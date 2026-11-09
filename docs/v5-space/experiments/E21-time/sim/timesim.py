"""
timesim.py: E-21's simulation. Which time rule gives correct TTLs and safe
leases under clock skew, clock jumps, GC pauses and leader changes?

Each option's time rules are written in E-17's rule language (dsl.py:
Guard, Cmp, Update, Action, Mutation), so a rule is one guard conjunct or
one state update, and ablation and mutants are mechanical (DEV-10). The
explorer is not E-17's breadth-first search: time here is real numbers (a
clock jump of 1 s to 1 h, drift of 200 ppm, a 1 to 5 s pause), so each
option runs on seeded random schedules from seven scenario families, and a
rule counts if dropping it breaks a check on some seed.

THE WORLD (shared, not counted).
  N = 3 or 5 nodes. Real time tau in ms, stepped every TICK (100 ms, the
  writer's tick). Node i's wall clock: tau + offset + drift * tau + the
  jumps so far; offsets spread over skew.max (250 ms), drift +-200 ppm.
  Its monotonic clock: (1 + drift) * tau, never jumps. Every node pings
  every 500 ms with its wall clock (and its HLC value); a receiver keeps
  the reading and its own monotonic time at receipt.
  One Raft group, abstract: a leader appends entries that commit at once.
  A leader that is down or paused is replaced election.ms (2 s) after it
  stopped, by an up, unpaused node that may stand. A paused leader that
  wakes before that carries on.
  Workload: the leader writes a TTL row every second (ttl 5 s or 30 s) and
  expires rows on its tick; one lock (lease 10 s) wanted by two clients,
  each with its own drifting monotonic clock and GC pauses of 1 to 5 s; a
  holder renews every lease/3 and believes it holds until its monotonic
  clock reaches (last ack + lease - margin), margin = a round trip plus
  skew.max (DESIGN-V5 5.3); it sends a protected write every 500 ms while
  it believes it holds, sometimes pausing between the check and the send
  (Kleppmann 2016).

OPTIONS (SPACE.md axis T)
  wall     the baseline: writer time = the leader's wall clock, never back.
  clamp    the draft (DESIGN-V5 4.2): t = max(last t, clamp(clock, median -
           skew.max, median + skew.max)), the median over the members'
           clocks from pings (own included), each reading carried forward by
           the receiver's monotonic time since it arrived; a member whose
           clock is off by more than skew.max waits longer to stand.
  hlc      hybrid logical clocks (Kulkarni et al. 2014) with CockroachDB's
           guards: l = max(l, clock) when stamping, max(l, received l) on a
           ping, max(l, t) on applying an entry; a reading more than
           max-offset (500 ms) ahead of the receiver's clock is refused; a
           leader whose clock is more than max-offset from its peers'
           median steps down, and such a node does not stand.
  mono     etcd's lessor: expiries are durations on the leader's
           monotonic clock; a new leader restarts every TTL and lease at its
           full length (Promote). Writer time is the wall clock (only for
           ctx.now()).
  mono+ck  mono with etcd 3.4's lease checkpoints: the leader logs each
           remaining duration every second (etcd's default is 5 minutes);
           a new leader resumes from the checkpoint.
  tt       TrueTime / ClockBound: each node reads an interval [earliest,
           latest] that holds real time (the premise: clock infrastructure
           that bounds the error, here 125 ms, and absorbs jumps); writer
           time is `latest`; a TTL or lease ends when `earliest` passes it.

Common to every option (counted once, in every option): expiry is a record
in the log (`log`), and a protected write carries its lock token and is
refused below the highest token the writer has seen (`fence`).

CHECKS (per seed)
  early_wt   a row expired before its ttl by writer time.
  early      a row expired more than skew.max early in real time (F-06: a
             skewed clock cannot end a TTL or a lease early).
  late       a row expired later than ttl + tick + skew.max + the time the
             group had no working leader during its life (P-02), or never.
  lease      the writer granted the lock while the previous holder still
             believed, by its own clock, that it held it (two holders
             without a pause: the clock rule's fault).
  stuck      the lock was not granted again within lease + tick + skew.max
             + leaderless time after its holder stopped renewing.
  back       writer time went back between two entries.
  agree      replicas removed a row at different log positions.
  stale      a protected write committed with a token below one the
             writer had already seen (TEST-13's fencing checker).
  overlap    (reported, not a check) protected writes sent by a client that
             was not the holder of the latest token at that moment: what
             fencing has to stop.
"""

import importlib.util
import json
import math
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
E17 = os.path.normpath(os.path.join(HERE, '..', '..', 'E17-partitioning', 'harness', 'dsl.py'))
_spec = importlib.util.spec_from_file_location('e17dsl', E17)
dsl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(dsl)
Action, Guard, Cmp, Update, Mutation, rules = dsl.Action, dsl.Guard, dsl.Cmp, dsl.Update, dsl.Mutation, dsl.rules
FLIP, OPS = dsl.FLIP, dsl.OPS

S = 250          # skew.max (API.md's proposed default)
TICK = 100       # the writer's tick and the sim step
ELECT = 2000     # election.ms
PING = 500
LEASE = 10000
MARGIN = 10 + S  # a holder's margin: a round trip plus skew.max
TTLS = (5000, 30000)
DUR = 180_000    # three minutes of real time per seed
MAXOFF = 500     # CockroachDB's --max-offset default
EPS = 125        # tt's error bound (the premise)
CKPT = 1000      # mono+ck: checkpoint every second (etcd's default: 5 minutes)
DRIFT = 200e-6
FAMILIES = ('drift', 'jumpL+', 'jumpL-', 'jumpF', 'pause', 'crash', 'mix')
CHECKS = ('early_wt', 'early', 'late', 'lease', 'stuck', 'back', 'agree', 'stale')


def G(name, fn, role='', note=''):
    return Guard(name, fn, role=role, note=note)


def U(name, fn, role='', note=''):
    return Update(name, fn, role=role, note=note)


def median(xs):
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


# ------------------------------------------------------------------ options
# Hooks: an option's actions are looked up by name. `stamp` computes the
# writer time into d['t']; `expire` guards a row's expiry (b = row); `grant`
# guards a new grant of a lapsed lock; `stand` guards a candidate; `recv`
# runs on a ping (b = the reading); `apply` runs when a node applies an
# entry; `promote` runs on a new leader; `selffence` may step the leader
# down; `ckpt` runs on the tick; `pwrite` guards a protected write;
# `expire` also holds the common `log` update.

class Opt:
    name = 'opt'
    TIMER = 'wall'        # which clock a row's deadline uses: 'wall' (writer time) or 'mono'

    def common_expire_updates(self):
        return [U('log', lambda w, st, b, d: d.__setitem__('log', True), 'log',
                  'expiry is a record in the log, so every replica removes the row at one position')]

    def pwrite(self):
        return Action('pwrite', 'deliver', None,
                      [Cmp('fence', lambda w, st, b: b['token'], '>=', lambda w, st, b: w.max_token,
                           role='fence', note='refuse a token below the highest the writer has seen')], [])

    def now(self, w, L):
        """The writer time the leader would stamp now (its own reading)."""
        return w.stamp(L)


class Wall(Opt):
    name = 'wall'

    def actions(self):
        return [
            Action('stamp', 'deliver', None, [], [
                U('read', lambda w, st, b, d: d.__setitem__('t', w.wall(st)), 'world'),
                U('never_back', lambda w, st, b, d: d.__setitem__('t', max(d['t'], w.last_t)), 'time',
                  'writer time never goes back (max with the last t in the log)')]),
            Action('expire', 'deliver', None,
                   [Cmp('due', lambda w, st, b: w.t_now - b['t_w'], '>=', lambda w, st, b: b['d'], role='time',
                        note='a row ends when writer time passes its ttl')],
                   self.common_expire_updates()),
            Action('grant', 'deliver', None,
                   [Cmp('lapsed', lambda w, st, b: w.t_now, '>=', lambda w, st, b: b['until'], role='time',
                        note='a lease lapses when writer time passes its end')], []),
            self.pwrite(),
        ]


class Clamp(Opt):
    name = 'clamp'
    WIN = S          # the clamp's half-width around the median

    def actions(self):
        WIN = self.WIN
        def peers(w, st, b, d):
            d['est'] = [r[0] for r in w.readings(st)]

        def extrap(w, st, b, d):
            d['est'] = [r[0] + (w.mono(st) - r[1]) for r in w.readings(st)]

        def med(d, w, st):
            return median(d.get('est', []) + [w.wall(st)])
        return [
            Action('stamp', 'deliver', None, [], [
                U('read', lambda w, st, b, d: d.__setitem__('t', w.wall(st)), 'world'),
                U('peers', peers, 'time', 'peers\' clocks ride the pings'),
                U('extrap', extrap, 'time', 'a reading is carried forward by the receiver\'s monotonic time'),
                U('upper', lambda w, st, b, d: d.__setitem__('t', min(d['t'], med(d, w, st) + WIN)), 'time',
                  'clamp to median + skew.max'),
                U('lower', lambda w, st, b, d: d.__setitem__('t', max(d['t'], med(d, w, st) - WIN)), 'time',
                  'clamp to median - skew.max'),
                U('never_back', lambda w, st, b, d: d.__setitem__('t', max(d['t'], w.last_t)), 'time',
                  'writer time never goes back (max with the last t in the log)')]),
            Action('expire', 'deliver', None,
                   [Cmp('due', lambda w, st, b: w.t_now - b['t_w'], '>=', lambda w, st, b: b['d'], role='time',
                        note='a row ends when writer time passes its ttl')],
                   self.common_expire_updates()),
            Action('grant', 'deliver', None,
                   [Cmp('lapsed', lambda w, st, b: w.t_now, '>=', lambda w, st, b: b['until'], role='time',
                        note='a lease lapses when writer time passes its end')], []),
            Action('stand', 'deliver', None,
                   [Cmp('near', lambda w, st, b: abs(w.wall(st) - w.peer_median(st)), '<=', lambda w, st, b: S,
                        role='elect', note='a member off by more than skew.max waits longer to stand')], []),
            self.pwrite(),
        ]


class Hlc(Opt):
    name = 'hlc'

    def actions(self):
        return [
            Action('stamp', 'deliver', None, [], [
                U('read', lambda w, st, b, d: d.__setitem__('t', w.wall(st)), 'world'),
                U('hlc_max', lambda w, st, b, d: d.__setitem__('t', max(d['t'], st.l)), 'time',
                  'l = max(l, clock)'),
                U('never_back', lambda w, st, b, d: d.__setitem__('t', max(d['t'], w.last_t)), 'time',
                  'never below the last t in the log'),
                U('set_l', lambda w, st, b, d: setattr(st, 'l', d['t']), 'time', 'the stamp is the new l')]),
            Action('send', 'deliver', None, [],
                   [U('send_max', lambda w, st, b, d: setattr(st, 'l', max(st.l, w.wall(st))), 'time',
                      'on a send, l = max(l, clock)')]),
            Action('recv', 'deliver', None,
                   [Cmp('near', lambda w, st, b: b['l'] - w.wall(st), '<=', lambda w, st, b: MAXOFF, role='time',
                        note='refuse a reading more than max-offset ahead (CockroachDB)')],
                   [U('adopt', lambda w, st, b, d: setattr(st, 'l', max(st.l, b['l'])), 'time',
                      'l = max(l, received l)')]),
            Action('apply', 'deliver', None, [],
                   [U('apply', lambda w, st, b, d: setattr(st, 'l', max(st.l, b['t'])), 'time',
                      'l = max(l, an applied entry\'s t)')]),
            Action('selffence', 'deliver', None,
                   [Cmp('far', lambda w, st, b: abs(w.wall(st) - w.peer_median(st)), '>', lambda w, st, b: MAXOFF,
                        role='elect', note='a leader whose clock is off by more than max-offset')],
                   [U('stepdown', lambda w, st, b, d: d.__setitem__('down', True), 'elect', 'steps down')]),
            Action('stand', 'deliver', None,
                   [Cmp('near', lambda w, st, b: abs(w.wall(st) - w.peer_median(st)), '<=', lambda w, st, b: MAXOFF,
                        role='elect', note='a node off by more than max-offset does not stand')], []),
            Action('expire', 'deliver', None,
                   [Cmp('due', lambda w, st, b: w.t_now - b['t_w'], '>=', lambda w, st, b: b['d'], role='time',
                        note='a row ends when the HLC passes its ttl')],
                   self.common_expire_updates()),
            Action('grant', 'deliver', None,
                   [Cmp('lapsed', lambda w, st, b: w.t_now, '>=', lambda w, st, b: b['until'], role='time',
                        note='a lease lapses when the HLC passes its end')], []),
            self.pwrite(),
        ]


class Mono(Opt):
    name = 'mono'
    TIMER = 'mono'
    CK = False

    def actions(self):
        acts = [
            Action('stamp', 'deliver', None, [], [
                U('read', lambda w, st, b, d: d.__setitem__('t', w.wall(st)), 'world'),
                U('never_back', lambda w, st, b, d: d.__setitem__('t', max(d['t'], w.last_t)), 'time',
                  'writer time (ctx.now) never goes back')]),
            Action('expire', 'deliver', None,
                   [Cmp('due', lambda w, st, b: w.mono(st), '>=', lambda w, st, b: b['dl'], role='time',
                        note='a row ends when the leader\'s monotonic clock passes its deadline')],
                   self.common_expire_updates()),
            Action('grant', 'deliver', None,
                   [Cmp('lapsed', lambda w, st, b: w.mono(st), '>=', lambda w, st, b: b['dl'], role='time',
                        note='a lease lapses on the leader\'s monotonic clock')], []),
            Action('promote', 'deliver', None, [],
                   [U('extend', lambda w, st, b, d: d.__setitem__('extend', True), 'time',
                      'a new leader restarts every deadline at its full length (etcd Promote)')]),
            self.pwrite(),
        ]
        if self.CK:
            acts.append(Action('ckpt', 'deliver', None, [],
                               [U('ckpt', lambda w, st, b, d: d.__setitem__('ckpt', True), 'time',
                                  'the leader logs each remaining duration (etcd 3.4 checkpoint)')]))
            acts.append(Action('resume', 'deliver', None, [],
                               [U('resume', lambda w, st, b, d: d.__setitem__('resume', True), 'time',
                                  'a new leader resumes from the last checkpoint')]))
        return acts


class MonoCk(Mono):
    name = 'mono+ck'
    CK = True


class TT(Opt):
    name = 'tt'

    def actions(self):
        return [
            Action('stamp', 'deliver', None, [], [
                U('read', lambda w, st, b, d: d.__setitem__('t', w.latest(st)), 'world'),
                U('never_back', lambda w, st, b, d: d.__setitem__('t', max(d['t'], w.last_t)), 'time',
                  'never below the last t in the log')]),
            Action('expire', 'deliver', None,
                   [Cmp('due', lambda w, st, b: w.earliest(st) - b['t_w'], '>=', lambda w, st, b: b['d'], role='time',
                        note='a row ends when `earliest` passes its ttl')],
                   self.common_expire_updates()),
            Action('grant', 'deliver', None,
                   [Cmp('lapsed', lambda w, st, b: w.earliest(st), '>=', lambda w, st, b: b['until'], role='time',
                        note='a lease lapses when `earliest` passes its end')], []),
            self.pwrite(),
        ]


class Median(Clamp):
    """clamp with a window of 0: writer time is the members' median clock
    (own clock included), never back. Added here after the first runs: the
    draft's window lets writer time sit skew.max off the median, so it can
    be up to 1.5 x skew.max off real time."""
    name = 'median'
    WIN = 0


OPTIONS = {o.name: o for o in (Wall, Clamp, Median, Hlc, Mono, MonoCk, TT)}


class Compiled:
    """An option's actions with one mutation applied (as E-17's World does)."""

    def __init__(self, opt, mutation=None):
        m = mutation or Mutation()
        self.acts = {}
        for a in opt.actions():
            gs = []
            for g in a.guards:
                if g.id in m.drop:
                    continue
                if g.op is None:
                    gs.append(g.fn)
                else:
                    f = OPS[FLIP[g.op] if g.id in m.flip else g.op]
                    gs.append(lambda w, st, b, lhs=g.lhs, rhs=g.rhs, f=f: f(lhs(w, st, b), rhs(w, st, b)))
            us = list(a.updates)
            if a.name in m.swap:
                i, j = m.swap[a.name]
                us[i], us[j] = us[j], us[i]
            us = [u for u in us if u.id not in m.drop]
            self.acts[a.name] = (gs, us)

    def has(self, name):
        return name in self.acts

    def ok(self, name, w, st, b):
        if name not in self.acts:
            return True
        return all(g(w, st, b) for g in self.acts[name][0])

    def run(self, name, w, st, b, d):
        if name in self.acts:
            for u in self.acts[name][1]:
                u.fn(w, st, b, d)
        return d

    def update_names(self, name):
        return {u.name for u in self.acts.get(name, ((), ()))[1]}


# ------------------------------------------------------------------ the world
class Node:
    __slots__ = ('i', 'off', 'drift', 'jumps', 'up_from', 'down', 'pauses', 'l', 'reads', 'tt_err')

    def __init__(self, i, off, drift):
        self.i, self.off, self.drift = i, off, drift
        self.jumps = []          # (tau, delta)
        self.down = []           # (start, end)
        self.pauses = []         # (start, end)
        self.l = 0
        self.reads = {}          # peer -> (wall reading, my mono at receipt, l)


class World:
    def __init__(self, opt_cls, seed, family, mutation=None):
        self.opt = opt_cls()
        self.c = Compiled(self.opt, mutation)
        self.rng = random.Random(seed * 7919 + FAMILIES.index(family))
        r = self.rng
        self.family = family
        self.N = 3 if seed % 2 == 0 else 5
        self.nodes = [Node(i, r.uniform(-S / 2, S / 2), r.uniform(-DRIFT, DRIFT)) for i in range(self.N)]
        self.tau = 0
        self.leader = 0
        self.lost_at = None
        self.unavail = []        # (start, end) intervals with no working leader
        self.log = []            # entries: dict(kind, t, tau, ...)
        self.last_t = -1e18
        self.t_now = 0
        self.rows = {}
        self.max_token = -1
        self.lock = None         # dict(holder, token, until, dl)
        self.clients = [self._client(k) for k in range(2)]
        self.dl = {}             # mono: row/lock deadlines on the current leader's monotonic clock
        self.ck = {}             # mono+ck: checkpointed remaining durations
        self.res = {c: 0 for c in CHECKS}
        self.res['overlap'] = 0
        self.res['late_max'] = 0.0
        self.res['early_max'] = 0.0
        self.pending = []
        self.leader_down = None
        self.stepped = False
        self._plan()

    def _client(self, k):
        r = self.rng
        return {'k': k, 'drift': r.uniform(-DRIFT, DRIFT), 'hold': None, 'until_m': 0, 'next_try': r.uniform(0, 2000),
                'next_renew': 0, 'next_write': 0, 'paused_until': 0, 'last_ack': None}

    def _plan(self):
        r, fam = self.rng, self.family

        def jump(node, at):
            mag = math.exp(r.uniform(math.log(1000), math.log(3_600_000)))
            return (at, mag if fam == 'jumpL+' else -mag if fam == 'jumpL-' else r.choice((-1, 1)) * mag)
        if fam in ('jumpL+', 'jumpL-'):
            self.nodes[0].jumps.append(jump(0, r.uniform(20_000, 120_000)))
        if fam == 'jumpF':
            n = r.randrange(1, self.N)
            self.nodes[n].jumps.append(jump(n, r.uniform(20_000, 120_000)))
        if fam == 'pause':
            for _ in range(r.randint(1, 3)):
                a = r.uniform(15_000, 150_000)
                self.nodes[r.randrange(self.N)].pauses.append((a, a + r.uniform(1000, 5000)))
        if fam == 'crash':
            for _ in range(r.randint(1, 2)):
                a = r.uniform(15_000, 140_000)
                self.nodes[r.randrange(self.N)].down.append((a, a + 30_000))
        if fam == 'mix':
            for _ in range(r.randint(1, 4)):
                n = r.randrange(self.N)
                a = r.uniform(15_000, 150_000)
                k = r.choice(('jump', 'pause', 'crash'))
                if k == 'jump':
                    self.nodes[n].jumps.append((a, r.choice((-1, 1)) * math.exp(r.uniform(math.log(1000), math.log(3_600_000)))))
                elif k == 'pause':
                    self.nodes[n].pauses.append((a, a + r.uniform(1000, 5000)))
                else:
                    self.nodes[n].down.append((a, a + 30_000))
        for n in self.nodes:
            n.jumps.sort()

    # ---------------------------------------------------------- clocks
    def wall(self, st, tau=None):
        tau = self.tau if tau is None else tau
        return tau + st.off + st.drift * tau + sum(dl for at, dl in st.jumps if at <= tau)

    def mono(self, st, tau=None):
        tau = self.tau if tau is None else tau
        return (1 + st.drift) * tau

    def earliest(self, st):
        return self.tau - EPS     # tt's premise: the interval holds real time

    def latest(self, st):
        return self.tau + EPS

    def readings(self, st):
        return [v for p, v in st.reads.items() if p != st.i]

    def peer_median(self, st):
        rs = [v[0] + (self.mono(st) - v[1]) for v in self.readings(st)]
        return median(rs) if rs else self.wall(st)

    def alive(self, st):
        t = self.tau
        return not any(a <= t < b for a, b in st.down) and not any(a <= t < b for a, b in st.pauses)

    def up(self, st):
        return not any(a <= self.tau < b for a, b in st.down)

    def stamp(self, L):
        d = self.c.run('stamp', self, L, {}, {})
        return d['t']

    # ---------------------------------------------------------- the log
    def append(self, kind, **kw):
        L = self.nodes[self.leader]
        t = self.stamp(L)
        if t < self.last_t:
            self.res['back'] += 1
        self.last_t = t
        self.t_now = t
        e = dict(kind=kind, t=t, tau=self.tau, idx=len(self.log), **kw)
        self.log.append(e)
        for n in self.nodes:
            if n.i != self.leader and self.up(n):
                self.c.run('apply', self, n, {'t': t}, {})
        return e

    # ---------------------------------------------------------- one run
    def run(self):
        next_row, rid = 1000, 0
        next_ping = 0
        next_ck = CKPT
        while self.tau < DUR:
            self.step_leader()
            if self.tau >= next_ping:
                self.pings()
                next_ping += PING
            L = self.nodes[self.leader] if self.leader is not None else None
            working = L is not None and self.alive(L)
            if working:
                self.t_now = self.stamp(L)
                if self.c.has('selffence') and self.c.ok('selffence', self, L, {}):
                    if self.c.run('selffence', self, L, {}, {}).get('down'):
                        self.lose_leader()
                        self.stepped = True
                        working = False
            if working:
                if self.tau >= next_row:
                    d = TTLS[rid % 2]
                    e = self.append('row', rid=rid, d=d)
                    self.rows[rid] = {'rid': rid, 't_w': e['t'], 'd': d, 'tau_w': self.tau, 'gone': None,
                                      'unav0': self.unavail_total(), 'local': {}}
                    if self.opt.TIMER == 'mono':
                        self.dl[rid] = self.mono(L) + d
                    rid += 1
                    next_row += 1000
                self.expire(L)
                if self.c.has('ckpt') and self.tau >= next_ck:
                    if 'ckpt' in self.c.update_names('ckpt'):
                        for k, v in self.dl.items():
                            self.ck[k] = max(0.0, v - self.mono(L))
                    next_ck += CKPT
            self.local_expiry()
            self.clients_step(working)
            self.tau += TICK
        self.finish()
        return self.res

    def unavail_total(self, upto=None):
        upto = self.tau if upto is None else upto
        tot = 0.0
        for a, b in self.unavail:
            tot += max(0.0, min(b, upto) - a)
        if self.lost_at is not None:
            tot += max(0.0, upto - self.lost_at)
        return tot

    def lose_leader(self):
        if self.lost_at is None:
            self.lost_at = self.tau
        self.leader_down = self.leader

    def step_leader(self):
        L = self.nodes[self.leader] if self.leader is not None else None
        if self.lost_at is None:
            if L is not None and self.alive(L):
                return
            self.lose_leader()
            return
        if L is not None and self.leader_down == self.leader and not self.stepped and self.alive(L) \
                and self.tau - self.lost_at < ELECT:
            # a paused leader woke before an election: it carries on
            self.unavail.append((self.lost_at, self.tau))
            self.lost_at = None
            return
        if self.tau - self.lost_at < ELECT:
            return
        cands = [n for n in self.nodes if self.alive(n) and n.i != self.leader_down]
        good = [n for n in cands if self.c.ok('stand', self, n, {})]
        # clamp: a skewed member only waits longer, so it can still lead when
        # it alone can win; hlc: a node off by more than max-offset never stands
        pool = good or (cands if isinstance(self.opt, Clamp) else [])
        if not pool:
            return
        new = self.rng.choice(pool)
        self.unavail.append((self.lost_at, self.tau))
        self.lost_at = None
        self.leader = new.i
        self.leader_down = None
        self.stepped = False
        # the new leader holds every committed entry (leader completeness)
        for e in self.log:
            self.c.run('apply', self, new, {'t': e['t']}, {})
        if self.opt.TIMER == 'mono':
            d = self.c.run('promote', self, new, {}, {})
            r = self.c.run('resume', self, new, {}, {}) if self.c.has('resume') else {}
            old = self.dl
            self.dl = {}
            for k in old:
                full = self.rows[k]['d'] if k != 'lock' else LEASE
                if r.get('resume') and k in self.ck:
                    self.dl[k] = self.mono(new) + self.ck[k]
                elif d.get('extend'):
                    self.dl[k] = self.mono(new) + full
                # else: the new leader has no deadline for it (deadlines live
                # on the old leader's monotonic clock): it never ends

    def pings(self):
        for a in self.nodes:
            if not self.alive(a):
                continue
            for b in self.nodes:
                if b is a or not self.alive(b):
                    continue
                self.c.run('send', self, a, {}, {})
                rd = (self.wall(a), self.mono(b), a.l)
                if self.c.ok('recv', self, b, {'l': a.l}):
                    self.c.run('recv', self, b, {'l': a.l}, {})
                b.reads[a.i] = rd

    def expire(self, L):
        for k, row in self.rows.items():
            if row['gone'] is not None:
                continue
            b = {'t_w': row['t_w'], 'd': row['d'], 'dl': self.dl.get(k, float('inf'))}
            if self.c.ok('expire', self, L, b):
                d = self.c.run('expire', self, L, b, {})
                if d.get('log'):
                    e = self.append('exp', rid=k)
                    row['gone'] = (self.tau, e['t'], e['idx'])
                    row['local'] = None
                else:
                    # no record: the leader removes it locally; replicas use their own clocks
                    row['gone'] = (self.tau, self.t_now, len(self.log))
                    row['local'][self.leader] = len(self.log)
                self.dl.pop(k, None)

    def local_expiry(self):
        """Without the `log` rule, each replica removes a row by its own clock."""
        for row in self.rows.values():
            loc = row['local']
            if loc is None or row['gone'] is None:
                continue
            for n in self.nodes:
                if n.i in loc or not self.up(n):
                    continue
                if self.opt.TIMER == 'mono':
                    if self.mono(n) - self.mono(n, row['tau_w']) >= row['d']:
                        loc[n.i] = len(self.log)
                elif max(self.wall(n), n.l) - row['t_w'] >= row['d']:
                    loc[n.i] = len(self.log)

    # ---------------------------------------------------------- the lock
    def clients_step(self, working):
        r = self.rng
        for c in self.clients:
            mono_c = (1 + c['drift']) * self.tau
            if self.tau < c['paused_until']:
                continue
            if r.random() < 0.004:
                # a GC pause (1 to 5 s), now and then a long stall or a crash (to 15 s)
                c['paused_until'] = self.tau + (r.uniform(1000, 5000) if r.random() < 0.7 else r.uniform(5000, 15000))
                continue
            believes = c['hold'] is not None and mono_c < c['until_m']
            if c['hold'] is not None and not believes:
                c['hold'] = None
            if not working:
                continue
            L = self.nodes[self.leader]
            if c['hold'] is None and self.tau >= c['next_try']:
                c['next_try'] = self.tau + 1000
                self.try_acquire(c, L, mono_c)
            elif c['hold'] is not None and self.tau >= c['next_renew']:
                self.renew(c, L, mono_c)
            if c['hold'] is not None and self.tau >= c['next_write']:
                c['next_write'] = self.tau + PING
                delay = r.uniform(1000, 5000) if r.random() < 0.05 else 0     # a pause between check and send
                self.pending.append((self.tau + delay, c['k'], c['hold']))
        self.deliver_writes(working)

    def try_acquire(self, c, L, mono_c):
        lk = self.lock
        if lk is not None:
            b = {'until': lk['until'], 'dl': self.dl.get('lock', float('inf'))}
            unav = self.unavail_total() - lk['unav0']
            overdue = self.tau - lk['renew_tau'] > LEASE + TICK + S + unav + 1000
            if not self.c.ok('grant', self, L, b):
                if overdue and not lk.get('stuck'):
                    self.res['stuck'] += 1
                    lk['stuck'] = True
                return
            prev = self.clients[lk['holder']]
            if prev['hold'] == lk['token'] and prev['last_ack'] is not None:
                # the previous holder's belief, in real time
                end_real = prev['last_ack'][0] + (LEASE - MARGIN) / (1 + prev['drift'])
                if self.tau < end_real - 1e-6:
                    self.res['lease'] += 1
        e = self.append('grant', client=c['k'])
        self.lock = {'holder': c['k'], 'token': e['idx'], 'until': e['t'] + LEASE, 'renew_tau': self.tau,
                     'unav0': self.unavail_total()}
        if self.opt.TIMER == 'mono':
            self.dl['lock'] = self.mono(L) + LEASE
        c['hold'] = e['idx']
        c['until_m'] = mono_c + LEASE - MARGIN
        c['last_ack'] = (self.tau, mono_c)
        c['next_renew'] = self.tau + LEASE / 3

    def renew(self, c, L, mono_c):
        lk = self.lock
        c['next_renew'] = self.tau + LEASE / 3
        if lk is None or lk['token'] != c['hold']:
            c['hold'] = None
            return
        e = self.append('renew', client=c['k'])
        lk['until'] = e['t'] + LEASE
        lk['renew_tau'] = self.tau
        lk['unav0'] = self.unavail_total()
        if self.opt.TIMER == 'mono':
            self.dl['lock'] = self.mono(L) + LEASE
        c['until_m'] = mono_c + LEASE - MARGIN
        c['last_ack'] = (self.tau, mono_c)

    def deliver_writes(self, working):
        if not working:
            return
        keep = []
        for at, k, tok in self.pending:
            if at > self.tau:
                keep.append((at, k, tok))
                continue
            if self.lock is not None and tok != self.lock['token']:
                self.res['overlap'] += 1
            L = self.nodes[self.leader]
            if self.c.ok('pwrite', self, L, {'token': tok}):
                if tok < self.max_token:
                    self.res['stale'] += 1
                self.max_token = max(self.max_token, tok)
                self.append('pw', client=k, token=tok)
        self.pending = keep

    # ---------------------------------------------------------- results
    def finish(self):
        for k, row in self.rows.items():
            unav = self.unavail_total(row['gone'][0] if row['gone'] else self.tau) - row['unav0']
            if row['gone'] is None:
                if self.tau - row['tau_w'] > row['d'] + TICK + S + unav + 1:
                    self.res['late'] += 1
                    self.res['late_max'] = max(self.res['late_max'], self.tau - row['tau_w'] - row['d'])
                continue
            tau_x, t_x, idx = row['gone']
            life = tau_x - row['tau_w']
            if t_x - row['t_w'] < row['d'] and self.opt.TIMER == 'wall':
                self.res['early_wt'] += 1
            if life < row['d'] - S - 2 * DRIFT * row['d'] - 1:
                self.res['early'] += 1
            self.res['early_max'] = max(self.res['early_max'], row['d'] - life)
            if life > row['d'] + TICK + S + unav + 1:
                self.res['late'] += 1
            self.res['late_max'] = max(self.res['late_max'], life - row['d'] - unav)
            loc = row['local']
            if loc:
                ups = set(loc.values())
                if len(ups) > 1:
                    self.res['agree'] += 1


def run_one(opt_name, seed, family, mutation=None):
    return World(OPTIONS[opt_name], seed, family, mutation).run()


def sweep(opt_name, seeds, mutation=None, families=FAMILIES, stop=False):
    """Totals over every family x seed; with stop, return at the first failure."""
    tot = {k: 0 for k in CHECKS}
    tot['overlap'] = 0
    tot['late_max'] = 0.0
    tot['early_max'] = 0.0
    first = None
    for fam in families:
        for s in range(seeds):
            r = run_one(opt_name, s, fam, mutation)
            for k in CHECKS + ('overlap',):
                tot[k] += r[k]
            tot['late_max'] = max(tot['late_max'], r['late_max'])
            tot['early_max'] = max(tot['early_max'], r['early_max'])
            bad = [k for k in CHECKS if r[k]]
            if bad and first is None:
                first = (fam, s, bad)
                if stop:
                    tot['first'] = first
                    return tot
    tot['first'] = first
    return tot


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('option')
    ap.add_argument('--seeds', type=int, default=20)
    ap.add_argument('--drop', action='append', default=[])
    ap.add_argument('--flip', action='append', default=[])
    ap.add_argument('--family', action='append', default=[])
    a = ap.parse_args()
    m = Mutation(drop=a.drop, flip=a.flip)
    r = sweep(a.option, a.seeds, m, tuple(a.family) or FAMILIES)
    print(json.dumps({'option': a.option, 'seeds': a.seeds, 'mutation': repr(m), **r}, default=str))
