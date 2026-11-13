# Paths: every step of every path, and where the waste is

2026-11-13. The owner asked: "flatten and step through all the steps different paths/scenarios can take to work out if it's the most optimal/efficient in each case e.g. zero copy, not decoding/encoding unnecessarily where not needed". This page does that for the chosen design ([DECISIONS V5-1 to V5-6](../DECISIONS.md); [VERDICT 11.7](VERDICT.md#117-the-owners-design-decisions-2026-11-12)): the base of [SIMPLICITY 3.1](SIMPLICITY.md#31-its-51-mechanisms), with groups and healing per resource (V5-2), a soft directory (V5-3), writer time across resources (V5-4), every write on disk at a majority (V5-5), and TypeScript first (V5-6). For each path it lists every step, says whether the step is needed, gives the least work any correct design must do (the lower bound), and names the gap. It changes no other study file. The micro-benchmarks behind it are [E-50](experiments/E50-path-costs/README.md).

Four walkers stepped through the paths: the write paths, the read and flow paths, the replication and upkeep paths, and the costs every path pays. This page merges their work. Findings that are the same waste seen from two paths are one finding here (section 6 names the walkers' own ids). Every benchmark the page relies on was run again for it, from E-50's folder. A skeptic then checked the page and its benches and found 23 problems: a wake estimate built on the wrong row shape, a busy budget with no Raft in it, top findings the design's own text already avoids, fixes that needed guards, and paths left out. This version applies them, and a second check's 13 (a rule sum that did not add up, stale E-49 figures, two missing guards, a saturated Raft bench); section 8 says what changed. The skeptic's benches, and new ones for 2 KB rows, field records, the escape, the flush and E-10's Raft port, are in E-50 too, with the second check's reruns.

**How each claim is marked.**
- **Measured here**: an E-50 benchmark, rerun for this page (3 runs; the median, with the lowest and highest run where it matters). The bench is named.
- **E-NN**: that experiment's README, with its numbers checked against it in this pass.
- **Code**: fero v4 at `cab0913` (`file:line`), or `data` at `63fea66` (`data:file:line`). Every line cited was read in this pass.
- **Docs**: a design record, named: [DESIGN-V5](../DESIGN-V5.md), [LAYERS](LAYERS.md), [API.md](API.md), [SIMPLICITY](SIMPLICITY.md), [MEMORY](MEMORY.md), [MECHANISMS](MECHANISMS.md).
- **Computed**: arithmetic on marked numbers. **Reasoned**: an argument; nothing ran it.
- **From memory**: a fact about an outside system (Kafka, etcd, TiKV, NATS, Redis, Redpanda, CockroachDB), not checked against its source here.

LAYERS and DESIGN-V5 still draw COMP2's shape (project groups, `#meta`, a central loop). Where they do, the step is read in the chosen design's form: a resource's own home group holds its settings and slot table, and each group's leader heals its own copies (V5-2). Where that changes a step, the step says so.

## 0. The answer

**The chosen design is sound on every path.** No step it requires is waste that a rule cannot avoid. Its text already avoids v4's worst habits: a reconnect that downloads the whole resource again, a scoped read that gathers every cell from every member and then polls, compaction that rescans every lane each tick, a snapshot that rewrites the whole state. It also already avoids three traps a builder would bring back from v4's code: the leader's fsync before its sends, a record encoded again for every link and subscriber, and a lane call per record (the end of this section).

**Built well, it sits close to its lower bound.** "Lean" is the design as written, built with every build-only fix of this page and no rule changed. Lean, one small write costs about **1.45-1.5 times** the least CPU this design must spend on a quiet box, and about **1.2-1.5 times** at 50,000 writes a second; a field record, the commonest write, about 1.1 times. The busy figures are loose for one reason: nobody has timed the Raft port inside a v5 server. E-02's pipeline, which the first version of this page used, runs no Raft; E-10's real port, in E-11's simple host, cost 47-55 µs a write at 50,000 a second (B11) against E-02's 17.0, so the busy totals below are ranges. And the top of each range is not a ceiling: at that rate the host was at its limit (commit p50 14-18 ms, against the 5.73 ms bar), so it batched more and paid less per write than a server with headroom would; at 10,000 a second the same host paid 143-187 µs (B11). A quarter to a third of the bound (with E-02's floor) is fold-all, the design's own choice. Built in v4's habits instead, a write costs 2.3 times the bound quiet and 1.6-2.4 times busy.

**What moves it further.** Ranked by gain against the lean column, weighed by how sure the gain is, how many paths it touches and what it costs in rules, so a sure gain on every path can rank above a larger one on a few (section 6 gives each gain alone):

1. **Send to the leader directly** (PA-4, design: a routing rule, 0 to +1 rule). Route-forward costs a round trip on about 2 of 3 writes: 40 µs p50 and 96 µs p99 on this box (E-01), a real network round trip between machines, and about half of a `received` answer's time. V5-3 already gives every client the slot table and the leaders.
2. **One native checksum per batch** (PA-1a, design: the record format, +1 rule). It gains on every path and every row shape. v4's crc32c in JavaScript runs 2.2-2.9 ns a byte; Node's native `zlib.crc32` (CRC-32/IEEE, so a format change) 0.2-0.5 ns a byte once per batch, but 213-231 ns per call, as slow as JavaScript, if called per record (measured here). A 1 MiB write's checksums on its path fall from 4.9-11.8 ms (lean) to under 1 ms; the 10 GB wake's from 24 s to 3-5 s; a busy small-row write's by about 2 µs. The batch checksum must cover the term, the base offset and the group, and the journal row header needs its own.
3. **A byte-rate cap on bulk work** (PA-6, design: about +1 rule). A catch-up, an install, a move's copy or a roll's catch-up shares the one member link and the one disk with live commits: a 4 MB frame holds a 1 Gb/s link for 34 ms (computed), big records raised others' commit p99 1.18-1.59 times (E-35), and a small fsync beside bulk writes waited 250-300 ms (E-01). The cap goes on both the link and the disk; a side file does not help on a shared disk (E-35: "not worth a mechanism now").
4. **Work that needs only bytes stays off the main thread** (PA-3). (b) Deltas sent from the committed bytes (design: 0 to +1 rule; E-31 again) take every delivery off main's event loop (1.5-14 ms p99 under load, E-07), for selectors that bytes can route. (a) Client links off main and answers from the worker at commit (build: 0 rules on a thread of their own, +1 for a handshake budget on the kernel worker), best on a thread of their own, so a reconnect storm never lands on Raft's thread (E-39).
5. **The value as JSON, with a tagged escape** (PA-1b, design: the record format, +1 rule). Its gain depends on the row's shape. With the rows kept, as a fold keeps them, a small row of many short strings decodes in about 55 % less time than with v4's codec, but a field record (whose record a fold does not keep) in only about 6-7 % less and a 2 KB row in about 10-27 % less, less as the heap grows; V8's own format takes about 43-53 % less on a 2 KB row (b3, B8, and the second check's rerun at 1,000,000 rows). The escape costs a walk at encode: 6 ns for a number, 59 ns for a small row and 74 ns for a 2 KB row (B9). With PA-1a and PA-1b, snapshots in V8's format, the 10 GB wake falls from about 94 s to about 51-64 s (reasoned), not the 30-36 s first written: most of E-34's decode is the collector moving 11 GB of kept rows. With JSON values in the snapshots instead it is about 64-75 s; PA-1a alone gives about 73-75 s.
6. **A restarted copy votes before its fold is done** (PA-16, design: +1 rule). As drafted it can neither vote nor ack until its fold ends: 22-94 s on two of three copies at E-34's sizes, at every roll step.
7. **One shared log per process** (PA-7, design: about +4 to +6 rules). As drafted every entry is written twice, to the journal and to its group's segment. One log with an index per group halves the disk's write bytes and the recorder's window; its records must describe themselves, so one damaged header cannot taint every group's later records.
8. **Rolls** (PA-20 and PA-41, design: 0 to +1 rule each). A write caught in a handover backs off at least 200 ms, at each of a group's 2-3 handovers per roll; DESIGN-V5 4.3's retry-after exists and only needs to count below the floor. And the hand-back, at a fixed ten a second per member after `settle.ms` (30 s), keeps leadership uneven for 30 s plus R/30 seconds after every restart: about 6 min at 10,000 resources a process (E-49 section 6).
9. **`f.snapshot` copies the whole resource on every read** (PA-8, an API point): 87-89 µs at 1,000 rows, 0.47-0.53 s at 1,000,000 (measured here), where API.md promises "a property read".
10. **Smaller design and build items:** the RESP gateway's per-key chain turns a pipeline of 16 writes on one key into 16 commits in a row (PA-40, build once O.seq exists; a read still waits for the writes before it); session renewals as logged writes (PA-9, medium: about 6 % of a 50,000-a-second budget at 10,000 processes); validation and decodes at steps that do not need them (PA-12).

**Is the design near the lower bound on each path?** The lower bound is the least work any correct design must do given V5-1 to V5-6: in particular `data` folds on every full copy, so every full copy decodes and folds every row it holds.

| Path | Built in v4's habits, as drawn | Lean: the design as written, built well | With the design changes of section 7 | What stands in the way |
|---|---|---|---|---|
| one small write, quiet: CPU, all processes | about 640-665 µs, 2.3 × the bound | about 415-430 µs, 1.45-1.5 × | about 406-414 µs with PA-1's codec and one hop per flush, PA-2's default; about 306 µs if flushes run in place, PA-2's option behind its guards; a little less with PA-4 | the two-thread layout and TLS are the design's (bound about 285 µs, with flushes in place); PA-2, PA-3 |
| one small write, busy (50,000 a second): CPU | about 66-116 µs, 1.6-2.4 × | about 40-87 µs, 1.2-1.5 × | about 30-74 µs, 1.0-1.1 × (bound about 27-71 µs) | the Raft port's own cost (not timed in a v5 server; B11 timed it at its limit, so the top ends are not ceilings); PA-1; fold-all is a quarter to a third of the bound |
| one field write, busy: CPU | about 40-85 µs | about 25-70 µs, about 1.1 × | about 25-69 µs: PA-1 changes little | the Raft line and the fold; the format barely matters |
| one write: round trips and fsyncs on its path | 3 RTT; 1-2 fsyncs in a row | 3 RTT; 1 fsync | 2 RTT; 1 fsync: **at the bound** | PA-4 |
| a 1 MiB write: CPU on its path | about 29-32 ms (23-26 ms of it checksum) | about 6.7-14 ms (crc32c in JavaScript) | about 2.6-3.3 ms | PA-1a; one decode per folding copy is needed |
| a local read of a held row | `f.snapshot.x` 1,700-510,000 × a `Map` read; `f.data.x` 4-14 × | `f.data.x` near the bound once PA-31 is built | at the bound with PA-8 | PA-8, PA-31 |
| a linearizable read | 2 RTT + a majority round | the same, batched per tick | 1 RTT + a majority round | PA-4, PA-30 |
| subscribe and fan-out, per record per subscriber | 2.1-4.6 µs of encode, plus a decode to route | about 0.01-0.46 µs | at the bound; `view` selectors keep one shared encode per change | PA-5 (a trap), PA-12, PA-3 |
| resume after a reconnect | v4: the whole resource again | records since the cursor: **at the bound** | at the bound | already in the design |
| follower catch-up, per 4 MB | about 28-31 ms of checksum, a re-encode, two disk writes, up to 34 ms of head of line | about 10-20 ms of JavaScript checksum (two passes), two disk writes, head of line | about 2-4 ms of checksum plus the fold, under the cap | PA-1a, PA-6, PA-7 |
| install, wake or boot of 10 GB | about 94 s (E-34) | about 82-94 s: the format sets it, with a crc32c in JavaScript, slice-by-8 to v4's table (computed) | about 51-64 s with snapshots in V8's format; about 64-75 s with JSON values (reasoned) | PA-1a, PA-1b; the collector's work on 11 GB of kept rows, the fold (8 s) and one decode are needed |
| a slot move | the slot's state sent 3 ×, written 3-6 ×, folded 3 × | the same | about zero bulk bytes, by reference, with L2 rules (medium-low) | PA-15 (design, on the biggest modelled mechanism) |
| a roll step | the fold before the vote; 200 ms backoffs in each handover; leadership uneven for 30 s + R/30 s after each restart | the same | vote before the fold; a short retry-after; a paced, batched hand-back | PA-16, PA-20, PA-41 |
| retention, compaction | v4: a rescan of every lane each tick (43 % of CPU, DESIGN-V5 9) | whole files: **at the bound** | at the bound | already in the design |
| genesis, `par` repair, failover, wake, TTL expiry | | **at or near the bound** | | small items only (section 5) |

**What this asks of the design.** Section 7.1 lists the changes that move a rule, the record format or a mechanism, for the owner to decide, in the order above: direct routing; one native checksum per batch with full header coverage; a byte-rate cap on bulk work; deltas from committed bytes; the value as JSON with a tagged escape and snapshots in V8's format; voting before the fold; one shared log with self-describing records; a short retry-after and a paced hand-back for rolls; renewals in memory; validation at the writer; parked queue takes; a slot move by reference. With the guards the checks added, they come to about **+14 to +25 rules** on the base's 405 (+2 more if a side file is later taken, +2 if flushes run in place), each with its model to run (or run again) named; 405 + 14 = 419 already passes every judged row (SPLIT 417; section 7.1 adds it up). Section 7.2 holds the build notes and the guards; 7.3 what the first slice must time.

**Build traps the design's text already avoids**, which a builder who ports v4's code would bring back (section 6): the leader's fsync before its sends (DESIGN-V5 4.2 has it "in parallel"; an in-place flush in the same run as the corked sends does it silently, 2.4); a record encoded again for each link, the journal and each subscriber (DESIGN-V5 4.1 and 8: encode once); a lane call per record (DESIGN-V5 8; E-05). v4 also has habits the design's text does not name: its kernel's own copy of every cell and its state hash, about 2 µs a record on every copy (PA-10); two pool hops per flush (PA-2); crossings through main (PA-3 a); 7-8 KB of garbage a record (PA-13).

**How sure** (section 8). **High** for the costs per byte, per record, per crossing and per flush: measured here, three runs, small spread. **Medium** for the totals of whole paths: each is a sum of measured parts, nothing was run end to end through a v5 server, and the busy totals carry a Raft line from 17 to 47-55 µs, whose top was measured with its host at its limit, so it is not a ceiling. **Medium-low** for the gains of the design changes on whole paths, which are reasoned; none is modelled yet. **Low** for the "from memory" lines about other systems.

## 1. How to read it

### 1.1 The setup walked

- Three servers S1, S2, S3. Each is the app's own Node process with a main thread and a kernel worker (LAYERS 8.1). Resource R has 4,096 slots in its own Raft groups (V5-2).
- Row `x` hashes to a slot of group g2. S2 leads g2; S1 and S3 follow it. With `standbys` at its default of 5 and three servers, every server holds and folds every group (docs: API.md 4, "Roles").
- Client C is another Node process with a bare `fero('R')`, linked to S1, following R. R has no `methods:`, so C may write plainly. Browser B reaches the project's public address over WebSocket.
- The write is `f.data.x = row`, a whole-row set of E-05's small row: about 100 B as JSON, 124-147 B in v4's codec. A "field" record sets one field: 14-38 B. It commits at `persisted`: on disk at two of three copies (V5-5).
- Links between machines carry TLS (DESIGN-V5 4.1 "Transports"). On one box they need not.
- One box: a loopback round trip in Node is 40 µs p50 and 96 µs p99; one fdatasync 179 µs p50 and 519 µs p99 alone, 676 µs p99 with three writers (E-01, as E-02 uses it). Between machines, the network numbers grow; none was measured.
- **Quiet** means one write in flight on an idle box, so every batch holds one record. **Busy** means 50,000 writes a second, about 60 records a batch (E-02: 62 records per flush at that rate).

### 1.2 The columns

Each path has a step table, then its lower bound, its gap, and how outside systems run it where that helps.
- **#**: the step's order. **Where**: the process (C, S1, S2, F for a follower), the thread (main, worker, pool) and the layer (L0 storage and links, L1 Raft, L2 judging and fold, L3 flow, L4 the API; LAYERS 0).
- **Step**: what happens. **Work**: what it costs, with the cost's mark.
- **Verdict**: **NEEDED** (any correct design must do it; the property it serves is named), **CONDITIONAL** (needed only in the case named), or **AVOIDABLE** (a correct design need not do it), with the finding that removes it.

### 1.3 The checklist each step was put through

1. Is a byte copied that could be shared or handed over (zero copy)?
2. Is anything encoded or decoded that the step does not read? Is it encoded or decoded more than once?
3. Is a checksum made or checked more than once, or per record where per batch would do, or in JavaScript where a native one exists?
4. Is the work per record where it could be per batch (a call, a buffer, a Raft entry, a frame, a lane call)?
5. Does the step cross a thread, or wait for an event loop, that it does not need?
6. Does it add an fsync, a network trip or a round trip? Could two waits run side by side instead of one after the other?
7. Does one big thing hold up small things behind it (head of line)?
8. Is the work done on every copy when one copy would do?
9. Does it make garbage, keep a second copy in memory, or wake a timer when nothing happens?
10. Is a security check made per operation where per link or per subscription would do?

### 1.4 The words

- **Copy** (of a group): a full replica that stores and folds every record of the group, a voter or a learner (fold-all, V5-6). A **payload copy** is bytes copied in memory.
- **Main** and **worker**: a server's two JavaScript threads. The kernel (L0 and L1: Raft, the journal, member links) runs on the worker; `data`, judging (L2), flow (L3) and user code run on main (LAYERS 0, 8.1, 10). A **crossing** or **hop** is one message between them. **libuv's pool** is the few threads Node runs file calls on; a call there wakes a pool thread and then wakes the caller back (a **pool hop**).
- **Net**: one network trip one way. **RTT**: a round trip.
- **Encode**: objects to bytes. **Decode**: bytes to objects. **Scan**: walking bytes to find where each record ends, without building objects. **Fold**: `data` applying committed records to its rows. **Lane**: `data`'s fast entry for a batch of records.
- **Batch**: the records one leader appended together, with one header (term, base offset, writer time). **Frame**: one message on a link or one row in a file; v4's frame has an 11-byte header and a crc32c (code: kernel/codec.ts:2-30). **Envelope**: the bytes a frame carries besides its records.
- **Journal**: the one append-only file per process every group writes to, with group commit (DESIGN-V5 4.1). **Segment**: a file of one group's entries, written after the journal as drafted. **Layer**: one incremental snapshot file (DESIGN-V5 3.4).
- **Relay**: a server that forwards a write it does not lead (route-forward), or a process that subscribes upstream and serves its own subscribers. **Delta**: one committed record sent to a subscriber.
- **As drawn**: LAYERS 8.2's diagrams built the way v4 builds its parts. **Lean**: every build-only fix applied, no rule changed.
- **W1, O.seq, Y**: E-48's three rules for answer stages (the library's own steps wait for committed answers; each writer numbers its writes; a read waits for the writer's own early-answered writes).
- **PA-1 to PA-41**: this page's findings (section 6). Section 6 maps them to the walkers' own ids. PA-1 has two parts: **PA-1a**, the checksum, and **PA-1b**, the value's form.
- **Kept**: a decode whose rows stay in memory afterwards, as a fold keeps them. Kept rows cost more to decode than rows thrown away at once, because the collector must move them out of its young space (b3).
- **Build trap**: waste the design's own text already avoids, which a builder who ports v4's habits would bring back.

## 2. The costs every path pays

These are the constants under every path: threads and crossings, the codec, the link, rows in memory, the API's edge, the recorder and timers. Sections 3 to 5 cite them instead of repeating them.

### 2.1 The unit costs

Measured here unless marked (E-50's bench in brackets; medians of 3 runs). On this VM an idle vCPU takes about 25 µs to wake (E-01, reasoned there), so every "quiet" cost below is near the top of what a busy server pays.

| Item | Cost | Mark |
|---|---|---|
| v4's crc32c in JavaScript (a 256-entry table, one byte a step) | 2.2-2.9 ns a byte (340-450 MB/s); 0.30-0.36 µs a small row | write/crc, upkeep/b1 |
| a crc32c in JavaScript, slice-by-8 (what a browser could run) | 1.2-1.3 ns a byte (760-860 MB/s) | write/crc |
| Node's native `zlib.crc32` (CRC-32/IEEE), once per batch or per MiB | 0.19-0.23 ns a byte (4.5-5 GB/s) over bytes already in the CPU's cache, as a frame just read is; 0.27 (first pass) to 0.45-0.48 (rerun) streamed from memory | write/crc, upkeep/b1 |
| the same, called once per 100 B record | 213-231 ns a call: as slow as the JavaScript one | upkeep/b1 |
| copy into a reused buffer / a new buffer per 100 B record | 0.044-0.05 ns a byte / 0.7-0.9 µs a record | upkeep/b1 |
| v4's codec, small row, frames of 256: encode (its crc share) / scan / key / full decode | 1.74-1.96 µs (0.31-0.36) / 0.63-0.67 / 0.72-0.84 / 2.71-3.21 µs | write/codec |
| v4's codec, a frame of one small row: encode / full decode | 3.6-3.7 µs / 3.1-3.6 µs | write/codec |
| the value as JSON text (binary key): decode per record / as one array per frame / encode | 0.89-0.97 / 0.60-0.62 / 0.54 µs | core/jsonval |
| a snapshot chunk of rows: `v8.deserialize` / `JSON.parse` / v4's decode (no crc) | 0.84-0.95 / 0.96-1.11 / 2.49-3.02 µs a row | upkeep/b2 |
| one decode pass with the rows kept, as a fold keeps them: v4's codec / the value as JSON per record / V8's format per frame (no crc), a small row | 2.92 (2.78-3.11) / 1.30 (1.29-1.38) / 1.15 (1.11-1.36) µs (not kept: 2.33 / 0.95 / 0.85) | upkeep/b3 |
| the same, E-34's 2 KB row (250,000 kept; at 1,000,000 kept) | 5.41 (5.01-5.73) / 3.93 (3.90-4.78) / 2.57 (2.40-2.95) µs (at 1,000,000 kept 6.08 / 5.06 / 3.49; the second check's rerun there 6.32 / 5.50 / 4.33) | upkeep/b3, results/recheck |
| a field record, which a fold does not keep (only its value): v4's codec / the value as JSON, one pass / a hot loop | 0.43 / 0.41 µs; 406 / 377 ns | upkeep/b3, core/field |
| PA-1b's escape: the walk at encode, a field / a small row / a 2 KB row; a reviver on a flagged small row | 6 / 59 / 74 ns; 4.6 µs | core/escape |
| a flush, v4's way taken apart: two pool hops / one pool hop / in place, with fdatasync; fsync instead, one hop | CPU 106 / 80 / 30 µs; 76 µs | core/sys2 |
| E-10's Raft port in E-11's host, CPU per write, the whole cluster: 10,000 / 50,000 writes a second | 143-187 µs a write / 47-55 µs a write, with the host at its limit (commit p50 14-18 ms, p99 84-127 ms; 229-285 loop rounds a second per process), so not a ceiling | core/raftport; E-11 |
| `data`'s fold, one lane call per batch of 256 / per record | 0.22-1.90 / 0.62-2.63 µs a record (1e3-1e6 rows) | E-05 |
| a main → worker → main round trip, quiet | 42-43 µs of CPU; 33-38 µs p50, 86-88 µs p99 | core/hopcpu, write/hop |
| a crossing under load, batches of 256 / 16 | 27-40 / 77-155 ns a record | E-07 |
| a 128 B write + `fdatasync`: in place / on a journal thread / through libuv's pool / v4's two pool hops | CPU 30-33 / 66-72 / 67-83 / 104-108 µs; p50 112-113 / 142-158 / 167-198 / 194-204 µs | core/sys, core/jthread |
| one `fdatasync` on this disk, alone / three writers | 179 µs p50, 519 µs p99 / 676 µs p99 | E-01 |
| a loopback round trip in Node | 40 µs p50, 96 µs p99 | E-01 |
| a 150 B message, sender + receiver: alone / 64 corked in one `writev` | TCP 5.9-6.2 / 0.47 µs; TLS 8.7-9.6 / 0.58-0.60 µs | core/link |
| a TCP connect / with a TLS 1.3 handshake, both ends | 100-109 µs / 2,008-2,172 µs of CPU | core/link |
| HMAC-SHA256 / ES256 check / Ed25519 check of 150 B | 2.5 / 77 / 104-112 µs | core/link |
| an event-loop turn / an idle 1 ms timer | 1 µs / 5-6 % of a core | write/hop, core/sys |
| the main thread's event-loop delay, p99, under 10,000-50,000 writes a second | 1.5-14 ms | E-07 |
| one socket write per subscriber per tick at a relay | 8-14 µs on this VM | E-08 |
| one small row in `data` | 315-338 B of heap | E-05 |
| garbage v4 makes per small-row record, written / received | 8.1 / 7.1 KB | core/alloc |

**What they say.** A copy is cheap. A checksum in JavaScript is not, and a native one is cheap only once per batch. The decode is the big cost per record, larger than the fold, and its price depends on the row's shape and on whether its rows are kept: JSON takes half off v4's decode on rows of many short strings, a tenth to a quarter on 2 KB rows (less as the heap grows), and hardly anything on a field record. A real Raft port costs about three times E-02's bare pipeline at 50,000 writes a second, measured with its host at its limit, where it pays less per write than it would with headroom. On a quiet box the per-batch and per-message constants (a flush, a crossing, a TLS record) are tens of µs each and dwarf the record's own work. Under load they spread over a batch, and the record's own work (decode, fold, garbage) leads.

### 2.2 Threads, and what crosses between them

| Thread | Runs | Source |
|---|---|---|
| main (server) | L2 judging and `data`'s fold of every group the server holds; L3 serving; L4 user code; L5 libraries | docs: LAYERS 0, 8.1, 10 |
| kernel worker (server) | L1 Raft for every group; L0 member links, the journal, link pings, the recorder | docs: LAYERS 0, 8.1 |
| libuv's pool | `fdatasync` (as drawn) | docs: LAYERS 8.1 |
| lease thread | touches the data folder's lock file every 500 ms | code: shell/runtime.ts:106-138 |
| main (client) | the lens, the client's link, decode and fold of what it follows | docs: LAYERS 8.1; which thread ends a client link is open (LAYERS 10 item 2) |

Every crossing one write makes (quiet: about 21-22 µs of CPU each way, measured here: core/hopcpu; busy: 27-155 ns a record, E-07):

| # | Where | Crossing | What crosses | Verdict |
|---|---|---|---|---|
| 1 | C | main ↔ a kernel worker, if a client has one | the `ASK`, each `DELTA` | AVOIDABLE: a client holds no Raft and no journal; its link and fold can stay on main, as v4's client does (PA-3) |
| 2 | S1 (relay) | worker → main → worker, if client links end on main | the `ASK`, to forward it | AVOIDABLE: end client links off main, so a relay forwards bytes; but not on the kernel worker as it is, since client load would then land on Raft's thread (a TLS reconnect storm took 0.8 of a core for 7 s, E-39). A link-and-flow thread of its own costs one crossing here instead of two (PA-3) |
| 3 | S2 (leader) | worker → main | the `ASK`, to be judged | NEEDED while judging reads `data`'s rows on main (RR-17, LAYERS 10 item 1) |
| 4 | S2 | main → worker | the judged batch, to propose | NEEDED (as 3) |
| 5 | S2 | worker → main | the committed batch, or only "commit ≥ N" | NEEDED: the leader folds (fold-all) |
| 6 | S2 | main → worker | the `ANSWER`, after the fold | AVOIDABLE: answer from the worker at commit, or not at all where the committed stream answers (PA-3, PA-27) |
| 7 | S1, S3 | worker → main | the committed batch | NEEDED (fold-all) |
| 8 | every server | worker → pool → worker | the journal's `fdatasync` | NEEDED once per batch, through one hop (a pool hop or a journal thread), never two as v4 does. In place would save 34-53 µs of CPU and 55-85 µs p50 on an idle box, but only behind guards (PA-2): the corked `APPEND`s go out first; never where a batch holding a `replicated` write may arrive, since MEMORY 9.4 needs each batch handed to the OS as it arrives and an in-place fsync blocks every write on the thread while it runs; after one slow flush the hop takes over, though the first stall blocks the thread in full. Whatever the thread, the durable mark is the offset the fsync started from (SIMPLICITY's `journal` rule 2) |

- **How bytes cross** (E-07): in batches, by transfer or a shared ring, never as cloned objects: 27.5 ns a record by transfer at batch 256, 40 ns by a ring; one record a message 0.8-2.2 µs; a structured clone 0.9-6.2 µs a record at any batch size. Already the design's rule (LAYERS 8.2).
- **A copy at the seam.** v4's framer hands out frames as views of the socket chunk (code: kernel/codec.ts:1078-1085). A transferred `ArrayBuffer` must be owned whole, so a batch for main is the chunk transferred or the batch copied once (0.044 ns a byte). CONDITIONAL and cheap.
- **At the native step** (E-03): one thread-safe call per batch costs 52 ns a record at batch 256 but 3.8 µs per call; a new Buffer per call 3.2-5.7 µs. Same rule: bytes, in batches, into buffers JavaScript owns. More kernel workers did not help: 4 workers gave 0.8-1.03 times one, because main feeds every write (E-02).
- **Lower bound** (judging on main, the kernel on a worker): three crossings per batch at the leader, one per follower. Busy, about 0.1-0.5 µs a write in all (E-07, computed). Quiet, about 106-110 µs of CPU per write across three servers (computed: 5 × 21-22 µs): a real cost of the two-thread layout, bought for F-14 (E-07: through a 5 s main-thread stall the worker's heartbeats stayed within 5 ms).
- **Gap:** up to 5 of the 10 crossings a write can make as drawn (rows 1, 2, 6); 4 if client links end on a thread of their own, which keeps one of row 2's two.
- **Others** (from memory): Redis runs commands on one thread and fsyncs the AOF there before it replies. Kafka parses on network threads, appends on a handler pool, replicates by followers' fetches. Redpanda runs a thread per core with no hand-offs inside a partition. etcd runs Raft on one goroutine, sends to followers before its own WAL save, and applies on another. TiKV writes Raft logs on store-writer threads and applies on a pool.

### 2.3 The codec and its framing

Where a record's bytes are made, as v4 does it and as it could be:

| # | Place | v4 today | Lean (no rule broken) | Verdict | Source |
|---|---|---|---|---|---|
| 1 | the client's `ASK` | value deep-copied at issue, then encoded | encode at issue, keep the bytes for resends | copy AVOIDABLE (PA-13) | code: api/data.ts:238-254 |
| 2 | a relay's forward | decoded, re-stamped, re-encoded | record bytes under a new small envelope | re-encode AVOIDABLE (PA-5) | code: kernel/write.ts:41-45 |
| 3 | the leader's batch | (v5 only) | for a plain set, the request's record bytes with the slot sequence in front, but only after a strict decode shows they are the canonical encoding (no overlong lengths, duplicate keys, trailing bytes or bad UTF-8); otherwise re-encoded | NEEDED once; re-encode AVOIDABLE for canonical bytes (PA-5). The bytes come from an untrusted client, and v4's re-encode at the relay made them canonical (code: kernel/write.ts:41-45) | docs: DESIGN-V5 4.3 |
| 4 | each member link | re-encoded per link | one batch, `writev([link header, batch])` to each follower | AVOIDABLE (PA-5) | code: kernel/node.ts:1224-1238 |
| 5 | the leader's journal row | encoded again, then copied into a row | `writev([row header, batch])`, no copy | AVOIDABLE (PA-2, PA-5) | code: kernel/node.ts:1239-1260, shell/runtime.ts:48-56 |
| 6 | a follower's journal | the received frame copied twice | `writev` of the received bytes | AVOIDABLE (PA-2) | code: kernel/node.ts:1604, shell/runtime.ts:48-56 |
| 7 | segments | (v5 as drafted) written again after the journal | one shared log with a per-group index | AVOIDABLE (PA-7) | docs: DESIGN-V5 4.1 |
| 8 | the object-store tier | (v5) segments as stored | as stored | NEEDED, already lean | docs: DESIGN-V5 4.1 |
| 9 | a subscriber's `DELTA` | re-encoded per client link | the log's bytes, or the chosen records copied | AVOIDABLE (PA-5) | code: kernel/write.ts:877, kernel/link.ts:166-171 |
| 10 | a local snapshot | rows encoded from objects | a native serializer, or cut from the log's bytes | speed AVOIDABLE (PA-1b, PA-14) | code: kernel/node.ts:1292-1330 |
| 11 | the recorder | (v5) bulk bytes by journal reference | the same | NEEDED, already lean | E-42 |
| 12 | a browser over WebSocket | the same frames | the same | NEEDED, already lean | E-40 |

So the design's rule, "the same bytes are the journal row and the wire" (DESIGN-V5 4.1), is right, and v4 does not follow it on its own commit path.

The bytes a record and a frame carry (v4's frame: code: kernel/codec.ts:2-30, 679-786):

| Item | Bytes | Verdict | Source |
|---|---|---|---|
| frame header | 11 | NEEDED: framing, size bound, integrity | code: kernel/codec.ts:2-30 |
| origin and issuer names as 36-character strings | about 78 of a 99 B envelope; a one-write frame is 238 B, 42 % envelope | AVOIDABLE in that form: small ids per link and per session (PA-23) | measured here: core/codecbytes |
| base sequence, epoch, base call id, record count | about 10 | NEEDED: one run of positions and attempt ids per frame | code: kernel/codec.ts:712-718 |
| a 3-byte length for every string | 28 of a small row's 139 B (14 strings) | AVOIDABLE: a 1-byte length for strings of up to 42 UTF-16 units, still one pass (PA-22) | measured here: core/codecbytes; code: kernel/codec.ts:255-282 |
| field names in every record | 30 B of a small row | CONDITIONAL: JSON, V8's format and v4 all repeat them; a shape table would save them at the price of a new logged mechanism (not advised) | measured here: core/codecbytes |
| v5's per-record header | +5.44 B (issuer, call id, length) +3.87 B for slot and sequence (+1.87 with an implicit sequence) | NEEDED: positions per slot (E-31); a length lets a server skip a record unread (PA-12) | E-19 |

Encodes, decodes and checksums per record, today and at the bound:

| Work | v4 today | Lower bound | Finding |
|---|---|---|---|
| encode | once per link and once for the WAL, plus at each relay | once, at the origin | PA-5 |
| decode | at the relay (validation), twice at the leader, once per follower and client | once per process that folds | PA-12 |
| the decoder | a `TextDecoder` and a subarray per string, a `DataView` per float (code: kernel/codec.ts:570-581). Kept, as a fold keeps them: 2.92 (2.78-3.11) µs a small row, 5.41 (5.01-5.73) µs a 2 KB row; a field record, which a fold does not keep (only its value), 0.43 µs (406 ns in B8's hot loop) | the value as JSON: kept, 1.30 (1.29-1.38) µs a small row and 3.93 (3.90-4.78) µs a 2 KB row; a field record 0.41 µs, not kept (377 ns in B8); V8's own format, kept: 1.15 (1.11-1.36) and 2.57 (2.40-2.95) µs (b3). The gain depends on the shape (PA-1b) | PA-1b (or a short-ASCII fast path, 127 → 66 ns a string, PA-13) |
| checksum | crc32c in JavaScript per frame (code: kernel/codec.ts:139-160, 1075, 1083) | one native checksum per batch, checked once per receiver | PA-1a |
| checksum on a TLS link | checked on every frame | optional | PA-32 |
| decode a key to route | per record | the slot in the record's header: 2-4 ns | PA-12 |

- **Lower bound per record:** encoded once at the origin; checked once per receiver by one native checksum per batch; decoded once per folding process by the fastest per-record decoder that runtime has, with the rows kept (1.3 µs a small row, the value as JSON or in V8's format, b3; one JSON array per frame is no faster once rows are kept, and cannot serve per-record cuts or lengths); a few hundred bytes of garbage beyond the row kept.
- **Gap, v4 against lean:** encodes about 5 → 1; decodes 6 → 4-5; checksum passes about 12 → 5-6. **Lean against PA-1:** each checksum pass about 5-10 times cheaper (PA-1a, on every shape); the decoder, kept, about 55 % less time for a small row but only about 6-7 % less for a field record (not kept: a fold keeps only its value) and about 10-27 % less for a 2 KB row, less as the heap grows (PA-1b: the gain depends on the shape); bytes 139 → 111 B a small row and a frame envelope 99 → about 20 B (PA-22, PA-23); garbage 7-8 KB → under 1 KB a record (reasoned for the last).
- **Why v2's JSON cost does not simply return** (reasoned). v4's codec says it left JSON because in v2 "JSON.parse became ~85% of decode" (code: kernel/codec.ts:21-23). That is a share of v2's decode, not a speed against a binary one: v4's own decoder turned out slower than `JSON.parse` on rows of many short strings, because it makes a `TextDecoder` call and a subarray per string. But part of it does return. `JSON.parse` has a fixed cost per call (a `TextDecoder` call and the parser's start), so on a field record it is most of the decode and the saving shrinks to about 6-7 %; on long strings both forms pay per byte, so a 2 KB row saves about 10-27 %, less as the heap grows. And JSON changes or drops some values without a sound, which v4's binary codec keeps ("NaN-preserving f64, Uint8Array", the same lines): PA-1b's tagged escape is the price of that (B9: a walk at encode, a reviver only on flagged records).
- **Others** (from memory): Kafka's record batch carries one CRC32C over the batch; the broker writes the offsets into the batch header outside the CRC, so it never re-encodes, and consumers get the stored bytes (by `sendfile` without TLS). On produce the broker never decodes keys or values, but it walks each record's header (lengths, offset and timestamp deltas) to validate it, and decompresses compressed batches. NATS core never parses a payload. etcd encodes each entry once as protobuf and chains a CRC32C in its WAL. Redpanda keeps Kafka's batch format and never decodes keys or values on a broker; it walks record headers to validate them, as Kafka does.

### 2.4 The link

Once per link:

| # | Step | Cost | Verdict | Source |
|---|---|---|---|---|
| 1 | TCP connect: 1 RTT | 100-109 µs of CPU, both ends | NEEDED | measured here: core/link |
| 2 | TLS 1.3 handshake: 1 RTT, key exchange, chain check | 2,008-2,172 µs of CPU; 49.7 KB held per link (E-27) | CONDITIONAL: between machines and from browsers. A handshake budget per tick keeps a storm from blocking deliveries (E-39) | measured here: core/link; E-27 |
| 3 | `HELLO` both ways, the `DOOR` proof (an HMAC each way) | 2.5 µs per HMAC; 1-2 RTT | NEEDED once per link; nothing per frame after | code: kernel/door.ts:11-16 |
| 4 | a client token's signature | 77 µs (ES256) to 104-112 µs (Ed25519) | NEEDED once per link; never per operation (already the design: API.md 4) | measured here: core/link |
| 5 | members, slot table, leaders: a `SUB` of the home group's records | 1 RTT; a run-length slot table is 56-196 B (E-36) | NEEDED; could ride the welcome (PA-21) | E-36 |

Per message:

| # | Step | Cost | Verdict | Source |
|---|---|---|---|---|
| 1 | frame into the link's outbox | (2.3) | | |
| 2 | cork at the first small frame of a run, uncork on `nextTick`: one `writev` per link per event-loop turn | 0.47 µs (TCP) / 0.58-0.60 µs (TLS) a message both ends in a batch of 64; 5.9-6.2 / 8.7-9.6 µs alone | NEEDED, and v4's run batch is right (must stay) | measured here: core/link; code: shell/runtime.ts:801-865 |
| 3 | one TLS record per `write` call | +2.5-3.7 µs a message alone, +0.1 µs in a batch of 64 | CONDITIONAL (TLS); covered by the cork | measured here: core/link |
| 4 | receive: one `read` per chunk; a whole frame is a view of the chunk, a split frame is copied once | 1 read a message alone, 0.02 batched | NEEDED; already zero-copy for whole frames | code: kernel/codec.ts:1053-1090 |
| 5 | `pause` when `write` answers false, `drain` later | a boolean | NEEDED (backpressure) | code: shell/runtime.ts:434-443 |
| 6 | admission: a credit per write on a client link; a `CREDIT` frame per window | a counter | NEEDED: without credits goodput fell to near zero at twice capacity; with them 79-82 % in TypeScript (E-39) | E-39 |
| 7 | a token's claims per write | a map read | NEEDED (`rules.write`); per forwarded record it can be once per subscription and partition (PA-34) | docs: API.md 4 |

Keeping links alive:
- v4 sends a `PING` plus a full `DIGEST` of every origin's high mark on each link every 500 ms (code: kernel/node.ts:1070-1105). Raft replaces the digest: not ported.
- v5 pings once per pair of machines per `ping.ms` (500 ms), and quiet groups send nothing of their own (SIMPLICITY 3.1, `link-pings`, `quiet-groups`). A ping costs about 21 µs of CPU per frame in Node (E-25), 49 µs per TLS ping and pong (E-27); 100 members make 19,800 ping frames a second in all (E-25).
- Any frame proves the peer alive, so a link that carried traffic in the last `ping.ms` needs no ping (PA-26; one rule of `link-pings` changes, failure detection does not).
- **Lower bound per message:** a share of one syscall a side per event-loop turn and one TLS record per write call. **Gap:** none if the run batch is kept. Quiet, a lone message pays the whole 5.9-9.6 µs: the floor of one message, not waste.
- **Others** (from memory): Redis replies once per client per event-loop pass; NATS flushes each client's buffer once per loop with `writev`; Kafka sends fetch data by `sendfile` without TLS; etcd's client API uses gRPC over HTTP/2, while its peers use rafthttp's long-lived streams.
- **The cork and the flush.** The run batch holds a frame until the end of the run that made it (code: shell/runtime.ts:808-812: "a frame waits for the end of the run that made it"). So any long synchronous step in the same run, such as an in-place `fdatasync`, holds every `APPEND` made before it until it ends: the sends then follow the leader's fsync instead of running beside it. An in-place flush must uncork first, or run in a later macrotask (PA-2).

### 2.5 Rows in memory, and the collector

One fold on one copy:

| # | Where | Step | Work | Verdict | Source |
|---|---|---|---|---|---|
| 1 | main · L2 | the committed batch arrives (a crossing, 2.2) | | NEEDED | |
| 2 | main · L2 | decode each record | kept: 2.92 (2.78-3.11) µs a small row in v4's codec, 1.30 (1.29-1.38) with the value as JSON | NEEDED once (fold-all); its speed is PA-1b | measured here: upkeep/b3 |
| 3 | main · L2 | v4's kernel apply: the cell key as JSON, ancestors, a version stamp, `state.set`, a `stable` stringify and an fnv hash of the value for a rolling state hash | about 2 µs a small row (1.8-2.6); 29-34 % of v4's per-record CPU (its apply and `stable` alone 22-26 %); a second copy of every cell | AVOIDABLE in v5: the hash is read only by the debugger and the simulator (code: kernel/diag.ts:156, 275, 283); v5's kernel never sees rows (LAYERS 1.4) (PA-10) | measured here: core/api; code: kernel/node.ts:2813-2870, 3101-3116 |
| 4 | main · L2 | `data`'s lane folds | 0.22-1.90 µs a record per batch; 0.62-2.63 per record as v4 calls it | NEEDED; per batch (PA-11) | E-05; code: api/substrate.ts:148-187 |
| 5 | main · L2 | views and taps run | 1 µs a record with one `group` view at 1e3 rows, 2,574 µs at 1e6 (a `data` change is owed, DATA-05) | NEEDED for declared views | E-05 |
| 6 | main · L2 | a row frozen once, lazily, when first handed out | once per row object | NEEDED; already right | code: data:api/index.ts:152-161 |
| 7 | main · L2 | the issuer's pending write settles, if any | map lookups | CONDITIONAL: only on the issuer | code: api/data.ts:623-650 |

- One small row in `data` costs 315-338 B of heap; a `group` view adds 146-182 B a row (E-05). v4 keeps every cell twice, in `data` and in the kernel's `state` map with a version, an entry hash and an ancestor index (code: kernel/node.ts:2849-2870). v5 must not port that shape (PA-10).
- Pauses grow with the number of objects: 0.77-0.98 s while loading 5e6 small rows, at most 45 ms under steady writes (E-07). The collector's CPU is per record: v4 makes 7-8 KB of garbage a record, and the collector is 12-24 % of its CPU (measured here: core/alloc, core/api profiles). At 50,000 records a second that is 350-400 MB a second of garbage per copy (computed).
- **Lower bound:** one row per process (about 300 B, the `Map` floor), one decode and one fold a record in batches, a few hundred bytes of garbage a record. **Others** (from memory): Redis keeps one dictionary entry per key; Kafka and Redpanda keep no rows (the page cache holds the log).

### 2.6 The API's edge: v4's lens and `Bind.issue`

`f.data.x = row` on the issuing process (v4: 7.7-8.3 µs in all, measured here: core/api write-row; shares from the first pass's profile, the rerun's within 2 points):

| # | Where | Step | Share of the 8.3 µs | Verdict in v5 | Source |
|---|---|---|---|---|---|
| 1 | main · L4 | the lens's `set` trap builds `{type, key, value}` and a one-record array | 1.5 % | NEEDED: fero owns the write surface (V4-7) | code: api/substrate.ts:396-400 |
| 2 | main · L4 | `unsendable` walks the value and deep-copies it (V4-52) | 0.36-0.44 µs; `copy` 6.1 % | AVOIDABLE: encode at issue and keep the bytes (PA-13) | code: api/data.ts:230-256, 725-737 |
| 3 | main · L4 | the methods-only door: one boolean | small | NEEDED (V4-5) | code: api/data.ts:509-515 |
| 4 | main · L4 | `admit`: the user's `validation:` if any | user code | NEEDED at the writer; at the issuer only an early answer (PA-12) | code: api/data.ts:520-528 |
| 5 | main · L4 | per record: an outcome row (`pending` in `cluster.writes`), a Promise with two closures, a pending entry and its key, the cell key as JSON, the in-flight maps | `#issue` 7.0 %, `cellOf` 3.8 %, `#outcome` 1.5 % | the pending row NEEDED (V4-7); the eager Promise AVOIDABLE (PA-13); the cell key CONDITIONAL (field writes in flight only) | code: api/data.ts:530-575, 283 |
| 6 | main · L1 (v4) | the kernel stamps, commits locally, applies to its own cell state with the state hash | kernel 28.6 % | AVOIDABLE (PA-10); in v5 the write leaves as an `ASK` | code: kernel/node.ts:1175-1260, 2813-2870 |
| 7 | main · L2 | `data` folds it; the Bind drops the pending entry | `data` 12.5 %; `#forget` 5.6 % | NEEDED (the fold, a settle by attempt id) | code: api/data.ts:607-650 |
| 8 | main | the collector | 21.3 % | PA-13 | measured here: core/api profile |

A received record on a copy (v4: 7.6 µs, measured here: core/api inbound-row; shares from the first pass's profile):

| # | Step | Share | Verdict in v5 | Source |
|---|---|---|---|---|
| 1 | `bytesIn` → the framer: a view of the chunk, the frame's crc32c in JavaScript | `crcFrame` 2.8 % | NEEDED once; native, per batch (PA-1a) | code: shell/runtime.ts:688-692; kernel/codec.ts:1053-1090 |
| 2 | each record's key and value decoded and copied out; a log entry | codec 24 %, UTF-8 14.6 %, `inbound` 4.5 % | the decode NEEDED once, faster (PA-1b); per-record log objects AVOIDABLE (PA-11) | code: kernel/write.ts:799-846 |
| 3 | the kernel's apply: cell key, ancestors, versions, `state`, `stable` + fnv | apply 12.8 %, `stable` 12.0 % | AVOIDABLE (PA-10): v5 has one writer per slot and no LWW | code: kernel/node.ts:2813-2870 |
| 4 | `Applied` → `Bind.#onApply` → `applyRec` → `data`'s lane, one record per call | Bind 3.6 %, `data` 12.4 % | the fold NEEDED, per batch (PA-11) | code: api/data.ts:623-706; api/substrate.ts:148-187 |
| 5 | the collector | 11.5 % | PA-13 | measured here: core/api profile |

- **Lower bound, issuer:** one record object, one pending row, one encode (the value walked once): about 1-2 µs plus the encode (reasoned). **A copy:** one native checksum per batch, one decode a record, one lane call per batch: about 1.3 + 0.22-1.90 µs a small row, the rows kept.
- **Gap:** about 4.4 of the issuer's 8.3 µs, and about 4 of a copy's 7.6 µs, are work v5 need not port (computed from the first pass's profile split; the rerun's profiles split the same way, results/prof-*.json).

### 2.7 The input recorder

E-42's rules: every kernel input is recorded before the kernel steps on it; bulk bytes already in the journal are recorded by reference; the journal is kept for the recorder's window.

| # | Where | Input | How it is recorded | Verdict | Source |
|---|---|---|---|---|---|
| 1 | S1 worker (relay) | the client's `ASK` | whole: it is not in S1's journal (about 238 B quiet) | NEEDED, for a relay's forward to replay | reasoned from E-42 |
| 2 | S2 worker | the forwarded `ASK` | whole | NEEDED | reasoned |
| 3 | S2 worker | main's judged batch | by journal reference once appended (5-6 B) | NEEDED | E-42 |
| 4 | S2 worker | each `APPENDED`, each fsync done, ticks | whole (5-20 B) | NEEDED | E-42 |
| 5 | S1, S3 worker | each `APPEND` | by reference (about 5 B) | NEEDED | E-42 |
| 6 | every main thread | crossings in, timers on main | not recorded: L2 and L3 run outside the kernel the tape covers | a coverage gap, not a cost: a replay of judging or of subscribe needs the order of main's inputs, one event per crossing (PA-29) | reasoned |

Cost: 1.1-1.7 % of a core per process at 50,000 appends a second, +0.24-0.34 µs an append; 0.15-0.4 % of the journal's bytes (E-42). Recording two whole `ASK`s a write adds well under 1 % of a core more (computed from E-42's `full` against `ref`). The journal kept for the window is 441 GB a day at 50,000 appends a second (E-42); written twice as drafted (PA-7). **Lower bound:** one event per input batch per thread; the design meets it once PA-29's gap is closed.

### 2.8 Timers and wake-ups

| Timer or wake | Per | Cost | Verdict | Source |
|---|---|---|---|---|
| a batch cut on a fixed 1 ms tick | process | 5-6 % of a core when idle (61-65 µs a tick) | AVOIDABLE: cut at the end of a turn or when the disk is free (PA-26) | measured here: core/sys; E-02 |
| the journal's flush | batch | 30-33 µs of CPU in place, 66-72 on a thread of its own, 67-83 through one pool hop, 104-108 through v4's two | NEEDED; one hop, never v4's two; in place only behind PA-2's guards | measured here: core/sys, core/jthread, core/sys2 |
| Raft ticks | awake group | 52-65 µs a group a second at 100 ms ticks; quiet groups stop them (2,000 idle groups ≤ 1 % of a core) | NEEDED for awake groups | E-11, E-26 |
| link pings | machine pair | 21 µs a frame; 49 µs a TLS ping and pong | NEEDED on idle links only (PA-26) | E-25, E-27 |
| election timers | group | set and reset per heartbeat; no wake unless it fires | NEEDED | reasoned |
| the lease toucher | process | one read and one `utimes` every 500 ms | NEEDED (V4-59, `dir-lease`) | code: shell/runtime.ts:106-138 |
| session renewals | process | a persisted write every server folds | AVOIDABLE as a log write (PA-9) | reasoned |
| a client's write timeout | write | a timer per write in flight (v4) | CONDITIONAL: one timer per link with a sorted list will do | reasoned |
| the cork's `nextTick` | link per turn | a microtask | NEEDED | code: shell/runtime.ts:857-865 |
| a crossing's wake | crossing | about 21-22 µs of CPU each way, quiet | 2.2 | measured here: core/hopcpu |
| v4's heartbeat `PING` + full `DIGEST` per link | link | grows with origins | not ported: Raft replaces digests | code: kernel/node.ts:1070-1105 |
| v4's compaction rescan each heartbeat | lane | 43 % of CPU in a two-member run | not ported: retention drops whole segments | docs: DESIGN-V5 8, 9 |

**Lower bound:** nothing fires on an idle process except pings on idle links and the lease toucher. **Others** (from memory): etcd ticks Raft every 100 ms per member; CockroachDB quiesces idle ranges; Kafka's replica fetchers long-poll.

### 2.9 One small write, added up

The write of the setup: C issues it, S1 forwards it (route-forward) and follows g2, S2 leads, S3 follows; links carry TLS. Every figure is computed from the measured parts above; nothing was run end to end.

**Quiet** (one write in flight, every batch one record):

| Per write | C | S1 (relay + follower) | S2 (leader) | S3 (follower) | All |
|---|---|---|---|---|---|
| messages sent + received, lean (as drawn) | 2 (2) | 6 (8) | 7 (8) | 3 (3) | 18 (21) |
| journal `writev` + `fdatasync` | 0 | 1 + 1 | 1 + 1 | 1 + 1 | 3 fsyncs |
| thread crossings, lean (as drawn) | 0 (0) | 1 (3) | 3 (4) | 1 (1) | 5 (8) |
| pool or journal-thread wakes, lean (as drawn) | 0 | 1 (2) | 1 (2) | 1 (2) | 3 (6) |
| full encodes, lean (as drawn) | 1 (1) | 0 (2) | 0 (4) | 0 (0) | 1 (7) |
| full decodes, lean (as drawn) | 1 (1) | 1 (2) | 2 (2) | 1 (1) | 5 (6) |
| checksum passes, lean (as drawn) | 2 (2) | 3 (4) | 2 (5) | 1 (1) | 8 (12) |
| payload copies, lean (as drawn) | 1 (2) | 2 (5) | 1 (5) | 0 (2) | 4 (14) |
| **CPU µs, as drawn** | 24 | 229 | 259 | 153 | **about 665** (about 640 on the rerun) |
| **CPU µs, lean** (v4's codec) | 20 | 122 | 178 | 107 | **about 428** (about 417 on the rerun) |
| CPU µs, lean with PA-1's codec (one hop per flush, PA-2's default) | 15 | 120 | 174 | 105 | about 414 (about 406 on the rerun) |
| CPU µs, the same with flushes in place (PA-2's option, behind its guards) | 15 | 84 | 138 | 69 | about 306 |

- Where the lean 428 µs go (computed from the first pass): the three flushes 197 µs (46 %); five crossings 110 µs (26 %); 18 socket operations under TLS about 86 µs (20 %); the record's own work about 33 µs (8 %), of which encode, five decodes and the folds are about 25 µs. With PA-1's codec the record's work falls to about 19 µs (414 µs in all). The rerun's parts give about 417 and 406 µs with the same shares within 2 points (the flushes about half). **So on a quiet box the per-batch and per-message constants are over 90 % of a write's CPU**: PA-2 and PA-3 matter most there, the codec least.
- How the cells were summed (first-pass parts): a TLS message 4.8 µs a side; a crossing 22; a flush 65.6 on a journal thread, 108 with v4's two pool hops, 29.7 in place; a decode 3.2 (v4's codec) or 1.0 (PA-1's); a fold 1.6 (v4, a record per lane call) or 1.0; v4's cell state and hash 2.2; the issue 3.0 (v4) or 1.5 (lean, reasoned); an encode of a one-record frame 3.6 (v4's codec) or about 1 (PA-1's); a JavaScript crc 0.38-0.67 a pass, a native one about 0.2 a call; Raft's bookkeeping at the leader about 3 (reasoned; E-10 did not time it). For example S2 lean with PA-1's codec = 7 × 4.8 + 0.7 + 65.6 + 3 × 22 + 2 × 1.0 + 1 + 0.3 + 1.0 + 0.4 + 3 = 173.6: two decodes, one to judge and one of the committed batch to fold it (3.1 step 35; the leader folds the committed bytes, PA-12); with v4's codec each decode is 3.2: about 178.
- **Lower bound, quiet, for this design** (judging on main, a kernel worker, fold-all, TLS): three flushes in place (89-98; a process that takes `replicated` answers needs one hop each instead, MEMORY 9.4), the 16 messages a route-forwarded write needs without the redundant `ANSWER` (about 70-77), five crossings (106-110), about 8 µs of record work: **about 285 µs**. Lean is 1.45-1.5 times it, as drawn 2.3 times. For any design that puts a write on two of three disks with a following client, without the thread split and over plain TCP, about 140 µs; the difference is the two-thread layout (bought for F-14) and TLS.

**Busy** (50,000 writes a second, about 60 records a batch), CPU µs per write across a client and three servers. The first version of this table took its biggest line from E-02, whose pipeline runs no Raft; its README says a real Raft group "adds its own messages, terms and timers (E-11 measures that)". E-11 timed E-10's real TypeScript port at 148-183 µs a write at 10,000 a second, against E-02's 62-81 µs at the same rate. B11 ran E-11's host at 50,000 a second: 47-55 µs a write. But there the host was at its limit: commit p50 14-18 ms and p99 84-127 ms, against the 5.73 ms bar, with only 229-285 loop rounds (fsyncs) a second per process, so each round carried about 200 writes against this table's 60 a batch. A port at its limit batches more and pays less per write than one with headroom (E-50 section 15); at 10,000 a second the same host paid 143-187 µs. So 47-55 µs is a point at a commit latency no v5 server may run at, not a ceiling, and the upper ends of the totals below are not upper bounds (the second check's rerun gave 47.1 and 55.5 µs, commit p50 16.7-19.5 ms). The host also has its own small message codec, so on that count the totals below count some codec work twice. More broadly, that host is simpler than a v5 server in ways that cut both ways (one Raft entry per write, persist before send, one thread, no TLS, no worker crossing), so the line is a range: from E-02's floor to the port as hosted. Decodes whose rows a fold keeps are priced kept (b3).

| Part | As drawn | Lean | Lean + PA-1a | Lean + PA-1 (a and b) | Lower bound (TypeScript) | Source |
|---|---|---|---|---|---|---|
| the replication pipeline: Raft, links, journal, flushes amortised, one crossing pair at the leader | 17.0 to 47-55 | the same | the same | the same | the same: 17.0 is a floor, with no Raft | E-02 (`ts-w1`: 6.9 + 5.1 + 5.0); B11 (E-10's port in E-11's host) |
| the client's link, `ASK` and `DELTA`, batched under TLS | 1.2 | 1.2 | 1.2 | 1.2 | 0.9 (TCP) | measured here: core/link |
| the relay's forward | 0.6 + 2 crossings | 0.6 | 0.6 | 0.6 | 0 (direct, PA-4) | core/link |
| encode, decode and checksums, whole cluster | 31.1-35.8 | 17.9-20.7 | 16.4-18.8 | 7.3-7.4 | 6.0 | measured here: write/codec, core/jsonval, upkeep/b3, core/escape |
| `data`'s fold, 4 processes | 2.5-10.5 | 0.9-7.6 | 0.9-7.6 | 0.9-7.6 | 0.9-7.6 | E-05 (1e3-1e6 rows) |
| v4's kernel cell state and hash, 4 processes | 8.8 | 0 | 0 | 0 | 0 | measured here: core/api |
| the issue at C | 3.0 | 1.5 | 1.5 | 1.5 | 1.0 | core/api; reasoned |
| crossings beyond E-02's | about 0.5 | about 0.2 | about 0.2 | about 0.2 | about 0.2 | E-07 |
| the recorder, 3 servers | about 1.0 | about 1.0 | about 1.0 | about 1.0 | about 1.0 | E-42 |
| **total, with E-02's floor for the pipeline** | **about 66-78** | **about 40-50** | **about 39-48** | **about 30-36** | **about 27-34** | computed |
| **total, with the port as E-11 hosts it** (at its limit: not an upper bound) | about 96-116 | about 71-87 | about 69-85 | about 60-74 | about 57-71 | computed |

- **Against this design's lower bound**, lean costs 1.2-1.5 times, lean + PA-1 1.0-1.1 times and v4's habits 1.6-2.4 times, the lower figure of each with the port's cost in both (a fixed cost shrinks every ratio), the higher with E-02's floor. With a port that costs more than B11's saturated point, the ratios shrink further and the totals grow. The first version gave 1.7-1.9 and 1.3-1.4 times against a bound priced lower than its lean column: E-02's one-thread pipeline (13.2 µs) and decodes of rows thrown away at once, as one JSON array per frame (0.6 µs). Priced alike, with the rows kept, the leader's fold of the committed bytes and a kernel worker in both, the multiples shrink; a Raft port's cost, in both, shrinks them further.
- **A field record**, the commonest write, is different: its codec costs 3.0 µs lean, 2.7 with PA-1a, 2.6 with PA-1 whole and 1.9 at the bound (B8, b3; computed as for the row). So a busy field write costs about 25-32 µs lean against 23-30 at the bound (with E-02's floor), about 1.1 times: the record format barely matters, and the Raft line and the fold set the cost.
- The biggest NEEDED item after the pipeline is fold-all: four processes decode and fold every write, 6-13 µs of a small row's 27-34 at the bound. It buys reads on every copy, warm failover and the fold check (RR-17, V5-6). It is the design's choice, not waste.
- **The codec line, summed** (per small row; first pass, then the rerun, from write/codec, core/jsonval, upkeep/b3 and core/escape). v4's encode 1.96 / 1.74 µs (its crc 0.36 / 0.31); its decode 3.21 / 2.71 µs with the crc, 0.6 µs more when the rows are kept. As drawn: C's copy and encode, the relay's decode and encode, the leader's two decodes and four encodes (the batch, two links, the WAL), S1's fold and `DELTA`, S3 and C: 7 encodes, 6 decodes, 4 of them kept: 31.1-35.8. Lean: one encode at C; at the leader a decode to judge, a header and a batch crc, and a kept decode to fold; S1, S3 and C a kept decode each: 17.9-20.7. PA-1a turns six JavaScript crc passes into native ones (about 0.05 µs each): 16.4-18.8. PA-1: the value as JSON (encode 0.54 µs plus the escape's walk, 0.06), decodes of 0.89-0.97 µs thrown away and 1.30 µs kept: 7.3-7.4. The bound: one encode and four kept decodes, one per folding process: 6.0.

Against the competitors measured on this box (CPU µs per write, all servers):

| System, setting | CPU per write | What differs | Source |
|---|---|---|---|
| fero, lean + PA-1 (computed) | about 30-36 to about 60-74 (+ the client's share inside) | 3 copies on disk; 4 processes decode and fold; a following client | this page |
| fero, lean (computed) | about 40-50 to about 71-87 | the design as written, built well | this page |
| fero, as drawn in v4's habits (computed) | about 66-78 to about 96-116 | | this page |
| E-10's TypeScript Raft port alone, E-11's host, 100 B, 3 processes | 47-55 at 50,000/s | one Raft entry per write, no client, judging, fold or record codec; at its limit there (commit p50 14-18 ms) | B11 |
| E-02's bare TypeScript pipeline, 100 B, 3 processes | 13.2 (one thread) / 17.0 (a kernel worker) at 50,000/s | no Raft, client, judging, fold or record codec | E-02 |
| Redis 7, `appendfsync always`, one server, no copies | 8.0-9.3 at pipeline 1 | one copy, one thread, no checksum | E-09a2 |
| Kafka 4.4, 3 brokers, `flush.messages=1`, 1 KiB | 20.9 (7.3 with no fsync) | never decodes keys or values on a broker (it walks record headers) | E-09c |
| Redpanda, 3 nodes, its default (on disk at a majority), 1 KiB | 5.8 + about 1.1 in the OS | C++, a thread per core, no key or value decode on a broker | E-09d |
| NATS JetStream, 3 servers, its default (in memory at a majority), 100 B | 23 | no fsync per message at its default | E-09b |
| etcd 3.5, 3 members, fsync before every answer | 121 (77 in the leader) + 34 in the client | protobuf, gRPC, one Raft group, bbolt | E-09e |

The comparison is rough (reasoned): Kafka and Redpanda ran 1 KiB records at their own maximum rates, where per-record CPU is lowest; Redis keeps one copy; fero's figure is a sum of parts. Against Redpanda, the matched system nearest fero's shape, lean + PA-1 costs about 4-11 times the CPU per write, the low end with E-02's floor; most of the rest of the gap is fold-all and the TypeScript Raft port against C++ (E-02: 13.2 against Rust's 9.9 µs at 50,000/s, without Raft). Against Kafka matched it is about 1.4-3.5 times; against etcd, about a fifth to a half (0.19-0.48 of its 155 µs with the client).

## 3. The write paths

### 3.1 One plain write, from the assignment to every fold and the answer

LAYERS 8.2's path, with v4's code where v4 has the step. Bytes: a small row is 124-147 B in v4's codec (write/codec).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | C main L4 | `f.data.x = row`: the lens's `set` trap makes `{type, key, value}` and a one-item array (code: api/substrate.ts:396-400) | 3 small allocations | NEEDED: fero owns the write surface; nothing shows before commit (V4-7) |
| 2 | C main L4 | issue: the methods-only door; check the key; **deep-copy the value** (V4-52); an outcome row (`pending`); a Promise with two closures; a pending entry; the cell key as JSON; in-flight maps (code: api/data.ts:497-600, 238-254, 725-737) | about 10 allocations; the copy 0.36-0.44 µs (measured here: write/codec) | outcome row NEEDED (V4-7). The copy AVOIDABLE: encode at issue, keep bytes for a resend. An eager Promise AVOIDABLE (PA-13) |
| 3 | C main L2 | attempt id (session, sequence) and the per-partition issue order (O.seq) | two counters; 2-6 B | NEEDED: exactly once (F-02, E-20); issue order (A-10, E-48) |
| 4 | C main L3 | admission: take one credit | a counter | NEEDED: overload (E-39: 79-82 % goodput at 2 × with credits) |
| 5 | C main L1 | route: route-forward sends to S1; direct hashes the partition key to a slot and looks up the group's leader | a 64-bit hash and a table read (reasoned) | CONDITIONAL: only for a client that sends direct (PA-4) |
| 6 | C main L0 | encode the `ASK`; frame header; **crc over the frame**; one copy out per frame (code: kernel/codec.ts:679-783) | encode 1.7-2.0 µs a row in frames of 256, 3.6-3.7 µs alone (crc 0.31-0.36) | encode NEEDED once, at the origin. The crc CONDITIONAL: TLS guards the wire; the stored checksum is the leader's (PA-1a) |
| 7 | C main L0 | cork at the first small frame, uncork next tick: one `writev` per turn per link (code: shell/runtime.ts:428-445, 801-863) | 1 syscall per turn | NEEDED |
| 8 | C → S1 | network | 1 net (20 µs p50, 48 µs p99 one way on loopback; E-01) | CONDITIONAL: AVOIDABLE when C sends to S2 direct (PA-4) |
| 9 | S1 L0 | read; **crc check**; the frame is a view of the chunk (code: kernel/codec.ts:1043-1100) | scan 0.63-0.67 µs a row | CONDITIONAL: the leader checks again; a relay that reads one header field need not (PA-12) |
| 10 | S1 main L2 | **`validation` where a write first enters** (DESIGN-V5 4.5): full decode, then the user's rule | decode 2.7-3.2 µs a row + the rule | AVOIDABLE: the writer runs it again after dedup and its answer counts. Only an early refusal is lost (PA-12) |
| 11 | S1 main L1 | route: read the key, hash to a slot, the slot table, group g2, its leader S2 | key decode 0.72-0.84 µs; a hash | NEEDED under route-forward. With the default partition function the client puts the slot in the header: a header read (PA-12) |
| 12 | S1 main L1 | `forward.once`: remember (attempt, copy) and the client link to answer on | an allocation | NEEDED under route-forward (E-20: 1 rule for `sess`) |
| 13 | S1 main → worker | cross to the worker that owns member links | 1 crossing (16-44 µs one way idle); a copy into a transferable buffer | AVOIDABLE: end client links on the worker (PA-3) |
| 14 | S1 worker L0 | build the forward frame; v4 re-encodes the record and its crc (code: kernel/write.ts:41-45) | encode 1.7-2.0 µs + crc | AVOIDABLE: forward the client's record bytes under a new small envelope; under `sess` nothing in the body changes at a hop (E-20) (PA-5) |
| 15 | S1 → S2 | write; network | 1 syscall, 1 net | CONDITIONAL: only under route-forward (PA-4) |
| 16 | S2 worker L0 | read; **crc check** (code: kernel/codec.ts:1075, 1083) | scan 0.63-0.67 µs a row | NEEDED: the leader must not log bytes it cannot read |
| 17 | S2 worker → main | cross to main, where judging runs; wait for main's event loop | 1 crossing; event-loop delay p99 1.5-14 ms under 10,000-50,000 writes a second (E-07) | NEEDED while judging reads `data`'s rows on main (LAYERS 10 item 1, RR-17) |
| 18 | S2 main L2 | **full decode** of the `ASK` | 2.7-3.2 µs a row | NEEDED: judging reads the key and maybe the value; the leader folds it anyway |
| 19 | S2 main L2 | judge in order: dedup (session floor and outcomes, from S2's fold of `#sessions`); shape checks; `validation`, `schema`, `rules.write`; conditions; ops | a few map reads: about 0.1-1 µs plain (reasoned); user code if declared | NEEDED: F-02 (E-20), shapes, rules (A-04, E-22) |
| 20 | S2 main L2 | stamp: the slot's next sequence; writer time `t` for the batch | a counter a slot; a median of 3 clocks a batch | NEEDED: cursors and versions per slot (E-31); TTLs and leases (E-21) |
| 21 | S2 main L2 | keep the judged record in the overlay for the next writes' judging | an entry | NEEDED: judge on the log end (A-04; DESIGN-V5 4.3) |
| 22 | S2 main L2 | **encode the result batch** | v4's way: a full re-encode, 1.7-2.0 µs a row | CONDITIONAL: NEEDED for ops (`incr` computes a value). AVOIDABLE for a plain or conditional set whose bytes step 18's strict decode found canonical: copy them, with the slot sequence in front; re-encode anything else, since the bytes came from an untrusted client and every copy and reader version will parse them (PA-5). Encode once is already the design's text (DESIGN-V5 4.1: "encoded once ... the same bytes are the journal row and the wire"): a build trap |
| 23 | S2 main → worker | cross back with the batch | 1 crossing; transfer | NEEDED while judging runs on main |
| 24 | S2 worker L1 | `Propose(batch)`: one Raft entry per batch; `Ready` gives the followers' messages and, with async storage writes, the leader's own append as a separate job | small allocations per batch | NEEDED: Raft (E-10) |
| 25 | S2 worker L0 | an `APPEND` to S1 and S3: a per-link header plus the batch; v4 encodes each record again for each link (code: kernel/node.ts:1224-1238) | v4: an encode and a crc per link; lean: `writev([header, batch])`, crc over the header only | send NEEDED; the re-encode per link AVOIDABLE (PA-1a, PA-5): a build trap, as step 22 |
| 26 | S2 worker L0 | **the leader's journal**, beside step 25: a row header and the same batch bytes, `writev`, then `fdatasync`; one fdatasync covers every group queued while the last ran | sync write 0.6 µs; a pool hop 26-30 µs p50 (write/hop); fsync 179 µs p50, 519-676 µs p99 (E-01). v4: async `fs.write` + async `fs.fsync` (2 pool hops), no group commit, the row copied (code: shell/runtime.ts:460-488, 48-56) | NEEDED: `persisted` (V5-5); group commit (E-12). It runs **beside** step 25, never before it: already the design's text (DESIGN-V5 4.2: the leader "writes its own journal in parallel"; LAYERS 8.2 step 5), so sending first is a build trap, not a finding. v4's second pool hop and the row copy AVOIDABLE (PA-2). If the flush runs in place on the kernel thread (PA-2's option), the corked `APPEND`s of step 25 must leave first (2.4, "The cork and the flush"), and no batch holding a `replicated` write may arrive meanwhile (3.3) |
| 27 | S2 worker L0 | the recorder: one tape entry per kernel input; bulk bytes by journal reference | 1.1-1.7 % of a core at 50,000 appends a second (E-42) | NEEDED: OPS-11, replay of an incident |
| 28 | S2 → S1, S3 | network, in parallel | 1 net each | NEEDED |
| 29 | F worker L0 | read; **crc check**; Raft's log-matching check | scan 0.63-0.67 µs a row | NEEDED once per copy: an ack for bad bytes would count toward the commit |
| 30 | F worker L1 | `Step(APPEND)`: append; keep the batch bytes (a view of the chunk, copied once per batch if kept past the step; code: kernel/codec.ts:1030-1042) | ≤ 1 copy a batch | NEEDED; the copy CONDITIONAL |
| 31 | F worker L0 | journal: `writev` + `fdatasync`, grouped with F's own leader rows for other groups. v4 copies the frame twice first (code: kernel/node.ts:1604, shell/runtime.ts:48-56) | a sync write, a pool hop, an fsync | NEEDED (`persisted`); v4's copies AVOIDABLE (PA-2) |
| 32 | F worker → S2 | `APPENDED` once the fsync is done; one per link per turn covers every group in it | about 0.1 µs, 1 syscall, 1 net, about 20 B | NEEDED |
| 33 | S2 worker L1 | commit: the second of three copies on disk; the leader's own counted only after its fsync | Raft bookkeeping | NEEDED (Raft; E-48: commit never reads an early mark) |
| 34 | S2 worker → S1, S3 | the new commit index, at once in an empty `APPEND` (etcd's way, from memory), or on the next batch | 1 small frame per follower when idle | NEEDED: followers fold only what they know is committed |
| 35 | S2 worker → main | committed entries cross to main; as drawn, main decodes the batch again (LAYERS 8.2) | 1 crossing; a second full decode, 2.7-3.2 µs a row | the crossing NEEDED; the second decode NEEDED unless guarded. Folding the objects it judged (needing only "commit ≥ N") would save one decode at the leader, but its fold then differs from the followers' wherever decode(encode(v)) is not v (the escape, -0, NaN, big integers, an op's value): the very drift fold-all and F-21 exist to catch, shown after a failover. So the leader folds the committed bytes, or the shortcut sits behind a simulator check that every judged value round-trips, plus F-21's hash (PA-12) |
| 36 | S2 main L2 | `data`'s lane folds the batch; the session's outcome is group state; views and taps run | 0.22-1.90 µs a record per batch; v4 calls the lane per record, 3-10 × more (E-05; code: api/substrate.ts:148, kernel/node.ts:1594-1598) | NEEDED (fold-all, RR-17); per record AVOIDABLE (PA-11) |
| 37 | S2 main → worker → S1 | the `ANSWER` (ok, slot, epoch, sequence), from main after the fold | 2 crossings, a small encode, 1 net, about 30 B | AVOIDABLE in that form: leave the worker at step 33 with step 34's index (PA-3). AVOIDABLE altogether when S1 folds g2: S1 sees the attempt id in the batch (PA-27; v4 does this, code: kernel/write.ts:54-57) |
| 38 | S1, S3 worker → main | the committed batch crosses to main | 1 crossing each; 27-40 ns a record busy (E-07) | NEEDED (fold-all) |
| 39 | S1, S3 main L2 | full decode, then the lane's fold | 2.7-3.2 µs a row (0.4-0.8 µs less with a short-ASCII decoder) + 0.22-1.90 µs | NEEDED (fold-all); the decoder's speed PA-1b |
| 40 | S1 main L3 | subscribers: an index lookup per record; a `DELTA` per matching subscriber; v4 encodes it again per link | v4: 1.7-2.0 µs a row per subscriber; lean: the record's bytes | send NEEDED; the re-encode AVOIDABLE (PA-5) |
| 41 | S1 main | the relay settles its forwarded attempt (from its own fold, or the `ANSWER`) and drops the `forward.once` entry | a map delete | NEEDED under route-forward |
| 42 | S1 → C | the `DELTA` (and, as drawn, the `ANSWER`) on the client link | 1 syscall, 1 net | NEEDED (one of the two) |
| 43 | C main | read, crc check, decode, fold; the write now shows (V4-7); the promise resolves once C's own view shows it; the outcome row turns `committed`; C's views and taps run | 2.7-3.2 µs + the fold | NEEDED: C follows R (read your writes, DESIGN-V5 4.4) |

With `standbys` above the voter count, each learner copy repeats steps 28-31 and 38-39, off the commit's path.

**Counted four ways** (computed from the measured parts):

| Per write (C follows R; 3 voters) | As drawn, built v4's way | Lean | Lean, direct to the leader (PA-4) | Lower bound |
|---|---|---|---|---|
| net trips one way on the caller's path | 6 (C→S1→S2→F→S2→S1→C) | 6 | **4** | 4 |
| round trips | 3 | 3 | 2 | 2 |
| frames sent in all | 11 | 9 (no `ANSWER`s) | 8 | 6-8 |
| fsyncs in all / on the caller's path | 3 / 1, or **2 in a row** if the leader fsyncs before it sends | 3 / 1 | 3 / 1 | 3 / 1 (Raft persists on every voter before it acks) |
| pool hops per copy | 2 | 1 | 1 | 0-1 |
| thread crossings on the caller's path | 6 (S1: 2, S2: 4) | 2-4 | 2 | 0, only if the leader judged on its kernel thread |
| main event-loop waits on the caller's path | 4 | 1-2 | 1 | 0 |
| full encodes of the record | 7 | 1-2 | 1-2 | 1 |
| full decodes | 6 | 5: one per copy that folds, plus the leader's judging decode (step 35) | 5 | 4: one per copy that folds, only with PA-12's guarded shortcut; else 5 |
| checksum passes over the record | about 12 | 6 | 6 | 5-6 |
| user-space copies of the record | about 20, plus C's copy of the value | 3-5 | 3-5 | 1 per receiver |
| codec CPU, whole cluster, a small row (2.9's sum, rows kept) | **31.1-35.8 µs** | 17.9-20.7 µs; 16.4-18.8 µs with PA-1a's native checksum; 7.3-7.4 µs with PA-1 whole | the same | 6.0 µs |

- **Measured anchors.** E-02's TypeScript pipeline with the kernel on a worker committed at p50 0.92 ms and p99 3.68 ms at 50,000 a second (no client, relay or judging). MEMORY 9.3 puts the committed answer at p50 0.97 ms, p99 4.45 ms. The bar is C + 5 ms = 5.73 ms (E-01). On one box the drawn path's extra 2 nets and 4 crossings add about 0.1 ms at p50 and 0.27 ms at p99 when idle (computed: 2 × 20-48 µs + 4 × 16-44 µs), and its 2-3 extra main-loop waits can add 1.5-14 ms each at p99 under load (E-07): that part alone can break the bar.
- **Lower bound.** Time: the record reaches the leader and one follower, sits on two disks, and the answer comes back: 2 round trips plus one fsync, the leader's beside the follower's. No `persisted` commit on this box beats 0.323 ms at p99 (the second-fastest of three fsyncs, no network: RR-15, VERDICT 2). CPU: one encode at the origin, one checksum made and one checked per copy, one decode and one lane call per batch per folding copy. Bytes: each link once, each disk once.
- **Gap.** Against the design as written and built well (lean): one round trip from route-forward (PA-4); the codec CPU of v4's format (PA-1: a native checksum per batch on every shape, a JSON value on rows of many short strings); one redundant `ANSWER` (PA-27); a second disk write per copy as drafted (PA-7). Against v4's habits also: 2-4 crossings and 2-3 main-loop waits (PA-3), re-encodes (PA-5), and up to one fsync if the leader's is not beside replication; the last two the design's text already avoids (build traps).
- **Others** (from memory). Kafka: the producer batches per partition and sends to the leader its metadata names; one CRC32C per batch, over the bytes after the CRC field; the broker writes offsets into the header outside the CRC, never re-encodes, never decodes keys or values, but walks each record's header to validate it; followers fetch, by `sendfile` without TLS; `acks=all` waits for page caches, no fsync by default. etcd: any member forwards to the leader; the leader writes its WAL while it sends (Raft thesis 10.2.1); the member you asked answers after its own apply. TiKV: a smart client goes to the leader; the Raft log is appended on a separate I/O thread while it sends. JetStream: routed to the stream's leader; no fsync per message by default.

### 3.2 Discovery and the first link (the cold first write)

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | C main | `fero('R')`: read the config cascade (code: api/config.ts) | file reads, once per process | NEEDED once |
| 2 | C → directory | connect to a seed or the box's rendezvous: TCP, `HELLO`, the `DOOR` proof | about 3 RTT (reasoned from DESIGN-DOOR) | CONDITIONAL: AVOIDABLE when the seed itself serves R (PA-21) |
| 3 | C → directory | ask once for an address of R (V5-3) | 1 RTT | NEEDED once per resource, unless step 2 is skipped |
| 4 | C → S1 | connect: TCP, TLS 1.3 (0 RTT when resumed), `HELLO` and `DOOR`; the token's signature checked once | 3-4 RTT; one check (77-112 µs) | NEEDED once per link |
| 5 | C → S1 | members, slot table and leaders from R itself (V5-3): a `SUB` of the home group's records | 1 RTT; 56-196 B run-length coded (E-36) | NEEDED once; could ride the welcome (PA-21) |
| 6 | C → `#sessions` | register a session: a write that commits at `persisted` | 1 commit | NEEDED once per process (F-02); on the first write's path AVOIDABLE (PA-21) |
| 7 | S2 writer | the group's writer must know the session lives, from its own fold of `#sessions` (E-20) | a follow lag across resources | CONDITIONAL: the first write may arrive first; carry the registration's position and wait only if behind (PA-21) |
| 8 | C → S1 | follow R: a `SUB` and its first snapshot | 1 RTT + the snapshot's bytes | NEEDED for read your writes (4.5) |
| 9 | C | the first write: 3.1, with code not yet optimised and first-touch allocations | cold JIT | CONDITIONAL (first op) |

- **Measured:** a cold browser client made its first committed write over `wss` in 13 ms (a Web Worker) and 17 ms (a page) from its connect call; in Node 58 ms, most of it Node's WebSocket client loading (E-40).
- **Lower bound:** TCP and TLS (1-2 RTT, 0-1 resumed), then one flight with `HELLO`, the proof, the session registration, both `SUB`s and the write, then the write's commit: about 2-3 RTT plus one commit (reasoned). **Gap:** done one after another, steps 2-8 are 7-9 RTT plus two commits in a row (PA-21).
- **Others** (from memory): a Kafka producer fetches metadata from a bootstrap broker, gets a producer id, then links to each leader. Redis: connect, `AUTH`, the command.

### 3.3 The answer at each stage: received, replicated, committed (V5-5's second step)

Every write still commits exactly as 3.1 (E-48: answer stages leave Raft's commit, election and recovery as `persisted`'s). Only the caller's answer moves.

| # | Stage | Extra step over 3.1 | Work | Verdict |
|---|---|---|---|---|
| 1 | received | after the leader's in-memory append (3.1 step 24), `ANSWER(received)` on the link the `ASK` came in | a small frame per write or per run of a session's writes | CONDITIONAL: only for writes that asked. After the append, never on arrival (E-13: etcd dropped writes caught in a handover in 8 of 15) |
| 2 | replicated | each follower hands each batch to the OS **as it arrives**, before its fsync, and reports early | a small frame per follower per batch | CONDITIONAL: a flag on the `APPEND` when a batch holds a `replicated` write, so `persisted` traffic pays nothing (PA-28) |
| 3 | replicated | the leader counts its own copy only after its own write call | none | NEEDED (else `replicated` would not survive the leader's process crash; MEMORY 9.4) |
| 4 | replicated | when two copies hold it in memory: `ANSWER(replicated)` | a small frame | CONDITIONAL |
| 5 | both | the client keeps the write pending, with its bytes, until commit; resends after a failover; reads wait for it (Y); the library's own steps never use early answers (W1) | memory per pending write | NEEDED: E-48's three rules |
| 6 | both | the committed outcome still reaches the client: a second answer, or the `DELTA` it follows anyway | a frame, or none when it follows | CONDITIONAL (PA-27) |
| 7 | both | **two marks on the leader; commit must never read the early one** | none at run time; a simulation monitor | NEEDED (a bug here silently makes `persisted` into `memory`; MEMORY 9.4) |

- **Speed** (MEMORY 9.3, from E-02's stages; TypeScript p50 / p99): received 0.15 / 0.20 ms; replicated 0.36 / 0.69 ms; committed 0.97 / 4.45 ms.
- **Lower bound:** received = one round trip to the leader plus its append; replicated = two round trips, no disk. **Gap:** route-forward adds one round trip to every stage, about doubling `received` (PA-4). A journal that queues writes arriving during an fsync (as E-02's does) delays `replicated` by up to one fsync, so a write on arrival is NEEDED for this stage (PA-2; MEMORY 9.4). An in-place `fdatasync` on the kernel thread is such a queue: while it runs, no batch on that thread reaches the OS, so a process whose journal may get a `replicated` batch keeps its flush off the thread (PA-2). With a write on arrival, a batch written after an fsync started is not covered by it: the durable mark must be the file offset at the fsync's start, never the offset at its end. That is already SIMPLICITY's `journal` rule 2 ("an entry waits for one that began after its write"). A wrong mark silently turns `persisted` into `replicated` (reasoned; a monitor in the simulator, PA-2).
- **Others** (from memory): Kafka's `acks=0`, `1` and `all` are the same idea; `acks=1` answers after the leader's page-cache write.

### 3.4 A method call that returns a value

`methods:` is the door: a client changes data only through methods (V4-5). A handler runs on the server the caller reached (API.md 4, "Methods").

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | C main | `f.methods.buy(arg)`: the argument copied and checked against the wire's limits, encoded into a `CALL` with a call id (code: api/methods.ts) | a walk, an encode | NEEDED |
| 2 | C → S1 | network | 1 net | NEEDED |
| 3 | S1 main | decode the argument; open the handler's context (the per-call collector that makes the return wait for its writes; code: api/data.ts:463-467) | a decode; per-call context | NEEDED |
| 4 | S1 main | the handler reads `ctx.data` (S1's committed fold) and writes `ctx.data.x = ...` | 3.1 steps 1-3 with S1 as the issuer | NEEDED |
| 5 | S1 → S2 → ... | each write goes to its slot's leader: 3.1 steps 13-36 | a forward when S1 does not lead the slot | CONDITIONAL: AVOIDABLE when the call runs where its writes are led (PA-25, an API question) |
| 6 | S1 main | the return waits until its writes commit (S1 learns from its own fold of g2) | the commit's wait | NEEDED: a call answers after its writes commit |
| 7 | S1 main | encode the `RESULT`; v4 does not clone it first (code: api/methods.ts:250) | an encode | NEEDED |
| 8 | S1 → C | network | 1 net | NEEDED |
| 9 | C main | decode the result; resolve once C's own view has the call's writes | a decode; maybe a short wait | NEEDED (read your writes) |

- **A keyed call** (`{ key }`) adds a claim in `#calls` (a conditional write at `persisted`) before the handler, and a stored result (another commit) before the answer (DESIGN-V5 4.5): three commits in a row. W1 forbids an early claim answer (E-48), so three is the floor under today's rules.
- **Lower bound (unkeyed):** one round trip to a server that leads the written slots, and one commit. **Gap:** one round trip more for every handler write to a group the reached server does not lead: with 3 servers, about 2 of 3 groups (PA-25).
- **Others** (from memory): Redis Cluster runs a script only on the node that owns its declared keys; etcd's `txn` is one request judged at the leader.

### 3.5 A conditional write, and ops

3.1, with these differences at the writer:

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | C | encode the condition (`if: { version }`, `{ absent }`, a fence) or the op (`incr(n, { min })`) apart from the record | a few bytes | NEEDED. Keep the record's bytes whole and the condition or op in a section of its own, so the leader can copy the record when the result equals the request (PA-5) |
| 2 | S2 main | judge the condition against the committed row plus the overlay | ≤ 3 µs target (PERF-10; DESIGN-V5 8) | NEEDED |
| 3 | S2 main | an op computes the new value; the leader encodes it | an encode of the value | NEEDED for ops: followers apply plain values and never re-run an op |
| 4 | S2 | **a refused first send is not appended**; its answer still waits for the commit of the log end it was judged on (A-04) | up to one commit's wait; no disk write | NEEDED (a refusal judged on a tail later lost was wrong in 10 of 100 seeds, E-22) |
| 5 | S2 | a refused resend is appended (an entry with no data) | an entry | NEEDED (exactly once across copies; E-20) |
| 6 | all | the answer carries a value or a decision, so it never goes out at an early stage | none | NEEDED (E-48: such results changed after a loss) |

- **One hot key:** judging on the overlay lets writes to one key pipeline, many conditional writes per commit with no lock held across it. With TiKV-style latches the same key would manage 1,179-1,616 writes a second (MEMORY 9.3, computed there). Already the right shape.
- **Lower bound:** as 3.1; a refusal, one round trip plus the wait for the tail's commit. **Gap:** a refusal waits for the whole log end's commit even when no tail entry touches its row. Closing it needs a read-index round instead: a rule change for a small gain. Not advised.

### 3.6 A batch

Many records to one partition, all or none (DESIGN-V5 4.3), or many writes made in one event-loop turn.

| # | Step | Per batch | Per record | Verdict |
|---|---|---|---|---|
| 1 | client: one sink call (`patch`), or separate assignments gathered into one frame per turn (code: shell/runtime.ts:801-863) | frame header, crc, syscall | lens record, outcome row, attempt id as base + i (code: kernel/codec.ts:665-667) | NEEDED |
| 2 | relay: one forward | one | none | CONDITIONAL (route-forward) |
| 3 | leader: crossings, one Raft entry, one journal row, one fsync, one `APPEND` per follower, one ack | all | decode, judge, slot sequence | NEEDED |
| 4 | all or none: the first refusal refuses the batch | | judged one by one | NEEDED |
| 5 | each copy: one lane call | one (E-05: 0.25 against 0.85 µs a record at 1,000 rows; 0.98 against 11.4 µs with one `group` view) | the fold | NEEDED; v4's per-record `applyRec` AVOIDABLE (PA-11) |
| 6 | one answer per batch, or per run of attempts (v4's `WACK` carries issuer, first id, count) | a frame | none | NEEDED |

- **Lower bound:** per record, only a decode and a fold on each copy, and a judgement and a slot sequence at the leader; everything else per batch. The design reaches it once the lane is called per batch. **Caps:** a Raft batch at most 1 MB, a catch-up `APPEND` at most 4 MB (DESIGN-V5 4.1).

### 3.7 A saga across two partitions, with fenced locks

A unit writes partitions p (group gA) and q (group gB) (E-24's program; API.md 4 "Locks and fences"). Each step commits at `persisted` before the next, because the library's own steps wait for durable answers (W1).

| # | Step | Commits in a row | Verdict |
|---|---|---|---|
| 1 | claim the lock of p in `#locks` (absent, or its lease lapsed); its version is the token | 1 | NEEDED (E-24 `claim.*`) |
| 2 | claim the lock of q, in key order | 1 | NEEDED under E-24's rules (key order prevents deadlock) |
| 3 | read `#sagas` for an unfinished unit on these partitions; resolve it first | 1 read round | NEEDED (E-24 F3) |
| 4 | write the intent `run` | 1 | NEEDED (E-24 `begin.*`) |
| 5 | step at p, fenced (`if: { fence: { lock, token } }`) | 1 | NEEDED (E-24 `step.*`) |
| 6 | step at q, fenced | 1, or 0 more beside step 5 | CONDITIONAL: running steps together needs E-24's model run again (PA-24) |
| 7 | record `done` | 1 | NEEDED (E-24 `close.*`) |
| 8 | release both locks | 1 | AVOIDABLE on the caller's path: answer after `done`, release after (PA-24) |

- **On the caller's path:** 6-7 commits and a read round: about 7 ms at the median in TypeScript (7 × MEMORY 9.3's 0.97 ms; computed). **Lower bound:** two commits in a row (two-phase commit as Percolator runs it), one with a deterministic order as Calvin's (from memory). **Gap:** about 3 times. The cheap cuts keep E-24's rules or need one rerun; the deep cuts (the intent in the first lock's row, claims in parallel) change 38 model-checked rules (SIMPLICITY 3.1: `saga-intents` 30, `lock-rows` 6, `fence-tokens` 2). Not advised now.
- **Others** (from memory): Kafka transactions take three to four rounds in a row; TiKV's async commit and one-phase commit one to two.

### 3.8 A big record (1 MiB)

3.1 with a 1 MiB value. API.md caps a record at 1 MB (SC-15).

| # | Where | What changes | Work | Verdict |
|---|---|---|---|---|
| 1 | C | encode: 3.0-3.6 ms, of which v4's JavaScript crc is about 2.6-3.0 ms | measured here: write/codec | the encode NEEDED; the slow crc AVOIDABLE (PA-1a) |
| 2 | each receiver | the frame straddles many socket chunks: the framer builds it in its own buffer, copying each byte once plus once per doubling (code: kernel/codec.ts:1030-1042) | about 0.1 ms per copy (84-124 µs for one 1 MiB copy, write/codec) | NEEDED once per receiver |
| 3 | relay, leader, followers, client | each crc check: about 2.6-3.0 ms in JavaScript | write/codec | one per copy NEEDED, at native speed (0.2 ms); the rest AVOIDABLE (PA-1a) |
| 4 | relay | v4's way: decode for `validation` (2.8-3.5 ms) and re-encode (3.0-3.6 ms) | write/codec | AVOIDABLE (PA-5, PA-12) |
| 5 | leader | decode, and as drawn decode again at commit; encode the batch | write/codec | one decode NEEDED (0.2-0.6 ms without the crc share); the rest AVOIDABLE |
| 6 | leader, followers | journal: 1 MiB into the page cache; the fsync carries it | E-35: a 1 MiB record ten times a second raised other partitions' p99 in the same journal 1.18-1.26 × | NEEDED; within SC-15's 1.2 × bar, just. A side file helped the victims a little (1.12 ×) but made the big record 4 times slower (5 → 23 ms p99), and E-35 judged it "not worth a mechanism now"; cutting into 64 KiB journal batches made victims worse (2.2-3.9 ×) (PA-6) |
| 7 | every link | one link per server pair carries every group's frames; a 1 MiB `APPEND` holds it for its transfer time | about 8 ms at 1 Gb/s, 0.8 ms at 10 Gb/s (computed) | CONDITIONAL head of line: cut big records into frames and let small frames pass between the pieces (PA-6) |
| 8 | main threads | a 3 ms crc check or decode on main holds every other write that server judges or folds | reasoned from the parts | AVOIDABLE in most part: a native crc, checked on the worker (PA-1a) |
| 9 | each copy | `data` installs the value by reference: no copy at the fold (code: api/substrate.ts:8-10) | none | NEEDED, already lean |

- **On the path, built in v4's habits:** the crc passes 9 times in a row (the client's encode, the relay's check and re-encode, the leader's check, batch and first `APPEND`, the faster follower's check, S1's `DELTA` and the client's check): about 23-26 ms. With the decodes' and encodes' own work, about 29-32 ms of CPU on the path (computed from write/codec, string form: encode 3.41-3.55 ms, crc 2.58-2.96 ms, decode 3.17-3.52 ms), against the 5.73 ms bar for a whole write.
- **Lean** (the design as written, built well: crc32c stays, DESIGN-V5 4.1): one checksum made, checked by the leader, the faster follower and the client (4 passes); the relay reads a header; the `APPEND` and the `DELTA` reuse the bytes; one encode and two decodes on the path (0.6-0.8 ms each without their checksum). With a crc32c in JavaScript that is 4.9 ms of checksum with a slice-by-8 table (1.22 ms a MiB) or 10.3-11.8 ms with v4's: **about 6.7-14 ms of CPU** on the path, plus the framer's copy at each receiver, the transfer and the fsync (computed from write/crc and write/codec).
- **With PA-1a** (CRC-32 by Node's native `zlib.crc32`, once per batch): the 4 passes take 0.8-0.94 ms, so **about 2.6-3.3 ms** (computed). The value's form (PA-1b) hardly matters here: a 1 MiB value is one long string or byte array, which both forms copy at memory speed.
- **Lower bound:** 1 MiB to the leader and one follower, on two disks; one checksum per copy at memory speed; one decode per folding copy. **Others** (from memory): Kafka checks the CRC with Java's CRC32C intrinsic, never decodes the value, and serves followers by `sendfile`; its default record cap is 1 MB. etcd caps a request at 1.5 MiB. Redis serves a big value on its one thread, so big keys stall it.

### 3.9 A write while its slot moves

Group A gives slot s to group B (LAYERS 8.3; under V5-2 the resource's home leader decides, the two leaders run it).

| # | When | What the write meets | Work | Verdict |
|---|---|---|---|---|
| 1 | before A's `fenced` is in A's log | 3.1 at A | none extra | NEEDED |
| 2 | after `fenced` | A answers `moved(B)` and appends nothing | 1 RTT to learn it | NEEDED (DESIGN-V5 4.4) |
| 3 | relay or client | updates its slot table; resends to B at once | a table write | NEEDED |
| 4 | B before its `open` commits | B answers `retry` | 1 RTT | NEEDED: B cannot judge s yet (LAYERS 8.3) |
| 5 | client | **fero's backoff starts at 200 ms** ("jittered backoff from 200 ms to `election.ms`", API.md 4, DESIGN-V5 4.3) | a wait of ≥ 200 ms | AVOIDABLE: the window is 2.7-4.1 ms at p50 (idle to 10,000 writes a second) and 16.7 ms at p99 at 10,000 a second (E-13). B already answers `retry` with a retry-after (DESIGN-V5 4.2, 4.3); the change is letting a retry-after of a few ms count below the floor (PA-20) |
| 6 | B after `open` | 3.1 at B; a resend of a write A committed before the fence finds its outcome in the carried session table | a map read | NEEDED (E-32's carried floor) |
| 7 | issue order | later writes to the same partition, pipelined behind, bounce too and are resent in order (O.seq) | ≤ 1 RTT each | NEEDED (A-10, E-48) |

- **Lower bound:** a caught write waits the window (about three commits) plus one round trip. **Gap:** the 200 ms floor, about 12-70 times the window. Holding the write at B would break A-02's "refuse at once, never hold" (E-13 found etcd drops writes caught in a handover), so the fix is the short `retryAfter`.
- **Others** (from memory): Redis Cluster answers `MOVED` (or `ASK` mid-migration) and the client retries at once; Kafka's client backs off 100 ms after `NOT_LEADER`.

### 3.10 A retry after a lost answer

The write committed, but S1's link to C broke before the answer arrived.

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | C | notices the link is gone; the write is pending in `cluster.writes` with its bytes | none | NEEDED (API.md 4 "Answers") |
| 2 | C | waits its backoff (200 ms up to `election.ms`) | a timer | NEEDED in general: the client cannot tell a plain link loss from a dead server that led groups, and the floor exists for that storm (DESIGN-V5 4.3: "so an election never brings a retry storm"). AVOIDABLE only when the new link reports a live leader for the slot: then the resend can go at once, and copy numbers keep it safe (E-20) (PA-20) |
| 3 | C → S1 or S3 | reconnects (3.2 step 4) and resubscribes with its cursor | 3-4 RTT + catch-up | NEEDED |
| 4 | C | if the catch-up holds C's own committed record, its attempt id settles the write; no resend | none | CONDITIONAL and cheap (PA-27; v4: kernel/write.ts:54-57) |
| 5 | C → leader | else resend the same attempt with copy number + 1; a relay forwards it once | 3.1 steps 6-16 | NEEDED (E-20) |
| 6 | leader | dedup: the outcome is among the session's outcomes, so answer with the original position; nothing appended | a map read | NEEDED (F-02) |
| 7 | leader | the answer waits until the log end it was judged on commits (A-04) | up to one commit | CONDITIONAL: a committed outcome cannot change, so the wait guards nothing here; lifting it is a rule change on a rare path. Not advised |
| 8 | C | writes pipelined behind the lost one are refused `gap` and resent in order (O.seq) | 1 RTT each | NEEDED (A-10; E-48 `ORDER` broke in 7 steps without it) |

- **Lower bound:** one round trip and a table read, no disk; or nothing when the resubscription shows the record. **Gap:** the 200 ms floor when the new link already reports a live leader (PA-20), and step 7's wait. A storm test as E-39's must show that resending at once on such a link never feeds an election's storm.
- **Others** (from memory): Kafka's idempotent producer resends in-flight batches with the same producer id and sequence after 100 ms; the broker keeps the last five sequences per producer and partition.

### 3.11 Waits on the write paths that could run side by side

| Wait | Where | Could run beside | Verdict | Finding |
|---|---|---|---|---|
| the leader's fsync before it sends | S2 worker | the followers' write and fsync | already beside them in the design's text (DESIGN-V5 4.2): a build trap, which an in-place flush in the same run as the corked sends would bring back (2.4) | PA-2 |
| a batch window on a timer | journal | the previous fsync (the batch forms while it runs) | AVOIDABLE: cut when the disk is free (E-02's journal) or at the end of a turn | PA-2, PA-26 |
| a follower's `write()` after the previous fsync ends | follower journal | that fsync (write on arrival) | AVOIDABLE; NEEDED for `replicated` | PA-2 |
| the fold before the answer | S2 main | the answer from the worker | AVOIDABLE | PA-3 |
| the session commit before the first write | `#sessions` | discovery and the follow | AVOIDABLE on the write's path | PA-21 |
| one big record in a shared journal | journal | | 1.18-1.26 × others' p99 (E-35) | accepted (SC-15); PA-6 |
| one big frame on a shared member link | link | small frames between its pieces | reasoned | PA-6 |
| a long crc or decode on main | main | other groups' judging and folds | AVOIDABLE in most part | PA-1a |
| a GC pause on main | main | | at most 45 ms under steady writes, 0.77-0.98 s while loading 5e6 rows (E-07) | the leader's judging waits; PA-3 keeps answers of judged writes flowing |
| a `retry` during a slot move or a planned handover | client | | the 200 ms floor, at every roll step (5.14) | PA-20 |

**Steps that cost on every copy, and work nobody reads** (write side): validation at the relay (PA-12); the leader's second decode (PA-12, only with its guard); the `ANSWER` through the relay when the relay and the client fold the group (PA-27); early follower reports when no write asked (PA-28); the client's deep copy (PA-13); v4's diagnostics ring, one event object per write, kept armed (code: kernel/node.ts:1202, kernel/journal.ts:143-147), which the recorder replaces (keep any such event per batch). Two more are knobs, not waste: learners fold every write too (with `standbys` 5 and `copies` 3, five server folds per write in a five-server project; API.md 4 "Roles"), and every server folds `#sessions` (PA-9).

### 3.12 A RESP `SET` and `INCR` through the gateway, at pipeline 1 and 16

PERF-02's row is driven by redis-benchmark through E-45's RESP gateway: an L5 library in an app process G that holds a fero client of resource `kv`. `SET` becomes `set(k, v)`; `INCR` becomes `set(k, op.incr(1))` and answers with the new value. Replies leave in request order, and, as E-45 built it, "a command waits for the previous one on the same key from the same connection" (E-45: a workaround for its F4, writes in flight to one partition committing out of order across a leader change). The run: 200 connections, 100 B values, `-P 1` or `-P 16`. Without `-r`, redis-benchmark sends every `SET` to one key and every `INCR` to one counter (from memory).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | G main | read the socket; parse the RESP array (`*3`, `$3 SET`, the key, the value) | a few allocations per command; not measured | NEEDED |
| 2 | G main | the per-key chain: wait while the previous command on the same key from this connection is in flight | at `-P 1` nothing waits; at `-P 16` on one key, 16 commits in a row per connection: about 15.5 ms per pipeline at MEMORY 9.3's committed p50 of 0.97 ms, against about 1 ms for one shared commit (computed) | For a write behind a write, AVOIDABLE once E-48's O.seq is built: the library then keeps issue order per (process, partition) for writes in flight, and refuses a gap (PA-40). For a read, NEEDED: Redis runs a connection's commands in order, so a `GET` pipelined behind a `SET` must see it, and E-45's `GET` reads the row held at G, where a write shows only at commit (V4-7); rule Y covers only early-answered writes. So a `GET`, or any command whose reply reads the row, still waits for the in-flight writes to its key on that connection |
| 3 | G main | `set(k, v)` or `set(k, op.incr(1))`: the issue, then 3.1 steps 1-8; a canonical integer string kept as a number (E-45) | 3.1's issue | NEEDED |
| 4 | G → leader | 3.1 steps 8-34 (route-forward or direct, PA-4) | 3.1 | NEEDED |
| 5 | leader L2 | `SET`: a plain set, its bytes copied (PA-5). `INCR`: judged on the log end's overlay, so 16 increments to one counter in one batch each see the one before, with no lock held across a commit (3.5) | `INCR` encodes its value once (3.5 step 3) | NEEDED |
| 6 | leader → G | `SET`: the answer at the stage asked (`persisted` is the matched row for Redis's `appendfsync always`; E-45 F7). `INCR`: at commit only, with its value; a result that carries a value never goes out early (E-48) | an `ANSWER` per command, or per run of attempts | NEEDED. `INCR` keeps its `ANSWER` even when G follows `kv`: a client that does not fold the counter's partition learns the value only from it (PA-27 keeps `ANSWER`s for values) |
| 7 | G main | reply `+OK` or `:n`, in request order, one write per connection per turn | the cork (2.4) | NEEDED |

- **At `-P 1`** each command is one write of 3.1, plus a parse and a reply; with 200 connections in flight, batches fill as in 2.9's busy case. **At `-P 16`** the 16 `SET`s (or `INCR`s) of a connection arrive in one read, leave in one frame, and can share one batch and one commit, if step 2 does not chain them; redis-benchmark runs its `GET` test apart (from memory; E-45 reports each test's rate apart), so no read waits there.
- **Lower bound:** per command, a parse, one record and a reply; per pipeline of 16 writes, one frame, one batch and one commit; a read waits for the writes before it on its key (reasoned). **Gap:** the chain between writes at `-P 16` on one key (PA-40). E-45's runs went through E-22's simulated prototype, so their rates (`SET` 3,490 a second at `-P 1`, 5,602 at `-P 16`) are not fero's speed; the small gain from 1 to 16 fits the chain (reasoned).
- **Others** (from memory): Redis runs a pipeline's commands one after another on its one thread and, with `appendfsync always`, fsyncs once per event-loop pass, so 16 pipelined `SET`s share one fsync.

## 4. The read and flow paths

The write itself is section 3's. These paths start where a read or a subscription starts. Rows are E-05's small rows (about 100 B as JSON, 123-125 B as one v4 record); a field record is 15-17 B.

### 4.1 A local read from a copy's fold

`f.data.x`, `f.snapshot.x` or `get('x')` of a held row, on a process that folds its partition (a server, or a client that follows it). Rows handed out are immutable, so a read by reference is safe (API.md 4 "Reads"; DATA-07).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | reader main L4 | `f.data.x`: fero's lens trap makes a child `data` handle and a new `Proxy` for each path step (code: api/substrate.ts:309-405) | 2 allocations a step: 0.54-0.59 µs at 1e3 rows, 3.0-3.1 µs at 1e5, 4.2-5.2 µs at 1e6, against 0.18-3.9 µs for `data`'s handle alone and 43 ns-1.2 µs for a `Map` (measured here: reads/local-read) | AVOIDABLE past the first: a plain read needs no write-capable child (PA-31) |
| 2 | main, `data` | the value read: `childRead` → `readAt` → `src.get(key)`, then a walk to the field (code: data:api/index.ts:93-102) | one hash lookup; cache misses at size: the floor is about 1 µs at 1e6 rows | NEEDED |
| 3 | main L4 | `f.snapshot.x`: the getter → `readAt` at the root → `store.snapshot()` builds a **new `Map` of every row**, then `materialize` a **new object of every row**, then `.x` (code: api/index.ts:1294-1296, api/substrate.ts:97, data:api/index.ts:93-98, data:kernel/store.ts:283-295, data:compat/v2-records.ts:138-143) | 2 × O(rows) per read: 87-89 µs at 1e3 rows, 30-33 ms at 1e5, 0.47-0.53 s at 1e6 (measured here; E-06 saw about 0.5 s for the same picture) | AVOIDABLE (PA-8) |
| 4 | main, `data` | hand-out freeze, once per row object, cached in a `WeakSet` (code: data:api/index.ts:152-161) | one walk of a row the first time it is handed out | CONDITIONAL: DATA-07's immutability, paid once; already the cheap form |
| 5 | main L4 | a sync read of a partition this process does not hold throws `shortfall`; an operator over a partial picture throws `holistic` (API.md 4 "Reads") | a set lookup | NEEDED (no stale or guessed answer); must stay a lookup, not a scan |

- **Lower bound:** one hash lookup into the rows, no allocation, no copy: 43-51 ns at 1e3 rows and 0.9-1.2 µs at 1e6, where cache misses dominate (measured here).
- **Gap:** `f.snapshot.x` is 1,700-2,000 times the floor at 1e3 rows and about 450,000-510,000 times at 1e6. v4 made `f.snapshot` the whole picture: "A fresh top container per access; rows shared by reference (stringify-and-discard is the intended use" (code: api/index.ts:1289-1291). API.md's v5 text uses it as a one-row read: P-01 calls `client.snapshot.widgets` "a sync read of a held row: a property read" with a bar under 100 ns (docs: API.md P-01; DESIGN-V5 8). One of the two must change (PA-8). It also makes two containers of every row per read: at 1e6 rows the kind of growth E-07 found makes long collector pauses (reasoned). `f.data.x` is 4-14 times the floor, all of it allocation per step (PA-31).
- **Others:** a Redis `GET` is a network round trip (E-09a: 144,000 a second at pipeline 1); fero's in-process read is where it can win outright (DESIGN-V5 8). Near caches that copy per read are the known slow form (from memory).

### 4.2 Read your writes (E-48's rule Y)

C writes `x`, then reads `x`. Only what makes the write visible to C's own reads.

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | S2 worker L1 | g2 commits the batch | (3.1) | (3.1) |
| 2 | S2 → S1 | the `ANSWER` and the commit offset ride one message to S1 (LAYERS 8.2) | 1 net; about 30 B | NEEDED: S1 must learn the commit to fold it |
| 3 | S1 worker → main | the committed batch crosses for the fold | 1 crossing; 27-40 ns a record (E-07) | NEEDED while `data` folds on main (RR-17) |
| 4 | S1 main L2 | `data` folds the batch through its lane | decode 3.2 + fold 0.2-1.9 µs a small row | NEEDED on S1 (fold-all) |
| 5 | S1 main L3 | S1 sends the delta, then the `ANSWER` (LAYERS 8.2: "the committed batch, then the ANSWER") | waits for S1's main event loop: p99 1.5-14 ms under steady writes (E-07) | the send NEEDED; the wait for S1's main loop AVOIDABLE (PA-3) |
| 6 | C main | C decodes and folds the delta; the `ANSWER` resolves the write once C's own view shows it (API.md 4 "Answers"; v4 the same: code: kernel/write.ts:880) | a decode and a fold | NEEDED (rule Y) |
| 7 | C main | a later read of `x` reads C's own fold (4.1) | a lookup | NEEDED |
| 8 | C, S1 | if C does not follow the partition (`cache.memory`), its read carries the highest version C has seen or written there, and S1 answers once its fold reaches it (API.md 4 "Reads") | 1 RTT plus S1's fold wait; about 6 B a read | CONDITIONAL: reads of what C does not hold |
| 9 | C | after an early answer (V5-5's second step), a read waits for C's early-answered writes to commit (Y) | up to one commit | CONDITIONAL |

- **Lower bound:** the commit, one net from the commit to C's copy (the answer and the delta share it), and C's own decode and fold of the record (reasoned). **Gap:** only step 5, S1's main thread: the delta and the answer both wait for S1's fold and event loop. Sent from the bytes at commit (PA-3), they leave S1 together from the worker.
- **Others** (from memory): Kafka gives no read-your-writes between a producer and a consumer; Redis gives it on one connection to the primary; etcd's default reads are linearizable (E-09e).

### 4.3 A linearizable read (ReadIndex, or a lease)

`get('x', { fresh: true })`: the writer confirms it still leads, then answers once its fold reaches the commit (API.md 4; DESIGN-V5 4.5).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | C main | build the read: key, `fresh`, C's floor for the partition | a small encode, about 30 B | NEEDED |
| 2 | C → S1 → S2 | to g2's leader; S1 forwards it if C has no link to S2 | 2 nets, or 1 direct | 1 net NEEDED; the forward CONDITIONAL (PA-4) |
| 3 | S2 worker L1 | ReadIndex: note the commit index; confirm leadership with a majority by a heartbeat with a read context (E-46: linearizable in every Maelstrom run) | 1 RTT to a majority, no fsync | NEEDED without a lease. Many reads in one tick should share one round, which can ride the next `APPEND` (PA-30) |
| 4 | S2 | a new leader answers reads only after its first own-term entry commits (Raft's read rule; from memory) | a wait, once per term | NEEDED |
| 5 | S2 worker → main | wait until S2's fold reaches the read index, then read on main | a crossing and S2's main-loop wait | the fold wait NEEDED; the main-loop wait CONDITIONAL on where the read runs |
| 6 | S2 main | read the row and encode it | about 2 µs a small row | NEEDED if answered from S2 |
| 7 | S2 → S1 → C | the answer; C decodes, folds, and from now on follows the partition | 2 nets (1 direct); decode 2.7-3.2 µs | NEEDED |

- **Lower bound:** one RTT from C to a copy of g2, plus one RTT from the leader to a majority, no fsync (reasoned; Raft's ReadIndex). A leader lease would drop the majority round at the price of trusting bounded clock drift (from memory: etcd, CockroachDB).
- **Gap and fixes:** the forward when C has no link to S2 (PA-4). A **follower read**: S1 asks S2 only for the read index (S1's own ack counts toward S2's majority), waits for its own fold, and answers from its own rows; no row bytes cross between servers and S2's main thread does nothing (from memory: TiKV). **Batch ReadIndex per tick** (from memory: etcd's read loop). Both build only (PA-30). A lease read is **not** proposed: E-21 chose writer time as the members' median so no one clock is trusted, and found that a guard on the leader's own clock turned every clock jump into a failover.
- **Others:** etcd's linearizable read had p50 0.43 ms at one client against 0.18 ms serializable (E-09e). Kafka offers none (from memory).

### 4.4 A read of a row this process does not hold

v4's scoped read is a gather (code: api/fold.ts); v5 replaces it with a one-hop `SUB`. Both are walked, because the gather is what v4's code would port if nothing changed.

v4's gather:

| # | Where | Step | Work | Verdict in v5 |
|---|---|---|---|---|
| 1 | coordinator | asks **every member** for its rows (a system `rows` call) | N RTTs in parallel | AVOIDABLE: v5 knows which group holds each slot |
| 2 | each member | walks **every version it holds**, even for a one-row read (code: api/fold.ts:85-87) | O(cells held) per answer | AVOIDABLE |
| 3 | each member | `JSON.parse` of each cell's key to find its partition (code: api/fold.ts:76-79) | a parse per cell | AVOIDABLE |
| 4 | each member | builds `{ v, st }` claims and sends them (code: api/fold.ts:8-10, 88-93) | an encode of every claimed cell | AVOIDABLE |
| 5 | coordinator | merges per cell by (epoch, seq, origin), parks, sweeps coverage | O(cells) | AVOIDABLE: v5 has one writer per slot, "no LWW comparison anywhere" (DESIGN-V5 4.3) |
| 6 | coordinator | the live variant gathers all of it again on a timer (code: api/fold.ts:447) | O(members × cells) per tick | AVOIDABLE: v5 subscribes |

v5:

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | C main | `get('u42')` on a row not held: one state-mode `SUB` of that partition, with C's floor; the miss **is** the subscribe (P-03) | a small encode; a cursor of 22-25 B (E-19) | NEEDED. A `GET` then a `SUB` would cost 2 RTTs and leave a window where a write falls between them (reasoned) |
| 2 | C → S1 | to S1 | 1 net | NEEDED |
| 3 | S1 main L3 | is g2's slot held open here, the fold ready and past C's floor (E-31's rules) | a slot-table lookup | NEEDED |
| 4 | S1 main | `rules.read(peer, partition)`, once for this subscription | user code, once | CONDITIONAL: only with `rules.read` or a token; once per (subscription, partition), never per record (PA-34) |
| 5 | S1 main | read the row, encode one frame, register C as a subscriber of the partition | about 2 µs a small row | NEEDED |
| 6 | S1 → C | `SNAP` (begin, the row, end), then deltas | 1 net | NEEDED |
| 7 | C main | checksum, decode, fold through the lane | 0.30-0.35 + 2.7-3.2 + 0.2-1.9 µs a small row | the decode and fold NEEDED; the checksum CONDITIONAL (PA-32) |
| 8 | if S1 does not hold g2 | S1 answers `moved`, naming a ready copy; C dials it if it has no link (or S1 subscribes upstream and relays, DESIGN-V5 4.4) | +1 RTT, or a new link | CONDITIONAL. A client with the slot table and the members (V5-3) can send the `SUB` to a copy it is linked to (PA-4) |

- **Lower bound:** one RTT to a ready copy, one encode and one decode of the row (reasoned). **Gap:** none when every server holds every group (the base topology); with more servers than `standbys`, a `moved` round trip.
- **v4 against v5:** v4's gather costs O(members × cells) per read and per live tick; v5's O(rows of the partition). This is already in the design (E-31, DESIGN-V5 4.4), and it is the largest read gain of v5 over v4 (reasoned from the code).
- **Others** (from memory): Redis Cluster answers a wrong-node read with `MOVED` and the client caches the slot map; a Kafka client reads from the leader, or a follower with KIP-392.

### 4.5 Subscribe: a snapshot, then changes

`f.follow(['room1'])`, or a client that follows the whole resource. State mode: a snapshot of the selected partitions, then each committed change (DESIGN-V5 4.4).

Opening:

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | C main | encode `SUB` (selector, mode, cursor `latest` or saved) | 22-79 B for 1-10 partitions; 1.0-3.3 KB for a whole resource at 1,024 slots, about 4-13 KB at 4,096 (E-19) | NEEDED |
| 2 | C → S1 | network | 1 net | NEEDED |
| 3 | S1 main L3 | checks: cluster id, incarnation, per-slot epoch, slot held open, fold ready and past the cursor (E-31) | a few lookups; a whole-resource cursor decodes in 13 µs (E-19) | NEEDED (E-31's properties) |
| 4 | S1 main | `rules.read` and token claims, per partition | user code once per partition | CONDITIONAL (PA-34) |
| 5 | S1 main, `data` | find the selected partitions' rows: one lookup for a one-row partition; a **prefix** partition (a room) needs its rows, and with no index every row is scanned | 2.8-3.2 ms at 1e5 rows and 25.8-28.3 ms at 1e6 for a 100-row room; 0.47-0.74 ms with an in-memory partition → rows index (measured here: reads/snapshot-serve) | the read NEEDED; the scan of every row AVOIDABLE (PA-17). The index is not free: it lives on every full copy (fold-all), costs memory per row and an update per fold, and must not be `data`'s `group` view until DATA-05 is fixed (a `group` view costs 146-182 B a row and 2,574 µs a record at 1e6 rows, E-05) |
| 6 | S1 main | encode the rows as frames between begin and end markers | about 2.1-2.7 µs a row: 0.21-0.27 ms for 100 rows (measured here) | NEEDED once per (selection, position); per subscriber AVOIDABLE when many start at one position: 4.7-7.4 µs each when 100 share it (PA-17) |
| 7 | S1 main | register the subscriber in the per-slot and per-partition index, at position P | a few inserts | NEEDED |
| 8 | S1 → C | the snapshot frames | 1 net; a socket write per frame batch, 8-14 µs on this VM (E-08) | NEEDED |
| 9 | C main | the framer: a whole frame inside one TCP chunk is a view; a split frame is copied once (code: kernel/codec.ts:1043-1100) | ≤ 1 payload copy | NEEDED (framing); the split copy CONDITIONAL |
| 10 | C main | checksum the frame | v4's JavaScript crc32c: 0.30-0.35 µs a small row, about 2.6-2.9 ms a MiB | CONDITIONAL (PA-32) |
| 11 | C main | scan, decode, then one lane call per frame; the snapshot lands as one apply between its markers | decode 3.2 + fold 0.2-1.9 µs a row | NEEDED. One lane call per record instead costs 0.62-2.63 µs a record, and 11.4 µs against 0.98 µs with one `group` view at 1e3 rows (E-05) |

Each later change:

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | S1 worker | a committed batch of g2 (from S2's `APPEND` and commit offset) | (5.1) | |
| 2 | S1 worker → main | the batch crosses for the fold | 27-40 ns a record (E-07) | NEEDED for the fold; for the delta AVOIDABLE for resource, partition and prefix selectors, which bytes can route (PA-3 b). A `view` selector and a method's live view send view outputs, which only main's fold makes (DESIGN-V5 4.4): those keep one encode per view change, shared by its subscribers |
| 3 | S1 main L3 | for each record: who follows its partition? | v4's way: decode the record first (2.4-3.0 µs a small row) or its key (0.48-0.64 µs); with the slot in the header and a per-slot bitmap, 1-4 ns when no one follows the slot (measured here: reads/route) | the lookup NEEDED; the decode before it AVOIDABLE (PA-12) |
| 4 | S1 main L3 | build each subscriber's frame: the whole batch, or the chosen records | v4 re-encodes per link: 2.1-2.4 µs a small row (code: kernel/write.ts:877, kernel/link.ts:166-171). Sharing the batch: 0. Copying chosen records with one checksum: 0.11 µs a row (native crc) or 0.40-0.44 µs (v4's JavaScript one) at 256 chosen; about 1 µs when one is chosen (measured here: reads/route) | sharing or copying NEEDED; re-encoding AVOIDABLE (PA-5). Encode once is already the design's text for deltas (DESIGN-V5 4.4 and 8: "encode once, `writev`"): a build trap. A shared room frame serves only subscribers whose cursor sits at its start; one that joined at a snapshot position inside the frame needs its own cut |
| 5 | S1 main | credit check, cursor advance, one write per link per tick | 8-14 µs per socket write (E-08) | NEEDED, one per tick, not per record |
| 6 | C main | checksum, decode, one lane call per frame | as opening step 11 | NEEDED (decode, fold) |
| 7 | S1 main | a slow `state` subscriber is conflated: one diff per row from its cursor to the fold | reads `data`'s rows | CONDITIONAL: only for a reader that fell behind its credit |

**What v4's method plane does instead.** A method that returns a live view streams it with `records(..., { clone: false })`; each change becomes **one `SUBREC` control frame per subscriber**, with its own 11-byte header, checksum and `link.ship` (code: api/methods.ts:349-358, kernel/node.ts:856-859); the client folds one record per `ingest` call (code: api/substrate.ts:228-262). Per small-row change: 4.4-4.6 µs to serve per subscriber against 2.0-2.4 µs for a batch encode shared by one subscriber and 20-24 ns shared by 100; 4.4-5.5 µs to apply against 2.7-3.1 µs in a batch. Per field change: 2.0-2.6 against 0.23-0.28 µs to serve, 1.9-2.4 against 0.53-0.63 µs to apply, 80 against 15 wire bytes (measured here: reads/substream). v5 should send a method's live view through the same flow as `follow` (PA-5, PA-11).

- **Lower bound.** Per delta at the server: no encode (the committed bytes are the delta, for selectors bytes can route), a slot test, a copy only for a partial selection or a mid-frame join, one socket write per link per tick. Routing by partition on bytes needs each record's partition without user code: the slot in the header is not the partition, and a function partition runs user code, which must not run on the kernel thread, so the record needs a partition hash in its header (bytes against E-19's 4 B bar) or a key decode (PA-3 b). Per snapshot: one read and one encode per (selection, position), shared. Per record at the client: one decode and one fold in batches; a checksum only where the link does not protect the bytes (reasoned).
- **Gap, built as v4 builds it:** per small-row delta, 2.1-2.4 µs of re-encode per subscriber plus 0.5-3.0 µs of decode per serving copy just to route, against about 0.01-0.46 µs. With 1,000 subscribers of a room, about 2.1-2.4 ms of server CPU per record against about 0.45 µs (computed); the socket writes per tick are the same. A room's snapshot at 1e6 rows: 26-28 ms against 0.70-0.74 ms, and 7.0-7.4 µs each if 100 share it (PA-5, PA-12, PA-17).
- **Others** (from memory): Kafka's broker never decodes on a fetch: it sends stored batch bytes by `sendfile` and the consumer checks one CRC per batch. NATS does one subject match per message, copies the message into each subscriber's buffer and flushes each client with one `writev` (E-08 measured 5.8 million deliveries a second per server core at 100 B). etcd groups watchers on a range, but each watch stream encodes its own events.

### 4.6 Resume from a cursor, and failover

C's link drops, or S1 dies. C resubscribes with its cursor (DESIGN-V5 4.4; E-31).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | C | a new link: TCP, TLS, the door (once per link; code: kernel/door.ts) | 2-3 RTT and a handshake | NEEDED once per link. E-39: 10,000 resubscribed in 1.5 s over TCP and 5.6-7.1 s over TLS |
| 2 | C → S | `SUB` with the cursor, and its waiting writes' positions as a minimum (DESIGN-V5 4.4 "Failover") | 1 net; 22-79 B for 1-10 partitions, up to 3.3 KB delta-coded for a whole resource (E-19) | NEEDED |
| 3 | S main | check the cursor (4.5 step 3); if S's fold is behind the minimum, wait | up to one commit round | NEEDED: no resolved write is ever invisible |
| 4 | S | find each slot's position: per-slot sequence → offset, from the in-memory tail, a segment's slot index, or the object store | a lookup; on disk a `pread`; from the store a ranged GET (MinIO 1.37 ms p50, S3 about 30 ms; E-28) | NEEDED |
| 5 | S | read the records after the cursor; keep the subscriber's partitions | v4's format: a scan of every record to find its edge, 0.26-0.34 µs a small row; with lengths and slots in the record header, a few ns a record (PA-12) | the read NEEDED; reading other slots' records CONDITIONAL (a slot's records are spread through its group's segments) |
| 6 | S → C | the records; in state mode a snapshot when S lacks them (it replaces) | as 4.5 | NEEDED |
| 7 | S | `END` if S lacks the next record; `expired` only from the slot's leader (A-06) | none | NEEDED (E-31: without it a routine reload ends a log reader for good) |

- **v4 for comparison:** a reconnecting client wipes its fold and asks with an empty digest; "its suffix ship IS the re-download" (code: kernel/node.ts:1431-1454): O(resource) per reconnect. v5's cursor makes it O(records since the cursor): the right bound, already in the design.
- **Lower bound:** read only the chosen partitions' bytes after the cursor, no decode on the server, plus the link's setup (reasoned). **Gap:** read amplification when one partition resumes far back: its records are spread through its group's log. A per-slot index per segment block keeps that to the slot's share; LAYERS 1.2's index **by partition** costs a key decode per record at segment write and serves only far resumes of one partition (PA-12).
- **Others** (from memory): Kafka keeps one partition in one log, so a resume is a sparse index lookup and a sequential read; fero gives up that contiguity by putting many partitions in a group, and the slot index buys most of it back.

### 4.7 Fan-out to many subscribers, and through relays

One room with many subscribers, at a server that folds it or at a relay (P-05; E-08; A-11). Per committed batch:

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | relay, from upstream | one frame per tick from the relay's own subscription | 1 net per tick | NEEDED |
| 2 | relay | checksum the frame | 0.30-0.35 µs a small row in JavaScript | CONDITIONAL (PA-32): the relay may forward the same bytes |
| 3 | relay | decode and fold, to serve snapshots to newcomers and conflate slow readers (a relay answers only after its upstream snapshot landed, DESIGN-V5 4.4) | 2.7-3.2 + 0.2-1.9 µs a small row | CONDITIONAL: a relay that serves `state` snapshots; a pure log relay need not fold |
| 4 | relay | route each record to rooms | slot test 1-4 ns; key decode only on a hit | NEEDED (PA-12) |
| 5 | relay | coalesce each room for a few ms; cut one frame per room per tick | copy + checksum 0.11-0.46 µs a record, once per room | NEEDED (A-11) |
| 6 | relay, per subscriber | credit, cursor, one `write` per socket per tick, the same room frame for every subscriber | 8-14 µs a write on this VM (E-08) | NEEDED, per subscriber per tick |
| 7 | relay, per WebSocket subscriber | a 2-4 byte WebSocket header, once per room per tick | WebSocket delivers 0.89-0.95 of TCP's per core (E-40) | NEEDED for browsers |
| 8 | TLS terminator, per subscriber | encrypt per link | E-27: 1,000 subscribers at 10 messages a second cost 8.8 % of a core on TCP, 17 % on TLS | NEEDED (per link; cannot be shared) |
| 9 | each subscriber | checksum, decode, fold | as 4.5 | NEEDED (decode, fold) |

- **v4 for comparison:** the feeder decodes every inbound record, copies it out (code: kernel/write.ts:842), then appends it to each client link's own encoder (code: kernel/write.ts:875-877 → kernel/link.ts:166-171): an encode per subscriber, 2.1-2.4 µs a small row. DESIGN-V5 8 measured v4's relay at about 9,000 deliveries a second, about 110 µs per relayed record. E-08's Node relay, which encodes once per room per tick, pushed 0.57-1.50 million a second per core with no added wait, and 20.6-32.3 million with 10 ms rounds.
- **Lower bound per record:** one route lookup and, for a partial selection, one copy into the room's frame; per subscriber per tick one write; no encode and no decode at a pure relay (reasoned; E-08 has this shape). **Gap:** as v4 builds it, 2.1-2.4 µs of encode per record per subscriber plus the decode to route: the encode alone is 1.4-3.6 times E-08's whole cost per delivery (PA-5, PA-12). Through a chain of relays, each level that serves snapshots also decodes and folds; a level that only feeds other relays need not.
- **Head of line:** a room's records stay in order on a link (NEEDED). A big record of one room holds back other rooms' frames on the same link (PA-6).
- **Others** (from memory): NATS copies each message into each subscriber's buffer; Redis pub/sub appends one shared reply object to each subscriber's output buffer; Kafka has no push fan-out.

### 4.8 A browser or edge client over WebSocket

Browser B follows a room and writes to it (P-05, P-19; E-40).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | B | import the client bundle (`data` + the codec + the wire) | 4-22 ms; 27.9 KB gzip (E-40) | NEEDED once per page load |
| 2 | B → edge | TCP, TLS 1.3, the HTTP upgrade; the 101 carries the door's challenge (E-40) | 3 RTT | NEEDED once per link |
| 3 | B → edge | the door's proof, the `SUB` and a first write in one flight | an HMAC (`crypto.subtle`), 1 net | NEEDED: E-40 measured 13-17 ms in Chromium from connect to the first committed write, mostly CPU |
| 4 | TLS terminator | decrypt and re-encrypt per link (A-11b) | per byte | NEEDED |
| 5 | edge relay (Node) | as 4.7; one WebSocket message per room per tick | as 4.7 | NEEDED |
| 6 | B main | a `message` event carries whole messages, so no TCP re-framing; one fero frame per message keeps the framer copy-free | none | NEEDED |
| 7 | B main | checksum each frame in JavaScript (browsers have no native CRC) | 0.30-0.35 µs a small row with v4's table, about half with slice-by-8 | AVOIDABLE on a TLS link whose server checked the bytes on read (PA-32) |
| 8 | B main | decode and fold, one lane call per frame | 2.7-3.2 + 0.2-1.9 µs a small row | NEEDED |
| 9 | B main | render | user code | out of scope |

- **Lower bound:** one TLS handshake plus two round trips to the first committed write (E-40's design; P-19's bar), then one decode and one fold per record (reasoned). **Gap:** the JavaScript checksum (PA-32) and the decode format (PA-1b).
- Folding in a Web Worker would move decode and fold off the page's thread, but the page then needs the rows across a `postMessage`: 0.9-6.2 µs a record by structured clone (E-07). For a room of a few hundred rows the page's thread is the cheaper place (reasoned).
- **Others** (from memory): Socket.IO, Phoenix and Ably encode each message once and write it to each socket, as 4.7 does.

### 4.9 A derived resource: reading sources, writing outputs with source marks

`derive(orders, totals, fn)`: the process that owns `totals` is a client of `orders` and records in its own log how far it has read (V5-2 point 4; P-17; E-30). Per source record:

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | D (the owner of `totals`, read here as the leader of its groups) | a log-mode `SUB` to `orders` from the marks in its own log | once per start; a cursor per source slot | NEEDED (V5-2: a restart resumes exactly) |
| 2 | a copy of `orders` → D | committed batches of `orders` | 1 net, unless D's process holds a copy of `orders` | CONDITIONAL: with `standbys` 5 and few servers, D's process often folds `orders` itself, so the records are already decoded in-process (PA-19) |
| 3 | D | decode each record for `fn` | 2.7-3.2 µs a small row | NEEDED, unless step 2 hands over decoded records |
| 4 | D | `e.row` (the row after the record) needs D to fold `orders`' partitions | memory O(rows read); a fold per record | CONDITIONAL: only if `fn` reads `e.row` |
| 5 | D | run `fn`; its outputs to one output slot go in one entry with the source mark (G-13; A-05) | user code | NEEDED |
| 6 | D L2 | judge each output at `totals`' writer, which is D: apply only above the mark (E-30's 5 rules); ops such as `incr` | local; 29 B a mark (E-30) | NEEDED (exactly once past the dedup horizon) |
| 7 | D L1 | commit at `totals`' majority | (3.1) | NEEDED |
| 8 | D | the next source record | must not wait for step 7: the one writer keeps the order per (source slot, output slot); E-30's rule orders only the cursor after the outputs' answers | waiting per record AVOIDABLE (PA-19) |

- **Lower bound:** per source record, one delivery (in-process when D folds the source), one run of `fn`, and the outputs' share of one batched commit (reasoned). **Gap:** built as a loop that awaits each output, throughput is one source record per commit latency, about 250 a second at 4 ms (reasoned from E-02's p99); reading the source over the network when D's own process folds it wastes a hop and a decode per record.
- A batch of source records in one output entry would cut entries further, but needs each output's own source position inside the entry: a format change with model debt (E-30 has one entry per source record). Not proposed.
- **Others** (from memory): Kafka Streams commits consumer offsets in the same transaction as the outputs.

### 4.10 The timeline viewer: resources merged by writer time (V5-4)

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | viewer | a log-mode `SUB` per resource (or one relay for them all), from time T | one per resource | NEEDED |
| 2 | each copy | find the first batch at or after T: `t` never goes back within a group (A-23), so a binary search over segments by their first batch's `t` finds it | O(log segments) reads | NEEDED; a separate time index AVOIDABLE |
| 3 | copy → viewer | the batches' bytes | every batch in the window | NEEDED for a full timeline; a filtered one reads only the chosen slots |
| 4 | viewer | a heap keyed by (`t`, resource name, group, position); each pop reads the next **batch header** only | O(log G) a batch | NEEDED; decoding records CONDITIONAL (only those shown) |
| 5 | viewer | place a derived record after the source record whose position it carries | needs the mark at the entry level, not inside the value | NEEDED (V5-4) |

- **Lower bound:** read each shown batch once; decode only headers to order and only shown records to display (reasoned). The design meets it if the format keeps `t` in the batch header (it does: DESIGN-V5 4.3) and the derived mark outside the value.
- **A wording gap** (reasoned): V5-4 says that "within a resource it uses the log's exact order". Under V5-2 a resource has several groups, and there is one exact order per group only. Across one resource's groups the viewer merges by `t` too, ties by group and position (PA-35).
- **Others** (from memory): Kafka keeps a time index per segment because its record timestamps may go back; fero's writer time never goes back within a group, so offsets and a binary search are enough.

### 4.11 Best-effort pub/sub on the `none` rung

`fero('news', { rows: false, durability: 'none' })`: no disk, no log, "every current subscriber gets every message, in order per subject" (API.md P-06; SIMPLICITY 3.1 `none-rung`). Its failover rule is unwritten (K-10).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | publisher P | `news.set('sports', v)`: encode | an encode | NEEDED |
| 2 | P → S1 | to P's server | 1 net | NEEDED |
| 3 | S1 → S2 | to the subject's slot leader, which orders the subject (route-forward) | 1 net | CONDITIONAL: order per subject across publishers needs one sequencer; the forward is AVOIDABLE when P sends to S2 (PA-4) |
| 4 | S2 | stamp the subject's next sequence in memory (readers count restarts as `gaps`) | a counter | NEEDED for order per subject |
| 5 | S2 | no journal, no fsync, no `APPEND`, no fold (`rows: false`) | none | correctly absent |
| 6 | S2 → servers with subscribers → clients | route per subject, one frame per room per tick (4.7) | 1-2 nets | NEEDED |

- **Lower bound:** publisher → one server → subscriber, 2 nets if order is per publisher; 3 if a per-subject sequencer is needed and it is not the publisher's server (reasoned). **Gap:** route-forward adds 1 net and a relay 1 more: 4 nets against 2-3 (PA-4).
- **Others:** NATS orders per publisher, not across publishers (from memory); E-09b measured core NATS publish-to-receive at p50 0.09 ms, p99 0.27 ms.

### 4.12 Presence rows

`online.set('ada', v, { while: 'session' })`: the row lives while its writer's session lives (P-13).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | writer | the session-bound write, sent only once the session's record has committed (A-04) | (3.1) | NEEDED |
| 2 | each reader | sees the row like any row (4.1, 4.5) | | NEEDED |
| 3 | every process | renews its session's lease in `#sessions` within `session.ms` (10 s); each renewal is a **persisted write** (API.md 4: the libraries keep `#sessions` on `persisted` resources) | one commit at `#sessions`' majority per renewal; tens of bytes | the liveness NEEDED; logging each renewal AVOIDABLE (PA-9) |
| 4 | every group writer | follows `#sessions` to learn lapses (MECHANISMS `presence-rows`; DESIGN-V5 5.3) | decodes every renewal record, at every following process | following the lapses NEEDED; decoding renewals AVOIDABLE (PA-9) |
| 5 | `#sessions` writer | a lapse by writer time, appended | 1 commit | NEEDED (every copy agrees which rows go) |
| 6 | each group writer | removes the lapsed session's rows by records in its own log | needs the session's rows: an in-memory index session → rows, else a scan of every row per lapse | the removes NEEDED; the scan AVOIDABLE with the index (build) |

- **Lower bound:** liveness as soft state in `#sessions`' leader's memory; only the lapse is a log fact, so every copy removes the same rows at the same position (reasoned).
- **Gap:** with N processes renewing every `session.ms` / 3, about N / 3.3 commits a second on `#sessions`, decoded by every following process. At 10,000 processes (a browser counts, if each process has one session) about 3,000 commits a second for liveness alone (reasoned arithmetic; the renewal period is the library's choice, taken here as a third of `session.ms`, as locks renew).
- **Others** (from memory): etcd keeps lease keep-alives in its leader's memory; only grants and revokes go through Raft, and a new leader extends every lease. API.md already records the question for named leases (Q-A28).

### 4.13 Queue claims and waiting takes

`jobs.work(fn)` and `mail.take(1, { wait: '20s' })` (P-09, P-22): a claim leases the first takeable rows at the queue partition's writer. Per message:

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | producer | `add`: a persisted write | (3.1) | NEEDED (no loss) |
| 2 | each waiting worker | follows the queue partition, so the add's delta wakes it (E-22 D6) | a delivery to **every** waiting worker | AVOIDABLE: only one can win (PA-18) |
| 3 | each woken worker | sends a `claim` to the writer | 1 RTT each (2 nets via a relay) | one claim NEEDED; N - 1 wasted |
| 4 | writer L2 | judge: the first n unclaimed, due rows | a scan past leased rows, unless the writer keeps an index of takeable rows by (priority, due) | the judging NEEDED; the scan AVOIDABLE with an in-memory index (build) |
| 5 | writer | the winner's lease appended and committed; the N - 1 others get `empty`, not appended but still waiting for the commit of the log end they were judged on (A-04) | 1 commit | NEEDED (at most one live lease) |
| 6 | worker | runs, then `ack`: remove under the claim's token | 1 commit | NEEDED |
| 7 | waiting workers | a lapsed lease writes no record, so a waiter learns of it only by polling once a second (E-22 D6) | a claim per waiter per second | AVOIDABLE (PA-18) |

- **Lower bound:** per message three commits (add, claim, ack), each sharing a group commit, and one handoff to one waiting worker (reasoned). **Gap:** N - 1 wasted claims per enqueue with N waiters, a wake RTT, and the 1 Hz polls. **Fix (PA-18):** a waiting take parks at the writer, in memory; when a row becomes takeable (an add, a `nack`, a lapse by writer time), the writer claims it for the oldest parked take in the same batch and answers after the commit. The claim must be appended under the waiter's own attempt id (its session and sequence), never one the writer makes: if the answer is lost at a leader change, the waiter's resent take then finds its outcome in dedup, where a writer-made id would let it claim a second row, a double delivery. A-10's "a take hands over what it has at once" already points this way.
- **Others** (from memory): SQS long polling parks a receive at the server; JetStream's pull requests wait at the server; Kafka share groups keep acquisition locks in the share-partition leader's memory.

### 4.14 Consumer groups

`group(orders, 'billing').run(...)` (P-08). Per batch:

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | member | joins: a `#groups` row with members, a generation, a token per share | 1 commit per join | NEEDED |
| 2 | member | `read({ share })`: a log-mode `SUB` of its share's slots from the share's committed cursor | | NEEDED |
| 3 | copy → member | the share's records; a share is a set of slots, so a copy holding the whole group cuts the share's records out of each batch | a slot test a record (PA-12); copy + checksum 0.11-0.46 µs a record | NEEDED; zero-copy when a share is whole groups |
| 4 | member | decode, user code | 2.7-3.2 µs a small row | NEEDED |
| 5 | member, `commit()` | the cursor written to `#groups` under the share's token (fenced) | 1 commit per batch, on another resource | NEEDED for at least once |
| 6 | member, `run()` | outputs carry the derived-once marks (4.9), so the cursor only says where to resume reading | 1 commit per batch | CONDITIONAL: under `run()` it can be written lazily, every few seconds (PA-33) |

- **Lower bound:** per batch one delivery and, for at least once, one cursor commit; for exactly once, the outputs' commit alone plus an occasional cursor commit (reasoned). **Gap:** a per-batch `#groups` commit under `run()` (PA-33).
- **Others** (from memory): Kafka commits offsets to `__consumer_offsets`, one write per commit; transactional consumers commit offsets with the outputs.

### 4.15 Across the read paths

- **Work every copy does that one copy needs.** Fold-all: every full copy decodes and folds every record, 2.7-3.2 + 0.2-1.9 µs a small row per copy; the design's rule (RR-17, V5-6), for reads from any copy, warm failover and the fold check (F-21). Routing for no one: a serving copy that routes by decoding each key pays 0.5-0.6 µs a small row even when no one follows the slot; with a slot test, 1-4 ns (PA-12). Renewals nobody but `#sessions` needs (PA-9). Freezing: `data` freezes a row once, when first handed out, never per fold: already right.
- **Encodes and decodes per small-row delta to one subscriber:**

| Step | v4 as built (code) | v5 lower bound (reasoned) |
|---|---|---|
| serving copy: decode to route | a full decode, 2.4-3.0 µs (code: kernel/write.ts:842) | none: a slot test, 1-4 ns |
| serving copy: fold | a decode and a fold (fold-all) | the same, once per copy (NEEDED) |
| serving copy: encode for the subscriber | one per subscriber, 2.1-2.4 µs (code: kernel/write.ts:877, kernel/link.ts:166-171) | none: the log's bytes; a copy of 0.11-0.46 µs only for a partial selection |
| subscriber: checksum | one per frame, 0.30-0.35 µs a row | one per frame, or none on a TLS link (PA-32) |
| subscriber: decode and fold | one each | one each (NEEDED) |

- **Per record against per batch:** v4 hands each committed record to `data` alone (code: kernel/node.ts:2895 → api/data.ts:623-681 → api/substrate.ts:148-187): 0.62-2.63 against 0.22-1.90 µs a record in batches of 256, and 11.4 against 0.98 µs with one `group` view at 1e3 rows (E-05), on every copy and every subscriber (PA-11). The frame checksum is already per frame (code: kernel/codec.ts:1075, 1083): keep it per batch.
- **Allocations per record** on every copy (v4): a `RecordView`, the copied-out record with its key array and value objects (code: kernel/write.ts:842), a log entry (kernel/write.ts:843-846), an `Applied` object (kernel/node.ts:2895), a one-record array for the lane (api/substrate.ts:160). The objects `data` folds are NEEDED; the rest AVOIDABLE in a batch path (PA-11, PA-13).
- **Thread crossings:** a committed batch crosses worker → main once for the fold (NEEDED while `data` folds on main). A delta that waits for main adds main's event-loop delay to every delivery (PA-3). If the kernel worker also owns client sockets, heavy fan-out (8-14 µs a socket write, E-08) and reconnect storms (10,000 TLS handshakes took a serving thread 0.8 of a core for 7 s, with delivery p99 at 100-156 ms, 27-45 times steady, E-39) land on the thread that runs every group's heartbeats, appends and votes, the thread F-14 keeps free. A separate link-and-flow thread costs one more crossing at 27-40 ns a record and keeps both free; the other choice is a TLS terminator in front (A-11) and a per-tick budget for handshakes and socket writes on the worker. A storm timed while Raft heartbeats run should choose between them (PA-3 a).
- **Waits that could run side by side:** the delivery and the fold (PA-3); derived outputs and the next source record (PA-19); ReadIndex and the next `APPEND` (PA-30); the snapshot's encode and the subscriber's registration (register at P first, queue deltas after P meanwhile; reasoned from E-31's model).
- **Head of line:** order per partition is a promise (NEEDED); across partitions there is none (API.md 4 "Order"), so a big record of one partition need not hold back another's deltas: interleave other partitions' frames between a big record's cuts (PA-6). On a link the stall is the record's transfer time, about 8 ms for 1 MiB at 1 Gb/s (computed).
- **Security per operation:** the door proves the secret once per link, TLS is per link: both right. API.md says servers check a token "when a follow opens, on every write and call, and on every record a relay, a prefix, a view or a method's returned view forwards" (API.md 4). Per forwarded record that is a check per delivery; the verdict for (token, partition) does not change between records, so take it once per (subscription, partition) and cache it until the token or the selection changes (PA-34).
- **Fsyncs:** no read path fsyncs. The read paths that write (a renewal, a claim and an ack, a group cursor, a derived output) are writes and share the journal's group commit. PA-9 and PA-33 remove some; PA-18 removes claims that write nothing but still wait for a commit.
- **The recorder:** a `SUB`, a `CREDIT` or a `fresh` read is an input of a few dozen bytes to a few KB, not in the journal, so it is recorded whole; a delivery is an effect and never recorded. So reads add bytes per subscription, not per delivery (reasoned from E-42). If L3 runs on main outside the deterministic kernel, the recorder never sees a `SUB` and a subscribe bug cannot be replayed: PA-29, and PA-3's delivery from bytes inside the kernel would put the subscribe path back under the recorder.

## 5. The replication and upkeep paths

The work a cluster does to keep its copies whole, rather than to serve a write or a read. A record here is about 100 B and a batch 256 records, as in E-02 and E-05.

**The parts every upkeep path shares, as drafted:**

| Part | As drafted | Thread | Source |
|---|---|---|---|
| member link | one TCP (or TLS) link per machine pair; every group the pair shares rides it; Raft batches up to 1 MB, catch-up `APPEND` up to 4 MB, bundled frames cut at 1 MB | worker | DESIGN-V5 4.1 "Transports" |
| journal | one per process; every group's entries, terms and votes; one fdatasync per batch window | worker; fsync on libuv's pool | DESIGN-V5 4.1; E-12 |
| segments | after the journal fsync, entries written again to one set of files per group, with offset, slot and partition indexes; the journal cut once segments cover it | worker | DESIGN-V5 4.1 |
| local snapshot | the folded rows at one offset, in incremental layers laid out by slot, with L2's tables beside them; every full copy cuts its own | main (rows), worker (files) | DESIGN-V5 3.4, 4.1; LAYERS 1.2 |
| fold | `data`'s lane folds committed records in offset order on every full copy | main | V5-1; LAYERS 3.4 |
| object store | put, ranged get, list, delete, put-if-absent; old segments and layers uploaded by the leader and named in the group's log after the put is confirmed | worker | DESIGN-V5 4.1 |
| recorder | every kernel input recorded before the kernel steps on it; bulk bytes by journal reference; the journal kept for the window | worker | E-42 |

### 5.1 A follower catching up from segments

A follower is behind, but its next entry is still in the leader's log: after a restart, a slow disk, a healed partition, or a learner after its snapshot (5.3). Per 4 MB chunk:

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | both workers L1 | the link comes back; each side reports its log end for the groups the pair shares; a leader wakes any group whose follower is behind | 1 RTT a link; about 20 B a group | NEEDED: liveness after a restart without waiting for a write (DESIGN-V5 4.2 "Quiet shards") |
| 2 | leader worker L1 | find the follower's next index (log matching; one rejected `APPEND` with a hint) | 1 RTT, usually once | NEEDED (Raft) |
| 3 | leader worker L0 | look up the offset in the group's index; read up to 4 MB from the segment | `pread` (page cache or disk); one copy kernel to user | NEEDED; the copy is unavoidable from Node (no `sendfile` to a JavaScript socket; from memory) |
| 4 | leader worker L0 | check each batch's checksum as it is read | 9-10 ms per 4 MB with v4's JavaScript crc32c, about 1-2 ms native (computed from upkeep/b1) | NEEDED: a replica never serves past a bad entry (`par`, LAYERS 1.3). The JavaScript cost AVOIDABLE (PA-1a) |
| 5 | leader worker L1 | build the `APPEND`: a small header (term, previous index and term, commit) and the stored batches as they are | the header only, 40 B; the batches by reference | NEEDED. Re-encoding the entries AVOIDABLE: v4's catch-up re-encodes every entry from objects (code: kernel/scope.ts:728, kernel/node.ts:2555), 2.4-2.6 µs a record (upkeep/b2) (PA-5) |
| 6 | leader worker L0 | a checksum over the whole frame body: v4's `crcFrame` covers header and body (code: kernel/codec.ts:159) | another 9-10 ms per 4 MB in JavaScript | AVOIDABLE: the batches inside carry their own checksums; a frame checksum over the header keeps a flipped verb or length caught (PA-1a) |
| 7 | leader worker L0 | onto the member link: `writev`, corked per run (code: shell/runtime.ts:801-866); TLS if on | a syscall; a copy to the kernel | NEEDED |
| 8 | the link | **head of line**: every live `APPEND` and `APPENDED` of every other group on this pair waits behind it | 33.6 ms per 4 MB at 1 Gb/s, 3.4 ms at 10 Gb/s; a 1 MB bundle 8.4 ms at 1 Gb/s (computed) | AVOIDABLE against P-01's 5.73 ms bar: a bulk lane, or chunks of 64 KB or less queued behind live frames (PA-6) |
| 9 | network | one hop | 4 MB | NEEDED |
| 10 | follower worker L0 | the framer rebuilds the frame from TCP chunks (code: kernel/codec.ts:1031-1042) | ≤ 8 MB copied; 0.05-0.2 ns a byte, under 2 ms per 4 MB | CONDITIONAL (a split frame); small |
| 11 | follower worker L0 | check the frame's checksum (code: kernel/codec.ts:1075, 1083) | 9-10 ms per 4 MB in JavaScript | AVOIDABLE as a second whole-body pass. Checking each batch once before it is stored is NEEDED (it is also the disk checksum), about 1-2 ms natively (PA-1a) |
| 12 | follower worker L1 | log matching against its log | in memory | NEEDED |
| 13 | follower worker L1 | read each batch header: term, base offset, count, and whether it holds a configuration, move or snapshot-naming entry | headers only, about 30 B a batch | NEEDED: membership takes effect on commit and the applied configuration is stored with its index (E-10). A per-batch flag spares a scan of every record (upkeep/b2: 0.3-0.4 µs a record more) (PA-12) |
| 14 | follower worker L0 | write the batches to its journal | a syscall; the bulk joins every live group's next fsync | NEEDED durable before the ack. Its harm to live commits is real: E-35 measured 1 MiB records raising other groups' p99 1.18-1.26 times, and 40 MiB/s of them 1.52-1.59 times, and a catch-up runs at 150-290 MB/s (E-13). But a side file on the same disk does not cure it: a journal per tenant still gave 1.30-1.36 times "because the tenants share the disk" (E-35), and a 4 KiB fdatasync beside bulk writes waited 250-300 ms at p50 and up to 0.9 s (E-01). What helps is a byte-rate cap on the catch-up's disk writes as well as its link (PA-6); a side file stays optional until a run shows it helps |
| 15 | follower, pool | fsync | an fsync | NEEDED: Raft acks only what is on disk |
| 16 | follower worker L0 | as drafted, the same entries written again to the group's segment, and that fsynced before the journal is cut | a second write and a second flush stream | AVOIDABLE: E-12 found a second flush stream slows the first at moderate load (a striped journal: p99 5-24 times). One shared log with a per-group index writes once (E-49) (PA-7) |
| 17 | follower worker L1 | ack (`APPENDED`, its match index) | 1 hop, about 20 B | NEEDED |
| 18 | worker → main | committed batches cross to main | by transfer, 27-40 ns a record (E-07), no copy | CONDITIONAL: full copies only; a learner that is only to vote, and a log replica, fold nothing |
| 19 | main L2 | decode and fold | decode 2.5-3.0 µs a record with v4's codec, 3.5-4.1 µs with its JavaScript checksum (upkeep/b2), fold 0.22-1.90 µs per batch (E-05) | NEEDED: fold-all (V5-1, V5-6). v4 hands `data` one record per lane call (code: api/substrate.ts:160, kernel/node.ts:2895): AVOIDABLE (PA-11); the decode's speed PA-1 |
| 20 | both workers | repeat per chunk, a window of chunks in flight | a wait | NEEDED |

- **v4 today** has no Raft log; its catch-up is digest anti-entropy (code: kernel/node.ts:2555-2611) and the one-teacher fold (code: kernel/scope.ts:683-745). Both re-encode every entry from objects, and the learner decodes every record on arrival (code: kernel/scope.ts:751).
- **Lower bound.** Per byte: one read at the leader, two checksum checks (the leader's on read, step 4, so a replica never serves past a bad entry; the follower's before it stores, step 11), one transfer, one write and one fsync per chunk at the follower. Per record, on full copies only: one decode and one fold. No decode or encode on either worker.
- **Gap, as drafted and built like v4:** per 4 MB about 28-31 ms of JavaScript checksum (three passes), a re-encode, a second disk write and flush stream, and up to 34 ms of head of line at 1 Gb/s. Lean (build only) drops the re-encode and the third checksum pass. With PA-1a, PA-6's cap and PA-7 it closes to about 2-4 ms of native checksum per 4 MB (two passes) plus the fold, with the catch-up's rate held under what live commits can bear.
- **Others** (from memory): a Kafka follower fetches; the leader serves segment bytes by `sendfile`, never decoding them; replication can be throttled (KIP-73). etcd sends `MsgApp` of at most `MaxSizePerMsg`; the follower writes them once to its WAL. Redpanda's Raft entries are Kafka record batches with one CRC per batch. TiKV's raft-engine keeps every region's log in one set of files with an in-memory index.

### 5.2 Making a snapshot

A group's tail passes N records or M bytes; every full copy cuts a layer of the rows changed since the last one; the leader uploads it (DESIGN-V5 3.4, 4.1).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | worker or main | trigger: the tail passes N records or M bytes | a compare per batch | NEEDED: bounds the tail, so retention can always be met |
| 2 | main L2 | cut at offset o: once the fold reaches o, take the rows changed since the last layer (a dirty set per group) and their values, copy on write | a set add per changed row on every write; O(changed) references at the cut | NEEDED: a snapshot at exactly one offset |
| 3 | main L2 | encode the changed rows, a marker per removed row, and L2's tables (slot sequences and epochs, session outcomes and floors, fence table, derived-once marks, caller keys, the fold version, the applied configuration, the slots held open) | 2.4-2.6 µs a row with v4's codec, 0.41-0.45 (JSON) or 0.64-0.71 (V8) (upkeep/b2) | NEEDED on main as drafted (rows are objects there; a structured clone costs 0.9-6.2 µs a record, E-07). The codec's speed AVOIDABLE (PA-1b). 1e6 changed rows with v4's codec hold main for about 2.5 s unless sliced (computed); E-05 measured 1.7 s per 1e6 rows |
| 4 | main or worker | lay out by slot with a per-slot index | a sort or bucket by slot | NEEDED: a move or a one-slot reader reads only its slot |
| 5 | main → worker | hand the bytes to the worker | by transfer, no copy | NEEDED |
| 6 | worker L0 | write the layer, fsync it, fsync the folder, record it in the local manifest | 2-3 fsyncs | NEEDED: a snapshot that lets the log go must be durable first. It skips the journal, which keeps it off the live fsyncs (good) |
| 7 | each other full copy | steps 2-6 again | an encode again | CONDITIONAL: without the store each copy needs its own restart point. Cut from the log's bytes on the worker, each copy's layer would be byte-identical (PA-14) |
| 8 | leader worker L0 | upload the layer, put-if-absent, named by (group incarnation, offset) | a signed request (SigV4) over TLS; a store RTT: 1.4-7 ms MinIO here, about 30 ms S3 Standard (E-28) | CONDITIONAL: tier on; once per layer, by the leader only |
| 9 | L1 | append an entry naming the layer; it commits | 1 commit, about 100 B | NEEDED: every copy knows the object exists before any drops its log |
| 10 | worker | in the background, layers merge into a new base; removal markers drop | read every layer, write a merged base | CONDITIONAL: bounds a cold start's layer count |

- **v4 today** re-encodes every live log entry, changed or not (code: kernel/node.ts:1292-1330, `encodeRun` at 1315), writes all of it to a temporary file, fsyncs and renames (code: shell/runtime.ts:495-530), triggered by a row count (code: kernel/node.ts:1121): O(state) per snapshot. The design's incremental layers fix that.
- **Lower bound:** the rows changed since the last layer, written once to each copy that needs a local restart point, uploaded once; no main-thread pause beyond capturing references; no encode at all if cut from the log's bytes. **Gap:** 3 copies × 2.4-2.6 µs a changed row of main-thread encode with v4's codec; a native serializer gives 0.41-0.71 µs, still on main and still 3 times (PA-1b, PA-14).
- **Others** (from memory): etcd snapshots its bbolt file, already in stored form, with no encode of the state; TiKV and CockroachDB build SST files from a storage-engine snapshot; Kafka's compaction rewrites segments on bytes in a background thread; Redis writes an RDB from a forked child.

### 5.3 Installing a snapshot

A copy is behind the leader's log start: a new learner (5.6), a copy back after a long absence, or a copy that lost its disk.

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | leader worker L1 | the follower's next index is below the first log index: start a snapshot send; each member loads at most two at a time and answers `busy` past that | a message; a back-off timer | NEEDED: InstallSnapshot; the pacing protects the member (DESIGN-V5 4.2) |
| 2 | the new copy's worker, or the leader's | source: the merged base and later layers from the store, in parallel ranges, or the leader's local layer files streamed | store GETs (about 30 ms each on S3, E-28) or `pread` at the leader | NEEDED (one of them); the store spares the leader's CPU and link |
| 3 | network | the bytes travel, from the store over HTTP or over the member link | head of line on the member link, as 5.1 step 8 | NEEDED; the member-link form's head of line AVOIDABLE (PA-6) |
| 4 | worker L0 | check each chunk's checksum | 24.1 s for 10 GB in v4's JavaScript (E-34); 2.8-4.9 s natively, once per batch, over bytes streamed from disk (0.27-0.48 ns a byte, upkeep/b1; computed) | NEEDED; the JavaScript cost AVOIDABLE (PA-1a) |
| 5 | worker L0 | write the files directly (not through the journal), fsync each, fsync the folder, record them; ack only after | fsyncs | NEEDED: a snapshot is acked only once durable. The direct write keeps bulk off the live fsyncs (good; 5.1 step 14 should do the same) |
| 6 | worker | drop the old log below the snapshot | unlink | NEEDED |
| 7 | main L2 | load the base, then each layer in order | decode 2.5-3.0 µs a row (v4) or 0.84-0.95 (V8's format) (upkeep/b2); fold 0.22-1.90 µs (E-05) | NEEDED on a full copy, once per row. A row changed in k layers is decoded and folded k + 1 times as drafted: AVOIDABLE by merging layers by key first (PA-36). A copy that is only to vote, and a log replica, skip this |
| 8 | main | restore L2's tables from the snapshot | a decode | NEEDED |
| 9 | | the tail since the snapshot comes as in 5.1 | | NEEDED |

- **v4 today:** the teacher walks its index for the partition and re-encodes every entry (code: kernel/scope.ts:705-728); the learner decodes each record as it arrives (code: kernel/scope.ts:751), then folds at the end.
- **What it costs today:** 1e6 small rows replay in 4.5 s, 36 s per GB, most of it v4's decode (E-05). 5e6 small rows in 22-24 s; 10 GB of 2 KB rows in 86-122 s (median 94 s), of which decode 51.8 s, crc 24.1 s, fold 8.2 s, read 5.7 s, with the collector inside the decode and the fold (E-34).
- **Lower bound:** the state's bytes over the network once, written once with an fsync per file, each final row decoded and folded once, on full copies only. Unlike etcd or TiKV, fero cannot install a snapshot without decoding it: its state lives as `data`'s objects on main (V5-1, V5-6), so the decode is part of the bound; only its speed is in play.
- **Gap:** the JavaScript checksum (about a quarter of E-34's wake) and the decode, most of whose 51.8 s is the collector moving 11 GB of kept rows (35.6 s of GC inside decode and fold, E-34). With PA-1a the checksum falls from 24.1 s to 2.8-4.9 s (native, once per batch, over bytes streamed from disk at 0.27-0.48 ns a byte, upkeep/b1). The decode falls far less than small rows suggest. Kept, E-34's 2 KB rows decode in 6.08 µs a row with v4's codec, 5.06 with the value as JSON per record and 3.49 in V8's format, at 1,000,000 rows (about 2 GB of heap; b3). JSON took 0.73 of v4's time at 250,000 rows and 0.83 at 1,000,000, and V8's format 0.47 and 0.57: the gap closes as the heap grows, because the collector's work on kept rows does not shrink with the format. The second check's rerun at 1,000,000 rows was noisier: JSON 0.87 of v4's time (medians of 3 runs each; 0.80-0.96 run against run), and one run of V8's format 0.68 (E-50 results/recheck). E-34's own v4 decode rose from 7.0 µs a row at 2.5e6 rows to 10.4 µs at 5e6, so the collector's share keeps growing past b3's 2 GB heap, and at 11 GB JSON may gain nothing. Rebuilt from E-34's parts (read 5.7 s, fold 8.2 s, about 4 s besides the load, and its 51.8 s decode either scaled by the 1,000,000-row ratio or cut only by the decode's own work, with all 35.6 s of GC kept), with PA-1a's 2.8-4.9 s of checksum: **about 51-64 s with snapshots in V8's format**, the design's choice, and about 64-75 s with JSON values, whose top is JSON gaining nothing (computed: 94 − 24.1 + 2.8-4.9 = 73-75 s, which is also PA-1a alone). Reasoned from measured parts; not timed at 11 GB. The first version's 30-36 s applied small-row ratios from decodes whose rows were thrown away. So JSON values gain little on rows with long strings, V8's format is the lever for snapshots, and a wake of big rows stays bound by the collector until rows live off the V8 heap. Lean, with a crc32c in JavaScript, the wake is about 82-94 s: a slice-by-8 table checks 10.2 GB in 12-13 s at 1.2-1.3 ns a byte, against v4's 24.1 s (computed from write/crc). For small rows E-05 measured the JSON replay directly: 3.35 s against 4.48 s per 1e6 rows (0.75).
- **Others** (from memory): etcd streams the bbolt file over a separate HTTP stream and swaps it in; CockroachDB and TiKV ingest SST files straight into their engine; Redis parses every key of an RDB, the closest to fero's case.

### 5.4 The object-store tier: upload, and reading back

Upload, when a segment seals or a new layer exists (5.2 step 8):

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | leader worker | trigger: a segment seals | an event, no timer | NEEDED; only the leader uploads |
| 2 | leader worker L0 | read the segment: as drafted one sequential read of the group's file; with shared segments (PA-7), a gather of the group's extents by its index | `pread`s; the gather's copy 0.05 ns a byte (upkeep/b1) | NEEDED; the gather is small |
| 3 | leader worker | check each batch's checksum | a hash | NEEDED: a bad batch must never become the store's good copy (`par`, LAYERS 1.3) |
| 4 | leader worker | build the segment's index by offset and slot (and by partition, as drafted) | by slot from record headers if each record carries its slot (E-19: +3.9 B a record); by partition a key decode per record, 1.3-1.6 µs (upkeep/b2) | NEEDED by offset and slot; CONDITIONAL by partition (PA-12) |
| 5 | leader worker L0 | put-if-absent the segment and its index | a signed request over TLS; a store RTT (1.37 ms p50 MinIO 1 KB; about 30 ms S3; E-28) | NEEDED; links kept alive |
| 6 | L1 | append an entry naming it; it commits | 1 commit, about 100 B | NEEDED; several names can share one entry |

Reading back, for a `log` reader below local retention, a new copy's base (5.3), a restore (5.8), or a move's reference (5.5):

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | worker | find the object holding offset o from the names in the group's log | a lookup in memory | NEEDED |
| 2 | worker L0 | GET the object's index (or a cached one), then GET the byte range | 1-2 store RTTs | NEEDED; the index GET CONDITIONAL (cache it) |
| 3 | worker | check checksums | a hash | NEEDED |
| 4 | worker; main for a fold | a `log` reader gets the batches as they are, filtered by slot from headers; a fold gets them across the seam | no decode on the worker | NEEDED; a partition filter needs a key decode per record of the slot (CONDITIONAL) |
| 5 | worker | keep fetched ranges in a local cache | a disk write | CONDITIONAL (DESIGN-V5 4.1: "cached by the server that reads them") |

- **Lower bound:** each sealed byte uploaded once by one copy; read back only the ranges asked for; no decode unless something folds them. **Gap:** small: a per-partition index needs a key decode per record at seal (PA-12), and with shared segments a gather on upload.
- **Others** (from memory): Kafka's tiered storage (KIP-405) copies rolled segments with their indexes; Redpanda uploads segments plus a manifest; WarpStream writes files that hold many partitions with an index, the shape PA-7 would give.

### 5.5 A slot move

Slot s moves from group A to group B of the same resource; under V5-2 the home group's leader decides and the slot table lives in the home log (DESIGN-V5 4.2; LAYERS 8.3; SIMPLICITY 3.2).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | home leader | pick s, A and B from the groups' loads | policy | NEEDED: one mover per resource |
| 2 | A L1 | commit `exporting(s, to B)` | 1 commit | NEEDED (E-15) |
| 3 | B L1 | commit `importing(s, from A)` | 1 commit | NEEDED |
| 4 | B leader | record the move's new epoch in the store's restore mark, before use | a conditional PUT: 1.8-3.6 ms MinIO, about 30 ms S3 (E-28) | CONDITIONAL: tier on (E-33); before the fence, so it adds nothing to the window |
| 5 | A main or the store → B | copy s while A still takes writes: a `state` subscription to s at A (A's main encodes s's rows), or A's newest layer for s from the store plus A's tail | an encode at A, 2.4-2.6 µs a row (v4's codec); a hop | **AVOIDABLE when every copy of B sits in a process that holds a copy of A** (always with 3 machines and 3 copies) (PA-15); CONDITIONAL otherwise |
| 6 | B L1, L0 | append the copy to B's log; it replicates and commits | 2 more transfers; 3 journal writes and fsyncs (3 more segment writes as drafted); head of line on links and journals | AVOIDABLE as step 5 |
| 7 | B's mains | each copy of B keeps the import unseen until `open`, then folds it or switches to it | a decode and fold of s's rows on each copy | AVOIDABLE as step 5: those processes already folded s from A's records; the merged view only switches owner (E-23). But the work moves into L2: after `open`, s's rows still live in A's fold until B's next snapshot, so B's writes and removes must hide A's rows in the merged view, and A must not drop or compact s's rows or segments while B points at them. DESIGN-V5 4.2 "Views mid-move" assumes B holds its own imported copy |
| 8 | B → A | B reports ready, with the position its copy reached, until A answers | a hop, repeated | NEEDED |
| 9 | A L1 | commit `fenced(s, to B, N)`; writes to s now get `retry`, then `moved(B)`; the window opens | 1 commit | NEEDED |
| 10 | A main and worker → B | the delta since ready, `END(N)`, and the carried set: slot sequence and epoch, session outcomes and floors, the fence table, derived-once marks, segment names | small encodes on main; a crossing; a hop | NEEDED: E-32's crossing rules carry these |
| 11 | home group | s → B in the slot table, in the resource's home log | 1 commit (0 if B is the home group) | NEEDED: the table is never behind an `open` |
| 12 | B L1 | commit `open(s, N)` and serve s; the window closes | 1 commit | NEEDED |
| 13 | clients | a stale route gets one `moved`; `state` subscribers get `END` at A and resubscribe at B | 1 RTT each | NEEDED |

- **The window** is three commits: 2.7-4.1 ms at the median and 16.7 ms at p99 at 10,000 writes a second, on E-10's TypeScript Raft (E-13). The bulk copy (steps 5-7) comes before the fence and adds nothing to it, but it loads the links and journals the window's commits wait on (5.1 steps 8 and 14).
- **Bulk bytes, as drafted:** for the shard rule's split (a group over 4 GB moves half its slots, DESIGN-V5 4.2): 2 GB sent 3 times, written 3 times (6 with the segments), decoded and folded 3 times; at E-05's v4 replay rate of 36 s per GB, about 72 s of main-thread fold per copy (computed).
- **Lower bound:** when every copy of B sits on a machine with a copy of A (always with 3 machines and 3 copies), the slot's rows are already on every target machine, in its log and its fold. The move then needs only its control entries and the carried set: no bulk bytes. Each copy of B names A's newest layer for s and A's segments up to N, as a fork names its parent's (SIMPLICITY 3.1 `forks`: "copies nothing"), and B's next snapshot takes s in. Retention already keeps what a move or a fork still reads (DESIGN-V5 4.1). A copy of B on a machine without A fetches by that reference. **Gap:** up to the slot's whole state three times over, against zero; a rare path, so the gain is in bytes and background load (PA-15), bought with L2 rules for masking A's rows and pinning them (medium-low certainty: E-23's merged views and DATA-09's differential test are touched, as well as E-15, E-17c and E-32).
- **Others** (from memory): CockroachDB and TiKV split a range in place, its data already on the same replicas, so a split moves no bytes; a merge first co-locates the replicas, then merges by metadata. Redis Cluster always moves keys between nodes (`MIGRATE`), because a slot there means a node.

### 5.6 Healing: add a learner, catch it up, promote it

A voter of group g is gone past `evict.after` (10 minutes); g's own leader heals it (V5-2; E-16; SIMPLICITY 3.2).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | leader worker | the link to the gone machine stays down past `evict.after` | a timer; link pings every 500 ms per machine pair, shared by every group (E-25) | NEEDED: failure detection per machine pair, not per group |
| 2 | leader L1 | pick a quieter machine and write the choice into g's log before the add | 1 commit | NEEDED: SIMPLICITY 3.2's added rule (two leaders may rank machines differently) |
| 3 | leader L1 | add the new machine as a learner | 1 commit | NEEDED |
| 4 | | the learner loads a snapshot (5.3) and the tail (5.1) | as 5.3 and 5.1 | NEEDED. A returning disk is reused and gets only the tail (good) |
| 5 | | the learner's log reaches the commit offset exactly | a wait | NEEDED (A-01) |
| 6 | leader L1 | promote it; check it holds the commit again, its own promotion included | 1 commit, a wait | NEEDED (E-16; A-01) |
| 7 | leader L1; home group | remove the gone voter; refresh g's record in the resource's home log | 1 commit; 1 more if g is not the home group | NEEDED |
| 8 | new copy's main | the new voter folds what it holds | a decode and fold (5.3 step 7) | CONDITIONAL: a full copy folds before it serves or leads, not before it votes; the design does not wait for the fold to promote (good) |
| 9 | every leader | every group the gone machine held heals on its own | as above, paced to two snapshot loads at a time per member | NEEDED |

- **What it costs:** etcd caught up at 5.2-6.9 s per GB (E-13). A TypeScript full copy that folds is bound by its decode and fold, at a rate per GB that depends on the row shape. Small rows: about 36 s per GB with v4's codec, and 21 s per GB of the (larger) log with the values as JSON, which E-05 measured directly (1e6 small rows replayed in 3.35 s against 4.48 s). 2 KB rows: about 9 s per GB with v4's codec (E-34), about 5-6.3 s per GB with PA-1a and snapshots in V8's format and 6.3-7.4 s with JSON values (reasoned from 5.3's rebuild).
- **Lower bound:** the group's state into the new machine once (from the store, sparing the leader), written once, folded once on a full copy; three configuration commits plus the placement record. **Gap:** 5.1's and 5.3's (PA-1a, PA-1b, PA-6, PA-7), plus head of line on live groups while it runs; the control steps are already minimal.
- **Others** (from memory): CockroachDB's replicate queue adds a learner, sends a snapshot, promotes it through a joint configuration and removes the old voter; Kafka's reassignment adds replicas that fetch until they join the in-sync set.

### 5.7 Retention and compaction

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | | a snapshot bounds the tail (5.2) | | NEEDED |
| 2 | worker | per group, check whether the log below offset i may go: a covering snapshot (fsynced locally, or a merged base in the store), the segment uploaded or `history` allowing, no move still reading it, no fork naming it | compares per segment | NEEDED (DESIGN-V5 4.1) |
| 3 | worker | drop whole segment files | unlink, a folder fsync | NEEDED; O(files), never per record |
| 4 | worker | as drafted, cut the journal once segments cover it | unlink | CONDITIONAL: exists only because of the double write (PA-7) |
| 5 | worker | keep the journal for the recorder's window | 441 GB a day at 50,000 appends a second, 8.8 GB at 1,000 (E-42) | NEEDED for the recorder; as drafted the journal and the segments hold the window twice (PA-7) |
| 6 | worker | with shared segments: a file goes only when no group needs a record in it, so a lagging group's live records are copied forward first | read, write, fsync of that group's tail | CONDITIONAL (PA-7's cost), bounded by snapshotting a group that pins an old file (reasoned) |
| 7 | worker | history lapses in the store | a DELETE per object, or a bucket lifecycle rule | NEEDED |
| 8 | worker | layer merges (5.2 step 10) | read and rewrite | CONDITIONAL |
| 9 | L2 | session outcomes and caller keys lapse after their horizon (writer time) | small | NEEDED |

- **v4 today:** compaction rides the heartbeat tick and walks every lane past `compactAt`, keeping per-cell winners (code: kernel/log.ts:254-279): 43 % of the CPU in a two-member run (DESIGN-V5 8, 9). v5 drops whole segments instead.
- **Lower bound:** deletes by whole files, no work per record. **Gap:** only PA-7's copy-forward if shared segments are taken, or the recorder's second copy if not.
- **Others** (from memory): Kafka deletes whole segments by time or size; raft-engine purges a file once every region in it has compacted past it and rewrites the few entries of regions that lag.

### 5.8 A restore from the store

Every disk is lost, or the owner asks for a past position (`fero restore`, an admin step; LAYERS 8.6; E-33). Under V5-2 it runs per resource.

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | restoring process | read the restore mark (the highest epoch used, the session generation) | 1 GET, about 1 KB | NEEDED (E-33) |
| 2 | | find each group's objects: the names lived in the lost logs, so LIST the resource's prefix, or read a per-group manifest | LIST pages of 1,000 keys, or 1 GET per group | NEEDED; a manifest makes it one GET (PA-37) |
| 3 | | take an epoch above the mark and raise the session generation; write both before any use | a conditional PUT (If-Match: 1.8-3.6 ms MinIO, about 30 ms S3; E-28) | NEEDED (E-33: without it a lock token repeats in 5 steps). One PUT for both; it can run while step 4 fetches (PA-37) |
| 4 | each new copy | GET the base, the layers and the segments up to the position, in parallel ranges | store GETs | NEEDED |
| 5 | worker | check checksums | a hash | NEEDED; native per batch (PA-1a) |
| 6 | worker | write them locally as the copy's base; fsync | disk, fsync | NEEDED: the copy's restarts then need no store |
| 7 | main | load the base, each layer, then replay the segments to the position | decode and fold | NEEDED once per row; k + 1 decodes for a row changed in k layers as drafted (PA-36) |
| 8 | L1 | found each group again: first entries; the slot table record at the new epoch in the home log | 1 commit per group | NEEDED |
| 9 | L2, L3 | answer a retry from an older session generation `restored`; refuse a cursor the history lacks `unknown-log` | compares | NEEDED (rules, no cost) |

- **Lower bound:** one round of metadata reads, one mark write, the state and tail read once per copy, each final row decoded and folded once per full copy. **Gap:** LIST against a manifest, the mark PUT in series with the fetch (about 30 ms on S3), layer re-decodes, and 5.3's checksum and decode (PA-1a, PA-1b). An admin path: only PA-1 matters.
- **Others** (from memory): `etcdutl snapshot restore` rewrites member ids with no decode per key; CockroachDB's RESTORE ingests backup SSTs in parallel on every node.

### 5.9 A crash, and the boot after it

A server stops without warning and starts again with its disk (LAYERS 8.5).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | process | Node starts and loads modules | E-26's cold start of three processes and 20 groups took 265-318 ms, most of it this | NEEDED |
| 2 | main, lease thread L0 | take the dir lease: claim the lock file, start the toucher, take a new epoch, rename the old epoch's folder, write and fsync a boot record naming the end offset (code: shell/runtime.ts:107-158, 235-305) | 2-3 fsyncs; about 1 KB | NEEDED: one process per data folder (`dir-lease`) |
| 3 | worker | read the boot record; refuse another cluster's or project's folder | a read | NEEDED |
| 4 | worker L0 | replay the journal: read it in large chunks, check each batch's checksum and the chain of offsets, cut a torn tail, mark a bad entry for `par` | a read; a hash per batch; headers only | NEEDED. v4 reads the whole file into one buffer (code: shell/runtime.ts:585), copies each frame out (code: shell/runtime.ts:594), re-frames it (code: kernel/node.ts:880), checks its crc (code: kernel/codec.ts:1083), then decodes every record's key in the kernel. v5 needs headers only on the worker: 0.04-0.07 µs a record natively against 1.3-4.1 µs for a key or full decode (upkeep/b2) (PA-1a, PA-12) |
| 5 | worker | as drafted, records the journal holds that a segment also covers are read twice | a read, a hash | AVOIDABLE: replay only past what segments cover; with one shared log there is no overlap (PA-7) |
| 6 | worker L1 | rebuild each group's state: hard state, the applied configuration with its index (E-10), the newest snapshot, the segment index (loaded, or rebuilt from a checkpoint and a header scan) | memory | NEEDED. Scanning all retained history at boot AVOIDABLE: verify old segments when read (`par` catches damage then) |
| 7 | main L2 | **as drafted, main loads each group's newest snapshot and replays its tail before step 9** | E-34: 5e6 small rows 22-24 s; 10 GB 86-122 s | NEEDED once per row, but its place in the order AVOIDABLE: the copy can vote, take appends and ack before its fold is done (PA-16). This runs at every roll step (5.14), not only after crashes |
| 8 | main | check the fold version in force; refuse to serve the group if it cannot run it | a compare | NEEDED (E-43) |
| 9 | worker L0, L1 | rejoin each group as a follower; links come up (TCP, TLS, `HELLO`, `DOOR`: a proof per link, not per group) | 1-3 RTT a link | NEEDED; PreVote keeps the copy from unseating a leader |
| 10 | | each leader sends the missing tail (5.1) or a snapshot (5.3) | | NEEDED |
| 11 | main L3 | ready per group once its fold reaches the commit offset it was told; until then it answers `moved` | | NEEDED (DESIGN-V5 4.4) |
| 12 | workers | after a whole-project restart every group elects at once | elections in shared frames; one journal fsync covers many votes | NEEDED. E-49 section 6 timed it on three processes: by Raft's random timers, the base's boot, 3.0-5.0 s at 1,000 groups a process, 6.9-7.1 s at 10,000 and 20-23 s at 100,000, with about two thirds of leaders landing off their preferred member; with each group's preferred leader standing at once (a boot campaign, about +1 rule the base does not have), 0.56-0.82 s, 1.74-2.18 s and 7.9-11.2 s (34 s once, when it collided), leaders exact. Its knee lies between 10,000 and 100,000. After a random-timer boot, uneven leaders wait for the hand-back: about 1 min at 1,000, 4.5 min at 10,000 and 43 min at 100,000 (E-49 section 6; 5.14). Dormant groups (5.10) or a boot campaign help (E-49) |

- **Lower bound:** read each byte that will be folded once (the snapshot and the tail, not history), check it once, decode and fold each row once on main. Raft needs only the log's headers and the hard state, so "a voter again" can come within about a second of the start, and "ready" when the fold is done.
- **Gap:** v4: a whole-file read, a copy per frame, the kernel decoding every record, a lane call per record. As drafted: the fold before the rejoin (PA-16: 22-94 s at E-34's sizes), the JavaScript checksum and v4's decode (PA-1a, PA-1b), and the journal's overlap with segments (PA-7).
- **Others** (from memory): Kafka, after an unclean stop, scans only the segments past its recovery-point checkpoint, on `log.recovery.threads`; etcd opens its bbolt file (memory-mapped, no decode) and replays WAL entries since the snapshot; Redis replays its AOF command by command, the slow analog of fero's fold; raft-engine rebuilds its index by scanning its files in parallel.

### 5.10 Waking a dormant group, and opening a cold resource

Waking (E-26: one group writable 3.3-3.5 ms after the wake; 20 groups in 10-16 ms):

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | worker | a message, a write or an open arrives for a dormant group; look it up in the dormant map | a lookup; 57 B a group (E-26), or 138 B with the resource's name, in E-49's form that also drops the resource's settings, slot table and per-slot state, to be rebuilt on wake (E-49 sections 1 and 2) | NEEDED |
| 2 | worker | read its 24 B record (term, vote, commit, last index and term) | a `pread`; page cache, or about 0.1-0.2 ms cold (reasoned) | NEEDED |
| 3 | worker | rebuild the Raft node | about 3 KB live (E-49) | NEEDED |
| 4 | workers | campaign: PreVote, the vote (term and vote fsynced on each voter), the new leader's own-term entry commits | 3 RTT, 2 fsyncs | NEEDED as Raft is written. The copy that led when the group slept could resume its term: about 1-2 ms saved against a Raft change; not recommended (PA-39) |
| 5 | workers | followers rebuild on the first message for the group | a `pread` each | NEEDED |
| 6 | main | if the group's rows were dropped while dormant (E-49's form), load its snapshot and tail | about 0.05 ms for 10 rows (E-49 section 7, at E-05's rate) | CONDITIONAL |
| 7 | | serve the write or the read | | NEEDED |

Opening a cold resource from a client (`fero(name)` in another process):

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | client | ask the soft directory once for one address (V5-3); v4's lookup is a live subscription (code: api/directory.ts:298) | a link (2-3 RTT), then 1 RTT | CONDITIONAL: once per client and name; links reused per machine |
| 2 | client | link to that server (reuse an open link to the machine) | 0-3 RTT | CONDITIONAL |
| 3 | server | members, slot table and leaders from the resource itself | 1 RTT; a few bytes with an implicit slot table (E-49) | NEEDED |
| 4 | server | if the home group is dormant, wake it (above) | | CONDITIONAL |
| 5 | | subscribe to the followed partitions (4.5) | | |

- **Lower bound:** for a write, a read of the 24 B record, leadership confirmed, one commit; for a read, ReadIndex once a leader exists. **Gap:** about two RTTs and one election fsync inside E-26's 3.3 ms, against DEP-04's 1.5 s bar: small.
- **Others** (from memory): TiKV's hibernated regions keep their leader in memory and resume ticking on a message, with no election; CockroachDB's quiesced ranges stay in memory too. fero's dormant group leaves memory, which is why it campaigns.

### 5.11 Creating a resource (genesis)

E-49 measured a create at about 5 ms on one box and about 35 ms across boxes with S3.

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | main L4 | the first `fero(name, opts)` with a server role; check the options | small | NEEDED |
| 2 | worker or main | create the resource's id only if absent: in the store (If-None-Match PUT: 1.37 ms p50 MinIO, about 30 ms S3; E-28), or on one box an exclusive file create, fdatasync and folder fsync (about 0.45 ms at p50, 0.41-0.49, run alone; 0.74 ms in E-49's first runs, which each followed a large delete: E-49 section 7) | 1 store RTT, or 2 fsyncs | NEEDED: exactly one genesis (E-33) |
| 3 | worker L1, L0 | found the home group: hard state and the founding batch (settings, slot table, group record) in the journal; a single first voter commits it | 1 fsync; about 300 B per resource per member as drafted (E-49), less with an implicit slot table | NEEDED |
| 4 | main | make the main thread's state: a `data` source, a lane (code: api/substrate.ts:117-124) | allocations | NEEDED |
| 5 | worker | announce it in the soft directory | a message; every seed holds every entry. E-49's one list per server resends the whole list on every change unless changes are numbered (E-49, "The cheapest forms") | CONDITIONAL |
| 6 | | healing adds the other voters (5.6): two learners, a tiny catch-up each, promoted | 6 commits in the background | NEEDED for 3 copies; off the create's path |

- **Lower bound:** one create-if-absent at a shared authority and one local durable commit; the other copies join behind it. **Gap:** none to speak of. Across boxes the store's about 30 ms is the floor and NEEDED: V5-2 leaves no other shared authority, and the soft directory decides nothing (V5-3).
- **Others** (from memory): Kafka creates a topic through the controller's metadata log; CockroachDB by a schema change in its system ranges.

### 5.12 `par` repair of a damaged entry

E-37's `par`: a damaged entry is marked bad and copied from a peer (LAYERS 1.3, 7).

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | worker L0 | a checksum fails when a batch is read: boot replay, a catch-up serve, a tier upload, a fold | a hash, on reads that happen anyway | NEEDED. A background scrub of cold history CONDITIONAL (not in the design) |
| 2 | worker L1 | mark it bad; the copy stops voting, taking appends and standing, and does not serve or fold past it | memory | NEEDED (E-37's 7 rules) |
| 3 | worker | send `REPAIR(group, offset)` to any one peer | a hop | NEEDED: from any peer, not only the leader (E-37: with repair from the leader only, 4-9 % of two-damage states were stuck: 54 of 1,292 and 22 of 244) |
| 4 | peer worker | read its copy, check it, answer `REPAIRED` with the bytes and its commit index, or "no good copy" | a `pread`, a hash, a hop | NEEDED |
| 5 | worker | take it only if it is good and the peer's commit covers the offset | a hash | NEEDED (RF-01) |
| 6 | worker L0 | store it: files are never rewritten in place, so append it as a repair record and point the index at it; fsync | a write, an fsync | NEEDED. With one shared log (PA-7) an append and an index update; with per-group segment files, an overlay or a rewrite. In one shared log a record whose header is damaged makes every later record of every group suspect, for the whole retention, unless records describe themselves (magic, length, group, offset, a header checksum), so boot can resync past it and `par` knows which group to ask for (PA-7) |
| 7 | worker | clear the mark; resume voting and appending | | NEEDED |

- **What the checksum's granularity costs everywhere else.** LAYERS 1.2 and `disk-incarnation` put a checksum on every entry. A native checksum called per 100 B record costs about 200-230 ns, as much as the JavaScript one, against 20-50 ns a record when the batch is checked once (upkeep/b1): per batch is several times cheaper on every write, read and boot. A repair per batch fetches at most one batch (1 MB) instead of one entry, on a rare path (PA-11).
- **v4 today:** a proven hole condemns the whole store: the fold resets and the node refolds everything from the cluster (code: kernel/node.ts:1353-1365), E-37's `rejoin`, which copies a whole replica again for one bad record.
- **Lower bound:** 1 RTT to one peer, one read there, one append and fsync here. **Gap:** none on the repair itself.
- **Others:** the PAR paper (FAST '18, cited in E-37) repairs from peers this way. Kafka truncates at a corrupt batch found during recovery and fetches again from the leader; etcd treats a CRC mismatch inside the WAL as fatal unless it is a torn tail (from memory).

### 5.13 A leader failover (F-05)

The leader's process dies.

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | follower workers | followers miss link pings and appends for `election.ms` (2 s in TypeScript) plus jitter | a timer | NEEDED: failure detection; most of the failover (E-13: E + about 5 ms on etcd) |
| 2 | workers | PreVote | 1 RTT | NEEDED: a returning copy must not unseat a working leader |
| 3 | workers | the vote: the candidate and each voter store term and vote before answering | 1 RTT; an fsync on each (the shared journal batches many groups' votes in one fsync) | NEEDED |
| 4 | new leader | an entry of its own term; it commits, which also commits the old tail | 1 RTT; an fsync at a majority | NEEDED (Raft) |
| 5 | worker → main | the worker tells main it leads | a crossing | NEEDED |
| 6 | main L2 | main folds its whole log before it answers; a warm full copy has folded to the old commit, so only the just-committed tail remains | a decode and fold of a few batches | NEEDED (F-05; fold-all); cheap for a warm copy |
| 7 | main L2 | rebuild writer-only state: the log-end overlay (empty once the tail commits), the expiry heap, writer time from peers' clocks | an expiry heap built by scanning rows with a time-to-live: O(such rows) | CONDITIONAL. The scan AVOIDABLE if every full copy keeps the expiry index warm from its own fold (PA-38) |
| 8 | clients | in-flight writes at the old leader were never answered as committed; clients get `unknown` and retry at the new leader | 1 RTT each | NEEDED (DESIGN-V5 4.3) |
| 9 | subscribers | resubscribe elsewhere with their cursors (4.6) | | |
| 10 | workers | many groups: a machine that led a third of 10,000 groups fails 3,333 elections at once | batched frames, shared fsyncs | NEEDED; the CPU of thousands of elections at once in TypeScript is not measured (the nearest measured case is E-49 section 6's whole-project boot, every group electing at once on three processes: 6.9-7.1 s at 10,000 groups a process by Raft's random timers) |
| 11 | | after `settle.ms` (30 s), leadership goes back to preferred leaders, at most 10 a second per member | | NEEDED (no flapping); 3,333 groups take about 333 s after the 30 s (computed), so leaders are uneven for about 6 min after the machine is back (E-49 section 6), off the failover's path |

- **Lower bound:** the detection timeout, one PreVote RTT, one vote RTT with its fsync, one commit, and the fold of the in-flight tail. **Gap:** close to none beyond the timeout, if the expiry index is kept warm (PA-38).
- **Others:** etcd runs the same steps with a 1 s default election timeout (from memory; E-13 measured it). Kafka with KRaft elects new partition leaders after the broker's session times out (9 s by default, DESIGN-V5 8). Redis Cluster promotes a replica after `cluster-node-timeout` (15 s by default; from memory).

### 5.14 A roll step: hand over, restart, catch up, hand back

A deploy restarts the copies one at a time (DESIGN-V5 6.1, "A roll on v5"; 4.2, `restart` and "A planned handover"). Here S2 restarts. It leads a third of the groups of every resource it holds: about R/3 groups with R small resources a process. This path runs on every deploy, so its costs are not rare.

| # | Where | Step | Work | Verdict |
|---|---|---|---|---|
| 1 | S2 | the signal: SIGTERM under a supervisor (`restart`), or the platform's `drain`; it hands over every group it leads and stays a replica of all of them | per led group | NEEDED: no group waits for an election timeout |
| 2 | S2 L1, per led group | stop taking new writes; a write that arrives meanwhile gets `moved`, naming the target, at once | none | NEEDED: refuse at once, never drop (E-13: etcd dropped writes caught in a transfer in 8 of 15) |
| 3 | S2 → target | bring the target to the log end (a warm voter usually is), send TimeoutNow; the target stands at once: its term and vote fsynced on the voters, then its first entry committed | "about one round trip and one fsync" (DESIGN-V5 4.2); etcd's group paused 9.7-9.8 ms at the median, about 4 ms over a quiet window (E-13) | NEEDED |
| 4 | client | the `moved` write reaches the target before its first entry commits: `retry`, with a retry-after | as drafted, the client's 200 ms floor | AVOIDABLE: a retry-after of the handover's expected rest, honoured below the floor (PA-20). Writes behind it in issue order wait too (O.seq) |
| 5 | S2, all its groups | R/3 handovers at once, their messages in shared frames and their votes sharing fsyncs | not measured in TypeScript at thousands | NEEDED |
| 6 | S2's clients | S2's client links close; clients reconnect elsewhere and resubscribe from their cursors (4.6) | E-39: 10,000 subscribers back in 1.5 s over TCP and 5.6-7.1 s over TLS, the serving thread at about 0.8 of a core, delivery p99 100-156 ms meanwhile | NEEDED. Where those handshakes land is PA-3 (a)'s guard: not on the kernel worker that is taking over S2's leaderships at that moment |
| 7 | S2 | the process exits and boots again with its disk (5.9) | a cold start of three processes and 20 groups: 265-318 ms (E-26) | NEEDED |
| 8 | S2 main | as drafted, the fold before the rejoin (5.9 step 7); meanwhile each group runs on two of three copies | 22-94 s at E-34's sizes; seconds for small resources | AVOIDABLE in order: vote and ack before the fold is done (PA-16). Without it, one more failure in that window stops writes |
| 9 | leaders → S2 | the links come back; each side reports its log end per shared group; leaders wake quiet groups whose follower is behind and send the tail (5.1) | the writes missed: at 50,000 a second of 100 B for 10 s, about 50 MB, at 150-290 MB/s (E-13) | NEEDED; under PA-6's cap so live commits keep their p99 |
| 10 | platform | `caughtUp` says so; the next copy goes | a number per group | NEEDED (DESIGN-V5 6.1) |
| 11 | each group's leader | after `settle.ms` (30 s) live and caught up, S2 takes back its preferred leaderships, at most ten a second per member: steps 2-4 again, once per group | `settle.ms` plus R/3 ÷ 10 a second: leaders uneven for about 1 min at 1,000 resources a process, 6 min at 10,000 and 56 min at 100,000 after the restart (E-49 section 6, from DESIGN-V5 4.2) | NEEDED: no flapping. But a fixed rate makes uneven leadership last in proportion to R, after every restart (PA-41) |
| 12 | the whole roll | three copies in turn: each group's leader moves away and back when its preferred copy restarts; if the next copy restarts before the hand-back ends, its groups move again | 2-3 handovers per group per roll (reasoned). If each restart waits for the last hand-back to end, the hand-backs alone take about 3 min at 1,000 resources a process, 18 min at 10,000 and 2.8 h at 100,000 (E-49 section 6); if the roll goes on once a copy has caught up, they overlap, and leaders stay uneven for about the roll's length plus one hand-back, about 1, 6 and 56 min (E-49 section 6, reasoned there). DESIGN-V5 does not say which | NEEDED |

- **With PA-16, PA-20 and PA-41 applied** (reasoned): each group pauses for about one handover (etcd's added pause was about 4 ms here, E-13) when its preferred copy goes and again when it comes back; a write caught in it retries after a few ms, not 200; the restarted copy votes and acks within about a second of its start, while its fold catches up behind; and leadership is even again as fast as batched handovers allow, busy groups first.
- **Lower bound:** per copy, one handover per led group (one round trip and one fsync, batched across groups), a restart, and a catch-up of the missed tail; the hand-back paced by what the box can take, not by a fixed count (reasoned). From measured parts, E-13 reasoned a three-copy roll at about 1 s on this box (0.3 s restart, 10 ms handover and a few ms of catch-up per copy), before any fold wait or hand-back.
- **Gap:** the fold before the rejoin (PA-16), the 200 ms floor for writes caught in each of a group's 2-3 handovers (PA-20), and the hand-back's fixed pace at large R (PA-41). The reconnect storm of step 6 is a cost of where client links end (PA-3 a), not of the roll.
- **Others** (from memory): Kafka's controlled shutdown moves leadership off a broker before it stops, and its preferred-leader election moves it back later, checked every few minutes; etcd's `move-leader` is Raft's leader transfer.

### 5.15 Three more paths, briefly

- **TTL expiry** (`rows: { ttl }`). The writer keeps an expiry heap; on its tick it appends one `remove` record per expired row, with the reason `ttl`, in one batch (DESIGN-V5 4.3: "a tick costs what expires, not what is held"). Every copy folds the removes and subscribers see them. **At the bound** on the writer: one record per expired row, one commit per tick, no scan. The gaps are PA-38's (a new leader builds the heap by a scan) and, on a cache with heavy churn, one logged remove per expiry, which is NEEDED: every copy must drop the same rows at the same position. A `touch` that resets a TTL is a logged write for the same reason.
- **Making a fork** (`forks`). A fork is a new resource whose groups start from the parent's snapshots and segments, named by reference: a genesis (5.11, about 30 ms with S3), then one record per group in the fork's home log; nothing is copied on disk or the wire (SIMPLICITY 3.1 `forks`: "copies nothing"; DESIGN-V5 6.2 row 8). But fold-all makes every full copy of the fork load the parent's state into its own fold before it serves: an install's decode and fold (5.3) per copy, 4.5 s per 1e6 small rows with v4's codec (E-05), less with PA-1b. E-06 measured a fork that runs at O(rows) in memory (2.6 s and about 250 B a row at 1e6), and 0.1 ms only if `data`'s store shared structure (not planned). So a fork is cheap on disk and dear in memory and CPU, per copy (reasoned from E-05, E-06).
- **A rolling fold-version change** (E-43). The fold version names `data`'s exact build and fero's way in (and the Node version, where user functions run in the fold), and it is an entry in each group's log (OPS-12): E-43 found two `data` builds with the same `SCHEDULE_VERSION` folding differently after 47,994 of 1,000,000 records. A change rolls as 5.14: every copy moves onto code that can run both versions (DEP-10 refuses a roll in which two copies would fold differently), the new version is appended once every copy can run it, and every copy switches at that position; a copy that cannot run it refuses to serve the group (5.9 step 8). The cost is one entry per group and the roll itself, nothing per record, unless the change needs a rebuild (a view whose output depends on the records, not the rows: E-43's `sum`), which is a refold per copy. With PA-1, the record format joins the fold version, so a format change is such a roll too.

## 6. Every finding in one table

The ids keep the first version's order, which ranked the findings by gain against v4's habits; section 0 ranks them again against the lean column, the design as written and built well. "Design" means a rule, the record format or a mechanism changes, for the owner to decide (section 7.1). "Build" means only how it is built (section 7.2). "Rules" counts rules a builder must get right, as [SIMPLICITY](SIMPLICITY.md) counts them; each fix was checked against SIMPLICITY 3.1's records, MEMORY 9.4's list for answer stages, and E-48's W1, O.seq and Y. "Walkers" names the four walkers' own ids that this finding merges (WP: writes, RP: reads and flow, U: upkeep, CP: the costs every path pays). Measured numbers give the range across this page's rerun and the walkers' first runs (section 8 says why they differ).

| Id | Paths | The waste | Size | The fix | Design or build | Gain | Rules and risk | Evidence | How sure | Walkers |
|---|---|---|---|---|---|---|---|---|---|---|
| **PA-1a** | 2.3, 3.1, 3.8, 4.5, 4.8, 5.1, 5.3, 5.8, 5.9 | Every receiver checks v4's crc32c in JavaScript, up to 12 passes a write; a native checksum called per record is no faster | crc 2.2-2.9 ns a byte; a 1 MiB write's checksum on its path 23-26 ms in v4's habits, 4.9-11.8 ms lean; 24.1 s of E-34's 10 GB wake | One checksum per batch on CRC-32/IEEE, by Node's native `zlib.crc32`, made where the batch is made, checked once per receiver and reused by the journal. Coverage: the batch checksum covers the term, the base offset, the group and the writer time; the journal row header has a small checksum of its own and keeps the predecessor chain (V3-8); only the wire's per-link fields (previous index and term, commit index) sit outside, under the frame header's checksum | design (the record format, DEV-09) | **large and robust**: 0.2-0.5 ns a byte on every row shape; a 1 MiB write 2.6-3.3 ms on its path; the 10 GB wake's checksum 2.8-4.9 s; about 2 µs off a busy small-row write | +1: every byte that boot, `par` or `disk-incarnation` trusts sits under a checksum. A term or offset outside every checksum would flip unseen (Kafka keeps its base offset and leader epoch outside its CRC: a known weak spot, not a model; from memory). E-37's check, with "entry" read as "batch", must include a damaged header. Browsers have no native CRC: slice-by-8 in JavaScript, 1.2-1.3 ns a byte | measured here: write/crc, upkeep/b1; E-34; E-37; DESIGN-V5 4.1 | high | WP4, U1 (part), U6 (checksum), U8 (frame checksum) |
| **PA-1b** | 2.3, 3.1, 4.5, 5.3, 5.6, 5.9 | Every copy and client decodes every record with v4's hand-written decoder (a `TextDecoder` and a subarray per string, a `DataView` per float); snapshots too | per record, kept as a fold keeps them: 2.92 (2.78-3.11) µs a small row, 5.41 (5.01-5.73) µs a 2 KB row; a field record, which a fold does not keep (only its value), 0.43 µs (406 ns in B8's hot loop) (b3, B8) | A binary envelope (key, slot, sequence, attempt id) with the value as JSON text, and a tagged escape for NaN, ±Infinity, -0, `undefined`, big integers, bytes and user keys equal to the tag: a walk of the value at encode sets a per-record "has escapes" flag, and only flagged records pay a reviver. Snapshot rows in V8's own format, which is the lever for wakes of big rows. The fallback that keeps v4's format: a short-ASCII string path | design (the record format, DEV-09) | **depends on the shape**: kept, about 55 % less decode time on a small row of many short strings, about 6-7 % on a field record (not kept: a fold keeps only its value), about 10-27 % on a 2 KB row, less as the heap grows (V8's format about 43-53 %); with PA-1a, the 10 GB wake from about 94 s to about 51-64 s with snapshots in V8's format, 64-75 s with JSON values (reasoned) | +1: the escape rule; the format joins the fold version in force, so E-43's two-versions check runs again, with a fuzz over every value class (non-ASCII, astral, numbers ≥ 2^53, non-canonical bytes). The walk at encode costs 6 ns for a number, 59 ns for a small row and 74 ns for a 2 KB row; a reviver on a flagged small row costs 4.6 µs (B9). Byte values grow a third in base64 (E-45 F3) or take a binary side section | measured here: core/jsonval, core/field, core/escape, upkeep/b2, upkeep/b3; E-34; E-05 (JSON replay 21 against 36 s per GB) | high on the parts; medium on whole paths | CP2, WP7, U1 (part), U5 (a) |
| **PA-2** | 2.2, 2.4, 2.8, 3.1, 3.3, 3.11 | v4 sends each flush through libuv's pool twice and copies each row twice; as drawn every flush takes one pool hop. (Sending before the leader's own fsync is already the design's text, DESIGN-V5 4.2: a build trap, not a finding) | per flush per copy: v4's two pool hops 104-108 µs of CPU and 194-204 µs p50; one pool hop 67-83 µs and 167-198 µs; a journal thread of its own 66-72 µs and 142-158 µs; in place 30-33 µs and 112-113 µs. Quiet, the flushes are about half of a write's CPU | One hop off the kernel thread, the default (one pool hop, or a journal thread fed through a `SharedArrayBuffer`: about the same on the rerun's host); never v4's two; no row copies; batches cut when the disk is free. Whatever the thread, the durable mark is the file offset at the fsync's start. In place is an option, not the default, and only behind its guards: (1) the run's corked `APPEND`s leave first (uncork, or fsync in a later macrotask), else the sends follow the fsync and a commit waits for two fsyncs in a row; (2) never on a process whose journal may get a batch holding a `replicated` write: MEMORY 9.4 needs each batch handed to the OS as it arrives, with the fsync in the background, and an in-place fsync blocks every write on the thread while it runs, so a batch that arrives meanwhile reaches the OS up to one fsync late; (3) after one slow flush, use the hop: a sync call cannot be cut short once it has started, so the first of E-01's 20-50 ms stalls, or a 0.25-0.9 s flush behind bulk writes, blocks the thread F-14 keeps free in full, and only the flushes after it move; (4) a simulator monitor that no commit waits for two fsyncs in a row | build | medium: per copy per batch 25-37 µs of CPU off v4's two hops (B10: the second pool hop adds about 19-26 µs; fsync against fdatasync makes no clear difference, -11 to +3 µs); in place a further 34-53 µs of CPU on an idle box, weighed against the first stall it cannot avoid | 0 design rules. Raft counts the leader only after its fsync; E-48's two marks unchanged; MEMORY 9.4's "the leader counts its own copy only once handed to the OS" holds (the `writev` stays on the kernel thread). The durable mark adds nothing: it is SIMPLICITY's `journal` rule 2 ("An fsync covers only bytes written before it began; an entry waits for one that began after its write"). In place, if taken, adds +2 build rules (guards 1 and 2); guard 3 is a speed fallback and guard 4 a test | measured here: core/sys, core/sys2, core/jthread, write/hop; E-01; E-10 (`AsyncStorageWrites`); E-02; code: shell/runtime.ts:801-866 | high on the costs; in place's tail risk reasoned | WP2, WP11, CP1 |
| **PA-3** | 2.2, 3.1, 3.11, 4.2, 4.5, 4.7, 4.15, 5.14 | Work that needs only bytes crosses to the main thread and waits for its event loop: a relay forwards through main; the `ANSWER` leaves main after the fold; a client runs a kernel worker it does not need; every delta waits for the serving copy's fold and main loop | quiet: up to 5 avoidable crossings, about 106-110 µs of CPU and 105 µs of time per write; under load up to 3 main-loop waits of 1.5-14 ms at p99 on a write's path and one on every delivery; a 5 s main stall stops every subscriber | (a) Client links off main: on a link-and-flow thread of their own (one crossing where they meet the member links, 21-22 µs of CPU quiet and 27-40 ns a record busy: still one fewer than through main), or on the kernel worker only behind a TLS terminator (A-11) and a per-tick budget for handshakes and socket writes. A relay forwards bytes; the answer leaves the worker at commit (main tells the worker each write's outcome when it judges it); a client process has no kernel worker. (b) Deltas from the committed bytes, after the subscriber's snapshot position, for resource, partition and prefix selectors; the fold still gates `END`, snapshots and conflation, and `view` selectors and methods' live views keep one shared encode per view change | (a) build; (b) design (one subscribe rule) | **large** at p99; medium at p50 | (a) 0 rules on a link-and-flow thread of their own; +1 (the per-tick handshake budget) on the kernel worker. Either way a price to choose: client load must never starve Raft's thread (E-39: 10,000 TLS reconnects took a thread 0.8 of a core for 7 s, delivery p99 27-45 times steady; E-08: 8-14 µs a subscriber write); time a storm while heartbeats run. A client's stall delays only its own link. (b) E-31's "a record only up to its fold" becomes "up to the commit this copy holds": E-31's 26-rule model runs again, with a `view` selector, a reloading or unfolded copy (`rec.loaded` still gates: nobody answers from an unloaded fold, most of all with PA-16) and a join inside a shared frame (it needs its own cut). Routing by partition needs the partition without user code: a partition hash in the header (bytes against E-19's 4 B bar) or a key decode: 0 to +1 rule. RR-17 kept; Y holds | measured here: core/hopcpu, write/hop; E-07; E-08; E-31; E-39 | high on the parts; the total not run | WP3, CP4, RP4 |
| **PA-4** | 3.1, 3.3, 3.12, 4.3, 4.4, 4.11 | Route-forward sends every write, `fresh` read and `none`-rung publish through the client's own server, which leads about 1 group in 3 | one RTT on about 2 of 3 writes: 40 µs p50, 96 µs p99 on loopback, a real RTT between machines; about doubles `received` | Send straight to the leader when the client has a link to its server (V5-3 already hands out the slot table and the leaders); open links to servers it writes often; forward otherwise (browsers, one-link clients); `SUB`s and `fresh` reads to a linked copy | design (a routing rule) | **large** (latency) | 0 to +1 rule. The forward path stays for browsers, so `forward.once` stays written and tested in any case (E-20: "Browsers stay fwd ... so these rules are written and tested in any case; smart only takes them off the path of server clients"); a direct send adds the client's leader table, its choice between direct and forwarded, and `moved` on a direct send. Each extra idle TLS link holds 49.7 KB at a server (E-27) | E-01; E-20; E-27 | high on the cost; the share across machines not measured | WP1, RP14, RP17 (part) |
| **PA-5** | 2.3, 3.1, 3.5, 3.8, 4.5, 4.7, 5.1 | v4 encodes a committed record again for each member link, its WAL, each relay hop and each subscriber, sends one control frame per change per subscriber in method streams, and re-encodes every entry from objects to serve a catch-up. Encode once is already the design's text (DESIGN-V5 4.1, 8): a build trap | 1.7-2.4 µs per small row per extra encode, about 5 extra per write; with 1,000 subscribers about 2.4 ms of CPU per record; a method stream 4.4-4.6 µs to serve and 4.4-5.5 µs to apply a change | Encode once at the origin. The leader decodes a plain write strictly and copies its record bytes from the `ASK`, with the slot sequence in front, only if they are the canonical encoding (a length check and a strict decoder: no overlong lengths, duplicate keys, trailing bytes or bad UTF-8); else it re-encodes. One batch to every follower and the journal by `writev`; a `DELTA` is the log's bytes, or the chosen records copied, for selectors bytes can route (PA-3 b); method streams ride the same flow | build (+ one `ASK` layout rule: the record whole, conditions and ops apart) | **large** at fan-out (per delivery 2.1-4.6 µs → 0-0.46 µs); medium per write; but against the design as written, a trap avoided, not a gain | +1: the canonical check. Untrusted bytes copied as they are would reach every copy and every reader version, each parser deciding what they mean (a parser differential, E-43); v4's re-encode at the relay made them canonical (code: kernel/write.ts:41-45). E-43's fuzz covers them. "Results only" (DESIGN-V5 4.3) holds, since a plain set's result is the request's record; ops still encode their value | measured here: write/codec, reads/route, reads/substream; code: kernel/node.ts:1224-1257, kernel/write.ts:877, kernel/scope.ts:728; E-08 | high | WP5, RP2, U8 (re-encode) |
| **PA-6** | 3.8, 4.7, 4.15, 5.1, 5.3, 5.5, 5.6, 5.14 | Bulk bytes (catch-up, install, a move's copy) and big records ride the one member link per machine pair and the one disk, in frames up to 4 MB | a 4 MB frame holds a 1 Gb/s link 34 ms ahead of every live frame (computed); big records raised other groups' commit p99 1.18-1.59 times (E-35); a 4 KiB fdatasync beside bulk writes waited 250-300 ms at p50 and up to 0.9 s (E-01) | A byte-rate cap on bulk work, on both the link and the disk writes; on the link, bulk cut into chunks of 64 KB or less queued behind live frames, with other partitions' frames between a big record's cuts. Not 64 KiB journal batches, which made victims worse (2.2-3.9 ×), and no side file for now: E-35's `blob` helped victims a little (1.12 ×) but made the big records 4 times slower, and E-35 judged it "not worth a mechanism now"; a journal per tenant still gave 1.30-1.36 × "because the tenants share the disk". A side file stays optional until 7.3's catch-up-beside-live-writes run shows it helps | design (a cap on bulk work) | **large** (p99 of live writes during any heal, catch-up, move or roll) | about +1 (the cap); +2 more only if a side file is later taken (named before the ack; the recorder references it). Raft safety holds: a follower acks only what is fsynced (reasoned) | computed from link speed; E-35; E-01; E-13 (catch-up 150-290 MB/s) | medium | U2, U14, RP12 |
| **PA-7** | 2.3, 2.7, 5.1, 5.4, 5.7, 5.9, 5.12 | Every entry is written twice to each disk (journal, then its group's segment) with a second fsync stream; the journal and segments overlap at boot; the recorder's window is held twice; files per group cost 12 KB and 3 inodes per resource | disk write bytes × 2; a second flush stream (E-12: a striped journal's p99 5-24 times worse at moderate load); the recorder's window 441 GB a day at 50,000 appends a second, twice | One shared log per process with an index per group (E-49's shared segments; TiKV's raft-engine, from memory); an upload gathers a group's extents (0.05 ns a byte); records describe themselves (magic, length, group, offset, a header checksum) so boot can resync past a damaged record and `par` knows its group | design (L0's journal mechanism) | **large** (bytes): disk writes and the recorder's disk halved | about +4 to +6. E-49 counts shared segments at about 4 (3-5): a shared file goes only when no group needs a record in it; an index swaps only after its copied records are fsynced; the tier uploads one group's records cut out of the shared files; a dropped resource's records are only marked dead until compaction frees them (E-49, "The cheapest forms"; forks ride `forks` rule 5). +1 for the resync: with one log kept for the whole retention, a damaged header would otherwise make every later record of every group suspect (DESIGN-V5 4.1 warns of it for the journal today). PA-7's model must include a damaged record in a shared file. A lagging group's records are copied forward (bound it by snapshotting that group). Touches `journal` (16 rules) and `tier` (10) | DESIGN-V5 4.1; E-12; E-42; E-49 ("The cheapest forms", sections 1 and 5) | medium | U3, WP15 |
| **PA-8** | 4.1 | `f.snapshot` builds a new `Map` and a new object of every row on every read | one row read: 87-89 µs at 1e3 rows, 30-33 ms at 1e5, 0.47-0.53 s at 1e6, against 43 ns-1.2 µs for a `Map`; two containers of every row of garbage per read | Make property reads one lookup: a read-only view over the store, the dense object built only when enumerated, a `copy()` for a frozen picture. Or keep `snapshot` whole (v4's meaning: stringify and discard) and move API.md's row reads to `f.data` | build in fero and `data`, or docs: an **API point for the owner** | **large** | 0 rules (DATA-07 holds by the lazy freeze). A view changes under a program that keeps it across an `await` | measured here: reads/local-read; code: api/index.ts:1289-1296; E-06 | high | RP1 |
| **PA-9** | 4.12, 2.8 | Each process renews its `#sessions` lease as a persisted write, and every group writer decodes every renewal to learn lapses | about N / 3.3 commits a second (3,000 at 10,000 processes) and their decode at every following process (reasoned) | Keep renewals in the memory of `#sessions`' leader; log only the lapse; a new leader gives every lease a full `session.ms` | design (a rule) | **medium**: 3,000 tiny commits a second at 10,000 processes share group commits and are about 6 % of a 50,000-a-second budget; their decode at each follower of `#sessions` costs a few ms of CPU a second (reasoned). Large only with hundreds of thousands of processes, or many group writers following `#sessions`. It also shortens the replay window and the `#sessions` log | Sessions still expire by writer time on a logged lapse; a longer lease only keeps outcomes longer (safe; E-20). E-22 D10 already gives every lease one `election.ms` at a new leader; this lengthens it to `session.ms`, so a lapse at a failover can take up to one `session.ms` more (P-13 read to the letter; VERDICT 8 item 20 names it). No interaction with E-48 or MEMORY 9.4 | reasoned; API.md Q-A28; etcd (from memory) | medium | RP3 |
| **PA-10** | 2.5, 2.6 | v4's kernel keeps a second copy of every cell (state, versions, entry hashes, ancestors) and runs a sorted stringify plus fnv on every applied value, for a hash only the debugger and the simulator read | about 2 µs a record on every copy and client (1.8-2.6 µs; 29-34 % of v4's per-record CPU); a second map of every cell | One row store per process (`data`'s); the v5 kernel holds no rows (LAYERS 1.4); F-21's divergence hash as a background job over bytes (E-05: 259 ms per million rows) | build | medium-large | 0 rules; F-21 keeps its check; the simulator hashes `data`'s rows itself | measured here: core/api profiles; code: kernel/node.ts:2813-2870, 3101-3116; kernel/diag.ts:156, 275, 283 | high | CP3 |
| **PA-11** | 2.5, 2.6, 3.6, 4.5, 4.15, 5.1, 5.12 | Work done per record that could be per batch: a lane call per record (code: api/substrate.ts:160), a new buffer per record, a native checksum call per record, a Raft entry and a `par` unit per record, a control frame per change | a lane call per record 0.62-2.63 against 0.22-1.90 µs (11.4 against 0.98 µs with a `group` view); a buffer per record 0.7-0.9 µs against about 22 ns; a native checksum per record about 200-230 against 20-50 ns | One Raft entry per batch with a base offset (as Kafka's and Redpanda's record batches, from memory); one checksum, one lane call, no buffers or log objects per record; `par` repairs a batch | design (the Raft entry, `par`'s unit) and build (the lane) | medium (CPU per record on every log path) | 0 new rules: E-37's model is unchanged with "entry" read as "batch"; a repair fetches up to 1 MB | measured here: upkeep/b1, reads/substream; E-05 | high | U6, WP7 (lane), RP2 (control frames), CP5 (part) |
| **PA-12** | 2.3, 3.1, 4.5, 4.6, 4.7, 5.1, 5.4, 5.9 | Steps decode what they do not read: the relay decodes for a `validation` the writer redoes; a serving copy decodes each key to route; a follower's kernel decodes keys before storing; a segment's partition index decodes every key at seal; records carry no length, so even a scan walks every value | a full decode 2.7-3.2 µs a small row; a key 0.5-0.8 µs (1.3-1.6 µs inside a batch read); a boundary scan 0.26-0.34 µs; a slot test 1-4 ns | Put the slot (E-19: +3.9 B) and a length (+1-2 B) in each record's header; route, filter and index by slot from headers; `validation` at the writer only; workers read batch headers only, with a per-batch flag for configuration, move and snapshot entries; no per-partition segment index unless a test needs it. The leader folds the committed bytes like every copy (one more decode, 1-3 µs a row), unless a simulator check shows decode(encode(v)) deep-equals v for every judged value, plus F-21's hash | design (a format rule; DESIGN-V5 4.5's "validation where a write first enters" changes) | medium (CPU per record per serving copy; relay latency) | 0 to +1. E-19's bar is 4 extra bytes a record and slot positions take 3.9, so a length goes over it unless the sequence is implicit (+1.9 B, E-19's option). Lost: an early refusal at the relay, for invalid writes only. A custom partition function still needs a key read. The leader's shortcut of folding the objects it judged is +1 (its check) and would otherwise let the leader's fold drift from the followers' wherever decode(encode(v)) is not v (the escape, -0, NaN, big integers, an op's value), the drift fold-all and F-21 exist to catch | measured here: write/codec, reads/route, upkeep/b2; E-19; F-21 | high | WP6, RP6, U8 (headers only), U13, RP15 |
| **PA-13** | 2.3, 2.5, 2.6, 3.1 | Garbage per record, and the client's issue: a deep copy of the value then an encode; an eager Promise per bare assignment; a subarray and a string per decoded string; a `DataView` per float; key strings and log objects per record | v4 makes 7.1-8.1 KB of garbage per small-row record (2.4-4.8 KB for a number); the collector is 12-24 % of v4's per-record CPU; the copy 0.36-0.44 µs | Encode at issue and keep the bytes for resends; a Promise only when awaited; a short-ASCII string path (91-127 → 57-66 ns a string); floats read without a `DataView` each; no per-record key strings | build | medium | 0 rules: V4-52's reason (the program may change its object later) is met by bytes; the decoder's output must match `TextDecoder` (a fuzz) | measured here: core/alloc, core/api, write/strdec, write/codec | high on v4's numbers; the lean target (under 1 KB a record) reasoned | CP5, WP14, WP7 (decoder) |
| **PA-14** | 5.2 | Every full copy encodes its changed rows on the main thread to cut a snapshot layer | 3 copies × 2.4-2.6 µs a row with v4's codec (1e6 rows hold main about 2.5 s unless sliced); 0.41-0.71 µs with a native serializer, still on main, still 3 times | (a) A native serializer, sliced (PA-1b's format). (b) Later, cut layers from the log's bytes on the worker (per row, the last whole-row record and the field records after it): no main-thread work, byte-identical across copies, one upload, a free F-21 check | (a) build; (b) design (the snapshot holds compacted records) | medium (main-thread CPU and stalls, × 3 copies) | (b) 1-2 rules and a real risk: the worker's "a whole-row write replaces the row" must equal `data`'s fold (DATA-09's differential test must cover it); L2's tables still come from main | measured here: upkeep/b2; E-05 | high (a); medium (b) | U5 |
| **PA-15** | 5.5 | A slot move copies the slot's rows into the target's log even when every target copy already holds them | the slot's state sent 3 times, written 3-6 times, folded 3 times (a 4 GB group's split: about 72 s of fold per copy at v4's replay rate, computed), against about zero | Move by reference: B names A's newest layer for s and A's segments up to N, as a fork does; switch the merged view's owner at `open`; B's next snapshot takes s in; a copy of B without A fetches by the reference. Until that snapshot, B's writes and removes hide A's rows in the merged view, and A keeps s's rows and segments pinned | design (the move's copy step) | medium (bytes and background load; a rare path) | +2 to +4: 1-2 for the reference, plus L2's masking of A's rows and their pinning against A's drops and compaction. On the study's biggest modelled mechanism (`slot-move` 13 rules; E-15's mutants caught only 39 %): E-15, E-17c, E-32, E-23 (merged views) and DATA-09's differential test must run again. DESIGN-V5 4.2's "Views mid-move" assumes B holds its own copy | reasoned from DESIGN-V5 4.2, SIMPLICITY 3.1 `forks`, E-23; E-05 | medium-low | U4 |
| **PA-16** | 5.9, 5.6, 5.14 | A restarted copy folds everything before it rejoins Raft, so it cannot vote or ack meanwhile; this runs at every roll step | 22-94 s under-replicated per restart at E-34's sizes, on every deploy | Vote, take appends and ack as soon as the log is open; fold behind; do not stand for leader until folded | design (+1 rule) | medium (large for big resources in rolls) | 1 rule (a copy whose fold is behind does not stand). A whole-cluster restart waits for a fold before anyone stands, as today; PreVote keeps it from unseating a leader. Deltas from bytes (PA-3 b) must still never be served from its unloaded fold (E-31's `rec.loaded`) | LAYERS 8.5; E-34 | medium | U7 |
| **PA-17** | 4.5 | A prefix partition's first picture scans every row, and is encoded once per subscriber | 26-28 ms per new subscriber of a 100-row room at 1e6 rows (2.8-3.2 ms at 1e5) | An in-memory index partition → rows for prefix and function partitions; a picture encoded once per (selection, position) and shared | build | medium (large in a reconnect storm): 0.47-0.74 ms; 4.7-7.4 µs each when 100 share it | 0 rules: the index and the cache are memory only, never served as rows. But the index lives on every full copy (fold-all): memory per row and an update per fold, on every copy. It must not be `data`'s `group` view until DATA-05 is fixed (146-182 B a row, 2,574 µs a record at 1e6 rows, E-05) | measured here: reads/snapshot-serve; E-05 | high | RP5 |
| **PA-18** | 4.13 | Waiting queue takes follow the queue, race to claim each new row, and poll once a second for lapsed leases | N - 1 wasted claims and a wake RTT per enqueue with N waiters; a claim per waiter per second | Park a waiting take at the writer, in memory; the writer claims for the oldest parked take when a row becomes takeable (an add, a `nack`, a lapse by writer time), in the same batch, and answers after the commit. The claim is appended under the waiter's own attempt id (its session and sequence), so a take resent after a lost answer finds its outcome in dedup | design (a rule in `queue-claims`) | medium | +1. The claim stays a logged lease (at most one live lease); a parked take is memory only, lost at a leader change and sent again by the client; W1 holds (answered only after the claim commits). A claim under a writer-made id, its answer lost at a leader change, would let the resent take claim a second row: a double delivery. E-22's P-09 and P-22 checks run again, with a lost answer at a leader change | reasoned; E-22 D6 | medium | RP7 |
| **PA-19** | 4.9 | A derived resource waits for each output's commit, and reads its source over the network even when its own process folds the source | about one source record per commit latency (about 250 a second at 4 ms); a hop and a decode per record | Pipeline the outputs (the one writer keeps the order the marks need); read the source in-process, handing `fn` decoded records; fold the source only if `fn` reads `e.row` | build | medium | 0 rules: E-30's 5 rules hold | reasoned from E-30, E-02 | medium | RP9 |
| **PA-20** | 3.9, 3.10, 5.14 | Retries back off from 200 ms where a slot move's or a planned handover's window is a few ms; a roll puts every led group through 2-3 handovers | ≥ 200 ms against a 2.7-16.7 ms window, at every roll step | DESIGN-V5 4.3 already gives `no-writer` and `moved` answers a retry-after; let a retry-after of the window's expected rest count below the 200 ms floor. After a link loss, resend at once only when the new link reports a live leader for the slot; otherwise keep the floor | design (a rule on the retry-after) | medium for the writes caught, on every roll | 0 to +1: A-02's "refuse at once, never hold" kept. The floor exists for elections (DESIGN-V5 4.3: "so an election never brings a retry storm"), and a plain link loss and an election often coincide, since the dead server led groups. A storm test as E-39's | E-13; API.md 4; DESIGN-V5 4.2, 4.3 | high on the gap | WP8 |
| **PA-21** | 2.4, 3.2, 4.4 | The cold first write runs discovery, the link, the session's commit, the slot-table `SUB` and the follow one after another, and the writer may not yet know the session lives | 7-9 RTT plus two commits in a row before the first write commits | Register the session when `fero()` opens, beside discovery; one flight after the door with the session, the slot-table `SUB` and the follow (or members, leaders and the run-length table in the welcome); skip the directory when the seed serves R; the first write carries the registration's position, and the writer waits only if behind | build | medium on the first operation | 0 of E-20's rules change; the wait on a position is reasoned, not modelled | E-40 (13-17 ms cold in a browser); E-20; E-36 | medium | WP9, RP17 |
| **PA-22** | 2.3 | v4 writes every string's length in 3 bytes so one pass needs no sizing | 28 of a small row's 139 B; 4 of a field record's 18 B | A 1-byte length for strings of up to 42 UTF-16 units, still one pass; the decoder reads any varint, so it reads both | design (a format rule) | medium (bytes on every link, journal, segment and tier object) | 0 rules; with PA-1b it applies to keys and the envelope only | measured here: core/codecbytes (round trip checked: 139 → 111 B, 18 → 14 B; decode 7-14 % faster) | high | CP6 |
| **PA-23** | 2.3, 3.1 | Every v4 frame carries its origin and its issuer as 36-character strings | a 99 B envelope; a one-write frame 238 B, 42 % envelope: every quiet `ASK` and `APPEND` | Name a peer by a number fixed at `HELLO` (known through the door) and a writer by its session's number from `#sessions` | design (a format rule) | medium for small frames (238 → about 160 B, reasoned) | E-20's dedup keys on (session, sequence): a session number is the same key; never reused within a session's life; a restore takes a new session generation (E-33) | measured here: core/codecbytes | medium | CP7 |
| **PA-24** | 3.7 | A saga makes 6-7 persisted commits in a row on the caller's path | about 7 ms at the median in TypeScript, against a bound of 2 commits | Answer after `done` and release the locks after; run steps on different partitions together | design (library steps) | medium (a rare path): 7 → 5-6 commits | Release after the answer keeps E-24's rules; steps together need E-24's model run again; the deep cuts change 38 model-checked rules: not advised | E-24; SIMPLICITY 3.1 | medium | WP10 |
| **PA-25** | 3.4 | A method call forwards each handler write the reached server does not lead | one RTT per such write (about 2 of 3 groups with 3 servers) | Route a call to the leader of its key's slot (a hint such as `partition(arg)` on the method) | design (API) | medium for calls | API.md says running at the writer is not the safety, so this is placement for speed only; the owner's API review decides | E-01 | medium | WP16 |
| **PA-26** | 2.4, 2.8, 3.11 | A fixed batch tick fires on an idle process; pings go out on links that carry traffic anyway | a 1 ms tick costs 5-6 % of a core per idle process; ping frames on every pair (19,800 a second at 100 members, E-25) | Cut batches at the end of a turn or when the disk is free; ping a link only after `ping.ms` with nothing sent | build (the tick); design (one rule of `link-pings`) | small-medium | Failure detection unchanged: any frame resets the silence timer | measured here: core/sys; E-02; E-25 | high (tick); reasoned (pings) | CP8 |
| **PA-27** | 3.1, 3.3, 3.10 | An `ANSWER` travels through the relay when the relay and the client fold the group and see the attempt id in the batch anyway | a frame and its crossings per write | Settle from the attempt id in the folded batch (v4 does: code: kernel/write.ts:54-57); `ANSWER` only for refusals, dedup hits, early stages, results that carry a value (`incr`, 3.12) and callers that do not follow | build | small | 0 rules: a committed record of the attempt is final whatever copy committed | code; API.md 4 | high | WP12 |
| **PA-28** | 3.3 | Followers would send an early receipt on every batch for `replicated` | a small frame per follower per batch | A flag on the `APPEND` when a batch holds a `replicated` write | build | small | 0 rules: the early report feeds answers only (MEMORY 9.4) | MEMORY 9.4 | high | WP13 |
| **PA-29** | 2.7, 4.15 | L2 judging and L3 flow run on main, outside the kernel's tape, and two threads interleave | a coverage gap: a judging or subscribe bug cannot be replayed (OPS-11) | Record each crossing's arrival on main as one tape event per batch; record a forwarded `ASK` whole at the relay and the leader | design (the recorder's format: +1 rule) | small cost (under 1 % of a core more), for replay coverage | must stay per batch | E-42; reasoned | medium | CP9 |
| **PA-30** | 4.3 | Each `fresh` read takes its own majority round at the leader, and its row crosses between servers | one majority round per read; row bytes per read | Batch ReadIndex per tick, riding the next `APPEND`; serve at a follower copy once it has the read index | build | small-medium | 0 rules (etcd's ReadIndex, TiKV's follower read, from memory); a lease read is not proposed (E-21) | E-46; E-09e | medium | RP8 |
| **PA-31** | 4.1 | `f.data.x` allocates a child handle and a `Proxy` per path step | 4-14 times a `Map` read: 0.54-5.2 µs against 43 ns-1.2 µs | Cache child lenses, or hand out the frozen row for a plain read | build | small-medium | 0 rules | measured here: reads/local-read | high | RP10 |
| **PA-32** | 4.4, 4.5, 4.7, 4.8 | Every receiver checks the frame checksum again on a TLS link whose server already checked the bytes on read; browsers do it in JavaScript | 0.3-0.35 µs a small row; 1.2-2.9 ms a MiB in a browser | Skip the check on TLS links; keep it on plain TCP | design (a link-level choice; optional) | small (medium for big rows in browsers) | Loses an end-to-end check against a server's own memory faults between its read check and the socket | measured here: write/crc, reads/route | medium | RP11 |
| **PA-33** | 4.14 | Under `run()`, the `#groups` cursor commits per batch though the marks already make re-reads harmless | a commit on another resource per batch | Write the cursor lazily, every few seconds | build | small-medium | E-30's order rule (the cursor after the outputs' answers) kept; a crash re-reads more | E-30 | medium | RP13 |
| **PA-34** | 2.4, 4.4, 4.5, 4.15 | API.md checks a token on every record a relay, a prefix, a view or a method's view forwards | a check per delivery | Check once per (subscription, partition); cache it until the token or the selection changes | build (API.md 4's wording) | small | A revoked token must end its subscriptions at once (a rule the cache keeps) | API.md 4 | medium | RP16 |
| **PA-35** | 4.10 | A time index per segment is not needed; V5-4 says "the log's exact order" within a resource, which has one order per group | a time index's work per record; a wording gap | Binary search by `t`; merge by batch headers only; say in V5-4 that a resource's groups merge by `t` too | docs | small | none | DESIGN-V5 4.3; A-23 | high | RP18 |
| **PA-36** | 5.3, 5.8 | A row changed in k snapshot layers is decoded and folded k + 1 times on install and restore | k + 1 decodes of a churned row | Merge layers by key (newest wins, markers drop) before folding; keys sorted within a slot | build (+ a format rule) | small | 0 rules | reasoned from DESIGN-V5 3.4 | medium | U9 |
| **PA-37** | 5.8 | A restore LISTs instead of reading a manifest, and writes its mark before it fetches | one or two store RTTs (about 30-60 ms on S3), on an admin path | One PUT for the mark and the session generation, beside the GETs; a manifest object per group | build | small | 0 rules: E-33 asks only that the mark be written before any use | E-28; E-33 | high | U10 |
| **PA-38** | 5.13 | A new leader builds the expiry heap by scanning rows with a time-to-live before it serves | O(such rows) at each failover | Keep the expiry index warm on every full copy from its own fold | build | small | 0 rules; a little memory per copy | reasoned (the expiry tick is not built yet) | low | U11 |
| **PA-39** | 5.10 | A dormant group's wake runs a full election | about 1-2 ms of E-26's 3.3 ms | The copy that led when the group slept resumes its term | design (a Raft rule) | small | **Not recommended**: a Raft change for under 2 ms against DEP-04's 1.5 s | E-26 | medium | U12 |
| **PA-40** | 3.12 | The RESP gateway makes a command wait for the previous one on the same key from the same connection: E-45's workaround for writes in flight committing out of order | at `-P 16` on one key, 16 commits in a row per connection: about 15.5 ms per pipeline against about 1 ms for one shared commit (computed from MEMORY 9.3's committed p50) | Once E-48's O.seq is built (the library keeps issue order per process and partition, and refuses a gap), the gateway pipelines a connection's writes: one frame, one batch, one commit, replies in order. The chain stays for reads: a `GET`, or any command whose reply reads the row at G, still waits for that connection's in-flight writes to its key, since Redis runs a connection's commands in order and a fero write shows only at commit (V4-7; rule Y covers only early-answered writes) | build (L5) | **large** for PERF-02's pipelined `SET` and `INCR` rows | 0 rules of its own, but it waits on O.seq, which E-48 says every row owes (A-10) and SIMPLICITY counts in no row's total, the base's 405 included (`issue-order`, 3 rules, kept apart) | E-45; E-48; MEMORY 9.3; SIMPLICITY (`issue-order`) | medium | (new: the skeptic's check) |
| **PA-41** | 5.14, 5.9, 5.13 | Leadership is handed back at a fixed ten a second per member after `settle.ms` (30 s), so after any restart a member's preferred leaderships stay elsewhere for 30 s plus R/3 ÷ 10 seconds | about 1 min at 1,000 resources a process, 6 min at 10,000, 56 min at 100,000, after every restart and every roll step (E-49 section 6, from DESIGN-V5 4.2); the fixed pace is the R/30 s part | Hand back by batches that share frames and fsyncs, paced by load rather than by a fixed count, and busy groups first: a quiet group's leader can wait for its next wake | design (a rule's pacing) | medium at 10,000 resources a process and more; small in the owner's likely range | 0 to +1: "no take in one tick" kept | DESIGN-V5 4.2; E-49 section 6 | medium | (new: the skeptic's check) |

**Already right, and must stay** (each is in the design or in v4 today; losing one would cost the size named): one TLS write per link per event-loop turn (8.7-9.6 µs a message alone, 0.58-0.60 µs in a batch of 64: measured here); signatures checked once per link (a per-write check would cost 77-112 µs, about one to three times a whole lean write at 50,000 a second, 40-87 µs: measured here, 2.9); bytes in batches across the thread seam and the native seam, never objects (E-07, E-03); one journal per process with group commit (E-12: 2.0-6.6 ms p99 against up to 854 ms for files per group); one Raft entry and one run of attempt ids per frame; judging on the log end, so a hot key pipelines (MEMORY 9.3); answers only after commit (A-04); `data`'s fold in batches (E-05); the recorder's journal references (E-42); resume from a cursor, not a download (E-31); a near-cache miss that is itself the `SUB`; the door and the first `SUB` in one flight (E-40); one write per socket per tick and per-room coalescing (E-08, A-11); rows frozen once when handed out; incremental snapshot layers; retention by whole files; `par` from any peer (E-37); dormant groups for idle resources (E-26, E-49).

**Build traps the design's text already avoids** (not findings against the design; tests for the first slice): the leader sends before its own fsync (DESIGN-V5 4.2: it "writes its own journal in parallel"; LAYERS 8.2 step 5; E-02's pipeline; E-10's `AsyncStorageWrites`), which an in-place flush in the same run as the corked sends would undo (2.4); encode once, the same bytes the journal row and the wire (DESIGN-V5 4.1 and 8: "encode once, `writev`"); one lane call per batch and no per-record objects (DESIGN-V5 8: "header-only decode, no per-record objects"; E-05). A builder who ports v4's code would bring each back (code: kernel/node.ts:1224-1260, kernel/write.ts:877, api/substrate.ts:160).

## 7. What this asks of the design

### 7.1 Changes for the owner to decide

Each changes a rule, the record format or a mechanism. "Records" are SIMPLICITY 3.1's mechanisms it touches; "rules" is the change in the count of rules a builder must get right (reasoned here unless a model is named), with the guards the check added counted in; "model" is what must run, or run again, before it is built. The base has 405 rules (SIMPLICITY 0). Rows follow section 0's order: gain against the lean column, weighed by how sure it is, how many paths it touches and its rule cost (the Gain column gives each gain alone).

| # | Change | Kind | Records touched | Rules | Model before building | Finding | Gain |
|---|---|---|---|---|---|---|---|
| 1 | **Send to the leader when linked**; route-forward stays for browsers and one-link clients | rule | `route-forward` (2) | 0 to +1: `forward.once` stays, since browsers stay forwarded (E-20); a direct send adds the client's leader table, its choice of path, and `moved` on a direct send | none new: E-20 modelled both paths | PA-4 | large: one RTT on about 2 of 3 writes |
| 2 | **The checksum: one per batch on CRC-32/IEEE** (Node's native `zlib.crc32`), checked once per receiver; the batch checksum covers term, base offset, group and writer time; the journal row header has its own small checksum and keeps the chain; only the wire's per-link fields sit outside, under the frame header's checksum | format (DEV-09) | `disk-incarnation`, `par-repair` (its unit becomes a batch), `raft-log` | +1 (every trusted byte under a checksum) | E-37's model read with "entry" as "batch", with a damaged header in its cases | PA-1a, PA-11 | large and robust: every path, every shape |
| 3 | **A byte-rate cap on bulk work**, on the link and the disk; bulk cut into 64 KB chunks on the link only; a side file only if a run shows it helps | rule (a mechanism later) | `link-pings`, `journal` (16) | about +1; +2 more with a side file | the catch-up-beside-live-writes run of 7.3 | PA-6 | large: live p99 during heals, moves and rolls |
| 4 | **Deltas from committed bytes**, off main, after the subscriber's snapshot position, for resource, partition and prefix selectors | rule | `subscribe` (26) | 0 to +1 (one rule changes; a partition hash in the record header, or deltas from bytes only where the slot routes) | E-31 again, with a `view` selector, a reloading or unfolded copy, and a join inside a shared frame | PA-3 (b) | large at p99 for subscribers |
| 5 | **The value as JSON text** with a tagged escape (a walk at encode, a per-record flag, a reviver only on flagged records); snapshot rows in V8's format; a slot and a length in each record's header; 1-byte lengths for short strings; small ids for peers and sessions in the envelope | format (DEV-09) | `fold-version`, `raft-log` | +1 (the escape rule; the format joins the fold version) | E-43's two-versions check; a fuzz of the escape against v4's codec over every value class and over non-canonical bytes | PA-1b, PA-12, PA-22, PA-23 | depends on the shape: large for rows of many short strings and for wakes in V8's format, small for field records |
| 6 | **A copy votes and acks before its fold is done**, and does not stand until folded | rule | `raft-term-vote`, `fold-all` | +1 | a check in E-14b's or E-16's model that a copy with an unfinished fold never stands | PA-16 | medium (large for big resources): 22-94 s less under-replication per restart, at every roll step |
| 7 | **One shared log per process with an index per group**; self-describing records with a header checksum | mechanism | `journal` (16), `tier` (10), `par-repair` (6), `forks` (7) | about +4 to +6 (E-49's about 4, 3-5, for shared segments with the tier, a resource's deletion and forks; +1 for the resync past a damaged record) | a model of retention across groups sharing a file, with a damaged record in a shared file | PA-7 | large: disk write bytes halved |
| 8 | **A short retry-after during a slot move or a handover**, honoured below the 200 ms floor; an immediate resend after a link loss only when the new link reports a live leader | rule | `slot-move`, `admission-credits` | 0 to +1 (DESIGN-V5 4.3's retry-after exists) | a storm test as E-39's | PA-20 | medium: every roll |
| 9 | **Hand-back in batches, paced by load, busy groups first** | rule | `raft-leader-transfer` (6); the pace itself is not among SIMPLICITY's counted rules | 0 to +1 | none ("no take in one tick" kept) | PA-41 | medium at 10,000 resources a process and more |
| 10 | **Session renewals in memory**; only the lapse logged; a new leader extends every lease by `session.ms` | rule | `client-sessions` (14), `presence-rows` (6) | 0 (a rule changes) | E-20's model and E-22's D10 check again | PA-9 | medium |
| 11 | **Validation at the writer only** (DESIGN-V5 4.5's "where a write first enters" goes); the leader folds the committed bytes, or folds its judged objects behind a round-trip check | rule | `writer-judging` | 0 to +1 (the check, if the shortcut is taken) | none for validation (the writer's check is the one that counts, E-32); a simulator check that every judged value round-trips, with F-21's hash, for the shortcut | PA-12 | medium |
| 12 | **Parked queue takes** at the writer, claimed under the waiter's own attempt id | rule | `queue-claims` (8) | +1 | E-22's P-09 and P-22 checks again, with a lost answer at a leader change | PA-18 | medium |
| 13 | **A slot move by reference** when every copy of B sits with a copy of A; L2 hides A's rows and pins them until B's snapshot | mechanism | `slot-move` (13), `forks` (7), `fold-all` | +2 to +4 | E-15, E-17c, E-32, E-23 and DATA-09's differential test again | PA-15 | medium-low certainty: bytes per move to about zero |
| 14 | **Snapshot layers cut from the log's bytes** on the worker (later) | mechanism | `raft-snapshot`, `fold-all` | +1 to +2 | DATA-09's differential test over the worker's compaction against `data`'s fold | PA-14 (b) | medium |
| 15 | **The recorder's boundary across both threads** | format | `input-recorder` (4) | +1 | none (no other model reads the tape) | PA-29 | small cost, replay coverage |
| 16 | **Pings only on silent links** | rule | `link-pings` (4) | 0 (a rule changes) | none (any frame resets the silence timer) | PA-26 | small-medium |
| 17 | **Saga steps on different partitions together**; locks released after the answer | rule (library) | `saga-intents` (30) | 0 | E-24 again for steps together | PA-24 | medium on a rare path |
| 18 | **`f.snapshot`'s meaning**: a lookup view, or the whole picture with row reads moved to `f.data` | API | none | 0 | none | PA-8 | large for programs that read rows through it |
| 19 | **Method placement** by a key hint | API | none | 0 | none | PA-25 | medium for calls |
| 20 | **No frame checksum on TLS links** (optional) | link rule | `disk-incarnation` (no: disk checksums stay) | 0 | none | PA-32 | small |
| 21 | **V5-4's wording**: a resource's groups merge by writer time too | docs | none | 0 | none | PA-35 | clarity |
| — | Not recommended: a dormant group resuming its term | Raft rule | `raft-term-vote` | +1 or more | | PA-39 | under 2 ms |

- **All of rows 1-17 together** add about +13 to +23 rules to the base's 405 (summed from the rows: their low ends add to 13 and their high ends to 23; reasoned, none modelled), or +2 more if row 3's side file is later taken. The guards the check added to build-only findings add +1 to +2 (7.2): PA-5's canonical check, and PA-3 (a)'s handshake budget if client links end on the kernel worker. PA-2's durable mark adds nothing, since it is already SIMPLICITY's `journal` rule 2, and flushing in place is an option outside the sum (+2 if taken: its uncork and its `replicated` guard). So about **+14 to +25** in all: about as many as the 24 rules between MIN-P and the base, and enough to take the base past every judged row (405 + 14 = 419, against DRAFT 410 and SPLIT 417; SIMPLICITY 1). Each change's gain must pay for its rules.
- **Cheap in rules for a large gain:** 1 (routing, 0 to +1), 2 (the checksum, +1), 3 (the cap, about +1) and 4 (deltas from bytes, 0 to +1): about +2 to +4 in all, each with its model named.
- **Shape-dependent:** 5 (the JSON value) gains a lot only on rows of many short strings; on field records, the commonest write, it saves about 6-7 % of the decode. Take it for the wire if most rows look like E-05's; take V8's format for snapshots either way.
- **Larger mechanisms that need a model first:** 7 (shared log), 13 (move by reference), 14 (snapshots from bytes); 3 grows into one if a side file is taken.
- **Owner's API calls:** 18, 19 and 20.

### 7.2 Notes for the build

None of these changes a design rule. Each is how the design's own text, built well, behaves; the guards are build rules, counted in 7.1's sum (in place's only if it is taken).

- **Build traps the design's text already avoids** (section 6): send before the leader's own fsync; encode once and share the bytes (PA-5); one lane call per batch, no per-record objects (PA-11).
- **The flush (PA-2):** one hop off the kernel thread (a journal thread or one pool hop), never v4's two; a sync `writev` on arrival; no row copies; batches cut when the disk is free, never on a timer. The durable mark is the file offset at the fsync's start: SIMPLICITY's `journal` rule 2 already, so 0 new rules. One hop is the default. In place is an option, outside 7.1's sum (+2 build rules if taken), only behind its guards: the run's corked sends leave first (uncork, or fsync in a later macrotask; +1); never on a process whose journal may get a batch holding a `replicated` write, since MEMORY 9.4 needs each batch handed to the OS on arrival with the fsync in the background (+1); after one slow flush, the hop takes over, though the first stall still blocks the thread in full; and a simulator monitor that no commit ever waits for two fsyncs in a row. Its gain, 34-53 µs of CPU per flush on an idle box, is small against that first stall on the thread F-14 keeps free.
- **Crossings (PA-3 a):** client links off main, on a link-and-flow thread of their own, or on the kernel worker only behind a TLS terminator and a per-tick budget for handshakes and socket writes (+1); time a reconnect storm while Raft heartbeats run before choosing. The answer leaves the worker at commit; a client process has no kernel worker; batches of bytes across every seam.
- **Encode once (PA-5):** the `ASK`'s record bytes become the batch only after a strict decode shows them canonical; otherwise re-encode (+1); one `writev` per follower and for the journal; deltas are the log's bytes where bytes can route; method streams ride `follow`'s flow.
- **Do not port v4's kernel state (PA-10)** or its digest heartbeat and compaction rescans (2.8).
- **Per batch (PA-11, build part):** one lane call per batch; no buffer, log object or key string per record.
- **Garbage (PA-13):** encode at issue; a Promise only when awaited; a short-string decode path if v4's format stays.
- **Snapshots (PA-14 a):** a native serializer, sliced to keep the event loop short.
- **Reads (PA-17, PA-30, PA-31):** a partition → rows index, priced per row and per fold on every copy, and not built on `data`'s `group` until DATA-05 is fixed; shared pictures; ReadIndex batched per tick and served at followers; cached child lenses.
- **Flow (PA-19, PA-33, PA-34):** pipelined derived outputs read in-process; lazy group cursors under `run()`; token checks per (subscription, partition).
- **The cold start (PA-21):** the session registered as `fero()` opens; one flight after the door.
- **Answers (PA-27, PA-28):** no `ANSWER` where the committed stream answers, except for results that carry a value; early receipts only when a batch asks.
- **The RESP gateway (PA-40):** no per-key chain between writes once O.seq is built; a read, or any command whose reply reads the row, still waits for that connection's in-flight writes to its key. O.seq itself is 3 rules that SIMPLICITY counts in no row (`issue-order`).
- **Upkeep (PA-36, PA-37, PA-38):** layers merged by key before folding; restore metadata beside the fetch; a warm expiry index on every copy.

### 7.3 What the first slice should time

Every total on this page is a sum of measured parts. The first slice of v5 should time, end to end:
- one write in each column of 3.1's counted table, quiet and busy (3 servers and a following client, TLS on), for a small row **and for a field record**, the commonest write;
- **E-10's port inside the v5 shell at 50,000 writes a second**, with one Raft entry per batch, sends before the leader's fsync and the kernel on a worker, with the commit p99 under the 5.73 ms bar: B11 timed it only in E-11's simple host (one entry per write, persist then send, one thread), at its limit (commit p50 14-18 ms);
- a 4 MB catch-up beside live writes: the live p99 with and without the byte-rate cap, and with a side file;
- a 10 GB install and wake in the chosen formats (JSON values and V8's format for snapshots), with its GC;
- a roll of three copies at 1,000 and at 10,000 resources a process: the pause per handover, the writes caught, the time to vote, to ready, and until leadership is even again;
- a reconnect storm of 10,000 TLS clients while Raft heartbeats run, with client links on a thread of their own and on the kernel worker;
- a fan-out of one room to 1,000 subscribers;
- redis-benchmark through the RESP gateway at `-P 1` and `-P 16`, with and without the per-key chain between writes, and a check that a `GET` pipelined behind a `SET` on one connection sees it.

## 8. How sure

**What was measured, and how.** Every micro-benchmark this page relies on ran again for it, from [E-50](experiments/E50-path-costs/README.md)'s folder: 3 runs each, each process alone on the box under the study's timing lock, fero's own `kernel/codec.ts` and seam imported unchanged (at `cab0913`), `data` at `63fea66`. The step tables' code lines were read in this pass; every experiment number was checked against its README. After the check, five more benches joined E-50 and ran three times under the lock the same way: b3 (a decode pass with the rows kept, for field records, small rows and E-34's 2 KB rows, in four forms, and 2 KB rows again at 1,000,000 kept), B8 (field records), B9 (the escape), B10 (the flush split) and B11 (E-10's port in E-11's host at 10,000 and 50,000 writes a second). A second check reran b3, B8 to B11 and the 2 KB rows at 1,000,000 kept, under the same lock (one or two runs each; raw lines in E-50's results/recheck): they came out close to the first runs and in the same order, except the 2 KB rows at 1,000,000 kept, where JSON gained less (section 5.3).

**The box changed under the walk.** The walkers' first runs and this rerun ran on the same VM type but, after a machine restart, on what behaves like a different host: JavaScript work ran 10-20 % faster in the rerun (v4's decode 2.71 against 3.21 µs a small row; its encode 1.74 against 1.96 µs), while work that streams memory ran slower (a `Map` read at 1e6 rows 1.2 against 0.93 µs; the native crc over a 32 MB buffer about 0.45 against 0.27 ns a byte, though over bytes already in the CPU's cache it ran 0.19-0.20 ns a byte). Where the two runs differ, the page gives the range of both; [E-50](experiments/E50-path-costs/README.md) keeps both passes' raw results. Every ratio that decides a finding held in both passes (native against JavaScript checksum, JSON against v4's decode on small rows, shared against re-encoded deltas, a slot test against a key decode, an index against a scan, in place against v4's two pool hops), with one exception: on the first host a flush on a journal thread of its own cost 17 µs of CPU and 56 µs at p50 less than one trip through libuv's pool (66 against 83 µs; 142 against 198 µs); on the rerun's host the two cost about the same (72 against 67 µs of CPU; 158 against 167 µs at p50). So PA-2 rests on what held in both: one hop at most instead of v4's two; a journal thread of its own is a choice to time on the target machine.

**The check, and what it changed.** A skeptic checked this page and E-50 and found 23 problems. Each was checked against its source before it was applied, and all held; one was refined: for 2 KB rows the skeptic timed one JSON array per frame, while PA-1b's form, JSON per record, saves a little more (17-27 % against 6-12 %), not enough to change the result. Separately, where this page leans on E-49, it cites E-49 as it now stands, with its own check's corrections in it (its sections 1, 2, 6 and 7 and "The cheapest forms"). A second check then found 13 more problems (R1-R13); they are applied too: the rule sum re-added, E-49's current figures, a guard each for the in-place flush and the RESP gateway's reads, B11's saturation, field records' decode figures, the wake's range, and wording. What changed:
- **The record format (PA-1) splits in two.** The native checksum per batch (PA-1a) gains on every row shape. The JSON value (PA-1b) gains a lot only on rows of many short strings: kept, as a fold keeps them, it saves about 55 % of the decode on a small row, about 6-7 % on a field record (not kept: a fold keeps only its value) and about 10-27 % on a 2 KB row, less as the heap grows (b3, B8: 17-27 % in the three runs, 13 % in the second check's rerun at 1,000,000 rows). The 10 GB wake falls to about 51-64 s with snapshots in V8's format (64-75 s with JSON values), not the 30-36 s first written: the collector's work on 11 GB of kept rows does not shrink with the format.
- **The busy budget had no Raft in it.** Its biggest line was E-02's pipeline, which runs no Raft. E-10's real port, in E-11's host, cost 47-55 µs a write at 50,000 a second (B11) against E-02's 13.2-17.0, and 148-183 µs at 10,000 (E-11; B11: 143-187 µs a write). So every busy total is now a range, and the busy multiples shrink. At 50,000 a second the host was at its limit (commit p50 14-18 ms, p99 84-127 ms; E-50 section 15), where a port batches more and pays less per write, so the top of each busy range is a point, not a ceiling.
- **Top findings were waste in v4's habits, not in the design.** Sending before the leader's fsync, encoding once and lane calls per batch are already the design's text; they are listed as build traps, and section 0 ranks against the lean column.
- **Several fixes needed guards**, now written into their findings, their rule counts and section 7: the in-place flush against the cork (PA-2), client links on Raft's thread (PA-3 a), deltas from bytes (PA-3 b), checksum coverage of headers (PA-1a), a damaged record in one shared log (PA-7), the leader folding what it judged (PA-12), untrusted bytes copied as they are (PA-5), a resend after a link loss (PA-20), a parked take's attempt id (PA-18), a move by reference's L2 rules (PA-15), and the price of a partition index (PA-17); after the second check, the in-place flush against MEMORY 9.4's write on arrival (PA-2) and a pipelined read behind writes at the RESP gateway (PA-40).
- **Counts and numbers corrected**: the changes of 7.1 with their guards come to about +14 to +25 rules on the base's 405 (+2 with a side file, +2 if flushes run in place), not the +14 to +29 first summed: the rows add to +13 to +23, and PA-2's durable mark is `journal` rule 2 already; PA-4 costs 0 to +1 rule, not -1; PA-7 costs about +4 to +6, at E-49's current count; PA-6 rests on a byte-rate cap, not a side file; PA-9's gain is medium; E-37's leader-only repair leaves 4-9 % stuck; the bounds count 3 fsyncs, 2 checksum checks per catch-up byte and a kept per-record decode; two outside-system lines.
- **Paths added:** a roll step (5.14), a RESP `SET` and `INCR` through the gateway (3.12), TTL expiry, making a fork and a rolling fold-version change (5.15). They brought two findings: PA-40 (the gateway's per-key chain) and PA-41 (the hand-back's fixed pace).

**By claim:**
- **High:** the costs per byte, per record, per crossing, per message and per flush (measured here, small spread). That v4 re-encodes per link and per subscriber, decodes twice at the leader, copies rows into its WAL, keeps a second copy of every cell and hashes it, and runs its snapshot over the whole state (code, read here). That a checksum is cheap natively only per batch. That the JSON value's gain depends on the row's shape. That `f.snapshot` copies the whole resource per read.
- **Medium:** every whole-path total (3.1's counted table, 2.9's quiet and busy budgets, the 10 GB wake at about 51-64 s, the heal rates per GB, a roll step's times): sums of measured parts, never run end to end through a v5 server. The busy totals carry a Raft line from 17 µs (E-02's floor) to 47-55 µs (E-10's port in a simple host, measured at its limit, so not a ceiling), and the real line for a lean build is not known. The rule counts of section 7.1, about +14 to +25 in all: reasoned from SIMPLICITY's records, no fix modelled. The quiet numbers carry this VM's slow wake-ups (about 25 µs per idle vCPU, E-01), so a busy server pays less per crossing and per flush; the quiet budget is near the top of its range.
- **Medium-low:** the move by reference (PA-15), whose L2 rules are not modelled; the hand-back's pacing (PA-41).
- **Low:** the "from memory" lines about Kafka, etcd, TiKV, CockroachDB, NATS, Redis and Redpanda (not checked against their sources here); the new envelope's size (PA-23) and the lean garbage target (PA-13), which are reasoned.

**Not measured at all:** round trips between machines (loopback only; E-01 gives this box's floors); TLS per forwarding hop; head of line on a real 1-10 Gb/s link (computed from link speed; E-35 measured the journal half); E-10's port with one Raft entry per batch, sends before its own fsync and the kernel on a worker, at 50,000 writes a second with headroom (B11 timed it with one entry per write, persist then send, one thread, and at its limit); thousands of elections or handovers at once in TypeScript; a whole roll; a reconnect storm beside Raft's heartbeats; the RESP gateway's parse cost; a real queue with many waiting workers (E-22 ran the pattern on a simulator); a browser's own decode and fold speed; the GC of an 11 GB heap of rows in any format but v4's.

**What would change the answer.** If PA-1b's format failed E-43's two-versions check or its fuzz, the fallback (v4's format with a short-string decoder) keeps PA-1a's checksum gain, which does not depend on the value's form. If the first slice's end-to-end write were far above 3.1's lean column, the Raft port's own cost (B11) and then the crossings and flushes (PA-2, PA-3) would be where to look first, not the codec. If most writes are field records, PA-1b matters little and PA-1a, PA-4 and PA-3 lead. If projects run mostly quiet, PA-2 and PA-3 matter more than PA-1; if mostly busy or bulk-heavy, PA-1a, PA-6 and PA-7 do. If projects hold 10,000 resources a process or more, the roll's hand-back (PA-41) and the boot's elections move up.

## 9. Sources

**Files used.** [DECISIONS V5-1 to V5-6](../DECISIONS.md); [VERDICT 11.7](VERDICT.md#117-the-owners-design-decisions-2026-11-12); [SIMPLICITY](SIMPLICITY.md) 0, 3.1, 3.2; [MEMORY](MEMORY.md) 9.3, 9.4; [LAYERS](LAYERS.md) 0, 1, 3.4, 4.4, 8.1-8.6, 10; [DESIGN-V5](../DESIGN-V5.md) 3.4, 4.1-4.5, 5.3, 6.1, 6.2, 8, 9; [API.md](API.md) 3, 4, P-01; [MECHANISMS](MECHANISMS.md); [AMENDMENTS](AMENDMENTS.md) A-02, A-04, A-10, A-11.

**The micro-benchmarks:** [E-50](experiments/E50-path-costs/README.md), with its raw results and the tables they print, the skeptic's benches among them (b3, B8, B10) and B11, which runs E-11's own host unchanged.

**The checks:** the skeptic's 23 findings on this page and E-50, the second check's 13 (R1-R13, with its reruns in E-50's results/recheck), and E-49 as corrected by its own check (its boot, dormant form, genesis, directory and shared-segment counts), which this page cites where it leans on E-49.

**Experiments cited** (each number checked against its README in this pass): [E-01], [E-02], [E-03], [E-04], [E-05], [E-06], [E-07], [E-08], [E-09a], [E-09a2], [E-09b], [E-09c], [E-09d], [E-09e], [E-10], [E-11], [E-12], [E-13], [E-14b], [E-15], [E-16], [E-17c], [E-19], [E-20], [E-21], [E-22], [E-23], [E-24], [E-25], [E-26], [E-27], [E-28], [E-30], [E-31], [E-32], [E-33], [E-34], [E-35], [E-36], [E-37], [E-39], [E-40], [E-42], [E-43], [E-45], [E-46], [E-48], [E-49].

**Code read in this pass:** fero v4 at `cab0913`: `kernel/codec.ts`, `kernel/node.ts`, `kernel/write.ts`, `kernel/link.ts`, `kernel/scope.ts`, `kernel/log.ts`, `kernel/diag.ts`, `kernel/door.ts`, `kernel/journal.ts`, `shell/runtime.ts`, `api/index.ts`, `api/substrate.ts`, `api/data.ts`, `api/methods.ts`, `api/fold.ts`, `api/directory.ts`, `api/config.ts`. `data` at `63fea66`: `api/index.ts`, `kernel/store.ts`, `compat/v2-records.ts`.

**From memory, not checked here:** Kafka's record batch layout, its fetch by `sendfile`, KIP-73, KIP-98, KIP-392 and KIP-405; etcd's leader-parallel WAL write, `bcastAppend`, read loop and lease keep-alives; TiKV's region cache, raft-engine, follower read, latches and hibernated regions; CockroachDB's splits, merges, quiesced ranges and replicate queue; Redpanda's batch format and thread per core; NATS's subject routing and per-publisher order; Redis's AOF, RDB, `MIGRATE` and pub/sub buffers; SQS long polling; Percolator and Calvin; Raft's read rule and the thesis's section 10.2.1.

[E-01]: experiments/E01-floors/README.md
[E-02]: experiments/E02-pipeline/README.md
[E-03]: experiments/E03-napi-cost/README.md
[E-04]: experiments/E04-wasm-kernel/README.md
[E-05]: experiments/E05-fold-cost/README.md
[E-06]: experiments/E06-fork-rewind/README.md
[E-07]: experiments/E07-gc-worker/README.md
[E-08]: experiments/E08-relay-fanout/README.md
[E-09a]: experiments/E09a-redis/README.md
[E-09a2]: experiments/E09a2-redis-memtier/README.md
[E-09b]: experiments/E09b-nats/README.md
[E-09c]: experiments/E09c-kafka/README.md
[E-09d]: experiments/E09d-redpanda/README.md
[E-09e]: experiments/E09e-etcd/README.md
[E-10]: experiments/E10-raft-port/README.md
[E-11]: experiments/E11-many-groups/README.md
[E-12]: experiments/E12-journal/README.md
[E-13]: experiments/E13-handover/README.md
[E-14b]: experiments/E14b-membership-liveness/README.md
[E-15]: experiments/E15-slot-move-tla/README.md
[E-16]: experiments/E16-controller-loop/README.md
[E-17c]: experiments/E17c-partitioning-rerun/README.md
[E-19]: experiments/E19-slot-positions/README.md
[E-20]: experiments/E20-dedup/README.md
[E-21]: experiments/E21-time/README.md
[E-22]: experiments/E22-api-prototype/README.md
[E-23]: experiments/E23-merged-views/README.md
[E-24]: experiments/E24-sagas-ramp/README.md
[E-25]: experiments/E25-idle-fd/README.md
[E-26]: experiments/E26-dormant-groups/README.md
[E-27]: experiments/E27-idle-links/README.md
[E-28]: experiments/E28-minio-log/README.md
[E-30]: experiments/E30-derived-once/README.md
[E-31]: experiments/E31-subscribe/README.md
[E-32]: experiments/E32-composition/README.md
[E-33]: experiments/E33-genesis-restore/README.md
[E-34]: experiments/E34-wake-10gb/README.md
[E-35]: experiments/E35-neighbours/README.md
[E-36]: experiments/E36-many-resources/README.md
[E-37]: experiments/E37-bad-entry/README.md
[E-39]: experiments/E39-overload-storm/README.md
[E-40]: experiments/E40-browser-client/README.md
[E-42]: experiments/E42-recorder/README.md
[E-43]: experiments/E43-fold-versions/README.md
[E-45]: experiments/E45-drivers/README.md
[E-46]: experiments/E46-maelstrom-raft/README.md
[E-48]: experiments/E48-ack-stages/README.md
[E-49]: experiments/E49-per-resource-cost/README.md
