#!/usr/bin/env python3
"""
slot_move.py: an exhaustive model checker for the v5 slot move.

It models DESIGN-V5.md 4.2 "Moving a slot" (with 2 "Positions", 4.3 dedup and
4.4 readiness) and explores every reachable state by breadth-first search, so
each counterexample it prints is a shortest one. Plain Python 3, standard
library only. See slot_move.md for what it models and what it found.

    python3 slot_move.py --jobs 4            # every run on the deep and wide bounds
    python3 slot_move.py --jobs 4 --cap 0    # ...with every mutant explored in full
    python3 slot_move.py --only design       # one run (comma-separated names)
    python3 slot_move.py --bound deep        # one bound (quick, deep, wide)
    python3 slot_move.py --quick             # the smoke-test bound, seconds
    python3 slot_move.py --list              # the run names and the bounds

THE MODEL IN ONE PARAGRAPH. Two shards, A and B, each an abstract Raft group:
a committed log, the current leader's uncommitted tail, and a count of
depositions. A deposition drops the tail; the new leader's tail is any prefix
of the old tail or of a tail lost earlier and not yet overwritten by a commit
(so the new leader may have none, some or all of it, as in Raft). A commit
moves the tail's first entry into the committed log. Leaders judge writes
against their log end (committed plus tail) and act on move steps only when
the entries are committed. Slot s moves from A to B; slot t stays at A. One
client (one issuer) issues a few writes with rising call ids, each to s or t,
and may resend each one, to either shard (a stale or fresh slot table).
Messages sit in a set: delivery does not remove them (duplication), any of
them may be delivered at any time (delay, reordering), and a message never
delivered is a lost one. Answers wait for commit, and are lost on deposition.
"""

import argparse
import sys
import time
from collections import deque

S, T = 's', 't'
EMPTY = frozenset()

# ----------------------------------------------------------------------------
# Log entries (tuples, so states hash):
#   ('w', aid, seq)                 a write to slot s, stamped with s's sequence
#   ('wt', aid)                     a write to slot t (t never moves)
#   ('importing',)                  B: importing(s, from A)          step 1
#   ('imp', to, ws, end, carried)   B: an import entry: A's records of s up to
#                                   seq `to` (ws = {(aid, seq)}); end = N once
#                                   END(N) arrived; carried = (outcomes, highest)
#   ('open', N)                     B: open(s, N)                    step 3
#   ('abort',)                      B: abort(s)
#   ('fenced', N)                   A: fenced(s, to B, N)             step 2
#   ('cancel',)                     A: the move is cancelled, after B's abort
#
# A shard is (committed, tail, (depositions, inherited), lost_tails,
# pending_answers, buffer). `inherited` counts the tail entries the leader got
# from earlier leaders; only the reading of 2 "Positions" uses it (else 0).
# `buffer` is a leader's volatile copy; only the mutant that skips writing the
# copy into the log uses it.
#
# Messages:
#   ('req', dst, aid, copy, resent)    client -> shard (copy 1 is the first send)
#   ('data', q, ws, end, carried)      A -> B: s's committed records up to q
#                                      (state mode: B keeps those above its own
#                                      position), END(N) and the carried state
#   ('imp_ok',), ('aborted',)          B -> A: an UNCOMMITTED importing or abort;
#                                      only in the two mutants that act on one
# B's committed facts ("importing committed", "abort committed", its live
# subscription) need no message: see the comment in Model.succ.
#
# Answers 'moved' and 'retry' are not definitive. They are modelled as the shard
# changing nothing; the client may resend to either shard at any time anyway.
# ----------------------------------------------------------------------------

# Variants. A "reading" is the design under a literal reading of a sentence that
# can be read two ways; a "mutant" removes or changes one rule.
VARIANTS = {
    'design': ('design', 'The design as written, every guard read the safe way.'),
    # readings: "Every step acts only on committed entries", applied to a guard
    # that tests for the ABSENCE of an entry
    'read-A-fence-committed': ('reading',
        '"A appends nothing to s after the fence", with the fence looked for in '
        'committed entries only'),
    'read-B-abort-committed': ('reading',
        '"B aborts only before open", with open looked for in committed entries only'),
    'read-B-open-committed': ('reading',
        'B appends open when no abort is committed (abort looked for in committed '
        'entries only)'),
    # reading of 2 "Positions": "A new leader stamps on from its committed state,
    # after any uncommitted tail it drops", for a leader that keeps that tail
    'read-new-leader-stamps-committed': ('reading',
        'a new leader stamps on from its committed state, though it keeps the '
        'earlier tail (4.3: "Raft never drops them")'),
    # mutants: one rule removed
    'fence-before-importing-commits': ('mutant',
        'A fences once B has APPENDED importing (B reports it uncommitted)'),
    'stream-before-fence-commits': ('mutant',
        'A answers moved(B) and streams the delta and END(N) once fenced is appended'),
    'b-serves-before-open-commits': ('mutant',
        'B serves s once open is appended, before it commits'),
    'b-serves-before-open': ('mutant',
        'B serves s once the copy and END(N) are committed, before writing open'),
    'open-before-copy-logged': ('mutant',
        'B keeps the copy in memory and commits open(s, N) without writing the '
        'copy into its log'),
    'fence-N-from-committed': ('mutant',
        'N is s\'s last COMMITTED sequence, not the last one in A\'s log'),
    'stamp-from-committed': ('mutant',
        'a leader stamps the next sequence from its committed state, ignoring its '
        'own tail'),
    'no-carried-sequence': ('mutant',
        'B stamps from its own writes, not from the imported sequence'),
    'no-carried-outcomes': ('mutant',
        'the carried state leaves out the outcomes tagged with s'),
    'no-max-merge': ('mutant',
        'B does not merge the issuer\'s highest call id by max'),
    'cancel-on-appended-abort': ('mutant',
        'A cancels once B has APPENDED abort (B reports it uncommitted)'),
    'cancel-without-abort': ('mutant',
        'A cancels a fenced move on its own (say on a timeout), without B\'s abort'),
    'b-aborts-after-open': ('mutant',
        'B may abort at any time, even after open'),
}


def has(entries, kind):
    for e in entries:
        if e[0] == kind:
            return True
    return False


def a_fence(entries):
    """A's fence over these entries: (fenced and not cancelled, N)."""
    f, n = False, None
    for e in entries:
        if e[0] == 'fenced':
            f, n = True, e[1]
        elif e[0] == 'cancel':
            f = False
    return f, n


def s_pos(entries, imports=True):
    """s's sequence at the end of these entries."""
    p = 0
    for e in entries:
        k = e[0]
        if k == 'w':
            if e[2] > p:
                p = e[2]
        elif k == 'imp' and imports:
            if e[1] > p:
                p = e[1]
    return p


def imp_pos(entries):
    """How far an import has copied s (the highest `to` of its import entries)."""
    p = 0
    for e in entries:
        if e[0] == 'imp' and e[1] > p:
            p = e[1]
    return p


def imp_end(entries):
    for e in entries:
        if e[0] == 'imp' and e[3] is not None:
            return e[3]
    return None


def s_state(entries):
    """s's rows in these entries, as (aid, seq) pairs."""
    st = set()
    for e in entries:
        if e[0] == 'w':
            st.add((e[1], e[2]))
        elif e[0] == 'imp':
            st |= e[2]
    return st


def walk_ok(entries):
    """Property 6, per shard: a write's sequence is above everything before it,
    and no fence, import or open names a sequence below the slot's position."""
    pos = 0
    for e in entries:
        k = e[0]
        if k == 'w':
            if e[2] <= pos:
                return False
            pos = e[2]
        elif k in ('imp', 'fenced', 'open'):
            if e[1] < pos:
                return False
            pos = e[1]
    return True


def walk_pos(entries):
    pos = 0
    for e in entries:
        if e[0] == 'w' or e[0] in ('imp', 'fenced', 'open'):
            v = e[2] if e[0] == 'w' else e[1]
            if v > pos:
                pos = v
    return pos


def append(sh, e):
    return (sh[0], sh[1] + (e,), sh[2], sh[3], sh[4], sh[5])


def answer(sh, aid, copy, kind, seq, wait):
    """An answer waits until the commit offset reaches `wait` (4.3). Returns
    the shard and the answers released now."""
    if wait <= len(sh[0]):
        return sh, ((aid, copy, kind, seq),)
    return (sh[0], sh[1], sh[2], sh[3], sh[4] | {(aid, copy, kind, seq, wait)}, sh[5]), ()


def commit(sh):
    com, tail, deps, lost, pend, buf = sh
    com = com + tail[:1]
    tail = tail[1:]
    if deps[1]:
        deps = (deps[0], deps[1] - 1)
    n = len(com)
    rel = tuple(p[:4] for p in pend if p[4] <= n)
    if rel:
        pend = frozenset(p for p in pend if p[4] > n)
    # Once the current leader commits, its term's entry is on a majority, so no
    # tail lost by an earlier leader can come back (Raft's election rule).
    return (com, tail, deps, EMPTY, pend, buf), rel


def take(cl, rel):
    """The client takes each released answer at once, or it is lost. (Taking it
    later is the same: taking changes only the client, which commutes with every
    shard step, and an answer that arrives after a resend is ignored.) An issuer
    takes only the answer to its latest copy of a pending attempt (4.3)."""
    outs = [(cl, ())]
    for (aid, copy, kind, seq) in rel:
        nxt = []
        for c, took in outs:
            nxt.append((c, took))
            s, q, cp = c[aid - 1]
            if s == 1 and cp == copy:
                new = (2, seq, cp) if kind == 'ok' else (3, None, cp)
                nxt.append((c[:aid - 1] + (new,) + c[aid:], took + ((aid, copy, kind, seq),)))
        outs = nxt
    return outs


def norm_lost(lost, tail):
    """Drop lost tails that are prefixes of the current tail or of another."""
    keep = []
    for g in lost:
        if not g or tail[:len(g)] == g:
            continue
        if any(h != g and h[:len(g)] == g for h in lost):
            continue
        keep.append(g)
    return frozenset(keep)


class Model:
    def __init__(self, variant='design', writes=(S, S, T), window=2, resends=1,
                 deposes=2, keep_prefix=True):
        self.v = variant
        self.writes = tuple(writes)
        self.W = window
        self.R = resends
        self.D = deposes
        self.keep = keep_prefix
        self.slot = {i + 1: w for i, w in enumerate(self.writes)}

    # ------------------------------------------------------------------ setup
    def init(self):
        sh = ((), (), (0, 0), EMPTY, EMPTY, ())
        cl = tuple((0, None, 0) for _ in self.writes)
        return (sh, sh, cl, EMPTY, False)

    # ------------------------------------------------------------ dedup (4.3)
    def dedup(self, entries, extra=()):
        """Outcomes {aid: (kind, seq, wait)} and the highest call id seen."""
        out = {}
        hi, hi_wait = 0, 0
        nomerge = self.v == 'no-max-merge'
        for i, e in enumerate(tuple(entries) + tuple(extra)):
            w = i + 1 if i < len(entries) else 0   # a volatile copy answers at once
            k = e[0]
            if k == 'w':
                a = e[1]
                out[a] = ('ok', e[2], w)
            elif k == 'wt':
                a = e[1]
                out[a] = ('ok', None, w)
            elif k == 'imp' and e[4] is not None:
                outs, h = e[4]
                for (oa, kind, sq) in outs:
                    out[oa] = (kind, sq, w)
                a = max((o[0] for o in outs), default=0) if nomerge else h
            else:
                continue
            if a > hi:
                hi, hi_wait = a, w
        return out, hi, hi_wait

    def judge(self, entries, aid, extra=()):
        out, hi, hi_wait = self.dedup(entries, extra)
        floor = hi - self.W if self.W else -1
        # Outcomes at or below the floor may have been dropped; assume they were.
        if aid in out and aid > floor:
            return ('hit',) + out[aid]
        if aid <= floor:
            return ('stale', hi_wait)
        return ('fresh',)

    def carried(self, entries):
        """A's carried state: s's outcomes above the floor, and the highest id."""
        out, hi, _ = self.dedup(entries)
        if self.v == 'no-carried-outcomes':
            return (EMPTY, hi)
        floor = hi - self.W if self.W else -1
        outs = frozenset((a, k, sq) for a, (k, sq, _) in out.items()
                         if self.slot[a] == S and a > floor)
        return (outs, hi)

    def next_seq(self, sh, dst):
        le = sh[0] + sh[1] + sh[5]
        if self.v == 'stamp-from-committed':
            le = sh[0] + sh[5]
        elif self.v == 'read-new-leader-stamps-committed':
            le = sh[0] + sh[1][sh[2][1]:] + sh[5]     # skip the inherited tail
        if dst == 'B' and self.v == 'no-carried-sequence':
            return s_pos(le, imports=False) + 1
        return s_pos(le) + 1

    # ------------------------------------------------------------ the guards
    def a_closed(self, A):
        """A takes no write to s: after the fence (answers retry, then moved(B))."""
        src = A[0] if self.v == 'read-A-fence-committed' else A[0] + A[1]
        return a_fence(src)[0]

    def b_serving(self, B):
        """B serves s only after open commits (4.2 step 3, 4.4)."""
        Bc = B[0]
        if self.v == 'b-serves-before-open-commits':
            le = Bc + B[1]
            return has(le, 'open') and not has(le, 'abort')
        if self.v == 'b-serves-before-open':
            n = imp_end(Bc)
            return (n is not None and imp_pos(Bc) == n
                    and not has(Bc + B[1], 'abort'))
        return has(Bc, 'open')

    # ------------------------------------------------------------ successors
    def succ(self, st, nofault=False):
        A, B, cl, net, started = st
        res = []
        add = res.append
        v = self.v
        Ac, Bc = A[0], B[0]
        Ale, Ble = Ac + A[1], Bc + B[1]

        # ---- the client (an issuer, 4.3): ids rise, the window bounds them
        if not nofault:
            pending = [i + 1 for i, c in enumerate(cl) if c[0] == 1]
            for i, (s, q, c) in enumerate(cl):
                aid = i + 1
                dsts = ('A', 'B') if self.slot[aid] == S else ('A',)
                if s == 0:
                    if self.W and aid - min(pending + [aid]) >= self.W:
                        break
                    ncl = cl[:i] + ((1, None, 1),) + cl[i + 1:]
                    for d in dsts:
                        add((('issue', aid, d),
                             (A, B, ncl, net | {('req', d, aid, 1, False)}, started)))
                    break
                if s == 1 and c <= self.R:
                    ncl = cl[:i] + ((1, None, c + 1),) + cl[i + 1:]
                    for d in dsts:
                        add((('resend', aid, c + 1, d),
                             (A, B, ncl, net | {('req', d, aid, c + 1, True)}, started)))

        # ---- deliveries (non-consuming: duplicates, delay, reordering)
        for msg in net:
            k = msg[0]
            if k == 'req':
                if nofault:
                    continue
                r = self.on_req(st, msg)
            elif k == 'data':
                r = self.on_data(st, msg)
            elif k == 'imp_ok':                     # one mutant only
                r = self.fence(st)
            else:                                   # 'aborted', one mutant only
                r = self.cancel(st)
            if r is not None:
                if k == 'req':
                    res.extend(r)
                else:
                    add(r)

        # B's three reports to A ("importing committed", "abort committed", and
        # its live subscription to s) state facts of B's COMMITTED log, which
        # never become false. A message sent once such a fact holds, delivered
        # at any later time, is the same as A acting on the fact at any later
        # time, so A reads B's committed log directly. (The one mutant whose
        # report can go stale keeps a real message.)
        bc_imp = has(Bc, 'importing')

        # ---- step 1: B's leader appends importing(s, from A). The move is
        # started once; nobody re-drives it if the entry is lost uncommitted.
        if not started:
            add((('B-start',), (A, append(B, ('importing',)), cl, net, True)))

        # ---- step 2: A's leader fences after B reports importing committed
        if v == 'fence-before-importing-commits':
            if has(Ble, 'importing') and ('imp_ok',) not in net:
                add((('B-report-early',), (A, B, cl, net | {('imp_ok',)}, started)))
        elif bc_imp:
            r = self.fence(st)
            if r is not None:
                add(r)

        # ---- step 2: A answers B's subscription (state mode), END after fence
        if bc_imp and not has(Bc, 'open') and not has(Bc, 'abort'):
            r = self.send(st)
            if r is not None:
                add(r)

        # ---- step 3: B's leader appends open(s, N) once the copy, END(N) and the
        # carried state are committed in its own log
        if has(Bc, 'importing') and not has(Ble, 'open'):
            ab_src = Bc if v == 'read-B-open-committed' else Ble
            if not has(ab_src, 'abort'):
                cview = B[5] if v == 'open-before-copy-logged' else Bc
                n = imp_end(cview)
                if n is not None and imp_pos(cview) == n:
                    add((('B-open', n), (A, append(B, ('open', n)), cl, net, started)))

        # ---- B aborts, only before open (a choice, not a fault)
        if not nofault and has(Ble, 'importing') and not has(Ble, 'abort'):
            if v == 'b-aborts-after-open':
                ok = True
            elif v == 'read-B-abort-committed':
                ok = not has(Bc, 'open')
            else:
                ok = not has(Ble, 'open')
            if ok:
                add((('B-abort',), (A, append(B, ('abort',)), cl, net, started)))

        # ---- A cancels, only after B's abort has committed
        if v == 'cancel-on-appended-abort':
            if has(Ble, 'abort') and ('aborted',) not in net:
                add((('B-report-abort-early',), (A, B, cl, net | {('aborted',)}, started)))
        elif has(Bc, 'abort'):
            r = self.cancel(st)
            if r is not None:
                add(r)

        # ---- mutant: A cancels on its own
        if (v == 'cancel-without-abort' and not nofault and a_fence(Ale)[0]
                and not has(Ale, 'cancel')):
            add((('A-cancel-alone',), (append(A, ('cancel',)), B, cl, net, started)))

        # ---- Raft: commits and depositions
        if A[1]:
            na, rel = commit(A)
            for ncl, took in (take(cl, rel) if cl is not None else [(cl, ())]):
                add((('commit', 'A', A[1][0], took), (na, B, ncl, net, started)))
        if B[1]:
            nb, rel = commit(B)
            for ncl, took in (take(cl, rel) if cl is not None else [(cl, ())]):
                add((('commit', 'B', B[1][0], took), (A, nb, ncl, net, started)))
        if not nofault:
            for x, sh in (('A', A), ('B', B)):
                for nsh in self.deposes(sh):
                    t = (nsh, B, cl, net, started) if x == 'A' else (A, nsh, cl, net, started)
                    add((('depose', x, nsh[1]), t))
        return res

    def deposes(self, sh):
        com, tail, deps, lost, pend, buf = sh
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
        inh = self.v == 'read-new-leader-stamps-committed'
        return [(com, c, (deps[0] + 1, len(c) if inh else 0), norm_lost(lost2, c), EMPTY, ())
                for c in cands]

    # ------------------------------------------------------------ handlers
    def on_req(self, st, msg):
        _, d, aid, copy, resent = msg
        A, B, cl, net, started = st
        slot = self.slot[aid]
        if d == 'A':
            sh = A
            if slot == S and self.a_closed(A):
                return None                 # retry, then moved(B): not definitive
        else:
            sh = B
            if slot == T or not self.b_serving(B):
                return None                 # moved(A) or retry: not definitive
        le = sh[0] + sh[1]
        n = len(le)
        r = self.judge(le, aid, sh[5])
        if r[0] == 'hit':
            _, kind, seq, wait = r
            sh2, rel = answer(sh, aid, copy, kind, seq, wait)
            lab = ('dedup', d, aid, copy, kind, seq)
        elif r[0] == 'stale':
            # Not appended, even for a resent copy: the floor that refuses it is
            # the highest id, already in the log, and it only rises. (Appending
            # it, as "a refusal of a resent attempt" literally says, would let
            # each duplicate of a late copy below the floor grow the log, since
            # that outcome sits below the floor and may be dropped at once.)
            sh2, rel = answer(sh, aid, copy, 'stale', None, r[1])
            lab = ('stale', d, aid, copy)
        else:
            if slot == S:
                seq = self.next_seq(sh, d)
                sh1 = append(sh, ('w', aid, seq))
            else:
                seq = None
                sh1 = append(sh, ('wt', aid))
            sh2, rel = answer(sh1, aid, copy, 'ok', seq, n + 1)
            lab = ('append', d, aid, copy, seq)
        out = []
        for ncl, took in take(cl, rel):
            if sh2 == sh and ncl == cl:
                continue
            t = (sh2, B, ncl, net, started) if d == 'A' else (A, sh2, ncl, net, started)
            out.append((lab + (took,), t))
        return out

    def fence(self, st):
        A, B, cl, net, started = st
        Ale = A[0] + A[1]
        if has(Ale, 'fenced') or has(Ale, 'cancel'):
            return None
        src = A[0] if self.v == 'fence-N-from-committed' else Ale
        n = s_pos(src)
        return (('A-fence', n), (append(A, ('fenced', n)), B, cl, net, started))

    def cancel(self, st):
        A, B, cl, net, started = st
        if has(A[0] + A[1], 'cancel'):
            return None
        return (('A-cancel',), (append(A, ('cancel',)), B, cl, net, started))

    def send(self, st):
        """A answers B's live subscription to s in state mode: s's committed
        records (B keeps those above its own position), then END(N) and the
        carried state once the fence has committed."""
        A, B, cl, net, started = st
        Ac = A[0]
        if has(Ac, 'cancel'):
            return None
        src = Ac + A[1] if self.v == 'stream-before-fence-commits' else Ac
        fenced, n = a_fence(src)
        if fenced:
            ws = frozenset((e[1], e[2]) for e in src if e[0] == 'w' and e[2] <= n)
            d = ('data', n, ws, n, self.carried(src))
        else:
            q = s_pos(Ac)
            if q == 0:
                return None
            ws = frozenset((e[1], e[2]) for e in Ac if e[0] == 'w')
            d = ('data', q, ws, None, None)
        if d in net:
            return None
        return (('A-send', d[1], d[3]), (A, B, cl, net | {d}, started))

    def on_data(self, st, msg):
        _, q, ws, end, car = msg
        A, B, cl, net, started = st
        Bc = B[0]
        Ble = Bc + B[1]
        if not has(Bc, 'importing') or has(Ble, 'open') or has(Ble, 'abort'):
            return None
        view = Ble + B[5]
        pos = s_pos(view)
        if not (q > pos or (end is not None and imp_end(view) is None)):
            return None
        e = ('imp', q, frozenset(w for w in ws if w[1] > pos), end, car)
        if self.v == 'open-before-copy-logged':
            nb = (B[0], B[1], B[2], B[3], B[4], B[5] + (e,))
        else:
            nb = append(B, e)
        mem = self.v == 'open-before-copy-logged'
        return (('B-import', pos, q, end, mem), (A, nb, cl, net, started))

    # ------------------------------------------------------------ dead messages
    def gc(self, st):
        """Drop what can never change anything again: pending answers the client
        can no longer take (not its latest copy, or the attempt is answered), a
        copy B can no longer use, and B's report once A has fenced or cancelled."""
        A, B, cl, net, started = st
        if cl is not None and (A[4] or B[4]):
            sh2 = []
            for sh in (A, B):
                if sh[4]:
                    keep = frozenset(p for p in sh[4]
                                     if cl[p[0] - 1][0] == 1 and cl[p[0] - 1][2] == p[1])
                    if len(keep) != len(sh[4]):
                        sh = (sh[0], sh[1], sh[2], sh[3], keep, sh[5])
                sh2.append(sh)
            A, B = sh2
            st = (A, B, cl, net, started)
        dead = None
        for m in net:
            k = m[0]
            if k == 'data':
                Bc = B[0]
                if (has(Bc, 'open') or has(Bc, 'abort') or
                        (m[1] <= imp_pos(Bc) and (m[3] is None or imp_end(Bc) is not None))):
                    dead = (dead or []) + [m]
            elif k == 'imp_ok':
                if has(A[0], 'fenced') or has(A[0], 'cancel'):
                    dead = (dead or []) + [m]
            elif k == 'aborted':
                if has(A[0], 'cancel'):
                    dead = (dead or []) + [m]
        if dead:
            return (A, B, cl, net - frozenset(dead), started)
        return st

    # ------------------------------------------------------------ properties
    def b_auth(self, B):
        """B holds s: a committed open with no committed abort after it."""
        op = False
        for e in B[0]:
            if e[0] == 'open':
                op = True
            elif e[0] == 'abort' and op:
                op = False
        return op

    def auth_rows(self, st):
        A, B = st[0], st[1]
        if self.b_auth(B):
            return s_state(B[0]) | s_state(B[5])
        return s_state(A[0])

    def auth_pos(self, st):
        A, B = st[0], st[1]
        if self.b_auth(B):
            return max(walk_pos(B[0]), walk_pos(B[5]))
        return walk_pos(A[0])

    def check(self, st):
        A, B, cl, net, started = st
        Ac, Bc = A[0], B[0]
        bad = []
        # 1. at most one shard has a committed open for s with no later fenced
        a_open = not a_fence(Ac)[0]
        b_open = has(Bc, 'open')
        if a_open and b_open:
            bad.append(1)
        # 2. no slot sequence number stamped on committed records by both shards
        a_seqs = {e[2] for e in Ac if e[0] == 'w'}
        b_seqs = {e[2] for e in Bc if e[0] == 'w'}
        if a_seqs & b_seqs:
            bad.append(2)
        # 3. every write committed to s at A before the fence is in B's state at open
        if b_open:
            pre = set()
            for e in Ac:
                if e[0] == 'fenced':
                    break
                if e[0] == 'w':
                    pre.add((e[1], e[2]))
            got = set()
            for e in Bc:
                if e[0] == 'open':
                    break
                if e[0] == 'imp':
                    got |= e[2]
            got |= s_state(B[5])
            if not pre <= got:
                bad.append(3)
        # 4. no write acknowledged as committed and then missing from s's state
        rows = None
        a_t = None
        cnt = {}
        for e in Ac + Bc:
            if e[0] in ('w', 'wt'):
                cnt[e[1]] = cnt.get(e[1], 0) + 1
        for i, (s, q, c) in enumerate(cl):
            aid = i + 1
            if s == 2:
                if self.slot[aid] == S:
                    if rows is None:
                        rows = self.auth_rows(st)
                    if (aid, q) not in rows:
                        bad.append(4)
                        break
                else:
                    if a_t is None:
                        a_t = {e[1] for e in Ac if e[0] == 'wt'}
                    if aid not in a_t:
                        bad.append(4)
                        break
        # 5. no attempt id commits twice
        if any(n > 1 for n in cnt.values()):
            bad.append(5)
        # 6. a slot's sequence never goes back (per shard; across shards on edges)
        if not walk_ok(Ac) or not walk_ok(B[5] + Bc):
            bad.append(6)
        # 8 (added). an attempt its issuer took as refused never commits
        for i, (s, q, c) in enumerate(cl):
            if s == 3 and cnt.get(i + 1):
                bad.append(8)
                break
        return bad

    # ------------------------------------------------------------ liveness
    def done(self, st):
        A, B = st[0], st[1]
        Ac, Bc = A[0], B[0]
        if has(Bc, 'open'):
            return True                                 # completed
        if has(Bc, 'abort') and has(Ac, 'cancel'):
            return True                                 # aborted, both sides
        if not has(Bc + B[1], 'importing') and not has(Ac + A[1], 'fenced'):
            return True                                 # never got going: nobody waits
        return False


# ============================================================================
# The search
# ============================================================================

PROPS = {
    1: 'at most one shard has a committed open for s with no later committed fenced',
    2: 'no slot sequence number is stamped on committed records by both shards',
    3: 'every write committed to s at A before the fence is in B\'s state when B opens',
    4: 'no write is acknowledged as committed and then missing from s\'s state',
    5: 'no attempt id commits twice',
    6: 'a slot\'s sequence never goes back',
    7: 'liveness: with no more faults (and no new abort), the move completes or aborts',
    8: '(added) an attempt its issuer took as refused never commits',
}


def explore(model, limit=None, progress=False):
    init = model.init()
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
        apos = None
        for lab, t in model.succ(s):
            t = model.gc(t)
            edges += 1
            # property 6 across shards: only a commit changes a committed log
            if lab[0] == 'commit' and 6 not in first:
                if apos is None:
                    apos = model.auth_pos(s)
                if model.auth_pos(t) < apos:
                    first[6] = (s, lab, t, 'edge')
            if t in seen:
                continue
            t = (canon(t[0]), canon(t[1]), canon(t[2]), canon(t[3]), t[4])
            seen[t] = (s, lab)
            for p in model.check(t):
                if p not in first:
                    first[p] = (s, lab, t, 'state')
            q.append(t)
        if progress and len(seen) % 500000 == 0:
            print(f'    .. {len(seen):,} states, queue {len(q):,}, '
                  f'{time.time() - t0:.0f}s', file=sys.stderr, flush=True)
        if limit and len(seen) > limit and first:
            break
    return seen, first, edges, time.time() - t0


def liveness(model, seen):
    """Property 7, bounded: from every reachable state, with every message lost
    and then no more faults (no deposition, no loss, no new abort; clients
    idle), some path reaches done. Checked as AG EF done over the no-fault
    graph, which under strong fairness means the move finishes."""
    t0 = time.time()
    idx = {}
    nodes = []
    origin = []
    for st in seen:
        A, B, cl, net, started = st
        pa = (A[0], A[1], (0, 0), EMPTY, EMPTY, A[5])
        pb = (B[0], B[1], (0, 0), EMPTY, EMPTY, B[5])
        p = (pa, pb, None, EMPTY, started)
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
            t = model.gc(t)
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
        # the stuck start (a reachable state with its messages lost) with the
        # shortest trace
        starts = [k for k in stuck if k < n0]
        best = None
        for k in starts:
            d = depth(seen, origin[k])
            if best is None or d < best[0]:
                best = (d, k)
        if best is None:          # stuck only after some no-fault steps
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

def ent(e):
    k = e[0]
    if k == 'w':
        return f'w{e[1]}@{e[2]}'
    if k == 'wt':
        return f'w{e[1]}(t)'
    if k == 'importing':
        return 'importing'
    if k == 'imp':
        ws = ','.join(f'w{a}@{q}' for a, q in sorted(e[2]))
        s = f'import(to {e[1]}' + (f': {ws}' if ws else '')
        if e[3] is not None:
            outs, hi = e[4]
            o = ','.join(f'w{a}' for a, _, _ in sorted(outs))
            s += f'; END({e[3]}); outcomes {{{o}}}; highest id {hi}'
        return s + ')'
    if k == 'open':
        return f'open(N={e[1]})'
    if k == 'abort':
        return 'abort'
    if k == 'fenced':
        return f'fenced(N={e[1]})'
    if k == 'cancel':
        return 'cancel'
    return str(e)


def took_text(took):
    out = []
    for (aid, copy, kind, seq) in took:
        r = f'committed at {seq}' if kind == 'ok' and seq is not None else (
            'committed' if kind == 'ok' else 'refused stale-attempt')
        out.append(f'; the client gets the answer to w{aid} copy {copy}: {r}')
    return ''.join(out)


def say(lab):
    k = lab[0]
    if k == 'issue':
        return f'client sends w{lab[1]} (first copy) to {lab[2]}'
    if k == 'resend':
        return f'client resends w{lab[1]} (copy {lab[2]}) to {lab[3]}'
    if k == 'append':
        sq = f' with sequence {lab[4]}' if lab[4] is not None else ''
        return (f'{lab[1]} takes w{lab[2]} copy {lab[3]} as fresh and appends it{sq}, '
                'uncommitted' + took_text(lab[5]))
    if k == 'dedup':
        at = f' at {lab[5]}' if lab[5] is not None else ''
        return (f'{lab[1]} finds w{lab[2]} among its outcomes; answers copy {lab[3]} '
                f'"{lab[4]}"{at} once that outcome is committed' + took_text(lab[6]))
    if k == 'stale':
        return (f'{lab[1]} refuses w{lab[2]} copy {lab[3]} stale-attempt (at or below '
                'the floor)' + took_text(lab[4]))
    if k == 'B-start':
        return "B's leader appends importing(s, from A), uncommitted"
    if k == 'B-report-early':
        return 'B tells A "importing appended" (not yet committed)'
    if k == 'B-report-abort-early':
        return 'B tells A "abort appended" (not yet committed)'
    if k == 'A-send':
        if lab[2] is not None:
            return f"A sends B s's records up to {lab[1]}, END({lab[2]}) and the carried state"
        return f"A sends B s's committed records up to {lab[1]}"
    if k == 'B-import':
        e = f', with END({lab[3]}) and the carried state' if lab[3] is not None else ''
        if lab[4]:
            return f'B keeps the copy of ({lab[1]}, {lab[2]}]{e} in its leader\'s memory'
        return f'B appends the copy of ({lab[1]}, {lab[2]}]{e}, uncommitted'
    if k == 'B-open':
        return f"B's leader appends open(s, N={lab[1]}), uncommitted"
    if k == 'B-abort':
        return "B's leader appends abort(s), uncommitted"
    if k == 'A-fence':
        return (f"A's leader, on B's report, appends "
                f"fenced(s, to B, N={lab[1]}), uncommitted")
    if k == 'A-cancel':
        return "A's leader, on B's abort report, appends cancel"
    if k == 'A-cancel-alone':
        return "A's leader appends cancel on its own"
    if k == 'commit':
        return f'{lab[1]} commits {ent(lab[2])}' + took_text(lab[3])
    if k == 'depose':
        kept = ', '.join(ent(e) for e in lab[2])
        return (f"{lab[1]}'s leader is deposed; the new leader's uncommitted tail is "
                + (f'[{kept}]' if kept else 'empty'))
    return str(lab)


def show_state(st):
    A, B, cl, net, started = st

    def sh(x):
        c = ', '.join(ent(e) for e in x[0]) or '-'
        t = ', '.join(ent(e) for e in x[1])
        return f'committed [{c}]' + (f' tail [{t}]' if t else '') + \
            (f' memory [{", ".join(ent(e) for e in x[5])}]' if x[5] else '')
    lines = [f'      A: {sh(A)}', f'      B: {sh(B)}']
    if cl is not None:
        cs = []
        for i, (s, q, c) in enumerate(cl):
            cs.append(f'w{i + 1}:' + ['unsent', 'pending', f'acked@{q}', 'refused'][s])
        lines.append('      client: ' + ' '.join(cs))
    return '\n'.join(lines)


def print_trace(seen, end, extra=None):
    steps = trace(seen, end)
    for n, (lab, st) in enumerate(steps, 1):
        print(f'   {n:2}. {say(lab)}')
    if extra:
        print(f'   {len(steps) + 1:2}. {extra}')
    print('     state now:')
    print(show_state(end))


# ============================================================================

BOUNDS = {
    # name: (what it is for, Model keyword arguments)
    'quick': ('a smoke test',
              dict(writes=(S, T), window=1, resends=1, deposes=1)),
    'deep': ('two writes to s in flight; two depositions per shard, so a lost '
             'tail can come back',
             dict(writes=(S, S), window=None, resends=1, deposes=2)),
    'wide': ('three writes (s, s, t) under the issuer window and the floor; one '
             'deposition per shard',
             dict(writes=(S, S, T), window=2, resends=1, deposes=1)),
}


def run(name, bound='deep', verbose=True, progress=False, cap=None):
    m = Model(name, **BOUNDS[bound][1])
    # A cap applies only to mutants, and only once a property has failed: the
    # design and the readings always explore their whole state space.
    lim = cap if VARIANTS[name][0] == 'mutant' else None
    seen, first, edges, dt = explore(m, limit=lim, progress=progress)
    capped = lim is not None and bool(first) and len(seen) > lim   # stopped early
    res = {'name': name, 'bound': bound, 'kind': VARIANTS[name][0], 'capped': capped,
           'states': len(seen), 'edges': edges, 'secs': dt,
           'failed': sorted(first),
           'steps': {p: depth(seen, v[2]) if v[3] == 'state' else depth(seen, v[0]) + 1
                     for p, v in first.items()}}
    lv = liveness(m, seen)
    res['live_nodes'], res['live_starts'], res['live_stuck'] = lv[0], lv[1], lv[2]
    capw = (' (stopped at the cap, after a failure: properties not shown failing '
            'were not explored in full)') if capped else ''
    res['live_secs'] = lv[4]
    if lv[2]:
        res['failed'] = sorted(set(res['failed']) | {7})
        res['steps'][7] = depth(seen, lv[3][0])
    if verbose:
        out = []
        kind, what = VARIANTS[name]
        print(f'\n=== {name} ({kind}) on bound {bound!r}: {what}')
        print(f'    bound: writes {m.writes}, window {m.W}, resends {m.R}, '
              f'depositions {m.D} per shard, lost tails may return: {m.keep}')
        print(f'    {len(seen):,} states, {edges:,} transitions, {dt:.1f}s; '
              f'liveness graph {lv[0]:,} states from {lv[1]:,} starts, {lv[4]:.1f}s{capw}')
        for p in sorted(PROPS):
            ok = (p not in first) if p != 7 else not lv[2]
            out.append(f'    property {p}: {"holds" if ok else "FAILS"}  ({PROPS[p]})')
        print('\n'.join(out))
        for p in sorted(first):
            s, lab, t, how = first[p]
            print(f'\n  -- shortest counterexample to property {p}'
                  + (' (on a transition)' if how == 'edge' else '') + ':')
            if how == 'edge':
                print_trace(seen, s, extra=say(lab) + "  <- the slot's sequence goes back here")
                print('     after it:')
                print(show_state(t))
            else:
                print_trace(seen, t)
        if lv[2]:
            orig, node = lv[3]
            print('\n  -- shortest counterexample to property 7 (liveness):')
            print_trace(seen, orig, extra='every message in flight is lost; '
                        'from here no more faults happen')
            print('     no sequence of steps from here completes or aborts the move.')
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--only', help='comma-separated run names (default: all)')
    ap.add_argument('--bound', default='deep,wide',
                    help='comma-separated bounds: ' + ', '.join(BOUNDS) + ' (default: deep,wide)')
    ap.add_argument('--quick', action='store_true', help='same as --bound quick')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--jobs', type=int, default=1)
    ap.add_argument('--progress', action='store_true')
    ap.add_argument('--cap', type=int, default=1_000_000,
                    help='stop a mutant run past this many states, once a safety property '
                         'has failed (default 1,000,000; 0 explores every mutant in full)')
    a = ap.parse_args()
    a.cap = a.cap or None
    if a.list:
        for k, (kind, what) in VARIANTS.items():
            print(f'{k:32} {kind:8} {what}')
        for k, (what, kw) in BOUNDS.items():
            print(f'bound {k:8} {what}: {kw}')
        return
    names = a.only.split(',') if a.only else list(VARIANTS)
    bounds = ['quick'] if a.quick else a.bound.split(',')
    for n in names:
        if n not in VARIANTS:
            sys.exit(f'unknown run {n!r}; see --list')
    for b in bounds:
        if b not in BOUNDS:
            sys.exit(f'unknown bound {b!r}; see --list')
    jobs = [(n, b) for b in bounds for n in names]
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
        print('    + stopped at --cap after a property failed; the count is what was explored')


def _captured(name, bound, cap=None):
    import io
    import contextlib
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        r = run(name, bound, cap=cap)
    return buf.getvalue(), r


if __name__ == '__main__':
    main()
