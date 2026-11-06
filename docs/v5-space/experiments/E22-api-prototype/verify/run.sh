#!/bin/sh
# E-22 step 3: faults, outside checkers and the verdict. Every step writes into verify/results/.
#   ./run.sh build      fetch and build the Go checkers (Porcupine, Elle's Go port): ./fetch.sh
#   ./run.sh types      tsc --strict over verify/*.ts (TypeScript 6.0.2; tsconfig names @types/node at /opt/node-tools)
#   ./run.sh selftest   both checkers on known-bad and known-good histories
#   ./run.sh matrix     every check x {calm, faults, shuffle} x 100 seeds, histories recorded (heavy lock,
#                       one lock per mode so a timing run never waits long)
#   ./run.sh lin        Porcupine over every recorded history
#   ./run.sh elle       the P-15 list-append workload (saga, owned, undo, nolock) x 3 modes x 100 seeds, then Elle
#   ./run.sh mutants    two planted kernel bugs under the register workload and three pattern checks,
#                       to show the checkers catch real bugs in real histories
#   ./run.sh timing     step 1's TEST-01 bench, 3 runs under the timing lock (after step 2's core fixes)
#   ./run.sh report     results/matrix.md from the raw results
#   ./run.sh            all of the above, in that order
# One check by hand: node --experimental-strip-types --no-warnings verify/run3.ts patterns/checks/p09.check.ts --mode shuffle --seeds 100
# (add --seed 7 --trace to replay one seed; the plain check replays with ../patterns/checks/... --seed 7 --trace
# for calm-free runs). DATA names data's folder; SP the study scratchpad (lock helpers, histories).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/.."
DATA="${DATA:-/home/user/pemrouz/data}"; export DATA
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
H="$SP/e22v/hist"; E="$SP/e22v/edn"; X="$SP/e22v/go-build/e22check"; V="$SP/e22v/viz"
R="$HERE/results"
N="node --experimental-strip-types --no-warnings"
SEEDS="${SEEDS:-100}"
what="${1:-all}"
mkdir -p "$R" "$H" "$E"
head() { echo "# $1, $(date -u +%FT%TZ), node $(node --version), data $(git -C "$DATA" log -1 --format=%h), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }

if [ "$what" = all ] || [ "$what" = build ]; then "$HERE/fetch.sh"; fi
if [ "$what" = all ] || [ "$what" = types ]; then { head "tsc $(tsc -v)"; tsc -p "$HERE/tsconfig.json" && echo "ok: tsc --strict over verify/, exit 0"; } 2>&1 | tee "$R/typecheck.txt"; fi
if [ "$what" = all ] || [ "$what" = selftest ]; then { head "selftest: Porcupine v1.3.1 and Elle's Go port (tipocket v1.0.0)"; "$X" selftest; } 2>&1 | tee "$R/selftest.txt"; fi
if [ "$what" = all ] || [ "$what" = matrix ]; then
  : > "$R/matrix.jsonl"
  { head "matrix, $SEEDS seeds per check and mode"
    for m in calm faults shuffle; do SEEDS="$SEEDS" H="$H" R="$R" "$SP/bin/heavy" sh "$HERE/matrix.sh" "$m"; done; } 2>&1 | tee "$R/matrix.txt"
fi
if [ "$what" = all ] || [ "$what" = lin ]; then
  { head "Porcupine v1.3.1 over every recorded history (timeout 20 s per partition)"; "$SP/bin/heavy" "$X" lin -viz "$V" "$H"/*.jsonl; } 2>&1 | tee "$R/porcupine.jsonl"
fi
if [ "$what" = all ] || [ "$what" = elle ]; then
  rm -rf "$E"; mkdir -p "$E"; : > "$R/elle-runs.jsonl"
  { head "P-15 list-append workload, $SEEDS seeds per variant and mode"
    for m in calm faults shuffle; do
      "$SP/bin/heavy" sh -c "for v in saga owned undo nolock; do ELLE_VARIANT=\$v ELLE_OUT='$E' E22_NAME=elle-\$v timeout 1200 $N verify/run3.ts verify/elle-saga.check.ts --mode $m --seeds $SEEDS --json '$R/elle-runs.jsonl' || echo \"FAIL elle-\$v $m: exit \$?\"; done"
    done; } 2>&1 | tee "$R/elle-runs.txt"
  { head "Elle list-append (Go port, tipocket v1.0.0) on every EDN history"; "$SP/bin/heavy" "$X" elle "$E"/*.edn; } > "$SP/e22v/elle-raw.jsonl" 2>&1
  python3 -I "$HERE/summarize.py" elle "$SP/e22v/elle-raw.jsonl" > "$R/elle.txt"; cat "$R/elle.txt"
fi
if [ "$what" = all ] || [ "$what" = mutants ]; then
  : > "$R/mutants.jsonl"
  { head "mutants: nodedup (writers forget attempts) and lostcommit (an election loses the newest committed write)"
    "$SP/bin/heavy" sh -c "for mu in nodedup lostcommit; do for c in lin-kv=verify/lin-kv core-exactly-once=checks/core-exactly-once p11=patterns/checks/p11 p14=checks/p14; do n=\${c%%=*}; f=\${c#*=}; E22_NAME=\$n timeout 1200 $N verify/run3.ts \$f.check.ts --mode shuffle --seeds $SEEDS --mutant \$mu --hist '$H'/mut-\$mu-\$n.jsonl --json '$R/mutants.jsonl' || echo \"exit \$?\"; done; done"
    "$SP/bin/heavy" "$X" lin "$H"/mut-*.jsonl; } 2>&1 | tee "$R/mutants.txt"
fi
if [ "$what" = all ] || [ "$what" = timing ]; then
  { head "TEST-01 bench (step 1's checks/test01.bench.ts after step 2's core fixes and step 3's history fields), 3 runs under $SP/bin/timing"
    for i in 1 2 3; do "$SP/bin/timing" sh -c "echo load \$(cut -d' ' -f1-3 /proc/loadavg); $N checks/test01.bench.ts"; done; } 2>&1 | tee "$R/test01.txt"
fi
if [ "$what" = all ] || [ "$what" = report ]; then python3 -I "$HERE/summarize.py" report "$R" > "$R/matrix.md"; cat "$R/matrix.md"; fi
