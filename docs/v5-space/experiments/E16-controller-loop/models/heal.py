"""
heal.py: who heals a group's replicas. E-16's model.

Two options on one world:
  self     each group's leader heals its own group, from its own links
           (DESIGN-V5 4.2, "Healing: one rule, run by each shard's leader";
           DRAFT, CELL, LANE, SPLIT; healing.py's round-2 rules with its
           fixes, on etcd's on-commit membership as E-14 found).
  cent-co  one controller loop on #meta's leader decides every change from
           its own view (its links to members, the group's reported config)
           and writes each decision into #meta's log as a command naming the
           group's config epoch; the group's leader runs a command only if
           its committed config still has that epoch (TiKV PD's region
           epoch; KRaft's combined controller). MIN, RUST, LEAN.

THE WORLD (shared, not counted as healing rules).
  Members 0..N-1: up or down, a disk incarnation (a member back without its
  disk is a new replica), and a side (0 or 1: links join members on one
  side). A replica is (member, incarnation). #meta: up (has a majority) or
  not, and the side its leader is on.
  One data group, Raft as an abstract group with on-commit membership (E-14):
  a committed config (voters, learners, epoch, the voter last promoted), at
  most one uncommitted entry (`tail`, etcd's one change at a time), a leader
  replica, the replicas that hold every committed entry (`held`), and those
  that hold the tail (`got`). Elections, commits, catch-up and CheckQuorum
  are world steps; they read only the committed config (on commit).
  `gone[s]`: the members observers on side s have not reached for
  evict.after (a `time` step sets it while the link is down; it is cleared in
  the step that brings the link back, since a link that is up is seen at
  once). A replica whose member came back with a new disk is known gone to
  observers on that member's side.

THE STEP KINDS. deliver (a process acts: elections, commits, catch-up and
every option action), time (evict.after passes), tick (a timer of an option
that always fires: cent-co's operator timeout),
fault (crash, lost disk, a member cut off, #meta loses its majority, #meta's
leader cut off), recover (a member, a link or #meta comes back). Liveness is
AG EF over deliver and time steps (calm), from every state judged.

PROPERTIES (healing.py's, as far as this world has them):
  P2  at the step that appends a removal (as healing.py judges it), the
      answering voters that hold the commit offset do not drop below three
      when they were three or more (a swap's removal waits until the new
      voter holds the offset again; healing.py R2-2).
  P3  healing keeps 3 or (between a swap's two steps) 4 voters: never fewer
      than 3, never more than 4.
  P5  AG EF: from every state with a live majority (a majority of the
      committed voters up, with their disks, on one side), a leader commits
      (no stuck state with a live majority).
  P8  AG EF, "healing finishes": from every state with a live majority (and,
      for cent-co, #meta up on that majority's side), calm steps reach a
      state with a working leader,
      an odd voter count (healing.py P4: never settle at two or four), and
      no voter its side cannot reach while a live member is free to replace
      it (healing.py P8).
  P9  no more than 8 config changes without an outside event (no churn).
  WAIT (reported, not a property): the states with a live majority while
      #meta is down or cut off from it, in which healing cannot finish until
      #meta returns.
  SWAP (reported, not a property): states with a config change pending and
      a live majority of the committed config, from which no leader can
      commit again: the change commits on the old majority and leaves a
      config whose majority is down (a second fault during a swap). P5 and
      P8 judge only states with no change pending, as healing.py judges a
      live majority against the config in force.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'engine'))
from engine import Action, Guard, Cmp, Update, FLIP   # noqa: E402

FIELDS = ('mem', 'gone', 'meta', 'vot', 'lrn', 'ep', 'newv', 'tail', 'ldr', 'held', 'got',
          'rep', 'cmds', 'chg', 'faults')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()
CHURN = 8


def maj(n_have, n_all):
    return 2 * n_have > n_all


class World:
    CALM = ('deliver', 'time', 'tick')
    INFO = ('WAIT', 'SWAP')
    MODE = None
    gc_stale = False

    def __init__(self, bound):
        self.b = bound
        self.N = bound['members']
        self.budget = bound['faults']
        self.kinds = set(bound.get('fault_kinds', ('crash', 'lose', 'cut', 'metadown', 'metacut')))

    # ------------------------------------------------------------ state
    def init(self):
        mem = tuple((True, 0, 0) for _ in range(self.N))
        vot = frozenset((m, 0) for m in self.b['voters'])
        lrn = frozenset((m, 0) for m in self.b.get('learners', ()))
        held = vot | lrn
        ldr = (self.b['voters'][0], 0)
        hist = ()
        down = self.b.get('down', ())
        mem = tuple((m not in down, 0, 0) for m in range(self.N))
        meta = (not self.b.get('meta_down', False), 0)
        return (mem, (E, E), meta, vot, lrn, 0, None, None, ldr, held, E, hist, E, 0, 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[f] for f in FIELDS)

    # ------------------------------------------------------------ views
    @staticmethod
    def alive(st, r):
        up, inc, side = st[0][r[0]]
        return up and inc == r[1]

    @staticmethod
    def ans(st, r, s):
        up, inc, side = st[0][r[0]]
        return up and inc == r[1] and side == s

    @staticmethod
    def gone_to(st, s, r):
        """Observers on side s count replica r gone: its link has been down
        past evict.after, or its member is back with a new disk. A link that
        is up is seen at once, so a member observers reach is never gone."""
        if s is None:
            return False                 # no observer (no leader): nothing is gone to it
        up, inc, side = st[0][r[0]]
        if up and side == s:
            return inc != r[1]
        return r[0] in st[1][s]

    @staticmethod
    def cur(st, m):
        return (m, st[0][m][1])

    def lside(self, st):
        l = st[IX['ldr']]
        return None if l is None else st[0][l[0]][2]

    def leader_ok(self, st):
        l = st[IX['ldr']]
        if l is None or not self.alive(st, l):
            return False
        s = st[0][l[0]][2]
        vot = st[IX['vot']]
        return l in vot and maj(sum(1 for v in vot if self.ans(st, v, s)), len(vot))

    def live_majority(self, st):
        vot = st[IX['vot']]
        return any(maj(sum(1 for v in vot if self.ans(st, v, s)), len(vot)) for s in (0, 1))

    def free_cands(self, st, s):
        """Live members on side s that could replace a voter: up, reached,
        and not a voter (a learner is a candidate for a swap, as in
        healing.py's P8)."""
        vm = {r for r in st[IX['vot']]}
        return [m for m in range(self.N) if st[0][m][0] and st[0][m][2] == s
                and m not in st[1][s] and self.cur(st, m) not in vm]

    # ------------------------------------------------------------ world steps
    def world(self, st):
        out = []
        mem, gone, meta, vot, lrn, ep, newv, tail, ldr, held, got, hist, cmds, chg, faults = st
        # --- deliver: CheckQuorum step-down, election, commit, catch-up
        if ldr is not None and not self.leader_ok(st):
            out.append((('stepdown', ldr), 'deliver', self._set(st, ldr=None)))
        if ldr is None:
            for c in sorted(vot):
                if not self.alive(st, c) or c not in held:
                    continue
                s = mem[c[0]][2]
                grant = [v for v in vot if self.ans(st, v, s) and (v not in got or c in got)]
                if not maj(len(grant), len(vot)):
                    continue
                if c in got and tail is not None:
                    ntail, ngot = tail, frozenset(r for r in got if self.ans(st, r, s))
                else:
                    ntail, ngot = ('noop',), frozenset([c])
                out.append((('elect', c), 'deliver', self._set(st, ldr=c, tail=ntail, got=ngot)))
        if self.leader_ok(st):
            s = mem[ldr[0]][2]
            if tail is not None and maj(len(got & vot), len(vot)):
                d = self.to_draft(st)
                if tail[0] == 'cfg':
                    _, nv, nl, nn = tail
                    d['vot'], d['lrn'], d['newv'], d['ep'] = nv, nl, nn, ep + 1
                    if self.gc_stale:
                        # every command names the epoch it was decided at,
                        # so after this commit none can run (exec.epoch) and
                        # none blocks a decision ('one' reads the current
                        # epoch): dead state, cleared (see CentCo.mutated)
                        d['cmds'] = E
                    d['chg'] = chg + 1
                    if ldr not in nv:
                        d['ldr'] = None
                d['held'] = frozenset(r for r in got if self.alive(st, r))
                d['tail'], d['got'] = None, E
                out.append((('commit', tail[0]), 'deliver', tuple(d[f] for f in FIELDS)))
            targets = vot | lrn | (tail[1] | tail[2] if tail is not None and tail[0] == 'cfg' else E)
            for r in sorted(targets):
                if not self.ans(st, r, s):
                    continue
                if r not in held:
                    ng = got | {r} if tail is not None else got
                    out.append((('catchup', r), 'deliver', self._set(st, held=held | {r}, got=ng)))
                elif tail is not None and r not in got:
                    out.append((('send', r), 'deliver', self._set(st, got=got | {r})))
        # --- time: evict.after passes, or a link is seen again
        for s in (0, 1):
            # marks matter only on a side where someone observes: an up
            # member, or #meta's leader
            if not (any(x[0] and x[2] == s for x in mem) or (meta[0] and meta[1] == s)):
                continue
            for m in range(self.N):
                up, inc, side = mem[m]
                reach = up and side == s
                if not reach and m not in gone[s]:
                    out.append((('evict', s, m), 'time', self._gone(st, s, gone[s] | {m})))
        # --- faults (budget) and recoveries (free)
        if faults < self.budget:
            for m in range(self.N):
                up, inc, side = mem[m]
                if up and 'crash' in self.kinds:
                    out.append((('crash', m), 'fault', self._mem(st, m, (False, inc, side), True)))
                if 'lose' in self.kinds and inc == 0:
                    out.append((('lose-disk', m), 'fault', self._mem(st, m, (False, inc + 1, side), True)))
                if up and side == 0 and 'cut' in self.kinds:
                    out.append((('cut', m), 'fault', self._mem(st, m, (up, inc, 1), True)))
            if meta[0] and 'metadown' in self.kinds:
                out.append((('meta-down',), 'fault', self._set(st, meta=(False, meta[1]), chg=0, faults=faults + 1)))
            if meta[1] == 0 and 'metacut' in self.kinds:
                out.append((('meta-cut',), 'fault', self._set(st, meta=(meta[0], 1), chg=0, faults=faults + 1)))
        for m in range(self.N):
            up, inc, side = mem[m]
            if not up and m not in self.b.get('never', ()):
                out.append((('recover', m), 'recover', self._mem(st, m, (True, inc, side), False)))
            if side == 1:
                out.append((('heal', m), 'recover', self._mem(st, m, (up, inc, 0), False)))
        if not meta[0]:
            out.append((('meta-up',), 'recover', self._set(st, meta=(True, meta[1]), chg=0)))
        if meta[1] == 1:
            out.append((('meta-heal',), 'recover', self._set(st, meta=(meta[0], 0), chg=0)))
        return out

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return tuple(d[f] for f in FIELDS)

    def _gone(self, st, s, g):
        gone = list(st[1])
        gone[s] = frozenset(g)
        return self._set(st, gone=tuple(gone), chg=0)

    def _mem(self, st, m, v, fault):
        mem = list(st[0])
        mem[m] = v
        # a link that comes back is seen at once: the gone mark of a member
        # observers on a side reach again is cleared in the same step
        gone = tuple(frozenset(x for x in st[1][s] if not (mem[x][0] and mem[x][2] == s)) for s in (0, 1))
        kw = dict(mem=tuple(mem), chg=0, gone=gone)
        if fault:
            kw['faults'] = st[IX['faults']] + 1
        return self._set(st, **kw)

    # ------------------------------------------------------------ properties
    def check(self, st):
        bad = []
        n = len(st[IX['vot']])
        if n < 3 or n > 4:
            bad.append('P3')
        return bad

    def check_edge(self, s, lab, kind, t):
        bad = []
        tl = t[IX['tail']]
        if s[IX['tail']] is None and tl is not None and tl[0] == 'cfg' and s[IX['vot']] - tl[1]:
            # healing.py P2 (round 2), judged at the step as healing.py
            # judges it: a removal must not lower the answering voters that
            # hold the commit offset, unless a replacement already holds it,
            # so `copies` (3) of them stay. Only a working leader's step is
            # judged (a leader cut off from its majority cannot commit it).
            if self.leader_ok(s):
                ls = self.lside(s)
                held = s[IX['held']]
                before = sum(1 for v in s[IX['vot']] if v in held and self.ans(s, v, ls))
                after = sum(1 for v in tl[1] if v in held and self.ans(s, v, ls))
                if after < before and after < 3:
                    bad.append('P2')
        if t[IX['chg']] > CHURN:
            bad.append('P9')
        return bad

    def healed(self, st):
        if not self.leader_ok(st) or st[IX['tail']] is not None:
            return False
        vot = st[IX['vot']]
        if len(vot) % 2 == 0:
            return False
        s = self.lside(st)
        missing = [v for v in vot if not self.ans(st, v, s)]
        return not missing or not self.free_cands(st, s)

    def goals(self, st):
        writable = self.leader_ok(st) and st[IX['tail']] is None
        return {'P5': writable, 'P8': self.healed(st), 'WAIT': self.healed(st), 'SWAP': writable}

    def judged(self, st):
        lm = self.live_majority(st)
        # Judged only with no config change pending, as healing.py judges a
        # live majority against the config that will be in force (on
        # append). A state with a change pending is reported apart (SWAP):
        # a change that commits on the old majority can leave a config
        # whose majority is down (a second fault during a swap).
        settled_cfg = st[IX['tail']] is None or st[IX['tail']][0] != 'cfg'
        # #meta can steer the group: it has a leader, on the side of the
        # group's live majority (so reports and commands get through)
        vot = st[IX['vot']]
        ms = st[IX['meta']][1]
        meta_ok = st[IX['meta']][0] and maj(sum(1 for v in vot if self.ans(st, v, ms)), len(vot))
        need_meta = self.MODE == 'cent'
        return {'P5': lm and settled_cfg,
                'P8': lm and settled_cfg and (meta_ok or not need_meta),
                'WAIT': lm and settled_cfg and not meta_ok,
                'SWAP': lm and not settled_cfg}

    # ------------------------------------------------------------ helpers for options
    def append(self, st, d, nv, nl, nn):
        """The leader appends a config entry; it reaches every answering
        replica that holds the commit offset, in the old or new config."""
        s = self.lside(st)
        members = st[IX['vot']] | st[IX['lrn']] | nv | nl
        d.f['tail'] = ('cfg', frozenset(nv), frozenset(nl), nn)
        d.f['got'] = frozenset(r for r in members if r in st[IX['held']] and self.ans(st, r, s))


# ---------------------------------------------------------------- the rules
# Shared guard and update functions. A guard reads the state through a view
# (the side whose links decide what is gone): the group leader's side for
# `self`, #meta's leader's side for the controller of `cent-co`.

def g_leader(w, st, b):
    return w.leader_ok(st)


def g_idle(w, st, b):
    return st[IX['tail']] is None


def lead_side(w, st):
    return w.lside(st)


def need(w, st, s):
    """Some voter is gone to side s's observers."""
    return any(w.gone_to(st, s, v) for v in st[IX['vot']])


def vote_count(w, st, b):
    return len(st[IX['vot']])


def rank_last(vot):
    return max(vot)


class SelfHeal(World):
    """Each group's leader heals from its own links."""
    MODE = 'self'

    def actions(self):
        def reps(w, st):
            for m in range(w.N):
                yield {'r': w.cur(st, m)}

        def cfg_reps(w, st):
            for r in sorted(st[IX['vot']] | st[IX['lrn']]):
                yield {'r': r}

        def add_upd(w, st, b, d):
            w.append(st, d, st[IX['vot']], st[IX['lrn']] | {b['r']}, st[IX['newv']])

        def promote_upd(w, st, b, d):
            w.append(st, d, st[IX['vot']] | {b['r']}, st[IX['lrn']] - {b['r']}, b['r'])

        def remove_upd(w, st, b, d):
            w.append(st, d, st[IX['vot']] - {b['r']}, st[IX['lrn']], st[IX['newv']])

        def dropl_upd(w, st, b, d):
            w.append(st, d, st[IX['vot']], st[IX['lrn']] - {b['r']}, st[IX['newv']])

        L = lambda w, st: w.lside(st)
        return [
            Action('add', 'deliver', reps, [
                Guard('leader', g_leader, role='raft', note='only a working leader proposes'),
                Guard('idle', g_idle, role='raft', note='one change at a time (etcd)'),
                Guard('cand', lambda w, st, b: w.ans(st, b['r'], L(w, st)) and b['r'][0] not in st[1][L(w, st)],
                      role='target', note='a live member the leader reaches, not gone'),
                Guard('new', lambda w, st, b: b['r'] not in st[IX['vot']] | st[IX['lrn']],
                      role='target', note='this replica is not already in the config (a member back '
                                          'with a new disk is a new replica: DESIGN-V5 4.1)'),
                Guard('need', lambda w, st, b: need(w, st, L(w, st)), role='target',
                      note='a voter is gone to the leader (a replacement is needed)'),
            ], [Update('append', add_upd, role='step')]),
            Action('promote', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('learner', lambda w, st, b: b['r'] in st[IX['lrn']], role='target'),
                Guard('live', lambda w, st, b: not w.gone_to(st, L(w, st), b['r']), role='target',
                      note='a candidate: not gone to the leader'),
                Guard('caught', lambda w, st, b: b['r'] in st[IX['held']], role='swap',
                      note='its log reaches the commit offset exactly'),
                Guard('need', lambda w, st, b: need(w, st, L(w, st)), role='target'),
                Cmp('odd', vote_count, '<', lambda w, st, b: 4, role='target',
                    note='promote only from three voters (to four, for the swap)'),
            ], [Update('append', promote_upd, role='step')]),
            Action('remove', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('voter', lambda w, st, b: b['r'] in st[IX['vot']], role='target'),
                Guard('gone', lambda w, st, b: w.gone_to(st, L(w, st), b['r']), role='target',
                      note='the voter is gone to the leader'),
                Cmp('four', vote_count, '>=', lambda w, st, b: 4, role='swap',
                    note='a swap promotes first, then removes'),
                Guard('newok', lambda w, st, b: st[IX['newv']] is None or b['r'] == st[IX['newv']]
                      or st[IX['newv']] in st[IX['held']], role='swap',
                      note='the new voter holds the commit offset again (its own promotion included)'),
            ], [Update('append', remove_upd, role='step')]),
            Action('surplus', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('voter', lambda w, st, b: b['r'] in st[IX['vot']], role='target'),
                Cmp('four', vote_count, '>=', lambda w, st, b: 4, role='target'),
                Guard('nogone', lambda w, st, b: not need(w, st, L(w, st)), role='target',
                      note='no voter is gone: the gone one came back'),
                Guard('last', lambda w, st, b: b['r'] == rank_last(st[IX['vot']]), role='target',
                      note='the voter the ring ranks last'),
                Guard('allheld', lambda w, st, b: all(v in st[IX['held']] and w.ans(st, v, L(w, st))
                                                      for v in st[IX['vot']] - {b['r']}),
                      role='swap', note='the voters left answer and hold the commit offset'),
            ], [Update('append', remove_upd, role='step')]),
            Action('dropl', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('learner', lambda w, st, b: b['r'] in st[IX['lrn']], role='target'),
                Guard('gone', lambda w, st, b: w.gone_to(st, L(w, st), b['r']), role='target'),
            ], [Update('append', dropl_upd, role='step')]),
        ]


class CentCo(World):
    """One controller loop on #meta's leader; commands carry the group's
    config epoch, and the group's leader checks it."""
    MODE = 'cent'
    gc_stale = True

    def mutated(self, m):
        """A state reduction, not a rule (engine.Compiled calls this with the
        mutation of the run). While exec.epoch is in force, a command whose
        epoch is past can never run and never blocks a decision, so the
        commit that raises the epoch clears them: the same behaviours with
        fewer states (a timeout would remove them anyway; nothing reads
        them). A run without exec.epoch keeps them, since there they can
        still run."""
        self.gc_stale = not (m is not None and 'exec.epoch' in m.drop)
        self.mut = m      # c_expire asks what the group, as mutated, would run

    def actions(self):
        M = lambda w, st: st[IX['meta']][1]          # the controller's side

        def reports(w, st):
            """The controller acts on the group's committed config, as the
            group reported it, and on every replica of every member. A late
            report needs no state of its own: a command decided at epoch e
            can run late, or be refused by the epoch check, which is what a
            late report leads to."""
            if not st[IX['meta']][0]:
                return                               # no #meta leader, no controller
            ep, vot, lrn, newv = st[IX['ep']], st[IX['vot']], st[IX['lrn']], st[IX['newv']]
            if True:
                for m in range(w.N):
                    for r in sorted({w.cur(st, m)} | {x for x in vot | lrn if x[0] == m}):
                        yield {'ep': ep, 'vot': vot, 'lrn': lrn, 'newv': newv, 'r': r}

        def issue(op):
            def f(w, st, b, d):
                d.f['cmds'] = st[IX['cmds']] | {(op, b['r'], b['ep'])}
            return f

        def rvot(b):
            return b['vot']

        acts = [
            Action('c_add', 'deliver', reports, [
                Guard('one', lambda w, st, b: not any(c[2] == b['ep'] for c in st[IX['cmds']]), role='idem',
                      note='one command per reported epoch (PD: one operator per region at a time)'),
                Guard('cand', lambda w, st, b: w.ans(st, b['r'], M(w, st)) and b['r'][0] not in st[1][M(w, st)],
                      role='target'),
                Guard('new', lambda w, st, b: b['r'] not in b['vot'] | b['lrn'], role='target'),
                Guard('need', lambda w, st, b: any(w.gone_to(st, M(w, st), v) for v in b['vot']), role='target'),
            ], [Update('issue', issue('add'), role='step')]),
            Action('c_promote', 'deliver', reports, [
                Guard('one', lambda w, st, b: not any(c[2] == b['ep'] for c in st[IX['cmds']]), role='idem',
                      note='one command per reported epoch (PD: one operator per region at a time)'),
                Guard('learner', lambda w, st, b: b['r'] in b['lrn'], role='target'),
                Guard('live', lambda w, st, b: not w.gone_to(st, M(w, st), b['r']), role='target'),
                Guard('need', lambda w, st, b: any(w.gone_to(st, M(w, st), v) for v in b['vot']), role='target'),
                Cmp('odd', lambda w, st, b: len(b['vot']), '<', lambda w, st, b: 4, role='target'),
            ], [Update('issue', issue('promote'), role='step')]),
            Action('c_remove', 'deliver', reports, [
                Guard('one', lambda w, st, b: not any(c[2] == b['ep'] for c in st[IX['cmds']]), role='idem',
                      note='one command per reported epoch (PD: one operator per region at a time)'),
                Guard('voter', lambda w, st, b: b['r'] in b['vot'], role='target'),
                Guard('gone', lambda w, st, b: w.gone_to(st, M(w, st), b['r']), role='target'),
                Cmp('four', lambda w, st, b: len(b['vot']), '>=', lambda w, st, b: 4, role='swap'),
            ], [Update('issue', issue('remove'), role='step')]),
            Action('c_surplus', 'deliver', reports, [
                Guard('one', lambda w, st, b: not any(c[2] == b['ep'] for c in st[IX['cmds']]), role='idem',
                      note='one command per reported epoch (PD: one operator per region at a time)'),
                Guard('voter', lambda w, st, b: b['r'] in b['vot'], role='target'),
                Cmp('four', lambda w, st, b: len(b['vot']), '>=', lambda w, st, b: 4, role='target'),
                Guard('nogone', lambda w, st, b: not any(w.gone_to(st, M(w, st), v) for v in b['vot']), role='target'),
                Guard('last', lambda w, st, b: b['r'] == rank_last(b['vot']), role='target'),
            ], [Update('issue', issue('surplus'), role='step')]),
            Action('c_dropl', 'deliver', reports, [
                Guard('one', lambda w, st, b: not any(c[2] == b['ep'] for c in st[IX['cmds']]), role='idem',
                      note='one command per reported epoch (PD: one operator per region at a time)'),
                Guard('learner', lambda w, st, b: b['r'] in b['lrn'], role='target'),
                Guard('gone', lambda w, st, b: w.gone_to(st, M(w, st), b['r']), role='target'),
            ], [Update('issue', issue('dropl'), role='step')]),
        ]

        # The group's leader runs a command from #meta's log. It reads #meta
        # through a link to #meta's side (it follows #meta).
        def cmds(w, st):
            # a command reaches the group's leader only over a link to
            # #meta's side (it follows #meta): a topology filter, not a rule
            if w.lside(st) != st[IX['meta']][1]:
                return
            for c in sorted(st[IX['cmds']]):
                yield {'op': c[0], 'r': c[1], 'ep': c[2]}

        def exec_upd(w, st, b, d):
            op, r = b['op'], b['r']
            vot, lrn, newv = st[IX['vot']], st[IX['lrn']], st[IX['newv']]
            if op == 'add':
                w.append(st, d, vot, lrn | {r}, newv)
            elif op == 'promote':
                w.append(st, d, vot | {r}, lrn - {r}, r)
            elif op in ('remove', 'surplus'):
                w.append(st, d, vot - {r}, lrn, newv)
            elif op == 'dropl':
                w.append(st, d, vot, lrn - {r}, newv)

        # An operator timeout (PD cancels an operator that makes no
        # progress): a command leaves #meta's list of live commands, so the
        # controller can decide again. A timer that always fires: calm.
        def drop(w, st, b, d):
            d.f['cmds'] = st[IX['cmds']] - {(b['op'], b['r'], b['ep'])}

        def runnable(w, st, b):
            """The group's leader would run this command now: exec's own
            topology filter (it reads #meta from #meta's side) and exec's
            guards as this run has them (exec.leader is the working leader)."""
            return w.lside(st) == st[IX['meta']][1] and all(
                exec_test(w, st, b, g) for g in exec_guards)

        def exec_test(w, st, b, g):
            # the exec guard as this run has it: a mutant that drops or
            # flips an exec guard changes what the group would run, and the
            # timeout must see the same (else it hides the mutant)
            m = getattr(w, 'mut', None)
            if m is not None and g.id in m.drop:
                return True
            if m is not None and g.id in m.flip and g.op:
                return g.test(w, st, b, FLIP[g.op])
            return g.test(w, st, b)

        acts.append(Action('c_expire', 'tick', lambda w, st: ({'op': c[0], 'r': c[1], 'ep': c[2]}
                                                               for c in sorted(st[IX['cmds']])), [
            Guard('stuck', lambda w, st, b: not runnable(w, st, b), role='idem',
                  note='only a command the group would not run now times out'),
        ], [Update('drop', drop, role='idem', note='the command times out')]))

        exec_guards = [
            Guard('leader', g_leader, role='raft'),
            Guard('idle', g_idle, role='raft'),
            Guard('epoch', lambda w, st, b: b['ep'] == st[IX['ep']], role='epoch',
                  note="the command names the group's current config epoch"),
            Guard('caught', lambda w, st, b: b['op'] != 'promote' or b['r'] in st[IX['held']], role='swap',
                  note='a promotion waits until the learner holds the commit offset (only the leader knows)'),
            Guard('newok', lambda w, st, b: b['op'] != 'remove' or st[IX['newv']] is None
                  or b['r'] == st[IX['newv']] or st[IX['newv']] in st[IX['held']], role='swap',
                  note='a swap removal waits until the new voter holds the offset again'),
            Guard('allheld', lambda w, st, b: b['op'] != 'surplus'
                  or all(v in st[IX['held']] and w.ans(st, v, w.lside(st)) for v in st[IX['vot']] - {b['r']}),
                  role='swap', note='a surplus removal waits until the voters left answer and hold the offset'),
            Guard('gone', lambda w, st, b: b['op'] not in ('remove', 'dropl') or w.gone_to(st, w.lside(st), b['r']),
                  role='view', note="a removal of a gone replica runs only if the leader's own links agree "
                                    "(DESIGN-V5's planner rule: a leader whose link to that life is up ignores it)"),
            Guard('live', lambda w, st, b: b['op'] != 'promote' or not w.gone_to(st, w.lside(st), b['r']),
                  role='view', note="a promotion runs only if the learner is not gone to the leader's own links "
                                    "(found by P8 on two-a: a promotion decided before the learner died stays "
                                    "runnable, so it never times out, and it blocks every other decision)"),
        ]
        acts.append(Action('exec', 'deliver', cmds, exec_guards,
                           [Update('append', exec_upd, role='step'),
                            Update('done', drop, role='idem', note="the command leaves #meta's list of live commands")]))
        return acts


OPTIONS = {'self': SelfHeal, 'cent-co': CentCo}

# Bounds. Members 0, 1, 2 start as voters (0 leads); the others are spares.
BOUNDS = {
    # three voters and one spare; one fault of any kind
    'three1': dict(members=4, voters=(0, 1, 2), faults=1),
    # three voters, one learner (healing.py's `four`), one fault
    'four1': dict(members=4, voters=(0, 1, 2), learners=(3,), faults=1),
    # #meta down from the start, then one member fault: self heals, cent-co waits
    'meta1': dict(members=4, voters=(0, 1, 2), faults=1, meta_down=True,
                  fault_kinds=('crash', 'lose', 'cut')),
    # three voters and one spare; two faults of any kind (the verify bound;
    # cent-co does not finish it: capped, see VERIFY)
    'three2': dict(members=4, voters=(0, 1, 2), faults=2),
    # two faults among crashes, lost disks and #meta losing its majority
    'two-a': dict(members=4, voters=(0, 1, 2), faults=2, fault_kinds=('crash', 'lose', 'metadown')),
    # two faults among crashes and cuts of a member or of #meta's leader
    # (cent-co does not finish two-a, two-b or two-c: more than 900,000
    # states each, and more than 4,000,000 on two-a)
    'two-b': dict(members=4, voters=(0, 1, 2), faults=2, fault_kinds=('crash', 'cut', 'metacut')),
    # two faults among cuts of a member and of #meta's leader: views that
    # differ (#meta's side against the group's side)
    'two-c': dict(members=4, voters=(0, 1, 2), faults=2, fault_kinds=('cut', 'metacut')),
}
# The ablation sweeps the one-fault bounds (seconds each) and verifies the
# smallest model, and every mutant they miss, on two faults of any kind
# (E-17's VERIFY). `self` finishes three2 (296,018 states); cent-co does not
# (more than 4,000,000 states on two-a alone), so run.sh caps its verify runs
# at 2,000,000 states: every trace up to 18 steps, safety only.
SWEEP = ('three1', 'four1', 'meta1')
VERIFY = ('three2',)
# Before E-17's reverse-order put-back, each rule the sweep dropped is checked
# alone on the verify bound (the design without it) and put back if that
# breaks a property (engine.Ablation, verify_pass1). Without this step the
# one-fault sweep drops rules that only two faults need (`surplus.voter`:
# P9 in 29 steps with a crash and a lost disk), and models with many rules
# dropped are too large to verify at two faults.
VERIFY_PASS1 = True
