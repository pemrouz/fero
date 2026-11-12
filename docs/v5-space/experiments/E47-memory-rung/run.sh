#!/bin/sh
# E-47: the `memory` rung inside Raft, on TiKV's shape (VERDICT 9 step 2b; K-09;
# RR-11 to RR-14). One exhaustive model in plain Python on E-16's engine (E-17's
# rule language, unchanged), and a brute-force check of its Raft abstraction.
#
#   ./run.sh              everything below, in order (about 45 minutes on one core)
#   ./run.sh raft         tools/raftcheck.py: three explicit replicas against the
#                         model's cut range [k, len], 1 to 6 entries; elections
#                         by vote, and the operator's recovery (`fero recover
#                         --unclean`) under two readings
#   ./run.sh STEP ...     run47.py steps:
#       base     runs 1 to 4: no rules; every property broken, each with its shortest trace
#       info     what the rung's contract allows (LOST, READBACK), reported, not counted
#       rules    run 5: R1+R2+R3+R4 together, then each one dropped (the DEV-10 ablation)
#       sets     run 5: each candidate rule set on its own
#       subs     run 5: each part of R2 and of R1s+R3+R2.claim dropped
#       w1       R4 with the tightest window (sync before the next append)
#       greedy   E-17's greedy ablation, three orders over whole rules, one over R2's parts
#       row      lock tokens from a counter in the row instead of TSO timestamps
#       verify   the sets that hold, on larger bounds (state limit 6 million)
#
# Each step runs under nice -n 10, each piece under 28 minutes, and under the
# lock wrapper $HEAVY when that file exists (the study ran every step under its
# heavy lock, $SP/bin/heavy). Set HEAVY= to run with no lock.
# Results are cached in results/runs.json, keyed by a hash of the model, so a
# step that stops resumes where it stopped and a changed model runs afresh.
# Delete results/runs.json to run everything afresh.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY-$SP/bin/heavy}"
if [ -n "$HEAVY" ] && [ ! -x "$HEAVY" ]; then
  echo "no lock wrapper at $HEAVY: running without a lock" >&2
  HEAVY=
fi
cd "$HERE"
mkdir -p results
STEPS="${*:-raft base info rules sets subs w1 greedy row verify}"
for s in $STEPS; do
  if [ "$s" = raft ]; then
    { echo "# E-47 raftcheck, $(date -u +%FT%TZ), $(python3 --version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"
      $HEAVY timeout 1700 nice -n 10 python3 tools/raftcheck.py 1 2 3 4 5 6; } > results/raftcheck.txt 2>&1
    continue
  fi
  for piece in 1 2 3; do
    rc=0
    $HEAVY timeout 1700 nice -n 10 python3 run47.py "$s" > /dev/null || rc=$?
    [ "$rc" -eq 0 ] && break
    if [ "$rc" -ne 124 ]; then
      echo "step $s failed (exit status $rc); see the error above. results/summary.md not rebuilt" >&2
      exit "$rc"
    fi
    echo "step $s: piece $piece stopped at 28 minutes; carrying on from results/runs.json" >&2
  done
done
python3 report47.py > results/summary.md
