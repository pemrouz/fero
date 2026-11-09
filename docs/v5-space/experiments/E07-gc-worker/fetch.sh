#!/bin/sh
# Nothing is downloaded for this experiment. It needs the two sibling repositories at the commits it ran on:
#   fero  a08ac53 (this repository; tree.sh copies api/substrate.ts, kernel/env.ts and kernel/codec.ts)
#   data  63fea66 (SCHEDULE_VERSION 4), https://github.com/pemrouz/data
set -e
DATA=${DATA:-/home/user/pemrouz/data}
if [ ! -d "$DATA/.git" ]; then git clone https://github.com/pemrouz/data "$DATA"; fi
git -C "$DATA" rev-parse --short HEAD | grep -q '^63fea66' || echo "note: data is not at 63fea66 (git -C $DATA checkout 63fea66 to match)"
