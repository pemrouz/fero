#!/usr/bin/env python3
"""E-28: results/runs.jsonl -> results/tables.md (median and range over runs, per layout, mode, size, writers)."""
import json, os, statistics
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
rows = [json.loads(l) for l in open(R + '/runs.jsonl')]
f = lambda xs: '%.2f (%.2f-%.2f)' % (statistics.median(xs), min(xs), max(xs))
keys = []
for r in rows:
    k = (r['layout'], r['res']['mode'], r['res']['size'], r['res']['conc'])
    if k not in keys: keys.append(k)
L = ['| drives | mode | object size | writers | runs | PUTs/s | p50, ms | p90, ms | p99, ms | p99.9, ms | errors | load averages |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
for k in keys:
    rs = [r for r in rows if (r['layout'], r['res']['mode'], r['res']['size'], r['res']['conc']) == k]
    x = [r['res'] for r in rs]
    L.append('| %s | %s | %s | %d | %d | %s | %s | %s | %s | %s | %d | %s |' % (k[0], k[1], ('%d KB' % (k[2] // 1024)) if k[2] < 1 << 20 else '1 MB', k[3], len(rs),
             f([y['ops_s'] for y in x]), f([y['p50_us'] / 1e3 for y in x]), f([y['p90_us'] / 1e3 for y in x]), f([y['p99_us'] / 1e3 for y in x]), f([y['p999_us'] / 1e3 for y in x]),
             sum(sum(y['errors'].values()) for y in x), '; '.join(r['loadavg'].split()[0] for r in rs)))
open(R + '/tables.md', 'w').write('\n'.join(L) + '\n'); print('\n'.join(L))
