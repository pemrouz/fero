#!/usr/bin/env python3
"""E-07: print the result tables (markdown) from results/*.jsonl: medians with min-max over runs."""
import json, sys, statistics, os
from collections import defaultdict

R = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'results')

def load(name):
    rows, la, run, cmd = [], None, None, None
    p = os.path.join(R, name)
    if not os.path.exists(p): return rows
    for l in open(p):
        d = json.loads(l)
        if 'loadavg' in d: la, run, cmd = d['loadavg'], d['run'], d['cmd']; continue
        if d.get('failed'): rows.append({'failed': True, 'cmd': cmd, 'run': run}); continue
        d['_load1'] = float(la.split()[0]); d['_run'] = run; d['_cmd'] = cmd
        rows.append(d)
    return rows

def med(xs, f='{:.1f}'):
    xs = [x for x in xs if x is not None]
    if not xs: return '-'
    m = statistics.median(xs)
    return (f.format(m) + ' (' + f.format(min(xs)) + '-' + f.format(max(xs)) + ')') if len(xs) > 1 else f.format(m)

gc = load('gc.jsonl')
if gc:
    print('### GC pauses on the main thread: while loading the rows, and under 30 s of steady writes\n')
    print('Pauses are perf_hooks `gc` entries (JavaScript stopped). Load phase = filling the rows (the heap grows, so major GCs run); writes = the 30 s write phase after one forced GC (columns: longest pause of any kind, longest major, longest minor, p99 of all). ELD = event-loop delay in the write phase.\n')
    print('| rows | shape | heap limit MB | offered/s | runs | achieved/s | heap after load MB | load s | load phase: longest pause ms | writes: longest pause ms | major ms | minor ms | GC p99 ms | ELD p99 ms | ELD p99.9 ms | ELD max ms | load avg |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    g = defaultdict(list)
    for d in gc:
        if d.get('failed'): continue
        g[(d['rows'], d['shape'], d['heap_limit_mb'], d['rate'])].append(d)
    for k in sorted(g, key=lambda k: (k[1], k[0], k[2], k[3])):
        xs = g[k]
        print(f"| {k[0]:,} | {k[1]} | {k[2]:,} | {k[3]:,} | {len(xs)} | {med([x['writes_per_s'] for x in xs], '{:,.0f}')} | {med([x['after_load']['heap_used_mb'] for x in xs], '{:,.0f}')} | {med([x['load_s'] for x in xs])} | "
              f"{med([x['gc_load']['all']['max'] for x in xs])} | {med([x['gc_write']['all']['max'] for x in xs])} | {med([x['gc_write']['major']['max'] for x in xs])} | {med([x['gc_write']['minor']['max'] for x in xs])} | {med([x['gc_write']['all']['p99'] for x in xs])} | "
              f"{med([x['eld_write_ms']['p99'] for x in xs])} | {med([x['eld_write_ms']['p999'] for x in xs])} | {med([x['eld_write_ms']['max'] for x in xs])} | {med([x['_load1'] for x in xs])} |")
    fails = [d for d in gc if d.get('failed')]
    if fails: print('\nFailed processes:', ', '.join(f"run {d['run']}: {d['cmd']}" for d in fails))
    print()

cr = load('cross.jsonl')
if cr:
    print('### Crossing between the main thread and a kernel worker (each record crosses in and out)\n')
    print('| mode | batch | runs | records/s (round trips) | wall ns per record per crossing | main busy ns per record (both crossings) | worker busy ns per record | load avg |')
    print('|---|---|---|---|---|---|---|---|')
    g = defaultdict(list)
    for d in cr: g[(d['mode'], d['batch'])].append(d)
    order = {'transfer': 0, 'sab': 1, 'sab-block': 2, 'clone': 3}
    for k in sorted(g, key=lambda k: (k[1], order[k[0]])):
        xs = g[k]
        print(f"| {k[0]} | {k[1]} | {len(xs)} | {med([x['recs_per_s'] for x in xs], '{:,.0f}')} | {med([x['wall_ns_per_rec_per_crossing'] for x in xs])} | {med([x['main_busy_ns_per_rec'] for x in xs])} | {med([x['worker_busy_ns_per_rec'] for x in xs])} | {med([x['_load1'] for x in xs])} |")
    print()

st = load('stall.jsonl')
if st:
    print('### A stalled main thread: the kernel\'s heartbeat and writes\n')
    print('| kernel on | stall | runs | stall ms | kernel timer gap max in stall ms | heartbeat gap at peer, max in stall ms | write RTT p50 in stall ms | write RTT p99 in stall ms | write RTT max in stall ms | commits queued for main | main drain ms | load avg |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|')
    g = defaultdict(list)
    for d in st: g[(d['kernel_on'], d['kind'])].append(d)
    for k in sorted(g, key=lambda k: (k[0] != 'worker', k[1])):
        xs = g[k]
        print(f"| {k[0]} | {k[1]} | {len(xs)} | {med([x['stall_ms'] for x in xs], '{:,.0f}')} | {med([x['kernel_timer_gap_ms']['stall']['max'] for x in xs])} | {med([x['peer']['heartbeat_gap_ms']['stall']['max'] for x in xs])} | "
              f"{med([x['peer']['write_rtt_ms']['stall']['p50'] for x in xs], '{:.2f}')} | {med([x['peer']['write_rtt_ms']['stall']['p99'] for x in xs], '{:.2f}')} | {med([x['peer']['write_rtt_ms']['stall']['max'] for x in xs], '{:.2f}')} | "
              f"{med([x['queued_for_main_after_stall'] for x in xs], '{:,.0f}')} | {med([x['main_drain_ms'] for x in xs])} | {med([x['_load1'] for x in xs])} |")
    gcs = [x['gc']['full_gc_ms'] for x in st if x.get('gc')]
    if gcs: print('\nForced full GCs on the main thread in the `gc` stall (ms, each run):', '; '.join(', '.join(str(v) for v in g_) for g_ in gcs))
    print()
