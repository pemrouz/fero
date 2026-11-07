# E-37: one bad entry on a voter that keeps its id

**Question (Q-37).** Does each row keep acknowledged writes when one voter keeps its id but loses or corrupts one fsynced entry below the commit point? What is the cheapest fix, counted as DEV-10 says? And with one bad entry on each of two replicas, at different offsets, how often does each storage-fault option (SPACE axis Z) stay writable without F-12's operator step?

**Threshold (QUESTIONS Q-37).** A fix of 2 rules or fewer keeps Raft, with Z `par` or `rejoin` as the count says. More than 2 → R `vsr` (Viewstamped Replication Revisited with protocol-aware recovery, as TigerBeetle runs it) is costed as a candidate row.

**In short.**
- **Raft as published loses an acknowledged write** when one voter keeps its id and one fsynced entry below the commit point reads back bad (model-checked on etcd's own spec): if the bad entry is cut as a torn tail (F-10's rule), the server's shorter log lets a lagging candidate win with its vote, and the new leader overwrites the committed write (one fault, 32 states). A silent flip breaks log agreement at once. So every Raft row needs a checksum per entry.
- **Z `rejoin` (the draft's choice) is a fix of 2 rules**, both shown necessary: the checksum turns damage into a wipe, and the wiped replica never votes under its old id (back under its old id, it loses a committed write the same way). It is safe and live with one damaged replica (27,985 states, no stuck state). It meets F-22's MUST. With one bad entry on **each of two** replicas it is never writable without F-12's operator step: two of three voters are gone.
- **Z `par` (repair the one entry from a peer, keep the vote)** meets F-22's SHOULD: with one bad entry on each of two replicas at different offsets, every judged state reaches a working leader (565,222 states, 276 two-damage states, 0 stuck). It costs **7 rules** (6 shown necessary by mutants, 1 by reasoning). Repair only from the leader is not enough: 4 to 9% of the two-damage states are stuck, because two damaged voters refuse their votes and no leader can be elected to repair them.
- By the threshold: a 2-rule fix (`rejoin`) keeps Raft for F-22's MUST; F-22's SHOULD needs more than 2 rules (`par`: 7), so R `vsr` is costed as a candidate row against "Raft + `par`".

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

`par` = a checksum per entry finds the damage; the replica keeps its id and the rest of its log, refuses to vote, take appends or stand while an entry is bad, and copies the bad entry from a peer that knows it is committed.

| Run | Faults | States | Safety | Liveness (AG EF) |
|---|---|---|---|---|
| `par1` | 1 damage | 62,743, complete | all 10 invariants hold | 1,897 judged states with a live majority, **0 stuck**; 501 of them with the entry still bad |
| `par1r2` | 1 damage, two client entries | 455,856, complete | all hold | (safety only) |
| `par2d` | **2 damages, on two replicas, at different offsets**, no crash | 565,222, complete | all hold | **276 judged states with both replicas damaged: 0 stuck**; 64 of them with both entries still bad, all of which reach a working leader |
| `par2` | 2 damages, any offsets (the same offset on two replicas included) | did not finish in 760 s (TLC stopped; no counterexample was reported before it) | - | - |
| `par2d-leader` | as `par2d`, but repair only from the current leader | 195,119, complete | all hold | **22 of the 244 judged two-damage states are stuck (9%)**: every one with both entries still bad |
| `par2-leader` | as `par2`, repair only from the current leader | 461,901, complete | all hold | **54 of the 1,292 judged two-damage states are stuck (4%)**, every one with both entries still bad (54 of 284) |

Why repair must come from any peer, not only the leader (`par2d-leader`, condensed; `XX` is the zeroed record, `bad@k` the slot marked bad):

```
 16 s1:L t2 [g n2 c2] ci3 | s2:F t2 [g n2 c2] ci2 | s3:F t2 [g XX] ci2 bad@2          s3 restarted; its entry 2 is bad
 17 s1:F t2 [g n2 XX] ci3 bad@3 | s2:F t2 [g n2 c2] ci2 | s3:F t2 [g XX] ci2 bad@2   the leader restarts; its entry 3 is bad
```

Now two of three voters refuse to vote, so s2 can never win, so there is no leader, so leader-only repair never starts. With repair from any peer, s3 copies entry 2 from s2 (s2 knows it committed), votes again, and a leader is elected whose commit index then covers entry 3 for s1. So the two-bad-replicas case needs peer repair, as PAR (FAST'18) does it.

**The rules of `par`, counted as DEV-10 says** ([tools/mutants.py](tools/mutants.py) made 11 mutants from the 10 tagged lines; [tools/mutrun37.py](tools/mutrun37.py) ran each on `par1`, then `par2d`, then `par1r2`, until one caught it; table in [results/mutants.md](results/mutants.md), runs in [results/mutants.json](results/mutants.json)):

| Rule (tagged line) | Mutant | Result |
|---|---|---|
| the checksum marks the slot bad (`ParDetect`) | update dropped | **caught**: `LogInv` at once (the zeroed record is read as data; 2 states) |
| a damaged server grants no vote (`ZNormal`, first guard) | guard dropped | **caught**: `MoreUpToDateCorrectInv` (32 states): with its last entry bad, the server compares a term of 0 and votes for a candidate that lacks a committed entry |
| a damaged server takes no append (`ZNormal`, second guard) | guard dropped | not caught on `par1`, `par1r2` or `par2d` (73,611 / 569,912 / 820,872 states): **not needed** |
| a damaged server drops such requests (`ZIgnore`) | guard dropped (any server may drop them) | undecided: `par1` and `par1r2` finish with no counterexample, `par2d` did not finish in 700 s; it only adds message loss, so at most liveness |
| a damaged server does not stand (`ZTimeout`) | guard dropped | **caught**: `LogMatchingInv` on `par2d` (56 states): a server whose entry 3 is bad but whose last entry is good wins, leads, and copies its zeroed entry 3 to a follower that lacked it |
| repair: the peer's slot is not bad itself (`ZRepair`) | guard dropped | not caught: in these runs the two bad entries are at different offsets (`par2d`); with the same offset on two replicas (`par2`, which did not finish) it copies garbage, so it is needed by reasoning |
| repair: the peer knows the entry is committed (`commitIndex[j] >= bad[i]`) | guard dropped | **caught** as a TLC evaluation error: the copy reads past the end of a peer's shorter log |
| the same comparison | `>=` flipped to `>` | **caught**: 14 stuck states with a live majority on `par2d` (the peer that knows exactly up to that entry may not repair) |
| repair: the server is damaged (`bad[i] # 0`) | guard dropped | equivalent (repairing an undamaged server changes nothing: the same 62,743 states on `par1`) |
| repair copies the entry | update dropped | **caught**: `LogInv` (3 states): the mark is cleared over a zeroed record |
| repair clears the mark | update dropped | **caught**: 76 stuck states with a live majority on `par2d` (two damaged servers that never vote again) |

So the cheapest `par` costs **6 rules shown necessary** (the checksum mark; no vote; no standing; repair from a peer that knows the entry committed; the copy; clearing the mark), plus 1 needed by reasoning (the peer's own slot is not bad), so **7**, against `rejoin`'s 2. Taking appends while damaged is allowed. Mutants: 11, 1 equivalent, 7 caught of the 10 others (70%; DEV-03 asks 85%): the two survivors are the append guard (not needed) and the peer-slot guard (its case did not finish), and one is undecided.

## What the model leaves out

- **Three voters, no membership change in these runs.** Under `rejoin`, healing must add the wiped member back as a new replica; E-14 checked lost disks with healing, and the rule count here assumes it.
- **One or two client entries, terms up to 4,** E-14b's reductions (EagerReady, BatchVote, EagerNet, DeadView) and `LeaderLease` (PreVote with CheckQuorum, no partitions). E-14b checked these reductions against the full model where both finish.
- **The damage happens at a restart** (the disk is read when the process starts). Damage found while running (a read that fails later) is the same once the process restarts; a process that keeps running on a damaged entry it has not read is not modelled.
- **A zeroed record** (term 0, a wrong value) is the shape of damage in mode par. Garbage that claims a higher term would make the damaged server refuse votes it should grant (liveness only) or, if it could stand, win (the campaign rule stops that).
- **Damage is below the server's own commit point** (the question's case). A damaged entry above it (acknowledged but not known committed) needs PAR's "possibly committed" query; the repair rule here would then wait for a peer that knows it committed.
- **The repair is one atomic step** (ask a peer, copy, clear the mark). The copied entry is committed, so a late or repeated answer carries the same bytes (reasoned).
- **Disks that lie about fsync, torn writes of several entries, and damage to the term or vote record** are not modelled (F-10 names a lying disk as residual risk).
- **Liveness is "a path exists"** (AG EF), as in E-14, not a fairness proof.


## Against the threshold

The threshold: "a fix of ≤ 2 rules keeps Raft, with Z `par` or `rejoin` as the count says; more → R `vsr` (VR Revisited plus protocol-aware recovery, as TigerBeetle runs it) is costed as a candidate row."

- **Raft as published (Z `crash`) does not keep acknowledged writes** when one voter keeps its id and loses or corrupts one entry below the commit point: one fault, 32 states (cut), or 2 states (silent). Every row that runs Raft must take a checksum per entry; F-10's "a torn tail is cut" is safe only for a tail the checksum shows was never acknowledged.
- **`rejoin` is a fix of 2 rules**, each shown necessary (`cut1-obs`, `silent1`; `ghost1-obs`). It keeps Raft as published and meets F-22's MUST. With one bad entry on each of two replicas it is **never** writable without F-12's operator step (`rejoin2`): two of three voters are gone under their ids.
- **`par` (peer repair) meets F-22's SHOULD**: every judged state with one bad entry on each of two replicas, at different offsets, reaches a working leader (`par2d`: 276 of 276), with no invariant broken. It costs 7 rules (6 shown necessary by mutants, 1 by reasoning): more than 2. Repair only from the leader is not enough (4 to 9% of those states stuck).
- So, by the threshold: **Raft stays, with Z `rejoin`** (2 rules, the draft's DESIGN-V5 4.1 choice) for F-22's MUST. F-22's SHOULD needs `par`'s 7 rules or R `vsr`; the threshold says `vsr` is then costed as a candidate row. `par` inside Raft is the smaller step (reasoned): it keeps etcd's raft as the core and adds PAR's repair (Alagappan et al., FAST'18, built their CTRL into LogCabin, a Raft implementation, and ZooKeeper; cited).

## How to rerun

```sh
./fetch.sh        # tla2tools.jar, CommunityModules 202611060952, etcd's raft at c51f010, into $SP/dl/
./run.sh          # every run above, then the mutants (each TLC run under the heavy lock)
./run.sh par2d    # one run (python3 tools/run37.py --list)
./run.sh mutants  # DEV-10's mutants of the par fix
```

Q-37: No for Raft as published (a voter that keeps its id and cuts one bad entry as a torn tail lets a lagging leader overwrite a committed write: TLC, one fault, 32 states); Z `rejoin` fixes it in 2 rules (checksum plus wipe; never vote under the old id) and meets F-22's MUST, but two replicas with one bad entry each are never writable without F-12; Z `par` (checksum, refuse to vote or stand, repair the entry from any peer that knows it committed) keeps every two-damage state writable (565,222 states, 0 stuck) at 7 rules, so by the threshold R `vsr` is costed as a candidate row for F-22's SHOULD. Moves: every Raft row (MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, DRAFT, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE) up on F-22 (M) and F-10 with Z `rejoin` (+2 rules, already DESIGN-V5 4.1), and needs Z `par` (+7 rules: PAR's repair inside Raft) for F-22 (S); PD (Raft with Z `crash`) down on F-22 (M) until it takes a checksum and `rejoin`; ISR and OBJ (Z `crash`, not Raft) not checked here; R `vsr` gains a reason to be costed (F-22 S), against Raft + `par`; DEV-01 +1 mechanism for `par` (the per-entry bad mark and peer repair), none for `rejoin` beyond the incarnation the rows already count.
