#!/bin/sh
# E-11's sources, by URL and checksum.
# - etcd raft at commit c51f010 (Go): already in $SP/dl/raftsrc/raft (see ../E10-raft-port/fetch.sh,
#   which clones https://github.com/etcd-io/raft and checks out c51f010). Its modules
#   (google.golang.org/protobuf v1.36.12 and others) come from the Go module proxy, checked by
#   go.sum and the Go checksum database.
# - Go 1.26.10 (etcd raft's go.mod needs 1.26): fetched by E-10 as golang.org/toolchain
#   v0.0.1-go1.26.10.linux-amd64 from the Go module proxy (checksum database verified).
# - raft-rs 0.7.0, protobuf 2.28.0, slog 2.8.2, libc 0.2.191 from crates.io, pinned in
#   rs/Cargo.lock (cargo checks the checksums).
# - The TS row uses ../E10-raft-port/port (in this repo); nothing to fetch.
set -eu
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
test -f "$SP/dl/raftsrc/raft/go.mod" || sh "$(dirname "$0")/../E10-raft-port/fetch.sh"
(cd "$(dirname "$0")/rs" && cargo fetch --locked)
