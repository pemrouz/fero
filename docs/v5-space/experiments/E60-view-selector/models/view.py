"""
view.py: E-31's subscribe model with a `view` selector (E-60 part 1; E-55
claim 22, TRANSFORMS XA-14). Exhaustive, on E-16's engine with E-17's rule
language, so rules and mutants are counted as DEV-10 says, as in E-31.

THE WORLD (not counted), E-31's with these changes
- One followed slot s and its committed log, from E-31's script: 1 `set a`,
  2 `set b` (the client's own write), 3 `del a`. Rows at each prefix: {},
  {a}, {a,b}, {b}.
- A served view over the slot's rows. Its value at position p is V(p), the
  rows at p (a keyed view; its frames carry rows added and rows removed).
  `views.rows` is R: a view with more than R rows ends `view-too-big`. R is
  unbounded except in the `big` bounds, where R = 1, so V(2) = {a,b} is too
  big. With `del a` at 3 the view fits again at 3; a copy that built the
  view fresh at 3 never knew it was too big at 2.
- Group A has three copies: LA (its leader at first), FA1 and FA2. Group B,
  which takes s at a slot move, has LB (its leader) and FB. Every copy folds
  committed records, one at a time. A leader crash loses its uncommitted
  tail (the client retries its own write); A's next leader is the first live
  copy in (LA, FA1, FA2). A crashed copy restarts empty, then loads a
  snapshot at the commit offset. A follower may reload a snapshot (a fault).
  Each restart or reload is a new incarnation; every served-view entry is
  memory only and dies with it.
- Placement is fixed by the view's key: the rendezvous order (FA1, FA2, LA)
  in A and (FB, LB) in B. The owner is the first copy in that order that is
  alive, loaded and not its group's leader (V5-14 pick 3).
- The move (bound `mv`): A fences s at the commit offset N (no tail), then B
  opens s at N; per-slot positions go on at B (E-31's O `slot`).
- The client C has one subscription to the view and writes record 2. It may
  subscribe anywhere when it has no SUB. Its connection to a copy is one FIFO
  queue of at most `cap` messages (1 unless a bound says: a credit of one, so
  a reader is as slow as the interleaving says). A SUB again on the same
  connection keeps the messages already in flight (late messages of the SUB
  it left); a SUB at another copy is another connection, and the client reads
  only the connection of its SUB. A crash or a dropped link resets the
  connection and loses what is in flight. No message is lost, doubled or
  reordered within a connection (TCP).
- The copy knows only what the SUB carried (the client's instance, sequence
  and `seen`) and its own record of what it sent on the link; it never reads
  the client's live state.
- A leader folds each record as it commits it (its fold is the commit offset).
  A group whose only ready copy is its leader has the leader serve the view
  until a second copy is ready (V5-17); then the leader hands it back (END
  moved).
- Faults (a budget): A's leader crashes, a follower of A crashes, a follower
  of A reloads, the client's link drops, the client gives up its SUB and
  subscribes again on the same connection (`resub`), and after the move B's
  follower crashes or reloads (`bcrash`, `breload`). B's leader never fails
  (a group of two cannot elect with one down).

WHAT IS COUNTED (DEV-10): when a copy builds an entry, sends a picture, a
ring resume, a frame, END or a refusal; how the client takes each; the
write's answer and `sync`; the linger.

AN ENTRY on copy x is (build position b) beside x's incarnation and counter.
Its instance is (copy, incarnation, counter). Its frames are the changes of
V over (b, fold], numbered 1, 2, ...: seq is their count, the ring keeps
the last K (K = 1 unless a bound says). The entry has ended (too big) once
V(q) is too big for some q in [b, fold]; it then stays ended while it lives.

PROPERTIES
  V1  the client's view is V(pos) for its position pos, and pos is committed:
      a state the view's own function gives on a prefix of the log.
  P6  the client's position never goes back.
  P3  nobody serves from an unloaded fold.
  P4  a resolved write (`sync`) is in its writer's view, and stays.
  D1  no doubled or missed change: a frame (alone or inside a ring resume)
      adds only rows the view does not show and removes only rows it shows.
  P9  a picture is never behind the client's view, nor behind the client's
      own write if the write's answer reached it before it sent the SUB: the
      SUB's `seen` is what the client has seen, its write's answer included
      (TRANSFORMS 3.8, API.md 3.10). A write answered while the SUB waits is
      left to sync() (P4).
  PL1 no picture, ring resume or frame comes from a group's leader while
      another copy of the group is ready (V5-17).
  PL2 a copy builds an entry only while it is the view's owner.
  E1  END `view-too-big` only when the view has truly ended: some committed
      prefix makes it too big, and the copy that says so has folded it.
  E2  the client never shows a too-big view, and after END it takes nothing
      and never subscribes again: END is terminal.
  E3  an entry that has met a too-big commit (views.rows checked on every
      commit it folded) never serves again while it lives.
  P5  (AG EF) with faults over, the client reaches the end: the script
      written and either its END, or its view at the commit offset with its
      write resolved.
  E4  (targeted check only, option `strict`) a client that follows the view
      never crosses the view's end without END: once it was shown a state
      before the first too-big prefix, it is never shown one at or past it.
      The design's END is per entry, so this stronger reading is checked apart.
"""

import functools
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

SCRIPT = (('set', 'a'), ('set', 'b'), ('del', 'a'))
MINE = 2
LA, FA1, FA2, LB, FB = range(5)
NAMES = ('LA', 'FA1', 'FA2', 'LB', 'FB')
GROUP = ('A', 'A', 'A', 'B', 'B')
ORDER = {'A': (FA1, FA2, LA), 'B': (FB, LB)}
SUCC = (LA, FA1, FA2)
FIELDS = ('log', 'tail', 'nxt', 'phase', 'alead', 'srv', 'cl', 'faults', 'mine')
IX = {f: i for i, f in enumerate(FIELDS)}
SRVF = ('alive', 'loaded', 'fold', 'inc', 'ctr', 'ent')
# cl: src = the copy of the client's connection; link = its SUB there: 'req' (sent, not yet
# answered), 'on' (answered, frames flow), 'done' (the copy ended it), None (no SUB); q = the
# connection's FIFO queue of messages to the client; lk = the copy's record of the link: the
# instance and sequence it last sent (at first the SUB's resume) and the SUB's `seen`; wsub =
# a ghost for P9, read by no rule: the client's write position if its answer had reached the
# client when it sent the SUB, else 0
CLF = ('src', 'link', 'q', 'val', 'pos', 'inst', 'seq', 'seen', 'ended', 'acked', 'res', 'lk', 'wsub')
CI = {f: i for i, f in enumerate(CLF)}
E = frozenset()


@functools.lru_cache(maxsize=None)
def fold(recs):
    rows = set()
    for c in recs:
        op, r = SCRIPT[c - 1]
        if op == 'set':
            rows.add(r)
        else:
            rows.discard(r)
    return frozenset(rows)


def V(log, p):
    return fold(log[:p])


@functools.lru_cache(maxsize=None)
def frames_of(log, b, f):
    """The frames of an entry built at b on a copy at fold f: (seq, pos, add, rem)."""
    out = []
    for q in range(b + 1, f + 1):
        old, new = V(log, q - 1), V(log, q)
        if old != new:
            out.append((len(out) + 1, q, new - old, old - new))
    return tuple(out)


class Ent:
    __slots__ = ('inst', 'seq', 'floor', 'frames', 'ended', 'b')


class View:
    CALM = ('deliver', 'commit', 'apply', 'time')
    INFO = ()
    STRICT = False          # option strict: check E4, the absorbing reading of END
    INST = 'full'           # planted: 'copy' drops the copy from the instance, 'inc' the incarnation
    FRAMEPOS = 'own'        # planted: 'fold' stamps a frame with the copy's fold, not its own position
    OWNSEQ = False          # planted: the client counts frames itself since its last picture (E-57 A2's bug)
    LEADSERVE = False       # planted: the leader may own a view while another copy is ready (XA-1's bug)
    NOINST = False          # planted (the review's VM5): the client takes a frame by its sequence only
    ENDATFOLD = False       # planted (VM7): views.rows checked on the copy's current value only
    PICFITS = False         # planted (VM8): an ended entry serves a picture again once the view fits

    def __init__(self, bound):
        self.b = bound
        self.move = bound.get('move', False)
        self.R = bound.get('rows', 99)
        self.K = bound.get('ring', 1)
        self.cap_q = bound.get('cap', 1)
        self.linger = bound.get('linger', False)
        # cap (only in the *-cap bounds): once a copy has built `cap` entries in one life,
        # its linger stops expiring and it builds over no live entry. It never binds in
        # the design here; it only makes finite the runs where a dropped rule lets the
        # client churn new instances without end (section 3 of the README)
        self.cap = bound.get('cap_build')

    # state: see FIELDS. srv[x] = (alive, loaded, fold, inc, ctr, ent); ent is the
    # entry's build position or None. cl: see CLF.
    def init(self):
        a = (True, True, 0, 0, 0, None)
        b = (True, False, 0, 0, 0, None)
        srv = (a, a, a, b, b)      # LA leads A; LB will lead B
        cl = (None, None, (), E, 0, None, 0, 0, False, False, False, None, 0)
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

    # ------------------------------------------------------------ helpers
    @staticmethod
    def holder(st):
        ph = st[IX['phase']]
        return 'A' if ph == 'A' else (None if ph[0] == 'F' else 'B')

    def holds(self, st, x):
        return self.holder(st) == GROUP[x]

    def leader(self, st, g):
        return st[IX['alead']] if g == 'A' else LB

    def leads(self, st, x):
        return self.leader(st, GROUP[x]) == x

    @staticmethod
    def ready(srv, x):
        return srv[x][0] and srv[x][1]

    def owner(self, st, g):
        """The rendezvous order without the leader; if no other copy is ready, the leader (V5-17)."""
        srv = st[IX['srv']]
        lead = self.leader(st, g)
        for x in ORDER[g]:
            if self.ready(srv, x) and (x != lead or self.LEADSERVE):
                return x
        if self.ready(srv, lead):
            return lead
        return None

    def top(self, st, x):
        ph = st[IX['phase']]
        n = len(st[IX['log']])
        if GROUP[x] == 'A':
            return n if ph == 'A' else ph[1]
        return n if ph != 'A' and ph[0] == 'B' else 0

    def inst_id(self, x, inc, ctr):
        if self.INST == 'copy':
            return (inc, ctr)
        if self.INST == 'inc':
            return (x, ctr)
        return (x, inc, ctr)

    def too_big(self, log, b, f):
        if self.ENDATFOLD:
            return len(V(log, f)) > self.R
        return any(len(V(log, q)) > self.R for q in range(b, f + 1))

    def ent(self, st, x):
        a, ld, f, inc, ctr, b = st[IX['srv']][x]
        if b is None:
            return None
        log = st[IX['log']]
        e = Ent()
        e.b = b
        e.inst = self.inst_id(x, inc, ctr)
        e.frames = frames_of(log, b, f)
        e.seq = len(e.frames)
        e.floor = max(0, e.seq - self.K)
        e.ended = self.too_big(log, b, f)
        return e

    def p_end(self, log):
        for q in range(len(log) + 1):
            if len(V(log, q)) > self.R:
                return q
        return None

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

    def reset(self, d):
        """The client's connection resets: its SUB ends and what is in flight is lost."""
        self.setcl(d, src=None, link=None, q=(), lk=None)

    def crash(self, d, cl, x):
        """x dies with its memory; its connections reset (the client sees the reset)."""
        self.setsrv(d, x, alive=False, loaded=False, ent=None)
        if cl[0] == x:
            self.reset(d)

    # ------------------------------------------------------------ world
    def world(self, st):
        log, tail, nxt, phase, alead, srv, cl, faults, mine = st
        out = []
        h = self.holder(st)
        lead = alead if h == 'A' else (LB if h == 'B' else None)
        if lead is not None and not tail and nxt < len(SCRIPT) and srv[lead][0]:
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
            if srv[lead][1]:          # the leader folds each record as it commits it
                self.setsrv(d, lead, fold=len(log) + 1)
            out.append((('commit', tail), 'commit', self.freeze(d)))
        for x in range(5):
            a, ld, f, inc, ctr, b = srv[x]
            # followers fold committed records one at a time; a leader's fold is the commit offset
            if a and ld and f < self.top(st, x) and not self.leads(st, x):
                d = self._d(st)
                self.setsrv(d, x, fold=f + 1)
                out.append((('apply', NAMES[x]), 'apply', self.freeze(d)))
        kinds = self.b['kinds']
        if faults < self.b['faults']:
            # A's leader crashes: the next live copy leads; an uncommitted tail at A is lost
            if 'lcrash' in kinds and srv[alead][0]:
                d = self._d(st)
                self.crash(d, cl, alead)
                nl = [y for y in SUCC if y != alead and srv[y][0]]
                if nl:
                    d.f['alead'] = nl[0]
                    if h == 'A' and tail:
                        d.f['tail'] = 0
                        if tail == MINE:
                            d.f['nxt'] = MINE - 1     # the client retries its own write
                    if srv[nl[0]][1]:
                        self.setsrv(d, nl[0], fold=self.top(st, nl[0]))
                    d.f['faults'] = faults + 1
                    out.append((('crash', NAMES[alead]), 'fault', self.freeze(d)))
            fol = [x for x in (LA, FA1, FA2) if x != alead and srv[x][0]]
            if h == 'B' and srv[FB][0]:
                fol.append(FB)
            for x in fol:
                b_ = GROUP[x] == 'B'
                if ('bcrash' if b_ else 'fcrash') in kinds:
                    d = self._d(st)
                    self.crash(d, cl, x)
                    d.f['faults'] = faults + 1
                    out.append((('crash', NAMES[x]), 'fault', self.freeze(d)))
                if ('breload' if b_ else 'reload') in kinds and srv[x][1]:
                    d = self._d(st)
                    self.setsrv(d, x, loaded=False, inc=srv[x][3] + 1, ctr=0, ent=None)
                    d.f['faults'] = faults + 1
                    out.append((('reload', NAMES[x]), 'fault', self.freeze(d)))
            if 'drop' in kinds and cl[0] is not None:
                d = self._d(st)
                self.reset(d)
                d.f['faults'] = faults + 1
                out.append((('drop', 'C'), 'fault', self.freeze(d)))
            if 'resub' in kinds and cl[1] in ('req', 'on'):
                # the client gives up its SUB (a timeout of its own) and keeps the connection:
                # what the copy already sent for it is still in flight
                d = self._d(st)
                self.setcl(d, link=None)
                d.f['faults'] = faults + 1
                out.append((('resub', 'C'), 'fault', self.freeze(d)))
        for x in (LA, FA1, FA2, FB):
            if x == FB and h != 'B':
                continue
            a, ld, f, inc, ctr, b = srv[x]
            if not a:     # a crashed copy restarts empty, a new incarnation, from a
                # snapshot at the commit offset (restart and load in one step; a
                # reload gives the loading state its own steps)
                d = self._d(st)
                self.setsrv(d, x, alive=True, loaded=True, fold=self.top(st, x), inc=inc + 1, ctr=0, ent=None)
                out.append((('restart', NAMES[x]), 'time', self.freeze(d)))
            elif not ld:  # it loads a snapshot at the commit offset
                d = self._d(st)
                t = self.top(st, x)
                self.setsrv(d, x, loaded=True, fold=t)
                out.append((('loaded', NAMES[x]), 'time', self.freeze(d)))
        if cl[0] is not None and not srv[cl[0]][0]:
            d = self._d(st)
            self.reset(d)
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
        val, pos = cl[CI['val']], cl[CI['pos']]
        if pos > len(log) or val != V(log, pos):
            bad.append('V1')
        if cl[CI['res']] and pos < st[IX['mine']]:
            bad.append('P4')
        if len(val) > self.R:
            bad.append('E2')
        return bad

    def check_edge(self, s, lab, kind, t):
        bad = []
        sc, tc = s[IX['cl']], t[IX['cl']]
        if tc[CI['pos']] < sc[CI['pos']]:
            bad.append('P6')
        a = lab[0]
        log = s[IX['log']]
        if a in ('pic', 'res', 'frm', 'build'):
            x = dict(lab[1])['x']
            srv = s[IX['srv']]
            if a != 'build':
                if not srv[x][1]:
                    bad.append('P3')
                if self.leads(s, x) and any(self.ready(srv, y) for y in ORDER[GROUP[x]] if y != x):
                    bad.append('PL1')
                # E3, stated on the log: has this entry folded a too-big commit?
                b0, f0 = srv[x][5], srv[x][2]
                if b0 is not None and any(len(V(log, q)) > self.R for q in range(b0, f0 + 1)):
                    bad.append('E3')
            if a == 'build' and self.owner(s, GROUP[x]) != x:
                bad.append('PL2')
            # the wait for seen, stated on world facts: a picture is never behind the
            # client's view, nor behind its own write if the answer came before the SUB
            want = max(sc[CI['pos']], sc[CI['wsub']])
            if a == 'pic' and srv[x][2] < want:
                bad.append('P9')
        if a in ('gotfrm', 'gotres') and sc[CI['q']][0][0] == a[3:]:
            # doubled or missed: an add for a row shown, a remove for a row not shown (a message
            # of another kind taken as this one breaks other properties; it is not read here)
            m = sc[CI['q']][0]
            fr = [m[3:]] if a == 'gotfrm' else [f[1:] for f in m[4]]
            v = sc[CI['val']]
            for q, add, rem in fr:
                if (add & v) or (rem - v):
                    bad.append('D1')
                    break
                v = (v - rem) | add
        if a == 'gotbig' and self.p_end(log) is None:
            bad.append('E1')         # a false END: no committed prefix makes the view too big
        if a == 'endbig':
            pe = self.p_end(log)
            if pe is None or s[IX['srv']][dict(lab[1])['x']][2] < pe:
                bad.append('E1')     # an early END: the sender has not folded the end
        if sc[CI['ended']] and (a == 'connect' or tc[CI['val']] != sc[CI['val']]
                                or tc[CI['pos']] != sc[CI['pos']]):
            bad.append('E2')
        if self.STRICT and a in ('gotpic', 'gotres', 'gotfrm') and sc[CI['inst']] is not None:
            # a client that followed the view crosses the view's end with no END
            pe = self.p_end(log)
            if pe is not None and sc[CI['pos']] < pe <= tc[CI['pos']]:
                bad.append('E4')
        return bad

    def goals(self, st):
        log = st[IX['log']]
        cl = st[IX['cl']]
        done = st[IX['nxt']] == len(SCRIPT) and not st[IX['tail']]
        fin = cl[CI['ended']] or (cl[CI['pos']] == len(log) and cl[CI['res']])
        return {'P5': done and fin}

    def judged(self, st):
        return {'P5': True}

    # ------------------------------------------------------------ rules
    def actions(self):
        O = self
        S = lambda st: st[IX['srv']]
        C = lambda st: st[IX['cl']]
        cl_ = lambda st, k: C(st)[CI[k]]

        def sendable(w, st):
            # topology, not a rule: a live copy answers a SUB on a connection with room
            cl = C(st)
            x = cl[0]
            if x is not None and cl[1] in ('req', 'on') and len(cl[2]) < O.cap_q and S(st)[x][0]:
                yield {'x': x}

        def linked(w, st):
            cl = C(st)
            if cl[0] is not None and cl[1] in ('req', 'on') and S(st)[cl[0]][0]:
                x = cl[0]
                if O.cap is not None and S(st)[x][4] >= O.cap and S(st)[x][5] is not None:
                    return
                yield {'x': x}

        def inbox(w, st):
            cl = C(st)
            if cl[2]:
                yield {'x': cl[0]}

        def free(w, st):
            # topology: with no SUB, the client tries any copy of the group that holds
            # the slot (A's three before the move, B's two once A has fenced)
            cl = C(st)
            if cl[1] is None:
                for x in ((LA, FA1, FA2) if st[IX['phase']] == 'A' else (LB, FB)):
                    yield {'x': x}

        def entries(w, st):
            # the linger runs only in bounds that ask for it (every bound keeps the
            # same rule list, as the ablation needs)
            if not O.linger:
                return
            cl = C(st)
            for x in range(5):
                if O.cap is not None and S(st)[x][4] >= O.cap:
                    continue
                if S(st)[x][5] is not None and S(st)[x][0] and not (cl[0] == x and cl[1] in ('req', 'on')):
                    yield {'x': x}

        X = lambda b: b['x']
        loaded = lambda w, st, b: S(st)[X(b)][1]
        holds = lambda w, st, b: O.holds(st, X(b))
        isowner = lambda w, st, b: O.owner(st, GROUP[X(b)]) == X(b)
        fold_ = lambda w, st, b: S(st)[X(b)][2]
        ent_ = lambda st, b: O.ent(st, X(b))
        lk_ = lambda st: cl_(st, 'lk') or (None, 0, 0)

        def live(w, st, b):
            e = ent_(st, b)
            return e is not None and not e.ended

        def sameinst(w, st, b):
            e = ent_(st, b)
            return e is not None and lk_(st)[0] == e.inst

        e_seq = lambda w, st, b: (ent_(st, b).seq if ent_(st, b) else 0)
        e_floor = lambda w, st, b: (ent_(st, b).floor if ent_(st, b) else 0)
        l_seq = lambda w, st, b: lk_(st)[1]

        def put(d, msg):
            O.setcl(d, q=d.f['cl'][CI['q']] + (msg,))

        def rec(inst, seq):
            # the copy's record of the link: what it last sent (the SUB's seen stays)
            return lambda d: O.setcl(d, lk=(inst, seq, (d.f['cl'][CI['lk']] or (None, 0, 0))[2]))

        acts = []

        # -------- refusals that send the client elsewhere, with its resume
        def refuse(msg):
            def f(w, st, b, d):
                put(d, msg)
                O.setcl(d, link='done')
            return f

        acts.append(Action('notready', 'deliver', sendable, [
            Guard('unready', lambda w, st, b: not loaded(w, st, b) or not holds(w, st, b), role='answer',
                  note='a copy that is loading, or does not hold the slot, answers retry'),
        ], [Update('send', refuse(('retry',)), role='answer')]))
        acts.append(Action('moved', 'deliver', sendable, [
            Guard('loaded', loaded, role='ready'),
            Guard('holds', holds, role='ready'),
            Guard('notowner', lambda w, st, b: not isowner(w, st, b), role='place',
                  note='a SUB at a copy that is not the view\'s owner gets END moved, naming it; '
                       'a held link there ends the same way when the owner changes (a hand-off)'),
        ], [Update('send', refuse(('end', 'moved')), role='answer')]))

        # -------- the owner builds the entry: a new instance
        def build_ctr(w, st, b, d):
            O.setsrv(d, X(b), ctr=S(st)[X(b)][4] + 1)

        def build_ent(w, st, b, d):
            O.setsrv(d, X(b), ent=S(st)[X(b)][2])

        acts.append(Action('build', 'deliver', linked, [
            Guard('loaded', loaded, role='ready'),
            Guard('holds', holds, role='ready'),
            Guard('owner', isowner, role='place', note='only the view\'s owner builds it: one copy, off the leader'),
            Guard('none', lambda w, st, b: S(st)[X(b)][5] is None, role='seq'),
        ], [
            Update('ctr', build_ctr, role='inst', note='instance = (copy, incarnation, counter): unique across copies'),
            Update('ent', build_ent, role='serve', note='the entry starts at the copy\'s fold'),
        ]))

        # -------- a picture: the whole view, at or past the SUB's seen
        def pic_send(w, st, b, d):
            x = X(b)
            e = ent_(st, b)
            f = S(st)[x][2]
            put(d, ('pic', e.inst if e else None, e.seq if e else 0, f, V(st[IX['log']], f)))
            O.setcl(d, link='on')

        def pic_rec(w, st, b, d):
            e = ent_(st, b)
            rec(e.inst if e else None, e.seq if e else 0)(d)

        def pic_live(w, st, b):
            if O.PICFITS:
                e = ent_(st, b)
                return e is not None and len(V(st[IX['log']], fold_(w, st, b))) <= O.R
            return live(w, st, b)

        acts.append(Action('pic', 'deliver', sendable, [
            Guard('loaded', loaded, role='ready', note='a copy answers only once its snapshot has loaded'),
            Guard('holds', holds, role='ready'),
            Guard('owner', isowner, role='place', note='a copy serves a view only while it is the owner'),
            Guard('live', pic_live, role='serve', note='only from a live entry: never a view that has ended'),
            Cmp('seen', fold_, '>=', lambda w, st, b: lk_(st)[2], role='seen',
                note='a picture waits until the copy\'s store is at or past the seen the SUB carried'),
        ], [Update('send', pic_send, role='serve',
                   note='the value, the instance, the frame sequence and the position'),
            Update('rec', pic_rec, role='ring', note='the copy records the instance and sequence it sent')]))

        # -------- a ring resume: the missed frames inside the answer
        def res_send(w, st, b, d):
            e = ent_(st, b)
            cs = l_seq(w, st, b)
            fr = tuple(f for f in e.frames[e.floor:] if f[0] > cs) if e else ()
            put(d, ('res', e.inst if e else None, e.seq if e else 0, S(st)[X(b)][2], fr))
            O.setcl(d, link='on')

        def res_rec(w, st, b, d):
            e = ent_(st, b)
            rec(e.inst if e else None, e.seq if e else 0)(d)

        acts.append(Action('res', 'deliver', sendable, [
            Guard('req', lambda w, st, b: cl_(st, 'link') == 'req', role='seq'),
            Guard('loaded', loaded, role='ready'),
            Guard('holds', holds, role='ready'),
            Guard('owner', isowner, role='place'),
            Guard('live', live, role='serve'),
            Guard('inst', sameinst, role='inst', note='the SUB\'s resume names this entry\'s instance'),
            Cmp('ring', l_seq, '>=', e_floor, role='ring', note='... and the ring reaches back to it'),
            Cmp('ahead', l_seq, '<=', e_seq, role='ring'),
        ], [Update('send', res_send, role='serve', note='the ring frames after the SUB\'s sequence, inside the answer'),
            Update('rec', res_rec, role='ring')]))

        # -------- a frame on a live link: the next one after what the copy sent
        def frm_next(w, st, b):
            e = ent_(st, b)
            cs = l_seq(w, st, b)
            nxt = [f for f in e.frames if f[0] == cs + 1] if e else []
            if nxt:
                return nxt[0]
            return (cs + 1, S(st)[X(b)][2], E, E)

        def frm_send(w, st, b, d):
            e = ent_(st, b)
            sq, q, add, rem = frm_next(w, st, b)
            if O.FRAMEPOS == 'fold':
                q = S(st)[X(b)][2]
            put(d, ('frm', e.inst if e else None, sq, q, add, rem))

        def frm_rec(w, st, b, d):
            e = ent_(st, b)
            rec(e.inst if e else None, frm_next(w, st, b)[0])(d)

        acts.append(Action('frm', 'deliver', sendable, [
            Guard('on', lambda w, st, b: cl_(st, 'link') == 'on', role='seq'),
            Guard('loaded', loaded, role='ready'),
            Guard('holds', holds, role='ready'),
            Guard('owner', isowner, role='place'),
            Guard('live', live, role='serve'),
            Guard('inst', sameinst, role='inst', note='frames go only on a link that follows this instance'),
            Cmp('behind', l_seq, '<', e_seq, role='serve'),
            Cmp('ring', l_seq, '>=', e_floor, role='ring',
                note='the next frame is still in the ring; else a picture (a slow reader)'),
        ], [Update('send', frm_send, role='serve', note='one frame per commit that changed the view, with its own position'),
            Update('rec', frm_rec, role='ring')]))

        # -------- END view-too-big: terminal
        acts.append(Action('endbig', 'deliver', sendable, [
            Guard('ended', lambda w, st, b: ent_(st, b) is not None and ent_(st, b).ended, role='end',
                  note='views.rows is checked on every commit: past it, END view-too-big'),
        ], [Update('send', refuse(('end', 'big')), role='end')]))

        # -------- the linger: an entry no link holds may go, unless it ended
        acts.append(Action('dispose', 'tick', entries, [
            Guard('stays', lambda w, st, b: not O.ent(st, X(b)).ended, role='end',
                  note='view-too-big stays until the method\'s code changes: no rebuild loop'),
        ], [Update('drop', lambda w, st, b, d: O.setsrv(d, X(b), ent=None), role='serve')]))

        # -------- the client takes what arrived, in order
        head = lambda st: cl_(st, 'q')[0]

        def take(kind, sub=None):
            if sub is None:
                return Guard('is', lambda w, st, b: head(st)[0] == kind, role='seq')
            return Guard('is', lambda w, st, b: head(st)[:2] == (kind, sub), role='seq')

        def credit(w, st, b, d):
            O.setcl(d, q=d.f['cl'][CI['q']][1:])

        def seen_up(w, st, b, d):
            O.setcl(d, seen=max(d.f['cl'][CI['seen']], d.f['cl'][CI['pos']]))

        def leave(w, st, b, d):
            O.setcl(d, link=None)

        acts.append(Action('gotpic', 'deliver', inbox, [take('pic')], [
            Update('clear', lambda w, st, b, d: O.setcl(d, val=E), role='replace',
                   note='a new picture is one commit of differences: it replaces the view'),
            Update('rows', lambda w, st, b, d: O.setcl(d, val=d.f['cl'][CI['val']] | head(st)[4]), role='replace'),
            Update('pos', lambda w, st, b, d: O.setcl(d, pos=head(st)[3]), role='pos'),
            Update('inst', lambda w, st, b, d: O.setcl(d, inst=head(st)[1]), role='inst'),
            Update('seq', lambda w, st, b, d: O.setcl(d, seq=0 if O.OWNSEQ else head(st)[2]), role='ring',
                   note='the resume is the server\'s sequence, never the client\'s own count'),
            Update('seen', seen_up, role='seen'),
            Update('credit', credit, role='seq'),
        ]))

        # a ring resume that repeats frames the client already applied (late frames of a SUB it
        # gave up on this connection): the client drops those frames first
        def stale(st):
            m = head(st)
            return m[0] == 'res' and m[1] == cl_(st, 'inst') and any(f[0] <= cl_(st, 'seq') for f in m[4])

        def trim(w, st, b, d):
            m = head(st)
            if m[0] == 'res':
                q = d.f['cl'][CI['q']]
                fr = tuple(f for f in m[4] if f[0] > cl_(st, 'seq'))
                O.setcl(d, q=(m[:4] + (fr,),) + q[1:])

        acts.append(Action('skip', 'deliver', inbox, [
            Guard('old', lambda w, st, b: stale(st), role='ring',
                  note='a ring resume carries frames the client already applied'),
        ], [Update('trim', trim, role='ring', note='the client drops a frame it already applied')]))

        def res_apply(w, st, b, d):
            v = d.f['cl'][CI['val']]
            for sq, q, add, rem in head(st)[4]:
                v = (v - rem) | add
            O.setcl(d, val=v)

        acts.append(Action('gotres', 'deliver', inbox, [
            take('res'),
            Guard('fresh', lambda w, st, b: not stale(st), role='ring',
                  note='only once the frames it already applied are dropped'),
        ], [
            Update('apply', res_apply, role='ring'),
            Update('seq', lambda w, st, b, d: O.setcl(
                d, seq=cl_(st, 'seq') + len(head(st)[4]) if O.OWNSEQ else head(st)[2]), role='ring'),
            Update('pos', lambda w, st, b, d: O.setcl(d, pos=head(st)[3]), role='pos'),
            Update('seen', seen_up, role='seen'),
            Update('credit', credit, role='seq'),
        ]))

        def frm_apply(w, st, b, d):
            f = head(st)
            O.setcl(d, val=(d.f['cl'][CI['val']] - f[5]) | f[4])

        if self.OWNSEQ:
            nextf = lambda w, st, b: head(st)[1] == cl_(st, 'inst')
        elif self.NOINST:
            nextf = lambda w, st, b: head(st)[2] == cl_(st, 'seq') + 1
        else:
            nextf = lambda w, st, b: head(st)[2] == cl_(st, 'seq') + 1 and head(st)[1] == cl_(st, 'inst')
        acts.append(Action('gotfrm', 'deliver', inbox, [
            take('frm'),
            Guard('next', nextf,
                  role='seq', note='a frame is taken only if it is the next of the instance followed'),
        ], [
            Update('apply', frm_apply, role='serve'),
            Update('seq', lambda w, st, b, d: O.setcl(d, seq=cl_(st, 'seq') + 1 if O.OWNSEQ else head(st)[2]),
                   role='ring'),
            Update('pos', lambda w, st, b, d: O.setcl(d, pos=head(st)[3]), role='pos'),
            Update('seen', seen_up, role='seen'),
            Update('credit', credit, role='seq'),
        ]))
        acts.append(Action('gotgap', 'deliver', inbox, [
            take('frm'),
            Guard('gap', lambda w, st, b: not nextf(w, st, b),
                  role='seq', note='any other frame: drop it and subscribe again'),
        ], [Update('leave', leave, role='answer'), Update('credit', credit, role='seq')]))
        acts.append(Action('gotmoved', 'deliver', inbox, [take('end', 'moved')], [
            Update('leave', leave, role='answer', note='subscribe at the owner, with the resume and seen'),
            Update('credit', credit, role='seq'),
        ]))
        acts.append(Action('gotretry', 'deliver', inbox, [take('retry')], [
            Update('leave', leave, role='answer'),
            Update('credit', credit, role='seq'),
        ]))
        acts.append(Action('gotbig', 'deliver', inbox, [take('end', 'big')], [
            Update('ended', lambda w, st, b, d: O.setcl(d, ended=True), role='end',
                   note='END view-too-big ends the link: h.closed rejects with it'),
            Update('leave', leave, role='answer'),
            Update('credit', credit, role='seq'),
        ]))

        # -------- subscribe, with the resume (instance, sequence) and seen
        def link(w, st, b, d):
            cl = C(st)
            x = X(b)
            # the same copy: the same connection, and what is in flight stays in it; another
            # copy: another connection (the client reads only the connection of its SUB)
            O.setcl(d, src=x, link='req', q=cl[CI['q']] if cl[0] == x else (),
                    lk=(cl[CI['inst']], cl[CI['seq']], cl[CI['seen']]),
                    wsub=st[IX['mine']] if cl[CI['acked']] else 0)

        acts.append(Action('connect', 'deliver', free, [
            Guard('alive', lambda w, st, b: S(st)[X(b)][0], role='seq'),
            Guard('open', lambda w, st, b: not cl_(st, 'ended'), role='end', note='an ended link never subscribes again'),
        ], [Update('link', link, role='seq', note='a SUB carries the instance, the sequence and seen')]))

        # -------- the write's answer, and sync() (read-your-writes on the view)
        def once(flag):
            return lambda w, st: iter([{}]) if not cl_(st, flag) else iter(())

        acts.append(Action('ack', 'deliver', once('acked'), [
            Guard('committed', lambda w, st, b: st[IX['mine']] > 0, role='write'),
        ], [
            Update('seen', lambda w, st, b, d: O.setcl(d, seen=max(cl_(st, 'seen'), st[IX['mine']])), role='seen',
                   note='seen also takes the position in the write\'s answer'),
            Update('acked', lambda w, st, b, d: O.setcl(d, acked=True), role='write'),
        ]))
        acts.append(Action('resolve', 'deliver', once('res'), [
            Guard('acked', lambda w, st, b: cl_(st, 'acked'), role='write'),
            Cmp('seen', lambda w, st, b: cl_(st, 'pos'), '>=', lambda w, st, b: st[IX['mine']], role='write',
                note='sync() resolves once the view has passed the write'),
        ], [Update('res', lambda w, st, b, d: O.setcl(d, res=True), role='write')]))

        # -------- the move: B opens at N with A's rows on both of its copies
        def openp(w, st):
            ph = st[IX['phase']]
            if ph != 'A' and ph[0] == 'F':
                yield {}

        def open_phase(w, st, b, d):
            n = st[IX['phase']][1]
            d.f['phase'] = ('B', n)
            # A no longer holds s: its copies' entries are gone and their folds
            # stop at N (a reduction in the pinned world step; they answer retry)
            for x in (LA, FA1, FA2):
                if d.f['srv'][x][1]:
                    O.setsrv(d, x, fold=n, ent=None)

        def open_fold(w, st, b, d):
            n = st[IX['phase']][1]
            O.setsrv(d, LB, loaded=True, fold=n)
            O.setsrv(d, FB, loaded=True, fold=n)

        acts.append(Action('bopen', 'deliver', openp, [], [
            Update('phase', open_phase, role='move'),
            Update('fold', open_fold, role='carry', note="B's copies start from A's rows at N"),
        ]))
        return acts


class Strict(View):
    STRICT = True


class CopyInst(View):
    INST = 'copy'


class IncInst(View):
    INST = 'inc'


class FramePos(View):
    FRAMEPOS = 'fold'


class OwnSeq(View):
    OWNSEQ = True


class LeadServe(View):
    LEADSERVE = True


class NoInst(View):
    NOINST = True


class EndAtFold(View):
    ENDATFOLD = True


class PicFits(View):
    PICFITS = True


OPTIONS = {'view': View, 'strict': Strict, 'copyinst': CopyInst, 'incinst': IncInst, 'framepos': FramePos,
           'ownseq': OwnSeq, 'leadserve': LeadServe, 'noinst': NoInst, 'endatfold': EndAtFold,
           'picfits': PicFits}
PLANTED = ('copyinst', 'incinst', 'framepos', 'ownseq', 'leadserve', 'noinst', 'endatfold', 'picfits')
# Pinned (never dropped or mutated): the world step bopen.phase, and the guard that
# is physics: a copy can send only a frame its ring still holds (frm.ring).
PINNED = {k: ('bopen.phase', 'frm.ring') for k in OPTIONS}


def B(**kw):
    d = dict(faults=1, kinds=('lcrash', 'fcrash', 'reload', 'drop'))
    d.update(kw)
    return d


BOUNDS = {
    'fo': B(),
    'mv': B(move=True, kinds=('lcrash', 'drop')),
    'big': B(rows=1, linger=True, kinds=('fcrash', 'reload', 'drop')),
    'ring2': B(ring=2, kinds=('fcrash', 'reload', 'drop')),
    # a connection that holds two messages, and a SUB given up and sent again on it
    'fifo': B(cap=2, ring=2, kinds=('resub', 'fcrash', 'reload', 'drop')),
    # the move, then B's follower fails: B's leader serves until it is back (V5-17)
    'bfo': B(move=True, kinds=('bcrash', 'breload', 'drop')),
    'fo2': B(faults=2, kinds=('fcrash', 'reload', 'drop')),
    'mvf': B(move=True, kinds=('fcrash', 'reload', 'drop')),
    'fifo2': B(cap=2, ring=2, faults=2, kinds=('resub', 'fcrash', 'reload', 'drop')),
    'fo2all': B(faults=2),
    'mv2': B(move=True, faults=2),
    'big2': B(rows=1, linger=True, faults=2),
    'mvbig': B(move=True, rows=1, linger=True),
    'bfo2': B(move=True, faults=2, kinds=('bcrash', 'breload', 'drop', 'resub')),
    'all2': B(move=True, rows=1, linger=True, faults=2),
}
for _b in ('fo', 'mv', 'big', 'ring2', 'fifo', 'bfo', 'fo2', 'mvf'):
    BOUNDS[_b + '-cap'] = dict(BOUNDS[_b], cap_build=3)
SWEEP = ('fo', 'mv', 'big', 'ring2', 'fifo', 'bfo')
VERIFY = ('fo2', 'mvf')
BIG = ('fifo2', 'fo2all', 'big2', 'mvbig', 'bfo2')   # checked once on the design, in full
PARTIAL = ('mv2', 'all2')                  # too large to finish: a partial check


# Where each rule is already counted, for L3's sum (E-60's README, "The count"):
#   e31   the same check as one of E-31's subscribe rules (LAYERS 4.3, its 26)
#   read  a row of LAYERS 4.3's read-surface table (LENS's resume row: "a resume
#         cursor is always the server's position ... a client drops a frame it
#         already applied")
#   tf    a row of LAYERS 4.3's transformations table (TRANSFORMS 8.3): placement,
#         served-view entries (views.rows, the linger), an instance unique across
#         copies, a resume answer carries its ring frames
#   new   counted in no table yet: the view selector's own
KIN = {
    'notready.unready': 'e31', 'notready.send': 'e31',
    'moved.loaded': 'tf', 'moved.holds': 'tf', 'moved.notowner': 'tf', 'moved.send': 'tf',
    'build.loaded': 'e31', 'build.holds': 'e31', 'build.owner': 'tf', 'build.none': 'tf',
    'build.ctr': 'tf', 'build.ent': 'tf',
    'pic.loaded': 'e31', 'pic.holds': 'e31', 'pic.owner': 'tf', 'pic.live': 'tf', 'pic.seen': 'e31',
    'pic.send': 'e31', 'pic.rec': 'tf',
    'res.req': 'tf', 'res.loaded': 'tf', 'res.holds': 'tf', 'res.owner': 'tf', 'res.live': 'tf',
    'res.inst': 'tf', 'res.ring': 'tf', 'res.ahead': 'tf', 'res.send': 'tf', 'res.rec': 'tf',
    'frm.on': 'e31', 'frm.loaded': 'e31', 'frm.holds': 'e31', 'frm.owner': 'tf', 'frm.live': 'tf',
    'frm.inst': 'tf', 'frm.behind': 'e31', 'frm.ring': 'e31', 'frm.send': 'e31', 'frm.rec': 'tf',
    'endbig.ended': 'tf', 'endbig.send': 'tf', 'dispose.stays': 'tf', 'dispose.drop': 'tf',
    'gotpic.is': 'e31', 'gotpic.clear': 'e31', 'gotpic.rows': 'e31', 'gotpic.pos': 'e31',
    'gotpic.inst': 'new', 'gotpic.seq': 'read', 'gotpic.seen': 'new', 'gotpic.credit': 'e31',
    'skip.old': 'read', 'skip.trim': 'read',
    'gotres.is': 'tf', 'gotres.fresh': 'read', 'gotres.apply': 'tf', 'gotres.seq': 'read', 'gotres.pos': 'e31',
    'gotres.seen': 'new', 'gotres.credit': 'e31',
    'gotfrm.is': 'e31', 'gotfrm.next': 'read', 'gotfrm.apply': 'e31', 'gotfrm.seq': 'read',
    'gotfrm.pos': 'e31', 'gotfrm.seen': 'new', 'gotfrm.credit': 'e31',
    'gotgap.is': 'new', 'gotgap.gap': 'new', 'gotgap.leave': 'new', 'gotgap.credit': 'new',
    'gotmoved.is': 'e31', 'gotmoved.leave': 'e31', 'gotmoved.credit': 'e31',
    'gotretry.is': 'e31', 'gotretry.leave': 'e31', 'gotretry.credit': 'e31',
    'gotbig.is': 'new', 'gotbig.ended': 'new', 'gotbig.leave': 'e31', 'gotbig.credit': 'e31',
    'connect.alive': 'e31', 'connect.open': 'new', 'connect.link': 'e31',
    'ack.committed': 'e31', 'ack.seen': 'new', 'ack.acked': 'e31',
    'resolve.acked': 'e31', 'resolve.seen': 'e31', 'resolve.res': 'e31',
    'bopen.phase': 'e31', 'bopen.fold': 'e31',
}
