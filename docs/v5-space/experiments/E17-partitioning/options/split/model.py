"""
split: groups that split under load and merge back when load falls
(SPACE P `split`, candidate SPLIT, DESIGN-V5 decision 20a). The shape is
CockroachDB's: https://www.cockroachlabs.com/docs/stable/architecture/distribution-layer
(range splits and merges) and its design notes (the split trigger creates
the right-hand range from the parent's state; a merge freezes the right-hand
range with a Subsume request and the merge trigger on the left-hand range
takes its state).

Grow is a SPLIT: the group A that holds p commits one split entry. That
entry is the decision and the fence at once: from the moment it is in A's
log, A takes no write to p. Once it commits, the new group B starts with an
`init` entry that holds p's state at the split (in CockroachDB the right-hand
side is created on the same replicas, so nothing crosses the network; here B
reads A's committed log, which is the same state). B serves p once its init
commits. A split cannot be given up: it is one entry, and before it commits
a crash simply loses it.

Shrink is a MERGE: the group B taking p back (the left-hand side) commits
`merging`; the group A that holds p (the right-hand side) then commits
`subsumed` and from that moment takes no write to p; once that commits, B
commits `merged` with p's state and serves p. B alone may give the merge up
(`merge-abort`, a timer, before `merged`), and A then unfreezes on B's
committed abort: one decider, as in CockroachDB, where the merge transaction
decides and the frozen right-hand side waits for its outcome.

Positions: SPACE O `off+lin`, an offset per group plus lineage. A position is
(generation, group, log index). The generation is CockroachDB's range
descriptor generation: a split gives both sides the parent's generation + 1,
a merge gives the merged group max(both) + 1. It is what keeps a partition's
positions rising when it comes back to a group with lower offsets.
Records do NOT move: they stay in the log of the group that wrote them. A
reader follows the lineage: B's `init` (and `merged`) entry names the last
position of p in the group it came from (the base), and a reader takes a
record that follows such an entry only once its cursor has reached that
base. The old group's log is kept for readers (lineage, kept forever).

Entries (a split is named (A, index of spl in A's log, B); a merge is named
(B, index of mrg in B's log, A)):
  ('w', aid, part, (gen, g, index), tok)                a write
  ('spl', part, B, gen)           A: p splits off to B; gen = the new
                                  generation of both sides
  ('init', name, part, rows, outs, tok, base, gen)       B: starts holding p
  ('mrg', part, A)                B: starts merging A's p in
  ('sub', name, part)             A: subsumed (frozen) for the merge
  ('mgd', name, part, rows, outs, tok, base, gen)        B: merged: holds p
  ('mab', name, part)             B: gives the merge up
  ('uns', name, part)             A: unfrozen after B's committed abort
rows = (aid, ...); outs = the dedup outcomes; tok = the highest lock token;
base = p's last position in A at the split (freeze). B takes all of these
from A's committed log up to the split (subsumed) entry: the state the
trigger hands over, fixed once that entry commits.
"""

from dsl import Action, Guard, Update, Cmp
from world import Option
from bounds import count

ZERO = (-1, -1, -1)


def held(E, g, part, holder0):
    h = holder0[part] == g
    for e in E:
        k = e[0]
        if k == 'spl' and e[1] == part:
            h = False
        elif k in ('init', 'mgd', 'uns') and e[2] == part:
            h = True
        elif k == 'sub' and e[2] == part:
            h = False
    return h


def gen_of(E):
    g = 0
    for e in E:
        if e[0] == 'spl':
            g = max(g, e[3])
        elif e[0] in ('init', 'mgd'):
            g = max(g, e[7])
    return g


def lastpos(E, part):
    """p's last position in these entries: its last write, or the base it
    came with."""
    t = ZERO
    for e in E:
        if e[0] == 'w' and e[2] == part:
            t = max(t, e[3])
        elif e[0] in ('init', 'mgd') and e[2] == part:
            t = max(t, e[6])
    return t


def rows_of(E, part):
    r = ()
    for e in E:
        if e[0] in ('init', 'mgd') and e[2] == part:
            r = e[3]
        elif e[0] == 'w' and e[2] == part:
            r = r + (e[1],)
    return r


def outs(E, part):
    o = set()
    for e in E:
        if e[0] == 'w' and e[2] == part:
            o.add(e[1])
        elif e[0] in ('init', 'mgd') and e[2] == part:
            o |= e[4]
    return o


def hightok(E, part):
    t = 0
    for e in E:
        if e[0] == 'w' and e[2] == part:
            t = max(t, e[4])
        elif e[0] in ('init', 'mgd') and e[2] == part:
            t = max(t, e[5])
    return t


def has(E, kind, name):
    return any(e[0] == kind and e[1] == name for e in E)


def base_before(E, i, part):
    """The lineage base of a record at index i: the base of the latest init
    or merged entry for the partition before it (ZERO if none)."""
    b = ZERO
    for e in E[:i]:
        if e[0] in ('init', 'mgd') and e[2] == part:
            b = e[6]
    return b


class Split(Option):
    ZERO = ZERO

    def __init__(self, bound):
        super().__init__(bound)
        lays = bound['layouts']
        self.K = max(count(l) for l in lays)
        self.names = tuple(f'G{i}' for i in range(self.K))
        self.holder0 = dict(lays[0])
        self.changes = []
        for a, b in zip(lays, lays[1:]):
            for p in ('p', 'q'):
                if a[p] != b[p]:
                    # a new group to the right is a split; back to the left, a merge
                    self.changes.append(('split' if b[p] > a[p] else 'merge', p, a[p], b[p]))

    def cursor0(self):
        return ZERO

    def owners(self, w, st, part):
        return [g for g in range(w.K) if held(w.com(st, g), g, part, self.holder0)]

    def rows(self, w, st, g, part):
        return rows_of(w.com(st, g), part)

    def settled(self, w, st):
        if any(grp[1] for grp in st[0]):
            return False
        for a in range(w.K):
            for i, e in enumerate(w.com(st, a)):
                if e[0] == 'spl':
                    if not has(w.com(st, e[2]), 'init', (a, i, e[2])):
                        return False
                elif e[0] == 'mrg':
                    name, A = (a, i, e[2]), e[2]
                    B = w.com(st, a)
                    if has(B, 'mgd', name):
                        continue
                    if has(B, 'mab', name) and (not has(w.com(st, A), 'sub', name) or has(w.com(st, A), 'uns', name)):
                        continue
                    return False
        return True

    def given_up(self, w, st):
        out = []
        for b in range(w.K):
            for i, e in enumerate(w.com(st, b)):
                if e[0] == 'mrg' and has(w.com(st, b), 'mab', (b, i, e[2])):
                    out.append((e[1], e[2]))
        return out

    def done_all(self, w, st):
        n = sum(1 for g in range(w.K) for e in w.com(st, g) if e[0] in ('init', 'mgd'))
        return n >= len(self.changes)

    def show(self, e):
        if e[0] in ('init', 'mgd'):
            return (e[0], e[1], e[2], list(e[3]), sorted(e[4]), f'tok={e[5]}', f'base={e[6]}', f'gen={e[7]}')
        return e

    def actions(self):
        h0, NM = self.holder0, self.names

        def gn(x):
            return NM[x]

        # ------------------------------------------------ the client's writes
        def reqs(w, st):
            for aid in w.aids:
                for g in range(w.K):
                    yield {'aid': aid, 'g': g, 'part': w.part[aid]}

        def lab(b):
            return (b['aid'], gn(b['g']))

        write = Action('write', 'deliver', reqs, [
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['part'], h0), role='route',
                  note='the group holds the partition by its committed log'),
            Guard('nosplit', lambda w, st, b: not any(e[0] == 'spl' and e[1] == b['part'] for e in w.tail(st, b['g'])),
                  role='move', note='no write once a split of the partition is in the log'),
            Guard('nosub', lambda w, st, b: not any(e[0] == 'sub' and e[2] == b['part'] for e in w.tail(st, b['g'])),
                  role='move', note='no write once subsumed is in the log'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), b['part']), role='dedup'),
            Cmp('fence', lambda w, st, b: w.tok[b['aid']], '>=',
                lambda w, st, b: hightok(w.log(st, b['g']), b['part']), role='fence'),
        ], [
            Update('pos', lambda w, st, b, d: d.e.__setitem__('pos', (gen_of(w.log(st, b['g'])), b['g'],
                                                                      len(w.log(st, b['g'])))),
                   role='stamp', note='(generation, group, log index)'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'w', b['aid'], b['part'], d.e.get('pos', ZERO), w.tok[b['aid']])), role='answer'),
        ], label=lab)

        refuse = Action('refuse', 'deliver', reqs, [
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['part'], h0), role='route'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), b['part']), role='dedup'),
            Cmp('stale', lambda w, st, b: w.tok[b['aid']], '<',
                lambda w, st, b: hightok(w.com(st, b['g']), b['part']), role='fence'),
        ], [
            Update('answer', lambda w, st, b, d: d.refuse(b['aid']), role='answer'),
        ], label=lab)

        # ------------------------------------------------ the reader: offsets plus lineage
        def cands(w, st):
            if st[3] is None:
                return
            for g in range(w.K):
                for i, e in enumerate(w.log(st, g)):
                    if e[0] == 'w' and e[2] == 'p':
                        yield {'g': g, 'i': i, 'aid': e[1], 'pos': e[3]}

        def nxt(w, st, b):
            cur, pos = st[3][0], b['pos']
            return not any(e[0] == 'w' and e[2] == 'p' and cur < e[3] < pos for e in w.com(st, b['g']))

        read = Action('read', 'read', cands, [
            Guard('committed', lambda w, st, b: b['i'] < len(w.com(st, b['g'])), role='cursor'),
            Cmp('after', lambda w, st, b: b['pos'], '>', lambda w, st, b: st[3][0], role='cursor'),
            Guard('next', nxt, role='cursor', note='the next one in this group: none skipped'),
            Cmp('lin', lambda w, st, b: st[3][0], '>=',
                lambda w, st, b: base_before(w.com(st, b['g']), b['i'], 'p'), role='cursor',
                note='lineage: a record after an init or merged entry only once the cursor reached its base'),
        ], [
            Update('take', lambda w, st, b, d: d.set_seen(st[3][1] + (b['aid'],)), role='cursor'),
            Update('cursor', lambda w, st, b, d: d.set_cursor(b['pos']), role='cursor'),
        ], label=lambda b: (gn(b['g']), b['aid'], b['pos']))

        # ------------------------------------------------ the plan
        def started(w, st):
            return sum(1 for g in range(w.K) for e in w.log(st, g) if e[0] in ('spl', 'mrg'))

        def next_of(kind):
            def gen(w, st):
                n = started(w, st)
                if n < len(self.changes) and self.changes[n][0] == kind:
                    _, p, a, b = self.changes[n]
                    yield {'part': p, 'src': a, 'dst': b}
            return gen

        def at(w, st, b):
            """A's committed log up to the split (or subsumed) entry: the state
            the split (merge) trigger hands over. The entry itself is committed
            (a guard says so), so this is fixed once it is."""
            return w.com(st, b['src'])[:b['i'] if 'i' in b else b['f']]

        # ------------------------------------------------ split: one entry at A, then B's init
        split = Action('split', 'control', next_of('split'), [
            Guard('open', lambda w, st, b: held(w.com(st, b['src']), b['src'], b['part'], h0), role='move',
                  note='A splits off only a partition its committed log holds'),
        ], [
            Update('gen', lambda w, st, b, d: d.e.__setitem__('gen', gen_of(w.log(st, b['src'])) + 1),
                   role='stamp', note='both sides take the next generation'),
            Update('append', lambda w, st, b, d: d.append(b['src'], (
                'spl', b['part'], b['dst'], d.e.get('gen', 0))), role='move'),
        ], label=lambda b: (b['part'], gn(b['src']), '->', gn(b['dst'])))

        def spls(w, st):
            for a in range(w.K):
                for i, e in enumerate(w.log(st, a)):
                    if e[0] == 'spl':
                        yield {'name': (a, i, e[2]), 'part': e[1], 'g': e[2], 'src': a, 'i': i,
                               'gen': e[3]}

        init = Action('init', 'deliver', spls, [
            Guard('splcom', lambda w, st, b: b['i'] < len(w.com(st, b['src'])), role='move',
                  note='B starts only from A\'s committed split'),
        ], [
            Update('rows', lambda w, st, b, d: d.e.__setitem__('rows', rows_of(at(w, st, b), b['part'])),
                   role='carry', note='the rows at the split'),
            Update('outs', lambda w, st, b, d: d.e.__setitem__('outs', frozenset(outs(at(w, st, b), b['part']))),
                   role='carry', note='the dedup outcomes'),
            Update('tok', lambda w, st, b, d: d.e.__setitem__('tok', hightok(at(w, st, b), b['part'])),
                   role='carry', note='the highest lock token'),
            Update('base', lambda w, st, b, d: d.e.__setitem__('base', lastpos(at(w, st, b), b['part'])),
                   role='cursor', note='lineage: p\'s last position in A at the split'),
            Update('gen', lambda w, st, b, d: d.e.__setitem__('gen', b['gen']), role='stamp'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'init', b['name'], b['part'], d.e.get('rows', ()), d.e.get('outs', frozenset()),
                d.e.get('tok', 0), d.e.get('base', ZERO), d.e.get('gen', 0))), role='move'),
        ], label=lambda b: (b['name'], b['part']))

        # ------------------------------------------------ merge: B merging, A subsumed, B merged
        merge = Action('merge', 'control', next_of('merge'), [
            Guard('one', lambda w, st, b: not any(
                e[0] == 'mrg' and e[1] == b['part'] and not has(w.log(st, b['dst']), 'mgd', (b['dst'], i, e[2]))
                and not has(w.log(st, b['dst']), 'mab', (b['dst'], i, e[2]))
                for i, e in enumerate(w.log(st, b['dst']))), role='move',
                note='one merge of the partition at a time'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['dst'], ('mrg', b['part'], b['src'])), role='move'),
        ], label=lambda b: (b['part'], gn(b['src']), 'into', gn(b['dst'])))

        def mrgs(w, st):
            for bb in range(w.K):
                for i, e in enumerate(w.log(st, bb)):
                    if e[0] == 'mrg':
                        yield {'name': (bb, i, e[2]), 'part': e[1], 'g': e[2], 'lhs': bb, 'i': i}

        sub = Action('subsume', 'deliver', mrgs, [
            Guard('mrgcom', lambda w, st, b: b['i'] < len(w.com(st, b['lhs'])), role='move',
                  note='A freezes only for B\'s committed merging'),
            Guard('open', lambda w, st, b: held(w.com(st, b['g']), b['g'], b['part'], h0), role='move',
                  note='A freezes only a partition its committed log holds'),
            Guard('noab', lambda w, st, b: not has(w.log(st, b['lhs']), 'mab', b['name']), role='move',
                  note='A does not freeze for a merge B has given up'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('sub', b['name'], b['part'])), role='move'),
        ], label=lambda b: (b['name'], b['part']))

        def subs(w, st):
            for a in range(w.K):
                for f, e in enumerate(w.log(st, a)):
                    if e[0] == 'sub':
                        yield {'name': e[1], 'part': e[2], 'g': e[1][0], 'src': a, 'f': f}

        def mrg_at(E, name, part):
            i = name[1]
            return i < len(E) and E[i] == ('mrg', part, name[2])

        merged = Action('merged', 'deliver', subs, [
            Guard('subcom', lambda w, st, b: b['f'] < len(w.com(st, b['src'])), role='move',
                  note='B takes p only from A\'s committed subsumed'),
            Guard('mrg', lambda w, st, b: mrg_at(w.com(st, b['g']), b['name'], b['part']), role='move',
                  note='the name is B\'s committed merging at that position, so a stale name is ignored'),
            Guard('noab', lambda w, st, b: not has(w.log(st, b['g']), 'mab', b['name']), role='decide',
                  note='B never merges once its abort is in its log'),
        ], [
            Update('rows', lambda w, st, b, d: d.e.__setitem__('rows', rows_of(at(w, st, b), b['part'])),
                   role='carry', note='the rows at the freeze'),
            Update('outs', lambda w, st, b, d: d.e.__setitem__('outs', frozenset(outs(at(w, st, b), b['part']))),
                   role='carry', note='the dedup outcomes'),
            Update('tok', lambda w, st, b, d: d.e.__setitem__('tok', hightok(at(w, st, b), b['part'])),
                   role='carry', note='the highest lock token'),
            Update('base', lambda w, st, b, d: d.e.__setitem__('base', lastpos(at(w, st, b), b['part'])),
                   role='cursor', note='lineage: p\'s last position in A at the freeze'),
            Update('gen', lambda w, st, b, d: d.e.__setitem__('gen', max(gen_of(w.log(st, b['g'])[:b['name'][1]]),
                                                                         gen_of(at(w, st, b))) + 1),
                   role='stamp', note='the merged generation: max of both sides at the merge, + 1'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'mgd', b['name'], b['part'], d.e.get('rows', ()), d.e.get('outs', frozenset()),
                d.e.get('tok', 0), d.e.get('base', ZERO), d.e.get('gen', 0))), role='move'),
        ], label=lambda b: (b['name'], b['part']))

        # ------------------------------------------------ giving a merge up (one decider: B)
        def own_mrgs(w, st):
            for bb in range(w.K):
                for i, e in enumerate(w.log(st, bb)):
                    if e[0] == 'mrg':
                        yield {'name': (bb, i, e[2]), 'part': e[1], 'g': bb}

        mab = Action('mabort', 'tick', own_mrgs, [
            Guard('nomgd', lambda w, st, b: not has(w.log(st, b['g']), 'mgd', b['name']), role='decide',
                  note='B gives up only while its log has no merged'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('mab', b['name'], b['part'])), role='decide'),
        ], label=lambda b: (b['name'],))

        def mabs(w, st):
            for bb in range(w.K):
                for j, e in enumerate(w.log(st, bb)):
                    if e[0] == 'mab':
                        yield {'name': e[1], 'part': e[2], 'g': e[1][2], 'lhs': bb, 'j': j}

        uns = Action('unsub', 'deliver', mabs, [
            Guard('abcom', lambda w, st, b: b['j'] < len(w.com(st, b['lhs'])), role='decide',
                  note='A unfreezes only on B\'s committed abort'),
            Guard('sub', lambda w, st, b: has(w.log(st, b['g']), 'sub', b['name']), role='move',
                  note='A unfreezes only a merge it froze for'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['g'], ('uns', b['name'], b['part'])), role='move'),
        ], label=lambda b: (b['name'],))

        return [write, refuse, read, split, init, merge, sub, merged, mab, uns]


OPTION = Split
# The give-up path: only a merge can be given up, by B (one decider).
GIVEUP = ('mabort.append',)
