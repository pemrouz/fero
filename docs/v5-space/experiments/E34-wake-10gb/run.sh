#!/bin/sh
# E-34: can one Node process wake 10 GB of rows to writable within a minute, with GC pauses under 1 s?
#   ./run.sh setup     build the scratch tree; ./gen.sh writes the snapshots (heavy lock)
#   ./run.sh limits    the row ceilings of a Map, an object and a data source (heavy lock)
#   ./run.sh timing    3 runs; each run is two timing holds: the 5e6 small rows, then the ~2 KB rows (10 GB)
#   ./run.sh           all of the above
# Each wake is one process: load (~10-90 s) then 30 s of writes at 10,000 a second. A wake that the kernel
# kills for memory, or that V8 stops at its heap limit, is recorded as such (its exit code and last stderr).
# Env: SP (scratchpad). Snapshots and journals live in $SP/e34; raw JSON lines land in results/.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
W=$SP/e34
export TREE=$W/tree JOURNAL=$W
R=$HERE/results
B=$HERE/bench
mkdir -p "$W" "$R"

# _one <run> <heap MB or default> <script> <args...>: one wake, its load average and free memory first
if [ "$1" = _one ]; then
  run=$2; heap=$3; shift 3
  f="$R/wake.jsonl"
  printf '{"run":%s,"loadavg":"%s","mem_available_mb":%s,"heap":"%s","cmd":"%s","limit_rows":"%s"}\n' "$run" "$(cat /proc/loadavg)" "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)" "$heap" "$*" "${LIMIT_ROWS:-}" >> "$f"
  flag=""; [ "$heap" = default ] || flag="--max-old-space-size=$heap"
  set +e
  node $flag --experimental-strip-types --no-warnings "$@" >> "$f" 2> "$W/stderr.txt"
  code=$?
  set -e
  if [ $code -ne 0 ]; then
    printf '{"exp":"E-34","part":"failed","exit":%s,"heap":"%s","cmd":"%s","limit_rows":"%s","stderr":%s}\n' "$code" "$heap" "$*" "${LIMIT_ROWS:-}" "$(tail -c 400 "$W/stderr.txt" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" >> "$f"
  fi
  exit 0
fi
if [ "$1" = _small ]; then
  run=$2; O="$HERE/run.sh _one $run"
  $O default "$B/wake.mjs" "$W/s5m.snap" small lane
  $O 3072 "$B/wake.mjs" "$W/s5m.snap" small lane
  $O 4096 "$B/wake.mjs" "$W/s5m.snap" small lane
  $O 4096 "$B/wake.mjs" "$W/s5m.snap" small adopt
  $O 4096 "$B/wake-d13.mjs" "$W/s5m.snap" small all
  $O 4096 "$B/wake-d13.mjs" "$W/s5m.snap" small none
  for i in 1 2 3; do
    printf '{"run":%s,"loadavg":"%s","probe":"worker-gc"}\n' "$run" "$(cat /proc/loadavg)" >> "$R/worker-gc.jsonl"
    node "$B/worker-gc.mjs" >> "$R/worker-gc.jsonl"
    OLD=4096 node "$B/worker-gc.mjs" >> "$R/worker-gc.jsonl"
  done
  exit 0
fi
if [ "$1" = _big ]; then
  run=$2; O="$HERE/run.sh _one $run"
  $O 14336 "$B/wake.mjs" "$W/b10g.snap" big lane
  LIMIT_ROWS=2500000 $O 7168 "$B/wake.mjs" "$W/b10g.snap" big lane
  LIMIT_ROWS=2500000 $O 7168 "$B/wake-d13.mjs" "$W/b10g.snap" big all
  $O 4096 "$B/wake-d13.mjs" "$W/b10g.snap" big none
  # how fast this disk reads the 10 GB snapshot back, with whatever the page cache holds after the wakes
  for i in 1 2; do
    printf '{"run":%s,"loadavg":"%s","probe":"dd-read","mem_available_mb":%s}\n' "$run" "$(cat /proc/loadavg)" "$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)" >> "$R/disk-read.jsonl"
    dd if="$W/b10g.snap" of=/dev/null bs=64M 2>&1 | tail -1 | python3 -c 'import json,sys; print(json.dumps({"exp":"E-34","part":"dd-read","file":"b10g.snap","dd":sys.stdin.read().strip()}))' >> "$R/disk-read.jsonl"
  done
  exit 0
fi

setup() {
  "$HERE/tree.sh" "$TREE"
  { cat "$TREE/VERSIONS"; node --version; uname -r; nproc; free -m | head -2; } > "$R/versions.txt"
}
limits() {
  # each case is cut off at 300 s: the object case never reaches its own 150 s check (a block of 1,024 inserts stalls)
  for w in map object source; do
    "$SP/bin/heavy" timeout 300 node --max-old-space-size=8192 --experimental-strip-types --no-warnings "$B/limits.mjs" $w >> "$R/limits.jsonl" ||
      printf '{"exp":"E-34","part":"limits","what":"%s","held":null,"error":"killed by timeout at 300 s"}\n' $w >> "$R/limits.jsonl"
  done
  # the object case never reaches its own cap check, so this probe prints its progress and is stopped at 200 s
  printf '{"exp":"E-34","part":"limits-object-progress","loadavg":"%s","cap_s":200}\n' "$(cat /proc/loadavg)" > "$R/limits-object-progress.jsonl"
  "$SP/bin/heavy" timeout 200 node --max-old-space-size=8192 "$B/limits-object-progress.mjs" >> "$R/limits-object-progress.jsonl" || true
}
timing() {
  for run in ${RUNS:-1 2 3}; do
    "$SP/bin/timing" "$HERE/run.sh" _small $run
    "$SP/bin/timing" "$HERE/run.sh" _big $run
  done
}

case "${1:-all}" in
  setup) setup ;;
  limits) limits ;;
  timing) timing ;;
  all) setup; "$HERE/gen.sh"; limits; timing ;;
  *) echo "usage: run.sh [setup|limits|timing|all]"; exit 1 ;;
esac
