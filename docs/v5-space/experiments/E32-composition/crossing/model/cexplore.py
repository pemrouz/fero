"""
cexplore.py: E-17's explore.py (breadth-first search, safety on each new
state and step, then AG EF liveness over the calm steps), with two changes:

- liveness is asked only from the states the world judges (E-16's engine:
  every group has a live majority), since a group with no majority cannot
  move by calm steps; and one more goal, LH (healing finishes);
- a step can break more than one edge property (E-17 has one, P4).

Calm steps: commit, deliver, read. A log drop ('drop'), a member fault
('fault'), a recovery ('recover'), E-17's deposition ('crash') and a new
move ('control') are not calm. A give-up is a 'tick'.

L5b, as in E-17: in every judged state reached with no give-up, calm steps
and control steps can still reach "settled, and every planned move done".
"""

import time
from array import array
from collections import deque

from cworld import CALM, GOALS


class Result:
    def __init__(self):
        self.states = 0
        self.edges = 0
        self.secs = 0.0
        self.capped = 0
        self.fail = {}
        self.digest = None
        self.complete = False
        self.judged = 0
        self.depth = 0

    def summary(self):
        f = ', '.join(f'{p} ({self.fail[p][0]})' for p in sorted(self.fail)) or 'all hold'
        cap = f', cap hit in {self.capped:,} states' if self.capped else ''
        lim = '' if self.complete else ' (STOPPED: partial)'
        return f'{self.states:,} states, {self.edges:,} steps, {self.secs:.1f}s: {f}{cap}{lim}'


def _trace(parent, i):
    labs = []
    while parent[i] is not None:
        j, lab = parent[i]
        labs.append(lab)
        i = j
    labs.reverse()
    return labs


def explore(w, stop_first=True, liveness=True, limit=None, progress=None):
    r = Result()
    t0 = time.time()
    init = w.init()
    index = {init: 0}
    states = [init]
    parent = [None]
    calm = array('i')
    calm_at = array('l', [0])
    other = array('i')           # non-calm, non-tick successors (for L5b's forward set)
    other_ctl = bytearray()      # 1 if that step is a control step
    other_at = array('l', [0])
    capped = bytearray()
    for p in w.check(init):
        r.fail[p] = (0, [])
    i = 0
    edges = 0
    while i < len(states):
        s = states[i]
        w.capped_now = False
        for lab, kind, t in w.succ(s):
            edges += 1
            j = index.get(t)
            if j is None:
                j = len(states)
                index[t] = j
                states.append(t)
                parent.append((i, lab))
                for p in w.check(t):
                    if p not in r.fail:
                        r.fail[p] = (j, None)
            for p in w.check_edge(s, t):
                if p not in r.fail:
                    r.fail[p] = (('edge', i, lab, j), None)
            if kind in CALM:
                calm.append(j)
            elif kind != 'tick':
                other.append(j)
                other_ctl.append(1 if kind == 'control' else 0)
        calm_at.append(len(calm))
        other_at.append(len(other))
        capped.append(1 if w.capped_now else 0)
        i += 1
        if r.fail and stop_first:
            break
        if limit and len(states) > limit:
            break
        if progress and i % 200000 == 0:
            progress(i, len(states), time.time() - t0)
    r.states = len(states)
    r.edges = edges
    r.capped = sum(capped)
    r.complete = i == len(states)
    for p, (j, _) in list(r.fail.items()):
        if isinstance(j, tuple):
            _, a, lab, b = j
            tr = _trace(parent, a) + [lab]
        else:
            tr = _trace(parent, j)
        r.fail[p] = (len(tr), tr)
    if liveness and r.complete and not r.fail:
        _liveness(w, r, states, parent, calm, calm_at, capped)
        _finish(w, r, states, calm, calm_at, other, other_ctl, other_at, capped)
    h = 0
    for s in states:
        h = (h + hash(s)) & 0xFFFFFFFFFFFFFFFF
    r.digest = (r.states, r.edges, h)
    r.secs = time.time() - t0
    return r


def _liveness(w, r, states, parent, calm, calm_at, capped):
    n = len(states)
    deg = array('l', bytes(8 * (n + 1)))
    for b in calm:
        deg[b + 1] += 1
    for x in range(n):
        deg[x + 1] += deg[x]
    rev = array('i', bytes(4 * len(calm)))
    fill = array('l', deg)
    for a in range(n):
        for k in range(calm_at[a], calm_at[a + 1]):
            b = calm[k]
            rev[fill[b]] = a
            fill[b] += 1
    del fill
    goals = [w.goals(s) for s in states]
    judged = bytearray(1 if w.judged(s) else 0 for s in states)
    r.judged = sum(judged)
    for k, name in enumerate(GOALS):
        reach = bytearray(n)
        q = deque()
        for x in range(n):
            if goals[x][k] or capped[x]:
                reach[x] = 1
                q.append(x)
        while q:
            b = q.popleft()
            for m in range(deg[b], deg[b + 1]):
                a = rev[m]
                if not reach[a]:
                    reach[a] = 1
                    q.append(a)
        for x in range(n):
            if judged[x] and not reach[x]:
                tr = _trace(parent, x)
                r.fail[name] = (len(tr), tr)
                break


def _finish(w, r, states, calm, calm_at, other, other_ctl, other_at, capped):
    n = len(states)
    pred = array('i', [-1]) * n
    seen = bytearray(n)
    seen[0] = 1
    q = deque([0])
    while q:
        a = q.popleft()
        for lst, lo, hi in ((calm, calm_at[a], calm_at[a + 1]), (other, other_at[a], other_at[a + 1])):
            for k in range(lo, hi):
                b = lst[k]
                if not seen[b]:
                    seen[b] = 1
                    pred[b] = a
                    q.append(b)

    def each_edge():
        for a in range(n):
            for k in range(calm_at[a], calm_at[a + 1]):
                yield a, calm[k]
            for k in range(other_at[a], other_at[a + 1]):
                if other_ctl[k]:
                    yield a, other[k]
    deg = array('l', bytes(8 * (n + 1)))
    m = 0
    for a, b in each_edge():
        deg[b + 1] += 1
        m += 1
    for x in range(n):
        deg[x + 1] += deg[x]
    rev = array('i', bytes(4 * m))
    fill = array('l', deg)
    for a, b in each_edge():
        rev[fill[b]] = a
        fill[b] += 1
    del fill
    reach = bytearray(n)
    q = deque()
    for x in range(n):
        if capped[x] or (w.opt.settled(w, states[x]) and w.opt.done_all(w, states[x])):
            reach[x] = 1
            q.append(x)
    while q:
        b = q.popleft()
        for m in range(deg[b], deg[b + 1]):
            a = rev[m]
            if not reach[a]:
                reach[a] = 1
                q.append(a)
    for x in range(n):
        if seen[x] and not reach[x] and w.judged(states[x]):
            path = [x]
            while pred[path[-1]] != -1:
                path.append(pred[path[-1]])
            path.reverse()
            tr = []
            for a, b in zip(path, path[1:]):
                for lab, kind, t in w.succ(states[a]):
                    if t == states[b] and kind != 'tick':
                        tr.append(lab)
                        break
            r.fail['L5b'] = (len(tr), tr)
            break
