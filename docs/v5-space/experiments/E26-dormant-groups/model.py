#!/usr/bin/env python3
"""E-26 (model): groups per log-tier process, and memory, for 1,000 sleeping projects of 1 to 20 resources.

A count, not a measurement. Inputs that are measured come from files:
  - a quiet group's memory per process: E-11 (../E11-many-groups/README.md, "Idle, quiet"): RSS growth per group
    at 10,000 groups, TS 16 KB (26 KB at 2,000), Go 6.5 KB, Rust 4.0 KB;
  - a dormant group's memory: this folder's lifecycle runs (results/lifecycle.jsonl): (RSS with 100,000 dormant
    groups - RSS with 100) / 99,900, median over runs and processes.
Projects: 1,000, resources per project uniform 1..20 (seeded), so about 10,500 resources. copies 3.
N options (SPACE §2): `proc` (a process per project: a sleeping project has no process at all), `tier` (a shared
log tier of k processes holds every project's groups), `pool` (a shared server pools tenants; the same count as tier).
Output: results/model.md.  Usage: python3 model.py
"""
import json, os, random, statistics

HERE = os.path.dirname(os.path.abspath(__file__))
rng = random.Random(26)
P = 1000
res = [rng.randint(1, 20) for _ in range(P)]
R = sum(res)

# KB per group in memory, by build (E-11, quiet groups, RSS growth per group at 10,000 groups; at 2,000 in brackets)
QUIET_KB = {'TS': 16.0, 'Go': 6.5, 'Rust': 4.0}


def dormant_bytes():
    p = os.path.join(HERE, 'results', 'lifecycle.jsonl')
    if not os.path.exists(p):
        return None
    rows = [json.loads(l) for l in open(p)]
    lo = [m['rss_kb'] for r in rows if r['S'] == 100 for m in r['mem']]
    hi = [m['rss_kb'] for r in rows if r['S'] == 100000 for m in r['mem']]
    if not lo or not hi:
        return None
    return (statistics.median(hi) - statistics.median(lo)) * 1024 / (100000 - 100)


# candidate -> (N option, groups per project as a function of its resource count r, note)
CANDS = [
    ('MIN, RUST, MIN-TS, LEAN, SRV, SIDE', 'proc', lambda r: r + 1, 'a group per resource + `#meta` per project (decision 17a)'),
    ('DRAFT', 'tier', lambda r: r + 1, 'a group per resource + `#meta` per project'),
    ('DRAFT with one shared metadata group (17b)', 'tier', lambda r: r, 'a group per resource; one `#meta` for the tier'),
    ('MIN-P', 'proc', lambda r: 1 + 1, 'one project group (small projects) + `#meta`'),
    ('MIN-P on a tier', 'tier', lambda r: 1 + 1, 'one project group + `#meta`'),
    ('CELL', 'tier', lambda r: 16 * r + 1, '16 cells per resource'),
    ('LANE', 'tier', lambda r: 64 + 1, '64 lanes per project'),
    ('SPLIT', 'tier', lambda r: r + 1, 'one range per resource at rest'),
    ('SLOG', 'tier', lambda r: r, 'a log group per resource; metadata in the controller'),
    ('RLOG', 'tier', lambda r: r + 1, 'groups run on log members'),
    ('EMB-V8', 'pool', lambda r: r + 1, 'a pooled server holds every tenant'),
    ('OBJ', 'tier', lambda r: 0, 'no group in memory: the log is the object store'),
]


def main():
    db = dormant_bytes()
    L = ['# E-26 (model): 1,000 sleeping projects (%d resources, 1-20 per project, seeded)' % R, '',
         'Quiet group memory from E-11 (RSS growth per group at 10,000 groups): TS %.0f KB, Go %.1f KB, Rust %.1f KB. '
         'Dormant group memory, measured here: %s.' % (QUIET_KB['TS'], QUIET_KB['Go'], QUIET_KB['Rust'],
                                                      ('%.0f B (results/lifecycle.jsonl)' % db) if db else 'not yet measured'), '',
         '| candidate | N | groups in all | groups per log-tier process, k = 3 | k = 6 | memory per process, quiet groups in memory (TS / Rust), k = 3 | with dormant groups, k = 3 | note |',
         '|---|---|---|---|---|---|---|---|']
    for name, n, gf, note in CANDS:
        G = sum(gf(r) for r in res) + (1 if '17b' in name else 0)
        if n == 'proc':
            L.append('| %s | proc | %s | 0 (a sleeping project has no process; its groups are on its own disk or in the object store) | 0 | 0 | 0 | %s |' % (name, '{:,}'.format(G), note))
            continue
        per3, per6 = G * 3 // 3, G * 3 // 6
        mq = '%.2f GB / %.2f GB' % (per3 * QUIET_KB['TS'] / 1e6, per3 * QUIET_KB['Rust'] / 1e6)
        md = ('%.3f GB' % (per3 * db / 1e9)) if db else '-'
        L.append('| %s | %s | %s | %s | %s | %s | %s | %s |' % (name, n, '{:,}'.format(G), '{:,}'.format(per3), '{:,}'.format(per6), mq, md, note))
    L += ['', 'The bar (Q-26): 1,000 projects in at most 2 GB per process. A `tier` or `pool` row over 2 GB with quiet groups in memory needs dormant groups (one mechanism) or decision 17b.']
    open(os.path.join(HERE, 'results', 'model.md'), 'w').write('\n'.join(L) + '\n')
    print('\n'.join(L))


main()
