#!/usr/bin/env python3
"""
delta.py: what Y `fwd` adds over Y `smart`, by DEV-10, from the smart
option's smallest model.

    python3 delta.py FWD_OPTION SMART_ABLATION.json OUT.json

The `fwd` model is the `smart` model plus a relay (the client's copy goes to
any server, which forwards it). So instead of a second full ablation, it
starts from the smart option's 1-minimal set (its `removed` list):
  1. the fwd model with those rules dropped runs every bound in full, the
     verify bound included; if a bound fails, the dropped rule whose return
     fixes it is put back (latest first), as E-17's runner does;
  2. every rule left is dropped alone on top: a rule is needed if some bound
     then fails (this is E-17's final pass, so the set is 1-minimal);
  3. the rules not needed are dropped greedily in model-text order;
  4. mutants of the rules only `fwd` has (the relay's): drop each, flip each
     comparison, swap its updates; a mutant no bound catches is run in full
     and compared with the smallest model by state digest (equivalent or
     survived).
The result has the same shape as engine.Ablation's, so report.py reads it.
"""
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

_spec = importlib.util.spec_from_file_location('e20dedup', os.path.join(HERE, 'models', 'dedup.py'))
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)


def main():
    opt, smart_path, out_path = sys.argv[1:4]
    t0 = time.time()
    cls = M.OPTIONS[opt]
    smart = json.load(open(smart_path))
    pinned = tuple(M.PINNED[opt])
    ab = engine.Ablation(cls, [(b, M.BOUNDS[b]) for b in M.SWEEP], verify=[(b, M.BOUNDS[b]) for b in M.VERIFY],
                         cache_path=out_path + '.cache')
    bn, vn = list(M.SWEEP), list(M.VERIFY)
    rl = engine.rules(cls(M.BOUNDS[M.SWEEP[0]]).actions())
    ids = [r.id for r in rl]
    smart_ids = {r['id'] for r in smart['rules']}
    removed = [i for i in smart['removed'] if i in ids]
    out = {'option': opt, 'bounds': bn, 'verify': vn, 'pinned': list(pinned), 'from': os.path.basename(smart_path),
           'start_removed': list(removed)}
    out['base'] = ab.per(engine.Mutation(), bn, True)
    back = []
    while True:
        ff = engine.first_fail(ab.per(engine.Mutation(drop=removed), bn + vn, False))
        if not ff:
            break
        fixed = None
        for r in reversed(removed):
            trial = [x for x in removed if x != r]
            if not engine.first_fail(ab.per(engine.Mutation(drop=trial), bn + vn, False)):
                fixed = r
                break
        if fixed is None:
            out['error'] = f'the smart minimal set fails {ff} under fwd and no single rule put back fixes it'
            break
        removed = [x for x in removed if x != fixed]
        back.append([fixed, f'put back: with the smart set dropped, fwd breaks {ff[1]} on {ff[0]} in {ff[2]} steps'])
    out['put_back'] = back
    greedy = []
    while True:
        cand = [i for i in ids if i not in removed and i not in pinned]
        res = {i: engine.first_fail(ab.per(engine.Mutation(drop=removed + [i]), bn + vn, False)) for i in cand}
        free = [i for i in cand if res[i] is None]
        if not free:
            break
        removed.append(free[0])
        greedy.append([free[0], 'dropped (not needed under fwd)'])
    out['greedy'] = greedy
    out['removed'] = removed
    out['minimal'] = ab.per(engine.Mutation(drop=removed), bn, True)
    out['verify_result'] = ab.per(engine.Mutation(drop=removed), vn, True)
    rows = []
    for r in rl:
        i = r.id
        row = {'id': i, 'kind': 'guard' if isinstance(r, engine.Guard) else 'update', 'role': r.role, 'note': r.note,
               'cmp': getattr(r, 'op', None), 'pinned': i in pinned, 'kept': i not in removed,
               'fwd_only': i not in smart_ids}
        if row['kept'] and not row['pinned']:
            row['final'] = engine.first_fail(ab.per(engine.Mutation(drop=removed + [i]), bn + vn, False))
            row['alone'] = row['final']
        rows.append(row)
    out['rules'] = rows
    # mutants of the relay's rules (the rules only fwd has)
    muts = []
    acts = cls(M.BOUNDS[M.SWEEP[0]]).actions()
    fwd_only = [r for r in rl if r.id not in smart_ids and r.id not in removed and r.id not in pinned]
    for r in fwd_only:
        muts.append(('drop', r.id, engine.Mutation(drop=removed + [r.id])))
        if isinstance(r, engine.Guard) and r.is_cmp():
            muts.append(('flip', r.id, engine.Mutation(drop=removed, flip=[r.id])))
    for a in acts:
        live = [k for k, u in enumerate(a.updates) if u.id not in removed and u.id not in pinned]
        if not any(a.updates[k].id not in smart_ids for k in live):
            continue
        for x in range(len(live)):
            for y in range(x + 1, len(live)):
                i, j = live[x], live[y]
                muts.append(('swap', f'{a.name}: {a.updates[i].name} <-> {a.updates[j].name}',
                             engine.Mutation(drop=removed, swap={a.name: (i, j)})))
    mrows = []
    for kind, what, m in muts:
        ff = engine.first_fail(ab.per(m, bn + vn, False))
        row = {'kind': kind, 'rule': what}
        if ff:
            row['caught'] = ff
        else:
            fp = ab.per(m, bn, True)
            row['caught'] = None
            row['equivalent'] = all(fp[b]['digest'] == out['minimal'][b]['digest'] for b in bn)
        mrows.append(row)
    out['mutants'] = mrows
    out['secs'] = round(time.time() - t0)
    with open(out_path, 'w') as f:
        json.dump(out, f, indent=1, default=str)
    kept = [r['id'] for r in rows if r['kept'] and not r['pinned']]
    print(f'{opt}: {len(kept)} rules needed; fwd-only kept: {[r["id"] for r in rows if r["kept"] and r["fwd_only"] and not r["pinned"]]}; '
          f'put back: {back}; {out["secs"]} s')


if __name__ == '__main__':
    main()
