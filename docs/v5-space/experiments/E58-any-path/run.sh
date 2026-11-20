#!/bin/sh
# E-58: writes at any path, and readers of any part, on data's real engine (E-55's prototype store on top).
#   ./run.sh sims      the seeded runs, 1,000 seeds each, under the heavy lock: parts 1 and 2 (oracle, depth 1 and 2,
#                      main, shape, edge and merge), part 3 (split), part 4 (filter), part 5 (versions at three shares)
#   ./run.sh mutants   the planted bugs: each must make its run fail in at least 100 of 1,000 seeds
#   ./run.sh timing    T1 (a room replaced as one batch or row by row) and T2 (what data's read rule costs a field
#                      link), RUNS times each, every process alone under the timing lock
#   ./run.sh probes    the two small probes (data v2 from the published package, fetched with npm; three edges of
#                      data v4's reader): results/probes.txt
#   ./run.sh review    only the runs added after the review, appended: oracle main again (with the client's counts),
#                      edge and merge at depth 1 and 2; two planted bugs in merge mode; the probes
#   ./run.sh quick     every seeded run and planted bug at 100 seeds, into $OUT/quick only (results/ is not touched),
#                      then a summary there: a check that everything still runs, not a result
#   ./run.sh summary   results/summary.md from the raw lines (node summarize.mjs)
#   ./run.sh clean     remove the raw lines; the other modes append
#   ./run.sh           clean, then all of the above but quick
# Env: SP (required: a scratch folder of your own that holds the lock helpers bin/timing and bin/heavy), NODE (default
# node on PATH: Node 22.22.0), RUNS (default "1 2 3"), SEEDS (default 1000), DATA (data's folder, read only;
# default ../data next to this repo, at 63fea66; E-55's lens.mjs reads it), OUT (temp files; default $SP/e58).
# data is imported from its TypeScript source with Node's type stripping, as E-55's prototype does. Every process runs
# with a 3,000 MB heap cap (the box has 15 GB and no swap; nothing here needs more than about 100 MB).
set -e
unset E58_MUTATE
HERE=$(cd "$(dirname "$0")" && pwd)
: "${SP:?set SP to a scratch folder (it holds bin/timing and bin/heavy)}"
NODE=${NODE:-node}
TIMING=${TIMING:-$SP/bin/timing}
HEAVY=${HEAVY:-$SP/bin/heavy}
RUNS=${RUNS:-1 2 3}
SEEDS=${SEEDS:-1000}
OUT=${OUT:-$SP/e58}
R=$HERE/results
[ "$1" = quick ] && { R=$OUT/quick; SEEDS=100; rm -rf "$R"; }
mkdir -p "$R"
[ "$1" = summary ] || mkdir -p "$OUT"
export DATA=${DATA:-$(cd "$HERE/../../../../.." && pwd)/data}
NODEF="$NODE --expose-gc --experimental-strip-types --no-warnings --max-old-space-size=3000"

# one process: its load average and command first, then its JSON line; a failure becomes a line too
one() {
  lock=$1; f=$2; dir=$3; m=$4; run=$5; shift 5
  printf '{"run":%s,"loadavg":"%s","cmd":"%s","mutate":"%s"}\n' "$run" "$(cat /proc/loadavg)" "$*" "$m" >> "$f"
  (cd "$HERE/$dir" && E58_MUTATE=$m $lock $NODEF "$@" >> "$f" 2> "$OUT/stderr.txt") || printf '{"exp":"E-58","part":"failed","run":%s,"cmd":"%s","stderr":"%s"}\n' "$run" "$*" "$(tail -c 300 "$OUT/stderr.txt" | tr '\n"' '  ')" >> "$f"
}

sims() {
  F="$R/sims.jsonl"
  for d in 1 2; do for m in main shape edge merge; do one "$HEAVY" "$F" sim "" 1 run.mjs oracle $d $SEEDS $m; done; done
  one "$HEAVY" "$F" sim "" 1 run.mjs split $SEEDS
  one "$HEAVY" "$F" sim "" 1 run.mjs filter $SEEDS
  for s in 0.2 0.5 0.8; do one "$HEAVY" "$F" sim "" 1 run.mjs versions $SEEDS $s; done
}

mutants() {
  F="$R/mutants.jsonl"
  for d in 1 2; do for m in rowmerge inplace under prev nearbeside wirefield; do one "$HEAVY" "$F" sim $m 1 run.mjs oracle $d $SEEDS main; done; done
  one "$HEAVY" "$F" sim splitrows 1 run.mjs split $SEEDS
  one "$HEAVY" "$F" sim prevrow 1 run.mjs filter $SEEDS
  one "$HEAVY" "$F" sim noancestor 1 run.mjs versions $SEEDS 0.5
  for m in prev wirefield; do one "$HEAVY" "$F" sim $m 1 run.mjs oracle 1 $SEEDS merge; done
}

# the runs added after the review (appended; the first lines stay): main again, now with the client's counts, which
# must give every earlier counter unchanged; the edge and merge modes; two planted bugs in merge mode
review() {
  F="$R/sims.jsonl"
  for d in 1 2; do for m in main edge merge; do one "$HEAVY" "$F" sim "" 1 run.mjs oracle $d $SEEDS $m; done; done
  F="$R/mutants.jsonl"
  for m in prev wirefield; do one "$HEAVY" "$F" sim $m 1 run.mjs oracle 1 $SEEDS merge; done
}

probes() {
  P="$R/probes.txt"
  mkdir -p "$OUT/data2" && (cd "$OUT/data2" && [ -f data-2.0.0.tgz ] || npm pack data@2.0.0 --pack-destination . >/dev/null 2>&1) && tar -xzf "$OUT/data2/data-2.0.0.tgz" -C "$OUT/data2"
  { echo "# E-58 probes: $(date -u +%F), $($NODE --version)"; echo; echo "## data v2 (data@2.0.0, sha256 $(sha256sum "$OUT/data2/data-2.0.0.tgz" | cut -c1-16)...)"; echo
    (cd "$HERE/probes" && $HEAVY $NODEF data-v2.mjs "$OUT/data2/package/dist/index.js"); echo
    echo "## data v4 at $(cd "$DATA" && git log -1 --format=%h): three edges of the per-path reader"; echo
    (cd "$HERE/probes" && $HEAVY $NODEF data-edges.mjs); } > "$P"
}

timing() {
  F="$R/timing.jsonl"
  for run in $RUNS; do
    for n in 10 100 1000; do one "$TIMING" "$F" bench "" $run replace.mjs $n; done
    for n in 10 100; do one "$TIMING" "$F" bench "" $run rule.mjs $n; done
  done
}

versions() {
  { $NODE --version; (cd "$DATA" && git log -1 --format='data %h %cs'); uname -r; nproc; } > "$R/versions.txt"
}

clean() { rm -f "$R"/sims.jsonl "$R"/mutants.jsonl "$R"/timing.jsonl "$R"/summary.md "$R"/probes.txt; }

case "$1" in
  sims) versions; sims ;;
  review) versions; review; probes ;;
  probes) probes ;;
  quick) sims; mutants; $NODE "$HERE/summarize.mjs" "$R" > /dev/null; grep -h '"failedSeeds"' "$R"/*.jsonl | sed 's/"stats".*//' ; echo "quick: $R/summary.md" ;;
  mutants) mutants ;;
  timing) versions; timing ;;
  summary) $NODE "$HERE/summarize.mjs" ;;
  clean) clean ;;
  "") clean; versions; sims; mutants; timing; probes; $NODE "$HERE/summarize.mjs" ;;
  *) echo "usage: run.sh [clean|sims|mutants|timing|probes|review|quick|summary]"; exit 1 ;;
esac
