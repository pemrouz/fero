#!/bin/sh
# E-18: do 256, 1,024, 4,096 or 16,384 slots spread a resource's load well,
# with hot keys, as groups grow; and how many writers does a resource really get?
# Parts:
#   env      machine and versions -> results/machine.txt
#   build    compile src/kern.c into $E18_BUILD/kern.so (our own C, no outside code)
#   selftest the C kernels against plain-Python twins and brute force, and the
#            float-tie regression against the kernel before its fix
#   static   part A: max/mean on a grid of G = 1..256, every placement (one heavy hold)
#   eff      part B: effective writers, G = 1..1,024 (one heavy hold)
#   dyn      part C: moves after a load shift (one heavy hold)
#   hash     part D: real hashes of real key names against the random stand-in
#   tail     part E: how often the slots alone miss the bar, over 2,200 draws (two processes)
#   report   the tables in results/ from the raw files
#   rest     parts C, D and E in one hold (about 12 minutes of compute)
#   all      env, build, selftest, static, eff, rest, report: what the recorded run did
#            (about 50 CPU-minutes; each hold is under 30 minutes of compute)
# Raw outputs go to $E18_RAW (default: the scratchpad); results/ keeps the
# summaries and trimmed raw tables. Usage: ./run.sh [part]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export E18_BUILD=${E18_BUILD:-$SP/e18}
RAW=${E18_RAW:-$SP/e18}
HEAVY="$SP/bin/heavy"
OUT="$HERE/results"
mkdir -p "$OUT" "$E18_BUILD" "$RAW"
cd "$HERE/src"
part=${1:-all}

env_() {
  {
    echo "date: $(date -u +%FT%TZ)"
    echo "host: $(uname -srm)"
    echo "cpus: $(nproc); mem: $(free -g | awk '/Mem:/{print $2}') GB"
    echo "python: $(python3 --version 2>&1); numpy: $(python3 -c 'import numpy; print(numpy.__version__)')"
    echo "gcc: $(gcc --version | head -1)"
    echo "loadavg at start: $(cat /proc/loadavg)"
  } > "$OUT/machine.txt"
}
build() { gcc -O2 -Wall -shared -fPIC -o "$E18_BUILD/kern.so" kern.c; }
selftest() { python3 selftest.py | tee "$OUT/selftest.txt"; }
static() {
  rm -f "$RAW/static-a.jsonl" "$RAW/static-b.jsonl"
  echo "static start $(date -u +%T) load $(cat /proc/loadavg)" >> "$OUT/walltime.txt"
  "$HEAVY" sh -c "python3 static.py --N 10000 100000 1000000 --out $RAW/static-a.jsonl 2> $RAW/static-a.log &
                  python3 static.py --N 10000000 --out $RAW/static-b.jsonl 2> $RAW/static-b.log; wait"
  echo "static end   $(date -u +%T)" >> "$OUT/walltime.txt"
}
eff() {
  rm -f "$RAW/eff-a.jsonl" "$RAW/eff-b.jsonl" "$RAW/curves-a.jsonl" "$RAW/curves-b.jsonl" "$RAW"/effc-*.jsonl
  echo "eff start $(date -u +%T) load $(cat /proc/loadavg)" >> "$OUT/walltime.txt"
  "$HEAVY" sh -c "python3 eff.py --N 10000 100000 --out $RAW/eff-a.jsonl --curves $RAW/curves-a.jsonl 2> $RAW/eff-a.log &
                  python3 eff.py --N 1000000 10000000 --out $RAW/eff-b.jsonl --curves $RAW/curves-b.jsonl 2> $RAW/eff-b.log; wait
                  for c in 0.25 1.0; do
                    python3 eff.py --N 10000 1000000 --dists zipf-0.99 --seeds 3 1 2 1 --split-c \$c --out $RAW/effc-\$c.jsonl 2>> $RAW/effc.log &
                  done; wait"
  echo "eff end   $(date -u +%T)" >> "$OUT/walltime.txt"
}
dyn() {
  rm -f "$RAW/dyn-a.jsonl" "$RAW/dyn-b.jsonl"
  echo "dyn start $(date -u +%T) load $(cat /proc/loadavg)" >> "$OUT/walltime.txt"
  "$HEAVY" sh -c "python3 dyn.py --N 10000 --out $RAW/dyn-a.jsonl 2> $RAW/dyn-a.log &
                  python3 dyn.py --N 1000000 --out $RAW/dyn-b.jsonl 2> $RAW/dyn-b.log; wait"
  echo "dyn end   $(date -u +%T)" >> "$OUT/walltime.txt"
}
hash_() {
  rm -f "$RAW/hash.jsonl"
  echo "hash start $(date -u +%T) load $(cat /proc/loadavg)" >> "$OUT/walltime.txt"
  "$HEAVY" python3 hashcheck.py "$RAW/hash.jsonl" 2> "$RAW/hash.log"
  echo "hash end   $(date -u +%T)" >> "$OUT/walltime.txt"
}
tail_() {
  rm -f "$RAW"/tail-*.jsonl
  echo "tail start $(date -u +%T) load $(cat /proc/loadavg)" >> "$OUT/walltime.txt"
  "$HEAVY" sh -c "(python3 tail.py --N 10000 --seeds 1000 --out $RAW/tail-a.jsonl 2> $RAW/tail-a.log;
                   python3 tail.py --N 1000000 --seeds 200 --out $RAW/tail-c.jsonl 2> $RAW/tail-c.log) &
                  python3 tail.py --N 100000 --seeds 1000 --out $RAW/tail-b.jsonl 2> $RAW/tail-b.log; wait"
  echo "tail end   $(date -u +%T)" >> "$OUT/walltime.txt"
}
rest() {   # parts C, D and E in one hold of the heavy lock (about 20 minutes)
  rm -f "$RAW/dyn-a.jsonl" "$RAW/dyn-b.jsonl" "$RAW/hash.jsonl" "$RAW"/tail-*.jsonl
  echo "rest start $(date -u +%T) load $(cat /proc/loadavg)" >> "$OUT/walltime.txt"
  "$HEAVY" sh -c "python3 dyn.py --N 10000 --out $RAW/dyn-a.jsonl 2> $RAW/dyn-a.log &
                  python3 dyn.py --N 1000000 --out $RAW/dyn-b.jsonl 2> $RAW/dyn-b.log; wait
                  (python3 hashcheck.py $RAW/hash.jsonl 2> $RAW/hash.log;
                   python3 tail.py --N 10000 --seeds 1000 --out $RAW/tail-a.jsonl 2> $RAW/tail-a.log;
                   python3 tail.py --N 1000000 --seeds 200 --out $RAW/tail-c.jsonl 2> $RAW/tail-c.log) &
                  python3 tail.py --N 100000 --seeds 1000 --out $RAW/tail-b.jsonl 2> $RAW/tail-b.log; wait"
  echo "rest end   $(date -u +%T)" >> "$OUT/walltime.txt"
}
regress() {
  mkdir -p "$E18_BUILD/eps0"
  gcc -O2 -DEPS=0 -shared -fPIC -o "$E18_BUILD/eps0/kern.so" kern.c
  {
    echo "Regression for the float-tie ping-pong (found 2026-11-09 in part B, S = 16,384, G = 611:"
    echo "200,000 moves of equal app-split pieces with no end). selftest.py's 300 equal-piece cases,"
    echo "run against kern.c built without the margin (EPS = 0, the kernel before the fix) and with it:"
    E18_BUILD="$E18_BUILD/eps0" python3 regress.py "old kernel (no margin)"
    python3 regress.py "fixed kernel (margin 1e-9 x floor)"
    echo "Every part was re-run from scratch with the fixed kernel; summary.md is from that run."
  } | tee "$OUT/selftest-regression.txt"
}
report() { python3 report.py "$RAW" "$OUT"; }

case "$part" in
  env) env_ ;;
  build) build ;;
  selftest) build; selftest; regress ;;
  static) build; static ;;
  eff) build; eff ;;
  dyn) build; dyn ;;
  hash) build; hash_ ;;
  tail) build; tail_ ;;
  rest) build; rest ;;
  report) report ;;
  all) env_; build; selftest; regress; static; eff; rest; report ;;
  *) echo "unknown part: $part" >&2; exit 2 ;;
esac
