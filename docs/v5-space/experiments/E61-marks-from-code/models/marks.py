"""
marks.py: E-61's model. Exactly once into fero by marks, with the mark written
by APP CODE: `{ from: e }` on each output write, the writes NOT awaited.

It runs on E-16's engine with E-17's rule language, as E-30's model did, and
reuses E-20's world for the Raft groups (abstract leaders, a crash keeps any
prefix of the uncommitted tail, a lost tail may come back). The mark rule is
E-30's `srchi-slot` (per reader, source slot and output slot, in the output's
own entry, carried with a slot move) with E-57 B5's write number, but here the
writer is app code inside a loop that does not await, so what E-30 got from a
consumer that waited for each answer must come from other rules.

THE WORLD (not counted)
  Source A: one or two source slots, already committed: a1 holds x0, x1, ...
  The source may cut its log (raise its floor): in a `keep` bound only below
  every reader's committed restart point (it keeps its log back to the
  marks); in a `cut` bound anywhere.
  Target B: output slots P, R, Q in Raft groups b0, b1. The consumer's cursor
  rows sit in a third group, gc (`#groups`). A slot may move between groups
  (E-15's fence and open, abstract, as E-30).
  The readers: one or more owners. An owner has a reader name. Owners with
  the same name share one share (a lease with a token): a takeover gives it to
  the other owner, and the old one runs on as a zombie until it notices.
  The app code fn: for each source record, a fixed list of output writes in
  call order (BOUNDS' `outs`), each marked `{ from: e }`. An output may carry
  a condition on the row (`if`), true or false by a world flag that may flip,
  or a lock condition (`if: { lock }`, P-10): refused `fenced` when the
  writer's share token is older than one the slot's leader has taken a lock
  write under. In an `async` bound fn may await something before it writes
  (one record at a time is held inside fn; it writes later).
  The copies: a write's copies go on the wire and can be lost. Copies of one
  session to one output slot arrive in issue order (one ordered link per
  leader; a lost copy is resent in order), copies of different sessions or
  slots in any order. The client resends a write once it is lost (no copy on
  the wire, in no group's log), up to `cap` copies (the session's resend).
  Answers: the client learns a write's outcome when its entry commits (state
  reduction, see norm()).

THE LOOP, as API.md 3.11 and LAYERS 3.3 and 8.8 write it
  start    read the restart point. derive(): `target.marks(name)`, per source
           slot the lowest mark over the output slots, read from committed
           state; consumer().run(): the share's committed cursor row in gc.
  read     take the next record (paced: only while this client holds fewer
           than LINE waiting writes; and only once fn has returned for the
           record before) and run fn: every output is issued, numbered within
           its record per output slot (the write's number w), and numbered per
           (session, output slot) for issue order (O.seq), and sent. Nothing
           is awaited.
  emit     an async fn that awaited before writing makes its writes.
  bare     derive() only: a bare mark for an output slot the last record read
           wrote nothing to, once no write to that slot waits.
  cursor   consumer().run() only: now and then, write the share's cursor in
           gc, only past records fn has returned for and whose writes are all
           answered, under the share's token, and again if gc lost it. gc
           applies a cursor write only above the row's value.
  expired  a read position below the source's floor: read the marks again
           (or the cursor); jump to them if they are at or past the floor,
           else stop with `expired`. Never skip ahead.
  fail     LAYERS 3.3 and 8.8 step 7: a marked write that fails (a gap at the
           leader, or a write lost with its copies spent) ends the loop with
           its error; the supervisor starts it again, from the marks.

THE LEADER of an output slot judges a copy in issue order (O.seq: a repeat is
a dup, a later one a gap, which ends its loop): at or below the stored mark ->
skipped (an entry that only takes the O.seq number), answered `skipped`; above
-> applied with the mark IN THE SAME ENTRY; a condition on the row that fails
-> refused, and the refusal raises the mark; a stale lock token -> refused
`fenced`, with no mark.

GHOSTS: each output has an id (its index in `outs`).

PROPERTIES
  ONCE     no output is applied twice.
  LOST     a reader's committed restart point never passes a record that has
           an output neither applied nor refused on its row.
  HANDLED  a committed skip of an output is of one applied or refused on its
           row (a skip never stands for an output that did not happen).
  ANSWER   no client is told `applied` for an output that is not applied.
  STAND    no output is both refused on its row and applied (this study's
           proposal: a refusal of a marked write is final).
  NOSTOP   in a `keep` bound no owner stops with `expired`.
  DONE     AG EF over calm steps, asked in every state: every reader done
           (each output applied once, or refused on its row; its restart point
           at the end) or, in a `cut` bound, stopped `expired`.
"""

import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

_spec = importlib.util.spec_from_file_location('e20dedup', os.path.join(HERE, '..', '..', 'E20-dedup', 'models', 'dedup.py'))
_e20 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_e20)
norm_lost = _e20.norm_lost

E = frozenset()
FIELDS = ('g', 'net', 'ds', 'floor', 'flag', 'hold', 'cnt')
IX = {f: i for i, f in enumerate(FIELDS)}
B0, B1, GC = 0, 1, 2
GN = ('b0', 'b1', 'gc')
BG = (B0, B1)
WMAX = 255            # a bare mark's write number: "all of this record"
NEGM = (-1, -1)
# owner: (life, up, pos, iss, held, tok); up: 0 down, 1 running, 2 stopped `expired`, 3 gave up
OWN = ('life', 'up', 'pos', 'iss', 'held', 'tok')
DOWN, UP, EXPIRED, GAVEUP = 0, 1, 2, 3
# an issued write: (P, k, pay, stat, copies); pay ('o', oid, w) or ('m', s, q)
WAIT, OK, REF, SKIP, FENCED = 0, 1, 2, 3, 4
# a log entry: (kind, sess, P, k, mk, oid, x); kind 'w' applied, 'k' skipped, 'r' refused on the row, 'f' refused
# `fenced`, 'm' a bare mark, 'M' a mark in its own entry; x: the writer's token ('w'), the answer ('k')
JUDGED = ('w', 'k', 'r', 'f', 'm')
MARKED = ('w', 'r', 'f', 'm', 'M')
# a copy on the wire: ('c', sess, P, k, pay, name, tok)
# cnt: (faults, owner crashes, drops, flips, cuts, takeovers)
C_F, C_RR, C_DR, C_FL, C_CU, C_TK = range(6)


def T(name, fn, role='', note=''):
    return Guard(name, fn, role=role, note=note)


def U(name, fn, role='', note=''):
    return Update(name, fn, role=role, note=note)


class Marks:
    CALM = ('deliver', 'read', 'tick', 'commit')
    INFO = ()
    # ---- variants (structural changes; the rule drops are the engine's)
    KEY = 'name+slot'      # what a mark is kept under: 'name+slot' | 'slot' | 'name'
    ENTRY = 'same'         # where the mark goes: 'same' entry as the output | 'apart' (after) | 'first' (before)
    WNUM = True            # the mark carries the write's number
    NONDET = False         # app code makes a record's writes to one slot in another order on a re-run
    UNPACED = False        # a marked write past the line is refused `backpressure` and the loop goes on
    MARKS_TAIL = False     # the loop reads marks() (or the cursor) from the leader's log, uncommitted tail included
    MARKS_MARKED = False   # marks() is the lowest mark over only the output slots that hold a mark
    MARKS_JOINED = False   # marks() over the slots the reader joined: a row in gc per (name, source slot, output
                           # slot), committed before the first write to that slot (and one home slot before the
                           # first record); bare marks go to joined slots only
    JUDGE_COM = False      # the leader checks the mark against committed entries only
    SKIPAHEAD = False      # on `expired`, jump to the source's floor
    STOPREFUSE = False     # the loop ends on a refusal; the supervisor restarts it
    NOBARE = False         # derive() sends no bare marks (as consumer().run())
    START_FRESH = False    # run(): a new owner starts only once no cursor write is pending in gc (E-22)
    FENCED_MARK = False    # a `fenced` refusal raises the mark too (this study's first design: every refusal final)
    WIRE = 'order'         # 'order': one session's copies to one slot arrive in issue order; 'any': in any order
    GAPEND = True          # a gap at the leader ends the writer's loop (LAYERS 3.3, 8.8 step 7)
    SPENTEND = True        # a write lost with its copies spent ends the loop; else DONE is not asked there

    def __init__(self, bound):
        self.b = bound
        self.mode = bound['mode']                    # 'derive' or 'run'
        self.src = dict(bound['src'])                # source slot -> number of records
        self.slots_src = tuple(sorted(self.src))
        self.outs = tuple(bound['outs'])             # (name, s, q, P, cond) in fn's call order; cond False|True|'lock'
        self.owners = tuple(bound['owners'])         # reader name per owner
        self.names = tuple(sorted(set(self.owners)))
        self.share = bound.get('share', False)
        self.shared = next((n for n in self.owners if self.owners.count(n) > 1), None)
        self.place = dict(bound['slots'])            # output slot -> group at the start
        self.oslots = tuple(sorted(self.place))
        self.move = bound.get('move')                # (P, from group, to group)
        self.cap = bound.get('cap', 2)
        self.line = bound.get('line', 2)
        self.crashes = bound.get('crashes', 0)       # per group
        self.faults = bound.get('faults', 1)
        self.restarts = bound.get('restarts', 1)
        self.ndrops = bound.get('drops', 0)
        self.nflips = bound.get('flips', 0)
        self.ncuts = bound.get('cuts', 0)
        self.ntakes = bound.get('takes', 0)
        self.keep = bound.get('keep', True)
        self.flag0 = bound.get('flag0', False)     # the row condition's truth at the start
        self.cgroups = bound.get('cgroups', BG)      # which groups may crash
        self.asyncfn = bound.get('async', False)     # fn may await before it writes
        # lives an owner may have: every loop end needs a fault (a gap or a spent write follows a lost copy or a
        # lost tail; a slot move without its issue numbers gaps once per life), so this is never reached in the
        # bounds; a supervisor past it gives up, and DONE then breaks, so the bound shows if it were reached
        self.lmax = bound.get('lives', 3 + self.restarts + self.faults + (1 if self.move else 0))
        assert not any(o[4] == 'lock' and self.move and o[3] == self.move[0] for o in self.outs), \
            'a lock output on a moving slot needs the fence to carry the lock table (not modelled)'

    # ------------------------------------------------------------ state
    def init(self):
        g = tuple(((), (), E, 0) for _ in GN)
        ds = tuple((0, DOWN, (), (), (), 0) for _ in self.owners)
        h0 = self.owners.index(self.shared) if self.shared else 0
        return (g, E, ds, tuple(0 for _ in self.slots_src), self.flag0, (h0, 0), (0,) * 6)

    def to_draft(self, st):
        d = dict(zip(FIELDS, st))
        d['_e'] = {}
        return d

    def freeze(self, d):
        return self.norm(tuple(d.f[x] for x in FIELDS))

    def norm(self, st):
        """State reduction (not rules). (1) An answer reaches the client when its entry commits: the client
        learns at once (a client that learns later only does its own steps later). (2) A copy that can only
        ever be a dup is dropped: its number is at or below the committed issue-order number of the group
        that will judge it (a slot not moving, or moved and open committed)."""
        g, net, ds, floor, flag, hold, cnt = st
        ds2 = list(ds)
        changed = False
        for i, o in enumerate(ds):
            if o[1] != UP or not any(x[3] == WAIT for x in o[3]):
                continue
            sess = (i, o[0])
            iss = list(o[3])
            refused = False
            for j, x in enumerate(iss):
                if x[3] != WAIT:
                    continue
                for gi in BG:
                    e = next((e for e in self.answers(g[gi]) if e[0] in JUDGED and e[1] == sess
                              and e[2] == x[0] and e[3] == x[1]), None)
                    if e is not None:
                        if e[0] == 'r':
                            a = REF
                        elif e[0] == 'f':
                            a = FENCED
                        elif e[0] == 'k' and e[6] == 'skip':
                            a = SKIP
                        else:
                            a = OK
                        iss[j] = x[:3] + (a, x[4])
                        refused = refused or e[0] == 'r'
                        changed = True
                        break
            o2 = o[:3] + (tuple(iss),) + o[4:]
            if self.STOPREFUSE and refused:
                # the loop ends with the refusal; the supervisor starts it again (a new session)
                o2 = (o[0] + 1, DOWN, (), (), (), o[5]) if o[0] + 1 < self.lmax else (o[0], GAVEUP) + o2[2:]
            ds2[i] = o2
        if changed:
            ds = tuple(ds2)
        if net:
            dead = []
            for m in net:
                P = m[2]
                if self.move and self.move[0] == P:
                    b = self.move[2]
                    if not any(e[0] == 'open' and e[1] == P for e in g[b][0]):
                        continue
                    gi = b
                else:
                    gi = self.place[P]
                if m[3] <= self.oseq((g,), 0, m[1], P, committed=True, grp=g[gi]):
                    dead.append(m)
            if dead:
                net = net - frozenset(dead)
                changed = True
        return (g, net, ds, floor, flag, hold, cnt) if changed else st

    @staticmethod
    def answers(grp):
        """The entries a client takes its answers from: the committed ones."""
        return grp[0]

    # ------------------------------------------------------------ views
    @staticmethod
    def log(st, g):
        grp = st[0][g]
        return grp[0] + grp[1]

    @staticmethod
    def com(st, g):
        return st[0][g][0]

    def ents(self, st, g, committed):
        return self.com(st, g) if committed else self.log(st, g)

    def own(self, st, i):
        return st[IX['ds']][i]

    def holds(self, st, i):
        """Owners of the shared name take turns by a lease; an owner of any other name holds its own share."""
        if not self.share or self.owners[i] != self.shared:
            return True
        return st[IX['hold']][0] == i

    def si(self, s):
        return self.slots_src.index(s)

    def append(self, d, g, entry):
        groups = list(d.f['g'])
        com, tail, lost, cr = groups[g]
        groups[g] = (com, tail + (entry,), lost, cr)
        d.f['g'] = tuple(groups)

    def set_own(self, d, i, **kw):
        ds = list(d.f['ds'])
        o = list(ds[i])
        for k, v in kw.items():
            o[OWN.index(k)] = v
        ds[i] = tuple(o)
        d.f['ds'] = tuple(ds)

    def end_loop(self, d, i):
        """The loop ends with an error; the supervisor will start it again (a new session)."""
        o = d.f['ds'][i]
        if o[0] + 1 < self.lmax:
            self.set_own(d, i, life=o[0] + 1, up=DOWN, pos=(), iss=(), held=())
        else:
            self.set_own(d, i, up=GAVEUP, pos=(), iss=(), held=())

    def bump(self, d, *which):
        c = list(d.f['cnt'])
        for w in which:
            c[w] += 1
        d.f['cnt'] = tuple(c)

    # ---- where an output slot lives
    def owner(self, st, P):
        """The group that holds P open (by log end); None while a move has fenced it and the target has not
        opened it (E-30's owner())."""
        if self.move and self.move[0] == P:
            _, a, b = self.move
            if any(e[0] == 'open' and e[1] == P for e in self.log(st, b)):
                return b
            if any(e[0] == 'fence' and e[1] == P for e in self.log(st, a)):
                return None
            return a
        return self.place[P]

    def com_owner(self, st, P):
        """Where P's committed marks are read: the target once its open committed, else the source group."""
        if self.move and self.move[0] == P:
            _, a, b = self.move
            if any(e[0] == 'open' and e[1] == P for e in self.com(st, b)):
                return b
            return a
        return self.place[P]

    # ---- the leader's per-slot state
    def mkey(self, name, s):
        return {'name+slot': (name, s), 'slot': (s,), 'name': (name,)}[self.KEY]

    def oseq(self, st, g, sess, P, committed=False, grp=None):
        hi = 0
        ents = (grp[0] if committed else grp[0] + grp[1]) if grp is not None else self.ents(st, g, committed)
        for e in ents:
            if e[0] in JUDGED and e[1] == sess and e[2] == P:
                hi = max(hi, e[3])
            elif e[0] == 'open' and e[1] == P:
                for ss, h in e[2][1]:
                    if ss == sess:
                        hi = max(hi, h)
        return hi

    def mark(self, st, g, key, P, committed=False):
        m = NEGM
        for e in self.ents(st, g, committed):
            if e[0] in MARKED and e[2] == P and e[4] is not None:
                mk = e[4]
                if self.mkey(mk[0], mk[1]) == key:
                    m = max(m, (mk[2], mk[3]))
            elif e[0] == 'open' and e[1] == P:
                for kk, v in e[2][0]:
                    if kk == key:
                        m = max(m, v)
        return m

    def judge_mark(self, st, g, key, P):
        return self.mark(st, g, key, P, committed=self.JUDGE_COM)

    def lock_seen(self, st, g, P):
        """The highest share token the slot's leader has taken a lock write under (P-10)."""
        t = -1
        for e in self.log(st, g):
            if e[0] == 'w' and e[2] == P and e[5] is not None and self.outs[e[5]][4] == 'lock':
                t = max(t, e[6])
        return t

    # ---- a copy's mark: (q, w) for an output, (q, WMAX) for a bare mark
    def pay_mk(self, pay, name):
        if pay[0] == 'o':
            nm, s, q, P, cond = self.outs[pay[1]]
            return (nm, s, q, pay[2] if self.WNUM else 0)
        _, s, q = pay
        return (name, s, q, WMAX)

    def copy_mk(self, m):
        return self.pay_mk(m[4], m[5])

    # ---- the restart point
    def joined(self, st, name, s, committed=True):
        """The output slots this reader joined for source slot s, with the first record that wrote there."""
        out = {}
        for e in self.ents(st, GC, committed):
            if e[0] == 'join' and e[1] == name and e[2] == s:
                out[e[3]] = min(out.get(e[3], e[4]), e[4])
        return out

    def rp_from(self, st, name, tail, marked=False):
        out = []
        for s in self.slots_src:
            if self.mode == 'derive' and self.MARKS_JOINED:
                v = None
                for P, q0 in self.joined(st, name, s).items():
                    m = self.mark(st, self.com_owner(st, P), self.mkey(name, s), P, committed=True)
                    x = q0 if m == NEGM else m[0] + (1 if m[1] == WMAX else 0)
                    v = x if v is None else min(v, x)
                out.append(0 if v is None else v)
            elif self.mode == 'derive':
                v = None
                for P in self.oslots:
                    if tail:
                        g = self.owner(st, P)
                        g = self.move[1] if g is None else g
                    else:
                        g = self.com_owner(st, P)
                    m = self.mark(st, g, self.mkey(name, s), P, committed=not tail)
                    if marked and m == NEGM:
                        continue
                    x = 0 if m == NEGM else m[0] + (1 if m[1] == WMAX else 0)
                    v = x if v is None else min(v, x)
                out.append(0 if v is None else v)
            else:
                out.append(self.rowval(st, name, s, committed=not tail))
        return tuple(out)

    def rp(self, st, name):
        """The committed restart point, as the properties and the source's cut judge it. derive(): per source
        slot, the lowest committed mark over the output slots (a record whose mark is an output's is read
        again; a bare mark says the record is whole there). run(): the committed cursor."""
        return self.rp_from(st, name, False)

    def rp_read(self, st, name):
        """The restart point as the loop reads it (the design: the committed one)."""
        return self.rp_from(st, name, self.MARKS_TAIL, self.MARKS_MARKED)

    def rp_resync(self, st, name):
        """The restart point as an `expired` reader reads it again (the design: as at start)."""
        return self.rp_read(st, name)

    def rowval(self, st, name, s, committed=False):
        """The share's cursor row in gc: the last write applied (a row set: the last write wins)."""
        c = 0
        for e in self.ents(st, GC, committed):
            if e[0] == 'cur' and e[1] == name and e[2] == s:
                c = e[3]
        return c

    def waiting(self, st, i):
        return sum(1 for x in self.own(st, i)[3] if x[3] == WAIT)

    def recs(self, name, s, q):
        return [oid for oid, (nm, s2, q2, P, c) in enumerate(self.outs) if nm == name and s2 == s and q2 == q]

    def lost_write(self, st, sess, x):
        """A write is lost: no copy on the wire, and in no group's log."""
        return not any(m[1] == sess and m[2] == x[0] and m[3] == x[1] for m in st[IX['net']]) and \
            not any(e[0] in JUDGED and e[1] == sess and e[2] == x[0] and e[3] == x[1]
                    for gi in BG for e in self.log(st, gi))

    # ------------------------------------------------------------ params
    def p_start(self, md, st):
        for i, o in enumerate(st[IX['ds']]):
            if o[1] == DOWN and self.holds(st, i) and o[0] < self.lmax:
                if self.START_FRESH and self.mode == 'run' and \
                        any(e[0] == 'cur' and e[1] == self.owners[i] for e in st[0][GC][1]):
                    continue                         # E-22: read the cursor fresh, once no cursor write is pending
                yield {'i': i}

    def p_read(self, md, st):
        fl = st[IX['floor']]
        for i, o in enumerate(st[IX['ds']]):
            if o[1] != UP:
                continue
            for j, s in enumerate(self.slots_src):
                if o[2][j] < self.src[s] and o[2][j] >= fl[j]:
                    yield {'i': i, 's': s}
                    # an async fn awaits before it writes: the record is held inside fn (one at a time)
                    if self.asyncfn and not o[4] and self.recs(self.owners[i], s, o[2][j]):
                        yield {'i': i, 's': s, 'hold': True}

    def p_low(self, md, st):
        fl = st[IX['floor']]
        for i, o in enumerate(st[IX['ds']]):
            if o[1] != UP:
                continue
            for j, s in enumerate(self.slots_src):
                if o[2][j] < fl[j]:
                    yield {'i': i, 's': s}

    def p_resend(self, md, st):
        for i, o in enumerate(st[IX['ds']]):
            if o[1] != UP:
                continue
            sess = (i, o[0])
            for j, x in enumerate(o[3]):
                if x[3] == WAIT and x[4] < self.cap and self.lost_write(st, sess, x):
                    yield {'i': i, 'j': j}

    def p_fail(self, md, st):
        if not self.SPENTEND:
            return
        for i, o in enumerate(st[IX['ds']]):
            if o[1] != UP:
                continue
            sess = (i, o[0])
            if any(x[3] == WAIT and x[4] >= self.cap and self.lost_write(st, sess, x) for x in o[3]):
                yield {'i': i}

    def p_bare(self, md, st):
        if self.mode != 'derive' or self.NOBARE:
            return
        for i, o in enumerate(st[IX['ds']]):
            if o[1] != UP:
                continue
            name = self.owners[i]
            for j, s in enumerate(self.slots_src):
                last = o[2][j] - 1                   # the last record run on s
                if last < 0:
                    continue
                js = self.joined(st, name, s) if self.MARKS_JOINED else None
                for P in self.oslots:
                    if js is not None and P not in js:
                        continue                     # marks-joined: bare marks go only to joined slots
                    # "an output slot that gets no output for a while" (a state reduction): the last record run
                    # wrote nothing to P; the guard `bare.idle` adds "and no write to P waits"
                    if any(self.outs[oid][3] == P for oid in self.recs(name, s, last)):
                        continue
                    # the mark the library puts on it: the last record run (the rule), or one past it (the
                    # record the reader holds next, which the rule `bare.read` refuses)
                    for q in (last, last + 1):
                        if q >= self.src[s]:
                            continue
                        if any(x[0] == P and x[2][0] == 'm' and x[2][1] == s and x[2][2] >= q for x in o[3]):
                            continue
                        yield {'i': i, 's': s, 'q': q, 'P': P}

    def p_join(self, md, st):
        if not self.MARKS_JOINED or self.mode != 'derive':
            return
        for i, o in enumerate(st[IX['ds']]):
            if o[1] != UP:
                continue
            name = self.owners[i]
            for j, s in enumerate(self.slots_src):
                q = o[2][j]
                if q >= self.src[s]:
                    continue
                have = self.joined(st, name, s, committed=False)
                want = {self.outs[oid][3] for oid in self.recs(name, s, q)}
                if not have and not want:
                    want = {self.oslots[0]}           # a home slot, so bare marks have a place before any output
                for P in sorted(want):
                    if P not in have:
                        yield {'i': i, 's': s, 'P': P, 'q': q}

    def all_joined(self, st, i, s):
        if not self.MARKS_JOINED or self.mode != 'derive':
            return True
        name = self.owners[i]
        q = self.own(st, i)[2][self.si(s)]
        js = self.joined(st, name, s)
        return bool(js) and all(self.outs[oid][3] in js for oid in self.recs(name, s, q))

    def p_emit(self, md, st):
        for i, o in enumerate(st[IX['ds']]):
            if o[1] == UP and o[4]:
                yield {'i': i}

    def p_cur(self, md, st):
        if self.mode != 'run':
            return
        for i, o in enumerate(st[IX['ds']]):
            if o[1] != UP:
                continue
            sess = (i, o[0])
            for j, s in enumerate(self.slots_src):
                p = o[2][j]
                # "now and then": write the read position, and write it again if gc lost it (no entry of
                # this session at p or past it in gc's log)
                if p > 0 and not any(e[0] == 'cur' and e[1] == self.owners[i] and e[2] == s and e[3] >= p
                                     and e[5] == sess for e in self.log(st, GC)):
                    yield {'i': i, 's': s, 'p': p}

    def p_copies(self, md, st):
        net = st[IX['net']]
        for m in net:
            if self.WIRE == 'order' and any(m2[1] == m[1] and m2[2] == m[2] and m2[3] < m[3] for m2 in net):
                continue                             # an earlier copy of this session to this slot is ahead of it
            g = self.owner(st, m[2])
            if g is not None:
                yield {'m': m, 'g': g}

    def p_crash(self, md, st):
        c = st[IX['cnt']]
        if c[C_RR] >= self.restarts or c[C_F] >= self.faults:
            return
        for i, o in enumerate(st[IX['ds']]):
            if o[1] == UP:
                yield {'i': i}

    def p_notice(self, md, st):
        for i, o in enumerate(st[IX['ds']]):
            if o[1] == UP and not self.holds(st, i):
                yield {'i': i}

    # ------------------------------------------------------------ helpers for the leader's guards
    def hi_of(self, st, b):
        m = b['m']
        return self.oseq(st, b['g'], m[1], m[2])

    def mark_of(self, st, b):
        m = b['m']
        mk = self.copy_mk(m)
        return self.judge_mark(st, b['g'], self.mkey(mk[0], mk[1]), m[2])

    def mk_of(self, st, b):
        mk = self.copy_mk(b['m'])
        return (mk[2], mk[3])

    def cond_fails(self, st, b):
        """A condition on the row that fails (the same for every writer)."""
        pay = b['m'][4]
        return pay[0] == 'o' and self.outs[pay[1]][4] is True and not st[IX['flag']]

    def stale(self, st, b):
        """A lock condition that fails: the writer's share token is older than one this leader took a lock
        write under (refused `fenced`; it depends on the writer, not on the row)."""
        pay = b['m'][4]
        return pay[0] == 'o' and self.outs[pay[1]][4] == 'lock' and b['m'][6] < self.lock_seen(st, b['g'], b['m'][2])

    # ------------------------------------------------------------ the writes of one record
    def issue(self, d, i, s, q, wnum):
        o = d.f['ds'][i]
        name = self.owners[i]
        oids = self.recs(name, s, q)
        if self.NONDET and o[0] > 0:
            oids = list(reversed(oids))              # a re-run calls the writes in another order
        iss = list(o[3])
        net = set(d.f['net'])
        sess = (i, o[0])
        line = sum(1 for x in iss if x[3] == WAIT)
        seen = {}
        for oid in oids:
            P = self.outs[oid][3]
            w = seen.get(P, 0) if wnum else 0
            seen[P] = seen.get(P, 0) + 1
            if self.UNPACED and line >= self.line:
                continue                             # refused `backpressure` on the client: never sent
            k = 1 + sum(1 for x in iss if x[0] == P)
            pay = ('o', oid, w)
            iss.append((P, k, pay, WAIT, 1))
            net.add(('c', sess, P, k, pay, name, o[5]))
            line += 1
        self.set_own(d, i, iss=tuple(iss))
        d.f['net'] = frozenset(net)

    # ------------------------------------------------------------ actions
    def actions(self):
        A = []

        # ---- the loop (L5, over L4's public calls)
        def start(md, st, b, d):
            i = b['i']
            tok = st[IX['hold']][1] if (self.share and self.owners[i] == self.shared) else 0
            self.set_own(d, i, up=UP, pos=self.rp_read(st, self.owners[i]), iss=(), held=(), tok=tok)
        A.append(Action('start', 'deliver', self.p_start, [], [U('read', start, 'world')]))

        def number(md, st, b, d):
            d.f['_e']['wnum'] = True

        def run_fn(md, st, b, d):
            i, s = b['i'], b['s']
            o = d.f['ds'][i]
            j = self.si(s)
            q = o[2][j]
            wn = bool(d.f['_e'].get('wnum'))
            if b.get('hold'):
                self.set_own(d, i, held=((s, q, wn),))
            else:
                self.issue(d, i, s, q, wn)
            pos = list(d.f['ds'][i][2])
            pos[j] = q + 1
            self.set_own(d, i, pos=tuple(pos))
        read_guards = [] if self.UNPACED else [
            Cmp('paced', lambda w, st, b: self.waiting(st, b['i']), '<', lambda w, st, b: self.line, role='pace',
                note='the reader yields a record only while this client holds fewer than LINE waiting writes')]
        read_guards.append(T('fnret', lambda w, st, b: not self.own(st, b['i'])[4], 'async',
                             'the loop takes the next record only once fn has returned (it awaits fn\'s promise)'))
        if self.MARKS_JOINED:
            read_guards.append(T('joined', lambda w, st, b: self.all_joined(st, b['i'], b['s']), 'join',
                                 'marks-joined: a record is run only once every slot it writes is joined (committed)'))
        A.append(Action('read', 'read', self.p_read, read_guards,
                        [U('number', number, 'wnum', 'each write carries its number within its record, per output slot'),
                         U('run', run_fn, 'world')]))

        def low_jump(md, st, b, d):
            i, s = b['i'], b['s']
            j = self.si(s)
            pos = list(d.f['ds'][i][2])
            if self.SKIPAHEAD:
                pos[j] = st[IX['floor']][j]
            else:
                pos[j] = self.rp_resync(st, self.owners[i])[j]
            self.set_own(d, i, pos=tuple(pos))
        A.append(Action('resync', 'deliver', self.p_low,
                        [] if self.SKIPAHEAD else
                        [T('kept', lambda w, st, b: self.rp_resync(st, self.owners[b['i']])[self.si(b['s'])] >=
                           st[IX['floor']][self.si(b['s'])], 'expired',
                           'below the floor: jump to the marks (or cursor) only if they are at or past the floor')],
                        [U('jump', low_jump, 'expired', 'an `expired` reader reads its marks (or cursor) again and resumes there')]))

        def stop(md, st, b, d):
            self.set_own(d, b['i'], up=EXPIRED)
        if not self.SKIPAHEAD:
            A.append(Action('expire', 'deliver', self.p_low,
                            [T('stale', lambda w, st, b: self.rp_resync(st, self.owners[b['i']])[self.si(b['s'])] <
                               st[IX['floor']][self.si(b['s'])], 'expired',
                               'stop only when the marks (or cursor) too are below the floor')],
                            [U('stop', stop, 'expired', 'stop with `expired`; never skip a record')]))

        def resend(md, st, b, d):
            i, j = b['i'], b['j']
            o = d.f['ds'][i]
            iss = list(o[3])
            x = iss[j]
            iss[j] = x[:4] + (x[4] + 1,)
            self.set_own(d, i, iss=tuple(iss))
            d.f['net'] = d.f['net'] | {('c', (i, o[0]), x[0], x[1], x[2], self.owners[i], o[5])}
        A.append(Action('resend', 'tick', self.p_resend, [], [U('send', resend, 'world')]))

        def bare(md, st, b, d):
            i, s, q, P = b['i'], b['s'], b['q'], b['P']
            o = d.f['ds'][i]
            iss = list(o[3])
            k = 1 + sum(1 for x in iss if x[0] == P)
            pay = ('m', s, q)
            iss.append((P, k, pay, WAIT, 1))
            self.set_own(d, i, iss=tuple(iss))
            d.f['net'] = d.f['net'] | {('c', (i, o[0]), P, k, pay, self.owners[i], o[5])}
        A.append(Action('bare', 'tick', self.p_bare,
                        [Cmp('read', lambda w, st, b: b['q'], '<',
                             lambda w, st, b: self.own(st, b['i'])[2][self.si(b['s'])], role='bare',
                             note='a bare mark only for a record already run (its writes were issued before it)'),
                         T('idle', lambda w, st, b: not any(x[0] == b['P'] and x[3] == WAIT
                                                            for x in self.own(st, b['i'])[3]), 'bare',
                           'a bare mark waits until no write to its slot waits')],
                        [U('send', bare, 'bare', 'derive() sends a bare mark to an idle output slot')]))

        def join(md, st, b, d):
            self.append(d, GC, ('join', self.owners[b['i']], b['s'], b['P'], b['q']))
        if self.MARKS_JOINED:
            A.append(Action('join', 'tick', self.p_join, [], [U('send', join, 'world')]))

        def emit(md, st, b, d):
            i = b['i']
            s, q, wn = d.f['ds'][i][4][0]
            self.issue(d, i, s, q, wn)
            self.set_own(d, i, held=())
        A.append(Action('emit', 'read', self.p_emit, [], [U('send', emit, 'world')]))

        def cur(md, st, b, d):
            i, s, p = b['i'], b['s'], b['p']
            self.append(d, GC, ('cur', self.owners[i], s, p, st[IX['hold']][1], (i, d.f['ds'][i][0])))

        def answered(w, st, b):
            o = self.own(st, b['i'])
            for x in o[3]:
                if x[2][0] == 'o':
                    nm, s, q, P, c = self.outs[x[2][1]]
                    if s == b['s'] and q < b['p'] and x[3] == WAIT:
                        return False
            return True
        A.append(Action('cursor', 'tick', self.p_cur,
                        [T('answered', answered, 'cursor',
                           'the cursor moves past a record only once its marked writes are answered'),
                         T('fnret', lambda w, st, b: not any(h[0] == b['s'] and h[1] < b['p']
                                                             for h in self.own(st, b['i'])[4]), 'async',
                           'the cursor moves past a record only once fn has returned for it'),
                         T('fence', lambda w, st, b: self.holds(st, b['i']), 'fence',
                           'a cursor write carries the share token; an older owner\'s is refused `fenced`'),
                         Cmp('ahead', lambda w, st, b: b['p'], '>',
                             lambda w, st, b: self.rowval(st, self.owners[b['i']], b['s']), role='cursor',
                             note='the cursor row never moves back: gc applies a write only above its value')],
                        [U('write', cur, 'world')]))

        def crash(md, st, b, d):
            i = b['i']
            o = d.f['ds'][i]
            self.set_own(d, i, life=o[0] + 1, up=DOWN, pos=(), iss=(), held=())
            self.bump(d, C_F, C_RR)
        A.append(Action('crash', 'control', self.p_crash, [], [U('crash', crash, 'world')]))

        def notice(md, st, b, d):
            self.set_own(d, b['i'], up=DOWN, pos=(), iss=(), held=())
        A.append(Action('notice', 'deliver', self.p_notice, [], [U('stop', notice, 'world')]))

        def fail(md, st, b, d):
            self.end_loop(d, b['i'])
        A.append(Action('fail', 'tick', self.p_fail, [], [U('end', fail, 'world')]))

        # ---- the output slot's leader (L2)
        def eat(md, st, b, d):
            d.f['net'] = d.f['net'] - {b['m']}

        def gap_end(md, st, b, d):
            # LAYERS 3.3 and 8.8 step 7: the writer gets `gap`, and its loop ends with that error
            i, life = b['m'][1]
            o = d.f['ds'][i]
            if self.GAPEND and o[0] == life and o[1] == UP:
                self.end_loop(d, i)

        def inorder(w, st, b):
            return b['m'][3] == self.hi_of(st, b) + 1

        def setmark(md, st, b, d):
            d.f['_e']['mk'] = self.copy_mk(b['m'])

        def say(md, st, b, d):
            d.f['_e']['say'] = 'skip'

        def put(kind):
            def f(md, st, b, d):
                m = b['m']
                mk = d.f['_e'].get('mk')
                oid = m[4][1] if m[4][0] == 'o' else None
                x = m[6] if kind == 'w' else (d.f['_e'].get('say', 'ok') if kind == 'k' else None)
                if kind == 'w' and self.ENTRY != 'same' and mk is not None:
                    if self.ENTRY == 'first':
                        self.append(d, b['g'], ('M', None, m[2], None, mk, None, None))
                        self.append(d, b['g'], ('w', m[1], m[2], m[3], None, oid, x))
                    else:
                        self.append(d, b['g'], ('w', m[1], m[2], m[3], None, oid, x))
                        self.append(d, b['g'], ('M', None, m[2], None, mk, None, None))
                    return
                self.append(d, b['g'], (kind, m[1], m[2], m[3], mk, oid, x))
            return f

        A.append(Action('dup', 'deliver', self.p_copies,
                        [T('seen', lambda w, st, b: b['m'][3] <= self.hi_of(st, b), 'world')], [U('eat', eat, 'world')]))
        A.append(Action('gap', 'deliver', self.p_copies,
                        [T('ahead', lambda w, st, b: b['m'][3] > self.hi_of(st, b) + 1, 'world')],
                        [U('eat', eat, 'world'), U('end', gap_end, 'world')]))
        is_out = lambda w, st, b: b['m'][4][0] == 'o'
        is_bare = lambda w, st, b: b['m'][4][0] == 'm'
        A.append(Action('apply', 'deliver', self.p_copies,
                        [T('out', is_out, 'world'),
                         T('inorder', inorder, 'order', 'issue order: a writer\'s write n to a slot only after n-1'),
                         Cmp('above', lambda w, st, b: self.mk_of(st, b), '>', lambda w, st, b: self.mark_of(st, b),
                             role='dedup', note='apply only above the stored mark'),
                         T('holds', lambda w, st, b: not self.cond_fails(st, b), 'world'),
                         T('unfenced', lambda w, st, b: not self.stale(st, b), 'world')],
                        [U('eat', eat, 'world'),
                         U('mark', setmark, 'dedup', 'the mark goes in the output\'s own entry'),
                         U('append', put('w'), 'world')]))
        A.append(Action('skip', 'deliver', self.p_copies,
                        [T('inorder', inorder, 'order', 'issue order'),
                         Cmp('below', lambda w, st, b: self.mk_of(st, b), '<=', lambda w, st, b: self.mark_of(st, b),
                             role='dedup', note='skip a write at or below the stored mark')],
                        [U('eat', eat, 'world'),
                         U('say', say, 'answer', 'a skip answers `skipped` (handled before), never `applied`'),
                         U('append', put('k'), 'world')]))
        A.append(Action('refuse', 'deliver', self.p_copies,
                        [T('out', is_out, 'world'),
                         T('inorder', inorder, 'order', 'issue order'),
                         Cmp('above', lambda w, st, b: self.mk_of(st, b), '>', lambda w, st, b: self.mark_of(st, b),
                             role='dedup', note='only a write above the mark is judged'),
                         T('fails', lambda w, st, b: self.cond_fails(st, b), 'world')],
                        [U('eat', eat, 'world'),
                         U('mark', setmark, 'refusal', 'a marked write refused on its row still raises the mark: the refusal is final'),
                         U('append', put('r'), 'world')]))
        fen_up = [U('eat', eat, 'world')]
        if self.FENCED_MARK:
            fen_up.append(U('mark', setmark, 'refusal', 'a `fenced` refusal raises the mark too (the first design)'))
        fen_up.append(U('append', put('f'), 'world'))
        A.append(Action('fenced', 'deliver', self.p_copies,
                        [T('out', is_out, 'world'),
                         T('inorder', inorder, 'order', 'issue order'),
                         Cmp('above', lambda w, st, b: self.mk_of(st, b), '>', lambda w, st, b: self.mark_of(st, b),
                             role='dedup', note='only a write above the mark is judged'),
                         T('stale', lambda w, st, b: self.stale(st, b), 'world')],
                        fen_up))
        A.append(Action('bmark', 'deliver', self.p_copies,
                        [T('bare', is_bare, 'world'),
                         T('inorder', inorder, 'order', 'issue order'),
                         Cmp('above', lambda w, st, b: self.mk_of(st, b), '>', lambda w, st, b: self.mark_of(st, b),
                             role='dedup', note='a bare mark only raises the mark')],
                        [U('eat', eat, 'world'),
                         U('mark', setmark, 'bare', 'the bare mark\'s entry holds the mark'),
                         U('append', put('m'), 'world')]))
        A.extend(self.move_actions())
        return A

    # ---- a slot move (E-15's protocol, abstract, as E-30): what the fence carries
    def move_actions(self):
        def p_fence(md, st):
            if self.move and not any(e[0] == 'fence' for e in self.log(st, self.move[1])):
                yield {}

        def cmarks(md, st, b, d):
            P, a = self.move[0], self.move[1]
            keys = set()
            for e in self.log(st, a):
                if e[0] in MARKED and e[2] == P and e[4] is not None:
                    keys.add(self.mkey(e[4][0], e[4][1]))
            d.f['_e']['cm'] = frozenset((k, self.mark(st, a, k, P)) for k in keys)

        def coseq(md, st, b, d):
            P, a = self.move[0], self.move[1]
            ss = {e[1] for e in self.log(st, a) if e[0] in JUDGED and e[2] == P}
            d.f['_e']['co'] = frozenset((s, self.oseq(st, a, s, P)) for s in ss)

        def fence(md, st, b, d):
            self.append(d, self.move[1], ('fence', self.move[0], (d.f['_e'].get('cm', E), d.f['_e'].get('co', E))))

        def p_open(md, st):
            if not self.move or any(e[0] == 'open' for e in self.log(st, self.move[2])):
                return
            for e in self.com(st, self.move[1]):
                if e[0] == 'fence':
                    yield {'f': e}

        def take(md, st, b, d):
            d.f['_e']['carry'] = b['f'][2]

        def opn(md, st, b, d):
            self.append(d, self.move[2], ('open', self.move[0], d.f['_e'].get('carry', (E, E))))
        return [Action('fence', 'control', p_fence, [],
                       [U('carry', cmarks, 'carry', 'the fence carries the slot\'s marks'),
                        U('oseq', coseq, 'carry', 'the fence carries the slot\'s issue-order numbers'),
                        U('append', fence, 'world')]),
                Action('open', 'deliver', p_open, [],
                       [U('carry', take, 'carry', 'the open takes the carried state'), U('append', opn, 'world')])]

    # ------------------------------------------------------------ world
    def world(self, st):
        g, net, ds, floor, flag, hold, cnt = st
        out = []
        for i in range(len(GN)):
            com, tail, lost, cr = g[i]
            if tail:
                e = tail[0]
                ng = g[:i] + ((com + (e,), tail[1:], E, cr),) + g[i + 1:]
                out.append((('commit', GN[i], repr(e)), 'commit', self.norm((ng,) + st[1:])))
            if i in self.cgroups and cr < self.crashes and cnt[C_F] < self.faults and (tail or lost):
                cands = set()
                for src in (tail,) + tuple(lost):
                    for j in range(len(src) + 1):
                        cands.add(src[:j])
                cands.discard(tail)
                lost2 = (lost | {tail}) if tail else lost
                for c in sorted(cands, key=len):
                    ng = g[:i] + ((com, c, norm_lost(lost2, c), cr + 1),) + g[i + 1:]
                    c2 = cnt[:C_F] + (cnt[C_F] + 1,) + cnt[C_F + 1:]
                    out.append((('crash', GN[i], f'tail keeps {len(c)}'), 'fault',
                                self.norm((ng, net, ds, floor, flag, hold, c2))))
        if cnt[C_DR] < self.ndrops and cnt[C_F] < self.faults:
            c2 = list(cnt)
            c2[C_DR] += 1
            c2[C_F] += 1
            for m in net:
                out.append((('drop', repr(m)), 'fault', (g, net - {m}, ds, floor, flag, hold, tuple(c2))))
        if cnt[C_FL] < self.nflips:
            c2 = list(cnt)
            c2[C_FL] += 1
            out.append((('flip', not flag), 'control', (g, net, ds, floor, not flag, hold, tuple(c2))))
        if cnt[C_CU] < self.ncuts:
            for j, s in enumerate(self.slots_src):
                nf = floor[j] + 1
                if nf > self.src[s]:
                    continue
                if self.keep and any(self.rp(st, nm)[j] < nf for nm in self.names):
                    continue
                c2 = list(cnt)
                c2[C_CU] += 1
                f2 = floor[:j] + (nf,) + floor[j + 1:]
                out.append((('cut', s, nf), 'control', (g, net, ds, f2, flag, hold, tuple(c2))))
        if self.share and cnt[C_TK] < self.ntakes and cnt[C_F] < self.faults:
            h, tok = hold
            for j in range(len(self.owners)):
                if j != h and self.owners[j] == self.shared and ds[j][1] == DOWN:
                    c2 = list(cnt)
                    c2[C_TK] += 1
                    c2[C_F] += 1
                    out.append((('takeover', j), 'control', (g, net, ds, floor, flag, (j, tok + 1), tuple(c2))))
        return out

    # ------------------------------------------------------------ properties
    def counts(self, st):
        w, r = {}, set()
        for g in BG:
            for e in self.com(st, g):
                if e[0] == 'w':
                    w[e[5]] = w.get(e[5], 0) + 1
                elif e[0] == 'r':
                    r.add(e[5])
        return w, r

    def check(self, st):
        bad = []
        w, r = self.counts(st)
        if any(v > 1 for v in w.values()):
            bad.append('ONCE')
        if any(oid in w for oid in r):
            bad.append('STAND')
        if self.keep and any(o[1] == EXPIRED for o in st[IX['ds']]):
            bad.append('NOSTOP')
        if any(e[0] == 'k' and e[5] is not None and e[5] not in w and e[5] not in r
               for g in BG for e in self.com(st, g)):
            bad.append('HANDLED')
        for o in st[IX['ds']]:
            if o[1] == UP and any(x[3] == OK and x[2][0] == 'o' and x[2][1] not in w for x in o[3]):
                bad.append('ANSWER')
                break
        for nm in self.names:
            rp = self.rp(st, nm)
            for oid, (n2, s, q, P, c) in enumerate(self.outs):
                if n2 == nm and q < rp[self.si(s)] and oid not in w and oid not in r:
                    bad.append('LOST')
                    return bad
        return bad

    def check_edge(self, s, lab, kind, t):
        return []

    def reader_done(self, st, nm, w, r):
        if any(self.owners[i] == nm and o[1] == EXPIRED for i, o in enumerate(st[IX['ds']])):
            return not self.keep
        for oid, (n2, s, q, P, c) in enumerate(self.outs):
            if n2 != nm:
                continue
            if c == 'lock':
                if w.get(oid) != 1:                  # the holder's lock holds: its write must land
                    return False
            elif not (w.get(oid) == 1 or (oid in r and oid not in w)):
                return False
        rp = self.rp(st, nm)
        for j, s in enumerate(self.slots_src):
            n = self.src[s]
            need = (n - 1 if self.mode == 'derive' else n) if n else 0
            if rp[j] < need:
                return False
        return True

    def goals(self, st):
        w, r = self.counts(st)
        return {'DONE': all(self.reader_done(st, nm, w, r) for nm in self.names)}

    def judged(self, st):
        if self.SPENTEND:
            return {'DONE': True}
        # the first model's path: a write that spent its copies waits for ever, so DONE was not asked there
        ok = True
        for o in st[IX['ds']]:
            if o[1] == UP and any(x[3] == WAIT and x[4] >= self.cap for x in o[3]):
                ok = False
        return {'DONE': ok}


# ===================================================================== options
class Design(Marks):
    """The design as API.md 3.11, LAYERS 3.3 and 8.8 and PATTERNS 5 and 9 write it, with E-57 B5's write number,
    and the rules this experiment adds: a refusal on the row raises the mark, a `fenced` refusal does not, a skip
    answers `skipped`, the loop awaits fn, and an `expired` reader reads its marks again before it stops."""


def variant(name, **kw):
    return type(name, (Design,), kw)


OPTIONS = {
    'design': Design,
    # each structural rule removed, one at a time (the rule drops are the engine's)
    'mark-apart': variant('MarkApart', ENTRY='apart'),        # the mark in its own entry after the output
    'mark-first': variant('MarkFirst', ENTRY='first'),        # ... before the output
    'key-slot': variant('KeySlot', KEY='slot'),               # marks per source slot only, not per reader name
    'key-name': variant('KeyName', KEY='name'),               # marks per reader name only, not per source slot
    'no-wnum': variant('NoWnum', WNUM=False),                 # the mark without the write's number
    'nondet': variant('Nondet', NONDET=True),                 # app code: another call order on a re-run
    'unpaced': variant('Unpaced', UNPACED=True),              # as written: refused `backpressure`, loop goes on
    'marks-tail': variant('MarksTail', MARKS_TAIL=True),      # the loop reads marks() with the uncommitted tail
    'marks-marked': variant('MarksMarked', MARKS_MARKED=True),  # marks(): lowest over the slots that hold a mark
    'judge-com': variant('JudgeCom', JUDGE_COM=True),         # the leader checks committed marks only
    'skip-ahead': variant('SkipAhead', SKIPAHEAD=True),       # on `expired`, jump to the earliest kept record
    'no-bare': variant('NoBare', NOBARE=True),                # derive() without bare marks
    'fenced-mark': variant('FencedMark', FENCED_MARK=True),   # a `fenced` refusal raises the mark too
    # other paths (each should hold)
    'stop-refuse': variant('StopRefuse', STOPREFUSE=True),    # the loop ends on a refusal and is restarted
    'start-fresh': variant('StartFresh', START_FRESH=True),   # E-22's fresh cursor read (with cursor.ahead dropped)
    'resend-any': variant('ResendAny', WIRE='any', GAPEND=False, SPENTEND=False),   # the first model's path
    'marks-joined': variant('MarksJoined', MARKS_JOINED=True),  # marks() over joined slots only (an alternative)
}

_D = 'derive'
_R = 'run'
_PR = {'P': B0, 'R': B1}
_P = {'P': B0}
_2 = (('d', 'a1', 0, 'P', False), ('d', 'a1', 1, 'P', False))   # x0 and x1 write P
BOUNDS = {
    # derive(): a1 holds x0 (to P and R) and x1 (to P only, so R needs a bare mark); one restart
    'd-short': {'mode': _D, 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 0, 'R', False),
                                                      ('d', 'a1', 1, 'P', False)),
                'owners': ('d',), 'slots': _PR, 'line': 2, 'faults': 1, 'restarts': 1},
    # ... and a leader crash in b0 that loses an uncommitted tail
    'd-tail': {'mode': _D, 'src': {'a1': 2}, 'outs': _2,
               'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 1, 'crashes': 1},
    # ... and a lost copy
    'd-drop': {'mode': _D, 'src': {'a1': 2}, 'outs': _2,
               'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 1, 'drops': 1},
    # two outputs of one record in one slot (E-57 B5), a restart, and a lost tail
    'd-two': {'mode': _D, 'src': {'a1': 1}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 0, 'P', False)),
              'owners': ('d',), 'slots': _P, 'line': 1, 'faults': 2, 'restarts': 1, 'crashes': 1},
    # a write whose row condition fails, and may come true later; a restart
    'd-refuse': {'mode': _D, 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 1, 'P', True)),
                 'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'flips': 1},
    # ... the condition true at first, false later: a write applied once is never judged again
    'd-refuse2': {'mode': _D, 'src': {'a1': 1}, 'outs': (('d', 'a1', 0, 'P', True),), 'flag0': True,
                  'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'flips': 1},
    # R moves from b1 to b0 while the deriver may restart (E-30's bmove)
    'd-move': {'mode': _D, 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 0, 'R', False),
                                                     ('d', 'a1', 1, 'R', False)),
               'owners': ('d',), 'slots': _PR, 'move': ('R', B1, B0), 'line': 2, 'faults': 1, 'restarts': 1},
    # the share moves to another owner while the first runs on (a zombie); the source keeps its log back to
    # the marks and may cut up to them
    'd-share': {'mode': _D, 'src': {'a1': 2}, 'outs': _2,
                'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 0,
                'takes': 1, 'cuts': 2},
    # a record that writes nothing to R, then one that does: a bare mark must name only records already run
    'd-bare': {'mode': _D, 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 1, 'R', False)),
               'owners': ('d',), 'slots': {'P': B0, 'R': B0}, 'line': 2, 'faults': 1, 'restarts': 1},
    # the four lines run in two processes at once under one name, with no share between them
    'd-twice': {'mode': _D, 'src': {'a1': 2}, 'outs': _2,
                'owners': ('d', 'd'), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'cuts': 1},
    # two readers with different names write to one slot from one source slot
    'd-names': {'mode': _D, 'src': {'a1': 1}, 'outs': (('d', 'a1', 0, 'P', False), ('e', 'a1', 0, 'P', False)),
                'owners': ('d', 'e'), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1},
    # two source slots write to one output slot
    'd-slots': {'mode': _D, 'src': {'a1': 2, 'a2': 1}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 1, 'P', False),
                                                               ('d', 'a2', 0, 'P', False)),
                'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1},
    # the line holds one waiting write: pacing matters
    'd-pace': {'mode': _D, 'src': {'a1': 3}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 1, 'P', False),
                                                     ('d', 'a1', 2, 'P', False)),
               'owners': ('d',), 'slots': _P, 'line': 1, 'faults': 1, 'restarts': 1},
    # the source cuts its log anywhere, below the marks too
    'd-cut': {'mode': _D, 'src': {'a1': 2}, 'outs': _2,
              'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'cuts': 2, 'keep': False},
    # consumer().run(): the share's cursor in gc, no bare marks
    'r-short': {'mode': _R, 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 0, 'R', False),
                                                      ('d', 'a1', 1, 'P', False)),
                'owners': ('d',), 'slots': _PR, 'line': 2, 'faults': 1, 'restarts': 1},
    'r-tail': {'mode': _R, 'src': {'a1': 2}, 'outs': _2,
               'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 1, 'crashes': 1,
               'cgroups': (B0, GC)},
    'r-two': {'mode': _R, 'src': {'a1': 1}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 0, 'P', False)),
              'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1},
    'r-refuse': {'mode': _R, 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 1, 'P', True)),
                 'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'flips': 1},
    'r-share': {'mode': _R, 'src': {'a1': 2}, 'outs': _2,
                'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 0,
                'takes': 1, 'cuts': 2},
    'r-cut': {'mode': _R, 'src': {'a1': 2}, 'outs': _2,
              'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'cuts': 2, 'keep': False},
    # ---- added after the review
    # a lock condition on the outputs (`if: { lock }`, P-10) and a share move with the old owner running on
    'd-lock': {'mode': _D, 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'P', 'lock'), ('d', 'a1', 1, 'P', 'lock')),
               'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 0, 'takes': 1},
    'r-lock': {'mode': _R, 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'P', 'lock'), ('d', 'a1', 1, 'P', 'lock')),
               'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 0, 'takes': 1},
    # an async fn: it may await before it writes; a restart
    'd-async': {'mode': _D, 'src': {'a1': 3}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 1, 'P', False),
                                                      ('d', 'a1', 2, 'P', False)),
                'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'async': True},
    'r-async': {'mode': _R, 'src': {'a1': 2}, 'outs': _2,
                'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'async': True},
    # a refused write, then a second write of the same record to the same slot
    'd-refuse-then': {'mode': _D, 'src': {'a1': 1}, 'outs': (('d', 'a1', 0, 'P', True), ('d', 'a1', 0, 'P', False)),
                      'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'flips': 1},
    'r-refuse-then': {'mode': _R, 'src': {'a1': 1}, 'outs': (('d', 'a1', 0, 'P', True), ('d', 'a1', 0, 'P', False)),
                      'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'flips': 1},
    # the condition flips twice (false, true, false) around a restart
    'd-flip2': {'mode': _D, 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 1, 'P', True)),
                'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'flips': 2},
    # a share move with a lost tail
    'd-share-tail': {'mode': _D, 'src': {'a1': 2}, 'outs': _2,
                     'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 0,
                     'takes': 1, 'cuts': 2, 'crashes': 1},
    'r-share-tail': {'mode': _R, 'src': {'a1': 2}, 'outs': _2,
                     'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 0,
                     'takes': 1, 'cuts': 2, 'crashes': 1, 'cgroups': (B0, GC)},
    # a share move and a restart of an owner
    'd-share-restart': {'mode': _D, 'src': {'a1': 2}, 'outs': _2,
                        'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 1,
                        'takes': 1, 'cuts': 2},
    'r-share-restart': {'mode': _R, 'src': {'a1': 2}, 'outs': _2,
                        'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 1,
                        'takes': 1, 'cuts': 2},
    # a share move and a source that cuts anywhere
    'd-share-cut': {'mode': _D, 'src': {'a1': 2}, 'outs': _2,
                    'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 0,
                    'takes': 1, 'cuts': 2, 'keep': False},
    'r-share-cut': {'mode': _R, 'src': {'a1': 2}, 'outs': _2,
                    'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 0,
                    'takes': 1, 'cuts': 2, 'keep': False},
    # a share move with two writes of one record to one slot
    'd-share-two': {'mode': _D, 'src': {'a1': 1}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 0, 'P', False)),
                    'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 0,
                    'takes': 1},
    # a source that cuts up to the marks, and a lost tail
    'd-cut-tail': {'mode': _D, 'src': {'a1': 2}, 'outs': _2,
                   'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 1, 'crashes': 1, 'cuts': 2},
    'r-cut-tail': {'mode': _R, 'src': {'a1': 2}, 'outs': _2,
                   'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 1, 'crashes': 1, 'cuts': 2,
                   'cgroups': (B0, GC)},
    # three records, a share move, a lost tail and a cut up to the marks: a jump on `expired` must not read
    # marks from a tail that is then lost
    'd-share-cut-tail3': {'mode': _D, 'src': {'a1': 3}, 'outs': _2 + (('d', 'a1', 2, 'P', False),),
                          'owners': ('d', 'd'), 'share': True, 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 0,
                          'takes': 1, 'cuts': 2, 'crashes': 1},
    # two processes in run() (two cursor writers, no share), and a cut up to the cursor
    'r-twice': {'mode': _R, 'src': {'a1': 2}, 'outs': _2,
                'owners': ('d', 'd'), 'slots': _P, 'line': 2, 'faults': 1, 'restarts': 1, 'cuts': 1},
    # a share move during a slot move
    'd-share-move': {'mode': _D, 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 1, 'R', False)),
                     'owners': ('d', 'd'), 'share': True, 'slots': _PR, 'move': ('R', B1, B0), 'line': 2,
                     'faults': 1, 'restarts': 0, 'takes': 1, 'cuts': 1},
    # a lost copy where a bare mark is due: x0 writes P and R, x1 writes P only (as d-short), one copy lost
    'd-bare-drop': {'mode': _D, 'src': {'a1': 2}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 0, 'R', False),
                                                          ('d', 'a1', 1, 'P', False)),
                    'owners': ('d',), 'slots': _PR, 'line': 2, 'faults': 2, 'restarts': 1, 'drops': 1},
    # a lost copy, then a write of the same record to the same slot whose row condition fails
    'd-refuse-drop': {'mode': _D, 'src': {'a1': 1}, 'outs': (('d', 'a1', 0, 'P', False), ('d', 'a1', 0, 'P', True)),
                      'owners': ('d',), 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 1, 'drops': 1},
    # two processes and a lost tail
    'd-twice-tail': {'mode': _D, 'src': {'a1': 2}, 'outs': _2,
                     'owners': ('d', 'd'), 'slots': _P, 'line': 2, 'faults': 2, 'restarts': 1, 'cuts': 1, 'crashes': 1},
}
CORE = ('d-short', 'd-tail', 'd-drop', 'd-two', 'd-refuse', 'd-refuse2', 'd-move', 'd-share', 'd-bare', 'd-twice',
        'd-names', 'd-slots', 'd-pace', 'd-cut', 'r-short', 'r-tail', 'r-two', 'r-refuse', 'r-share', 'r-cut')
ADDED = tuple(b for b in BOUNDS if b not in CORE)
ALL = tuple(BOUNDS)
# The ablation's bounds, about smallest first (by the design's state count), so a rule's first break is found
# cheaply and on a small bound; the two biggest (874,075 and 1,092,334 states) are its verify bounds: the
# smallest model and each mutant that no sweep bound catches run there in full. `d-bare-drop` and
# `d-refuse-drop` were added last: the first when the ablation dropped both order rules of a bare mark together,
# the second when the seeded runs broke without `refuse.inorder` and no bound did.
SWEEP = ('d-refuse2', 'r-two', 'd-pace', 'd-share-two', 'd-refuse-then', 'd-names', 'd-lock', 'd-share',
         'r-refuse-then', 'd-refuse', 'd-refuse-drop', 'd-cut', 'd-flip2', 'd-async', 'r-async', 'd-drop', 'r-lock', 'd-share-cut',
         'd-two', 'r-refuse', 'r-short', 'r-share', 'r-cut', 'd-tail', 'd-cut-tail', 'd-short', 'd-slots',
         'r-share-cut', 'r-tail', 'r-cut-tail', 'd-share-tail', 'd-twice', 'd-bare-drop', 'd-share-restart',
         'r-share-tail', 'd-bare',
         'd-move', 'r-twice', 'd-share-cut-tail3', 'r-share-restart')
VERIFY = ('d-share-move', 'd-twice-tail')
assert sorted(SWEEP + VERIFY) == sorted(ALL)
PIN = ('start.read', 'read.run', 'resend.send', 'emit.send', 'cursor.write', 'crash.crash', 'notice.stop', 'fail.end',
       'dup.seen', 'dup.eat', 'gap.ahead', 'gap.eat', 'gap.end', 'apply.out', 'apply.holds', 'apply.unfenced',
       'apply.eat', 'apply.append', 'skip.eat', 'skip.append', 'refuse.out', 'refuse.fails', 'refuse.eat',
       'refuse.append', 'fenced.out', 'fenced.stale', 'fenced.eat', 'fenced.append', 'bmark.bare', 'bmark.eat',
       'bmark.append', 'fence.append', 'open.append')
PINNED = {k: PIN for k in OPTIONS}

# ===================================================================== seeded walks (harness/walk.py)
# Bigger worlds than an exhaustive run can hold: every fault at once, walked at random from a seed, then
# calm steps until nothing is left to do. The same model code, the same properties.
_W_OUTS = (
    ('d', 'a1', 0, 'P', False), ('d', 'a1', 0, 'R', False),          # x0: two slots
    ('d', 'a1', 1, 'P', False), ('d', 'a1', 1, 'P', True),           # x1: two writes to P, the second with a condition
    ('d', 'a1', 3, 'Q', False), ('d', 'a1', 3, 'P', 'lock'),         # x2 writes nothing (a bare mark's case); x3: Q,
                                                                     #   and P under the share's lock
    ('d', 'a1', 4, 'R', False), ('d', 'a1', 4, 'Q', True),           # x4: R, and Q with a condition
    ('d', 'a2', 0, 'Q', False), ('d', 'a2', 1, 'P', False),          # a second source slot
    ('e', 'a1', 0, 'P', False), ('e', 'a1', 2, 'Q', False),          # a second reader name, same slots
)
_W = {'src': {'a1': 5, 'a2': 2}, 'outs': _W_OUTS, 'owners': ('d', 'd', 'e'), 'share': True,
      'slots': {'P': B0, 'R': B1, 'Q': B1}, 'move': ('Q', B1, B0), 'line': 2, 'cap': 3, 'async': True,
      'faults': 9, 'restarts': 3, 'crashes': 2, 'drops': 3, 'flips': 2, 'takes': 1, 'cgroups': (B0, B1, GC)}
WALKS = {
    'w-derive': dict(_W, mode=_D, cuts=3, keep=True),
    'w-run': dict(_W, mode=_R, cuts=3, keep=True),
    'w-derive-cut': dict(_W, mode=_D, cuts=4, keep=False),
    'w-run-cut': dict(_W, mode=_R, cuts=4, keep=False),
}
