#!/usr/bin/env python3
"""partial.py: cross-check a finished reduced run against the part of the
full model's graph that TLC wrote before the full run was stopped.

  python3 tools/partial.py SMALL_RUNDIR BIG_RUNDIR JUDGE [--out FILE.json]

SMALL is a finished run at a lower term bound (terms up to 2). BIG is the
same scenario at E-14b's bounds, stopped part-way: a part-graph. Both must
come from the SAME module files, -fp, view and symmetry: only then does a
state have the same node id in both. (TLC fingerprints a string by the order
in which it first met it, so one more module in the run, such as MCferoq.tla,
gives every state another id. A run of MCferoq or MCferoz cannot be compared
with a full run this way; check 1 then finds no state in both.)

What it checks, on the data:
 1. Same ids, same states: every state in both graphs has the same flags.
 2. SMALL holds every judged state: no judged state of BIG is missing in
    SMALL.
 3. SMALL only removes steps: every step of SMALL out of a state that BIG
    had expanded is also a step of BIG. (A state is expanded in BIG when
    BIG wrote at least one step out of it; TLC writes all of a state's
    steps together.)
 4. How many steps out of judged states BIG has and SMALL lacks. For a
    terms-up-to-2 run these are the timeouts into term 3; for MCferoq it
    must be none (it keeps every step out of a judged state).
 5. The AG EF question on SMALL, on BIG and on their union. All three are
    sub-graphs of the full graph, so a judged state that reaches a goal in
    the union reaches it in the full model. A state that does not is only
    "not shown" on a part-graph.
"""
import glob
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import agef2  # noqa: E402

PAIR = [('s', np.int64), ('d', np.int64)]


def graph(paths):
    ids, goal, live, faults, nup, mterm, init, es, ed, plan, _open = agef2.load(paths)
    ids = np.frombuffer(ids, dtype=np.int64)
    sid, first = np.unique(ids, return_index=True)
    g = dict(sid=sid,
             goal=np.frombuffer(goal, dtype=np.uint8).astype(bool)[first],
             live=np.frombuffer(live, dtype=np.uint8).astype(bool)[first],
             faults=np.frombuffer(faults, dtype=np.int16)[first],
             nup=np.frombuffer(nup, dtype=np.int16)[first],
             mterm=np.frombuffer(mterm, dtype=np.int16)[first],
             plan=np.frombuffer(plan, dtype=np.uint8)[first],
             es=np.frombuffer(es, dtype=np.int64), ed=np.frombuffer(ed, dtype=np.int64))
    return g


def merge(a, b):
    """The union of two graphs: one row per node id, all edges of both."""
    sid = np.concatenate((a['sid'], b['sid']))
    u, first = np.unique(sid, return_index=True)
    g = dict(sid=u, es=np.concatenate((a['es'], b['es'])), ed=np.concatenate((a['ed'], b['ed'])))
    for k in ('goal', 'live', 'faults', 'nup', 'mterm', 'plan'):
        g[k] = np.concatenate((a[k], b[k]))[first]
    return g


def agef(g, judge):
    """agef2.check's two questions on a graph that may be a part-graph: an
    edge whose end is not a node is dropped (its end was never written)."""
    sid, n = g['sid'], len(g['sid'])

    def idx(x):
        p = np.searchsorted(sid, x)
        p[p >= n] = 0
        return p, sid[p] == x
    s, oks = idx(g['es'])
    d, okd = idx(g['ed'])
    keep = oks & okd
    missing = int((~keep).sum())
    s, d = s[keep], d[keep]
    pair = np.unique(s.astype(np.int64) * n + d)
    s, d = pair // n, pair % n
    prog = (g['faults'][s] == g['faults'][d]) & (g['nup'][s] == g['nup'][d])
    ps, pd = s[prog], d[prog]
    o = np.argsort(pd, kind='stable')
    rsrc = ps[o]
    rptr = np.searchsorted(pd[o], np.arange(n + 1))
    good = agef2.back_reach(g['goal'], rsrc, rptr)
    judged = g['mterm'] <= judge
    jl = judged & g['live']
    und = jl & ~good
    res = dict(states=n, edges=int(len(s)), ends_not_written=missing, judged=int(judged.sum()),
               judged_live=int(jl.sum()), reach_goal=int((jl & good).sum()), not_shown=int(und.sum()))
    if (g['plan'] != 2).all():
        pgood = agef2.back_reach(g['plan'] == 1, rsrc, rptr)
        pj = jl & (g['faults'] == 0)
        res.update(plan_judged=int(pj.sum()), plan_reach=int((pj & pgood).sum()),
                   plan_not_shown=int((pj & ~pgood).sum()))
    return res, und


def edges(g):
    """All steps as a sorted, duplicate-free array of (src id, dst id)."""
    e = np.empty(len(g['es']), dtype=PAIR)
    e['s'], e['d'] = g['es'], g['ed']
    return np.unique(e)


def term_of(g, ids):
    p = np.searchsorted(g['sid'], ids)
    p[p >= len(g['sid'])] = 0
    return np.where(g['sid'][p] == ids, g['mterm'][p], 32767)


def segs(wd):
    return sorted(glob.glob(os.path.join(wd, 'seg*.g.gz')), key=lambda p: int(os.path.basename(p)[3:-5]))


def main():
    a = sys.argv[1:]
    small_dir, big_dir, judge = a[0], a[1], int(a[2])
    outp = a[a.index('--out') + 1] if '--out' in a else None
    A = graph(segs(small_dir))
    B = graph(segs(big_dir))
    res = dict(small=os.path.basename(small_dir.rstrip('/')), big=os.path.basename(big_dir.rstrip('/')), judge=judge,
               small_states=len(A['sid']), big_states=len(B['sid']))
    print('SMALL %s: %d states (finished).  BIG %s: %d states (a part-graph).  Judged: highest term <= %d' % (
        res['small'], res['small_states'], res['big'], res['big_states'], judge))

    # 1. the same ids mean the same states
    common, ia, ib = np.intersect1d(A['sid'], B['sid'], return_indices=True)
    same = np.ones(len(common), dtype=bool)
    for k in ('goal', 'live', 'faults', 'nup', 'mterm', 'plan'):
        same &= A[k][ia] == B[k][ib]
    res.update(common_states=int(len(common)), common_flags_differ=int((~same).sum()))
    print('1. states in both: %d, of which with any flag different: %d' % (len(common), res['common_flags_differ']))

    # 2. the judged states
    ja = A['sid'][A['mterm'] <= judge]
    jb = B['sid'][B['mterm'] <= judge]
    res.update(judged_small=int(len(ja)), judged_big=int(len(jb)),
               judged_small_not_in_big=int(len(np.setdiff1d(ja, B['sid']))),
               judged_big_not_in_small=int(len(np.setdiff1d(jb, A['sid']))))
    print('2. judged states: SMALL %d, BIG %d; in BIG and not in SMALL: %d (in SMALL and not yet in BIG: %d)' % (
        res['judged_small'], res['judged_big'], res['judged_big_not_in_small'], res['judged_small_not_in_big']))

    # 3. SMALL only removes steps
    ea, eb = edges(A), edges(B)
    expanded_b = np.unique(eb['s'])
    in_exp = np.isin(ea['s'], expanded_b)
    extra = np.setdiff1d(ea[in_exp], eb)
    res.update(small_steps=int(len(ea)), big_steps=int(len(eb)), big_expanded=int(len(expanded_b)),
               small_steps_from_expanded=int(in_exp.sum()), small_steps_not_in_big=int(len(extra)))
    print('3. steps: SMALL %d, BIG %d (BIG expanded %d states); SMALL steps out of states BIG expanded: %d, '
          'of which BIG lacks: %d' % (len(ea), len(eb), len(expanded_b), int(in_exp.sum()), len(extra)))

    # 4. steps out of judged states that BIG has and SMALL lacks
    jeb = eb[term_of(B, eb['s']) <= judge]
    lack = np.setdiff1d(jeb, ea)
    res.update(big_judged_steps=int(len(jeb)), big_judged_steps_not_in_small=int(len(lack)),
               of_which_leave_judged=int((term_of(B, lack['d']) > judge).sum()) if len(lack) else 0)
    print('4. steps out of judged states in BIG: %d; SMALL lacks %d of them (%d of those go above term %d)' % (
        len(jeb), len(lack), res['of_which_leave_judged'], judge))

    # 5. AG EF on each graph and on the union
    for name, g in (('small', A), ('big', B), ('union', merge(A, B))):
        r, und = agef(g, judge)
        res[name] = r
        print('5. %-5s: %d states; judged with a live majority %d: reach a working leader %d, not shown %d%s' % (
            name, r['states'], r['judged_live'], r['reach_goal'], r['not_shown'],
            ('; plan: judged %d, can finish %d, not shown %d' % (r['plan_judged'], r['plan_reach'], r['plan_not_shown']))
            if 'plan_judged' in r else ''))
    ok = (res['common_flags_differ'] == 0 and res['judged_big_not_in_small'] == 0
          and res['small_steps_not_in_big'] == 0)
    res['consistent'] = ok
    print('\nSMALL and BIG agree (checks 1 to 3): %s' % ('yes' if ok else 'NO'))
    print('union: judged states with a live majority not shown to reach a working leader: %d (SMALL alone: %d)' % (
        res['union']['not_shown'], res['small']['not_shown']))
    if outp:
        json.dump(res, open(outp, 'w'), indent=1, sort_keys=True)


if __name__ == '__main__':
    main()
