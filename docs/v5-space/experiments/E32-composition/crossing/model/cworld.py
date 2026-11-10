"""
cworld.py: E-17's world, with the parts the composed crossing needs added.

WHAT IS REUSED. E-17's shared harness, unchanged and imported from its own
folder: the rule language (dsl.py: Action, Guard, Cmp, Update, Mutation) and
the world (world.py: groups as abstract Raft logs with a committed log, the
leader's uncommitted tail and the tails earlier leaders lost; the client's
copies that reach any group at any time; the reader; the ghost history; the
properties P1, P2, P3, P4, P6 and the goals L4, L5, L5b, L5g, L7). CWorld
subclasses World. With every added part switched off by the bound, CWorld
makes exactly World's steps (run.sh `base` checks the state and step counts
on E-17's six bounds).

WHAT IS ADDED (the world's own steps; not counted as rules).
- Members and replicas, from E-16's world (heal.py), in a smaller form.
  Members 0..M-1 run a replica of every group (COMP's G `pslot`: a project's
  groups share its servers, so one crash hits the source and the target at
  once). A member is (up, disk incarnation). A replica is (member,
  incarnation): a member back without its disk is a new replica (Z
  `rejoin`). Each group has a leader (a member, or None) and `held`, the
  replicas whose disk holds every committed entry.
- Membership on commit (E-14): a group's config (voters, learners) is the
  last committed ('cfg', ...) entry of its log, or the bound's start. An
  entry commits when a majority of the committed config's voters are up and
  hold the log. A leader that its own committed change removes steps down.
- Elections. With no leader, any live voter stands (A-01 rule 3). A voter
  grants its vote unless it holds every committed entry and the candidate
  does not (Raft's log check). A candidate with a majority of the committed
  config's voters wins and keeps any prefix of the old leader's tail, or of
  a tail an earlier leader lost (E-17's rule for a deposed leader).
- Catch-up: a live replica of the config that is behind gets the leader's
  log (or its snapshot: the two are one step here) and joins `held`.
- Member faults (a budget): a crash (disk kept) and a lost disk. Recovery
  is free, and is not a calm step (as in E-16): liveness is asked with the
  failed member still down.
- The client's acknowledgements (E-20 `sess`): once an attempt has its
  answer the client may take it; the lowest unacknowledged id is the floor
  its later copies carry.
- Only a group with a live leader appends or answers.

PROPERTIES ADDED (E-14's and E-16's, at this level of abstraction).
  QL  E-14's QuorumLogInv, counting live disks (E-14's QuorumLogInvLive):
      every majority of a group's committed voters holds a replica with
      every committed entry.
  LC  E-14's LeaderCompletenessInv: a leader holds every committed entry.
  LV  a leader is a voter of its group's committed config (E-14c's r19: a
      removed leader never takes the group back).
  CF  E-14's CommittedIsDurableInv, for config entries: a group's config is
      the last config change it committed (a ghost remembers it).
  HV  E-16's P3: a healing group keeps three voters, or four inside a swap.
  HR  E-16's P2: a removal never lowers the answering voters that hold the
      commit offset below three.
  P8  E-30's ONCE: derived outputs apply once each, in source order.
  DP  E-30's DONE, on the bounds remit-* only: an output answered "already
      applied" has its source record's output applied. Those bounds also
      turn on E-30's `dup` answer (a world rule there, pinned here too): an
      output at or below the slot's mark, re-emitted under a new id, is
      answered "already applied" by a group whose committed log holds the
      slot open. With `remit` off (every other bound) nothing changes.
  LH  E-16's P8 (AG EF): healing finishes.
Liveness (L4, L5, L5b, L5g, L7, LH) is asked from every state where every
group has a live majority of its committed voters; calm steps are commit,
deliver (elections, catch-up, acks and every protocol step) and read.
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
E17 = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'E17-partitioning', 'harness'))
if E17 not in sys.path:
    sys.path.insert(0, E17)

from world import World, Draft, norm_lost, EMPTY, PARTS, PIDX     # noqa: E402  (E-17's, unchanged)

PROPS_ADDED = {
    'QL': "E-14 QuorumLogInv (live disks): every majority of a group's committed voters holds a replica "
          'with every committed entry',
    'LC': 'E-14 LeaderCompletenessInv: a leader holds every committed entry',
    'LV': "a leader is a voter of its group's committed config (E-14c r19)",
    'CF': "E-14 CommittedIsDurableInv, for config entries: a group's config is the last config change it "
          'committed',
    'HV': 'E-16 P3: a healing group keeps three voters, or four inside a swap',
    'HR': 'E-16 P2: a removal never lowers the answering voters that hold the commit offset below three',
    'P8': 'E-30 ONCE: derived outputs apply once each, in source order',
    'DP': 'E-30 DONE (bounds remit-*): an output answered "already applied" (dup) has its source '
          "record's output applied",
    'LH': 'E-16 P8 (AG EF): healing finishes',
}
CALM = ('commit', 'deliver', 'read')
GOALS = ('L5', 'L7', 'L4', 'L5g', 'LH')


class CDraft(Draft):
    """E-17's Draft, for groups that also carry (leader, held), and with a
    cut: the log's prefix replaced by a snapshot entry."""
    __slots__ = ()

    def append(self, g, entry):
        if self.groups is None:
            self.groups = list(self.st[0])
        com, tail, lost, cr, ldr, held = self.groups[g]
        if entry in com or entry in tail:
            return                  # a log never holds the same entry twice (E-17)
        if len(com) + len(tail) >= self.w.cap:
            self.capped = True
            return
        self.groups[g] = (com, tail + (entry,), lost, cr, ldr, held)

    def cut(self, g, k, snap):
        """Replace the first k entries of g's log by `snap`."""
        if self.groups is None:
            self.groups = list(self.st[0])
        com, tail, lost, cr, ldr, held = self.groups[g]
        if k <= len(com):
            self.groups[g] = ((snap,) + com[k:], tail, lost, cr, ldr, held)
        else:                       # above the commit offset (only a mutant does this)
            self.groups[g] = ((snap,), tail[k - len(com):], lost, cr, ldr, held)

    def freeze(self):
        st = self.st
        groups = st[0] if self.groups is None else tuple(self.groups)
        return (groups, st[1], self.refused, self.reader, st[4], st[5], st[6], st[7])


def maj(have, of):
    return 2 * have > of


class CWorld(World):
    """State: (groups, hist, refused, reader, mem, acked, used, gcfg).
      groups  one (com, tail, lost, crashes, ldr, held) per group
      mem     one (up, incarnation) per member; () with no replica layer
      acked   the attempts whose answer the client has taken
      used    (member faults used, log drops used)
      gcfg    a ghost: per group, the last config change it committed (None
              before the first), for property CF"""

    def __init__(self, option_cls, bound, mutation=None, cap=12):
        super().__init__(option_cls, bound, mutation, cap=cap)
        b = bound
        self.rep = 'members' in b
        self.M = b.get('members', 0)
        self.voters0 = b.get('voters')                 # per group: tuple of members
        self.leaders0 = b.get('leaders')               # per group: a member
        self.fail = tuple(b.get('fail', ()))           # members that may fail
        self.kinds = tuple(b.get('kinds', ('crash', 'lose')))
        self.mfaults = b.get('mfaults', 0)
        self.drops = b.get('drops', 0)
        self.never = tuple(b.get('never', ()))         # members that never come back (as E-16's `never`)
        self.heal = frozenset(b.get('heal', ()))       # groups whose leader heals
        self.sess = dict(b.get('sess', {}))            # attempt id -> session sequence
        self.derived = dict(b.get('derived', {}))      # attempt id -> source sequence
        self.sess_aids = tuple(a for a in self.aids if a in self.sess)
        self.remit = bool(b.get('remit'))              # E-30's `dup` answer (bounds remit-*)
        self.opt.bind(self)
        self._fst, self._facts = None, None

    # ------------------------------------------------------------- states
    def init(self):
        gen = self.opt.genesis()
        groups = []
        for g in range(self.K):
            if self.rep:
                held = frozenset((m, 0) for m in self.voters0[g])
                groups.append((gen[g], (), EMPTY, 0, self.leaders0[g], held))
            else:
                groups.append((gen[g], (), EMPTY, 0, 0, EMPTY))
        hist = tuple(() for _ in PARTS)
        reader = (self.opt.cursor0(), ()) if self.bound.get('reader') else None
        mem = tuple((True, 0) for _ in range(self.M))
        return (tuple(groups), hist, EMPTY, reader, mem, EMPTY, (0, 0), (None,) * self.K)

    # ------------------------------------------------------------- views
    @staticmethod
    def alive(st, r):
        up, inc = st[4][r[0]]
        return up and inc == r[1]

    @staticmethod
    def cur(st, m):
        return (m, st[4][m][1])

    def cfg(self, st, g):
        """(voters, learners, the voter last promoted) by g's committed log."""
        return self.opt.config(self, st[0][g][0], g)

    def leads(self, st, g):
        """g has a live leader (always, with no replica layer)."""
        if not self.rep:
            return True
        ldr = st[0][g][4]
        return ldr is not None and st[4][ldr][0]

    def quorum(self, st, g):
        """A majority of g's committed voters are up and hold the log."""
        vot = self.cfg(st, g)[0]
        held = st[0][g][5]
        return maj(sum(1 for v in vot if v in held and self.alive(st, v)), len(vot))

    def leader_ok(self, st, g):
        return self.leads(st, g) and self.quorum(st, g)

    def live_majority(self, st, g):
        vot = self.cfg(st, g)[0]
        return maj(sum(1 for v in vot if self.alive(st, v)), len(vot))

    def floor_now(self, st):
        """The client's lowest unacknowledged session id."""
        acked = st[5]
        open_ = [self.sess[a] for a in self.sess_aids if a not in acked]
        return min(open_) if open_ else max(self.sess.values(), default=0) + 1

    # ------------------------------------------------------------- steps
    def succ(self, st):
        groups, hist, refused, reader, mem, acked, used, gcfg = st
        self._cst, self._clogs = st, tuple(grp[0] + grp[1] for grp in groups)
        out = []
        names = self.opt.names
        rep = self.rep
        ecr = sum(grp[3] for grp in groups)
        for g in range(self.K):
            com, tail, lost, cr, ldr, held = groups[g]
            lead = self.leads(st, g)
            if tail and lead and (not rep or self.quorum(st, g)):
                e = tail[0]
                nldr, nheld, ngc = ldr, held, gcfg
                if rep:
                    nheld = frozenset(r for r in held if self.alive(st, r))
                    if e[0] == 'cfg':
                        ngc = gcfg[:g] + ((e[1], e[2], e[3]),) + gcfg[g + 1:]
                        if (ldr, mem[ldr][1]) not in e[1]:
                            nldr = None      # a leader its own change removes steps down
                ng = (com + (e,), tail[1:], EMPTY, cr, nldr, nheld)
                nh = hist
                if e[0] == 'w':
                    pi = PIDX[e[2]]
                    nh = hist[:pi] + (hist[pi] + ((e[1], e[3], e[4]),),) + hist[pi + 1:]
                out.append((('commit', names[g], self.opt.show(e)), 'commit',
                            (groups[:g] + (ng,) + groups[g + 1:], nh, refused, reader, mem, acked, used, ngc)))
            # E-17's deposition: the leader is replaced with no member fault
            if lead and cr < self.crashes and ecr < self.faults and (tail or lost):
                for c in self._prefixes(tail, lost, keep_whole=False):
                    lost2 = (lost | {tail}) if tail else lost
                    ng = (com, c, norm_lost(lost2, c), cr + 1, ldr, held)
                    out.append((('crash', names[g], f'tail keeps {len(c)}'), 'crash',
                                (groups[:g] + (ng,) + groups[g + 1:], hist, refused, reader, mem, acked, used, gcfg)))
            if rep and ldr is None:
                vot = self.cfg(st, g)[0]
                for c in sorted(vot):
                    if not self.alive(st, c):
                        continue
                    grants = sum(1 for v in vot if self.alive(st, v) and (v not in held or c in held))
                    if not maj(grants, len(vot)):
                        continue
                    for t in self._prefixes(tail, lost, keep_whole=True):
                        lost2 = (lost | {tail}) if tail else lost
                        ng = (com, t, norm_lost(lost2, t), cr, c[0], held)
                        out.append((('elect', names[g], c[0], f'tail keeps {len(t)}'), 'deliver',
                                    (groups[:g] + (ng,) + groups[g + 1:], hist, refused, reader, mem, acked, used, gcfg)))
            if rep and lead:
                vot, lrn, _ = self.cfg(st, g)
                for r in sorted(vot | lrn):
                    if r not in held and self.alive(st, r):
                        ng = (com, tail, lost, cr, ldr, held | {r})
                        out.append((('catchup', names[g], r[0]), 'deliver',
                                    (groups[:g] + (ng,) + groups[g + 1:], hist, refused, reader, mem, acked, used, gcfg)))
        if rep:
            if used[0] < self.mfaults:
                for m in self.fail:
                    up, inc = mem[m]
                    if up and 'crash' in self.kinds:
                        out.append((('member-crash', m), 'fault', self._fault(st, m, False)))
                    if inc == 0 and 'lose' in self.kinds:
                        out.append((('member-loses-disk', m), 'fault', self._fault(st, m, True)))
            for m in range(self.M):
                up, inc = mem[m]
                if not up and m not in self.never:
                    nm = mem[:m] + ((True, inc),) + mem[m + 1:]
                    out.append((('member-back', m), 'recover', (groups, hist, refused, reader, nm, acked, used, gcfg)))
        # the client takes an answer (E-20: the floor its later copies carry)
        if self.sess_aids:
            done = None
            for a in self.sess_aids:
                if a in acked:
                    continue
                if done is None:
                    done = {x[0] for h in hist for x in h} | refused
                if a in done:
                    out.append((('ack', a), 'deliver', (groups, hist, refused, reader, mem, acked | {a}, used, gcfg)))
        # E-30's `dup` (bounds remit-* only): an output at or below the slot's mark, under an id the
        # outcomes do not hold, is answered "already applied". A world rule, pinned as in E-30.
        if self.remit:
            applied = None
            for a in self.derived:
                if ('dup', a) in refused:
                    continue
                if applied is None:
                    applied = {x[0] for h in hist for x in h}
                if a in applied:
                    continue
                for g in range(self.K):
                    if self.leads(st, g) and self.opt.dup_ok(self, st, g, a):
                        out.append((('dup', a, names[g]), 'deliver',
                                    (groups, hist, refused | {('dup', a)}, reader, mem, acked, used, gcfg)))
                        break
        for a, gs, us in self.compiled:
            kind = self.opt.KIND.get(a.name, a.kind)
            for b in a.params(self, st):
                if rep and a.name != 'read' and not self.leads(st, b['g']):
                    continue            # only a group with a live leader acts
                ok = True
                for g in gs:
                    if not g(self, st, b):
                        ok = False
                        break
                if not ok:
                    continue
                d = CDraft(self, st)
                for u in us:
                    u.fn(self, st, b, d)
                if d.capped:
                    self.capped_now = True
                    continue
                t = d.freeze()
                if a.name == 'snap' and t != st:
                    t = t[:6] + ((used[0], used[1] + 1), gcfg)
                if t != st:
                    out.append(((a.name, a.label(b)), kind, t))
        return out

    @staticmethod
    def _prefixes(tail, lost, keep_whole):
        cands = set()
        for src in (tail,) + tuple(lost):
            for i in range(len(src) + 1):
                cands.add(src[:i])
        if not keep_whole:
            cands.discard(tail)        # E-17: keeping the whole tail changes nothing
        return sorted(cands, key=lambda c: (len(c), repr(c)))

    def _fault(self, st, m, lose):
        groups, hist, refused, reader, mem, acked, used, gcfg = st
        up, inc = mem[m]
        nm = mem[:m] + ((False, inc + 1 if lose else inc),) + mem[m + 1:]
        ng = []
        for com, tail, lost, cr, ldr, held in groups:
            if ldr == m:
                ldr = None
            if lose:
                held = held - {(m, inc)}
            ng.append((com, tail, lost, cr, ldr, held))
        return (tuple(ng), hist, refused, reader, nm, acked, (used[0] + 1, used[1]), gcfg)

    # ------------------------------------------------------------- properties
    def check(self, st):
        """E-17's World.check (P1, P2, P3, P4, P6), then the added ones."""
        bad = []
        opt = self.opt
        groups, hist, refused, reader = st[0], st[1], st[2], st[3]
        p1 = p6 = False
        for part in PARTS:
            own = opt.owners(self, st, part)
            if len(own) > 1:
                p6 = True
            ha = self.hist_aids(st, part)
            for g in own:
                if opt.rows(self, st, g, part) != ha:
                    p1 = True
        if p1:
            bad.append('P1')
        at = {}
        p2 = False
        for h in hist:
            prev = None
            for aid, pos, tok in h:
                if at.setdefault(pos, aid) != aid:
                    p2 = True
                if prev is not None and not pos > prev:
                    p2 = True
                prev = pos
        if p2:
            bad.append('P2')
        allaids = [x[0] for h in hist for x in h]
        p3 = len(set(allaids)) != len(allaids) or bool(refused & set(allaids))
        for h in hist:
            for i in range(1, len(h)):
                if h[i][2] < h[i - 1][2]:
                    p3 = True
        if p3:
            bad.append('P3')
        if reader is not None:
            ha = self.hist_aids(st, 'p')
            seen = reader[1]
            if ha[:len(seen)] != seen:
                bad.append('P4')
        if p6:
            bad.append('P6')
        if self.derived:
            for h in hist:
                src = [self.derived[x[0]] for x in h if x[0] in self.derived]
                if any(b <= a for a, b in zip(src, src[1:])):
                    bad.append('P8')
                    break
        if self.remit:
            done_src = {self.derived[x[0]] for h in hist for x in h if x[0] in self.derived}
            if any(isinstance(r, tuple) and self.derived[r[1]] not in done_src for r in refused):
                bad.append('DP')
        if self.rep:
            for g in range(self.K):
                com, tail, lost, cr, ldr, held = groups[g]
                c = self.cfg(st, g)
                vot = c[0]
                n = len(vot)
                gc = st[7][g]
                if gc is not None and gc != c and 'CF' not in bad:
                    bad.append('CF')
                if sum(1 for v in vot if v not in held) >= n // 2 + 1 and 'QL' not in bad:
                    bad.append('QL')
                if ldr is not None:
                    r = (ldr, st[4][ldr][1])
                    if st[4][ldr][0] and r not in held and 'LC' not in bad:
                        bad.append('LC')
                    if r not in vot and 'LV' not in bad:
                        bad.append('LV')
                if g in self.heal and not 3 <= n <= 4 and 'HV' not in bad:
                    bad.append('HV')
        return bad

    def check_edge(self, s, t):
        """E-17's P4 on a step (what the reader took only grows), and E-16's
        P2 at the step that appends a removal. Returns the ids broken."""
        bad = []
        a, b = s[3], t[3]
        if a is not None and a[1] is not b[1] and b[1][:len(a[1])] != a[1]:
            bad.append('P4')
        if self.rep:
            for g in self.heal:
                st_, tt = s[0][g][1], t[0][g][1]
                if len(tt) == len(st_) + 1 and tt[-1][0] == 'cfg' and self.leader_ok(s, g):
                    vot = self.cfg(s, g)[0]
                    nv = tt[-1][1]
                    if vot - nv:
                        held = s[0][g][5]
                        before = sum(1 for v in vot if v in held and self.alive(s, v))
                        after = sum(1 for v in nv if v in held and self.alive(s, v))
                        if after < before and after < 3:
                            bad.append('HR')
        return bad

    def healed(self, st, g):
        if not self.leader_ok(st, g):
            return False
        if any(e[0] == 'cfg' for e in st[0][g][1]):
            return False
        vot = self.cfg(st, g)[0]
        if len(vot) % 2 == 0:
            return False
        missing = [v for v in vot if not self.alive(st, v)]
        if not missing:
            return True
        free = [m for m in range(self.M) if st[4][m][0] and self.cur(st, m) not in vot]
        return not free

    def goals(self, st):
        settled = self.opt.settled(self, st)
        done = {x[0] for h in st[1] for x in h} | st[2]
        if self.remit:
            done |= {r[1] for r in st[2] if isinstance(r, tuple)}
        answered = all(a in done for a in self.aids)
        reader = st[3]
        caught = reader is None or reader[1] == self.hist_aids(st, 'p')
        back = all(self.opt.owners(self, st, part) == [g] for part, g in self.opt.given_up(self, st))
        healed = all(self.healed(st, g) for g in self.heal) if self.rep else True
        return settled, answered, caught, back, healed

    def judged(self, st):
        """Liveness is asked from st: every group has a live majority."""
        if not self.rep:
            return True
        return all(self.live_majority(st, g) for g in range(self.K))
