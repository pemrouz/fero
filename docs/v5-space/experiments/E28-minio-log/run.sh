#!/bin/sh
# E-28 timing part: MinIO conditional PUTs on this disk. Usage: sh run.sh [build|time|summary|all]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/fero-sp}
export SP
case "${1:-all}" in
  build) mkdir -p "$SP/e28"; (cd "$HERE/put" && GOTOOLCHAIN=local go build -o "$SP/e28/e28put" .) ;;
  time) for r in 1 2 3; do "$SP/bin/timing" sh "$HERE/bench.sh" $r; done ;;
  summary) python3 "$HERE/summarize.py" ;;
  all) sh "$0" build; sh "$0" time; sh "$0" summary ;;
esac
