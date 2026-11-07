#!/bin/sh
# E-17 part 1: the shared partitioning harness and the options fixN, re-key
# (rekey, rekey-carry) and slot moves. Plain Python 3 (3.13 here), standard
# library only. Each ablation runs in pieces of about 20 minutes under the
# study's heavy lock, so timing runs are never kept waiting long; a piece that
# runs out of time leaves a checkpoint, and the next piece carries on from it.
#
#   ./run.sh                      # everything below, then results/summary.md
#   ./run.sh slot                 # one option (its core, then +giveup if it has one)
#   FRESH=1 ./run.sh slot         # forget the checkpoint and start again (a re-run)
#   python3 harness/cli.py --option slot --bound grow --drop final.outs   # one run
#
# What runs (as in the README):
#   fixN          core ablation + mutants (it has no give-up path)
#   slot          core ablation + mutants; +giveup ablation + mutants;
#                 slot+abort: a give-up path with one decider (only B gives
#                 up, by abort; A never cancels), no mutants
#   rekey         core ablation + mutants; +giveup ablation, no mutants;
#                 rekey+giveup-alt: +giveup again, warm-started without the
#                 bulk-copy path (cut.ready, copy.append, copy.once), which
#                 the first +giveup run could not decide at the state limit;
#                 rekey-alt: a warm start keeping freeze.rkcom in place of
#                 freeze.cutcom and the cut-over entry (README, finding 5),
#                 with its own checkpoint (results/rekey-alt-checkpoint.json)
#
# The checkpoints (results/*-checkpoint.json) are caches for resuming; they
# are not results, and .gitignore keeps them out of the repo.
#   rekey-carry   warm start from rekey's result + mutants (its give-up
#                 path is rekey's); run it after rekey;
#                 rekey-carry-alt: warm start from rekey-alt's result + mutants;
#                 rekey-carry+giveup: warm start from rekey+giveup-alt, no mutants
#   orders        (./run.sh orders, after the rest) one more greedy order per
#                 option, no mutants: slot-rev and rekey-rev (greedy in
#                 reverse model-text order), rekey-carry-rev (warm start from
#                 rekey-rev). README finding 5.
set -e
cd "$(dirname "$0")"
SP=/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad
HEAVY=${HEAVY:-$SP/bin/heavy}
[ -x "$HEAVY" ] || HEAVY=
JOBS=${JOBS:-2}
OPTS=${*:-fixN slot rekey rekey-carry orders}

{ uname -srm; python3 --version; nproc; free -g | sed -n 2p; date -u; } > results/machine.txt

piece() {   # piece <option> [args]: run until done, one heavy hold per piece
  until $HEAVY python3 harness/cli.py --option "$@" --ablate --jobs "$JOBS" --budget 1200; do
    rc=$?
    [ "$rc" -eq 3 ] || exit "$rc"
  done
}

for o in $OPTS; do
  [ -n "$FRESH" ] && rm -f "results/$o-checkpoint.json" "results/$o-alt-checkpoint.json" "results/$o-rev-checkpoint.json" \
        "results/$o+giveup-alt-checkpoint.json" "results/$o+giveup-checkpoint.json" "results/$o+abort-checkpoint.json"
  case "$o" in
    orders)
      piece slot --reverse --tag slot-rev --seed-from slot --no-mutants
      piece rekey --reverse --tag rekey-rev --seed-from rekey --no-mutants
      piece rekey-carry --warm-from rekey-rev --tag rekey-carry-rev --seed-from rekey-carry --no-mutants
      continue ;;
    rekey-carry) piece "$o" --warm-from rekey ;;
    *) piece "$o" ;;
  esac
  case "$o" in
    slot) piece "$o" --giveup
          piece "$o" --pin abort.append --pin import.append --tag slot+abort --seed-from slot --no-mutants \
                --warm-from slot+giveup --warm-drop cancel.append --warm-drop cancel.nofence \
                --warm-drop fence.nocancel --warm-drop drop.cancom --warm-drop drop.append ;;
    rekey) piece "$o" --giveup --no-mutants
           piece "$o" --giveup --no-mutants --warm-from rekey+giveup --warm-drop cut.ready \
                 --warm-drop copy.append --warm-drop copy.once --tag rekey+giveup-alt --seed-from rekey
           piece "$o" --warm-from rekey --warm-keep freeze.rkcom --warm-drop freeze.cutcom \
                 --warm-drop cut.append --tag rekey-alt --seed-from rekey ;;
    rekey-carry) piece "$o" --warm-from rekey-alt --tag rekey-carry-alt --seed-from rekey-carry
                 piece "$o" --giveup --no-mutants --warm-from rekey+giveup-alt --tag rekey-carry+giveup \
                       --seed-from rekey-carry ;;
  esac
done
python3 harness/report.py > results/summary.md
echo "wrote results/summary.md"
