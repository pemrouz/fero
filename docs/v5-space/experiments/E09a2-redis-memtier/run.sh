#!/bin/sh
# E-09a2: Redis 7.0.15 driven by memtier_benchmark 2.5.2, on E-09a's three setups, with same-hold
# redis-benchmark controls, and memtier against E-45's RESP gateway over the E-22 prototype (a simulator).
#   sh run.sh all            every timing hold below, in order (each well under 30 minutes), then the table
#   sh run.sh default|aof|r3|b2|proto  one timing hold (3 runs per config, round-robin, resumable); b2 repeats
#                            aof's matched rows beside r3, because the VM rebooted between aof and r3
#   sh run.sh default2       the default setup's GET and INCR redis-benchmark controls (added after the
#                            default hold had run with SET controls only), then probe 1
#   sh run.sh probe2         probe 2: pipeline-16 rows once more with run-queue waits, and memtier GET on
#                            2 threads x 100 and 1 thread x 200 connections (results/probe.jsonl, not timed rows)
#   sh run.sh smoke          a short unrecorded run of six configs (plumbing check; heavy lock, not timing)
#   sh run.sh table          results/runs.jsonl -> results/tables.md (with the row-by-row comparison to E-09a),
#                            and the kept memtier JSON ($SP/e09a2/keep) -> results/tails.md
# The timed holds resume (a run already in results/runs.jsonl is skipped); the probes do not (they append to
# results/probe.jsonl), so `all` is for an empty results/ folder.
# Needs: memtier at $SP/opt/memtier/bin/memtier_benchmark (fetch.sh), redis-server and redis-benchmark 7.0.15
# (Ubuntu), Node 22 for the prototype host (../E45-drivers/host.ts, which loads ../E22-api-prototype and data).
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
B="python3 -I $HERE/bench.py"
P1="default-set-p1 default-set-p1-rb default-set-p16 default-set-p16-rb default-get-p16 default-get-p16-rb default-incr-p16 default-incr-p16-rb"
P2="default-get-p16 default-get-p16-rb probe-default-get-p16-t2 probe-default-get-p16-t1 default-set-p16 default-set-p16-rb default-incr-p16 default-incr-p16-rb"
case "${1:-all}" in
  default)  "$SP/bin/timing" $B run default-set default-get default-incr default-mix ;;  # 8 memtier configs + controls, x3
  aof)      "$SP/bin/timing" $B run aof-set aof-get aof-incr aof-mix ;;      # same on appendfsync always
  r3)       "$SP/bin/timing" $B run aof-r3- ;;                              # 6 memtier configs + 4 controls, x3
  b2)       "$SP/bin/timing" $B run b2- ;;      # aof's matched rows again, beside r3 (they ran on a new boot of the VM)
  proto)    "$SP/bin/timing" $B run proto- ;;                               # the E-22 simulator behind E-45's RESP gateway
  default2) "$SP/bin/timing" sh -c "$B run default-get default-incr && $B probe $P1" ;;
  probe2)   "$SP/bin/timing" $B probe $P2 ;;
  smoke)    "$SP/bin/heavy" $B smoke default-get-p16 default-incr-p1 aof-r3-mix-p16 default-set-p1-rb proto-incr-p16 proto-set-p1-rb ;;
  table)    $B table && $B tails ;;
  all)      for b in default aof default2 r3 b2 proto probe2; do sh "$0" $b; done; $B table && $B tails ;;
  *) echo "unknown block $1"; exit 1 ;;
esac
