#!/bin/sh
# E-07: Node's GC pauses with data rows on the main thread, and the cost of a kernel on a worker thread.
#   ./run.sh setup        build the scratch tree (fero's seam + data at HEAD, as E-05 and E-34 did)
#   ./run.sh <block>      one timing hold: gcA | gcB | gcC | cross | stall
#   ./run.sh              setup, then every block (about 30 minutes of the box alone, in five holds)
#   ./run.sh summary      print the tables from results/*.jsonl
# Every process is preceded by a line with the load average. Raw JSON lines land in results/.
# Env: SP (scratchpad), FERO, DATA (see tree.sh), RUNS (default 3).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export TREE=$SP/e07/tree
R=$HERE/results
B=$HERE/bench
RUNS=${RUNS:-3}
NODE="node --expose-gc --experimental-strip-types --no-warnings"
mkdir -p "$R"

one() { # one <out file> <run> <node args...>
  f=$1; run=$2; shift 2
  printf '{"run":%s,"loadavg":"%s","cmd":"%s"}\n' "$run" "$(cat /proc/loadavg)" "$*" >> "$f"
  $NODE "$@" >> "$f" || echo '{"failed":true}' >> "$f"
}

gc_block() { # sizes as "rows:shape:heapMB" ...
  for run in $(seq 1 "$RUNS"); do
    for cfg in "$@"; do
      n=${cfg%%:*}; rest=${cfg#*:}; shape=${rest%%:*}; heap=${rest#*:}
      for rate in 10000 50000; do
        if [ "$heap" = default ]; then [ "$rate" = 10000 ] || continue; one "$R/gc.jsonl" "$run" "$B/gc.mjs" "$n" "$shape" "$rate" 30
        else one "$R/gc.jsonl" "$run" --max-old-space-size="$heap" "$B/gc.mjs" "$n" "$shape" "$rate" 30; fi
      done
    done
  done
}

case "${1:-all}" in
  setup) sh "$HERE/tree.sh" "$TREE"; { cat "$TREE/VERSIONS"; node --version; uname -r; nproc; free -g | head -2; } > "$R/versions.txt" ;;
  _gcA) gc_block 100000:big:8192 1000000:small:8192 ;;
  _gcB) gc_block 1000000:big:8192 ;;
  _gcC) gc_block 5000000:small:8192 5000000:small:default ;;
  _cross)
    for run in $(seq 1 "$RUNS"); do for b in 1 16 256; do for m in transfer sab sab-block clone; do
      one "$R/cross.jsonl" "$run" "$B/cross.mjs" "$m" "$b" 5
    done; done; done ;;
  _stall)
    for run in $(seq 1 "$RUNS"); do for w in worker main; do for k in busy gc; do
      one "$R/stall.jsonl" "$run" "$B/stall.mjs" "$w" "$k" 5000
    done; done; done ;;
  gcA|gcB|gcC|cross|stall) "$SP/bin/timing" sh "$HERE/run.sh" "_$1" ;;
  summary) python3 "$HERE/summarize.py" "$R" ;;
  all) "$HERE/run.sh" setup; for b in gcA gcB gcC cross stall; do "$HERE/run.sh" "$b"; done; "$HERE/run.sh" summary ;;
  *) echo "unknown block $1"; exit 1 ;;
esac
