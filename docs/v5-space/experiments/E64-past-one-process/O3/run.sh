#!/bin/sh
# E-64 O3: partials keyed by slot, pushed down to a copy of each group, merged by key. Re-runs every part.
#   sim     seeded exactness: long runs (G = 4, 16, elastic; 100,000 commits; and elastic with the importing copy
#           published early), then 1,000 short seeds of the real code, of the early variant and of eight planted
#           bugs, at G = 4 and elastic. Under the heavy lock, PAR at a time.
#   bench   the cost bench (bench/bench.mjs): every part three times, in one hold of the timing lock (each process
#           alone on the box)
#   S       the tables (results/summary.md)
#   quick   a smoke run of everything, short, no locks, nothing written to results/
#   all     sim, bench, S
# Env: SP (a folder holding bin/heavy and bin/timing; without them, commands run directly), PAR (default 3),
# COMMITS (long runs, default 100000), SEEDS (default 1000). Node 22. Every process runs under 3.5 GB of heap.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-}
PAR=${PAR:-3}
N=${COMMITS:-100000}
S=${SEEDS:-1000}
OUT="$HERE/results"
NODE="node --max-old-space-size=3500"
HEAVY=""; [ -x "$SP/bin/heavy" ] && HEAVY="$SP/bin/heavy"
TIMING=""; [ -x "$SP/bin/timing" ] && TIMING="$SP/bin/timing"
mkdir -p "$OUT"
cd "$HERE"
part=${1:-all}

sim_cmds() {
  for g in 4 16 elastic; do echo "$NODE sim/sim.mjs --groups=$g --commits=$N --seed=1"; done
  echo "$NODE sim/sim.mjs --groups=elastic --commits=$N --seed=2 --early"
  for g in 4 elastic; do
    for m in none early nor1 nopicture mergepic coalescedrop ties extmerged rounded pergroup; do
      mm=""; [ "$m" = early ] && mm="--early"; [ "$m" != none ] && [ "$m" != early ] && mm="--mutate=$m"
      echo "$NODE sim/sim.mjs --groups=$g --seeds=$S --commits=400 --keys=300 $mm"
    done
  done
}
run_par() { # stdin's command lines, PAR at a time, under one hold of the heavy lock when there is one
  : > "$OUT/sim.jsonl"
  export OUT PAR
  $HEAVY sh -c 'xargs -P "$PAR" -I{} sh -c "{} >> \"$OUT/sim.jsonl\""'
}

case "$part" in
  sim) sim_cmds | run_par ;;
  bench) # one hold of the timing lock for the whole series: each process alone on the box, three runs
    : > "$OUT/bench.jsonl"
    export NODE OUT
    $TIMING sh -c 'for run in 1 2 3; do for p in host delta comb rate coalesce mem bytes; do
      printf "{\"run\":%s,\"part\":\"%s\",\"loadavg\":\"%s\"}\n" "$run" "$p" "$(cut -d" " -f1-3 /proc/loadavg)" >> "$OUT/bench.jsonl"
      $NODE --expose-gc bench/bench.mjs --part=$p --run=$run >> "$OUT/bench.jsonl"
    done; done' ;;
  S) node bench/summarize.mjs > "$OUT/summary.md"; cat "$OUT/summary.md" ;;
  quick)
    for g in 4 elastic; do $NODE sim/sim.mjs --groups=$g --commits=2000 --keys=600 --seed=1 | cut -c1-200; done
    $NODE sim/sim.mjs --groups=4 --seeds=20 --commits=300 --keys=300 --mutate=nopicture | cut -c1-200
    for p in host delta comb rate coalesce mem bytes; do $NODE --expose-gc bench/bench.mjs --part=$p --quick | cut -c1-300; done ;;
  all) sh "$0" sim; sh "$0" bench; sh "$0" S ;;
  *) echo "usage: run.sh sim|bench|S|quick|all"; exit 1 ;;
esac
