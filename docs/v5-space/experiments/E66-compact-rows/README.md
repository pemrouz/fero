# E-66: a compact row store, and what must be fixed now to add one later

**Question.** V5-20 item 9 asked whether fero wants a compact row store (rows kept outside V8's graph of objects, as columns or bytes), and where it would sit: inside `data` 5, or as a store of fero's own. It asked now, because adding one late could force a rewrite of the layers below. [E-65](../E65-every-row/README.md)'s X1 had already timed a column store and an arena: about 0.4 times `data`'s RSS, pauses of 5 to 14 ms against 0.9 to 1.3 s at 5e6 rows, and none of `data`'s operators. This experiment adds only what E-65 lacked: what one read costs in each form, what making a row costs, whether keeping the keys in a JavaScript `Map` keeps the pause, what the key index itself costs as it grows, and how much of `data`'s engine reads rows as objects. The design page is [COMPACT.md](../../COMPACT.md). A review checked the first version; the last section says what it changed.

## The answer first

- **Do not build it in the first build; make six fixes instead** (COMPACT.md section 5). Then a compact store is an addition inside `data`, not a rewrite *(reasoned, from the map)*. Decided as V5-21, with a compact backing turned on only by an explicit setting, not by size (its item 7).
- **The key index binds first.** One `Map` rebuilds in one step when it fills: 59 to 84 ms at 1.05e6 keys, 249 to 304 ms at 4.2e6, 631 to 688 ms at 8.4e6; it stops at 16,777,216. 64 small `Map`s kept every rebuild under 20 ms and passed that line *(measured)*.
- **A row made for the fixed shape costs about twice `data`'s read at 1e6 rows**: 936 to 1,082 ns frozen, against 455 to 497. At 1e4 rows 199 to 251 ns against 42 to 65, so three to six times, and over P-01's 100 ns *(measured)*. The text field is a third to a half of it. E-65 X1's generic `get` costs 2,685 to 2,809 ns.
- **A row view that copies nothing costs about what `data` costs**: one field 267 to 365 ns at 1e6, 77 to 88 at 1e4; kept, so the object must exist, 289 to 331 at 1e6 *(measured)*.
- **Keys in a `Map` keep the collection short**: one forced full collection 157 to 334 ms at 5e6 rows with the fields in columns, against 943 to 1,335 ms for the same rows in `data` (E-65) *(measured)*. But not the rebuild, nor the stop at 16,777,216.
- **Inside `data`, 4 of 35 node classes always keep row objects** (`FilterNode`, `MapNode`, `BucketNode` in group mode, `ToValueNode`; 6 with `FilterNode`'s two subclasses), and 3 more keep the whole row as a projection when no field or function is named (`DistinctNode`, `TrackedScalarNode`, `ProjectionAggregate`) *(checked: read)*. 23 calls fetch a row by key; 35 call the app's own function; 56 walk a whole parent; 10 classes name one field *(counted, approximate)*.

## The probes

| Probe | What it does | Mark |
|---|---|---|
| [probes/rowread.mjs](probes/rowread.mjs) | 1e6 rows of E-65's eight-field row. Reads by key, the same 262,144 random keys for every form: `data`'s row (`node.get`, the path an operator's `rowAt` takes); X1's column store making a new object; a row view object with a getter per field; a Proxy; no object (the field from its column). The view and the no-object reads also run with the key found through a JavaScript `Map` (`-map`). Three reads: one field, all eight fields, two rows compared | measured; the column forms agree with the column store's own row (checked) |
| [probes/keymap-gc.mjs](probes/keymap-gc.mjs) | 1e6 and 5e6 rows in columns, keys in a `Map` (`map`) or in X1's typed-array index (`ix`); and the `Map` of keys alone (`keys`). Three forced full collections in a row | measured |
| [probes/rowmake.mjs](probes/rowmake.mjs) (review) | 1e6 and 1e4 rows. A row made by code written for the fixed shape (one object literal; the text by Buffer's `utf8Slice`): plain, frozen, without its text field, and frozen with the key found through a `Map`; X1's `get`; the row view, through X1's index and through a `Map`; `data`'s row. Three reads: one field, all eight, and `keep` (the row stored in a ring, so it must exist). `--form=check` compares every form with `data`'s own rows | measured; checked against `data` |
| [probes/keyindex.mjs](probes/keyindex.mjs) (review) | Grows a key index from empty to 16,777,217 keys and times every insert: one `Map` (as `data`'s `keySlot`), 64 `Map`s chosen by the key's hash, or X1's typed index. A stall is an insert of 1 ms or more; stalls with a collection in them are told apart by a `gc` observer | measured |
| [probes/ops-count.mjs](probes/ops-count.mjs) | `data`'s `ops/*.ts` and `kernel/node.ts`, class by class: state that keeps rows (typed as rows), state of `unknown` values that may keep a whole-row projection, what a class inherits through `extends`, `rowAt` calls, reads of a change's `row` or `prev`, calls of an app function, a named field, full passes | counted; the classes that keep rows read by hand |

## Results

Marks: *(measured)* three runs, each process alone on the box under the timing lock, a range of the runs' medians; *(counted)* from the source; *(checked)* a probe compared it. Node 22.22.0, 4 CPUs, `data` at 63fea66.

| What | Result | Mark |
|---|---|---|
| One field of a random held row, 1e6 rows | `data` 396 to 518 ns; row view 267 to 365; Proxy 350 to 434; no object 309 to 346; X1's made row 2,685 to 2,809 | measured (rowread, rowmake) |
| All eight fields, 1e6 rows | `data` 1,325 to 1,565 ns; row view 2,693 to 3,038; Proxy 2,644 to 3,108; no object 2,024 to 2,128; X1's made row 3,016 to 3,211; a frozen row of the fixed shape 1,239 to 1,408 | measured |
| Two rows compared (one step of a bisect), 1e6 rows | `data` 536 to 643 ns; row view 475 to 518; Proxy 513 to 637; no object 519 to 557; X1's made rows 3,328 to 3,380 | measured |
| The key found through a `Map`, 1e6 rows | one field: row view 520 to 614 ns, no object 546 to 588; two rows: row view 798 to 895, no object 568 to 833 | measured |
| A row of the fixed shape, 1e6 rows (one field; kept) | plain 804 to 873 / 848 to 890 ns; frozen 936 to 977 / 966 to 1,082; no text field 377 to 512 / 480 to 526; frozen, key through a `Map` 1,160 to 1,234 / 1,199 to 1,306; `data` 455 to 491 / 456 to 497 | measured (rowmake) |
| The same at 1e4 rows (one field; kept) | frozen 199 to 220 / 216 to 251 ns; frozen through a `Map` 200 to 264 / 187 to 262; row view 77 to 82 / 81 to 88; row view through a `Map` 71 to 86 / 73 to 83; `data` 59 to 65 / 42 to 57 | measured (rowmake) |
| The forms agree | rowread: 8,000 fields a run against the column store's own row, 0 differ. rowmake: 55,000 fields at 1e6 rows against `data`'s own rows, 0 differ | checked |
| One forced full collection: fields in columns, keys in a `Map` | 1e6 rows 36 to 51 ms; 5e6 rows 157 to 334 ms; RSS 257 to 271 / 1,024 to 1,081 MB | measured |
| The same, keys in X1's typed index (sized at the start) | 1e6 rows 9.1 to 12.9 ms; 5e6 rows 7.5 to 12.2 ms; RSS 206 / 631 to 632 MB | measured |
| The `Map` of keys alone | 1e6 rows 31 to 43 ms; 5e6 rows 176 to 280 ms; heap 55 / 343 MB | measured |
| Rows in one `data` source, for comparison | 1e6 rows 203 to 260 ms; 5e6 rows 943 to 1,335 ms | measured, E-65 `forced-gc` |
| RSS a row that a key `Map` adds | 51 to 90 B (`map` less `ix`) | measured, arithmetic |
| One `Map` grown from empty | a rebuild stall at each doubling: 59 to 84 ms at 1,048,576 keys, 123 to 149 at 2,097,152, 249 to 304 at 4,194,304, 631 to 688 at 8,388,608; stopped with "Map maximum size exceeded" at 16,777,216 in every run; heap 893 to 894 MB | measured (keyindex) |
| 64 `Map`s grown from empty | longest stall with no collection in it 15 to 20 ms; passed 16,777,216; heap 1,522 to 1,564 MB (the 64 tables had just doubled at this size) | measured (keyindex) |
| Stalls with a collection in them | one `Map` up to 46 to 514 ms; 64 `Map`s up to 11 to 205 ms (the key strings are on the heap either way) | measured (keyindex) |
| X1's typed index grown from empty | rebuild stalls of 22 to 23 ms at 524,288 keys with no collection; longer ones while its key bytes and arrays grew, with a collection inside: up to 2,742 to 3,103 ms at 8,527,496 keys | measured (keyindex); the cause read in `compact.mjs` (`grow`, `_kcompactOrGrow`, `_rehash`) |

The full ranges are in [results/summary.md](results/summary.md); each run's lines, with the box's load, in [results/rowread.jsonl](results/rowread.jsonl), [results/keymap-gc.jsonl](results/keymap-gc.jsonl), [results/rowmake.jsonl](results/rowmake.jsonl) and [results/keyindex.jsonl](results/keyindex.jsonl); the check in [results/rowmake-check.jsonl](results/rowmake-check.jsonl). The load at start was 0.2 to 1.4 on 4 CPUs.

**The count** *([results/ops-count.jsonl](results/ops-count.jsonl))*: 35 classes. Typed as keeping rows, declared and set: `FilterNode.view` (`ops/rowops.ts:16`), `MapNode.view` (`ops/rowops.ts:189`, the mapped rows), `BucketNode.members` and `skOf` (`ops/bucket.ts:114`, `:130`). State of `unknown` values, read by hand: `ToValueNode.mirror` (`ops/misc.ts:672-686`) keeps every parent row, always; `DistinctNode.projOf` and `view` (`misc.ts:443-460`), `TrackedScalarNode.tracked` (`misc.ts:36-56`) and `ProjectionAggregate.tracked` (`ops/aggregate.ts:52-72`) keep the row itself when no function or field is named *(checked: read)*. With subclasses through `extends`: 5 classes inherit or declare typed row state (`FilterNode`'s subclasses `RescopeFilterNode` and `CompareRNode`), and 15 the `unknown` kind *(counted)*. So 6 classes always keep rows, 14 only as a whole-row projection, 15 never. `OrderedView` declares a `rows` map (`ops/ordered.ts:153`) but never sets it: since `data`'s M6 work its comparator reads rows from the parent (`ops/ordered.ts:186-210`). `rowAt` calls 23; `row` or `prev` reads 54; app-function calls 35; classes that name a field 10; full passes (`each(` or `snapshot()`) 56 *(counted, approximate)*.

## What the numbers say

- **Reading one field by key is ruled by cache misses, not by the layout.** At 1e6 random rows, a row view's one-field read (267 to 365 ns) is no dearer than `data`'s (396 to 518 ns), and the bare column read (309 to 346 ns) is no cheaper than the view *(measured)*. Kept in a ring, so V8 cannot drop it, the view costs the same (289 to 331 ns) *(measured)*.
- **Making a whole row costs about twice `data`'s read at 1e6 rows, written for the fixed shape** (936 to 1,082 ns frozen), and three to six times at 1e4 rows *(measured)*. X1's generic `get`, the first version's "made row", is 2.7 µs because it loops over field names and decodes text a byte at a time. The text field is a third to a half of a made row; without it a made row costs about `data`'s *(measured)*.
- **So a compact store is cheap for reads that do not keep the row** (a comparator, a projection, a judge, a fold's `emit`), and costs about twice for a row handed to app code, which must be made and frozen (API.md: a row you took never changes). At small sizes a made row misses P-01's 100 ns, so the layout should turn on by size *(reasoned from the measured)*.
- **A key `Map` costs a little in reads and a little in collections, and a lot in its rebuild.** The `Map` lookup adds about 200 to 300 ns to a one-field read over X1's typed index, and the keys alone pause 176 to 280 ms in a full collection at 5e6 *(measured)*. But a single `Map` rebuilds in one step, 0.25 to 0.3 s at 4.2e6 keys and 0.63 to 0.69 s at 8.4e6, and stops at 16,777,216 *(measured)*. Small tables fix both.
- **X1's typed index is not a stepped index as built.** It doubles its table and grows its key bytes in one step each; it was sized at the start in E-65 and here, which hid this *(measured; checked: read)*.

## Limits

- One machine, one row shape (eight fields, about 100 B as JSON, one text field). Rows with more text fields would make made rows and all-field reads dearer.
- Reads only. Writes into columns, and the made `prev` a change in `data` would carry, were not timed; E-65 X1 timed the column store's fold with its own views (0.15 to 0.20 M writes a second).
- The row view reads live columns; nothing here checks it against a row that changes while held (COMPACT.md 3, C3, says why it must not be handed to app code).
- The key index probe inserts only, with fresh keys `'k' + i`; deletes and their tombstones were not timed. A stall with a collection in it is counted apart, so a rebuild that set off a collection lands there (X1's long stalls do).
- The count is a pattern count. The classes that keep rows, and `OrderedView`'s unused field, were read by hand; the other columns are approximate: a class's body runs to the next class, so free functions after it count for it.
- `data`'s own column backing does not exist; C2's costs are reasoned from the count and E-65.

## How to run

```sh
./run.sh quick     # small sizes, nothing written to results/; ends "E-66 quick: ok"
./run.sh full      # the count, three timed runs of rowread and keymap-gc, then the review's probes (about 30 minutes)
./run.sh review    # only the review's probes: the check, then three timed runs of rowmake and keyindex
./run.sh summary   # results/summary.md from the files already there
```

`SP` names a scratch folder of your own holding `bin/timing` (runs a command alone on the box) and `bin/heavy`; without them the locks are skipped. `DATA` is `data`'s folder, by default `../data` next to this repo, read only. The probes import E-65 X1's column store and helpers from `../E65-every-row/X1/src/`. Every process stays under 4 GB (`--max-old-space-size=3000`).

## What the review changed

A review of the first version found that the key index was missing, that the made-row cost came from X1's generic code, that one class keeping rows (`ToValueNode`) and three keeping a whole-row projection were missed, and that the forms were never compared with `data`'s own rows. Two probes were added (`rowmake`, `keyindex`), the count was widened and its quick gate pinned again, and every number above was rerun three times where it changed. The review's claim that X1's typed index grows without a one-step rebuild did not hold: grown from empty, it stalled longer than one `Map` *(measured)*. COMPACT.md section 8 lists the changes to the design page.
