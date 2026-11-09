#!/bin/sh
# E-20: which dedup option holds exactly once with the fewest rules, and does
# Y `fwd` need a rule that Y `smart` does not? One model, eight options
# (win, sess, pid, keys) x (smart, fwd), on E-16's engine (E-17's rule
# language), plus a Node memory probe.
#
#   ./run.sh            everything: design runs, ablations + mutants, summary, memory
#   ./run.sh check      only the design runs (every option on every bound)
#   ./run.sh ablate     DEV-10 (ablate20.py): the four smart options in full; each fwd option
#                       from its smart option's smallest model (what the relay adds)
#   ./run.sh variants   the two append-every-refusal variants (sess-fwd-all, win-fwd-all)
#   ./run.sh rev [OPTION ...]       the same, greedy drops in reverse model-text order
#   ./run.sh report     results/summary.md from the ablation files
#   ./run.sh mem        Node memory per dedup entry at 1e4 and 1e6 clients
#
# Every model run is under $SP/bin/heavy, in pieces of at most 25 minutes;
# an ablation keeps its work in results/<option>-ablation.json.cache, so the
# next piece carries on where the last stopped.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY:-$SP/bin/heavy}"
CLI="$HERE/../E16-controller-loop/engine/cli.py"
ALL="win-smart win-fwd sess-smart sess-fwd pid-smart pid-fwd keys-smart keys-fwd"
cd "$HERE"
mkdir -p results
STEP="${1:-all}"; [ $# -gt 0 ] && shift
OPTS="${*:-win-smart sess-smart pid-smart keys-smart}"
head() { echo "# $1, $(date -u +%FT%TZ), $(python3 --version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }

if [ "$STEP" = all ] || [ "$STEP" = check ]; then
  { head "E-20 design runs"
    "$HEAVY" timeout 1500 sh -c "for o in $ALL sess-fwd-all win-fwd-all; do python3 '$CLI' models/dedup.py \$o; done"
  } > results/design.txt 2>&1 || true
fi

ablate() {   # $1 option, then ablate20.py's flags (pieces of 25 minutes, resumed from the cache)
  o="$1"; shift
  for piece in 1 2 3 4 5 6; do
    [ -f "results/$o-ablation.json" ] && return 0
    "$HEAVY" timeout 1500 python3 ablate20.py "$o" "results/$o-ablation.json" "$@" >> "results/$o-ablation.log" 2>&1 && return 0
    echo "piece $piece of $o stopped at 25 minutes; carrying on from the cache" >> "results/$o-ablation.log"
  done
}

if [ "$STEP" = all ] || [ "$STEP" = ablate ]; then
  # the four smart options in full (DEV-10); each fwd option from its smart
  # option's smallest model (what the relay adds)
  for o in win-smart sess-smart pid-smart keys-smart; do ablate "$o"; done
  for d in win sess pid keys; do ablate "$d-fwd" --from "results/$d-smart-ablation.json"; done
fi
if [ "$STEP" = all ] || [ "$STEP" = variants ]; then
  # every refusal appended: is a fwd hop rule still needed?
  ablate sess-fwd-all --from results/sess-smart-ablation.json
  ablate win-fwd-all --from results/win-smart-ablation.json
fi
if [ "$STEP" = rev ]; then
  # the same with the greedy drops in reverse model-text order (a second order)
  for o in $OPTS; do
    "$HEAVY" timeout 1500 python3 ablate20.py "$o" "results/$o-rev-ablation.json" --model models/dedup_rev.py \
      >> "results/$o-rev-ablation.log" 2>&1 || true
  done
fi
if [ "$STEP" = all ] || [ "$STEP" = report ]; then
  python3 report.py results/*-ablation.json > results/summary.md
fi
if [ "$STEP" = all ] || [ "$STEP" = mem ]; then
  { head "E-20 memory probe"; node --version; for d in win sess sessslot pid keys; do for n in 10000 1000000; do
      node --expose-gc mem.mjs "$d" "$n"; done; done; } > results/memory.txt 2>&1
fi
