#!/bin/sh
# E-34: write the two snapshots (heavy lock): 5e6 small rows (~0.6 GB) and 5e6 ~2 KB rows (~10 GB), in $SP/e34.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export TREE=$SP/e34/tree
NODE="node --experimental-strip-types --no-warnings"
[ -f "$SP/e34/s5m.snap" ] || "$SP/bin/heavy" $NODE "$HERE/bench/gen.mjs" "$SP/e34/s5m.snap" 5000000 small >> "$HERE/results/gen.jsonl"
[ -f "$SP/e34/b10g.snap" ] || "$SP/bin/heavy" $NODE "$HERE/bench/gen.mjs" "$SP/e34/b10g.snap" 5000000 big >> "$HERE/results/gen.jsonl"
