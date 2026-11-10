#!/bin/sh
# E-14c: E-14b finished. Two of etcd's shipped invariants replaced by the
# properties Raft really needs (and shown to still catch real bugs), the
# liveness verdicts for three-disk and four, and mutant r19 settled.
#
#   ./run.sh              everything below, in order (several CPU-hours; every
#                         TLC segment takes the study's heavy lock for at most
#                         25 minutes, and no new segment starts in US Eastern
#                         peak hours, 8 AM to 2 PM on weekdays)
#   ./run.sh calib        step 1: the new invariant set on runs E-14b finished
#   ./run.sh bugs         step 2: do the replacements still catch real bugs?
#   ./run.sh sweep        step 3: three-disk and four, the liveness verdicts
#   ./run.sh full         step 3, optional: the runs that do not finish on
#                         this box (hours; they leave part-graphs)
#   ./run.sh r19          step 4: mutant r19, one term further
#   python3 tools/run14c.py --list           the runs steps 1 and 3 can name
#   python3 tools/run14c.py RUN --max-seg K   one run, continued for up to K segments
#
# Needs: java 21, python3 with numpy, what fetch.sh fetches, and E-14's and
# E-14b's model files next to this folder (read-only). Writes results/ and
# cfg/; big files (state graphs, checkpoints) stay in $SP/e14c/.
# Memory: one TLC run takes up to its heap plus about 0.5 GB; the runs below
# are started one at a time.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
cd "$HERE"
"$HERE/fetch.sh" > /dev/null
W="$SP/e14c/runs"
mkdir -p "$W"
step() { [ -z "$1" ] || [ "$1" = "$2" ]; }

# 1. The new set on runs E-14b finished (three-1c, three-1c1f, two-1c1f) or
#    stopped at a false alarm (one): the history variable's cost (states
#    against E-14b's) and the false alarm gone.
if step "$1" calib; then
  python3 tools/run14c.py three-1c three-1c1f one two-1c1f --redo
fi

# 2. The bugs: a lost disk back under its old id, three bugs planted in
#    etcdraft.tla, and E-14's mutants that E-14b caught with a replaced
#    invariant. Each planted bug is checked once per invariant set.
if step "$1" bugs; then
  python3 tools/bugs.py ghost minority anylog twovote mutants
fi

# 3. The liveness verdicts for three-disk and four.
if step "$1" sweep; then
  # (a) the judged part alone: terms up to 2, complete (minutes)
  E14C_KEEP=1 python3 tools/run14c.py three-disk-t2 four-t2 --heap 3g --max-seg 2
  # (b) the bounds' calibration: six scenarios that finish in full (one,
  #     three-1c1f and two-1c1f are step 1's; two and the two with a lost
  #     disk are run here), again with bound 1, bounds 1+2, bounds 1 to 4
  #     and all six
  python3 tools/run14c.py two two-1c1f-d three-1c1f-d --heap 3g --max-seg 2
  python3 tools/run14c.py two-1c1f-q two-1c1f-qc two-1c1f-qf two-1c1f-z one-q one-qf one-z \
      three-1c1f-q three-1c1f-qf three-1c1f-z two-qc two-qf two-z two-1c1f-dz three-1c1f-dz --heap 3g --max-seg 2
  # (c) the two scenarios at E-14b's bounds with all six bounds, to the end
  E14C_KEEP=1 python3 tools/run14c.py three-disk-z --heap 3g --max-seg 4
  E14C_KEEP=1 python3 tools/run14c.py four-z --heap 3g --max-seg 4
  # (d) the same with the healing-order rule "grow first"
  E14C_KEEP=1 python3 tools/run14c.py three-disk-g --heap 3g --max-seg 4
  E14C_KEEP=1 python3 tools/run14c.py four-g --heap 3g --max-seg 4
  # (e) the stuck states by kind, with the shortest trace to each kind
  for r in three-disk-z four-z three-disk-g four-g; do
    python3 tools/classify.py "$W/$r" 2 --trace > "$SP/e14c/$r-classify-trace.txt"
    sed -n '1,/^$/p' "$SP/e14c/$r-classify-trace.txt" > "results/$r-classify.txt"
    python3 tools/kindtrace.py "$r" "$SP/e14c/$r-classify-trace.txt" "results/$r"
  done
  # (f) the terms-up-to-2 runs against the full runs' part-graphs, when
  #     ./run.sh full has left them in $SP/e14c/runs (the same module files,
  #     so the same node ids: the judged states and their flags agree)
  for s in three-disk four; do
    if ls "$W/$s"/seg*.g.gz > /dev/null 2>&1; then
      python3 tools/partial.py "$W/$s-t2" "$W/$s" 2 --out "results/partial-$s.json" > "results/partial-$s.txt"
    fi
  done
  # (g) the judged states three-disk's part-graph reaches through a lost
  #     disk (needs its label files, which E14C_KEEP=1 leaves in the run folder)
  if ls "$W/three-disk"/seg*.l.* > /dev/null 2>&1; then
    python3 tools/missing.py "$W/three-disk-t2" "$W/three-disk" 2 "$W/three-disk" > results/three-disk-extra-judged.txt
  fi
fi

# 3, optional. The runs that do not finish on this box (README): the full
#    runs at E-14b's bounds (four segments of three-disk and three of four
#    are what E-14c ran, with the graph dump), and one segment each with
#    bounds 1+2 and with bounds 1 to 4.
if [ "$1" = full ]; then
  E14C_KEEP=1 python3 tools/run14c.py three-disk --max-seg 4
  E14C_KEEP=1 python3 tools/run14c.py four --max-seg 3
  python3 tools/entries.py "$W/four" > results/four-entries.txt
  E14C_KEEP=1 python3 tools/run14c.py three-disk-q four-q three-disk-qf four-qf --heap 3g --max-seg 1
fi

# 4. r19: the design and the mutant on m3 and m2p, terms up to 5, judged at
#    3, then the stuck states sorted by kind, with the shortest trace to each.
if step "$1" r19; then
  python3 tools/r19.py m3 m2p
  { echo "# tools/classify.py on design-m3-t5 (judged at term 3)"; python3 tools/classify.py "$W/design-m3-t5" 3
    echo; echo "# tools/classify.py on r19-m3-t5 (judged at term 3)"; python3 tools/classify.py "$W/r19-m3-t5" 3
  } > results/r19-classify.txt
  python3 tools/classify.py "$W/design-m3-t5" 3 --trace > "$SP/e14c/design-m3-t5-classify-trace.txt"
  python3 tools/kindtrace.py design-m3-t5 "$SP/e14c/design-m3-t5-classify-trace.txt" results/design-m3-t5
  python3 tools/classify.py "$W/r19-m3-t5" 3 --trace > "$SP/e14c/r19-m3-t5-classify-trace.txt"
  python3 tools/kindtrace.py r19-m3-t5 "$SP/e14c/r19-m3-t5-classify-trace.txt" results/r19
fi

python3 tools/table.py > /dev/null
