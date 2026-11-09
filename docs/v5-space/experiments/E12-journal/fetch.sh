#!/bin/sh
# E-12 downloads nothing by hand. The Rust build fetches libc 0.2.191 and crc32fast 1.5.4 from
# crates.io, pinned with their checksums in rs/Cargo.lock (cargo checks them). Node 22.22.0 and
# Rust 1.97.0 are the box's own (see ../E01-floors/results/env.txt).
set -eu
cd "$(dirname "$0")/rs" && cargo fetch --locked
