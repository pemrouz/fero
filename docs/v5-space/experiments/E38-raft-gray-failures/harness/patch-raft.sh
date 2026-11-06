#!/bin/sh
# Copies etcd's raft (the pinned module) into $1 and makes two changes:
# 1. It seeds the election jitter, so a run replays from its seed. etcd reads
#    crypto/rand for it (raft.go, lockedRand.Intn); a seeded math/rand source
#    is used instead when the harness sets one.
# 2. Two timer knobs, off by default (then raft behaves exactly as shipped):
#    how often a leader runs CheckQuorum (every electionTimeout/E38CQDiv
#    ticks; etcd: every electionTimeout), and the random part of the election
#    timeout (Intn(E38JitterTicks); etcd: Intn(electionTimeout)). The harness
#    uses them only in runs named "fero timers".
set -e
DST="$1"
SRC=$(GOFLAGS=-mod=mod go list -m -f '{{.Dir}}' go.etcd.io/raft/v3)
rm -rf "$DST"; mkdir -p "$DST"; cp -r "$SRC"/. "$DST"/; chmod -R u+w "$DST"
python3 - "$DST/raft.go" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "\tr.mu.Lock()\n\tv, _ := rand.Int(rand.Reader, big.NewInt(int64(n)))"
new = "\tr.mu.Lock()\n\tif e38Rand != nil {\n\t\tx := e38Rand.Intn(n)\n\t\tr.mu.Unlock()\n\t\treturn x\n\t}\n\tv, _ := rand.Int(rand.Reader, big.NewInt(int64(n)))"
assert s.count(old) == 1, 'patch point not found'
s = s.replace(old, new)
old2 = "\tif r.electionElapsed >= r.electionTimeout {\n\t\tr.electionElapsed = 0\n\t\tif r.checkQuorum {"
new2 = "\tif r.electionElapsed >= r.electionTimeout/E38CQDiv {\n\t\tr.electionElapsed = 0\n\t\tif r.checkQuorum {"
assert s.count(old2) == 1, 'patch point 2 not found'
s = s.replace(old2, new2)
old3 = "\tr.randomizedElectionTimeout = r.electionTimeout + globalRand.Intn(r.electionTimeout)"
new3 = "\tif E38JitterTicks > 0 {\n\t\tr.randomizedElectionTimeout = r.electionTimeout + globalRand.Intn(E38JitterTicks)\n\t\treturn\n\t}\n" + old3
assert s.count(old3) == 1, 'patch point 3 not found'
s = s.replace(old3, new3)
open(p, 'w').write(s)
PY
cat > "$DST/e38_seed.go" <<'GO'
package raft

import mrand "math/rand"

var e38Rand *mrand.Rand

// E38CQDiv and E38JitterTicks are the timer knobs (1 and 0: etcd as shipped).
var E38CQDiv = 1
var E38JitterTicks = 0

// SeedElectionJitter makes the election jitter replay from seed (E-38).
func SeedElectionJitter(seed int64) {
	globalRand.mu.Lock()
	e38Rand = mrand.New(mrand.NewSource(seed))
	globalRand.mu.Unlock()
}
GO
echo "patched raft in $DST"
