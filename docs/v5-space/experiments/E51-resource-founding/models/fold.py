"""
fold.py: v4's directory host learns who is up from a published peer table.
E-51.

v4's #directory host (api/directory.ts, hostMethods: lines 206-300) drops a
registrant's entries when the registrant is no longer up in the host's
published `cluster.peers` row, read after the host's fold. A registrant
the host has never published as up is not dropped at once: it gets GRACE
cleanup passes (simplicity.json soft-directory high rule 14), because its
register can be handled in the window before its HELLO's fold publishes it.
A register runs a cleanup pass at once, so its caller is marked seen from
its first entry (rule 12, the fix of v4's I-34: before it, a second
server's clean leave sat out the GRACE budget while lookups handed out its
dead address, because no later fold ever came).

THE WORLD (not counted). One host; two registrants (servers A and B),
each with a link that is up or down. A link event (open or close) makes the
host fold once: it publishes every link's state, then runs a cleanup pass.
A registrant registers its entry once on each new link (v4: on link-up);
its register may be handled before or after the fold that publishes its
link (the race the grace covers), but the host runs a pending fold before
it handles the next link event (v4's afterFold microtask runs before any
socket callback). Faults (budget): a link closes (a clean leave or a crash).
RECOVER (free): a registrant dials again. GRACE = 3 passes, as v4
(api/directory.ts:199; the first version of this model had 2).

The cleanup pass (pinned, v4's onPeers): an owner published up is marked
seen; a seen owner not up is forgotten (its entries go); an unseen owner
not up waits one more pass.

PROPERTIES
  REBUILD  AG EF: calm steps reach a state where the table holds exactly
           the entries of registrants whose link is up.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

R = 2
GRACE = 3                   # v4: api/directory.ts:199
FIELDS = ('link', 'want', 'pub', 'pend', 'ent', 'seen', 'grace', 'faults')
IX = {f: i for i, f in enumerate(FIELDS)}


def _put(t, i, v):
    t = list(t)
    t[i] = v
    return tuple(t)


class Fold:
    CALM = ('deliver', 'tick', 'time')
    INFO = ()

    def __init__(self, bound):
        self.budget = bound['faults']

    def init(self):
        return ((False,) * R, (False,) * R, (False,) * R, False, (False,) * R, (False,) * R, (0,) * R, 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[x] for x in FIELDS)

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return tuple(d[x] for x in FIELDS)

    def world(self, st):
        out = []
        link, f = st[0], st[IX['faults']]
        if st[IX['pend']]:
            return out          # the host's fold (a microtask) runs before it handles the next socket event
        for r in range(R):
            if not link[r]:
                out.append((('dial', r), 'recover' if f else 'deliver',
                            self._set(st, link=_put(link, r, True), want=_put(st[IX['want']], r, True), pend=True)))
            elif f < self.budget:
                out.append((('close', r), 'fault', self._set(st, link=_put(link, r, False), want=_put(st[IX['want']], r, False),
                                                              pend=True, faults=f + 1)))
        return out

    def check(self, st):
        return []

    def check_edge(self, s, lab, kind, t):
        return []

    def goals(self, st):
        return {'REBUILD': all(st[IX['ent']][r] == st[0][r] for r in range(R))}

    def judged(self, st):
        return {'REBUILD': True}

    def actions(self):
        def regs(w, st):
            for r in range(R):
                if st[0][r] and st[IX['want']][r]:
                    yield {'r': r}

        def entry(w, st, b, d):
            d.f['ent'] = _put(d.f['ent'], b['r'], True)
            d.f['want'] = _put(d.f['want'], b['r'], False)     # a registrant registers once per link

        def passnow(w, st, b, d):
            r = b['r']
            if d.f['pub'][r]:
                d.f['seen'] = _put(d.f['seen'], r, True)
                d.f['grace'] = _put(d.f['grace'], r, 0)
            elif not d.f['seen'][r]:
                d.f['grace'] = _put(d.f['grace'], r, min(GRACE, d.f['grace'][r] + 1))

        def folds(w, st):
            if st[IX['pend']]:
                yield {}

        def publish(w, st, b, d):
            d.f['pub'] = st[0]
            d.f['pend'] = False

        def clean(w, st, b, d):
            ent, seen, grace, pub = list(d.f['ent']), list(d.f['seen']), list(d.f['grace']), d.f['pub']
            for r in range(R):
                if not ent[r]:
                    continue
                if pub[r]:
                    seen[r], grace[r] = True, 0
                elif seen[r]:
                    ent[r], seen[r], grace[r] = False, False, 0
                else:
                    grace[r] = min(GRACE, grace[r] + 1)
            d.f['ent'], d.f['seen'], d.f['grace'] = tuple(ent), tuple(seen), tuple(grace)

        def unseen(w, st):
            for r in range(R):
                if st[IX['ent']][r] and not st[IX['seen']][r] and not st[IX['pub']][r]:
                    yield {'r': r}

        def forget(w, st, b, d):
            r = b['r']
            d.f['ent'] = _put(d.f['ent'], r, False)
            d.f['grace'] = _put(d.f['grace'], r, 0)

        return [
            Action('register', 'deliver', regs, [], [
                Update('entry', entry, role='world', note='the host stores the entry (pinned)'),
                Update('pass', passnow, role='softdir',
                       note='a register runs a cleanup pass at once, so its caller is seen from its first entry (rule 12)'),
            ]),
            Action('fold', 'deliver', folds, [], [
                Update('publish', publish, role='world', note="the host's fold publishes the peer table (pinned)"),
                Update('clean', clean, role='world', note='the cleanup pass on every fold (pinned)'),
            ]),
            Action('forget', 'deliver', unseen, [
                Cmp('grace', lambda w, st, b: st[IX['grace']][b['r']], '>=', lambda w, st, b: GRACE, role='softdir',
                    note='a registrant never published as up survives GRACE passes before it is dropped (high rule 14)'),
            ], [Update('drop', forget, role='world', note='its entries go (pinned)')]),
        ]


OPTIONS = {'v4': Fold}
PINNED = {'v4': ('register.entry', 'fold.publish', 'fold.clean', 'forget.drop')}

BOUNDS = {
    'f1': dict(faults=1),
    'f2': dict(faults=2),
    'f3': dict(faults=3),
}
SWEEP = ('f1', 'f2')
VERIFY = ('f3',)
VERIFY_PASS1 = True
