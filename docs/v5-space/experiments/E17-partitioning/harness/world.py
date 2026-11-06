"""
world.py: the shared world every option runs in.

THE WORLD IN ONE PARAGRAPH. Some groups, each an abstract Raft group: a
committed log, the current leader's uncommitted tail, the tails earlier
leaders lost (one may come back until the next commit), and a count of
crashes. Two partitions, p and q. A few client attempts, each (id, partition,
lock token); a copy of any attempt can reach any group at any time, any
number of times (stale routes, retries, duplicates, delay). One optional
reader follows p with a cursor. Options add their own log entries and their
own actions; the harness owns commit, crash, the ghost history and the
properties. Group-to-group messages are not state: a report is a fact in the
sender's log, and acting on it is reading that log (see HARNESS.md, "Why
there is no message set").

The state is a tuple (groups, hist, refused, reader):
  groups   one (com, tail, lost, crashes) per group; lost is a frozenset of
           tails lost by earlier leaders since the last commit
  hist     per partition, every original application of a write, in commit
           order: ((aid, pos, tok), ...). A ghost: the truth the properties
           compare against.
  refused  frozenset of attempt ids a group told the client were refused for
           good (a final answer). A ghost.
  reader   None, or (cursor, seen): seen is the attempt ids the reader has
           taken, in order. A ghost, plus the reader's own cursor.

A write entry is always ('w', aid, part, pos, tok); the harness appends it
to hist when it commits. Everything else in a log belongs to the option.
A log never holds the same entry twice: appending an entry already in the
log does nothing (so a guard that only stops an exact repeat is not a rule).
"""

from dsl import CALM_KINDS, FLIP, OPS

PARTS = ('p', 'q')
PIDX = {'p': 0, 'q': 1}
EMPTY = frozenset()

# The properties (P) and the liveness goals (L). Ids are stable: the report
# and HARNESS.md cite them.
PROPS = {
    'P1': 'no acknowledged write lost or extra: every group that holds a '
          'partition open has exactly its history as rows',
    'P2': 'a position never changes meaning: no position names two writes, '
          'and positions rise along each partition\'s history',
    'P3': 'dedup and fence state survive: no attempt applied twice, lock '
          'tokens never fall along a partition\'s history, and an attempt '
          'told "refused" never commits',
    'P4': 'a cursor resumes with no gap or overlap: what the reader took is '
          'always a prefix of the history, and only ever grows',
    'P6': 'one writer per partition: at most one group holds it open',
    'L4': 'the reader can always catch up (no cursor left stuck)',
    'L5': 'every move or re-key under way can end once faults and timers stop',
    'L5b': 'grow and shrink finish: in every state reached without a give-up '
           'timer (cancel, abort, abandon), every planned change can still '
           'complete',
    'L7': 'every attempt can get an answer (applied or refused) once faults '
          'and timers stop',
    'L5g': 'a give-up gives the partition back: once a move or re-key is given '
           'up (cancel, abort, abandon committed), calm steps can reach a state '
           'where its source, and only its source, holds the partition open',
}


def norm_lost(lost, tail):
    """Keep the lost tails that could still come back and add something."""
    keep = []
    for g in lost:
        if not g or tail[:len(g)] == g:
            continue
        if any(h != g and h[:len(g)] == g for h in lost):
            continue
        keep.append(g)
    return frozenset(keep)


class Draft:
    """A mutable copy of a state that one action's updates change."""
    __slots__ = ('w', 'st', 'groups', 'refused', 'reader', 'e', 'capped')

    def __init__(self, w, st):
        self.w, self.st = w, st
        self.groups = None
        self.refused = st[2]
        self.reader = st[3]
        self.e = {}            # an entry under construction (field updates)
        self.capped = False

    def append(self, g, entry):
        if self.groups is None:
            self.groups = list(self.st[0])
        com, tail, lost, cr = self.groups[g]
        if entry in com or entry in tail:
            return                  # a log never holds the same entry twice
        if len(com) + len(tail) >= self.w.cap:
            self.capped = True
            return
        self.groups[g] = (com, tail + (entry,), lost, cr)

    def refuse(self, aid):
        self.refused = self.refused | {aid}

    def set_seen(self, seen):
        self.reader = (self.reader[0], seen)

    def set_cursor(self, cursor):
        self.reader = (cursor, self.reader[1])

    def freeze(self):
        groups = self.st[0] if self.groups is None else tuple(self.groups)
        return (groups, self.st[1], self.refused, self.reader)


class Option:
    """The interface an option implements (see HARNESS.md). Subclasses set
    `names` (the group names), and define genesis, actions, owners, rows,
    settled and cursor0."""
    names = ()
    ZERO = (0, 0)          # the default position (what a dropped update leaves)

    def __init__(self, bound):
        self.bound = bound

    def genesis(self):
        """The first committed entries of each group (usually none)."""
        return tuple(() for _ in self.names)

    def actions(self):
        raise NotImplementedError

    def owners(self, w, st, part):
        """Groups whose COMMITTED log holds the partition open for writes."""
        raise NotImplementedError

    def rows(self, w, st, g, part):
        """The partition's rows at group g by its committed log: the attempt
        ids whose effects it holds, in order."""
        raise NotImplementedError

    def settled(self, w, st):
        """No move or re-key under way, and every tail committed."""
        raise NotImplementedError

    def cursor0(self):
        """The reader's first cursor (before any record of p)."""
        raise NotImplementedError

    def given_up(self, w, st):
        """[(partition, group)]: for the latest change if it was given up
        (committed cancel, abort or abandon), the source group that must hold
        the partition again. L5g asks that this stays reachable."""
        return []

    def done_all(self, w, st):
        """Every planned change (the bound's layouts) has completed. L5b asks
        that this stays reachable while nobody gives up."""
        return True

    def show(self, entry):
        return repr(entry)


class World:
    def __init__(self, option_cls, bound, mutation=None, cap=10):
        self.bound = bound
        self.opt = option_cls(bound)
        self.cap = cap
        self.crashes = bound['crashes']             # per group
        self.faults = bound.get('faults', 99)        # crashes per run, all groups
        self.attempts = tuple(bound['attempts'])
        self.part = {a: p for a, p, t in self.attempts}
        self.tok = {a: t for a, p, t in self.attempts}
        self.aids = tuple(a for a, p, t in self.attempts)
        self.K = len(self.opt.names)
        self.capped_now = False
        self._cst, self._clogs = None, ()
        acts = self.opt.actions()
        self.actions = acts
        m = mutation
        self.compiled = []
        for a in acts:
            gs = []
            for g in a.guards:
                if m and g.id in m.drop:
                    continue
                if g.op is None:
                    gs.append(g.fn)
                else:
                    op = FLIP[g.op] if (m and g.id in m.flip) else g.op
                    gs.append(_cmp(g.lhs, OPS[op], g.rhs))
            us = [u for u in a.updates]
            if m and a.name in m.swap:
                i, j = m.swap[a.name]
                us[i], us[j] = us[j], us[i]
            us = [u for u in us if not (m and u.id in m.drop)]
            self.compiled.append((a, gs, us))

    # ------------------------------------------------------------- helpers
    @staticmethod
    def com(st, g):
        return st[0][g][0]

    @staticmethod
    def tail(st, g):
        return st[0][g][1]

    def log(self, st, g):
        """com + tail. Cached for the state being expanded (guards read it often)."""
        if st is self._cst:
            return self._clogs[g]
        grp = st[0][g]
        return grp[0] + grp[1]

    # ------------------------------------------------------------- states
    def init(self):
        gen = self.opt.genesis()
        groups = tuple((gen[g], (), EMPTY, 0) for g in range(self.K))
        hist = tuple(() for _ in PARTS)
        reader = (self.opt.cursor0(), ()) if self.bound.get('reader') else None
        return (groups, hist, EMPTY, reader)

    def succ(self, st):
        """Every step from st: (label, kind, next state). Sets capped_now if
        an append was refused by the log-length cap."""
        groups, hist, refused, reader = st
        self._cst, self._clogs = st, tuple(grp[0] + grp[1] for grp in groups)
        out = []
        used = sum(grp[3] for grp in groups)
        for g in range(self.K):
            com, tail, lost, cr = groups[g]
            if tail:
                e = tail[0]
                ng = (com + (e,), tail[1:], EMPTY, cr)
                nh = hist
                if e[0] == 'w':
                    pi = PIDX[e[2]]
                    nh = hist[:pi] + (hist[pi] + ((e[1], e[3], e[4]),),) + hist[pi + 1:]
                out.append((('commit', self.opt.names[g], self.opt.show(e)), 'commit',
                            (groups[:g] + (ng,) + groups[g + 1:], nh, refused, reader)))
            if cr < self.crashes and used < self.faults and (tail or lost):
                cands = set()
                for src in (tail,) + tuple(lost):
                    for i in range(len(src) + 1):
                        cands.add(src[:i])
                cands.discard(tail)        # keeping the whole tail changes nothing
                lost2 = (lost | {tail}) if tail else lost
                for c in sorted(cands, key=len):
                    ng = (com, c, norm_lost(lost2, c), cr + 1)
                    out.append((('crash', self.opt.names[g], f'tail keeps {len(c)}'), 'crash',
                                (groups[:g] + (ng,) + groups[g + 1:], hist, refused, reader)))
        for a, gs, us in self.compiled:
            for b in a.params(self, st):
                ok = True
                for g in gs:
                    if not g(self, st, b):
                        ok = False
                        break
                if not ok:
                    continue
                d = Draft(self, st)
                for u in us:
                    u.fn(self, st, b, d)
                if d.capped:
                    self.capped_now = True
                    continue
                t = d.freeze()
                if t != st:
                    out.append(((a.name, a.label(b)), a.kind, t))
        return out

    # ------------------------------------------------------------- properties
    def hist_aids(self, st, part):
        return tuple(x[0] for x in st[1][PIDX[part]])

    def check(self, st):
        """The safety properties that fail in state st."""
        bad = []
        opt = self.opt
        groups, hist, refused, reader = st
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
        # P2: a position names one write; positions rise along a history
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
        # P3: once each; tokens never fall; refused never commits
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
        return bad

    @staticmethod
    def check_edge(s, t):
        """P4 on a step: what the reader took only ever grows."""
        a, b = s[3], t[3]
        if a is None or a[1] is b[1]:
            return False
        return b[1][:len(a[1])] != a[1]

    def goals(self, st):
        """(settled, answered, caught up, given back): the liveness goals."""
        settled = self.opt.settled(self, st)
        done = {x[0] for h in st[1] for x in h} | st[2]
        answered = all(a in done for a in self.aids)
        reader = st[3]
        caught = reader is None or reader[1] == self.hist_aids(st, 'p')
        back = all(self.opt.owners(self, st, part) == [g] for part, g in self.opt.given_up(self, st))
        return settled, answered, caught, back


def _cmp(lhs, f, rhs):
    return lambda w, st, b: f(lhs(w, st, b), rhs(w, st, b))


def is_calm(kind):
    return kind in CALM_KINDS or kind == 'commit'
