#!/bin/bash
# Evidence for planted bug 2 (E46_READ=leaderlocal): for every such run in $1 (the runs dir), the reads a
# deposed leader answered (journal_deposed.clj), the Porcupine verdict per key, and any read no
# linearization can explain (stale_witness.py), plus how Maelstrom's own Knossos check ended.
# Usage: bug2_evidence.sh <runs dir> > results/planted-bug-2.txt   (needs $SP/e46/porcheck: see run.sh)
set -uo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
JAR="${MAELSTROM_JAR:-$SP/dl/maelstrom/maelstrom/lib/maelstrom.jar}"
for d in "$1"/*/; do
  r=$(basename "$d")
  s="$d/store/lin-kv/latest"
  grep -q 'read=leaderlocal' "$s/node-logs/n0.log" 2>/dev/null || continue
  echo "=== $r"
  if [ -f "$s/results.edn" ]; then
    echo "Knossos (in Maelstrom): $(grep -oE ':failures \[[^]]*\]' "$s/results.edn" | tail -1 || echo ':failures []') ; Maelstrom: $(grep -oE 'Everything looks good!|Analysis invalid!' "$d/maelstrom.out" | tail -1)"
  else
    echo "Knossos (in Maelstrom): did not finish; last search report: $(grep 'knossos.search' "$d/maelstrom.out" | tail -1 | cut -c1-220)"
  fi
  java -cp "$JAR" clojure.main "$HERE/journal_deposed.clj" "$s/net-journal" 2>/dev/null | grep -E 'DIFFERS|^summary'
  python3 -I "$HERE/porcupine/hist2json.py" "$s/history.edn" > "$SP/e46/por/$r.jsonl"
  echo "Porcupine: $("$SP/e46/porcheck" "$SP/e46/por/$r.jsonl" 60 | grep -E 'ILLEGAL|unknown \(|^summary' | tr '\n' ' ')"
  python3 -I "$HERE/stale_witness.py" "$s/history.edn"
done
