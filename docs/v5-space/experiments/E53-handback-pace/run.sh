#!/bin/sh
# E-53: the hand-back's pace (V5-7) on real code: E-26's host on E-10's TypeScript Raft port, with E-49's patches
# and the hand-back's own (host-patch.mjs), three processes on loopback, R groups each (one per resource).
# Usage: sh run.sh [pace|load|settle|liveness|recheck|recheck-live|summary|all]
#   pace     no load. scenario restart (kill -9 member 2, failover, restart from its journal, hand back about R/3)
#            and cold (a whole-project cold boot by Raft's random timers, every member takes back its own, about
#            2R/3 in all), at R = 1,000, 10,000 and 100,000, with pace rate:10 (DESIGN-V5's ten a second) and
#            cap:8, cap:32, cap:128 (V5-7: transfers in flight per member), random order. Ten a second at
#            100,000 is stopped after 60 s and its end computed from the rate it held. Three runs each
#   load     a write load on 300 random groups at 10 writes a second each (client.mjs) at R = 1,000 and 10,000:
#            no hand-back (the control), cap:$BEST random, cap:8, cap:32 and cap:128 busiest first, and rate:10
#            busiest first (stopped after 30 s: by then the loaded groups have moved); at R = 100,000 the control,
#            cap:8 and cap:$BEST busiest first only. Three runs each
#   settle   the design's settle.ms of 30 s in place of the harness's 10 s, cap:8 (the recommended default), R = 100,000,
#            both scenarios
#   liveness a giver dies in the middle of a hand-back: with the cap's 3 s timeout and without it (not a timing; heavy)
#   summary  results/tables.md (summarize.py)
# Added after the skeptic's check (README, "After the skeptic's check"):
#   recheck  F-05's cells again, busiest first, 300 loaded groups: cap 8 at R = 1,000 and 10,000 (10 runs) and 100,000
#            (5 runs, settle 20 s so the like-for-like control fits before the hand-back), and cap 4 at 10,000 (10 runs);
#            the writes that met a transfer are marked (host patch 16). One timing hold per scenario, runs interleaved
#   recheck-live  not a timing (heavy): cap 8 with and without the 3 s timeout when a giver dies (as liveness), and
#            the givers' side: transfers to the dead member still set 30 s after it died, as designed and with host
#            patch 18 (a group with a transfer in flight does not go quiet)
# Each run of each scenario holds $SP/bin/timing once, over all its configurations (a lock: no other timed run and
# no heavy job overlaps it; 10-25 minutes each).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
T="$SP/bin/timing"
BEST=${BEST:-32}
H="node $HERE/handback.mjs"
mkdir -p "$HERE/results"

# the dispatch is one brace group ending in exit, so editing this file during a run is safe
{
case "${1:-all}" in
  pace) for r in 1 2 3; do for s in restart cold; do $T sh "$HERE/run.sh" _pace $r $s; done; done ;;
  _pace)   # one timing hold: one run of one scenario, every pace
    r=$2; s=$3
    for p in cap:8 cap:32 cap:128; do $H runs=$r scenario=$s pace=$p scales=1000,10000,100000; done
    $H runs=$r scenario=$s pace=rate:10 scales=1000,10000
    $H runs=$r scenario=$s pace=rate:10 scales=100000 max=60 ;;
  load) for r in 1 2 3; do for s in restart cold; do $T sh "$HERE/run.sh" _load $r $s; done; done ;;
  _load)   # one timing hold: one run of one scenario, every configuration
    r=$2; s=$3
    $H runs=$r scenario=$s pace=none load=300 wrate=10 scales=1000,10000,100000 out=load.jsonl
    $H runs=$r scenario=$s pace=cap:$BEST order=random load=300 wrate=10 scales=1000,10000 out=load.jsonl
    for c in 8 32 128; do
      if [ "$c" = "$BEST" ] || [ "$c" = 8 ]; then sc=1000,10000,100000; else sc=1000,10000; fi
      $H runs=$r scenario=$s pace=cap:$c order=busy load=300 wrate=10 scales=$sc out=load.jsonl
    done
    $H runs=$r scenario=$s pace=rate:10 order=busy load=300 wrate=10 scales=1000,10000 max=30 out=load.jsonl ;;
  settle) for r in 1 2 3; do $T sh "$HERE/run.sh" _settle $r; done ;;
  _settle) r=$2; for s in restart cold; do $H runs=$r scenario=$s pace=cap:8 settle=30 scales=100000 out=settle.jsonl; done ;;   # cap 8: the recommended default
  recheck) for s in restart cold; do $T sh "$HERE/run.sh" _recheck $s; done ;;
  _recheck)   # one timing hold: one scenario, every R and cap, runs interleaved
    s=$2
    for r in 1 2 3 4 5 6 7 8 9 10; do
      $H runs=$r scenario=$s pace=cap:8 order=busy load=300 wrate=10 scales=1000,10000 out=recheck.jsonl
      $H runs=$r scenario=$s pace=cap:4 order=busy load=300 wrate=10 scales=10000 out=recheck.jsonl
      if [ $r -le 5 ]; then $H runs=$r scenario=$s pace=cap:8 order=busy load=300 wrate=10 scales=100000 settle=20 out=recheck.jsonl; fi
    done ;;
  recheck-live) "$SP/bin/heavy" sh "$HERE/run.sh" _recheck_live ;;
  _recheck_live)
    for r in 1 2 3 4 5; do   # cap 8 without the timeout (five runs each R)
      $H runs=$r scenario=cold pace=cap:8 scales=1000 kill=50 timeout=1000000000 wait=40 settle=5 probe=30 out=liveness.jsonl
      $H runs=$r scenario=cold pace=cap:8 scales=10000 kill=200 timeout=1000000000 wait=40 settle=5 probe=30 out=liveness.jsonl
    done
    for r in 1 2 3; do   # the givers' side at cap 32 as designed and with patch 18; cap 8 with the timeout
      for xa in 0 1; do
        $H runs=$r scenario=cold pace=cap:32 scales=1000 kill=50 timeout=3000 wait=40 settle=5 probe=30 xferawake=$xa out=xfer.jsonl
        $H runs=$r scenario=cold pace=cap:32 scales=10000 kill=200 timeout=3000 wait=40 settle=5 probe=30 xferawake=$xa out=xfer.jsonl
      done
      $H runs=$r scenario=cold pace=cap:8 scales=1000 kill=50 timeout=3000 wait=40 settle=5 probe=30 out=liveness.jsonl
      $H runs=$r scenario=cold pace=cap:8 scales=10000 kill=200 timeout=3000 wait=40 settle=5 probe=30 out=liveness.jsonl
    done ;;
  liveness)   # not a timing: a giver (member 3) is killed 50 ms (R = 1,000) or 200 ms (R = 10,000) into a cold boot's
               # hand-back at cap 32; with the 3 s timeout and without it (1e9 ms), do members 1 and 2 finish? Five runs each
    "$SP/bin/heavy" sh "$HERE/run.sh" _liveness ;;
  _liveness)
    for r in 1 2 3 4 5; do for t in 3000 1000000000; do
      $H runs=$r scenario=cold pace=cap:32 scales=1000 kill=50 timeout=$t wait=40 settle=5 out=liveness.jsonl
      $H runs=$r scenario=cold pace=cap:32 scales=10000 kill=200 timeout=$t wait=40 settle=5 out=liveness.jsonl
    done; done ;;
  summary) python3 "$HERE/summarize.py" "$HERE/results" > "$HERE/results/tables.md"; cat "$HERE/results/tables.md" ;;
  all) sh "$0" pace; sh "$0" load; sh "$0" settle; sh "$0" liveness; sh "$0" recheck; sh "$0" recheck-live; sh "$0" summary ;;
  *) echo "usage: sh run.sh [pace|load|settle|liveness|recheck|recheck-live|summary|all]"; exit 2 ;;
esac
exit 0
}
