#!/usr/bin/env python3
"""
prerun.py: pass 1 of ablate.py (each rule dropped alone from the full design) in
several processes, written into ablate.py's cache, so ablate.py finds those runs
done and goes on with the greedy drops. Same runs, same keys, same limit.

    python3 prerun.py MODEL OPTION OUT.json [--jobs 3] [--limit N]

Each worker takes every JOBS-th rule and keeps its own cache (OUT.json.cache.wK);
at the end the caches are merged into OUT.json.cache. A rule is run on the sweep
bounds in order until one fails, then, if none failed, on the verify bounds, as
ablate.py's pass 1 does.
"""
import argparse
import json
import os
import signal
import sys
from multiprocessing import Process

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'E16-controller-loop', 'engine'))
sys.path.insert(0, HERE)
import engine   # noqa: E402
from engine import Mutation, first_fail   # noqa: E402
from ablate import load   # noqa: E402


def work(k, jobs, a):
    mod = load(a.model)
    cls = mod.OPTIONS[a.option]
    pinned = tuple(getattr(mod, 'PINNED', {}).get(a.option, ()))
    bn = [(b, mod.BOUNDS[b]) for b in mod.SWEEP]
    vn = [(b, mod.BOUNDS[b]) for b in mod.VERIFY]
    ab = engine.Ablation(cls, bn, verify=vn, limit=a.limit, cache_path=f'{a.out}.cache.w{k}')
    ids = [r.id for r in engine.rules(cls(bn[0][1]).actions())]
    if k == 0:
        ab.per(Mutation(), [b for b, _ in bn], True)
    for n, i in enumerate(ids):
        if n % jobs != k:
            continue
        ff = first_fail(ab.per(Mutation(drop=[i]), [b for b, _ in bn]))
        if ff is None and vn and i not in pinned:
            ab.per(Mutation(drop=[i]), [b for b, _ in vn], True)
        print(f'  w{k}: {i}', flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('model')
    ap.add_argument('option')
    ap.add_argument('out')
    ap.add_argument('--jobs', type=int, default=3)
    ap.add_argument('--limit', type=int, default=3_000_000)
    a = ap.parse_args()
    ps = [Process(target=work, args=(k, a.jobs, a)) for k in range(a.jobs)]
    for p in ps:
        p.start()

    def stop(*_):
        # a hold that ends (timeout) stops the workers too; their caches keep what they ran
        for p in ps:
            p.terminate()
        sys.exit(1)
    signal.signal(signal.SIGTERM, stop)
    for p in ps:
        p.join()
    if any(p.exitcode for p in ps):
        sys.exit(1)
    cache = {}
    main_path = a.out + '.cache'
    if os.path.exists(main_path):
        with open(main_path) as f:
            cache.update(dict((k, v) for k, v in json.load(f)))
    for k in range(a.jobs):
        p = f'{a.out}.cache.w{k}'
        if os.path.exists(p):
            with open(p) as f:
                cache.update(dict((x, v) for x, v in json.load(f)))
    with open(main_path + '.tmp', 'w') as f:
        json.dump(list(cache.items()), f)
    os.replace(main_path + '.tmp', main_path)
    for k in range(a.jobs):
        p = f'{a.out}.cache.w{k}'
        if os.path.exists(p):
            os.remove(p)
    print(f'prerun: {len(cache):,} runs in {main_path}')
    open(a.out + '.prerun', 'w').close()


if __name__ == '__main__':
    main()
