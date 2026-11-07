"""
pslot-fused: pslot's move with its entries fused the way a split fuses them
(see options/split/model.py and CockroachDB's split trigger). A probe of the
move's shape, not a candidate of its own.

The drafted move (options/slot, options/pslot) has A commit `exporting` and
then `fenced`, and B commit a final copy and then `open`. Here:
  - A's first entry IS the fence: `fenced(k, to B, N)`, a control step. It is
    the decision and the fence at once; from the moment it is in A's log, A
    takes no write to the slot. The move is named by its position in A's log.
  - Once it commits, B commits ONE entry, the final copy, which carries the
    rows and records, the dedup outcomes, the highest lock token and the
    sequence, AND opens the slot: B holds the slot once that entry commits.
  - No `importing`, no bulk copy, no ready report (part 1 found they serve
    only the unwritable window).
  - The give-up path has one decider, B (as slot+abort): B may abort a move
    while its log has no copy for it, never copies once its abort is in its
    log, and A unfences on B's committed abort, for a move it fenced.
  - The final copy reads A's committed log up to the fence entry: the state
    at the fence, fixed once the fence commits (as a split trigger hands over
    the state at the split).
Everything else (positions, the reader, resource names, the shared group) is
pslot's.

Entries (name = (A, index of the fence in A's log, B); k = (res, n)):
  ('w', aid, part, (res, n, seq), tok)
  ('fen', k, B, N)                                   A: fenced, the decision
  ('cp', name, k, recs, outs, tok, seq)              B: the copy; B opens
  ('abort', name, k)                                 B: gives the move up
  ('unf', name, k)                                   A: unfenced
"""

from dsl import Action, Guard, Update, Cmp
from world import Option
from bounds import count

SLOT = {'p': ('P', 0), 'q': ('Q', 0)}


def m(ek, key):
    return ek[1] == key[1] and (ek[0] is None or ek[0] == key[0])


def parts_of(ek):
    return tuple(p for p in sorted(SLOT) if m(ek, SLOT[p]))


def held(E, g, s, holder0):
    h = holder0[s] == g
    for e in E:
        k = e[0]
        if k == 'fen' and m(e[1], s):
            h = False
        elif (k == 'cp' or k == 'unf') and m(e[2], s):
            h = True
    return h


def top(E, s):
    t = 0
    for e in E:
        if e[0] == 'w' and SLOT[e[2]] == s:
            t = max(t, e[3][2])
        elif e[0] == 'cp' and m(e[2], s):
            t = max(t, e[6])
        elif e[0] == 'fen' and m(e[1], s):
            t = max(t, e[3])
    return t


def outs(E, s):
    o = set()
    for e in E:
        if e[0] == 'w' and SLOT[e[2]] == s:
            o.add(e[1])
        elif e[0] == 'cp' and m(e[2], s):
            o |= e[4]
    return o


def hightok(E, s):
    t = 0
    for e in E:
        if e[0] == 'w' and SLOT[e[2]] == s:
            t = max(t, e[4])
        elif e[0] == 'cp' and m(e[2], s):
            t = max(t, e[5])
    return t


def recs(E, s):
    r = ()
    for e in E:
        if e[0] == 'cp' and m(e[2], s):
            r = e[3]
        elif e[0] == 'w' and SLOT[e[2]] == s:
            r = r + ((e[1], e[3]),)
    return r


def has(E, kind, name):
    return any(e[0] == kind and e[1] == name for e in E)


class PSlotFused(Option):
    ZERO = ('-', 0, 0)

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

    def cursor0(self):
        return SLOT['p'] + (0,)

    def owners(self, w, st, part):
        s = SLOT[part]
        return [g for g in range(w.K) if held(w.com(st, g), g, s, self.holder0)]

    def rows(self, w, st, g, part):
        return tuple(a for a, pos in recs(w.com(st, g), SLOT[part]))

    def settled(self, w, st):
        if any(grp[1] for grp in st[0]):
            return False
        for a in range(w.K):
            for i, e in enumerate(w.com(st, a)):
                if e[0] != 'fen':
                    continue
                name = (a, i, e[2])
                if has(w.com(st, e[2]), 'cp', name) or has(w.com(st, a), 'unf', name):
                    continue
                return False
        return True

    def given_up(self, w, st):
        out = []
        for a in range(w.K):
            for i, e in enumerate(w.com(st, a)):
                if e[0] == 'fen' and has(w.com(st, e[2]), 'abort', (a, i, e[2])):
                    out.extend((p, a) for p in parts_of(e[1]))
        return out

    def done_all(self, w, st):
        return sum(1 for g in range(w.K) for e in w.com(st, g) if e[0] == 'cp') >= len(self.moves)

    def show(self, e):
        if e[0] == 'cp':
            return ('cp', e[1], e[2], [a for a, p in e[3]], sorted(e[4]), f'tok={e[5]}', f'seq={e[6]}')
        return e

    def actions(self):
        h0, ZERO, N = self.holder0, self.ZERO, self.names

        def gn(x):
            return N[x]

        def k(d, b):
            return (d.e.get('res'), b['s'][1])

        def res(note=''):
            return Update('res', lambda w, st, b, d: d.e.__setitem__('res', b['s'][0]), role='route',
                          note=note or 'the entry names its resource, not only the slot number')

        def reqs(w, st):
            for aid in w.aids:
                for g in range(w.K):
                    yield {'aid': aid, 'g': g, 's': SLOT[w.part[aid]]}

        def lab(b):
            return (b['aid'], gn(b['g']))

        write = Action('write', 'deliver', reqs, [
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='route'),
            Guard('nofence', lambda w, st, b: not any(e[0] == 'fen' and m(e[1], b['s']) for e in w.tail(st, b['g'])),
                  role='move', note='no write once fenced is in the log, committed or not'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), b['s']), role='dedup'),
            Cmp('fence', lambda w, st, b: w.tok[b['aid']], '>=',
                lambda w, st, b: hightok(w.log(st, b['g']), b['s']), role='fence'),
        ], [
            Update('pos', lambda w, st, b, d: d.e.__setitem__('pos', b['s'] + (top(w.log(st, b['g']), b['s']) + 1,)),
                   role='stamp'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'w', b['aid'], w.part[b['aid']], d.e.get('pos', ZERO), w.tok[b['aid']])), role='answer'),
        ], label=lab)

        refuse = Action('refuse', 'deliver', reqs, [
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='route'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), b['s']), role='dedup'),
            Cmp('stale', lambda w, st, b: w.tok[b['aid']], '<',
                lambda w, st, b: hightok(w.com(st, b['g']), b['s']), role='fence'),
        ], [
            Update('answer', lambda w, st, b, d: d.refuse(b['aid']), role='answer'),
        ], label=lab)

        sp = SLOT['p']

        def cands(w, st):
            if st[3] is None:
                return
            for g in range(w.K):
                for i, e in enumerate(w.log(st, g)):
                    if e[0] == 'w' and e[2] == 'p':
                        yield {'g': g, 'i': i, 'aid': e[1], 'pos': e[3]}
                    elif e[0] == 'cp' and m(e[2], sp):
                        for aid, pos in e[3]:
                            yield {'g': g, 'i': i, 'aid': aid, 'pos': pos}

        def nxt(w, st, b):
            cur, pos = st[3][0], b['pos']
            for e in w.com(st, b['g']):
                if e[0] == 'w' and e[2] == 'p' and cur < e[3] < pos:
                    return False
                if e[0] == 'cp' and m(e[2], sp) and any(cur < q < pos for a, q in e[3]):
                    return False
            return True

        read = Action('read', 'read', cands, [
            Guard('committed', lambda w, st, b: b['i'] < len(w.com(st, b['g'])), role='cursor'),
            Cmp('after', lambda w, st, b: b['pos'], '>', lambda w, st, b: st[3][0], role='cursor'),
            Guard('next', nxt, role='cursor'),
        ], [
            Update('take', lambda w, st, b, d: d.set_seen(st[3][1] + (b['aid'],)), role='cursor'),
            Update('cursor', lambda w, st, b, d: d.set_cursor(b['pos']), role='cursor'),
        ], label=lambda b: (gn(b['g']), b['aid'], b['pos']))

        # ------------------------------------------------ A fences: the decision and the fence at once
        def nextmove(w, st):
            n = sum(1 for g in range(w.K) for e in w.log(st, g) if e[0] == 'fen')
            if n < len(self.moves):
                s, a, b = self.moves[n]
                yield {'s': s, 'g': a, 'dst': b}

        fence = Action('fence', 'control', nextmove, [
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='move',
                  note='A fences only a slot its committed log holds open'),
            Guard('nofence', lambda w, st, b: not any(e[0] == 'fen' and m(e[1], b['s']) for e in w.tail(st, b['g'])),
                  role='move'),
        ], [
            res('the fence names the resource'),
            Update('N', lambda w, st, b, d: d.e.__setitem__('N', top(w.log(st, b['g']), b['s'])), role='stamp',
                   note='N is the slot\'s last sequence in A\'s log'),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('fen', k(d, b), b['dst'], d.e.get('N', 0))),
                   role='move'),
        ], label=lambda b: (b['s'], gn(b['g']), '->', gn(b['dst'])))

        # ------------------------------------------------ B copies, and the copy opens
        def fens(w, st):
            for a in range(w.K):
                for f, e in enumerate(w.log(st, a)):
                    if e[0] == 'fen':
                        for p in parts_of(e[1]):
                            yield {'name': (a, f, e[2]), 's': SLOT[p], 'g': e[2], 'src': a, 'f': f}

        def at(w, st, b):
            return w.com(st, b['src'])[:b['f']]

        final = Action('final', 'deliver', fens, [
            Guard('fencom', lambda w, st, b: b['f'] < len(w.com(st, b['src'])), role='move',
                  note='B copies only from A\'s committed fence'),
            Guard('noabort', lambda w, st, b: not has(w.log(st, b['g']), 'abort', b['name']), role='decide',
                  note='B never copies once its abort is in its log'),
        ], [
            res('the copy names the resource'),
            Update('recs', lambda w, st, b, d: d.e.__setitem__('recs', recs(at(w, st, b), b['s'])), role='carry'),
            Update('outs', lambda w, st, b, d: d.e.__setitem__('outs', frozenset(outs(at(w, st, b), b['s']))),
                   role='carry'),
            Update('tok', lambda w, st, b, d: d.e.__setitem__('tok', hightok(at(w, st, b), b['s'])), role='carry'),
            Update('seq', lambda w, st, b, d: d.e.__setitem__('seq', top(at(w, st, b), b['s'])), role='carry'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'cp', b['name'], k(d, b), d.e.get('recs', ()), d.e.get('outs', frozenset()),
                d.e.get('tok', 0), d.e.get('seq', 0))), role='move'),
        ], label=lambda b: (b['name'],))

        # ------------------------------------------------ giving up: one decider, B
        def b_moves(w, st):
            for a in range(w.K):
                for f, e in enumerate(w.log(st, a)):
                    if e[0] == 'fen':
                        for p in parts_of(e[1]):
                            yield {'name': (a, f, e[2]), 's': SLOT[p], 'g': e[2]}

        abort = Action('abort', 'tick', b_moves, [
            Guard('nocp', lambda w, st, b: not has(w.log(st, b['g']), 'cp', b['name']), role='decide',
                  note='B gives up only while its log has no copy for the move'),
        ], [
            res(),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('abort', b['name'], k(d, b))), role='decide'),
        ], label=lambda b: (b['name'],))

        def aborts(w, st):
            for dst in range(w.K):
                for j, e in enumerate(w.log(st, dst)):
                    if e[0] == 'abort':
                        for p in parts_of(e[2]):
                            yield {'name': e[1], 's': SLOT[p], 'g': e[1][0], 'dst': dst, 'j': j}

        def fen_at(E, name, s):
            i = name[1]
            return i < len(E) and E[i][0] == 'fen' and m(E[i][1], s) and E[i][2] == name[2]

        unfence = Action('unfence', 'deliver', aborts, [
            Guard('abcom', lambda w, st, b: b['j'] < len(w.com(st, b['dst'])), role='decide',
                  note='A reopens only on B\'s committed abort'),
            Guard('fen', lambda w, st, b: fen_at(w.com(st, b['g']), b['name'], b['s']), role='move',
                  note='... of a move A fenced (the name is A\'s committed fence at that position)'),
        ], [
            res(),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('unf', b['name'], k(d, b))), role='move'),
        ], label=lambda b: (b['name'],))

        return [write, refuse, read, fence, final, abort, unfence]


GIVEUP = ('abort.append',)
