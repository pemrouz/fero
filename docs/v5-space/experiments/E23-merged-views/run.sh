#!/bin/sh
# E-23: can live views over a resource held by several groups be merged exactly?
# Re-runs every part and writes results/. Parts:
#   env      machine, versions, data's commit
#   checks   the exact-sum cross-check (vs Python's math.fsum) and the mixed-type probe
#   A [g..]  merge exactness: groups 1, 4, 16, elastic x domains int, float, dirty x mixes moves, failover
#   B        history independence: interleaving, rebuilt views, a follower from a snapshot
#   C        a slot move seen as two cuts (fence first, open first)
#   E        an asynchronous merger: late, interleaved partials checked against the query over its cut
#   rest     checks + B + C + E in one hold of the heavy lock
#   D        cost per commit of the merge layer (timing: one hold of the CPU lock, 3 runs per row)
#   S        the summary tables of A and C (results/summary.md)
#   all      everything (about 80 CPU-minutes; most of A's runs take 2 to 5 minutes)
# Usage: ./run.sh [part]. Env: COMMITS=n shortens A, B, C and E; PAR=n runs n at a
# time inside one hold of the heavy lock (default 3, the brief's limit); SKIP_DONE=1
# skips a run whose result file is already non-empty (to resume).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export DATA_DIR=${DATA_DIR:-/home/user/pemrouz/data}
N=${COMMITS:-100000}
PAR=${PAR:-3}
HEAVY="$SP/bin/heavy"
TIMING="$SP/bin/timing"
OUT="$HERE/results"
NODE="node --experimental-strip-types"
mkdir -p "$OUT"
cd "$HERE/src"
part=${1:-all}
[ $# -gt 0 ] && shift

# todo <result file> <command...>: print one command line, unless SKIP_DONE=1 and it is done
todo() {
  f=$1; shift
  if [ "${SKIP_DONE:-0}" = 1 ] && [ -s "$f" ]; then return 0; fi
  echo "$* > $f 2>&1"
}
# par: run the command lines on stdin, PAR at a time, under ONE hold of the heavy lock
par() { $HEAVY sh par.sh "$PAR"; }

env_part() {
  {
    echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "node: $(node --version)"
    echo "python: $(python3 --version 2>&1)"
    echo "data: $(git -C "$DATA_DIR" log -1 --format='%H %cd' --date=iso) (SCHEDULE_VERSION $(grep -o 'SCHEDULE_VERSION = [0-9]*' "$DATA_DIR/contract/index.ts" | grep -o '[0-9]*$'))"
    echo "data dirty files: $(git -C "$DATA_DIR" status --porcelain | wc -l)"
    echo "cpu: $(nproc) x $(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2 | sed 's/^ //')"
    echo "mem: $(free -g | awk '/Mem:/ {print $2}') GB"
    echo "kernel: $(uname -r)"
  } > "$OUT/env.txt"
  cat "$OUT/env.txt"
}

checks_cmds() {
  todo "$OUT/exactsum-check.txt" "$NODE exactsum-check.ts | python3 -I check_fsum.py"
  todo "$OUT/probe-mixed.txt" $NODE probe-mixed.ts
}

A_cmds() {
  for g in ${*:-1 4 16 elastic}; do
    for d in int float dirty; do
      for mix in moves failover; do
        todo "$OUT/A-merge-g$g-$d-$mix.txt" $NODE merge.ts --groups=$g --domain=$d --mix=$mix --commits=$N
      done
    done
  done
}

B_cmds() {
  for g in 4 16; do
    for d in int float dirty; do
      n=$N
      # the dirty domain trips data's sorted-index fault (see probe-mixed), which
      # slows the full-order view quadratically; 20,000 commits show it
      if [ "$d" = dirty ] && [ "$n" -gt 20000 ]; then n=20000; fi
      todo "$OUT/B-interleave-g$g-$d.txt" $NODE interleave.ts --groups=$g --domain=$d --commits=$n
    done
  done
}

C_cmds() {
  n=$N
  if [ "$n" -gt 20000 ]; then n=20000; fi
  for mv in fence-first open-first; do
    for g in 4 elastic; do
      todo "$OUT/C-move-$mv-g$g.txt" $NODE merge.ts --groups=$g --domain=int --move=$mv --commits=$n
    done
  done
}

E_cmds() {
  for g in 4 16; do
    for d in int float; do
      todo "$OUT/E-async-g$g-$d.txt" $NODE async.ts --groups=$g --domain=$d --commits=$N
    done
  done
}

D_part() {
  f="$OUT/D-bench.txt"
  # one hold of the CPU lock for the whole series (51 short runs, about 5 minutes)
  $TIMING sh bench-all.sh > "$f" 2>&1
  $NODE bench-summary.ts "$f" > "$OUT/D-bench-summary.txt"
  cat "$OUT/D-bench-summary.txt"
}

heads() { for f in "$@"; do if [ -s "$f" ]; then head -2 "$f"; fi; done; return 0; }

case "$part" in
  env) env_part ;;
  checks) checks_cmds | par; cat "$OUT/exactsum-check.txt" "$OUT/probe-mixed.txt" ;;
  A) A_cmds "$@" | par; heads "$OUT"/A-merge-*.txt ;;
  B) B_cmds | par; heads "$OUT"/B-*.txt ;;
  C) C_cmds | par; heads "$OUT"/C-*.txt ;;
  E) E_cmds | par; heads "$OUT"/E-*.txt ;;
  rest) { checks_cmds; B_cmds; C_cmds; E_cmds; } | par; heads "$OUT"/B-*.txt "$OUT"/C-*.txt "$OUT"/E-*.txt ;;
  D) D_part ;;
  S) $NODE summarize.ts "$OUT" > "$OUT/summary.md"; echo "wrote $OUT/summary.md" ;;
  all) env_part; { checks_cmds; A_cmds; } | par; { B_cmds; C_cmds; E_cmds; } | par; D_part
       $NODE summarize.ts "$OUT" > "$OUT/summary.md" ;;
  *) echo "unknown part $part" >&2; exit 2 ;;
esac
