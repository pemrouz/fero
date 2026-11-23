#!/usr/bin/env python3
"""
walk.py: seeded random walks through a model, for bounds too large to explore
in full. Safety only: every state's check() and every step's check_edge().

    python3 walk.py MODEL OPTION BOUND [--walks 20000] [--depth 120] [--seed 0]

Each walk starts at init() and takes a uniformly random enabled step (the
model's own successor function, E-16's engine) until it has no step or
reaches the depth. A walk that finds a broken property prints its trace.
"""
import argparse
import importlib.util
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'E16-controller-loop', 'engine'))
import engine   # noqa: E402


def load(path):
    spec = importlib.util.spec_from_file_location('model_' + os.path.basename(path)[:-3], path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('model')
    ap.add_argument('option')
    ap.add_argument('bound')
    ap.add_argument('--walks', type=int, default=20000)
    ap.add_argument('--depth', type=int, default=120)
    ap.add_argument('--seed', type=int, default=0)
    a = ap.parse_args()
    mod = load(a.model)
    model = mod.OPTIONS[a.option](mod.BOUNDS[a.bound])
    c = engine.Compiled(model)
    steps = 0
    seen = set()
    fails = {}
    for w in range(a.walks):
        rnd = random.Random(a.seed * 1_000_003 + w)
        s = model.init()
        tr = []
        for _ in range(a.depth):
            succ = c.succ(s)
            if not succ:
                break
            lab, kind, t = rnd.choice(succ)
            tr.append(lab)
            steps += 1
            bad = model.check(t) + model.check_edge(s, lab, kind, t)
            s = t
            seen.add(t)
            if bad:
                for p in bad:
                    if p not in fails or len(tr) < len(fails[p]):
                        fails[p] = list(tr)
                break
    print(f'{a.option} {a.bound}: {a.walks:,} walks, {steps:,} steps, {len(seen):,} distinct states: '
          + (', '.join(f'{p} ({len(t)} steps)' for p, t in sorted(fails.items())) or 'no property broken'))
    for p, t in sorted(fails.items()):
        print(f'  {p}: shortest trace found, {len(t)} steps')
        engine.show_trace(t)


if __name__ == '__main__':
    main()
