"""
catalog.py: the settings record in the home log, changed online. E-51.

simplicity.json meta-catalog@per-resource: an alter changes the settings
record online, by an entry in the resource's home log, and a roll adds the
new code hash before it removes the old one (rule 2); a server becomes a
full copy only if it can run one of the allowed code hashes (rule 3; a
later open with another code hash is refused unless an alter allows it,
rule 1's code part); while the write gate is read-only, every group of the
resource refuses every write (rule 5); and in the record's high count, an
alter's keys are checked against each other (high rule 6). Rule 1's
options part and rule 4 (the seed) are models/found.py's.

THE WORLD (not counted). One resource on three machines, each holding a
copy of its home group H and of one data group G (Raft, abstract: a group
commits while a majority of copies serve). Each machine runs code hash 1
or 2. A roll (fero deploy's, a control step) restarts one machine with code
2, only while every other copy serves (a roll waits for each copy to
rejoin); a restarted copy serves again once it joins. The operator's alter
steps (control) add hash 2 to the settings record, remove hash 1, set the
read-only gate, or change one of two keys (`copies` and `standbys`, which
must keep standbys >= copies: DESIGN-V5 4.5's keys checked against each
other). Each group follows the home log and applies the gate when it reads
it (a world step). Control steps count as calm here: the operator finishes
the roll (as E-33's `init` counted the operator's step).

PROPERTIES
  CAT3   every serving copy runs a code hash the settings record allows.
  AVAIL  while every machine is up, the groups commit: no alter or roll step
         takes the majority away ("online").
  GATE   no write commits in a group that has applied the read-only gate
         (the rule's own words: the model shows only that nothing else
         enforces it).
  KEYS   the settings record keeps standbys >= copies (the cross-key check's
         own words).
  ROLL   AG EF: calm steps reach a state where every machine runs hash 2,
         serves, and the record allows only hash 2 (the roll finishes).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

S = 3
FIELDS = ('code', 'serving', 'allowed', 'gate', 'gview', 'keys', 'alters', 'late')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()
GROUPS = ('H', 'G')


def _put(t, i, v):
    t = list(t)
    t[i] = v
    return tuple(t)


class Catalog:
    CALM = ('deliver', 'tick', 'time', 'control')
    INFO = ()

    def __init__(self, bound):
        self.b = bound
        self.gatestep = bound.get('gate', True)
        self.kbudget = bound.get('keys', 1)

    def init(self):
        return ((1,) * S, frozenset(range(S)), frozenset([1]), 'open', ('open', 'open'), (2, 3), 0, False)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[x] for x in FIELDS)

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return tuple(d[x] for x in FIELDS)

    def commits(self, st):
        return 2 * len(st[IX['serving']]) > S

    # ---- world
    def world(self, st):
        out = []
        code, serving = st[0], st[1]
        # a roll restarts one machine with hash 2, only while every other copy serves
        for m in range(S):
            if code[m] == 1 and all(x in serving for x in range(S) if x != m):
                out.append((('roll', m), 'control', self._set(st, code=_put(code, m, 2), serving=serving - {m})))
        # the operator sets the read-only gate (an entry in the home log)
        if self.gatestep and st[IX['gate']] == 'open' and self.commits(st):
            out.append((('close',), 'control', self._set(st, gate='ro')))
        # each group follows the home log and applies the gate
        for i, g in enumerate(GROUPS):
            if st[IX['gview']][i] != st[IX['gate']]:
                out.append((('follow', g), 'deliver', self._set(st, gview=_put(st[IX['gview']], i, st[IX['gate']]))))
        return out

    # ---- properties
    def check(self, st):
        bad = []
        if any(st[0][m] not in st[IX['allowed']] for m in st[1]):
            bad.append('CAT3')
        if not self.commits(st):
            bad.append('AVAIL')
        c, sb = st[IX['keys']]
        if sb < c:
            bad.append('KEYS')
        if st[IX['late']]:
            bad.append('GATE')
        return bad

    def check_edge(self, s, lab, kind, t):
        return []

    def goals(self, st):
        return {'ROLL': st[IX['allowed']] == frozenset([2]) and all(c == 2 for c in st[0])
                and len(st[1]) == S}

    def judged(self, st):
        return {'ROLL': True}

    # ---- the rules (counted)
    def actions(self):
        def joins(w, st):
            for m in range(S):
                if m not in st[1]:
                    yield {'m': m}

        def serve(w, st, b, d):
            d.f['serving'] = st[1] | {b['m']}

        def adds(w, st):
            if 2 not in st[IX['allowed']] and w.commits(st):
                yield {}

        def add2(w, st, b, d):
            d.f['allowed'] = st[IX['allowed']] | {2}

        def rms(w, st):
            if 1 in st[IX['allowed']] and w.commits(st):
                yield {}

        def rm1(w, st, b, d):
            d.f['allowed'] = d.f['allowed'] - {1}

        def stopold(w, st, b, d):
            al = d.f['allowed']
            d.f['serving'] = frozenset(m for m in d.f['serving'] if st[0][m] in al)

        def writes(w, st):
            if w.commits(st):
                for g in GROUPS:
                    yield {'g': g}

        def wr(w, st, b, d):
            # a write changes rows, not the record; the ghost marks a write in a
            # group that had applied the read-only gate
            if st[IX['gview']][GROUPS.index(b['g'])] == 'ro':
                d.f['late'] = True

        def keyset(w, st):
            if st[IX['alters']] >= w.kbudget or not w.commits(st):
                return
            c, sb = st[IX['keys']]
            for k in (0, 1):
                for v in (1, 2, 3):
                    if v != st[IX['keys']][k]:
                        yield {'k': k, 'v': v}

        def setk(w, st, b, d):
            d.f['keys'] = _put(st[IX['keys']], b['k'], b['v'])
            d.f['alters'] = st[IX['alters']] + 1

        def after_keys(st, b):
            ks = _put(st[IX['keys']], b['k'], b['v'])
            return ks[1] - ks[0]

        return [
            Action('join', 'deliver', joins, [
                Guard('code', lambda w, st, b: st[0][b['m']] in st[IX['allowed']], role='catalog',
                      note="a server becomes a full copy only if it runs an allowed code hash (rule 3; rule 1's code part)"),
            ], [Update('serve', serve, role='world', note='it joins and serves (pinned)')]),
            Action('alteradd', 'control', adds, [], [
                Update('entry', add2, role='catalog',
                       note='an alter adds the new code hash by an entry in the home log (rule 2)'),
            ]),
            Action('alterrm', 'control', rms, [
                Cmp('after', lambda w, st, b: len(st[IX['allowed']]), '>', lambda w, st, b: 1, role='catalog',
                    note='the old hash is removed only after the new one is in (rule 2)'),
                Guard('rolled', lambda w, st, b: all(st[0][m] != 1 for m in st[1]), role='catalog',
                      note='... and after the roll: no serving copy runs it (rule 2)'),
            ], [
                Update('entry', rm1, role='catalog', note='the removal is an entry in the home log (rule 2)'),
                Update('stopold', stopold, role='world',
                       note='a copy whose hash is no longer allowed is refused at its next HELLO (pinned)'),
            ]),
            Action('write', 'deliver', writes, [
                Guard('gate', lambda w, st, b: st[IX['gview']][GROUPS.index(b['g'])] == 'open', role='catalog',
                      note='while the write gate is read-only, every group refuses every write (rule 5)'),
            ], [Update('w', wr, role='world', note='a client write commits (pinned)')]),
            Action('alterkey', 'control', keyset, [
                Cmp('consistent', lambda w, st, b: after_keys(st, b), '>=', lambda w, st, b: 0, role='catalog',
                    note="an alter's keys are checked against each other: standbys >= copies (high rule 6)"),
            ], [Update('entry', setk, role='world', note='the key change, an entry in the home log (pinned)')]),
        ]


OPTIONS = {'design': Catalog}
PINNED = {'design': ('join.serve', 'alterrm.stopold', 'write.w', 'alterkey.entry')}

BOUNDS = {
    # the roll, the gate, one key change
    'roll': dict(gate=True, keys=1),
    # the roll and two key changes, no gate
    'keys2': dict(gate=False, keys=2),
}
SWEEP = ('roll',)
VERIFY = ('keys2',)
VERIFY_PASS1 = True
