#!/bin/sh
# E-35: big records and a busy tenant on E-12's shared journal (Node 22).
# Usage: sh run.sh probe | a | b | b40 | all | summary
# Every block runs under the timing lock ($SP/bin/timing); configs already in results/ are skipped.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
# the dispatch is one brace group ending in exit, so editing this file during a run is safe
{
case "${1:-all}" in
  probe|a|b|b40|bq) node "$HERE/bench.mjs" block="$1" runs="${RUNS:-3}" ;;
  summary) python3 "$HERE/summarize.py" > "$HERE/results/tables.md"; cat "$HERE/results/tables.md" ;;
  all)
    for b in probe a b b40 bq; do
      echo "$(date +%T) block $b waiting"; "$SP/bin/timing" sh "$HERE/run.sh" "$b"; echo "$(date +%T) block $b done"
    done
    sh "$HERE/run.sh" summary ;;
  *) echo "unknown $1" >&2; exit 1 ;;
esac
exit 0
}
