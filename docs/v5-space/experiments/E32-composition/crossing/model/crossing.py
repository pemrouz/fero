"""
crossing.py: the composed model of E-32 (b). One slot move, with a leader
change, a voter change of the source or the target group, a log drop behind
a snapshot, and the dedup state the move carries, in any order.

WHERE EACH PART COMES FROM (COMP's picks, AMENDMENTS section 4).
- The slot move: E-17's options/slot/model.py, ported line for line, with
  one give-up decider (A-17 (4), E-17 part 1's `slot+abort`: only B gives a
  move up; A's own `cancel` and B's `drop` are gone) and every once guard
  (A-17 (1), E-17c). The carried set is A-17 (2)'s, as far as this world has
  it: rows and records, the sequence, dedup outcomes, the session floor,
  the highest lock token, and the `srchi-slot` mark.
- Dedup: E-20's `sess` (D `sess`): a write applies only when it is not
  among the session's outcomes and is at or above the session's floor; the
  floor is the client's lowest unacknowledged id, carried by every copy;
  outcomes below the floor are forgotten (E-20 pins that memory bound, so
  here it sits in the fold, not in a rule); the move carries outcomes and
  floor.
- Derived outputs: E-30's `srchi-slot` (A-05): an output applies only above
  the slot's mark; the mark is written in the output's own entry; the move
  carries it.
- Voter changes: E-16's `self` (C `self`, A-19), its five actions as written
  (add a learner, promote, remove, surplus, drop a gone learner), on E-14's
  membership on commit (A-01) with V `+lrn` and Z `rejoin` (A-28: a member
  back without its disk is a new replica). cworld.py holds Raft itself.
- A log drop behind a snapshot (DESIGN-V5 4.1, "When a replica may drop its
  log below offset i"): the action `snap`. NEW HERE: no single experiment
  modelled it. A group replaces the first k entries of its log by one
  snapshot entry. What the snapshot carries is written one field per update,
  so the ablation can say which fields a snapshot needs: the slots held
  open, each slot's sequence, rows, outcomes, lock token and mark, the
  session floor, the config, and the move facts (which moves this group has
  exported, imported, copied, fenced, cancelled, unfenced, opened, aborted).

HOW THE PORT READS A LOG. E-17's slot model reads raw entries. Here a log
may begin with a snapshot entry:
  ('snap', n, held, seq, recs, outs, floor, tok, mark, cfg, facts)
n is how many entries it replaces. The folds (held, top, outs, hightok,
recs, floor, mark, config) start from its fields. `ents(E)` gives every
entry with its absolute index, and before them every fact the snapshot
carries with the index it had; guards that ask "is this entry in the log"
read ents. A move is still named by the position of its `exporting`: the
absolute index.

Entries (name = (A, absolute index of exporting in A's log, B)):
  ('w', aid, part, (slot, seq), tok, L, src)   a write; L the floor its copy
                                              carried; src its source
                                              sequence if it is a derived
                                              output, else 0
  ('exp', slot, B) ('fen', name, slot, N) ('can', name, slot)
  ('unf', name, slot, N) ('imp', name, slot) ('open', name, slot, N)
  ('abort', name, slot)                       as in E-17's slot model
  ('cp', name, slot, upto, recs, outs, tok, seq, end, floor, mark)
                                              E-17's copy, plus the carried
                                              floor and mark
  ('cfg', voters, learners, newv)             a config change (E-16)
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import cworld                                   # noqa: E402,F401  (puts E-17's harness on the path)
from dsl import Action, Guard, Update, Cmp      # noqa: E402
from world import Option                        # noqa: E402
from bounds import count                        # noqa: E402

SLOT = {'p': 's', 'q': 't'}
PARTS_OF = {'s': ('p',), 't': ('q',)}
SI = {'s': 0, 't': 1}
SLOTS = ('s', 't')
BIG = 1 << 30
E0 = frozenset()
FACT_KINDS = ('exp', 'imp', 'cp', 'fen', 'can', 'unf', 'open', 'abort')


# ------------------------------------------------------------------ log views
def alen(E):
    """The absolute length of a log (a snapshot counts the entries it replaced)."""
    if E and E[0][0] == 'snap':
        return E[0][1] - 1 + len(E)
    return len(E)


def ents(E):
    """(absolute index, entry) for every entry of E; before them, every fact
    its snapshot carries, with the index it had."""
    if E and E[0][0] == 'snap':
        sn = E[0]
        out = sorted(sn[10], key=lambda x: x[0])
        off = sn[1] - 1
        for k in range(1, len(E)):
            out.append((k + off, E[k]))
        return out
    return list(enumerate(E))


def held(E, g, s, holder0):
    """Does this log leave g holding s open?"""
    h = holder0[s] == g
    for e in E:
        k = e[0]
        if k == 'fen':
            if e[2] == s:
                h = False
        elif k == 'open' or k == 'unf':
            if e[2] == s:
                h = True
        elif k == 'snap':
            if e[2] is not None:
                h = s in e[2]
    return h


def top(E, s):
    """The slot's last sequence in this log."""
    t = 0
    for e in E:
        k = e[0]
        if k == 'w':
            if SLOT[e[2]] == s:
                t = max(t, e[3][1])
        elif k == 'cp':
            if e[2] == s:
                t = max(t, e[7], e[8])
        elif k in ('fen', 'unf', 'open'):
            if e[2] == s:
                t = max(t, e[3])
        elif k == 'snap':
            t = max(t, e[3][SI[s]])
    return t


def floor(E):
    """The session's floor in this log: the highest lowest-unacknowledged id
    a copy carried here, or that a move carried in."""
    f = 0
    for e in E:
        k = e[0]
        if k == 'w':
            if e[5] > f:
                f = e[5]
        elif k == 'cp':
            if e[9] > f:
                f = e[9]
        elif k == 'snap':
            if e[6] > f:
                f = e[6]
    return f


def outs(E, s, seq):
    """The dedup outcomes of the slot. With sessions (seq: attempt id ->
    session sequence), outcomes below the floor are forgotten (E-20)."""
    o = set()
    for e in E:
        if e[0] == 'w':
            if SLOT[e[2]] == s:
                o.add(e[1])
        elif e[0] == 'cp':
            if e[2] == s:
                o |= e[5]
        elif e[0] == 'snap':
            o |= e[5][SI[s]]
    if seq and o:
        fl = floor(E)
        if fl:
            o = {a for a in o if seq.get(a, BIG) >= fl}
    return o


def hightok(E, s):
    t = 0
    for e in E:
        if e[0] == 'w':
            if SLOT[e[2]] == s:
                t = max(t, e[4])
        elif e[0] == 'cp':
            if e[2] == s:
                t = max(t, e[6])
        elif e[0] == 'snap':
            t = max(t, e[7][SI[s]])
    return t


def mark(E, s):
    """The slot's `srchi-slot` mark: the highest source sequence applied."""
    m = 0
    for e in E:
        if e[0] == 'w':
            if SLOT[e[2]] == s and e[6] > m:
                m = e[6]
        elif e[0] == 'cp':
            if e[2] == s and e[10] > m:
                m = e[10]
        elif e[0] == 'snap':
            if e[8][SI[s]] > m:
                m = e[8][SI[s]]
    return m


def recs(E, s):
    """The slot's rows with positions: a copy replaces, a write adds."""
    r = ()
    for e in E:
        if e[0] == 'cp':
            if e[2] == s:
                r = e[4]
        elif e[0] == 'w':
            if SLOT[e[2]] == s:
                r = r + ((e[1], e[3]),)
        elif e[0] == 'snap':
            r = e[4][SI[s]]
    return r


def exp_at(F, name, s):
    """Is name (A, i, B) the position of exporting(s, to B) in these entries?"""
    i, want = name[1], ('exp', s, name[2])
    return any(j == i and e == want for j, e in F)


def has(F, kind, name):
    return any(e[0] == kind and e[1] == name for _, e in F)


def final_cp(F, name):
    return any(e[0] == 'cp' and e[1] == name and e[8] >= 0 for _, e in F)


def strip(e):
    """A copy as a fact: its name and its END, without the data (the data is
    in the snapshot's fields)."""
    return ('cp', e[1], e[2], 0, (), E0, 0, 0, e[8], 0, 0)


class Crossing(Option):
    ZERO = ('-', 0)
    KIND = {'snap': 'drop'}          # a log drop is its own kind of step: not calm, not a give-up

    def __init__(self, bound):
        super().__init__(bound)
        lays = bound['layouts']
        self.K = max(count(l) for l in lays)
        self.names = tuple(f'G{i}' for i in range(self.K))
        self.holder0 = {SLOT[p]: g for p, g in lays[0].items()}
        self.moves = []
        for a, b in zip(lays, lays[1:]):
            for p in ('p', 'q'):
                if a[p] != b[p]:
                    self.moves.append((SLOT[p], a[p], b[p]))
        self.giveup = bound.get('giveup', True)
        self.serial = bound.get('serial', False)
        self.dropg = tuple(bound.get('dropg', ()))
        self.voters0 = bound.get('voters')
        self.seq = dict(bound.get('sess', {}))
        self.derived = dict(bound.get('derived', {}))
        self._est = None

    def bind(self, w):
        self.w = w

    # ------------------------------------------------------------ cached views
    def _fill(self, st):
        self._est = st
        el, ec = [], []
        for grp in st[0]:
            com, tail = grp[0], grp[1]
            fc = ents(com)
            ec.append(fc)
            if tail:
                n = alen(com)
                el.append(fc + [(n + k, e) for k, e in enumerate(tail)])
            else:
                el.append(fc)
        self._el, self._ec = el, ec

    def EL(self, st, g):
        """ents of g's whole log."""
        if st is not self._est:
            self._fill(st)
        return self._el[g]

    def EC(self, st, g):
        """ents of g's committed log."""
        if st is not self._est:
            self._fill(st)
        return self._ec[g]

    def config(self, w, E, g):
        """(voters, learners, the voter last promoted) by these entries."""
        if self.voters0 is None:
            return (E0, E0, None)
        c = (frozenset((m, 0) for m in self.voters0[g]), E0, None)
        for e in E:
            if e[0] == 'cfg':
                c = (e[1], e[2], e[3])
            elif e[0] == 'snap':
                if e[9] is not None:
                    c = e[9]
        return c

    # ------------------------------------------------------------ the Option interface
    def cursor0(self):
        return ('s', 0)

    def owners(self, w, st, part):
        s = SLOT[part]
        return [g for g in range(w.K) if held(w.com(st, g), g, s, self.holder0)]

    def rows(self, w, st, g, part):
        return tuple(a for a, pos in recs(w.com(st, g), SLOT[part]))

    def settled(self, w, st):
        if any(grp[1] for grp in st[0]):
            return False
        for a in range(w.K):
            A = self.EC(st, a)
            for i, e in A:
                if e[0] != 'exp':
                    continue
                name = (a, i, e[2])
                B = self.EC(st, e[2])
                if has(B, 'open', name) or has(A, 'unf', name):
                    continue
                if has(A, 'can', name) and (not has(B, 'imp', name) or has(B, 'abort', name)):
                    continue
                return False
        return True

    def given_up(self, w, st):
        out = []
        for a in range(w.K):
            A = self.EC(st, a)
            for i, e in A:
                if e[0] != 'exp':
                    continue
                name = (a, i, e[2])
                if has(A, 'can', name) or has(self.EC(st, e[2]), 'abort', name):
                    out.extend((p, a) for p in PARTS_OF[e[1]])
        return out

    def done_all(self, w, st):
        return sum(1 for g in range(w.K) for _, e in self.EC(st, g) if e[0] == 'open') >= len(self.moves)

    def show(self, e):
        if e[0] == 'cp':
            x = ('cp', e[1], e[2], f'upto={e[3]}', [a for a, p in e[4]],
                 sorted(e[5]), f'tok={e[6]}', f'seq={e[7]}', f'end={e[8]}')
            if e[9] or e[10]:
                x += (f'floor={e[9]}', f'mark={e[10]}')
            return x
        if e[0] == 'cfg':
            return ('cfg', 'voters', sorted(e[1]), 'learners', sorted(e[2]))
        return e

    # ------------------------------------------------------------ the rules
    def actions(self):
        h0, ZERO, N = self.holder0, self.ZERO, self.names
        EL, EC = self.EL, self.EC
        seq, derived = self.seq, self.derived

        def gn(x):
            return N[x]

        # ============================================================ E-17 slot: the client's writes
        def reqs(w, st):
            fl = w.floor_now(st) if seq else 0
            hist_p = None
            for aid in w.aids:
                if aid in derived and derived[aid] > 1:
                    # the consumer handles its source in order: it sends the
                    # output of record k only once k-1's output is applied
                    if hist_p is None:
                        hist_p = {x[0] for h in st[1] for x in h}
                    prev = [a for a in derived if derived[a] == derived[aid] - 1]
                    if not all(a in hist_p for a in prev):
                        continue
                if aid in seq:
                    if self.serial and seq[aid] > fl:
                        continue                             # the client sends one write at a time
                    ls = range(1, min(seq[aid], fl) + 1)     # any floor the client had when it sent a copy
                else:
                    ls = (0,)
                for g in range(w.K):
                    for L in ls:
                        yield {'aid': aid, 'g': g, 's': SLOT[w.part[aid]], 'L': L}

        def lab(b):
            return (b['aid'], gn(b['g'])) + ((f'floor={b["L"]}',) if b['L'] else ())

        write = Action('write', 'deliver', reqs, [
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='route',
                  note='the group holds the slot open by its committed log'),
            Guard('nofence', lambda w, st, b: not any(e[0] == 'fen' and e[2] == b['s'] for e in w.tail(st, b['g'])),
                  role='move', note='no write once fenced is in the log, committed or not'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), b['s'], seq), role='dedup'),
            Cmp('fence', lambda w, st, b: w.tok[b['aid']], '>=',
                lambda w, st, b: hightok(w.log(st, b['g']), b['s']), role='fence'),
            Cmp('above', lambda w, st, b: seq.get(b['aid'], BIG), '>=',
                lambda w, st, b: floor(w.log(st, b['g'])), role='dedup',
                note='E-20 sess: apply only at or above the session\'s floor'),
            Cmp('mark', lambda w, st, b: derived.get(b['aid'], BIG), '>',
                lambda w, st, b: mark(w.log(st, b['g']), b['s']), role='dedup',
                note='E-30 srchi-slot: a derived output applies only above the slot\'s mark'),
        ], [
            Update('pos', lambda w, st, b, d: d.e.__setitem__('pos', (b['s'], top(w.log(st, b['g']), b['s']) + 1)),
                   role='stamp', note='stamp the slot\'s next sequence, from the log end'),
            Update('floor', lambda w, st, b, d: d.e.__setitem__('L', b['L']), role='dedup',
                   note='E-20 sess: the entry records the floor its copy carried'),
            Update('src', lambda w, st, b, d: d.e.__setitem__('src', derived.get(b['aid'], 0)), role='dedup',
                   note='E-30 srchi-slot: the source sequence is written in the output\'s own entry'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'w', b['aid'], w.part[b['aid']], d.e.get('pos', ZERO), w.tok[b['aid']],
                d.e.get('L', 0), d.e.get('src', 0))), role='answer'),
        ], label=lab)

        def reqs1(w, st):
            for aid in w.aids:
                for g in range(w.K):
                    yield {'aid': aid, 'g': g, 's': SLOT[w.part[aid]]}

        refuse = Action('refuse', 'deliver', reqs1, [
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='route'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), b['s'], seq), role='dedup'),
            Cmp('stale', lambda w, st, b: w.tok[b['aid']], '<',
                lambda w, st, b: hightok(w.com(st, b['g']), b['s']), role='fence'),
            Cmp('above', lambda w, st, b: seq.get(b['aid'], BIG), '>=',
                lambda w, st, b: floor(w.log(st, b['g'])), role='dedup',
                note='E-20 sess: a copy below the floor is answered stale, never judged; E-17\'s '
                     'refusal reads the outcomes, and E-20 forgets them below the floor'),
        ], [
            Update('answer', lambda w, st, b, d: d.refuse(b['aid']), role='answer'),
        ], label=lambda b: (b['aid'], gn(b['g'])))

        # ============================================================ E-17 slot: the reader
        def cands(w, st):
            if st[3] is None:
                return
            for g in range(w.K):
                com = w.com(st, g)
                if com and com[0][0] == 'snap':
                    for aid, pos in com[0][4][SI['s']]:
                        yield {'g': g, 'i': -1, 'aid': aid, 'pos': pos}
                for i, e in EL(st, g):
                    if e[0] == 'w' and e[2] == 'p':
                        yield {'g': g, 'i': i, 'aid': e[1], 'pos': e[3]}
                    elif e[0] == 'cp' and e[2] == 's':
                        for aid, pos in e[4]:
                            yield {'g': g, 'i': i, 'aid': aid, 'pos': pos}

        def nxt(w, st, b):
            cur, pos = st[3][0], b['pos']
            for e in w.com(st, b['g']):
                if e[0] == 'w' and e[2] == 'p' and cur < e[3] < pos:
                    return False
                if e[0] == 'cp' and e[2] == 's' and any(cur < q < pos for a, q in e[4]):
                    return False
                if e[0] == 'snap' and any(cur < q < pos for a, q in e[4][SI['s']]):
                    return False
            return True

        read = Action('read', 'read', cands, [
            Guard('committed', lambda w, st, b: b['i'] < alen(w.com(st, b['g'])), role='cursor'),
            Cmp('after', lambda w, st, b: b['pos'], '>', lambda w, st, b: st[3][0], role='cursor'),
            Guard('next', nxt, role='cursor'),
        ], [
            Update('take', lambda w, st, b, d: d.set_seen(st[3][1] + (b['aid'],)), role='cursor'),
            Update('cursor', lambda w, st, b, d: d.set_cursor(b['pos']), role='cursor'),
        ], label=lambda b: (gn(b['g']), b['aid'], b['pos']))

        # ============================================================ E-17 slot: step 0, exporting
        def under_way(F, s):
            u = None
            for _, e in F:
                k = e[0]
                if k == 'exp' and e[1] == s:
                    u = True
                elif k in ('can', 'unf') and e[2] == s:
                    u = None
                elif k == 'open' and e[2] == s:
                    u = None
            return u is not None

        def nextmove(w, st):
            k = sum(1 for g in range(w.K) for _, e in EL(st, g) if e[0] == 'exp')
            if k < len(self.moves):
                s, a, b = self.moves[k]
                yield {'s': s, 'g': a, 'dst': b}

        export = Action('export', 'control', nextmove, [
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='move',
                  note='A exports only a slot its committed log holds open'),
            Guard('nofence', lambda w, st, b: not any(e[0] == 'fen' and e[2] == b['s'] for e in w.tail(st, b['g'])),
                  role='move'),
            Guard('one', lambda w, st, b: not under_way(EL(st, b['g']), b['s']), role='move',
                  note='one move of a slot at a time'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('exp', b['s'], b['dst'])), role='move'),
        ], label=lambda b: (b['s'], gn(b['g']), '->', gn(b['dst'])))

        # ============================================================ step 1: B imports, copies
        def exps(w, st):
            for a in range(w.K):
                for i, e in EL(st, a):
                    if e[0] == 'exp':
                        yield {'name': (a, i, e[2]), 's': e[1], 'g': e[2], 'i': i}

        imp = Action('import', 'deliver', exps, [
            Guard('expcom', lambda w, st, b: b['i'] < alen(w.com(st, b['name'][0])), role='move',
                  note='B acts on a committed exporting'),
            Guard('new', lambda w, st, b: not any(e[1] == b['name'] for _, e in EL(st, b['g'])
                                                   if e[0] in ('imp', 'abort')), role='move',
                  note='B refuses a name it has imported or aborted'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('imp', b['name'], b['s'])), role='move'),
        ], label=lambda b: (b['name'], b['s']))

        def imps(w, st):
            for g in range(w.K):
                for i, e in EL(st, g):
                    if e[0] == 'imp':
                        yield {'name': e[1], 's': e[2], 'g': g, 'i': i, 'src': e[1][0]}

        copy = Action('copy', 'deliver', imps, [
            Guard('impcom', lambda w, st, b: b['i'] < alen(w.com(st, b['g'])), role='perf',
                  note='B commits importing, then copies'),
            Guard('noabort', lambda w, st, b: not has(EL(st, b['g']), 'abort', b['name']), role='perf'),
            Guard('once', lambda w, st, b: not any(e[0] == 'cp' and e[1] == b['name'] for _, e in EL(st, b['g'])),
                  role='idem', note='one bulk copy; the rest comes after the fence'),
        ], [
            Update('recs', lambda w, st, b, d: d.e.__setitem__('recs', recs(w.com(st, b['src']), b['s'])),
                   role='perf'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'cp', b['name'], b['s'], alen(w.com(st, b['src'])), d.e.get('recs', ()), E0, 0, 0, -1, 0, 0)),
                role='perf'),
        ], label=lambda b: (b['name'], gn(b['g']), 'from', gn(b['src'])))

        # ============================================================ step 2: A fences on B's ready
        def a_exps(w, st):
            for g in range(w.K):
                for i, e in EL(st, g):
                    if e[0] == 'exp':
                        yield {'name': (g, i, e[2]), 's': e[1], 'g': g, 'dst': e[2]}

        def ready(w, st, b):
            """B's ready report: B's committed log holds a copy for this move."""
            return any(e[0] == 'cp' and e[1] == b['name'] for _, e in EC(st, b['dst']))

        fence = Action('fence', 'deliver', a_exps, [
            Guard('ready', ready, role='perf',
                  note='A fences on B\'s report of a committed copy'),
            Guard('expcom', lambda w, st, b: exp_at(EC(st, b['g']), b['name'], b['s']), role='move',
                  note='A owns the move once exporting commits; the name is the position of '
                       'that exporting in A\'s committed log, so a stale name is ignored'),
            Guard('nocancel', lambda w, st, b: not has(EL(st, b['g']), 'can', b['name']), role='move',
                  note='A never fences once cancel is in its log'),
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='move'),
            Guard('nofence', lambda w, st, b: not any(e[0] == 'fen' and e[2] == b['s'] for e in w.tail(st, b['g'])),
                  role='move'),
            Guard('once', lambda w, st, b: not has(EL(st, b['g']), 'fen', b['name']), role='idem'),
        ], [
            Update('N', lambda w, st, b, d: d.e.__setitem__('N', top(w.log(st, b['g']), b['s'])), role='stamp',
                   note='N is the slot\'s last sequence in A\'s log (its end, not its commit)'),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('fen', b['name'], b['s'], d.e.get('N', 0))),
                   role='move'),
        ], label=lambda b: (b['name'], 'to', gn(b['dst'])))

        # ============================================================ after the fence commits: END(N), carried state
        def fens(w, st):
            for a in range(w.K):
                for f, e in EL(st, a):
                    if e[0] == 'fen':
                        yield {'name': e[1], 's': e[2], 'g': e[1][2], 'src': a, 'f': f, 'N': e[3]}

        final = Action('final', 'deliver', fens, [
            Guard('fencom', lambda w, st, b: b['f'] < alen(w.com(st, b['src'])), role='move',
                  note='only once fenced commits does A send the delta and END(N)'),
            Guard('imp', lambda w, st, b: has(EC(st, b['g']), 'imp', b['name']), role='move',
                  note='B has committed importing'),
            Guard('noabort', lambda w, st, b: not has(EL(st, b['g']), 'abort', b['name']), role='move'),
            Guard('once', lambda w, st, b: not final_cp(EL(st, b['g']), b['name']), role='idem'),
        ], [
            Update('recs', lambda w, st, b, d: d.e.__setitem__('recs', recs(w.com(st, b['src']), b['s'])),
                   role='carry', note='the rows and records of the slot'),
            Update('outs', lambda w, st, b, d: d.e.__setitem__(
                'outs', frozenset(outs(w.com(st, b['src']), b['s'], seq))),
                role='carry', note='the dedup outcomes tagged with the slot'),
            Update('tok', lambda w, st, b, d: d.e.__setitem__('tok', hightok(w.com(st, b['src']), b['s'])),
                   role='carry', note='the highest lock token'),
            Update('seq', lambda w, st, b, d: d.e.__setitem__('seq', top(w.com(st, b['src']), b['s'])),
                   role='carry', note='the slot\'s sequence'),
            Update('floor', lambda w, st, b, d: d.e.__setitem__('floor', floor(w.com(st, b['src']))),
                   role='carry', note='E-20 sess: the session\'s floor'),
            Update('mark', lambda w, st, b, d: d.e.__setitem__('mark', mark(w.com(st, b['src']), b['s'])),
                   role='carry', note='E-30 srchi-slot: the slot\'s mark'),
            Update('end', lambda w, st, b, d: d.e.__setitem__('end', b['N']), role='move', note='END(N)'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'cp', b['name'], b['s'], alen(w.com(st, b['src'])), d.e.get('recs', ()), d.e.get('outs', E0),
                d.e.get('tok', 0), d.e.get('seq', 0), d.e.get('end', -1), d.e.get('floor', 0),
                d.e.get('mark', 0))), role='move'),
        ], label=lambda b: (b['name'], 'END', b['N']))

        # ============================================================ step 3: B opens
        def finals(w, st):
            for g in range(w.K):
                for j, e in EL(st, g):
                    if e[0] == 'cp' and e[8] >= 0:
                        yield {'name': e[1], 's': e[2], 'g': g, 'j': j, 'N': e[8]}

        opn = Action('open', 'deliver', finals, [
            Guard('cpcom', lambda w, st, b: b['j'] < alen(w.com(st, b['g'])), role='move',
                  note='B opens once the delta, END(N) and the carried state commit'),
            Guard('noabort', lambda w, st, b: not has(EL(st, b['g']), 'abort', b['name']), role='move',
                  note='B never opens once abort is in its log'),
            Guard('once', lambda w, st, b: not has(EL(st, b['g']), 'open', b['name']), role='idem'),
        ], [
            Update('N', lambda w, st, b, d: d.e.__setitem__('N', b['N']), role='stamp'),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('open', b['name'], b['s'], d.e.get('N', 0))),
                   role='move'),
        ], label=lambda b: (b['name'], 'at', b['N']))

        # ============================================================ giving up: one decider, B
        def b_moves(w, st):
            if not self.giveup:
                return
            for a in range(w.K):
                for i, e in EL(st, a):
                    if e[0] == 'exp':
                        yield {'name': (a, i, e[2]), 's': e[1], 'g': e[2]}

        abort = Action('abort', 'tick', b_moves, [
            Guard('imp', lambda w, st, b: has(EL(st, b['g']), 'imp', b['name']), role='move',
                  note='B gives up only a move it is importing'),
            Guard('noopen', lambda w, st, b: not has(EL(st, b['g']), 'open', b['name']), role='move',
                  note='B aborts only while its log has no open'),
            Guard('once', lambda w, st, b: not has(EL(st, b['g']), 'abort', b['name']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('abort', b['name'], b['s'])), role='move'),
        ], label=lambda b: (b['name'],))

        def aborts(w, st):
            for dst in range(w.K):
                for j, e in EL(st, dst):
                    if e[0] == 'abort':
                        yield {'name': e[1], 's': e[2], 'g': e[1][0], 'dst': dst, 'j': j}

        def fen_n(F, name):
            for _, e in F:
                if e[0] == 'fen' and e[1] == name:
                    return e[3]
            return 0

        unfence = Action('unfence', 'deliver', aborts, [
            Guard('abcom', lambda w, st, b: b['j'] < alen(w.com(st, b['dst'])), role='move',
                  note='A reopens only on B\'s committed abort'),
            Guard('fen', lambda w, st, b: has(EL(st, b['g']), 'fen', b['name']), role='move'),
            Guard('once', lambda w, st, b: not has(EL(st, b['g']), 'unf', b['name']), role='idem'),
        ], [
            Update('N', lambda w, st, b, d: d.e.__setitem__('N', fen_n(EL(st, b['g']), b['name'])),
                   role='stamp', note='reopen at N'),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('unf', b['name'], b['s'], d.e.get('N', 0))),
                   role='move'),
        ], label=lambda b: (b['name'],))

        cancel_ab = Action('cancel_on_abort', 'deliver', aborts, [
            Guard('abcom', lambda w, st, b: b['j'] < alen(w.com(st, b['dst'])), role='move'),
            Guard('nofen', lambda w, st, b: not has(EL(st, b['g']), 'fen', b['name']), role='move'),
            Guard('once', lambda w, st, b: not has(EL(st, b['g']), 'can', b['name']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('can', b['name'], b['s'])), role='move'),
        ], label=lambda b: (b['name'],))

        # ------------------------------------------------ E-17's second decider (A's own cancel, and B's
        # clean-up after it). COMP has one decider (A-17 (4)), so these two
        # actions exist only when a bound asks for them: run.sh `base` uses
        # them to compare this port with E-17's slot model count for count.
        def own_exps(w, st):
            for g in range(w.K):
                for i, e in EL(st, g):
                    if e[0] == 'exp':
                        yield {'name': (g, i, e[2]), 's': e[1], 'g': g}

        cancel = Action('cancel', 'tick', own_exps, [
            Guard('nofence', lambda w, st, b: not has(EL(st, b['g']), 'fen', b['name']), role='move',
                  note='before its fence, A may cancel on its own'),
            Guard('once', lambda w, st, b: not has(EL(st, b['g']), 'can', b['name']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('can', b['name'], b['s'])), role='move'),
        ], label=lambda b: (b['name'],))

        def cans(w, st):
            for a in range(w.K):
                for c, e in EL(st, a):
                    if e[0] == 'can':
                        yield {'name': e[1], 's': e[2], 'g': e[1][2], 'src': a, 'c': c}

        drop = Action('drop', 'deliver', cans, [
            Guard('cancom', lambda w, st, b: b['c'] < alen(w.com(st, b['src'])), role='move'),
            Guard('once', lambda w, st, b: not has(EL(st, b['g']), 'abort', b['name']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('abort', b['name'], b['s'])), role='move'),
        ], label=lambda b: (b['name'],))

        # ============================================================ NEW: a log drop behind a snapshot
        def cuts(w, st):
            if st[6][1] >= w.drops:
                return
            for g in self.dropg:
                com, tail = w.com(st, g), w.tail(st, g)
                raw = len(com) - (1 if com and com[0][0] == 'snap' else 0)
                if raw:
                    yield {'g': g, 'k': len(com)}                 # everything committed
                if tail:
                    yield {'g': g, 'k': len(com) + 1}             # one entry above the commit offset

        def pre(w, st, b):
            return w.log(st, b['g'])[:b['k']]

        def copying(w, st, b):
            """A slot move is still copying from this log: an exporting here
            that is not cancelled or unfenced, whose target has not committed
            the final copy."""
            g = b['g']
            F = EL(st, g)
            for i, e in F:
                if e[0] != 'exp':
                    continue
                name = (g, i, e[2])
                if has(F, 'can', name) or has(F, 'unf', name):
                    continue
                if not final_cp(EC(st, e[2]), name):
                    return True
            return False

        def fact(kind):
            def f(w, st, b, d):
                P = ents(pre(w, st, b))
                if kind == 'cp':
                    d.e['f_cp'] = [(i, strip(e)) for i, e in P if e[0] == 'cp']
                else:
                    d.e['f_' + kind] = [(i, e) for i, e in P if e[0] == kind]
            return f

        def cut(w, st, b, d):
            P = pre(w, st, b)
            facts = []
            for k in FACT_KINDS:
                facts.extend(d.e.get('f_' + k, ()))
            snap = ('snap', alen(P), d.e.get('held'), d.e.get('seq', (0, 0)), d.e.get('recs', ((), ())),
                    d.e.get('outs', (E0, E0)), d.e.get('floor', 0), d.e.get('tok', (0, 0)),
                    d.e.get('mark', (0, 0)), d.e.get('cfg'), frozenset(facts))
            d.cut(b['g'], b['k'], snap)

        snap = Action('snap', 'control', cuts, [
            Cmp('com', lambda w, st, b: b['k'], '<=', lambda w, st, b: len(w.com(st, b['g'])), role='snap',
                note='a snapshot is cut at or below the commit offset'),
            Guard('nomove', lambda w, st, b: not copying(w, st, b), role='snap',
                  note='DESIGN-V5 4.1: no slot move is still copying from it'),
        ], [
            Update('held', lambda w, st, b, d: d.e.__setitem__('held', frozenset(
                s for s in SLOTS if held(pre(w, st, b), b['g'], s, h0))), role='snap',
                note='which slots the group holds open'),
            Update('seq', lambda w, st, b, d: d.e.__setitem__('seq', tuple(top(pre(w, st, b), s) for s in SLOTS)),
                   role='snap', note='each slot\'s sequence'),
            Update('recs', lambda w, st, b, d: d.e.__setitem__('recs', tuple(recs(pre(w, st, b), s) for s in SLOTS)),
                   role='snap', note='each slot\'s rows and records'),
            Update('outs', lambda w, st, b, d: d.e.__setitem__('outs', tuple(
                frozenset(outs(pre(w, st, b), s, seq)) for s in SLOTS)), role='snap',
                note='each slot\'s dedup outcomes'),
            Update('floor', lambda w, st, b, d: d.e.__setitem__('floor', floor(pre(w, st, b))), role='snap',
                   note='the session floor'),
            Update('tok', lambda w, st, b, d: d.e.__setitem__('tok', tuple(hightok(pre(w, st, b), s) for s in SLOTS)),
                   role='snap', note='each slot\'s highest lock token'),
            Update('mark', lambda w, st, b, d: d.e.__setitem__('mark', tuple(mark(pre(w, st, b), s) for s in SLOTS)),
                   role='snap', note='each slot\'s srchi-slot mark'),
            Update('cfg', lambda w, st, b, d: d.e.__setitem__('cfg', self.config(w, pre(w, st, b), b['g'])
                                                             if self.voters0 is not None else None),
                   role='snap', note='the group\'s config'),
            Update('f_exp', fact('exp'), role='snap', note='the moves this group exports'),
            Update('f_imp', fact('imp'), role='snap', note='the moves this group imports'),
            Update('f_cp', fact('cp'), role='snap', note='which copies it holds, and their END'),
            Update('f_fen', fact('fen'), role='snap', note='its fences, with N'),
            Update('f_can', fact('can'), role='snap', note='its cancels'),
            Update('f_unf', fact('unf'), role='snap', note='its unfences'),
            Update('f_open', fact('open'), role='snap', note='its opens'),
            Update('f_abort', fact('abort'), role='snap', note='its aborts'),
            Update('cut', cut, role='snap', note='the log below the offset is dropped'),
        ], label=lambda b: (gn(b['g']), f'below {b["k"]}'))

        # ============================================================ E-16 self: each group's leader heals
        def reps(w, st):
            for g in sorted(w.heal):
                for m in range(w.M):
                    yield {'g': g, 'r': w.cur(st, m)}

        def cfg_reps(w, st):
            for g in sorted(w.heal):
                vot, lrn, nn = w.cfg(st, g)
                for r in sorted(vot | lrn):
                    yield {'g': g, 'r': r}

        def g_leader(w, st, b):
            return w.leader_ok(st, b['g'])

        def g_idle(w, st, b):
            return not any(e[0] == 'cfg' for e in w.tail(st, b['g']))

        def vot(w, st, b):
            return w.cfg(st, b['g'])[0]

        def lrn(w, st, b):
            return w.cfg(st, b['g'])[1]

        def newv(w, st, b):
            return w.cfg(st, b['g'])[2]

        def heldby(w, st, b):
            return st[0][b['g']][5]

        def need(w, st, b):
            return any(not w.alive(st, v) for v in vot(w, st, b))

        def vote_count(w, st, b):
            return len(vot(w, st, b))

        def add_upd(w, st, b, d):
            d.append(b['g'], ('cfg', vot(w, st, b), lrn(w, st, b) | {b['r']}, newv(w, st, b)))

        def promote_upd(w, st, b, d):
            d.append(b['g'], ('cfg', vot(w, st, b) | {b['r']}, lrn(w, st, b) - {b['r']}, b['r']))

        def remove_upd(w, st, b, d):
            d.append(b['g'], ('cfg', vot(w, st, b) - {b['r']}, lrn(w, st, b), newv(w, st, b)))

        def dropl_upd(w, st, b, d):
            d.append(b['g'], ('cfg', vot(w, st, b), lrn(w, st, b) - {b['r']}, newv(w, st, b)))

        hl = lambda b: (gn(b['g']), b['r'])     # noqa: E731
        heal = [
            Action('add', 'deliver', reps, [
                Guard('leader', g_leader, role='raft', note='only a working leader proposes'),
                Guard('idle', g_idle, role='raft', note='one change at a time (etcd)'),
                Guard('cand', lambda w, st, b: w.alive(st, b['r']), role='target',
                      note='a live member the leader reaches'),
                Guard('new', lambda w, st, b: b['r'] not in vot(w, st, b) | lrn(w, st, b), role='target',
                      note='this replica is not already in the config (a member back with a new disk is a '
                           'new replica)'),
                Guard('need', need, role='target', note='a voter is gone to the leader'),
            ], [Update('append', add_upd, role='step')], label=hl),
            Action('promote', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('learner', lambda w, st, b: b['r'] in lrn(w, st, b), role='target'),
                Guard('live', lambda w, st, b: w.alive(st, b['r']), role='target'),
                Guard('caught', lambda w, st, b: b['r'] in heldby(w, st, b), role='swap',
                      note='its log reaches the commit offset'),
                Guard('need', need, role='target'),
                Cmp('odd', vote_count, '<', lambda w, st, b: 4, role='target',
                    note='promote only from three voters (to four, for the swap)'),
            ], [Update('append', promote_upd, role='step')], label=hl),
            Action('remove', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('voter', lambda w, st, b: b['r'] in vot(w, st, b), role='target'),
                Guard('gone', lambda w, st, b: not w.alive(st, b['r']), role='target',
                      note='the voter is gone to the leader'),
                Cmp('four', vote_count, '>=', lambda w, st, b: 4, role='swap',
                    note='a swap promotes first, then removes (A-01 rule 5: grow before shrink)'),
                Guard('newok', lambda w, st, b: newv(w, st, b) is None or b['r'] == newv(w, st, b)
                      or newv(w, st, b) in heldby(w, st, b), role='swap',
                      note='the new voter holds the commit offset again'),
            ], [Update('append', remove_upd, role='step')], label=hl),
            Action('surplus', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('voter', lambda w, st, b: b['r'] in vot(w, st, b), role='target'),
                Cmp('four', vote_count, '>=', lambda w, st, b: 4, role='target'),
                Guard('nogone', lambda w, st, b: not need(w, st, b), role='target',
                      note='no voter is gone: the gone one came back'),
                Guard('last', lambda w, st, b: b['r'] == max(vot(w, st, b)), role='target',
                      note='the voter the ring ranks last'),
                Guard('allheld', lambda w, st, b: all(v in heldby(w, st, b) and w.alive(st, v)
                                                      for v in vot(w, st, b) - {b['r']}),
                      role='swap', note='the voters left answer and hold the commit offset'),
            ], [Update('append', remove_upd, role='step')], label=hl),
            Action('dropl', 'deliver', cfg_reps, [
                Guard('leader', g_leader, role='raft'),
                Guard('idle', g_idle, role='raft'),
                Guard('learner', lambda w, st, b: b['r'] in lrn(w, st, b), role='target'),
                Guard('gone', lambda w, st, b: not w.alive(st, b['r']), role='target'),
            ], [Update('append', dropl_upd, role='step')], label=hl),
        ]

        if self.bound.get('two_deciders'):
            return [write, refuse, read, export, imp, copy, fence, final, opn, cancel, drop, abort,
                    unfence, cancel_ab]
        return [write, refuse, read, export, imp, copy, fence, final, opn, abort, unfence, cancel_ab,
                snap] + heal


OPTION = Crossing
# The rules added at the crossing (what no single experiment had): the log
# drop's two guards, what the snapshot carries, and the two carried fields
# that E-20 and E-30 each checked alone.
ADDED = tuple('snap.' + x for x in (
    'com', 'nomove', 'held', 'seq', 'recs', 'outs', 'floor', 'tok', 'mark', 'cfg',
    'f_exp', 'f_imp', 'f_cp', 'f_fen', 'f_can', 'f_unf', 'f_open', 'f_abort', 'cut')) + (
    'write.above', 'write.mark', 'write.floor', 'write.src', 'refuse.above', 'final.floor', 'final.mark')
