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
    python3 hunt.py --work $SP/e17c/work combined   # R and B together (runs repeat and bigger first)
    python3 hunt.py --work $SP/e17c/work stats      # the entry kinds each smallest model adds
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
  R   a step taken twice. The harness ignores an append of an entry
      already in the log (HARNESS.md), so a guard that only stops an exact
      repeat is never counted. A real log appends it: a handler run twice (an
      at-least-once delivery, a retry) writes its entry twice unless a guard
      stops it. Here an entry may be appended once more (at most two copies).
      Which smallest sets still hold, and which dropped rule comes back?
  B   bigger bounds: part 2's readback, readback1 and bothread (extra.py),
      and two with a THIRD group, which no shared bound has: chain3 (p moves
      G0 -> G1 -> G2 with the reader on; chain3c the same with one crash and
      one write) and fork3 (p and q leave G0 for G1 and G2 in one change).
  C   R and B together: each core set with every rule R or B put back, on
      every bound at once with a step taken twice, and each rule put back
      dropped again alone (it must break a bound).
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
ap.add_argument('what', nargs='+', choices=('others', 'repeat', 'bigger', 'combined', 'stats', 'all'))
ap.add_argument('--only', action='append', default=[], help='only these result names')
ap.add_argument('--limit', type=int, default=1_500_000)
ap.add_argument('--res', help='where the smallest sets are (default WORK/results)')
A = ap.parse_args()
sys.path.insert(0, os.path.join(A.work, 'harness'))

import runner                                      # noqa: E402
import world                                       # noqa: E402
from bounds import BOUNDS, SWEEP, GROW, SHRINK, TWICE, VERIFY  # noqa: E402
from dsl import Mutation                           # noqa: E402
from world import World, PROPS, is_calm            # noqa: E402
from explore import explore                        # noqa: E402

RES = A.res or os.path.join(A.work, 'results')

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


ORIG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'E17-partitioning', 'results')
SOURCE = {}


def removed(name):
    """This re-run's smallest set; for a result it did not re-derive (the
    give-up prices, checked fresh by verify.py instead), the original's."""
    p = os.path.join(RES, f'{name}-ablation.json')
    SOURCE[name] = 're-run'
    if not os.path.exists(p):
        p = os.path.join(ORIG, f'{name}-ablation.json')
        SOURCE[name] = 'the original set (parts 1 and 2), which this re-run checks fresh with verify.py (compare.md)'
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
    """world.Draft.append, but an entry already in the log may be appended
    ONCE more (at most two copies): a step taken twice, as an at-least-once
    delivery or a retried handler does in a real log. (Unlimited repeats fill
    every log to the cap and the state space past any limit.)"""
    if self.groups is None:
        self.groups = list(self.st[0])
    com, tail, lost, cr = self.groups[g]
    if (com + tail).count(entry) >= 2:
        return
    if len(com) + len(tail) >= self.w.cap:
        self.capped = True
        return
    self.groups[g] = (com, tail + (entry,), lost, cr)


def check(opt, drop, bounds, stop_first=True, limit=None):
    cls, _ = runner.load(opt)
    out = {}
    for b in bounds:
        r = explore(World(cls, bound(b), Mutation(drop=drop), cap=runner.CAP), stop_first=stop_first,
                    limit=limit or A.limit)
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


RLIMIT = 300_000     # states per run in the repeat check and its repairs
PUTBACK_R = {}       # name -> rules R put back (None: not repaired)
PUTBACK_B = {}       # name -> rules the bigger bounds put back


def repair(opt, drop, bounds, limit=None):
    """Which dropped rules must come back so every bound holds. First, one
    at a time: idempotence guards (role 'idem') first, the others only if no
    idem guard alone repairs it. If no single rule does, greedily: put back
    the rule that pushes the first failure furthest (a later bound, or more
    steps), idem guards first on a tie, until every bound holds (at most 6);
    then drop again any rule put back that is no longer needed, so the set
    returned is 1-minimal among those put back. A run stopped at the state
    limit counts as not repaired (undecided)."""
    roles = {r.id: r.role for r in runner.rule_list(opt)}
    idem = [r for r in drop if roles.get(r) == 'idem']
    rest = [r for r in drop if roles.get(r) != 'idem']
    for group in (idem, rest):
        singles = []
        for rule in group:
            trial = [x for x in drop if x != rule]
            if first_bad(check(opt, trial, bounds, limit=limit)) is None:
                singles.append(rule)
        if singles:
            return f'repair: put back any one of {singles}', singles[:1]
    order = list(bounds)

    def score(fb):
        if fb is None:
            return (len(order) + 1, 0)
        return (order.index(fb[0]), 0 if fb[1] == 'LIMIT' else fb[2])

    back = []
    cur = list(drop)
    while len(back) < 6:
        best = None
        for rule in idem + rest:
            if rule not in cur:
                continue
            trial = [x for x in cur if x != rule]
            sc = score(first_bad(check(opt, trial, bounds, limit=limit)))
            key = (sc, 1 if roles.get(rule) == 'idem' else 0)
            if best is None or key > best[0]:
                best = (key, rule)
            if sc[0] == len(order) + 1 and roles.get(rule) == 'idem':
                break
        if best is None:
            break
        back.append(best[1])
        cur = [x for x in cur if x != best[1]]
        if best[0][0][0] == len(order) + 1:
            for rule in list(back):           # minimise: is each one still needed?
                trial = cur + [rule]
                if first_bad(check(opt, trial, bounds, limit=limit)) is None:
                    back.remove(rule)
                    cur = trial
            return f'repair: put back all of {back} (greedy, then each checked still needed)', back
    return f'repair: no set of up to 6 rules found (tried {back})', None


def repair_all(opt, drop, bounds, limit=None):
    """For R: put back every dropped idempotence guard (role 'idem') at once;
    if that is not enough, every dropped guard. If every bound then holds,
    drop each one put back again, in model-text order, keeping it dropped if
    every bound still holds: what is left is the set R needs back (1-minimal
    among those put back)."""
    rl = runner.rule_list(opt)
    roles = {r.id: r.role for r in rl}
    guards = {r.id for r in rl if hasattr(r, 'op')}
    idem = [r for r in drop if roles.get(r) == 'idem']
    other = [r for r in drop if r in guards and r not in idem]
    fb = None
    for extra in (idem, idem + other):
        cur = [x for x in drop if x not in extra]
        fb = first_bad(check(opt, cur, bounds, limit=limit))
        if fb is None:
            back = [r for r in [x.id for x in rl] if r in extra]
            for r in list(back):
                if first_bad(check(opt, cur + [r], bounds, limit=limit)) is None:
                    back.remove(r)
                    cur = cur + [r]
            return f'repair: put back {back} ({len(back)} rule{"s" if len(back) != 1 else ""})', back
    what = f'{fb[1]} on {fb[0]}' if fb else '?'
    return f'repair: not repaired even with every dropped guard put back ({what})', None


ROPT = {'split': 'once-split', 'pslot-fused': 'once-pslot-fused'}


def run_repeat():
    print('## R: a log that may append an exact repeat once\n')
    print('Each smallest set on the shared sweep and twice1 (twice1 left out for the give-up sets), with world.Draft.append changed so an '
          'entry already in the log may be appended once more (a step taken twice: at most two copies of an '
          'entry, within the same 10-entry cap). A cap hit still counts as able to reach a liveness goal, as in '
          'the harness. Runs stop at 300,000 states (LIMIT: undecided).\n')
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
            if os.path.isdir(os.path.join(A.work, 'options', 'once')) and opt in ROPT:
                # the variant with the once guards its model never wrote; they
                # start dropped, like every once guard the ablation dropped
                base = {r.id for r in runner.rule_list(opt)}
                opt = ROPT[opt]
                drop = drop + [r.id for r in runner.rule_list(opt) if r.id not in base]
            bounds = list(SWEEP) + list(VERIFY)
            if name.endswith('+abort') or name.endswith('+giveup'):
                bounds = list(SWEEP)
            t0 = time.time()
            rs = check(opt, drop, bounds, limit=RLIMIT)
            fb = first_bad(rs)
            sizes = ', '.join(f'{b} {r.states:,}' for b, r in rs.items())
            if fb is None:
                print(f'{name} ({opt}): holds every bound with a step taken twice ({sizes}; {time.time() - t0:.0f}s)')
            elif fb[1] == 'LIMIT':
                print(f'{name} ({opt}): undecided: {fb[0]} passed {RLIMIT:,} states with no counterexample ({sizes})')
                txt, back = repair_all(opt, drop, bounds, limit=RLIMIT)
                print('    ' + txt)
                PUTBACK_R[name] = back
            else:
                b, p, d, tr = fb
                print(f'{name} ({opt}): FAILS {p} on {b} in {d} steps with a step taken twice ({sizes}):')
                print(show(tr))
                txt, back = repair_all(opt, drop, bounds, limit=RLIMIT)
                print('    ' + txt)
                PUTBACK_R[name] = back
            if fb is None:
                PUTBACK_R[name] = []
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
                    txt, back = repair(opt, drop, [b] + list(SWEEP))
                    print('    ' + txt)
                    PUTBACK_B.setdefault(name, set()).update(back or ['?'])
            sys.stdout.flush()


# ------------------------------------------------------------------ C: both at once
CORE = ['fixN', 'slot', 'rekey', 'rekey-carry', 'pslot', 'split', 'lanes', 'lanes-carry', 'pslot-fused']


def run_combined():
    """Each core set with every rule R and B put back, checked with a step
    taken twice on the sweep, twice1 and the bigger bounds at once; then
    each rule put back is dropped again alone: it must break some bound
    (so the count is 1-minimal among those put back)."""
    print('## C: the bigger bounds and a step taken twice, together\n')
    print('Each core set with every rule that R or B put back, run with a step taken twice on the six sweep '
          'bounds, twice1 and the bigger bounds B uses. Then each rule put back is dropped again, alone: it '
          'must break a bound. Runs stop at 300,000 states (LIMIT: undecided).\n')
    orig = world.Draft.append
    world.Draft.append = repeat_append
    try:
        for name in CORE:
            if A.only and name not in A.only:
                continue
            drop = removed(name)
            if drop is None or name not in PUTBACK_R:
                print(f'{name}: no result yet (needs R first)')
                continue
            r, b = PUTBACK_R[name], sorted(PUTBACK_B.get(name, ()))
            if r is None or '?' in b:
                print(f'{name}: R or B found no repair; nothing to combine')
                continue
            opt = option_of(name)
            if os.path.isdir(os.path.join(A.work, 'options', 'once')) and opt in ROPT:
                base = {x.id for x in runner.rule_list(opt)}
                opt = ROPT[opt]
                drop = drop + [x.id for x in runner.rule_list(opt) if x.id not in base]
            back = list(dict.fromkeys(r + b))
            cur = [x for x in drop if x not in back]
            bs = list(SWEEP) + list(VERIFY) + ['readback', 'readback1', 'bothread']
            if opt.startswith('once-') or opt in THREE_OK:
                bs += list(THREE)
            if name == 'fixN':
                bs = list(SWEEP) + list(VERIFY) + ['bothread']
            t0 = time.time()
            fb = first_bad(check(opt, cur, bs, limit=RLIMIT))
            kept = len(runner.rule_list(opt)) - len(cur)
            if fb is not None:
                what = f'{fb[1]} on {fb[0]}' + ('' if fb[1] == 'LIMIT' else f' in {fb[2]} steps')
                print(f'{name}: with {back} put back it still FAILS {what}')
                if fb[1] != 'LIMIT':
                    print(show(fb[3]))
                continue
            need = []
            for x in back:
                fx = first_bad(check(opt, cur + [x], bs, limit=RLIMIT))
                need.append(f'{x}: ' + ('NOT needed' if fx is None else f'{fx[1]} on {fx[0]}' +
                                        ('' if fx[1] == 'LIMIT' else f' in {fx[2]} steps')))
            print(f'{name}: {kept} rules ({kept - len(back)} + {len(back)} put back: {", ".join(back) or "none"}) '
                  f'hold every bound with a step taken twice ({time.time() - t0:.0f}s)')
            for x in need:
                print(f'    without {x}')
            sys.stdout.flush()
    finally:
        world.Draft.append = orig


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
        what = {'others', 'repeat', 'bigger', 'combined', 'stats'}
    if 'combined' in what:
        what |= {'repeat', 'bigger'}
    print('# E-17 part 3: the hunt (hunt.py)\n')
    for k, f in (('stats', run_stats), ('others', run_others), ('bigger', run_bigger), ('repeat', run_repeat),
                 ('combined', run_combined)):
        if k in what:
            f()
            print()
    print('## Where each smallest set came from\n')
    for n in SETS:
        if n in SOURCE:
            print(f'- {n}: {SOURCE[n]}')
