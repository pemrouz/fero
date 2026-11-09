#!/bin/sh
# E-25: idle failure-detector cost at n = 100. Usage: sh run.sh [build|model|time|summary|all]
# (a) is a model; (b) and (c) are timed under $SP/bin/timing; the Rust build holds $SP/bin/heavy.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
case "${1:-all}" in
  build) (cd "$HERE/rs" && CARGO_TARGET_DIR=$SP/e11/target cargo build --release --locked -q) ;;   # shares E-11's compiled raft-rs
  model) python3 "$HERE/model.py" ;;
  time) node "$HERE/bench.mjs" part=b runs=3; node "$HERE/bench.mjs" part=c runs=3 ;;
  summary) python3 "$HERE/summarize.py" ;;
  all) "$SP/bin/heavy" sh "$0" build; sh "$0" model; "$SP/bin/timing" sh "$0" time; sh "$0" summary ;;
esac
