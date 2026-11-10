#!/usr/bin/env python3
"""
resolve24.py: settle the mutants an ablation left "undecided" only because a
verify bound stopped at the state limit.

    python3 resolve24.py MODEL.py RESULT.json

Why. The engine (E-16's Ablation.mutants) runs a mutant on the sweep bounds,
then on the verify bounds, and only then compares its reachable states with
the smallest model's. For the saga, the smallest model itself passes
3,000,000 states on the verify bound `sub-f` without an end. So a mutant that
changes nothing (two updates of one action swapped, which give the same next
state) also stops there, and the engine calls it "undecided" before it ever
compares states.

This script makes no new run. It reads the ablation's own cache and compares,
for each undecided mutant, the digest of its run (state count, step count and
a sum of state hashes) with the smallest model's on every bound: the sweep
bounds and the verify bounds that finish, and the stopped bound too (both
runs are breadth first in the same order, so equal digests there mean the
same first 3,000,001 states). A mutant equal on every bound is marked
equivalent, with `resolved_by`; any other stays undecided.
"""
import importlib.util
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'E16-controller-loop', 'engine'))
import engine   # noqa: E402


def key(m, b, full):
    return json.dumps([list(m.key()[0]), list(m.key()[1]), [list(x) for x in m.key()[2]], b, full])


def main():
    model, result = sys.argv[1:3]
    spec = importlib.util.spec_from_file_location('m24', model)
    M = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = M
    spec.loader.exec_module(M)
    R = json.load(open(result))
    cache = dict(json.load(open(result + '.cache')))
    cls = M.OPTIONS[R['option']]
    removed, pinned = list(R['removed']), set(R['pinned'])
    bn, vn = list(R['bounds']), list(R['verify'])

    def run(m, b):
        for full in (True, False):
            v = cache.get(key(m, b, full))
            if v is not None:
                return v
        return None

    base = {b: run(engine.Mutation(drop=removed), b) for b in bn + vn}
    acts = cls(M.BOUNDS[bn[0]]).actions()
    muts = {}
    for r in engine.rules(acts):
        if r.id in removed or r.id in pinned:
            continue
        muts[('drop', r.id)] = engine.Mutation(drop=removed + [r.id])
        if isinstance(r, engine.Guard) and r.is_cmp():
            muts[('flip', r.id)] = engine.Mutation(drop=removed, flip=[r.id])
    for a in acts:
        live = [k for k, u in enumerate(a.updates) if u.id not in removed and u.id not in pinned]
        for x in range(len(live)):
            for y in range(x + 1, len(live)):
                i, j = live[x], live[y]
                muts[('swap', f'{a.name}: {a.updates[i].name} <-> {a.updates[j].name}')] = \
                    engine.Mutation(drop=removed, swap={a.name: (i, j)})
    n = 0
    for row in R['mutants']:
        if not row.get('undecided'):
            continue
        m = muts[(row['kind'], row['rule'])]
        per = {b: run(m, b) for b in bn + vn}
        same = all(per[b] is not None and base[b] is not None and not per[b]['fail']
                   and per[b]['digest'] == base[b]['digest'] and per[b]['complete'] == base[b]['complete']
                   for b in bn + vn)
        if same:
            stopped = [b for b in bn + vn if not base[b]['complete']]
            row['was_undecided'] = row.pop('undecided')
            row['equivalent'] = True
            row['resolved_by'] = ('resolve24.py: the same state digest as the smallest model on every bound; '
                                  + (f'on {", ".join(stopped)} both runs stop at the state limit with the same '
                                     f'first {base[stopped[0]]["states"]:,} states' if stopped else 'all complete'))
            n += 1
        print(f'{row["kind"]} {row["rule"]}: {"equivalent (by digest on every bound)" if same else "still undecided"}')
    R['resolved'] = n
    with open(result, 'w') as f:
        json.dump(R, f, indent=1, default=str)
    c = sum(1 for m in R['mutants'] if m['caught'])
    eq = sum(1 for m in R['mutants'] if not m['caught'] and m.get('equivalent'))
    und = sum(1 for m in R['mutants'] if m.get('undecided'))
    print(f'{R["option"]}: mutants {len(R["mutants"])}; caught {c}; equivalent {eq}; undecided {und}; '
          f'survived {len(R["mutants"]) - c - eq - und}')


if __name__ == '__main__':
    main()
