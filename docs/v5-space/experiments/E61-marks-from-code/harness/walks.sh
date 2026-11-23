#!/bin/sh
# E-61 seeded walks: the design, each removal and each rule dropped, on the four big worlds (models/marks.py WALKS).
#   sh harness/walks.sh OUT.jsonl SEEDS
# Each line of OUT.jsonl is one (option or rule drop, world) with SEEDS seeds. WORLDS picks the worlds (default
# all four), so two halves can run side by side into two files.
set -eu
OUT=$1; N=$2
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
# in the -cut worlds a cut weighs 0.02 against 1 for any other step, so that cuts land late as often as early
w() { $PY harness/walk.py "$@" --seeds "$N" --chaos 200 --cutw "$CW" --out "$OUT" > /dev/null; }
for b in ${WORLDS:-w-derive w-run w-derive-cut w-run-cut}; do
  case $b in *-cut) CW=0.02 ;; *) CW=1 ;; esac
  for o in design mark-apart mark-first key-slot key-name no-wnum nondet unpaced marks-tail marks-marked judge-com \
           skip-ahead no-bare fenced-mark stop-refuse resend-any; do
    w "$o" "$b"
  done
  for r in read.paced read.fnret read.number resync.kept resync.jump expire.stale expire.stop bare.read bare.idle \
           bare.send cursor.answered cursor.fnret cursor.fence cursor.ahead apply.inorder apply.above apply.mark \
           skip.inorder skip.below skip.say refuse.inorder refuse.above refuse.mark fenced.inorder fenced.above \
           bmark.inorder bmark.above bmark.mark fence.carry fence.oseq open.carry; do
    w design "$b" --drop "$r"
  done
  w design "$b" --drop bare.idle --drop bmark.inorder   # the two the ablation dropped together (K10)
done
