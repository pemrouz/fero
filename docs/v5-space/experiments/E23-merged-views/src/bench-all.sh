#!/bin/sh
# Run D's whole series under ONE hold of the CPU lock (run.sh wraps this in
# $SP/bin/timing): 51 short runs, each a fresh Node process, the load average
# printed before each. About 5 minutes in all.
set -eu
cd "$(dirname "$0")"
NODE="node --experimental-strip-types"
run() { echo "loadavg before: $(cat /proc/loadavg)"; $NODE bench.ts "$@"; }
for i in 1 2 3; do run --variant=base --op=all; done
for op in filter topk sum group; do
  for v in one views merge; do for i in 1 2 3; do run --variant=$v --op=$op; done; done
done
for op in topk sum; do
  for v in viewsC mergeC; do for i in 1 2 3; do run --variant=$v --op=$op; done; done
done
