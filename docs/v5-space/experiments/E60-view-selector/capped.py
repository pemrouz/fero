#!/usr/bin/env python3
"""
capped.py: the view model's smallest model and its mutants, finished on the capped
bounds (E-60's README, section 3a).

ablate.py keeps every rule whose drop alone stopped at the state limit, so its
smallest model may hold rules it does not need. On the *-cap bounds (the sweep and
verify bounds with one more world limit: once a copy has built 3 entries in one
life, its linger stops expiring and it builds over no live entry) those runs end.
This script starts from ablate.py's smallest model and makes one more greedy pass
there: first the rules ablate.py kept only for the state limit (and any whose drop
mutant stopped there), then every other kept rule, in model order; a rule is dropped
if the model without it holds on every capped bound; then final passes until one
drops nothing. Then the engine's mutants of the result, judged as ablate.py judges
them, on the capped bounds.

    python3 capped.py results/view-ablation.json results/view-capped.json

Resumable: its runs are cached in OUT.cache.
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
sys.path.insert(0, HERE)
import engine   # noqa: E402
from engine import Mutation, first_fail   # noqa: E402
import view     # noqa: E402
from ablate import mutants   # noqa: E402

src, out = sys.argv[1], sys.argv[2]
o = json.load(open(src))
cls = view.View
pinned = view.PINNED['view']
bn = [(b + '-cap', view.BOUNDS[b + '-cap']) for b in view.SWEEP]
vn = [(b + '-cap', view.BOUNDS[b + '-cap']) for b in view.VERIFY]
bnames, vnames = [b for b, _ in bn], [b for b, _ in vn]
ab = engine.Ablation(cls, bn, verify=vn, limit=3_000_000, cache_path=out + '.cache')

removed = list(o['removed'])
ids = [r.id for r in engine.rules(cls(bn[0][1]).actions())]
kept = [i for i in ids if i not in removed and i not in pinned]
first = set(o.get('limited', [])) | {x['rule'] for x in o['mutants'] if x['kind'] == 'drop' and x.get('undecided')}
order = [i for i in kept if i in first] + [i for i in kept if i not in first]


def holds(drop):
    per = ab.per(Mutation(drop=drop), bnames)
    ff = first_fail(per)
    if ff is None:
        ff = first_fail(ab.per(Mutation(drop=drop), vnames, True))
    return ff


base = holds(removed)
print(f'the smallest model of ablate.py on the capped bounds: {"holds" if base is None else base}', flush=True)
steps = []
for i in order:
    ff = holds(removed + [i])
    if ff is None:
        removed.append(i)
        steps.append([i, 'dropped'])
        print(f'  {i}: dropped (holds on every capped bound without it)', flush=True)
    else:
        steps.append([i, f'kept: {ff[1]} on {ff[0]} in {ff[2]} steps'])
        print(f'  {i}: kept ({ff[1]} on {ff[0]}, {ff[2]} steps)', flush=True)
# a final pass, as E-16's: try each rule still kept again, until a pass drops nothing (a rule
# kept early, for example for the state limit, may not be needed once others are gone)
while True:
    more = []
    for i in [i for i in order if i not in removed]:
        if holds(removed + [i]) is None:
            removed.append(i)
            more.append(i)
            steps.append([i, 'dropped in the final pass'])
            print(f'  {i}: dropped in the final pass', flush=True)
    if not more:
        break
minimal = ab.per(Mutation(drop=removed), bnames, True)
vres = ab.per(Mutation(drop=removed), vnames, True)
left = [i for i in ids if i not in removed and i not in pinned]
print(f'the smallest model on the capped bounds: {len(left)} rules and {len(pinned)} pinned; '
      + ', '.join(f'{b} {minimal[b]["states"]:,}' for b in bnames) + '; '
      + ', '.join(f'{b} {vres[b]["states"]:,}' for b in vnames), flush=True)
print('  kept: ' + ', '.join(left), flush=True)
rows = mutants(ab, cls, removed, minimal, bn + vn, bnames, vnames, pinned)
for r in rows:
    res = (f'{r["caught"][1]} on {r["caught"][0]} ({r["caught"][2]} steps)' if r.get('caught') else
           'equivalent' if r.get('equivalent') else 'undecided' if r.get('undecided') else 'SURVIVED')
    print(f'  {r["kind"]} {r["rule"]}: {res}', flush=True)
json.dump({'removed': removed, 'steps': steps, 'kept': left,
           'minimal': {b: minimal[b]['states'] for b in bnames}, 'verify': {b: vres[b]['states'] for b in vnames},
           'mutants': rows}, open(out, 'w'), indent=1, default=str)
