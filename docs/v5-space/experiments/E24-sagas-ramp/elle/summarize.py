#!/usr/bin/env python3
"""summarize.py: a Markdown table of real Elle's verdicts (check.clj's JSON lines),
one row per (mode, fail rate): histories, read-committed valid, serializable
valid, and the anomaly types with (histories with it: total cases)."""
import json
import sys
from collections import defaultdict

rows = defaultdict(lambda: {'n': 0, 'rc': 0, 'sr': 0, 'an': defaultdict(lambda: [0, 0]), 'err': 0})
for line in open(sys.argv[1]):
    o = json.loads(line)
    key = o['file'].rsplit('-', 1)[0]
    r = rows[key]
    r['n'] += 1
    if 'error' in o:
        r['err'] += 1
        continue
    r['rc'] += o['rc']['valid'] is True
    r['sr'] += o['sr']['valid'] is True
    seen = {}
    for part in ('rc', 'sr'):
        for k, v in o[part]['counts'].items():
            seen[k] = max(seen.get(k, 0), v)
    for k, v in seen.items():
        r['an'][k][0] += 1
        r['an'][k][1] += v
print('| histories | n | read committed valid | serializable valid | anomalies (histories with it: total cases) | errors |')
print('|---|---|---|---|---|---|')
for key in sorted(rows):
    r = rows[key]
    an = ', '.join(f'{k} {h}: {c}' for k, (h, c) in sorted(r['an'].items())) or 'none'
    print(f"| {key} | {r['n']} | {r['rc']} | {r['sr']} | {an} | {r['err']} |")
