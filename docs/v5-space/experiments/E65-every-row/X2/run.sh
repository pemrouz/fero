#!/bin/sh
# E-65 X2: one-time work over every row, by a paged scan that never holds every row.
#
#   ./run.sh quick     a smoke run: every mode and every planted bug on 100 seeds of the hard world, the scan
#                      bench at 4e5 rows, the local and pin benches small; then a verdict (src/checkquick.mjs):
#                      it fails if the real code failed a seed, a planted bug failed none, or a scan's check did
#                      not hold. Writes nothing to results/. A few minutes. `./run.sh quick-heavy` runs it
#                      under the heavy lock.
#   ./run.sh sim       the seeded runs (six worlds, three modes, every planted bug), in one hold of the heavy
#                      lock: results/sim.jsonl
#   ./run.sh bench     the timed runs: three holds of the timing lock, one per run, each about 4 minutes alone
#                      on the box: results/bench.jsonl
#   ./run.sh probe     the timed prototype's pin check with two planted bugs (results/probe-pincheck.txt)
#   ./run.sh summary   results/summary.md from the results files
#   ./run.sh           sim, bench, summary
#
# Env: SP (a folder of your own holding bin/timing, which runs a command alone on the box, and bin/heavy,
# which shares the box but waits for timing runs; without them the locks are skipped). NODE (default node on PATH;
# Node 22.22.0 here). DATA (data's folder, default ../data next to this repo; read only, used by the pin bench).
# Every process runs with at most 3,000 MB of heap (the scan bench: four server processes of about 1 GB each at
# 1e7 rows, and the asking process).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
NODE=${NODE:-node}
HEAVY=""; TIMING=""
if [ -n "$SP" ] && [ -x "$SP/bin/heavy" ]; then HEAVY="$SP/bin/heavy"; TIMING="$SP/bin/timing"; fi
N="$NODE --max-old-space-size=3000"
NS="$NODE --max-old-space-size=3000 --expose-gc --experimental-strip-types --no-warnings"

DEF="--G=4 --S=64 --keys=800 --moveP=0.05"
WIDE="--G=8 --S=256 --keys=3000 --P=8 --moveP=0.05"
ONE="--G=1 --S=64 --keys=800"
LONG="--G=16 --S=1024 --keys=20000 --P=16 --moveP=0.1 --failP=0.02"
STRESS="--G=2 --S=16 --keys=200 --wps=6 --failP=0.05 --moveP=0.1 --lagMax=60 --pinSpread=30 --moveLen=6"
HARD="--G=2 --S=4 --keys=120 --wps=6 --failP=0.2 --moveP=0.3 --lagMax=60 --pinSpread=30 --moveLen=4 --P=2"
BUGS_none="noseen nofollow restart maporder"
BUGS_slot="noseen nobuffer dropnosave everysave"
BUGS_cut="nopair oldpair dropnosave opennosave everysave localpin pinnotcarried nofloor"

# the seeded runs, all in one hold of the heavy lock (a few minutes of one CPU)
sim_all() {
  OUT=results/sim.jsonl
  for m in none slot cut; do
    $N src/sim.mjs --mode=$m --seeds=1000 $DEF --tag=default --out=$OUT
    $N src/sim.mjs --mode=$m --seeds=300 $WIDE --tag=wide --out=$OUT
    $N src/sim.mjs --mode=$m --seeds=300 $ONE --tag=one --out=$OUT
    $N src/sim.mjs --mode=$m --seeds=100 $LONG --tag=long --out=$OUT
    $N src/sim.mjs --mode=$m --seeds=2000 $STRESS --tag=stress --out=$OUT
    $N src/sim.mjs --mode=$m --seeds=1000 $HARD --tag=hard --out=$OUT
  done
  for b in $BUGS_none; do $N src/sim.mjs --mode=none --bug=$b --seeds=1000 $HARD --tag=hard --out=$OUT; $N src/sim.mjs --mode=none --bug=$b --seeds=1000 $DEF --tag=default --out=$OUT; done
  for b in $BUGS_slot; do $N src/sim.mjs --mode=slot --bug=$b --seeds=1000 $HARD --tag=hard --out=$OUT; $N src/sim.mjs --mode=slot --bug=$b --seeds=1000 $DEF --tag=default --out=$OUT; done
  for b in $BUGS_cut; do $N src/sim.mjs --mode=cut --bug=$b --seeds=1000 $HARD --tag=hard --out=$OUT; $N src/sim.mjs --mode=cut --bug=$b --seeds=1000 $DEF --tag=default --out=$OUT; done
  $N src/sim.mjs --mode=cut --bug=oldpair --seeds=2000 $STRESS --tag=stress --out=$OUT
}
# one timed run: every timed part, one process at a time, in one hold of the timing lock (about 4 minutes)
bench_run() {
  r=$1; OUT=results/bench.jsonl
  $N --expose-gc src/bench-scan.mjs --rows=10000000 --set=main --run=$r --out=$OUT
  $N --expose-gc src/bench-scan.mjs --rows=10000000 --set=writes --run=$r --out=$OUT
  $N --expose-gc src/bench-scan.mjs --rows=2000000 --set=sweep --run=$r --out=$OUT
  $N --expose-gc src/bench-local.mjs --part=local --rows=2500000 --run=$r --out=$OUT
  $NS src/bench-local.mjs --part=pin --rows=625000 --run=$r --out=$OUT
}
sim() { $HEAVY sh "$HERE/run.sh" sim-inner; }
bench() { for r in 1 2 3; do $TIMING sh "$HERE/run.sh" bench-run $r; done; }
quick() {
  T=$(mktemp)
  for m in none slot cut; do $N src/sim.mjs --mode=$m --seeds=100 $HARD --tag=quick >> "$T"; done
  for b in $BUGS_none; do $N src/sim.mjs --mode=none --bug=$b --seeds=100 $HARD --tag=quick >> "$T"; done
  for b in $BUGS_slot; do $N src/sim.mjs --mode=slot --bug=$b --seeds=100 $HARD --tag=quick >> "$T"; done
  for b in $BUGS_cut; do $N src/sim.mjs --mode=cut --bug=$b --seeds=100 $HARD --tag=quick >> "$T"; done
  $N --expose-gc src/bench-scan.mjs --rows=400000 --set=quick >> "$T"
  $N --expose-gc src/bench-scan.mjs --rows=400000 --set=writes >> "$T"
  $N --expose-gc src/bench-local.mjs --part=local --rows=200000 --rounds=3 >> "$T"
  $NS src/bench-local.mjs --part=pin --rows=100000 --writes=50000 --rounds=3 >> "$T"
  if $NODE src/checkquick.mjs < "$T"; then st=0; else st=1; fi
  rm -f "$T"; return $st
}
case "$1" in
  quick) quick ;;
  quick-heavy) $HEAVY sh "$HERE/run.sh" quick ;;
  probe) # the timed prototype's own check, with two planted bugs in the writer (4e5 rows, not timed)
    for b in none noimage everysave; do SCAN_BUG=$b $N --expose-gc src/bench-scan.mjs --rows=400000 --set=writes --only=cut+w | grep '"scan"' | sed "s/^/bug=$b /"; done | tee results/probe-pincheck.txt ;;
  sim) sim ;;
  bench) bench ;;
  sim-inner) sim_all ;;
  bench-run) bench_run "$2" ;;
  summary) $NODE src/summarize.mjs ;;
  "") sim; bench; $NODE src/summarize.mjs ;;
  *) echo "usage: run.sh [quick|sim|bench|summary]"; exit 1 ;;
esac
