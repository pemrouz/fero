"""
once: split + merge and the fused probe, each with the "once" guards their
models never wrote.

slot's, lanes' and re-key's models give every action that writes a named
entry a guard "not if this entry is already in my log" (role 'idem'); the
ablation then drops most of them, because the harness ignores an exact
repeat (HARNESS.md). split's and pslot-fused's models never wrote these
guards at all: their entries are taken at the fence, so a repeat is the same
entry, and the harness ignores it. In a real log a step taken twice appends
twice. To ask "which once guards does each option need in a real log" on
equal terms, these two variants add the guard, with the same shape and
role, to every action that writes a named entry. Nothing else changes, so
with the harness's convention the added guards are never needed and the
counts are unchanged.

  once-split        split + merge: init, subsume, merged, mabort, unsub
  once-pslot-fused  the fused probe: final (the copy that opens), abort,
                    unfence
"""
import importlib.util
import os
import sys

from dsl import Action, Guard   # noqa: E402

_here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _load(rel, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(_here, rel))
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_split = _load('split/model.py', 'opt_split_for_once')
_fused = _load('pslot/fused.py', 'opt_fused_for_once')


def _has(E, kind, name):
    return any(e[0] == kind and e[1] == name for e in E)


def _with_once(acts, spec):
    """spec: action name -> the entry kind it writes, named by b['name'], in
    the log of group b[key]."""
    out = []
    for a in acts:
        if a.name in spec:
            kind, key = spec[a.name]
            g = Guard('once', (lambda kind, key: lambda w, st, b: not _has(w.log(st, b[key]), kind, b['name']))(kind, key),
                      role='idem', note=f'not if this {kind} is already in the log')
            guards = [Guard(x.name, x.fn, x.role, x.note, x.lhs, x.op, x.rhs) for x in a.guards] + [g]
            a = Action(a.name, a.kind, a.params, guards, a.updates, label=a.label, note=a.note)
        out.append(a)
    return out


class OnceSplit(_split.Split):
    def actions(self):
        return _with_once(_split.Split.actions(self), {
            'init': ('init', 'g'), 'subsume': ('sub', 'g'), 'merged': ('mgd', 'g'),
            'mabort': ('mab', 'g'), 'unsub': ('uns', 'g')})


class OnceFused(_fused.PSlotFused):
    def actions(self):
        return _with_once(super().actions(), {
            'final': ('cp', 'g'), 'abort': ('abort', 'g'), 'unfence': ('unf', 'g')})


OPTION = OnceSplit
OPTIONS = {'once-split': OnceSplit, 'once-pslot-fused': OnceFused}
GIVEUP = ()
