#!/bin/sh
# E-26 (and E-36's latencies): group lifecycle on E-10's TS Raft port. Usage: sh run.sh [time|summary|model|all]
# The lifecycle runs hold $SP/bin/timing (3 runs per scale, one run of every scale per hold).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/fero-sp}
export SP
case "${1:-all}" in
  time) for r in 1 2 3; do "$SP/bin/timing" node "$HERE/lifecycle.mjs" runs=$r; done ;;
  summary) python3 "$HERE/summarize.py" ;;
  model) python3 "$HERE/model.py" ;;
  all) sh "$0" time; sh "$0" summary; sh "$0" model ;;
esac
