#!/bin/sh
# E-51: founding and finding a resource when each resource is its own
# cluster (DECISIONS V5-2, V5-3). Eight small models on E-16's engine and
# E-17's rule language (DEV-10's ablation and mutants):
#   models/found.py        per-resource genesis by create-if-absent: a candidate id on disk first, two names, the settings record, the seed
#   models/catalog.py      the settings record changed online: a code-hash roll, the write gate, cross-key checks
#   models/records.py      a group's record in the home log: write (and write again while it differs), newest wins, removed-copy GC, deletion
#   models/incarnation.py  an operator recovery's incarnation, and old copies that must stop
#   models/dirtable.py     the soft directory's table, rebuilt from announcements alone
#   models/client.py       a client's lookup, HELLO check, members from the resource, blackout
#   models/place.py        healing finds machines through machine entries; a leaver retires first
#   models/fold.py         v4's host: the published peer table, seen-on-register and the grace
#
#   ./run.sh            everything (about 25 minutes of CPU from empty caches, measured 2026-11-14:
#                       found's two2 bound alone takes 7 minutes and 5.5 GB; each piece under the heavy lock)
#   ./run.sh check      only the designs and the probes
#
# The engine prints "(STOPPED AT THE STATE LIMIT)" after any run it did not
# finish, and a run that stops at its first counterexample is one of them:
# in results/probes.txt the label means "stopped at the first failure".
#
# The ablation caches (results/*.cache) are keyed by rule set and bound, not
# by the model's text, so each cache is kept only while a hash of the model,
# the engine and the rule language is the one it was made with (skeptic F12).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY:-$SP/bin/heavy}"
[ -x "$HEAVY" ] || HEAVY=""
CLI="$HERE/../E16-controller-loop/engine/cli.py"
ENG="$HERE/../E16-controller-loop/engine/engine.py $HERE/../E17-partitioning/harness/dsl.py"
cd "$HERE"
mkdir -p results
python3 -c 'import sys, platform; print(platform.python_version(), platform.machine())' > results/versions.txt
nproc >> results/versions.txt
# The designs, every bound, every property broken listed (none should be).
$HEAVY timeout 3000 sh -c "
  python3 $CLI models/found.py objcas --all-fails --limit 8000000 --bound one1 --bound two0 --bound diff1 --bound one2 --bound two1 --bound two2 > results/design-found.txt 2>&1
  python3 $CLI models/catalog.py design --all-fails --bound roll --bound keys2 > results/design-catalog.txt 2>&1
  python3 $CLI models/records.py design --all-fails --bound e2 --bound m2 --bound e2m2 > results/design-records.txt 2>&1
  python3 $CLI models/incarnation.py design --all-fails --bound data2 --bound home3 --bound data3 > results/design-incarnation.txt 2>&1
  python3 $CLI models/dirtable.py design --all-fails --bound r1 --bound r2 --bound n2 --bound r2m --bound d2 > results/design-dirtable.txt 2>&1
  python3 $CLI models/client.py design --all-fails --bound c1 --bound c2 --bound c2m --bound c3m > results/design-client.txt 2>&1
  python3 $CLI models/place.py design --all-fails --bound p1 --bound p1n --bound p2 --bound p2n > results/design-place.txt 2>&1
  python3 $CLI models/place.py stale --all-fails --bound p1 --bound p1n --bound p2 --bound p2n > results/design-place-stale.txt 2>&1
  python3 $CLI models/fold.py v4 --all-fails --bound f1 --bound f2 --bound f3 > results/design-fold.txt 2>&1
"
# Probes: the design text as written, where the runs found it wrong or loose.
$HEAVY timeout 1500 sh -c "
  { echo '# the opener keeps its candidate, and the id the store took, only in memory (E-33 took create and first entry as one step)';
    python3 $CLI models/found.py objcas-mem --bound one1;
    echo; echo '# the first fix as a builder would write it: create, and write the created id to disk when the create answers';
    python3 $CLI models/found.py objcas-after --bound one1;
    echo; echo '# rule 9 as written: a client asks the directory only for a first address (no failed-member mark)';
    python3 $CLI models/client.py design --bound c1 --drop dialfail.mark;
    echo; echo '# the home group recovered: judged even while the recovered copy is down (the residual case)';
    python3 $CLI models/incarnation.py design --bound home3s;
    echo; echo '# ... judged only where two old copies are up together and the recovered copy is down: the home group, then a data group';
    python3 $CLI models/incarnation.py design --bound home3e --bound data3e;
    echo; echo '# meta-directory rules 1 to 8 as first written (no write-again) when a record write can be lost';
    python3 $CLI models/records.py noresend --bound e2 --bound m2;
    echo; echo '# write again only until the record is once shown (retry until acknowledged)';
    python3 $CLI models/records.py ack --bound e2m2;
    echo; echo '# the leader reads the directory and adds later (a stale read): the leaver exit and never-re-announce without the refusal';
    python3 $CLI models/place.py stale --bound p1 --bound p1n --bound p2 --bound p2n --drop add.refuse --drop add.own;
    echo; echo '# ... and the same drop where the leader reads the live table in the add step itself';
    python3 $CLI models/place.py design --bound p1 --bound p1n --bound p2 --bound p2n --drop add.refuse --drop add.own;
    echo; echo '# healing adds a machine its own link has not reached (a stale machine entry), P9 at 6 changes (this model) and 8 (E-16)';
    python3 $CLI models/place.py design --bound p1 --drop add.live;
    python3 $CLI models/place.py design --bound p1c8 --bound p1nc8 --bound p2c8 --bound p2nc8 --drop add.live;
    echo; echo '# v4 without the pass on register (I-34)';
    python3 $CLI models/fold.py v4 --bound f1 --drop register.pass; } > results/probes.txt 2>&1
"
[ "$1" = check ] && exit 0
# Drop a cache made from another text of its model, the engine or the rule language.
fresh() {
  h=$(cat "models/$1.py" $ENG | sha256sum | cut -c1-16)
  if [ "$(cat "results/$2-ablation.json.cache.sha" 2>/dev/null)" != "$h" ]; then
    rm -f "results/$2-ablation.json.cache"
    echo "$h" > "results/$2-ablation.json.cache.sha"
  fi
}
for m in fold incarnation catalog records place client dirtable found; do fresh $m $m; done
fresh place place-stale
# DEV-10: ablation and mutants of every model (smallest model first, as E-16 and E-33).
$HEAVY timeout 3500 sh -c "
  python3 $CLI models/fold.py v4 --ablate results/fold-ablation.json --limit 1500000
  python3 $CLI models/incarnation.py design --ablate results/incarnation-ablation.json --limit 1500000
  python3 $CLI models/catalog.py design --ablate results/catalog-ablation.json --limit 1500000
  python3 $CLI models/records.py design --ablate results/records-ablation.json --limit 1500000
  python3 $CLI models/place.py design --ablate results/place-ablation.json --limit 1500000
  python3 $CLI models/place.py stale --ablate results/place-stale-ablation.json --limit 1500000
  python3 $CLI models/client.py design --ablate results/client-ablation.json --limit 1500000
  python3 $CLI models/dirtable.py design --ablate results/dirtable-ablation.json --limit 1500000
  python3 $CLI models/found.py objcas --ablate results/found-ablation.json --limit 1500000
" > results/ablation.log 2>&1
for m in found catalog records incarnation dirtable client place place-stale fold; do
  echo "# results/$m-ablation.json"; echo
  python3 ../E16-controller-loop/engine/report.py results/$m-ablation.json
done > results/summary.md
