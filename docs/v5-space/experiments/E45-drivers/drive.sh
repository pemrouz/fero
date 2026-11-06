#!/bin/sh
# drive.sh NAME KIND "HOST-ARGS" TOOL-COMMAND...
# Starts host.ts KIND with HOST-ARGS, waits for its `ready` line, runs the tool command once,
# stops the host (SIGTERM: it prints its summary) and writes everything to results/NAME.txt.
# Run it under the study's heavy lock (run.sh does). Not a timing run: the numbers the tool
# prints measure the E-22 SIMULATOR through a gateway, never fero.
set -u
cd "$(dirname "$0")"
name=$1; kind=$2; hargs=$3; shift 3
N="node --experimental-strip-types --no-warnings"
mkdir -p results
out="results/$name.txt"
log="${TMPDIR:-/tmp}/e45-host-$name.$$.log"
{
  echo "# E-45 $name: $(date -u +%FT%TZ), node $(node --version), data $(git -C "${DATA:-/home/user/pemrouz/data}" log -1 --format=%h), $(nproc) vCPU, loadavg $(cat /proc/loadavg)"
  echo "# host: host.ts $kind $hargs"
  echo "# tool: $*"
} > "$out"
# shellcheck disable=SC2086
$N host.ts "$kind" $hargs --every 10 > "$log" 2>&1 &
hpid=$!
i=0
until grep -q '^ready' "$log" 2>/dev/null; do
  i=$((i + 1)); if [ $i -gt 300 ]; then echo "host did not start" >> "$out"; cat "$log" >> "$out"; kill $hpid; exit 1; fi
  sleep 0.1
done
start=$(date +%s.%N)
# a tool that hangs must not hold the study's lock: 5 minutes at most per tool run
timeout -k 10 300 "$@" >> "$out" 2>&1
rc=$?
end=$(date +%s.%N)
kill -TERM $hpid 2>/dev/null; wait $hpid 2>/dev/null
echo "# tool exit code $rc, wall $(echo "$end - $start" | bc) s" >> "$out"
echo "# host log:" >> "$out"
cat "$log" >> "$out"
rm -f "$log"
echo "$name: tool exit $rc ($(tail -n 1 "$out" | cut -c1-160))"
exit 0
