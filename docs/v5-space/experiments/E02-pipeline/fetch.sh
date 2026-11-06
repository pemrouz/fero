#!/bin/sh
# E-02 downloads only two Rust crates from crates.io (libc, crc32fast, and crc32fast's cfg-if).
# Cargo.lock pins their versions and sha256 checksums; cargo checks them on fetch.
# Go uses only its standard library; the Node addon uses Node's own headers.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
cargo fetch --locked --manifest-path "$HERE/rs/Cargo.toml"
