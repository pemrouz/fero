#!/bin/sh
# Probe P6: the markers. Makes the marked throwaway copies, runs the switch-off pass, and the
# two cost checks. Nothing here writes into the repo; everything goes to WORK.
#
#   WORK=<scratch dir> sh probes/p6/run.sh marked     the marked copy of the Raft port, built both ways
#   WORK=... CORPUS=<dir with seed2 seed3 seed5 seed7> sh probes/p6/run.sh raft    the pass over Raft's markers
#   WORK=... E22=<the design branch's E22-api-prototype folder> DATA=<data checkout> sh probes/p6/run.sh ts
#   ... sh probes/p6/run.sh raft-short | ts-short     the same with short tests (SHORT scripts per corpus; SHORT seeds per check)
#   ... sh probes/p6/run.sh ts-one                    the short TypeScript checks in one process per rule
#   WORK=... sh probes/p6/run.sh bytes      the release build with markers against the one without
#   WORK=... sh probes/p6/run.sh bench      the TypeScript marker's cost, a micro-bench
#
# Environment:
#   WORK    scratch directory (required).
#   CORPUS  the Go-filled random scripts, made by crates/raft-harness/diff/run_diff.sh corpus.
#   E22, DATA  the API prototype experiment on the design branch, and data at the commit it used.
#   JOBS    workers for the pass (default 1). HEAVY, TIMING: optional lock wrappers put in front
#           of the builds and of the timed runs.
# Needs: cargo (the pinned toolchain), node 22.18 or newer, patch, diff, objcopy, cmp.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
: "${WORK:?set WORK to a scratch directory}"
mkdir -p "$WORK"
WORK=$(cd "$WORK" && pwd)
HEAVY=${HEAVY:-}
TIMING=${TIMING:-}
JOBS=${JOBS:-1}
what=${1:-}
M=$WORK/marked

# A workspace with the port, its harness and the marker crate. $1: the folder; $2: "marked" or "plain".
make_ws() {
  [ -e "$1" ] && { echo "$1 exists already; remove it first"; exit 1; }
  mkdir -p "$1/crates"
  cp -r "$ROOT/crates/raft" "$ROOT/crates/raft-harness" "$ROOT/crates/rule" "$1/crates/"
  cp "$ROOT/clippy.toml" "$ROOT/rustfmt.toml" "$ROOT/rust-toolchain.toml" "$1/"
  sed 's|^members = .*|members = ["crates/raft", "crates/raft-harness", "crates/rule"]|' "$ROOT/Cargo.toml" > "$1/Cargo.toml"
  (cd "$1" && patch -s -p1 < "$HERE/raft-markers.patch")
  if [ "$2" = plain ]; then
    # The same manifests and tests as the marked copy, with the port's own unmarked sources.
    rm -r "$1/crates/raft/src"
    cp -r "$ROOT/crates/raft/src" "$1/crates/raft/src"
  fi
}

case "$what" in
marked)
  make_ws "$M" marked
  cd "$M"
  $HEAVY cargo build -q --release -p raft-harness
  ./target/release/raft-datadriven | tail -1
  $HEAVY cargo build -q --release -p raft-harness --features switch --target-dir target-switch
  # Stable names for the test programs of the switch build.
  mkdir -p "$M/bins"
  $HEAVY cargo test -q --release --features switch --target-dir target-switch --no-run --message-format=json 2>/dev/null | node -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      for (const l of s.split("\n")) { if (!l.startsWith("{")) continue; const j = JSON.parse(l)
        if (j.reason === "compiler-artifact" && j.profile.test && j.executable) console.log(j.target.kind[0] + "-" + j.target.name, j.executable) } })' |
    while read -r name exe; do ln -sf "$exe" "$M/bins/$name"; done
  ln -sf "$M/target-switch/release/raft-datadriven" "$M/bins/raft-datadriven"
  ln -sf "$M/target-switch/release/raft-diff" "$M/bins/raft-diff"
  node "$ROOT/tools/rule-scan.mjs" "$M/crates" | tail -1
  ;;
raft)
  : "${CORPUS:?set CORPUS to the folder with seed2, seed3, seed5 and seed7}"
  [ -d "$M/bins" ] || { echo "run '$0 marked' first"; exit 1; }
  export MARKED="$M" CORPUS
  $TIMING node "$HERE/pass.mjs" run "$HERE/raft.suite.json" --out "$WORK/raft-pass-j$JOBS.jsonl" --jobs "$JOBS"
  ;;
raft-short)
  # The short run: the 41 files and the first SHORT scripts of each corpus (default 100), no harness tests.
  : "${CORPUS:?set CORPUS to the folder with seed2, seed3, seed5 and seed7}"
  [ -d "$M/bins" ] || { echo "run '$0 marked' first"; exit 1; }
  SHORT=${SHORT:-100}
  C=$WORK/corpus-short-$SHORT
  if [ ! -d "$C" ]; then
    for s in seed2 seed3 seed5 seed7; do
      mkdir -p "$C/$s/in" "$C/$s/out"
      ls "$CORPUS/$s/out" | sort | head -n "$SHORT" | while read -r f; do
        ln -s "$CORPUS/$s/out/$f" "$C/$s/out/$f"; ln -s "$CORPUS/$s/in/$f" "$C/$s/in/$f"
      done
    done
  fi
  node -e '
    const fs = require("fs"), [M, C, out] = process.argv.slice(1)
    const tests = [{ name: "files", group: "files", cwd: M, cmd: [M + "/bins/raft-datadriven"], timeout_ms: 5000 }]
    for (const s of ["seed2", "seed3", "seed5", "seed7"]) tests.push({ name: "scripts-" + s, group: "scripts", cwd: M, cmd: [M + "/bins/raft-diff", `${C}/${s}/out`, `${C}/${s}/in`], timeout_ms: 5000 })
    fs.writeFileSync(out, JSON.stringify({ name: "raft", scan: [M + "/crates"], tests }, null, 1))' "$M" "$C" "$WORK/raft-short.suite.json"
  $TIMING node "$HERE/pass.mjs" run "$WORK/raft-short.suite.json" --out "$WORK/raft-short-pass-j$JOBS.jsonl" --jobs "$JOBS"
  ;;
ts|ts-short)
  : "${E22:?set E22 to the design branch folder docs/v5-space/experiments/E22-api-prototype}"
  : "${DATA:?set DATA to the data checkout}"
  T=$WORK/e22-marked
  if [ ! -d "$T" ]; then
    cp -r "$E22" "$T"
    (cd "$T" && patch -s -p1 < "$HERE/l2-markers.patch")
    cp "$HERE/rule.ts" "$HERE/rule-env.ts" "$T/proto/"
  fi
  # The suite: every check of the prototype and of its patterns, each as one test. The short run
  # gives each check SHORT seeds (default 3) in place of its own 20 to 200.
  SEEDS=""; [ "$what" = ts-short ] && SEEDS=${SHORT:-3}
  node -e '
    const fs = require("fs"), path = require("path"), T = process.argv[1], seeds = process.argv[3]
    const n = ["node", "--experimental-strip-types", "--no-warnings", "--import", path.join(T, "proto/rule-env.ts")]
    const tests = []
    for (const [group, dir] of [["core", "checks"], ["patterns", "patterns/checks"]])
      for (const f of fs.readdirSync(path.join(T, dir)).filter(f => f.endsWith(".check.ts")).sort())
        tests.push({ name: group + "/" + f.replace(".check.ts", ""), group, cwd: path.join(T, dir, ".."), cmd: [...n, path.join(T, dir, f), ...(seeds ? ["--seeds", seeds] : [])], timeout_ms: seeds ? 20000 : 120000 })
    fs.writeFileSync(process.argv[2], JSON.stringify({ name: "ts", scan: [path.join(T, "proto")], tests }, null, 1))' "$T" "$WORK/$what.suite.json" "$SEEDS"
  export DATA
  $TIMING node "$HERE/pass.mjs" run "$WORK/$what.suite.json" --out "$WORK/$what-pass-j$JOBS.jsonl" --jobs "$JOBS"
  ;;
ts-one)
  # The same checks in ONE node process per rule, SHORT seeds each (default 3).
  T=$WORK/e22-marked
  [ -d "$T" ] || { echo "run '$0 ts' or '$0 ts-short' first"; exit 1; }
  : "${DATA:?set DATA to the data checkout}"
  cp "$HERE/all-checks.ts" "$T/all-checks.ts"
  cat > "$WORK/ts-one.suite.json" <<JSON
{ "name": "ts", "scan": ["$T/proto"], "tests": [ { "name": "all-checks", "group": "one process", "cwd": "$T",
  "cmd": ["node", "--experimental-strip-types", "--no-warnings", "--import", "$T/proto/rule-env.ts", "$T/all-checks.ts", "--seeds", "${SHORT:-3}"], "timeout_ms": 60000 } ] }
JSON
  export DATA
  $TIMING node "$HERE/pass.mjs" run "$WORK/ts-one.suite.json" --out "$WORK/ts-one-pass-j$JOBS.jsonl" --jobs "$JOBS"
  ;;
bytes)
  # Build the unmarked sources and the marked sources at ONE path, with the same manifests, with
  # no switch feature. Then compare the programs section by section.
  B=$WORK/bytes
  [ -e "$B" ] && { echo "$B exists already; remove it first"; exit 1; }
  mkdir -p "$B/plain" "$B/marked"
  for kind in plain marked; do
    make_ws "$B/ws" "$kind"
    (cd "$B/ws" && $HEAVY cargo build -q --release -p raft-harness && cp target/release/raft-datadriven target/release/raft-diff "$B/$kind/")
    mv "$B/ws" "$B/ws-$kind"
  done
  RC=0
  for bin in raft-datadriven raft-diff; do
    for sec in .text .rodata .eh_frame .data.rel.ro; do
      for kind in plain marked; do objcopy -O binary --only-section=$sec "$B/$kind/$bin" "$B/$kind/$bin$sec"; done
      size=$(wc -c < "$B/plain/$bin$sec")
      differ=$(cmp -l "$B/plain/$bin$sec" "$B/marked/$bin$sec" 2>/dev/null | wc -l)
      [ "$size" = "$(wc -c < "$B/marked/$bin$sec")" ] || differ="the sizes differ"
      echo "$bin $sec: $size bytes, bytes that differ: $differ"
      if [ "$sec" != .data.rel.ro ] && [ "$differ" != 0 ]; then RC=1; fi
    done
  done
  [ $RC = 0 ] && echo "ok bytes: the code (.text), the constants (.rodata) and the unwind tables are byte-equal" || echo "FAILED bytes"
  exit $RC
  ;;
bench)
  $TIMING node --no-warnings "$HERE/bench.ts"
  ;;
*)
  sed -n '2,20p' "$0"; exit 2 ;;
esac
