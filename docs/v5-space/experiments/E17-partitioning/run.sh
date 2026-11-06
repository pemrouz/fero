#!/bin/sh
# E-17 part 1: the shared partitioning harness and the options fixN, re-key
# (rekey, rekey-carry) and slot moves. Plain Python 3 (3.13 here), standard
# library only. Each option's ablation and mutants run in pieces of about 20
# minutes under the study's heavy lock, so timing runs are never kept waiting
# long; a piece that runs out of time leaves a checkpoint and the next piece
# carries on from it.
#
#   ./run.sh                      # every option, then the summary
#   ./run.sh slot                 # one option
#   FRESH=1 ./run.sh slot         # forget the checkpoint and start again
#   python3 harness/cli.py --option slot --bound grow --drop final.outs   # one run
set -e
cd "$(dirname "$0")"
SP=/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad
HEAVY=${HEAVY:-$SP/bin/heavy}
[ -x "$HEAVY" ] || HEAVY=
JOBS=${JOBS:-2}
OPTS=${*:-fixN slot rekey rekey-carry}

{ uname -srm; python3 --version; nproc; free -g | sed -n 2p; date -u; } > results/machine.txt

for o in $OPTS; do
  [ -n "$FRESH" ] && rm -f "results/$o-checkpoint.json"
  # the core (the give-up path may be dropped), then with the give-up path
  # pinned (options without one skip it); both share one checkpoint
  for g in "" --giveup; do
    until $HEAVY python3 harness/cli.py --option "$o" --ablate $g --jobs "$JOBS" --budget 1200; do
      rc=$?
      [ "$rc" -eq 3 ] || exit "$rc"
    done
  done
done
python3 harness/report.py > results/summary.md
echo "wrote results/summary.md"
