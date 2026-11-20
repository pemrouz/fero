#!/bin/sh
# E-56 positions: what commit ids, hash chains and hash trees (Merkle trees) would cost fero v5.
#   ./run.sh timing    the timed parts, RUNS times each, every process under the timing lock and preceded by
#                      its load average:
#                        hash.mjs    hashing one commit's records (crc32, xxHash32, SHA-256, a hash chain)
#                        tree.mjs    keeping a hash structure over a partition's rows, per write, and its bytes a row
#                        resume.mjs  a resume after compaction, 100 B rows: bytes, round trips, CPU
#   ./run.sh heavy     resume.mjs with 1 KB rows, bytes and round trips only (deterministic), and textform.mjs
#                      (what a version and a cursor look like as text; 1,000,000 order checks), under the heavy lock
#   ./run.sh summary   the tables (node summarize.mjs), written to results/tables.md
#   ./run.sh clean     remove the results; timing and heavy append, so a partial rerun adds to what is there
#   ./run.sh           clean, then all of the above
# Env: SP (a scratch folder, required: it holds bin/timing and bin/heavy, the lock wrappers; timing runs its
# command alone on the box, heavy shares it), NODE (default node on PATH: Node 22.22.0), RUNS (default
# "1 2 3"), NODEF (the node command with its flags; default NODE with a 4,000 MB heap cap). Nothing is downloaded and nothing outside this folder is written but $SP/e56pos. The benches import
# E-05's xxHash32 (../../E05-fold-cost/bench/xxh.mjs), which checks itself against xxHash's reference vectors.
# Raw JSON lines land in results/.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
: "${SP:?set SP to a scratch folder (it holds bin/timing and bin/heavy)}"
NODE=${NODE:-node}
TIMING=${TIMING:-$SP/bin/timing}
HEAVY=${HEAVY:-$SP/bin/heavy}
RUNS=${RUNS:-1 2 3}
R=$HERE/results
B=$HERE/bench
W=$SP/e56pos
mkdir -p "$R" "$W"
# every node process stays under 4 GB of heap (the box has 15 GB and no swap); NODEF overrides the whole command
NODEF=${NODEF:-"$NODE --expose-gc --no-warnings --max-old-space-size=4000"}

# one process: its load average first, then its JSON line(s); a failure becomes a line too
one() {
  lock=$1; f=$2; run=$3; shift 3
  printf '{"run":%s,"loadavg":"%s","cmd":"%s"}\n' "$run" "$(cat /proc/loadavg)" "$*" >> "$f"
  if (cd "$B" && $lock "$@" > "$W/out.txt" 2> "$W/stderr.txt"); then sed "s/^{/{\"run\":$run,/" "$W/out.txt" >> "$f"
  else printf '{"exp":"E-56","part":"failed","run":%s,"cmd":"%s","stderr":"%s"}\n' "$run" "$*" "$(tail -c 300 "$W/stderr.txt" | tr '\n"' '  ')" >> "$f"; fi
}

# the changed rows k for n rows: 1, 100 and a tenth of n, each once (at 1,000 rows a tenth is 100)
ks() { printf '%s\n' 1 100 $(($1 / 10)) | sort -nu; }

timing() {
  for run in $RUNS; do
    T="one $TIMING"
    $T "$R/hash.jsonl" $run $NODEF hash.mjs
    for n in 1000 100000 1000000; do
      for way in base ver rowhash sum sumkept mkver mkverb mkleaf mkrow mksha; do $T "$R/tree.jsonl" $run $NODEF tree.mjs $n $way; done
    done
    for n in 1000 100000 1000000; do
      for k in $(ks $n); do $T "$R/resume.jsonl" $run $NODEF resume.mjs $n $k 100; done
    done
  done
}

heavy() {
  one "$HEAVY" "$R/textform.jsonl" 1 $NODEF textform.mjs
  for n in 1000 100000 1000000; do
    for k in $(ks $n); do one "$HEAVY" "$R/resume-1k.jsonl" 1 $NODEF resume.mjs $n $k 1000; done
  done
}

versions() {
  { $NODE --version; uname -r; nproc; free -g | head -2 | tail -1; } > "$R/versions.txt"
}

# a fresh start: results from an earlier, unfinished run are never mixed in
clean() { rm -f "$R"/hash.jsonl "$R"/tree.jsonl "$R"/resume.jsonl "$R"/resume-1k.jsonl "$R"/textform.jsonl "$R"/tables.md; }

case "$1" in
  clean) clean ;;
  timing) versions; timing ;;
  heavy) heavy ;;
  summary) $NODE "$HERE/summarize.mjs" > "$R/tables.md"; cat "$R/tables.md" ;;
  "") clean; versions; timing; heavy; $NODE "$HERE/summarize.mjs" > "$R/tables.md" ;;
  *) echo "usage: run.sh [clean|timing|heavy|summary]"; exit 1 ;;
esac
