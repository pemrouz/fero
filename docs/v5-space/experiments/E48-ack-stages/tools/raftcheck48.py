#!/usr/bin/env python3
"""
raftcheck48.py: E-48's brute-force check of the Raft step under the ack-stage
forms, on three explicit copies. It extends E-47's tools/raftcheck.py (copied
idea, new code): each follower now sends two reports to the leader, one when
it holds an entry in memory and one when it has it on disk, and the leader's
view of those reports lags the follower's real state.

THE EXPLICIT MODEL. Copy 0 starts as leader. Each copy has a log length h and a
synced length s <= h. The leader keeps, per follower i, the last memory report
ma_i <= h_i and the last disk report da_i <= s_i it has heard. Steps: the leader
appends one entry (up to N); the leader sends one more entry to a follower; any
copy syncs one more entry; a follower reports its h (memory report, only where
the form has one) or its s (disk report). From the leader's view:
  c   = second largest of (s0, da1, da2)   Raft's commit point under `persisted`
                                           (S0, S1): disk reports only
  rp  = second largest of (h0, ma1, ma2)   S1's `replicated` stage (answers only),
                                           and S2's commit point
  len = h0                                 S1's `received` stage
and the true points k = second largest s (majority on disk), m = second largest
h (majority in memory).

FAULTS, then every election Raft allows: a candidate whose log is at least as
long as that of a majority of copies that may vote (itself included). Before
the fault every log is a prefix of the leader's, one term, so "at least as up
to date" is "at least as long".
  intact   no copy loses anything (a process crash with the page cache kept, a
           partition, a slow leader): any election over (h0, h1, h2)
  u1       one copy stops uncleanly (power loss of that machine): it keeps only
           s; then any election
  u2       two or three copies stop uncleanly; then any election
Two voting rules for copies that stopped uncleanly:
  vote     they vote on their synced prefix, as `persisted` Raft allows (their
           disk reports never covered more than they synced)
  cbn      the memory rung's rule: they come back as new and neither vote nor
           lead; if no voting majority is left, the operator's recovery starts
           the group from the longest log any copy holds (E-47's rule 15) or,
           for comparison, from the survivors alone

WHAT IS CHECKED (results/raftcheck.txt)
  (A) S1 leaves `persisted` Raft as it was: the reachable states projected onto
      (h, s, disk reports) are the same set with and without memory reports,
      and so is every fault's set of (projection, new log length). Memory
      reports change no transition and no commit.
  (B) c <= k and rp <= m in every state (the leader never over-counts).
  (C) S0/S1, unclean copies voting: no fault ever cuts below c (no committed
      entry lost). Counted: how often each fault cuts below rp (an answer at
      `replicated` lost) and below len (an answer at `received` lost). And a
      variant of `replicated`, all three copies hold it in memory (rp3 = the
      smallest of h0, ma1, ma2): no single fault loses it (checked).
  (D) The abstract steps of models/ackstage.py are sound: an intact-log
      election cuts to [m, len]; any unclean stop with voting cuts to [k, len];
      per (len, m, k) the unclean cuts reach all of [k, len].
  (E) S2 (commit at rp): with unclean copies voting, one unclean stop alone
      cuts below the commit point (counted). With cbn, no single fault does;
      a majority stop leaves no voting majority, and the operator's recovery
      from the longest log stays inside [k, len] (from the survivors alone it
      cuts below k).
"""
import itertools
import sys
import time


def second(xs):
    return sorted(xs)[-2]


def reach(N, mem):
    start = (0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
    seen = {start}
    todo = [start]
    while todo:
        st = todo.pop()
        h0, s0 = st[0], st[1]
        nxt = []
        if h0 < N:
            nxt.append((h0 + 1,) + st[1:])
        if s0 < h0:
            nxt.append((h0, s0 + 1) + st[2:])
        for base in (2, 6):
            h, s, ma, da = st[base:base + 4]
            for v in ((h + 1, s, ma, da) if h < h0 else None,
                      (h, s + 1, ma, da) if s < h else None,
                      (h, s, h, da) if mem and ma < h else None,
                      (h, s, ma, s) if da < s else None):
                if v is not None:
                    t = st[:base] + v + st[base + 4:]
                    nxt.append(t)
        for t in nxt:
            if t not in seen:
                seen.add(t)
                todo.append(t)
    return seen


def winners(post, allowed):
    """New log lengths Raft can elect: a candidate with a majority (2 of 3) of allowed voters no longer than it."""
    out = set()
    for c in allowed:
        if sum(1 for v in allowed if post[v] <= post[c]) >= 2:
            out.add(post[c])
    return out


def faults(st):
    """Yield (kind, stopped set, post logs) for every fault from st."""
    h = (st[0], st[2], st[6])
    s = (st[1], st[3], st[7])
    yield 'intact', (), h
    for r in range(3):
        post = tuple(s[i] if i == r else h[i] for i in range(3))
        yield 'u1', (r,), post
    for n in (2, 3):
        for S in itertools.combinations(range(3), n):
            post = tuple(s[i] if i in S else h[i] for i in range(3))
            yield 'u2', S, post


def run(N, mem):
    seen = reach(N, mem)
    kinds = ('intact', 'u1', 'u2')
    z = lambda: {k: 0 for k in kinds}
    c = dict(outcomes=z(), below_c=z(), below_rp=z(), below_len=z(), s2_below_rp=z(),
             cbn_outcomes=z(), cbn_below_rp=z(), cbn_noquorum=z(), op_below_k=z(), op_outside=z(),
             surv=z(), surv_below_k=z(), unsound=z(), over=0, u1_leader_rp=0, u1_follower_rp=0,
             below_rp3=z())
    cuts = {}          # (len, m, k) -> new lengths reached by unclean stops with voting
    outs = set()       # (projection without memory reports, kind, stopped set, new length) for check (A)
    for st in seen:
        h0, s0, h1, s1, ma1, da1, h2, s2, ma2, da2 = st
        L = h0
        k = second((s0, s1, s2))
        m = second((h0, h1, h2))
        cp = second((s0, da1, da2))
        rp = second((h0, ma1, ma2))
        rp3 = min((h0, ma1, ma2))      # a variant of `replicated`: all three copies hold it in memory
        if cp > k or rp > m:
            c['over'] += 1
        proj = (h0, s0, h1, s1, da1, h2, s2, da2)
        for kind, S, post in faults(st):
            # unclean copies vote on their synced prefix (persisted Raft)
            ls = winners(post, (0, 1, 2))
            for l in ls:
                c['outcomes'][kind] += 1
                outs.add((proj, kind, S, l))
                if l < cp:
                    c['below_c'][kind] += 1
                if l < rp:
                    c['below_rp'][kind] += 1
                    c['s2_below_rp'][kind] += 1
                    if kind == 'u1':
                        c['u1_leader_rp' if S == (0,) else 'u1_follower_rp'] += 1
                if l < L:
                    c['below_len'][kind] += 1
                if l < rp3:
                    c['below_rp3'][kind] += 1
                lo = m if kind == 'intact' else k
                if not (lo <= l <= L):
                    c['unsound'][kind] += 1
                if kind != 'intact':
                    cuts.setdefault((L, m, k), set()).add(l)
            if not mem:
                continue
            # the memory rung's rule: copies that stopped uncleanly come back as new (no vote, no lead)
            allowed = tuple(i for i in range(3) if i not in S)
            if len(allowed) >= 2:
                for l in winners(post, allowed):
                    c['cbn_outcomes'][kind] += 1
                    if l < rp:
                        c['cbn_below_rp'][kind] += 1
            else:
                c['cbn_noquorum'][kind] += 1
                l6 = max(post)                     # rule 15: the longest log any copy holds
                if l6 < k:
                    c['op_below_k'][kind] += 1
                if not (k <= l6 <= L):
                    c['op_outside'][kind] += 1
                if allowed:
                    c['surv'][kind] += 1
                    if max(post[i] for i in allowed) < k:
                        c['surv_below_k'][kind] += 1
    exact = sum(1 for (L, m, k), ls in cuts.items() if ls != set(range(k, L + 1)))
    return len(seen), c, outs, exact, len(cuts)


def main():
    Ns = [int(x) for x in sys.argv[1:]] or [1, 2, 3, 4]
    ok = True
    print('(A) S1 against persisted: memory reports change nothing in Raft')
    print(' N  states P  states S1  projections equal  fault outcomes equal')
    res = {}
    for N in Ns:
        t0 = time.time()
        nP, cP, oP, exP, _ = run(N, False)
        nS, cS, oS, exS, pairs = run(N, True)
        projP = {st[:4] + (st[5],) + st[6:8] + (st[9],) for st in reach(N, False)}
        projS = {st[:4] + (st[5],) + st[6:8] + (st[9],) for st in reach(N, True)}
        eq1 = projP == projS
        eq2 = oP == oS
        ok = ok and eq1 and eq2
        res[N] = (nS, cS, exS, pairs, cP)
        print(f'{N:2} {nP:9,} {nS:9,}  {str(eq1):5}  {str(eq2):5}   ({time.time() - t0:.1f}s)')
    print()
    print('(B) the leader never over-counts: states with c > k or rp > m')
    for N in Ns:
        nS, c, ex, pairs, cP = res[N]
        print(f'{N:2} {c["over"]}')
        ok = ok and c['over'] == 0
    print()
    print('(C) S0/S1, copies that stopped uncleanly vote: outcomes (new leader, new log length) per fault, and how many')
    print('    cut below the commit point c (must be 0), below `replicated` (rp) and below `received` (len)')
    print(' N  fault   outcomes   below c  below rp  below len')
    for N in Ns:
        nS, c, ex, pairs, cP = res[N]
        for kd in ('intact', 'u1', 'u2'):
            print(f'{N:2}  {kd:6} {c["outcomes"][kd]:9,} {c["below_c"][kd]:9} {c["below_rp"][kd]:9,} {c["below_len"][kd]:9,}')
            ok = ok and c['below_c'][kd] == 0 and cP['below_c'][kd] == 0
        print(f'      one unclean stop: `replicated` lost {c["u1_leader_rp"]:,} times when the stopped copy is the leader, '
              f'{c["u1_follower_rp"]:,} when it is a follower')
        print(f'      variant `replicated to all three` (rp3 = min of h0, ma1, ma2): lost on intact {c["below_rp3"]["intact"]}, '
              f'u1 {c["below_rp3"]["u1"]} (must be 0), u2 {c["below_rp3"]["u2"]:,}')
        ok = ok and c['below_rp3']['u1'] == 0 and c['below_rp3']['intact'] == 0
    print()
    print('(D) the abstract steps are sound: outcomes outside [m, len] (intact) or [k, len] (unclean), and')
    print('    (len, m, k) triples whose unclean cuts differ from [k, len]')
    for N in Ns:
        nS, c, ex, pairs, cP = res[N]
        u = c['unsound']
        print(f'{N:2}  outside: intact {u["intact"]}, u1 {u["u1"]}, u2 {u["u2"]};  triples differing: {ex} of {pairs}')
        ok = ok and sum(u.values()) == 0 and ex == 0
    print()
    print('(E) S2, commit at rp (memory reports). With unclean voters: cuts below the commit point.')
    print('    With cbn: below the commit point; faults with no voting majority (operator); the operator from the longest')
    print('    log: below k / outside [k, len]; from the survivors alone: faults with a survivor / below k')
    print(' N  fault   vote: below rp   cbn: below rp  no quorum  op longest: <k / outside  survivors: n / <k')
    for N in Ns:
        nS, c, ex, pairs, cP = res[N]
        for kd in ('intact', 'u1', 'u2'):
            print(f'{N:2}  {kd:6} {c["s2_below_rp"][kd]:13,}  {c["cbn_below_rp"][kd]:13,}  {c["cbn_noquorum"][kd]:9,}  '
                  f'{c["op_below_k"][kd]:6} / {c["op_outside"][kd]:3}        {c["surv"][kd]:6,} / {c["surv_below_k"][kd]:5,}')
        ok = ok and c['cbn_below_rp']['intact'] == 0 and c['cbn_below_rp']['u1'] == 0 and \
            c['op_below_k']['u2'] == 0 and c['op_outside']['u2'] == 0 and \
            (c['s2_below_rp']['u1'] > 0 or N == 0)
    print()
    print('all checks hold' if ok else 'A CHECK FAILED')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
