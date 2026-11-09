#!/bin/sh
# E-20: which dedup option holds exactly once with the fewest rules, and does
# Y `fwd` need a rule that Y `smart` does not? One model, eight options
# (win, sess, pid, keys) x (smart, fwd), on E-16's engine (E-17's rule
# language), plus a Node memory probe.
#
#   ./run.sh            everything: design runs, ablations + mutants, summary, memory
#   ./run.sh check      only the design runs (every option on every bound)
#   ./run.sh ablate     DEV-10 (ablate20.py): the four smart options in full (sess-smart at a
#                       2.5 million state limit, then resolve20.py); win, pid and keys under fwd
#                       from their smart option's smallest model (what the relay adds); sess
#                       under fwd by dropping its one relay rule on the full designs
#   ./run.sh variants   the append-every-refusal variant win-fwd-all (sess-fwd-all is in ablate)
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
  # the four smart options in full (DEV-10). sess-smart's smallest model needs
  # 2,298,773 states on bound `lost`, so it runs with a 2.5 million limit;
  # resolve20.py then settles any mutant that still stopped at a limit by
  # trying the small bounds first (a no-op when none did)
  ablate win-smart; ablate sess-smart --limit 2500000; ablate pid-smart; ablate keys-smart
  "$HEAVY" timeout 1500 python3 resolve20.py results/sess-smart-ablation.json --small-only swap >> results/sess-smart-ablation.log 2>&1
  # win, pid and keys under fwd: from the smart option's smallest model (what the relay adds)
  for d in win pid keys; do ablate "$d-fwd" --from "results/$d-smart-ablation.json"; done
  # sess under fwd: from sess-smart's smallest model, `lost` would need well
  # over 2.5 million states; the relay's one rule (forward.once; sess has no
  # budgets) is dropped alone on the full sess-fwd and sess-fwd-all designs
  { echo "# E-20 relay rule under sess: forward.once dropped alone on the full designs, $(date -u +%FT%TZ), load $(cut -d' ' -f1-3 /proc/loadavg)"
    "$HEAVY" timeout 1500 sh -c "for o in sess-fwd sess-fwd-all; do python3 '$CLI' models/dedup.py \$o --drop forward.once; done"
  } > results/sess-fwd-relay.txt 2>&1
fi
if [ "$STEP" = all ] || [ "$STEP" = variants ]; then
  # every refusal appended: is a fwd hop rule still needed? (sess: see sess-fwd-relay.txt)
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
