#!/bin/sh
# E-22b: E-22's saved histories re-checked with real Elle 0.2.8 and Knossos 0.3.16.
#   ./run.sh build     copy E-22's Go checker (unchanged, cmp-checked) and add e22b.go; go build
#   ./run.sh self      the 26 self-test cases: 8 with real Elle, 18 with Knossos (E-22's model, ported)
#   ./run.sh elle      real Elle on all 1,200 saga histories, at read committed and serializable
#   ./run.sh pilot     Knossos on the 1,800 register (lin-kv) partitions: the time per op that sizes the sample
#   ./run.sh knossos   Porcupine per partition, then Knossos, on: every lin-kv partition (3 modes), the
#                      known-bad histories (E-22's mutants, the lin-kv history from before fix G1), and a
#                      seeded sample of every other history file (K per file, at most MAXOPS ops)
#   ./run.sh report    results/*.md from the raw results
#   ./run.sh           all of the above, in that order
# Every JVM and Go step runs under $SP/bin/heavy (one hold per step, each well under 30 minutes).
# Inputs: E-22's histories in $SP/e22v (edn/, hist/, lin-kv-calm-before.jsonl), its Go build in
# $SP/e22v/go-build, and the jars fetch.sh lists. Outputs: raw in $SP/e22b, trimmed in results/.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
E22="$HERE/../E22-api-prototype/verify"
V="$SP/e22v"; W="$SP/e22b"; B="$W/go-build"; R="$HERE/results"
JARS="$SP/dl/elle-mvn/jars/*"
JAVA="java -Xmx3g -XX:ActiveProcessorCount=2 -cp $JARS:$HERE/clj"
K="${K:-20}"; MAXOPS="${MAXOPS:-120}"; LIMIT="${LIMIT:-60000}"
what="${1:-all}"
mkdir -p "$W" "$R"
head() { echo "# $1, $(date -u +%FT%TZ), $(java -version 2>&1 | grep -m1 version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }

if [ "$what" = all ] || [ "$what" = build ]; then
  rm -rf "$B"; mkdir -p "$B"
  for f in main.go model.go selftest.go; do cmp "$E22/go/$f" "$V/go-build/$f"; done   # E-22's build is its committed code
  cp "$V/go-build/go.mod" "$V/go-build/go.sum" "$V/go-build/main.go" "$V/go-build/model.go" "$V/go-build/selftest.go" "$B/"
  cp -r "$V/go-build/tipocket-elle" "$B/"
  cp "$HERE/go/e22b.go" "$B/"
  ( cd "$B" && GOTOOLCHAIN=local GOFLAGS=-mod=mod "$SP/bin/heavy" go build -o e22b . ) && echo "built $B/e22b ($(go version))"
fi

if [ "$what" = all ] || [ "$what" = self ]; then
  "$B/e22b" dumpself "$W/selftest.json"
  rm -rf "$W/self-edn"; python3 -I "$HERE/prep.py" elleself "$W/selftest.json" "$W/self-edn"
  python3 -I "$HERE/prep.py" self "$W/selftest.json" "$W/jobs-self.jsonl"
  "$SP/bin/heavy" sh -c "$JAVA clojure.main $HERE/clj/elle_check.clj $W/elle-self.jsonl $W/self-edn/*.edn && \
    $JAVA clojure.main $HERE/clj/knossos_check.clj $W/jobs-self.jsonl $W/knossos-self.jsonl 10000"
  { head "self-test: real Elle 0.2.8 and Knossos 0.3.16"
    python3 -I "$HERE/compare.py" elleself "$W/selftest.json" "$W/elle-self.jsonl"; echo
    python3 -I "$HERE/compare.py" knself "$W/selftest.json" "$W/knossos-self.jsonl"; } | tee "$R/selftest.md"
fi

if [ "$what" = all ] || [ "$what" = elle ]; then
  { head "real Elle 0.2.8 list-append on E-22's 1,200 EDN histories"
    "$SP/bin/heavy" sh -c "$JAVA clojure.main $HERE/clj/elle_check.clj $W/elle-real.jsonl $V/edn/*.edn"
    python3 -I "$HERE/compare.py" elle "$V/elle-raw.jsonl" "$W/elle-real.jsonl"; } 2>&1 | tee "$R/elle.md"
fi

LINKV="$V/hist/lin-kv-calm.jsonl $V/hist/lin-kv-faults.jsonl $V/hist/lin-kv-shuffle.jsonl"
BAD="$V/lin-kv-calm-before.jsonl $V/hist/mut-nodedup-lin-kv.jsonl $V/hist/mut-lostcommit-lin-kv.jsonl \
 $V/hist/mut-nodedup-core-exactly-once.jsonl $V/hist/mut-nodedup-p11.jsonl $V/hist/mut-lostcommit-p11.jsonl \
 $V/hist/mut-nodedup-p14.jsonl $V/hist/mut-lostcommit-p14.jsonl"
OTHER=$(ls "$V"/hist/*.jsonl | grep -v -e /lin-kv- -e /mut-)

if [ "$what" = all ] || [ "$what" = pilot ]; then
  : > "$W/jobs-pilot.jsonl"; python3 -I "$HERE/prep.py" all "$W/jobs-pilot.jsonl" $LINKV
  { head "pilot: Knossos (competition) on every lin-kv partition, time limit $LIMIT ms"
    "$SP/bin/heavy" sh -c "$B/e22b parts $W/por-pilot.jsonl $LINKV && $JAVA clojure.main $HERE/clj/knossos_check.clj $W/jobs-pilot.jsonl $W/knossos-pilot.jsonl $LIMIT"
    python3 -I "$HERE/compare.py" knossos "$W/por-pilot.jsonl" "$W/knossos-pilot.jsonl"; } 2>&1 | tee "$R/knossos-linkv.md"
fi

if [ "$what" = all ] || [ "$what" = knossos ]; then
  : > "$W/jobs-bad.jsonl"; python3 -I "$HERE/prep.py" all "$W/jobs-bad.jsonl" $BAD
  : > "$W/jobs-sample.jsonl"; python3 -I "$HERE/prep.py" sample "$W/jobs-sample.jsonl" "$K" "$MAXOPS" $OTHER 2> "$W/sample-draw.txt"
  { head "Knossos (competition) on the known-bad histories, time limit $LIMIT ms"
    "$SP/bin/heavy" sh -c "$B/e22b parts $W/por-bad.jsonl $BAD && $JAVA clojure.main $HERE/clj/knossos_check.clj $W/jobs-bad.jsonl $W/knossos-bad.jsonl $LIMIT"
    python3 -I "$HERE/compare.py" knossos "$W/por-bad.jsonl" "$W/knossos-bad.jsonl"; } 2>&1 | tee "$R/knossos-bad.md"
  { head "Knossos (competition) on a sample of every other history file: K=$K per file, at most $MAXOPS ops, time limit $LIMIT ms"
    cat "$W/sample-draw.txt"
    "$SP/bin/heavy" sh -c "$B/e22b parts $W/por-other.jsonl $OTHER"
    "$SP/bin/heavy" sh -c "$JAVA clojure.main $HERE/clj/knossos_check.clj $W/jobs-sample.jsonl $W/knossos-sample.jsonl $LIMIT"
    python3 -I "$HERE/compare.py" knossos "$W/por-other.jsonl" "$W/knossos-sample.jsonl"; } 2>&1 | tee "$R/knossos-sample.md"
fi
