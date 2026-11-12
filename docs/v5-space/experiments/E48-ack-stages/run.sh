#!/bin/sh
# E-48: per-operation ack stages inside Raft, on TiKV's shape (the owner's
# question after MEMORY.md: guarantees per operation instead of per resource).
# One exhaustive model in plain Python on E-16's engine (E-17's rule language,
# unchanged), copied from E-47's model and changed, and a brute-force check of
# the Raft step with memory and disk reports.
#
#   ./run.sh              everything below, in order
#   ./run.sh raft         tools/raftcheck48.py: three explicit copies, 1 to 4 entries
#   ./run.sh STEP ...     run48.py steps:
#       base     no rules: S0, S1 (four stage maps), S2 (three); every property, shortest traces
#       crash    the same with the leader's process crash in place of a power loss
#       info     what an early answer's contract allows (EARLY-LOST, RESULT, ...), reported, not counted
#       rules    S1 with W1+O.seq+Y on every stage map, both result modes, both faults
#       subs     each part of W1+O.seq+Y dropped (the DEV-10 ablation)
#       greedy   E-17's greedy ablation for S1, four orders
#       s2       S2 with candidate rule sets
#       verify   the sets that hold, on larger bounds
#
# Each step runs under nice -n 10, each piece under 28 minutes, and under the
# lock wrapper $HEAVY when that file exists (the study ran every step under its
# heavy lock, $SP/bin/heavy). Set HEAVY= to run with no lock.
# Results are cached in results/runs.json, keyed by a hash of the model, so a
# step that stops resumes where it stopped and a changed model runs afresh.
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
STEPS="${*:-raft base crash info rules subs greedy s2 verify}"
for s in $STEPS; do
  if [ "$s" = raft ]; then
    { echo "# E-48 raftcheck48, $(date -u +%FT%TZ), $(python3 --version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"
      $HEAVY timeout 1700 nice -n 10 python3 tools/raftcheck48.py 1 2 3 4; } > results/raftcheck.txt 2>&1
    continue
  fi
  for piece in 1 2 3; do
    rc=0
    $HEAVY timeout 1700 nice -n 10 python3 run48.py "$s" > /dev/null || rc=$?
    [ "$rc" -eq 0 ] && break
    if [ "$rc" -ne 124 ]; then
      echo "step $s failed (exit status $rc); see the error above. results/summary.md not rebuilt" >&2
      exit "$rc"
    fi
    echo "step $s: piece $piece stopped at 28 minutes; carrying on from results/runs.json" >&2
  done
done
python3 report48.py > results/summary.md
