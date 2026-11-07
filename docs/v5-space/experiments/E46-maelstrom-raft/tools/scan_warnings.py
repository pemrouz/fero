"""List every WARN or ERROR line in each E-46 run's Maelstrom log, grouped by kind.

Clojure's start-up warnings about `abs` are left out (they come from the jar's
libraries, not the test). Each kind is printed with its count and one example.
Usage: scan_warnings.py <runs dir>
"""
import os
import re
import sys
from collections import Counter

runs = sys.argv[1]
total = Counter()
for name in sorted(os.listdir(runs)):
    path = os.path.join(runs, name, 'maelstrom.out')
    if not os.path.exists(path):
        continue
    lines = open(path, encoding='utf-8', errors='replace').read().splitlines()
    kinds = Counter()
    example = {}
    for i, line in enumerate(lines):
        if not re.match(r'^(WARN|ERROR)', line) or 'abs already refers' in line or 'PMathsFunctions' in line:
            continue
        nxt = lines[i + 1] if i + 1 < len(lines) else ''
        if 'Invalid dest for message' in nxt:
            m = re.search(r':dest "(c\d+)"', nxt)
            kind = 'reply to a client Maelstrom already closed (Invalid dest)'
            example.setdefault(kind, nxt[:240])
        else:
            kind = re.sub(r'^\S+ \[[^\]]+\] ', '', line)[:120]
            example.setdefault(kind, (line + ' | ' + nxt)[:240])
        kinds[kind] += 1
    for k, c in kinds.items():
        total[k] += c
    print(f'{name}: ' + ('none' if not kinds else '; '.join(f'{c} x {k}' for k, c in kinds.items())))
    for k in kinds:
        print(f'    e.g. {example[k]}')
print()
print('All runs: ' + ('none' if not total else '; '.join(f'{c} x {k}' for k, c in total.items())))
