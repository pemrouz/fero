#!/bin/sh
# What E-38 uses from outside, and where it comes from.
#  - Go 1.26.10 (etcd's raft at c51f010 needs go >= 1.26): fetched by the go
#    command itself from proxy.golang.org (GOTOOLCHAIN=go1.26.10).
#  - go.etcd.io/raft/v3 v3.7.0-rc.0.0.20261023205317-c51f010c851e (commit
#    c51f010c851edd0dada5af41bafbf68e54617767) and google.golang.org/protobuf
#    v1.36.12: fetched by the go command from proxy.golang.org, checked
#    against harness/go.sum.
# Nothing else is downloaded.
set -e
cd "$(dirname "$0")/harness"
export GOTOOLCHAIN=go1.26.10
go version
go mod download -x go.etcd.io/raft/v3 google.golang.org/protobuf
go mod verify
