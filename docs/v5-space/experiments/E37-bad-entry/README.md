# E-37: one bad entry on a voter that keeps its id

**Question (Q-37).** Does each row keep acknowledged writes when one voter keeps its id but loses or corrupts one fsynced entry below the commit point? What is the cheapest fix, counted as DEV-10 says? And with one bad entry on each of two replicas, at different offsets, how often does each storage-fault option (SPACE axis Z) stay writable without F-12's operator step?

**Threshold (QUESTIONS Q-37).** A fix of 2 rules or fewer keeps Raft, with Z `par` or `rejoin` as the count says. More than 2 → R `vsr` (Viewstamped Replication Revisited with protocol-aware recovery, as TigerBeetle runs it) is costed as a candidate row.

IN-SHORT-PENDING

## Words used here

- A **voter** counts toward commits and elections. A **replica** is a member plus its disk incarnation (DESIGN-V5 4.1).
- **Below the commit point**: the damaged entry is at or below the commit index the server itself had written to disk. So the server had acknowledged it, and knew it was committed.
- **Damage** here is one entry that reads back wrong after a restart: lost (a hole) or corrupted (wrong bytes). The rest of the log is intact.
- The **storage-fault options** (SPACE axis Z):
  - **`crash`**: Raft as published. Disks fail only by crashing. With no checksum per entry, a reader cannot tell mid-log damage from a torn tail (a half-written last record), so it cuts the log there, as F-10's rule "a torn tail is cut, not fatal" says. This model calls that mode **cut**. A flip inside an entry's value that nothing checks is mode **silent**.
  - **`rejoin`** (the draft, DESIGN-V5 4.1): a checksum per entry finds the damage; the replica wipes its disk and comes back as a new replica (a new incarnation), which never votes as the old one. Healing then adds it back. The model for "wiped, but back under the old id" is mode **ghost**.
  - **`par`** (protocol-aware recovery, FAST'18; TigerBeetle): a checksum finds the damage; the replica keeps its id and the rest of its log, and repairs the one entry from a peer. This experiment's cheapest form: a damaged replica refuses to vote, take appends or stand until a peer repairs it.
- **Writable**: some leader of the group can commit an entry of its own term (E-14's goal). **Stuck**: no fault-free path leads there.
- **TLC** is the TLA+ model checker. **AG EF** (from every reachable state, the goal can still be reached) is the liveness check E-14 used.

## Method

### The model

[tla/MCbadentry.tla](tla/MCbadentry.tla) `EXTENDS` E-14b's [MCferolive.tla](tla/MCferolive.tla) (copied here unchanged; it `EXTENDS` E-14's MCferoraft.tla, which `EXTENDS` etcd's own `etcdraft.tla`, unchanged). So Raft, etcd's membership rules, crashes, the goal and E-14b's reductions are theirs. The additions:

1. **`DamageRestart(i, k)`, a fault.** Server i restarts, and entry k of its log comes back damaged. k is at or below the commit index i had persisted, and is not the genesis entry. The mode decides what happens next:
   - **cut**: i cuts its log at k (and its commit index with it) and carries on under its id;
   - **silent**: entry k's value is wrong, its term looks right, nothing checks it;
   - **rejoin**: i's disk is wiped and i is gone for good under this id (E-14's lost disk; a spare id could be added by healing);
   - **ghost**: the same wipe, but i comes back at once under its old id, empty (E-14's `GhostReturn`);
   - **par**: entry k is replaced by a zeroed record (term 0, a wrong value) and marked bad (`bad[i] = k`). The fix rules below then apply.
2. **The fix (mode par)**, tagged one rule per line for DEV-10 between `MUTATE-BEGIN` and `MUTATE-END`:
   - the checksum marks the slot bad (`ParDetect`);
   - a damaged server grants no vote and takes no append (`ZNormal`); it drops such requests unanswered (`ZIgnore`);
   - a damaged server does not stand for election (`ZTimeout`);
   - repair (`ZRepair`): a damaged server copies entry k from a peer that is not damaged itself and whose commit index is at least k (so the peer's copy is the committed one, by Raft's state machine safety), then clears the mark. A variant (`RepairFrom = "leader"`) allows only the current leader as the peer.
3. **A ghost and a new property, `NoLostCommit`**: `ghost` is the longest log ever committed. Every server's committed prefix must agree with it, and every leader of a later term must hold it. This catches a committed entry lost over time, which a check of one state can miss (the server that knew it was committed may have restarted).
4. **The 8 shipped invariants, read through `TrueLog`**: in mode par, a bad slot is read as the committed entry it held (the data the group can still repair from peers). So the bad slot itself is not a violation; a vote, a lead or a copy built on it is.

The run constants ([tools/run37.py](tools/run37.py), every `.cfg` in [cfg/](cfg)): three voters; s1 leads in term 2 and its empty entry is committed (E-14's `InitLeader`); one client entry (two in the `r2` runs); no membership change; terms up to 4; crashes keep the disk; E-14b's reductions EagerReady, BatchVote, EagerNet and DeadView, and `LeaderLease` (a follower stands only when no up server leads in its term or a later one, which is what PreVote with CheckQuorum gives). Liveness is AG EF on TLC's state graph ([tools/agef37.py](tools/agef37.py), E-14's `agef.py` with a count by number of damaged entries added), judged at terms up to 2.

### DEV-10

[tools/mutants.py](tools/mutants.py) (E-14's generator, pointed at this file) makes one mutant per tagged rule: each guard dropped, each update dropped, each comparison flipped. [tools/mutrun37.py](tools/mutrun37.py) runs each on the par runs, cheapest first. A rule counts (DEV-10 (c)) when dropping it lets TLC find a counterexample: a broken invariant, or a stuck state with a live majority where the design has none.

## Results

Machine: 4 vCPU, 15 GB, one virtual disk, shared with other agents (load 3 to 9); Java 21, TLC2 2026.11.06 nightly, `-workers 2`, the real CommunityModules jar; Python 3.13 with numpy for the graph check. Versions and sha256 of every input: [results/versions.txt](results/versions.txt). Each run's constants are in [cfg/](cfg), its trimmed TLC output (with the trace condensed by [tools/trace37.py](tools/trace37.py) at the top) in `results/<run>.txt`, and every number below in [results/runs.json](results/runs.json). Wall times include waiting for the shared lock. All model-checked here.

### 1. Raft as published loses a committed write (Z `crash`)

| Run | Mode | Faults | Result | States |
|---|---|---|---|---|
| `cut1` | cut | 1 damage | `QuorumLogInv` broken at the damage itself: the committed entry is no longer on any quorum's log | 1,091, trace of 15 states |
| `cut1-obs` | cut | 1 damage | **`NoLostCommit` broken: a committed client write is overwritten** | 8,757, trace of 32 states |
| `silent1` | silent | 1 damage | `LogInv` broken at once: two servers' committed logs disagree at the damaged index | 19, trace of 2 states |

The `cut1-obs` trace, condensed (entries: `g` genesis, `n2` the term-2 leader's empty entry, `c2` the client write of term 2, `n3` the term-3 leader's empty entry; `ci` the commit index):

```
 13 s1:L t2 [g n2 c2] ci2 | s2:F t2 [g n2 c2] ci2 | s3:F t2 [g n2] ci2
 14 s1:L t2 [g n2 c2] ci3 | s2:F t2 [g n2 c2] ci2 | s3:F t2 [g n2] ci2     s1 commits c2 (s1 and s2 hold it)
 16 s1:F t2 [g] ci1     | s2:F t2 [g n2 c2] ci2 | s3:F t2 [g n2] ci2     s1 restarts; entry 2 reads back bad; cut as a torn tail
 17 s1:F t2 [g] ci1     | s2:F t2 [g n2 c2] ci2 | s3:C t3 [g n2] ci2     s3, which lacks c2, stands
 24 s1:F t3 [g] ci1     | s2:F t3 [g n2 c2] ci2 | s3:C t3 [g n2] ci2     s1 votes for s3: s3's log is longer than s1's cut one
 32 s1:F t3 [g] ci1     | s2:F t3 [g n2 c2] ci2 | s3:L t3 [g n2 n3] ci2  s3 leads without c2 and writes n3 at index 3
```

One fault is enough: the leader itself restarts with one bad entry. It keeps its id, so its vote still counts, but its log is now shorter than what it acknowledged. That is the FAST'18 failure (Alagappan et al., "Protocol-Aware Recovery for Consensus-Based Storage"), here on etcd's own spec. It is also why F-10's "a torn tail is cut, not fatal" is unsafe without a checksum per entry: the reader cannot tell a torn tail (never acknowledged) from a damaged entry below the commit point (acknowledged, maybe on a bare majority).

### 2. Z `rejoin`: two rules, safe, and it stops on two damaged replicas

`rejoin` = a checksum per entry finds the damage, and the replica wipes itself and returns as a new replica that never votes as the old one (DESIGN-V5 4.1).

| Run | Faults | States | Safety | Liveness (AG EF, judged at terms up to 2) |
|---|---|---|---|---|
| `rejoin1` | 1 damage | 27,985, complete | all 10 invariants hold | 1,178 judged states with a live majority, **0 stuck** (376 of them after the damage) |
| `ghost1-obs` | 1 damage, the wipe back **under the old id** | 8,233 | **`NoLostCommit` broken** (trace of 32 states, the same shape as `cut1-obs`: the wiped server votes with an empty log) | - |
| `rejoin2` | 2 damages on two replicas, no crash | 3,950, complete | all hold | **every state with two damaged replicas is stuck**: the two are gone under their ids, so 1 of 3 voters is left and no leader can ever commit (28 stuck states; none has a live majority, so none is "judged": this is F-12's majority loss) |

**The rules, counted as DEV-10 says.** Each is shown necessary by a counterexample when it is left out:
1. the checksum turns damage into a wipe (without it: `cut1-obs` or `silent1`);
2. a wiped replica never votes under its old id (without it: `ghost1-obs`; E-14's `GhostReturn` mutant is the same rule).

So `rejoin` costs **2 rules**, keeps Raft as published, and meets F-22's MUST. It fails F-22's SHOULD by construction: two damaged replicas of three are two lost voters, and only F-12's operator step restarts writes. It also re-copies the whole replica for one bad entry (a full snapshot transfer, reasoned).

### 3. Z `par`: the cheapest repair, and two damaged replicas

PAR-RESULTS-PENDING

## What the model leaves out

- **Three voters, no membership change in these runs.** Under `rejoin`, healing must add the wiped member back as a new replica; E-14 checked lost disks with healing, and the rule count here assumes it.
- **One or two client entries, terms up to 4,** E-14b's reductions (EagerReady, BatchVote, EagerNet, DeadView) and `LeaderLease` (PreVote with CheckQuorum, no partitions). E-14b checked these reductions against the full model where both finish.
- **The damage happens at a restart** (the disk is read when the process starts). Damage found while running (a read that fails later) is the same once the process restarts; a process that keeps running on a damaged entry it has not read is not modelled.
- **A zeroed record** (term 0, a wrong value) is the shape of damage in mode par. Garbage that claims a higher term would make the damaged server refuse votes it should grant (liveness only) or, if it could stand, win (the campaign rule stops that).
- **Damage is below the server's own commit point** (the question's case). A damaged entry above it (acknowledged but not known committed) needs PAR's "possibly committed" query; the repair rule here would then wait for a peer that knows it committed.
- **The repair is one atomic step** (ask a peer, copy, clear the mark). The copied entry is committed, so a late or repeated answer carries the same bytes (reasoned).
- **Disks that lie about fsync, torn writes of several entries, and damage to the term or vote record** are not modelled (F-10 names a lying disk as residual risk).
- **Liveness is "a path exists"** (AG EF), as in E-14, not a fairness proof.

RESULTS-END
