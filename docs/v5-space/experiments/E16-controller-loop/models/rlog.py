"""
rlog.py: RLOG's case for E-16. The group's log is kept by log members (one
Raft group, taken as always able to commit here); a server is the group's
writer by holding a writer epoch committed in that log, and the controller
on #meta's leader hands the writer role over. "One more guard on every
append": the log group's leader takes a client append only if it carries
the latest committed writer epoch (Kafka's producer epochs, BookKeeper's
ledger fencing, Neon's terms on safekeepers; SPACE R `rlog`).

THE WORLD (not counted). Two servers that can be the writer, each up or
down and linked to #meta or cut off from it (a cut-off server still reaches
the log members: the dangerous case). #meta up or down. The log: writer
epoch entries ('we', server, epoch) and client writes ('w', server, epoch,
base), where base is how much of the log the server had folded when it
judged the write. The first writer is server 0, epoch 1.

FAULTS: crash a server, cut a server off from #meta, #meta down.
RECOVER: free.

PROPERTIES
  RL1  one writer: every committed write carries the epoch of the latest
       writer entry before it, and comes from that entry's server.
  RL2  no stale judgement: every committed write was judged on the whole
       log before it (base = its position - 1), so no update is lost.
  RL3  AG EF: from every state where #meta is up and some server is up and
       linked, calm steps reach a state where a write commits.
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

FIELDS = ('srv', 'meta', 'log', 'wep', 'fold', 'faults', 'nw')
IX = {f: i for i, f in enumerate(FIELDS)}
NS = 2


class Rlog:
    CALM = ('deliver', 'time')
    INFO = ()

    def __init__(self, bound):
        self.b = bound
        self.budget = bound['faults']

    def init(self):
        srv = tuple((True, True) for _ in range(NS))       # (up, linked to #meta)
        log = (('we', 0, 1),)
        return (srv, True, log, (1, 0), (1, 0), 0, 0)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[f] for f in FIELDS)

    @staticmethod
    def cur(st):
        """The latest committed writer entry: (server, epoch)."""
        for e in reversed(st[IX['log']]):
            if e[0] == 'we':
                return e[1], e[2]
        return None, 0

    def world(self, st):
        out = []
        srv, meta, log, wep, fold, faults, nw = st
        for s in range(NS):
            up, link = srv[s]
            if faults < self.budget:
                if up:
                    out.append((('crash', s), 'fault', self._srv(st, s, (False, link), 1)))
                if link:
                    out.append((('cut', s), 'fault', self._srv(st, s, (up, False), 1)))
            if not up:
                # a restart loses the server's memory: it reloads its fold
                # from the log as it rejoins (wep and fold are its own state)
                out.append((('recover', s), 'recover', self._srv(st, s, (True, link), 0)))
            if not link:
                out.append((('heal', s), 'recover', self._srv(st, s, (up, True), 0)))
        if faults < self.budget and meta:
            out.append((('meta-down',), 'fault', self._set(st, meta=False, faults=faults + 1)))
        if not meta:
            out.append((('meta-up',), 'recover', self._set(st, meta=True)))
        return out

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return tuple(d[f] for f in FIELDS)

    def _srv(self, st, s, v, f):
        srv = list(st[0])
        srv[s] = v
        return self._set(st, srv=tuple(srv), faults=st[IX['faults']] + f)

    def check(self, st):
        bad = []
        log = st[IX['log']]
        cw, ce = None, 0
        for i, e in enumerate(log):
            if e[0] == 'we':
                cw, ce = e[1], e[2]
            else:
                if e[1] != cw or e[2] != ce:
                    if 'RL1' not in bad:
                        bad.append('RL1')
                if e[3] != i:
                    if 'RL2' not in bad:
                        bad.append('RL2')
        return bad

    def check_edge(self, s, lab, kind, t):
        return []

    def goals(self, st):
        return {'RL3': st[IX['nw']] > 0 and st[IX['log']][-1][0] == 'w'}

    def judged(self, st):
        return {'RL3': st[IX['meta']] and any(u and l for u, l in st[IX['srv']])
                and st[IX['nw']] < self.b['writes']}

    def actions(self):
        def servers(w, st):
            for s in range(NS):
                if st[0][s][0]:
                    yield {'s': s}

        def handover_servers(w, st):
            if not st[IX['meta']]:
                return                       # no #meta leader, no controller
            for s in range(NS):
                yield {'s': s}

        def h_append(w, st, b, d):
            cw, ce = w.cur(st)
            d.f['log'] = st[IX['log']] + (('we', b['s'], ce + 1),)

        def t_wep(w, st, b, d):
            wep = list(d.f['wep'])
            wep[b['s']] = w.cur(st)[1]
            d.f['wep'] = tuple(wep)

        def t_fold(w, st, b, d):
            fold = list(d.f['fold'])
            fold[b['s']] = len(st[IX['log']])
            d.f['fold'] = tuple(fold)

        def w_append(w, st, b, d):
            s = b['s']
            d.f['log'] = st[IX['log']] + (('w', s, st[IX['wep']][s], st[IX['fold']][s]),)
            d.f['nw'] = st[IX['nw']] + 1            # a bound counter, not a rule

        def w_fold(w, st, b, d):
            fold = list(d.f['fold'])
            fold[b['s']] = st[IX['fold']][b['s']] + 1
            d.f['fold'] = tuple(fold)

        return [
            # the controller hands the writer role over
            Action('handover', 'deliver', handover_servers, [
                Guard('gone', lambda w, st, b: not (st[0][w.cur(st)[0]][0] and st[0][w.cur(st)[0]][1]),
                      role='decide', note='the current writer is gone to the controller'),
                Guard('alive', lambda w, st, b: st[0][b['s']][0] and st[0][b['s']][1], role='decide',
                      note='the new writer is up and linked'),
                Guard('other', lambda w, st, b: b['s'] != w.cur(st)[0], role='decide'),
            ], [Update('append', h_append, role='epoch', note='commit a writer entry with the next epoch')]),
            # a server named by the latest writer entry takes the role: it
            # folds to the log end (the entry included) before it writes
            Action('takeover', 'deliver', servers, [
                Guard('named', lambda w, st, b: w.cur(st)[0] == b['s'] and st[IX['wep']][b['s']] < w.cur(st)[1],
                      role='epoch'),
            ], [Update('wep', t_wep, role='epoch'), Update('fold', t_fold, role='fold')]),
            # a writer judges a write on its fold and appends it; the log
            # group's leader checks the writer epoch on every append
            Action('write', 'deliver', servers, [
                Cmp('bound', lambda w, st, b: st[IX['nw']], '<', lambda w, st, b: w.b['writes'], role='bound'),
                Guard('holder', lambda w, st, b: st[IX['wep']][b['s']] > 0, role='epoch',
                      note='it believes it holds a writer epoch'),
                Guard('epoch', lambda w, st, b: st[IX['wep']][b['s']] == w.cur(st)[1], role='epoch',
                      note="the log's leader takes the append only with the latest committed writer epoch"),
            ], [Update('append', w_append, role='step'), Update('fold', w_fold, role='fold')]),
        ]


OPTIONS = {'rlog': Rlog}
BOUNDS = {
    'r1': dict(faults=1, writes=2),
    'r2': dict(faults=2, writes=2),
}
SWEEP = ('r1', 'r2')
VERIFY = ()
PINNED = {'rlog': ('write.bound',)}
