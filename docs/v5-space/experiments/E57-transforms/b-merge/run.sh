#!/bin/sh
# E-57 group B (b-merge): transformations across partitions, resources and time, built small on data's real
# engine (data at 63fea66, read only). Every claim of this part's README, from a clean checkout.
#   ./run.sh sims      the seeded correctness runs and their planted bugs, under the heavy lock
#   ./run.sh timing    the timed costs, RUNS times each, each process alone under the timing lock
#   ./run.sh model     B5: E-30's model extended (Python 3), under the heavy lock
#   ./run.sh           all of the above
#   ./run.sh <name>    one part: b1 b1m b2 b3 b4 b6 xb pure t-b1 t-b2 t-b3 t-b4 t-b6 t-xb1 t-xb4 model
# Env: SP (a scratch folder, required: it holds bin/timing, bin/heavy and dl/esbuild, as E-55's run.sh), NODE
# (default node on PATH: Node 22.22.0), DATA (data's folder, default ../data next to this repo),
# RUNS (default "1 2 3"), SEEDS (default 1000). Raw JSON lines land in results/.
set -e
HERE=${E57B_HERE:-$(cd "$(dirname "$0")" && pwd)} # E57B_HERE: this folder, when the script runs from a copy
: "${SP:?set SP to a scratch folder (it holds bin/timing, bin/heavy and dl/esbuild)}"
NODE=${NODE:-node}
DATA=${DATA:-$(cd "$HERE/../../../../../.." && pwd)/data}
TIMING=${TIMING:-$SP/bin/timing}
HEAVY=${HEAVY:-$SP/bin/heavy}
RUNS=${RUNS:-1 2 3}
SEEDS=${SEEDS:-1000}
ESBUILD=${ESBUILD:-$SP/dl/esbuild/node_modules/esbuild/bin/esbuild}
export OUT=${OUT:-$SP/e57/b-merge}
R=$HERE/results
mkdir -p "$R" "$OUT"
# every process stays under 4 GB (the box has 15 GB, no swap, and another study beside this one)
NODEF="$NODE --expose-gc --no-warnings --max-old-space-size=3500"

# data's public API, bundled once (esbuild, ESM, for Node), plus SourceNode for the cost benches.
# --ignore-annotations: data's package.json marks only dist/ops/*.js as having side effects, so a bundle of the
# source drops the side-effect imports of ops/setops.ts, ops/bucket.ts and ops/quantile.ts (group, the set
# operators and the quantiles vanish, and `median` throws "reserved name ... has no implementation yet").
bundle() {
  printf "export * from '%s/api/index.ts'\nexport { SourceNode, leafAt } from '%s/kernel/node.ts'\n" "$DATA" "$DATA" > "$OUT/entry.ts"
  $ESBUILD "$OUT/entry.ts" --bundle --format=esm --platform=node --ignore-annotations --outfile="$OUT/data.tmp.mjs" --log-level=warning
  mv "$OUT/data.tmp.mjs" "$OUT/data.mjs" # atomic: a run that starts meanwhile never reads half a file
}

# one process: its load average first, then its JSON line(s); a failure becomes a line too
one() {
  lock=$1; f=$2; run=$3; shift 3
  printf '{"run":%s,"loadavg":"%s","cmd":"%s"}\n' "$run" "$(cat /proc/loadavg)" "$*" >> "$f"
  (cd "$HERE" && $lock "$@" >> "$f" 2> "$OUT/stderr.txt") || printf '{"exp":"E-57","part":"failed","run":%s,"cmd":"%s","stderr":"%s"}\n' "$run" "$*" "$(tail -c 300 "$OUT/stderr.txt" | tr '\n"' '  ')" >> "$f"
}

b1() { # B1: 1e5 commits per configuration, two stores each, every view checked after every entry
  for g in ${B1G:-1 4 16 elastic}; do one "$HEAVY" "$R/b1.jsonl" 1 $NODEF sim/b1-store.mjs --groups=$g --commits=100000 --keys=3000 --seed=1; done
}
b1m() { # B1's planted bugs against the same 1,000 short seeds the real code passes (G = 4 and elastic)
  for g in 4 elastic; do
    for m in "" r2 r1 ties; do one "$HEAVY" "$R/b1-seeds.jsonl" 1 $NODEF sim/b1-store.mjs --groups=$g --seeds=$SEEDS --commits=400 --keys=300 --sync=200 --mutate=$m; done
  done
}

b2() { # B2 and XB-7 (the new operators, page joins, paging across cuts), then their planted bugs
  one "$HEAVY" "$R/b2.jsonl" 1 $NODEF sim/b2-ops.mjs $SEEDS 300 120
  for m in cursor keepempty; do (MUTATE=$m; export MUTATE; one "$HEAVY" "$R/b2.jsonl" 1 $NODEF sim/b2-ops.mjs $SEEDS 300 120); done
}
b3() { # B3, XB-8, XB-9, XB-10: the full design, the plan as written, and the planted bugs
  one "$HEAVY" "$R/b3.jsonl" 1 $NODEF sim/b3-derive.mjs $SEEDS 600
  (PLAN=1; export PLAN; one "$HEAVY" "$R/b3.jsonl" 1 $NODEF sim/b3-derive.mjs $SEEDS 600)
  for m in nofence noremove nobump nobarrier noversion; do (MUTATE=$m; export MUTATE; one "$HEAVY" "$R/b3.jsonl" 1 $NODEF sim/b3-derive.mjs $SEEDS 600); done
}
b4() { # B4, XB-11
  one "$HEAVY" "$R/b4.jsonl" 1 $NODEF sim/b4-lookup.mjs $SEEDS 400
  for m in reverse count undef; do (MUTATE=$m; export MUTATE; one "$HEAVY" "$R/b4.jsonl" 1 $NODEF sim/b4-lookup.mjs $SEEDS 400); done
}
b6() { # B6, XB-12
  one "$HEAVY" "$R/b6.jsonl" 1 $NODEF sim/b6-past.mjs $SEEDS 120
  for m in byrecord noseek newest; do (MUTATE=$m; export MUTATE; one "$HEAVY" "$R/b6.jsonl" 1 $NODEF sim/b6-past.mjs $SEEDS 120); done
}
xb() { # the pure-oracle claims (XB-2, 3, 5, 6, 13), XB-1's index oracle and XB-4's exact sum, each with its planted bug
  for c in "XB-2 " "XB-2 reverse" "XB-2 utf8" "XB-3 " "XB-3 plus" "XB-5 " "XB-5 string" "XB-6 " "XB-6 rowkey" "XB-13 " "XB-13 arrival"; do
    set -- $c
    (MUTATE=${2:-}; export MUTATE; one "$HEAVY" "$R/xb.jsonl" 1 $NODEF sim/xb-pure.mjs $1 $SEEDS 200)
  done
  one "$HEAVY" "$R/xb.jsonl" 1 $NODEF sim/xb1-index.mjs $SEEDS 200 2000
  (MUTATE=prev; export MUTATE; one "$HEAVY" "$R/xb.jsonl" 1 $NODEF sim/xb1-index.mjs $SEEDS 200 2000)
  one "$HEAVY" "$R/xb.jsonl" 1 $NODEF sim/xb4-exactsum.mjs $SEEDS 1000
  (E23SUM=1; export E23SUM; one "$HEAVY" "$R/xb.jsonl" 1 $NODEF sim/xb4-exactsum.mjs $SEEDS 1000)
}
timing() { # every timed number: RUNS runs, each process alone under the timing lock
  T="one $TIMING"
  for run in $RUNS; do
    for n in 10000 100000 1000000; do $T "$R/timing.jsonl" $run $NODEF bench/xb1-cost.mjs $n; done
    for p in feed diff views; do $T "$R/timing.jsonl" $run $NODEF bench/b1-cost.mjs $p; done
    for n in 10000 100000 1000000; do $T "$R/timing.jsonl" $run $NODEF bench/costs.mjs by $n; done
    for p in derive lookup sum; do $T "$R/timing.jsonl" $run $NODEF bench/costs.mjs $p; done
    for m in 10000 100000; do $T "$R/timing.jsonl" $run $NODEF bench/costs.mjs past $m; done
  done
}
model() { # B5 (no bytecode caches left in E-30, E-20 or this folder)
  export PYTHONDONTWRITEBYTECODE=1
  : # B5: E-30's model extended, on E-16's engine (Python 3); every bound, the planted bug, the ablation
  CLI=$HERE/../../E16-controller-loop/engine/cli.py
  { echo "# E-57 B5 model runs, $(date -u +%FT%TZ), $(python3 --version), load $(cut -d' ' -f1-3 /proc/loadavg)"
    $HEAVY timeout 1500 python3 "$CLI" "$HERE/models/derived2.py" srchi-slot-w --all-fails --limit 1500000
    echo "## planted: the mark without the write's number (E-30's srchi-slot as it is)"
    $HEAVY timeout 1500 python3 "$CLI" "$HERE/models/derived2.py" srchi-slot --bound two-short --bound two-gcrash --bound two-drop --bound two-deep --bound two-bmove
    echo "## the order rule dropped"
    $HEAVY timeout 1500 python3 "$CLI" "$HERE/models/derived2.py" srchi-slot-w --drop emit.inorder --bound two-short --bound two-deep --bound two-bmove
  } > "$R/b5-model.txt" 2>&1 || true
  # the full DEV-10 ablation can take most of an hour; the first pass stopped it so the timed runs could finish (README, B5)
  $HEAVY timeout 3000 python3 "$CLI" "$HERE/models/derived2.py" srchi-slot-w --ablate "$R/b5-ablation.json" > "$R/b5-ablation.txt" 2>&1 || true
  $HEAVY $NODE --expose-gc bench/b5-mark.mjs >> "$R/b5-model.txt" 2>&1 || true
}
versions() {
  { $NODE --version; (cd "$DATA" && git log -1 --format='data %h %cs'); echo "esbuild $($ESBUILD --version)"; python3 --version; uname -r; nproc; } > "$R/versions.txt"
}

case "$1" in
  bundle) bundle ;;
  b1|b1m|b2|b3|b4|b6|xb|timing|model) bundle; $1 ;;
  sims) bundle; versions; b1; b1m; b2; b3; b4; b6; xb ;;
  "") bundle; versions; b1; b1m; b2; b3; b4; b6; xb; model; timing ;;
  *) echo "usage: run.sh [sims|timing|model|b1|b1m|b2|b3|b4|b6|xb]"; exit 1 ;;
esac
