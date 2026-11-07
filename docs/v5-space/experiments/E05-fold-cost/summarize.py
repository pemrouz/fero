#!/usr/bin/env python3
"""E-05: print the README's tables from results/*.jsonl (median of the runs, and the spread min-max of the
per-run medians). Usage: python3 summarize.py"""
import json, os, statistics
from collections import defaultdict

R = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'results')


def load(name, part):
    p = os.path.join(R, name)
    if not os.path.exists(p):
        return [], []
    rows, loads = [], []
    for line in open(p):
        d = json.loads(line)
        if 'loadavg' in d:
            loads.append(float(d['loadavg'].split()[0]))
        elif d.get('part') == part:
            rows.append(d)
    return rows, loads


def ms(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return '-'
    m = statistics.median(xs)
    f = (lambda v: f'{v:.2f}') if m < 10 else (lambda v: f'{v:.1f}') if m < 1000 else (lambda v: f'{v:,.0f}')
    return f'{f(m)} ({f(min(xs))}-{f(max(xs))})' if len(xs) > 1 else f(m)


def loadline(loads):
    return f'load average at start of each process: median {statistics.median(loads):.2f}, range {min(loads):.2f}-{max(loads):.2f}, n={len(loads)}' if loads else ''


fold, fl = load('fold.jsonl', 'fold')
if fold:
    print('### fold: µs per record, wall (CPU), median of runs (spread of run medians)\n')
    print('| rows | views | mode | field update | whole-row set | insert | delete | runs |')
    print('|---|---|---|---|---|---|---|---|')
    g = defaultdict(lambda: defaultdict(list))
    for d in fold:
        g[(d['rows'], d['views'], d['mode'])][d['kind']].append(d)
    for (n, v, m), kinds in sorted(g.items(), key=lambda k: (k[0][0], ['none', 'group', 'filter100'].index(k[0][1]), k[0][2] != 'rec')):
        cells = []
        for k in ['field', 'set', 'insert', 'delete']:
            xs = kinds.get(k, [])
            cells.append(f"{ms([x['us_wall'] for x in xs])} [cpu {ms([x['us_cpu'] for x in xs])}]")
        print(f"| {n:,} | {v} | {m} | " + ' | '.join(cells) + f" | {len(kinds.get('field', []))} |")
    print('\n' + loadline(fl) + '\n')

gs, gl = load('group-scale.jsonl', 'group-scale')
if gs:
    print('### group view cost against bucket size (lane batches of 256, µs per record)\n')
    print('| rows | rows per bucket | none | counts (length(fn)) | group | group + sink |')
    print('|---|---|---|---|---|---|')
    g = defaultdict(lambda: defaultdict(list))
    for d in gs:
        g[d['rows']][d['variant']].append(d['us_per_record_b256'])
    for n, v in sorted(g.items()):
        print(f"| {n:,} | {n // 16:,} | " + ' | '.join(ms(v[k]) for k in ['none', 'counts', 'group', 'group+sink']) + ' |')
    print('\n' + loadline(gl) + '\n')

mem, _ = load('mem.jsonl', 'mem')
if mem:
    print('### memory: bytes of V8 heap per row after full GC (runs agree to within a few bytes; median shown)\n')
    print('| rows | form | views | heap/row after load | after churn | views add | heap/row with views | RSS/row after churn | heap limit MB |')
    print('|---|---|---|---|---|---|---|---|---|')
    g = defaultdict(list)
    for d in mem:
        g[(d['rows'], d['form'], d['views'])].append(d)
    for k, v in sorted(g.items(), key=lambda k: (k[0][0], k[0][1] != 'seam', ['none', 'group', 'filter100'].index(k[0][2]))):
        md = lambda f: int(statistics.median([x[f] for x in v if f in x])) if any(f in x for x in v) else '-'
        print(f"| {k[0]:,} | {k[1]} | {k[2]} | {md('heap_per_row')} | {md('heap_per_row_after_churn')} | {md('views_heap_per_row')} | {md('heap_per_row_with_views')} | {md('rss_per_row_after_churn')} | {md('heap_size_limit_mb')} |")
    print(f"\nrow size: {mem[0]['row_json_bytes']} B as JSON, {mem[0]['row_codec_bytes']} B in fero's codec (one insert record).\n")

rp, rl = load('replay.jsonl', 'replay')
if rp:
    print('### replay from an encoded log (1e6 records, file in page cache)\n')
    print('| log | format | views | seconds | records/s | s per GB | read s | decode s | fold s | view build s | heap MB |')
    print('|---|---|---|---|---|---|---|---|---|---|---|')
    g = defaultdict(list)
    for d in rp:
        g[(d['file'], d['fmt'], d['views'])].append(d)
    for k, v in g.items():
        f = lambda key: ms([x.get(key) for x in v])
        print(f"| {k[0]} | {k[1]} | {k[2]} | {f('seconds')} | {ms([x['records_per_s'] for x in v])} | {f('s_per_gb')} | {f('read_s')} | {f('decode_s')} | {f('fold_s')} | {f('view_build_s')} | {f('heap_mb')} |")
    print('\n' + loadline(rl) + '\n')

hs, hl = load('hash.jsonl', 'hash')
if hs:
    print('### hashing the folded state on the main thread (ms)\n')
    print('| rows | xx-sum | sha-sorted | md5-each | json-xx | encode-only |')
    print('|---|---|---|---|---|---|')
    g = defaultdict(lambda: defaultdict(list))
    for d in hs:
        g[d['rows']][d['way']].append(d['ms'])
    for n, v in sorted(g.items()):
        print(f"| {n:,} | " + ' | '.join(ms(v[k]) for k in ['xx-sum', 'sha-sorted', 'md5-each', 'json-xx', 'encode-only']) + ' |')
    print('\n' + loadline(hl) + '\n')

d13, dl = load('d13.jsonl', 'd13')
if d13:
    print("### decision 13's form: bytes per row on each thread, and the worker's hash\n")
    print('| rows | worker form | projection | main heap/row | worker heap/row | worker arena/row | total/row | RSS/row | worker hash ms | load ms |')
    print('|---|---|---|---|---|---|---|---|---|---|')
    g = defaultdict(list)
    for d in d13:
        g[(d['rows'], d['worker_form'], d['projection'])].append(d)
    for k, v in sorted(g.items()):
        md = lambda f: int(statistics.median([x[f] for x in v]))
        print(f"| {k[0]:,} | {k[1]} | {k[2]} | {md('main_heap_per_row')} | {md('worker_heap_per_row')} | {md('worker_arena_per_row')} | {md('total_per_row')} | {md('rss_per_row')} | {ms([x['worker_hash_ms'] for x in v])} | {ms([x['load_ms'] for x in v])} |")
    print('\n' + loadline(dl) + '\n')
