# E-43: do two `data` versions, and two Node versions, fold the same records to the same rows?

**Question (Q-43, [QUESTIONS.md](../../QUESTIONS.md) §8).** The fold is the step that turns committed change records into rows. `data` does it. Every replica, client and replay must get the same rows from the same records, or replicas drift apart in silence. Do two `data` versions do so? Do Node 22 and Node 26?

It decides OPS-12 (the fold's version is an entry in the log), F-21 (the hourly divergence check), DATA-04 (the SCHEDULE contract and its version number) and DEP-10 (a roll is refused when two copies would fold differently): **what the fold-version entry must pin** before phase 1 fixes the record header.

**Threshold.** None picks a row. Any difference names a clause or a Node behaviour that the fold version must pin.

## The short answer

- **Node 22 and Node 26 fold the same.** 32 folds of 1,000,000 records on each: the same rows at 20 checkpoints and at the end, and for the 18 folds that were checked record by record, the same row and the same answer after every one of the 1,000,000 records. 0 differences.
- **Two `data` commits one `SCHEDULE_VERSION` bump apart fold the same** for the bumps 2 → 3 and 3 → 4: 0 differences in 1,000,000 records. The bump 1 → 2 changed the fold, as it said it would.
- **Two `data` commits with the same `SCHEDULE_VERSION` fold differently.** Both say version 4. After 47,994 of the 1,000,000 records their rows differ, and 578 rows are still different at the end. One commit between them changed what a deep write under a text value does, and did not raise the number.
- So **`SCHEDULE_VERSION` does not name the fold.** The fold-version entry must pin `data`'s exact build, the way in (three ways in give two different sets of rows), and, for any function of the user's that runs in the fold, the Node version too: 8 of 61 JavaScript behaviours probed differ between Node 22 and 26, among them the result of `**`.

## What could not be run

fero v4 says it needs `data` at `SCHEDULE_VERSION` 5 (STATUS.md: "npm's data 4.0.0 is SCHEDULE_VERSION 4; fero needs 5"). The copy of `data` on this box, and GitHub's `main` and `v4` branches, are at 63fea66, which is version 4. Version 5 is not published. So the bump 4 → 5 was not tested. The bumps 1 → 2, 2 → 3 and 3 → 4 were.

## Method

Everything is in this folder; `./fetch.sh`, then `./run.sh` (about 25 minutes, through the heavy lock; not a timing run). Tables: [results/summary.md](results/summary.md), printed by [summarize.py](summarize.py) from the raw files in [results/](results).

**The `data` commits** ([results/commits.txt](results/commits.txt)). `fetch.sh` clones `data`'s history from GitHub (the box holds one commit) and exports eight commits:

| commit | SCHEDULE_VERSION | what it is |
|---|---|---|
| 4479a92 | 1 | the contract first becomes a test suite |
| 6b615e2 | 2 | the bump to 2: the deep-path law (clause 10) |
| b831319 | 2 | the last commit at 2 (the hot lane exists from here) |
| 46df5f9 | 3 | the bump to 3: the value table (clause 11) |
| ff85e6c | 3 | the last commit at 3 |
| dc65b8f | 4 | the bump to 4: a mid-batch attach sees the batch end (clause 7) |
| 2b8b780 | 4 | two commits later, the same day; 515c0cf is one of them |
| 63fea66 | 4 | HEAD |

**The stream** ([gen.mjs](gen.mjs)). One seeded stream of 1,000,000 change records in fero's own record shape and codec (3,907 frames, 36 MB, SHA-256 `8be4d289…`). The generator uses whole-number arithmetic only, and its bytes are identical on Node 22 and Node 26. It writes 20,017 row keys (20,000 plain ones and 17 odd ones: digits, unicode, a NUL, names like `constructor`). Values stay inside the codec's domain: null, undefined, booleans, numbers (with -0, NaN, the infinities and the largest and smallest doubles), text, bytes, arrays, objects up to three deep. Each record is made as one of 32 kinds ([results/stream.json](results/stream.json) has the counts): whole-row writes and removes (36 %), field writes (22 %), deep writes that meet an object, nothing, null, a number, text or an array on the way (21 %), removes of fields, deep fields and array slots (13 %), deep writes to rows that are not there, the same record twice, `undefined` over nothing, and five malformed shapes (1 %). So about two thirds are what a careful app writes and a third are edges.

**Five ways in** ([fold.mjs](fold.mjs)):

- `lane-rec`: `data`'s hot lane, one record a call. This is what fero v4's `applyRec` does, without its two repairs.
- `lane-b256`: the lane, 256 records a call (one `data` commit per frame: what a v5 kernel handing over a batch would do).
- `seam`: fero v4's own `substrate.applyRec`: the lane plus fero's repairs (a deep write to a missing row makes the row; a malformed record is reshaped).
- `ingest-rec`, `ingest-b256`: the handle's `ingest()` with the older record profile, which is how a client mirror folds. It exists at every version, the lane only from b831319. The malformed lane shapes mean other things in this profile (an update with no key replaces the whole source), so these two leave them out, by shape.

**What is compared.** At 20 checkpoints and at the end: SHA-256 of the rows in the engine's own order, of the public snapshot, and of the rows with keys sorted. In the per-record ways in, also after every record: a digest of the touched row, and whether the record was taken or refused. Values are written by [canon.mjs](canon.mjs) so that every double, -0, NaN, a hole and key order all show.

**Finding where two folds part** ([diff.mjs](diff.mjs), [classify.mjs](classify.mjs)). A *root* is a record after which the two rows differ although they agreed after the record before it on that row. So the folds parted at that record; it is not an old difference carried along. Each root is then folded again on both sides with the row before, the record, and the row after written out, and counted by what the record met in the row.

**64 folds**: 8 commits × the ways in each supports × Node 22.22.0 and Node 26.13.0.

**Six side probes**: [nodeprobe.mjs](nodeprobe.mjs) (67 JavaScript behaviours, on both Node versions), [views.mjs](views.mjs) (11 views over the fold), [history.mjs](history.mjs) (is a view's value a function of the rows?), [bigarray.mjs](bigarray.mjs) and [hostile.mjs](hostile.mjs) (two things a single record can do), and a grep of `data`'s source ([results/data-grep.txt](results/data-grep.txt)).

## Results

### 1. Node 22 against Node 26: the same, everywhere

| What | Compared | Differ |
|---|---|---|
| 32 folds of 1,000,000 records on each Node | rows at 20 checkpoints and at the end (three digests) | 0 |
| 18 of them record by record | the touched row and the answer after each record: 18,000,000 comparisons | 0 |
| 11 views over the first 200,000 records, at 3 commits | each view's value, live and rebuilt | 0 |
| the history probe | 4 cases | 0 |

The reason is in `data`'s source (grep, [results/data-grep.txt](results/data-grep.txt)): its fold and operators call no locale function, no `Math` library function, no date function. Every sort has its own comparator. The only clock read is a stats timer. Nothing in it can follow the engine.

### 2. `data` version against `data` version (Node 22)

Records after which the touched row differs, of 1,000,000:

| From → to | Way in | Rows differ after | Roots | Rows still apart at the end | Same row, but one side refused the record |
|---|---|---|---|---|---|
| version 1 → 2 (4479a92 → 6b615e2) | ingest | 174,154 | 54,875 | 1,937 | 41,489 |
| version 2 → 2 (6b615e2 → b831319) | ingest | 0 | 0 | 0 | 0 |
| version 2 → 3 (b831319 → 46df5f9) | lane, ingest | 0 | 0 | 0 | 0 |
| version 3 → 3 (46df5f9 → ff85e6c) | lane | 0 | 0 | 0 | 0 |
| **version 3 → 4** (ff85e6c → dc65b8f) | lane, ingest, seam | **0** | 0 | 0 | 0 |
| **version 4 → 4** (dc65b8f → 2b8b780) | lane | **47,994** | 15,815 | 578 | 2,090 |
| | ingest | 47,784 | 15,812 | 578 | 2,090 |
| | seam | 47,966 | 15,818 | 580 | 0 |
| version 4 → 4 (2b8b780 → 63fea66) | lane, ingest, seam | 0 | 0 | 0 | 0 |

**Version 1 → 2** is the deep-path law, and the bump announced it. In the first 3,000 roots every one is a remove of a field or a deep field: version 1 throws "nested-field removal is not supported", version 2 removes it.

**Inside version 4** is the surprise. Every root was explained ([results/roots-lane-v4-v4later-all.txt](results/roots-lane-v4-v4later-all.txt)): 15,812 of 15,815 are **a deep write whose path passes through a text value** (the other 3 are differences carried from before). Example, record 26:

- the row before: `{ n: 375, s: "null", tags: [], a: null, 10: 221.875 }`
- the record: update `[k9417, s, 10] = 486`
- dc65b8f: `s` becomes `{ 0: "n", 1: "u", 2: "l", 3: "l", 10: 486 }` (the text's letters leak in as fields)
- 2b8b780: `s` becomes `{ 10: 486 }`

The 2,090 "same row, one side refused" are the second change: removing an array slot that holds `undefined` was a silent no-op and is now refused. The row is the same; the answer to the writer is not.

Both changes come from one commit, 515c0cf, "clause-10 edge pins", made the same day as the bump to 4. It changed 20 lines of `kernel/node.ts` and the text of clause 10, which now says "pinned at SCHEDULE_VERSION 4". It did not touch the number: the commit before it had already raised it. So two builds that both report 4 fold one record in 21 of this stream to a different row.

### 3. Three ways in, one commit (HEAD)

| Pair | Rows differ after | Roots | Rows apart at the end | Same row, one side refused |
|---|---|---|---|---|
| the lane against fero's seam | 22,569 | 15,348 | 1,512 | 19,052 |
| the lane against ingest (the malformed shapes left out) | 0 | 0 | 0 | 0 |

The lane and fero v4's seam end with different rows (10,628 against 12,067). In the first 3,000 roots: 2,646 are a deep write to a row that is not there (the lane refuses it; the seam makes the row, as v4's replication needs), and 354 are an insert with a two-part key (the lane refuses; the seam folds it as a field write). These are fero's repairs, on purpose. They are part of the fold.

### 4. One record a call against 256 a call

The same rows at every checkpoint, on the lane at all six commits and on ingest from version 2 on. At version 1, ingest in batches ends with 1,835 rows against 10,628: one bad record threw and the rest of its batch was lost (the failure clause 10d outlawed). So from version 2, where a batch ends does not change the rows.

### 5. JavaScript behaviours a user's function could lean on

[nodeprobe.mjs](nodeprobe.mjs) prints 67 lines: 6 are version strings, 61 are behaviours. **8 of the 61 differ** between Node 22.22.0 (V8 12.4, ICU 77.1, Unicode 16, tz 2025b) and Node 26.13.0 (V8 14.6, ICU 78.3, Unicode 17, tz 2026e):

| Behaviour | Node 22 | Node 26 |
|---|---|---|
| `10 ** -5` (the bits of the double) | `3ee4f8b588e368f0` | `3ee4f8b588e368f1` |
| `1.1 ** 100` | `40caea4e6126bb96` | `40caea4e6126bb95` |
| `/\p{L}/u` and `/\p{Emoji}/u` on two code points that Unicode 17 added | not a letter, not an emoji, not assigned | known |
| the offset of `Africa/Casablanca` for four dates in 2027 | +01:00 | +00:00 |
| the message of one caught error (an invalid locale tag), of 14 tried | "Incorrect locale information provided" | "Invalid language tag: …" |
| built-ins that exist: 12 of 26 tried (`Temporal`, `Math.sumPrecise`, `RegExp.escape`, `Float16Array`, `Promise.try`, `Uint8Array.fromBase64`, `Iterator.concat`, `Map.prototype.getOrInsert`, …) | missing | present |

The same on both: number to text and back, `toFixed`, JSON, 20 `Math` functions at 13 points each, key order, sort (stable; even with a comparator that returns a boolean), case mapping, normalisation, `localeCompare` and `Intl.Collator` on the strings tried, grapheme and word breaks, date parsing, number and date formatting in 6 locales, `structuredClone`, text encoding, float sums.

So `data`'s own fold does not see the Node version, but a rule, a method, an upcaster or a view function of the user's can. A price computed with `**`, a text check with `\p{…}`, a date in a zone whose rule changed, a caught error's text stored in a row: each folds differently on two copies during a roll across Node versions.

### 6. A view's value is not a function of the rows

[history.mjs](history.mjs), at HEAD, the same on both Node versions ([results/history.jsonl](results/history.jsonl)). Each history ends in the same rows as the short one; "rebuilt" is the same view over a new source made from those rows.

| History | Rows at the end | `sum('n')`, live | rebuilt |
|---|---|---|---|
| only row a | `{ a: { n: 0.1 } }` | 0.1 | 0.1 |
| a, then b with n = 1e21, then b removed | the same | **0** | 0.1 |
| a, then c with n = NaN, then c removed | the same | **NaN** | 0.1 |
| ten rows of 0.1 added, nine removed | one row of 0.1 | **0.10000000000000003** | 0.1 |

`sum` and `avg` keep a running total (`data`'s source says so: "NaN poisons and removal cannot un-poison"). So a replica that folded every record and a replica that loaded a snapshot and folded the rest can show different sums over the same rows.

Over the 1,000,000-record stream ([views.mjs](views.mjs), first 200,000 records, 11 views, 3 commits): `filter` and `group` hold the same rows live and rebuilt, in a different key order; `az` (sort) and the top 10 hold their rows in the same order of the sort field, and differ only in the order of rows that compare equal. The scalar views agreed on this stream.

### 7. Two things one record can do

**Set an array's length** ([bigarray.mjs](bigarray.mjs)). `update [row, tags, length] = n` is folded as a plain property write, so the array becomes n long.

| Length set by one record of 41 bytes | One later write under that array | The row encoded for the wire |
|---|---|---|
| 100,000 | 0.5 ms | 100 KB |
| 10,000,000 | 74 ms (Node 22), 69 ms (Node 26) | 10 MB, 0.3 s |
| 100,000,000 | **4.1 s (Node 22), 4.3 s (Node 26)** | not tried |

The first version of this run's stream held a few such records with 2³¹; every fold of it took 130 to 400 s where it now takes 10 to 25 s. They are probed apart, and the stream keeps array lengths under 64.

**Use a name that is also on `Object.prototype`** ([hostile.mjs](hostile.mjs)), the same at every commit and on both Node versions:

- A row keyed `__proto__` is in the engine and **missing from the public snapshot** (2 rows in the engine, 1 shown).
- A write to `[a, __proto__, polluted]` is taken. `Object.prototype` is not changed. But row a is no longer a plain object: reading `a.polluted` gives the value, and its own keys do not show it.

## What the fold version must pin

For OPS-12's log entry, DEP-10's check before a roll, and F-21's hash:

1. **`data`'s exact build, not `SCHEDULE_VERSION`.** A content hash of `data`'s fold code, or the commit, or a number that a test forces to rise: for example a small file of test records with the digest of the rows they fold to, kept in `data`; the fold version is that digest, and DATA-04's suite fails when it changes without the file changing. Evidence: result 2.
2. **The way in.** The lane, fero's seam with its repairs, and a batch size (for version 1). fero's L2 library version, which OPS-12 already names, must cover the repairs. Evidence: result 3.
3. **The JavaScript engine, for the user's functions only.** Either a roll across Node versions restarts every copy together (J already says so for a Node major), or what a rule may call is fenced (no `**` on non-integers, no `Intl`, no `\p{…}`, no zone rules, no error text), or rules run only at the writer and their *results* are what the log carries. The third is what a single writer per partition already gives, if followers and clients fold records and never re-run rules. Evidence: result 5.
4. **Rows only, in F-21's hash; and a rule for views.** Hash the rows with keys in a fixed order. Do not hash views. And P-12 and P-16 need one of: aggregates rebuilt at a snapshot on every replica at the same log position, or sums that do not drift (exact sums for whole numbers, a compensated sum, or a recount on a timer), or the promise restated. Evidence: result 6.
5. **Bounds on what one record may do,** judged at the writer before it commits: no write to an array's `length`, a cap on a row's encoded size (SC-15 has one), and `__proto__` refused as a row key and as a path part. Evidence: result 7.

## What this leaves out

- **The bump 4 → 5,** not published (above).
- **Views across `data` versions.** Views were compared across Node versions and live against rebuilt, at three commits, not version against version.
- **Other engines.** Bun, Deno and browsers run other JavaScript engines or other V8 builds. P-19 puts the fold in browsers. Only Node 22 and 26 on x86-64 Linux were run.
- **A native fold.** DATA-09's differential test (a Rust fold against `data`) would use this same stream and tooling; it was not run here.
- **Records a careful single writer would never commit.** A third of the stream is edges. In v5 the writer judges first, so many of them would be refused before they reach a log. But the writer's judgement runs on `data` too, so two writers on two builds admit different records: the roots above are exactly those.
- **32-bit digests per record.** The per-record digest is 32 bits, so a rare collision can hide a difference for one record and move a root (3 of 15,815 roots here were differences carried from an earlier record). The checkpoint and final digests are SHA-256.
- **One seed.** One stream of 1,000,000 records. A second seed would change counts, not kinds.

## Verdict

- **Node 22 and Node 26: no difference in `data`'s fold.** No pin is needed for `data` itself. A pin or a fence is needed for the user's functions, where 8 of 61 behaviours differ.
- **`data` versions: `SCHEDULE_VERSION` is not enough.** It did not move when the fold changed (inside 4), and it moved twice when the fold did not (2 → 3, 3 → 4). The fold-version entry must name the build.
- Three more pins follow from what the run met on the way: the way in, views, and bounds on a record.

Q-43: Node 22 and Node 26 fold 1,000,000 records to the same rows in all 32 folds (18,000,000 per-record comparisons, 0 differ), and so do `data` commits one SCHEDULE_VERSION bump apart for 2 → 3 and 3 → 4 (0 differ); but two commits that both say SCHEDULE_VERSION 4 differ after 47,994 records and in 578 final rows (commit 515c0cf changed a deep write under a text value and did not raise the number), fero's seam and `data`'s lane end 1,512 rows apart on purpose, 8 of 61 JavaScript behaviours differ between the two Node versions (`**` in its last bit, Unicode 17, a zone rule, an error text, 12 built-ins), a `sum` view depends on the records and not the rows (0, NaN or 0.10000000000000003 where a rebuild gives 0.1), and one 41-byte record can make a 10 MB row or a 4 s write; the bump 4 → 5 that fero v4 needs is not published, so it was not run. Moves: no candidate up or down by itself; every row gains five pins for OPS-12, DEP-10 and F-21 before phase 1 fixes the record header (the fold version names `data`'s build and fero's way in, not SCHEDULE_VERSION; user functions run at the writer only, or are fenced, or a Node change restarts all copies; F-21 hashes rows, never views; P-12 and P-16 need rebuilt or drift-free aggregates at snapshots; the writer bounds what one record may do); every row with F `all` and W `any` (replicas and clients that fold and serve reads: MIN and its family, DRAFT, CELL, LANE, SPLIT, SLOG, RLOG, ISR, PD, EMB-V8) down a little on P-12 and P-16 until the view rule is chosen, where LEAN, SIDE and OBJ (one folding replica at a time) are exposed only at failover; RUST, SRV and EMB-V8 gain a ready input for DATA-09 (this stream and its per-record digests); DATA-04 needs a data-side change (a number or digest that a test forces to move with the fold).
