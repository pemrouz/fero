#!/bin/sh
# E-13: handover, failover, catch-up per GB (three etcd 3.5.17 members), and the slot-move window
# (three processes of E-10's TypeScript raft port, through E-11's host). Run as root.
# Usage: sh run.sh build | etcd | etcd-t100 | move | table | all
# Timed blocks hold $SP/bin/timing; the build holds $SP/bin/heavy.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
mkdir -p "$HERE/results" "$SP/e13"
case "${1:-all}" in
  build) (cd "$HERE/load" && GOTOOLCHAIN=local GOFLAGS=-mod=mod GOPATH=$SP/e13/gopath GOCACHE=$SP/e13/gocache go build -o "$SP/e13/e13load" .) ;;
  etcd)
    python3 -I "$HERE/etcd.py" move --runs 3
    python3 -I "$HERE/etcd.py" kill --election 1000 --runs 3
    python3 -I "$HERE/etcd.py" kill --election 2000 --runs 3
    python3 -I "$HERE/etcd.py" join --mode log --gb 1 --runs 3
    python3 -I "$HERE/etcd.py" join --mode snap --gb 1 --runs 3 ;;
  etcd-t100)   # the same move and kill runs with a 100 ms per-attempt client timeout, and elections read from the logs
    python3 -I "$HERE/etcd.py" move --runs 3 --timeout 100ms --tag -t100
    python3 -I "$HERE/etcd.py" kill --election 1000 --runs 3 --timeout 100ms --tag -t100
    python3 -I "$HERE/etcd.py" kill --election 2000 --runs 3 --timeout 100ms --tag -t100 ;;
  move) node "$HERE/move/move.mjs" runs=3 ;;
  table) python3 -I "$HERE/etcd.py" table; python3 -I "$HERE/summarize_move.py" ;;
  all)
    "$SP/bin/heavy" sh "$HERE/run.sh" build
    "$SP/bin/timing" sh "$HERE/run.sh" etcd
    "$SP/bin/timing" sh "$HERE/run.sh" etcd-t100
    "$SP/bin/timing" sh "$HERE/run.sh" move
    sh "$HERE/run.sh" table ;;
esac
