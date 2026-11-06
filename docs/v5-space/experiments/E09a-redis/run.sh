#!/bin/sh
# E-09a: Redis 7.0.15 (Ubuntu package) measured with redis-benchmark 7.0.15, plus respbench for SET + WAIT.
#   sh run.sh build        build respbench (Go standard library only) into $SP/e09/bin
#   sh run.sh all          the timing holds below, 3 runs per config, then the table
#   sh run.sh default|aof|r3   one timing hold
#   sh run.sh table        results/runs.jsonl -> results/tables.md
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
B="python3 -I $HERE/bench.py"
case "${1:-all}" in
  build)   mkdir -p "$SP/e09/bin"; (cd respbench && GOTOOLCHAIN=local "$SP/bin/heavy" go build -trimpath -o "$SP/e09/bin/respbench" .) ;;
  default) "$SP/bin/timing" $B run default- ;;
  aof)     "$SP/bin/timing" $B run aof-set aof-get aof-incr ;;
  r3)      "$SP/bin/timing" $B run aof-r3- ;;
  table)   $B table ;;
  all)     sh "$0" default; sh "$0" aof; sh "$0" r3; $B table ;;
  *) echo "unknown block $1"; exit 1 ;;
esac
