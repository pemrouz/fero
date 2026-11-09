#!/bin/sh
# E-21: which time rule gives correct TTLs and safe leases under clock skew,
# clock jumps, GC pauses and leader changes? A seeded simulation of 3 or 5
# nodes (sim/timesim.py), each option's rules in E-17's rule language, and a
# DEV-10 ablation on the seeds (sim/ablate.py).
#
#   ./run.sh            everything
#   ./run.sh design     every option on every family x SEEDS seeds; per-check counts
#   ./run.sh ablate [OPTION ...]   pass 1, greedy, final pass, mutants (default: all)
#   ./run.sh report     results/summary.md
# Every run is under $SP/bin/heavy (2 worker processes), each hold under 25 minutes.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY-$SP/bin/heavy}"
SEEDS="${SEEDS:-30}"
ALL="wall clamp median hlc mono mono+ck tt"
cd "$HERE"
mkdir -p results
STEP="${1:-all}"; [ $# -gt 0 ] && shift
OPTS="${*:-$ALL}"
head() { echo "# $1, $(date -u +%FT%TZ), $(python3 --version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }

if [ "$STEP" = all ] || [ "$STEP" = design ]; then
  { head "E-21 design runs, $SEEDS seeds per family"
    $HEAVY timeout 1500 sh -c "for o in $ALL; do python3 sim/timesim.py \$o --seeds $SEEDS; done"
  } > results/design.jsonl 2>&1
fi
if [ "$STEP" = all ] || [ "$STEP" = ablate ]; then
  for o in $OPTS; do
    { head "E-21 ablation $o, $SEEDS seeds per family"
      $HEAVY timeout 1500 python3 sim/ablate.py "$o" --seeds "$SEEDS" --jobs 2 --out "results/$o-ablation.json"
    } > "results/$o-ablation.log" 2>&1 || echo "ablation $o stopped (see its log)"
  done
fi
if [ "$STEP" = all ] || [ "$STEP" = report ]; then
  python3 sim/report.py results/*-ablation.json > results/summary.md
fi
