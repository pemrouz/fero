# A memory option for fero v5

2026-11-12, revised the same day after a skeptic's review (13 findings; what changed is in section 8), and again after the owner asked about acks per operation (section 9, which changes section 0). A second review then corrected section 9 (19 findings; section 8). The user asked whether fero v5 should offer a `memory` option, and how much hassle it brings. This page answers for TiKV's shape, the design the study's arithmetic picks on the frame the user chose (section 1). MIN-P+par, the fallback design, is noted where it differs. MIN-P+par keeps `data`'s fold on every server, cuts keys into fixed hash slots held by Raft groups, and has only the `persisted` rung ([candidates/MIN-P+par.md](candidates/MIN-P+par.md)).

**How each claim is marked.**
- **Measured**: the experiment and its numbers are named.
- **Model-checked**: [E-47]'s or [E-48]'s model explored every reachable state, at small bounds.
- **Checked by brute force**: E-47's `raftcheck.py` or E-48's `raftcheck48.py` tried every case on three explicit copies.
- **Computed**: `tools/closure.py`, the `repro` script of [candidates/README.md](candidates/README.md#reproduce-a-computed-claim), or one of the scripts in sections 7.2 and 9.8.
- **Cited**: a published system, as the study's files cite it; in section 9.5, a source read in this pass, linked in 9.8. "From memory" means nobody checked it here.
- **Reasoned**: an argument. Nothing ran it.

This page changes no other study file. The experiments it adds are [E-47] and [E-48].

## 0. The recommendation

**Revised the same day, after the owner asked about acks per operation (section 9), and corrected after a second review of that section (section 8).** The first answer is kept below, marked superseded.

1. **Build `persisted` only first.** Unchanged.
2. **Second: answer stages per call (S1), not the memory rung.** Every write still commits on disk at two of three servers before anyone else can see it. A plain write's handle can also be awaited earlier: at `received` (the range's leader has it in its log) or at `replicated` (two of three servers hold it in memory). An early answer says only how far the write got, not that it will commit (item 9). Writes that answer with a value or a decision (ops, conditions, fenced writes, claims, batches, transactions) answer at commit only. This is the v5 draft's `confirm: 'sent'`, grown to the three stages the owner named.
3. **Why** (section 9):
   - it gives the writer about the memory rung's answer time. At p99, `replicated` takes about 0.69 ms in TypeScript, against 4.45 ms for a commit when the three copies share one disk and 2.52 ms with a disk per copy; in Rust, 0.42 against 1.67 and 0.76 ms (reasoned from E-02's measured stages plus TiKV's hops; the journal it needs was never timed, 9.3);
   - nobody but the writer can ever be told something that later vanishes: no lost visible tail, no kind of write refused, no operator step (model-checked at small bounds, [E-48]);
   - Raft's commit, election and recovery rules stay exactly `persisted`'s (checked by brute force, [E-48]). Its messages, its journal and the leader's marks do change (9.4);
   - it costs 0 to 8 more interacting pairs (the study's measure of how many parts touch the same state: 233 → 233 to 241), against 20 to 34 for the memory rung (computed).
4. **Its three rules** (model-checked, each needed):
   - **W1**: the libraries' own steps wait for committed answers, so only the caller's last answer comes early.
   - **O.seq**: each writer numbers its writes, and a range refuses a gap. This is the "issue order" every row already owes (AMENDMENTS A-10; [E-45] F4). With S1 even a client that awaits each answer needs it, since awaiting an early answer no longer keeps order.
   - **Y**: a client's read waits until its own early-answered writes are visible.
5. **What it does not buy:** faster reads or subscribers; read-your-writes from a sync read before the commit (item 8); the third less CPU; the higher top speed; riding a disk stall for anyone but the writer. And a loop of early answers is still capped by how many unfinished writes the server lets a client hold (its credit grant, 9.3).
6. **Third, and only for a timed need S1 cannot meet:** readers or subscribers that must see writes before the disk has them; the CPU; Kafka's top speed in a native build; or JetStream's 16-client line, if the referee rules that an answer stage is not a rung, or refuses an early JetStream answer with a sequence number that may change (9.3). Then the memory rung per resource, form (a), exactly as the superseded answer below says. It combines with S1 (A+S1+S4, where S4 lets a memory resource's write also await the disk: 254 to 276 pairs).
7. **When:** after the `persisted` slice is timed, if waiting for the disk (the **fsync**, which forces a write from memory onto the disk) is at least half of a write's p99 there (the gate of 6.2), and once S1's journal is timed: each batch handed to the operating system on arrival, with the fsync in the background (9.7).
8. **Rulings it needs** (9.7):
   - **The benchmark rule.** PERF-01 says that at a competitor's default settings, fero's "matching rung" must win. Does an answer stage count as a rung, for Redis (PERF-02) and JetStream (PERF-04)? If not, S1 moves no benchmark line. If so, S1 likely wins JetStream's 16-client line, but only if an early JetStream answer may carry a sequence number that a lost write would change. The memory rung likely wins that line either way (reasoned).
   - **F-01** ("no lost acknowledged write"): "acknowledged" must mean the committed answer.
   - **Read-your-writes (P-01):** after an early answer it holds for reads that wait (Y), and for sync reads only from the committed answer.
   - **The "answer after commit" rules** (A-04 and REQUIREMENTS' default line) must allow a plain write to say how far it got. And TiKV-persisted's own card says "on disk at a majority before the ack", so a referee must accept S1 as a change of that row (the second ground of the referee's ruling RR-14, 9.1).
9. **What an early answer promises:** the write got that far, and nothing more.
   - `received` can be lost on any leader change. `replicated` can be lost on one machine's power cut. So `replicated` is about as fast as the memory rung's "ok", but weaker: the memory rung's "ok" survives one power cut. ("All three copies hold it" survives one power cut too, at the slowest copy's speed.)
   - If its copy is lost, fero resends the write, and the new leader judges it again. It can then be refused: by a `rules.write` that reads the row, a field write whose row was removed, `read-only` or `disk-full`.
   - It is lost for good if your process stops, or your session lapses, before it commits. Past its `timeout` the handle rejects `timeout` (outcome unknown), and fero keeps resending it while the session lives (API.md's rule).
   - An early answer never carries a value.
10. **How sure.**
    - **Medium** that nobody but the caller is misled: model-checked at small bounds, by one agent, with no mutants; the Raft step checked by brute force.
    - **Low** on the caller's own contract. E-48's plain writes are one writer, one key and up to three writes that can never be refused. Refusable plain writes, a client that stops, order across ranges, splits and moves, and subscribers are not modelled.
    - **Low** on speed: reasoned from measured parts, and S1's journal was never timed.

### 0.1 Superseded: the first answer (2026-11-12)

**Why it was superseded.** It never weighed answer stages per call. Those give the writer about the answer time of item 8's first bullet below, with far fewer of item 9's costs: no operator step and no lost visible tail, and 0 to 8 more pairs instead of 20 to 34. They bring costs of their own: an early answer that is weaker and must be learned, three rules, new parts in the journal and the follower reports, and several rulings (section 9). The memory rung still buys what they cannot (fast visibility, CPU, top speed), so it stays, as the third step.

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
| **(e1) Per kind of write**: plain writes answered from memory; transaction records, fenced writes, claims, cursors, splits and merges wait for disk | 49 (0) | **251 to 265**, in memory | P-15 back to its `persisted` support, once modelled (reasoned) | replayed by hand on E-47's traces: the snapshot-read and clean-up breaks remain unless a reader also waits for disk before it acts on a transaction's commit (reasoned). **Now model-checked** in [E-48] as S3: ATOMIC 21 and 22; it holds once readers of transaction keys read only the disk prefix (RD.txn), section 9.2 | "Plain writes on a memory resource are fast and can be lost. Writes others rely on wait for disk." | expects a memory resource's transactions to be fast |
| **(e2) A clean stop judged by boot id** | +0 | +0, reasoned | removes the kill -9 path to F-07 | reasoned | nothing new | — |
| **(e3) Memory only across separate hosts** | +0 | +0, reasoned | none | reasoned. On one box it gives no speed, so PERF-01's same-box test lines would see no gain. Better as a health warning than as a rule | "On one machine, memory waits for disk like `persisted`." | — |
| **(e4) A flush call**: `flush()` waits until the disk has the caller's writes (per write, it is S4 of section 9) | +0 on (e1) | reasoned | none | — | "Call `flush()` before you tell a person their write is saved." | — |
| Rejected: (e5) the leader alone answers; (e6) automatic unclean recovery | — | — | (e5) loses answered writes on every leader crash. (e6) cannot list what may be lost before it runs (F-12) | — | — | — |

Notes on the table.
- **The SHOULD count.** Every memory form starts at 4 SHOULDs (P-15's SHOULD is open as judged). It goes back to 5 only if a referee accepts E-47 (or (e1)'s own model) for P-15.
- **Rule 3 never prefers a memory form** once the loss is accepted. Even at 5 SHOULDs, 251 to 274 pairs lose to 233 (computed). Picking a memory form means picking speed over rule 3's count. That is the user's call.
- **(a0) against (a).** (a0) drops rule 13, the split and merge model (6.1 item 1), and the one met MUST at risk (F-03). It costs about 2 pairs less. But a memory resource is then one Raft group: one leader's write rate and one server's memory and disk. SC-03 asks a resource to grow to 64 writers, and SC-06 lets it outgrow one server; (a0) meets neither for memory resources (reasoned). A cache can live with that; a hot counter shared by many servers cannot. So (a) stays the target. (a0) is a fair first step only if the user accepts SC-03's ceiling as a loss for memory resources until splits come.
- **(e1) is the strongest idea, but not first.** PostgreSQL's per-transaction `synchronous_commit` and MongoDB's per-write `j` option are precedents (cited in section 9.5). But E-47's snapshot-read and clean-up traces, replayed by hand on (e1), let a reader act on a commit that is not yet on disk (reasoned). Before (e1) is used, its reader rule needs its own model. [E-48] has now run it: the gap is real, and RD.txn closes it (section 9.2).

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
- **Against (e1):** it is the richest form, but the hand replay above shows a gap, and [E-48] confirms it. Its fix puts every reader of a transaction on the disk prefix, and its plain writes still carry the memory contract on every resource (section 9.4).
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
| Answer stages per call (S1, section 9) | open to it | open to it too: footnote 13 rules out commit levels per write, and S1 moves no commit point (reasoned). COMP2's client sessions already carry a per-writer sequence (API.md) |
| JetStream's one-client line with `memory` | about 0.42 ms (Rust) | about 0.39 ms (Rust): no oracle hop, more room, still above 0.303 (reasoned) |
| Kafka's top speed with `persisted` | below E-02's margins: an LSM and two-phase commit come on top | exactly E-02's: 1.10 times the bar in TypeScript, 1.35 times in Rust (reasoned) |
| Cost per project | $18.64 to $19.01 a month at 10 writes/s | $7.52 to $7.89 (E-41's recheck), unchanged by the rung |

The same recommendation holds there in kind: the refusal form, built second, after its own lost-tail models (E-24, E-20) pass. Its recovery needs rule 15 too (reasoned: the same Raft groups, the same lost tail).

## 5. The API it would mean

**How a resource asks for it.** [API.md](API.md#3-the-declarations) already has the key, and it carries over to TiKV's shape unchanged.
- `durability?: 'persisted' | 'memory' | 'none'` is a resource key. The default is `'persisted'`.
- It is set per resource, never per write. A per-write `durability` does not compile ([API.md §10](API.md#10-how-this-file-is-checked)). That is the commit level. An answer stage per call is a different thing (section 9.6).
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
8. Only if (e1) or {R1s, R3, R2.claim} is ever wanted: their own models. (e1)'s reader rule is now model-checked ([E-48], RD.txn); its plain writes are not.
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
- **S1's journal times badly.** If early reports wait behind the background fsyncs, so that `replicated` is not much faster than the commit, S1 buys little, and the memory rung moves back to second (section 9.7).
- **A need S1 cannot meet appears.** Readers or subscribers must see writes before the disk has them, or the CPU or Kafka's top speed matters, or JetStream's 16-client line must be won and the referee rules that an answer stage is not a rung (or refuses an early answer with a sequence number that may change, 9.3). Then the memory rung comes third, combined with S1.
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
- [E-48] and its results (section 9). [E-45]: F4 (issue order) and F7, and its JetStream gateway, [lib/jetstream.ts](experiments/E45-drivers/lib/jetstream.ts), whose PubAck takes its sequence from the committed version (section 9.3).
- For section 9 also: [AMENDMENTS.md](AMENDMENTS.md) A-07 (the credit grant) and A-10 (issue order, caller keys); [API.md](API.md) section 4 (the writer's order of checks, issue order, retries and `timeout`) and section 5 (the error table).
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
| the per-operation forms | section 9.8 | section 9.8 |

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

**Later the same day: acks per operation** (section 9). The owner asked whether guarantees per operation, awaited at different acks, had been ruled out. They had never been weighed: what was ruled out was a commit level per write, for COMP2's shared groups. [E-48] modelled them. **Section 0 changed:** answer stages per call (S1) now come second, and the memory rung third. The reason: S1 gives the writer about the rung's answer time with no lost visible tail, no change to Raft's commit, election or recovery rules, no kind of write refused and no operator step, for 0 to 8 pairs instead of 20 to 34; what it does not give (fast visibility, CPU, top speed) is what the rung is kept for. Also, (e1)'s gap, found by hand in 4.1, is now model-checked, and so is its reader rule.

**A second review, of section 9** (19 findings, C1 to C19, each checked against the files; all held). What changed:
- **C1, C12: what an early answer promises.** fero's plain writes are judged too (shape checks, `schema`, `rules.write` with the current row, `read-only`, `disk-full`), so a resent copy can be refused. An early answer now says only how far the write got. A write is lost for good if the process stops or its session lapses first; past its `timeout` the handle says `unknown` and fero keeps resending.
- **C2, C7: JetStream's 16-client line.** A JetStream answer carries a sequence number made from the commit, which an early answer cannot know. So S1 wins that line only with a ruling that allows a provisional number, and A's trigger list now names the line.
- **C3: O.seq is A-10's owed issue order** ([E-45] F4). The "applied twice" half of ORDER 6 comes from a model with no write ids, which TiKV-persisted's transaction ids cover. The price moves by 1 pair at most (233 → 234; computed).
- **C4: read-your-writes** for sync reads after an early answer is now a ruling (9.7).
- **C5, C6: speed and strength.** Section 0 gives both disk baselines, and says that `replicated` is weaker than the memory rung's "ok" under one power cut.
- **C8, C13, C14: wording.** 0.1 no longer says S1 has none of the rung's costs. The owner's answer names RR-14's second ground. "Raft does not change" now says which part: its commit, election and recovery rules.
- **C9, C10: facts.** An `incr`'s or a condition's changed result is reasoned, not modelled. PostgreSQL's `on`, `remote_write` and `remote_apply` keep a commit hidden until the standby confirms (S1-like); `off` and `local` are S2-like (cited, 9.5).
- **C11: how a plain write rides TiKV's shape** is now stated (9.4), and its model is owed (9.7).
- **C15: how sure** is split by claim.
- **C16: the credit grant** caps a loop of early answers (9.3).
- **C17: the API.** Stage promises are made on first use, `durable` on a `none` resource is defined, and the unused `Stage` type is gone.
- **C18, C19:** E-48's README now cites this page's pair counts and ranking, and terms are explained at first use.

## 9. Per-operation acks

**The owner's question** (2026-11-12): "re: option being per resource, did you rule out guarantees per operation where you can await different types of acks, e.g. wait till server received it, wait till replicated, wait till on disk etc? if so, can you explain tradeoff?"

**Words used in this section.**
- **Stage**: how far one write has got, and so how early its caller can hear back.
  - **received**: the range's leader has put the write in its log.
  - **replicated**: two of the three copies hold it in memory (in the operating system's page cache, not yet fsynced).
  - **committed**: on disk at two of three copies, applied, and visible to everyone. Under `persisted` this is the only answer today.
  - **durable**: on disk at two of three. On a `persisted` resource it is the same moment as committed.
- **Early answer**: an answer at received or replicated, before the commit.
- **The forms weighed here.**
  - **A, per resource**: form (a) of sections 0 to 8, the `memory` rung chosen per resource.
  - **S1, answer stages**: every write commits exactly as `persisted` does. It is judged at the leader's log end, as today, and applied and shown to anyone only once two of three have it on disk. The caller picks, per call, which stage its own answer waits for. The servers' commit work is the same whatever it picks; what S1 adds to them is in 9.4.
  - **S2, commit in memory, an answer per write**: every group commits at the memory point, as the `memory` rung does. Each caller's answer waits for memory or for disk, as it chose.
  - **S3**: S2 with fixed rules for which kinds of write wait for disk. This is form (e1).
  - **S4**: on a memory resource, a write's handle also lets you await the disk. This is form (e4), per write.
  - **Mixes**, such as A+S1: early stages on `persisted` resources, and the `memory` rung on chosen ones.
- **Spec** and **blind** early answers. A spec answer carries the result the leader judged on its log so far, such as an `incr`'s new value or a condition's ok. A blind one says only "accepted".
- **W1, O.seq, Y**: the three rules S1 needs (9.2). **RD**: a reader reads only what is on disk at two of three.
- **ReadIndex**: Raft's way to serve a read safely: the read first learns the leader's commit point, then waits until that much is applied.
- **Credit grant** (or credit window, AMENDMENTS A-07): how many unfinished writes the server lets one client hold at a time. The rest wait in the client.

### 9.0 The answer

1. **No, this was not ruled out. It was never weighed.** The study ruled out a commit level chosen per write, and only for COMP2's family, where many resources share one Raft group and a group has one commit point (AMENDMENTS footnote 13). The owner's shape is different: every write still commits on disk, and each call picks when its own answer comes (S1). The v5 draft had one such stage, `confirm: 'sent'`, and a reviewer's proposal cut it with no stated reason (9.1). One formal ground does remain: TiKV-persisted's card promises "on disk at a majority before the ack", so early stages change that row, and a referee must accept the change (RR-14's second ground, 9.1).
2. **The trade-off.** S1 shortens only the writer's own wait. `replicated` answers where the `memory` rung commits: at p99 about 0.69 ms in TypeScript, against 4.45 ms for a commit on one shared disk and 2.52 ms with a disk per copy (reasoned from E-02's measured stages plus TiKV's hops). But it is the weaker answer: one machine's power cut can lose it, where the memory rung's "ok" survives one. What readers and subscribers see, CPU per write, top speed and disk stalls all stay as `persisted`.
3. **What S1 gets in return.** Given three small rules (9.2), nobody but the writer can ever be told something that later vanishes. Raft's commit, election and recovery rules do not change, no kind of write is refused, and no operator step is added (model-checked and checked by brute force in [E-48]). Raft's messages, its journal and the leader's marks do change (9.4). It costs 0 to 8 more interacting pairs; the `memory` rung costs 20 to 34 (computed). The writer's own early answer is weaker than a commit: it can be lost, and a resent copy can still be refused (9.4).
4. **The other forms.** A buys more: fast visibility, a third less CPU, a higher top speed. But every reader of a memory resource can see writes that later vanish, and A needs refusals and an operator step. Commit in memory with a per-write answer (S2, S3, S4) breaks through readers even when the writer waits for the disk (model-checked).
5. **So the recommendation changes** (section 0): answer stages (S1) come second, and the `memory` rung comes third, only for a need S1 cannot meet. Two rulings decide whether S1 also moves a benchmark line (9.3).

### 9.1 Was it ruled out, where, and why

**Per-operation choice came up three times** (cited: the files named).
- **v4 shipped a per-write ladder**: `confirm: 'committed' | 'replicated' | 'persisted'`, default `committed` ([api/types.ts](../../api/types.ts), [kernel/confirm.ts](../../kernel/confirm.ts), [examples/10-confirm](../../examples/10-confirm/README.md)).
  - The write became visible first, at `committed` (stamped and applied at its owner). The answer could then wait for later proof. So it was "answer later than visible": S4's shape, not S1's.
  - What v4 learned. Proof of a stage must come from the replication marks, never from "applied": v2's answer from `applied` was "a documented guaranteed-false-positive" ([DECISIONS.md](../DECISIONS.md) V3-7; `kernel/confirm.ts`). The M4 review found false `persisted` proof after a failed fsync, and marks that were right within one life but "a lie across lives" of a peer ([HISTORY.md](../HISTORY.md)). Single-row writes reached `persisted` at about 250 a second per member ([STATUS.md](../../STATUS.md)).
  - No decision rejected the ladder itself. The v5 draft replaced it "by majority commits" ([DESIGN-V5.md](../DESIGN-V5.md), "What is replaced").
- **The v5 draft kept one early stage**, `confirm: 'sent'` (DESIGN-V5 §3.2). That is S1's `received` stage.
  - A plain write's promise resolves once its leader has appended it. The answer carries the attempt id, never an offset. The write stays pending and is resent after a failover. Others see it only once it commits. Writes with conditions or ops cannot use it.
  - Decision 21a (chosen) deferred it to phase 5, since "`sent` needs its own failover rule" (§3.2). Decision 23a, a reviewer's list of cuts that the drafter called "my pick" but never marked "Chosen", cut it outright. The commit that added 23a gives no reason (computed: `git show fc81eb7`), and [SPACE.md](SPACE.md) calls 23a a proposal.
- **The study's map** lists Q `mix` as "chosen per resource (or per write) | the draft, v4's per-write ladder" ([SPACE.md](SPACE.md)). API.md's first draft dropped per-write choice because Raft has "one commit point per resource" and 23a cut `sent`. Its Q-A9 said to reopen the question "with PERF-02's and PERF-05's default-config rows" (computed: `git show 173a90f:docs/v5-space/API.md`).

**The final reason** (cited).
- AMENDMENTS footnote 13: "`maj-m` and `none` per resource, never per write, because G `pslot` cuts groups by durability". G `pslot` puts the slots of many resources in one Raft group. A group has one commit point, so it cannot commit some writes in memory and others on disk.
- The referee's RR-14 adds a second ground, for the shard rows: a per-write rung there "would be a change of the row (a second rung inside one group, v4's ladder), not a rule they hold" ([rerulings.cells.json](judging/closure/rerulings.cells.json)).
- VERDICT's P-15 row and §5.3, and API.md's Q-A9 and its `@ts-expect-error` line, repeat this for COMP2 ([VERDICT.md](VERDICT.md), [API.md §9](API.md#9-open-api-questions)).

**Does that reason hold on TiKV's shape?**
- **For a commit level per write: not by the footnote** (cited unless marked).
  - TiKV's shape is G `shard`, not `pslot`. Its card says "`memory` or `none` per resource" with no "never per write" ([candidates/TiKV-TS.md](candidates/TiKV-TS.md); compare [candidates/COMP2.md](candidates/COMP2.md)). RR-14 does not name TiKV-TS.
  - Family B's referee named, for TiKV-TS's P-15, a closer that is a rung per kind of write ("writes its locks and commit record at `persisted`, or is refused") and left it open ([B.settled.json](judging/closure/hybrids/B.settled.json)). Section 4.4 already says (e1) is open on TiKV's shape.
  - Ranges stay per resource only by rule 13 ("No merge joins ranges of two resources"). TiKV itself can merge across tables (SPACE.md cites `enable-cross-table-merge`). Without rule 13 the footnote's problem would come back, for a per-resource rung too (reasoned).
- **For S1 the footnote's reason does not apply on any shape**, COMP2's included. S1 never moves a group's commit point (reasoned). E-48 checked by brute force that S1's Raft rules (commit, elections, what a fault keeps) are `persisted`'s.
- **RR-14's second ground still bites in form.** TiKV-persisted's card says "on disk at a majority before the ack" ([candidates/TiKV-persisted.md](candidates/TiKV-persisted.md)). An early answer is outside that wording, and the closure tool has no option for it. So S1 changes the row, and a referee must accept that change (reasoned).
- **Standing rules that bind any early answer** (cited): REQUIREMENTS' default "a write's answer comes after its commit"; A-04, every answer (a refusal too) waits for the commit it was judged on, because E-22 found a refusal by a write that was then lost in 10 of 100 seeds (measured); E-20's "an attempt told `applied` has a committed write of its own"; F-01, "no lost acknowledged write"; and read-your-writes (P-01). S1 keeps them only with rulings 2, 3, 6 and 7 of 9.7 (reasoned).

### 9.2 The forms side by side

"Pairs" are computed by the `ack-pairs` script (9.8), with `closure.py`'s own pair rule on copies of the units. Low, mid and high place the new reads differently; each placement is a reasoned choice, and the script says which. "Model" is [E-48] unless marked: every reachable state at small bounds, one fault per run (a power loss, or the leader's process crash), 1,637 runs and 62.9 million states in all.

| Form | Mechanisms (novel) | Pairs | What the model showed | Rules needed | What a user learns | The footgun |
|---|---|---|---|---|---|---|
| **(d) `persisted` only** (the first slice) | 48 (0) | **233** | the baseline. Even here a client that sends a write before the one before is answered can see them land out of order (ORDER 7), as [E-45] F4 measured on the prototype (12 of 100 seeds). The model's "applied twice" (ORDER 6, a timeout resend) needs writes with no id; TiKV-persisted's transaction ids cover it | O.seq: A-10's issue order, which every row already owes | "Every write is on disk at two of three servers before fero answers." | — |
| **A, per resource** (form (a), the old recommendation) | 49 (0) | **253 to 267** | [E-47]: with no rules, transactions, fences and lock rows break; the refusals fix every modelled break. Plain writes, splits and feeds on memory: not modelled | {R2} and rules 1 to 15 (4.2); the operator's recovery | "A memory resource takes one-row writes only, and can lose its last second of them." | "saved" shown on a memory answer; a fact on a `persisted` resource that needs a memory write to survive |
| **S1, answer stages**: `received` only (the draft's `sent`), or `received` and `replicated` | 48 to 49 (0) | **233 / 238 / 241** (low / mid / high) | Raft unchanged (brute force). With no rules: a snapshot sees half a transaction **with no fault at all** (ATOMIC 10), half a transaction after a power loss (OTHERS.txn 8), a write under a lost lock grant (OTHERS.lock 6), plain writes out of order (ORDER 7), a writer misses its own write (RYW 5). With W1+O.seq+Y: every promise to others holds (160 runs, and 5 larger bounds) | W1, O.seq, Y. None on Raft's commit, election or recovery rules | "Every write is on disk at two of three servers before anyone else sees it. You may hear sooner how far it got, but that is not a promise it will commit. Until it commits, fero keeps it and resends it; a resent copy is judged again and can be refused. It is lost for good if your process stops or your session lapses first. Writes that answer with a value or a decision answer at commit." | "saved" shown on an early answer, then the process dies or the resend is refused; an early answer used as an ordering point between ranges |
| **S2, commit in memory, an answer per write** | 49 to 50 (0) | **250 / 254 / 268** (callers free); **251 / 255 / 273** (safe) | Breaks through readers even when every caller waits for the disk (ATOMIC 21 and 22, OTHERS.read 5 and 11). Holds only with W1+RD+O.seq+Y, where every reader reads the disk prefix: then it is S1 plus the `memory` rung's Raft rules | W1+RD+O.seq+Y, and rules 4 to 15 and the operator step on every group | "Every write is visible once two servers hold it in memory. Await `durable` to survive a power cut. Any resource can come back up to a second earlier." | awaiting `durable` on your own write does not stop you acting on someone else's lost write |
| **S3** = form (e1) | 49 (0) | **251 to 265**; 252 to 266 with RD.txn | The gap section 4.1 found by hand is real (ATOMIC 21 and 22): a reader acts on a commit not yet on disk. RD.txn closes it | W1 by kind, RD.txn, O.seq, Y, and rules 4 to 15 on every group | "Plain writes are fast and may vanish. Writes others rely on wait for disk, and so does a reader that meets a transaction." | a plain write that a transaction relied on vanishes |
| **A+S4**: A, plus `durable` on a memory resource's writes | 49 to 50 (0) | **254 to 271** | S4's own row (every caller at disk on a memory commit) protects the caller only: readers still act on lost writes (OTHERS.read 5 and 11) | A's | "On a memory resource, `durable` waits for the disks and covers every earlier write of its range." | others saw the write before it was durable |
| **A+S1** | 49 to 50 (0) | **253 to 275** | as A and S1 (not modelled together) | both sets | "A resource's rung says when others see a write. The stage you await says when you hear back." | A's and S1's |
| **A+S1+S4**: one ladder on both kinds | 49 to 50 (0) | **254 to 276** | as A+S1 | both sets | as A+S1 | as A+S1 |

**S1's three rules** (model-checked: each part needed, since dropping it brings a break back; E-17's greedy ablation ends at the same set in all three orders run).
- **W1**, four guards in the client library. The coordinator commits only after its prewrites are durable; the other keys follow only a durable primary; a reader resolves a lock only after a durable check; a holder writes under a lock only after its claim is durable. Dropping a part gives ATOMIC 15, OTHERS.txn 19, OTHERS.txn 18 or OTHERS.lock 8. In short: the library's own steps rest on committed answers only, and only the caller's last answer may come early. If early stages exist on plain writes only (9.6), W1 holds by construction (reasoned).
- **O.seq**: each writer numbers its writes. A range applies them in order, refuses a gap (`gap`) and answers a repeat `dup`. Without it: ORDER 7. This is the "issue order for one process's writes in flight to one partition" that AMENDMENTS A-10 already owes on every row, and the sequence [E-45] F4 proposes after it measured the break (12 of 100 seeds). So it is counted in neither price. Priced as one more state that the writer reads and writes, it adds 1 pair to each (233 → 234 for (d), 241 → 242 for S1 at high; computed: `ack-pairs`' last line). What S1 changes: under `persisted` alone, a client that sends each write only after the one before is answered keeps its order (E-48's S0 `pipe`; E-45: 0 of 100 seeds). After an early answer that is no longer true (S1 `pipe`, ORDER 7). So with S1, awaiting an answer is not enough to keep order, for apps and for gateways such as E-45's, which chain each write behind the previous answer.
- **Y**: a read waits until the writer's last answered write is visible, as Raft's ReadIndex waits for the applied index. Without it: RYW 5. A sync read cannot wait, so it shows the write only from the commit (9.7, ruling 3).
- E-47's epoch (R3) is not needed for S1 and cannot replace W1: R3+O.seq+Y still breaks (ATOMIC 13, OTHERS.txn 8, OTHERS.lock 6).

**Why a snapshot can see half a transaction with no fault** (model-checked; the 10-step trace was rerun here). T prewrites key a and hears "ok" as soon as a's leader has appended the lock. T then prewrites and commits its primary b. A reader takes a later snapshot, reads a before a's lock is committed and so sees the old value, then reads b's new one. Percolator needs every lock visible before the commit time is taken; an early prewrite answer breaks that. This is why W1 keeps the library on committed answers.

### 9.3 What each buys

**Speed** (computed by `ack-speeds`, 9.8: E-02's measured stages at 50,000 writes a second and 100 B, plus TiKV's three hops at their medians from E-01. No kernel of TiKV's shape was ever timed.)

The writer's answer, p50 / p99 in ms:

| Stage | TypeScript | Rust | Go | Forms that use it |
|---|---|---|---|---|
| received | 0.15 / 0.20 | 0.12 / 0.17 | 0.11 / 0.16 | S1 |
| replicated = the `memory` rung's commit | 0.36 / 0.69 | 0.25 / 0.42 | 0.29 / 0.54 | S1's stage; A's memory resources; S2 and S3 |
| committed, on this disk | 0.97 / 4.45 | 0.71 / 1.67 | 0.82 / 2.06 | S1's default; A's `persisted` resources; S4's `durable` |
| committed, a disk per copy (emulated) | 0.68 / 2.52 | 0.47 / 0.76 | 0.49 / 0.84 | the same |

- The `received` row uses TypeScript's `none` row for the leader's append in all three builds, because Rust's and Go's `none` rows carry a 1 ms tick (E-02).
- **A caveat on `replicated`** (reasoned). It matches the `memory` rung only if each follower hands every batch to the operating system as it arrives, while an fsync runs. E-02's `persisted` journal does not: it queues writes that arrive during an fsync (`ts/pipeline.ts`, read here). And S1 keeps `persisted`'s fsync rate, about 725 to 1,000 a second per process (section 2.3), where the `memory` rung syncs about once a second. How much those fsyncs slow the early report was not timed.

What else each form changes (reasoned from the table above and from E-02's measured CPU and top speeds):

| | S1 | A (memory resources) | S2 | S3 |
|---|---|---|---|---|
| Others see a write at | disk: 0.97 / 4.45 ms (TS) | memory: 0.36 / 0.69 ms | memory, every write | memory for plain writes; disk for transaction records |
| The writer reads its own write after | the commit (Y waits): about 1.05 ms p50 (TS) | the answer: about 0.44 ms | the answer | the answer, for plain writes |
| CPU per write, leader and two followers (TS / Rust / Go) | `persisted`'s 13.2 / 9.9 / 14.3 µs, plus one small report per batch | `memory`'s 8.0 / 6.4 / 9.6 µs (40 / 36 / 33 % less) | between the two | between the two |
| Top speed (Rust / Go, growing files) | `persisted`'s 2.21 / 2.83 M/s (4.11 / 4.08 preallocated) | `memory`'s 4.96 / 5.55 M/s | between | between |
| A disk stall (E-01: 22-52 ms, or 0.25-0.9 s behind a bulk writer) | early answers continue only until the client's credit grant and its 512 waiting writes fill (the 512 alone last 10.2 ms at 50,000/s); nothing else does | answers and reads continue, up to rule 9's 1 s | memory-level writes continue | plain writes continue |
| One hot key, if a lock per key is held until the write is visible (TiKV's latches; from memory) | 1,179 / 1,616 / 1,359 writes/s (TS / Rust / Go) | 4,167 / 6,173 / 4,926 | as A | as A for plain writes |

- With the study's own judging unit (it judges each write on the log end and answers after commit), writes to one key pipeline in every form. Then only the answer time differs (cited: `judging/mechanisms.json`, `writer-judging`).
- **The credit grant caps the gain, not only in a stall** (reasoned). An early-answered write is still unfinished until it commits, so it holds one of the client's credits (A-07: "each client holds at most a granted number of writes outstanding"). A caller that waits for each early answer gains the early-answer time only while its uncommitted writes fit in its grant. Beyond that, each next early answer waits for an earlier commit, and its rate is the grant divided by the commit time: what a client that sends up to its grant without waiting gets under `persisted` too. The grant is a number the server hands out, and its size was never set (A-07 says the grant was not built).
- Emulated disks cut `persisted`'s CPU to 10.7 / 6.4 / 9.8 µs (measured, E-02). So `memory`'s saving is the real fsync's own CPU, which S1 still pays (reasoned).

**The benchmark lines** (section 2.2's seven lines; TS / native; reasoned from measured parts, "proved" as in 2.2).

| # | Line | `persisted` only | A | S1, if a stage is not a rung (R-a) | S1, if a stage counts as a rung (R-b) | A+S1 under R-b |
|---|---|---|---|---|---|---|
| 1 | Redis SET, pipeline 1 | open / open | open / open | as `persisted` | open / open: `received` answers in 0.15 ms p50 (TS), but the servers do `persisted`'s work | at least A's |
| 2 | Redis INCR, pipeline 1 | open / open | open / open | as `persisted` | as `persisted`: an op answers at commit, unless a second ruling allows a provisional value | as A |
| 3, 4 | Redis, pipeline 16 | open / open | open / open | as `persisted` | as `persisted`: capacity lines | as A |
| 5 | JetStream, 1 client | **lost, proved** / **lost, proved** | likely lost / open | **lost, proved** | likely lost / open (`replicated` is 0.69 ms TS, 0.42 Rust; the bar is 0.303) | as A |
| 6 | JetStream, 16 clients | likely lost / open | likely won / likely won | likely lost / open | likely won / likely won, **only if** an early answer may carry a sequence number that may change; else as R-a | likely won |
| 7 | Kafka top speed | likely lost / open, thin | open, thin / likely won | likely lost / open, thin | likely lost / open, thin: S1's servers do `persisted`'s work | as A |

- **Tally, TypeScript.** `persisted` only, and S1 under R-a: 1 lost (proved), 2 likely lost, 4 open. S1 under R-b with a provisional sequence number: 1 likely won, 2 likely lost, 4 open (without it, as R-a). A: 1 likely won, 1 likely lost, 5 open.
- **Tally, Rust.** `persisted` only: 1 lost (proved), 6 open. S1 under R-b with a provisional sequence number: 1 likely won, 6 open (without it, as `persisted`). A: 2 likely won, 5 open.
- Kafka's end-to-end line (PERF-05) is won by every form: 638 ms for Kafka against about 19 ms for E-02's TypeScript `persisted` (measured, [E-09c] and [E-02]). NATS core (PERF-03) is the `none` rung's.

**The ruling: is an answer stage a "rung" for PERF-01?** PERF-01 says "at the competitor's default, fero's matching rung must win". The files define a rung two ways.
- **R-a**: "Rung: what a commit means" (VERDICT's key of terms; API.md §0). Then S1 adds no rung, and it moves no benchmark line.
- **R-b**: "Rung: what fero's 'ok' means for a write" (section 1 of this page; REQUIREMENTS' "before the answer"). Then S1's `replicated` matches JetStream's PubAck (a majority holds it in the page cache), and `received` matches Redis as shipped (one server's memory).
- **For R-b:** PERF-04 times "p99 ack latency", and PERF-02 compares Redis "as shipped vs fero's weakest rung". Both time the answer. And S1 promises the writer at least what those rivals do, while promising readers more.
- **Against R-b:** both rivals show the write to readers at that same point, and S1 does not. A line that times only the ack would credit fero with an answer that says nothing about when others see the write.
- **A second ruling, for line 6 under R-b: may an early JetStream answer carry a sequence number that a lost write would change?** A JetStream answer (a PubAck) carries the message's stream sequence. E-45's gateway makes it from the committed version ([E-45] `lib/jetstream.ts`: "the PubAck after commit carries `seq`, a number made from the version"; cited). An early answer has no version (9.6), since a lost and resent write lands at another place. So the gateway must either send a provisional number that a loss may change (the same kind of changed result E-48 reports for grants and transaction outcomes), or wait for the commit and give the line up. Under A the commit itself is in memory, so A's answer carries the true number: on this line A and S1 are not equal (reasoned).
- **A third, smaller ruling:** may a gateway answer Redis INCR with a value judged before commit? Section 9.6 says no. Then lines 2 and 4 score as `persisted`.
- **Judged cells** (reasoned; `closure.py` has no S1 option). Under R-b, PERF-04 for TiKV-persisted+S1 would read as it does for TiKV-TS: open, not failed. On the owner's frame rule 3 counts no speed, so this matters only for which lines are lost by name.

### 9.4 What each costs and breaks

**S1** (reasoned unless marked).
- **What must be built.**
  - A second, earlier report from each follower, once a batch is in the page cache, so the leader knows when two copies hold it. It feeds answers only. `received` alone needs none.
  - A journal that writes each batch on arrival and fsyncs in the background (9.3's caveat).
  - Two marks on the leader. **Commit must never read the early one.** A bug that does turns `persisted` into `memory` silently. That is v4's V3-7 lesson, and it needs a simulation monitor.
  - The leader counts its own copy toward `replicated` only once it has handed the batch to the operating system (its own write call). Counted earlier, a crash of the leader's process loses that copy, and `replicated` would no longer survive a process crash. E-48's process crash keeps the leader's whole log, which assumes this rule.
  - The client keeps an early-answered write in `cluster.writes` until it commits, and resends it after a failover, as the draft's `sent` did. The `received` answer must come after the append, never on arrival: in E-13, etcd dropped writes caught in a leader handover in 8 of 15 handovers (measured).
  - W1 in the libraries, O.seq at each range (A-10's issue order), Y on reads (9.2).
- **How a plain write rides TiKV's shape** (reasoned; the card does not say). TiKV-persisted gets exactly once from transaction ids (D `txn`, "transaction ids under two-phase commit") and makes dedup a kernel command (K `kern`). This page takes a plain write to be **one kernel command** at its range: one log entry, carrying its attempt id (its transaction id, so its dedup) and an oracle time. In effect it is a one-key transaction committed in one phase, as TiKV does for a transaction inside one range (from memory; section 6.1 item 4 assumes the same).
  - Then `received` is that one entry's append, W1.pw does not arise (there is no separate prewrite), and a resent copy keeps its id, so it applies at most once.
  - Still open: a resent copy that meets a newer commit to the same key. Either it keeps its old time and is refused as a write conflict (Percolator's rule for a start time older than the key's last commit), so the early answer ends in a refusal; or it takes a new time and lands after the newer write (the late-resend footgun below).
  - If a plain write were instead a full Percolator transaction (a prewrite, then a commit), `received` would be the prewrite's append, and W1.pw would cover plain writes too.
  - Its model is owed (9.7).
- **What an early answer promises.** That the write got that far. Not that it will commit.
  - `received` can be lost on any leader change, with no power loss (brute force: 23,774 of 140,648 outcomes with every log intact, at 4 entries).
  - `replicated` survives any process crash, but not one machine's power loss, because Raft lets a copy that lost power vote (brute force: 26,536 of 494,042 outcomes; 14,664 with the leader as that copy, 11,872 with a follower). Defined as "all three copies hold it", it survives one power loss (0 losses), but waits for the slowest copy.
  - Either way fero still holds the write and resends it (reasoned from the draft's rule; E-48 resends, but never stops the client). So it is lost for good only if the process stops, or its session lapses (the write then ends `unknown`), before it commits. A restore ends it `restored`.
  - Past its `timeout` (10 s by default) the handle rejects `timeout`, outcome unknown, and fero keeps resending it while the session lives (API.md's rule for `unknown`). A failover (below) or a long stall can run past it.
  - **A resent copy is judged again, and can be refused** (cited: API.md's order of checks at the writer and its error table; `judging/mechanisms.json`, `writer-judging`: "Dedup, shape checks, rules, conditions and ops are judged against the log-end state"). An early answer only means the old leader did not refuse it on its log end. On the new leader's log end, a field write whose row another client removed is refused `absent-row`; a `rules.write`, which sees the current row, may say no; and any write can meet `read-only` or `disk-full` (or `too-many-keys`, if it carries a caller key). Then the handle rejects with that refusal, after the caller has moved on. E-48 cannot show this: its plain writes can never be refused.
  - A lost early answer waits out a failover: about 0.94-1.42 s with a 1 s election timer, 2.03-3.36 s with 2 s (measured, [E-13]).
  - **An early answer cannot safely carry a value or a decision.** Under spec, results changed after a loss: an early "aborted" became a commit (RESULT 16 and 18 steps), an early "ok" for a protected write became "fenced" (16), and a lock grant's token changed (7) (model-checked, reported). That an `incr`'s value or a condition's decision changes the same way is reasoned, by the same mechanism: E-48's plain writes carry neither. So early stages go on plain writes only, and their early answer is blind: it carries no value, and a plain write's own outcome (ok or refused) is known only at its commit (the bullet above).
- **Footguns.**
  - Showing a person "saved" on an early answer. If the client dies, or a browser tab closes, while its server copy is lost, the write is gone. If the resent copy is refused, the person was told "saved" for a write that never happened.
  - Treating an early answer as an ordering point between ranges. Write 1 (range A) is answered early, so the app sends write 2 (range B); A's leader dies; readers see write 2 without write 1 until the resend lands, and for good if the client died. Inside one range the order holds.
  - A late resend of a blind `set` lands after another client's newer `set` of the same row. A timeout resend does this under `persisted` too, but here the caller had moved on.
  - Reads are not faster. Even the writer's own read waits for disk, and a sync read (`f.snapshot`, `f.data`) shows the old row until the commit (V4-7).
  - Throughput does not rise. Only a caller that waits for one write at a time gains, and only while its uncommitted writes fit its credit grant (9.3).
  - A script that ends right after early answers loses them unless `destroy()` drains them. An early rejection that nobody awaits must print one stderr line, not crash Node.
- **What it changes in the requirements.**
  - F-01 must say that "acknowledged" means the committed answer.
  - A-04 and REQUIREMENTS' default line ("a write's answer comes after its commit") must say "every value, decision and refusal after its commit; a plain write may say earlier how far it got".
  - The default line's "reads of what you wrote see it", and P-01's read-your-writes, must say: after an early answer, a read that waits sees it (Y); a sync read (`f.data`, `f.snapshot`) sees it only from the committed answer. Showing a pending write in a sync read is what V4-7 forbids.
  - F-09 needs a stderr line for a lost or refused early-answered write that nobody awaited.
  - Decision 23a's cut is reversed. AMENDMENTS footnote 13 is untouched.
- **A caution from Ceph** (cited from a search summary only). Ceph is the one system found with two answers on one write (`complete` in memory, `safe` on disk). Its owners removed the early one, because users "only care about making writes durable as quickly as possible". So S1 should offer no more than these stages.

**A** (sections 3 and 4): a lost visible tail for every reader and subscriber of a memory resource, the refusals, rules 4 to 15, the operator's recovery after a power cut, and up to about 1 s of answered writes.

**S2 and S3.** The `memory` rung's Raft rules (come back as new, rule 15's recovery) and the operator step on **every** group, not just on chosen resources (E-48, brute force: with copies that lost power still voting, one power loss loses a committed entry in 26,536 outcomes). Every resource then carries the lost-tail contract, unless every reader reads the disk prefix, which makes S2 into S1 plus those rules. A disk-level write on one range can rest on a memory-level write on another; the log-prefix defence covers one log only. So S1 dominates S2 and S4, and S3 is A's contract spread to every resource's plain writes (reasoned, as [E-48] argues).

**S4 alone** buys the caller a durable answer on a memory resource, but every reader saw the write before it was durable.

### 9.5 How rivals do it

Claims marked **cited** were read in this pass in each system's own documentation source or code (most documentation sites were not reachable, so the source files behind them were read). **Search** means only a search summary was read, not the page. The links are listed at the end of section 9.8.

| Class | Systems | What they show |
|---|---|---|
| **S1-like**: one point where others see the write; only the writer may hear earlier | Kafka `acks` 0 / 1 / `all` (cited: "Regardless of the `acks` setting, the messages will not be visible to the consumers until" the in-sync copies have them); BookKeeper's deferred sync (cited: readers' bound moves only after `force()`); MySQL semi-sync `AFTER_SYNC` (search); PostgreSQL with a synchronous standby at `on`, `remote_write` or `remote_apply` (cited: while it waits for the standby, the commit is marked but "still show[s] as running in the procarray", so other sessions do not see it; a cancelled wait leaves it "already committed locally"); inside transactions, CockroachDB's pipelined writes and TiKV's pipelined and in-memory locks (cited) | the early answer can be wrong, and only the writer learns: Kafka `acks=1` "will be lost" on a leader failure; BookKeeper fails the whole handle; CockroachDB fails the transaction at commit. Kafka refuses exactly-once on early answers: idempotence "requires this config value to be 'all'" (cited) |
| **Own-stage visibility**: each write is shown at its own chosen stage | Couchbase durable writes; Redpanda's per-entry visible offset; PostgreSQL when transactions mix `synchronous_commit` settings, which its docs call "possible, and useful" (cited) | they need a per-key barrier while a write is pending, or a log-prefix rule (Redpanda's last strict entry holds later relaxed ones back) |
| **S2-like**: others may see a write before it is durable; the caller picks what its own answer waits for | Redis `WAIT` / `WAITAOF` (cited: "WAIT does not make Redis a strongly consistent store"); MongoDB `w` / `j` with `local` reads (cited: other clients "can see the result of a write operation before the write operation is acknowledged"); PostgreSQL `synchronous_commit = off` (shown before its own flush) and `local` (shown before the standby has it); Cassandra consistency levels; Riak `w` / `dw`; LevelDB and RocksDB `sync`; Ceph's old `complete` / `safe` (all cited); SQL Server delayed durability, Aerospike `COMMIT_MASTER` (search) | readers see writes that are later rolled back (MongoDB writes rollback files for an operator); a timed-out write stays applied; the shared defence is the log prefix (PostgreSQL: "it is not possible for A's effects to be lost while B's effects are preserved"), which protects no reader that already acted; feeds are gated even where reads are not (MongoDB change streams report majority-committed changes only) |
| **A-like**: chosen per container | JetStream storage per stream, and its docs' advice to place strict streams on a second cluster with `sync_interval: always` (cited); Redpanda `write.caching` per topic; Kafka's flush settings and `min.insync.replicas` per topic (cited); SQL Server's database gate, Aerospike's strong namespaces, Aurora's guarded switch (search) | the common product pattern is a per-container floor plus a bounded per-call choice, where the strong container forbids the weak choice (reasoned from the rows) |
| **Research** | Skyros, SOSP 2021: answer result-free writes at once, make writes that return state wait (search). CAD, FAST 2020: commit from memory, but the first reader of a not-yet-durable item waits for the disk (search) | Skyros is the cleanest published rule for S1's open question: early answers only for writes without a result |

**What this says for fero** (reasoned).
- S1 has strong precedent, but always in one of two shapes: writes that return no judged result (Kafka produce, BookKeeper add, Skyros puts), or early answers inside a unit whose commit proves them again (CockroachDB, TiKV locks). No system found answers a stand-alone `incr` value or a condition's result early and later honours it. fero's plain writes sit between the two shapes: they return no value, but they are judged (shape checks, `rules.write` with the current row), so a resent one can still be refused (9.4).
- S2 is the most common shape among rivals, and it is the source of every vendor warning that a reader may see data that is later rolled back. In TiKV's shape, writes depend on each other across ranges and through two-phase commit, and the log-prefix defence does not cross logs.
- A plus a per-call strengthening (A+S4) is the common product pattern. Ceph warns against more stages than needed.

### 9.6 The API it would mean

**A handle, not a per-call option** (reasoned). A per-call option such as `{ ack: 'received' }` returns one answer and drops the final one. A handle keeps the final outcome reachable: the client keeps the write until it commits, and the app can still learn of a loss or a refusal.
- `set` and `remove` of a plain write return a `Write`. It is a `Promise<Ack>` that resolves at the commit, as today, with `received`, `replicated` and `durable` as extra promises. Each extra promise is made only when it is first read, so a write whose stages nobody reads costs no extra promise and no extra rejection.
- Ops, conditional writes, fenced writes, batches, claims, locks, transactions and saga steps return a `Judged`, which has `durable` only. Their answers carry results, so they come at commit.
- An early answer is `Early { key, attempt, stage }`: no version and no value, since a resent write lands at another place and is judged again there (the draft's rule).
- No new error codes. An early stage resolves only with how far the write got. It never says `refused`, so F-02's "refused never commits later" cannot break through it.
- **The handle can still reject after an early answer**: with a refusal, when a resent copy is judged again and refused (9.4); with `timeout` (outcome unknown, and fero keeps resending); or with `unknown`, `destroyed` or `restored`. A stage the write never reached rejects with the same error.
- A write whose rejection reaches no handler on any of its promises prints one stderr line (F-09), never Node's unhandled-rejection crash.
- Field writes (`set(['k', 'n'], 5)`) could instead return `Judged`: their refusal (`absent-row`) races with another client's remove, as a condition does. This page keeps them as `Write`, under the contract above. That is a choice for the API's owner (reasoned).
- On a `none` resource (no log, no disk) a write has one best-effort answer: `received` resolves with it, and `replicated` and `durable` reject at once with `config`.
- An async read on the same handle (`get`, `follow`, `read`) waits until that handle's earlier writes to what it reads have committed (rule Y). A sync read cannot wait, so it shows the write at commit (V4-7).
- With A, one handle type on both kinds. On a memory resource `replicated` is the commit, and `durable` waits for the disks (S4). On a `persisted` resource `received` and `replicated` come early, and `durable` is the commit. The bare `await` always means "visible to others".
- A gateway is the client, so it picks the stage per protocol: RESP `SET` at `received`; etcd at commit; JetStream's PubAck at `replicated` under R-b only if it may carry a provisional stream sequence (9.3), and otherwise at commit, since the PubAck's sequence is made from the committed version.
- A write by assignment (`f.data.k = v`) returns nothing, so it has no stage.

**The declarations** (a patch to API.md's `fero.d.ts`; the checker in 9.8 applies these two blocks to a copy).

```ts
// patch: verbs — fero.d.ts, Verbs<Row>: in place of the three write verbs that return Promise<Ack>
  // writes: each commits at the resource's rung. Awaiting the handle answers at that commit, as
  // before; a plain write's handle also has earlier stages (S1), and every handle has `durable`.
  // Stage promises are made on first read.
  set(key: Key, value: Op, opts?: WriteOpts): Judged
  set(key: Key, value: Row, opts: JudgedOpts): Judged
  set(key: Key, value: Row, opts?: PlainOpts): Write
  set(key: Key, value: Row | Op, opts?: WriteOpts): Judged
  set(key: Path, value: Op, opts?: WriteOpts): Judged
  set(key: Path, value: unknown, opts: JudgedOpts): Judged
  set(key: Path, value: unknown, opts?: PlainOpts): Write
  remove(key: Key | Path, opts: JudgedOpts): Judged
  remove(key: Key | Path, opts?: PlainOpts): Write
```

```ts
// patch: types — fero.d.ts, after the Ack interface
/** (S1) What an early stage proves: the write got this far, nothing more. No version and no value:
 *  a write that is lost and resent lands at another place, and is judged again there. The stage
 *  you await changes no commit: the write always commits at the resource's rung. */
export interface Early {
  key: Path
  attempt: AttemptId
  stage: 'received' | 'replicated'
}
/** A write whose answer depends on what it is judged against: a condition, an op, a claim, a batch,
 *  a transaction step. It answers at its commit, with its result, never earlier. */
export interface Judged extends Promise<Ack> {
  /** On disk at a majority. On a 'persisted' resource the same answer as awaiting the handle;
   *  on a 'memory' resource it comes later (S4); on a 'none' resource it rejects at once ('config'). */
  readonly durable: Promise<Ack>
}
/** A plain write. Until it commits it is in this client's pending list (cluster.writes) and is
 *  resent after a failover; it is lost for good if this process stops or its session lapses first.
 *  A resent copy is judged again and can be refused: then the handle rejects with that refusal,
 *  even after an early stage resolved. Nobody else can read it before the commit. A stage the
 *  write never reached rejects with the write's FeroError; a rejection that reaches no handler on
 *  any of the write's promises is printed once on stderr (F-09). */
export interface Write extends Judged {
  /** The range's leader took it into its log. A leader change can lose that copy; the client resends it. */
  readonly received: Promise<Early>
  /** Two of three hold it in memory, before their fsyncs. On a 'memory' resource this is the commit. */
  readonly replicated: Promise<Early>
}
export type PlainOpts = Omit<WriteOpts, 'if'> & { if?: undefined }
export type JudgedOpts = WriteOpts & { if: Cond }
```

`WriteRow` also gains `stage?: 'received' | 'replicated'`: the last stage a pending write reached.

```ts
// file: stages.ts — S1: one write, answered at the stage you await
import { fero, op, lock, FeroError } from 'fero'

const clicks = await fero<{ n: number }>('clicks')        // 'persisted': every write commits on disk at a majority
const w = clicks.set('page-1', { n: 1 })                  // the write leaves now; the stage you await changes no server work
const got = await w.replicated                            // two of three hold it in memory; nobody else can read it yet
console.log(got.attempt, got.stage)                       // an attempt id, never a version
const ack = await w                                       // committed: on disk at a majority, applied, visible
console.log(ack.version)
w.catch((e: FeroError) => console.log(e.code, e.outcome)) // 'unknown' if it can never commit

// Many plain writes, each answered when its leader took it. The client keeps each one until it
// commits and resends it after a failover; Ctrl-C (destroy) waits for them first. The early
// answers come fast only while the uncommitted writes fit this client's credit grant (9.3).
for (let i = 0; i < 100; i++) await clicks.set(`row-${i}`, { n: i }).received
console.log(await clicks.get('row-99'))                   // read-your-writes: waits until row-99 commits

// A write judged against the state has no early stage: an op, a condition, a fenced write.
const stock = await fero<{ left: number }>('stock')
const sold = await stock.set('sku-1', op.incr(-1, { min: 0 }))   // answers at commit, with the new value
console.log(sold.value)
const l = await lock('repricer', { lease: '10s' })
await stock.set('sku-1', { left: 9 }, { if: { fence: l.fence } })

// With the memory option (form A): the commit is two of three in memory; `durable` waits for the disks (S4).
const prices = await fero<{ cents: number }>('prices', { durability: 'memory' })
const p = prices.set('sku-1', { cents: 499 })
await p                                                   // visible to every reader now; may vanish in a power cut
await p.durable                                           // on disk at a majority, with every earlier write of its range
```

```ts
// file: stages-types.ts — what must and must not type-check with answer stages
import { fero, op, type Early, type Judged, type Write } from 'fero'
const f = await fero<{ n: number }>('f')
const w: Write = f.set('k', { n: 1 })
const e: Early = await w.received
// @ts-expect-error an early answer has no version: a resent write lands elsewhere
console.log(e.version)
// @ts-expect-error an op's result is known only at its commit: no early stage
await f.set('k', op.incr(1)).received
// @ts-expect-error the same for an op on a path
await f.set(['k', 'n'], op.incr(1)).replicated
// @ts-expect-error a condition is answered at commit: no early stage
await f.set('k', { n: 2 }, { if: { absent: true } }).replicated
// @ts-expect-error a conditional remove too
await f.remove('k', { if: { present: true } }).received
const j: Judged = f.set('k', { n: 2 }, { if: { absent: true } })
await j.durable
// @ts-expect-error the stage is chosen by what you await, not by a write option
await f.set('k', { n: 3 }, { ack: 'received' })
// @ts-expect-error still no rung per write
await f.set('k', { n: 3 }, { durability: 'memory' })
// @ts-expect-error a batch is judged all or none: no early stage
await f.batch([{ key: 'a', value: { n: 1 } }]).received
const acks = await Promise.all([f.set('a', { n: 1 }), f.set('b', { n: 2 })])   // a Write is a Promise<Ack>
console.log(acks.length)
f.data.k = { n: 4 }                                       // assignment returns no handle: no early stage
```

**Checked** (computed: `ack-api`, 9.8, TypeScript 6.0.2). API.md's 26 blocks and these 2 compile with no errors, so API.md's own 16 `@ts-expect-error` lines still fail as they should. With the 8 `@ts-expect-error` lines above removed, tsc reports 8 errors, each for its stated reason. A planted `p.durabel` fails. Not checked: that any of it runs.

### 9.7 What stays open

**Models** (each reasoned as needed; none run).
1. **A client that stops** while it holds early-answered writes, with dedup, a failover and a session that lapses, on E-20's dedup model. The property: a write answered `committed` is never lost; a write answered early is lost only if its client stopped or its session lapsed.
2. **A plain write that can be refused on resend**: a field write while another client removes the row, and a `rules.write` that reads the row. The property: the handle ends refused, and nobody but the caller ever saw the write. E-48's plain writer can never be refused.
3. **How a plain write rides TiKV's shape** (9.4): one kernel command with its attempt id, or a one-key transaction; and what a resend that meets a newer commit to the same key does.
4. **Order between ranges** for early-answered writes, and conditions and `incr` on plain keys. E-48's plain writes are one writer, one key, two or three writes.
5. **O.seq's state across splits, merges and range moves**, and resends through a forwarding hop (A-21's forward-once rule). Dedup state must travel with the unit that holds it ([SPACE.md](SPACE.md)).
6. **Feeds and subscribers** with S1. E-48's OTHERS.read stands in for them.
7. **Two faults in one run**, pre-vote and check-quorum (which would remove some of `replicated`'s losses), TiKV's real scheduler, and leader leases for reads.
8. **DEV-10's mutants and a second agent's rerun** of E-48.
9. A simulation monitor for "commit never reads the early mark".
10. If A is ever built: section 6.1's models still stand.

**Timings.**
1. **The gate** (section 6.2 item 1) should also time the `replicated` mark: it costs one counter.
2. **S1's journal**: each batch written on arrival with a background fsync, and two reports per follower; on this disk, on a disk per copy, and with E-01's stalls.
3. **One write in flight through the gateway** (JetStream's line 5) at `received` and `replicated`.
4. **The credit grant**: its size, and a loop that waits for each early answer at that size (9.3).

**Rulings for the owner.**
1. **R-a or R-b** (9.3): does an answer stage count as fero's "matching rung" for PERF-02 and PERF-04? And under R-b, **may an early JetStream answer carry a sequence number that a lost write would change?** Without both, S1 wins no benchmark line.
2. **F-01**: does "acknowledged" mean the committed answer?
3. **Read-your-writes (P-01)** after an early answer: it holds for reads that wait (Y), and for sync reads only from the committed answer. Or a design that shows a pending own write in sync reads, which V4-7 forbids.
4. **May a gateway answer Redis INCR with a value judged before commit?** This page says no.
5. **What `replicated` promises**: survives a process crash, not one power loss; or "all three copies", which survives one power loss at the slowest copy's speed.
6. **What an early answer promises**: how far the write got, with a final answer that can still be a refusal (this page's choice); or early stages only on writes that cannot be refused on state, so field writes and resources with `rules.write` answer at commit.
7. **Restate A-04** and REQUIREMENTS' default line for values, decisions and refusals only, and **reverse decision 23a**.
8. **Accept S1 as a change of TiKV-persisted's row** (RR-14's second ground), or judge it as a new row.

### 9.8 How to check the numbers

Run from `docs/v5-space`:

```sh
python3 -c "$(awk '/^```python ack-pairs$/{f=1;next} /^```$/{f=0} f' MEMORY.md)"
python3 -I -c "$(awk '/^```python ack-speeds$/{f=1;next} /^```$/{f=0} f' MEMORY.md)"
python3 -I -c "$(awk '/^```python ack-api$/{f=1;next} /^```$/{f=0} f' MEMORY.md)"          # add strip or plant
python3 experiments/E48-ack-stages/tools/raftcheck48.py 1 2 3 4
cd experiments/E48-ack-stages && python3 ../E16-controller-loop/engine/cli.py models/ackstage.py S1-recv --bound txnb --all-fails --no-mutants
```

| Claim | Command | Result, run here 2026-11-12 |
|---|---|---|
| the forms' pairs | `ack-pairs` | (d) 233, {R2} 248, (a) 253-267, (e1) 251-265 (section 7.2's numbers); S1 233 / 238 / 241; S2 250 / 254 / 268 and 251 / 255 / 273; S3 251-265, 252-266 with RD.txn; A+S4 254-271; A+S1 253-275; A+S1+S4 254-276; O.seq, if priced: (d) 233 → 234, S1 233 → 234, 238 → 239, 241 → 242 |
| the speeds of 9.3 | `ack-speeds` | as 9.3's tables |
| the API of 9.6 | `ack-api`; `ack-api strip`; `ack-api plant` | 28 files, no errors; 8 errors; 1 error (`durabel`) |
| S1 leaves Raft as `persisted`; what each stage survives | `raftcheck48.py` | "all checks hold"; at 4 entries, 8,058 and 116,874 states; `received` lost 23,774 times with logs intact; `replicated` 26,536 on one power loss, 0 under "all three" |
| a snapshot sees half a transaction with no fault | the `cli.py` line | `S1-recv txnb: 122,888 states: ATOMIC (10 steps), OTHERS.txn (8 steps)` |
| the same with W1 | `... S1-recv-W1 --bound txnb` | `61,288 states: all hold` |
| S4 and S3 break through readers | `... S2-disk --bound pipe --all-fails` | `223 states: OTHERS.read (5 steps)` |
| every E-48 table | `experiments/E48-ack-stages/run.sh` (about 81 minutes of CPU) | [E-48]'s results files |

```python ack-pairs
# Pairs for the per-operation forms of section 9.2, by closure.py's own pair rule, on in-memory copies
# of the units. Run from docs/v5-space. It first runs section 7.2's memory-pairs block (quietly) and
# reuses its helpers, so the shared rules 4 to 15 are the same code. Which unit reads or writes a new
# state is a reasoned choice, so each form is priced at three levels:
#   low  : each new read sits in a unit that already reads the neighbouring state
#   mid  : the stage answers are their own (not novel) unit, 'ack-stages'
#   high : mid, plus read-your-writes waits in the read units (rule Y) and the forwarder keeping an
#          early-answered write in flight until it commits (the v5 draft's rule for confirm: 'sent')
import re, io, contextlib
G = {}
with contextlib.redirect_stdout(io.StringIO()):
    exec(re.search(r"```python memory-pairs\n(.*?)\n```", open('MEMORY.md').read(), re.S).group(1), G)
units, add, n, rules = G['units'], G['add'], G['n'], G['rules']
BASE, TX = 'TiKV-persisted', 'two-phase-commit'
def new(g, key, reads, writes):
    g.append({'key': key, 'novel': False, 'reads': list(reads), 'writes': list(writes)}); return g
def R2():                              # MEMORY's {R2}: the transaction and the fenced write read the catalog
    return add(add(units(BASE, 'mix'), TX, ['meta.catalog']), 'writer-judging', ['meta.catalog'])
def A(hi):                             # form (a): {R2} with every rule of 4.2
    return rules(R2(), hi, True)
def s1(g, level, stages=('received', 'replicated')):
    # S1: every write commits at disk. New state: group.mcommit, the highest index two of three hold in
    # memory, from each follower's early report. 'received' reads the leader's log end (group.log).
    if 'replicated' in stages:
        add(g, 'raft-commit', writes=['group.mcommit'])
    mark = {'received': 'group.log', 'replicated': 'group.mcommit', 'durable': 'group.dcommit'}
    reads = [mark[s] for s in stages] + ['group.commit']
    if level == 'low':
        return add(g, 'writer-judging', reads)
    new(g, 'ack-stages', reads + ['writer.logend', 'route.inflight'], ['write.stage'])
    add(g, 'route-forward', ['write.stage'])                    # the forwarder relays each stage's answer
    if level == 'high':
        add(g, 'route-forward', ['group.commit'])               # keeps the write until it commits; resends it
        for k in ('read-lease', 'raft-readindex'):
            add(g, k, ['write.stage'])                          # Y: a read after an early answer waits for it
    return g
def S2(level, safe=True):
    # S2: every group commits in memory (rules 4 to 15 on every group); an answer may wait for disk.
    g = rules(units(BASE, 'mix'), level == 'high', True)
    add(g, 'memory-rung', writes=['group.dcommit']); add(g, 'writer-judging', ['group.dcommit'])
    if safe:                                                    # transaction records answered at disk,
        add(g, TX, ['group.dcommit'])                           # and at high the reader rule (RD) and
        if level == 'high':                                     # claims and cursors at disk
            add(g, 'mvcc', ['group.dcommit'])
            for k in ('lock-rows', 'queue-claims', 'consumer-groups'):
                add(g, k, ['group.dcommit'])
    if level != 'low':
        new(g, 'ack-stages', ['group.commit', 'group.dcommit', 'writer.logend', 'route.inflight'], ['write.stage'])
        add(g, 'route-forward', ['write.stage'])
    return g
def E1(hi, reader=False):              # S3 = MEMORY's (e1); 'reader' adds RD.txn (mvcc reads group.dcommit)
    g = add(add(add(units(BASE, 'mix'), 'memory-rung', writes=['group.dcommit']), 'writer-judging',
                ['group.dcommit']), TX, ['group.dcommit'])
    if reader:
        add(g, 'mvcc', ['group.dcommit'])
    return rules(g, hi, True)
def AS4(hi, level):                    # A plus a `durable` stage on memory resources (S4)
    g = A(hi)
    if level == 'low':
        return add(g, 'writer-judging', ['group.dcommit'])
    new(g, 'ack-stages', ['group.commit', 'group.dcommit', 'writer.logend', 'route.inflight'], ['write.stage'])
    return add(g, 'route-forward', ['write.stage'])
def row(name, f):
    v = [f(l) for l in ('low', 'mid', 'high')]
    print('  %-44s %s pairs; mechanisms %s; novel %s' % (name, ' / '.join(str(n(x)) for x in v),
          '-'.join(map(str, sorted({len(x) for x in v}))), '/'.join(map(str, sorted({sum(bool(m['novel']) for m in x) for x in v})))))
print('check against 7.2: (d) %d, {R2} %d, (a) %d-%d, (e1) %d-%d'
      % (n(units(BASE, 'maj-d')), n(R2()), n(A(False)), n(A(True)), n(E1(False)), n(E1(True))))
print('forms, pairs at low / mid / high:')
row('S1, received only (the draft\'s confirm: sent)', lambda l: s1(units(BASE, 'maj-d'), l, ('received',)))
row('S1, received and replicated', lambda l: s1(units(BASE, 'maj-d'), l))
row('S2, callers free (unsafe)', lambda l: S2(l, safe=False))
row('S2, safe', lambda l: S2(l))
print('  %-44s %d / - / %d; with RD.txn %d / - / %d' % ('S3 = (e1)', n(E1(False)), n(E1(True)), n(E1(False, True)), n(E1(True, True))))
for hi in (False, True):
    t = 'A high' if hi else 'A low'
    row('A + S4, ' + t, lambda l: AS4(hi, 'low' if l == 'low' else 'mid'))
    row('A + S1, ' + t, lambda l: s1(A(hi), l))
    row('A + S1 + S4, ' + t, lambda l: s1(A(hi), l, ('received', 'replicated', 'durable')))
def oseq(g):                           # O.seq = A-10's issue order: the writer reads and writes the issuer table
    return add(g, 'writer-judging', ['issuer.table'], ['issuer.table'])
print('O.seq, if priced (A-10 owes it on every row, so 9.2 counts it in neither): (d) %d -> %d; S1 %s'
      % (n(units(BASE, 'maj-d')), n(oseq(units(BASE, 'maj-d'))),
         ' / '.join('%d -> %d' % (n(s1(units(BASE, 'maj-d'), l)), n(oseq(s1(units(BASE, 'maj-d'), l)))) for l in ('low', 'mid', 'high'))))
```

```python ack-speeds
# Speed per form (section 9.3), from measured parts: arithmetic only, no timing. Run from docs/v5-space.
# E-02 (3 processes on loopback, 100 B, one group, 50,000 writes/s, medians of 3 runs, no client hop)
# gives each stage; E-01 gives the hops. TiKV's shape adds three hops (the client's, the oracle's, the
# forward to the leader), at their medians, as section 2.2 does.
import json, statistics as S, bisect
runs = [json.loads(l) for l in open('experiments/E02-pipeline/results/runs.jsonl')]
E1 = 'experiments/E01-floors/results/'
def pick(impl, mode, store='grow', rate=50000):
    r = [x for x in runs if (x['impl'], x['mode'], x['store'], x['size'], x['groups']) == (impl, mode, store, 100, 1)
         and str(x['rate_label']) == str(rate) and x['ok']]
    assert len(r) == 3, (impl, mode, store, rate, len(r))
    lat = {k: S.median(x['lat_ms'][k] for x in r) for k in ('p50', 'p99', 'p999')}
    cpu = sum(S.median(x['cpu_us_per_append'][p] for x in r) for p in ('leader', 'f1', 'f2')
              if r[0]['cpu_us_per_append'].get(p) is not None)
    return lat, cpu, S.median(x['tput'] for x in r)
rtt = [json.loads(l) for l in open(E1 + 'rtt.jsonl')]
def hop(impl, key):                     # median over runs of the 1 KiB loopback round trip, ms
    v = sorted(r[key] for r in rtt if r['impl'] == impl and r['bytes'] == 1024); return v[len(v) // 2] / 1000.0
IM = {'ts': 'node', 'rust': 'rust', 'go': 'go'}
none = pick('ts', 'none')[0]            # the leader's append; Rust's and Go's `none` rows carry a 1 ms tick
print('the writer\'s answer, p50 / p99 ms (E-02 stage + 3 hops); CPU us per write, leader + 2 followers')
vis = {}
for impl in ('ts', 'rust', 'go'):
    h = 3 * hop(IM[impl], 'p50_us')
    (mem, cm, _), (per, cp, _), (emu, ce, _) = pick(impl, 'memory'), pick(impl, 'persisted'), pick(impl, 'persisted', 'emu')
    vis[impl] = (per['p50'] + h, mem['p50'] + h)
    print('  %-4s received %.2f / %.2f | replicated = memory commit %.2f / %.2f | committed %.2f / %.2f, a disk per copy'
          ' %.2f / %.2f | CPU persisted %.1f, memory %.1f (%.0f %% less), emulated disks %.1f'
          % (impl, none['p50'] + h, none['p99'] + h, mem['p50'] + h, mem['p99'] + h, per['p50'] + h, per['p99'] + h,
             emu['p50'] + h, emu['p99'] + h, cp, cm, 100 * (1 - cm / cp), ce))
print('one hot key, if a latch is held until the write is visible (1 / E-02 p50, server side), and a client loop'
      ' that reads (2 hops) then writes with a condition')
for impl in ('ts', 'rust', 'go'):
    per, mem = pick(impl, 'persisted')[0]['p50'], pick(impl, 'memory')[0]['p50']; rd = 2 * hop(IM[impl], 'p50_us')
    print('  %-4s latch: visible at disk %.0f/s, at memory %.0f/s | loop: S1 %.0f/s, A %.0f/s'
          % (impl, 1000 / per, 1000 / mem, 1000 / (rd + vis[impl][0]), 1000 / (rd + vis[impl][1])))
print('top speed, 100 B, writes/s (E-02 max)')
for impl in ('ts', 'rust', 'go'):
    p, f, m = (pick(impl, md, st, 'max')[2] for md, st in (('persisted', 'grow'), ('persisted', 'falloc'), ('memory', 'grow')))
    print('  %-4s persisted %.2f M (preallocated %.2f M), memory %.2f M = %.2f GB/s of journal over 3 copies'
          % (impl, p / 1e6, f / 1e6, m / 1e6, m * 112 * 3 / 1e9))
print('stalls: 512 waiting writes last %.1f ms at 50,000/s; a 0.9 s stall leaves 45,000 writes (%.1f MB at 100 B)'
      % (512 / 50.0, 45000 * 112 / 1e6))
q = sorted(float(l) for l in open(E1 + 'fdatasync-1w-cdf.txt') if l.strip() and not l.startswith('#'))
def race(p):                            # 2nd fastest of 3 independent fsyncs: G = 3F^2 - 2F^3
    for x in q:
        f = bisect.bisect_right(q, x) / len(q)
        if 3 * f * f - 2 * f ** 3 >= p:
            return x
print('one write in flight, us (JetStream line 5: p99 < 303)')
for impl, tail in (('rust', 330), ('go', 450), ('node', 570)):      # E-02 `memory` p99 at 50,000/s, us
    m, p = hop(impl, 'p50_us'), hop(impl, 'p99_us')
    m, p = m * 1000, p * 1000
    print('  %-4s received: 3 hops %.0f (p50), %.0f (p99) | replicated: wire %.0f-%.0f, E-02 tail + 3 hops %.0f'
          ' | committed: bound %.0f, estimate %.0f' % (impl, 3 * m, 3 * p, 4 * m, 4 * p, tail + 3 * m,
                                                      race(.92) + 3 * m, race(.99) + 3 * m))
```

```python ack-api
# Type-check section 9.6 against API.md's own declarations, as API.md section 10 does. Run from
# docs/v5-space. Every API.md block that starts "// file:" goes to a fresh folder; fero.d.ts gets
# 9.6's two patch blocks (and a `stage` on WriteRow); 9.6's two file blocks are added; tsc runs.
# Argument: none; 'strip' (drop 9.6's @ts-expect-error lines, so each must fail); 'plant' (a typo).
# DATA names data's folder, as in API.md section 10.
import re, sys, os, json, subprocess, tempfile
mode = sys.argv[1] if len(sys.argv) > 1 else ''
mem = open('MEMORY.md').read()
sec = mem[mem.index('\n### 9.6'):mem.index('\n### 9.7')]
out, files = tempfile.mkdtemp(prefix='ack-api-'), []
def put(name, body):
    open(os.path.join(out, name), 'w').write(body); files.append(name)
blocks = r"```ts\n(// (file|patch): (\S+)[^\n]*\n)([\s\S]*?)```"
for head, kind, name, body in re.findall(blocks, open('API.md').read()):
    if kind == 'file':
        put(name, head + body)
patch = {name: body for _, kind, name, body in re.findall(blocks, sec) if kind == 'patch'}
d = open(os.path.join(out, 'fero.d.ts')).read()
def sub(old, new):
    global d
    assert d.count(old) == 1, old
    d = d.replace(old, new)
sub("  // writes: each answers after its commit, at the resource's rung\n"
    "  set(key: Key, value: Row | Op, opts?: WriteOpts): Promise<Ack>\n"
    "  set(key: Path, value: unknown, opts?: WriteOpts): Promise<Ack>\n"
    "  remove(key: Key | Path, opts?: WriteOpts): Promise<Ack>\n", patch['verbs'])
end = "  value?: unknown      // ops only: the value the op wrote (incr: the new number)\n}\n"
sub(end, end + patch['types'])
row = "  state: 'pending' | 'committed' | 'refused' | 'unknown'\n"
sub(row, row + "  stage?: 'received' | 'replicated'   // (S1) a pending write: the last stage it reached\n")
open(os.path.join(out, 'fero.d.ts'), 'w').write(d)
for head, kind, name, body in re.findall(blocks, sec):
    if kind != 'file':
        continue
    if mode == 'strip' and name == 'stages-types.ts':
        body = ''.join(l for l in body.splitlines(True) if '@ts-expect-error' not in l)
    if mode == 'plant' and name == 'stages.ts':
        body = body.replace('await p.durable', 'await p.durabel', 1)
    put(name, head + body)
data = os.environ.get('DATA', '/home/user/pemrouz/data')
co = {'target': 'es2022', 'module': 'esnext', 'moduleResolution': 'bundler', 'strict': True, 'noEmit': True,
      'types': [], 'lib': ['es2022'], 'paths': {'fero': ['./fero.d.ts'], 'data': [os.path.join(data, 'types/public.d.ts')]}}
json.dump({'compilerOptions': co, 'files': files}, open(os.path.join(out, 'tsconfig.json'), 'w'))
r = subprocess.run(['tsc', '-p', os.path.join(out, 'tsconfig.json')], capture_output=True, text=True)
print('%d files (%d from API.md, 2 from 9.6) in %s' % (len(files), len(files) - 2, out))
print(r.stdout.strip() or 'tsc: no errors')
print('exit', r.returncode)
```

**Sources for 9.5** (each read in this pass unless marked "search").
- Kafka: [ProducerConfig.java](https://raw.githubusercontent.com/apache/kafka/trunk/clients/src/main/java/org/apache/kafka/clients/producer/ProducerConfig.java), [design.md](https://raw.githubusercontent.com/apache/kafka/trunk/docs/design/design.md), [TopicConfig.java](https://raw.githubusercontent.com/apache/kafka/trunk/clients/src/main/java/org/apache/kafka/common/config/TopicConfig.java).
- Redpanda: [consensus.h](https://raw.githubusercontent.com/redpanda-data/redpanda/dev/src/v/raft/consensus.h).
- NATS JetStream: [jetstream/README.md](https://raw.githubusercontent.com/nats-io/nats.docs/master/nats-concepts/jetstream/README.md).
- Redis: [wait.md](https://raw.githubusercontent.com/redis/docs/main/content/commands/wait.md), [waitaof.md](https://raw.githubusercontent.com/redis/docs/main/content/commands/waitaof.md).
- MongoDB: [write-concern.txt](https://raw.githubusercontent.com/mongodb/docs/HEAD/content/manual/manual/source/reference/write-concern.txt), [list-visibility-of-data.rst](https://raw.githubusercontent.com/mongodb/docs/HEAD/content/manual/manual/source/includes/list-visibility-of-data.rst), [replica-set-rollbacks.txt](https://raw.githubusercontent.com/mongodb/docs/HEAD/content/manual/manual/source/core/replica-set-rollbacks.txt), [changeStreams.txt](https://raw.githubusercontent.com/mongodb/docs/HEAD/content/manual/manual/source/changeStreams.txt).
- PostgreSQL: [wal.sgml](https://raw.githubusercontent.com/postgres/postgres/master/doc/src/sgml/wal.sgml), [config.sgml](https://raw.githubusercontent.com/postgres/postgres/master/doc/src/sgml/config.sgml) (`synchronous_commit`), [xact.c](https://raw.githubusercontent.com/postgres/postgres/master/src/backend/access/transam/xact.c) (`RecordTransactionCommit`), [syncrep.c](https://raw.githubusercontent.com/postgres/postgres/master/src/backend/replication/syncrep.c) (a cancelled wait).
- Cassandra: [dynamo.adoc](https://raw.githubusercontent.com/apache/cassandra/trunk/doc/modules/cassandra/pages/architecture/dynamo.adoc). Riak: [replication-properties.md](https://raw.githubusercontent.com/basho/basho_docs/HEAD/content/riak/kv/2.2.3/developing/app-guide/replication-properties.md). LevelDB: [index.md](https://raw.githubusercontent.com/google/leveldb/main/doc/index.md). RocksDB: [Basic-Operations.md](https://raw.githubusercontent.com/wiki/facebook/rocksdb/Basic-Operations.md).
- CockroachDB: [transaction-layer.md](https://raw.githubusercontent.com/cockroachdb/docs/main/src/current/v26.2/architecture/transaction-layer.md). TiDB and TiKV: [pessimistic-transaction.md](https://raw.githubusercontent.com/pingcap/docs/master/pessimistic-transaction.md), [RFC 0077](https://raw.githubusercontent.com/tikv/rfcs/master/text/0077-in-memory-pessimistic-locks.md).
- Couchbase: [durability.adoc](https://raw.githubusercontent.com/couchbase/docs-server/HEAD/modules/learn/pages/data/durability.adoc). Ceph: [librados.h](https://raw.githubusercontent.com/ceph/ceph/main/src/include/rados/librados.h). BookKeeper: [WriteFlag.java](https://raw.githubusercontent.com/apache/bookkeeper/master/bookkeeper-server/src/main/java/org/apache/bookkeeper/client/api/WriteFlag.java), [LedgerHandle.java](https://raw.githubusercontent.com/apache/bookkeeper/master/bookkeeper-server/src/main/java/org/apache/bookkeeper/client/LedgerHandle.java).
- Search only: MySQL's [semi-sync interface](https://dev.mysql.com/doc/refman/en/replication-semisync-interface.html); SQL Server's [transaction durability](https://learn.microsoft.com/en-us/sql/relational-databases/logs/control-transaction-durability); Aerospike's [policies](https://aerospike.com/docs/server/guide/policies); Aurora's [feature recommendations](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/AuroraMySQL.BestPractices.FeatureRecommendations.html); Ceph's removal of the early answer (Luminous's "kill ack vs commit distinction", and the Linux client's "libceph: get rid of ack vs commit"); [Skyros](https://par.nsf.gov/biblio/10299722); [CAD](https://www.usenix.org/conference/fast20/presentation/ganesan).

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
[E-45]: experiments/E45-drivers/README.md
[E-47]: experiments/E47-memory-rung/README.md
[E-48]: experiments/E48-ack-stages/README.md
