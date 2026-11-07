"""
restore.py: a restore to a past position keeps positions, lock tokens,
cursors and retries honest. E-33, second half (OPS-07).

OPS-07: "A restore gives every slot a new epoch, so old cursors are refused
`unknown-log` (SC-08(d)); lock fence tokens restart above every token handed
out before the restore, or every lock is reset loudly, so P-10 holds against
outside systems that saw newer tokens; client dedup sessions are cleared,
and a retry is refused, not re-run (F-02)." API.md: a lock token is a
Version, and versions of one partition compare with `<` "across failovers,
moves and restores".

THE WORLD (not counted). One slot's history: writes, lock grants and slot
moves, each at a position (epoch, seq); seq never goes back within a
history, and a move raises the epoch. A backup holds a prefix of the history
with its epoch and seq. A restore replaces the history with a backup's
prefix. One client issues attempts under a session generation; one reader follows the
slot with a cursor (the position of the last record it took). Ghosts, kept
across restores by the harness (freeze): every (position, record) ever
written, the highest token ever granted, every (attempt, history number)
applied.

OPTIONS
  design   the restore takes a new epoch above the high-water mark that
           every epoch is recorded in before it is used (the object store's
           manifest), and starts a new session generation.
  naive    "a restore gives every slot a new epoch" read as the backup's
           epoch plus one: no high-water mark.

PROPERTIES
  R1  a position never names two records, across restores (so a cursor or
      version from before the restore can never be read as one after it).
  R2  lock tokens strictly rise in real time, across restores (P-10 holds
      against an outside system that saw a newer token).
  R3  an attempt applied before a restore is never applied again after it:
      a retry is refused, not re-run (F-02).
  R4  the reader takes records with no gap and no overlap: each record it
      takes follows its cursor in the history it reads; a cursor the
      history does not hold is refused (`unknown-log`) and the reader
      starts over.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

FIELDS = ('hist', 'ep', 'sq', 'hw', 'snaps', 'sgen', 'issued', 'cur', 'nmv', 'restores',
          'everpos', 'evertok', 'everapp', 'hno')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()
CAP = 6            # a bound, not a rule: records in one history


class Restore:
    CALM = ('deliver', 'time')
    INFO = ()
    NAIVE = False

    def __init__(self, bound):
        self.b = bound

    def init(self):
        return ((), 1, 0, 1, E, 1, E, None, 0, 0, E, (0, 0), E, 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        f = d.f
        # the harness keeps the ghosts: every (position, record) ever in a
        # history, the highest token granted, every (attempt, history) applied
        f['everpos'] = f['everpos'] | {(e[2], e[:2]) for e in f['hist']}
        for e in f['hist']:
            if e[0] == 'k' and e[2] > f['evertok']:
                f['evertok'] = e[2]
        f['everapp'] = f['everapp'] | {(e[1], f['hno']) for e in f['hist'] if e[0] == 'w'}
        return tuple(f[x] for x in FIELDS)

    def world(self, st):
        out = []
        d = self.to_draft(st)
        # the client issues an attempt under its current session generation
        for a in self.b['attempts']:
            if not any(x[0] == a for x in st[IX['issued']]):
                out.append((('issue', a), 'control', self._set(st, issued=st[IX['issued']] | {(a, st[IX['sgen']])})))
        # a backup of the current history
        if len(st[IX['snaps']]) < self.b['backups']:
            snap = (st[IX['hist']], st[IX['ep']], st[IX['sq']], st[IX['sgen']])
            if snap not in st[IX['snaps']]:
                out.append((('backup', len(st[IX['hist']])), 'control', self._set(st, snaps=st[IX['snaps']] | {snap})))
        return out

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return tuple(d[f] for f in FIELDS)

    def check(self, st):
        bad = []
        pos = {}
        for p, rec in st[IX['everpos']]:
            if pos.setdefault(p, rec) != rec:
                bad.append('R1')
                break
        return bad

    def check_edge(self, s, lab, kind, t):
        bad = []
        if lab[0] == 'write':
            # an attempt applied in any earlier history (the restore dropped
            # it, or kept it) is applied again: a retry was re-run
            a = dict(lab[1])['a']
            if any(x == a for x, h in s[IX['everapp']]):
                bad.append('R3')
        if lab[0] == 'lock':
            new = [e for e in t[IX['hist']] if e[0] == 'k' and e not in s[IX['hist']]]
            if new and not new[-1][2] > s[IX['evertok']]:
                bad.append('R2')
        if lab[0] == 'read' and t[IX['cur']] is not None:
            h = s[IX['hist']]
            poss = [e[2] for e in h]
            cur = s[IX['cur']]
            i = poss.index(t[IX['cur']]) if t[IX['cur']] in poss else -1
            ok = i >= 0 and ((cur is None and i == 0) or (i > 0 and poss[i - 1] == cur))
            if not ok:
                bad.append('R4')
        return bad

    def goals(self, st):
        return {}

    def judged(self, st):
        return {}

    def actions(self):
        def attempts(w, st):
            if len(st[IX['hist']]) >= CAP or st[IX['sq']] >= 2 * CAP:
                return                     # a bound, not a rule: the history's length
            for (a, g) in sorted(st[IX['issued']]):
                yield {'a': a, 'g': g}

        def one(w, st):
            yield {}

        def one_cap(w, st):
            if len(st[IX['hist']]) < CAP and st[IX['sq']] < 2 * CAP:
                yield {}

        def snaps(w, st):
            for sn in sorted(st[IX['snaps']]):
                yield {'snap': sn}

        def stamp(kind):
            def f(w, st, b, d):
                pos = (st[IX['ep']], st[IX['sq']] + 1)
                rec = ('w', b['a'], pos) if kind == 'w' else ('k', 'lock', pos)
                d.f['hist'] = st[IX['hist']] + (rec,)
            return f

        def seq(w, st, b, d):
            d.f['sq'] = st[IX['sq']] + 1

        def epoch_up(w, st, b, d):
            d.f['ep'] = st[IX['ep']] + 1
            d.f['nmv'] = st[IX['nmv']] + 1       # a bound counter, not a rule

        def hw_up(w, st, b, d):
            d.f['hw'] = max(st[IX['hw']], st[IX['ep']] + 1)

        def r_world(w, st, b, d):
            # what any restore does (the world, pinned): the history, the
            # slot's epoch and sequence, and the session table all come back
            # as the backup holds them
            hist, ep, sq, sgen = b['snap']
            d.f['hist'], d.f['ep'], d.f['sq'], d.f['sgen'] = hist, ep, sq, sgen
            d.f['hno'] = st[IX['hno']] + 1           # a ghost: the history number
            d.f['restores'] = st[IX['restores']] + 1

        def r_epoch(w, st, b, d):
            d.f['ep'] = (b['snap'][1] + 1) if w.NAIVE else st[IX['hw']] + 1

        def r_hw(w, st, b, d):
            d.f['hw'] = (b['snap'][1] + 1) if w.NAIVE else st[IX['hw']] + 1

        def r_sgen(w, st, b, d):
            # a fresh session generation, never used before (sessions are
            # matched by equality, so a fresh id is enough)
            d.f['sgen'] = 100 + st[IX['restores']]

        def nxt(w, st):
            h = st[IX['hist']]
            cur = st[IX['cur']]
            poss = [e[2] for e in h]
            if cur is None:
                i = 0
            elif cur in poss:
                i = poss.index(cur) + 1
            else:
                # the cursor is not in this history: the next record by order
                later = [k for k, p in enumerate(poss) if p > cur]
                i = later[0] if later else len(h)
            return i

        def read_take(w, st, b, d):
            i = nxt(w, st)
            d.f['cur'] = st[IX['hist']][i][2]

        def reads(w, st):
            if nxt(w, st) < len(st[IX['hist']]):
                yield {}

        def refuse(w, st, b, d):
            d.f['cur'] = None

        acts = [
            Action('write', 'deliver', attempts, [
                Guard('session', lambda w, st, b: b['g'] == st[IX['sgen']], role='session',
                      note='an attempt from a session older than the restore is refused'),
                Guard('dedup', lambda w, st, b: not any(e[0] == 'w' and e[1] == b['a'] for e in st[IX['hist']]),
                      role='dedup', note='an attempt already applied in this history is not applied again'),
            ], [Update('stamp', stamp('w'), role='stamp'), Update('seq', seq, role='stamp')]),
            Action('lock', 'deliver', one_cap, [
                Cmp('one', lambda w, st, b: sum(1 for e in st[IX['hist']] if e[0] == 'k'), '<',
                    lambda w, st, b: w.b['locks'], role='bound'),
            ], [Update('stamp', stamp('k'), role='stamp'), Update('seq', seq, role='stamp')]),
            Action('move', 'deliver', one, [
                Cmp('one', lambda w, st, b: st[IX['nmv']], '<', lambda w, st, b: w.b['moves'], role='bound'),
            ], [Update('hw', hw_up, role='epoch', note='the new epoch is recorded in the store before use'),
                Update('epoch', epoch_up, role='epoch')]),
            Action('restore', 'control', snaps, [
                Cmp('budget', lambda w, st, b: st[IX['restores']], '<', lambda w, st, b: w.b['restores'],
                    role='bound'),
            ], [Update('world', r_world, role='bound', note='the backup comes back (the world)'),
                Update('epoch', r_epoch, role='epoch', note='a new epoch above every epoch used'),
                Update('hw', r_hw, role='epoch'),
                Update('sgen', r_sgen, role='session', note='sessions cleared: a new generation')]),
            Action('read', 'deliver', reads, [
                Guard('known', lambda w, st, b: st[IX['cur']] is None
                      or st[IX['cur']] in [e[2] for e in st[IX['hist']]], role='cursor',
                      note='a cursor this history does not hold is refused (unknown-log)'),
            ], [Update('take', read_take, role='bound', note='the reader takes the record (the world)')]),
            Action('refused', 'deliver', one, [
                Guard('unknown', lambda w, st, b: st[IX['cur']] is not None
                      and st[IX['cur']] not in [e[2] for e in st[IX['hist']]], role='cursor'),
            ], [Update('reset', refuse, role='cursor', note='the reader starts over from a snapshot')]),
        ]
        return acts


class Naive(Restore):
    NAIVE = True


OPTIONS = {'design': Restore, 'naive': Naive}

BOUNDS = {
    # one write, one lock, one move, one backup, one restore
    'b1': dict(attempts=('a1',), locks=1, moves=1, backups=1, restores=1),
    # two writes, one lock, no move
    'b2': dict(attempts=('a1', 'a2'), locks=1, moves=0, backups=1, restores=1),
    # one write, one lock, two moves, two backups
    'b3': dict(attempts=('a1',), locks=1, moves=2, backups=2, restores=1),
}
SWEEP = ('b1', 'b2', 'b3')
VERIFY = ()
# Pinned: the bounds, and the world's own steps written as updates (a
# record lands in the log; a restore brings the backup back; the reader takes
# a record). Without them the model has nothing left to check.
# A slot move raising the epoch is E-15's rule (the slot design), the world
# here: in one slot it has no job of its own, so it is pinned too.
PINNED = {'design': ('lock.one', 'move.one', 'restore.budget', 'restore.world', 'read.take',
                     'write.stamp', 'lock.stamp', 'move.epoch'),
          'naive': ('lock.one', 'move.one', 'restore.budget', 'restore.world', 'read.take',
                    'write.stamp', 'lock.stamp', 'move.epoch')}
