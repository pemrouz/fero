#!/bin/sh
# E-09c: Kafka 4.4.0 (KRaft, 3 nodes) driven by Kafka's own perf tools on this box.
#   sh run.sh all            build, then two timing holds (one per setup: max phase, then lat phase), then the tables
#   sh run.sh <hold>         one of: build | calibrate | checks | default | flush1 | default-max | flush1-max | default-lat | flush1-lat | sharediag | sharediag-hb | table
# Every timed hold runs under $SP/bin/timing (the box alone); checks run under $SP/bin/heavy.
# A max phase must run before its lat phase: `half` runs at half of max-omb's median rate.
set -e
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
HERE=$(cd "$(dirname "$0")" && pwd)
K=$SP/dl/kafka/kafka_2.13-4.4.0
B="python3 -I $HERE/kbench.py"
mkdir -p "$HERE/results/raw" "$SP/e09/kafka"
cd "$SP/e09/kafka"
log() { echo "=== $(date +%T) $* (load $(cut -d' ' -f1-3 /proc/loadavg))" | tee -a "$HERE/results/timing-log.txt"; }
case "$1" in
build)
  mkdir -p "$SP/e09/kafka/classes"
  javac -proc:none -cp "$K/libs/*" -d "$SP/e09/kafka/classes" "$HERE"/e2e/*.java ;;
calibrate)
  "$SP/bin/timing" sh -c "for s in default flush1; do $B smoke kafka \$s max --scale 0.1; $B smoke kafka \$s lat --scale 0.1; done" 2>&1 \
    | grep -v '^\[20' | tee "$HERE/results/calibrate.txt" ;;
checks)
  for s in default flush1; do "$SP/bin/heavy" python3 -I "$HERE/tools/fsynccheck.py" kafka $s 2000; done 2>&1 | grep -v '^\[20' > "$HERE/results/fsynccheck.txt"
  "$SP/bin/heavy" python3 -I "$HERE/tools/apicheck.py" kafka default 2>&1 | grep -v '^\[20' > "$HERE/results/apicheck.txt" ;;
default|flush1)
  # one timing hold per setup: 3 runs of the max phase, then 3 runs of the lat phase (about 20 minutes)
  log "start kafka $1"
  "$SP/bin/timing" sh -c "$B run kafka $1 max && $B run kafka $1 lat" 2>&1 | grep -v '^\[20' | tee -a "$HERE/results/timing-log.txt"
  log "end kafka $1" ;;
default-max|flush1-max|default-lat|flush1-lat)
  # one phase alone (to re-run a phase); extra arguments go to kbench.py, e.g. `sh run.sh flush1-lat --first 2 --runs 2`
  h=$1; shift; x="$*"; set -- $(echo "$h" | tr - ' ')
  log "start kafka $1 $2 $x"
  "$SP/bin/timing" $B run kafka "$1" "$2" $x 2>&1 | grep -v '^\[20' | tee -a "$HERE/results/timing-log.txt"
  log "end kafka $1 $2 $x" ;;
sharediag)
  # the share-group diagnostic (tools/sharediag.py): per-second share-consumer stats, timed, the box alone
  log "start kafka sharediag"
  "$SP/bin/timing" python3 -I "$HERE/tools/sharediag.py" default 3 2>&1 | grep -v '^\[20' | tee "$HERE/results/sharediag.txt"
  log "end kafka sharediag" ;;
sharediag-hb)
  # the same with the share-group heartbeat at 1,000 ms instead of 5,000 ms (is the start-up wait one heartbeat?)
  log "start kafka sharediag-hb"
  "$SP/bin/timing" python3 -I "$HERE/tools/sharediag.py" default 3 1000 2>&1 | grep -v '^\[20' | tee "$HERE/results/sharediag-hb1000.txt"
  log "end kafka sharediag-hb" ;;
table)
  $B table ;;
all)
  for h in build default flush1 sharediag sharediag-hb table; do sh "$0" $h; done ;;
*)
  echo "usage: sh run.sh all|build|calibrate|checks|default|flush1|default-max|flush1-max|default-lat|flush1-lat|sharediag|sharediag-hb|table"; exit 2 ;;
esac
