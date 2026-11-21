#!/bin/sh
# E-64 O4: a view sharded by its output key. Every claim of README.md, from a clean checkout.
# data at 63fea66 and fero v4's codec are read, never changed.
#   ./run.sh sims      the seeded runs: groups x shards, a group down, the barrier, float values; heavy lock
#   ./run.sh mutants   the planted bugs, 1,000 seeds each; heavy lock
#   ./run.sh long      two long runs of 50,000 steps; heavy lock
#   ./run.sh timing    the timed costs, RUNS times each, each process alone under the timing lock
#   ./run.sh bytes     encoded bytes a record for K = 1, 4, 16, 64 (no timing)
#   ./run.sh summary   results/summary.md from the JSON lines
#   ./run.sh quick     a few seeds of each sim and one small bench, no locks (a smoke test, about a minute)
#   ./run.sh           sims, mutants, long, bytes, timing, summary
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
# Each part takes its lock ONCE and runs all its processes inside it.
case "${1:-all}" in
  sims|mutants|long) if [ -z "$INNER" ] && [ -n "$HEAVY" ]; then exec "$HEAVY" env INNER=1 sh "$HERE/run.sh" "$@"; fi ;;
  timing) if [ -z "$INNER" ] && [ -n "$TIMING" ]; then exec "$TIMING" env INNER=1 sh "$HERE/run.sh" "$@"; fi ;;
esac
# every process stays under 4 GB
N="$NODE --experimental-strip-types --no-warnings --expose-gc --max-old-space-size=3500"
cd "$HERE"

one() { # file, command...: one process, its load average first, then its JSON line
  f=$1; shift
  printf '{"loadavg":"%s","cmd":"%s"}\n' "$(cat /proc/loadavg)" "$*" >> "$f"
  "$@" >> "$f" || printf '{"failed":"%s"}\n' "$*" >> "$f"
}

sims() {
  f=$R/sims.jsonl
  for cfg in "--groups=1 --K=4" "--groups=4 --K=1" "--groups=4 --K=4" "--groups=4 --K=16" "--groups=16 --K=4" "--groups=16 --K=16"; do
    one "$f" $N src/sim.mjs --seeds=$SEEDS --steps=1500 $cfg
  done
  one "$f" $N src/sim.mjs --seeds=$SEEDS --steps=1500 --groups=4 --K=4 --down=1
  one "$f" $N src/sim.mjs --seeds=$SEEDS --steps=1500 --groups=4 --K=4 --dom=float
  one "$f" $N src/sim.mjs --seeds=$SEEDS --steps=1500 --groups=4 --K=4 --barrier=250
  one "$f" $N src/sim.mjs --seeds=$SEEDS --steps=1500 --groups=16 --K=16 --barrier=250
  one "$f" $N src/sim.mjs --seeds=$SEEDS --steps=1500 --groups=4 --K=4 --barrier=250 --down=1
  # the lean wire form: parts only to shards with messages, plus markers
  for cfg in "--groups=4 --K=4" "--groups=16 --K=16" "--groups=4 --K=16 --down=1" "--groups=4 --K=4 --barrier=250" "--groups=16 --K=16 --barrier=250 --down=1"; do
    one "$f" $N src/sim.mjs --seeds=$SEEDS --steps=1500 --wire=lean $cfg
  done
}
mutants() {
  f=$R/mutants.jsonl
  for m in noleave nochain skipgap mergepic nohello nofilter; do one "$f" $N src/sim.mjs --seeds=$SEEDS --steps=1500 --groups=4 --K=4 --mutate=$m; done
  one "$f" $N src/sim.mjs --seeds=$SEEDS --steps=1500 --groups=4 --K=4 --barrier=250 --mutate=barrierpass
  one "$f" $N src/sim.mjs --seeds=$SEEDS --steps=1500 --groups=4 --K=4 --barrier=250 --wire=lean --mutate=nobmark
}
long() {
  f=$R/long.jsonl
  one "$f" $N src/sim.mjs --steps=50000 --groups=4 --K=4 --barrier=250
  one "$f" $N src/sim.mjs --steps=50000 --groups=16 --K=16 --down=1
  one "$f" $N src/sim.mjs --steps=50000 --groups=16 --K=16 --barrier=250 --wire=lean
}
timing() {
  f=$R/timing.jsonl
  for run in $RUNS; do
    for rows in 100000 1000000; do
      for v in plain route encode encode256; do one "$f" $N src/bench.mjs route $rows 1000000 16 $v; done
      for view in sum full; do
        one "$f" $N src/bench.mjs r0 $rows 1000000 $view
        one "$f" $N src/bench.mjs shard $rows 2000000 16 $view
      done
      one "$f" $N src/bench.mjs shard $rows 2000000 4 sum
      one "$f" $N src/bench.mjs scan $rows 16
    done
  done
}
bytes() {
  f=$R/bytes.jsonl
  for K in 1 4 16 64; do one "$f" $N src/bench.mjs bytes 1000000 $K; done
}
summary() { $NODE src/summarize.mjs > "$R/summary.md"; echo "wrote $R/summary.md"; }
quick() {
  for cfg in "--groups=4 --K=4" "--groups=16 --K=16 --down=1" "--groups=4 --K=4 --barrier=250"; do $N src/sim.mjs --seeds=5 --steps=1500 $cfg; done
  $N src/sim.mjs --seeds=5 --steps=1500 --mutate=noleave
  $N src/bench.mjs route 100000 200000 16 route
  $N src/bench.mjs shard 100000 300000 16 sum
}

case "${1:-all}" in
  sims) sims ;;
  mutants) mutants ;;
  long) long ;;
  timing) timing ;;
  bytes) bytes ;;
  summary) summary ;;
  quick) quick ;;
  all) sh "$HERE/run.sh" sims; sh "$HERE/run.sh" mutants; sh "$HERE/run.sh" long; bytes; sh "$HERE/run.sh" timing; summary ;;
  *) echo "usage: $0 [sims|mutants|long|timing|bytes|summary|quick]"; exit 1 ;;
esac
