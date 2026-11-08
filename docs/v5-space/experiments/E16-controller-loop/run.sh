#!/bin/sh
# E-16: one controller loop on #meta's leader (cent-co) against healing by
# every group's leader (self), on one world, with DEV-10's counting.
#
#   ./run.sh            everything below (about 3 CPU-hours on a quiet box;
#                       every piece holds the study's heavy lock for at most
#                       25 minutes, and each ablation resumes from its cache)
#   ./run.sh check      only the design runs and the verify probes (minutes)
#
# Needs: python3 (standard library). Reads E-17's harness/dsl.py unchanged.
# Writes results/. PYTHONHASHSEED is pinned by engine/cli.py.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
HEAVY="${HEAVY:-$SP/bin/heavy}"
cd "$HERE"
mkdir -p results

# 1. The designs on the one-fault bounds and two-a, with traces and the
#    WAIT and SWAP counts; then the other two-fault bounds (cent-co stops at
#    900,000 states on them: safety only).
for o in self cent-co; do
  "$HEAVY" timeout 1500 python3 engine/cli.py models/heal.py "$o" --bound three1 --bound four1 --bound meta1 \
    --bound two-a --limit 900000 > "results/design-$o.txt" 2>&1 || true
done
"$HEAVY" timeout 600 python3 engine/cli.py models/rlog.py rlog > results/design-rlog.txt 2>&1 || true
"$HEAVY" timeout 1500 sh -c 'for o in self cent-co; do for b in two-b two-c three2; do
  python3 engine/cli.py models/heal.py $o --bound $b --limit 900000; done; done' > results/design-extra.txt 2>&1 || true

# 2. The verify probes: cent-co does not finish two-a in 4,000,000 states;
#    a breadth-first run of three2 capped at 2,000,000 states covers every
#    trace up to 18 steps; the two-fault traces the verify bound must find
#    are found within it (12 and 14 steps).
"$HEAVY" timeout 1500 sh -c '
  echo "# Verify-bound probes. cli.py with --limit 4000000, and engine/depth.py."
  python3 engine/cli.py models/heal.py cent-co --bound two-a --limit 4000000
  python3 engine/depth.py models/heal.py cent-co two-b 3000000 exec.gone
  python3 engine/depth.py models/heal.py cent-co two-a 3000000 exec.allheld
  python3 engine/depth.py models/heal.py self two-a 3000000 surplus.allheld
  python3 engine/depth.py models/heal.py cent-co three2 2000000' > results/verify-probes.txt 2>&1 || true
[ "$1" = check ] && exit 0

# 3. The ablation and the mutants (DEV-10), resumable: each piece runs at
#    most 25 minutes under the heavy lock; the cache keeps finished runs.
#    The sweep runs stop at 900,000 states; cent-co's verify runs on three2
#    stop at 2,000,000 (safety to 18 steps; self finishes three2).
ablate() {  # model option out [extra args]
  m=$1; o=$2; out=$3; shift 3
  n=0
  while [ ! -s "$out" ] && [ $n -lt 16 ]; do
    "$HEAVY" timeout 1500 python3 engine/cli.py "$m" "$o" --ablate "$out" --limit 900000 "$@" >> "${out%.json}.log" 2>&1 || true
    n=$((n + 1))
  done
}
ablate models/heal.py self results/self-ablation.json
ablate models/rlog.py rlog results/rlog-ablation.json
ablate models/heal.py cent-co results/cent-co-ablation.json --vlimit 2000000
python3 engine/report.py results/self-ablation.json results/cent-co-ablation.json results/rlog-ablation.json > results/summary.md
