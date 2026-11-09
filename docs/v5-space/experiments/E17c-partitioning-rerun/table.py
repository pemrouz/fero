#!/usr/bin/env python3
"""
table.py: the one table of options for the E-17 verdict, made from this
re-run's results (WORK/results) and the probes (results/*-ablation.json).

    python3 table.py --work $SP/e17c/work > results/table.md

Per option: rules as written; necessary (this re-run's smallest set); the
other greedy order; the price with a working give-up path (kept, of which
undecided); model lines (code only, as report.py counts them); the entry
kinds the smallest model adds to the shared state (found by exploring it:
every kind that appears in any reachable log, with its field count) and the
cursor's parts; states as written and smallest (sum over the six sweep
bounds, then twice1 for the smallest); seconds of one full sweep as written
and smallest (this re-run, on a shared box: sizes, not timings); mutants.
"""

import argparse
import json
import os
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
ap = argparse.ArgumentParser()
ap.add_argument('--work', required=True)
A = ap.parse_args()
sys.path.insert(0, os.path.join(A.work, 'harness'))

import runner                                      # noqa: E402
from report import code_lines                      # noqa: E402
from bounds import BOUNDS, SWEEP                   # noqa: E402
from dsl import Mutation                           # noqa: E402
from world import World                            # noqa: E402

RES = os.path.join(A.work, 'results')
ROWS = [  # name, label, other orders, give-up result
    ('fixN', 'fixN', (), None),
    ('slot', 'slot moves', ('slot-rev',), 'slot+abort'),
    ('rekey', 'fixN + re-key (CELL as written)', ('rekey-rev', 'rekey-alt'), 'rekey+giveup-alt'),
    ('rekey-carry', 'fixN + re-key, positions carried', ('rekey-carry-rev', 'rekey-carry-alt'), 'rekey-carry+giveup'),
    ('pslot', 'pslot (MIN-P)', ('pslot-rev',), 'pslot+abort'),
    ('split', 'split + merge (SPLIT)', ('split-rev',), 'split+giveup'),
    ('lanes', 'lanes + range moves (LANE)', ('lanes-rev',), 'lanes+abort'),
    ('lanes-carry', 'lanes, records carried', (), None),
    ('pslot-fused', 'probe: pslot-fused', ('pslot-fused-rev',), 'pslot-fused+abort'),
]
ORIG = os.path.join(os.path.dirname(HERE), 'E17-partitioning', 'results')
FILES = {'fixN': 'fixN/model.py', 'slot': 'slot/model.py', 'rekey': 'rekey/model.py',
         'rekey-carry': 'rekey/model.py', 'pslot': 'pslot/model.py', 'split': 'split/model.py',
         'lanes': 'lanes/model.py', 'lanes-carry': 'lanes/model.py', 'pslot-fused': 'pslot/fused.py'}


def load(name, orig=False):
    """This re-run's result; with orig, the original's if this re-run only
    checked it (verify.py), marked by a dagger."""
    for d in (RES, os.path.join(HERE, 'results')):
        p = os.path.join(d, f'{name}-ablation.json')
        if os.path.exists(p):
            return json.load(open(p))
    if orig and os.path.exists(os.path.join(RES, f'{name}-verify.json')):
        d = json.load(open(os.path.join(ORIG, f'{name}-ablation.json')))
        d['_checked'] = True
        return d
    return None


def kept(d):
    return sum(r['kept'] for r in d['rules'])


def undecided(d):
    return sum(1 for r in d['rules'] if r['kept'] and r.get('final') and r['final'][1] == 'LIMIT')


def gtxt(g):
    if not g:
        return '-'
    k, u = kept(g), undecided(g)
    return (f'{k - u} to {k}' if u else f'{k}') + (' †' if g.get('_checked') else '')


def option_of(name):
    base = name.split('+')[0]
    for suf in ('-rev', '-alt'):
        if base.endswith(suf):
            base = base[:-len(suf)]
    return base


def kinds(name, drop):
    cls, _ = runner.load(option_of(name))
    k = {}
    for b in SWEEP:
        w = World(cls, BOUNDS[b], Mutation(drop=drop), cap=runner.CAP)
        seen = {w.init()}
        todo = [w.init()]
        while todo:
            s = todo.pop()
            for grp in s[0]:
                for e in grp[0] + grp[1]:
                    if e[0] != 'w':
                        k[e[0]] = max(k.get(e[0], 0), len(e) - 1)
            for lab, kind, t in w.succ(s):
                if t not in seen:
                    seen.add(t)
                    todo.append(t)
    cur = cls(BOUNDS['read']).cursor0()
    return k, len(cur)


def main():
    out = ['| Option | Rules as written | **Necessary** | Beyond fixN | Other greedy order | With a working give-up '
           '(of which undecided) | Model lines | Entry kinds the smallest model adds (fields) | Cursor parts | '
           'States as written, 6 sweep bounds | States smallest, 6 bounds; twice1 | Seconds, one sweep: as written; '
           'smallest | Mutants caught of made (equivalent; survived) |',
           '|---|---|---|---|---|---|---|---|---|---|---|---|---|']
    notes = ['', '† the original set (parts 1 and 2), checked fresh by verify.py, not re-derived. A range counts '
             'the rules still undecided at the state limit (kept).']
    base = None
    for name, label, other, gu in ROWS:
        d = load(name)
        if d is None:
            out.append(f'| {label} | not run yet |' + ' |' * 11)
            continue
        n = kept(d)
        if base is None:
            base = n
        os_ = [load(x) for x in other]
        g = load(gu, orig=True) if gu else None
        k, cp = kinds(name, d['removed'])
        sw = sum(d['base'][b]['states'] for b in SWEEP)
        sm = sum(d['minimal'][b]['states'] for b in SWEEP)
        tv = d.get('verify', {}).get('twice1', {}).get('states')
        ts = sum(d['base'][b]['secs'] for b in SWEEP)
        tm = sum(d['minimal'][b]['secs'] for b in SWEEP)
        mu = d.get('mutants') or []
        c = sum(1 for r in mu if r.get('caught'))
        e = sum(1 for r in mu if not r.get('caught') and r.get('equivalent'))
        u = sum(1 for r in mu if r.get('undecided'))
        lines = code_lines(os.path.join(A.work, 'options', FILES[name]))
        out.append(
            f'| {label} | {len(d["rules"])} | **{n}** | {n - base} | '
            f'{"; ".join(f"{kept(o)} (`{x}`)" for x, o in zip(other, os_) if o) or "-"} | '
            f'{gtxt(g)} | {lines} | '
            f'{len(k)}: ' + ', '.join(f'`{x}` ({f})' for x, f in sorted(k.items())) + f' | {cp} | '
            f'{sw:,} | {sm:,}; {tv:,} | {ts:.0f}; {tm:.1f} | '
            f'{c} of {len(mu)} ({e}; {len(mu) - c - e - u}) |')
    print('\n'.join(out + notes))


if __name__ == '__main__':
    main()
