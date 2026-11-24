#!/bin/sh
# Differential fuzz: random interaction scripts, filled in by etcd's own Go raft and its
# InteractionEnv, then replayed byte for byte on the Rust port.
#
# Usage, from anywhere:
#   RAFT_SRC=<etcd raft checkout at the vendored commit> diff/run_diff.sh <count> <seed> [readindex,restart]
#   RAFT_SRC=<...> diff/run_diff.sh corpus      # the four corpora: 4,000 scripts
#
# Environment:
#   RAFT_SRC  an etcd raft checkout at the commit in crates/raft/testdata/PROVENANCE.md. Read only.
#   WORK      scratch directory for the Go copy, the scripts and the outputs. Default ./target/work/raft-diff.
#   HEAVY     optional command to put in front of the long steps (for example a lock wrapper).
#   REPLAY_ONLY=1  skip the generator and the Go run; replay what is already in WORK.
# Needs: node 22.18 or newer (it runs the TypeScript generator as is), go, cargo.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../.." && pwd)
WORK=${WORK:-./target/work/raft-diff}
HEAVY=${HEAVY:-}
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)

if [ "${1:-}" = "corpus" ]; then
  RC=0
  "$0" 1000 2 || RC=1
  "$0" 1000 3 || RC=1
  "$0" 1000 5 readindex || RC=1
  "$0" 1000 7 readindex,restart || RC=1
  exit $RC
fi

COUNT=${1:-200}; SEED=${2:-1}; EXTRA=${3:-}
W=$WORK/seed$SEED

if [ -z "${REPLAY_ONLY:-}" ]; then
  : "${RAFT_SRC:?set RAFT_SRC to an etcd raft checkout}"
  # A scratch copy of etcd raft with one patch: the election-timeout jitter (crypto/rand)
  # returns 0 when RAFT_DIFF_RAND0 is set. The Rust side pins the same number to 0.
  GO=$WORK/raft-go
  if [ ! -d "$GO" ]; then
    cp -r "$RAFT_SRC" "$GO"
    chmod -R u+w "$GO"
    python3 - "$GO/raft.go" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
a = 'func (r *lockedRand) Intn(n int) int {'
assert a in s, 'raft.go: lockedRand.Intn not found'
s = s.replace(a, a + '\n\tif os.Getenv("RAFT_DIFF_RAND0") != "" {\n\t\treturn 0\n\t}', 1)
s = s.replace('import (\n', 'import (\n\t"os"\n', 1)
open(p, 'w').write(s)
PY
  fi
  cp "$HERE/zz_raft_diff_test.go" "$GO/"
  rm -rf "$W" && mkdir -p "$W/in" "$W/out"
  node "$HERE/gen_scripts.ts" "$W/in" "$COUNT" "$SEED" $EXTRA
  (cd "$GO" && RAFT_DIFF_RAND0=1 RAFT_DIFF_IN="$W/in" RAFT_DIFF_OUT="$W/out" $HEAVY go test -count=1 -run TestRaftDiff . > "$W/go.txt" 2>&1) || { tail -20 "$W/go.txt"; exit 1; }
fi

RC=0
(cd "$ROOT" && $HEAVY cargo run -q --release -p raft-harness --bin raft-diff -- "$W/out" "$W/in") > "$W/rust.txt" 2>&1 || RC=$?
cat "$W/rust.txt"
exit $RC
