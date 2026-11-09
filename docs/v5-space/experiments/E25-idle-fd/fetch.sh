#!/bin/sh
# E-25's Rust hub uses raft-rs 0.7.0 and its dependencies from crates.io, pinned by rs/Cargo.lock (E-11's lock file).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
(cd "$HERE/rs" && cargo fetch --locked)
