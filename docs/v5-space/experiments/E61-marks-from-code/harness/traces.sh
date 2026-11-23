#!/bin/sh
# E-61: the shortest counterexample of each rule this study adds or tests, as the engine prints it.
#   sh harness/traces.sh > results/traces.txt
cd "$(dirname "$0")/.."
PY=${PYTHON:-python3}
CLI=../E16-controller-loop/engine/cli.py
t() { echo "## $*"; $PY $CLI models/marks.py "$@" | grep -v "judged states"; echo; }
t design --bound d-share --drop expire.stale
t design --bound r-share --drop resync.jump
t design --bound r-share --drop cursor.ahead
t design --bound d-refuse --drop refuse.mark
t design --bound d-refuse-then --drop refuse.mark
t design --bound d-refuse2 --drop refuse.above
t design --bound d-refuse --drop skip.say
t design --bound d-async --drop read.fnret
t design --bound r-async --drop cursor.fnret
t design --bound d-bare-drop --drop bare.idle --drop bmark.inorder
t design --bound d-bare --drop bare.read
t design --bound d-refuse-drop --drop refuse.inorder
t design --bound r-short --drop cursor.answered
t design --bound r-lock --drop cursor.fence
t design --bound d-tail --drop apply.inorder
t fenced-mark --bound d-lock
t fenced-mark --bound r-lock
t unpaced --bound d-pace
t mark-apart --bound d-tail
t mark-first --bound d-tail
t marks-tail --bound d-tail
t marks-marked --bound d-short
t judge-com --bound d-short
t skip-ahead --bound d-cut
t nondet --bound d-two
t key-name --bound d-slots
t no-wnum --bound r-two
