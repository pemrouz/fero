"""
place.py: healing finds machines through the soft directory; a leaving
machine retires first. E-51.

With no #meta there is no member list every leader shares (simplicity.json
healing-self@per-resource, rule 15's note). A group's leader knows of a
machine outside its group only from the soft directory's machine entries
(soft-directory rule 2: "a server also announces itself as a machine, with
its room and the code it can run, so a leader can find a machine for a new
copy"). meta-members@per-resource: a leaving server marks itself retiring
first: it takes its machine entry out of the directory and refuses to
become a new copy (rule 1); healing never adds a copy on a machine that
said it is retiring (rule 2); and, in the record's high count, a retiring
voter is left to its own leave, so only one of the leave and healing adds
a replacement (rule 3). meta-catalog@per-resource rule 3: a server becomes
a full copy only if it can run one of the resource's allowed code hashes.

THE WORLD (not counted). Four machines, each up or down. One resource
whose group keeps two copies (the target; a swap holds three between its
two steps, as E-16's three-to-four). The group's leader is any live copy
(Raft, abstract). A soft directory of machine entries: an entry appears
when a machine announces itself, and outlives a dead machine until the
failure detector drops it (a `time` step), so the leader can read a stale
entry. Healing (E-16's `self` rules, pinned): when a copy is down, add a
replacement from the machines the leader knows of, then remove the dead
copy; one change at a time. A leave (control step, Ctrl-C): the leaver
retires, its leave adds a replacement for its own copy once, then removes
it, or removes it at once if no replacement exists (DESIGN-V5 4.2
"Leaving": a leave may lower a count; healing tops it up later). A
retiring machine that crashes is simply down: healing replaces it. A bound may mark one machine unable to run
the resource's code.

A ghost records which machines are leaving (the Ctrl-C itself), apart
from the retiring mark the rules set, so a property never reads the state
of the rule it judges; the leave's own steps (pinned) follow the ghost.

FAULTS (budget): crash (a leaving machine that crashes stays down: its
leave is over). RECOVER (free): start. CALM: deliver, tick, time.

PROPERTIES
  P3    the group never holds more than three copies (E-16's P3: target + 1
        between a swap's two steps; the leave and healing must not both add
        a replacement for a leaver).
  P7    no step adds a copy on a leaving machine (healing.py round 2's P7,
        which E-16 could not ask: it had no leave).
  CAT3  every copy is on a machine that can run the resource's code.
  HEAL  AG EF: from every state where a copy is down, a copy is live, and
        at least two machines are up, not retiring and able to run the code,
        calm steps reach exactly two copies, both live and not retiring
        (E-16's P8, shortened).
  LEAVE AG EF: the same goal, from every state where a live retiring
        machine holds a copy (so its leave ends with no copy on it).
  P9    no more than 6 changes to the group without an outside event (no
        churn). E-16's P9 allows 8; a bound may set `churn`.

The `stale` option is a probe (skeptic F4): the leader reads the machine
entries in one step and adds later, from what it read, so its read can
come before a leaver's directory exit, as a soft directory's answers can.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

S = 4
TARGET = 2
CHURN = 6
FIELDS = ('up', 'copies', 'ment', 'ret', 'leaving', 'ladded', 'forold', 'chg', 'leaves', 'faults')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()


def _put(t, i, v):
    t = list(t)
    t[i] = v
    return tuple(t)


class Place:
    CALM = ('deliver', 'tick', 'time')
    INFO = ()

    def __init__(self, bound):
        self.b = bound
        self.budget = bound['faults']
        self.lbudget = bound.get('leaves', 1)
        self.nocode = set(bound.get('nocode', ()))
        self.churn = bound.get('churn', CHURN)

    def init(self):
        return ((True,) * S, frozenset((0, 1)), E, E, E, E, E, 0, 0, 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return self._norm(d.f)

    def _norm(self, f):
        # the ghost keeps a replacement pair only while both copies are in the group
        cp = f['copies']
        f['forold'] = frozenset((o, m) for (o, m) in f['forold'] if o in cp and m in cp)
        return tuple(f[x] for x in FIELDS)

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return self._norm(d)

    def ok(self, m):
        return m not in self.nocode

    def leader(self, st):
        return any(st[0][m] for m in st[IX['copies']])

    def spare(self, st):
        """A valid replacement exists: up, not retiring, able to run the code, no copy."""
        return any(st[0][m] and m not in st[IX['leaving']] and self.ok(m) and m not in st[IX['copies']]
                   for m in range(S))

    # ---- world
    def world(self, st):
        out = []
        up, cp, ment, ret = st[0], st[1], st[2], st[3]
        lv = st[IX['leaving']]
        f = st[IX['faults']]
        for m in range(S):
            if up[m] and f < self.budget:
                out.append((('crash', m), 'fault', self._set(st, up=_put(up, m, False), faults=f + 1, chg=0)))
            if not up[m] and m not in lv:
                out.append((('start', m), 'recover', self._set(st, up=_put(up, m, True), chg=0)))
            if m in ment and not up[m]:
                out.append((('expire', m), 'time', self._set(st, ment=ment - {m})))
        chg = min(self.churn + 1, st[IX['chg']] + 1)
        if self.leader(st):
            # healing removes a dead copy once its replacement is in (E-16's remove, pinned)
            if len(cp) >= TARGET + 1:
                for old in cp:
                    if not up[old]:
                        out.append((('remove', old), 'deliver', self._set(st, copies=cp - {old}, chg=chg)))
            # the leave removes the leaver once its replacement is in, or at
            # once if none can be found (a leave may lower a count; healing
            # tops it up later: DESIGN-V5 4.2 "Leaving"; pinned)
            for old in cp:
                if up[old] and old in lv and (old in st[IX['ladded']] or not self.spare(st)
                                              or len(cp - {old}) >= TARGET):
                    out.append((('lremove', old), 'deliver', self._set(st, copies=cp - {old}, chg=chg)))
            # surplus: with more than the target and none down or retiring,
            # healing removes the copy its stored placement leaves out (E-16's
            # surplus, pinned; any one here)
            if len(cp) > TARGET and all(up[m] and m not in lv for m in cp):
                for old in cp:
                    out.append((('surplus', old), 'deliver', self._set(st, copies=cp - {old}, chg=chg)))
        return out

    # ---- properties
    def check(self, st):
        bad = []
        if len(st[1]) > TARGET + 1:
            bad.append('P3')
        if any(not self.ok(m) for m in st[1]):
            bad.append('CAT3')
        if st[IX['chg']] > self.churn:
            bad.append('P9')
        return bad

    def check_edge(self, s, lab, kind, t):
        bad = []
        if lab[0] == 'add':
            b = dict(lab[1])
            if b['m'] in s[IX['leaving']]:
                bad.append('P7')

        return bad

    def goals(self, st):
        up, cp, lv = st[0], st[1], st[IX['leaving']]
        live = sum(1 for m in cp if up[m] and m not in lv)
        heal = live >= TARGET and len(cp) == TARGET
        leave = heal and not any(m in lv for m in cp)
        return {'HEAL': heal, 'LEAVE': leave}

    def judged(self, st):
        up, cp, lv = st[0], st[1], st[IX['leaving']]
        valid = sum(1 for m in range(S) if up[m] and m not in lv and self.ok(m))
        sp = valid >= TARGET and self.leader(st)
        return {'HEAL': sp and any(not up[m] for m in cp),
                'LEAVE': sp and any(up[m] and m in lv for m in cp)}

    # ---- the rules (counted)
    def actions(self):
        def ups(w, st):
            for m in range(S):
                if st[0][m] and m not in st[IX['ment']]:
                    yield {'m': m}

        def madd(w, st, b, d):
            d.f['ment'] = d.f['ment'] | {b['m']}

        def leavers(w, st):
            if st[IX['leaves']] >= w.lbudget:
                return
            for m in range(S):
                if st[0][m] and m not in st[IX['leaving']]:
                    yield {'m': m}

        def mark(w, st, b, d):
            d.f['ret'] = d.f['ret'] | {b['m']}

        def exit_(w, st, b, d):
            d.f['ment'] = d.f['ment'] - {b['m']}

        def count(w, st, b, d):
            d.f['leaves'] = st[IX['leaves']] + 1
            d.f['leaving'] = st[IX['leaving']] | {b['m']}     # a ghost: this machine is leaving (Ctrl-C)
            d.f['chg'] = 0

        def adds(w, st):
            if not w.leader(st):
                return
            up, cp, ret = st[0], st[1], st[3]
            for m in st[IX['ment']]:            # the leader knows a machine only from its machine entry
                if m in cp:
                    continue
                # healing: a swap starts from the target, for a copy that is
                # down, or (DESIGN-V5: a voter not in the target) retiring
                if len(cp) == TARGET:
                    for old in cp:
                        if not up[old] or old in ret:
                            yield {'why': 'heal', 'old': old, 'm': m}
                # healing grows a group a leave left below the target
                if len(cp) < TARGET:
                    yield {'why': 'heal', 'old': None, 'm': m}
                # the leave adds a replacement for the leaver's own copy, once,
                # if the count would not hold without it (DESIGN-V5: it
                # promotes a learner "so the voter count holds")
                for old in cp:
                    if up[old] and old in st[IX['leaving']] and old not in st[IX['ladded']] and len(cp - {old}) < TARGET:
                        yield {'why': 'leave', 'old': old, 'm': m}

        def put(w, st, b, d):
            d.f['copies'] = st[1] | {b['m']}
            d.f['chg'] = min(w.churn + 1, st[IX['chg']] + 1)
            if b['why'] == 'leave':
                d.f['ladded'] = st[IX['ladded']] | {b['old']}


        return [
            Action('mannounce', 'deliver', ups, [
                Guard('notret', lambda w, st, b: b['m'] not in st[IX['ret']], role='members',
                      note='a retiring machine never announces itself again (rule 1: its machine entry stays out)'),
            ], [Update('add', madd, role='softdir',
                       note='a server announces itself as a machine, with the code it can run (rule 2)')]),
            Action('leave', 'control', leavers, [], [
                Update('mark', mark, role='members', note='a leaving server marks itself retiring first (rule 1)'),
                Update('exit', exit_, role='members', note='it takes its machine entry out of the directory (rule 1)'),
                Update('count', count, role='world', note='the leave starts (a ghost) and a bound on leaves (pinned)'),
            ]),
            Action('add', 'deliver', adds, [
                Guard('live', lambda w, st, b: st[0][b['m']], role='heal',
                      note="add only a machine the leader's own link reaches (healing-self's high rule add.cand)"),
                Guard('code', lambda w, st, b: w.ok(b['m']), role='catalog',
                      note="a server becomes a copy only if it can run one of the resource's allowed code hashes (rule 3)"),
                Guard('refuse', lambda w, st, b: b['m'] not in st[IX['ret']], role='members',
                      note='a retiring server refuses to become a new copy (rule 1; healing never adds it, rule 2)'),
                Guard('own', lambda w, st, b: b['why'] == 'leave' or b['old'] is None or b['old'] not in st[IX['ret']]
                      or not st[0][b['old']],
                      role='members', note='a live retiring copy is left to its own leave (high rule 3)'),
            ], [Update('put', put, role='heal', note='the add, a config entry (pinned: E-16)')]),
        ]


class Stale(Place):
    """The probe of skeptic F4: the leader's view of the machine entries is
    a copy taken at a `read` step (a world step), and its adds pick from
    that copy, not from the live table."""

    def init(self):
        return super().init() + (E,)

    def to_draft(self, st):
        d = dict(zip(FIELDS, st[:len(FIELDS)]))
        d['seen'] = st[len(FIELDS)]
        return d

    def _norm(self, f):
        return super()._norm(f) + (f.get('seen', E),)

    def world(self, st):
        out = list(super().world(st))
        if st[-1] != st[IX['ment']]:
            out.append((('read',), 'deliver', self._set(st, seen=st[IX['ment']])))
        return out

    def actions(self):
        acts = super().actions()
        add = [a for a in acts if a.name == 'add'][0]
        orig = add.params

        def params(w, st):
            fake = list(st[:len(FIELDS)])
            fake[IX['ment']] = st[-1]           # pick from the leader's last read of the directory
            yield from orig(w, tuple(fake))
        add.params = params
        return acts


OPTIONS = {'design': Place, 'stale': Stale}
PINNED = {k: ('leave.count', 'add.put') for k in OPTIONS}

BOUNDS = {
    # four machines, copies on 0 and 1; one crash; one leave
    'p1': dict(faults=1, leaves=1),
    # machine 3 cannot run the resource's code
    'p1n': dict(faults=1, leaves=1, nocode=(3,)),
    # two crashes, one leave
    'p2': dict(faults=2, leaves=1),
    # two crashes, two leaves, machine 3 without the code
    'p2n': dict(faults=2, leaves=2, nocode=(3,)),
    # a probe bound: p1 with E-16's P9 limit of 8 changes
    'p1c8': dict(faults=1, leaves=1, churn=8),
    'p1nc8': dict(faults=1, leaves=1, nocode=(3,), churn=8),
    'p2c8': dict(faults=2, leaves=1, churn=8),
    'p2nc8': dict(faults=2, leaves=2, nocode=(3,), churn=8),
}
SWEEP = ('p1', 'p1n')
VERIFY = ('p2', 'p2n')
VERIFY_PASS1 = True
