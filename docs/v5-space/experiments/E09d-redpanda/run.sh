#!/bin/sh
# E-09d: Redpanda 26.2.6 (3 nodes, --smp 1 --memory 2G --overprovisioned) driven by Kafka's own perf tools.
# The driver is E-09c's kbench.py (one driver, so Kafka's and Redpanda's rows are measured the same way);
# its results land in this folder's results/.
#   sh run.sh all            two timing holds (one per setup: max phase, then lat phase), then the tables
#   sh run.sh <hold>         one of: build | calibrate | checks | fsync | wcache | fsync-max | wcache-max | fsync-lat | wcache-lat | table
# Needs E-09c's Java probes built (sh ../E09c-kafka/run.sh build) and /opt/redpanda linked (fetch.sh).
set -e
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
HERE=$(cd "$(dirname "$0")" && pwd)
C=$HERE/../E09c-kafka
B="python3 -I $C/kbench.py"
R="--results $HERE/results"
mkdir -p "$HERE/results/raw" "$SP/e09/redpanda"
cd "$SP/e09/redpanda"
log() { echo "=== $(date +%T) $* (load $(cut -d' ' -f1-3 /proc/loadavg))" | tee -a "$HERE/results/timing-log.txt"; }
case "$1" in
build)
  sh "$C/run.sh" build ;;
calibrate)
  "$SP/bin/timing" sh -c "for s in fsync wcache; do $B smoke redpanda \$s max --scale 0.1 $R; $B smoke redpanda \$s lat --scale 0.1 $R; done" 2>&1 \
    | grep -v '^\[20' | tee "$HERE/results/calibrate.txt" ;;
checks)
  for s in fsync wcache; do "$SP/bin/heavy" python3 -I "$C/tools/fsynccheck.py" redpanda $s 2000; done 2>&1 | grep -v '^\[20' > "$HERE/results/fsynccheck.txt"
  for s in fsync wcache; do "$SP/bin/heavy" python3 -I "$C/tools/apicheck.py" redpanda $s; done 2>&1 | grep -v '^\[20' > "$HERE/results/apicheck.txt" ;;
fsync|wcache)
  # one timing hold per setup: 3 runs of the max phase, then 3 runs of the lat phase (about 20 minutes)
  log "start redpanda $1"
  "$SP/bin/timing" sh -c "$B run redpanda $1 max $R && $B run redpanda $1 lat $R" 2>&1 | grep -v '^\[20' | tee -a "$HERE/results/timing-log.txt"
  log "end redpanda $1" ;;
fsync-max|wcache-max|fsync-lat|wcache-lat)
  # one phase alone (to re-run a phase)
  set -- $(echo "$1" | tr - ' ')
  log "start redpanda $1 $2"
  "$SP/bin/timing" $B run redpanda "$1" "$2" $R 2>&1 | grep -v '^\[20' | tee -a "$HERE/results/timing-log.txt"
  log "end redpanda $1 $2" ;;
table)
  $B table $R ;;
all)
  for h in build fsync wcache table; do sh "$0" $h; done ;;
*)
  echo "usage: sh run.sh all|build|calibrate|checks|fsync|wcache|fsync-max|wcache-max|fsync-lat|wcache-lat|table"; exit 2 ;;
esac
