#!/bin/sh
# E-22 step 2: every pattern as an example of at most 40 lines, each with its check, plus Q-22's
# check-then-set experiment. No timing here (step 1 owns TEST-01).
#   ./run.sh            types, then every check, into results/ (both under the study's heavy lock)
#   ./run.sh types      tsc --strict over patterns/, and the examples against API.md's own fero.d.ts
#   ./run.sh checks     the checks only; then step 1's checks again, as a regression record for the
#                       core fixes listed in ../API-NOTES.md part E (read-only use of ../checks)
#   one check:          node --experimental-strip-types --no-warnings checks/p09.check.ts [--seeds N | --seed S --trace]
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
  { head "tsc $(tsc -v)"; "$SP/bin/heavy" sh -c 'timeout 300 tsc -p tsconfig.json && echo "ok: tsc --strict over patterns/, exit 0"; timeout 300 node checks/api-types.mjs'; } 2>&1 | tee results/typecheck.txt
fi
if [ "$what" = all ] || [ "$what" = checks ]; then
  { head checks; "$SP/bin/heavy" sh -c "for f in checks/*.check.ts ../checks/*.check.ts; do timeout 300 $N \"\$f\" || echo \"FAIL \$f: exit \$?\"; done"; } 2>&1 | tee results/checks.txt
  if grep -q '^FAIL' results/checks.txt; then echo "checks failed"; exit 1; fi
fi
