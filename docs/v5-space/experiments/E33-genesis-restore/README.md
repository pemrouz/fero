# E-33: genesis founds exactly one cluster; a restore keeps tokens and cursors honest

**Question (Q-33).** Does genesis found exactly one cluster per project and always finish, and does a restore keep tokens and cursors honest?

**Threshold.** Holds → the draft's genesis stands as one counted mechanism. A two-cluster trace → it is replaced by an explicit `fero init` on the first start across boxes (CockroachDB's shape), which costs SC-02's "no setup" across boxes; the user decides.

**In short.**
- **The draft's genesis can found two clusters for one project** (model-checked, 10 steps, two faults): seeds 0 and 1 found X and commit a write; seed 0 crashes and seed 1 loses its dir; seeds 1 and 2 are a majority with no id, so they found Y and commit a write. A seed cannot tell "never ran" from "lost its dir", so "a majority of seeds with no id" is not proof that no cluster exists. One lost dir plus one crash turns a stalled cluster (which should wait, F-12) into a new, empty one that takes writes.
- **Three fixes, each model-checked safe at the same bounds:** `fero init` once (CockroachDB's shape; 3 rules; costs SC-02's "no setup" across boxes); found only with **every** seed reached (5 rules; safe, but a seed that never starts blocks founding for good); and, new here, **create the cluster id in the object store with a conditional PUT** (`If-None-Match: *`; 4 rules; safe and live with no setup, given an object store at the first start, which MIN's family already requires across boxes).
- **A one-box cluster carried to many boxes by `seeds` makes two clusters under every option but "every seed"**: the seed holding the one-box id is down, and the others found without it. The safe path is already in DESIGN-V5: other boxes join a running cluster with `hosts`; `seeds` is only for a first start with no data anywhere. That sentence must be stated as a rule.
- **One box holds** (exclusive create, join through a member, the stale-folder rule) at one to three faults; the guard "a dir it cannot read may hold `#meta`" is needed (without it, two clusters in 7 steps).
- **A restore keeps positions, lock tokens, retries and cursors honest** with 8 rules, and **only if its new epoch is above every epoch ever used**: read as "the backup's epoch plus one", a slot move after the backup makes the restore reuse an epoch, so a lock token and a version repeat (5 and 6 steps). The epoch must be recorded outside the restored data (the object store's manifest) before it is used.
- DEV-10: 8 to 9 of 8 to 9 non-equivalent mutants caught per model (100%).

## Words used here

- **Genesis**: the first start of a project's cluster. It creates `#meta` (the cluster's own shard) and mints the **cluster id**, which rides every HELLO; processes with different ids never link.
- **Seeds**: the list of founding members a cross-box start is given. **Run folder**: `.fero/` on one box, holding the `cluster-id` file and one dir per process.
- **A dir** is a process's data folder: it holds the cluster id the process applied and, for a voter, a `#meta` replica. **Wiped**: the dir is gone (a new disk, `rm -rf`, a new container); the process restarts without it.
- **Restore**: a project is rebuilt from a backup at a past position (OPS-07). A **position** (version) is (epoch, seq) per slot; a **slot epoch** rises on a slot move; a **lock token** is a version (API.md), so it compares with `<`.
- **AG EF**: "from every reachable state, the goal can still be reached", the liveness check of E-14 and healing.py.
- **DEV-10**: a rule is one guard conjunct or one state update, counted only if removing it lets the checker find a counterexample; mutants are made by script.

## Method

Three exhaustive models in plain Python, on E-16's engine ([../E16-controller-loop/engine/engine.py](../E16-controller-loop/engine/engine.py)), which uses E-17's shared rule language (`harness/dsl.py`) unchanged and E-17's ablation and mutant procedure. Each model brings its own small world (E-17's world is about partitions moving between groups and does not fit). Each run is breadth first over every reachable state, so every trace below is a shortest one.

### 1. Founding across boxes ([models/genesis.py](models/genesis.py))

The world: three seeds, each up or down, on side 0 or 1 (links join seeds on one side), with a dir that holds an applied cluster id or nothing. `#meta`'s first election and its first entry are one atomic step: Raft's one leader per term and majority commit are E-14's job; this model asks whether the founding rule picks one id. A write commits under id c when a majority of the seeds hold c, up and linked. Faults (a budget): a crash (dir kept), a wipe (down; the dir is gone, so the seed restarts without it), a cut (the seed moves to side 1). Starting, healing a link and restarting are free. Every seed starts down: seeds start in any order.

Four options:
- **`draft`**, DESIGN-V5 4.2 as written: a seed founds when it reaches a majority of the seeds and none of the seeds it reaches has an id; a seed with no id that reaches one with an id joins it.
- **`unanimous`**: found only when every seed is reached and none has an id.
- **`init`**: an explicit `fero init` (CockroachDB): seeds never found by themselves; an operator step founds once, on a seed that reaches a majority.
- **`objcas`**: the one-box rule with the object store in place of the run folder: the cluster id is created in the object store by a conditional PUT (`If-None-Match: *`); the seed whose create succeeds is `#meta`'s only voter, as the first process on one box is; every other seed adopts the stored id and is added as a replica by healing once the cluster works. MIN's family already requires an object store across boxes (SPACE 4.1, footnote 1).

Properties: **G1**, one cluster per project: never two ids that each have a committed client write and a dir still holding them; **G2**, AG EF: once a majority of seeds is up and linked (and, for `init`, the operator has run it), calm steps reach an id held by a majority of seeds, up and linked. **G2all** is the same judged only when every seed is up and linked (`unanimous`'s own promise).

Bounds: `any1` (one fault), `any2` (two faults), `any3` (three faults, crash and wipe only), and `onebox1`: seed 0 already holds an id, with writes, from an earlier one-box run (the case "a process that has a one-box `cluster-id` file never founds from seeds"), one fault.

### 2. Founding on one box, and the stale folder ([models/onebox.py](models/onebox.py))

Four processes of one project's run on one box (`#meta` grows to three voters as they arrive; the fourth holds no `#meta` replica). The run folder holds the `cluster-id` file and one dir per process; a dir is locked while its process is up. Actions: **create** (the first process: an exclusive create of `cluster-id`; it is `#meta`'s only voter), **join** (through a member of the file's cluster), **stale** (after `connect.wait` with no member reached: if no dir it can read holds the cluster's `#meta`, none is locked by a live process, and no dir is unreadable, rename the file aside and found a new id), **write**. Faults: a crash (dir kept, unlocked), a wipe of a stopped process's dir, a dir briefly unreadable (it becomes readable again with time). Properties G1 and G2 (from every state where every process is up and every dir readable).

### 3. A restore to a past position ([models/restore.py](models/restore.py))

One slot's history of writes, lock grants and slot moves at positions (epoch, seq); backups of a prefix; one restore; one client with a session; one reader with a cursor. Two options: **`design`**: a restore takes a new epoch above a high-water mark in which every epoch is recorded before it is used (the object store's manifest), and starts a new session generation; **`naive`**: "a new epoch" read as the backup's epoch plus one. Properties: **R1** a position never names two records across restores (so no cursor or version from before the restore can be read as one after it); **R2** lock tokens strictly rise in real time across restores (P-10 against an outside system that saw a newer token); **R3** an attempt applied before the restore is never applied again after it (a retry is refused, not re-run: F-02); **R4** the reader takes records with no gap and no overlap, and a cursor the history does not hold is refused (`unknown-log`).

## Results

Machine: 4 vCPU, 15 GB, shared with other agents; Python 3.13, standard library. Every run is complete (every reachable state explored) unless it says otherwise. Raw output: [results/design-genesis.txt](results/design-genesis.txt), [results/design-onebox.txt](results/design-onebox.txt), [results/design-restore.txt](results/design-restore.txt); the DEV-10 ablations in `results/*-ablation.json` and [results/summary.md](results/summary.md). All model-checked here.

### 1. Founding across boxes: the draft founds two clusters

| Option | `any1` (1 fault) | `any2` (2 faults) | `any3` (3 faults) | `onebox1` (a seed with a one-box id) |
|---|---|---|---|---|
| `draft` | holds (206 states) | **G1 broken** (1,006 states; 10 steps) | **G1** and G2 broken (1,418) | **G1** (4 steps) and G2 broken (165) |
| `unanimous` | G1 holds; **G2 fails** in 9 of 39 judged states | G1 holds; G2 fails in 24 of 207 | G1 holds; G2 fails in 18 of 308 | G1 holds; G2 fails in 3 of 65 |
| `init` | holds (206) | holds (942) | holds (870) | **G1** (4 steps) and G2 broken (165) |
| `objcas` | holds (750) | holds (3,598) | holds (4,088) | **G1** (3 steps) and G2 broken (497) |

`unanimous` keeps its own weaker promise (G2all: founding completes once **every** seed is up and linked) in every bound; it fails G2 by design, since one seed that never starts blocks founding for good.

**The draft's two-cluster trace** (`any2`, 10 steps, two faults):
1. Seeds 0 and 1 start. Seed 0 reaches a majority (0, 1), none has an id: it founds **X**, on 0 and 1. Seed 2 starts but has not linked yet.
2. A client write commits under X.
3. Seed 0 crashes (its dir is kept: it holds X and the write). Seed 1 loses its dir and restarts without it.
4. Seeds 1 and 2 reach each other: a majority of the seeds, and neither has an id. The rule allows founding: seed 1 founds **Y**.
5. A client write commits under Y.

Now the project has two clusters, each with acknowledged writes. X's only copy is seed 0's disk; when seed 0 returns it holds X, and "different ids never link". In `any3` the same split also blocks founding for the survivors (G2: seeds 0 and 2 up, holding X and Y). The draft's rule cannot tell "a seed that never ran" from "a seed that lost its dir": both answer "no id". So one lost dir plus one crash turns a majority loss of X, which should wait for an operator (F-12), into a new, empty cluster that takes writes. The sentence "A seed restarted without its dir finds a cluster id at another seed" holds only if that other seed is reachable.

**The one-box carry-over** (`onebox1`): seed 0 holds an id from an earlier one-box run, with writes, and is down. Seeds 1 and 2 found a new cluster from `seeds` (draft), or the operator runs `init` on seed 1, or seed 1 wins the object-store create: in each, the project then has two clusters with writes. "A process that has a one-box `cluster-id` file never founds from seeds" protects only that process; the others found without it. Only `unanimous` holds here, because it needs seed 0. The safe path is the draft's own rule for `hosts`: the other boxes **join** the running one-box cluster (`hosts`, not `seeds`), and seeds are only for a first start with no data anywhere. That is a rule to state in DESIGN-V5 4.2, not a mechanism.

**What each fix costs:**
- `unanimous`: safe in every bound, but founding needs every seed up and linked (it fails G2's "a majority").
- `init`: safe in every bound but the carry-over; costs SC-02's "no setup" across boxes (one `fero init` on the first start), as Q-33's threshold says.
- `objcas`: safe and live in every bound but the carry-over, with **no setup**: the conditional create in the object store picks one id even when every dir is wiped, and a seed that adopts the stored id holds no replica until the cluster's own voters let healing add it, so it never starts an empty copy under the old id. It needs the object store reachable at the first start, and, like one box, the first writes have one copy until the others join (DESIGN-V5's "starts with one voter"). MIN's family already requires an object store across boxes (SPACE 4.1, footnote 1); rows without one (DRAFT, CELL, LANE, SPLIT on bare boxes) would take `init` or `unanimous`.

### 2. Founding on one box: holds

`draft` on one box (exclusive create of `cluster-id`, join through a member, the stale-folder rule) holds G1 and G2 at one, two and three faults (784, 2,584 and 6,592 states; G2 here asks that every process of the run can write). The guard "a dir it cannot read may hold `#meta`, so the file is not stale" is needed (DEV-10 below).

### 3. A restore: positions, tokens, retries and cursors stay honest

| Option | `b1` (write, lock, move, restore) | `b2` (two writes, no move) | `b3` (two moves, two backups) |
|---|---|---|---|
| `design` (a new epoch above a high-water mark in the store; a fresh session generation) | holds (640 states) | holds (1,184) | holds (8,868) |
| `naive` (the backup's epoch plus one) | **R1 and R2 broken** (710) | holds | **R1 and R2 broken** (11,356) |

The `naive` trace (R2, 5 steps): a backup is taken at epoch 1; a slot move raises the epoch to 2; a lock is granted with token (2, 1); the restore takes "the backup's epoch plus one", which is 2 again, and the sequence goes back to the backup's; the next lock gets token (2, 1) again. An outside system that saw the first token cannot tell the two holders apart, and a version from before the restore now names a different record (R1, 6 steps, with a write in place of the first lock). "A restore gives every slot a new epoch" is right only if "new" means above every epoch ever used, and the restored copy cannot know that from its own data: the epoch must be recorded outside it (the object store's manifest) before it is used.

### 4. DEV-10: rules and mutants

The ablation (E-17's procedure on E-16's engine) runs each option on its sweep bounds and verifies the smallest model on the next bound up; the mutants are made by script from the smallest model. Full tables, with the property and the steps each removal breaks: [results/summary.md](results/summary.md).

| Model and option | Rules needed (of written) | The rules | Mutants caught |
|---|---|---|---|
| genesis `objcas` | **4** (of 9) | the create succeeds only while no id is stored (`If-None-Match`); the create writes the id; a seed adopts only a stored id; the adopt itself | 4 of 4 |
| genesis `init` | **3** (of 7) | init runs once; init mints the id; a seed adopts an id it finds at a seed it reaches | 3 of 3 |
| genesis `unanimous` | **5** (of 6) | found only when every seed is reached; and none has an id; the mint; join only a seed that has an id; the adopt | 6 of 6 |
| genesis `draft` | not counted: the design breaks G1, so there is no smallest correct model to count (6 rules written) | | |
| one box (`draft`) | **4** (of 12, one pinned) | a process joins the file's cluster (through a member); the stale check finds no readable dir holding `#meta`; and **no dir is unreadable**; the stale step founds anew | 4 of 4 |
| restore `design` | **8** (of 11, eight pinned) | a retry from a session older than the restore is refused; an attempt already applied is not applied again; the write and the lock each advance the sequence; a slot move records its epoch in the store before use; the restore takes an epoch above that record; the restore starts a new session generation; a cursor the history does not hold is refused | 8 of 8 (1 swap equivalent) |

Notes on what the counts mean:
- **One box:** the exclusive create drops out of the count because the model takes "check that no dir holds `#meta`" and "write the file" as one step, so it cannot see two processes both checking before either writes. A real check-then-write needs the exclusive create (rename aside, then create with `O_EXCL`) to stay atomic between processes; it is counted here by reasoning, not by the ablation (so one box is 5 rules). The ablation also folds "create the first file" into the stale step: one founding rule, "found when no readable dir holds `#meta` and no dir is unreadable", covers both the first start and a wiped folder.
- **Restore:** recording the restore's own epoch in the store (`restore.hw`) drops out only because the bounds have one restore; a second restore would need it (reasoned). The reader's refusal path (`refused.*`) is liveness for the reader, which this model does not ask.
- In `objcas`, the seed-to-seed `join` rules all drop out: adopting the stored id does their job. In `init`, the "init reaches a majority" and "init refuses a seed with an id" guards drop out at these bounds; `init.once` (the CLI refuses a second init) is the one that keeps a single cluster.
- **Pinned** (written as updates, never dropped or mutated): bounds, and steps of the world itself: a record lands in the log, a restore brings the backup back, a slot move raises the epoch (E-15's rule), the reader takes a record, a process joins only through a member of the cluster. The first ablations without those pins dropped them and then everything that depended on them, leaving vacuous models (a write that writes nothing needs no dedup); the pins are what keeps the count honest.

## What the model leaves out

- **`#meta`'s first election and first entry are one atomic step**, and joining is one step through a member. Raft's own one leader per term and majority commit are E-14's and E-14b's.
- **Three seeds; one box has four processes and at most three `#meta` voters;** up to three faults; at most three ids minted. Seeds-list mismatches (the HELLO hash check) and processes given `hosts` and no `seeds` are not modelled.
- **The object store is always reachable and its conditional PUT is atomic** (S3 conditional writes; MinIO answered 200 then 412 in TOOLS.md's smoke test). A store outage at the first start blocks `objcas` founding (a stated delay).
- **The stale check is one atomic step** (see the DEV-10 note): the exclusive create that makes it atomic between processes is counted by reasoning.
- **Restore:** one slot, one restore, one or two backups. Lock tokens are versions (API.md), so they rise with the epoch; a token kept apart from versions would need its own high-water mark. Erasure (F-08) is not modelled.
- **Liveness is "a path exists"** (AG EF), not a fairness proof.

## Against the threshold

The threshold: "holds → the draft's genesis stands as one counted mechanism. A two-cluster trace → it is replaced by an explicit `fero init` on the first start across boxes (CockroachDB's shape), which costs SC-02's 'no setup' across boxes; the user decides."

- **There is a two-cluster trace** (two faults: one lost dir, one crash). So the draft's founding rule does not stand.
- The threshold's replacement, `fero init`, holds (3 rules) and costs SC-02's "no setup" across boxes.
- This experiment adds a third choice the threshold did not name: **the object store's conditional create** (4 rules) holds with no setup. It needs an object store reachable at the first start, which MIN's family requires anyway (SPACE 4.1, footnote 1). Rows that run across boxes without an object store (DRAFT, CELL, LANE, SPLIT as drafted) need `fero init`, or "every seed" with its liveness cost. **The user decides** between these, as the threshold says; the evidence favours the conditional create wherever an object store exists.
- In every choice, `seeds` must never be used beside a dir that already holds a cluster id; growing from one box is a join through `hosts`.
- Rows by SPACE 4.1: an object store is required across boxes for MIN, RUST, LEAN, MIN-P, MIN-TS and SIDE (footnote 1), and SLOG and OBJ are built on one; DRAFT, CELL, LANE, SPLIT, SRV, EMB-V8 and RLOG are not, as drafted. PD and ISR found by their own explicit step (PD's initial cluster; KRaft formats its log dirs with a cluster id, `kafka-storage format`), which is `init`'s shape.
- **The restore** keeps tokens and cursors honest with a new epoch above an outside high-water mark and a fresh session generation (8 rules, every mutant caught); the literal "a new epoch" reading fails.

## How to rerun

```sh
./run.sh          # the designs, then DEV-10's ablations and mutants (minutes of CPU; two holds of the heavy lock)
./run.sh check    # the designs only
python3 ../E16-controller-loop/engine/cli.py models/genesis.py draft --bound any2    # one run, with its trace
```

Q-33: No as drafted: founding on "a majority of seeds with no id" makes two clusters with writes after one lost dir and one crash (10 steps, model-checked), because a seed cannot tell "never ran" from "lost its dir"; `fero init` (3 rules, costs SC-02's no-setup across boxes) or a conditional create of the cluster id in the object store (4 rules, no setup, needs the store at the first start) each hold at the same bounds, `seeds` must never run beside a dir that holds an id (grow from one box by `hosts`), one box holds, and a restore stays honest only with an epoch above an outside high-water mark and a fresh session generation (8 rules, every mutant caught). Moves: MIN, RUST, LEAN, MIN-P, MIN-TS, SIDE, SLOG, OBJ (an object store across boxes, SPACE 4.1) up on SC-02 and DEP-18 with genesis = the conditional create (one mechanism, 4 rules); DRAFT, CELL, LANE, SPLIT, SRV, EMB-V8, RLOG (no store required across boxes as drafted) down on SC-02 (one `fero init`, 3 rules) unless they require the store; PD and ISR unchanged (their systems already found by an explicit step: PD's initial cluster, KRaft's `kafka-storage format --cluster-id`); every row's OPS-07 holds only with the restore's high-water epoch and a fresh session generation (8 rules; one more store write per epoch).
