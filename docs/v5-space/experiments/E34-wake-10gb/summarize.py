#!/usr/bin/env python3
"""E-34: print the README's tables from results/wake.jsonl (median of the runs, spread = min-max of runs).
Usage: python3 summarize.py"""
import json, os, statistics
from collections import defaultdict

R = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')
rows, heads, fails = [], [], []
cur = None
for line in open(os.path.join(R, 'wake.jsonl')):
    d = json.loads(line)
    if 'loadavg' in d:
        cur = d
        heads.append(d)
    elif d.get('part') == 'failed':
        fails.append(d)
    else:
        d['_head'] = cur
        rows.append(d)


def ms(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return '-'
    m = statistics.median(xs)
    f = (lambda v: f'{v:.2f}') if m < 10 else (lambda v: f'{v:.1f}') if m < 1000 else (lambda v: f'{v:,.0f}')
    return f'{f(m)} ({f(min(xs))}-{f(max(xs))})' if len(xs) > 1 else f(m)


g = defaultdict(list)
for d in rows:
    h = d['_head']
    form = 'main' if d['part'] == 'wake-main' else 'worker+' + d['projection']
    how = d.get('load', '-') if d['part'] == 'wake-main' else 'frames'
    g[(d['shape'], d['rows'], form, how, h['heap'])].append(d)

print('### wake: time to the first committed write, memory, and GC pauses (median of runs, spread of runs)\n')
print('| rows | shape | snapshot GB | form | load | heap flag MB | wake to first write s | load s | first write ms | max RSS MB | heap used after load MB | GC max pause in load ms | runs |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
for k, v in sorted(g.items(), key=lambda k: (k[0][0] != 'small', k[0][1], k[0][2], k[0][3], str(k[0][4]))):
    heapafter = [x['after_load'].get('heap_used_mb', x['after_load'].get('main_heap_used_mb')) for x in v]
    gcl = [x['gc_load']['all']['max'] if 'gc_load' in x else max(x['gc_load_main']['all']['max'], x['gc_load_worker']['all']['max']) for x in v]
    print(f"| {k[1]:,} | {k[0]} | {v[0]['snapshot_gb']} | {k[2]} | {k[3]} | {k[4]} | {ms([x['wake_to_first_write_s'] for x in v])} | {ms([x['load_s'] for x in v])} | {ms([x['first_write_ms'] for x in v])} | {ms([x['max_rss_mb'] for x in v])} | {ms(heapafter)} | {ms(gcl)} | {len(v)} |")

print('\n### under 10,000 writes a second for 30 s after the wake: GC pauses and event-loop delay (ms)\n')
print('| rows | shape | form | heap flag | writes/s | GC max (main) | GC p99.9 (main) | major GCs (main) | GC max (worker) | GC p99.9 (worker) | loop delay p99.9 | loop delay max |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|')
for k, v in sorted(g.items(), key=lambda k: (k[0][0] != 'small', k[0][1], k[0][2], k[0][3], str(k[0][4]))):
    gm = [x.get('gc_write', x.get('gc_write_main')) for x in v]
    gw = [x.get('gc_write_worker') for x in v]
    el = [x.get('eld_write_ms', x.get('eld_write_main_ms')) for x in v]
    print(f"| {k[1]:,} | {k[0]} | {k[2]} ({k[3]}) | {k[4]} | {ms([x['writes_per_s'] for x in v])} | {ms([y['all']['max'] for y in gm])} | {ms([y['all']['p999'] for y in gm])} | {ms([y['major']['n'] for y in gm])} | {ms([y['all']['max'] for y in gw if y])} | {ms([y['all']['p999'] for y in gw if y])} | {ms([e['p999'] for e in el])} | {ms([e['max'] for e in el])} |")

lp = [(k, [x['load_parts_s'] for x in v if 'load_parts_s' in x]) for k, v in g.items()]
lp = [(k, xs) for k, xs in lp if xs]
if lp:
    print('\n### where the main-thread load time goes (s; GC runs inside decode and fold, so the parts overlap)\n')
    print('| rows | shape | load | read | crc | decode | fold | of which GC |')
    print('|---|---|---|---|---|---|---|---|')
    for k, xs in sorted(lp, key=lambda k: (k[0][0] != 'small', k[0][1], k[0][3], str(k[0][4]))):
        print(f"| {k[1]:,} | {k[0]} | {k[3]} ({k[4]} MB) | " + ' | '.join(ms([x[f] for x in xs]) for f in ['read', 'crc', 'decode', 'fold', 'gc']) + ' |')

wg = os.path.join(R, 'worker-gc.jsonl')
if os.path.exists(wg):
    ws = [json.loads(l) for l in open(wg)]
    ws = [w for w in ws if w.get('part') == 'worker-gc']
    if ws:
        print('\n### a Map of 5e6 row keys filled on the main thread, then on a worker: longest GC pause (ms)\n')
        print('| where | worker heap limit | longest pause, each try | GC kind of the longest (4 = major) | build s |')
        print('|---|---|---|---|---|')
        gg = defaultdict(list)
        for w in ws:
            gg[(w['where'], w['worker_old_mb'])].append(w)
        for k, v in sorted(gg.items()):
            print(f"| {k[0]} | {k[1] if k[0] == 'worker' else '-'} | {', '.join(str(x['longest'][0][0]) for x in v)} | {', '.join(str(x['longest'][0][1]) for x in v)} | {ms([x['build_ms'] / 1000 for x in v])} |")

if fails:
    print('\n### runs that did not finish\n')
    print('| heap flag | command | rows limit | exit | last stderr |')
    print('|---|---|---|---|---|')
    for f in fails:
        print(f"| {f['heap']} | {f['cmd'].split('/')[-1]} | {f['limit_rows'] or '-'} | {f['exit']} | {f['stderr'].strip().splitlines()[-1][:160] if f['stderr'].strip() else ''} |")

loads = [float(h['loadavg'].split()[0]) for h in heads]
mem = [h['mem_available_mb'] for h in heads]
if loads:
    print(f"\nload average at the start of each wake: median {statistics.median(loads):.2f}, range {min(loads):.2f}-{max(loads):.2f}; memory available: {min(mem):,}-{max(mem):,} MB; n={len(loads)}")
