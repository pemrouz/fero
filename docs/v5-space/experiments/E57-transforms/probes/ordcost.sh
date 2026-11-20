#!/bin/sh
# The critic's timed probe (ordcost.mjs): data's za('points', 10) per write at 1e4, 1e5 and 1e6 rows. Three runs,
# each process alone under the timing lock. Lines append to ordcost.jsonl (the critic's own run is there already).
# Env: SP (a scratch folder holding bin/timing), NODE (default node on PATH), DATA (data's checkout).
: "${SP:?set SP to a scratch folder (it holds bin/timing)}"
NODE=${NODE:-node}
cd "$(dirname "$0")"
for run in 1 2 3; do for n in 10000 100000 1000000; do
  printf '{"run":%s,"loadavg":"%s"}\n' $run "$(cat /proc/loadavg)" >> ordcost.jsonl
  $SP/bin/timing $NODE --expose-gc --max-old-space-size=3000 --experimental-strip-types --no-warnings ordcost.mjs $n >> ordcost.jsonl
done; done
