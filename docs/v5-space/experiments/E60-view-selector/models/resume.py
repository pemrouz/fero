"""
resume.py: E-31's subscribe model (mode `state`) with a client-held base, for
a folded resume, `connect({ resume: cursor })` (E-60 part 2; V5-13 pick 7,
CONNECT 10 Q3). Exhaustive, on E-16's engine with E-17's rule language.

THE WORLD (not counted), E-31's, with these changes
- E-31's slot and script (1 `set a`, 2 `set b` the client's own write, 3 `del a`);
  the bound `tw` writes a fourth record, 4 `set b` again, so one row is set
  twice. A row's value is the record that set it last, so a row set again is
  a different row. E-31's
  groups (LA and FA hold s; LB takes it at a move), leader crash, follower
  reload and link drop. No relay and no `log` mode here.
- Every copy keeps, beside its rows, each row's version (the slot position
  of its last write) and its own **tombstones**: a removed row and the
  position of its removal, added as it folds a removal, dropped when the row
  is set again. A time step `gc` drops the tombstones at or below the fold
  (the window passes). A snapshot carries rows and versions, not tombstones,
  so a reloaded copy starts with none, and so does B at a move (B opens with
  A's rows and versions at N). Beside them the copy keeps a **floor**,
  `tbase`: the oldest cursor it claims its tombstones reach back to. Keeping
  the floor right is counted (rules `load.floor`, `gc.floor`,
  `bopen.floor`); the tombstones themselves are the world.
- The client may **restart** (a fault): its link closes; it keeps the base it
  last saved, its rows with their cursor, one record. The client may save
  its base at any time (a calm step). A restart is a new process: its write's
  promise is gone (it resolves again once its view passes the write).

THE OPTIONS
- `e31`: E-31's design (option `fixed`, mode `state`): a reconnect may get a
  conflated diff from the records the copy holds after the cursor; a
  restarted client starts from nothing (no base) and takes a new picture.
- `fold`: the folded resume. The client keeps its base across a restart. A
  copy answers a SUB with "rows newer than the cursor, plus tombstones newer
  than it" when its window reaches back to the cursor; else a new picture.
  It never reads the log.
- `torn` (planted): the base is saved in two steps (rows, then cursor).
- `firstver` (planted, the review's RM6): a row's version is its first set,
  not its last.

WHAT IS COUNTED (DEV-10): E-31's server answers and client handling in mode
`state`, the folded resume's guards and the client's base.

PROPERTIES (E-31's, mode `state`)
  P2  the client's view equals the fold of the committed log at its cursor,
      after every message: no ghost row, nothing uncommitted, nothing
      skipped. After a folded resume this is "the same as a fresh subscribe"
      at that position (F1 checks the step itself).
  F1  a folded resume leaves the client exactly where a new picture from the
      same copy would: its rows equal the copy's rows, its cursor the copy's
      fold.
  P3  nobody answers from an unloaded fold.
  P4  a resolved write is in its writer's view, and stays.
  P6  the client's cursor never goes back, within one process life.
  P5  (AG EF) with faults over, the client catches up: the script written,
      its cursor at the commit offset, its write resolved.
"""

import functools
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

SCRIPT = (('set', 'a'), ('set', 'b'), ('del', 'a'), ('set', 'b'))
MINE = 2
LA, FA, LB = 0, 1, 2
NAMES = ('LA', 'FA', 'LB')
FIELDS = ('log', 'tail', 'nxt', 'phase', 'alead', 'srv', 'cl', 'faults', 'mine')
IX = {f: i for i, f in enumerate(FIELDS)}
SRVF = ('alive', 'loaded', 'fold', 'base', 'tbase', 'tombs')
CLF = ('src', 'link', 'inf', 'cur', 'view', 'res', 'pcur', 'pview')
CI = {f: i for i, f in enumerate(CLF)}
E = frozenset()


@functools.lru_cache(maxsize=None)
def fold(recs):
    """The rows at the end of recs: (row, the record that set it last)."""
    rows = {}
    for c in recs:
        op, r = SCRIPT[c - 1]
        if op == 'set':
            rows[r] = c
        else:
            rows.pop(r, None)
    return frozenset(rows.items())


@functools.lru_cache(maxsize=None)
def versions(recs, first=False):
    """Per row: the position of its last set (planted `firstver`: its first)."""
    ver = {}
    for p, c in enumerate(recs, 1):
        op, r = SCRIPT[c - 1]
        if op == 'set':
            if not (first and r in ver):
                ver[r] = p
        else:
            ver.pop(r, None)
    return ver


@functools.lru_cache(maxsize=None)
def newer(recs, cur, tombs, first=False):
    """What a copy at fold len(recs) sends for a cursor: its rows whose version is
    newer than cur, and the tombstones it holds that are newer than cur."""
    ver = versions(recs, first)
    rows = dict(fold(recs))
    sets = frozenset((r, rows[r]) for r, p in ver.items() if p > cur)
    rem = frozenset(r for r, p in tombs if p > cur)
    return sets, rem


def tomb_step(tombs, recs, p):
    """A copy folds record p: a removal adds its tombstone, a set drops the row's."""
    op, r = SCRIPT[recs[p - 1] - 1]
    if op == 'del':
        return tombs | {(r, p)}
    return frozenset(t for t in tombs if t[0] != r)


class Res:
    CALM = ('deliver', 'commit', 'apply', 'time')
    INFO = ()
    FOLD = False       # the folded resume (else E-31's design)
    TORN = False       # planted: the base saved in two steps
    FIRSTVER = False   # planted (the review's RM6): a row's version is its first set

    def __init__(self, bound):
        self.b = bound
        self.move = bound.get('move', False)
        self.n = bound.get('n', 3)       # how many of the script's records are written

    # srv[x] = (alive, loaded, fold, base, tbase, tombs): base = the oldest record it holds
    # (E-31), tbase = the floor its tombstones claim, tombs = the tombstones. cl = (src, link, inf,
    # cur, view, res, pcur, pview): pcur and pview are the saved base.
    def init(self):
        srv = ((True, True, 0, 0, 0, E), (True, True, 0, 0, 0, E), (True, False, 0, 0, 0, E))
        cl = (None, None, None, 0, E, False, 0, E)
        return ((), 0, 0, 'A', LA, srv, cl, 0, 0)

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
    def holder(st):
        ph = st[IX['phase']]
        return 'A' if ph == 'A' else (None if ph[0] == 'F' else 'B')

    def holds(self, st, x):
        ph = st[IX['phase']]
        if x in (LA, FA):
            return ph == 'A'
        return ph != 'A' and ph[0] == 'B'

    def setcl(self, d, **kw):
        v = dict(zip(CLF, d.f['cl']))
        v.update(kw)
        d.f['cl'] = tuple(v[n] for n in CLF)

    def setsrv(self, d, x, **kw):
        srv = list(d.f['srv'])
        v = dict(zip(SRVF, srv[x]))
        v.update(kw)
        srv[x] = tuple(v[n] for n in SRVF)
        d.f['srv'] = tuple(srv)

    def rows(self, st, x):
        return fold(st[IX['log']][:st[IX['srv']][x][2]])

    # ------------------------------------------------------------ world
    def world(self, st):
        log, tail, nxt, phase, alead, srv, cl, faults, mine = st
        out = []
        h = self.holder(st)
        lead = alead if h == 'A' else (LB if h == 'B' else None)
        if lead is not None and not tail and nxt < self.n and srv[lead][0]:
            d = self._d(st)
            d.f['tail'] = nxt + 1
            d.f['nxt'] = nxt + 1
            out.append((('propose', nxt + 1), 'commit', self.freeze(d)))
        if lead is not None and tail and srv[lead][0]:
            d = self._d(st)
            d.f['log'] = log + (tail,)
            d.f['tail'] = 0
            if tail == MINE:
                d.f['mine'] = len(log) + 1
            out.append((('commit', tail), 'commit', self.freeze(d)))
        top = len(log) if phase == 'A' else phase[1]
        for x in (LA, FA):
            a, ld, f, base, tb, ts = srv[x]
            if a and ld and f < top:
                d = self._d(st)
                self.setsrv(d, x, fold=f + 1, tombs=tomb_step(ts, log, f + 1))
                out.append((('apply', NAMES[x]), 'apply', self.freeze(d)))
        a, ld, f, base, tb, ts = srv[LB]
        if a and ld and f < len(log):
            d = self._d(st)
            self.setsrv(d, LB, fold=f + 1, tombs=tomb_step(ts, log, f + 1))
            out.append((('apply', 'LB'), 'apply', self.freeze(d)))
        kinds = self.b['kinds']
        if faults < self.b['faults']:
            if srv[LA][0] and 'crash' in kinds:
                d = self._d(st)
                self.setsrv(d, LA, alive=False)
                d.f['alead'] = FA
                if h == 'A' and tail:
                    d.f['tail'] = 0
                    if tail == MINE:
                        d.f['nxt'] = MINE - 1
                d.f['faults'] = faults + 1
                out.append((('crash', 'LA'), 'fault', self.freeze(d)))
            if srv[FA][0] and srv[FA][1] and 'reload' in kinds:
                d = self._d(st)
                self.setsrv(d, FA, loaded=False)
                d.f['faults'] = faults + 1
                out.append((('reload', 'FA'), 'fault', self.freeze(d)))
            if 'drop' in kinds and cl[0] is not None:
                d = self._d(st)
                self.setcl(d, src=None, link=None, inf=None)
                d.f['faults'] = faults + 1
                out.append((('drop', 'C'), 'fault', self.freeze(d)))
            if 'restart' in kinds:
                # the client process restarts: its link closes; the new process
                # starts from its saved base (fold) or from nothing (e31)
                d = self._d(st)
                if self.FOLD:
                    self.setcl(d, src=None, link=None, inf=None, cur=cl[CI['pcur']], view=cl[CI['pview']],
                               res=False)
                else:
                    self.setcl(d, src=None, link=None, inf=None, cur=0, view=E, res=False)
                d.f['faults'] = faults + 1
                out.append((('restart', 'C'), 'fault', self.freeze(d)))
        if cl[0] is not None and not srv[cl[0]][0]:
            d = self._d(st)
            self.setcl(d, src=None, link=None, inf=None)
            out.append((('timeout', 'C'), 'time', self.freeze(d)))
        if self.move and phase == 'A' and not tail:
            d = self._d(st)
            d.f['phase'] = ('F', len(log))
            out.append((('fence', len(log)), 'control', self.freeze(d)))
        return out

    # ------------------------------------------------------------ properties
    def check(self, st):
        bad = []
        log = st[IX['log']]
        cl = st[IX['cl']]
        cur, view = cl[CI['cur']], cl[CI['view']]
        if cur > len(log) or view != fold(log[:cur]):
            bad.append('P2')
        if cl[CI['res']] and cur < st[IX['mine']]:
            bad.append('P4')
        return bad

    def check_edge(self, s, lab, kind, t):
        bad = []
        sc, tc = s[IX['cl']], t[IX['cl']]
        if tc[CI['cur']] < sc[CI['cur']] and lab != ('restart', 'C'):
            bad.append('P6')
        a = lab[0]
        if a in ('snap', 'diff', 'fres'):
            x = dict(lab[1])['x']
            if not s[IX['srv']][x][1]:
                bad.append('P3')
        if a == 'gotfres':
            inf = sc[CI['inf']]
            if inf[0] != 'fres' or tc[CI['view']] != inf[4] or tc[CI['cur']] != inf[1]:
                bad.append('F1')
        return bad

    def goals(self, st):
        log = st[IX['log']]
        cl = st[IX['cl']]
        done = st[IX['nxt']] == self.n and not st[IX['tail']]
        return {'P5': done and cl[CI['cur']] == len(log) and cl[CI['res']]}

    def judged(self, st):
        return {'P5': True}

    # ------------------------------------------------------------ rules
    def actions(self):
        O = self
        S = lambda st: st[IX['srv']]
        C = lambda st: st[IX['cl']]
        cl_ = lambda st, k: C(st)[CI[k]]
        X = lambda b: b['x']

        def sendable(w, st):
            cl = C(st)
            x = cl[0]
            if x is not None and cl[2] is None and S(st)[x][0]:
                yield {'x': x}

        def inbox(w, st):
            if cl_(st, 'inf') is not None:
                yield {'x': cl_(st, 'src')}

        def free(w, st):
            if cl_(st, 'src') is None:
                for x in (LA, FA, LB):
                    yield {'x': x}

        def only(flag, gen):
            # topology: an action of the other option has no parameters, so every
            # option has the same rule list
            return lambda w, st: gen(w, st) if flag else iter(())

        loaded = lambda w, st, b: S(st)[X(b)][1]
        holds = lambda w, st, b: O.holds(st, X(b))
        fold_ = lambda w, st, b: S(st)[X(b)][2]
        cur_ = lambda w, st, b: cl_(st, 'cur')
        req = Guard('req', lambda w, st, b: cl_(st, 'link') in ('req', 'on'), role='seq')

        acts = []
        # -------- a snapshot (a new picture): E-31's rules
        acts.append(Action('snap', 'deliver', sendable, [
            req,
            Guard('loaded', loaded, role='ready', note='a copy answers only once its snapshot has loaded'),
            Guard('holds', holds, role='ready'),
            Cmp('cursor', fold_, '>=', cur_, role='cursor', note="never before its fold has reached the cursor"),
        ], [Update('send', lambda w, st, b, d: O.setcl(d, link='on', inf=('snap', fold_(w, st, b), O.rows(st, X(b)))),
                   role='serve')]))

        # -------- E-31's conflated diff from the records after the cursor (option e31)
        def diff_send(w, st, b, d):
            old = fold(st[IX['log']][:cur_(w, st, b)])
            new = O.rows(st, X(b))
            O.setcl(d, link='on', inf=('diff', fold_(w, st, b), new - old, old - new))

        acts.append(Action('diff', 'deliver', only(not self.FOLD, sendable), [
            Guard('req', lambda w, st, b: cl_(st, 'link') in ('req', 'on'), role='seq'),
            Guard('loaded', loaded, role='ready'),
            Guard('holds', holds, role='ready'),
            Cmp('behind', cur_, '<', fold_, role='serve'),
            Cmp('held', lambda w, st, b: S(st)[X(b)][3], '<=', cur_, role='serve',
                note='a diff from the cursor needs the records after it; else a snapshot'),
        ], [Update('send', diff_send, role='serve')]))

        # -------- the folded resume: rows newer than the cursor, plus tombstones (option fold)
        def fres_send(w, st, b, d):
            x = X(b)
            f = fold_(w, st, b)
            sets, rem = newer(st[IX['log']][:f], cur_(w, st, b), S(st)[x][5], O.FIRSTVER)
            O.setcl(d, link='on', inf=('fres', f, sets, rem, O.rows(st, x)))

        acts.append(Action('fres', 'deliver', only(self.FOLD, sendable), [
            Guard('req', lambda w, st, b: cl_(st, 'link') in ('req', 'on'), role='seq'),
            Guard('loaded', loaded, role='ready'),
            Guard('holds', holds, role='ready'),
            Cmp('cursor', fold_, '>=', cur_, role='cursor',
                note='the copy waits until its fold reaches the client\'s cursor'),
            Cmp('window', lambda w, st, b: S(st)[X(b)][4], '<=', cur_, role='tomb',
                note='its tombstones reach back to the cursor; else a new picture'),
        ], [Update('send', fres_send, role='serve', note="rows whose version is newer than the cursor, "
                                                         "and tombstones newer than it; never the log")]))

        acts.append(Action('notready', 'deliver', sendable, [
            Guard('unready', lambda w, st, b: not loaded(w, st, b) or not holds(w, st, b), role='answer',
                  note='an unloaded replica, A once fenced, or B before it opens: go elsewhere'),
        ], [Update('send', lambda w, st, b, d: O.setcl(d, inf=('retry',)), role='answer')]))

        # -------- the client takes what arrived
        def take(kind):
            return Guard('is', lambda w, st, b: cl_(st, 'inf')[0] == kind, role='seq')

        inf_ = lambda st: cl_(st, 'inf')
        credit = lambda w, st, b, d: O.setcl(d, inf=None)
        cursor = lambda w, st, b, d: O.setcl(d, cur=inf_(st)[1])

        acts.append(Action('gotsnap', 'deliver', inbox, [take('snap')], [
            Update('clear', lambda w, st, b, d: O.setcl(d, view=E), role='replace', note='a snapshot replaces the view'),
            Update('rows', lambda w, st, b, d: O.setcl(d, view=d.f['cl'][CI['view']] | inf_(st)[2]), role='replace'),
            Update('cursor', cursor, role='cursor'),
            Update('credit', credit, role='seq'),
        ]))
        acts.append(Action('gotdiff', 'deliver', inbox, [take('diff')], [
            Update('add', lambda w, st, b, d: O.setcl(d, view=d.f['cl'][CI['view']] | inf_(st)[2]), role='replace'),
            Update('del', lambda w, st, b, d: O.setcl(d, view=d.f['cl'][CI['view']] - inf_(st)[3]), role='replace'),
            Update('cursor', cursor, role='cursor'),
            Update('credit', credit, role='seq'),
        ]))

        def fadd(w, st, b, d):
            keys = {r for r, _ in inf_(st)[2]}
            O.setcl(d, view=frozenset(p for p in d.f['cl'][CI['view']] if p[0] not in keys) | inf_(st)[2])

        def fdel(w, st, b, d):
            O.setcl(d, view=frozenset(p for p in d.f['cl'][CI['view']] if p[0] not in inf_(st)[3]))

        acts.append(Action('gotfres', 'deliver', inbox, [take('fres')], [
            Update('add', fadd, role='replace', note='a row set after the cursor replaces the row'),
            Update('del', fdel, role='replace', note='tombstones remove rows'),
            Update('cursor', cursor, role='cursor'),
            Update('credit', credit, role='seq'),
        ]))
        acts.append(Action('gotretry', 'deliver', inbox, [take('retry')], [
            Update('leave', lambda w, st, b, d: O.setcl(d, src=None, link=None), role='answer'),
            Update('credit', credit, role='seq'),
        ]))
        acts.append(Action('connect', 'deliver', free, [
            Guard('alive', lambda w, st, b: S(st)[X(b)][0], role='seq'),
        ], [Update('link', lambda w, st, b, d: O.setcl(d, src=X(b), link='req'), role='seq',
                   note='connect({ resume: cursor }): the SUB carries the base\'s cursor')]))

        # -------- the client saves its base: its rows with their cursor, one record
        def saveable(w, st):
            if O.FOLD and (cl_(st, 'pcur'), cl_(st, 'pview')) != (cl_(st, 'cur'), cl_(st, 'view')):
                yield {}

        if not self.TORN:
            acts.append(Action('save', 'deliver', saveable, [], [
                Update('rows', lambda w, st, b, d: O.setcl(d, pview=cl_(st, 'view')), role='base',
                       note='the saved rows ...'),
                Update('cur', lambda w, st, b, d: O.setcl(d, pcur=cl_(st, 'cur')), role='base',
                       note='... with the cursor they are at, in one record'),
            ]))
        else:
            acts.append(Action('save', 'deliver', saveable, [], [
                Update('rows', lambda w, st, b, d: O.setcl(d, pview=cl_(st, 'view')), role='base'),
            ]))
            acts.append(Action('savecur', 'deliver', saveable, [], [
                Update('cur', lambda w, st, b, d: O.setcl(d, pcur=cl_(st, 'cur')), role='base'),
            ]))

        # -------- the tombstone floor's upkeep: a snapshot and the window
        def unloaded(w, st):
            ph = st[IX['phase']]
            x = FA
            if S(st)[x][0] and not S(st)[x][1]:
                yield {'x': x}

        def top_(st):
            ph = st[IX['phase']]
            return len(st[IX['log']]) if ph == 'A' else ph[1]

        acts.append(Action('load', 'deliver', unloaded, [], [
            Update('rows', lambda w, st, b, d: O.setsrv(d, X(b), loaded=True, fold=top_(st), base=top_(st), tombs=E),
                   role='world', note='the snapshot loads: rows and versions at the commit offset, no tombstones'),
            Update('floor', lambda w, st, b, d: O.setsrv(d, X(b), tbase=top_(st)), role='tomb',
                   note='a loaded snapshot starts the copy\'s window at its position'),
        ]))

        def gcable(w, st):
            if O.FOLD and 'gc' in O.b.get('time', ()):
                for x in (LA, FA, LB):
                    a, ld, f, base, tb, ts = S(st)[x]
                    if a and ld and tb < f:
                        yield {'x': x}

        acts.append(Action('gc', 'deliver', gcable, [], [
            Update('drop', lambda w, st, b, d: O.setsrv(d, X(b), tombs=frozenset(
                t for t in S(st)[X(b)][5] if t[1] > S(st)[X(b)][2])), role='world',
                note='the window passes: tombstones at or below the fold are dropped'),
            Update('floor', lambda w, st, b, d: O.setsrv(d, X(b), tbase=S(st)[X(b)][2]), role='tomb',
                   note='the floor follows the tombstones dropped'),
        ]))

        # -------- the client's own write resolves (E-31)
        acts.append(Action('resolve', 'deliver', lambda w, st: iter([{}]) if not cl_(st, 'res') else iter(()), [
            Guard('committed', lambda w, st, b: st[IX['mine']] > 0, role='write'),
            Cmp('seen', cur_, '>=', lambda w, st, b: st[IX['mine']], role='write',
                note='a write resolves once its writer\'s subscription has passed it'),
        ], [Update('res', lambda w, st, b, d: O.setcl(d, res=True), role='write')]))

        # -------- the move: B opens at N with A's rows and versions; no tombstones
        def openp(w, st):
            ph = st[IX['phase']]
            if ph != 'A' and ph[0] == 'F':
                yield {}

        def open_phase(w, st, b, d):
            d.f['phase'] = ('B', st[IX['phase']][1])

        def open_fold(w, st, b, d):
            n = st[IX['phase']][1]
            O.setsrv(d, LB, loaded=True, fold=n, base=n, tombs=E)

        acts.append(Action('bopen', 'deliver', openp, [], [
            Update('phase', open_phase, role='move'),
            Update('fold', open_fold, role='carry', note="B starts from A's rows and versions at N, no tombstones"),
            Update('floor', lambda w, st, b, d: O.setsrv(d, LB, tbase=st[IX['phase']][1]), role='tomb',
                   note="B's tombstone window starts at N"),
        ]))
        return acts


class Fold(Res):
    FOLD = True


class Torn(Fold):
    TORN = True


class FirstVer(Fold):
    FIRSTVER = True


OPTIONS = {'e31': Res, 'fold': Fold, 'torn': Torn, 'firstver': FirstVer}
PLANTED = ('torn', 'firstver')
# Pinned: the world steps written as rules (the move's phase, a snapshot's load, the
# window's drop of old tombstones) and E-31's diff.held
PINNED = {k: ('bopen.phase', 'diff.held', 'load.rows', 'gc.drop') for k in OPTIONS}


def B(**kw):
    d = dict(faults=1, kinds=('crash', 'reload', 'drop', 'restart'), time=('gc',))
    d.update(kw)
    return d


BOUNDS = {
    'fo': B(),
    'tw': B(n=4, kinds=('reload', 'drop', 'restart')),
    'mv': B(move=True, kinds=('crash', 'drop', 'restart')),
    'fo2': B(faults=2),
    'mv2': B(move=True, faults=2),
}
SWEEP = ('fo', 'mv', 'tw')
VERIFY = ('fo2',)
BIG = ('mv2',)            # checked once on the design, in full


# Where each rule is already counted (see view.py's KIN): e31 = one of E-31's
# subscribe rules; new = the folded resume's own.
KIN = {
    'snap.req': 'e31', 'snap.loaded': 'e31', 'snap.holds': 'e31', 'snap.cursor': 'e31', 'snap.send': 'e31',
    'diff.req': 'e31', 'diff.loaded': 'e31', 'diff.holds': 'e31', 'diff.behind': 'e31', 'diff.held': 'e31',
    'diff.send': 'e31',
    'fres.req': 'new', 'fres.loaded': 'new', 'fres.holds': 'new', 'fres.cursor': 'new', 'fres.window': 'new',
    'fres.send': 'new',
    'notready.unready': 'e31', 'notready.send': 'e31',
    'gotsnap.is': 'e31', 'gotsnap.clear': 'e31', 'gotsnap.rows': 'e31', 'gotsnap.cursor': 'e31',
    'gotsnap.credit': 'e31',
    'gotdiff.is': 'e31', 'gotdiff.add': 'e31', 'gotdiff.del': 'e31', 'gotdiff.cursor': 'e31', 'gotdiff.credit': 'e31',
    'gotfres.is': 'new', 'gotfres.add': 'new', 'gotfres.del': 'new', 'gotfres.cursor': 'new', 'gotfres.credit': 'new',
    'gotretry.is': 'e31', 'gotretry.leave': 'e31', 'gotretry.credit': 'e31',
    'connect.alive': 'e31', 'connect.link': 'e31',
    'save.rows': 'new', 'save.cur': 'new',
    'resolve.committed': 'e31', 'resolve.seen': 'e31', 'resolve.res': 'e31',
    'bopen.phase': 'e31', 'bopen.fold': 'e31', 'bopen.floor': 'new',
    'load.rows': 'e31', 'load.floor': 'new', 'gc.drop': 'new', 'gc.floor': 'new',
}
