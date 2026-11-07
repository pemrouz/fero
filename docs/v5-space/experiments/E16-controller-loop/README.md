# E-16: one controller loop on `#meta`'s leader, against healing by every group's leader

**Question (Q-16).** Is one controller loop on `#meta`'s leader (C `cent-co`: MIN, RUST, LEAN and the rest of MIN's family) smaller and safer than healing by every group's leader (C `self` and `self+p`: DRAFT, CELL, LANE, SPLIT)?

**Threshold.** `cent-co` needs fewer rules, has no stuck state with a live majority, and its wait while `#meta` is down is only a stated delay → MIN's choice stands. A new stuck state, or more rules → per-leader healing wins this axis.

IN-SHORT-PENDING

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
- **`cent-co`** (6 actions): the controller's `c_add`, `c_promote`, `c_remove`, `c_surplus`, `c_dropl` read gone marks from `#meta`'s side and **any config the group has committed** (a report can be late), and each writes a command into `#meta`'s log; `exec`, on the group's leader, runs a command when the leader works, no change is pending, **the epoch matches**, and the checks only the leader can make hold (the learner holds the commit offset; the voters left answer and hold it). The controller runs only while `#meta` has a leader, and a command reaches the group's leader only over a link to `#meta`'s side (topology, not rules).

### RLOG's case

[models/rlog.py](models/rlog.py): the group's log is kept by log members; a server is the writer by holding a writer epoch committed in that log; the controller hands the role over when the writer is gone to it; the log group's leader checks the writer epoch on every append. Two servers, crashes, a server cut off from `#meta` while it still reaches the log members, `#meta` down.

### Properties (healing.py's, as far as this world has them)

| Id | Property |
|---|---|
| P2 | At the commit of a removal, the answering voters that hold the commit offset do not drop below three when they were three or more (healing.py round 2's P2: no step lowers them unless a replacement already holds the offset). |
| P3 | Healing keeps three voters, or four between a swap's two steps. |
| P5 | AG EF: from every state with a live majority, a leader commits (no stuck state with a live majority). |
| P8 | AG EF, "healing finishes": from every state with a live majority (for `cent-co`, and `#meta` up), calm steps reach a working leader with an odd number of voters and no voter its side cannot reach while a live member is free to replace it. This folds in healing.py's P4 (never settle at two or four) and P8. |
| P9 | No more than 8 config changes without an outside event (no churn). |
| WAIT | Reported, not a property: states with a live majority and `#meta` down from which healing cannot finish while `#meta` stays down. |
| RL1, RL2, RL3 | RLOG: one writer (every committed write carries the epoch of the latest writer entry before it); no stale judgement (every write was judged on the whole log before it); AG EF a write can commit while `#meta` and a server are up. |

### Bounds

| Bound | Members | Start | Faults |
|---|---|---|---|
| `three1` | 4 | voters 0, 1, 2; member 3 spare | 1 of any kind |
| `four1` | 4 | voters 0, 1, 2; learner 3 (healing.py's `four`) | 1 |
| `meta1` | 4 | voters 0, 1, 2; spare 3; `#meta` down from the start | 1 member fault |
| `three2` | 4 | voters 0, 1, 2; spare 3 | 2 of any kind |

RESULTS-PENDING
