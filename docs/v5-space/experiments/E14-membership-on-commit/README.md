# E-14: membership changes that take effect on commit, checked with TLC on etcd's raft spec

**Question (Q-14).** Are membership changes that take effect on commit, as in etcd's raft, safe and live in fero's healing scenarios?

**In short.**
- **The rule is right, with one more guard.** On commit, healing.py's stuck state R2-1 has a way out (TLC follows it to a leader that commits, in 72 steps), and on append the same state is stuck for good (TLC explores all 2,905 states from it and none has a working leader). Two independent checkers now agree on the rule, at least at this state.
- **But etcd's own TLA+ spec, unmodified, reaches two leaders in one term** (63 steps, F1): it lets a server campaign with an old configuration while a newer committed one is not yet applied. etcd's code forbids that (`hup`), the spec does not. On fero's model the same guard is what stops it: drop it and TLC finds the two leaders; keep it and TLC finds no way past it. So "take effect on commit" is safe only with "never campaign with a committed change unapplied", a rule to count and keep in the port.
- **Not done at the stated bounds.** The full liveness check (no stuck state anywhere in a scenario) did not finish on this box for any scenario with a working leader making changes: the message-level spec has hundreds of thousands of states per scenario within 25 minutes. Safety held in every state explored. The shipped model as shipped never finishes either: its state space is infinite (F4).
- **DEV-10:** the mechanical mutants of fero's membership lines were run in random simulation only; see F5.

## Words used here

- A **voter** counts toward commits and elections. A **learner** copies the log but does not count.
- **Takes effect on commit**: a server acts on a configuration only once the entry holding it is committed and the server has applied it. This is what etcd's raft does. **On append** (the mutant): a server acts on the last configuration entry in its log, committed or not, as in the Raft dissertation's single-server rule.
- **Applied**: in etcd, a committed entry is handed to the application, which then calls `ApplyConfChange`. So a server can know an entry is committed and not yet act on it. The spec has the same gap: `ApplySimpleConfChange` is a step of its own.
- **Stuck**: no fault-free path leads to a leader of its latest configuration that commits an entry of its own term. **Live majority**: a majority of the voters of the latest committed configuration is up.
- **AG EF**: "from every reachable state, the goal can still be reached". It is healing.py's P5 ("no stuck state with a live majority").
- **TLC**: the TLA+ model checker. It explores every reachable state within the bounds.

## What etcd's spec covers, exactly

Read from `raft/tla/etcdraft.tla` (926 lines) and `MCetcdraft.tla`/`.cfg` at etcd-io/raft commit c51f010 (2026-10-23).

| Covered | How |
|---|---|
| Raft's core | terms, votes, AppendEntries with any range, heartbeats, a "snapshot" as an AppendEntries from index 1, commit by a majority of the leader's configuration with an entry of the leader's own term |
| durability | a separate `Ready` step persists term, vote, log length, commit index and configuration, and only then releases the server's messages; the leader acks itself after that (`AppendEntriesToSelf`) |
| crashes | `Restart`: a server loses its volatile state and its unpersisted log tail, and comes back at once |
| the network | messages are a bag: reordered, duplicated or lost (each at most when one copy is in flight) |
| membership | one change at a time (`pendingConfChangeIndex`); add a voter or promote a learner (`AddNewServer`), add a learner, remove a server (`DeleteServer`); a configuration applies when its committed entry is applied (`ApplySimpleConfChange`, a step of its own); a candidate must be a voter of its own applied configuration; any server grants votes by term, log and vote alone, so learners vote |
| properties | 8 safety invariants: `LogInv`, `MoreThanOneLeaderInv`, `ElectionSafetyInv`, `LogMatchingInv`, `QuorumLogInv`, `MoreUpToDateCorrectInv`, `LeaderCompletenessInv`, `CommittedIsDurableInv`. No liveness property. |
| bounds (MC) | 4 servers, 3 at the start, at most 2 changes, terms up to 10, at most 5 client entries, symmetry, at most one candidate at a time, one AppendEntries per pair per term in flight |

| Not in the spec, though etcd's code (`raft.go`) has it | Why it matters here |
|---|---|
| PreVote, CheckQuorum, leader transfer (`TimeoutNow`), read index | Q-38 (E-38) covers them by running etcd's code |
| a new leader's empty entry, and `pendingConfIndex = lastIndex` at `becomeLeader` | together they are etcd's form of Ongaro's 2015 fix: no change until the leader has committed in its term |
| `hup` refuses to campaign while a committed configuration change is not yet applied | without it, the spec reaches two leaders in one term (finding F1 below) |
| a demotion (voter to learner) as a single change | healing's swaps and the step from two voters to one use it |
| `StepDownOnRemoval`: a leader whose applied configuration drops it steps down | otherwise a removed leader keeps leading a group it is not in |
| the vote tally counts only the configuration's voters | the spec's `BecomeLeader` needs `votesGranted` itself to be a quorum, so a learner's granted vote blocks that candidate's win (liveness only) |
| promotion takes the learner out of the learner set | the spec leaves it in both sets (harmless here) |
| partially persisted logs | the spec's own README lists it as a known gap |

## What this experiment adds

All in [tla/MCferoraft.tla](tla/MCferoraft.tla), which `EXTENDS` the shipped `etcdraft.tla` unchanged (sha256 in [results/versions.txt](results/versions.txt)), as `MCetcdraft.tla` does. Every shipped action, handler and invariant is used as is; the additions are:

1. **The membership rules of etcd's code** (`FeroRules`, between `MUTATE-BEGIN` and `MUTATE-END`): the new leader's empty entry and pending index; one change at a time, proposed only once every earlier change is applied (`pendingConfIndex <= applied`); add a learner, add a voter, promote, **demote**, remove; apply the latest committed configuration, and a leader it drops steps down; campaign only as a voter of the applied configuration and with no committed change left to apply; the tally counts voters only. With `FeroRules = FALSE` the shipped membership actions run instead.
2. **Faults with a budget**: a crash that keeps the disk (down until a free recovery), a **lost disk** (the member never returns under its id; a spare id can join instead), the shipped instant restart, message loss and duplication, and a leader or candidate giving up. A mutant, `GhostReturn`, lets a lost disk come back under its old id.
3. **The on-append mutant** (`OnAppend`): a server's configuration is the last configuration entry in its log.
4. **healing.py's scenarios** as starting configurations and healing plans: `four` (3 voters, 1 learner; the plan "swap": promote the learner, demote or remove a voter, in any order the leader picks), `four-voters` (4 voters; demote or remove one), `two` (2 voters, 1 learner; demote one, or promote the learner), `one` (1 voter, 2 learners; promote both), `three+spare` (3 voters, a spare id; any voter may lose its disk; add the spare as a voter, remove a voter).
5. **The liveness property** as AG EF on TLC's own state graph: TLC dumps the graph (`-dump dot`), and [tools/agef.py](tools/agef.py) checks that from every state with a live majority, steps that are neither faults nor recoveries reach a leader of its latest configuration that has committed an entry of its own term. This is the stuck search of healing.py, on TLC's graph.
6. **One more invariant and three scripts**: `QuorumLogInvLive` (the shipped `QuorumLogInv`, counting only disks that still exist; it replaces `QuorumLogInv` in fero's runs, since a lost disk can no longer vote), and the scripted behaviors of F1 (on the shipped spec and on fero's model) and F2.
7. **DEV-10's mutants**, made by [tools/mutants.py](tools/mutants.py) from every tagged rule line, run by [tools/mutate_run.py](tools/mutate_run.py).

**Reductions** (each a constant; each run states which it uses):
- `InitLeader`: start once the first leader has committed its empty entry (a reachable state).
- `CoarseAE`: a leader sends each follower everything from its match index to its log end, and no separate heartbeats (an empty append carries the commit index).
- `LeaderLease`: a follower stands only while no up server leads in its term or a later one. This is what PreVote with CheckQuorum gives when the leader can be reached; this model has no partitions, only crashes and delayed messages.
- No duplicate sends or replies: a message, or a reply, already in flight is not added again (duplication is a fault of its own, `DupF`). Without this the shipped model's state space is infinite (F4).
- No idle appends: with `CoarseAE`, a leader sends a follower an append only when it carries entries the follower may lack or a commit index not yet sent to it (`sentCommit`).
- A view (`FeroView`) that ignores responses older than their receiver's term: such a response can only be dropped as stale, so states differing only in it behave the same.
- `EagerApply`: a server acts on its committed configuration with no separate apply step (used only where named).
- Healing plans restrict which changes the leader proposes, never when.
- Terms are bounded (`MaxTermLimit` 5, with the first leader in term 2); agef judges only states at term 3 or lower, so every judged state has two more elections in hand.

The CommunityModules jar is not used: [tla/SequencesExt.tla](tla/SequencesExt.tla), [FiniteSetsExt.tla](tla/FiniteSetsExt.tla) and [BagsExt.tla](tla/BagsExt.tla) define in plain TLA+ the eight operators the spec uses (`IsPrefix`, `SetToSeq`, `FoldSeq`, `SelectLastInSubSeq`, `Max`, `Min`, `BagAdd`, `FoldBag`).

## Results

Raw TLC output (trimmed traces) is in [results/](results); the runs' constants are in [cfg/](cfg). TLC2 2026.11.06 (nightly), Java 21, `-workers 2` (1 for the scripts), 4 vCPU shared with other agents. Times include waiting for the shared lock.

### F1. etcd's own spec, unmodified, reaches two leaders in one term

[tla/MCstaleconfig.tla](tla/MCstaleconfig.tla) scripts one behavior of `etcdraft.tla` with `MCetcdraft`'s own initial state, wrappers and bounds (4 servers, 2 changes). TLC checks every step is one of the spec's enabled actions and checks the 8 invariants at every state. Result ([results/staleconfig.txt](results/staleconfig.txt), model-checked here): **`MoreThanOneLeaderInv` is violated after 63 steps**:
1. Leader 1 (term 2) adds 4 as a voter, commits it with 2, applies it.
2. Leader 1 removes 3; the entry commits on 1, 2 and 4 under {1,2,3,4}.
3. 4 learns the commit and applies {1,2,4}. 2 knows that index 4 (the add) is committed, but has applied nothing: its configuration is still {1,2,3}.
4. 2 campaigns with {1,2,3} and wins with 3's vote (3 was removed but still runs). 4 campaigns with {1,2,4} and wins with 1's vote. Both lead in term 3.

The two configurations in use, {1,2,3} and {1,2,4}, differ by two servers, so their majorities need not overlap. **etcd's code does not do this**: `raft.go`'s `hup` refuses to campaign while a committed configuration change is not yet applied ("cannot campaign at term %d since there are still pending configuration changes to apply"). The spec has no such guard. The as-shipped bounds cannot find it by search: the shipped state space is not even finite (below).

**The same behavior on fero's model** ([tla/MCstale2.tla](tla/MCstale2.tla), etcd's code rules): with the design, TLC finds no way past step 33, where B (the analogue of 2) would campaign: the guard `CanCampaign: ConfApplied(i)` refuses it (51 states, complete, [results/stale2.txt](results/stale2.txt)). With that one guard dropped (mutant `CanCampaign:drop-guard:r20`), `MoreThanOneLeaderInv` is violated at step 53 ([results/stale2-mutant.txt](results/stale2-mutant.txt)). So "takes effect on commit" is safe **only together with** "no campaign while a committed change is unapplied", and a port of etcd's raft must keep that line.

### F2. healing.py's R2-1 on etcd's spec: on append it is stuck, on commit it is not

The state just after R2-1's fault (`InitR21`): four voters; leader A appended "demote B" in term 2, sent it only to B, and is gone for good. B holds the longest log. C and D are up. A majority (B, C, D) of the committed configuration is live.

| Run | Rule | What TLC did | Result |
|---|---|---|---|
| `r21-append-ef` | on append | explored every reachable state, terms up to 4, no faults: **2,905 states, depth 22, complete** | **no state has a leader of its latest configuration that commits**: stuck with a live majority, as healing.py found ([results/r21-append-ef.txt](results/r21-append-ef.txt)) |
| `r21-append` | on append | the same graph, through agef.py | 0 goal states; the R2-1 state is stuck with a live majority ([results/r21-append.txt](results/r21-append.txt)) |
| `r21-script` | on commit | a scripted way out ([tla/MCr21script.tla](tla/MCr21script.tla)) | **the goal is reached in 72 steps**: B, still a voter of its applied configuration, stands and wins with C and D; it commits the demotion and its empty entry, applies the demotion and steps down; C wins under {A, C, D} with D and commits ([results/r21-script.txt](results/r21-script.txt)) |
| `r21`, `r21-ef` | on commit | AG EF over every state reachable from R2-1, and a breadth-first search for the nearest goal | **did not finish** within their caps (25 and 30 min): about 1.1 million states each, depth 55, no invariant broken, no goal yet within 55 steps (the script's path is 72) ([results/r21.txt](results/r21.txt), [results/r21-ef.txt](results/r21-ef.txt)) |

Why on append is stuck: B is a learner in its own log, so it never stands; C and D still have the four-voter configuration and need a third vote; B refuses it because its log is longer; A is gone. On commit, B's demotion is not in force until committed, so B stands. The scripted way out also uses **a removed leader stepping down** (B, once it applies its own demotion: etcd's `StepDownOnRemoval`, which fero must turn on); without it B would lead a group it is not in, refusing new writes, and its heartbeats would keep C and D from standing (reasoned; etcd-io/raft issue 83 is about the same).

### F3. The healing scenarios, from a leader in place

Started once the first leader has committed (`InitLeader`), with crashes as the faults (1 per run), `LeaderLease`, terms up to 5, etcd's lazy apply, and the healing plan of each scenario. The graph went to agef.py as it was written. Neither run finished within its cap:

| Run | Scenario | Explored | Invariants | AG EF |
|---|---|---|---|---|
| `two` | 2 voters + 1 learner; demote a voter (two back to one) or promote the learner; 2 changes | 894,373 states, depth 22, 248,096 still queued (25 min) | all 8 held in every state explored | not run (graph incomplete) |
| `four-voters` | 4 voters; demote or remove one (the R2-1 shape from the start); 1 change | 1,194,538 states, depth 15, 582,905 still queued (30 min) | all 8 held in every state explored | not run |

([results/two.txt](results/two.txt), [results/four-voters.txt](results/four-voters.txt).) The other planned scenarios (`four`: a swap; `one`: growth from one voter; `three-disk`: a lost disk returning as a new id, with `three-ghost`, the same disk returning under its old id; the learners-refuse-votes ablation) are defined in [tools/run.py](tools/run.py) but were not run: with these two not finishing, they would not have either, and the shared box had no more room. Earlier calibration runs, before two reductions were added, also explored about 1.2 to 2.1 million states each without a violation (not kept).

So the scenario-wide answer is **safety: no counterexample in about 2 million states across the two scenarios; liveness: open**.

### F4. What the shipped spec's bounds can and cannot do

- **As shipped, it never finishes.** The shipped `MCetcdraft.cfg` bounds terms, changes and client entries, but a candidate may resend a `RequestVote` any number of times before a reply lands (`RequestVote` only needs `j \notin votesResponded[i]`, and `Send` adds another copy to the bag; `MCSend` limits only AppendEntries). So copies pile up without bound, and so do duplicate replies: the state space is infinite (reasoned, from the spec text). Run as shipped for 10 minutes ([results/shipped-asis.txt](results/shipped-asis.txt)): 804,566 distinct states, depth 12, 580,133 still queued, no invariant broken.
- fero's model removes that: a message already in flight is not sent again, and an identical reply is not added again (duplication is a fault of its own). On `r21-append-ef` this took the state count from more than 241,000 (still growing at depth 36 when stopped) to **2,905, complete**.
- Even so, the message-level spec grows fast: any run with a live leader making changes and a crash anywhere, at 3 to 4 servers, reached hundreds of thousands to over a million states in 25 minutes without finishing. The bounds the threshold names (3 to 4 servers, 2 changes, terms up to 4, under 1 hour) are **not reached for full AG EF** on this box; they are reached for the targeted states above.

### F5. DEV-10's mutants

[tools/mutants.py](tools/mutants.py) made 22 mutants mechanically from the 20 tagged rule lines of fero's membership rules (each guard dropped, each update dropped, each comparison flipped; DEV-10's "swap two updates" means nothing in TLA+, where an action's conjuncts are simultaneous). Each ran on two scenarios (`two` and `three+spare`, any change, 2 changes, 1 fault, no lease, terms up to 5) with TLC's random simulation (depth 80, 120 s each), because exhaustive runs per mutant do not fit this box. Table: [results/mutants.txt](results/mutants.txt).

| | count | which |
|---|---|---|
| caught by a safety invariant in simulation | 5 | the vote tally counts voters only (r01); only a leader proposes (r04); one change at a time: `pendingConfIndex <= committed` (r05), the previous change applied (r06), the pending index set on proposal (r09) |
| caught by a targeted script (F1) | 1 | no campaign while a committed change is unapplied (r20) |
| equivalent, by reading (the mutant changes nothing reachable, or only turns one change kind into another that exists anyway) | 9 | the membership guards of add-learner, add-voter, promote, demote, remove (r10 to r14); `LastConfIdx > 0` dropped or flipped (r15, always true after genesis); `~ConfApplied` in apply (r16, re-applying is a stutter); `<=` to `<` on the pending index (r05 flip, only delays a proposal) |
| liveness only, not checkable in simulation | 7 | the new leader's pending index (r02) and empty entry (r03), together Ongaro's fix; no empty voter set (r07); the change entry appended (r08); the config applied (r17); a removed leader stepping down (r18); only voters campaign (r19) |

So **6 of 22 caught (27%), 6 of 13 non-equivalent (46%)**: far below DEV-03's 85%. The gap is the liveness rules, which need the AG EF check per mutant, and that check does not finish on this box at useful bounds (F4). Two of them are known to matter from outside this model: Ongaro's fix (r02, r03; his 2015 counterexample needs five servers, as healing.py also found) and `StepDownOnRemoval` (r18; etcd-io/raft issue 83). Slice 1 of the mutants (6 of 22) ran before the reply de-duplication was added; that changes only how many copies of a reply sit in the network.

**Rules counted (DEV-10 (c)).** Ablation shows these are needed: the voter-only tally, leader-only proposals, the two one-change-at-a-time guards and the pending-index update (simulation), and the unapplied-change campaign guard (script): **6 rules**. Two more are needed for liveness by the R2-1 runs: changes take effect on commit (the on-append mutant is stuck) and a removed leader steps down (reasoned). The rest of etcd's membership lines are not shown necessary here.

## What the model leaves out

- **PreVote, CheckQuorum, leader transfer and read index**: not in the spec. `LeaderLease` stands in for PreVote with CheckQuorum (a follower does not stand while a leader is up), and `StepDownF`, a fault, for CheckQuorum's step-down. E-38 runs the real code for them.
- **Partitions** are not modelled as such: a message can wait in the network for ever, and a server can crash and stay down, which covers a cut-off member for the others. A cut-off leader that keeps running, appending and sending to the other side only, is covered by the order of steps (it sends to some, then goes down).
- **Partially persisted logs** (the spec's own known issue 1) and a disk that loses one entry (E-37's question).
- **Joint consensus**: the spec carries `jointConfig` but never enters a joint configuration; etcd's `ConfChangeV2` with joint states is not checked. fero uses single changes only.
- **Snapshots and log compaction**, client sessions, slot moves (E-15), `#meta` and the controller (E-16).
- **Bounds.** Up to 4 servers; at most 2 changes; terms up to 5 (4 for the R2-1 runs); 1 fault per run (crash, lost disk, or in the safety runs message loss, duplication, an instant restart, a step-down). The reductions listed above. The full liveness check (AG EF) finished only for the R2-1 state on append; elsewhere it is a targeted witness (a scripted path) or not finished.
- **Liveness is "a path exists"** (AG EF), not a fairness proof: that random timeouts take such a path with probability 1 is reasoned, not checked.

## Against the threshold

The threshold: "on commit, every invariant and the liveness property hold at 3 to 4 servers, 2 changes, terms up to 4, each run up to 1 h, and on append gives the stuck trace → two independent checkers confirm the rule. Any on-commit counterexample → the healing rules change before DRAFT or MIN can be judged."

- **On append gives the stuck trace: yes.** healing.py's R2-1, from the state after its fault, on etcd's spec: complete, no working leader in any of 2,905 states (model-checked here).
- **On commit, an invariant broke: in etcd's spec as shipped** (two leaders in one term, F1), because the spec lacks a guard etcd's code has. With etcd's code rules, fero's model holds every invariant in every state explored, the scripted F1 behavior stops at that guard, and R2-1 has a way out. So the counterexample changes L1's text, not the healing rules: DESIGN-V5 §4.2's "a membership change takes effect when it commits" needs "and a member does not stand for election while a committed change is not yet applied" next to it. One more rule in DEV-10's count, no new mechanism; a port of etcd's raft has it already, a rewrite from the paper or from the TLA+ spec would not.
- **The liveness property at the stated bounds: not established.** No full AG EF run with a working leader making changes finished on this box (F3, F4). The liveness evidence is the R2-1 pair (stuck on append, a way out on commit), not a sweep.

So E-14 is **partial**: the rule is confirmed by a second checker where healing.py found it failing, a missing guard was found and shown necessary, and the full liveness sweep is missing.

## How to rerun

```sh
./fetch.sh            # tla2tools.jar and etcd's raft at c51f010, into $SP/dl/
./run.sh              # every run reported here (about 5 CPU-hours; each TLC run under the heavy lock, at most 30 min)
./run.sh r21-append-ef r21-script stale2 stale2-mutant   # the quick ones (seconds of checking each)
./run.sh mutants      # DEV-10's mutants
```

Q-14: Yes, with one more rule: on commit, healing.py's stuck state R2-1 recovers (TLC, a 72-step path) while on append it stays stuck (TLC, all 2,905 states); but etcd's own TLA+ spec reaches two leaders in one term because it lets a member campaign while a committed change is unapplied, which etcd's code forbids and DESIGN-V5 §4.2 must state; the full liveness sweep at 3 to 4 servers did not finish here. Moves: every row that ports etcd's raft (MIN, MIN-P, MIN-TS, DRAFT, RUST, SRV, LEAN, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE) up on F-16 and F-07 (no R2-1 stall) with +1 rule in DEV-10's count, not a mechanism; I `own` down (the spec alone misses the guard); every Raft row's DEV-03 still open (6 of 22 mutants caught, liveness rules unchecked).

