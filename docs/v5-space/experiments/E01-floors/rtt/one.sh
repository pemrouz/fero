#!/bin/sh
# one round-trip run: one.sh <run> <impl: node|rust|go> <bytes> <seconds> <port>; prints one JSON line
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
BIN=${BIN:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad/e01e02}
run=$1 impl=$2 bytes=$3 secs=$4 port=$5
case $impl in
  node) cmd="node $HERE/rtt.mjs" ;;
  rust) cmd="$BIN/target-rtt/release/rtt" ;;
  go)   cmd="$BIN/rtt-go" ;;
esac
$cmd server "$port" & S=$!
trap 'kill $S 2>/dev/null || true' EXIT
python3 -c 'import socket,sys,time
for _ in range(100):
    try: socket.create_connection(("127.0.0.1", int(sys.argv[1])), 0.1).close(); break
    except OSError: time.sleep(0.05)' "$port"
sleep 0.2
L=$(cat /proc/loadavg)
out=$($cmd client "$port" "$bytes" "$secs")
kill $S 2>/dev/null || true; wait $S 2>/dev/null || true
RUN=$run L=$L python3 -c 'import json,os,sys; d=json.loads(sys.stdin.read()); d["run"]=int(os.environ["RUN"]); d["loadavg"]=os.environ["L"]; print(json.dumps(d))' <<J
$out
J
