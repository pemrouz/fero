#!/usr/bin/env python3
"""E-26 / E-36: results/lifecycle.jsonl -> results/lifecycle.md (median and range over runs, per scale S)."""
import json, os, statistics
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
rows = [json.loads(l) for l in open(R + '/lifecycle.jsonl')]
f = lambda xs, fmt='%.2f': (fmt + ' (' + fmt + '-' + fmt + ')') % (statistics.median(xs), min(xs), max(xs))
L = ['| dormant groups per process (S) | runs | meta commit p50, ms | new group first write p50, ms | MIN create (meta + group) p50, ms | max of 20, ms | wake one group p50, ms | p90 | max | wake 20 groups, ms | cold boot of 3 processes + 20 groups, ms | RSS per process, MB | idle Raft messages/s per process | idle frames/s per process | load averages |',
     '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|']
for S in sorted({r['S'] for r in rows}):
    rs = [r for r in rows if r['S'] == S]
    L.append('| %s | %d | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |' % ('{:,}'.format(S), len(rs), f([r['meta_ms']['p50'] for r in rs]), f([r['create_group_ms']['p50'] for r in rs]),
             f([r['create_min_ms']['p50'] for r in rs]), f([r['create_min_ms']['max'] for r in rs]), f([r['wake1_ms']['p50'] for r in rs]), f([r['wake1_ms']['p90'] for r in rs]), f([r['wake1_ms']['max'] for r in rs]),
             f([x for r in rs for x in r['wake20_ms']], '%.1f'), f([b['spawn_to_ok_ms'] for r in rs for b in r['boot']], '%.0f'), f([m['rss_kb'] / 1024 for r in rs for m in r['mem']], '%.1f'),
             f([x['msgs_s'] for r in rs for x in r['idle']]), f([x['frames_s'] for r in rs for x in r['idle']]), '; '.join(r['loadavg'].split()[0] for r in rs)))
lo = [m['rss_kb'] for r in rows if r['S'] == 100 for m in r['mem']]; hi = [m['rss_kb'] for r in rows if r['S'] == 100000 for m in r['mem']]
if lo and hi:
    L += ['', 'Memory per dormant group: (median RSS at S = 100,000 - median RSS at S = 100) / 99,900 = %.0f B.' % ((statistics.median(hi) - statistics.median(lo)) * 1024 / 99900)]
open(R + '/lifecycle.md', 'w').write('\n'.join(L) + '\n'); print('\n'.join(L))
