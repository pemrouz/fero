#!/bin/sh
# E-38(c): three etcd 3.5.17 members in their own network namespaces, links cut with iptables. Run as root.
# Usage: sh run.sh [all|table|down]. Needs E-13's load client (built by ../E13-handover/run.sh build).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
case "${1:-all}" in
  all)
    [ -x "$SP/e13/e13load" ] || "$SP/bin/heavy" sh "$HERE/../E13-handover/run.sh" build
    "$SP/bin/timing" python3 -I "$HERE/gray.py" run --runs 3
    python3 -I "$HERE/gray.py" down
    python3 -I "$HERE/gray.py" table ;;
  table) python3 -I "$HERE/gray.py" table ;;
  down) python3 -I "$HERE/gray.py" down ;;
esac
