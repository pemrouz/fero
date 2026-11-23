#!/bin/sh
# E-59: groups that start at one voter (growth to three, a crash between the
# two promotions, the step back from two voters to one, a gone learner
# dropped) and a clean stop (a leave with no spare, leave.ms, a retire that
# stays pending, the leave of an only voter), with both answers to "a voter
# leaves with no spare": it stays in the config, absent (absent), or the group
# shrinks to two voters and steps back to one (shrink).
#
#   ./run.sh quick   about 10 CPU-minutes: both options on the small bounds,
#                    100 seeds per walk, the planted bugs (each must break a
#                    property), DUR on s1, the probes
#   ./run.sh         everything: every bound, the big bounds, DUR, 1,000 seeds
#                    on the small walks, planted bugs in the walks, the probes, the caps
#                    of P9, the hand-written mutants, whole sentences dropped,
#                    and pass 1 of the ablation of absent (DEV-10); several
#                    CPU-hours on a 4-CPU box
#
# Needs: python3 (standard library). Imports E-16's engine and E-17's dsl.py,
# unchanged. Every model run pins PYTHONHASHSEED=0 and caps its memory at
# 4 GB (MEMCAP_MB).
#
# Env: OUT    where results go (default: results; a rerun overwrites it)
#      HEAVY  a wrapper for long runs (for example a lock that keeps timing
#             runs alone on the box); default: none
#      CACHE  where the ablation keeps its run cache (default: ./cache, which
#             is not part of the results)
#      JOBS   worker processes for the ablation, mutants and sentences (default 2)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"
HEAVY="${HEAVY:-}"
CACHE="${CACHE:-cache}"
JOBS="${JOBS:-2}"
R="${OUT:-results}"
mkdir -p "$R" "$CACHE"
run() { $HEAVY "$@"; }
SMALL="solo r1 o1 o1d g0 o1f s1 rl g1"
BIG="g1w g2 gs gl2 s2f s1sf"

if [ "$1" = quick ]; then
  for o in absent shrink; do run python3 models/run.py $o $SMALL; done > "$R/quick-design.txt" 2>&1
  for o in absent shrink; do for w in w2 w3 w5s w5g; do
    run python3 models/walk.py $o $w --seeds 100 --depth 90; done; done > "$R/quick-walks.txt" 2>&1
  # planted bugs on small bounds: each must break the property named
  {
    run python3 models/run.py absent o1 --drop exitms.safe      # LW
    run python3 models/run.py absent o1 --drop exitalone.alone  # LX
    run python3 models/run.py absent solo --drop exitalone.stop # SF
    run python3 models/run.py absent s1 --drop exitms.held      # DX
    run python3 models/run.py absent o1 --drop write.stay       # LW
    run python3 models/run.py absent o1 --drop leave.mark       # SF
    run python3 models/run.py absent o1 --drop standby.notret   # P7
    run python3 models/run.py absent o1f --drop dropl.append    # DL
    run python3 models/run.py absent o1f --drop promote.pair    # P9
    run python3 models/run.py absent o1f --drop commit.own      # LW
    run python3 models/run.py absent r1 --drop win.maj          # DJ
    run python3 models/run.py absent s2 --drop ldead.append     # SF
    run python3 models/run.py shrink g1 --drop stepback.two     # CK
  } > "$R/quick-planted.txt" 2>&1
  for o in absent-dur shrink-dur; do run python3 models/run.py $o s1; done > "$R/quick-dur.txt" 2>&1
  run python3 models/probe.py traces > "$R/probes-traces.txt" 2>&1
  grep -h -E '^(absent|shrink)' "$R"/quick-*.txt
  exit 0
fi

# 1. The design on every bound (both options); the big bounds (to 1,000,000
#    states; a run that stops there is checked for safety only); DUR, a
#    safety property in the variants absent-dur and shrink-dur, on the bounds
#    that start at three voters (a group of one voter commits on one disk).
for o in absent shrink; do run python3 models/run.py $o; done > "$R/design.txt" 2>&1
#    g1w, g2 and gs have no leave and no retire hint, so both options are the
#    same model there: they run once, as absent.
{ for b in $BIG; do run python3 models/run.py absent $b --limit 1000000; done
  for b in gl2 s2f s1sf; do run python3 models/run.py shrink $b --limit 1000000; done; } > "$R/design-big.txt" 2>&1
for o in absent-dur shrink-dur; do run python3 models/run.py $o s1 s2 rl s1f4 s1f; done \
  > "$R/design-dur.txt" 2>&1 || true

# 2. The caps of P9: the design's longest run of config and placement entries.
for o in absent shrink; do run python3 models/maxchg.py $o solo r1 o1 o1d g0 o1f s1 rl r1s g1 gr s1s s2 r1f r1sd g0d; done \
  > "$R/maxchg.txt" 2>&1

# 3. Seeded walks on bounds too big to explore whole: the design, then the
#    probe of LAYERS 2.3 rule 1 as written and planted bugs.
#    1,000 seeds on w2 and w3, 300 on w5s and w5g (about 1.3 CPU-seconds a
#    seed there); this record also has absent on w5s with 1,000 seeds.
for o in absent shrink; do
  for w in w2 w3; do run python3 models/walk.py $o $w --seeds 1000 --depth 90; done
  for w in w5s w5g; do run python3 models/walk.py $o $w --seeds 300 --depth 90; done
done > "$R/walks.txt" 2>&1
{
  run python3 models/walk.py shrink-onevoter w5g --seeds 300 --depth 90
  for d in write.stay lrem.keep grow.small promote.pair stepback.noret exitms.safe exitalone.alone handover.voter; do
    for w in w3 w5g; do run python3 models/walk.py shrink $w --seeds 200 --depth 90 --drop $d; done
  done
} > "$R/walks-planted.txt" 2>&1

# 4. Probes: the named traces, where a clean stop ends, a retire that stays
#    pending, and the clean stop as the pages write it (no only-voter path,
#    no V4-60, exit at leave.ms whatever).
run python3 models/probe.py traces > "$R/probes-traces.txt" 2>&1
run python3 models/probe.py outcomes > "$R/probes-outcomes.txt" 2>&1
run python3 models/probe.py pending > "$R/probes-pending.txt" 2>&1
{
  run python3 models/run.py absent o1 s2 gl --drop opromote.append --drop lrem.append --drop ldead.append \
    --drop exitms.safe --drop exit.safe --drop exitms.held --drop exit.held
  run python3 models/run.py shrink o1 s1 s2 gl --drop exitms.safe --drop exit.safe --drop exitms.held \
    --drop exit.held
} > "$R/probes-as-written.txt" 2>&1

# 5. Hand-written mutants (both options, every bound) and whole sentences
#    dropped (the rule count at LAYERS' grain).
run python3 models/mutants.py --jobs $JOBS > "$R/mutants.txt" 2>&1
run python3 models/sentences.py absent shrink --jobs $JOBS > "$R/sentences.md" 2>&1

# 6. Pass 1 of the ablation (DEV-10, E-16's procedure): each design rule and
#    each Raft-core rule dropped alone, on the sweep bounds, then the verify
#    bounds (gr s1s s2 s1f) for a rule the sweep does not need. absent only:
#    shrink's pass 1 takes many more CPU-hours (set E59_SHRINK=1 to run it,
#    with s2 as its only verify bound). A stopped run resumes from its cache.
#    The greedy pass, the smallest model and its mutants: unset
#    E59_PASS1_ONLY (hours more; not run for this record).
export E59_SWEEP="solo r1 o1 o1d g0 o1f s1 rl r1s g1" E59_PASS1_ONLY=1
OPTS=absent; [ -n "$E59_SHRINK" ] && OPTS="absent shrink"
for o in $OPTS; do
  if [ $o = absent ]; then E59_VERIFY="gr s1s s2 s1f"; else E59_VERIFY="s2"; fi
  export E59_VERIFY
  run python3 models/ablate.py $o "$R/ablation-$o.json" --jobs $JOBS --limit 2000000 \
    --cache "$CACHE/ablation-$o.cache" > "$R/ablation-$o.log" 2>&1 || true
  python3 models/pass1.py $o "$CACHE/ablation-$o.cache" > "$R/pass1-$o.md"
done
