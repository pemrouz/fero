#!/bin/sh
# E-22b: E-22's saved histories re-checked with real Elle 0.2.8 and Knossos 0.3.16.
#   ./run.sh build    copy E-22's Go checker (unchanged, cmp-checked), add go/e22b.go, go build
#   ./run.sh self     the 26 self-test cases: 8 with real Elle, 18 with Knossos (E-22's model, ported)
#   ./run.sh elle     real Elle on all 1,200 saga histories at read committed and serializable; then the
#                     same with the Go port's rule for never-read appends (the root-cause ablation);
#                     then real Elle's own explanation of one history the two disagree on
#   ./run.sh pilot    Porcupine and Knossos on all 1,800 register (lin-kv) partitions; its time per op
#                     sized the rest
#   ./run.sh bad      both on the known-bad histories: E-22's 7 mutant runs and lin-kv from before fix G1
#   ./run.sh por      Porcupine per partition on every other history file
#   ./run.sh small    jobs: every partition of 120 ops or fewer in every other file, cut in 3 chunks
#                     (chunks 2 and 3 shuffled, so a cut at 25 min leaves a random sample)
#   ./run.sh small1 | small2 | small3    Knossos on one chunk (each one heavy hold, cut at 25 min)
#   ./run.sh big      Knossos on KBIG partitions per file drawn from the 600 with more than 120 ops
#                     (p09, p22), LIMITBIG ms each, the hold cut at 25 min
#   ./run.sh report   results/knossos-small.md from the three chunks, and results/knossos-summary.md
#   ./run.sh          all of the above, in that order. Several steps may be named: ./run.sh build self
# Every JVM and Go step runs under $SP/bin/heavy, one hold per step, each under 30 minutes.
# Inputs: E-22's histories in $SP/e22v (edn/, hist/, lin-kv-calm-before.jsonl, elle-raw.jsonl), its Go
# build in $SP/e22v/go-build, and the jars fetch.sh lists. Raw outputs in $SP/e22b, trimmed in results/.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
E22="$HERE/../E22-api-prototype/verify"
V="$SP/e22v"; W="$SP/e22b"; B="$W/go-build"; R="$HERE/results"
JARS="$SP/dl/elle-mvn/jars/*"
# HEAVY wraps each JVM and Go step. To run several steps under one hold, run the script under the
# helper with HEAVY= (empty); never nest the helper (an inner wait on the gate behind a waiting
# timing run would deadlock).
HEAVY="${HEAVY-$SP/bin/heavy}"
JAVA="java -Djava.awt.headless=true -Xmx3g -XX:ActiveProcessorCount=2 -cp $HERE/clj:$JARS"
LIMIT="${LIMIT:-60000}"; KBIG="${KBIG:-5}"; LIMITBIG="${LIMITBIG:-120000}"
STEPS="${*:-all}"
mkdir -p "$W" "$R"
want() { for s in $STEPS; do [ "$s" = all ] || [ "$s" = "$1" ] && return 0; done; return 1; }
head() { echo "# $1, $(date -u +%FT%TZ), $(java -version 2>&1 | grep -m1 version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }
KN="clojure.main $HERE/clj/knossos_check.clj"

LINKV="$V/hist/lin-kv-calm.jsonl $V/hist/lin-kv-faults.jsonl $V/hist/lin-kv-shuffle.jsonl"
BAD="$V/lin-kv-calm-before.jsonl $V/hist/mut-nodedup-lin-kv.jsonl $V/hist/mut-lostcommit-lin-kv.jsonl \
 $V/hist/mut-nodedup-core-exactly-once.jsonl $V/hist/mut-nodedup-p11.jsonl $V/hist/mut-lostcommit-p11.jsonl \
 $V/hist/mut-nodedup-p14.jsonl $V/hist/mut-lostcommit-p14.jsonl"
OTHER=$(ls "$V"/hist/*.jsonl | grep -v -e /lin-kv- -e /mut-)
colons() { echo $* | tr ' ' ':'; }
POR="$W/por-pilot.jsonl=$(colons $LINKV),$W/por-bad.jsonl=$(colons $BAD),$W/por-other.jsonl=$(colons $OTHER)"

if want build; then
  rm -rf "$B"; mkdir -p "$B"
  for f in main.go model.go selftest.go; do cmp "$E22/go/$f" "$V/go-build/$f"; done   # E-22's build is its committed code
  cp "$V/go-build/go.mod" "$V/go-build/go.sum" "$V/go-build/main.go" "$V/go-build/model.go" "$V/go-build/selftest.go" "$B/"
  cp -r "$V/go-build/tipocket-elle" "$B/"
  cp "$HERE/go/e22b.go" "$B/"
  ( cd "$B" && GOTOOLCHAIN=local GOFLAGS=-mod=mod $HEAVY go build -o e22b . ) && echo "built $B/e22b ($(go version))"
fi

if want self; then
  "$B/e22b" dumpself "$W/selftest.json"
  rm -rf "$W/self-edn"; python3 -I "$HERE/prep.py" elleself "$W/selftest.json" "$W/self-edn"
  python3 -I "$HERE/prep.py" self "$W/selftest.json" "$W/jobs-self.jsonl"
  $HEAVY sh -c "$JAVA clojure.main $HERE/clj/elle_check.clj $W/elle-self.jsonl $W/self-edn/*.edn && \
    $JAVA $KN $W/jobs-self.jsonl $W/knossos-self.jsonl 10000"
  { head "self-test: real Elle 0.2.8 and Knossos 0.3.16"
    python3 -I "$HERE/compare.py" elleself "$W/selftest.json" "$W/elle-self.jsonl"; echo
    python3 -I "$HERE/compare.py" knself "$W/selftest.json" "$W/knossos-self.jsonl"; } | tee "$R/selftest.md"
fi

if want elle; then
  { head "real Elle 0.2.8 list-append on E-22's 1,200 EDN histories"
    $HEAVY sh -c "$JAVA clojure.main $HERE/clj/elle_check.clj $W/elle-real.jsonl $V/edn/*.edn"
    python3 -I "$HERE/compare.py" elle "$V/elle-raw.jsonl" "$W/elle-real.jsonl"; } 2>&1 | grep -v JAVA_TOOL > "$R/elle.md"
  { head "ablation: real Elle 0.2.8 with the Go port's rule for never-read appends (E22B_RULE=port)"
    $HEAVY sh -c "E22B_RULE=port $JAVA clojure.main $HERE/clj/elle_check.clj $W/elle-portrule.jsonl $V/edn/*.edn"
    python3 -I "$HERE/compare.py" elle "$V/elle-raw.jsonl" "$W/elle-portrule.jsonl"; } 2>&1 | grep -v JAVA_TOOL > "$R/elle-portrule.md"
  python3 -I "$HERE/compare.py" elletsv "$V/elle-raw.jsonl" "$W/elle-real.jsonl" "$W/elle-portrule.jsonl" > "$R/elle-verdicts.tsv"
  { head "real Elle 0.2.8's explanation of undo-calm-seed14 at read committed (the port finds it valid)"
    cat "$V/edn/undo-calm-seed14.edn"; echo
    $HEAVY sh -c "$JAVA clojure.main $HERE/clj/elle_explain.clj read-committed $V/edn/undo-calm-seed14.edn"; } 2>&1 | grep -v JAVA_TOOL > "$R/elle-explain-undo-calm-seed14.txt"
  sed -n '1,25p' "$R/elle.md"; sed -n '1,25p' "$R/elle-portrule.md"
fi

if want pilot; then
  : > "$W/jobs-pilot.jsonl"; python3 -I "$HERE/prep.py" all "$W/jobs-pilot.jsonl" $LINKV
  { head "pilot: Knossos (competition) on every lin-kv partition, time limit $LIMIT ms"
    $HEAVY sh -c "$B/e22b parts $W/por-pilot.jsonl $LINKV && $JAVA $KN $W/jobs-pilot.jsonl $W/knossos-pilot.jsonl $LIMIT"
    python3 -I "$HERE/compare.py" knossos "$POR" "$W/knossos-pilot.jsonl=$W/jobs-pilot.jsonl"; } 2>&1 | grep -v JAVA_TOOL > "$R/knossos-linkv.md"
fi

if want bad; then
  : > "$W/jobs-bad.jsonl"; python3 -I "$HERE/prep.py" all "$W/jobs-bad.jsonl" $BAD
  { head "Knossos (competition) on the known-bad histories, time limit $LIMIT ms"
    $HEAVY sh -c "$B/e22b parts $W/por-bad.jsonl $BAD && $JAVA $KN $W/jobs-bad.jsonl $W/knossos-bad.jsonl $LIMIT"
    python3 -I "$HERE/compare.py" knossos "$POR" "$W/knossos-bad.jsonl=$W/jobs-bad.jsonl"; } 2>&1 | grep -v JAVA_TOOL > "$R/knossos-bad.md"
fi

if want por; then $HEAVY "$B/e22b" parts "$W/por-other.jsonl" $OTHER; fi

if want small; then
  rm -f "$W"/jobs-small*; python3 -I "$HERE/prep.py" sample "$W/jobs-small.jsonl" 0 0 120 $OTHER 2> "$W/small-draw.txt"
  ( cd "$W" && split -n l/3 -d -a 1 jobs-small.jsonl jobs-small- ) && wc -l "$W"/jobs-small-*
  # chunk 0 ran in file order and finished; chunks 1 and 2 hold the slow p08, p17 partitions and are
  # cut at 25 min, so they run in a seeded random order: what a cut leaves checked is a random sample
  python3 -I "$HERE/prep.py" shuffle "$W/jobs-small-1" 2212; python3 -I "$HERE/prep.py" shuffle "$W/jobs-small-2" 2213
fi
for i in 0 1 2; do
  if want small$((i + 1)); then
    $HEAVY sh -c "timeout 1500 $JAVA $KN $W/jobs-small-$i $W/knossos-small-$i.jsonl $LIMIT" || echo "chunk $i stopped: exit $?"
  fi
done

if want big; then
  : > "$W/jobs-big.jsonl"; python3 -I "$HERE/prep.py" sample "$W/jobs-big.jsonl" "$KBIG" 121 1000000 $OTHER 2> "$W/big-draw.txt"
  { head "Knossos (competition) on $KBIG partitions per file of more than 120 ops, $LIMITBIG ms each, the hold cut at 25 min"
    grep -v " 0 with" "$W/big-draw.txt"
    $HEAVY sh -c "timeout 1500 $JAVA $KN $W/jobs-big.jsonl $W/knossos-big.jsonl $LIMITBIG" || echo "stopped: exit $?"
    python3 -I "$HERE/compare.py" knossos "$POR" "$W/knossos-big.jsonl=$W/jobs-big.jsonl"; } 2>&1 | grep -v JAVA_TOOL > "$R/knossos-big.md"
fi

if want report; then
  SMALL="$W/knossos-small-0.jsonl=$W/jobs-small-0,$W/knossos-small-1.jsonl=$W/jobs-small-1,$W/knossos-small-2.jsonl=$W/jobs-small-2"
  { echo "# Knossos (competition) on the partitions of 120 ops or fewer in every other history file, time limit $LIMIT ms"
    echo "# jobs: $(wc -l < "$W/jobs-small.jsonl") partitions; checked: $(cat "$W"/knossos-small-[012].jsonl | wc -l)"
    python3 -I "$HERE/compare.py" knossos "$POR" "$SMALL"; } > "$R/knossos-small.md"
  { echo "# Knossos 0.3.16 beside Porcupine v1.3.1: every run, per group and mode"
    python3 -I "$HERE/compare.py" knsum "$POR" \
      "$W/knossos-pilot.jsonl=$W/jobs-pilot.jsonl,$W/knossos-bad.jsonl=$W/jobs-bad.jsonl,$SMALL,$W/knossos-big.jsonl=$W/jobs-big.jsonl"; } > "$R/knossos-summary.md"
fi
