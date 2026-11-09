#!/usr/bin/env python3
"""elle_report.py: compare real Elle's verdicts with the model's own checks.

    python3 elle_report.py INDEX.jsonl ELLE.jsonl > results/elle.md
"""
import json
import sys
from collections import defaultdict

idx = {}
for line in open(sys.argv[1]):
    r = json.loads(line)
    idx[r['file']] = r
ell = {}
for line in open(sys.argv[2]):
    r = json.loads(line)
    ell[r['file']] = r

rows = defaultdict(lambda: defaultdict(int))
errors = []
for f, r in idx.items():
    e = ell.get(f)
    key = (r['option'], r['bound'])
    row = rows[key]
    row['histories'] += 1
    model_dup = 'ONCE' in r['model']
    row['model ONCE broken'] += model_dup
    row['model LOST broken'] += 'LOST' in r['model']
    row['walk reached B = f(A)'] += bool(r['done'])
    if e is None or 'error' in e:
        errors.append((f, e))
        row['elle error'] += 1
        continue
    dup = 'duplicate-elements' in e['rc']['types']
    row['Elle :duplicate-elements'] += dup
    row['Elle invalid (rc)'] += e['rc']['valid'] is not True
    row['agree'] += dup == model_dup
    for t in e['rc']['types']:
        row['type ' + t] += 1

cols = ['histories', 'model ONCE broken', 'Elle :duplicate-elements', 'agree', 'Elle invalid (rc)',
        'model LOST broken', 'walk reached B = f(A)', 'elle error']
print('# E-30: real Elle 0.2.8 on the derived outputs\n')
print('Each history is one seeded random walk of `models/derived.py` (faults for 40 steps, then calm steps), '
      'written by `elle_hist.py` as list-append operations (one append per output, one final read of each B row). '
      '`agree` counts histories where Elle reports `:duplicate-elements` exactly when the model\'s ONCE check is '
      'broken. Lost outputs are the model\'s LOST check; list-append has no check for an acknowledged append that '
      'no read shows, so Elle is not asked about them.\n')
print('| option | bound | ' + ' | '.join(cols) + ' |')
print('|---|---|' + '---|' * len(cols))
for (o, b) in sorted(rows):
    row = rows[(o, b)]
    print(f'| {o} | {b} | ' + ' | '.join(str(row[c]) for c in cols) + ' |')
other = sorted({c for r in rows.values() for c in r if c.startswith('type ')})
if other:
    print('\nAnomaly types Elle reported (histories, all options): ' +
          ', '.join(f'`{c[5:]}` {sum(r[c] for r in rows.values())}' for c in other) + '.')
if errors:
    print(f'\n{len(errors)} histories Elle could not check; first: {errors[0]}')
