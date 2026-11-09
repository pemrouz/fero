#!/bin/sh
# E-08 downloads: the Rust crates in rs/Cargo.lock (mio 1.2.4, libc 0.2.191 and their dependencies) from
# crates.io; Cargo.lock pins each crate's sha256 checksum, and cargo checks them. The NATS yardstick uses
# nats-server 2.10.22 and the nats CLI 0.5.1 that E-09b and the toolsmith fetched (see ../tools-fetch.sh:
# steps `nats` and `natscli`, each checked against the release's SHA256SUMS).
set -e
cd "$(dirname "$0")/rs" && cargo fetch --locked
