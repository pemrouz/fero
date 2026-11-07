"""
pslot: slot moves where groups belong to the PROJECT, not to one resource
(SPACE G `pslot`, candidate MIN-P). A group holds (resource, slot) pairs from
any resources with equal `copies` and durability. A new resource's slots
start inside an existing group, and slot moves split them off under load
(TiKV PD's cross-table region merge and CockroachDB's span-config coalescing
are the precedents SPACE names).

The move protocol is slot's, unchanged (options/slot/model.py, DESIGN-V5 4.2
as revised after the slot-move spike): A commits `exporting`; B commits
`importing` and a bulk copy; A fences at N on B's ready report; once the
fence commits, B takes the final copy with END(N) and the carried state; B
opens. A may cancel before its fence; B may abort after it; A unfences on
B's committed abort.

What pslot changes, and so what this model adds:
  - p and q are partitions of two DIFFERENT resources, P and Q, and both sit
    in slot 0 of their resource: the same slot number, in one shared group.
    A slot is named (resource, slot number).
  - So every entry of the move protocol must say which resource's slot it is
    about. In slot's model a group holds one resource, so the slot number is
    enough. Here each entry's resource is set by its own update (`res`), as
    HARNESS.md asks for every field of an entry. Dropping it leaves the
    resource out: the entry then names "slot 0" of the group, which is what a
    group does if it keeps slot's per-resource code unchanged, and it applies
    to every resource's slot 0 there. The ablation then says which entries
    really need the resource's name.
  - Positions are (resource, slot, sequence). The resource in a position is a
    harness artefact (property P2 compares positions across partitions; in
    fero a position is read within one resource), so it is not a rule.
  - Writes need nothing new: a write names its partition, and so its
    resource.
Left out, as for slot: the slot table in #meta, incarnations and epochs
(unclean recovery). Also left out (reasoned in README.md): the rule that a
group holds only resources with equal `copies` and durability (a placement
guard of the controller, with no property here to break), group creation and
deletion, and resource creation inside a running group.

Entries (name = (A, index of exporting in A's log, B); k = (res, n), where
res is None when the entry does not name its resource):
  ('w', aid, part, (res, n, seq), tok)              a write
  ('exp', k, B)                                     A: exporting
  ('fen', name, k, N)                               A: fenced at N
  ('can', name, k)                                  A: cancelled
  ('unf', name, k, N)                               A: unfenced, reopens at N
  ('imp', name, k)                                  B: importing
  ('cp', name, k, upto, recs, outs, tok, seq, end)  B: a copy (see slot)
  ('open', name, k, N)                              B: opens at N
  ('abort', name, k)                                B: gives the move up
"""

from dsl import Action, Guard, Update, Cmp
from world import Option
from bounds import count

SLOT = {'p': ('P', 0), 'q': ('Q', 0)}      # the same slot number, two resources


def m(ek, key):
    """Does an entry's slot ek name the slot key? An entry with no resource
    names that slot number in every resource of the group."""
    return ek[1] == key[1] and (ek[0] is None or ek[0] == key[0])


def parts_of(ek):
    return tuple(p for p in sorted(SLOT) if m(ek, SLOT[p]))


def held(E, g, s, holder0):
    """Does this sequence of entries leave g holding slot s open?"""
    h = holder0[s] == g
    for e in E:
        k = e[0]
        if k == 'fen' and m(e[2], s):
            h = False
        elif (k == 'open' or k == 'unf') and m(e[2], s):
            h = True
    return h


def top(E, s):
    """The slot's last sequence in these entries."""
    t = 0
    for e in E:
        k = e[0]
        if k == 'w':
            if SLOT[e[2]] == s:
                t = max(t, e[3][2])
        elif k == 'cp':
            if m(e[2], s):
                t = max(t, e[7], e[8])
        elif k in ('fen', 'unf', 'open'):
            if m(e[2], s):
                t = max(t, e[3])
    return t


def outs(E, s):
    o = set()
    for e in E:
        if e[0] == 'w' and SLOT[e[2]] == s:
            o.add(e[1])
        elif e[0] == 'cp' and m(e[2], s):
            o |= e[5]
    return o


def hightok(E, s):
    t = 0
    for e in E:
        if e[0] == 'w' and SLOT[e[2]] == s:
            t = max(t, e[4])
        elif e[0] == 'cp' and m(e[2], s):
            t = max(t, e[6])
    return t


def recs(E, s):
    """The slot's rows with positions: a copy replaces, a write adds."""
    r = ()
    for e in E:
        if e[0] == 'cp' and m(e[2], s):
            r = e[4]
        elif e[0] == 'w' and SLOT[e[2]] == s:
            r = r + ((e[1], e[3]),)
    return r


def exp_at(E, name, s):
    """Is name (A, i, B) the position of exporting(s, to B) in these entries?"""
    i = name[1]
    return i < len(E) and E[i][0] == 'exp' and m(E[i][1], s) and E[i][2] == name[2]


def has(E, kind, name):
    return any(e[0] == kind and e[1] == name for e in E)


def final_cp(E, name):
    return any(e[0] == 'cp' and e[1] == name and e[8] >= 0 for e in E)


class PSlot(Option):
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
        out = []
        for a in range(w.K):
            for i, e in enumerate(w.com(st, a)):
                if e[0] != 'exp':
                    continue
                name = (a, i, e[2])
                if has(w.com(st, a), 'can', name) or has(w.com(st, e[2]), 'abort', name):
                    out.extend((p, a) for p in parts_of(e[1]))
        return out

    def done_all(self, w, st):
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

        def k(d, b):
            """The slot an entry names: its resource only if the res update ran."""
            return (d.e.get('res'), b['s'][1])

        def res(note=''):
            return Update('res', lambda w, st, b, d: d.e.__setitem__('res', b['s'][0]), role='route',
                          note=note or 'the entry names its resource, not only the slot number')

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
            Guard('nofence', lambda w, st, b: not any(e[0] == 'fen' and m(e[2], b['s']) for e in w.tail(st, b['g'])),
                  role='move', note='no write once fenced is in the log, committed or not'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), b['s']), role='dedup'),
            Cmp('fence', lambda w, st, b: w.tok[b['aid']], '>=',
                lambda w, st, b: hightok(w.log(st, b['g']), b['s']), role='fence'),
        ], [
            Update('pos', lambda w, st, b, d: d.e.__setitem__('pos', b['s'] + (top(w.log(st, b['g']), b['s']) + 1,)),
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
        sp = SLOT['p']

        def cands(w, st):
            if st[3] is None:
                return
            for g in range(w.K):
                for i, e in enumerate(w.log(st, g)):
                    if e[0] == 'w' and e[2] == 'p':
                        yield {'g': g, 'i': i, 'aid': e[1], 'pos': e[3]}
                    elif e[0] == 'cp' and m(e[2], sp):
                        for aid, pos in e[4]:
                            yield {'g': g, 'i': i, 'aid': aid, 'pos': pos}

        def nxt(w, st, b):
            cur, pos = st[3][0], b['pos']
            for e in w.com(st, b['g']):
                if e[0] == 'w' and e[2] == 'p' and cur < e[3] < pos:
                    return False
                if e[0] == 'cp' and m(e[2], sp) and any(cur < q < pos for a, q in e[4]):
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
                kk = e[0]
                if kk == 'exp' and m(e[1], s):
                    u = True
                elif kk in ('can', 'unf', 'open') and m(e[2], s):
                    u = None
            return u is not None

        def nextmove(w, st):
            n = sum(1 for g in range(w.K) for e in w.log(st, g) if e[0] == 'exp')
            if n < len(self.moves):
                s, a, b = self.moves[n]
                yield {'s': s, 'g': a, 'dst': b}

        export = Action('export', 'control', nextmove, [
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='move',
                  note='A exports only a slot its committed log holds open'),
            Guard('nofence', lambda w, st, b: not any(e[0] == 'fen' and m(e[2], b['s']) for e in w.tail(st, b['g'])),
                  role='move'),
            Guard('one', lambda w, st, b: not under_way(w.log(st, b['g']), b['s']), role='move',
                  note='one move of a slot at a time'),
        ], [
            res(),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('exp', k(d, b), b['dst'])), role='move'),
        ], label=lambda b: (b['s'], gn(b['g']), '->', gn(b['dst'])))

        # ------------------------------------------------ step 1: B imports, copies
        def exps(w, st):
            for a in range(w.K):
                for i, e in enumerate(w.log(st, a)):
                    if e[0] == 'exp':
                        for p in parts_of(e[1]):
                            yield {'name': (a, i, e[2]), 's': SLOT[p], 'g': e[2], 'i': i}

        imp = Action('import', 'deliver', exps, [
            Guard('expcom', lambda w, st, b: b['i'] < len(w.com(st, b['name'][0])), role='move',
                  note='B acts on a committed exporting'),
            Guard('new', lambda w, st, b: not any(e[1] == b['name'] for e in w.log(st, b['g'])
                                                   if e[0] in ('imp', 'abort')), role='move',
                  note='B refuses a name it has imported or aborted'),
        ], [
            res(),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('imp', b['name'], k(d, b))), role='move'),
        ], label=lambda b: (b['name'], b['s']))

        def imps(w, st):
            for g in range(w.K):
                for i, e in enumerate(w.log(st, g)):
                    if e[0] == 'imp':
                        for p in parts_of(e[2]):
                            yield {'name': e[1], 's': SLOT[p], 'g': g, 'i': i, 'src': e[1][0]}

        copy = Action('copy', 'deliver', imps, [
            Guard('impcom', lambda w, st, b: b['i'] < len(w.com(st, b['g'])), role='perf',
                  note='B commits importing, then copies'),
            Guard('noabort', lambda w, st, b: not has(w.log(st, b['g']), 'abort', b['name']), role='perf'),
            Guard('once', lambda w, st, b: not any(e[0] == 'cp' and e[1] == b['name'] for e in w.log(st, b['g'])),
                  role='idem', note='one bulk copy; the rest comes after the fence'),
        ], [
            res(),
            Update('recs', lambda w, st, b, d: d.e.__setitem__('recs', recs(w.com(st, b['src']), b['s'])),
                   role='perf'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'cp', b['name'], k(d, b), len(w.com(st, b['src'])), d.e.get('recs', ()), frozenset(), 0, 0, -1)),
                role='perf'),
        ], label=lambda b: (b['name'], gn(b['g']), 'from', gn(b['src'])))

        # ------------------------------------------------ step 2: A fences on B's ready
        def a_exps(w, st):
            for g in range(w.K):
                for i, e in enumerate(w.log(st, g)):
                    if e[0] == 'exp':
                        for p in parts_of(e[1]):
                            yield {'name': (g, i, e[2]), 's': SLOT[p], 'g': g, 'dst': e[2]}

        def ready(w, st, b):
            return any(e[0] == 'cp' and e[1] == b['name'] for e in w.com(st, b['dst']))

        fence = Action('fence', 'deliver', a_exps, [
            Guard('ready', ready, role='perf', note='A fences on B\'s report of a committed copy'),
            Guard('expcom', lambda w, st, b: exp_at(w.com(st, b['g']), b['name'], b['s']), role='move',
                  note='A owns the move once exporting commits; a stale name is ignored'),
            Guard('nocancel', lambda w, st, b: not has(w.log(st, b['g']), 'can', b['name']), role='move',
                  note='A never fences once cancel is in its log'),
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['s'], h0), role='move'),
            Guard('nofence', lambda w, st, b: not any(e[0] == 'fen' and m(e[2], b['s']) for e in w.tail(st, b['g'])),
                  role='move'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'fen', b['name']), role='idem'),
        ], [
            res('the fence names the resource: else it fences slot 0 of every resource in the group'),
            Update('N', lambda w, st, b, d: d.e.__setitem__('N', top(w.log(st, b['g']), b['s'])), role='stamp',
                   note='N is the slot\'s last sequence in A\'s log (its end, not its commit)'),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('fen', b['name'], k(d, b), d.e.get('N', 0))),
                   role='move'),
        ], label=lambda b: (b['name'], 'to', gn(b['dst'])))

        # ------------------------------------------------ after the fence commits: delta, END(N), carried state
        def fens(w, st):
            for a in range(w.K):
                for f, e in enumerate(w.log(st, a)):
                    if e[0] == 'fen':
                        for p in parts_of(e[2]):
                            yield {'name': e[1], 's': SLOT[p], 'g': e[1][2], 'src': a, 'f': f, 'N': e[3]}

        final = Action('final', 'deliver', fens, [
            Guard('fencom', lambda w, st, b: b['f'] < len(w.com(st, b['src'])), role='move',
                  note='only once fenced commits does A send the delta and END(N)'),
            Guard('imp', lambda w, st, b: has(w.com(st, b['g']), 'imp', b['name']), role='move',
                  note='B has committed importing'),
            Guard('noabort', lambda w, st, b: not has(w.log(st, b['g']), 'abort', b['name']), role='move'),
            Guard('once', lambda w, st, b: not final_cp(w.log(st, b['g']), b['name']), role='idem'),
        ], [
            res('the final copy names the resource'),
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
                'cp', b['name'], k(d, b), len(w.com(st, b['src'])), d.e.get('recs', ()),
                d.e.get('outs', frozenset()), d.e.get('tok', 0), d.e.get('seq', 0), d.e.get('end', -1))),
                role='move'),
        ], label=lambda b: (b['name'], 'END', b['N']))

        # ------------------------------------------------ step 3: B opens
        def finals(w, st):
            for g in range(w.K):
                for j, e in enumerate(w.log(st, g)):
                    if e[0] == 'cp' and e[8] >= 0:
                        for p in parts_of(e[2]):
                            yield {'name': e[1], 's': SLOT[p], 'g': g, 'j': j, 'N': e[8]}

        opn = Action('open', 'deliver', finals, [
            Guard('cpcom', lambda w, st, b: b['j'] < len(w.com(st, b['g'])), role='move',
                  note='B opens once the delta, END(N) and the carried state commit'),
            Guard('noabort', lambda w, st, b: not has(w.log(st, b['g']), 'abort', b['name']), role='move',
                  note='B never opens once abort is in its log'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'open', b['name']), role='idem'),
        ], [
            res('the open names the resource: else B opens slot 0 of every resource'),
            Update('N', lambda w, st, b, d: d.e.__setitem__('N', b['N']), role='stamp'),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('open', b['name'], k(d, b), d.e.get('N', 0))),
                   role='move'),
        ], label=lambda b: (b['name'], 'at', b['N']))

        # ------------------------------------------------ cancelling
        def own_exps(w, st):
            for g in range(w.K):
                for i, e in enumerate(w.log(st, g)):
                    if e[0] == 'exp':
                        for p in parts_of(e[1]):
                            yield {'name': (g, i, e[2]), 's': SLOT[p], 'g': g}

        cancel = Action('cancel', 'tick', own_exps, [
            Guard('nofence', lambda w, st, b: not has(w.log(st, b['g']), 'fen', b['name']), role='move',
                  note='before its fence, A may cancel on its own'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'can', b['name']), role='idem'),
        ], [
            res(),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('can', b['name'], k(d, b))), role='move'),
        ], label=lambda b: (b['name'],))

        def cans(w, st):
            for a in range(w.K):
                for c, e in enumerate(w.log(st, a)):
                    if e[0] == 'can':
                        for p in parts_of(e[2]):
                            yield {'name': e[1], 's': SLOT[p], 'g': e[1][2], 'src': a, 'c': c}

        drop = Action('drop', 'deliver', cans, [
            Guard('cancom', lambda w, st, b: b['c'] < len(w.com(st, b['src'])), role='move'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'abort', b['name']), role='idem'),
        ], [
            res(),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('abort', b['name'], k(d, b))), role='move'),
        ], label=lambda b: (b['name'],))

        def b_moves(w, st):
            for a in range(w.K):
                for i, e in enumerate(w.log(st, a)):
                    if e[0] == 'exp':
                        for p in parts_of(e[1]):
                            yield {'name': (a, i, e[2]), 's': SLOT[p], 'g': e[2]}

        abort = Action('abort', 'tick', b_moves, [
            Guard('imp', lambda w, st, b: has(w.log(st, b['g']), 'imp', b['name']), role='move',
                  note='B gives up only a move it is importing'),
            Guard('noopen', lambda w, st, b: not has(w.log(st, b['g']), 'open', b['name']), role='move',
                  note='B aborts only while its log has no open'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'abort', b['name']), role='idem'),
        ], [
            res(),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('abort', b['name'], k(d, b))), role='move'),
        ], label=lambda b: (b['name'],))

        def aborts(w, st):
            for dst in range(w.K):
                for j, e in enumerate(w.log(st, dst)):
                    if e[0] == 'abort':
                        for p in parts_of(e[2]):
                            yield {'name': e[1], 's': SLOT[p], 'g': e[1][0], 'dst': dst, 'j': j}

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
            res('the unfence names the resource'),
            Update('N', lambda w, st, b, d: d.e.__setitem__('N', fen_n(w.log(st, b['g']), b['name'])),
                   role='stamp', note='reopen at N'),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('unf', b['name'], k(d, b), d.e.get('N', 0))),
                   role='move'),
        ], label=lambda b: (b['name'],))

        cancel_ab = Action('cancel_on_abort', 'deliver', aborts, [
            Guard('abcom', lambda w, st, b: b['j'] < len(w.com(st, b['dst'])), role='move'),
            Guard('nofen', lambda w, st, b: not has(w.log(st, b['g']), 'fen', b['name']), role='move'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['g']), 'can', b['name']), role='idem'),
        ], [
            res(),
            Update('append', lambda w, st, b, d: d.append(b['g'], ('can', b['name'], k(d, b))), role='move'),
        ], label=lambda b: (b['name'],))

        return [write, refuse, read, export, imp, copy, fence, final, opn, cancel, drop, abort,
                unfence, cancel_ab]


OPTION = PSlot
# The give-up path, as for slot (see options/slot/model.py).
GIVEUP = ('cancel.append', 'abort.append', 'import.append')


def _load_fused():
    """pslot-fused (fused.py): the same option with the move's entries fused
    the way a split fuses them; a probe of the move's shape."""
    import importlib.util
    import os
    import sys
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fused.py')
    spec = importlib.util.spec_from_file_location('opt_pslot_fused', path)
    mod = sys.modules.get(spec.name)
    if mod is None:
        mod = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = mod
        spec.loader.exec_module(mod)
    return mod.PSlotFused


OPTIONS = {'pslot': PSlot, 'pslot-fused': _load_fused()}
