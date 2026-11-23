#!/bin/sh
# E-65 X1: the asking process holds every row, better than today's R0. Every claim of README.md, from a clean
# checkout. data (DATA, default ../data next to this repo) and fero v4's codec (kernel/codec.ts) are read, never
# changed.
#   ./run.sh quick     every part small, nothing written to results/ (a smoke test, a few minutes; under the
#                      heavy lock when SP is set)
#   ./run.sh sims      seeded runs: the split stores (B1 to B4) and the compact stores, real and planted; heavy lock
#   ./run.sh budget    seeded runs of the memory-budget guard, six policies; heavy lock
#   ./run.sh mem       bytes a row for every form at 1e6 rows, RUNS times; heavy lock
#   ./run.sh cap       past data's 16,777,216 rows a source: one source, 16 sources, columns; and the probe of
#                      whether data frees a dropped source's rows; heavy lock
#   ./run.sh timing    fold, live views, a live median, reads, GC pauses, worker threads; RUNS times each, each
#                      process alone under the timing lock
#   ./run.sh summary   results/summary.md from the JSON lines (runs nothing)
#   ./run.sh           sims, budget, mem, cap, timing, summary
# Env: SP (a scratch folder of your own holding bin/timing, which runs a command alone on the box, and
# bin/heavy, which shares the box but waits for timing runs; without them the locks are skipped). NODE (default
# node on PATH, Node 22.22.0). DATA (data's folder). SEEDS (default 1000), BSEEDS (budget seeds, default 100),
# RUNS (default "1 2 3"). X1_TMP (where the disk forms write their files; default the system's temp folder).
# Every process runs with --max-old-space-size=3500 or less and stays under 4 GB (the ceiling runs reach about
# 3 GB). Raw JSON lines land in results/; move old files away first for a clean rerun.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../../.." && pwd)
export DATA=${DATA:-$(cd "$REPO/.." && pwd)/data}
export FERO=${FERO:-$REPO}
NODE=${NODE:-node}
SEEDS=${SEEDS:-1000}
BSEEDS=${BSEEDS:-100}
RUNS=${RUNS:-1 2 3}
R=$HERE/results
mkdir -p "$R"
if [ -n "$SP" ]; then TIMING=$SP/bin/timing; HEAVY=$SP/bin/heavy; else TIMING=; HEAVY=; fi
case "${1:-all}" in
  quick|sims|budget|mem|cap) if [ -z "$INNER" ] && [ -n "$HEAVY" ]; then exec "$HEAVY" env INNER=1 sh "$HERE/run.sh" "$@"; fi ;;
  timing) if [ -z "$INNER" ] && [ -n "$TIMING" ]; then exec "$TIMING" env INNER=1 sh "$HERE/run.sh" "$@"; fi ;;
esac
N="$NODE --experimental-strip-types --no-warnings --expose-gc --max-old-space-size=3500"
cd "$HERE"

one() { # file, command...: one process, its load average first, then its JSON line
  f=$1; shift
  printf '{"loadavg":"%s","cmd":"%s"}\n' "$(cut -d' ' -f1-3 /proc/loadavg)" "$*" >> "$f"
  "$@" >> "$f" || printf '{"failed":"%s"}\n' "$*" >> "$f"
}

sims() {
  f=$R/sims.jsonl
  for form in one blocks groups; do one "$f" $N src/sim.mjs --part=split --form=$form --seeds=$SEEDS; done
  one "$f" $N src/sim.mjs --part=split --form=blocks --S=32 --G=8 --seeds=$SEEDS
  for form in one blocks; do one "$f" $N src/sim.mjs --part=split --form=$form --dom=float --seeds=$SEEDS; done
  for m in noorder nodup route topshort medmed; do one "$f" $N src/sim.mjs --part=split --form=blocks --mutate=$m --seeds=$SEEDS; done
  one "$f" $N src/sim.mjs --part=split --form=blocks --S=2 --mutate=topshort --seeds=$SEEDS
  one "$f" $N src/sim.mjs --part=split --form=groups --mutate=nomigrate --seeds=$SEEDS
  for form in arena column kvdisk; do one "$f" $N src/sim.mjs --part=compact --form=$form --seeds=$SEEDS; done
  for fm in arena:tombstop arena:compactaddr column:tombstop column:presence column:nooverflow kvdisk:tombstop; do
    one "$f" $N src/sim.mjs --part=compact --form=${fm%%:*} --mutate=${fm##*:} --seeds=$SEEDS
  done
}
budget() {
  f=$R/budget.jsonl
  for p in heapnow model first aftergc scaled confirm; do
    one "$f" $NODE --experimental-strip-types --no-warnings --expose-gc --max-old-space-size=128 src/budget.mjs --policy=$p --budget=32 --seeds=$BSEEDS
  done
}
mem() {
  f=$R/mem.jsonl
  for run in $RUNS; do for form in one blocks16 blocks64 proj arena kvdisk column sqlite; do one "$f" $N src/bench.mjs mem --form=$form --rows=1000000; done; done
}
cap() {
  f=$R/cap.jsonl
  one "$f" $N src/bench.mjs cap --form=one --rows=20000000
  one "$f" $N src/bench.mjs cap --form=blocks16 --rows=20000000
  one "$f" $NODE --experimental-strip-types --no-warnings --expose-gc --max-old-space-size=512 src/bench.mjs cap --form=column --rows=20000000
  one "$R/probe-drop.jsonl" $N src/probe-drop.mjs
}
timing() {
  for run in $RUNS; do
    f=$R/timing.jsonl
    one "$f" $N src/bench.mjs probe
    for form in one blocks16 blocks64 proj arena kvdisk column sqlite; do one "$f" $N src/bench.mjs fold --form=$form --rows=1000000; done
    for form in one blocks16 proj column; do one "$f" $N src/bench.mjs fold --form=$form --rows=1000000 --views; done
    for m in none data data16 sorted; do one "$f" $N src/bench.mjs median --form=$m --rows=100000; one "$f" $N src/bench.mjs median --form=$m --rows=1000000; done
    for form in one blocks16 proj arena kvdisk column sqlite sqlite-ix; do one "$f" $N src/bench.mjs read --form=$form --rows=1000000; done
    for form in one blocks16 column arena; do one "$f" $N src/bench.mjs gc --form=$form --rows=5000000 --rate=50000 --secs=10; done
    f=$R/workers.jsonl
    for w in 0 1 2 3; do one "$f" $N src/workers.mjs fold --W=$w --rows=1000000 --recs=1000000; one "$f" $N src/workers.mjs fold --W=$w --rows=1000000 --recs=1000000 --views; done
    for w in 1 2 3; do one "$f" $N src/workers.mjs read --W=$w --rows=1000000; done
  done
}
quick() {
  Q=$(mktemp -d)
  echo "== E-65 X1 quick: sims =="
  for form in one blocks groups; do $N src/sim.mjs --part=split --form=$form --seeds=10 | cut -c1-200; done
  $N src/sim.mjs --part=split --form=blocks --mutate=route --seeds=10 | cut -c1-200
  for form in arena column kvdisk; do $N src/sim.mjs --part=compact --form=$form --seeds=10 | cut -c1-200; done
  $N src/sim.mjs --part=compact --form=column --mutate=presence --seeds=10 | cut -c1-200
  echo "== budget =="
  $NODE --experimental-strip-types --no-warnings --expose-gc --max-old-space-size=128 src/budget.mjs --policy=confirm --budget=32 --seeds=3 | cut -c1-200
  echo "== benches (small) =="
  for form in one blocks16 proj arena kvdisk column sqlite; do $N src/bench.mjs fold --form=$form --rows=20000 --recs=20000 | cut -c1-200; done
  for form in one column; do $N src/bench.mjs fold --form=$form --rows=20000 --recs=20000 --views | cut -c1-200; done
  for form in one column sqlite-ix; do $N src/bench.mjs read --form=$form --rows=20000 | cut -c1-200; done
  $N src/bench.mjs mem --form=column --rows=20000 | cut -c1-200
  $N src/bench.mjs median --form=sorted --rows=20000 --recs=20000 | cut -c1-200
  $N src/bench.mjs gc --form=one --rows=50000 --secs=1 | cut -c1-200
  $N src/bench.mjs cap --form=blocks16 --rows=100000 | cut -c1-200
  $N src/workers.mjs fold --W=2 --rows=50000 --recs=50000 --views | cut -c1-200
  $N src/workers.mjs read --W=2 --rows=50000 | cut -c1-200
  rm -rf "$Q"
  echo "== E-65 X1 quick: done =="
}
summary() { $NODE src/summarize.mjs > "$R/summary.md" && echo "wrote results/summary.md"; }

case "${1:-all}" in
  quick) quick ;;
  sims) sims ;;
  budget) budget ;;
  mem) mem ;;
  cap) cap ;;
  timing) timing ;;
  summary) summary ;;
  all) sh "$HERE/run.sh" sims; sh "$HERE/run.sh" budget; sh "$HERE/run.sh" mem; sh "$HERE/run.sh" cap; sh "$HERE/run.sh" timing; summary ;;
  *) echo "usage: run.sh [quick|sims|budget|mem|cap|timing|summary]"; exit 1 ;;
esac
