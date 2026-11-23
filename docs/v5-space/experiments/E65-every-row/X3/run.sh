#!/bin/sh
# E-65 X3: live user code over every row as a fold (emit per row, combine per bucket), kept by partials per group
# next to the rows and a merger per view, so no process holds every row.
#
#   ./run.sh quick     a smoke run: the lawful folds on 30 seeds in three worlds, every planted bug on 30 seeds, the
#                      bench parts small; then a verdict: it fails if a lawful run failed a seed or was flagged by
#                      fero's own checks, or if a planted bug was neither caught by the oracle nor flagged.
#                      Writes nothing to results/. About 3 minutes of one CPU. `./run.sh quick-heavy` runs it under
#                      the heavy lock.
#   ./run.sh sim       the seeded runs, in one hold of the heavy lock: results/sim.jsonl
#   ./run.sh bench     three timed runs, each in one hold of the timing lock: results/bench.jsonl
#   ./run.sh summary   results/summary.md from the results files
#   ./run.sh           sim, bench, summary
#
# Env: SP (a folder holding bin/timing, which runs a command alone on the box, and bin/heavy, which shares the box
# but waits for timing runs; without them the locks are skipped). NODE (default node on PATH; Node 22.22.0 here).
# This part does not use data: the partials and the merger are plain code (see README, "What this does not show").
# Every process runs with at most 3,000 MB of heap.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
NODE=${NODE:-node}
HEAVY=""; TIMING=""
if [ -n "$SP" ] && [ -x "$SP/bin/heavy" ]; then HEAVY="$SP/bin/heavy"; TIMING="$SP/bin/timing"; fi
N="$NODE --max-old-space-size=3000"
USER_BUGS="avgmeans firstwins floatsum badremove maxremove badkeeps impure badempty mutsecond"

quick() {
  T=$(mktemp)
  for w in "--groups=4" "--groups=16" "--groups=elastic --deploy"; do $N src/sim.mjs --seeds=30 $w --tag=quick --out=$T >/dev/null; done
  for m in nopair resyncadd norescan; do $N src/sim.mjs --seeds=30 --mutate=$m --tag=quick --out=$T >/dev/null; done
  $N src/sim.mjs --seeds=30 --deploy --mutate=mixver --tag=quick --out=$T >/dev/null
  for b in $USER_BUGS; do $N src/sim.mjs --seeds=30 --bug=$b --tag=quick --out=$T >/dev/null; done
  for p in partial merger check; do $N src/bench.mjs --part=$p --quick >/dev/null; done
  $N -e '
    const ls = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n").map(JSON.parse); let bad = 0
    for (const l of ls) {
      const name = l.bug !== "none" ? "bug " + l.bug : l.mutate !== "none" ? "mutate " + l.mutate : "lawful " + l.groups + (l.deploy ? " deploy" : "")
      const ok = l.bug === "none" && l.mutate === "none" ? l.failed === 0 && l.anyFero === 0 : l.failed > 0 || l.anyFero > 0
      console.log((ok ? "ok   " : "FAIL ") + name + ": oracle failed " + l.failed + "/" + l.seeds + ", fero flagged " + l.anyFero + "/" + l.seeds)
      if (!ok) bad++
    }
    console.log(bad ? "quick: FAILED" : "quick: ok"); process.exit(bad ? 1 : 0)' $T
  rm -f $T
}

sim_all() {
  OUT=results/sim.jsonl
  $N src/sim.mjs --seeds=1000 --groups=4 --tag=lawful --out=$OUT
  $N src/sim.mjs --seeds=300 --groups=16 --tag=lawful --out=$OUT
  $N src/sim.mjs --seeds=500 --groups=elastic --tag=lawful --out=$OUT
  $N src/sim.mjs --seeds=500 --groups=elastic --deploy --tag=deploy --out=$OUT
  $N src/sim.mjs --seeds=300 --groups=4 --deploy --overlap=300 --tag=deploy --out=$OUT
  $N src/sim.mjs --seeds=300 --groups=4 --deploy --overlap=0 --tag=deploy --out=$OUT
  $N src/sim.mjs --seeds=300 --groups=4 --nokeeps --tag=variant --out=$OUT
  $N src/sim.mjs --seeds=300 --groups=4 --flat --tag=variant --out=$OUT
  $N src/sim.mjs --seeds=1 --seed=7 --groups=16 --commits=20000 --keys=3000 --deploy --tag=long --out=$OUT
  $N src/sim.mjs --seeds=1 --seed=8 --groups=elastic --commits=20000 --keys=3000 --tag=long --out=$OUT
  for m in nopair resyncadd norescan; do $N src/sim.mjs --seeds=300 --groups=4 --mutate=$m --tag=builder --out=$OUT; done
  $N src/sim.mjs --seeds=300 --groups=4 --deploy --mutate=mixver --tag=builder --out=$OUT
  for b in $USER_BUGS; do $N src/sim.mjs --seeds=300 --groups=4 --bug=$b --tag=user --out=$OUT; done
}
bench_run() {
  r=$1
  for p in partial merger check; do $N src/bench.mjs --part=$p --run=$r --out=results/bench.jsonl; done
}

case "${1:-all}" in
  quick) quick ;;
  quick-heavy) $HEAVY sh "$0" quick ;;
  sim) rm -f results/sim.jsonl; $HEAVY sh "$0" sim-run ;;
  bench) rm -f results/bench.jsonl; for r in 1 2 3; do $TIMING sh "$0" bench-run $r; done ;;
  bench-run) bench_run "$2" ;;
  sim-run) sim_all ;;
  summary) $N src/summarize.mjs > results/summary.md ;;
  all) sh "$0" sim; sh "$0" bench; sh "$0" summary ;;
  *) echo "usage: ./run.sh [quick|quick-heavy|sim|bench|summary|all]"; exit 2 ;;
esac
