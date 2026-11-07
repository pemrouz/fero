#!/usr/bin/env python3
"""
hunt.py: E-17 part 3's search for a rule an option needs but omitted (a
property the shared harness does not check, or a bound it does not reach),
and for a rule counted that is not needed. It imports the shared harness
from a work copy and changes nothing in it; every check here is OUTSIDE the
shared sweep, so the shared counts stay comparable.

    python3 hunt.py --work $SP/e17c/work others     # L8 and F8 (below), as written and smallest
    python3 hunt.py --work $SP/e17c/work repeat     # a log that does NOT ignore an exact repeat
    python3 hunt.py --work $SP/e17c/work bigger     # part 2's three bounds + three groups
    python3 hunt.py --work $SP/e17c/work all

The smallest sets are this re-run's (WORK/results/<name>-ablation.json).

Checks:
  L8  "others go on" (SC-08(b), "a partition is unwritable ... per move WHILE
      OTHERS GO ON"): from every reachable state, an attempt on a partition
      that the bound's layouts never move can be answered (applied or
      refused for good) by client steps and commits alone: no step of the
      change protocol, no crash, no timer. Parts 1 and 2 argued this in words
      ("re-key freezes every partition", reasoned); this checks it.
  F8  "copy only what moves" (SC-08(f), "data moved ... <= its share"): no
      reachable state has rows of a partition the layouts never move in any
      group but the one that held it at the start.
  R   a log that does NOT ignore an exact repeat. The harness ignores an
      append of an entry already in the log (HARNESS.md), so a guard that only
      stops an exact repeat is never counted. A real log appends it. With
      repeats appended (up to the same 10-entry cap), which smallest sets
      still hold, and which dropped rules come back?
  B   bigger bounds: part 2's readback, readback1 and bothread (extra.py),
      and two with a THIRD group, which no shared bound has: chain3 (p moves
      G0 -> G1 -> G2 with the reader on) and fork3 (p and q leave G0 for G1
      and G2 in one change).
"""

import argparse
import json
import os
import sys
import time
from collections import deque

if os.environ.get('PYTHONHASHSEED') != '0':
    os.environ['PYTHONHASHSEED'] = '0'
    os.execv(sys.executable, [sys.executable] + sys.argv)

ap = argparse.ArgumentParser()
ap.add_argument('--work', required=True)
ap.add_argument('what', nargs='+', choices=('others', 'repeat', 'bigger', 'stats', 'all'))
ap.add_argument('--only', action='append', default=[], help='only these result names')
ap.add_argument('--limit', type=int, default=1_500_000)
A = ap.parse_args()
sys.path.insert(0, os.path.join(A.work, 'harness'))

import runner                                      # noqa: E402
import world                                       # noqa: E402
from bounds import BOUNDS, SWEEP, GROW, SHRINK, TWICE, VERIFY  # noqa: E402
from dsl import Mutation                           # noqa: E402
from world import World, PROPS, is_calm            # noqa: E402
from explore import explore                        # noqa: E402

RES = os.path.join(A.work, 'results')

# the smallest sets checked, and the option each one is a set of
SETS = ['fixN', 'slot', 'slot-rev', 'slot+abort', 'rekey', 'rekey-alt', 'rekey-carry', 'rekey-carry-alt',
        'pslot', 'pslot-rev', 'pslot+abort', 'pslot-fused', 'pslot-fused+abort', 'split', 'split+giveup',
        'lanes', 'lanes-rev', 'lanes+abort', 'lanes-carry']


def option_of(name):
    base = name.split('+')[0]
    for suf in ('-rev', '-alt'):
        if base.endswith(suf):
            base = base[:-len(suf)]
    return base


def removed(name):
    p = os.path.join(RES, f'{name}-ablation.json')
    if not os.path.exists(p):
        return None
    return json.load(open(p))['removed']


EXTRA = {
    # part 2's (E17b extra.py), unchanged
    'readback': dict(layouts=TWICE, attempts=[('w1', 'p', 1), ('w2', 'p', 1)], crashes=0, faults=0, reader=True),
    'readback1': dict(layouts=TWICE, attempts=[('w1', 'p', 1), ('w2', 'p', 1)], crashes=1, faults=1, reader=True),
    'bothread': dict(layouts=GROW, attempts=[('w1', 'p', 1), ('w3', 'q', 1)], crashes=1, faults=2, reader=True),
    # new: a third group
    'chain3': dict(layouts=[{'p': 0, 'q': 0}, {'p': 1, 'q': 0}, {'p': 2, 'q': 0}],
                   attempts=[('w1', 'p', 1), ('w2', 'p', 1)], crashes=0, faults=0, reader=True),
    'chain3c': dict(layouts=[{'p': 0, 'q': 0}, {'p': 1, 'q': 0}, {'p': 2, 'q': 0}],
                    attempts=[('w1', 'p', 1)], crashes=1, faults=1, reader=False),
    'fork3': dict(layouts=[{'p': 0, 'q': 0}, {'p': 1, 'q': 2}],
                  attempts=[('w1', 'p', 1), ('w3', 'q', 1)], crashes=1, faults=1, reader=False),
    # for L8 and F8: one write on the partition that stays
    'both': BOUNDS['both'],
    'bothshrink': dict(layouts=SHRINK, attempts=[('w1', 'p', 1), ('w3', 'q', 1)], crashes=1, faults=2, reader=False),
    'bothtwice': dict(layouts=TWICE, attempts=[('w1', 'p', 1), ('w3', 'q', 1)], crashes=0, faults=0, reader=False),
}
THREE = ('chain3', 'chain3c', 'fork3')     # only options that read layouts as moves of one unit
THREE_OK = ('slot', 'pslot', 'pslot-fused', 'lanes', 'lanes-carry', 'split')


def bound(b):
    return EXTRA.get(b) or BOUNDS[b]


def show(tr, ind='      '):
    return '\n'.join(f'{ind}{k:2}. {" ".join(map(str, lab))}' for k, lab in enumerate(tr, 1))


# ------------------------------------------------------------------ L8 and F8
def graph(w, limit):
    """BFS; keeps parents (for traces) and the client-and-commit edges."""
    init = w.init()
    index = {init: 0}
    states, parent, client, capped = [init], [None], [], bytearray()
    i = 0
    while i < len(states):
        s = states[i]
        w.capped_now = False
        out = []
        for lab, kind, t in w.succ(s):
            j = index.get(t)
            if j is None:
                j = len(states)
                index[t] = j
                states.append(t)
                parent.append((i, lab))
            if lab[0] in ('commit', 'write', 'refuse'):
                out.append(j)
        client.append(out)
        capped.append(1 if w.capped_now else 0)
        i += 1
        if len(states) > limit:
            return None
    return states, parent, client, capped


def trace(parent, i):
    labs = []
    while parent[i] is not None:
        j, lab = parent[i]
        labs.append(lab)
        i = j
    return labs[::-1]


def others(name, drop, b):
    opt = option_of(name)
    cls, _ = runner.load(opt)
    bd = bound(b)
    w = World(cls, bd, Mutation(drop=drop), cap=runner.CAP)
    t0 = time.time()
    g = graph(w, A.limit)
    if g is None:
        return f'{name} {b}: LIMIT (undecided)'
    states, parent, client, capped = g
    lays = bd['layouts']
    still = [p for p in ('p', 'q') if all(l[p] == lays[0][p] for l in lays)]
    still_aids = [a for a, p, t in bd['attempts'] if p in still]
    home = {p: w.opt.owners(w, states[0], p) for p in still}
    res = []
    # L8: backward reachability over client edges, per still attempt
    n = len(states)
    rev = [[] for _ in range(n)]
    for a in range(n):
        for j in client[a]:
            rev[j].append(a)
    for aid in still_aids:
        reach = bytearray(n)
        q = deque()
        for x in range(n):
            st = states[x]
            if capped[x] or aid in w.hist_aids(st, w.part[aid]) or aid in st[2]:
                reach[x] = 1
                q.append(x)
        while q:
            y = q.popleft()
            for x in rev[y]:
                if not reach[x]:
                    reach[x] = 1
                    q.append(x)
        bad = next((x for x in range(n) if not reach[x]), None)
        if bad is None:
            res.append(f'L8 holds for {aid}')
        else:
            res.append(f'L8 FAILS for {aid} ({w.part[aid]}, never moved by the layouts): from this state no client '
                       f'step or commit can answer it; it waits for the change:\n' + show(trace(parent, bad)))
    # F8: rows of a still partition anywhere but its first holder
    f8 = None
    for x in range(n):
        st = states[x]
        for p in still:
            for gg in range(w.K):
                if gg in home[p]:
                    continue
                if w.opt.rows(w, st, gg, p):
                    f8 = (x, p, gg)
                    break
            if f8:
                break
        if f8:
            break
    if f8 is None:
        res.append(f'F8 holds: rows of {", ".join(still)} never leave {", ".join(w.opt.names[h] for p in still for h in home[p])}')
    else:
        x, p, gg = f8
        res.append(f'F8 FAILS: rows of {p} (never moved by the layouts) are copied to {w.opt.names[gg]}:\n'
                   + show(trace(parent, x)))
    head = f'{name} {b} [{"as written" if not drop else "smallest set"}]: {n:,} states, {time.time() - t0:.1f}s'
    return head + '\n' + '\n'.join('    ' + r.replace('\n', '\n    ') for r in res)


def run_others():
    print('## L8 (others go on) and F8 (copy only what moves)\n')
    done = set()
    for name in SETS:
        if A.only and name not in A.only:
            continue
        opt = option_of(name)
        drop = removed(name)
        if drop is None:
            print(f'{name}: no result yet')
            continue
        bs = ('both', 'bothshrink', 'bothtwice')
        if opt not in done:
            done.add(opt)
            for b in bs:
                print(others(name, [], b))
        for b in bs:
            print(others(name, drop, b))
        sys.stdout.flush()


# ------------------------------------------------------------------ R: repeats appended
def repeat_append(self, g, entry):
    """world.Draft.append without "a log never holds the same entry twice"."""
    if self.groups is None:
        self.groups = list(self.st[0])
    com, tail, lost, cr = self.groups[g]
    if len(com) + len(tail) >= self.w.cap:
        self.capped = True
        return
    self.groups[g] = (com, tail + (entry,), lost, cr)


def check(opt, drop, bounds, stop_first=True):
    cls, _ = runner.load(opt)
    out = {}
    for b in bounds:
        r = explore(World(cls, bound(b), Mutation(drop=drop), cap=runner.CAP), stop_first=stop_first, limit=A.limit)
        out[b] = r
        if (r.fail or not r.complete) and stop_first:
            break
    return out


def first_bad(rs):
    for b, r in rs.items():
        if r.fail:
            p = min(r.fail, key=lambda k: r.fail[k][0])
            return b, p, r.fail[p][0], r.fail[p][1]
        if not r.complete:
            return b, 'LIMIT', r.states, []
    return None


def repair(opt, drop, bounds):
    """Which dropped rules, put back, make every bound hold: one at a time
    first; then greedily (the rule whose return moves the first failure
    furthest), at most 4 rules."""
    singles = []
    for rule in drop:
        trial = [x for x in drop if x != rule]
        if first_bad(check(opt, trial, bounds)) is None:
            singles.append(rule)
    if singles:
        return f'put back any one of {singles}'
    back = []
    cur = list(drop)
    order = list(bounds)
    for _ in range(4):
        best = None
        for rule in cur:
            trial = [x for x in cur if x != rule]
            fb = first_bad(check(opt, trial, bounds))
            if fb is None:
                back.append(rule)
                return f'put back {back} (greedy; each needed in that order)'
            key = (order.index(fb[0]), fb[2] if fb[1] != 'LIMIT' else 10 ** 9)
            if best is None or key > best[0]:
                best = (key, rule)
        if best is None:
            break
        back.append(best[1])
        cur = [x for x in cur if x != best[1]]
    return f'no repair of up to 4 rules found (tried {back})'


def run_repeat():
    print('## R: a log that appends an exact repeat\n')
    print('Each smallest set on the shared sweep and twice1, then readback, with world.Draft.append changed so an '
          'entry already in the log is appended again (up to the same 10-entry cap). A cap hit still counts as '
          'able to reach a liveness goal, as in the harness, so the liveness results here are weaker than the '
          'safety ones.\n')
    orig = world.Draft.append
    world.Draft.append = repeat_append
    try:
        for name in SETS:
            if A.only and name not in A.only:
                continue
            drop = removed(name)
            if drop is None:
                print(f'{name}: no result yet')
                continue
            opt = option_of(name)
            bounds = list(SWEEP) + list(VERIFY) + ['readback']
            if name.endswith('+abort') or name.endswith('+giveup'):
                bounds = list(SWEEP) + ['readback']
            t0 = time.time()
            rs = check(opt, drop, bounds)
            fb = first_bad(rs)
            sizes = ', '.join(f'{b} {r.states:,}' for b, r in rs.items())
            if fb is None:
                print(f'{name}: holds every bound with repeats appended ({sizes}; {time.time() - t0:.0f}s)')
            else:
                b, p, d, tr = fb
                print(f'{name}: FAILS {p} on {b} in {d} steps with repeats appended ({sizes}):')
                print(show(tr))
                print('    ' + repair(opt, drop, bounds))
            sys.stdout.flush()
    finally:
        world.Draft.append = orig


# ------------------------------------------------------------------ B: bigger bounds
def run_bigger():
    print('## B: bigger bounds\n')
    for name in SETS:
        if A.only and name not in A.only:
            continue
        drop = removed(name)
        if drop is None:
            print(f'{name}: no result yet')
            continue
        opt = option_of(name)
        bs = ['readback', 'bothread'] if ('+' in name) else ['readback', 'readback1', 'bothread']
        if opt in THREE_OK and '+' not in name:
            bs += list(THREE)
        if opt == 'fixN':
            bs = ['bothread']
        for b in bs:
            t0 = time.time()
            rs = check(opt, drop, [b], stop_first=False)
            r = rs[b]
            fb = first_bad(rs)
            if fb is None:
                print(f'{name} {b}: {r.states:,} states, {time.time() - t0:.0f}s: all hold')
            else:
                bb, p, d, tr = fb
                print(f'{name} {b}: {r.states:,} states: {p} in {d} steps' + ('' if p == 'LIMIT' else ':'))
                if p != 'LIMIT':
                    print(show(tr))
                    print('    ' + repair(opt, drop, [b] + list(SWEEP)))
            sys.stdout.flush()


# ------------------------------------------------------------------ S: the state an option adds
def run_stats():
    """The log-entry kinds (and their field counts) that appear in any
    reachable state of each smallest model, on every sweep bound: what an
    option adds to the harness's fixed state (per group: committed log, tail,
    lost tails, crash count; the reader's cursor and what it took; the
    ghosts). Plus the shape of its cursor."""
    print('## S: the state each smallest model adds\n')
    for name in ['fixN', 'slot', 'rekey', 'rekey-carry', 'pslot', 'split', 'lanes', 'lanes-carry', 'pslot-fused']:
        drop = removed(name)
        if drop is None:
            print(f'{name}: no result yet')
            continue
        opt = option_of(name)
        cls, _ = runner.load(opt)
        kinds = {}
        for b in SWEEP:
            w = World(cls, bound(b), Mutation(drop=drop), cap=runner.CAP)
            g = graph(w, A.limit)
            for st in g[0]:
                for grp in st[0]:
                    for e in grp[0] + grp[1]:
                        if e[0] != 'w':
                            kinds[e[0]] = max(kinds.get(e[0], 0), len(e) - 1)
        cur = cls(bound('read')).cursor0()
        print(f'{name}: entry kinds {len(kinds)}: '
              + ', '.join(f'{k} ({n} fields)' for k, n in sorted(kinds.items()))
              + f'; cursor {cur!r} ({len(cur)} parts)')
        sys.stdout.flush()


if __name__ == '__main__':
    what = set(A.what)
    if 'all' in what:
        what = {'others', 'repeat', 'bigger', 'stats'}
    print('# E-17 part 3: the hunt (hunt.py)\n')
    for k, f in (('stats', run_stats), ('others', run_others), ('bigger', run_bigger), ('repeat', run_repeat)):
        if k in what:
            f()
            print()
