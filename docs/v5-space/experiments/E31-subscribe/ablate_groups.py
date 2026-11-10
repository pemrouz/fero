#!/usr/bin/env python3
"""
ablate_groups.py: DEV-10's ablation for E-31, when the smallest sweep model
needs a whole path back for the verify bounds.

E-16's engine (Ablation.run) finds the smallest model on the sweep bounds,
then, if the verify bounds break it, puts back ONE dropped rule at a time. For
the subscribe protocol that cannot work: the sweep drops the snapshot path and
the `expired` path as wholes (the sweep bounds never need them), and the
verify bound `fo2-*` (a leader crash, then the new leader compacts its log)
needs one of those paths back, which is several rules at once. So this script:

  1. runs the engine's own ablation on the sweep bounds only (pass 1, greedy,
     final pass), from the same cache file;
  2. puts back the named groups (the paths), and checks the verify bounds;
  3. makes the result 1-minimal on the sweep and the verify bounds together:
     each kept rule (not pinned) is dropped if the model still holds on both;
  4. writes the engine's own rule table and its mutants (engine.Ablation.mutants)
     in the engine's JSON format, so report.py reads it.

    python3 ablate_groups.py MODEL OPTION OUT.json --group NAME=rule,rule ...

Every counted rule is still one whose removal alone lets the checker find a
counterexample on the sweep or verify bounds, as DEV-10 asks.
"""
import argparse
import importlib.util
import json
import os
import sys
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'E16-controller-loop', 'engine'))
import engine   # noqa: E402
from engine import Mutation, first_fail, Guard, _trace_of   # noqa: E402


def load(path):
    spec = importlib.util.spec_from_file_location('model_' + os.path.basename(path)[:-3], path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('model')
    ap.add_argument('option')
    ap.add_argument('out')
    ap.add_argument('--group', action='append', default=[])
    ap.add_argument('--limit', type=int, default=3_000_000)
    a = ap.parse_args()
    t0 = time.time()
    mod = load(a.model)
    cls = mod.OPTIONS[a.option]
    pinned = tuple(getattr(mod, 'PINNED', {}).get(a.option, ()))
    bn = [(b, mod.BOUNDS[b]) for b in mod.SWEEP]
    vn = [(b, mod.BOUNDS[b]) for b in mod.VERIFY]
    bnames, vnames = [b for b, _ in bn], [b for b, _ in vn]
    groups = []
    for g in a.group:
        name, rules = g.split('=', 1)
        groups.append((name, rules.split(',')))

    # 1. the engine's ablation on the sweep bounds only
    ab = engine.Ablation(cls, bn, verify=[], limit=a.limit, cache_path=a.out + '.cache')
    sweep = ab.run(mutate=False, pinned=pinned)
    if sweep.get('error'):
        raise SystemExit('sweep: ' + sweep['error'])
    removed = list(sweep['removed'])
    greedy = list(sweep['greedy'])
    ab.verify = vn                         # from here on, the verify bounds count too
    log = print

    def holds(drop, names, full=False):
        return first_fail(ab.per(Mutation(drop=drop), names, full)) is None

    # 2. the smallest sweep model on the verify bounds; put the groups back
    first = ab.per(Mutation(drop=removed), vnames, True)
    back = []
    ff = first_fail(first)
    log(f'  sweep: {len(removed)} dropped; on the verify bounds: {ff and ff[:3]}')
    if ff:
        for name, rules in groups:
            rs = [r for r in rules if r in removed]
            removed = [r for r in removed if r not in rs]
            # a pair, as the engine writes put_back (report.py reads pairs)
            back.append([f'group {name}: {", ".join(rs)}',
                         f'put back as a group: without it the smallest sweep model breaks '
                         f'{ff[1]} on {ff[0]} in {ff[2]} steps'])
            greedy.append([name, 'group put back: ' + ', '.join(rs)])
        ff2 = first_fail(ab.per(Mutation(drop=removed), vnames, True))
        if ff2:
            raise SystemExit(f'with the groups put back the model still breaks {ff2[:3]}')

    # 3. 1-minimal on the sweep and verify bounds together
    ids = [r.id for r in engine.rules(cls(bn[0][1]).actions())]
    while True:
        extra = None
        for i in ids:
            if i in removed or i in pinned:
                continue
            # verify first: a rule needed only there fails in seconds on fo2-*
            if holds(removed + [i], vnames) and holds(removed + [i], bnames):
                extra = i
                break
        if extra is None:
            break
        removed.append(extra)
        greedy.append([extra, 'dropped in the final pass on the sweep and verify bounds'])
        log(f'  final pass: dropped {extra}')

    # 4. the engine's table and mutants
    out = {'bounds': bnames, 'verify': vnames, 'pinned': list(pinned), 'base': sweep['base'],
           'greedy': greedy, 'removed': removed, 'put_back': back, 'sweep_removed': sweep['removed']}
    minimal = ab.per(Mutation(drop=removed), bnames, True)
    out['minimal'] = minimal
    out['verify_result'] = ab.per(Mutation(drop=removed), vnames, True)
    rows = []
    for r in engine.rules(cls(bn[0][1]).actions()):
        i = r.id
        row = {'id': i, 'kind': 'guard' if isinstance(r, Guard) else 'update', 'role': r.role,
               'note': r.note, 'cmp': getattr(r, 'op', None)}
        p1 = ab.per(Mutation(drop=[i]), bnames)
        row['alone'] = first_fail(p1)
        row['kept'] = i not in removed
        row['pinned'] = i in pinned
        if row['kept']:
            per = ab.per(Mutation(drop=removed + [i]), vnames)
            f = first_fail(per)
            if f is None:
                per = ab.per(Mutation(drop=removed + [i]), bnames)
                f = first_fail(per)
            row['final'] = f
            row['final_trace'] = _trace_of(per, f)
        rows.append(row)
    out['rules'] = rows
    # the engine's mutants with the bound lists swapped: each mutant meets the
    # verify bounds first (where the paths put back are needed), then the sweep;
    # equivalence is judged on the verify bounds (the larger ones)
    out['mutants'] = ab.mutants(removed, out['verify_result'], vnames, bnames, pinned)
    out['mutants_note'] = 'verify bounds first; equivalence judged on the verify bounds'
    out['option'] = a.option
    out['secs'] = round(time.time() - t0)
    with open(a.out, 'w') as f:
        json.dump(out, f, indent=1, default=str)
    kept = [r['id'] for r in rows if r['kept']]
    print(f'{a.option}: {len(kept)} rules kept of {len(rows)}; groups put back: {[b[0] for b in back]}')


if __name__ == '__main__':
    main()
