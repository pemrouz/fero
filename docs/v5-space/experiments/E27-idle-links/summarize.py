#!/usr/bin/env python3
"""E-27: medians with min-max over runs from runs.jsonl."""
import json, sys, statistics
from collections import defaultdict
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
def med(xs, f='{:,.1f}'):
    xs = [x for x in xs if x is not None]
    if not xs: return '-'
    m = statistics.median(xs)
    return f.format(m) + (' (' + f.format(min(xs)) + '-' + f.format(max(xs)) + ')' if len(xs) > 1 else '')
g = defaultdict(list)
for r in rows: g[(r['mode'] + ('' if r['node'].startswith('v22') else ' (Node ' + r['node'] + ')'), r['links'])].append(r)
print('| link | links | runs | join s | base RSS MB | RSS with links MB | per link KB (RSS) | per link KB (JS heap) | peak RSS MB | idle CPU % of a core | active CPU % of a core | deliveries/s | p50 µs | p99 µs | p99.9 µs | load avg |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for k in sorted(g):
    xs = g[k]
    print(f"| {k[0]} | {k[1]:,} | {len(xs)} | {med([x['join_s'] for x in xs], '{:.2f}')} | {med([x['base_rss_mb'] for x in xs])} | {med([x['held_rss_mb'] for x in xs])} | {med([x['per_link_kb'] for x in xs], '{:.2f}')} | {med([x['per_link_heap_kb'] for x in xs], '{:.2f}')} | "
          f"{med([x['peak_hwm_mb'] for x in xs])} | {med([x['idle_cpu_pct_core'] for x in xs], '{:.2f}')} | {med([x['active_cpu_pct_core'] for x in xs], '{:.1f}')} | {med([x['active_deliveries_per_s'] for x in xs], '{:,.0f}')} | "
          f"{med([x['active_lat_us']['p50'] for x in xs], '{:,.0f}')} | {med([x['active_lat_us']['p99'] for x in xs], '{:,.0f}')} | {med([x['active_lat_us']['p999'] for x in xs], '{:,.0f}')} | {med([float(x['loadavg'].split()[0]) for x in xs])} |")
