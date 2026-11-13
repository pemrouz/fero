# E-50: what each step of a path costs (the micro-benchmarks behind PATHS.md)

**Question (Q-50).** The owner asked: "flatten and step through all the steps different paths/scenarios can take to work out if it's the most optimal/efficient in each case e.g. zero copy, not decoding/encoding unnecessarily where not needed". [PATHS.md](../../PATHS.md) does the stepping, for the chosen design (DECISIONS V5-1 to V5-6). To say whether a step is waste, and how much, it needs the price of each kind of step on this box: a checksum, an encode, a decode at each depth, a copy, a thread crossing, a flush, a message on a link, a read, a route, a subscriber's frame. This experiment measures those prices. It asks sixteen small questions, one per results section below (sections 1 to 16; section 17 says what moved between two passes), and says which of PATHS.md's findings each one settles.

**Where the study stood** (cited: the experiments named). [E-05] priced `data`'s fold (0.22-1.90 µs a record in batches) and v4's replay (36 s per GB; the same records as JSON in 21 s per GB). [E-03] timed v4's decode at 712 ns a record on a mix of half field updates and half 3-field rows, which agrees with this experiment's 359 ns a field record and 2.7 µs a 7-field row. [E-07] priced a crossing between threads in batches (27-40 ns a record). [E-02] priced the replicated pipeline without a client, judging, a record codec or Raft itself; [E-11] ran E-10's real Raft port, up to 10,000 writes a second. [E-34] split a 10 GB wake into read, checksum, decode and fold. Nothing had priced v4's codec at each depth of reading, a checksum per byte against per call, a crossing's CPU (not only its time), the flush's thread, a TLS message alone against in a batch, `f.snapshot`, or the work a server does per subscriber. v4's codec itself records why it left JSON: in v2 "JSON.parse became ~85% of decode" (code: kernel/codec.ts:21-23). Section 3 and sections 12, 13 and 16 (added after the check) show how much of that holds: it depends on the row's shape, on whether the rows are kept, and on the escape JSON needs.

**Threshold.** None: no target is set. Each measure decides which way one or more of PATHS.md's findings go, and how large it is. The bench table under Method, and each result, name them.

**In short** (measured here: 3 runs each, every process alone under the study's timing lock; ranges in brackets are the lowest and highest run):

- **A checksum in JavaScript costs 40-55 times a copy; a native one is cheap only once per batch.** v4's crc32c runs at 2.2-2.9 ns a byte (340-450 MB/s). Node's native `zlib.crc32` runs at 0.19-0.20 ns a byte over bytes already in the CPU's cache (a frame just read), 0.45-0.48 ns streamed from memory on this host. Called once per 100 B record it costs 213 ns a call, as slow as the JavaScript one. A copy into a reused buffer costs 0.05 ns a byte.
- **The decode is the big cost per record, larger than `data`'s fold.** v4's codec decodes a small row in 2.7 µs (frames of 256), encodes it in 1.7 µs, and spends 0.3 µs just finding where each record ends (0.6 µs with its checksum), because records carry no length. The same row with its value as JSON text decodes in 0.89 µs (0.62 µs as one JSON array per frame); in V8's own format 0.84 µs. A short-ASCII string path takes v4's string decode from 91 to 57 ns a string.
- **How much JSON saves depends on the row's shape, and on whether its rows are kept** (sections 12 and 16, added after the check). Kept, as a fold keeps them, the value as JSON saves about 55 % of v4's decode on a small row of many short strings, about 6-7 % on a field record (which a fold does not keep) and about 17-27 % on a 2 KB row in these runs (13 % at 1,000,000 rows in a second check's rerun, so about 10-27 %); V8's own format saves about 43-53 % on a 2 KB row. The 2 KB gain shrinks as the heap grows, so E-34's 10 GB wake rebuilds to about 51-64 s with snapshots in V8's format and 64-75 s with JSON values, not the 30-36 s PATHS.md first gave.
- **The escape that JSON needs** (NaN, -0, `undefined`, big integers, bytes) **costs a walk at encode**, 6 ns for a number, 59 ns for a small row and 74 ns for a 2 KB row; a reviver on every record would cost 4.6 µs on a small row (section 13).
- **Bytes:** v4 spends 28 of a small row's 139 B on 3-byte string lengths (a 1-byte length gives 111 B, decoded back exactly) and 99 B of every frame's envelope on two 36-character names.
- **v4's API edge:** a local write costs 7.7 µs and a received record 7.6 µs; about a quarter to a third of that is the kernel's own cell copy and its sorted-stringify state hash, and 12-23 % the collector. v4 makes 7.1-8.1 KB of garbage per small-row record.
- **A crossing between threads, quiet, costs 42.5 µs of CPU per round trip** (38 µs p50, 88 µs p99). **A flush** costs 33 µs of CPU and 112 µs p50 in place, 67-72 µs and 158-167 µs through one pool hop or on a journal thread of its own, and 104 µs and 194 µs as v4 does it (two pool hops). The second pool hop, not fsync against fdatasync, makes v4's way dear (section 14).
- **E-10's real Raft port costs about three times E-02's bare pipeline:** 47-55 µs a write across three processes at 50,000 writes a second, in E-11's simple host, against 13.2-17.0 µs (section 15). PATHS.md's busy budget had used E-02's figure. At that rate the host was at its limit (commit p50 14-18 ms), where it batches more and pays less per write, so 47-55 µs is a point, not a ceiling.
- **A TLS message alone costs 8.7 µs; in a batch of 64, 0.58 µs.** A TLS handshake costs 2.0 ms of CPU; a signature check 77-104 µs.
- **`f.snapshot.k` costs 87 µs at 1e3 rows, 33 ms at 1e5 and 0.53 s at 1e6**; a plain `Map` read of the same rows 43 ns to 1.2 µs; `f.data.k` 0.6-5.2 µs.
- **Per subscriber:** re-encoding a small row costs 2.1 µs; copying its bytes into the subscriber's frame with one native checksum 0.11 µs; a slot test to route it 1-4 ns, against 0.48 µs to decode its key. v4's one control frame per change costs 4.4 µs to serve and 4.4 µs to apply, against 2.0 and 2.7 µs batched (20 ns each when 100 share the batch).
- **A 100-row room's first picture** costs 28 ms at 1e6 rows by scanning every row, 0.74 ms with an index, and 7.4 µs each when 100 subscribers share it.
- **The box changed between the two passes** (a machine restart): JavaScript work ran 10-28 % faster in the rerun and memory-bound work 12-67 % slower. Every ratio that decides one of PATHS.md's findings held in both passes except one: a flush on a journal thread of its own was cheaper than one pool hop on the first host (66 against 83 µs of CPU) and about equal on the rerun's (72 against 67 µs).

## Words used here

- **Checksum**: a short code over some bytes that changes if any byte changes. v4 uses **crc32c** written in JavaScript. Node has a native **CRC-32** (`zlib.crc32`, the IEEE polynomial: a different code, so a format change).
- **Encode**: objects to bytes. **Decode**: bytes to objects. **Scan**: walk bytes to find where each record ends, without building objects. **Key decode**: build only each record's key.
- **Frame**: one message on a link or one row in a file; v4's frame has an 11-byte header and a crc32c over header and body. A **batch** here is 256 records in one frame.
- **Small row**: E-05's row, about 100 B as JSON (`name`, `email`, `region`, `room`, `n`, `active`, `tags`); 123-147 B as one record in v4's codec. A **field** record sets one field to a number.
- **Main** and **worker**: a server's two JavaScript threads. A **crossing** is one message between them. **libuv's pool** is the few threads Node runs file calls on.
- **Quiet**: one operation in flight on an otherwise idle box. On this VM an idle vCPU takes about 25 µs to wake ([E-01], reasoned there), so quiet costs are near the top of what a busy server pays.
- **CPU** below is `process.cpuUsage()`: every thread of the process. **Wall** is elapsed time.

## Method

**The box.** 4 vCPU (Intel Xeon at 2.10 GHz, as `/proc/cpuinfo` names it), 15 GB, Linux 6.18 (a Firecracker VM), Node 22.22.0 with `--experimental-strip-types`, OpenSSL 3.5.4. The disk is the box's one virtual disk (`/dev/vda`, ext4). [results/versions.txt](results/versions.txt) records it.

**The code.** Benches that need only the codec import fero v4's own `kernel/codec.ts` from this repo, unchanged, by a relative path. Benches that need fero's seam onto `data` (`api/substrate.ts` imports `../../data/api/index.ts`) import from a scratch tree that [bench/tree.sh](bench/tree.sh) builds outside the repo: fero v4's `api/`, `kernel/`, `shell/` and `utils/` copied unchanged at `cab0913`, with `data` at `63fea66` linked beside them. Nothing in fero or `data` is changed.

**The runs.** [run.sh](run.sh) runs each part 3 times. Each process runs alone on the box under the study's timing lock (`$SP/bin/timing`, which waits for every other heavy or timed job to end) and takes well under a minute. Before each process the lock writes `/proc/loadavg` into the results file, then the process writes one JSON line (or one per case). Inside a process each case is the median of 5 to 7 rounds; the tables give the median of the 3 runs, then the lowest and highest run. [bench/summarize.py](bench/summarize.py) prints every table below from [results/](results) into [results/tables.md](results/tables.md).

**The benches** ([bench/](bench); four folders, after the four parts of PATHS.md):

| Bench | What it times | Settles |
|---|---|---|
| [write/crc.mjs](bench/write/crc.mjs) | one checksum pass at 128 B to 1 MiB: v4's crc32c (its 256-entry table, one byte a step, copied from `kernel/codec.ts:139-153`), a slice-by-8 crc32c in JavaScript, and `zlib.crc32`; both crc32c checked against the published check value | PA-1a, PA-32 |
| [write/codec.ts](bench/write/codec.ts) | v4's codec per record, in frames of 1, 16 and 256, small rows and field records: encode (its crc share apart), scan, key decode, full decode, the deep copy a local write takes at issue (`copyOf`, V4-52) and the walk alone; then one 1 MiB value as a string and as bytes | PA-1a, PA-1b, PA-5, PA-12, PA-13 |
| [write/hop.mjs](bench/write/hop.mjs) | the time of one hop when the box is idle, one message at a time: an event-loop turn, a main → worker → main round trip (64 B transferred each way), an async `fs.write` (one pool hop) and the same write done synchronously | PA-2, PA-3 |
| [write/strdec.mjs](bench/write/strdec.mjs) | the 13 strings of a small row decoded with `TextDecoder` over a subarray each (v4: `kernel/codec.ts:576-581`) against a short-ASCII fast path | PA-13 |
| [reads/local-read.mjs](bench/reads/local-read.mjs) | one read of a held row's field on a copy holding 1e3, 1e5 or 1e6 rows: v4's `f.snapshot.k`, building the snapshot alone, `f.data.k` through fero's lens, `data`'s own handle, and a plain `Map` of the same rows (the floor); the key string's cost subtracted | PA-8, PA-31 |
| [reads/route.mjs](bench/reads/route.mjs) | a serving copy routing each record of a committed 256-record frame to whoever follows its partition (100,000 partitions over 4,096 slots, 0 to 100,000 followed): full decode, key decode, or a slot test first; then cutting one subscriber's frame out of the batch: v4's re-encode against copying the chosen records' bytes with one checksum (a self-check decodes each cut frame back) | PA-5, PA-12, PA-32 |
| [reads/substream.mjs](bench/reads/substream.mjs) | a live subscription's changes as v4's method plane sends them (one `SUBREC` control frame per change per subscriber) against one frame per 256 changes encoded once, served to 1 and 100 subscribers and applied at the client | PA-5, PA-11 |
| [reads/snapshot-serve.mjs](bench/reads/snapshot-serve.mjs) | a server answering one state-mode subscription to a 100-row room (a prefix partition) at 1e5 and 1e6 rows: scanning every row, or an in-memory index from partition to rows; and the same picture shared by 100 and 1,000 subscribers | PA-17 |
| [upkeep/b1-checksum.mjs](bench/upkeep/b1-checksum.mjs) | a checksum and a copy per byte over 32 MB: v4's crc32c and `zlib.crc32` called once per 100 B record, once per 25.6 KB batch, once per MiB, and per batch over one 1 MiB buffer read again and again (bytes already in the CPU's cache, as a frame just read from a socket is); a copy into a reused buffer, and a new buffer per batch and per record | PA-1a, PA-11 |
| [upkeep/b2-decode.mjs](bench/upkeep/b2-decode.mjs) | 200,000 small rows in v4's codec (256 to a frame) and as snapshot chunks of 256 `[key, row]` pairs in JSON and in V8's own format (`v8.serialize`): the encode, then each depth of reading a v4 frame (checksum only, record edges, keys, full decode) with v4's checksum and a native one, and the full decode of the other two forms | PA-1b, PA-12, PA-14 |
| [core/api.ts](bench/core/api.ts) | v4's whole local path on a solo runtime with no I/O (as its baseline probe `api.write-5k`): `f.data.k = v` through the lens, `Bind.issue`, the kernel's stamp and commit, and `data`'s fold; and frames of 50 records from an admitted peer through `node.step(bytesIn)`. Values a number or a small row. With `PROF=<file>`, a CPU profile of the timed loops, summed by area by [core/profsum.mjs](bench/core/profsum.mjs) | PA-10, PA-13 |
| [core/alloc.ts](bench/core/alloc.ts) | the same four modes, bytes allocated per operation; a round counts only if no garbage collection started inside it | PA-13 |
| [core/sys.mjs](bench/core/sys.mjs) | per operation, CPU and time: a 128 B write and `fdatasync` in place (on a growing and a preallocated file), through libuv's pool (`writeSync` then `fs.fdatasync`), and v4's way (async `fs.write` then async `fs.fsync`); a small `writeSync` and `writevSync`; an event-loop turn; an idle process for 3 s with a 1 ms timer and with none | PA-2, PA-26 |
| [core/jthread.mjs](bench/core/jthread.mjs) | the same write and `fdatasync` on a journal thread of its own, woken through a `SharedArrayBuffer` | PA-2 |
| [core/hopcpu.mjs](bench/core/hopcpu.mjs) | the CPU of one main → worker → main round trip, one at a time | PA-3 |
| [core/link.mjs](bench/core/link.mjs) | one process holding both ends of a loopback link, plain TCP or TLS 1.3 (a self-signed P-256 certificate, the chain verified), sending 150 B messages: one `write` per message per turn, 64 corked into one `writev`, or 64 copied into one buffer; then connects per link, and an HMAC-SHA256, an Ed25519 check and an ES256 check of 150 B | PA-4, already-right items |
| [core/codecbytes.ts](bench/core/codecbytes.ts) | v4's bytes per record and per frame envelope, with a 36-character name as origin and issuer, against the same codec with a 1-byte length for strings of up to 42 UTF-16 units (patched at run time; every record decoded back and compared) | PA-22, PA-23 |
| [core/jsonval.mjs](bench/core/jsonval.mjs) | the same 256 small rows with a binary key and the value as JSON text, decoded per record or as one JSON array per frame, against v4's codec (every value decoded back and compared) | PA-1b |
| [upkeep/b3-kept.mjs](bench/upkeep/b3-kept.mjs) | added after the check (from the skeptic's big.mjs and small.mjs): one decode pass over N records with every decoded row kept, as a fold or a wake keeps it, or not kept; field records, small rows and E-34's 2 KB rows; v4's codec, a binary key with the value as JSON per record, one JSON array per frame, and V8's format per frame; the GC time inside. 2 KB rows also at 1,000,000 kept (about 2 GB of heap) | PA-1b, the 10 GB wake |
| [core/field.mjs](bench/core/field.mjs) | added after the check (the skeptic's field.mjs, with the encode and a self-check): a field record, v4's codec against a binary key and field with the value as JSON, frames of 256 | PA-1b for the commonest write |
| [core/escape.mjs](bench/core/escape.mjs) | added after the check: the price of PA-1b's tagged escape (NaN, ±Infinity, -0, `undefined`, big integers, bytes, a user key equal to the tag): a walk before `JSON.stringify` against a replacer on every record, a reviver against plain `JSON.parse`; a self-check round-trips every class | PA-1b |
| [core/sys2.mjs](bench/core/sys2.mjs) | added after the check (the skeptic's sys2.mjs): one 128 B write and flush, splitting v4's two pool hops from fsync against fdatasync | PA-2 |
| [core/raftport.mjs](bench/core/raftport.mjs) | added after the check: E-11's own TS host ([../E11-many-groups/ts/host.ts](../E11-many-groups/ts/host.ts), unchanged) running E-10's Raft port in three processes, 1 and 16 groups, at 10,000 and 50,000 writes a second; CPU of every process over a 6 s window | 2.9's busy budget (its Raft line) |

**Two passes.** The four walkers of PATHS.md first ran these benches in their own scratch folders. The machine was then restarted, and this folder's copies (made to run from here: imports by relative path or `$TREE`, temporary files, certificates and profiles in `$WORK` outside the repo) were run again for PATHS.md. The rerun's host behaves differently (Results, last section), so where a number moved, PATHS.md gives the range of both passes. The results files hold the rerun only. One case was added in the rerun: b1's checksum over cached bytes. **After the check.** A skeptic checked PATHS.md and this experiment and found, among other things, that PA-1's decode gain was measured on one row shape with the rows thrown away, that the busy budget's pipeline had no Raft in it, and that v4's flush cost had not been split. Five benches were added for it ([run.sh](run.sh) `check`), three of them moved here from the skeptic's own scratch benches (big.mjs and small.mjs became b3; field.mjs and sys2.mjs kept their names), and each ran three times under the timing lock, interleaved with the other agents' jobs: sections 12 to 16. **After a second check.** It reran b3, B8 to B11 and the 2 KB rows at 1,000,000 kept, one or two runs each under the same lock; its raw lines are in [results/recheck/](results/recheck) (summarize.py does not read them, so the tables hold the three runs only), and sections 12 to 16 quote them where they matter.

**Reproduce.** `./run.sh` (all parts, about 35 minutes of box time), or `./run.sh setup`, then `write`, `reads`, `upkeep`, `core`, `profile`, `check` (the benches added after the check, then `bigkept`), `tables`. Env: `SP` (the study's scratchpad; its `bin/timing` is the lock), `WORK` (default `$SP/e50`), `FERO`, `DATA` (see [bench/tree.sh](bench/tree.sh)), `RUNS`. Nothing was downloaded.

## Results

Medians of 3 runs, the lowest and highest run in brackets (this rerun; [results/tables.md](results/tables.md)). Where the first pass differs by more than about 10 %, its median is given after a slash or in the last section. Load average before each process: median 1.14, range 0.53-2.50 (129 processes); with the benches added after the check, median 1.20, range 0.25-4.45 (249 processes).

### 1. What does a checksum cost, per byte and per call? (write/crc, upkeep/b1)

One pass over one buffer, ns per pass:

| bytes | v4's crc32c (JavaScript) | crc32c, slice-by-8 (JavaScript) | `zlib.crc32` (native) |
|---|---|---|---|
| 128 | 284 (275-286) | 146 (144-156) | 135 (124-137) |
| 1 KiB | 2,516 (2,398-2,736) | 1,181 (1,170-1,236) | 357 (329-376) |
| 64 KiB | 158,752 (149,539-164,511) | 74,892 (71,377-75,136) | 12,956 (12,248-12,988) |
| 1 MiB | **2.61 ms** (402 MB/s) | 1.22 ms | **0.21 ms** (5.1 GB/s) |

Over 32 MB, ns per byte (and per 100 B record):

| case | ns per byte | ns per 100 B record | first pass, ns per byte |
|---|---|---|---|
| v4's crc32c, one call per record | 2.17 (2.03-2.30) | 217 | 2.46 |
| v4's crc32c, one call per 25.6 KB batch | 2.21 (2.16-2.23) | 221 | 2.51 |
| `zlib.crc32`, one call per record | 2.13 (2.07-2.21) | **213** | 2.31 |
| `zlib.crc32`, one call per batch, streamed from memory | 0.45 (0.45-0.46) | 45 | 0.27 |
| `zlib.crc32`, one call per MiB, streamed | 0.48 (0.47-0.49) | 48 | 0.23 |
| `zlib.crc32`, one call per batch, bytes in the CPU's cache | **0.20** (0.17-0.20) | **20** | (not run) |
| copy into a reused buffer, per batch | 0.05 (0.05-0.06) | 5.0 | 0.044 |
| a new buffer and a copy, per batch | 0.23 (0.18-0.27) | 23 | 0.22 |
| a new buffer and a copy, per record | 9.13 (9.08-9.21) | **913** | 6.98 |

- A native checksum is 11 times v4's over cached bytes and 5 times streamed, but only per batch: one C++ call costs about 200 ns, so per 100 B record it is no faster than JavaScript.
- A copy costs 40-55 times less than a JavaScript checksum per byte. A new buffer per record costs 0.7-0.9 µs: more than v4's whole scan of the record.
- **Settles:** PA-1a (native, per batch, on every row shape), PA-11 (never per record), PA-32 (a browser's JavaScript checksum: about 1.2 ms a MiB with slice-by-8).

### 2. What does v4's codec cost at each depth of reading? (write/codec, upkeep/b2)

v4's codec (`kernel/codec.ts`, unchanged), ns per record:

| frame | record | bytes per record | encode | of it crc | scan | key | full decode | `copyOf` at issue |
|---|---|---|---|---|---|---|---|---|
| 1 | row | 147 | 3,653 (3,626-3,828) | 326 | 925 | 1,045 | 3,059 (2,804-3,101) | 381 |
| 16 | row | 124 | 1,701 (1,607-1,711) | 297 | 608 | 755 | 2,540 (2,519-2,628) | 364 |
| 256 | row | 127 | **1,740** (1,703-1,777) | 308 | **632** | **720** | **2,712** (2,706-2,815) | **364** |
| 1 | field | 38 | 425 | 70 | 442 | 690 | 715 | 13 |
| 256 | field | 14.6 | 216 | 35 | 116 | 343 | 359 | 8 |

First pass at frames of 256, row: encode 1,956, crc 359, scan 669, key 841, full decode 3,213, `copyOf` 436.

One 1 MiB value, µs: as a string, encode 3,406, crc alone 2,581, full decode 3,167, one plain copy 107; as bytes, encode 2,979, crc 2,644, decode 2,772, `copyOf` 73.

200,000 small rows, µs per record (upkeep/b2):

| form | depth | wall | CPU | first pass, wall |
|---|---|---|---|---|
| v4 | encode | 2.36 (2.33-2.40) | 2.85 | 2.63 |
| v4 | checksum only, v4's JavaScript crc32c | 0.35 | 0.47 | 0.39 |
| v4 | checksum only, native | **0.07** (0.06-0.07) | 0.18 | 0.041 |
| v4 | checksum + record edges | 0.69 | 0.92 | 0.74 |
| v4 | checksum + edges + each key | 1.30 (1.25-1.35) | 1.60 | 1.58 |
| v4 | checksum + full decode | 3.47 (3.45-3.50) | 3.78 | 4.11 |
| v4 | full decode, no checksum | 2.49 (2.44-2.54) | 2.83 | 3.02 |
| JSON | encode | **0.41** (0.40-0.46) | 0.57 | 0.45 |
| V8 serialize | encode | 0.64 (0.63-0.67) | 0.86 | 0.71 |
| JSON | full decode | **0.96** (0.92-1.00) | 1.08 | 1.11 |
| V8 serialize | full decode | **0.84** (0.83-0.84) | 1.28 | 0.95 |

- Decoding a small row costs more than `data` folds it (0.22-1.90 µs in batches, [E-05]). For a 1 MiB record, the JavaScript checksum is 76-95 % of both the encode and the decode.
- Finding where records end costs as much as the checksum (0.3 µs a small row), because v4's records carry no length: a scan walks every value.
- A follower that only stores and acks needs the checksum alone: 0.04-0.07 µs a record natively, against 1.3-1.6 µs for keys and 2.5-4.1 µs for a full decode.
- **Settles:** PA-1b (the decode format, for small rows: section 12 adds field records and 2 KB rows, with the rows kept), PA-5 (an extra encode costs 1.7-2.0 µs a small row), PA-12 (decode only what a step reads; a length in each record), PA-14 (a snapshot encode: 2.4-2.6 µs a row in v4's codec, 0.41-0.71 in JSON or V8's format).

### 3. How fast can a record's value decode? (core/jsonval, write/strdec)

The same 256 small rows, ns per record (every value decoded back and compared: all equal):

| form | bytes per record | encode | decode |
|---|---|---|---|
| binary key, value as JSON text, parsed per record | 138 | 539 (484-548) | **885** (842-964) |
| binary keys, values as one JSON array per frame | 137 | 362 (347-366) | **621** (617-623) |
| v4's codec (its decode includes its JavaScript crc32c) | 139 | 1,632 (1,574-1,700) | 2,761 (2,727-2,763) |

First pass: 974, 597 and 2,697 ns to decode. The 13 strings of a row decode at 91 ns a string with v4's `TextDecoder` per subarray (first pass 127), 57 ns with a short-ASCII fast path (66), and 51 ns with a field-name cache (61).

- The value as JSON decodes 3.1 times faster per record and 4.4 times as one array per frame, at the same bytes. A fair compare takes v4's JavaScript checksum (about 0.35 µs) out of its figure: about 2.4 against 0.9 µs.
- **This holds for this shape, decoded and thrown away.** The rows here have 13 short strings each, and each decoded row dies at once in the young generation. With the rows kept, as a fold keeps them, and for other shapes, the gain is smaller (section 12); and this bench has no escape for the values JSON changes or drops (section 13).
- **Settles:** PA-1b for small rows (JSON for the value; V8's format for snapshots only, since browsers cannot read it); section 12 shows the gain shrinks on field records and 2 KB rows, and once rows are kept, PA-13 (the short-string path as the fallback).

### 4. How many bytes does a record carry? (core/codecbytes)

| format | record | bytes per record (frames of 256) | envelope of one frame | frame of one record | encode ns | decode ns |
|---|---|---|---|---|---|---|
| v4 | small row | 139 | 99.1 | 238 | 1,746 | 2,846 |
| v4 with 1-byte short-string lengths | small row | **111** | 95.1 | 206 | 1,566 | 2,450 |
| v4 | one-field number | 18.0 | 99.0 | 117 | 235 | 338 |
| v4 with 1-byte short-string lengths | one-field number | **14.0** | 95.0 | 109 | 216 | 347 |

Every record round-tripped exactly. The same row is 143 B as JSON and 135 B through `v8.serialize`; its field names are 30 B; a row record holds 14 strings. The envelope's two 36-character names are most of its 99 B.

- **Settles:** PA-22 (1-byte lengths: 20-22 % fewer bytes, decode 7-14 % faster, encode 10 %), PA-23 (small ids in the envelope).

### 5. What does one write, or one received record, cost through v4's API edge? (core/api, core/alloc)

| mode | ns per op | bytes allocated per op | first pass, ns |
|---|---|---|---|
| write, a number | 4,704 (4,677-4,830) | 4,804 | 4,757 |
| write, a small row | 7,714 (7,458-7,729) | 8,085 | 8,322 |
| received, a number | 2,491 (2,414-2,647) | 2,404 | 2,398 |
| received, a small row | 7,567 (7,563-7,964) | 7,050 | 7,571 |

Where the time goes (self time, % of the profile; [results/prof-*.json](results)):

| area | write, number | write, row | received, number | received, row |
|---|---|---|---|---|
| fero's Bind: issue, outcome rows, settle (`api/data.ts`) | 36.3 | 22.9 | 9.2 | 3.5 |
| fero's kernel: apply, `stable` + fnv state hash, commit (`kernel/node.ts`) | 14.9 | 30.1 (apply 13.3, `stable` 10.2) | 24.9 | 34.1 (apply 13.9, `stable` 11.7) |
| fero's codec (`kernel/codec.ts`) and Node's UTF-8 decode | 0.2 | 8.7 (`copy` at issue 6.6) | 15.1 | 38.0 |
| `data`'s fold | 15.3 | 12.1 | 33.7 | 12.1 |
| the collector | 23.2 | 19.5 | 16.4 | 12.2 |

- The kernel's own cell state and hash take 29-34 % of v4's CPU per small-row record (apply and `stable` alone 22-26 %): about 2 µs a record on every copy. Only the debugger and the simulator read the hash.
- v4 allocates about 50-60 times a record's bytes per record; the collector is 12-23 % of the CPU.
- **Settles:** PA-10 (do not port the kernel's cell state), PA-13 (garbage per record; the copy at issue).

### 6. What does a thread hop or a flush cost? (write/hop, core/hopcpu, core/sys, core/jthread)

Time of one hop when the box is idle, µs (20,000 round trips a run):

| hop | p50 | p99 | first pass p50 / p99 |
|---|---|---|---|
| one event-loop turn | 0.8 | 3.8 | 1.0 / 5.2 |
| main → worker → main | **37.7** (36.7-38.6) | **87.7** | 32.6 / 86.2 |
| async `fs.write` of 100 B (one pool hop) | 29.7 | 67.5 | 26.3 / 64.8 |
| the same write, synchronous | 0.5 | 1.0 | 0.6 / 1.4 |

CPU of the whole process per operation, µs:

| one operation | CPU | of it user / system | p50 / p99 time | first pass: CPU, p50 |
|---|---|---|---|---|
| 128 B write + `fdatasync`, in place, growing file | 43.5 | 7.5 / 34.9 | 141 / 486 | 43.6, 144 |
| 128 B write + `fdatasync`, **in place**, preallocated file | **32.7** (28.7-37.8) | 12.9 / 22.4 | **112** / 303 | 29.7, 113 |
| the same on **a journal thread of its own** | **71.9** (67.7-77.9) | 26.8 / 51.1 | **158** / 453 | 65.6, 142 |
| `writeSync` + `fs.fdatasync` (**one pool hop**) | **66.9** (66.9-87.9) | 25.3 / 45.8 | **167** / 574 | 82.6, 198 |
| async `fs.write` + async `fs.fsync` (**v4's two pool hops**) | **104** (100-121) | 22.2 / 78.2 | **194** / 731 | 108, 204 |
| `writeSync` of 128 B, no flush | 0.63 | | | 0.63 |
| `writevSync` of [16 B, 128 B] | 0.70 | | | 0.71 |
| one event-loop turn (`setImmediate`) | 0.91 | | | 0.91 |
| main → worker → main, 64 B transferred each way | **42.5** (40.8-42.8) | 21.5 / 21.1 | | 43.4 |
| an idle process for 3 s with a 1 ms timer | 5 % of a core (61 µs a tick, 886 ticks a second) | | | 6 %, 65 µs |
| an idle process with no timer | 0 | | | 0 |

- The flush's own work is about 30 µs of CPU, nearly all in the kernel. Each extra thread wake adds a context switch and about 15-25 µs of CPU on this quiet VM. v4's two pool hops are the dearest way on both hosts; in place is the cheapest on both. Between one pool hop and a journal thread of its own, the first host favoured the thread (66 against 83 µs of CPU, 142 against 198 µs at p50) and the rerun's host neither (72 against 67 µs; 158 against 167 µs).
- A crossing costs as much CPU as a flush when the box is quiet. Under load crossings batch and cost 27-155 ns a record ([E-07]).
- **Settles:** PA-2 (the flush: one hop at most, never v4's two; in place is the cheapest when idle, but only behind PATHS.md's guards; a journal thread is a choice to time on the target), PA-3 (each avoidable crossing is about 42 µs of CPU and 38 µs p50 quiet), PA-26 (an idle 1 ms timer costs 5-6 % of a core).

### 7. What does a link cost? (core/link)

Per 150 B message, sender and receiver in one process:

| mode | CPU µs | wall µs | reads per message | first pass CPU |
|---|---|---|---|---|
| TCP, one `write` per message | 6.20 (5.92-6.35) | 5.75 | 1.00 | 5.94 |
| TCP, 64 corked into one `writev` | 0.47 | 0.28 | 0.02 | 0.47 |
| TCP, 64 copied into one buffer | 0.36 | 0.22 | 0.02 | 0.41 |
| TLS 1.3, one `write` per message | **8.70** (8.65-8.86) | 8.19 | 1.00 | 9.60 |
| TLS 1.3, 64 corked | **0.58** (0.53-0.63) | 0.37 | 0.02 | 0.60 |
| TLS 1.3, 64 in one buffer | 0.43 | 0.27 | 0.02 | 0.46 |

Per link, both ends: a TCP connect 100 µs of CPU (89-104); with a TLS 1.3 handshake 2,008 µs (1,735-2,106). Per 150 B: HMAC-SHA256 2.5 µs, an Ed25519 check 104 µs, an ES256 check 77 µs.

- Most of a message's cost is per `write` call, not per byte: TLS makes each `write` its own record. v4's run batch (one `writev` per link per event-loop turn) is the right shape and must stay.
- A signature check per write (77-104 µs) would cost about one to three times a whole lean write at 50,000 writes a second (40-87 µs, PATHS.md 2.9): once per link is right.
- **Settles:** the already-right items of PATHS.md 6 (one write per link per turn; signatures once per link); the per-link price of PA-4's extra links.

### 8. What does a local read cost? (reads/local-read)

One read of a held row's field, ns per read (building the key string subtracted):

| rows | `f.snapshot.k` | building the snapshot alone | `f.data.k` (fero's lens) | `data`'s handle | a plain `Map` |
|---|---|---|---|---|---|
| 1,000 | **86,750** (86,517-103,385) | 81,978 | 594 | 180 | 42.6 |
| 100,000 | **32.5 ms** (31.9-38.9) | 31.9 ms | 3,147 | 2,084 | 576 |
| 1,000,000 | **532 ms** (532-551) | 540 ms | 5,228 | 3,883 | 1,209 |

First pass: `f.snapshot.k` 89 µs, 30.4 ms and 473 ms; the `Map` 51 ns, 453 ns and 928 ns.

- `f.snapshot.k` builds the whole picture on every read; indexing one row out of it adds almost nothing. At 1e6 rows one read costs half a second.
- The lens costs 1.3-3.3 times `data`'s handle, and the handle 3-4.5 times a `Map`: both allocate per path step.
- **Settles:** PA-8 (`f.snapshot` as a lookup view, or row reads through `f.data`), PA-31 (the lens).

### 9. Routing a committed record, and cutting a subscriber's frame (reads/route)

A serving copy routes each record of a 256-record frame (100,000 partitions over 4,096 slots), ns per record:

| record | followed partitions | records that hit | full decode first | key decode first | slot test first | the slot test alone |
|---|---|---|---|---|---|---|
| row | 0 | 0 % | 2,415 | 482 | 334 | 3.9 |
| row | 1,000 | 1.2 % | 2,456 | 502 | 396 | 1.5 |
| row | 100,000 | 100 % | 2,470 | 487 | 526 | 1.3 |
| field | 0 | 0 % | 411 | 343 | 118 | 1.2 |
| field | 100,000 | 100 % | 493 | 428 | 426 | 1.4 |

Every way also pays per frame the checksum (298 ns a row in JavaScript) and, in v4's format, the boundary scan (262 ns a row).

Cutting one subscriber's frame out of a committed batch, ns per chosen record (every cut frame decoded back to exactly the chosen records):

| record | chosen of 256 | re-encode from objects (v4) | copy bytes + v4's JavaScript crc | copy bytes + native crc |
|---|---|---|---|---|
| row | 1 | 3,019 | 1,144 | 789 |
| row | 16 | 2,053 | 381 | 145 |
| row | 256 | **2,112** | 398 | **109** |
| field | 256 | 230 | 102 | 58 |

- With no one following a slot, a slot test skips a record in 1-4 ns where v4 decodes 0.5 µs (key) or 2.4 µs (whole); the scan to find the record's end is then most of the cost, which a length in each record removes.
- Copying a subscriber's records is 14-19 times cheaper than re-encoding them with a native checksum, and 5 times with v4's JavaScript one, once a frame holds 16 or more.
- **Settles:** PA-5 (copy or share, never re-encode), PA-12 (the slot and a length in each record's header).

### 10. A live subscription's changes (reads/substream)

ns per change:

| record | step | v4: one control frame per change per subscriber | one frame per 256, encoded once |
|---|---|---|---|
| row | serve, 1 subscriber | 4,357 (4,153-4,452) | 2,037 (1,888-2,038) |
| row | serve, 100 subscribers, each | 4,357 | **20** |
| row | apply on the client | 4,380 (4,062-5,165) | 2,677 |
| row | wire bytes per change | 181 | 117 |
| field | serve, 1 subscriber | 1,956 | 227 |
| field | apply on the client | 1,894 | 527 |
| field | wire bytes per change | 80 | 15 |

First pass: a row 4,584 against 2,437 ns to serve and 5,520 against 3,129 ns to apply.

- One frame per change costs about twice one frame per batch for a small row and 4-9 times for a one-field change, on both ends, with 1.5-5 times the bytes.
- **Settles:** PA-5 and PA-11 (method streams ride the same batched flow as `follow`).

### 11. A room's first picture (reads/snapshot-serve)

One state-mode subscription to a 100-row room (a prefix partition), µs:

| rows | scan every row | an index partition → rows | of it, the encode | shared by 100 subscribers, each | shared by 1,000, each |
|---|---|---|---|---|---|
| 100,000 | 3,221 (2,670-3,309) | 474 | 212 | 4.7 | 0.47 |
| 1,000,000 | **28,304** (26,264-29,864) | **735** | 234 | **7.4** | 0.73 |

First pass: 2,836 and 25,843 µs by scan; 483 and 700 µs with an index.

- **Settles:** PA-17 (an index for prefix partitions, and a picture encoded once and shared).

### 12. A decode with the rows kept, per row shape (upkeep/b3, core/field; added after the check)

Sections 2 and 3 decode a frame and throw the rows away, so each row dies at once in V8's young generation. A fold keeps every row, and a wake keeps millions, so the collector must move them to its old generation and walk them. E-34's 10 GB load spent 35.6 s of its 51.8 s decode in GC. This section decodes each record once, as a wake or a fold does, with the rows kept or not, for three shapes: a field record (one number), E-05's small row (as E-34 makes it) and E-34's 2 KB row (the small row plus one 1,900-character string). Each line is one process; no checksum (section 1 prices it).

| shape | rows decoded | form | the rows | runs | bytes per row | µs per row, wall | µs per row, CPU | GC µs per row | heap after, MB |
|---|---|---|---|---|---|---|---|---|---|
| field | 1,000,000 | v4's codec | not kept | 3 | 24 | 0.43 (0.42-0.45) | 0.47 (0.46-0.51) | 0.01 (0.01-0.01) | 21.0 (20.0-21.0) |
| field | 1,000,000 | v4's codec | kept | 3 | 24 | 0.85 (0.74-0.89) | 1.36 (1.10-1.41) | 0.31 (0.27-0.38) | 202 (198-203) |
| field | 1,000,000 | binary key, value as JSON, per record | not kept | 3 | 19.7 | 0.41 (0.36-0.46) | 0.42 (0.37-0.47) | 0.01 (0.01-0.01) | 9.00 (8.00-9.00) |
| field | 1,000,000 | binary key, value as JSON, per record | kept | 3 | 19.7 | 0.64 (0.63-0.81) | 0.88 (0.84-1.09) | 0.14 (0.13-0.17) | 116 (114-116) |
| field | 1,000,000 | one JSON array per frame | not kept | 3 | 25.7 | 0.42 (0.40-0.45) | 0.43 (0.42-0.47) | 0.01 (0.01-0.01) | 42.0 (33.0-44.0) |
| field | 1,000,000 | one JSON array per frame | kept | 3 | 25.7 | 0.70 (0.70-0.73) | 1.10 (1.10-1.16) | 0.23 (0.22-0.24) | 130 (129-131) |
| field | 1,000,000 | V8's format per frame | not kept | 3 | 25.9 | 0.17 (0.16-0.19) | 0.26 (0.26-0.30) | 0.05 (0.05-0.06) | 16.0 (15.0-16.0) |
| field | 1,000,000 | V8's format per frame | kept | 3 | 25.9 | 0.27 (0.26-0.34) | 0.64 (0.64-0.67) | 0.15 (0.14-0.19) | 131 (131-133) |
| small | 1,000,000 | v4's codec | not kept | 3 | 127.5 | 2.33 (2.20-2.34) | 2.38 (2.24-2.40) | 0.04 (0.04-0.04) | 10.0 (6.0-16.0) |
| small | 1,000,000 | v4's codec | kept | 3 | 127.5 | 2.92 (2.78-3.11) | 4.01 (3.83-4.54) | 0.59 (0.55-0.77) | 410 (409-412) |
| small | 1,000,000 | binary key, value as JSON, per record | not kept | 3 | 127.3 | 0.95 (0.85-1.12) | 0.96 (0.86-1.13) | 0.02 (0.01-0.02) | 16.0 (9.0-17.0) |
| small | 1,000,000 | binary key, value as JSON, per record | kept | 3 | 127.3 | 1.30 (1.29-1.38) | 2.00 (1.81-2.00) | 0.35 (0.32-0.41) | 295 (294-297) |
| small | 1,000,000 | one JSON array per frame | not kept | 3 | 131.3 | 0.91 (0.85-0.96) | 0.90 (0.87-0.96) | 0.02 (0.02-0.02) | 30.0 (25.0-35.0) |
| small | 1,000,000 | one JSON array per frame | kept | 3 | 131.3 | 1.38 (1.17-1.50) | 2.12 (1.73-2.45) | 0.40 (0.32-0.48) | 317 (317-318) |
| small | 1,000,000 | V8's format per frame | not kept | 3 | 117.4 | 0.85 (0.85-1.02) | 1.17 (1.13-1.30) | 0.17 (0.17-0.20) | 20.0 (19.0-21.0) |
| small | 1,000,000 | V8's format per frame | kept | 3 | 117.4 | 1.15 (1.11-1.36) | 2.23 (2.17-2.53) | 0.43 (0.42-0.64) | 358 (358-360) |
| big | 250,000 | v4's codec | not kept | 3 | 2037.5 | 3.80 (3.53-3.86) | 4.00 (3.73-4.07) | 0.12 (0.10-0.12) | 5.00 (5.00-16.00) |
| big | 250,000 | v4's codec | kept | 3 | 2037.5 | 5.41 (5.01-5.73) | 8.46 (8.00-9.29) | 1.55 (1.51-1.94) | 594 (591-594) |
| big | 250,000 | binary key, value as JSON, per record | not kept | 3 | 2037 | 2.61 (2.46-2.99) | 2.63 (2.49-3.04) | 0.07 (0.06-0.08) | 6.00 (6.00-9.00) |
| big | 250,000 | binary key, value as JSON, per record | kept | 3 | 2037 | 3.93 (3.90-4.78) | 6.17 (6.12-7.67) | 1.44 (1.36-1.75) | 560 (560-561) |
| big | 250,000 | one JSON array per frame | not kept | 3 | 2040 | 3.49 (3.14-3.67) | 3.54 (3.18-3.70) | 0.19 (0.19-0.21) | 5.00 (5.00-39.00) |
| big | 250,000 | one JSON array per frame | kept | 3 | 2040 | 4.95 (4.79-5.30) | 7.09 (6.94-7.93) | 1.43 (1.39-1.66) | 576 (575-581) |
| big | 250,000 | V8's format per frame | not kept | 3 | 2025.4 | 1.69 (1.53-1.70) | 2.45 (2.24-2.51) | 0.48 (0.44-0.50) | 19.0 (13.0-41.0) |
| big | 250,000 | V8's format per frame | kept | 3 | 2025.4 | 2.57 (2.40-2.95) | 4.96 (4.32-5.67) | 1.38 (1.21-1.53) | 579 (10-579) |
| big | 1,000,000 | v4's codec | kept | 3 | 2038.5 | 6.08 (5.80-6.24) | 8.95 (8.65-9.09) | 2.45 (2.35-2.45) | 2,352 (2,351-2,355) |
| big | 1,000,000 | binary key, value as JSON, per record | kept | 3 | 2038.3 | 5.06 (4.36-5.47) | 7.72 (6.67-7.97) | 2.15 (2.07-2.42) | 2,225 (2,223-2,225) |
| big | 1,000,000 | one JSON array per frame | kept | 3 | 2041.3 | 6.52 (5.48-6.60) | 9.49 (7.78-9.71) | 2.22 (1.86-2.31) | 2,266 (2,263-2,304) |
| big | 1,000,000 | V8's format per frame | kept | 3 | 2026.4 | 3.49 (3.48-3.56) | 5.98 (5.84-6.08) | 1.88 (1.87-1.94) | 2,305 (2,303-2,305) |

A field record in a hot loop, decoded and thrown away (core/field, B8):

| form | runs | round trip | bytes per record | encode ns per record | decode ns per record |
|---|---|---|---|---|---|
| v4's codec | 3 | True | 24.1 | 333 (330-340) | 406 (392-409) |
| binary key and field, value as JSON | 3 | True | 16.4 | 312 (272-314) | 377 (365-384) |

- **Small rows (E-05's shape, 13 short strings):** kept, the value as JSON decodes in 1.30 µs against v4's 2.92 (0.45 of v4's time); thrown away, 0.95 against 2.33. Keeping the rows costs JSON 0.35 µs a row and v4 0.59 µs: the collector moves each kept row once. One JSON array per frame is no faster than JSON per record once rows are kept.
- **Field records:** thrown away (a fold keeps only the value), JSON 0.41 µs against v4's 0.43; in B8's hot loop 377 against 406 ns, and the encode 312 against 333 ns. `JSON.parse` has a fixed cost per call (a `TextDecoder` call and the parser's start), which is most of a field record's decode, so the value's form saves about 6-7 %. The bytes do fall: 16.4 against 24.1 B a record in frames of 256.
- **2 KB rows:** kept, 250,000 rows, JSON per record 3.93 µs against v4's 5.41 (0.73), V8's format 2.57 (0.47), one JSON array per frame 4.95 (0.92). Both forms pay the long string per byte, so the gain is smaller than on small rows, and it shrinks as the heap grows (section 16).
- **The skeptic's own runs** (its big.mjs, one JSON array per frame, 250,000 kept) gave v4 5.05-5.64 µs, JSON 4.76-4.97 and V8's format 2.39-2.74: the same picture for the frame form. The second check's rerun of every case (two runs each, [results/recheck/b3.jsonl](results/recheck/b3.jsonl)) gave the same order: kept small rows, JSON 0.39-0.44 of v4's time; field records not kept, JSON 7-13 % less; 2 KB rows at 250,000 kept, JSON 0.65-0.70 and V8's format 0.43-0.44. The record format PA-1b proposes is JSON per record, which does better on 2 KB rows than one array per frame, but not by enough to change the conclusion.
- **Settles:** PA-1b is shape-dependent. PA-1a (the checksum) is not: it is the robust part of PA-1. The 10 GB wake in PATHS.md 5.3 is rebuilt from these ratios.

### 13. What does PA-1b's escape cost? (core/escape; added after the check)

`JSON.stringify` changes or drops some values without a sound: NaN and ±Infinity become `null`, -0 becomes 0, `undefined` drops out of an object, a BigInt throws and a `Uint8Array` becomes an object of numbered keys. So PA-1b needs an escape. Two ways, per record (median of 7 rounds a run):

Self-check (every escaped class round-trips; plain values get no flag): True

| shape | runs | JSON bytes | JSON.stringify | the walk alone | walk + stringify | stringify with a replacer | JSON.parse | JSON.parse with a reviver |
|---|---|---|---|---|---|---|---|---|
| field | 3 | 5.4 | 98.0 (88.3-98.2) | 6.50 (6.40-6.60) | 94.9 (92.8-96.5) | 230 (229-234) | 69.0 (65.8-69.6) | 346 (328-366) |
| small | 3 | 108.5 | 301 (297-318) | 58.9 (58.1-64.8) | 415 (384-420) | 884 (833-887) | 582 (577-582) | 4,602 (4,157-4,811) |
| big | 3 | 2018.5 | 5,296 (5,270-5,323) | 74.4 (70.2-77.5) | 5,438 (5,255-5,480) | 5,928 (5,723-6,070) | 1,270 (1,248-1,365) | 5,497 (5,032-5,604) |

- **The walk is cheap:** 6 ns for a number, 59 ns for a small row and 74 ns for a 2 KB row (its length matters little: one long string is one test). The second check's two runs gave 6, 50-62 and 68-73 ns. With the walk, the encode of a small row takes 415 ns against 301 ns for a bare `JSON.stringify`.
- **A replacer on every record costs 2.9 times the bare encode** of a small row, and **a reviver on every record 8 times the bare decode** (4.6 µs against 582 ns): the reviver is called for every key and value. So the decoder must not run one unless the record's flag says so.
- A 2 KB row's `JSON.stringify` costs 5.3 µs, about four times its `JSON.parse` (1.3 µs): a cost for snapshot cuts and encodes of big rows, not for wakes.
- **Settles:** PA-1b's escape as a walk at encode plus a per-record flag, never a replacer or reviver on every record.

### 14. What makes v4's flush dear? (core/sys2; added after the check)

One 128 B write and one flush on a preallocated file, one at a time (CPU of the whole process, every thread):

| mode | runs | CPU µs per op | p50 µs | p99 µs |
|---|---|---|---|---|
| writeSync + fdatasyncSync (in place) | 3 | 29.7 (25.4-31.4) | 118 (89-118) | 245 (137-361) |
| writeSync + fsyncSync (in place) | 3 | 32.5 (30.8-32.7) | 117 (115-124) | 335 (255-344) |
| writeSync + async fdatasync (one pool hop) | 3 | 80.4 (74.4-86.8) | 191 (148-200) | 522 (490-646) |
| writeSync + async fsync (one pool hop) | 3 | 76.1 (71.5-96.6) | 158 (149-244) | 598 (438-780) |
| async write + async fdatasync (two pool hops) | 3 | 106 (106-115) | 185 (175-234) | 575 (541-610) |
| async write + async fsync (two pool hops: v4's way) | 3 | 94.8 (86.7-111.3) | 173 (161-204) | 465 (412-541) |

- **The second pool hop is what makes v4's flush dear**, not fsync against fdatasync: two hops cost 95-106 µs of CPU, one hop 80 µs, in place 30 µs (with fdatasync). Swapping fdatasync for fsync made no clear difference on this file (-11 to +3 µs), so the second hop, about 19-26 µs, is the cost.
- In place is cheapest, but it blocks the calling thread for the whole flush: a frame corked earlier in the same run leaves only after it (PATHS.md 2.4), a batch that arrives meanwhile reaches the OS only after it (which the `replicated` answer stage cannot take: MEMORY 9.4), and a slow flush cannot be cut short once it has started. Its guards are in PATHS.md PA-2; one hop is the default.
- The skeptic's own runs gave two hops 98-117 µs, one hop 77-98 and in place 31-42 µs of CPU: the same order. So did the second check's two runs, noisier: two hops 102-150, one hop 80-111, in place 30-38 µs.
- **Settles:** PA-2's CPU claim (one hop, never two), with in place behind its guards.

### 15. What does a real Raft port cost at 50,000 writes a second? (core/raftport; added after the check)

PATHS.md's busy budget first took its biggest line, the replication pipeline, from E-02, whose pipeline runs no Raft. E-11 ran E-10's real port up to 10,000 writes a second. This runs E-11's own host, unchanged, at 10,000 and 50,000 (three processes on loopback, one replica of each group in each, one Raft entry per 100 B write, one journal write and fdatasync per loop round before the messages go out, quiet groups):

| groups | offered writes/s | runs | committed/s | cluster cores | CPU µs per write (cluster) | busiest process, cores | fsyncs/s per process | commit p50 ms | commit p99 ms |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 10,000 | 3 | 9,992 (9,991-9,995) | 1.87 (1.87-1.87) | 187 (187-187) | 0.71 (0.70-0.71) | 1,096 (926-1,114) | 3.43 (3.42-3.94) | 14.9 (11.7-25.8) |
| 1 | 50,000 | 3 | 49,906 (49,880-49,916) | 2.35 (2.32-2.36) | 47.2 (46.4-47.3) | 0.92 (0.92-0.95) | 229 (229-233) | 14.3 (14.1-14.5) | 83.7 (81.2-92.4) |
| 16 | 10,000 | 3 | 9,996 (9,996-9,997) | 1.43 (1.41-1.49) | 143 (141-149) | 0.48 (0.47-0.51) | 2,701 (2,334-2,746) | 1.81 (1.77-2.03) | 10.6 (7.4-33.9) |
| 16 | 50,000 | 3 | 49,851 (49,807-49,854) | 2.72 (2.66-2.77) | 54.6 (53.4-55.6) | 0.92 (0.90-0.94) | 285 (185-288) | 18.1 (16.7-24.3) | 127 (119-191) |

- **At 50,000 writes a second the port costs 47 µs a write with one group and 55 with 16**, across three processes: about three times E-02's pipeline at the same rate (13.2 µs on one thread, 17.0 with a kernel worker). At 10,000 a second it cost 187 and 143 µs, as E-11 found (183 and 148).
- **It is near the edge of this box at 50,000 a second:** the busiest process used 0.92 of a core, the commit's p50 was 14-18 ms (E-02's floor pipeline: 0.9 ms), so its loop had fallen behind, and every process ran only a few hundred loop rounds a second, so each round carried hundreds of entries. A port at its limit batches more, which makes its CPU per write lower than it would be with headroom. So 47-55 µs is a point at a commit latency (p50 14-18 ms, p99 84-127 ms, against PATHS.md's 5.73 ms bar) that no v5 server may run at, not a ceiling for a busy budget. The second check's rerun (one run each, [results/recheck/raftport.jsonl](results/recheck/raftport.jsonl)) gave 47.1 and 55.5 µs a write at 50,000 a second (commit p50 16.7-19.5 ms, p99 63-142 ms) and 154-194 µs at 10,000.
- **The host is simpler than a v5 server, both ways:** one Raft entry per write (v5 would put one batch in an entry, PA-11), its own small message codec, persist then send (v5 sends first), one thread (no worker crossings), no TLS, no client, no judging and no fold. So this is not a v5 server's cost; it shows that the Raft line of a busy budget is not E-02's floor.
- **Settles:** PATHS.md 2.9's pipeline line is a range, from E-02's floor (no Raft) to this, whose top is not an upper bound.

### 16. Do the 2 KB ratios hold as the heap grows? (upkeep/b3 at 1,000,000 kept; added after the check)

The same 2 KB rows at 1,000,000 kept (about 2.3 GB of heap), three runs; the rows are in section 12's table.

- **The gain shrinks as the heap grows.** JSON per record took 0.73 of v4's time at 250,000 rows and 0.83 at 1,000,000; one JSON array per frame 0.92 and 1.07; V8's format 0.47 and 0.57. The collector's share grows with the heap and does not shrink with the format (GC 1.55 → 2.45 µs a row for v4, 1.44 → 2.15 for JSON).
- **A second check's rerun** at 1,000,000 kept (three runs of v4's codec and of JSON per record, one of V8's format; [results/recheck/bigkept.jsonl](results/recheck/bigkept.jsonl)) gained less: v4 6.32 µs a row (6.29-6.72), JSON 5.50 (5.35-6.04), V8's format 4.33. That is JSON 0.87 of v4's time (0.80-0.96 run against run) and V8's format 0.68. Pooled with section 12's runs and the second check's two runs at 250,000 rows ([results/recheck/b3.jsonl](results/recheck/b3.jsonl)), the medians give JSON about 27 % less than v4 at 250,000 rows and about 14 % less at 1,000,000, with a spread of several points either way: about 10-27 % in round figures, less as the heap grows.
- E-34's wake held 11 GB, about five times this heap, and spent 35.6 s of its 51.8 s decode in GC; its own v4 decode rose from 7.0 µs a row at 2.5e6 rows to 10.4 µs at 5e6 ([E-34]'s phase table). So the ratios at 11 GB are likely closer to 1 still. PATHS.md 5.3 rebuilds the wake both ways (the 1,000,000-row ratio, and only the decode's own work cut, with all the GC kept): about 51-64 s with snapshots in V8's format and about 64-75 s with JSON values (73-75 s if JSON gains nothing at 11 GB), against 94 s, not the 30-36 s first written.
- **Settles:** the 10 GB wake's estimate; V8's format, not JSON, is the lever for snapshots of big rows.

### 17. What moved between the two passes

The walkers' first pass and this rerun ran the same benches on the same VM type, before and after a machine restart (both report an Intel Xeon at 2.10 GHz; the rerun's `results/versions.txt` records it).

| measure | first pass | rerun | rerun ÷ first |
|---|---|---|---|
| v4's full decode, small row, frames of 256 | 3,213 ns | 2,712 ns | 0.84 |
| v4's encode, the same | 1,956 ns | 1,740 ns | 0.89 |
| `TextDecoder` per string | 127 ns | 91 ns | 0.72 |
| v4's JavaScript crc32c, per byte (b1) | 2.46 ns | 2.17 ns | 0.88 |
| native crc per batch, streamed over 32 MB | 0.27 ns | 0.45 ns | 1.67 |
| a `Map` read at 1e6 rows | 928 ns | 1,209 ns | 1.30 |
| `f.snapshot.k` at 1e6 rows | 473 ms | 532 ms | 1.12 |
| a flush through one pool hop, CPU | 82.6 µs | 66.9 µs | 0.81 |
| a flush on a journal thread, CPU | 65.6 µs | 71.9 µs | 1.10 |
| a TLS message alone, CPU | 9.60 µs | 8.70 µs | 0.91 |

Work done in JavaScript on data in the CPU's cache ran 10-28 % faster; work that streams memory ran 12-67 % slower. Every ratio that decides one of PATHS.md's findings held in both passes, except the journal thread against one pool hop (section 6). The first pass's raw lines are in [results/first-pass/](results/first-pass), with their tables ([results/first-pass/tables.md](results/first-pass/tables.md), printed by `python3 bench/summarize.py results/first-pass`).

## What this box cannot show

- **Whole paths.** These are the parts. Every total in PATHS.md is a sum of them; nothing here ran a write, a catch-up or a wake end to end through a v5 server.
- **A network.** Links are loopback on one VM. A real 1-10 Gb/s link adds its round trips and its transfer time (head of line is computed from link speed in PATHS.md, not measured).
- **Quiet against busy.** The quiet costs (a crossing, a flush, a lone message) include this VM's slow vCPU wake-up (about 25 µs, [E-01]); on a busy server each costs less. The per-record costs in batches do not depend on it.
- **Wide rows.** Sections 1-11 use E-05's small row; b3 adds field records and E-34's 2 KB rows. Deep values and other shapes were not measured; the decode's gain depends on the shape (section 12).
- **An 11 GB heap.** b3 keeps at most 1,000,000 rows of 2 KB (about 2 GB of heap). E-34's wake held 11 GB; how the collector's work grows from 2 to 11 GB in each form is reasoned, not measured.
- **The Raft port in a v5 server.** B11 runs E-10's port only in E-11's simple host: one Raft entry per write, its own message codec, one thread, persist then send, a blocking fsync per loop round, no TLS, and at 50,000 writes a second only at its limit. A v5 server would batch entries, send before its fsync and keep the kernel on a worker, with headroom.
- **Other runtimes.** Node 22 only. Browsers have no native CRC (the JavaScript slice-by-8 is what they would run); the native step's costs are [E-03]'s.

## Verdict

Q-50: on this box, per small row, v4's codec decodes in 2.7-3.2 µs, encodes in 1.7-2.0 µs and checks its JavaScript crc32c at 2.2-2.9 ns a byte, while a value as JSON decodes in 0.89-0.97 µs (0.60-0.62 µs as one array per frame); but with the rows kept, as a fold keeps them, JSON saves about 55 % of v4's decode on a small row, about 6-7 % on a field record (which a fold does not keep) and about 10-27 % on a 2 KB row (V8's format about 43-53 %), the 2 KB gain shrinking as the heap grows, and the escape JSON needs costs a walk at encode (6 ns for a number, 59 ns for a small row and 74 ns for a 2 KB row) where a reviver on every record would cost 4.6 µs a small row; a native `zlib.crc32` runs at 0.19-0.48 ns a byte when called once per batch but 213-231 ns per call per record; a copy costs 0.05 ns a byte and a new buffer per record 0.7-0.9 µs; a quiet thread crossing costs 42-43 µs of CPU per round trip; a flush costs 30-33 µs of CPU in place, 66-83 µs with one hop off the kernel thread and 104-108 µs as v4 does it, the second pool hop making the difference; E-10's Raft port, in E-11's host, costs 47-55 µs a write across three processes at 50,000 writes a second, about three times E-02's pipeline, measured with the host at its limit (commit p50 14-18 ms), so a point and not a ceiling; a TLS message 8.7-9.6 µs alone and 0.58-0.60 µs in a batch of 64; `f.snapshot.k` 87-89 µs, 30-33 ms and 0.47-0.53 s at 1e3, 1e5 and 1e6 rows against 43 ns-1.2 µs for a `Map`; per subscriber a re-encode costs 2.1-2.4 µs against 0.11 µs to copy the record's bytes and 1-4 ns to route it by slot; a 100-row room's first picture 26-28 ms by scan at 1e6 rows against 0.70-0.74 ms by index. Moves (PATHS.md): PA-1a (a native checksum per batch) is settled as the robust per-record gain, on every row shape; PA-1b (the value as JSON) depends on the shape: about half the decode on rows of many short strings, little on field records, and on 2 KB rows about 10-27 %, less as the heap grows, where V8's format is the lever for snapshots; the 10 GB wake rebuilds to about 51-64 s with snapshots in V8's format (64-75 s with JSON values), not 30-36 s; the busy budget's pipeline line becomes a range, from E-02's floor to E-10's port, whose top is not an upper bound; PA-2 rests on one hop at most (the second pool hop is the cost), with in place only behind guards; PA-3, PA-5, PA-8, PA-10, PA-12, PA-13, PA-17, PA-22, PA-23, PA-26 and PA-31 are sized by these numbers; one TLS write per link per turn and signatures once per link are confirmed as right.

[E-01]: ../E01-floors/README.md
[E-02]: ../E02-pipeline/README.md
[E-03]: ../E03-napi-cost/README.md
[E-05]: ../E05-fold-cost/README.md
[E-07]: ../E07-gc-worker/README.md
[E-08]: ../E08-relay-fanout/README.md
[E-11]: ../E11-many-groups/README.md
[E-34]: ../E34-wake-10gb/README.md
