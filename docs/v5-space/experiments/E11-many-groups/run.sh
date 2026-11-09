#!/bin/sh
# E-11: the cost of N Raft groups in one process, in Go (etcd raft c51f010), Rust (raft-rs 0.7.0)
# and TypeScript (E-10's port of etcd raft). Three processes on loopback, each with one replica
# of each of N groups.
# Usage: sh run.sh build | smoke | idle-small | idle-10k | busy | busy-tick | all | summary
# Timed blocks run under $SP/bin/timing; builds and smoke under $SP/bin/heavy.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
GO126=${GO126:-$SP/dl/e10-go/gopath/pkg/mod/golang.org/toolchain@v0.0.1-go1.26.10.linux-amd64/bin/go}

build() {
  # Go: etcd raft at c51f010 needs Go 1.26 (E-10 fetched go1.26.10); build from a copy whose go.mod points at the source
  mkdir -p "$SP/e11/gobuild"
  cp "$HERE/go/main.go" "$HERE/go/go.mod" "$HERE/go/go.sum" "$SP/e11/gobuild/" 2>/dev/null || cp "$HERE/go/main.go" "$HERE/go/go.mod" "$SP/e11/gobuild/"
  (cd "$SP/e11/gobuild" && export GOPATH=$SP/e11/gopath GOMODCACHE=$SP/e11/gopath/pkg/mod GOCACHE=$SP/e11/gocache GOTOOLCHAIN=local GOFLAGS=-mod=mod &&
    "$GO126" mod edit -replace go.etcd.io/raft/v3="$SP/dl/raftsrc/raft" && "$GO126" mod tidy && "$GO126" build -o "$SP/e11/e11-go" .)
  (cd "$HERE/rs" && CARGO_TARGET_DIR=$SP/e11/target cargo build --release --locked -q)
}

# the dispatch is one brace group ending in exit, so editing this file during a run is safe
{
case "${1:-all}" in
  build) build ;;
  smoke) for i in go rs ts; do node "$HERE/bench.mjs" block=smoke runs=1 impls=$i n=100 m=quiet500 rate=1000; done ;;
  idle-small|idle-10k|busy|busy-tick) node "$HERE/bench.mjs" block="$1" runs="${RUNS:-3}" ;;
  summary) python3 "$HERE/summarize.py" "$HERE/results/runs.jsonl" > "$HERE/results/tables.md"; cat "$HERE/results/tables.md" ;;
  all)
    "$SP/bin/heavy" sh "$HERE/run.sh" build
    for b in idle-small idle-10k busy busy-tick; do
      echo "$(date +%T) block $b waiting"; "$SP/bin/timing" sh "$HERE/run.sh" "$b"; echo "$(date +%T) block $b done"
    done
    sh "$HERE/run.sh" summary ;;
  *) echo "unknown $1" >&2; exit 1 ;;
esac
exit 0
}
