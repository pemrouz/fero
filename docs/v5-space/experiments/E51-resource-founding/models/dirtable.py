"""
dirtable.py: the soft directory's table, rebuilt from announcements alone. E-51.

DECISIONS V5-3: "Servers announce which resources they hold copies of. The
directory is rebuilt from those announcements, keeps no log, decides
nothing, and any machine can serve it." The rules are v4's #directory
(api/directory.ts) stretched across machines (simplicity.json
soft-directory, rules 1 to 12).

THE WORLD (not counted). Three machines (servers 0, 1, 2), each up or down,
on side 0 or 1. One or two seed directories (a bound setting), hosted on
machine 1, or on machines 0 and 1 (machine 2 hosts no seed). A directory's host can die alone (another process on that
machine may take it over); a machine's crash kills its host too, and a
server that starts binds its machine's directory first (v4's start). A
table is soft state: a host's death empties it. Copies: each resource has a
set of machines holding a copy; healing moves a copy from one machine to
another (a world step, budgeted: E-16's rules). Links: one per server and
directory, with a generation (a link's identity, never reused while the
directory still holds an older link of that server); when a server crashes or is cut off, the
server side sees its link gone at once (it will dial again), but the
directory holds the old link as stale until its failure detector notices
(v4: WATCH_TICKS silent beats), so an entry can outlive its announcer for a
while, and a server back within that window opens a new link beside the
stale one. A server learns of a new copy as a to-do (announce it); the
table's entries are (server, resource, owner link); every server also
announces itself as a machine (an entry with resource M; soft-directory
rule 2, which healing reads: models/place.py counts it), so a server has
more than one entry and a link can own some of them and not others.

FAULTS (budget): crash, cut (to side 1), a directory host's death.
Healing's moves have their own budget. RECOVER (free): start, heal.
CALM: deliver and time (links open, announcements, the failure detector,
the takeover delay).

PROPERTIES
  REBUILD  AG EF: once calm, every seed directory whose machine is up is
           hosted, and its table holds exactly the copies on live servers it
           reaches: none missing, none stale. (The task's "a re-announce after
           a directory host moves rebuilds the table from announcements
           alone".)
  FIND.r   AG EF: from every state where resource r has a live copy on the
           client's side (side 0) and a seed machine is up there, calm
           steps reach a state where a hosted seed directory on side 0
           lists a live copy of r that the client can dial.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

S = 3
FIELDS = ('mach', 'copies', 'host', 'table', 'link', 'closed', 'pend', 'moves', 'faults')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()
NOLINK = (None, None)      # (current generation, stale generation the directory still holds)
M = 'M'                    # a server's machine entry (soft-directory rule 2), announced with its copies


def _put(t, i, v):
    t = list(t)
    t[i] = v
    return tuple(t)


class DirTable:
    CALM = ('deliver', 'tick', 'time')
    INFO = ()

    def __init__(self, bound):
        self.b = bound
        self.NR = bound.get('names', 1)
        self.budget = bound['faults']
        self.mbudget = bound.get('moves', 0)
        self.kinds = set(bound.get('kinds', ('crash', 'cut', 'hostdie')))
        self.start_copies = bound.get('copies', ((0, 2), (1, 2)))[:self.NR]
        self.DIRS = tuple(bound.get('dirs', (0, 1)))      # seed directories, hosted on these machines

    def L(self, s, d):
        return s * 2 + d

    def init(self):
        mach = tuple((True, 0) for _ in range(S))
        copies = tuple(frozenset(c) for c in self.start_copies)
        return (mach, copies, (True, True), (E, E), (NOLINK,) * (S * 2), (E, E), E, 0, 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        f = d.f
        # housekeeping, not a rule: a closed link with no entry left is forgotten
        cl = []
        for k in range(2):
            keep = frozenset((s, g) for (s, g) in f['closed'][k] if any(e[0] == s and e[2] == g for e in f['table'][k]))
            cl.append(keep)
        f['closed'] = tuple(cl)
        return tuple(f[x] for x in FIELDS)

    # ---- views
    @staticmethod
    def up(st, m):
        return st[0][m][0]

    @staticmethod
    def side(st, m):
        return st[0][m][1]

    def dir_up(self, st, d):
        return st[IX['host']][d] and self.up(st, d)

    def reach(self, st, s, d):
        return self.up(st, s) and self.dir_up(st, d) and self.side(st, s) == self.side(st, d)

    def held(self, st, s, r):
        return r == M or s in st[IX['copies']][r]

    def truth(self, st, d):
        t = {(s, r) for r in range(self.NR) for s in st[IX['copies']][r]
             if self.up(st, s) and self.side(st, s) == self.side(st, d)}
        t |= {(s, M) for s in range(S) if self.up(st, s) and self.side(st, s) == self.side(st, d)}
        return frozenset(t)

    # ---- world
    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        from engine import Draft
        return self.freeze(Draft(d))

    def _stale(self, link, closed, s, d):
        """The server side drops link (s, d) now; the directory keeps it
        stale until it notices. A second stale link is closed at once (a
        bound on what the directory remembers: one stale link per pair)."""
        cur, old = link[self.L(s, d)]
        if cur is None:
            return link, closed
        if old is not None:
            closed = _put(closed, d, closed[d] | {(s, old)})
        return _put(link, self.L(s, d), (None, cur)), closed

    def _kill_host(self, st_f, d):
        st_f['host'] = _put(st_f['host'], d, False)
        st_f['table'] = _put(st_f['table'], d, E)
        st_f['closed'] = _put(st_f['closed'], d, E)
        lk = st_f['link']
        for s in range(S):
            lk = _put(lk, self.L(s, d), NOLINK)
        st_f['link'] = lk

    def world(self, st):
        out = []
        mach, faults = st[0], st[IX['faults']]
        for m in range(S):
            up, side = mach[m]
            if faults < self.budget:
                if up and 'crash' in self.kinds:
                    f = self.to_draft(st)
                    f['mach'] = _put(mach, m, (False, side))
                    lk, cl = f['link'], f['closed']
                    for d in self.DIRS:
                        lk, cl = self._stale(lk, cl, m, d)
                    f['link'], f['closed'] = lk, cl
                    if m in self.DIRS:
                        self._kill_host(f, m)
                    f['faults'] = faults + 1
                    out.append((('crash', m), 'fault', self._frz(f)))
                if up and side == 0 and 'cut' in self.kinds:
                    f = self.to_draft(st)
                    f['mach'] = _put(mach, m, (True, 1))
                    lk, cl = f['link'], f['closed']
                    for s in range(S):
                        for d in self.DIRS:
                            if (s == m or d == m) and f['mach'][s][1] != f['mach'][d][1]:
                                lk, cl = self._stale(lk, cl, s, d)
                    f['link'], f['closed'] = lk, cl
                    f['faults'] = faults + 1
                    out.append((('cut', m), 'fault', self._frz(f)))
                if m in self.DIRS and up and st[IX['host']][m] and 'hostdie' in self.kinds:
                    f = self.to_draft(st)
                    self._kill_host(f, m)
                    f['faults'] = faults + 1
                    out.append((('hostdie', m), 'fault', self._frz(f)))
            if not up:
                f = self.to_draft(st)
                f['mach'] = _put(mach, m, (True, side))
                if m in self.DIRS:
                    f['host'] = _put(f['host'], m, True)     # a starting server binds its directory first
                out.append((('start', m), 'recover', self._frz(f)))
            if side == 1:
                f = self.to_draft(st)
                f['mach'] = _put(mach, m, (up, 0))
                lk, cl = f['link'], f['closed']
                for s2 in range(S):
                    for d in self.DIRS:
                        if (s2 == m or d == m) and f['mach'][s2][1] != f['mach'][d][1]:
                            lk, cl = self._stale(lk, cl, s2, d)
                f['link'], f['closed'] = lk, cl
                out.append((('heal', m), 'recover', self._frz(f)))
        if st[IX['moves']] < self.mbudget:
            for r in range(self.NR):
                cp = st[IX['copies']][r]
                for a in cp:
                    for b in range(S):
                        if b not in cp and self.up(st, b):
                            f = self.to_draft(st)
                            f['copies'] = _put(st[IX['copies']], r, (cp - {a}) | {b})
                            f['pend'] = st[IX['pend']] | {(b, r)}
                            f['moves'] = st[IX['moves']] + 1
                            out.append((('move', r, a, b), 'fault', self._frz(f)))
        return out

    def _frz(self, f):
        from engine import Draft
        return self.freeze(Draft(f))

    # ---- properties
    def check(self, st):
        return []

    def check_edge(self, s, lab, kind, t):
        return []

    def rebuilt(self, st):
        for d in self.DIRS:
            if not self.up(st, d):
                continue
            if not st[IX['host']][d]:
                return False
            if frozenset((e[0], e[1]) for e in st[IX['table']][d]) != self.truth(st, d):
                return False
        return True

    def live_copy(self, st, r):
        return any(self.up(st, s) and self.side(st, s) == 0 for s in st[IX['copies']][r])

    def found(self, st, r):
        for d in self.DIRS:
            if self.dir_up(st, d) and self.side(st, d) == 0:
                for (s, rr, g) in st[IX['table']][d]:
                    if rr == r and s in st[IX['copies']][r] and self.up(st, s) and self.side(st, s) == 0:
                        return True
        return False

    def goals(self, st):
        g = {'REBUILD': self.rebuilt(st)}
        for r in range(self.NR):
            g[f'FIND.{r}'] = self.found(st, r)
        return g

    def judged(self, st):
        j = {'REBUILD': True}
        seed = any(self.up(st, d) and self.side(st, d) == 0 for d in self.DIRS)
        for r in range(self.NR):
            j[f'FIND.{r}'] = seed and self.live_copy(st, r)
        return j

    # ---- the rules (counted)
    def actions(self):
        def conns(remote):
            def gen(w, st):
                for s in range(S):
                    for d in self.DIRS:
                        if (d != s) != remote:
                            continue
                        if st[IX['link']][self.L(s, d)][0] is None and w.reach(st, s, d):
                            yield {'s': s, 'd': d}
            return gen

        def newgen(st, b):
            # a new link never shares an identity with a link the directory
            # still holds (stale, or closed with entries still to expire)
            used = {st[IX['link']][self.L(b['s'], b['d'])][1]} | {g for (s, g) in st[IX['closed']][b['d']] if s == b['s']}
            return min(g for g in range(3) if g not in used)

        def opn(w, st, b, d):
            d.f['link'] = _put(d.f['link'], self.L(b['s'], b['d']), (newgen(st, b), st[IX['link']][self.L(b['s'], b['d'])][1]))

        def again(w, st, b, d):
            g = d.f['link'][self.L(b['s'], b['d'])][0]
            if g is None:
                return
            s, k = b['s'], b['d']
            tb = d.f['table'][k]
            for r in list(range(w.NR)) + [M]:
                if w.held(st, s, r) and not any(e[0] == s and e[1] == r for e in tb):
                    tb = tb | {(s, r, g)}
            d.f['table'] = _put(d.f['table'], k, tb)

        def take(w, st, b, d):
            g = d.f['link'][self.L(b['s'], b['d'])][0]
            if g is None:
                return
            s, k = b['s'], b['d']
            tb = d.f['table'][k]
            old = frozenset(e for e in tb if e[0] == s and e[2] != g and w.held(st, s, e[1]))
            d.f['table'] = _put(d.f['table'], k, (tb - old) | frozenset((s, e[1], g) for e in old))

        def pends(w, st):
            for (s, r) in st[IX['pend']]:
                if w.up(st, s):
                    yield {'s': s, 'r': r}

        def entry(w, st, b, d):
            s, r = b['s'], b['r']
            if s not in st[IX['copies']][r]:
                return
            for k in self.DIRS:
                g = st[IX['link']][self.L(s, k)][0]
                if g is not None and w.reach(st, s, k) and not any(e[0] == s and e[1] == r for e in d.f['table'][k]):
                    d.f['table'] = _put(d.f['table'], k, d.f['table'][k] | {(s, r, g)})

        def clear(w, st, b, d):
            d.f['pend'] = d.f['pend'] - {(b['s'], b['r'])}

        def stales(w, st):
            for s in range(S):
                for k in self.DIRS:
                    if st[IX['link']][self.L(s, k)][1] is not None and w.dir_up(st, k):
                        yield {'s': s, 'd': k}

        def close(w, st, b, d):
            cur, old = st[IX['link']][self.L(b['s'], b['d'])]
            d.f['link'] = _put(d.f['link'], self.L(b['s'], b['d']), (cur, None))
            d.f['closed'] = _put(d.f['closed'], b['d'], d.f['closed'][b['d']] | {(b['s'], old)})

        def expires(w, st):
            for k in self.DIRS:
                cl = st[IX['closed']][k]
                if not cl:
                    continue
                dead = {s for (s, g) in cl}
                for e in st[IX['table']][k]:
                    if e[0] in dead:
                        yield {'d': k, 'e': e}

        def drop(w, st, b, d):
            d.f['table'] = _put(d.f['table'], b['d'], d.f['table'][b['d']] - {b['e']})

        def backs(w, st):
            for k in self.DIRS:
                for e in st[IX['table']][k]:
                    s, r, g = e
                    cur = st[IX['link']][self.L(s, k)][0]
                    if cur is not None and w.reach(st, s, k) and not w.held(st, s, r):
                        yield {'d': k, 'e': e, 'g': cur}

        def downs(w, st):
            for k in self.DIRS:
                if not st[IX['host']][k] and w.up(st, k):
                    yield {'d': k}

        def host(w, st, b, d):
            d.f['host'] = _put(d.f['host'], b['d'], True)

        return [
            Action('connect', 'deliver', conns(False), [], [
                Update('open', opn, role='world', note="a server dials its own machine's directory (pinned)"),
                Update('again', again, role='softdir',
                       note='on every new link it announces every copy it holds, and itself (rule 3)'),
                Update('take', take, role='softdir',
                       note='its later announcement takes over its own older entries (rule 11, first half)'),
            ]),
            Action('rconnect', 'deliver', conns(True), [], [
                Update('open', opn, role='softdir',
                       note="a server also links to every other seed directory (rule 7)"),
                Update('again', again, role='softdir', note='rule 3, on a link to another machine\'s seed'),
                Update('take', take, role='softdir', note='rule 11, on a link to another machine\'s seed'),
            ]),
            Action('announce', 'deliver', pends, [], [
                Update('entry', entry, role='softdir',
                       note='a server announces a copy it gains to every directory it is linked to (rule 1)'),
                Update('clear', clear, role='world', note='the to-do is done (pinned)'),
            ]),
            Action('notice', 'tick', stales, [], [
                Update('close', close, role='world',
                       note="the host's failure detector closes a silent link (pinned: v4's WATCH_TICKS)"),
            ]),
            Action('expire', 'deliver', expires, [
                Guard('owner', lambda w, st, b: (b['e'][0], b['e'][2]) in st[IX['closed']][b['d']], role='softdir',
                      note="only the entry's current announcer's death drops it (rule 11, second half)"),
            ], [Update('drop', drop, role='softdir',
                       note="an entry lives only while its announcer's link lives (rule 4)")]),
            Action('takeback', 'deliver', backs, [
                Guard('owner', lambda w, st, b: b['e'][2] == b['g'], role='softdir',
                      note='only the current announcer may take an entry back (rule 11)'),
            ], [Update('undo', drop, role='softdir',
                       note='a server takes back an entry as soon as it stops holding that copy (rule 5)')]),
            Action('takeover', 'tick', downs, [], [
                Update('host', host, role='softdir',
                       note="when a machine's directory host stops, another server there hosts it after a delay (rule 6)"),
            ]),
        ]


OPTIONS = {'design': DirTable}
PINNED = {'design': ('connect.open', 'announce.clear', 'notice.close')}

BOUNDS = {
    # one seed directory (on machine 1); one resource on machines 0 and 2; one fault of any kind; one move
    'r1': dict(names=1, dirs=(1,), faults=1, moves=1),
    # one seed directory; two faults; no move
    'r2': dict(names=1, dirs=(1,), faults=2, moves=0),
    # two seed directories (machines 0 and 1); one fault; one move
    'd2': dict(names=1, dirs=(0, 1), faults=1, moves=1),
    # one seed directory; two resources; one fault; one move
    'n2': dict(names=2, dirs=(1,), faults=1, moves=1),
    # one seed directory; two faults; one move
    'r2m': dict(names=1, dirs=(1,), faults=2, moves=1),
}
SWEEP = ('r1', 'r2', 'n2')
VERIFY = ('r2m', 'd2')
VERIFY_PASS1 = True
