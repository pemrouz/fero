#!/usr/bin/env python3
"""E-08 (and E-40's fan-out rows): medians with min-max over runs, from runs.jsonl lines."""
import json, sys, statistics
from collections import defaultdict
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
def med(xs, f='{:,.0f}'):
    xs = [x for x in xs if x is not None]
    if not xs: return '-'
    m = statistics.median(xs)
    return f.format(m) + (' (' + f.format(min(xs)) + '-' + f.format(max(xs)) + ')' if len(xs) > 1 else '')
g = defaultdict(list)
sweep = [r for r in rows if r.get('ok') and r['rate_label'] == 'sweep']
for r in rows:
    if r.get('ok') and r['rate_label'] != 'sweep': g[(r['impl'], r['mode'], r.get('tls', '0'), r['subs'], r['rate_label'], (r.get('tick') or 'data') if r['impl'] == 'node' else 'read-until-empty')].append(r)
bad = [r for r in rows if not r.get('ok')]
print('| relay | tick | wire | subscribers | rate | runs | deliveries/s | records in/s | relay cores | deliveries per relay core-second | subscriber cores (2 procs) | p50 µs | p99 µs | p99.9 µs | load avg |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for k in sorted(g, key=lambda k: (k[3], k[0], k[5], k[1], k[2], k[4] != 'max')):
    xs = g[k]
    rate = 'max' if k[4] == 'max' else (f"half CPU = {xs[0]['rate']:,}/s" if k[4] == 'halfcpu' else f"half = {xs[0]['rate']:,}/s")
    print(f"| {k[0]} | {k[5]} | {k[1]}{' + tls' if k[2] == '1' else ''} | {k[3]:,} | {rate} | {len(xs)} | {med([x['deliveries_per_s'] for x in xs])} | {med([x['recs_in_per_s'] for x in xs])} | {med([x['relay_cores'] for x in xs], '{:.2f}')} | {med([x['per_relay_core'] for x in xs])} | "
          f"{med([sum(x['subs_cores']) for x in xs], '{:.2f}')} | {med([x['lat_us_p50'] for x in xs], '{:,.0f}')} | {med([x['lat_us_p99'] for x in xs], '{:,.0f}')} | {med([x['lat_us_p999'] for x in xs], '{:,.0f}')} | {med([float(x['loadavg'].split()[0]) for x in xs], '{:.1f}')} |")
if sweep:
    print('\nThe halfcpu sweeps (one 3 s probe per rate, halving from half the max rate until the relay used at most 0.6 of a core): how the cost per delivery changes with the load.\n')
    print('| relay | wire | subscribers | records in/s | deliveries/s | relay cores | deliveries per relay core-second | p99 µs |')
    print('|---|---|---|---|---|---|---|---|')
    for x in sorted(sweep, key=lambda x: (x['subs'], x['impl'], x['mode'], -x['rate'])):
        print(f"| {x['impl']} | {x['mode']} | {x['subs']:,} | {x['rate']:,} | {x['deliveries_per_s']:,} | {x['relay_cores']:.2f} | {x['per_relay_core']:,} | {x['lat_us_p99']:,.0f} |")
if bad: print(f"\n{len(bad)} failed run(s):", '; '.join(f"{b['impl']} {b['subs']} {b['rate_label']} run {b['run']}" for b in bad))
