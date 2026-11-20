#!/bin/sh
# E-57 probes: the small probes TRANSFORMS.md cites, run on data's real engine (read only). Untimed, one process each.
#   ./run.sh          the four untimed probes, each into its .out file
#   ./run.sh ordcost  the critic's timed probe, three runs under the timing lock (ordcost.sh)
# Env: SP (a scratch folder holding bin/heavy and bin/timing), NODE (default node on PATH), DATA (data's
# checkout at 63fea66; the scripts' default is ../data, next to this repo).
set -e
: "${SP:?set SP to a scratch folder (it holds bin/heavy and bin/timing)}"
NODE=${NODE:-node}
HERE=$(cd "$(dirname "$0")" && pwd)
NODEF="$NODE --expose-gc --experimental-strip-types --no-warnings --max-old-space-size=2000"
case "$1" in
  ordcost) sh "$HERE/ordcost.sh" ;;
  "") cd "$HERE"
    for p in limitprobe data-bugs top-objects maxprobe; do $SP/bin/heavy $NODEF $p.mjs > $p.out 2>&1; done ;;
  *) echo "usage: run.sh [ordcost]"; exit 1 ;;
esac
