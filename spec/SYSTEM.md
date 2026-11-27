# fero v5: the system

Nothing is built yet. Rules: [ledger.json](ledger.json). Slices: [slices.json](slices.json). Budget: [budget.json](budget.json), accepted (V5-25). Bytes: [SHAPES.md](SHAPES.md). Files, counts, the list of bars: [README.md](README.md). Why: [DECISIONS](https://github.com/pemrouz/fero/blob/design/docs/DECISIONS.md), [BUILD](https://github.com/pemrouz/fero/blob/design/docs/v5-space/BUILD.md), [LAYERS](https://github.com/pemrouz/fero/blob/design/docs/v5-space/LAYERS.md), [REQUIREMENTS](https://github.com/pemrouz/fero/blob/design/docs/v5-space/REQUIREMENTS.md).

## What fero is

fero is shared, live data for apps. An app names a resource, `fero('orders')`, and every server and client that opens it sees the same rows, kept in step. A resource's rows hash into 4,096 fixed **slots**. A **group** is a few servers that agree on one log (Raft) and holds some slots. Each server in a group is a **copy**: it stores every change and **folds** it, that is, applies it to its rows. A write is acknowledged only when a majority of its group has it on disk. <sub>V5-2, V5-18</sub>

## The layers

- **L0, storage and I/O.** The journal, the links, the handshake, disk checks.
- **L1, the log.** Raft per group; founding, healing; slots, their moves, routing.
- **L2, fold and ops.** Judges each write once, at the leader; hands committed records to the fold.
- **L3, flow.** Subscriptions, pacing, positions, served views, the merger, scans.
- **L4, the surface.** `fero()`, addresses into the data, reads, writes, methods, config.
- **L5, libraries.** Locks, queues, sagas, `derive`, the past, gateways, the CLI.
- **`data` 5, beside them.** The sibling engine, in TypeScript. It holds the rows and runs views. Its rules are the ledger's row D. <sub>V5-14, V5-21</sub>

The ledger holds 832 rule records (821 to 1,038 at their low and high counts) *(counted)*.

## Rust and JavaScript

Rust holds L0, L1 and the byte-moving part of L3. JavaScript holds the rest and `data`. Clients are TypeScript. One rule guards the line: **JavaScript runs once per decision, never once per delivery, and bytes cross in batches.** A crossing with 256 records costs 52 ns a record; one per record costs 3.8 µs *(measured, E-03)*. Rust never builds a row, judges a write or runs app code. <sub>V5-23.1</sub>

## Server platforms

Servers run on Linux from slice 1, where speed is judged. macOS and Windows servers come in slice 7. Clients run anywhere. The owner's laptop runs slice 0's probes, timed as provisional. <sub>V5-24.3, V5-27</sub>

## The bars

A **bar** is a requirement with an id; the bars are the rows REQUIREMENTS marks MUST. A **pin** is a test that holds a bar's number. The speed bars are judged on dedicated machines only: PERF-08, commit p99 within the disk's floor plus a round trip plus 0.5 ms; PERF-11, 3 million deliveries a core-second; PERF-09, 500,000 writes a second per process (a SHOULD, held as slice 1's stop line). <sub>V5-23.3, .4</sub>

**MUSTs the first build does not reach** are restated as after the first build, each with its reason: P-06's `none` rung and PERF-03, judged on it (relays come later); P-18 and TEST-06 (forks need the tier); OPS-07 (restore comes with the tier); F-18 (the slow-leader rule waits; slice 2 catches only a stuck leader); OPS-13 (erase has no rule yet). F-12's recover command is built in slice 2. PERF-04 is a stated miss; DEP-19 is dropped; TEST-10 loses its twin clause. Most other MUSTs are not pinned to a slice yet. <sub>V5-23.6, V5-26</sub>

## The slices, in order

**0** ground: seven probes with kill lines. **1** one write through every layer. **2** groups that heal. **3** the slot move. **4** the read surface and the examples. **5** served views. **6** the libraries. **7** the door, the tools, the rival runs. **8** work past one process's memory. Until slice 7, v5 runs only on a trusted network. <sub>V5-24.1, .2</sub>

Slice 0 builds no rule. It proves the Raft port, which carries 77 of the ledger's 80 Raft records (63 from Raft's spec, 14 model-checked); slice 1 turns them on *(counted)*.

## One write

1. **L4, client.** `orders.data.x.set(row)` becomes one record with its stream and number. It does not show yet.
2. **L3, client.** A credit lets it out (from slice 4).
3. **L1, client.** The key hashes to a slot; the write goes to that slot's leader.
4. **L0, leader.** Rust reads it off the link and hands it up in a batch.
5. **L2, leader.** JavaScript judges it, stamps the slot's next number and a time, and hands it down.
6. **L1 and L0, every voter.** The leader sends the batch on and writes its own journal beside the sends.
7. **L1.** A majority holds it on disk: it is committed.
8. **L2 and `data`, every copy.** The batch crosses up once and `data` folds it.
9. **L3.** Rust sends the committed bytes to every link that reads the row.
10. **Client.** Its fold shows the row; the write resolves with the row's version.

*(Reasoned from LAYERS 8.1; no run exists.)*

## Not in the first build

In [later.json](later.json): answer stages, the `none` rung, the object store's segments and snapshot layers, restore, forks, the slow-leader rule. Also later: rows and views in Rust; the `memory` rung; writes across regions; app-written combines; a standby merger; a folded resume. No move from v4: it has no users. <sub>V5-5, V5-20.21, V5-22.4, V5-23.2</sub>
