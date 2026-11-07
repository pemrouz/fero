#!/bin/sh
# Build the scratch tree fero's seam expects: fero/api/substrate.ts imports '../../data/api/index.ts',
# so data must sit next to fero. We copy the three fero files the seam and the codec need (read only from
# the repo, nothing in it is changed) and link data beside them.
#   tree.sh <tree dir>      env: FERO (fero v4 folder), DATA (data folder)
set -e
T=$1
FERO=${FERO:-/home/user/fero}
DATA=${DATA:-/home/user/pemrouz/data}
mkdir -p "$T/fero/api" "$T/fero/kernel"
cp "$FERO/api/substrate.ts" "$T/fero/api/"
cp "$FERO/kernel/env.ts" "$FERO/kernel/codec.ts" "$T/fero/kernel/"
printf '{ "type": "module" }\n' > "$T/fero/package.json"
ln -sfn "$DATA" "$T/data"
{
  echo "fero $(git -C "$FERO" rev-parse --short HEAD) (substrate.ts, env.ts, codec.ts copied)"
  echo "data $(git -C "$DATA" rev-parse --short HEAD) SCHEDULE_VERSION $(grep -o 'SCHEDULE_VERSION = [0-9]*' "$DATA/contract/index.ts" | grep -o '[0-9]*$')"
} > "$T/VERSIONS"
