#!/bin/sh
# E-44: what the run needs.
#   nats-server 2.10.22   already on the box ($SP/dl/nats/, sha256 checked by ../tools-fetch.sh nats)
#   nats (the official JavaScript client) 2.29.3 from the npm registry, pinned with its lock file in npm/
#   data at HEAD (63fea66), the copy on the box
set -e
HERE=$(cd "$(dirname "$0")" && pwd); . "$HERE/env.sh"
mkdir -p "$E44_NPM"; cp "$HERE/npm/package.json" "$HERE/npm/package-lock.json" "$E44_NPM/"
cd "$E44_NPM" && npm ci --no-audit --no-fund
