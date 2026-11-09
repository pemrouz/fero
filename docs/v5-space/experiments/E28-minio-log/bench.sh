#!/bin/sh
# E-28 timing block: one MinIO server (single drive, or 4 drives with erasure coding, all on this one disk),
# then conditional PUTs with ./put (e28put). One JSON line per config to results/runs.jsonl, with the load average.
# Usage (under $SP/bin/timing): sh bench.sh <run number> [single,ec4]
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
M=$SP/opt/minio/minio; P=$SP/e28/e28put; OUT=$HERE/results/runs.jsonl; RUN=${1:-0}; LAYOUTS=${2:-single,ec4}
start() { # $1 = layout name, rest = drive paths
  lay=$1; shift; rm -rf "$SP/e28/data"; mkdir -p "$SP/e28/data"
  for d in "$@"; do mkdir -p "$d"; done
  # MINIO_CI_CD lets MinIO use several drives that sit on the root disk (else it reports them "not found")
  pkill -9 -f "minio server $SP/e28/data" 2>/dev/null || true; sleep 0.5
  MINIO_CI_CD=1 MINIO_ROOT_USER=e28user MINIO_ROOT_PASSWORD=e28secret123 "$M" server "$@" --address 127.0.0.1:19100 --console-address 127.0.0.1:19101 > "$SP/e28/minio-$lay.log" 2>&1 &
  MPID=$!
  for _ in $(seq 1 120); do [ "$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' http://127.0.0.1:19100/minio/health/ready)" = 200 ] && break; sleep 0.5; done
  "$P" -mkbucket > /dev/null
  "$P" -mode plain -size 1024 -dur 2s -prefix warm > /dev/null   # warm-up, not recorded
}
one() { # layout mode size conc dur
  la=$(cat /proc/loadavg)
  r=$("$P" -mode "$2" -size "$3" -conc "$4" -dur "$5" -prefix "r$RUN-$2-$3-$4")
  echo "{\"exp\":\"E-28\",\"run\":$RUN,\"layout\":\"$1\",\"loadavg\":\"$la\",\"res\":$r}" >> "$OUT"
  echo "$1 $2 $3 c$4 -> $r"
}
if echo "$LAYOUTS" | grep -q single; then
start single "$SP/e28/data/d1"
for size in 1024 16384 65536 262144 1048576; do for mode in create cas plain; do one single $mode $size 1 6s; done; done
one single create 1024 8 6s; one single create 65536 8 6s
kill -9 $MPID; wait $MPID 2>/dev/null || true
fi
if echo "$LAYOUTS" | grep -q ec4; then
start ec4 "$SP/e28/data/d1" "$SP/e28/data/d2" "$SP/e28/data/d3" "$SP/e28/data/d4"
for size in 1024 65536 1048576; do for mode in create cas; do one ec4 $mode $size 1 6s; done; done
kill -9 $MPID; wait $MPID 2>/dev/null || true
fi
rm -rf "$SP/e28/data"
