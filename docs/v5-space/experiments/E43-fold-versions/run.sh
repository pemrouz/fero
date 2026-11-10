#!/bin/sh
# E-43: do two data versions, and two Node versions, fold the same records to the same rows?
#   ./run.sh gen      write the 1e6-record stream on Node 22 and again on Node 26; compare the bytes
#   ./run.sh fold     fold it with 8 data commits x 2 Node versions x up to 5 modes (heavy lock, 2 at a time)
#   ./run.sh diff     compare the pairs, find the root records, explain and count them
#   ./run.sh probes   the Node behaviour probe, the views probe, the odd-names probe
#   ./run.sh          all of it (about 25 minutes)
# Needs ./fetch.sh first (data's history, exported commits, the scratch trees). Not a timing run.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
W=$SP/e43
R=$HERE/results
N22="/opt/node22/bin/node --experimental-strip-types --no-warnings"
N26="$SP/dl/node26/node-v26.13.0-linux-x64/bin/node --no-warnings"
COMMITS="4479a92 6b615e2 b831319 46df5f9 ff85e6c dc65b8f 2b8b780 63fea66"   # SCHEDULE_VERSION 1, 2, 2, 3, 3, 4, 4, 4
LANE="b831319 46df5f9 ff85e6c dc65b8f 2b8b780 63fea66"                      # the hot lane exists from b831319 on
SEAM="ff85e6c dc65b8f 2b8b780 63fea66"                                      # fero's substrate.ts imports resolve from ff85e6c on
HEAD=63fea66
RECORDS=${RECORDS:-1000000}
S=$W/stream
mkdir -p "$R" "$W/out"
export TZ=UTC LANG=C LC_ALL=C
cd "$HERE"

gen() {
  $N22 gen.mjs $W/tree/$HEAD $S $RECORDS 43 > "$R/gen.jsonl"
  $N26 gen.mjs $W/tree/$HEAD $W/stream26 $RECORDS 43 >> "$R/gen.jsonl"
  cmp $S/stream.log $W/stream26/stream.log && cmp $S/stream.kinds $W/stream26/stream.kinds && echo '{"streamBytesEqualOnNode22AndNode26":true}' >> "$R/gen.jsonl"
  rm -rf $W/stream26
  python3 -c "import json;d=json.load(open('$S/stream.json'));json.dump({k:d[k] for k in ['seed','records','frames','bytes','sha256','nkeys','count']},open('$R/stream.json','w'),indent=1)"
}

# one fold: <node tag> <commit> <mode>
one() {
  case $1 in n22) N=$N22;; n26) N=$N26;; esac
  $N fold.mjs $W/tree/$2 $S $3 $W/out/$2-$3-$1 > $W/out/$2-$3-$1.line 2> $W/out/$2-$3-$1.err || echo "{\"data\":\"$2\",\"mode\":\"$3\",\"node\":\"$1\",\"failed\":true}" > $W/out/$2-$3-$1.line
}
jobs_list() {
  for n in n22 n26; do
    for c in $COMMITS; do echo "$n $c ingest-rec"; echo "$n $c ingest-b256"; done
    for c in $LANE; do echo "$n $c lane-rec"; echo "$n $c lane-b256"; done
    for c in $SEAM; do echo "$n $c seam"; done
  done
}
fold() {
  jobs_list > $W/jobs.txt
  # two at a time, in holds of at most about 25 minutes
  split -l 24 $W/jobs.txt $W/jobs.part.
  for part in $W/jobs.part.*; do
    "$SP/bin/heavy" sh -c "xargs -P 2 -L 1 '$HERE/run.sh' _one < $part"
  done
  cat $W/out/*.line > "$R/fold.jsonl"
  rm -f $W/jobs.part.*
}
if [ "$1" = _one ]; then one $2 $3 $4; exit 0; fi

# one pair: <name> <a prefix> <b prefix> <a tree> <b tree> <mode> <node a> <node b>
pair() {
  name=$1; A=$W/out/$2; B=$W/out/$3
  d=$(node diff.mjs $S $A $B $W/out/$name.roots)
  echo "{\"pair\":\"$name\",\"a\":\"$2\",\"b\":\"$3\",\"diff\":$d}" >> "$R/pairs.jsonl"
  if [ -s $W/out/$name.roots ]; then
    head -3000 $W/out/$name.roots > $W/out/$name.roots.head   # explain at most the first 3,000 roots
    $7 fold.mjs $W/tree/$4 $S $6 $W/out/$name.xa 0 $W/out/$name.roots.head > /dev/null
    $8 fold.mjs $W/tree/$5 $S $6 $W/out/$name.xb 0 $W/out/$name.roots.head > /dev/null
    node classify.mjs $W/out/$name.xa.explain.jsonl $W/out/$name.xb.explain.jsonl $4 $5 > "$R/roots-$name.json"
  fi
}
# two ways in at one commit: <name> <a prefix> <b prefix> <commit> <a mode> <b mode>
ways() {
  name=$1; A=$W/out/$2; B=$W/out/$3
  d=$(node diff.mjs $S $A $B $W/out/$name.roots)
  echo "{\"pair\":\"$name\",\"a\":\"$2\",\"b\":\"$3\",\"diff\":$d}" >> "$R/pairs.jsonl"
  rm -f "$R/roots-$name.json"
  if [ -s $W/out/$name.roots ]; then
    head -3000 $W/out/$name.roots > $W/out/$name.roots.head
    $N22 fold.mjs $W/tree/$4 $S $5 $W/out/$name.xa 0 $W/out/$name.roots.head > /dev/null
    $N22 fold.mjs $W/tree/$4 $S $6 $W/out/$name.xb 0 $W/out/$name.roots.head > /dev/null
    node classify.mjs $W/out/$name.xa.explain.jsonl $W/out/$name.xb.explain.jsonl "$5" "$6" > "$R/roots-$name.json"
  fi
}
diffs() {
  : > "$R/pairs.jsonl"
  # data version pairs on Node 22, through the hot lane (one record a call)
  pair lane-v2-v3        b831319-lane-rec-n22 46df5f9-lane-rec-n22 b831319 46df5f9 lane-rec "$N22" "$N22"
  pair lane-v3-v3        46df5f9-lane-rec-n22 ff85e6c-lane-rec-n22 46df5f9 ff85e6c lane-rec "$N22" "$N22"
  pair lane-v3-v4        ff85e6c-lane-rec-n22 dc65b8f-lane-rec-n22 ff85e6c dc65b8f lane-rec "$N22" "$N22"
  pair lane-v4-v4later   dc65b8f-lane-rec-n22 2b8b780-lane-rec-n22 dc65b8f 2b8b780 lane-rec "$N22" "$N22"
  pair lane-v4later-head 2b8b780-lane-rec-n22 63fea66-lane-rec-n22 2b8b780 63fea66 lane-rec "$N22" "$N22"
  # the same through ingest (the client mirror path), which also exists at versions 1 and 2
  pair ingest-v1-v2        4479a92-ingest-rec-n22 6b615e2-ingest-rec-n22 4479a92 6b615e2 ingest-rec "$N22" "$N22"
  pair ingest-v2-v2        6b615e2-ingest-rec-n22 b831319-ingest-rec-n22 6b615e2 b831319 ingest-rec "$N22" "$N22"
  pair ingest-v2-v3        b831319-ingest-rec-n22 46df5f9-ingest-rec-n22 b831319 46df5f9 ingest-rec "$N22" "$N22"
  pair ingest-v3-v4        ff85e6c-ingest-rec-n22 dc65b8f-ingest-rec-n22 ff85e6c dc65b8f ingest-rec "$N22" "$N22"
  pair ingest-v4-v4later   dc65b8f-ingest-rec-n22 2b8b780-ingest-rec-n22 dc65b8f 2b8b780 ingest-rec "$N22" "$N22"
  pair ingest-v4later-head 2b8b780-ingest-rec-n22 63fea66-ingest-rec-n22 2b8b780 63fea66 ingest-rec "$N22" "$N22"
  # fero's own seam (the lane plus its two repairs)
  pair seam-v3-v4          ff85e6c-seam-n22 dc65b8f-seam-n22 ff85e6c dc65b8f seam "$N22" "$N22"
  pair seam-v4-v4later     dc65b8f-seam-n22 2b8b780-seam-n22 dc65b8f 2b8b780 seam "$N22" "$N22"
  pair seam-v4later-head   2b8b780-seam-n22 63fea66-seam-n22 2b8b780 63fea66 seam "$N22" "$N22"
  # the lane against fero's seam, and the lane against ingest, at HEAD: three ways in, one record stream
  ways head-lane-vs-seam   63fea66-lane-rec-n22 63fea66-seam-n22 63fea66 lane-rec seam
  ways head-lane-vs-ingest 63fea66-lane-rec-n22 63fea66-ingest-rec-n22 63fea66 lane-rec ingest-rec
  # every root of the pair inside SCHEDULE_VERSION 4, not only the first 3,000
  $N22 fold.mjs $W/tree/dc65b8f $S lane-rec $W/out/all.xa 0 $W/out/lane-v4-v4later.roots > /dev/null
  $N22 fold.mjs $W/tree/2b8b780 $S lane-rec $W/out/all.xb 0 $W/out/lane-v4-v4later.roots > /dev/null
  node classify.mjs $W/out/all.xa.explain.jsonl $W/out/all.xb.explain.jsonl dc65b8f 2b8b780 > $W/out/roots-all.json
  python3 allroots.py $W/out/roots-all.json > "$R/roots-lane-v4-v4later-all.txt"
  # Node 22 against Node 26, every commit and per-record mode
  for c in $COMMITS; do pair node-$c-ingest $c-ingest-rec-n22 $c-ingest-rec-n26 $c $c ingest-rec "$N22" "$N26"; done
  for c in $LANE; do pair node-$c-lane $c-lane-rec-n22 $c-lane-rec-n26 $c $c lane-rec "$N22" "$N26"; done
  for c in $SEAM; do pair node-$c-seam $c-seam-n22 $c-seam-n26 $c $c seam "$N22" "$N26"; done
}

probes() {
  $N22 nodeprobe.mjs > "$R/nodeprobe-node22.txt"
  $N26 nodeprobe.mjs > "$R/nodeprobe-node26.txt"
  diff "$R/nodeprobe-node22.txt" "$R/nodeprobe-node26.txt" > "$R/nodeprobe.diff" || true
  : > "$R/views.jsonl"
  for c in ff85e6c dc65b8f $HEAD; do
    $N22 views.mjs $W/tree/$c $S 200000 >> "$R/views.jsonl"
    $N26 views.mjs $W/tree/$c $S 200000 >> "$R/views.jsonl"
  done
  : > "$R/bigarray.jsonl"
  timeout 120 $N22 bigarray.mjs $W/tree/$HEAD >> "$R/bigarray.jsonl" || true
  timeout 120 $N26 bigarray.mjs $W/tree/$HEAD >> "$R/bigarray.jsonl" || true
  : > "$R/history.jsonl"
  $N22 history.mjs $W/tree/$HEAD >> "$R/history.jsonl"
  $N26 history.mjs $W/tree/$HEAD >> "$R/history.jsonl"
  : > "$R/hostile.jsonl"
  for c in $LANE; do $N22 hostile.mjs $W/tree/$c >> "$R/hostile.jsonl"; done
  $N26 hostile.mjs $W/tree/$HEAD >> "$R/hostile.jsonl"
}

case "$1" in
  gen) gen;; fold) fold;; diff) "$SP/bin/heavy" "$HERE/run.sh" _diffs;; _diffs) diffs;; probes) "$SP/bin/heavy" "$HERE/run.sh" _probes;; _probes) probes;;
  '') gen; fold; "$SP/bin/heavy" "$HERE/run.sh" _diffs; "$SP/bin/heavy" "$HERE/run.sh" _probes; python3 "$HERE/summarize.py" > "$R/summary.md";;
  *) echo "usage: run.sh [gen|fold|diff|probes]"; exit 2;;
esac
