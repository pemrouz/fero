#!/bin/sh
# Differential fuzz: random interaction scripts, filled in by etcd's own Go raft and
# InteractionEnv, then replayed byte for byte on the TS port.
# Usage: diff/run_diff.sh <count> <seed> [readindex,restart]   (from the E10-raft-port folder)
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")/.." && pwd)
COUNT=${1:-200}; SEED=${2:-1}; EXTRA=${3:-}
WORK=$SP/e10diff/seed$SEED
rm -rf "$WORK" && mkdir -p "$WORK/in" "$WORK/out"
# A scratch copy of etcd raft at c51f010, with one patch: the election-timeout jitter
# (crypto/rand) returns 0 when E10_RAND0 is set, so both sides are deterministic.
if [ ! -d "$SP/dl/e10-go/raft-diff" ]; then
  cp -r "$SP/dl/raftsrc/raft" "$SP/dl/e10-go/raft-diff"
  python3 - "$SP/dl/e10-go/raft-diff/raft.go" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
s = s.replace('func (r *lockedRand) Intn(n int) int {', 'func (r *lockedRand) Intn(n int) int {\n\tif os.Getenv("E10_RAND0") != "" {\n\t\treturn 0\n\t}', 1)
s = s.replace('import (\n', 'import (\n\t"os"\n', 1)
open(p, 'w').write(s)
PY
fi
cp "$HERE/diff/zz_e10_diff_test.go" "$SP/dl/e10-go/raft-diff/"
node "$HERE/diff/gen_scripts.ts" "$WORK/in" "$COUNT" "$SEED" $EXTRA
export GOPATH=$SP/dl/e10-go/gopath GOMODCACHE=$SP/dl/e10-go/gopath/pkg/mod GOTOOLCHAIN=go1.26.10 GOFLAGS=-modcacherw GOCACHE=$SP/dl/e10-go/gocache
(cd "$SP/dl/e10-go/raft-diff" && E10_RAND0=1 E10_DIFF_IN="$WORK/in" E10_DIFF_OUT="$WORK/out" "$SP/bin/heavy" go test -count=1 -run TestE10Diff . > "$WORK/go.txt" 2>&1) || { tail -20 "$WORK/go.txt"; exit 1; }
node "$HERE/diff/run_ts.ts" "$WORK/out" "$WORK/in"
