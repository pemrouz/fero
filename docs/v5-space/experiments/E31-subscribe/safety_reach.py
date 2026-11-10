#!/usr/bin/env python3
"""
safety_reach.py: the safety properties (P1 to P4, P6, P7) over EVERY reachable
state of a bound that is too large for the engine's full run.

The engine (E-16's explore) keeps every state, its parent and every calm edge,
because the liveness check (P5, AG EF) needs the whole graph. That is about
600 bytes a state, so a bound of tens of millions of states does not fit.
This script keeps only a 64-bit hash of each state seen and the breadth-first
frontier, so it can finish such a bound, for the safety properties only:

    python3 safety_reach.py OPTION BOUND [--secs 1300]

It uses the same model, the same compiled rules (engine.Compiled) and the
same checks (model.check, model.check_edge). What it does not give: P5
(liveness), and a trace (it prints the broken state and the step into it).
Hashing: two different states with the same 64-bit hash would hide one of
them; for 3e7 states that chance is about 2e-5 (n^2 / 2^65).
"""
import argparse
import os
import sys
import time
from collections import deque

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', 'E16-controller-loop', 'engine'))
sys.path.insert(0, os.path.join(HERE, 'models'))
import engine      # noqa: E402
import subscribe   # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('option')
    ap.add_argument('bound')
    ap.add_argument('--secs', type=float, default=1300.0)
    a = ap.parse_args()
    model = subscribe.OPTIONS[a.option](subscribe.BOUNDS[a.bound])
    c = engine.Compiled(model, engine.Mutation())
    t0 = time.time()
    init = model.init()
    seen = {hash(init)}
    q = deque([init])
    n = 1
    edges = 0
    peak = 1
    bad = None
    if model.check(init):
        bad = (model.check(init), 'init', init)
    nxt = 1_000_000
    done = False
    while q and bad is None:
        s = q.popleft()
        for lab, kind, t in c.succ(s):
            edges += 1
            e = model.check_edge(s, lab, kind, t)
            if e:
                bad = (e, lab, t)
                break
            h = hash(t)
            if h not in seen:
                seen.add(h)
                n += 1
                f = model.check(t)
                if f:
                    bad = (f, lab, t)
                    break
                q.append(t)
        if c.err is not None:
            bad = (['ERR'], c.err, s)
        if len(q) > peak:
            peak = len(q)
        if n >= nxt:
            print(f'  {n:,} states, frontier {len(q):,}, {time.time() - t0:.0f}s', flush=True)
            nxt += 1_000_000
            if time.time() - t0 > a.secs:
                break
    else:
        done = bad is None
    secs = time.time() - t0
    if bad:
        print(f'{a.option} {a.bound}: {bad[0]} BROKEN after {n:,} states, {secs:.1f}s; step {bad[1]}; state {bad[2]}')
    elif done:
        print(f'{a.option} {a.bound}: {n:,} states, {edges:,} steps, {secs:.1f}s: every safety property '
              f'(P1 to P4, P6, P7) holds in every reachable state (complete; hashed states; peak frontier {peak:,})')
    else:
        print(f'{a.option} {a.bound}: {n:,} states, {secs:.1f}s: no safety property broken so far '
              f'(STOPPED AT THE TIME LIMIT; frontier {len(q):,})')


if __name__ == '__main__':
    main()
