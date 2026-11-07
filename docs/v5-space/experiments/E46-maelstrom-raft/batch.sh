#!/bin/bash
# Run every line of matrix.txt whose first column is the given batch, one after another.
# Optional 10th and 11th columns set --concurrency (default 4n) and --rate (default 50).
# run.sh calls this once per batch under the heavy lock, so each lock hold stays near 30 minutes.
set -uo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
grep -E "^$1 " "$HERE/matrix.txt" | while read -r _ name nodes read seed secs nemesis pause compact conc rate; do
  "$HERE/run-one.sh" "$name" "$nodes" "$read" "$seed" "$secs" "$nemesis" "$pause" "$compact" "${rate:-50}" "${conc:-4n}" </dev/null
done
