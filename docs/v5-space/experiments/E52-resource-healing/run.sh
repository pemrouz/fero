#!/bin/sh
# E-52: healing when each resource is its own cluster (no #meta, no shared
# member list), with the platform's hints, retiring, drains and V5-7's
# hand-back; DEV-10's count by ablation and mutants.
#
#   ./run.sh            everything below (about 9 hours of wall time on a quiet
#                       4-CPU box, in pieces of at most 50 minutes under the
#                       heavy lock; the ablation resumes from its cache within
#                       one run)
#   ./run.sh check      only steps 1 to 4: the caps, the design, the shapes
#                       without a stored placement and the probes (about 4
#                       CPU-hours)
#
# Needs: python3 (standard library). Imports E-16's engine and heal.py and
# E-17's harness/dsl.py unchanged. Writes results/. PYTHONHASHSEED is pinned
# by E-16's engine/cli.py and by models/par.py, finish.py, checks.py.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY:-$SP/bin/heavy}"
CLI="$HERE/../E16-controller-loop/engine/cli.py"
M=models/resheal.py
SWEEP="hl0 hln hp0 hd0 l1 hgn four1 f1 ll2 hg1 lh1"
cd "$HERE"
mkdir -p results

# 1. The caps of P9 and P9L: the design's longest run of changes and of
#    transfers after one outside event, per bound. MAXCHG in the model is
#    set from this file (twice the longest run, at least 8 and 4).
"$HEAVY" timeout 1500 python3 models/maxchg.py $M $SWEEP hpl0 hd2 hh0 lhh h1 lf1 \
  > results/maxchg.txt 2>&1 || true
LIMIT=5000000 "$HEAVY" timeout 3000 python3 models/maxchg.py $M f2 ll2f > results/maxchg-big.txt 2>&1 || true

# 2. The design on every bound (liveness included), the two-hint bounds, and
#    the two big bounds (f2: two faults; ll2f: one fault and two leaves).
"$HEAVY" timeout 1500 sh -c "for b in $SWEEP h1 lf1; do
  python3 $CLI $M res --bound \$b --limit 6000000; done" > results/design-res.txt 2>&1 || true
"$HEAVY" timeout 1500 sh -c "for b in hh0 lhh hpl0 hd2; do
  python3 $CLI $M res --bound \$b --limit 6000000; done" > results/design-twohints.txt 2>&1 || true
"$HEAVY" timeout 3000 sh -c "python3 $CLI $M res --bound f2 --limit 9000000
  python3 $CLI $M res --bound ll2f --limit 6000000" > results/design-res-big.txt 2>&1 || true

# 3. Rule 15 as a design choice: the same healing with no stored placement:
#    picks by load and nothing stored (free), a target every leader computes
#    the same way (ring), or picks by load with a retiring voter removed
#    first (retfirst).
"$HEAVY" timeout 3000 sh -c "for o in free ring retfirst; do for b in f1 four1 l1 ll2 lh1 hg1 hgn hl0 hd0 h1 lf1; do
  python3 $CLI $M \$o --bound \$b --limit 6000000; done; done" > results/noplace.txt 2>&1 || true
"$HEAVY" timeout 3000 sh -c "for o in free ring retfirst; do
  python3 $CLI $M \$o --bound f2 --limit 6000000; done" > results/noplace-f2.txt 2>&1 || true

# 4. Probes. P7 judged on every target (lf1p7) and SWAP's stuck states as a
#    failure with a trace (lf1swap), in the design (res), with promote.live
#    as E-16 wrote it, "not gone" (resgone), with the leader forgetting what
#    a machine said once its link drops (resnow), and with both first
#    readings at once (resgonenow, this model's first version); and
#    resgone on h1 and lf1, where it breaks P2C. Then the design with E-16's
#    links, where the leader reaches every live machine on its side
#    (resopen), against the design's links to group members and dialed
#    machines only.
#    (--all-fails: every state explored and every property judged, so a P2C
#    failure does not hide what the liveness checks find.)
"$HEAVY" timeout 3000 sh -c "for o in res resgone resnow resgonenow; do for b in lf1p7 lf1swap; do
  python3 $CLI $M \$o --bound \$b --limit 4000000 --all-fails; done; done
  for b in h1 lf1; do python3 $CLI $M resgone --bound \$b --limit 4000000; done" > results/probe-heard.txt 2>&1 || true
"$HEAVY" timeout 1500 sh -c "for b in $SWEEP h1; do python3 $CLI $M resopen --bound \$b --limit 4000000; done
  for d in leave.unlist pick.notret dial.link pick.cand add.cand; do for o in res resopen; do
    for b in $SWEEP; do python3 $CLI $M \$o --bound \$b --drop \$d --limit 900000 | head -12; done; done; done" \
  > results/probe-links.txt 2>&1 || true
[ "$1" = check ] && exit 0

# 5. The ablation and the mutants (DEV-10), as E-16 ran them (models/finish.py:
#    E-16's Ablation.run with three small changes to how the verify bounds
#    are read, see the README), with the independent runs done first on 3
#    cores (models/par.py fills the cache the ablation reads; each piece at
#    most 25 minutes, resumable). Old outputs go first, so nothing stale is
#    read: the cache key holds no model hash.
NOMUT=results/res-ablation-nomut.json
OUT=results/res-ablation.json
rm -f $NOMUT $NOMUT.cache $OUT $OUT.cache results/res-ablation.log
export LIMIT=900000 VLIMIT=5000000
for mode in pass1 verify1; do
  n=0
  until "$HEAVY" timeout 1500 python3 models/par.py $M res $NOMUT.cache $mode 3 >> results/res-ablation.log 2>&1 \
      || [ $n -ge 12 ]; do n=$((n + 1)); done
done
n=0
while [ ! -s $NOMUT ] && [ $n -lt 24 ]; do
  "$HEAVY" timeout 3000 python3 models/finish.py $M res $NOMUT --no-mutants --limit $LIMIT --vlimit $VLIMIT \
    >> results/res-ablation.log 2>&1 || true
  n=$((n + 1))
done
n=0
until MUTANTS_FROM=$NOMUT "$HEAVY" timeout 3000 python3 models/par.py $M res $NOMUT.cache mutants 3 \
    >> results/res-ablation.log 2>&1 || [ $n -ge 12 ]; do n=$((n + 1)); done
cp -f $NOMUT.cache $OUT.cache
n=0
while [ ! -s $OUT ] && [ $n -lt 24 ]; do
  "$HEAVY" timeout 3000 python3 models/finish.py $M res $OUT --limit $LIMIT --vlimit $VLIMIT \
    >> results/res-ablation.log 2>&1 || true
  n=$((n + 1))
done
rm -f $NOMUT.cache
python3 ../E16-controller-loop/engine/report.py $OUT > results/summary.md
python3 models/count.py $OUT >> results/summary.md

# 6. Checks on the smallest model the ablation left: the two-hint bounds,
#    E-17's put-back step on lhh (where the smallest model breaks LD),
#    covering pairs (the hand-back with Raft's own transfer guards put
#    back), and the two big bounds to 6,000,000 states.
"$HEAVY" timeout 1500 python3 models/checks.py $M $OUT twohints 4000000 > results/checks-twohints.txt 2>&1 || true
"$HEAVY" timeout 3000 python3 models/checks.py $M $OUT putback 2000000 lhh > results/checks-lhh-putback.txt 2>&1 || true
"$HEAVY" timeout 3000 python3 models/checks.py $M $OUT cover 5000000 > results/checks-cover.txt 2>&1 || true
"$HEAVY" timeout 3000 python3 models/checks.py $M $OUT big 6000000 f2 ll2f > results/checks-big.txt 2>&1 || true
