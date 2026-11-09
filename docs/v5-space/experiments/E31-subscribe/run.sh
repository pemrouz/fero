#!/bin/sh
# E-31: the subscribe protocol (DESIGN-V5 4.4, L3) across a leader crash, a
# follower's snapshot reload, a slot move and a relay. One exhaustive model on
# E-16's engine (E-17's rule language, unchanged).
#   ./run.sh check    every option on every bound (traces of what breaks)
#   ./run.sh ablate   DEV-10: ablation and mutants of the option whose design holds
#   ./run.sh report   results/summary.md
#   ./run.sh          all three
# Every model step runs under $SP/bin/heavy, one hold per step, each under 25 minutes.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY-$SP/bin/heavy}"
CLI="$HERE/../E16-controller-loop/engine/cli.py"
REPORT="$HERE/../E16-controller-loop/engine/report.py"
R="$HERE/results"
STEPS="${*:-check ablate report}"
mkdir -p "$R"
cd "$HERE"
want() { for s in $STEPS; do [ "$s" = "$1" ] && return 0; done; return 1; }
hdr() { echo "# $1, $(date -u +%FT%TZ), $(python3 --version), $(nproc) vCPU, load $(cut -d' ' -f1-3 /proc/loadavg)"; }

if want check; then
  hdr 'subscribe: every option on every bound' > $R/design.txt
  $HEAVY timeout 1500 sh -c "for o in draft fixed off; do python3 $CLI models/subscribe.py \$o --limit 3000000; done" >> $R/design.txt 2>&1
fi
if want ablate; then
  $HEAVY timeout 1500 python3 $CLI models/subscribe.py fixed --ablate $R/fixed-ablation.json --limit 3000000
fi
if want report; then
  python3 $REPORT $R/fixed-ablation.json > $R/summary.md
fi
