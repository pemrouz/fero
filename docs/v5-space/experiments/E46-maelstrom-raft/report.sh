#!/bin/bash
# E-46: turn the runs in $E46_RUNS into results/. run.sh calls it after the batches; it can also run alone.
# Needs Go (with porcupine v1.3.1 in the module cache, or network) and a JDK; runs no Maelstrom test.
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
SP="${SP:-/tmp/claude-0/-home-user-fero/bac5b7a6-c95f-59b1-b9a5-8d26a3a427c5/scratchpad}"
RUNS="${E46_RUNS:-$SP/e46/runs}"
JAR="${MAELSTROM_JAR:-$SP/dl/maelstrom/maelstrom/lib/maelstrom.jar}"
R="$HERE/results"
mkdir -p "$R/anomalies" "$SP/e46/por"
hist() { echo "$RUNS/$1/store/lin-kv/latest/history.edn"; }

# Second checker: Porcupine on every run's history, key by key.
(cd "$HERE/tools/porcupine" && go build -o "$SP/e46/porcheck" .)
for d in "$RUNS"/*/; do
  r=$(basename "$d"); [ -f "$(hist "$r")" ] || continue
  python3 -I "$HERE/tools/porcupine/hist2json.py" "$(hist "$r")" > "$SP/e46/por/$r.jsonl"
  echo "$r: $("$SP/e46/porcheck" "$SP/e46/por/$r.jsonl" 60 | tail -1)"
done > "$R/porcupine.txt"

# The table, the per-run summaries, trimmed copies, and every WARN/ERROR in Maelstrom's logs.
python3 -I "$HERE/table.py" "$RUNS/summary.jsonl" "$R/porcupine.txt" > "$R/runs.md"
cp "$RUNS/summary.jsonl" "$R/summary.jsonl"
python3 -I "$HERE/trim.py" "$RUNS" "$R/runs"
python3 -I "$HERE/tools/scan_warnings.py" "$RUNS" > "$R/warnings.txt"

# Planted bug 1: the reads Knossos rejected.
{
  echo "# Planted bug 1 (batch D, E46_READ=buggy): for each key Knossos rejected, the op it could not place and the last ok op it could."
  echo "# Made by tools/lin_failures.py from each run's results.edn. Times are completion times, in s since the test start."
  for d in "$RUNS"/bug*/; do
    r=$(basename "$d"); python3 -I "$HERE/tools/lin_failures.py" "$r" "$RUNS/$r/store/lin-kv/latest/results.edn"
  done
} > "$R/planted-bug-failures.txt"

# Planted bug 2: deposed leaders, Porcupine, and hand-checkable stale reads.
{
  echo "# Planted bug 2 (leaderlocal): a node that believes it leads answers reads from its own state."
  echo "# Made by tools/bug2_evidence.sh. A run with no results.edn is one whose Knossos search was stopped by hand:"
  echo "# here stale5-s2, stopped at 2026-11-07T01:11:04Z after 20 min 40 s (18 min of it searching key 9) to free the shared lock."
  "$HERE/tools/bug2_evidence.sh" "$RUNS"
} > "$R/planted-bug-2.txt"

# Anomaly 3: which keys and client threads got reads (one run per concurrency setting and node count).
{
  echo "# Anomaly 3: with --concurrency 4n, Maelstrom's lin-kv reads only in the keys of the first thread group."
  echo "# Made by tools/keys_by_group.py from each run's history.edn. 'thread group' = thread // 2n; reads come only from threads 0..n-1."
  echo "# Source (in the Maelstrom 0.2.4 jar): jepsen/tests/linearizable_register.clj (concurrent-generator (* 2 n) ... (gen/reserve n r ...)),"
  echo "# jepsen/generator.clj reserve (absolute thread ranges, with its own TODO about nested reserves), jepsen/generator/interpreter.clj:89 (node = thread mod n)."
  for x in c3-ri-s1:3:12 c5-ri-s1:5:20 r3-mix-s4:3:6 r5-mix-s4:5:10; do
    IFS=: read -r r n c <<< "$x"; [ -f "$(hist "$r")" ] && python3 -I "$HERE/tools/keys_by_group.py" "$r" "$(hist "$r")" "$n" "$c"
  done
  echo
  echo "# The jar's reserve:"
  unzip -p "$JAR" jepsen/generator.clj | sed -n 1176,1190p
  echo "# The jar's linearizable-register generator:"
  unzip -p "$JAR" jepsen/tests/linearizable_register.clj | sed -n 39,45p
} > "$R/anomalies/reads-by-thread.txt"

# Anomaly 2: every snapshot in the compaction runs.
for d in "$RUNS"/k*/; do
  r=$(basename "$d"); j="$RUNS/$r/store/lin-kv/latest/net-journal"
  java -cp "$JAR" clojure.main "$HERE/tools/journal_snaps.clj" "$j" 2>/dev/null | grep -- '->' > "$R/anomalies/snapshots-$r.txt"
  java -cp "$JAR" clojure.main "$HERE/tools/journal_snapcheck.clj" "$j" 2>/dev/null | grep -- '->' > "$R/anomalies/snapcheck-$r.txt"
done
for d in "$RUNS"/k*/; do
  r=$(basename "$d")
  python3 -I "$HERE/tools/snap_audit.py" "$r" "$RUNS/$r/store/lin-kv/latest/node-logs" "$R/anomalies/snapshots-$r.txt" "$R/anomalies/snapcheck-$r.txt"
done > "$SP/e46/snap-audit-now.txt"
echo "snapshot audit (compare with results/anomalies/snapshot-audit.txt, which adds the traced examples):"
cat "$SP/e46/snap-audit-now.txt"
