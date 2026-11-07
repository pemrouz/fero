#!/bin/sh
# E-33: genesis founds exactly one cluster per project; a restore keeps
# positions, tokens, cursors and retries honest. Three models on E-16's
# engine (E-17's rule language):
#   models/genesis.py   founding across boxes from `seeds` (four options)
#   models/onebox.py    founding on one box, and the stale-folder rule
#   models/restore.py   a restore to a past position (two options)
#
#   ./run.sh            everything (minutes; each piece under the heavy lock)
#   ./run.sh check      only the design runs
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY:-$SP/bin/heavy}"
CLI="$HERE/../E16-controller-loop/engine/cli.py"
cd "$HERE"
mkdir -p results
"$HEAVY" timeout 1500 sh -c "
  for o in draft unanimous init objcas; do python3 $CLI models/genesis.py \$o --all-fails --bound any1 --bound any2 --bound any3 --bound onebox1; done > results/design-genesis.txt 2>&1
  python3 $CLI models/onebox.py draft --all-fails > results/design-onebox.txt 2>&1
  for o in design naive; do python3 $CLI models/restore.py \$o --all-fails; done > results/design-restore.txt 2>&1
"
[ "$1" = check ] && exit 0
# DEV-10: ablation and mutants of every option whose design holds.
"$HEAVY" timeout 1500 sh -c "
  for o in objcas init unanimous; do python3 $CLI models/genesis.py \$o --ablate results/genesis-\$o-ablation.json --limit 400000; done
  python3 $CLI models/onebox.py draft --ablate results/onebox-ablation.json --limit 400000
  python3 $CLI models/restore.py design --ablate results/restore-ablation.json --limit 400000
"
python3 ../E16-controller-loop/engine/report.py results/genesis-objcas-ablation.json results/genesis-init-ablation.json \
  results/genesis-unanimous-ablation.json results/onebox-ablation.json results/restore-ablation.json > results/summary.md
