#!/bin/sh
# E-44: fero's patterns P-01, P-14, P-10 and P-09 on NATS JetStream 2.10.22 (the BUY row), checked on a
# three-server cluster on this box with the stream leader killed along the way.
#   ./run.sh          cluster up, every check, cluster down (about 8 minutes); results/*.jsonl
#   ./run.sh <check>  one of: probe dedup p01 p14 p10 p09 failover (the cluster must be up: ./cluster.sh up)
# Needs ./fetch.sh first (the NATS client from npm). Not a timing run: the numbers marked "rough" were taken
# while other jobs ran on the box.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"; . ./env.sh
R=$HERE/results; mkdir -p "$R"
one() {
  c=$1; export E44_RUN=$(date +%s | tail -c 6)
  printf '{"loadavg":"%s","check":"%s"}\n' "$(cat /proc/loadavg)" "$c" > "$R/$c.jsonl"
  if [ "$c" = burn-one-id ]; then timeout 240 $NODE checks.mjs burn >> "$R/$c.jsonl" 2> "$SP/e44/$c.err" < /dev/null
  elif [ "$c" = probe ]; then $NODE msgid_probe.mjs >> "$R/$c.jsonl" 2> "$SP/e44/$c.err" < /dev/null
  else timeout 240 $NODE checks.mjs $c >> "$R/$c.jsonl" 2> "$SP/e44/$c.err" < /dev/null || echo "{\"check\":\"$c\",\"ok\":false,\"crashed\":\"see $SP/e44/$c.err\"}" >> "$R/$c.jsonl"; fi
  sleep 6     # a killed server is back and caught up before the next check
}
all() {
  ./cluster.sh down; ./cluster.sh up > "$R/cluster.txt" 2>&1
  { "$SP/dl/nats/nats-server-v2.10.22-linux-amd64/nats-server" --version; node --version; grep '"version"' "$E44_NPM/node_modules/nats/package.json"; git -C "$E44_DATA" rev-parse --short HEAD; } >> "$R/cluster.txt" 2>&1
  for c in probe dedup p01 p14 p10 p09 failover burn; do one $c; done
  E44_ONE_ID=1 one burn-one-id
  ./cluster.sh down
  ./loc.py buy.mjs > "$R/loc.txt"
}
case "$1" in
  '') "$SP/bin/heavy" "$HERE/run.sh" _all;;
  _all) all;;
  *) one "$1";;
esac
