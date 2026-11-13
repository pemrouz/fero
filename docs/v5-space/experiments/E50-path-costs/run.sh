#!/bin/sh
# E-50: the micro-benchmarks behind PATHS.md. Every process runs alone on the box (the study's timing lock) and well
# under a minute. Each part runs RUNS times (default 3), interleaved. Raw output lands in results/<name>.jsonl: one
# /proc/loadavg line, then one JSON line, per process. bench/summarize.py prints results/tables.md from them.
#   ./run.sh setup     the scratch tree (bench/tree.sh) and a self-signed P-256 certificate (as E-27's), in $WORK
#   ./run.sh write     bench/write:  crc, codec, hop, strdec
#   ./run.sh reads     bench/reads:  local-read (1e3, 1e5, 1e6 rows), snapshot-serve (1e5, 1e6), route, substream
#   ./run.sh upkeep    bench/upkeep: b1-checksum, b2-decode
#   ./run.sh core      bench/core:   api, alloc, sys, jthread, hopcpu, link, codecbytes, jsonval
#   ./run.sh profile   one CPU profile per api.ts mode ($WORK/prof), summed by area into results/prof-<mode>.json
#   ./run.sh check     the benches added after the skeptic's check of PATHS.md: upkeep/b3-kept (field, small and
#                      2 KB rows decoded once and kept, in four forms), core/field, core/escape, core/sys2 (the flush
#                      split), core/raftport (E-10's port in E-11's host at 10,000 and 50,000 writes a second),
#                      then bigkept (b3's 2 KB rows at 1,000,000 kept, about 2 GB of heap; also ./run.sh bigkept)
#   ./run.sh tables    bench/summarize.py prints results/tables.md and results/first-pass/tables.md
#   ./run.sh           all of the above, in that order (about 35 minutes of box time on 4 vCPU)
# Env: SP (the study's scratchpad; $SP/bin/timing is the lock), WORK (default $SP/e50: the tree, temp files, certs,
# profiles; never inside the repo), FERO and DATA (see bench/tree.sh), RUNS (default 3).
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
export WORK=${WORK:-$SP/e50}
export TREE=$WORK/tree
export CERTS=$WORK/certs
RUNS=${RUNS:-3}
R=$HERE/results
B=$HERE/bench
TS="node --experimental-strip-types --no-warnings"
T=$SP/bin/timing
if [ ! -x "$T" ]; then echo "no timing lock at $T: running without it (numbers may suffer from neighbours)" >&2; T=; fi
mkdir -p "$R" "$WORK"

# one <results name> <dir under bench> <command...>: one process inside one lock hold, its load average first
one() { f=$1; d=$2; shift 2; ( cd "$B/$d" && $T sh -c 'cat /proc/loadavg; exec "$@"' sh "$@" ) >> "$R/$f.jsonl"; }

setup() {
  "$B/tree.sh" "$TREE"
  if [ ! -f "$CERTS/cert.pem" ]; then
    mkdir -p "$CERTS"
    openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
      -keyout "$CERTS/key.pem" -out "$CERTS/cert.pem" -days 30 -subj "/CN=127.0.0.1" 2> /dev/null
  fi
  { cat "$TREE/VERSIONS"; node --version; node -p 'process.versions.openssl'; uname -r; nproc; grep -m1 'model name' /proc/cpuinfo; free -g | sed -n 2p; } > "$R/versions.txt"
}

write() {
  for run in $(seq "$RUNS"); do
    one crc write node crc.mjs
    one codec write $TS codec.ts
    one hop write node hop.mjs
    one strdec write node strdec.mjs
  done
}

reads() {
  [ -d "$TREE/fero" ] || setup
  for run in $(seq "$RUNS"); do
    for n in 1000 100000 1000000; do one local-read reads node --expose-gc local-read.mjs $n; done
    for n in 100000 1000000; do one snapshot-serve reads node --expose-gc snapshot-serve.mjs $n; done
    one route reads node --expose-gc route.mjs
    one substream reads node --expose-gc substream.mjs
  done
}

upkeep() {
  for run in $(seq "$RUNS"); do
    one b1 upkeep node --experimental-strip-types b1-checksum.mjs $run
    one b2 upkeep node --experimental-strip-types --expose-gc b2-decode.mjs $run 200000
  done
}

core() {
  [ -d "$TREE/fero" ] && [ -f "$CERTS/cert.pem" ] || setup
  for run in $(seq "$RUNS"); do
    for m in write-num write-row inbound-num inbound-row; do one api core $TS --expose-gc api.ts $m 20000 7; done
    for m in alloc-write-num alloc-write-row alloc-inbound-num alloc-inbound-row; do
      one alloc core $TS --expose-gc --min-semi-space-size=128 --max-semi-space-size=256 alloc.ts $m 5000 7
    done
    for m in fsync-grow fsync-over a1 a2; do one sys core node sys.mjs $m 1500; done
    one sys core node jthread.mjs 1500
    one sys core node hopcpu.mjs 20000
    for m in write writev imm; do one sys core node sys.mjs $m 200000; done
    for m in tick1 idle; do one sys core node sys.mjs $m 3000; done
    for m in tcp-each tls-each; do one link core node link.mjs $m 100000; done
    for m in tcp-cork64 tcp-cat64 tls-cork64 tls-cat64; do one link core node link.mjs $m 400000; done
    for m in hs-tcp hs-tls; do one link core node link.mjs $m 300; done
    one link core node link.mjs crypto
    one codecbytes core $TS codecbytes.ts
    one jsonval core $TS jsonval.mjs
  done
  rm -rf "$WORK/tmp"
}

profile() {
  [ -d "$TREE/fero" ] || setup
  mkdir -p "$WORK/prof"
  for m in write-num write-row inbound-num inbound-row; do
    ( cd "$B/core" && PROF=$WORK/prof/$m.cpuprofile $T $TS --expose-gc api.ts $m 20000 7 > /dev/null )
    node "$B/core/profsum.mjs" "$WORK/prof/$m.cpuprofile" 20 > "$R/prof-$m.json"
  done
}

check() {
  for run in $(seq "$RUNS"); do
    # (loop names apart from one()'s f and d: sh variables are global)
    for shp in field small big; do for frm in v4 rec json v8; do for kp in 0 1; do
      one b3 upkeep node --experimental-strip-types --no-warnings --max-old-space-size=6144 b3-kept.mjs $shp $frm $kp
    done; done; done
    one field core node --experimental-strip-types --no-warnings field.mjs
    one escape core node escape.mjs
    for m in inplace inplacef a1 a1f a2d a2; do one sys2 core node sys2.mjs $m 1500; done
    for n in 1 16; do for r in 10000 50000; do one raftport core node raftport.mjs $n $r; done; done
  done
  bigkept
  rm -rf "$WORK/tmp" "$WORK/raft"
}

# b3 at four times the rows: 1,000,000 kept 2 KB rows (about 2 GB of heap), to see whether the ratios hold as the heap grows
bigkept() {
  for run in $(seq "$RUNS"); do
    for frm in v4 rec json v8; do
      one b3 upkeep node --experimental-strip-types --no-warnings --max-old-space-size=8192 b3-kept.mjs big $frm 1 1000000
    done
  done
}

tables() { python3 "$B/summarize.py" > "$R/tables.md"; [ ! -d "$R/first-pass" ] || python3 "$B/summarize.py" "$R/first-pass" > "$R/first-pass/tables.md"; }

case "${1:-all}" in
  setup|write|reads|upkeep|core|profile|check|bigkept|tables) "$1" ;;
  all) setup; write; reads; upkeep; core; profile; check; tables ;;
  *) echo "usage: run.sh [setup|write|reads|upkeep|core|profile|check|tables|all]" >&2; exit 2 ;;
esac
