"""
rekey: fixN, grown (or shrunk) by copying the whole resource into a new
generation with a different cell count, then flipping a catalog pointer
under a fence (V5-PRIMITIVE section 3 item 4; SPACE P `rekey`; CELL). The
shape follows Vitess's Reshard workflow (VReplication): the new cells copy
from the old ones while writes go on, then a cut-over stops writes at the
old cells, the new cells catch up to that point, and the routing switches.
https://vitess.io/docs/reference/vreplication/reshard/

Groups: C, the catalog (in fero, #meta), whose log holds the workflow's
decisions; and the cells of each generation. Generation k has count(layout k)
cells; a partition goes to cell hash mod count. Every re-key copies into NEW
cells (a new generation), so a grow 1 -> 2 runs 3 cells and a catalog.

Entries:
  catalog    ('rk', G, src)   re-key into generation G from generation src
             ('cut', G)       stop writes at the old cells (cut-over)
             ('flip', G)      G is now the current generation
             ('abandon', G)   give the re-key up (only before the flip)
  old cell   ('frz', G)       frozen for the re-key into G: takes no writes
             ('thaw', G)      unfrozen after an abandon
  new cell   ('cp', G, o, upto, rows, outs, tok, fin): a copy from old cell
             o's committed log up to index `upto`, of the partitions that map
             here. rows = ((part, ((aid, pos), ...)), ...); outs = dedup
             outcomes per partition; tok = highest lock token per partition;
             fin = True for the copy made after o's freeze committed.
  any cell   ('w', aid, part, (gen, cell, index), tok)
A position is (generation, cell, log index): positions never collide, but a
cursor of an old generation means nothing in a new one.

Two variants, differing only in what a reader does across a flip:
  rekey        CELL as written: a cell refuses a cursor of another generation
               (`unknown-log`); the reader restarts from a snapshot of the new
               cell. A `log` reader loses its place (P-07).
  rekey-carry  the copy carries each record with its original position, and a
               new cell serves those too, so a cursor of the old generation
               continues (cheap lineage: positions are compared as tuples).
"""

from dsl import Action, Guard, Update, Cmp
from world import Option
from bounds import HASH, count

C = 0                       # the catalog's group


def cell(part, n):
    return HASH[part] % n


def has(E, kind, G):
    return any(e[0] == kind and e[1] == G for e in E)


def rows_of(E, part):
    """((aid, pos), ...): a copy replaces, a write adds."""
    r = ()
    for e in E:
        if e[0] == 'cp':
            d = dict(e[4])
            if part in d:
                r = d[part]
        elif e[0] == 'w' and e[2] == part:
            r = r + ((e[1], e[3]),)
    return r


def outs(E, part):
    o = set()
    for e in E:
        if e[0] == 'w' and e[2] == part:
            o.add(e[1])
        elif e[0] == 'cp':
            o |= dict(e[5]).get(part, frozenset())
    return o


def hightok(E, part):
    t = 0
    for e in E:
        if e[0] == 'w' and e[2] == part:
            t = max(t, e[4])
        elif e[0] == 'cp':
            t = max(t, dict(e[6]).get(part, 0))
    return t


def cur(Ecat):
    """The current generation by these catalog entries."""
    g = 1
    for e in Ecat:
        if e[0] == 'flip':
            g = max(g, e[1])
    return g


class Rekey(Option):
    ZERO = (0, 0, -1)
    CARRY = False

    def __init__(self, bound):
        super().__init__(bound)
        lays = bound['layouts']
        self.n = {k + 1: count(l) for k, l in enumerate(lays)}     # gen -> cells
        names = ['C']
        self.cells = {}           # gen -> [group]
        self.info = {}            # group -> (gen, cell)
        for k in sorted(self.n):
            self.cells[k] = []
            for c in range(self.n[k]):
                self.info[len(names)] = (k, c)
                self.cells[k].append(len(names))
                names.append(f'g{k}c{c}')
        self.names = tuple(names)
        self.plan = len(lays) - 1

    def cursor0(self):
        return (1, cell('p', self.n[1]), -1)

    # which old cells feed new cell g (gen G) when copying from gen src
    def sources(self, G, src, g):
        c = self.info[g][1]
        out = []
        for o in self.cells[src]:
            co = self.info[o][1]
            if any(cell(p, self.n[src]) == co and cell(p, self.n[G]) == c for p in HASH):
                out.append(o)
        return out

    def holds(self, g, part):
        k, c = self.info[g]
        return cell(part, self.n[k]) == c

    def frozen(self, E, Ecom):
        """Some freeze in E without a committed thaw after it."""
        return any(e[0] == 'frz' and not has(Ecom, 'thaw', e[1]) for e in E)

    def owners(self, w, st, part):
        cat = w.com(st, C)
        out = []
        for g in range(1, w.K):
            k = self.info[g][0]
            if not self.holds(g, part):
                continue
            if k != 1 and not has(cat, 'flip', k):
                continue
            com = w.com(st, g)
            if self.frozen(com, com):
                continue
            out.append(g)
        return out

    def rows(self, w, st, g, part):
        return tuple(a for a, pos in rows_of(w.com(st, g), part))

    def settled(self, w, st):
        if any(grp[1] for grp in st[0]):
            return False
        cat = w.com(st, C)
        for e in cat:
            if e[0] != 'rk':
                continue
            G, src = e[1], e[2]
            if has(cat, 'flip', G):
                continue
            if not has(cat, 'abandon', G):
                return False
            for o in self.cells[src]:
                E = w.com(st, o)
                if has(E, 'frz', G) and not has(E, 'thaw', G):
                    return False
        return True

    def given_up(self, w, st):
        """If the latest re-key was abandoned (committed), the generation it
        copied from must hold every partition again."""
        cat = w.com(st, C)
        rks = [e for e in cat if e[0] == 'rk']
        if not rks:
            return []
        G, src = max(rks)[1], max(rks)[2]
        if not has(cat, 'abandon', G):
            return []
        out = []
        for part in HASH:
            for g in self.cells[src]:
                if self.holds(g, part):
                    out.append((part, g))
        return out

    def done_all(self, w, st):
        """The last planned generation has flipped."""
        return has(w.com(st, C), 'flip', max(self.n))

    def show(self, e):
        if e[0] == 'cp':
            return ('cp', e[1], self.names[e[2]], f'upto={e[3]}',
                    {p: [a for a, q in r] for p, r in e[4]}, dict(e[5]), dict(e[6]), 'fin' if e[7] else '')
        return e

    def actions(self):
        ZERO, NM, info = self.ZERO, self.names, self.info

        def gn(x):
            return NM[x]

        def rk_of(w, st, G):
            for e in w.log(st, C):
                if e[0] == 'rk' and e[1] == G:
                    return e
            return None

        # ------------------------------------------------ the client's writes
        def reqs(w, st):
            for aid in w.aids:
                for g in range(1, w.K):
                    yield {'aid': aid, 'g': g, 'part': w.part[aid]}

        def lab(b):
            return (b['aid'], gn(b['g']))

        def live(w, st, g):
            k = info[g][0]
            return k == 1 or has(w.com(st, C), 'flip', k)

        write = Action('write', 'deliver', reqs, [
            Guard('route', lambda w, st, b: self.holds(b['g'], b['part']), role='route',
                  note='the partition\'s cell in this cell\'s generation'),
            Guard('live', lambda w, st, b: live(w, st, b['g']), role='decide',
                  note='a new generation takes writes only after its flip commits'),
            Guard('nofrz', lambda w, st, b: not self.frozen(w.log(st, b['g']), w.com(st, b['g'])), role='move',
                  note='no write once frozen is in the log, until a committed thaw'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), b['part']), role='dedup'),
            Cmp('fence', lambda w, st, b: w.tok[b['aid']], '>=',
                lambda w, st, b: hightok(w.log(st, b['g']), b['part']), role='fence'),
        ], [
            Update('pos', lambda w, st, b, d: d.e.__setitem__('pos', info[b['g']] + (len(w.log(st, b['g'])),)),
                   role='stamp', note='(generation, cell, log index)'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'w', b['aid'], b['part'], d.e.get('pos', ZERO), w.tok[b['aid']])), role='answer'),
        ], label=lab)

        refuse = Action('refuse', 'deliver', reqs, [
            Guard('route', lambda w, st, b: self.holds(b['g'], b['part']), role='route'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), b['part']), role='dedup'),
            Cmp('stale', lambda w, st, b: w.tok[b['aid']], '<',
                lambda w, st, b: hightok(w.com(st, b['g']), b['part']), role='fence'),
        ], [
            Update('answer', lambda w, st, b, d: d.refuse(b['aid']), role='answer'),
        ], label=lab)

        # ------------------------------------------------ the workflow, at the catalog
        def nextrk(w, st):
            k = sum(1 for e in w.log(st, C) if e[0] == 'rk')
            if k < self.plan:
                yield {'G': k + 2}

        def ended(w, st, b):
            cat, com = w.log(st, C), w.com(st, C)
            return all(has(com, 'flip', e[1]) or has(com, 'abandon', e[1]) for e in cat if e[0] == 'rk')

        start = Action('start', 'control', nextrk, [
            Guard('prev', ended, role='move', note='one re-key at a time'),
        ], [
            Update('src', lambda w, st, b, d: d.e.__setitem__('src', cur(w.com(st, C))), role='move',
                   note='copy from the current generation'),
            Update('append', lambda w, st, b, d: d.append(C, ('rk', b['G'], d.e.get('src', 1))), role='move'),
        ], label=lambda b: ('gen', b['G']))

        def rks(w, st):
            for r, e in enumerate(w.log(st, C)):
                if e[0] == 'rk':
                    yield {'G': e[1], 'src': e[2], 'r': r}

        def pairs(w, st):
            for r, e in enumerate(w.log(st, C)):
                if e[0] == 'rk':
                    G, src = e[1], e[2]
                    for g in self.cells[G]:
                        for o in self.sources(G, src, g):
                            yield {'G': G, 'src': src, 'r': r, 'g': g, 'o': o}

        def has_final(E, G, o):
            return any(e[0] == 'cp' and e[1] == G and e[2] == o and e[7] for e in E)

        def cprows(w, st, b):
            n = self.n[b['G']]
            c = info[b['g']][1]
            E = w.com(st, b['o'])
            return tuple((p, rows_of(E, p)) for p in sorted(HASH)
                         if cell(p, n) == c and self.holds(b['o'], p))

        def parts_here(b):
            n = self.n[b['G']]
            c = info[b['g']][1]
            return [p for p in sorted(HASH) if cell(p, n) == c and self.holds(b['o'], p)]

        copy = Action('copy', 'deliver', pairs, [
            Guard('rkcom', lambda w, st, b: b['r'] < len(w.com(st, C)), role='perf',
                  note='copy for a committed re-key'),
            Guard('once', lambda w, st, b: not any(e[0] == 'cp' and e[1] == b['G'] and e[2] == b['o']
                                                    for e in w.log(st, b['g'])),
                  role='idem', note='one bulk copy; the rest comes after the cut-over'),
        ], [
            Update('rows', lambda w, st, b, d: d.e.__setitem__('rows', cprows(w, st, b)), role='perf'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'cp', b['G'], b['o'], len(w.com(st, b['o'])), d.e.get('rows', ()), (), (), False)), role='perf'),
        ], label=lambda b: ('gen', b['G'], gn(b['g']), 'from', gn(b['o'])))

        def all_copied(w, st, b, final, committed):
            G, src = b['G'], b['src']
            for g in self.cells[G]:
                E = w.com(st, g) if committed else w.log(st, g)
                for o in self.sources(G, src, g):
                    if not any(e[0] == 'cp' and e[1] == G and e[2] == o and (e[7] or not final) for e in E):
                        return False
            return True

        cut = Action('cut', 'deliver', rks, [
            Guard('rkcom', lambda w, st, b: b['r'] < len(w.com(st, C)), role='move'),
            Guard('ready', lambda w, st, b: all_copied(w, st, b, False, True), role='perf',
                  note='every new cell reports a committed copy'),
            Guard('noab', lambda w, st, b: not has(w.log(st, C), 'abandon', b['G']), role='move'),
            Guard('once', lambda w, st, b: not has(w.log(st, C), 'cut', b['G']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(C, ('cut', b['G'])), role='move'),
        ], label=lambda b: ('gen', b['G']))

        def olds(w, st):
            for r, e in enumerate(w.log(st, C)):
                if e[0] == 'rk':
                    for o in self.cells[e[2]]:
                        yield {'G': e[1], 'r': r, 'o': o}

        freeze = Action('freeze', 'deliver', olds, [
            Guard('rkcom', lambda w, st, b: b['r'] < len(w.com(st, C)), role='move',
                  note='an old cell freezes only for a committed re-key'),
            Guard('cutcom', lambda w, st, b: has(w.com(st, C), 'cut', b['G']), role='perf',
                  note='... once the catalog has committed the cut-over'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['o']), 'frz', b['G']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['o'], ('frz', b['G'])), role='move'),
        ], label=lambda b: ('gen', b['G'], gn(b['o'])))

        def frzs(w, st):
            for r, e in enumerate(w.log(st, C)):
                if e[0] != 'rk':
                    continue
                G, src = e[1], e[2]
                for g in self.cells[G]:
                    for o in self.sources(G, src, g):
                        for f, x in enumerate(w.log(st, o)):
                            if x[0] == 'frz' and x[1] == G:
                                yield {'G': G, 'src': src, 'g': g, 'o': o, 'f': f}

        final = Action('final', 'deliver', frzs, [
            Guard('frzcom', lambda w, st, b: b['f'] < len(w.com(st, b['o'])), role='move',
                  note='the final copy covers the old cell\'s committed freeze'),
            Guard('once', lambda w, st, b: not has_final(w.log(st, b['g']), b['G'], b['o']), role='idem'),
        ], [
            Update('rows', lambda w, st, b, d: d.e.__setitem__('rows', cprows(w, st, b)), role='carry'),
            Update('outs', lambda w, st, b, d: d.e.__setitem__('outs', tuple(
                (p, frozenset(outs(w.com(st, b['o']), p))) for p in parts_here(b))), role='carry',
                note='dedup transfer'),
            Update('tok', lambda w, st, b, d: d.e.__setitem__('tok', tuple(
                (p, hightok(w.com(st, b['o']), p)) for p in parts_here(b))), role='carry',
                note='fence transfer'),
            Update('fin', lambda w, st, b, d: d.e.__setitem__('fin', True), role='move'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'cp', b['G'], b['o'], len(w.com(st, b['o'])), d.e.get('rows', ()), d.e.get('outs', ()),
                d.e.get('tok', ()), d.e.get('fin', False))), role='move'),
        ], label=lambda b: ('gen', b['G'], gn(b['g']), 'from', gn(b['o'])))

        flip = Action('flip', 'deliver', rks, [
            Guard('finals', lambda w, st, b: all_copied(w, st, b, True, False), role='decide',
                  note='every new cell holds its final copy from every source'),
            Guard('fincom', lambda w, st, b: all_copied(w, st, b, True, True), role='decide',
                  note='... committed'),
            Guard('noab', lambda w, st, b: not has(w.log(st, C), 'abandon', b['G']), role='decide',
                  note='never flip once abandon is in the catalog\'s log'),
            Guard('once', lambda w, st, b: not has(w.log(st, C), 'flip', b['G']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(C, ('flip', b['G'])), role='decide'),
        ], label=lambda b: ('gen', b['G']))

        abandon = Action('abandon', 'tick', rks, [
            Guard('noflip', lambda w, st, b: not has(w.log(st, C), 'flip', b['G']), role='decide',
                  note='abandon only while the catalog\'s log has no flip'),
            Guard('once', lambda w, st, b: not has(w.log(st, C), 'abandon', b['G']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(C, ('abandon', b['G'])), role='decide'),
        ], label=lambda b: ('gen', b['G']))

        def abs_(w, st):
            for a, e in enumerate(w.log(st, C)):
                if e[0] == 'abandon':
                    rk = rk_of(w, st, e[1])
                    if rk is None:
                        continue
                    for o in self.cells[rk[2]]:
                        yield {'G': e[1], 'a': a, 'o': o}

        thaw = Action('thaw', 'deliver', abs_, [
            Guard('abcom', lambda w, st, b: b['a'] < len(w.com(st, C)), role='decide',
                  note='an old cell thaws only on a committed abandon'),
            Guard('frz', lambda w, st, b: has(w.log(st, b['o']), 'frz', b['G']), role='move'),
            Guard('once', lambda w, st, b: not has(w.log(st, b['o']), 'thaw', b['G']), role='idem'),
        ], [
            Update('append', lambda w, st, b, d: d.append(b['o'], ('thaw', b['G'])), role='move'),
        ], label=lambda b: ('gen', b['G'], gn(b['o'])))

        acts = [write, refuse] + self.reads() + [start, copy, cut, freeze, final, flip, abandon, thaw]
        return acts

    # ------------------------------------------------ the reader
    def reads(self):
        info = self.info

        def cands(w, st):
            if st[3] is None:
                return
            for g in range(1, w.K):
                for i, e in enumerate(w.log(st, g)):
                    if e[0] == 'w' and e[2] == 'p':
                        yield {'g': g, 'i': i, 'aid': e[1], 'pos': e[3]}
                    elif self.CARRY and e[0] == 'cp':
                        for aid, pos in dict(e[4]).get('p', ()):
                            yield {'g': g, 'i': i, 'aid': aid, 'pos': pos}

        def nxt(w, st, b):
            cur_, pos = st[3][0], b['pos']
            for e in w.com(st, b['g']):
                if e[0] == 'w' and e[2] == 'p' and cur_ < e[3] < pos:
                    return False
                if self.CARRY and e[0] == 'cp' and any(cur_ < q < pos for a, q in dict(e[4]).get('p', ())):
                    return False
            return True

        guards = [Guard('committed', lambda w, st, b: b['i'] < len(w.com(st, b['g'])), role='cursor')]
        if not self.CARRY:
            guards.append(Guard('gen', lambda w, st, b: st[3][0][0] == info[b['g']][0], role='cursor',
                                note='a cursor of another generation is refused (unknown-log)'))
        guards += [
            Cmp('after', lambda w, st, b: b['pos'], '>', lambda w, st, b: st[3][0], role='cursor'),
            Guard('next', nxt, role='cursor'),
        ]
        read = Action('read', 'read', cands, guards, [
            Update('take', lambda w, st, b, d: d.set_seen(st[3][1] + (b['aid'],)), role='cursor'),
            Update('cursor', lambda w, st, b, d: d.set_cursor(b['pos']), role='cursor'),
        ], label=lambda b: (self.names[b['g']], b['aid'], b['pos']))
        if self.CARRY:
            return [read]

        def cells(w, st):
            if st[3] is None:
                return
            for g in range(1, w.K):
                yield {'g': g}

        restart = Action('restart', 'read', cells, [
            Guard('route', lambda w, st, b: self.holds(b['g'], 'p'), role='cursor',
                  note='a snapshot of the reader\'s partition, from its cell'),
            Cmp('newer', lambda w, st, b: info[b['g']][0], '>', lambda w, st, b: st[3][0][0], role='cursor',
                note='refused unknown-log: restart from a newer generation\'s snapshot, never an older'),
            Guard('live', lambda w, st, b: info[b['g']][0] == 1 or has(w.com(st, C), 'flip', info[b['g']][0]),
                  role='cursor', note='the snapshot comes from a cell that has flipped'),
        ], [
            Update('take', lambda w, st, b, d: d.set_seen(tuple(a for a, p in rows_of(w.com(st, b['g']), 'p'))),
                   role='cursor', note='the snapshot replaces what the reader holds'),
            Update('cursor', lambda w, st, b, d: d.set_cursor(info[b['g']] + (len(w.com(st, b['g'])) - 1,)),
                   role='cursor'),
        ], label=lambda b: (self.names[b['g']],))
        return [read, restart]


class RekeyCarry(Rekey):
    CARRY = True


OPTION = Rekey
# The give-up path (see slot/model.py): abandoning a re-key.
GIVEUP = ('abandon.append',)
OPTIONS = {'rekey': Rekey, 'rekey-carry': RekeyCarry}
