#!/bin/sh
# E-16: one controller loop on #meta's leader (cent-co) against healing by
# every group's leader (self), on one world, with DEV-10's counting.
#
#   ./run.sh            everything below (about 2 CPU-hours on a quiet box;
#                       every piece holds the study's heavy lock for at most
#                       25 minutes, and the ablation resumes from its cache)
#   ./run.sh check      only the design runs (minutes)
#
# Needs: python3 (standard library). Reads E-17's harness/dsl.py unchanged.
# Writes results/. PYTHONHASHSEED is pinned by engine/cli.py.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY:-$SP/bin/heavy}"
cd "$HERE"
mkdir -p results

# 1. The designs on every bound, with traces and the WAIT counts.
for o in self cent-co; do
  "$HEAVY" timeout 1500 python3 engine/cli.py models/heal.py "$o" > "results/design-$o.txt" 2>&1 || true
done
"$HEAVY" timeout 600 python3 engine/cli.py models/rlog.py rlog > results/design-rlog.txt 2>&1 || true
[ "$1" = check ] && exit 0

# 2. The ablation and the mutants (DEV-10), resumable: each piece runs at
#    most 25 minutes under the heavy lock; the cache keeps finished runs.
ablate() {  # model option out
  n=0
  while [ ! -s "$3" ] && [ $n -lt 12 ]; do
    "$HEAVY" timeout 1500 python3 engine/cli.py "$1" "$2" --ablate "$3" --limit 900000 >> "${3%.json}.log" 2>&1 || true
    n=$((n + 1))
  done
}
ablate models/heal.py self results/self-ablation.json
ablate models/heal.py cent-co results/cent-co-ablation.json
ablate models/rlog.py rlog results/rlog-ablation.json
python3 engine/report.py results/self-ablation.json results/cent-co-ablation.json results/rlog-ablation.json > results/summary.md
