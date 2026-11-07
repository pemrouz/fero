#!/bin/bash
# One Maelstrom lin-kv run of the E-46 node, then the summary.
# Usage: run-one.sh <name> <nodes> <read: readindex|log|mixed|buggy> <seed> <seconds> <nemesis: partition|none> <pause: 0|1> [compact] [rate] [concurrency]
# Writes the run to $E46_RUNS/<name>/ (Maelstrom's store, the pauser log) and one JSON line to $E46_RUNS/summary.jsonl.
# Run it under the heavy lock: $SP/bin/heavy run-one.sh ...
# E46_TIMEOUT (s, default 0 = none) stops Maelstrom, checker included, after that long; the history
# is written before the checker starts, so tools/porcupine can still check it.
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
MAELSTROM_JAR="${MAELSTROM_JAR:-$SP/dl/maelstrom/maelstrom/lib/maelstrom.jar}"
RUNS="${E46_RUNS:-$SP/e46/runs}"
name=$1 nodes=$2 read=$3 seed=$4 secs=$5 nemesis=$6 pause=$7 compact=${8:-0} rate=${9:-50} conc=${10:-4n}

dir="$RUNS/$name"
rm -rf "$dir"; mkdir -p "$dir/pids"
cd "$dir"
nem=()
[ "$nemesis" != none ] && nem=(--nemesis "$nemesis" --nemesis-interval "${E46_NEMESIS_INTERVAL:-3}")
# Server-to-server latency: exponential with this mean (ms), so messages on one link reorder.
# Maelstrom keeps client-to-server latency at zero whatever this is.
lat=(--latency "${E46_LATENCY:-5}" --latency-dist "${E46_LATENCY_DIST:-exponential}")

pauser_pid=""
if [ "$pause" = 1 ]; then
  # Pause for the test's length minus 5 s, so every node runs again before teardown.
  node --experimental-strip-types --no-warnings "$HERE/node/pauser.ts" "$dir/pids" "$nodes" "$((secs - 5))" "$seed" "$dir/pauses.log" 4000 200 3000 &
  pauser_pid=$!
fi

start=$(date +%s)
set +e
E46_READ="$read" E46_SEED="$seed" E46_PIDDIR="$dir/pids" E46_COMPACT="$compact" \
  timeout "${E46_TIMEOUT:-0}" java -Xmx3g -Djava.awt.headless=true -jar "$MAELSTROM_JAR" test -w lin-kv \
  --bin "$HERE/node/run-node.sh" --node-count "$nodes" --time-limit "$secs" \
  --concurrency "$conc" --rate "$rate" "${lat[@]}" "${nem[@]}" > maelstrom.out 2>&1
code=$?
set -e
end=$(date +%s)
[ -n "$pauser_pid" ] && { kill "$pauser_pid" 2>/dev/null || true; wait "$pauser_pid" 2>/dev/null || true; }

E46_LAT="${E46_LATENCY:-5}/${E46_LATENCY_DIST:-exponential}" python3 -I "$HERE/summarize.py" "$dir" "$name" "$nodes" "$read" "$seed" "$secs" "$nemesis" "$pause" "$compact" "$rate" "$conc" "$code" "$((end - start))" >> "$RUNS/summary.jsonl"
tail -1 "$RUNS/summary.jsonl"
