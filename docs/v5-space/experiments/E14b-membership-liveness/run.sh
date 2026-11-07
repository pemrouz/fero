#!/bin/sh
# E-14b: E-14 finished. The real CommunityModules jar in place of E-14's
# stand-ins, the liveness sweep at 3 to 4 servers with 2 changes, the five
# healing scenarios E-14 defined but did not run, and DEV-10's mutants by
# exhaustive search.
#
#   ./run.sh              everything below, in order (several CPU-hours; every
#                         TLC run takes the study's heavy lock, and a run longer
#                         than one hold is split into checkpointed segments of
#                         at most 25 minutes)
#   ./run.sh jar          step 1 only
#   ./run.sh calib        step 2 only
#   ./run.sh sweep        step 3 only
#   ./run.sh mutants      step 4 only
#   python3 tools/live.py --list            the runs step 3 can name
#   python3 tools/live.py RUN --max-seg K   one run, continued for up to K segments
#
# Needs: java 21, python3 with numpy, and what fetch.sh fetches. Writes
# results/ and cfg/; big files (state graphs, checkpoints) stay in
# $SP/e14b/runs.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
cd "$HERE"
"$HERE/fetch.sh" > /dev/null
step() { [ -z "$1" ] || [ "$1" = "$2" ]; }

# 1. E-14's finished runs, with the real jar and with E-14's stand-ins.
if step "$1" jar; then
  python3 tools/jarcheck.py
fi

# 2. The reductions: each against the model without it, on runs that finish
#    both ways (the same verdicts, and how many states each removes); and the
#    segment machinery: one run cut into 60-second segments against the same
#    run in one piece.
if step "$1" calib; then
  python3 tools/live.py r21-full r21-append-full r21 r21-append three-1c three-1c-ready three-1c-full
  python3 tools/segtest.py
fi

# 3. The liveness sweep (on commit, with the campaign guard), the on-append
#    mutant on the same scenarios, the learners-refuse-votes ablation and the
#    lost disk that comes back under its old id.
if step "$1" sweep; then
  for r in four-voters two one three-disk four; do
    python3 tools/live.py "$r" --max-seg 8
  done
  for r in four-voters-append two-append one-append three-disk-append four-append; do
    python3 tools/live.py "$r" --max-seg 8
  done
  python3 tools/live.py four-novote one-novote two-novote --max-seg 4
  python3 tools/live.py three-ghost three-disk-noghost --max-seg 2
fi

# 4. DEV-10's mutants (E-14's 22), exhaustively on four small scenarios.
if step "$1" mutants; then
  python3 tools/mutex.py --design
  python3 tools/mutex.py --skip-done
  python3 tools/mutex.py --table
fi
