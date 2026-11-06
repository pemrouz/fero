#!/bin/sh
# E-22 step 1 downloads nothing. It needs:
#   - Node 22 (22.22.0 here; --experimental-strip-types)
#   - data, the state engine, at commit 63fea66 (the sibling repo; on this box /home/user/pemrouz/data)
# On a fresh machine, this fetches data at that commit into $DATA (default ./data-src):
set -eu
DATA="${DATA:-$(dirname "$0")/data-src}"
if [ ! -d "$DATA/.git" ]; then git clone https://github.com/pemrouz/data "$DATA"; fi
git -C "$DATA" checkout --quiet 63fea66
echo "data at $(git -C "$DATA" log -1 --format=%h) in $DATA; run: DATA=$DATA ./run.sh"
