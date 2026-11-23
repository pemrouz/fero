#!/usr/bin/env python3
"""
ablate.py: DEV-10's count for one option of grow.py, by E-16's procedure
(E-17's runner.py), with the independent runs spread over worker processes.

    python3 models/ablate.py OPTION OUT.json [--jobs 3] [--limit 2000000] [--no-mutants] [--cache PATH]

The procedure, as E-16's engine.Ablation runs it (no verify bounds here):
  1. the design on every SWEEP bound must hold every property;
  2. pass 1: each design rule dropped alone, the SWEEP bounds in order,
     stopping at the first that fails, and then, for a rule the sweep does not
     need, the VERIFY bounds (E-16's verify pass 1); the same for each
     Raft-core rule (pinned in the ablation, reported apart: it shows the
     safety properties catch it);
  3. greedy: in model-text order, each rule pass 1 did not keep is dropped
     on top of those dropped before, if every bound still holds;
  4. final pass: every rule left is dropped once more on top of the smallest
     model; one whose removal breaks nothing is dropped too (repeat), so the
     set left is 1-minimal on the sweep; then the smallest model runs on the
     VERIFY bounds, and while it fails the rule whose return fixes it is put
     back, last dropped first (E-17), and the final pass runs again on every
     bound;
  5. mutants of the smallest model: drop each kept rule, flip each kept
     comparison, swap each pair of kept updates in one action. A mutant that
     breaks no property on any bound is equivalent if its reachable state
     set has the smallest model's digest on every bound, else it survived.
A run that stops at the state limit with no counterexample is undecided; in
steps 3 and 4 it counts as a failure (the rule is kept), as in E-16.

Every run is cached in OUT.json.cache (JSON lines keyed by the option, the
model file's hash, the mutation and the bound), so a stopped ablation resumes.
"""
import argparse
import hashlib
import json
import multiprocessing as mp
import os
import resource
import sys
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.normpath(os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine')))
import engine  # noqa: E402
import importlib.util  # noqa: E402

MODEL = os.path.join(HERE, 'grow.py')
MHASH = hashlib.sha256(open(MODEL, 'rb').read()).hexdigest()[:16]
CAP = int(os.environ.get('MEMCAP_MB', '4000')) * 1024 * 1024
G = {}


def load():
    spec = importlib.util.spec_from_file_location('grow', MODEL)
    mod = importlib.util.module_from_spec(spec)
    sys.modules['grow'] = mod
    spec.loader.exec_module(mod)
    return mod


def winit(option, limit):
    try:
        resource.setrlimit(resource.RLIMIT_AS, (CAP, CAP))
    except (ValueError, OSError):
        pass
    G['mod'] = load()
    G['cls'] = G['mod'].OPTIONS[option]
    G['option'], G['limit'] = option, limit


def mkey(m):
    return json.dumps([sorted(m.drop), sorted(m.flip), sorted([k, list(v)] for k, v in m.swap.items())])


def to_mut(k):
    d, f, s = json.loads(k)
    return engine.Mutation(drop=d, flip=f, swap={a: tuple(v) for a, v in s})


def run_one(arg):
    """One (mutation, bound) run in a worker."""
    k, b = arg
    m = to_mut(k)
    try:
        r = engine.explore(G['cls'](G['mod'].BOUNDS[b]), m, stop_first=True, limit=G['limit'])
        out = {'states': r.states, 'complete': r.complete, 'secs': round(r.secs, 1),
               'fail': {p: [d, [' '.join(str(x) for x in lab) if isinstance(lab, tuple) else str(lab)
                                for lab in tr][:60]] for p, (d, tr) in r.fail.items()},
               'digest': list(r.digest), 'judged': r.judged}
    except MemoryError:
        out = {'states': -1, 'complete': False, 'secs': 0, 'fail': {}, 'digest': None, 'judged': {}, 'mem': True}
    return (k, b, out)


class Cache:
    def __init__(self, path, option):
        self.path, self.option = path, option
        self.d = {}
        if os.path.exists(path):
            for line in open(path):
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if o['h'] == MHASH and o['o'] == option:
                    self.d[(o['k'], o['b'])] = o['r']
        self.f = open(path, 'a')

    def get(self, k, b):
        return self.d.get((k, b))

    def put(self, k, b, r):
        self.d[(k, b)] = r
        self.f.write(json.dumps({'h': MHASH, 'o': self.option, 'k': k, 'b': b, 'r': r}) + '\n')
        self.f.flush()


def first_fail(per, bounds):
    for b in bounds:
        x = per.get(b)
        if x is None:
            continue
        if x['fail']:
            p = min(x['fail'], key=lambda q: x['fail'][q][0])
            return [b, p, x['fail'][p][0], sorted(x['fail'])]
        if not x['complete']:
            return [b, 'LIMIT', x['states'], ['LIMIT']]
    return None


class Runner:
    def __init__(self, option, cache, pool, bounds):
        self.option, self.cache, self.pool, self.bounds = option, cache, pool, bounds

    def many(self, muts, ordered=True, bounds=None):
        """Run each mutation over the bounds. ordered: bound by bound, a
        mutation stops at its first failing bound (as E-16's per()); else
        every bound of every mutation is run. Returns {key: {bound: result}}."""
        bounds = list(bounds or self.bounds)
        keys = [mkey(m) for m in muts]
        res = {k: {} for k in keys}
        if not ordered:
            todo = [(k, b) for k in keys for b in bounds if self.cache.get(k, b) is None]
            for k, b, r in self.pool.imap_unordered(run_one, todo):
                self.cache.put(k, b, r)
            for k in keys:
                for b in bounds:
                    res[k][b] = self.cache.get(k, b)
            return res
        live = list(keys)
        for b in bounds:
            todo = [(k, b) for k in live if self.cache.get(k, b) is None]
            for k, bb, r in self.pool.imap_unordered(run_one, todo):
                self.cache.put(k, bb, r)
            nxt = []
            for k in live:
                r = self.cache.get(k, b)
                res[k][b] = r
                if not r['fail'] and r['complete']:
                    nxt.append(k)
            live = nxt
        return res

    def ff(self, m, bounds=None, ordered=True):
        k = mkey(m)
        bounds = list(bounds or self.bounds)
        return first_fail(self.many([m], ordered=ordered, bounds=bounds)[k], bounds)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('option')
    ap.add_argument('out')
    ap.add_argument('--jobs', type=int, default=3)
    ap.add_argument('--limit', type=int, default=2_000_000)
    ap.add_argument('--no-mutants', action='store_true')
    ap.add_argument('--cache', default=None, help='the run cache (default: OUT.cache)')
    a = ap.parse_args()
    mod = load()
    cls = mod.OPTIONS[a.option]
    bounds = list(os.environ['E59_SWEEP'].split()) if os.environ.get('E59_SWEEP') else list(mod.SWEEP)
    vb = list(os.environ['E59_VERIFY'].split()) if os.environ.get('E59_VERIFY') else list(getattr(mod, 'VERIFY', ()))
    allb = bounds + vb
    acts = cls(mod.BOUNDS[bounds[0]]).actions()
    rl = engine.rules(acts)
    ids = [r.id for r in rl]
    pinned = set(mod.PINNED[a.option])
    core = [r.id for r in rl if r.id in pinned and r.role == 'raft']
    design = [i for i in ids if i not in pinned]
    t0 = time.time()
    cache = Cache(a.cache or (a.out + '.cache'), a.option)
    pool = mp.Pool(a.jobs, initializer=winit, initargs=(a.option, a.limit))
    R = Runner(a.option, cache, pool, bounds)
    log = lambda s: (print(f'[{time.time() - t0:7.0f}s] {s}'), sys.stdout.flush())
    out = {'option': a.option, 'bounds': bounds, 'verify': vb, 'model_hash': MHASH, 'limit': a.limit}
    M = engine.Mutation
    K = lambda drop: mkey(M(drop=drop))

    base = R.many([M()], ordered=False, bounds=allb)[mkey(M())]
    out['base'] = base
    if first_fail(base, allb):
        out['error'] = f'the design fails: {first_fail(base, allb)}'
        json.dump(out, open(a.out, 'w'), indent=1)
        log(out['error'])
        return
    log(f'design holds on {len(allb)} bounds; {len(design)} design rules, {len(core)} Raft-core rules')

    # pass 1: each rule alone on the sweep; a rule the sweep does not need is
    # also tried alone on the verify bounds (E-16's verify pass 1)
    p1 = R.many([M(drop=[i]) for i in design + core])
    alone = {i: first_fail(p1[K([i])], bounds) for i in design + core}
    rest1 = [i for i in design + core if not alone[i]]
    pv = R.many([M(drop=[i]) for i in rest1], bounds=vb)
    valone = {i: first_fail(pv[K([i])], vb) for i in rest1}
    for i in rest1:
        if valone[i] and valone[i][1] != 'LIMIT':
            alone[i] = valone[i]
    log(f'pass 1: {sum(1 for i in design if alone[i])} of {len(design)} design rules necessary alone '
        f'(sweep and verify); {sum(1 for i in core if alone[i])} of {len(core)} core rules caught')

    if os.environ.get('E59_PASS1_ONLY'):
        # E59_PASS1_ONLY=1: stop after pass 1 (pass1.py prints it from the cache)
        out['pass1'] = {i: alone[i] for i in design + core}
        out['design'], out['core'] = design, core
        json.dump(out, open(a.out, 'w'), indent=1)
        log('stopped after pass 1 (E59_PASS1_ONLY)')
        return

    removed, greedy = [], []
    for i in design:
        if alone[i]:
            continue
        f = R.ff(M(drop=removed + [i]), ordered=False)
        if f is None:
            removed.append(i)
            greedy.append([i, 'dropped'])
        else:
            greedy.append([i, f'kept: with the others dropped it breaks {f[1]} on {f[0]} in {f[2]} steps'])
        log(f'greedy {i}: {greedy[-1][1]}')

    def final_pass(bl, note):
        nonlocal removed
        while True:
            rest = [i for i in design if i not in removed]
            res = R.many([M(drop=removed + [i]) for i in rest], bounds=bl)
            extra = [i for i in rest if first_fail(res[K(removed + [i])], bl) is None]
            if not extra:
                return
            removed.append(extra[0])
            greedy.append([extra[0], note])
            log(f'{note}: {extra[0]}')

    final_pass(bounds, 'dropped in the final pass')
    # verify: the smallest model on the verify bounds; while it fails, put back
    # the rule whose return makes every bound pass, last dropped first (E-17)
    back = []
    # E59_NO_PUTBACK=1: skip the put-back (each trial reruns the verify bounds
    # one rule at a time, hours here); the smallest model is then 1-minimal on
    # the sweep only, and its verify result is reported
    while vb and not os.environ.get('E59_NO_PUTBACK'):
        f = R.ff(M(drop=removed), bounds=vb)
        if not f:
            break
        if f[1] == 'LIMIT':
            out['verify_undecided'] = f
            break
        fixed = None
        for r in reversed(removed):
            trial = [x for x in removed if x != r]
            if not R.ff(M(drop=trial), bounds=vb) and not R.ff(M(drop=trial)):
                fixed = r
                break
        if fixed is None:
            # no single rule fixes it: put back the last rule dropped and try again
            fixed = removed[-1]
            note = (f'put back (no single rule fixed it; the last dropped comes back): the smallest model '
                    f'breaks {f[1]} on {f[0]} in {f[2]} steps')
        else:
            note = f'put back: without it the smallest model breaks {f[1]} on {f[0]} in {f[2]} steps'
        removed = [x for x in removed if x != fixed]
        back.append([fixed, note])
        greedy.append(back[-1])
        log(back[-1][0] + ': ' + back[-1][1])
    if back:
        final_pass(allb, 'dropped in the final pass after the verify')
    minimal = R.many([M(drop=removed)], ordered=False, bounds=allb)[K(removed)]
    out['minimal'] = minimal
    out['minimal_verify'] = first_fail(minimal, vb) if vb else None
    if out['minimal_verify']:
        log(f'the smallest model on the verify bounds: breaks {out["minimal_verify"][1]} on '
            f'{out["minimal_verify"][0]} (no put-back run); mutants are judged on the sweep')
    mb = bounds if out['minimal_verify'] else allb
    out['removed'] = removed
    out['greedy'] = greedy
    out['put_back'] = back
    rows = []
    fin = R.many([M(drop=removed + [i]) for i in design if i not in removed], bounds=allb)
    for r in rl:
        i = r.id
        row = {'id': i, 'kind': 'guard' if isinstance(r, engine.Guard) else 'update', 'role': r.role,
               'note': r.note, 'pinned': i in pinned, 'core': i in core}
        if i in design or i in core:
            row['alone'] = alone[i]
            if alone[i] and alone[i][1] != 'LIMIT':
                src = p1[K([i])] if alone[i][0] in bounds else pv[K([i])]
                row['alone_trace'] = src[alone[i][0]]['fail'][alone[i][1]][1]
        if i in design:
            row['kept'] = i not in removed
            if row['kept']:
                k = K(removed + [i])
                f = first_fail(fin[k], allb)
                row['final'] = f
                if f and f[1] != 'LIMIT':
                    row['final_trace'] = fin[k][f[0]]['fail'][f[1]][1]
        rows.append(row)
    out['rules'] = rows
    kept = [i for i in design if i not in removed]
    log(f'{len(kept)} of {len(design)} design rules kept')
    json.dump(out, open(a.out, 'w'), indent=1)

    if not a.no_mutants:
        muts = []
        for i in kept:
            muts.append(('drop', i, engine.Mutation(drop=removed + [i])))
        for r in rl:
            if r.id in kept and isinstance(r, engine.Guard) and r.is_cmp():
                muts.append(('flip', r.id, engine.Mutation(drop=removed, flip=[r.id])))
        for act in acts:
            live = [x for x, u in enumerate(act.updates) if u.id in kept]
            for x in range(len(live)):
                for y in range(x + 1, len(live)):
                    p, q = live[x], live[y]
                    muts.append(('swap', f'{act.name}: {act.updates[p].name} <-> {act.updates[q].name}',
                                 engine.Mutation(drop=removed, swap={act.name: (p, q)})))
        res = R.many([m for _, _, m in muts], bounds=mb)
        mrows = []
        unc = []
        for kind, what, m in muts:
            f = first_fail(res[mkey(m)], mb)
            row = {'kind': kind, 'rule': what}
            if f and f[1] == 'LIMIT':
                row['caught'] = None
                row['undecided'] = f
            elif f:
                row['caught'] = f
            else:
                unc.append((row, m))
            mrows.append(row)
        if unc:
            full = R.many([m for _, m in unc], ordered=False, bounds=mb)
            for row, m in unc:
                per = full[mkey(m)]
                row['caught'] = None
                row['equivalent'] = all(per[b]['digest'] == minimal[b]['digest'] for b in mb)
        out['mutants'] = mrows
        c = sum(1 for r in mrows if r['caught'])
        e = sum(1 for r in mrows if not r['caught'] and r.get('equivalent'))
        u = sum(1 for r in mrows if r.get('undecided'))
        log(f'mutants: {len(mrows)}; caught {c}; equivalent {e}; undecided {u}; survived {len(mrows) - c - e - u}')
    out['secs'] = round(time.time() - t0)
    json.dump(out, open(a.out, 'w'), indent=1)
    pool.close()


if __name__ == '__main__':
    main()
