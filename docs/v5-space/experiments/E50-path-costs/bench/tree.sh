#!/bin/sh
# Build the scratch tree that the benches needing fero's seam import (bench/reads/*, bench/core/api.ts and alloc.ts).
# fero's api/substrate.ts imports '../../data/api/index.ts', so data must sit next to fero. We copy fero v4's api/,
# kernel/, shell/ and utils/ (read only from the repo; nothing in it changes) and link data beside them.
#   tree.sh <tree dir>      env: FERO (fero v4 folder; default: this repo), DATA (data folder)
set -e
T=$1
HERE=$(cd "$(dirname "$0")" && pwd)
FERO=${FERO:-$(cd "$HERE/../../../../.." && pwd)}
DATA=${DATA:-/home/user/pemrouz/data}
[ -n "$T" ] || { echo "usage: tree.sh <tree dir>" >&2; exit 2; }
[ -f "$DATA/api/index.ts" ] || { echo "data not found at $DATA (set DATA)" >&2; exit 2; }
rm -rf "$T/fero"
mkdir -p "$T/fero"
for d in api kernel shell utils; do cp -R "$FERO/$d" "$T/fero/$d"; done
cp "$FERO/package.json" "$T/fero/package.json"
ln -sfn "$DATA" "$T/data"
{
  echo "fero $(git -C "$FERO" rev-parse --short HEAD) (api kernel shell utils copied)"
  echo "data $(git -C "$DATA" rev-parse --short HEAD)"
} > "$T/VERSIONS"
