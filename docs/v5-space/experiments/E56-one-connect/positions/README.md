# E-56, positions: what commit ids, hash chains and Merkle trees would cost

**Question.** The owner asked (2026-11-19) whether a `from` option could start a stream at a commit id, what a commit id looks like, whether `from: -5` could replay the last five commits, and whether Merkle trees help with anything. This part of E-56 prices the hashing, the trees and the resumes those questions lead to. The answers, with their sources, are written up for the owner separately; this README lists the measurements.

**Words.** A **record** is one change to one row. A **batch** is the records one leader appends together (one Raft entry). A **version** is a row's place in its partition's log: its slot's (epoch, sequence) at the row's last write. A **Merkle tree** is a tree of hashes: each leaf hashes some rows, each inner node hashes its children, so two sides can find where they differ by comparing hashes top down. A **tombstone** is a kept note that a row was removed. **Compaction** drops log that a snapshot covers.

**Bars.** E-54's bar for anything kept per write on the live path (API.md 3.12, "What would change this"): **under about 0.2 µs a write and 20 B, with the collector under 1 %**. The same bar is used here for a hash chain and for a kept tree. For the resume, a decision bar set before the runs: **a Merkle walk earns its rules only if it beats "rows newer than mine, plus the deletes" on bytes or on round trips in some case.** For the text forms: **0 order errors**.

## Measurements

| # | File | What it measures | Bar | Result (median, with the range over 3 runs) |
|---|---|---|---|---|
| 1 | hash.mjs | SHA-256 (node:crypto) of one commit's records: what a content-addressed commit id or a hash chain (each commit hashes the one before, as git does) would cost the leader per batch | 0.2 µs a write | one record: 1.24-1.35 µs at 100 B, 1.67-1.85 µs at 1 KB. In a batch of 256 records: 67-69 ns a 100 B record, 604-656 ns a 1 KB record. **The chain** (the previous 32 B hashed in): 1.53-1.69 µs and 1.90-2.44 µs for one record; 67-71 ns and 647-662 ns a record in a batch. **Passes only for full batches of small records** |
| 2 | hash.mjs | xxHash32 (E-05's, plain JS) of the same bytes, one seed and two; CRC-32 (native), which every batch already pays (LAYERS.md 1.2) | none: references | xxHash32, one record: 62-65 ns at 100 B, 427-523 ns at 1 KB; 49-51 ns and 495-499 ns a record in a batch. Two seeds: about twice. CRC-32: 173-175 ns and 280-308 ns one record; 17.8-19.9 ns and 234-266 ns a record in a batch |
| 3 | tree.mjs | a 16-ary Merkle tree over each row's (key, version), kept per write: the whole path rehashed (`mkver`), the path once per 256 writes (`mkverb`), or only the leaf sums kept and the inner nodes built when asked (`mkleaf`) | 0.2 µs and 20 B | extra a write at 1,000 / 100,000 / 1,000,000 rows: `mkver` +486-512 / +924-1,207 / +1,405-1,716 ns; `mkverb` +243-279 / +686-774 / +1,013-1,687 ns; `mkleaf` +190-245 / +333-454 / +773-1,001 ns. **Fails at every size.** Memory: the tree's arrays 2.2 / 5.6 / 0.6 B a row (exact), on top of a per-row version (row 6). Building every inner node on demand: 3 µs / 0.58-1.07 ms / 0.89-1.09 ms |
| 4 | tree.mjs | the same tree over each row's content hash (`mkrow`), and a SHA-256 tree (`mksha`: a kept SHA-256 per row, leaves and inner nodes SHA-256) | 0.2 µs and 20 B | `mkrow` +1.55-1.81 / +2.76-2.98 / +3.19-3.64 µs. `mksha` +7.6-8.3 / +17.2-17.7 / +19.4-20.7 µs, 34-54 B a row of arrays; inner nodes on demand 22-37 µs / 5.4-6.1 ms / 4.1-4.9 ms. **Fails** |
| 5 | tree.mjs | E-05's order-free sum of row hashes kept per write: the old row's hash recomputed from `prev` (`sum`), or each row's hash kept (`sumkept`); one row hash alone (`rowhash`: `JSON.stringify`, then xxHash32 under two seeds) | 0.2 µs and 20 B | `sum` +1.25-1.35 / +2.16-2.53 / +2.89-3.09 µs; `sumkept` +0.67-0.75 / +0.96-1.19 / +1.66-1.76 µs and 50-61 B a row; `rowhash` +0.58-0.75 / +0.76-1.37 / +1.07-1.36 µs. **Fails**: the encode of the row is most of it |
| 6 | tree.mjs | a per-row version kept beside the rows in a `Map` (`ver`): what "rows newer than mine" needs, and what `if: { version }` already implies | 0.2 µs and 20 B | +1.0-14 / +33-169 / +188-334 ns; 29-37 B a row (heap). Passes on time at 1,000 rows only; never on bytes, as a separate `Map` |
| 7 | resume.mjs | a resume after compaction, 100 B rows, n = 1,000, 100,000, 1,000,000 and k = 1, 100, n / 10 changed rows: (a) the full picture; (b) a Merkle walk over (key, version); (c) the rows newer than the client's version plus the removes kept as tombstones; (d) the client lists every key and version | the walk must beat (c) on bytes or trips in some case | **(c) is smallest in every case, in 1 trip**: k = 1: 164-173 B; k = 100: 11.3-12.1 KB; k = n / 10: 1.20 MB at 100,000 rows, 12.3 MB at 1,000,000. (b): 1.68 to 5.28 times (c)'s bytes (510 B to 25.9 MB), 3 to 5 trips; with 32 B hashes 1.3 KB to 27.6 MB. (a): 0.12 to 131 MB. (d): 13 KB to 28.2 MB, mostly the keys sent up. **The walk fails the bar** |
| 8 | resume.mjs | the same with 1 KB rows (bytes and trips only, under the heavy lock) | as row 7 | (c) still smallest: 1.07 KB to 94.2 MB; (b) is 1.08 to 1.68 times (c); (a) 1.0 MB to 1.04 GB |
| 9 | resume.mjs | CPU for one resume, both sides in one process, trees built beforehand and not timed | none | (c) scans every row on the server: 0.17-0.26 ms / 2.1-5.1 ms / 22.6-43.0 ms. (a) 0.21-0.24 / 7.5-10.1 / 74-117 ms. (b) 14-40 µs for one change, up to 1.08-1.23 s at a tenth changed. (d) 0.38-0.53 / 18.7-23.7 / 282-360 ms |
| 10 | textform.mjs | two text forms of a version's number (`toNumber`), checked against the number's order; a one-partition cursor as base64url | 0 errors | 0 wrong of 1,000,000 pairs, both forms; 0 round-trip errors. A version is 13 characters (fixed) or 2-10 (prefixed) in the examples; a one-partition cursor 21-26 B, 28-35 characters |

## How to run

```sh
SP=/path/to/scratch ./run.sh            # clean, then timing (3 runs), heavy, summary
SP=/path/to/scratch ./run.sh timing     # only the timed parts; they append to results/
SP=/path/to/scratch ./run.sh summary    # print results/tables.md from results/*.jsonl
```

`SP` is a scratch folder that holds `bin/timing` (runs one command alone on the box) and `bin/heavy` (shares the box, waits for timing runs), as for E-55. `NODE` defaults to `node` on PATH (Node 22.22.0); `RUNS` to `1 2 3`. Nothing is downloaded. The benches import E-05's xxHash32 (`../../E05-fold-cost/bench/xxh.mjs`), which checks itself against xxHash's reference vectors at import; `bench/common.mjs` keeps a copy that returns a signed 32-bit value (so V8 does not box it on the heap) and checks it equals E-05's on 2,000 random inputs. Every timed process ran under the timing lock, three times, with the load average written before it. Raw lines are in `results/*.jsonl`; `results/tables.md` holds the tables; `results/versions.txt` the Node version, kernel, CPUs and memory.

## Method, in short

- **hash.mjs.** A commit is its records' bytes as the log holds them: 1 or 256 records, each JSON text of exactly 100 B or 1,000 B. Each way runs 7 rounds of about 0.2 s in one process; the median, low and high. SHA-256 is checked against its known value for "abc"; CRC-32 against its check value.
- **tree.mjs.** One partition of n rows (E-05's small row, about 100 B as JSON) in a `Map`. 300,000 writes replace random rows (seeded); 30,000 warm up, then three rounds of 90,000 are timed. Each way adds its own work per write; "extra" is the way minus `base` in the same run. The 16-ary tree has depth 2 at 1,000 rows (256 leaves) and 4 at 100,000 and 1,000,000 (65,536 leaves); a leaf is a bucket by the key's hash and holds the order-free sum (E-05's form) of its rows' hashes. After the writes every structure is rebuilt from scratch and compared (`check`).
- **resume.mjs.** A client holds a partition at a version v0; the server then took k changes (a tenth of them removes), and the log since v0 is gone. Four ways bring the client up to date, each checked against the server's rows. Bytes are counted exactly under one stated encoding (8 B a message header, a key as 1 B of length plus its bytes, a version 8 B, a row as 2 B of length plus key, version and JSON, a node hash 8 B or 32 B, a cursor 25 B from E-19).
- **textform.mjs.** Two order-keeping text forms of a version's number, checked on 1,000,000 seeded pairs, and a one-partition cursor in E-19's layout as base64url.

## Results

Every table, with each run's median and the range over runs, is in [results/tables.md](results/tables.md), printed by `summarize.mjs` from `results/*.jsonl`. Every kept structure matched one rebuilt from scratch after its writes (`check: ok` in all 90 timed tree processes), every resume left the client equal to the server (`ok` in all 32 cases of each row size), and the resume bytes are the same in every run. The load average at the start of each timed process: median 2.2-2.4, range 0.3-3.3; it counts this study's own previous process too.

**In one line.** No hash structure kept per write meets E-54's bar of 0.2 µs: the cheapest Merkle form (leaf sums only) costs 0.19 to 1.0 µs a write and the content-hash forms 0.6 to 20.7 µs; a SHA-256 chain per commit passes only in full batches of small records; and for a resume after compaction, "rows newer than mine, plus the removes kept as tombstones" is smaller than a Merkle walk in every case measured (by 1.08 to 5.28 times) and takes one round trip instead of three to five.

A note on the runs: run.sh first ran k = n / 10 at 1,000 rows as well as k = 100, which is the same case; `summarize.mjs` keeps one line per run and case, and run.sh now runs each case once.

## What this cannot show

- These are stand-ins: a `Map` for data's rows, plain JSON for fero's records. A row hash here pays `JSON.stringify`; a design that hashed a whole-row write's record bytes would pay only the hash (hash.mjs's 100 B row). A field write would still need the row encoded again.
- The resume counts bytes and round trips; it does not time a network. A round trip on one box is about 40 µs (E-01); across regions it is tens of ms, which is where the walk's extra trips hurt most.
- The CPU columns of the resume are one process doing both sides' work, with the trees built beforehand and not timed. "Rows newer than mine" scans every row of the partition on the server; an index kept in version order would make it O(changes), at a cost per write that was not measured.
- One machine: 4 CPUs, Node 22.22.0, Linux 6.18. Another study shared the box; every timed process held the timing lock, which runs it alone.
