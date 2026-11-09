#!/usr/bin/env python3
"""
resolve20.py: settle the mutants (and the kept rules' final checks) that an
ablation left "undecided" because a bound stopped at the state limit.

    python3 resolve20.py RESULT.json [--model models/dedup.py] [--limit 2500000]
                         [--order restart,move,expire,exprst,mvexp,lost]

Why: ablate20.py runs each mutant on the bounds in SWEEP order and stops at
the first that fails or stops at the state limit. For sess-smart the
smallest model's `lost` bound needs 2,298,773 states (complete, no failure,
found under a 2.5 million limit), more than the default 1.5 million, so a
mutant run there stops at the limit before any later bound can catch it.
Running every such mutant on `lost` at 2.5 million costs about 8 minutes
each here. This script runs the small bounds first, in --order, and the big
one only for a mutant none of them catches. The rule language, the mutants
and the smallest model are unchanged; only the order the bounds are tried
in differs, and a mutant counts as caught by any bound, as before.

A mutant no bound catches is compared with the smallest model by state
digest on every bound (a run with no failure explores the same states
whether or not it stops at a first failure, so its digest is the full one).
The rows are rewritten in place, each marked 'resolved_by' this script; the
'minimal' entry of a bound that stopped at the limit is replaced by the
complete run of the same rule set from the ablation's own cache.
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
    ap.add_argument('result')
    ap.add_argument('--model', default=os.path.join(HERE, 'models', 'dedup.py'))
    ap.add_argument('--limit', type=int, default=2_500_000)
    ap.add_argument('--order', default='restart,move,expire,exprst,mvexp,lost')
    ap.add_argument('--small-only', default='', help='mutant kinds (e.g. swap) run on every bound but the last of '
                    '--order (unless that run is cached); one none of them catches stays undecided, with that reason')
    a = ap.parse_args()
    spec = importlib.util.spec_from_file_location('e20model', a.model)
    M = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(M)
    R = json.load(open(a.result))
    cls = M.OPTIONS[R['option']]
    pinned = set(R['pinned'])
    removed = list(R['removed'])
    bn, vn = list(R['bounds']), list(R['verify'])
    order = [b for b in a.order.split(',') if b in bn + vn]
    assert sorted(order) == sorted(bn + vn), (order, bn, vn)
    t0 = time.time()
    log = lambda *x: print(*x, flush=True)
    # the ablation's own cache: complete runs made under a larger limit
    main_ab = engine.Ablation(cls, [(b, M.BOUNDS[b]) for b in bn], verify=[(b, M.BOUNDS[b]) for b in vn],
                              cache_path=a.result + '.cache')
    # a fresh cache for this script's runs (the main one holds runs stopped at 1.5 million)
    ab = engine.Ablation(cls, [(b, M.BOUNDS[b]) for b in bn], verify=[(b, M.BOUNDS[b]) for b in vn],
                         limit=a.limit, vlimit=a.limit, cache_path=a.result.replace('.json', '') + '-resolve.cache')
    for b in bn:
        x = R['minimal'][b]
        if not x['complete']:
            y = main_ab.run1(engine.Mutation(drop=removed), b, False)
            if y['complete'] and not y['fail']:
                R['minimal'][b] = dict(y, resolved_by='resolve20.py: the complete run of the same rule set')
                log(f'minimal {b}: {y["states"]} states, complete (from the ablation cache)')
            else:
                y = ab.run1(engine.Mutation(drop=removed), b, True)
                R['minimal'][b] = dict(y, resolved_by=f'resolve20.py, limit {a.limit}')
                log(f'minimal {b}: {y["states"]} states, complete {y["complete"]}')
    acts = cls(M.BOUNDS[bn[0]]).actions()
    rl = engine.rules(acts)
    # the same mutants, made the same way as ablate20.py (smart options: no --from)
    left = [r for r in rl if r.id not in removed and r.id not in pinned]
    muts = {}
    for r in left:
        muts[('drop', r.id)] = engine.Mutation(drop=removed + [r.id])
    for r in left:
        if isinstance(r, engine.Guard) and r.is_cmp():
            muts[('flip', r.id)] = engine.Mutation(drop=removed, flip=[r.id])
    for act in acts:
        live = [k for k, u in enumerate(act.updates) if u.id not in removed and u.id not in pinned]
        for x in range(len(live)):
            for y in range(x + 1, len(live)):
                i, j = live[x], live[y]
                muts[('swap', f'{act.name}: {act.updates[i].name} <-> {act.updates[j].name}')] = \
                    engine.Mutation(drop=removed, swap={act.name: (i, j)})
    done = {}
    for row in R['mutants']:
        if not row.get('undecided'):
            continue
        m = muts[(row['kind'], row['rule'])]
        # a kind in --small-only skips the last bound unless that run is already in this script's cache
        last_key = json.dumps([list(m.key()[0]), list(m.key()[1]), [list(x) for x in m.key()[2]], order[-1], False])
        small = row['kind'] in a.small_only.split(',') and last_key not in ab.cache
        per = ab.per(m, order[:-1] if small else order)
        ff = FF(per)
        for k in ('undecided', 'caught', 'trace', 'equivalent'):
            row.pop(k, None)
        row['resolved_by'] = f'resolve20.py: bounds in the order {",".join(order)}, limit {a.limit}'
        if small and not ff:
            row['caught'] = None
            row['undecided'] = [order[-1], 'NOT RUN', 0, [f'not caught on {",".join(order[:-1])}; {order[-1]} not run']]
        elif ff and ff[1] == 'LIMIT':
            row['caught'] = None
            row['undecided'] = ff
        elif ff:
            row['caught'] = ff
            row['trace'] = engine._trace_of(per, ff)
        else:
            row['caught'] = None
            row['equivalent'] = all(per[b]['digest'] == R['minimal'][b]['digest'] for b in bn)
        log(f'mutant {row["kind"]} {row["rule"]}: {row.get("caught") or row.get("undecided") or ("equivalent" if row.get("equivalent") else "SURVIVED")}')
        if row['kind'] == 'drop':
            done[row['rule']] = (row.get('caught') or row.get('undecided'), per)
    for row in R['rules']:
        f = row.get('final')
        if f and f[1] == 'LIMIT' and row['id'] in done:
            ff, per = done[row['id']]
            row['final'] = ff
            row['final_trace'] = engine._trace_of(per, ff) if ff and ff[1] != 'LIMIT' else None
            row['final_resolved_by'] = 'resolve20.py (see the drop mutant of the same rule)'
    R['resolve_secs'] = round(time.time() - t0)
    with open(a.result, 'w') as f:
        json.dump(R, f, indent=1, default=str)
    c = sum(1 for m in R['mutants'] if m['caught'])
    eq = sum(1 for m in R['mutants'] if m.get('equivalent'))
    und = sum(1 for m in R['mutants'] if m.get('undecided'))
    log(f'{R["option"]}: mutants {len(R["mutants"])}, caught {c}, equivalent {eq}, undecided {und}; '
        f'resolve {R["resolve_secs"]} s')


if __name__ == '__main__':
    main()
