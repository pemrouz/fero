#!/bin/sh
# E-02: the replication pipeline floor in TS (main thread, 1/2/4 workers), Rust and Go.
# Each configuration runs RUNS times (default 3); a few configurations share one timing hold.
# Needs E-01's results/fdatasync-1w-cdf.txt for the tmpfs (emu) variant.
# Usage: sh run.sh [build|all|summary|<block>]   blocks: core (= core100 + core1k) emu1 emu16kwn grouprungs prealloc
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
BIN=$SP/e01e02
RUNS=${RUNS:-3}
what=${1:-all}

build() {
  mkdir -p "$BIN"
  (cd "$HERE/rs" && CARGO_TARGET_DIR=$BIN/target-pipe cargo build --release --locked -q)
  (cd "$HERE/go" && GOTOOLCHAIN=local go build -o "$BIN/e02-go" .)
  gcc -shared -fPIC -O2 -Wall -I"$(dirname "$(dirname "$(readlink -f "$(command -v node)")")")/include/node" \
    -o "$BIN/emu.node" "$HERE/emu/emu.c"
}

b() { node "$HERE/bench.mjs" runs="$RUNS" "$@"; }
# one timing hold runs a block of configurations (about 6 to 12 minutes); a block can be re-run:
# configurations that already have RUNS good runs in results/runs.jsonl are skipped
hold() { "$SP/bin/timing" sh "$HERE/run.sh" "$@"; }

core_one() {  # $1 = impl, $2 = size: persisted, real disk, growing files, one group
  b impl=$1 size=$2 rate=max
  b impl=$1 size=$2 rate=10000
  b impl=$1 size=$2 rate=50000
  b impl=$1 size=$2 rate=half
}
emu_one() {   # tmpfs; each fdatasync is followed by a delay drawn from E-01's one-writer distribution
  b impl=$1 size=100 groups=$2 store=emu rate=max
  b impl=$1 size=100 groups=$2 store=emu rate=half
  b impl=$1 size=100 groups=$2 store=emu rate=50000
}
kwn_one() {   # several kernel workers on the real disk, 16 groups pinned by group % N
  b impl=$1 size=100 groups=16 rate=max
  b impl=$1 size=100 groups=16 rate=50000
  b impl=$1 size=100 groups=16 rate=half
}
groups_one() { # $1 = groups sharing one journal and one link per peer
  for impl in ts rust go; do
    b impl=$impl size=100 groups=$1 rate=max
    b impl=$impl size=100 groups=$1 rate=50000
  done
}
rungs_one() {  # memory (no fsync wait), ldr (leader disk only), none (no followers, no disk)
  for impl in ts rust go; do
    b impl=$impl size=100 mode=$1 rate=max
    b impl=$impl size=100 mode=$1 rate=50000
  done
}
prealloc_one() { # fallocate'd or zero-filled segments, against growing files (core)
  for impl in ts rust go; do
    b impl=$impl size=100 store=$1 rate=max
    b impl=$impl size=100 store=$1 rate=half
  done
}

block() {
  case $1 in
    core100) for i in ts ts-w1 rust go; do core_one $i 100; done ;;
    core1k) for i in ts ts-w1 rust go; do core_one $i 1024; done ;;
    core) block core100; block core1k ;;
    emu1) for i in ts ts-w1 rust go; do emu_one $i 1; done ;;
    emu16) for i in ts-w1 ts-w2 ts-w4; do emu_one $i 16; done ;;
    kwn) for i in ts-w1 ts-w2 ts-w4; do kwn_one $i; done ;;
    groups) groups_one 16; groups_one 1000 ;;
    rungs1) rungs_one memory; rungs_one ldr ;;
    rungs2) rungs_one none ;;
    prealloc) prealloc_one falloc; prealloc_one zero ;;
    # kwN inside one process: the leader alone with its own (emulated) disk, so N workers are not
    # fighting two follower processes for the 4 vCPUs
    kwnsolo) for i in ts-w1 ts-w2 ts-w4; do b impl=$i size=100 groups=16 mode=ldr store=emu rate=max; done ;;
    preallocsolo) block prealloc; block kwnsolo ;;
    # bigger holds, so fewer waits behind other agents' heavy jobs
    emu16kwn) block emu16; block kwn ;;
    grouprungs) block groups; block rungs1; block rungs2 ;;
  esac
}
BLOCKS="core emu1 emu16kwn grouprungs preallocsolo"
cdf_wait() { until [ -s "$HERE/../E01-floors/results/fdatasync-1w-cdf.txt" ]; do sleep 30; done; }

case $what in
  _block) block "$2" ;;
  build) build ;;
  all) build; for k in $BLOCKS; do case $k in emu*) cdf_wait ;; esac; hold _block "$k"; done
       python3 "$HERE/summarize.py" "$HERE/results" > "$HERE/results/tables.md" ;;
  summary) python3 "$HERE/summarize.py" "$HERE/results" > "$HERE/results/tables.md" ;;
  # the queue started on 2026-11-06 calls emu16 kwn groups rungs1 rungs2 one by one: merge them into two holds
  emu16) cdf_wait; hold _block emu16kwn ;;
  groups) hold _block grouprungs ;;
  kwn|rungs1|rungs2) ;;
  prealloc) cdf_wait; hold _block preallocsolo ;;
  *) case $what in emu*) cdf_wait ;; esac; hold _block "$what" ;;
esac
