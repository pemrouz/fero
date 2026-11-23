#!/bin/sh
# E-60: the `view` selector and a folded resume in E-31's subscribe model.
# Two exhaustive models on E-16's engine (E-17's rule language, unchanged), a
# seeded random-walk checker for the bounds too big to finish, and a seeded
# harness for what a folded resume saves.
#   ./run.sh quick    both models' designs on their sweep and verify bounds, every
#                     planted bug and the strict reading of END, 100 seeds of the
#                     resume harness (about an hour on a quiet box)
#   ./run.sh full     quick, then: the bigger bounds in full, the partial bounds and
#                     their random walks, both ablations with mutants (resumable, in
#                     holds of at most 25 minutes), the rules whose drop stops at the
#                     state limit decided on the capped bounds and the smallest model
#                     finished there with its mutants, 1,000 seeds of the
#                     resume harness with its planted bugs, and the report
#   ./run.sh check | big | partial | ablate | decide | sim | report    one step
# The ablation resumes from results/*-ablation.json.cache; delete the cache, the
# .prerun mark and the .json to run it afresh after a model change (the cache key
# does not hold the model's text).
# Every model step runs under $SP/bin/heavy and under a 4 GB address-space limit.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/fero-sp}"
HEAVY="${HEAVY-$SP/bin/heavy}"
CLI="$HERE/../E16-controller-loop/engine/cli.py"
REPORT="$HERE/../E16-controller-loop/engine/report.py"
R="$HERE/results"
MODE="${1:-quick}"
case "$MODE" in
  quick) STEPS="check simq" ;;
  full) STEPS="check big partial ablate decide sim report" ;;
  *) STEPS="$*" ;;
esac
mkdir -p "$R"
cd "$HERE"
ulimit -v 4000000
want() { for s in $STEPS; do [ "$s" = "$1" ] && return 0; done; return 1; }
hdr() { echo "# $1, $(date -u +%FT%TZ), $(python3 --version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }
run() { $HEAVY timeout 1500 "$@"; }

if want check; then
  hdr 'view: the design, then the strict reading of END and each planted bug, on the sweep and verify bounds' > $R/view-design.txt
  for o in view strict copyinst incinst framepos ownseq leadserve noinst endatfold picfits; do
    run python3 $CLI models/view.py $o --limit 3500000 >> $R/view-design.txt 2>&1
  done
  run python3 $CLI models/view.py strict --bound mvbig --limit 3500000 >> $R/view-design.txt 2>&1
  hdr 'view: are the scenarios the review asked about reached? (cover.py: each marker is reported like a broken property)' > $R/view-cover.txt
  run python3 cover.py bfo fifo fo2 big >> $R/view-cover.txt 2>&1
  hdr 'resume: E-31 as designed, the folded resume, and the planted torn base and first version' > $R/resume-design.txt
  for o in e31 fold torn firstver; do
    run python3 $CLI models/resume.py $o --limit 3500000 >> $R/resume-design.txt 2>&1
  done
fi
if want big; then
  hdr 'view: the bigger bounds, in full, on the design (limit 3,500,000 states)' > $R/view-big.txt
  for b in fifo2 fo2all big2 mvbig bfo2; do
    run python3 $CLI models/view.py view --bound $b --limit 3500000 >> $R/view-big.txt 2>&1
  done
  hdr 'resume: the move with two faults, in full, on the folded resume and on E-31' > $R/resume-big.txt
  for o in fold e31; do
    run python3 $CLI models/resume.py $o --bound mv2 --limit 3500000 >> $R/resume-big.txt 2>&1
  done
fi
if want partial; then
  hdr 'view: the bounds that do not finish, stopped at 3,000,000 states, then 20,000 random walks each' > $R/view-partial.txt
  for b in mv2 all2; do
    run python3 $CLI models/view.py view --bound $b --limit 3000000 >> $R/view-partial.txt 2>&1
    run python3 walk.py models/view.py view $b --walks 20000 --depth 120 >> $R/view-partial.txt 2>&1
  done
  run python3 walk.py models/view.py strict all2 --walks 20000 --depth 120 >> $R/view-partial.txt 2>&1
fi
if want ablate; then
  for m in view:view resume:fold; do
    model=${m%%:*}; opt=${m#*:}; out=$R/$model-ablation.json
    n=0
    # pass 1 in three processes (prerun.py), into the cache ablate.py reads
    until [ -f $out.prerun ] || [ -f $out ]; do
      n=$((n + 1)); [ $n -le 20 ] || { echo "pass 1 of $model did not end in 20 holds" >&2; exit 1; }
      run python3 prerun.py models/$model.py $opt $out --jobs 3 --limit 1000000 || true
    done
    n=0
    until [ -f $out ]; do
      n=$((n + 1)); [ $n -le 20 ] || { echo "ablation of $model did not end in 20 holds" >&2; exit 1; }
      run python3 ablate.py models/$model.py $opt $out --limit 1000000 || true
    done
  done
fi
if want decide; then
  hdr 'view: the rules whose drop stopped at the state limit, decided on the capped bounds (decide.py)' > $R/view-limited.txt
  # one piece per hold: the design and the smallest model on the capped bounds, then each such rule
  for w in design minimal; do run python3 decide.py $R/view-ablation.json $w >> $R/view-limited.txt 2>&1; done
  for r in $(python3 -c "import json; print(' '.join(json.load(open('$R/view-ablation.json'))['limited']))"); do
    run python3 decide.py $R/view-ablation.json alone $r >> $R/view-limited.txt 2>&1
  done
  for r in $(python3 -c "import json; o = json.load(open('$R/view-ablation.json')); print(' '.join(x['rule'] for x in o['mutants'] if x['kind'] == 'drop' and x.get('undecided')))"); do
    run python3 decide.py $R/view-ablation.json mutant $r >> $R/view-limited.txt 2>&1
  done
  # the smallest model finished on the capped bounds, and its mutants (capped.py; resumable)
  n=0
  until [ -f $R/view-capped.json ]; do
    n=$((n + 1)); [ $n -le 20 ] || { echo "capped.py did not end in 20 holds" >&2; exit 1; }
    run python3 capped.py $R/view-ablation.json $R/view-capped.json > $R/view-capped.txt 2>&1 || true
  done
fi
if want sim; then
  hdr 'resume harness: 1,000 seeds, then each planted bug' > $R/resume-sim.txt
  rm -f $R/resume-sim.jsonl
  for p in '' window tombs versions gcfloor; do
    run python3 resume_sim.py --seeds 1000 ${p:+--plant $p} --out $R/resume-sim.jsonl > /dev/null
  done
  python3 summarize.py sim $R/resume-sim.jsonl >> $R/resume-sim.txt
fi
if want simq; then
  run python3 resume_sim.py --seeds 100 | python3 summarize.py sim -
fi
if want report; then
  {
    python3 $REPORT $R/view-ablation.json $R/resume-ablation.json
    python3 summarize.py ablation $R/view-ablation.json $R/resume-ablation.json
  } > $R/summary.md
fi
