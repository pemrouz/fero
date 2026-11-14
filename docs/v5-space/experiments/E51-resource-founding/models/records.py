"""
records.py: a group's record in the resource's home log. E-51.

DECISIONS V5-2 (2): each resource keeps its settings and slot table as
records in its own log; V5-3: a client learns members, slot table and
leaders from the resource itself, which means from these records.
simplicity.json meta-directory@per-resource (the study's meta-directory,
moved from #meta to the home log): after each config change a group's
leader writes the group's record into the home log (rule 1); a record
names the config it describes and an older config never overwrites a
newer (rule 2); a removed copy deletes its data only once the group's
record shows the config without it (rule 5); a group's record is deleted
only after the slot table has shown none of its slots for settle.ms (rule
6) and only once its history is safe (rule 7); after the home group is
recovered from a copy that was behind, every group leader writes its
record again (rule 8). Rules 3 and 4 (incarnations) are models/incarnation.py's.

A record write can be lost: G's leader dies after G's config commits and
before H commits the record, or H's leader changes and drops the write
before it commits (skeptic F2: the first version of this model never lost
one, and every rule then held REC). So the design here adds one rule: G's
leader, which follows the home log anyway (for the gate and the code
hashes), writes its record again whenever the home log's record of G
differs from G's committed config (`resend`). The `ack` option is a probe:
the leader writes again only until it has once seen its record shown
(retry until acknowledged), so a later recovery of H from a copy that was
behind is not seen by this rule.

THE WORLD (not counted). One resource: its home group H and one data group
G. G's configs follow a fixed list of epochs (0: copies on machines 0, 1,
2; then 0, 1, 3; then 0, 3, 4): healing proposes the next one (an
uncommitted entry), which commits, or is lost when G's leader dies (a
fault). G's leader refuses a copy its newest config, committed or not,
leaves out, so that copy learns it may be removed. A record write is a
message from G's leader to H's leader, delivered in any order, as late as
it likes, or lost (a fault). A copy that holds the data at commit is taken to be caught up
(E-16's catch-up step). G's one slot may be moved to H, or back (control
steps; the slot table, a record in H's log, says where it is); settle.ms
passes after the table's last change, and G's history reaches the
object-store tier at some point (time steps). H may be recovered by the operator from a copy that was behind (a
fault): its record of G goes back to epoch 0 and its incarnation rises.
FAULTS (budget): abort (a proposal lost with G's leader), lose (a record
write lost), hrecover.

PROPERTIES
  REC   AG EF: once calm, the home log's record of G names G's committed
        config (or G is deleted and has no record): the records agree with
        what the groups hold.
  DUR   every copy in G's committed config still holds G's data (no copy
        deletes a log it is still a voter of).
  SLOT  the slot table never places a slot in a deleted group.
  HIST  a deleted group's history is in the tier (V5-1: history is read
        from the log; a deleted group's log must not take it with it).
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Cmp, Update   # noqa: E402

CFG = (frozenset((0, 1, 2)), frozenset((0, 1, 3)), frozenset((0, 3, 4)))
FIELDS = ('ce', 'pe', 'data', 'told', 'msgs', 'rec', 'hinc', 'seen', 'table', 'tset', 'tiered', 'gdel', 'merges',
          'faults', 'shown')
IX = {f: i for i, f in enumerate(FIELDS)}
E = frozenset()
GONE = 'gone'


class Records:
    CALM = ('deliver', 'tick', 'time')
    INFO = ()
    TRACK_SHOWN = False      # only the ack probe reads whether G's leader has seen its record shown

    def __init__(self, bound):
        self.b = bound
        self.budget = bound['faults']
        self.maxe = bound.get('epochs', 2)
        self.mbudget = bound.get('merge', 0)
        self.kinds = set(bound.get('kinds', ('abort', 'hrecover', 'lose')))

    def init(self):
        return (0, None, CFG[0], E, E, 0, 0, 0, 'G', True, False, False, 0, 0, True)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        if not self.TRACK_SHOWN:
            d.f['shown'] = True
        return tuple(d.f[x] for x in FIELDS)

    def _set(self, st, **kw):
        d = self.to_draft(st)
        d.update(kw)
        return tuple(d[x] for x in FIELDS)

    # ---- world
    def world(self, st):
        out = []
        ce, pe, data, told, msgs, rec = st[0], st[1], st[2], st[3], st[4], st[5]
        gdel, f = st[IX['gdel']], st[IX['faults']]
        if not gdel:
            # healing proposes the next config (an uncommitted entry)
            if pe is None and ce < self.maxe:
                out.append((('propose', ce + 1), 'deliver', self._set(st, pe=ce + 1)))
            # G's leader refuses a copy its newest config leaves out
            newest = CFG[pe if pe is not None else ce]
            for x in sorted(CFG[ce] | (CFG[pe] if pe is not None else E)):
                if x not in newest and x not in told and x in data:
                    out.append((('refuse', x), 'deliver', self._set(st, told=told | {x})))
            for x in sorted(data - CFG[ce] - told):
                out.append((('refuse', x), 'deliver', self._set(st, told=told | {x})))
            if pe is not None and f < self.budget and 'abort' in self.kinds:
                out.append((('abort', pe), 'fault', self._set(st, pe=None, faults=f + 1)))
        # a record write older than the record is dropped by H (or left)
        for e in msgs:
            if rec == GONE or (isinstance(rec, int) and e <= rec):
                out.append((('discard', e), 'deliver', self._set(st, msgs=msgs - {e})))
        # a record write is lost (G's leader died, or H's leader changed, before it committed)
        if f < self.budget and 'lose' in self.kinds:
            for e in sorted(msgs):
                out.append((('lose', e), 'fault', self._set(st, msgs=msgs - {e}, faults=f + 1)))
        # G's leader sees its record shown in the home log (the ack option reads it)
        if self.TRACK_SHOWN and not gdel and rec == ce and not st[IX['shown']]:
            out.append((('shown',), 'deliver', self._set(st, shown=True)))
        # the operator recovers H from a copy that was behind
        if f < self.budget and 'hrecover' in self.kinds and isinstance(rec, int) and rec > 0:
            out.append((('hrecover',), 'fault', self._set(st, rec=0, hinc=st[IX['hinc']] + 1, faults=f + 1)))
        # G's slot moves to H, or back (the home leader's slot moves, a
        # control step); settle.ms passes after the table's last change;
        # G's history reaches the tier (the tier copies segments routinely)
        if st[IX['merges']] < self.mbudget and not gdel:
            to = 'H' if st[IX['table']] == 'G' else 'G'
            out.append((('move', to), 'control', self._set(st, table=to, tset=False, merges=st[IX['merges']] + 1)))
        if not st[IX['tset']]:
            out.append((('settle',), 'time', self._set(st, tset=True)))
        if not st[IX['tiered']] and not gdel:
            out.append((('tier',), 'time', self._set(st, tiered=True)))
        return out

    # ---- properties
    def check(self, st):
        bad = []
        if not st[IX['gdel']] and not CFG[st[0]] <= st[2]:
            bad.append('DUR')
        if st[IX['gdel']] and st[IX['table']] == 'G':
            bad.append('SLOT')
        if st[IX['gdel']] and not st[IX['tiered']]:
            bad.append('HIST')
        return bad

    def check_edge(self, s, lab, kind, t):
        return []

    def goals(self, st):
        if st[IX['gdel']]:
            return {'REC': st[5] == GONE}
        return {'REC': st[5] == st[0]}

    def judged(self, st):
        return {'REC': True}

    # ---- the rules (counted)
    def actions(self):
        w = self

        def commits(w, st):
            if st[1] is not None and not st[IX['gdel']]:
                yield {'e': st[1]}

        def apply(w, st, b, d):
            e = b['e']
            d.f['ce'] = e
            d.f['pe'] = None
            d.f['data'] = st[2] | CFG[e]           # a new copy catches up (E-16's world)
            d.f['shown'] = False

        def record(w, st, b, d):
            d.f['msgs'] = st[4] | {b['e']}

        def recs(w, st):
            for e in st[4]:
                if st[5] != GONE:
                    yield {'e': e}

        def setrec(w, st, b, d):
            d.f['rec'] = b['e']
            d.f['msgs'] = st[4] - {b['e']}

        def gcs(w, st):
            for x in st[3]:
                if x in st[2]:
                    yield {'x': x}

        def delete(w, st, b, d):
            d.f['data'] = st[2] - {b['x']}

        def dels(w, st):
            if not st[IX['gdel']] and st[5] != GONE:
                yield {}

        def drop(w, st, b, d):
            d.f['rec'] = GONE
            d.f['gdel'] = True
            d.f['data'] = E
            d.f['msgs'] = E

        def rews(w, st):
            if st[IX['seen']] < st[IX['hinc']] and not st[IX['gdel']]:
                yield {}

        def again(w, st, b, d):
            d.f['msgs'] = st[4] | {st[0]}

        def seen(w, st, b, d):
            d.f['seen'] = st[IX['hinc']]

        def resends(w, st):
            if not st[IX['gdel']]:
                yield {}

        return [
            Action('commit', 'deliver', commits, [], [
                Update('apply', apply, role='world', note="G's config entry commits (Raft, pinned)"),
                Update('record', record, role='records',
                       note="after each config change, G's leader writes G's record into the home log (rule 1)"),
            ]),
            Action('setrec', 'deliver', recs, [
                Cmp('newer', lambda w, st, b: b['e'], '>', lambda w, st, b: st[5] if isinstance(st[5], int) else -1,
                    role='records', note='a record names its config; an older config never overwrites a newer (rule 2)'),
            ], [Update('set', setrec, role='world', note="H's leader applies the record write (pinned)")]),
            Action('gc', 'deliver', gcs, [
                Guard('shown', lambda w, st, b: isinstance(st[5], int) and b['x'] not in CFG[st[5]], role='records',
                      note="a removed copy deletes its data only once G's record shows the config without it (rule 5)"),
            ], [Update('delete', delete, role='world', note='the copy deletes its log (pinned)')]),
            Action('delete', 'deliver', dels, [
                Guard('noslots', lambda w, st, b: st[IX['table']] != 'G', role='records',
                      note="a group's record is deleted only once the slot table shows none of its slots (rule 6)"),
                Guard('settled', lambda w, st, b: st[IX['tset']], role='records',
                      note='... and has shown none for settle.ms (rule 6)'),
                Guard('safe', lambda w, st, b: st[IX['tiered']], role='records',
                      note="a group's record is deleted only once its history is safe (rule 7)"),
            ], [Update('drop', drop, role='world', note="the home leader deletes G's record; G's copies stop (pinned)")]),
            Action('rewrite', 'deliver', rews, [], [
                Update('again', again, role='records',
                       note="after H is recovered from a copy that was behind, G's leader writes its record again (rule 8)"),
                Update('seen', seen, role='world', note="G's leader saw H's new incarnation (pinned)"),
            ]),
            Action('resend', 'deliver', resends, w.resend_guards(), [
                Update('again', again, role='records',
                       note="... and writes its record again, until the home log shows it (new: a record write can be lost)"),
            ]),
        ]

    def resend_guards(self):
        return [Guard('differs', lambda w, st, b: st[5] != st[0], role='records',
                      note="G's leader sees the home log's record of G differ from G's committed config ...")]


class RecordsAck(Records):
    """A probe: G's leader writes its record again only until it has once
    seen it shown in the home log (retry until acknowledged)."""
    TRACK_SHOWN = True

    def resend_guards(self):
        return super().resend_guards() + [
            Guard('unshown', lambda w, st, b: not st[IX['shown']], role='records',
                  note='... only until it has once seen its record shown')]


class RecordsNoResend(Records):
    """A probe: the design as first written (rules 1 to 8, no resend), in
    the world where a record write can be lost."""

    def resend_guards(self):
        return [Guard('never', lambda w, st, b: False, role='records')]


OPTIONS = {'design': Records, 'ack': RecordsAck, 'noresend': RecordsNoResend}
PINNED = {k: ('commit.apply', 'setrec.set', 'gc.delete', 'delete.drop', 'rewrite.seen') for k in OPTIONS}

BOUNDS = {
    # two config changes, one fault (a lost proposal or a recovery of H), no slot move
    'e2': dict(epochs=2, faults=1, merge=0),
    # one config change, one fault, the slot moved to H and back
    'm2': dict(epochs=1, faults=1, merge=2),
    # two config changes, two faults, the slot moved to H and back
    'e2m2': dict(epochs=2, faults=2, merge=2),
}
SWEEP = ('e2', 'm2')
VERIFY = ('e2m2',)
VERIFY_PASS1 = True
