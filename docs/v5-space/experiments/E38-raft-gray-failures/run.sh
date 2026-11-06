#!/bin/sh
# E-38 (a, b): etcd's raft under partial partitions, one-way loss, leader
# transfer and a fail-slow node, in a deterministic simulation.
# Usage: ./run.sh            all suites (about 20 CPU-minutes, single thread)
#        ./run.sh named      one suite
# Output: results/<suite>.jsonl (one JSON line per run) and results/summary.txt
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY:-$SP/bin/heavy}"
B="$SP/e38/build"
export GOTOOLCHAIN=go1.26.10
mkdir -p "$B" "$HERE/results"
cd "$HERE/harness"
./patch-raft.sh "$SP/e38/raft-patched"
cp sim.go main.go go.mod go.sum "$B"/
cd "$B"
go mod edit -replace go.etcd.io/raft/v3="$SP/e38/raft-patched"
$HEAVY go build -o e38 .
SUITES="${1:-named transfer slow sweep3 ablate sweep5}"
for s in $SUITES; do
  case $s in
    sweep3) ARGS="-seeds 3" ;;
    ablate) ARGS="-seeds 2" ;;
    sweep5) ARGS="-seeds 2 -count 150" ;;
    *) ARGS="-seeds 5" ;;
  esac
  echo "suite $s $ARGS"
  rm -f "$HERE/results/$s.jsonl.gz"
  $HEAVY ./e38 -suite $s $ARGS > "$HERE/results/$s.jsonl"
done
python3 "$HERE/summarize.py" "$HERE/results" > "$HERE/results/summary.txt"
# (the committed results/*.jsonl are gzipped to keep the repo small; summarize.py reads either)
cat "$HERE/results/summary.txt"
