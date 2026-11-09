"""
ablate.py: DEV-10 for E-21's options, on seeded runs instead of a full search.

    python3 sim/ablate.py OPTION [--seeds N] [--jobs 2] [--out results/OPTION.json]

1. The design runs on every family x seed. Its failures are reported (an
   option that fails as designed is not ablated further).
2. Pass 1: each rule dropped alone; necessary if some seed then breaks a
   check (runs stop at the first failure).
3. Greedy: the others dropped one at a time in model-text order, each kept
   dropped only if nothing breaks; a final pass drops again each rule left
   and keeps it only if that breaks something (1-minimal, as E-17's runner).
4. Mutants of the smallest set: drop each rule, flip each comparison, swap
   each pair of updates in one action. A mutant is caught if a seed breaks
   a check. One that changes no number on any seed is `no change` (the
   seeded stand-in for E-17's equivalence by state digest).

A rule here is one guard conjunct or one update of the option's actions;
the `read` updates (the clock reading itself) are the world and never
dropped.
"""
import argparse
import json
import os
import sys
import time
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import timesim as ts   # noqa: E402

PINNED = ('stamp.read',)


def _one(args):
    opt, seed, fam, mk = args
    m = ts.Mutation(drop=mk[0], flip=mk[1], swap=dict(mk[2]))
    try:
        r = ts.run_one(opt, seed, fam, m)
    except (KeyError, TypeError, ValueError, IndexError, ZeroDivisionError):
        # a mutant whose rules cannot run (for example an update moved before
        # the clock reading it needs): reported as ERR, as E-16's engine and
        # TLC report an evaluation error
        out = {k: 0 for k in ts.CHECKS + ('overlap', 'leaderless')}
        out['ERR'] = 1
        return fam, seed, out, 0.0, 0.0
    out = {k: r[k] for k in ts.CHECKS + ('overlap', 'leaderless')}
    out['ERR'] = 0
    return fam, seed, out, r['late_max'], r['early_max']


def sweep(pool, opt, seeds, m, stop):
    mk = (tuple(sorted(m.drop)), tuple(sorted(m.flip)), tuple(sorted(m.swap.items())))
    jobs = [(opt, s, f, mk) for f in ts.FAMILIES for s in range(seeds)]
    tot = {k: 0 for k in ts.CHECKS + ('overlap', 'leaderless', 'ERR')}
    tot['late_max'] = 0.0
    tot['early_max'] = 0.0
    first = None
    per = {}
    step = 8
    for c in range(0, len(jobs), step):
        for fam, seed, r, lm, em in pool.map(_one, jobs[c:c + step]):
            for k, v in r.items():
                tot[k] += v
            tot['late_max'] = max(tot['late_max'], lm)
            tot['early_max'] = max(tot['early_max'], em)
            per[f'{fam}/{seed}'] = r
            bad = [k for k in ts.CHECKS + ('ERR',) if r[k]]
            if bad and first is None:
                first = (fam, seed, bad)
        if first and stop:
            break
    tot['first'] = first
    return tot, per


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('option')
    ap.add_argument('--seeds', type=int, default=30)
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--out')
    ap.add_argument('--no-mutants', action='store_true')
    a = ap.parse_args()
    opt = ts.OPTIONS[a.option]()
    acts = opt.actions()
    rl = [r for r in ts.rules(acts) if r.id not in PINNED]
    ids = [r.id for r in rl]
    out = {'option': a.option, 'seeds_per_family': a.seeds, 'families': ts.FAMILIES,
           'rules': [{'id': r.id, 'kind': 'guard' if isinstance(r, ts.Guard) else 'update', 'role': r.role,
                      'note': r.note, 'cmp': getattr(r, 'op', None)} for r in rl]}
    t0 = time.time()
    with Pool(a.jobs) as pool:
        def run(m, stop=True):
            return sweep(pool, a.option, a.seeds, m, stop)
        base, per = run(ts.Mutation(), stop=False)
        out['base'] = base
        print(f'{a.option} design: {json.dumps(base)}', flush=True)
        if base['first']:
            out['fails_as_designed'] = base['first']
        nec = {}
        for i in ids:
            r, _ = run(ts.Mutation(drop=[i]))
            nec[i] = r['first']
            print(f'  drop {i}: {r["first"]}', flush=True)
        out['pass1'] = nec
        removed = []
        if not base['first']:
            for i in ids:
                if nec[i]:
                    continue
                r, _ = run(ts.Mutation(drop=removed + [i]))
                if not r['first']:
                    removed.append(i)
            while True:
                extra = [i for i in ids if i not in removed and not run(ts.Mutation(drop=removed + [i]))[0]['first']]
                if not extra:
                    break
                removed.append(extra[0])
        out['removed'] = removed
        kept = [i for i in ids if i not in removed]
        out['kept'] = {i: (run(ts.Mutation(drop=removed + [i]))[0]['first'] if not base['first'] else nec[i])
                       for i in kept}
        if not a.no_mutants and not base['first']:
            muts = []
            for r in rl:
                if r.id in removed:
                    continue
                muts.append(('drop', r.id, ts.Mutation(drop=removed + [r.id])))
            for r in rl:
                if r.id not in removed and isinstance(r, ts.Guard) and r.is_cmp():
                    muts.append(('flip', r.id, ts.Mutation(drop=removed, flip=[r.id])))
            for act in acts:
                live = [k for k, u in enumerate(act.updates) if u.id not in removed and u.id not in PINNED]
                for x in range(len(live)):
                    for y in range(x + 1, len(live)):
                        i, j = live[x], live[y]
                        muts.append(('swap', f'{act.name}: {act.updates[i].name} <-> {act.updates[j].name}',
                                     ts.Mutation(drop=removed, swap={act.name: (i, j)})))
            # stamp.read is pinned, but a swap that moves it is still a mutant
            for act in acts:
                if act.name == 'stamp':
                    for j, u in enumerate(act.updates):
                        if j and u.id not in removed:
                            muts.append(('swap', f'stamp: read <-> {u.name}',
                                         ts.Mutation(drop=removed, swap={'stamp': (0, j)})))
            rows = []
            minimal, mper = run(ts.Mutation(drop=removed), stop=False)
            for kind, what, m in muts:
                r, p = run(m)
                if r['first']:
                    rows.append({'kind': kind, 'rule': what, 'caught': r['first']})
                else:
                    full, fper = run(m, stop=False)
                    rows.append({'kind': kind, 'rule': what, 'caught': None, 'no_change': fper == mper})
                print(f'  mutant {kind} {what}: {rows[-1]}', flush=True)
            out['mutants'] = rows
    out['secs'] = round(time.time() - t0)
    path = a.out or os.path.join(HERE, '..', 'results', f'{a.option}-ablation.json')
    with open(path, 'w') as f:
        json.dump(out, f, indent=1, default=str)
    print(f'{a.option}: kept {len(kept)} of {len(ids)}; {out["secs"]} s', flush=True)


if __name__ == '__main__':
    main()
