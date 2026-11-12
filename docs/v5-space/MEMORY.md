# A memory option for fero v5

2026-11-12, revised the same day after a skeptic's review (13 findings; what changed is in section 8). The user asked whether fero v5 should offer a `memory` option, and how much hassle it brings. This page answers for TiKV's shape, the design the study's arithmetic picks on the frame the user chose (section 1). MIN-P+par, the fallback design, is noted where it differs. MIN-P+par keeps `data`'s fold on every server, cuts keys into fixed hash slots held by Raft groups, and has only the `persisted` rung ([candidates/MIN-P+par.md](candidates/MIN-P+par.md)).

**How each claim is marked.**
- **Measured**: the experiment and its numbers are named.
- **Model-checked**: [E-47]'s model explored every reachable state, at small bounds.
- **Checked by brute force**: E-47's `raftcheck.py` tried every case on three explicit copies.
- **Computed**: `tools/closure.py`, the `repro` script of [candidates/README.md](candidates/README.md#reproduce-a-computed-claim), or one of the two scripts in section 7.
- **Cited**: a published system, as the study's files cite it. "From memory" means nobody checked it here.
- **Reasoned**: an argument. Nothing ran it.

This page changes no study file. The one experiment it adds is [E-47].

## 0. The recommendation

1. **Keep a memory option, but build it second, not in the first slice.**
2. **Form:** chosen per resource (`durability: 'memory'`), with E-47's rule set {R2} and the recovery rules of section 4.2. This is form (a) in section 4.
3. **{R2} in plain words:** a memory resource takes writes to one row at a time: `set`, delete, ops such as `incr`, and conditions on that row. A transaction, or a fenced write (one guarded by a lock's token), that touches it is refused `needs-persisted`. Locks, queues, limits, sessions and consumer groups keep their own state on `persisted` resources anyway.
4. **What a memory "ok" means.** It can vanish for about a second. If two of three servers lose power inside that second, the resource comes back as it was up to a second earlier. So two clients can both have heard "ok" for the last item in stock, though the state left still keeps the rule. And a write fero resends after a timeout may apply twice, unless it carries a caller id.
5. **The operator's recovery** restarts such a group from the longest log any copy still holds, on disk or in memory, not just from the copy that stayed up (rule 15). Checked by brute force: restarting from the survivor alone loses entries that two disks had.
6. **Use it for** caches, live state you can rebuild, counters you may lose, streams you can replay. **Never for** money, locks, queues, presence or full history.
7. **When:** after the `persisted` slice is timed, if waiting for the disk is at least half of a write's p99 there, and once models 1 to 7 of section 6.1 pass (model 1, splits, only for form (a)).
8. **It buys** (section 2):
   - one write about 3.5 to 3.9 times faster at the median and 4.4 to 7.6 times at p99 on E-02's pipeline (measured), about 2 to 3 times once TiKV's own hops are added (reasoned);
   - no waiting behind disk stalls, and about a third less CPU per write (measured on E-02);
   - on the benchmarks, likely one more won line: JetStream with 16 clients, and in a native build Kafka's top speed too (reasoned). The four Redis lines stay open on both rungs: they turn on how many writes a second the whole shape does with 200 or 3,200 in flight, and nothing has timed that.
9. **You give up** (section 4):
   - 20 to 34 more interacting pairs (the study's measure of parts that touch: 233 → 253 to 267);
   - one rule to learn, and an "ok" that is weaker on memory resources (item 4);
   - an operator step after a power cut;
   - up to about 1 s of answered writes on memory resources.
10. **It does not save** JetStream's one-client test line in TypeScript. That line stays a loss by name either way.
11. **A simpler first step exists:** memory resources that never split (form (a0), 251 to 265 pairs). It needs no split model, but each memory resource is then one range: one leader's write rate and one server's size. That fails SC-03's ceiling (64 writers per resource) for memory resources. So (a), with splits, stays the target.
12. **How sure: low to medium.**
    - Model-checked: without the refusals, transactions, fences and lock rows break. With them, nothing that was modelled stays on a memory resource.
    - So what does stay there (plain writes, ops, conditions, splits, merges, feeds) is reasoned only.
    - The recovery rule: checked by brute force on three copies.
    - Speed: reasoned from measured parts.

## 1. What the user asked, and the frame

**The user's words** (2026-11-12): "I don't mind accepting some losses if it makes things better, but also having memory option seems nice? of course if it introduces too much hassle as you described then that can be evaluated."

**Words used on this page.**
- **Rung**: what fero's "ok" means for a write.
  - `persisted`: two of three servers have the write on disk before fero answers. "On disk" means **fsynced**: flushed from the operating system's memory (its **page cache**) to the disk.
  - `memory`: two of three servers hold the write in memory. Their disks catch up within about a second.
  - `none`: no disk and no log. Whoever listens now gets the message.
- **The memory option** is the `memory` rung, chosen per resource. The study calls it Q `maj-m`, offered inside Q `mix` ([SPACE.md](SPACE.md)).
- **COMP2**: MIN-P+par plus the memory rung. Both use a **saga** for a unit across partitions: steps that each commit on their own, undone by later steps if the unit fails. The study's earlier costs of the rung (VERDICT §9 step 2b) were found for COMP2.
- **Unclean stop**: a server stops without flushing, as in a power cut. **Lost tail**: the last answered writes of a memory group that no surviving disk holds.
- **k**: the longest start of a group's log that two of its three copies have on disk.
- **p50 / p99**: the time half of the writes beat, and the time 99 in 100 beat.
- **Rule 3** ranks the designs that pass every MUST. Fewer **novel mechanisms** wins when the counts are 2 or more apart. Then more **SHOULDs** met wins. Then fewer **interacting pairs** wins. A pair is two mechanisms that touch the same state, so more pairs means more to build and test. Counts such as 0 / 5 / 233 read novel / SHOULDs / pairs.
- **Guessed cell**: a verdict that no judged design supports.
- **Fence token**: a number handed out with a lock. A protected (**fenced**) write carries it, and a range refuses a token older than one it has already seen.
- **Fold**: replay the change records into rows, which is what `data` does.

**The user's two answers** ([VERDICT §8](VERDICT.md#8-what-the-user-must-confirm)).
- **Item 15, DATA-01: the loose reading.** Another engine may hold the rows on servers, as long as its results equal data's. DATA-09's differential test must show that.
- **Item 2, losses.** A named competitor test line may be lost when the trade buys something real.

**TiKV's shape, in short** ([candidates/TiKV-TS.md](candidates/TiKV-TS.md), [candidates/TiKV-persisted.md](candidates/TiKV-persisted.md)).
- Each resource is cut into **ranges** of keys. Each range is one Raft group of three copies. Ranges split when they grow and merge when they shrink.
- A separate controller (PD, the "placement driver") places the copies. Inside it, a **timestamp oracle** (TSO) hands out rising times. Every write takes one round trip to it.
- A write across ranges uses **two-phase commit** in the form of Percolator (Google's design, which TiKV copies), over a multi-version store (an **LSM**, a log-structured store on disk). Each key is first **prewritten**: locked, with its new value. Then one key, the **primary**, gets the commit record that decides the whole unit, and the other keys follow.
- **Transaction ids** give exactly once: a retried commit finds its own record.
- `data` folds the rows on clients only.

**The arithmetic's pick on this frame** (computed: `repro rank --loss`, 24 of 31 rows in).

| Place | Row | Counts | What it is |
|---|---|---|---|
| 1 | TiKV-persisted, and its TypeScript-first twin | 0 / 5 / 233 | TiKV's shape with `persisted` only |
| 2 | TiKV-TS | 0 / 4 / 244 | the same shape with the memory rung |
| 3 | PD+fix | 0 / 3 / 247 | |
| 4 | MIN-P+par | 3 / 6 / 264 | the fallback, with no memory rung |

- TiKV-persisted and its twin stay unbeaten from 0 to 10 guessed cells ([the loss ladder](judging/closure/results/ladder-restated-PERF-01_losses.md)).
- On this frame TiKV-TS differs from TiKV-persisted in two cells only: P-15's MUST and SHOULD go from met to open (computed: `repro differ TiKV-persisted TiKV-TS --loss`). Without the loss, PERF-04 differs too: it fails for TiKV-persisted and is open for TiKV-TS.
- **P-15** is "transactions across partitions": every unit ends all applied or all undone (the MUST), and no reader sees half of one (the SHOULD).

**So the real question.** Once a loss is accepted, rule 3 counts no speed. On rule 3 alone the memory option loses: 233 pairs against 244 or more. This page weighs what rule 3 does not count: what the option buys, and its whole hassle.

## 2. What a memory option buys

### 2.1 What each rival's default waits for

| Rival (experiment) | Its default answers a write once... | fero's matching rung |
|---|---|---|
| Redis 7.0.15 ([E-09a], [E-09a2]) | one server holds it in memory | `memory` or less |
| NATS core 2.10.22 ([E-09b]) | nothing: there is no answer | `none` |
| NATS JetStream 2.10.22 ([E-09b]) | a majority holds it in the page cache (sync every 2 minutes) | `memory` |
| Kafka 4.4.0 ([E-09c]) | every in-sync copy holds it in the page cache (no fsync) | `memory` |
| Redpanda 26.2.6 ([E-09d]) | a majority has fsynced it | `persisted` |
| etcd 3.5.17 ([E-09e]) | a majority has fsynced it | `persisted` |

So four test rows time fero against a default that answers before the disk: PERF-02 (Redis), PERF-03 (NATS core), PERF-04 (JetStream) and PERF-05 (Kafka). PERF-03 is decided by the `none` rung, which every design has.

### 2.2 The seven test lines the rung decides

**How to read it.**
- **PERF-01's rule:** fero wins a test line only if its median beats the rival's by more than the larger spread. A spread is the gap between the best and worst of three runs. The "bar" column applies the rule to the rival's own spread.
- **A gateway** is a part of fero that speaks a rival's protocol (Redis, NATS, Kafka), so the rival's own benchmark tool can drive fero.
- **No kernel of TiKV's shape was ever timed** through a gateway. So every verdict below is reasoned from measured parts. The one exception says "proved": a lower bound from E-01's measured parts that holds for any shape of hop time (RR-15).
- **Lines 5 to 7: estimates.** They add TiKV's three extra hops at their medians to [E-02]'s pipeline at 50,000 writes a second. The hops are the client's, the oracle's and the forward to the leader. Together they are about 0.09 ms in Rust and Go, 0.12 ms in Node ([E-01]).
- **Lines 1 to 4: throughput needed.** redis-benchmark and memtier keep a fixed number of requests in flight: 200, or 3,200 at pipeline 16. Then the mean latency is in-flight ÷ writes a second (Little's law; E-09a2 measured memtier's mean at 0.998-1.000 of it). So a p99 bar there is a throughput bar. The column gives the rate fero needs, with a tail as narrow as Redis's (reasoned from E-09a2's numbers).

| # | Test line | Rival's default | Bar | `persisted` only: TS / native | With `memory`: TS / native |
|---|---|---|---|---|---|
| 1 | Redis SET, pipeline 1 (PERF-02, P-02) | 144,076/s; p99 2.88 ms (2.75-3.49) | p99 under about 2.14 ms: about 190,000 SETs/s or more | open / open | open / open |
| 2 | Redis INCR, pipeline 1 (PERF-02, P-11) | 155,283/s; p99 2.72 (2.66-2.77) | about 160,000 to 210,000/s | open / open | open / open |
| 3 | Redis SET, pipeline 16 | 620,157/s; p99 9.34 (9.28-11.46) | p99 under about 7.2: about 800,000/s | open / open | open / open |
| 4 | Redis INCR, pipeline 16 | 838,775/s; p99 7.01 (6.75-7.55) | p99 under about 6.2: about 950,000/s | open / open | open / open |
| 5 | JetStream publish with ack, 1 client (PERF-04) | 3,280 acks/s (2,287-3,342); p99 0.550 (0.536-0.783) | p99 under 0.303 ms, and at least about 4,340 acks/s | **lost, proved** / **lost, proved** | likely lost / **open** |
| 6 | JetStream publish with ack, 16 clients | 22,173/s (20,241-22,541); p99 2.85 (2.48-3.05) | p99 under about 2.29 ms, and above about 24,500/s | likely lost / open | likely won / likely won |
| 7 | Kafka default top speed (PERF-05, P-07) | 240,043 records/s of 1 KiB (238,014-257,107) | about 259,100/s | likely lost / open, thin | open, thin / likely won |

**Notes on the lines** (reasoned unless marked).
- **Lines 1 to 4.** At 200 in flight, 190,000 SETs a second means a mean under about 1.03 ms. Each one passes through gateway, oracle, Raft and the LSM. E-02's bare pipeline reaches 2.2 to 5.5 million writes a second, but with no gateway, oracle or LSM. So no rung is likely won or lost here. The `memory` rung takes the flush out of each round, which can only help, but by how much is open. Line 2's range: about 160,000/s if fero's spread is as narrow as Redis's (0.11 ms), about 210,000/s with the wider spread E-02 measured for Rust. (An earlier draft called these four lines likely won with `memory`. It used E-02's p99 at a fixed 50,000 writes a second, which does not hold in a closed loop.)
- **Line 5, `persisted`.** The bound: at least 0.356 ms in TypeScript, 0.328 ms in Rust and 0.321 ms in Go, all above the 0.303 ms bar (computed from E-01's parts, section 7). The estimates are 0.44 ms in TypeScript and 0.41 to 0.42 ms native.
- **Line 5, `memory`.** E-02's `memory` tail plus TiKV's hops is about 0.69 ms in TypeScript, 0.54 ms in Go and 0.42 ms in Rust. Only the bare network path fits: 0.12 to 0.23 ms in Rust.
- **Line 6.** With 16 in flight, 24,500 a second means a mean under about 0.65 ms. `memory` gives about 0.36 ms (TypeScript, 0.24 ms plus the hops), so the rate fits too. `persisted` in TypeScript is about 0.97 ms; native wins the rate only with a disk per copy (0.38-0.40 ms in E-02's emulation).
- **Line 7.** E-02's journal alone is only 1.10 times the bar in TypeScript and 1.35 times in Rust, before an LSM and two-phase commit come on top.
- **Lines 3 and 4, `persisted`.** Near these rates this disk's stalls swung E-02's p99 by 44 to 156 ms (measured), so a disk per copy matters.

**Tally.**

| Build | `persisted` only | With `memory` |
|---|---|---|
| TypeScript phase | 1 lost (proved), 2 likely lost, 4 open (Redis) | 1 likely won, 5 open (Redis, Kafka), 1 likely lost (JetStream, 1 client) |
| Native step, Rust | 1 lost (proved), 6 open | 2 likely won, 5 open (Redis; JetStream, 1 client) |
| Native step, Go | as Rust, but Go's wide p99 spread at 50,000/s (1.59-3.35 ms, E-02) likely loses line 6 | as Rust; Go's `memory` spread is 0.41-0.48 ms |

**JetStream's one-client line stays hard.** A native kernel wins it only if its own work adds less than about 0.07 ms at p99 over the bare network path (0.303 − 0.233). E-02 never ran one write in flight, so these are one working point, not a ceiling.

**Lines the rung does not decide** (reasoned from the same experiments).
- Redis GET is a read: no commit is involved.
- NATS core (PERF-03, P-06) is decided by the `none` rung.
- JetStream's async publish, pull consumer and work queue are won either way: `persisted` top speed is 4 to 28 times their rates.
- Kafka's p99 at half its top speed is won either way: 638 ms for Kafka against about 19 ms for E-02's TypeScript `persisted` ([E-09c]).
- Redpanda (PERF-06) and etcd (PERF-07) wait for the disk by default, so `persisted` is their matching rung.
- PERF-08 and PERF-09 count `persisted` commits only.

**Against the study's cells.** The judged cells move only P-15 and PERF-04 (computed). PERF-02 and PERF-05 are open for both rows, because no kernel ran through a gateway at speed. VERDICT §8 item 2 already names "PERF-02's and PERF-05's default test lines" beside JetStream's, and this page agrees.

**Where MIN-P+par differs.** The same throughput bars apply to lines 1 to 4. Its writes skip the oracle hop, so line 5 with `memory` is about 0.39 ms in Rust: more room, still above 0.303 (reasoned).

### 2.3 What it buys beyond the benchmarks

**Latency for users** (measured, [E-02]: three processes on loopback, 100 B records, real disk, growing files, 50,000 writes a second, no client hop; medians of 3 runs).

| Build | `persisted` p50 / p99 / p99.9, ms | `memory` p50 / p99 / p99.9, ms | Gain at p50, p99 |
|---|---|---|---|
| TypeScript | 0.85 / 4.33 / 20.2 | 0.24 / 0.57 / 2.6 | 3.5, 7.6 times |
| Rust | 0.62 / 1.58 / 4.1 | 0.16 / 0.33 / 1.2 | 3.9, 4.8 times |
| Go | 0.74 / 1.97 / 4.9 | 0.20 / 0.45 / 1.7 | 3.7, 4.4 times |

- **That is 1.3 to 3.8 ms off a p99** at that load on this box.
- **Against a separate disk per copy** (emulated in E-02), `persisted` read 0.56 / 2.40 ms (TypeScript), 0.38 / 0.67 (Rust) and 0.40 / 0.75 (Go). The gain is then 1.7 to 4.2 times.
- **TiKV's own hops shrink the gain**, since both rungs pay them. At the median it becomes about 1.9 times (Rust, a disk per copy) to 2.7 times (TypeScript, this disk) (reasoned).
- **On a cloud disk the gain grows.** AWS describes its gp3 volumes as "single-digit millisecond" (cited in [E-01]). A `persisted` write waits for one such flush; a `memory` write does not (reasoned; nothing was timed on gp3).

**Tails.**
- E-01 found a 22-52 ms flush stall in every 30-60 s run. A small flush waited 0.25-0.9 s behind a bulk writer on the same disk (measured).
- In TiKV's shape, the LSM's compactions, a new copy's snapshot and the object-store tier are such bulk writers (reasoned). A `persisted` write waits behind them; a `memory` write does not wait for a flush.
- E-02's p99.9 shows the start of this: 20.2 → 2.6 ms in TypeScript, 4.1 → 1.2 ms in Rust (measured).
- Not measured: an LSM compacting beside commits, or whether a plain `write()` itself blocks once a bulk writer fills the page cache.

**CPU per write** (measured, E-02, µs of one core per committed write, leader plus two followers, at 50,000 a second).
- TypeScript 13.2 → 8.0 (40 % less), Rust 9.9 → 6.4 (36 % less), Go 14.3 → 9.6 (33 % less).
- At top speed TypeScript saves nothing: its main thread is the limit.
- In TiKV's shape the LSM and the oracle cost the same on both rungs, so the share saved is smaller (reasoned).

**Top speed** (measured, E-02).
- Against growing files: Rust 2.21 → 4.96 million/s, Go 2.83 → 5.55, TypeScript 2.79 → 2.75 (no gain).
- Against preallocated files `persisted` already reaches Rust 4.11, Go 4.08 and TypeScript 3.58 million/s. Against those, `memory` on growing files gains only 1.2 times (Rust) and 1.4 times (Go), and TypeScript loses. `memory` was never run on preallocated files.

**Disk.** The same bytes are written. Flushes fall from about 725 to 1,000 a second per process (E-02: 69, 50 and 60 records per flush at 50,000/s) to about one a second (reasoned).

**Cost per project: no change** (reasoned from [E-41]'s rules). No machine size step is crossed at E-41's two loads, and disk size and traffic stay the same. PD's shape costs $18.64 to $19.01 a month at 10 writes a second either way (E-41's recheck).

**What the same switch did for the rivals** (measured, each with its own tool on this box).
- Skipping the flush made one write's latency 1.7 to 4.2 times lower: etcd 1.7-1.9, Redpanda 2.1-3.0, JetStream 2.4-2.7, Kafka 3.3-4.2.
- Systems that already share one flush among many writes gained little throughput: Redpanda 1.07 times with big batches.
- fero shares flushes too. So for fero the rung's value is latency, not throughput (reasoned).

### 2.4 Where it buys nothing

- **Writes across ranges.** Under the recommended rule they never touch a memory resource. A `persisted` write across two ranges pays about 0.48 ms at the median and 0.77 ms at p99 on the floor (reasoned; section 7).
- **Locks and fences.** They stay on `persisted` resources.
- **Reads.** No read waits for a flush on either rung.
- **Redpanda, etcd and NATS core** (section 2.2).

## 3. What a lost tail breaks

### 3.1 When a tail is lost

- **It takes a majority losing its page cache.** With three copies, two must stop uncleanly before their disks have the write: a power cut, an operating-system crash, or a host or rack going down. The leader holds the whole committed log, so it must be one of them (reasoned).
- **A crash of fero alone loses nothing.** A kill -9 does not empty the page cache. E-02's `memory` rung hands each write to the operating system before it answers (`writevSync`, then the answer, with no fsync: `ts/pipeline.ts`). So a write it answered survives a kill -9 (reasoned from the code).
- **But the settled rule counts a kill as unclean.** So killing every fero process at once would leave every memory group waiting for an operator, though nothing was lost (reasoned). Form (e2) fixes this: judge a clean stop by the machine's **boot id**, a random number Linux picks at each start.
- **After a real loss, a copy comes back "as new".** A copy that cannot vouch for its log returns under a new identity as a non-voting copy. It votes again only once it has caught up (the settled `memory-rung` unit; SPACE's Q `maj-m`). Kafka does the same for a broker that stopped uncleanly: KIP-966, a Kafka design proposal, keeps such a broker out of the leader election until it has caught up (cited by the settled unit).
- **A whole group needs an operator then.** If a majority of a memory group came back as new, the group has no voting majority. It waits for `fero recover --unclean`, which must list what may be lost before it runs (F-12).
- **The recovery must read every copy's disk.** The obvious reading of "rebuild from what is left" is to restart from the copy that stayed up. That loses entries that two disks had. Example: the leader and follower 1 fsync a split entry; follower 2 has not received it yet; a power cut takes the leader and follower 1. Follower 2's log lacks the entry. Checked by brute force: this reading cut the log below k in 2 of 57 majority stops that leave a survivor (logs of at most one entry), and in 1,764 of 29,358 (at most six entries) ([results/raftcheck.txt](experiments/E47-memory-rung/results/raftcheck.txt)). So rule 15 restarts from the longest log any copy holds: a stopped copy's disk, or a survivor's memory. That never cut below k, in any case tried, even with one stopped copy's disk lost.

### 3.2 One cause under every break

The group comes back as a true, earlier copy of itself, so nothing inside it is wrong. What breaks is every promise that had already left the group:
- a client told "ok" or "refused";
- a lock holder told "granted";
- a reader who saw a value;
- a subscriber who folded a record with `data`;
- another range that holds the other half of a transaction;
- the controller's table of which range holds which keys.

Every rule in section 4 either keeps such promises out of the lost tail, or cancels them loudly afterwards, or is named in the rung's contract as an "ok" that may vanish (reasoned).

### 3.3 Part by part

"Now" is the cell for TiKV-persisted / TiKV-TS (computed with `closure.py`'s cells). "Backed by" says whether E-47 model-checked the break or it is reasoned.

| Part of TiKV's shape | What a lost tail does | Promise it breaks | Now | Backed by | Closer in the recommended form |
|---|---|---|---|---|---|
| A transaction over a memory range and a `persisted` range | half applied; or the `persisted` half is rolled back after "committed" | P-15 M and S; F-01 (a `persisted` write undone) | P-15 met / open; F-01 open / open | model-checked: ATOMIC 14 and 11, DURABLE 15 | refuse the transaction (R2.txn) |
| A transaction inside one memory range, or over two | half applied | P-15 | as above | model-checked: ATOMIC 11 (one range), 11 and 14 (two) | R2.txn |
| A rollback record (a refusal) | a transaction told "aborted" commits later | F-02 | open / open | model-checked: REFUSED 13 | R2.txn |
| A fence table | a write under an older lock token lands after one under a newer token was answered | P-10 | open / open | model-checked: FENCE 13 | refuse fenced writes (R2.put) |
| A lock row | a claim is lost, so a second holder is granted the lock while the first still holds it | P-10 | open / open | model-checked: HOLDERS 7, even with oracle tokens | locks live in `#locks`, a system resource, never memory |
| A lock row whose tokens come from a counter | one token handed out twice | P-10 | open / open | model-checked: TOKEN 7. Impossible if tokens are oracle times (rule 4) | as above |
| Conditions and bounds on one row (`if`, `incr` with `min`/`max`) | an "ok" vanishes; a later write then passes the check the vanished write had used. Two clients can both hear "ok" for the last item. The state left still keeps the rule | P-14, P-11 | open / open | reasoned | the rung's contract: an "ok" on memory may vanish. Rule 12 keeps a refusal a refusal |
| Plain writes and their retries | a memory write carries no transaction id, so a resent write may apply twice, with or without a loss | F-02 | open / open | reasoned (E-47: R2 leaves no dedup state on memory) | the contract; a caller id prevents it (reasoned) |
| Versions and their clean-up | an answer changes; a deleted row comes back; an expiry is undone until the next tick | F-04, F-08, P-02 | open / open | reasoned | the rung's contract: say it in health and in `fero recover` |
| Closed times (a range's promise that no new write lands at or below a time) and follower reads | an answer at or below a closed time changes | F-04, P-03 | open / open | reasoned | the incarnation raise (rule 11) |
| Change feeds | a client silently keeps rows the server lost, since its cursor still looks valid | P-03, P-05 | open / open | reasoned | the cursor's incarnation check refuses an old cursor `unknown-log`; the client takes a fresh snapshot |
| Split and merge records | two ranges claim the same keys, or none does | F-03 (met), F-08, F-12 | F-03 met / met | reasoned. E-17 lists unclean recovery among what its models leave out | split and merge entries on a memory range wait for disk, or the recovery adopts the controller's range table (rule 13); no merge across resources. Either needs rule 15 |
| The recovery itself | a restart from the survivor alone drops entries two disks had (above) | F-03, F-01 for split entries | — | checked by brute force | rule 15 |
| The controller and its oracle | nothing, while they stay `persisted` | — | — | reasoned | system groups are never memory |
| Coming back as new | done per server rather than per range copy, it would wipe `persisted` ranges too | F-01 | open / open | reasoned (family B's note) | come back as new per range copy |
| A failed background fsync, or a full disk | answers for writes that can never reach disk | F-10, F-20 | open / open | reasoned | stop memory answers on that server |
| Presence, full history, derived outputs; and the state of queues, consumer groups and limits | two live leases, lost acks, zombie commits, counts going back | P-08, P-09, P-11, P-13, P-17 | open / open | reasoned | presence, history and derived outputs are refused on memory; the libraries keep queues, cursors and limits on `persisted` resources (rule 5) |

**What this says.**
- The study counts only P-15 for TiKV-TS because most other parts were open already, not because the rung leaves them alone (computed).
- Two reaches go past the judged cells. Through two-phase commit, a memory primary can undo a write on a `persisted` resource (F-01). E-47 model-checked it: DURABLE, 15 steps. Through a lost split, a met MUST, F-03 (one writer), is at risk. That one is reasoned.
- **Times never repeat, if versions and tokens are oracle times.** The judged TiKV-TS row does not promise that. Its positions are hybrid-logical-clock times (O `hlc`), and its lock-rows unit takes a token from the row's own version. If a version came from a leader's clock, a new leader on a lagging clock could hand out a time at or below one lost in the tail. Then a token or a cursor time could repeat. So rule 4 makes it a design rule: every token and every version on a memory resource is an oracle time. Every write already pays the oracle hop in section 2.2's estimates, and the rule adds no pair (computed).

### 3.4 What E-47's model found

**What it is** ([E-47]).
- An exhaustive model in plain Python on E-16's engine, with E-17's rule language, the tools E-20 and E-24 use.
- Two Raft groups, A and B, and a timestamp oracle. Group A can have a majority stop uncleanly once per run; group B never stops.
- Percolator's two-phase commit is judged when each command is applied. Readers clean up old locks. Clients retry. Two lock holders run, and one holder's lease can lapse while it is paused.
- The whole set was rerun on the final model after the review: 603 runs, 40.6 million states, 2,548 s of CPU in all ([results/runs.json](experiments/E47-memory-rung/results/runs.json)).

**The breaks, in plain words** (shortest traces; full ones in [results/base.txt](experiments/E47-memory-rung/results/base.txt)).
- **Half a transaction across rungs** (ATOMIC, 14 steps; RR-11's trace). T writes key a on a memory range (its primary) and key b on a `persisted` range. Both say ok. T commits a, in memory, and is told "committed". Two of the memory range's three servers then lose power. The new leader keeps neither entry. T commits b. A reader sees b's new value and a's old one.
- **A `persisted` write undone** (DURABLE, 15 steps). a's lock times out. A reader checks a, rolls it back, and sends "roll back b". The memory range loses its tail: the new leader keeps a's lock but not the rollback. T's commit of a now succeeds, and T is told "committed". Then the reader's "roll back b" lands on the `persisted` range, which never lost anything.
- **Half a transaction inside one memory range** (ATOMIC, 11 steps; nobody predicted it). T writes a and c on the same memory range, and both say ok. The tail is lost; the new leader keeps a's lock, not c's. T commits a anyway. A reader sees a new and c old.
- **A refused transaction commits later** (REFUSED, 13 steps; RR-13's trace in Percolator's terms). T is told "aborted" after a reader rolled it back. The rollback record is in the lost tail. A second copy of T's commit, still in flight, then lands and commits T.
- **A fence goes back** (FENCE, 13 steps; RR-12's trace step for step). Holder h1 writes x with token 4 and is told ok. The tail is lost, and x's range forgets token 4. Paused holder h0 wakes and writes x with its old token 2. It is accepted.
- **Two holders at once** (HOLDERS, 7 steps; added after the review). h0's claim is granted and h0 is told so. The tail is lost, and the claim with it. h1 claims and is granted too. Both now hold the lock, and neither lease has lapsed. Fencing still holds; one holder per lease (P-10) does not.
- **One token handed out twice** (TOKEN, 7 steps), only when tokens come from a counter in the lock row.
- **Never broke:** a transaction applied twice (ONCE), or a `persisted` key reading older later (MONO).
- **Allowed, and reported apart:** an answered memory write gone, and a later read older than an earlier one ([results/info.txt](experiments/E47-memory-rung/results/info.txt)). That is the rung's contract.

**Which rules fix it** ([results/sets.txt](experiments/E47-memory-rung/results/sets.txt), [subs.txt](experiments/E47-memory-rung/results/subs.txt), [greedy.txt](experiments/E47-memory-rung/results/greedy.txt)).

| Rule set | Holds on every bound? | What it costs |
|---|---|---|
| no rules | no: P-15, P-10 (fences and one holder) and F-02 break | — |
| R1: no transaction spans two rungs | no: half a transaction inside one memory range and over two, a lost fence, a lost refusal, two holders | — |
| R4: a bounded fsync, counted in entries | no: even syncing before every append fixes only the refusal case | — |
| **{R2}**: no transaction, fenced write or lock row on a memory range | **yes**, nothing stuck | memory resources lose transactions and fenced writes; lock rows stay off them |
| {R1s, R3}: a transaction that touches a memory range stays inside that one range, plus an epoch after an unclean loss | no: two holders (HOLDERS 7) | — |
| **{R1s, R3, R2.claim}**: the same, with lock rows kept off memory | **yes**, nothing stuck | an epoch with four needed parts: fences rise to the oracle's time; old prewrites and commits are refused "outcome unknown"; so are readers' old clean-ups; a snapshot read that sees an epoch change starts again |

- Every part of both sets is needed: dropping any one brings a counterexample back.
- E-17's greedy ablation (drop each rule in turn, keep it if a break comes back) ends at {R2} in all three orders over whole rules, and at {R1s, R3, R2.claim} when R2's parts are dropped one by one.
- The larger bounds agree. The largest run explored all 4,953,029 states ([results/verify.txt](experiments/E47-memory-rung/results/verify.txt)).

**The Raft step, checked by brute force** ([results/raftcheck.txt](experiments/E47-memory-rung/results/raftcheck.txt); three explicit copies, 1 to 6 entries).
- **What the model does.** After a majority stop it lets the new leader keep any start of the log from k to its end. Every run above uses that one step.
- **Elections by vote.** If copies that stopped uncleanly could vote on what they had on disk, the cuts are exactly those, in up to 181,314 stop-and-election outcomes. `persisted` never lost an answered entry; `memory` did.
- **But the settled rule forbids that vote.** Such a copy never votes under its old identity, so the group waits for the operator. The check now covers that path too. Rule 15's restart stayed inside [k, end] in every one of up to 39,144 majority stops, also with one stopped copy's disk lost. So the model's step covers the operator's recovery, provided rule 15 holds. Restarting from the survivor alone cut below k (section 3.1).

**What E-47 leaves out** (its own list).
- Only one unclean stop per run, and group B never stops.
- Splits and merges, range moves, leader leases for reads.
- Plain writes on a memory range, ops, conditions and their retries. These are the only things {R2} leaves there.
- TiKV's async commit, one-phase commit, pessimistic locks and clean-up of old versions.
- Raft's term and vote are assumed synced to disk.
- The group after the operator's recovery is modelled as an instant restart; how the controller sets its new members is not modelled.
- Small bounds; one agent. No guard-by-guard count and no **mutants** (one-rule bugs planted to test the model), which DEV-10, the study's counting rule, asks for.

**One caution about {R2}'s result.** Under {R2}, every modelled program that touches the memory group is refused at its first step. Those runs have only 12 to 387 states. So "it holds" means the refusals block every modelled hazard, not that anything left on memory was checked. What stays on memory was not modelled at all (reasoned from E-47's own note).

**Kill test 2b does not fire on TiKV's shape** at these bounds (model-checked). VERDICT §9's kill table says the rung goes if it "breaks a MUST with no rule that fixes it". Two rule sets fix every modelled break.

## 4. The forms side by side

### 4.1 The table

Pairs marked "in memory" are counted by `closure.py`'s own pair rule on copies of its units, with the reads each form adds (section 7). Which unit reads a new state is a reasoned choice. So each form with rules has two counts: **low** puts each check where its state is already read; **high** puts it at the call or at the writer. Every form below except (d) also carries the shared rules 4 to 15 of section 4.2, and is counted with them.

| Form | Mechanisms (novel) | Pairs | Cells against "no rung" | Model | The rule a user learns | The risk if a user ignores it |
|---|---|---|---|---|---|---|
| **(d) No memory rung** (`persisted` and `none`) | 48 (0) | **233**, computed | none. P-15 M and S met; JetStream's line a loss by name | nothing owed | "Every write is on disk at two of three servers before fero answers." | uses `none` for state and expects a newcomer to see it |
| **(a) Per resource, with {R2}** (recommended) | 49 (0) | **253 to 267**, in memory | P-15 M and S open as judged. E-47 is the model their closer asked for, so a referee could set them back to met (reasoned) | refusals: model-checked. Recovery rule: brute force. The rest: reasoned | "A memory resource takes one-row writes only, and can lose its last second of them." | writes a fact to a `persisted` resource that holds only if a memory write survived; shows a person "saved" on a memory answer |
| **(a0) As (a), but memory resources never split or merge** (one range each) | 49 (0) | **251 to 265**, in memory | as (a); and SC-03 (64 writers per resource) fails for memory resources (reasoned) | as (a), minus the split and merge model | as (a), plus "a memory resource is capped at one range" | outgrows the cap |
| **(a′) Per resource, with {R1s, R3, R2.claim}** | 49 or 50 (0; whether R3's reader parts are novel was not ruled, so possibly 1) | **256 to 274**, in memory | as (a) | model-checked | "A transaction on memory stays inside one range. After a power loss, transactions in flight end 'unknown', fenced writers take their locks again, and reads start again." | assumes a transaction over memory keys always works; R1s refuses it when its keys fall in two ranges, which an app cannot predict once ranges split (reasoned) |
| **(b) Rungs never share a range; no transaction across rungs** | 49 (0) | **251 to 265**, in memory | P-15 M stays open | E-47: its rule, R1, breaks inside one memory range and over two (ATOMIC 11 and 14) | as (a), plus "a transaction over memory resources can come back half done" | assumes all-or-nothing over memory resources |
| **(c) A stated loss window with back-pressure** (like JetStream's sync interval or Redpanda's 100 ms flush) | +0 on (a) or (b) | +0 (it is rule 9) | none move | E-47: a bound in entries (R4) fixes no break but the refusal case | "At most N of answered writes (default 1 s) can vanish. If disks fall behind, memory writes slow down to keep that promise." | reads N as "safe enough for anything" |
| **(e1) Per kind of write**: plain writes answered from memory; transaction records, fenced writes, claims, cursors, splits and merges wait for disk | 49 (0) | **251 to 265**, in memory | P-15 back to its `persisted` support, once modelled (reasoned) | **not modelled.** Replayed by hand on E-47's traces, the snapshot-read and clean-up breaks remain unless a reader also waits for disk before it acts on a transaction's commit (reasoned) | "Plain writes on a memory resource are fast and can be lost. Writes others rely on wait for disk." | expects a memory resource's transactions to be fast |
| **(e2) A clean stop judged by boot id** | +0 | +0, reasoned | removes the kill -9 path to F-07 | reasoned | nothing new | — |
| **(e3) Memory only across separate hosts** | +0 | +0, reasoned | none | reasoned. On one box it gives no speed, so PERF-01's same-box test lines would see no gain. Better as a health warning than as a rule | "On one machine, memory waits for disk like `persisted`." | — |
| **(e4) A flush call**: `flush()` waits until the disk has the caller's writes | +0 on (e1) | reasoned | none | — | "Call `flush()` before you tell a person their write is saved." | — |
| Rejected: (e5) the leader alone answers; (e6) automatic unclean recovery | — | — | (e5) loses answered writes on every leader crash. (e6) cannot list what may be lost before it runs (F-12) | — | — | — |

Notes on the table.
- **The SHOULD count.** Every memory form starts at 4 SHOULDs (P-15's SHOULD is open as judged). It goes back to 5 only if a referee accepts E-47 (or (e1)'s own model) for P-15.
- **Rule 3 never prefers a memory form** once the loss is accepted. Even at 5 SHOULDs, 251 to 274 pairs lose to 233 (computed). Picking a memory form means picking speed over rule 3's count. That is the user's call.
- **(a0) against (a).** (a0) drops rule 13, the split and merge model (6.1 item 1), and the one met MUST at risk (F-03). It costs about 2 pairs less. But a memory resource is then one Raft group: one leader's write rate and one server's memory and disk. SC-03 asks a resource to grow to 64 writers, and SC-06 lets it outgrow one server; (a0) meets neither for memory resources (reasoned). A cache can live with that; a hot counter shared by many servers cannot. So (a) stays the target. (a0) is a fair first step only if the user accepts SC-03's ceiling as a loss for memory resources until splits come.
- **(e1) is the strongest idea, but not first.** PostgreSQL's per-transaction `synchronous_commit` and MongoDB's per-write `j` option are precedents (from memory, not checked). But E-47's snapshot-read and clean-up traces, replayed by hand on (e1), let a reader act on a commit that is not yet on disk (reasoned). Before (e1) is used, its reader rule needs its own model.

### 4.2 The recommended form in full: (a) with {R2}

**The rules, and what backs each.**

| # | Rule | Backed by |
|---|---|---|
| 1 | A write commits when two of three copies hold it in memory. The disks catch up in the background. | the settled `memory-rung` unit |
| 2 | **R2.txn:** a transaction with any key on a memory resource is refused before its first prewrite. | E-47, model-checked: needed |
| 3 | **R2.put:** a fenced write to a memory resource is refused. | E-47, model-checked: needed |
| 4 | Lock rows live in `#locks`, which is never memory. Every lock token and every version on a memory resource is an oracle time. | E-47, model-checked: lock rows off memory are needed for one holder per lease (HOLDERS 7), even with oracle tokens; oracle tokens alone are enough for fencing. Oracle versions: reasoned (section 3.3) |
| 5 | Session-bound rows (`while: 'session'`), `history: 'all'` and derived outputs are refused on memory. The libraries keep their own state (`#locks`, `#sessions`, `#calls`, queues, consumer-group cursors, limits) on `persisted` resources. | reasoned (costs pass). API.md says the libraries keep their own state on `persisted` resources; this page reads that to cover `limiter` too. Not modelled |
| 6 | No system group is ever memory: the controller, `#meta`, `#locks` and the other `#` resources. | reasoned |
| 7 | A copy that stopped uncleanly comes back as new, per range copy, never per server. | the settled unit; family B's note (reasoned) |
| 8 | A clean stop is judged by the machine's boot id. On the same boot, the copy fsyncs its files and then vouches for its log. | form (e2), reasoned |
| 9 | When the oldest unsynced write on a server is older than 1 s, memory answers wait. | form (c), reasoned |
| 10 | A failed background fsync, or a full disk, stops memory answers on that server. | F-10, F-20; reasoned |
| 11 | A recovery raises the group's incarnation (a counter the controller already keeps), so an old cursor is refused `unknown-log`. | reasoned |
| 12 | A recovery raises the range generation (a counter the range table already raises on every split or merge), so a write copy sent before it is answered `restored`, final, and is not retried. | reasoned. TiKV itself makes a client retry on a stale range epoch (from memory, not checked), which would judge the old copy again |
| 13 | Split and merge entries on a memory range wait for disk, or the recovery adopts the controller's range table. No merge joins ranges of two resources. | reasoned. Either closer protects only with rule 15 |
| 14 | Raft's term and vote are synced to disk. | E-47's assumption |
| 15 | `fero recover --unclean` restarts a memory group from the longest log any copy holds: a stopped copy's disk, or a survivor's memory. That is at least k. It never restarts from the survivor alone. It takes the group's members and key range from the controller's tables. | checked by brute force (raftcheck checks 6 and 7) |

**Counted:** 49 mechanisms, 0 novel, 253 (low) to 267 (high) pairs (in memory; section 7). Every rule's reads are counted. Rules 2 and 3 add 4 pairs, rule 13 adds 2, rule 15 adds 2, and rule 12 adds 1 (low). The high count also checks rule 5 at the call (+5), reads the disk incarnation for rule 11 (+1), and has the recovery write the range table and the writer read it for rule 12 (+9 instead of +1). Rules 4, 6 to 10 and 14 add no pair (computed for 4, 9 and 10; reasoned for the rest, whose state already exists in their own unit).

**What a user learns.**

> Resources are `persisted` unless you say otherwise: fero answers once two of three servers have your write on disk. You may mark a resource `durability: 'memory'`. Then fero answers once two of three servers hold the write in memory, and their disks catch up within a second. A crash of fero itself loses nothing. But if two of those servers lose power, or their operating system crashes, within that second, the resource comes back as it was up to a second earlier. Clients following it reload it, and fero says what may be lost.
>
> So on a memory resource an "ok" may vanish. That includes a conditional write: two clients may both hear "ok" for the last item, though what is left never breaks your rule. A write that fero resends after a timeout may count twice, unless you give it an `id`. A refusal always stays a refusal.
>
> Because of that window, a memory resource takes one-row writes only: no transactions, no fenced writes, no presence rows, no full history and no derived outputs. fero refuses those with `needs-persisted`. Locks, queues, limits and consumer groups keep their own state on `persisted` resources. Use memory for what you can lose or rebuild.

**What an app still gets wrong** (reasoned).
- It writes a fact to a `persisted` resource that is true only if a memory write survived. An example is "order placed" for a cart total held in memory. No refusal can catch that.
- It shows a person "saved" on a memory answer.
- It bills from a memory counter, or treats a memory "ok" for the last item as a sale.
- It counts with `incr` on memory and expects no double counts after a timeout.
- It treats the reload after a loss as a bug.

**The operator's part.** After a power cut that takes two of three copies of a memory range, that range waits for `fero recover --unclean`. The command lists what may be lost before it runs (F-12), then follows rule 15. The health line names the ranges that came back as new, and the window they may have lost (F-09). With rule 8, a crash or kill of fero alone needs no operator. A copy that came back as new and lost its files is copied again at about 5 to 7 s per GB (measured on etcd, [E-13]), so 100 GB of memory data takes about 9 to 12 minutes (reasoned).

### 4.3 Why {R2} and not the others

- **Against {R1s, R3, R2.claim}:** {R2} is one stated rule and no new state. The other keeps transactions on memory, but adds an epoch with four parts, two of which have no precedent anyone here knows, and "outcome unknown" answers after every loss. Counted with the same shared rules, it costs 3 to 7 more pairs (256 to 274 against 253 to 267). And R1s ties a transaction to one range, which splits break (E-47's own reasoning).
- **Against (b):** E-47 shows its rule leaves transactions half applied.
- **Against (c) alone:** a window bounds how much is lost, not whether a promise breaks. It is kept as rule 9, for the number it gives users.
- **Against (e1):** it is the richest form, but it is not modelled, and the hand replay above shows a gap.
- **Against (a0):** see 4.1's notes. It is a first step, not the target.
- **Against (d):** (d) is simpler and wins rule 3. It is the right first slice. But it gives up the speed of section 2 for every resource, forever. The memory option's cost is contained: one-row writes only, 20 to 34 pairs, and nothing else in the design changes.

### 4.4 Where MIN-P+par differs

| | TiKV's shape | MIN-P+par (with the rung it becomes COMP2) |
|---|---|---|
| Counted price of the rung | 233 → 244 pairs; P-15 M and S met → open (computed) | 264 → 277 pairs; P-10, P-15 M and F-02 met → open (computed) |
| With {R2}'s refusals only | 248 (in memory) | 279 to 281 (in memory) |
| With the shared rules 4 to 15 | 253 to 267 | not counted here: COMP2's recovery uses its own restore mark, session generation and slot epochs (API.md) |
| Why the counts differ | most cells the tail reaches were open already | many such cells are met there: F-01, F-02, F-04, P-03, P-07, P-09, P-10, P-13, P-17 (computed). The same tail reaches the rest on a memory resource (reasoned) |
| The model | E-47 covers transactions, fences, lock rows, refusals and the recovery's cut | E-47 does not cover sagas or client sessions. E-24 and E-20 with a lost tail are still owed (VERDICT §9 step 2b) |
| Exactly once on memory | lost under {R2}: no transaction id; a caller id restores it (reasoned) | kept: COMP2's client sessions carry a floor per session, and RR-13's recovery starts a new session generation (API.md) |
| Per-kind-of-write form (e1) | open to it | ruled out by AMENDMENTS footnote 13: groups are cut by durability |
| JetStream's one-client line with `memory` | about 0.42 ms (Rust) | about 0.39 ms (Rust): no oracle hop, more room, still above 0.303 (reasoned) |
| Kafka's top speed with `persisted` | below E-02's margins: an LSM and two-phase commit come on top | exactly E-02's: 1.10 times the bar in TypeScript, 1.35 times in Rust (reasoned) |
| Cost per project | $18.64 to $19.01 a month at 10 writes/s | $7.52 to $7.89 (E-41's recheck), unchanged by the rung |

The same recommendation holds there in kind: the refusal form, built second, after its own lost-tail models (E-24, E-20) pass. Its recovery needs rule 15 too (reasoned: the same Raft groups, the same lost tail).

## 5. The API it would mean

**How a resource asks for it.** [API.md](API.md#3-the-declarations) already has the key, and it carries over to TiKV's shape unchanged.
- `durability?: 'persisted' | 'memory' | 'none'` is a resource key. The default is `'persisted'`.
- It is set per resource, never per write. A per-write `durability` does not compile ([API.md §10](API.md#10-how-this-file-is-checked)).
- Until the rung is built, `fero()` throws `config` for `durability: 'memory'`. So the first slice ships the key, and adding the rung later changes no type.
- Changing it online goes through `fero.alter`, an open question (Q-A25 in [API.md §9](API.md#9-open-api-questions)).

**What changes from API.md.** API.md is written for COMP2, whose unit across partitions is `saga()`. TiKV's shape has transactions (two-phase commit) instead, and API.md names no call for them yet. The refusal code, `needs-persisted`, is the same (reasoned). API.md's exactly-once comes from client sessions; under {R2} a memory write has no such dedup, so a resent write may apply twice unless it carries an `id` (section 3.3).

**What is refused, and with which error.**

| What | When | Error | Backed by |
|---|---|---|---|
| `durability: 'memory'` before the rung is built | at `fero()` | `config` (thrown) | [API.md §5](API.md#5-errors-and-refusal-codes) |
| a write with `if: { fence }` on a memory resource | before it is written | `needs-persisted` | E-47's R2.put, model-checked |
| a transaction with any key on a memory resource | before its first prewrite | `needs-persisted` | E-47's R2.txn, model-checked |
| `rows: { while: 'session' }` or `history: 'all'` on a memory resource | at create | `needs-persisted` | API.md's RR-14 list and the costs pass; reasoned |
| a write with `while: 'session'`, or a derived output aimed at a memory resource | at the call, or when the derive starts | `needs-persisted` | the same; reasoned |
| after an unclean recovery: a cursor from before it | when the client resubscribes | `unknown-log`; the client takes a fresh snapshot | reasoned |
| after an unclean recovery: a write copy sent before it | when the copy lands | `restored` (outcome unknown, final) | API.md's `restored` code; reasoned |

**Allowed on a memory resource, with the weaker "ok"** (section 3.3): `set`, delete, ops such as `incr`, conditions with `if` (other than a fence), and bounds such as `incr` with `min`/`max`. Locks, queues, limiters and consumer groups never put their own state on a memory resource, so nothing about them is refused there.

`needs-persisted` has the outcome `refused`: nothing was written ([API.md §5](API.md#5-errors-and-refusal-codes)).

**A short sample.** It type-checks against API.md's own declarations (`fero.d.ts`, `env.d.ts`) with TypeScript 6.0.2, as API.md §10 checks its blocks (run here; a planted `durability: 'mem'` fails). The refusal itself is a runtime check, not a type.

```ts
// file: memory.ts — a memory resource, and what it refuses
import { fero, lock } from 'fero'

const prices = await fero('prices', { durability: 'memory', rows: { ttl: '5m' } })   // a cache
await prices.set('sku-1', { cents: 499 })    // answered once two of three servers hold it in memory

const l = await lock('repricer', { lease: '10s' })
await prices.set('sku-1', { cents: 599 }, { if: { fence: l.fence } })   // refused 'needs-persisted'

const orders = await fero('orders')          // 'persisted', the default
await orders.set('o-77', { sku: 'sku-1', cents: 499 }, { if: { fence: l.fence } })   // fine
```

## 6. What stays open

### 6.1 Models

Before the memory rung is built (each reasoned as needed; none run):
1. **Splits and merges with a lost tail**, on E-17's harness, which lists unclean recovery as left out. F-03 rests on it. Not needed for (a0).
2. **The operator's recovery with a lost tail**, beyond raftcheck's log check: the controller sets the new members and key range (rule 15), copies left over from a lost split are removed, and the group serves again. E-47 models it as an instant restart.
3. **Change feeds with time cursors** and the incarnation check. E-31 modelled slot cursors, not times. P-03 and P-05 rest on it.
4. **Plain writes, ops and conditions on a memory range, and their retries**, caller ids included. E-47 left them out. Also worth a run: a one-key write with its own transaction id (TiKV's one-phase commit, no lock for a reader to clean up). If it holds, memory writes get exactly once back.
5. **A second unclean stop** before the first heals.
6. **A power-cut test on an LSM** with memory and `persisted` ranges on one server. It checks that no `persisted` range is wiped and that a `persisted` fsync also syncs earlier memory entries. E-29's power-loss runs used a journal, not an LSM.
7. **DEV-10's guard-by-guard count and mutants** for the chosen rules, and a second agent's rerun (DEV-10 (e)).
8. Only if (e1) or {R1s, R3, R2.claim} is ever wanted: their own models. (e1) needs its reader rule.
9. For MIN-P+par instead: E-24's saga and lock models and E-20's dedup model with a lost tail (VERDICT §9 step 2b).

### 6.2 Timings

1. **The gate.** On the `persisted` slice, a single-range write's p99 at 50,000 writes a second, split into its parts: the flush, the oracle hop, the forward, the LSM's work. If the flush is at least half of it, the rung can at least halve it (reasoned; this gate is this page's proposal).
2. **The Redis lines, closed loop.** memtier at 200 and 3,200 in flight through the gateway, on both rungs. Lines 1 to 4 need about 160,000 to 950,000 writes a second (section 2.2). This is the timing that says whether the rung wins any Redis line.
3. **VERDICT's kill test 6b, only if JetStream's line still matters.** `nats bench js` through the gateway, one write in flight, client hop included. The bar: p99 under about 0.30 ms and at least about 4,340 acks a second. Estimates: TypeScript 0.69 ms, Go 0.54, Rust 0.42 (reasoned). Rust wins only if the kernel's own work adds less than about 0.07 ms at p99. On the user's frame this test no longer decides whether a design is in. It decides only whether the rung wins that line.
4. **`memory` at 1 KiB, on preallocated files, with a real background flush** (lines 3, 4 and 7).
5. **TiKV's own parts:** the oracle's round trip, Percolator's two rounds, and an LSM compacting beside commits.
6. **A disk per copy, with stalls.** E-02's emulation left out E-01's 20-50 ms stalls, and lines 3, 4 and 6 turn on them.

### 6.3 What would change the recommendation

- **The gate fails.** If the oracle, two-phase commit and the LSM leave the flush a small part of a write's p99, the rung buys too little. Then build (d) only.
- **A model breaks with no closer.** If splits, merges, the recovery or feeds break a MUST under a lost tail with no rule that fixes it, kill test 2b fires, and the rung goes.
- **The user wants transactions on memory resources.** Then {R1s, R3, R2.claim} (256 to 274 pairs, perhaps 1 novel) or (e1) after its model.
- **The user wants a strict "ok" on memory** (no vanished conditional ok, no double count on a resend). Then refuse conditions, bounds and unkeyed ops on memory too, or wait for the one-phase-commit model (6.1 item 4). Plain `set` alone stays.
- **The user wants no operator step after a power cut.** Then no memory option. (e6), automatic recovery, breaks F-12.
- **The user accepts SC-03's ceiling for memory resources.** Then (a0) can come first, without the split model.
- **The user wants JetStream's one-client line.** Then only a native kernel with the rung, and only if its own work stays under about 0.07 ms at p99. TypeScript cannot.
- **Deploys run on cloud disks with millisecond flushes.** The gain grows (reasoned from a cited figure). That strengthens the case.
- **The strict DATA-01 reading after all.** Then MIN-P+par is built, and the memory option there is COMP2's rung, with section 4.4's differences.

## 7. Sources

### 7.1 Files used

**The study.**
- [VERDICT.md](VERDICT.md): §8 (items 2 and 15) and §9 (step 2b, the kill table rows 6b and 2b).
- [candidates/TiKV-TS.md](candidates/TiKV-TS.md), [candidates/TiKV-persisted.md](candidates/TiKV-persisted.md), [candidates/MIN-P+par.md](candidates/MIN-P+par.md), and the `repro` script in [candidates/README.md](candidates/README.md#reproduce-a-computed-claim).
- [judging/closure/hybrids/B.settled.json](judging/closure/hybrids/B.settled.json): rows B1 (TiKV-TS) and B2 (TiKV-persisted), their P-15, F-01, F-12, SC-05 and PERF-04 cells, the mechanism notes and the leads.
- [judging/closure/rerulings.cells.json](judging/closure/rerulings.cells.json): RR-04 and RR-11 to RR-16.
- [judging/closure/results/ladder-restated-PERF-01_losses.md](judging/closure/results/ladder-restated-PERF-01_losses.md).
- [AMENDMENTS.md](AMENDMENTS.md): section 2 (Q), section 4 (K-09, K-10, K-24, footnote 13), section 5 (G-05).
- [API.md](API.md): sections 0 to 5, 8, 9 and 10, and its library rule ("the libraries keep their own state ... on `persisted` resources").
- [REQUIREMENTS.md](REQUIREMENTS.md): P-02, P-03, P-05, P-10, P-11, P-14, P-15, PERF-01, PERF-04, F-01, F-02, F-03, F-07, F-12, SC-03, SC-06.
- [SPACE.md](SPACE.md): the Q axis.
- `tools/closure.py`: the cells, counts and pair rule. [judging/mechanisms.json](judging/mechanisms.json): the settled `memory-rung` unit and its precedent (KIP-966), and the units `lock-rows`, `range-table`, `meta-directory` and `subscribe` that the rules read.

**The experiments.**
- [E-47] and its results: [base.txt](experiments/E47-memory-rung/results/base.txt), [info.txt](experiments/E47-memory-rung/results/info.txt), [sets.txt](experiments/E47-memory-rung/results/sets.txt), [subs.txt](experiments/E47-memory-rung/results/subs.txt), [greedy.txt](experiments/E47-memory-rung/results/greedy.txt), [verify.txt](experiments/E47-memory-rung/results/verify.txt), [raftcheck.txt](experiments/E47-memory-rung/results/raftcheck.txt), [runs.json](experiments/E47-memory-rung/results/runs.json), [summary.md](experiments/E47-memory-rung/results/summary.md).
- [E-01] (floors: [the fsync table](experiments/E01-floors/results/fdatasync-1w-cdf.txt) and [the round trips](experiments/E01-floors/results/rtt.jsonl)), [E-02] (the pipeline and its rungs; `ts/pipeline.ts` for the write order), [E-09a], [E-09a2] (and its [results/tables.md](experiments/E09a2-redis-memtier/results/tables.md); its section 1 for Little's law), [E-09b], [E-09c], [E-09d], [E-09e], [E-13] (catch-up per GB), [E-17] (what its models leave out), [E-41] (cost, and its recheck).
- Named here only as VERDICT, the rulings, E-47 and the costs pass cite them, not re-read: E-20 (dedup), E-24 (sagas and locks), E-29 (power loss on a journal), E-31 (subscribe).

The first draft also drew on working notes outside the repository (a gains pass and a costs pass). Their numbers were re-checked against the files above, and everything this page uses from them is in it.

### 7.2 How to check the numbers

Run from `docs/v5-space`. Define `repro` as [candidates/README.md](candidates/README.md#reproduce-a-computed-claim) shows:

```sh
repro() { python3 -c "$(awk '/^```python repro$/{f=1;next} /^```$/{f=0} f' candidates/README.md)" "$@"; }
```

| Claim | Command | Result, run here 2026-11-12 |
|---|---|---|
| the order on the frame | `repro rank --loss` | TiKV-persisted 0 / 5 / 233 first; TiKV-TS 0 / 4 / 244 second; MIN-P+par 3 / 6 / 264 fourth |
| what the rung moves on TiKV's shape | `repro differ TiKV-persisted TiKV-TS --loss` | P-15 M and S: met / open |
| the same without the loss | `repro differ TiKV-persisted TiKV-TS` | also PERF-04: fails / open |
| the rung on TiKV-persisted | `repro row 'Q=mix' TiKV-persisted --loss` | 0 / 4 / 244, 122 open, 1 guessed cell (PERF-08) |
| the twin without the rung | `repro row 'Q=maj-d' TiKV-TS --loss` | 0 / 5 / 233, 121 open, no guessed cell |
| what the rung moves on MIN-P+par | `repro differ MIN-P+par COMP2 --loss`; `repro row 'Q=mix' MIN-P+par --loss` | P-10, P-15 M, F-02: met / open; 3 / 6 / 277 |
| the forms' pairs | the `memory-pairs` script below | 233, 244, 246, 248; (a) 253-267; (a0) 251-265; (b) and (e1) 251-265; {R1s, R3} 256-270 or 260-274; MIN-P+par 264, 277, 279, 281 |
| the floors of section 2.2 | the `memory-floors` script below | race p99 323 µs; `persisted` bound 356 µs (TypeScript), 328 (Rust), 321 (Go), estimates 442, 415, 408; `memory` 689 / 422 / 535 µs (TypeScript / Rust / Go) |
| the recovery's cut | `python3 experiments/E47-memory-rung/tools/raftcheck.py` | rule 15: no cut below k; from the survivor: 2 to 1,764 cuts below k |

```sh
python3 -c "$(awk '/^```python memory-pairs$/{f=1;next} /^```$/{f=0} f' MEMORY.md)"
python3 -I -c "$(awk '/^```python memory-floors$/{f=1;next} /^```$/{f=0} f' MEMORY.md)"
```

```python memory-pairs
# Pairs for each memory form, by closure.py's own pair rule, on in-memory copies of the units.
# Run from docs/v5-space. No study file changes. Which unit reads a new state is a reasoned choice,
# so every form is priced twice: 'low' puts each check where its state is already read, 'high' at the call.
import sys, itertools, copy
sys.path.insert(0, 'tools')
import closure as C
ROWS, MS, CM = C.all_rows(), C.mech_rows(), C.mech()
def units(base, q):
    v = dict(ROWS[base]); v['Q'] = q
    return [copy.deepcopy(MS[e['key']]) for e in CM['mechanisms'] if C.carries(e, v)]
def add(got, key, reads=(), writes=()):
    m = next(m for m in got if m['key'] == key)
    m['reads'] = list(dict.fromkeys(list(m['reads']) + list(reads)))
    m['writes'] = list(dict.fromkeys(list(m['writes']) + list(writes)))
    return got
def n(got):
    return sum(1 for x, y in itertools.combinations(got, 2) if set(x['writes']) & set(y['reads'] + y['writes'])
               or set(y['writes']) & set(x['reads'] + x['writes']))
def count(got):
    return '%d novel, %d pairs, %d mechanisms' % (sum(bool(m['novel']) for m in got), n(got), len(got))
def rules(g, hi, splits):
    """Section 4.2's rules every memory form needs, beyond its refusals (rules 4 to 15)."""
    add(g, 'lock-rows', ['tso.high'])                                 # 4: tokens (and versions) are oracle times
    add(g, 'memory-rung', ['durable.log', 'disk.incarnation'])       # 9, 10: the 1 s window; the failed-fsync stop
    add(g, 'controller-commands', ['durable.log', 'group.unclean'])  # 15: `fero recover --unclean`, a controller command
    if hi:
        for k in ('queue-claims', 'consumer-groups', 'presence-rows'):
            add(g, k, ['meta.catalog'])                               # 5: checked at the call, not at create
        add(g, 'subscribe', ['disk.incarnation'])                     # 11: the cursor check reads the disk incarnation
        add(g, 'controller-commands', writes=['range.table'])         # 12: the recovery raises the range generation,
        add(g, 'writer-judging', ['range.table'])                     #     and the writer judges a copy against it
    else:                                                             # 5, 11: at create; meta.directory's incarnation
        add(g, 'range-table', ['meta.commands'])                      # 12: the range table raises it on the command
    if splits:                                                        # 13: split and merge entries wait for disk
        add(g, 'memory-rung', writes=['group.dcommit'])
        add(g, 'split-record', ['group.dcommit']); add(g, 'merge-record', ['group.dcommit'])
    return g
def both(make, splits=True):
    return '%d (low) to %d (high)' % tuple(n(rules(make(), hi, splits)) for hi in (False, True))
for base, tx in (('TiKV-persisted', 'two-phase-commit'), ('MIN-P+par', 'saga-intents')):
    print(base)
    print('  (d) no memory rung:', count(units(base, 'maj-d')))
    print('  the rung as judged, no rules:', count(units(base, 'mix')))
    print('  R2.txn only (the transaction refuses a memory key):', count(add(units(base, 'mix'), tx, ['meta.catalog'])))
    R2 = lambda: add(add(units(base, 'mix'), tx, ['meta.catalog']), 'writer-judging', ['meta.catalog'])
    print('  {R2}, its refusals only:', count(R2()))
    if tx != 'two-phase-commit':
        continue        # rules 4 to 15 and the other forms are priced for TiKV's shape only; footnote 13 rules (e1) out here
    print('  (a) {R2} with every rule of 4.2:', both(R2))
    print('  (a0) the same, memory resources never split or merge:', both(R2, splits=False))
    print('  (b) R1, rungs never share a range:', both(lambda: add(units(base, 'mix'), tx, ['meta.catalog'])))
    E1 = lambda: add(add(add(units(base, 'mix'), 'memory-rung', writes=['group.dcommit']), 'writer-judging', ['group.dcommit']),
                     tx, ['group.dcommit'])
    print('  (e1) per kind of write:', both(E1))
    def r13(fence_judges=False, own_unit=False):
        r = add(add(units(base, 'mix'), tx, ['meta.catalog', 'group.epoch']), 'mvcc', ['group.epoch'])
        if own_unit:
            r.append({'key': 'unclean-epoch', 'novel': False, 'reads': ['group.unclean', 'tso.high', 'group.log'],
                      'writes': ['group.epoch', 'fence.table']})
            return r
        if not fence_judges:
            return add(r, 'memory-rung', ['tso.high'], ['group.epoch', 'fence.table'])
        add(r, 'memory-rung', ['tso.high'], ['group.epoch'])
        for k in [m['key'] for m in r if 'fence.table' in m['reads']]:
            add(r, k, ['group.epoch'])
        return r
    print('  {R1s, R3}, the epoch raises fence tables:', both(r13))
    print('  {R1s, R3}, fence judges read the epoch:', both(lambda: r13(fence_judges=True)))
    print('  {R1s, R3}, the epoch as its own unit (counted not novel; not ruled):', both(lambda: r13(own_unit=True)))
```

```python memory-floors
# One write in flight, one range: floors from E-01's measured parts (arithmetic, no timing). Run from docs/v5-space.
import bisect, json
R = 'experiments/E01-floors/results/'
q = sorted(float(l) for l in open(R + 'fdatasync-1w-cdf.txt') if l.strip() and not l.startswith('#'))
def race(p):                                  # 2nd fastest of 3 independent fsyncs: G = 3F^2 - 2F^3
    for x in q:
        f = bisect.bisect_right(q, x) / len(q)
        if 3 * f * f - 2 * f ** 3 >= p:
            return x
rtt = [json.loads(l) for l in open(R + 'rtt.jsonl')]
def hop(impl, key):                           # median over runs of the 1 KiB loopback round trip
    v = sorted(r[key] for r in rtt if r['impl'] == impl and r['bytes'] == 1024); return v[len(v) // 2]
print('race p99 %.0f us (RR-15: 323); bar: p99 < 303 us, mean ack < %.0f us (4,340 acks/s)' % (race(.99), 1e6 / 4340))
E02 = {'rust': 330, 'go': 450, 'node': 570}  # E-02 `memory` p99 at 50,000/s, us (node = TypeScript)
for impl in ('rust', 'go', 'node'):
    m, p = hop(impl, 'p50_us'), hop(impl, 'p99_us')
    print('%-4s hop p50 %.1f p99 %.1f us | persisted, 3 hops: bound %.0f, estimate %.0f | memory: wire 4 hops %.0f-%.0f,'
          ' E-02 tail + 3 hops %.0f, + 2 hops (no oracle, MIN-P+par) %.0f us'
          % (impl, m, p, race(.92) + 3 * m, race(.99) + 3 * m, 4 * m, 4 * p, E02[impl] + 3 * m, E02[impl] + 2 * m))
for impl in ('rust', 'node'):                 # a persisted write across two ranges: prepare, then commit; two oracle hops
    m = hop(impl, 'p50_us')
    print('%-4s across two ranges, persisted: median about %.0f us, p99 about %.0f us' % (impl, 2 * race(.5) + 4 * m, 2 * race(.99) + 4 * m))
```

**The lower bound, in words.** For independent parts, the chance that a sum exceeds a + b is at least the chance each part exceeds its own share. So with each hop at its median (a 1-in-2 chance above it), a p99 of fsync race plus three hops is at least the race's p92 plus three hop medians (RR-15's argument, with TiKV's hops).

**The Redis throughput bars, in words.** At a fixed depth D, mean latency = D ÷ rate. Redis's own p99 is about 1.8 to 2.1 times its mean. So to get under a p99 bar B with a tail as narrow, fero needs a mean under B ÷ that ratio, and a rate above D ÷ that mean. For SET at pipeline 1: 2.14 ÷ 2.07 = 1.03 ms, and 200 ÷ 1.03 ms = about 194,000 a second.

## 8. What the review changed

A skeptic's review found 13 problems in the first draft. Each was checked against the files.
- **F1, the recovery path.** E-47 had checked only elections by vote, which the settled rule forbids after an unclean stop. raftcheck now checks the operator's recovery too. Rule 15 is new, and rule 13's second closer is back.
- **F2, the price.** Rules 5, 11, 12 and the new 15 now count their reads: 253 to 267 pairs, not 250.
- **F3, the weaker "ok".** One answer now: one-row conditions, bounds and ops are allowed on memory with a weaker "ok"; libraries keep limits on `persisted` resources; a resent memory write may apply twice unless it carries an `id`.
- **F4, the Redis lines.** They are closed-loop benchmarks, so E-02's open-loop p99 did not predict them. Now open on both rungs, with the rate each needs.
- **F5, how sure.** Under {R2} the modelled programs are refused at once, so section 0 now says what was and was not checked.
- **F6, one holder per lease.** E-47 gained a property for it (HOLDERS). It breaks without lock rows off memory, even with oracle tokens. So {R1s, R3} alone no longer holds; {R1s, R3, R2.claim} does.
- **F7, F9:** two number slips fixed (line 5's TypeScript bound; the order of the preallocated speeds).
- **F8:** "versions are oracle times" is now a design rule, not a given.
- **F10, F11, F13** are in E-47's README and scripts, and in the wording here: the kill -9 note, a stale result file, a cache that now knows the model's version, the lock fallback, and terms explained at first use.
- **F12, the variant with no splits** is now form (a0).

[E-01]: experiments/E01-floors/README.md
[E-02]: experiments/E02-pipeline/README.md
[E-09a]: experiments/E09a-redis/README.md
[E-09a2]: experiments/E09a2-redis-memtier/README.md
[E-09b]: experiments/E09b-nats/README.md
[E-09c]: experiments/E09c-kafka/README.md
[E-09d]: experiments/E09d-redpanda/README.md
[E-09e]: experiments/E09e-etcd/README.md
[E-13]: experiments/E13-handover/README.md
[E-17]: experiments/E17-partitioning/README.md
[E-41]: experiments/E41-hosted-cost/README.md
[E-47]: experiments/E47-memory-rung/README.md
