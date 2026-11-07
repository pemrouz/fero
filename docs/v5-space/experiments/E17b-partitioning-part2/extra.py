#!/usr/bin/env python3
"""
extra.py: run an option's model on bounds that are NOT in the shared sweep.

The shared bounds (E17-partitioning/harness/bounds.py) stay as they are, so
counts stay comparable. This script only asks one more question of a model
already ablated: does its smallest rule set still hold on a bigger bound,
and which dropped rules does the bigger bound need back? It changes nothing
in the harness; it imports it.

    python3 extra.py --option split --bound readback
    python3 extra.py --option split --bound readback --drop merged.base
    python3 extra.py --option split --bound readback --minimal          # the smallest set from results/
"""

import argparse
import json
import os
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
H = os.path.join(os.path.dirname(HERE), 'E17-partitioning')
sys.path.insert(0, os.path.join(H, 'harness'))

import runner                      # noqa: E402
from bounds import BOUNDS, SWEEP, TWICE, GROW  # noqa: E402
from dsl import Mutation           # noqa: E402
from world import World, PROPS     # noqa: E402
from explore import explore        # noqa: E402

EXTRA = {
    # grow then shrink back with the reader on p and two writes of one
    # holder: records on both sides of each change, so a reader must cross
    # a change back (a merge, a move back) with records behind it
    'readback': dict(layouts=TWICE, attempts=[('w1', 'p', 1), ('w2', 'p', 1)],
                     crashes=0, faults=0, reader=True),
    # the same with one leader crash anywhere
    'readback1': dict(layouts=TWICE, attempts=[('w1', 'p', 1), ('w2', 'p', 1)],
                      crashes=1, faults=1, reader=True),
    # one grow with a write to each partition and the reader on p, two crashes
    'bothread': dict(layouts=GROW, attempts=[('w1', 'p', 1), ('w3', 'q', 1)],
                     crashes=1, faults=2, reader=True),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--option', required=True)
    ap.add_argument('--bound', action='append', required=True)
    ap.add_argument('--drop', action='append', default=[])
    ap.add_argument('--keep', action='append', default=[], help='with --minimal: put this rule back')
    ap.add_argument('--minimal', help='drop what results/<name>-ablation.json removed (the smallest set)')
    ap.add_argument('--limit', type=int, default=runner.LIMIT)
    ap.add_argument('--repair', action='store_true',
                    help='with --minimal: if a bound fails, say which single dropped rule, put back, '
                         'makes every given bound and every shared sweep bound hold')
    a = ap.parse_args()
    drop = list(a.drop)
    if a.minimal:
        d = json.load(open(os.path.join(H, 'results', f'{a.minimal}-ablation.json')))
        drop += [r for r in d['removed'] if r not in a.keep]
    cls, _ = runner.load(a.option)
    bad = []
    for b in a.bound:
        bound = EXTRA.get(b) or BOUNDS[b]
        w = World(cls, bound, Mutation(drop=drop), cap=runner.CAP)
        r = explore(w, stop_first=False, limit=a.limit)
        tag = f'minimal of {a.minimal}' if a.minimal else (f'drop {", ".join(drop)}' if drop else 'as written')
        if a.keep:
            tag += ', back: ' + ', '.join(a.keep)
        print(f'{a.option} {b} [{tag}]: {r.summary()}{"" if r.complete else " (LIMIT: undecided)"}')
        if r.fail:
            bad.append(b)          # a LIMIT with no counterexample is undecided: nothing to repair
        for p in sorted(r.fail):
            dd, tr = r.fail[p]
            print(f'    {p} in {dd} steps: {PROPS[p]}')
            for k, lab in enumerate(tr, 1):
                print(f'      {k:2}. {" ".join(map(str, lab))}')
    if a.repair and bad and a.minimal:
        fixes = []
        for rule in reversed(drop):
            trial = [x for x in drop if x != rule]
            ok = True
            for b in list(a.bound) + list(SWEEP):
                bound = EXTRA.get(b) or BOUNDS[b]
                r = explore(World(cls, bound, Mutation(drop=trial), cap=runner.CAP), stop_first=True, limit=a.limit)
                if r.fail or not r.complete:
                    ok = False
                    break
            if ok:
                fixes.append(rule)
        print(f'    repair: put back any one of {fixes} and every bound given and every sweep bound holds'
              if fixes else '    repair: no single dropped rule, put back, makes every bound hold')


if __name__ == '__main__':
    main()
