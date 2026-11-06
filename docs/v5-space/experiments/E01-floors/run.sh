#!/bin/sh
# E-01: this box's floors (fsync for 1 and 3 writers, flush honesty, loopback round trip).
# Several rounds share ONE hold of $SP/bin/timing (8 to 14 minutes), so the box is not handed to
# other agents' heavy jobs between rounds; each phase runs 3 rounds.
# Every measurement records /proc/loadavg first.
# Usage: sh run.sh [all|build|env|summary]   (all = build, env, then three timing holds)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
T=$SP/bin/timing
WORK=$SP/e01e02/e01            # on the real disk: the same ext4 as /
BIN=$SP/e01e02
R=$HERE/results
RAW=$SP/e01e02/e01-raw         # full fio JSON and probe samples stay out of the repo
PORT=27411
mkdir -p "$WORK" "$R" "$RAW"
what=${1:-all}
SELF="$HERE/run.sh"

build() {
  gcc -O2 -Wall -o "$BIN/wfsync" "$HERE/probe/wfsync.c"
  CARGO_TARGET_DIR=$BIN/target-rtt cargo build --release --manifest-path "$HERE/rtt/rs/Cargo.toml" -q
  (cd "$HERE/rtt" && GOTOOLCHAIN=local go build -o "$BIN/rtt-go" rtt.go)
}

env_txt() {
  {
    echo "date: $(date -Is)"; uname -a; nproc; free -m | head -2
    lscpu | grep -E 'Model name|^CPU\(s\)|Thread|MHz' || true
    mount | grep ' / '; echo "ext4 options:"; tr '\n' ' ' < /proc/fs/ext4/vda/options; echo
    dmesg 2>/dev/null | grep -E 'EXT4-fs \(vda\)' || true
    echo "vda: rotational=$(cat /sys/block/vda/queue/rotational) write_cache=$(cat /sys/block/vda/queue/write_cache) fua=$(cat /sys/block/vda/queue/fua) scheduler=$(cat /sys/block/vda/queue/scheduler)"
    echo "virtio-blk features (bit 0 first; bit 9 = VIRTIO_BLK_F_FLUSH): $(cat /sys/block/vda/device/features)"
    fio --version; node --version; rustc --version; go version; gcc --version | head -1
  } > "$R/env.txt" 2>&1
}

FIOCOMMON="--directory=$WORK --rw=write --ioengine=sync --size=4G --time_based --output-format=json --percentile_list=50:90:99:99.9:99.99"

fio_round() {   # every fio job once, about 4.5 minutes
  i=$1
  while IFS='|' read -r name secs args; do
    [ -z "$name" ] && continue
    out=$RAW/fio-$name.$i.json
    cat /proc/loadavg > "$out.load"
    # shellcheck disable=SC2086
    fio --name="$name" $FIOCOMMON --runtime="$secs" $args > "$out"
    rm -f "$WORK/$name".*
    python3 "$HERE/summarize.py" fio "$name" "$i" "$out" >> "$R/fio.jsonl"
  done <<JOBS
fsync-1w-4k|60|--bs=4k --fdatasync=1 --numjobs=1
fsync-3w-4k|60|--bs=4k --fdatasync=1 --numjobs=3 --group_reporting
dsync-1w-4k|30|--bs=4k --sync=dsync --numjobs=1
direct-dsync-1w-4k|30|--bs=4k --direct=1 --sync=dsync --numjobs=1
direct-nosync-1w-4k|30|--bs=4k --direct=1 --numjobs=1
fsync-1w-64k|30|--bs=64k --fdatasync=1 --numjobs=1
direct-dsync-3w-4k|30|--bs=4k --direct=1 --sync=dsync --numjobs=3 --group_reporting
JOBS
}

probe_round() {  # every probe layout once, about 2.5 minutes
  i=$1
  while read -r name w bs secs mode layout; do
    [ -z "$name" ] && continue
    out=$RAW/probe-$name.$i
    cat /proc/loadavg > "$out.load"
    "$BIN/wfsync" "$WORK" "$w" "$bs" "$secs" "$mode" "$layout" "$out"
    python3 "$HERE/summarize.py" probe "$name" "$i" "$out" "$w" >> "$R/probe.jsonl"
  done <<JOBS
grow-1w 1 4096 20 fdatasync grow
grow-3w 3 4096 20 fdatasync grow
falloc-1w 1 4096 20 fdatasync falloc
zero-1w 1 4096 20 fdatasync zero
zero-3w 3 4096 20 fdatasync zero
nosync-1w 1 4096 10 none grow
JOBS
}

rtt_round() {    # node, rust and go at 64 B and 1 KiB, 10 s each, about 80 s
  for impl in node rust go; do
    for bytes in 64 1024; do
      sh "$HERE/rtt/one.sh" "$1" "$impl" "$bytes" 10 "$PORT" >> "$R/rtt.jsonl"
    done
  done
}

sustained_round() {
  # 10 GiB of 1 MiB O_DIRECT writes, with a 4 KiB fdatasync probe at 200/s beside it.
  # A host-side write cache shows as a bandwidth cliff, or as the probe's flush time rising.
  i=$1; out=$RAW/sustained.$i
  cat /proc/loadavg > "$out.load"
  (cd "$RAW" && fio --output-format=json --directory="$WORK" \
    --name=bulk --rw=write --bs=1M --direct=1 --ioengine=libaio --iodepth=8 --size=10G --runtime=120 \
      --write_bw_log="$out.bulk" --log_avg_msec=1000 --exitall \
    --name=probe --rw=write --bs=4k --ioengine=sync --fdatasync=1 --rate_iops=200 --size=1G --time_based --runtime=150 \
      --percentile_list=50:90:99:99.9 > "$out.json")
  rm -f "$WORK"/bulk.* "$WORK"/probe.*
  python3 "$HERE/summarize.py" sustained "$i" "$out" >> "$R/sustained.jsonl"
}

# run phase:round specs in order, e.g. _do fio:1 fio:2 (inside one timing hold)
do_specs() { for spec in "$@"; do "${spec%%:*}_round" "${spec##*:}"; done; }
hold() { $T sh "$SELF" _do "$@"; }
cdf() { python3 "$HERE/summarize.py" cdf "$RAW/probe-grow-1w" 3 > "$R/fdatasync-1w-cdf.txt"; }

case $what in
  _do) shift; do_specs "$@" ;;
  all) build; env_txt
       hold fio:1 fio:2 fio:3
       hold probe:1 probe:2 probe:3; cdf
       hold rtt:1 rtt:2 rtt:3 sustained:1 sustained:2 sustained:3
       python3 "$HERE/summarize.py" summary "$R" > "$R/tables.md" ;;
  resume) hold fio:2 fio:3                     # what was left after the first fio round (2026-11-06)
       hold probe:1 probe:2 probe:3; cdf
       hold rtt:1 rtt:2 rtt:3 sustained:1 sustained:2 sustained:3
       python3 "$HERE/summarize.py" summary "$R" > "$R/tables.md" ;;
  build) build ;;
  env) env_txt ;;
  summary) python3 "$HERE/summarize.py" summary "$R" > "$R/tables.md" ;;
esac
