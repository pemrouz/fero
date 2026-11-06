#!/bin/sh
# E-09e downloads: etcd 3.5.17 (release tarball, sha256 from the release's SHA256SUMS), etcd's benchmark tool
# (built from the Go module proxy by the shared tools script; go.sum pins every hash), the lock loop's Go
# modules (lockbench/go.sum pins them), and etcd's published performance page (cited context only).
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
HERE=$(cd "$(dirname "$0")" && pwd)
# etcd v3.5.17: https://github.com/etcd-io/etcd/releases/download/v3.5.17/etcd-v3.5.17-linux-amd64.tar.gz
#   sha256 eff6ac621d41711085d0f38fab17d8fa3705f6326c3ff11301a1f5a71fc94edd
# benchmark: go.etcd.io/etcd/v3/tools/benchmark @ v3.5.17 (wrapper module in ../tools/src/etcd-benchmark)
bash "$HERE/../tools-fetch.sh" etcd etcdbench
(cd "$HERE/lockbench" && GOTOOLCHAIN=local go mod download && go mod verify)
mkdir -p "$SP/dl/e09-cited"
curl -sSfL -o "$SP/dl/e09-cited/etcd-performance.md" \
  https://raw.githubusercontent.com/etcd-io/website/main/content/en/docs/v3.5/op-guide/performance.md
# first seen 2026-11-06 with sha256 2ca37dde80a3f2c4f3966fe4d99755329ae4f5ca1d9adf42c0127c2004be76d4 (a living page: may change)
sha256sum "$SP/dl/e09-cited/etcd-performance.md"
