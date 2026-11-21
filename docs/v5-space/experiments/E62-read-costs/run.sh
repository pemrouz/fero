#!/bin/sh
# E-62: the read surface's owed costs, timed (LAYERS 11 "Owed for the read surface" items 5, 6, 8, 10 and "Owed for
# V5-15" items 1 and 5; API.md 11.2). Six benches in bench/, each prints one JSON line per process:
#   fields.mjs     item 1: c.version, c.cursor and a diff entry's version on E-55 claim 10's harness (part, whole, alone)
#   countback.mjs  item 2: counting back for -N on E-19's slot layout, a cold partition beside a hot one
#   ended.mjs      item 3: the `ended` guard in the read trap, on E-55 claim 1's read harness
#   verstore.mjs   item 4: a version in the row's own entry in data's store (a scratch copy, patch/data-ver.patch)
#                  against the separate Map of E-56 positions
#   equals.mjs     item 5: an `equals` guard at the leader (deep compare, its JSON text, three hashes) and its bytes,
#                  beside a version guard
#   fieldback.mjs  item 6: a field's -N, the row's log read back past a busy sibling field
# Modes:
#   ./run.sh           full: clean results/, then every bench RUNS times, each process alone on the box (the timing
#                      lock held once for the whole set, so the box drains once), then results/summary.md
#   ./run.sh quick     one run of everything at small sizes and few rounds, under the heavy lock, into $OUT/quick
#                      (results/ untouched): a check that everything still runs, not a result
#   ./run.sh <bench>.. the named benches in full, their old lines replaced, under one hold of the timing lock:
#                      fields | countback | ended | verstore | equals | fieldback
#   ./run.sh again <bench>..  one more run of the named benches, appended: when summarize.mjs sets a run aside
#                      because other processes used a tenth of a CPU or more while it ran
#   ./run.sh summary   results/summary.md from the raw lines (node summarize.mjs)
# Env: SP (required: a scratch folder of your own that holds the lock helpers bin/timing, which runs a command alone
# on the box, and bin/heavy), NODE (default node on PATH: Node 22.22.0), RUNS (default "1 2 3"), DATA (data's folder,
# read only; default ../data next to this repo, at 63fea66), OUT (temp files and the patched copy of data's kernel;
# default $SP/e62), FLUSH_MB (countback's cache-clearing buffer, default 1,024 MB, off the heap). Every process runs
# with a 3,000 MB heap cap; the biggest, countback at 10^6 partitions, needs about 2 GB with its 1 GB buffer. Every
# result line carries `box`: the CPU time other processes used while it ran. Nothing is downloaded.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
: "${SP:?set SP to a scratch folder (it holds bin/timing and bin/heavy)}"
NODE=${NODE:-node}
TIMING=${TIMING:-$SP/bin/timing}
HEAVY=${HEAVY:-$SP/bin/heavy}
LOCK=$TIMING
RUNS=${RUNS:-1 2 3}
OUT=${OUT:-$SP/e62}
export DATA=${DATA:-$(cd "$HERE/../../../../.." && pwd)/data}
R=$HERE/results
NODEF="$NODE --expose-gc --experimental-strip-types --no-warnings --max-old-space-size=3000"
mkdir -p "$OUT"

# the scratch copy of data's kernel with a version in each row's entry (data itself is never edited)
dv() {
  rm -rf "$OUT/dv"; mkdir -p "$OUT/dv"
  cp -r "$DATA/kernel" "$DATA/contract" "$OUT/dv/"
  patch -s -p1 -d "$OUT/dv" < "$HERE/patch/data-ver.patch"
  export DV="$OUT/dv"
}

# The named benches' processes, all of their runs, under ONE hold of $LOCK (the timing lock; quick takes the heavy
# lock): the box drains once, not once per process, and each process still runs alone. inner's arguments are
# commands, and out=<file> to say where the lines of the commands after it go. A failed process leaves a line.
inner() {
  f=/dev/null
  case "$1" in out=*) ;; *.jsonl) f=$1; shift ;; esac # an older form: the result file first
  for c in "$@"; do
    case "$c" in out=*) f=${c#out=}; continue ;; esac
    (cd "$HERE/bench" && $NODEF $c >> "$f" 2> "$OUT/stderr.txt") || printf '{"exp":"E-62","bench":"failed","cmd":"%s","stderr":"%s"}\n' "$c" "$(tail -c 300 "$OUT/stderr.txt" | tr '\n"' '  ')" >> "$f"
  done
}
# a bench's commands, each once per run in RUNS
cmds() {
  case "$1" in
    fields) set -- "fields.mjs part" "fields.mjs whole" "fields.mjs alone" ;;
    countback) set -- "countback.mjs even-1e4" "countback.mjs even-1e5" "countback.mjs even-1e6" "countback.mjs hot-1" "countback.mjs hot-10" ;;
    ended) set -- "ended.mjs 1000" "ended.mjs 100000" "ended.mjs 1000000" ;;
    verstore) set -- "verstore.mjs 1000 row" "verstore.mjs 1000 field" "verstore.mjs 100000 row" "verstore.mjs 100000 field" "verstore.mjs 1000000 row" "verstore.mjs 1000000 field" ;;
    equals) set -- "equals.mjs" ;;
    fieldback) set -- "fieldback.mjs 10 0" "fieldback.mjs 100 0" "fieldback.mjs 1000 0" "fieldback.mjs 10 2" "fieldback.mjs 100 2" "fieldback.mjs 1000 2" ;;
  esac
  for run in $RUNS; do for c in "$@"; do printf '%s\n' "$c"; done; done
}
# one hold for every bench named: run.sh inner out=<file> <commands> out=<file> <commands> ...
timed() {
  list=""
  for b in "$@"; do list="$list
out=$R/$b.jsonl
$(cmds "$b")"; done
  case " $* " in *" verstore "*) dv ;; esac
  IFS='
'; set -- $list; unset IFS
  $LOCK sh "$HERE/run.sh" inner "$@"
}

versions() {
  { $NODE --version; (cd "$DATA" && git log -1 --format='data %h %cs'); uname -r; nproc; } > "$R/versions.txt"
}

quick() {
  R=$OUT/quick; rm -rf "$R"; mkdir -p "$R"; LOCK=$HEAVY; dv
  export ROUNDS=2 WRITES=20000 READS=20000 OPSX=0.05 RECORDS=500000 FLUSH_MB=64
  $LOCK sh "$HERE/run.sh" inner out="$R/fields.jsonl" "fields.mjs part" "fields.mjs whole" "fields.mjs alone" \
    out="$R/countback.jsonl" "countback.mjs even-1e4" "countback.mjs hot-10" out="$R/ended.jsonl" "ended.mjs 1000" \
    out="$R/verstore.jsonl" "verstore.mjs 1000 row" "verstore.mjs 1000 field" out="$R/equals.jsonl" "equals.mjs" \
    out="$R/fieldback.jsonl" "fieldback.mjs 100 2"
  $NODE "$HERE/summarize.mjs" "$R" > /dev/null
  grep -h '"failed"' "$R"/*.jsonl || echo "quick: every process ran; $R/summary.md"
}

ALL="fields countback ended verstore equals fieldback"
case "$1" in
  inner) shift; inner "$@" ;;
  quick) quick ;;
  summary) $NODE "$HERE/summarize.mjs" "$R" ;;
  again) shift; for b in "$@"; do case " $ALL " in *" $b "*) ;; *) echo "usage: run.sh again <bench>...; benches: $ALL"; exit 1 ;; esac; done
     RUNS=again; timed "$@" ;;
  "") mkdir -p "$R"; rm -f "$R"/*.jsonl "$R"/summary.md; versions; timed $ALL; $NODE "$HERE/summarize.mjs" "$R" ;;
  *) for b in "$@"; do case " $ALL " in *" $b "*) ;; *) echo "usage: run.sh [quick|summary|<bench>...]; benches: $ALL"; exit 1 ;; esac; done
     mkdir -p "$R"; for b in "$@"; do rm -f "$R/$b.jsonl"; done; versions; timed "$@" ;;
esac
