#!/bin/sh
# E-20: which dedup option holds exactly once with the fewest rules, and does
# Y `fwd` need a rule that Y `smart` does not? One model, eight options
# (win, sess, pid, keys) x (smart, fwd), on E-16's engine (E-17's rule
# language), plus a Node memory probe.
#
#   ./run.sh            everything: design runs, ablations + mutants, summary, memory
#   ./run.sh check      only the design runs (every option on every bound)
#   ./run.sh ablate     DEV-10: the four smart options in full; each fwd option from its smart
#                       option's smallest model (delta.py)
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

ablate() {   # $1 option, $2 tag suffix, $3 model file
  o="$1"; out="results/$o$2-ablation.json"
  for piece in 1 2 3 4 5 6 7 8; do
    if "$HEAVY" timeout 1500 python3 "$CLI" "$3" "$o" --ablate "$out" >> "results/$o$2-ablation.log" 2>&1; then
      return 0
    fi
    echo "piece $piece of $o$2 stopped at 25 minutes; carrying on from the cache" >> "results/$o$2-ablation.log"
  done
}

delta() {   # $1 fwd option, $2 the smart option it starts from
  for piece in 1 2 3 4; do
    if "$HEAVY" timeout 1500 python3 delta.py "$1" "results/$2-ablation.json" "results/$1-ablation.json" \
        >> "results/$1-ablation.log" 2>&1; then return 0; fi
    echo "piece $piece of $1 stopped at 25 minutes; carrying on from the cache" >> "results/$1-ablation.log"
  done
}

if [ "$STEP" = all ] || [ "$STEP" = ablate ]; then
  # the four smart options in full (DEV-10), then each fwd option from its
  # smart option's smallest model (delta.py: what the relay adds)
  for o in win-smart sess-smart pid-smart keys-smart; do ablate "$o" "" models/dedup.py; done
  for d in win sess pid keys; do delta "$d-fwd" "$d-smart"; done
fi
if [ "$STEP" = all ] || [ "$STEP" = variants ]; then
  # every refusal appended: is a fwd hop rule still needed?
  delta sess-fwd-all sess-smart
  delta win-fwd-all win-smart
fi
if [ "$STEP" = rev ]; then
  for o in $OPTS; do ablate "$o" "-rev" models/dedup_rev.py; done
fi
if [ "$STEP" = all ] || [ "$STEP" = report ]; then
  python3 report.py results/*-ablation.json > results/summary.md
fi
if [ "$STEP" = all ] || [ "$STEP" = mem ]; then
  { head "E-20 memory probe"; node --version; for d in win sess sessslot pid keys; do for n in 10000 1000000; do
      node --expose-gc mem.mjs "$d" "$n"; done; done; } > results/memory.txt 2>&1
fi
