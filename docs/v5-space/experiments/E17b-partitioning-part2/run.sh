#!/bin/sh
# E-17 part 2: the options pslot, split + merge and lanes + range moves, on
# E-17's shared harness (../E17-partitioning, unchanged). Plain Python 3
# (3.13 here), standard library only. Each ablation runs in pieces of about
# 20 minutes under the study's heavy lock; a piece that runs out of time
# leaves a checkpoint (../E17-partitioning/results/<name>-checkpoint.json,
# a cache, kept out of git), and the next piece carries on from it.
#
#   ./run.sh                     # everything below, then results/summary.md and results/extra.txt
#   ./run.sh split               # one option: its core, its other order, its give-up price
#   FRESH=1 ./run.sh split       # forget the checkpoints and start again (a re-run)
#   python3 ../E17-partitioning/harness/cli.py --option split --bound grow --drop init.outs   # one run
#   python3 extra.py --option split --minimal split --bound readback                     # a bigger bound
#
# What runs, per option (as in README.md):
#   <o>           core ablation + mutants
#   <o>-rev       the greedy drops in reverse model-text order, no mutants
#   pslot+abort, lanes+abort   the give-up path with one decider (only B
#                 gives up, by abort; A never cancels): abort.append and
#                 import.append pinned, no mutants. Warm start (as part 1's
#                 slot+abort): the core's dropped rules less the give-up rules
#                 slot+abort needed (and, for lanes, less fence.once); refused,
#                 and so run in full, if any bound then fails
#   split+giveup, pslot-fused+abort   the give-up path, run in full (no warm start)
#   pslot+giveup  (only as ./run.sh pslot+giveup; NOT run for the reported
#                 results) the drafted two-decider give-up (cancel, abort,
#                 import pinned), as slot+giveup in part 1; warm start from
#                 pslot+abort
#   split+giveup  a merge given up by B (mabort.append pinned), no mutants
#   lanes-carry   the copy also carries records with their positions (no
#                 lineage); warm start from lanes, with mutants
#   fused         (a probe of the move's shape) pslot-fused: pslot with the
#                 move's entries fused the way a split fuses them (the fence
#                 is the decision; the final copy opens B); core + mutants,
#                 its other order, and its one-decider give-up price
#   extra         every smallest set on three bounds outside the shared sweep
#                 (extra.py), and which dropped rule each failure needs back
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
H=$HERE/../E17-partitioning
cd "$H"
SP=/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad
HEAVY=${HEAVY:-$SP/bin/heavy}
[ -x "$HEAVY" ] || HEAVY=
JOBS=${JOBS:-2}
OPTS=${*:-pslot split lanes fused extra}

{ uname -srm; python3 --version; nproc; free -g | sed -n 2p; date -u; } >> "$HERE/results/machine.txt"

piece() {   # piece <option> [args]: run until done, one heavy hold per piece
  until $HEAVY python3 harness/cli.py --option "$@" --ablate --jobs "$JOBS" --budget 1200; do
    rc=$?
    [ "$rc" -eq 3 ] || exit "$rc"
  done
}

# The harness applies --warm-keep only when some --warm-drop is given (cli.py),
# so each warm start below also names one rule its source already dropped
# (export.nofence, dropped by every core set here); that changes nothing else.
GU="--warm-keep open.noabort --warm-keep abort.imp --warm-keep abort.noopen --warm-keep unfence.abcom \
    --warm-keep unfence.fen --warm-keep unfence.append --warm-keep abort.res --warm-keep unfence.res \
    --warm-drop export.nofence"

for o in $OPTS; do
  if [ -n "$FRESH" ]; then
    for t in "$o" "$o-rev" "$o+abort" "$o-carry"; do rm -f "results/$t-checkpoint.json"; done
    if [ "$o" = fused ]; then
      rm -f results/pslot-fused-checkpoint.json results/pslot-fused-rev-checkpoint.json \
            results/pslot-fused+abort-checkpoint.json
    fi
  fi
  case "$o" in
    pslot)
      piece pslot
      piece pslot --reverse --tag pslot-rev --seed-from pslot --no-mutants
      piece pslot --pin abort.append --pin import.append --tag pslot+abort --seed-from pslot --no-mutants \
            --warm-from pslot $GU ;;
    pslot+giveup)
      piece pslot --giveup --tag pslot+giveup --seed-from pslot --no-mutants --warm-from pslot+abort \
            --warm-keep drop.cancom --warm-keep drop.append --warm-keep cancel.nofence --warm-keep fence.nocancel \
            --warm-keep drop.res --warm-keep cancel.res --warm-drop export.nofence ;;
    split)
      piece split
      piece split --reverse --tag split-rev --seed-from split --no-mutants
      piece split --giveup --seed-from split --no-mutants ;;
    lanes)
      piece lanes
      piece lanes --reverse --tag lanes-rev --seed-from lanes --no-mutants
      piece lanes-carry --warm-from lanes
      piece lanes --pin abort.append --pin import.append --tag lanes+abort --seed-from lanes --no-mutants \
            --warm-from lanes $GU --warm-keep fence.once ;;
    giveups)    # the one-decider give-up prices alone (also run by pslot and lanes above)
      piece pslot --pin abort.append --pin import.append --tag pslot+abort --seed-from pslot --no-mutants \
            --warm-from pslot $GU
      piece lanes --pin abort.append --pin import.append --tag lanes+abort --seed-from lanes --no-mutants \
            --warm-from lanes $GU --warm-keep fence.once ;;
    fused)
      piece pslot-fused
      piece pslot-fused --reverse --tag pslot-fused-rev --seed-from pslot-fused --no-mutants
      piece pslot-fused --pin abort.append --tag pslot-fused+abort --seed-from pslot-fused --no-mutants ;;
    extra)
      "$HERE/extra.sh" > "$HERE/results/extra.txt" ;;
  esac
done
python3 "$HERE/report2.py" > "$HERE/results/summary.md"
echo "wrote results/summary.md"
