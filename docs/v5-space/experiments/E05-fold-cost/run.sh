#!/bin/sh
# E-05: what data's fold costs per record, per row of memory, per GB of replay, and to hash.
#   ./run.sh setup     build the scratch tree (fero's seam + data) and write the replay logs (heavy lock)
#   ./run.sh mem       bytes per row, 3 runs (heavy lock, one hold per run: memory is not a speed)
#   ./run.sh timing    3 runs of every timed part; each run is two timing holds (the fold part, then the rest),
#                      each process in them well under 60 s and preceded by its load average
#   ./run.sh           all of the above
# Env: SP (scratchpad), FERO (fero v4 folder), DATA (data folder). Raw JSON lines land in results/.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
W=$SP/e05
export TREE=$W/tree
R=$HERE/results
B=$HERE/bench
NODE="node --expose-gc --experimental-strip-types --no-warnings"
mkdir -p "$W" "$R"

# _one <out file> <run> <script> <args...>: one process inside one lock hold, its load average first
if [ "$1" = _one ]; then
  f=$2; run=$3; shift 3
  printf '{"run":%s,"loadavg":"%s","cmd":"%s"}\n' "$run" "$(cat /proc/loadavg)" "$*" >> "$f"
  $NODE "$@" >> "$f"
  exit 0
fi

setup() {
  "$HERE/tree.sh" "$TREE"
  cp "$TREE/VERSIONS" "$R/versions.txt"
  { node --version; uname -r; nproc; free -g | head -2; } >> "$R/versions.txt"
  "$SP/bin/heavy" $NODE "$B/replay.mjs" make "$W/load1m.log" load1m > "$R/replay-make.jsonl"
  "$SP/bin/heavy" $NODE "$B/replay.mjs" make "$W/mixed1m.log" mixed1m >> "$R/replay-make.jsonl"
  "$SP/bin/heavy" $NODE "$B/replay.mjs" make "$W/load1m.json" load1m json >> "$R/replay-make.jsonl"
}

# _mem <run> and _fold/_rest <run>: the processes of one hold, run one after another inside it
if [ "$1" = _mem ]; then
  run=$2
  for n in 1000 100000 1000000; do
    for v in none group filter100; do "$HERE/run.sh" _one "$R/mem.jsonl" $run "$B/mem.mjs" $n $v seam; done
    "$HERE/run.sh" _one "$R/mem.jsonl" $run "$B/mem.mjs" $n none map
  done
  exit 0
fi
if [ "$1" = _fold ]; then
  run=$2
  for n in 1000 100000 1000000; do
    for v in none group filter100; do for m in rec b256; do "$HERE/run.sh" _one "$R/fold.jsonl" $run "$B/fold.mjs" $n $v $m; done; done
  done
  exit 0
fi
if [ "$1" = _rest ]; then
  run=$2; O="$HERE/run.sh _one"
  for n in 1000 10000 100000 1000000; do $O "$R/group-scale.jsonl" $run "$B/group-scale.mjs" $n; done
  $O "$R/replay.jsonl" $run "$B/replay.mjs" run "$W/load1m.log" none
  $O "$R/replay.jsonl" $run "$B/replay.mjs" run "$W/load1m.log" group
  $O "$R/replay.jsonl" $run "$B/replay.mjs" run "$W/mixed1m.log" none
  $O "$R/replay.jsonl" $run "$B/replay.mjs" run "$W/load1m.json" none json
  for n in 100000 1000000; do
    for w in xx-sum sha-sorted md5-each json-xx encode-only; do $O "$R/hash.jsonl" $run "$B/hash.mjs" $n $w; done
    for f in "compact all" "compact none" "data all"; do $O "$R/d13.jsonl" $run "$B/d13.mjs" $n $f; done
  done
  exit 0
fi

mem() { for run in ${RUNS:-1 2 3}; do "$SP/bin/heavy" "$HERE/run.sh" _mem $run; done; }
timing() {
  for run in ${RUNS:-1 2 3}; do
    "$SP/bin/timing" "$HERE/run.sh" _fold $run
    "$SP/bin/timing" "$HERE/run.sh" _rest $run
  done
}

case "${1:-all}" in
  setup) setup ;;
  mem) mem ;;
  timing) timing ;;
  all) setup; mem; timing ;;
  *) echo "usage: run.sh [setup|mem|timing|all]"; exit 1 ;;
esac
