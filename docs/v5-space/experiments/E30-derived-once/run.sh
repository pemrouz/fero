#!/bin/sh
# E-30: do consumer groups and derived resources stay exactly once when the
# outputs and the cursor sit in different groups, across a restart shorter
# or longer than the dedup horizon? One model (six options) on E-16's engine
# with E-17's rule language, extending E-20's world; then real Elle on the
# outputs.
#
#   ./run.sh            everything
#   ./run.sh check      the design runs (every option on every bound, every property broken listed)
#   ./run.sh ablate     DEV-10 ablation + mutants of the options that hold (srchi-slot, srcpos)
#   ./run.sh elle       random walks of the model as list-append histories, checked by real Elle
#   ./run.sh report     results/summary.md
# Every model and JVM run is under $SP/bin/heavy, each hold under 25 minutes.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY-$SP/bin/heavy}"
CLI="$HERE/../E16-controller-loop/engine/cli.py"
JARS="$SP/dl/elle-mvn/jars/*"
H="$SP/e30h"
cd "$HERE"
mkdir -p results
STEP="${1:-all}"
head() { echo "# $1, $(date -u +%FT%TZ), $(python3 --version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }

if [ "$STEP" = all ] || [ "$STEP" = check ]; then
  { head "E-30 design runs"
    $HEAVY timeout 1500 sh -c "for o in srchi-slot srcpos srchi srcpos-nok; do python3 '$CLI' models/derived.py \$o --all-fails --limit 1500000; done"
    # the options that fail: every property they break, each run to the state limit
    $HEAVY timeout 1500 sh -c "for o in win sess; do python3 '$CLI' models/derived.py \$o --all-fails --limit 1500000; done"
    $HEAVY timeout 1500 sh -c "for o in pid keys; do python3 '$CLI' models/derived.py \$o --all-fails --limit 1500000; done"
  } > results/design.txt 2>&1 || true
fi
if [ "$STEP" = all ] || [ "$STEP" = ablate ]; then
  # E-20's ablate20.py: E-17's procedure on the rules that are not pinned
  for o in srchi-slot srcpos; do
    for piece in 1 2 3 4; do
      [ -f "results/$o-ablation.json" ] && break
      $HEAVY timeout 1500 python3 ../E20-dedup/ablate20.py "$o" "results/$o-ablation.json" --model models/derived.py \
        >> "results/$o-ablation.log" 2>&1 && break
      echo "piece $piece stopped at 25 minutes; carrying on from the cache" >> "results/$o-ablation.log"
    done
  done
fi
if [ "$STEP" = all ] || [ "$STEP" = elle ]; then
  rm -rf "$H"; mkdir -p "$H/classes"
  $HEAVY timeout 1500 python3 elle_hist.py "$H" --walks 200
  # dom-top (an Elle dependency) writes classes at run time: keep them out of the repo
  ( cd "$H" && $HEAVY timeout 1500 java -Djava.awt.headless=true -Dclojure.compile.path="$H/classes" -Xmx3g \
      -XX:ActiveProcessorCount=2 -cp "$HERE/clj:$JARS" clojure.main "$HERE/clj/elle_e30.clj" "$H/elle.jsonl" "$H"/*.edn )
  { python3 elle_report.py "$H/index.jsonl" "$H/elle.jsonl"; echo; head "run"; java -version 2>&1 | head -1; } > results/elle.md
  cp "$H/index.jsonl" results/elle-index.jsonl
  cp "$H/elle.jsonl" results/elle-verdicts.jsonl
fi
if [ "$STEP" = all ] || [ "$STEP" = report ]; then
  python3 ../E20-dedup/report.py results/srchi-slot-ablation.json results/srcpos-ablation.json > results/summary.md
fi
