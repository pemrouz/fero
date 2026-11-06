#!/usr/bin/env python3
"""E-02 tables: median over runs, range in brackets. Usage: summarize.py <results dir>"""
import json, os, statistics, sys

rows = [json.loads(l) for l in open(os.path.join(sys.argv[1], 'runs.jsonl')) if l.strip()]
ok = [r for r in rows if r.get('ok')]
bad = [r for r in rows if not r.get('ok')]

def med(xs):
    xs = [x for x in xs if x is not None]
    return (statistics.median(xs), min(xs), max(xs)) if xs else None

def f(t, d=1):
    if t is None:
        return '-'
    m, lo, hi = t
    if m >= 1000:
        return f'{m:,.0f} ({lo:,.0f}-{hi:,.0f})'
    return f'{m:.{d}f} ({lo:.{d}f}-{hi:.{d}f})'

order = {'ts': 0, 'ts-w1': 1, 'ts-w2': 2, 'ts-w4': 3, 'rust': 4, 'go': 5}
keys = []
for r in ok:
    k = (r['store'], r['mode'], r['groups'], r['size'], r['rate_label'], r['impl'])
    if k not in keys:
        keys.append(k)
keys.sort(key=lambda k: (k[0], k[1], k[2], k[3], {'max': 0, 'half': 2}.get(k[4], 1), str(k[4]).zfill(8), order.get(k[5], 9)))

print('| store | mode | groups | size B | rate | impl | runs | committed/s | p50 ms | p99 ms | p99.9 ms | CPU µs/append leader | f1 | f2 | cores leader | recs/flush | other cores | loadavg (1 min) |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for k in keys:
    rs = [r for r in ok if (r['store'], r['mode'], r['groups'], r['size'], r['rate_label'], r['impl']) == k]
    rate = k[4] if k[4] in ('max', 'half') else f'{int(k[4]):,}'
    if k[4] == 'half':
        rate = f"half = {int(statistics.median([r['rate'] for r in rs])):,}"
    la = med([float(r['loadavg'].split()[0]) for r in rs])
    print(f"| {k[0]} | {k[1]} | {k[2]} | {k[3]} | {rate} | {k[5]} | {len(rs)} | {f(med([r['tput'] for r in rs]))} | "
          f"{f(med([r['lat_ms']['p50'] for r in rs]), 2)} | {f(med([r['lat_ms']['p99'] for r in rs]), 2)} | {f(med([r['lat_ms']['p999'] for r in rs]), 2)} | "
          f"{f(med([r['cpu_us_per_append']['leader'] for r in rs]), 2)} | {f(med([r['cpu_us_per_append']['f1'] for r in rs]), 2)} | "
          f"{f(med([r['cpu_us_per_append']['f2'] for r in rs]), 2)} | {f(med([r['cores_used']['leader'] for r in rs]), 2)} | "
          f"{f(med([r['recs_per_flush'] for r in rs]))} | {f(med([r['other_cores'] for r in rs]), 2)} | {f(la, 1)} |")
if bad:
    print(f'\n{len(bad)} failed runs:')
    for r in bad:
        print('-', json.dumps(r)[:300])

# Fixed and marginal CPU: per configuration, a least-squares line through (committed/s, cores used)
# over the fixed-rate and half-max runs (max runs left out: their batches are capped, not timed).
# intercept = cores spent per second whatever the rate (ticks, wakeups, syscalls per batch);
# slope = µs of one core per extra committed append.
print('\n| store | mode | groups | size B | impl | points | leader: fixed cores, marginal µs/append | f1: fixed, marginal | f2: fixed, marginal |')
print('|---|---|---|---|---|---|---|---|---|')
fits = {}
for k in sorted({(r['store'], r['mode'], r['groups'], r['size'], r['impl']) for r in ok}, key=lambda k: (k[0], k[1], k[2], k[3], order.get(k[4], 9))):
    rs = [r for r in ok if (r['store'], r['mode'], r['groups'], r['size'], r['impl']) == k and r['rate_label'] != 'max']
    if len({r['rate'] for r in rs}) < 2:
        continue
    cells = []
    for who in ('leader', 'f1', 'f2'):
        pts = [(r['tput'], r['cores_used'][who]) for r in rs if r['cores_used'].get(who) is not None]
        if len(pts) < 2:
            cells.append('-'); continue
        n = len(pts); mx = sum(p[0] for p in pts) / n; my = sum(p[1] for p in pts) / n
        sxx = sum((p[0] - mx) ** 2 for p in pts); sxy = sum((p[0] - mx) * (p[1] - my) for p in pts)
        b = sxy / sxx if sxx else 0; a0 = my - b * mx
        cells.append(f'{a0:.3f}, {b * 1e6:.2f}')
    print(f'| {k[0]} | {k[1]} | {k[2]} | {k[3]} | {k[4]} | {len(rs)} | ' + ' | '.join(cells) + ' |')
