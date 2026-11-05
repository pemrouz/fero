# healing.py: a model check of healing and leave

[healing.py](healing.py) is a small exhaustive model checker for [DESIGN-V5.md](../DESIGN-V5.md) §4.2: "Healing: one rule, run by each shard's leader", the planner table, the `leave` row of "Leaving, restarting and stopping", and the healing property of §10.2. It is plain Python 3, standard library only. It explores every reachable state within its bounds, breadth first, so each counterexample below is a shortest one.

There have been two rounds:
- **Round 2** checks the text as revised after round 1: swaps promote first, `gone` comes from each leader's own links, a leave marks `retiring`, and two voters step back to one. It is the default, and is reported first.
- **Round 1** checked the text before that. Its results are kept below as they were reported, and `--round 1` reruns them.

```sh
python3 healing.py                     # round 2, eight scenarios (about 25 min on one core)
python3 healing.py --scenario three    # one scenario
python3 healing.py --mutants           # round 2's 22 mutants (about an hour)
python3 healing.py --fix swap-exact-remove --fix stand-when-demoted   # round 2's proposed fixes
python3 healing.py --any-order --faults 1   # every step order (see "Reductions")
python3 healing.py --round 1           # round 1's model, its mutants with --mutants, its fixes with --fix
python3 healing.py --list
```

## Round 2 in short

- **Raft safety held everywhere** (P1). Healing never raised a count to an even number, and never lowered one except where the text says (P3). A shard never settled at two or four voters (P4). A leave never removed a paused voter (P6). No healing step targeted a retiring member (P7). Healing always replaced a gone voter when a live candidate was free (P8). No configuration churned: at most 8 changes ever came between two outside events, so nothing flaps (P9).
- **One new stuck state with a live majority** (P5, `four`, 36 states). It is a Raft-level gap that round 2's swap made reachable (finding R2-1).
- **The swap's removal step is too early** (P2, finding R2-2). The new voter can lack its own promotion when "the very next step" removes the old one.
- **§10.2 still misses two exceptions** (finding R2-3): the step from two voters back to one, and a leave whose promoted learner fails before the leaver's removal.
- **A planner `retire` with no replacement never completes** (finding R2-4).
- **Your three questions.** A shard does not settle at four voters or flap. Two-to-one and a swap do not fight, even in any step order. A member back after `gone` costs one swap and stops.
- **Mutants:** see the round-2 table below.

## Words used here

- A **replica** is a member plus its disk incarnation. A member that comes back without its disk is a new replica, written `2#1`. The old replica `2` can no longer vouch for its log. **Vouching** means its disk still holds what it acknowledged.
- A **voter** counts toward commits and elections. A **learner** copies the log but does not count.
- **Committed** means a leader saw a majority of its configuration's voters hold the entry.
- **Gone** means a member's link has been down past `evict.after`, or a planner said so.
- **Answering** (round 2, §10.2): up and linked to the leader. A paused voter counts: it answers within the probe window.
- **Retiring** (round 2): marked for good by a leave or a planner's `retire`; never a candidate. Round 1 called this `draining`. In round 2 `draining` gives up leadership only, and is not modelled.
- A **swap** (round 2): add the replacement as a learner, let it reach the commit offset exactly, promote it, then remove the old voter in the very next step.
- **Dead**, for a leave, means the member's link is down and it does not answer the leader's probes within `leave.ms`. A **paused** member (a GC pause shorter than the probe window) answers in time.
- **Settled** means healing has nothing left to do: a leader that can write, nobody leaving or paused, every reachable member caught up, every unreachable voter already marked gone, and no healing step enabled.
- **Stuck** means no fault-free path leads to a leader that can write.

## What it models

**One shard, as an abstract Raft group.**
- Each replica has a term, a vote and a log. Entries are a leader's own-term entry (written `n2` for term 2), client writes (`c0`) and configuration changes.
- A configuration (voters, learners) is a log entry. It takes effect when appended, as in Raft's single-server changes. A leader makes one change at a time. Each change waits until the previous one has committed, and until the leader has committed an entry of its own term (Ongaro's 2015 fix).
- A commit needs a majority of the voters of the leader's latest configuration. It counts only replicas that can vouch.
- An election is one step. The candidate first passes PreVote: a majority of its own configuration's voters must be out of touch with a live leader, and must find its log up to date. Then it collects real votes by Raft's rule. Learners answer vote requests by the log rule and never stand. A candidate counts only its own configuration's voters, and only replicas that can vouch.
- A leader steps down when it cannot reach a majority (CheckQuorum), sees a higher term, or has removed itself.
- A leader can be deposed with its uncommitted tail lost; the next leader's log wins.
- A leaving leader hands over with TimeoutNow to its best-ranked caught-up voter.

**Members (2 to 4) and faults.**
- A member can:
  - crash, keeping or losing its disk;
  - be partitioned (members sit on one of two sides; links cross no side);
  - pause;
  - get Ctrl-C (a leave);
  - be cut off mid-leave;
  - be marked gone.
- Crashes, partitions, pauses and cut-offs count against the fault budget. Returns, heals, the end of a pause and the gone mark (time passing) are free.
- A member that leaves, or crashes while leaving, never comes back. A Ctrl-C means the operator wants it gone.

## Round 2: the revised text

### What changed in the model

**Healing, as the text now says.**
- **Candidates** are members that are not retiring, not departed, and that the leader's own link has reached within `evict.after`. A member that never started has never been reached, so it is not a candidate until it starts.
- **Gone** is per leader: its own link down past `evict.after`. `#meta`'s `gone` mark is left out. The model relies on each leader's own link, which the text says is enough. That mark is also what makes the `ignore-own-link` mutant matter: without it, only `#meta` would ever drop a dead member.
- **The target** is as in round 1: three voters once three candidates are live, or the incumbent for a one-voter shard; never even, never lowered.
- **The steps**, one at a time, in this order:
  1. **The swap's removal**, forced as "the very next step" after a swap's promotion. No leave step may come between.
  2. A gone voter removed with no replacement, only when the voters left are still odd and at or above the target.
  3. Growth to an odd count, by a learner within `lag.max`.
  4. **A swap**, for a gone voter (by a leader with quorum) or a live voter not in the target: add the learner, wait for the commit offset exactly, promote.
  5. Add live candidates as learners.
  6. A surplus live voter, once the target is all voters.
  7. **Two voters step back to one:** fewer than three live candidates, neither voter retiring, `copies` not 2.
  8. Drop stale learners.
- **A retiring voter is left to its own leave** while that leave runs. Afterwards, healing treats it as any voter not in the target.

**The leave** marks the member `retiring`. Then the leader:
1. promotes a caught-up learner;
2. removes the leaver once that learner's log reaches the commit offset exactly, waiting within `leave.ms` while the learner is live;
3. removes dead voters first, by the probe rule, when that is what lets the leave carry;
4. keeps the leaver as a voter when neither step is safe.

A leaving or retiring leader hands over first.

**The planner** (two new scenarios):
- `retire` and `undrain`, with up to two hints;
- `stop`, once a retired member holds no replica (a scale-in);
- `drain` and `lead` move only leadership, and are not modelled.

**Under-replication** is reported when live voters are fewer than `copies` or than the configuration's voters.

### Properties added or changed

| | Property |
|---|---|
| P2 | The revised §10.2: "no healing step reduces the number of **answering**, vouching voters that hold a committed entry, unless a replacement voter already holds it; a leave may, only when no caught-up learner exists or by removing dead voters". A removal is paired only with its own promotion: a swap's removal with that swap's promotion, a leaver's removal with the learner promoted for it. Only a leader that reaches a majority is judged, since a cut-off leader cannot commit the step before CheckQuorum steps it down. |
| P3 | Allowed: growth 1 -> 2 -> 3; a swap's promotion to four with its removal forced next; the swap's removal; the surplus rule; two voters stepping back to one. Nothing else lowers or makes an even count. |
| P8 | New: a settled shard has no gone voter while a live candidate is free. Healing finishes its swaps. |
| P9 | New: no more than 8 configuration changes in a row without an outside event (a fault, a return, a heal, a pause ending, time passing, Ctrl-C or a planner hint). A loop, such as two rules fighting or a returning member churning, shows here. States past the cap are not explored. |
| P10 | New, for the planner scenarios, and informational: a retired member ends with no replica. |

### Runs

The revised text, with the stuck search. All on one core each; about 25 minutes in all.

| Scenario | Members | Faults | Leaves / hints | Client entries | States | Time |
|---|---|---|---|---|---|---|
| `two` (example 01) | 2 | 2 | 1 | 1 | 14,203 | 2 s |
| `three` | 3 | 2 | 1 | 1 | 1,344,467 | 255 s |
| `one` (1 voter growing to 3) | 3 | 2 | 1 | 0 | 890,126 | 174 s |
| `four` (3 voters, 1 learner) | 4 | 2 | 1 | 0 | 4,827,906 | 892 s |
| `four-2leave` | 4 | 1 | 2 | 0 | 230,714 | 69 s |
| `four-arrive` | 4 | 1 | 1 | 0 | 40,812 | 8 s |
| `three-retire` (planner) | 3 | 2 | 2 hints | 0 | 120,843 | 15 s |
| `four-retire` (planner) | 4 | 1 | 2 hints | 0 | 194,650 | 22 s |

Any-order runs, for "do rules fight":

| Scenario | Faults | States | Most changes between outside events |
|---|---|---|---|
| `one` | 1 | 25,106 | 6 |
| `three` | 2 | 198,437 | 6 |
| `four` | 1 | 12,930 | 5 |
| `four-arrive` | 1 | 51,370 | 6 |
| `four-retire` | 1 | 199,531 | 6 |

All of them hold P1, P3, P4, P6, P7, P8 and P9.

**What held, everywhere:**
- P1, all four parts. P1-durable now holds in `four` too: the report counts the configuration's voters.
- P3, P4, P6, P7, P8 and P9. The most configuration changes between two outside events was 8, in `four`.
- P5 everywhere except `four` (finding R2-1).

**What was violated:**

| Scenario | P2 | P5 | P10 |
|---|---|---|---|
| `two` | - | - | - |
| `three` | heal-demote; leave-no-replacement (admitted) | - | - |
| `one` | heal-demote; leave-no-replacement | - | - |
| `four` | heal-demote; **heal-swap-remove**; leave-no-replacement; leave-after-promote, replacement down | **36 states** | - |
| `four-2leave` | heal-demote; leave-no-replacement; leave-after-promote, replacement down | - | - |
| `four-arrive` | heal-demote; leave-no-replacement; leave-after-promote, replacement down | - | - |
| `three-retire` | - | - | retire never completes |
| `four-retire` | **heal-swap-remove** (and replacement down) | - | retire never completes |

### Findings, and the sentences still wrong

#### R2-1. A shard with a live majority waits for a cut-off leader (P5)

**Trace** (`four`, 6 steps, two faults):
1. Member 1 is partitioned away.
2. `evict.after` passes.
3. Leader 0 promotes learner 3 to replace 1: voters {0,1,2,3}. This commits on 0, 2 and 3.
4. Member 0 is partitioned onto 1's side.
5. "The very next step": 0 removes 1, which stays a learner: voters {0,2,3}. The entry reaches only 1.
6. Member 1's partition heals.

Now 1, 2 and 3 are linked: three of the four voters of the committed configuration. But:
- 2 and 3 need 1's vote, and 1 refuses it: its log is longer.
- 1 never stands: in its own log it is a learner.
- 0 is cut off.

The shard waits for 0, though a live majority is there.

**The sentences:**
- "A change takes effect when appended" (the single-server rule the model was asked to use).
- §4.2, "A learner ... never stands itself".

Together they make a member demoted by an uncommitted entry into a voter that blocks and cannot stand. Round 2 makes this reachable because the swap's removal comes at once, even from a leader that has just lost its links. It is not specific to swaps: any demotion of a voter can do it.

**Fix:** either say that fero's raft applies a configuration change when it commits, as etcd's raft does (decision 22 ports it), or add to §4.2: "A member demoted by an entry that is not yet committed still stands, and does not count its own vote", as Ongaro's thesis lets a server outside its latest configuration stand. `--fix stand-when-demoted` checks the second: see "Fixes checked".

#### R2-2. The swap removes the old voter before the new one holds its own promotion (P2)

**Trace** (`four-retire`, 4 steps, one fault):
1. Learner 3, caught up, pauses.
2. A planner retires member 0.
3. Leader 0 promotes 3 to replace 0: voters {0,1,2,3}. This commits on 0, 1 and 2; 3 misses it.
4. "The very next step" removes 0: voters {1,2,3}.

The promotion entry, which is committed, is now on 2 of 3 voters, where it was on 3.

A second trace (4 steps): 3 is promoted, then crashes, and the next step still removes 0, which was live. In `four`, a returning member and a lost disk give the same with no planner.

**The sentence:** "let its log reach the leader's commit offset, exactly, not merely within `lag.max`; promote it; then remove the old voter in the very next step. ... No step lowers the number of answering voters holding a committed entry". The commit offset is checked before the promotion, but the promotion itself moves it.

**Fix:** "promote it; then, once its log reaches the commit offset again, its own promotion included, remove the old voter in the very next step. If the new voter is gone first, that step removes it instead, and the old voter stays." The leave row already says this for its own replacement. `--fix swap-exact-remove` removes every case.

#### R2-3. §10.2 misses two exceptions (P2)

**The sentence:** "no healing step reduces the number of answering, vouching voters that hold a committed entry, unless a replacement voter already holds it; a leave may, only when no caught-up learner exists or by removing dead voters, and says so".

- **Two voters stepping back to one** (`three`, 3 steps) is a healing step that removes an answering holder, with no replacement. §4.2 itself calls it "the one step by which healing lowers a voter count".
- **A leave whose promoted learner fails before the leaver's removal** (`four`, 4 steps):
  1. Member 1 gets Ctrl-C.
  2. Learner 3 is promoted for it, and catches up.
  3. 3 crashes.
  4. The leave removes 1: the remaining live voters are a majority.

  Removing 1 is right: keeping it would leave {0,1,2,3} with only two live members once 1 exits. But it lowers the answering holders, and the sentence does not allow it.

**Fix:** "no healing step reduces the number of answering, vouching voters that hold a committed entry, unless a replacement voter already holds it, except two voters stepping back to one; a leave may, only when no caught-up learner exists, when the learner it promoted fails before the leaver is removed, or by removing dead voters, and says so".

#### R2-4. A planner `retire` with no replacement never completes (P10)

**Trace** (`three-retire`, 1 step): a planner retires member 0 of three. No candidate can replace it, healing never lowers a count, and the step back to one is for two voters only. So 0 stays a voter for good, and the scale-in "retires a copy before it stops it" waits for ever. It is the same in `four-retire` after two retires.

**The sentence:** `retire(member)`, "As `drain`, and healing moves its replicas off, since a retiring member is never a candidate. A scale-in retires a copy before it stops it".

**Fix:** say what happens. For example: "When no candidate can replace it, a retire stays pending and `cluster.health` says why. To go below `copies` members, the copy leaves (Ctrl-C), which may lower the count". Or let the leader remove a retiring voter as a leave would, when the remaining live voters stay a majority.

### Your three questions

- **Can a shard now settle at four voters, or flap?** No.
  - P4 held in every run: no settled state had two or four voters.
  - The surplus rule settles a swap cut off between its steps.
  - P9 held: at most 8 configuration changes came between outside events. In any step order it was 6.
- **Can two-to-one and a swap fight?** No.
  - Their conditions do not overlap. Two-to-one needs fewer than three live candidates. A swap needs a free live candidate in the target, at the target count.
  - With every step order allowed, no run churned or settled at two or four.
  - Two-to-one did need "neither voter retiring". Without it (`two-to-one-retiring`), a one-voter leave and the step back undo each other. The model then finds a shard stuck for good after a Ctrl-C alone.
- **Can a member back after `gone` cause churn without end?** No. Its return is an outside event. It is taken back as a learner, and at most one swap follows (add, promote, remove: three changes). The return costs one fault each time it happens, so it cannot loop on its own.

### Stuck states

Every stuck state lacks a live majority, except finding R2-1. The classes, counts aside, are round 1's, and so is whether the doc admits them. Round 2 adds no "settles at two" source. Two voters now come only from a leave in flight, or a step back not yet taken.

### Mutants (round 2)

MUTANTS_TABLE

### Fixes checked

FIXES_TABLE

## Round 1: the first review

These are round 1's results as reported, on the text as it then stood. `python3 healing.py --round 1` reruns them; the state counts can differ slightly, since round 2 added a churn counter to the state. Findings 1 to 5 below are now in the text: they are what round 2 checked.

### Results in short

- **Raft safety held everywhere.** At most one leader per term; no new leader lacked a committed entry; no commit overwrote one. A committed entry was always on a majority of the committed configuration's voters, or the shard was reported under-replicated, except in one case (finding 3).
- **Healing never raised a voter count to an even number, and never lowered one** (P3). A paused voter was never removed by a leave (P6). Healing never targeted a leaving member (P7). With a live majority, the shard always got a writable leader again (P5).
- **Five design findings** (below):
  1. The leave can remove the leaver before its replacement holds the newest commit.
  2. A dead fourth voter is never removed.
  3. A dead fourth voter is never reported.
  4. A shard can sit at two voters, where the doc says it should have one or three.
  5. §10.2's property is broken by healing's own gone-voter step, as worded.

  Findings 1 to 3 are gaps in the rules. Finding 4 is a contradiction with a real cost: either crash then stops writes. Finding 5 is wording. Each has a proposed fix, and the fixes for 1 to 4 were checked by the same model.
- **Twelve of fourteen mutants are caught.** The two not caught guard against things this model has no notion of: time to catch up, and five members (see "Mutants").

**Healing, as round 1 modelled it.**
- **The target** is the ring, with rank = member number. Candidates are members that are not draining, departed or gone.
  - There are 3 target voters once three candidates are live. Otherwise the voter count stays as it is ("never lowers", "only to an odd number").
  - A one-voter shard keeps its incumbent ("Its one voter stays the incumbent across restarts").
- **The steps**, one at a time, in the doc's order:
  1. A gone voter (or a replica whose member came back with a new disk) is removed, "only when a replacement candidate exists".
  2. A live candidate is added as a learner.
  3. A learner within `lag.max` of the commit offset is promoted, to an odd count. The exceptions are the doc's own: 1 -> 2 -> 3 once three candidates are live, and 3 -> 4 -> 3 to replace a live voter not in the target.
  4. A live voter not in the target is removed once its replacement is a voter "whose log reaches the leader's commit offset, exactly".
  5. Learners whose member is gone, draining, departed or on a stale disk are dropped.
- `lag.max` is one entry.

**The leave, as round 1 modelled it.**
1. Ctrl-C marks the member `draining`.
2. A leaving leader hands over first. As a shard's only voter, it first promotes a learner.
3. The leader then promotes one caught-up learner, if there is one, "so the voter count holds".
4. It removes the leaver "if the remaining live voters stay a majority of the new set".
5. If that is not safe, it removes dead voters first, by the probe rule. A paused voter is not dead.
6. If neither is safe, the leaver is kept as a voter.
7. The leaver's process exits as soon as its leader has decided, and is in any case bounded by `leave.ms`.

**Two timing facts the doc implies,** modelled as guards:
- CheckQuorum steps a cut-off leader down within `election.ms`. That is before `evict.after` and before the leave's probe window ends. So only a leader that reaches a majority acts on a link that has been down for a long time.
- A leaving leader waits while a reachable voter can take its hand-over (or, as the only voter, while a reachable learner can catch up). A paused one answers within `leave.ms`.

### Properties

| | Property | How it is checked |
|---|---|---|
| P1 | Raft safety | At most one leader per term (a history of who won each term). A new leader holds every committed entry. A commit never overwrites a committed entry. **P1-durable:** every committed entry is on a majority of the committed configuration's vouching voters, or `cluster.health` reports under-replication. The doc's test is "fewer live voters than `copies`". A live voter is up, can vouch, and is not cut off on the smaller side. |
| P2 | §10.2: "no healing or leave step reduces the number of vouching voters that hold a committed entry, unless a replacement voter already holds it" | At every removal, for every committed entry, the vouching holders among the new voters must be at least those before. If the previous change of voters promoted a replacement, "before" means before that promotion. So a promote-then-remove pair passes only if the replacement holds the entry. Only steps by a leader that holds every committed entry are judged; a leader missing one can never commit. |
| P3 | Healing never raises a voter count to an even number, and never lowers one | At every healing step. Allowed exceptions: the doc's 1 -> 2 -> 3 growth, the 3 -> 4 -> 3 replacement, and a gone voter removed while a replacement candidate exists (or, under the `gone-surplus` fix, while the count stays at the target). |
| P4 | The shard never settles with two voters (or any even count) | At every settled state. Each case is labelled with the step that last changed the count, and whether a returning member could undo it. |
| P5 | After faults stop, with a live majority, the shard elects and commits | For every reachable state: a fault-free search (no returns, pauses end) for a leader that is not leaving, has committed in its term, and reaches a majority of its non-leaving voters. States with none are stuck. Each is classified, and checked again with returns and heals allowed. |
| P6 | A merely paused member is never removed by a leave | At every leave removal of a voter other than the leaver. |
| P7 | No healing step targets a draining member | At every add and promote. |

### Runs

The design as written. Times include the stuck search. All on one core each.

| Scenario | Members | Faults | Leaves | Client entries | States | Time |
|---|---|---|---|---|---|---|
| `two` (example 01: 1 voter, 1 learner) | 2 | 2 | 1 | 1 | 12,764 | 1 s |
| `three` (3 voters) | 3 | 2 | 1 | 1 | 1,050,293 | 248 s |
| `one` (1 voter, 1 learner, a third starts later) | 3 | 2 | 1 | 0 | 956,910 | 235 s |
| `four` (3 voters, 1 learner) | 4 | 2 | 1 | 0 | 3,514,195 | 705 s |
| `four-2leave` | 4 | 1 | 2 | 0 | 241,129 | 47 s |
| `four-arrive` (3 voters, a 4th starts later) | 4 | 1 | 1 | 0 | 42,981 | 7 s |

Terms are bounded at 5 in the search, and at 8 in the stuck search. The two smaller 4-member runs use one fault to stay within minutes; `four` covers two. `three` with no client entries is 154,144 states (34 s).

**Held in every run:** P1-election, P1-complete, P1-prefix, P3, P5, P6, P7. `two` holds every property.

**Violated:**

| Scenario | P1-durable | P2 | P4 |
|---|---|---|---|
| `two` | - | - | - |
| `three` | - | leave-dead, leave-leaver-no-replacement, **leave-leaver-after-promote** | settles at 2 (leave; gone) |
| `one` | - | the same three | settles at 2 (leave; gone; **interrupted 1->2->3**) |
| `four` | **yes** | the same three, and heal-gone | settles at 2; **settles at 4** |
| `four-2leave` | - | the same four | settles at 2; **settles at 4** |
| `four-arrive` | - | the same four | settles at 2; **settles at 4** |

Client entries add only log positions in this model. Each leader's own-term entry and every configuration change are committed entries too, tracked the same way. A client entry costs 5 to 9 times the states, so 4-member runs use none. The 3-member run with one client entry found the same classes as with none.

### Design findings

#### 1. The leave removes the leaver before its replacement holds the newest commit

**Trace** (`four-arrive`, 6 steps, one fault):
1. Member 3 starts. The leader, 0, adds it as a learner, and it catches up.
2. Member 3 pauses (a GC pause).
3. Member 1 gets Ctrl-C.
4. The leader promotes learner 3: voters {0,1,2,3}. 3 is "caught up": within `lag.max`. But it is paused and misses the promotion entry. The entry commits on 0, 1 and 2.
5. The leave removes 1: voters {0,2,3}. The remaining live voters are a majority; a paused voter counts as live.

The newest committed entry is now on 2 of the 3 voters, where it was on 3. The replacement, 3, does not hold it. In `three` and `one` the same happens with a member that returned as a learner. With per-follower replication (`--fine`), no pause is needed: a learner one entry behind is enough.

**Breaks:** §10.2, "no healing or leave step reduces the number of vouching voters that hold a committed entry, unless a replacement voter already holds it". The leave row says only "promotes a caught-up learner", and §4.2 defines caught up as within `lag.max`. Healing's own rule for a live voter waits for the commit offset "exactly, not merely within `lag.max`. So no step lowers the number of voters holding a committed entry" (R-72, H-172). The leave path has no such wait.

**Fix:** in the leave row, "then it removes the leaver once the promoted learner's log reaches the leader's commit offset, exactly, as healing's live-voter rule does". This costs about one round trip inside `leave.ms`. `--fix leave-exact` removes every case of it in every scenario.

#### 2. A shard can settle at four voters, one of them dead, for good

**Trace** (`four`, 4 steps, one fault):
1. Member 1 gets Ctrl-C.
2. The leader promotes learner 3 first: voters {0,1,2,3}.
3. Member 1 crashes before the leader removes it, so the leave is cut off.
4. `evict.after` passes, and member 1 is gone.

Healing now has no step. "A gone voter ... is removed only when a replacement candidate exists", and every other member is already a voter. The shard keeps four voters. A commit needs all three of {0,2,3}, so one more failure stops writes, where three voters {0,2,3} would survive it.

The run found two more paths to the same end:
- A member losing its disk while a leave was in flight (`four`, 10 steps, two faults). Its new replica was promoted by the leave, so its old replica, which can no longer vouch, has no "replacement candidate" left. The doc says (4.1): "the shard's leader adds it back as a learner and removes the old one". The second half never happens.
- Healing and the leave both promoting a replacement for the same leaver. Healing counts a draining voter as a live voter not in the target, so it promotes one. The leave then promotes "a caught-up learner" too, and the shard briefly holds five voters.

**Breaks:** "healing raises a voter count only to an odd number", and the purpose of "a gone voter is removed only when a replacement candidate exists", which is to stop shrinking below the target, not to keep a surplus dead voter.

**Fix:** "a gone voter is also removed, with no replacement, when the voters left are still an odd number at or above the target". It would also be better to say that healing leaves a leaving voter to the leave, so only one of them promotes a replacement. `--fix gone-surplus` removes every settle at four.

#### 3. Under-replication goes unreported while a shard has four voters

**Trace** (`four`, 4 steps, two faults):
1. Member 1 pauses.
2. Member 0, the leader, gets Ctrl-C.
3. The leader promotes learner 3 first: voters {0,1,2,3}. This commits on 0, 2 and 3.
4. Member 0 crashes and loses its disk before it is removed.

Entries up to the promotion are now on 2 of the 4 voters. There are 3 live voters (1, 2 and 3), which equals `copies`, so `cluster.health` reports nothing. Yet the shard has a voter that cannot vouch, and needs all three live members to commit. With per-follower replication this takes one fault.

**Breaks:** "Under-replication is never silent. `cluster.health` and one stderr line say when a shard has fewer live voters than `copies`". The test misses a configuration that holds more voters than `copies`, which a leave and a replacement both create.

**Fix:** report when the live voters are fewer than `copies` **or fewer than the configuration's voters**. `--fix report-dead` removes every case of it.

#### 4. A shard can sit at two voters, though the doc says it should not

Three ways, all found as settled states:
- **(a) A leave from three voters with no learner** (`three`, 2 steps, no fault). Member 1 gets Ctrl-C, and the leave removes it: voters {0,2}. Only two members remain. Healing never lowers and raises only to an odd number, so the shard keeps two voters for good, and either crash stops its writes (stuck class "two voters, one down"). The leave row allows the leave to lower the count. But limit 6 says "So below three candidates a shard has one voter", and the one-voter rule exists because "a shard with two voters could not survive either one's crash".
- **(b) The 1 -> 2 -> 3 growth is cut short** (`one`, 4 steps, one fault). The third member starts, and healing adds it as a learner. Healing promotes the first learner (1 -> 2, "once three candidates are live"). Then the third member crashes, or leaves, before its own promotion. The shard sits at two voters until it returns, or for good if it left. This breaks "passing through two only for the moment of the change".
- **(c) A gone voter is removed, then its replacement leaves** (`three`, 4 steps, one fault). Member 1 loses its disk and restarts as a new replica. Healing removes the old replica, since a replacement candidate exists: member 1's new replica. Then member 1 gets Ctrl-C before it is promoted. This breaks "The shard has two voters only between those steps".

**Fix:** decide which the doc means.
- **Option 1:** two voters are allowed after a leave. Say so in limit 6 and the one-voter rule, and promote 1 -> 2 only when a second caught-up learner is ready to follow at once.
- **Option 2 (my pick):** a shard with two voters, fewer than three live candidates and neither voter leaving steps back to one voter (the leader) and a learner. That is an explicit exception to "never lowers", and it matches the doc's own choice for two machines. The clause "neither voter leaving" is needed. Without it the checker found a loop: a leaving leader's healing promotes the other member as its replacement, and the step back demotes it again, without end.

`--fix two-to-one` results are in "Checking the fixes".

#### 5. §10.2's property, as worded, is broken by healing's own gone-voter step

**Trace** (`four`, 3 steps, one fault):
1. Member 1 crashes, keeping its disk.
2. `evict.after` passes.
3. Healing removes member 1 (a replacement candidate, 3, exists): voters {0,2}, learner 3.

Member 1's disk still holds every committed entry, so the vouching voters holding them drop from 3 to 2. The replacement holds nothing yet: "that replacement is added as a learner in the next step". The doc says "Removing the gone one first costs nothing: it was already not answering". That is true for availability, and P1 holds: the shard is reported under-replicated meanwhile. But it contradicts §10.2's wording.

**Fix:** word §10.2 as "no step reduces the number of **answering** vouching voters ...", or list the exceptions: removing a gone voter as the first half of its replacement, and the two leave steps below.

### Which P2 breaks a leave is allowed

The leave row lets a leave lower the voter count, so two of its steps may break P2. The checker labels each removal:

| Step | P2 | The doc |
|---|---|---|
| `leave-leaver-no-replacement`: the leaver is removed when no caught-up learner was there to promote | breaks it | admitted: "Only a leave (below) or an operator does" lower a voter count |
| `leave-dead`: a dead voter is removed first, by the probe rule | breaks it (the dead voter may keep its disk) | admitted: "Dead voters are removed first, when that is what lets the leave carry (as V4-60)", and the reviewer's "availability over copies" |
| `leave-leaver-after-promote`: the leaver is removed after a promotion, but the replacement lacks a committed entry | breaks it | **not admitted**: finding 1 |

Healing steps break P2 only by the gone-voter removal (finding 5).

### Stuck states, and whether the doc admits them

No stuck state had a live majority in any run, so P5 holds. Every stuck state lacks a majority of live voters. "Until a member returns" means returns and heals fix it. "Permanent" means they do not: the members needed left for good, or lost their disks.

| Class | Example (shortest) | Doc admits it? |
|---|---|---|
| one voter, down | `one`: the only voter crashes | Yes: example 01, "the other is read-only until it returns". Permanent only if its disk is lost: `fero recover --unclean`. |
| two voters, one down | `three`: a leave leaves {0,2}, then 0 crashes | Yes by limit 6, "two voters cannot survive a crash". But each such shard came from finding 4. |
| a leaver kept as a voter | `three`: 0 loses its disk, 1 gets Ctrl-C and crashes mid-leave. `one`: the only voter is partitioned from its learner and gets Ctrl-C | Yes: "A shard where neither is safe keeps it as a voter, and `destroy()` names it". Read-only until the leaver returns with its dir. |
| voters lost disks | `three`: two members lose their disks | Yes: beyond what a majority survives. `fero recover --unclean`. |
| majority down or cut off | `three`: two members crash | Yes: plain Raft. |

### Mutants

`python3 healing.py --mutants` removes one rule at a time. It runs each mutant and the design on the same smaller bounds:
- `two`: 2 faults, 1 client entry;
- `three-m`: 2 faults;
- `one-m` and `four-m`: 1 fault.

These runs offer every enabled step (`--any-order`), so a mutant's extra choice is never hidden by the step order. A mutant is **caught** when it reaches a violation or a stuck class the design does not reach, or reaches one with fewer faults. `no-draining` loops (healing keeps re-adding the leaver), so its runs stop at 1.5M states. What they found is still real. The whole run takes about 40 minutes.

| Mutant (the rule removed) | Earlier finding | Caught by |
|---|---|---|
| `gone-no-repl`: remove a gone voter with no replacement | E1 | P3-lower: 3 -> 2 voters (3 steps); P4 settles at two |
| `heal-lower`: shrink to the live candidates | E1 | P3-lower; P4; P5: stuck for good **with a live majority** |
| `promote-even`: raise 1 -> 2 with two candidates | F2, R-80 | P3-even (1 step); P4 settles at two |
| `promote-uncaught`: promote a learner before it caught up | etcd's rule | **not caught** |
| `live-remove-lag`: remove a live voter when its replacement is within `lag.max` | H-172, R-72 | P2 (`four-m`, 4 steps) |
| `leave-paused`: a paused voter counts as dead | R-58 | P6 (`three-m`, 3 steps) |
| `leave-no-dead`: never remove dead voters first | S-207, R-77, V4-60 | P5: the stayer is stuck after one crash; the design needs two |
| `leave-no-promote`: remove the leaver without promoting a learner | R-62 | P5: two voters, one down, new in `four-m`; P2 |
| `leave-always-remove`: remove the leaver even when that loses the live majority | | P5: stuck after one crash; the design needs two |
| `no-draining`: no draining mark | D-081, R-64 | P7: healing re-adds the leaver as a learner (6 steps) |
| `learner-no-vote`: learners refuse votes | S-037, R-76 | P5: stuck for good **with a live majority** (see below) |
| `ghost-votes`: a replica that lost its disk votes as its old self | R-54 | P1: two leaders in one term; a leader missing a committed entry; a commit over a committed entry |
| `no-own-term`: change the configuration before committing in the leader's term | Ongaro 2015 | **not caught** |
| `no-config-wait`: append a change before the previous one commits | | P1: all four of its checks |

**12 of 14 caught.** The two misses are honest limits of this model:
- **`promote-uncaught`.** A learner's catch-up takes no time here. The rule exists so that a far-behind voter (loading gigabytes) cannot stall commits, so it needs time in the model.
- **`no-own-term`.** Ongaro's counterexample needs two changes in different terms whose majorities do not overlap: one adds a member and one removes one, from four. That needs five members. With three or four, any two single-change majorities overlap.

The `learner-no-vote` catch is R-76 exactly (`one-m`, 4 steps):
1. The third member starts.
2. Learner 1 pauses.
3. The leader, 0, promotes 1 (voters {0,1}). The entry reaches no one.
4. The leader steps down (CheckQuorum).

Now 0 needs 1's vote. 1 is still a learner in its own log, so it never votes, and nobody else can stand. The design survives this, because learners answer vote requests by the log rule.

### Checking the fixes

The same six scenarios, with the fixes applied:

| | `two` | `three` | `one` | `four` | `four-2leave` | `four-arrive` |
|---|---|---|---|---|---|---|
| fix A: `leave-exact`, `gone-surplus`, `report-dead` | all hold | P2 (admitted), P4-settle2 | P2 (admitted), P4-settle2 | P2 (admitted, and heal-gone), P4-settle2 | the same as `four` | the same as `four` |
| fix A + `two-to-one` (4-member runs with 1 fault) | all hold | P2 (admitted), P2 and P3-lower at the demotion | the same | the same, and heal-gone | not run | the same as `four` |

- **Fix A** removes findings 1, 2 and 3 everywhere: no leave-after-promote P2, no settle at four, no silent under-replication. It adds no stuck class with a live majority (P5 holds) and nothing new elsewhere. `four` with fix A: 5,428,352 states, 1055 s.
- Two things in the fixes themselves had to be got right, and the checker showed both:
  - `leave-exact` must also refuse a replacement that has since lost its disk. Its member's new replica can hold the full log, but the promoted voter cannot vouch.
  - The leave must wait, within `leave.ms`, for a live replacement to catch up, rather than give up at once.
- **Adding `two-to-one`** removes every settle at two. The remaining violations are the demotion itself, flagged as P3-lower and P2. That is the trade: an acknowledged write is on one disk until the learner has it, as in example 01. Two-to-one makes `three` 1.2M states and `one` 1.1M. The 4-member runs used one fault, which is enough for every settle at two.

## Reductions, and how they were checked

To keep four members and two faults within minutes, the default model makes three choices. The stricter forms remain as flags.
1. **Append-and-send** (default) vs `--fine`. A new entry reaches every reachable, responsive member of the leader's configuration in the same step, and a separate step catches up members that return. A follower lags only through a fault (crash, partition, pause), which is how the task frames a slow member. `--fine` sends to one follower per step.
2. **Doc order** (default) vs `--any-order`. Healing takes its next step in the doc's order, the leave its own next step, and the two interleave freely. `--any-order` offers every enabled step.
3. **Urgent exit.** A leaver exits in the same step as its leader's decision. A leave is bounded by `leave.ms`, which is short against everything else here.

**Cross-check.** `three` (one client entry) and `four` were run at one fault in all four combinations of the first two flags:

| | default | `--fine` | `--any-order` | both |
|---|---|---|---|---|
| `three` | 7,793 | 45,327 | 9,436 | 68,876 |
| `four` | 13,912 | 419,588 | 17,575 | 611,224 |

The finer models found no class that the default run misses at two faults. They reach some classes with one fault fewer:
- `--fine` reaches findings 1 and 3, the leave's dead-voter removal, and a "leaver kept" stuck state. That stuck state is finding 4 again: the change to two voters is still uncommitted when one of them crashes.
- `--any-order` reaches finding 2 by the 3 -> 4 -> 3 replacement.

## Model errors found and fixed along the way

Each of these first showed as a property failure. In each case the model was wrong, not the design:
- A partitioned leader removed the other voter as dead. CheckQuorum would have stepped it down first, so the quorum guard was added.
- P2's promote-then-remove pairing ignored a learner-only change in between.
- A restarted one-voter leaver could not stand for election. The doc does not bar it.
- The stuck search waited for every leave to end. A leave is bounded, so the target is now a leader with a majority of non-leaving voters.
- The one-voter target followed rank, not the incumbent.
- A leader could not remove itself. Raft allows it, and the leader then steps down.
- Gone marks and liveness were read from a fixed side of a partition, not relative to the leader's side.
- A leaving leader exited while a voter one entry behind, or paused, could still take its hand-over.
- Steps by a stale leader that lacked a committed entry were judged, though they can never commit.
- A partitioned voter counted as live for the under-replication report.

## What the abstraction leaves out

- **One shard.** No `#meta` (the draining mark is always written; the `no-draining` mutant covers a leave without it), no planner hints other than `gone`, no planner `place` targets, and no slot moves.
- **No log replicas or witness, no snapshots, no object store.** "Caught up" is one entry (`lag.max`). There is no time to catch up, so `catchup.max` and the etcd caught-up rule cannot matter here.
- **Time is only ordering.** `election.ms` < `leave.ms` < `evict.after`, with no clocks, `settle.ms` hand-backs, preferred-leader moves or `skew.max`.
- **Messages are steps, not packets.** There is no loss, reordering or duplication beyond what crashes, partitions and pauses create. Elections, PreVote and CheckQuorum are atomic guards. There is no read index and no quiet shards.
- **Disks fail only at a crash.** No torn tails, no damage mid-log, no lying disks, no `durability: 'memory'`.
- **Leavers never return,** and a crash during a leave is final. A `restart` under a supervisor is a plain crash and return.
- **Bounds:** 2 to 4 members, 1 or 2 faults, 1 or 2 leaves, 0 or 1 client entries, terms at most 5.
