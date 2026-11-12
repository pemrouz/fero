"""
memrung.py: E-47. The `memory` rung inside Raft, on TiKV's shape: two Raft
groups, a timestamp oracle, Percolator's two-phase commit over multi-version
keys, a fenced lock, readers that resolve locks, and clients that retry.
The safety model VERDICT section 9 step 2b owes (K-09; RR-11 to RR-14).

THE WORLD (not counted)
  Groups. Two Raft groups of three replicas, A and B. Group A is the one a
  fault can hit: a majority of its replicas stops uncleanly. Group B never
  stops (a group that never loses anything needs no replicas in the model).
  Each group has a rung:
    P  persisted: a write is acknowledged once a majority has it on disk.
    M  memory:    a write is acknowledged once a majority holds it in memory;
                  the disks catch up in the background.
  Group A is kept as (log, k, term). The log is the leader's log, a tuple of
  (term, command). For M, every entry is committed at once (a follower holds
  it in memory as soon as it is appended) and k is the majority-synced point:
  the longest prefix that two replicas have on disk. For P, k is both the
  majority-synced point and the commit point (a write commits only when two
  replicas have it on disk). `sync` moves k to the end of the log.
  The unclean stop of a majority, then a restart and Raft's election, is one
  step: the new leader's log is the old log cut to any length l with
  k <= l <= len(log), plus a no-op of the new term. Why this is Raft: each
  stopped replica keeps only what it synced; the survivor (if any) keeps what
  it held; a candidate wins with a majority of votes only from replicas whose
  logs are no longer than its own; so the new leader's log is at least the
  second longest synced prefix (k) and at most the old log. tools/raftcheck.py
  checks that claim by brute force on three explicit replicas (each with its
  own log, sync point and up flag, and elections by vote): the cut lengths
  reachable there are exactly [k, len] (results/raftcheck.txt). One unclean
  stop per run (the bound `stops`), so no replica ever holds a divergent log
  that could win a later election.
  Clients. A command is a copy on the network until a leader appends it; a
  copy is delivered at most once, after any delay, in any order. The kernel
  judges each command when it applies it (K `kern`), so an answer is the
  command's result in the committed log. A client reads its answer only from
  the committed log; if the answer is lost (no answer and no copy in flight
  after the cut), it sends the same command again (budgets below).
  The timestamp oracle (TSO) is a counter in PD, which is `persisted` and
  never loses a step here.

THE STATE MACHINE (Percolator, as TiKV writes it; judged at apply)
  pw  (txn s, key k, primary p): lock k for s, unless s already has a write
      record at k (answer its outcome), or another txn holds k (locked), or a
      newer write exists (conflict).
  cm  (txn s, key k, commit ts c): if k holds s's lock, remove it and write a
      commit record (c, s); if s already has a record at k, answer it;
      otherwise answer `notfound`.
  chk (txn s, primary p): a reader that found s's lock expired asks the
      primary: if p holds s's lock, roll it back (write a rollback record); if
      p has s's commit record, answer `committed at c`; if p has nothing, write
      a rollback record (TiKV's protection against a late prewrite).
  res (txn s, key k, status): a reader rolls a secondary forward or back.
  claim (holder h): the lock row L takes h if it is free, h's own, or held by a
      token whose lease lapsed; the token is a TSO timestamp (tok=tso: the
      claim's commit timestamp, which is what a row's version is under MVCC)
      or the row's version counter plus one (tok=row, a variant).
  put (holder h, token t): a protected write of key x: refused if t is below
      the fence (the highest token this group has seen for L), else it raises
      the fence to t and writes x.
  epoch (floor): only with rule R3, appended by the first leader after an
      unclean majority stop: the group's epoch goes up by one, and every fence
      rises to the floor (R3.fence): the TSO's current value with tok=tso, or
      the lock row's version as #locks shows it with tok=row.

THE PROGRAMS
  A transaction coordinator: begin (start ts from the TSO, the epoch of each
  group it writes), prewrite every key, take a commit ts, commit the primary;
  once the primary answers `ok` the transaction is committed and the client is
  told so; then it sends the secondaries' commits and stops (no waiting). A
  failed prewrite or a refused primary commit tells the client `aborted`; a
  commit refused as `stale` (R3) tells it `unknown`. The coordinator may crash.
  A reader: takes a snapshot ts, reads each key; a lock of a transaction that
  started at or before the snapshot blocks the read; once that lock's TTL has
  run out (`expire`, a time step) the reader checks the primary and resolves
  the key. It reads `rounds` times, each at a new ts.
  A lock holder: claim, then one protected write; if the write is fenced, claim
  once more and write again. A holder's lease may lapse (`lapse`, a fault: the
  holder is paused and does not know), so another holder may claim over it.

THE RULES (each one a switch; the ablation drops them)
  R1        no transaction spans rungs (its keys are all on M groups or all on P)
  R1s       a transaction that touches an M group touches only that group
            (found here: R1 as worded leaves a transaction over two M groups)
  R2.txn    no transaction writes a key on an M group           } RR-14: locks,
  R2.claim  no lock row (#locks) on an M group                  } fences, and
  R2.put    no protected (fenced) write to an M group           } txn state off M
  R3.fence  after an unclean majority stop, the new leader's epoch entry raises
            every fence to the floor (RR-12, OPS-07)
  R3.stale  ... and the group refuses a prewrite or a commit stamped with an
            older epoch (answer `stale`: outcome unknown) (RR-13, A-08)
  R3.res    ... and the same for a reader's resolve: a reader stamps a resolve
            with the epoch it sees when it sends it, and sends a new one if it
            hears `stale`
  R3.read   ... and a read returns its group's epoch: a snapshot that sees a
            group's epoch change between two of its reads starts again (a new
            snapshot ts), so no snapshot mixes the state before a cut with the
            state after it
  R4        bounded background fsync: the leader appends to an M group only
            while fewer than W entries are not yet on a majority's disks
  A refused begin, claim or write ends that program at once (the app is told
  the call is not offered on that resource).

PROPERTIES (bugs)
  ATOMIC   a reader's snapshot holds some of a transaction's writes and not all
  DURABLE  an acknowledged write on a P group is gone (an acked entry missing
           from the log, or a rollback record for a transaction told committed)
  MONO     a reader's later snapshot holds an older value of a key on a P group
  REFUSED  a transaction told `aborted` has a commit record (F-02)
  ONCE     a key holds two commit records for one transaction (F-02)
  TOKEN    one token is granted twice (P-10)
  FENCE    a group commits a protected write under token t after it
           acknowledged one under a higher token (P-10; RR-12's trace)
  HOLDERS  two holders have each been told `granted`, and neither one's
           current lease has lapsed (P-10: at most one holder per lease by the
           writer's time). A holder's current lease is its latest grant: a claim
           again by the same holder replaces its lease. The model has no release
           and no expiry but the `lapse` fault, so a lease stays live until it
           lapses.
  done     AG EF: every program can end once faults stop (liveness)
ALLOWED BY THE RUNG'S CONTRACT (reported in info runs, never counted)
  LOST     an acknowledged write on an M group is gone
  READBACK a reader's later snapshot holds an older value of a key on an M group
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Update   # noqa: E402

FIELDS = ('grp', 'tso', 'cli', 'hold', 'rdr', 'net', 'gh', 'fl', 'bad')
IX = {f: i for i, f in enumerate(FIELDS)}
GN = ('A', 'B')
RULES = ('R1', 'R1s', 'R2.txn', 'R2.claim', 'R2.put', 'R3.fence', 'R3.stale', 'R3.res', 'R3.read', 'R4')
DONE_C = ('end', 'crashed')


def expand(names):
    """'R2' means every R2.* rule; 'R3.fence' means itself."""
    out = set()
    for n in names:
        out |= {r for r in RULES if r == n or r.startswith(n + '.')}
    return out


def pretty(cmd):
    op = cmd[0]
    if op == 'pw':
        _, s, k, p, ep = cmd
        return f'prewrite {k} (txn {s}{", primary" if k == p else ", primary " + p}{", epoch %d" % ep if ep else ""})'
    if op == 'cm':
        _, s, k, c, ep = cmd
        return f'commit {k} (txn {s} at ts {c}{", epoch %d" % ep if ep else ""})'
    if op == 'chk':
        return f'check txn {cmd[1]} at its primary {cmd[2]} (roll back if locked)'
    if op == 'res':
        _, s, k, stt, ep = cmd
        return f'resolve {k} (txn {s}: ' + (f'commit at ts {stt[1]}' if stt[0] == 'put' else 'roll back') + (
            f', epoch {ep})' if ep else ')')
    if op == 'claim':
        _, h, att, over = cmd
        return f'claim the lock (holder h{h}, attempt {att}' + (
            f', taking over lapsed token {",".join(map(str, over))})' if over else ')')
    if op == 'put':
        return f'protected write of x (holder h{cmd[1]}, token {cmd[2]})'
    if op == 'noop':
        return "the new leader's no-op"
    if op == 'epoch':
        return f'epoch entry (fences rise to {cmd[1]})'
    return str(cmd)


def pres(r):
    if r is None:
        return '-'
    if isinstance(r, tuple):
        return ' '.join(map(str, r))
    return str(r)


class Mem:
    RUNGS = ('M', 'P')     # rung of group A, of group B
    RULESET = ()
    W = 2                  # R4's window: entries not yet on a majority's disks
    CALM = ('deliver', 'time')
    INFO = ()

    def __init__(self, bound):
        self.b = bound
        self.keys = dict(bound.get('keys', {}))           # key -> group index
        self.txns = tuple(bound.get('txns', ()))          # ((keys...), primary)
        self.readers = tuple(bound.get('readers', ()))    # ((keys...), rounds)
        self.nh = bound.get('holders', 0)
        self.lock = bound.get('lock')                     # (group of #locks, group of x)
        self.tok = bound.get('tok', 'tso')
        self.cmcopies = bound.get('cmcopies', 2)
        self.early = bound.get('early', False)            # a commit may be resent before its answer
        self.reclaims = bound.get('reclaims', 1 if self.tok == 'row' else 0)   # claims again after a fenced write
        self.gkeys = tuple(tuple(sorted(k for k, g in self.keys.items() if g == gi)) for gi in (0, 1))
        self.kidx = {k: self.gkeys[g].index(k) for k, g in self.keys.items()}
        self.R = expand(self.RULESET)
        self.mode = bound.get('mode', 'bug')              # 'bug' or 'info'
        self._fc = {}

    def mutated(self, m):
        self.R = expand(self.RULESET) - (expand(m.drop) if m is not None else set())
        self._fc = {}

    def rung(self, gi):
        return self.RUNGS[gi]

    # ------------------------------------------------------------ state
    def init(self):
        grp = (((), 0, 1), ((), 0, 1))
        cli = tuple(('start', 0, 0, (), (), tuple(0 for _ in t[0]), 0) for t in self.txns)
        hold = tuple(('start', 0, 0, 0, (), 0) for _ in range(self.nh))
        rdr = tuple(('start', 0, 0, (), (), (), 0) for _ in self.readers)
        gh = (tuple(None for _ in self.txns), (0, 0), (), (), (), ())
        return (grp, 1, cli, hold, rdr, (), gh, (0, 0, 0), ())

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return tuple(d.f[f] for f in FIELDS)

    def _d(self, st):
        class D:
            pass
        d = D()
        d.f = self.to_draft(st)
        return d

    # ------------------------------------------------------------ the state machine
    def empty(self, gi):
        return (tuple((None, ()) for _ in self.gkeys[gi]), (None, 0, 0), 0, None, 0)

    def apply(self, gi, fs, cmd, ts):
        """ts: the TSO value the leader took when it appended the entry (a claim's commit ts)."""
        mv, lrow, fence, px, ep = fs
        op = cmd[0]
        if op == 'noop':
            return fs, None
        if op == 'epoch':
            if 'R3.fence' in self.R:
                fence = max(fence, cmd[1])
            return (mv, lrow, fence, px, ep + 1), None
        if op in ('pw', 'cm', 'chk', 'res'):
            s, k = cmd[1], cmd[2]
            i = self.kidx[k]
            lock, ws = mv[i]
            rec = next((w for w in ws if w[1] == s), None)

            def put(lock2, ws2):
                m2 = list(mv)
                m2[i] = (lock2, tuple(sorted(ws2)))
                return (tuple(m2), lrow, fence, px, ep)
            if op == 'pw':
                if 'R3.stale' in self.R and cmd[4] < ep:
                    return fs, 'stale'
                if lock is not None and lock[0] == s:
                    return fs, 'ok'
                if rec is not None:
                    return fs, 'rolledback' if rec[2] == 'rb' else 'committed'
                if lock is not None:
                    return fs, 'locked'
                if any(w[0] > s for w in ws):
                    return fs, 'conflict'
                return put((s, cmd[3]), ws), 'ok'
            if op == 'cm':
                if 'R3.stale' in self.R and cmd[4] < ep:
                    return fs, 'stale'
                if lock is not None and lock[0] == s:
                    return put(None, ws + ((cmd[3], s, 'put'),)), 'ok'
                if rec is not None:
                    return fs, 'rolledback' if rec[2] == 'rb' else 'ok'
                return fs, 'notfound'
            if op == 'chk':
                if lock is not None and lock[0] == s:
                    return put(None, ws + ((s, s, 'rb'),)), ('rb',)
                if rec is not None:
                    return fs, ('put', rec[0]) if rec[2] == 'put' else ('rb',)
                return put(lock, ws + ((s, s, 'rb'),)), ('rb',)
            if op == 'res':
                stt = cmd[3]
                if 'R3.res' in self.R and cmd[4] < ep:
                    return fs, 'stale'
                if lock is not None and lock[0] == s:
                    w = (stt[1], s, 'put') if stt[0] == 'put' else (s, s, 'rb')
                    return put(None, ws + (w,)), 'ok'
                if stt[0] == 'rb' and rec is None:
                    return put(lock, ws + ((s, s, 'rb'),)), 'ok'
                return fs, 'ok'
        if op == 'claim':
            _, h, att, over = cmd
            holder, tok, ver = lrow
            if holder is None or holder == h or tok in over:
                nt = ts if self.tok == 'tso' else ver + 1
                return (mv, (h, nt, ver + 1), fence, px, ep), ('granted', nt)
            return fs, ('busy',)
        if op == 'put':
            _, h, t = cmd
            if t < fence:
                return fs, ('fenced',)
            return (mv, lrow, t, (h, t), ep), ('ok',)
        raise ValueError(cmd)

    def fold(self, gi, pre):
        """(state, results) of the log prefix pre, cached."""
        key = (gi, pre)
        c = self._fc.get(key)
        if c is not None:
            return c
        if not pre:
            c = (self.empty(gi), ())
        else:
            fs, rs = self.fold(gi, pre[:-1])
            fs2, r = self.apply(gi, fs, pre[-1][1], pre[-1][2])
            c = (fs2, rs + (r,))
        self._fc[key] = c
        return c

    def cpre(self, st, gi):
        """The committed prefix of group gi's log."""
        L, k, term = st[0][gi]
        if gi == 0 and self.rung(0) == 'P':
            return L[:k]
        return L

    def cfold(self, st, gi):
        return self.fold(gi, self.cpre(st, gi))

    def answer(self, st, gi, cmd):
        pre = self.cpre(st, gi)
        _, rs = self.fold(gi, pre)
        for j in range(len(pre) - 1, -1, -1):
            if pre[j][1] == cmd:
                return rs[j]
        return None

    def gone(self, st, gi, cmd):
        """A command is lost: no copy in flight and no entry in the leader's log (committed or not)."""
        return (gi, cmd) not in st[IX['net']] and not any(e[1] == cmd for e in st[IX['grp']][gi][0])

    def kv(self, st, k):
        gi = self.keys[k]
        return self.cfold(st, gi)[0][0][self.kidx[k]]

    @staticmethod
    def has_put(ws, s):
        return any(w[1] == s and w[2] == 'put' for w in ws)

    @staticmethod
    def has_rb(ws, s):
        return any(w[1] == s and w[2] == 'rb' for w in ws)

    # ------------------------------------------------------------ helpers for updates
    @staticmethod
    def setat(d, field, i, v):
        t = list(d.f[field])
        t[i] = v
        d.f[field] = tuple(t)

    @staticmethod
    def send(d, gi, cmd):
        d.f['net'] = tuple(sorted(d.f['net'] + ((gi, cmd),)))

    @staticmethod
    def addbad(d, name):
        if name not in d.f['bad']:
            d.f['bad'] = tuple(sorted(d.f['bad'] + (name,)))

    def gh(self, d, i, v):
        g = list(d.f['gh'])
        g[i] = v
        d.f['gh'] = tuple(g)

    def ack(self, d, gi, cmd):
        g = d.f['gh']
        if (gi, cmd) not in g[5]:
            self.gh(d, 5, tuple(sorted(g[5] + ((gi, cmd),))))

    def fence_new(self, d, gi, pre, lo):
        """FENCE: entries pre[lo:] have just committed at group gi."""
        _, rs = self.fold(gi, pre)
        hi = d.f['gh'][1][gi]
        for j in range(lo, len(pre)):
            cmd = pre[j][1]
            if cmd[0] == 'put' and rs[j] == ('ok',) and cmd[2] < hi:
                self.addbad(d, 'FENCE')

    def epoch_of(self, st, gi):
        return self.cfold(st, gi)[0][4]

    # ------------------------------------------------------------ world
    def world(self, st):
        out = []
        grp, tso, cli, hold, rdr, net, gh, fl, bad = st
        L, k, term = grp[0]
        # the disks of a majority catch up
        if k < len(L):
            d = self._d(st)
            self.setat(d, 'grp', 0, (L, len(L), term))
            if self.rung(0) == 'P':
                self.fence_new(d, 0, L, k)
            out.append((('sync', 'A', f'a majority has all {len(L)} entries on disk'), 'time', self.freeze(d)))
        # a majority of A stops uncleanly; Raft elects a new leader
        if fl[0] < self.b.get('stops', 0):
            for l in range(k, len(L) + 1):
                d = self._d(st)
                if any(r.startswith('R3.') for r in self.R):
                    if self.tok == 'tso':
                        floor = tso
                    else:
                        gl = self.lock[0] if self.lock else 0
                        pre = L[:l] if gl == 0 else self.cpre(st, 1)
                        if gl == 0 and self.rung(0) == 'P':
                            pre = L[:min(k, l)]
                        floor = self.fold(gl, pre)[0][1][2]
                    e = (term + 1, ('epoch', floor), 0)
                else:
                    e = (term + 1, ('noop',), 0)
                self.setat(d, 'grp', 0, (L[:l] + (e,), k, term + 1))
                self.setat(d, 'fl', 0, fl[0] + 1)
                out.append((('stop', 'A', f'a majority stops uncleanly: {len(L)} entries, {k} on a majority\'s disks; '
                             f'the new leader keeps {l}'), 'fault', self.freeze(d)))
        # a coordinator crashes
        if fl[2] < self.b.get('crashes', 0):
            for i, c in enumerate(cli):
                if c[0] not in DONE_C and c[0] != 'start':
                    d = self._d(st)
                    self.setat(d, 'cli', i, ('crashed',) + c[1:])
                    self.setat(d, 'fl', 2, fl[2] + 1)
                    out.append((('crash', f'T{i}'), 'fault', self.freeze(d)))
        # a holder's lease lapses while it is paused
        if fl[1] < self.b.get('lapses', 0):
            for h, x in enumerate(hold):
                if x[0] in ('put', 'putw') and x[2] not in gh[3]:
                    d = self._d(st)
                    self.gh(d, 3, tuple(sorted(gh[3] + (x[2],))))
                    self.setat(d, 'fl', 1, fl[1] + 1)
                    out.append((('lapse', f'h{h}', f'token {x[2]}'), 'fault', self.freeze(d)))
        # a lock's TTL runs out (time passes)
        for i, c in enumerate(cli):
            s = c[1]
            if s and s not in gh[4] and any(self.kv(st, k)[0] is not None and self.kv(st, k)[0][0] == s
                                            for k in self.txns[i][0]):
                d = self._d(st)
                self.gh(d, 4, tuple(sorted(gh[4] + (s,))))
                out.append((('expire', f'T{i}', f'the TTL of txn {s}\'s locks runs out'), 'time', self.freeze(d)))
        return out

    # ------------------------------------------------------------ properties
    def check(self, st):
        grp, tso, cli, hold, rdr, net, gh, fl, bad = st
        info = self.mode == 'info'
        out = [b for b in bad if b.startswith('i:') == info]
        out = [b[2:] if info else b for b in out]
        for gi, cmd in gh[5]:
            if self.rung(gi) == ('M' if info else 'P') and not any(e[1] == cmd for e in grp[gi][0]):
                out.append('LOST' if info else 'DURABLE')
        for i, t in enumerate(gh[0]):
            s = cli[i][1]
            keys = self.txns[i][0]
            if t == 'committed':
                for k in keys:
                    if self.rung(self.keys[k]) == ('M' if info else 'P') and self.has_rb(self.kv(st, k)[1], s):
                        out.append('LOST' if info else 'DURABLE')
            if t == 'aborted' and not info:
                if any(self.has_put(self.kv(st, k)[1], s) for k in keys):
                    out.append('REFUSED')
        if not info:
            # a holder's current lease is its latest grant (a claim again by the same holder replaces it);
            # it holds the lock while that token has not lapsed. tok > 0: granted at least once.
            live = [h for h, x in enumerate(hold) if x[2] > 0 and x[2] not in gh[3]]
            if len(live) > 1:
                out.append('HOLDERS')
            for k in self.keys:
                ws = self.kv(st, k)[1]
                ss = [w[1] for w in ws if w[2] == 'put']
                if len(ss) != len(set(ss)):
                    out.append('ONCE')
        return sorted(set(out))

    def check_edge(self, s, lab, kind, t):
        return []

    def goals(self, st):
        return {'done': all(c[0] in DONE_C for c in st[IX['cli']]) and all(h[0] == 'end' for h in st[IX['hold']])
                and all(r[0] == 'end' for r in st[IX['rdr']])}

    def judged(self, st):
        return {'done': True}

    # ------------------------------------------------------------ rule tests
    def txn_refused(self, i):
        keys = self.txns[i][0]
        gs = {self.keys[k] for k in keys}
        rs = {self.rung(g) for g in gs}
        if 'R1' in self.R and len(rs) > 1:
            return 'R1'
        if 'R1s' in self.R and 'M' in rs and len(gs) > 1:
            return 'R1s'
        if 'R2.txn' in self.R and 'M' in rs:
            return 'R2'
        return None

    def claim_refused(self):
        return 'R2' if 'R2.claim' in self.R and self.rung(self.lock[0]) == 'M' else None

    def put_refused(self):
        return 'R2' if 'R2.put' in self.R and self.rung(self.lock[1]) == 'M' else None

    # ------------------------------------------------------------ the programs
    def actions(self):
        O = self
        acts = []
        T = lambda b: f'T{b["i"]}'
        C = lambda st, i: st[IX['cli']][i]

        def clis(*pcs):
            def gen(w, st):
                for i, c in enumerate(st[IX['cli']]):
                    if c[0] in pcs:
                        yield {'i': i}
            return gen

        def setc(d, i, **kw):
            pc, s, c, eps, acks, pwc, cmc = d.f['cli'][i]
            v = dict(pc=pc, s=s, c=c, eps=eps, acks=acks, pwc=pwc, cmc=cmc)
            v.update(kw)
            O.setat(d, 'cli', i, (v['pc'], v['s'], v['c'], v['eps'], v['acks'], v['pwc'], v['cmc']))

        def tell(d, i, what):
            O.gh(d, 0, tuple(what if j == i else x for j, x in enumerate(d.f['gh'][0])))

        def pwcmd(st, i, k):
            keys, p = O.txns[i]
            c = C(st, i)
            return ('pw', c[1], k, p, c[3][keys.index(k)])

        def cmcmd(st, i, k):
            keys, p = O.txns[i]
            c = C(st, i)
            return ('cm', c[1], k, c[2], c[3][keys.index(k)])

        # --- a transaction coordinator
        def begin(w, st, b, d):
            i = b['i']
            keys, p = O.txns[i]
            s = st[IX['tso']]
            d.f['tso'] = s + 1
            eps = tuple(O.epoch_of(st, O.keys[k]) for k in keys)
            setc(d, i, pc='pw', s=s, eps=eps, pwc=tuple(1 for _ in keys))
            for k, e in zip(keys, eps):
                O.send(d, O.keys[k], ('pw', s, k, p, e))
        acts.append(Action('t.begin', 'deliver', clis('start'),
                           [Guard('allowed', lambda w, st, b: O.txn_refused(b['i']) is None)],
                           [Update('go', begin)], label=lambda b: (T(b),)))
        acts.append(Action('t.refused', 'deliver', clis('start'),
                           [Guard('rule', lambda w, st, b: O.txn_refused(b['i']) is not None)],
                           [Update('end', lambda w, st, b, d: setc(d, b['i'], pc='end'))],
                           label=lambda b: (T(b), 'refused by a rule')))

        def pwans(w, st):
            for b in clis('pw')(w, st):
                i = b['i']
                c = C(st, i)
                for k in O.txns[i][0]:
                    if k not in c[4]:
                        r = O.answer(st, O.keys[k], pwcmd(st, i, k))
                        if r is not None:
                            yield {'i': i, 'k': k, 'r': r}

        def pwack(w, st, b, d):
            i, k, r = b['i'], b['k'], b['r']
            c = C(st, i)
            if r == 'ok':
                O.ack(d, O.keys[k], pwcmd(st, i, k))
                acks = tuple(sorted(c[4] + (k,)))
                setc(d, i, acks=acks, pc='getc' if len(acks) == len(O.txns[i][0]) else 'pw')
            else:
                tell(d, i, 'aborted')
                setc(d, i, pc='end')
        acts.append(Action('t.prewritten', 'deliver', pwans, [], [Update('take', pwack)],
                           label=lambda b: (T(b), b['k'], pres(b['r']))))

        def pwlost(w, st):
            for b in clis('pw')(w, st):
                i = b['i']
                c = C(st, i)
                for j, k in enumerate(O.txns[i][0]):
                    cmd = pwcmd(st, i, k)
                    if k not in c[4] and c[5][j] < 2 and O.gone(st, O.keys[k], cmd):
                        yield {'i': i, 'k': k, 'j': j}

        def pwresend(w, st, b, d):
            i, k, j = b['i'], b['k'], b['j']
            c = d.f['cli'][i]
            setc(d, i, pwc=tuple(x + (1 if jj == j else 0) for jj, x in enumerate(c[5])))
            O.send(d, O.keys[k], pwcmd(st, i, k))
        acts.append(Action('t.prewrite-again', 'deliver', pwlost, [], [Update('send', pwresend)],
                           label=lambda b: (T(b), b['k'], 'no answer and no copy in flight')))

        def getc(w, st, b, d):
            i = b['i']
            c = st[IX['tso']]
            d.f['tso'] = c + 1
            setc(d, i, pc='cm', c=c, cmc=1)
            p = O.txns[i][1]
            d2 = d.f['cli'][i]
            keys = O.txns[i][0]
            O.send(d, O.keys[p], ('cm', d2[1], p, c, d2[3][keys.index(p)]))
        acts.append(Action('t.commit', 'deliver', clis('getc'), [], [Update('go', getc)],
                           label=lambda b: (T(b), 'commit ts from the TSO; commit the primary')))

        def cmans(w, st):
            for b in clis('cm')(w, st):
                i = b['i']
                p = O.txns[i][1]
                r = O.answer(st, O.keys[p], cmcmd(st, i, p))
                if r is not None:
                    yield {'i': i, 'r': r}

        def cmack(w, st, b, d):
            i, r = b['i'], b['r']
            p = O.txns[i][1]
            if r == 'ok':
                O.ack(d, O.keys[p], cmcmd(st, i, p))
                tell(d, i, 'committed')
                setc(d, i, pc='cms')
            else:
                tell(d, i, 'unknown' if r == 'stale' else 'aborted')
                setc(d, i, pc='end')
        acts.append(Action('t.committed', 'deliver', cmans, [], [Update('take', cmack)],
                           label=lambda b: (T(b), 'primary', pres(b['r']))))

        def cmagain(w, st):
            for b in clis('cm')(w, st):
                i = b['i']
                c = C(st, i)
                p = O.txns[i][1]
                cmd = cmcmd(st, i, p)
                if (O.early and c[6] < O.cmcopies) or (c[6] < O.cmcopies + 1 and O.gone(st, O.keys[p], cmd)):
                    yield {'i': i}

        def cmresend(w, st, b, d):
            i = b['i']
            setc(d, i, cmc=C(st, i)[6] + 1)
            O.send(d, O.keys[O.txns[i][1]], cmcmd(st, i, O.txns[i][1]))
        acts.append(Action('t.commit-again', 'deliver', cmagain, [], [Update('send', cmresend)],
                           label=lambda b: (T(b), 'no answer yet (timeout): send the commit again')))

        def secs(w, st, b, d):
            i = b['i']
            keys, p = O.txns[i]
            for k in keys:
                if k != p:
                    O.send(d, O.keys[k], cmcmd(st, i, k))
            setc(d, i, pc='end')
        acts.append(Action('t.secondaries', 'deliver', clis('cms'), [], [Update('send', secs)],
                           label=lambda b: (T(b), 'send the secondaries\' commits and stop')))

        # --- a reader
        def rdrs(*pcs):
            def gen(w, st):
                for j, r in enumerate(st[IX['rdr']]):
                    if r[0] in pcs:
                        yield {'j': j}
            return gen

        def setr(d, j, **kw):
            pc, rnd, r, pend, seen, prev, sends = d.f['rdr'][j]
            v = dict(pc=pc, rnd=rnd, r=r, pend=pend, seen=seen, prev=prev, sends=sends)
            v.update(kw)
            O.setat(d, 'rdr', j, (v['pc'], v['rnd'], v['r'], v['pend'], v['seen'], v['prev'], v['sends']))

        def rstart(w, st, b, d):
            j = b['j']
            r = st[IX['tso']]
            d.f['tso'] = r + 1
            setr(d, j, pc='read', r=r, pend=O.readers[j][0], seen=())
        acts.append(Action('r.snapshot', 'deliver', rdrs('start'), [], [Update('go', rstart)],
                           label=lambda b: (f'R{b["j"]}', 'snapshot ts from the TSO')))

        def gets(w, st):
            for b in rdrs('read')(w, st):
                j = b['j']
                rd = st[IX['rdr']][j]
                for k in rd[3]:
                    lock, ws = O.kv(st, k)
                    if lock is None or lock[0] > rd[2]:
                        vs = [w_[1] for w_ in ws if w_[2] == 'put' and w_[0] <= rd[2]]
                        yield {'j': j, 'k': k, 'v': max(vs) if vs else 0}

        def rget(w, st, b, d):
            j, k, v = b['j'], b['k'], b['v']
            rd = st[IX['rdr']][j]
            g, e = O.keys[k], O.epoch_of(st, O.keys[k])
            if 'R3.read' in O.R and any(gg == g and ee != e for _, _, gg, ee in rd[4]):
                setr(d, j, pc='start', pend=(), seen=())      # the epoch moved under this snapshot: start again
                return
            seen = rd[4] + ((k, v, g, e),)
            pend = tuple(x for x in rd[3] if x != k)
            old = {x[0]: x[1] for x in rd[5]}.get(k)
            if old is not None and v < old:
                if O.rung(O.keys[k]) == 'P':
                    O.addbad(d, 'MONO')
                elif O.mode == 'info':
                    O.addbad(d, 'i:READBACK')
            if not pend:
                sv = {x[0]: x[1] for x in seen}
                for i, (keys, p) in enumerate(O.txns):
                    s = C(st, i)[1]
                    if s and all(x in sv for x in keys):
                        got = [sv[x] == s for x in keys]
                        if any(got) and not all(got):
                            O.addbad(d, 'ATOMIC')
                if rd[1] + 1 < O.readers[j][1]:
                    setr(d, j, pc='start', rnd=rd[1] + 1, pend=(), seen=(), prev=seen)
                else:
                    setr(d, j, pc='end', pend=(), seen=seen)
            else:
                setr(d, j, pend=pend, seen=seen)
        acts.append(Action('r.read', 'deliver', gets, [], [Update('take', rget)],
                           label=lambda b: (f'R{b["j"]}', b['k'], 'value of txn %s' % b['v'] if b['v'] else 'initial value')))

        def blocked(st, j):
            rd = st[IX['rdr']][j]
            for k in rd[3]:
                lock = O.kv(st, k)[0]
                if lock is not None and lock[0] <= rd[2] and lock[0] in st[IX['gh']][4]:
                    yield k, lock

        def chks(w, st):
            for b in rdrs('read')(w, st):
                j = b['j']
                if st[IX['rdr']][j][6] >= 4:
                    continue
                for k, (s, p) in blocked(st, j):
                    cmd = ('chk', s, p)
                    if O.gone(st, O.keys[p], cmd):
                        yield {'j': j, 'k': k, 'cmd': cmd}

        def sendr(w, st, b, d):
            j = b['j']
            setr(d, j, sends=st[IX['rdr']][j][6] + 1)
            O.send(d, O.keys[b['cmd'][2]], b['cmd'])
        acts.append(Action('r.check', 'deliver', chks, [], [Update('send', sendr)],
                           label=lambda b: (f'R{b["j"]}', b['k'], 'lock expired: ' + pretty(b['cmd']))))

        def ress(w, st):
            for b in rdrs('read')(w, st):
                j = b['j']
                if st[IX['rdr']][j][6] >= 4:
                    continue
                for k, (s, p) in blocked(st, j):
                    if k == p:
                        continue
                    stt = O.answer(st, O.keys[p], ('chk', s, p))
                    if stt is None:
                        continue
                    cmd = ('res', s, k, stt, O.epoch_of(st, O.keys[k]))
                    if O.gone(st, O.keys[k], cmd):
                        yield {'j': j, 'k': k, 'cmd': cmd}
        acts.append(Action('r.resolve', 'deliver', ress, [], [Update('send', sendr)],
                           label=lambda b: (f'R{b["j"]}', b['k'], pretty(b['cmd']))))

        # --- a lock holder
        def hs(*pcs):
            def gen(w, st):
                for h, x in enumerate(st[IX['hold']]):
                    if x[0] in pcs:
                        yield {'h': h}
            return gen

        def seth(d, h, **kw):
            pc, att, tok, tries, over, rs = d.f['hold'][h]
            v = dict(pc=pc, att=att, tok=tok, tries=tries, over=over, rs=rs)
            v.update(kw)
            O.setat(d, 'hold', h, (v['pc'], v['att'], v['tok'], v['tries'], v['over'], v['rs']))

        def claimcmd(st, h):
            x = st[IX['hold']][h]
            return ('claim', h, x[1], x[4])
        H = lambda b: f'h{b["h"]}'

        def claim(w, st, b, d):
            h = b['h']
            att = st[IX['tso']]
            d.f['tso'] = att + 1
            over = st[IX['gh']][3]
            seth(d, h, pc='claimw', att=att, over=over)
            O.send(d, O.lock[0], ('claim', h, att, over))
        acts.append(Action('h.claim', 'deliver', hs('start', 'again'),
                           [Guard('allowed', lambda w, st, b: O.claim_refused() is None)],
                           [Update('go', claim)], label=lambda b: (H(b),)))
        acts.append(Action('h.refused', 'deliver', hs('start', 'again'),
                           [Guard('rule', lambda w, st, b: O.claim_refused() is not None)],
                           [Update('end', lambda w, st, b, d: seth(d, b['h'], pc='end'))],
                           label=lambda b: (H(b), 'claim refused by a rule')))

        def clans(w, st):
            for b in hs('claimw')(w, st):
                r = O.answer(st, O.lock[0], claimcmd(st, b['h']))
                if r is not None:
                    yield {'h': b['h'], 'r': r}

        def clack(w, st, b, d):
            h, r = b['h'], b['r']
            if r[0] == 'granted':
                t = r[1]
                g = d.f['gh']
                if any(tk == t for tk, _ in g[2]):
                    O.addbad(d, 'TOKEN')
                O.gh(d, 2, tuple(sorted(g[2] + ((t, h),))))
                O.ack(d, O.lock[0], claimcmd(st, h))
                seth(d, h, pc='put', tok=t)
            else:
                seth(d, h, pc='end')
        acts.append(Action('h.claimed', 'deliver', clans, [], [Update('take', clack)],
                           label=lambda b: (H(b), pres(b['r']))))

        def cllost(w, st):
            for b in hs('claimw')(w, st):
                cmd = claimcmd(st, b['h'])
                if O.gone(st, O.lock[0], cmd) and st[IX['hold']][b['h']][5] < 2:
                    yield b

        def clresend(w, st, b, d):
            h = b['h']
            x = st[IX['hold']][h]
            seth(d, h, rs=x[5] + 1)
            O.send(d, O.lock[0], claimcmd(st, h))
        acts.append(Action('h.claim-again', 'deliver', cllost, [], [Update('send', clresend)],
                           label=lambda b: (H(b), 'no answer and no copy in flight')))

        def put(w, st, b, d):
            h = b['h']
            seth(d, h, pc='putw')
            O.send(d, O.lock[1], ('put', h, st[IX['hold']][h][2]))
        acts.append(Action('h.write', 'deliver', hs('put'),
                           [Guard('allowed', lambda w, st, b: O.put_refused() is None)],
                           [Update('go', put)], label=lambda b: (H(b),)))
        acts.append(Action('h.write-refused', 'deliver', hs('put'),
                           [Guard('rule', lambda w, st, b: O.put_refused() is not None)],
                           [Update('end', lambda w, st, b, d: seth(d, b['h'], pc='end'))],
                           label=lambda b: (H(b), 'protected write refused by a rule')))

        def putcmd(st, h):
            return ('put', h, st[IX['hold']][h][2])

        def puans(w, st):
            for b in hs('putw')(w, st):
                r = O.answer(st, O.lock[1], putcmd(st, b['h']))
                if r is not None:
                    yield {'h': b['h'], 'r': r}

        def puack(w, st, b, d):
            h, r = b['h'], b['r']
            x = st[IX['hold']][h]
            if r == ('ok',):
                g = d.f['gh']
                hi = list(g[1])
                hi[O.lock[1]] = max(hi[O.lock[1]], x[2])
                O.gh(d, 1, tuple(hi))
                O.ack(d, O.lock[1], putcmd(st, h))
                seth(d, h, pc='end')
            elif x[3] < O.reclaims:
                seth(d, h, pc='again', tries=x[3] + 1)
            else:
                seth(d, h, pc='end')
        acts.append(Action('h.written', 'deliver', puans, [], [Update('take', puack)],
                           label=lambda b: (H(b), pres(b['r']))))

        def pulost(w, st):
            for b in hs('putw')(w, st):
                cmd = putcmd(st, b['h'])
                if O.gone(st, O.lock[1], cmd) and st[IX['hold']][b['h']][5] < 2:
                    yield b

        def puresend(w, st, b, d):
            h = b['h']
            x = st[IX['hold']][h]
            seth(d, h, rs=x[5] + 1)
            O.send(d, O.lock[1], putcmd(st, h))
        acts.append(Action('h.write-again', 'deliver', pulost, [], [Update('send', puresend)],
                           label=lambda b: (H(b), 'no answer and no copy in flight')))

        # --- the network: a leader appends a copy (memory, or group B: committed at once)
        def copies(w, st):
            for gi, cmd in sorted(set(st[IX['net']])):
                yield {'g': gi, 'cmd': cmd}

        def window(w, st, b):
            if b['g'] != 0 or O.rung(0) != 'M' or 'R4' not in O.R:
                return True
            L, k, term = st[IX['grp']][0]
            return len(L) - k < O.W

        def deliver(w, st, b, d):
            gi, cmd = b['g'], b['cmd']
            net = list(st[IX['net']])
            net.remove((gi, cmd))
            d.f['net'] = tuple(net)
            L, k, term = st[IX['grp']][gi]
            ts = 0
            if cmd[0] == 'claim' and O.tok == 'tso':
                ts = st[IX['tso']]       # the claim commits with a fresh timestamp: its token
                d.f['tso'] = ts + 1
            L2 = L + ((term, cmd, ts),)
            if gi == 1:
                O.setat(d, 'grp', 1, (L2, len(L2), term))
                O.fence_new(d, 1, L2, len(L))
            else:
                O.setat(d, 'grp', 0, (L2, k, term))
                if O.rung(0) == 'M':
                    O.fence_new(d, 0, L2, len(L))
        acts.append(Action('deliver', 'deliver', copies, [Guard('R4', window)], [Update('append', deliver)],
                           label=lambda b: (GN[b['g']], pretty(b['cmd']))))
        return acts


def option(rungs, rules=(), W=2, name=None):
    """A model class for group A's and B's rungs ('MP' = A memory, B persisted) and a rule set."""
    nm = name or (rungs + ('-' + '+'.join(rules) if rules else ''))
    return type('Mem_' + nm.replace('-', '_').replace('+', '_').replace('.', '_'), (Mem,),
                {'RUNGS': tuple(rungs), 'RULESET': tuple(rules), 'W': W})


ALL4 = ('R1', 'R2', 'R3', 'R4')
OPTIONS = {}
for _r in ('PP', 'MP', 'MM'):
    OPTIONS[_r] = option(_r)
    OPTIONS[_r + '-all'] = option(_r, ALL4)
    OPTIONS[_r + '-R2'] = option(_r, ('R2',))
    OPTIONS[_r + '-R1s+R3'] = option(_r, ('R1s', 'R3'))
    OPTIONS[_r + '-R4'] = option(_r, ('R4',))

TX = dict(stops=1, crashes=1, cmcopies=1, early=False)
BOUNDS = {
    # a transaction over a (group A) and b (group B), primary on A; one reader, two snapshots
    'txn': dict(keys={'a': 0, 'b': 1}, txns=((('a', 'b'), 'a'),), readers=((('a', 'b'), 2),), **TX),
    # the same, primary on B
    'txnb': dict(keys={'a': 0, 'b': 1}, txns=((('a', 'b'), 'b'),), readers=((('a', 'b'), 2),), **TX),
    # a transaction over two keys of group A only; one snapshot (two snapshots: txn1-2r)
    'txn1': dict(keys={'a': 0, 'c': 0}, txns=((('a', 'c'), 'a'),), readers=((('a', 'c'), 1),), **TX),
    'txn1-2r': dict(keys={'a': 0, 'c': 0}, txns=((('a', 'c'), 'a'),), readers=((('a', 'c'), 2),), **TX),
    # one key on A; the commit may be sent twice before any answer; a reader resolves
    'dedup': dict(keys={'x': 0}, txns=((('x',), 'x'),), readers=((('x',), 1),), stops=1, crashes=0,
                  cmcopies=2, early=True),
    # a lock row (#locks) and a protected key x; two holders, one paused lease
    'lockAA': dict(lock=(0, 0), holders=2, lapses=1, stops=1),
    'lockBA': dict(lock=(1, 0), holders=2, lapses=1, stops=1),
    'lockAB': dict(lock=(0, 1), holders=2, lapses=1, stops=1),
}
for _b in ('lockAA', 'lockBA', 'lockAB'):
    BOUNDS[_b + '-row'] = dict(BOUNDS[_b], tok='row')
SWEEP = ('txn', 'txnb', 'txn1', 'dedup', 'lockAA', 'lockBA', 'lockAB')
VERIFY = ()
