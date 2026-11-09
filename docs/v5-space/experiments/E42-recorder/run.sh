#!/bin/sh
# E-42: E-02's TS pipeline with a recorder of kernel inputs; cost and replay fidelity. Usage: sh run.sh [cost|verify|summary|all]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
case "${1:-all}" in
  cost) "$SP/bin/timing" node "$HERE/bench.mjs" part=cost runs=3 ;;
  verify) "$SP/bin/timing" node "$HERE/bench.mjs" part=verify runs=3 ;;
  summary) python3 "$HERE/summarize.py" ;;
  all) sh "$0" cost; sh "$0" verify; sh "$0" summary ;;
esac
