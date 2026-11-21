#!/bin/sh
# E-64 O1: the merger. Re-runs every part and writes results/.
#   sim     seeded exactness: three long runs (G = 4, 16, elastic; 100,000 commits) and 1,000 short seeds of the
#           real code and of six planted bugs at G = 4 and elastic (under the heavy lock, PAR at a time)
#   bench   the cost bench (bench/bench.mjs), every part three times, each process alone under the timing lock
#   S       the tables (results/summary.md)
#   quick   a smoke run of everything (short), no locks, nothing written to results/
#   all     sim, bench, S
# Env: SP (folder holding bin/heavy and bin/timing; without them, commands run directly), PAR (default 3),
# COMMITS (long runs, default 100000), SEEDS (default 1000).
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
  for g in 4 elastic; do
    for m in none nopair ties kshort extmerged resyncadd noowner; do
      mm=""; [ "$m" != none ] && mm="--mutate=$m"
      echo "$NODE sim/sim.mjs --groups=$g --seeds=$S --commits=400 --keys=300 $mm"
    done
  done
}
run_par() { # stdin's command lines, PAR at a time, under one hold of the heavy lock when there is one
  : > "$OUT/sim.jsonl"
  export OUT PAR
  $HEAVY sh -c 'xargs -P "$PAR" -I{} sh -c "{} >> \"$OUT/sim.jsonl\""'
}
bench_once() {
  for p in bytes mem; do $NODE --expose-gc bench/bench.mjs --part=$p; done
  $NODE --expose-gc bench/bench.mjs --part=window --work=uniform --k=10 --n=100000
  $NODE --expose-gc bench/bench.mjs --part=window --work=rising --k=10 --n=100000
  $NODE --expose-gc bench/bench.mjs --part=window --work=uniform --k=100 --n=100000
  $NODE --expose-gc bench/bench.mjs --part=window --work=uniform --k=10 --n=1000000
  for p in add ext union pages; do $NODE --expose-gc bench/bench.mjs --part=$p; done
}

case "$part" in
  sim) sim_cmds | run_par; cat "$OUT/sim.jsonl" | cut -c1-160 ;;
  bench)
    : > "$OUT/bench.jsonl"
    for r in 1 2 3; do
      echo "bench run $r, load $(cut -d' ' -f1-3 /proc/loadavg)" >&2
      $TIMING sh "$HERE/run.sh" bench-once | sed "s/^{/{\"run\":$r,/" >> "$OUT/bench.jsonl"
    done ;;
  bench-once) bench_once ;;
  S) node bench/summarize.mjs "$OUT" > "$OUT/summary.md"; echo "wrote $OUT/summary.md" ;;
  quick)
    for g in 4 elastic; do $NODE sim/sim.mjs --groups=$g --commits=3000 --seed=1; done
    $NODE sim/sim.mjs --groups=4 --seeds=20 --commits=400 --keys=300 --mutate=nopair
    $NODE --expose-gc bench/bench.mjs --part=window --writes=20000 --n=20000
    $NODE --expose-gc bench/bench.mjs --part=pages --reads=50 ;;
  all) "$0" sim; "$0" bench; "$0" S ;;
  *) echo "unknown part $part" >&2; exit 2 ;;
esac
