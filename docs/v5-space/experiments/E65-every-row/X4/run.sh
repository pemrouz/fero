#!/bin/sh
# E-65 X4: live and one-time quantiles over every row, without one process holding every value.
#   ./run.sh quick     every part small, nothing written to results/ (a smoke test, about a minute; under the
#                      heavy lock when SP is set)
#   ./run.sh sims      seeded runs, real code at two relative errors and nine planted bugs; heavy lock
#   ./run.sh accuracy  sketch errors and sizes against exact answers (static, churn, band); heavy lock
#   ./run.sh timing    the timed cells, RUNS times each, each process alone under the timing lock
#   ./run.sh summary   results/summary.md from the JSON lines (runs nothing)
#   ./run.sh           sims, accuracy, timing, summary
# Env: SP (a scratch folder of your own holding bin/timing, which runs a command alone on the box, and bin/heavy,
# which shares the box but waits for timing runs; without them the locks are skipped). NODE (default node on
# PATH; Node 22.22.0 was used). SEEDS (default 1000). RUNS (default "1 2 3"). LIBS (optional: a folder holding
# node_modules with @datadog/sketches-js@2.1.1 (Apache-2.0) and tdigest@0.1.3 (MIT); `./run.sh libs` installs
# them into $X4_TMP, default the system's temp folder, and prints the folder). No file in the repo is changed.
# Every process runs with --max-old-space-size=3500 or less.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
SEEDS=${SEEDS:-1000}
RUNS=${RUNS:-1 2 3}
R=$HERE/results
mkdir -p "$R"
if [ -n "$SP" ]; then TIMING=$SP/bin/timing; HEAVY=$SP/bin/heavy; else TIMING=; HEAVY=; fi
case "${1:-all}" in
  quick|sims|accuracy) if [ -z "$INNER" ] && [ -n "$HEAVY" ]; then exec "$HEAVY" env INNER=1 sh "$HERE/run.sh" "$@"; fi ;;
  timing) if [ -z "$INNER" ] && [ -n "$TIMING" ]; then exec "$TIMING" env INNER=1 sh "$HERE/run.sh" "$@"; fi ;;
esac
N="$NODE --max-old-space-size=3500"
cd "$HERE"
BUGS="nopair resyncadd noremove bandold picadd negbucket infbucket rank7 nooff"

one() { # file, command...: one process, its JSON line
  f=$1; shift
  "$@" >> "$f" || printf '{"failed":"%s"}\n' "$*" >> "$f"
}
sims() {
  f=$R/sim.jsonl
  one "$f" $N src/sim.mjs --seeds=$SEEDS --alpha=0.01
  one "$f" $N src/sim.mjs --seeds=$SEEDS --alpha=0.001 --seed0=100001
  one "$f" $N src/sim.mjs --seeds=$SEEDS --alpha=0.01 --S=16 --steps=4000 --seed0=200001
  for b in $BUGS; do one "$f" $N src/sim.mjs --seeds=$SEEDS --mutate=$b; done
}
accuracy() {
  f=$R/accuracy.jsonl
  for d in lognormal pareto ints wide latency; do for n in 10000 100000 1000000; do
    for s in 1 2 3; do one "$f" $N src/accuracy.mjs static --dist=$d --n=$n --seed=$s; done
  done; done
  for u in 0 1 4 16; do for s in 1 2 3; do one "$f" $N src/accuracy.mjs churn --n=100000 --u=$u --seed=$s; done; done
  for c in 0.1 0.25 1; do one "$f" $N src/accuracy.mjs churn --n=100000 --u=16 --c=$c; done
  for d in lognormal pareto ints latency; do for n in 100000 1000000 10000000; do for a in 0.01 0.001; do
    one "$f" $N src/accuracy.mjs band --dist=$d --n=$n --alpha=$a
  done; done; done
}
timing() {
  f=$R/bench.jsonl
  for run in $RUNS; do
    one "$f" $N src/bench.mjs ops
    one "$f" $N src/bench.mjs merge --n=1000000 --g=16
    one "$f" $N src/bench.mjs merge --n=1000000 --g=64
    one "$f" $N src/bench.mjs coalesce --mode=small
    one "$f" $N src/bench.mjs coalesce --mode=random
    for a in 0.01 0.001; do one "$f" $N src/bench.mjs band --n=1000000 --alpha=$a; one "$f" $N src/bench.mjs band --n=10000000 --alpha=$a; done
    for n in 1000000 10000000; do for g in 16 64; do one "$f" $N src/bench.mjs onetime --n=$n --g=$g; done; done
  done
}
quick() {
  t=$(mktemp -d)
  $N src/sim.mjs --seeds=20 --steps=1500 > "$t/q"
  for b in $BUGS; do $N src/sim.mjs --seeds=20 --steps=1500 --mutate=$b >> "$t/q"; done
  $N src/accuracy.mjs static --n=20000 >> "$t/q"; $N src/accuracy.mjs churn --n=10000 --u=2 >> "$t/q"; $N src/accuracy.mjs band --n=100000 >> "$t/q"
  for c in ops coalesce "band --n=100000" "onetime --n=100000"; do $N src/bench.mjs $c >> "$t/q"; done
  $NODE src/summarize.mjs --quick "$t/q"
  rm -rf "$t"
}
case "${1:-all}" in
  quick) quick ;;
  sims) sims ;;
  accuracy) accuracy ;;
  timing) timing ;;
  summary) $NODE src/summarize.mjs ;;
  libs) d=${X4_TMP:-$(mktemp -d)}; (cd "$d" && npm init -y >/dev/null && npm install @datadog/sketches-js@2.1.1 tdigest@0.1.3 >/dev/null); echo "LIBS=$d" ;;
  all) sims; accuracy; timing; $NODE src/summarize.mjs ;;
  *) echo "usage: $0 [quick|sims|accuracy|timing|summary|libs]"; exit 1 ;;
esac
