#!/usr/bin/env python3
"""
decide.py: the rules whose single drop stopped at the state limit, and every drop
mutant the ablation left undecided, decided on the *-cap bounds (E-60's README,
section 3a).

    python3 decide.py results/view-ablation.json [design | minimal | alone RULE | mutant RULE]

Dropping one of these rules lets the client churn new view instances without end,
so the checker stops at its state limit. The *-cap bounds are the sweep and verify
bounds with one more world limit: once a copy has built 3 entries in one life, its
linger stops expiring and it builds over no live entry. For each such rule this runs
(a) the design without it and (b) the smallest model without it (its drop mutant),
after checking that the design and the smallest model hold on the capped bounds.
"""
import json
import os
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, 'models'))
sys.path.insert(0, os.path.join(HERE, '..', 'E16-controller-loop', 'engine'))
import engine   # noqa: E402
import view     # noqa: E402

o = json.load(open(sys.argv[1]))
removed, limited = o['removed'], o['limited']
caps = [b + '-cap' for b in view.SWEEP + view.VERIFY]


def run(drop, label):
    for b in caps:
        r = engine.explore(view.View(view.BOUNDS[b]), engine.Mutation(drop=drop), limit=3_000_000)
        if r.fail or not r.complete:
            fs = ', '.join(f'{p} ({r.fail[p][0]} steps)' for p in sorted(r.fail)) or 'state limit'
            print(f'{label}: {b}: {r.states:,} states: {fs}', flush=True)
            for p, (d, tr) in sorted(r.fail.items()):
                print(f'  {p}: shortest trace, {d} steps')
                engine.show_trace(tr)
            return
    print(f'{label}: holds on every capped bound', flush=True)


# one piece per call (python3 decide.py FILE [design | minimal | alone RULE | mutant RULE]), or all
what = sys.argv[2:] or ['all']
if what[0] in ('design', 'all'):
    run([], 'the design')
if what[0] in ('minimal', 'all'):
    run(removed, 'the smallest model')
# every drop mutant the ablation left undecided (its own run stopped at the state limit), not
# only the rules whose drop alone did
undecided = [x['rule'] for x in o.get('mutants', []) if x['kind'] == 'drop' and x.get('undecided')]
for r in limited:
    if what[0] == 'all' or (what[0] == 'alone' and what[1] == r):
        run([r], f'the design without {r}')
for r in sorted(set(limited) | set(undecided), key=lambda r: (limited + undecided).index(r)):
    if what[0] == 'all' or (what[0] == 'mutant' and what[1] == r):
        run(removed + [r], f'the smallest model without {r} (its drop mutant)')
