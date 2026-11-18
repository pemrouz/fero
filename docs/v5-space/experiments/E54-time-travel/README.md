# E-54: stepping through a resource's versions

**Question (Q-54).** The owner asked whether fero should step back in time by reversing change records. They recalled two ways to keep old copies of data that cannot change: one costs O(log n) a step, one O(1), both with shared structure and fast updates. To step through a resource's versions (back one, forward one, and a jump to any position) on top of its log of change records, which structure is fastest, smallest and safest? And what does each one cost the write path?

**It decides** whether any version structure goes on the live write path (the owner asked whether fero should use one), what the timeline viewer, the debugger, tapes, forks, restore and as-of reads each use, whether a fero record must carry its prior value, and what `data` would need if it were rewritten (in TypeScript or Rust) for this.

<!-- answer:start -->
## The answer first

- **The owner's two approaches are path copying and rerooting.** The O(log n) one is a persistent tree with path copying: a HAMT, as in Clojure, Immutable.js, `im`, `imbl` and `rpds`. Every version is a root, a read costs log32 n steps, and a write copies about 4 nodes at 1e6 rows. The O(1) one is Baker's rerooting ("shallow binding"). A write is O(1), and a read is O(1) only at the version that holds the real table. Any other version first costs the distance to it. (From the literature; the sources are below. Which of the two the owner meant by "O(1)" is reasoned from their words; two other readings are named under "The two approaches".)
- **None of them belongs on the live write path** (measured). A HAMT root kept per write adds 3.3-5.7 µs to the plain fold's 0.79-1.4 µs a write, and keeps 1.3-1.7 KB a version. Under 50,000 writes a second the collector then takes 15-22% of the time, against 0.5%, and the event-loop delay's p99 goes from 1.5 ms to 17-22 ms. A HAMT used only as the store, with no old root kept, still adds 1.1-2.2 µs a write: 2.4 to 3.6 times a `Map` (measured in the review, [bench/hamtstore.mjs](bench/hamtstore.mjs), 3 runs). Rust's HAMTs are no cheaper: 8 to 10 µs a write and 1.9-4.9 KB a version at 1e6 rows. Even the cheapest way, reverse records, would keep 16-150 B a record in every copy's memory, for a reader the live path does not have. The log is already the history (V5-1).
- **On the reader side, fat nodes are the best fit** (measured). A reader is the timeline viewer, the debugger or a rerun: a process that folds the log for itself. A fat node keeps, per row, the list of versions at which the row changed and the row each one made. Two layouts were measured, and **the pick is per-row lists** ("fat": per-row arrays with a binary search). Beside a plain `Map`, building them adds 0.97-1.02 µs a record and keeps 104-219 B a version, 6 to 14 times less than a HAMT. A step and a jump cost under 0.2 µs (a number changes). A row at any version costs about 2.1-2.4 µs, and a row with 150,000 versions reads in 1.2 µs. A picture is just a version number, and it is frozen. The other layout, a 4-byte back-pointer per record into the log ("fatlog"), is smaller and cheaper to build (+0.34-0.35 µs, 54-76 B a version), but it is **not picked**: a row written very often makes its own reads walk a long chain, 0.3 ms and at worst 1.6-5.4 ms for a row with 150,000 versions. On `data`'s real fold the picked layout costs more: +1.5-2.0 µs a record and 103-285 B a version (measured by [E-55](../E55-lens-prototype/README.md), claim 23, the same kept-bytes method as here: heap after minus heap before).
- **Reverse records are the smallest, and right only for walking in order** (measured). They keep 16-49 B a version and add 0.17-0.26 µs a record. A step costs 0.3-1.2 µs. But a jump costs the distance, about 0.35-1 µs per record of it (computed: the median jump over a third of the history, the mean distance between random versions; a random jump in 1.5 million versions took 0.18-0.48 s), and a frozen picture needs a copy of every row (0.16-1.1 s). That suits E-06's reruns in tape order and a debugger's single steps. It does not suit a scrub bar. Baker's rerooting is the same thing with twice the memory (102-106 B a version), and one table that every reader moves, so it is not safe to share.
- **Checkpoints in memory are the worst way** (measured). Each one copies every row: about 30 MB and 0.45 s at 1e6 rows. The event loop stalls (p99 7-549 ms). At 1e6 rows with K = 10,000, and at 1e5 rows with K = 1,000, the box no longer keeps up with 50,000 writes a second (19,600 and 31,500 a second). Snapshots belong on disk, where V5-1 already keeps them as the compacted start.
- **A fero record needs to carry nothing new.** `data` already makes the prior row on every write: `UpdateDelta.prev`, by reference, with no copy (code: data contract/delta.ts:44, kernel/node.ts:444-466). It matched the plain fold's prior row in every one of 857,148 checks (measured). Keeping it costs a reader no time we could see (-0.18 to +0.10 µs a record, within the noise) and 70-150 B a record. Putting it in the log would add 58 B (the old field) to 108 B (the old row) to a 71-73 B record: 80% to 150% more bytes on disk, on the wire and in every copy (measured with fero v4's codec). In v5, `data` folds a batch per call (docs: LAYERS 3.4), so `prev` is the row before the batch, one per row per batch (0.999-1.000 deltas a record at 256 records a batch, measured). That is the right step for a viewer, since no reader ever sees a state inside a batch.
- **Safe** (measured, and code). `data` never changes a row; a write makes a new one (code: data api/index.ts:152-156). So every way shares rows and copies none. HAMT roots and fat-node pictures stayed right after the cursor moved, in every run. A picture made by copying is safe too, but costs O(rows). Handing out the cursor's own table without a copy changed under the reader in every run that tried it.
<!-- answer:end -->

## Words used

- **Version.** The state of a resource after the first v records of its log. Version 0 is the start (the snapshot the kept log begins from). In this experiment one record makes one version.
- **Step back, step forward.** Move from version v to v-1, or to v+1. **Jump**: move to any version.
- **Picture.** Every row of the resource at one version, **frozen**: it never changes after it is handed out, whatever happens next.
- **Reverse record.** A record that undoes another. To undo "set row k to X" you need what row k was before: the **prior value**.
- **Path copying** (structural sharing). A write copies only the nodes on the path from the root to the changed entry. Every other node is shared with the old version, so both versions stay whole.
- **HAMT** (hash array mapped trie, Bagwell 2001). A tree with up to 32 children a node, found by 5 bits of the key's hash at each level. 1 million keys make a tree about 4 levels deep. Clojure, Scala, Immutable.js, `im`, `imbl` and `rpds` use it for their maps.
- **Rerooting** (Baker's shallow binding). One version holds the real, changeable table. Every other version is a small "diff" node (one key and its old value) that points one step nearer the real table. To read another version, walk to it and reverse the diffs on the way, so the real table moves there.
- **Fat node.** Each key keeps its own list of (version, value). Reading key k at version v is a search in k's list.
- **Checkpoint.** A full copy of the table, kept every K records. A version is the nearest checkpoint before it plus a replay of up to K records.
- **Live write path.** The work every copy of a resource does for every write: decode, fold into rows, answer. Anything here is paid by every write on every copy, whether anyone ever looks back or not.
- **Reader side.** A process that reads the log for itself: the timeline viewer, the debugger, a test rerun. It pays for its own structure; nothing else does.
- **Fold.** Turning committed change records into rows. `data` does it (V5-1).
- **Batch.** The records one log entry commits together. A reader never sees a state inside a batch.

## The two approaches, from the literature

The owner's two are, most likely, these (named from the literature; "which is which" is reasoned from their words):

| | **O(log n): path copying in a persistent tree** | **O(1): Baker's rerooting** |
|---|---|---|
| Who | Bagwell's HAMT (2001) with Clojure's path copying; Immutable.js, Scala, `im`, `imbl`, `rpds` | Baker's shallow binding (1978; "Shallow binding makes functional arrays fast", 1991); Conchon and Filliâtre's persistent union-find (2007) and OCaml's `parray` |
| A write | copies about log32 n nodes (4 levels at 1e6 keys) | one small diff node; the real table is changed in place |
| A read | log32 n steps, at any version | O(1) at the version that holds the table; elsewhere, the distance to it first |
| Every version | a root you can keep, share and read at any time | a node; reading it moves the real table there |
| Safe to share | yes: nothing ever changes | no: two readers at two versions move the table back and forth ("semi-persistent") |

**Other readings of "O(1)"** (from memory; not what this experiment took the owner to mean, so the pairing above is a guess): Driscoll's **node copying** gives O(1) amortised time and space a write for linked structures, and a HAMT's log32 n is often called "effectively constant", since it is at most 7 steps for any size a machine holds. Neither changes the measurements below: a HAMT is measured as it is, and node copying was not built.

Two more ways from the same literature are measured too. **Fat nodes** (Driscoll, Sarnak, Sleator and Tarjan, "Making data structures persistent", 1986/1989): each field keeps its history; O(1) a write, O(log m) to read a field after m changes. **Checkpoints plus replay**: the plain way most event-sourced systems use. Not measured: **transients** (Clojure): a persistent map changed in place for a batch, then frozen. They make building a version cheaper; they keep no old versions, so they do not answer this question. **Immer**-style copy-on-write of plain objects (from memory) copies every object on the path in full: for a resource held as one object of n rows that is O(n) a write; `data`'s own `pathCopy` is this at the row level (code: data kernel/node.ts:275).

Sources (web, search results; the pages themselves could not be fetched from this box): Bagwell, Ideal Hash Trees, https://lampwww.epfl.ch/papers/idealhashtrees.pdf. Baker 1991, ACM SIGPLAN Notices 26(8) 145-147, https://scilit.com/publications/68835f1e05e321daf16acfb722f7b61c. Conchon and Filliâtre 2007, https://usr.lmf.cnrs.fr/%7Ejcf/publis/puf-wml07.pdf and its slides https://usr.lmf.cnrs.fr/~jcf/ftp/publis/puf-wml07-slides.pdf (rerooting). Driscoll et al., summarized at https://en.wikipedia.org/wiki/Persistent_data_structure. Clojure transients, https://clojure.org/reference/transients. The bounds in the table are from memory and agree with those summaries.

## What E-06 already answers

[E-06](../E06-fork-rewind/README.md) asked whether fero test can rerun a recorded input on the exact state before it. It found (measured there):

- **Undo is the fast way to rerun in tape order**: apply input i, read what it wrote, apply its reverse records. 0.03-0.05 ms a rerun at every size, with no snapshot. That is approach (a) below, used one step at a time.
- **Putting a snapshot back into `data` costs O(rows)**: 0.5-1.1 s at 1e6 rows, whether the snapshot is `data`'s own plain object or an Immutable.js map (0.72 s to turn back into an object). So a persistent map makes keeping versions cheap but not handing one to `data`.
- **Immutable.js with a version per input** costs 1.7-6 µs a record to keep, and a rerun from it 0.005-0.016 ms (no `data`).
- **Key order**: a removed row put back by an undo lands at the end of `data`'s key order.

E-06 did not measure: steps in both directions, jumps, reads at a version without moving, whole pictures at a version, memory per version over a million versions, GC pauses, the cost on the live write path, rerooting, fat nodes, Rust, or what a record must carry for (a). This experiment does.

## Method

All code is in this folder. Node 22.22.0 (V8 12.4); Rust 1.97.0. Box: 4 shared vCPU, 15 GB, Linux 6.18 (Firecracker VM). Versions: [results/versions.txt](results/versions.txt).

**The log** ([bench/common.mjs](bench/common.mjs)). A seeded tape of change records in fero's record shape (`{ type, key: [rowKey, ...fieldPath], value }`). Rows are E-05's small row (about 100 B as JSON). The mix: 45% field writes (one field of a live row), 45% whole-row writes, 5% new rows, 5% removes, so the row count stays near the start's. Rows follow `data`'s rule: a row is never changed; a field write makes a new row (a shallow copy with the field set) and the old one stays as it was. So every way below shares rows by reference and copies none.

**The ten ways** ([bench/structs.mjs](bench/structs.mjs)). Each holds the log and the start, folds the records into its own structure, and answers back, forward, jump, read and picture:

| way | what it keeps | back / forward | jump | read row k at v | picture at v |
|---|---|---|---|---|---|
| base | a Map (nothing else) | refold from the start | refold | scan the log from the start | refold |
| (a) rev | Map + each record's prior row, by reference (what `data`'s `UpdateDelta.prev` is) | set the prior row / apply the record | walk, one record a step | scan forward from v for k's first record, take its prior row | walk there, copy the Map |
| (a) revleaf | the same, but a field write keeps only the old field value (what the wire's `WireRecord.prev` would carry) | path-copy the row back | walk | walk back over k's records | walk, copy |
| (d) diff | Baker: a node per version; the newest holds the Map | reroot one step | reroot (the distance) | follow the diff chain from v (no move) | reroot, copy |
| (b) ckpt K | Map + a Map copy every K records (K = 1,000 and 10,000) | copy the checkpoint, replay | copy, replay | checkpoint's row, then k's records since | copy, replay |
| (c) imm | Immutable.js 5.1.9 `Map`, one root per version | change a number | change a number | `roots[v].get(k)` | the root itself |
| (c) hamt | a HAMT written here ([bench/hamt.mjs](bench/hamt.mjs), 90 lines), one root per version | a number | a number | `get(roots[v], k)` | the root |
| (e) fat | per key: arrays of versions and rows | a number | a number | binary search in k's list | search every key |
| (e) fatlog | per record: the index of the previous record of the same key (4 B) and the row it made | a number | a number | walk back from k's newest record | walk every key |

For the (c) ways, "picture as a Map" also times turning the root into a plain Map, what `data` adopts.

**One process per way, size and run**:
1. Make the log (1,500,000 records plus slack) and the start (1e5 or 1e6 rows). Full collection; heap noted.
2. **Build**: fold 1,000,000 records, keeping history. Measured: ns a write (GC included), bytes kept per version (heap after minus before, a full collection at both ends), bytes of garbage per write (every collection's used-heap drop, from `v8.GCProfiler`), GC pauses.
3. **Steady writes** (E-07's method): 10 s; every 1 ms tick the records due at 50,000 a second (at most 2,000 a tick, so a stall is followed by a catch-up). Measured: GC pauses (`perf_hooks` `gc` entries), event-loop delay (`monitorEventLoopDelay`, 1 ms resolution), writes a second achieved, share of the time spent writing.
4. **Steps** from the newest version (about 1,500,000): 1,000 steps back, then 1,000 forward; 50 jumps to random versions; 1,000 reads of a random row at a random version (the cursor left where it is); 10 pictures at random versions. Targets are drawn before the clocks start. Each op is timed alone; an op under 100 µs is also timed as one batch of 1,000 on fresh targets (the mean), because the timer itself costs 90-200 ns.
5. **Checks** (untimed): 14 versions × 40 keys, 2 whole pictures, the same 2 pictures again after the cursor moved to version 0, the newest version and back (frozen?), and the cursor itself, all against a refold from the start. Also, for the ways with a cursor Map, the shortcut of handing out that Map without a copy, then moving 1,000 versions: does the "picture" change?

**One hot row** (`./run.sh hot`). With `HOT=0.1`, a tenth of all records are field writes to one extra row that is never removed, about 150,000 versions of it by the end. The fat and fatlog ways at 1e6 rows, 3 runs, add 1,000 reads of that row at random versions. Unset, `HOT` changes nothing: the tape is the one above.

**What `data` pays** ([bench/live.mjs](bench/live.mjs)), through fero v4's real seam (E-06's [tree.sh](../E06-fork-rewind/tree.sh): `api/substrate.ts`, `kernel/env.ts`, `kernel/codec.ts` at fero af0127c, `data` 63fea66 linked beside them; nothing in either repo is changed). A `data` source is filled the way a replica fills one (E-06's `fill`), then the same 1,000,000 records are folded with `substrate.applyRec`, one `data` commit per record, as fero v4 folds. Modes: plain; plus a `data` sink that does nothing; plus a sink that keeps each delta's `prev` (the reverse records `data` already makes); and the lane with 256 records a call (one commit per frame, as a v5 kernel would hand over a batch). Every 7th kept `prev` is compared with the plain fold's prior row. And, untimed, the bytes: each record and its prior value encoded with fero v4's codec, in frames of 256.

**Rust** ([rust/src/main.rs](rust/src/main.rs)): the same tape (same generator), rows as `Arc<Row>` with `Arc<str>` fields, so a field write shares every other field as in Node. Ways: a std `HashMap` fold, the same plus reverse records, and one root per version in `im` 15.1.0, `imbl` 7.0.2 (both HAMTs) and `rpds` 1.2.1 (`HashTrieMapSync`). A counting allocator gives exact bytes kept and allocated. Reads at random versions are checked against a refold.

**Timing.** Three runs, each one `timing` hold (the box to itself), every process preceded by its load average. Tables give the median of the runs and, in brackets, the lowest and highest run. `ckpt` with K = 1,000 at 1e6 rows is not run: it would hold 1,500 copies of a 1e6-row Map at about 30 MB each (measured at K = 10,000: 2,978 B a version × 10,000), about 45 GB, three times this box's memory (computed).

<!-- results:start -->
## Results

Raw lines: [results/structs.jsonl](results/structs.jsonl), [results/hot.jsonl](results/hot.jsonl), [results/live.jsonl](results/live.jsonl), [results/rust.jsonl](results/rust.jsonl). Every process ran; none failed. The tables are printed by [summarize.py](summarize.py).

<!-- tables:start (python3 summarize.py) -->
### Node: the write path while history is kept (per write; then 10 s of steady writes at 50,000 a second)

History = 1,000,000 records folded after the start. "extra" is the way's write cost minus the plain fold's (base) in the same size. Kept = heap after the history minus heap before it (full collections at both ends), per version. Garbage = bytes the collector freed over the history, per write. Steady: GC pauses are perf_hooks `gc` entries; ELD = event-loop delay (1 ms resolution).

| rows | way | K | ns per write | extra ns | kept B per version | garbage B per write | steady: writes/s | write CPU share | GC ms in 10 s | longest GC pause ms | GC p99 ms | ELD p99 ms | ELD max ms | heap after MB | runs |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100,000 | base (refold) | - | 790.8 (710.5-816.6) | 0.0 (-80.3-25.8) | 7.4 | 35.9 | 49,999 | 0.08 (0.08-0.09) | 55 (21-61) | 13.6 (10.8-19.0) | 13.6 (10.8-19.0) | 1.5 (1.4-1.6) | 14.8 (11.8-20.3) | 402 | 3 |
| 100,000 | (a) rev | - | 978.8 (931.6-1,059) | 188.0 (140.8-268.6) | 49.0 | 25.5 | 49,998 (49,998-49,999) | 0.10 (0.09-0.10) | 30 (25-40) | 15.9 (14.4-21.5) | 15.9 (14.4-21.5) | 1.5 (1.5-1.6) | 17.1 (15.6-23.2) | 460 | 3 |
| 100,000 | (a) revleaf | - | 973.1 (902.7-1,169) | 182.3 (111.9-378.0) | 30.1 | 44.5 | 49,999 (49,998-49,999) | 0.10 (0.09-0.10) | 111 (109-119) | 32.8 (31.0-35.2) | 32.8 (31.0-35.2) | 1.6 (1.6-1.6) | 36.1 (33.5-38.2) | 434 | 3 |
| 100,000 | (d) diff (Baker) | - | 1,062 (984.9-1,128) | 271.2 (194.1-337.4) | 105.5 | 26.2 | 49,999 | 0.09 (0.09-0.10) | 82 (72-84) | 17.0 (14.2-20.1) | 17.0 (14.2-20.1) | 1.5 (1.4-1.5) | 18.5 (15.4-22.4) | 540 | 3 |
| 100,000 | (b) ckpt | 1,000 | 28,964 (28,196-29,952) | 28,173 (27,406-29,161) | 3,716 | 13,875 (13,875-13,876) | 31,501 (30,657-31,971) | 0.97 | 939 (929-954) | 7.4 (7.0-10.7) | 7.0 (6.9-10.0) | 109.8 (98.4-110.1) | 115.7 (113.4-116.9) | 5,056 (5,021-5,071) | 3 |
| 100,000 | (b) ckpt | 10,000 | 4,057 (3,838-4,078) | 3,266 (3,048-3,287) | 405.5 | 1,392 (1,392-1,393) | 49,836 (49,780-49,852) | 0.32 (0.31-0.34) | 228 (216-233) | 22.6 (15.9-24.1) | 22.6 (15.9-24.1) | 7.0 (6.4-9.3) | 122.8 (100.6-125.6) | 972 | 3 |
| 100,000 | (c) imm (Immutable.js) | - | 6,132 (6,013-6,330) | 5,342 (5,222-5,540) | 1,454 | 90.0 | 49,996 (49,995-49,997) | 0.21 (0.20-0.22) | 1,637 (1,511-1,663) | 34.6 (27.9-35.3) | 22.9 (19.8-24.0) | 18.4 (16.3-18.6) | 43.6 (38.5-45.5) | 2,482 (2,482-2,482) | 3 |
| 100,000 | (c) hamt (here) | - | 4,132 (4,084-4,212) | 3,341 (3,293-3,421) | 1,257 | 40.4 | 49,998 | 0.16 (0.15-0.16) | 1,475 (1,347-1,659) | 26.3 (22.5-77.3) | 26.3 (22.5-77.3) | 17.0 (15.4-18.2) | 29.8 (25.5-81.7) | 2,201 (2,201-2,201) | 3 |
| 100,000 | (e) fat | - | 1,813 (1,763-1,931) | 1,022 (972.2-1,140) | 103.6 | 13.0 (12.6-13.2) | 49,997 (49,997-49,998) | 0.16 (0.15-0.17) | 56 (50-130) | 16.3 (13.8-31.8) | 16.3 (13.8-31.8) | 2.1 (1.8-3.1) | 35.9 (32.2-49.6) | 519 | 3 |
| 100,000 | (e) fatlog | - | 1,135 (1,070-1,252) | 343.8 (278.8-461.7) | 53.7 | 28.2 | 49,998 (49,998-49,999) | 0.12 (0.11-0.12) | 28 (27-30) | 17.8 (17.6-19.0) | 17.8 (17.6-19.0) | 1.5 (1.5-1.7) | 21.1 (19.4-32.4) | 465 | 3 |
| 1,000,000 | base (refold) | - | 1,414 (1,293-1,452) | 0.0 (-121.0-38.7) | 23.1 | 12.8 | 49,999 | 0.11 (0.11-0.11) | 53 (50-55) | 29.5 (27.1-33.0) | 29.5 (27.1-33.0) | 1.5 (1.5-1.5) | 91.4 (85.8-110.3) | 712 (712-712) | 3 |
| 1,000,000 | (a) rev | - | 1,679 (1,566-1,768) | 264.8 (152.7-353.9) | 45.1 | 22.1 | 49,999 (49,998-49,999) | 0.12 (0.12-0.13) | 62 (50-62) | 32.1 (27.4-38.1) | 32.1 (27.4-38.1) | 1.5 (1.5-1.5) | 89.0 (84.2-132.5) | 721 | 3 |
| 1,000,000 | (a) revleaf | - | 1,587 (1,562-1,644) | 173.6 (148.5-230.4) | 16.1 | 51.2 | 49,999 | 0.12 (0.12-0.13) | 73 (63-74) | 44.6 (39.9-47.0) | 44.6 (39.9-47.0) | 1.5 (1.5-1.6) | 94.0 (84.3-95.5) | 683 | 3 |
| 1,000,000 | (d) diff (Baker) | - | 1,638 (1,580-1,744) | 223.8 (166.3-330.1) | 101.5 | 22.8 | 49,998 | 0.13 (0.12-0.14) | 114 (106-119) | 22.6 (21.6-23.3) | 22.6 (21.6-23.3) | 1.6 (1.5-2.6) | 113.7 (90.3-151.0) | 802 | 3 |
| 1,000,000 | (b) ckpt | 10,000 | 50,175 (44,829-50,460) | 48,761 (43,415-49,046) | 2,978 | 13,317 (13,317-13,317) | 19,581 (18,521-21,193) | 0.99 (0.99-0.99) | 373 (364-380) | 19.3 (14.8-22.1) | 12.7 (10.0-13.4) | 548.9 (526.4-564.7) | 604.0 (587.2-632.8) | 4,086 (4,058-4,114) | 3 |
| 1,000,000 | (c) imm (Immutable.js) | - | 7,065 (7,014-7,399) | 5,652 (5,600-5,985) | 1,695 | 115.8 | 49,997 (49,995-49,997) | 0.29 (0.27-0.29) | 2,208 (2,129-2,267) | 56.5 (55.4-68.1) | 49.8 (35.2-50.9) | 22.4 (21.1-23.4) | 73.3 (65.8-87.6) | 3,220 (3,220-3,221) | 3 |
| 1,000,000 | (c) hamt (here) | - | 5,830 (5,430-6,068) | 4,416 (4,016-4,654) | 1,436 | 67.0 (67.0-67.1) | 49,998 (49,984-49,998) | 0.22 (0.20-0.23) | 1,939 (1,871-1,983) | 70.8 (67.9-88.5) | 50.2 (48.1-53.5) | 20.7 (19.0-21.1) | 79.0 (74.5-95.5) | 2,804 (2,804-2,804) | 3 |
| 1,000,000 | (e) fat | - | 2,382 (2,356-2,450) | 968.4 (942.7-1,036) | 218.7 | 17.8 (17.3-18.0) | 49,998 | 0.19 (0.18-0.20) | 203 (185-205) | 21.6 (17.6-21.8) | 21.6 (17.6-21.8) | 1.9 (1.8-1.9) | 131.5 (124.3-154.4) | 958 | 3 |
| 1,000,000 | (e) fatlog | - | 1,761 (1,726-1,964) | 347.5 (311.9-549.7) | 75.7 | 50.2 | 49,998 | 0.15 (0.13-0.15) | 31 (25-32) | 19.5 (15.4-20.1) | 19.5 (15.4-20.1) | 1.6 (1.5-1.8) | 21.9 (17.5-23.6) | 723 | 3 |

load average at the start of each process: median 1.34, range 0.65-2.11, n=57

### Node: stepping through versions (cursor starts at the newest version, about 1,500,000)

back and fwd: one step; mean of a batch of 1,000 where each step is under 100 µs, else the median of single steps. jump: to a random version (the mean of a batch of 1,000 where cheap, else the median and p90 of up to 50). read: one row at a random version, the cursor left where it is (median, p90 over up to 1,000; a batch mean in brackets where cheap). picture: a frozen whole picture at a random version (median of up to 10); for (c) a root, and "as a Map" turns it into a plain Map (what data can adopt). checks: reads, pictures, pictures again after the cursor moved, and the cursor itself, against a refold from the start.

| rows | way | K | step back | step forward | jump | jump p90 | read p50 | read p90 | read mean | picture p50 | picture as a Map | timer ns | checks wrong | no-copy picture changed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 100,000 | base (refold) | - | 895 ms (842 ms-903 ms) | 2.87 µs (2.78 µs-3.46 µs) | 246 ms (243 ms-266 ms) | 597 ms (532 ms-621 ms) | 25 ms (23.7 ms-28 ms) | 48 ms (43.8 ms-49.9 ms) | - | 568 ms (529 ms-584 ms) | - | 96 (95-193) | 0 of 1812 | yes |
| 100,000 | (a) rev | - | 1.24 µs (856 ns-1.6 µs) | 573 ns (542 ns-1.1 µs) | 215 ms (194 ms-216 ms) | 457 ms (425 ms-518 ms) | 4.09 ms (3.96 ms-4.17 ms) | 22.6 ms (21.8 ms-23.1 ms) | - | 213 ms (212 ms-298 ms) | - | 138 (118-172) | 0 of 1812 | yes |
| 100,000 | (a) revleaf | - | 697 ns (675 ns-1.13 µs) | 266 ns (255 ns-327 ns) | 304 ms (260 ms-319 ms) | 554 ms (551 ms-582 ms) | 25.9 ms (25.5 ms-26.1 ms) | 47 ms (45.3 ms-48.7 ms) | - | 237 ms (208 ms-267 ms) | - | 92 (91-97) | 0 of 1812 | yes |
| 100,000 | (d) diff (Baker) | - | 506 ns (506 ns-596 ns) | 336 ns (331 ns-370 ns) | 175 ms (174 ms-207 ms) | 417 ms (392 ms-439 ms) | 2.19 ms (2.17 ms-2.51 ms) | 14.4 ms (13.7 ms-14.8 ms) | - | 156 ms (120 ms-158 ms) | - | 130 (125-145) | 0 of 1812 | yes |
| 100,000 | (b) ckpt | 1,000 | 28.3 ms (27.8 ms-29.4 ms) | 1.19 µs (893 ns-1.23 µs) | 26.1 ms (25.6 ms-26.6 ms) | 32.8 ms (31.4 ms-37.8 ms) | 23.3 µs (23.2 µs-24.2 µs) | 40.5 µs (39.5 µs-42.6 µs) | 22.6 µs (21.7 µs-23.2 µs) | 26 ms (25.4 ms-26.8 ms) | - | 160 (130-174) | 0 of 1812 | - |
| 100,000 | (b) ckpt | 10,000 | 33.3 ms (31.4 ms-36.4 ms) | 1.08 µs (918 ns-1.17 µs) | 30.9 ms (30.1 ms-34.3 ms) | 47.1 ms (46.3 ms-47.2 ms) | 193 µs (175 µs-208 µs) | 352 µs (322 µs-393 µs) | - | 31 ms (30.6 ms-38 ms) | - | 96 (95-140) | 0 of 1812 | - |
| 100,000 | (c) imm (Immutable.js) | - | 61 ns (58 ns-71 ns) | 53 ns (46 ns-72 ns) | 63 ns (59 ns-84 ns) | - | 5.77 µs (5.62 µs-5.96 µs) | 7.49 µs (7.34 µs-9.94 µs) | 6.82 µs (5.65 µs-9.68 µs) | 1.13 µs (1.02 µs-1.23 µs) | 99.5 ms (80.5 ms-116 ms) | 92 (92-98) | 0 of 1812 | - |
| 100,000 | (c) hamt (here) | - | 58 ns (57 ns-72 ns) | 56 ns (51 ns-66 ns) | 69 ns (63 ns-85 ns) | - | 4.88 µs (4.78 µs-5.14 µs) | 6.35 µs (6.1 µs-6.5 µs) | 4.94 µs (4.63 µs-14.4 µs) | 958 ns (794 ns-1.16 µs) | 63.6 ms (61.6 ms-84.9 ms) | 90 (90-115) | 0 of 1812 | - |
| 100,000 | (e) fat | - | 72 ns (59 ns-89 ns) | 58 ns (54 ns-64 ns) | 74 ns (65 ns-81 ns) | - | 2.35 µs (2.27 µs-3.04 µs) | 3.52 µs (3.36 µs-4.53 µs) | 2.26 µs (2.01 µs-2.63 µs) | 59.1 ms (56 ms-66 ms) | - | 132 (94-155) | 0 of 1812 | - |
| 100,000 | (e) fatlog | - | 155 ns (127 ns-233 ns) | 57 ns (42 ns-71 ns) | 114 ns (57 ns-141 ns) | - | 2.33 µs (2.26 µs-3.08 µs) | 4.24 µs (4.22 µs-5.56 µs) | 3.73 µs (2.38 µs-6.32 µs) | 199 ms (186 ms-206 ms) | - | 170 (134-190) | 0 of 1812 | - |
| 1,000,000 | base (refold) | - | 2.11 s (2.06 s-2.15 s) | 2.11 µs (1.82 µs-3.44 µs) | 1 s (987 ms-1.13 s) | 1.67 s (1.64 s-2.07 s) | 20.9 ms (20.7 ms-23 ms) | 39.3 ms (37.5 ms-41.3 ms) | - | 1.36 s (1.29 s-1.37 s) | - | 135 (134-136) | 0 of 1812 | yes |
| 1,000,000 | (a) rev | - | 668 ns (654 ns-974 ns) | 510 ns (458 ns-718 ns) | 303 ms (292 ms-363 ms) | 913 ms (910 ms-970 ms) | 11.2 ms (10.8 ms-11.4 ms) | 31.6 ms (30.9 ms-32.7 ms) | - | 838 ms (782 ms-959 ms) | - | 130 (127-132) | 0 of 1812 | yes |
| 1,000,000 | (a) revleaf | - | 830 ns (819 ns-1.72 µs) | 347 ns (296 ns-846 ns) | 481 ms (472 ms-518 ms) | 1.03 s (907 ms-1.12 s) | 23.2 ms (23 ms-25 ms) | 40 ms (38.2 ms-41 ms) | - | 1.09 s (997 ms-1.2 s) | - | 129 (125-181) | 0 of 1812 | yes |
| 1,000,000 | (d) diff (Baker) | - | 705 ns (549 ns-733 ns) | 450 ns (442 ns-483 ns) | 336 ms (319 ms-341 ms) | 733 ms (729 ms-773 ms) | 6.81 ms (6.43 ms-6.84 ms) | 17.7 ms (17.3 ms-17.8 ms) | - | 912 ms (841 ms-924 ms) | - | 132 (128-133) | 0 of 1812 | yes |
| 1,000,000 | (b) ckpt | 10,000 | 453 ms (426 ms-499 ms) | 2.14 µs (2.09 µs-2.18 µs) | 460 ms (430 ms-515 ms) | 558 ms (519 ms-629 ms) | 178 µs (167 µs-187 µs) | 334 µs (302 µs-340 µs) | - | 487 ms (434 ms-494 ms) | - | 92 (91-92) | 0 of 1812 | - |
| 1,000,000 | (c) imm (Immutable.js) | - | 56 ns (56 ns-60 ns) | 52 ns (52 ns-54 ns) | 64 ns (63 ns-66 ns) | - | 6.65 µs (6.05 µs-6.94 µs) | 8.07 µs (7.19 µs-8.37 µs) | 6.68 µs (5.98 µs-15.1 µs) | 940 ns (726 ns-1.09 µs) | 1.07 s (1.03 s-1.15 s) | 96 (93-96) | 0 of 1812 | - |
| 1,000,000 | (c) hamt (here) | - | 57 ns (53 ns-68 ns) | 53 ns (50 ns-55 ns) | 65 ns (64 ns-87 ns) | - | 6.35 µs (5.95 µs-6.9 µs) | 7.96 µs (7.37 µs-8.43 µs) | 10.4 µs (5.64 µs-14.4 µs) | 1.13 µs (916 ns-1.48 µs) | 894 ms (856 ms-909 ms) | 92 (88-94) | 0 of 1812 | - |
| 1,000,000 | (e) fat | - | 59 ns (57 ns-65 ns) | 54 ns (54 ns-55 ns) | 70 ns (68 ns-103 ns) | - | 2.34 µs (2.24 µs-2.92 µs) | 3.61 µs (3.3 µs-4.37 µs) | 2.05 µs (1.94 µs-6.89 µs) | 631 ms (557 ms-651 ms) | - | 95 (93-121) | 0 of 1812 | - |
| 1,000,000 | (e) fatlog | - | 124 ns (122 ns-176 ns) | 42 ns (40 ns-56 ns) | 60 ns (58 ns-84 ns) | - | 2.11 µs (1.9 µs-2.86 µs) | 3.58 µs (3.46 µs-4.65 µs) | 2.03 µs (1.9 µs-2.95 µs) | 1.45 s (1.39 s-1.54 s) | - | 140 (137-199) | 0 of 1812 | - |

### One hot row: a tenth of all writes go to one row (HOT=0.1), fat nodes

The same history, plus one row `hot` that takes 10% of all records (about 150,000 versions by the end). "read" is a random row at a random version; "read hot" is the hot row at a random version.

| rows | way | ns per write | kept B per version | read p50 | read hot p50 | read hot p90 | read hot max | picture p50 | checks wrong | runs |
|---|---|---|---|---|---|---|---|---|---|---|
| 1,000,000 | (e) fat | 2,004 (1,926-2,289) | 207.9 | 2.22 µs (2.06 µs-2.58 µs) | 1.17 µs (1.1 µs-1.53 µs) | 1.71 µs (1.68 µs-2.16 µs) | 98 µs (85.7 µs-120 µs) | 642 ms (614 ms-680 ms) | 0 of 1812 | 3 |
| 1,000,000 | (e) fatlog | 1,601 (1,575-1,620) | 80.3 | 1.94 µs (1.93 µs-1.96 µs) | 301 µs (299 µs-302 µs) | 579 µs (574 µs-605 µs) | 1.62 ms (1.56 ms-5.44 ms) | 1.47 s (1.33 s-1.51 s) | 0 of 1812 | 3 |

load average at the start of each process: median 1.18, range 0.99-1.73, n=6


### data: what the live fold pays to keep reverse records (fero v4 seam, data 63fea66)

base = `substrate.applyRec` per record (one data commit per record); sink = plus a data sink that does nothing; prev = plus a sink keeping each delta's `prev` (the row before the commit, by reference); prev256 = the lane with 256 records a call and the same sink. 1,000,000 records.

| rows | mode | ns per record | extra ns over base | kept B per record | kept B over base | garbage B per record | deltas per record | prev checked against the plain fold | runs |
|---|---|---|---|---|---|---|---|---|---|
| 100,000 | base | 2,586 (2,581-3,204) | 0.0 (-5.0-618.5) | -28.7 | 0.0 | 1,331 (1,330-1,331) | - | - | 3 |
| 100,000 | sink | 2,799 (2,721-2,843) | 213.0 (134.7-257.2) | -28.7 (-28.7--28.6) | 0.0 (0.0-0.1) | 1,443 (1,440-1,482) | - | - | 3 |
| 100,000 | prev | 2,681 (2,477-3,091) | 95.2 (-109.0-504.9) | 40.9 (40.8-40.9) | 69.6 (69.5-69.6) | 1,405 (1,402-1,444) | 1.000 | 0 wrong of 428,574 | 3 |
| 100,000 | prev256 | 1,426 (1,378-1,446) | -1,160 (-1,208--1,140) | 52.6 (52.5-52.6) | 81.3 (81.2-81.3) | 327.2 (326.6-327.6) | 0.999 | - | 3 |
| 1,000,000 | base | 3,352 (2,811-3,368) | 0.0 (-541.2-15.8) | -107.1 (-107.2--107.1) | 0.0 (-0.1-0.0) | 1,402 (1,401-1,405) | - | - | 3 |
| 1,000,000 | sink | 3,190 (2,932-3,254) | -161.7 (-420.2--97.4) | -107.1 | 0.0 | 1,554 (1,518-1,556) | - | - | 3 |
| 1,000,000 | prev | 3,170 (2,956-3,239) | -181.9 (-395.8--112.6) | 40.5 (40.4-40.5) | 147.6 (147.5-147.6) | 1,439 (1,402-1,441) | 1.000 | 0 wrong of 428,574 | 3 |
| 1,000,000 | prev256 | 2,163 (2,091-2,236) | -1,189 (-1,261--1,115) | 52.2 | 159.3 | 321.2 (320.2-322.3) | 1.000 | - | 3 |

load average at the start of each process: median 1.52, range 1.21-1.98, n=26

### What each record would carry: fero v4 codec bytes

| rows | records (field / whole row / new / remove) | log B per record | + prior leaf B per record | as share of the log | + prior whole row B per record | as share of the log |
|---|---|---|---|---|---|---|
| 100,000 | 447,609 / 451,789 / 48,176 / 52,426 | 71.4 | 58.6 | 82% | 108.3 | 152% |
| 1,000,000 | 447,609 / 451,789 / 48,176 / 52,426 | 73 | 58.4 | 80% | 108.8 | 149% |

### Rust: one persistent-map root per version (exact bytes from a counting allocator)

1,000,000 records. base and rev read and picture at the newest version only (a plain HashMap); im, imbl and rpds at a random version. read = mean of 100,000 in one batch; picture = into a std HashMap, median of 3.

| rows | way | ns per write | kept B per version | allocated B per write | read ns | picture ms | checks wrong | runs |
|---|---|---|---|---|---|---|---|---|
| 100,000 | base | 643.7 (581.5-681.0) | 4.3 | 43.0 | 198.9 (191.8-214.0) | 6.7 (6.5-6.8) | - | 3 |
| 100,000 | rev | 747.7 (620.9-793.5) | 51.4 | 59.7 | 239.6 (202.0-256.0) | 6.8 (6.6-7.5) | - | 3 |
| 100,000 | im | 7,100 (6,610-7,475) | 4,290 (4,289-4,292) | 4,329 (4,327-4,330) | 1,087 (1,078-1,294) | 42.5 (41.7-45.8) | 0 of 1,680 | 3 |
| 100,000 | imbl | 6,210 (5,573-6,452) | 3,756 (3,756-3,757) | 3,803 (3,803-3,803) | 3,170 (3,103-5,399) | 33.9 (33.6-44.1) | 0 of 1,680 | 3 |
| 100,000 | rpds | 4,569 (4,550-4,752) | 1,525 (1,525-1,525) | 1,571 (1,571-1,571) | 2,166 (2,080-2,361) | 72.8 (67.0-81.1) | 0 of 1,680 | 3 |
| 1,000,000 | base | 849.1 (758.1-879.1) | 27.6 | 43.0 | 388.6 (356.0-410.8) | 96.2 (95.4-100.7) | - | 3 |
| 1,000,000 | rev | 847.4 (844.6-905.6) | 51.4 | 59.7 | 356.2 (342.0-369.9) | 98.1 (95.2-100.5) | - | 3 |
| 1,000,000 | im | 10,222 (9,389-10,368) | 4,913 (4,912-4,913) | 4,960 (4,959-4,960) | 1,374 (1,217-1,604) | 606.6 (527.0-657.4) | 0 of 1,680 | 3 |
| 1,000,000 | imbl | 10,369 (9,678-10,478) | 4,538 (4,538-4,538) | 4,590 (4,590-4,590) | 1,829 (1,592-1,873) | 458.2 (417.3-468.9) | 0 of 1,680 | 3 |
| 1,000,000 | rpds | 10,136 (9,673-10,143) | 1,931 | 1,976 (1,976-1,976) | 1,813 (1,600-1,876) | 837.4 (835.8-936.7) | 0 of 1,680 | 3 |

load average at the start of each process: median 1.48, range 1.09-1.82, n=30
<!-- tables:end -->

"kept B per version" is the heap after the history minus the heap before it, both after a full collection, divided by the 1,000,000 versions. For `base` it is the live rows' own churn (7-23 B). For the `data` table, "kept B over base" is the mode's kept bytes minus the plain fold's, which is what keeping `prev` holds; the plain fold's own figure is negative: the rows the history replaced took more heap than the rows it wrote (the start's rows are decoded from fero frames, the history's are built in place; why was not looked into).
<!-- results:end -->

## What the numbers say

**1. Every way that keeps a version per write pays for it in memory, and a HAMT pays most.** Per version kept, at 1e5 and 1e6 rows: reverse records with only the old field 16-30 B, with the old row 45-49 B, fatlog 54-76 B, Baker's rerooting 102-106 B, fat nodes in JavaScript arrays 104-219 B (most of it the arrays' spare room), a HAMT 1.3-1.7 KB, and checkpoints 0.4-3.7 KB. A million versions in a HAMT is 1.3-1.7 GB of heap in Node. The rows themselves are shared by every way (none copies a row); what differs is the structure around them.

**2. The write-path cost follows the memory.** (The fat-node pick is "fat", the per-row lists: +0.97-1.02 µs. "fatlog" is the layout finding 7 rejects.) On top of the plain fold (0.79 µs a write at 1e5 rows, 1.4 µs at 1e6): reverse records +0.17-0.26 µs, Baker +0.22-0.27 µs, fatlog +0.34-0.35 µs, fat +0.97-1.02 µs, the HAMT written here +3.3-4.4 µs, Immutable.js +5.3-5.7 µs, checkpoints +3.3-49 µs (+28 µs at K = 1,000). Much of the HAMTs' extra is the collector: 2-3 s of GC while building a million versions, against 0.02-0.4 s for every other way except checkpoints.

**3. Under steady writes, only the HAMTs and the checkpoints hurt latency.** At 50,000 writes a second for 10 s, the plain fold spends 0.5% of the time in GC and its event-loop p99 is 1.5 ms. Reverse records, Baker and fatlog stay there (0.3-1.1% in GC, p99 1.5-1.6 ms), and fat nearly so (0.6-2.0%, p99 1.9-2.1 ms). A HAMT with every version kept spends 15-22% of the time in GC, with p99 17-22 ms and longest pauses of 26-71 ms: its nodes all survive, so collections keep copying and marking them. Checkpoints stall the loop for each copy (p99 7 ms at 1e5 rows and K = 10,000; 110 ms at K = 1,000; 549 ms at 1e6 rows), and fall behind the 50,000 a second (31,500 and 19,600).

**4. For jumps, the O(1) ways win by about six orders of magnitude.** HAMT, fat and fatlog: a step or a jump is a number (40-160 ns, most of it the loop around it), and a row at a version costs 2.1-6.7 µs. Reverse records and Baker: a step costs 0.3-1.2 µs, but a jump costs the distance (0.18-0.48 s for a random one in 1.5 million versions), and a row read away from the cursor scans the log (2.2-26 ms). Checkpoints: a jump or a step back is a copy of every row (26-33 ms at 1e5 rows, 0.45-0.46 s at 1e6). The plain refold, which is v4's viewer's way: 0.25-1.0 s a jump and 0.9-2.1 s a step back.

**5. A whole picture costs O(rows) in every way, unless it stays a handle.** A HAMT root or a fat-node version number is a picture for free (about 1 µs, or nothing), read one row at a time. Turned into a plain Map, the form `data` adopts, a HAMT root costs 64-100 ms at 1e5 rows and 0.89-1.07 s at 1e6 (E-06 measured 0.72 s for Immutable.js to an object). The copy-based ways cost the same order: 0.16-0.24 s at 1e5 rows and 0.84-1.09 s at 1e6, walking included. Fat nodes must look up every row ever seen: 59-199 ms at 1e5, 0.63-1.45 s at 1e6.

**6. Rust does not change the choice.** With rows shared by `Arc` as in Node, a plain `HashMap` fold costs 0.64-0.85 µs a write, and reverse records add at most 0.1 µs and 51 B a version, about as in Node. The persistent maps cost 4.6-7.1 µs a write at 1e5 rows and 10.1-10.4 µs at 1e6 (the medians of these three runs; the review's two reruns at 1e6 rows gave `im` 8.1-10.2 µs and `rpds` 8.0-8.2 µs, with the counting allocator and with the system allocator alike, [results/rust-alloc.jsonl](results/rust-alloc.jsonl): so 8 to 10 µs, and the counting allocator is not the cause), and keep 1.5-4.9 KB a version: `im` and `imbl` keep fixed-size node chunks (3.8-4.9 KB), `rpds` keeps only the used slots (1.5-1.9 KB). They are slower than Node's own HAMT per write. A likely reason: a path copy in Rust clones each sibling entry, and each clone of an `Arc` key or row is an atomic count change, where JavaScript copies plain pointers (reasoned, not profiled). A read at a random version costs 1.1-3.2 µs.

**7. A hot row is fatlog's weak spot** (the hot-row table). With a tenth of all writes on one row (about 150,000 versions of it), reading that row at a random version walks its chain: 0.3 ms at the median, 0.58 ms at p90, 1.6-5.4 ms at worst. Per-row arrays with a binary search read it in 1.2 µs (p90 1.7 µs). The other rows are not slowed. A real reader would use the back-pointer for rows with few versions and a sorted per-row index for the rest, or grow per-row typed arrays by doubling, which cuts the spare room plain arrays keep (reasoned; not built).

## What in fero needs to step through versions

| need | what it does | the structure it needs | where it lives |
|---|---|---|---|
| **The timeline viewer and `fero debug`** (V5-4; LAYERS 4.4; PATHS 4.10) | scrub a window of history: step, jump, show the rows on screen and what changed | fat nodes (a version list per row) over the window it reads, built while it folds; data's `prev` for free if it only steps | the viewer only. LAYERS already makes it a subscriber of each log |
| **The debugger today** (v4: tools/debug/model.mjs:178, `stateAt`) | replays a node's journal from the start to every step | the same: a step there is a refold from the start (0.9-2.1 s a step back at these sizes, measured as `base`) | the viewer |
| **Tapes and reruns** (P-18, TEST-07) | rerun input i on the state just before it, in tape order | reverse records: E-06's undo, 0.03-0.05 ms a rerun | the test runner |
| **Forks** (P-18; `fero.fork(name, { at })`, API.md:1017) | a new resource from a cut of the parent | none in memory: in storage a fork is one record per group (LAYERS `forks`); to run it, one fold from the parent's snapshot to the cut, O(rows) once (E-06: 2.6 s at 1e6 rows) | storage, then one fold |
| **Restore** (`fero restore`, API.md:1221) | cut a resource's log at a position and rebuild | none: one forward fold from the nearest snapshot | an admin step |
| **As-of reads** | `changes({ of, from: version })` (API.md:1178) reads records from a position; no call reads a row or a picture "as of" a version | none today. If one is added (a row's history, an audit page), it is a reader over that row's records: a filtered `changes`, or fat nodes on the reader | the reader |

**So nothing that needs versions sits on the live write path** (reasoned from the table). Each one is a reader of the log that already exists. Should fero use one, as the owner asked? Not on the live path, where it would cost every write on every copy 0.2-5.7 µs and 16 B to 1.7 KB of memory (a version kept per write), for features that run in one reading process (reasoned). On the reader, yes: fat nodes, a version list per row, over the part of the log it reads.

## What is safe

- **Rows are shared, never copied, and never changed.** `data` writes a new row for every change and leaves the old one as it was (`pathCopy`, code: data kernel/node.ts:275; "rows are immutable post-write by the path-copy law", data api/index.ts:153). So an old row held by any structure stays right for ever. `snapshot({ freeze: true })` turns a silent change into a loud error, once per row (data api/index.ts:156).
- **Frozen by construction**: a HAMT root and a fat-node version number. Checked here: both pictures were still right after the cursor went to version 0, the newest version and back, in every run. Neither can be changed by anyone.
- **Frozen only by a copy**: reverse records, Baker, checkpoints and the plain refold hand out a fresh Map, O(rows). The shortcut, handing out the cursor's own table, changed under the reader in every run that tried it ("no-copy picture changed: yes").
- **Not safe to share: Baker's table.** Reading another version moves the one table there. Two readers at two versions move it back and forth, and a live write at the newest version would first move it back (a stall of the distance). This is why it cannot sit on the live path, and why reverse records do the same job more simply on a linear log (reasoned).
- **A fat-node picture lives as long as its records.** It points into the log, so a reader holding version v keeps that part of the log, as `changes()` readers already do through `history` (they get `expired` past it).
- **A picture handed to `data` must be a copy.** `data` writes into an object it adopts (E-06), so it must never adopt a picture someone else holds.
- **Key order** (E-06's finding): a HAMT has no insertion order. A picture from it handed to `data` iterates in another order than the resource. Reverse records put a removed row back at the end. `data` owes "a removed row restored at its old key" (LAYERS 3.4); a viewer that shows rows sorted needs neither.

## What a fero record must carry

- **For reverse records, the prior value.** `data` already computes it on every write, as `UpdateDelta.prev` (the whole prior row, by reference, shared with the new row's unchanged fields; code: data contract/delta.ts:44, kernel/node.ts:444-466) and `RemoveDelta.prev`. A sink receives it with no copy. It matched the plain fold in every check (table above).
- **Per batch, not per record.** `data` merges a batch to one delta per row, keeping the first `prev` (code: data contract/delta.ts:101-103). v5 folds one batch per lane call (LAYERS 3.4), so a reader gets the row before the batch. Nobody can see a state inside a batch, so the batch is the honest step. A viewer that wants to step record by record inside a batch can work out the in-between rows from the batch's own records (reasoned).
- **Where it lives: only the reader.** A reader that folds forward from a snapshot has every `prev` for free. Only a reader that starts at "now" and steps back past its start would need the log to carry it. It can instead fold from the nearest snapshot. The wire format already allows a `prev` (data contract/index.ts:35, the leaf at the path), but carrying it costs 58-108 B on every 71-73 B record (80-150%) on disk, on the wire, and on every copy (measured). It is not worth it.

## What it leaves out

- **One shape of resource.** Small rows (about 100 B), writes spread evenly over the rows, plus one hot row in the hot-row test. Rows of 2 KB would not change the structures' own costs, since rows are shared, but would change what a copy-based picture costs (reasoned).
- **The structures, not `data` rewritten.** The ways here are built beside a plain Map. A `data` whose store is itself a HAMT was not built. The first form of this page reasoned its cost from the runs that kept every root (+3.3-5.7 µs a write). That was about twice too high, because most of that cost is the collector keeping every old node alive. **Measured in the review** ([bench/hamtstore.mjs](bench/hamtstore.mjs): this experiment's own HAMT and tape, only the newest root kept, a store with no versions; 3 runs under the timing lock, [results/hamtstore.jsonl](results/hamtstore.jsonl)):

  | rows | a `Map`, ns a write | the HAMT as a store, ns a write | **added a write** | collector, ms per million writes: `Map` / HAMT store | the HAMT keeping every root, ns a write |
  |---|---|---|---|---|---|
  | 100,000 | 614-756 | 1,844-2,498 | **+1.1 to +1.8 µs** | 17-22 / 350-486 | 4,093-4,937 |
  | 1,000,000 | 1,263-1,374 | 3,339-3,543 | **+2.0 to +2.2 µs** | 106-118 / 751-831 | 4,594-4,875 |

  So a HAMT store costs 2.4 to 3.6 times the plain fold, and the old paths become garbage (the collector's work rises 6 to 28 times). "Not planned" still holds. What it would buy is an O(1) snapshot, so O(1) forks and frozen pictures (E-06's finding). Views over such a store were not measured. This is the structures' own cost, not `data`'s whole fold.
- **The viewer itself.** No timeline viewer was built. Its window (how many versions it holds) is a product choice; the per-version costs above let it be sized: 1e5 versions of fat nodes take about 10-22 MB as per-row lists (5-8 MB as fatlog), of a HAMT about 130-170 MB.
- **On disk.** Every way here is in memory. A log on disk with snapshots (V5-1) is the history; these structures are what a reader builds from it.
- **A browser.** The viewer may run in one. The costs were measured in Node 22 on this box only.
- **Other Rust maps.** `im`, `imbl` and `rpds` only; a HAMT tuned for this (no atomic counts, a pool) might do better. Rust's reverse records were measured; Baker and fat nodes in Rust were not.
- **Transients and node copying** (the O(1)-amortised combination of Driscoll et al.) were not built.

## How to rerun

```sh
./fetch.sh            # Immutable.js 5.1.9 (E-06's fetch.sh) and the Rust crates in rust/Cargo.lock
./run.sh setup        # E-06's tree.sh (fero's seam + data), the Rust build
./run.sh timing       # 3 runs, one timing hold each (about 20 minutes a run on this box)
./run.sh hot          # 3 runs of the hot-row test
./run.sh hamtstore    # the review's follow-up: a HAMT as a store (only the newest root kept) against a Map
./run.sh summary      # the tables (python3 summarize.py)
```

Env: `SP` (a scratch folder of your own, required: it holds `bin/timing`, `dl/` and the build tree; nothing in this folder points at one), `NODE` (default `node` on PATH), `RUNS`, `SIZES`. Raw lines are in [results/](results): `structs.jsonl`, `hot.jsonl`, `live.jsonl`, `rust.jsonl`, each process preceded by its load average; and the review's `hamtstore.jsonl` (its first 6 lines are the reviewer's two runs, with no load line) and `rust-alloc.jsonl` (the Rust ways again, with the counting allocator and with the system allocator).

## Verdict

**Version structures belong on the reader, never on the live write path; on the reader, fat nodes.** Every way to keep a version per write costs the write path something, and the owner's two (a HAMT, or Baker's rerooting) cost it the most or give the least: a HAMT root per write adds 3.3-5.7 µs a write and 1.3-1.7 KB a version, and 15-22% of the time goes to GC (as a store with no versions kept it still adds 1.1-2.2 µs a write); rerooting is reverse records with twice the memory and an unsafe shared table. No feature that needs versions (the timeline viewer, the debugger, tapes, forks, restore) runs on the live path: each is a reader of the log V5-1 already keeps. On a reader, fat nodes as per-row lists give O(1) steps and jumps, a row at any version in about 2 µs, and frozen pictures as version numbers, for about +1.0 µs a record and 104-219 B a version beside a `Map` (6 to 14 times less than a HAMT), and +1.5-2.0 µs and 103-285 B on `data`'s real fold (E-55). Reverse records are smaller still and serve walking in order (E-06's reruns). A record carries nothing new: `data`'s `prev` already gives the prior row per batch, and putting it in the log would add 80-150% to every record.

Q-54: the owner's two are path copying in a HAMT (O(log32 n) a write and a read; Clojure, Immutable.js, im, imbl, rpds) and Baker's rerooting (O(1) at the version holding the table, the distance elsewhere); on the live write path none of the five ways belongs: a HAMT root per write adds 3.3-5.7 µs to a 0.79-1.4 µs fold and keeps 1.3-1.7 KB a version, with 15-22% of the time in GC and event-loop p99 17-22 ms against 1.5 ms (as a store with no versions kept, +1.1-2.2 µs a write, measured in the review; Rust's im, imbl and rpds: 8-10 µs a write and 1.9-4.9 KB a version at 1e6 rows), checkpoints every 10,000 records at 1e6 rows stall the loop (p99 549 ms) and fall to 19,600 writes a second, and reverse records, the cheapest (+0.17-0.26 µs, 16-49 B a version), still serve no live reader; on a reader, fat nodes as per-row sorted lists (the pick) give steps and jumps under 0.2 µs, a row at any version in 2.1-2.4 µs, a 150,000-version row in 1.2 µs and frozen pictures as version numbers, for +0.97-1.02 µs a record and 104-219 B a version beside a Map, 6-14 times less than a HAMT, and +1.5-2.0 µs and 103-285 B on data's real fold (E-55); a back-pointer chain is smaller (54-76 B, +0.34-0.35 µs) but reads a 150,000-version row in 0.3 ms, so it is not picked, while reverse records and rerooting step in 0.3-1.2 µs but jump in 0.18-0.48 s and need an O(rows) copy per frozen picture (0.16-1.1 s); a fero record needs no prior value, since data's UpdateDelta.prev gives the prior row by reference per batch (0 wrong in 857,148 checks; 70-150 B a record to keep, no time we could see), and carrying it in the log would add 58-108 B to a 71-73 B record (80-150%). Moves: no candidate up or down (every row keeps the log as its history and folds with data the same way); V5-1 stands as written (the log is the history; versions are a reader's structure); the timeline viewer (LAYERS 4.4, PATHS 4.10) and `fero debug` gain a stated structure, fat nodes over the window they read, built while they fold (a library on the reader, 0 rules); TEST-07 stays met by E-06's undo; the wire and log formats carry no prior value; DATA-04 gains nothing (E-06's removed-row key position stays its one item); a data store rewritten as a HAMT is not planned (+3.3-5.7 µs and 1.3-1.7 KB of garbage per write, for O(1) snapshots only forks and the viewer would use); moving data to Rust does not change any of this.
