# E-14c: membership on commit, completed (Raft's real invariants, the lost-disk and swap scenarios, mutant r19)

**Question (Q-14, completion of E-14b).** Are membership changes that take effect on commit, as in etcd's raft, safe and live in fero's healing scenarios? E-14b answered most of it but left three things open: the liveness verdict for `three-disk` (a lost disk replaced under a spare id) and for `four` (the swap), and mutant r19. Both liveness runs had stopped when one of etcd's shipped invariants, `LeaderCompletenessInv`, fired on a stale leader that cannot commit; E-14b showed that this invariant and `QuorumLogInv` are stronger than Raft needs once servers hold different configurations. E-14c replaces each with the property Raft really needs, shows the replacements still catch real safety bugs, finishes both liveness runs at E-14b's bounds, and settles r19. Threshold (Q-14's own): on commit, every invariant and the liveness property hold at 3 to 4 servers, 2 changes, terms up to 4, each run up to 1 hour; any on-commit counterexample means the healing rules change before DRAFT or MIN can be judged.

**Status: STATUS_PLACEHOLDER**

## In short

SHORT_PLACEHOLDER

## Words used here

- A **voter** counts toward commits and elections. A **learner** copies the log but does not count.
- **On commit** (etcd's rule, the design): a server acts on a configuration only once the entry holding it is committed and applied. **The campaign guard**: a server does not stand for election while a committed configuration change is not yet applied (etcd's `hup`; E-14 found on commit is safe only with it). Every on-commit run here has it.
- **Working leader** (E-14's goal): a leader that is a voter of its own applied configuration and has committed an entry of its own term. **Plan done** (E-14b's second goal): a working leader whose configuration is the scenario's healing target.
- **Stuck**: from this state, with no more faults and no recoveries, no path reaches a working leader. **Live majority**: a majority of the voters of the latest committed configuration is up.
- **AG EF** ("from every judged state, the goal can still be reached"): healing.py's P5, checked on TLC's state graph by [tools/agef2.py](tools/agef2.py) (E-14b's tool, copied unchanged). A state is **judged** when its highest term is at least two below the term bound, so it has two elections in hand.
- **TLC**: the TLA+ model checker. It visits every state the model can reach within the bounds.
- **Commit term**: the term of the leader that committed an entry. Raft commits an entry of an older term only indirectly, when a later leader commits one of its own (Raft paper, section 5.4.2), so an entry's commit term can be above its own term.
- **History variable** (or ghost): a variable that records the past for an invariant to read. No step reads it, so it changes no behaviour.
- **DEV-10** (REQUIREMENTS): mutants are made by script from the model text (drop each guard, drop each update, flip each comparison). A mutant is **caught** when the checker finds a counterexample with it.

## Method

### The model

[tla/MCferoc.tla](tla/MCferoc.tla) `EXTENDS` E-14b's [MCferolive.tla](../E14b-membership-liveness/tla/MCferolive.tla), which `EXTENDS` E-14's [MCferoraft.tla](../E14-membership-on-commit/tla/MCferoraft.tla), which `EXTENDS` etcd's `etcdraft.tla`, all unchanged (read in place; [tools/common.py](tools/common.py) stages copies per run). So every step, fault, reduction (E-14b's R1 to R4, symmetry, `LeaderLease`, `CoarseAE`), goal and plan is E-14b's. E-14c adds one history variable, `ctl`: for each index ever committed, the entry and its commit term. It is in TLC's view, so two states with different histories are never merged and every invariant that reads it is checked soundly. Runs use the real CommunityModules jar, `-workers 2` (one run used 1), `-fp 7` in every segment, and segments of at most 25 minutes, each its own hold of the heavy lock (E-14b's machinery, [tools/run14c.py](tools/run14c.py)). No new segment started in US Eastern peak hours.

### Step 1: what Raft really needs, in place of the two shipped invariants

| Shipped invariant | What it asks | Why it is too strong here (E-14b) | Replacement | Why that is what Raft needs |
|---|---|---|---|---|
| `LeaderCompletenessInv` | a leader whose term is above an entry's **own** term holds every committed entry | an entry of term 2 committed in term 4 by s1; then s2 counts old votes and leads term 3 without it. That leader can never commit (a quorum is at term 4), so nothing is lost; it stopped `three-disk` and `four-voters-append` | `LeaderCompletenessRaftInv`: a leader whose term is above an entry's **commit term** holds it | Raft's Leader Completeness Property says "if a log entry is committed in a given term, then that entry will be present in the logs of the leaders for all higher-numbered terms" (Ongaro and Ousterhout 2014, Figure 3 and section 5.4.3). "Committed in a given term" is the commit term, which the shipped text reads as the entry's own term (cited; the gap is section 5.4.2's indirect commit) |
| `QuorumLogInv` (`QuorumLogInvLive`) | every quorum of **every server's applied** configuration holds that server's committed entries | a learner two changes behind still holds the genesis configuration {s1}, which it can never use (it is not a voter in it, and the campaign guard stops it); it stopped `one` | two parts. `VoteQuorumInv`: no server that lacks a committed entry and could stand can collect a quorum of votes in the configuration it would stand with; every such quorum has a member whose log is more up to date (it refuses, by the shipped `logOk`) or whose disk is lost. `CommittedQuorumInv`: `QuorumLogInv`, but for the **latest committed** configuration only | Raft's safety argument for elections (section 5.4.3): a leader is elected by a quorum, every quorum holds a voter with each committed entry, and that voter refuses a candidate with a less up-to-date log. The first part is that step stated for every configuration a server can still stand in; the second keeps the latest configuration's quorums safe for every future election, which single-server changes guarantee from one configuration to the next (Ongaro's thesis, section 4.2.1: the majorities of the old and new configurations overlap) |
| (none) | | `LogInv` compares only logs that exist now, so a commit lost from every log goes unseen | `CommittedNeverLostInv`: while a live majority exists, every committed entry is on some server whose disk exists | State machine safety needs committed entries to survive, not only to agree. The live-majority guard leaves out one case the protocol cannot help: the only voter of a one-voter configuration losing its disk |

The other six shipped invariants stay (`LogInv`, `MoreThanOneLeaderInv`, `ElectionSafetyInv`, `LogMatchingInv`, `MoreUpToDateCorrectInv`, `CommittedIsDurableInv`). So every run below checks ten invariants. The history variable's cost (model-checked here, against E-14b's counts for the same runs): `three-1c` 12,098 states (+0%), the mutant scenario `m2` 100,736 (+0%), `one` 194,788 against `one-noq`'s 190,058 (+2.5%), `two-1c1f` 66,344 against 64,245 (+3.3%), `three-1c1f` 579,252 against 555,676 (+4.2%).

**The false alarms are gone** (model-checked here): `one` now finishes with all ten invariants holding in every state (194,788 states; E-14b stopped it at `QuorumLogInvLive`), with the same AG EF result as E-14b's `one-noq` (88 stuck states, the two-voter window). `two-1c1f` gives E-14b's 4 stuck states (the two-voter window) and `three-1c1f` passes, as in E-14b. `three-disk` passes the depth (66) at which E-14b stopped (step 3).

### Step 2: the replacements still catch real bugs

[tools/bugs.py](tools/bugs.py) runs each bug once per invariant set: each replacement alone, `LogInv` alone (is a commit really lost?), the whole new set, and the shipped set. The scenario is three voters, one change of any kind, one crash or lost disk, terms up to 4. Each run stops at its first violation or after 300 seconds; a run that finishes with no violation explored every state. Model-checked here ([results/bugs.md](results/bugs.md), traces in [results/bugs/](results/bugs)):

| Bug | VoteQuorumInv | CommittedQuorumInv | LeaderCompletenessRaftInv | CommittedNeverLostInv | LogInv (a real loss) | new set (first to fire) | shipped set (first to fire) |
|---|---|---|---|---|---|---|---|
| **ghost**: a lost disk comes back at once, empty, under its old id (E-14b's `three-ghost`) | 15 states | 15 | 32 | 41 | 44 | VoteQuorumInv, 15 | QuorumLogInvLive, 15 |
| **minority** (planted in `etcdraft.tla`): a leader commits once any one member holds the entry | 7 | 7 | 20 | none (1,033,203 states) | 25 | VoteQuorumInv, 7 | QuorumLogInvLive, 7 |
| **anylog** (planted): a voter grants its vote whatever the candidate's log | 27 | 36 | 27 | none (737,138) | 39 | VoteQuorumInv, 27 | MoreUpToDateCorrectInv, 27 |
| **twovote** (planted): a voter grants a second vote in the same term | none (708,862) | none | none | none | none | MoreThanOneLeaderInv, 40 | MoreThanOneLeaderInv, 40 |

(Numbers are the length of TLC's shortest counterexample, in states.) So:
- Each lost-commit bug is caught by every replacement, as early as the shipped set catches it (7, 15 and 27 states against 7, 15 and 27), well before the loss itself shows in `LogInv` (25 to 44 states).
- `CommittedNeverLostInv` sees only the ghost: in etcd's spec a follower never truncates an entry below its own commit index, so after the planted bugs the old holder keeps its copy and the two logs disagree instead (which `LogInv` sees).
- Two leaders in one term are caught by `MoreThanOneLeaderInv`, which stays. No log invariant sees it in this scenario: both leaders of the same term write the same empty entry at the same index, so no data differs (reasoned from the trace, [results/bugs/twovote--new-trace.txt](results/bugs/twovote--new-trace.txt)).

**E-14's mutants that E-14b caught with `QuorumLogInvLive`** (r02, r05, r06, r09) were re-run on `m2` with the new set and the state graph: all four are caught, by `CommittedQuorumInv` (traces of 56, 20, 23 and 20 states); r05, r06 and r09 are also caught by `VoteQuorumInv` alone. The design passes `m2` with the new set (100,736 states, AG EF and plan PASS). r02's trace ([results/bugs/mut-r02--m2-trace.txt](results/bugs/mut-r02--m2-trace.txt)) shows why the second part is needed: without the new leader's `pendingConfIndex`, s2 proposes "demote s2" (voters {s1}) while "demote s1" (voters {s2}) is still uncommitted in its log; both commit, so the configuration jumps from {s2} to {s1}, a two-server change, and the only voter s1 lacks the entry that made it the only voter. Nobody can stand again (s1 thinks it is a learner): the group is dead, and a committed entry sits on no voter. `VoteQuorumInv` alone does not see it (nobody can stand, so no election can lose it), and E-14b's AG EF did not either (the dead end is at term 3, which a run judged at term 2 never judges). A first version of the new set without `CommittedQuorumInv` missed r02; it was added before any step 3 run counted.

### Step 3: the liveness runs

Both runs use E-14b's sweep settings unchanged ([cfg/three-disk.cfg](cfg/three-disk.cfg), [cfg/four.cfg](cfg/four.cfg)): on commit with the campaign guard, learners vote, terms up to 4 (judged at 2), two changes, at most one fault, recovery free, `LeaderLease`, no message loss, all four of E-14b's reductions, symmetry among interchangeable members (in `three-disk`: the two voters other than the first leader), the ten invariants of step 1.
- **`three-disk`** (a lost disk replaced by a spare id): voters s1, s2, s3 and a spare s4 that is not yet a member; the leader may add s4 as a voter and remove any of s1 to s3; the fault is one crash or one lost disk (a lost disk never returns under its id). Plan done: s4 is a voter and there are three voters.
- **`four`** (the swap): voters s1, s2, s3 and a learner s4; the leader may promote s4 and demote or remove one fixed voter other than the first leader (`V2`); the fault is one crash of any member. Plan done: s4 is a voter and `V2` is not. With `V2` fixed by the plan and s4 the only learner, no two members are interchangeable, so symmetry removes nothing here (E-14b's `four-voters` had two interchangeable voters).

STEP3_RESULTS

### Step 4: mutant r19

r19 drops the first guard of `CanCampaign` (`i \in GetConfig(i)`: only a voter of its own applied configuration may stand). E-14b found nothing on `m3` and `m2p` and could not finish `m2` and `m3c`. Reading the mutant says why: a server that is not a voter can only exist after a configuration change, and every change in these scenarios happens in term 2 (the first leader's), so the first election a non-voter can stand in is term 3. Runs judged at term 2 never judge it.

[tools/r19.py](tools/r19.py) runs the same scenarios one term further (terms up to 5, judged at 3), the design first. Model-checked here ([results/r19.json](results/r19.json), [results/r19-classify.txt](results/r19-classify.txt)):

| Run | States | Invariants | Stuck with a live majority (judged at term 3) | of which: a candidate that lost holds the group | of which: a non-voter leads |
|---|---|---|---|---|---|
| design, `m3` | 12,098 | all hold | 812 | 812 | 0 |
| **r19, `m3`** | 87,779 | all hold | 6,340 | 1,990 | **4,350** |
| design, `m2p` | 572 | all hold | 0 | | |
| r19, `m2p` | 572 | all hold | 0 | | |

Judging one term further shows a bound of the model, not of Raft: E-14 kept the shipped `MCetcdraft` bound "one candidate at a time" (`Cardinality({s \in GetConfig(i) : state[s] = Candidate}) < 1`), so a candidate that lost can never stand again, and no other member may stand while it is a candidate. In real Raft it times out and stands again. [tools/classify.py](tools/classify.py) sorts the stuck states by what holds them. All 812 of the design's are this bound ([results/design-m3-t5-candidate-trace.txt](results/design-m3-t5-candidate-trace.txt): s3, behind, stands, loses, and holds the group). The mutant adds 4,350 of a kind the design never has: a non-voter leads. The shortest trace ([results/r19-nonvoter-trace.txt](results/r19-nonvoter-trace.txt), 32 states):
1. Leader s1 removes itself (voters {s2, s3}), commits it with s2, applies it and steps down.
2. With r19 dropped, s1 may stand although it is no longer a voter. Its log is the longest, so s2 and s3 vote for it, and it wins term 3 (the tally counts only voters, and both voters voted).
3. s1 now leads a group it is not a member of. The one change is spent; while it leads, no voter may stand (`LeaderLease`, which PreVote with CheckQuorum gives in etcd); so no voter ever leads again.

Every step is a step of the full model, and from the last state the only steps left are s1 copying and committing its own empty entry; none of them lets a voter stand (reasoned). **So r19 is caught, as a liveness bug**: without "only voters stand", a removed or demoted member with the longest log takes the leadership back and keeps it. It is etcd's `promotable()` check. It is not a safety bug: every invariant holds in all 87,779 states.

## Results

RESULTS_PLACEHOLDER

## What the model leaves out

Everything E-14b's model leaves out, it still leaves out (E-14b's own list): 5 servers (Ongaro's 2015 single-server bug needs 5), more than two changes, more than one fault per run, partitions as such, message loss together with liveness, and a full check without E-14b's four reductions (R4, the one coarsening, is checked only on E-14b's calibration pairs). Also:
- **AG EF looks only at states in the first leader's term.** Every run is judged at two terms below its bound (E-14b's rule), and in every scenario here the first new election is term 3, so with terms up to 4 only term-2 states are judged. A dead end that appears only after a new election is seen only when every path from some term-2 state leads into it. r02's dead end and r19's non-voter leader are of that kind: E-14b's AG EF missed both (r02 was caught by an invariant).
- **Judging one term further meets a bound of the model.** E-14 kept `MCetcdraft`'s "one candidate at a time": a candidate that lost can never stand again, and while it is a candidate no other member of its configuration may stand. Judged at term 3, the design itself then has stuck states (812 in `m3`, all of this kind). So step 4 sorts stuck states by kind rather than reading a raw FAIL, and the step 3 verdicts stay at E-14b's judging rule.
- **The replacements are checked, not proved.** Each is argued from the Raft paper and thesis (cited) and shown here to catch every lost-commit bug planted (step 2); none is checked with TLAPS or Apalache.
- **Fairness and timing** as in E-14b: AG EF says a way out exists, not that random timeouts take it; how long anything takes is not measured here.

## Against the threshold

THRESHOLD_PLACEHOLDER

## How to rerun

```sh
./fetch.sh            # CommunityModules 202611060952, tla2tools.jar, etcd's raft at c51f010, into $SP/dl/
./run.sh calib        # step 1 (minutes)
./run.sh bugs         # step 2 (about 30 CPU-minutes)
./run.sh sweep        # step 3 (hours: checkpointed segments of up to 25 minutes, one heavy hold each)
./run.sh r19          # step 4 (minutes)
python3 tools/table.py   # results/tables.md from the JSON files
```

Machine: 4 vCPU, 15 GB, one virtual disk, shared with other agents (load 6 to 9 during these runs); Java 21, TLC2 2026.11.06 nightly, CommunityModules 202611060952, Python 3.13 with numpy 2.5 ([results/versions.txt](results/versions.txt)). Wall times include sharing the CPU.

VERDICT_PLACEHOLDER
