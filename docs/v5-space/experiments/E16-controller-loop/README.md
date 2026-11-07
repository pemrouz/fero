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
- **`cent-co`** (7 actions): the controller's `c_add`, `c_promote`, `c_remove`, `c_surplus`, `c_dropl` read gone marks from `#meta`'s side and the group's committed config (as the group reports it), issue at most one command per config epoch (PD's one operator per region), and write it into `#meta`'s list of live commands; `c_expire` is PD's operator timeout: a command the group would not run now leaves the list, so the controller can decide again; `exec`, on the group's leader, runs a command when the leader works, no change is pending, **the epoch matches**, and the checks only the leader can make hold (the learner holds the commit offset; the voters left answer and hold it; a replica to remove is gone **to the leader's own links**), then marks it done. The controller runs only while `#meta` has a leader, and a command reaches the group's leader only over a link to `#meta`'s side (topology, not rules). A late report needs no state of its own: a command decided at epoch e that runs late, or is refused by the epoch check, is what a late report leads to.

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
| `two-a` | 4 | voters 0, 1, 2; spare 3 | 2 among crash, lost disk, `#meta` down (the ablation's verify bound) |
| `two-b` | 4 | the same | 2 among crash, member cut, `#meta`'s leader cut |
| `two-c` | 4 | the same | 2 among member cut and `#meta`'s leader cut |
| `three2` | 4 | the same | 2 of any kind |

The ablation sweeps the one-fault bounds and verifies on `two-a` (E-17's SWEEP and VERIFY).

## Results

Machine: 4 vCPU, 15 GB, shared with other agents; Python 3.13, standard library ([results/versions.txt](results/versions.txt)). Raw output: [results/design-self.txt](results/design-self.txt), [results/design-cent-co.txt](results/design-cent-co.txt), [results/design-rlog.txt](results/design-rlog.txt), [results/design-extra.txt](results/design-extra.txt); the ablations in `results/*-ablation.json` and [results/summary.md](results/summary.md). All model-checked here.

### 1. Both options are safe and live at these bounds

| Bound | `self`: states | `cent-co`: states | P2, P3, P9 | P5: stuck with a live majority | P8: healing cannot finish |
|---|---|---|---|---|---|
| `three1` | 1,917 | 9,885 | hold in both | 0 of 1,345 / 0 of 6,777 | 0 / 0 |
| `four1` | 1,553 | 4,752 | hold in both | 0 / 0 | 0 / 0 |
| `meta1` | 3,978 | 10,282 | hold in both | 0 / 0 | 0 / 0 |
| `two-a` | 15,534 | 347,262 | hold in both | 0 of 8,801 / 0 of 236,582 | 0 / 0 |
EXTRA-ROWS

`cent-co` has 3 to 22 times the states of `self` at the same bounds: its commands are state of their own (decided, live, timed out, done), on top of the group's.

### 2. Where `self` heals and `cent-co` waits

WAIT counts the states with a live majority while `#meta` is down or cut off from that majority, from which healing cannot finish until `#meta` returns:

| Bound | `self` | `cent-co` |
|---|---|---|
| `meta1` (`#meta` down from the start, one member fault) | 0 of 1,327 | **210 of 415** |
| `two-a` | 0 of 277 | **234 of 1,058** |
WAIT-EXTRA

For example (`meta1`): `#meta` has no majority; voter 1 crashes; `evict.after` passes. `self`'s leader adds spare 3, lets it catch up, promotes it and removes 1. `cent-co` has no controller, so the group stays at two live voters of three until `#meta` returns; one more crash then stops its writes. Once `#meta` is back, healing finishes in every state (P8 holds with `#meta` up), so the wait is a delay, not a stuck state. Its length is the `#meta` outage.

### 3. What the model found on the way (each a rule the design needs)

- **`cent-co` must re-check "gone" on the group's own links before a removal.** The first `cent-co` model ran a removal whenever the epoch matched, and the search found (P2, 15 steps, in that earlier version; the ablation below shows the same rule needed in the final one): voter 1 crashes and is replaced by a swap (4 voters); `#meta`'s leader is cut off from the group's side, so to it voter 0 looks gone; it decides "remove 0" at the current epoch; the cut heals; the group's leader runs the command, since the epoch still matches, and removes voter 0, which is up, while voter 1 is still down: two answering voters hold the commit offset where there were three. The epoch check protects against a changed config, not against a changed view of who is alive. The fix is DESIGN-V5's own planner rule ("a leader whose link to that life is up ignores it"), here `exec.gone`.
- **`cent-co` needs an operator lifecycle.** With one command per epoch (PD's one operator per region) and no timeout, a command the group refuses (the voter came back) blocks the controller for that epoch for ever (P8, 13 steps, in an earlier version: the group sits at four voters). PD cancels such operators on a timeout; here `c_expire`.
- **A surplus removal must wait until the voters left answer**, not only hold the commit offset (P2, 12 steps, in both options): a voter that crashed but was not yet evicted still "holds" the offset on its disk.
- **A member back with a new disk must be addable as a new replica while its old replica is still a voter** (P8, 3 steps, in both options, in an earlier version that compared members, not replicas): the leader loses its disk, a spare crashes, the old leader comes back empty; the only live candidate is the old leader's new replica, and "not already in the config" must mean that replica, as DESIGN-V5 4.1 says ("adds it back as a learner and removes the old one"). Counting a learner as a candidate in P8 is what exposed it: an earlier P8 counted only members outside the config, and a model that added everyone as a learner and never promoted passed it.
- **A second fault during a swap can stop writes, in both options (SWAP).** On commit (E-14), a promotion from three voters to four commits on the old majority; if the new voter (or another) then fails, the four-voter config has two of four down, and no leader can commit until one returns: `two-a` has 120 such states for `self` and 624 for `cent-co` (`three2`: 3,024 for `self`). healing.py did not judge these (on append, the four-voter config is in force at once, and it has no live majority). E-14b found the same window when growing from two voters to three. Joint consensus (CockroachDB's atomic replication changes) would not have it (reasoned). It is the same for both options, so it does not decide this axis; it is a stated limit of single-step swaps.

ABLATION-PENDING

## What the model leaves out

- **`#meta` is abstract here**: up or down, and the side its leader is on. In `cent-co`, `#meta` heals itself through the same loop (its leader is the controller and the group's leader at once, so the epoch check is trivial there), and in `self` it heals itself like any group; so the two options are equal on `#meta`'s own healing (reasoned). Its own majority loss is any group's majority loss: F-12.
- **No leave (Ctrl-C), pause, planner hints, retiring or draining**, which healing.py round 2 had. A leave is where the options would differ most (reasoned): in `self` the group's leader runs it; in `cent-co` a leave while `#meta` is down cannot carry, so the leaver either waits (a Ctrl-C that hangs) or exits as a crash would.
- **Groups start at three voters**: no growth from one voter, no two-to-one step back (healing.py's `one` and `two`), no log replicas or witnesses.
- **Raft is an abstract group**: elections, commits and catch-up are atomic steps; messages are not modelled one by one. E-14 and E-14b check etcd's Raft itself.
- **Time is only order**: `evict.after` passing is a step, CheckQuorum is a step, the operator timeout is a step that always fires in the end.
- **Bounds**: 4 members, 1 or 2 faults, one data group. `cent-co` on `two-b`, `two-c` and `three2` did not finish within 900,000 states (memory); safety held in every state explored.
