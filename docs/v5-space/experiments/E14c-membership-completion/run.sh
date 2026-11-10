#!/bin/sh
# E-14c: E-14b finished. Two of etcd's shipped invariants replaced by the
# properties Raft really needs (and shown to still catch real bugs), the
# liveness verdicts for three-disk and four, and mutant r19 settled.
#
#   ./run.sh              everything below, in order (several CPU-hours; every
#                         TLC segment takes the study's heavy lock for at most
#                         25 minutes, and no new segment starts in US Eastern
#                         peak hours, 8 AM to 2 PM on weekdays)
#   ./run.sh calib        step 1: the new invariant set on runs E-14b finished
#   ./run.sh bugs         step 2: do the replacements still catch real bugs?
#   ./run.sh sweep        step 3: three-disk and four, to completion
#   ./run.sh r19          step 4: mutant r19, one term further
#   python3 tools/run14c.py --list           the runs steps 1 and 3 can name
#   python3 tools/run14c.py RUN --max-seg K   one run, continued for up to K segments
#
# Needs: java 21, python3 with numpy, what fetch.sh fetches, and E-14's and
# E-14b's model files next to this folder (read-only). Writes results/ and
# cfg/; big files (state graphs, checkpoints) stay in $SP/e14c/.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
cd "$HERE"
"$HERE/fetch.sh" > /dev/null
mkdir -p "$SP/e14c/runs"
step() { [ -z "$1" ] || [ "$1" = "$2" ]; }

# 1. The new set on runs E-14b finished (three-1c, three-1c1f, two-1c1f) or
#    stopped at a false alarm (one): the history variable's cost (states
#    against E-14b's) and the false alarm gone.
if step "$1" calib; then
  python3 tools/run14c.py three-1c three-1c1f one two-1c1f --redo
fi

# 2. The bugs: a lost disk back under its old id, three bugs planted in
#    etcdraft.tla, and E-14's mutants that E-14b caught with a replaced
#    invariant. Each planted bug is checked once per invariant set.
if step "$1" bugs; then
  python3 tools/bugs.py ghost minority anylog twovote mutants
fi

# 3. The liveness sweep: three-disk and four at E-14b's bounds (on commit,
#    the campaign guard, terms up to 4 judged at 2, one crash or lost disk,
#    two changes), each continued from its checkpoint until it finishes.
if step "$1" sweep; then
  E14C_KEEP=1 python3 tools/run14c.py three-disk --max-seg 20
  E14C_KEEP=1 python3 tools/run14c.py four --max-seg 30
  python3 tools/classify.py "$SP/e14c/keep/three-disk" 3 > results/three-disk-classify.txt
  python3 tools/classify.py "$SP/e14c/keep/four" 3 > results/four-classify.txt
fi

# 4. r19: the design and the mutant on m3 and m2p, terms up to 5, judged at
#    3, then the stuck states sorted by kind, with the shortest trace to each.
if step "$1" r19; then
  python3 tools/r19.py m3 m2p
  W="$SP/e14c/runs"
  { echo "# tools/classify.py on design-m3-t5 (judged at term 3)"; python3 tools/classify.py "$W/design-m3-t5" 3
    echo; echo "# tools/classify.py on r19-m3-t5 (judged at term 3)"; python3 tools/classify.py "$W/r19-m3-t5" 3
  } > results/r19-classify.txt
fi

python3 tools/table.py
