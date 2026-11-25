#!/bin/sh
# Probe P2: the kernel in the simulator.
#
#   ./run.sh build     the native runner and the WASM module
#   ./run.sh check     the byte check: seeds 1 to 1,000, native against WASM,
#                      with the fold on and with it off; all three lists equal
#   ./run.sh trap      builds both with a planted trap; the check must fail
#   ./run.sh timing    the measures, three runs (results/timing.jsonl)
#   ./run.sh summary   results/tables.md from results/timing.jsonl
#   ./run.sh           build, check, trap
#
# It needs Rust (the pinned toolchain with the wasm32-unknown-unknown target),
# Node 22.18 or later, and a checkout of data: DATA_DIR, or `data` next to
# this repo.
#
# WORK is where builds and lists go (default: target/p2 in the repo).
# On a shared machine, HEAVY and TIMING may name a wrapper that takes a lock:
# HEAVY around builds and long runs, TIMING around each timed run.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
WORK=${WORK:-$ROOT/target/p2}
W32=wasm32-unknown-unknown
SEEDS=${SEEDS:-1000}
mkdir -p "$WORK" "$HERE/results"
cd "$ROOT"

build() {
  $HEAVY cargo build -q --release --target-dir "$WORK/target" -p sim-run
  $HEAVY cargo build -q --release --target-dir "$WORK/target" -p wasm --target $W32
  cp "$WORK/target/$W32/release/fero_sim.wasm" "$WORK/fero_sim.wasm"
  echo "built: $(wc -c < "$WORK/fero_sim.wasm") bytes of WASM"
}

# lists <dir with the builds> <prefix>: the three lists of seed lines.
lists() {
  $HEAVY "$1/release/sim-run" seeds 1 "$SEEDS" > "$WORK/$2native.txt"
  $HEAVY node "$HERE/lines.mjs" "$1/$W32/release/fero_sim.wasm" 1 "$SEEDS" fold > "$WORK/$2wasm-fold.txt" 2> "$WORK/$2fold-work.json"
  $HEAVY node "$HERE/lines.mjs" "$1/$W32/release/fero_sim.wasm" 1 "$SEEDS" nofold > "$WORK/$2wasm-nofold.txt" 2> /dev/null
}

# differing <a> <b>: how many seeds have a different line.
differing() {
  paste -d' ' "$1" "$2" | awk '$1 != $4 || $2 != $5 || $3 != $6 { d++ } END { print d + 0 }'
}

check() {
  lists "$WORK/target" ""
  a=$(differing "$WORK/native.txt" "$WORK/wasm-fold.txt")
  b=$(differing "$WORK/native.txt" "$WORK/wasm-nofold.txt")
  n=$(wc -l < "$WORK/native.txt")
  events=$(awk '{ e += $2 } END { print e }' "$WORK/native.txt")
  {
    echo "seeds 1 to $SEEDS: $n lines in each list, $events events"
    echo "native against WASM with the fold on:  $a seeds differ"
    echo "native against WASM with the fold off: $b seeds differ"
    echo "what the fold did: $(cat "$WORK/fold-work.json")"
    echo "sha256 of the list: $(sha256sum < "$WORK/native.txt" | cut -d' ' -f1)"
  } > "$HERE/results/check.txt"
  cat "$HERE/results/check.txt"
  if [ "$n" != "$SEEDS" ] || [ "$a" != 0 ] || [ "$b" != 0 ]; then echo "FAILED p2 check"; exit 1; fi
  if [ "$SEEDS" = 1000 ]; then cp "$WORK/native.txt" "$HERE/results/seeds-1-1000.txt"; fi
  echo "ok p2 check: $n of $SEEDS seeds, three lists equal"
}

trap_check() {
  $HEAVY cargo build -q --release --target-dir "$WORK/target-trap" -p sim-run --features sim/trap-width
  $HEAVY cargo build -q --release --target-dir "$WORK/target-trap" -p wasm --target $W32 --features sim/trap-width
  lists "$WORK/target-trap" "trap-"
  a=$(differing "$WORK/trap-native.txt" "$WORK/trap-wasm-fold.txt")
  b=$(differing "$WORK/trap-wasm-fold.txt" "$WORK/trap-wasm-nofold.txt")
  {
    echo "with the trap planted (a machine-sized length hashed into the trace), seeds 1 to $SEEDS:"
    echo "native against WASM: $a seeds differ"
    echo "WASM with the fold on against WASM with the fold off: $b seeds differ"
  } > "$HERE/results/trap.txt"
  cat "$HERE/results/trap.txt"
  if [ "$a" = 0 ]; then echo "FAILED p2 trap: the check did not see the trap"; exit 1; fi
  echo "ok p2 trap: the check fails on $a of $SEEDS seeds"
}

# One timed run. Each bench is preceded by the machine's load average.
batch() {
  run=$1
  R="$WORK/timing.jsonl"
  la() { printf '{"run":%s,"loadavg":"%s"}\n' "$run" "$(cat /proc/loadavg 2> /dev/null || echo unknown)"; }
  { la; node --expose-gc "$HERE/bench.mjs" "$WORK/fero_sim.wasm"; } >> "$R"
  { la; "$WORK/target/release/sim-run" time 1 200 5; } >> "$R"
}

# The three runs land in results/ only when all three are done.
timing() {
  : > "$WORK/timing.jsonl"
  for run in 1 2 3; do $TIMING sh "$HERE/run.sh" batch $run; done
  cp "$WORK/timing.jsonl" "$HERE/results/timing.jsonl"
}

case "${1:-all}" in
  build) build ;;
  check) check ;;
  trap) trap_check ;;
  batch) batch "$2" ;;
  timing) timing ;;
  summary) node "$HERE/summarize.mjs" "$HERE/results/timing.jsonl" > "$HERE/results/tables.md"; cat "$HERE/results/tables.md" ;;
  all) build; check; trap_check; echo "ok p2" ;;
  *) echo "usage: ./run.sh [build|check|trap|timing|summary]"; exit 2 ;;
esac
