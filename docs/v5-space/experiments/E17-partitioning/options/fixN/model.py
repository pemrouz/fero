"""
fixN: N groups fixed when the resource is defined; a partition goes to group
hash(partition) mod N, forever (Kafka partitions; V5-PRIMITIVE's 16 cells
without the re-key). Nothing ever moves.

Entries: only writes, ('w', aid, part, pos, tok), with pos = (group, log
index): an offset per group (SPACE O `off`).
The reader's cursor is a position: (group, index) of the last record taken.
"""

from dsl import Action, Guard, Update, Cmp
from world import Option
from bounds import HASH, count


def outs(E, part):
    """The attempts this log has applied to the partition (the dedup table)."""
    return {e[1] for e in E if e[0] == 'w' and e[2] == part}


def hightok(E, part):
    """The highest lock token this log has applied to the partition."""
    return max([e[4] for e in E if e[0] == 'w' and e[2] == part] + [0])


class FixN(Option):
    ZERO = (-1, -1)

    def __init__(self, bound):
        super().__init__(bound)
        self.N = count(bound['layouts'][0])
        self.names = tuple(f'G{i}' for i in range(self.N))
        self.home = {part: HASH[part] % self.N for part in HASH}

    def cursor0(self):
        return (self.home['p'], -1)

    def owners(self, w, st, part):
        return [self.home[part]]

    def rows(self, w, st, g, part):
        return tuple(e[1] for e in w.com(st, g) if e[0] == 'w' and e[2] == part)

    def settled(self, w, st):
        return all(not grp[1] for grp in st[0])

    def actions(self):
        home, ZERO = self.home, self.ZERO

        def reqs(w, st):
            for aid in w.aids:
                for g in range(w.K):
                    yield {'aid': aid, 'g': g}

        def lab(b):
            return (b['aid'], self.names[b['g']])

        def P(w, b):
            return w.part[b['aid']]

        write = Action('write', 'deliver', reqs, [
            Guard('route', lambda w, st, b: b['g'] == home[P(w, b)], role='route',
                  note='only the partition\'s own group takes it'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), P(w, b)),
                  role='dedup', note='an attempt already in the log is not applied again'),
            Cmp('fence', lambda w, st, b: w.tok[b['aid']], '>=',
                lambda w, st, b: hightok(w.log(st, b['g']), P(w, b)), role='fence',
                note='a token below the highest seen is not applied'),
        ], [
            Update('pos', lambda w, st, b, d: d.e.__setitem__('pos', (b['g'], len(w.log(st, b['g'])))),
                   role='stamp', note='the position is the group and the log index'),
            Update('append', lambda w, st, b, d: d.append(b['g'], (
                'w', b['aid'], P(w, b), d.e.get('pos', ZERO), w.tok[b['aid']])), role='answer'),
        ], label=lab)

        refuse = Action('refuse', 'deliver', reqs, [
            Guard('route', lambda w, st, b: b['g'] == home[P(w, b)], role='route'),
            Guard('dedup', lambda w, st, b: b['aid'] not in outs(w.log(st, b['g']), P(w, b)),
                  role='dedup', note='an applied attempt is answered, not refused'),
            Cmp('stale', lambda w, st, b: w.tok[b['aid']], '<',
                lambda w, st, b: hightok(w.com(st, b['g']), P(w, b)), role='fence',
                note='refused for good only on a committed higher token'),
        ], [
            Update('answer', lambda w, st, b, d: d.refuse(b['aid']), role='answer'),
        ], label=lab)

        def recs(w, st):
            if st[3] is None:
                return
            for g in range(w.K):
                for i, e in enumerate(w.log(st, g)):
                    if e[0] == 'w' and e[2] == 'p':
                        yield {'g': g, 'i': i, 'e': e}

        def nxt(w, st, b):
            cur, pos = st[3][0], b['e'][3]
            return not any(e[0] == 'w' and e[2] == 'p' and cur < e[3] < pos
                           for e in w.com(st, b['g']))

        read = Action('read', 'read', recs, [
            Guard('committed', lambda w, st, b: b['i'] < len(w.com(st, b['g'])), role='cursor',
                  note='serve only committed records'),
            Cmp('after', lambda w, st, b: b['e'][3], '>', lambda w, st, b: st[3][0], role='cursor',
                note='only records after the cursor'),
            Guard('next', nxt, role='cursor', note='the next one: none skipped'),
        ], [
            Update('take', lambda w, st, b, d: d.set_seen(st[3][1] + (b['e'][1],)), role='cursor'),
            Update('cursor', lambda w, st, b, d: d.set_cursor(b['e'][3]), role='cursor'),
        ], label=lambda b: (self.names[b['g']], b['e'][1], b['e'][3]))

        return [write, refuse, read]


OPTION = FixN
