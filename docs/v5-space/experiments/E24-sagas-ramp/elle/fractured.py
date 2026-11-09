#!/usr/bin/env python3
"""fractured.py: a direct count of fractured reads in sim.py's histories (a cross-check
of Elle's G-single on many more histories than Elle is run on): a read transaction is
fractured if it sees a unit's append on one key and misses it on another key the unit
wrote that the same transaction read.   python3 fractured.py DIR"""
import glob
import re
import sys
from collections import defaultdict

tot = defaultdict(lambda: [0, 0, 0])
for f in sorted(glob.glob(sys.argv[1] + '/*.edn')):
    tag = f.rsplit('/', 1)[1].rsplit('-', 1)[0]
    ops = [l for l in open(f) if l.startswith('{')]
    units = {}
    for l in ops:
        if ':type :ok' in l and ':append' in l:
            u = int(re.search(r':append \d+ (\d+)', l).group(1))
            units[u] = [int(k) for k in re.findall(r':append (\d+) \d+', l)]
    hb = False
    for l in ops:
        if ':type :ok' in l and ':r ' in l:
            tot[tag][1] += 1
            reads = {int(k): [int(x) for x in v.split()] for k, v in re.findall(r'\[:r (\d+) \[([\d ]*)\]\]', l)}
            if any(T not in reads[b] for a, lst in reads.items() for T in lst for b in units.get(T, []) if b in reads):
                tot[tag][2] += 1
                hb = True
    tot[tag][0] += hb
for tag, (h, n, b) in sorted(tot.items()):
    print(f'{tag}: {n} read transactions, {b} fractured, in {h} histories')
