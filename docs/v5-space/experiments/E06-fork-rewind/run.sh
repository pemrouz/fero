#!/bin/sh
# E-06: can data fork and rewind state cheaply enough for fero test?
#   ./run.sh setup     build the scratch tree (fero's seam + data); fetch.sh must have fetched Immutable.js
#   ./run.sh timing    3 runs of every part; one timing hold per run, each process in it well under 60 s
#                      and preceded by its load average
#   ./run.sh           both
# Env: SP (scratchpad), FERO (fero v4 folder), DATA (data folder). Raw JSON lines land in results/.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
W=$SP/e06
export TREE=$W/tree
export IMMUTABLE=${IMMUTABLE:-$SP/dl/immutable/pkg/package/dist/immutable.es.js}
R=$HERE/results
B=$HERE/bench
# 6 GB heap: at 1e6 rows the parent, its view, a fork, a deep copy and an Immutable map are alive at once
# (with the default 2 GB heap, fork.mjs at 1e6 rows died out of memory in the first run)
NODE="node --max-old-space-size=6144 --expose-gc --experimental-strip-types --no-warnings"
mkdir -p "$W" "$R"

if [ "$1" = _one ]; then
  f=$2; run=$3; shift 3
  printf '{"run":%s,"loadavg":"%s","cmd":"%s","samples":"%s"}\n' "$run" "$(cat /proc/loadavg)" "$*" "${SAMPLES:-20}" >> "$f"
  $NODE "$@" >> "$f" 2> "$W/stderr.txt" || printf '{"exp":"E-06","part":"failed","cmd":"%s","stderr":"%s"}\n' "$*" "$(tail -c 300 "$W/stderr.txt" | tr '\n"' '  ')" >> "$f"
  exit 0
fi

setup() {
  "$HERE/tree.sh" "$TREE"
  [ -f "$IMMUTABLE" ] || { echo "run fetch.sh first (Immutable.js missing at $IMMUTABLE)"; exit 1; }
  { cat "$TREE/VERSIONS"; echo "immutable $(node -e "console.log(require('$SP/dl/immutable/pkg/package/package.json').version)")"; node --version; uname -r; nproc; } > "$R/versions.txt"
}

if [ "$1" = _batch ]; then
  run=$2; O="$HERE/run.sh _one"
  for n in ${SIZES:-1000 100000 1000000}; do
    $O "$R/fork.jsonl" $run "$B/fork.mjs" $n
    for k in 100 1000 10000; do
      $O "$R/rewind.jsonl" $run "$B/rewind.mjs" $n snap $k 0
      $O "$R/rewind.jsonl" $run "$B/rewind.mjs" $n imm $k 0
    done
    $O "$R/rewind.jsonl" $run "$B/rewind.mjs" $n immfloor 0 0
    $O "$R/rewind.jsonl" $run "$B/rewind.mjs" $n undo 0 0
    s=20; [ $n -ge 100000 ] && s=5
    SAMPLES=$s $O "$R/rewind.jsonl" $run "$B/rewind.mjs" $n snap 100 1
    $O "$R/rewind.jsonl" $run "$B/rewind.mjs" $n undo 0 1
  done
  exit 0
fi

timing() { for run in ${RUNS:-1 2 3}; do "$SP/bin/timing" "$HERE/run.sh" _batch $run; done; }

case "${1:-all}" in
  setup) setup ;;
  timing) timing ;;
  all) setup; timing ;;
  *) echo "usage: run.sh [setup|timing|all]"; exit 1 ;;
esac
