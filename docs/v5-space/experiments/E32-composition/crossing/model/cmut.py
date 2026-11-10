#!/usr/bin/env python3
"""
cmut.py: DEV-10 (d)'s mutants of the composed model, made by script from the
model's rules, never hand-picked:
  G  drop each guard conjunct
  C  flip each comparison (< to <=, <= to <, > to >=, >= to >)
  U  drop each state update
  S  swap each pair of updates inside one action

Two stages, both resumable (a JSON checkpoint) and run in pieces under the
heavy lock.

1. THE DIFFERENTIAL PASS, one exploration of the unmutated model per bound.
   In every reachable state, for every action and every binding, each
   mutant's version of that action is evaluated beside the model's own. A
   mutant DIFFERS on a bound if somewhere it takes a step the model does
   not, or does not take one the model does, or lands elsewhere. A mutant
   that differs nowhere has the model's own steps in every reachable state,
   so (by induction over the search) it reaches exactly the same states: it
   is EQUIVALENT on that bound. This replaces E-17's test (run the mutant in
   full and compare the digest of its state set) with the same verdict at a
   fraction of the cost: one pass settles every equivalent mutant at once.
2. THE RUNS. Each mutant that differs is run alone on the bounds where it
   differs, cheapest first, stopping at the first broken property (safety
   or liveness). It is
     caught      a property breaks;
     ill-formed  the model cannot be evaluated (a dropped guard kept a read
                 in range): reported apart, as E-15 did;
     undecided   a run stopped at the state limit with no counterexample;
     survived    every such bound runs to the end and nothing breaks.

    python3 model/cmut.py --out results/mutants.json [--budget 1500] [--jobs 2]
    python3 model/cmut.py --out results/mutants.json --report
    python3 model/cmut.py --out X.json --base-drop RULE,RULE   # mutants of a smaller model
"""

import argparse
import json
import multiprocessing as mp
import os
import sys
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from cworld import CWorld, CDraft                    # noqa: E402
from cexplore import explore                         # noqa: E402
from cbounds import BOUNDS, SWEEP                    # noqa: E402
from crossing import Crossing                        # noqa: E402
from dsl import Mutation, rules, FLIP                # noqa: E402

LIMIT = 1_500_000
ERRS = (TypeError, IndexError, KeyError, ValueError, AttributeError)


def make_mutants(base_drop=()):
    """Every one-rule mutant of the model (with base_drop already dropped)."""
    acts = Crossing(BOUNDS[SWEEP[0]]).actions()
    out = []
    for a in acts:
        for g in a.guards:
            if g.id not in base_drop:
                out.append(('G', g.id))
    for a in acts:
        for g in a.guards:
            if g.id not in base_drop and g.is_cmp():
                out.append(('C', g.id))
    for a in acts:
        for u in a.updates:
            if u.id not in base_drop:
                out.append(('U', u.id))
    for a in acts:
        live = [k for k, u in enumerate(a.updates) if u.id not in base_drop]
        for x in range(len(live)):
            for y in range(x + 1, len(live)):
                out.append(('S', f'{a.name}:{a.updates[live[x]].name}<->{a.updates[live[y]].name}'))
    return out


def mutation_of(mid, base_drop=()):
    kind, what = mid
    if kind in ('G', 'U'):
        return Mutation(drop=list(base_drop) + [what])
    if kind == 'C':
        return Mutation(drop=base_drop, flip=[what])
    aname, pair = what.split(':')
    x, y = pair.split('<->')
    for a in Crossing(BOUNDS[SWEEP[0]]).actions():
        if a.name == aname:
            names = [u.name for u in a.updates]
            return Mutation(drop=base_drop, swap={aname: (names.index(x), names.index(y))})
    raise KeyError(mid)


# ------------------------------------------------------------------ stage 1
def _apply(w, a, s, b, us):
    d = CDraft(w, s)
    for u in us:
        u.fn(w, s, b, d)
    if d.capped:
        return 'CAP'
    t = d.freeze()
    if t == s:
        return None
    if a.name == 'snap':
        t = t[:6] + ((s[6][0], s[6][1] + 1), t[7])
    return t


def _scan(vals, skip=None, repl=None):
    """The guards' verdict, evaluated in order as the world does: False at
    the first false guard, 'ERR' if a guard that cannot be evaluated comes
    before any false one, else True."""
    for k, v in enumerate(vals):
        if k == skip:
            continue
        if repl is not None and k == repl[0]:
            v = repl[1]
        if v == 'ERR':
            return 'ERR'
        if v is False:
            return False
    return True


def diff_pass(args):
    bname, base_drop = args
    base_drop = frozenset(base_drop)
    t0 = time.time()
    w = CWorld(Crossing, BOUNDS[bname], Mutation(drop=base_drop))
    acts = []
    for a in w.actions:
        gs = [g for g in a.guards if g.id not in base_drop]
        us = [u for u in a.updates if u.id not in base_drop]
        acts.append((a, gs, us))
    differs = {}                  # mutant id (as a string) -> where it first differs
    init = w.init()
    seen = {init}
    todo = [init]
    i = 0
    rep = w.rep
    while i < len(todo):
        s = todo[i]
        i += 1
        for lab, kind, t in w.succ(s):
            if t not in seen:
                seen.add(t)
                todo.append(t)
        for a, gs, us in acts:
            for b in a.params(w, s):
                if rep and a.name != 'read' and not w.leads(s, b['g']):
                    continue
                vals = []
                for g in gs:
                    try:
                        vals.append(bool(g.test(w, s, b)))
                    except ERRS:
                        vals.append('ERR')
                base_en = _scan(vals) is True
                base_t = _apply(w, a, s, b, us) if base_en else None
                where = [i - 1, a.name, [str(x) for x in a.label(b)]]
                # G: drop a guard (it matters only where that guard is false)
                for k, g in enumerate(gs):
                    if vals[k] is not False:
                        continue
                    key = 'G ' + g.id
                    if key in differs:
                        continue
                    res = _scan(vals, skip=k)
                    if res == 'ERR':
                        differs[key] = where + ['ERR']
                    elif res is True:
                        try:
                            if _apply(w, a, s, b, us) is not None:
                                differs[key] = where
                        except ERRS:
                            differs[key] = where + ['ERR']
                # C: flip a comparison
                for k, g in enumerate(gs):
                    if not g.is_cmp() or vals[k] == 'ERR':
                        continue
                    key = 'C ' + g.id
                    if key in differs:
                        continue
                    fv = bool(g.test(w, s, b, FLIP[g.op]))
                    if fv == vals[k]:
                        continue
                    res = _scan(vals, repl=(k, fv))
                    if res == 'ERR':
                        differs[key] = where + ['ERR']
                    elif res != base_en:
                        # exactly one of the two takes the step
                        try:
                            t = base_t if base_en else _apply(w, a, s, b, us)
                        except ERRS:
                            differs[key] = where + ['ERR']
                            continue
                        if t is not None:
                            differs[key] = where
                if not base_en:
                    continue
                # U: drop an update
                for k, u in enumerate(us):
                    key = 'U ' + u.id
                    if key in differs:
                        continue
                    try:
                        t = _apply(w, a, s, b, us[:k] + us[k + 1:])
                    except ERRS:
                        differs[key] = where + ['ERR']
                        continue
                    if t != base_t:
                        differs[key] = where
                # S: swap two updates
                n = len(us)
                for x in range(n):
                    for y in range(x + 1, n):
                        key = f'S {a.name}:{us[x].name}<->{us[y].name}'
                        if key in differs:
                            continue
                        us2 = list(us)
                        us2[x], us2[y] = us2[y], us2[x]
                        try:
                            t = _apply(w, a, s, b, us2)
                        except ERRS:
                            differs[key] = where + ['ERR']
                            continue
                        if t != base_t:
                            differs[key] = where
    return bname, {'states': len(todo), 'secs': round(time.time() - t0, 1), 'differs': differs}


# ------------------------------------------------------------------ stage 2
def run_mutant(args):
    mid, bounds, base_drop = args
    m = mutation_of(tuple(mid), tuple(base_drop))
    per = {}
    verdict = 'survived'
    for b in bounds:
        t0 = time.time()
        try:
            w = CWorld(Crossing, BOUNDS[b], m)
            r = explore(w, stop_first=True, liveness=True, limit=LIMIT)
        except ERRS as e:
            per[b] = {'error': f'{type(e).__name__}: {e}'[:200], 'secs': round(time.time() - t0, 1)}
            verdict = 'ill-formed'
            break
        x = {'states': r.states, 'secs': round(r.secs, 1), 'complete': r.complete}
        if r.fail:
            p = min(r.fail, key=lambda k: r.fail[k][0])
            x['fail'] = [p, r.fail[p][0], sorted(r.fail)]
            x['trace'] = [' '.join(map(str, lab)) for lab in r.fail[p][1]][:60]
            per[b] = x
            verdict = 'caught'
            break
        per[b] = x
        if not r.complete:
            verdict = 'undecided'
    return mid, {'verdict': verdict, 'per': per}


# ------------------------------------------------------------------ driver
def load(path):
    if os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    return {'diff': {}, 'runs': {}}


def save(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def key_of(mid):
    return f'{mid[0]} {mid[1]}'


def classify(ck, muts, sweep):
    rows = []
    for mid in muts:
        k = key_of(mid)
        dif = [b for b in sweep if k in ck['diff'].get(b, {}).get('differs', {})]
        if not all(b in ck['diff'] for b in sweep):
            rows.append((mid, 'pending', dif, None))
        elif not dif:
            rows.append((mid, 'equivalent', dif, None))
        elif k in ck['runs']:
            rows.append((mid, ck['runs'][k]['verdict'], dif, ck['runs'][k]))
        else:
            rows.append((mid, 'pending', dif, None))
    return rows


def report(ck, muts, sweep, out=sys.stdout):
    rows = classify(ck, muts, sweep)
    kinds = {'G': 'drop a guard conjunct', 'C': 'flip a comparison', 'U': 'drop a state update',
             'S': 'swap two updates'}
    cols = ('caught', 'ill-formed', 'undecided', 'survived', 'equivalent', 'pending')
    print('| Kind | Made | ' + ' | '.join(cols) + ' |', file=out)
    print('|---|---|' + '---|' * len(cols), file=out)
    tot = {c: 0 for c in cols}
    for k in 'GCUS':
        sub = [r for r in rows if r[0][0] == k]
        cnt = {c: sum(1 for r in sub if r[1] == c) for c in cols}
        for c in cols:
            tot[c] += cnt[c]
        print(f'| {k}: {kinds[k]} | {len(sub)} | ' + ' | '.join(str(cnt[c]) for c in cols) + ' |', file=out)
    print(f'| **all** | **{len(rows)}** | ' + ' | '.join(f'**{tot[c]}**' for c in cols) + ' |', file=out)
    change = len(rows) - tot['equivalent'] - tot['pending']
    if change:
        print(f'\nCaught: {tot["caught"]} of the {change} that change a step somewhere '
              f'({100 * tot["caught"] / change:.0f}%); counting ill-formed as found too: '
              f'{tot["caught"] + tot["ill-formed"]} ({100 * (tot["caught"] + tot["ill-formed"]) / change:.0f}%).',
              file=out)
    print('\n| Mutant | Verdict | Where | Differs on |', file=out)
    print('|---|---|---|---|', file=out)
    for mid, v, dif, run in rows:
        where = ''
        if run and v == 'caught':
            b = list(run['per'])[-1]
            f = run['per'][b]['fail']
            where = f'{f[0]} on `{b}` in {f[1]} steps'
        elif run and v == 'ill-formed':
            b = list(run['per'])[-1]
            where = f'on `{b}`: {run["per"][b]["error"][:70]}'
        elif run and v == 'undecided':
            where = 'state limit on ' + ', '.join(f'`{b}`' for b, x in run['per'].items() if not x.get('complete', True))
        print(f'| {mid[0]} `{mid[1]}` | {v} | {where} | {len(dif)} of {len(sweep)} |', file=out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--budget', type=float, default=1500)
    ap.add_argument('--jobs', type=int, default=2)
    ap.add_argument('--report', action='store_true')
    ap.add_argument('--base-drop', default='')
    ap.add_argument('--sweep', default='')
    a = ap.parse_args()
    base_drop = tuple(x for x in a.base_drop.split(',') if x)
    sweep = tuple(a.sweep.split(',')) if a.sweep else SWEEP
    muts = make_mutants(base_drop)
    ck = load(a.out)
    ck['base_drop'] = list(base_drop)
    ck['sweep'] = list(sweep)
    if a.report:
        report(ck, muts, sweep)
        return
    t0 = time.time()
    with mp.Pool(a.jobs) as pool:
        todo = [(b, base_drop) for b in sweep if b not in ck['diff']]
        for bname, res in pool.imap_unordered(diff_pass, todo):
            ck['diff'][bname] = res
            save(a.out, ck)
            print(f'  differential pass on {bname}: {res["states"]:,} states, {res["secs"]}s, '
                  f'{len(res["differs"])} mutants differ', flush=True)
        if not all(b in ck['diff'] for b in sweep):
            print('differential pass not finished')
            sys.exit(3)

        def tasks():
            for mid in muts:
                k = key_of(mid)
                if k in ck['runs']:
                    continue
                dif = [b for b in sweep if k in ck['diff'][b]['differs']]
                if not dif:
                    continue
                if time.time() - t0 > a.budget:
                    return
                yield (list(mid), dif, list(base_drop))
        n = 0
        for mid, res in pool.imap_unordered(run_mutant, tasks()):
            ck['runs'][key_of(mid)] = res
            n += 1
            save(a.out, ck)
            print(f'  {key_of(mid):44} {res["verdict"]}', flush=True)
    rows = classify(ck, muts, sweep)
    left = sum(1 for r in rows if r[1] == 'pending')
    print(f'{len(rows)} mutants; {left} still to run')
    sys.exit(3 if left else 0)


if __name__ == '__main__':
    main()
