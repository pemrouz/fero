# A compact row store: does fero want one, and where would it sit

2026-11-23. V5-20 item 9 ([DECISIONS](../DECISIONS.md)) did not leave a compact row store to a later build by default. It asked for a decision now: does fero want one, and where would it sit (inside `data` 5, or as a store of fero's own)? Adding it late could force a rewrite of the layers below. [E-65](experiments/E65-every-row/README.md)'s X1 had built a column store and an arena and found them smaller and almost free of pauses, but `data`'s operators do not run on them ([EVERYROW.md](EVERYROW.md) 3.2, question 9). This page maps every place that depends on how rows sit in memory, prices five ways, and says what the first build must fix so that a compact store stays a cheap addition. A review checked it; section 8 says what that changed.

**How it was made.** Read V5-1 to V5-20, [LAYERS.md](LAYERS.md), [API.md](API.md), EVERYROW.md, E-63, E-65's X1, fero's one seam onto `data` ([api/substrate.ts](../../api/substrate.ts)), and `data`'s engine at 63fea66 (its `kernel/`, `contract/`, `seam/`, `ops/` and `api/`). Five small probes in [E-66](experiments/E66-compact-rows/README.md): one read of a held row in each layout, a full collection with the keys kept in a JavaScript `Map`, a row made by code written for the fixed shape, the key index's own stall as it grows (all timed), and a count of what in `data` reads rows as objects. E-65's numbers are cited, not run again.

**Marks.** *(measured)*: timed, three runs, each process alone on the box, a range. *(checked)*: a probe or a run checked it, or a reading of the code (*checked: read*). *(counted)*: a count from code or a run. *(reasoned)*: an argument; nothing ran it. *(a guess)*: nobody measured it. File references are `file:line`; `data`'s are at 63fea66.

---

## 0. The answer

1. **Do not build a compact store in the first build. Deferring is safe once the first build does six small things** (section 5): fero reads rows only through `data` and keeps none of its row objects; snapshots name their format and are never a dump of V8's objects; the row version is a column of `data`'s store; `data` 5's operators keep keys, not rows; the read promise lets a row be made on read; and `data` 5 splits each source's key index into small tables *(reasoned, from the map in section 2; the last one measured)*.
2. **The key index binds before the rows do, with or without columns.** `data` keeps a source's keys in one JavaScript `Map` (`kernel/store.ts:33-35`). When a `Map` fills, V8 builds a table twice the size in one step: 249 to 304 ms at 4.2e6 keys and 631 to 688 ms at 8.4e6. One `Map` stops at 16,777,216 keys *(measured, E-66 review)*. 64 small `Map`s chosen by the key's hash kept every rebuild under 20 ms and passed 16,777,216 *(measured)*. This touches no row, helps today's layout, and `data` 5 owes a lifted cap anyway (V5-20).
3. **When a compact store comes, it sits inside `data`** (C2), as a second backing behind `data`'s own store, turned on by size or by an explicit setting, never by declaring a schema alone. `data` already plans it: its store "stays columnar-ready: a columnar SourceBacking swaps `slots: T[]` for per-field columns behind the same keySlot map" (`kernel/store.ts:6-8`) *(checked: read)*. A store of fero's own for holds (C1) keeps only the views that merge, so what a user may run would depend on how the rows are held *(reasoned)*.
4. **No first-build need asks for it.** DEP-13's 2 KB a small row is met about three times over: 698 to 703 B of RSS *(measured, E-65 X1)*. A leader's full collection passes V5-20's 0.5 s health warning near 1.9e6 to 2.7e6 small rows, and F-06's 1 s near 3.7e6 to 5.3e6 *(reasoned, linear from E-65's 943 to 1,335 ms at 5e6)*. Holds are bounded by `memory` (V5-20 item 3).
5. **A row made from columns costs about twice `data`'s read at 1e6 rows, and three to six times at 1e4.** A frozen row of the fixed shape: 936 to 1,082 ns at 1e6 rows, against 455 to 497 for `data`'s row; 199 to 251 ns at 1e4, against 42 to 65. With the keys in a `Map`: 1,160 to 1,306 ns at 1e6. The one text field is a third to a half of it *(measured)*. A row view that copies nothing costs about what `data` costs: 267 to 365 ns at 1e6, 77 to 88 at 1e4 *(measured)*. E-66's first figure, 2.7 µs, measured E-65 X1's generic code, not the cost of making a row.
6. **What keeps rows inside `data` today.** Of `data`'s 35 node classes, 4 always keep row objects in their state (`FilterNode` with its 2 subclasses, `MapNode`, `BucketNode` in group mode, `ToValueNode`), and 3 more keep the row when no field or function is named (`DistinctNode`, and the bases of max, min, some, every, sum, avg and quantile) *(checked: read)*. Beyond those: 23 calls fetch a row by key, 35 call the app's own function, 56 walk a whole parent, and every change carries its rows by reference *(counted, approximate)*. Under a compact backing each of these must make a row, or read a column.

---

## 1. Words

- **Row layout.** How a row sits in memory. Today each row is one JavaScript object in `data`'s store. A change makes a new object (`pathCopy`, `kernel/node.ts:463`), so an old row never changes.
- **Compact store.** Rows kept outside V8's graph of objects. **Column store**: one typed array a field; a row is an index into them. **Arena**: each row as bytes in big buffers.
- **Backing.** What `data`'s store keeps rows in: today an array of row objects (`slots`) and a `Map` from key to place (`keySlot`, `kernel/store.ts:33-35`).
- **Key index.** The table that finds a row's place from its key: `keySlot` in `data`, a hash table in typed arrays in X1. **Rebuild**: when the table fills, a new one twice the size is built and every key is moved, in one step.
- **Made row.** A new plain object filled from the columns on a read. "Of the fixed shape" means code written for the row's known fields (one object literal), not a loop over field names. **Row view** (or flyweight): a tiny object that holds only the row's index and reads each field from its column when asked; a **Proxy** does the same with a trap.
- **Held row.** A row this process keeps live: a server's copy, `hold: 'all'`, a live link.
- **`schema`.** P-20's optional runtime check of a row's fields ([API.md](API.md) P-20). A compact backing may read field types from it later; it needs no new name.

---

## 2. What touches the row layout (the map)

Each row: where it is, what it does today, what changes under a compact layout, and whether that change is cheap later or a rewrite. C1 to C4 are the options of section 3. "Fix n" is the fix of section 5 that keeps the row cheap.

| # | Place | Where | Today | Under a compact layout | Later: cheap or rewrite? |
|---|---|---|---|---|---|
| 1 | **The fold** | v4: `api/substrate.ts:113-170` (`applyRec`); `data` `seam/index.ts:343-399`, `kernel/node.ts:434-470`. v5 keeps it: committed records through `data`'s lane (LAYERS 3.3 `fold-all`, 3.4) | records in; `data` copies the row along the path and keeps the new object | C1: fero's store applies the records itself (X1's `apply`). C2: `data` writes the column in place and makes the old row for the change | **cheap**: records are the only way in, in both repos *(checked: read)* |
| 2 | **Changes carry rows** | `data` `contract/delta.ts:29-50` (`row`, `prev` by reference) | free: the old object is still there | C2: one or two made rows a change; young garbage unless something keeps them | cheap inside `data`, if row 3 holds (fix 4) |
| 3 | **Live views and operators** | `data` `ops/*.ts`; counted in E-66 | 4 classes always keep row objects: `FilterNode.view` (`ops/rowops.ts:16`, and its subclasses `RescopeFilterNode`, `CompareRNode`), `MapNode.view` (`:189`), `BucketNode.members` (`ops/bucket.ts:114`, `:130`), `ToValueNode.mirror` (`ops/misc.ts:672-686`). 3 more keep a projection that is the row itself when no field or function is named: `DistinctNode` (`misc.ts:443-460`, `:454`), `TrackedScalarNode` (`misc.ts:36-56`), `ProjectionAggregate` (`ops/aggregate.ts:52-72`). For max, min, sum and the rest, no field means a list of plain values, so in practice it is `distinct()` with no function *(reasoned)*. The rest keep keys and values (since `data`'s M6 work) | C1: only fero's own views (sum, count, min, max, top k, distinct, a sorted column), +9 to +15 builder rules (E-65 X1). C2: every operator; the 10 classes that name a field read its column; the 35 app-function calls need a row | **rewrite inside `data`** if `data` 5 adds more state that keeps rows; cheap if it keeps keys (fix 4) |
| 4 | **The comparator of an ordered view** | `data` `ops/ordered.ts:186-187`, `:203-210` | two `rowAt(k)` reads a comparison, from the parent | C2: a row view or a column read per side: 475 to 518 ns with X1's index, 798 to 895 with keys in a `Map`, against 536 to 643 for `data` *(measured, E-66)* | cheap if `by` is a field name (`ordered.ts:506`) |
| 5 | **The lens** (writes by assignment) | v4: `api/substrate.ts:309-420`. v5: `data`'s handle is the lens (D2) | a write becomes a record; reads go through `data`'s handle | none on the write side; reads see the store through the handle | **cheap** |
| 6 | **Held-row reads**: P-01's < 100 ns, and the owed pin | API.md 3.9, 3.10 (lines 524, 573-576, 621); REQUIREMENTS P-01 | the frozen row by reference, a new object at each write. API.md owes a pin: a re-read of a row already read within twice a `Map` read (line 576) | a made, frozen row per read: 1.9 to 2.4 times `data`'s read at 1e6 rows, 2.4 to 2.9 with keys in a `Map`, 3 to 6 times at 1e4 *(measured)*. That misses the owed pin, and at 1e4 rows it misses P-01's 100 ns (199 to 251 ns) | cheap if the layout turns on by size, and the read promise allows a made row (fix 5, question 4); a **broken promise** otherwise |
| 7 | **Judging on main** (V5-20 item 14) | LAYERS 3.1, 3.3 | the leader reads the newest state: the shape rule, guards, an op's start value, a room write's rows, `op.merge` | field reads: about a `data` read from columns (E-66 `id`); a made, frozen row adds about 0.5 µs a row read at 1e6 rows *(measured)* | **rewrite** if the judge keeps or walks row objects; cheap if it reads through `data` (fix 1) |
| 8 | **Served views** (V5-20 item 13) | LAYERS 4; TRANSFORMS 3.8 | `data`'s operators over a copy's rows | C1: untouched (servers keep `data`). C4: needs C2 | cheap with fix 4 |
| 9 | **`scan()` and folds** (V5-20 items 4, 5) | E-65 X2, X3 | pages read a copy's rows by key at a pin; a pin keeps an image of a row the first time it changes, from the change's `prev`; a fold's `emit` reads a row | C2/C4: an image is one made row at the first change of a pinned row (X2: 127 B today); pages encode from columns | cheap if pages are read through `data` by key, not by holding its objects (fix 1) |
| 10 | **Snapshots and journal replay** | LAYERS 1.2 (line 233), 8.5 step 5 (line 1322), 9.2 PA-1b (line 1664) | load the newest snapshot into `data`, then replay the tail through the lane; PA-1b proposes "snapshots in V8's format" | a compact store must load and write a snapshot in a form it can read without V8's objects | **rewrite** if a snapshot is one V8 dump of the object graph; cheap if each snapshot names its format (fix 2) |
| 11 | **Per-row versions** (owed) | LAYERS 3.2 (line 525); CONNECT 3.6; `data` N7 | not built; a separate `Map` costs 29 to 37 B a row (E-56) | a column of versions | **rewrite** if kept on the row object or in a `Map` keyed by row; cheap as a column by slot in `data`'s store (fix 3) |
| 12 | **DEP-13**, 2 KB a small row | REQUIREMENTS DEP-13 | 698 to 703 B of RSS a row (E-65) | column store: 298 B (E-65 X1, its table) | not needed for it |
| 13 | **F-06 pauses** on a process that leads | REQUIREMENTS F-06; V5-20 item 8 | 943 to 1,335 ms at 5e6 rows (E-65) | column: 7.5 to 14.3 ms at 5e6 with X1's index (E-65, E-66); keys in a `Map`: 157 to 334 ms (E-66); plus each live view's key maps (row 3) | C4 lifts a server's rows past about 2e6 to 5e6 small rows; cheap with fixes 4 and 6 |
| 14 | **The `memory` guard** (V5-20 item 3) | API.md 9 | counts RSS | RSS counts off-heap bytes too | **cheap**, if the open asks `data`'s store for its bytes a row, not a constant (fix 1) |
| 15 | **The key index** | `data` `kernel/store.ts:33-35` (`keySlot`) | one `Map` a source. A full collection marks it; a rebuild blocks main for 59 to 84 ms at 1.05e6 keys up to 631 to 688 ms at 8.4e6; it stops at 16,777,216 *(measured, E-66 review)*. E-63 saw the 1e6 rebuild as a leader's p99 of 140 to 441 ms | the same under C2, unless the index changes: X1's typed index also doubles in one step (`compact.mjs:72`, `:98-103`), and grown from empty it stalled 2.7 to 3.1 s *(measured)* | **cheap now** inside `data` (fix 6); it binds C0 and C2 alike |
| 16 | **`snapshot()` and whole-value reads** | `data` `kernel/node.ts:98` (`snapshot(): Map<RowKey, Out>`), `:138-140` (`rowAt` falls back to it), `api/index.ts:97`; `seam/index.ts:599`, `:696`, `:704` | a whole `h.value`, a picture's start and a sink's start read every row through it; listing `h.value` or `{ ...h.value }` walks every row (API.md 3.9) | C2: each call makes every row | cheap if full passes go through `each` or a key iterator, never a new `snapshot()` caller on a hot path (fix 4) |
| 17 | **Warm pictures** (reasoned, not built) | LAYERS 4.2 (line 709) | with `hold: '200MB'`, closed selections' rows kept in client memory | a fero-side row cache: it keeps row objects outside `data` | cheap if they keep a `data` source or bytes, not row objects (fix 1) |
| 18 | **Sinks by reference, freeze once** | LAYERS 3.7 D4 and D8a (lines 654, 658); `data` `api/index.ts:152-162` | a sink gets the row object; the first read freezes it once, deeply, remembered in a `WeakSet` keyed by the row object | each delivery makes and freezes a row, and "once" has no object to key on | cheap if the read promise allows a made row (fix 5); a per-slot cache of made rows keeps freeze-once (O1, section 3) |

Two facts carry this map. **fero has one seam onto `data`**: `api/substrate.ts` imports one `data` entry and folds only records *(checked: read)*. **`data` already hides its layout behind one store**: the source writes through `slotOf`, `rowAt` and `writeSlot` (`kernel/node.ts:440-466`), and three operator families have already moved from keeping rows to keeping keys and reading rows from the parent (`ordered.ts:183-209`, `between.ts:73`, `setops.ts:119`) *(checked: read)*. What would make a later compact store a rewrite is code that skips those seams: a fero layer that keeps or walks `data`'s row objects, a snapshot that is a dump of them, a version stored on them, an operator that holds them.

---

## 3. The options

### C0. No compact layout
- **What.** Rows stay `data` objects everywhere. Big holds are bounded by `memory` (V5-20 item 3).
- **Covers.** Every operator, every read, P-01 on its small shape. DEP-13 met three times over.
- **Costs.** 698 to 703 B of RSS a small row, about 1.4 M rows a GB *(measured, E-65)*. A full collection near 1 s at 5e6 rows *(measured, E-65)*. The key `Map`'s rebuild: 249 to 304 ms at 4.2e6 keys, 631 to 688 ms at 8.4e6, and a stop at 16,777,216 *(measured, E-66 review)*. A process that leads holds about 2e6 to 5e6 small rows before the warning or F-06 binds *(reasoned from those)*. And V8's heap limit: REQUIREMENTS SC-10 records 2.05 GiB on its box, which at 296 to 300 B of heap a row (E-65 X1) is about 7e6 small rows before any operator state; on this box today the default is 8.05 GiB *(checked)*, so the line moves with the machine *(reasoned)*.

### C1. A fero store for big holds only
- **What.** `hold: 'all'` with a fixed row form keeps rows in fero's own column store (X1's form). Sync reads, `get()`, and the views that merge.
- **Covers.** Big holds at about 0.4 times the RSS and about 1 % of the pauses *(measured, E-65)*.
- **Costs.** Two stores and two read paths in fero; +9 to +15 builder rules for fero's own views (E-65 X1); +1 to +2 user rules: on a compact hold, a `filter(fn)`, `group`, a `reduce` or a comparator function is refused, so what runs depends on the hold's kind *(reasoned)*. Servers are not helped.

### C2. Inside `data` 5: a column backing
- **What.** A source past a size line, or with an explicit setting, keeps its rows in columns; every operator runs on it. The key index is fix 6's small tables, which pass 2^24 and grow in steps. A single `Map` does not do: it stops at 16,777,216 and rebuilds in one step *(measured)*.
- **What changes in `data`** *(counted, E-66; reasoned)*: the store (`kernel/store.ts`, 297 lines) gets a second backing; the write path (`node.ts:434-470`) writes in place and makes `prev`; the 4 classes that keep rows move to keys, as M6 did for three others, and the 3 that keep a whole-row projection keep the key instead; the 10 classes that name a field read its column; the 35 app-function calls, the 56 full passes and the `snapshot()` callers get a made row or a row view; sink deliveries (D4) make rows and the freeze (D8a) needs O1's cache or runs at each read; the adopted lanes (`store.ts` `adoptObject`, `adoptArray`) stay for object-born sources.
- **Covers.** Every operator on big rows, for holds and for servers alike.
- **Costs.** The largest piece of work: most of `data`'s kernel and `ops/` *(a guess: a release the size of data 5's own D-items)*. fero's side: none past fixes 1 to 3.

### C3. Columns with a row view on read
- **What.** C1 or C2, where a read gets a row view (a flyweight or a Proxy) instead of a made row, so code that reads rows still works.
- **Per read** *(measured, E-66)*: one field 267 to 365 ns at 1e6 rows (Proxy 350 to 434), against 396 to 518 for `data`; kept in a ring, so the object must exist, 289 to 331. At 1e4 rows 77 to 88 ns, under P-01's 100. All eight fields cost 2,693 to 3,038 ns through X1's text path, where a made row of the fixed shape reads them in 1,239 to 1,408.
- **The catch.** A row view reads the live columns, so it changes when the row changes. `data`'s changes hand out `prev`, and the API promises a row "you may keep" never changes (API.md line 574). So a view may only serve reads that do not keep the row: a comparator, a projection, a judge, a fold's `emit`. A row handed to app code must be made and frozen *(reasoned)*. Since a made row of the fixed shape costs only about twice `data`'s read at 1e6 rows, views pay only where reads are many and hot: comparators and field reads at small sizes *(reasoned)*.

### C4. Servers' own rows compact too
- **What.** A server's copy of its groups uses C2's backing, not only holds.
- **Covers.** F-06 for big servers. A leader's pause at 5e6 rows drops from about 1 s to the columns' and key tables' own: 157 to 334 ms with keys in one `Map` *(measured, E-66)*, less with fix 6's tables *(a guess: not timed with columns)*. Memory a row about 0.4 times *(measured, E-65)*.
- **Costs.** Needs C2 first, since served views, judging, root code and `ctx.data` run on a server's rows. Operators still keep one key `Map` entry a row per live view: E-66's `Map` of 5e6 keys alone paused 176 to 280 ms, so a leader's pause is the source's plus each live view's key maps *(measured; the sum reasoned)*. DEP-13 does not need it.

### C5. Fix the seams now, choose the layout per source later
- **What.** C0 in the first build, plus the six fixes of section 5. A compact backing then comes as C2 (with C3's views where they pay) inside `data`, turned on by size or by an explicit setting, and reading field types from P-20's `schema`.
- **Covers.** Everything C0 does now, with fix 6 removing the key index's stall and stop; leaves C2 and C4 as additions.
- **Costs.** +0 to +1 builder rule in fero (fix 1) and +1 in `data` (operators keep keys); 4 of `data`'s classes change in `data` 5, and 3 more keep a key where they kept a whole-row projection *(checked: read; reasoned)*. Fix 6 is new work inside `data`'s store, no new rule *(reasoned)*.

### Other ways, named and weighed
- **O1. A cache of made rows, one per slot.** Make a row on its first read, freeze it, keep it until that row is written. Two reads of an unchanged row are then `===`, the freeze runs once, and a re-read is a key lookup plus an array read: the same steps as `data`'s read today *(reasoned)*. Only rows read since their last write stay on the heap; kept through `WeakRef`, a row stays only while app code holds it, which is exactly when identity can be seen *(reasoned; the cost of many `WeakRef`s is a guess)*. It is the way to keep the owed pin and D8a under C2 (question 4).
- **O2. Hot rows as objects, cold rows in columns.** Rows written or read lately stay `data` objects; a pass off the hot path packs cold rows into columns, as `data`'s store already compacts off the hot path. App reads of hot rows keep `data`'s cost. Two layouts in one source, and a cold row's first write must make its `prev` *(reasoned)*. A form of C2, for later.
- **O3. Turn the layout on by size, or by an explicit setting.** A source turns to columns past N rows. Small resources with a `schema` keep P-01 and the owed pin. Taken into C2 and C5.
- **O4. The key index first, as its own piece.** Taken as fix 6.
- **An arena** (rows as JSON bytes): needs no fixed form, pauses 5.4 to 6.1 ms at 5e6, but a field costs 1.37 to 1.52 µs to read *(measured, E-65)*. A picture could send its bytes unchanged *(reasoned)*. A fallback for rows with no `schema`.
- **Keys in typed arrays** (X1's index): pauses 7.5 to 14.3 ms at 5e6, and faster than a `Map` for one field (309 to 346 against 546 to 588 ns) *(measured, E-65, E-66)*. But it doubles its table in one step too, and its key bytes grow by copying: grown from empty to 16.8e6 keys it stalled 2.7 to 3.1 s *(measured)*. In E-65 and E-66 it was sized at the start. A choice inside fix 6, not a separate option.
- **A projection hold** (`hold` with named fields only): half the heap for three of eight fields *(measured, E-65)*. An API option, not a layout; it can come any time.

---

## 4. The comparison

| | C0 data only | C1 fero store, holds | C2 inside `data` | C3 row view on read | C4 servers too | C5 seams now |
|---|---|---|---|---|---|---|
| RSS a small row | 698 to 703 B | 298 B | about 330 to 390 B *(a guess: X1's 298 B, less its own key index, plus a key `Map`'s 51 to 90 B, E-66)* | as C1 or C2 | as C2, on servers | as C0 now |
| Longest collection, 5e6 rows | 943 to 1,335 ms | 9.5 to 14.3 ms | 157 to 334 ms (keys in one `Map`) | as C1 or C2 | as C2, plus views' key maps | as C0 now |
| Key index stall | one `Map`: 249 to 304 ms at 4.2e6 keys, 631 to 688 at 8.4e6; stops at 16,777,216 | X1's index sized at the start: none; grown from empty: up to 2.7 to 3.1 s | fix 6's 64 tables: under 20 ms, no stop at 2^24 | as C1 or C2 | as C2 | fix 6: under 20 ms |
| One field of a held row, 1e6 rows | 396 to 518 ns | view 267 to 365; made, frozen 936 to 1,082 | keys in a `Map`: view 520 to 614; made, frozen 1,160 to 1,306 | view, as C1 or C2 | as C2 | as C0 now |
| The same at 1e4 rows (P-01: < 100 ns) | 42 to 65 ns | view 77 to 88; made, frozen 199 to 251 | view 71 to 86; made, frozen 187 to 264 | view 71 to 88 | as C2 | as C0 now |
| `data`'s operators | all | merge views only | all | all, rows made for app code | all | all |
| Builder / user rules | 0 / 0 | +9 to +15 / +1 to +2 | fero +0 to +1; `data` most of `ops/` | +1 to +2 (when a row is made) | C2's, plus a server setting | fero +0 to +1, `data` +1 / 0 |
| Later work if deferred | rewrite where seams were skipped | rewrite of holds' views | — | — | needs C2 | cheap: C2 and C4 are additions |
| Who needs it | — | a deployment with big holds | big holds and big servers | with C1 or C2 | a leader past about 2e6 to 5e6 small rows | everyone, now |

Sources: E-65 X1 (RSS, pauses), E-65 probe (`data`'s pause), E-66 (row views, made rows, keys in a `Map`, the key index, the count). Every read cell is *(measured)*; rule counts *(reasoned)*.

---

## 5. The pick, and what the first build must fix now

**Pick C5**: no compact store in the first build; fix the seams now; when a deployment needs it, build C2 inside `data`, turned on by size or an explicit setting, with row views where they pay, and C4 on top if servers need more than about 2e6 to 5e6 small rows each.

**What the first build must fix now** (each is small; together they keep C2 and C4 additions):

1. **fero reads rows only through `data`.** A rule, not a new interface: every layer (L2's judge, L3's pictures, warm pictures, pages, scans, pins and served views, L4's `.value` and `get()`, L5's folds) reads rows through `data`'s handle and operators (`rowAt`, `each`, `get`). No fero code keeps `data`'s row objects in its own tables; the log-end overlay keeps records; warm pictures keep a `data` source or bytes. Nothing compares rows by identity (compare `version`) or dumps `data`'s objects. `memory` asks `data`'s store for its bytes a row. +0 to +1 builder rule *(reasoned)*.
2. **Snapshots name their format.** A local snapshot, a snapshot layer and a picture carry a format id and do not depend on the layout: never `v8.serialize` of a store. PA-1b's "V8's format" is read as per row values. Rows are the first format; column blocks may come later and load whole. 0 new rules: it is the format's choice *(reasoned)*.
3. **The row version is a column by slot inside `data`'s store** (LAYERS 3.2; `data`'s N7 tags each diff entry with it), read by key: never a field of the row handed out, never a separate `Map` (a heap entry a row, 29 to 37 B, E-56, with its own collection and rebuild). It is owed anyway (LAYERS 3.2). 0 new rules *(reasoned)*.
4. **A `data` 5 rule: operators keep keys and projected values, never rows**, and read a row through `rowAt(key)` or a named field through a field read. Today 4 of 35 classes break it always (`FilterNode`, `MapNode`, `BucketNode` in group mode, `ToValueNode`) and 3 when the projection is the whole row (`DistinctNode`, `TrackedScalarNode`, `ProjectionAggregate`) *(checked: read)*. Full passes go through `each` or a key iterator (N9), never a new `snapshot()` caller on a hot path. `data` 5's new pieces follow it: D3's two-level stores, D4's sinks, D8a's freeze, D8c's index, N5's reverse index, N7's version tag. One new item for LAYERS 3.7 *(reasoned)*.
5. **The read promise worded so a row may be made on read.** A row read is "a frozen value, new at each write" (API.md line 621). Whether two reads of an unchanged row are `===`, and whether the owed re-read pin binds a compact source, is question 4 *(reasoned)*.
6. **`data` 5's key index in small tables.** Each source's keys in many small `Map`s chosen by slot block (or by the key's hash), not one. 64 tables kept every rebuild under 20 ms at 16.8e6 keys, where one `Map` stalled 631 to 688 ms at 8.4e6 and stopped at 16,777,216 *(measured, E-66 review)*. It does not remove the collection of the key strings, which stays on the heap: stalls with a collection in them came up to 205 ms with 64 tables and up to 514 ms with one `Map` *(measured)*. It lifts the cap `data` 5 owes (V5-20) and helps C0 today. The cost is memory at some sizes: 1,522 to 1,564 MB of heap against 893 MB for one `Map`, at a size where the 64 tables had just doubled *(measured; the reason reasoned)*. 0 new rules: it is inside `data`'s store *(reasoned)*.

**Is deferring safe once these exist?** Yes, with the evidence above: the only ways in and out of rows are then records (the fold, checked: read), `data`'s own reads (fix 1), and snapshots of a named format (fix 2); `data`'s layout is already behind one store (`store.ts`, checked: read); 15 of its 35 node classes never keep row objects, 14 keep them only as a whole-row projection, and 6 always do (4 that declare it, 2 that inherit it) *(counted, with subclasses)*. What deferral does not remove is the cost of the compact store itself (section 3); that cost is the same whenever it is built. What would make it a rewrite or a broken promise is a fix skipped: rows 3, 7, 9, 10, 11, 14, 15, 16 and 17 of the map become rewrites, and rows 6 and 18 broken promises, so 11 of the 18 rows rest on the six fixes (rows 2, 8 and 13 follow from rows 3 and 15) *(counted from section 2)*.

---

## 6. What it changes in the records (amended, never deleted)

Nothing here is edited yet; these are the amendments the owner's answers would make.

- **V5-20 item 9**: answered: no compact store in the first build; the first build makes the six fixes of section 5; a later compact store sits inside `data`, turned on by size or an explicit setting.
- **EVERYROW question 9**: its "when" stands (later, when a deployment asks); its "where and what" (a compact hold with sync reads and the merge classes only, C1's form in fero; EVERYROW lines 117 and 227) is superseded by C2 inside `data`. **E-65 X1's verdict 5** ("do not build compact rows for the first build"): unchanged.
- **E-65's README** (its line 34) gives the column store 296 to 300 B of RSS a row; X1's own table gives 298 B, and 296 to 300 B is `data`'s live heap a row there. This page uses 298 B.
- **LAYERS 3.2** (the row version, line 525): "beside the rows" becomes "a column by slot in `data`'s store". **LAYERS 1.2** (the local snapshot, line 233): a snapshot names its format. **LAYERS 9.2** (PA-1b, line 1664): V8's format per row value only, never a dump of a store.
- **LAYERS 3.7** (`data` 5.0.0): two new items: operators keep keys, not rows (4 classes always, 3 when the projection is the row); each source's key index in small tables (fix 6), which is how the owed lifted cap is met. D4 and D8a note that a later compact backing makes rows for sinks and needs O1's cache to freeze once.
- **LAYERS 4.2** (warm pictures, line 709): they keep a `data` source or bytes, not row objects.
- **API.md 3.9** (`.value`): the wording of question 4, and the owed re-read pin scoped to what question 4 picks. **API.md 9** (`memory`): the open asks `data`'s store for its bytes a row.
- **P-20**: no change. Its `schema` is what a compact backing may read for field types; no new name is reserved.

---

## 7. Questions for the owner, one at a time, most important first

1. **A compact store in the first build?** Pick: no; the first build makes the six fixes of section 5 instead (about +1 to +2 rules). Other way: build C1 for `hold: 'all'` now (+9 to +15 builder, +1 to +2 user rules).
2. **`data` 5's key index in small tables (fix 6)?** Pick: yes, as `data` 5's first storage piece: 64 tables kept every rebuild under 20 ms and passed 16,777,216 keys, where one `Map` stalled 249 to 304 ms at 4.2e6 keys and 631 to 688 ms at 8.4e6, then stopped *(measured)*; it helps today's layout and meets the owed lifted cap. Other way: keep one `Map` a source and lift the cap only with sources by block (E-65 X1), which leaves each source's rebuild in one step.
3. **Where should a compact store sit when it comes?** Pick: inside `data`, as a second backing turned on by size or an explicit setting (C2, with row views where they pay), so every operator still runs. Other way: a store of fero's own for big holds (C1), with only the views that merge.
4. **Two reads of an unchanged row: the same object?** Today they are, the first read freezes the row once (D8a), and API.md owes a pin: a re-read within twice a `Map` read. A row made on read gives all three up: a re-read costs 1.9 to 2.9 times `data`'s read at 1e6 rows and 3 to 6 times at 1e4 *(measured)*. Pick: no `===` promise; a row is a frozen value, new at each write, and code that compares rows compares `version`; the owed pin binds `data`'s object rows, and a later compact backing keeps it with O1's per-slot cache of made rows. Other ways: promise `===` now, which binds a compact backing to O1 for every row it hands out; or drop the owed pin for compact sources, and say so in API.md.
5. **The `data` 5 rule that operators keep keys, not rows?** Pick: yes, in data 5.0.0 (4 classes change, and 3 keep a key where they kept a whole-row projection). Other way: leave it to the day a compact backing comes, and change them then.
6. **Servers' own rows compact (C4), later?** Pick: only when a leader must hold more than about 2e6 to 5e6 small rows: the health warning (0.5 s) comes near 1.9e6 to 2.7e6 and F-06's 1 s near 3.7e6 to 5.3e6 *(reasoned, linear from E-65)*; until then, more servers each holding fewer groups. Other way: plan C4 into `data` 5.
7. **How would a compact backing turn on?** Pick: by size, past a line, or by an explicit setting; it reads field types from P-20's `schema` and needs no new name. Other way: whenever a resource declares a `schema`. That is simpler, but a small resource would then miss P-01's 100 ns (a made, frozen row costs 199 to 251 ns at 1e4 rows, *measured*) and the owed pin.

---

## 8. What the review changed

A review checked this page against its sources and ran one probe. Its findings held except where noted; the E-66 review probes (`rowmake`, `keyindex`) settled the numbers.

- **The key index** (new row 15, fix 6, question 2). The first version said keys can stay in one JavaScript `Map`. One `Map` rebuilds in one step (631 to 688 ms at 8.4e6 keys) and stops at 16,777,216 *(measured)*. The review also said X1's typed index grows without such a stall; it does not as built: it doubles in one step too, and grown from empty it stalled 2.7 to 3.1 s *(measured; checked: read)*.
- **A made row** costs 936 to 1,082 ns at 1e6 rows when written for the fixed shape, not 2,685 to 2,709 (that was X1's generic code). The text field is a third to a half of it *(measured)*. Section 0 item 5, rows 6 and 7, C3 and the table changed.
- **The owed pin, the freeze-once rule and P-01** (row 6, row 18, question 4): a made row misses all three, and at 1e4 rows it misses P-01's 100 ns. So the layout turns on by size or an explicit setting, not by declaring a shape (question 7), and O1 is named.
- **No new word `shape`.** API.md already uses `shape` for upcasters and `schema` for the runtime check. The old question 6 asked for the word; it is gone.
- **The count.** 4 classes always keep rows, not 3 (`ToValueNode` was missed), and 3 more keep the whole row as a projection. The probe now also matches state of `unknown` values and follows `extends`, and the quick gate pins the new answer *(checked: read; counted)*.
- **New map rows**: `snapshot()` and whole-value reads (16), warm pictures (17), sinks and the freeze (18); C4 adds the views' key maps.
- **Fix 1** is a rule, not a door with seven calls (the door only hedged C1). **Fix 2** asks for a named format, not "row by row". **Fix 3** says a column by slot in `data`'s store.
- **Smaller fixes.** C2's read uses keys in a `Map`, as its pause does. Question 6's line now gives both the 0.5 s warning and F-06. EVERYROW question 9's "where" is superseded, not unchanged. The column store's RSS is X1's 298 B. The "5 to 10 GB" and "2 µs budget" figures are gone. The row view, kept so it must exist, costs what it cost before (289 to 331 ns), so V8 was not dropping it. Every made form now also checks against `data`'s own rows (55,000 fields, 0 differ).
- **What did not hold, in part.** The heap-limit note: SC-10's 2.05 GiB is that box's default; this box's is 8.05 GiB *(checked)*, so the 7e6-row line moves with the machine.
