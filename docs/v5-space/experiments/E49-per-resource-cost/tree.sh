#!/bin/sh
# E-49: build the scratch tree the harness loads v4's real code from. fero's api/substrate.ts imports
# '../../data/api/index.ts', so data must sit next to fero: copy the five v4 files the directory and the seam
# need (read only from the repo; nothing in it changes) and link data beside them, as E-05's tree.sh does.
#   tree.sh <tree dir>      env: FERO (fero v4 folder), DATA (data folder)
set -e
T=$1
FERO=${FERO:-/home/user/fero}
DATA=${DATA:-/home/user/pemrouz/data}
mkdir -p "$T/fero/api" "$T/fero/kernel"
cp "$FERO/api/substrate.ts" "$FERO/api/directory.ts" "$T/fero/api/"
cp "$FERO/kernel/env.ts" "$FERO/kernel/codec.ts" "$FERO/kernel/door.ts" "$T/fero/kernel/"
printf '{ "type": "module" }\n' > "$T/fero/package.json"
ln -sfn "$DATA" "$T/data"
{
  echo "fero $(git -C "$FERO" rev-parse --short HEAD) (api/substrate.ts, api/directory.ts, kernel/env.ts, kernel/codec.ts, kernel/door.ts copied)"
  echo "data $(git -C "$DATA" rev-parse --short HEAD)"
  node --version
} > "$T/VERSIONS"
