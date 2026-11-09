#!/bin/sh
# E-08: deliveries a second from one relay core, Node and Rust, 1,000 and 10,000 loopback TCP subscribers.
#   ./run.sh build       build the Rust relay, subscriber and feed binaries (heavy lock)
#   ./run.sh <block>     one timing hold: s1k (1,000 subscribers) | s10k (10,000) | halfcpu | ticks
#   ./run.sh             build, every block, summary
#   ./run.sh summary     print the tables from results/runs.jsonl
# s1k / s10k: the Node relay with TICK=data (fan out after every read of the feed link) and the Rust relay, each
#   3 runs at max (as fast as the relay takes records) and 3 at half of that max; s1k ends with the yardstick, core
#   NATS 1 -> 16 at 100 B with NATS's own tool (nats.py).
# halfcpu: both relays at a load where they use at most about 0.6 of a core (a sweep halves the rate from half
#   the max until they do), 3 runs there: delivery latency at a moderate load.
# ticks: the Node relay at max with TICK=immediate (one fan-out per event-loop turn) and TICK=win10 (one per 10 ms):
#   how much of the Node-Rust gap is records per write.
# Env: SP (scratchpad), RUNS (default 3).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
RUNS=${RUNS:-3}
B="node $HERE/bench.mjs"
blk() {
  TICK=data $B impl=node subs=$1 rate=max runs="$RUNS"; TICK=data $B impl=node subs=$1 rate=half runs="$RUNS"
  $B impl=rust subs=$1 rate=max runs="$RUNS"; $B impl=rust subs=$1 rate=half runs="$RUNS"
}
case "${1:-all}" in
  build) (cd "$HERE/rs" && CARGO_TARGET_DIR=$SP/e08/target "$SP/bin/heavy" cargo build --release --locked) ;;
  _s1k) blk 1000; python3 "$HERE/nats.py" "$RUNS" "$HERE/results/nats.jsonl" ;;
  _s10k) blk 10000 ;;
  _halfcpu) for n in 1000 10000; do for impl in node rust; do TICK=data $B impl=$impl subs=$n rate=halfcpu runs="$RUNS"; done; done ;;
  _ticks) for t in immediate win10; do for n in 1000 10000; do TICK=$t $B impl=node subs=$n rate=max runs="$RUNS"; done; done ;;
  s1k|s10k|halfcpu|ticks) { node --version; uname -r; nproc; grep -A1 'name = "mio"' "$HERE/rs/Cargo.lock"; } > "$HERE/results/versions.txt"; "$SP/bin/timing" sh "$HERE/run.sh" "_$1" ;;
  summary) python3 "$HERE/summarize.py" "$HERE/results/runs.jsonl" ;;
  all) "$HERE/run.sh" build; for b in s1k s10k halfcpu ticks; do "$HERE/run.sh" $b; done; "$HERE/run.sh" summary ;;
  *) echo "unknown block $1"; exit 1 ;;
esac
