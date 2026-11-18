#!/bin/sh
# E-54: step through a resource's versions on top of its log: which structure, and what it costs the write path.
#   ./run.sh setup     the scratch tree (E-06's tree.sh: fero's seam + data), the Rust build; fetch.sh first
#   ./run.sh timing    3 runs; one timing hold per run; every process preceded by its load average
#   ./run.sh hot       3 runs of fat nodes with one hot row (HOT=0.1: a tenth of all writes go to one row)
#   ./run.sh hamtstore the review's follow-up: a HAMT store that keeps only its newest root, against a Map
#   ./run.sh summary   the tables (python3 summarize.py)
#   ./run.sh           setup, timing, hot, summary
# Env: SP (a scratch folder, required), NODE (default node on PATH), RUNS (default "1 2 3"), SIZES (default
# "100000 1000000"). Raw JSON lines land in results/.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
# SP: a scratch folder of your own (the build tree and the Rust target go there). It must hold bin/timing (a
# lock wrapper that runs its command alone on the box) and dl/ (fetch.sh). No default: a build never lands in the repo.
: "${SP:?set SP to a scratch folder (it holds bin/timing, dl/ and the build tree)}"
W=$SP/e54
export TREE=$W/tree
export IMMUTABLE=${IMMUTABLE:-$SP/dl/immutable/pkg/package/dist/immutable.es.js}
NODE=${NODE:-node}
RUST=$W/target/release/e54
R=$HERE/results
B=$HERE/bench
# 10 GiB heap: checkpoints every 10,000 records of 1e6 rows hold about 4 GB, Immutable.js roots about 3 GB
NODEF="$NODE --max-old-space-size=10240 --expose-gc --experimental-strip-types --no-warnings"
mkdir -p "$W" "$R"

if [ "$1" = _one ]; then
  f=$2; run=$3; shift 3
  printf '{"run":%s,"loadavg":"%s","cmd":"%s"}\n' "$run" "$(cat /proc/loadavg)" "$*" >> "$f"
  "$@" >> "$f" 2> "$W/stderr.txt" || printf '{"exp":"E-54","part":"failed","run":%s,"cmd":"%s","stderr":"%s"}\n' "$run" "$*" "$(tail -c 300 "$W/stderr.txt" | tr '\n"' '  ')" >> "$f"
  exit 0
fi

setup() {
  "$HERE/../E06-fork-rewind/tree.sh" "$TREE"
  [ -f "$IMMUTABLE" ] || { echo "run fetch.sh first (Immutable.js missing at $IMMUTABLE)"; exit 1; }
  (cd "$HERE/rust" && CARGO_TARGET_DIR=$W/target cargo build --release --locked)
  { cat "$TREE/VERSIONS"; echo "immutable 5.1.9"; grep -A1 -E '^name = "(im|imbl|rpds)"$' "$HERE/rust/Cargo.lock" | paste - - - | sed 's/name = //; s/version = //; s/"//g; s/--//'; $NODE --version; rustc --version; uname -r; nproc; } > "$R/versions.txt"
}

if [ "$1" = _batch ]; then
  run=$2; O="$HERE/run.sh _one"
  for n in ${SIZES:-100000 1000000}; do
    for way in base rev revleaf diff imm hamt fat fatlog; do $O "$R/structs.jsonl" $run $NODEF "$B/structs.mjs" $n $way; done
    for k in 1000 10000; do
      # 1,000 copies of a 1e6-row Map do not fit this box (about 28 GB at E-54's measured size per copy)
      [ $n -ge 1000000 ] && [ $k -lt 10000 ] && continue
      $O "$R/structs.jsonl" $run $NODEF "$B/structs.mjs" $n ckpt $k
    done
    for mode in base sink prev prev256; do $O "$R/live.jsonl" $run $NODEF "$B/live.mjs" $n $mode; done
    [ "$run" = 1 ] && $O "$R/live.jsonl" $run $NODEF "$B/live.mjs" $n bytes
    for way in base rev im imbl rpds; do $O "$R/rust.jsonl" $run "$RUST" $n $way 1000000; done
  done
  exit 0
fi

if [ "$1" = _hot ]; then
  run=$2; O="$HERE/run.sh _one"
  for way in fat fatlog; do HOT=0.1 $O "$R/hot.jsonl" $run $NODEF "$B/structs.mjs" 1000000 $way; done
  exit 0
fi

if [ "$1" = _hamtstore ]; then
  run=$2; O="$HERE/run.sh _one"
  for n in ${SIZES:-100000 1000000}; do for way in map hamt-latest hamt-all; do $O "$R/hamtstore.jsonl" $run $NODEF "$B/hamtstore.mjs" $n $way; done; done
  exit 0
fi

# the review's follow-up: a HAMT as a STORE (only the newest root kept) against a Map; hamt-all keeps every root
hamtstore() { for run in ${RUNS:-1 2 3}; do "$SP/bin/timing" "$HERE/run.sh" _hamtstore $run; done; }
timing() { for run in ${RUNS:-1 2 3}; do "$SP/bin/timing" "$HERE/run.sh" _batch $run; done; }
hot() { for run in ${RUNS:-1 2 3}; do "$SP/bin/timing" "$HERE/run.sh" _hot $run; done; }

case "${1:-all}" in
  setup) setup ;;
  timing) timing ;;
  hot) hot ;;
  hamtstore) hamtstore ;;
  summary) python3 "$HERE/summarize.py" ;;
  all) setup; timing; hot; python3 "$HERE/summarize.py" ;;
  *) echo "usage: run.sh [setup|timing|hot|hamtstore|summary|all]"; exit 1 ;;
esac
