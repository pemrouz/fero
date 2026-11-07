#!/bin/sh
# E-03: the napi seam, an embedded V8 (deno_core) and QuickJS (rquickjs), and SIDE's local seam.
#   ./run.sh build     compile the addon, the two isolate hosts and the daemon; bundle data (heavy lock)
#   ./run.sh timing    3 timing runs of every bench (timing lock), raw JSON lines into results/
#   ./run.sh           both
# Env: SP (scratchpad), DATA (data's folder), FERO (fero v4's folder, for kernel/codec.ts).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
OUT=$SP/e03
DATA=${DATA:-/home/user/pemrouz/data}
NODE26=${NODE26:-$SP/dl/node26/node-v26.13.0-linux-x64/bin/node}
ESBUILD=${ESBUILD:-$SP/dl/esbuild/node_modules/.bin/esbuild}
mkdir -p "$OUT" "$HERE/results"
NODEF="--experimental-strip-types --no-warnings"

build() {
  for c in addon isolate/denocore isolate/quickjs seam/daemon; do
    CARGO_TARGET_DIR=$OUT/target-$(basename $c) "$SP/bin/heavy" cargo build --release --locked --manifest-path "$HERE/$c/Cargo.toml"
  done
  cp "$OUT/target-addon/release/libe03_addon.so" "$OUT/e03.node"
  "$ESBUILD" "$DATA/api/index.ts" --bundle --format=iife --global-name=D --target=es2022 --ignore-annotations --log-level=error --outfile="$OUT/data.bundle.js"
}

# One timing hold per run: the whole batch below runs under one $SP/bin/timing lock (a few minutes),
# each bench preceded by a load-average line tagged with the run number.
batch() {
  run=$1; B="$OUT/data.bundle.js"; I="$HERE/isolate"; R="$HERE/results"
  la() { printf '{"run":%s,"loadavg":"%s"}\n' "$run" "$(cat /proc/loadavg)"; }
  { la; node "$HERE/bench/napi.mjs" "$OUT/e03.node"; }                                   >> "$R/napi.jsonl"
  { la; "$NODE26" "$HERE/bench/napi.mjs" "$OUT/e03.node"; }                              >> "$R/napi-node26.jsonl"
  { la; node $NODEF "$HERE/bench/fold.mjs" "$OUT/e03.node"; }                            >> "$R/fold.jsonl"
  { la; node --expose-gc "$I/node-host.mjs" "$B" "$I/shim.js" "$I/work.js"; }             >> "$R/isolate.jsonl"
  { la; "$NODE26" --expose-gc "$I/node-host.mjs" "$B" "$I/shim.js" "$I/work.js"; }        >> "$R/isolate.jsonl"
  { la; "$OUT/target-denocore/release/e03_denocore" "$B" "$I/shim.js" "$I/work.js"; }     >> "$R/isolate.jsonl"
  { la; "$OUT/target-quickjs/release/e03_quickjs" "$B" "$I/shim.js" "$I/work.js"; }       >> "$R/isolate.jsonl"
  { la; SEAM_DIR="$OUT" node "$HERE/seam/client.mjs" "$OUT/target-daemon/release/e03_daemon" "$OUT/e03.node"; } >> "$R/seam.jsonl"
}

timing() { for run in 1 2 3; do "$SP/bin/timing" "$HERE/run.sh" batch $run; done; }

case "${1:-all}" in
  batch) batch "$2" ;;
  build) build ;;
  timing) timing ;;
  all) build; timing ;;
esac
