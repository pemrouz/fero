"""
grow.py: E-59's model. Groups that start at one voter (growth to three, a
crash between the two promotions, the step back from two voters to one, a
gone learner dropped) and a clean stop (a leave with no spare, leave.ms, a
retire that stays pending, the leave of an only voter), on a Raft core with
terms, votes and a log per member.

WHAT IS REUSED, UNCHANGED.
  * The rule language is E-17's harness/dsl.py, through E-16's engine
    (../../E16-controller-loop/engine/engine.py): one rule is one guard
    conjunct or one state update; mutants and the ablation are mechanical.
  * E-52's healing rules (healing-self: add, promote, remove, surplus,
    dropl; rule 15's pick; promote only a learner that answers now; P7, LD,
    P9) with E-52's names, as LAYERS 2.3 states them after V5-10.

WHAT IS NEW: THE WORLD (not counted as design rules).
  * A Raft core per member, not E-16's abstract group: a term, a vote, a log
    of entries (term, payload) and a commit index per member, and a role
    (follower, candidate, leader). Payloads: the founding entry (config,
    placement), a config (voters, learners), a placement, a no-op, a write.
    Membership applies on commit (etcd, raft-config): a member's config is
    the last config entry at or below its own commit index. A leader counts
    acks with its applied config, only an entry of its own term (raft-commit),
    and steps down when its applied config drops it (etcd StepDownOnRemoval).
    Only a voter of its own applied config stands; learners grant votes.
    These are written as actions with role 'raft' so the properties can be
    shown to catch their removal (pass 1), but they are pinned in the
    ablation of the design: raft-* records count them, and E-10, E-14b and
    E-14c checked them on etcd's code and spec.
  * Reductions (pinned, stated): replication sends the leader's whole log
    (E-14's CoarseAE); a member stands only while no up leader holds its
    term or a later one, one candidate at a time (E-14's LeaderLease), and
    only if a majority of its config would grant (PreVote); a candidate gives
    up only when it cannot win; any member that meets a higher term takes it
    (any message carries the term); a leader whose transfer is in flight
    proposes nothing (etcd's leadTransferee) and gives the transfer up once
    no member holds a higher term; a leader with no live majority steps down
    (CheckQuorum).
  * Faults: a crash keeps the disk; recovery is free. A process that
    stopped mid-leave starts fresh (it is no longer leaving). No cuts and no
    lost disks here (E-52 and E-14c have them). Links: a leader reaches every
    up machine (E-52's directory and dial are not repeated).
  * Time is order only: evict.after (a down machine becomes gone) and
    leave.ms (a leaver's timer) are steps that always fire in the end.
  * Outside steps within a budget: crashes, leaves (Ctrl-C, not supervised),
    retire hints, client writes.

THE DESIGN (counted): see actions(); `--rules` lists every rule.

PROPERTIES.
  Safety, every state:
    ES  at most one leader per term (over the whole history).
    LM  log matching: two logs with an entry of the same term at the same
        index agree up to it.
    SM  every member's committed prefix agrees with every entry ever
        committed (no committed entry changes).
    LC  a leader of term t holds every entry committed in a term below t.
    NL  no committed entry lost: every entry ever committed is on a set of
        voters of the latest committed config that meets every majority
        (E-14c's CommittedQuorumInv; disks are never lost here).
    VQ  no member that lacks a committed entry and could stand can collect a
        majority of votes in its own config (E-14c's VoteQuorumInv).
    DJ  never two disjoint majorities at work: no two leaders can each
        reach a majority of their own config's voters that would take their
        appends at the same time.
    SN  a stopped or removed member serves nothing: every up leader is a
        voter of its own applied config, and no exited member leads.
    P3  the latest committed config has 1 to 4 voters.
  Safety, every step:
    OV  every config entry a leader appends keeps a majority overlap with
        the leader's applied config (no two majorities can be disjoint).
    CK  the voter count goes from three or more to fewer than three only
        while a leave is in progress (a retire never does it: DESIGN-V5 4.2
        "going below copies is a leave, not a retire").
    P7  no add, standby add or promotion targets a machine that says it is
        retiring (E-52's P7).
    LD  no hand-over targets a retiring machine (E-52's LD).
    LX  an exit never takes away the last live majority of the group while
        a live machine that is not leaving could stand in for the leaver
        (judged at the exit step, crashed machines or not).
    DX  an exit never leaves a committed entry on fewer than a majority of
        the voters that have not exited (the leaver's disk goes with it).
    OL  a config entry never takes away the live majority: if the leader's
        applied config has one, the new config has one too (a promotion of a
        machine that does not answer, from one voter, breaks it).
    B2B back to back (LAYERS 2.3 rule 2): a promotion from one voter happens
        only while another learner that answers and says nothing holds the
        commit offset; and right after a promotion from one voter to two, the
        next config entry is the second promotion, unless a crash, a leave
        or a retire hint has happened, or a machine is down or gone.
    P9  no more than `churn` config or placement entries without an outside
        event (twice the design's longest run on the bound, at least 8).
    P9L no more than `lchurn` leadership transfers without an outside event
        (E-52's P9L; 4, twice the design's longest run on every bound).
    P9W no log longer than `maxlog` (twice the design's longest log on the
        bound): a mutant that appends without end is caught, not explored
        for ever.
  Liveness, AG EF over calm steps (deliver and time). Judged only where one
  more election fits under the term bound (`room`, as E-14b judged below its
  bound), and, for HF and LW, where some live machine says nothing (with
  every machine retiring there is no place for the data: a limit).
    P5  from every state with a live majority of the latest committed config,
        whose live voters have applied it, and no config change in flight, a
        working leader can be reached.
    HF  healing finishes, from the same states: a working leader, nothing
        uncommitted, an odd voter count, three voters once three live
        machines say nothing (else no free machine could replace a dead or
        retiring voter), every live machine in the config while there is
        one voter, and no gone learner in the config.
    GF  growth finishes: from every state with fewer than three voters and
        three live machines that are not retiring, calm steps reach three
        voters that all answer.
    DL  a gone learner is dropped: from every state with a working leader
        and a gone learner in the config, calm steps reach a config with no
        gone learner.
    SF  a clean stop finishes: from every state where a machine that says
        it is leaving is still up (crashed machines or not, a spare or not),
        calm steps reach no such machine up.
    LW  leaves keep the group writable: from every state with no crashed
        machine, calm steps reach a working leader (DESIGN-V5 4.2, two
        machines: "the other carries on alone").
    RC  a retire completes once a spare exists: from every state where a
        retire-hinted machine is a voter of three or more and a live machine
        that says nothing is not a voter, calm steps reach it out of the
        voters.
  Reported, not a property:
    SWF while a leaver is up and one machine is down, calm steps reach a
        working leader (the group stays writable through a stop with one
        crash).
    POST after a stop (a machine exited, no leaver up), with one machine
        down, calm steps reach a working leader.
    DUR (variants absent-dur, shrink-dur, a safety property there) once a
        machine has exited, every committed entry is on two machines that
        have not exited, while the latest committed config names two.
    WIN states with a live majority of the latest committed config where a
        live voter has not applied it, from which no working leader can be
        reached: E-14b's two-voter window (growing from two voters to three,
        the leader is lost before the other old voter hears the commit).
    SWAP states with a config change in flight and a live majority, from
        which no working leader can be reached (E-16's SWAP: a fault during
        a change).
"""

import itertools
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
E16 = os.path.normpath(os.path.join(HERE, '..', '..', 'E16-controller-loop'))
sys.path.insert(0, os.path.join(E16, 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402  (E-17's dsl, via E-16's engine)

DOWN, UP, EXIT = 0, 1, 2
FOL, CAND, LEAD, XFER = 0, 1, 2, 3   # XFER: a leader whose transfer is in flight
LEADS = (LEAD, XFER)
NONE, LEAVING, RETIRE = 0, 1, 2

FIELDS = ('st', 'tm', 'vf', 'lg', 'ci', 'rl', 'vg', 'lv', 'rt', 'lms', 'gone', 'elec', 'cm', 'cmt',
          'nf', 'nl', 'nr', 'nw', 'chg', 'lc')
IX = {f: i for i, f in enumerate(FIELDS)}
ST, TM, VF, LG, CI, RL, VG, LV, RT, LMS, GONE, ELEC, CM, CMT, NF, NL, NR, NW, CHG, LC = range(len(FIELDS))
E = frozenset()
CHURN = 8
# the caps of P9, from results/maxchg.txt (twice the design's longest run, at least 8)
MAXCHG = {}

CFG_ACTS = ('add', 'standby', 'promote', 'remove', 'surplus', 'dropl', 'stepback', 'opromote', 'lrem', 'ldead',
            'ldrop')


def maj(n, tot):
    return 2 * n > tot


def tset(t, i, v):
    return t[:i] + (v,) + t[i + 1:]


def cfg_of(log, k):
    """(voters, learners, index) of the last config entry in log[:k], or None."""
    for i in range(k - 1, -1, -1):
        p = log[i][1]
        if p[0] == 'f' or p[0] == 'c':
            return p[1], p[2], i
    return None


def plc_of(log, k):
    for i in range(k - 1, -1, -1):
        p = log[i][1]
        if p[0] == 'f':
            return p[3]
        if p[0] == 'p':
            return p[1]
    return E


def newv_of(log, k):
    """The voter the last config change in log[:k] added, if it added one."""
    cur = None
    for i in range(k - 1, -1, -1):
        p = log[i][1]
        if p[0] == 'f' or p[0] == 'c':
            if cur is None:
                cur = p[1]
            else:
                add = cur - p[1]
                return next(iter(add)) if len(add) == 1 else None
    return None


def disjoint(c1, c2):
    """Can a majority of c1 and a majority of c2 be disjoint?"""
    if not c1 or not c2:
        return False
    a, b, s = len(c1 - c2), len(c2 - c1), len(c1 & c2)
    return max(0, len(c1) // 2 + 1 - a) + max(0, len(c2) // 2 + 1 - b) <= s


def uptodate(la, lb):
    """Log la is at least as up to date as lb (Raft's vote rule)."""
    ta = la[-1][0] if la else 0
    tb = lb[-1][0] if lb else 0
    return ta > tb or (ta == tb and len(la) >= len(lb))


def is_prefix(a, b):
    return len(a) <= len(b) and b[:len(a)] == a


class Grow:
    CALM = ('deliver', 'time')
    INFO = ('WIN', 'SWAP', 'SWF', 'POST')
    OPTION = 'shrink'
    DUR = False

    def __init__(self, bound):
        self.b = bound
        self.N = bound['n']
        self.F = bound.get('faults', 0)
        self.L = bound.get('leaves', 0)
        self.R = bound.get('retires', 0)
        self.W = bound.get('writes', 0)
        self.MAXT = bound.get('maxt', 3)
        self.room = bound.get('room', 1)
        self.churn = bound.get('churn', CHURN)
        self.maxlog = bound.get('maxlog', 40)
        self.lchurn = bound.get('lchurn', 4)
        self.leavers = tuple(bound.get('leavers', range(self.N)))
        self._cs = None
        self._c = {}

    # ------------------------------------------------------------ state
    def init(self):
        N = self.N
        V = frozenset(self.b['voters'])
        L = frozenset(self.b.get('learners', ()))
        P = frozenset(self.b.get('place', self.b['voters']))
        f = (1, ('f', V, L, P))
        lg = tuple((f,) if (i in V or i in L) else () for i in range(N))
        ci = tuple(1 if lg[i] else 0 for i in range(N))
        tm = tuple(1 if lg[i] else 0 for i in range(N))
        vf = tuple(0 if lg[i] else -1 for i in range(N))
        rl = tuple(LEAD if i == 0 else FOL for i in range(N))
        st = tuple(DOWN if i in self.b.get('down', ()) else UP for i in range(N))
        z = tuple(0 for _ in range(N))
        vg = tuple(E for _ in range(N))
        return (st, tm, vf, lg, ci, rl, vg, z, z, E, E, frozenset({(1, 0)}), (f,), (1,), 0, 0, 0, 0, 0, 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[f] for f in FIELDS)

    # ------------------------------------------------------------ views (cached per state)
    def _v(self, st):
        if st is not self._cs:
            self._cs = st
            self._c = {}
        return self._c

    def cfg(self, st, n):
        c = self._v(st)
        k = ('cfg', n)
        if k not in c:
            c[k] = cfg_of(st[LG][n], st[CI][n])
        return c[k]

    def V(self, st, n):
        x = self.cfg(st, n)
        return x[0] if x else E

    def Lr(self, st, n):
        x = self.cfg(st, n)
        return x[1] if x else E

    def plc(self, st, n):
        c = self._v(st)
        k = ('plc', n)
        if k not in c:
            c[k] = plc_of(st[LG][n], st[CI][n])
        return c[k]

    def gcfg(self, st):
        """The latest committed config of the group (from every entry ever committed)."""
        c = self._v(st)
        if 'g' not in c:
            c['g'] = cfg_of(st[CM], len(st[CM]))
        return c['g']

    def live(self, st, m):
        return st[ST][m] == UP

    def ret(self, st, m):
        return st[RT][m] != NONE

    def cands(self, st):
        """Live machines that say nothing (not retiring)."""
        return [m for m in range(self.N) if st[ST][m] == UP and st[RT][m] == NONE]

    def caught(self, st, n, m):
        """m holds n's commit offset exactly."""
        k = st[CI][n]
        return len(st[LG][m]) >= k and st[LG][m][:k] == st[LG][n][:k]

    def leading(self, st, n):
        return st[ST][n] == UP and st[RL][n] in LEADS and n in self.V(st, n)

    def idle(self, st, n):
        return st[CI][n] == len(st[LG][n])

    def working(self, st, n):
        if not self.leading(st, n):
            return False
        V = self.V(st, n)
        if not maj(sum(1 for v in V if st[ST][v] == UP), len(V)):
            return False
        if any(st[ST][m] == UP and st[TM][m] > st[TM][n] for m in range(self.N)):
            return False
        k = st[CI][n]
        return k > 0 and st[LG][n][k - 1][0] == st[TM][n]

    def writable(self, st):
        return any(self.working(st, n) for n in range(self.N))

    def up_leaver(self, st, m):
        return st[ST][m] == UP and (st[LV][m] or st[RT][m] == LEAVING)

    def carriers(self, st, m):
        """Live machines other than m that could stand in for it: not
        leaving, and either saying nothing or already a member."""
        g = self.gcfg(st)
        mem = (g[0] | g[1]) if g else E
        return [x for x in range(self.N) if x != m and st[ST][x] == UP and st[RT][x] != LEAVING
                and (st[RT][x] == NONE or x in mem)]

    def alone(self, st, m):
        """Nothing can carry the group without m: its latest committed
        config has no live majority (no change can commit), or no live
        machine could stand in for m."""
        g = self.gcfg(st)
        if g and not maj(sum(1 for v in g[0] if st[ST][v] == UP), len(g[0])):
            return True
        return not self.carriers(st, m)

    def leaving_in_progress(self, st):
        return any(st[RT][m] == LEAVING for m in range(self.N))

    # ------------------------------------------------------------ world steps
    def world(self, st):
        out = []
        N = self.N
        for m in range(N):
            s = st[ST][m]
            if s == UP and st[NF] < self.F:
                d = self.to_draft(st)
                d['st'] = tset(st[ST], m, DOWN)
                d['rl'] = tset(st[RL], m, FOL)
                d['vg'] = tset(st[VG], m, E)
                d['nf'] = st[NF] + 1
                d['chg'] = 0
                d['lc'] = 0
                out.append((('crash', m), 'fault', tuple(d[f] for f in FIELDS)))
            if s == DOWN:
                d = self.to_draft(st)
                d['st'] = tset(st[ST], m, UP)
                d['gone'] = st[GONE] - {m}
                if st[LV][m]:
                    # a process that stopped mid-leave starts fresh
                    d['lv'] = tset(st[LV], m, 0)
                    d['lms'] = st[LMS] - {m}
                    if st[RT][m] == LEAVING:
                        d['rt'] = tset(st[RT], m, NONE)
                d['chg'] = 0
                d['lc'] = 0
                out.append((('recover', m), 'recover', tuple(d[f] for f in FIELDS)))
            if s != UP and m not in st[GONE]:
                d = self.to_draft(st)
                d['gone'] = st[GONE] | {m}
                d['chg'] = 0
                d['lc'] = 0
                out.append((('evict', m), 'time', tuple(d[f] for f in FIELDS)))
            if s == UP and st[LV][m] and m not in st[LMS]:
                d = self.to_draft(st)
                d['lms'] = st[LMS] | {m}
                d['chg'] = 0
                d['lc'] = 0
                out.append((('leave.ms', m), 'time', tuple(d[f] for f in FIELDS)))
        return out

    # ------------------------------------------------------------ actions
    def actions(self):
        w = self
        N = self.N

        def P_n(w, st):
            for n in range(w.N):
                yield {'n': n}

        def P_lead(w, st):
            for n in range(w.N):
                if st[RL][n] in LEADS and st[ST][n] == UP:
                    yield {'n': n}

        def P_xfer(w, st):
            for n in range(w.N):
                if st[RL][n] == XFER and st[ST][n] == UP:
                    yield {'n': n}

        def P_act(w, st):
            # a leader proposes only while no transfer of its own is in flight
            # (etcd refuses proposals while leadTransferee is set)
            for n in range(w.N):
                if st[RL][n] == LEAD and st[ST][n] == UP:
                    yield {'n': n}

        def P_lead_m(w, st):
            for n in range(w.N):
                if st[RL][n] == LEAD and st[ST][n] == UP:
                    for m in range(w.N):
                        if m != n:
                            yield {'n': n, 'm': m}

        def P_leads_m(w, st):
            for n in range(w.N):
                if st[RL][n] in LEADS and st[ST][n] == UP:
                    for m in range(w.N):
                        if m != n:
                            yield {'n': n, 'm': m}

        def P_lead_mm(w, st):
            """the leader and any member, itself included"""
            for n in range(w.N):
                if st[RL][n] == LEAD and st[ST][n] == UP:
                    for m in range(w.N):
                        yield {'n': n, 'm': m}

        def P_pair(w, st):
            for n in range(w.N):
                for m in range(w.N):
                    if m != n:
                        yield {'n': n, 'm': m}

        def P_commit(w, st):
            for n in range(w.N):
                if st[RL][n] in LEADS and st[ST][n] == UP:
                    for k in range(st[CI][n] + 1, len(st[LG][n]) + 1):
                        yield {'n': n, 'k': k}

        def P_grow(w, st):
            for n in range(w.N):
                if st[RL][n] == LEAD and st[ST][n] == UP:
                    others = [m for m in range(w.N) if m != n]
                    for x, y in itertools.combinations(others, 2):
                        yield {'n': n, 'x': x, 'y': y}

        def P_pick(w, st):
            for n in range(w.N):
                if st[RL][n] == LEAD and st[ST][n] == UP:
                    for x in range(w.N):
                        for y in range(w.N):
                            if x != y:
                                yield {'n': n, 'x': x, 'y': y}

        def P_m(w, st):
            for m in range(w.N):
                yield {'m': m}

        def P_leave(w, st):
            for m in w.leavers:
                yield {'m': m}

        # ---- shared guard functions
        def g_leader(w, st, b):
            return w.leading(st, b['n'])

        def g_idle(w, st, b):
            return w.idle(st, b['n'])

        def append(payload_fn):
            def f(w, st, b, d):
                n = b['n']
                lg = d.f['lg']
                d.f['lg'] = tset(lg, n, lg[n] + ((st[TM][n], payload_fn(w, st, b)),))
                d.f['chg'] = d.f['chg'] + 1
            return f

        def c_add(w, st, b):
            return ('c', w.V(st, b['n']), w.Lr(st, b['n']) | {b['m']})

        def c_promote(w, st, b):
            return ('c', w.V(st, b['n']) | {b['m']}, w.Lr(st, b['n']) - {b['m']})

        def c_remove(w, st, b):
            return ('c', w.V(st, b['n']) - {b['m']}, w.Lr(st, b['n']))

        def c_dropl(w, st, b):
            return ('c', w.V(st, b['n']), w.Lr(st, b['n']) - {b['m']})

        def c_demote(w, st, b):
            return ('c', w.V(st, b['n']) - {b['m']}, w.Lr(st, b['n']) | {b['m']})

        def nv(w, st, b):
            return len(w.V(st, b['n']))

        def newok(w, st, b):
            n = b['n']
            x = newv_of(st[LG][n], st[CI][n])
            return x is None or x == b['m'] or (w.live(st, x) and w.caught(st, n, x))

        def one_voter(w, st, b):
            return len(w.V(st, b['n'])) == 1

        # ---- Raft core: updates
        def u_stand(w, st, b, d):
            n = b['n']
            d.f['tm'] = tset(d.f['tm'], n, st[TM][n] + 1)
            d.f['vf'] = tset(d.f['vf'], n, n)
            d.f['rl'] = tset(d.f['rl'], n, CAND)
            d.f['vg'] = tset(d.f['vg'], n, frozenset({n}))

        def u_grant(w, st, b, d):
            m, n = b['m'], b['n']
            if st[TM][m] < st[TM][n]:
                d.f['tm'] = tset(d.f['tm'], m, st[TM][n])
                d.f['rl'] = tset(d.f['rl'], m, FOL)
                d.f['vg'] = tset(d.f['vg'], m, E)
            d.f['vf'] = tset(d.f['vf'], m, n)

        def u_count(w, st, b, d):
            n = b['n']
            d.f['vg'] = tset(d.f['vg'], n, d.f['vg'][n] | {b['m']})

        def u_lead(w, st, b, d):
            n = b['n']
            d.f['rl'] = tset(d.f['rl'], n, LEAD)
            d.f['elec'] = st[ELEC] | {(st[TM][n], n)}

        def u_noop(w, st, b, d):
            n = b['n']
            lg = d.f['lg']
            d.f['lg'] = tset(lg, n, lg[n] + ((st[TM][n], ('n',)),))

        def u_copy(w, st, b, d):
            n, m = b['n'], b['m']
            if st[TM][m] < st[TM][n]:
                d.f['tm'] = tset(d.f['tm'], m, st[TM][n])
                d.f['vf'] = tset(d.f['vf'], m, -1)
            d.f['rl'] = tset(d.f['rl'], m, FOL)
            d.f['vg'] = tset(d.f['vg'], m, E)
            ln, lm = st[LG][n], st[LG][m]
            if not is_prefix(ln, lm):
                d.f['lg'] = tset(d.f['lg'], m, ln)

        def u_lci(w, st, b, d):
            n, m = b['n'], b['m']
            k = max(st[CI][m], st[CI][n])
            k = min(k, len(d.f['lg'][m]))
            d.f['ci'] = tset(d.f['ci'], m, max(st[CI][m], k))

        def g_cmaj(w, st, b):
            n, k = b['n'], b['k']
            V = w.V(st, n)
            pre = st[LG][n][:k]
            have = sum(1 for v in V if st[ST][v] == UP and len(st[LG][v]) >= k and st[LG][v][:k] == pre)
            return maj(have, len(V))

        def u_cset(w, st, b, d):
            n, k = b['n'], b['k']
            d.f['ci'] = tset(d.f['ci'], n, max(st[CI][n], k))

        def u_cdown(w, st, b, d):
            n, k = b['n'], b['k']
            c = cfg_of(st[LG][n], max(st[CI][n], k))
            if c is None or n not in c[0]:
                d.f['rl'] = tset(d.f['rl'], n, FOL)

        def u_chist(w, st, b, d):
            n, k = b['n'], b['k']
            pre = st[LG][n][:k]
            cm = st[CM]
            if len(pre) > len(cm) and pre[:len(cm)] == cm:
                d.f['cm'] = pre
                d.f['cmt'] = st[CMT] + tuple(st[TM][n] for _ in range(len(pre) - len(cm)))

        def u_fol(w, st, b, d):
            d.f['rl'] = tset(d.f['rl'], b['n'], FOL)

        def u_transfer(w, st, b, d):
            m = b['m']
            d.f['rl'] = tset(d.f['rl'], b['n'], XFER)
            d.f['lc'] = d.f['lc'] + 1
            d.f['tm'] = tset(d.f['tm'], m, max(st[TM][m], st[TM][b['n']]) + 1)
            d.f['vf'] = tset(d.f['vf'], m, m)
            d.f['rl'] = tset(d.f['rl'], m, CAND)
            d.f['vg'] = tset(d.f['vg'], m, frozenset({m}))

        def u_exit(w, st, b, d):
            m = b['m']
            d.f['st'] = tset(d.f['st'], m, EXIT)
            d.f['rl'] = tset(d.f['rl'], m, FOL)
            d.f['vg'] = tset(d.f['vg'], m, E)

        def exit_safe(w, st, m):
            """The voters left without m can still commit: they have applied
            the latest committed config and are a majority of it, and they
            are a majority of every newer config in any log."""
            g = w.gcfg(st)
            if not g:
                return True
            V, L, i = g
            rest = [v for v in V if v != m and st[ST][v] == UP]
            if not maj(len(rest), len(V)):
                return False
            if any(w.cfg(st, v) is None or w.cfg(st, v)[2] < i for v in rest):
                return False
            for x in range(w.N):
                if st[ST][x] == EXIT:
                    continue
                lg = st[LG][x]
                for e in lg[len(st[CM]):]:
                    if e[1][0] == 'c' and m in e[1][1]:
                        Vp = e[1][1]
                        if not maj(sum(1 for v in Vp if v != m and st[ST][v] == UP), len(Vp)):
                            return False
            return True

        def held(w, st, m):
            """The live voters left without m hold every committed entry and
            are a majority of the latest committed config."""
            g = w.gcfg(st)
            if not g:
                return True
            V = g[0]
            have = sum(1 for v in V if v != m and st[ST][v] == UP and is_prefix(st[CM], st[LG][v]))
            return maj(have, len(V))

        def u_stop(w, st, b, d):
            m = b['m']
            d.f['st'] = tset(d.f['st'], m, DOWN)
            d.f['rl'] = tset(d.f['rl'], m, FOL)
            d.f['vg'] = tset(d.f['vg'], m, E)

        def named(w, st, m):
            """Some config names m: the latest committed one, or one pending
            in an up leader's log."""
            g = w.gcfg(st)
            if g and (m in g[0] or m in g[1]):
                return True
            for n in range(w.N):
                if st[RL][n] in LEADS and st[ST][n] == UP:
                    c = cfg_of(st[LG][n], len(st[LG][n]))
                    if c and (m in c[0] or m in c[1]):
                        return True
            return False

        def prevote(w, st, b):
            n = b['n']
            V = w.V(st, n)
            t = st[TM][n] + 1
            g = sum(1 for y in V if st[ST][y] == UP and st[TM][y] < t and uptodate(st[LG][n], st[LG][y]))
            return maj(g, len(V))

        def u_newer(w, st, b, d):
            n = b['n']
            d.f['rl'] = tset(d.f['rl'], n, FOL)
            hi = max(st[TM][m] for m in range(w.N) if st[ST][m] == UP)
            d.f['tm'] = tset(d.f['tm'], n, hi)
            d.f['vf'] = tset(d.f['vf'], n, -1)

        def canwin(w, st, n):
            V = w.V(st, n)
            t = st[TM][n]
            g = sum(1 for y in V if y in st[VG][n] or (
                st[ST][y] == UP and (st[TM][y] < t or (st[TM][y] == t and st[VF][y] in (-1, n)))
                and uptodate(st[LG][n], st[LG][y])))
            return maj(g, len(V))

        def u_learn(w, st, b, d):
            n = b['n']
            d.f['tm'] = tset(d.f['tm'], n, st[TM][b['m']])
            d.f['vf'] = tset(d.f['vf'], n, -1)
            d.f['rl'] = tset(d.f['rl'], n, FOL)
            d.f['vg'] = tset(d.f['vg'], n, E)

        def few(w, st, b):
            """fewer than three live machines that say nothing"""
            return len(w.cands(st)) < 3

        acts = [
            # ================================================= Raft core (pinned in the design's ablation)
            Action('stand', 'deliver', P_n, [
                Guard('up', lambda w, st, b: st[ST][b['n']] == UP, role='world'),
                Guard('notlead', lambda w, st, b: st[RL][b['n']] == FOL, role='world'),
                Guard('lease', lambda w, st, b: not any(
                    st[ST][x] == UP and st[RL][x] in LEADS and st[TM][x] >= st[TM][b['n']]
                    for x in range(w.N) if x != b['n']), role='red',
                    note='reduction: PreVote with CheckQuorum (E-14 LeaderLease)'),
                Guard('onecand', lambda w, st, b: not any(
                    st[ST][x] == UP and st[RL][x] == CAND for x in range(w.N) if x != b['n']), role='red',
                    note='reduction: one candidate at a time (E-14)'),
                Guard('voter', lambda w, st, b: b['n'] in w.V(st, b['n']), role='raft',
                      note='only a voter of its own applied config stands (etcd promotable; E-14c r19)'),
                Guard('prevote', prevote, role='red',
                      note='reduction: PreVote, a member stands only if a majority of its config would grant'),
                Cmp('maxt', lambda w, st, b: st[TM][b['n']], '<', lambda w, st, b: w.MAXT, role='bound'),
            ], [Update('go', u_stand, role='raft', note='raise the term, vote for itself')]),
            Action('vote', 'deliver', P_pair, [
                Guard('up', lambda w, st, b: st[ST][b['m']] == UP and st[ST][b['n']] == UP, role='world'),
                Guard('cand', lambda w, st, b: st[RL][b['n']] == CAND, role='raft'),
                Guard('asked', lambda w, st, b: b['m'] in w.V(st, b['n']), role='red',
                      note='a candidate asks the voters of its own config (learners among them vote)'),
                Guard('new', lambda w, st, b: b['m'] not in st[VG][b['n']], role='red'),
                Cmp('term', lambda w, st, b: st[TM][b['m']], '<=', lambda w, st, b: st[TM][b['n']], role='raft',
                    note='no vote for an older term'),
                Guard('once', lambda w, st, b: st[TM][b['m']] < st[TM][b['n']] or st[VF][b['m']] in (-1, b['n']),
                      role='raft', note='one vote a term (raft-term-vote)'),
                Guard('log', lambda w, st, b: uptodate(st[LG][b['n']], st[LG][b['m']]), role='raft',
                      note="the candidate's log is at least as up to date"),
            ], [Update('grant', u_grant, role='raft', note='store the vote and the term'),
                Update('count', u_count, role='raft')]),
            Action('win', 'deliver', P_n, [
                Guard('up', lambda w, st, b: st[ST][b['n']] == UP, role='world'),
                Guard('cand', lambda w, st, b: st[RL][b['n']] == CAND, role='raft'),
                Guard('maj', lambda w, st, b: maj(len(st[VG][b['n']] & w.V(st, b['n'])), len(w.V(st, b['n']))),
                      role='raft', note='votes of a majority of its own config'),
            ], [Update('lead', u_lead, role='raft'),
                Update('noop', u_noop, role='raft', note="a new leader's empty entry (etcd; Ongaro's 2015 fix)")]),
            Action('giveup', 'deliver', P_n, [
                Guard('up', lambda w, st, b: st[ST][b['n']] == UP, role='world'),
                Guard('cand', lambda w, st, b: st[RL][b['n']] == CAND, role='world'),
                Guard('stuck', lambda w, st, b: not canwin(w, st, b['n']), role='red',
                      note='reduction: a candidate times out only when it cannot win'),
            ], [Update('fol', u_fol, role='world', note='a candidate times out and waits')]),
            Action('learn', 'deliver', P_pair, [
                Guard('up', lambda w, st, b: st[ST][b['n']] == UP and st[ST][b['m']] == UP, role='world'),
                Guard('higher', lambda w, st, b: st[TM][b['m']] > st[TM][b['n']], role='world'),
            ], [Update('take', u_learn, role='world',
                       note='any message with a higher term: take it and become a follower')]),
            Action('repl', 'deliver', P_leads_m, [
                Guard('up', lambda w, st, b: st[ST][b['m']] == UP, role='world'),
                Guard('member', lambda w, st, b: b['m'] in (lambda c: (c[0] | c[1]) if c else E)(
                    cfg_of(st[LG][b['n']], len(st[LG][b['n']]))) or b['m'] in (w.V(st, b['n']) | w.Lr(st, b['n'])),
                      role='red', note='the leader sends to the members of its configs'),
                Cmp('term', lambda w, st, b: st[TM][b['m']], '<=', lambda w, st, b: st[TM][b['n']], role='raft',
                    note='a follower takes appends only from a leader of its term or later'),
            ], [Update('copy', u_copy, role='raft', note="the follower's log becomes the leader's (CoarseAE)"),
                Update('ci', u_lci, role='raft', note="the follower learns the leader's commit index")]),
            Action('commit', 'deliver', P_commit, [
                Guard('own', lambda w, st, b: st[LG][b['n']][b['k'] - 1][0] == st[TM][b['n']], role='raft',
                      note='count only an entry of its own term (raft-commit)'),
                Guard('maj', g_cmaj, role='raft', note="a majority of its applied config's voters hold it"),
            ], [Update('set', u_cset, role='raft'),
                Update('down', u_cdown, role='raft', note='a leader its applied config drops steps down'),
                Update('hist', u_chist, role='world', note='history: every entry ever committed')]),
            Action('xabort', 'deliver', P_xfer, [
                Guard('lost', lambda w, st, b: not any(st[ST][m] == UP and st[TM][m] > st[TM][b['n']]
                                                       for m in range(w.N)), role='world'),
            ], [Update('lead', lambda w, st, b, d: d.f.__setitem__('rl', tset(d.f['rl'], b['n'], LEAD)),
                       role='world', note='a transfer whose target is gone is given up (raft-leader-transfer)')]),
            Action('cq', 'deliver', P_lead, [
                Guard('nomaj', lambda w, st, b: not maj(sum(1 for v in w.V(st, b['n']) if st[ST][v] == UP),
                                                        len(w.V(st, b['n']))), role='world'),
            ], [Update('fol', u_fol, role='world', note='CheckQuorum: a leader with no live majority steps down')]),

            # ================================================= the design: growth and healing
            # LAYERS 2.3 "Growing from one voter", rule 1: a placement of three first. LAYERS says
    # "a group with one voter"; E-59 found that a placement can name fewer than three
    # machines while the group has more voters (the only voter's leave picks into a
    # placement of one), so the guard is on the placement, not the voter count.
            Action('grow', 'deliver', P_grow, [
                Guard('leader', g_leader, role='raft', note='only a working leader proposes'),
                Guard('idle', g_idle, role='raft', note='one change at a time'),
                Guard('small', lambda w, st, b: len(w.plc(st, b['n'])) < 3, role='grow',
                      note='its stored placement names fewer than three machines'),
                Guard('cand', lambda w, st, b: all(w.live(st, m) and not w.ret(st, m)
                                                   for m in (b['n'], b['x'], b['y'])), role='grow',
                      note='three live machines that say nothing, itself included'),
            ], [Update('append', append(lambda w, st, b: ('p', frozenset({b['n'], b['x'], b['y']}))),
                       role='grow', note='write a placement of three into the log')]),
            # healing-self rule 15: a placed machine gone or retiring -> pick another
            Action('pick', 'deliver', P_pick, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('need', lambda w, st, b: b['x'] in w.plc(st, b['n']) and
                      (b['x'] in st[GONE] or w.ret(st, b['x'])), role='heal',
                      note='a placed machine is gone or says it is retiring'),
                Guard('wait', lambda w, st, b: st[RT][b['x']] != LEAVING or b['x'] in st[LMS] or
                      st[ST][b['x']] != UP, role='leave',
                      note="a retiring voter is left to its own leave until leave.ms (meta-members' high rule)"),
                Guard('cand', lambda w, st, b: w.live(st, b['y']), role='heal', note='the new machine answers'),
                Guard('new', lambda w, st, b: b['y'] not in w.plc(st, b['n']), role='heal',
                      note='not already placed'),
                Guard('notret', lambda w, st, b: not w.ret(st, b['y']), role='heal'),
            ], [Update('append', append(lambda w, st, b: ('p', (w.plc(st, b['n']) - {b['x']}) | {b['y']})),
                       role='heal', note='write the new placement into the log')]),
            Action('add', 'deliver', P_lead_m, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('placed', lambda w, st, b: b['m'] in w.plc(st, b['n']), role='heal'),
                Guard('new', lambda w, st, b: b['m'] not in w.V(st, b['n']) | w.Lr(st, b['n']), role='heal'),
                Guard('cand', lambda w, st, b: w.live(st, b['m']), role='heal'),
                Guard('notret', lambda w, st, b: not w.ret(st, b['m']), role='heal'),
            ], [Update('append', append(c_add), role='heal', note='add it as a learner')]),
            # DESIGN-V5 4.2: with fewer than three candidates the others are learners
            Action('standby', 'deliver', P_lead_m, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('one', one_voter, role='grow', note='the group has one voter'),
                Guard('new', lambda w, st, b: b['m'] not in w.V(st, b['n']) | w.Lr(st, b['n']), role='grow'),
                Guard('cand', lambda w, st, b: w.live(st, b['m']), role='grow'),
                Guard('notret', lambda w, st, b: not w.ret(st, b['m']), role='grow'),
            ], [Update('append', append(c_add), role='grow', note='add a live machine as a learner')]),
            Action('promote', 'deliver', P_lead_m, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('learner', lambda w, st, b: b['m'] in w.Lr(st, b['n']), role='heal'),
                Guard('placed', lambda w, st, b: b['m'] in w.plc(st, b['n']), role='heal'),
                Guard('caught', lambda w, st, b: w.caught(st, b['n'], b['m']), role='heal',
                      note='it holds the commit offset exactly'),
                Guard('live', lambda w, st, b: w.live(st, b['m']), role='heal', note='it answers the leader now'),
                Guard('notret', lambda w, st, b: not w.ret(st, b['m']), role='heal'),
                Cmp('odd', nv, '<', lambda w, st, b: 4, role='heal', note='never past four voters'),
                Guard('pair', lambda w, st, b: len(w.V(st, b['n'])) != 1 or any(
                    x != b['m'] and x in w.plc(st, b['n']) and w.live(st, x) and not w.ret(st, x)
                    and w.caught(st, b['n'], x) for x in w.Lr(st, b['n'])), role='grow',
                      note='from one voter only once both learners hold the commit offset and answer'),
            ], [Update('append', append(c_promote), role='heal')]),
            Action('remove', 'deliver', P_lead_m, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('voter', lambda w, st, b: b['m'] in w.V(st, b['n']), role='heal'),
                Guard('gone', lambda w, st, b: b['m'] in st[GONE], role='heal'),
                Cmp('four', nv, '>=', lambda w, st, b: 4, role='heal', note='a swap promotes first'),
                Guard('newok', newok, role='heal', note='the new voter holds the commit offset again'),
            ], [Update('append', append(c_remove), role='heal')]),
            Action('surplus', 'deliver', P_lead_mm, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('voter', lambda w, st, b: b['m'] in w.V(st, b['n']), role='heal'),
                Cmp('four', nv, '>=', lambda w, st, b: 4, role='heal'),
                Guard('last', lambda w, st, b: b['m'] not in w.plc(st, b['n']), role='heal',
                      note='the voter the stored placement leaves out'),
                Guard('allheld', lambda w, st, b: all(w.live(st, v) and w.caught(st, b['n'], v)
                                                      for v in w.V(st, b['n']) - {b['m']}), role='heal'),
            ], [Update('append', append(c_remove), role='heal')]),
            # LAYERS 2.3 growth rule 4: a learner gone to the leader is dropped
            Action('dropl', 'deliver', P_lead_m, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('learner', lambda w, st, b: b['m'] in w.Lr(st, b['n']), role='grow'),
                Guard('gone', lambda w, st, b: b['m'] in st[GONE], role='grow'),
            ], [Update('append', append(c_dropl), role='grow')]),
            # LAYERS 2.3 growth rule 3: two voters step back to one
            Action('stepback', 'deliver', P_lead_m, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('two', lambda w, st, b: len(w.V(st, b['n'])) == 2, role='grow'),
                Guard('other', lambda w, st, b: b['m'] in w.V(st, b['n']), role='grow',
                      note='the other voter'),
                Guard('few', few, role='grow', note='fewer than three live machines that say nothing'),
                Guard('noret', lambda w, st, b: not any(w.ret(st, v) for v in w.V(st, b['n'])), role='grow',
                      note='neither voter retiring'),
            ], [Update('append', append(c_demote), role='grow', note='make the other voter a learner')]),

            # ================================================= the design: a clean stop
            Action('leave', 'control', P_leave, [
                Guard('budget', lambda w, st, b: st[NL] < w.L, role='world'),
                Guard('up', lambda w, st, b: st[ST][b['m']] == UP and not st[LV][b['m']] and
                      st[RT][b['m']] == NONE, role='world'),
            ], [Update('start', lambda w, st, b, d: (d.f.__setitem__('lv', tset(d.f['lv'], b['m'], 1)),
                                                     d.f.__setitem__('nl', st[NL] + 1),
                                                     d.f.__setitem__('chg', 0), d.f.__setitem__('lc', 0)), role='world',
                       note='Ctrl-C, not supervised: the process starts to leave'),
                Update('mark', lambda w, st, b, d: d.f.__setitem__('rt', tset(d.f['rt'], b['m'], LEAVING)),
                       role='leave', note='it says "retiring" in its pings first (leave.mark)')]),
            Action('retire', 'control', P_m, [
                Guard('budget', lambda w, st, b: st[NR] < w.R, role='world'),
                Guard('up', lambda w, st, b: st[ST][b['m']] == UP and st[RT][b['m']] == NONE, role='world'),
            ], [Update('mark', lambda w, st, b, d: (d.f.__setitem__('rt', tset(d.f['rt'], b['m'], RETIRE)),
                                                    d.f.__setitem__('nr', st[NR] + 1),
                                                    d.f.__setitem__('chg', 0), d.f.__setitem__('lc', 0)), role='world',
                       note='a retire hint: the machine says retiring, and stays up')]),
            Action('write', 'control', P_act, [
                Guard('budget', lambda w, st, b: st[NW] < w.W, role='world'),
                Guard('stay', lambda w, st, b: not any(
                    e[1][0] == 'c' and b['n'] not in e[1][1] for e in st[LG][b['n']][st[CI][b['n']]:]), role='leave',
                      note='a leader that has appended its own removal takes no new write'),
            ], [Update('append', lambda w, st, b, d: (
                d.f.__setitem__('lg', tset(d.f['lg'], b['n'], d.f['lg'][b['n']] + ((st[TM][b['n']], ('w',)),))),
                d.f.__setitem__('nw', st[NW] + 1)), role='world', note='a client write')]),
            # LAYERS 8.9 B2: a retiring leader hands over; never to a retiring machine
            Action('handover', 'deliver', P_lead_m, [
                Guard('leader', g_leader, role='raft'),
                Guard('self', lambda w, st, b: w.ret(st, b['n']), role='leave', note='the leader says retiring'),
                Guard('voter', lambda w, st, b: b['m'] in w.V(st, b['n']) and b['m'] in
                      cfg_of(st[LG][b['n']], len(st[LG][b['n']]))[0], role='xfer',
                      note='a voter of its applied config and of any config pending in its log'),
                Guard('tvoter', lambda w, st, b: b['m'] in w.V(st, b['m']), role='xfer',
                      note='the target is a voter of its own applied config (else it ignores TimeoutNow)'),
                Guard('notret', lambda w, st, b: not w.ret(st, b['m']), role='leave',
                      note='no transfer to a retiring machine'),
                Guard('caught', lambda w, st, b: st[LG][b['m']] == st[LG][b['n']], role='xfer',
                      note='TimeoutNow only once the target holds the whole log'),
                Guard('live', lambda w, st, b: w.live(st, b['m']), role='xfer'),
                Cmp('maxt', lambda w, st, b: max(st[TM][b['m']], st[TM][b['n']]), '<', lambda w, st, b: w.MAXT,
                    role='bound'),
            ], [Update('transfer', u_transfer, role='leave', note='TimeoutNow: the target stands at once')]),
            # DESIGN-V5 4.2 leave row, one voter: promote a learner first
            Action('opromote', 'deliver', P_lead_m, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('one', one_voter, role='leave'),
                Guard('self', lambda w, st, b: w.ret(st, b['n']), role='leave',
                      note='the only voter says retiring (a leave, or a retire hint: its seat moves off)'),
                Guard('learner', lambda w, st, b: b['m'] in w.Lr(st, b['n']), role='leave'),
                Guard('caught', lambda w, st, b: w.caught(st, b['n'], b['m']), role='leave'),
                Guard('live', lambda w, st, b: w.live(st, b['m']), role='leave'),
                Guard('notret', lambda w, st, b: not w.ret(st, b['m']), role='leave'),
            ], [Update('append', append(c_promote), role='leave')]),
            # remove a leaving voter (DESIGN-V5's leave; the options differ here, see the subclasses)
            Action('lrem', 'deliver', P_lead_mm, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('voter', lambda w, st, b: b['m'] in w.V(st, b['n']), role='leave'),
                Guard('ret', lambda w, st, b: w.ret(st, b['m']), role='leave', note='it says retiring'),
                Guard('maj', lambda w, st, b: maj(sum(1 for v in w.V(st, b['n']) - {b['m']} if w.live(st, v)),
                                                  len(w.V(st, b['n'])) - 1), role='leave',
                      note='the live voters left are a majority of the new set'),
                Guard('few', few, role='leave', note='no spare: fewer than three live machines that say nothing'),
                Guard('keep', lambda w, st, b: any(w.live(st, v) and st[RT][v] != LEAVING
                                                   for v in w.V(st, b['n']) - {b['m']}), role='leave',
                      note='a live voter that is not leaving stays (a leave goes before a pending retire)'),
                Guard('newok', newok, role='leave', note='a just-promoted voter holds the commit offset again'),
            ] + self.lrem_extra(), [Update('append', append(c_remove), role='leave')]),
            # DESIGN-V5 4.2 leave row: dead voters removed first, when that lets the leave carry (V4-60)
            Action('ldead', 'deliver', P_lead_m, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('voter', lambda w, st, b: b['m'] in w.V(st, b['n']), role='leave'),
                Guard('dead', lambda w, st, b: st[ST][b['m']] != UP, role='leave', note='it does not answer'),
                Guard('carry', lambda w, st, b: any(
                    st[RT][x] == LEAVING and x in st[LMS] and x in w.V(st, b['n'])
                    for x in range(w.N) if x != b['m']), role='leave',
                      note="a voter's leave has run to leave.ms and needs it"),
                Guard('maj', lambda w, st, b: maj(sum(1 for v in w.V(st, b['n']) - {b['m']} if w.live(st, v)),
                                                  len(w.V(st, b['n'])) - 1), role='leave'),
            ], [Update('append', append(c_remove), role='leave')]),
            # LAYERS 8.9, not modelled before: a leaving learner is dropped from the config
            Action('ldrop', 'deliver', P_lead_m, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('learner', lambda w, st, b: b['m'] in w.Lr(st, b['n']), role='leave'),
                Guard('leave', lambda w, st, b: st[RT][b['m']] == LEAVING, role='leave'),
            ], [Update('append', append(c_dropl), role='leave')]),
            # LAYERS 8.9 B4: the leaver exits once no config names it and it leads nothing ...
            Action('exit', 'deliver', P_m, [
                Guard('leaving', lambda w, st, b: st[ST][b['m']] == UP and st[LV][b['m']] == 1, role='world'),
                Guard('unnamed', lambda w, st, b: not named(w, st, b['m']), role='leave',
                      note='no config names it'),
                Guard('nolead', lambda w, st, b: st[RL][b['m']] not in LEADS, role='leave', note='it leads nothing'),
                Guard('safe', lambda w, st, b: exit_safe(w, st, b['m']), role='leave',
                      note='the voters left have applied the latest config and can commit without it'),
                Guard('held', lambda w, st, b: held(w, st, b['m']), role='leave',
                      note='the voters left hold every committed entry (a majority without it)'),
            ], [Update('go', u_exit, role='world')]),
            # ... or at leave.ms
            Action('exitms', 'deliver', P_m, [
                Guard('leaving', lambda w, st, b: st[ST][b['m']] == UP and st[LV][b['m']] == 1, role='world'),
                Guard('lms', lambda w, st, b: b['m'] in st[LMS], role='leave', note='leave.ms has passed'),
                Guard('safe', lambda w, st, b: exit_safe(w, st, b['m']), role='leave',
                      note='the voters left can still commit without it'),
                Guard('held', lambda w, st, b: held(w, st, b['m']), role='leave',
                      note='the voters left hold every committed entry'),
            ], [Update('go', u_exit, role='world')]),
            # ... and the bound: at leave.ms, a leaver that nothing can carry the
            # group without stops as a crash would; the group waits for its restart
            Action('exitalone', 'deliver', P_m, [
                Guard('leaving', lambda w, st, b: st[ST][b['m']] == UP and st[LV][b['m']] == 1, role='world'),
                Guard('lms', lambda w, st, b: b['m'] in st[LMS], role='leave', note='leave.ms has passed'),
                Guard('alone', lambda w, st, b: w.alone(st, b['m']), role='leave',
                      note='no live majority, or no live machine that could stand in for it'),
            ], [Update('stop', u_stop, role='leave',
                       note='it stops with its disk, as a crash would; a restart starts fresh')]),
        ]
        return acts

    def lrem_extra(self):
        return [Guard('leave', lambda w, st, b: st[RT][b['m']] == LEAVING or len(w.V(st, b['n'])) <= 2,
                      role='leave', note='from three voters only a leave, never a retire hint')]

    # ------------------------------------------------------------ properties
    def check(self, st):
        bad = []
        N = self.N
        # ES
        seen = {}
        for t, n in st[ELEC]:
            if t in seen and seen[t] != n:
                bad.append('ES')
                break
            seen[t] = n
        lg = st[LG]
        # LM
        for i in range(N):
            for j in range(i + 1, N):
                a, c = lg[i], lg[j]
                m = min(len(a), len(c))
                k = 0
                while k < m and a[k] == c[k]:
                    k += 1
                if any(a[x][0] == c[x][0] for x in range(k, m)):
                    bad.append('LM')
                    break
            if 'LM' in bad:
                break
        cm = st[CM]
        # SM
        for i in range(N):
            pre = lg[i][:st[CI][i]]
            if not (is_prefix(pre, cm) or is_prefix(cm, pre)):
                bad.append('SM')
                break
        # LC
        for n in range(N):
            if st[RL][n] in LEADS and st[ST][n] == UP:
                t = st[TM][n]
                for i, ct in enumerate(st[CMT]):
                    if ct < t and (len(lg[n]) <= i or lg[n][i] != cm[i]):
                        bad.append('LC')
                        break
                if 'LC' in bad:
                    break
        g = self.gcfg(st)
        V = g[0] if g else E
        # NL
        if V:
            hold = sum(1 for v in V if is_prefix(cm, lg[v]))
            if 2 * hold < len(V):
                bad.append('NL')
        # VQ
        for x in range(N):
            if st[ST][x] == EXIT:
                continue
            cx = self.cfg(st, x)
            if not cx or x not in cx[0] or is_prefix(cm, lg[x]):
                continue
            grant = sum(1 for y in cx[0] if st[ST][y] != EXIT and uptodate(lg[x], lg[y]))
            if maj(grant, len(cx[0])):
                bad.append('VQ')
                break
        # DJ
        can = []
        for n in range(N):
            if st[RL][n] in LEADS and st[ST][n] == UP:
                Vn = self.V(st, n)
                acc = sum(1 for y in Vn if st[ST][y] == UP and st[TM][y] <= st[TM][n])
                if Vn and maj(acc, len(Vn)):
                    can.append(n)
        if len(can) > 1:
            bad.append('DJ')
        # SN
        for n in range(N):
            if st[RL][n] in LEADS and (st[ST][n] == EXIT or (st[ST][n] == UP and n not in self.V(st, n))):
                bad.append('SN')
                break
        # P3
        if not (1 <= len(V) <= 4):
            bad.append('P3')
        # P9W: no log longer than twice the design's longest on this bound
        if any(len(x) > self.maxlog for x in lg):
            bad.append('P9W')
        # DUR (variants only): once a machine has exited, every committed entry
        # is on two machines that have not exited, while the config names two
        if self.DUR and g and any(x == EXIT for x in st[ST]):
            mem = [m for m in (g[0] | g[1]) if st[ST][m] != EXIT]
            if sum(1 for m in mem if is_prefix(cm, lg[m])) < min(2, len(mem)):
                bad.append('DUR')
        return bad

    def check_edge(self, s, lab, kind, t):
        bad = []
        name = lab[0]
        if name in CFG_ACTS or name == 'grow' or name == 'pick':
            b = dict(lab[1])
            n = b['n']
            ent = t[LG][n][-1][1]
            if ent[0] == 'c':
                old = self.V(s, n)
                new = ent[1]
                last = cfg_of(s[LG][n], len(s[LG][n]))
                if disjoint(old, new) or (last and disjoint(last[0], new)):
                    bad.append('OV')
                if len(old) >= 3 and len(new) < 3 and not self.leaving_in_progress(s):
                    bad.append('CK')
                if name in ('add', 'standby', 'promote', 'opromote') and s[RT][b['m']] != NONE:
                    bad.append('P7')
                # OL: a config entry never takes away the live majority
                if maj(sum(1 for v in old if s[ST][v] == UP), len(old)) and \
                        not maj(sum(1 for v in new if s[ST][v] == UP), len(new)):
                    bad.append('OL')
                # B2B: from one voter, both learners ready; after the first
                # promotion the next config entry is the second, unless a fault
                if name == 'promote' and len(old) == 1 and not any(
                        x != b['m'] and s[ST][x] == UP and s[RT][x] == NONE and self.caught(s, n, x)
                        for x in self.Lr(s, n)):
                    bad.append('B2B')
                if last and len(last[0]) == 2 and len(new) != 3:
                    prev = cfg_of(s[LG][n], last[2])
                    calm = (s[NF] == 0 and s[NL] == 0 and s[NR] == 0 and all(x == UP for x in s[ST])
                            and not s[GONE])
                    if prev and len(prev[0]) == 1 and calm:
                        bad.append('B2B')
        if name == 'handover':
            b = dict(lab[1])
            if s[RT][b['m']] != NONE:
                bad.append('LD')
        if name in ('exit', 'exitms', 'exitalone'):
            m = dict(lab[1])['m']
            g = self.gcfg(s)
            if g:
                V = g[0]
                before = maj(sum(1 for v in V if s[ST][v] == UP), len(V))
                after = maj(sum(1 for v in V if t[ST][v] == UP), len(V))
                if before and not after and self.carriers(s, m):
                    bad.append('LX')
                if name != 'exitalone':
                    def hold(x):
                        return sum(1 for v in V if x[ST][v] != EXIT and is_prefix(x[CM], x[LG][v]))
                    if maj(hold(s), len(V)) and not maj(hold(t), len(V)):
                        bad.append('DX')
        if t[CHG] > self.churn:
            bad.append('P9')
        if t[LC] > self.lchurn:
            bad.append('P9L')
        return bad

    def pending(self, st):
        """Some up member's log holds a config entry the group has not
        committed (E-16's tail: a change in flight)."""
        k = len(st[CM])
        for n in range(self.N):
            if st[ST][n] == UP and any(e[1][0] == 'c' for e in st[LG][n][k:]):
                return True
        return False

    def settled(self, st):
        g = self.gcfg(st)
        if not g:
            return False
        V, L, idx = g
        return all(self.cfg(st, v) is not None and self.cfg(st, v)[2] >= idx
                   for v in V if st[ST][v] == UP)

    def live_majority(self, st):
        g = self.gcfg(st)
        if not g:
            return False
        V = g[0]
        return maj(sum(1 for v in V if st[ST][v] == UP), len(V))

    def healed(self, st):
        for n in range(self.N):
            if self.working(st, n) and self.idle(st, n):
                break
        else:
            return False
        V, L = self.V(st, n), self.Lr(st, n)
        if len(V) % 2 == 0:
            return False
        lc = self.cands(st)
        if len(lc) >= 3 and len(V) < 3:
            return False
        bad = [v for v in V if st[ST][v] != UP or st[RT][v] != NONE]
        free = [m for m in lc if m not in V]
        if bad and free:
            return False
        if len(V) == 1 and any(m not in V and m not in L for m in lc):
            return False
        if any(m in st[GONE] for m in L):
            return False
        return True

    def goals(self, st):
        wr = self.writable(st)
        g = self.gcfg(st)
        V = g[0] if g else E
        L = g[1] if g else E
        up_leavers = any(self.up_leaver(st, m) for m in range(self.N))
        return {
            'P5': wr,
            'WIN': wr,
            'SWAP': wr,
            'HF': self.healed(st),
            'GF': len(V) == 3 and all(st[ST][v] == UP for v in V) and self.settled(st) and wr,
            'DL': not any(m in st[GONE] for m in L),
            'SF': not up_leavers,
            'SWF': wr,
            'POST': wr,
            'LW': wr,
            'RC': not any(st[RT][v] == RETIRE for v in V),
        }

    def judged(self, st):
        lm = self.live_majority(st)
        sett = self.settled(st)
        g = self.gcfg(st)
        V = g[0] if g else E
        L = g[1] if g else E
        crashed = any(x == DOWN for x in st[ST])
        up_leavers = any(self.up_leaver(st, m) for m in range(self.N))
        ndown = sum(1 for x in st[ST] if x == DOWN)
        lc = self.cands(st)
        if max(st[TM]) > self.MAXT - self.room:
            # the term bound: liveness is judged only where one more election fits (E-14b)
            return {k: False for k in ('P5', 'WIN', 'SWAP', 'HF', 'GF', 'DL', 'SF', 'SWF', 'POST', 'LW', 'RC')}
        pend = self.pending(st)
        # with every live machine saying "retiring" there is no place for the
        # data: the design has no rule for it (a limit, stated in the README)
        anyc = len(lc) > 0
        return {
            'P5': lm and sett and not pend,
            'WIN': lm and not sett and not pend,
            'SWAP': lm and pend,
            'HF': lm and sett and not pend and anyc,
            'GF': len(V) < 3 and len(lc) >= 3,
            'DL': self.writable(st) and any(m in st[GONE] for m in L),
            'SF': up_leavers,
            'SWF': up_leavers and ndown == 1,
            'POST': not up_leavers and ndown == 1 and any(x == EXIT for x in st[ST]),
            'LW': not crashed and anyc,
            'RC': len(V) >= 3 and any(st[RT][v] == RETIRE for v in V) and any(m not in V for m in lc),
        }


class Shrink(Grow):
    """DESIGN-V5's leave: with no spare, the group shrinks to two voters
    (the leaver is removed while the live voters left are a majority), and
    the growth rules step it back to one."""
    OPTION = 'shrink'


class Absent(Grow):
    """LAYERS 8.9's reading: with no spare, nothing removes a live leaving
    voter from three; it exits at leave.ms and stays in the config, absent.
    The leave of an only voter still promotes a learner, hands over and is
    removed from two voters (DESIGN-V5), so lrem acts only from two."""
    OPTION = 'absent'

    def lrem_extra(self):
        return [Guard('two', lambda w, st, b: len(w.V(st, b['n'])) == 2, role='leave',
                      note='only from two voters: the leave of an only voter')]


class ShrinkDUR(Shrink):
    """Shrink, with DUR checked as a safety property."""
    DUR = True


class AbsentDUR(Absent):
    """Absent, with DUR checked as a safety property."""
    DUR = True


class ShrinkOneVoter(Shrink):
    """A probe, not the design: growth's placement is written only by a group
    with one voter, as LAYERS 2.3 rule 1 words it."""

    def actions(self):
        acts = super().actions()
        for a in acts:
            if a.name == 'grow':
                g = Guard('one', lambda w, st, b: len(w.V(st, b['n'])) == 1, role='grow',
                          note='the group has one voter (LAYERS 2.3 as written)')
                g.action = 'grow'
                a.guards.insert(2, g)
        return acts


OPTIONS = {'shrink': Shrink, 'absent': Absent, 'shrink-dur': ShrinkDUR, 'absent-dur': AbsentDUR,
           'shrink-onevoter': ShrinkOneVoter}

# ---------------------------------------------------------------- bounds
# Machines 0, 1, 2 (and 3, a spare, where named). 0 leads in term 1 with the
# founding entry committed. `maxt` bounds the term.
B1 = dict(n=3, voters=(0,), place=(0,))           # founded by 0 alone; 1 and 2 up, empty
B3 = dict(n=3, voters=(0, 1, 2))                   # three voters, no spare
BOUNDS = {
    # growth from one voter
    'g0': dict(B1, maxt=3, writes=1, churn=10, maxlog=14),
    'g1': dict(B1, maxt=4, faults=1, churn=10, maxlog=20),
    'gr': dict(B1, maxt=4, retires=1, churn=10, maxlog=14),
    # a leave during growth (any machine, the founder included)
    'gl': dict(B1, maxt=4, leaves=1, churn=16, maxlog=18),
    # three voters, no spare: one leave, two leaves, a leave and a crash
    's1': dict(B3, maxt=4, leaves=1, writes=1, churn=8, maxlog=10),
    's2': dict(B3, maxt=5, leaves=2, churn=8, maxlog=14),
    's1f': dict(B3, maxt=5, room=2, leaves=1, faults=1, churn=12, maxlog=18),
    # a retire with no spare (it stays pending), and with a spare (it completes)
    'r1': dict(B3, maxt=4, retires=1, churn=8, maxlog=4),
    'r1s': dict(n=4, voters=(0, 1, 2), maxt=4, retires=1, churn=8, maxlog=12),
    # two machines (example 01): 0 the only voter, 1 a learner; a leave, and a leave with a crash
    'o1': dict(n=2, voters=(0,), learners=(1,), place=(0,), maxt=4, leaves=1, writes=1, churn=8, maxlog=12),
    'o1f': dict(n=2, voters=(0,), learners=(1,), place=(0,), maxt=6, leaves=1, faults=1, churn=8, maxlog=18),
    # with a spare: the leave is healing's swap (E-52), for comparison
    's1s': dict(n=4, voters=(0, 1, 2), maxt=4, leaves=1, churn=10, maxlog=12),
    # a retire and a leave, no spare
    'rl': dict(B3, maxt=5, leaves=1, retires=1, churn=8, maxlog=14),
    # one machine alone (a solo server), Ctrl-C; example 01 with the learner down
    'solo': dict(n=1, voters=(0,), place=(0,), maxt=3, leaves=1, churn=8, maxlog=8),
    'o1d': dict(n=2, voters=(0,), learners=(1,), place=(0,), down=(1,), maxt=4, leaves=1, churn=8, maxlog=12),
    # a retire with no spare and a crash; a spare that starts later; a third machine that starts later
    'r1f': dict(B3, maxt=4, retires=1, faults=1, churn=8, maxlog=12),
    'r1sd': dict(n=4, voters=(0, 1, 2), down=(3,), maxt=4, retires=1, churn=8, maxlog=12),
    'g0d': dict(B1, down=(2,), maxt=3, churn=10, maxlog=14),
    # a leave and a crash with three voters, a smaller term bound than s1f
    's1f4': dict(B3, maxt=4, room=2, leaves=1, faults=1, churn=12, maxlog=14),
    # ---- the big bounds: the design only (caps not measured: generous)
    'g1w': dict(B1, maxt=4, faults=1, writes=1, churn=16, maxlog=30),
    'g2': dict(B1, maxt=5, faults=2, churn=16, maxlog=30),
    'gs': dict(n=4, voters=(0,), place=(0,), maxt=4, faults=1, churn=16, maxlog=30),
    'gl2': dict(B1, maxt=5, leaves=2, churn=16, maxlog=30),
    's2f': dict(B3, maxt=5, leaves=2, faults=1, churn=16, maxlog=30),
    's1sf': dict(n=4, voters=(0, 1, 2), maxt=5, leaves=1, faults=1, churn=16, maxlog=30),
}
# The ablation sweeps the small bounds and verifies on the three largest (E-16's
# and E-52's procedure: each rule the sweep drops is tried alone on the verify
# bounds and put back if a property breaks there).
SWEEP = ('solo', 'r1', 'o1', 'o1d', 'g0', 'o1f', 's1', 'rl', 'r1s', 'g1', 'gr', 's1s')
VERIFY = ('s2', 'gl', 's1f')
EXTRA = ('r1f', 'r1sd', 'g0d', 's1f4')
ALL = SWEEP + VERIFY + EXTRA
BIG = ('g1w', 'g2', 'gs', 'gl2', 's2f', 's1sf')

# Pinned in the ablation of the design (never dropped, never mutated as
# design rules): the Raft core (raft-* records; E-10, E-14b, E-14c), the
# reductions, the world's bookkeeping and the bounds. Pass 1 still drops each
# Raft rule alone, which shows the safety properties catch it.
def pinned(cls):
    out = []
    for a in cls(BOUNDS[SWEEP[0]]).actions():
        for r in a.guards + a.updates:
            if r.role in ('raft', 'red', 'world', 'bound') and not (a.name in DESIGN_ACTS and r.role == 'raft'
                                                                  and r.name in ('leader', 'idle')):
                out.append(r.id)
    return tuple(out)


DESIGN_ACTS = ('grow', 'pick', 'add', 'standby', 'promote', 'remove', 'surplus', 'dropl', 'stepback',
               'handover', 'opromote', 'lrem', 'ldead', 'ldrop', 'exit', 'exitms', 'exitalone', 'leave')
PINNED = {o: pinned(c) for o, c in OPTIONS.items()}
