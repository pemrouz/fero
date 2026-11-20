#!/bin/sh
# E-57: transformations in fero v5, built small on data's real engine. Runs both parts, each with its own run.sh:
#   a-served/  served views (class C) and pushdown (class B): A1-A8 and XA-1 to XA-13 (XA-14 is a model job, not here)
#   b-merge/   across partitions, resources and time: B1-B6 and XB-1 to XB-13
#   ./run.sh                 both parts in full, one after the other (group A, then group B)
#   ./run.sh a [step]        group A only; step is one of a-served/run.sh's: sims mutants timing types summary, and
#                            (added after the skeptic's review) xa2more pagecost
#   ./run.sh b [step]        group B only; step is one of b-merge/run.sh's: sims timing model b1 b1m b2 b3 b4 b6 xb, and tpages
# probes/run.sh runs the small probes TRANSFORMS.md cites (see probes/README.md).
#   ./run.sh summary         both parts' results in short, from the results files already there (runs nothing timed)
# Env: SP (required): a scratch folder of your own. It holds bin/timing (runs a command alone on the box) and bin/heavy
# (shares the box, waits for timing runs), and for group B dl/esbuild (E-40's fetch.sh), which bundles data once.
# NODE (default node on PATH, Node 22.22.0; group A takes tsc 6.0.2 from PATH). RUNS (default
# "1 2 3"), SEEDS (default 1000), DATA (data's folder, default ../data next to this repo, at 63fea66, read only).
# Group B's model step needs Python 3 and E-16's engine at ../E16-controller-loop (E-30's model is imported, not edited).
# Memory: every process runs with --max-old-space-size of 3000 (group A) or 3500 (group B), and the parts run one after
# the other, so no two big processes share the box. Results append to each part's results/*.jsonl: move the old files
# away first for a clean rerun. Group B's full run includes B1 at 1e5 commits (about 35 minutes of CPU) and the full
# B5 ablation (stopped after 50 minutes by a timeout); group A's sims and mutants take about 7 minutes of CPU.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
: "${SP:?set SP to a scratch folder (it holds bin/timing, bin/heavy and dl/esbuild)}"
NODE=${NODE:-node}
export SP NODE
part() { dir=$1; shift; echo "== E-57 $dir $* =="; sh "$HERE/$dir/run.sh" "$@"; }
case "$1" in
  a) shift; part a-served "$@" ;;
  b) shift; part b-merge "$@" ;;
  summary)
    echo "== E-57 a-served: results/summary.md =="; (cd "$HERE/a-served" && $NODE summarize.mjs)
    echo "== E-57 b-merge =="; (cd "$HERE/b-merge" && $NODE summarize.mjs) ;;
  "") part a-served; part b-merge; echo "== E-57: done; see a-served/results/summary.md and 'node b-merge/summarize.mjs' ==" ;;
  *) echo "usage: run.sh [a [step] | b [step] | summary]"; exit 1 ;;
esac
