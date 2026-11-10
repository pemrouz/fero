#!/usr/bin/env python3
"""agef2.py: E-14's liveness check (tools/agef.py there), on the compact
graph files dotfilter.py writes, possibly in several segments (one per
hold of the heavy lock; a resumed TLC run writes its graph to a new file,
and the segments together are the whole graph: nodes and edges written
after a checkpoint and before the stop are written again by the next
segment, so they may repeat, which does not matter).

  agef2.py --judge-max-term N [--trace K] SEG.g.gz [SEG2.g.gz ...]

For every reachable state the check asks:

    live majority  =>  a goal state is reachable by progress steps only

A progress step keeps `faults` and the number of up servers unchanged (so it
is neither a fault nor a recovery). Only states whose highest term is at
most N are judged, so that every judged state has two more elections in
hand before the model's term bound. This is healing.py's P5 ("no stuck
state with a live majority") as AG EF. It is sound under symmetry because
the goal, the flags and the step kinds are symmetric (E-14's argument).
"""
import gzip
import sys
from array import array

import numpy as np


def openlab(p):
    """A label file: gzip (as dotfilter.py writes it) or xz (recompressed later)."""
    import gzip
    import lzma
    return lzma.open(p, 'rt') if p.endswith('.xz') else gzip.open(p, 'rt')


def load(paths):
    ids, goal, live, faults, nup, mterm, init = (array('q'), bytearray(), bytearray(), array('h'),
                                                 array('h'), array('h'), [])
    plan = bytearray()
    openf = bytearray()
    es, ed = array('q'), array('q')
    for p in paths:
        with gzip.open(p, 'rt') as f:
            for line in f:
                if line[0] == 'E':
                    _, a, b = line.split()
                    es.append(int(a))
                    ed.append(int(b))
                elif line[0] == 'N':
                    w = line.split()
                    _, i, g, l, fl, u, t, ini, pl = w[:9]
                    plan.append(int(pl))
                    openf.append(int(w[9]) if len(w) > 9 else 2)
                    ids.append(int(i))
                    goal.append(g == '1')
                    live.append(l == '1')
                    faults.append(int(fl))
                    nup.append(int(u))
                    mterm.append(int(t))
                    if ini == '1':
                        init.append(int(i))
    return ids, goal, live, faults, nup, mterm, init, es, ed, plan, openf


def back_reach(target, rsrc, rptr):
    good = target.copy()
    frontier = np.nonzero(good)[0]
    while frontier.size:
        preds = np.unique(rsrc[ranges(rptr, frontier)])
        new = preds[~good[preds]]
        good[new] = True
        frontier = new
    return good


def ranges(ptr, f):
    lo, hi = ptr[f], ptr[f + 1]
    ln = hi - lo
    tot = int(ln.sum())
    if tot == 0:
        return np.zeros(0, dtype=np.int64)
    starts = np.repeat(lo - np.concatenate(([0], np.cumsum(ln)[:-1])), ln)
    return starts + np.arange(tot)


def check(paths, judge, ntrace=1, labels=()):
    ids, goal, live, faults, nup, mterm, init, es, ed, plan, openf = load(paths)
    plan = np.frombuffer(plan, dtype=np.uint8)
    openf = np.frombuffer(openf, dtype=np.uint8)
    ids = np.frombuffer(ids, dtype=np.int64)
    goal = np.frombuffer(goal, dtype=np.uint8).astype(bool)
    live = np.frombuffer(live, dtype=np.uint8).astype(bool)
    faults = np.frombuffer(faults, dtype=np.int16)
    nup = np.frombuffer(nup, dtype=np.int16)
    mterm = np.frombuffer(mterm, dtype=np.int16)
    # nodes may repeat across segments: keep one row per id
    sid, first = np.unique(ids, return_index=True)
    goal, live, faults, nup, mterm = goal[first], live[first], faults[first], nup[first], mterm[first]
    plan = plan[first]
    openf = openf[first]
    n = len(sid)
    es = np.frombuffer(es, dtype=np.int64)
    ed = np.frombuffer(ed, dtype=np.int64)
    nedges_raw = len(es)

    def idx(x):
        p = np.searchsorted(sid, x)
        p[p >= n] = 0
        return p, sid[p] == x
    s, oks = idx(es)
    d, okd = idx(ed)
    missing = int((~(oks & okd)).sum())
    keep = oks & okd
    s, d = s[keep], d[keep]
    pair = np.unique(s.astype(np.int64) * n + d)
    s, d = pair // n, pair % n
    prog = (faults[s] == faults[d]) & (nup[s] == nup[d])
    ps, pd = s[prog], d[prog]
    o = np.argsort(pd, kind='stable')
    rsrc = ps[o]
    rptr = np.searchsorted(pd[o], np.arange(n + 1))
    good = back_reach(goal, rsrc, rptr)
    judged = mterm <= judge
    stuck = (~good) & judged
    stuck_live = stuck & live
    res = dict(states=n, edges=int(len(s)), edges_raw=nedges_raw, missing_edge_ends=missing,
               initial=len(init), goal_states=int(goal.sum()), can_reach_goal=int(good.sum()),
               judged=int(judged.sum()), stuck=int(stuck.sum()), stuck_live=int(stuck_live.sum()),
               near_bound_unreached=int(((~good) & ~judged).sum()),
               stuck_live_by_faults={int(k): int(v) for k, v in zip(*np.unique(faults[stuck_live], return_counts=True))},
               max_term=int(mterm.max()) if n else 0)
    lines = ['states %d  edges %d (raw lines %d, ends not found %d)  initial %d' % (
        n, len(s), nedges_raw, missing, len(init)),
        'goal states %d  can reach goal %d' % (res['goal_states'], res['can_reach_goal']),
        'judged states (highest term <= %d) %d' % (judge, res['judged']),
        'stuck states %d  of which with a live majority %d  (not judged, near the term bound: %d)' % (
            res['stuck'], res['stuck_live'], res['near_bound_unreached'])]
    if stuck_live.any():
        lines.append('stuck with a live majority, by faults used: %s' % res['stuck_live_by_faults'])
    if stuck_live.any() and ntrace > 0 and init:
        o2 = np.argsort(s, kind='stable')
        fdst = d[o2]
        fptr = np.searchsorted(s[o2], np.arange(n + 1))
        parent = np.full(n, -2, dtype=np.int64)
        start, _ = idx(np.array(init, dtype=np.int64))
        parent[start] = -1
        frontier = start
        found = []
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
            nxt, fi = np.unique(nxt, return_index=True)
            parent[nxt] = src_of[fi]
            frontier = nxt
        need = set()
        paths_ = []
        for h in found:
            p = []
            while h >= 0:
                p.append(h)
                h = int(parent[h])
            p.reverse()
            paths_.append(p)
            need.update(int(sid[x]) for x in p)
        lab = {}
        for lp in labels:
            with openlab(lp) as f:
                for line in f:
                    k, _, v = line.partition('\t')
                    if int(k) in need and int(k) not in lab:
                        lab[int(k)] = v.rstrip('\n')
        for k, p in enumerate(paths_):
            lines.append('\n=== shortest trace %d to a stuck state with a live majority: %d states ===' % (k + 1, len(p)))
            lines.append('(states as TLC stores them: with symmetry on, each is the representative of its class)')
            for i, x in enumerate(p):
                lines.append('--- state %d' % (i + 1))
                lines.append(lab.get(int(sid[x]), '(label not kept)').replace('\\n', '\n').replace('\\\\', '\\').replace('\\"', '"'))
    # The second goal (MCferolive's planv): from every judged state with no
    # fault used and a live majority, the plan can still be finished by
    # progress steps.
    if (plan != 2).all() and n:
        pgood = back_reach(plan == 1, rsrc, rptr)
        pj = judged & live & (faults == 0)
        pstuck = pj & ~pgood
        res['plan_judged'] = int(pj.sum())
        res['plan_done_states'] = int((plan == 1).sum())
        res['plan_stuck'] = int(pstuck.sum())
        if (openf != 2).all():
            # MCferoq's openv: the change budget still allows the plan. A
            # state where it does not (the leader's own choices spent the
            # budget) can never finish the plan under any rule, so the plan
            # goal is judged where openv holds; the others are counted apart.
            po = pj & (openf == 1)
            postuck = po & ~pgood
            res['plan_open_judged'] = int(po.sum())
            res['plan_open_stuck'] = int(postuck.sum())
            res['plan_spent'] = int((pj & (openf == 0)).sum())
            res['plan_spent_can_finish'] = int((pj & (openf == 0) & pgood).sum())
            lines.append('plan: judged fault-free states with a live majority %d, plan-done states %d, '
                         'cannot finish the plan %d' % (res['plan_judged'], res['plan_done_states'], res['plan_stuck']))
            lines.append('  of the judged: the change budget still allows the plan in %d, cannot finish %d  -> %s' % (
                res['plan_open_judged'], res['plan_open_stuck'], 'FAIL' if postuck.any() else 'PASS'))
            lines.append('  the leader spent the budget another way in %d (not judged; of these can still '
                         'finish: %d, which must be 0)' % (res['plan_spent'], res['plan_spent_can_finish']))
            res['plan_result'] = 'FAIL' if postuck.any() else 'PASS'
        else:
            lines.append('plan: judged fault-free states with a live majority %d, plan-done states %d, '
                         'cannot finish the plan %d  -> %s' % (res['plan_judged'], res['plan_done_states'],
                                                               res['plan_stuck'], 'FAIL' if pstuck.any() else 'PASS'))
            res['plan_result'] = 'FAIL' if pstuck.any() else 'PASS'
    res['result'] = 'FAIL' if stuck_live.any() else 'PASS'
    if missing:
        # An edge whose end has no node line means the graph is broken (for
        # example segments written under different fingerprint functions);
        # a state may then look stuck only because its edges are lost.
        res['result'] = 'INVALID'
        res['plan_result'] = 'INVALID'
        lines.append('\nINVALID: %d edge ends have no node line; the graph is incomplete' % missing)
    lines.append('\nRESULT: %s' % ('FAIL (stuck with a live majority)' if stuck_live.any()
                                   else 'PASS (no stuck state with a live majority)'))
    return res, '\n'.join(lines)


def main():
    a = sys.argv[1:]
    judge = int(a[a.index('--judge-max-term') + 1])
    ntrace = int(a[a.index('--trace') + 1]) if '--trace' in a else 1
    paths = [x for x in a if x.endswith('.g.gz')]
    labels = [x for x in a if x.endswith('.l.gz') or x.endswith('.l.xz')]
    res, text = check(paths, judge, ntrace, labels)
    print(text)
    return 1 if res['result'] == 'FAIL' else 0


if __name__ == '__main__':
    sys.exit(main())
