"""
client.py: a client finds the right copy through a soft directory. E-51.

DECISIONS V5-3: "A client asks it once for one address of a resource, then
learns the members, slot table and leaders from the resource itself ...
While the directory is down, connected clients keep working; only first
lookups wait." simplicity.json soft-directory rules 8 (a client keeps an
address only if the HELLO there names the same project and resource), 9 (it
asks the directory only for a first address; from then on it learns
members from the resource itself) and 10 (a lookup that fails or finds
nothing is asked again; never given up). Rule 9 as written leaves a client
stuck once every member it learned is dead or moved (FIND, 5 steps: see
the README), so the design here adds the fix the runs found: a failed dial
marks that member failed but keeps it (it is retried: forgetting it leaves
a client stuck in a blackout when the member comes back, CONN, 10 steps),
and once every member it knows has failed since it last connected, the
client asks the directory again (`dialfail.mark` and the `lookup.first`
guard, counted like the others).

THE WORLD (not counted). Three machines (addresses 0, 1, 2), each up or
down, on side 0 or 1, each running one server process of this project (P),
or, after a fault, of another project (Q) that reused the address (a port
taken by another project's process after a crash; Q has a resource of the
same name). One resource r: a set of machines holding its copies; healing
moves a copy (a world step, budgeted). One seed directory, on the client's
side, with soft entries for r: a live holder's announcement adds its
address; an entry outlives its announcer until the failure detector or the
takeback removes it (a `time` step), so the directory can hand out an
address that is dead, holds no copy of r any more (its server holds other
resources only), or now answers for project Q. The directory host can die
and a takeover brings it back (the table is then rebuilt from live
holders, as models/dirtable.py shows); a `blackout` fault takes every
directory host down for good (V5-3's case). One client, on side 0, that
wants r: it looks r up, dials an address, checks the HELLO, and once
connected is told the members by the resource itself (and told again when
they change).

FAULTS (budget): crash, cut (to side 1), reuse (a down machine's address
comes back as project Q's process), the directory host's death, blackout.
Healing's moves have their own budget. RECOVER (free): start (as P), heal.
CALM: deliver, tick, time.

PROPERTIES
  D1    a client never treats another project's copy, or a server that holds
        no copy of r, as r (soft-directory rule 8's property).
  FIND  AG EF: from every state where r has a live copy the client can
        reach and the directory is not blacked out, calm steps reach a state
        where the client is connected to a live copy of r.
  CONN  AG EF (V5-3): from every state in a blackout where the client was
        connected before and a member the resource last told it of still
        holds a live copy it can reach, calm steps (no directory) reach a
        state where it is connected to a live copy.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

S = 3
P, Q = 'P', 'Q'
LOOK, FAILED = 'look', 'failed'
FIELDS = ('mach', 'copies', 'dir', 'ent', 'phase', 'known', 'failed', 'told', 'moves', 'faults')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()
UP, DOWN, DARK = 'up', 'down', 'dark'


def _put(t, i, v):
    t = list(t)
    t[i] = v
    return tuple(t)


class Client:
    CALM = ('deliver', 'tick', 'time')
    INFO = ()

    def __init__(self, bound):
        self.b = bound
        self.budget = bound['faults']
        self.mbudget = bound.get('moves', 0)
        self.kinds = set(bound.get('kinds', ('crash', 'cut', 'reuse', 'hostdie', 'blackout')))
        self.copies0 = frozenset(bound.get('copies', (0, 1)))

    def init(self):
        mach = tuple((True, 0, P) for _ in range(S))
        return (mach, self.copies0, UP, E, LOOK, E, E, E, 0, 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[x] for x in FIELDS)

    def _frz(self, f):
        return tuple(f[x] for x in FIELDS)

    # ---- views
    @staticmethod
    def up(st, m):
        return st[0][m][0]

    @staticmethod
    def side(st, m):
        return st[0][m][1]

    @staticmethod
    def proj(st, m):
        return st[0][m][2]

    def dialable(self, st, a):
        return self.up(st, a) and self.side(st, a) == 0

    def right(self, st, a):
        """a's process is this project's and holds a copy of r."""
        return self.proj(st, a) == P and a in st[IX['copies']]

    def live(self, st, a):
        return self.dialable(st, a) and self.right(st, a)

    # ---- world
    def world(self, st):
        out = []
        mach, faults, cp = st[0], st[IX['faults']], st[IX['copies']]
        for m in range(S):
            up, side, pj = mach[m]
            if faults < self.budget:
                if up and 'crash' in self.kinds:
                    out.append((('crash', m), 'fault', self._set(st, mach=_put(mach, m, (False, side, pj)), faults=faults + 1)))
                if up and side == 0 and 'cut' in self.kinds:
                    out.append((('cut', m), 'fault', self._set(st, mach=_put(mach, m, (True, 1, pj)), faults=faults + 1)))
                if not up and pj == P and 'reuse' in self.kinds:
                    out.append((('reuse', m), 'fault', self._set(st, mach=_put(mach, m, (True, side, Q)), faults=faults + 1)))
            if not up:
                out.append((('start', m), 'recover', self._set(st, mach=_put(mach, m, (True, side, P)))))
            if side == 1:
                out.append((('heal', m), 'recover', self._set(st, mach=_put(mach, m, (up, 0, pj)))))
        if faults < self.budget:
            if st[IX['dir']] == UP and 'hostdie' in self.kinds:
                out.append((('hostdie',), 'fault', self._set(st, dir=DOWN, ent=E, faults=faults + 1)))
            if st[IX['dir']] != DARK and 'blackout' in self.kinds:
                out.append((('blackout',), 'fault', self._set(st, dir=DARK, ent=E, faults=faults + 1)))
        if st[IX['dir']] == DOWN:
            # takeover (models/dirtable.py rule 6), and the table rebuilt by re-announcement
            ent = frozenset(a for a in range(S) if self.up(st, a) and self.proj(st, a) == P and a in cp)
            out.append((('takeover',), 'time', self._set(st, dir=UP, ent=ent)))
        if st[IX['dir']] == UP:
            for a in range(S):
                if a not in st[IX['ent']] and self.up(st, a) and self.proj(st, a) == P and a in cp and self.side(st, a) == 0:
                    out.append((('announce', a), 'deliver', self._set(st, ent=st[IX['ent']] | {a})))
                if a in st[IX['ent']] and not (self.up(st, a) and self.proj(st, a) == P and a in cp):
                    out.append((('expire', a), 'time', self._set(st, ent=st[IX['ent']] - {a})))
        if st[IX['moves']] < self.mbudget:
            for a in cp:
                for b in range(S):
                    if b not in cp and self.up(st, b) and self.proj(st, b) == P:
                        out.append((('move', a, b), 'fault', self._set(st, copies=(cp - {a}) | {b}, moves=st[IX['moves']] + 1)))
        # a connected client notices its copy is gone (closed link, or the
        # server says it holds no copy any more) and starts over
        ph = st[IX['phase']]
        if isinstance(ph, tuple) and ph[0] == 'conn' and not self.live(st, ph[1]):
            out.append((('lost', ph[1]), 'deliver', self._set(st, phase=LOOK)))
        return out

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return self._frz(d)

    # ---- properties
    def check(self, st):
        return []

    def check_edge(self, s, lab, kind, t):
        if lab[0] == 'hello':
            a = dict(lab[1])['a']
            if not self.right(s, a):
                return ['D1']
        return []

    def connected(self, st):
        ph = st[IX['phase']]
        return isinstance(ph, tuple) and ph[0] == 'conn' and self.live(st, ph[1])

    def goals(self, st):
        c = self.connected(st)
        return {'FIND': c, 'CONN': c}

    def judged(self, st):
        anylive = any(self.live(st, a) for a in range(S))
        dark = st[IX['dir']] == DARK
        told = st[IX['told']]
        return {'FIND': anylive and not dark,
                'CONN': dark and bool(told) and any(self.live(st, a) for a in told)}

    # ---- the rules (counted)
    def actions(self):
        def phase_is(p):
            return lambda st: st[IX['phase']] == p

        def looks(w, st):
            if st[IX['phase']] == LOOK and st[IX['dir']] == UP:
                for a in st[IX['ent']]:
                    yield {'a': a}

        def misses(w, st):
            if st[IX['phase']] == LOOK and st[IX['dir']] == UP and not st[IX['ent']]:
                yield {}

        def redials(w, st):
            if st[IX['phase']] == LOOK:
                for a in st[IX['known']]:
                    yield {'a': a}

        def dials(w, st):
            ph = st[IX['phase']]
            if isinstance(ph, tuple) and ph[0] == 'dial' and w.dialable(st, ph[1]):
                yield {'a': ph[1]}

        def conns(w, st):
            ph = st[IX['phase']]
            if isinstance(ph, tuple) and ph[0] == 'conn' and w.live(st, ph[1]) and st[IX['told']] != st[IX['copies']]:
                yield {'a': ph[1]}

        def fails(w, st):
            ph = st[IX['phase']]
            if isinstance(ph, tuple) and ph[0] == 'dial' and not w.dialable(st, ph[1]):
                yield {'a': ph[1]}

        def mark(w, st, b, d):
            d.f['failed'] = d.f['failed'] | {b['a']}

        def setp(v):
            def f(w, st, b, d):
                d.f['phase'] = v(b) if callable(v) else v
            return f

        def tell(w, st, b, d):
            d.f['told'] = st[IX['copies']]       # what the resource itself says (a ghost)
            d.f['failed'] = E

        def learn(w, st, b, d):
            d.f['known'] = st[IX['copies']]

        def drop(w, st, b, d):
            d.f['phase'] = LOOK
            d.f['known'] = d.f['known'] - {b['a']}
            d.f['failed'] = d.f['failed'] - {b['a']}

        return [
            Action('lookup', 'deliver', looks, [
                Guard('first', lambda w, st, b: st[IX['known']] <= st[IX['failed']], role='softdir',
                      note='it asks the directory only while no member it knows has answered since it last connected (rule 9, first half)'),
            ], [Update('pick', setp(lambda b: ('dial', b['a'])), role='world', note='dial an address the directory gave (pinned)')]),
            Action('miss', 'deliver', misses, [], [
                Update('fail', setp(FAILED), role='world', note='a lookup that finds nothing fails (pinned)'),
                Update('again', setp(LOOK), role='softdir',
                       note='a lookup that fails or finds nothing is asked again later, never given up (rule 10)'),
            ]),
            Action('redial', 'deliver', redials, [], [
                Update('pick', setp(lambda b: ('dial', b['a'])), role='world',
                       note='dial a member the resource told it of (pinned)'),
            ]),
            Action('hello', 'deliver', dials, [
                Guard('proj', lambda w, st, b: w.proj(st, b['a']) == P, role='softdir',
                      note='the HELLO names the same project (rule 8)'),
                Guard('res', lambda w, st, b: b['a'] in st[IX['copies']], role='softdir',
                      note='the HELLO names the same resource: the server holds a copy of it (rule 8)'),
            ], [
                Update('conn', setp(lambda b: ('conn', b['a'])), role='world', note='connected (pinned)'),
                Update('tell', tell, role='world', note='the resource tells it the members (a ghost; pinned)'),
                Update('learn', learn, role='softdir',
                       note='it keeps the members the resource tells it (rule 9, second half)'),
            ]),
            Action('reject', 'deliver', dials, [
                Guard('wrong', lambda w, st, b: not w.right(st, b['a']), role='world',
                      note='any other answer (pinned)'),
            ], [Update('drop', drop, role='softdir', note='drops the address and tries the next (rule 8)')]),
            Action('dialfail', 'deliver', fails, [], [
                Update('back', setp(LOOK), role='world', note='a dial that finds nothing there fails (pinned)'),
                Update('mark', mark, role='softdir',
                       note='a failed dial marks that member failed (still retried), so once every member it knows has failed the client asks the directory again (new)'),
            ]),
            Action('refresh', 'deliver', conns, [], [
                Update('tell', tell, role='world', note='the resource tells it the new members (pinned)'),
                Update('learn', learn, role='softdir', note='rule 9, when members change'),
            ]),
        ]


OPTIONS = {'design': Client}
PINNED = {'design': ('lookup.pick', 'miss.fail', 'redial.pick', 'hello.conn', 'hello.tell', 'reject.wrong',
                     'dialfail.back', 'refresh.tell')}

BOUNDS = {
    # copies on 0 and 1, one fault of any kind, one move
    'c1': dict(faults=1, moves=1),
    # two faults, no move
    'c2': dict(faults=2, moves=0),
    # two faults, one move
    'c2m': dict(faults=2, moves=1),
    # three faults, one move
    'c3m': dict(faults=3, moves=1),
}
SWEEP = ('c1', 'c2')
VERIFY = ('c2m',)
VERIFY_PASS1 = True
