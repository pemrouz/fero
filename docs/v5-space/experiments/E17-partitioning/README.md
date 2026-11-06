# E-17 (part 1): how many rules each way of mapping partitions onto groups needs

**Question (Q-17).** Measured, not guessed: how complex is each way of mapping partitions onto groups? This is part 1 of 2. It builds the **shared harness** every option is checked on, and checks the first three options on it: **fixN** (a fixed group count), **fixN + re-key** (grow by copying into a new generation; two cursor designs, `rekey` and `rekey-carry`), and **slot moves**. Part 2 (another agent) adds `pslot`, `split` + merge, and lanes + range moves on the same harness ([HARNESS.md](HARNESS.md) tells it how). A third agent re-runs every ablation.

PLACEHOLDER-RESULTS

## Method

**One harness, the same world for every option.** [HARNESS.md](HARNESS.md) has the details. In short:
- **Groups** are abstract Raft groups: a committed log, the leader's uncommitted tail, and the tails earlier leaders lost (one may come back until the next commit, as in Raft). A **crash** is a leader crash: the new leader keeps any prefix of the tail. There is no unclean recovery: a committed entry never goes away.
- **Two partitions,** p and q. **Client attempts** carry an id, a partition and a lock token. A copy of any attempt may reach any group at any time, any number of times: stale routes, retries, duplicates and delay, with no client state.
- **One reader** follows p with a cursor, in some bounds.
- **Group-to-group messages are facts in logs.** A group acts on a report by reading the sender's log. With crash-only faults this loses no behaviour (a late, lost or repeated report is a log read late, never or twice), and it keeps the state small. A guard says "committed only" wherever the design waits for a commit, so the mutant that acts on an uncommitted report exists.
- **The event alphabet** QUESTIONS asks for: crash, restart (both one step here: a new leader from the log), partition (a fact never read; liveness is checked from every state), deliver, tick (a timer: cancel, abort, abandon). Plus control (a scale change starts) and read.

**One property module** ([harness/world.py](harness/world.py)), checked on every state, step and calm path:

| Id | Property | QUESTIONS' words |
|---|---|---|
| P1 | every group that holds a partition open has exactly its history as rows | no acknowledged write lost or doubled |
| P2 | no position names two writes; positions rise along a partition's history | a position never changes meaning |
| P3 | no attempt applied twice; lock tokens never fall; a refused attempt never commits | dedup and fence state survive |
| P4 | what the reader took is a prefix of the history and only grows | a cursor resumes with no gap or overlap |
| P6 | at most one group holds a partition open | one writer per partition |
| L4, L5, L7 | from every state, with no more faults or timers: the reader can catch up; every change under way can end; every attempt can be answered | grow and shrink finish (and nothing else gets stuck) |

**The same bounds for every option** ([harness/bounds.py](harness/bounds.py)). At most 2 leader crashes a run, at most 1 per group (2 in `deep`):

| Bound | Change | Attempts (partition, token) | Reader | Used for |
|---|---|---|---|---|
| `grow` | p's load moves to a second group | w1 (p, 1), w2 (p, 2) | no | sweep |
| `shrink` | p's load comes back to the first group | w1 (p, 1), w2 (p, 2) | no | sweep |
| `both` | grow | w1 (p, 1), w3 (q, 1) | no | sweep |
| `read` | grow | w1 (p, 1), w2 (p, 1) | yes | sweep |
| `deep` | grow, 2 crashes in one group allowed | w1 (p, 1), w2 (p, 2) | no | sweep |
| `twice` | grow, then shrink back; no crash | w1 (p, 1) | yes | sweep |
| `twice1` | grow, then shrink back; 1 crash | w1 (p, 1) | no | verify only (1.3 million states for re-key) |

**Rules counted by ablation, mutants made by script** ([harness/runner.py](harness/runner.py)), as REQUIREMENTS DEV-10 says. Each option is written in a small rule language ([harness/dsl.py](harness/dsl.py)): an action is guard conjuncts and state updates, one field per update. Then:
1. The model as designed must hold everything on every sweep bound.
2. Each rule is dropped alone. It is necessary if some bound then fails.
3. The rules found unnecessary are dropped one by one (greedy, in model-text order), each kept dropped only if everything still holds.
4. A final pass proves what is left is 1-minimal: dropping any one rule breaks a property. Then the smallest model runs on the verify bound.
5. Mutants of the smallest model: drop each guard, drop each update, flip each `<`/`<=`/`>`/`>=`, swap each pair of updates in one action. A mutant no bound catches is **equivalent** if its state graph is the same as the model's on every bound, else it **survived**.

Every count below is **model-checked here**, from the files in [results/](results). Claims marked **reasoned** are not model results.

**Box and versions.** Linux 6.18 (Firecracker VM), 4 vCPU, 15 GB; Python 3.13.17, standard library only ([results/machine.txt](results/machine.txt)). Model checks ran under `$SP/bin/heavy`, with two worker processes, in pieces of about 20 minutes. Seconds below are from a shared, busy box (other agents' TLC and simulations ran beside them): treat them as rough sizes, not timings.

**Reproduce.** `./run.sh` (all options, then [results/summary.md](results/summary.md)), or `./run.sh slot` for one option. `FRESH=1` ignores the checkpoint. One run: `python3 harness/cli.py --option slot --bound grow --drop final.outs`.
