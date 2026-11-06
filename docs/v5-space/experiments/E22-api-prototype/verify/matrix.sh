#!/bin/sh
# One mode of step 3's matrix (run.sh calls it under the heavy lock): every check, $SEEDS seeds,
# histories into $H, one summary line per check into $R/matrix.jsonl.
# The checks: every pattern check of step 2 (minus its p18, which runs its own worlds: verify/p18x
# replaces it), step 1's checks, and step 3's own. name=file[:ENV=value]
set -u
m="$1"
cd "$(dirname "$0")/.."
N="node --experimental-strip-types --no-warnings"
for c in cts=patterns/checks/cts p02=patterns/checks/p02 p03=patterns/checks/p03 p04=patterns/checks/p04 \
  p05=patterns/checks/p05 p06=patterns/checks/p06 p07=patterns/checks/p07 p08=patterns/checks/p08 \
  p09=patterns/checks/p09 p10=patterns/checks/p10 p11=patterns/checks/p11 p12=patterns/checks/p12 \
  p13=patterns/checks/p13 p15=patterns/checks/p15 p16=patterns/checks/p16 p17=patterns/checks/p17 \
  p18=verify/p18x p19=patterns/checks/p19 p20=patterns/checks/p20 p21=patterns/checks/p21 p22=patterns/checks/p22 \
  p01=checks/p01 p14=checks/p14 core-exactly-once=checks/core-exactly-once core-reader=checks/core-reader \
  core-features=checks/core-features core-determinism=checks/core-determinism lin-kv=verify/lin-kv \
  phantom=verify/phantom order-planted=verify/planted-order:ORDER_VARIANT=planted order-fixed=verify/planted-order:ORDER_VARIANT=fixed; do
  n="${c%%=*}"; rest="${c#*=}"; f="${rest%%:*}"; envs=""; [ "$f" != "$rest" ] && envs="${rest#*:}"
  env $envs E22_NAME="$n" timeout 600 $N verify/run3.ts "$f.check.ts" --mode "$m" --seeds "$SEEDS" --hist "$H/$n-$m.jsonl" --json "$R/matrix.jsonl" || echo "FAIL $n $m: exit $?"
done
