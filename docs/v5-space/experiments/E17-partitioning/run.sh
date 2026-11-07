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
#   slot          core ablation + mutants; +giveup ablation + mutants
#   rekey         core ablation + mutants; +giveup ablation, no mutants;
#                 rekey-alt: a warm start keeping freeze.rkcom in place of
#                 freeze.cutcom and the cut-over entry (README, finding 5)
#   rekey-carry   warm start from rekey's result + mutants (its give-up
#                 path is rekey's); run it after rekey
set -e
cd "$(dirname "$0")"
SP=/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad
HEAVY=${HEAVY:-$SP/bin/heavy}
[ -x "$HEAVY" ] || HEAVY=
JOBS=${JOBS:-2}
OPTS=${*:-fixN slot rekey rekey-carry}

{ uname -srm; python3 --version; nproc; free -g | sed -n 2p; date -u; } > results/machine.txt

piece() {   # piece <option> [args]: run until done, one heavy hold per piece
  until $HEAVY python3 harness/cli.py --option "$@" --ablate --jobs "$JOBS" --budget 1200; do
    rc=$?
    [ "$rc" -eq 3 ] || exit "$rc"
  done
}

for o in $OPTS; do
  [ -n "$FRESH" ] && rm -f "results/$o-checkpoint.json"
  case "$o" in
    rekey-carry) piece "$o" --warm-from rekey ;;
    *) piece "$o" ;;
  esac
  case "$o" in
    slot) piece "$o" --giveup ;;
    rekey) piece "$o" --giveup --no-mutants
           piece "$o" --warm-from rekey --warm-keep freeze.rkcom --warm-drop freeze.cutcom \
                 --warm-drop cut.append --tag rekey-alt ;;
  esac
done
python3 harness/report.py > results/summary.md
echo "wrote results/summary.md"
