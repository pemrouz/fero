#!/bin/bash
# E-46: re-run everything. Needs fetch.sh first (Maelstrom 0.2.4, Porcupine v1.3.1), a JDK, Node 22, Go
# and gnuplot (apt-get install gnuplot-nox; Jepsen draws its latency plots with it).
# Each batch of matrix.txt takes the shared heavy lock on its own, so one hold stays near 30 minutes.
# Output: $E46_RUNS (default $SP/e46/runs): one folder per run, and summary.jsonl; then report.sh writes
# results/. A background task here may stop after 2 hours while a batch waits for the lock:
# E46_BATCHES="D E F" ./run.sh resumes. Batch G is in matrix.txt but was not run here (README):
# E46_BATCHES=G ./run.sh runs it. E46_TIMEOUT=400 caps each Maelstrom run, checker included (batches
# A-E ran with no cap, and stale5-s2's Knossos search was stopped by hand; F ran with 400, never reached).
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
export E46_RUNS="${E46_RUNS:-$SP/e46/runs}"
mkdir -p "$E46_RUNS"
for b in ${E46_BATCHES:-A B C D E F}; do
  "$SP/bin/heavy" "$HERE/batch.sh" "$b"
done
"$HERE/report.sh"
