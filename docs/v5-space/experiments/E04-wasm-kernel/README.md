# E-04: one Rust kernel in WASM for the sim, and whether a TS and a Rust kernel stay byte-identical

## The question

Q-04: could one Rust kernel, compiled to WASM (WebAssembly) for the sim and the site, replace the two-kernel plan; and do a TS and a Rust kernel stay byte-identical in practice? (QUESTIONS.md §1.) It decides L `wasm` against `ts→rs` (X2, TEST-10, DEV-07), and whether "two kernels for a while" is needed at all.

Words used below:
- **The kernel**: the pure part of a replica: events in (a tick, a message, a client write), effects out (messages to send, bytes to persist, entries to apply). No I/O. The sim, the server and the site all drive the same kernel.
- **WASM**: WebAssembly, a portable binary that V8 (Node, browsers) runs at near-native speed. A **crossing** is one call from JS into WASM and back; bytes cross by copying into and out of WASM's linear memory.
- **A twin**: the same kernel written twice, here once in TypeScript and once in Rust, to one written spec.
- **The guard**: TEST-10's differential test: feed both twins the same seeded inputs and compare every output byte.
- **A chaos seed**: one seeded sim run with crashes, cut links, lost and delayed messages and client writes; the seed fixes every random choice, so a run replays exactly.
- **TEST-01's bar**: a fresh node plus a scenario ≤ 5 ms; 200 chaos seeds ≤ 1 s.

## The answer in short

All measured here unless marked. Timing: medians of 3 timing runs (ranges in the tables).

- **TEST-01 holds with the kernel in WASM, if the sim reuses one WASM instance.** 200 chaos seeds took **102 ms** with K in WASM (bar 1 s) and **384 ms** with raft-rs 0.7.0 in WASM; a fresh solo node plus a scenario took **0.011 ms** at p50 and **0.054 ms** at p99 with K, and 0.016 / 0.053 ms with raft-rs (bar 5 ms). Every applied entry was folded by data's hot lane in JS, as fero's sim would.
- **A fresh WASM instance per test misses the 5 ms bar at p99.** Making a new instance per scenario gave p99 **7.3 ms** (K) and **7.9 ms** (raft-rs), max 38-56 ms. Making an instance is cheap (15 µs at p50), but each one's linear memory pushes V8 into a full garbage collection about every 70 instances (30 major collections in 2,000 instances, [results/instance-gc.txt](results/instance-gc.txt)). So the rule is: one instance per test worker, and the kernel resets its own state inside it (`k_reset`, `r_reset` here). Per chaos seed, a fresh instance still fits the 1 s bar (555 ms for 200 raft-rs seeds).
- **Crossing into WASM is cheap next to the sim around it.** Replaying the recorded kernel calls of 200 K seeds with no driver: native Rust **59 ns** per event, the same Rust in WASM in one call **81 ns** (1.4 × native), and from JS with **one crossing per event 178 ns**. So a crossing with its effects costs about **100 ns** per event. The TS twin replays at **501 ns** per event (2.8 × the WASM twin from JS). Inside the full sim the driver (seeded choices, the network, decoding effects) and data's fold cost about 400 ns per event, so the K sim runs at 590 ns per event in WASM and 869 in TS.
- **A real Raft library in WASM is no faster in the sim than the TS port.** raft-rs in WASM: 1,346 ns per event; E-10's TS port of etcd raft: 1,374 ns. raft-rs's speed is spent encoding and decoding every message as protobuf to cross into WASM, while the TS port hands JS objects around. A TS kernel in a TS sim never serialises; a WASM kernel always does.
- **The two twins stayed byte-identical.** Over 1,000 seeds (883,902 kernel events with crashes, cut links, loss, non-ASCII and emoji keys, numbers ≥ 2^53 and ids ≥ 2^32) the TS twin and the WASM twin produced the same bytes at every step and the same final state on every node, on the first run of the guard. Both twins were written by one agent who knew the classic traps, which biases this towards identity.
- **The guard catches the classic traps, but only with the right inputs and a state check.** Each trap planted in one twin was caught: map iteration order (Rust `HashMap`) in 994 of 1,000 seeds, a UTF-16 sort (JS's default `sort()`) in 523, a UTF-16 length used as the UTF-8 length in 994, a 32-bit varint (`>>>`) in 101, an `i64` counter in place of an f64 in 459. Three of the five never changed a single effect byte: they showed only in the final state dump. The varint trap showed only in the 10% of seeds that used request ids ≥ 2^32. So TEST-10's guard must compare state, not only effects, and its seeds must include every class of input that reaches a different code path (non-ASCII, astral and BMP-high keys; integers ≥ 2^32 in every varint field; numbers ≥ 2^53 and fractions in every numeric op).

## What was built

1,355 lines, all in this folder; nothing in fero or data was changed.

Two honesty notes on how the twins were made. (1) Both were written by one agent, to the spec in k.ts's header, knowing the classic traps. (2) Each twin is a first cut with one tuning pass on the TS side only: profiling showed the TS twin spending a third of its time in `TextEncoder`, `TextDecoder` and the garbage collector, so entries now keep their key's UTF-8 bytes and decode the string once, at apply (this about halved its replay cost, from 660-930 to 340-420 ns per event in smoke runs, not timing runs). The Rust twin was not tuned (it allocates a `String` per key read). During development the guard's first trap runs missed the 32-bit varint trap because the sim encoded its own events with the trapped encoder too, so both twins saw the same wrong bytes; the traps were then confined to the kernel's own writers. No kernel difference between the twins was found at any point.

| Part | File | What it is |
|---|---|---|
| K, the TS twin | [k-ts/k.ts](k-ts/k.ts) | A small replication kernel with a written spec in its header: E-02's inner loop (encode a record, keep a journal, fold into a map) plus Raft-lite elections (terms, votes with the up-to-date check, appends with the log-matching check and truncation, majority commit of current-term entries, a no-op entry on election), timers driven by ticks and a seeded xorshift inside the kernel. Events and effects are bytes: LEB128 varints, f64 values (data's numbers are f64), UTF-8 keys. A crash keeps only what the node persisted: the journal is a stream of `PERSIST` effects that the sim keeps and hands back on restart. |
| K, the Rust twin | [k-rs/src/lib.rs](k-rs/src/lib.rs) | The same spec written as a Rust developer would (a `BTreeMap`, `Vec<u8>`, `u64` counters). Built for `wasm32-unknown-unknown` (59.6 KB, no imports) and natively (for the replay bench). Two Cargo features plant traps for the guard's sensitivity test. |
| raft-rs in WASM | [raft-wasm/src/lib.rs](raft-wasm/src/lib.rs) | raft-rs 0.7.0 (protobuf codec, no default logger) behind a byte ABI, built for `wasm32-unknown-unknown` (1.34 MB). It handles each `Ready` the way raft-rs's own example does. Messages cross as protobuf bytes. getrandom's "custom" hook seeds raft-rs's election timeouts, so a fresh instance replays a seed exactly (checked: the same seed twice gave the same run). |
| The sims | [sim/simk.ts](sim/simk.ts), [sim/simraft.ts](sim/simraft.ts), [sim/kwasm.ts](sim/kwasm.ts) | One chaos shape for both kernels: 3 nodes (5 in a fifth of the seeds), 130 ticks, each tick a 2% chance of crashing a node for 3-12 ticks and a 2% chance of cutting a node's links for 5-14 ticks, 5% message loss, 1-3 ticks of delay, a client write in 60% of ticks to a random node, keys that include accented, fullwidth (U+FF5A), emoji (astral) and lone-surrogate strings, values that include fractions and numbers ≥ 2^32 and ≥ 2^53, request ids ≥ 2^32 in a tenth of the seeds. Every applied entry on every node is folded by data's hot lane in JS (data 63fea66), as user code and data's fold would run in fero's sim. Monitors: every node applies the same entry at the same index; nodes at the same applied index fold to the same data value. The Raft sim runs raft-rs in WASM and E-10's TypeScript port of etcd raft (messages stay JS objects there), both with election tick 10, heartbeat tick 1, PreVote and CheckQuorum. |
| Benches | [bench/diff.ts](bench/diff.ts), [bench/record.ts](bench/record.ts), [bench/test01.ts](bench/test01.ts) | The guard; a recorder of 200 seeds' kernel calls; TEST-01's measures, a replay of the recorded calls with no driver (TS twin; WASM twin one call per event; WASM twin replaying the whole trace inside one call; native Rust in [k-rs/src/bin/replay.rs](k-rs/src/bin/replay.rs)), and WASM set-up costs. |

The monitors were checked once against two planted kernel bugs (not kept as a check): granting votes without the up-to-date check was caught in 264 of 1,000 seeds; committing older-term entries by count (Raft's figure-8 bug) was caught in none, since it needs a rarer schedule than these seeds make. The sim is a speed and identity harness, not a safety checker (E-46 and E-10 check Raft's safety).

## How it was measured

- **The guard** ([results/guard.jsonl](results/guard.jsonl)): 1,000 seeds through the TS twin and the WASM twin, under the heavy lock (not a timing run). It compares a hash of each step's event and effect bytes, step by step, and every live node's final state dump. Then the same with each trap planted.
- **Timing** ([results/test01.jsonl](results/test01.jsonl), [results/replay-native.jsonl](results/replay-native.jsonl)): 3 timing runs under `$SP/bin/timing`, each one hold with the load average recorded at its start. Within a run each measure repeats 5 times after a warm-up (chaos: 5 runs of 200 seeds; fresh node: 5 × 2,000 scenarios); the tables give the median of the 3 run medians and their range.
- **A chaos seed's size.** At 130 ticks a K seed makes about 864 kernel events and a Raft seed about 1,420 (raft-rs and etcd raft send a heartbeat every tick). E-22's prototype seeds made 1,372; the tables give ns per event so any size can be read off.
- **The fresh-node scenario** (TEST-01's second bar): a new solo node, 25 ticks (it elects itself), three client writes (`set`, `incr`, `set`), every applied entry folded by data, a read of the folded row, and the node destroyed. With WASM it runs in a shared instance (`reset`), or in a new instance per scenario.
- Box: 4 vCPU Firecracker VM, 15 GB RAM, Ubuntu 24.04; Node 22.22.0 (V8 12.4); Rust 1.97.0 with the `wasm32-unknown-unknown` target; raft-rs 0.7.0; data 63fea66; E-10's port as in this repo (fero 68a5b8e).
- `./run.sh build`, `./run.sh guard`, `./run.sh timing`, then `python3 -I summarize.py` writes [results/tables.md](results/tables.md). [fetch.sh](fetch.sh) adds the Rust target and fetches the crates.

## Results

### The guard (heavy lock, not a timing run; [results/guard.jsonl](results/guard.jsonl))

1,000 seeds, the same seeded inputs into the TS twin and the WASM twin. "Step" is the first kernel call whose event or effect bytes differ (-1: no step differed, only the final state dump did).

| run | seeds that differ | where it shows | first seed (step of steps) | median first step |
|---|---|---|---|---|
| clean twins | **0 of 1,000** (883,902 events) | nowhere | - | - |
| TS: keys sorted by JS's default `sort()` (UTF-16 order) | 523 | state dump only | 1 (-1 of 924) | -1 |
| TS: a key's UTF-16 length written as its UTF-8 length | 994 | state dump only (the kernel writes key bytes it was given; only the dump encodes a string) | 1 (-1 of 924) | -1 |
| TS: varint with 32-bit shifts (`>>>= 7`) | 101 | effects (the reply's request id) | 1 (6 of 924) | 0 |
| Rust: dump walks a `HashMap` in its own order | 994 | state dump only | 1 (-1 of 924) | -1 |
| Rust: `incr` adds as `i64` | 459 | effects (the applied value) and state | 2 (71 of 739) | 435 |

No monitor violation and no kernel error in any run: every trap ran to the end and differed only in bytes.

### TEST-01 (timing lock, 3 runs; load averages at start 5.61, 2.66, 1.97)

200 chaos seeds, every applied entry folded by data in JS (bar: ≤ 1 s):

| kernel | ms for 200 seeds | kernel events | ns per event | the same with no data fold |
|---|---|---|---|---|
| K, TS twin | 150 (139-191) | 172,871 | 869 | 141 ms |
| **K, WASM twin** | **102 (96-105)** | 172,871 | 590 | 83 ms |
| Raft, E-10's TS port of etcd raft | 396 (387-445) | 288,276 | 1,374 | 392 ms |
| **Raft, raft-rs 0.7.0 in WASM, one instance** | **384 (347-420)** | 285,099 | 1,346 | 356 ms |
| Raft, raft-rs in WASM, a fresh instance per seed | 555 (526-565) | 283,457 | 1,957 | 574 ms |

At E-22's seed size (274,339 events for 200 seeds), these per-event costs give 162 ms (K WASM), 238 ms (K TS), 369 ms (raft-rs WASM), 377 ms (TS port) and 537 ms (raft-rs, fresh instance per seed): all under the bar. No monitor violation in any run.

A fresh solo node plus a scenario (elect, `set`, `incr`, `set`, folded by data, one read), 2,000 per run (bar: ≤ 5 ms):

| kernel | p50 ms | p99 ms | max ms |
|---|---|---|---|
| K, TS twin | 0.015 | 0.083 (0.068-0.096) | 1.90 |
| **K, WASM twin, one shared instance** | **0.011** | **0.054 (0.046-0.057)** | 1.71 |
| K, WASM twin, a fresh instance per scenario | 0.052 | **7.32 (6.54-8.25)** | 38.4 |
| Raft, TS port | 0.028 | 0.100 (0.089-0.14) | 2.13 |
| **Raft, raft-rs WASM, one shared instance** | **0.016** | **0.053 (0.042-0.060)** | 2.05 |
| Raft, raft-rs WASM, a fresh instance per scenario | 0.45 | **7.94 (7.21-8.21)** | 55.7 |

Replay of the recorded kernel calls of 200 K seeds, no sim around them:

| how | ns per event |
|---|---|
| native Rust ([k-rs/src/bin/replay.rs](k-rs/src/bin/replay.rs)) | 58.7 (57.8-62.0) |
| the Rust twin in WASM, the whole trace inside one call | 81.0 (71.0-81.1) |
| the Rust twin in WASM, one call from JS per event (copy the event in, run, view the effects) | 178 (170-213) |
| the TS twin, one call per event | 501 (461-571) |

WASM set-up: compiling K's module 8.8 µs (V8 compiles lazily; the work moves to the first calls), raft-rs's 448 µs. Making an instance in a loop of 200, garbage collection included: 341 µs (K), 674 µs (raft-rs) on average. In the GC probe ([results/instance-gc.txt](results/instance-gc.txt), heavy lock, not a timing run): p50 15 µs, p99 2.5 ms, 30 mark-compact collections in 2,000 instances. Module sizes: K 59,603 bytes, raft-rs 1,342,615 bytes (release, no `wasm-opt`).

Full tables: [results/tables.md](results/tables.md).

## What this box cannot show

- **Browsers.** The site's kernel would run in a browser's WASM engine; only Node's V8 was measured here (E-40 owns browsers).
- **A real v5 kernel.** K is about 300 lines with one group, no snapshots, no membership change, no batching across groups; raft-rs is a real library but not fero's kernel. The crossing cost per event is what carries over; the kernel's own work will grow with the real kernel in both languages.
- **Independent authors.** Both twins were written by one agent who knew the classic traps in advance. That biases the clean result towards identity; the planted traps show what the guard catches when someone does not know them.
- **One machine, other agents.** As in every timing experiment here; the GC and instance numbers are the most sensitive to it.

## Verdict

**Threshold met, with one rule.** QUESTIONS.md's bar for Q-04 is TEST-01 with the kernel in WASM. It holds: 200 chaos seeds in 102 ms (K) and 384 ms (raft-rs), a fresh node plus a scenario at 0.054 ms p99, with data's fold and the sim in JS. The rule: the sim keeps one WASM instance per test worker and resets the kernel's state inside it; a new instance per test misses the 5 ms bar at p99 (7.3-7.9 ms) because each instance's memory drives V8 into frequent full collections. So a Rust kernel compiled to WASM can be the sim's kernel and the site's kernel, and a TS kernel need never be written for the sim: this removes "two kernels for a while" from the RUST row and from any `ts→rs` row that goes native.

What it does not change (reasoned from the numbers): WASM is not needed for speed. The TS twin also meets TEST-01 (150 ms; 0.083 ms p99), and a real Raft library in WASM ran at parity with the TS port in the sim (1,346 against 1,374 ns per event), because every message must be serialised to cross. So this result lifts a cost from Rust-first designs; it does not push a TS-first design towards Rust.

On byte identity: two twins written to one spec stayed identical over 1,000 seeds on the first try, and the guard caught all five planted traps. Two lessons for TEST-10 (and DATA-09's fold differential): the guard must compare state as well as effects (three of five traps never changed an effect byte), and its seeds must reach every input class that takes a different code path (non-ASCII, astral and BMP-high keys; integers ≥ 2^32 in every varint; numbers ≥ 2^53 and fractions in every numeric op), since a trap shows only in the seeds that reach it (10% for the varint trap here). With one Rust kernel everywhere, the kernel needs no twin at all; the guard then remains for data's fold if any layer folds natively (DATA-09).

Cost: about 6 agent-hours for this experiment (most of the wall time was waiting for the timing lock), under the entry's 7; about 0.3 CPU-hours.

Q-04: yes: a Rust kernel compiled to WASM meets TEST-01 as the sim's kernel (200 chaos seeds 102 ms with K and 384 ms with raft-rs 0.7.0 against 1 s; a fresh node plus a scenario 0.054 ms p99 against 5 ms, data's fold in JS) if the sim reuses one instance per worker and resets state inside it (a fresh instance per test gives 7.3-7.9 ms p99, over the bar, from V8's collections of instance memory); a crossing costs about 100 ns per event and WASM runs at 1.4 × native, but a real Raft library in WASM is only at parity with the TS port in the sim (1,346 vs 1,374 ns/event) because messages must be serialised; a TS and a Rust twin stayed byte-identical over 1,000 seeds (883,902 events) on the first run, and the guard caught all five planted traps (map order, UTF-16 sort, UTF-16 length, 32-bit varint, i64 counter) only by comparing state as well as effects and only in seeds whose inputs reach the trap. Moves: RUST up on TEST-01, TEST-10, DEV-07 and X2 (one kernel's bytes in the sim, the site and the server; no TS kernel needed); L `wasm` up as the sim and site form of any native kernel; MIN, DRAFT and LEAN (`ts→rs`) up on X2 (going native later no longer means two kernels) and neutral on TEST-01 (their TS kernel passes too); MIN-TS unchanged; every row that keeps two kernels or a native fold takes TEST-10's guard as specified here (state compared; inputs ≥ 2^32, ≥ 2^53, fractions, non-ASCII, astral and BMP-high keys).
