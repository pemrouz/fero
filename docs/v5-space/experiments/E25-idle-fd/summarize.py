#!/usr/bin/env python3
"""E-25: results/runs.jsonl -> results/tables.md (parts b and c; median and range over runs)."""
import json, os, statistics
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
rows = [json.loads(l) for l in open(R + '/runs.jsonl')]
f = lambda xs, fmt='%.2f': (fmt + ' (' + fmt + '-' + fmt + ')') % (statistics.median(xs), min(xs), max(xs))
L = ['## (b) one process, 99 links pinged every 500 ms', '', '| build | quiet groups held | runs | CPU, % of one core | frames out/s | frames in/s | suspects | RSS, MB | load averages |', '|---|---|---|---|---|---|---|---|---|']
for impl in ('node', 'rust'):
    for g in (0, 2000):
        rs = [r for r in rows if r['part'] == 'b' and r['impl'] == impl and r['groups'] == g]
        if not rs: continue
        L.append('| %s | %d | %d | %s | %s | %s | %d | %s | %s |' % (impl, g, len(rs), f([100 * r['cores'] for r in rs], '%.3f'), f([r['frames_out_s'] for r in rs], '%.0f'),
                 f([r['frames_in_s'] for r in rs], '%.0f'), sum(r['suspects'] for r in rs), f([r['rss_kb'] / 1024 for r in rs], '%.1f'), '; '.join(r['loadavg'].split()[0] for r in rs)))
L += ['', '## (c) 100 Node processes on this box', '', '| mode | runs | total CPU, cores | per process, % of a core (median) | max process, % | total RSS, GB | RSS per process, MB | frames/s expected in all | load averages before; at the end |', '|---|---|---|---|---|---|---|---|---|']
for mode in ('bare', 'mesh'):
    rs = [r for r in rows if r['part'] == 'c' and r['mode'] == mode]
    if not rs: continue
    L.append('| %s | %d | %s | %s | %s | %s | %s | %d | %s |' % (mode, len(rs), f([r['cores_total'] for r in rs], '%.3f'), f([100 * r['cores_per_process_median'] for r in rs], '%.3f'),
             f([100 * r['cores_per_process_max'] for r in rs], '%.2f'), f([r['rss_total_mb'] / 1024 for r in rs], '%.2f'), f([r['rss_per_process_mb'] for r in rs], '%.1f'),
             rs[0]['frames_s_total_expected'], '; '.join(r['loadavg_before'].split()[0] + ', ' + r['loadavg_end'].split()[0] for r in rs)))
open(R + '/tables.md', 'w').write('\n'.join(L) + '\n'); print('\n'.join(L))
