#!/bin/sh
# Build the scratch tree fero's seam expects, for one data commit: fero/api/substrate.ts imports
# '../../data/api/index.ts', so data must sit next to fero. Copies three fero files (read only), links data.
#   tree.sh <tree dir> <data export dir> <commit>
set -e
T=$1; DATA=$2; COMMIT=$3
FERO=${FERO:-/home/user/fero}
mkdir -p "$T/fero/api" "$T/fero/kernel"
cp "$FERO/api/substrate.ts" "$T/fero/api/"
cp "$FERO/kernel/env.ts" "$FERO/kernel/codec.ts" "$T/fero/kernel/"
printf '{ "type": "module" }\n' > "$T/fero/package.json"
ln -sfn "$DATA" "$T/data"
echo "$COMMIT" > "$T/COMMIT"
