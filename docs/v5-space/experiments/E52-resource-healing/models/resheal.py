"""
resheal.py: E-52's model. Healing when each resource is its own cluster
(DECISIONS V5-2, V5-3, V5-7), with no #meta and no shared member list.

WHAT IS REUSED, UNCHANGED.
  * The rule language is E-17's harness/dsl.py, through E-16's engine
    (../../E16-controller-loop/engine/engine.py imports it unchanged), so a
    rule, a mutant and the ablation mean what they mean in E-16 and E-17.
  * The world is E-16's: this file imports E-16's models/heal.py and
    subclasses its World. Elections, commits, catch-up, CheckQuorum,
    on-commit membership (one change at a time), crashes, lost disks, cuts,
    recoveries, gone marks set by time on each side, and the properties P2
    and P3 are heal.py's code, run as written there. P9 is heal.py's
    counter, judged here with a cap per bound (below).

WHAT CHANGES IN THE WORLD (the chosen design).
  * No #meta. heal.py's #meta field is pinned to (up, side 2): no #meta
    faults, no #meta observer, and no option reads it. There is no gone mark
    in a shared place: a leader reads gone from its own links only (heal.py's
    per-side marks, which `self` already used: observers on one side lose a
    link at the same moment), plus gone hints it took itself.
  * Links (link-pings rule 1): members that share the group ping each other;
    a machine outside the group is linked to the leader only if the leader
    dialed it (`lk`). A dialed link lasts until the leader changes or the
    machine is evicted (gone past evict.after on the leader's side). What a
    leader "reaches" is a linked machine that is up on its side.
  * The soft directory (V5-3): a set of listed machines. An up machine that
    is not retiring announces itself (deliver); an entry stays while its
    announcer's link to the directory lives, so a machine that went down
    stays listed until a `time` step drops it, and a machine cut off from
    the leader stays listed (it still reaches a seed on its side). A leader
    learns a spare machine only from the directory; to use one it dials it
    (the `dial` action, counted).
  * What a machine says in its pings (draining, retiring) is heard by every
    linked observer on its side; each side keeps the last thing it heard
    from a machine it no longer reaches (`hd`; a machine that exited after
    saying "retiring" stays "retiring" to it).
  * Picks are by load, so two leaders of one group can rank machines
    differently: every choice of a machine is a free choice (a parameter).
    The placement a leader picks is a log entry ('place', members), written
    before the add (healing-self@per-resource rule 15); it commits as any
    entry does and then holds the stored placement.
  * The platform's hints arrive at leaders as outside steps (`control`,
    within a budget): gone(m), lead(m, config read), place(members, config
    read), drain(m) (to the member itself). A hint's content is free: the
    properties must hold for any hint, stale or not.
  * A member that leaves (Ctrl-C) says retiring first. A leaver exits (goes
    down for good) once it holds no voter seat and does not lead. A process
    that stopped mid-drain or mid-leave starts fresh when it recovers.
  * The preferred leader (`pref`, stored with the group) and V5-7's hand-
    back: once the preferred member has been back, a caught-up voter, for
    settle.ms (a `time` step), the leader hands leadership to it. The pace
    (a cap on transfers in flight) is abstracted: any number in flight.
    When the preferred member leaves the stored placement, the leader
    re-picks it among the placed machines (`repref`, counted).
  * A leadership transfer is Raft's TimeoutNow: it reaches the target only
    if the target answers the leader (no transfer across a cut or to a dead
    machine); the target then leads at once and commits an entry of its own
    term, as heal.py's election does.

THE STATE. heal.py's 15 fields; its unused `rep` field (index 11) holds this
model's extras: flg (what each member says in its pings: 0 none, 1 draining,
2 retiring, 3 left), gt (what each process itself knows: 0, 1 drain started,
2 leave started; the properties read it), dirl (listed members), place (the
stored placement), pref (the preferred leader), stl (the preferred member has
been back and caught up for settle.ms), hg (gone hints the current leader
holds, as its rules read them), nh and nlv (hint and leave budgets used), lc
(leadership transfers since the last outside event), hd (per side, the last
flag heard from each machine it does not reach now), lk (the leader's dialed
links), and four observers only the properties read: ak (who acknowledged
the pending entry, under any leader: P2C), lh (the member the
last applied lead hint named, until it leaves the stored placement), go (the
gone hints the current leader accepted) and ph (the last accepted place
hint, until a pick replaces it).

PROPERTIES.
  P2  heal.py's: a removal never lowers the answering voters that hold the
      commit offset below three when they were three or more.
  P2C a committed config change never leaves the committed entries on fewer
      than a majority of the new voters (judged at the commit: the replicas
      that acknowledged the change are a majority of the new voters).
  P3  heal.py's: 3 voters, or 4 between a swap's two steps.
  P5  AG EF: from every state with a live majority, a leader commits.
  P8  AG EF, healing finishes: from every state with a live majority, calm
      steps reach a working leader, an odd voter count, and no voter that is
      unreachable or retiring while a live member that is not retiring could
      replace it.
  P9  heal.py's counter, widened: no more than `churn` changes of config or
      placement without an outside event, where `churn` is twice the
      design's own longest run on that bound, at least heal.py's 8
      (results/maxchg.txt). So a counterexample makes more than twice the
      changes the design ever makes there.
  P9L no more than `lchurn` leadership transfers (hand-backs, hand-overs)
      without an outside event: twice the design's longest run, at least 4.
  P7  no add or promote targets a retiring member the leader could know is
      retiring: one its links reach now, or one it heard say so (healing.py
      round 2's P7, as far as a leader can know; the bound flag p7all judges
      every target, for a probe).
  LD  no hand-back, hand-over or lead hint hands leadership to a member that
      is draining or leaving.
  LH  a hand-back never moves leadership away from the member the last lead
      hint named (DESIGN-V5 4.2: "so the settle.ms hand-back does not undo
      it").
  DR  AG EF: from every state where the leader is draining or leaving and
      another live, caught-up voter that is neither could lead, calm steps
      reach a working leader that is neither.
  What each hint and the hand-back must do (DEP-17 makes the hint path a
  MUST; without these, a hint that does nothing breaks no property):
  LB  AG EF: from every state where the preferred member could lead (a live,
      caught-up voter, neither draining nor leaving) and does not, calm steps
      reach it leading (V5-7's hand-back). Not judged where settle.ms never
      passes (`nosettle`).
  LE  the same for the member the last lead hint named. On a bound with
      `nosettle`, only the lead hint itself can move leadership.
  PE  AG EF: from every state where the last place hint's machines are all
      up, reached and not leaving (and no pick has replaced it since), calm
      steps reach exactly those machines as the three voters.
  PR  AG EF: from every state with a working leader whose preferred member
      is not a voter of the stored placement, calm steps reach one that is
      (DESIGN-V5 4.2: the preferred leader is "the full voter the ring
      ranks first", which moves as members leave).
  P8 on a bound with `noevict` (evict.after never passes): judged once the
      leader holds a gone hint for every voter it cannot reach, so healing
      must finish on the hint alone ("leaders replace it now").
  SWAP (reported, as heal.py): states with a config change pending from
      which no leader can commit (a second fault during a swap).
"""

import importlib.util
import itertools
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
E16 = os.path.normpath(os.path.join(HERE, '..', '..', 'E16-controller-loop'))
sys.path.insert(0, os.path.join(E16, 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402  (E-17's dsl, via E-16's engine)

_spec = importlib.util.spec_from_file_location('e16_heal', os.path.join(E16, 'models', 'heal.py'))
heal = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(heal)
IX, E, maj = heal.IX, heal.E, heal.maj
REP = IX['rep']
# P9 and P9L are judged here, with a cap per bound (BOUNDS below; set from
# results/maxchg.txt). heal.py counts config changes in `chg`; here placement
# writes count there too. Leadership transfers count in `lc`. Both reset on
# every outside event. heal.py's own P9 check is lifted (it would read its
# global 8); CHURN and LCHURN are the floors.
heal.CHURN = 10 ** 9
CHURN = 8
LCHURN = 4

NONE, DRAIN, RETIRE, LEFT = 0, 1, 2, 3
XF = ('flg', 'gt', 'dirl', 'place', 'pref', 'stl', 'hg', 'nh', 'nlv', 'lh', 'lc', 'go', 'ph', 'hd', 'lk', 'ak')
XI = {f: i for i, f in enumerate(XF)}


def xg(st, f):
    return st[REP][XI[f]]


def xset(x, **kw):
    lst = list(x)
    for k, v in kw.items():
        lst[XI[k]] = v
    return tuple(lst)


def tup_set(t, i, v):
    lst = list(t)
    lst[i] = v
    return tuple(lst)


def dset(d, **kw):
    d.f['rep'] = xset(d.f['rep'], **kw)


class ResWorld(heal.World):
    CALM = ('deliver', 'time', 'tick')
    INFO = ('SWAP',)
    MODE = 'self'

    def __init__(self, bound):
        super().__init__(bound)
        self.kinds = set(bound.get('fault_kinds', ('crash', 'lose', 'cut')))   # no #meta faults
        self.hbudget = bound.get('hints', 0)
        self.hkinds = set(bound.get('hint_kinds', ('gone', 'lead', 'place', 'drain')))
        self.lbudget = bound.get('leaves', 0)
        self.p7all = bound.get('p7all', False)
        self.noevict = bound.get('noevict', False)   # evict.after never passes: only a gone hint says gone
        self.nosettle = bound.get('nosettle', False)  # settle.ms never passes: no hand-back
        self.churn = bound.get('churn', CHURN)
        self.lchurn = bound.get('lchurn', LCHURN)
        self.hd0 = ((NONE,) * self.N, (NONE,) * self.N)
        self._lo_st, self._lo_v = None, None
        if bound.get('swapfail'):
            self.INFO = ()          # a probe: report SWAP's stuck states as a failure, with a trace

    # ------------------------------------------------------------ state
    def init(self):
        st = super().init()
        up = [st[0][m][0] for m in range(self.N)]
        # the group's founding config is its first stored placement (the
        # genesis writes it with the group: genesis-conditional-create)
        x = ((NONE,) * self.N, (NONE,) * self.N, frozenset(m for m in range(self.N) if up[m]),
             frozenset(self.b['voters']), self.b['voters'][0], False, E, 0, 0, None, 0, E, None,
             self.hd0, E, E)
        return self._set(st, meta=(True, 2), rep=x)

    def to_draft(self, st):
        d = super().to_draft(st)
        d['_src'] = st           # the state the step starts from (read by freeze only)
        return d

    def freeze(self, d):
        t = super().freeze(d)
        s = d.f.get('_src')
        if s is None:
            return self.canon(t)
        return self.canon(self.carry(s, self.lost_hint(s, t)))

    def lost_hint(self, s, t):
        """A place hint is acknowledged when its entry commits. If the entry
        is lost before that (a new leader without it, or another entry
        appended over it), the hint was never applied: the platform sends it
        again (outside the model), and PE no longer asks for it."""
        tl = s[IX['tail']]
        if (tl is not None and tl[0] == 'place' and tl[2] == 'hint' and t[IX['tail']] != tl
                and t[REP][XI['ph']] is not None):
            return self._set(t, rep=xset(t[REP], ph=None))
        return t

    def carry(self, s, t):
        """What a step changes beside its own effect: settle.ms starts again
        for a new preferred member; a new leader has its own links and hints;
        a side keeps the last flag it heard from a machine it stops reaching."""
        x = t[REP]
        y = x
        # who acknowledged the pending entry, kept across a change of leader
        # (heal.py's `got` is the current leader's view, which drops a
        # replica that acknowledged and then went down); read only by P2C
        tl = t[IX['tail']]
        if tl is None:
            ak = E
        elif tl != s[IX['tail']]:
            ak = t[IX['got']]
        else:
            ak = y[XI['ak']] | s[IX['got']] | t[IX['got']]
        if ak != y[XI['ak']]:
            y = xset(y, ak=ak)
        if y[XI['stl']] and y[XI['pref']] != xg(s, 'pref'):
            y = xset(y, stl=False)
        if s[IX['ldr']] != t[IX['ldr']] and (y[XI['lk']] or y[XI['hg']] or y[XI['go']]):
            y = xset(y, lk=E, hg=E, go=E)
        if y is not x:
            t = self._set(t, rep=y)
        # a link that comes up is seen at once (as heal.py clears gone marks):
        # a gone hint for a machine the leader reaches again lapses (a
        # recovery, a healed cut, a dial, or the machine joining the group)
        hg, go = t[REP][XI['hg']], t[REP][XI['go']]
        if hg or go:
            back = {m for m in hg | go if self.reached(t, m) and not self.reached(s, m)}
            if back:
                t = self._set(t, rep=xset(t[REP], hg=hg - back, go=go - back))
        fs = xg(s, 'flg')
        if any(fs):
            ms_s, ms_t = self.members(s), self.members(t)
            hd = [list(h) for h in t[REP][XI['hd']]]
            ch = False
            for side in (0, 1):
                for m in range(self.N):
                    if (fs[m] != NONE and self.reached_from(s, side, m, ms_s)
                            and not self.reached_from(t, side, m, ms_t)):
                        hd[side][m] = fs[m]
                        ch = True
            if ch:
                t = self._set(t, rep=xset(t[REP], hd=(tuple(hd[0]), tuple(hd[1]))))
        return t

    def canon(self, t):
        """One form per state: stl means nothing without a leader or while the
        preferred member leads; a gone hint and a dialed link live in a
        leader's memory (a dialed link until the machine is evicted or joins
        the group); a lead hint lapses once its member leaves the stored
        placement; a side's memory of a flag matters only for a machine it
        does not reach now."""
        x = t[REP]
        ldr = t[IX['ldr']]
        y = x
        if y[XI['stl']] and (ldr is None or ldr[0] == y[XI['pref']]):
            y = xset(y, stl=False)
        if (y[XI['hg']] or y[XI['go']]) and ldr is None:
            y = xset(y, hg=E, go=E)
        lk = y[XI['lk']]
        if lk:
            if ldr is None:
                nlk = E
            else:
                ms = self.members(t)
                g = t[1][t[0][ldr[0]][2]]
                nlk = frozenset(m for m in lk if m not in ms and m not in g)
            if nlk != lk:
                y = xset(y, lk=nlk)
        lh = y[XI['lh']]
        if lh is not None and not self.lh_live(t, lh):
            y = xset(y, lh=None)
        if y is not x:
            t = self._set(t, rep=y)
        hd = t[REP][XI['hd']]
        if hd != self.hd0:
            ms = self.members(t)
            nhd = tuple(tuple(NONE if self.reached_from(t, s, m, ms) else hd[s][m] for m in range(self.N))
                        for s in (0, 1))
            if nhd != hd:
                t = self._set(t, rep=xset(t[REP], hd=nhd))
        return t

    # ------------------------------------------------------------ views
    def leader_ok(self, st):
        """heal.py's leader_ok, cached for the state last asked about (every
        action's `leader` guard asks it of the same state, once per
        parameter; the answer is the same)."""
        if st is self._lo_st:
            return self._lo_v
        v = super().leader_ok(st)
        self._lo_st, self._lo_v = st, v
        return v

    def members(self, st):
        """The machines in the group's config (committed or pending): they
        share the group, so they ping each other (link-pings rule 1)."""
        ms = {r[0] for r in st[IX['vot']]} | {r[0] for r in st[IX['lrn']]}
        tl = st[IX['tail']]
        if tl is not None and tl[0] == 'cfg':
            ms |= {r[0] for r in tl[1]} | {r[0] for r in tl[2]}
        return ms

    def linked(self, st, m):
        """The leader has a link to machine m: a group member, or a machine
        it dialed (kept until evicted)."""
        return m in xg(st, 'lk') or m in self.members(st)

    def reached_from(self, st, s, m, ms=None):
        """Observers on side s reach machine m now: it is up on side s, and
        linked to them (a member, or dialed by the leader on side s)."""
        up, inc, side = st[0][m]
        if not up or side != s:
            return False
        if ms is None:
            ms = self.members(st)
        return m in ms or (m in xg(st, 'lk') and self.lside(st) == s)

    def reached(self, st, m):
        """The leader's own link reaches member m now."""
        s = self.lside(st)
        return s is not None and self.reached_from(st, s, m)

    def lgone_m(self, st, m):
        """Member m is gone to the leader: its own link has been down past
        evict.after (heal.py's marks, cleared when the link comes back), or
        it holds a gone hint for m. The view itself does not test the link
        for a hint: that is rule gone.link, checked when the hint lands, and
        the world drops the hint when the link comes back, as heal.py drops
        a gone mark."""
        s = self.lside(st)
        if s is None:
            return False
        return m in st[1][s] or m in xg(st, 'hg')

    def lgone(self, st, r):
        """Replica r is gone to the leader: heal.py's gone_to on the leader's
        side (a member back with a new disk included), or a gone hint."""
        s = self.lside(st)
        if s is None:
            return False
        return self.gone_to(st, s, r) or r[0] in xg(st, 'hg')

    def seen(self, st, m):
        """What member m says in its pings (draining, retiring), as the leader
        hears it: what it says now while its link reaches m, else the last
        thing its side heard from m (nothing if never)."""
        s = self.lside(st)
        if s is None:
            return NONE
        if self.reached_from(st, s, m):
            return xg(st, 'flg')[m]
        return xg(st, 'hd')[s][m]

    # the preferred leader and the stored placement (overridden without one)
    def pref_ok(self, st):
        p = xg(st, 'pref')
        return p in xg(st, 'place') and self.cur(st, p) in st[IX['vot']]

    def pref_need(self, st):
        return xg(st, 'pref') not in xg(st, 'place')

    def pref_cand(self, st, m):
        vot = st[IX['vot']]
        first = [x for x in sorted(xg(st, 'place')) if self.cur(st, x) in vot]
        return bool(first) and m == first[0]

    def lh_live(self, st, m):
        return m in xg(st, 'place')

    def looking(self, st):
        """The leader is looking for a machine for a new copy."""
        pl = xg(st, 'place')
        return need(self, st) or any(self.lgone_m(st, x) or self.seen(st, x) == RETIRE for x in pl)

    # ------------------------------------------------------------ world steps
    def world(self, st):
        out = []
        flg = xg(st, 'flg')
        for lab, kind, t in super().world(st):
            if lab[0] in ('recover', 'lose-disk', 'crash', 'cut', 'heal') and flg[lab[1]] == LEFT:
                continue            # a member that left is gone for good
            if self.noevict and lab[0] == 'evict':
                continue
            t = self.fix(st, lab, t)
            if (kind in ('fault', 'recover') or lab[0] == 'evict') and t[REP][XI['lc']]:
                t = self._set(t, rep=xset(t[REP], lc=0))    # an outside event
            out.append((lab, kind, t))
        for lab, kind, t in self.more(st):
            out.append((lab, kind, self.fix(st, lab, t)))
        return out

    def fix(self, s, lab, t):
        """Keep the extras right across the world's own steps."""
        x = t[REP]
        if lab == ('commit', 'place'):
            x = xset(x, place=s[IX['tail']][1])
            if s[IX['tail']][2] == 'pick':
                x = xset(x, ph=None)     # a leader's own pick replaces a hinted placement
            t = self._set(t, chg=t[IX['chg']] + 1, rep=x)
        else:
            t = self.lost_hint(s, t)
        x = t[REP]
        if s[0] != t[0]:
            changed = [m for m in range(self.N) if s[0][m] != t[0][m]]
            if xg(s, 'pref') in changed:
                x = xset(x, stl=False)
            if lab[0] == 'recover' and xg(s, 'gt')[lab[1]] in (DRAIN, RETIRE):
                m = lab[1]      # a process that stopped mid-drain or mid-leave starts fresh
                x = xset(x, flg=tup_set(x[XI['flg']], m, NONE), gt=tup_set(x[XI['gt']], m, NONE))
        if x is not t[REP]:
            t = self._set(t, rep=x)
        return self.canon(self.carry(s, t))

    def more(self, st):
        out = []
        mem, x = st[0], st[REP]
        flg, gt, dirl = x[XI['flg']], x[XI['gt']], x[XI['dirl']]
        vot, tail, ldr = st[IX['vot']], st[IX['tail']], st[IX['ldr']]
        for m in range(self.N):
            up, inc, side = mem[m]
            # the soft directory: announce while up and not retiring; an entry
            # outlives its member until its link to the directory drops
            if up and flg[m] not in (RETIRE, LEFT) and m not in dirl:
                out.append((('announce', m), 'deliver', self._set(st, rep=xset(x, dirl=dirl | {m}))))
            if m in dirl and not up:
                out.append((('dirdrop', m), 'time', self._set(st, rep=xset(x, dirl=dirl - {m}))))
            # a draining process restarts (an outside step)
            if gt[m] == DRAIN:
                out.append((('undrain', m), 'recover', self._set(
                    st, chg=0, rep=xset(x, flg=tup_set(flg, m, NONE), gt=tup_set(gt, m, NONE), lc=0))))
            # a leaver exits once it holds no voter seat and does not lead
            if (gt[m] == RETIRE and up and not any(v[0] == m for v in vot)
                    and not (tail is not None and tail[0] == 'cfg' and any(v[0] == m for v in tail[1]))
                    and (ldr is None or ldr[0] != m)):
                ms = list(mem)
                ms[m] = (False, inc, side)
                out.append((('exit', m), 'deliver',
                            self._set(st, mem=tuple(ms), rep=xset(x, flg=tup_set(flg, m, LEFT)))))
        # settle.ms passes with the preferred member back, a caught-up voter
        pref = x[XI['pref']]
        if not self.nosettle and not x[XI['stl']] and ldr is not None and ldr[0] != pref:
            pr = self.cur(st, pref)
            if pr in vot and self.ans(st, pr, self.lside(st)) and pr in st[IX['held']]:
                out.append((('settle', pref), 'time', self._set(st, rep=xset(x, stl=True))))
        return out

    # ------------------------------------------------------------ properties
    def check_edge(self, s, lab, kind, t):
        bad = super().check_edge(s, lab, kind, t)     # heal.py's P2 (its P9 is lifted: below)
        if t[IX['chg']] > self.churn:
            bad.append('P9')
        if lab == ('commit', 'cfg'):
            # the replicas that acknowledged the change (each held every
            # earlier committed entry when it did), under this leader or an
            # earlier one, must be a majority of the new voters, as of the
            # old ones. A disk lost after it acknowledged is a later fault,
            # not the change's doing; heal.py's `held` is not used, since it
            # drops a replica that is down at the commit although its disk
            # keeps the entries
            nv = t[IX['vot']]
            have = xg(s, 'ak') | s[IX['got']]
            if not maj(sum(1 for v in nv if v in have), len(nv)):
                bad.append('P2C')
        a = lab[0]
        gt = xg(s, 'gt')
        if a in ('add', 'promote'):
            m = dict(lab[1])['r'][0]
            if gt[m] == RETIRE:
                ls = self.lside(s)
                heard = ls is not None and xg(s, 'hd')[ls][m] == RETIRE
                if self.p7all or self.reached(s, m) or heard:
                    bad.append('P7')
        if a in ('handback', 'handover', 'lead'):
            nl = t[IX['ldr']]
            if nl is not None and nl != s[IX['ldr']] and gt[nl[0]] in (DRAIN, RETIRE):
                bad.append('LD')        # leadership moved to a draining or leaving member
        if t[REP][XI['lc']] > self.lchurn:
            bad.append('P9L')
        if a == 'handback':
            lh, ldr = xg(s, 'lh'), s[IX['ldr']]
            if lh is not None and ldr is not None and ldr[0] == lh and t[IX['ldr']] != ldr:
                bad.append('LH')
        return bad

    def free_cands(self, st, s):
        vm = st[IX['vot']]
        gt, flg = xg(st, 'gt'), xg(st, 'flg')
        return [m for m in range(self.N) if st[0][m][0] and st[0][m][2] == s and m not in st[1][s]
                and self.cur(st, m) not in vm and gt[m] != RETIRE and flg[m] != LEFT]

    def healed(self, st):
        if not self.leader_ok(st) or st[IX['tail']] is not None:
            return False
        vot = st[IX['vot']]
        if len(vot) % 2 == 0:
            return False
        s = self.lside(st)
        gt = xg(st, 'gt')
        missing = [v for v in vot if not self.ans(st, v, s) or gt[v[0]] == RETIRE]
        return not missing or not self.free_cands(st, s)

    def goals(self, st):
        ok = self.leader_ok(st)
        writable = ok and st[IX['tail']] is None
        ldr = st[IX['ldr']]
        lh, ph = xg(st, 'lh'), xg(st, 'ph')
        return {'P5': writable, 'P8': self.healed(st), 'SWAP': writable,
                'DR': writable and xg(st, 'gt')[ldr[0]] == NONE,
                'LB': ok and ldr == self.cur(st, xg(st, 'pref')),
                'LE': ok and lh is not None and ldr == self.cur(st, lh),
                'PE': writable and ph is not None and len(st[IX['vot']]) == 3
                and frozenset(v[0] for v in st[IX['vot']]) == ph,
                'PR': self.pref_ok(st)}

    def can_lead(self, st, m):
        """Member m could take leadership now: its current replica is a voter
        that answers the leader and holds the commit offset, and it is not
        draining or leaving (what it knows itself)."""
        r = self.cur(st, m)
        return (r in st[IX['vot']] and self.ans(st, r, self.lside(st)) and r in st[IX['held']]
                and xg(st, 'gt')[m] == NONE)

    def judged(self, st):
        lm = self.live_majority(st)
        settled = st[IX['tail']] is None or st[IX['tail']][0] != 'cfg'
        dr = False
        if self.leader_ok(st) and st[IX['tail']] is None:
            ldr, gt = st[IX['ldr']], xg(st, 'gt')
            if gt[ldr[0]] in (DRAIN, RETIRE):
                s = self.lside(st)
                dr = any(v != ldr and self.ans(st, v, s) and gt[v[0]] == NONE and v in st[IX['held']]
                         for v in st[IX['vot']])
        p8 = lm and settled
        if p8 and self.noevict:
            # with no evict.after, only a gone hint says gone: judge healing
            # once the leader holds one for every voter it cannot reach
            s = self.lside(st)
            go = xg(st, 'go')
            p8 = s is not None and all(self.ans(st, v, s) or v[0] in go for v in st[IX['vot']])
        idle_ok = self.leader_ok(st) and st[IX['tail']] is None
        ldr, pref, lh, ph = st[IX['ldr']], xg(st, 'pref'), xg(st, 'lh'), xg(st, 'ph')
        lb = (not self.nosettle and idle_ok and ldr != self.cur(st, pref) and self.can_lead(st, pref))
        le = idle_ok and lh is not None and ldr != self.cur(st, lh) and self.can_lead(st, lh)
        pe = False
        if idle_ok and ph is not None:
            s, gt, flg = self.lside(st), xg(st, 'gt'), xg(st, 'flg')
            pe = all(st[0][m][0] and st[0][m][2] == s and gt[m] != RETIRE and flg[m] != LEFT for m in ph)
        pr = idle_ok and self.pref_need(st)
        return {'P5': lm and settled, 'P8': p8, 'SWAP': lm and not settled, 'DR': dr,
                'LB': lb, 'LE': le, 'PE': pe, 'PR': pr}


# ---------------------------------------------------------------- helpers

def g_leader(w, st, b):
    return w.leader_ok(st)


def g_idle(w, st, b):
    return st[IX['tail']] is None


def L(w, st):
    return w.lside(st)


def vote_count(w, st, b):
    return len(st[IX['vot']])


def base_place(st):
    pl = xg(st, 'place')
    return pl if pl is not None else frozenset(v[0] for v in st[IX['vot']])


def need(w, st, b=None):
    """A replacement is needed: a voter is gone to the leader, or the stored
    placement leaves a voter out (a pick, a leave or a place hint)."""
    vot, pl = st[IX['vot']], xg(st, 'place')
    return any(w.lgone(st, v) for v in vot) or (pl is not None and any(v[0] not in pl for v in vot))


def append_entry(w, st, d, entry):
    """The leader appends an entry; it reaches every answering replica that
    holds the commit offset (heal.py's append, for any entry)."""
    s = w.lside(st)
    members = st[IX['vot']] | st[IX['lrn']]
    d.f['tail'] = entry
    d.f['got'] = frozenset(r for r in members if r in st[IX['held']] and w.ans(st, r, s))


def xfer(w, st, d, t, count=True):
    """A leadership transfer to replica t (Raft's TimeoutNow). It reaches t
    only if t answers the leader (not across a cut, not to a dead machine):
    otherwise nothing happens, as Raft's transfer times out. Then t leads at
    once and commits an entry of its own term, as heal.py's election does."""
    s = w.lside(st)
    if s is None or not w.ans(st, t, s):
        return
    tail, got = st[IX['tail']], st[IX['got']]
    if t in got and tail is not None:
        d.f['tail'], d.f['got'] = tail, frozenset(r for r in got if w.ans(st, r, s))
    else:
        d.f['tail'], d.f['got'] = ('noop',), frozenset([t])
    d.f['ldr'] = t
    if count:
        dset(d, lc=st[REP][XI['lc']] + 1)
    dset(d, hg=E, go=E, lk=E)


def budget(kind):
    def f(w, st, b, d):
        x = d.f['rep']
        kw = {'nh': x[XI['nh']] + 1} if kind != 'leave' else {'nlv': x[XI['nlv']] + 1}
        if kind == 'leave':
            kw['gt'] = tup_set(x[XI['gt']], b['m'], RETIRE)
        if kind == 'drain':
            kw['gt'] = tup_set(x[XI['gt']], b['m'], DRAIN)
        if kind == 'lead':
            kw['lh'] = b['m']
        if kind == 'gone':
            kw['go'] = x[XI['go']] | {b['m']}
        if kind == 'place':
            kw['ph'] = b['p']
        kw['lc'] = 0
        d.f['rep'] = xset(x, **kw)
        d.f['chg'] = 0
    return f


class ResHeal(ResWorld):
    """Healing by each group's own leader, from its own links, with a stored
    placement, the platform's hints, retiring, drains and the hand-back."""

    def actions(self):
        def known(w, st):
            """The machines a leader can name: the soft directory's entries,
            the group's members, and the machines it dialed (topology, not
            a rule)."""
            return sorted(set(xg(st, 'dirl')) | w.members(st) | set(xg(st, 'lk')))

        def reps(w, st):
            if w.lside(st) is None:
                return
            for m in known(w, st):
                yield {'r': w.cur(st, m)}

        def cfg_reps(w, st):
            if w.lside(st) is None:
                return
            for r in sorted(st[IX['vot']] | st[IX['lrn']]):
                yield {'r': r}

        def dial_params(w, st):
            """A leader dials a listed machine while it looks for one: a voter
            is gone or left out of the stored placement, or a placed machine
            is gone or said it is retiring (when to dial is the leader's
            business; a dial at another time only adds a link)."""
            if w.lside(st) is None or not w.looking(st):
                return
            ms, lk = w.members(st), xg(st, 'lk')
            for m in sorted(xg(st, 'dirl')):
                if m not in ms and m not in lk:
                    yield {'m': m}

        def pick_params(w, st):
            if w.lside(st) is None:
                return
            ms = known(w, st)
            for x in sorted(base_place(st)):
                for c in ms:
                    yield {'x': x, 'c': c}

        def voters(w, st):
            if w.lside(st) is None:
                return
            for r in sorted(st[IX['vot']] | st[IX['lrn']]):
                yield {'r': r}

        def leader_only(w, st):
            if st[IX['ldr']] is not None:
                yield {}

        def any_member(w, st):
            if st[IX['ldr']] is not None:
                for m in range(w.N):
                    yield {'m': m}

        def leave_params(w, st):
            if xg(st, 'nlv') >= w.lbudget:
                return
            for m in range(w.N):
                if st[0][m][0] and xg(st, 'gt')[m] != RETIRE:
                    yield {'m': m}

        def hint_ok(w, st, kind):
            return xg(st, 'nh') < w.hbudget and kind in w.hkinds

        def drain_params(w, st):
            if not hint_ok(w, st, 'drain'):
                return
            for m in range(w.N):
                if st[0][m][0] and xg(st, 'gt')[m] == NONE:
                    yield {'m': m}

        def lead_params(w, st):
            if not hint_ok(w, st, 'lead') or st[IX['ldr']] is None:
                return
            ep = st[IX['ep']]
            for m in range(w.N):
                for e in sorted({max(0, ep - 1), ep}):
                    yield {'m': m, 'e': e}

        def place_params(w, st):
            if not hint_ok(w, st, 'place') or st[IX['ldr']] is None:
                return
            ep = st[IX['ep']]
            for p in itertools.combinations(range(w.N), 3):
                for e in sorted({max(0, ep - 1), ep}):
                    yield {'p': frozenset(p), 'e': e}

        def gone_params(w, st):
            if not hint_ok(w, st, 'gone') or st[IX['ldr']] is None:
                return
            for m in range(w.N):
                yield {'m': m}

        def add_upd(w, st, b, d):
            w.append(st, d, st[IX['vot']], st[IX['lrn']] | {b['r']}, st[IX['newv']])

        def promote_upd(w, st, b, d):
            w.append(st, d, st[IX['vot']] | {b['r']}, st[IX['lrn']] - {b['r']}, b['r'])

        def remove_upd(w, st, b, d):
            w.append(st, d, st[IX['vot']] - {b['r']}, st[IX['lrn']], st[IX['newv']])

        def dropl_upd(w, st, b, d):
            w.append(st, d, st[IX['vot']], st[IX['lrn']] - {b['r']}, st[IX['newv']])

        def pick_upd(w, st, b, d):
            append_entry(w, st, d, ('place', frozenset((base_place(st) - {b['x']}) | {b['c']}), 'pick'))

        def dial_upd(w, st, b, d):
            m = b['m']
            up, inc, side = st[0][m]
            if up and side == w.lside(st):        # the dial is answered only by a live machine on its side
                x = d.f['rep']
                d.f['rep'] = xset(x, lk=x[XI['lk']] | {m})

        def placed(w, st, m):
            pl = xg(st, 'place')
            return pl is not None and m in pl

        def pref_rep(w, st):
            return w.cur(st, xg(st, 'pref'))

        def set_flag(flag):
            def f(w, st, b, d):
                x = d.f['rep']
                d.f['rep'] = xset(x, flg=tup_set(x[XI['flg']], b['m'], flag))
            return f

        def unlist(w, st, b, d):
            x = d.f['rep']
            d.f['rep'] = xset(x, dirl=x[XI['dirl']] - {b['m']})

        def set_pref(w, st, b, d):
            dset(d, pref=b['m'])

        def mark_gone(w, st, b, d):
            x = d.f['rep']
            d.f['rep'] = xset(x, hg=x[XI['hg']] | {b['m']})

        return [
            # ---------------- healing (E-16's five actions, names kept) ----------------
            Action('add', 'deliver', reps, [
                Guard('leader', g_leader, role='raft', note='only a working leader proposes'),
                Guard('idle', g_idle, role='raft', note='one change at a time (etcd)'),
                Guard('cand', lambda w, st, b: w.reached(st, b['r'][0]), role='target',
                      note="E-16's add.cand: a live machine the leader's own link reaches now"),
                Guard('new', lambda w, st, b: b['r'] not in st[IX['vot']] | st[IX['lrn']], role='target',
                      note='this replica is not already in the config'),
                Guard('need', need, role='target',
                      note='a voter is gone, or the stored placement leaves a voter out'),
                Guard('placed', lambda w, st, b: placed(w, st, b['r'][0]), role='place',
                      note='add only a machine the stored placement names (rule 15: the pick is written first)'),
                Guard('notret', lambda w, st, b: w.seen(st, b['r'][0]) != RETIRE, role='retire',
                      note='never a machine that said it is retiring (meta-members@per-resource rule 2)'),
            ], [Update('append', add_upd, role='step')]),
            Action('promote', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('learner', lambda w, st, b: b['r'] in st[IX['lrn']], role='target'),
                Guard('live', lambda w, st, b: w.ans(st, b['r'], L(w, st)), role='target',
                      note='the learner answers the leader now (E-16: "not gone"; that reading breaks P2C, '
                           'probe resgone)'),
                Guard('caught', lambda w, st, b: b['r'] in st[IX['held']], role='swap'),
                Guard('need', need, role='target'),
                Cmp('odd', vote_count, '<', lambda w, st, b: 4, role='target',
                    note='promote only from three voters (to four, for the swap)'),
                Guard('placed', lambda w, st, b: placed(w, st, b['r'][0]), role='place',
                      note='promote only a machine the stored placement names'),
                Guard('notret', lambda w, st, b: w.seen(st, b['r'][0]) != RETIRE, role='retire'),
            ], [Update('append', promote_upd, role='step')]),
            Action('remove', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('voter', lambda w, st, b: b['r'] in st[IX['vot']], role='target'),
                Guard('gone', lambda w, st, b: w.lgone(st, b['r']), role='target',
                      note="gone to the leader's own links (or by a gone hint it took)"),
                Cmp('four', vote_count, '>=', lambda w, st, b: 4, role='swap'),
                Guard('newok', lambda w, st, b: st[IX['newv']] is None or b['r'] == st[IX['newv']]
                      or st[IX['newv']] in st[IX['held']], role='swap'),
            ], [Update('append', remove_upd, role='step')]),
            Action('surplus', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('voter', lambda w, st, b: b['r'] in st[IX['vot']], role='target'),
                Cmp('four', vote_count, '>=', lambda w, st, b: 4, role='target'),
                Guard('nogone', lambda w, st, b: not any(w.lgone(st, v) for v in st[IX['vot']]), role='target'),
                Guard('last', lambda w, st, b: xg(st, 'place') is not None and b['r'][0] not in xg(st, 'place'),
                      role='target', note='the voter the stored placement leaves out (read from the log)'),
                Guard('allheld', lambda w, st, b: all(v in st[IX['held']] and w.ans(st, v, L(w, st))
                                                      for v in st[IX['vot']] - {b['r']}), role='swap'),
            ], [Update('append', remove_upd, role='step')]),
            Action('dropl', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('learner', lambda w, st, b: b['r'] in st[IX['lrn']], role='target'),
                Guard('gone', lambda w, st, b: w.lgone(st, b['r']), role='target'),
            ], [Update('append', dropl_upd, role='step')]),
            # ---------------- finding a spare: the directory, then a dial ----------------
            Action('dial', 'deliver', dial_params, [
                Guard('leader', g_leader, role='raft'),
            ], [Update('link', dial_upd, role='dir',
                       note='the leader dials a machine the directory lists, so its own link can reach it')]),
            # ---------------- rule 15: the pick, written before the add ----------------
            Action('pick', 'deliver', pick_params, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('need', lambda w, st, b: w.lgone_m(st, b['x']) or w.seen(st, b['x']) == RETIRE,
                      role='place', note='re-pick only a placed machine that is gone to the leader or retiring'),
                Guard('cand', lambda w, st, b: w.linked(st, b['c']) and not w.lgone_m(st, b['c']), role='target',
                      note="the high-bound add.cand: a machine the leader's own link reached within evict.after"),
                Guard('new', lambda w, st, b: b['c'] not in base_place(st), role='place'),
                Guard('notret', lambda w, st, b: w.seen(st, b['c']) != RETIRE, role='retire'),
            ], [Update('append', pick_upd, role='place',
                       note="write the pick into the group's log as the placement (rule 15)")]),
            # ---------------- the leave (meta-members@per-resource) ----------------
            Action('leave', 'control', leave_params, [], [
                Update('mark', set_flag(RETIRE), role='retire',
                       note='marks itself retiring first: says it in its pings'),
                Update('unlist', unlist, role='retire', note='takes its machine entry out of the directory'),
                Update('start', budget('leave'), role='pin', note='the leave starts (world)'),
            ]),
            # ---------------- the platform's hints (planner-hints@per-resource) ----------------
            Action('drain', 'control', drain_params, [], [
                Update('mark', set_flag(DRAIN), role='hint', note='a draining process says so in its pings'),
                Update('start', budget('drain'), role='pin'),
            ]),
            Action('handover', 'deliver', voters, [
                Guard('leader', g_leader, role='raft'),
                Guard('self', lambda w, st, b: xg(st, 'gt')[st[IX['ldr']][0]] in (DRAIN, RETIRE), role='hint',
                      note='a draining or leaving process hands over every group it leads'),
                Guard('voter', lambda w, st, b: b['r'] in st[IX['vot']], role='xfer'),
                Guard('notme', lambda w, st, b: b['r'] != st[IX['ldr']], role='xfer'),
                Guard('live', lambda w, st, b: w.ans(st, b['r'], L(w, st)), role='xfer'),
                Guard('caught', lambda w, st, b: b['r'] in st[IX['held']], role='xfer'),
                Guard('notdrn', lambda w, st, b: w.seen(st, b['r'][0]) == NONE, role='hint',
                      note='never to a member that says it is draining or retiring'),
            ], [Update('transfer', lambda w, st, b, d: xfer(w, st, d, b['r']), role='xfer')]),
            Action('lead', 'control', lead_params, [
                Guard('leader', g_leader, role='raft'),
                Guard('stale', lambda w, st, b: b['e'] == st[IX['ep']], role='hint',
                      note='stale-plan: applied only if the config it read is still current'),
                Guard('voter', lambda w, st, b: w.cur(st, b['m']) in st[IX['vot']], role='xfer'),
                Guard('notme', lambda w, st, b: w.cur(st, b['m']) != st[IX['ldr']], role='xfer'),
                Guard('live', lambda w, st, b: w.ans(st, w.cur(st, b['m']), L(w, st)), role='xfer'),
                Guard('caught', lambda w, st, b: w.cur(st, b['m']) in st[IX['held']], role='xfer'),
                Guard('notdrn', lambda w, st, b: w.seen(st, b['m']) == NONE, role='hint',
                      note='a drained or retiring member is never made leader or preferred'),
            ], [Update('transfer', lambda w, st, b, d: xfer(w, st, d, w.cur(st, b['m']), count=False), role='xfer'),
                Update('pref', set_pref, role='hint', note="also sets the group's preferred leader"),
                Update('budget', budget('lead'), role='pin')]),
            Action('place', 'control', place_params, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('stale', lambda w, st, b: b['e'] == st[IX['ep']], role='hint'),
                Guard('reach', lambda w, st, b: all(w.reached(st, m) or (m in xg(st, 'dirl') and st[0][m][0]
                                                                        and st[0][m][2] == L(w, st))
                                                    for m in b['p'] if not any(v[0] == m for v in st[IX['vot']])),
                      role='hint', note="a new machine the hint names must be one the leader's own links reach "
                                        "(dialing it if the directory lists it)"),
            ], [Update('append', lambda w, st, b, d: append_entry(w, st, d, ('place', b['p'], 'hint')), role='hint',
                       note="writes the hint's placement into the group's log (rule 15's record)"),
                Update('budget', budget('place'), role='pin')]),
            Action('gone', 'control', gone_params, [
                Guard('leader', g_leader, role='raft'),
                Guard('link', lambda w, st, b: not w.reached(st, b['m']), role='hint',
                      note="ignored while the leader's own link to that member is up"),
            ], [Update('mark', mark_gone, role='hint', note='the leader treats the member as gone now'),
                Update('budget', budget('gone'), role='pin')]),
            # ---------------- V5-7's hand-back ----------------
            Action('handback', 'deliver', leader_only, [
                Guard('leader', g_leader, role='raft'),
                Guard('notme', lambda w, st, b: xg(st, 'pref') != st[IX['ldr']][0], role='hand'),
                Guard('voter', lambda w, st, b: pref_rep(w, st) in st[IX['vot']], role='hand'),
                Guard('live', lambda w, st, b: w.ans(st, pref_rep(w, st), L(w, st)), role='hand'),
                Guard('caught', lambda w, st, b: pref_rep(w, st) in st[IX['held']], role='hand'),
                Guard('settle', lambda w, st, b: xg(st, 'stl'), role='hand',
                      note='back and caught up for settle.ms'),
                Guard('notdrn', lambda w, st, b: w.seen(st, xg(st, 'pref')) == NONE, role='hint',
                      note='no hand-back to a member that says it is draining or retiring'),
            ], [Update('transfer', lambda w, st, b, d: xfer(w, st, d, pref_rep(w, st)), role='xfer')]),
            # ---------------- who is preferred once the preferred member leaves ----------------
            Action('repref', 'deliver', any_member, [
                Guard('leader', g_leader, role='raft'),
                Guard('need', lambda w, st, b: w.pref_need(st), role='pref',
                      note='only when the preferred member is out of the stored placement'),
                Guard('first', lambda w, st, b: w.pref_cand(st, b['m']), role='pref',
                      note='the new preferred member is the first voter the stored placement names'),
            ], [Update('set', set_pref, role='pref',
                       note="the group's preferred leader becomes that machine (DESIGN-V5 4.2: the ring's first; "
                            "with no ring, a placed machine)")]),
        ]


OPTIONS = {'res': ResHeal}
PINNED = {'res': ('leave.start', 'drain.start', 'lead.budget', 'place.budget', 'gone.budget')}

# Members 0, 1, 2 start as voters (0 leads and is the preferred leader); 3 is
# a spare. Faults: crash (disk kept), lost disk, a member cut off to side 1.
# `churn` and `lchurn` (P9, P9L): twice the design's longest run on that
# bound, at least 8 and 4 (results/maxchg.txt); CAPS below sets them.
V = (0, 1, 2)
BOUNDS = {
    'f1': dict(members=4, voters=V, faults=1),
    'four1': dict(members=4, voters=V, learners=(3,), faults=1),
    'l1': dict(members=4, voters=V, faults=0, leaves=1),
    'll2': dict(members=4, voters=V, faults=0, leaves=2),
    'h1': dict(members=4, voters=V, faults=1, hints=1),
    'hg1': dict(members=4, voters=V, faults=1, hints=1, hint_kinds=('gone',)),
    'hl1': dict(members=4, voters=V, faults=1, hints=1, hint_kinds=('lead',)),
    'hp1': dict(members=4, voters=V, faults=1, hints=1, hint_kinds=('place',)),
    'hd1': dict(members=4, voters=V, faults=1, hints=1, hint_kinds=('drain',)),
    'hgn': dict(members=4, voters=V, faults=1, hints=1, hint_kinds=('gone',), noevict=True),
    'hl0': dict(members=4, voters=V, faults=0, hints=1, hint_kinds=('lead',)),
    'hln': dict(members=4, voters=V, faults=0, hints=1, hint_kinds=('lead',), nosettle=True),
    'hp0': dict(members=4, voters=V, faults=0, hints=1, hint_kinds=('place',)),
    'hd0': dict(members=4, voters=V, faults=0, hints=1, hint_kinds=('drain',)),
    'lh1': dict(members=4, voters=V, faults=0, leaves=1, hints=1),
    'lf1': dict(members=4, voters=V, faults=1, leaves=1),
    'll2f': dict(members=4, voters=V, faults=1, leaves=2),
    'f2': dict(members=4, voters=V, faults=2),
    'h2': dict(members=4, voters=V, faults=1, hints=2),
    'mix': dict(members=4, voters=V, faults=1, hints=1, leaves=1),
    # two hints (DEP-17: stale, duplicated or reordered hints), no fault
    'hh0': dict(members=4, voters=V, faults=0, hints=2),
    'lhh': dict(members=4, voters=V, faults=0, leaves=1, hints=2),
    'hpl0': dict(members=4, voters=V, faults=0, hints=2, hint_kinds=('place', 'lead')),
    'hd2': dict(members=4, voters=V, faults=0, hints=2, hint_kinds=('drain',)),
    # probes: P7 judged on every target, reached or not
    'lf1p7': dict(members=4, voters=V, faults=1, leaves=1, p7all=True),
    # probe: the shortest trace to a SWAP state that can never commit again
    'lf1swap': dict(members=4, voters=V, faults=1, leaves=1, swapfail=True),
}
# The design's longest run of changes (config and placement) and of
# leadership transfers after one outside event, per bound (results/maxchg.txt).
MAXCHG = {'hl0': (0, 0), 'hln': (0, 0), 'hp0': (4, 1), 'hd0': (0, 1), 'l1': (4, 2), 'hgn': (4, 2),
          'four1': (3, 2), 'f1': (4, 2), 'll2': (4, 2), 'hg1': (4, 2), 'hpl0': (4, 2), 'hd2': (0, 2),
          'hh0': (4, 2), 'lh1': (8, 4), 'lhh': (8, 4), 'h1': (7, 4), 'lf1': (8, 4),
          'f2': (7, 3), 'll2f': (8, 4)}    # ll2f: in the first 5,000,000 states (results/maxchg-big.txt)
for _b, (_c, _l) in MAXCHG.items():
    BOUNDS[_b]['churn'] = max(CHURN, 2 * _c)
    BOUNDS[_b]['lchurn'] = max(LCHURN, 2 * _l)
SWEEP = ('hl0', 'hln', 'hp0', 'hd0', 'l1', 'hgn', 'four1', 'f1', 'll2', 'hg1', 'lh1')
VERIFY = ('h1', 'lf1')
VERIFY_PASS1 = True


# ---------------------------------------------------------------- without a stored placement
# Shapes of the same healing with no stored pick, to test rule 15 as a design
# choice (DEV-10's ablation tests it rule by rule inside the design, where
# every add follows the stored placement, so dropping the write alone leaves
# nothing to follow). They drop the pick action, the place hint (with no
# placement record there is nowhere to write it) and the `placed` guards; a
# replacement is needed while a voter is gone or says it is retiring; the
# preferred member is re-picked among the voters once it is no voter.

def need_noplace(w, st, b=None):
    return any(w.lgone(st, v) or w.seen(st, v[0]) == RETIRE for v in st[IX['vot']])


class _NoPlace(ResHeal):
    def last_guard(self):
        return None

    def pref_need(self, st):
        return self.cur(st, xg(st, 'pref')) not in st[IX['vot']]

    def pref_cand(self, st, m):
        vot = st[IX['vot']]
        first = [x for x in range(self.N) if self.cur(st, x) in vot]
        return bool(first) and m == first[0]

    def looking(self, st):
        return need_noplace(self, st)

    def pref_ok(self, st):
        return self.cur(st, xg(st, 'pref')) in st[IX['vot']]

    def lh_live(self, st, m):
        return self.cur(st, m) in st[IX['vot']]

    def actions(self):
        acts = [a for a in super().actions() if a.name not in ('pick', 'place')]
        for a in acts:
            if a.name in ('add', 'promote'):
                a.guards = [g for g in a.guards if g.name != 'placed']
            for g in a.guards:
                if g.name == 'need' and a.name != 'repref':
                    g.fn = need_noplace
            if a.name == 'surplus':
                gs = []
                for g in a.guards:
                    if g.name == 'last':
                        lg = self.last_guard()
                        if lg is None:
                            continue
                        g.fn, g.note = lg
                    gs.append(g)
                a.guards = gs
        return acts


class FreeHeal(_NoPlace):
    """Picks by load and nothing stored: which voter a surplus removal takes
    is a free choice (each leader ranks by its own view of load)."""


class RingHeal(_NoPlace):
    """The record's low bound: a target every leader computes the same way
    from the group's own config and its members' signals: a surplus removal
    takes a voter that says it is retiring, else the voter with the highest
    id (E-16's ring order)."""

    def last_guard(self):
        def last(w, st, b):
            ret = [v for v in st[IX['vot']] if w.seen(st, v[0]) == RETIRE]
            return b['r'] in ret if ret else b['r'] == max(st[IX['vot']])
        return last, 'a retiring voter first, else the voter the ring ranks last (every leader computes the same)'


OPTIONS.update({'free': FreeHeal, 'ring': RingHeal})
PINNED.update({'free': PINNED['res'], 'ring': PINNED['res']})


class RetFirstHeal(_NoPlace):
    """Picks by load and nothing stored, but a surplus removal takes a voter
    that says it is retiring first (else a free choice): the one ordering a
    load ranking cannot get wrong, since every leader hears the same signal."""

    def last_guard(self):
        def last(w, st, b):
            ret = [v for v in st[IX['vot']] if w.seen(st, v[0]) == RETIRE]
            return b['r'] in ret if ret else True
        return last, 'a retiring voter first, else any (the leader ranks by load)'


OPTIONS.update({'retfirst': RetFirstHeal})
PINNED.update({'retfirst': PINNED['res']})


class ResGoneHeal(ResHeal):
    """A probe, not the design: promote.live as E-16 wrote it, "the learner is
    not gone to the leader" (reached within evict.after), in place of "the
    learner answers the leader now"."""

    def actions(self):
        acts = super().actions()
        for a in acts:
            if a.name == 'promote':
                for g in a.guards:
                    if g.name == 'live':
                        g.fn = lambda w, st, b: not w.lgone(st, b['r'])
                        g.note = 'not gone to the leader (E-16)'
        return acts


class ResNowHeal(ResHeal):
    """A probe, not the design: the leader forgets what a machine said once
    its link drops (this model's first reading): `seen` is the flag of a
    machine the leader reaches now, else nothing."""

    def seen(self, st, m):
        return xg(st, 'flg')[m] if self.reached(st, m) else NONE


class ResGoneNowHeal(ResGoneHeal):
    """A probe: both first readings at once (E-16's promote.live, and a
    leader that forgets what a machine said), as this model first had them."""

    def seen(self, st, m):
        return xg(st, 'flg')[m] if self.reached(st, m) else NONE


class ResOpenHeal(ResHeal):
    """A probe, not the design: the leader reaches every live machine on its
    side, linked or not (the first version of this model's links, E-16's)."""

    def reached_from(self, st, s, m, ms=None):
        up, inc, side = st[0][m]
        return up and side == s

    def linked(self, st, m):
        return True


OPTIONS.update({'resgone': ResGoneHeal, 'resnow': ResNowHeal, 'resgonenow': ResGoneNowHeal, 'resopen': ResOpenHeal})
for _o in ('resgone', 'resnow', 'resgonenow', 'resopen'):
    PINNED[_o] = PINNED['res']
