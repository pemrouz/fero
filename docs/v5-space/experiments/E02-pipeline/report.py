#!/usr/bin/env python3
"""E-02: the README's focused tables (median of runs, range in brackets) from results/runs.jsonl.
Usage: report.py <results dir> > results/report.md"""
import json, os, statistics, sys

R = sys.argv[1]
rows = [json.loads(l) for l in open(os.path.join(R, 'runs.jsonl')) if l.strip()]
ok = [r for r in rows if r.get('ok')]
ORDER = {'ts': 0, 'ts-w1': 1, 'ts-w2': 2, 'ts-w4': 3, 'rust': 4, 'go': 5}
RATE = lambda r: {'max': 0, 'half': 3}.get(r, 1 if r == '10000' else 2)

def med(xs):
    xs = [x for x in xs if x is not None]
    return (statistics.median(xs), min(xs), max(xs)) if xs else None

def f(t, d=1, rng=True):
    if t is None:
        return '-'
    m, lo, hi = t
    if m >= 1000:
        s = f'{m:,.0f}'; r = f' ({lo:,.0f}-{hi:,.0f})'
    else:
        s = f'{m:.{d}f}'; r = f' ({lo:.{d}f}-{hi:.{d}f})'
    return s + (r if rng else '')

def sel(**k):
    return [r for r in ok if all(r[a] == b for a, b in k.items())]

def table(title, groups, key_cols):
    print(f'\n#### {title}\n')
    print('| ' + ' | '.join(key_cols) + ' | runs | committed/s | p50 ms | p99 ms | p99.9 ms | CPU µs/append: leader / f1 / f2 | leader cores | records per flush |')
    print('|' + '---|' * (len(key_cols) + 8))
    for keyvals, rs in groups:
        if not rs:
            continue
        rate = rs[0]['rate_label']
        cpu = [med([r['cpu_us_per_append'][w] for r in rs]) for w in ('leader', 'f1', 'f2')]
        cpus = ' / '.join(f(c, 2, False) for c in cpu)
        print('| ' + ' | '.join(str(v) for v in keyvals) + f" | {len(rs)} | {f(med([r['tput'] for r in rs]))} | "
              f"{f(med([r['lat_ms']['p50'] for r in rs]), 2)} | {f(med([r['lat_ms']['p99'] for r in rs]), 2)} | "
              f"{f(med([r['lat_ms']['p999'] for r in rs]), 1, False)} | {cpus} | {f(med([r['cores_used']['leader'] for r in rs]), 2, False)} | "
              f"{f(med([r['recs_per_flush'] for r in rs]), 0, False)} |")

def ratelabel(rs):
    l = rs[0]['rate_label']
    if l == 'half':
        return f"half = {int(statistics.median([r['rate'] for r in rs])):,}"
    return 'max' if l == 'max' else f'{int(l):,}'

def by(rs, keys):
    out = {}
    for r in rs:
        out.setdefault(tuple(r[k] for k in keys), []).append(r)
    return out

# 1. core: real disk, persisted, growing files, one group
for size in (100, 1024):
    rs = sel(store='grow', mode='persisted', groups=1, size=size)
    g = by(rs, ('rate_label', 'impl'))
    keys = sorted(g, key=lambda k: (RATE(k[0]), ORDER.get(k[1], 9)))
    table(f'Real disk, persisted, 1 group, {size} B records', [((ratelabel(g[k]), k[1]), g[k]) for k in keys], ['rate', 'build'])

# 2. emu: tmpfs with sampled fsync delays, one group and 16 groups
for groups in (1, 16):
    rs = sel(store='emu', mode='persisted', groups=groups, size=100)
    g = by(rs, ('rate_label', 'impl'))
    keys = sorted(g, key=lambda k: (RATE(k[0]), ORDER.get(k[1], 9)))
    table(f'tmpfs with sampled fsync delays (independent disks emulated), persisted, {groups} group(s), 100 B', [((ratelabel(g[k]), k[1]), g[k]) for k in keys], ['rate', 'build'])

# 3. kwN on the real disk, 16 groups
rs = sel(store='grow', mode='persisted', groups=16, size=100)
rs = [r for r in rs if r['impl'].startswith('ts-w')]
g = by(rs, ('rate_label', 'impl'))
keys = sorted(g, key=lambda k: (RATE(k[0]), ORDER.get(k[1], 9)))
table('Real disk, several TS kernel workers (kwN), 16 groups, 100 B', [((ratelabel(g[k]), k[1]), g[k]) for k in keys], ['rate', 'build'])

# 3b. kwN inside one process: the leader alone (`ldr`) on tmpfs with sampled fsync delays, 16 groups
rs = [r for r in sel(store='emu', mode='ldr', groups=16, size=100)]
g = by(rs, ('rate_label', 'impl'))
keys = sorted(g, key=lambda k: (RATE(k[0]), ORDER.get(k[1], 9)))
table('One process, several TS kernel workers: the leader alone (`ldr`), tmpfs with sampled fsync delays, 16 groups, 100 B', [((ratelabel(g[k]), k[1]), g[k]) for k in keys], ['rate', 'build'])

# 4. groups: 1, 16, 1,000 sharing one journal and one link per peer
rs = [r for r in sel(store='grow', mode='persisted', size=100) if r['impl'] in ('ts', 'rust', 'go') and r['rate_label'] in ('max', '50000')]
g = by(rs, ('rate_label', 'groups', 'impl'))
keys = sorted(g, key=lambda k: (RATE(k[0]), ORDER.get(k[2], 9), k[1]))
table('Groups sharing one journal and one link per peer (real disk, 100 B)', [((ratelabel(g[k]), k[2], k[1]), g[k]) for k in keys], ['rate', 'build', 'groups'])

# 5. rungs
rs = [r for r in sel(store='grow', groups=1, size=100) if r['impl'] in ('ts', 'rust', 'go') and r['rate_label'] in ('max', '50000')]
g = by(rs, ('rate_label', 'mode', 'impl'))
MO = {'persisted': 0, 'memory': 1, 'ldr': 2, 'none': 3}
keys = sorted(g, key=lambda k: (RATE(k[0]), ORDER.get(k[2], 9), MO.get(k[1], 9)))
table('Rungs (real disk, 1 group, 100 B)', [((ratelabel(g[k]), k[2], k[1]), g[k]) for k in keys], ['rate', 'build', 'rung'])

# 6. storage layout
rs = [r for r in sel(mode='persisted', groups=1, size=100) if r['store'] in ('grow', 'falloc', 'zero') and r['impl'] in ('ts', 'rust', 'go') and r['rate_label'] in ('max', 'half')]
g = by(rs, ('rate_label', 'store', 'impl'))
ST = {'grow': 0, 'falloc': 1, 'zero': 2}
keys = sorted(g, key=lambda k: (RATE(k[0]), ORDER.get(k[2], 9), ST.get(k[1], 9)))
table('Growing files against preallocated segments (real disk, 1 group, 100 B)', [((ratelabel(g[k]), k[2], k[1]), g[k]) for k in keys], ['rate', 'build', 'layout'])

# 7. fixed + marginal CPU
print('\n#### CPU as a fixed part plus a part per append\n')
print('A least-squares line through (committed/s, cores used) over the fixed-rate and half-max runs of one configuration. '
      'The fixed part is what a process spends each second whatever the rate (ticks, wakeups, one round of syscalls per batch); '
      'the marginal part is µs of one core per extra committed append.\n')
print('| storage | size B | groups | build | leader: fixed cores + µs/append | follower: fixed cores + µs/append | appends/s at 1 core (leader; extrapolated from the line, reasoned) |')
print('|---|---|---|---|---|---|---|')
for k in sorted({(r['store'], r['size'], r['groups'], r['impl']) for r in ok if r['mode'] == 'persisted'}, key=lambda k: (k[0], k[1], k[2], ORDER.get(k[3], 9))):
    rs = [r for r in ok if (r['store'], r['size'], r['groups'], r['impl']) == k and r['mode'] == 'persisted' and r['rate_label'] != 'max']
    if len({r['rate_label'] for r in rs}) < 2:
        continue
    cells = []
    fit = {}
    for who in ('leader', 'f1'):
        pts = [(r['tput'], r['cores_used'][who]) for r in rs if r['cores_used'].get(who) is not None]
        n = len(pts); mx = sum(p[0] for p in pts) / n; my = sum(p[1] for p in pts) / n
        sxx = sum((p[0] - mx) ** 2 for p in pts); sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
        b = sxy / sxx if sxx else 0; a0 = my - b * mx
        fit[who] = (a0, b)
        cells.append(f'{a0:.2f} + {b * 1e6:.2f}')
    a0, b = fit['leader']
    cap = (1 - a0) / b if b > 0 else float('inf')
    print(f'| {k[0]} | {k[1]} | {k[2]} | {k[3]} | {cells[0]} | {cells[1]} | {cap:,.0f} |')
