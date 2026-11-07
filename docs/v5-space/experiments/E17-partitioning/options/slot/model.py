"""
slot: fixed slots per resource; groups own slot sets; one move protocol moves
a slot between groups (DESIGN-V5 4.2 "Moving a slot", as revised after the
slot-move spike; V5-UNITS option 4). Each partition sits in one slot for
ever; here p is in slot s and q in slot t.

What is modelled is the protocol's crash-only part: the move's owner
(`exporting`, named by its position in A's log), B's import and bulk copy,
the ready report, A's fence at N (the slot's last sequence in its log), the
delta and END(N) with the carried state after the fence commits, B's open,
A's cancel before the fence, B's abort after it, A's unfence on B's
committed abort, and the "two kinds of rule" (a step that waits reads
committed entries; a guard that forbids reads the whole log).
Left out, because no E-17 fault needs them: the slot table in #meta (routing
is free here: a copy may reach any group), incarnations and epochs (there is
no unclean recovery here). slot_move.py checks those.

Entries (name = (A, index of exporting in A's log, B)):
  ('w', aid, part, (slot, seq), tok)                  a write
  ('exp', slot, B)                                    A: exporting
  ('fen', name, slot, N)                              A: fenced at N
  ('can', name, slot)                                 A: cancelled
  ('unf', name, slot, N)                              A: unfenced, reopens at N
  ('imp', name, slot)                                 B: importing
  ('cp', name, slot, upto, recs, outs, tok, seq, end) B: a copy of the slot
        from A's committed log up to index `upto`. recs = ((aid, pos), ...),
        the slot's rows and records (DESIGN-V5: its rows and the segment
        names of its records); outs = the dedup outcomes; tok = the highest
        lock token; seq = the slot's last sequence; end = N on the copy made
        after the fence (END(N)), else -1.
  ('open', name, slot, N)                             B: opens at N
  ('abort', name, slot)                               B: gives the move up
A position is (slot, seq). The reader's cursor is the last position taken.
"""

from dsl import Action, Guard, Update, Cmp
from world import Option
from bounds import count

SLOT = {'p': 's', 'q': 't'}
PARTS_OF = {'s': ('p',), 't': ('q',)}


def held(E, g, s, holder0):
    """Does this sequence of entries leave g holding s open?"""
    h = holder0[s] == g
    for e in E:
        k = e[0]
        if k == 'fen' and e[2] == s:
            h = False
        elif (k == 'open' or k == 'unf') and e[2] == s:
            h = True
    return h


def top(E, s):
    """The slot's last sequence in these entries."""
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
    return t


def outs(E, s):
    o = set()
    for e in E:
        if e[0] == 'w' and SLOT[e[2]] == s:
            o.add(e[1])
        elif e[0] == 'cp' and e[2] == s:
            o |= e[5]
    return o


def hightok(E, s):
    t = 0
    for e in E:
        if e[0] == 'w' and SLOT[e[2]] == s:
            t = max(t, e[4])
        elif e[0] == 'cp' and e[2] == s:
            t = max(t, e[6])
    return t


def recs(E, s):
    """The slot's rows with positions: a copy replaces, a write adds."""
    r = ()
    for e in E:
        if e[0] == 'cp' and e[2] == s:
            r = e[4]
        elif e[0] == 'w' and SLOT[e[2]] == s:
            r = r + ((e[1], e[3]),)
    return r


def exp_at(E, name, s):
    """Is name (A, i, B) the position of exporting(s, to B) in these entries?"""
    i = name[1]
    return i < len(E) and E[i] == ('exp', s, name[2])


def has(E, kind, name):
    return any(e[0] == kind and e[1] == name for e in E)


def final_cp(E, name):
    return any(e[0] == 'cp' and e[1] == name and e[8] >= 0 for e in E)


class Slot(Option):
    ZERO = ('-', 0)

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
            for i, e in enumerate(w.com(st, a)):
                if e[0] != 'exp':
                    continue
                name = (a, i, e[2])
                B = w.com(st, e[2])
                if has(B, 'open', name) or has(w.com(st, a), 'unf', name):
                    continue
                if has(w.com(st, a), 'can', name) and (not has(B, 'imp', name) or has(B, 'abort', name)):
                    continue
                return False
        return True

    def given_up(self, w, st):
        """A move given up (cancel committed at A, or abort committed at B)
        must leave its slot open at A, the source."""
        out = []
        for a in range(w.K):
            for i, e in enumerate(w.com(st, a)):
                if e[0] != 'exp':
                    continue
                name = (a, i, e[2])
                if has(w.com(st, a), 'can', name) or has(w.com(st, e[2]), 'abort', name):
                    out.extend((p, a) for p in PARTS_OF[e[1]])
        return out

    def done_all(self, w, st):
        """Every planned move has opened at its target (each completed move
        commits exactly one open)."""
        return sum(1 for g in range(w.K) for e in w.com(st, g) if e[0] == 'open') >= len(self.moves)

    def show(self, e):
        if e[0] == 'cp':
            return ('cp', e[1], e[2], f'upto={e[3]}', [a for a, p in e[4]],
                    sorted(e[5]), f'tok={e[6]}', f'seq={e[7]}', f'end={e[8]}')
        return e

    def actions(self):
        h0, ZERO, N = self.holder0, self.ZERO, self.names

        def gn(x):
            return N[x]

        # ------------------------------------------------ the client's writes
        def reqs(w, st):
            for aid in w.aids:
                for g in range(w.K):
                    yield {'aid': aid, 'g': g, 's': SLOT[w.part[aid]]}

        def lab(b):
            return (b['aid'], gn(b['g']))

        write = Action('write', 'deliver', reqs, [
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='route',
                  note='the group holds the slot open by its committed log'),
            Guard('nofence', lambda w, st, b: not any(e[0] == 'fen' and e[2] == b['s'] for e in w.tail(st, b['g'])),
                  role='move', note='no write once fenced is in the log, committed or not'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), b['s']), role='dedup'),
            Cmp('fence', lambda w, st, b: w.tok[b['aid']], '>=',
                lambda w, st, b: hightok(w.log(st, b['g']), b['s']), role='fence'),
        ], [
            Update('pos', lambda w, st, b, d: d.e.__setitem__('pos', (b['s'], top(w.log(st, b['g']), b['s']) + 1)),
                   role='stamp', note='stamp the slot\'s next sequence, from the log end'),
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

        # ------------------------------------------------ the reader
        def cands(w, st):
            if st[3] is None:
                return
            for g in range(w.K):
                for i, e in enumerate(w.log(st, g)):
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
            return True

        read = Action('read', 'read', cands, [
            Guard('committed', lambda w, st, b: b['i'] < len(w.com(st, b['g'])), role='cursor'),
            Cmp('after', lambda w, st, b: b['pos'], '>', lambda w, st, b: st[3][0], role='cursor'),
            Guard('next', nxt, role='cursor'),
        ], [
            Update('take', lambda w, st, b, d: d.set_seen(st[3][1] + (b['aid'],)), role='cursor'),
            Update('cursor', lambda w, st, b, d: d.set_cursor(b['pos']), role='cursor'),
        ], label=lambda b: (gn(b['g']), b['aid'], b['pos']))

        # ------------------------------------------------ step 0: exporting
        def under_way(E, s):
            u = None
            for e in E:
                k = e[0]
                if k == 'exp' and e[1] == s:
                    u = True
                elif k in ('can', 'unf') and e[2] == s:
                    u = None
                elif k == 'open' and e[2] == s:
                    u = None
            return u is not None

        def nextmove(w, st):
            k = sum(1 for g in range(w.K) for e in w.log(st, g) if e[0] == 'exp')
            if k < len(self.moves):
                s, a, b = self.moves[k]
                yield {'s': s, 'g': a, 'dst': b}

        export = Action('export', 'control', nextmove, [
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='move',
                  note='A exports only a slot its committed log holds open'),
            Guard('nofence', lambda w, st, b: not any(e[0] == 'fen' and e[2] == b['s'] for e in w.tail(st, b['g'])),
                  role='move'),
            Guard('one', lambda w, st, b: not under_way(w.log(st, b['g']), b['s']), role='move',
                  note='one move of a slot at a time'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('exp', b['s'], b['dst'])), role='move'),
        ], label=lambda b: (b['s'], gn(b['g']), '->', gn(b['dst'])))

        # ------------------------------------------------ step 1: B imports, copies
        def exps(w, st):
            for a in range(w.K):
                for i, e in enumerate(w.log(st, a)):
                    if e[0] == 'exp':
                        yield {'name': (a, i, e[2]), 's': e[1], 'g': e[2], 'i': i}

        imp = Action('import', 'deliver', exps, [
            Guard('expcom', lambda w, st, b: b['i'] < len(w.com(st, b['name'][0])), role='move',
                  note='B acts on a committed exporting'),
            Guard('new', lambda w, st, b: not any(e[1] == b['name'] for e in w.log(st, b['g'])
                                                   if e[0] in ('imp', 'abort')), role='move',
                  note='B refuses a name it has imported or aborted'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('imp', b['name'], b['s'])), role='move'),
        ], label=lambda b: (b['name'], b['s']))

        def imps(w, st):
            for g in range(w.K):
                for i, e in enumerate(w.log(st, g)):
                    if e[0] == 'imp':
                        yield {'name': e[1], 's': e[2], 'g': g, 'i': i, 'src': e[1][0]}

        copy = Action('copy', 'deliver', imps, [
            Guard('impcom', lambda w, st, b: b['i'] < len(w.com(st, b['g'])), role='perf',
                  note='B commits importing, then copies'),
            Guard('noabort', lambda w, st, b: not has(w.log(st, b['g']), 'abort', b['name']), role='perf'),
            Guard('once', lambda w, st, b: not any(e[0] == 'cp' and e[1] == b['name'] for e in w.log(st, b['g'])),
                  role='idem', note='one bulk copy; the rest comes after the fence'),
        ], [
            Update('recs', lambda w, st, b, d: d.e.__setitem__('recs', recs(w.com(st, b['src']), b['s'])),
                   role='perf'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'cp', b['name'], b['s'], len(w.com(st, b['src'])), d.e.get('recs', ()), frozenset(), 0, 0, -1)),
                role='perf'),
        ], label=lambda b: (b['name'], gn(b['g']), 'from', gn(b['src'])))

        # ------------------------------------------------ step 2: A fences on B's ready
        def a_exps(w, st):
            for g in range(w.K):
                for i, e in enumerate(w.log(st, g)):
                    if e[0] == 'exp':
                        yield {'name': (g, i, e[2]), 's': e[1], 'g': g, 'dst': e[2]}

        def ready(w, st, b):
            """B's ready report: B's committed log holds a copy for this move."""
            return any(e[0] == 'cp' and e[1] == b['name'] for e in w.com(st, b['dst']))

        fence = Action('fence', 'deliver', a_exps, [
            Guard('ready', ready, role='perf',
                  note='A fences on B\'s report of a committed copy'),
            Guard('expcom', lambda w, st, b: exp_at(w.com(st, b['g']), b['name'], b['s']), role='move',
                  note='A owns the move once exporting commits; the name is the position of '
                       'that exporting in A\'s committed log, so a stale name is ignored'),
            Guard('nocancel', lambda w, st, b: not has(w.log(st, b['g']), 'can', b['name']), role='move',
                  note='A never fences once cancel is in its log'),
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='move'),
            Guard('nofence', lambda w, st, b: not any(e[0] == 'fen' and e[2] == b['s'] for e in w.tail(st, b['g'])),
                  role='move'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'fen', b['name']), role='idem'),
        ], [
            Update('N', lambda w, st, b, d: d.e.__setitem__('N', top(w.log(st, b['g']), b['s'])), role='stamp',
                   note='N is the slot\'s last sequence in A\'s log (its end, not its commit)'),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('fen', b['name'], b['s'], d.e.get('N', 0))),
                   role='move'),
        ], label=lambda b: (b['name'], 'to', gn(b['dst'])))

        # ------------------------------------------------ after the fence commits: delta, END(N), carried state
        def fens(w, st):
            for a in range(w.K):
                for f, e in enumerate(w.log(st, a)):
                    if e[0] == 'fen':
                        yield {'name': e[1], 's': e[2], 'g': e[1][2], 'src': a, 'f': f, 'N': e[3]}

        final = Action('final', 'deliver', fens, [
            Guard('fencom', lambda w, st, b: b['f'] < len(w.com(st, b['src'])), role='move',
                  note='only once fenced commits does A send the delta and END(N)'),
            Guard('imp', lambda w, st, b: has(w.com(st, b['g']), 'imp', b['name']), role='move',
                  note='B has committed importing'),
            Guard('noabort', lambda w, st, b: not has(w.log(st, b['g']), 'abort', b['name']), role='move'),
            Guard('once', lambda w, st, b: not final_cp(w.log(st, b['g']), b['name']), role='idem'),
        ], [
            Update('recs', lambda w, st, b, d: d.e.__setitem__('recs', recs(w.com(st, b['src']), b['s'])),
                   role='carry', note='the rows and records of the slot'),
            Update('outs', lambda w, st, b, d: d.e.__setitem__('outs', frozenset(outs(w.com(st, b['src']), b['s']))),
                   role='carry', note='the dedup outcomes tagged with the slot'),
            Update('tok', lambda w, st, b, d: d.e.__setitem__('tok', hightok(w.com(st, b['src']), b['s'])),
                   role='carry', note='the highest lock token'),
            Update('seq', lambda w, st, b, d: d.e.__setitem__('seq', top(w.com(st, b['src']), b['s'])),
                   role='carry', note='the slot\'s sequence'),
            Update('end', lambda w, st, b, d: d.e.__setitem__('end', b['N']), role='move', note='END(N)'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'cp', b['name'], b['s'], len(w.com(st, b['src'])), d.e.get('recs', ()), d.e.get('outs', frozenset()),
                d.e.get('tok', 0), d.e.get('seq', 0), d.e.get('end', -1))), role='move'),
        ], label=lambda b: (b['name'], 'END', b['N']))

        # ------------------------------------------------ step 3: B opens
        def finals(w, st):
            for g in range(w.K):
                for j, e in enumerate(w.log(st, g)):
                    if e[0] == 'cp' and e[8] >= 0:
                        yield {'name': e[1], 's': e[2], 'g': g, 'j': j, 'N': e[8]}

        opn = Action('open', 'deliver', finals, [
            Guard('cpcom', lambda w, st, b: b['j'] < len(w.com(st, b['g'])), role='move',
                  note='B opens once the delta, END(N) and the carried state commit'),
            Guard('noabort', lambda w, st, b: not has(w.log(st, b['g']), 'abort', b['name']), role='move',
                  note='B never opens once abort is in its log'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'open', b['name']), role='idem'),
        ], [
            Update('N', lambda w, st, b, d: d.e.__setitem__('N', b['N']), role='stamp'),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('open', b['name'], b['s'], d.e.get('N', 0))),
                   role='move'),
        ], label=lambda b: (b['name'], 'at', b['N']))

        # ------------------------------------------------ cancelling
        def own_exps(w, st):
            for g in range(w.K):
                for i, e in enumerate(w.log(st, g)):
                    if e[0] == 'exp':
                        yield {'name': (g, i, e[2]), 's': e[1], 'g': g}

        cancel = Action('cancel', 'tick', own_exps, [
            Guard('nofence', lambda w, st, b: not has(w.log(st, b['g']), 'fen', b['name']), role='move',
                  note='before its fence, A may cancel on its own'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'can', b['name']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('can', b['name'], b['s'])), role='move'),
        ], label=lambda b: (b['name'],))

        def cans(w, st):
            for a in range(w.K):
                for c, e in enumerate(w.log(st, a)):
                    if e[0] == 'can':
                        yield {'name': e[1], 's': e[2], 'g': e[1][2], 'src': a, 'c': c}

        drop = Action('drop', 'deliver', cans, [
            Guard('cancom', lambda w, st, b: b['c'] < len(w.com(st, b['src'])), role='move'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'abort', b['name']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('abort', b['name'], b['s'])), role='move'),
        ], label=lambda b: (b['name'],))

        def b_moves(w, st):
            for a in range(w.K):
                for i, e in enumerate(w.log(st, a)):
                    if e[0] == 'exp':
                        yield {'name': (a, i, e[2]), 's': e[1], 'g': e[2]}

        abort = Action('abort', 'tick', b_moves, [
            Guard('imp', lambda w, st, b: has(w.log(st, b['g']), 'imp', b['name']), role='move',
                  note='B gives up only a move it is importing'),
            Guard('noopen', lambda w, st, b: not has(w.log(st, b['g']), 'open', b['name']), role='move',
                  note='B aborts only while its log has no open'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'abort', b['name']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('abort', b['name'], b['s'])), role='move'),
        ], label=lambda b: (b['name'],))

        def aborts(w, st):
            for dst in range(w.K):
                for j, e in enumerate(w.log(st, dst)):
                    if e[0] == 'abort':
                        yield {'name': e[1], 's': e[2], 'g': e[1][0], 'dst': dst, 'j': j}

        def fen_n(E, name):
            for e in E:
                if e[0] == 'fen' and e[1] == name:
                    return e[3]
            return 0

        unfence = Action('unfence', 'deliver', aborts, [
            Guard('abcom', lambda w, st, b: b['j'] < len(w.com(st, b['dst'])), role='move',
                  note='A reopens only on B\'s committed abort'),
            Guard('fen', lambda w, st, b: has(w.log(st, b['g']), 'fen', b['name']), role='move'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'unf', b['name']), role='idem'),
        ], [
            Update('N', lambda w, st, b, d: d.e.__setitem__('N', fen_n(w.log(st, b['g']), b['name'])),
                   role='stamp', note='reopen at N'),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('unf', b['name'], b['s'], d.e.get('N', 0))),
                   role='move'),
        ], label=lambda b: (b['name'],))

        cancel_ab = Action('cancel_on_abort', 'deliver', aborts, [
            Guard('abcom', lambda w, st, b: b['j'] < len(w.com(st, b['dst'])), role='move'),
            Guard('nofen', lambda w, st, b: not has(w.log(st, b['g']), 'fen', b['name']), role='move'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'can', b['name']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('can', b['name'], b['s'])), role='move'),
        ], label=lambda b: (b['name'],))

        return [write, refuse, read, export, imp, copy, fence, final, opn, cancel, drop, abort,
                unfence, cancel_ab]


OPTION = Slot
# The give-up path: the free choices to give a move up, and B's record of the
# import it may later abort (without it, the ablation can make abort dead: B
# never imports, so it never aborts). Pinned (never dropped) in the '+giveup'
# ablation, which finds what a working give-up path costs.
GIVEUP = ('cancel.append', 'abort.append', 'import.append')
