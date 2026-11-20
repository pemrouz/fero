#!/bin/sh
# E-57 group A: served views (class C) and pushdown (class B), built small on data's real engine and E-55's prototype.
#   ./run.sh sims      the seeded runs (A1-A8, XA-2, XA-7, XA-8, XA-9, XA-10, XA-12, XA-13), 1,000 seeds each, under the heavy lock
#   ./run.sh mutants   the planted bugs: each must make its seeded run fail in at least 100 of 1,000 seeds
#   ./run.sh timing    the timed costs, RUNS times each, every process alone under the timing lock
#   ./run.sh types     XA-11: tsc on a view context that has no second resource
#   ./run.sh summary   the tables (node summarize.mjs)
#   ./run.sh           all of the above
# Env: SP (a scratch folder, required: it holds bin/timing and bin/heavy), NODE (default node on PATH: Node
# 22.22.0), RUNS (default "1 2 3"), DATA (data's folder, default ../data next to this repo, at 63fea66, read only).
# data is imported from its TypeScript source with Node's type stripping, as E-55's prototype does (no bundle).
# Every process runs with --max-old-space-size=3000 (the box has 15 GB and no swap; nothing here needs more).
set -e
unset E57_MUTATE
HERE=$(cd "$(dirname "$0")" && pwd)
: "${SP:?set SP to a scratch folder (it holds bin/timing and bin/heavy)}"
NODE=${NODE:-node}
TIMING=${TIMING:-$SP/bin/timing}
HEAVY=${HEAVY:-$SP/bin/heavy}
RUNS=${RUNS:-1 2 3}
SEEDS=${SEEDS:-1000}
R=$HERE/results
W=$SP/e57/a-served
mkdir -p "$R" "$W"
export NODE
export ERRDIR=$W # a process's stderr goes to the scratch folder

# each batch holds its lock once: the seeded runs under the heavy lock; each timed run under the timing lock, so every
# timed process runs alone on the box (batch.sh lists the processes)
sims() { $HEAVY "$HERE/batch.sh" sims "$R/sims.jsonl" 1 $SEEDS; }
mutants() { $HEAVY "$HERE/batch.sh" mutants "$R/mutants.jsonl" 1 $SEEDS; }
timing() { for run in $RUNS; do $TIMING "$HERE/batch.sh" timing "$R/timing.jsonl" $run; done; }

types() {
  TSC=${TSC:-tsc}
  { if (cd "$HERE/types" && $TSC -p tsconfig.json > "$W/tsc.txt" 2>&1); then e=0; else e=1; fi
    printf '{"exp":"E-57","claim":"XA-11","tsc":"%s","exit":%s,"errors":"%s"}\n' "$($TSC -v)" $e "$(tr '\n"' '  ' < "$W/tsc.txt" | cut -c1-600)"
    sed 's#// @ts-expect-error#// (stripped)#' "$HERE/types/view.ts" > "$HERE/types/_stripped.ts"
    echo '{"extends":"./tsconfig.json","files":["_stripped.ts"]}' > "$HERE/types/_t.json"
    (cd "$HERE/types" && $TSC -p _t.json > "$W/tsc.txt" 2>&1) || true
    printf '{"exp":"E-57","claim":"XA-11","config":"expect-error lines stripped","errors":"%s"}\n' "$(grep -o '_stripped.ts([0-9]*,[0-9]*): error TS[0-9]*' "$W/tsc.txt" | tr '\n' ' ')"
    rm -f "$HERE/types/_stripped.ts" "$HERE/types/_t.json"
  } >> "$R/types.jsonl"
}

versions() {
  { $NODE --version; ${TSC:-tsc} -v; (cd "${DATA:-$(cd "$HERE/../../../../../.." && pwd)/data}" && git log -1 --format='data %h %cs'); uname -r; nproc; } > "$R/versions.txt"
}

case "$1" in
  sims) versions; sims ;;
  mutants) mutants ;;
  timing) versions; timing ;;
  types) types ;;
  summary) $NODE "$HERE/summarize.mjs" ;;
  "") versions; types; sims; mutants; timing; $NODE "$HERE/summarize.mjs" ;;
  *) echo "usage: run.sh [sims|mutants|timing|types|summary]"; exit 1 ;;
esac
