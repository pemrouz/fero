"""
derived.py: E-30's model. Do consumer groups and derived resources stay
exactly once when the outputs and the cursor sit in different groups, across
a restart shorter or longer than the dedup horizon?

It extends E-20's world (../../E20-dedup/models/dedup.py: abstract Raft
groups, copies delivered at most once, a global clock, the same crash and
commit steps) and runs on E-16's engine with E-17's rule language, so rules
and mutants are counted as in E-20 (DEV-10).

THE WORLD (not counted)
  Source A: two slots, a1 and a2, already committed (A's own replication is
  not the question): a1 holds x1 (and x2 in bound `deep`), a2 holds y1.
  f: x1 -> one output in group b0 and one in group b1 (a record whose
  outputs span two groups), y1 -> b1, x2 -> b0. Each output is an `incr`
  (not idempotent: P-17's hard case on purpose).
  Output B: groups b0 and b1. The cursor: a row per source slot in a third
  group gc (`#groups`). gc also holds sess's sessions.
  One consumer (a group member that owns both source slots). It reads the
  cursor when it starts; for each source slot in order, it sends every
  output of the record at its position, waits until each is answered, then
  appends the cursor (position + 1) to gc and moves on without waiting for
  that commit. A crash (a fault) loses all it holds; its copies stay in
  flight; a later start reads the cursor again. Time may pass while it is
  down: in bound `long`, longer than the dedup horizon H.

GHOSTS: every output write carries its ghost id (record, group).

PROPERTIES
  ONCE   no output is applied twice (B = f(A) has no extra effect).
  LOST   the committed cursor never passes a record whose outputs are not
         all committed in B (B = f(A) has no missing effect).
  DONE   AG EF over calm steps: B = f(A) exactly and every cursor at the
         end, from every state judged (the consumer has copies left).

OPTIONS (D, as E-20, applied to the consumer's outputs, plus srcpos)
  win     the draft with ids from the source position, as API.md's group
          run() says: issuer (consumer, source slot), call id = the source
          sequence; each B writer keeps per issuer the highest id and the
          outcomes above the floor (W = 1), and forgets an issuer silent for
          H by its writer time.
  sess    a consumer session in gc, reused by the next life while it lives,
          renewed while the consumer runs, expiring S after its last renewal;
          a B writer keeps the session's outcomes until it expires and
          answers `unknown` for an expired one; on `unknown` the consumer
          opens a new session and sends the output again (it cannot tell).
  pid     Kafka's idempotent producer without transactions (KIP-98): a new
          producer id per consumer life, a sequence per (producer, B group)
          counted from 0, the writer keeps the last sequence.
  keys    an idempotency key per output, (source slot, sequence, group),
          kept for TTL = H by writer time.
  srcpos  the attempt id is the source position (slot, sequence), kept by
          each B writer for as long as the source keeps the record (its
          retention; here the source keeps everything, so: forever).
  srchi   the cursor beside the outputs: each B writer keeps, per (consumer,
          source slot), the highest source sequence it has applied, written
          in the same entry as the output; an output at or below it is a
          duplicate. One integer per (consumer, source slot) per B group.
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
FIELDS = ('g', 'now', 'net', 'cs', 'faults', 'rr', 'drops', 'down')
IX = {f: i for i, f in enumerate(FIELDS)}
B0, B1, GC = 0, 1, 2
GN = ('b0', 'b1', 'gc')
BGROUPS = (B0, B1)
IDLE, SENT, DONE = 0, 1, 2
NEG = -99


def T(name, fn, role='', note=''):
    return Guard(name, fn, role=role, note=note)


def U(name, fn, role='', note=''):
    return Update(name, fn, role=role, note=note)


class Derived:
    CALM = ('deliver', 'tick', 'time', 'commit')
    INFO = ()
    H = 1          # the dedup horizon (win's forgetting, keys' TTL, sess's expiry)

    def __init__(self, bound):
        self.b = bound
        self.src = bound['src']                     # slot -> number of records
        self.outs = tuple(bound['outs'])            # (slot, seq, group) per output
        self.cap = bound.get('cap', 2)
        self.tmax = bound.get('tmax', 0)
        self.crashes = bound.get('crashes', 1)      # per group
        self.faults = bound.get('faults', 1)
        self.ndrops = bound.get('drops', 1)
        self.restarts = bound.get('restarts', 1)
        self.slots = tuple(sorted(self.src))
        self.bslots = bound.get('bslots')          # B slot per output (default: one slot per B group)
        self.bmove = bound.get('bmove')            # (B slot, from group, to group): a B slot move

    # ------------------------------------------------------------ state
    def init(self):
        g = tuple(((), (), E, 0) for _ in GN)
        n = len(self.outs)
        # cs: (life, pos per slot, status per output, copies per output, session generation)
        cs = (0, tuple(0 for _ in self.slots), (IDLE,) * n, (0,) * n, self.keep_on_start(0, (0,) * len(self.slots)),
              (0,) * n)
        return (g, 0, E, cs, 0, 0, 0, True)          # starts down: `start` reads the cursor

    def to_draft(self, st):
        d = dict(zip(FIELDS, st))
        d['_e'] = {}
        return d

    def freeze(self, d):
        f = d.f
        rr = f['rr']
        net = f['net']
        stat = f['cs'][2]
        # world normalisation: answers to a past life or to an output no
        # longer sent can never be taken
        dead = [m for m in net if m[0] == 'a' and (m[2] != rr or f['down'] or stat[m[3]] != SENT)]
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

    def life(self, st):
        return st[IX['cs']][0]

    def pos(self, st, slot):
        return st[IX['cs']][1][self.slots.index(slot)]

    def ostat(self, st, o):
        return st[IX['cs']][2][o]

    def kk(self, st, o):
        return st[IX['cs']][3][o]

    def cursor(self, st, slot, committed=True):
        ents = self.com(st, GC) if committed else self.log(st, GC)
        return max([e[2] for e in ents if e[0] == 'cur' and e[1] == slot] + [0])

    def append(self, d, g, entry):
        groups = list(d.f['g'])
        com, tail, lost, cr = groups[g]
        if entry in com or entry in tail:
            return
        groups[g] = (com, tail + (entry,), lost, cr)
        d.f['g'] = tuple(groups)

    def set_cs(self, d, part, i, v):
        cs = list(d.f['cs'])
        x = list(cs[part])
        x[i] = v
        cs[part] = tuple(x)
        d.f['cs'] = tuple(cs)

    def gid(self, o):
        s, q, g = self.outs[o]
        return (s, q, g)

    # ------------------------------------------------------------ option hooks
    def wid(self, st, o):
        raise NotImplementedError

    def outcome(self, st, g, wid, committed):
        raise NotImplementedError

    def option_actions(self):
        return []

    # ------------------------------------------------------------ params
    def p_start(self, md, st):
        if st[IX['down']]:
            yield {}

    def p_emit(self, md, st):
        if st[IX['down']]:
            return
        for o, (s, q, g) in enumerate(self.outs):
            if q == self.pos(st, s) and self.ostat(st, o) == IDLE:
                yield {'o': o}

    def p_resend(self, md, st):
        if st[IX['down']]:
            return
        for o in range(len(self.outs)):
            if self.ostat(st, o) == SENT and self.kk(st, o) < self.cap:
                yield {'o': o}

    def bslot(self, o):
        return self.bslots[o] if self.bslots else GN[self.outs[o][2]]

    def owner(self, st, bs):
        """World: the B group that holds B slot bs open (by log end); None
        while a move has fenced it and the target has not opened it."""
        if self.bmove and self.bmove[0] == bs:
            _, src, dst = self.bmove
            if any(e[0] == 'open' and e[1] == bs for e in self.log(st, dst)):
                return dst
            if any(e[0] == 'fence' and e[1] == bs for e in self.log(st, src)):
                return None
            return src
        return next(self.outs[o][2] for o in range(len(self.outs)) if self.bslot(o) == bs)

    def p_copies(self, md, st):
        for m in st[IX['net']]:
            if m[0] == 'c':
                g = self.owner(st, self.bslot(m[4]))
                if g is not None:
                    yield {'m': m, 'g': g}

    def p_learn(self, md, st):
        if st[IX['down']]:
            return
        for o in range(len(self.outs)):
            if self.ostat(st, o) != SENT:
                continue
            g = self.owner(st, self.bslot(o))     # the writer that holds the output's slot now
            if g is not None and self.outcome(st, g, self.wid(st, o), True) is not None:
                yield {'o': o}

    # ---- a B slot move (bound `bmove`): E-15's protocol, abstract; the
    # option says what the fence carries
    def carry_out(self, st, bs, src):
        return E

    def move_actions(self):
        def p_fence(md, st):
            if self.bmove and not any(e[0] == 'fence' for e in self.log(st, self.bmove[1])):
                yield {}

        def carry(md, st, b, d):
            d.f['_e']['carry'] = self.carry_out(st, self.bmove[0], self.bmove[1])

        def fence(md, st, b, d):
            self.append(d, self.bmove[1], ('fence', self.bmove[0], d.f['_e'].get('carry', E)))

        def p_open(md, st):
            if not self.bmove or any(e[0] == 'open' for e in self.log(st, self.bmove[2])):
                return
            for e in self.com(st, self.bmove[1]):
                if e[0] == 'fence':
                    yield {'f': e}

        def take(md, st, b, d):
            d.f['_e']['carry'] = b['f'][2]

        def opn(md, st, b, d):
            self.append(d, self.bmove[2], ('open', self.bmove[0], d.f['_e'].get('carry', E), st[IX['now']]))
        return [Action('fence', 'control', p_fence, [],
                       [U('carry', carry, 'carry', 'the fence carries the option\'s dedup state for the slot'),
                        U('append', fence, 'world')]),
                Action('open', 'deliver', p_open, [],
                       [U('carry', take, 'carry', 'open takes the carried state'), U('append', opn, 'world')])]

    def p_answers(self, md, st):
        for m in st[IX['net']]:
            if m[0] == 'a':
                yield {'m': m}

    def p_commit(self, md, st):
        if st[IX['down']]:
            return
        for s in self.slots:
            p = self.pos(st, s)
            if p >= self.src[s]:
                continue
            mine = [o for o, (s2, q, g) in enumerate(self.outs) if s2 == s and q == p]
            yield {'s': s, 'p': p, 'mine': tuple(mine)}

    # ------------------------------------------------------------ actions
    def actions(self):
        A = []

        def start(md, st, b, d):
            cs = d.f['cs']
            pos = tuple(self.cursor(st, s) for s in self.slots)
            n = len(self.outs)
            d.f['cs'] = (cs[0], pos, (IDLE,) * n, (0,) * n, self.keep_on_start(cs[4], pos), (0,) * n)
            d.f['down'] = False
        A.append(Action('start', 'deliver', self.p_start, [], [U('read', start, 'world')]))

        def emit(md, st, b, d):
            o = b['o']
            self.set_cs(d, 2, o, SENT)
            self.set_cs(d, 3, o, 1)
            if self.TIMED:
                self.set_cs(d, 5, o, st[IX['now']])
            d.f['net'] = d.f['net'] | {self.copy(st, o)}
        A.append(Action('emit', 'deliver', self.p_emit, self.emit_guards(), [U('send', emit, 'world')]))

        def resend(md, st, b, d):
            o = b['o']
            k = self.kk(st, o) + 1
            self.set_cs(d, 3, o, k)
            d.f['net'] = d.f['net'] | {self.copy(st, o)}
        A.append(Action('resend', 'tick', self.p_resend, self.resend_guards(), [U('send', resend, 'world')]))

        def learn(md, st, b, d):
            self.set_cs(d, 2, b['o'], DONE)
        A.append(Action('learn', 'deliver', self.p_learn, [], [U('done', learn, 'world')]))

        def recv(md, st, b, d):
            m = b['m']
            d.f['net'] = d.f['net'] - {m}
            if m[1] == 'dup':
                self.set_cs(d, 2, m[3], DONE)
            else:                      # 'x': unknown (sess: the session expired)
                self.on_unknown(st, b, d, m[3])
        A.append(Action('recv', 'deliver', self.p_answers, [], [U('take', recv, 'world')]))

        def all_done(w, st, b):
            return all(self.ostat(st, o) == DONE for o in b['mine'])

        def cur(md, st, b, d):
            self.append(d, GC, ('cur', b['s'], b['p'] + 1))

        def adv(md, st, b, d):
            cs = list(d.f['cs'])
            pos = list(cs[1])
            pos[self.slots.index(b['s'])] = b['p'] + 1
            cs[1] = tuple(pos)
            d.f['cs'] = tuple(cs)
        A.append(Action('commit', 'deliver', self.p_commit,
                        [T('acked', all_done, 'cursor', 'the cursor moves only after every output is answered')],
                        [U('cursor', cur, 'world'), U('advance', adv, 'world')]))

        def p_flush(md, st):
            # the consumer re-sends its position until gc holds it (a lost
            # cursor write is written again, as a periodic commit would)
            if st[IX['down']]:
                return
            for s in self.slots:
                p = self.pos(st, s)
                if p > self.cursor(st, s, committed=False):
                    yield {'s': s, 'p': p}

        def flush(md, st, b, d):
            self.append(d, GC, ('cur', b['s'], b['p']))
        A.append(Action('flush', 'deliver', p_flush, [], [U('append', flush, 'world')]))

        def p_crash(md, st):
            if not st[IX['down']] and st[IX['rr']] < self.restarts and st[IX['faults']] < self.faults:
                yield {}

        def crash(md, st, b, d):
            cs = d.f['cs']
            d.f['cs'] = (cs[0] + 1,) + cs[1:]
            d.f['rr'] = d.f['rr'] + 1
            d.f['down'] = True
            d.f['faults'] = d.f['faults'] + 1
        A.append(Action('crash', 'control', p_crash, [], [U('crash', crash, 'world')]))
        A.extend(self.option_actions())
        A.extend(self.move_actions())
        return A

    ANSWERS = False   # True: the writer answers outside the log (win's stale, sess's unknown)
    TIMED = False     # True: a rule reads an entry's writer time (win's and keys' forgetting)

    def copy(self, st, o):
        """A copy on the wire: ('c', wid, life, output, o). State reduction
        (not a rule): the life is kept only where an answer must find its
        way back, and no copy carries a copy number or a send time (no rule
        here reads them), so two identical copies in flight are one; a
        resend after a delivery makes a new one."""
        return ('c', self.wid(st, o), st[IX['rr']] if self.ANSWERS else 0, self.outs[o], o,
                st[IX['now']] if self.TIMED else 0)

    def emit_guards(self):
        return []

    def resend_guards(self):
        return []

    def budget(self):
        """E-20's time rules for the options that forget by time (win, keys):
        a copy is applied only within its budget B of its send time."""
        return Cmp('budget', lambda w, st, b: st[IX['now']] - b['m'][5], '<', lambda w, st, b: 1, role='hop',
                   note='the copy\'s budget is not spent (E-20)')

    def stop_retry(self):
        return [Cmp('horizon', lambda w, st, b: st[IX['now']] - st[IX['cs']][5][b['o']], '<', lambda w, st, b: 1,
                    role='time', note='stop resending R after the first send (E-20)')]

    def keep_on_start(self, x, pos):
        """What the consumer's last field holds after a start (sess: its
        session generation, kept across lives; pid: this life's start
        positions)."""
        return x

    def on_unknown(self, st, b, d, o):
        pass

    # ------------------------------------------------------------ world
    def world(self, st):
        g, now, net, cs, faults, rr, drops, down = st
        out = []
        for i in range(len(GN)):
            com, tail, lost, cr = g[i]
            if tail:
                e = tail[0]
                ng = g[:i] + ((com + (e,), tail[1:], E, cr),) + g[i + 1:]
                out.append((('commit', GN[i], repr(e)), 'commit', (ng,) + st[1:]))
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
                                (ng, now, net, cs, faults + 1, rr, drops, down)))
        if drops < self.ndrops and faults < self.faults:
            for m in net:
                out.append((('drop', repr(m)), 'fault', (g, now, net - {m}, cs, faults + 1, rr, drops + 1, down)))
        if now < self.tmax:
            out.append((('tick', now + 1), 'time', (g, now + 1, net, cs, faults, rr, drops, down)))
        return out

    # ------------------------------------------------------------ properties
    def applied(self, st):
        cnt = {}
        for i in BGROUPS:
            for e in self.com(st, i):
                if e[0] == 'w':
                    cnt[e[2]] = cnt.get(e[2], 0) + 1
        return cnt

    def check(self, st):
        bad = []
        cnt = self.applied(st)
        if any(v > 1 for v in cnt.values()):
            bad.append('ONCE')
        for s in self.slots:
            c = self.cursor(st, s)
            for o, (s2, q, g) in enumerate(self.outs):
                if s2 == s and q < c and not cnt.get(self.gid(o)):
                    bad.append('LOST')
                    return bad
        return bad

    def check_edge(self, s, lab, kind, t):
        return []

    def goals(self, st):
        cnt = self.applied(st)
        ok = all(cnt.get(self.gid(o)) == 1 for o in range(len(self.outs))) and \
            all(self.cursor(st, s) >= self.src[s] for s in self.slots)
        return {'DONE': ok}

    def judged(self, st):
        cs = st[IX['cs']]
        return {'DONE': all(k < self.cap for k in cs[3])}

    # ------------------------------------------------------------ shared judge pieces
    def eat(self):
        return U('eat', lambda md, st, b, d: d.f.__setitem__('net', d.f['net'] - {b['m']}), 'world')

    def write(self, extra=None):
        def f(md, st, b, d):
            m = b['m']
            s, q, g = m[3]
            x = d.f['_e'].get('x', extra(st, b) if extra else None)
            self.append(d, b['g'], ('w', m[1], (s, q, g), st[IX['now']] if self.TIMED else 0, x, self.bslot(m[4])))
        return U('append', f, 'world')

    def answer(self, code):
        def f(md, st, b, d):
            m = b['m']
            d.f['net'] = d.f['net'] | {('a', code, m[2], m[4])}   # (code, life, output)
        return U('answer', f, 'world')

    def p_forget_by(self, key_of):
        def p(md, st):
            for g in BGROUPS:
                seen = {}
                for e in self.log(st, g):
                    if e[0] == 'w':
                        k = key_of(e)
                        seen[k] = max(seen.get(k, NEG), e[3])
                    elif e[0] == 'fg':
                        seen.pop(e[1], None)
                for k, t in seen.items():
                    yield {'g': g, 'k': k, 't': t}
        return p

    def forget_action(self, key_of, note):
        def fg(md, st, b, d):
            self.append(d, b['g'], ('fg', b['k'], st[IX['now']]))
        return Action('forget', 'tick', self.p_forget_by(key_of),
                      [Cmp('silent', lambda w, st, b: st[IX['now']] - b['t'], '>=', lambda w, st, b: self.H,
                           role='time', note=note)],
                      [U('append', fg, 'mem')])

    def live_entries(self, st, g, committed, key_of):
        """The B writer's fold: write entries not forgotten (a 'fg' entry
        drops every earlier entry with its key)."""
        ents = self.com(st, g) if committed else self.log(st, g)
        out = []
        for e in ents:
            if e[0] == 'w':
                out.append(e)
            elif e[0] == 'fg':
                out = [x for x in out if key_of(x) != e[1]]
        return out


# ===================================================================== win
class Win(Derived):
    """Issuer (consumer, source slot), call id = source sequence; W = 1;
    issuers forgotten after H by writer time."""
    W = 1
    ANSWERS = True
    TIMED = True

    def resend_guards(self):
        return self.stop_retry()

    def wid(self, st, o):
        s, q, g = self.outs[o]
        return (('d', s), q)

    def view(self, st, g, iss, committed):
        es = [e for e in self.live_entries(st, g, committed, lambda e: e[1][0]) if e[1][0] == iss]
        if not es:
            return {}, NEG
        hi = max(e[1][1] for e in es)
        return {e[1][1] for e in es if e[1][1] > hi - self.W}, hi

    def outcome(self, st, g, wid, committed):
        outs, hi = self.view(st, g, wid[0], committed)
        return 'w' if wid[1] in outs else None

    def option_actions(self):
        idn = lambda w, st, b: b['m'][1][1]
        floor = lambda w, st, b: self.view(st, b['g'], b['m'][1][0], False)[1] - self.W
        notin = lambda w, st, b: b['m'][1][1] not in self.view(st, b['g'], b['m'][1][0], False)[0]
        return [
            Action('apply', 'deliver', self.p_copies,
                   [T('notin', notin, 'dedup', 'not among the outcomes'),
                    Cmp('floor', idn, '>', floor, role='dedup', note='above the floor (highest - W)'),
                    self.budget()],
                   [self.eat(), self.write()]),
            Action('dup', 'deliver', self.p_copies, [T('in', lambda w, st, b: not notin(w, st, b), 'world')],
                   [self.eat()]),
            Action('stale', 'deliver', self.p_copies,
                   [T('notin', notin, 'dedup', 'not among the outcomes'),
                    Cmp('floor', idn, '<=', floor, role='dedup', note='at or below the floor')],
                   [self.eat(), self.answer('dup')]),
            self.forget_action(lambda e: e[1][0], 'forget an issuer silent for H'),
        ]


# ===================================================================== sess
class Sess(Derived):
    """A consumer session in gc, reused across lives until it expires."""
    S = 1
    ANSWERS = True

    def sid(self, st):
        return ('s', st[IX['cs']][4])

    def wid(self, st, o):
        s, q, g = self.outs[o]
        return (self.sid(st), (s, q))

    def expired(self, st, sid):
        return any(e[0] == 'exp' and e[1] == sid for e in self.com(st, GC))

    def outcome(self, st, g, wid, committed):
        if self.expired(st, wid[0]):
            return None
        ents = self.com(st, g) if committed else self.log(st, g)
        return 'w' if any(e[0] == 'w' and e[1] == wid for e in ents) else None

    def emit_guards(self):
        return [T('registered', lambda w, st, b: any(e[0] == 'ren' and e[1] == self.sid(st) for e in self.com(st, GC)),
                  'dedup', 'send only once the session is registered')]

    def on_unknown(self, st, b, d, o):
        # the session expired: the consumer cannot tell whether the output
        # landed; it opens a new session and sends the output again
        cs = d.f['cs']
        if cs[4] == st[IX['cs']][4]:
            d.f['cs'] = cs[:4] + (cs[4] + 1,) + cs[5:] + cs[5:]
        self.set_cs(d, 2, o, IDLE)
        self.set_cs(d, 3, o, 0)

    def option_actions(self):
        live = lambda w, st, b: not self.expired(st, b['m'][1][0])
        notin = lambda w, st, b: self.outcome(st, b['g'], b['m'][1], False) is None

        def p_reg(md, st):
            if not st[IX['down']] and not any(e[0] == 'ren' and e[1] == self.sid(st) for e in self.log(st, GC)) \
                    and not self.expired(st, self.sid(st)):
                yield {}

        def p_newsess(md, st):
            if not st[IX['down']] and self.expired(st, self.sid(st)) and st[IX['cs']][4] < 2:
                yield {}

        def newsess(md, st, b, d):
            cs = d.f['cs']
            d.f['cs'] = cs[:4] + (cs[4] + 1,) + cs[5:]

        def p_renew(md, st):
            sid = self.sid(st)
            lg = self.log(st, GC)
            rens = [e for e in lg if e[0] == 'ren' and e[1] == sid]
            if not st[IX['down']] and rens and len(rens) < 2 and not any(e[0] == 'exp' and e[1] == sid for e in lg) \
                    and all(e[2] < st[IX['now']] for e in rens):
                yield {}

        def reg(md, st, b, d):
            self.append(d, GC, ('ren', self.sid(st), st[IX['now']]))

        def p_exp(md, st):
            lg = self.log(st, GC)
            for sid in {e[1] for e in lg if e[0] == 'ren'}:
                if not any(e[0] == 'exp' and e[1] == sid for e in lg):
                    yield {'sid': sid, 't': max(e[2] for e in lg if e[0] == 'ren' and e[1] == sid)}

        def exp(md, st, b, d):
            self.append(d, GC, ('exp', b['sid']))
        return [
            Action('register', 'deliver', p_reg, [], [U('append', reg, 'world')]),
            Action('renew', 'tick', p_renew, [], [U('append', reg, 'world')]),
            Action('newsess', 'deliver', p_newsess, [], [U('sid', newsess, 'world')]),
            Action('apply', 'deliver', self.p_copies,
                   [T('notin', notin, 'dedup', 'not among the session\'s outcomes'),
                    T('live', live, 'dedup', 'the session has not expired')],
                   [self.eat(), self.write()]),
            Action('dup', 'deliver', self.p_copies,
                   [T('in', lambda w, st, b: live(w, st, b) and not notin(w, st, b), 'world')], [self.eat()]),
            Action('expired', 'deliver', self.p_copies,
                   [T('dead', lambda w, st, b: not live(w, st, b), 'dedup', 'the session expired')],
                   [self.eat(), self.answer('x')]),
            Action('expire', 'tick', p_exp,
                   [Cmp('silent', lambda w, st, b: st[IX['now']] - b['t'], '>=', lambda w, st, b: self.S, role='time',
                        note='a session not renewed for S expires')],
                   [U('append', exp, 'mem')]),
        ]


# ===================================================================== pid
class Pid(Derived):
    """Kafka's idempotent producer, no transactions: a new producer id per
    life, a sequence per (producer, B group) from 0."""

    def keep_on_start(self, x, pos):
        return pos

    def wid(self, st, o):
        """(producer, partition, sequence): a new producer id per life; the
        sequence counts this life's outputs to that group, in the consumer's
        order, from where this life started (Kafka's per-partition count)."""
        s, q, g = self.outs[o]
        start = st[IX['cs']][4]
        n = sum(1 for (s2, q2, g2) in self.outs[:o] if g2 == g and q2 >= start[self.slots.index(s2)])
        return (('p', self.life(st)), g, n)

    def last(self, st, g, p, committed):
        ents = self.com(st, g) if committed else self.log(st, g)
        qs = [e[1][2] for e in ents if e[0] == 'w' and e[1][0] == p]
        return max(qs) if qs else None

    def outcome(self, st, g, wid, committed):
        lst = self.last(st, g, wid[0], committed)
        return 'w' if lst is not None and wid[2] <= lst else None

    def option_actions(self):
        seq = lambda w, st, b: b['m'][1][2]
        last = lambda w, st, b: self.last(st, b['g'], b['m'][1][0], False)
        return [
            Action('apply_next', 'deliver', self.p_copies,
                   [T('known', lambda w, st, b: last(w, st, b) is not None, 'dedup', 'state for (producer, partition)'),
                    Cmp('next', seq, '==', lambda w, st, b: last(w, st, b) + 1, role='dedup', note='the next sequence')],
                   [self.eat(), self.write()]),
            Action('apply_first', 'deliver', self.p_copies,
                   [T('unknown', lambda w, st, b: last(w, st, b) is None, 'dedup', 'a new producer'),
                    Cmp('zero', seq, '==', lambda w, st, b: 0, role='dedup', note='starts at 0')],
                   [self.eat(), self.write()]),
            Action('dup', 'deliver', self.p_copies,
                   [T('seen', lambda w, st, b: last(w, st, b) is not None and seq(w, st, b) <= last(w, st, b), 'world')],
                   [self.eat()]),
        ]


# ===================================================================== keys
class Keys(Derived):
    """An idempotency key per output, kept for TTL = H."""
    TIMED = True

    def resend_guards(self):
        return self.stop_retry()

    def wid(self, st, o):
        return ('k',) + self.outs[o]

    def outcome(self, st, g, wid, committed):
        es = self.live_entries(st, g, committed, lambda e: e[1])
        return 'w' if any(e[1] == wid for e in es) else None

    def option_actions(self):
        notin = lambda w, st, b: self.outcome(st, b['g'], b['m'][1], False) is None
        return [
            Action('apply', 'deliver', self.p_copies, [T('notin', notin, 'dedup', 'the key is not in the table'),
                                                        self.budget()],
                   [self.eat(), self.write()]),
            Action('dup', 'deliver', self.p_copies, [T('in', lambda w, st, b: not notin(w, st, b), 'world')],
                   [self.eat()]),
            self.forget_action(lambda e: e[1], 'a key lives for its TTL'),
        ]


# ===================================================================== srcpos
class SrcPos(Derived):
    """The attempt id is the source position and the output's order k within
    the record's outputs (as a keyed call's (key, k), DESIGN-V5 4.5); kept for
    the source's retention (the source keeps everything here, so it is never
    dropped). ID_K = False is the id without k (bound bmove shows why k is
    needed)."""
    ID_K = True

    def wid(self, st, o):
        s, q, g = self.outs[o]
        k = sum(1 for (s2, q2, g2) in self.outs[:o] if (s2, q2) == (s, q))
        return ('d', s, q, k) if self.ID_K else ('d', s, q)

    def outcome(self, st, g, wid, committed):
        ents = self.com(st, g) if committed else self.log(st, g)
        return 'w' if any((e[0] == 'w' and e[1] == wid) or (e[0] == 'open' and wid in e[2]) for e in ents) else None

    def carry_out(self, st, bs, src):
        return frozenset(e[1] for e in self.log(st, src) if e[0] == 'w' and e[5] == bs)

    def option_actions(self):
        notin = lambda w, st, b: self.outcome(st, b['g'], b['m'][1], False) is None
        return [
            Action('apply', 'deliver', self.p_copies,
                   [T('notin', notin, 'dedup', 'the source position is not in the key table')],
                   [self.eat(), self.write()]),
            Action('dup', 'deliver', self.p_copies, [T('in', lambda w, st, b: not notin(w, st, b), 'world')],
                   [self.eat()]),
        ]


# ===================================================================== srchi
class SrcHi(Derived):
    """The cursor beside the outputs: per (consumer, source slot), the
    highest source sequence applied at this B group, in the output entry."""

    def wid(self, st, o):
        s, q, g = self.outs[o]
        return ('d', s, q)

    def hi(self, st, g, k, committed):
        """The highest source sequence applied here for key k: (source slot)
        here; (source slot, B slot) in srchi-slot."""
        ents = self.com(st, g) if committed else self.log(st, g)
        qs = [e[4] for e in ents if e[0] == 'w' and e[4] is not None and self.ekey(e) == k]
        for e in ents:
            if e[0] == 'open':
                qs += [h for kk, h in e[2] if kk == k]
        return max(qs) if qs else NEG

    def ekey(self, e):
        return e[1][1]

    def wkey(self, wid):
        return wid[1]

    def carry_out(self, st, bs, src):
        # the draft's "fence tables carried whole and merged by max"
        ks = {self.ekey(e) for e in self.log(st, src) if e[0] == 'w' and e[4] is not None}
        return frozenset((k, self.hi(st, src, k, False)) for k in ks)

    def outcome(self, st, g, wid, committed):
        return 'w' if wid[2] <= self.hi(st, g, self.wkey(wid), committed) else None

    def option_actions(self):
        q = lambda w, st, b: b['m'][1][2]
        hi = lambda w, st, b: self.hi(st, b['g'], self.wkey(b['m'][1]), False)

        def mark(md, st, b, d):
            d.f['_e']['x'] = b['m'][1][2]
        return [
            Action('apply', 'deliver', self.p_copies,
                   [Cmp('above', q, '>', hi, role='dedup', note='above the highest source sequence applied here')],
                   [self.eat(), U('mark', mark, 'dedup', 'the entry records its source sequence (the cursor row)'),
                    U('append', self.write().fn, 'world')]),
            Action('dup', 'deliver', self.p_copies, [T('in', lambda w, st, b: not (q(w, st, b) > hi(w, st, b)), 'world')],
                   [self.eat()]),
        ]


class SrcPosNoK(SrcPos):
    ID_K = False


class SrcHiSlot(SrcHi):
    """srchi kept per (consumer, source slot, B slot), so a B slot move
    carries exactly that slot's numbers."""

    def wid(self, st, o):
        s, q, g = self.outs[o]
        return ('d', s, q, self.bslot(o))

    def ekey(self, e):
        return (e[1][1], e[5])

    def wkey(self, wid):
        return (wid[1], wid[3])

    def carry_out(self, st, bs, src):
        ks = {self.ekey(e) for e in self.log(st, src) if e[0] == 'w' and e[4] is not None and e[5] == bs}
        return frozenset((k, self.hi(st, src, k, False)) for k in ks)


OPTIONS = {'win': Win, 'sess': Sess, 'pid': Pid, 'keys': Keys, 'srcpos': SrcPos, 'srchi': SrcHi,
           'srchi-slot': SrcHiSlot, 'srcpos-nok': SrcPosNoK}

_OUTS = (('a1', 0, B0), ('a1', 0, B1), ('a2', 0, B1))
BOUNDS = {
    # a restart shorter than the horizon (no time passes)
    'short': {'src': {'a1': 1, 'a2': 1}, 'outs': _OUTS, 'cap': 2, 'crashes': 0, 'faults': 1, 'drops': 0,
              'tmax': 0, 'restarts': 1},
    # a restart and a B or gc leader crash (a lost tail)
    'gcrash': {'src': {'a1': 1, 'a2': 1}, 'outs': _OUTS, 'cap': 2, 'crashes': 1, 'faults': 2, 'drops': 0,
               'tmax': 0, 'restarts': 1},
    # a restart and a lost copy
    'drop': {'src': {'a1': 1, 'a2': 1}, 'outs': _OUTS, 'cap': 2, 'crashes': 0, 'faults': 2, 'drops': 1,
             'tmax': 0, 'restarts': 1},
    # a restart longer than the horizon: time passes while the consumer is down
    'long': {'src': {'a1': 1, 'a2': 1}, 'outs': _OUTS, 'cap': 2, 'crashes': 0, 'faults': 1, 'drops': 0,
             'tmax': 2, 'restarts': 1},
    # deeper: x2 follows x1 on a1 (one source slot), two restarts, short
    'deep': {'src': {'a1': 2}, 'outs': (('a1', 0, B0), ('a1', 0, B1), ('a1', 1, B0)), 'cap': 2, 'crashes': 0,
             'faults': 2, 'drops': 0, 'tmax': 0, 'restarts': 2},
}
# A B slot move: x1 has outputs in B slots P (in b0) and R (in b1); R moves
# from b1 to b0 while the consumer may crash and restart: what must the move
# carry for each option?
BOUNDS['bmove'] = {'src': {'a1': 1}, 'outs': (('a1', 0, B0), ('a1', 0, B1)), 'bslots': ('P', 'R'),
                   'bmove': ('R', B1, B0), 'cap': 2, 'crashes': 0, 'faults': 1, 'drops': 0, 'tmax': 0, 'restarts': 1}
BOUNDS['bmove2'] = {'src': {'a1': 2}, 'outs': (('a1', 0, B0), ('a1', 0, B1), ('a1', 1, B0)),
                    'bslots': ('P', 'R', 'P'), 'bmove': ('R', B1, B0), 'cap': 2, 'crashes': 0, 'faults': 1,
                    'drops': 0, 'tmax': 0, 'restarts': 1}
SWEEP = ('short', 'gcrash', 'drop', 'long', 'deep', 'bmove', 'bmove2')
VERIFY = ()
PIN = ('start.read', 'flush.append', 'fence.append', 'open.append', 'emit.send', 'resend.send', 'learn.done', 'recv.take', 'commit.cursor', 'commit.advance',
       'crash.crash', 'register.append', 'renew.append', 'newsess.sid', 'dup.in', 'dup.eat', 'dup.seen',
       'apply.eat', 'apply.append', 'apply_next.eat', 'apply_next.append', 'apply_first.eat', 'apply_first.append',
       'stale.eat', 'stale.answer', 'expired.eat', 'expired.answer', 'forget.append', 'expire.append')
PINNED = {k: PIN for k in OPTIONS}
