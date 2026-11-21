#!/bin/sh
# E-64 O2: derive from the change stream alone, with before-images. Every claim of README.md, from a clean
# checkout. data at 63fea66 and fero v4's codec are read, never changed.
#   ./run.sh sims      D1 (marks), D2 (partials replaced on restart): seeded runs and planted bugs, heavy lock
#   ./run.sh topk      T1: a top-k per share with a bounded buffer and refills, seeded, heavy lock
#   ./run.sh rate      T2: refills per 1e6 changes by workload and buffer size, heavy lock
#   ./run.sh timing    the timed costs, RUNS times each, each process alone under the timing lock
#   ./run.sh bytes     encoded bytes a record, with fero v4's codec (no timing)
#   ./run.sh summary   results/summary.md from the JSON lines
#   ./run.sh quick     a few seeds of each sim and one small bench, no locks (a smoke test, about a minute)
#   ./run.sh           sims, topk, rate, bytes, timing, summary
# Env: SP (a scratch folder holding bin/timing and bin/heavy; without it the locks are skipped), NODE (default
# node on PATH: Node 22.22.0), DATA (data's folder, default ../data next to this repo), SEEDS (default 1000),
# RUNS (default "1 2 3"). Raw JSON lines land in results/.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../../../../.." && pwd)
export DATA=${DATA:-$(cd "$REPO/.." && pwd)/data}
export FERO=${FERO:-$REPO}
NODE=${NODE:-node}
SEEDS=${SEEDS:-1000}
RUNS=${RUNS:-1 2 3}
R=$HERE/results
mkdir -p "$R"
if [ -n "$SP" ]; then TIMING=$SP/bin/timing; HEAVY=$SP/bin/heavy; else TIMING=; HEAVY=; fi
# Each part takes its lock ONCE and runs all its processes inside it (a heavy part shares the CPU; the timing part
# has the box alone for its whole series), so a part does not queue again behind other jobs between processes.
case "${1:-all}" in
  sims|topk|rate) if [ -z "$INNER" ] && [ -n "$HEAVY" ]; then exec "$HEAVY" env INNER=1 sh "$HERE/run.sh" "$@"; fi ;;
  timing) if [ -z "$INNER" ] && [ -n "$TIMING" ]; then exec "$TIMING" env INNER=1 sh "$HERE/run.sh" "$@"; fi ;;
esac
if [ -n "$INNER" ]; then TIMING=; HEAVY=; fi
# every process stays under 4 GB
N="$NODE --experimental-strip-types --no-warnings --expose-gc --max-old-space-size=3500"
cd "$HERE"

one() { # lock, file, command...: one process, its load average first, then its JSON line(s)
  lock=$1; f=$2; shift 2
  printf '{"loadavg":"%s","cmd":"%s"}\n' "$(cat /proc/loadavg)" "$*" >> "$f"
  $lock "$@" >> "$f" || printf '{"failed":"%s"}\n' "$*" >> "$f"
}

sims() {
  f=$R/d.jsonl
  # D1, the marks form: groups 1, 4, 16; one output partition (the whole view at one cut) and 8 (spread)
  for cfg in "--groups=1 --shares=4" "--groups=4 --shares=4" "--groups=16 --shares=3" "--groups=16 --shares=16"; do
    for P in 1 8; do one "$HEAVY" "$f" $N src/sim-delta.mjs --seeds=$SEEDS --steps=1500 $cfg --P=$P; done
  done
  one "$HEAVY" "$f" $N src/sim-delta.mjs --seeds=$SEEDS --steps=1500 --dom=float --P=1
  one "$HEAVY" "$f" $N src/sim-delta.mjs --seeds=$SEEDS --steps=1500 --down=1 --P=1
  one "$HEAVY" "$f" $N src/sim-delta.mjs --seeds=$SEEDS --steps=1500 --down=1 --P=8
  for P in 1 8; do one "$HEAVY" "$f" $N src/sim-delta.mjs --steps=50000 --P=$P; done
  # D1's planted bugs (P=1, except nofilter, which needs partitions at different cuts), and a control
  for m in nobefore nomark memcursor float; do one "$HEAVY" "$f" $N src/sim-delta.mjs --seeds=$SEEDS --steps=1500 --P=1 --mutate=$m; done
  one "$HEAVY" "$f" $N src/sim-delta.mjs --seeds=$SEEDS --steps=1500 --P=8 --mutate=nofilter
  one "$HEAVY" "$f" $N src/sim-delta.mjs --seeds=$SEEDS --steps=1500 --P=1 --dom=int --mutate=float
  # D2, partials per share replaced on restart
  for cfg in "--groups=1 --shares=1" "--groups=4 --shares=4" "--groups=16 --shares=3"; do one "$HEAVY" "$f" $N src/sim-delta.mjs --form=replace --seeds=$SEEDS --steps=1500 $cfg; done
  one "$HEAVY" "$f" $N src/sim-delta.mjs --form=replace --seeds=$SEEDS --steps=1500 --down=1
  one "$HEAVY" "$f" $N src/sim-delta.mjs --form=replace --steps=50000
  for m in nocheck noreplace nofence; do one "$HEAVY" "$f" $N src/sim-delta.mjs --form=replace --seeds=$SEEDS --steps=1500 --mutate=$m; done
}
topk() {
  f=$R/t1.jsonl
  for kp in 12 20; do one "$HEAVY" "$f" $N src/sim-topk.mjs --seeds=$SEEDS --steps=1500 --kp=$kp --kmax=$((kp * 2)); done
  one "$HEAVY" "$f" $N src/sim-topk.mjs --seeds=$SEEDS --steps=1500 --groups=16 --shares=3 --kp=12 --kmax=24
  one "$HEAVY" "$f" $N src/sim-topk.mjs --steps=50000 --kp=12 --kmax=24
  for m in nodrop norefill; do one "$HEAVY" "$f" $N src/sim-topk.mjs --seeds=$SEEDS --steps=1500 --kp=12 --kmax=24 --mutate=$m; done
}
rate() {
  f=$R/t2.jsonl
  for n in 100000 1000000; do for wl in up walk uniform churn topdel; do for kp in 12 20 50 100; do
    one "$HEAVY" "$f" $N src/topk-rate.mjs $n $wl 10 $kp 1000000
  done; done; done
}
bytes() { one "" "$R/bytes.jsonl" $N src/bench.mjs bytes 1000000; }
timing() {
  f=$R/timing.jsonl
  for run in $RUNS; do
    for n in 100000 1000000; do
      for v in plain sink enrich; do one "$TIMING" "$f" $N src/bench.mjs enrich $n 1000000 $v; done
      one "$TIMING" "$f" $N src/bench.mjs r0 $n 1000000
      one "$TIMING" "$f" $N src/bench.mjs scan $n 20
    done
    for b in 100 10000; do for w in 64 1024; do for s in exact plain; do one "$TIMING" "$f" $N src/bench.mjs runner 1000000 $b $w $s; done; done; done
    for x in log enriched; do one "$TIMING" "$f" $N src/bench.mjs decode 1000000 $x; done
  done
}
summary() { $NODE "$HERE/src/summarize.mjs" "$R" > "$R/summary.md"; }
quick() {
  q=$(mktemp); trap 'rm -f "$q"' EXIT  # a smoke run writes nothing to results/
  $N src/sim-delta.mjs --seeds=20 --steps=800 >> "$q"
  $N src/sim-delta.mjs --seeds=20 --steps=800 --P=8 >> "$q"
  $N src/sim-delta.mjs --seeds=20 --steps=800 --mutate=nobefore >> "$q"
  $N src/sim-delta.mjs --form=replace --seeds=20 --steps=800 >> "$q"
  $N src/sim-topk.mjs --seeds=20 --steps=800 --kp=12 --kmax=24 >> "$q"
  $N src/topk-rate.mjs 100000 uniform 10 12 200000 >> "$q"
  $N src/bench.mjs runner 200000 100 256 exact >> "$q"
  cat "$q"
}

case "${1:-all}" in
  sims) sims ;; topk) topk ;; rate) rate ;; bytes) bytes ;; timing) timing ;; summary) summary ;; quick) quick ;;
  all) sh "$HERE/run.sh" sims; sh "$HERE/run.sh" topk; sh "$HERE/run.sh" rate; bytes; sh "$HERE/run.sh" timing; summary ;;
  *) echo "usage: $0 [sims|topk|rate|bytes|timing|summary|quick]"; exit 2 ;;
esac
