# E-36: a project with 100,000 small resources

## The question

Q-36 ([QUESTIONS.md](../../QUESTIONS.md) §8): what does a project with 100,000 small resources cost?

SC-13 asks a project to hold at least N_res resources (proposed 100,000), most of them small, as `fero('doc:' + id)` invites: creating one answers in ≤ C + 10 ms, opening a cold one in ≤ 5 ms, and an idle one costs ≤ 2 KB on each member that holds it and sends no frames. Words: the **`#meta` table** is the catalog (one row per resource) plus each resource's **slot table** (which group holds each of its 1,024 slots, and the slot's epoch). **Per-slot state** is what a member keeps per slot: its sequence, epoch and fence position. MIN gives each resource its own group; **MIN-P** puts many resources' slots in the project's groups (G `pslot`); **LANE** has 64 lanes per project and no slot table.

**Threshold** (QUESTIONS.md): above 2 KB per idle resource, or above 2,000 groups per process at 1e5 → the slot table is run-length coded from phase 1 and resources share groups (MIN-P's rule), or the ceiling is stated with its error (SC-13).

## Method

- **`#meta` bytes, exact** ([meta_model.mjs](meta_model.mjs)): a catalog row encoded compactly (name `doc:` + 20 characters, id, incarnation, settings, created-at, state: 48 B), and the slot table in four forms: raw (1,024 × group u32 + epoch u32), varint rows, run-length coded (runs of start, length, group, epoch; one run when every slot sits in one group, 2 more per moved slot), and none (MIN-P: one shared slot map per project; LANE: lanes by hash). At 1e2, 1e4 and 1e5 resources, per voter.
- **Memory per resource in Node 22, measured** (same file, not a timing run): heapUsed plus array buffers after a forced GC, for 10,000 resources at once: per-slot state dense (three typed arrays of 1,024) or sparse (a Map of the touched slots: 1, 10 or 100), the slot table as 1,024 row objects, as typed arrays, or as one run; the catalog row as an object.
- **Create and open latency, measured** with E-26's lifecycle runs on E-10's TS Raft port ([../E26-dormant-groups](../E26-dormant-groups/README.md)), three processes with 100, 10,000 and 100,000 dormant groups each: MIN's create = the `#meta` row committed, then the resource's new group created on three processes with its first write; MIN-P's and LANE's create = the `#meta` row only; opening a cold resource = waking its dormant group until one write commits. Under `$SP/bin/timing`, 3 runs per scale, 20 samples each.
- **Groups per process and idle frames**: counted from the forms; idle frames measured in E-26 (0 Raft messages for quiet and dormant groups).

**Files.** [run.sh](run.sh). Raw: [results/meta_model.json](results/meta_model.json); the latencies in [../E26-dormant-groups/results/lifecycle.jsonl](../E26-dormant-groups/results/lifecycle.jsonl). Nothing was downloaded.

## Results

### `#meta` bytes per voter (exact)

| form | per resource | 1e2 resources | 1e4 | 1e5 |
|---|---|---|---|---|
| MIN, raw slot table (the draft's 1,024 slot rows) | 8,240 B | 0.8 MB | 82 MB | **824 MB** |
| MIN, slot rows as varints | 5,168 B | 0.5 MB | 52 MB | 517 MB |
| MIN, run-length slot table, no moves | 56 B | 0.006 MB | 0.56 MB | **5.6 MB** |
| MIN, run-length, 10 moved slots per resource | 196 B | 0.02 MB | 2.0 MB | 19.6 MB |
| MIN-P (one shared slot map per project) | 48 B | 0.005 MB | 0.48 MB | **4.8 MB** |
| LANE (64 lanes, no slot table) | 48 B | 0.005 MB | 0.48 MB | **4.8 MB** |

### Memory per idle resource in Node (measured, 10,000 resources)

| part | form | bytes per resource |
|---|---|---|
| catalog row | object | 185 |
| slot table | 1,024 row objects | 49,131 |
| slot table | two typed arrays | 8,608 |
| slot table | one run (run-length) | **120** |
| per-slot state | dense typed arrays (1,024 slots) | 21,089 |
| per-slot state | sparse Map, 1 / 10 / 100 slots touched | **241** / **1,008** / 8,464 |
| group | quiet, in memory (E-11: TS / Go / Rust) | 16,000-26,000 / 6,500 / 4,000 |
| group | dormant (E-26) | **57** |

### Create and open (measured on E-10's TS Raft port; medians of 3 runs, 20 samples each)

| dormant groups per process | MIN create (meta + group): p50 / max of 20, ms | MIN-P, LANE create (meta only): p50, ms | open a cold resource (wake its group): p50 / p90 / max, ms |
|---|---|---|---|
| 100 | 4.60 / 6.84 (worst run 10.25) | 1.60 | 3.51 / 5.11 / 5.30 |
| 10,000 | 4.55 / 6.05 | 1.57 | 3.41 / 4.52 / 4.86 |
| 100,000 | 5.28 / 6.65 | 1.81 | 3.33 / 4.39 / 5.35 (worst run 7.61) |

### Per idle resource, assembled (TS), and groups per process at 1e5

| row and form | per idle resource | groups per process at 1e5 | idle frames per resource |
|---|---|---|---|
| MIN as drafted (group in memory, slot rows, dense per-slot state) | about 86 KB (46 KB with typed arrays) | 100,000 in memory | 0 (quiet) |
| MIN + run-length slot table + sparse per-slot state, group in memory | 17.3 KB (Rust group: 5.3 KB) | 100,000 in memory | 0 |
| **MIN + run-length + sparse + dormant groups** | **1.4 KB** (10 slots touched; 8.8 KB at 100) | 100,000 dormant, awake only when used | 0 |
| **MIN-P** (project groups, shared slot map) + sparse per-slot state | **0.4-1.2 KB** (1-10 slots touched) | about 16 | 0 |
| **LANE** (lane offsets, no per-resource slot state) | **0.2 KB** | 64 | 0 |

## Against the threshold

| bar | MIN as drafted | MIN + run-length + sparse + dormant | MIN-P | LANE |
|---|---|---|---|---|
| create ≤ C + 10 ms (10.7 ms) | 4.6-5.3 ms p50, max 6-10 ms: holds | the same | 1.6-1.8 ms: holds | 1.6-1.8 ms: holds |
| open a cold one ≤ 5 ms | holds at p50 and p90 (3.3-3.5, 4.4-5.1 ms), the tail is over (5.4-7.6 ms) | the same | a catalog lookup when the project's groups are awake (reasoned); one wake (3.4 ms) when asleep | the same as MIN-P |
| ≤ 2 KB per idle resource | **fails, 23-43 ×** | holds while few slots are touched (1.4 KB at 10; fails at 100: 8.8 KB) | holds | holds |
| ≤ 2,000 groups per process at 1e5 | **fails (100,000 in memory)** | dormant groups cost 57 B each; awake ones follow activity | holds (about 16) | holds (64) |
| `#meta` per voter at 1e5 | 824 MB | 5.6-19.6 MB | 4.8 MB | 4.8 MB |

So, as the threshold says: **the slot table must be run-length coded from phase 1** (the draft's 1,024 rows per resource cost 824 MB of `#meta` per voter at 1e5 and 8-49 KB of memory per resource), **per-slot state must be sparse** (dense is 21 KB per resource), and either **resources share groups (MIN-P's rule)** or **groups go dormant** (E-26: one mechanism, 57 B per group). Per-slot state for touched slots is then the largest term (about 85 B per touched slot in a JS Map; a sorted typed-array form would take about 12 B, reasoned), so a resource that has written to all 1,024 slots costs about 87 KB in the Map form wherever it lives: SC-13's "small" has to mean "few slots touched", or per-slot state goes in typed arrays (about 12 KB at 1,024 slots, still over 2 KB). LANE needs no slot table and no per-slot state, so it is the cheapest per resource, but it caps writers per project (E-18).

## What this box cannot show

- The memory figures are V8's (Node 22) for the JS forms; a Rust core would hold the same state in about a quarter (E-11's 4 KB against 16-26 KB per group).
- Opening a cold resource was measured as a wake of its group on three processes on one box; across machines add about two round trips (0.5-1 ms).
- 100,000 resources were not created through `fero()`: the create and open runs used 100,000 dormant groups and timed 20 fresh creates and wakes beside them; `#meta` sizes are encodings, not a running `#meta` group.

## Verdict

Q-36: a project with 100,000 small resources costs, per idle resource, about 86 KB in memory and 8.2 KB of `#meta` per voter (824 MB at 1e5) with MIN as drafted, but 1.4 KB with a run-length slot table, sparse per-slot state and dormant groups, 0.4-1.2 KB with MIN-P and 0.2 KB with LANE; a create answers in 4.6-5.3 ms (MIN) or 1.6-1.8 ms (MIN-P, LANE) against 10.7 ms, and a cold open in 3.3-3.5 ms at the median (tail 5.4-7.6 ms) against 5 ms, flat from 100 to 100,000 resources. Moves: MIN (and MIN-TS, RUST, LEAN, DRAFT, RLOG, SRV, SIDE, EMB-V8: a group per resource) down on SC-13 and SC-10 as drafted, recoverable only with three phase-1 format choices (run-length slot table and sparse per-slot state, DEV-09) plus dormant groups (+1 mechanism, DEV-01); MIN-P up on SC-13, SC-10 and X18 (no dormant groups needed; settings must be equal per group); LANE up on SC-13's memory clause (0.2 KB) but its writer cap stays (E-18); every row: SC-13's "small" must be defined as "few slots touched" or per-slot state priced per touched slot (about 85 B in a JS Map).
