#!/bin/sh
# E-61: exactly once into fero by marks written from app code (`{ from: e }`, not awaited), through crashes,
# lost Raft tails, restarts from marks or from the share's cursor, share moves, slot moves, refused and fenced
# writes, an async fn, pacing, failed writes that end the loop, and a source that cuts its log. One exhaustive
# model on E-16's engine with E-17's rule language (E-30's way), its DEV-10 ablation and mutants, build-bug
# mutants, the structural removals, seeded runs of the same model on bigger worlds, and E-57 B5's owed ablation.
#
#   ./run.sh quick    the design on every bound, what each bound reaches, every structural removal (on the
#                     40 sweep bounds), the build-bug mutants, the traces, 100 seeds per world (about 40
#                     minutes of CPU)
#   ./run.sh full     quick's steps with 1,000 seeds and the other paths on all 42 bounds, plus the DEV-10
#                     ablation and its mutants (about 3 hours of CPU); E-57 B5's ablation only with B5=1 (its
#                     model is E-57's, unchanged since it ran)
#   ./run.sh core     full without the ablation; ./run.sh ablate, the ablation alone (the two can run side by side)
#   ./run.sh report   results/summary.md from the result files
#   ./run.sh          = full, then report
#
# Env: HEAVY, a command prefix that runs a job when the box is free to share (default: none). PYTHON
# (default python3; 3.13 here, standard library only). quick writes into results/quick/ so it never
# overwrites the full results. Every process stays under 4 GB (the biggest bound holds 1,092,334 states for
# the design; the ablation stops a run at 1,300,000).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"
HEAVY=${HEAVY-}
PY=${PYTHON:-python3}
export PYTHON=$PY
export PYTHONDONTWRITEBYTECODE=1   # no bytecode files next to the other experiments' sources
CLI=../E16-controller-loop/engine/cli.py
ABL=../E20-dedup/ablate20.py
B5M=../E57-transforms/b-merge/models/derived2.py
STEP=${1:-all}
stamp() { echo "# $1, $(date -u +%FT%TZ), $($PY --version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }

run_core() {   # $1: results folder, $2: seeds per world
  R=$1; N=$2
  mkdir -p "$R"
  { stamp "E-61 design runs: every bound, every property listed"
    $HEAVY $PY $CLI models/marks.py design --all-fails; } > "$R/design.txt" 2>&1
  rm -f "$R/reach.jsonl" "$R/variants.jsonl" "$R/mutants.jsonl" "$R/walks.jsonl" "$R/walks-run.jsonl"
  $HEAVY $PY harness/reach.py "$R/reach.jsonl" > /dev/null
  # each removal on the ablation's 40 bounds; the other paths, which should hold, on all 42 (not in quick)
  $HEAVY $PY harness/variants.py "$R/variants.jsonl" mark-apart mark-first key-slot key-name no-wnum nondet unpaced \
    marks-tail marks-marked judge-com skip-ahead no-bare fenced-mark > /dev/null
  $HEAVY $PY harness/variants.py "$R/variants.jsonl" design --drop read.fnret --drop cursor.fnret > /dev/null
  $HEAVY $PY harness/variants.py "$R/variants.jsonl" stop-refuse --drop refuse.mark > /dev/null
  $HEAVY $PY harness/variants.py "$R/variants.jsonl" stop-refuse start-fresh resend-any marks-joined $ALLB > /dev/null
  $HEAVY $PY harness/variants.py "$R/variants.jsonl" start-fresh --drop cursor.ahead $ALLB > /dev/null
  $HEAVY $PY harness/mutants.py "$R/mutants.jsonl" > "$R/mutants.txt"
  $HEAVY sh harness/traces.sh > "$R/traces.txt" 2>&1
  # the derive worlds and the run worlds side by side, then one file
  WORLDS="w-derive w-derive-cut" $HEAVY sh harness/walks.sh "$R/walks.jsonl" "$N" &
  WORLDS="w-run w-run-cut" $HEAVY sh harness/walks.sh "$R/walks-run.jsonl" "$N"
  wait
  cat "$R/walks-run.jsonl" >> "$R/walks.jsonl"
  rm -f "$R/walks-run.jsonl"
}

ablate() {
  rm -f results/design-ablation.json results/design-ablation.json.cache
  $HEAVY $PY $ABL design results/design-ablation.json --model models/marks.py --limit 1300000 \
    > results/design-ablation.log 2>&1
  rm -f results/design-ablation.json.cache
  $HEAVY $PY harness/probe.py > results/probe.txt 2>&1   # fence.oseq on a smaller move bound (reads the ablation)
  if [ "${B5:-0}" = 1 ]; then
    rm -f results/b5-ablation.json results/b5-ablation.json.cache
    $HEAVY $PY $ABL srchi-slot-w results/b5-ablation.json --model $B5M > results/b5-ablation.log 2>&1
    rm -f results/b5-ablation.json.cache
  fi
}

case "$STEP" in
  quick) ALLB=; run_core results/quick 100 ;;
  core) ALLB=--all; run_core results 1000 ;;            # full's steps but the ablation
  ablate) ablate ;;                                      # the ablation alone (it can run beside `core`)
  full|all)
    ALLB=--all; run_core results 1000
    ablate
    if [ "$STEP" = all ]; then $PY harness/report.py > results/summary.md; fi ;;
  report) $PY harness/report.py > results/summary.md ;;
  *) echo "usage: run.sh [quick | full | core | ablate | report]"; exit 1 ;;
esac
