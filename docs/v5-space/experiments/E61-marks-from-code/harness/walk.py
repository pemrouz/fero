#!/usr/bin/env python3
"""
walk.py: seeded runs of E-61's model on worlds too big to explore whole.

    python3 harness/walk.py OPTION BOUND [--seeds N] [--drop RULE ...] [--chaos S] [--calm S] [--cutw W] [--out FILE.jsonl]

BOUND is one of the model's WALKS (or BOUNDS). Each seed walks the model at random: first any step
(faults, moves, takeovers, cuts, flips, restarts and the loop's own steps), up to --chaos steps; then
calm steps only (the loop, the leaders, commits), until none is left or --calm steps pass. The safety
properties (ONCE, LOST, HANDLED, ANSWER, STAND, NOSTOP) are checked in every state. At the end, a state
with no calm step left that is not the goal, while the goal is asked there (always, in the design), is a
DONE break: calm steps can no longer finish the job. The same seed gives the same walk.

One JSON line per run: the option, the bound, the seeds, how many broke each property, the first seed
that broke each, and what the walks went through (restarts, lost tails, takeovers, cuts, refusals...).
"""
import argparse
import importlib.util
import json
import os
import random
import sys
import time

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine'))
import engine   # noqa: E402

spec = importlib.util.spec_from_file_location('e61marks', os.path.join(HERE, '..', 'models', 'marks.py'))
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)

EVENTS = ('crash', 'start', 'takeover', 'notice', 'cut', 'flip', 'drop', 'fence', 'open', 'refuse', 'fenced', 'skip',
          'apply', 'bmark', 'gap', 'dup', 'expire', 'resync', 'resend', 'fail', 'emit')


def pick(succ, rng, cutw):
    """A random successor; a source cut weighs cutw against 1 for any other step (so cuts can land late)."""
    if cutw == 1.0:
        return succ[rng.randrange(len(succ))]
    ws = [cutw if x[0][0] == 'cut' else 1.0 for x in succ]
    r = rng.random() * sum(ws)
    for x, w in zip(succ, ws):
        r -= w
        if r < 0:
            return x
    return succ[-1]


def walk(model, comp, rng, chaos, calm, cutw=1.0):
    st = model.init()
    seen = set()
    ev = {}
    lost_tails = 0
    for phase, budget in (('chaos', chaos), ('calm', calm)):
        for _ in range(budget):
            succ = comp.succ(st)
            if phase == 'calm':
                succ = [x for x in succ if x[1] in model.CALM]
            if not succ:
                break
            lab, kind, t = pick(succ, rng, cutw)
            name = lab[0]
            if name in EVENTS:
                ev[name] = ev.get(name, 0) + 1
            if name == 'takeover' and st[M.IX['ds']][st[M.IX['hold']][0]][1] == M.UP:
                ev['takeover-old-running'] = ev.get('takeover-old-running', 0) + 1
            if name in ('gap', 'fail') and [o[0] for o in st[M.IX['ds']]] != [o[0] for o in t[M.IX['ds']]]:
                ev['loop-ended'] = ev.get('loop-ended', 0) + 1     # a write failed: its loop ended (step 7)
            if name == 'crash' and len(lab) > 1 and isinstance(lab[1], str):
                ev['group-crash'] = ev.get('group-crash', 0) + 1
                gi, keep = M.GN.index(lab[1]), int(lab[2].split()[-1])
                if len(st[0][gi][1]) > keep:
                    lost_tails += 1
                    if any(e[0] == 'w' for e in st[0][gi][1][keep:]):
                        ev['lost-tail-with-an-output'] = ev.get('lost-tail-with-an-output', 0) + 1
            for p in model.check(t):
                seen.add(p)
            st = t
        else:
            if phase == 'calm':
                return seen, ev, lost_tails, 'unfinished'
    quiet = not [x for x in comp.succ(st) if x[1] in model.CALM]
    if quiet and model.judged(st)['DONE'] and not model.goals(st)['DONE']:
        seen.add('DONE')
    elif quiet and not model.judged(st)['DONE']:
        return seen, ev, lost_tails, 'not-asked'
    if model.goals(st)['DONE']:
        return seen, ev, lost_tails, 'stopped-expired' if any(o[1] == M.EXPIRED for o in st[2]) else 'finished'
    return seen, ev, lost_tails, 'other'



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('option')
    ap.add_argument('bound')
    ap.add_argument('--seeds', type=int, default=1000)
    ap.add_argument('--first', type=int, default=0)
    ap.add_argument('--drop', action='append', default=[])
    ap.add_argument('--chaos', type=int, default=150)
    ap.add_argument('--calm', type=int, default=3000)
    ap.add_argument('--cutw', type=float, default=1.0, help='weight of a source cut against 1 for other steps')
    ap.add_argument('--out')
    a = ap.parse_args()
    b = M.WALKS.get(a.bound) or M.BOUNDS[a.bound]
    model = M.OPTIONS[a.option](b)
    comp = engine.Compiled(model, engine.Mutation(drop=a.drop))
    t0 = time.time()
    broke = {}
    first = {}
    totals = {}
    ends = {}
    lost = 0
    anyb = 0
    for seed in range(a.first, a.first + a.seeds):
        rng = random.Random(seed)
        seen, ev, lt, end = walk(model, comp, rng, a.chaos, a.calm, a.cutw)
        lost += lt
        anyb += 1 if seen else 0
        ends[end] = ends.get(end, 0) + 1
        for k, v in ev.items():
            totals[k] = totals.get(k, 0) + v
        for p in seen:
            broke[p] = broke.get(p, 0) + 1
            first.setdefault(p, seed)
    row = {'option': a.option, 'bound': a.bound, 'drop': a.drop, 'seeds': a.seeds, 'first_seed': a.first,
           'chaos': a.chaos, 'calm': a.calm, 'cutw': a.cutw, 'broke': broke, 'first_broken_seed': first,
           'seeds_with_a_break': anyb, 'ends': ends, 'events': totals, 'lost_tails': lost,
           'secs': round(time.time() - t0, 1)}
    line = json.dumps(row, sort_keys=True)
    print(line, flush=True)
    if a.out:
        with open(a.out, 'a') as f:
            f.write(line + '\n')


if __name__ == '__main__':
    main()
