#!/bin/sh
# E-65: work over every row, past a fixed row ceiling. Each part has its own run.sh; this one calls them.
#   X1/  the asker's own memory budget; stores by block or by group; compact stores; worker threads; a sorted column
#   X2/  scan(): every row once, in pages, from one copy of each group, at one cut
#   X3/  live folds per group: the server's author writes emit and combine, a merger adds the pieces
#   X4/  a histogram per group for medians and quantiles; a band of exact values for an exact answer
#   X5/  a slot sample with intervals; clients that merge; the other ways, reasoned
#   probes/  added after the skeptic: each live view's cost on a big hold, forced collections, a seeded oracle
#            for the sorted column, the fold with many groups' small frames and a store per group, the sorted
#            column at 1e7 values
#
#   ./run.sh quick     every part small and the probes small; nothing written to results/. About 15 minutes of one
#                      CPU, in one hold of the heavy lock when SP is set. Ends "E-65 quick: ok" or exits 1.
#   ./run.sh full      every part in full (hours: each part's seeded runs and three timed runs), then the probes
#   ./run.sh probes    the probes in full: the oracle under the heavy lock, three timed runs under the timing lock
#   ./run.sh x1 [step] one part; the step is that part's own (its run.sh header lists them)
#   ./run.sh summary   each part's results in short, from the files already there (runs nothing)
# Env: SP (a scratch folder of your own holding bin/timing, which runs a command alone on the box, and bin/heavy,
# which shares the box but waits for timing runs; without them the locks are skipped). NODE (default node on PATH,
# Node 22.22.0). DATA (data's folder, default ../data next to this repo, at 63fea66, read only). Every process runs
# with --max-old-space-size=3000 to 3500, so it stays under 4 GB.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
export NODE
N="$NODE --experimental-strip-types --no-warnings --expose-gc --max-old-space-size=3000"
if [ -n "$SP" ] && [ -x "$SP/bin/heavy" ]; then HEAVY="$SP/bin/heavy"; TIMING="$SP/bin/timing"; else HEAVY=; TIMING=; fi
P=$HERE/probes
R=$P/results

# one part's quick run, with no locks of its own (the caller holds the heavy lock)
partq() { d=$1; m=$2; echo "== E-65 $d $m =="; env -u SP INNER=1 sh "$HERE/$d/run.sh" "$m" > "$T/$d.out" 2>&1 || { tail -20 "$T/$d.out"; echo "E-65 quick: $d FAILED"; exit 1; }; tail -3 "$T/$d.out"; }

probes_quick() {
  echo "== E-65 probes, small =="
  cd "$P"
  for b in none nextchunk nointerp; do $N sortedcol-oracle.mjs --seeds=40 --steps=3000 --bug=$b; done > "$T/oracle.out"
  cat "$T/oracle.out"
  grep -q '"bug":"none".*"failed":0,' "$T/oracle.out" || { echo "E-65 quick: oracle failed on real code"; exit 1; }
  for b in nextchunk nointerp; do grep -q "\"bug\":\"$b\".*\"failed\":\\(3[0-9]\\|40\\)," "$T/oracle.out" || { echo "E-65 quick: planted $b not caught in most seeds"; exit 1; }; done
  $N sortedcol-scale.mjs --n=200000 --changes=200000 | tee "$T/scale.out"
  grep -q '"median_ok":true' "$T/scale.out" || { echo "E-65 quick: sorted column median wrong"; exit 1; }
  $N views-fold.mjs --rows=20000 --view=za --ms=300
  $N asker-fold.mjs --rows=20000 --stores=64 --frame=4 --view=za --ms=300
  $N forced-gc.mjs --rows=100000
}

probes_timed() { # one timed run of every probe cell
  r=$1
  cd "$P"
  echo "{\"run\":$r,\"loadavg_start\":\"$(cut -d' ' -f1-3 /proc/loadavg)\"}"
  for v in none sum length za median all; do $N views-fold.mjs --rows=1000000 --view=$v --ms=3000; done
  for v in za median; do $N views-fold.mjs --rows=100000 --view=$v --ms=2000; done
  $N asker-fold.mjs --rows=1000000 --stores=1 --frame=256 --view=za
  $N asker-fold.mjs --rows=1000000 --stores=64 --frame=4 --view=za
  $N asker-fold.mjs --rows=1000000 --stores=256 --frame=4 --view=za
  $N asker-fold.mjs --rows=1000000 --stores=1 --frame=256 --view=none
  $N asker-fold.mjs --rows=1000000 --stores=1 --frame=4 --view=none
  $N asker-fold.mjs --rows=1000000 --stores=64 --frame=4 --view=none
  $N asker-fold.mjs --rows=1000000 --stores=64 --frame=4 --view=sum
  $N sortedcol-scale.mjs --n=1000000
  $N sortedcol-scale.mjs --n=10000000
  for n in 1000000 5000000; do $N forced-gc.mjs --rows=$n; done
  echo "{\"run_end\":$r,\"loadavg_end\":\"$(cut -d' ' -f1-3 /proc/loadavg)\"}"
}

case "$1" in
  quick)
    if [ -z "$INNER" ] && [ -n "$HEAVY" ]; then exec "$HEAVY" env INNER=1 sh "$HERE/run.sh" quick; fi
    T=$(mktemp -d)
    partq X1 quick; partq X2 quick; partq X3 quick; partq X4 quick; partq X5 quick
    probes_quick
    rm -rf "$T"
    echo "E-65 quick: ok" ;;
  probes)
    mkdir -p "$R"
    for b in none nextchunk nointerp; do $HEAVY $N "$P/sortedcol-oracle.mjs" --seeds=300 --steps=6000 --bug=$b; done | tee "$R/oracle.jsonl"
    for r in 1 2 3; do $TIMING sh "$HERE/run.sh" probes-run $r; done | tee "$R/timing.jsonl" ;;
  probes-run) probes_timed "$2" ;;
  full)
    sh "$HERE/X1/run.sh" all; sh "$HERE/X2/run.sh"; sh "$HERE/X3/run.sh" all; sh "$HERE/X4/run.sh" all; sh "$HERE/X5/run.sh" all
    sh "$HERE/run.sh" probes; echo "== E-65: done; see README.md and each part's results/ ==" ;;
  x1|X1) shift; sh "$HERE/X1/run.sh" "${@:-all}" ;;
  x2|X2) shift; sh "$HERE/X2/run.sh" "$@" ;;
  x3|X3) shift; sh "$HERE/X3/run.sh" "${@:-all}" ;;
  x4|X4) shift; sh "$HERE/X4/run.sh" "${@:-all}" ;;
  x5|X5) shift; sh "$HERE/X5/run.sh" "${@:-all}" ;;
  summary)
    for d in X1 X2 X3 X4 X5; do echo "== E-65 $d: results/summary.md =="; sed -n '1,40p' "$HERE/$d/results/summary.md"; done
    echo "== E-65 probes =="; cat "$R/oracle.jsonl" "$R/timing.jsonl" ;;
  *) echo "usage: run.sh [quick | full | probes | x1..x5 [step] | summary]"; exit 1 ;;
esac
