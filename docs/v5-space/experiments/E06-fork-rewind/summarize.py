#!/usr/bin/env python3
"""E-06: print the README's tables from results/*.jsonl (median of the runs, spread = min-max of run values).
Usage: python3 summarize.py"""
import json, os, statistics
from collections import defaultdict

R = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')


def load(name):
    p = os.path.join(R, name)
    rows, loads = [], []
    if os.path.exists(p):
        for line in open(p):
            d = json.loads(line)
            if 'loadavg' in d:
                loads.append(float(d['loadavg'].split()[0]))
            else:
                rows.append(d)
    return rows, loads


def ms(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return '-'
    m = statistics.median(xs)
    f = (lambda v: f'{v:.3f}') if m < 1 else (lambda v: f'{v:.2f}') if m < 10 else (lambda v: f'{v:.1f}') if m < 1000 else (lambda v: f'{v:,.0f}')
    return f'{f(m)} ({f(min(xs))}-{f(max(xs))})' if len(xs) > 1 else f(m)


def loadline(loads):
    return f'load average at start of each process: median {statistics.median(loads):.2f}, range {min(loads):.2f}-{max(loads):.2f}, n={len(loads)}' if loads else ''


fork, fl = load('fork.jsonl')
fork = [d for d in fork if d.get('part') == 'fork']
if fork:
    cols = ['snapshot', 'adopt', 'first-update', 'first-insert', 'view', 'fork-total', 'lane-refill', 'deep-copy', 'imm-build', 'imm-fork', 'imm-to-data']
    print('### fork: ms to copy a resource (median of 5 in a process; median of runs, spread of runs)\n')
    print('| rows | ' + ' | '.join(cols) + ' | fork heap MB | fork B/row | Immutable map MB |')
    print('|---|' + '---|' * (len(cols) + 3))
    g = defaultdict(list)
    for d in fork:
        g[d['rows']].append(d)
    for n, v in sorted(g.items()):
        print(f'| {n:,} | ' + ' | '.join(ms([x[c]['ms'] for x in v]) for c in cols) + f" | {ms([x['fork_heap_mb'] for x in v])} | {ms([x['fork_bytes_per_row'] for x in v])} | {ms([x['imm_map_heap_mb'] for x in v])} |")
    print('\n' + loadline(fl) + '\n')

rw, rl = load('rewind.jsonl')
rew = [d for d in rw if d.get('part') == 'rewind']
chk = [d for d in rw if d.get('part') == 'undo-check']
if rew:
    print('### rerun one input on the exact state before it (ms per rerun: median of the 20 (or 5) sampled reruns per run; median of runs, spread of runs)\n')
    print('| rows | method | K | view | rerun median | rerun p90 | rerun max | inputs replayed (median) | snapshots kept | ms to take one | heap kept MB | µs per record to keep | runs |')
    print('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    g = defaultdict(list)
    for d in rew:
        g[(d['rows'], d['method'], d['K'], d['view'])].append(d)
    order = {'snap': 0, 'imm': 1, 'immfloor': 2, 'undo': 3}
    # kept_heap_mb is the net heap change over the whole tape walk (heap after minus before, both after a full
    # collection), so it also holds the source's own churn; a negative median means the kept states cost less
    # than that noise, and is printed as such rather than as a size
    kept = lambda v: (lambda m: f'< noise (net {m:.1f})' if m < 0 else ms([x['kept_heap_mb'] for x in v]))(statistics.median([x['kept_heap_mb'] for x in v]))
    for k, v in sorted(g.items(), key=lambda k: (k[0][0], k[0][3], order[k[0][1]], k[0][2])):
        f = lambda key: ms([x[key] for x in v])
        print(f"| {k[0]:,} | {k[1]} | {k[2] or '-'} | {'group' if k[3] else 'none'} | {f('rerun_ms_median')} | {f('rerun_ms_p90')} | {f('rerun_ms_max')} | {int(statistics.median([x['replayed_inputs_median'] for x in v]))} | {v[0]['snapshots']} | {f('take_ms_median')} | {kept(v)} | {f('keep_us_per_record')} | {len(v)} |")
    print('\n' + loadline(rl) + '\n')
if chk:
    print('### undo checks\n')
    print('| rows | states compared after undo | key order kept | a removed row put back keeps key order |')
    print('|---|---|---|---|')
    g = defaultdict(list)
    for d in chk:
        g[d['rows']].append(d)
    for n, v in sorted(g.items()):
        if sum(x['of'] for x in v) == 0:
            print(f"| {n:,} | not checked (a full compare costs O(rows) per rerun) | - | - |")
            continue
        print(f"| {n:,} | {sum(x['states_checked'] for x in v)} (all equal) | {sum(x['key_order_kept'] for x in v)} of {sum(x['of'] for x in v)} | {sorted(set(str(x['remove_undo_keeps_key_order']) for x in v))} |")
