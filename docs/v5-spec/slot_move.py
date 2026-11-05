#!/usr/bin/env python3
"""
slot_move.py: an exhaustive model checker for the v5 slot move.

It models DESIGN-V5.md 4.2 "Moving a slot" (second round: the move's owner,
the ready report, the slot table in #meta, and unclean recovery), with 2
"Positions", 4.3 dedup and 4.4 readiness. It explores every reachable state by
breadth-first search, so each counterexample it prints is a shortest one.
Plain Python 3, standard library only. See slot_move.md.

    python3 slot_move.py --jobs 4            # the runs in slot_move.md (plan())
    python3 slot_move.py --only fixed --bound move   # one run
    python3 slot_move.py --bound write       # every variant on one bound
    python3 slot_move.py --quick             # the smoke-test bound, seconds
    python3 slot_move.py --list              # the run names and the bounds

THE MODEL IN ONE PARAGRAPH. Shard A holds slot s; shards B (and C) can import
it. Each shard is an abstract Raft group: a committed log, the current
leader's uncommitted tail, and a count of depositions. A deposition drops the
tail; the new leader's tail is any prefix of the old tail or of a tail lost
earlier and not yet overwritten by a commit. A commit moves the tail's first
entry into the committed log. An unclean recovery (at most one per run)
replaces one shard's committed log by any prefix of it, drops its tail, bumps
its epoch, and applies the recovery rule. The slot table in #meta is a
register written by messages, each carrying a version, and answered by acks.
One client issues a few writes, resends them, and sends each copy to any
shard. Messages sit in a set: delivery does not remove them (duplication),
any may be delivered at any time (delay, reordering), and one never delivered
is lost. Every report a shard makes is put in the set the moment its log (or
an ack) makes it true; sending it later is the same as delivering it later.
"""

import argparse
import sys
import time
from collections import deque

S, T = 's', 't'
EMPTY = frozenset()
Z = (0, 0)                      # a position: (epoch, sequence)
NAMES = 'ABC'

# ----------------------------------------------------------------------------
# Log entries. Positions are (epoch, seq) tuples, compared as tuples.
#   ('w', aid, pos)                    a write to slot s
#   ('wt', aid)                        a write to slot t (t never moves; A only)
#   ('exporting', tgt)                 A: step 0. The move's name is this
#                                      entry's index in A's log (with the
#                                      epoch too in the fixed runs)
#   ('fenced', name, N, tgt, tep)      A: step 2; tep: the incarnation (epoch)
#                                      of the target whose ready report it acted on
#   ('cancel', name)                   A: cancels before its fence
#   ('unfenced', name, N)              A: reopens s at N, after B's abort
#   ('importing', name)                target: step 1
#   ('imp', name, to, ws, end, car)    target: copy of s up to `to`; end = N
#                                      once END(N) came; car = carried state
#   ('open', name, N)                  target: step 3
#   ('abort', name)                    target: gives the move up (or drops its
#                                      copy after A's cancel)
#   ('rec', outcome)                   any shard: an unclean recovery; outcome
#                                      'open' or 'shut'; epoch 1 from here
#
# A shard is (committed, tail, (depositions, inherited), lost_tails,
# pending_answers, memory). `memory` is the leader's volatile move, used only by
# the mutant without `exporting`.
#
# The state is (shards, table, client, net, (moves_started, recovered, maxpos)).
# table = (holder index, version). maxpos is a ghost: the highest position of any
# write ever committed anywhere (property 6).
#
# Messages:
#   ('req', dst, aid, copy, resent)        client -> shard
#   ('export', tgt, name)                  A -> tgt: importing, please
#   ('sub', tgt, name)                     tgt -> A: send me s (state mode)
#   ('data', tgt, name, p, q, ws, end, car)  A -> tgt: s's records; p None for a
#                                          snapshot before the fence, else the
#                                          delta since ready position p, END(N)
#   ('ready', tgt, name, p, epoch)         tgt -> A: my copy is committed up to p
#   ('cancelled', tgt, name)               A -> tgt: drop your copy
#   ('aborted', tgt, name, epoch)          tgt -> A: my abort is committed
#   ('tw', holder, version, writer)        tgt -> #meta: table write
#   ('tack', holder, version, writer)      #meta -> writer: that write committed
# A recovery makes a new incarnation of the shard: messages addressed to the old
# one are not delivered to it (links are per incarnation); messages it sent
# before stay deliverable.
# 'moved' and 'retry' change nothing: the client may resend anywhere anyway.
# ----------------------------------------------------------------------------

# The fixes this round's runs showed are needed (slot_move.md, findings). Two
# more were tried and are not needed under one recovery per run, so they are
# left out of `fixed` (their code stays): 'names-with-epoch' (a move's name
# includes A's epoch) and 'recovery-waits-for-abort-report' (a shard counts as
# importing until its abort is reported).
FIXES = ('recovery-ends-move', 'table-by-move', 'unfence-takes-epoch',
         'recovery-writes-table', 'fence-binds-incarnation')

VARIANTS = {
    'design': ('design', 'the revised text, read literally', ()),
    'fixed': ('design', 'the revised text with the five fixes below', FIXES),
    # one fix left out at a time
    'fixed-but-recovery-resumes': ('reading',
        'without "a recovered shard that does not reopen s ends its part in every '
        'move of s in its copy"',
        tuple(f for f in FIXES if f != 'recovery-ends-move')),
    'fixed-but-table-by-writer': ('reading',
        'table writes ordered by the writer\'s (epoch, log position), and B writes '
        's -> A back only "if it wrote s -> B" (as its log shows)',
        tuple(f for f in FIXES if f != 'table-by-move')),
    'fixed-but-unfence-at-old-epoch': ('reading',
        'without the epoch: A reopens at N in N\'s epoch after a recovered B\'s abort',
        tuple(f for f in FIXES if f != 'unfence-takes-epoch')),
    'fixed-but-recovery-reads-table-only': ('reading',
        'without "a recovery that reopens s first writes the table row, at its '
        'new epoch"', tuple(f for f in FIXES if f != 'recovery-writes-table')),
    'fixed-but-fence-ignores-incarnation': ('reading',
        'without "a fence binds the target\'s incarnation: A sends END only to it, '
        'and reopens s only on an abort from it or a newer one"',
        tuple(f for f in FIXES if f != 'fence-binds-incarnation')),
    'fixed-but-table-unversioned': ('reading',
        'the table row is a plain register: the last write to arrive wins',
        tuple(f for f in FIXES if f != 'table-by-move') + ('table-unversioned',)),
    # the coordinator's mutants, on top of the fixed protocol
    'table-after-open': ('mutant',
        '(a) B commits open first and writes s -> B after', FIXES),
    'recovery-trusts-table': ('mutant',
        '(b) recovery reopens s on the table and its copy, without asking the '
        'other shards', FIXES),
    'abort-keeps-table': ('mutant',
        '(c) B aborts without writing s -> A back', FIXES),
    'a-unfences-alone': ('mutant',
        '(d) A gives the move up after its fence without B\'s abort (cancels '
        'and reopens s)', FIXES),
    'no-exporting': ('mutant',
        '(e) no exporting entry: the move lives in A\'s leader\'s memory and has '
        'no name', FIXES),
    # the first round's mutants that still apply
    'ready-before-copy-commits': ('mutant',
        'B reports ready from its uncommitted copy (S1)', FIXES),
    'fence-without-ready': ('mutant',
        'A fences on its exporting alone, without B\'s ready report', FIXES),
    'stream-before-fence-commits': ('mutant',
        'A answers moved(B) and streams the delta and END(N) once fenced is '
        'appended', FIXES),
    'b-serves-before-open-commits': ('mutant',
        'B serves s once open is appended, before it commits', FIXES),
    'b-serves-before-open': ('mutant',
        'B serves s once its copy and END(N) are committed, before open', FIXES),
    'fence-N-from-committed': ('mutant',
        'N is s\'s last committed sequence, not the last in A\'s log', FIXES),
    'stamp-from-committed': ('mutant',
        'a new leader stamps from its committed state, ignoring the tail it kept', FIXES),
    'no-carried-sequence': ('mutant',
        'B stamps from its own writes, not from the imported sequence', FIXES),
    'no-carried-outcomes': ('mutant',
        'the carried state leaves out the outcomes tagged with s', FIXES),
    'no-max-merge': ('mutant',
        'B does not merge the issuer\'s highest call id by max', FIXES),
    'unfence-on-appended-abort': ('mutant',
        'A reopens s once B has APPENDED abort (B reports it uncommitted)', FIXES),
    'b-aborts-after-open': ('mutant',
        'B may abort even after open', FIXES),
    'guards-on-committed': ('mutant',
        'every forbidding guard looks only at committed entries (round 1)', FIXES),
}


def is_open(entries, is_a):
    """Does this log hold s open? (genesis for A, open, unfenced or a recovery
    that reopened, with no later fenced or shutting recovery)"""
    o = is_a
    for e in entries:
        k = e[0]
        if k == 'fenced':
            o = False
        elif k == 'unfenced' or k == 'open':
            o = True
        elif k == 'rec':
            o = e[1] == 'open'
        elif k == 'abort' and o and not is_a:
            o = False               # only in the mutant where B aborts after open
    return o


def epoch(entries):
    for e in entries:
        if e[0] == 'rec':
            return 1
    return 0


def top(entries):
    """The highest position of s in these entries."""
    p = Z
    for e in entries:
        k = e[0]
        if k == 'w':
            q = e[2]
        elif k == 'imp':
            q = e[2]
        elif k in ('fenced', 'unfenced', 'open'):
            q = e[2]
        else:
            continue
        if q > p:
            p = q
    return p


def walk_ok(entries):
    """Property 6 in one log: a write's position is above all before it, and no
    fence, import, open or unfence names a lower one."""
    p = Z
    for e in entries:
        k = e[0]
        if k == 'w':
            if e[2] <= p:
                return False
            p = e[2]
        elif k in ('imp', 'fenced', 'unfenced', 'open'):
            if e[2] < p and k != 'imp':
                return False
            if e[2] > p:
                p = e[2]
    return True


def s_rows(entries):
    st = set()
    for e in entries:
        if e[0] == 'w':
            st.add((e[1], e[2]))
        elif e[0] == 'imp':
            st |= e[3]
    return st


def append(sh, e):
    return (sh[0], sh[1] + (e,), sh[2], sh[3], sh[4], sh[5])


def answer(sh, aid, copy, kind, pos, wait):
    if wait <= len(sh[0]):
        return sh, ((aid, copy, kind, pos),)
    return (sh[0], sh[1], sh[2], sh[3], sh[4] | {(aid, copy, kind, pos, wait)}, sh[5]), ()


def commit(sh):
    com, tail, deps, lost, pend, mem = sh
    com = com + tail[:1]
    tail = tail[1:]
    if deps[1]:
        deps = (deps[0], deps[1] - 1)
    n = len(com)
    rel = tuple(p[:4] for p in pend if p[4] <= n)
    if rel:
        pend = frozenset(p for p in pend if p[4] > n)
    # once the current leader commits, no tail lost by an earlier leader returns
    return (com, tail, deps, EMPTY, pend, mem), rel


def take(cl, rel):
    """The client takes each released answer at once, or it is lost; it takes
    only the answer to its latest copy of a pending attempt (4.3)."""
    outs = [(cl, ())]
    for (aid, copy, kind, pos) in rel:
        nxt = []
        for c, took in outs:
            nxt.append((c, took))
            s, q, cp = c[aid - 1]
            if s == 1 and cp == copy:
                new = (2, pos, cp) if kind == 'ok' else (3, None, cp)
                nxt.append((c[:aid - 1] + (new,) + c[aid:], took + ((aid, copy, kind, pos),)))
        outs = nxt
    return outs


def norm_lost(lost, tail):
    keep = []
    for g in lost:
        if not g or tail[:len(g)] == g:
            continue
        if any(h != g and h[:len(g)] == g for h in lost):
            continue
        keep.append(g)
    return frozenset(keep)


class Model:
    def __init__(self, variant='design', shards=2, writes=(S, T), window=1, resends=1,
                 deposes=1, moves=1, recovery=True, keep_prefix=True):
        self.v = variant
        self.fix = set(VARIANTS[variant][2])
        self.K = shards
        self.writes = tuple(writes)
        self.W = window
        self.R = resends
        self.D = deposes
        self.M = moves
        self.recovery = recovery
        self.keep = keep_prefix
        self.slot = {i + 1: w for i, w in enumerate(self.writes)}
        self.named = variant != 'no-exporting'

    def init(self):
        sh = ((), (), (0, 0), EMPTY, EMPTY, ())
        cl = tuple((0, None, 0) for _ in self.writes)
        return (tuple(sh for _ in range(self.K)), (0, ()), cl, EMPTY, (0, False, Z))

    # ------------------------------------------------------------ views of a log
    def name_at(self, entries, i):
        if 'names-with-epoch' in self.fix:
            return (epoch(entries[:i]), i)
        return i

    def a_moves(self, entries):
        """A's moves: name -> [target, N or None, cancelled, unfenced N or None,
        target incarnation fenced on, settled by a recovery] (the latest move of
        each name)."""
        mv = {}
        for i, e in enumerate(entries):
            k = e[0]
            if k == 'exporting':
                mv[self.name_at(entries, i)] = [e[1], None, False, None, None, False]
            elif k == 'fenced':
                if e[1] in mv:
                    mv[e[1]][1] = e[2]
                    mv[e[1]][4] = e[4]
                elif not self.named:
                    mv[None] = [e[3], e[2], False, None, e[4], False]
            elif k == 'cancel' and e[1] in mv:
                mv[e[1]][2] = True
            elif k == 'unfenced' and e[1] in mv:
                mv[e[1]][3] = e[2]
            elif (k == 'rec' and e[1] == 'shut' and 'recovery-ends-move' in self.fix):
                for m in mv.values():           # a fence from before the recovery
                    if m[1] is not None and m[3] is None:   # no longer reopens s
                        m[5] = True
        return mv

    def t_moves(self, entries):
        """A target's imports: name -> [pos, end, car, end_idx, abort_idx, open,
        abort, first_import_seen] (the latest import of each name)."""
        mv = {}
        for i, e in enumerate(entries):
            k = e[0]
            if k == 'importing':
                mv[e[1]] = [Z, None, None, None, None, False, False, False]
            elif k == 'imp' and e[1] in mv:
                m = mv[e[1]]
                if e[2] > m[0]:
                    m[0] = e[2]
                m[7] = True
                if e[4] is not None and m[1] is None:
                    m[1], m[2], m[3] = e[4], e[5], i
            elif k == 'open' and e[1] in mv:
                mv[e[1]][5] = True
            elif k == 'abort' and e[1] in mv:
                mv[e[1]][4] = i
                mv[e[1]][6] = True
            elif k == 'rec' and e[1] == 'open':
                for m in mv.values():
                    if not m[6]:
                        m[5] = True
        return mv

    def live_import(self, entries):
        """The name of an import still under way in this log, or False."""
        for n, m in self.t_moves(entries).items():
            if not m[5] and not m[6]:
                return True
        return False

    def under_way(self, entries, mem):
        """Is a move still under way at A? (an exporting not ended by cancel or
        unfenced)"""
        if not self.named:
            return bool(mem)
        for n, m in self.a_moves(entries).items():
            if not m[2] and m[3] is None:
                return True
        return False

    # ------------------------------------------------------------ dedup (4.3)
    def dedup(self, entries):
        out = {}
        hi, hi_wait = 0, 0
        nomerge = self.v == 'no-max-merge'
        for i, e in enumerate(entries):
            w = i + 1
            k = e[0]
            if k == 'w':
                a = e[1]
                out[a] = ('ok', e[2], w)
            elif k == 'wt':
                a = e[1]
                out[a] = ('ok', None, w)
            elif k == 'imp' and e[5] is not None:
                outs, h = e[5]
                for (oa, kind, pos) in outs:
                    out[oa] = (kind, pos, w)
                a = max((o[0] for o in outs), default=0) if nomerge else h
            else:
                continue
            if a > hi:
                hi, hi_wait = a, w
        return out, hi, hi_wait

    def judge(self, entries, aid):
        out, hi, hi_wait = self.dedup(entries)
        floor = hi - self.W if self.W else -1
        if aid in out and aid > floor:
            return ('hit',) + out[aid]
        if aid <= floor:
            return ('stale', hi_wait)
        return ('fresh',)

    def carried(self, entries):
        out, hi, _ = self.dedup(entries)
        if self.v == 'no-carried-outcomes':
            return (EMPTY, hi)
        floor = hi - self.W if self.W else -1
        outs = frozenset((a, k, p) for a, (k, p, _) in out.items()
                         if self.slot[a] == S and a > floor)
        return (outs, hi)

    def next_pos(self, sh, x):
        le = sh[0] + sh[1]
        if self.v == 'stamp-from-committed':
            le = sh[0] + sh[1][sh[2][1]:]           # skip the inherited tail
        p = top(le)
        if x != 0 and self.v == 'no-carried-sequence':
            p = Z
            for e in le:
                if e[0] == 'w' and e[2] > p:
                    p = e[2]
        ep = max(epoch(sh[0] + sh[1]), p[0])
        return (ep, p[1] + 1)

    # ------------------------------------------------------------ guards
    def fguard(self, sh):
        """The log a FORBIDDING guard reads: the whole log, committed or not
        (round 1's finding, now "Two kinds of rule" in the text)."""
        return sh[0] + sh[1]

    def rguard(self, sh):
        """The same, for the three guards round 1 found (A takes no write after
        its fence, B never aborts after open, never opens after abort); the
        mutant reads them on committed entries only, as round 1's readings did."""
        return sh[0] if self.v == 'guards-on-committed' else sh[0] + sh[1]

    def serving(self, sh, x):
        """Does shard x take writes to s?"""
        com = sh[0]
        if x != 0:
            if self.v == 'b-serves-before-open-commits':
                return is_open(com + sh[1], False)
            if self.v == 'b-serves-before-open':
                le = com + sh[1]
                for n, m in self.t_moves(com).items():
                    if (m[1] is not None and m[0] == m[1] and not m[6]
                            and not self.t_moves(le)[n][6]):
                        return True
                if not is_open(com, False):
                    return False
        if not is_open(com, x == 0):
            return False
        return is_open(self.rguard(sh), x == 0)    # nothing in the tail closes it

    def ver(self, n, step, ep, idx):
        """The version a table write carries; ep is the writer's incarnation
        (epoch) at the log entry that causes the write. With the fix: (the move's
        name, the writer's incarnation, the step: 1 for s -> target, 2 for s -> A
        back). The name is A's (epoch, position), so a later move always wins,
        and within a move a newer incarnation, then the write-back; a recovery's
        own write sits at its new epoch, before any move of that epoch.
        Literally ("the newest config winning"): the writer's (epoch, log
        position)."""
        if 'table-by-move' in self.fix and self.named:
            return (n if isinstance(n, tuple) else (0, n), ep, step)
        return (ep, idx)

    def rec_ver(self):
        """The version of a recovery's own table write (the fix)."""
        if 'table-by-move' in self.fix and self.named:
            return ((1, -1), 0, 0)
        return (1, -1)

    # ------------------------------------------------------------ reports
    def reports(self, shards, table, net):
        """Every message the shards' logs (and #meta's acks) make true now."""
        msgs = []
        A = shards[0]
        if self.named:
            for n, m in self.a_moves(A[0]).items():
                tgt = m[0]
                if m[2]:
                    msgs.append(('cancelled', tgt, n))
                elif m[3] is None and not m[5]:
                    msgs.append(('export', tgt, n))
        else:
            if A[5]:
                msgs.append(('export', A[5][0], None))
            for e in A[0]:
                if e[0] == 'cancel':
                    msgs.append(('cancelled', e[2], None))
        for x in range(1, self.K):
            sh = shards[x]
            com = sh[0]
            ep = epoch(com)
            src = com + sh[1] if self.v == 'ready-before-copy-commits' else com
            rmv = self.t_moves(src)
            for n, m in self.t_moves(com).items():
                if m[5]:
                    if self.v == 'table-after-open' and not m[6] and m[3] is not None:
                        msgs.append(('tw', x, self.ver(n, 1, epoch(com[:m[3]]), m[3] + 1), x))
                    continue
                if not m[6]:
                    if m[1] is None:
                        msgs.append(('sub', x, n))
                        if n in rmv and rmv[n][7]:
                            msgs.append(('ready', x, n, rmv[n][0], ep))
                    elif self.v != 'table-after-open':
                        msgs.append(('tw', x, self.ver(n, 1, epoch(com[:m[3]]), m[3] + 1), x))
                    continue
                # an abort: write s -> A back first, then report it
                if self.v == 'abort-keeps-table':
                    wrote = False
                elif 'table-by-move' in self.fix:
                    wrote = True            # always: a late s -> B of this move loses
                else:
                    wrote = m[1] is not None        # "if it wrote s -> B", by its log
                if wrote:
                    ver = self.ver(n, 2, epoch(com[:m[4]]), m[4] + 1)
                    msgs.append(('tw', 0, ver, x))
                    if ('tack', 0, ver, x) not in net:
                        continue
                msgs.append(('aborted', x, n, ep))
            if self.v == 'unfence-on-appended-abort':
                for n, m in self.t_moves(com + sh[1]).items():
                    if m[6] and not m[5]:
                        msgs.append(('aborted', x, n, ep))
        return frozenset(msgs)

    # ------------------------------------------------------------ successors
    def succ(self, st, nofault=False):
        shards, table, cl, net, meta = st
        started, recovered, maxpos = meta
        res = []
        add = res.append
        v = self.v
        A = shards[0]
        Ale = A[0] + A[1]

        def put(x, sh):
            return shards[:x] + (sh,) + shards[x + 1:]

        # ---- the client: ids rise, the window bounds them. After the recovery the
        # client sends nothing new (copies already sent may still land).
        if not nofault and not recovered:
            pending = [i + 1 for i, c in enumerate(cl) if c[0] == 1]
            for i, (s, q, c) in enumerate(cl):
                aid = i + 1
                dsts = range(self.K) if self.slot[aid] == S else (0,)
                if s == 0:
                    if self.W and aid - min(pending + [aid]) >= self.W:
                        break
                    ncl = cl[:i] + ((1, None, 1),) + cl[i + 1:]
                    for d in dsts:
                        add((('issue', aid, d),
                             (shards, table, ncl, net | {('req', d, aid, 1, False)}, meta)))
                    break
                if s == 1 and c <= self.R:
                    ncl = cl[:i] + ((1, None, c + 1),) + cl[i + 1:]
                    for d in dsts:
                        add((('resend', aid, c + 1, d),
                             (shards, table, ncl, net | {('req', d, aid, c + 1, True)}, meta)))

        # ---- deliveries
        for m in net:
            k = m[0]
            if k == 'req':
                if not nofault:
                    res.extend(self.on_req(st, m))
                continue
            if k == 'export':
                r = self.on_export(st, m)
            elif k == 'sub':
                r = self.on_sub(st, m)
            elif k == 'ready':
                r = self.on_ready(st, m)
                if r is not None:
                    add(r)
                r = self.on_ready_send(st, m)
            elif k == 'data':
                r = self.on_data(st, m)
            elif k == 'tw':
                r = self.on_tw(st, m)
            elif k == 'aborted':
                r = self.on_aborted(st, m)
            elif k == 'cancelled':
                r = self.on_cancelled(st, m)
            else:
                continue
            if r is not None:
                add(r)

        # ---- step 0: A starts a move (a choice)
        if not nofault and started < self.M and is_open(self.fguard(A), True) \
                and is_open(A[0], True):
            if not self.under_way(self.fguard(A), A[5]):
                for tgt in range(1, self.K):
                    if self.named:
                        na = append(A, ('exporting', tgt))
                        nmsg = net
                    else:
                        na = (A[0], A[1], A[2], A[3], A[4], (tgt,))
                        nmsg = net | {('export', tgt, None)}
                    add((('A-export', tgt),
                         (put(0, na), table, cl, nmsg, (started + 1, recovered, maxpos))))

        # ---- A cancels on its own, before its fence (a choice)
        if not nofault:
            if self.named:
                for n, m in self.a_moves(self.fguard(A)).items():
                    if m[1] is None and not m[2] and m[3] is None:
                        add((('A-cancel', n), (put(0, append(A, ('cancel', n))), table, cl, net, meta)))
            elif A[5] and is_open(self.fguard(A), True):
                na = append(A, ('cancel', None, A[5][0]))
                na = (na[0], na[1], na[2], na[3], na[4], ())
                add((('A-cancel', None), (put(0, na), table, cl, net, meta)))
            if v == 'a-unfences-alone':
                for n, m in self.a_moves(Ale).items():
                    if m[1] is not None and m[3] is None and not is_open(Ale, True):
                        na = append(append(A, ('cancel', n)), ('unfenced', n, top(Ale)))
                        add((('A-unfence-alone', n), (put(0, na), table, cl, net, meta)))

        # ---- mutant: A fences on its committed exporting alone
        if v == 'fence-without-ready':
            for n, m in self.a_moves(A[0]).items():
                r = self.try_fence(st, m[0], n, epoch(shards[m[0]][0]))
                if r is not None:
                    add(r)

        # ---- targets: open (step 3), and abort (a choice)
        for x in range(1, self.K):
            sh = shards[x]
            com = sh[0]
            fg = self.fguard(sh)
            le_mv = self.t_moves(fg)
            rg_mv = self.t_moves(self.rguard(sh))
            ep = epoch(com)
            for n, m in self.t_moves(com).items():
                lm = le_mv.get(n)
                if lm is None:
                    continue
                if m[1] is not None and m[0] == m[1] and not lm[5] and not rg_mv[n][6]:
                    if v == 'table-after-open' or \
                            ('tack', x, self.ver(n, 1, epoch(com[:m[3]]), m[3] + 1), x) in net:
                        add((('T-open', x, n, m[1]),
                             (put(x, append(sh, ('open', n, m[1]))), table, cl, net, meta)))
            if not nofault:
                held = is_open(self.rguard(sh), False)
                for n, lm in le_mv.items():
                    rm = rg_mv.get(n, lm)
                    if not lm[6] and ((not rm[5] and not held) or v == 'b-aborts-after-open'):
                        add((('T-abort', x, n), (put(x, append(sh, ('abort', n))), table, cl, net, meta)))

        # ---- Raft: commits, depositions; an unclean recovery
        for x in range(self.K):
            sh = shards[x]
            if sh[1]:
                nsh, rel = commit(sh)
                e = sh[1][0]
                nmax = maxpos
                if e[0] == 'w' and e[2] > maxpos:
                    nmax = e[2]
                for ncl, took in (take(cl, rel) if cl is not None else [(cl, ())]):
                    add((('commit', x, e, took),
                         (put(x, nsh), table, ncl, net, (started, recovered, nmax))))
        if not nofault and not recovered:
            for x in range(self.K):
                for nsh in self.deposes(shards[x]):
                    add((('depose', x, nsh[1]), (put(x, nsh), table, cl, net, meta)))
            if self.recovery and not recovered:
                for x in range(self.K):
                    net2 = frozenset(mm for mm in net if self.addressee(mm) != x)
                    for lab, nsh, nt in self.recoveries(st, x):
                        add((lab, (put(x, nsh), nt, cl, net2, (started, True, maxpos))))
        return res

    def deposes(self, sh):
        com, tail, deps, lost, pend, mem = sh
        if deps[0] >= self.D:
            return []
        if self.keep:
            cands = set()
            for src in (tail,) + tuple(lost):
                for i in range(len(src) + 1):
                    cands.add(src[:i])
            lost2 = frozenset(g for g in lost | {tail} if g)
        else:
            cands, lost2 = {()}, EMPTY
        inh = self.v == 'stamp-from-committed'
        return [(com, c, (deps[0] + 1, len(c) if inh else 0), norm_lost(lost2, c), EMPTY, ())
                for c in cands]

    @staticmethod
    def addressee(m):
        """The shard a message is addressed to (None for #meta)."""
        k = m[0]
        if k == 'req':
            return m[1]
        if k in ('export', 'data', 'cancelled'):
            return m[1]
        if k in ('sub', 'ready', 'aborted'):
            return 0
        if k == 'tack':
            return m[3]
        return None

    def recoveries(self, st, x):
        """fero recover --unclean x: a lagging survivor's copy (any prefix of the
        committed log) becomes the log; the tail and the leader's memory go; the
        epoch is bumped; the recovery rule decides s (DESIGN-V5 4.2, recovery)."""
        shards, table, cl, net, meta = st
        sh = shards[x]
        out = []
        for k in range(len(sh[0]) + 1):
            pre = sh[0][:k]
            if x == 0:
                rows = True
            else:
                mv = self.t_moves(pre)
                rows = any(m[1] is not None and m[0] == m[1] and not m[6] for m in mv.values()) \
                    or is_open(pre, False)
            others = True
            if self.v != 'recovery-trusts-table':
                for y in range(self.K):
                    if y != x and self.busy(shards[y], y, net):
                        others = False
            outcomes = ['shut']
            if table[0] == x and rows and others:
                outcomes.append('open')
            for oc in outcomes:
                log = pre + (('rec', oc),)
                if oc == 'shut' and 'recovery-ends-move' in self.fix:
                    log = self.end_moves(log, x)
                nsh = (log, (), sh[2], EMPTY, EMPTY, ())
                nt = table
                if oc == 'open' and 'recovery-writes-table' in self.fix:
                    nt = (x, self.rec_ver())    # at the new epoch: beats older writes
                out.append((('recover', x, k, oc), nsh, nt))
        return out

    def busy(self, sh, y, net):
        """Shard y's answer to the recovery: does it hold s open, or import it?
        Literally, its leader answers from its log end. With the fix, an import
        counts until its abort is committed and reported (the report comes only
        after the table write-back), so no table write of it is still in flight."""
        le = sh[0] + sh[1]
        if is_open(le, y == 0) or is_open(sh[0], y == 0):
            return True
        if y == 0:
            return False
        if 'recovery-waits-for-abort-report' not in self.fix:
            return self.live_import(le)
        ep = epoch(sh[0])
        for src in (sh[0], le):
            for n, m in self.t_moves(src).items():
                if m[5]:
                    continue
                if not m[6]:
                    return True
                if src is sh[0] and ('aborted', y, n, ep) not in net:
                    return True
        return False

    def end_moves(self, log, x):
        """The fix: a recovered shard that does not reopen s ends its part in any
        move of s: a target aborts its import; A cancels a move it has not fenced
        (a fenced one waits for the target's abort, as ever)."""
        if x == 0:
            for n, m in self.a_moves(log).items():
                if m[1] is None and not m[2] and m[3] is None:
                    log = log + (('cancel', n),)
        else:
            for n, m in self.t_moves(log).items():
                if not m[5] and not m[6]:
                    log = log + (('abort', n),)
        return log

    # ------------------------------------------------------------ handlers
    def on_req(self, st, msg):
        _, d, aid, copy, resent = msg
        shards, table, cl, net, meta = st
        slot = self.slot[aid]
        sh = shards[d]
        if slot == T:
            pass                            # t stays at A, always open
        elif not self.serving(sh, d):
            return []                       # moved or retry: not definitive
        le = sh[0] + sh[1]
        n = len(le)
        r = self.judge(le, aid)
        if r[0] == 'hit':
            _, kind, pos, wait = r
            sh2, rel = answer(sh, aid, copy, kind, pos, wait)
            lab = ('dedup', d, aid, copy, kind, pos)
        elif r[0] == 'stale':
            sh2, rel = answer(sh, aid, copy, 'stale', None, r[1])
            lab = ('stale', d, aid, copy)
        else:
            if slot == S:
                pos = self.next_pos(sh, d)
                sh1 = append(sh, ('w', aid, pos))
            else:
                pos = None
                sh1 = append(sh, ('wt', aid))
            sh2, rel = answer(sh1, aid, copy, 'ok', pos, n + 1)
            lab = ('append', d, aid, copy, pos)
        out = []
        for ncl, took in take(cl, rel):
            if sh2 == sh and ncl == cl:
                continue
            out.append((lab + (took,),
                        (shards[:d] + (sh2,) + shards[d + 1:], table, ncl, net, meta)))
        return out

    def on_export(self, st, msg):
        _, tgt, n = msg
        shards, table, cl, net, meta = st
        sh = shards[tgt]
        fg = self.fguard(sh)
        if self.live_import(fg) or is_open(fg, False):
            return None
        if self.named and n in self.t_moves(fg):
            return None                     # this move was imported already
        if not self.named and sum(1 for e in fg if e[0] == 'importing') >= self.M:
            return None                     # (bound: unnamed imports, as many as moves)
        nsh = append(sh, ('importing', n))
        return (('T-importing', tgt, n), (shards[:tgt] + (nsh,) + shards[tgt + 1:],
                                          table, cl, net, meta))

    def a_current(self, A, name, tgt):
        """Does A know the move `name` (to tgt), not cancelled or given back?"""
        if self.named:
            m = self.a_moves(A[0]).get(name)        # committed exporting: a wait
            if m is None or m[0] != tgt:
                return None
            return m
        if A[5] and A[5][0] == tgt:
            return [tgt, None, False, None]
        return None

    def on_sub(self, st, msg):
        """Before its fence, A answers the target's state-mode subscription with
        s's committed records (the target keeps those above its position)."""
        _, tgt, n = msg
        shards, table, cl, net, meta = st
        A = shards[0]
        m = self.a_current(A, n, tgt)
        if m is None or m[1] is not None or m[2] or m[3] is not None:
            return None
        if not is_open(A[0], True):
            return None
        com = A[0]
        q = top(com)
        ws = frozenset((e[1], e[2]) for e in com if e[0] == 'w')
        d = ('data', tgt, n, None, q, ws, None, None)
        if d in net:
            return None
        return (('A-send', tgt, n, None, q, None), (shards, table, cl, net | {d}, meta))

    def on_ready(self, st, msg):
        """Step 2: A fences on the target's ready report."""
        if self.v == 'fence-without-ready':
            return None
        return self.try_fence(st, msg[1], msg[2], msg[4])

    def try_fence(self, st, tgt, n, tep):
        shards, table, cl, net, meta = st
        A = shards[0]
        fg = self.fguard(A)
        m = self.a_current(A, n, tgt)
        if m is None:
            return None
        lm = self.a_moves(fg).get(n) if self.named else None
        if lm is not None and (lm[1] is not None or lm[2] or lm[3] is not None):
            return None
        if not is_open(fg, True) or not is_open(A[0], True):
            return None
        src = A[0] if self.v == 'fence-N-from-committed' else A[0] + A[1]
        N = top(src)
        if N[0] < epoch(A[0] + A[1]):
            N = (epoch(A[0] + A[1]), N[1])
        fe = ('fenced', n, N, tgt, tep)
        return (('A-fence', tgt, n, N), ((append(A, fe),) + shards[1:], table, cl, net, meta))

    def fence_of(self, A, n, src):
        """(N, target, target incarnation), if the move n's fence is in `src` and
        s was not given back."""
        if self.named:
            m = self.a_moves(src).get(n)
            if m is None or m[1] is None or m[3] is not None or m[2] or m[5]:
                return None
            return (m[1], m[0], m[4])
        F = None
        for e in src:
            if e[0] == 'fenced':
                F = (e[2], e[3], e[4])
            elif e[0] == 'unfenced' or (e[0] == 'rec' and 'recovery-ends-move' in self.fix):
                F = None
        return F

    def on_ready_send(self, st, msg):
        """After its fence commits, A sends the delta since the ready position,
        END(N) and the carried state."""
        _, tgt, n, p, _ep = msg
        shards, table, cl, net, meta = st
        A = shards[0]
        src = A[0] + A[1] if self.v == 'stream-before-fence-commits' else A[0]
        F = self.fence_of(A, n, src)
        if F is None or F[1] != tgt:
            return None
        N = F[0]
        if p > N:
            return None
        ws = frozenset((e[1], e[2]) for e in src if e[0] == 'w' and p < e[2] <= N)
        car = self.carried(src)
        if 'fence-binds-incarnation' in self.fix:
            car = car + (F[2],)         # END is for the incarnation A fenced on
        d = ('data', tgt, n, p, N, ws, N, car)
        if d in net:
            return None
        return (('A-send', tgt, n, p, N, N), (shards, table, cl, net | {d}, meta))

    def on_data(self, st, msg):
        _, tgt, n, p, q, ws, end, car = msg
        shards, table, cl, net, meta = st
        sh = shards[tgt]
        com = sh[0]
        cm = self.t_moves(com).get(n)
        if cm is None:
            return None                         # importing must be committed
        fg = self.fguard(sh)
        lm = self.t_moves(fg).get(n)
        if lm is None or lm[5] or lm[6]:
            return None
        lmv = self.t_moves(sh[0] + sh[1])[n]
        pos = lmv[0]
        if lmv[1] is not None:
            return None                         # it has END(N) already
        if p is None:                           # a snapshot before the fence
            if lmv[1] is not None or (lmv[7] and q <= pos):
                return None
        else:                                   # the delta after the fence
            if p > pos or not (q > pos or end is not None):
                return None
            if 'fence-binds-incarnation' in self.fix and car[2] != epoch(sh[0] + sh[1]):
                return None                     # END for another incarnation of me
            car = car[:2]
        top_ = q if q > pos else pos
        e = ('imp', n, top_, frozenset(w for w in ws if w[1] > pos), end, car)
        nsh = append(sh, e)
        return (('T-import', tgt, n, pos, q, end),
                (shards[:tgt] + (nsh,) + shards[tgt + 1:], table, cl, net, meta))

    def on_tw(self, st, msg):
        """#meta commits a table write if it is newer (versioned register)."""
        _, val, ver, w = msg
        shards, table, cl, net, meta = st
        ack = ('tack', val, ver, w)
        if 'table-unversioned' in self.fix:
            if table == (val, ver) and ack in net:
                return None
        else:
            if ver < table[1] or (ver == table[1] and val != table[0]):
                return None
            if ver == table[1] and ack in net:
                return None
        return (('meta-write', val, ver), (shards, (val, ver), cl, net | {ack}, meta))

    def on_aborted(self, st, msg):
        """A, on the target's committed abort: reopen s at N (unfenced), or end a
        move it had not fenced."""
        _, tgt, n, tep = msg
        shards, table, cl, net, meta = st
        A = shards[0]
        fg = self.fguard(A)
        if self.named:
            m = self.a_moves(fg).get(n)
            if m is None or m[0] != tgt or m[2] or m[3] is not None or m[5]:
                return None
            if m[1] is None:
                return (('A-cancel-on-abort', n), (shards[:0] + (append(A, ('cancel', n)),) + shards[1:],
                                                   table, cl, net, meta))
        else:
            if A[5] and A[5][0] == tgt and is_open(fg, True):
                na = append(A, ('cancel', None, tgt))
                na = (na[0], na[1], na[2], na[3], na[4], ())
                return (('A-cancel-on-abort', None), ((na,) + shards[1:], table, cl, net, meta))
        if is_open(fg, True):
            return None
        F = self.fence_of(A, n, fg)
        if F is None or F[1] != tgt:
            return None                 # the fence names its target
        N = F[0]
        if 'fence-binds-incarnation' in self.fix and tep < F[2]:
            return None                 # an abort of an older incarnation's import
        if 'unfence-takes-epoch' in self.fix and tep > N[0]:
            N = (tep, N[1])
        na = append(A, ('unfenced', n, N))
        if not self.named:
            na = (na[0], na[1], na[2], na[3], na[4], ())
        return (('A-unfence', n, N), ((na,) + shards[1:], table, cl, net, meta))

    def on_cancelled(self, st, msg):
        _, tgt, n = msg
        shards, table, cl, net, meta = st
        sh = shards[tgt]
        lm = self.t_moves(self.fguard(sh)).get(n)
        if lm is None or lm[5] or lm[6]:
            return None
        return (('T-drop', tgt, n), (shards[:tgt] + (append(sh, ('abort', n)),) + shards[tgt + 1:],
                                     table, cl, net, meta))

    # ------------------------------------------------------------ after a step
    def settle(self, st):
        """Add every report the new state makes true, and drop what can never
        change anything again."""
        shards, table, cl, net, meta = st
        net2 = net | self.reports(shards, table, net)
        if cl is not None and any(sh[4] for sh in shards):
            ns = []
            for sh in shards:
                if sh[4]:
                    keep = frozenset(p for p in sh[4]
                                     if cl[p[0] - 1][0] == 1 and cl[p[0] - 1][2] == p[1])
                    if len(keep) != len(sh[4]):
                        sh = (sh[0], sh[1], sh[2], sh[3], keep, sh[5])
                ns.append(sh)
            shards = tuple(ns)
        if net2 is not net:
            net2 = net2 | self.reports(shards, table, net2)  # acks enable a report
        return (shards, table, cl, net2, meta)

    # ------------------------------------------------------------ properties
    def holder(self, st):
        """The shard whose state is s's (property 4, before any recovery)."""
        shards = st[0]
        for x in range(self.K):
            if is_open(shards[x][0], x == 0):
                return x
        return 0

    def check(self, st):
        shards, table, cl, net, meta = st
        started, recovered, maxpos = meta
        bad = []
        opens = [x for x in range(self.K) if is_open(shards[x][0], x == 0)]
        # 1. at most one shard holds s open
        if len(opens) > 1:
            bad.append(1)
        # 2. no position stamped on committed writes by two shards
        seen = {}
        for x in range(self.K):
            for e in shards[x][0]:
                if e[0] == 'w':
                    if seen.get(e[2], x) != x:
                        bad.append(2)
                        break
                    seen[e[2]] = x
            if 2 in bad:
                break
        # 3. every write committed to s at A before a move's fence is at the target
        #    when the target opens
        A = shards[0]
        for x in range(1, self.K):
            com = shards[x][0]
            for i, e in enumerate(com):
                if e[0] != 'open':
                    continue
                n = e[1]
                got = set()
                cur = None
                for f in com[:i]:
                    if f[0] == 'importing':
                        cur = f[1]
                        if f[1] == n:
                            got = set()
                    elif f[0] == 'imp' and f[1] == n:
                        got |= f[3]
                pre = set()
                for f in A[0]:
                    if f[0] == 'fenced' and f[1] == n:
                        break
                    if f[0] == 'w':
                        pre.add((f[1], f[2]))
                    elif f[0] in ('unfenced', 'rec'):
                        pass
                if not pre <= got:
                    bad.append(3)
        # 4. no acknowledged write missing from s's state (before any recovery)
        cnt = {}
        for x in range(self.K):
            for e in shards[x][0]:
                if e[0] in ('w', 'wt'):
                    cnt[e[1]] = cnt.get(e[1], 0) + 1
        if not recovered:
            h = self.holder(st)
            rows = s_rows(shards[h][0])
            a_t = {e[1] for e in A[0] if e[0] == 'wt'}
            for i, (s, q, c) in enumerate(cl):
                aid = i + 1
                if s == 2:
                    ok = (aid, q) in rows if self.slot[aid] == S else aid in a_t
                    if not ok:
                        bad.append(4)
                        break
        # 5. no attempt commits twice
        if any(n > 1 for n in cnt.values()):
            bad.append(5)
        # 6. per shard, positions never go back (and, on edges, never reused)
        for x in range(self.K):
            if not walk_ok(shards[x][0]):
                bad.append(6)
                break
        # 8. an attempt its issuer took as refused never commits
        for i, (s, q, c) in enumerate(cl):
            if s == 3 and cnt.get(i + 1):
                bad.append(8)
                break
        # 9. whenever a shard holds s open, the table names it
        for x in opens:
            if table[0] != x:
                bad.append(9)
                break
        return sorted(set(bad))

    # ------------------------------------------------------------ liveness
    def done(self, st):
        """No move left half done: every move a shard started has finished (the
        target opened) or was cancelled or given back, at both ends."""
        shards = st[0]
        A = shards[0]
        Ale = A[0] + A[1]
        if self.named:
            for n, m in self.a_moves(A[0]).items():
                if m[2] or m[3] is not None or m[5]:
                    continue
                tgt = m[0]
                tm = self.t_moves(shards[tgt][0]).get(n)
                if m[1] is not None and tm is not None and tm[5]:
                    continue                    # finished
                return False
            for e in A[1]:
                if e[0] == 'exporting':
                    return False                # a move appended, not yet committed
        elif A[5]:
            return False
        for x in range(1, self.K):
            sh = shards[x]
            if self.live_import(sh[0] + sh[1]):
                return False
        return True


# ============================================================================
# The search
# ============================================================================

PROPS = {
    1: 'at most one shard holds s open',
    2: 'no position (epoch, seq) is stamped on committed writes by two shards',
    3: 'every write committed to s at A before the fence is at the target when it opens',
    4: 'no acknowledged write goes missing (checked only while no recovery has happened)',
    5: 'no attempt id commits twice',
    6: 'a slot\'s position never goes back, and is never reused (as (epoch, seq))',
    7: 'liveness: with no more faults, every move finishes or is cancelled (from '
       'states with no recovery)',
    8: 'an attempt its issuer took as refused never commits',
    9: 'whenever a shard holds s open, the table names it',
}


def explore(model, limit=None, progress=False):
    init = model.settle(model.init())
    seen = {init: None}
    q = deque([init])
    first = {}
    edges = 0
    t0 = time.time()
    intern = {}

    def canon(x):
        y = intern.get(x)
        if y is None:
            intern[x] = x
            return x
        return y

    while q:
        s = q.popleft()
        maxpos = s[4][2]
        for lab, t in model.succ(s):
            t = model.settle(t)
            edges += 1
            # property 6 across shards and time: a committed write's position
            # is above every position committed before it, anywhere
            if lab[0] == 'commit' and lab[2][0] == 'w' and 6 not in first:
                if not lab[2][2] > maxpos:
                    first[6] = (s, lab, t, 'edge')
            if t in seen:
                continue
            t = (canon(t[0]), t[1], canon(t[2]), canon(t[3]), t[4])
            seen[t] = (s, lab)
            for p in model.check(t):
                if p not in first:
                    first[p] = (s, lab, t, 'state')
            q.append(t)
        if progress and len(seen) % 500000 < 3:
            print(f'    .. {len(seen):,} states, queue {len(q):,}, '
                  f'{time.time() - t0:.0f}s', file=sys.stderr, flush=True)
        if limit and len(seen) > limit and first:
            break
    return seen, first, edges, time.time() - t0


def liveness(model, seen):
    """Property 7, bounded: from every reachable state with no recovery, with
    every message lost (the shards then repeat their reports) and then no more
    faults (no deposition, loss, recovery or new choice to cancel or abort;
    clients idle), some path reaches done. Checked as AG EF done over the
    no-fault graph."""
    t0 = time.time()
    idx = {}
    nodes = []
    origin = []
    for st in seen:
        shards, table, cl, net, meta = st
        if meta[1]:
            continue
        ps = tuple((sh[0], sh[1], (0, 0), EMPTY, EMPTY, sh[5]) for sh in shards)
        tacks = frozenset(m for m in net if m[0] == 'tack')   # #meta's answers stay
        p = model.settle((ps, table, None, tacks, (model.M, False, Z)))
        if p not in idx:
            idx[p] = len(nodes)
            nodes.append(p)
            origin.append(st)
    n0 = len(nodes)
    succs = []
    parent = {}
    i = 0
    while i < len(nodes):
        s = nodes[i]
        lst = []
        for lab, t in model.succ(s, nofault=True):
            t = model.settle(t)
            j = idx.get(t)
            if j is None:
                j = len(nodes)
                idx[t] = j
                nodes.append(t)
                parent[j] = (i, lab)
            lst.append(j)
        succs.append(lst)
        i += 1
    good = [model.done(s) for s in nodes]
    rev = [[] for _ in nodes]
    for a, lst in enumerate(succs):
        for b in lst:
            rev[b].append(a)
    q = deque(k for k, g in enumerate(good) if g)
    reach = list(good)
    while q:
        b = q.popleft()
        for a in rev[b]:
            if not reach[a]:
                reach[a] = True
                q.append(a)
    stuck = [k for k in range(len(nodes)) if not reach[k]]
    cex = None
    if stuck:
        starts = [k for k in stuck if k < n0]
        best = None
        for k in starts:
            d = depth(seen, origin[k])
            if best is None or d < best[0]:
                best = (d, k)
        if best is None:
            k = stuck[0]
            while k >= n0:
                k = parent[k][0]
            best = (depth(seen, origin[k]), k)
        cex = (origin[best[1]], nodes[best[1]])
    return len(nodes), n0, len(stuck), cex, time.time() - t0


def depth(seen, st):
    d = 0
    while seen[st] is not None:
        st = seen[st][0]
        d += 1
    return d


def trace(seen, st):
    out = []
    while seen[st] is not None:
        p, lab = seen[st]
        out.append((lab, st))
        st = p
    out.reverse()
    return out


# ============================================================================
# Plain-English output
# ============================================================================

def ps(p):
    return f'{p[1]}' if p[0] == 0 else f'{p[0]}:{p[1]}'


def nm(n):
    if n is None:
        return 'm'
    if isinstance(n, tuple):
        return f'm{n[0]}:{n[1]}'
    return f'm{n}'


def ent(e):
    k = e[0]
    if k == 'w':
        return f'w{e[1]}@{ps(e[2])}'
    if k == 'wt':
        return f'w{e[1]}(t)'
    if k == 'exporting':
        return f'exporting(to {NAMES[e[1]]})'
    if k == 'fenced':
        return f'fenced({nm(e[1])}, N={ps(e[2])})'
    if k == 'cancel':
        return f'cancel({nm(e[1])})'
    if k == 'unfenced':
        return f'unfenced({nm(e[1])}, at {ps(e[2])})'
    if k == 'importing':
        return f'importing({nm(e[1])})'
    if k == 'imp':
        ws = ','.join(f'w{a}@{ps(q)}' for a, q in sorted(e[3]))
        s = f'copy({nm(e[1])} to {ps(e[2])}' + (f': {ws}' if ws else '')
        if e[4] is not None:
            outs, hi = e[5]
            o = ','.join(f'w{a}' for a, _, _ in sorted(outs))
            s += f'; END({ps(e[4])}); outcomes {{{o}}}; highest id {hi}'
        return s + ')'
    if k == 'open':
        return f'open({nm(e[1])}, N={ps(e[2])})'
    if k == 'abort':
        return f'abort({nm(e[1])})'
    if k == 'rec':
        return f'RECOVERED(s {e[1]})'
    return str(e)


def took_text(took):
    out = []
    for (aid, copy, kind, pos) in took:
        r = (f'committed at {ps(pos)}' if kind == 'ok' and pos is not None else
             'committed' if kind == 'ok' else 'refused stale-attempt')
        out.append(f'; the client gets the answer to w{aid} copy {copy}: {r}')
    return ''.join(out)


def say(lab):
    k = lab[0]
    if k == 'issue':
        return f'client sends w{lab[1]} (first copy) to {NAMES[lab[2]]}'
    if k == 'resend':
        return f'client resends w{lab[1]} (copy {lab[2]}) to {NAMES[lab[3]]}'
    if k == 'append':
        sq = f' at {ps(lab[4])}' if lab[4] is not None else ''
        return (f'{NAMES[lab[1]]} takes w{lab[2]} copy {lab[3]} as fresh and appends '
                f'it{sq}' + took_text(lab[5]))
    if k == 'dedup':
        at = f' at {ps(lab[5])}' if lab[5] is not None else ''
        return (f'{NAMES[lab[1]]} finds w{lab[2]} among its outcomes; answers copy '
                f'{lab[3]} "{lab[4]}"{at} once committed' + took_text(lab[6]))
    if k == 'stale':
        return f'{NAMES[lab[1]]} refuses w{lab[2]} copy {lab[3]} stale-attempt' + took_text(lab[4])
    if k == 'A-export':
        return f"A's leader appends exporting(s, to {NAMES[lab[1]]})"
    if k == 'A-cancel':
        return f"A's leader appends cancel({nm(lab[1])}) on its own"
    if k == 'A-unfence-alone':
        return f"A's leader appends cancel and unfenced({nm(lab[1])}) on its own"
    if k == 'T-importing':
        return f"{NAMES[lab[1]]}'s leader, asked by A, appends importing({nm(lab[2])})"
    if k == 'A-send':
        if lab[5] is not None:
            return (f"A sends {NAMES[lab[1]]} s's records after {ps(lab[3])}, "
                    f"END({ps(lab[5])}) and the carried state ({nm(lab[2])})")
        return f"A sends {NAMES[lab[1]]} s's committed records up to {ps(lab[4])} ({nm(lab[2])})"
    if k == 'T-import':
        e = f', with END({ps(lab[5])})' if lab[5] is not None else ''
        return f"{NAMES[lab[1]]} appends the copy up to {ps(lab[4])}{e}"
    if k == 'A-fence':
        return (f"A's leader, on {NAMES[lab[1]]}'s ready report, appends "
                f"fenced({nm(lab[2])}, N={ps(lab[3])})")
    if k == 'A-unfence':
        return f"A's leader, on the abort report, appends unfenced({nm(lab[1])}, at {ps(lab[2])})"
    if k == 'A-cancel-on-abort':
        return f"A's leader, on the abort report, appends cancel({nm(lab[1])})"
    if k == 'T-open':
        return f"{NAMES[lab[1]]}'s leader appends open({nm(lab[2])}, N={ps(lab[3])})"
    if k == 'T-abort':
        return f"{NAMES[lab[1]]}'s leader appends abort({nm(lab[2])})"
    if k == 'T-drop':
        return f"{NAMES[lab[1]]}'s leader, told of A's cancel, appends abort({nm(lab[2])})"
    if k == 'meta-write':
        return f"#meta commits the table row s -> {NAMES[lab[1]]} (version {lab[2]})"
    if k == 'commit':
        return f'{NAMES[lab[1]]} commits {ent(lab[2])}' + took_text(lab[3])
    if k == 'depose':
        kept = ', '.join(ent(e) for e in lab[2])
        return (f"{NAMES[lab[1]]}'s leader is deposed; the new leader's uncommitted "
                f"tail is " + (f'[{kept}]' if kept else 'empty'))
    if k == 'recover':
        return (f"fero recover --unclean {NAMES[lab[1]]}: a lagging copy keeps the first "
                f"{lab[2]} committed entries; the rule leaves s {lab[3]} there")
    return str(lab)


def show_state(st, K):
    shards, table, cl, net, meta = st
    lines = []
    for x in range(K):
        sh = shards[x]
        c = ', '.join(ent(e) for e in sh[0]) or '-'
        t = ', '.join(ent(e) for e in sh[1])
        lines.append(f'      {NAMES[x]}: committed [{c}]' + (f' tail [{t}]' if t else ''))
    lines.append(f'      table: s -> {NAMES[table[0]]}')
    if cl:
        cs = []
        for i, (s, q, c) in enumerate(cl):
            cs.append(f'w{i + 1}:' + ['unsent', 'pending', f'acked@{ps(q) if q else ""}',
                                      'refused'][s])
        lines.append('      client: ' + ' '.join(cs))
    return '\n'.join(lines)


def print_trace(seen, end, K, extra=None):
    steps = trace(seen, end)
    for n, (lab, st) in enumerate(steps, 1):
        print(f'   {n:2}. {say(lab)}')
    if extra:
        print(f'   {len(steps) + 1:2}. {extra}')
    print('     state now:')
    print(show_state(end, K))


# ============================================================================

BOUNDS = {
    # name: (what it is for, Model keyword arguments). After the recovery no
    # deposition happens and the client sends nothing new.
    'quick': ('a smoke test: A and B, no writes, one move, one recovery',
              dict(shards=2, writes=(), deposes=1, moves=1)),
    'move': ('A and B, no writes; one move; two depositions per shard; one recovery',
             dict(shards=2, writes=(), deposes=2, moves=1)),
    'moves': ('A and B, no writes; two moves in a run (the second after the first '
              'ends); one deposition per shard; one recovery',
              dict(shards=2, writes=(), deposes=1, moves=2)),
    'three': ('A, B and C, no writes; two moves; one deposition per shard; one recovery',
              dict(shards=3, writes=(), deposes=1, moves=2)),
    'write': ('A and B; one write to s with one resend, each copy to either '
              'shard; one deposition per shard; one move; one recovery',
              dict(shards=2, writes=(S,), window=None, resends=1, deposes=1, moves=1)),
    'dedup': ('A and B; w1 to s and w2 to t under window 1, one resend each (the '
              'floor and the max merge); one deposition per shard; one move; no recovery',
              dict(shards=2, writes=(S, T), window=1, resends=1, deposes=1, moves=1,
                   recovery=False)),
    'deep': ('A and B; two writes to s, no resend; one deposition per shard; one '
             'move; no recovery',
             dict(shards=2, writes=(S, S), window=None, resends=0, deposes=1, moves=1,
                  recovery=False)),
}


def plan():
    """The default runs: (variant, bound) pairs. Every variant runs on `move`;
    the design, the fix and the readings on every bound with a recovery; each
    mutant also on the bounds where its rule can matter."""
    design = ['design', 'fixed']
    readings = [k for k, v in VARIANTS.items() if v[0] == 'reading']
    mutants = [k for k, v in VARIANTS.items() if v[0] == 'mutant']
    jobs = [(n, 'move') for n in VARIANTS]
    jobs += [(n, 'moves') for n in design + readings + ['no-exporting']]
    jobs += [(n, 'write') for n in design + readings + mutants]
    jobs += [(n, 'dedup') for n in design + ['no-carried-outcomes', 'no-max-merge',
                                             'b-serves-before-open-commits']]
    jobs += [(n, 'deep') for n in design + ['fence-N-from-committed', 'stamp-from-committed',
                                            'no-carried-sequence', 'b-serves-before-open',
                                            'b-serves-before-open-commits',
                                            'guards-on-committed']]
    jobs += [(n, 'three') for n in ['fixed', 'no-exporting']]
    return jobs


def run(name, bound='move', verbose=True, progress=False, cap=None):
    m = Model(name, **BOUNDS[bound][1])
    lim = cap if VARIANTS[name][0] == 'mutant' else None
    seen, first, edges, dt = explore(m, limit=lim, progress=progress)
    capped = lim is not None and bool(first) and len(seen) > lim
    res = {'name': name, 'bound': bound, 'kind': VARIANTS[name][0], 'capped': capped,
           'states': len(seen), 'edges': edges, 'secs': dt, 'failed': sorted(first),
           'steps': {p: depth(seen, v[2]) if v[3] == 'state' else depth(seen, v[0]) + 1
                     for p, v in first.items()}}
    lv = liveness(m, seen)
    res['live_nodes'], res['live_starts'], res['live_stuck'] = lv[0], lv[1], lv[2]
    if lv[2]:
        res['failed'] = sorted(set(res['failed']) | {7})
        res['steps'][7] = depth(seen, lv[3][0])
    if verbose:
        kind, what, _ = VARIANTS[name]
        capw = (' (stopped at the cap, after a failure)') if capped else ''
        print(f'\n=== {name} ({kind}) on bound {bound!r}: {what}')
        print(f'    bound: {BOUNDS[bound][1]}')
        print(f'    {len(seen):,} states, {edges:,} transitions, {dt:.1f}s; '
              f'liveness graph {lv[0]:,} states from {lv[1]:,} starts, {lv[4]:.1f}s{capw}')
        for p in sorted(PROPS):
            ok = (p not in first) if p != 7 else not lv[2]
            print(f'    property {p}: {"holds" if ok else "FAILS"}  ({PROPS[p]})')
        for p in sorted(first):
            s, lab, t, how = first[p]
            print(f'\n  -- shortest counterexample to property {p}'
                  + (' (on a transition)' if how == 'edge' else '') + ':')
            if how == 'edge':
                print_trace(seen, s, m.K, extra=say(lab) + '  <- this position is not new')
            else:
                print_trace(seen, t, m.K)
        if lv[2]:
            orig, node = lv[3]
            print('\n  -- shortest counterexample to property 7 (liveness):')
            print_trace(seen, orig, m.K, extra='every message in flight is lost; '
                        'from here no more faults happen')
            print('     no sequence of steps from here finishes or cancels every move.')
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--only', help='comma-separated run names (default: all)')
    ap.add_argument('--bound', default=None,
                    help='comma-separated bounds: ' + ', '.join(BOUNDS))
    ap.add_argument('--quick', action='store_true', help='same as --bound quick')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--jobs', type=int, default=1)
    ap.add_argument('--progress', action='store_true')
    ap.add_argument('--cap', type=int, default=1_000_000,
                    help='stop a mutant run past this many states once a safety '
                         'property has failed (0: explore every mutant in full)')
    a = ap.parse_args()
    a.cap = a.cap or None
    if a.list:
        for k, (kind, what, _) in VARIANTS.items():
            print(f'{k:32} {kind:8} {what}')
        for k, (what, kw) in BOUNDS.items():
            print(f'bound {k:6} {what}')
        return
    names = a.only.split(',') if a.only else list(VARIANTS)
    bounds = ['quick'] if a.quick else (a.bound.split(',') if a.bound else None)
    for n in names:
        if n not in VARIANTS:
            sys.exit(f'unknown run {n!r}; see --list')
    for b in bounds or []:
        if b not in BOUNDS:
            sys.exit(f'unknown bound {b!r}; see --list')
    if bounds is None and not a.only:
        jobs = plan()                       # the default: the runs in slot_move.md
    else:
        jobs = [(n, b) for b in (bounds or list(BOUNDS)) for n in names]
    results = []
    if a.jobs > 1 and len(jobs) > 1:
        from concurrent.futures import ProcessPoolExecutor
        with ProcessPoolExecutor(a.jobs) as ex:
            futs = [ex.submit(_captured, n, b, a.cap) for n, b in jobs]
            for f in futs:
                text, r = f.result()
                print(text, end='', flush=True)
                results.append(r)
    else:
        for n, b in jobs:
            results.append(run(n, b, progress=a.progress, cap=a.cap))
    print('\n=== summary')
    print(f'    {"run":32} {"bound":6} {"kind":8} {"states":>11} {"live":>9}  result '
          '(property: steps in its shortest counterexample)')
    for r in results:
        f = r['failed']
        verdict = 'all hold' if not f else 'fails ' + ', '.join(
            f'{p}:{r["steps"][p]}' for p in f)
        cp = '+' if r.get('capped') else ' '
        print(f'    {r["name"]:32} {r["bound"]:6} {r["kind"]:8} {r["states"]:>11,}{cp}'
              f'{r["live_nodes"]:>9,}  {verdict}')
    if any(r.get('capped') for r in results):
        print('    + stopped at --cap after a safety property failed; the count is '
              'what was explored')


def _captured(name, bound, cap=None):
    import io
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        r = run(name, bound, cap=cap)
    return buf.getvalue(), r


if __name__ == '__main__':
    main()
