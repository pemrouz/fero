#!/bin/sh
# E-56 probes: the owner's one `connect` (I1-I4, I9, I11, I12), built on E-55's prototype. E-55's proto/lens.mjs and
# proto/net.mjs are imported from E-55's folder and never edited; proto/connect.mjs adds connect on top of them.
#   ./run.sh checks   probe 1 (a thenable handle), probe 3's identity check, probe 4 (lifetimes) with its planted bugs
#                     and with the first call inside connect(), and probe 5's two slips the types cannot catch
#                     (slips.mjs: a forgotten .get() printed; when an HTTP request says it closed); under the heavy lock
#   ./run.sh sims     E-55's seeded lifetime checks (its claims 7, 9 and 26) run on connect, then every planted bug;
#                     under the heavy lock
#   ./run.sh timing   probe 2 (for await: buffer growth, cost per delivery), probe 3 (what prev costs) and probe 4's
#                     cost of { signal } and { until } a link (signal.mjs), RUNS times each, every process alone under
#                     the timing lock and preceded by its load average
#   ./run.sh types    probe 5: tsc on check/ (must exit 0), then every must-fail line stripped (strip.mjs); under
#                     the heavy lock
#   ./run.sh summary  the timed tables, as ranges over the runs (node summarize.mjs), also written to results/tables.md
#   ./run.sh clean    remove the results; checks, sims, timing and types append, so a partial rerun adds to them
#   ./run.sh          clean, then all of the above
# Env: SP (required: a scratch folder of your own that holds the lock helpers bin/timing and bin/heavy),
# NODE (default node on PATH: Node 22.22.0; tsc 6.0.2 from PATH, or from NODE's folder when NODE is a path), RUNS (default "1 2 3"),
# DATA (data's folder for E-55's lens.mjs; default ../data next to this repo, at 63fea66), OUT (temp files; default
# $SP/e56/probes), NODEF (the node command with its flags; default NODE with a 4,000 MB heap cap). Raw JSON lines
# land in results/.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
: "${SP:?set SP to a scratch folder (it holds bin/timing and bin/heavy)}"
NODE=${NODE:-node}
TIMING=${TIMING:-$SP/bin/timing}
HEAVY=${HEAVY:-$SP/bin/heavy}
RUNS=${RUNS:-1 2 3}
OUT=${OUT:-$SP/e56/probes}
R=$HERE/results
B=$HERE/bench
mkdir -p "$R" "$OUT/tmp"
export TMPDIR=${TMPDIR:-$OUT/tmp}
case $NODE in */*) PATH="$(dirname "$NODE"):$PATH"; export PATH ;; esac
# every node process stays under 4 GB of heap (the box has 15 GB and no swap); NODEF overrides the whole command
NODEF=${NODEF:-"$NODE --expose-gc --experimental-strip-types --no-warnings --max-old-space-size=4000"}

# one process: its load average first, then its JSON line(s); a failure becomes a line too
one() {
  lock=$1; f=$2; run=$3; shift 3
  printf '{"run":%s,"loadavg":"%s","env":"%s","cmd":"%s"}\n' "$run" "$(cat /proc/loadavg)" "$(env | grep -E '^E5[56]_' | tr '\n' ' ')" "$*" >> "$f"
  (cd "$B" && $lock "$@" >> "$f" 2> "$OUT/stderr.txt") || printf '{"exp":"E-56","part":"failed","run":%s,"cmd":"%s","stderr":"%s"}\n' "$run" "$*" "$(tail -c 300 "$OUT/stderr.txt" | tr '\n"' '  ')" >> "$f"
}

checks() {
  F="$R/checks.jsonl"; H="one $HEAVY"
  $H "$F" 1 $NODEF thenable.mjs
  $H "$F" 1 $NODEF commit.mjs identity
  $H "$F" 1 $NODEF lifetimes.mjs
  (E56_FIRST=sync; export E56_FIRST; $H "$F" 1 $NODEF lifetimes.mjs) # the first call inside connect(), as E-55 built it
  for m in twice nosignalcleanup untilclosed; do (E56_MUTATE=$m; export E56_MUTATE; $H "$F" 1 $NODEF lifetimes.mjs); done
  $H "$F" 1 $NODEF slips.mjs
}

sims() {
  F="$R/sims.jsonl"; H="one $HEAVY"
  $H "$F" 1 $NODEF sims.mjs picture 1000
  (E56_FIRST=sync; export E56_FIRST; $H "$F" 1 $NODEF sims.mjs picture 1000)
  $H "$F" 1 $NODEF sims.mjs views 1000
  $H "$F" 1 $NODEF sims.mjs share
  # planted bugs: each must make its run fail (never set in a measured run). E-55's own three on the picture run, with
  # the first call a microtask later (the default) and inside connect(); then this folder's own
  for m in bornseq settled cover; do
    (E55_MUTATE=$m; export E55_MUTATE; $H "$F" 1 $NODEF sims.mjs picture 300)
    (E55_MUTATE=$m; E56_FIRST=sync; export E55_MUTATE E56_FIRST; $H "$F" 1 $NODEF sims.mjs picture 300)
  done
  for m in twice mergeprev mergedrop; do (E56_MUTATE=$m; export E56_MUTATE; $H "$F" 1 $NODEF sims.mjs picture 300); done
  (E55_MUTATE=viewleak; export E55_MUTATE; $H "$F" 1 $NODEF sims.mjs views 300)
  (E56_MUTATE=onceheld; export E56_MUTATE; $H "$F" 1 $NODEF sims.mjs views 300)
  for m in twice percopy; do (E56_MUTATE=$m; export E56_MUTATE; $H "$F" 1 $NODEF sims.mjs share); done
}

timing() {
  F="$R/timing.jsonl"; T="one $TIMING"
  for run in $RUNS; do
    for m in merge every; do for s in row whole; do $T "$F" $run $NODEF foreach.mjs grow $m $s 5 10000 1; done; done
    $T "$F" $run $NODEF foreach.mjs cost
    for k in 1 10; do $T "$F" $run $NODEF commit.mjs prev $k; done
    $T "$F" $run $NODEF signal.mjs
  done
}

types() {
  F="$R/types.jsonl"
  if (cd "$HERE/check" && $HEAVY tsc -p tsconfig.json > "$OUT/tsc.txt" 2>&1); then e=0; else e=1; fi
  printf '{"exp":"E-56","probe":5,"tsc":"%s","config":"check/tsconfig.json","exit":%s,"errors":"%s"}\n' "$(tsc -v)" $e "$(tr '\n"' '  ' < "$OUT/tsc.txt" | cut -c1-400)" >> "$F"
  rm -rf "$OUT/strip"; mkdir -p "$OUT/strip"
  # run from the strip folder, so tsc prints file names only
  (cd "$OUT/strip" && $HEAVY $NODE "$HERE/strip.mjs" "$HERE/check" "$OUT/strip" full) > "$R/types-stripped.txt"
  printf '{"exp":"E-56","probe":5,"stripped":"%s"}\n' "$(tail -1 "$R/types-stripped.txt")" >> "$F"
}

# a fresh start: results from an earlier run are never mixed in
clean() { rm -f "$R"/checks.jsonl "$R"/sims.jsonl "$R"/timing.jsonl "$R"/types.jsonl "$R"/types-stripped.txt "$R"/tables.md; }

versions() {
  { $NODE --version; tsc -v; (cd "${DATA:-$(cd "$HERE/../../../../../.." && pwd)/data}" && git log -1 --format='data %h %cs'); uname -r; nproc; } > "$R/versions.txt"
}

case "$1" in
  checks) versions; checks ;;
  sims) sims ;;
  timing) versions; timing ;;
  types) types ;;
  summary) $NODE "$HERE/summarize.mjs" > "$R/tables.md"; cat "$R/tables.md" ;;
  clean) clean ;;
  "") clean; versions; types; checks; sims; timing; $NODE "$HERE/summarize.mjs" > "$R/tables.md" ;;
  *) echo "usage: run.sh [clean|checks|sims|timing|types|summary]"; exit 1 ;;
esac
