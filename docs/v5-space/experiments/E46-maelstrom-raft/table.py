"""Turn E-46's summary.jsonl into a markdown table (one row per run) plus totals."""
import json
import os
import re
import sys
from collections import Counter


def reasons(store):
    """Count completions by reason from the run's history.edn (kept in the store)."""
    c = Counter()
    path = os.path.join(store, 'history.edn')
    if not os.path.exists(path):
        return None
    for line in open(path, encoding='utf-8', errors='replace'):
        if ':process :nemesis' in line or ':type :invoke' in line:
            continue
        t = re.search(r':type :(\w+)', line)
        if not t:
            continue
        t = t.group(1)
        e = re.search(r':error \[?:([\w-]+)', line)
        if t == 'ok':
            c['ok'] += 1
        elif t == 'info':
            c['unknown'] += 1
        elif e and e.group(1) in ('precondition-failed', 'key-does-not-exist'):
            c['refused'] += 1
        elif e and e.group(1) == 'temporarily-unavailable':
            c['noleader'] += 1
        elif e and e.group(1) == 'net-timeout':
            c['timeout'] += 1
        else:
            c['other'] += 1
    return c

rows = [json.loads(line) for line in open(sys.argv[1]) if line.strip()]
# Keep the last line per run name (a re-run replaces an earlier one).
by = {}
for r in rows:
    by[r['name']] = r
rows = list(by.values())

print('| Run | Nodes | Reads | Seed | s | Partitions | Pauses (s) | Elections | ok | cas/read refused (20, 22) | no leader (11) | read timed out | unknown (info) | Reads ok | Knossos | Maelstrom | Hash points (bad) | Snaps sent / applied | Node errors |')
print('|---|---:|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---|---|---|---|---:|')
tot = dict(runs=0, ok=0, fail=0, info=0, el=0, part=0, pauses=0)
rtot = Counter()
for r in rows:
    o = r['ops']
    ok = sum(v for k, v in o.items() if k.endswith('_ok'))
    fail = sum(v for k, v in o.items() if k.endswith('_fail'))
    info = sum(v for k, v in o.items() if k.endswith('_info'))
    lin = {'true': 'valid', 'false': '**INVALID**'}.get(r['lin_valid'], str(r['lin_valid']))
    rc = reasons(r['store']) or Counter()
    print(f"| {r['name']} | {r['nodes']} | {r['read']} | {r['seed']} | {r['secs']} | {r['partitions']} | "
          f"{r['pauses']} ({r['paused_ms'] / 1000:.1f}) | {r['elections']} | {ok} | {rc['refused']} | {rc['noleader']} | "
          f"{rc['timeout']} | {info}{' +' + str(rc['other']) + ' other' if rc['other'] else ''} | "
          f"{o.get('read_ok', 0)} | {lin}{' (' + str(r['bad_keys']) + ' keys)' if r['bad_keys'] else ''} | {r['verdict']} | "
          f"{r['hash_points_compared']} ({r['hash_mismatches']}) | {r['snap_sent']} / {r['snap_applied']} | {r['node_errors']} |")
    tot['runs'] += 1
    rtot.update(rc)
    tot['ok'] += ok
    tot['fail'] += fail
    tot['info'] += info
    tot['el'] += r['elections']
    tot['part'] += r['partitions']
    tot['pauses'] += r['pauses']
print()
print(f"Totals: {tot['runs']} runs, {tot['ok']} ok / {tot['fail']} fail / {tot['info']} info operations, "
      f"{tot['el']} elections, {tot['part']} partitions, {tot['pauses']} pauses. "
      f"Failures by reason: {rtot['refused']} cas/read refused by the store, {rtot['noleader']} no leader, "
      f"{rtot['timeout']} reads timed out, {rtot['other']} other.")
