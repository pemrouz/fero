#!/bin/bash
# Run every line of matrix.txt whose first column is the given batch, one after another.
# run.sh calls this once per batch under the heavy lock, so each lock hold stays near 30 minutes.
set -uo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
grep -E "^$1 " "$HERE/matrix.txt" | while read -r _ name nodes read seed secs nemesis pause compact; do
  "$HERE/run-one.sh" "$name" "$nodes" "$read" "$seed" "$secs" "$nemesis" "$pause" "$compact" 50 4n </dev/null
done
