#!/bin/sh
# E-56: one `connect` (the owner's questions of 2026-11-19 and 2026-11-20). Runs both parts, each with its own run.sh:
#   positions/  what commit ids, hash chains and Merkle trees would cost (hash.mjs, tree.mjs, resume.mjs, textform.mjs)
#   probes/     the owner's one `connect` built on E-55's prototype (thenable, for await, (state, commit), lifetimes, types)
#   ./run.sh            both parts in full: each cleans its results/, runs, and writes results/tables.md
#   ./run.sh positions  only the positions part, in full
#   ./run.sh probes     only the probes part, in full
#   ./run.sh summary    both parts' tables from the results already there
# Env: SP (required: a scratch folder of your own that holds the lock helpers bin/timing, which runs a command alone
# on the box, and bin/heavy, which shares it and waits for timing runs). NODE (default node on PATH, Node
# 22.22.0; the probes take tsc 6.0.2 from PATH, or from NODE's folder when NODE is a path). RUNS (default "1 2 3"). NODEF (the node command with its
# flags; each part defaults to NODE with a 4,000 MB heap cap, so every process stays under 4 GB). DATA (data's folder
# for E-55's prototype; default ../data next to this repo, read only). Nothing is downloaded.
# The probes import E-55's proto/lens.mjs from ../E55-lens-prototype and never edit it; the positions benches import
# E-05's xxHash32 from ../E05-fold-cost.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
: "${SP:?set SP to a scratch folder (it holds bin/timing and bin/heavy)}"
export SP
part() { echo "== E-56 $1 =="; sh "$HERE/$1/run.sh" ${2:-}; }
case "$1" in
  positions) part positions ;;
  probes) part probes ;;
  summary) part positions summary; part probes summary ;;
  "") part positions; part probes; echo "== E-56: done; tables in positions/results/tables.md and probes/results/tables.md ==" ;;
  *) echo "usage: run.sh [positions|probes|summary]"; exit 1 ;;
esac
