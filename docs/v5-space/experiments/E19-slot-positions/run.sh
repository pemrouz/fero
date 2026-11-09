#!/bin/sh
# E-19: what slot-shaped positions cost. Usage: sh run.sh [build|time|summary|all]
# The byte counts are exact and need no lock; the ns columns are light timing, run under $SP/bin/timing,
# 3 runs each, Node then Rust then the cursor program, with /proc/loadavg recorded in every JSON line.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
BIN=$SP/e19/target/release/e19header
case "${1:-all}" in
  build) (cd "$HERE/rs" && CARGO_TARGET_DIR=$SP/e19/target cargo build --release -q) ;;
  time)
    for r in 1 2 3; do
      node "$HERE/node/header.mjs" secs=2 >> "$HERE/results/header.jsonl"
      "$BIN" secs=2 >> "$HERE/results/header.jsonl"
      node "$HERE/node/cursor.mjs" secs=2 >> "$HERE/results/cursor.jsonl"
    done ;;
  summary) python3 "$HERE/summarize.py" > "$HERE/results/tables.md"; cat "$HERE/results/tables.md" ;;
  all) "$SP/bin/heavy" sh "$0" build; "$SP/bin/timing" sh "$0" time; sh "$0" summary ;;
esac
