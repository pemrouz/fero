#!/usr/bin/env python3
"""
ablate.py: DEV-10's ablation and mutants for E-60's models, on E-16's engine.

    python3 ablate.py MODEL OPTION OUT.json [--limit N]

1. E-16's procedure (its Ablation.run, copied into run_ablation below and run
   from the same cache): pass 1, greedy drops in model-text order, a final
   pass that proves the set left 1-minimal on the sweep bounds; then the
   smallest model on the verify bounds, with rules put back one at a time in
   reverse order while it fails there. One change: a rule whose removal
   alone stopped at the state limit is kept, and not tried again.
2. For every rule, what its removal alone from the full design breaks, on
   the sweep bounds, then on the verify bounds if it holds there ("alone",
   pass 1): the ablation of each rule, the table
   a builder reads, as E-31 reports it.
3. The engine's mutants of the smallest model: drop each kept rule, flip each
   comparison, swap each pair of updates in one action (verify bounds when
   the sweep does not catch it; equivalence by the digest of the reachable
   states, as E-17 and E-31 judge it). One shortcut: a swap whose two orders
   give the same next state from every reachable state of the smallest model,
   on every sweep and verify bound, leaves the reachable states the same, so
   it is equivalent without the engine's runs.
4. The model's planted bugs (options in its PLANTED list), each on every
   sweep and verify bound.

The run resumes from OUT.json.cache, so it can be cut into holds.
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


def run_ablation(ab, pinned):
    """E-16's Ablation.run (pass 1, greedy, final pass; the verify bounds on the smallest model, with
    rules put back one at a time in reverse order), run from the same cache, with one change: a rule
    whose removal alone stopped at the state limit is kept as needed and not tried again in the final
    pass (its trials grow without end too, and each costs a run to the limit)."""
    from engine import rules
    rl = rules(ab.cls(list(ab.bounds)[0][1]).actions())
    ids = [r.id for r in rl]
    bn = [b for b, _ in ab.bounds]
    vn = [b for b, _ in ab.verify]
    out = {'bounds': bn, 'verify': vn, 'pinned': list(pinned)}
    base = ab.per(Mutation(), bn, True)
    out['base'] = base
    if any(base[b]['fail'] for b in bn) or not all(base[b]['complete'] for b in bn):
        out['error'] = 'the design fails or does not finish'
        return out
    removed, nec1 = [], {}
    for i in ids:
        nec1[i] = first_fail(ab.per(Mutation(drop=[i]), bn))
        # a rule that holds alone on the sweep bounds is tried on the verify bounds too (E-60's
        # review: a rule needed only with two faults looked unneeded on the one-fault sweep)
        if nec1[i] is None and vn and i not in pinned:
            nec1[i] = first_fail(ab.per(Mutation(drop=[i]), vn, True))
    print(f'  pass 1: {sum(1 for i in ids if nec1[i])} of {len(ids)} rules necessary alone', flush=True)
    limited = [i for i in ids if nec1[i] and nec1[i][1] == 'LIMIT']
    greedy = []
    for i in ids:
        if nec1[i] or i in pinned:
            continue
        ff = first_fail(ab.per(Mutation(drop=removed + [i]), bn))
        if ff is None:
            removed.append(i)
            greedy.append([i, 'dropped'])
        else:
            greedy.append([i, f'kept: with the others dropped it breaks {ff[1]} on {ff[0]} in {ff[2]} steps'])
    while True:
        remaining = [i for i in ids if i not in removed and i not in limited]
        fin = {i: ab.per(Mutation(drop=removed + [i]), bn) for i in remaining}
        extra = [i for i in remaining if first_fail(fin[i]) is None and i not in pinned]
        if not extra:
            break
        for i in extra:
            if first_fail(ab.per(Mutation(drop=removed + [i]), bn)) is None:
                removed.append(i)
                greedy.append([i, 'dropped in the final pass'])
    back = []
    while vn:
        ff = first_fail(ab.per(Mutation(drop=removed), vn, True))
        if not ff:
            break
        if ff[1] == 'LIMIT':
            out['verify_undecided'] = ff
            break
        fixed = None
        for r in reversed(removed):
            trial = [x for x in removed if x != r]
            if not first_fail(ab.per(Mutation(drop=trial), vn, True)) and \
                    not first_fail(ab.per(Mutation(drop=trial), bn)):
                fixed = r
                break
        if fixed is None:
            out['error'] = f'the smallest model fails {ff[1]} on {ff[0]} and no single rule put back fixes it'
            break
        removed = [x for x in removed if x != fixed]
        back.append([fixed, f'put back: without it the smallest model breaks {ff[1]} on {ff[0]} in {ff[2]} steps'])
        greedy.append(back[-1])
    out.update(greedy=greedy, removed=removed, put_back=back, limited=limited)
    out['minimal'] = ab.per(Mutation(drop=removed), bn, True)
    if vn:
        out['verify_result'] = ab.per(Mutation(drop=removed), vn, True)
    rows = []
    for r in rl:
        i = r.id
        row = {'id': i, 'kind': 'guard' if isinstance(r, Guard) else 'update', 'role': r.role,
               'note': r.note, 'cmp': getattr(r, 'op', None), 'alone': nec1[i], 'kept': i not in removed,
               'pinned': i in pinned}
        if row['kept']:
            if i in limited:
                row['final'] = nec1[i]
            else:
                per = ab.per(Mutation(drop=removed + [i]), bn)
                ff = first_fail(per)
                if ff is None and vn:
                    per = ab.per(Mutation(drop=removed + [i]), vn, True)
                    ff = first_fail(per)
                row['final'] = ff
                row['final_trace'] = _trace_of(per, ff)
        rows.append(row)
    out['rules'] = rows
    return out


def _apply(model, s, b, updates, removed, sw):
    us = list(updates)
    if sw:
        i, j = sw
        us[i], us[j] = us[j], us[i]
    d = engine.Draft(model.to_draft(s))
    for u in us:
        if u.id in removed:
            continue
        u.fn(model, s, b, d)
    return model.freeze(d)


def noncommuting(cls, bounds, removed, swaps, limit):
    """The swaps (action, i, j) whose two orders give another next state from some reachable state
    of the smallest model on one of the bounds. The rest change nothing reachable."""
    from collections import deque
    bad = set()
    for bname, bd in bounds:
        todo = [x for x in swaps if x not in bad]
        if not todo:
            break
        model = cls(bd)
        c = engine.Compiled(model, Mutation(drop=removed))
        acts = {a.name: (a, gs) for a, gs, us in c.acts}
        by = {}
        for a, i, j in todo:
            by.setdefault(a, []).append((i, j))
        init = model.init()
        seen = {init}
        q = deque([init])
        while q:
            s = q.popleft()
            for lab, kind, t in c.succ(s):
                if t not in seen:
                    seen.add(t)
                    q.append(t)
            if len(seen) > limit:
                raise SystemExit(f'commute check: {bname} passed {limit:,} states')
            for an, pairs in by.items():
                a, gs = acts[an]
                for b in a.params(model, s):
                    try:
                        if not all(g(model, s, b) for g in gs):
                            continue
                        base = _apply(model, s, b, a.updates, removed, None)
                    except (TypeError, IndexError, KeyError, ValueError):
                        continue
                    for i, j in pairs:
                        if (an, i, j) in bad:
                            continue
                        try:
                            alt = _apply(model, s, b, a.updates, removed, (i, j))
                        except (TypeError, IndexError, KeyError, ValueError):
                            alt = None
                        if alt != base:
                            bad.add((an, i, j))
        print(f'  commute check on {bname}: {len(seen):,} states; {len(bad)} of {len(swaps)} swaps change a step',
              flush=True)
    return bad


def mutants(ab, cls, removed, minimal, bounds, bn, vn, pinned, limited=()):
    """E-16's Ablation.mutants, with the commute check above for swaps."""
    acts = cls(bounds[0][1]).actions()
    rl = [r for r in engine.rules(acts) if r.id not in removed]
    muts = []
    limited = set(limited or ())
    for r in rl:
        if r.id not in pinned:
            muts.append(('drop', r.id, Mutation(drop=list(removed) + [r.id])))
    for r in rl:
        if isinstance(r, Guard) and r.is_cmp() and r.id not in pinned:
            muts.append(('flip', r.id, Mutation(drop=removed, flip=[r.id])))
    swaps = []
    for a in acts:
        live = [k for k, u in enumerate(a.updates) if u.id not in removed and u.id not in pinned]
        for x in range(len(live)):
            for y in range(x + 1, len(live)):
                i, j = live[x], live[y]
                swaps.append((a.name, i, j))
                muts.append(('swap', f'{a.name}: {a.updates[i].name} <-> {a.updates[j].name}',
                             Mutation(drop=removed, swap={a.name: (i, j)})))
    bad = noncommuting(cls, bounds, set(removed), swaps, 6_000_000)
    rows = []
    for kind, what, m in muts:
        row = {'kind': kind, 'rule': what}
        if kind == 'drop' and what in limited:
            row['caught'] = None
            row['undecided'] = ['', 'LIMIT', 0, ['LIMIT']]
            row['how'] = 'its removal alone already stopped at the state limit (pass 1); not run again'
            rows.append(row)
            continue
        if kind == 'swap':
            (an, (i, j)), = m.swap.items()
            if (an, i, j) not in bad:
                row['caught'] = None
                row['equivalent'] = True
                row['how'] = 'the two orders give the same next state from every reachable state'
                rows.append(row)
                continue
        per = ab.per(m, bn)
        ff = first_fail(per)
        if ff and ff[1] == 'LIMIT':
            row['caught'] = None
            row['undecided'] = ff
        elif ff:
            row['caught'] = ff
            row['trace'] = _trace_of(per, ff)
        else:
            vf = first_fail(ab.per(m, vn, True)) if vn else None
            if vf and vf[1] == 'LIMIT':
                row['caught'] = None
                row['undecided'] = vf
            elif vf:
                row['caught'] = vf
            else:
                fp = ab.per(m, bn, True)
                row['caught'] = None
                row['equivalent'] = all(fp[b]['digest'] == minimal[b]['digest'] for b in bn)
        rows.append(row)
    c = sum(1 for r in rows if r['caught'])
    eq = sum(1 for r in rows if not r['caught'] and r.get('equivalent'))
    und = sum(1 for r in rows if r.get('undecided'))
    print(f'  mutants: {len(rows)}; caught {c}; equivalent {eq}; undecided {und}; survived {len(rows) - c - eq - und}',
          flush=True)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('model')
    ap.add_argument('option')
    ap.add_argument('out')
    ap.add_argument('--limit', type=int, default=3_000_000)
    a = ap.parse_args()
    t0 = time.time()
    mod = load(a.model)
    cls = mod.OPTIONS[a.option]
    pinned = tuple(getattr(mod, 'PINNED', {}).get(a.option, ()))
    bn = [(b, mod.BOUNDS[b]) for b in mod.SWEEP]
    vn = [(b, mod.BOUNDS[b]) for b in mod.VERIFY]
    bnames, vnames = [b for b, _ in bn], [b for b, _ in vn]
    ab = engine.Ablation(cls, bn, verify=vn, limit=a.limit, cache_path=a.out + '.cache')
    out = run_ablation(ab, pinned)
    if out.get('error'):
        print('error:', out['error'])
    removed = out.get('removed', [])

    # 2. each rule alone, from the full design, on the sweep bounds (pass 1)
    for row in out.get('rules', []):
        if row.get('pinned'):
            continue
        per = ab.per(Mutation(drop=[row['id']]), bnames)
        ff = first_fail(per)
        if ff is None and vnames:
            per = ab.per(Mutation(drop=[row['id']]), vnames, True)
            ff = first_fail(per)
        row['alone_all'] = ff
        row['alone_trace'] = _trace_of(per, ff)

    # 3. the engine's mutants of the smallest model; a swap of two updates that give the same next
    # state, in either order, from every reachable state of the smallest model on every sweep and
    # verify bound is equivalent (the reachable states are the same), so it is not run again
    minimal = out.get('minimal') or ab.per(Mutation(drop=removed), bnames, True)
    out['mutants'] = mutants(ab, cls, removed, minimal, bn + vn, bnames, vnames, pinned, out.get('limited'))

    # 4. the planted bugs
    planted = []
    for opt in getattr(mod, 'PLANTED', ()):
        res = {}
        found = None
        for b, bd in bn + vn:
            r = engine.explore(mod.OPTIONS[opt](bd), limit=a.limit)
            res[b] = {'states': r.states, 'complete': r.complete,
                      'fail': {p: [d, [' '.join(map(str, x)) if isinstance(x, tuple) else str(x) for x in tr]]
                               for p, (d, tr) in r.fail.items()}}
            if r.fail and found is None:
                p = min(r.fail, key=lambda k: r.fail[k][0])
                found = [b, p, r.fail[p][0], sorted(r.fail)]
                break
        planted.append({'option': opt, 'caught': found, 'runs': res})
        print(f'  planted {opt}: {found and found[:3]}', flush=True)
    out['planted'] = planted
    out['option'] = a.option
    out['secs'] = round(time.time() - t0)
    with open(a.out, 'w') as f:
        json.dump(out, f, indent=1, default=str)
    kept = [r['id'] for r in out.get('rules', []) if r['kept']]
    print(f'{a.option}: {len(kept)} rules kept of {len(out.get("rules", []))}; error: {out.get("error")}')


if __name__ == '__main__':
    main()
