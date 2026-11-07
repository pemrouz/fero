"""
onebox.py: founding on one box from a run folder, and the stale-folder rule.
E-33.

DESIGN-V5 4.2: "On one box, the first process of a project's run creates
`cluster-id` in the run's folder under `.fero/` with an exclusive create, and
is #meta's only voter. Everyone else joins ... A process that finds
`cluster-id` but reaches no member within `connect.wait` waits ... If no dir
in the run folder holds any of the cluster's #meta, and none is still locked
by a live process (the dirs were wiped), the file is stale. The process
renames it aside, says so, and founds a new cluster with a new id."

THE WORLD (not counted). Four processes of one project's run on one box
(they always reach each other while up). The run folder holds the
`cluster-id` file (an id, or none) and one dir per process. A dir holds an
id (or nothing) and whether it holds a #meta replica; it is locked while
its process is up. A dir can be briefly unreadable (a fault), and becomes
readable again with time. Ghosts: `wrote` (ids with a committed write).

FAULTS (budget): crash (the process stops; its dir stays, unlocked), wipe
(a stopped process's dir is deleted), unreadable (one dir cannot be read
for a moment). RECOVER (free): a process starts. TICK (a timer that always fires, so
calm here): the dir is readable again; `connect.wait` passes (the stale
check runs on it).

PROPERTIES
  G1  one cluster per project: never two ids that each have a committed
      client write and a dir still holding them.
  G2  AG EF: from every state where every process is up and every dir is
      readable, calm steps reach a state where every process can commit a
      write (its dir holds the file's id, and a majority of that id's #meta
      replicas is up). A joining process becomes a #meta replica while #meta
      has fewer than three (healing grows one-box #meta from one voter to
      three as members arrive); a fourth member holds no #meta replica.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

P = 4
META = 3           # #meta has at most three voters; a fourth member holds no #meta replica
FIELDS = ('proc', 'file', 'minted', 'unread', 'wrote', 'faults')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()
NODIR = (0, False)


class OneBox:
    CALM = ('deliver', 'tick')
    INFO = ()

    def __init__(self, bound):
        self.b = bound
        self.budget = bound['faults']
        self.kinds = set(bound.get('kinds', ('crash', 'wipe', 'unreadable')))

    def init(self):
        # every process down at first, no dirs, no file (a fresh run)
        procs = tuple((False, NODIR) for _ in range(P))
        return (procs, 0, 0, E, E, 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[f] for f in FIELDS)

    @staticmethod
    def did(st, p):
        return st[0][p][1][0]

    @staticmethod
    def meta_of(st, c):
        """The processes whose dir holds c's #meta replica."""
        return [q for q in range(P) if st[0][q][1] == (c, True)]

    def can_write_id(self, st, c):
        holders = self.meta_of(st, c)
        return 2 * sum(1 for q in holders if st[0][q][0]) > len(holders) > 0

    def can_write(self, st, p):
        c = self.did(st, p)
        holders = self.meta_of(st, c)
        return (st[0][p][0] and c != 0 and c == st[1]
                and 2 * sum(1 for q in holders if st[0][q][0]) > len(holders))

    def world(self, st):
        out = []
        procs, file, minted, unread, wrote, faults = st
        for p in range(P):
            up, d = procs[p]
            if faults < self.budget:
                if up and 'crash' in self.kinds:
                    out.append((('crash', p), 'fault', self._proc(st, p, (False, d), 1)))
                if not up and d != NODIR and 'wipe' in self.kinds:
                    out.append((('wipe', p), 'fault', self._proc(st, p, (False, NODIR), 1, unread - {p})))
                if d != NODIR and p not in unread and 'unreadable' in self.kinds:
                    out.append((('unreadable', p), 'fault', self._set(st, unread=unread | {p}, faults=faults + 1)))
            if not up:
                out.append((('start', p), 'recover', self._proc(st, p, (True, d), 0)))
            if p in unread:
                out.append((('readable', p), 'tick', self._set(st, unread=unread - {p})))
            # clients write through any up process whose cluster can commit
            # (the world, not a rule; the ghost `wrote` records the id)
            c = self.did(st, p)
            if up and c and self.can_write_id(st, c) and c not in wrote:
                out.append((('write', p), 'deliver', self._set(st, wrote=wrote | {c})))
        return out

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return tuple(d[f] for f in FIELDS)

    def _proc(self, st, p, v, f, unread=None):
        procs = list(st[0])
        procs[p] = v
        kw = dict(proc=tuple(procs), faults=st[5] + f)
        if unread is not None:
            kw['unread'] = unread
        return self._set(st, **kw)

    def check(self, st):
        live = [c for c in st[IX['wrote']] if any(self.did(st, q) == c for q in range(P))]
        return ['G1'] if len(live) > 1 else []

    def check_edge(self, s, lab, kind, t):
        return []

    def goals(self, st):
        # every process of the run is up, in the file's cluster, and that
        # cluster can commit
        return {'G2': all(self.can_write(st, p) for p in range(P))}


    def judged(self, st):
        return {'G2': all(st[0][p][0] for p in range(P)) and not st[IX['unread']]}

    def actions(self):
        def ups(w, st):
            for p in range(P):
                if st[0][p][0]:
                    yield {'p': p}

        def ups_mint(w, st):
            if st[IX['minted']] >= 3:
                return                     # a bound, not a rule: three ids at most
            yield from ups(w, st)

        def pairs(w, st):
            for p in range(P):
                for q in range(P):
                    if p != q and st[0][p][0] and st[0][q][0]:
                        yield {'p': p, 'q': q}

        def set_dir(st, d, p, v):
            procs = list(d.f['proc'])
            procs[p] = (procs[p][0], v)
            d.f['proc'] = tuple(procs)

        def create(w, st, b, d):
            c = st[IX['minted']] + 1
            d.f['minted'] = c
            d.f['file'] = c
            set_dir(st, d, b['p'], (c, True))

        def join(w, st, b, d):
            # it joins, and healing makes it a #meta replica (one-box #meta
            # starts with one voter and grows to three as members arrive)
            c = st[IX['file']]
            set_dir(st, d, b['p'], (c, len(w.meta_of(st, c)) < META))

        def wr(w, st, b, d):
            d.f['wrote'] = st[IX['wrote']] | {w.did(st, b['p'])}

        def holds_meta_or_unreadable(w, st, c):
            return [q for q in range(P) if st[0][q][1] == (c, True) or q in st[IX['unread']]]

        return [
            # the first process of the run: an exclusive create of cluster-id
            Action('create', 'deliver', ups_mint, [
                Guard('nofile', lambda w, st, b: st[IX['file']] == 0, role='found',
                      note='the exclusive create succeeds only if no cluster-id file exists'),
                Guard('nodir', lambda w, st, b: w.did(st, b['p']) == 0, role='found',
                      note='its own dir holds no id'),
            ], [Update('create', create, role='found', note="it mints the id and is #meta's only voter")]),
            # everyone else joins through a member that holds the file's id
            Action('join', 'deliver', pairs, [
                Guard('nodir', lambda w, st, b: w.did(st, b['p']) == 0, role='join'),
                Guard('member', lambda w, st, b: st[IX['file']] != 0 and w.did(st, b['q']) == st[IX['file']],
                      role='join', note='it reaches a member of the cluster the file names'),
            ], [Update('join', join, role='join')]),
            # connect.wait passed with no member reached: the stale check
            Action('stale', 'tick', ups_mint, [
                Guard('file', lambda w, st, b: st[IX['file']] != 0, role='stale'),
                Guard('nodir', lambda w, st, b: w.did(st, b['p']) == 0, role='stale',
                      note='its own dir holds no id of the file (else it is a member and waits)'),
                Guard('nomember', lambda w, st, b: not any(st[0][q][0] and w.did(st, q) == st[IX['file']]
                                                             for q in range(P)), role='stale',
                      note='it reaches no member within connect.wait'),
                Guard('nometa', lambda w, st, b: not [q for q in w.meta_of(st, st[IX['file']])
                                                      if q not in st[IX['unread']]], role='stale',
                      note="no dir it can read holds the cluster's #meta"),
                Guard('unlocked', lambda w, st, b: not any(st[0][q][0] and w.did(st, q) != 0 for q in range(P)),
                      role='stale', note='no dir is still locked by a live process'),
                Guard('readable', lambda w, st, b: not st[IX['unread']], role='stale',
                      note='a dir it cannot read may hold #meta: then the file is not stale'),
            ], [Update('refound', create, role='stale', note='rename the file aside and found with a new id')]),
        ]


OPTIONS = {'draft': OneBox}
# Pinned: a process joins only through a member of the cluster (the member's
# leader adds it: Raft's membership change). That is how joining works, not a
# rule of the design; without it a process "joins" a cluster no one serves.
PINNED = {'draft': ('join.member',)}

BOUNDS = {
    'one1': dict(faults=1),
    'one2': dict(faults=2),
    'one3': dict(faults=3),
}
SWEEP = ('one1', 'one2', 'one3')
VERIFY = ()
