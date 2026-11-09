#!/bin/sh
# E-12: one shared journal against one log file per group, in Node and Rust.
# Usage: sh run.sh build | sh run.sh all | sh run.sh <block> | sh run.sh summary
#   blocks: ts1 ts16 ts256 ts2000 rs1 rs16 rs256 rs2000 var-ts var-rs var2-rs stripe-rs fs-rs
#   fs-rs needs the loop filesystems: $SP/bin/heavy sh mkfs.sh up (and mkfs.sh down after)
# Each block runs under the timing lock ($SP/bin/timing). Within a block the 3 repeats are
# interleaved (config 1..n, then again, then again). A config that already has $RUNS lines in
# results/runs.jsonl is skipped, so a block can be re-run after an interruption.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
RUNS=${RUNS:-3}
OUT=$HERE/results/runs.jsonl
RSBIN=$SP/e12/target/release/e12journal
DATA=$SP/e12/data
WIN="warm=1500 dur=6000 drain=1000"

build() { (cd "$HERE/rs" && CARGO_TARGET_DIR=$SP/e12/target cargo build --release --locked -q); }

# one config: impl mode groups rate prealloc pool
have() { if [ -f "$OUT" ]; then grep -c "\"tag\":\"$1\"" "$OUT" || true; else echo 0; fi; }
one() {
  impl=$1 mode=$2 g=$3 rate=$4 pre=${5:-0} pool=${6:-4} fs=${7:-root} st=${8:-1}
  tag="$impl/$mode/$g/$rate/p$pre/t$pool"; [ "$fs" = root ] || tag="$tag/$fs"; [ "$st" = 1 ] || tag="$tag/s$st"
  n=$(have "$tag"); [ "$n" -ge "$RUNS" ] && return 0
  r=$rate; [ "$rate" = max ] && r=0
  DATA=$SP/e12/data; [ "$fs" = root ] || DATA=$SP/e12/mnt/$fs/data
  rm -rf "$DATA"
  d0=$(awk '$3=="vda"{print $10}' /proc/diskstats); s0=$(date +%s.%N)
  if [ "$impl" = ts ]; then
    line=$(UV_THREADPOOL_SIZE=$pool node "$HERE/ts/journal.ts" mode=$mode groups=$g rate=$r prealloc=$pre $WIN dir=$DATA tag=$tag) || { echo "FAIL $tag" >&2; return 0; }
  else
    line=$("$RSBIN" mode=$mode stripes=$st groups=$g rate=$r prealloc=$pre pool=$pool $WIN dir=$DATA tag=$tag) || { echo "FAIL $tag" >&2; return 0; }
  fi
  d1=$(awk '$3=="vda"{print $10}' /proc/diskstats); s1=$(date +%s.%N)
  # the whole disk's writes during the run (MB/s, setup included), to spot other writers beside this run's own mb_s
  line=$(echo "$line" | python3 -c "import json,sys; d=json.loads(sys.stdin.read()); d['disk_mb_s_run']=round(($d1-$d0)*512/1e6/($s1-$s0),2); print(json.dumps(d))")
  echo "$line" >> "$OUT"
  echo "$line" | python3 -c 'import json,sys; d=json.loads(sys.stdin.read()); print("%-24s %9.0f/s fsync %7.0f/s p99 %8.2f ms cpu %6.2f us load %s" % (d["tag"], d["appends_s"], d["fsyncs_s"], d["p99"] or -1, d["cpu_us_per_append"], d["loadavg"].split()[0]))'
}

# a block = a list of configs, each repeated RUNS times, interleaved
blk() {
  i=1
  while [ $i -le "$RUNS" ]; do
    echo "$CONFIGS" | while read -r c; do [ -n "$c" ] && one $c; done
    i=$((i + 1))
  done
}
loads="10000 50000 200000 max"
main_block() {  # $1 impl $2 groups
  CONFIGS=""
  modes="a b c"; [ "$2" = 1 ] && modes="a b"
  for m in $modes; do for l in $loads; do CONFIGS="$CONFIGS
$1 $m $2 $l"; done; done
  blk
}
var_block() {  # $1 impl: preallocated segments, and 32 threads for b and c
  CONFIGS=""
  for g in 256 2000; do for l in 50000 max; do
    for m in a b c; do CONFIGS="$CONFIGS
$1 $m $g $l 1 4"; done
    for m in b c; do CONFIGS="$CONFIGS
$1 $m $g $l 0 32"; done
  done; done
  blk
}

var2_block() {  # Rust: one sync thread per group for b and c (as a goroutine per WAL would give)
  CONFIGS=""
  for g in 256 2000; do for l in 50000 max; do for m in b c; do CONFIGS="$CONFIGS
rs $m $g $l 0 $g"; done; done; done
  blk
}
stripe_block() {  # Rust: the journal striped over 4 files, each with its own flush thread (group g -> journal g % 4)
  CONFIGS=""
  for g in 16 256 2000; do for l in $loads; do CONFIGS="$CONFIGS
rs a $g $l 0 4 root 4"; done; done
  blk
}
fs_block() {  # Rust, the same disk through 4 GiB loop filesystems: ext4 with a jbd2 journal, and XFS.
  # Fixed rate on growing files; max on preallocated segments (a max run with growing files fills 4 GiB).
  CONFIGS=""
  for fs in ext4j xfs; do for g in 256 2000; do for m in a b c; do CONFIGS="$CONFIGS
rs $m $g 50000 0 4 $fs
rs $m $g max 1 4 $fs"; done; done; done
  blk
}

# the dispatch is one brace group ending in exit, so editing this file during a run is safe
{
case "${1:-all}" in
  build) build ;;
  ts1|ts16|ts256|ts2000|rs1|rs16|rs256|rs2000)
    impl=$(echo "$1" | cut -c1-2); g=$(echo "$1" | cut -c3-); main_block "$impl" "$g" ;;
  var-ts) var_block ts ;;
  var-rs) var_block rs ;;
  fs-rs) fs_block ;;
  var2-rs) var2_block ;;
  stripe-rs) stripe_block ;;
  summary) python3 "$HERE/summarize.py" "$OUT" > "$HERE/results/tables.md"; cat "$HERE/results/tables.md" ;;
  all)
    "$SP/bin/heavy" sh "$HERE/run.sh" build
    for b in rs1 rs16 rs256 rs2000 ts1 ts16 ts256 ts2000 var-rs var-ts var2-rs stripe-rs; do
      echo "$(date +%T) block $b waiting"; "$SP/bin/timing" sh "$HERE/run.sh" "$b"; echo "$(date +%T) block $b done"
    done
    "$SP/bin/heavy" sh "$HERE/mkfs.sh" up
    "$SP/bin/timing" sh "$HERE/run.sh" fs-rs
    "$SP/bin/heavy" sh "$HERE/mkfs.sh" down
    sh "$HERE/run.sh" summary ;;
  *) echo "unknown block $1" >&2; exit 1 ;;
esac
exit 0
}
