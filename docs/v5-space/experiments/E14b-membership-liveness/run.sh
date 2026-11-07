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
#   python3 tools/live.py --list            the runs steps 2 and 3 can name
#   python3 tools/live.py RUN --max-seg K   one run, continued for up to K segments
#
# Needs: java 21, python3 with numpy, and what fetch.sh fetches. Writes
# results/ and cfg/; big files (state graphs, checkpoints, mutant traces)
# stay in $SP/e14b/.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
cd "$HERE"
"$HERE/fetch.sh" > /dev/null
step() { [ -z "$1" ] || [ "$1" = "$2" ]; }

# 1. E-14's finished runs with the real jar and with E-14's stand-ins; then
#    the jar's own TLA+ text with no Java overrides (FoldBag's argument order).
if step "$1" jar; then
  python3 tools/jarcheck.py
  python3 tools/jarcheck.py stale2 r21-append-ef --sets=jartext,jartext-bagstub
fi

# 2. The reductions, each against the model without it, on runs that finish
#    both ways (same verdicts; how many states each removes); and the segment
#    machinery: one run cut into 25-second segments against the same run in
#    one piece.
if step "$1" calib; then
  python3 tools/live.py r21-append-none r21-append-rb r21-append r21-rb r21 r21f r21f-rb
  python3 tools/live.py three-1c three-1c-rbd three-1c1f two-1c1f two-1c1f-append two-1c1f-novote --max-seg 3
  python3 tools/traces.py two-1c1f-novote 16
  python3 tools/segtest.py two-1c1f 25
fi

# 3. The liveness sweep (on commit, with the campaign guard, terms up to 4),
#    the on-append twin, and a lost disk that comes back under its old id.
#    Long runs continue from their checkpoint for up to --max-seg segments.
if step "$1" sweep; then
  python3 tools/live.py four-voters --max-seg 5
  python3 tools/live.py three-ghost three-ghost-loss
  python3 tools/live.py two one one-noq three-disk four-voters-append --max-seg 5
  for r in four-voters-append one three-disk three-ghost three-ghost-loss; do
    last=$(ls -v "$SP/e14b/runs/$r"/seg*.out | tail -1)
    python3 tools/compact_trace.py "$last" > "results/$r-trace.txt" || true
  done
  # Defined in tools/live.py but not run here (too big for the time this
  # shared box gave; see README): four four-append two-append one-append
  # three-disk-append four-novote one-novote two-novote three-disk-noghost
  # four-voters-t5.
fi

# 4. DEV-10's mutants (E-14's 22), exhaustively on small scenarios, cheapest
#    first: pass 1 on m3 and m2 (no fault), pass 2 on m2p (a specific healing
#    plan) and m3c (a leader crash) for the mutants pass 1 did not catch. m4c is defined but too big per mutant
#    (its design run did not finish in 15 minutes).
if step "$1" mutants; then
  python3 tools/mutex.py --design --scen m3,m2,m2p,m3c
  python3 tools/mutex.py --skip-done --scen m3,m2 --cap 600
  python3 tools/mutex.py --skip-done --scen m3,m2,m2p,m3c --cap 900
  python3 tools/mutex.py --table
fi
