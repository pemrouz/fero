"""
ackstage.py: E-48. Per-operation ack stages inside Raft, on TiKV's shape: two
Raft groups, a timestamp oracle, Percolator's two-phase commit over
multi-version keys, a fenced lock, readers that resolve locks, clients that
retry, and a plain writer that pipelines. Copied from E-47's models/memrung.py
and changed; E-47 itself is not edited.

THE FORMS (FORM, with a STAGE map per kind of operation)
  S0  persisted only: an entry commits, is applied and is seen once a majority
      has it on disk; every answer waits for that (E-47's group A under PP).
  S1  ack stages, commit at disk: commit, apply and reads exactly as S0. The
      caller picks, per operation, when its own answer resolves:
        recv  the range leader appended it
        repl  a majority holds it in memory (followers report receipt before
              their fsync; the report feeds answers only, never the commit)
        cmt   on disk at a majority, applied, visible (the default; = S0)
  S2  commit in memory: an entry commits, is applied and is seen once a
      majority holds it in memory (the memory rung's commit); each answer
      waits for the stage its caller picked:
        mem   committed in memory
        disk  on disk at a majority
  E1  (as STAGE 'e1' under S2) MEMORY.md's form (e1): plain writes answered
      from memory; transaction records, claims and fenced writes wait for disk.

THE WORLD (not counted)
  Group A is (log, m, k, term): the leader's log, the majority-memory point m
  (the longest prefix two copies hold) and the majority-disk point k <= m.
  `repl` moves m to the end of the log; `sync` moves k to m. The commit point
  is k (S0, S1) or m (S2). Group B never stops, commits at append, and needs no
  copies in the model.
  Faults on group A, each once per run at most (bounds `stops`, `lcrash`):
    stop    an unclean stop (power loss) of the leader alone or of a majority.
            The new leader keeps the log cut to any l with k <= l <= len,
            plus a no-op (or R3's epoch entry) of the new term. In S0/S1 the
            new m is k (only the disk-majority prefix is surely held by two
            copies); in S2 the operator's recovery (E-47's rule 15) commits the
            kept log and its first entry, as E-47's `memory` group does.
            tools/raftcheck48.py checks the cut range [k, len] by brute force,
            for one or more unclean copies voting on their synced prefix.
    lcrash  the leader's process stops with its page cache kept (a kill, a
            deploy, a partition): the new leader keeps the log cut to any l
            with m <= l <= len, plus a no-op; m and k stay. raftcheck48 checks
            [m, len] for every election over intact logs.
  Clients. A command is a copy on the network until a leader appends it; a
  copy is delivered at most once, after any delay, in any order (the plain
  writer's copies arrive in the order it sent them: one connection). A client
  reads its answer at a stage from the leader's log: the last entry of that
  command whose index is below the stage's point (len for recv, m for repl or
  mem, the commit point for cmt, k for disk). If the command is gone (no copy
  in flight, no entry in the log) and the client has no answer it can act on,
  it sends it again (budgets below).

RESULTS IN EARLY ANSWERS (RES)
  spec   the leader judges a command over its own log, in log order, before
         the command commits (TiKV judges conflicts before it proposes, under
         latches, which is the same order); an early answer carries that
         result. If the entry survives, the committed result is the same (a
         cut is a suffix). If it is lost, a copy sent again is judged afresh.
  blind  an early answer carries no result (judged at apply): it says only
         "accepted". A step that needs a result waits for the durable stage.

THE STATE MACHINE: E-47's Percolator (pw, cm, chk, res, claim, put, epoch),
  judged in log order, plus
  set (w, n, att): the plain writer's n-th write (attempt att) of key p. It
  appends (n, att) to p's list. With rule O.seq the group keeps the writer's
  last applied n: n <= last is answered `dup` (no effect), n > last + 1 `gap`
  (refused), n = last + 1 applies.

THE PROGRAMS
  E-47's transaction coordinator, reader and two lock holders, except that each
  step waits for the answer to the step before at that step's ACT stage: the
  kind's own stage, or the durable stage under W1 (or for every result-bearing
  step under RES = blind). The user's own promise (the transaction's outcome,
  a grant, a protected write's ok, a plain write's ok) resolves at the kind's
  STAGE.
  A plain writer: sends set 1 (and set 2), each once the answer to the one
  before is in at its stage (`pipeline`: without waiting); it tracks every
  write to the durable stage and sends a copy again, lowest first, when one is
  gone or refused `gap` (budget one each; `timeout`: also while a copy is still
  in the log or in flight, as a client that times out cannot tell); in bound
  `ryw` it then reads p.
  A plain reader: reads p once.

THE RULES (each one a switch; the ablation drops them)
  W1.pw     the coordinator commits the primary only once every prewrite is
            durable                                   } the library's protocol
  W1.cm     it sends the secondaries' commits only     } steps rest only on
            once the primary's commit is durable       } durable answers; only
  W1.chk    a reader resolves a key only once its      } the caller's own
            check of the primary is durable            } promise resolves early
  W1.claim  a holder sends its protected write only once its claim is durable
  O.seq     the plain writer's writes carry a sequence; the group applies them
            in order, refuses a gap, and answers a repeat `dup` (Kafka's
            idempotent producer: from memory, not checked here)
  Y         read-your-writes: a client's read waits until its last answered
            write is visible (commit point past it) or gone
  RD.txn    S2: readers of transaction keys read the majority-disk prefix only
  RD.plain  S2: readers of the plain key read the majority-disk prefix only
  R1s, R2.txn, R2.claim, R2.put, R3.fence, R3.stale, R3.res, R3.read: E-47's
            rules, unchanged (used for S2 and in the ablation)

PROPERTIES (bugs; a promise to the caller counts only when the caller chose
the durable stage for it: cmt in S0/S1, disk in S2)
  ATOMIC    a reader's snapshot holds some of a transaction's writes and not all
  DURABLE   a durably acked entry is gone, or a key holds a rollback record of
            a transaction durably told committed
  MONO      a later snapshot holds an older value of a key read from a durable
            prefix
  REFUSED   a transaction durably told `aborted` has a commit record
  ONCE      a key holds two commit records of one transaction
  TOKEN     one token is durably granted twice
  FENCE     a group commits a protected write under token t after a durable ack
            of one under a higher token
  HOLDERS   two holders are durably granted the lock, neither lease lapsed
  OTHERS.read  a reader was shown a value whose write is no longer committed (for a
               transaction key: neither that key's commit record nor the
               primary's, which decides the transaction, is committed)
  OTHERS.lock  a protected write is committed under a token whose claim is gone
               from the lock row's log
  OTHERS.txn   a transaction holds a commit record at one key and a rollback
               record at another, or its primary is committed while a
               secondary's prewrite is gone and nothing can lock it again
  ORDER     the plain writer's committed writes are not 1, 2, ... in order
            with no gap and no repeat
  RYW       the plain writer's read missed its own answered write, and that
            same copy of the write is committed
  done      AG EF: every program can end once faults stop (liveness)
REPORTED, NOT COUNTED (mode `info`): what an early answer's contract allows
  EARLY-LOST    an early-answered command is gone from the log and the network
  RESULT        an early answer's result differs from the result the committed
                log gives the same command (spec only)
  EARLY-HOLDERS two holders hold a grant at any stage, neither lease lapsed
  READBACK      a later snapshot older, on a key read from a memory prefix
"""

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..',
                                'E16-controller-loop', 'engine'))
from engine import Action, Guard, Update   # noqa: E402

FIELDS = ('grp', 'tso', 'cli', 'hold', 'rdr', 'net', 'gh', 'fl', 'bad', 'wr', 'pr')
IX = {f: i for i, f in enumerate(FIELDS)}
GN = ('A', 'B')
RULES = ('W1.pw', 'W1.cm', 'W1.chk', 'W1.claim', 'O.seq', 'Y', 'RD.txn', 'RD.plain',
         'R1s', 'R2.txn', 'R2.claim', 'R2.put', 'R3.fence', 'R3.stale', 'R3.res', 'R3.read')
DONE_C = ('end', 'crashed')
KINDS = ('pw', 'cm', 'chk', 'claim', 'put', 'set')
_all = lambda s: {k: s for k in KINDS}
STAGES = {
    'cmt': _all('cmt'),
    'recv': _all('recv'),
    'repl': _all('repl'),
    # the library pipelines its own steps early; the caller's answers are durable
    'mixr': dict(pw='recv', chk='recv', claim='recv', cm='cmt', put='cmt', set='recv'),
    'mixp': dict(pw='repl', chk='repl', claim='repl', cm='cmt', put='cmt', set='repl'),
    'mem': _all('mem'),
    'disk': _all('disk'),
    'e1': dict(pw='disk', cm='disk', chk='disk', claim='disk', put='disk', set='mem'),
}
# gh slots
G_TOLD, G_HI, G_GRANTS, G_LAPSED, G_EXP, G_ACKS, G_EARLY, G_SEEN, G_MISS = range(9)


def expand(names):
    """'W1' means every W1.* rule; 'R3.fence' means itself."""
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
    if op == 'set':
        return f'plain write {cmd[2]} of p' + (f' (copy {cmd[3] + 1})' if cmd[3] else '')
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


class Ack:
    FORM = 'S1'            # S0, S1 (commit at disk) or S2 (commit in memory)
    STAGE = 'cmt'          # a key of STAGES
    RES = 'spec'           # spec or blind
    RULESET = ()
    CALM = ('deliver', 'time')
    INFO = ()

    def __init__(self, bound):
        self.b = bound
        self.keys = dict(bound.get('keys', {}))           # key -> group index
        self.txns = tuple(bound.get('txns', ()))          # ((keys...), primary)
        self.readers = tuple(bound.get('readers', ()))    # ((keys...), rounds)
        self.nh = bound.get('holders', 0)
        self.lock = bound.get('lock')                     # (group of #locks, group of x)
        self.cmcopies = bound.get('cmcopies', 2)
        self.early = bound.get('early', False)            # a commit may be resent before its answer
        self.reclaims = bound.get('reclaims', 0)
        self.plain = bound.get('plain')                   # dict(nw, pipeline, read) or None
        self.npr = bound.get('preaders', 0)
        self.gkeys = tuple(tuple(sorted(k for k, g in self.keys.items() if g == gi)) for gi in (0, 1))
        self.kidx = {k: self.gkeys[g].index(k) for k, g in self.keys.items()}
        self.R = expand(self.RULESET)
        self.mode = bound.get('mode', 'bug')              # 'bug' or 'info'
        self.st = STAGES[self.STAGE]
        self.ds = 'disk' if self.FORM == 'S2' else 'cmt'
        self._fc = {}

    def mutated(self, m):
        self.R = expand(self.RULESET) - (expand(m.drop) if m is not None else set())
        self._fc = {}

    # ------------------------------------------------------------ stages
    def stage(self, kind):
        return self.st[kind]

    def act(self, kind):
        """The stage at which a program acts on an answer of this kind."""
        if kind == 'set':
            return self.st['set']
        if self.RES == 'blind' or ('W1.' + kind) in self.R:
            return self.ds
        return self.st[kind]

    def durable(self, kind):
        """A promise of this kind counts only when its caller chose the durable stage."""
        return self.st[kind] == self.ds

    def lim(self, st, gi, stage):
        L, m, k, term = st[0][gi]
        if gi == 1 or stage == 'recv':
            return len(L)
        if stage in ('repl', 'mem'):
            return m
        if stage == 'cmt':
            return m if self.FORM == 'S2' else k
        return k                                        # disk

    def cpt(self, st):
        L, m, k, term = st[0][0]
        return m if self.FORM == 'S2' else k

    # ------------------------------------------------------------ state
    def init(self):
        grp = (((), 0, 0, 1), ((), 0, 0, 1))
        cli = tuple(('start', 0, 0, (), (), tuple(0 for _ in t[0]), 0) for t in self.txns)
        hold = tuple(('start', 0, 0, 0, (), 0, 0) for _ in range(self.nh))
        rdr = tuple(('start', 0, 0, (), (), (), 0) for _ in self.readers)
        gh = (tuple(None for _ in self.txns), (0, 0), (), (), (), (), (), (), ())
        wr = ('run', 1, tuple(0 for _ in range(self.plain['nw'])), ()) if self.plain else ()
        pr = tuple('start' for _ in range(self.npr))
        return (grp, 1, cli, hold, rdr, (), gh, (0, 0, 0, 0), (), wr, pr)

    def to_draft(self, st):
        return dict(zip(FIELDS, st))

    def freeze(self, d):
        return self.autotell(tuple(d.f[f] for f in FIELDS))

    def _d(self, st):
        class D:
            pass
        d = D()
        d.f = self.to_draft(st)
        return d

    # ------------------------------------------------------------ the state machine
    def empty(self, gi):
        return (tuple((None, ()) for _ in self.gkeys[gi]), (None, 0, 0), 0, None, 0, (), 0)

    def apply(self, gi, fs, cmd, ts):
        """ts: the TSO value the leader took when it appended the entry (a claim's commit ts)."""
        mv, lrow, fence, px, ep, pl, last = fs
        op = cmd[0]
        if op == 'noop':
            return fs, None
        if op == 'epoch':
            if 'R3.fence' in self.R:
                fence = max(fence, cmd[1])
            return (mv, lrow, fence, px, ep + 1, pl, last), None
        if op == 'set':
            _, w, n, att = cmd
            if 'O.seq' in self.R:
                if n <= last:
                    return fs, ('dup',)
                if n != last + 1:
                    return fs, ('gap',)
                return (mv, lrow, fence, px, ep, pl + ((n, att),), n), ('ok',)
            return (mv, lrow, fence, px, ep, pl + ((n, att),), last), ('ok',)
        if op in ('pw', 'cm', 'chk', 'res'):
            s, k = cmd[1], cmd[2]
            i = self.kidx[k]
            lock, ws = mv[i]
            rec = next((w for w in ws if w[1] == s), None)

            def put(lock2, ws2):
                m2 = list(mv)
                m2[i] = (lock2, tuple(sorted(ws2)))
                return (tuple(m2), lrow, fence, px, ep, pl, last)
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
                return (mv, (h, ts, ver + 1), fence, px, ep, pl, last), ('granted', ts)
            return fs, ('busy',)
        if op == 'put':
            _, h, t = cmd
            if t < fence:
                return fs, ('fenced',)
            return (mv, lrow, t, (h, t), ep, pl, last), ('ok',)
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
        L = st[0][gi][0]
        return L if gi == 1 else L[:self.cpt(st)]

    def vis(self, st, gi, rule):
        """The prefix a reader sees: the committed one, or under RD.* in S2 the majority-disk one."""
        L, m, k, term = st[0][gi]
        if gi == 1:
            return L
        if self.FORM == 'S2' and rule in self.R:
            return L[:k]
        return L[:self.cpt(st)]

    def vis_durable(self, gi, rule):
        return gi == 1 or self.FORM != 'S2' or rule in self.R

    def cfold(self, st, gi):
        return self.fold(gi, self.cpre(st, gi))

    def ans(self, st, gi, cmd, stage, raw=False):
        """The answer a client reads for cmd at a stage: the last entry of cmd below the stage's point."""
        L = st[0][gi][0]
        n = self.lim(st, gi, stage)
        for j in range(n - 1, -1, -1):
            if L[j][1] == cmd:
                if not raw and self.RES == 'blind' and gi == 0 and stage != self.ds:
                    return ('accepted',)
                return self.fold(gi, L)[1][j]
        return None

    def inflight(self, st, gi, cmd):
        if (gi, cmd) in st[IX['net']]:
            return True
        wr = st[IX['wr']]
        return bool(wr) and gi == 0 and cmd in wr[3]

    def gone(self, st, gi, cmd):
        """A command is lost: no copy in flight and no entry in the leader's log (committed or not)."""
        return not self.inflight(st, gi, cmd) and not any(e[1] == cmd for e in st[IX['grp']][gi][0])

    def kv(self, st, k, rule='RD.txn'):
        gi = self.keys[k]
        return self.fold(gi, self.vis(st, gi, rule))[0][0][self.kidx[k]]

    def ckv(self, st, k):
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
        if (gi, cmd) not in g[G_ACKS]:
            self.gh(d, G_ACKS, tuple(sorted(g[G_ACKS] + ((gi, cmd),))))

    def early_tell(self, d, gi, cmd, r):
        g = d.f['gh']
        if not any(x[0] == gi and x[1] == cmd for x in g[G_EARLY]):
            self.gh(d, G_EARLY, tuple(sorted(g[G_EARLY] + ((gi, cmd, r),))))

    def fence_new(self, d, gi, pre, lo):
        """FENCE: entries pre[lo:] have just committed at group gi."""
        _, rs = self.fold(gi, pre)
        hi = d.f['gh'][G_HI][gi]
        for j in range(lo, len(pre)):
            cmd = pre[j][1]
            if cmd[0] == 'put' and rs[j] == ('ok',) and cmd[2] < hi:
                self.addbad(d, 'FENCE')

    def epoch_of(self, st, gi):
        return self.cfold(st, gi)[0][4]

    # ------------------------------------------------------------ early answers, told when first in
    def autotell(self, st):
        """Record every early answer to a caller's own promise in the first state where it is in."""
        grp, tso, cli, hold, rdr, net, gh, fl, bad, wr, pr = st
        new = []
        told = {(x[0], x[1]) for x in gh[G_EARLY]}

        def look(gi, cmd, kind):
            if self.durable(kind) or (gi, cmd) in told:
                return
            r = self.ans(st, gi, cmd, self.stage(kind))
            if r is not None:
                new.append((gi, cmd, r))
                told.add((gi, cmd))
        for i, c in enumerate(cli):
            if c[0] == 'cm':
                keys, p = self.txns[i]
                look(self.keys[p], ('cm', c[1], p, c[2], c[3][keys.index(p)]), 'cm')
        for h, x in enumerate(hold):
            if x[0] == 'claimw':
                look(self.lock[0], ('claim', h, x[1], x[4]), 'claim')
            elif x[0] == 'putw':
                look(self.lock[1], ('put', h, x[2]), 'put')
        acks = []
        if wr:
            for n in range(1, wr[1]):
                cmd = ('set', 0, n, wr[2][n - 1])
                look(0, cmd, 'set')
                if self.durable('set') and (0, cmd) not in gh[G_ACKS] and \
                        self.ans(st, 0, cmd, self.ds, raw=True) == ('ok',):
                    acks.append((0, cmd))
        if not new and not acks:
            return st
        g = list(gh)
        g[G_EARLY] = tuple(sorted(gh[G_EARLY] + tuple(new)))
        g[G_ACKS] = tuple(sorted(gh[G_ACKS] + tuple(acks)))
        return st[:IX['gh']] + (tuple(g),) + st[IX['gh'] + 1:]

    # ------------------------------------------------------------ world
    def world(self, st):
        out = []
        grp, tso, cli, hold, rdr, net, gh, fl, bad, wr, pr = st
        L, m, k, term = grp[0]
        S2 = self.FORM == 'S2'
        # a majority holds every entry in memory
        if m < len(L):
            d = self._d(st)
            self.setat(d, 'grp', 0, (L, len(L), k, term))
            if S2:
                self.fence_new(d, 0, L, m)
            out.append((('repl', 'A', f'a majority holds all {len(L)} entries in memory'), 'time', self.freeze(d)))
        # a majority's disks catch up with what a majority holds
        if k < m:
            d = self._d(st)
            self.setat(d, 'grp', 0, (L, m, m, term))
            if not S2:
                self.fence_new(d, 0, L[:m], k)
            out.append((('sync', 'A', f'a majority has {m} entries on disk'), 'time', self.freeze(d)))
        # an unclean stop of the leader alone or of a majority
        if fl[0] < self.b.get('stops', 0):
            for l in range(k, len(L) + 1):
                d = self._d(st)
                if any(r.startswith('R3.') for r in self.R):
                    e = (term + 1, ('epoch', tso), 0)
                else:
                    e = (term + 1, ('noop',), 0)
                L2 = L[:l] + (e,)
                if S2:
                    self.setat(d, 'grp', 0, (L2, l + 1, k, term + 1))
                    self.fence_new(d, 0, L2, min(m, l))
                else:
                    self.setat(d, 'grp', 0, (L2, k, k, term + 1))
                self.setat(d, 'fl', 0, fl[0] + 1)
                out.append((('stop', 'A', f'an unclean stop (power loss): {len(L)} entries, {m} held by a majority, '
                             f'{k} on a majority\'s disks; the new leader keeps {l}'), 'fault', self.freeze(d)))
        # the leader's process stops, page cache kept; the followers elect a new leader
        if fl[3] < self.b.get('lcrash', 0):
            for l in range(m, len(L) + 1):
                d = self._d(st)
                L2 = L[:l] + ((term + 1, ('noop',), 0),)
                self.setat(d, 'grp', 0, (L2, m, k, term + 1))
                self.setat(d, 'fl', 3, fl[3] + 1)
                out.append((('lcrash', 'A', f'the leader\'s process stops (page cache kept): {len(L)} entries, '
                             f'{m} held by a majority; the new leader keeps {l}'), 'fault', self.freeze(d)))
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
                if x[0] in ('put', 'putw') and x[2] not in gh[G_LAPSED]:
                    d = self._d(st)
                    self.gh(d, G_LAPSED, tuple(sorted(gh[G_LAPSED] + (x[2],))))
                    self.setat(d, 'fl', 1, fl[1] + 1)
                    out.append((('lapse', f'h{h}', f'token {x[2]}'), 'fault', self.freeze(d)))
        # a lock's TTL runs out (time passes)
        for i, c in enumerate(cli):
            s = c[1]
            if s and s not in gh[G_EXP] and any(self.ckv(st, k)[0] is not None and self.ckv(st, k)[0][0] == s
                                                for k in self.txns[i][0]):
                d = self._d(st)
                self.gh(d, G_EXP, tuple(sorted(gh[G_EXP] + (s,))))
                out.append((('expire', f'T{i}', f'the TTL of txn {s}\'s locks runs out'), 'time', self.freeze(d)))
        return out

    # ------------------------------------------------------------ properties
    def check(self, st):
        grp, tso, cli, hold, rdr, net, gh, fl, bad, wr, pr = st
        info = self.mode == 'info'
        out = [b for b in bad if b.startswith('i:') == info]
        out = [b[2:] if info else b for b in out]
        if info:
            for gi, cmd, r in gh[G_EARLY]:
                if gi == 0 and self.gone(st, gi, cmd):
                    out.append('EARLY-LOST')
                if r != ('accepted',):
                    r2 = self.ans(st, gi, cmd, self.ds, raw=True)
                    if r2 is not None and r2 != r:
                        out.append('RESULT')
            live = [h for h, x in enumerate(hold) if x[2] > 0 and x[2] not in gh[G_LAPSED]]
            if len(live) > 1:
                out.append('EARLY-HOLDERS')
            return sorted(set(out))
        for gi, cmd in gh[G_ACKS]:
            if not any(e[1] == cmd for e in grp[gi][0]):
                out.append('DURABLE')
        for i, t in enumerate(gh[G_TOLD]):
            s = cli[i][1]
            keys = self.txns[i][0]
            if t == 'committed' and any(self.has_rb(self.ckv(st, k)[1], s) for k in keys):
                out.append('DURABLE')
            if t == 'aborted' and any(self.has_put(self.ckv(st, k)[1], s) for k in keys):
                out.append('REFUSED')
        # OTHERS.txn
        for i, (keys, p) in enumerate(self.txns):
            s = cli[i][1]
            if not s:
                continue
            recs = {k: self.ckv(st, k) for k in keys}
            puts = [k for k in keys if self.has_put(recs[k][1], s)]
            rbs = [k for k in keys if self.has_rb(recs[k][1], s)]
            if puts and rbs:
                out.append('OTHERS.txn')
            elif p in puts and cli[i][0] != 'pw':
                for k in keys:
                    lock, ws = recs[k]
                    if k != p and not any(w[1] == s for w in ws) and not (lock is not None and lock[0] == s):
                        e = cli[i][3][keys.index(k)]
                        if self.gone(st, self.keys[k], ('pw', s, k, p, e)) and not any(
                                e_[1][0] == 'pw' and e_[1][1] == s and e_[1][2] == k for e_ in grp[self.keys[k]][0]):
                            out.append('OTHERS.txn')
        # OTHERS.read
        for x in gh[G_SEEN]:
            if x[0] == 't':
                # the reader saw txn s committed; its decision (the primary's commit record) is gone
                p = next(t[1] for i, t in enumerate(self.txns) if cli[i][1] == x[2])
                if not self.has_put(self.ckv(st, x[1])[1], x[2]) and not self.has_put(self.ckv(st, p)[1], x[2]):
                    out.append('OTHERS.read')
            elif (x[1], x[2]) not in self.cfold(st, 0)[0][5]:
                out.append('OTHERS.read')
        # OTHERS.lock
        if self.lock:
            gl, gx = self.lock
            pre = self.cpre(st, gx)
            _, rs = self.fold(gx, pre)
            for j, e in enumerate(pre):
                if e[1][0] == 'put' and rs[j] == ('ok',):
                    t = e[1][2]
                    if not any(f[1][0] == 'claim' and f[2] == t for f in grp[gl][0]):
                        out.append('OTHERS.lock')
        # HOLDERS, ONCE
        live = [h for h, x in enumerate(hold) if x[6] > 0 and x[6] not in gh[G_LAPSED]]
        if len(live) > 1:
            out.append('HOLDERS')
        for k in self.keys:
            ws = self.ckv(st, k)[1]
            ss = [w[1] for w in ws if w[2] == 'put']
            if len(ss) != len(set(ss)):
                out.append('ONCE')
        # ORDER, RYW
        if self.plain:
            pl = self.cfold(st, 0)[0][5]
            ns = tuple(n for n, _ in pl)
            if ns != tuple(range(1, len(ns) + 1)):
                out.append('ORDER')
            for cmd in gh[G_MISS]:
                if (cmd[2], cmd[3]) in pl:
                    out.append('RYW')
        return sorted(set(out))

    def check_edge(self, s, lab, kind, t):
        return []

    def goals(self, st):
        wr = st[IX['wr']]
        return {'done': all(c[0] in DONE_C for c in st[IX['cli']]) and all(h[0] == 'end' for h in st[IX['hold']])
                and all(r[0] == 'end' for r in st[IX['rdr']]) and (not wr or wr[0] == 'end')
                and all(p == 'end' for p in st[IX['pr']])}

    def judged(self, st):
        return {'done': True}

    # ------------------------------------------------------------ rule tests (E-47's, with the rung of A from the form)
    def rung(self, gi):
        return 'M' if (gi == 0 and self.FORM == 'S2') else 'P'

    def txn_refused(self, i):
        keys = self.txns[i][0]
        gs = {self.keys[k] for k in keys}
        rs = {self.rung(g) for g in gs}
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

        def tell(d, i, what, gi, cmd, r):
            """The transaction's outcome: a counted promise if the caller chose the durable stage for it."""
            if O.durable('cm'):
                O.gh(d, G_TOLD, tuple(what if j == i else x for j, x in enumerate(d.f['gh'][G_TOLD])))
            else:
                O.early_tell(d, gi, cmd, r)

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
                        r = O.ans(st, O.keys[k], pwcmd(st, i, k), O.act('pw'))
                        if r is not None:
                            yield {'i': i, 'k': k, 'r': r}

        def pwack(w, st, b, d):
            i, k, r = b['i'], b['k'], b['r']
            c = C(st, i)
            if r == 'ok':
                if O.act('pw') == O.ds and O.durable('cm'):
                    O.ack(d, O.keys[k], pwcmd(st, i, k))
                acks = tuple(sorted(c[4] + (k,)))
                setc(d, i, acks=acks, pc='getc' if len(acks) == len(O.txns[i][0]) else 'pw')
            else:
                tell(d, i, 'aborted', O.keys[k], pwcmd(st, i, k), r)
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
                r = O.ans(st, O.keys[p], cmcmd(st, i, p), O.act('cm'))
                if r is not None:
                    yield {'i': i, 'r': r}

        def cmack(w, st, b, d):
            i, r = b['i'], b['r']
            p = O.txns[i][1]
            cmd = cmcmd(st, i, p)
            if r == 'ok':
                if O.durable('cm'):
                    O.ack(d, O.keys[p], cmd)
                tell(d, i, 'committed', O.keys[p], cmd, r)
                setc(d, i, pc='cms')
            else:
                tell(d, i, 'unknown' if r == 'stale' else 'aborted', O.keys[p], cmd, r)
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

        # --- a reader of transaction keys
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
                if O.vis_durable(O.keys[k], 'RD.txn'):
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
                shown = tuple(('t', x[0], x[1]) for x in seen if x[1])
                if shown:
                    O.gh(d, G_SEEN, tuple(sorted(set(d.f['gh'][G_SEEN] + shown))))
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
                if lock is not None and lock[0] <= rd[2] and lock[0] in st[IX['gh']][G_EXP]:
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
                    stt = O.ans(st, O.keys[p], ('chk', s, p), O.act('chk'))
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
            pc, att, tok, tries, over, rs, dtok = d.f['hold'][h]
            v = dict(pc=pc, att=att, tok=tok, tries=tries, over=over, rs=rs, dtok=dtok)
            v.update(kw)
            O.setat(d, 'hold', h, (v['pc'], v['att'], v['tok'], v['tries'], v['over'], v['rs'], v['dtok']))

        def claimcmd(st, h):
            x = st[IX['hold']][h]
            return ('claim', h, x[1], x[4])
        H = lambda b: f'h{b["h"]}'

        def claim(w, st, b, d):
            h = b['h']
            att = st[IX['tso']]
            d.f['tso'] = att + 1
            over = st[IX['gh']][G_LAPSED]
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
                r = O.ans(st, O.lock[0], claimcmd(st, b['h']), O.act('claim'))
                if r is not None:
                    yield {'h': b['h'], 'r': r}

        def clack(w, st, b, d):
            h, r = b['h'], b['r']
            if r[0] == 'granted':
                t = r[1]
                dt = 0
                if O.durable('claim'):
                    g = d.f['gh']
                    if any(tk == t for tk, _ in g[G_GRANTS]):
                        O.addbad(d, 'TOKEN')
                    O.gh(d, G_GRANTS, tuple(sorted(g[G_GRANTS] + ((t, h),))))
                    O.ack(d, O.lock[0], claimcmd(st, h))
                    dt = t
                seth(d, h, pc='put', tok=t, dtok=dt)
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
                r = O.ans(st, O.lock[1], putcmd(st, b['h']), O.act('put'))
                if r is not None:
                    yield {'h': b['h'], 'r': r}

        def puack(w, st, b, d):
            h, r = b['h'], b['r']
            x = st[IX['hold']][h]
            if r == ('ok',):
                if O.durable('put'):
                    g = d.f['gh']
                    hi = list(g[G_HI])
                    hi[O.lock[1]] = max(hi[O.lock[1]], x[2])
                    O.gh(d, G_HI, tuple(hi))
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

        # --- the plain writer W: (pc, next seq to send, attempt per seq, copies in flight in send order)
        def wcmd(wr, n):
            return ('set', 0, n, wr[2][n - 1])

        def wready(st, wr, n):
            """W may act on write n: its answer is in at the set's stage and is not a refusal."""
            r = O.ans(st, 0, wcmd(wr, n), O.act('set'))
            return r is not None and r != ('gap',)

        def wsend(w, st):
            wr = st[IX['wr']]
            if wr and wr[0] == 'run' and wr[1] <= O.plain['nw']:
                n = wr[1]
                if n == 1 or O.plain.get('pipeline') or wready(st, wr, n - 1):
                    yield {'n': n}

        def wsendu(w, st, b, d):
            wr = d.f['wr']
            n = b['n']
            d.f['wr'] = (wr[0], n + 1, wr[2], wr[3] + (wcmd(wr, n),))
        acts.append(Action('w.send', 'deliver', wsend, [], [Update('send', wsendu)],
                           label=lambda b: ('W', f'sends plain write {b["n"]}')))

        def wdone(st, wr, n):
            return O.ans(st, 0, wcmd(wr, n), O.ds, raw=True) in (('ok',), ('dup',))

        def wresend(w, st):
            wr = st[IX['wr']]
            if not wr or wr[0] == 'end':
                return
            for n in range(1, wr[1]):
                if wdone(st, wr, n):
                    continue
                cmd = wcmd(wr, n)
                bad = O.gone(st, 0, cmd) or O.ans(st, 0, cmd, O.ds, raw=True) == ('gap',) or \
                    (O.RES == 'spec' and O.ans(st, 0, cmd, O.act('set')) == ('gap',)) or \
                    (O.plain.get('timeout') and O.ans(st, 0, cmd, O.ds, raw=True) is None)
                if bad and wr[2][n - 1] >= 1:
                    continue                                # given up on this one: no budget left
                if bad:
                    yield {'n': n}
                return                                      # lowest first: later writes wait for it

        def wresendu(w, st, b, d):
            wr = d.f['wr']
            n = b['n']
            atts = tuple(a + (1 if i == n - 1 else 0) for i, a in enumerate(wr[2]))
            wr2 = (wr[0], wr[1], atts, wr[3])
            d.f['wr'] = (wr[0], wr[1], atts, wr[3] + (wcmd(wr2, n),))
        acts.append(Action('w.again', 'deliver', wresend, [], [Update('send', wresendu)],
                           label=lambda b: ('W', f'sends plain write {b["n"]} again (gone or refused)')))

        def wdeliver(w, st):
            wr = st[IX['wr']]
            if wr and wr[3]:
                yield {'cmd': wr[3][0]}

        def wdeliveru(w, st, b, d):
            wr = d.f['wr']
            d.f['wr'] = (wr[0], wr[1], wr[2], wr[3][1:])
            L, m, k, term = st[IX['grp']][0]
            O.setat(d, 'grp', 0, (L + ((term, b['cmd'], 0),), m, k, term))
        acts.append(Action('w.deliver', 'deliver', wdeliver, [], [Update('append', wdeliveru)],
                           label=lambda b: ('A', pretty(b['cmd']))))

        def wreads(w, st):
            wr = st[IX['wr']]
            if wr and wr[0] == 'run' and O.plain.get('read') and wr[1] > O.plain['nw']:
                n = O.plain['nw']
                cmd = wcmd(wr, n)
                if O.ans(st, 0, cmd, O.act('set')) is None:
                    return
                if 'Y' in O.R:
                    vis = O.vis(st, 0, 'RD.plain')
                    if not (any(e[1] == cmd for e in vis) or O.gone(st, 0, cmd)):
                        return
                pl = O.fold(0, O.vis(st, 0, 'RD.plain'))[0][5]
                yield {'got': tuple(x for x, _ in pl), 'miss': (n, wr[2][n - 1]) not in pl}

        def wreadu(w, st, b, d):
            wr = d.f['wr']
            d.f['wr'] = ('track', wr[1], wr[2], wr[3])
            if b['miss']:
                n = O.plain['nw']
                O.gh(d, G_MISS, tuple(sorted(d.f['gh'][G_MISS] + (wcmd(wr, n),))))
        acts.append(Action('w.read', 'deliver', wreads, [], [Update('take', wreadu)],
                           label=lambda b: ('W', f'reads p: writes {list(b["got"])}' +
                                            (' (its own write missing)' if b['miss'] else ''))))

        def wends(w, st):
            """W stops once every write it sent is durable or given up (no budget left), and it has sent and read
            all it meant to, or it gave one up (then it reports the failure and stops)."""
            wr = st[IX['wr']]
            if not wr or wr[0] == 'end':
                return
            gave = False
            for n in range(1, wr[1]):
                if wdone(st, wr, n):
                    continue
                cmd = wcmd(wr, n)
                if wr[2][n - 1] >= 1 and (O.gone(st, 0, cmd) or O.ans(st, 0, cmd, O.ds, raw=True) == ('gap',)):
                    gave = True                             # given up: no budget left
                    continue
                return
            if not gave and (wr[1] <= O.plain['nw'] or (wr[0] == 'run' and O.plain.get('read'))):
                return
            yield {}

        acts.append(Action('w.end', 'deliver', wends, [],
                           [Update('end', lambda w, st, b, d: d.f.__setitem__('wr', ('end',) + d.f['wr'][1:]))],
                           label=lambda b: ('W', 'every write durable or given up')))

        # --- a plain reader
        def preads(w, st):
            for j, p in enumerate(st[IX['pr']]):
                if p == 'start':
                    pl = O.fold(0, O.vis(st, 0, 'RD.plain'))[0][5]
                    yield {'j': j, 'pl': pl}

        def preadu(w, st, b, d):
            O.setat(d, 'pr', b['j'], 'end')
            shown = tuple(('p', n, a) for n, a in b['pl'])
            if shown:
                O.gh(d, G_SEEN, tuple(sorted(set(d.f['gh'][G_SEEN] + shown))))
        acts.append(Action('p.read', 'deliver', preads, [], [Update('take', preadu)],
                           label=lambda b: (f'P{b["j"]}', f'reads p: writes {[n for n, _ in b["pl"]]}')))

        # --- the network: a leader appends a copy (group B commits at once)
        def copies(w, st):
            for gi, cmd in sorted(set(st[IX['net']])):
                yield {'g': gi, 'cmd': cmd}

        def deliver(w, st, b, d):
            gi, cmd = b['g'], b['cmd']
            net = list(st[IX['net']])
            net.remove((gi, cmd))
            d.f['net'] = tuple(net)
            L, m, k, term = st[IX['grp']][gi]
            ts = 0
            if cmd[0] == 'claim':
                ts = st[IX['tso']]       # the claim commits with a fresh timestamp: its token
                d.f['tso'] = ts + 1
            L2 = L + ((term, cmd, ts),)
            if gi == 1:
                O.setat(d, 'grp', 1, (L2, len(L2), len(L2), term))
                O.fence_new(d, 1, L2, len(L))
            else:
                O.setat(d, 'grp', 0, (L2, m, k, term))
        acts.append(Action('deliver', 'deliver', copies, [], [Update('append', deliver)],
                           label=lambda b: (GN[b['g']], pretty(b['cmd']))))
        return acts


def option(form, stage, rules=(), res='spec', name=None):
    nm = name or (form + '-' + stage + ('-blind' if res == 'blind' else '') + ('-' + '+'.join(rules) if rules else ''))
    return type('Ack_' + nm.replace('-', '_').replace('+', '_').replace('.', '_'), (Ack,),
                {'FORM': form, 'STAGE': stage, 'RULESET': tuple(rules), 'RES': res})


OPTIONS = {}
OPTIONS['S0'] = option('S0', 'cmt')
for _st in ('recv', 'repl', 'mixr', 'mixp'):
    OPTIONS['S1-' + _st] = option('S1', _st)
    OPTIONS['S1-' + _st + '-W1'] = option('S1', _st, ('W1',))
    OPTIONS['S1-' + _st + '-blind'] = option('S1', _st, res='blind')
for _st in ('mem', 'disk', 'e1'):
    OPTIONS['S2-' + _st] = option('S2', _st)

TX = dict(stops=1, crashes=1, cmcopies=1, early=False)
BOUNDS = {
    # E-47's bounds, unchanged
    'txn': dict(keys={'a': 0, 'b': 1}, txns=((('a', 'b'), 'a'),), readers=((('a', 'b'), 2),), **TX),
    'txnb': dict(keys={'a': 0, 'b': 1}, txns=((('a', 'b'), 'b'),), readers=((('a', 'b'), 2),), **TX),
    'txn1': dict(keys={'a': 0, 'c': 0}, txns=((('a', 'c'), 'a'),), readers=((('a', 'c'), 1),), **TX),
    'dedup': dict(keys={'x': 0}, txns=((('x',), 'x'),), readers=((('x',), 1),), stops=1, crashes=0,
                  cmcopies=2, early=True),
    'lockAA': dict(lock=(0, 0), holders=2, lapses=1, stops=1),
    'lockBA': dict(lock=(1, 0), holders=2, lapses=1, stops=1),
    'lockAB': dict(lock=(0, 1), holders=2, lapses=1, stops=1),
    # plain writes: two pipelined writes and a reader; one write then a read of it
    'pipe': dict(plain=dict(nw=2), preaders=1, stops=1),
    'pipe-s': dict(plain=dict(nw=2, pipeline=True), preaders=1, stops=1),
    'ryw': dict(plain=dict(nw=1, read=True), stops=1),
    # the plain writer may also send a write again on a timeout, while a copy is still in the log or in flight
    'pipe-t': dict(plain=dict(nw=2, timeout=True), preaders=1, stops=1),
}
for _b in list(BOUNDS):
    BOUNDS[_b + '-c'] = dict(BOUNDS[_b], stops=0, lcrash=1)     # the leader's process crash instead of a power loss
SWEEP = ('txn', 'txnb', 'txn1', 'dedup', 'lockAA', 'lockBA', 'lockAB', 'pipe', 'ryw')
VERIFY = ()
