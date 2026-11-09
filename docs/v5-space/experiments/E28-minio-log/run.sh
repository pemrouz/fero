#!/bin/sh
# E-28 timing part: MinIO conditional PUTs on this disk. Usage: sh run.sh [build|time|summary|all]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
case "${1:-all}" in
  build) mkdir -p "$SP/e28"; (cd "$HERE/put" && GOTOOLCHAIN=local go build -o "$SP/e28/e28put" .) ;;
  time) for r in 1 2 3; do "$SP/bin/timing" sh "$HERE/bench.sh" $r; done ;;
  summary) python3 "$HERE/summarize.py" ;;
  all) sh "$0" build; sh "$0" time; sh "$0" summary ;;
esac
