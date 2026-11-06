"""
explore.py: breadth-first search over every reachable state, the safety
checks on each new state and step, then the liveness check (AG EF goal over
the calm steps). Breadth first, so the first bad state found is a nearest
one and its trace is a shortest one.

Calm steps are commit, deliver and read: no crash, no timer (tick), no new
scale decision (control). Liveness asks: from EVERY reachable state, can
calm steps alone reach the goal? A state where the log-length cap stopped an
append counts as able to reach it (we cannot know), and is reported.
"""

import time
from array import array
from collections import deque

from world import World, is_calm


class Result:
    def __init__(self):
        self.states = 0
        self.edges = 0
        self.secs = 0.0
        self.capped = 0           # states where the cap stopped an append
        self.fail = {}            # prop -> (depth, trace)
        self.digest = None
        self.complete = False     # explored every reachable state
        self.live_nodes = 0

    def failed(self):
        return sorted(self.fail)

    def summary(self):
        f = ', '.join(f'{p} ({self.fail[p][0]})' for p in sorted(self.fail)) or 'all hold'
        cap = f', cap hit in {self.capped:,} states' if self.capped else ''
        return f'{self.states:,} states, {self.secs:.1f}s: {f}{cap}'


def _trace(states, parent, i):
    labs = []
    while parent[i] is not None:
        j, lab = parent[i]
        labs.append(lab)
        i = j
    labs.reverse()
    return labs


def explore(w: World, stop_first=True, liveness=True, limit=None):
    """Explore w. stop_first: stop at the first safety failure (ablation
    sweeps). Otherwise explore everything and record each property's
    shortest failure."""
    r = Result()
    t0 = time.time()
    init = w.init()
    index = {init: 0}
    states = [init]
    parent = [None]
    calm = array('i')          # calm successors of every state, flat
    calm_at = array('l', [0])  # state i's successors are calm[calm_at[i]:calm_at[i+1]]
    other = array('i')         # control and crash successors (for L5b), flat
    other_ctl = bytearray()    # 1 if that edge is a control step
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
            if 'P4' not in r.fail and w.check_edge(s, t):
                # the reader went back: record on the step (the state may be old)
                r.fail['P4'] = (('edge', i, lab, j), None)
            if is_calm(kind):
                calm.append(j)
            elif kind == 'control' or kind == 'crash':
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
    r.states = len(states)
    r.edges = edges
    r.capped = sum(capped)
    r.complete = i == len(states)
    # traces for the safety failures
    for p, (j, _) in list(r.fail.items()):
        if isinstance(j, tuple):          # an edge failure
            _, a, lab, b = j
            tr = _trace(states, parent, a) + [lab]
            r.fail[p] = (len(tr), tr)
        else:
            tr = _trace(states, parent, j)
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
    # the reverse calm graph, as flat arrays (compressed rows)
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
    names = ('L5', 'L7', 'L4')
    for k, name in enumerate(names):
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
        for x in range(n):           # BFS order: the first is a shallowest
            if not reach[x]:
                tr = _trace(states, parent, x)
                r.fail[name] = (len(tr), tr)
                break
    r.live_nodes = n


def _finish(w, r, states, calm, calm_at, other, other_ctl, other_at, capped):
    """L5b: in every state reachable with no tick step (nobody gives up), calm
    and control steps can still reach: settled and every planned change done."""
    n = len(states)
    # forward: the states reachable without a tick
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
    # backward over calm and control steps from the goal
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
        if seen[x] and not reach[x]:
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
