#!/bin/sh
# E-29: what the run needs.
#   LazyFS 0.3.1 (github.com/dsrhaslab/lazyfs, tag 0.3.1, commit 045a0b3a) and libfuse3: fetched and built by
#   ../tools-fetch.sh (step "lazyfs", usable since 2026-11-06; ../TOOLS.md has the build note).
#   Node 22, util-linux's fallocate and losetup, e2fsprogs' mkfs.ext4: already on the box.
set -e
SP=${SP:-/tmp/fero-sp}
[ -x "$SP/dl/lazyfs/src/lazyfs/build/lazyfs" ] || ALLOW_GATED=1 "$(dirname "$0")/../tools-fetch.sh" lazyfs
[ "$(git -C "$SP/dl/lazyfs/src" rev-parse --short HEAD)" = 045a0b3 ] || { echo "LazyFS is not at 0.3.1 (045a0b3)"; exit 1; }
echo "LazyFS ready: $SP/dl/lazyfs/src/lazyfs/build/lazyfs"
