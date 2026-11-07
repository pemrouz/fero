#!/bin/sh
# E-37: one voter keeps its id but loses or corrupts one fsynced entry below
# the commit point. TLC on E-14b's model (etcd's etcdraft.tla unchanged
# underneath), with a damage fault and the storage-fault options of SPACE Z.
#
#   ./run.sh              everything below; every TLC run holds the study's
#                         heavy lock for at most 25 minutes
#   ./run.sh RUN ...      some runs (python3 tools/run37.py --list)
#   ./run.sh mutants      DEV-10's mutants of the par fix only
#
# Needs: java 21, python3 with numpy, and what fetch.sh fetches. Writes
# results/ and cfg/; state graphs and TLC folders stay in $SP/e37/.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
export SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
cd "$HERE"
"$HERE/fetch.sh" > /dev/null
sha256sum tla/MCferolive.tla ../E14-membership-on-commit/tla/MCferoraft.tla tla/MCbadentry.tla \
  "$SP/dl/raftsrc/raft/tla/etcdraft.tla" "$SP/dl/tla/tla2tools.jar" \
  "$SP/dl/communitymodules/CommunityModules-deps.jar" > results/versions.txt
java -version 2>&1 | grep -v Picked >> results/versions.txt
python3 --version >> results/versions.txt
if [ "$1" = mutants ]; then
  python3 tools/mutrun37.py --runs par1,par1r2,par2d
  exit 0
fi
if [ $# -gt 0 ]; then
  python3 tools/run37.py "$@" --timeout 1500
  exit 0
fi
# 1. Raft as published (Z crash): the damage cut as a torn tail; a silent
#    flip; the wipe back under the old id (the incarnation rule left out).
python3 tools/run37.py cut1 cut1-obs silent1 ghost1 ghost1-obs --timeout 1500
# 2. Z rejoin: one damage plus a crash; two damages on two replicas.
python3 tools/run37.py rejoin1 rejoin2 --timeout 1500
# 3. Z par (the cheapest fix): one damage plus a crash; two damages at
#    different offsets; repair only from the leader.
python3 tools/run37.py par1 par1r2 par1c par2 par2d par2d-leader par2-leader --timeout 1500
# 4. DEV-10's mutants of the par fix.
python3 tools/mutrun37.py --runs par1,par1r2,par2d
