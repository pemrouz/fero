#!/bin/sh
# E-04: one Rust kernel in WASM as the sim's kernel; byte identity of a TS and a Rust kernel.
#   ./run.sh build    K (Rust twin) to wasm32, clean and with each planted trap; K natively (replay bin);
#                     raft-rs 0.7.0 to wasm32 (heavy lock)
#   ./run.sh guard    the 1,000-seed TS-vs-WASM diff, clean and with each trap (heavy lock; not timing)
#   ./run.sh timing   TEST-01 with the kernel in WASM and in TS, the replay benches (timing lock, 3 runs)
#   ./run.sh          all three
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
OUT=$SP/e04
mkdir -p "$OUT" "$HERE/results"
NODEF="--experimental-strip-types --no-warnings"
W=wasm32-unknown-unknown

build() {
  H="$SP/bin/heavy"
  CARGO_TARGET_DIR=$OUT/t-k "$H" cargo build --release --locked --target $W --lib --manifest-path "$HERE/k-rs/Cargo.toml"
  cp "$OUT/t-k/$W/release/e04_k.wasm" "$OUT/k.wasm"
  for f in trap-map-order trap-num-i64; do
    CARGO_TARGET_DIR=$OUT/t-k-$f "$H" cargo build --release --locked --target $W --lib --features $f --manifest-path "$HERE/k-rs/Cargo.toml"
    cp "$OUT/t-k-$f/$W/release/e04_k.wasm" "$OUT/k-$f.wasm"
  done
  CARGO_TARGET_DIR=$OUT/t-k-native "$H" cargo build --release --locked --bin replay --manifest-path "$HERE/k-rs/Cargo.toml"
  CARGO_TARGET_DIR=$OUT/t-raft "$H" cargo build --release --locked --target $W --lib --manifest-path "$HERE/raft-wasm/Cargo.toml"
  cp "$OUT/t-raft/$W/release/e04_raftwasm.wasm" "$OUT/raft.wasm"
}

guard() {
  H="$SP/bin/heavy"
  : > "$HERE/results/guard.jsonl"
  "$H" node $NODEF "$HERE/bench/diff.ts" "$OUT/k.wasm" 1000 clean >> "$HERE/results/guard.jsonl"
  for t in sort-utf16 strlen-utf16 varint-32; do
    E04_TRAP=$t "$H" node $NODEF "$HERE/bench/diff.ts" "$OUT/k.wasm" 1000 "ts:$t" >> "$HERE/results/guard.jsonl"
  done
  for f in trap-map-order trap-num-i64; do
    "$H" node $NODEF "$HERE/bench/diff.ts" "$OUT/k-$f.wasm" 1000 "rust:$f" >> "$HERE/results/guard.jsonl"
  done
}

# One timing hold per run (a few minutes), each bench preceded by a load-average line.
batch() {
  run=$1; R="$HERE/results"
  la() { printf '{"run":%s,"loadavg":"%s"}\n' "$run" "$(cat /proc/loadavg)"; }
  { la; node $NODEF --expose-gc "$HERE/bench/test01.ts" "$OUT/k.wasm" "$OUT/raft.wasm" "$OUT/trace.bin"; } >> "$R/test01.jsonl"
  { la; "$OUT/t-k-native/release/replay" "$OUT/trace.bin" 5; } >> "$R/replay-native.jsonl"
}

timing() {
  node $NODEF "$HERE/bench/record.ts" "$OUT/trace.bin" > "$HERE/results/trace.json"
  for run in 1 2 3; do "$SP/bin/timing" "$HERE/run.sh" batch $run; done
}

case "${1:-all}" in
  batch) batch "$2" ;;
  build) build ;;
  guard) guard ;;
  timing) timing ;;
  all) build; guard; timing ;;
esac
