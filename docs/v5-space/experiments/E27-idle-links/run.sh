#!/bin/sh
# E-27: can one Node server hold 10,000 idle client links, over TLS, inside its memory budget?
#   ./run.sh certs      a self-signed P-256 certificate for the TLS runs ($SP/e27/certs)
#   ./run.sh tcp|tls    one timing hold: RUNS runs of e27.mjs (10,000 links, 60 s idle, 30 s with 1,000 active)
#   ./run.sh tls26      the tls hold again with Node 26.13.0 (OpenSSL 3.5 in both; V8 and libuv differ)
#   ./run.sh            certs if missing, both holds, summary
#   ./run.sh summary    the tables from results/runs.jsonl
# Memory is not a speed, but the idle-CPU and active lines are, so each run sits under the timing lock.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export SP
RUNS=${RUNS:-3}
NODE26=${NODE26:-$SP/dl/node26/node-v26.13.0-linux-x64/bin/node} # Node 26.13.0 (TOOLS.md), for the tls26 variant
case "${1:-all}" in
  certs) mkdir -p "$SP/e27/certs" && cd "$SP/e27/certs" && openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
           -keyout key.pem -out cert.pem -days 30 -subj "/CN=127.0.0.1" ;;
  _tcp|_tls) m=${1#_}; for run in $(seq 1 "$RUNS"); do node "$HERE/e27.mjs" "$m" 10000 60 30 "$HERE/results/runs.jsonl" "$run"; done ;;
  _tls26) for run in $(seq 1 "$RUNS"); do "$NODE26" "$HERE/e27.mjs" tls 10000 60 30 "$HERE/results/runs.jsonl" "$run"; done ;;
  tls26) "$SP/bin/timing" sh "$HERE/run.sh" _tls26 ;;
  tcp|tls) { node --version; node -p process.versions.openssl; uname -r; ulimit -n; } > "$HERE/results/versions.txt"; "$SP/bin/timing" sh "$HERE/run.sh" "_$1" ;;
  summary) python3 "$HERE/summarize.py" "$HERE/results/runs.jsonl" ;;
  all) [ -f "$SP/e27/certs/cert.pem" ] || "$HERE/run.sh" certs; "$HERE/run.sh" tcp; "$HERE/run.sh" tls; "$HERE/run.sh" summary ;;
  *) echo "unknown step $1"; exit 1 ;;
esac
