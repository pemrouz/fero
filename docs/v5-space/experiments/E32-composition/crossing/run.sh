#!/bin/sh
# E-32 (b): the composed model of the riskiest crossing. Re-runs every result in results/.
#
#   ./run.sh              every step, in order
#   ./run.sh base         step 1: E-17's slot model reproduced, and the port checked against it
#   ./run.sh design       every bound in full, with liveness (the two largest bounds are partial)
#   ./run.sh found        the one counterexample found while composing, before its fix
#   ./run.sh carry        the floor, the mark and the lock token, each dropped where it is the only guard
#   ./run.sh mutants      DEV-10 (d): the one-rule mutants of the composed model as designed
#   ./run.sh ablate       DEV-10 (c): the rules added at the crossing (every other rule kept)
#   ./run.sh report       results/*.md from the checkpoints
#   ./run.sh review       the review's checks: re-runs, the source's log drop mid-move, the review
#                         bounds, the election probe, four planted bugs (results/review.txt)
#   ./run.sh union        NOT RUN (CPU budget): the smallest composed model, from the single
#                         experiments' smallest sets, and its mutants
#
# Needs Python 3.13 (standard library only) and E-17's harness and E-16's and E-17's result files
# beside this folder (../../E17-partitioning, ../../E16-controller-loop). Nothing is downloaded.
# Every model check runs under the study's heavy lock, in pieces of at most about 25 minutes; a piece
# that runs out of time exits 3 and the loop starts the next one from the checkpoint.
# Big files (checkpoints with every trace) stay in $SP/e32b; results/ holds the trimmed tables.
set -eu
cd "$(dirname "$0")"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="$SP/bin/heavy"
[ -x "$HEAVY" ] || HEAVY=""
W="$SP/e32b"
mkdir -p "$W" results
JOBS="${JOBS:-2}"

pieces() {    # run a resumable command until it stops asking for another piece
    while :; do
        set +e
        timeout 1780 $HEAVY "$@"
        rc=$?
        set -e
        [ "$rc" -eq 3 ] || [ "$rc" -eq 124 ] || break
    done
    return "$rc"
}

step_base() {
    { echo "# E-17's slot model, unchanged, against E-17's stored results"
      $HEAVY python3 model/repro_base.py
      echo
      echo "# this port, with every added part switched off, against the same"
      $HEAVY python3 model/crun.py --base; } | tee results/base.txt
}

SMALL=src,dst,src-dst,dst-src,mark-src,mark-dst,remit-src,remit-dst,lock-src,lock-dst,read-src,read-dst,giveup-src,giveup-dst,crash-src,crash-dst
MID=floors-src,floors-dst,floore-src,floore-dst,floor-src,floor-dst,twice-src,twice-dst,slots-src,slots-dst
BIG=heal2-src,heal2-dst
PARTIAL=any,all

step_design() {
    rm -f "$W/design.json"
    for set in $SMALL $MID $BIG; do
        timeout 1780 $HEAVY python3 model/crun.py --design "$W/design.json" --only "$set" --limit 3000000
    done | tee "$W/design.txt"
    # the two largest: as many states as fit one lock hold each (partial)
    for b in any all; do
        timeout 1780 $HEAVY python3 model/crun.py --design "$W/design.json" --only "$b" --limit 2500000
    done | tee -a "$W/design.txt"
    grep -v '^    [a-z0-9-]*: [0-9,]* expanded' "$W/design.txt" > results/design.txt
    python3 model/creport.py design "$W/design.json" > results/design.md
}

step_found() {
    { echo "# the composed model without refuse.above (E-20's stale rule on E-17's refusal path)"
      $HEAVY python3 model/crun.py --bound floors-src --drop refuse.above; } | tee results/found-refuse-above.txt
}

step_carry() {
    { for b in floore-src floore-dst; do
        for d in write.above final.floor snap.floor snap.outs final.outs write.floor; do
          $HEAVY python3 model/crun.py --bound "$b" --drop "$d" | head -1
        done
      done
      for b in remit-src remit-dst; do
        for d in write.mark final.mark snap.mark write.src; do
          $HEAVY python3 model/crun.py --bound "$b" --drop "$d" | head -1
        done
      done
      for b in lock-src lock-dst; do
        for d in write.fence final.tok snap.tok refuse.stale; do
          $HEAVY python3 model/crun.py --bound "$b" --drop "$d" | head -1
        done
      done
      echo; echo "# three shortest traces in full"
      $HEAVY python3 model/crun.py --bound remit-src --drop snap.mark
      $HEAVY python3 model/crun.py --bound remit-src --drop final.mark
      $HEAVY python3 model/crun.py --bound floore-src --drop snap.floor; } | tee results/carry-checks.txt
}

step_mutants() {
    pieces python3 model/cmut.py --out "$W/mutants.json" --jobs "$JOBS" --budget 1250 | tee -a "$W/mutants.log"
}

step_ablate() {
    # pass 1 reuses the G and U mutants (dropping one rule alone is that mutant): run `mutants` first
    pieces python3 model/cabl.py --out "$W/abl-added.json" --stage added --seed "$W/mutants.json" \
        --jobs "$JOBS" --budget 1250 | tee -a "$W/abl-added.log"
}

step_union() {    # not run for this README (CPU budget); kept so the next agent can
    pieces python3 model/cabl.py --out "$W/abl-union.json" --stage union --added-from "$W/abl-added.json" \
        --jobs "$JOBS" --budget 1400 | tee -a "$W/abl-union.log"
    drop=$(python3 -c "import json,sys; print(','.join(json.load(open(sys.argv[1]))['result']['removed']))" "$W/abl-union.json")
    pieces python3 model/cmut.py --out "$W/mutants-small.json" --base-drop "$drop" --jobs "$JOBS" --budget 1400 \
        | tee -a "$W/mutants-small.log"
}

step_review() {   # the review's checks (README, "Review"); about 1 CPU-hour
    { echo "# E-32 (b) review: every check the review ran (README, \"Review\"), raw output"
      echo
      echo "## 1. re-runs of the smallest bound and two larger ones (compare with results/design.txt)"
      for b in src slots-dst heal2-src; do
          timeout 1780 $HEAVY python3 model/crun.py --design "$W/review-rerun.json" --only "$b" --limit 3000000
      done | grep -v ' expanded, '
      [ -f "$W/design.json" ] && python3 -c "
import json, sys
a, b = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
for k in b:
    print(f'{k:10} state digest {\"SAME as\" if a[k][\"digest\"] == b[k][\"digest\"] else \"DIFFERENT from\"} the stored run')
" "$W/design.json" "$W/review-rerun.json"
      echo
      echo "## 2. DESIGN-V5 4.1's guard (snap.nomove) dropped: the source may drop its log while a move copies from it"
      for b in src dst dst-src src-dst floor-src twice-src twice-dst slots-src heal2-src; do
          timeout 1780 $HEAVY python3 model/crun.py --bound "$b" --drop snap.nomove --all --limit 4000000 | head -1
      done
      echo
      echo "## 3. the review bounds (cbounds.py REVIEW): in full with liveness, or partial where marked"
      for b in read2-src read2-dst crash2-src; do
          timeout 1780 $HEAVY python3 model/crun.py --design "$W/review-bounds.json" --only "$b" --limit 3000000
      done | grep -v ' expanded, '
      echo
      echo "## 4. does any election ever see a live voter behind the log?"
      $HEAVY python3 model/creview.py stale src dst crash-src crash-dst giveup-dst crash2-src
      $HEAVY python3 model/creview.py stale all --limit 1000000
      echo
      echo "## 5. four planted bugs (model/creview.py): each on src, then on the smallest bound that reaches it"
      $HEAVY python3 model/creview.py plant --work "$W/plant"
      echo
      echo "## 6. mutants equivalent on the 18 sweep bounds, run on bounds outside the sweep"
      $HEAVY python3 model/crun.py --bound read2-src --drop read.next | head -1
      for f in write.above refuse.above; do
          timeout 1780 $HEAVY python3 model/crun.py --bound floor-src --flip "$f" | head -1
      done
    } | tee results/review.txt
}

step_report() {
    python3 model/cmut.py --out "$W/mutants.json" --report > results/mutants.md
    python3 model/creport.py ablation "$W/abl-added.json" > results/ablation.md
    python3 model/crun.py --rules > results/rules.txt
    { uname -srm; python3 --version; nproc; grep MemTotal /proc/meminfo; } > results/machine.txt
}

case "${1:-all}" in
    base) step_base ;;
    design) step_design ;;
    found) step_found ;;
    carry) step_carry ;;
    mutants) step_mutants ;;
    ablate) step_ablate ;;
    union) step_union ;;
    review) step_review ;;
    report) step_report ;;
    all) step_base; step_design; step_found; step_carry; step_mutants; step_ablate; step_report ;;
    *) echo "unknown step: $1" >&2; exit 2 ;;
esac
