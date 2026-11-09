#!/usr/bin/env python3
"""
ablate20.py: E-17's ablation procedure (DEV-10) for E-20's options, on
E-16's engine, without running the pinned rules.

    python3 ablate20.py OPTION OUT.json [--from SMART.json] [--model models/dedup.py]

Why not engine.Ablation.run: it runs pass 1 and the final pass for the
pinned rules too. Here a third of each model is pinned (the world's
bookkeeping), and dropping a bookkeeping update (a copy never taken off the
wire) makes the state space run to the 1.5 million limit, about 90 s a run,
to learn nothing: a pinned rule is never dropped. This script runs the same
procedure on the rules that are not pinned, with engine.Ablation's cache
(the same file format, so an interrupted engine run's cache is reused):
  1. the design runs every bound in full; it must hold;
  2. pass 1: each rule dropped alone (not with --from);
  3. greedy, in model-text order: each rule pass 1 did not find necessary is
     dropped if every bound still holds with it and the earlier drops;
  4. final pass: every rule left is dropped on top; any whose removal breaks
     nothing is dropped, and the pass repeats until each rule left breaks a
     bound (1-minimal);
  5. verify: the smallest model on the verify bound; if it fails, the
     latest dropped rule whose return fixes it is put back;
  6. mutants of the smallest model (drop each rule left, flip each
     comparison, swap each pair of updates in one action); one no bound
     catches is run in full and compared with the smallest model by state
     digest (equivalent or survived).
With --from SMART.json (the Y `fwd` options), step 1 starts from the smart
option's smallest model instead (its `removed` list; a rule whose drop then
fails is put back), pass 1 is skipped, and the mutants are those of the rules
only `fwd` has (the relay's).
The output has engine.Ablation's shape, so report.py reads it.
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

FF = engine.first_fail


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('option')
    ap.add_argument('out')
    ap.add_argument('--from', dest='frm')
    ap.add_argument('--model', default=os.path.join(HERE, 'models', 'dedup.py'))
    ap.add_argument('--limit', type=int, default=1_500_000)
    a = ap.parse_args()
    spec = importlib.util.spec_from_file_location('e20model', a.model)
    M = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(M)
    t0 = time.time()
    cls = M.OPTIONS[a.option]
    pinned = set(getattr(M, 'PINNED', {}).get(a.option, ()))
    bn, vn = list(M.SWEEP), list(M.VERIFY)
    ab = engine.Ablation(cls, [(b, M.BOUNDS[b]) for b in bn], verify=[(b, M.BOUNDS[b]) for b in vn],
                         limit=a.limit, cache_path=a.out + '.cache')
    acts = cls(M.BOUNDS[bn[0]]).actions()
    rl = engine.rules(acts)
    ids = [r.id for r in rl]
    free = [i for i in ids if i not in pinned]
    log = lambda *x: print(*x, flush=True)
    out = {'option': a.option, 'bounds': bn, 'verify': vn, 'pinned': sorted(pinned & set(ids))}
    run = lambda drop, names, full=False: ab.per(engine.Mutation(drop=drop), names, full)
    out['base'] = run([], bn, True)
    if any(x['fail'] or not x['complete'] for x in out['base'].values()):
        out['error'] = 'the model as designed fails or does not finish: ' + str(
            {b: (sorted(x['fail']), x['complete']) for b, x in out['base'].items()})
        json.dump(out, open(a.out, 'w'), indent=1, default=str)
        log(out['error'])
        return
    smart_ids = None
    removed, back, greedy, nec1 = [], [], [], {}
    if a.frm:
        sm = json.load(open(a.frm))
        smart_ids = {r['id'] for r in sm['rules']}
        out['from'] = os.path.basename(a.frm)
        removed = [i for i in sm['removed'] if i in ids]
        out['start_removed'] = list(removed)
        while True:
            ff = FF(run(removed, bn + vn))
            if not ff:
                break
            fixed = next((r for r in reversed(removed) if not FF(run([x for x in removed if x != r], bn + vn))), None)
            if fixed is None:
                out['error'] = f'the smart set fails {ff} here and no single rule put back fixes it'
                break
            removed.remove(fixed)
            back.append([fixed, f'put back: with the smart set dropped it breaks {ff[1]} on {ff[0]} in {ff[2]} steps'])
    else:
        for i in free:
            nec1[i] = FF(run([i], bn))
        log(f'  pass 1: {sum(1 for i in free if nec1[i])} of {len(free)} rules necessary alone')
    for i in free:
        if i in removed or nec1.get(i):
            continue
        ff = FF(run(removed + [i], bn))
        if ff is None:
            removed.append(i)
            greedy.append([i, 'dropped'])
        else:
            greedy.append([i, f'kept: with the others dropped it breaks {ff[1]} on {ff[0]} in {ff[2]} steps'])
    while True:
        extra = [i for i in free if i not in removed and FF(run(removed + [i], bn)) is None]
        if not extra:
            break
        for i in extra:
            if FF(run(removed + [i], bn)) is None:
                removed.append(i)
                greedy.append([i, 'dropped in the final pass'])
    while vn:
        ff = FF(run(removed, vn, True))
        if not ff:
            break
        if ff[1] == 'LIMIT':
            out['verify_undecided'] = ff
            break
        fixed = next((r for r in reversed(removed)
                      if not FF(run([x for x in removed if x != r], vn, True))
                      and not FF(run([x for x in removed if x != r], bn))), None)
        if fixed is None:
            out['error'] = f'the smallest model fails {ff[1]} on {ff[0]} and no single rule put back fixes it'
            break
        removed.remove(fixed)
        back.append([fixed, f'put back: without it the smallest model breaks {ff[1]} on {ff[0]} in {ff[2]} steps'])
    out['greedy'], out['removed'], out['put_back'] = greedy, removed, back
    out['minimal'] = run(removed, bn, True)
    if vn:
        out['verify_result'] = run(removed, vn, True)
    rows = []
    for r in rl:
        i = r.id
        row = {'id': i, 'kind': 'guard' if isinstance(r, engine.Guard) else 'update', 'role': r.role,
               'note': r.note, 'cmp': getattr(r, 'op', None), 'pinned': i in pinned, 'kept': i not in removed,
               'alone': nec1.get(i)}
        if smart_ids is not None:
            row['fwd_only'] = i not in smart_ids
        if row['kept'] and not row['pinned']:
            per = run(removed + [i], bn)
            ff = FF(per)
            if ff is None and vn:
                per = run(removed + [i], vn, True)
                ff = FF(per)
            row['final'] = ff
            row['final_trace'] = engine._trace_of(per, ff)
        rows.append(row)
    out['rules'] = rows
    left = [r for r in rl if r.id not in removed and r.id not in pinned and
            (smart_ids is None or r.id not in smart_ids)]
    muts = []
    for r in left:
        muts.append(('drop', r.id, engine.Mutation(drop=removed + [r.id])))
    for r in left:
        if isinstance(r, engine.Guard) and r.is_cmp():
            muts.append(('flip', r.id, engine.Mutation(drop=removed, flip=[r.id])))
    for act in acts:
        live = [k for k, u in enumerate(act.updates) if u.id not in removed and u.id not in pinned]
        if smart_ids is not None and not any(act.updates[k].id not in smart_ids for k in live):
            continue
        for x in range(len(live)):
            for y in range(x + 1, len(live)):
                i, j = live[x], live[y]
                muts.append(('swap', f'{act.name}: {act.updates[i].name} <-> {act.updates[j].name}',
                             engine.Mutation(drop=removed, swap={act.name: (i, j)})))
    mrows = []
    for kind, what, m in muts:
        per = ab.per(m, bn)
        ff = FF(per)
        row = {'kind': kind, 'rule': what}
        if ff and ff[1] == 'LIMIT':
            row['caught'] = None
            row['undecided'] = ff
        elif ff:
            row['caught'] = ff
            row['trace'] = engine._trace_of(per, ff)
        else:
            vf = FF(ab.per(m, vn, True)) if vn else None
            if vf and vf[1] == 'LIMIT':
                row['caught'] = None
                row['undecided'] = vf
            elif vf:
                row['caught'] = vf
            else:
                fp = ab.per(m, bn, True)
                row['caught'] = None
                row['equivalent'] = all(fp[b]['digest'] == out['minimal'][b]['digest'] for b in bn)
        mrows.append(row)
    out['mutants'] = mrows
    out['secs'] = round(time.time() - t0)
    with open(a.out, 'w') as f:
        json.dump(out, f, indent=1, default=str)
    kept = [r['id'] for r in rows if r['kept'] and not r['pinned']]
    c = sum(1 for m in mrows if m['caught'])
    eq = sum(1 for m in mrows if m.get('equivalent'))
    log(f'{a.option}: {len(kept)} rules needed of {len(free)}; mutants {len(mrows)}, caught {c}, '
        f'equivalent {eq}; put back {back}; {out["secs"]} s')


if __name__ == '__main__':
    main()
