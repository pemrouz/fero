#!/bin/sh
# E-39 downloads: the Rust crates in rs/Cargo.lock (mio 1.2.4, libc 0.2.191, crc32fast 1.5.4 and their dependencies) from
# crates.io; Cargo.lock pins each crate's sha256 checksum, and cargo checks them. E-02's Rust follower is built
# by ../E02-pipeline/run.sh build (its crates are pinned in ../E02-pipeline/rs/Cargo.lock).
set -e
cd "$(dirname "$0")/rs" && cargo fetch --locked
