# E-56: one `connect`, commit ids and Merkle trees

**Question.** On 2026-11-20 the owner asked for one verb, `connect`, with overloaded options: it streams, each call gets the state and the diff of a commit, `disconnect()` ends it, a lifetime option may end it too, `from` starts at a commit id or `-5` commits back, a read once is awaited, the same handle is an async iterable. The owner also asked what a commit id looks like and whether Merkle trees help with anything. E-56 asks two things. **How would a single `connect` work**, built small on E-55's prototype: what goes right and what goes wrong at run time and in the types? **What do commit ids, hash chains and Merkle trees cost** fero v5? The design answer, built on these results, is [CONNECT.md](../../CONNECT.md).

**Short answer.** One `connect` for **live state** works: a callback, a handle and a `for await` loop on one verb, with `disconnect()` and a lifetime option (`signal`, `until`) beside it, passed every lifetime check E-55 has, given three rules. Two of the owner's ideas went wrong when built as asked: a **thenable handle** lost every link that passed through code that resolves values (1,000 of 1,000), and **`get()` built as `connect({ once })`** moved the whole partition (65,671 B) to read one number (1 B by a GET). **`from` on `connect`** switched the same slow loop from 1-50 waiting rows to a queue of about 45,600 commits. That measures how far one word moves a loop between evidence 5's two rules (live state and the log), and CONNECT.md keeps both rules; it does not measure an option against a verb, and 7,777 such loops ran with 0 wrong. Whether that rule belongs behind an option is a judgement (CONNECT.md 2.4). One more thing went wrong in the first build: **a partition's state read after its link ended** gave a different answer on a client, with a linger, on a server and with another link on the same rows; a guard per link made every such read throw `ended`. A **commit id** inside one partition is the version of its last record there, short text such as `38S9` that keeps log order under plain `<`; a whole resource has none, only a cursor. **Merkle trees** do not pay: every partition has one leader and one order, so a position already says what is missing; no Merkle way kept per write came in under 0.2 µs in any run (E-54's yardstick for a version kept per write); and a resume by "rows newer than mine plus tombstones" beat a Merkle walk in all 8 cases.

**Words.** A *lens* is an address, such as `shop.data.widgets.stock`. A *link* is one live connection from a lens into this process; its *picture* is the rows so far, which it gets first. A *partition* is the rows one leader keeps in one order; the *linger* is the short wait before a client drops rows no link holds. A *selection* is what one subscription brings in; equal lenses share one. A *SUB* is the subscribe message, a *GET* a one-off read. A *commit* is one leader's batch of writes, cut down to the rows a link reads. A *record* is one change to one row. A *version* is a row's place in its partition's log: its slot's (epoch, sequence) at its last write. A *cursor* is a reader's place: one (epoch, sequence) per slot it reads. A *Merkle tree* is a tree of hashes: each leaf hashes some rows, each inner node hashes its children, so two sides find where they differ by comparing hashes from the top down. A *tombstone* is a kept note that a row was removed. *Compaction* drops log that a snapshot covers. A *thenable* is an object with a `then` method, which `await` treats as a promise. A *microtask* is a step JavaScript runs right after the current code. A *planted bug* is a bug put in on purpose, to show a check can fail.

**Marks.** *(measured)*: timed, three runs, each process alone under the box's timing lock; the range over the runs. *(checked)*: a probe, a seeded run or tsc ran it, and its line is in a `results/` folder. *(reasoned)*: an argument, not run. *(a guess)*: nobody measured it.

## The parts

| Part | What it is | Its README |
|---|---|---|
| [positions/](positions) | four benches: hashing one commit's records (`hash.mjs`), keeping a hash structure over a partition's rows per write (`tree.mjs`), a resume after compaction four ways (`resume.mjs`), and what a version and a cursor look like as text (`textform.mjs`) | [positions/README.md](positions/README.md) |
| [probes/](probes) | the owner's `connect` built on E-55's prototype ([proto/connect.mjs](probes/proto/connect.mjs), about 300 lines; E-55's `proto/lens.mjs` is imported and never edited), five probes: a thenable handle, `for await`, the callback's `(state, commit)`, `disconnect()` with a lifetime on one link (with E-55's seeded checks), and the types | [probes/README.md](probes/README.md) |

## How each claim was measured

- **Hashing a commit** (positions, `hash.mjs`). A commit is its records' bytes: 1 or 256 records of exactly 100 B or 1,000 B of JSON. CRC-32 (native), xxHash32 (E-05's, plain JavaScript), SHA-256 (`node:crypto`) and a SHA-256 chain (the previous 32 B hashed in). 7 rounds of about 0.2 s in one process, the median; three processes. SHA-256 is checked against its known value for "abc", CRC-32 against its check value.
- **A hash structure kept per write** (positions, `tree.mjs`). One partition of 1,000, 100,000 or 1,000,000 rows in a `Map`. 300,000 seeded writes replace random rows; 30,000 warm up, then three rounds of 90,000 are timed. Each way adds its own work per write; "extra" is the way minus a plain `Map` write in the same process. After the writes every structure is rebuilt from scratch and compared (`check: ok` in all 90 timed processes).
- **A resume after compaction** (positions, `resume.mjs`). A client holds a partition at a version; the server took k changes (a tenth of them removes) and the log since is gone. Four ways bring the client up to date, each checked against the server's rows: (a) a full picture, (b) a Merkle walk over (key, version), (c) the rows newer than the client's version plus tombstones, (d) the client lists every key and version. Bytes are counted exactly under one stated encoding; CPU is one process doing both sides, trees built beforehand.
- **Text forms** (positions, `textform.mjs`). Two order-keeping text forms of a version's number, checked on 1,000,000 seeded pairs; a one-partition cursor in E-19's layout as base64url.
- **A thenable handle** (probe 1, `thenable.mjs`). One client over E-55's loopback transport with JSON frames, so SUBs, UNSUBs, GETs and bytes are counted. Three variants: the handle is thenable and the link stays (V-a); thenable and awaiting ends it (V-a1); no `then`, and `get()` reads once (V-b). Seven ways code resolves values.
- **`for await`** (probe 2, `foreach.mjs`). A writer makes 10,000 commits a second for 5 s; the loop waits a 1 ms timer each turn (about 870 turns a second), merged (live state) or every commit (the log's rule). The cost per delivery: one link on 10,000 rows, the ways interleaved, the median of 7 rounds, differences taken inside each round.
- **`(state, commit)`** (probe 3, `commit.mjs`). What `state` is for a row, a field, a partition and the whole resource over 6 calls; what reading `prev`, a diff, the records and their JSON costs, end to end and alone (over 100,000 and 1,000,000 captured changes).
- **Lifetimes** (probe 4, `lifetimes.mjs`, `sims.mjs`, `signal.mjs`). 17 cases of `disconnect()`, `signal`, `until`, `once` and `break` on one link, among them a partition's state read after its link ends in four settings (a client with no linger, a client with a 50 ms linger, a server, a client with a second link on the same rows), as first built and with a guard per link; then E-55's seeded checks (its claims 7, 9 and 26) run on `connect`: 1,000 seeds of 150 steps on a server and a loopback client, links made at random points, ended at random by each way, some twice. `signal.mjs` times what `{ signal }` and `{ until }` add to a link: a listener per link against one listener per signal and a Set, alone, at 10 to 10,000 links on one signal, and the prototype's `connect()` then `disconnect()`, 7 interleaved rounds, the median.
- **Types** (probe 5, `check/`). A `fero.d.ts` sketch of the owner's connect; forms that must compile, each pinned by a type equality; 17 lines that must not. tsc 6.0.2, `strict`; the strip proof removes each `@ts-expect-error` and requires an error on its own line. Beside it, `slips.mjs` runs two slips the types cannot catch: what printing a lens gives, and when Node's HTTP request says it closed (one loopback GET, the client staying 300 ms).

## Results

All from the results files; each part's `summarize.mjs` prints the full tables ([positions/results/tables.md](positions/results/tables.md), [probes/results/tables.md](probes/results/tables.md)).

**Commit ids and positions** *(checked, `textform.mjs`)*:

| Epoch | Sequence | The version as text (prefixed form) |
|---|---|---|
| 0 | 1 | `11` |
| 0 | 9,001 | `38S9` |
| 0 | 16,777,215 | `5FZZZZ` |
| 3 | 12 | `930000000C` |

0 order errors in 1,000,000 seeded pairs for both text forms, 0 round-trip errors. A one-partition cursor is 21-26 bytes, 28-35 characters, for example `CzBVep_E6Q4zWH2ix-wRNgMBnAMAqUY`. The split of 63 bits between epoch and sequence (23 and 40 here) is *a guess*.

**Hashing one commit** *(measured)*:

| Way | 1 record, 100 B | 1 record, 1 KB | a record in a batch of 256 × 100 B | a record in a batch of 256 × 1 KB |
|---|---|---|---|---|
| CRC-32 | 194-204 ns | 350-371 ns | 23.3-24.0 ns | 225-236 ns |
| xxHash32 | 77.0-82.4 ns | 577-600 ns | 55.3-57.7 ns | 541-559 ns |
| SHA-256 | 1,147-1,246 ns | 1,747-1,829 ns | 76.5-78.5 ns | 730-752 ns |
| SHA-256 chain | 1,631-1,676 ns | 2,325-2,431 ns | 79.8-82.6 ns | 718-751 ns |

**A hash structure kept per write, extra ns over a plain `Map` write** *(measured)*:

| Way | 1,000 rows | 100,000 rows | 1,000,000 rows | Memory |
|---|---|---|---|---|
| a per-row version in a `Map` (`ver`) | +10.5 to +15.1 | +26.8 to +64.1 | +213 to +276 | 29-37 B a row |
| Merkle tree over (key, version), path rehashed each write (`mkver`) | +598 to +605 | +1,202 to +1,224 | +1,395 to +1,747 | tree 2.2 / 5.6 / 0.6 B a row, exact |
| the same, path rehashed once per 256 writes (`mkverb`) | +296 to +304 | +854 to +900 | +1,177 to +1,281 | the same |
| only the leaf sums kept (`mkleaf`) | +254 to +309 | +360 to +382 | +695 to +854 | the same |
| ... `mkleaf` over `ver`, which it rides on | +243 to +296 | +296 to +355 | +420 to +602 | |
| Merkle tree over each row's content hash (`mkrow`) | +2,037 to +2,180 | +3,496 to +3,809 | +3,640 to +3,791 | the same |
| SHA-256 Merkle tree (`mksha`) | +8,295 to +8,507 | +16,784 to +17,277 | +19,243 to +20,384 | 34-54 B a row of arrays |
| E-05's order-free sum, old hash recomputed (`sum`) | +1,584 to +1,676 | +2,649 to +2,691 | +2,798 to +3,065 | none |
| the same, each row's hash kept (`sumkept`) | +852 to +861 | +1,305 to +1,333 | +1,477 to +1,700 | 50-61 B a row |

No way came under 0.2 µs in any run. 0.2 µs is the bar E-54 set for a version kept per write on the live path (API.md:747 at commit ca36cf8, before API.md was rewritten for V5-13 to V5-15), used here only as a yardstick. Building every inner node on demand instead: 4-8 µs at 1,000 rows, 1.21-1.30 ms at 100,000 and 1.15-1.58 ms at 1,000,000; SHA-256 5.6-12.3 ms.

**A resume after compaction, bytes up plus down, 100 B rows** *(checked: exact bytes, the same in every run)*:

| Rows | k | (a) full, 1 trip | (b) Merkle walk | (c) newer + tombstones, 1 trip | (d) list, 1 trip | (b) ÷ (c) |
|---|---|---|---|---|---|---|
| 1,000 | 1 | 122,483 | 510, 3 trips | **164** | 13,029 | 3.11 |
| 1,000 | 100 | 121,348 | 18,906, 3 trips | **11,260** | 24,045 | 1.68 |
| 100,000 | 1 | 12,844,211 | 790, 5 trips | **169** | 1,489,034 | 4.67 |
| 100,000 | 100 | 12,843,016 | 42,070, 5 trips | **11,848** | 1,500,633 | 3.55 |
| 100,000 | 10,000 | 12,742,812 | 2,110,441, 5 trips | **1,197,945** | 2,678,810 | 1.76 |
| 1,000,000 | 1 | 131,441,711 | 910, 5 trips | **173** | 15,889,038 | 5.26 |
| 1,000,000 | 100 | 131,440,489 | 64,039, 5 trips | **12,127** | 15,900,912 | 5.28 |
| 1,000,000 | 100,000 | 130,487,246 | 25,922,470, 5 trips | **12,348,898** | 28,157,763 | 2.10 |

With 1 KB rows (c) is still smallest in all 8 cases, and (b) is 1.08 to 1.68 times (c). With 32-byte SHA-256 node hashes the walk sends 1.3 KB to 27.6 MB. CPU *(measured)*: (c) scans the partition on the server, 0.24-0.31 ms at 1,000 rows, 2.5-6.2 ms at 100,000, 23.9-43.0 ms at 1,000,000; the walk takes 18-35 µs for one change but 1.12-1.16 s with a tenth of a million rows changed; (d) 0.51 to 418 ms.

**Probe 1, a thenable handle** *(checked)*: an `async` helper that returns `lens.connect(fn)`, called 1,000 times: with V-a, 1,000 links left open and 0 handles to end them; with V-a1, each callback called once and then never again; with V-b, 1,000 handles, all ended. `get()` built as `connect({ once })` on a client, reading one number of a 1,000-row partition: 1 SUB, a 65,671-byte picture, 1,000 rows folded, 1 UNSUB; E-55's `get()`: 1 GET, 1 byte.

**Probe 2, `for await`** *(measured)*:

| Loop | Link on | Commits the loop saw (of 50,000) | Waiting at the end | Heap growth |
|---|---|---|---|---|
| merged | one row | 49,990-49,996, 11.4-11.6 a turn | 1 | 0.3-0.4 MB |
| merged | the whole resource (1,000 rows) | 49,991-49,995, 11.4-11.6 a turn | 5-9 rows (at most 27-50) | 0.3 MB |
| every commit | one row | 4,362-4,412 | **45,588-45,638** | **16.1 MB** |
| every commit | the whole resource | 4,372-4,387 | **45,613-45,628** | **17.1 MB** |

The every-commit queue grew 9,116-9,127 commits a second. This is the gap between evidence 5's two rules, which a separate log verb has too; it does not say whether the switch may sit behind one option (a judgement, CONNECT.md 2.4).

Per delivery, one link on 10,000 rows: a callback 161-189 ns a commit over no link; a loop +116 to +137 ns over the callback (every commit, in bursts), +166 to +241 ns (merged, in bursts); one commit per turn +707 to +789 ns (every) and +874 to +910 ns (merged) over a writer that awaits each commit with no link.

**Probe 3, `(state, commit)`** *(checked and measured)*: for a row, `state` is a new object at each write; for a partition or the whole resource it is one live view, so a React-style setter rendered 1 of 6 calls, and a new wrapper each call rendered 6 of 6. No change carries a version on the prototype; it must come with the frame. Alone, per change: reading `prev` 8.2-11.5 ns, building a diff object 21.0-29.2 ns, a field diff 30.5-59.0 ns, the records 137.6-170.3 ns, the records as JSON 278.6-376.9 ns. End to end at one change a commit, every read stayed within −80 to +29 ns of reading nothing. In a merged loop (probe 4's seeded run), a partition's state ran ahead of its turn's diff in 5,640 of 196,267 turns (2.9 %); a row's never.

**Probe 4, lifetimes** *(checked)*: 17 of 17 cases pass with the defaults (the first call a microtask after `connect()` returns, `break` ends the handle, a strict `until` that also refuses an HTTP request). **A partition's state read after its link ends**, as first built (the shared live view): on a client with no linger, 2 rows before and 0 after; with a 50 ms linger, still 2 rows, and a server write after the end showed (`n` went 1 to 41), then 0 after the linger; on a server, the write showed; with another link on the same rows, the write showed. With a guard per link, every one of those reads, and `handle.state`, threw `ended`. E-55's seeded checks on `connect`: claim 7, 1,000 seeds, 73,789 links (40,778 callbacks, 7,467 `once`, 17,767 merged loops, 7,777 every-commit loops; 22,237 ended twice): 0 doubled, 0 missed, 0 wrong `prev`, 0 calls after the end, 0 selections left. Claim 26: 59,941 view sinks, 0 calls after the end. Claim 9: 2,000 handles on one row, 100 writes: 1 SUB, 100 decodes, 100 `text()` builds for 200,000 deliveries, 1 UNSUB after the linger.

**Probe 4b, what `{ signal }` and `{ until }` cost a link** *(measured)*: a listener per link on one shared signal, as this prototype does, cost 1.9-7.2 µs to add at 1,000 links and 19 µs at 10,000; one listener per signal and a Set cost 0.11-0.16 µs to join and 0.05-0.07 µs to leave at 1,000 and 10,000 links. On the prototype, `{ signal }` added 2.7-3.0 µs a link to `connect()` plus `disconnect()` at 1,000 links and 25-28 µs at 10,000; `{ until }` added 0.39-0.59 µs a link with 10 links on one socket-like thing.

**Probe 5, types and two slips** *(checked)*: tsc 6.0.2 exit 0; 17 of 17 stripped lines fail at their own line. A thenable handle disappears from the types too (an `async` helper that returns `connect(fn)` types as the row). `get(key)` beside `get()` compiles, and `await shop.data.get(sku)` compiles as an address. Run: `JSON.stringify(lens)` gives `undefined` (`{}` when the lens is a field of an object), `console.log` prints `Lens(shop.widgets)`; and on Node 22.22.0 an HTTP request whose body was read said `close` at 19 ms while its client stayed until 315 ms, so `{ until: req }` would end a long response's link at once.

## The checks have teeth

Each planted bug must make its run fail *(checked; probes/results/sims.jsonl and checks.jsonl)*:

| Planted bug | What the run saw |
|---|---|
| `twice`: a second end releases the selection again | 28,137 unequal and 24 calls after the end (300 seeds); 2,001 linger timers; a lifetimes case fails |
| `mergeprev`: a merged change keeps the newest `prev`, not the first | 4,953 wrong `prev` |
| `mergedrop`: a remove then an add of one key merges as an add | 388 doubled, 87 merged turns unequal |
| `percopy`: a new commit object per link | 100,000 `text()` builds, not 100 |
| `onceheld`: `once` ends the view's sink but not its hold | 1,273 views and 729 selections left |
| `nosignalcleanup`: `disconnect()` leaves the abort listener | 2 lifetimes cases fail (1,000 listeners where 500 should be) |
| `untilclosed`: no check that `until` already closed | 2 lifetimes cases fail |
| E-55's `viewleak`, `cover` | 39,841 calls after the end; 95 and 126 merged turns unequal |
| E-55's `bornseq`, `settled` | **not caught with the first call a microtask later: 0 of 73,789 first calls came inside a batch or a commit's effects, so neither rule is ever reached.** With the first call inside `connect()`: 1,315 and 533 doubled |

The positions part checks itself: every kept tree equals one rebuilt from scratch after its writes (`check: ok` in all 90 timed tree processes), every resume leaves the client equal to the server (`ok` in all 32 cases of each row size), and SHA-256, CRC-32 and xxHash32 are checked against reference values at start.

## Limits

- **Stand-ins.** The probes sit on E-55's prototype: no fero kernel, no log, no positions. `from` takes only `'now'`, and an every-commit loop keeps its queue in the process; a real log reader reads the server's log by position, so there the cost is lag, not memory *(reasoned)*. The positions benches use a `Map` for data's rows and plain JSON for fero's records.
- **Not measured:** the cost of a commit carrying its cursor or its version (bar 50 ns a commit); the cost of the `ended` guard as a real build would make it (one flag check in the view's read trap; the probe's guard is a second `Proxy`, which shows the rule holds, not its price); counting back for `-5` on a real log; an index that keeps rows in version order; tombstone memory; anything over a real network. The resume counts bytes and trips; it does not time a network.
- **Small worlds.** The seeded runs use 12-30 rows and 4 partitions, one process, a loopback client, no reconnect. The slow loop waits on a timer, not on CPU work.
- **One box:** 4 CPUs, Node 22.22.0, Linux 6.18; another study shared it, and every timed process held the timing lock.
- **When it ran.** Every result here was made again, in full, on 2026-11-20 between 03:37 and 04:00 UTC, after the box restarted at about 01:02, with the scripts as they stand (`./run.sh` from a copy of this folder; each part cleans its results first; every node process capped at 4,000 MB of heap). Every timed process ran three times, each alone under the timing lock; the checks, the seeded runs and the types ran under the heavy lock. Every line that does not depend on time came out the same as in the first runs (00:33-00:54): probe 1, probe 3's identity check, every earlier lifetimes case, all 17 seeded-run lines byte for byte, the types, the resume bytes and the text forms *(checked)*. New since then: lifetimes cases 11 (four settings, and the guard) and 16 (a request as `until`), `signal.mjs`, `slips.mjs`, and two columns in the tables. **The timed numbers moved.** Most cells came out slower, by up to about 30 %; a few came out faster (SHA-256 of one 100 B record, 1,244-1,353 → 1,147-1,246 ns); a few moved more: the callback over no link 110-141 → 161-189 ns; one commit per turn +413-621 → +707-910 ns; the records' JSON 215-283 → 279-377 ns; CRC-32 of one 100 B record 173-175 → 194-204 ns; the eager Merkle tree at 1,000 rows +486-512 → +598-605 ns. The cause is not known. Two candidates: the heap cap fell from 8,000 or 12,000 MB to 4,000 MB, which may shrink V8's young generation, and another study shared the box (a guess either way). No verdict changed. CONNECT.md cites only the new numbers.

## How to run

```sh
SP=<your scratch folder> ./run.sh            # both parts in full: each cleans its results/, runs, writes results/tables.md
SP=<your scratch folder> ./run.sh positions  # one part
SP=<your scratch folder> ./run.sh probes
SP=<your scratch folder> ./run.sh summary    # both parts' tables from the results already there
```

`SP` holds the lock helpers `bin/timing` (runs one command alone on the box) and `bin/heavy` (shares the box, waits for timing runs). `NODE` defaults to `node` on PATH (Node 22.22.0); tsc 6.0.2 is taken from PATH, or from `NODE`'s folder when `NODE` is a path. `RUNS` defaults to `1 2 3`. `NODEF` overrides the node command and its flags. `DATA` is data's folder for E-55's prototype (default `../data`, next to this repo, read only). Nothing is downloaded. Each part's README lists its own modes.

## Verdict

**One `connect` for live state: yes, with three lifetime rules, and a partition's state readable only while its link is live. A thenable handle and `get` built as a subscription: no, checked. `from`, `at` and `once` on `connect`: no, but by judgement, not by measurement; E-56 measured only how far one word moves a slow loop. A commit id is a version inside one partition and a cursor across; Merkle trees: no, for every use now.** The design that follows is [CONNECT.md](../../CONNECT.md).
