#!/bin/sh
# E-43: what the run needs, and where it comes from.
#   data's full history   https://github.com/pemrouz/data (the copy on the box is a one-commit clone);
#                         checked: HEAD is 63fea66fb5d1369023ae1baa35c27302ce0c7157
#   Node 26.13.0          nodejs.org tarball, fetched and checked by ../tools-fetch.sh node26
#   Node 22.22.0          already on the box (/opt/node22)
# Exports the eight commits (only the folders the fold needs) and builds one scratch tree per commit.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
W=$SP/e43
H=$SP/dl/data-hist
mkdir -p "$H" "$W/data"
[ -d "$H/data/.git" ] || git clone --quiet https://github.com/pemrouz/data "$H/data"
[ "$(git -C "$H/data" rev-parse 63fea66)" = 63fea66fb5d1369023ae1baa35c27302ce0c7157 ] || { echo "data HEAD is not the expected commit"; exit 1; }
[ -x "$SP/dl/node26/node-v26.13.0-linux-x64/bin/node" ] || "$HERE/../tools-fetch.sh" node26
for c in 4479a92 6b615e2 b831319 46df5f9 ff85e6c dc65b8f 2b8b780 63fea66; do
  if [ ! -d "$W/data/$c" ]; then
    mkdir -p "$W/data/$c"
    if git -C "$H/data" cat-file -e $c:v4/api/index.ts 2>/dev/null; then git -C "$H/data" archive $c v4 | tar -x -C "$W/data/$c" --strip-components=1   # before the v4 tree became the root
    else git -C "$H/data" archive $c api kernel seam contract ops compat render jsx devtools types conformance package.json | tar -x -C "$W/data/$c"; fi
    [ -f "$W/data/$c/package.json" ] || printf '{ "type": "module" }\n' > "$W/data/$c/package.json"
  fi
  "$HERE/tree.sh" "$W/tree/$c" "$W/data/$c" $c
  echo "$c SCHEDULE_VERSION $(grep -o 'SCHEDULE_VERSION = [0-9]*' "$W/data/$c/contract/index.ts" | grep -o '[0-9]*$') $(git -C "$H/data" log -1 --format='%ad %s' --date=short $c | cut -c1-110)"
done | tee "$HERE/results/commits.txt"
