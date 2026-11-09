# E-16: one controller loop on `#meta`'s leader, against healing by every group's leader

**Question (Q-16).** Is one controller loop on `#meta`'s leader (C `cent-co`: MIN, RUST, LEAN and the rest of MIN's family) smaller and safer than healing by every group's leader (C `self` and `self+p`: DRAFT, CELL, LANE, SPLIT)?

**Threshold.** `cent-co` needs fewer rules, has no stuck state with a live majority, and its wait while `#meta` is down is only a stated delay → MIN's choice stands. A new stuck state, or more rules → per-leader healing wins this axis.

**In short.**
- **Both options are safe and live at every bound checked** (4 members, up to two faults of any kind; `self` up to 296,018 states, `cent-co` up to 713,550): no broken safety property, no stuck state with a live majority, and healing always finishes once faults stop (with `#meta` up, for `cent-co`). Model-checked here.
- **But `cent-co` as first written had a new stuck state with a live majority** (two faults, 8 steps, 92 states): a promotion decided before the learner died stays runnable, so it never times out, and it blocks every other decision. One more check at the group's leader (`exec.live`) fixes it. `self` never had it: it decides and acts in one step on its own links.
- **Each controller decision must be checked again where it runs**: the epoch (the config changed), the leader's own links for a removal (`exec.gone`, P2 in 14 steps without it) and for a promotion (`exec.live`), and the offsets only the leader knows. Plus a timeout that `self` does not need: a command the group refuses must leave, or the controller is blocked (the ablation shows "one command per epoch" and "done" are not needed once the epoch check and the timeout are there).
- **`cent-co` waits while `#meta` is down**: with a member fault as well, 24% to 62% of the judged states cannot finish healing until `#meta` returns (`self`: none). It is a delay, not a stuck state.
- **Rules (DEV-10, same world, same procedure): `self` 14, `cent-co` 18** (16 of them with a counterexample; distinct checks 13 against 17). `cent-co` keeps `self`'s healing rules in the controller and adds 4 for the distance between decider and executor: the epoch check, two re-checks of who is alive, and the timeout. Mutants caught: 16 of 17 against 12 of 21 (`cent-co`: none survived, 9 undecided because its mutated models outgrow the explorer). RLOG's writer handover adds 9 rules, all needed, including the one more guard on every append.
- **By the threshold, per-leader healing wins this axis**: `cent-co` had a new stuck state, needs more rules, and waits while `#meta` is down. The rows that take `cent-co` (MIN and its family, RUST, SRV, LEAN, RLOG) should take `self` instead, or keep `cent-co` and pay its 4 extra rules and the wait.

## Words used here

- **Healing**: changing a group's replicas so it keeps three voters on live members: add a replacement as a learner, let it catch up, promote it, remove the gone voter (a **swap**), and remove a surplus voter if the gone one comes back.
- A **voter** counts toward commits and elections; a **learner** copies the log and does not. A **replica** is a member plus its disk incarnation: a member back without its disk is a new replica.
- **Gone**: a member whose link has been down past `evict.after`, as seen from one side of a partition. A link that is up is seen at once.
- **`self`**: each group's leader runs the healing rules from its own links (DESIGN-V5 4.2).
- **`cent-co`**: one loop on `#meta`'s leader decides every change from its own links and the group's reported config, and writes each decision into `#meta`'s log as a **command** naming the group's config **epoch** (the number of config changes committed so far). The group's leader runs a command only if its committed config still has that epoch. This is TiKV PD's region epoch and KRaft's combined controller.
- **Live majority**: a majority of the group's committed voters are up, with their disks, on one side of the network.
- **Stuck**: from this state, with no more faults and no recoveries, no path reaches the goal.
- **AG EF**: "from every reachable state, the goal can still be reached", the stuck search of healing.py and E-14.
- **DEV-10**: a **rule** is one guard conjunct or one state update; it counts only if removing it lets the checker find a counterexample (ablation). **Mutants** are made by script: drop each guard, drop each update, flip each comparison, swap each pair of updates in one action.

## Method

### The shared harness

E-17 built the study's shared harness for models that compare options ([../E17-partitioning/HARNESS.md](../E17-partitioning/HARNESS.md)). This experiment uses its **rule language unchanged**: [engine/engine.py](engine/engine.py) imports `../E17-partitioning/harness/dsl.py` (`Action`, `Guard`, `Cmp`, `Update`, `Mutation`), so a rule and a mutant mean what they mean in E-17. The **ablation and the mutants** follow E-17's `runner.py` step by step: pass 1 (drop each rule alone), greedy drops in model-text order, a final pass that proves the set left is 1-minimal, a verify bound, then the mutants of the smallest model, with a mutant judged equivalent when the reachable state set is the same (count, edges, digest).

What is **not** shared: E-17's world (`harness/world.py`) is a world of partitions that move between abstract groups. Healing is about members, disks, links and a controller, which that world has no notion of. So, as the task allowed ("otherwise port healing.py minimally"), this experiment brings its own world, ported from [healing.py](../../v5-spec/healing.py) in a smaller form, and a small explorer with the same AG EF check. E-33 uses the same engine. Rule counts here are compared only with each other.

### The world (shared by both options; not counted)

[models/heal.py](models/heal.py):
- **Members** 0 to N-1: up or down, a disk incarnation, a side (0 or 1; links join members on one side). **`#meta`**: up (it has a majority) or not, and the side its leader is on.
- **One data group**, Raft as an abstract group with on-commit membership (E-14's verdict): a committed config (voters, learners, epoch, the voter last promoted), at most one uncommitted entry (etcd's one change at a time), a leader, the replicas that hold every committed entry, and those that hold the uncommitted entry. Elections (a candidate must hold every committed entry, and voters that hold the uncommitted entry refuse one that does not), commits (a majority of the committed voters), catch-up and CheckQuorum are world steps. A new leader first commits an entry of its own term.
- **Gone marks** per side, set by time passing while a link is down, cleared when the link comes back.
- **Faults** (a budget): a crash (disk kept), a lost disk, a member cut off to side 1, `#meta` losing its majority, `#meta`'s leader cut off to side 1. **Recoveries** are free. **Calm steps** for liveness: protocol steps and time passing; no faults and no recoveries.

### The two options (counted)

- **`self`** (5 actions): `add` a live member as a learner when a voter is gone; `promote` a caught-up learner from three voters to four; `remove` a gone voter from four; `surplus`: remove the voter ranked last from four when none is gone, once the voters left answer and hold the commit offset; `dropl`: drop a gone learner. Each is guarded by "the leader works" and "no change pending" (Raft's own rules, role `raft`) and reads gone marks from the leader's side.
- **`cent-co`** (7 actions): the controller's `c_add`, `c_promote`, `c_remove`, `c_surplus`, `c_dropl` read gone marks from `#meta`'s side and the group's committed config (as the group reports it), issue at most one command per config epoch (PD's one operator per region), and write it into `#meta`'s list of live commands; `c_expire` is PD's operator timeout: a command the group would not run now leaves the list, so the controller can decide again; `exec`, on the group's leader, runs a command when the leader works, no change is pending, **the epoch matches**, and the checks only the leader can make hold (the learner holds the commit offset; the voters left answer and hold it; a replica to remove is gone **to the leader's own links**; a learner to promote is not gone to them, `exec.live`, added after the search below found the stuck state without it), then marks it done. The controller runs only while `#meta` has a leader, and a command reaches the group's leader only over a link to `#meta`'s side (topology, not rules). A late report needs no state of its own: a command decided at epoch e that runs late, or is refused by the epoch check, is what a late report leads to.

### RLOG's case

[models/rlog.py](models/rlog.py): the group's log is kept by log members; a server is the writer by holding a writer epoch committed in that log; the controller hands the role over when the writer is gone to it; the log group's leader checks the writer epoch on every append. Two servers, crashes, a server cut off from `#meta` while it still reaches the log members, `#meta` down.

### Properties (healing.py's, as far as this world has them)

| Id | Property |
|---|---|
| P2 | At the commit of a removal, the answering voters that hold the commit offset do not drop below three when they were three or more (healing.py round 2's P2: no step lowers them unless a replacement already holds the offset). |
| P3 | Healing keeps three voters, or four between a swap's two steps. |
| P5 | AG EF: from every state with a live majority, a leader commits (no stuck state with a live majority). |
| P8 | AG EF, "healing finishes": from every state with a live majority (for `cent-co`, and `#meta` up on that majority's side), calm steps reach a working leader with an odd number of voters and no voter its side cannot reach while a live member that is not a voter (a learner counts) could replace it. This folds in healing.py's P4 (never settle at two or four) and P8. |
| P9 | No more than 8 config changes without an outside event (no churn). |
| WAIT | Reported, not a property: states with a live majority and `#meta` down from which healing cannot finish while `#meta` stays down. |
| RL1, RL2, RL3 | RLOG: one writer (every committed write carries the epoch of the latest writer entry before it); no stale judgement (every write was judged on the whole log before it); AG EF a write can commit while `#meta` and a server are up. |

### Bounds

| Bound | Members | Start | Faults |
|---|---|---|---|
| `three1` | 4 | voters 0, 1, 2; member 3 spare | 1 of any kind |
| `four1` | 4 | voters 0, 1, 2; learner 3 (healing.py's `four`) | 1 |
| `meta1` | 4 | voters 0, 1, 2; spare 3; `#meta` down from the start | 1 member fault |
| `two-a` | 4 | voters 0, 1, 2; spare 3 | 2 among crash, lost disk, `#meta` down |
| `two-b` | 4 | the same | 2 among crash, member cut, `#meta`'s leader cut |
| `two-c` | 4 | the same | 2 among member cut and `#meta`'s leader cut |
| `three2` | 4 | the same | 2 of any kind (the ablation's verify bound) |

### The ablation (DEV-10), and four things added to E-17's procedure

The ablation sweeps the one-fault bounds and verifies on `three2`, two faults of any kind (E-17's SWEEP and VERIFY). Four additions, each forced by what the runs showed, and each applied to both options alike (the last two touch only `cent-co`, the only option with commands):

1. **A verify pass 1.** With one fault the sweep drops rules that only two faults need. The first self ablation kept 9 rules, and that model broke P9 on `two-a` in 29 steps: `surplus` "removed" a learner left over from a lost disk as if it were a voter, a no-op config change repeated without end (`surplus.voter` is the rule). E-17's put-back (try each dropped rule, last dropped first, on the verify bound) runs models with many rules dropped, which are millions of states with deep counterexamples: hours per try. So before it, each rule the sweep dropped is checked alone on the verify bound (the design without that one rule, near the design's size) and put back if a property breaks, as pass 1 keeps a rule that is necessary alone on the sweep. E-17's put-back then runs only if the result still fails, and afterwards the final pass (prove the set 1-minimal) runs again on the sweep and the verify bound together, so a rule put back that the rest no longer needs is dropped again (`self`: 3 of its 8 put back, among them the guards of the "drop a gone learner" action, whose update the ablation had dropped). (`VERIFY_PASS1` in [models/heal.py](models/heal.py); off for E-33.)
2. **A state limit on the verify bound for both options:** 2,000,000 states (the sweep keeps E-16's 900,000). Both designs finish `three2` (296,018 and 713,550 states); a model with rules dropped can pass the limit, and is then undecided, as E-17 counts it. On the verify bound a run stops at its first failure (the decisions read only whether a run fails).
3. **A state reduction for `cent-co`.** A command names the epoch it was decided at. After a config change commits, every command of the old epoch can never run (the epoch check) and never blocks a decision (the "one command per epoch" check reads the current epoch). Before, such commands stayed until the timeout removed them, and their mix multiplied the states. Now the commit clears them. It is the same set of behaviours: nothing reads them, and the timeout could fire at that moment anyway. A run whose mutant drops the epoch check keeps them, since there they could still run (`CentCo.mutated`). It is not a rule and is never dropped or mutated.

4. **The timeout reads the exec guards as the run has them.** `c_expire` lets a command go when "the group would not run it now". At first it tested the design's exec guards even in a run whose mutant dropped one, so the timeout applied the dropped check and hid the mutant: the run without `exec.live` passed, while the model written before `exec.live` existed broke P8. Now both tests read the same, mutated guards, and the two runs agree (92 stuck states). Cached ablation runs that mutate an exec guard were discarded and run again.

RLOG's model pins two bounds (a write attempt counts toward the bound whether or not it lands; at most five writer epochs), so a dropped rule cannot make a counter grow without end.

## Results

Machine: 4 vCPU, 15 GB, shared with other agents; Python 3.13, standard library ([results/versions.txt](results/versions.txt)). Raw output: [results/design-self.txt](results/design-self.txt), [results/design-cent-co.txt](results/design-cent-co.txt), [results/design-rlog.txt](results/design-rlog.txt), [results/design-extra.txt](results/design-extra.txt); the probes in [results/verify-probes.txt](results/verify-probes.txt) (and, before the stale-command reduction, [results/verify-probes-unreduced.txt](results/verify-probes-unreduced.txt)); `cent-co` without `exec.live` in [results/cent-co-without-live.txt](results/cent-co-without-live.txt) and [results/cent-co-before-live.txt](results/cent-co-before-live.txt); the ablations in `results/*-ablation.json`, their logs in `results/*-ablation.log`, and [results/summary.md](results/summary.md). All model-checked here, from 2026-11-08 to 2026-11-09, on a box shared with other agents' runs (every run under the study's heavy lock).

### 1. Both options are safe and live at every bound

P5 and P8 give "states that cannot reach the goal" of the states judged (`self` / `cent-co`). `cent-co` is the model with the stale-command reduction and `exec.live` (Method, and section 3).

| Bound | `self`: states | `cent-co`: states | P2, P3, P9 | P5: stuck with a live majority | P8: healing cannot finish |
|---|---|---|---|---|---|
| `three1` | 2,213 | 4,315 | hold in both | 0 of 1,473 / 0 of 2,547 | 0 of 1,473 / 0 of 2,530 |
| `four1` | 1,673 | 3,193 | hold in both | 0 of 1,282 / 0 of 2,249 | 0 of 1,282 / 0 of 2,210 |
| `meta1` | 4,762 | 4,712 | hold in both | 0 of 3,162 / 0 of 2,944 | 0 of 3,162 / 0 of 2,529 |
| `two-a` | 33,939 | 86,875 | hold in both | 0 of 16,163 / 0 of 35,767 | 0 of 16,163 / 0 of 35,182 |
| `two-b` | 99,802 | 210,998 | hold in both | 0 of 62,676 / 0 of 126,321 | 0 of 62,676 / 0 of 118,038 |
| `two-c` | 58,570 | 122,582 | hold in both | 0 of 38,701 / 0 of 78,165 | 0 of 38,701 / 0 of 71,574 |
| `three2` | 296,018 | 713,550 | hold in both | 0 of 160,194 / 0 of 348,388 | 0 of 160,194 / 0 of 327,807 |

`cent-co` has about as many states as `self` with one fault and 2 to 2.6 times as many with two: its commands are state of their own. Before the stale-command reduction it had 4 to 10 times as many with one fault and did not finish any two-fault bound on this box (over 4,000,000 states on `two-a`, 4.1 GB: [results/verify-probes-unreduced.txt](results/verify-probes-unreduced.txt)). Raw output: [results/design-self.txt](results/design-self.txt), [results/design-cent-co.txt](results/design-cent-co.txt), [results/design-extra.txt](results/design-extra.txt).

### 2. Where `self` heals and `cent-co` waits

WAIT counts the states with a live majority while `#meta` is down or cut off from that majority (judged), from which healing cannot finish until `#meta` returns:

| Bound | `self` | `cent-co` |
|---|---|---|
| `meta1` (`#meta` down from the start, one member fault) | 0 of 1,455 | **210 of 415** |
| `three1`, `four1` (`#meta` may fail as the one fault) | 0 of 17 / 0 of 17 | 0 of 17 / 0 of 39 |
| `two-a` | 0 of 513 | **360 of 585** |
| `two-b` | 0 of 4,402 | **3,135 of 8,283** |
| `two-c` | 0 of 3,346 | **1,603 of 6,591** |
| `three2` | 0 of 11,838 | **12,593 of 20,581** |

In `three1` and `four1` the one fault is `#meta` itself, so no member is gone and nothing needs healing while it is down. Once a member fault joins a `#meta` fault, `cent-co` cannot finish healing in 24% to 62% of those states until `#meta` returns; `self` always can.

For example (`meta1`): `#meta` has no majority; voter 1 crashes; `evict.after` passes. `self`'s leader adds spare 3, lets it catch up, promotes it and removes 1. `cent-co` has no controller, so the group stays at two live voters of three until `#meta` returns; one more crash then stops its writes. Once `#meta` is back, healing finishes in every state (P8 holds with `#meta` up), so the wait is a delay, not a stuck state. Its length is the `#meta` outage.

### 3. What the model found on the way (each a rule the design needs)

- **`cent-co` must re-check "gone" on the group's own links before a removal.** The first `cent-co` model ran a removal whenever the epoch matched, and the search found (P2; 14 steps on `two-b` in the final model with `exec.gone` dropped, [results/verify-probes.txt](results/verify-probes.txt)): voter 1 crashes and is replaced by a swap (4 voters); `#meta`'s leader is cut off from the group's side, so to it voter 0 looks gone; it decides "remove 0" at the current epoch; the cut heals; the group's leader runs the command, since the epoch still matches, and removes voter 0, which is up, while voter 1 is still down: two answering voters hold the commit offset where there were three. The epoch check protects against a changed config, not against a changed view of who is alive. The fix is DESIGN-V5's own planner rule ("a leader whose link to that life is up ignores it"), here `exec.gone`.
- **`cent-co` must also re-check, at the group's leader, that a learner it promotes is alive: without that, `cent-co` as first written had a stuck state with a live majority** (P8 on `two-a`: 92 of 35,182 judged states cannot finish healing; 8 steps; [results/cent-co-before-live.txt](results/cent-co-before-live.txt)). Member 1 loses its disk and comes back as a new replica; the controller adds the new replica as a learner, it catches up, and the controller decides "promote it" at epoch 1; then member 1 crashes. The command stays runnable (the epoch matches, and the learner still holds the log on its kept disk), so it never times out (only a command the group would not run times out), and it blocks every other decision (one command per epoch). The only path left runs the promotion, which leaves four voters with two down: no majority, ever. `self` decides and acts in one step on its own links, so it can wait for the eviction and not promote. The fix is one more check at the group's leader (`exec.live`). It is the same lesson as `exec.gone`: every check the controller makes on its view of who is alive must be made again where the command runs, because the view may be stale by then. Before the stale-command reduction (Method) no two-fault run of `cent-co` finished, so liveness was never judged there and this state stayed hidden; with it, `two-a` finishes in 86,875 states.
- **`cent-co` needs a timeout for commands.** A command the group refuses (for example, the voter came back) must leave the list, or the controller stays blocked (P8 in 7 to 11 steps without `c_expire.drop`; an earlier version, with one command per epoch and no timeout, sat at four voters for ever). PD cancels such operators on a timeout. The ablation shows the timeout may fire for any command ("only a command the group would not run" is not needed), and that "one command per epoch" and "done" are not needed once the epoch check and the timeout are there.
- **A surplus removal must wait until the voters left answer**, not only hold the commit offset (P2, 12 steps for `cent-co` on `two-a`, 9 for `self`, with the guard dropped): a voter that crashed but was not yet evicted still "holds" the offset on its disk.
- **A member back with a new disk must be addable as a new replica while its old replica is still a voter** (P8, 3 steps, in both options, in an earlier version that compared members, not replicas): the leader loses its disk, a spare crashes, the old leader comes back empty; the only live candidate is the old leader's new replica, and "not already in the config" must mean that replica, as DESIGN-V5 4.1 says ("adds it back as a learner and removes the old one"). Counting a learner as a candidate in P8 is what exposed it: an earlier P8 counted only members outside the config, and a model that added everyone as a learner and never promoted passed it.
- **A second fault during a swap can stop writes, in both options (SWAP).** On commit (E-14), a promotion from three voters to four commits on the old majority; if the new voter (or another) then fails, the four-voter config has two of four down, and no leader can commit until one returns: for `self`, 224 of the 12,317 states with a change pending on `two-a` (608 on `two-b`, 304 on `two-c`, 1,840 of 103,288 on `three2`); for `cent-co`, 812 of 34,903 on `two-a` (1,320 on `two-b`, 576 on `two-c`, 5,740 of 275,989 on `three2`); none with one fault in either. healing.py did not judge these (on append, the four-voter config is in force at once, and it has no live majority). E-14b found the same window when growing from two voters to three. Joint consensus (CockroachDB's atomic replication changes) would not have it (reasoned). It is the same for both options, so it does not decide this axis; it is a stated limit of single-step swaps.

### 4. Rules and mutants (DEV-10)

Full tables, with the property and steps each removal breaks: [results/summary.md](results/summary.md); raw results in `results/*-ablation.json`. Model-checked here.

| | `self` | `cent-co` | RLOG's writer handover (on top of `cent-co`) |
|---|---|---|---|
| Rules written (not pinned) | 34 | 38 | 11 |
| **Rules needed** | **14** (all with a counterexample; `add.new` only alone, undecided in the smallest model) | **18** (16 with a counterexample; `c_add.new` and `c_promote.need` undecided, kept) | **9** (all decided) |
| Distinct checks (one guard repeated in several actions of one actor counted once) | 13 | 17 | 9 |
| Put back by the verify bound (`three2`) | 5 kept of 8 put back | 7 kept of 7 put back (1 more undecided, not put back) | (no verify bound) |
| The smallest model on `three2` | holds, liveness included (1,545,198 states) | no counterexample in 2,000,001 states (the limit): undecided | - |
| Mutants of the smallest model caught | 16 of 17 (94%; 1 undecided) | 12 of 21 (57%): every decided one caught, 9 undecided (the run passes the state limit), none survived | 9 of 9 (2 swaps equivalent) |

**`self`'s 14 rules**, in words (the leader's healing routine, from its own links):
- *add* a replica that is not already in the config (`add.new`, undecided: without it the run passes 900,000 states), as a learner;
- *promote* only a learner, only while a voter is gone, and only from three voters to four;
- *remove* only a voter, only one gone to the leader, and only from four voters;
- *surplus*: from four voters, remove the voter the ring ranks last, only once the voters left answer and hold the commit offset;
- and each action's own append (4).

What the ablation dropped from `self`, and why that is safe here: Raft's own guards (a working leader proposes; one change at a time) do nothing in this world, where an uncommitted change can do no harm (Raft's commit rule; E-14 checks it on etcd's spec); "promote only a caught-up learner" (catch-up is a world step here; etcd itself refuses to promote a learner that is not in sync); "add only a live member" and the whole "drop a gone learner" action (a gone learner left in the config breaks no property: a gap in the properties, the same for both options); and `remove.newok`, `surplus.nogone`, `surplus.voter`, covered by the rules kept.

**`cent-co`'s 18 rules**, in words. The controller's decisions, from its links and the reported config (11): *add* a live member it reaches that is not already in the config (`c_add.cand`, `c_add.new`), and issue the command; *promote* only a learner, only while a voter is gone, only from three voters, and issue; *remove* only a voter, only from four voters, and issue; *surplus* only from four voters, and issue. The group's leader, when it runs a command (6): the command's **epoch** is the current one (`exec.epoch`, P2 in 14 steps); a surplus removal waits until the voters left answer and hold the commit offset; a removal runs only if the replica is gone **to the leader's own links** (`exec.gone`, P2); a promotion only if the learner is not gone to them (`exec.live`, P8); and the append. And the **timeout** (`c_expire.drop`, P8 in 7 to 11 steps: a command the group refuses must leave, or the controller is blocked).

So `cent-co` keeps the healing rules `self` has (the same targets, now in the controller), and adds the rules that exist only because the decider and the executor are apart: the epoch check, the two re-checks of who is alive, and the timeout (4). The ablation dropped "one command per epoch" (all five `.one` guards), "only a stuck command times out" and "done": the epoch check and the timeout already cover them. Two of the 18 (`c_add.new`, `c_promote.need`) have no counterexample at these bounds, only runs that pass the state limit; without them `cent-co` is 16, still above 14.

On DEV-03 (85% of mutants caught by a model that finishes): `self`'s model catches 16 of 17 (94%); `cent-co`'s catches every decided mutant but leaves 9 of 21 undecided, because a mutated controller makes many more states than this Python explorer can hold (it needed the stale-command reduction to finish even the design at two faults). A TLC port with fingerprints on disk would likely decide them (reasoned); here it is a cost of `cent-co`: a bigger model to check.

**RLOG's 9 rules** (the writer role handed over through the group's log, [models/rlog.py](models/rlog.py)): the controller hands over only when the writer is gone to it, and only to a server that is up and linked (RL3, 5 steps each), by committing a writer entry with the next epoch; the named server takes the role only by that entry, takes its epoch, and folds to the log's end before it writes (RL2, 4 steps: without the fold, it judges a write on a log that misses the last writer's writes); **the log group's leader takes an append only with the latest committed writer epoch** (RL1, 1 step: the "one more guard on every append" of Q-16); and the write's own append and fold. `write.holder` (the server believes it holds an epoch) is covered by the epoch check. All 9 non-equivalent mutants are caught.

## What the model leaves out

- **`#meta` is abstract here**: up or down, and the side its leader is on. In `cent-co`, `#meta` heals itself through the same loop (its leader is the controller and the group's leader at once, so the epoch check is trivial there), and in `self` it heals itself like any group; so the two options are equal on `#meta`'s own healing (reasoned). Its own majority loss is any group's majority loss: F-12.
- **No leave (Ctrl-C), pause, planner hints, retiring or draining**, which healing.py round 2 had. A leave is where the options would differ most (reasoned): in `self` the group's leader runs it; in `cent-co` a leave while `#meta` is down cannot carry, so the leaver either waits (a Ctrl-C that hangs) or exits as a crash would.
- **Groups start at three voters**: no growth from one voter, no two-to-one step back (healing.py's `one` and `two`), no log replicas or witnesses.
- **Raft is an abstract group**: elections, commits and catch-up are atomic steps; messages are not modelled one by one. E-14 and E-14b check etcd's Raft itself.
- **Time is only order**: `evict.after` passing is a step, CheckQuorum is a step, the operator timeout is a step that always fires in the end.
- **Properties left out**: healing.py's P1 (Raft's own safety: one leader per term, no committed entry lost) holds by construction here, since elections and commits are atomic steps (E-14 and E-14b check it on etcd's spec); P6 (a leave never removes a paused voter) and P7 (no step adds a retiring member) need leave, pause and retire, which this world does not have.
- **Bounds**: 4 members, 1 or 2 faults, one data group. Both options finish every bound, liveness included; `cent-co` only with the stale-command reduction (without it, over 4,000,000 states on `two-a`). A larger world (five members, three faults, several groups sharing one controller) would grow `cent-co` faster than `self`, since its commands are extra state (reasoned).
- **One data group.** The controller's real job is many groups at once, with a queue and limits on how many changes run together (PD's scheduling limits); that is not modelled, and it would add to `cent-co`, not to `self` (reasoned).
- **No property asks that a gone learner leave the config.** So "drop a gone learner" is not counted for either option (the ablation dropped `dropl` and `c_dropl` alike when it could); a real design needs it to free the member (reasoned).

## Against the threshold

The threshold: "`cent-co` needs fewer rules, has no stuck state with a live majority, and its wait while `#meta` is down is only a stated delay → MIN's choice stands. A new stuck state, or more rules → per-leader healing wins this axis."

- **A new stuck state: yes.** `cent-co` as first written had 92 states with a live majority where healing could never finish (`two-a`, 8 steps; [results/cent-co-without-live.txt](results/cent-co-without-live.txt)). One more rule (`exec.live`) removes it; `self` never had it.
- **More rules: yes.** 18 against 14 (16 against 14 counting only rules with a counterexample; 17 against 13 distinct checks). The 4 extra are the epoch check, the two re-checks of who is alive, and the timeout: each exists because the controller decides on a view that may be stale when the group runs the command.
- **The wait while `#meta` is down is a stated delay: yes.** Healing finishes in every state once `#meta` is back (P8 holds with `#meta` up on every bound), but with a member fault as well, 24% to 62% of the judged states cannot finish until then (`self`: none).
- So, by the threshold, **per-leader healing (`self`) wins axis C** over `cent-co`. `self+p` (the draft's optional planner) was not modelled here: a planner hint that names the config it read is a command checked by epoch, so it would need the same re-checks as `cent-co`'s commands if it can change membership (reasoned).
- What `cent-co` was meant to buy, one place that sees every group (to balance load and place replicas well), is not a healing rule; a planner that only hints, or a balancer that only moves slots, can give it without being on the healing path (reasoned).

## How to rerun

```sh
./run.sh check    # the designs on every bound, the probes, and cent-co without exec.live (minutes)
./run.sh          # then the three ablations and their mutants (resumable 25-minute pieces under the heavy lock)
python3 engine/cli.py models/heal.py cent-co --bound two-a --drop exec.live    # the stuck state, with its trace
python3 engine/report.py results/self-ablation.json results/cent-co-ablation.json results/rlog-ablation.json
```

Q-16: No: one controller loop on `#meta`'s leader is neither smaller nor safer than healing by each group's leader. As first written it had a new stuck state with a live majority (two faults, 8 steps, 92 states: a promotion decided before the learner died stays runnable, never times out and blocks every other decision); it needs 18 rules against 14 (16 with a counterexample: the same healing rules plus an epoch check, two re-checks of who is alive at the group's leader, and a timeout); and with a member fault as well it cannot finish healing in 24% to 62% of the judged states while `#meta` is down (a delay, not a stuck state). Once fixed, both are safe and live at every bound (4 members, up to two faults, model-checked), and RLOG's writer handover adds 9 rules, all needed. Moves: DRAFT, CELL, LANE, SPLIT (`self`, `self+p`) up on DEV-01, DEV-02 and SC-08(e); MIN, RUST, SRV, LEAN, MIN-P, MIN-TS, RLOG, EMB-V8, SIDE (`cent-co`) down on DEV-01, DEV-02 (4 more rules, and commands that interact with each group's config epoch) and SC-08(e) (healing stops while `#meta` is down), unless they switch C to `self`; PD, ISR, SLOG, OBJ (`cent`) carry the same 4 rules (reasoned: PD's region epoch and operator timeout); RLOG +9 rules for the writer handover.
