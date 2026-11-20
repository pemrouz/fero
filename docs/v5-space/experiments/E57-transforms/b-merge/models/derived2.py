"""
derived2.py: E-57 B5. E-30's model (../../../E30-derived-once/models/derived.py, read and imported, not
changed) extended as its README's "What the model leaves out" names: one source record with TWO outputs in ONE
output slot. Each output is now (source slot, sequence, B group, w), where w is the write's number within its
record. Run on E-16's engine, as E-30 ran.

OPTIONS
  srchi-slot     E-30's chosen mark, as it is: per (consumer, source slot, B slot) the highest source sequence
                 applied. With two outputs of one record in one B slot, the second has the same sequence, so it
                 is taken for a duplicate and skipped: the planted bug (today's srchi-slot).
  srchi-slot-w   API.md's pick: the mark also carries the write's number, so the mark is (sequence, w), compared
                 as a pair; and the consumer sends a record's outputs to one B slot in w order (the next only after
                 the one before is answered), so a lower w can never arrive after a higher one was applied.

BOUNDS: E-30's seven bounds with w = 0 (its properties keep holding), and five with two outputs of x1 in one
B slot: two-short, two-gcrash, two-drop, two-deep (x2 follows x1 on a1), two-bmove (the slot that holds both
outputs moves from b1 to b0 while the consumer may crash and restart).
"""
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
E30 = os.path.join(HERE, '..', '..', '..', 'E30-derived-once', 'models', 'derived.py')
_spec = importlib.util.spec_from_file_location('e30derived', E30)
_d = importlib.util.module_from_spec(_spec)
sys.modules['e30derived'] = _d
_spec.loader.exec_module(_d)
from engine import Action, Guard, Cmp, Update   # noqa: E402  (on the path through E-30's module)

B0, B1, GC = _d.B0, _d.B1, _d.GC
IX, IDLE, SENT, DONE, NEG, E = _d.IX, _d.IDLE, _d.SENT, _d.DONE, _d.NEG, _d.E
T, U = _d.T, _d.U


class W:
    """Outputs are 4-tuples (s, q, g, w). Every place E-30 unpacks (s, q, g) is written again here."""

    def gid(self, o):
        return self.outs[o]

    def p_emit(self, md, st):
        if st[IX['down']]:
            return
        for o, out in enumerate(self.outs):
            s, q = out[0], out[1]
            if q == self.pos(st, s) and self.ostat(st, o) == IDLE:
                yield {'o': o}

    def p_commit(self, md, st):
        if st[IX['down']]:
            return
        for s in self.slots:
            p = self.pos(st, s)
            if p >= self.src[s]:
                continue
            mine = [o for o, out in enumerate(self.outs) if out[0] == s and out[1] == p]
            yield {'s': s, 'p': p, 'mine': tuple(mine)}

    def check(self, st):
        bad = []
        cnt = self.applied(st)
        if any(v > 1 for v in cnt.values()):
            bad.append('ONCE')
        for s in self.slots:
            c = self.cursor(st, s)
            for o, out in enumerate(self.outs):
                if out[0] == s and out[1] < c and not cnt.get(self.gid(o)):
                    bad.append('LOST')
                    return bad
        return bad

    def write(self, extra=None):
        def f(md, st, b, d):
            m = b['m']
            x = d.f['_e'].get('x', extra(st, b) if extra else None)
            self.append(d, b['g'], ('w', m[1], m[3], st[IX['now']] if self.TIMED else 0, x, self.bslot(m[4])))
        return Update('append', f, 'world')


class SrcHiSlot(W, _d.SrcHiSlot):
    """E-30's srchi-slot over 4-tuple outputs: the mark is the source sequence only (the planted bug)."""

    def wid(self, st, o):
        s, q, g, w = self.outs[o]
        return ('d', s, q, self.bslot(o))


class SrcHiSlotW(W, _d.SrcHiSlot):
    """The mark carries the write's number: (sequence, w), compared as a pair."""
    NEGT = (NEG, NEG)

    def wid(self, st, o):
        s, q, g, w = self.outs[o]
        return ('d', s, (q, w), self.bslot(o))

    def hi(self, st, g, k, committed):
        ents = self.com(st, g) if committed else self.log(st, g)
        qs = [e[4] for e in ents if e[0] == 'w' and e[4] is not None and self.ekey(e) == k]
        for e in ents:
            if e[0] == 'open':
                qs += [h for kk, h in e[2] if kk == k]
        return max(qs) if qs else self.NEGT

    def emit_guards(self):
        # a record's outputs to one B slot go out in w order: the next only once the one before is answered
        def before_done(w_, st, b):
            o = b['o']
            s, q, g, w = self.outs[o]
            bs = self.bslot(o)
            return all(self.ostat(st, o2) == DONE for o2, x in enumerate(self.outs)
                       if x[0] == s and x[1] == q and self.bslot(o2) == bs and x[3] < w)
        return [T('inorder', before_done, 'order', "a record's outputs to one B slot are sent in w order")]


OPTIONS = {'srchi-slot': SrcHiSlot, 'srchi-slot-w': SrcHiSlotW}


def w0(outs):
    return tuple(o + (0,) for o in outs)


BOUNDS = {}
for name, b in _d.BOUNDS.items():   # E-30's bounds, every output w = 0
    BOUNDS[name] = dict(b, outs=w0(b['outs']))
_TWO = (('a1', 0, B0, 0), ('a1', 0, B0, 1), ('a1', 0, B1, 0))   # x1: two outputs in b0's slot, one in b1's
BOUNDS['two-short'] = {'src': {'a1': 1}, 'outs': _TWO, 'cap': 2, 'crashes': 0, 'faults': 1, 'drops': 0, 'tmax': 0, 'restarts': 1}
BOUNDS['two-gcrash'] = {'src': {'a1': 1}, 'outs': _TWO, 'cap': 2, 'crashes': 1, 'faults': 2, 'drops': 0, 'tmax': 0, 'restarts': 1}
BOUNDS['two-drop'] = {'src': {'a1': 1}, 'outs': _TWO, 'cap': 2, 'crashes': 0, 'faults': 2, 'drops': 1, 'tmax': 0, 'restarts': 1}
BOUNDS['two-deep'] = {'src': {'a1': 2}, 'outs': (('a1', 0, B0, 0), ('a1', 0, B0, 1), ('a1', 1, B0, 0)), 'cap': 2,
                      'crashes': 0, 'faults': 2, 'drops': 0, 'tmax': 0, 'restarts': 2}
# the slot R that holds both outputs of x1 moves from b1 to b0
BOUNDS['two-bmove'] = {'src': {'a1': 1}, 'outs': (('a1', 0, B1, 0), ('a1', 0, B1, 1), ('a1', 0, B0, 0)),
                       'bslots': ('R', 'R', 'P'), 'bmove': ('R', B1, B0), 'cap': 2, 'crashes': 0, 'faults': 1,
                       'drops': 0, 'tmax': 0, 'restarts': 1}
SWEEP = tuple(_d.SWEEP) + ('two-short', 'two-gcrash', 'two-drop', 'two-deep', 'two-bmove')
VERIFY = ()
PINNED = {k: _d.PIN for k in OPTIONS}
