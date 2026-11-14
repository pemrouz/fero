"""
incarnation.py: an operator recovery, and old copies that must stop. E-51.

DESIGN-V5 4.2 "Operator recovery": `fero recover --unclean` forces a
group's config onto one surviving copy and bumps the group's incarnation;
"if the 'lost' majority was only partitioned, it may still elect under the
old incarnation. Its leader learns the bump ... when it can reach it, and
stops". With no #meta, the bump lives in the resource's home log, and for
the home group itself in its own log and its members' HELLO.
simplicity.json meta-directory@per-resource rules 3 (an operator recovery
raises the group's incarnation in its record; for the home group itself,
in its own log and in its members' HELLO) and 4 (a leader or copy that sees
a higher incarnation for its own group, in the home log or in a peer's
HELLO, stops and comes back as a new copy).

THE WORLD (not counted). One group X with copies on machines 0, 1, 2, each
up or down, on side 0 or 1; each copy holds X at an incarnation. Faults
cut copies 1 and 2 off (to side 1, where they are still a majority of X's
old config and can elect under the old incarnation) or crash a machine.
The operator recovers X on copy 0 once, when copy 0 cannot reach a majority
(a control step; its own refusals are the recovery command's rules, not
counted here). Two bounds: X is a data group, whose record lives in the
home group's log, readable from side 0 (the home group is healthy and on
side 0 here); or X is the home group itself, which has no other log to
read: old copies can learn the bump only from a HELLO.

PROPERTIES
  INC   AG EF: from every state where every machine that is up is on side 0
        (the cut has healed), calm steps reach a state where no live copy
        of X still serves under an old incarnation (each has stopped and
        come back as a new copy): only the recovered copy serves X as it
        was, and it still does if it is up (and with no recovery, every live
        copy serves: none stops for nothing). For the home group, judged
        only while the recovered copy is up:
        with it down, an old copy has nothing to learn the bump from (the
        residual case DESIGN-V5 accepts; the run without this condition
        shows it in 5 steps). The `home3e` and `data3e` probes judge INC only
        where two old copies are up together on one side (enough to elect
        under the old incarnation) and the recovered copy is down.

"Serving" here means "up and not stopped": the model has no elections, so
one old copy up alone cannot lead or commit; two can (a majority of the
old three).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

S = 3
NEW = 'new'                 # stopped, and back as a new (empty) copy of the current incarnation
FIELDS = ('up', 'side', 'inc', 'cur', 'rec', 'recov', 'faults')
IX = {f: i for i, f in enumerate(FIELDS)}


def _put(t, i, v):
    t = list(t)
    t[i] = v
    return tuple(t)


class Incarnation:
    CALM = ('deliver', 'tick', 'time')
    INFO = ()

    def __init__(self, bound):
        self.b = bound
        self.home = bound.get('home', False)
        self.budget = bound['faults']
        self.kinds = set(bound.get('kinds', ('cut', 'crash')))

    def init(self):
        return ((True,) * S, (0,) * S, (0,) * S, 0, 0, False, 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[x] for x in FIELDS)

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return tuple(d[x] for x in FIELDS)

    def serving(self, st, x):
        i = st[2][x]
        return st[0][x] and i != NEW

    # ---- world
    def world(self, st):
        out = []
        up, side, f = st[0], st[1], st[IX['faults']]
        for m in range(S):
            if f < self.budget:
                if 'crash' in self.kinds and up[m]:
                    out.append((('crash', m), 'fault', self._set(st, up=_put(up, m, False), faults=f + 1)))
                if 'cut' in self.kinds and up[m] and side[m] == 0 and m != 0:
                    out.append((('cut', m), 'fault', self._set(st, side=_put(side, m, 1), faults=f + 1)))
            if not up[m]:
                out.append((('start', m), 'recover', self._set(st, up=_put(up, m, True))))
            if side[m] == 1:
                out.append((('heal', m), 'recover', self._set(st, side=_put(side, m, 0))))
        return out

    # ---- properties
    def check(self, st):
        return []

    def check_edge(self, s, lab, kind, t):
        return []

    def goals(self, st):
        # after a recovery, only the recovered copy (0) serves X as it was;
        # every other live copy has stopped and come back as a new copy
        up = st[0]
        if not st[IX['recov']]:
            return {'INC': all(self.serving(st, x) for x in range(S) if up[x])}     # nobody stops for nothing
        return {'INC': (not up[0] or self.serving(st, 0)) and
                all(not self.serving(st, x) for x in range(1, S))}

    def judged(self, st):
        healed = all(st[1][x] == 0 for x in range(S) if st[0][x])
        if self.home and st[IX['recov']] and not self.b.get('strict'):
            # the home group has no other log: an old copy can learn the bump
            # only from the recovered copy (DESIGN-V5's residual case: two
            # homes until it comes back)
            healed = healed and self.serving(st, 0)
        if self.b.get('elect'):
            old = [x for x in range(1, S) if self.serving(st, x) and st[1][x] == 0]
            healed = healed and st[IX['recov']] and not st[0][0] and len(old) >= 2
        return {'INC': healed}

    # ---- the rules (counted)
    def actions(self):
        def recs(w, st):
            up, side = st[0], st[1]
            if st[IX['recov']] or not up[0]:
                return
            reach = sum(1 for x in range(S) if up[x] and side[x] == side[0])
            if 2 * reach <= S:                 # copy 0 cannot reach a majority: the operator's case
                yield {}

        def force(w, st, b, d):
            d.f['cur'] = st[IX['cur']] + 1     # the operator's truth (a ghost) and the forced config
            d.f['recov'] = True

        def raise_(w, st, b, d):
            d.f['inc'] = _put(d.f['inc'], 0, st[IX['cur']] + 1)

        def record(w, st, b, d):
            if not w.home:
                d.f['rec'] = st[IX['cur']] + 1

        def logs(w, st):
            if w.home:
                return                         # the home group has no other log to read
            for x in range(S):
                if w.serving(st, x) and st[1][x] == 0:     # the home log is read from side 0
                    yield {'x': x}

        def hellos(w, st):
            for x in range(S):
                for y in range(S):
                    if x != y and w.serving(st, x) and w.serving(st, y) and st[1][x] == st[1][y]:
                        yield {'x': x, 'y': y}

        def stop(w, st, b, d):
            d.f['inc'] = _put(d.f['inc'], b['x'], NEW)

        return [
            Action('recover', 'control', recs, [], [
                Update('force', force, role='world', note='the operator forces X onto copy 0 (pinned)'),
                Update('raise', raise_, role='records',
                       note="the recovery raises X's incarnation, which X's HELLO carries (rule 3)"),
                Update('record', record, role='records',
                       note="... and in X's record in the home log (rule 3; the home group has no other log)"),
            ]),
            Action('logstop', 'deliver', logs, [
                Cmp('higher', lambda w, st, b: st[IX['rec']], '>', lambda w, st, b: st[2][b['x']], role='records',
                    note='a copy that sees a higher incarnation for its group in the home log ... (rule 4)'),
            ], [Update('stop', stop, role='records', note='... stops and comes back as a new copy (rule 4)')]),
            Action('hellostop', 'deliver', hellos, [
                Cmp('higher', lambda w, st, b: st[2][b['y']], '>', lambda w, st, b: st[2][b['x']], role='records',
                    note="a copy that sees a higher incarnation in a peer's HELLO ... (rule 4)"),
            ], [Update('stop', stop, role='records', note='... stops and comes back as a new copy (rule 4)')]),
        ]


OPTIONS = {'design': Incarnation}
PINNED = {'design': ('recover.force',)}

BOUNDS = {
    # a data group: cut copies 1 and 2, then a crash
    'data3': dict(home=False, faults=3),
    # the home group itself: cut copies 1 and 2, then a crash
    'home3': dict(home=True, faults=3),
    # a data group, two faults
    'data2': dict(home=False, faults=2),
    # a probe: the home group, judged even while the recovered copy is down
    'home3s': dict(home=True, faults=3, strict=True),
    # probes: judged only where two old copies are up together and the recovered copy is down
    'home3e': dict(home=True, faults=3, strict=True, elect=True),
    'data3e': dict(home=False, faults=3, strict=True, elect=True),
}
SWEEP = ('data2', 'home3')
VERIFY = ('data3',)
VERIFY_PASS1 = True
