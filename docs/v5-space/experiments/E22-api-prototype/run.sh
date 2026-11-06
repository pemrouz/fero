#!/bin/sh
# E-22 step 1: the prototype core. Runs every check (each ends `ok <name>` or prints a replay
# command and exits 1), then the TEST-01 bench three times under the study's timing lock.
#   ./run.sh            checks, then timing
#   ./run.sh checks     checks only (light: about 10 s of CPU)
#   ./run.sh timing     the TEST-01 bench only
#   ./run.sh types      tsc --strict over the prototype, checks and examples, and the examples against
#                       API.md's own fero.d.ts (checks/api-types.mjs); tsconfig.json names
#                       @types/node at /opt/node-tools; point typeRoots elsewhere on another box)
# DATA names data's folder (default /home/user/pemrouz/data); SP the study scratchpad (lock helpers).
set -eu
cd "$(dirname "$0")"
DATA="${DATA:-/home/user/pemrouz/data}"; export DATA
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
N="node --experimental-strip-types --no-warnings"
what="${1:-all}"
mkdir -p results
head() { echo "# $1, $(date -u +%FT%TZ), node $(node --version), data $(git -C "$DATA" log -1 --format=%h), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }
if [ "$what" = all ] || [ "$what" = types ]; then
  { head "tsc $(tsc -v)"; tsc -p tsconfig.json && echo "ok: tsc --strict, exit 0"; node checks/api-types.mjs; } 2>&1 | tee results/typecheck.txt
fi
if [ "$what" = all ] || [ "$what" = checks ]; then
  # light (about 10 s of CPU), but run under the study's heavy lock so no timing run is disturbed
  # (one lock for the whole set: the queue for the lock can be long)
  { head checks; "$SP/bin/heavy" sh -c "for f in checks/*.check.ts; do $N \"\$f\"; done"; } 2>&1 | tee results/checks.txt
  if grep -q '^FAIL' results/checks.txt; then echo "checks failed"; exit 1; fi
fi
if [ "$what" = all ] || [ "$what" = timing ]; then
  { head "TEST-01 bench, 3 runs under $SP/bin/timing"
    for i in 1 2 3; do "$SP/bin/timing" $N checks/test01.bench.ts; done; } 2>&1 | tee results/test01.txt
fi
