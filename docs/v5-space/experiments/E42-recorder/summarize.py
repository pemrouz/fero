#!/usr/bin/env python3
"""E-42: results/runs.jsonl and results/verify.jsonl -> results/tables.md."""
import json, os, statistics
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
rows = [json.loads(l) for l in open(R + '/runs.jsonl')]
f = lambda xs, fmt='%.2f': (fmt + ' (' + fmt + '-' + fmt + ')') % (statistics.median(xs), min(xs), max(xs))
L = ['| recorder | runs | committed/s | p99, ms | leader µs/append | follower µs/append | leader cores | follower cores | recorder MB/s, leader / follower | journal MB/s, leader / follower | recorder / journal bytes, leader / follower | load averages |', '|---|---|---|---|---|---|---|---|---|---|---|---|']
for rec in ('off', 'ref', 'full'):
    rs = [r for r in rows if r['rec'] == rec]
    if not rs: continue
    sec = 11.0   # recorder and journal bytes cover the whole run: 2 s warm-up + 8 s window + 1 s drain
    fol = lambda r, k: (r[k]['f1'] + r[k]['f2']) / 2
    L.append('| %s | %d | %s | %s | %s | %s | %s | %s | %s / %s | %s / %s | %s / %s | %s |' % (rec, len(rs), f([r['tput'] for r in rs], '%.0f'), f([r['p99'] for r in rs]),
             f([r['cpu_us_per_append']['leader'] for r in rs]), f([fol(r, 'cpu_us_per_append') for r in rs]), f([r['cores']['leader'] for r in rs], '%.3f'), f([fol(r, 'cores') for r in rs], '%.3f'),
             f([r['rec_bytes']['leader'] / 1e6 / sec for r in rs]), f([fol(r, 'rec_bytes') / 1e6 / sec for r in rs]),
             f([r['journal_bytes']['leader'] / 1e6 / sec for r in rs]), f([fol(r, 'journal_bytes') / 1e6 / sec for r in rs]),
             f([r['rec_bytes']['leader'] / r['journal_bytes']['leader'] for r in rs], '%.3f'), f([fol(r, 'rec_bytes') / fol(r, 'journal_bytes') for r in rs], '%.3f'),
             '; '.join(r['loadavg'].split()[0] for r in rs)))
if os.path.exists(R + '/verify.jsonl'):
    V = [json.loads(l) for l in open(R + '/verify.jsonl')]
    L += ['', '| recorder | runs | replays byte-identical (3 processes per run) | events per process (leader, f1, f2), first run | planted reorderings that changed the effects, of 10 per process (leader, f1, f2) |', '|---|---|---|---|---|']
    for rec in ('ref', 'full'):
        vs = [v for v in V if v['rec'] == rec]
        if not vs: continue
        L.append('| %s | %d | %d of %d | %s | %s |' % (rec, len(vs), sum(3 if v['identical'] else 0 for v in vs), 3 * len(vs), vs[0]['events'],
                 '; '.join(str([v['planted_faults_changed_effects_of_10'][k] for k in ('0', '1', '2')]) for v in vs)))
open(R + '/tables.md', 'w').write('\n'.join(L) + '\n'); print('\n'.join(L))
