#!/usr/bin/env python3
"""
steal_check.py: are `claim.free`, `giveup.lost` and `backoff.blocked` needed
for SAFETY? A targeted check beside the saga's ablation.

The ablation keeps these three guards without a counterexample: with one of
them dropped a holder may claim, give up or back off at any time, lock tokens
grow without end, and the run passes the state limit ("undecided").

This script bounds the tokens instead: a lock may be claimed only while its
token is below CAP (a bound on the world, not a rule), so the state space is
finite. It then visits every reachable state of the saga (option fullundo)
with one of the three guards dropped, and checks the safety properties A1
(all or nothing) and A2 (no write cycle). It keeps only a 64-bit hash of each
state and the breadth-first frontier.

    python3 steal_check.py [--cap 4] [--secs 280]

What it cannot say: liveness (L1). The cap itself stops every claim in the
end, so "every unit can still end" is not a fair question here; and "nobody
steals a lock for ever" is a fairness property, which AG EF does not express.
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
import engine   # noqa: E402
import saga     # noqa: E402

CAP = 4


class Capped(saga.FullUndo):
    def actions(self):
        acts = super().actions()
        for a in acts:
            if a.name == 'claim':
                inner = a.params

                def capped(w, st, inner=inner):
                    for b in inner(w, st):
                        pc = st[saga.IX['procs']][b['h']][0]
                        if pc[0] != 'lock':
                            yield b          # the seq guard refuses it
                            continue
                        x = self.units[self.unit(b['h'])][pc[1]]
                        if self.lockrow(st, x)[0] < CAP:
                            yield b
                a.params = capped
        return acts


def reach(model, drop, secs):
    c = engine.Compiled(model, engine.Mutation(drop=drop))
    t0 = time.time()
    init = model.init()
    seen = {hash(init)}
    q = deque([init])
    n = 1
    while q:
        s = q.popleft()
        for lab, kind, t in c.succ(s):
            h = hash(t)
            if h not in seen:
                seen.add(h)
                n += 1
                f = model.check(t)
                if f:
                    return f'{f} BROKEN after {n:,} states, {time.time() - t0:.1f}s; step {lab}'
                q.append(t)
        if c.err is not None:
            return f'ERR {c.err} after {n:,} states'
        if n % 4096 == 0 and time.time() - t0 > secs:
            return f'{n:,} states, {time.time() - t0:.1f}s: A1 and A2 hold so far (STOPPED AT THE TIME LIMIT)'
    return f'{n:,} states, {time.time() - t0:.1f}s: A1 and A2 hold in every reachable state (complete, hashed states)'


def main():
    global CAP
    ap = argparse.ArgumentParser()
    ap.add_argument('--cap', type=int, default=4)
    ap.add_argument('--secs', type=float, default=280.0)
    ap.add_argument('--bound', action='append', default=[])
    ap.add_argument('--drop', action='append', default=[])
    a = ap.parse_args()
    CAP = a.cap
    for drop in ([[d] for d in a.drop] or [[], ['claim.free'], ['giveup.lost'], ['backoff.blocked']]):
        for b in (a.bound or ['one', 'two', 'sub']):
            what = 'the design' if not drop else 'without ' + ', '.join(drop)
            print(f'fullundo, tokens capped at {CAP}, {what}, {b}: {reach(Capped(saga.BOUNDS[b]), drop, a.secs)}',
                  flush=True)


if __name__ == '__main__':
    main()
