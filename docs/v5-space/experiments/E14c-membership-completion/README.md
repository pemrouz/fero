# E-14c: membership on commit, completed (Raft's real invariants, the lost-disk and swap scenarios, mutant r19)

**Question (Q-14, completion of E-14b).** Are membership changes that take effect on commit, as in etcd's raft, safe and live in fero's healing scenarios? E-14b answered most of it but left three things open: the liveness verdict for `three-disk` (a lost disk replaced under a spare id) and for `four` (the swap), and mutant r19. Both liveness runs had stopped when one of etcd's shipped invariants, `LeaderCompletenessInv`, fired on a stale leader that cannot commit; E-14b showed that this invariant and `QuorumLogInv` are stronger than Raft needs once servers hold different configurations. E-14c replaces each with the property Raft really needs, shows the replacements still catch real safety bugs, gets both liveness verdicts at E-14b's bounds, and settles r19. Threshold (Q-14's own): on commit, every invariant and the liveness property hold at 3 to 4 servers, 2 changes, terms up to 4, each run up to 1 hour; any on-commit counterexample means the healing rules change before DRAFT or MIN can be judged.

**Status: done** (2026-11-10), with stated limits. Both liveness verdicts are in, r19 is settled, the two invariants are replaced. Not done: the full runs at E-14b's bounds do not finish on this box (4.6 and 3.6 million states reached, no invariant broken), so above the first new election the invariants are checked only on the states the runs visited; and the liveness verdicts come from six stated bounds that apply only above that election, checked against six scenarios that finish in full.

## In short

- **The two shipped invariants are replaced by what Raft needs, and the false alarms are gone.** `LeaderCompletenessInv` becomes "a leader whose term is above the term in which an entry was *committed* holds it" (the Raft paper's own wording). `QuorumLogInv` becomes two parts: no server that lacks a committed entry can win an election, and every quorum of the *latest committed* configuration holds every committed entry. A third, new one says no committed entry is ever lost. With them, `one` finishes (E-14b's run stopped at a false alarm) and `three-disk` runs past the depth where E-14b's stopped.
- **They still catch real bugs.** A lost disk that returns under its old id, a leader that commits with a minority, and a voter that grants its vote whatever the candidate's log are each caught by every replacement, as early as the shipped set catches them (traces of 15, 7 and 27 states). Two leaders in one term are caught by `MoreThanOneLeaderInv`, which stays. The four E-14 mutants that E-14b caught with the old invariant are still caught.
- **The liveness verdict for both scenarios: stuck only in E-14b's two-voter window, and not at all when healing grows first.** With E-14b's plans as written, the leader may take a voter away before it adds the newcomer. Then the group passes through two voters, and if the leader is lost just after the newcomer's change commits, the survivors wait for it: 112 stuck states among 381,270 judged in `three-disk`, 692 among 485,043 in `four`. Every one of the 804 is that window. With one planner rule, **grow first** (add or promote the newcomer, then remove or demote), both scenarios have no stuck state at all (0 of 340,671 and 0 of 235,702) and the plan always finishes. DESIGN-V5 §4.2 already has this rule ("a swap promotes first, then removes"); here it is shown needed and enough, on etcd's own spec.
- **How the verdicts were reached.** The full runs do not fit this box: after 100 and 75 minutes they held 4,584,001 and 3,576,095 states and were still growing (no invariant broken). The liveness check only judges states before the first new election, and needs one way out for each. So six bounds were added that apply only after that election and only remove steps. A PASS under them is sound by construction. They were checked on six scenarios that finish in full: the same judged states, the same stuck states, the same plan verdict, each time.
- **r19 is caught, as a liveness bug.** Without "only a voter stands", a leader that removed itself is elected again and keeps a group it is not a member of: 4,350 stuck states where the design has none of that kind. It shows only one term later than E-14b judged. Mutants caught: 12 of 22, and 12 of the 13 not equivalent by reading (92%).
- **Three things about the tools**, for whoever runs TLC next: E-14b's plan check cannot pass in these two scenarios as written, because the plans let the leader spend both changes without reaching the target (now counted apart); a lost disk can make the highest term go back down; and TLC's state ids are the same between two runs only when both load the same module files.

## Words used here

- A **voter** counts toward commits and elections. A **learner** copies the log but does not count.
- **On commit** (etcd's rule, the design): a server acts on a configuration only once the entry holding it is committed and applied. **The campaign guard**: a server does not stand for election while a committed configuration change is not yet applied (etcd's `hup`; E-14 found on commit is safe only with it). Every on-commit run here has it.
- **Working leader** (E-14's goal): a leader that is a voter of its own applied configuration and has committed an entry of its own term. **Plan done** (E-14b's second goal): a working leader whose configuration is the scenario's healing target.
- **Stuck**: from this state, with no more faults and no recoveries, no path reaches a working leader. **Live majority**: a majority of the voters of the latest committed configuration is up.
- **AG EF** ("from every judged state, the goal can still be reached"): healing.py's P5, checked on TLC's state graph by [tools/agef2.py](tools/agef2.py) (E-14b's tool, with one more flag). A state is **judged** when its highest term is at least two below the term bound, so it has two elections in hand. Here the bound is 4 and every run starts in term 2, so the judged states are those **before the first new election**: highest term 2, the **judged term**.
- **A progress step** is any step that is neither a fault nor a recovery. The check follows only progress steps.
- **The two-voter window** (E-14b's finding): a group grows from two voters to three; the change commits; the leader is lost before the other old voter hears of it. That voter still acts on the two-voter configuration and cannot win without the lost leader, although two of the three new voters are up.
- **TLC**: the TLA+ model checker. It visits every state the model can reach within the bounds. A **part-graph** is the part of a state graph TLC had written when a run was stopped.
- **Commit term**: the term of the leader that committed an entry. Raft commits an entry of an older term only indirectly, when a later leader commits one of its own (Raft paper, section 5.4.2), so an entry's commit term can be above its own term.
- **History variable** (or ghost): a variable that records the past for an invariant to read. No step reads it, so it changes no behaviour.
- **DEV-10** (REQUIREMENTS): mutants are made by script from the model text (drop each guard, drop each update, flip each comparison). A mutant is **caught** when the checker finds a counterexample with it.

## Method

### The model

[tla/MCferoc.tla](tla/MCferoc.tla) `EXTENDS` E-14b's [MCferolive.tla](../E14b-membership-liveness/tla/MCferolive.tla), which `EXTENDS` E-14's [MCferoraft.tla](../E14-membership-on-commit/tla/MCferoraft.tla), which `EXTENDS` etcd's `etcdraft.tla`, all unchanged (read in place; [tools/common.py](tools/common.py) stages copies per run). So every step, fault, reduction (E-14b's R1 to R4, symmetry, `LeaderLease`, `CoarseAE`), goal and plan is E-14b's. E-14c adds one history variable, `ctl`: for each index ever committed, the entry and its commit term. It is in TLC's view, so two states with different histories are never merged and every invariant that reads it is checked soundly. Three more small modules are used in step 3 only: [MCferoq.tla](tla/MCferoq.tla) and [MCferoz.tla](tla/MCferoz.tla) (the six bounds) and [MCferog.tla](tla/MCferog.tla) (the grow-first rule). Runs use the real CommunityModules jar, `-workers 2`, `-fp 7` in every segment, and segments of at most 25 minutes, each its own hold of the heavy lock (E-14b's machinery, [tools/run14c.py](tools/run14c.py)). No new segment started in US Eastern peak hours.

### Step 1: what Raft really needs, in place of the two shipped invariants

| Shipped invariant | What it asks | Why it is too strong here (E-14b) | Replacement | Why that is what Raft needs |
|---|---|---|---|---|
| `LeaderCompletenessInv` | a leader whose term is above an entry's **own** term holds every committed entry | an entry of term 2 committed in term 4 by s1; then s2 counts old votes and leads term 3 without it. That leader can never commit (a quorum is at term 4), so nothing is lost; it stopped `three-disk` and `four-voters-append` | `LeaderCompletenessRaftInv`: a leader whose term is above an entry's **commit term** holds it | Raft's Leader Completeness Property says "if a log entry is committed in a given term, then that entry will be present in the logs of the leaders for all higher-numbered terms" (Ongaro and Ousterhout 2014, Figure 3 and section 5.4.3). "Committed in a given term" is the commit term, which the shipped text reads as the entry's own term (cited; the gap is section 5.4.2's indirect commit) |
| `QuorumLogInv` (`QuorumLogInvLive`) | every quorum of **every server's applied** configuration holds that server's committed entries | a learner two changes behind still holds the genesis configuration {s1}, which it can never use (it is not a voter in it, and the campaign guard stops it); it stopped `one` | two parts. `VoteQuorumInv`: no server that lacks a committed entry and could stand can collect a quorum of votes in the configuration it would stand with; every such quorum has a member whose log is more up to date (it refuses, by the shipped `logOk`) or whose disk is lost. `CommittedQuorumInv`: `QuorumLogInv`, but for the **latest committed** configuration only | Raft's safety argument for elections (section 5.4.3): a leader is elected by a quorum, every quorum holds a voter with each committed entry, and that voter refuses a candidate with a less up-to-date log. The first part is that step stated for every configuration a server can still stand in; the second keeps the latest configuration's quorums safe for every future election, which single-server changes guarantee from one configuration to the next (Ongaro's thesis, section 4.2.1: the majorities of the old and new configurations overlap) |
| (none) | | `LogInv` compares only logs that exist now, so a commit lost from every log goes unseen | `CommittedNeverLostInv`: while a live majority exists, every committed entry is on some server whose disk exists | State machine safety needs committed entries to survive, not only to agree. The live-majority guard leaves out one case the protocol cannot help: the only voter of a one-voter configuration losing its disk |

The other six shipped invariants stay (`LogInv`, `MoreThanOneLeaderInv`, `ElectionSafetyInv`, `LogMatchingInv`, `MoreUpToDateCorrectInv`, `CommittedIsDurableInv`). So every run below checks ten invariants. The history variable's cost (model-checked here, against E-14b's counts for the same runs): `three-1c` 12,098 states (+0%), the mutant scenario `m2` 100,736 (+0%), `one` 194,788 against `one-noq`'s 190,058 (+2.5%), `two-1c1f` 66,344 against 64,245 (+3.3%), `three-1c1f` 579,252 against 555,676 (+4.2%), `two` 597,181 against 558,605 (+6.9%).

**The false alarms are gone** (model-checked here): `one` now finishes with all ten invariants holding in every state (194,788 states; E-14b stopped it at `QuorumLogInvLive`), with the same AG EF result as E-14b's `one-noq` (88 stuck states, the two-voter window). `two-1c1f` gives E-14b's 4 stuck states, `two` its 6, and `three-1c1f` passes, as in E-14b. `three-disk` ran to depth 71 with no invariant broken; E-14b's run stopped at depth 66 (step 3).

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

### Step 3: the liveness verdicts for `three-disk` and `four`

Both scenarios keep E-14b's sweep settings ([cfg/three-disk.cfg](cfg/three-disk.cfg), [cfg/four.cfg](cfg/four.cfg)): on commit with the campaign guard, learners vote, terms up to 4 (judged at 2), two changes, at most one fault, recovery free, `LeaderLease`, no message loss, all four of E-14b's reductions, symmetry among interchangeable members, the ten invariants of step 1.
- **`three-disk`** (a lost disk replaced by a spare id): voters s1, s2, s3 and a spare s4 that is not yet a member; the leader may add s4 as a voter and remove any of s1 to s3; the fault is one crash or one lost disk (a lost disk never returns under its id). Plan done: s4 is a voter and there are three voters. Symmetry: the two voters other than the first leader.
- **`four`** (the swap): voters s1, s2, s3 and a learner s4; the leader may promote s4 and demote or remove one fixed voter other than the first leader (`V2`); the fault is one crash of any member. Plan done: s4 is a voter and `V2` is not. No two members are interchangeable here, so symmetry removes nothing.

#### 3a. The full runs do not finish on this box

Model-checked here ([results/three-disk.txt](results/three-disk.txt), [results/four.txt](results/four.txt)):

| Run | Segments | Wall | Distinct states | Depth | Left on the queue | Invariants |
|---|---|---|---|---|---|---|
| `three-disk` | 4 | 100 min | 4,584,001 | 71 | 312,982, still growing | all ten hold in every state reached |
| `four` | 3 | 75 min | 3,576,095 | 62 | 297,296, still growing | all ten hold in every state reached |

Neither queue had begun to shrink. By highest term, `four`'s states are 453,346 at term 2, 2,974,195 at term 3 and 148,554 at term 4; `three-disk`'s are 380,528, 3,690,466 and 513,007: term 4 had hardly begun. At about a million states per 25-minute hold, neither run ends inside this study's budget. So the invariants are checked on these states and not on the whole space. The runs that were tried and dropped on the way (a first attempt with one worker, the smaller fault set `CrashLeaderOnly`, terms up to 3 with the graph) are listed in [results/dropped.md](results/dropped.md).

#### 3b. What the check needs

The check judges only the states before the first new election, and for each one asks for one way out by progress steps. Two short runs at terms up to 2 give that judged part alone, complete (`three-disk-t2`, `four-t2`; all ten invariants hold):

| Scenario | Judged states | With a live majority | Reach a working leader inside term 2 | Need an election |
|---|---|---|---|---|
| `three-disk` | 381,270 | 376,950 | 309,622 | 67,328 |
| `four` | 485,043 | 452,004 | 429,886 | 22,118 |

Everything above term 2 matters to the check only as a way out for the last column. In the full run it is most of the work: in `four`'s part-graph, 3,122,749 states above term 2 come from only 12,633 states that enter term 3, about 250 each ([results/four-entries.txt](results/four-entries.txt)). The reason is the order of independent steps: when a candidate or a leader talks to its followers, E-14b's reductions let the exchanges run in any order, and every order passes through its own states.

The terms-up-to-2 runs load the same module files as the full runs, so a state has the same id in both, and the two can be compared state by state ([tools/partial.py](tools/partial.py); [results/partial-four.txt](results/partial-four.txt), [results/partial-three-disk.txt](results/partial-three-disk.txt)): 453,346 and 380,518 states are in both, none with a different flag, and every step the short run takes out of a state the full run had expanded is a step of the full run. The part-graphs are too shallow to judge with: of the 22,118 states of `four` that need an election, `four`'s part-graph shows a working leader for 211.

#### 3c. Six bounds above the judged term

All six apply only in a state whose highest term is above 2, and each only removes steps. So two things hold whatever the bounds are:
1. **The judged states are the full model's**, each with every step of the full model that leads to another judged state. (One exception, which changes nothing, is under "A lost disk" below.)
2. **A PASS is sound.** Every step kept is a step of the full model, so a way out found here is a way out there.

A FAIL needs more: that no way out was cut off. The table says, per bound, why it should not be (reasoned), and 3d checks it on runs that finish both ways.

| Bound | Module | What it removes above term 2 | Can it cut off a way out? |
|---|---|---|---|
| 1 | [MCferoq.tla](tla/MCferoq.tla) | faults and recoveries | No. The check never follows a fault or a recovery, and one taken above term 2 leads to no judged state |
| 2 | MCferoq.tla | after a fault, a leader's **new** configuration proposals (changes already in a log still commit and apply) | It could, in principle. A working leader needs an election and a commit, not a new change. The plan goal is judged only where no fault was used, so this bound never touches it |
| 3 | MCferoq.tla | the order of E-14b's two eager steps: one chosen server takes its `Ready` step, one chosen message is delivered | No, up to order: `Ready` steps of different servers, and deliveries to different servers, touch different state and end in the same state in any order |
| 4 | MCferoq.tla | every step out of a state where the question is answered: a working leader after a fault, or the plan done | No: the way out has already arrived |
| 5 | [MCferoz.tla](tla/MCferoz.tla) | every candidate but one: of the servers that could stand, one chosen server that can win (a quorum of its own configuration is up, with logs no more up to date than its own and terms no higher). It also applies to the timeout that leaves term 2 | No, when the test for "can win" is right: a server that cannot win only becomes a candidate that lost. In a state before the first election every server is at term 2 or below, where the test is Raft's own voting rule (reasoned) |
| 6 | MCferoz.tla | the order of the steps with no choice in them (apply a committed configuration, become leader, commit, the leader's own append, an append to a follower, a vote request): one fixed order, one chosen server at a time. Standing and proposing happen only when none of these can change anything | No, up to order: once it is settled who stands, these steps carry out what the vote and the logs decide. Delaying one never helps: a leader must apply its committed configuration before it counts as working, and a follower may not stand before it has applied |

Bounds 1 and 2 alone, and bounds 1 to 4, were tried first and are still too big (`three-disk-q`, `four-q`, `three-disk-qf`, `four-qf` in [results/tables.md](results/tables.md): 1.4 to 1.7 million states each when stopped, queues still growing). With all six, a run is the judged part plus a thin layer above it.

#### 3d. The bounds against the full model

Six scenarios that finish in full, run again under the bounds. Each cell: distinct states; stuck with a live majority (of judged states); states that cannot finish the plan (of judged fault-free states). Model-checked here ([results/tables.md](results/tables.md)):

| Scenario | Full model | Bound 1 | Bounds 1+2 | Bounds 1 to 4 | All six |
|---|---|---|---|---|---|
| `two-1c1f` (two voters and a learner, one change, one crash) | 66,344; 4 (2,090); 0 (572) | 60,866; same | 49,143; same | 28,030; same | 3,460; same |
| `one` (one voter and two learners, two promotions, one crash) | 194,788; 88 (14,816); 0 (4,162) | 178,256; same | | 78,741; same | 19,654; same |
| `three-1c1f` (three voters, any one change, one crash) | 579,252; 0 (9,024); 0 (2,464) | 366,544; same | | 167,892; same | 18,613; same |
| `two` (two voters and a learner, two changes, one crash) | 597,181; 6 (17,014); 0 (4,759) | | 248,647; same | 154,752; same | 22,507; same |
| `two-1c1f-d` (`two-1c1f` with a crash or a lost disk) | 67,725; 4 (2,776); 0 (572) | | | | 4,286; same |
| `three-1c1f-d` (`three-1c1f` with a crash or a lost disk) | 599,466; 0 (11,850); 0 (2,464) | | | | 23,537; same |

"Same" means the same three numbers after the state count: the judged states, the stuck states and the plan verdict never changed, in any cell, while the state count fell by up to 31 times.

#### 3e. Results at E-14b's bounds, with all six bounds

Model-checked here ([results/three-disk-z.txt](results/three-disk-z.txt), [results/four-z.txt](results/four-z.txt); each run one segment, 13 and 14 minutes):

| Run | Distinct states | Judged | Invariants | Stuck with a live majority | What holds them | Plan (where the budget still allows it) |
|---|---|---|---|---|---|---|
| `three-disk-z` | 493,907 (complete) | 381,270 | all ten hold | **112** of 376,950 | all 112: the two-voter window | 63,001 judged, all can finish |
| `four-z` | 569,488 (complete) | 485,043 | all ten hold | **692** of 452,004 | all 692: the two-voter window | 89,375 judged, all can finish |

The judged states, and those with a live majority, are the same counts as in the terms-up-to-2 runs of the full model (3b), as they must be.

**All 804 stuck states are E-14b's two-voter window.** [tools/classify.py](tools/classify.py) reads each stuck state and tests, from its logs and commit indexes: nobody leads or stands; a majority of the latest committed configuration is up; and no up server could win an election in the latest configuration it knows to be committed. All 804 pass that test, and in all of them the up server that would win in the latest configuration still knows a two-voter one ([results/three-disk-z-classify.txt](results/three-disk-z-classify.txt), [results/four-z-classify.txt](results/four-z-classify.txt)). The shortest traces, 32 states each ([results/three-disk-z-window-2-trace.txt](results/three-disk-z-window-2-trace.txt), [results/four-z-window-2-trace.txt](results/four-z-window-2-trace.txt)):
1. Leader s1 takes s2 away first (removes it in `three-disk`, demotes it in `four`). It commits with s3. The voters are now {s1, s3}.
2. s1 proposes the newcomer (adds s4, or promotes it): voters {s1, s3, s4}. s3 stores it and acks, so it is **committed**: both voters of {s1, s3} hold it. s1 knows; s3 does not yet.
3. s1 crashes. s3 and s4 are up: two of the three voters of the committed configuration.
4. s3 knows only {s1, s3} as committed and cannot win without s1. s4 is no voter in anything it knows. s2 does not know it was taken away, stands in {s1, s2, s3} and is refused by s3, whose log is longer. Nothing moves until s1 comes back.

So this is not a new failure: it is the window E-14b found in `two-1c1f`, reached here because the plans let the leader shrink the group to two voters before growing it back to three. Each stuck state is a state before the first election, where the model is not bounded at all, and in it no server can win by Raft's own voting rule; so these states are stuck in the full model too (reasoned from the classifier's test and the traces, as E-14b reasoned its 4).

#### 3f. The same scenarios with "grow first"

[tla/MCferog.tla](tla/MCferog.tla) adds one rule for the planner, at every term: a leader proposes a change that makes the voter set smaller only once every newcomer of the plan is a voter of the configuration it acts on. So a swap promotes and then demotes; a replacement adds and then removes; the group never has fewer voters than it started with. Nothing in the membership rules changes. Model-checked here, all six bounds ([results/three-disk-g.txt](results/three-disk-g.txt), [results/four-g.txt](results/four-g.txt)):

| Run | Distinct states | Judged | Invariants | Stuck with a live majority | Stuck at all | Plan |
|---|---|---|---|---|---|---|
| `three-disk-g` | 437,510 (complete) | 340,671 | all ten hold | **0** | 0 | 59,627 judged, all can finish; no state with the budget spent |
| `four-g` | 283,449 (complete) | 235,702 | all ten hold | **0** | 0 | 53,165 judged, all can finish; no state with the budget spent |

Both are a PASS, which is sound under the bounds. So the order of the two changes is the whole difference: shrink first has the window, grow first does not. DESIGN-V5 §4.2 already says "a swap promotes first, then removes"; the two runs above and the two in 3e are that rule's ablation, on etcd's spec.

#### The plan goal, and a budget the leader can waste

E-14b's plan check asks: from every judged state with no fault used, can the plan still be finished? In these two scenarios it cannot pass as written. The plans give the leader two changes, the target needs two, and the plan lets it spend both another way: demote `V2` and then remove it (the learner never promoted), or remove two voters. From such a state no rule could finish the plan. `MCferoq.tla` adds a flag, `openv`: the change budget still allows the plan. [tools/agef2.py](tools/agef2.py) judges the plan where it holds and counts the rest apart: 2,638 such states in `three-disk-z` and 19,952 in `four-z`, none of which can finish (the flag is right), against 63,001 and 89,375 where the budget allows it, all of which can. With grow first there is no way to waste the budget, and no such state.

#### A lost disk can make the highest term go down

The argument for the bounds leans on "terms never go down". That is true of each server, but a judged state is told by the *highest* term among the servers, and a lost disk wipes its server's term. So in `three-disk` a state can be judged after a new election has begun: a server stands alone in term 3, then loses its disk. The bounded runs have no fault above term 2 and never visit such a state. Does that lose a judged state that matters? No (reasoned, and measured on what the full run reached): a candidate's vote request reaches every other member at once and raises their term, so it holds a higher term alone only before it asks (and then losing its disk leaves the same state as losing it one step earlier), or when it is the only voter (and then, once its disk is lost, no live majority is left, so the state is not one the check judges). `three-disk`'s part-graph holds 10 judged states that the terms-up-to-2 run lacks: all 10 are the second kind, with no live majority ([results/three-disk-extra-judged.txt](results/three-disk-extra-judged.txt), made by [tools/missing.py](tools/missing.py)). `four` has no lost disk, and there the two runs' judged states agree exactly.

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

Machine: 4 vCPU, 15 GB (a 14.3 GB limit for the session), one virtual disk, shared with other agents (load 2 to 13 during these runs); Java 21, TLC2 2026.11.06 nightly, CommunityModules 202611060952, Python 3.13 with numpy 2.5 ([results/versions.txt](results/versions.txt)). Wall times include sharing the CPU. Every run's constants are in [cfg/](cfg); every run's row is in [results/tables.md](results/tables.md), built from [results/runs.json](results/runs.json) by [tools/table.py](tools/table.py).

| What | Result | Evidence |
|---|---|---|
| The two shipped invariants replaced; the false alarms gone | `one` finishes (194,788 states, ten invariants hold); `three-disk` passes E-14b's stopping depth | model-checked here, step 1 |
| The replacements catch real bugs | ghost, minority and anylog caught at 15, 7 and 27 states, as early as the shipped set; twovote by `MoreThanOneLeaderInv`; mutants r02, r05, r06, r09 still caught | model-checked here, step 2 |
| `three-disk` (lost disk, spare id), E-14b's plan | 112 stuck states with a live majority among 381,270 judged; all the two-voter window; plan finishes wherever the budget allows | model-checked here under six bounds (3e); stuck in the full model: reasoned |
| `four` (the swap), E-14b's plan | 692 stuck among 485,043 judged; all the two-voter window; plan finishes wherever the budget allows | the same |
| The same two with grow first | 0 stuck of 340,671 and 0 of 235,702; plan always finishes | model-checked here; a PASS is sound under the bounds (3f) |
| The six bounds | same judged states, stuck states and plan verdict as the full model on six scenarios | model-checked here (3d) |
| Safety in the two scenarios | all ten invariants hold in every state of every run: 4,584,001 and 3,576,095 states of the full runs (not finished), the complete terms-up-to-2 runs, and the four complete bounded runs | model-checked here (3a, 3b, 3e, 3f) |
| r19 (only voters stand) | caught as a liveness bug: 4,350 stuck states with a non-voter leader, 0 in the design | model-checked here, judged one term further; the trace's end is reasoned (step 4) |
| DEV-10's mutants | 12 of 22 caught; 12 of the 13 not equivalent by reading (92%; E-14b: 11, and r19 open). Still not caught: r07, outside the property by construction | E-14b's table plus r19 |

**Rules counted (DEV-10 (c), ablation).** E-14b counted 14 rules for membership on etcd's raft. E-14c adds two, both shown needed by ablation and neither a new mechanism: only a voter stands (r19; etcd's `promotable()`), and healing grows before it shrinks (3e against 3f; DESIGN-V5 §4.2's "a swap promotes first"). The second is a rule for whoever plans the changes: DRAFT's per-leader healing, MIN's controller loop.

## What the model leaves out

Everything E-14b's model leaves out, it still leaves out (E-14b's own list): 5 servers (Ongaro's 2015 single-server bug needs 5), more than two changes, more than one fault per run, partitions as such, message loss together with liveness, and a full check without E-14b's four reductions (R4, the one coarsening, is checked only on E-14b's calibration pairs). Also:
- **The invariants above the first election, at full size.** The full runs at E-14b's bounds stopped at 4,584,001 and 3,576,095 states with their queues still growing. The bounded runs visit only a thin layer above term 2. So "all ten invariants hold" is complete for the states before the first new election and partial after it.
- **A FAIL under the bounds is argued, not proved.** A PASS is sound by construction. That the 804 stuck states are stuck in the full model too rests on the classifier's test (no server can win, by Raft's voting rule, in a state where the model is not bounded), on reading the traces, and on the six calibration scenarios, where the bounds never changed a stuck count. The six include a lost disk only at small size (`two-1c1f-d`, `three-1c1f-d`).
- **AG EF looks only at states in the first leader's term.** Every run is judged at two terms below its bound (E-14b's rule), and in every scenario here the first new election is term 3, so with terms up to 4 only term-2 states are judged. A dead end that appears only after a new election is seen only when every path from some term-2 state leads into it. r02's dead end and r19's non-voter leader are of that kind: E-14b's AG EF missed both (r02 was caught by an invariant).
- **Judging one term further meets a bound of the model.** E-14 kept `MCetcdraft`'s "one candidate at a time": a candidate that lost can never stand again, and while it is a candidate no other member of its configuration may stand. Judged at term 3, the design itself then has stuck states (812 in `m3`, all of this kind). So step 4 sorts stuck states by kind rather than reading a raw FAIL, and the step 3 verdicts stay at E-14b's judging rule.
- **Grow first is checked for these two plans only**: one newcomer, one member to take away, starting from three voters. A group that really is at two voters (E-14b's `two`, `one`) still has the window, whatever the order.
- **The replacements are checked, not proved.** Each is argued from the Raft paper and thesis (cited) and shown here to catch every lost-commit bug planted (step 2); none is checked with TLAPS or Apalache.
- **Fairness and timing** as in E-14b: AG EF says a way out exists, not that random timeouts take it; how long anything takes is not measured here.

**Three traps in TLC, for anyone who compares runs** (E-14b lists two more, about split runs):
1. With a view and a lost-disk fault, "the highest term" is not monotone (above).
2. TLC's state ids (fingerprints, which are also the node ids of `-dump dot`) agree between two runs only when both load the same module files, as well as the same `-fp`. TLC fingerprints a string by the order in which it first met it, so one more module in the run gives every state another id. Measured here: `four` and `four-t2` give the initial state the same id; `four-z`, which also loads `MCferoq.tla` and `MCferoz.tla`, gives it another; a state-by-state comparison then finds no state in both.
3. Three TLC runs with 5 GB heaps do not fit this session's memory limit: one was killed. The driver now takes `--heap`, and `run.sh` starts runs one at a time.

## Against the threshold

Q-14's threshold: "on commit, every invariant and the liveness property hold at 3 to 4 servers, 2 changes, terms ≤ 4, each run ≤ 1 h, and on append gives the stuck trace → two independent checkers confirm the rule. Any on-commit counterexample → the healing rules change before DRAFT or MIN can be judged."

- **On commit, safety: holds in every state reached.** With Raft's real invariants in place of the two too-strong ones, no invariant broke in any on-commit run of E-14c: the complete runs of steps 1 and 3, and the 8,160,096 states the two full runs reached. The false alarms that stopped E-14b's `one` and `three-disk` do not come back. Not complete: the two full runs (3a).
- **On commit, liveness, the lost-disk replacement and the swap: holds when healing grows first; fails in the two-voter window when it shrinks first.** With E-14b's plans (either order) there are 112 and 692 stuck states with a live majority, all the window E-14b found; this is the same on-commit counterexample as E-14b's, not a new one. With grow first there is none, and the plan always finishes. Each of these runs took 9 to 14 minutes.
- **Bounds.** 4 servers (3 voters and a learner or a spare), 2 changes, terms up to 4, one crash or lost disk: E-14b's. The liveness verdicts use six more bounds that apply only above the judged term (3c); the two full runs at E-14b's bounds alone did not finish in 100 and 75 minutes.
- **By the threshold's own rule, the healing rules change** in the way E-14b said, with one more line, which the design already has: (1) healing grows before it shrinks, so that a swap or a replacement never passes through two voters (DESIGN-V5 §4.2: "a swap promotes first"; shown needed and enough here); (2) only a voter of its own applied configuration stands (etcd's `promotable()`; r19); (3) E-14b's limit stands for a group that really is at two voters: growing from two to three has a one-message window, and if the old leader's disk is lost in it the survivors need an operator step.

## How to rerun

```sh
./fetch.sh            # CommunityModules 202611060952, tla2tools.jar, etcd's raft at c51f010, into $SP/dl/
./run.sh calib        # step 1 (minutes)
./run.sh bugs         # step 2 (about 30 CPU-minutes)
./run.sh sweep        # step 3: the terms-up-to-2 runs, the calibration, the bounded runs, grow first (about 3 CPU-hours)
./run.sh full         # step 3, optional: the runs that do not finish (hours; they leave the part-graphs 3a and 3b read)
./run.sh r19          # step 4 (minutes)
python3 tools/table.py   # results/tables.md from the JSON files
```

Q-14: Yes, with one planner rule that DESIGN-V5 §4.2 already has: on commit with the campaign guard broke none of Raft's real invariants in any state reached (the two shipped invariants that stopped E-14b are replaced, and the replacements catch a returning lost disk, a minority commit and a vote without the log check as early as the shipped set), and in the lost-disk replacement and the swap it has no stuck state when healing grows before it shrinks (0 of 340,671 and 0 of 235,702 judged states, plan always finishes), against 112 and 692 stuck states, every one E-14b's two-voter window, when the leader may shrink first; r19 is caught as a liveness bug (a removed leader takes the group back), so 12 of 13 non-equivalent mutants are caught (92%). The full runs at E-14b's bounds do not finish on this box (4.6 and 3.6 million states, no invariant broken); the liveness verdicts use six bounds above the judged term that give the full model's numbers on six scenarios. Moves: every row that ports etcd's raft (MIN, MIN-P, MIN-TS, DRAFT, RUST, SRV, LEAN, CELL, LANE, SPLIT, RLOG, EMB-V8, SIDE) up on F-16 and DEV-03 (both open healing scenarios now judged, r19 settled), F-07 as E-14b left it (the window stays only for a group that really is at two voters), +2 counted rules already in etcd or in DESIGN-V5 §4.2 (only a voter stands; healing grows first), no new mechanism; DRAFT and MIN the same, since both must order a swap grow-first: DRAFT states it, MIN's controller must.
