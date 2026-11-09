#!/usr/bin/env python3
"""E-13: results/move.jsonl (slot-move window on the TS port) -> results/move-table.md (median and range of runs)."""
import json, os, statistics
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
rows = [json.loads(l) for l in open(R + '/move.jsonl')]
f = lambda xs: '%.2f (%.2f-%.2f)' % (statistics.median(xs), min(xs), max(xs))
L = ['| background writes/s | commits in the move | runs | moves per run | window p50, ms | p90 | p99 | max | write p99 on process 1, ms | load averages |', '|---|---|---|---|---|---|---|---|---|---|']
for rate in sorted({r['rate'] for r in rows}):
    for st in (1, 2, 3):
        rs = [r for r in rows if r['rate'] == rate and r['stages'] == st]
        if not rs: continue
        L.append('| %d | %d | %d | %d | %s | %s | %s | %s | %s | %s |' % (rate, st, len(rs), statistics.median([r['moves_done'] for r in rs]),
                 f([r['move_p50'] for r in rs]), f([r['move_p90'] for r in rs]), f([r['move_p99'] for r in rs]), f([r['move_max'] for r in rs]),
                 f([r['write_p99'][0] for r in rs]) if rate else '-', '; '.join(r['loadavg'].split()[0] for r in rs)))
open(R + '/move-table.md', 'w').write('\n'.join(L) + '\n'); print('\n'.join(L))
