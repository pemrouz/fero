# E-03: what a call between JavaScript and Rust costs

## The question

Q-03: what does a call from JavaScript into Rust (napi, Node's native addon interface) cost, per call and per record? (QUESTIONS.md §1.) It decides whether RUST can keep L2 and user rules in JS over a Rust core (K `lib` × L `rs+napi`) or must move them to Rust or WASM; EMB-V8 (L `rs+v8`, a V8 engine inside a Rust server); SIDE (H `side`, fero as a Rust daemon beside the app's Node process); conflict X3; DATA-09; PERF-10.

Words used below:
- **napi**: Node-API, the stable C interface a native addon uses to talk to Node. **napi-rs** is the Rust library that wraps it.
- **A crossing**: one call from one language into the other, and back.
- **A threadsafe function (TSFN)**: napi's way for a Rust thread to queue a call into JS; JS runs it later, on its own thread, from the event loop.
- **A ring**: a fixed block of shared memory with a head and a tail counter; one side writes records and moves the head, the other reads them and moves the tail.
- **An isolate**: one V8 engine instance. **deno_core** embeds V8 in a Rust program; **rquickjs** embeds QuickJS, a small JS interpreter.
- **data's fold**: data's hot lane (`lane()`), the call fero v4's `api/substrate.ts` makes to apply committed records to rows.

## The answer in short

All measured here, under the timing lock: medians of 3 runs on Node 22.22.0 unless marked (ranges in the tables).

- **Rules can stay in JS.** Rust calling a JS function from inside a napi call costs **107 ns** per call with napi-rs's `Function::call` (103 ns raw; 92-93 ns on Node 26). The bar is ≤ 300 ns. An empty call from JS into Rust costs 24 ns; with one number in and out, 109 ns (napi-rs checks and converts each value).
- **But not one async call per record from a Rust thread.** A threadsafe function (a Rust thread queueing a call into JS) costs **3.8 µs** per call and 5.2 µs of CPU: over the 1 µs line. Batching fixes it: 424 ns per record at 16 records a call, **52 ns at 256**, 25 ns at 4,096. A `SharedArrayBuffer` ring from a Rust thread to JS costs **14 ns** per record at any batch size, while JS spins (it burns a core while it waits).
- **Bytes: pass in or fill, never hand out a new Buffer.** A 4 KB buffer into Rust: 111 ns borrowed, 182 ns as napi-rs's owned `Buffer`. Rust filling a JS-owned buffer: 124 ns. A new 4 KB Buffer handed out per call: **3.2 µs** (a Rust `Vec` as an external Buffer) to **5.7 µs** (a copy), from garbage collection and external-memory bookkeeping.
- **X3 holds: the crossing is under 1 ns per record at batch 256.** Handing a 256-record frame (8.5 KB) from Rust to JS costs 0.74 ns per record (JS pulls) or 0.62 ns (Rust pushes). End to end, Rust's bytes to data's rows took 1,190-1,200 ns per record against 1,164 from bytes JS already held (+2-3%, inside the spread). The cost is decoding: fero v4's codec takes **712 ns** per record, data's lane **76 ns**. A TS kernel's follower pays that decode too. Rust building the record objects itself through napi costs **888 ns** per record, more than JS's own decode: hand bytes, decode in JS.
- **EMB-V8 stays live.** In deno_core (V8 inside Rust) an empty op costs **2.6 ns** and a 4 KB buffer op 6.8 ns (bar ≤ 100 ns), and data's fold runs at **70 ns** per record against 87 in Node 22 and 79 in Node 26 (0.80-0.88 ×; bar ≤ 1.2 ×). Memory: a bare isolate holds 1.28 MB of heap, data's code 0.28 MB more, each row 196 bytes (Node: 182); the process RSS is 37 MB; a runtime takes 10.5 ms to create without a snapshot.
- **QuickJS is out for data's fold.** In rquickjs an op costs 40 ns, but data's fold costs **1,425 ns** per record: **16-18 × Node**, and a row takes 417 bytes (2.3 × Node). It stays fine for tiny scripts (a 10 MB process).
- **SIDE: a shared-memory ring meets the bar; a socket does not; a call per op does not come close.** From a Rust daemon to a Node process at batch 256: a ring in `/dev/shm` costs **15 ns** per record, **1.5 ×** napi's cheapest path at batch 256 (the direct call, 10.3 ns; bar ≤ 2 ×), but Node needs a small native addon to map the memory (one call at start). A Unix socket stream costs **44 ns** per record (**4.3 ×**, over the bar), 46 ns of Node's CPU. A request and its reply over the socket take **33 µs** at batch 1, so a write or a method that waits on the daemon for each operation costs 10 × PERF-10's 3 µs bar for a conditional op.

## What was built

All code is in this folder; nothing in fero or data was changed.

| Part | File | What it does |
|---|---|---|
| napi addon | [addon/src/lib.rs](addon/src/lib.rs) | napi-rs 3.16.1 (napi4). An empty call; a 4 KB Buffer passed in (napi-rs's owned `Buffer`, which takes a napi reference, and a borrowed `Uint8ArraySlice`), filled by Rust, and handed out new (a Rust `Vec` moved into an external Buffer, or copied); Rust calling a JS function once per record from inside one napi call (napi-rs `Function::call` and raw `napi_call_function`), and once per batch of 1, 16, 256 or 4,096 100-byte records written into a JS-owned scratch Buffer; a raw threadsafe function fed by a Rust thread, one call per batch (blocking mode, queue of 1,024); a ring in a `SharedArrayBuffer` written by a Rust thread and read by JS (JS spins on the head: V8's `Atomics.wait` cannot be woken from Rust); fero v4 frames handed to JS (pull: JS asks, Rust copies a frame into a scratch Buffer; push: Rust calls JS per frame); Rust building the record objects itself through napi; and a `/dev/shm` map handed to JS as an external ArrayBuffer (for SIDE). |
| napi bench | [bench/napi.mjs](bench/napi.mjs) | Times each crossing: 5 repetitions after a warm-up, median and range. Run on Node 22.22.0 and Node 26.13.0. |
| X3 bench | [bench/fold.mjs](bench/fold.mjs) | 256-record batches of fero v4 wire records (half field updates `[row, 'n'] = number`, half whole-row sets of a 3-field object) over 10,000 rows. Encoded once with fero v4's own codec ([kernel/codec.ts](../../../../kernel/codec.ts) `encodeFrame`), decoded with its `Frame.records()` and `rec()`, folded with data's `lane()` (data at 63fea66). Measures the lane alone, decode alone, decode + lane from bytes JS holds, and the same from bytes Rust hands over (pull, push), and from objects Rust builds. The crossing's price is the difference. |
| isolate hosts | [isolate/work.js](isolate/work.js), [isolate/shim.js](isolate/shim.js), [isolate/node-host.mjs](isolate/node-host.mjs), [isolate/denocore/src/main.rs](isolate/denocore/src/main.rs), [isolate/quickjs/src/main.rs](isolate/quickjs/src/main.rs) | The same plain script in four hosts: Node 22, Node 26, deno_core 0.413.0 (V8 from the v8 crate 150.4.0) and rquickjs 0.14.0. data is bundled into one script with esbuild 0.25.12 (`--ignore-annotations`, so every side-effect import of data's operators stays). Each host times an empty loop, an empty Rust op, a 4 KB buffer op, and data's lane on 256-record batches, and reports memory (heap for data's code, heap per row at 10,000 rows, RSS). The shim only adds `console`, `performance`, `queueMicrotask`, `structuredClone` and `setTimeout` where a bare engine lacks them; none is on the lane's path (checked in the bundle). |
| SIDE seam | [seam/daemon/src/main.rs](seam/daemon/src/main.rs), [seam/client.mjs](seam/client.mjs) | A Rust daemon (standard library only) gives a Node process 100-byte records: streamed over a Unix socket in frames of 16, 256 or 4,096; request/reply over the socket (one 1-byte request, one frame back); and through a ring in `/dev/shm`, mapped into Node by the addon's `map_shm` (one napi call at start, none per record). Reports wall ns per record, Node's CPU and the daemon's CPU per record. |

Bars from QUESTIONS.md Q-03: a JS rule called per record ≤ 300 ns (keeps L2 and rules in JS) and ≥ 1 µs (moves them out); a batch of 256 handed to data's fold at ≤ 50 ns per record (X3 holds); an isolate op ≤ 100 ns and data's fold inside it within 1.2 × plain Node (EMB-V8 stays); the local seam ≤ 2 × napi's per-record cost at batch 256 (SIDE stays).

How X3's bar is read here (reasoned): a TS kernel's follower also turns wire bytes into records before data folds them, so decoding is paid by every design. What a Rust kernel adds is the crossing: getting the bytes (or objects) from Rust to JS. So the bar is checked on the crossing's extra cost per record (pull or push minus decode + lane from bytes JS already holds), and the decode and the lane are reported beside it.

## How it was measured

- Every timed number ran under `$SP/bin/timing` (the box alone apart from processes that skip the lock), 3 timing runs, each a batch of all the benches in one hold of a few minutes; every bench line is preceded by the load average at its start ([results/](results)). Within a run each measure is repeated 5 times after a warm-up and the run's median is kept; the tables give the median of the 3 run medians and (in brackets) their range.
- Box: 4 vCPU Firecracker VM, 15 GB RAM, Ubuntu 24.04, kernel 6.18.44; Node 22.22.0 (V8 12.4.254.21) and 26.13.0 (V8 14.6.202.34); Rust 1.97.0; napi-rs 3.16.1; deno_core 0.413.0; rquickjs 0.14.0; data 63fea66; fero 68a5b8e for `kernel/codec.ts`.
- `./run.sh build` compiles everything under the heavy lock, `./run.sh timing` runs the 3 timing batches, `python3 -I summarize.py` writes [results/tables.md](results/tables.md). [fetch.sh](fetch.sh) fetches esbuild and the crates.

## Results

Full tables with every row and run: [results/tables.md](results/tables.md). Raw lines: [results/napi.jsonl](results/napi.jsonl), [results/napi-node26.jsonl](results/napi-node26.jsonl), [results/fold.jsonl](results/fold.jsonl), [results/isolate.jsonl](results/isolate.jsonl), [results/seam.jsonl](results/seam.jsonl). Load averages at the start of each timing batch were 1.4-4.5 (the 15-minute averages were higher: other agents' locked jobs had just ended).

### The napi seam (ns per call, or per record for the Rust-to-JS rows)

| crossing | Node 22 | Node 26 | process CPU per record (Node 22) |
|---|---|---|---|
| a plain JS call (baseline) | 7.4 | 8.1 | |
| JS → Rust, empty | 23.5 | 19.3 | |
| JS → Rust, one u32 in and out | 109 | 105 | |
| 4 KB Buffer in, borrowed (`Uint8ArraySlice`) | 111 | 107 | |
| 4 KB Buffer in, napi-rs owned `Buffer` | 182 | 169 | |
| Rust fills a JS-owned 4 KB Buffer | 124 | 126 | |
| a new 4 KB Buffer out, external | 3,237 | 3,403 | |
| a new 4 KB Buffer out, copied | 5,697 | 5,770 | |
| **Rust → JS function, once per record, napi-rs** | **107** | 92 | |
| Rust → JS function, once per record, raw napi | 103 | 93 | |
| Rust → JS directly, batch 1 / 16 / 256 / 4,096 (100 B records in a scratch Buffer) | 150 / 14.6 / **10.3** / 8.6 | 136 / 18.4 / 10.7 / 9.9 | |
| **Rust thread → JS, threadsafe function**, batch 1 / 16 / 256 / 4,096 | **3,802** / 424 / **51.7** / 24.7 | 4,107 / 388 / 45.9 / 25.9 | 5,171 / 564 / 75.8 / 44.3 |
| Rust thread → JS, SharedArrayBuffer ring, batch 1 / 16 / 256 / 4,096 | 14.4 / 14.6 / **14.0** / 14.2 | 16.9 / 16.2 / 15.4 / 15.0 | 29.5 / 29.1 / 28.0 / 28.5 |
| the same ring, each span copied out before reading, batch 256 / 4,096 | 20.7 / 19.7 | 21.3 / 20.9 | 41.6 / 38.6 |

(The ring's CPU is about twice its wall time because both threads spin. The first smoke runs, taken while other agents' jobs ran, gave the rings 200-700 ns per record: a spinning pair needs two free cores.)

### X3: a 256-record batch into data's fold (Node 22, ns per record)

| path | ns per record |
|---|---|
| data's lane on ready JS records | 76 (60-91) |
| decode fero v4 frame bytes (`Frame.records()`, `rec()`) | 712 (710-736) |
| decode + lane, bytes already in JS (a TS kernel's follower) | 1,164 (1,163-1,237) |
| Rust → JS, pull: the crossing alone (one call per frame, 8.5 KB copied) | **0.74** |
| Rust → JS, push: the crossing alone | **0.62** |
| pull + decode + lane | 1,190 (1,184-1,252) |
| push + decode + lane | 1,200 (1,122-1,230) |
| Rust builds the record objects through napi, alone | 888 (860-905) |
| Rust builds the objects + lane | 1,142 (1,106-1,152) |

### EMB-V8: the same script in four hosts

| host | empty op (ns) | 4 KB buffer op (ns) | data's fold (ns per record) | × Node 22 | heap per row (bytes) | heap for data's code | RSS |
|---|---|---|---|---|---|---|---|
| Node 22.22.0 (napi, from above) | 23.5 | 111 | 87.2 (76-90) | 1.00 | 182 | 0.81 MB | 53 MB |
| Node 26.13.0 | 19.3 | 107 | 78.9 (68-79) | 0.90 | 183 | 0.85 MB | 61 MB |
| **deno_core 0.413.0** (V8 via the v8 crate 150.4.0) | **2.6** | **6.8** | **69.8 (69-71)** | **0.80** | 196 | 0.28 MB (bare isolate 1.28 MB) | 37 MB |
| rquickjs 0.14.0 | 40.4 | 83.1 | **1,425 (1,208-1,444)** | **16.3** | 417 | 0.78 MB (bare 0.10 MB) | 10 MB |

Node's "heap for data's code" is measured in an already-running Node process, so it is not comparable with a bare isolate's. A deno_core runtime took 10.5 ms to create (no startup snapshot); a QuickJS one 0.2 ms.

### SIDE: a Rust daemon to a Node process (100 B records)

| seam | ns per record (wall) | Node CPU | daemon CPU | round trip |
|---|---|---|---|---|
| Unix socket stream, batch 16 / **256** / 4,096 | 88 / **44** / 71 | 90 / 46 / 71 | 71 / 19 / 16 | |
| Unix socket, request and reply, batch 1 / 16 / 256 | 32,685 / 2,276 / 204 | 21,085 / 1,524 / 134 | 12,290 / 822 / 70 | **32.7 µs** / 36.4 µs / 52.3 µs |
| `/dev/shm` ring, batch 16 / **256** / 4,096 | 14.4 / **15.3** / 16.9 | 14 / 15 / 17 | 14 / 15 / 17 | |
| the same, each span copied out first, batch 256 / 4,096 | 17.0 / 17.4 | 17 / 17 | 17 / 17 | |

Against napi at batch 256: the direct call 10.3 ns, the in-process ring 14.0 ns, the threadsafe function 51.7 ns. The shm ring is 1.5 × the direct call; the socket stream 4.3 ×.

## What this box cannot show

- **One machine, 4 vCPUs, other agents.** The timing lock keeps other agents' locked jobs off the box, not every process. A Rust thread and the JS thread need two free cores; with four, a stray process can still preempt one, which hits the spinning ring benches hardest.
- **A VM's cores.** Cross-core cache traffic (the ring benches, the socket) depends on how the host maps vCPUs to physical cores, which a guest cannot see.
- **Other platforms.** Linux x86-64 only; macOS and Windows napi and socket costs differ.
- **Real user code.** The "rule" here is a function that adds a number. A real rule costs its own work on top of the crossing.
- **data's own cost is not this experiment's.** E-05 owns the fold's cost per record, per row and per GB of replay; the lane numbers here are only the baseline the crossing is compared against.

## Verdict

Against QUESTIONS.md's bars for Q-03:

| Bar | Measured | Result |
|---|---|---|
| a JS rule called per record ≤ 300 ns → RUST keeps L2 and rules in JS; ≥ 1 µs → they move out | 107 ns from inside a napi call; 3.8 µs through a threadsafe function from a Rust thread, 52 ns per record at batch 256 | **met**, on one condition: the Rust core runs on the JS thread (JS calls it, it calls rules back) or hands work across threads in batches of 16 or more |
| a 256-record batch handed to data's fold ≤ 50 ns per record → X3 holds | 0.6-0.7 ns per record for the crossing; +26-36 ns end to end (inside the spread) | **met**; decode in JS from bytes; never build the records in Rust (888 ns per record) |
| an isolate op ≤ 100 ns and data's fold within 1.2 × Node → EMB-V8 stays | deno_core: 2.6 ns op, fold 0.80 × Node 22 (0.88 × Node 26) | **met**: EMB-V8 is a live candidate; rquickjs fails (fold 16-18 ×) and is pruned |
| the local seam ≤ 2 × napi's per-record cost at batch 256 → SIDE stays | `/dev/shm` ring 1.5 ×; Unix socket stream 4.3 ×; a request/reply round trip 33 µs | **met only by the shared-memory ring**, which needs a small native addon in Node; SIDE stays, but each synchronous call to the daemon costs about 33 µs |

What else this changes (reasoned from the numbers): with a native kernel, data's fold stays data's code in JS at a negligible crossing cost, so DATA-09's differential test is needed only if a fold moves native. The largest cost on a follower's path is not the seam but decoding: fero v4's value codec takes 712 ns per record against data's lane at 76 ns. That holds for a TS kernel as much as a Rust one, and it is most of E-05's 2 µs fold budget.

Cost: about 5 agent-hours (most of the wall time was waiting for the timing lock), under the entry's 10; about 0.3 CPU-hours.

Q-03: a call from Rust into a JS function costs 107 ns from inside a napi call (bar 300 ns) but 3.8 µs through a threadsafe function from a Rust thread (52 ns per record at batch 256; a SharedArrayBuffer ring 14 ns); handing a 256-record batch to data's JS fold costs under 1 ns per record for the crossing (the follower's real cost is fero v4's decode, 712 ns per record, which a TS kernel pays too; Rust-built objects cost 888 ns); deno_core ops cost 2.6 ns and data's fold runs at 0.80 × Node inside it, while QuickJS folds 16 × slower; a Rust daemon reaches Node at 15 ns per record over a /dev/shm ring (1.5 × napi's 10.3 ns) but 44 ns over a Unix socket (4.3 ×) and 33 µs per request/reply. Moves: RUST up on G1, DEV-05, PERF-10, DATA-09 and X3 (L2 and rules stay in JS, data folds in JS, on the condition that the core is called on the JS thread or crosses threads in batches); EMB-V8 kept as a live candidate (up on G2 and G6); the rquickjs variant of EMB-V8 pruned (fold 16-18 × Node); SIDE kept only with a shared-memory ring and a small mmap addon (a socket alone fails the 2 × bar), and down on PERF-10 (each synchronous call to the daemon costs about 33 µs, against 3 µs and 10 µs bars).
