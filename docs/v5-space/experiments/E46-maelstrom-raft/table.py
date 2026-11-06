"""Turn E-46's summary.jsonl into a markdown table (one row per run) plus totals."""
import json
import sys

rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
# Keep the last line per run name (a re-run replaces an earlier one).
by = {}
for r in rows:
    by[r['name']] = r
rows = list(by.values())

print('| Run | Nodes | Reads | Seed | s | Partitions | Pauses (s) | Elections | Max term | ok / fail / info | Reads ok | Knossos (lin) | Maelstrom | Hash points (bad) | Snaps sent / applied | Node errors |')
print('|---|---:|---|---:|---:|---:|---|---:|---:|---|---:|---|---|---|---|---:|')
tot = dict(runs=0, ok=0, fail=0, info=0, el=0, part=0, pauses=0)
for r in rows:
    o = r['ops']
    ok = sum(v for k, v in o.items() if k.endswith('_ok'))
    fail = sum(v for k, v in o.items() if k.endswith('_fail'))
    info = sum(v for k, v in o.items() if k.endswith('_info'))
    lin = {'true': 'valid', 'false': '**INVALID**'}.get(r['lin_valid'], str(r['lin_valid']))
    print(f"| {r['name']} | {r['nodes']} | {r['read']} | {r['seed']} | {r['secs']} | {r['partitions']} | "
          f"{r['pauses']} ({r['paused_ms'] / 1000:.1f}) | {r['elections']} | {r['max_term']} | {ok} / {fail} / {info} | "
          f"{o.get('read_ok', 0)} | {lin}{' (' + str(r['bad_keys']) + ' keys)' if r['bad_keys'] else ''} | {r['verdict']} | "
          f"{r['hash_points_compared']} ({r['hash_mismatches']}) | {r['snap_sent']} / {r['snap_applied']} | {r['node_errors']} |")
    tot['runs'] += 1
    tot['ok'] += ok
    tot['fail'] += fail
    tot['info'] += info
    tot['el'] += r['elections']
    tot['part'] += r['partitions']
    tot['pauses'] += r['pauses']
print()
print(f"Totals: {tot['runs']} runs, {tot['ok']} ok / {tot['fail']} fail / {tot['info']} info operations, "
      f"{tot['el']} elections, {tot['part']} partitions, {tot['pauses']} pauses.")
