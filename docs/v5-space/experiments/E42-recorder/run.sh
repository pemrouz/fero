#!/bin/sh
# E-42: E-02's TS pipeline with a recorder of kernel inputs; cost and replay fidelity. Usage: sh run.sh [cost|verify|summary|all]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/fero-sp}
export SP
case "${1:-all}" in
  cost) "$SP/bin/timing" node "$HERE/bench.mjs" part=cost runs=3 ;;
  verify) "$SP/bin/timing" node "$HERE/bench.mjs" part=verify runs=3 ;;
  summary) python3 "$HERE/summarize.py" ;;
  all) sh "$0" cost; sh "$0" verify; sh "$0" summary ;;
esac
