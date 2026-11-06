#!/bin/sh
# E-09e: etcd 3.5.17, three members on this box, measured with etcd's own benchmark tool (v3.5.17).
#   sh run.sh build        build the lock loop (lockbench) into $SP/e09/bin (needs fetch.sh first)
#   sh run.sh calibrate    short untimed runs that size each config's --total (writes totals.json)
#   sh run.sh all          the three timing holds below, 3 runs per config, then the table
#   sh run.sh put|range|ops   one timing hold
#   sh run.sh table        results/runs.jsonl -> results/tables.md
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
B="python3 -I $HERE/bench.py"
case "${1:-all}" in
  build)     mkdir -p "$SP/e09/bin"; (cd lockbench && GOTOOLCHAIN=local "$SP/bin/heavy" go build -mod=readonly -trimpath -o "$SP/e09/bin/lockbench" .) ;;
  calibrate) "$SP/bin/heavy" $B calibrate ;;
  put)   "$SP/bin/timing" $B run put-1c put-1000c put-1000c-all put-1c-nofsync put-1000c-nofsync ;;
  range) "$SP/bin/timing" $B run range-l-1c range-l-1000c range-s-1c range-s-1000c ;;
  ops)   "$SP/bin/timing" $B run txn-put-1c txn-put-1000c lease-keepalive-1000c stm-1c stm-1000c stm-lock-1c lock-1c lock-100c ;;
  table) $B table ;;
  all)   sh "$0" put; sh "$0" range; sh "$0" ops; $B table ;;
  *) echo "unknown block $1"; exit 1 ;;
esac
