#!/usr/bin/env python3
"""
par.py: fill an ablation's cache in parallel, so E-16's sequential ablation
(engine.Ablation, unchanged) finds most of its runs already done.

    python3 models/par.py MODEL OPTION CACHE MODE [JOBS]

MODE
  pass1    every rule alone (pinned ones skipped), on the SWEEP bounds in
           order, stopping at the first bound that fails: what the
           ablation's pass 1 runs.
  verify1  every rule that pass 1 found not necessary alone, alone on the
           VERIFY bounds (stop at the first failure): what the ablation's
           verify pass 1 runs (VERIFY_PASS1).
  mutants  ABLATION.json given as JOBS' neighbour (env MUTANTS_FROM): the
           mutants of the smallest model in that result, on the SWEEP bounds
           and then the VERIFY bounds, as engine.Ablation.mutants runs them.

Each run is computed by engine.Ablation.run1 in a worker process, so its
cache key and its stored result are byte for byte what the ablation would
store; the parent merges them into CACHE. PYTHONHASHSEED is pinned to 0, as
engine/cli.py pins it, so state digests match.
"""
import json
import os
import sys

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

import importlib.util          # noqa: E402
import multiprocessing as mp   # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
E16 = os.path.normpath(os.path.join(HERE, '..', '..', 'E16-controller-loop'))
sys.path.insert(0, os.path.join(E16, 'engine'))
import engine                  # noqa: E402

LIMIT = int(os.environ.get('LIMIT', '900000'))
VLIMIT = int(os.environ.get('VLIMIT', '2000000'))


def load(path):
    spec = importlib.util.spec_from_file_location('model_' + os.path.basename(path)[:-3], path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


G = {}


def init(path, option):
    mod = load(path)
    G['mod'], G['cls'] = mod, mod.OPTIONS[option]


def ablation():
    mod = G['mod']
    return engine.Ablation(G['cls'], [(b, mod.BOUNDS[b]) for b in mod.SWEEP],
                           verify=[(b, mod.BOUNDS[b]) for b in mod.VERIFY], limit=LIMIT,
                           cache_path=None, vlimit=VLIMIT, verify_pass1=True)


def task(arg):
    """arg: (drop, flip, swap, bounds, full). Runs the bounds in order and
    stops at the first that fails or stops at the limit (Ablation.per)."""
    drop, flip, swap, bounds, full = arg
    ab = ablation()
    m = engine.Mutation(drop=drop, flip=flip, swap={k: tuple(v) for k, v in swap.items()})
    out = []
    for b in bounds:
        x = ab.run1(m, b, full)
        if (x['fail'] or not x['complete']) and not full:
            break
    for k, v in ab.cache.items():
        out.append((k, v))
    return out


def main():
    path, option, cache, mode = sys.argv[1:5]
    jobs = int(sys.argv[5]) if len(sys.argv) > 5 else 3
    init(path, option)
    mod = G['mod']
    pinned = set(getattr(mod, 'PINNED', {}).get(option, ()))
    rl = engine.rules(G['cls'](mod.BOUNDS[mod.SWEEP[0]]).actions())
    ids = [r.id for r in rl]
    store = {}
    if os.path.exists(cache):
        with open(cache) as f:
            for k, v in json.load(f):
                store[k] = v

    def key(drop, b, full, flip=(), swap=None):
        m = engine.Mutation(drop=drop, flip=flip, swap=swap)
        return json.dumps([list(m.key()[0]), list(m.key()[1]), [list(x) for x in m.key()[2]], b, full])

    tasks = []
    if mode == 'pass1':
        for i in ids:
            if i in pinned:
                continue
            if all(key([i], b, False) in store for b in mod.SWEEP):
                continue
            tasks.append(([i], [], {}, list(mod.SWEEP), False))
    elif mode == 'verify1':
        # RULES (a JSON list in the environment), if given: exactly these
        # rules, as the verify pass 1 runs each rule the sweep dropped (the
        # final pass can drop a rule that was necessary alone)
        only = json.loads(os.environ['RULES']) if os.environ.get('RULES') else None
        for i in ids:
            if i in pinned or (only is not None and i not in only):
                continue
            per = [store.get(key([i], b, False)) for b in mod.SWEEP]
            nec = any(x and (x['fail'] or not x['complete']) for x in per)
            if nec and only is None:
                continue
            if all(key([i], b, False) in store for b in mod.VERIFY):
                continue
            tasks.append(([i], [], {}, list(mod.VERIFY), False))
    elif mode == 'final':
        # E-16's final pass after the verify: each rule left, dropped on top
        # of REMOVED (a JSON list in the environment), on the sweep, then on
        # the verify bounds for those the sweep does not break (full=False,
        # as Ablation.run's final pass reads them)
        removed = json.loads(os.environ['REMOVED'])
        left = [i for i in ids if i not in removed and i not in pinned]
        sweep = [(removed + [i], [], {}, list(mod.SWEEP), False) for i in left
                 if not all(key(removed + [i], b, False) in store for b in mod.SWEEP)]
        run(sweep, jobs, path, option, store, cache, 'final (sweep)')

        def broke(d, bounds):
            for bb in bounds:
                x = store.get(key(d, bb, False))
                if x is None:
                    return None
                if x['fail'] or not x['complete']:
                    return True
            return False
        tasks = [(removed + [i], [], {}, list(mod.VERIFY), False) for i in left
                 if broke(removed + [i], mod.SWEEP) is False and broke(removed + [i], mod.VERIFY) is None]
        mode = 'final (verify)'
    elif mode == 'rows':
        # the final verdict rows: each rule in RULES dropped on top of
        # REMOVED, on every verify bound to its end (full), as Ablation.run
        # reads the rows of rules the sweep does not break
        removed = json.loads(os.environ['REMOVED'])
        for i in json.loads(os.environ['RULES']):
            if not all(key(removed + [i], b, True) in store for b in mod.VERIFY):
                tasks.append((removed + [i], [], {}, list(mod.VERIFY), True))
    elif mode == 'mutants':
        res = json.load(open(os.environ['MUTANTS_FROM']))
        removed = res['removed']
        acts = G['cls'](mod.BOUNDS[mod.SWEEP[0]]).actions()
        rl2 = [r for r in engine.rules(acts) if r.id not in removed]
        muts = []
        for r in rl2:
            if r.id not in pinned:
                muts.append((removed + [r.id], [], {}))
        for r in rl2:
            if isinstance(r, engine.Guard) and r.is_cmp() and r.id not in pinned:
                muts.append((removed, [r.id], {}))
        for a in acts:
            live = [k for k, u in enumerate(a.updates) if u.id not in removed and u.id not in pinned]
            for x in range(len(live)):
                for y in range(x + 1, len(live)):
                    muts.append((removed, [], {a.name: [live[x], live[y]]}))
        def needed(d, fl, sw, bounds, full):
            # as Ablation.per: bounds in order, stop at the first that
            # fails or stops at the limit (unless full); run only if some
            # bound it would read is not stored yet
            for bb in bounds:
                k = key(d, bb, full, fl, {kk: tuple(v) for kk, v in sw.items()})
                if k not in store:
                    return True
                x = store[k]
                if (x['fail'] or not x['complete']) and not full:
                    return False
            return False
        def caught(d, fl, sw):
            for bb in mod.SWEEP:
                x = store.get(key(d, bb, False, fl, {kk: tuple(v) for kk, v in sw.items()}))
                if x is None:
                    return None
                if x['fail'] or not x['complete']:
                    return True
            return False
        # first the sweep for every mutant; then the verify bounds only for
        # the mutants the sweep did not catch (as Ablation.mutants)
        sweep = [(d, fl, sw, list(mod.SWEEP), False) for d, fl, sw in muts
                 if needed(d, fl, sw, list(mod.SWEEP), False)]
        run(sweep, jobs, path, option, store, cache, 'mutants (sweep)')
        tasks = [(d, fl, sw, list(mod.VERIFY), True) for d, fl, sw in muts
                 if caught(d, fl, sw) is False and needed(d, fl, sw, list(mod.VERIFY), True)]
        mode = 'mutants (verify)'
    run(tasks, jobs, path, option, store, cache, mode)


def run(tasks, jobs, path, option, store, cache, mode):
    print(f'{mode}: {len(tasks)} tasks, {jobs} workers', flush=True)
    done = 0
    if tasks:
        with mp.Pool(jobs, initializer=init, initargs=(path, option)) as pool:
            for out in pool.imap_unordered(task, tasks):
                for k, v in out:
                    store[k] = v
                done += 1
                if done % 5 == 0 or done == len(tasks):
                    tmp = cache + '.tmp'
                    with open(tmp, 'w') as f:
                        json.dump(list(store.items()), f)
                    os.replace(tmp, cache)
                    print(f'  {done}/{len(tasks)}', flush=True)
    tmp = cache + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(list(store.items()), f)
    os.replace(tmp, cache)


if __name__ == '__main__':
    main()
