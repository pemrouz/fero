#!/bin/sh
# E-29: (a) the power-loss test tier on LazyFS; (b) a full disk: the reserve each operation needs, and the refusal order.
#   ./run.sh a        LazyFS: what it models, the power-loss rounds, the mutants, the rough rate   (about 12 minutes)
#   ./run.sh b        64 MB filesystems (tmpfs and ext4 on a loop device): solo journal and three-process pipeline (about 6 minutes)
#   ./run.sh          both
# Needs root (FUSE and loop mounts) and LazyFS 0.3.1 built by ../tools-fetch.sh (see ../TOOLS.md). Not a timing run:
# it goes through the heavy lock, in holds of a few minutes.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
SP=${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}
W=$SP/e29
R=$HERE/results
mkdir -p "$W" "$R"
cd "$HERE"
N="node"

a() {
  { echo "node $(node --version)"; echo "kernel $(uname -r)"; echo "LazyFS 0.3.1, git $(git -C "$SP/dl/lazyfs/src" rev-parse --short HEAD)"; fusermount3 -V; mkfs.ext4 -V 2>&1 | head -1; } > "$R/versions.txt" 2>&1 || true
  L=$W/probe; mkdir -p "$L"; ./lazyfs.sh down "$L" 2>/dev/null || true; rm -rf "$L/root"; ./lazyfs.sh up "$L"
  $N a_probe.mjs "$L" > "$R/a-lazyfs-model.jsonl"
  $N a_rate.mjs "$L" > "$R/a-rate.jsonl"
  ./lazyfs.sh down "$L"
  : > "$R/a-powerloss.jsonl"; : > "$R/a-mutants.jsonl"
  for seed in 1 2 3; do
    $N a_powerloss.mjs "$W/a" clear 400 $seed >> "$R/a-powerloss.jsonl"
    $N a_powerloss.mjs "$W/a" recycle 400 $seed >> "$R/a-powerloss.jsonl"
    $N a_powerloss.mjs "$W/a" torn-op 40 $seed >> "$R/a-powerloss.jsonl"
    $N a_powerloss.mjs "$W/a" torn-seq 40 $seed >> "$R/a-powerloss.jsonl"
  done
  # every mutant against every scenario: which broken journal does which fault catch?
  for m in noSync noSeqCheck resync eagerCut; do
    $N a_powerloss.mjs "$W/a" clear 150 1 $m >> "$R/a-mutants.jsonl"
    $N a_powerloss.mjs "$W/a" recycle 150 1 $m >> "$R/a-mutants.jsonl"
    $N a_powerloss.mjs "$W/a" torn-op 25 1 $m >> "$R/a-mutants.jsonl"
    $N a_powerloss.mjs "$W/a" torn-seq 25 1 $m >> "$R/a-mutants.jsonl"
  done
  # the journal's own first bug (eagerCut) is rare: it needs the long runs that found it
  for seed in 1 2 3; do $N a_powerloss.mjs "$W/a" recycle 400 $seed eagerCut >> "$R/a-mutants.jsonl"; done
}

b() {
  : > "$R/b-solo.jsonl"
  mkdir -p "$W/b"
  for kind in tmpfs ext4; do
    ./fs64.sh up "$W/b" $kind $kind
    for part in naive policy nohead; do $N b_solo.mjs "$W/b/$kind" $kind $part >> "$R/b-solo.jsonl"; done
    if [ $kind = ext4 ]; then FREE_BLOCKS=8 OPS_CAP=1500 $N b_solo.mjs "$W/b/$kind" $kind cost >> "$R/b-solo.jsonl"   # the loop disk syncs slowly
    else $N b_solo.mjs "$W/b/$kind" $kind cost >> "$R/b-solo.jsonl"; fi
    ./fs64.sh down "$W/b" $kind
  done
  mkdir -p "$W/p"
  $N b_pipeline_run.mjs "$W/p" tmpfs 17310 > "$R/b-pipeline-tmpfs.jsonl" || true
  cp "$W/p/pipeline.log" "$W/p/pipeline-tmpfs.log"
  $N b_pipeline_run.mjs "$W/p" ext4 17320 > "$R/b-pipeline-ext4.jsonl" || true
}

case "$1" in
  a) "$SP/bin/heavy" "$HERE/run.sh" _a;; _a) a;;
  b) "$SP/bin/heavy" "$HERE/run.sh" _b;; _b) b;;
  '') "$SP/bin/heavy" "$HERE/run.sh" _a; "$SP/bin/heavy" "$HERE/run.sh" _b;;
  *) echo "usage: run.sh [a|b]"; exit 2;;
esac
