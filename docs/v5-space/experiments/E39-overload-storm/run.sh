#!/bin/sh
# E-39: twice capacity, and a reconnect storm.
#   ./run.sh build                    build the Rust leader and load generator (heavy lock); E-02's Rust follower
#                                     binary must exist too (../E02-pipeline/run.sh build)
#   ./run.sh <impl>-max               timing hold: 3 closed-loop max runs (impl = ts | rust)
#   ./run.sh <impl>-<combo>           timing hold: 3 runs at 0.5, 1, 1.5 and 2 x max, combo =
#                                       un-naive  unbounded queue, clients retry at once on timeout
#                                       b-naive   bounded queue + refusal with retry-after, clients retry at once
#                                       b-jitter  bounded queue + retry-after, clients honour it with full jitter
#                                       (b-jitter-t2: the same with patient clients, timeout 2 s, deadline 4 s)
#                                       b-prio    b-jitter, and the leader serves its commit path first (bounded-prio)
#                                       b-credit  b-jitter plus a client-side window of `limit` outstanding writes
#                                     (0.5 x runs only for b-jitter, the steady reference, and b-credit)
#   ./run.sh <impl>-b-jitter-t2       timing hold: b-jitter at 1 and 2 x with patient clients (timeout 2 s, deadline 4 s)
#   ./run.sh storm-tcp | storm-tls    timing hold: the reconnect storm, 3 runs per variant
#   ./run.sh all                      everything above; ./run.sh summary prints the tables
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
RUNS=${RUNS:-3}
P="node $HERE/pipe/bench.mjs procs=2 p1=10 p2=8 runs=1"
combo() { # $1 impl, $2 policy, $3 client, $4 multiples
  for run in $(seq 1 "$RUNS"); do for m in $4; do $P impl=$1 mult=$m policy=$2 client=$3; done; done; }
case "$1" in
  build) (cd "$HERE/rs" && CARGO_TARGET_DIR=$SP/e39/target "$SP/bin/heavy" cargo build --release --locked) ;;
  _ts-max|_rust-max) i=${1#_}; i=${i%-max}; node "$HERE/pipe/bench.mjs" procs=2 p1=10 runs="$RUNS" impl=$i mult=max ;;
  _*-un-naive) i=${1#_}
    # 2026-11-09: rebuild first, so the bounded client send buffer (load.rs) is in every run from here on
    if [ "$1" = "_rust-un-naive" ]; then (cd "$HERE/rs" && CARGO_TARGET_DIR=$SP/e39/target cargo build --release --offline -q)
      # the hold before lost rust-max and rust-b-jitter (run.sh was being edited while it ran: a syntax error); run them first
      grep -q '"impl":"rust","mult":"max"' "$HERE/results/pipe.jsonl" || { sh "$HERE/run.sh" _rust-max; sh "$HERE/run.sh" _rust-b-jitter; }
    fi
    combo "${i%%-*}" unbounded naive "1 1.5 2"
    # 2026-11-09: to lose fewer gaps between holds to other jobs, the hold that ends with ts-un-naive also ran the
    # next hold's blocks (marker file $SP/e39/merge-C); a normal run of this block does not
    if [ "$1" = "_ts-un-naive" ] && [ -f "$SP/e39/merge-C" ]; then
      rm -f "$SP/e39/merge-C"
      for b in ts-b-naive ts-b-prio ts-b-credit rust-max rust-b-jitter; do sh "$HERE/run.sh" "_$b"; done
      echo "$(date +%T) hold B+C done" >> "$SP/queue.log"
    fi ;;
  _*-b-naive) i=${1#_}; combo "${i%%-*}" bounded naive "1 1.5 2" ;;
  _*-b-jitter) i=${1#_}; combo "${i%%-*}" bounded jitter "0.5 1 1.5 2" ;;
  _*-b-prio) i=${1#_}; combo "${i%%-*}" bounded-prio jitter "1 1.5 2" ;;
  _*-b-credit) i=${1#_}; combo "${i%%-*}" bounded credit "0.5 1 1.5 2" ;;
  _*-b-jitter-t2) i=${1#_}; i=${i%%-*} # b-jitter with patient clients: no timeout before 2 s, give up at 4 s
    for run in $(seq 1 "$RUNS"); do for m in 1 2; do $P impl=$i mult=$m policy=bounded client=jitter timeout=2000 deadline=4000; done; done ;;
  _ts-rerun) # the TS naive runs that the first client (unbounded send buffer) lost to the kernel's OOM killer
    $P impl=ts mult=1.5 policy=unbounded client=naive; $P impl=ts mult=1.5 policy=bounded client=naive
    $P impl=ts mult=2 policy=bounded client=naive; $P impl=ts mult=2 policy=bounded client=naive ;;
  _storm-tcp) for run in $(seq 1 "$RUNS"); do for p in fixed jitter; do node "$HERE/storm/storm.mjs" tcp $p 0 10000 "$HERE/results/storm.jsonl" $run; done; done ;;
  _storm-tls) for run in $(seq 1 "$RUNS"); do for v in "fixed 0" "jitter 0" "jitter 1"; do set -- $v; node "$HERE/storm/storm.mjs" tls $1 $2 10000 "$HERE/results/storm.jsonl" $run; done; done ;;
  ts-*|rust-*|storm-*) { node --version; uname -r; cat /proc/cpuinfo | grep -m1 'model name'; } > "$HERE/results/versions.txt"; "$SP/bin/timing" sh "$HERE/run.sh" "_$1" ;;
  all) "$HERE/run.sh" build
       for i in ts rust; do for b in max b-jitter un-naive b-naive b-prio b-credit b-jitter-t2; do "$HERE/run.sh" $i-$b; done; done
       "$HERE/run.sh" storm-tcp; "$HERE/run.sh" storm-tls; "$HERE/run.sh" summary ;;
  summary) python3 "$HERE/summarize.py" "$HERE/results" ;;
  *) echo "usage: see the header"; exit 1 ;;
esac
