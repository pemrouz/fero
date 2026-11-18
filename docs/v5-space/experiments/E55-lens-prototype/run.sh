#!/bin/sh
# E-55: the connect lens (LENS.md) as a prototype on data's real engine; every claim of LENS.md section 6 it can run.
#   ./run.sh timing    the timed claims (1, 2, 3, 6, 8, 9, 10, 11, 12, 16, 19, 20, 21-rate, 23), RUNS times each,
#                      each process under the timing lock and preceded by its load average
#   ./run.sh sims      the seeded correctness runs (4, 7, 9, 14, 17, 18, 21) under the heavy lock, then the mutants
#   ./run.sh mutants   only the planted bugs (each must make its seeded run fail), under the heavy lock
#   ./run.sh gc        the collector's own timing (13: Node natural, a browser; 15), under the timing lock
#   ./run.sh types     claims 5 and 24 (tsc 6.0.2 on API.md's declarations; Node, tsc and esbuild import matrix)
#   ./run.sh review-sims | review-timing   the review pass: the seeded runs and the touched timed parts, on the
#                      prototype as changed for the skeptic's findings (results/review-*.jsonl)
#   ./run.sh summary   the tables (node summarize.mjs)
#   ./run.sh           all of the above
# Env: SP (a scratch folder, required), NODE (default node on PATH: Node 22.22.0), RUNS (default "1 2 3"), DATA (data's
# folder, default ../data next to this repo, at 63fea66). Raw JSON lines land in results/.
set -e
HERE=${E55_HERE:-$(cd "$(dirname "$0")" && pwd)} # E55_HERE: the experiment folder, when this script runs from a copy
# SP: a scratch folder of your own, required. It holds bin/timing and bin/heavy (lock wrappers: timing runs its
# command alone on the box, heavy shares it), dl/esbuild (E-40's fetch.sh) and this script's temp files.
: "${SP:?set SP to a scratch folder (it holds bin/timing, bin/heavy and dl/esbuild)}"
export ESBUILD=${ESBUILD:-$SP/dl/esbuild/node_modules/esbuild/bin/esbuild}
export OUT=${OUT:-$SP/e55/imports}
NODE=${NODE:-node}
TIMING=${TIMING:-$SP/bin/timing}
HEAVY=${HEAVY:-$SP/bin/heavy}
RUNS=${RUNS:-1 2 3}
R=$HERE/results
B=$HERE/bench
W=$SP/e55
mkdir -p "$R" "$W"
NODEF="$NODE --expose-gc --experimental-strip-types --no-warnings --max-old-space-size=12000"
NODEN="$NODE --experimental-strip-types --no-warnings --max-old-space-size=12000" # no --expose-gc: natural collection

# one process: its load average first, then its JSON line(s); a failure becomes a line too
one() {
  lock=$1; f=$2; run=$3; shift 3
  printf '{"run":%s,"loadavg":"%s","cmd":"%s"}\n' "$run" "$(cat /proc/loadavg)" "$*" >> "$f"
  (cd "$B" && $lock "$@" >> "$f" 2> "$W/stderr.txt") || printf '{"exp":"E-55","part":"failed","run":%s,"cmd":"%s","stderr":"%s"}\n' "$run" "$*" "$(tail -c 300 "$W/stderr.txt" | tr '\n"' '  ')" >> "$f"
}

timing() {
  for run in $RUNS; do
    T="one $TIMING"
    for n in 1000 100000 1000000; do $T "$R/step.jsonl" $run $NODEF step.mjs $n read; done
    for way in one two kept handle2; do $T "$R/step.jsonl" $run $NODEF step.mjs 100000 mem $way; done
    for n in 10000 100000 1000000; do $T "$R/step.jsonl" $run $NODEF step.mjs $n write; done
    for n in 100000 1000000; do $T "$R/step.jsonl" $run $NODEF stepvariant.mjs $n; done # claim 1 follow-up: four ways to build a step
    $T "$R/connect.jsonl" $run $NODEF connect.mjs setup
    $T "$R/connect.jsonl" $run $NODEF weakprobe.mjs # claim 6 follow-up: a registration made 1 to 10,000 in one job
    E55_ROWS=100000 $T "$R/connect.jsonl" $run $NODEF weakprobe.mjs # the same in a process holding 100,000 rows
    $T "$R/connect.jsonl" $run $NODEF firstprobe.mjs # claim 6 follow-up: a first picture with and without a collection before
    $T "$R/connect.jsonl" $run $NODEF connect.mjs fan
    $T "$R/connect.jsonl" $run $NODEF connect.mjs tap
    $T "$R/connect.jsonl" $run $NODEF connect.mjs weak
    $T "$R/connect.jsonl" $run $NODEF connect.mjs weak work
    $T "$R/gc.jsonl" $run $NODEF gc.mjs forced
    # claim 16: rooms of P rows, S shapes, the view on the server (push) or here (local); big products are skipped
    for ps in "100 1" "100 10" "100 100" "100 1000" "1000 1" "1000 10" "1000 100" "1000 1000" "10000 1" "10000 10" "10000 100" "100000 1" "100000 10"; do
      set -- $ps
      for mode in push local; do $T "$R/pushdown.jsonl" $run $NODEF net.mjs pushdown $1 $2 $mode 2000; done
    done
    for p in 1000 10000 100000; do $T "$R/pushdown.jsonl" $run $NODEF viewprobe.mjs $p; done # claim 16 follow-up: the view alone, data only
    $T "$R/net.jsonl" $run $NODEF net.mjs miss
    # claim 19: depth 2 against flat (+ PA-17's index); 1e6 one-row partitions as one data source each is tried too
    for np in "1000 1" "1000 100" "100000 1" "100000 100" "100000 10000" "1000000 100" "1000000 10000" "1000000 1"; do
      set -- $np
      for way in flat flatidx d2data d2plain flatplain; do $T "$R/depth2.jsonl" $run $NODEF depth2.mjs $way $1 $2; done
    done
    # claim 23: asOf, fat nodes fed from data's prev; 1,000,000 records
    for n in 100000 1000000; do for mode in base fat; do $T "$R/asof.jsonl" $run $NODEF asof.mjs $n $mode; done; done
    HOT=0.15 $T "$R/asof.jsonl" $run $NODEF asof.mjs 1000000 fat
    $T "$R/marks.jsonl" $run $NODEF marks.mjs rate
  done
}

sims() {
  H="one $HEAVY"
  $H "$R/sims.jsonl" 1 $NODEF callspace.mjs
  $H "$R/sims.jsonl" 1 $NODEF sim.mjs picture 1000
  $H "$R/sims.jsonl" 1 $NODEF sim.mjs collector 1000
  $H "$R/sims.jsonl" 1 $NODEF sim.mjs commute 1000
  $H "$R/sims.jsonl" 1 $NODEF net.mjs reconnect 1000
  $H "$R/sims.jsonl" 1 $NODEF net.mjs share
  $H "$R/sims.jsonl" 1 $NODEF connect.mjs share
  for n in 3 5; do $H "$R/sims.jsonl" 1 $NODEF leader.mjs $n; done
  $H "$R/sims.jsonl" 1 $NODEF marks.mjs sim 1000
  mutants
}

mutants() {
  H="one $HEAVY"
  # planted bugs: each must make its run fail (never set in a measured run)
  for m in bornseq settled cover; do E55_MUTATE=$m $H "$R/mutants.jsonl" 1 $NODEF sim.mjs picture 300; done
  E55_MUTATE=floor $H "$R/mutants.jsonl" 1 $NODEF net.mjs reconnect 100
  E55_MUTATE=resend E55_MUTATE_CLIENT=nodedupe $H "$R/mutants.jsonl" 1 $NODEF net.mjs reconnect 100
}

# The review pass (2026-11-18): the prototype was changed for the skeptic's findings (README, "The review").
# Every seeded run again on the changed code, with the new checks and their planted bugs, then the timed parts
# the changes touch. Lines land in results/review-sims.jsonl and results/review-timing.jsonl.
review_sims() {
  F="$R/review-sims.jsonl"; H="one $HEAVY"
  $H "$F" 1 $NODEF callspace.mjs
  $H "$F" 1 $NODEF sim.mjs picture 1000
  $H "$F" 1 $NODEF sim.mjs collector 1000
  (E55_MUTATE=weakread; export E55_MUTATE; $H "$F" 1 $NODEF sim.mjs collector 1000) # control: reads served from weakly held rows
  $H "$F" 1 $NODEF sim.mjs views 1000
  (E55_MUTATE=viewleak; export E55_MUTATE; $H "$F" 1 $NODEF sim.mjs views 300) # control: views outlive their handle
  $H "$F" 1 $NODEF sim.mjs commute 1000
  $H "$F" 1 $NODEF net.mjs reconnect 1000
  $H "$F" 1 $NODEF net.mjs share
  $H "$F" 1 $NODEF connect.mjs share
  for n in 3 5; do $H "$F" 1 $NODEF leader.mjs $n; done
  $H "$F" 1 $NODEF marks.mjs sim 1000 8 60
  $H "$F" 1 $NODEF marks.mjs sim 100 512 4000
  for m in bornseq settled cover; do (E55_MUTATE=$m; export E55_MUTATE; $H "$F" 1 $NODEF sim.mjs picture 300); done
  (E55_MUTATE=floor; export E55_MUTATE; $H "$F" 1 $NODEF net.mjs reconnect 100)
  (E55_MUTATE=resend; E55_MUTATE_CLIENT=nodedupe; export E55_MUTATE E55_MUTATE_CLIENT; $H "$F" 1 $NODEF net.mjs reconnect 100)
}
review_timing() {
  F="$R/review-timing.jsonl"; T="one $TIMING"
  for run in $RUNS; do
    $T "$F" $run $NODEF connect.mjs tap2 # claim 10, the ways interleaved (F5), and the freeze (F15)
    for n in 1000 100000 1000000; do $T "$F" $run $NODEF step.mjs $n read; done # claim 1 on the changed lens
    for n in 10000 100000 1000000; do $T "$F" $run $NODEF step.mjs $n write; done # claim 3
    $T "$F" $run $NODEF connect.mjs fan # claim 8
    $T "$F" $run $NODEF net.mjs miss # claim 20, now lens.get()
  done
}

gcruns() {
  for run in $RUNS; do
    for age in young old; do for mode in idle busy busy-writes; do one $TIMING "$R/natural.jsonl" $run $NODEN gc.mjs natural $age $mode; done; done
    for mode in idle busy busy-writes; do one $TIMING "$R/natural.jsonl" $run $NODE "$HERE/browser/run.mjs" $mode; done
  done
  one $TIMING "$R/gc.jsonl" 1 $NODEF gc.mjs capture
}

types() {
  # API.md section 6's declarations and env.d.ts, extracted exactly as API.md's checker does
  mkdir -p "$HERE/types/out"
  $NODE --input-type=module -e "
import { readFileSync, writeFileSync } from 'node:fs'
const md = readFileSync('$HERE/../../API.md', 'utf8')
for (const [, body, name] of md.matchAll(/\`\`\`ts\n(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)\`\`\`/g)) if (name === 'fero.d.ts' || name === 'env.d.ts') writeFileSync('$HERE/types/out/' + name, body)
"
  TSC=${TSC:-tsc}
  {
    for cfg in tsconfig tsconfig.neg tsconfig.screens; do
      if (cd "$HERE/types" && $TSC -p $cfg.json > "$W/tsc.txt" 2>&1); then e=0; else e=1; fi
      printf '{"exp":"E-55","claim":5,"config":"%s","tsc":"%s","exit":%s,"errors":"%s"}\n' $cfg "$($TSC -v)" $e "$(tr '\n"' '  ' < "$W/tsc.txt" | cut -c1-400)"
    done
    # every @ts-expect-error line in negatives.ts, stripped: each must error for its reason
    sed 's#// @ts-expect-error#// (stripped)#' "$HERE/types/negatives.ts" > "$HERE/types/_stripped.ts"
    echo '{"extends":"./tsconfig.json","files":["out/env.d.ts","env2.d.ts","_stripped.ts"]}' > "$HERE/types/_t.json"
    (cd "$HERE/types" && $TSC -p _t.json > "$W/tsc.txt" 2>&1) || true
    printf '{"exp":"E-55","claim":5,"config":"negatives stripped","errors":"%s"}\n' "$(grep -o '_stripped.ts([0-9]*,[0-9]*): error TS[0-9]*' "$W/tsc.txt" | tr '\n' ' ')"
    # (the first pass also compiled LENS.md P-01's line verbatim: it began with '(' and failed TS2349; LENS.md's
    # line was rewritten after the review, so that step is gone. Its result line stays in results/types.jsonl.)
    rm -f "$HERE/types/_stripped.ts" "$HERE/types/_t.json"
    # typed assignment, retried
    (cd "$HERE/types" && $TSC -p tsconfig.assign.json > "$W/tsc.txt" 2>&1) || true
    printf '{"exp":"E-55","claim":5,"config":"typed assignment","errors":"%s"}\n' "$(grep -o 'assign.ts([0-9]*,[0-9]*): error TS[0-9]*: [^.]*' "$W/tsc.txt" | tr '\n"' '  ')"
    echo '{"extends":"./tsconfig.json","files":["assign-mapped.ts"]}' > "$HERE/types/_t.json"
    (cd "$HERE/types" && $TSC -p _t.json > "$W/tsc.txt" 2>&1) || true; rm -f "$HERE/types/_t.json"
    printf '{"exp":"E-55","claim":5,"config":"typed assignment, mapped accessors","errors":"%s"}\n' "$(grep -o 'error TS[0-9]*: [^.]*' "$W/tsc.txt" | head -2 | tr '\n"' '  ')"
  } >> "$R/types.jsonl"
  NODE=$NODE "$HERE/imports/matrix.sh" >> "$R/imports.jsonl"
  NODE=$SP/dl/node26/node-v26.13.0-linux-x64/bin/node "$HERE/imports/matrix.sh" >> "$R/imports.jsonl" 2>/dev/null || true
}

versions() {
  { $NODE --version; ${TSC:-tsc} -v; (cd "${DATA:-$(cd "$HERE/../../../../.." && pwd)/data}" && git log -1 --format='data %h %cs'); echo "esbuild $($SP/dl/esbuild/node_modules/esbuild/bin/esbuild --version)"; echo "chromium 153.0.8010.12 (Playwright 1.63.0)"; uname -r; nproc; } > "$R/versions.txt"
}

case "$1" in
  timing) versions; timing ;;
  sims) sims ;;
  mutants) mutants ;;
  gc) gcruns ;;
  types) types ;;
  review-sims) review_sims ;;
  review-timing) review_timing ;;
  summary) $NODE "$HERE/summarize.mjs" ;;
  "") versions; types; sims; timing; gcruns; $NODE "$HERE/summarize.mjs" ;;
  *) echo "usage: run.sh [timing|sims|mutants|gc|types|summary|review-sims|review-timing]"; exit 1 ;;
esac
