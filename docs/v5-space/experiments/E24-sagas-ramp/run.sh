#!/bin/sh
# E-24: sagas with fenced locks (P-15's MUST) and RAMP-Fast (its SHOULD).
# Two exhaustive models on E-16's engine (E-17's rule language, unchanged), and
# real Elle 0.2.8 on simulated histories.
#   ./run.sh check    every option of both models on every bound (traces of what breaks),
#                     and RAMP's gc-fol, which does not finish, once, on the chosen option
#   ./run.sh ablate   DEV-10: ablation and mutants of the chosen options (saga fullundo, ramp)
#   ./run.sh elle     elle/sim.py writes 6 x 100 histories; real Elle checks them;
#                     then 4 x 1,000 more histories for the direct count of fractured reads
#   ./run.sh report   results/summary.md from the ablation files
#   ./run.sh          all four, in order
# Every model and JVM step runs under $SP/bin/heavy, one hold per step, each under 25 minutes.
# An ablation resumes from its .cache file, so it runs as several holds until it ends.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY-$SP/bin/heavy}"
CLI="$HERE/../E16-controller-loop/engine/cli.py"
REPORT="$HERE/../E16-controller-loop/engine/report.py"
W="$SP/e24"; R="$HERE/results"
JARS="$SP/dl/elle-mvn/jars/*"
STEPS="${*:-check ablate elle report}"
mkdir -p "$W" "$R"
cd "$HERE"
want() { for s in $STEPS; do [ "$s" = "$1" ] && return 0; done; return 1; }
hdr() { echo "# $1, $(date -u +%FT%TZ), $(python3 --version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }
# ablate MODEL OPTION OUT: hold after hold (each <= 25 min) until OUT is written
ablate() {
  n=0
  until [ -f "$3" ]; do
    n=$((n + 1)); [ $n -le 10 ] || { echo "ablation $2 did not end in 10 holds" >&2; exit 1; }
    $HEAVY timeout 1500 python3 $CLI "$1" "$2" --ablate "$3" --limit 3000000 || true
  done
}

if want check; then
  hdr 'saga: every option on every bound' > $R/design-saga.txt
  $HEAVY timeout 1500 sh -c "for o in draft owned bump fullundo raise; do python3 $CLI models/saga.py \$o --limit 3000000; done" >> $R/design-saga.txt 2>&1
  hdr 'ramp: every option on every bound' > $R/design-ramp.txt
  $HEAVY timeout 1500 sh -c "for o in ramp noserve; do python3 $CLI models/ramp.py \$o --limit 3000000; done" >> $R/design-ramp.txt 2>&1
  hdr 'ramp: gc-fol, which does not finish, on the chosen option (a partial check)' >> $R/design-ramp.txt
  $HEAVY timeout 1500 python3 $CLI models/ramp.py ramp --bound gc-fol --limit 3000000 >> $R/design-ramp.txt 2>&1
fi
if want ablate; then
  ablate models/saga.py fullundo $R/saga-fullundo-ablation.json
  ablate models/ramp.py ramp $R/ramp-ablation.json
fi
if want elle; then
  rm -rf "$W/hist" "$W/hist1k"; mkdir -p "$W/hist" "$W/hist1k" "$W/classes"
  for m in plain ramp rampv; do for f in 0 0.15; do python3 elle/sim.py "$W/hist" $m 100 $f; done; done > $R/elle-sim.txt
  $HEAVY timeout 1500 java -Djava.awt.headless=true -Dclojure.compile.path="$W/classes" -Xmx3g \
    -XX:ActiveProcessorCount=2 -cp "$HERE/elle:$JARS" clojure.main elle/check.clj "$W/elle.jsonl" "$W"/hist/*.edn
  python3 elle/summarize.py "$W/elle.jsonl" > $R/elle.md
  cp "$W/hist/plain-f00-000.edn" "$W/hist/ramp-f00-000.edn" "$W/hist/ramp-f00-069.edn" "$W/hist/rampv-f00-069.edn" $R/
  for m in ramp rampv; do for f in 0 0.15; do python3 elle/sim.py "$W/hist1k" $m 1000 $f; done; done > $R/elle-sim-1k.txt
  python3 elle/fractured.py "$W/hist1k" > $R/fractured-1k.txt
fi
if want report; then
  python3 $REPORT $R/saga-fullundo-ablation.json $R/ramp-ablation.json > $R/summary.md
fi
