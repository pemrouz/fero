#!/bin/sh
# E-64: four ways past one process, built small. Each option has its own run.sh; this one calls them.
#   O1/  the merger: partials by group, merged by key (E-23's design)        steps: sim bench S quick all
#   O2/  derive from the change stream alone, with before-images            steps: sims topk rate timing bytes summary quick
#   O3/  partials by slot, merged by key                                    steps: sim bench S quick all
#   O4/  a view sharded by its output key                                   steps: sims mutants long timing bytes summary quick
#   probes/move-failover.mjs  O1 when a partial's host fails while a slot move is queued (after the skeptic)
#
#   ./run.sh                 every option in full, one after the other (hours: O1's and O3's long runs, every
#                            option's 1,000-seed runs and three timed runs each), then the probe
#   ./run.sh o1 [step]       one option; the step is that option's own (its run.sh header lists them)
#   ./run.sh quick           a smoke run of every option and the probe, no locks, about five minutes
#   ./run.sh probe           the probe alone; it prints one line per case and writes probes/move-failover.out
#   ./run.sh summary         each option's results in short, from the results files already there (runs nothing)
# Env: SP (a scratch folder of your own holding bin/timing, which runs a command alone on the box, and bin/heavy,
# which shares the box but waits for timing runs; without them the locks are skipped). NODE (default node on
# PATH, Node 22.22.0). DATA (data's folder, default ../data next to this repo, at 63fea66, read only).
# O1 and O3 run each process with --max-old-space-size=3500, O2 and O4 likewise, so every process stays under
# 4 GB. Results go to each option's results/ folder; move the old files away first for a clean rerun.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
export NODE
opt() { d=$1; shift; echo "== E-64 $d $* =="; sh "$HERE/$d/run.sh" "$@"; }
probe() { echo "== E-64 probe: move-failover =="; (cd "$HERE" && $NODE probes/move-failover.mjs | tee probes/move-failover.out); }
case "$1" in
  o1|O1) shift; opt O1 "${@:-all}" ;;
  o2|O2) shift; opt O2 "$@" ;;
  o3|O3) shift; opt O3 "${@:-all}" ;;
  o4|O4) shift; opt O4 "$@" ;;
  probe) probe ;;
  quick) opt O1 quick; opt O2 quick; opt O3 quick; opt O4 quick; probe ;;
  summary)
    for d in O1 O2 O3 O4; do echo "== E-64 $d: results/summary.md =="; sed -n '1,40p' "$HERE/$d/results/summary.md"; done
    echo "== E-64 probe =="; cat "$HERE/probes/move-failover.out" ;;
  "") opt O1 all; opt O2; opt O3 all; opt O4; probe; echo "== E-64: done; see README.md and each option's results/ ==" ;;
  *) echo "usage: run.sh [o1|o2|o3|o4 [step] | quick | probe | summary]"; exit 1 ;;
esac
