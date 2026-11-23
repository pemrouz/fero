#!/bin/sh
# E-63: which thread judges writes? A leader's write path several ways on one load (50,000 writes a second), each
# through a 5 s stall of the leader's main thread (bench/run.mjs; the README says what each form is).
#   ./run.sh setup [file]          build the scratch tree (fero's seam and codec + data, as E-07 did); write the
#                                  versions to file (default results/versions.txt)
#   ./run.sh quick                 setup, then every cell once on 100,000 small rows with short phases (2 s stall);
#                                  under the heavy lock, not timed; prints the tables to the screen; writes only to $SP
#   ./run.sh full                  clean results/, then every hold below in turn, then the tables (about 2.5 hours
#                                  of the box alone): the first holds (1e6 small rows, 1e5 big rows: runs 1 to 3 of
#                                  the nine cells, then of four cells with the GC log on), the first side probe,
#                                  then the review holds (./run.sh review)
#   ./run.sh review                the holds added after review, appended to results/: 900,000 small rows, the ten
#                                  cells of CELLS_A, then the ten of CELLS_B, then the GC log on four cells, then the
#                                  second side probe (about 1.5 hours)
#   ./run.sh hold <rows> <shape> [cell ...]   one timing hold: run 1 of every cell, then run 2, then run 3
#   ./run.sh gchold <rows> <shape> [cell ...] the same with the GC log on (GCSTATS=1; default cells none, A, B, B2)
#   ./run.sh spikes                one timing hold of the first side probe (bench/spikes.mjs, six row stores)
#   ./run.sh spikes2               one timing hold of the second side probe (four more row-store cases, B2's upkeep,
#                                  and bench/budget.mjs, the cost of a rule budget)
#   ./run.sh summary               write results/tables.md from results/runs.jsonl and results/spikes.jsonl
# A cell is form[@W][/rate]:[leader flag]: M3@200 sets M3's watchdog W in ms, B/75000 sets the rate, and the flag
# goes to the leader's node (M2 is A with --max-semi-space-size). HOLD names the hold in each run's header line.
# Env: SP (required: a scratch folder of your own holding the lock helpers bin/timing, which runs a command alone on
# the box, and bin/heavy, which shares it and waits for timing runs). NODE (default node on PATH; Node 22.22.0).
# FERO and DATA for tree.sh (default: this repo, and ../data next to it, read only). Every process gets a
# 3,800 MB heap cap. Journals go to $SP/e63/j on the real disk and are removed after each run.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
: "${SP:?set SP to a scratch folder (it holds bin/timing and bin/heavy)}"
NODE=${NODE:-node}
export TREE=$SP/e63/tree JDIR=$SP/e63/j
R=$HERE/results
B=$HERE/bench
# the first holds (1e6 small rows; 1e5 big rows)
: "${CELLS:=none: A: A:--max-semi-space-size=64 A:--max-semi-space-size=2 M1: M3: M3@200: B: B2:}"
# the review holds, both on 900,000 small rows: (a) every form, with Bs added; (b) the user-rule stall and the
# budget, and 1.5 times the rate, each with the control and B and B2 beside them in the same hold
CELLS_A="none: A: A:--max-semi-space-size=64 A:--max-semi-space-size=2 M1: M3: M3@200: B: Bs: B2:"
CELLS_B="none: B: B2: B+rule: B+budget: B2+rule: B2+budget: none/75000: B/75000: B2/75000:"
GCCELLS="none: A: B: B2:"
mkdir -p "$R" "$JDIR"

one() { # one <out> <run> <rows> <shape> <form[@W][/rate]> [leader flag] [quick]
  out=$1; run=$2; rows=$3; shape=$4; spec=$5; flag=$6; q=${7:-}
  rate=50000; case "$spec" in */*) rate=${spec#*/}; spec=${spec%%/*} ;; esac
  watch=500; case "$spec" in *@*) watch=${spec#*@}; spec=${spec%%@*} ;; esac
  printf '{"run":%s,"hold":"%s","loadavg":"%s","cell":"%s %s %s %s"}\n' "$run" "${HOLD:-}" "$(cat /proc/loadavg)" "$5" "$rows" "$shape" "$flag" >> "$out"
  # shellcheck disable=SC2086
  RATE=$rate WATCH_MS=$watch "$NODE" "$B/run.mjs" "$spec" "$rows" "$shape" $q $flag >> "$out" || echo '{"failed":true}' >> "$out"
}
cells() { # cells <out> <run> <rows> <shape> [quick]
  for c in $CELLS; do one "$1" "$2" "$3" "$4" "${c%%:*}" "${c#*:}" "${5:-}"; done
}
runs() { # runs <rows> <shape> [cell ...]: runs 1 to 3 of the cells
  rows=$1; shape=$2; shift 2; [ $# -gt 0 ] && CELLS="$*"
  for run in 1 2 3; do cells "$R/runs.jsonl" "$run" "$rows" "$shape"; done
}
probe() { # probe <run> <bench file> <args...>: one side-probe process, its header line first
  run=$1; f=$2; shift 2
  printf '{"run":%s,"hold":"%s","loadavg":"%s","cell":"%s %s"}\n' "$run" "${HOLD:-}" "$(cat /proc/loadavg)" "$f" "$*" >> "$R/spikes.jsonl"
  "$NODE" --expose-gc --experimental-strip-types --no-warnings --max-old-space-size=3800 "$B/$f" "$@" >> "$R/spikes.jsonl" || echo '{"failed":true}' >> "$R/spikes.jsonl"
}

case "${1:-}" in
  setup) sh "$HERE/tree.sh" "$TREE"; { cat "$TREE/VERSIONS"; "$NODE" --version; uname -r; nproc; free -g | head -2; } > "${2:-$R/versions.txt}" ;;
  quick)
    sh "$HERE/run.sh" setup "$SP/e63/versions.txt"
    rm -f "$SP/e63/quick.jsonl"
    CELLS="$CELLS_A B+rule: B+budget: B2+rule: B2+budget: none/75000: B/75000: B2/75000:" \
      "$SP/bin/heavy" sh "$HERE/run.sh" _cells "$SP/e63/quick.jsonl" 1 100000 small quick
    "$NODE" "$HERE/summarize.mjs" "$SP/e63/quick.jsonl" ;;
  _cells) shift; cells "$@" ;;
  _runs) shift; runs "$@" ;;
  _gcruns) shift; export GCSTATS=1; rows=$1; shape=$2; shift 2; [ $# -gt 0 ] || set -- $GCCELLS; runs "$rows" "$shape" "$@" ;;
  _spikes) for run in 1 2 3; do for v in map map2 mapint lane lane+ver compact; do probe "$run" spikes.mjs "$v"; done; done ;;
  _spikes2) for run in 1 2 3; do
      for v in "map2 1000000" "map2shard 1000000" "map2 900000" "lane+ver 900000" "upkeep 1000000"; do
        # shellcheck disable=SC2086
        probe "$run" spikes.mjs $v
      done
      probe "$run" budget.mjs 100000
    done ;;
  spikes) HOLD=${HOLD:-spikes} "$SP/bin/timing" sh "$HERE/run.sh" _spikes ;;
  spikes2) HOLD=${HOLD:-spikes2} "$SP/bin/timing" sh "$HERE/run.sh" _spikes2 ;;
  hold) shift; HOLD=${HOLD:-$1-$2} "$SP/bin/timing" sh "$HERE/run.sh" _runs "$@" ;;
  gchold) shift; HOLD=${HOLD:-gc-$1-$2} "$SP/bin/timing" sh "$HERE/run.sh" _gcruns "$@" ;;
  review)
    sh "$HERE/run.sh" setup "$R/versions-review.txt"
    # shellcheck disable=SC2086
    HOLD=review-a sh "$HERE/run.sh" hold 900000 small $CELLS_A
    # shellcheck disable=SC2086
    HOLD=review-b sh "$HERE/run.sh" hold 900000 small $CELLS_B
    HOLD=review-gc sh "$HERE/run.sh" gchold 900000 small
    sh "$HERE/run.sh" spikes2 ;;
  full)
    rm -f "$R/runs.jsonl" "$R/spikes.jsonl" "$R/tables.md"
    sh "$HERE/run.sh" setup
    for rs in "1000000 small" "100000 big"; do
      # shellcheck disable=SC2086
      sh "$HERE/run.sh" hold $rs
      # shellcheck disable=SC2086
      sh "$HERE/run.sh" gchold $rs
    done
    sh "$HERE/run.sh" spikes
    sh "$HERE/run.sh" review
    sh "$HERE/run.sh" summary ;;
  summary) "$NODE" "$HERE/summarize.mjs" "$R/runs.jsonl" "$R/spikes.jsonl" > "$R/tables.md"; cat "$R/tables.md" ;;
  *) echo "usage: run.sh setup [file] | quick | full | review | hold <rows> <shape> [cell ...] | gchold <rows> <shape> [cell ...] | spikes | spikes2 | summary"; exit 1 ;;
esac
