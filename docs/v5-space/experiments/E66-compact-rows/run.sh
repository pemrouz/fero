#!/bin/sh
# E-66: a compact row store for fero v5. What in the design depends on how rows sit in memory is read from the
# records and from data's code (COMPACT.md); these probes add the numbers E-65 did not have.
#   probes/rowread.mjs    one read of a held row by key: a row in data, against a column store that makes an
#                         object, a row view object (a flyweight), a Proxy, or no object at all
#   probes/keymap-gc.mjs  one forced full collection, with the fields in columns and the keys in a JavaScript Map
#                         (as data's keySlot keeps them) or in typed arrays
#   probes/ops-count.mjs  how much of data's engine reads rows as objects: a count of its source, nothing timed
#   probes/rowmake.mjs    (review) a row made by code written for the fixed shape, frozen or not, and the row view
#                         with a read that keeps the object; `--form=check` compares every form with data's rows
#   probes/keyindex.mjs   (review) the key index's own stall: one Map, 64 Maps, or X1's typed index, grown from empty
#
#   ./run.sh quick     small sizes, nothing written to results/. A minute or two. Ends "E-66 quick: ok" or exits 1.
#   ./run.sh full      the count, then three timed runs of every timed cell (about 25 minutes), then the summary
#   ./run.sh review    only the review's probes: three timed runs of rowmake and keyindex (about 15 minutes)
#   ./run.sh summary   results/summary.md from the files already there (runs nothing)
# Env: SP (a scratch folder of your own holding bin/timing, which runs a command alone on the box, and bin/heavy;
# without them the locks are skipped). NODE (default node on PATH, Node 22). DATA (data's folder, default ../data
# next to this repo, read only; E-66 ran at 63fea66). Every process runs with --max-old-space-size=3000.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
NODE=${NODE:-node}
N="$NODE --expose-gc --max-old-space-size=3000"
if [ -n "$SP" ] && [ -x "$SP/bin/timing" ]; then TIMING="$SP/bin/timing"; else TIMING=; fi
if [ -n "$SP" ] && [ -x "$SP/bin/heavy" ]; then HEAVY="$SP/bin/heavy"; else HEAVY=; fi
P=$HERE/probes; R=$HERE/results

case "${1:-quick}" in
quick)
  cd "$P"
  $NODE ops-count.mjs | tail -1 | tee /dev/stderr | grep -q '"holding_rows":\["BucketNode","FilterNode","MapNode"\],"maybe_rows":\["DistinctNode","ProjectionAggregate","ToValueNode","TrackedScalarNode"\]' || { echo "E-66 quick: the count changed; read it again"; exit 1; }
  $N rowread.mjs --form=data --rows=50000 --reads=200000
  $N rowread.mjs --form=col --rows=50000 --reads=200000 | grep -q '"checked_fields":8000' || { echo "E-66 quick: the row views disagree with the store"; exit 1; }
  for f in map ix keys; do $N keymap-gc.mjs --form=$f --rows=200000; done
  $N rowmake.mjs --form=check --rows=50000 | grep -q '"bad":0' || { echo "E-66 quick: a made row differs from data's row"; exit 1; }
  $N rowmake.mjs --form=col --rows=50000 --reads=100000 > /dev/null
  for f in map blocks ix; do $N keyindex.mjs --form=$f --rows=300000; done
  echo "E-66 quick: ok" ;;
full)
  cd "$P"
  $NODE ops-count.mjs > "$R/ops-count.jsonl"
  for run in 1 2 3; do
    for f in data col; do $TIMING $N rowread.mjs --form=$f --rows=1000000 --reads=1000000 | sed "s/^{/{\"run\":$run,/" >> "$R/rowread.jsonl"; done
    for n in 1000000 5000000; do for f in map ix keys; do
      $TIMING $N keymap-gc.mjs --form=$f --rows=$n | sed "s/^{/{\"run\":$run,/" >> "$R/keymap-gc.jsonl"
    done; done
  done
  "$0" review ;;
review)
  cd "$P"
  $HEAVY $N rowmake.mjs --form=check --rows=1000000 > "$R/rowmake-check.jsonl"
  for run in 1 2 3; do
    for n in 1000000 10000; do for f in data col; do
      $TIMING $N rowmake.mjs --form=$f --rows=$n --reads=1000000 | sed "s/^{/{\"run\":$run,/" >> "$R/rowmake.jsonl"
    done; done
    for f in map blocks ix; do $TIMING $N keyindex.mjs --form=$f --rows=16777217 | sed "s/^{/{\"run\":$run,/" >> "$R/keyindex.jsonl"; done
  done
  $NODE "$HERE/summarize.mjs" > "$R/summary.md"; cat "$R/summary.md" ;;
summary) $NODE "$HERE/summarize.mjs" > "$R/summary.md"; cat "$R/summary.md" ;;
*) echo "usage: ./run.sh quick|full|review|summary"; exit 2 ;;
esac
