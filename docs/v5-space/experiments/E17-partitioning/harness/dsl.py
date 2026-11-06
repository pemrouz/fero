"""
dsl.py: the rule language every option is written in.

An option is a list of Actions. An Action has a kind, a parameter generator,
a list of Guards (each one guard conjunct) and a list of Updates (each one
state update). This shape is what makes ablation and mutants mechanical
(REQUIREMENTS DEV-10):

  - drop a guard conjunct      -> the guard always passes
  - drop a state update        -> the update does nothing
  - flip a comparison          -> < becomes <=, <= becomes <, > becomes >=,
                                  >= becomes >   (only Guards made with Cmp)
  - swap two updates           -> they run in the other order

A rule is one Guard or one Update. Its id is "action.rule".

Kinds of action (the event alphabet, see HARNESS.md):
  deliver   a fact reaches a process and it acts (a report, a client's
            request, a decision it reads). Allowed in calm.
  read      the reader asks a group for the next record. Allowed in calm.
  control   a scale decision starts (grow, shrink). Not in calm.
  tick      a timer fires: a free choice such as cancel or abort. Not in calm.
The harness adds crash (a leader dies, a new one takes over) and commit.
"""

import operator

OPS = {'<': operator.lt, '<=': operator.le, '>': operator.gt, '>=': operator.ge,
       '==': operator.eq, '!=': operator.ne}
FLIP = {'<': '<=', '<=': '<', '>': '>=', '>=': '>'}
CALM_KINDS = ('deliver', 'read')
KINDS = ('deliver', 'read', 'control', 'tick')

# What a rule is for. Used only to group rules in the report.
ROLES = {
    'route': 'which group takes a partition',
    'dedup': 'an attempt takes effect once',
    'fence': 'lock tokens never go back',
    'stamp': 'positions',
    'cursor': 'readers resume',
    'move': 'the move or re-key protocol',
    'carry': 'state carried to the new group',
    'decide': 'one point decides a move or re-key',
    'perf': 'copy before the fence (the unwritable window)',
    'idem': 'never append the same step twice',
    'answer': 'the answer to the client',
}


class Guard:
    """One guard conjunct. Either fn(w, st, b) -> bool, or a comparison
    lhs(w, st, b) <op> rhs(w, st, b) made with Cmp (which can be flipped)."""
    __slots__ = ('name', 'fn', 'lhs', 'op', 'rhs', 'role', 'note', 'action')

    def __init__(self, name, fn=None, role='', note='', lhs=None, op=None, rhs=None):
        self.name, self.fn, self.role, self.note = name, fn, role, note
        self.lhs, self.op, self.rhs = lhs, op, rhs
        self.action = None

    @property
    def id(self):
        return f'{self.action}.{self.name}'

    def is_cmp(self):
        return self.op in FLIP

    def test(self, w, st, b, op=None):
        if self.op is None:
            return self.fn(w, st, b)
        return OPS[op or self.op](self.lhs(w, st, b), self.rhs(w, st, b))


def Cmp(name, lhs, op, rhs, role='', note=''):
    return Guard(name, role=role, note=note, lhs=lhs, op=op, rhs=rhs)


class Update:
    """One state update: fn(w, st, b, d) changes the draft d."""
    __slots__ = ('name', 'fn', 'role', 'note', 'action')

    def __init__(self, name, fn, role='', note=''):
        self.name, self.fn, self.role, self.note = name, fn, role, note
        self.action = None

    @property
    def id(self):
        return f'{self.action}.{self.name}'


class Action:
    """kind: one of KINDS. params(w, st) yields bindings (dicts). The label
    of a step is (name, label(b))."""

    def __init__(self, name, kind, params, guards, updates, label=None, note=''):
        assert kind in KINDS, kind
        self.name, self.kind, self.params = name, kind, params
        self.guards, self.updates = list(guards), list(updates)
        self.label = label or (lambda b: tuple(sorted(b.items())))
        self.note = note
        names = [r.name for r in self.guards + self.updates]
        assert len(set(names)) == len(names), f'duplicate rule name in {name}'
        for r in self.guards + self.updates:
            r.action = name


def rules(actions):
    """Every rule of an option, in model-text order."""
    out = []
    for a in actions:
        out.extend(a.guards)
        out.extend(a.updates)
    return out


class Mutation:
    """What is switched off or changed in one run.
    drop:  set of rule ids (guards pass, updates do nothing)
    flip:  set of guard ids whose comparison is flipped
    swap:  dict action name -> (i, j), two update positions swapped"""

    def __init__(self, drop=(), flip=(), swap=None):
        self.drop = frozenset(drop)
        self.flip = frozenset(flip)
        self.swap = dict(swap or {})

    def __repr__(self):
        parts = []
        if self.drop:
            parts.append('drop ' + ', '.join(sorted(self.drop)))
        if self.flip:
            parts.append('flip ' + ', '.join(sorted(self.flip)))
        for a, (i, j) in self.swap.items():
            parts.append(f'swap {a}[{i},{j}]')
        return '; '.join(parts) or 'none'

    def key(self):
        return (tuple(sorted(self.drop)), tuple(sorted(self.flip)),
                tuple(sorted(self.swap.items())))
