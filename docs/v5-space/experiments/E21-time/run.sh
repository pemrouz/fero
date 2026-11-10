#!/bin/sh
# E-21: which time rule gives correct TTLs and safe leases under clock skew,
# clock jumps, GC pauses and leader changes? A seeded simulation of 3 or 5
# nodes (sim/timesim.py), each option's rules in E-17's rule language, and a
# DEV-10 ablation on the seeds (sim/ablate.py).
#
#   ./run.sh            everything
#   ./run.sh design     every option on every family x SEEDS seeds; per-check counts
#   ./run.sh ablate [OPTION ...]   pass 1, greedy, final pass, mutants (default: all)
#   ./run.sh verify     the verify family `handover` (planned handovers): each smallest model on it,
#                       the rule put back, every mutant of the final models on eight families
#   ./run.sh nine       the same ablation on nine families (the seven, jump2, handover) for the options
#                       that hold on all nine: median+g, hlc, tt
#   ./run.sh report     results/summary.md (seven families) and results/summary9.md (nine)
# Every run is under $SP/bin/heavy (2 worker processes), each hold under 25 minutes.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY-$SP/bin/heavy}"
SEEDS="${SEEDS:-30}"
ALL="wall clamp median median1 hlc mono mono+ck tt"
NINE="median+g hlc tt"     # hold as designed on all nine families
cd "$HERE"
mkdir -p results
STEP="${1:-all}"; [ $# -gt 0 ] && shift
OPTS="${*:-$ALL}"
head() { echo "# $1, $(date -u +%FT%TZ), $(python3 --version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }

if [ "$STEP" = all ] || [ "$STEP" = design ]; then
  { head "E-21 design runs, $SEEDS seeds per family"
    $HEAVY timeout 1500 sh -c "for o in $ALL median+g; do python3 sim/timesim.py \$o --seeds $SEEDS --extra; done"
  } > results/design.jsonl 2>&1
fi
if [ "$STEP" = all ] || [ "$STEP" = ablate ]; then
  for o in $OPTS; do
    { head "E-21 ablation $o, $SEEDS seeds per family"
      $HEAVY timeout 1500 python3 sim/ablate.py "$o" --seeds "$SEEDS" --jobs 2 --out "results/$o-ablation.json"
    } > "results/$o-ablation.log" 2>&1 || echo "ablation $o stopped (see its log)"
  done
fi
if [ "$STEP" = all ] || [ "$STEP" = verify ]; then
  # reads results/<option>-ablation.json; writes results/handover.json and handover.md (about 6 minutes)
  { head "E-21 verify family handover, $SEEDS seeds"
    $HEAVY timeout 1500 python3 sim/verify.py --seeds "$SEEDS" --jobs 2 --out results/handover.json
  } > results/handover.log 2>&1
fi
if [ "$STEP" = all ] || [ "$STEP" = nine ]; then
  for o in $NINE; do
    { head "E-21 ablation $o on nine families (the seven, jump2, handover), $SEEDS seeds per family"
      $HEAVY timeout 1500 python3 sim/ablate.py "$o" --seeds "$SEEDS" --jobs 2 --nine --out "results/$o-ablation9.json"
    } > "results/$o-ablation9.log" 2>&1 || echo "ablation $o (nine) stopped (see its log)"
  done
fi
if [ "$STEP" = all ] || [ "$STEP" = report ]; then
  python3 sim/report.py results/*-ablation.json > results/summary.md
  python3 sim/report.py results/*-ablation9.json > results/summary9.md
fi
