# E-29: the power-loss test tier, and what a full disk needs

**Question (Q-29, [QUESTIONS.md](../../QUESTIONS.md) §7).** Two parts.
(a) Can this box run the power-loss test tier that F-01 and F-10 need from phase 2? The tier uses LazyFS, a filesystem that holds unsynced writes in memory and can drop them, as a power cut does.
(b) How much disk must L0 (the storage layer) keep in reserve for a full disk, and in what order does it refuse work (F-20)?

**Threshold.** (a) It works → the tier is planned on this box. Blocked → say exactly why, and plan a disk model in the simulator plus a second box. (b) The reserve per kind of operation and the refusal order are written into L0's format now (DEV-09).

It decides no candidate. It prevents a surprise in phase 2.

## What was built

| File | What |
|---|---|
| [journal.mjs](journal.mjs) | A small journal in the shape L0 would have: batches with a checksum and a chained sequence number, segment files, write then sync, recovery that cuts a torn tail, a reserve. 128 lines. It is a test object, not fero's journal. |
| [lazyfs.sh](lazyfs.sh) | Starts and stops LazyFS 0.3.1 and cuts the power. |
| [a_probe.mjs](a_probe.mjs) | What LazyFS models: 13 small probes. |
| [a_powerloss.mjs](a_powerloss.mjs) | The tier: a writer on LazyFS, a power cut, a recovery, and an oracle outside LazyFS. Four scenarios, four broken journals (mutants). |
| [fs64.sh](fs64.sh) | Makes a 64 MB tmpfs or a 64 MB ext4 on a loop device. |
| [b_solo.mjs](b_solo.mjs) | A solo journal writer with rows, a snapshot and a retention pass, on a 64 MB filesystem. |
| [b_pipeline.mjs](b_pipeline.mjs), [b_pipeline_run.mjs](b_pipeline_run.mjs) | E-02's pipeline shape (a leader and two followers, three OS processes, a batch commits at a majority) with what a full disk needs added. |

Run it: `./fetch.sh`, then `./run.sh` (about 18 minutes, as root, through the heavy lock). Raw output: [results/](results). Machine: 4 vCPU, 15 GB, Linux 6.18 (a Firecracker VM), Node 22.22.0, LazyFS 0.3.1 (git 045a0b3), libfuse 3.14.0, e2fsprogs 1.47.0. This is not a timing run; the box was shared (load 4 to 12).

## Part (a): the power-loss tier

### What LazyFS models (measured: [results/a-lazyfs-model.jsonl](results/a-lazyfs-model.jsonl))

| Probe | After the power cut | Is the loss modelled? |
|---|---|---|
| a write with no sync | the file is empty | yes |
| a write, then fsync | the bytes are there | yes |
| a write that grows the file, then fdatasync | the bytes and the new size are there | yes |
| fdatasync, then more writes | only the synced part | yes |
| an unsynced overwrite inside a synced file | the old bytes are back | yes |
| a truncate with no sync | the old size is back | yes |
| fsync through a second descriptor of the file | the bytes are there | yes |
| a rename with no directory fsync | the new name is there | **no** |
| a create with no fsync | the (empty) file is there | **no** |
| an unlink with no directory fsync | the file is gone | **no** |
| mkdir, a synced file inside, no directory fsync | the file is there | **no** |
| fallocate | not supported | - |
| statfs through the mount | says 512-byte blocks and 0 MB free | - |

So LazyFS models lost data and lost sizes. It does not model a lost directory entry: names change at once.

### The test

The writer appends batches of 1 to 3 records of 10 to 6,000 bytes. Some batches are followed by a sync and so count as acknowledged; some are not. Then the power is cut. Then the journal recovers, as after a restart. An oracle in the test process (outside LazyFS) holds a checksum of every batch written. After each recovery it checks three things:

1. every acknowledged batch is there;
2. no batch is there that was never written;
3. what is there is one unbroken run of batches, each with the bytes that were written.

Four scenarios:

- **clear:** the power goes between writes (LazyFS's `clear-cache`). Every unsynced byte vanishes.
- **recycle:** the same, with small segments, a retention pass now and then, and retired segment files reused without clearing them. So old batches with good checksums lie after the new tail.
- **torn-op:** one write is cut into 2 to 4 parts and only some reach the disk; then LazyFS kills itself.
- **torn-seq:** of a run of writes with no sync between, only some reach the disk (say the 1st and the 4th); then LazyFS kills itself.

### Results (measured: [results/a-powerloss.jsonl](results/a-powerloss.jsonl), three seeds each)

| Scenario | Rounds | Acknowledged batches | Written, not synced | of those lost / kept | Torn tails cut | LazyFS deaths | Violations |
|---|---|---|---|---|---|---|---|
| clear | 1,200 | 2,997 | 2,956 | 2,954 / 2 | 0 | 0 | **0** |
| recycle | 1,200 | 3,012 | 2,971 | 2,533 / 438 | 391 | 0 | **0** |
| torn-op | 120 | 754 | 232 | 232 / 0 | 120 | 120 | **0** |
| torn-seq | 120 | 3,257 | 355 | 312 / 43 | 65 | 79 | **0** |

2,640 power cuts, 10,020 acknowledged batches, none lost, with the journal as it now stands. Unsynced batches that survive (kept) are allowed: a sync of a later batch, or a segment change, carried them.

**The tier found a real bug in the journal first.** The first full run had 2 violations in 1,200 `recycle` rounds: "an acknowledged batch is gone". The journal's recovery took leftover bytes in *any* segment for a torn tail, and deleted the segments after it. A reused segment that is not the last one has such leftovers, so recovery deleted later segments that held acknowledged batches. The fix is one rule: when a segment's run stops and the next segment's name is the sequence number wanted, carry on there; only when nothing carries on is it the tail. The old behaviour is kept as the mutant `eagerCut`.

### Does the tier catch a broken journal? (measured: [results/a-mutants.jsonl](results/a-mutants.jsonl))

Violations found, of rounds run:

| Broken journal | clear | recycle | torn-op | torn-seq |
|---|---|---|---|---|
| `noSync`: acknowledges without a sync | 128 of 150 | 109 of 150 | 18 of 25 | 21 of 25 |
| `noSeqCheck`: recovery takes any batch with a good checksum | 0 | 185 of 150 rounds (several a round) | 0 | 0 |
| `resync`: after a bad batch, recovery looks for the next good one and carries on | 0 | 224 | 0 | 11 of 25 |
| `eagerCut`: leftover bytes in any segment are a torn tail (the bug above) | 0 | 0 of 150; **2 of 1,200** | 0 | 0 |

Every mutant is caught by at least one scenario. Two lessons: a missing sync shows at once, in any scenario; the two recovery mistakes that "tolerate" bad bytes show only with reused segments or torn runs; and a rare one (`eagerCut`) needs more than a thousand rounds. The tier is fast enough for that: a `clear` round takes about 10 ms, a torn round about 1.4 s (LazyFS must be started again).

**Speed of the tier** (rough, the box was busy; [results/a-rate.jsonl](results/a-rate.jsonl)): 11,155 appends with a sync a second through LazyFS, against 3,379 on the plain disk beside it. LazyFS's sync does not reach the disk, so the tier is not slowed by fsync.

### What had to be learnt about LazyFS 0.3.1

- **Torn faults must be set in the config file.** Sent through the fifo, `torn-op` is accepted and never fires: `add_torn_op_fault` in `lazyfs.cpp` sets `int occurrence=1` and ignores the value given. The same fault in an `[[injection]]` block of the config works.
- **`occurrence` counts FUSE writes, and the kernel cuts a write at each 4 KB page end.** One `write()` of 4,680 bytes arrives as two. So a "torn write" tears at a page end, as real disks do.
- **After a torn fault LazyFS kills itself.** The mount is dead ("transport endpoint is not connected"). Drop it with `fusermount3 -uz` and mount again.
- **The "done" fifo needs one reader for the whole session.** A reader per power cut works once; the second cut then hangs.
- **A write that LazyFS dies under returns a short count** (3,179 of 4,680 bytes). The journal must treat a short count as "ask again": the next call gives the real error.
- **No fallocate, and statfs is wrong.** A journal with preallocated segments can run on LazyFS only by writing zeros, and its free-space check must look at another directory.

### What this tier cannot show

- **A missing directory fsync.** LazyFS keeps every create, rename and unlink. A journal that forgets to sync the directory after making a segment passes here and loses the segment on a real power cut. This needs the simulator's disk model, or a block-level tool (dm-log-writes, CrashMonkey), which needs kernel modules this VM was not checked for.
- **A failed fsync** (F-10: "one failed fsync stops acknowledgements"). LazyFS cannot make a sync fail. The journal has the rule (a failed sync is final), and nothing here tests it. It needs dm-error or dm-flakey, or the simulator.
- **A disk that lies about fsync, or loses one synced block** (F-22 is E-37's).
- **Real hardware.** Everything above is LazyFS's model of a power cut, not a power cut.

## Part (b): a full disk

Two 64 MB filesystems: a tmpfs, and an ext4 on a loop device (`mkfs.ext4 -m 0`, `data=ordered`). The ext4 has 54.7 MB for files; ext4 also holds back about 327 blocks (1.3 MB) that only its own metadata may use, so `bfree` never reads 0.

### Filled with no reserve, files that grow (measured: [results/b-solo.jsonl](results/b-solo.jsonl), part `naive`)

| | tmpfs | ext4 |
|---|---|---|
| writes of 1 KB before the refusal | 64,512 | 55,082 |
| where ENOSPC came | at a write, 0 of 1,040 bytes taken | **in the middle of a batch: 352 of 1,040 bytes taken** |
| with 0 bytes free: a remove, a term change, a member change, a retention mark | **all four refused** | all four passed, by luck: they fitted in the last block's unused part |
| a snapshot | refused | refused |
| reading a row | works | works |
| a restart after the refusals | no torn tail, nothing acknowledged lost | the same (the journal took the half batch back with a truncate) |
| deleting one old segment | works with 0 bytes free; frees 4 MB | the same |

So a full disk with no reserve cannot record a vote or a delete. And a file that grows can run out in the middle of a batch.

### What each kind of operation needs (part `cost`)

One operation per sync, until the disk refuses.

| Operation | Bytes in the journal | Done in 64 free blocks (tmpfs, growing file) | Done in 8 free blocks (ext4) | In a preallocated segment |
|---|---|---|---|---|
| remove one row (a 24 B key) | 56 | 4,751 | 582 | 18,722 in 1 MiB, **0 new blocks** |
| a term change or a vote (term, vote, commit) | 56 | 4,751 | 582 | 18,722, 0 new blocks |
| a member change (a 64 B list) | 96 | 2,771 | 339 | 10,921, 0 new blocks |
| a retention mark ("the log starts at s") | 48 | 5,543 | 679 | 21,842, 0 new blocks |
| a snapshot of 4,000 rows of 1 KB | 4.05 MB | - | - | - |

- A small record costs exactly its own bytes: 73 removes or votes fit in one 4 KB block. The filesystem adds nothing.
- Inside a preallocated segment an append takes no new block at all, on tmpfs and on ext4. (On ext4 the free-block count did not move through 1,500 synced appends.)
- A snapshot costs the rows' bytes, and while the new one is written the old one is still there. So the peak is one more snapshot. After the rename the old one's space is back.
- A retention pass (dropping whole segments below the snapshot) needs no new bytes: the unlink works at 0 bytes free.

### The rule that works, and the one that deadlocks (parts `policy` and `nohead`)

The rule: segments are preallocated (2 MiB); a fixed reserve (2 MiB here) is kept for the small privileged records; and data writes are refused while free space is under **the reserve plus room for one snapshot** (the rows' bytes × 1.05 + 64 KB). Rows: 12,000 of 1 KB.

| Step | With snapshot headroom (tmpfs / ext4) | Without it, reserve only (tmpfs / ext4) |
|---|---|---|
| filled until refused | after 48,385 / 40,321 writes, `disk-full`, 14 / 12.7 MB still free | after 62,496 / 52,416 writes, 2 / 2.7 MB free |
| the warning line at 80 % of the usable space | printed once | printed once |
| while full: read a row | ok | ok |
| while full: one more data write | refused `disk-full` | refused |
| while full: remove 500 rows, 200 term changes, a member change | all done | all done |
| snapshot, then drop the segments below it | 11.1 MB written, **48 / 40 MB freed** | **the snapshot fails: no room** |
| writes afterwards, with no operator | 3,000 of 3,000 taken | 0 taken |
| the way out | - | tmpfs: none, even after deleting every row by hand (the snapshot of nothing has no block to land in). ext4: only after deleting all 11,500 rows by hand |
| a restart | nothing lost, no torn tail | nothing lost, no torn tail |

Without room for a snapshot a full node is stuck: deleting rows does not free disk until a snapshot lets the log go, and the snapshot cannot be written.

A second bug was found here, in the rule itself: a privileged record opened a new segment out of the reserve, and data writes then filled the rest of that segment (1,986 of them). A segment opened from the reserve must be marked, so that data cannot ride in behind the record.

### Three processes ([results/b-pipeline-tmpfs.jsonl](results/b-pipeline-tmpfs.jsonl), [results/b-pipeline-ext4.jsonl](results/b-pipeline-ext4.jsonl))

E-02's own `pipeline.ts` cannot be filled: it throws on a short write and on a failed sync. The pipeline here has the same shape and adds the journal above, a follower that stops acknowledging, a resend, a leader that refuses, and a retention pass. 250 batches of 16 KB a second are offered (4 MB/s), each process on its own 64 MB filesystem.

| Step | tmpfs | ext4 |
|---|---|---|
| steady | 237 commits/s | 194 |
| **follower 1 full** (it began with 14 MB free) | it says so in one line and its acknowledgement stays at batch 635; the leader and follower 2 go on at 240 commits/s; nothing is refused | stays at 508; 199 commits/s |
| its space is freed | it asks for batches from 636 by itself, gets 475, has caught up 348 ms later | from 509, 392 batches, 513 ms |
| **the leader full** (and the others: they hold the same bytes) | it refuses new writes `disk-full` with a retry-after (253 refused in a second); commits stop; 4 MB free on each, the reserve | 299 refused; 4.7 MB free |
| a retention pass on all three, no restart | 58 MB freed on each; writes are back 21 ms later, 230 commits/s | 48 MB; 71 ms; 185 commits/s |
| **both followers full** | commits stall at batch 4,064; the leader takes 256 more batches, then refuses `no-writer` (143 refused) | stalls at 3,429; 143 refused |
| one follower's space is freed | commits are back 244 ms later | 263 ms |
| at the end, every journal read back from disk | every acknowledgement the leader saw is on that follower's disk; the committed batch is on a majority; no torn tail | the same |

A full follower never acknowledged a batch it had not synced, lost no membership, and came back with no operator step. Both runs end `pass`.

## For L0's format (DEV-09): the reserve and the refusal order

**The reserve, per kind of operation.**

| Operation | What it needs on disk | Where it comes from |
|---|---|---|
| a data write | its batch | free space above the hard limit; refused first |
| a remove | 32 B plus the key (56 B for a 24 B key) | the fixed reserve |
| a term change, a vote | 56 B | the fixed reserve |
| a member change | 32 B plus the list (96 B for 64 B) | the fixed reserve |
| a handover | nothing on the old leader; one term record and one entry on the new one (about 112 B) | the new leader's fixed reserve |
| a retention pass | nothing (unlinks), plus a 48 B mark | the fixed reserve |
| a snapshot | the rows' bytes once more, until the rename | the snapshot headroom (or the object store, where there is one) |

**Sizes.** The fixed reserve is one preallocated segment, at least 1 MiB. 1 MiB holds 18,722 term changes: nine rounds of elections for 2,000 groups sharing the journal. The snapshot headroom is the rows' bytes on disk × 1.05 + 64 KB, tracked as rows change. So the hard limit is: free space < reserve + headroom.

**The order.**

1. At 80 % of the usable space (the disk less the reserve and the headroom): one health row and one stderr line, naming the fix (SC-09).
2. At the hard limit: new data writes are refused `disk-full` with a retry-after. Reads, subscriptions, removes, retention, snapshots, votes, member changes and handovers go on.
3. If the reserve itself cannot take a record: the node stops voting and acknowledging, says so, and stays readable. It never acknowledges bytes it did not sync.
4. When space comes back (a retention pass, a dropped resource, a bigger volume), writes resume with no operator step and no member lost.

**Six format rules this run adds.**

1. **Segments are preallocated.** Then a full disk shows only when a segment is made, never in the middle of a batch. (E-02 already found them 1.3 to 1.9 × faster.)
2. **The reserve is counted in whole segments, and a segment opened from it is marked,** so data cannot use it.
3. **The hard limit includes room for one snapshot,** or the node deadlocks. Where snapshots go to the object store, the headroom can be dropped; then a store outage at a full disk stops retention, and F-15 must say so.
4. **Recovery finds a segment's end from the next segment's name,** never from leftover bytes, so segment files can be reused.
5. **A batch carries a chained sequence number as well as a checksum,** and recovery stops at the first batch that does not carry the next one. A checksum alone lets old batches in a reused file pass (mutant `noSeqCheck`), and "skip the bad one and carry on" breaks the order (mutant `resync`).
6. **Free space is asked of the filesystem per batch, and a short write means "ask again",** not "torn".

## What the model leaves out

- **Elections on a full disk.** The pipeline has no elections. The cost of a vote record is measured; a full voter in a real election is not. A full leader should hand over, and that is not built here.
- **Many groups in one journal.** The reserve was sized by arithmetic for 2,000 groups, not run.
- **Big state.** With 10 GB of rows the snapshot headroom is 10 GB. So a volume must hold the rows twice plus the log, or snapshots must go to the object store. SC-10 should list this as a stated limit.
- **Other filesystems.** XFS needs at least 300 MB, so it was not run at 64 MB. Quotas and thin-provisioned volumes can refuse in other places.
- **Health rows.** The 80 % warning is one line of the test's output.
- **Part (a)'s limits,** listed above: directory entries, failed syncs, lying disks.

## Verdict

- **(a) works on this box.** LazyFS 0.3.1 mounts, drops unsynced writes, tears writes, and the tier found a real recovery bug in 2 of 1,200 rounds and catches all four broken journals. The tier is planned on this box from phase 2. Two holes need the simulator's disk model (or a block-level tool): a missing directory fsync and a failed fsync.
- **(b) is answered.** The reserve per operation and the refusal order are above, ready for L0's format.

Q-29: yes, this box runs the power-loss tier (LazyFS 0.3.1: 2,640 power cuts and torn writes, 10,020 acknowledged batches, 0 lost; all four broken journals caught, one of them the journal's own first bug, found in 2 of 1,200 rounds), but LazyFS does not model lost directory entries or failed syncs, which need the simulator's disk model; and for a full disk L0 keeps one preallocated segment (at least 1 MiB) for removes, votes, member changes and retention marks (48 to 96 B each, 0 new blocks inside a preallocated segment) plus room for one snapshot (the rows' bytes again), refuses data first, and a full follower stops acknowledging and resumes by itself (three processes, tmpfs and ext4: pass). Moves: no candidate up or down; every row gains six L0 format rules for DEV-09 (preallocated segments, a marked reserve segment, snapshot headroom in the hard limit, segment ends by name, chained sequence numbers, short write = ask again) and F-20 holds with them; every row with snapshots on its own disk (all but OBJ) must state "a volume holds the rows twice" in SC-10 or send snapshots to the object store; F-10's failed-fsync and directory-fsync clauses stay open until the simulator's disk model covers them.
