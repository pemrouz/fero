#!/bin/sh
# E-09b: NATS 2.10.22 measured with the nats CLI 0.5.1 (nats bench, nats latency).
#   sh run.sh all          the timing holds below (3 runs per setup, each on fresh servers), then the table
#   sh run.sh core|always|default   one timing hold
#   sh run.sh table        results/runs.jsonl -> results/tables.md
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
B="python3 -I $HERE/bench.py"
case "${1:-all}" in
  core)    "$SP/bin/timing" $B run core core-route ;;
  always)  "$SP/bin/timing" $B run js-always ;;
  default) "$SP/bin/timing" $B run js-default ;;
  table)   $B table ;;
  all)     sh "$0" core; sh "$0" always; sh "$0" default; $B table ;;
  *) echo "unknown block $1"; exit 1 ;;
esac
