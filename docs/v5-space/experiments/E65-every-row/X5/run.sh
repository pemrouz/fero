#!/bin/sh
# E-65 X5, the wildcard: a slot sample (hold k of 4,096 slots and estimate), and clients that merge the
# groups' partials themselves. Every claim of README.md, from a clean checkout. Plain Node; no data needed.
#   ./run.sh quick     small seeded runs of both parts, real code and every planted bug, and one timing pass;
#                      exits non-zero if real code fails a seed or a planted bug fails fewer than 2 of 3
#                      (a minute or two; under the heavy lock when SP is set)
#   ./run.sh sims      the seeded runs: sample (moderate, sparse, heavy tail, two sample sizes) and every
#                      planted bug; clientmerge (random and rising scores) and its planted bug; heavy lock
#   ./run.sh timing    sample-bench and cm-bench, RUNS times, each alone under the timing lock
#   ./run.sh summary   results/summary.md from the JSON lines (runs nothing)
#   ./run.sh           sims, timing, summary
# Env: SP (a scratch folder of your own holding bin/timing and bin/heavy; without them the locks are
# skipped). NODE (default node, Node 22.22.0). SEEDS (default 100). RUNS (default "1 2 3").
# Every process stays far under 1 GB (--max-old-space-size=2000).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
SEEDS=${SEEDS:-100}
RUNS=${RUNS:-1 2 3}
R=$HERE/results
mkdir -p "$R"
if [ -n "$SP" ]; then TIMING=$SP/bin/timing; HEAVY=$SP/bin/heavy; else TIMING=; HEAVY=; fi
case "${1:-all}" in
  quick|sims) if [ -z "$INNER" ] && [ -n "$HEAVY" ]; then exec "$HEAVY" env INNER=1 sh "$HERE/run.sh" "$@"; fi ;;
  timing) if [ -z "$INNER" ] && [ -n "$TIMING" ]; then exec "$TIMING" env INNER=1 sh "$HERE/run.sh" "$@"; fi ;;
esac
N="$NODE --max-old-space-size=2000"
S=$HERE/src

failed() { sed -n 's/.*"failed":\([0-9]*\).*/\1/p' | tail -1; }

case "${1:-all}" in
quick)
  ok=1
  f=$($N $S/sample.mjs 4 | failed); echo "sample real: $f of 4 seeds failed"; [ "$f" = 0 ] || ok=0
  for b in noscale rowvar hotpick window lostdelete; do
    f=$(BUG=$b $N $S/sample.mjs 3 | failed); echo "sample bug $b: $f of 3 failed"; [ "$f" -ge 2 ] || ok=0
  done
  f=$(BUG=skipempty PARTS=2000 $N $S/sample.mjs 3 | failed); echo "sample bug skipempty (sparse): $f of 3 failed"; [ "$f" -ge 2 ] || ok=0
  f=$(N=20000 W=40000 $N $S/clientmerge.mjs 2 | grep '"part"' | head -1 | failed); echo "clientmerge real (random): $f of 2 failed"; [ "$f" = 0 ] || ok=0
  f=$(CMBUG=answeronly N=20000 W=40000 $N $S/clientmerge.mjs 3 | grep '"part"' | head -1 | failed); echo "clientmerge bug answeronly (random): $f of 3 failed"; [ "$f" -ge 2 ] || ok=0
  $N $S/sample-bench.mjs 0 >/dev/null && $N $S/cm-bench.mjs 0 >/dev/null && echo "benches ran"
  [ $ok = 1 ] && echo "quick: ok" || { echo "quick: FAILED"; exit 1; }
  ;;
sims)
  : > "$R/sample.jsonl"; : > "$R/sample-runs.jsonl"
  OUT=$R/sample.jsonl $N $S/sample.mjs $SEEDS >> "$R/sample-runs.jsonl"
  OUT=$R/sample.jsonl PARTS=2000 $N $S/sample.mjs $SEEDS >> "$R/sample-runs.jsonl"
  OUT=$R/sample.jsonl TAIL=heavy $N $S/sample.mjs $SEEDS >> "$R/sample-runs.jsonl"
  OUT=$R/sample.jsonl TAIL=heavy K=1024 $N $S/sample.mjs $((SEEDS / 2)) >> "$R/sample-runs.jsonl"
  OUT=$R/sample.jsonl K=64 $N $S/sample.mjs $((SEEDS / 2)) >> "$R/sample-runs.jsonl"
  for b in noscale rowvar hotpick window lostdelete; do OUT=$R/sample.jsonl BUG=$b $N $S/sample.mjs $SEEDS >> "$R/sample-runs.jsonl"; done
  OUT=$R/sample.jsonl BUG=skipempty PARTS=2000 $N $S/sample.mjs $SEEDS >> "$R/sample-runs.jsonl"
  $N $S/clientmerge.mjs 5 > "$R/clientmerge.jsonl"
  CMBUG=answeronly $N $S/clientmerge.mjs 5 >> "$R/clientmerge.jsonl"
  G=256 $N $S/clientmerge.mjs 2 >> "$R/clientmerge.jsonl"
  ;;
timing)
  : > "$R/timing.jsonl"
  for i in $RUNS; do
    echo "{\"loadavg\":\"$(cut -d' ' -f1-3 /proc/loadavg)\",\"run\":$i}" >> "$R/timing.jsonl"
    $N $S/sample-bench.mjs $i >> "$R/timing.jsonl"
    $N $S/cm-bench.mjs $i >> "$R/timing.jsonl"
  done
  ;;
summary) $NODE $S/summarize.mjs "$R" > "$R/summary.md" ;;
all) sh "$HERE/run.sh" sims; sh "$HERE/run.sh" timing; sh "$HERE/run.sh" summary ;;
esac
