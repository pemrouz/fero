#!/usr/bin/env python3
"""
crun.py: run the composed model.

    python3 model/crun.py --list
    python3 model/crun.py --base                       # the port against E-17's slot model
    python3 model/crun.py --bound src                  # one bound, with traces
    python3 model/crun.py --bound src --drop snap.outs # one rule switched off
    python3 model/crun.py --bound src --flip write.above
    python3 model/crun.py --design OUT.json [--only a,b] [--limit N]   # every bound, in full
    python3 model/crun.py --rules

It re-runs itself with PYTHONHASHSEED=0, as E-17's cli.py does, so state
digests are the same from run to run.
"""

import argparse
import json
import os
import sys
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

import cworld                                        # noqa: E402
from cworld import CWorld                            # noqa: E402
from cexplore import explore                         # noqa: E402
from cbounds import BOUNDS, BASE, SWEEP              # noqa: E402
from crossing import Crossing, ADDED                 # noqa: E402
from dsl import Mutation, rules                      # noqa: E402
from world import PROPS                              # noqa: E402

LIMIT = 3_000_000
ALLB = dict(BASE)
ALLB.update(BOUNDS)


def run(bound, mutation=None, stop_first=True, liveness=True, limit=LIMIT, progress=None):
    b = BASE[bound[5:]] if bound.startswith('base-') else BOUNDS[bound]
    w = CWorld(Crossing, b, mutation)
    return explore(w, stop_first=stop_first, liveness=liveness, limit=limit, progress=progress)


def show_trace(tr, indent='      '):
    for k, lab in enumerate(tr, 1):
        print(f'{indent}{k:2}. {" ".join(map(str, lab))}')


def rule_list(two=False):
    b = dict(BOUNDS['src'])
    if two:
        b['two_deciders'] = True
    return rules(Crossing(b).actions())


def as_json(r):
    return {'states': r.states, 'edges': r.edges, 'secs': round(r.secs, 1), 'complete': r.complete,
            'judged': r.judged, 'capped': r.capped, 'digest': list(r.digest),
            'fail': {p: [d, [' '.join(map(str, x)) for x in tr]] for p, (d, tr) in r.fail.items()}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bound')
    ap.add_argument('--drop', action='append', default=[])
    ap.add_argument('--flip', action='append', default=[])
    ap.add_argument('--limit', type=int, default=LIMIT)
    ap.add_argument('--all', action='store_true', help='do not stop at the first failure')
    ap.add_argument('--no-liveness', action='store_true')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--rules', action='store_true')
    ap.add_argument('--base', action='store_true')
    ap.add_argument('--design', help='run every bound in full; write the results to this JSON file')
    ap.add_argument('--only')
    a = ap.parse_args()

    if a.list:
        for n, b in BOUNDS.items():
            print(f'  {n}: attempts {[x[0] for x in b["attempts"]]}, fail {b["fail"]} {b["kinds"]}, '
                  f'heal {b["heal"]}, drop {b["dropg"]} x{b["drops"]}, reader {b["reader"]}, giveup {b["giveup"]}')
        for p, t in list(PROPS.items()) + list(cworld.PROPS_ADDED.items()):
            print(f'  {p}: {t}')
        return
    if a.rules:
        for r in rule_list():
            k = 'guard ' if hasattr(r, 'op') else 'update'
            c = f' [{r.op}]' if getattr(r, 'op', None) else ''
            new = ' NEW' if r.id in ADDED else ''
            print(f'{k} {r.id:26} {r.role:7}{c}{new} {r.note}')
        return
    if a.base:
        e17 = os.path.join(cworld.E17, '..', 'results', 'slot-ablation.json')
        old = json.load(open(e17))['base']
        ok = True
        for b in BASE:
            r = run('base-' + b, stop_first=False)
            same = (r.states, r.edges) == (old[b]['digest'][0], old[b]['digest'][1]) and not r.fail
            ok &= same
            print(f'{b:7} E-17 slot: {old[b]["digest"][0]:7,} states {old[b]["digest"][1]:8,} steps   '
                  f'this port: {r.states:7,} states {r.edges:8,} steps  fails: {sorted(r.fail) or "none"}  '
                  f'{"SAME" if same else "DIFFERENT"}')
        print('the port makes exactly E-17\'s states and steps' if ok else 'THE PORT DIFFERS')
        sys.exit(0 if ok else 1)
    if a.design:
        names = a.only.split(',') if a.only else list(BOUNDS)
        out = {}
        if os.path.exists(a.design):
            out = json.load(open(a.design))
        for n in names:
            t0 = time.time()
            r = run(n, stop_first=False, limit=a.limit,
                    progress=lambda i, m, s: print(f'    {n}: {i:,} expanded, {m:,} found, {s:.0f}s', flush=True))
            out[n] = as_json(r)
            print(f'{n:11} {r.summary()}  judged {r.judged:,}', flush=True)
            for p in sorted(r.fail):
                d, tr = r.fail[p]
                print(f'    {p} in {d} steps:')
                show_trace(tr)
            with open(a.design, 'w') as f:
                json.dump(out, f, indent=1)
        return
    m = Mutation(a.drop, a.flip)
    r = run(a.bound, m, stop_first=not a.all, liveness=not a.no_liveness, limit=a.limit)
    print(f'{a.bound} [{m}]: {r.summary()}  judged {r.judged:,}')
    for p in sorted(r.fail):
        d, tr = r.fail[p]
        print(f'  {p}: {PROPS.get(p) or cworld.PROPS_ADDED.get(p, "")}')
        print(f'    shortest counterexample, {d} steps:')
        show_trace(tr)


if __name__ == '__main__':
    main()
