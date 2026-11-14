"""
found.py: founding each resource by itself, with no #meta. E-51.

DECISIONS V5-2 (5): a project is machines plus a name lookup; it has no
genesis of its own. Each resource is founded on its first open by E-33's
`objcas` rule, run once per resource: the opener whose create-if-absent of
the resource's id in the object store succeeds founds the resource's home
group as its only voter, with the id and the settings record as its first
entry; every other opener adopts the stored id and joins as a copy
(simplicity.json genesis-conditional-create@per-resource). Here the opener
first writes a candidate id to its own disk, then asks the store to create
that id, then compares the stored id with its candidate (skeptic F1: the
created id held in memory, or written to disk only once the create
answers, is lost by one crash; the `objcas-mem` and `objcas-after` probes).
The settings record holds the first open's options, and a later open whose
options differ is refused (meta-catalog@per-resource rule 1). The seed is
applied once, and the settings record marks it applied in the same entry
(rule 4); a copy that opens later may apply its seed if the record says it
is not applied (`reseed`, the path the ablation tests).

THE WORLD (not counted). Three machines, each up or down, on side 0 or 1
(links join machines on one side). One or two resource names (two, so
isolation between resources can fail). Per machine and name, its dir holds
nothing, or an id with one of three states: CAND (a candidate id the
opener wrote to its disk before it asked the store to create it; it
stays a candidate until the opener has compared it with the stored id
and written the home group's first entry, or dropped it), KNOWN (it
adopted the stored id and is not a copy yet), REP (a copy: it holds the
home group's log, as a voter or a learner). A candidate's id gets its
number when the store holds it (the id itself was fixed when it was
written: the number is only how the model names it). Healing adds a
joiner as a learner and grows the group from one voter straight to three
once two learners are live (DESIGN-V5 4.2; a world step: E-16's and
E-14c's rules). The object store maps a key to an id, by create-if-absent
(S3's If-None-Match). A home group commits when a majority of its voters
are up, linked and hold a copy (Raft, abstract, as in E-33). Each opener
opens with options: the same everywhere, except the (machine, name) pairs
a bound marks as different (an older or changed build). Ghosts: the name
each id was minted for, the first open's options per id, how often each
id's seed was applied, whether a seed landed after a client write, the
ids under which a client write committed, and the ids a holder lost its
disk with.

E-33 took the create and the first entry as one atomic step. A real
opener does a store round trip and then writes its log, and a crash can
fall between them, so here founding is four steps: write a candidate id
to disk (`cand`), ask the store to create it (`put`), compare the stored
id with the candidate, then write the first entry (`first`) or drop the
candidate and adopt the stored id (`drop`, then `adopt`). The comparison
is what a restarted opener does: it does not know whether its create
went through, so it reads the store.

FAULTS (budget): crash (down, dir kept), wipe (down, dir gone), cut (moves to
side 1). RECOVER (free): start, heal the cut. Client writes are world steps
(deliver) under any id whose group can commit.

PROPERTIES
  G1    one id per resource: never two ids minted for one name that each
        have a committed client write and a copy still holding them (E-33's
        G1, per resource).
  ISO   isolation: a machine's dir for name r holds only an id minted for r.
  CAT1  every copy of an id runs the options of that id's first open.
  SEED  each id's seed is applied at most once, and never after a client
        write under that id (it would overwrite the write).
  G2    AG EF, founding completes, per name: from every state with a
        majority of machines up and linked on one side, where every id of
        that name that still has a holder (a copy, or an opener whose stored
        candidate has not yet been founded) has one up there, calm steps reach a state
        where the stored id's home group commits on that side, every up
        machine there whose options match the first open's is a copy, and
        the seed is applied. A stored id with no holder left because a
        holder's disk was lost is F-12 (a lost majority: the operator
        restores or clears it) and not judged, nor
        is a state where the home group has no live majority there (a wait,
        as E-16 judges P5 and P8).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

S = 3
CAND, KNOWN, REP, MEM = 'cand', 'known', 'rep', 'mem'
FIELDS = ('mach', 'dir', 'store', 'minted', 'idname', 'fopts', 'voters', 'sett', 'seedn', 'seeded',
          'wrote', 'late', 'lost', 'faults')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()


def _put(t, i, v):
    t = list(t)
    t[i] = v
    return tuple(t)


class Found:
    CALM = ('deliver', 'time')
    INFO = ()
    CANDKIND = CAND          # the candidate is on disk from the start
    FIRST_KINDS = (CAND,)    # which candidates may found

    def __init__(self, bound):
        self.b = bound
        self.NR = bound.get('names', 2)
        self.budget = bound['faults']
        self.kinds = set(bound.get('kinds', ('crash', 'wipe', 'cut')))
        self.diff = set(bound.get('diff', ()))
        self.maxid = bound.get('maxid', self.NR + 1)

    def opts(self, m, r):
        return 'B' if (m, r) in self.diff else 'A'

    def init(self):
        mach = tuple((m not in self.b.get('down', ()), 0) for m in range(S))
        dirs = tuple(tuple(0 for _ in range(self.NR)) for _ in range(S))
        return (mach, dirs, tuple(None for _ in range(self.NR)), 0, (), (), (), (), (), (), E, E, E, 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[f] for f in FIELDS)

    # ---- views
    @staticmethod
    def up(st, m):
        return st[0][m][0]

    @staticmethod
    def side(st, m):
        return st[0][m][1]

    @staticmethod
    def ent(st, m, r):
        return st[1][m][r]

    def holds(self, st, m, c, kinds=(REP,)):
        for r in range(self.NR):
            e = st[1][m][r]
            if e and e[0] == c and e[1] in kinds:
                return True
        return False

    def can_write(self, st, c, side=None):
        if not (1 <= c <= st[IX['minted']]):
            return False
        vs = st[IX['voters']][c - 1]
        if not vs:
            return False
        for s in ((0, 1) if side is None else (side,)):
            n = sum(1 for q in vs if self.up(st, q) and self.side(st, q) == s and self.holds(st, q, c))
            if 2 * n > len(vs):
                return True
        return False

    def surviving(self, st, c):
        return any(self.holds(st, q, c, (REP, CAND, MEM)) for q in range(S))

    # ---- world steps
    def world(self, st):
        out = []
        mach, faults = st[0], st[IX['faults']]
        for m in range(S):
            up, side = mach[m]
            if faults < self.budget:
                if up and 'crash' in self.kinds:
                    out.append((('crash', m), 'fault', self._mach(st, m, (False, side), 1)))
                if 'wipe' in self.kinds and any(st[1][m]):
                    t = self._mach(st, m, (False, side), 1)
                    gone = frozenset(e[0] for e in st[1][m] if e and e[0])
                    out.append((('wipe', m), 'fault', self._set(t, dir=_put(t[1], m, tuple(0 for _ in range(self.NR))),
                                                                 lost=st[IX['lost']] | gone)))
                if up and side == 0 and 'cut' in self.kinds:
                    out.append((('cut', m), 'fault', self._mach(st, m, (up, 1), 1)))
            if not up:
                out.append((('start', m), 'recover', self._mach(st, m, (True, side), 0)))
            if side == 1:
                out.append((('heal', m), 'recover', self._mach(st, m, (up, 0), 0)))
        for c in range(1, st[IX['minted']] + 1):
            if c not in st[IX['wrote']] and self.can_write(st, c):
                out.append((('write', c), 'deliver', self._set(st, wrote=st[IX['wrote']] | {c})))
            # healing grows a home group from one voter straight to three
            # (DESIGN-V5 4.2: never two voters; joint consensus makes the
            # step atomic): a world step, E-16's and E-14c's rules
            vs = st[IX['voters']][c - 1]
            if len(vs) == 1:
                (v,) = tuple(vs)
                if self.up(st, v) and self.holds(st, v, c):
                    ls = [q for q in range(S) if q != v and self.up(st, q) and
                          self.side(st, q) == self.side(st, v) and self.holds(st, q, c)]
                    if len(ls) >= 2:
                        nv = _put(st[IX['voters']], c - 1, frozenset([v] + ls[:2]))
                        out.append((('grow', c), 'deliver', self._set(st, voters=nv)))
        return out

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return tuple(d[x] for x in FIELDS)

    def _mach(self, st, m, v, f):
        return self._set(st, mach=_put(st[0], m, v), faults=st[IX['faults']] + f)

    # ---- properties
    def check(self, st):
        bad = []
        names = st[IX['idname']]
        for r in range(self.NR):
            live = [c for c in st[IX['wrote']] if names[c - 1] == r and self.surviving(st, c)]
            if len(live) > 1:
                bad.append('G1')
                break
        for m in range(S):
            for r in range(self.NR):
                e = st[1][m][r]
                if e and e[0] >= 1 and names[e[0] - 1] != r:
                    bad.append('ISO')
                    break
            else:
                continue
            break
        fo = st[IX['fopts']]
        for m in range(S):
            for r in range(self.NR):
                e = st[1][m][r]
                if e and e[1] == REP and e[0] >= 1 and self.opts(m, r) != fo[e[0] - 1]:
                    bad.append('CAT1')
                    break
            else:
                continue
            break
        if any(n > 1 for n in st[IX['seedn']]) or st[IX['late']]:
            bad.append('SEED')
        return bad

    def check_edge(self, s, lab, kind, t):
        return []

    def judged_side(self, st, r, s):
        up = [q for q in range(S) if self.up(st, q) and self.side(st, q) == s]
        if 2 * len(up) <= S:
            return False
        c = st[IX['store']][r]
        if c is not None and not self.surviving(st, c) and c in st[IX['lost']]:
            return False                      # F-12: the stored id's holders lost their disks
        if c is not None:
            vs = st[IX['voters']][c - 1]
            if vs and 2 * sum(1 for q in vs if q in up and self.holds(st, q, c)) <= len(vs):
                return False                  # no live majority of its home group here: a wait (E-16's P5)
        for c2 in range(1, st[IX['minted']] + 1):
            if st[IX['idname']][c2 - 1] == r and self.surviving(st, c2) and \
                    not any(self.holds(st, q, c2, (REP, CAND, MEM)) for q in up):
                return False
        return True

    def goal(self, st, r):
        c = st[IX['store']][r]
        if c is None or st[IX['seedn']][c - 1] < 1:
            return False
        fo = st[IX['fopts']][c - 1]
        for s in (0, 1):
            if not self.can_write(st, c, s):
                continue
            if all(self.ent(st, q, r) == (c, REP) for q in range(S)
                   if self.up(st, q) and self.side(st, q) == s and self.opts(q, r) == fo):
                return True
        return False

    def goals(self, st):
        return {f'G2.{r}': self.goal(st, r) for r in range(self.NR)}

    def judged(self, st):
        return {f'G2.{r}': any(self.judged_side(st, r, s) for s in (0, 1)) for r in range(self.NR)}

    # ---- the rules (counted)
    def actions(self):
        w = self

        def mr(w, st):
            for m in range(S):
                if st[0][m][0]:
                    for r in range(w.NR):
                        yield {'m': m, 'r': r}

        def cands(kinds, mints=True):
            def gen(w, st):
                for m in range(S):
                    if st[0][m][0]:
                        for r in range(w.NR):
                            e = st[1][m][r]
                            if e and e[1] in kinds:
                                if mints and e[0] == 0 and st[IX['minted']] >= w.maxid:
                                    continue           # a bound: ids minted per run
                                yield {'m': m, 'r': r, 'c': e[0]}
            return gen

        def keepcand(w, st, b, d):
            d.f['dir'] = _put(d.f['dir'], b['m'], _put(d.f['dir'][b['m']], b['r'], (0, w.CANDKIND)))

        def mint(w, st, d, m, r):
            # number a candidate's id (its value was fixed when it was written)
            c = d.f['minted'] + 1
            d.f['minted'] = c
            d.f['idname'] = d.f['idname'] + (r,)
            d.f['fopts'] = d.f['fopts'] + (w.opts(m, r),)
            d.f['voters'] = d.f['voters'] + (E,)
            d.f['sett'] = d.f['sett'] + (None,)
            d.f['seedn'] = d.f['seedn'] + (0,)
            d.f['seeded'] = d.f['seeded'] + (False,)
            return c

        def unstored(w, st):
            for x in cands((CAND, MEM))(w, st):
                if x['c'] == 0:
                    yield x

        def create(w, st, b, d):
            c = mint(w, st, d, b['m'], b['r'])
            d.f['store'] = _put(d.f['store'], b['r'], c)
            kind = st[1][b['m']][b['r']][1]
            d.f['dir'] = _put(d.f['dir'], b['m'], _put(d.f['dir'][b['m']], b['r'], (c, kind)))

        def cid(w, st, b, d):
            c = b['c'] or d.f['dir'][b['m']][b['r']][0]
            if not c:
                raise ValueError('no id')       # an update order no design has (reported as ERR)
            return c

        def group(w, st, b, d):
            c = b['c'] or mint(w, st, d, b['m'], b['r'])   # founding on a candidate the store never took
            d.f['voters'] = _put(d.f['voters'], c - 1, frozenset([b['m']]))
            d.f['dir'] = _put(d.f['dir'], b['m'], _put(d.f['dir'][b['m']], b['r'], (c, REP)))

        def settings(w, st, b, d):
            d.f['sett'] = _put(d.f['sett'], cid(w, st, b, d) - 1, w.opts(b['m'], b['r']))

        def seedrows(w, st, b, d):
            c = cid(w, st, b, d)
            d.f['seedn'] = _put(d.f['seedn'], c - 1, min(2, d.f['seedn'][c - 1] + 1))
            if c in st[IX['wrote']]:
                d.f['late'] = d.f['late'] | {c}

        def seedmark(w, st, b, d):
            d.f['seeded'] = _put(d.f['seeded'], cid(w, st, b, d) - 1, True)

        def dropcand(w, st, b, d):
            d.f['dir'] = _put(d.f['dir'], b['m'], _put(d.f['dir'][b['m']], b['r'], 0))

        def adopts(w, st):
            for m in range(S):
                if st[0][m][0]:
                    for r in range(w.NR):
                        for k in range(w.NR):
                            yield {'m': m, 'r': r, 'k': k}

        def adopt(w, st, b, d):
            c = st[IX['store']][b['k']]
            d.f['dir'] = _put(d.f['dir'], b['m'], _put(d.f['dir'][b['m']], b['r'], (c or 0, KNOWN)))

        def joins(w, st):
            for m in range(S):
                if not st[0][m][0]:
                    continue
                for r in range(w.NR):
                    e = st[1][m][r]
                    if e and e[1] == KNOWN and e[0] >= 1 and w.can_write(st, e[0], w.side(st, m)):
                        yield {'m': m, 'r': r, 'c': e[0]}

        def add(w, st, b, d):
            c = b['c']
            d.f['dir'] = _put(d.f['dir'], b['m'], _put(d.f['dir'][b['m']], b['r'], (c, REP)))

        def copies(w, st):
            for m in range(S):
                if not st[0][m][0]:
                    continue
                for r in range(w.NR):
                    e = st[1][m][r]
                    if e and e[1] == REP and w.can_write(st, e[0], w.side(st, m)):
                        yield {'m': m, 'r': r, 'c': e[0]}

        return [
            Action('cand', 'deliver', mr, [
                Guard('noid', lambda w, st, b: st[1][b['m']][b['r']] == 0, role='genesis',
                      note='an opener makes a candidate only while its dir holds no id for this name'),
            ], [
                Update('keep', keepcand, role='genesis',
                       note='the opener writes a fresh candidate id to its disk BEFORE it asks the store to create it'),
            ]),
            Action('put', 'deliver', unstored, [
                Guard('absent', lambda w, st, b: st[IX['store']][b['r']] is None, role='genesis',
                      note="If-None-Match: the create succeeds only while no id is stored under the project and this name"),
            ], [
                Update('create', create, role='genesis', note='the store keeps the candidate as the resource id'),
            ]),
            Action('first', 'deliver', cands(w.FIRST_KINDS), [
                Guard('mine', lambda w, st, b: st[IX['store']][b['r']] == b['c'], role='genesis',
                      note='it founds only if the stored id is its own candidate (from the create\'s answer, or read back after a restart)'),
            ], [
                Update('group', group, role='genesis',
                       note="found the home group as its only voter, the id in its first entry (found.create)"),
                Update('settings', settings, role='catalog',
                       note='the first entry carries the settings record (the first open\'s options)'),
                Update('seed', seedrows, role='catalog', note='the first entry applies the seed rows'),
                Update('mark', seedmark, role='catalog', note='the settings record marks the seed applied, in the same entry'),
            ]),
            Action('drop', 'deliver', cands((CAND, MEM), mints=False), [
                Guard('other', lambda w, st, b: st[IX['store']][b['r']] not in (None, b['c']), role='genesis',
                      note='a stored id that is not its candidate: it lost the race'),
            ], [
                Update('drop', dropcand, role='genesis', note='it drops its candidate (and adopts the stored id: adopt)'),
            ]),
            Action('adopt', 'deliver', adopts, [
                Guard('noid', lambda w, st, b: st[1][b['m']][b['r']] == 0, role='genesis'),
                Guard('key', lambda w, st, b: b['k'] == b['r'], role='genesis',
                      note='it reads the id under its own project and name, not another key'),
                Guard('stored', lambda w, st, b: st[IX['store']][b['k']] is not None, role='genesis',
                      note='an id is stored there'),
            ], [Update('adopt', adopt, role='genesis', note='keep the stored id in its dir (adopt.adopt)')]),
            Action('join', 'deliver', joins, [
                Guard('same', lambda w, st, b: w.opts(b['m'], b['r']) == st[IX['sett']][b['c'] - 1], role='catalog',
                      note="a later open whose options differ from the settings record is refused"),
            ], [Update('add', add, role='heal', note="healing adds it as a copy, a learner (E-16's rules; pinned)")]),
            Action('reseed', 'deliver', copies, [
                Guard('unseeded', lambda w, st, b: not st[IX['seeded']][b['c'] - 1], role='catalog',
                      note='a copy that opens with a seed applies it only if the record says it is not applied'),
            ], [
                Update('rows', seedrows, role='catalog'),
                Update('mark', seedmark, role='catalog'),
            ]),
        ]


class FoundMem(Found):
    """A probe, not a design: the opener keeps its candidate, and the id
    the store took, only in memory until its first entry is written, so a
    crash between the store create and the first entry loses it (E-33 took
    the two as one step)."""
    CANDKIND = MEM
    FIRST_KINDS = (MEM,)

    def world(self, st):
        out = []
        for lab, kind, t in super().world(st):
            if lab[0] == 'crash':
                m = lab[1]
                dm = tuple(0 if (e and e[1] == MEM) else e for e in t[1][m])
                t = self._set(t, dir=_put(t[1], m, dm))
            out.append((lab, kind, t))
        return out


class FoundAfter(FoundMem):
    """A probe, not a design: the first fix this page proposed, as a
    builder would write it: create in the store, and when the create
    answers, write the created id to disk (`persist`, its own step), then
    the first entry. A crash between the answer and the disk write loses
    the id, as in objcas-mem."""
    FIRST_KINDS = (CAND,)

    def actions(self):
        def mems(w, st):
            for m in range(S):
                if st[0][m][0]:
                    for r in range(w.NR):
                        e = st[1][m][r]
                        if e and e[1] == MEM and e[0] >= 1:
                            yield {'m': m, 'r': r, 'c': e[0]}

        def persist(w, st, b, d):
            d.f['dir'] = _put(d.f['dir'], b['m'], _put(d.f['dir'][b['m']], b['r'], (b['c'], CAND)))

        return super().actions() + [
            Action('persist', 'deliver', mems, [], [
                Update('disk', persist, role='genesis', note='after the create answers, write the created id to disk')]),
        ]


OPTIONS = {'objcas': Found, 'objcas-mem': FoundMem, 'objcas-after': FoundAfter}
PINNED = {k: ('join.add',) for k in OPTIONS}

BOUNDS = {
    # one name, machines start down in any order, one fault
    'one1': dict(names=1, faults=1, down=(0, 1, 2)),
    # two names (isolation), every machine up, no fault
    'two0': dict(names=2, faults=0),
    # two names, every machine up, one fault
    'two1': dict(names=2, faults=1),
    # one name, machine 2 opens with other options, one fault
    'diff1': dict(names=1, faults=1, down=(0, 1, 2), diff=((2, 0),)),
    # one name, two faults (E-33's any2)
    'one2': dict(names=1, faults=2, down=(0, 1, 2)),
    # two names, machines start down, other options on machine 2 for name 0, two faults
    'two2': dict(names=2, faults=2, down=(0, 1, 2), diff=((2, 0),)),
}
SWEEP = ('one1', 'two0', 'diff1')
VERIFY = ('one2', 'two1')
VERIFY_PASS1 = True
