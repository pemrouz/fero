#!/bin/sh
# E-38(c): three etcd 3.5.17 members in their own network namespaces, links cut with iptables. Run as root.
# Usage: sh run.sh [all|table|down]. Needs E-13's load client (built by ../E13-handover/run.sh build).
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/fero-sp}
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
