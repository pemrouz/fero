#!/bin/sh
# E-15: the slot move in TLA+ (tla/SlotMove.tla), cross-checked against
# docs/v5-spec/slot_move.py on the same 76 runs (26 variants, 7 bounds),
# then DEV-10's mechanical mutants of the fixed protocol
# (tla/SlotMoveFixed.tla).
#
#   ./run.sh            everything below, in order (about 8 CPU-hours here)
#   ./run.sh plan       both checkers on every run of slot_move.py's plan()
#   ./run.sh replay     replay each slot_move.py counterexample in TLC
#   ./run.sh compare    the comparison table (results/compare.md)
#   ./run.sh equiv      SlotMoveFixed against SlotMove's "fixed" variant
#   ./run.sh mutants    the mechanical mutants (results/mutants.md)
#
# Runs already done are skipped (delete results/<dir>/<run>.json to redo).
# Every step holds the study's heavy lock ($SP/bin/heavy) in pieces of at
# most about 25 minutes; TLC runs with one worker (two for `three`), so its
# shortest counterexamples are exact.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
export HEAVY="${HEAVY:-$SP/bin/heavy}"
cd "$HERE"
"$HERE/fetch.sh" > /dev/null

plan() { python3 tools/batch.py --loop --budget 1500; }
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
compare() { python3 tools/compare.py --json > results/compare.md; tail -1 results/compare.md; }
equiv() { "$HEAVY" python3 tools/mutants.py --equiv --no-heavy; }
mutants() {
  while [ "$(python3 tools/mutants.py --left)" != 0 ]; do
    "$HEAVY" python3 tools/mutants.py --run --no-heavy --budget 1500
  done
  python3 tools/mutants.py --table > results/mutants.md
}

case "$1" in
  plan) plan ;;
  replay) replay ;;
  compare) compare ;;
  equiv) equiv ;;
  mutants) mutants ;;
  "") plan; replay; compare; equiv; mutants ;;
  *) echo "unknown: $1"; exit 1 ;;
esac
