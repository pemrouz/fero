#!/usr/bin/env python3
"""
walk.py: seeded random runs of grow.py on bounds too big to explore whole
(five machines, two crashes, two leaves, a retire, writes). Each seed walks
the model's own steps at random; every state and every step is checked
against every safety property. At the end of a walk, if a liveness goal is
judged there, a breadth-first search over calm steps from that state (up to
a state limit) must reach it; a search that hits the limit is undecided.
A leave is usually over before a walk ends, so SF is also judged in the
middle of a walk: at the first state with a leaver up and no machine down,
and at the first with a leaver up and a machine down. The reported goals
(SWF, POST) are searched at the first state where each is judged, and
counted, not failed.

    python3 models/walk.py OPTION WBOUND [--seeds 1000] [--depth 80] [--drop RULE] [--first 0]

Same seed, same walk (PYTHONHASHSEED pinned). Prints one summary line, and
the first failing seed with its trace.
"""
import argparse
import os
import random
import resource
import sys
from collections import deque

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

spec = importlib.util.spec_from_file_location('grow', os.path.join(HERE, 'grow.py'))
G = importlib.util.module_from_spec(spec)
sys.modules['grow'] = G
spec.loader.exec_module(G)

# Bounds for walks: bigger than any explored bound.
WBOUNDS = {
    # founded by 0 alone; four more machines (growth with spares, picks)
    'w5g': dict(n=5, voters=(0,), place=(0,), maxt=9, faults=2, leaves=2, retires=1, writes=2, churn=20, maxlog=60),
    # three voters and two spares
    'w5s': dict(n=5, voters=(0, 1, 2), maxt=9, faults=2, leaves=2, retires=1, writes=2, churn=20, maxlog=60),
    # three voters, no spare: two leaves and two crashes
    'w3': dict(n=3, voters=(0, 1, 2), maxt=9, faults=2, leaves=2, retires=1, writes=2, churn=20, maxlog=60),
    # two machines: the founder's leave with two crashes
    'w2': dict(n=2, voters=(0,), learners=(1,), place=(0,), maxt=9, faults=2, leaves=1, writes=2, churn=20, maxlog=60),
}
LIVE = ('P5', 'HF', 'LW', 'SF', 'DL', 'RC', 'GF')
INFO = ('SWF', 'POST')


def calm_search(model, comp, s, goal, limit):
    seen = {s}
    q = deque([s])
    while q:
        x = q.popleft()
        if model.goals(x)[goal]:
            return True
        for lab, kind, t in comp.succ(x):
            if kind in model.CALM and t not in seen:
                seen.add(t)
                if len(seen) > limit:
                    return None
                q.append(t)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('option')
    ap.add_argument('bound')
    ap.add_argument('--seeds', type=int, default=1000)
    ap.add_argument('--first', type=int, default=0)
    ap.add_argument('--depth', type=int, default=80)
    ap.add_argument('--drop', action='append', default=[])
    ap.add_argument('--flip', action='append', default=[])
    ap.add_argument('--climit', type=int, default=60000)
    a = ap.parse_args()
    bd = WBOUNDS.get(a.bound) or G.BOUNDS[a.bound]
    model = G.OPTIONS[a.option](bd)
    m = engine.Mutation(drop=a.drop, flip=a.flip)
    comp = engine.Compiled(model, m)
    fails = {}
    first = None
    judged = {g: 0 for g in LIVE}
    undecided = 0
    steps = 0
    mid = {'SF, no machine down': 0, 'SF, a machine down': 0}
    info = {g: [0, 0] for g in INFO}
    for seed in range(a.first, a.first + a.seeds):
        rng = random.Random(seed)
        s = model.init()
        tr = []
        bad = None
        done = set()
        for _ in range(a.depth):
            succ = comp.succ(s)
            if not succ:
                break
            lab, kind, t = succ[rng.randrange(len(succ))]
            tr.append(lab)
            steps += 1
            p = model.check_edge(s, lab, kind, t) + model.check(t)
            if comp.err:
                p.append('ERR')
                comp.err = None
            s = t
            if p:
                bad = p
                break
            j = model.judged(s)
            if j.get('SF'):
                k = 'SF, a machine down' if any(x == G.DOWN for x in s[G.ST]) else 'SF, no machine down'
                if k not in done:
                    done.add(k)
                    mid[k] += 1
                    r = calm_search(model, comp, s, 'SF', a.climit)
                    if r is None:
                        undecided += 1
                    elif not r:
                        bad = ['SF']
                        break
            for g in INFO:
                if j.get(g) and g not in done:
                    done.add(g)
                    r = calm_search(model, comp, s, g, a.climit)
                    if r is None:
                        undecided += 1
                    else:
                        info[g][0] += 1
                        info[g][1] += (not r)
        if bad is None:
            j = model.judged(s)
            for g in LIVE:
                if j.get(g):
                    judged[g] += 1
                    r = calm_search(model, comp, s, g, a.climit)
                    if r is None:
                        undecided += 1
                    elif not r:
                        bad = [g]
                        break
        if bad:
            for p in bad:
                fails[p] = fails.get(p, 0) + 1
            if first is None:
                first = (seed, bad, tr)
    tag = f' [{m}]' if (a.drop or a.flip) else ''
    print(f'{a.option}{tag} {a.bound}: {a.seeds} seeds, {steps:,} steps, depth {a.depth}; '
          f'failing seeds by property: {fails or "none"}; liveness judged at the end: '
          + ', '.join(f'{g} {n}' for g, n in judged.items() if n)
          + '; SF judged mid-walk: ' + ', '.join(f'{k} {n}' for k, n in mid.items())
          + '; reported (walks judged, stuck): ' + ', '.join(f'{g} {x[0]}, {x[1]}' for g, x in info.items())
          + f'; undecided searches {undecided}')
    if first:
        seed, bad, tr = first
        print(f'  first failing seed {seed}: {bad}, {len(tr)} steps')
        engine.show_trace(tr)
    sys.stdout.flush()


if __name__ == '__main__':
    main()
