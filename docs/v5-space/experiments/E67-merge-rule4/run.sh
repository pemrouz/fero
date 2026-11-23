#!/bin/sh
# E-67: the merger's rule 4 on seeds. Re-runs every part and writes results/.
#   sim     1,000 seeds of 600 steps for each line: the forms none, a, b, b0, c in the four worlds (g4, g16,
#           elastic, stress), the ring at 16 and 256 frames in stress, and every planted bug in g4 and stress
#           (under the heavy lock, PAR lines at a time)
#   bench   the timings (bench/bench.mjs), every part three times, each run alone under the timing lock
#   S       the tables (results/summary.md)
#   quick   a smoke run (20 seeds a line for a few lines, a short bench), no locks, nothing written to results/
#   full    sim, bench, S
# Env: SP (a folder holding bin/heavy and bin/timing lock wrappers; without them commands run directly),
# PAR (default 3), SEEDS (default 1000).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-}
PAR=${PAR:-3}
S=${SEEDS:-1000}
OUT="$HERE/results"
NODE="node --max-old-space-size=3500"
HEAVY=""; [ -n "$SP" ] && [ -x "$SP/bin/heavy" ] && HEAVY="$SP/bin/heavy"
TIMING=""; [ -n "$SP" ] && [ -x "$SP/bin/timing" ] && TIMING="$SP/bin/timing"
mkdir -p "$OUT"
cd "$HERE"
part=${1:-full}

sim_cmds() {
  for w in g4 g16 elastic stress; do for f in none a b b0 c; do echo "$NODE sim/sim.mjs --world=$w --fix=$f --seeds=$S"; done; done
  for r in 16 256; do echo "$NODE sim/sim.mjs --world=stress --fix=b --ring=$r --seeds=$S"; done
  for w in g4 stress; do
    for m in nopair resyncadd back noclosure nojoin keyowner rebuildnol health giveup giveupskip; do echo "$NODE sim/sim.mjs --world=$w --fix=a --mutate=$m --seeds=$S"; done
    echo "$NODE sim/sim.mjs --world=$w --fix=b --ring=16 --mutate=ringgap --seeds=$S"
    for m in nomovepart noorder noclosure nojoin nomoverows rebuildnomove keyowner droprows giveup; do echo "$NODE sim/sim.mjs --world=$w --fix=c --mutate=$m --seeds=$S"; done
  done
}
run_par() { # stdin's command lines, PAR at a time, under one hold of the heavy lock when there is one
  : > "$OUT/sim.jsonl"
  export OUT PAR
  $HEAVY sh -c 'xargs -P "$PAR" -I{} sh -c "{} >> \"$OUT/sim.jsonl\""'
}
bench_once() {
  for p in picture install ring movepart; do $NODE --expose-gc bench/bench.mjs --part=$p; done
}

case "$part" in
  sim) sim_cmds | run_par; wc -l "$OUT/sim.jsonl" ;;
  bench)
    : > "$OUT/bench.jsonl"
    for r in 1 2 3; do
      echo "bench run $r, load $(cut -d' ' -f1-3 /proc/loadavg)" >&2
      $TIMING sh "$HERE/run.sh" bench-once | sed "s/^{/{\"run\":$r,/" >> "$OUT/bench.jsonl"
    done ;;
  bench-once) bench_once ;;
  S) node bench/summarize.mjs "$OUT" > "$OUT/summary.md"; echo "wrote $OUT/summary.md" ;;
  quick)
    for f in none a c; do $NODE sim/sim.mjs --world=g4 --fix=$f --seeds=20 | cut -c1-200; done
    $NODE sim/sim.mjs --world=stress --fix=b0 --seeds=20 | cut -c1-200
    $NODE sim/sim.mjs --world=stress --fix=a --mutate=nojoin --seeds=20 | cut -c1-200
    $NODE --expose-gc bench/bench.mjs --part=movepart ;;
  full) "$0" sim; "$0" bench; "$0" S ;;
  *) echo "unknown part $part" >&2; exit 2 ;;
esac
