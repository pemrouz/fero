#!/usr/bin/env python3
"""
run.py: run grow.py on E-16's engine, as E-16's cli.py does, with a memory
cap of 4 GB per process and the peak memory printed.

    python3 models/run.py OPTION BOUND [BOUND ...] [--drop RULE] [--flip RULE]
                          [--limit N] [--all-fails] [--trace-all]

PYTHONHASHSEED is pinned to 0 (the process re-executes itself), so state
counts and digests repeat exactly.
"""
import argparse
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

CAP = int(os.environ.get('MEMCAP_MB', '4000')) * 1024 * 1024
try:
    resource.setrlimit(resource.RLIMIT_AS, (CAP, CAP))
except (ValueError, OSError):
    pass


def load():
    spec = importlib.util.spec_from_file_location('grow', os.path.join(HERE, 'grow.py'))
    mod = importlib.util.module_from_spec(spec)
    sys.modules['grow'] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('option')
    ap.add_argument('bounds', nargs='*')
    ap.add_argument('--drop', action='append', default=[])
    ap.add_argument('--flip', action='append', default=[])
    ap.add_argument('--limit', type=int, default=4_000_000)
    ap.add_argument('--all-fails', action='store_true')
    a = ap.parse_args()
    mod = load()
    cls = mod.OPTIONS[a.option]
    m = engine.Mutation(drop=a.drop, flip=a.flip)
    tag = f' [{m}]' if (a.drop or a.flip) else ''
    for b in a.bounds or mod.ALL:
        t0 = time.time()
        r = engine.explore(cls(mod.BOUNDS[b]), m, stop_first=not a.all_fails, limit=a.limit)
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024
        print(f'{a.option}{tag} {b}: {r.summary()} (peak {rss} MB)')
        for name, (nj, stuck) in sorted(r.judged.items()):
            print(f'    {name}: {nj:,} judged states, {stuck:,} cannot reach the goal')
        for p, (d, tr) in sorted(r.fail.items()):
            print(f'  {p}: shortest trace, {d} steps')
            engine.show_trace(tr)
        sys.stdout.flush()


if __name__ == '__main__':
    main()
