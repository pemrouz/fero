#!/bin/sh
# E-54 downloads. Immutable.js 5.1.9 from npm through E-06's fetch.sh (checked against npm's sha512 integrity).
# The Rust crates pinned in rust/Cargo.lock (im 15.1.0, imbl 7.0.2, rpds 1.2.1 and their dependencies) from
# crates.io; cargo checks every crate's sha256 against the lock file. data and fero are the two sibling repos
# (E-06's tree.sh links them).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
"$HERE/../E06-fork-rewind/fetch.sh"
cd "$HERE/rust" && cargo fetch --locked
