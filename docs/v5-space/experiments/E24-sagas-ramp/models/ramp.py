"""
ramp.py: RAMP-Fast (Bailis et al., SIGMOD 2014) on fero's groups, for P-15's
SHOULD (no reader sees half a unit). E-24 (QUESTIONS Q-24).

THE WORLD (not counted). Partitions p and q, each in a group of its own with
one writer (an abstract Raft group: a write is applied at once and acked). A
writer's state for its partition is (vers, com, last): the versions it keeps
(by unit id; 0 is the first version), the units whose commit marker it has,
and lastCommit. Each partition also has a follower: a copy of the writer's
state from some earlier moment (a fold of a prefix of the log), brought up to
date by a calm `sync` step. Readers may read either.

Units (blind writes, RAMP's own setting): each writes a set of partitions.
Its client prepares at each (the version carries the unit id and its sibling
partitions), and, once every prepare is acked, writes a commit marker at
each. A client may crash at any point (budget).

One reader runs two read transactions over p and q, one after the other.
Round 1 reads each partition's lastCommit version. If some version names a
sibling partition at a newer unit than the reader holds there, round 2
fetches that exact version by unit id. A version not found (dropped by
garbage collection) restarts the read.

Garbage collection (a tick, not calm): a writer may drop a version older
than lastCommit, by its rules.

Slot move (bound `move`): q moves once from its group to a new group, at any
moment (a control step). The new group starts from what the move carries
(each part of the state is its own update, so the ablation says which are
needed). E-15 checks the move itself; here it is atomic.

PROPERTIES
  RA   read atomicity: a finished read that holds unit T's version of x, where
       T also wrote y (ground truth, not the version's metadata) and y was
       read, holds a version of y from T or a later unit.
  R2   at most two rounds: after round 2's fetches, nothing more is needed.
  KEEP the lastCommit version is kept (round 1 always finds what it names).
  MONO a reader's second read never returns an older version than its first
       (fero's promise: a process never reads older than it saw).
  V    (AG EF) for every unit some reader returned, each partition it wrote
       reaches a lastCommit at or above it once faults stop (nothing seen is
       undone: a later reader there sees it or a newer unit).
  L    (AG EF) every read finishes.
  W    (AG EF) every unit whose client is alive is written: each partition's
       lastCommit reaches it (so a model that never writes cannot pass).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

PARTS = ('p', 'q')
PX = {'p': 0, 'q': 1}
FIELDS = ('ws', 'fol', 'wr', 'rd', 'seen', 'faults', 'moved', 'shown')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()
ST0 = (frozenset({0}), frozenset({0}), 0)      # (vers, com, last)


class Ramp:
    CALM = ('deliver', 'read', 'sync')
    INFO = ()
    SERVE_COMMITS = True     # a round-2 fetch of a pending version commits it there

    def __init__(self, bound):
        self.b = bound
        self.units = bound['units']                    # {t: (part, ...)}; t is its timestamp
        self.tids = tuple(sorted(self.units))
        self.reads = bound.get('reads', 2)

    def init(self):
        ws = (ST0, ST0)
        wr = tuple((E, E, True) for _ in self.tids)      # (prepared, committed, up)
        rd = (0, (None, None), 0, 0, None)               # (txn index, fetched, stage, restarts, need2)
        return (ws, ws, wr, rd, (0, 0), 0, False, E)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[f] for f in FIELDS)

    def _d(self, st):
        class D:
            pass
        d = D()
        d.f = self.to_draft(st)
        return d

    @staticmethod
    def setat(d, field, i, v):
        t = list(d.f[field])
        t[i] = v
        d.f[field] = tuple(t)

    def ti(self, t):
        return self.tids.index(t)

    def md(self, t):
        return self.units[t] if t else PARTS

    def need(self, fetched):
        """RAMP-Fast: for each partition, the newest unit whose fetched version
        names it as a sibling."""
        out = [0, 0]
        for y in PARTS:
            t = fetched[PX[y]]
            if t is None or t == 0:
                continue
            for x in self.units[t]:
                if x in PX and t > out[PX[x]]:
                    out[PX[x]] = t
        return tuple(out)

    # ------------------------------------------------------------ world
    def world(self, st):
        ws, fol, wr, rd, seen, faults, moved, shown = st
        out = []
        for t in self.tids:
            prep, com, up = wr[self.ti(t)]
            if up and com != frozenset(self.units[t]) and faults < self.b['crashes']:
                d = self._d(st)
                self.setat(d, 'wr', self.ti(t), (prep, com, False))
                d.f['faults'] = faults + 1
                out.append((('crash', t), 'fault', self.freeze(d)))
        for i, x in enumerate(PARTS):
            if x in self.b.get('fol', ()) and fol[i] != ws[i]:
                d = self._d(st)
                self.setat(d, 'fol', i, ws[i])
                out.append((('sync', x), 'sync', self.freeze(d)))
        return out

    # ------------------------------------------------------------ properties
    def check(self, st):
        # KEEP: the version round 1 returns (lastCommit) exists at the writer
        return ['KEEP'] if any(w[2] not in w[0] for w in st[IX['ws']]) else []

    def check_edge(self, s, lab, kind, t):
        bad = []
        if lab[0] == 'finish':
            fetched = s[IX['rd']][1]
            for x in PARTS:
                tx = fetched[PX[x]]
                if tx:
                    for y in self.units[tx]:
                        if y in PX and fetched[PX[y]] < tx:
                            bad.append('RA')
            if s[IX['rd']][0] == 1:
                seen = s[IX['seen']]
                if any(fetched[i] < seen[i] for i in range(2)):
                    bad.append('MONO')
        if lab[0] == 'r2':
            # R2: round 2 fetches only what round 1 planned; any other fetch is a third round
            rd = s[IX['rd']]
            x = dict(lab[1])['x']
            if rd[4] is None or self.need(rd[1])[PX[x]] != rd[4][PX[x]]:
                bad.append('R2')
        return bad

    def goals(self, st):
        ws, fol, wr, rd, seen, faults, moved, shown = st
        # every unit a reader returned is, at each partition it wrote, the
        # lastCommit version or older than it (committed, or superseded by a
        # newer committed unit): a later reader there sees it or newer
        vis = all(ws[PX[x]][2] >= t for t in shown for x in self.units[t])
        # W: every unit whose client is alive gets written: at each partition
        # it wrote, lastCommit reaches it (so a model that never writes fails)
        wrote = all(ws[PX[x]][2] >= t for t in self.tids if wr[self.ti(t)][2] for x in self.units[t])
        return {'V': vis, 'L': rd[0] >= self.reads, 'W': wrote}

    def judged(self, st):
        return {'V': True, 'L': True, 'W': True}

    # ------------------------------------------------------------ rules
    def actions(self):
        O = self

        def wparams(w, st):
            for t in O.tids:
                if st[IX['wr']][O.ti(t)][2]:
                    for x in O.units[t]:
                        yield {'t': t, 'x': x}

        def rparams(w, st):
            # topology: a partition has a follower only if the bound gives it one
            if st[IX['rd']][0] < O.reads:
                for x in PARTS:
                    for r in (('ldr', 'fol') if x in O.b.get('fol', ()) else ('ldr',)):
                        yield {'x': x, 'r': r}

        def fin(w, st):
            if st[IX['rd']][0] < O.reads:
                yield {}

        def gcp(w, st):
            if not O.b.get('gc'):
                return
            for x in PARTS:
                for t in st[IX['ws']][PX[x]][0]:
                    if t:
                        yield {'x': x, 't': t}

        def mvp(w, st):
            if O.b.get('move') and not st[IX['moved']]:
                yield {}

        W = lambda st, b: st[IX['ws']][PX[b['x']]]
        REP = lambda st, b: st[IX['ws' if b['r'] == 'ldr' else 'fol']][PX[b['x']]]
        WR = lambda st, b: st[IX['wr']][O.ti(b['t'])]
        RD = lambda st: st[IX['rd']]

        def setws(d, x, vers=None, com=None, last=None):
            v, c, l = d.f['ws'][PX[x]]
            O.setat(d, 'ws', PX[x], (v if vers is None else vers, c if com is None else com,
                                     l if last is None else last))

        def setwr(d, t, prep=None, com=None):
            p, c, up = d.f['wr'][O.ti(t)]
            O.setat(d, 'wr', O.ti(t), (p if prep is None else prep, c if com is None else com, up))

        def setrd(d, **kw):
            k, f, s, r, n2 = d.f['rd']
            v = dict(k=k, f=f, s=s, r=r, n2=n2)
            v.update(kw)
            d.f['rd'] = (v['k'], v['f'], v['s'], v['r'], v['n2'])

        def fetched_set(d, x, t):
            f = list(d.f['rd'][1])
            f[PX[x]] = t
            setrd(d, f=tuple(f))

        acts = []
        # ---------------- the writing client
        acts.append(Action('prepare', 'deliver', wparams, [
            Guard('once', lambda w, st, b: b['x'] not in WR(st, b)[0], role='seq'),
        ], [
            Update('vers', lambda w, st, b, d: setws(d, b['x'], vers=W(st, b)[0] | {b['t']}), role='write',
                   note='the version is kept, with its unit id and siblings, invisible to round 1'),
            Update('ack', lambda w, st, b, d: setwr(d, b['t'], prep=WR(st, b)[0] | {b['x']}), role='seq'),
        ]))
        all_prep = Guard('allprep', lambda w, st, b: WR(st, b)[0] == frozenset(O.units[b['t']]), role='write',
                         note='RAMP: commit markers only after every prepare is acked')
        acts.append(Action('commit', 'deliver', wparams, [
            Guard('once', lambda w, st, b: b['x'] not in WR(st, b)[1], role='seq'),
            all_prep,
            Cmp('newer', lambda w, st, b: b['t'], '>', lambda w, st, b: W(st, b)[2], role='write',
                note='lastCommit only rises (max)'),
        ], [
            Update('com', lambda w, st, b, d: setws(d, b['x'], com=W(st, b)[1] | {b['t']}), role='write'),
            Update('last', lambda w, st, b, d: setws(d, b['x'], last=b['t']), role='write',
                   note='the new version becomes the one round 1 returns'),
            Update('ack', lambda w, st, b, d: setwr(d, b['t'], com=WR(st, b)[1] | {b['x']}), role='seq'),
        ]))
        acts.append(Action('commitold', 'deliver', wparams, [
            Guard('once', lambda w, st, b: b['x'] not in WR(st, b)[1], role='seq'),
            Guard('allprep', all_prep.fn, role='write'),
            Cmp('older', lambda w, st, b: b['t'], '<=', lambda w, st, b: W(st, b)[2], role='write',
                note='a marker older than lastCommit leaves lastCommit alone'),
        ], [
            Update('com', lambda w, st, b, d: setws(d, b['x'], com=W(st, b)[1] | {b['t']}), role='write'),
            Update('ack', lambda w, st, b, d: setwr(d, b['t'], com=WR(st, b)[1] | {b['x']}), role='seq'),
        ]))
        # ---------------- the reader
        acts.append(Action('r1', 'read', rparams, [
            Guard('stage', lambda w, st, b: RD(st)[2] == 0, role='seq'),
            Guard('unread', lambda w, st, b: RD(st)[1][PX[b['x']]] is None, role='seq'),
            Cmp('mono', lambda w, st, b: REP(st, b)[2], '>=', lambda w, st, b: st[IX['seen']][PX[b['x']]],
                role='mono', note="fero's read rule: a server answers only once its fold reached what this "
                                  "process saw there"),
        ], [
            Update('get', lambda w, st, b, d: fetched_set(d, b['x'], REP(st, b)[2]), role='read',
                   note='round 1: the lastCommit version, with its siblings'),
        ]))

        def plan(w, st, b, d):
            setrd(d, s=1, n2=O.need(RD(st)[1]))

        acts.append(Action('plan', 'read', fin, [
            Guard('stage', lambda w, st, b: RD(st)[2] == 0, role='seq'),
            Guard('all', lambda w, st, b: None not in RD(st)[1], role='seq'),
        ], [Update('plan', plan, role='seq', note='round 2 is planned from round 1')]))

        def r2_commit(w, st, b, d):
            v, c, l = W(st, b)
            t = O.need(RD(st)[1])[PX[b['x']]]
            if t not in c:
                setws(d, b['x'], com=c | {t})

        def r2_last(w, st, b, d):
            v, c, l = d.f['ws'][PX[b['x']]]
            t = O.need(RD(st)[1])[PX[b['x']]]
            if t > l:
                setws(d, b['x'], last=t)

        r2u = [Update('get', lambda w, st, b, d: fetched_set(d, b['x'], O.need(RD(st)[1])[PX[b['x']]]),
                      role='read', note='round 2: the exact version, by unit id')]
        if O.SERVE_COMMITS:
            # at the writer; a follower that serves it forwards the commit to the writer
            r2u += [Update('commit', r2_commit, role='repair',
                           note='a pending version fetched by id is committed at the writer (a sibling is)'),
                    Update('last', r2_last, role='repair')]
        acts.append(Action('r2', 'read', rparams, [
            Guard('stage', lambda w, st, b: RD(st)[2] == 1, role='seq'),
            Cmp('needs', lambda w, st, b: O.need(RD(st)[1])[PX[b['x']]], '>',
                lambda w, st, b: RD(st)[1][PX[b['x']]], role='read',
                note='a sibling names a newer unit here than round 1 returned'),
            Guard('found', lambda w, st, b: O.need(RD(st)[1])[PX[b['x']]] in REP(st, b)[0], role='read',
                  note='the replica holds that version (else it answers retry)'),
        ], r2u))
        acts.append(Action('restart', 'read', rparams, [
            Guard('stage', lambda w, st, b: RD(st)[2] == 1, role='seq'),
            Cmp('needs', lambda w, st, b: O.need(RD(st)[1])[PX[b['x']]], '>',
                lambda w, st, b: RD(st)[1][PX[b['x']]], role='read'),
            Guard('gone', lambda w, st, b: O.need(RD(st)[1])[PX[b['x']]] not in st[IX['ws']][PX[b['x']]][0],
                  role='read', note='the writer no longer holds it (collected): read again'),
        ], [Update('reset', lambda w, st, b, d: setrd(d, f=(None, None), s=0, r=RD(st)[3] + 1, n2=None),
                   role='read')]))

        def finish(w, st, b, d):
            k, f, s, r, n2 = RD(st)
            setrd(d, k=k + 1, f=(None, None), s=0, r=0, n2=None)

        def remember(w, st, b, d):
            f = RD(st)[1]
            d.f['seen'] = tuple(max(a, c) for a, c in zip(st[IX['seen']], f))

        def shown(w, st, b, d):
            d.f['shown'] = st[IX['shown']] | {t for t in RD(st)[1] if t}

        acts.append(Action('finish', 'read', fin, [
            Guard('stage', lambda w, st, b: RD(st)[2] == 1, role='seq'),
            Guard('complete', lambda w, st, b: all(n <= f for n, f in zip(O.need(RD(st)[1]), RD(st)[1])),
                  role='read', note='no sibling names a newer unit than the reader holds'),
        ], [
            Update('next', finish, role='seq'),
            Update('seen', remember, role='mono', note='the process remembers the highest version it saw'),
            Update('ghost', shown, role='world'),
        ]))
        # ---------------- the writer's garbage collection
        acts.append(Action('gc', 'tick', gcp, [
            Cmp('older', lambda w, st, b: b['t'], '<', lambda w, st, b: W(st, b)[2], role='gc',
                note='keep the lastCommit version'),
            Guard('committed', lambda w, st, b: b['t'] in W(st, b)[1], role='gc',
                  note='keep a pending version until its commit marker'),
        ], [Update('drop', lambda w, st, b, d: setws(d, b['x'], vers=W(st, b)[0] - {b['t']}), role='gc')]))
        # ---------------- the slot move of q
        def carry(part):
            def f(w, st, b, d):
                v, c, l = st[IX['ws']][1]
                nv, nc, nl = d.f['ws'][1]
                if part == 'pending':
                    nv = nv | frozenset(t for t in v if t not in c)
                elif part == 'committed':
                    nv = nv | frozenset(t for t in v if t in c)
                elif part == 'com':
                    nc = c
                elif part == 'last':
                    nl = l
                O.setat(d, 'ws', 1, (nv, nc, nl))
            return f

        def fresh(w, st, b, d):
            O.setat(d, 'ws', 1, (frozenset({0}), frozenset({0}), 0))
            O.setat(d, 'fol', 1, (frozenset({0}), frozenset({0}), 0))
            d.f['moved'] = True

        acts.append(Action('move', 'control', mvp, [], [
            Update('fresh', fresh, role='world'),
            Update('pending', carry('pending'), role='carry', note='the move carries pending versions'),
            Update('committed', carry('committed'), role='carry', note='... committed versions'),
            Update('com', carry('com'), role='carry', note='... the commit markers'),
            Update('last', carry('last'), role='carry', note='... lastCommit'),
        ]))
        return acts


class NoServe(Ramp):
    SERVE_COMMITS = False


OPTIONS = {'ramp': Ramp, 'noserve': NoServe}
PINNED = {k: ('move.fresh', 'finish.ghost') for k in OPTIONS}

BOUNDS = {
    # two units over p and q, a client crash, two reads in a row
    'two': dict(units={1: ('p', 'q'), 2: ('p', 'q')}, crashes=1, reads=2),
    # a follower of q that lags; reads go to it or to the writer
    'fol': dict(units={1: ('p', 'q'), 2: ('q',)}, crashes=1, reads=2, fol=('q',)),
    # garbage collection of versions older than lastCommit
    'gc': dict(units={1: ('p', 'q'), 2: ('p', 'q')}, crashes=0, reads=1, gc=True),
    # q moves to a new group at any moment
    'move': dict(units={1: ('p', 'q'), 2: ('q',)}, crashes=1, reads=1, move=True),
    # verify: the features two at a time, with three units
    'fol-move': dict(units={1: ('p', 'q'), 2: ('q',), 3: ('p', 'q')}, crashes=1, reads=2, fol=('q',), move=True),
    'gc-move': dict(units={1: ('p', 'q'), 2: ('p', 'q'), 3: ('q',)}, crashes=1, reads=1, gc=True, move=True),
    'gc-fol': dict(units={1: ('p', 'q'), 2: ('p', 'q')}, crashes=1, reads=1, fol=('q',), gc=True),
}
SWEEP = ('two', 'fol', 'gc', 'move')
VERIFY = ('fol-move', 'gc-move', 'gc-fol')
