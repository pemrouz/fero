#!/usr/bin/env python3
"""agef37.py: E-14's tools/agef.py (copied; the check is unchanged), plus a
count of judged states by how many entries are damaged (E-37).

agef.py: the liveness check of E-14, on TLC's own state graph.

TLC writes the whole reachable state graph with `-dump dot,actionlabels`
(run.py pipes it through gzip). This tool reads it and checks, for every
reachable state:

    live majority  =>  a goal state is reachable by progress steps only

where a progress step is any step that is not a fault and not a recovery
(faults raise the `faults` counter; a recovery raises the number of up
servers). This is healing.py's P5 ("no stuck state with a live majority")
as an AG EF property. In a finite graph, AG EF goal means that a scheduler
that gives every enabled step some chance (random election timeouts)
reaches the goal with probability 1, which is the sense in which Raft is
live (a reasoned argument, not checked here). It is sound under TLC's
symmetry reduction because the goal, the live-majority flag and the step
kinds are symmetric.

The model (MCferoraft.tla) writes two flags into every state: goalv (a
leader of its latest config has committed an entry of its own term) and
livev (a majority of the latest committed config's voters is up).

Terms are bounded in the model, so a state near the bound can look stuck
only because no term is left to elect in. So only states whose highest
term is at most MaxTermLimit - 2 are judged (--judge-max-term N): from
them a path may use two more elections. Others are counted apart, as
"near the bound".

Usage: agef.py graph.dot[.gz] [--trace N] [--judge-max-term N]
Prints counts, and the shortest path from the initial state to the first N
stuck states with a live majority.
"""
import gzip
import re
import sys
from array import array

import numpy as np

Q = r'"((?:[^"\\]|\\.)*)"'
NODE = re.compile(r'^(-?\d+) \[label=' + Q + r'(,tooltip=' + Q + r')?(.*)\];?\s*$')
EDGE = re.compile(r'^(-?\d+) -> (-?\d+)')
F_GOAL = re.compile(r'/\\\\ goalv = (TRUE|FALSE)')
F_LIVE = re.compile(r'/\\\\ livev = (TRUE|FALSE)')
F_FAULTS = re.compile(r'/\\\\ faults = (\d+)')
F_UP = re.compile(r'/\\\\ up = (\{[^}]*\})')
F_TERM = re.compile(r'/\\\\ currentTerm = \(([^)]*)\)')
F_DAM = re.compile(r'/\\\\ damaged = \{([^}]*)\}')
F_BAD = re.compile(r'/\\\\ bad = \(([^)]*)\)')


def opener(path):
    if path.endswith('.gz'):
        return gzip.open(path, 'rt', encoding='utf-8', errors='replace')
    return open(path, encoding='utf-8', errors='replace')


def count_up(s):
    s = s.strip()
    return 0 if s == '{}' else s.count(',') + 1


def ranges(ptr, f):
    """Indices ptr[f[k]] .. ptr[f[k]+1]-1 for every k, concatenated."""
    lo, hi = ptr[f], ptr[f + 1]
    ln = hi - lo
    tot = int(ln.sum())
    if tot == 0:
        return np.zeros(0, dtype=np.int64)
    starts = np.repeat(lo - np.concatenate(([0], np.cumsum(ln)[:-1])), ln)
    return starts + np.arange(tot)


def main():
    args = sys.argv[1:]
    path = args[0]
    ntrace = int(args[args.index('--trace') + 1]) if '--trace' in args else 1
    judge = int(args[args.index('--judge-max-term') + 1]) if '--judge-max-term' in args else 10 ** 9
    ids, goal, live, faults, nup, mterm = array('q'), bytearray(), bytearray(), array('h'), array('h'), array('h')
    ndam, nbad = array('h'), array('h')
    esrc, edst = array('q'), array('q')
    init = []
    with opener(path) as f:
        for line in f:
            if ' -> ' in line:
                m = EDGE.match(line)
                if m:
                    esrc.append(int(m.group(1)))
                    edst.append(int(m.group(2)))
                continue
            m = NODE.match(line.strip())
            if not m:
                continue
            lab = m.group(4) or m.group(2)
            ids.append(int(m.group(1)))
            goal.append(F_GOAL.search(lab).group(1) == 'TRUE')
            live.append(F_LIVE.search(lab).group(1) == 'TRUE')
            faults.append(int(F_FAULTS.search(lab).group(1)))
            nup.append(count_up(F_UP.search(lab).group(1)))
            t = F_TERM.search(lab)
            mterm.append(max([int(x) for x in re.findall(r':> (\d+)', t.group(1))] or [0]) if t else 0)
            dm = F_DAM.search(lab)
            ndam.append(dm.group(1).count('<<') if dm else 0)
            bm = F_BAD.search(lab)
            nbad.append(len([x for x in re.findall(r':> (\d+)', bm.group(1)) if x != '0']) if bm else 0)
            if 'filled' in (m.group(5) or ''):
                init.append(int(m.group(1)))
    ids = np.frombuffer(ids, dtype=np.int64)
    n = len(ids)
    order = np.argsort(ids)
    sid = ids[order]

    def idx(x):
        x = np.asarray(x, dtype=np.int64)
        p = np.searchsorted(sid, x)
        p[p >= n] = 0
        return order[p], sid[p] == x
    goal = np.frombuffer(goal, dtype=np.uint8).astype(bool)
    live = np.frombuffer(live, dtype=np.uint8).astype(bool)
    faults = np.frombuffer(faults, dtype=np.int16)
    nup = np.frombuffer(nup, dtype=np.int16)
    mterm = np.frombuffer(mterm, dtype=np.int16)
    s, oks = idx(np.frombuffer(esrc, dtype=np.int64))
    d, okd = idx(np.frombuffer(edst, dtype=np.int64))
    keep = oks & okd
    s, d = s[keep], d[keep]
    prog = (faults[s] == faults[d]) & (nup[s] == nup[d])
    # backward reachability of goal states over progress edges (CSR by target)
    ps, pd = s[prog], d[prog]
    o = np.argsort(pd, kind='stable')
    rsrc = ps[o]
    rptr = np.searchsorted(pd[o], np.arange(n + 1))
    good = goal.copy()
    frontier = np.nonzero(good)[0]
    while frontier.size:
        preds = np.unique(rsrc[ranges(rptr, frontier)])
        new = preds[~good[preds]]
        good[new] = True
        frontier = new
    judged = mterm <= judge
    stuck = (~good) & judged
    stuck_live = stuck & live
    near = int(((~good) & ~judged).sum())
    print('states %d  edges %d  initial %d' % (n, len(esrc), len(init)))
    print('goal states %d  can reach goal %d' % (int(goal.sum()), int(good.sum())))
    print('judged states (highest term <= %s) %d' % (judge if judge < 10 ** 9 else 'any', int(judged.sum())))
    print('stuck states %d  of which with a live majority %d  (not judged, near the term bound: %d)' % (
        int(stuck.sum()), int(stuck_live.sum()), near))
    if stuck_live.any():
        u, c = np.unique(faults[stuck_live], return_counts=True)
        print('stuck with a live majority, by faults used: %s' % dict(zip(u.tolist(), c.tolist())))
    ndam = np.frombuffer(ndam, dtype=np.int16)
    nbad = np.frombuffer(nbad, dtype=np.int16)
    parts = []
    for k in sorted(set(ndam.tolist())):
        sel = judged & live & (ndam == k)
        parts.append('%d damaged: %d judged live-majority states, %d stuck' % (k, int(sel.sum()), int((sel & stuck).sum())))
    for k in sorted(set(nbad.tolist())):
        sel = judged & live & (nbad == k)
        parts.append('%d still bad: %d judged live-majority states, %d stuck' % (k, int(sel.sum()), int((sel & stuck).sum())))
    print('DAMAGE ' + '; '.join(parts))
    found = []
    if stuck_live.any() and ntrace > 0 and init:
        # forward BFS from the initial state over every edge, with parents
        o2 = np.argsort(s, kind='stable')
        fdst = d[o2]
        fptr = np.searchsorted(s[o2], np.arange(n + 1))
        parent = np.full(n, -2, dtype=np.int64)
        start, _ = idx(init)
        parent[start] = -1
        frontier = start
        while frontier.size and len(found) < ntrace:
            for h in frontier[stuck_live[frontier]][:ntrace - len(found)]:
                found.append(int(h))
            if len(found) >= ntrace:
                break
            r = ranges(fptr, frontier)
            src_of = np.repeat(frontier, fptr[frontier + 1] - fptr[frontier])
            nxt = fdst[r]
            fresh = parent[nxt] == -2
            nxt, src_of = nxt[fresh], src_of[fresh]
            nxt, first = np.unique(nxt, return_index=True)
            parent[nxt] = src_of[first]
            frontier = nxt
        paths, need = [], set()
        for h in found:
            p = []
            while h >= 0:
                p.append(h)
                h = int(parent[h])
            p.reverse()
            paths.append(p)
            need.update(int(ids[x]) for x in p)
        labels = {}
        with opener(path) as f:
            for line in f:
                if ' -> ' in line:
                    continue
                m = NODE.match(line.strip())
                if m and int(m.group(1)) in need:
                    labels[int(m.group(1))] = m.group(4) or m.group(2)
        for k, p in enumerate(paths):
            print('\n=== shortest trace %d to a stuck state with a live majority: %d states ===' % (k + 1, len(p)))
            print('(states as TLC stores them: with symmetry on, each is the representative of its class,')
            print(' so member names can swap between steps)')
            for i, x in enumerate(p):
                print('--- state %d' % (i + 1))
                print(labels.get(int(ids[x]), '?').replace('\\n', '\n').replace('\\\\', '\\').replace('\\"', '"'))
    print('\nRESULT: %s' % ('FAIL (stuck with a live majority)' if stuck_live.any() else 'PASS (no stuck state with a live majority)'))
    return 1 if stuck_live.any() else 0


if __name__ == '__main__':
    sys.exit(main())
