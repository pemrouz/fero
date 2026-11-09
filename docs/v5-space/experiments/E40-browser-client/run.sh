#!/bin/sh
# E-40: can a browser or an edge worker be a full fero client over WebSocket?
#   ./run.sh bundle    (a) bundle sizes, gzip and brotli (heavy lock; not a speed)
#   ./run.sh fanout    (b) one timing hold: E-08's Node relay over plain TCP and over WebSocket, 1,000 and 10,000
#                          subscribers, at max, with both relay ticks (TICK=data: fan out per feed read; TICK=immediate:
#                          per event-loop turn) (E-08's bench.mjs and Rust subscribers, which speak both)
#   ./run.sh cold      (c) one timing hold: 10 cold clients each in Node, a Chromium page and a Chromium Web Worker
#   ./run.sh           all three, then the summary
# Needs: E-08's Rust binaries (../E08-relay-fanout/run.sh build), esbuild (fetch.sh), Playwright + Chromium
# (preinstalled on the study box: /opt/node-tools/node_modules/playwright 1.63.0, /opt/pw-browsers/chromium-1243),
# and a self-signed P-256 certificate with IP SAN 127.0.0.1 in $SP/e40/certs (made by `./run.sh certs`).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
R=$HERE/results
mkdir -p "$R"
E08=$HERE/../E08-relay-fanout
case "${1:-all}" in
  certs) mkdir -p "$SP/e40/certs" && cd "$SP/e40/certs" && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
           -keyout key.pem -out cert.pem -days 30 -subj "/CN=127.0.0.1" -addext "subjectAltName=IP:127.0.0.1" ;;
  bundle) "$SP/bin/heavy" node "$HERE/bundle.mjs" "$SP/e40/static" > "$R/bundle.jsonl" ;;
  _fanout) for t in data immediate; do for n in 1000 10000; do for m in tcp ws; do
             TICK=$t node "$E08/bench.mjs" impl=node subs=$n mode=$m rate=max runs=3 out="$R/fanout.jsonl"
           done; done; done ;;
  _cold) node "$HERE/cold.mjs" 10 "$R/cold.jsonl" ;;
  fanout|cold) "$SP/bin/timing" sh "$HERE/run.sh" "_$1" ;;
  summary) python3 "$HERE/summarize.py" "$R" ;;
  all) [ -f "$SP/e40/certs/cert.pem" ] || "$HERE/run.sh" certs; "$HERE/run.sh" bundle; "$HERE/run.sh" fanout; "$HERE/run.sh" cold; "$HERE/run.sh" summary ;;
  *) echo "unknown step $1"; exit 1 ;;
esac
