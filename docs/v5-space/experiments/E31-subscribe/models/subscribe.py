"""
subscribe.py: the subscribe protocol of DESIGN-V5 4.4 (L3, flow), across a
leader crash, a follower's snapshot reload, a slot move and a relay. E-31
(QUESTIONS Q-31). Exhaustive, in slot_move.py's style, on E-16's engine with
E-17's rule language (so rules and mutants are counted as DEV-10 says).

THE WORLD (not counted)
- One followed slot s and its committed log, written from a fixed script:
  1 `set a`, 2 `set b` (the client's own write), 3 `del a`. Every prefix has a
  different fold ({}, {a}, {a,b}, {b}), so a stale or ghost view shows.
- Group A holds s at first: its leader LA and its follower FA. Group B's
  leader LB takes s if the bound moves it. The group that holds s has one
  uncommitted entry at most (the tail) at its leader; a commit appends it to
  the log; a leader crash loses it. The client retries its own write (record
  2); other writers do not, so the next script record takes that position
  (a reader that saw the lost record would see a different one there).
- A server's fold is (loaded, fold, base): it holds the records in
  (base, fold] and the rows at fold. LA keeps every segment (base 0). FA
  catches up one record at a time. FA may fall behind and reload a snapshot
  (a fault): while it loads it is unloaded, then its fold is the commit
  offset and its base is that offset (it holds no older records).
- The move (bound `mv`): A fences s at N = the commit offset (with no tail),
  then B opens s with A's rows at N. Positions are per slot, so they go on at
  B from N + 1 (O `slot`); option `off` gives B its own offsets instead.
- A relay R (bound `rl`) subscribes upstream like any subscriber and serves
  the client from its own fold.
- The client C has one subscription in the bound's mode, `state` (a snapshot,
  then deltas or conflated diffs, each replacing what it covers) or `log`
  (every record from its cursor). Credits of one record: each link carries at
  most one message at a time. C writes record 2 and waits for it.
- Faults (budget): LA crashes (FA leads A); FA reloads; the relay crashes; a
  link drops (an overflow closes it). Starting the move is a control step.

WHAT IS COUNTED (DEV-10): the servers' answers and their guards (when a
server may send a snapshot, a record or a diff, and when it says moved,
retry, end or expired), the subscriber's handling of each answer, the
relay's readiness, the move's carried state that serving needs, and the
client's write resolution.

PROPERTIES
  P1  log: what the client took is the committed log's prefix, in order, once.
  P2  state: the client's view equals the fold of the committed log at its
      cursor (no ghost rows, nothing uncommitted), after every message.
  P3  nobody answers from an unloaded fold (no snapshot, record or diff from
      a server or relay that has not loaded).
  P4  a resolved write is visible to its writer's own subscription, and stays.
  P6  the client's cursor never goes back.
  P7  no false `expired`: the client is told `expired` only when no replica
      holds its next record (here every record is kept somewhere, so never).
  P5  (AG EF) after any answer, with faults over, the client reaches a
      serving replica and catches up: its cursor at the commit offset, the
      script written, its write resolved; or it was told a true `expired`
      (the records it needs are on no live replica of the slot).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

SCRIPT = (('set', 'a'), ('set', 'b'), ('del', 'a'))
MINE = 2                      # the client's own write is script record 2
LA, FA, LB, RL = 0, 1, 2, 3   # sources: three servers and the relay
NAMES = ('LA', 'FA', 'LB', 'R')
FIELDS = ('log', 'tail', 'nxt', 'phase', 'alead', 'srv', 'segs', 'rel', 'cl', 'faults', 'mine')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()
K_OFF = 1                     # option off: B's log holds one record of another slot first


def fold(recs):
    rows = set()
    for c in recs:
        op, r = SCRIPT[c - 1]
        if op == 'set':
            rows.add(r)
        else:
            rows.discard(r)
    return frozenset(rows)


class Sub:
    CALM = ('deliver', 'commit', 'apply', 'time')
    INFO = ()
    FIXED = False      # a reloaded follower ends log subscriptions with END, not expired
    OFF = False        # positions are per group offsets, not per slot sequences

    def __init__(self, bound):
        self.b = bound
        self.mode = bound['mode']
        self.relay = bound.get('relay', False)
        self.move = bound.get('move', False)

    # state:
    #  log    committed records of s (script ids), positions 1..n
    #  tail   the holding group leader's uncommitted record, or 0
    #  nxt    the next script index to propose (0-based)
    #  phase  'A', ('F', N) fenced at N, ('B', N) open at B
    #  alead  A's leader: LA or FA
    #  srv    per server (alive, loaded, fold, base)
    #  segs   B was carried A's segment names (it can serve records <= N)
    #  rel    the relay (alive, src, link, inflight, cursor, view, loaded, base)
    #  cl     the client (src, link, inflight, cursor, view, resolved, dead)
    #  mine   position of the client's write once committed, else 0
    def init(self):
        srv = ((True, True, 0, 0), (True, True, 0, 0), (True, False, 0, 0))
        rel = (self.relay, None, None, None, 0, self.view0(), self.mode == 'log', 0)
        cl = (None, None, None, 0, self.view0(), False, False)
        return ((), 0, 0, 'A', LA, srv, False, rel, cl, 0, 0)

    def view0(self):
        return E if self.mode == 'state' else ()

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
        """Server x holds s open (DESIGN 4.4: readiness is per slot)."""
        ph = st[IX['phase']]
        if x in (LA, FA):
            return ph == 'A'
        return ph != 'A' and ph[0] == 'B'

    def src_state(self, st, x):
        """(alive, loaded, fold, base) of a source, the relay included."""
        if x == RL:
            a, s, lk, inf, cur, view, ld, base = st[IX['rel']]
            return (a, ld, cur, base)
        a, ld, f, base = st[IX['srv']][x]
        if x == LB and st[IX['segs']] and ld:
            # B reads the records below N from A's segments: as far back as a
            # live A replica still holds them (no object store in this model)
            n = st[IX['phase']][1]
            held = [st[IX['srv']][y][3] for y in (LA, FA) if st[IX['srv']][y][0] and st[IX['srv']][y][1]]
            base = min([n] + held)
        return (a, ld, f, base)

    def src_rows(self, st, x):
        if x == RL:
            rel = st[IX['rel']]
            return rel[5] if self.mode == 'state' else fold(rel[5])
        a, ld, f, base = st[IX['srv']][x]
        return fold(st[IX['log']][:f]) if ld else E

    def rec_at(self, st, x, pos):
        """The record source x sends as position pos (its own numbering)."""
        log = st[IX['log']]
        if x == RL:
            rel = st[IX['rel']]
            if self.mode == 'log':
                recv = rel[5]
                return recv[pos - 1] if 0 < pos <= len(recv) else None
            return log[pos - 1] if 0 < pos <= len(log) else None
        pos = self.slotpos(x, pos)
        if pos == len(log) + 1 and st[IX['tail']] and self.leads(st, x):
            return st[IX['tail']]      # the leader's uncommitted entry
        return log[pos - 1] if 0 < pos <= len(log) else None

    def expire_answer(self, st, b):
        x, who = b['x'], b['who']
        if who == 'rel' or x == RL:
            return ('end',)
        if not self.FIXED or self.leads(st, x):
            return ('expired',)
        return ('end',)

    def slotpos(self, x, pos):
        """Under OFF, B reads a position as its own offset."""
        return pos - K_OFF if (self.OFF and x == LB) else pos

    def leads(self, st, x):
        h = self.holder(st)
        return (h == 'A' and x == st[IX['alead']]) or (h == 'B' and x == LB)

    def sub(self, st, who):
        """A subscriber's link: (src, link, inflight, cursor, view)."""
        if who == 'cl':
            s, lk, inf, cur, view, res, dead = st[IX['cl']]
        else:
            a, s, lk, inf, cur, view, ld, base = st[IX['rel']]
        return s, lk, inf, cur, view

    def setsub(self, d, who, **kw):
        if who == 'cl':
            names = ('src', 'link', 'inf', 'cur', 'view', 'res', 'dead')
            v = dict(zip(names, d.f['cl']))
            v.update(kw)
            d.f['cl'] = tuple(v[n] for n in names)
        else:
            names = ('alive', 'src', 'link', 'inf', 'cur', 'view', 'loaded', 'base')
            v = dict(zip(names, d.f['rel']))
            v.update(kw)
            d.f['rel'] = tuple(v[n] for n in names)

    def setsrv(self, d, x, **kw):
        names = ('alive', 'loaded', 'fold', 'base')
        srv = list(d.f['srv'])
        v = dict(zip(names, srv[x]))
        v.update(kw)
        srv[x] = tuple(v[n] for n in names)
        d.f['srv'] = tuple(srv)

    # ------------------------------------------------------------ world
    def world(self, st):
        log, tail, nxt, phase, alead, srv, segs, rel, cl, faults, mine = st
        out = []
        h = self.holder(st)
        lead = alead if h == 'A' else (LB if h == 'B' else None)
        # the holding group's leader proposes the next script record (the
        # client's own write is record 2)
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
            out.append((('commit', tail), 'commit', self.freeze(d)))
        # replicas apply committed records (A's up to the fence)
        top = len(log) if phase == 'A' else phase[1]     # A applies up to its fence
        for x in (LA, FA):
            a, ld, f, base = srv[x]
            if a and ld and f < top:
                d = self._d(st)
                self.setsrv(d, x, fold=f + 1)
                out.append((('apply', NAMES[x]), 'apply', self.freeze(d)))
        a, ld, f, base = srv[LB]
        if a and ld and f < len(log):
            d = self._d(st)
            self.setsrv(d, LB, fold=f + 1)
            out.append((('apply', 'LB'), 'apply', self.freeze(d)))
        if faults < self.b['faults']:
            # A's leader crashes: FA leads A; an uncommitted tail at A is lost
            if srv[LA][0] and 'crash' in self.b['kinds']:
                d = self._d(st)
                self.setsrv(d, LA, alive=False)
                d.f['alead'] = FA
                if h == 'A' and tail:
                    d.f['tail'] = 0
                    if tail == MINE:
                        d.f['nxt'] = MINE - 1     # the client retries its own write
                d.f['faults'] = faults + 1
                out.append((('crash', 'LA'), 'fault', self.freeze(d)))
            # FA falls behind the tail and reloads a snapshot
            if srv[FA][0] and srv[FA][1] and 'reload' in self.b['kinds']:
                d = self._d(st)
                self.setsrv(d, FA, loaded=False)
                d.f['faults'] = faults + 1
                out.append((('reload', 'FA'), 'fault', self.freeze(d)))
            if self.relay and rel[0] and 'relay' in self.b['kinds']:
                d = self._d(st)
                self.setsub(d, 'rel', alive=False, src=None, link=None, inf=None, loaded=self.mode == 'log')
                d.f['faults'] = faults + 1
                out.append((('crash', 'R'), 'fault', self.freeze(d)))
            # a link overflows and is closed
            if 'drop' in self.b['kinds']:
                for who in ('cl', 'rel') if self.relay else ('cl',):
                    s = self.sub(st, who)
                    if s[0] is not None and (who == 'cl' or rel[0]):
                        d = self._d(st)
                        self.setsub(d, who, src=None, link=None, inf=None)
                        d.f['faults'] = faults + 1
                        out.append((('drop', who), 'fault', self.freeze(d)))
        # the reload finishes: a snapshot at the commit offset (time)
        a, ld, f, base = srv[FA]
        if a and not ld:
            d = self._d(st)
            self.setsrv(d, FA, loaded=True, fold=top, base=top)
            out.append((('loaded', 'FA'), 'time', self.freeze(d)))
        # the relay restarts empty (time)
        if self.relay and not rel[0]:
            d = self._d(st)
            self.setsub(d, 'rel', alive=True, src=None, link=None, inf=None, cur=0, view=self.view0(),
                        loaded=self.mode == 'log', base=0)
            out.append((('restart', 'R'), 'time', self.freeze(d)))
        # a subscriber notices its source is gone (a timeout)
        for who in ('cl', 'rel') if self.relay else ('cl',):
            s = self.sub(st, who)
            if s[0] is not None and not self.src_state(st, s[0])[0]:
                d = self._d(st)
                self.setsub(d, who, src=None, link=None, inf=None)
                out.append((('timeout', who), 'time', self.freeze(d)))
        # the move: A fences s at the commit offset, then B opens it
        if self.move and phase == 'A' and not tail:
            d = self._d(st)
            d.f['phase'] = ('F', len(log))
            out.append((('fence', len(log)), 'control', self.freeze(d)))
        return out

    # ------------------------------------------------------------ properties
    def check(self, st):
        bad = []
        log = st[IX['log']]
        s, lk, inf, cur, view, res, dead = st[IX['cl']]
        if self.mode == 'log':
            if view != log[:len(view)] or cur != len(view):
                bad.append('P1')
        else:
            if cur > len(log) or view != fold(log[:cur]):
                bad.append('P2')
        mine = st[IX['mine']]
        if res and cur < mine:
            bad.append('P4')
        return bad

    def check_edge(self, s, lab, kind, t):
        bad = []
        if t[IX['cl']][3] < s[IX['cl']][3]:
            bad.append('P6')
        if lab[0] in ('snap', 'rec', 'diff'):
            b = dict(lab[1])
            if not self.src_state(s, b['x'])[1]:
                bad.append('P3')
        if lab[0] == 'gotexp':
            # P7: some live replica holding s could have served the next record
            cur = s[IX['cl']][3]
            for x in (LA, FA, LB):
                a, ld, f, base = self.src_state(s, x)
                if a and ld and self.holds(s, x) and base <= cur:
                    bad.append('P7')
                    break
        return bad

    def goals(self, st):
        log = st[IX['log']]
        s, lk, inf, cur, view, res, dead = st[IX['cl']]
        done = st[IX['nxt']] == len(SCRIPT) and not st[IX['tail']]
        # a true `expired` (P7 checks it is true) is also an end: the records
        # the reader needs are gone from every live replica of the slot
        return {'P5': done and (dead or (cur == len(log) and res))}

    def judged(self, st):
        return {'P5': True}

    # ------------------------------------------------------------ rules
    def actions(self):
        O = self
        whos = ('cl', 'rel') if self.relay else ('cl',)

        def links(w, st):
            """Every subscriber with a source, the source it is linked to."""
            for who in whos:
                if who == 'rel' and not st[IX['rel']][0]:
                    continue
                s, lk, inf, cur, view = O.sub(st, who)
                if s is not None:
                    yield {'who': who, 'x': s}

        def free(w, st):
            for who in whos:
                if who == 'rel' and not st[IX['rel']][0]:
                    continue
                if who == 'cl' and st[IX['cl']][6]:
                    continue
                s, lk, inf, cur, view = O.sub(st, who)
                if s is None:
                    for x in ((LA, FA, LB, RL) if who == 'cl' and O.relay else (LA, FA, LB)):
                        yield {'who': who, 'x': x}

        def inbox(w, st):
            for who in whos:
                if who == 'rel' and not st[IX['rel']][0]:
                    continue
                s, lk, inf, cur, view = O.sub(st, who)
                if inf is not None:
                    yield {'who': who, 'x': s}

        def sendable(w, st):
            # topology, not a rule: a source can only send what it holds
            for b in links(w, st):
                s, lk, inf, cur, view = O.sub(st, b['who'])
                a, ld, f, base = O.src_state(st, b['x'])
                if a and inf is None:
                    yield b

        SUB = lambda st, b: O.sub(st, b['who'])
        SRC = lambda st, b: O.src_state(st, b['x'])
        cur_ = lambda w, st, b: SUB(st, b)[3]
        isrc = lambda x: x == RL

        # positions a source sends are its own: per slot (the same everywhere),
        # or under OFF, B's own offsets
        def srcpos(st, x, f):
            return f + K_OFF if (O.OFF and x == LB) else f

        def ready(name):
            return [
                Guard(name + 'loaded', lambda w, st, b: SRC(st, b)[1], role='ready',
                      note='a replica answers only once its snapshot has loaded; a relay only once its upstream snapshot has landed'),
                Guard(name + 'holds', lambda w, st, b: isrc(b['x']) or O.holds(st, b['x']), role='ready',
                      note='a shard serves a slot only while it holds it open'),
            ]

        # -------- servers' and the relay's answers
        acts = []
        # topology: actions of the other mode have no parameters (so every
        # bound has the same rule list, which the ablation needs)
        def only(mode, gen):
            return lambda w, st: gen(w, st) if O.mode == mode else iter(())
        snap_g = [Guard('req', lambda w, st, b: SUB(st, b)[1] in ('req', 'on'), role='seq')] + ready('') + [
            Cmp('cursor', lambda w, st, b: srcpos(st, b['x'], SRC(st, b)[2]), '>=', cur_, role='cursor',
                note='never before its fold has reached the subscriber\'s cursor'),
        ]

        def snap_send(w, st, b, d):
            x = b['x']
            O.setsub(d, b['who'], link='on', inf=('snap', srcpos(st, x, SRC(st, b)[2]), O.src_rows(st, x)))


        acts.append(Action('snap', 'deliver', only('state', sendable), snap_g, [
            Update('send', snap_send, role='serve', note='a snapshot of exactly the slot at the fold'),
        ]))

        # a conflated diff from the cursor to the fold: rows set and rows removed
        def diff_send(w, st, b, d):
            x = b['x']
            f = SRC(st, b)[2]
            old = fold(st[IX['log']][:O.slotpos(x, cur_(w, st, b))])
            new = O.src_rows(st, x)
            O.setsub(d, b['who'], link='on', inf=('diff', srcpos(st, x, f), new - old, old - new))

        acts.append(Action('diff', 'deliver', only('state', sendable), [
            Guard('req', lambda w, st, b: SUB(st, b)[1] in ('req', 'on'), role='seq'),
            *ready(''),
            Cmp('behind', cur_, '<', lambda w, st, b: srcpos(st, b['x'], SRC(st, b)[2]), role='serve'),
            Cmp('held', lambda w, st, b: srcpos(st, b['x'], SRC(st, b)[3]), '<=', cur_, role='serve',
                note='a diff from the cursor needs the records after it; else a snapshot replaces'),
        ], [Update('send', diff_send, role='serve', note='deltas since the cursor, conflated per row')]))
        # log: a subscription opens at the cursor; then one record per credit
        # log: a subscription opens at the cursor; then one record per credit
        acts.append(Action('open', 'deliver', only('log', sendable), [
            Guard('req', lambda w, st, b: SUB(st, b)[1] == 'req', role='seq'),
            *ready(''),
            Cmp('held', lambda w, st, b: srcpos(st, b['x'], SRC(st, b)[3]), '<=', cur_, role='cursor',
                note='it holds the record after the cursor'),
        ], [Update('on', lambda w, st, b, d: O.setsub(d, b['who'], link='on'), role='serve')]))
        acts.append(Action('rec', 'deliver', sendable, [
            Guard('on', lambda w, st, b: SUB(st, b)[1] == 'on', role='seq'),
            *ready(''),
            Cmp('committed', cur_, '<', lambda w, st, b: srcpos(st, b['x'], SRC(st, b)[2]), role='serve',
                note='only up to its fold, which holds committed records only'),
            Cmp('held', lambda w, st, b: srcpos(st, b['x'], SRC(st, b)[3]), '<=', cur_, role='serve'),
        ], [Update('send', lambda w, st, b, d: O.setsub(d, b['who'], inf=(
            'rec', cur_(w, st, b) + 1, O.rec_at(st, b['x'], cur_(w, st, b) + 1))), role='serve',
            note='the next record, carrying its slot sequence')]))
        acts.append(Action('moved', 'deliver', sendable, [
            Guard('notholds', lambda w, st, b: b['x'] in (LA, FA) and st[IX['phase']] != 'A', role='answer',
                  note='A answers moved(B) once its fence commits, and ends what it streamed'),
        ], [Update('send', lambda w, st, b, d: O.setsub(d, b['who'], inf=('moved',)), role='answer')]))
        acts.append(Action('notready', 'deliver', sendable, [
            Guard('unready', lambda w, st, b: not SRC(st, b)[1] or (b['x'] == LB and not O.holds(st, LB)),
                  role='answer',
                  note='an unloaded replica answers moved, naming a ready one; B answers retry until it opens'),
        ], [Update('send', lambda w, st, b, d: O.setsub(d, b['who'], inf=('retry',)), role='answer')]))

        acts.append(Action('expire', 'deliver', only('log', sendable), [
            Guard('on', lambda w, st, b: SUB(st, b)[1] in ('req', 'on'), role='seq'),
            Guard('loaded', lambda w, st, b: SRC(st, b)[1], role='answer'),
            Cmp('lost', lambda w, st, b: srcpos(st, b['x'], SRC(st, b)[3]), '>', cur_, role='answer',
                note='it no longer holds the record after the cursor (a reload, or a relay that started later)'),
        ], [Update('send', lambda w, st, b, d: O.setsub(d, b['who'], inf=O.expire_answer(st, b)),
            role='answer', note='draft: a replica that lacks the record ends log subscriptions with expired; '
                                'fixed: with END, so the reader goes elsewhere, and only the holding '
                                "group's leader, whose log is the group's retention, says expired")]))

        # -------- a subscriber takes what arrived
        def take(kind):
            return Guard('is', lambda w, st, b: SUB(st, b)[2][0] == kind, role='seq')

        def apply_snap_clear(w, st, b, d):
            O.setsub(d, b['who'], view=E)

        def apply_snap_rows(w, st, b, d):
            inf = SUB(st, b)[2]
            v = d.f['cl'][4] if b['who'] == 'cl' else d.f['rel'][5]
            O.setsub(d, b['who'], view=v | inf[2])

        def apply_cursor(w, st, b, d):
            O.setsub(d, b['who'], cur=SUB(st, b)[2][1])

        def clear_inf(w, st, b, d):
            O.setsub(d, b['who'], inf=None)

        def rel_loaded(w, st, b, d):
            if b['who'] == 'rel' and SUB(st, b)[2][0] == 'snap':
                O.setsub(d, 'rel', loaded=True, base=SUB(st, b)[2][1])


        acts.append(Action('gotsnap', 'deliver', only('state', inbox), [take('snap')], [
            Update('clear', apply_snap_clear, role='replace', note='a snapshot replaces the whole view'),
            Update('rows', apply_snap_rows, role='replace'),
            Update('cursor', apply_cursor, role='cursor'),
            Update('loaded', rel_loaded, role='ready', note='a relay is loaded once its snapshot landed'),
            Update('credit', clear_inf, role='seq'),
        ]))

        def diff_add(w, st, b, d):
            inf = SUB(st, b)[2]
            v = d.f['cl'][4] if b['who'] == 'cl' else d.f['rel'][5]
            O.setsub(d, b['who'], view=v | inf[2])

        def diff_del(w, st, b, d):
            inf = SUB(st, b)[2]
            v = d.f['cl'][4] if b['who'] == 'cl' else d.f['rel'][5]
            O.setsub(d, b['who'], view=v - inf[3])

        acts.append(Action('gotdiff', 'deliver', only('state', inbox), [take('diff')], [
            Update('add', diff_add, role='replace'),
            Update('del', diff_del, role='replace', note='a conflated diff carries removals'),
            Update('cursor', apply_cursor, role='cursor'),
            Update('credit', clear_inf, role='seq'),
        ]))

        def rec_apply(w, st, b, d):
            inf = SUB(st, b)[2]
            v = d.f['cl'][4] if b['who'] == 'cl' else d.f['rel'][5]
            if O.mode == 'log':
                O.setsub(d, b['who'], view=v + (inf[2],))
            else:
                O.setsub(d, b['who'], view=fold_one(v, inf[2]))

        acts.append(Action('gotrec', 'deliver', inbox, [take('rec')], [
            Update('apply', rec_apply, role='serve'),
            Update('cursor', apply_cursor, role='cursor'),
            Update('credit', clear_inf, role='seq'),
        ]))

        def leave(w, st, b, d):
            O.setsub(d, b['who'], src=None, link=None)

        acts.append(Action('gotmoved', 'deliver', inbox, [take('moved')], [
            Update('leave', leave, role='answer', note='resubscribe elsewhere with the cursor'),
            Update('credit', clear_inf, role='seq'),
        ]))
        acts.append(Action('gotretry', 'deliver', inbox, [take('retry')], [
            Update('leave', leave, role='answer', note='try again, here or elsewhere, with the cursor'),
            Update('credit', clear_inf, role='seq'),
        ]))

        acts.append(Action('gotend', 'deliver', only('log', inbox), [take('end')], [
            Update('leave', leave, role='answer'),
            Update('credit', clear_inf, role='seq'),
        ]))
        acts.append(Action('gotexp', 'deliver', only('log', inbox), [take('expired')], [
            Update('dead', lambda w, st, b, d: O.setsub(d, b['who'], dead=True) if b['who'] == 'cl' else None,
                   role='answer', note="the reader throws 'expired' to the app"),
            Update('leave', leave, role='answer'),
            Update('credit', clear_inf, role='seq'),
        ]))

        # -------- subscribe, with the cursor
        acts.append(Action('connect', 'deliver', free, [
            Guard('alive', lambda w, st, b: O.src_state(st, b['x'])[0], role='seq'),
        ], [Update('link', lambda w, st, b, d: O.setsub(d, b['who'], src=b['x'], link='req'), role='seq')]))

        # -------- the move: B opens at N with what is carried
        def openp(w, st):
            ph = st[IX['phase']]
            if ph != 'A' and ph[0] == 'F':
                yield {}

        def open_phase(w, st, b, d):
            d.f['phase'] = ('B', st[IX['phase']][1])

        def open_fold(w, st, b, d):
            O.setsrv(d, LB, loaded=True, fold=st[IX['phase']][1], base=st[IX['phase']][1])

        def open_segs(w, st, b, d):
            O.setsrv(d, LB, base=0)
            d.f['segs'] = True

        acts.append(Action('bopen', 'deliver', openp, [], [
            Update('phase', open_phase, role='move'),
            Update('fold', open_fold, role='carry', note="B starts from A's rows at N"),
            Update('segs', open_segs, role='carry',
                   note="... and the names of A's segments below N, so it can serve log readers from before N"),
        ]))

        # -------- the client's own write resolves
        acts.append(Action('resolve', 'deliver', lambda w, st: iter([{}]) if not st[IX['cl']][5] else iter(()), [
            Guard('committed', lambda w, st, b: st[IX['mine']] > 0, role='write'),
            Cmp('seen', lambda w, st, b: st[IX['cl']][3], '>=', lambda w, st, b: st[IX['mine']], role='write',
                note='a write resolves once its writer\'s subscription has passed its position'),
        ], [Update('res', lambda w, st, b, d: O.setsub(d, 'cl', res=True), role='write')]))
        return acts


def fold_one(rows, c):
    op, r = SCRIPT[c - 1]
    return rows | {r} if op == 'set' else rows - {r}


class Fixed(Sub):
    FIXED = True


class Off(Sub):
    OFF = True
    FIXED = True


OPTIONS = {'draft': Sub, 'fixed': Fixed, 'off': Off}
PINNED = {k: ('bopen.phase',) for k in OPTIONS}


def B(mode, **kw):
    d = dict(mode=mode, faults=1, kinds=('crash', 'reload', 'drop'))
    d.update(kw)
    return d


BOUNDS = {
    'fo-state': B('state'),
    'fo-log': B('log'),
    'mv-state': B('state', move=True, kinds=('crash', 'drop')),
    'mv-log': B('log', move=True, kinds=('crash', 'drop')),
    'rl-state': B('state', relay=True, kinds=('crash', 'relay')),
    'rl-log': B('log', relay=True, kinds=('crash', 'relay')),
    'all-state': B('state', move=True, relay=True, faults=2, kinds=('crash', 'reload', 'relay', 'drop')),
    'all-log': B('log', move=True, relay=True, faults=2, kinds=('crash', 'reload', 'relay', 'drop')),
    # verify bounds that finish within the hold: the move and two faults; the move
    # and the relay with one fault (mvrl-state did not finish within a 25-minute hold)
    'fo2-state': B('state', move=True, faults=2, kinds=('crash', 'reload', 'drop')),
    'fo2-log': B('log', move=True, faults=2, kinds=('crash', 'reload', 'drop')),
    'mvrl-state': B('state', move=True, relay=True, kinds=('crash', 'reload', 'relay', 'drop')),
    'mvrl-log': B('log', move=True, relay=True, kinds=('crash', 'reload', 'relay', 'drop')),
}
SWEEP = ('fo-log', 'fo-state', 'mv-log', 'mv-state', 'rl-log', 'rl-state')
VERIFY = ('fo2-state', 'fo2-log', 'mvrl-log')
