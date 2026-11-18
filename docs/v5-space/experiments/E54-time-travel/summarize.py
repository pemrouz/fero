#!/usr/bin/env python3
"""E-54 tables from results/*.jsonl: the median of the runs and, in brackets, the lowest and highest run.
Prints Markdown; README.md holds a copy between the tables markers."""
import json, os, statistics
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
R = os.path.join(HERE, 'results')


def load(name):
    rows, loads, failed = [], [], []
    p = os.path.join(R, name)
    if not os.path.exists(p):
        return rows, loads, failed
    for line in open(p):
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        if 'loadavg' in d:
            loads.append(float(d['loadavg'].split()[0]))
        elif d.get('part') == 'failed':
            failed.append(d)
        else:
            rows.append(d)
    return rows, loads, failed


def med(xs):
    xs = [x for x in xs if x is not None]
    if not xs:
        return None, None, None
    return statistics.median(xs), min(xs), max(xs)


def t(ns):  # a time in ns, in the unit that suits it
    if ns is None:
        return '-'
    a = abs(ns)
    if a < 1e3:
        return f'{ns:.0f} ns'
    if a < 1e6:
        return f'{ns / 1e3:.3g} µs'
    if a < 1e9:
        return f'{ns / 1e6:.3g} ms'
    return f'{ns / 1e9:.3g} s'


def num(x, d=1):
    if x is None:
        return '-'
    if abs(x) >= 1000:
        return f'{x:,.0f}'
    return f'{x:.{d}f}'


def cell(xs, fmt=num):
    m, lo, hi = med(xs)
    if m is None:
        return '-'
    if lo == hi:
        return fmt(m)
    return f'{fmt(m)} ({fmt(lo)}-{fmt(hi)})'


def loadline(loads):
    if not loads:
        return ''
    return f'\nload average at the start of each process: median {statistics.median(loads):.2f}, range {min(loads):.2f}-{max(loads):.2f}, n={len(loads)}\n'


ORDER = ['base', 'rev', 'revleaf', 'diff', 'ckpt', 'imm', 'hamt', 'fat', 'fatlog']
NAME = {'base': 'base (refold)', 'rev': '(a) rev', 'revleaf': '(a) revleaf', 'diff': '(d) diff (Baker)', 'ckpt': '(b) ckpt', 'imm': '(c) imm (Immutable.js)', 'hamt': '(c) hamt (here)', 'fat': '(e) fat', 'fatlog': '(e) fatlog'}


def structs():
    rows, loads, failed = load('structs.jsonl')
    g = defaultdict(list)
    for d in rows:
        g[(d['rows'], d['way'], d['K'])].append(d)
    keys = sorted(g, key=lambda k: (k[0], ORDER.index(k[1]), k[2] or 0))
    base = {n: statistics.median([d['build']['ns_per_write'] for d in g[(n, 'base', None)]]) for (n, w, k) in keys if w == 'base'}
    out = []
    out.append('### Node: the write path while history is kept (per write; then 10 s of steady writes at 50,000 a second)\n')
    out.append('History = 1,000,000 records folded after the start. "extra" is the way\'s write cost minus the plain fold\'s (base) in the same size. Kept = heap after the history minus heap before it (full collections at both ends), per version. Garbage = bytes the collector freed over the history, per write. Steady: GC pauses are perf_hooks `gc` entries; ELD = event-loop delay (1 ms resolution).\n')
    out.append('| rows | way | K | ns per write | extra ns | kept B per version | garbage B per write | steady: writes/s | write CPU share | GC ms in 10 s | longest GC pause ms | GC p99 ms | ELD p99 ms | ELD max ms | heap after MB | runs |')
    out.append('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for k in keys:
        ds = g[k]
        n, w, K = k
        out.append('| ' + ' | '.join([
            f'{n:,}', NAME[w], f'{K:,}' if K else '-',
            cell([d['build']['ns_per_write'] for d in ds]),
            cell([d['build']['ns_per_write'] - base.get(n, 0) for d in ds]),
            cell([d['build']['kept_b_per_version'] for d in ds]),
            cell([d['build']['garbage_b_per_write'] for d in ds]),
            cell([d['steady']['per_s'] for d in ds]),
            cell([d['steady']['write_cpu_share'] for d in ds], lambda x: f'{x:.2f}'),
            cell([d['steady']['gc']['all']['sum'] for d in ds], lambda x: f'{x:,.0f}'),
            cell([d['steady']['gc']['all']['max'] for d in ds]),
            cell([d['steady']['gc']['all']['p99'] for d in ds]),
            cell([d['steady']['eld_ms']['p99'] for d in ds]),
            cell([d['steady']['eld_ms']['max'] for d in ds]),
            cell([d['steady']['heap_mb'] for d in ds], lambda x: f'{x:,.0f}'),
            str(len(ds)),
        ]) + ' |')
    out.append(loadline(loads))
    out.append('### Node: stepping through versions (cursor starts at the newest version, about 1,500,000)\n')
    out.append('back and fwd: one step; mean of a batch of 1,000 where each step is under 100 µs, else the median of single steps. jump: to a random version (the mean of a batch of 1,000 where cheap, else the median and p90 of up to 50). read: one row at a random version, the cursor left where it is (median, p90 over up to 1,000; a batch mean in brackets where cheap). picture: a frozen whole picture at a random version (median of up to 10); for (c) a root, and "as a Map" turns it into a plain Map (what data can adopt). checks: reads, pictures, pictures again after the cursor moved, and the cursor itself, against a refold from the start.\n')
    out.append('| rows | way | K | step back | step forward | jump | jump p90 | read p50 | read p90 | read mean | picture p50 | picture as a Map | timer ns | checks wrong | no-copy picture changed |')
    out.append('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|')
    for k in keys:
        ds = g[k]
        n, w, K = k
        def op(name, f='p50'):
            return [d['ops_ns'][name][f] if d['ops_ns'][name] else None for d in ds]
        def mean_or(name):
            ms = [d['mean_ns'][name] for d in ds]
            return ms if all(m is not None for m in ms) else op(name)
        wrong = sum(d['checks']['reads_wrong'] + d['checks']['pictures_wrong'] + d['checks']['frozen_wrong'] + d['checks']['cursor_wrong'] for d in ds)
        checked = sum(d['checks']['reads'] + 2 * d['checks']['pictures'] + 40 for d in ds)
        nc = sorted(set(str(d['checks']['nocopy_picture_changed']) for d in ds))
        out.append('| ' + ' | '.join([
            f'{n:,}', NAME[w], f'{K:,}' if K else '-',
            cell(mean_or('back'), t), cell(mean_or('fwd'), t),
            cell(mean_or('jump'), t), cell(op('jump', 'p90'), t) if [d['mean_ns']['jump'] for d in ds][0] is None else '-',
            cell(op('read'), t), cell(op('read', 'p90'), t),
            cell([d['mean_ns']['read'] for d in ds], t),
            cell(op('picture'), t), cell(op('to_map'), t),
            cell(op('timer'), lambda x: f'{x:.0f}'),
            f'{wrong} of {checked}', '/'.join('-' if x == 'None' else ('yes' if x == 'True' else 'no') for x in nc),
        ]) + ' |')
    if failed:
        out.append('\nFailed processes: ' + '; '.join(f"run {d['run']}: {d['cmd'].split('/')[-1]} ({d['stderr'][-120:]})" for d in failed))
    return '\n'.join(out)


def hot():
    rows, loads, failed = load('hot.jsonl')
    if not rows and not failed:
        return ''
    g = defaultdict(list)
    for d in rows:
        g[(d['rows'], d['way'], d.get('hot'))].append(d)
    out = ['### One hot row: a tenth of all writes go to one row (HOT=0.1), fat nodes\n']
    out.append('The same history, plus one row `hot` that takes 10% of all records (about 150,000 versions by the end). "read" is a random row at a random version; "read hot" is the hot row at a random version.\n')
    out.append('| rows | way | ns per write | kept B per version | read p50 | read hot p50 | read hot p90 | read hot max | picture p50 | checks wrong | runs |')
    out.append('|---|---|---|---|---|---|---|---|---|---|---|')
    for k in sorted(g, key=lambda k: (k[0], ORDER.index(k[1]))):
        ds = g[k]
        n, w, h = k
        wrong = sum(d['checks']['reads_wrong'] + d['checks']['pictures_wrong'] + d['checks']['frozen_wrong'] + d['checks']['cursor_wrong'] for d in ds)
        checked = sum(d['checks']['reads'] + 2 * d['checks']['pictures'] + 40 for d in ds)
        out.append('| ' + ' | '.join([
            f'{n:,}', NAME[w], cell([d['build']['ns_per_write'] for d in ds]), cell([d['build']['kept_b_per_version'] for d in ds]),
            cell([d['ops_ns']['read']['p50'] for d in ds], t), cell([d['ops_ns']['read_hot']['p50'] for d in ds], t),
            cell([d['ops_ns']['read_hot']['p90'] for d in ds], t), cell([d['ops_ns']['read_hot']['max'] for d in ds], t),
            cell([d['ops_ns']['picture']['p50'] for d in ds], t), f'{wrong} of {checked}', str(len(ds)),
        ]) + ' |')
    out.append(loadline(loads))
    if failed:
        out.append('\nFailed processes: ' + '; '.join(f"run {d['run']}: {d['cmd'].split('/')[-1]}" for d in failed))
    return '\n'.join(out)


def live():
    rows, loads, failed = load('live.jsonl')
    g = defaultdict(list)
    by = {}
    for d in rows:
        if d['mode'] == 'bytes':
            by[d['rows']] = d
        else:
            g[(d['rows'], d['mode'])].append(d)
    MO = ['base', 'sink', 'prev', 'prev256']
    keys = sorted(g, key=lambda k: (k[0], MO.index(k[1])))
    out = ['### data: what the live fold pays to keep reverse records (fero v4 seam, data 63fea66)\n']
    out.append('base = `substrate.applyRec` per record (one data commit per record); sink = plus a data sink that does nothing; prev = plus a sink keeping each delta\'s `prev` (the row before the commit, by reference); prev256 = the lane with 256 records a call and the same sink. 1,000,000 records.\n')
    out.append('| rows | mode | ns per record | extra ns over base | kept B per record | kept B over base | garbage B per record | deltas per record | prev checked against the plain fold | runs |')
    out.append('|---|---|---|---|---|---|---|---|---|---|')
    base = {n: statistics.median([d['ns_per_record'] for d in g[(n, 'base')]]) for (n, m) in keys if m == 'base'}
    bkept = {n: statistics.median([d['kept_b_per_record'] for d in g[(n, 'base')]]) for (n, m) in keys if m == 'base'}
    for k in keys:
        ds = g[k]
        n, m = k
        chk = sum(d['prev_checked'] for d in ds)
        out.append('| ' + ' | '.join([
            f'{n:,}', m, cell([d['ns_per_record'] for d in ds]), cell([d['ns_per_record'] - base.get(n, 0) for d in ds]),
            cell([d['kept_b_per_record'] for d in ds]), cell([d['kept_b_per_record'] - bkept.get(n, 0) for d in ds]), cell([d['garbage_b_per_record'] for d in ds]),
            cell([d['deltas_per_record'] for d in ds], lambda x: f'{x:.3f}') if ds[0]['deltas_per_record'] is not None else '-',
            f"{sum(d['prev_wrong'] for d in ds)} wrong of {chk:,}" if chk else '-', str(len(ds)),
        ]) + ' |')
    out.append(loadline(loads))
    if by:
        out.append('### What each record would carry: fero v4 codec bytes\n')
        out.append('| rows | records (field / whole row / new / remove) | log B per record | + prior leaf B per record | as share of the log | + prior whole row B per record | as share of the log |')
        out.append('|---|---|---|---|---|---|---|')
        for n, d in sorted(by.items()):
            kd = d['kinds']
            out.append(f"| {n:,} | {kd['field']:,} / {kd['row']:,} / {kd['insert']:,} / {kd['remove']:,} | {d['log_b_per_record']} | {d['prior_leaf_b_per_record']} | {d['leaf_share']:.0%} | {d['prior_row_b_per_record']} | {d['row_share']:.0%} |")
    if failed:
        out.append('\nFailed processes: ' + '; '.join(f"run {d['run']}: {d['cmd'].split('/')[-1]}" for d in failed))
    return '\n'.join(out)


def rust():
    rows, loads, failed = load('rust.jsonl')
    g = defaultdict(list)
    for d in rows:
        g[(d['rows'], d['way'])].append(d)
    WO = ['base', 'rev', 'im', 'imbl', 'rpds']
    keys = sorted(g, key=lambda k: (k[0], WO.index(k[1])))
    out = ['### Rust: one persistent-map root per version (exact bytes from a counting allocator)\n']
    out.append('1,000,000 records. base and rev read and picture at the newest version only (a plain HashMap); im, imbl and rpds at a random version. read = mean of 100,000 in one batch; picture = into a std HashMap, median of 3.\n')
    out.append('| rows | way | ns per write | kept B per version | allocated B per write | read ns | picture ms | checks wrong | runs |')
    out.append('|---|---|---|---|---|---|---|---|---|')
    for k in keys:
        ds = g[k]
        n, w = k
        chk = sum(d['checked'] for d in ds)
        out.append('| ' + ' | '.join([
            f'{n:,}', w, cell([d['ns_per_write'] for d in ds]), cell([d['kept_b_per_version'] for d in ds]),
            cell([d['alloc_b_per_write'] for d in ds]), cell([d['read_ns'] for d in ds]), cell([d['picture_ms'] for d in ds]),
            f"{sum(d['wrong'] for d in ds)} of {chk:,}" if chk else '-', str(len(ds)),
        ]) + ' |')
    out.append(loadline(loads))
    if failed:
        out.append('\nFailed processes: ' + '; '.join(f"run {d['run']}: {d['cmd']}" for d in failed))
    return '\n'.join(out)


if __name__ == '__main__':
    print(structs())
    print()
    h = hot()
    if h:
        print(h)
        print()
    print(live())
    print()
    print(rust())
