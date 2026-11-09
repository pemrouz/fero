#!/usr/bin/env python3
"""E-40: the tables from results/bundle.jsonl, fanout.jsonl and cold.jsonl (medians with min-max over runs)."""
import json, sys, os, statistics, subprocess
from collections import defaultdict

R = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'results')
def rows(n):
    p = os.path.join(R, n)
    return [json.loads(l) for l in open(p) if l.strip()] if os.path.exists(p) else []
def med(xs, f='{:,.1f}'):
    xs = [x for x in xs if x is not None]
    if not xs: return '-'
    m = statistics.median(xs)
    return f.format(m) + (' (' + f.format(min(xs)) + '-' + f.format(max(xs)) + ')' if len(xs) > 1 else '')

b = rows('bundle.jsonl')
if b:
    print('### (a) Bundle sizes (esbuild, minified ESM for browsers)\n')
    print('| bundle | what | modules | minified bytes | gzip -9 bytes | brotli bytes |')
    print('|---|---|---|---|---|---|')
    what = {'data-all': 'every export of data', 'data-used': "only data's $ and lane (what the client imports)", 'codec': "fero v4's frame codec", 'client': 'the prototype client: data ($, lane) + codec + wire + door'}
    for r in b: print(f"| {r['name']} | {what.get(r['name'], '')} | {r['modules']} | {r['raw_bytes']:,} | {r['gzip9_bytes']:,} | {r['brotli_bytes']:,} |")
    print()

f = rows('fanout.jsonl')
if f:
    print('### (b) Fan-out from one Node relay core: WebSocket against plain TCP\n')
    here = os.path.dirname(os.path.abspath(__file__))
    print(subprocess.run(['python3', os.path.join(here, '../E08-relay-fanout/summarize.py'), os.path.join(R, 'fanout.jsonl')], capture_output=True, text=True).stdout)
    g = defaultdict(list)
    for r in f:
        if r.get('ok') and r['rate_label'] == 'max': g[(r['subs'], r.get('tick') or 'data', r['mode'])].append(r['per_relay_core'])
    for n, tick in sorted({(k[0], k[1]) for k in g}):
        t, w = g.get((n, tick, 'tcp')), g.get((n, tick, 'ws'))
        if t and w: print(f"WebSocket / TCP deliveries per relay core-second at {n:,} subscribers, tick={tick}: {statistics.median(w) / statistics.median(t):.2f}")
    print()

c = rows('cold.jsonl')
if c:
    print('### (c) Cold client: ms from the start of the runtime (process start for Node, navigation start for the page)\n')
    print('| runtime | runs | script starts | import of the bundle | connect + TLS + upgrade (open - start) | open -> challenge | challenge -> proof sent | proof -> first write committed | connect start -> committed | total: runtime start -> committed | load avg |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    g = defaultdict(list)
    for r in c:
        if 'error' in r: continue
        g[r['mode']].append(r)
    for mode in ('node', 'page', 'worker'):
        xs = g.get(mode)
        if not xs: continue
        m = lambda x, k: x['marks'].get(k)
        print(f"| {mode if mode != 'worker' else 'worker (Chromium Web Worker)'} | {len(xs)} | {med([x['script_start'] if mode != 'worker' else x['marks'].get('worker_script') for x in xs])} | {med([x['import_ms'] for x in xs])} | "
              f"{med([m(x, 'open') - m(x, 'start') for x in xs])} | {med([m(x, 'challenge') - m(x, 'open') for x in xs])} | {med([m(x, 'proof') - m(x, 'challenge') for x in xs])} | {med([m(x, 'committed') - m(x, 'proof') for x in xs])} | "
              f"{med([m(x, 'committed') - m(x, 'start') for x in xs])} | {med([m(x, 'committed') for x in xs])} | {med([float(x['loadavg'].split()[0]) for x in xs])} |")
    print('\nA second client in the same runtime (warm: the runtime and the bundle are loaded; ms from its connect call):\n')
    print('| runtime | runs | connect + TLS + upgrade | -> challenge | -> proof sent | -> first write committed (total) |')
    print('|---|---|---|---|---|---|')
    for mode in ('node', 'page', 'worker'):
        xs = [x for x in g.get(mode, []) if x.get('warm')]
        if not xs: continue
        w = lambda x, k: x['warm'].get(k)
        print(f"| {mode} | {len(xs)} | {med([w(x, 'open') for x in xs])} | {med([w(x, 'challenge') for x in xs])} | {med([w(x, 'proof') for x in xs])} | {med([w(x, 'committed') for x in xs])} |")
    errs = [r for r in c if 'error' in r]
    if errs: print('\nErrors:', '; '.join(r['error'] for r in errs))
