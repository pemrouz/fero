#!/usr/bin/env python3
"""
raftcheck.py: checks E-47's group abstraction against three explicit Raft
replicas, by brute force.

THE ABSTRACTION (models/memrung.py). Group A is kept as its leader's log, the
majority-synced point k (the longest prefix two replicas have on disk) and,
for P, the commit point (= k). An unclean stop of a majority, the restarts and
Raft's election are one step: the new leader's log is the old log cut to any
length l with k <= l <= len.

THE EXPLICIT MODEL (here). Three replicas, each with its own log length h (a
prefix of the leader's log: before the first stop every log is a prefix of the
leader's), its own sync point s <= h, and an up flag. Steps: the leader appends
one entry (up to N); the leader sends one more entry to a follower; a replica
syncs one more entry. The commit point is the second largest h (M: a majority
holds the entry in memory) or the second largest s (P: a majority has it on
disk). Then one unclean stop of any set of two or three replicas: each stopped
replica keeps only its synced prefix (h := s). Then any election Raft allows: a
candidate c and a set of voters V (c in V, |V| >= 2) where every voter's log is
no longer than c's (all entries share one term before the stop, so "at least
as up to date" is "at least as long"). This covers the survivor staying leader
(c = the old leader) and the restarted followers electing one of themselves
while the old leader is alive (they need no vote from it). The new log length
is l = h_c.

WHAT IS CHECKED, for every reachable state before the stop and every stop and
election from it:
  (1) k <= l <= len, where k = the second largest s (no cut below k);
  (2) for each (len, k) reached, the cut lengths reached are all of [k, len]
      (the abstraction adds no cut the explicit model cannot make);
  (3) P: l >= the commit point (no acknowledged entry is lost);
      M: l < the commit point happens (an acknowledged entry can be lost);
  (4) every election after the stop has at least one voter that stopped
      uncleanly, so R3's trigger "a leader elected with any voter that
      restarted uncleanly takes a new epoch" fires after every majority stop.

THE OPERATOR'S RECOVERY (`fero recover --unclean`). Checks (1) to (4) let a
replica that stopped uncleanly vote on its synced prefix. The settled
`memory-rung` unit forbids that for a `memory` group: such a replica comes back
as new and never votes under its old identity. So after a majority stop the
group has no voting majority and waits for the operator, who rebuilds it from
what the replicas hold. Two readings of that rebuild are checked, for M only
(under P a replica that stopped uncleanly still holds all it acknowledged, so
it votes as before):
  (5) no majority stop leaves a voting majority (so the group must wait);
  (6) the recovery rule: the new log is the most up-to-date log any replica
      holds, a stopped replica's synced prefix or a survivor's whole log
      (with one term before the stop, the longest). Checked: k <= l <= len,
      and the cuts it reaches lie inside [k, len], so the model's step covers
      it. (6b) the same with one stopped replica's disk lost (unreadable).
  (7) the other reading, "rebuild from the survivor": the new log is the
      surviving replica's log. Counted: outcomes with l < k, where an entry
      that a majority had on disk is lost.
"""
import itertools
import sys


def second(xs):
    return sorted(xs)[-2]


def run(rung, N):
    start = ((0, 0), (0, 0), (0, 0))          # (h, s) per replica; replica 0 leads
    seen = {start}
    todo = [start]
    while todo:
        st = todo.pop()
        nxt = []
        (h0, s0) = st[0]
        if h0 < N:
            nxt.append(((h0 + 1, s0),) + st[1:])
        for r in (1, 2):
            h, s = st[r]
            if h < h0:
                t = list(st)
                t[r] = (h + 1, s)
                nxt.append(tuple(t))
        for r in (0, 1, 2):
            h, s = st[r]
            if s < h:
                t = list(st)
                t[r] = (h, s + 1)
                nxt.append(tuple(t))
        for t in nxt:
            if t not in seen:
                seen.add(t)
                todo.append(t)
    bad1 = bad3 = lost = clean = 0
    cuts = {}
    outcomes = 0
    rec = {'stops': 0, 'voting': 0, 'below': 0, 'outside': 0, 'below_lost_disk': 0, 'surv': 0, 'surv_below': 0,
           'surv_acked_lost': 0}
    for st in seen:
        L = st[0][0]
        k = second([s for h, s in st])
        cm = second([h for h, s in st]) if rung == 'M' else k
        for n in (2, 3):
            for S in itertools.combinations(range(3), n):
                post = [s if r in S else h for r, (h, s) in enumerate(st)]
                for c in range(3):
                    for m in (2, 3):
                        for V in itertools.combinations(range(3), m):
                            if c not in V or any(post[v] > post[c] for v in V):
                                continue
                            l = post[c]
                            outcomes += 1
                            if not set(V) & set(S):
                                clean += 1
                            if not (k <= l <= L):
                                bad1 += 1
                            if l < cm:
                                if rung == 'P':
                                    bad3 += 1
                                else:
                                    lost += 1
                            cuts.setdefault((L, k), set()).add(l)
                if rung != 'M':
                    continue
                rec['stops'] += 1
                up = [r for r in range(3) if r not in S]
                if len(up) >= 2:
                    rec['voting'] += 1
                l6 = max(post)                 # a stopped replica's synced prefix or a survivor's whole log
                if l6 < k:
                    rec['below'] += 1
                if not (k <= l6 <= L):
                    rec['outside'] += 1
                for r0 in S:                   # one stopped replica's disk is unreadable
                    if max(post[r] for r in range(3) if r != r0) < k:
                        rec['below_lost_disk'] += 1
                if up:
                    rec['surv'] += 1
                    l7 = max(post[r] for r in up)
                    if l7 < k:
                        rec['surv_below'] += 1
                    if l7 < cm:
                        rec['surv_acked_lost'] += 1
    bad2 = sum(1 for (L, k), ls in cuts.items() if ls != set(range(k, L + 1)))
    return len(seen), outcomes, bad1, bad2, bad3, lost, len(cuts), clean, rec


def main():
    Ns = [int(x) for x in sys.argv[1:]] or [1, 2, 3, 4, 5, 6]
    print('rung  N  states  stop+election outcomes  (1) cut below k  (2) (len,k) pairs whose cuts '
          'differ from [k,len]  (4) elections with no stopped voter  (3) P: acked entry lost / M: acked entry lost')
    ok = True
    recs = []
    for rung in ('P', 'M'):
        for N in Ns:
            n, o, b1, b2, b3, lost, pairs, clean, rec = run(rung, N)
            tail = f'{b3} (must be 0)' if rung == 'P' else f'{lost} (must be > 0 for N >= 1)'
            print(f'{rung:4} {N:2} {n:7,} {o:12,}  {b1:6}  {b2:4} of {pairs:3}  {clean:6}  {tail}')
            ok = ok and b1 == 0 and b2 == 0 and clean == 0 and (b3 == 0 if rung == 'P' else (lost > 0 or N == 0))
            if rung == 'M':
                recs.append((N, rec))
    print('abstraction holds (elections by vote)' if ok else 'ABSTRACTION BROKEN (elections by vote)')
    print()
    print('The operator\'s recovery, M only: unclean replicas do not vote (the settled memory-rung unit)')
    print('rung  N  majority stops  (5) leaving a voting majority  (6) recovery rule: l < k / l outside [k,len]  '
          '(6b) one stopped disk lost: l < k  (7) rebuild from the survivor: stops with a survivor / l < k / acked lost')
    rok = True
    for N, r in recs:
        print(f'M    {N:2} {r["stops"]:14,}  {r["voting"]:6}  {r["below"]:6} / {r["outside"]:4}  {r["below_lost_disk"]:6}  '
              f'{r["surv"]:12,} / {r["surv_below"]:6,} / {r["surv_acked_lost"]:6,}')
        rok = rok and r['voting'] == 0 and r['below'] == 0 and r['outside'] == 0 and r['below_lost_disk'] == 0 \
            and (r['surv_below'] > 0 or N == 0)
    print('recovery rule stays inside [k, len]; rebuild from the survivor cuts below k' if rok
          else 'RECOVERY CHECK BROKEN')
    return 0 if ok and rok else 1


if __name__ == '__main__':
    sys.exit(main())
