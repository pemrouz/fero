#!/bin/sh
# Every smallest set (part 1's and part 2's) on three bounds outside the
# shared sweep (extra.py: readback, readback1, bothread), with the repair
# search when one fails; then the lanes-atfence probe. All in ONE hold of the
# heavy lock (each run takes seconds). Output: results/extra.txt.
cd "$(dirname "$0")"
SP=/tmp/fero-sp
HEAVY=${HEAVY:-$SP/bin/heavy}
[ -x "$HEAVY" ] || HEAVY=
exec $HEAVY sh "$(pwd)/extra-runs.sh"
