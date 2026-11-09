# E-19: what slot-shaped positions cost

## The question

Q-19 ([QUESTIONS.md](../../QUESTIONS.md) §4): what do slot-shaped positions cost, in bytes per record and in cursor size over a whole resource?

A **position** says where a reader is in a log. In the MIN family (O `slot`, SPACE §2) a record is found by its **slot** (one of 1,024 hash buckets of a resource) and its **sequence** within that slot, so a position survives a slot moving to another group. The other option is one **offset** per group (O `off`: CELL, LANE; `off+lin`: SPLIT), which is smaller but changes meaning when data moves. A **cursor** is the set of positions a reader hands back when it reconnects: for a whole-resource reader that is one (epoch, sequence) per slot, 1,024 of them.

**Threshold** (QUESTIONS.md): at most 4 extra bytes and at most 50 ns per record, a typical cursor of at most 256 B and a worst one of at most 8 KB → O `slot` stands. A reconnect storm of 10,000 clients over 100 MB → a server-side cursor token, priced as one more mechanism.

## Method

**Record header** ([node/header.mjs](node/header.mjs), [rs/src/main.rs](rs/src/main.rs), the same code in Node 22.22.0 and Rust 1.97.0, no dependencies). Batches of 256 records with 100 B payloads, uniform slots. Every form has the same batch header (term, base offset, writer time, count) and the same per-record fields (issuer, call id, payload length). The forms add, per record:

| form | per record | who uses it |
|---|---|---|
| `off` | nothing (offset = base + index) | CELL, LANE, SPLIT |
| `slot` | slot varint + slot sequence varint | MIN family, as DESIGN-V5 §4.3 writes it |
| `slotfix` | slot u16 + sequence u32, fixed width | a variant |
| `slotimp` | slot varint only; the sequence is implicit: the reader keeps one counter per slot, and each journal segment starts with a checkpoint of the 1,024 counters | a cheaper variant, priced here |

Bytes per record are exact. Encode and header-only decode (walk every header, skip payloads) are timed for 2 s each, at three per-slot sequence sizes: about 1e3 (a resource with about 1e6 writes), 1e6 (about 1e9 writes) and 1e9.

**Cursors** ([node/cursor.mjs](node/cursor.mjs)). The per-slot sequences are the expected writes per slot for 1e3, 1e6 and 1e9 writes over 100,000 partitions, uniform and Zipf 0.99 and 1.2, hashed to slots with E-18's 64-bit mix. Then 0, 10 or 100 slot moves (a move carries the slot's epoch and sequence, DESIGN-V5 §4.2, so it does not change the cursor) and 0, 1 or 3 unclean recoveries of one of 16 groups (each bumps the epochs of the slots that group holds). Six encodings: raw (fixed width), varint, dense (no slot ids), delta (epochs as runs, sequences zigzag-delta from the previous slot), rle (delta plus runs of equal deltas), deflate. Also filtered cursors (a client that follows k partitions), the offset forms, and the bytes a reconnect storm of 10,000 clients sends. One light timing: encode and decode one whole-resource cursor.

**Timing rules.** Built under `$SP/bin/heavy`; all timed parts ran under `$SP/bin/timing`, 3 runs (Node, Rust and the cursor program in turn), load average recorded in every JSON line (1.0 to 2.1; the machine was otherwise quiet). Tables show the median and the range.

**Files.** [run.sh](run.sh), [summarize.py](summarize.py). Raw: [results/header.jsonl](results/header.jsonl), [results/cursor.jsonl](results/cursor.jsonl). Tables: [results/tables.md](results/tables.md). Nothing was downloaded, so there is no fetch.sh.

## Results

All measured here ([results/tables.md](results/tables.md)).

### Per record

| per-slot sequence (resource writes) | form | extra bytes vs `off` | extra ns, Node: encode / decode | extra ns, Rust: encode / decode |
|---|---|---|---|---|
| 1e3 (about 1e6) | `slot` | **+3.87** | +9.7 / +8.3 | +2.9 / +2.8 |
| 1e6 (about 1e9) | `slot` | **+4.87** | +8.0 / +16.6 | +2.9 / +3.7 |
| 1e9 (about 1e12) | `slot` | +6.87 | +14.5 / +22.3 | +4.8 / +4.9 |
| any | `slotfix` | +6.00 | +9.4 to +11.7 / +1.4 to +4.9 | +1.6 to +2.4 / +0.2 to +0.5 |
| any | `slotimp` | **+1.87** | +7.0 to +9.6 / +5.9 to +11.1 | +0.8 to +1.0 / +1.6 to +1.8 |

- The `off` header is 5.44 B per record in all cases (issuer, call id and length varints, plus the batch header shared by 256).
- A slot varint costs 1.87 B on average (slots 128 to 1,023 take 2 bytes). The sequence varint takes 2 B below 16,384 writes per slot (a resource below about 16.7 million writes), 3 B below about 2 million per slot (a resource below about 2 billion writes).
- **Time is far under the bar**: at most 22 ns extra per record in Node, 5 ns in Rust, against 50 ns.

### Cursors

| cursor | bytes |
|---|---|
| a client following 1 partition (varint) | 22-25 |
| 10 partitions | 57-79 |
| 64 partitions | 260-388 |
| whole resource, raw | 14,355 |
| whole resource, varint | 3,987-6,092 |
| **whole resource, delta-coded** | **1,045 (young) to 3,229 (1e9 writes, Zipf 0.99); +49 B per unclean recovery; moves add 0** |
| whole resource, rle | 26 (young) to 3,229 |
| whole resource, deflate | 23 to 3,462 (no better than delta once slots have data) |
| CELL (16 cells) / LANE (64 lanes) | 66-82 / 146-274 |
| SPLIT, after 0 / 10 / 100 splits | 23-25 / 73-84 / 422-624 |

- **Moves are free in the cursor**: 0, 10 and 100 moves give the same bytes, because a move carries the slot's epoch and sequence. Only an unclean recovery adds bytes (a new epoch run).
- **Reconnect storm**: 10,000 clients that each send a whole-resource cursor send 32-33 MB delta-coded (144 MB raw, 61 MB varint). A realistic mix (9,936 clients with 10 rooms each plus 64 relays with whole-resource cursors) sends 1.0 MB.
- Encoding one whole-resource cursor (delta form, 3,229 B) takes 36 µs (34-39) and decoding 13 µs (13-14) in Node; a storm of 10,000 costs about 0.13 s of decode CPU.

## Against the threshold

| bar | result | holds? |
|---|---|---|
| ≤ 4 extra bytes per record | +3.87 B up to about 16.7M writes per resource, **+4.87 B up to about 2 billion**, +1.87 B with implicit sequences | **just, and not above 16.7M writes**, unless the sequence is implicit |
| ≤ 50 ns per record | ≤ 22 ns (Node), ≤ 5 ns (Rust) | yes |
| typical cursor ≤ 256 B | 22-79 B for a client of 1-10 partitions; 260-388 B at 64 | yes for clients; a whole-resource reader is 1-3.3 KB |
| worst cursor ≤ 8 KB | 3.3 KB delta-coded; 14.4 KB raw | **only if delta-coded** |
| storm ≤ 100 MB | 32-33 MB delta-coded; 144 MB raw | **only if delta-coded**; no server-side token needed |

So O `slot` stands, if two format details are fixed in phase 1 (DEV-09): cursors are delta-coded (the raw form fails two bars), and the sequence is either implicit per slot (+1.87 B, one checkpoint of 1,024 counters per journal segment, which the segment index of S `jrnl` already has a place for) or the 4 B bar is restated to 5 B for resources past 16.7M writes. Neither is a new mechanism; both are record-format choices.

Offsets are smaller (CELL 66-82 B, LANE 146-274 B per whole-resource cursor; 4-5 B less per record), but they are not free either: CELL's and LANE's re-key, and SPLIT's splits, change what an offset means, which `slot` avoids (P-07: a position never changes meaning across moves). The size gap does not decide between them.

## What this box cannot show

- The ns columns are CPU time on this VM's cores; another CPU shifts them, but the gap to the 50 ns bar is 2 to 10 times.
- The cursor sizes come from expected per-slot sequences (a model of the load), not a real run. Exact bytes would differ by a few per cent; the gap to the bars would not.
- The storm counts bytes only. E-39 measured a real resubscription storm on E-27's server.

## Verdict

Q-19: slot-shaped positions cost +3.9 B per record (+4.9 B past about 16.7M writes per resource; +1.9 B with an implicit per-slot sequence) and at most 22 ns (Node) or 5 ns (Rust), and a whole-resource cursor is 1.0-3.3 KB delta-coded (14 KB raw), with moves adding nothing; a client cursor of 1-10 partitions is 22-79 B, and a 10,000-client storm is 32 MB, so no server-side cursor token is needed. Moves: O `slot` (MIN, MIN-P, MIN-TS, RUST, SRV, LEAN, DRAFT, RLOG, SLOG, OBJ, EMB-V8, SIDE) holds on P-03, P-05, P-07 and SC-10's cursor ceiling, provided DEV-09 fixes delta-coded cursors and the per-record sequence form (implicit, or restate the 4 B bar to 5 B) in phase 1; `off` rows (CELL, LANE, SPLIT) gain nothing that decides: 4-5 B per record and 10-40× smaller whole-resource cursors, but positions that a re-key or split changes.
