#!/usr/bin/env python3
"""
healing.py: a small exhaustive model checker for DESIGN-V5 section 4.2,
"Healing: one rule, run by each shard's leader" and "Leaving, restarting
and stopping". Plain Python 3, standard library only.

    python3 healing.py                 # every scenario, the design as written
    python3 healing.py --scenario four # one scenario
    python3 healing.py --mutants       # one rule removed at a time
    python3 healing.py --list          # scenarios and mutants

What it models (healing.md says it in plain English):
  * ONE shard, as an abstract Raft group. Replicas are (member, disk
    incarnation). A configuration (voters, learners) is a log entry that
    takes effect when appended; one change at a time, each only after the
    previous one committed and after the leader committed an entry of its
    own term (Ongaro's 2015 fix). A commit needs a majority of the voters
    of the leader's latest configuration. A leader can be deposed with its
    uncommitted tail lost. PreVote and CheckQuorum are abstracted as guards.
    Learners answer vote requests by the log rule; a candidate counts only
    its own configuration's voters.
  * Members crash and return with or without their disk, are partitioned,
    pause (a GC pause shorter than the probe window), leave (Ctrl-C) and are
    reported gone (evict.after, or a planner).
  * Healing and the leave run the doc's steps as written.

The properties are listed in PROPS below. Every reachable state is checked;
violations are reported with the shortest trace (the search is breadth
first).
"""

import argparse
import sys
import time
from array import array

# --------------------------------------------------------------------------
# tuple layouts

UP, INC, SIDE, PAUSED, GONE, DRAIN, LEAVING, LEFT = range(8)   # member
TERM, VOTED, LOG, LEADER, COMMIT = range(5)                    # replica
NOOP, CLIENT, CFG = 0, 1, 2                                    # entry kinds


class G:
    """Parameters of one run (module globals, for speed)."""
    N = 3            # members
    COPIES = 3       # `copies`
    LAG = 1          # `lag.max`, in entries
    MAXT = 5         # highest term the main search may reach
    F = 2            # faults (crash, partition, pause, cut-off leave)
    LV = 1           # leaves (Ctrl-C)
    E = 1            # client entries
    MUT = frozenset()
    FIX = frozenset()  # proposed fixes to try (see FIXES)
    FINE = False     # replicate to one follower per step
    ANY = False      # healing may take any enabled step, not the doc's order
    META = True      # #meta has a majority, so the draining mark is written


PROPS = {
    'P1-election':  'at most one leader per term',
    'P1-complete':  'a new leader holds every committed entry (none lost)',
    'P1-prefix':    'a commit never overwrites a committed entry',
    'P1-durable':   'a committed entry is on a majority of the committed '
                    'configuration\'s voters, or the shard reports under-replication',
    'P2-holders':   'no healing or leave step lowers the vouching voters holding '
                    'a committed entry, unless a replacement voter already holds it',
    'P3-even':      'healing never raises a voter count to an even number '
                    '(except the doc\'s transient 1->2->3 and the 3->4->3 replacement)',
    'P3-lower':     'healing never lowers a voter count (except a gone voter '
                    'with a replacement candidate)',
    'P4-settle2':   'the shard never settles with two voters (except where the doc says)',
    'P4-settleeven':'the shard never settles with an even voter count',
    'P5-stuck':     'after faults stop, with a live majority, the shard elects and commits',
    'P6-paused':    'a leave never removes a voter that is only paused',
    'P7-draining':  'no healing step adds or promotes a draining or departed member',
}

# --------------------------------------------------------------------------
# interning: entries, sub-tuples

ENT = []
ENT_ID = {}


def ent(term, kind, data):
    k = (term, kind, data)
    i = ENT_ID.get(k)
    if i is None:
        i = len(ENT)
        ENT.append(k)
        ENT_ID[k] = i
    return i


_I = {}


def I(t):
    r = _I.get(t)
    if r is None:
        _I[t] = t
        r = t
    return r


_CFG = {}


def cfgs(log):
    """(latest, previous) configuration in a log; each (index, voters,
    learners, tag) or None."""
    r = _CFG.get(log)
    if r is None:
        latest = prev = None
        for idx in range(len(log) - 1, -1, -1):
            e = ENT[log[idx]]
            if e[1] == CFG:
                if latest is None:
                    latest = (idx + 1,) + e[2]
                else:
                    prev = (idx + 1,) + e[2]
                    break
        r = (latest, prev)
        _CFG[log] = r
    return r


_TAGS = {}


def tags_of(log):
    r = _TAGS.get(log)
    if r is None:
        r = frozenset(ENT[x][2][2] for x in log if ENT[x][1] == CFG)
        _TAGS[log] = r
    return r


_LP = {}


def last_promoted(log):
    """The voter added by the most recent change that added one."""
    r = _LP.get(log)
    if r is None:
        r = None
        cf = [ENT[x][2] for x in log if ENT[x][1] == CFG]
        for k in range(len(cf) - 1, 0, -1):
            a, b = set(cf[k][0]), set(cf[k - 1][0])
            if len(a) == len(b) + 1 and b < a:
                r = (a - b).pop()
                break
        _LP[log] = r
    return r


_PV = {}


def prev_voters(log):
    """The voter set just before the most recent change of the voter set
    (learner-only changes skipped), or None."""
    r = _PV.get(log, 0)
    if r == 0:
        r = None
        cf = [ENT[x][2] for x in log if ENT[x][1] == CFG]
        for k in range(len(cf) - 1, 0, -1):
            if cf[k][0] != cf[k - 1][0]:
                r = cf[k - 1][0]
                break
        _PV[log] = r
    return r


def own_voter(log, r):
    c = cfgs(log)[0]
    return c is not None and r in c[1]


def lcp(a, b):
    n = min(len(a), len(b))
    i = 0
    while i < n and a[i] == b[i]:
        i += 1
    return i


def last_term(log):
    return ENT[log[-1]][0] if log else 0


def uptodate(a, b):
    """log a is at least as up to date as log b (Raft's vote rule)."""
    ta, tb = last_term(a), last_term(b)
    return ta > tb or (ta == tb and len(a) >= len(b))


def maj(k):
    return k // 2 + 1


def tadd(t, x):
    return tuple(sorted(t + (x,)))


def tdel(t, x):
    return tuple(y for y in t if y != x)


def freeze(mems, reps, nf, nl, nc, com, win):
    return (I(tuple(I(tuple(m)) for m in mems)),
            I(tuple(I(tuple(r)) for r in reps)),
            nf, nl, nc, I(com), win)


# --------------------------------------------------------------------------
# the commit rule

def advance(mems, reps, L, com):
    """Advance leader L's commit index (reps is a mutable list). Returns
    (com, violation or None)."""
    r = reps[L]
    log, term = r[LOG], r[TERM]
    V = cfgs(log)[0][1]
    need = maj(len(V))
    newc = r[COMMIT]
    for n in range(len(log), r[COMMIT], -1):
        if ENT[log[n - 1]][0] != term:
            break
        cnt = 0
        for (m, i) in V:
            if mems[m][INC] != i:
                continue
            if m == L or lcp(reps[m][LOG], log) >= n:
                cnt += 1
        if cnt >= need:
            newc = n
            break
    viol = None
    if newc != r[COMMIT]:
        reps[L] = (r[TERM], r[VOTED], log, r[LEADER], newc)
        lc = len(com)
        if newc >= lc:
            if log[:lc] != com:
                viol = ('P1-prefix', 'leader %d commits over a committed entry' % L)
            com = log[:newc]
        elif log[:newc] != com[:newc]:
            viol = ('P1-prefix', 'leader %d commit disagrees with the committed log' % L)
    return com, viol


# --------------------------------------------------------------------------
# the successor function

class Ctx:
    """Per-state derived facts, shared by actions and checks."""
    __slots__ = ('up', 'resp', 'side', 'inc', 'rid', 'lk', 'leaders', 'heard')

    def __init__(self, s):
        mems, reps = s[0], s[1]
        N = len(mems)
        self.up = up = [m[UP] for m in mems]
        self.resp = [m[UP] and not m[PAUSED] for m in mems]
        self.side = side = [m[SIDE] for m in mems]
        self.inc = inc = [m[INC] for m in mems]
        self.rid = [(m, inc[m]) for m in range(N)]
        self.lk = [[a != b and up[a] and up[b] and side[a] == side[b]
                    for b in range(N)] for a in range(N)]
        self.leaders = [L for L in range(N) if reps[L][LEADER] and self.resp[L]]
        heard = [False] * N
        for L in self.leaders:
            c = cfgs(reps[L][LOG])[0]
            mem = set(c[1]) | set(c[2])
            for m in range(N):
                if (m != L and self.lk[L][m] and self.rid[m] in mem
                        and reps[L][TERM] >= reps[m][TERM]):
                    heard[m] = True
        self.heard = heard


def can_change(s, L):
    r = s[1][L]
    c, log = r[COMMIT], r[LOG]
    own = c >= 1 and ENT[log[c - 1]][0] == r[TERM]
    if not own and 'no-own-term' not in G.MUT:
        return False
    if cfgs(log)[0][0] > c and 'no-config-wait' not in G.MUT:
        return False
    return True


def send_all(mems, rs, L, cx):
    """Unless --fine: a new entry reaches, in the same step, every reachable
    and responsive member of the leader's configuration (rs is mutated)."""
    if G.FINE:
        return
    rL = rs[L]
    log = rL[LOG]
    c = cfgs(log)[0]
    for (m, i) in c[1] + c[2]:
        if m == L or mems[m][INC] != i or not cx.lk[L][m] or not cx.resp[m]:
            continue
        rf = rs[m]
        if rf[TERM] > rL[TERM]:
            continue
        rs[m] = (rL[TERM], rf[VOTED] if rf[TERM] == rL[TERM] else -1, log, False, 0)


def elect(s, cx, c, T, forced, from_leader, label):
    """Candidate c stands in term T. Returns a successor (label, state, viols)."""
    mems, reps, nf, nl, nc, com, win = s
    N = len(mems)
    reps = list(reps)
    rc = reps[c]
    V = cfgs(rc[LOG])[0][1]
    grants = 1
    voters_granting = [c]
    for (m, i) in V:
        if m == c:
            continue
        ghost = mems[m][INC] != i
        if ghost and 'ghost-votes' not in G.MUT:
            continue
        if not (cx.lk[c][m] and cx.resp[m]):
            continue
        rm = reps[m]
        if rm[TERM] > T:
            continue
        if rm[TERM] < T:
            rm = (T, -1, rm[LOG], False, 0)
        ok = rm[VOTED] in (-1, c) and uptodate(rc[LOG], rm[LOG])
        if ok and 'learner-no-vote' in G.MUT:
            if not own_voter(rm[LOG], cx.rid[m]):
                ok = False
        if ok:
            rm = (rm[TERM], c, rm[LOG], False, 0)
            grants += 1
            voters_granting.append(m)
        reps[m] = rm
    if from_leader is not None:
        rl = reps[from_leader]
        reps[from_leader] = (max(rl[TERM], T), rl[VOTED] if rl[TERM] >= T else -1,
                             rl[LOG], False, 0)
    viols = []
    won = grants >= maj(len(V))
    if won:
        newlog = I(rc[LOG] + (ent(T, NOOP, None),))
        if rc[LOG][:len(com)] != com:
            viols.append(('P1-complete',
                          'member %d wins term %d without committed entry %d'
                          % (c, T, lcp(rc[LOG], com) + 1)))
        reps[c] = (T, c, newlog, True, 0)
        send_all(mems, reps, c, cx)
        prev = win[T]
        if prev != -1 and prev != c:
            viols.append(('P1-election', 'members %d and %d both lead term %d'
                          % (prev, c, T)))
        win = win[:T] + (c,) + win[T + 1:]
        com, v = advance(mems, reps, c, com)
        if v:
            viols.append(v)
        lab = (label, c, T, tuple(sorted(voters_granting)))
    else:
        reps[c] = (T, c, rc[LOG], False, 0)
        lab = (label + '-lost', c, T, tuple(sorted(voters_granting)))
    return (lab, freeze(mems, reps, nf, nl, nc, com, win), viols)


def config_steps(s, cx, L):
    """The doc's healing and leave steps leader L may take now. Each is
    (rule, subject member, new voters, new learners, extra)."""
    mems, reps = s[0], s[1]
    N = len(mems)
    r = reps[L]
    log, commit = r[LOG], r[COMMIT]
    latest = cfgs(log)[0]
    V, Lr = latest[1], latest[2]
    Vs, Ls = set(V), set(Lr)
    rid, up, lk = cx.rid, cx.up, cx.lk
    MUT = G.MUT
    steps = []

    def link(m):
        return m == L or lk[L][m]

    def gone_m(m):
        return mems[m][GONE] and not link(m)

    def live_m(m):
        return up[m] and link(m)

    def v_gone(v):
        m, i = v
        if mems[m][INC] != i and up[m] and link(m):
            return True          # cannot vouch: its member came back as a new replica
        return gone_m(m)

    cands = [m for m in range(N)
             if not mems[m][DRAIN] and not mems[m][LEFT] and not gone_m(m)]
    live_c = [m for m in cands if live_m(m)]
    nv, nlive = len(V), len(live_c)
    if 'heal-lower' in MUT:
        k = max(1, min(G.COPIES, nlive))
    elif 'promote-even' in MUT:
        k = G.COPIES if nlive >= G.COPIES else max(min(nv, G.COPIES), min(nlive, G.COPIES))
    else:
        k = G.COPIES if nlive >= G.COPIES else min(nv, G.COPIES)
    if k == 1:
        # "Its one voter stays the incumbent across restarts."
        incumbent = [v[0] for v in V if v[0] in cands and v == rid[v[0]]]
        T = incumbent[:1] if incumbent else cands[:1]
    else:
        T = cands[:k]
    Tset = set(T)
    # CheckQuorum: a leader cut off from a majority of its voters steps down
    # within election.ms, before evict.after or the leave's probe window can
    # end. So steps that act on a link long down need a leader with quorum.
    quorum = sum(1 for (m, i) in V if mems[m][INC] == i and link(m) and up[m]) >= maj(len(V))

    # ---- healing ------------------------------------------------------
    # a gone voter: removed only when a replacement candidate exists
    for v in V:
        if v_gone(v) and quorum:
            repl = [m for m in live_c if rid[m] not in Vs]
            surplus = 'gone-surplus' in G.FIX and nv - 1 >= max(k, 1) and (nv - 1) % 2 == 1
            if repl or surplus or 'gone-no-repl' in MUT:
                steps.append(('heal-gone', v[0], tdel(V, v), tdel(Lr, v), v))
    # add a live candidate as a learner
    for m in live_c:
        if rid[m] not in Vs and rid[m] not in Ls:
            steps.append(('heal-add', m, V, tadd(Lr, rid[m]), rid[m]))
            break                                  # best rank first
    # promote a caught-up learner in the target
    for l in Lr:
        m = l[0]
        if l != rid[m] or m not in Tset or not live_m(m):
            continue
        if 'promote-uncaught' not in MUT and lcp(reps[m][LOG], log) < commit - G.LAG:
            continue
        ok = False
        if nv < k:
            if (nv + 1) % 2 == 1 or (nv == 1 and nlive >= G.COPIES) or 'promote-even' in MUT:
                ok = True
        elif nv == k:
            if any(u[0] not in Tset and live_m(u[0]) and not v_gone(u) for u in V):
                ok = True                          # a replacement, 3 -> 4 -> 3
        if ok:
            steps.append(('heal-promote', m, tadd(V, l), tdel(Lr, l), l))
            break
    # a live voter not in the target: removed once its replacement is a
    # voter at the leader's commit offset, exactly
    inT = [v for v in V if v[0] in Tset and v == rid[v[0]]]
    for u in V:
        m = u[0]
        if (m in Tset and u == rid[m]) or v_gone(u) or not live_m(m):
            continue                     # (a leader may remove itself, then steps down)
        if mems[m][INC] != u[1]:
            continue
        if len(inT) < k:
            continue
        rp = last_promoted(log)
        need = commit - G.LAG if 'live-remove-lag' in MUT else commit
        if rp is None or rp not in inT or lcp(reps[rp[0]][LOG], log) < need:
            continue
        nl_ = tadd(Lr, u) if (m in cands and u not in Ls) else Lr
        steps.append(('heal-rmlive', m, tdel(V, u), nl_, u))
    if 'heal-lower' in MUT and nv > k:
        for u in V:
            if u[0] not in Tset or v_gone(u):
                if u[0] != L:
                    steps.append(('heal-shrink', u[0], tdel(V, u), tdel(Lr, u), u))
    # a learner whose member is gone, draining, departed or a stale disk
    for l in Lr:
        m = l[0]
        stale = l != rid[m] and up[m] and link(m)
        if stale or mems[m][DRAIN] or mems[m][LEFT] or gone_m(m):
            steps.append(('heal-rmlearner', m, V, tdel(Lr, l), l))

    # ---- the leave ----------------------------------------------------
    for m in range(N):
        if not mems[m][LEAVING] or not up[m]:
            continue
        lid = rid[m]
        if lid in Ls and L != m:
            steps.append(('leave-learner', m, V, tdel(Lr, lid), lid))
        if lid not in Vs:
            continue
        promoted = ('leave-promote', m) in tags_of(log)
        caught = [l for l in Lr if l == rid[l[0]] and live_m(l[0])
                  and not mems[l[0]][DRAIN] and not mems[l[0]][LEFT]
                  and lcp(reps[l[0]][LOG], log) >= commit - G.LAG]
        no_promote = 'leave-no-promote' in MUT
        if not promoted and caught and not no_promote:
            l = caught[0]
            steps.append(('leave-promote', m, tadd(V, l), tdel(Lr, l), l))
        if promoted or not caught or no_promote:
            def live_leave(v):
                mm, i = v
                if mems[mm][INC] != i:
                    return False
                if mm == L:
                    return True
                if not lk[L][mm]:
                    return False
                if 'leave-paused' in MUT and mems[mm][PAUSED]:
                    return False
                return True
            rest = tdel(V, lid)
            safe = len(rest) >= 1 and sum(live_leave(v) for v in rest) >= maj(len(rest))
            exact = True
            if 'leave-exact' in G.FIX:
                # the fix: the replacement must hold the leader's commit offset
                rp = last_promoted(log)
                if rp is not None and rp in Vs and rp != lid and lcp(reps[rp[0]][LOG], log) < commit:
                    exact = False
            if L != m and len(rest) >= 1 and exact and (safe or 'leave-always-remove' in MUT):
                steps.append(('leave-leaver', m, rest, Lr, lid))
            if not safe and quorum and 'leave-no-dead' not in MUT:
                for d in rest:
                    if not live_leave(d):
                        rest2 = tdel(V, d)
                        if sum(live_leave(v) for v in rest2) >= maj(len(rest2)):
                            steps.append(('leave-dead', d[0], rest2, tdel(Lr, d), d))
    return steps, (V, Lr, k, Tset, nlive, live_c)


HEAL_ORDER = ['heal-gone', 'heal-shrink', 'heal-add', 'heal-promote', 'heal-rmlive', 'heal-rmlearner']
LEAVE_ORDER = ['leave-promote', 'leave-dead', 'leave-leaver', 'leave-learner']


def ordered(steps):
    """Healing takes its next step by the doc's order (remove a gone voter,
    add its replacement as a learner, promote it, remove a live voter not in
    the target, drop stale learners); the leave takes its own next step. The
    two interleave freely. (--any-order offers every enabled step.)"""
    out = []
    for order in (HEAL_ORDER, LEAVE_ORDER):
        best = None
        for st in steps:
            if st[0] in order and (best is None or order.index(st[0]) < order.index(best[0])):
                best = st
        if best is not None:
            out.append(best)
    return out


def holders(mems, reps, V, com, j):
    """Vouching voters of V that hold committed entry j (1-based)."""
    n = 0
    for (m, i) in V:
        if mems[m][INC] == i and lcp(reps[m][LOG], com) >= j:
            n += 1
    return n


def check_step(s, cx, L, step, info):
    """Properties of one healing or leave step (P2, P3, P6, P7)."""
    mems, reps, com = s[0], s[1], s[5]
    rule, subj, Vn, Ln, who = step
    V, Lr, k, Tset, nlive, live_c = info
    log = reps[L][LOG]
    viols = []
    if len(Vn) < len(V):                                    # a removal
        removed = who
        pv = prev_voters(log)
        base = V
        if pv is not None and len(pv) + 1 == len(V) and set(pv) < set(V):
            base = pv                                       # promoted a replacement, then remove
        for j in range(len(com), 0, -1):
            hb = holders(mems, reps, base, com, j)
            ha = holders(mems, reps, Vn, com, j)
            if ha < hb:
                kind = rule
                if rule == 'leave-leaver':
                    kind = 'leave-leaver-after-promote' if base is not V else 'leave-leaver-no-replacement'
                viols.append(('P2-holders', '%s removes %s: committed entry %d held by %d '
                              'vouching voters before, %d after' % (kind, removed, j, hb, ha), kind))
                break
        if rule.startswith('heal-'):
            if rule == 'heal-gone':
                pass                                        # sanctioned transient
            elif len(Vn) < min(k, G.COPIES) or (rule != 'heal-rmlive'):
                viols.append(('P3-lower', '%s lowers the voter count %d -> %d'
                              % (rule, len(V), len(Vn)), rule))
        if rule in ('leave-dead',):
            m = removed[0]
            if mems[m][UP] and mems[m][INC] == removed[1] and (m == L or cx.lk[L][m]):
                viols.append(('P6-paused', 'the leave removes voter %d, which is up and '
                              'linked (paused=%s)' % (m, mems[m][PAUSED]), rule))
    if rule == 'heal-promote' and len(Vn) % 2 == 0:
        replacing = any(u[0] not in Tset for u in V)
        growth = len(V) == 1 and nlive >= G.COPIES
        if not (replacing or growth):
            viols.append(('P3-even', 'healing raises the voter count %d -> %d'
                          % (len(V), len(Vn)), rule))
    if rule in ('heal-promote', 'heal-add'):
        m = subj
        if mems[m][DRAIN] or mems[m][LEFT] or mems[m][LEAVING]:
            viols.append(('P7-draining', '%s targets member %d, which is leaving'
                          % (rule, m), rule))
    return viols


def exit_ready(s, cx, m):
    """The leaving member m exits once a leader that can change the
    configuration has nothing left to do for its leave: it is out, or kept
    as a voter because neither step is safe. A leaving leader first hands
    over when it can."""
    mems, reps = s[0], s[1]
    N = len(mems)
    busy = decided = False
    for L in cx.leaders:
        if L != m and not cx.lk[L][m]:
            continue
        if L == m:
            V = cfgs(reps[L][LOG])[0][1]
            for t in range(N):
                if (t != L and cx.rid[t] in V and cx.lk[L][t] and cx.resp[t]
                        and reps[t][LOG] == reps[L][LOG] and not mems[t][LEAVING]):
                    busy = True
        if not can_change(s, L):
            continue
        decided = True
        steps, _ = config_steps(s, cx, L)
        for st in steps:
            if st[0].startswith('leave-') and (st[1] == m or st[0] == 'leave-dead'):
                busy = True
    return decided and not busy


def urgent_exits(t):
    """A leave is bounded by leave.ms and its process exits as soon as its
    leader has decided: applied in the same step, not interleaved."""
    mems = t[0]
    if not any(mm[LEAVING] and mm[UP] for mm in mems):
        return t, ()
    done = []
    again = True
    while again:
        again = False
        mems, reps, nf, nl, nc, com, win = t
        cx = Ctx(t)
        for m in range(len(mems)):
            if mems[m][LEAVING] and mems[m][UP] and exit_ready(t, cx, m):
                ms = list(mems)
                ms[m] = (False, mems[m][INC], mems[m][SIDE], False, mems[m][GONE],
                         mems[m][DRAIN], False, True)
                rs = list(reps)
                r = reps[m]
                rs[m] = (r[TERM], r[VOTED], r[LOG], False, 0)
                t = freeze(ms, rs, nf, nl, nc, com, win)
                done.append(m)
                again = True
                break
    return t, tuple(done)


def succ(s, mode, tcap):
    out = succ0(s, mode, tcap)
    res = []
    for lab, t, v in out:
        t2, ex = urgent_exits(t)
        if ex:
            lab = ('then-exit', lab, ex)
        res.append((lab, t2, v))
    return res


def succ0(s, mode, tcap):
    """Successors. mode 0: everything; 1: protocol only (no faults, no
    recoveries); 2: protocol and recoveries (returns, heals), no faults."""
    mems, reps, nf, nl, nc, com, win = s
    N = len(mems)
    cx = Ctx(s)
    up, resp, lk, rid = cx.up, cx.resp, cx.lk, cx.rid
    out = []
    MUT = G.MUT

    # ---- protocol ----------------------------------------------------
    for m in range(N):
        if mems[m][PAUSED]:
            ms = list(mems)
            ms[m] = mems[m][:PAUSED] + (False,) + mems[m][PAUSED + 1:]
            out.append((('unpause', m), freeze(ms, reps, nf, nl, nc, com, win), None))

    for L in cx.leaders:
        rL = reps[L]
        logL = rL[LOG]
        latest = cfgs(logL)[0]
        members = set(latest[1]) | set(latest[2])
        # replicate. By default one step sends the leader's log to every
        # reachable, responsive member of its configuration (a follower lags
        # only by a fault: a crash, a partition or a pause). --fine sends to
        # one follower per step.
        targets = []
        for f in range(N):
            if f == L or not lk[L][f] or not resp[f] or rid[f] not in members:
                continue
            rf = reps[f]
            if rf[TERM] > rL[TERM]:
                continue
            if rf[LOG] != logL or rf[LEADER]:
                targets.append(f)
        groups = [[f] for f in targets] if G.FINE else ([targets] if targets else [])
        for grp in groups:
            rs = list(reps)
            for f in grp:
                rf = reps[f]
                voted = rf[VOTED] if rf[TERM] == rL[TERM] else -1
                rs[f] = (rL[TERM], voted, logL, False, 0)
            c2, v = advance(mems, rs, L, com)
            out.append((('rep', L, tuple(grp)), freeze(mems, rs, nf, nl, nc, c2, win), [v] if v else None))
        # CheckQuorum: step down when cut off from a majority, or on a higher term
        V = latest[1]
        reach = sum(1 for (m, i) in V if mems[m][INC] == i and
                    (m == L or (lk[L][m] and resp[m] and reps[m][TERM] <= rL[TERM])))
        higher = max([reps[m][TERM] for m in range(N) if lk[L][m] and resp[m]] + [0])
        removed = rid[L] not in V and latest[0] <= rL[COMMIT]
        if reach < maj(len(V)) or higher > rL[TERM] or removed:
            rs = list(reps)
            t = max(rL[TERM], higher)
            rs[L] = (t, rL[VOTED] if t == rL[TERM] else -1, logL, False, 0)
            out.append((('stepdown', L), freeze(mems, rs, nf, nl, nc, com, win), None))
        # client write
        c = rL[COMMIT]
        if (nc < G.E and not mems[L][LEAVING] and c >= 1 and ENT[logL[c - 1]][0] == rL[TERM]):
            rs = list(reps)
            rs[L] = (rL[TERM], rL[VOTED], I(logL + (ent(rL[TERM], CLIENT, nc),)), True, c)
            send_all(mems, rs, L, cx)
            c2, v = advance(mems, rs, L, com)
            out.append((('write', L, nc), freeze(mems, rs, nf, nl, nc + 1, c2, win), [v] if v else None))
        # healing and leave steps
        if can_change(s, L):
            steps, info = config_steps(s, cx, L)
            if not G.ANY:
                steps = ordered(steps)
            for step in steps:
                rule, subj, Vn, Ln, who = step
                e = ent(rL[TERM], CFG, (Vn, Ln, (rule, subj)))
                rs = list(reps)
                rs[L] = (rL[TERM], rL[VOTED], I(logL + (e,)), True, rL[COMMIT])
                send_all(mems, rs, L, cx)
                c2, v = advance(mems, rs, L, com)
                viols = check_step(s, cx, L, step, info)
                if v:
                    viols.append(v)
                out.append((('cfg', L, rule, subj, Vn, Ln, who), freeze(mems, rs, nf, nl, nc, c2, win),
                            viols or None))
        # leadership hand-over by a leaving leader (TimeoutNow)
        if mems[L][LEAVING]:
            for t in range(N):
                if t == L or rid[t] not in V or not lk[L][t] or not resp[t]:
                    continue
                if reps[t][LOG] != logL or mems[t][LEAVING]:
                    continue
                T = max(reps[t][TERM], rL[TERM]) + 1
                if T > tcap:
                    continue
                out.append(elect(s, cx, t, T, True, L, 'transfer'))
                break                             # to the best-ranked caught-up voter

    # campaigns (PreVote, then the vote), by voters of their own configuration
    for c in range(N):
        rc = reps[c]
        if not resp[c] or rc[LEADER] or cx.heard[c]:
            continue
        lc = cfgs(rc[LOG])[0]
        if lc is None:
            continue                                     # a new replica: no configuration
        V = lc[1]
        if rid[c] not in V:
            continue                                     # learners never stand
        pre = 1
        tmax = rc[TERM]
        for (m, i) in V:
            if m == c or not (lk[c][m] and resp[m]):
                continue
            tmax = max(tmax, reps[m][TERM])
            if mems[m][INC] != i and 'ghost-votes' not in MUT:
                continue
            if cx.heard[m] or not uptodate(rc[LOG], reps[m][LOG]):
                continue
            if 'learner-no-vote' in MUT and not own_voter(reps[m][LOG], rid[m]):
                continue
            pre += 1
        if pre < maj(len(V)):
            continue
        T = tmax + 1
        if T > tcap:
            continue
        out.append(elect(s, cx, c, T, False, None, 'elect'))

    # evict.after elapses (time passing, not a fault): the gone mark
    cc = cfgs(com)[0]
    known = set(x[0] for x in cc[1])          # voters: a gone learner is only dropped and re-added
    for m in range(N):
        mm = mems[m]
        if mm[GONE] or m not in known:
            continue
        cut = any(up[x] and cx.side[x] != mm[SIDE] for x in range(N))
        if (not mm[UP]) or cut:
            ms = list(mems)
            ms[m] = mm[:GONE] + (True,) + mm[GONE + 1:]
            out.append((('gone', m), freeze(ms, reps, nf, nl, nc, com, win), None))

    if mode == 1:
        return out

    # ---- recoveries (no budget) ---------------------------------------
    for m in range(N):
        mm = mems[m]
        if not mm[UP] and not mm[LEFT]:
            ms = list(mems)
            ms[m] = (True, mm[INC], mm[SIDE], False, False, mm[DRAIN], False, False)
            out.append((('return', m), freeze(ms, reps, nf, nl, nc, com, win), None))
        if mm[SIDE] == 1:
            ms = list(mems)
            ms[m] = mm[:SIDE] + (0, mm[PAUSED], False) + mm[GONE + 1:]
            out.append((('heal', m), freeze(ms, reps, nf, nl, nc, com, win), None))

    if mode == 2:
        return out

    # ---- faults (budgeted) --------------------------------------------
    if nf < G.F:
        for m in range(N):
            mm = mems[m]
            if mm[UP]:
                for keep in (True, False):
                    ms = list(mems)
                    rs = list(reps)
                    r = reps[m]
                    left = mm[LEAVING]          # a leaver that crashes is gone for good
                    if keep:
                        ms[m] = (False, mm[INC], mm[SIDE], False, mm[GONE], mm[DRAIN], False, left)
                        rs[m] = (r[TERM], r[VOTED], r[LOG], False, 0)
                    else:
                        ms[m] = (False, mm[INC] + 1, mm[SIDE], False, mm[GONE], mm[DRAIN], False, left)
                        rs[m] = (0, -1, (), False, 0)
                    out.append((('crash', m, keep), freeze(ms, rs, nf + 1, nl, nc, com, win), None))
                if mm[SIDE] == 0:
                    ms = list(mems)
                    ms[m] = mm[:SIDE] + (1,) + mm[SIDE + 1:]
                    out.append((('part', m), freeze(ms, reps, nf + 1, nl, nc, com, win), None))
                if not mm[PAUSED]:
                    ms = list(mems)
                    ms[m] = mm[:PAUSED] + (True,) + mm[PAUSED + 1:]
                    out.append((('pause', m), freeze(ms, reps, nf + 1, nl, nc, com, win), None))
                if mm[LEAVING]:
                    ms = list(mems)
                    ms[m] = (False, mm[INC], mm[SIDE], False, mm[GONE], mm[DRAIN], False, True)
                    rs = list(reps)
                    r = reps[m]
                    rs[m] = (r[TERM], r[VOTED], r[LOG], False, 0)
                    out.append((('cutoff', m), freeze(ms, rs, nf + 1, nl, nc, com, win), None))
    if nl < G.LV:
        for m in range(N):
            mm = mems[m]
            if mm[UP] and not mm[PAUSED] and not mm[LEAVING] and not mm[LEFT]:
                drain = G.META and 'no-draining' not in MUT
                ms = list(mems)
                ms[m] = (True, mm[INC], mm[SIDE], False, mm[GONE], drain or mm[DRAIN], True, False)
                out.append((('leave', m, drain), freeze(ms, reps, nf, nl + 1, nc, com, win), None))
    return out


# --------------------------------------------------------------------------
# state predicates

def live_voters(s, V):
    mems = s[0]
    return sum(1 for (m, i) in V if mems[m][UP] and mems[m][INC] == i and not mems[m][LEFT])


def reported(s, V):
    """The doc: cluster.health says so when a shard has fewer live voters than copies."""
    return live_voters(s, V) < G.COPIES


def writable(s, cx=None):
    """A leader, not leaving, that has committed in its term and reaches a
    majority of its configuration's voters that are not leaving (a leaver
    exits within leave.ms, so it cannot be counted on)."""
    mems, reps = s[0], s[1]
    if cx is None:
        cx = Ctx(s)
    for L in cx.leaders:
        if mems[L][LEAVING]:
            continue
        r = reps[L]
        c = r[COMMIT]
        if c < 1 or ENT[r[LOG][c - 1]][0] != r[TERM]:
            continue
        V = cfgs(r[LOG])[0][1]
        n = sum(1 for (m, i) in V if mems[m][INC] == i and not mems[m][LEAVING] and
                (m == L or (cx.lk[L][m] and cx.resp[m] and reps[m][TERM] <= r[TERM])))
        if n >= maj(len(V)):
            return L
    return None


def check_state(s):
    """State properties: P1-durable."""
    mems, reps, com = s[0], s[1], s[5]
    viols = []
    if not com:
        return viols
    cc = cfgs(com)[0]
    ic, V = cc[0], cc[1]
    if reported(s, V):
        return viols
    h = holders(mems, reps, V, com, ic)
    if h < maj(len(V)):
        viols.append(('P1-durable', 'the committed configuration %s (entry %d): entries up '
                      'to %d on %d of its voters, %d live voters, none reported'
                      % (fmt_set(V), ic, ic, h, live_voters(s, V)), 'majority'))
    h2 = holders(mems, reps, V, com, len(com))
    if h2 < len(V) - maj(len(V)) + 1:
        viols.append(('P1-durable', 'committed entry %d is on %d of %s: a majority can '
                      'miss it' % (len(com), h2, fmt_set(V)), 'intersection'))
    return viols


def settled(s, cx):
    """Healing has nothing left to do: a writable leader, nobody leaving or
    paused, every reachable config member caught up, no step enabled."""
    mems, reps = s[0], s[1]
    if any(m[PAUSED] or m[LEAVING] for m in mems):
        return None
    L = writable(s, cx)
    if L is None or not can_change(s, L):
        return None
    log = reps[L][LOG]
    latest = cfgs(log)[0]
    for (m, i) in latest[1]:
        if m != L and not cx.lk[L][m] and not mems[m][GONE]:
            return None                  # evict.after has not yet run out for it
    for (m, i) in latest[1] + latest[2]:
        if m != L and mems[m][INC] == i and cx.lk[L][m] and reps[m][LOG] != log:
            return None
    steps, _ = config_steps(s, cx, L)
    if steps:
        return None
    return L


# --------------------------------------------------------------------------
# formatting

def fmt_set(V):
    return '{' + ','.join(('%d' % m) if i == 0 else ('%d#%d' % (m, i)) for (m, i) in V) + '}'


RULE_TEXT = {
    'heal-gone': 'healing removes gone voter',
    'heal-add': 'healing adds learner',
    'heal-promote': 'healing promotes learner',
    'heal-rmlive': 'healing removes live voter (not in target)',
    'heal-rmlearner': 'healing removes learner',
    'heal-shrink': 'healing shrinks (mutant) removing',
    'leave-learner': 'the leave removes learner',
    'leave-promote': 'the leave promotes learner',
    'leave-leaver': 'the leave removes the leaver',
    'leave-dead': 'the leave removes dead voter',
}


def fmt_label(lab):
    k = lab[0]
    if k == 'then-exit':
        return '%s; then leaving member %s exits (its leave is done or decided)' % (
            fmt_label(lab[1]), ','.join(str(m) for m in lab[2]))
    if k == 'unpause':
        return 'member %d\'s pause ends' % lab[1]
    if k == 'rep':
        return 'leader %d replicates to %s' % (lab[1], ', '.join('member %d' % f for f in lab[2]))
    if k == 'stepdown':
        return 'leader %d steps down (CheckQuorum or a higher term)' % lab[1]
    if k == 'write':
        return 'leader %d appends client entry c%d' % (lab[1], lab[2])
    if k == 'cfg':
        _, L, rule, subj, Vn, Ln, who = lab
        what = fmt_set((who,))[1:-1]
        if rule.startswith('leave-') and who[0] != subj:
            what += ' (for the leave of %d)' % subj
        return 'leader %d: %s %s -> voters %s learners %s' % (
            L, RULE_TEXT.get(rule, rule), what, fmt_set(Vn), fmt_set(Ln))
    if k in ('elect', 'transfer'):
        how = 'is elected' if k == 'elect' else 'takes a hand-over and is elected'
        return 'member %d %s in term %d (votes %s)' % (lab[1], how, lab[2], list(lab[3]))
    if k in ('elect-lost', 'transfer-lost'):
        return 'member %d stands in term %d and loses (votes %s)' % (lab[1], lab[2], list(lab[3]))
    if k == 'exit':
        return 'leaving member %d exits (its leave is done or decided)' % lab[1]
    if k == 'gone':
        return 'member %d is marked gone (evict.after, or a planner)' % lab[1]
    if k == 'return':
        return 'member %d (re)starts' % lab[1]
    if k == 'heal':
        return 'member %d\'s partition heals' % lab[1]
    if k == 'crash':
        return 'member %d crashes (%s)' % (lab[1], 'disk kept' if lab[2] else 'DISK LOST')
    if k == 'part':
        return 'member %d is partitioned away' % lab[1]
    if k == 'pause':
        return 'member %d pauses (GC, shorter than the probe window)' % lab[1]
    if k == 'cutoff':
        return 'leaving member %d is cut off and exits mid-leave' % lab[1]
    if k == 'leave':
        return 'member %d gets Ctrl-C: leave%s' % (lab[1], ' (marked draining)' if lab[2] else ' (no draining mark)')
    return str(lab)


def fmt_entry(x):
    t, k, d = ENT[x]
    if k == NOOP:
        return 'n%d' % t
    if k == CLIENT:
        return 'c%d' % d
    return 'cfg%s' % fmt_set(d[0])


def fmt_state(s):
    mems, reps, nf, nl, nc, com, win = s
    lines = []
    for m in range(len(mems)):
        mm, r = mems[m], reps[m]
        flags = []
        if not mm[UP]:
            flags.append('LEFT' if mm[LEFT] else 'down')
        if mm[SIDE]:
            flags.append('partitioned')
        if mm[PAUSED]:
            flags.append('paused')
        if mm[GONE]:
            flags.append('gone')
        if mm[DRAIN]:
            flags.append('draining')
        if mm[LEAVING]:
            flags.append('leaving')
        lines.append('    m%d%s t%d %s%s [%s]' % (
            m, ('#%d' % mm[INC]) if mm[INC] else '', r[TERM], 'LEADER ' if r[LEADER] else '',
            ','.join(flags), ' '.join(fmt_entry(x) for x in r[LOG])))
    lines.append('    committed: %d entries, config %s' % (len(com), fmt_set(cfgs(com)[0][1]) if com else '-'))
    return '\n'.join(lines)


# --------------------------------------------------------------------------
# scenarios

def initial(kind):
    """Returns (N, initial state)."""
    if kind == 'three':
        N, V, Lr, present = 3, [0, 1, 2], [], [0, 1, 2]
    elif kind == 'four':
        N, V, Lr, present = 4, [0, 1, 2], [3], [0, 1, 2, 3]
    elif kind == 'four-arrive':
        N, V, Lr, present = 4, [0, 1, 2], [], [0, 1, 2]
    elif kind == 'one':
        N, V, Lr, present = 3, [0], [1], [0, 1]
    elif kind == 'two':
        N, V, Lr, present = 2, [0], [1], [0, 1]
    else:
        raise SystemExit('unknown scenario ' + kind)
    G.N = N
    cfg0 = ent(1, CFG, (tuple((m, 0) for m in V), tuple((m, 0) for m in Lr), ('genesis', -1)))
    log = I((cfg0,))
    mems, reps = [], []
    for m in range(N):
        if m in present:
            mems.append((True, 0, 0, False, False, False, False, False))
            reps.append((1, 0, log, m == 0, 1 if m == 0 else 0))
        else:
            mems.append((False, 0, 0, False, False, False, False, False))
            reps.append((0, -1, I(()), False, 0))
    win = tuple([-1, 0] + [-1] * (G.MAXT + 4))
    return N, freeze(mems, reps, 0, 0, 0, log, win)


SCENARIOS = {
    # name: (initial, faults, leaves, client entries, max term, what)
    'two':         ('two', 2, 1, 1, 5, 'example 01: two processes, 1 voter and 1 learner'),
    'three':       ('three', 2, 1, 1, 5, '3 members, 3 voters'),
    'one':         ('one', 2, 1, 0, 5, 'a shard created below three candidates: '
                                       '1 voter, 1 learner, a third member starts later'),
    'four':        ('four', 2, 1, 0, 5, '4 members, 3 voters and a learner'),
    'four-2leave': ('four', 1, 2, 0, 5, '4 members, 3 voters and a learner, two leaves'),
    'four-arrive': ('four-arrive', 1, 1, 0, 5, '4 members, 3 voters, the 4th starts later'),
    # smaller bounds, for the mutants
    'three-m':     ('three', 2, 1, 0, 5, '3 members, 3 voters (mutant bounds)'),
    'one-m':       ('one', 1, 1, 0, 5, 'one voter, one learner, a third starts later (mutant bounds)'),
    'four-m':      ('four', 1, 1, 0, 5, '4 members, 3 voters and a learner (mutant bounds)'),
}

DEFAULT_SCENARIOS = ['two', 'three', 'one', 'four', 'four-2leave', 'four-arrive']

FIXES = {
    'leave-exact':  'the leave removes the leaver only once its promoted replacement '
                    'holds the leader\'s commit offset, exactly',
    'gone-surplus': 'a gone voter is removed with no replacement when the voters left '
                    'are still an odd number at or above the target',
}

MUTANTS = {
    'gone-no-repl':      'healing removes a gone voter with no replacement candidate (E1)',
    'heal-lower':        'healing shrinks the voter count to the live candidates (E1)',
    'promote-even':      'healing raises a voter count to two (F2, R-80)',
    'promote-uncaught':  'healing promotes a learner before it caught up',
    'live-remove-lag':   'a live voter is removed when its replacement is only within lag.max (H-172, R-72)',
    'leave-paused':      'the leave counts a merely paused voter as dead (R-58)',
    'leave-no-dead':     'the leave never removes dead voters first (S-207, R-77, V4-60)',
    'leave-no-promote':  'the leave removes the leaver without promoting a learner first (R-62)',
    'leave-always-remove': 'the leave removes the leaver even when that loses the live majority',
    'no-draining':       'the leave writes no draining mark (D-081, R-64)',
    'learner-no-vote':   'a learner refuses votes (S-037, R-76)',
    'ghost-votes':       'a replica that lost its disk votes under its old identity (R-54)',
    'no-own-term':       'a new leader changes the configuration before committing in its term',
    'no-config-wait':    'a change is appended before the previous one committed',
}


# --------------------------------------------------------------------------
# the search

class Result:
    def __init__(self):
        self.viol = {}        # (prop, kind) -> (state index, label, text, depth)
        self.count = {}       # (prop, kind) -> count
        self.settled = {}     # voters count -> number of settled states
        self.settle_ex = {}   # (nvoters, cause) -> state index
        self.states = 0
        self.edges = 0
        self.secs = 0.0
        self.stuck = {}       # class -> (count, example index)
        self.capped = 0


def explore(scn, mutants=frozenset(), quiet=False, limit=None, liveness=True):
    init_kind, F, LV, E, MAXT, _ = SCENARIOS[scn]
    G.F, G.LV, G.E, G.MAXT, G.MUT = F, LV, E, MAXT, frozenset(mutants)
    G.META = True
    N, s0 = initial(init_kind)
    t0 = time.time()
    index = {s0: 0}
    states = [s0]
    parent = array('i', [-1])
    acts = [None]
    depth = array('h', [0])
    R = Result()
    labels = {}

    def record(prop, kind, i, lab, text):
        key = (prop, kind)
        R.count[key] = R.count.get(key, 0) + 1
        if key not in R.viol:
            R.viol[key] = (i, lab, text, depth[i] + (1 if lab is not None else 0))

    i = 0
    while i < len(states):
        s = states[i]
        for v in check_state(s):
            record(v[0], v[2], i, None, v[1])
        cx = Ctx(s)
        L = settled(s, cx)
        if L is not None:
            V = cfgs(s[1][L][LOG])[0][1]
            nv = len(V)
            R.settled[nv] = R.settled.get(nv, 0) + 1
            if nv % 2 == 0:
                cause = settle_cause(s, L)
                back = any(m != L and not cx.lk[L][m] and not s[0][m][LEFT] and not s[0][m][DRAIN]
                           for m in range(len(s[0])))
                cause += ', until a member returns' if back else ', permanent'
                key = (nv, cause)
                if key not in R.settle_ex:
                    R.settle_ex[key] = i
                prop = 'P4-settle2' if nv == 2 else 'P4-settleeven'
                record(prop, cause, i, None, 'settled with voters %s; the count was last set by %s'
                       % (fmt_set(V), cause))
        for lab, t, viols in succ(s, 0, G.MAXT):
            R.edges += 1
            lab = labels.setdefault(lab, lab)
            j = index.get(t)
            if j is None:
                j = len(states)
                index[t] = j
                states.append(t)
                parent.append(i)
                acts.append(lab)
                depth.append(depth[i] + 1)
            if viols:
                for v in viols:
                    record(v[0], v[2] if len(v) > 2 else '', i, lab, v[1])
        i += 1
        if not quiet and i % 200000 == 0:
            print('   ... %d states, %d queued, %.0fs' % (i, len(states) - i, time.time() - t0),
                  file=sys.stderr)
        if limit and len(states) > limit:
            print('   state limit hit', file=sys.stderr)
            break
    R.states = len(states)
    R.secs = time.time() - t0
    R.index, R.states_list, R.parent, R.acts = index, states, parent, acts
    if liveness:
        stuck_pass(R)
    R.secs = time.time() - t0
    return R


def settle_cause(s, L):
    """Which step last set the voter count of leader L's configuration."""
    log = s[1][L][LOG]
    cf = [ENT[x][2] for x in log if ENT[x][1] == CFG]
    for k in range(len(cf) - 1, 0, -1):
        if len(cf[k][0]) != len(cf[k - 1][0]):
            return cf[k][2][0]
    return 'genesis'


# --------------------------------------------------------------------------
# liveness: after faults stop, can the shard elect and commit?

def stuck_pass(R):
    """For every reachable state: is there a fault-free path (protocol
    actions only, no returns) to a writable state with no leave in progress?
    States with none are 'stuck'. Each is then classified, and checked again
    with returns and heals allowed (no new faults)."""
    states, index = R.states_list, R.index
    n = len(states)
    res = bytearray(n)              # 0 unknown, 1 can progress, 2 stuck
    extra = {}                       # states outside the main set
    tcap = G.MAXT + 3

    def known(t):
        j = index.get(t)
        if j is not None:
            return res[j]
        return extra.get(t, 0)

    def setk(t, val):
        j = index.get(t)
        if j is not None:
            res[j] = val
        else:
            extra[t] = val

    def search(s0, mode):
        # depth-first, memoised; True when a writable quiescent state is reachable
        if mode == 1:
            k = known(s0)
            if k:
                return k == 1
        seen = {s0: None}
        stack = [s0]
        while stack:
            s = stack.pop()
            if writable(s) is not None:
                if mode == 1:
                    t = s
                    while t is not None:
                        setk(t, 1)
                        t = seen[t]
                return True
            for lab, t, _ in succ(s, mode, tcap):
                if t in seen:
                    continue
                if mode == 1:
                    k = known(t)
                    if k == 2:
                        continue
                    if k == 1:
                        u = s
                        while u is not None:
                            setk(u, 1)
                            u = seen[u]
                        return True
                seen[t] = s
                stack.append(t)
        if mode == 1:
            for t in seen:
                setk(t, 2)
        return False

    for j in range(n - 1, -1, -1):
        if res[j]:
            continue
        search(states[j], 1)

    classes = {}
    for j in range(n):
        if res[j] != 2:
            continue
        s = states[j]
        cls = classify_stuck(s, search)
        c = classes.get(cls)
        if c is None:
            classes[cls] = [1, j]
        else:
            c[0] += 1
    R.stuck = classes
    R.live = res
    for cls, (cnt, j) in classes.items():
        if cls[0] == 'LIVE MAJORITY':
            key = ('P5-stuck', 'live majority, ' + cls[1])
            R.count[key] = cnt
            R.viol[key] = (j, None, 'no fault-free path to a writable leader, though a '
                           'majority of every configuration is live', 0)


def classify_stuck(s, search):
    """Why a stuck state is stuck. A leaving member counts as gone: its leave
    is bounded by leave.ms and it exits."""
    mems, reps, com = s[0], s[1], s[5]
    N = len(mems)
    cfgsets = [cfgs(com)[0][1]]
    for m in range(N):
        if mems[m][UP] and not mems[m][LEAVING]:
            c = cfgs(reps[m][LOG])[0]
            if c and c[1] not in cfgsets:
                cfgsets.append(c[1])

    def alive(m, i):
        return mems[m][UP] and mems[m][INC] == i and not mems[m][LEAVING]

    def live_majority(V):
        best = 0
        for side in (0, 1):
            n = sum(1 for (m, i) in V if alive(m, i) and mems[m][SIDE] == side)
            best = max(best, n)
        return best >= maj(len(V))
    lm = all(live_majority(V) for V in cfgsets)
    V = cfgsets[0]
    # would the majority be live if the leavers had stayed (up, with their disks)?
    def alive2(m, i):
        return mems[m][INC] == i and (mems[m][UP] or mems[m][LEFT])
    best = 0
    for side in (0, 1):
        best = max(best, sum(1 for (m, i) in V if alive2(m, i) and mems[m][SIDE] == side))
    leaver_voter = best >= maj(len(V)) and any(
        (mems[m][LEFT] or mems[m][LEAVING]) and mems[m][INC] == i for (m, i) in V)
    ghost_voter = any(mems[m][INC] != i for (m, i) in V)
    perm = not search(s, 2)
    if lm:
        why = 'LIVE MAJORITY'
    elif leaver_voter:
        why = 'a leaver kept as a voter'
    elif len(V) == 1:
        why = 'one voter, down'
    elif len(V) == 2:
        why = 'two voters, one down'
    elif ghost_voter:
        why = 'voters lost disks'
    else:
        why = 'majority down or cut off'
    return (why, 'permanent' if perm else 'until a member returns')


# --------------------------------------------------------------------------
# reporting

def trace(R, i, lab=None):
    steps = []
    j = i
    while j > 0:
        steps.append(R.acts[j])
        j = R.parent[j]
    steps.reverse()
    if lab is not None:
        steps.append(lab)
    return steps


def print_trace(R, i, lab=None, out=sys.stdout, final=True):
    for n, a in enumerate(trace(R, i, lab), 1):
        print('    %2d. %s' % (n, fmt_label(a)), file=out)
    if final:
        s = R.states_list[i]
        if lab is not None:
            for l2, t, _ in succ(s, 0, G.MAXT + 3):
                if l2 == lab:
                    s = t
                    break
        print('   final state:', file=out)
        print(fmt_state(s), file=out)


def report(scn, R, out=sys.stdout, traces=True):
    _, F, LV, E, MAXT, what = SCENARIOS[scn]
    print('== %s: %s' % (scn, what), file=out)
    print('   bounds: faults %d, leaves %d, client entries %d, terms <= %d; mutants %s; fixes %s; %s'
          % (F, LV, E, MAXT, ','.join(sorted(G.MUT)) or 'none', ','.join(sorted(G.FIX)) or 'none',
             ('per-follower replication' if G.FINE else 'append-and-send') +
             (', any step order' if G.ANY else '')), file=out)
    print('   %d states, %d transitions, %.1fs' % (R.states, R.edges, R.secs), file=out)
    print('   settled states by voter count: %s' % dict(sorted(R.settled.items())), file=out)
    held = [p for p in PROPS if not any(k[0] == p for k in R.viol)]
    print('   held: %s' % ' '.join(held), file=out)
    for key in sorted(R.viol):
        i, lab, text, d = R.viol[key]
        print('   VIOLATED %s [%s] x%d: %s' % (key[0], key[1], R.count[key], text), file=out)
        if traces:
            print('   shortest trace (%d steps):' % d, file=out)
            print_trace(R, i, lab, out)
    if R.stuck:
        print('   stuck states (no fault-free path to a writable leader):', file=out)
        for cls, (cnt, j) in sorted(R.stuck.items(), key=lambda kv: -kv[1][0]):
            print('     %-34s %-24s x%d' % (cls[0], cls[1], cnt), file=out)
            if traces:
                print_trace(R, j, None, out)
    print(file=out)


def summary_line(scn, R):
    return '%s: %d states; violated: %s' % (
        scn, R.states, ', '.join(sorted(set(k[0] for k in R.viol))) or 'none')


# Mutants run on smaller bounds, so all fourteen finish in minutes.
MUTANT_SCENARIOS = ['two', 'three-m', 'one-m', 'four-m']


def signature(R):
    """What a run found: violation keys, and stuck classes (as P5 keys)."""
    sig = set(R.viol)
    for cls in R.stuck:
        sig.add(('P5-stuck', cls[0] + ', ' + cls[1]))
    return sig


def run_mutants(scns, mutants, a):
    print('Mutants: each removes one rule; caught = it adds a violation or a stuck class '
          'the design as written does not have, on the same bounds.')
    base = {}
    for scn in scns:
        G.FIX = frozenset()
        R = explore(scn, set(), quiet=True, limit=a.limit, liveness=not a.no_liveness)
        base[scn] = signature(R)
        print('  baseline %-8s %8d states, %.0fs' % (scn, R.states, R.secs))
        sys.stdout.flush()
    for mu in mutants:
        print('-- mutant %s: %s' % (mu, MUTANTS[mu]))
        caught_any = False
        for scn in scns:
            R = explore(scn, {mu}, quiet=True, limit=a.limit, liveness=not a.no_liveness)
            new = sorted(signature(R) - base[scn])
            caught_any = caught_any or bool(new)
            print('   %-8s %8d states  %s' % (scn, R.states, 'caught by:' if new else 'not caught'))
            shown = set()
            for key in new:
                if key[0] in shown and key[0] != 'P5-stuck':
                    continue
                shown.add(key[0])
                if key in R.viol:
                    i, lab, text, d = R.viol[key]
                    print('      %s [%s]: %s (%d steps)' % (key[0], key[1], text, d))
                else:
                    print('      %s [%s]' % key)
                if a.mutant_traces and key in R.viol:
                    i, lab, text, d = R.viol[key]
                    print_trace(R, i, lab, sys.stdout, final=False)
        print('   => %s' % ('CAUGHT' if caught_any else 'NOT CAUGHT'))
        sys.stdout.flush()


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--scenario', action='append', help='scenario(s) to run (default: all)')
    ap.add_argument('--mutant', action='append', default=[], help='run with this rule removed')
    ap.add_argument('--mutants', action='store_true', help='run every mutant on every scenario')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--mutant-traces', action='store_true', help='with --mutants: print each new trace')
    ap.add_argument('--no-liveness', action='store_true')
    ap.add_argument('--no-traces', action='store_true')
    ap.add_argument('--faults', type=int)
    ap.add_argument('--leaves', type=int)
    ap.add_argument('--entries', type=int)
    ap.add_argument('--limit', type=int)
    ap.add_argument('--fine', action='store_true', help='replicate to one follower per step')
    ap.add_argument('--any-order', action='store_true', help='healing may take any enabled step')
    ap.add_argument('--fix', action='append', default=[], help='apply a proposed fix: ' + ', '.join(FIXES))
    ap.add_argument('--maxterm', type=int)
    a = ap.parse_args()
    if a.list:
        for k, v in SCENARIOS.items():
            print('%-12s %s (faults %d, leaves %d, entries %d)' % (k, v[5], v[1], v[2], v[3]))
        print()
        for k, v in MUTANTS.items():
            print('%-20s %s' % (k, v))
        return
    G.FINE = a.fine
    G.ANY = a.any_order
    G.FIX = frozenset(a.fix)
    scns = a.scenario or DEFAULT_SCENARIOS
    for scn in scns:
        b = list(SCENARIOS[scn])
        if a.faults is not None:
            b[1] = a.faults
        if a.leaves is not None:
            b[2] = a.leaves
        if a.entries is not None:
            b[3] = a.entries
        if a.maxterm is not None:
            b[4] = a.maxterm
        SCENARIOS[scn] = tuple(b)
    if a.mutants:
        run_mutants(a.scenario or MUTANT_SCENARIOS, a.mutant or list(MUTANTS), a)
        return
    for scn in scns:
        R = explore(scn, set(a.mutant), limit=a.limit, liveness=not a.no_liveness)
        report(scn, R, traces=not a.no_traces)
        sys.stdout.flush()


if __name__ == '__main__':
    main()
