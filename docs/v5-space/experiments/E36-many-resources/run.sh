#!/bin/sh
# E-36: the #meta and per-slot model (bytes exact, memory measured in Node; not timing), and the create/open
# latencies, which come from E-26's lifecycle runs (../E26-dormant-groups, run there under $SP/bin/timing).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$HERE/results"
node --expose-gc "$HERE/meta_model.mjs" > "$HERE/results/meta_model.json"
[ -s "$HERE/../E26-dormant-groups/results/lifecycle.jsonl" ] || sh "$HERE/../E26-dormant-groups/run.sh" time
python3 "$HERE/../E26-dormant-groups/summarize.py"
