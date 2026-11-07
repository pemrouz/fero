#!/bin/sh
# E-15: the slot move in TLA+ (tla/SlotMove.tla), cross-checked against
# docs/v5-spec/slot_move.py on the runs of its plan() (26 variants, 6 bounds),
# then DEV-10's mechanical mutants of the fixed protocol (tla/SlotMoveFixed.tla).
#
#   ./run.sh            every step below, in order
#   ./run.sh plan       both checkers on every run of slot_move.py's plan()
#                       that fits one lock hold (TLC: up to 4.5 million states)
#   ./run.sh three      TLC on `fixed three` (7.5 million states), in
#                       checkpointed segments of at most 22 minutes each
#                       (here it finished in one: 22.9 minutes, two workers)
#   ./run.sh replay     replay each slot_move.py counterexample in TLC
#   ./run.sh compare    results/compare.md and results/mdcheck.md
#   ./run.sh equiv      SlotMoveFixed against SlotMove's "fixed" variant
#   ./run.sh mutants    the mechanical mutants: all on `move`, then the ones
#                       `move` does not catch on write0
#   ./run.sh link       mutant m131 (links that do not check incarnations),
#                       which survived move and write0, also on write and moves
#   ./run.sh mutants_more  (not run here) the ones still uncaught, on deep
#                       and dedup
#
# Runs already done are skipped (delete results/<dir>/<run>.json to redo).
# Every step holds the study's heavy lock ($SP/bin/heavy) in pieces of at
# most about 25 minutes. TLC runs with two workers (E15_WORKERS) for the
# plan, one worker for replays and mutants. With two workers TLC's
# breadth-first depth can in principle come out one step high; compare.md
# checks every step count against slot_move.py, and none did.
#
# Not run by this script (too big for the budget; see the README's gaps):
#   python3 tools/segments.py no-exporting moves --loop        (14.7 M states)
#   python3 tools/segments.py no-exporting three --loop --cap 7000000
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
export HEAVY="${HEAVY:-$SP/bin/heavy}"
cd "$HERE"
"$HERE/fetch.sh" > /dev/null

plan() { python3 tools/batch.py --loop --budget 1500; }
three() { E15_HEAP=6g python3 tools/segments.py fixed three --loop --workers 2 --seconds 1320; }
replay() {
  # each pass holds the lock for at most ~25 minutes
  while python3 - <<'EOF'
import glob, json, os, sys
sp = os.environ['SP']
done = json.load(open('results/replays.json')) if os.path.exists('results/replays.json') else {}
todo = [d for d in glob.glob(f'{sp}/e15/replays/*') if os.path.basename(d) not in done]
sys.exit(0 if todo else 1)
EOF
  do "$HEAVY" python3 tools/replay.py --no-heavy --budget 1500; done
  python3 tools/replay.py --table
}
compare() {
  python3 tools/compare.py --json > results/compare.md; tail -1 results/compare.md
  python3 tools/mdcheck.py > results/mdcheck.md
}
equiv() { "$HEAVY" python3 tools/mutants.py --equiv --no-heavy; }
mutants() {
  # pass 1: every mutant on `move` (safety, then property 7)
  export E15_MUT_BOUNDS=move
  while [ "$(python3 tools/mutants.py --left)" != 0 ]; do
    "$HEAVY" python3 tools/mutants.py --run --no-heavy --budget 1320
  done
  # pass 2: the mutants `move` does not catch, on write0 (a write, a resend,
  # a recovery). This is where the README's DEV-10 numbers stop.
  export E15_MUT_BOUNDS=move,write0
  "$HEAVY" python3 -c "import sys; sys.path.insert(0, 'tools'); import mutants; mutants.HEAVY = False; print(mutants.fixed_counts())"
  # two one-worker processes share the pass: each claims a mutant before it runs it
  until python3 tools/mutants.py --survivors-left | grep -qx 0; do
    "$HEAVY" python3 tools/mutants.py --run --redo-survivors --no-heavy --budget 1320 --claim &
    "$HEAVY" python3 tools/mutants.py --run --redo-survivors --no-heavy --budget 1320 --claim &
    wait
  done
  python3 tools/mutants.py --table > results/mutants.md
}
link() {
  export E15_MUT_BOUNDS=move,write0,write,moves
  "$HEAVY" sh -c "python3 -c \"import sys; sys.path.insert(0, 'tools'); import mutants; mutants.HEAVY = False; print(mutants.fixed_counts())\" && python3 tools/mutants.py --run --redo-survivors --no-heavy --only 131"
  python3 tools/mutants.py --table > results/mutants.md
  python3 tools/summary.py > results/summary.md
}
mutants_more() {
  # NOT run here (CPU budget; see the README's gaps): the mutants still
  # uncaught after pass 2, on deep and dedup (and `moves` would need
  # E15_MUT_BOUNDS to name it and fixed_counts() to learn its size)
  export E15_MUT_BOUNDS=move,write0,deep,dedup
  "$HEAVY" python3 -c "import sys; sys.path.insert(0, 'tools'); import mutants; mutants.HEAVY = False; print(mutants.fixed_counts())"
  until python3 tools/mutants.py --survivors-left | grep -qx 0; do
    "$HEAVY" python3 tools/mutants.py --run --redo-survivors --no-heavy --budget 1320
  done
  python3 tools/mutants.py --table > results/mutants.md
}

case "$1" in
  plan) plan ;;
  three) three ;;
  replay) replay ;;
  compare) compare ;;
  equiv) equiv ;;
  mutants) mutants ;;
  link) link ;;
  mutants_more) mutants_more ;;
  "") plan; three; replay; compare; equiv; mutants; link ;;
  *) echo "unknown: $1"; exit 1 ;;
esac
