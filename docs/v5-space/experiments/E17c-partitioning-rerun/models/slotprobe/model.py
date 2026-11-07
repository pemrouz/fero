"""
slotprobe: two probes of rules slot's model may count only because of how
it is written, not because the move needs them. Each is slot's model
(options/slot/model.py) with one thing changed; nothing else differs.

  slotprobe-trig     B's `open` acts on a copy entry. In slot's model its
                     parameters yield only copies with END(N) set (a filter
                     in `params`, which HARNESS.md says to avoid: a design
                     filter must be a guard, or nobody counts it). Here the
                     parameters yield every copy, and the filter is a guard,
                     `open.final`. Does `final.end` (END(N)) stay needed once
                     the filter can be ablated?
  slotprobe-atfence  the final copy reads A's committed log up to A's fence
                     entry (the state at the fence, as a split's trigger
                     does), not A's whole committed log at the time of the
                     copy. Part 2 found that `final.once` is a rule of this
                     timing for lanes (`lanes-atfence`); this checks slot.
"""
import importlib.util
import os
import sys

_here = os.path.dirname(os.path.abspath(__file__))
_path = os.path.join(os.path.dirname(_here), 'slot', 'model.py')
_spec = importlib.util.spec_from_file_location('opt_slot_for_slotprobe', _path)
_mod = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = _mod
_spec.loader.exec_module(_mod)

from dsl import Action, Guard   # noqa: E402


class SlotTrig(_mod.Slot):
    def actions(self):
        acts = _mod.Slot.actions(self)
        out = []
        for a in acts:
            if a.name == 'open':
                def every_cp(w, st):
                    for g in range(w.K):
                        for j, e in enumerate(w.log(st, g)):
                            if e[0] == 'cp':
                                yield {'name': e[1], 's': e[2], 'g': g, 'j': j, 'N': e[8]}
                guards = [Guard('final', lambda w, st, b: b['N'] >= 0, role='move',
                                note='B opens on the final copy (END(N) set), not on the bulk copy')]
                # fresh rule objects: Action() sets each rule's action name
                for g in a.guards:
                    guards.append(Guard(g.name, g.fn, g.role, g.note, g.lhs, g.op, g.rhs))
                a = Action('open', a.kind, every_cp, guards, a.updates, label=a.label, note=a.note)
            out.append(a)
        return out


class SlotAtFence(_mod.Slot):
    def actions(self):
        acts = _mod.Slot.actions(self)
        for a in acts:
            if a.name != 'final':
                continue
            upto = {}

            def cut(w, st, b):
                """A's committed log up to and including its fence entry."""
                return w.com(st, b['src'])[:b['f'] + 1]

            for u in a.updates:
                if u.name == 'recs':
                    u.fn = lambda w, st, b, d: d.e.__setitem__('recs', _mod.recs(cut(w, st, b), b['s']))
                elif u.name == 'outs':
                    u.fn = lambda w, st, b, d: d.e.__setitem__('outs', frozenset(_mod.outs(cut(w, st, b), b['s'])))
                elif u.name == 'tok':
                    u.fn = lambda w, st, b, d: d.e.__setitem__('tok', _mod.hightok(cut(w, st, b), b['s']))
                elif u.name == 'seq':
                    u.fn = lambda w, st, b, d: d.e.__setitem__('seq', _mod.top(cut(w, st, b), b['s']))
                elif u.name == 'append':
                    u.fn = lambda w, st, b, d: d.append(b['g'], (
                        'cp', b['name'], b['s'], b['f'] + 1, d.e.get('recs', ()), d.e.get('outs', frozenset()),
                        d.e.get('tok', 0), d.e.get('seq', 0), d.e.get('end', -1)))
        return acts


OPTION = SlotTrig
OPTIONS = {'slotprobe-trig': SlotTrig, 'slotprobe-atfence': SlotAtFence}
GIVEUP = _mod.GIVEUP
