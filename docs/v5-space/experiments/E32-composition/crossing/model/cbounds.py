"""
cbounds.py: the bounds of the composed model.

Every composed bound holds the five things at once: one slot move (p's slot
s goes from G0, "A", to G1, "B"), a leader change, a voter change of A or
B, a log drop behind a snapshot, and dedup state the move must carry. They
are E-15's kind of bound: the smallest that still hold each thing, with the
place where the fault and the drop may strike varied from bound to bound.

Members 0, 1, 2 are the voters of both groups at the start (COMP's G
`pslot`: a project's groups share its servers). Member 3 is a spare. A is
led by member 0 and B by member 1. So:
  - member 0 failing is a leader change in A, and takes a voter from B;
  - member 1 failing is a leader change in B, and takes a voter from A;
  - a lost disk (Z `rejoin`) leaves a replica that never comes back, so
    the group's leader must swap it out: add the spare as a learner, promote
    it, remove the old voter: three voter changes.

Keys beyond E-17's (layouts, attempts, crashes, faults, reader):
  members  how many members; voters, leaders per group
  fail     the members that may fail; kinds: crash, lose (a lost disk)
  mfaults  member faults per run
  heal     the groups whose leader heals (E-16 `self`)
  drops    log drops per run; dropg: the groups that may drop
  sess     attempt id -> session sequence (E-20 `sess`)
  derived  attempt id -> source sequence (E-30 `srchi-slot` outputs)
  giveup   whether B may give the move up (the one decider)
  serial   the client sends one write at a time (the next only once the
           one before is acknowledged)
  never    members that never come back once they fail
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
E17 = os.path.normpath(os.path.join(HERE, '..', '..', '..', 'E17-partitioning', 'harness'))
if E17 not in sys.path:
    sys.path.insert(0, E17)
import bounds as e17bounds          # noqa: E402

GROW = e17bounds.GROW
TWICE = e17bounds.TWICE

# E-17's own six bounds, with its two deciders: only to show the port is exact.
BASE = {name: dict(e17bounds.BOUNDS[name], two_deciders=True, giveup=True) for name in e17bounds.SWEEP}

REP = dict(members=4, voters=((0, 1, 2), (0, 1, 2)), leaders=(0, 1), crashes=0, faults=0)


def B(**kw):
    d = dict(layouts=GROW, reader=False, giveup=False, mfaults=1, drops=1, kinds=('crash', 'lose'))
    d.update(REP)
    d.update(kw)
    return d


W1 = [('w1', 'p', 1)]
W2 = [('w1', 'p', 1), ('w2', 'p', 2)]
S1 = {'w1': 1}
S2 = {'w1': 1, 'w2': 2}
O2 = [('o1', 'p', 1), ('o2', 'p', 1)]
D2 = {'o1': 1, 'o2': 2}
LOSE = dict(kinds=('lose',))


def side(x, **kw):
    """x = 'src': member 0 (A's leader) loses its disk for good; A heals; A
    drops. x = 'dst': the same for member 1 and B."""
    m, g = (0, 0) if x == 'src' else (1, 1)
    d = dict(fail=(m,), never=(m,), heal=(g,), dropg=(g,), kinds=('lose',))
    d.update(kw)
    return B(**d)


BOUNDS = {
    # --- the core four: one session write; one member loses its disk for good (a leader change, then
    # the swap: add the spare as a learner, promote it, remove the lost voter); one log drop
    # A's leader is lost; A heals; A drops its log
    'src': side('src', attempts=W1, sess=S1),
    # B's leader is lost; B heals; B drops its log
    'dst': side('dst', attempts=W1, sess=S1),
    # A's leader is lost; B (which lost a follower) heals; B drops
    'src-dst': B(attempts=W1, sess=S1, fail=(0,), never=(0,), heal=(1,), dropg=(1,), **LOSE),
    # B's leader is lost; A heals; A drops
    'dst-src': B(attempts=W1, sess=S1, fail=(1,), never=(1,), heal=(0,), dropg=(0,), **LOSE),
    # --- derived outputs with the srchi-slot mark (no session: the consumer restarted past any horizon)
    'mark-src': side('src', attempts=O2, derived=D2),
    'mark-dst': side('dst', attempts=O2, derived=D2),
    # --- a reader of the moved slot (E-31's cursor property, as E-17's P4 and L4)
    'read-src': side('src', attempts=W1, sess=S1, reader=True),
    'read-dst': side('dst', attempts=W1, sess=S1, reader=True),
    # --- the give-up path (one decider: B aborts, A reopens)
    'giveup-src': side('src', attempts=W1, sess=S1, giveup=True),
    'giveup-dst': side('dst', attempts=W1, sess=S1, giveup=True),
    # --- the failed member only crashed, and may come back at any time (catch-up, a surplus voter)
    'crash-src': B(attempts=W1, sess=S1, fail=(0,), kinds=('crash',), heal=(0,), dropg=(0,)),
    'crash-dst': B(attempts=W1, sess=S1, fail=(1,), kinds=('crash',), heal=(1,), dropg=(1,)),
    # --- the session floor: two writes, so the first outcome is forgotten before the move carries it
    'floor-src': side('src', attempts=W2, sess=S2),
    'floor-dst': side('dst', attempts=W2, sess=S2),
    # the same with a client that sends one write at a time (half the size; the mutants run on these)
    'floors-src': side('src', attempts=W2, sess=S2, serial=True),
    'floors-dst': side('dst', attempts=W2, sess=S2, serial=True),
    # --- the slot moves to B and back (E-17's `twice`): stale names, a second move after a drop
    'twice-src': side('src', attempts=W1, sess=S1, layouts=TWICE),
    'twice-dst': side('dst', attempts=W1, sess=S1, layouts=TWICE),
    # --- the session floor is one per group, the outcomes one set per slot: w1 on the moving slot,
    # w3 on the slot that stays (one write at a time)
    'slots-src': side('src', attempts=[('w1', 'p', 1), ('w3', 'q', 1)], sess={'w1': 1, 'w3': 2}, serial=True),
    'slots-dst': side('dst', attempts=[('w1', 'p', 1), ('w3', 'q', 1)], sess={'w1': 1, 'w3': 2}, serial=True),
    # --- one lost member, and BOTH groups heal at once (each lost a voter)
    'heal2-src': B(attempts=W1, sess=S1, fail=(0,), never=(0,), heal=(0, 1), dropg=(0,), **LOSE),
    'heal2-dst': B(attempts=W1, sess=S1, fail=(1,), never=(1,), heal=(0, 1), dropg=(1,), **LOSE),
    # --- everything anywhere: any voter may lose its disk, both groups heal, either may drop
    'any': B(attempts=W1, sess=S1, fail=(0, 1, 2), never=(0, 1, 2), heal=(0, 1), dropg=(0, 1), **LOSE),
    # the same with the lost member able to come back empty (Z rejoin), a crash as well, two drops,
    # the give-up path, the reader, and one leader deposed with no member fault (E-17's crash)
    'all': B(attempts=W1, sess=S1, fail=(0, 1, 2), heal=(0, 1), dropg=(0, 1), drops=2, giveup=True, reader=True,
             crashes=1, faults=1),
}

# The bounds the mutants and the ablation run on, cheapest first.
SWEEP = ('src', 'dst', 'read-src', 'read-dst', 'mark-src', 'mark-dst', 'giveup-src', 'giveup-dst',
         'crash-src', 'crash-dst', 'floors-src', 'floors-dst')
