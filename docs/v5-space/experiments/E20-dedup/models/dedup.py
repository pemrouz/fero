"""
dedup.py: E-20's model. Which dedup option holds exactly once with the
fewest rules, across lost answers, failover, a slot move, a refusal followed
by a stale copy, a client restart and expiry by the writer's time; and does
routing through a non-leader server (Y `fwd`) need a rule that sending
straight to the leader (Y `smart`) does not?

It runs on E-16's engine (../../E16-controller-loop/engine/engine.py), which
uses E-17's shared rule language (E17-partitioning/harness/dsl.py) unchanged:
a rule is one guard conjunct or one state update, and ablation and mutants
are E-17's procedure (DEV-10). Like E-16 and E-33, this model brings its own
world: E-17's world lets any copy of an attempt reach any group any number
of times, which no dedup design that leans on TCP can survive by itself.

THE WORLD (shared by every option; its steps are not counted as rules).
  Groups g0, g1 (data) and #s (a registry: sessions or producer ids). Each
  is an abstract Raft group as in E-17: a committed log, the leader's
  uncommitted tail, tails lost by earlier leaders (one may come back until
  the next commit), and a crash count. A crash deposes the leader: the new
  tail is a prefix of the old one or of a lost one.
  Two slots: s1 always in g0; s2 starts in g0 and may move to g1. The move
  protocol itself is E-15's and E-17's: here g0 appends a fence (it stops
  writing s2 at once, from its log end) and g1 appends `open` once g0's
  fence has committed. Which dedup state the fence carries to g1 is the
  option's rule.
  One client with a plan of attempts (each on a slot, each may be refused
  by a condition, which the writer decides freely). Every attempt is sent
  as copies; a copy is a message delivered at most once (TCP does not
  duplicate), after any delay, or lost (a fault). Under `fwd` the client's
  copy goes to a relay (any server), which forwards it to the slot's
  writer; under `smart` it goes straight to the writer.
  Answers: an answer from the writer's committed state (the outcome in the
  writer's fold: the reply to the waiting request, or a later dedup hit) is
  `learn`; an answer not in the log (a first send's refusal, a stale
  attempt, an expired session) is a message that may be lost.
  A global clock `now` (writer time is `now`; E-21 owns clock faults).
  A client restart (a fault): the process dies; its copies stay in flight.

GHOSTS (the truth the properties read; no rule reads them). Every attempt
has a ghost id (life, n); a write entry carries its ghost id. `told` holds
the answers the client accepted.

PROPERTIES
  ONCE     no attempt has two committed writes (F-02).
  REFUSED  an attempt the client was told `refused` never has a committed
           write, before or after (F-02).
  TRUE     an attempt the client was told `applied` has a committed write
           of its own (a wire id reused by a new life is caught here).
  L7       AG EF over calm steps: every attempt of the client's current life
           ends (applied, refused or unknown), from every state judged.

OPTIONS (SPACE.md axis D), each with Y `smart` and Y `fwd`:
  win    the draft (DESIGN-V5 4.3): attempt id (issuer, call id), issuer =
         process + life; per issuer and shard the highest id seen and the
         outcomes above the floor (highest - W); the issuer's window
         promise; a resend's refusal appended; issuers forgotten after the
         horizon H by writer time; per-hop time budgets; stop retrying after
         R; outcomes and highest ids carried by a slot move, merged by max.
  sess   client sessions (Raft thesis 6.3, LogCabin): a session id
         registered in #s, renewed by the client; per session the outcomes
         at or above the client's lowest unacknowledged id L (sent with each
         copy); a session expires in #s by #s's writer time; a writer
         answers `unknown` for an expired session and never judges it
         afresh; outcomes and floors carried by a slot move.
  pid    Kafka's idempotent producer (KIP-98, KIP-360): a producer id from
         #s; per (producer, partition) a gapless sequence; the writer keeps
         the last sequence and its outcome; accept next, absorb duplicates,
         refuse out of order; an unknown producer is accepted only at
         sequence 0; producer state forgotten after P; every refusal is
         appended (else the sequence would gap); the client sends one
         attempt at a time per partition and stops retrying after R
         (delivery.timeout.ms); state per (producer, partition) carried by
         the move.
  keys   idempotency keys (Stripe, SQS): every write carries a unique key;
         the writer keeps each key's outcome for TTL by writer time; no
         window, no floor; budgets and a stop-retry time as win.

PINNED (written as rules, never dropped or mutated, and not counted): the
world's bookkeeping (the client's statuses, a copy taken off the wire, the
append of the write itself), the memory bounds each design states (win's
forgetting, sess's expiry, pid's and keys' forgetting, sess's client floor
L), and each design's answers at once (a first send's refusal not
appended, `stale-attempt`, `unknown` for an expired session). Without them,
ablation would find a slower or unbounded design; with them, it finds the
safety rules each design as written needs.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

E = frozenset()
FIELDS = ('g', 'now', 'net', 'cl', 'told', 'faults', 'rr', 'drops')
IX = {f: i for i, f in enumerate(FIELDS)}
G0, G1, GS = 0, 1, 2
GN = ('g0', 'g1', '#s')
DATA = (G0, G1)
IDLE, PEND, APPLIED, REFUSED, UNKNOWN, NONE = 0, 1, 2, 3, 4, 5
NEG = -99


def norm_lost(lost, tail):
    """E-17's rule: keep the lost tails that could still come back."""
    keep = []
    for g in lost:
        if not g or tail[:len(g)] == g:
            continue
        if any(h != g and h[:len(g)] == g for h in lost):
            continue
        keep.append(g)
    return frozenset(keep)


def T(name, fn, role='', note=''):
    return Guard(name, fn, role=role, note=note)


def U(name, fn, role='', note=''):
    return Update(name, fn, role=role, note=note)


# message layout: ('c' | 'x', wid, gid, slot, k, r, s, extra)
#   'c' on the wire to a writer, 'x' held by a relay (fwd)
#   wid: the wire id the writer sees; gid: the ghost id (life, n)
#   k: copy number; r: 1 if a resend; s: the copy's send time (its budget's
#   start); extra: sess's L (the client's lowest unacknowledged id)
# answer: ('a', code, gid, k), code 'r' refused, 's' stale, 'x' unknown
# entry: ('w' | 'r', wid, slot, t, gid, extra)


class Dedup:
    CALM = ('deliver', 'tick', 'time', 'commit')
    INFO = ()
    ROUTE = 'smart'
    W = 1          # win's issuer window (call ids span less than W)
    R = 1          # stop retrying an attempt R after its first send (half the horizon)
    B = 1          # a copy's time budget (every hop subtracts what it held)
    H = 1          # forget an issuer silent for H (win), a producer (pid), a key's TTL (keys)
    S = 1          # sess: a session not renewed for S expires

    def __init__(self, bound):
        self.b = bound
        self.plan = tuple(bound['att'])            # slot per planned attempt
        self.cap = bound.get('cap', 3)             # copies per attempt
        self.tmax = bound.get('tmax', 0)
        self.crashes = bound.get('crashes', 1)     # per group
        self.faults = bound.get('faults', 1)       # crashes + restarts + drops, all groups
        self.ndrops = bound.get('drops', 1)
        self.restarts = bound.get('restarts', 0)
        self.move = bound.get('move', False)
        self.serial = bound.get('serial', False)
        self.replan = bound.get('replan', True)
        self.fwd = self.ROUTE == 'fwd'

    # ------------------------------------------------------------ state
    def init(self):
        g = tuple(((), (), E, 0) for _ in GN)
        n = len(self.plan)
        cl = (0, (IDLE,) * n, (0,) * n, (0,) * n, 0)
        return (g, 0, E, cl, E, 0, 0, 0)

    def to_draft(self, st):
        d = dict(zip(FIELDS, st))
        d['_e'] = {}
        return d

    def freeze(self, d):
        # World normalisation (not a rule): an answer message for an attempt
        # that is not pending in the client's current life can never be
        # taken (recv reads only pending attempts of the current life), so
        # it is removed; it changes no step any rule can take.
        f = d.f
        rr = f['rr']
        stat = f['cl'][1]
        net = f['net']
        dead = [m for m in net if m[0] == 'a' and (m[2][0] != rr or stat[m[2][1]] != PEND)]
        if dead:
            f['net'] = net - frozenset(dead)
        return tuple(f[x] for x in FIELDS)

    # ------------------------------------------------------------ views
    @staticmethod
    def log(st, g):
        grp = st[0][g]
        return grp[0] + grp[1]

    @staticmethod
    def com(st, g):
        return st[0][g][0]

    def owns(self, st, g, slot):
        """World: the writer of g holds `slot` open, by its log end."""
        if slot == 's1':
            return g == G0
        if g == G0:
            return not any(e[0] == 'fence' for e in self.log(st, G0))
        return any(e[0] == 'open' for e in self.log(st, G1))

    def life(self, st):
        return st[IX['cl']][0]

    def stat(self, st, n):
        return st[IX['cl']][1][n]

    def kk(self, st, n):
        return st[IX['cl']][2][n]

    def t0(self, st, n):
        return st[IX['cl']][3][n]

    def gid(self, st, n):
        return (st[IX['rr']], n)

    def append(self, d, g, entry):
        groups = list(d.f['g'])
        com, tail, lost, cr = groups[g]
        if entry in com or entry in tail:
            return
        groups[g] = (com, tail + (entry,), lost, cr)
        d.f['g'] = tuple(groups)

    def send_msg(self, d, msg):
        d.f['net'] = d.f['net'] | {msg}

    def eat(self, d, msg):
        d.f['net'] = d.f['net'] - {msg}

    def set_cl(self, d, part, n, v):
        cl = list(d.f['cl'])
        x = list(cl[part])
        x[n] = v
        cl[part] = tuple(x)
        d.f['cl'] = tuple(cl)

    def tell(self, d, gid, what):
        d.f['told'] = d.f['told'] | {(gid, what)}

    # ------------------------------------------------------------ option hooks
    def wid(self, st, n):
        raise NotImplementedError

    def extra(self, st, n, d=None):
        return None

    def outcome(self, st, g, m_or_wid, committed):
        """The outcome ('w' or 'r') the writer of g holds for this wire id in
        its fold (log end, or committed), or None."""
        raise NotImplementedError

    def actions(self):
        raise NotImplementedError

    # ------------------------------------------------------------ shared params
    def p_send(self, md, st):
        """The next idle attempt of the current life (the plan's order). In
        a `serial` bound the client sends one attempt at a time (a bound on
        the world, to keep timed runs small, not a rule)."""
        stat = st[IX['cl']][1]
        if self.serial and PEND in stat:
            return
        for n, s in enumerate(stat):
            if s == IDLE:
                yield {'n': n}
                return

    def p_pending(self, md, st):
        stat = st[IX['cl']][1]
        for n, s in enumerate(stat):
            if s == PEND:
                yield {'n': n}

    def p_resend(self, md, st):
        stat = st[IX['cl']][1]
        for n, s in enumerate(stat):
            if s == PEND and st[IX['cl']][2][n] < self.cap:
                yield {'n': n}

    def p_copies(self, md, st):
        """Every copy on the wire x every data group that holds its slot."""
        for m in st[IX['net']]:
            if m[0] == 'c':
                for g in DATA:
                    if self.owns(st, g, m[3]):
                        yield {'m': m, 'g': g}

    def p_relay(self, md, st):
        for m in st[IX['net']]:
            if m[0] == 'x':
                yield {'m': m}

    def p_answers(self, md, st):
        life_rr = st[IX['rr']]
        for m in st[IX['net']]:
            if m[0] == 'a' and m[2][0] == life_rr and self.stat(st, m[2][1]) == PEND:
                yield {'m': m}

    def p_learn(self, md, st):
        """A pending attempt x a data group whose committed fold holds an
        outcome for its wire id (the reply to the waiting request, or a dedup
        hit; never a raw log entry the fold has dropped)."""
        for n, s in enumerate(st[IX['cl']][1]):
            if s != PEND:
                continue
            w = self.wid(st, n)
            slot = self.plan[n]
            for g in DATA:
                o = self.outcome(st, g, (w, slot), True)
                if o is not None:
                    yield {'n': n, 'g': g, 'o': o}

    # ------------------------------------------------------------ shared actions
    TIMED = True     # False: no rule reads a copy's send time or an entry's time
    APPEND_ALL = False   # True: every refusal is appended (no answer outside the log for a first send)

    def copy_msg(self, st, b, d, r):
        n = b['n']
        e = d.f['_e']
        k = self.kk(st, n) + (1 if r else 0)
        if not r:
            k = 1
        return ('x' if self.fwd else 'c', self.wid(st, n), self.gid(st, n), self.plan[n], k, r,
                st[IX['now']] if self.TIMED else 0, e.get('L'))

    def a_send(self, guards=(), extra_updates=()):
        def upd_status(md, st, b, d):
            self.set_cl(d, 1, b['n'], PEND)
            self.set_cl(d, 2, b['n'], 1)
            self.set_cl(d, 3, b['n'], st[IX['now']])

        def upd_emit(md, st, b, d):
            self.send_msg(d, self.copy_msg(st, b, d, 0))
        return Action('send', 'deliver', self.p_send, list(guards),
                      list(extra_updates) + [U('status', upd_status, 'world'), U('emit', upd_emit, 'world')])

    def a_resend(self, guards=(), extra_updates=()):
        def upd_k(md, st, b, d):
            self.set_cl(d, 2, b['n'], self.kk(st, b['n']) + 1)

        def upd_emit(md, st, b, d):
            self.send_msg(d, self.copy_msg(st, b, d, 1))
        return Action('resend', 'tick', self.p_resend, list(guards),
                      list(extra_updates) + [U('k', upd_k, 'world'), U('emit', upd_emit, 'world')])

    def a_recv(self):
        """The client takes an answer message for one of its pending attempts."""
        def upd(md, st, b, d):
            m = b['m']
            n = m[2][1]
            code = m[1]
            if code in ('r', 's'):
                self.set_cl(d, 1, n, REFUSED)
                self.tell(d, m[2], 'R')
            else:
                self.set_cl(d, 1, n, UNKNOWN)
                if not self.unknown_ok(st, n):
                    self.tell(d, m[2], 'U!')      # ghost: `unknown` before the design allows it

        def upd_eat(md, st, b, d):
            self.eat(d, b['m'])
        return Action('recv', 'deliver', self.p_answers,
                      [Cmp('latest', lambda w, st, b: b['m'][3], '>=', lambda w, st, b: self.kk(st, b['m'][2][1]),
                           role='answer', note='accept only the answer to the latest copy')],
                      [U('status', upd, 'world'), U('eat', upd_eat, 'world')])

    def a_learn(self):
        def upd(md, st, b, d):
            n = b['n']
            if b['o'] == 'w':
                self.set_cl(d, 1, n, APPLIED)
                self.tell(d, self.gid(st, n), 'A')
            else:
                self.set_cl(d, 1, n, REFUSED)
                self.tell(d, self.gid(st, n), 'R')
        return Action('learn', 'deliver', self.p_learn, [], [U('status', upd, 'world')])

    def a_forward(self, guards=(), extra_updates=(), once=True):
        """fwd: a relay forwards a held copy to the slot's writer."""
        def upd_emit(md, st, b, d):
            m = b['m']
            s = d.f['_e'].get('s', st[IX['now']])
            self.send_msg(d, ('c',) + m[1:6] + (s,) + m[7:])

        def upd_once(md, st, b, d):
            self.eat(d, b['m'])
        ups = list(extra_updates) + [U('emit', upd_emit, 'world')]
        if once:
            ups.append(U('once', upd_once, 'hop', 'a relay forwards a copy once (only over the link it had)'))
        return Action('forward', 'deliver', self.p_relay, list(guards), ups)

    def a_restart(self):
        def upd_life(md, st, b, d):
            cl = d.f['cl']
            d.f['cl'] = (cl[0] + 1,) + cl[1:]

        def upd_reset(md, st, b, d):
            cl = d.f['cl']
            n = len(self.plan)
            # the new life runs the plan again, or (bound `replan`: False)
            # sends nothing: the bound then only asks what the old life's
            # copies do
            s0 = IDLE if self.replan else NONE
            d.f['cl'] = (cl[0], (s0,) * n, (0,) * n, (0,) * n, cl[4])
            d.f['rr'] = d.f['rr'] + 1
            d.f['faults'] = d.f['faults'] + 1

        def p(md, st):
            if st[IX['rr']] < self.restarts and st[IX['faults']] < self.faults:
                yield {}
        return Action('restart', 'control', p, [],
                      [U('life', upd_life, 'dedup', 'a restarted process takes a new issuer id (its life)'),
                       U('reset', upd_reset, 'world')])

    # ------------------------------------------------------------ the world
    def world(self, st):
        g, now, net, cl, told, faults, rr, drops = st
        out = []
        for i in range(len(GN)):
            com, tail, lost, cr = g[i]
            if tail:
                e = tail[0]
                ng = g[:i] + ((com + (e,), tail[1:], E, cr),) + g[i + 1:]
                out.append((('commit', GN[i], self.show(e)), 'commit', (ng,) + st[1:]))
            if cr < self.crashes and faults < self.faults and (tail or lost):
                cands = set()
                for src in (tail,) + tuple(lost):
                    for j in range(len(src) + 1):
                        cands.add(src[:j])
                cands.discard(tail)
                lost2 = (lost | {tail}) if tail else lost
                for c in sorted(cands, key=len):
                    ng = g[:i] + ((com, c, norm_lost(lost2, c), cr + 1),) + g[i + 1:]
                    out.append((('crash', GN[i], f'tail keeps {len(c)}'), 'fault',
                                (ng, now, net, cl, told, faults + 1, rr, drops)))
        if drops < self.ndrops and faults < self.faults:
            for m in net:
                out.append((('drop', self.show(m)), 'fault',
                            (g, now, net - {m}, cl, told, faults + 1, rr, drops + 1)))
        if now < self.tmax:
            out.append((('tick', now + 1), 'time', (g, now + 1, net, cl, told, faults, rr, drops)))
        return out

    def show(self, x):
        return repr(x)

    # ------------------------------------------------------------ properties
    def writes(self, st):
        """ghost id -> number of committed writes, over every group."""
        cnt = {}
        for i in DATA:
            for e in self.com(st, i):
                if e[0] == 'w':
                    cnt[e[4]] = cnt.get(e[4], 0) + 1
        return cnt

    def check(self, st):
        bad = []
        cnt = self.writes(st)
        if any(v > 1 for v in cnt.values()):
            bad.append('ONCE')
        told = st[IX['told']]
        if any(w == 'R' and cnt.get(gid, 0) for gid, w in told):
            bad.append('REFUSED')
        if any(w == 'A' and not cnt.get(gid, 0) for gid, w in told):
            bad.append('TRUE')
        return bad

    def check_edge(self, s, lab, kind, t):
        return []

    def goals(self, st):
        # every attempt of the current life ends, and none ended `unknown`
        # before the design allows (API.md: fero keeps retrying until a
        # definite answer or half the horizon; an expired session or a
        # forgotten producer is the other way to `unknown`)
        return {'L7': all(x not in (IDLE, PEND) for x in st[IX['cl']][1]) and
                not any(w == 'U!' for _, w in st[IX['told']])}

    def unknown_ok(self, st, n):
        """May attempt n end `unknown` by an answer now? (sess: its session
        expired; pid: its producer state was forgotten.)"""
        return False

    def giveup_update(self):
        def giveup(md, st, b, d):
            n = b['n']
            self.set_cl(d, 1, n, UNKNOWN)
            if st[IX['now']] - self.t0(st, n) < self.R:
                self.tell(d, self.gid(st, n), 'U!')     # ghost: gave up before the horizon
        return U('status', giveup, 'world')

    def judged(self, st):
        # Judged where the client's resends cannot have run out: every
        # pending attempt has a copy left (the bound's cap, not a rule).
        cl = st[IX['cl']]
        return {'L7': all(cl[2][n] < self.cap for n, s in enumerate(cl[1]) if s == PEND)}


# ======================================================================= win
class Win(Dedup):
    """DESIGN-V5 4.3 as written (D `win`)."""

    def iss(self, st):
        return ('i', self.life(st))

    def wid(self, st, n):
        return (self.iss(st), n)

    def fold(self, st, g, committed):
        """issuer -> (outs {n: (kind, slot)} above the floor, hi, last_t)."""
        ents = self.com(st, g) if committed else self.log(st, g)
        v = {}
        for e in ents:
            if e[0] in ('w', 'r'):
                iss, n = e[1]
                o, hi, lt = v.get(iss, ({}, NEG, NEG))
                o = dict(o)
                o[n] = (e[0], e[2])
                v[iss] = (o, max(hi, n), max(lt, e[3]))
            elif e[0] == 'fg':
                v.pop(e[1], None)
            elif e[0] == 'open':
                _, slot, outs, his, t = e
                for (iss, n), kind in outs:
                    o, hi, lt = v.get(iss, ({}, NEG, NEG))
                    o = dict(o)
                    o[n] = (kind, slot)
                    v[iss] = (o, hi, max(lt, t))
                for iss, h in his:
                    o, hi, lt = v.get(iss, ({}, NEG, NEG))
                    v[iss] = (o, max(hi, h), max(lt, t))
        out = {}
        for iss, (o, hi, lt) in v.items():
            floor = hi - self.W
            out[iss] = ({n: x for n, x in o.items() if n > floor}, hi, lt)
        return out

    def outcome(self, st, g, ws, committed):
        (iss, n), slot = ws
        f = self.fold(st, g, committed).get(iss)
        if f is None:
            return None
        x = f[0].get(n)
        return x[0] if x else None

    def hi(self, st, g, iss):
        f = self.fold(st, g, False).get(iss)
        return f[1] if f else NEG

    def notin(self, w, st, b):
        m = b['m']
        return self.outcome(st, b['g'], (m[1], m[3]), False) is None

    def actions(self):
        W, R, B, H = self.W, self.R, self.B, self.H
        now = lambda w, st, b: st[IX['now']]
        age = lambda w, st, b: st[IX['now']] - b['m'][6]
        idn = lambda w, st, b: b['m'][1][1]
        floor = lambda w, st, b: self.hi(st, b['g'], b['m'][1][0]) - W
        A = []

        def window(w, st, b):
            # the issuer's window: call ids span less than W; with W = 1 the
            # earlier attempt is answered first
            n = b['n']
            return all(self.stat(st, j) not in (IDLE, PEND) for j in range(max(0, n - W + 1)))
        A.append(self.a_send([T('window', window, 'dedup', 'issuer window: ids span less than W')]))
        A.append(self.a_resend([Cmp('horizon', lambda w, st, b: st[IX['now']] - self.t0(st, b['n']), '<',
                                    lambda w, st, b: R, role='time', note='stop retrying R (half the horizon) after the first send')]))

        def giveup_p(md, st):
            yield from self.p_pending(md, st)

        A.append(Action('giveup', 'tick', giveup_p,
                        [Cmp('late', lambda w, st, b: st[IX['now']] - self.t0(st, b['n']), '>=', lambda w, st, b: R,
                             role='time', note='after R the attempt ends unknown')],
                        [self.giveup_update()]))
        A.append(self.a_recv())
        A.append(self.a_learn())
        if self.fwd:
            def stamp(md, st, b, d):
                d.f['_e']['s'] = b['m'][6]
            A.append(self.a_forward([Cmp('budget', age, '<', lambda w, st, b: B, role='hop',
                                         note='a relay forwards only within the budget')],
                                    [U('age', stamp, 'hop', 'a relay subtracts the time it held the copy')]))
        A.append(self.a_restart())

        eat = U('eat', lambda md, st, b, d: self.eat(d, b['m']), 'world')

        def judge(name, extra_guards, ups, budget=True):
            gs = [T('notin', self.notin, 'dedup', 'not among the outcomes (log end)'),
                  Cmp('floor', idn, '>', floor, role='dedup', note='above the floor (highest - W)')]
            if budget:
                gs.append(Cmp('budget', age, '<', lambda w, st, b: B, role='hop', note='the copy\'s budget is not spent'))
            return Action(name, 'deliver', self.p_copies, gs + list(extra_guards),
                          [U('eat', lambda md, st, b, d: self.eat(d, b['m']), 'world')] + list(ups))

        def app(kind):
            def f(md, st, b, d):
                m = b['m']
                self.append(d, b['g'], (kind, m[1], m[3], st[IX['now']], m[2], None))
            return f
        A.append(judge('apply', [], [U('append', app('w'), 'world')]))
        if self.APPEND_ALL:
            A.append(judge('refuse_r', [], [U('append', app('r'), 'world')]))
        else:
            A.append(judge('refuse_r', [T('resend', lambda w, st, b: b['m'][5] == 1, 'perf',
                                          'only a resend\'s refusal is appended')],
                           [U('append', app('r'), 'world')]))
            A.append(judge('refuse_f', [T('first', lambda w, st, b: b['m'][5] == 0, 'dedup',
                                          'a refusal not appended only for a first send')],
                           [U('emit', lambda md, st, b, d: self.send_msg(d, ('a', 'r', b['m'][2], b['m'][4])), 'perf')]))
        # stale-attempt: at or below the floor and not among the outcomes
        A.append(Action('stale', 'deliver', self.p_copies,
                        [T('notin', self.notin, 'dedup', 'not among the outcomes'),
                         Cmp('floor', idn, '<=', floor, role='dedup', note='at or below the floor')],
                        [eat, U('emit', lambda md, st, b, d: self.send_msg(d, ('a', 's', b['m'][2], b['m'][4])), 'perf')]))
        A.append(Action('dup', 'deliver', self.p_copies,
                        [T('in', lambda w, st, b: not self.notin(w, st, b), 'world')],
                        [U('eat', lambda md, st, b, d: self.eat(d, b['m']), 'world')]))

        # forgetting: an issuer silent for H, by the writer's time
        def p_forget(md, st):
            for g in DATA:
                for iss in self.fold(st, g, False):
                    yield {'g': g, 'iss': iss}

        def forget(md, st, b, d):
            self.append(d, b['g'], ('fg', b['iss'], st[IX['now']]))
        A.append(Action('forget', 'tick', p_forget,
                        [Cmp('silent', lambda w, st, b: st[IX['now']] - self.fold(st, b['g'], False)[b['iss']][2], '>=',
                             lambda w, st, b: H, role='time', note='forget an issuer silent for the horizon')],
                        [U('append', forget, 'mem')]))
        A.extend(self.move_actions())
        return A

    def move_actions(self):
        def p_fence(md, st):
            if self.move and not any(e[0] == 'fence' for e in self.log(st, G0)):
                yield {}

        def outs(md, st, b, d):
            f = self.fold(st, G0, False)
            d.f['_e']['outs'] = frozenset(((iss, n), x[0]) for iss, (o, hi, lt) in f.items()
                                          for n, x in o.items() if x[1] == 's2')

        def his(md, st, b, d):
            f = self.fold(st, G0, False)
            d.f['_e']['hi'] = frozenset((iss, hi) for iss, (o, hi, lt) in f.items())

        def fence(md, st, b, d):
            e = d.f['_e']
            self.append(d, G0, ('fence', 's2', e.get('outs', E), e.get('hi', E)))

        def p_open(md, st):
            if any(e[0] == 'open' for e in self.log(st, G1)):
                return
            for e in self.com(st, G0):
                if e[0] == 'fence':
                    yield {'f': e}

        def oouts(md, st, b, d):
            d.f['_e']['outs'] = b['f'][2]

        def ohi(md, st, b, d):
            d.f['_e']['hi'] = b['f'][3]

        def opn(md, st, b, d):
            e = d.f['_e']
            self.append(d, G1, ('open', 's2', e.get('outs', E), e.get('hi', E), st[IX['now']]))
        return [Action('fence', 'control', p_fence, [],
                       [U('outs', outs, 'carry', 'the fence carries the slot\'s outcomes'),
                        U('hi', his, 'carry', 'the fence carries each issuer\'s highest id'),
                        U('append', fence, 'world')]),
                Action('open', 'deliver', p_open, [],
                       [U('outs', oouts, 'carry', 'open takes the carried outcomes'),
                        U('hi', ohi, 'carry', 'open takes the carried highest ids (merged by max)'),
                        U('append', opn, 'world')])]


class WinFwd(Win):
    ROUTE = 'fwd'


# ======================================================================= sess
class Sess(Dedup):
    """Client sessions (Raft thesis 6.3, LogCabin), registered in #s."""
    TIMED = False    # no sess rule reads a copy's send time or a data entry's time (state reduction)

    def sid(self, st):
        return ('s', self.life(st), st[IX['cl']][4])

    def wid(self, st, n):
        return (self.sid(st), n)

    def expired(self, st, sid):
        return any(e[0] == 'exp' and e[1] == sid for e in self.com(st, GS))

    def unknown_ok(self, st, n):
        return self.expired(st, self.sid(st))

    def registered(self, st, sid, committed=True):
        ents = self.com(st, GS) if committed else self.log(st, GS)
        return any(e[0] == 'ren' and e[1] == sid for e in ents)

    def fold(self, st, g, committed):
        """session -> (outs {n: (kind, slot)} at or above the floor, floor);
        an expired session has no state (data writers forget it when #s's
        committed log says so)."""
        ents = self.com(st, g) if committed else self.log(st, g)
        v = {}
        for e in ents:
            if e[0] in ('w', 'r'):
                sid, n = e[1]
                o, fl = v.get(sid, ({}, NEG))
                o = dict(o)
                o[n] = (e[0], e[2])
                L = e[5] if e[5] is not None else NEG
                v[sid] = (o, max(fl, L))
            elif e[0] == 'open':
                _, slot, outs, fls, t = e
                for (sid, n), kind in outs:
                    o, fl = v.get(sid, ({}, NEG))
                    o = dict(o)
                    o[n] = (kind, slot)
                    v[sid] = (o, fl)
                for sid, f in fls:
                    o, fl = v.get(sid, ({}, NEG))
                    v[sid] = (o, max(fl, f))
        out = {}
        for sid, (o, fl) in v.items():
            if self.expired(st, sid):
                continue
            out[sid] = ({n: x for n, x in o.items() if n >= fl}, fl)
        return out

    def outcome(self, st, g, ws, committed):
        (sid, n), slot = ws
        f = self.fold(st, g, committed).get(sid)
        if f is None:
            return None
        x = f[0].get(n)
        return x[0] if x else None

    def floor(self, st, g, sid):
        f = self.fold(st, g, False).get(sid)
        return f[1] if f else NEG

    def notin(self, w, st, b):
        m = b['m']
        return self.outcome(st, b['g'], (m[1], m[3]), False) is None

    def lowest(self, st):
        for n, s in enumerate(st[IX['cl']][1]):
            if s in (IDLE, PEND):
                return n
        return len(self.plan)

    def actions(self):
        idn = lambda w, st, b: b['m'][1][1]
        floor = lambda w, st, b: self.floor(st, b['g'], b['m'][1][0])
        live = T('live', lambda w, st, b: not self.expired(st, b['m'][1][0]), 'dedup',
                 'the session has not expired in #s (committed)')
        A = []

        def setL(md, st, b, d):
            d.f['_e']['L'] = self.lowest(st)
        reg_ok = T('registered', lambda w, st, b: self.registered(st, self.sid(st)), 'dedup',
                   'send only once the session\'s registration has committed')
        A.append(self.a_send([reg_ok], [U('L', setL, 'mem', 'each copy carries the lowest unacknowledged id')]))
        A.append(self.a_resend([], [U('L', setL, 'mem', 'each copy carries the lowest unacknowledged id')]))
        A.append(self.a_recv())
        A.append(self.a_learn())

        # register (first renewal) and renew the session in #s
        def p_reg(md, st):
            if not self.registered(st, self.sid(st), committed=False):
                yield {}

        def reg(md, st, b, d):
            self.append(d, GS, ('ren', self.sid(st), st[IX['now']]))
        A.append(Action('register', 'deliver', p_reg, [], [U('append', reg, 'world')]))

        def p_renew(md, st):
            # a live client renews its session (at most once per run here: a
            # bound, enough to keep a session alive across one tick)
            sid = self.sid(st)
            lg = self.log(st, GS)
            rens = [e for e in lg if e[0] == 'ren' and e[1] == sid]
            if rens and len(rens) < 2 and not any(e[0] == 'exp' and e[1] == sid for e in lg) and \
                    all(e[2] < st[IX['now']] for e in rens):
                yield {}
        A.append(Action('renew', 'tick', p_renew, [], [U('append', reg, 'world')]))

        # a new session after the old one expired (the client keeps its life)
        def p_rereg(md, st):
            if self.expired(st, self.sid(st)) and st[IX['cl']][4] < 1:
                yield {}

        def rereg(md, st, b, d):
            cl = d.f['cl']
            d.f['cl'] = cl[:4] + (cl[4] + 1,)

        def drop_pending(md, st, b, d):
            for n, s in enumerate(st[IX['cl']][1]):
                if s == PEND:
                    self.set_cl(d, 1, n, UNKNOWN)
        A.append(Action('newsess', 'deliver', p_rereg, [],
                        [U('sid', rereg, 'dedup', 'a new session after expiry'),
                         U('unknown', drop_pending, 'world')]))

        if self.fwd:
            A.append(self.a_forward())
        A.append(self.a_restart())

        def app(kind):
            def f(md, st, b, d):
                m = b['m']
                self.append(d, b['g'], (kind, m[1], m[3], 0, m[2], m[7]))
            return f

        def judge(name, extra_guards, ups):
            gs = [T('notin', self.notin, 'dedup', 'not among the session\'s outcomes (log end)'),
                  Cmp('floor', idn, '>=', floor, role='dedup', note='at or above the session\'s floor L'),
                  T('live', live.fn, 'dedup', live.note)]
            return Action(name, 'deliver', self.p_copies, gs + list(extra_guards),
                          [U('eat', lambda md, st, b, d: self.eat(d, b['m']), 'world')] + list(ups))
        A.append(judge('apply', [], [U('append', app('w'), 'world')]))
        if self.APPEND_ALL:
            A.append(judge('refuse_r', [], [U('append', app('r'), 'world')]))
        else:
            A.append(judge('refuse_r', [T('resend', lambda w, st, b: b['m'][5] == 1, 'perf',
                                          'only a resend\'s refusal is appended')],
                           [U('append', app('r'), 'world')]))
            A.append(judge('refuse_f', [T('first', lambda w, st, b: b['m'][5] == 0, 'dedup',
                                          'a refusal not appended only for a first send')],
                           [U('emit', lambda md, st, b, d: self.send_msg(d, ('a', 'r', b['m'][2], b['m'][4])), 'perf')]))
        A.append(Action('stale', 'deliver', self.p_copies,
                        [T('notin', self.notin, 'dedup', 'not among the outcomes'),
                         Cmp('floor', idn, '<', floor, role='dedup', note='below the session\'s floor'),
                         T('live', live.fn, 'dedup', live.note)],
                        [U('eat', lambda md, st, b, d: self.eat(d, b['m']), 'world'),
                         U('emit', lambda md, st, b, d: self.send_msg(d, ('a', 's', b['m'][2], b['m'][4])), 'perf')]))
        A.append(Action('expired', 'deliver', self.p_copies,
                        [T('dead', lambda w, st, b: self.expired(st, b['m'][1][0]), 'dedup',
                           'the session expired in #s')],
                        [U('eat', lambda md, st, b, d: self.eat(d, b['m']), 'world'),
                         U('emit', lambda md, st, b, d: self.send_msg(d, ('a', 'x', b['m'][2], b['m'][4])), 'perf')]))
        A.append(Action('dup', 'deliver', self.p_copies,
                        [T('in', lambda w, st, b: not self.notin(w, st, b), 'world')],
                        [U('eat', lambda md, st, b, d: self.eat(d, b['m']), 'world')]))

        # expiry in #s by #s's writer time
        def p_exp(md, st):
            seen = set()
            for e in self.log(st, GS):
                if e[0] == 'ren' and e[1] not in seen:
                    seen.add(e[1])
                    if not any(x[0] == 'exp' and x[1] == e[1] for x in self.log(st, GS)):
                        yield {'sid': e[1]}

        def last_ren(st, sid):
            return max(e[2] for e in self.log(st, GS) if e[0] == 'ren' and e[1] == sid)

        def expire(md, st, b, d):
            self.append(d, GS, ('exp', b['sid']))
        A.append(Action('expire', 'tick', p_exp,
                        [Cmp('silent', lambda w, st, b: st[IX['now']] - last_ren(st, b['sid']), '>=',
                             lambda w, st, b: self.S, role='time', note='a session not renewed for S expires')],
                        [U('append', expire, 'mem')]))
        A.extend(self.move_actions())
        return A

    def move_actions(self):
        def p_fence(md, st):
            if self.move and not any(e[0] == 'fence' for e in self.log(st, G0)):
                yield {}

        def outs(md, st, b, d):
            f = self.fold(st, G0, False)
            d.f['_e']['outs'] = frozenset(((sid, n), x[0]) for sid, (o, fl) in f.items()
                                          for n, x in o.items() if x[1] == 's2')

        def fls(md, st, b, d):
            f = self.fold(st, G0, False)
            d.f['_e']['fl'] = frozenset((sid, fl) for sid, (o, fl) in f.items())

        def fence(md, st, b, d):
            e = d.f['_e']
            self.append(d, G0, ('fence', 's2', e.get('outs', E), e.get('fl', E)))

        def p_open(md, st):
            if any(e[0] == 'open' for e in self.log(st, G1)):
                return
            for e in self.com(st, G0):
                if e[0] == 'fence':
                    yield {'f': e}

        def oouts(md, st, b, d):
            d.f['_e']['outs'] = b['f'][2]

        def ofl(md, st, b, d):
            d.f['_e']['fl'] = b['f'][3]

        def opn(md, st, b, d):
            e = d.f['_e']
            self.append(d, G1, ('open', 's2', e.get('outs', E), e.get('fl', E), st[IX['now']]))
        return [Action('fence', 'control', p_fence, [],
                       [U('outs', outs, 'carry', 'the fence carries the slot\'s outcomes'),
                        U('floor', fls, 'carry', 'the fence carries each session\'s floor'),
                        U('append', fence, 'world')]),
                Action('open', 'deliver', p_open, [],
                       [U('outs', oouts, 'carry', 'open takes the carried outcomes'),
                        U('floor', ofl, 'carry', 'open takes the carried floors'),
                        U('append', opn, 'world')])]


class SessFwd(Sess):
    ROUTE = 'fwd'


# ======================================================================= pid
class Pid(Dedup):
    """Kafka's idempotent producer (KIP-98, KIP-360), per (producer, slot)."""

    def pid(self, st):
        return ('p', self.life(st))

    def unknown_ok(self, st, n):
        p, slot, sq = self.wid(st, n)
        return any(e[0] == 'pfg' and e[1] == p and e[2] == slot for g in DATA for e in self.com(st, g))

    SLOTI = {'s1': 0, 's2': 1}

    def epoch(self, st, slot):
        """(epoch, first attempt under it) for this life and partition.
        cl[4] holds (life, per slot (epoch, first)); another life's value
        counts as (0, 0): a new life is a new producer id."""
        x = st[IX['cl']][4]
        if not isinstance(x, tuple) or x[0] != self.life(st):
            return (0, 0)
        return x[1][self.SLOTI[slot]]

    def bump(self, st, d, n):
        """KIP-360: after an attempt ends `unknown`, the producer bumps its
        epoch on that partition and its sequence there restarts at 0."""
        slot = self.plan[n]
        cl = d.f['cl']
        x = cl[4] if isinstance(cl[4], tuple) and cl[4][0] == self.life(st) else (self.life(st), ((0, 0), (0, 0)))
        eps = list(x[1])
        eps[self.SLOTI[slot]] = (eps[self.SLOTI[slot]][0] + 1, n + 1)
        d.f['cl'] = cl[:4] + ((x[0], tuple(eps)),)

    def seq(self, st, n):
        slot = self.plan[n]
        first = self.epoch(st, slot)[1]
        return sum(1 for j in range(first, n) if self.plan[j] == slot)

    def wid(self, st, n):
        # one attempt in flight per partition, so the epoch never changes
        # under an attempt that is still pending: every copy keeps its id
        slot = self.plan[n]
        return (self.pid(st) + (self.epoch(st, slot)[0],), slot, self.seq(st, n))

    def fold(self, st, g, committed):
        """(pid, slot) -> (last seq, its kind, last_t)."""
        ents = self.com(st, g) if committed else self.log(st, g)
        v = {}
        for e in ents:
            if e[0] in ('w', 'r'):
                p, slot, sq = e[1]
                v[(p, slot)] = (sq, e[0], e[3])
            elif e[0] == 'pfg':
                v.pop((e[1], e[2]), None)
            elif e[0] == 'open':
                _, slot, st8, t = e
                for key, (sq, kind) in st8:
                    old = v.get(key)
                    if old is None or old[0] < sq:
                        v[key] = (sq, kind, t)
        return v

    def outcome(self, st, g, ws, committed):
        (p, slot, sq), _ = ws
        x = self.fold(st, g, committed).get((p, slot))
        if x is None or x[0] != sq:
            return None              # Kafka caches the last sequence's outcome only (here: 1)
        return x[1]

    def state(self, st, g, m):
        p, slot, sq = m[1]
        return self.fold(st, g, False).get((p, slot))

    def actions(self):
        B, R, H = self.B, self.R, self.H
        age = lambda w, st, b: st[IX['now']] - b['m'][6]
        sq = lambda w, st, b: b['m'][1][2]
        last = lambda w, st, b: self.state(st, b['g'], b['m'])[0]
        has = T('known', lambda w, st, b: self.state(st, b['g'], b['m']) is not None, 'dedup',
                'the writer holds state for (producer, partition)')
        A = []

        def inflight(w, st, b):
            n = b['n']
            slot = self.plan[n]
            return all(self.stat(st, j) not in (IDLE, PEND) for j in range(n) if self.plan[j] == slot)
        reg_ok = T('registered', lambda w, st, b: any(e[0] == 'pid' and e[1] == self.pid(st) for e in self.com(st, GS)),
                   'dedup', 'send only once the producer id has committed in #s')
        A.append(self.a_send([reg_ok, T('inflight', inflight, 'dedup',
                                        'one attempt in flight per partition (max.in.flight = cached outcomes)')]))
        A.append(self.a_resend([Cmp('horizon', lambda w, st, b: st[IX['now']] - self.t0(st, b['n']), '<',
                                    lambda w, st, b: R, role='time', note='stop retrying after R (delivery.timeout.ms)')]))

        A.append(Action('giveup', 'tick', self.p_pending,
                        [Cmp('late', lambda w, st, b: st[IX['now']] - self.t0(st, b['n']), '>=', lambda w, st, b: R,
                             role='time', note='after R the attempt ends unknown')],
                        [self.giveup_update(),
                         U('bump', lambda md, st, b, d: self.bump(st, d, b['n']), 'dedup',
                           'a give-up bumps the epoch: the partition\'s sequence restarts at 0 (KIP-360)')]))
        rv = self.a_recv()

        def rbump(md, st, b, d):
            if b['m'][1] == 'x':
                self.bump(st, d, b['m'][2][1])
        bu = U('bump', rbump, 'dedup', 'an unknown-producer answer bumps the epoch too (KIP-360)')
        bu.action = rv.name
        rv.updates.append(bu)
        A.append(rv)
        A.append(self.a_learn())

        def p_reg(md, st):
            if not any(e[0] == 'pid' and e[1] == self.pid(st) for e in self.log(st, GS)):
                yield {}

        def reg(md, st, b, d):
            self.append(d, GS, ('pid', self.pid(st)))
        A.append(Action('register', 'deliver', p_reg, [], [U('append', reg, 'world')]))
        if self.fwd:
            def stamp(md, st, b, d):
                d.f['_e']['s'] = b['m'][6]
            A.append(self.a_forward([Cmp('budget', age, '<', lambda w, st, b: B, role='hop',
                                         note='a relay forwards only within the budget')],
                                    [U('age', stamp, 'hop', 'a relay subtracts the time it held the copy')]))
        A.append(self.a_restart())

        budget = lambda: Cmp('budget', age, '<', lambda w, st, b: B, role='hop', note='the copy\'s budget is not spent')

        def app(kind):
            def f(md, st, b, d):
                m = b['m']
                self.append(d, b['g'], (kind, m[1], m[3], st[IX['now']], m[2], None))
            return f
        eat = lambda: U('eat', lambda md, st, b, d: self.eat(d, b['m']), 'world')
        nxt = lambda: [T('known', has.fn, 'dedup', has.note),
                       Cmp('after', sq, '>', last, role='dedup', note='sequence above the last'),
                       Cmp('next', sq, '<=', lambda w, st, b: last(w, st, b) + 1, role='dedup', note='no gap: at most last + 1')]
        first = lambda: [T('unknown', lambda w, st, b: self.state(st, b['g'], b['m']) is None, 'dedup',
                           'no state for (producer, partition)'),
                         Cmp('zero', sq, '<=', lambda w, st, b: 0, role='dedup', note='an unknown producer starts at 0')]
        A.append(Action('apply_next', 'deliver', self.p_copies, nxt() + [budget()], [eat(), U('append', app('w'), 'world')]))
        A.append(Action('apply_first', 'deliver', self.p_copies, first() + [budget()], [eat(), U('append', app('w'), 'world')]))
        A.append(Action('refuse_next', 'deliver', self.p_copies, nxt() + [budget()], [eat(), U('append', app('r'), 'world')]))
        A.append(Action('refuse_first', 'deliver', self.p_copies, first() + [budget()], [eat(), U('append', app('r'), 'world')]))
        A.append(Action('dup', 'deliver', self.p_copies,
                        [T('known', has.fn, 'world'),
                         T('seen', lambda w, st, b: b['m'][1][2] <= self.state(st, b['g'], b['m'])[0], 'world')],
                        [eat()]))
        A.append(Action('ooo', 'deliver', self.p_copies,
                        [T('known', has.fn, 'world'),
                         T('gap', lambda w, st, b: b['m'][1][2] > self.state(st, b['g'], b['m'])[0] + 1, 'world')],
                        [eat()]))
        A.append(Action('unknownpid', 'deliver', self.p_copies,
                        [T('unknown', lambda w, st, b: self.state(st, b['g'], b['m']) is None, 'world'),
                         T('nonzero', lambda w, st, b: b['m'][1][2] > 0, 'world'),
                         T('forgotten', lambda w, st, b: any(e[0] == 'pfg' and (e[1], e[2]) == (b['m'][1][0], b['m'][1][1])
                                                             for e in self.com(st, b['g'])), 'dedup',
                           'answer unknown only once the forget has committed')],
                        [eat(), U('emit', lambda md, st, b, d: self.send_msg(d, ('a', 'x', b['m'][2], b['m'][4])), 'perf')]))

        def p_forget(md, st):
            for g in DATA:
                for key in self.fold(st, g, False):
                    yield {'g': g, 'key': key}

        def forget(md, st, b, d):
            self.append(d, b['g'], ('pfg', b['key'][0], b['key'][1], st[IX['now']]))
        A.append(Action('forget', 'tick', p_forget,
                        [Cmp('silent', lambda w, st, b: st[IX['now']] - self.fold(st, b['g'], False)[b['key']][2], '>=',
                             lambda w, st, b: H, role='time', note='forget producer state silent for P')],
                        [U('append', forget, 'mem')]))
        if True:   # the move (its params are empty unless the bound moves s2)
            def p_fence(md, st):
                if self.move and not any(e[0] == 'fence' for e in self.log(st, G0)):
                    yield {}

            def carry(md, st, b, d):
                f = self.fold(st, G0, False)
                d.f['_e']['st'] = frozenset((k, (v[0], v[1])) for k, v in f.items() if k[1] == 's2')

            def fence(md, st, b, d):
                self.append(d, G0, ('fence', 's2', d.f['_e'].get('st', E)))

            def p_open(md, st):
                if any(e[0] == 'open' for e in self.log(st, G1)):
                    return
                for e in self.com(st, G0):
                    if e[0] == 'fence':
                        yield {'f': e}

            def ocarry(md, st, b, d):
                d.f['_e']['st'] = b['f'][2]

            def opn(md, st, b, d):
                self.append(d, G1, ('open', 's2', d.f['_e'].get('st', E), st[IX['now']]))
            A.append(Action('fence', 'control', p_fence, [],
                            [U('state', carry, 'carry', 'the fence carries (producer, partition) state'),
                             U('append', fence, 'world')]))
            A.append(Action('open', 'deliver', p_open, [],
                            [U('state', ocarry, 'carry', 'open takes the carried producer state'),
                             U('append', opn, 'world')]))
        return A


class PidFwd(Pid):
    ROUTE = 'fwd'


# ======================================================================= keys
class Keys(Dedup):
    """Idempotency keys only: a unique key per write, kept for TTL."""

    def wid(self, st, n):
        return ('k', self.life(st), n)

    def fold(self, st, g, committed):
        ents = self.com(st, g) if committed else self.log(st, g)
        v = {}
        for e in ents:
            if e[0] in ('w', 'r'):
                v[e[1]] = (e[0], e[2], e[3])
            elif e[0] == 'kfg':
                v.pop(e[1], None)
            elif e[0] == 'open':
                _, slot, outs, t = e
                for key, kind in outs:
                    v.setdefault(key, (kind, slot, t))
        return v

    def outcome(self, st, g, ws, committed):
        w, slot = ws
        x = self.fold(st, g, committed).get(w)
        return x[0] if x else None

    def notin(self, w, st, b):
        return self.fold(st, b['g'], False).get(b['m'][1]) is None

    def actions(self):
        B, R, H = self.B, self.R, self.H
        age = lambda w, st, b: st[IX['now']] - b['m'][6]
        A = []
        A.append(self.a_send())
        A.append(self.a_resend([Cmp('horizon', lambda w, st, b: st[IX['now']] - self.t0(st, b['n']), '<',
                                    lambda w, st, b: R, role='time', note='stop retrying after R')]))

        A.append(Action('giveup', 'tick', self.p_pending,
                        [Cmp('late', lambda w, st, b: st[IX['now']] - self.t0(st, b['n']), '>=', lambda w, st, b: R,
                             role='time', note='after R the attempt ends unknown')],
                        [self.giveup_update()]))
        A.append(self.a_recv())
        A.append(self.a_learn())
        if self.fwd:
            def stamp(md, st, b, d):
                d.f['_e']['s'] = b['m'][6]
            A.append(self.a_forward([Cmp('budget', age, '<', lambda w, st, b: B, role='hop',
                                         note='a relay forwards only within the budget')],
                                    [U('age', stamp, 'hop', 'a relay subtracts the time it held the copy')]))
        A.append(self.a_restart())

        def app(kind):
            def f(md, st, b, d):
                m = b['m']
                self.append(d, b['g'], (kind, m[1], m[3], st[IX['now']], m[2], None))
            return f

        def judge(name, extra_guards, ups):
            gs = [T('notin', self.notin, 'dedup', 'the key is not in the table (log end)'),
                  Cmp('budget', age, '<', lambda w, st, b: B, role='hop', note='the copy\'s budget is not spent')]
            return Action(name, 'deliver', self.p_copies, gs + list(extra_guards),
                          [U('eat', lambda md, st, b, d: self.eat(d, b['m']), 'world')] + list(ups))
        A.append(judge('apply', [], [U('append', app('w'), 'world')]))
        A.append(judge('refuse_r', [T('resend', lambda w, st, b: b['m'][5] == 1, 'perf',
                                      'only a resend\'s refusal is appended')], [U('append', app('r'), 'world')]))
        A.append(judge('refuse_f', [T('first', lambda w, st, b: b['m'][5] == 0, 'dedup',
                                      'a refusal not appended only for a first send')],
                       [U('emit', lambda md, st, b, d: self.send_msg(d, ('a', 'r', b['m'][2], b['m'][4])), 'perf')]))
        A.append(Action('dup', 'deliver', self.p_copies,
                        [T('in', lambda w, st, b: not self.notin(w, st, b), 'world')],
                        [U('eat', lambda md, st, b, d: self.eat(d, b['m']), 'world')]))

        def p_forget(md, st):
            for g in DATA:
                for key in self.fold(st, g, False):
                    yield {'g': g, 'key': key}

        def forget(md, st, b, d):
            self.append(d, b['g'], ('kfg', b['key'], st[IX['now']]))
        A.append(Action('forget', 'tick', p_forget,
                        [Cmp('ttl', lambda w, st, b: st[IX['now']] - self.fold(st, b['g'], False)[b['key']][2], '>=',
                             lambda w, st, b: H, role='time', note='a key lives for its TTL')],
                        [U('append', forget, 'mem')]))
        if True:   # the move (its params are empty unless the bound moves s2)
            def p_fence(md, st):
                if self.move and not any(e[0] == 'fence' for e in self.log(st, G0)):
                    yield {}

            def carry(md, st, b, d):
                f = self.fold(st, G0, False)
                d.f['_e']['outs'] = frozenset((k, v[0]) for k, v in f.items() if v[1] == 's2')

            def fence(md, st, b, d):
                self.append(d, G0, ('fence', 's2', d.f['_e'].get('outs', E)))

            def p_open(md, st):
                if any(e[0] == 'open' for e in self.log(st, G1)):
                    return
                for e in self.com(st, G0):
                    if e[0] == 'fence':
                        yield {'f': e}

            def ocarry(md, st, b, d):
                d.f['_e']['outs'] = b['f'][2]

            def opn(md, st, b, d):
                self.append(d, G1, ('open', 's2', d.f['_e'].get('outs', E), st[IX['now']]))
            A.append(Action('fence', 'control', p_fence, [],
                            [U('outs', carry, 'carry', 'the fence carries the slot\'s keys'),
                             U('append', fence, 'world')]))
            A.append(Action('open', 'deliver', p_open, [],
                            [U('outs', ocarry, 'carry', 'open takes the carried keys'),
                             U('append', opn, 'world')]))
        return A


class KeysFwd(Keys):
    ROUTE = 'fwd'


class WinFwdAll(WinFwd):
    APPEND_ALL = True


class SessFwdAll(SessFwd):
    APPEND_ALL = True


OPTIONS = {'win-smart': Win, 'win-fwd': WinFwd, 'sess-smart': Sess, 'sess-fwd': SessFwd,
           'pid-smart': Pid, 'pid-fwd': PidFwd, 'keys-smart': Keys, 'keys-fwd': KeysFwd,
           # variants: every refusal appended, so no copy is ever answered outside the log
           'win-fwd-all': WinFwdAll, 'sess-fwd-all': SessFwdAll}

# Bounds. att: the slot of each planned attempt. Every attempt may be refused.
BOUNDS = {
    # retries whose answers are lost, a failover mid-retry, a refusal then a
    # stale copy: two attempts on s1, three copies each, one crash, one drop
    'lost': {'att': ('s1', 's1'), 'cap': 3, 'crashes': 1, 'faults': 2, 'drops': 1},
    # a slot move mid-retry, with a crash on either side
    'move': {'att': ('s2', 's1'), 'cap': 2, 'crashes': 1, 'faults': 1, 'drops': 1, 'move': True},
    # a client restart with copies of the old life in flight
    'restart': {'att': ('s1',), 'cap': 2, 'crashes': 1, 'faults': 2, 'drops': 1, 'restarts': 1},
    # expiry by the writer's time, with late copies
    'expire': {'att': ('s1', 's1'), 'cap': 2, 'crashes': 0, 'faults': 1, 'drops': 1, 'tmax': 2, 'serial': True},
    # expiry with a restart: the old life's copies land late
    'exprst': {'att': ('s1',), 'cap': 2, 'crashes': 0, 'faults': 1, 'drops': 0, 'tmax': 2, 'restarts': 1,
               'replan': False},
    # the verify bound: a move and expiry with late copies
    'mvexp': {'att': ('s2',), 'cap': 2, 'crashes': 1, 'faults': 1, 'drops': 1, 'tmax': 2, 'move': True,
              'serial': True},
}
SWEEP = ('lost', 'move', 'restart', 'expire', 'exprst')
VERIFY = ('mvexp',)

PIN_COMMON = ('send.status', 'send.emit', 'resend.k', 'resend.emit', 'recv.status', 'recv.eat',
              'learn.status', 'giveup.status', 'forward.emit', 'restart.reset', 'register.append',
              'renew.append', 'newsess.unknown', 'fence.append', 'open.append', 'dup.in', 'dup.eat', 'dup.known', 'dup.seen',
              'ooo.known', 'ooo.gap', 'ooo.eat', 'unknownpid.unknown', 'unknownpid.nonzero', 'unknownpid.eat',
              'unknownpid.emit', 'apply.eat', 'apply.append', 'refuse_r.eat', 'refuse_r.append',
              'refuse_f.eat', 'refuse_f.emit', 'stale.eat', 'stale.emit', 'expired.eat', 'expired.emit',
              'forget.append', 'expire.append', 'send.L', 'resend.L',
              'apply_next.eat', 'apply_next.append', 'apply_first.eat', 'apply_first.append',
              'refuse_next.eat', 'refuse_next.append', 'refuse_first.eat', 'refuse_first.append')
PINNED = {k: PIN_COMMON for k in OPTIONS}
