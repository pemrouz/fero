"""
genesis.py: founding a cluster across boxes from a `seeds` list. E-33.

DESIGN-V5 4.2, "Clusters, genesis and discovery": "Across boxes, the
founding members start with the same `seeds` list, which becomes #meta's
first voters. A seed founds only when it reaches a majority of the seeds and
none of them has a cluster id. They then hold #meta's first election, and
the winner's first entry carries the cluster id it mints; no seed takes
client traffic before it has applied that entry. A seed restarted without
its dir finds a cluster id at another seed, and joins as a new replica. ...
A process that has a one-box `cluster-id` file never founds from `seeds`:
the file wins, and it joins that cluster or waits."

THE WORLD (not counted). Three seeds, each up or down, on side 0 or 1 (links
join seeds on one side), with a dir that holds nothing, or an applied
cluster id c and whether it holds a replica of c's #meta (a voter that took
part in c's commits) or only knows the id. #meta's first election and its
first entry are one atomic step (`found`): Raft's own one-leader-per-term
and majority commit are E-14's; what this model asks is whether the
founding rule picks one id. A write commits under c when a majority of the
c's #meta voters hold replicas of it, up and linked (Raft). A founding by
seeds makes the seeds list #meta's first voters; an object-store founding
starts #meta with one voter, and healing adds members as they join. A seed that learns c from
another seed becomes a replica only through a working c (Raft's membership
change needs c's majority); otherwise it knows the id and waits, and a world
step makes it a replica once c works. Ghosts: `wrote`, the ids under which a
client write committed; `minted`.

FAULTS (budget): crash (down, dir kept), wipe (down, the dir is gone: the
seed restarts without it), cut (the seed moves to side 1). RECOVER (free):
up again, linked again. TIME: none needed here.

OPTIONS
  draft      the text above: found on a majority of reached seeds with no id.
  unanimous  found only when every seed is reached and none has an id.
  init       an explicit `fero init`: seeds never found by themselves; an
             operator step founds once (CockroachDB's `cockroach init`).
  objcas     the cluster id is created in the object store by a conditional
             PUT (If-None-Match: *); a seed founds only if that create
             succeeds, else adopts the stored id. MIN's family already
             requires an object store across boxes (SPACE 4.1, footnote 1).

PROPERTIES
  G1   one cluster per project: never two ids that each have a committed
       client write and a replica still holding them.
  G1s  (strict, reported) at most one id ever commits a client write.
  G2   AG EF, founding completes: from every state where a majority of
       seeds is up and linked (and, for `init`, the operator has run init),
       and every id that still has a replica has one among them, calm steps
       reach a state where a majority of the seeds, up and linked, have
       applied one id. (A cluster whose replicas are all down or cut off is
       waited for: founding another would break G1.)
  G2all  the same, judged only once every seed is up and linked: the
       weaker promise `unanimous` makes (its ablation uses it; G2 is
       then reported, not a failure).
"""

import itertools
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

S = 3
MAXID = 3          # a bound, not a rule: ids minted per run
FIELDS = ('seed', 'minted', 'wrote', 'faults', 'osid', 'inited', 'voters')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()


class Genesis:
    CALM = ('deliver', 'time')
    INFO = ('G2all',)          # reported; G2 (a majority up) is the property

    def __init__(self, bound):
        self.b = bound
        self.budget = bound['faults']
        self.kinds = set(bound.get('kinds', ('crash', 'wipe', 'cut')))

    def init(self):
        seeds = []
        for p in range(S):
            d = 0
            if p in self.b.get('onebox', ()):
                d = 1                      # an id from an earlier one-box run
            seeds.append((p not in self.b.get('down', ()), 0, (d, True) if d else 0))
        minted = 1 if self.b.get('onebox') else 0
        wrote = frozenset([1]) if self.b.get('onebox') else E
        voters = ((frozenset([0]),) if self.b.get('onebox') else ())   # one-box #meta: one voter
        return (tuple(seeds), minted, wrote, 0, None, False, voters)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[f] for f in FIELDS)

    # views
    @staticmethod
    def reach(st, p):
        """The seeds p reaches now (itself included), if p is up."""
        up, side, _ = st[0][p]
        if not up:
            return []
        return [q for q in range(S) if st[0][q][0] and st[0][q][1] == side]

    @staticmethod
    def dir(st, p):
        d = st[0][p][2]
        return d[0] if d else 0

    @staticmethod
    def isrep(st, p, c):
        return st[0][p][2] == (c, True)

    @staticmethod
    def voters_of(st, c):
        """c's #meta voters (Raft's config): the seeds list for a founding
        by seeds, or the members added since (objcas, one box)."""
        v = st[IX['voters']]
        return v[c - 1] if 0 < c <= len(v) else frozenset()

    def can_write(self, st, c):
        vs = self.voters_of(st, c)
        for s in (0, 1):
            n = sum(1 for q in vs if st[0][q][0] and st[0][q][1] == s and self.isrep(st, q, c))
            if vs and 2 * n > len(vs):
                return True
        return False

    # world steps
    def world(self, st):
        out = []
        seeds, minted, wrote, faults, osid, inited, voters = st
        for p in range(S):
            up, side, d = seeds[p]
            if faults < self.budget:
                if up and 'crash' in self.kinds:
                    out.append((('crash', p), 'fault', self._seed(st, p, (False, side, d), 1)))
                if 'wipe' in self.kinds and d != 0:
                    out.append((('wipe', p), 'fault', self._seed(st, p, (False, side, 0), 1)))
                if up and side == 0 and 'cut' in self.kinds:
                    out.append((('cut', p), 'fault', self._seed(st, p, (up, 1, d), 1)))
            if not up and p not in self.b.get('never', ()):
                out.append((('start', p), 'recover', self._seed(st, p, (True, side, d), 0)))
            # Raft membership: a seed that knows id c but holds no replica of
            # it is added as a replica once c works and reaches it
            if up and d and not d[1] and self.can_write(st, d[0]) and \
                    any(self.isrep(st, q, d[0]) and seeds[q][0] and seeds[q][1] == side for q in range(S)):
                t = self._seed(st, p, (up, side, (d[0], True)), 0)
                vs = list(voters)
                vs[d[0] - 1] = vs[d[0] - 1] | {p}       # healing adds it to #meta's voters
                out.append((('add-replica', p), 'deliver', self._set(t, voters=tuple(vs))))
            if side == 1:
                out.append((('heal', p), 'recover', self._seed(st, p, (up, 0, d), 0)))
        # clients write through any up seed whose cluster can commit (the
        # world, not a rule; the ghost `wrote` records the id)
        for p in range(S):
            c = self.dir(st, p)
            if seeds[p][0] and c and self.can_write(st, c) and c not in wrote:
                out.append((('write', p), 'deliver', self._set(st, wrote=wrote | {c})))
        return out

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return tuple(d[x] for x in FIELDS)

    def _seed(self, st, p, v, f):
        seeds = list(st[0])
        seeds[p] = v
        d = self.to_draft(st)
        d['seed'] = tuple(seeds)
        d['faults'] = st[3] + f
        return tuple(d[x] for x in FIELDS)

    # properties
    def surviving(self, st, c):
        return any(self.isrep(st, q, c) for q in range(S))

    def check(self, st):
        bad = []
        live = [c for c in st[2] if self.surviving(st, c)]
        if len(live) > 1:
            bad.append('G1')
        return bad

    def check_edge(self, s, lab, kind, t):
        return []

    def founded(self, st):
        for s in (0, 1):
            for c in range(1, st[1] + 1):
                n = sum(1 for q in range(S) if st[0][q][0] and st[0][q][1] == s and self.dir(st, q) == c)
                if 2 * n > S:
                    return True
        return False

    def judged_side(self, st, s):
        up = [q for q in range(S) if st[0][q][0] and st[0][q][1] == s]
        if 2 * len(up) <= S:
            return False
        for c in range(1, st[1] + 1):
            if self.surviving(st, c) and not any(self.isrep(st, q, c) for q in up):
                return False
        return True

    def goals(self, st):
        ok = self.founded(st)
        return {'G2': ok, 'G2all': ok}

    def judged(self, st):
        lm = any(self.judged_side(st, s) for s in (0, 1))
        al = all(st[0][q][0] and st[0][q][1] == st[0][0][1] for q in range(S)) and self.judged_side(st, st[0][0][1])
        return {'G2': lm and self.judge_extra(st), 'G2all': al and self.judge_extra(st)}

    def judge_extra(self, st):
        return True

    # shared actions: join, write
    def common(self):
        def pairs(w, st):
            for p in range(S):
                for q in w.reach(st, p):
                    if q != p:
                        yield {'p': p, 'q': q}

        def adopt(w, st, b, d):
            seeds = list(d.f['seed'])
            up, side, _ = seeds[b['p']]
            c = w.dir(st, b['q'])
            seeds[b['p']] = (up, side, (c, w.can_write(st, c)))
            d.f['seed'] = tuple(seeds)

        def ups(w, st):
            for p in range(S):
                if st[0][p][0]:
                    yield {'p': p}

        def wr(w, st, b, d):
            d.f['wrote'] = st[2] | {w.dir(st, b['p'])}

        return [
            Action('join', 'deliver', pairs, [
                Guard('noid', lambda w, st, b: w.dir(st, b['p']) == 0, role='join',
                      note='a seed with no id (new, or back without its dir)'),
                Guard('hasid', lambda w, st, b: w.dir(st, b['q']) != 0, role='join',
                      note='finds an id at a seed it reaches'),
            ], [Update('adopt', adopt, role='join')]),
        ]


def _mint(w, st, b, d, members):
    c = st[1] + 1
    d.f['minted'] = c
    d.f['voters'] = st[IX['voters']] + (frozenset(range(S)),)   # the seeds list: #meta's first voters
    seeds = list(d.f['seed'])
    for q in members:
        up, side, _ = seeds[q]
        seeds[q] = (up, side, (c, True))
    d.f['seed'] = tuple(seeds)


class Draft(Genesis):
    def actions(self):
        def ps(w, st):
            if st[1] >= MAXID:
                return                     # a bound: at most MAXID ids minted
            for p in range(S):
                if st[0][p][0]:
                    yield {'p': p}
        return [
            Action('found', 'deliver', ps, [
                Cmp('majority', lambda w, st, b: 2 * len(w.reach(st, b['p'])), '>', lambda w, st, b: S,
                    role='found', note='it reaches a majority of the seeds'),
                Guard('noid', lambda w, st, b: all(w.dir(st, q) == 0 for q in w.reach(st, b['p'])),
                      role='found', note='none of the seeds it reaches has a cluster id (its own dir included)'),
            ], [Update('mint', lambda w, st, b, d: _mint(w, st, b, d, w.reach(st, b['p'])), role='found',
                       note="#meta's first leader mints the id; it commits on the seeds reached")]),
        ] + self.common()


class Unanimous(Genesis):
    INFO = ('G2',)             # it cannot meet G2 by design; G2all is its own promise

    def actions(self):
        def ps(w, st):
            if st[1] >= MAXID:
                return                     # a bound: at most MAXID ids minted
            for p in range(S):
                if st[0][p][0]:
                    yield {'p': p}
        return [
            Action('found', 'deliver', ps, [
                Cmp('all', lambda w, st, b: len(w.reach(st, b['p'])), '>=', lambda w, st, b: S,
                    role='found', note='it reaches every seed'),
                Guard('noid', lambda w, st, b: all(w.dir(st, q) == 0 for q in w.reach(st, b['p'])),
                      role='found'),
            ], [Update('mint', lambda w, st, b, d: _mint(w, st, b, d, w.reach(st, b['p'])), role='found')]),
        ] + self.common()


class Init(Genesis):
    """`fero init`: the operator founds once (a control step). For G2 the
    operator is taken to act in the end (a control step counts as calm);
    the cost is the step itself (SC-02's "no setup" across boxes)."""
    CALM = ('deliver', 'time', 'control')

    def judge_extra(self, st):
        # after every replica of the founded cluster is lost, founding again
        # is the operator's call (init runs once), so those states are not
        # judged
        return st[IX['minted']] == 0 or any(self.surviving(st, c) for c in range(1, st[1] + 1))

    def actions(self):
        def ps(w, st):
            if st[1] >= MAXID:
                return                     # a bound: at most MAXID ids minted
            for p in range(S):
                if st[0][p][0]:
                    yield {'p': p}

        def upd(w, st, b, d):
            _mint(w, st, b, d, w.reach(st, b['p']))
            d.f['inited'] = True
        return [
            Action('init', 'control', ps, [
                Guard('once', lambda w, st, b: not st[IX['inited']], role='found',
                      note='the operator runs init once (the CLI refuses a second)'),
                Cmp('majority', lambda w, st, b: 2 * len(w.reach(st, b['p'])), '>', lambda w, st, b: S,
                    role='found', note='init waits until its seed reaches a majority of the seeds'),
                Guard('noid', lambda w, st, b: all(w.dir(st, q) == 0 for q in w.reach(st, b['p'])),
                      role='found', note='init refuses a seed that already has an id'),
            ], [Update('mint', upd, role='found')]),
        ] + self.common()


class ObjCas(Genesis):
    """The id is created in the object store by a conditional PUT."""

    def actions(self):
        def ps(w, st):
            if st[1] >= MAXID:
                return                     # a bound: at most MAXID ids minted
            for p in range(S):
                if st[0][p][0]:
                    yield {'p': p}

        def create(w, st, b, d):
            c = st[1] + 1
            d.f['minted'] = c
            d.f['osid'] = c
            d.f['voters'] = st[IX['voters']] + (frozenset([b['p']]),)   # #meta starts with one voter
            seeds = list(d.f['seed'])
            up, side, _ = seeds[b['p']]
            seeds[b['p']] = (up, side, (c, True))
            d.f['seed'] = tuple(seeds)

        def adopt(w, st, b, d):
            seeds = list(d.f['seed'])
            up, side, _ = seeds[b['p']]
            c = st[IX['osid']]
            seeds[b['p']] = (up, side, (c, w.can_write(st, c)))
            d.f['seed'] = tuple(seeds)
        return [
            Action('found', 'deliver', ps, [
                Guard('absent', lambda w, st, b: st[IX['osid']] is None, role='found',
                      note='If-None-Match: * succeeds only while no id is stored'),
                Guard('noid', lambda w, st, b: w.dir(st, b['p']) == 0, role='found',
                      note='its own dir holds no id (the one-box file wins)'),
            ], [Update('create', create, role='found')]),
            Action('adopt', 'deliver', ps, [
                Guard('noid', lambda w, st, b: w.dir(st, b['p']) == 0, role='join'),
                Guard('stored', lambda w, st, b: st[IX['osid']] is not None, role='join'),
            ], [Update('adopt', adopt, role='join')]),
        ] + self.common()


OPTIONS = {'draft': Draft, 'unanimous': Unanimous, 'init': Init, 'objcas': ObjCas}

BOUNDS = {
    # seeds start in any order (all down at first), one fault
    'any1': dict(faults=1, down=(0, 1, 2)),
    # two faults: a dir lost and a link cut
    'any2': dict(faults=2, down=(0, 1, 2)),
    # seed 0 already holds an id from a one-box run (with writes); one fault
    'onebox1': dict(faults=1, down=(0, 1, 2), onebox=(0,)),
    # three faults, crash and wipe only
    'any3': dict(faults=3, down=(0, 1, 2), kinds=('crash', 'wipe')),
}
SWEEP = ('any1', 'any2')
VERIFY = ('any3',)
