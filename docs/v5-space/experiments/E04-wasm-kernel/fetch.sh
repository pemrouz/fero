#!/bin/sh
# E-04's downloads: the wasm32 Rust target and the crates. Nothing goes in the repo.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
# 1. The wasm32-unknown-unknown standard library for Rust 1.97.0 (rustup checks it against the
#    channel manifest's sha256).
rustup target add wasm32-unknown-unknown
# 2. Crates from crates.io, pinned with sha256 in raft-wasm/Cargo.lock: raft 0.7.0, raft-proto 0.7.0,
#    protobuf 2.28.0, slog 2, getrandom 0.2 (the "custom" hook makes raft-rs's timeouts seedable).
#    k-rs has no dependency.
cargo fetch --locked --manifest-path "$HERE/raft-wasm/Cargo.toml"
# 3. E-10's TypeScript port of etcd raft is in this repo (experiments/E10-raft-port/port); data is at
#    /home/user/pemrouz/data (E-22's fetch.sh fetches it at 63fea66 on a fresh machine).
