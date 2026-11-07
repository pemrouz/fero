# E-33: genesis founds exactly one cluster; a restore keeps tokens and cursors honest

**Question (Q-33).** Does genesis found exactly one cluster per project and always finish, and does a restore keep tokens and cursors honest?

**Threshold.** Holds → the draft's genesis stands as one counted mechanism. A two-cluster trace → it is replaced by an explicit `fero init` on the first start across boxes (CockroachDB's shape), which costs SC-02's "no setup" across boxes; the user decides.

IN-SHORT-PENDING

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
- **`objcas`**: the cluster id is created in the object store by a conditional PUT (`If-None-Match: *`); a seed founds only if that create succeeds, and otherwise adopts the stored id. MIN's family already requires an object store across boxes (SPACE 4.1, footnote 1).

Properties: **G1**, one cluster per project: never two ids that each have a committed client write and a dir still holding them; **G2**, AG EF: once a majority of seeds is up and linked (and, for `init`, the operator has run it), calm steps reach an id held by a majority of seeds, up and linked. **G2all** is the same judged only when every seed is up and linked (`unanimous`'s own promise).

Bounds: `any1` (one fault), `any2` (two faults), `any3` (three faults, crash and wipe only), and `onebox1`: seed 0 already holds an id, with writes, from an earlier one-box run (the case "a process that has a one-box `cluster-id` file never founds from seeds"), one fault.

### 2. Founding on one box, and the stale folder ([models/onebox.py](models/onebox.py))

Three processes of one project's run on one box. The run folder holds the `cluster-id` file and one dir per process; a dir is locked while its process is up. Actions: **create** (the first process: an exclusive create of `cluster-id`; it is `#meta`'s only voter), **join** (through a member of the file's cluster), **stale** (after `connect.wait` with no member reached: if no dir it can read holds the cluster's `#meta`, none is locked by a live process, and no dir is unreadable, rename the file aside and found a new id), **write**. Faults: a crash (dir kept, unlocked), a wipe of a stopped process's dir, a dir briefly unreadable (it becomes readable again with time). Properties G1 and G2 (from every state where every process is up and every dir readable).

### 3. A restore to a past position ([models/restore.py](models/restore.py))

One slot's history of writes, lock grants and slot moves at positions (epoch, seq); backups of a prefix; one restore; one client with a session; one reader with a cursor. Two options: **`design`**: a restore takes a new epoch above a high-water mark in which every epoch is recorded before it is used (the object store's manifest), and starts a new session generation; **`naive`**: "a new epoch" read as the backup's epoch plus one. Properties: **R1** a position never names two records across restores (so no cursor or version from before the restore can be read as one after it); **R2** lock tokens strictly rise in real time across restores (P-10 against an outside system that saw a newer token); **R3** an attempt applied before the restore is never applied again after it (a retry is refused, not re-run: F-02); **R4** the reader takes records with no gap and no overlap, and a cursor the history does not hold is refused (`unknown-log`).

RESULTS-PENDING
