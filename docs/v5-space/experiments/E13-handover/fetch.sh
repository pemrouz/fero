#!/bin/sh
# E-13 downloads: etcd 3.5.17 (release tarball, sha256 checked against the release's SHA256SUMS) and the etcd
# benchmark tool, both made by the study's tools script; the load client's Go modules come from proxy.golang.org,
# checked by load/go.sum (go build does that itself).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
sh "$HERE/../tools-fetch.sh" etcd etcdbench
SP=${SP:-/tmp/fero-sp}
(cd "$HERE/load" && GOTOOLCHAIN=local GOFLAGS=-mod=mod GOPATH=$SP/e13/gopath go mod download)
