#!/bin/bash
# E-46: re-run everything. Needs fetch.sh first (Maelstrom 0.2.4), a JDK, Node 22 and gnuplot
# (apt-get install gnuplot-nox; Jepsen draws its latency plots with it).
# Each batch of matrix.txt takes the shared heavy lock on its own, so one hold stays near 30 minutes.
# Output: $E46_RUNS (default $SP/e46/runs): one folder per run, and summary.jsonl; then the
# table, the trimmed runs and the warning scan in results/. A background task here may stop
# after 2 hours while a batch waits for the lock: E46_BATCHES="D E" ./run.sh resumes.
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
export E46_RUNS="${E46_RUNS:-$SP/e46/runs}"
mkdir -p "$E46_RUNS"
for b in ${E46_BATCHES:-A B C D E}; do
  "$SP/bin/heavy" "$HERE/batch.sh" "$b"
done
python3 -I "$HERE/table.py" "$E46_RUNS/summary.jsonl" > "$HERE/results/runs.md"
cp "$E46_RUNS/summary.jsonl" "$HERE/results/summary.jsonl"
python3 -I "$HERE/trim.py" "$E46_RUNS" "$HERE/results/runs"
python3 -I "$HERE/tools/scan_warnings.py" "$E46_RUNS" > "$HERE/results/warnings.txt"
