#!/bin/sh
# E-14: membership changes that take effect on commit, checked with TLC on
# etcd's own TLA+ spec (etcdraft.tla, unmodified) plus fero's additions.
#
#   ./run.sh               everything below (about 5 CPU-hours; each TLC run
#                          holds the study's heavy lock for at most 30 min)
#   ./run.sh RUN ...       some runs (python3 tools/run.py --list)
#   ./run.sh mutants       the DEV-10 mutants only
#
# Needs: java, python3, and what fetch.sh fetches. Writes results/.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
export TLA_JAR="${TLA_JAR:-$SP/dl/tla/tla2tools.jar}"
export RAFT_TLA="${RAFT_TLA:-$SP/dl/raftsrc/raft/tla}"
export HEAVY="${HEAVY:-$SP/bin/heavy}"
cd "$HERE"
"$HERE/fetch.sh" > /dev/null
if [ "$1" = mutants ]; then
  python3 tools/mutate_run.py
  exit 0
fi
if [ $# -gt 0 ]; then
  python3 tools/run.py "$@"
  exit 0
fi
# 1. The shipped spec as shipped (it does not finish; capped at 10 min), and
#    one scripted behavior of it (seconds).
python3 tools/run.py shipped-asis --timeout 600
python3 tools/run.py staleconfig
# 2. The same behavior on fero's model: the design, and without the guard.
python3 tools/run.py stale2 stale2-mutant
# 3. healing.py's R2-1, from the state after its fault: on append (all
#    states, then the graph check), on commit (a scripted way out), and the
#    two on-commit searches that did not finish here.
python3 tools/run.py r21-append-ef r21-append r21-script
python3 tools/run.py r21-ef --timeout 1500
python3 tools/run.py r21 --timeout 1800
# 4. Two scenarios from a leader in place (did not finish here).
python3 tools/run.py two --timeout 1500
python3 tools/run.py four-voters --timeout 1800
# 5. DEV-10's mutants, in four slices of under 30 minutes each.
python3 tools/mutate_run.py --slice 1/4 --secs 120
for k in 2 3 4; do python3 tools/mutate_run.py --slice $k/4 --secs 120 --no-design; done
python3 tools/mutate_run.py --table
# Other runs defined in tools/run.py (python3 tools/run.py --list) were
# planned but not run on this box; see README.
