# Facts brief: lenses, connect, flow, versions and exactly once

Written 2026-11-17 for three API designers. It answers the owner's feedback on fero v5's API (docs/v5-space/API.md, API-TOUR.md). **Facts only. No design.**

## How to read this

**Marks.** Every claim carries one:
- **code** `repo:file:line`. Repos: `fero:` is this repo (the v4 code is api/, kernel/, shell/); `data:` is the sibling data repo (`../data`) at commit 63fea66 (`SCHEDULE_VERSION` 4); `v2:` is fero's git branch `origin/master` (fero 1.7.0, commit 1f3df9a), read with `git show origin/master:<file>`.
- **docs** `file:line` or a section, in fero's docs/ unless named. `API` is docs/v5-space/API.md, `TOUR` is API-TOUR.md, `LAYERS`, `PATHS`, `SIMPLICITY`, `VERDICT` are the pages of the same name in docs/v5-space/, `DV5` is docs/DESIGN-V5.md, `DEC` is docs/DECISIONS.md.
- **E-nn**: an experiment under docs/v5-space/experiments/ (its README).
- **measured here**: run for this brief. The script is named; scripts and raw lines are in ./bench/ (section 9).
- **reasoned**: an argument from the cited code or docs; nothing ran it.
- **from memory**: an outside fact nobody checked here. developer.mozilla.org could not be reached from the study box (its host is not in the box's allowed network), so no web page was fetched.

**Machine for "measured here".** 4 shared vCPUs (Intel Xeon 2.10 GHz, a Firecracker VM), 15 GB. **Node v22.22.0** for every run; Node 26 was not used. Timed runs went through the study's `timing` lock. The scratch tree is E-50's (`fero 817a756` api/kernel/shell/utils copied, `data 63fea66` beside it).

**Words used here.**
- **handle**: data's value from `$(obj)`: a JavaScript `Proxy` over a node of data's graph.
- **lens**: fero v4's own `Proxy` over a data handle that turns `f.data.k = v` into a write record (fero:api/substrate.ts:262-272).
- **view**: a live result of an operator (`filter`, `top`, `sum`...), kept up to date as rows change.
- **sink**: a callback that receives each commit's changes.
- **anchor**: the first argument of data's `connect(anchor, fn)`.
- **row**: one top-level key of a data source and its value. **partition**: rows kept in one order. **fold**: applying change records to rows.
- **record**: one change. fero's record (a **Rec**) is `{ type: 0|1|2, key: [rowKey, ...fieldPath], value, at? }` (fero:kernel/env.ts:206-217; data:seam/index.ts:330-337).
- **SUB**: v5's one subscribe verb (LAYERS:518). In v4, SUB is a method subscription (fero:kernel/codec.ts:69-72).

**The owner's questions, and where the facts are.**

| Question | Sections |
|---|---|
| prefix/suffix keys with `{ before }`, against nesting `[prefix][suffix]` with the row as the default partition | 1.9, 1.10, 3.1, 4.8, 8 |
| whether fero is exactly once, like Kafka | 6 |
| does `typeof shop` pull the server into the client | 4.12 |
| changes, reversing records, versions, persistent data structures | 1.6, 1.11, 4.2, 5 |
| `resource.a.b.c.connect()`, weak references, server-side against local transforms, `shop.data.set`, no `follow` | 1.1 to 1.8, 2, 4.1, 4.4, 4.7 |
| what `tap`'s argument is | 1.5, 4.3 |
| why `derive` is its own function | 3.2, 4.5, 6.3 |

---

## 1. data today

### 1.1 The handle and what one path step costs

- **`$(value)` returns a `Proxy`.** It is not callable and not thenable (code: data:api/index.ts:1-6). One handler object serves every handle (data:api/index.ts:473-478, 519-590). A handle is a target object plus a `Proxy` (data:api/index.ts:586-590).
- **A property read is a path step.** `h.k` and `h.get('k')` both return a child handle: a path address, not a value (data:api/index.ts:259-260, 552, 592-602). A child of a source carries `{ source, path }` (data:api/index.ts:105-127).
- **data caches every child handle on its parent, by name, for the parent's whole life** (code: data:api/index.ts:592-602; caches are lazy, data:api/index.ts:77-85). So a second read of `h.k` allocates nothing in data.
  - **Memory per distinct key read (measured here, mem-step2.mjs, 100,000 rows):** 318 B per key read one step deep (`q.get(k)[value]`); 990 B per key read two steps deep (`q[k].n[value]`). At 1,000,000 rows the method gave negative numbers (the collector's timing swamped it), so it is not settled there; at 1,000 rows it was not run.
  - Nothing ever drops a cached child while its parent lives (code: data:api/index.ts:592-602 has no eviction).
- **A value read is `[value]`** (data:api/index.ts:522). Under a source it is one `src.get(rowKey)`, then a walk down the field path (data:api/index.ts:93-103). At the root it builds a fresh container of every row (data:api/index.ts:96-97; data:compat/v2-records.ts:137-143).
- **Writes are methods only.** Bare assignment and `delete` throw with guidance (data:api/index.ts:554-563). The write methods are `update`, `set`, `insert`, `remove`, `patch` (data:api/index.ts:245-248, 277-324).
- **Operators are only at the root of a view.** `h.k.filter(…)` on a child path throws: "child handles are addresses, not views" (data:api/index.ts:543-548).
- **Operators dedup by value.** A call with the same declarative arguments returns the same view object; closures never dedup (data:api/index.ts:480-517; data:ops/registry.ts:14-18; data:ops/rowops.ts:291-314; test data:api/api.test.ts:106-110).

**What one path step costs (measured here, path-step.mjs; each number is ns per read, median of 5 rounds).** "spread" reads a key spread over all rows; "same" reads one key again and again.

| Rows | fero lens, 1 step, spread | fero lens, 1 step, same | fero lens, 2 steps, same | data handle, 1 step, spread | data handle, 1 step, same | data handle, 2 steps, same | `Map.get`, spread |
|---|---|---|---|---|---|---|---|
| 1,000 | 470 | 260 | 548 | 210 | 123 | 216 | 32 |
| 100,000 | 3,091 | 397 | 822 | 3,207 | 133 | 216 | 267 |
| 1,000,000 | 4,461 | 547 | 1,061 | 4,362 | 129 | 245 | 660 |

(The "spread" columns include building the key index, 16-101 ns; see `idx.only` in path-step.jsonl.)

- **PA-31 checked.** PATHS says `f.data.x` costs 0.54-5.2 µs (PATHS:686; PA-31 at PATHS:1355). That number is the whole one-step read through fero's lens with keys spread over the rows. The rerun here agrees: 0.47 µs at 1,000 rows to 4.46 µs at 1,000,000.
- **What the number is made of** (measured here, by subtraction):
  - fero's lens adds 137, 264 and 419 ns per step over data's own cached step (at 1e3, 1e5, 1e6 rows).
  - data's own second step (a cached child) costs 83-117 ns.
  - The rest of the large-size cost is memory misses. data's handle pays them too (3.2-4.4 µs spread, 0.13 µs same), and a plain `Map` pays part of them (0.27-0.66 µs spread).
- **PA-31's wording "a child handle and a `Proxy` per path step"** fits fero's lens: it makes a new `Proxy` and a new path array on every step and caches neither (code: fero:api/substrate.ts:393-394, 331). It does not fit data's handle, which caches its children (above).

### 1.2 The ways to subscribe

All forms are in data:api/index.ts:325-378 (root views) and 173-224 (child paths).

| Form | What the callback gets | Where (code) |
|---|---|---|
| `connect(records[])` | v2-shaped records pushed into the array | data:api/index.ts:352-356 |
| `connect(anchor, fn, opts?)` | one v2-shaped record per call (a `ChangeRecordV2`) | data:api/index.ts:357-361 |
| `connect(anchor, prop)` | nothing: it sets `anchor[prop]` to the whole current value now and after every commit | data:api/index.ts:362-374 |
| `connect(fn)` | throws: "not a valid sink" | data:api/index.ts:375-377 |
| `sink({ apply, init?, wantsOrder?, origin? })` | the native `CommitBatch`, by reference, no copy; root views only | data:api/index.ts:436-468 |
| `wireSink(target, out, opts?)` | `WireBatch`es, in application order (removes, moves, adds, updates) | data:seam/index.ts:584-; data:CLAUDE.md "Gotchas" |

- **Every attach is snapshot-then-deltas.** All of them go through `attachSettled` (data:kernel/node.ts:172-197). The record forms send an opening `{ type: 'update', key: [], value: <whole current value> }` record (data:api/index.ts:185; data:ops/misc.ts:629-631).
- **On a child path** (`h.a.b.connect(…)`) the same three forms run `connectPath` (data:api/index.ts:329-345). It subscribes the **root source** and checks every row delta of every commit against its row key (data:api/index.ts:186-191). Records come out relative to the subtree (data:api/index.ts:203-219). Options: `origin`, `clone` (default true: a `structuredClone` per value, data:api/index.ts:181), `initial` (default true).
  - **So each path subscription costs work per commit in proportion to the commit's row deltas, whether or not they touch its path** (reasoned from data:api/index.ts:189-191).
- **The options** `{ origin, clone, initial }` (data:types/public.d.ts:110-114, `SinkOpts`). `clone: false` hands values by reference (safe by the path-copy law: data:contract/SCHEDULE.md:96-97).

**What a subscription adds per change (measured here, tap-cost.mjs; 10,000 small rows; each write is `s.get(k).get('n').update(v)`; ns per write, median of 5 rounds of 200,000 writes):**

| Attached | ns per write | Added per change |
|---|---|---|
| nothing | 2,054 | — |
| `tap(() => …)` (no parameter) | 2,051 | about 0 |
| `sink({ apply })` | 1,877 | about 0 (noise) |
| `connect(anchor, fn, { clone: false })` | 2,564 | about 0.5 µs |
| `connect(anchor, fn)` (clones) | 3,409 | about 1.4 µs |
| `tap((rec) => …)` (a parameter: a cloned record) | 3,741 | about 1.7 µs |

- data's own perf gate measures the native sink: **0.0173 µs per extra by-reference sink per commit** (measured here: data `perf/m4-budgets.ts` section B3, 33 sinks against 1).

### 1.3 Snapshot-then-deltas and the other SCHEDULE clauses

data:contract/SCHEDULE.md (VERSION 4; data:contract/index.ts:21):
- **Clause 7 (lines 39-47).** A sink connected between commits gets `init(snapshot)` of settled state, then every later commit once, in order. No gap, no overlap. An attach inside an open `batch()` waits for that batch's commit.
- **Clause 4 (lines 29-31).** Effects (taps, connect callbacks, DOM sinks) run after all operator state settles, in graph order, each isolated. Their throws collect into one `AggregateError`.
- **Clause 5 (32-33).** A write made inside an effect runs as the next commit.
- **Clause 6 (34-38).** Every batch carries an `origin` token. A sink can declare its origin and be skipped for its own writes, at one compare per sink (data:kernel/runtime.ts:303-316).
- **Clause 8 (48-52).** At most one row delta per key per batch; no `update` whose leaf did not change.
- **Clause 10 (56-81).** Deep paths: field removal is first-class; removes are idempotent; a deep write to a missing row throws ("a deep write cannot invent a row"); one bad record in an `ingest` never stops the others.
- **Clause 11 (82-97).** The value domain a codec must keep. By-reference surfaces share immutable references.
- data keeps no history: "the engine itself only moves forward" (data:contract/index.ts:90-93).

### 1.4 Lifetimes: scopes, the WeakRef registry, and what an anchor does

- **The rule in data's kernel:** "Scopes are the lifecycle semantics; GC timing can never change observable results (WeakRef survives only as a dev-mode leak detector, elsewhere)" (data:kernel/scope.ts:1-3).
- **References are strong and point down.** Parents hold children; scopes hold nodes (data:kernel/node.ts:1-7). A node's `children` and `effects` are plain arrays (data:kernel/node.ts:45-48). A view is pushed into each parent's `children` when made (data:kernel/node.ts:69-71). A sink is pushed into `effects` (data:kernel/node.ts:142-145).
- **So a view or a sink lives as long as its source, until someone disposes it** (reasoned from the lines above). Dropping the program's last reference does not stop it. fero v4 hit this: "100 such calls left 100 dead filters" (DEC:2763, V4-54).
- **Scopes.** A node or a subscription made while a scope is current is added to it (data:kernel/node.ts:73-74, 153, 195). `scope.dispose()` tears its subtree down at once, and finishes even when a cleanup throws (data:kernel/scope.ts:47-76). `onCleanup` throws outside a scope (data:kernel/scope.ts:104-118).
- **The WeakRef registry** is a `Set<WeakRef<DataNode>>` in the runtime (data:kernel/runtime.ts:39, 93-95). Only `graph()` reads it, for devtools (data:kernel/runtime.ts:97-111; data:devtools/panel/inspector.ts:109). It never ends a subscription.
- **The anchor is ignored.** `connect(anchor, fn)` checks that `anchor` is an object, then builds the sink from `fn` alone (code: data:api/index.ts:357-361). The comment where v2's form was replaced: "the v2 WeakRef-drop idiom is replaced by an explicit handle" (data:compat/v2-records.ts:145-147). fero v4 says the same: "the v3 anchor/WeakRef pinning contract is gone" (fero:api/substrate.ts:197-202; also 16-18).
- **Measured here (anchor-life.mjs):**
  - A callback that closes over its anchor keeps the anchor alive for good (the source's `effects` array holds the closure), and keeps firing.
  - A callback that does not touch its anchor lets the anchor be collected, and **the subscription still fires after the anchor is gone**.
- **What a GC-tied lifetime would need** (reasoned): the callback must not hold the anchor strongly, or the source keeps the anchor alive through `effects`; and something must notice the anchor's collection (a `FinalizationRegistry` or polling a `WeakRef`).
- **Outside facts (from memory).** `FinalizationRegistry` callbacks run some time after a collection, are not promised to run at all, and the JavaScript standard asks programs not to depend on them for correctness. A DOM node removed from the document is collected only once nothing in JavaScript reaches it.

### 1.5 `tap`

- **Declared** as `tap(fn: ((change: ChangeRecordV2) => void) | (() => void)): ReadonlyData<T>` on data's `Ops<T>` (data:types/public.d.ts:277, 339).
- **data picks the mode from the function's source text** (`tapHasParam`: `fn.length`, then a regex on `Function.prototype.toString`) (data:ops/misc.ts:598-611).
  - **No parameter:** called once when the tap is made, then once per commit, with no argument and no allocation (data:ops/misc.ts:622-623, 632-634).
  - **A parameter:** one call per row delta, each with a v2-shaped record `{ type, key, value, at? }` built by `V2RecordSink` and copied with `structuredClone`; the first call carries `{ type: 'update', key: [], value: <the whole current value> }` (data:ops/misc.ts:618-621, 628-631).
- **A tap never gets the latest copy as a second argument.** The only whole value it gets is that first record (code: data:ops/misc.ts:624-636).
- **A record has no prior value for an update.** `update` records carry the new leaf only; `remove` records carry the removed value as `value` (data:compat/v2-records.ts:106-127).
- **A tap is a view.** It passes its input through (data:ops/misc.ts:638-648), is never deduped (`dedupKey: () => null`, data:ops/misc.ts:857-861), and lives until disposed (1.4).
- Cost per change: section 1.2's table.

### 1.6 The delta algebra

data:contract/delta.ts (SCHEMA_VERSION 3):
- **Row deltas:** `add { key, row }`, `remove { key, prev }`, `update { key, row, prev, path, deleted? }` (lines 28-55). `prev` is "always present" on a remove (37). On an update, `row` and `prev` are references, "structurally shared" (43-44).
- **Order deltas** are a separate channel, for sinks that ask (`wantsOrder`) (57-65). **Scalar deltas** are `{ prev, next }` (67-71).
- **`CommitBatch { seq, origin, rows, order, scalar }`** (78-86); at most one row delta per key (81). Consolidation rules (97-105).
- **So the native batch can be reversed** (it carries `prev`); the v2 record (1.5) and fero's Rec cannot (reasoned from the shapes above).

### 1.7 Which operators work row by row, and which keep state

From the registry (data:ops/registry.ts:10-19; categories data:contract/index.ts:84-88; definitions in data:ops/*.ts):

| Kind | Operators | Work per change (reasoned from the kind; E-05 for the measured ones) |
|---|---|---|
| row, `rowop` | `filter`, `map`, `gt`/`lt`/`gte`/`lte`, `between`, `keys`, `values` | the changed rows only |
| set, `rowop` | `intersect`, `union`, `except` | the changed keys |
| ordered, `holistic` | `az`, `za`, `top`, `limit`, `reverse` | keeps an order |
| bucket | `group` (`aggregate-decomposable`), `lengthBuckets`, `distinct` (`holistic`) | keeps buckets; `group` rebuilds a touched bucket: O(rows in the bucket) (E-05 finding 6) |
| aggregate | `sum`, `avg`, `length`, `some`, `every` (decomposable); `max`, `min`, `reduce`, `quantile`, `percentile`, `median` (holistic) | keeps a running value |
| rebuild | `to` | an O(Δ) mirror for unordered parents (data:ops/misc.ts:651-667) |
| effect | `tap` | see 1.5 |

- **`declarative`** says whether the arguments are plain data, with no closure (data:ops/registry.ts:14; data:contract/index.ts:87). `filter`, `map`, `group`, `reduce`, `tap`, `to`, `some`, `every`, `distinct` are not; the compares, `between`, sort/top, set ops and `sum`/`avg`/`length`/`max`/`min`/quantiles are (data:ops/*.ts `defineOperator` lines).
- **E-05 costs.** One `group` view costs 1.0 µs a record at 1,000 rows, 173 µs at 100,000, 2,574 µs at 1,000,000 (batches of 256); 100 `filter` views cost 9.0 µs a record at 1e5 rows and 17.9 µs at 1e6, because each predicate runs on each change (E-05 "What the numbers say" 6).

### 1.8 The render layer

- **`render(host, ast)` makes one Scope per mount** and returns a handle whose `dispose()` ends every subscription, listener and row scope at once (data:render/index.ts:1002-1030; header 8-9).
- **Each binding's subscription is added to its scope** (data:render/index.ts:279-286, 329-334). A keyed list keeps one element per row key; a removed row's element and scope go at once (data:render/index.ts:10-16). Components get child scopes (55-63).
- **Nothing in render/ or jsx/ watches the DOM or the collector** (code: no `MutationObserver`, `isConnected`, `WeakRef` or `FinalizationRegistry` there; grep). A DOM node removed by other code keeps its subscriptions until its scope is disposed (reasoned).
- **JSX:** a handle as a child is reactive text; iteration is only `<For each={view}>` (data:jsx/index.ts:11-19).

### 1.9 Writes inside a row: the path-copy law

- **A write copies every object on its path** (data:kernel/node.ts:275-291; `shallowCopy` is `{ ...v }`, 199-201; SCHEDULE.md:16-19). Rows are never changed in place.
- **Measured here (nest-cost.mjs): one message written as a field of a room row, against one row per message.** 20 rooms; ns per write.

| Messages per room | room is a row, `room.m = msg` | a row per message, `'room/m' = msg` |
|---|---|---|
| 10 | 1,102 | 731 |
| 1,000 | 428,734 | 925 |
| 10,000 | 3,585,352 | 2,037 |

- So a field write costs in proportion to the number of fields beside it in the row (measured above; the copy is code: data:kernel/node.ts:277). Every copy and every following client folds the same write, so each pays it (reasoned from DATA-01, REQUIREMENTS:201).

### 1.10 DATA-07: rows handed out are immutable

- **The requirement:** "Rows handed out are immutable, so a read by reference cannot change what a node holds" (docs: v5-space/REQUIREMENTS.md:207).
- **data today freezes only on request.** `snapshot({ freeze: true })` deep-freezes each row once, remembered in a `WeakSet` (data:api/index.ts:152-162, 261-276). A plain `[value]` read returns the stored row unfrozen (data:api/index.ts:93-103).
- **The "lazy freeze" is v5's text, not code:** "The first read of a row after it was written also freezes it, once, deeply" (API:390; PA-8 at PATHS:1332 says "DATA-07 holds by the lazy freeze"). A row read through a `filter` view was not frozen in E-22's probe (API:1163).

### 1.11 The store, data's speed, and Rust

- **The store is mutable:** a `Map` from key to slot and a packed array of rows; removal leaves a tombstone; compaction runs later (data:kernel/store.ts:1-28). `snapshot()` copies every row reference into a new `Map`: O(rows) (data:kernel/store.ts:283-297). Rows are immutable values; the table is not persistent.
- **data's lane (its fast entry for fero records), measured here** (data `perf/m3-replication.ts`, 10,000 rows, one sink and one `filter→sum` chain): 0.685 µs a record in frames of 16 (best 0.579; gate ≤ 2.5), 2.129 µs one record per call, 0.573 µs in frames of 512. Retention 129-132 B a record (`perf/m4-budgets.ts` B1).
- **E-05:** the fold is 0.22-1.90 µs a record in batches of 256 up to 1e6 rows; 315-338 B of heap a small row; fero v4's codec decode (2.7 µs) costs more than the fold.
- **Rust.** LAYERS reads that at a native step L0 and L1 move to Rust and `data` stays JavaScript (LAYERS:64). E-03: handing a 256-record batch from Rust to data's JavaScript fold costs under 1 ns a record for the crossing; a call from Rust into a JavaScript function costs 107 ns inside a napi call and 3.8 µs from a Rust thread; Rust-built objects cost 888 ns a record against 712 ns for v4's JavaScript decode (E-03 Q-03). A user's `filter`/`map` function is JavaScript (reasoned), so a Rust data would call back into JavaScript per row for those operators.

---

## 2. fero v4

### 2.1 The lens: how assignment becomes a write

- **The seam.** fero imports one data entry, `../../data/api/index.ts` (fero:api/substrate.ts:27-29; fero:CLAUDE.md "The two seams").
- **The lens** is fero's `Proxy` over a data handle (fero:api/substrate.ts:309-423):
  - **Child access** reads data's child handle and wraps it in a new lens with a new path array, every time (393-394).
  - **`set` trap:** `f.data.a.b = v` becomes `sink([{ type: REC.update, key: [...path, 'b'], value: v }])` (396-401). `sink` is `Bind.issue` (262-268).
  - **`deleteProperty`:** a remove record, after a no-op filter and an array-hole refusal (402-412).
  - **Lens builtins:** `set(k, v)`, `update(v)`, `remove()`, `patch(pairs)` build the same records and call the same `sink` (339-361). `insert`, `ingest`, `raf`, `dispose` throw (365-380). `first`/`last` return lenses (381-389).
  - **Operators** go to data, with an "escaped" mark (392, 662-670).
  - **`then`:** awaiting a lens resolves its current value (323-327).
- **V4-7:** "the proxy changes only when a commit applies (no optimistic copy)" (fero:api/substrate.ts:267-268).
- **Cost of one write at the issuer in v4: 7.7-8.3 µs**, step by step in PATHS 2.6 (PATHS:279-305): the trap is 1.5 % of it; the value's deep copy, the pending row, a promise, the kernel stamp and the collector are most of it.

### 2.2 The method plane (api/methods.ts)

- **The dual handle:** `await methods.x(a)` is a one-shot CALL; any other touch opens a live SUB and hands back a local mirror (fero:api/methods.ts:731-798). `open()`, `close()`, `ready`, `mode` are reserved (770-783). Writes through it throw (787).
- **The host's stream:** for a SUB, the handler's returned view is streamed with `records(view, …, { clone: false })`. Each change is one `subOut` step, so one SUBREC frame per subscriber per record (fero:api/methods.ts:329-372). `move` records are skipped (fero:api/methods.ts:30-32, 350).
  - Cost (PATHS 4.5, "What v4's method plane does instead"): 4.4-4.6 µs to serve a small-row change per subscriber against 2.0-2.4 µs for one shared batch encode; 80 against 15 wire bytes per field change.
- **The client** folds SUBREC records into a local `$()` mirror with `applyStreamRec` (fero:api/substrate.ts:228-253). On a feeder change it subscribes again, and a fresh first picture replaces the mirror (fero:api/methods.ts:13-17).
- **A retried CALL runs the handler again;** calls are not deduped, only their writes are (fero:api/methods.ts:22-24).
- **`records()` uses a fresh `{}` as the anchor** (fero:api/substrate.ts:207-210).

### 2.3 V4-54: handler views released by the collector

DEC:2762-2773; code fero:api/substrate.ts:496-660.
- **Why:** "only JavaScript reachability tells a kept view from a dropped one, so fero asks the garbage collector" (DEC:2764). Releasing at the end of a call broke handlers that cache a view (V4-16).
- **How:** `ctx.data` is a scope over the surface; every view made through it comes back wrapped in a small `Proxy`. Each wrapper is registered with a `FinalizationRegistry`, with a count per view. When the last wrapper is collected, the view is disposed, unless it has a child view, a subscription, or module code can reach it ("escaped") (fero:api/substrate.ts:521-565). Only operators that data never dedups (`filter`, `map`, `reduce`, `group`, `tap`, `to`, `union`, `intersect`, `except`) can be released past an escaped parent (fero:api/substrate.ts:531-536).
- **Cost:** about 4 µs per view a handler makes; 1.05-1.10× for 1,000 views over 200 rows; 0.2-0.3 µs per operator call through the public lens for the escape mark (DEC:2769).
- **Consequences stated in the record:** release happens when the collector runs, not when the call ends; "a dropped view keeps being worked out on every commit until a GC finds it; a long-lived one may wait for a major GC"; tests must force the collector; some views are not tracked (DEC:2771).
- Two traps it pins: the wrapper's target must be an empty object (else a full view build per read, a 3.27× pin), and the subscription's dispose hook must be built outside the trap (else it keeps the wrapper alive) (DEC:2768).

### 2.4 Scoped reads and scoped replication

- **`api/fold.ts`, the gather.** On a scoped node a whole read asks every member for its stamped claims, merges them per cell by the last-writer order, parks keys in a handover, and drops a key only when every current holder attests it is gone (fero:api/fold.ts:1-38). The live form gathers again on a timer: 4× the heartbeat, at least 1 s (fero:api/fold.ts:37-38, 477).
  - Cost: O(members × cells) per read and per live tick (PATHS 4.4, the v4 table).
- **`kernel/scope.ts`:** a per-(node, partition) state machine, `held` / `acquiring` / `orphan`, with a one-teacher latch and possession evidence on HAVEQ/HAVEA (fero:kernel/scope.ts:1-36).

### 2.5 What v4 sends for a subscription

- **The verbs** (fero:kernel/codec.ts:64-82): `RECORDS`, `DIGEST` (replication and anti-entropy); `CALL`, `RESULT`, `SUB {id, m, a}`, `UNSUB {id}`, `SUBREC {id, recs}` (the method plane); `HAVEQ`, `HAVEA`, `ACQ`, `ACQDONE` (scoped replication).
- **A v4 SUB always names a method and an argument** (fero:kernel/codec.ts:69-72). There is no SUB by row, partition or prefix.
- **A bare `fero(name)` client gets the whole resource:** every record, by replication. On reconnect it "wipes its fold and asks with an empty digest; its suffix ship IS the re-download" (PATHS 4.6, citing fero:kernel/node.ts:1431-1454).
- **v4's partition is the row key** (`key[0]`, or `at` for a new row) (fero:kernel/env.ts:233-234). A Rec has no prior value (fero:kernel/env.ts:212-217).

---

## 3. fero v2 (origin/master)

### 3.1 Design

- **"The core data structure is an immutable append-only changelog… Data is dynamically sharded into partitions (top-level keys by default). Writes for a partition can only happen on one node, but reads from anywhere."** Partition ownership comes from a consistent hash ring; a write goes to any node and is forwarded to the owner, at most 2 hops (v2:README.md:23-25).
- **Keys are dotted paths, and the partition is the first part:** `change.key.split('.')[0]` (v2:partitions.js:20-22). `update`/`remove`/`add` take keys that "can be arbitrarily deep" (v2:README.md:310-316); `push` and `patch` build dotted keys (v2:cache.js:30-45).
- **A partition strategy can be a function** ("by user/IP/ID/session"), to co-locate one user's data across services (v2:README.md:357-359).
- **Each partition's log** is a linked list of changes with a per-partition counter `ptime`, capped by `partitions.history.max` (v2:partition.js; v2:README.md:396).
- **A change record is `{ type, key, value }`** plus `ptime`; there is no prior value (v2:messages/change.js:9-13). Values are serialised lazily, on first access (v2:README.md:231).

### 3.2 API

- **`await fero(name, opts)` returns the cache, a plain object** that is the same on every node (v2:README.md:32-39; v2:index.js:1-6). `opts` may be a request handler function (`from`) (v2:README.md:65-80, 294-296). `client: true` makes a client (v2:README.md:82-86, 300).
- **Events are an observable chain:** `cache.on('change').map(…).filter(…).reduce(…)` (emitterify) (v2:README.md:49-57, 318-330).
- **Acks are chosen by what you wait for:** `peers.send(m)` fires; `.on('ack')` waits for the ack; `.on('reply')` for the reply. No promise is made until `.on(…)` is called (v2:README.md:116-134, 231).
- **proxy.js:** an optional `Proxy` whose `set` calls `update(key, value)` and `deleteProperty` calls `remove(key)` (v2:proxy.js:1-7). It has no `get` trap, so it routes top-level assignment only (code).
- **connect.js connects storage, not views:** it restores the first server from `storage.restore` and replays the owner's changes into `storage.add/update/remove` (v2:connect.js:1-47; v2:README.md:361-375).
- **A derived service in v2 is a client plus a server, joined by hand:** `stream1.on('change').reduce(acc => ++acc).map(d => counts.update('stream1', d))` (v2:README.md:251-271). The example keeps no position and does no dedup (code).
- **Not in v2:** a `resource.a.b.c.connect()` lens. The owner's recollection of that design is from data's earlier library; data's local clone has one commit (63fea66), and its CLAUDE.md says the old tree is at the `v3` branch tip, which this clone does not have (data:CLAUDE.md:28-30). The traces in today's code are the ignored anchor and the two comments in 1.4.

---

## 4. fero v5 on paper (nothing built)

### 4.1 `follow`

- **`f.follow(of)`** keeps some partitions here: their rows once, then each change (API:430-463; API:795).
- **What it takes:** a partition, a list, `{ prefix }`, or `{ share }` (`Selector`, API:874).
- **What it returns:** a `Follow`, which is a `LiveData` (data's operators work on it), plus `ready`, `rows`, `cursor`, `close()` (API:861-881).
- **Cost:** one trip, the selected partitions once, then a small frame per change; the server encodes each change once (API:461). A `{ prefix }` follow's first picture walks the partition names (API:179).
- **Follows of the same selection in one process share one subscription and one fold, counted, closed by the last `close()`** (API:462; marked reasoned there).
- **A `get` of a row not held is a follow of its partition** (PATHS 4.4; API:1166). `get(k, { hold: false })` reads once and keeps nothing (API:392, 804).
- **Lifetime:** `close()` (API:462, 876-881). Nothing in API, LAYERS or PATHS ties a lifetime to the collector (grep for `WeakRef`, `FinalizationRegistry`: none).

### 4.2 `changes`

- **`f.changes({ of, from, until, credit })`** reads committed records in order, from a position (API:464-470; API:797, 882-894).
- **An entry is `{ rec, value?, partition, version, time, source, reason? }`** (API:895-905). `e.value` is set only when the record wrote a whole row; it is "not the row now" (API:469).
- **`from` defaults to `'latest'`; "now" is the call** (API:465-468; marked reasoned). Other values: `'earliest'`, a saved cursor, a version.
- **`history` defaults to 0** (API:1342): the log is kept for `changes` only as far as `history` says; past it, `expired` (API:464).
- **A cursor** is text: one position per slot it reads; 22-79 B for 1-10 partitions, up to about 4-13 KB for a whole resource (API:1170-1174).
- **Who uses `changes` in API's patterns:** pub/sub (P-06, API:1464-1480), streams and replay (P-07, API:1481-1498), event sourcing (P-16, API:1636-1654); `consumer` and `derive` are built on the same reader (API:493, 499).

### 4.3 `tap`

- **API's own declarations** give `tap(fn: () => void)` only on `ClusterView` and `WritesView` (API:952, 966).
- **Views and follows get data's `tap`,** through `LiveData<Row> extends Omit<Ops<…>, 'patch'>` (API:861; data:types/public.d.ts:339). That is why P-05's `live.tap((rec) => ws.send(JSON.stringify(rec)))` type-checks (API:1455).
- **The comment at API:641** says "A tap gets one" (a `Rec`). `Rec` excludes `move` (API:642); data's tap with a parameter can deliver `move` records for ordered parents (data:types/public.d.ts:72-75).
- **The text says** "`tap` fires once when it is added, then once per change… The first call carries the picture so far" (API:463). In data, that first picture comes only to a tap with a parameter, as a cloned whole value; a bare tap gets no argument (1.5).

### 4.4 Served views (a method that returns a view)

- **A method may return a view.** The client's call is then a `LiveCall`: `await` it for one picture, `.open()` it for a live mirror kept on the server (API:349, 368, 471; types `CallOf`, `LiveCall` at API:929-944). Example P-12 (API:1567-1588).
- **DV5 4.4's subscribe selector includes `view`, "a server-side view"** (DV5:633). DV5 4.5: "A view returned from a method is served live… Views of the same declarative shape are shared. A `group` bucket can be streamed (a data change)" (DV5:675-677).
- **PATHS:** "v5 should send a method's live view through the same flow as `follow` (PA-5, PA-11)"; a `view` selector's deltas are view outputs, which only main's fold makes, so they keep one encode per view change, shared by its subscribers (PATHS 4.5, "Each later change" step 2 and the v4 note).
- **E-31's model has one followed slot and no view selector** (E-31 "The world", "What the model leaves out").
- **A whole-resource view on a process that holds only part throws `not-held`;** a served view is the stated way out (API:427, 1586).

### 4.5 `derive`

- **`derive(source, target, fn)`;** `fn(e, out)`; `out.set` and `out.remove` return nothing (API:473-500; types API:1069-1094).
- **"`derive` is a `consumer` with a target"** (API:499). The deriver is a client of its source and the owner of its target (V5-2 point 4; API:493).
- **Each output carries a 29 B mark of its source position** in the target's own log, so a restart resumes exactly and no source record counts twice (API:494; E-30; LAYERS:458).
- **One source record's outputs to one partition commit together; outputs to several partitions commit one by one** (API:497).
- **Exactly once holds only while the source keeps its log back to the marks** (`history`, default 0, or the tier); past that the deriver stops with `expired` (LAYERS:930; API:1666).
- **Who runs it is open:** API reads the derivers as splitting the source's shares; PATHS and LAYERS read the target's leader (API:499; LAYERS 8.8; API Q-B8).
- **Why `out` returns nothing:** a loop that awaits each output runs at about 250 source records a second (PATHS 4.9; PA-19).

### 4.6 `hold`

- **`hold: 'all'`** (the default, as v4): the open sends one picture of every row, then every later write to the resource while the handle is open (API:183-205).
- **`hold: 'asked'`**: no rows until a `get` or `follow`; with no size, nothing is ever dropped. **A size:** the same, least recently read partitions dropped when full (API:197-199).
- **Every operator over every row throws `not-held` on a process that holds only part** (API:427).
- Whether `'asked'` should be the default is open (TOUR:279-281; API 11.1 q8).

### 4.7 `near`

- **A method may say which row it is about:** `{ near: true, run }` (the argument is the row key) or `{ near: 'sku', run }` (`arg.sku`) (API:382-385; type API:910).
- **The hint is plain data in the resource's settings.** A client sends the call straight to that row's leader; the handler's writes to that partition are then local: one trip and one commit in all. It is for speed only (API:382-385).
- **Without it** a handler's writes go to their partition's leader: about 2 writes in 3 take one more trip with three servers (PA-25; API:379).

### 4.8 Partitions

- **Three forms:** each row (the default), `{ before: '/' }` (the key's text before the first `/`), or a function of the row key (API:154-181; type API:709).
- **Costs (API:170-174, 178):** the row: a hash, nothing stored. `{ before }` and a function: an index from partition to rows on every copy, memory per row and an update per fold (PA-17). A process without the function cannot route, so its writes take one more trip.
- **The rule is fixed at founding** (API:177; API:1341). A function is code and cannot travel: every server passes the same one and its text is compared (API:176).
- **A partition is one leader's work;** across partitions there is no order, and `batch` is all-or-none within one partition only (API:156, 180, 298).
- **A field write** to a row that does not exist is refused `absent-row` (API:1159), so it takes no early answer stage (API:261). A row may be at most 64 MB and a record at most 1 MB (API:1209). `rows: { ttl, max, where, while }` acts per row (API:728).

### 4.9 L3's SUB protocol

- **One verb serves followers, clients, relays, consumers, derived resources and the viewer: a selector, a mode and a cursor** (LAYERS:518; DV5 4.4 at DV5:627-660).
- **Selector** (DV5:633): `resource`; `partitions: [...]`; `prefix`; `view` (a server-side view); `slots` (for servers, relays and slot moves). API's `Selector` adds `{ share }` for consumers (API:874).
  - **No selector names a field inside a row, a key range, or a predicate,** except by asking a server for a `view` (reasoned from DV5:633 and API:874).
- **Mode** (DV5:634): `state`: a snapshot, then deltas, conflated per row for a slow reader. `log`: every record from the cursor, never conflated.
- **Cursor** (DV5:635): the cluster id, the resource's incarnation, then per slot its epoch and last sequence; or `'latest'`, `'earliest'`.
- **Rules** (LAYERS:534, `subscribe`, 26 rules, model-checked in E-31): serve only from a loaded fold, never before it reaches the cursor, committed records only; `retry` when not ready; `END` from a copy that lacks the next record; only the slot's group leader says `expired`; a snapshot replaces the whole view; a write resolves only once the writer's own subscription has passed it.
- **Credits** are in bytes; a slow `state` reader is conflated, a slow `log` reader is paused (DV5 4.4 "Credits"). Client limits: 512 waiting writes or 64 MB (LAYERS:527).
- **Encode once** is a build trap: a delta is the log's bytes where bytes can route (LAYERS:543); PATHS 4.5 prices v4's re-encode per subscriber at 2.1-2.4 µs a small row.
- **L3 has 33 rules** (24-40) (LAYERS 0.2 table).

### 4.10 The wire (LAYERS section 7, LAYERS:622-646)

- **DV5's 18 verbs:** link `HELLO`, `DOOR`, `PING`, `DIAG`; Raft `VOTE`, `VOTED`, `APPEND`, `APPENDED`, `SNAPSHOT`, `TIMEOUT-NOW`, `QUIET`; ask `ASK`, `ANSWER`; flow `SUB`, `SNAP`, `DELTA`, `END`, `CREDIT`. Plus `REPAIR`, `REPAIRED`: 20 for sure; up to 4 more open.
- **`SUB` carries** a follow set, a client's read of the home group's records, a group leader's follow of its home log, a writer's follow of `#sessions`, a derived resource's read of its source, and a slot move's copy (LAYERS:638).
- **`ASK`** carries writes, calls, an `alter`, a recover and placement hints; an `ANSWER` carries a stage or the committed result (LAYERS 7).

### 4.11 PATHS: subscribe, fan-out, served views, a miss, derive

- **4.4 A miss** (PATHS:733-763): one state-mode `SUB` of the row's partition, one trip; a `GET` then a `SUB` would cost two trips and leave a window. v4's gather is O(members × cells); v5 is O(rows of the partition).
- **4.5 Subscribe** (PATHS:765-801): a 100-row room's first picture at 1e6 rows: 26-28 ms by a scan of every row, 0.47-0.74 ms with a partition index; an encode is about 2.1-2.7 µs a row; per change, routing by a slot in the header costs 1-4 ns, a key decode 0.5-3.0 µs.
- **4.7 Fan-out** (PATHS:821-840): per record, one route lookup and one copy into the room's frame; per subscriber per tick, one socket write (8-14 µs on this VM, E-08).
- **4.8 Browser** (PATHS:842-860): one TLS handshake plus two round trips to the first committed write; decode and fold per record in the page.
- **4.9 Derive** (PATHS:862-879): one delivery, one run of `fn`, a share of one commit per source record; reading the source over the network when the process already folds it wastes a hop and a decode.
- **PA-8** (PATHS:1332): v4's `f.snapshot` builds a new `Map` and a new object of every row per read: 87-89 µs at 1e3 rows, 30-33 ms at 1e5, 0.47-0.53 s at 1e6.
- **PA-17** (PATHS:1341): a prefix partition's first picture scans every row unless an in-memory partition→rows index exists, on every copy; it must not be data's `group` view until DATA-05 is fixed.
- **PA-19** (PATHS:1343): a derived resource that awaits each output runs at about 250 source records a second.
- **PA-31:** checked in 1.1.

### 4.12 `fero<typeof shop>`: does the client pull in the server?

- **API's text:** "`import type` keeps the server's code out of the client's bundle" (API:369).
- **Measured here (typeof/, a `server.ts` that prints when its module runs):**
  - Node v22.22.0 `--experimental-strip-types`: `import type { shop }` does **not** run the server module. A plain `import { shop }` used only in a type **does** run it.
  - esbuild 0.25.12 `--bundle`: both forms leave the server out by default. With `verbatimModuleSyntax: true` in tsconfig, the plain form **bundles the server code**.
- **The server file is a module with top-level `await fero(…)`** (API:339-351; TOUR:16-20). So any value import of it starts a server role in the importing process (reasoned from the role rule, API:114).

### 4.13 The experiments

- **E-08 (fan-out).** One Node relay core: 0.57-1.50 million deliveries a second with no added wait, 20.6-32.3 million with 10 ms rounds; each socket write costs 8-14 µs in Node and Rust alike; p99 1.2 ms at 1,000 subscribers, 0.22-0.25 s at 10,000 with no coalescing (E-08 Verdict).
- **E-31 (subscribe).** The draft's "a reloaded follower says `expired`" broke a promise; the fix is `END` from any copy, `expired` only from the holding group's leader. Cursors must be per-slot sequences. 26 rules; every property holds on ten bounds, up to 7.6 million states. Not modelled: many slots, credits above one record, conflation inside a relay, the view selector (E-31 "In short", "What the model leaves out").
- **E-40 (browser).** `data` plus a client: 27.9 KB gzip; WebSocket fan-out 0.89-0.95× of TCP; a cold browser's first committed write 13-17 ms (E-40 Verdict).
- **E-05 (fold costs).** See 1.7 and 1.11.
- **E-06 (fork and rewind).** See 5.2.
- **E-30 (source marks).** See 6.3.
- **E-20 (client sessions).** See 6.1.

---

## 5. What would step through versions in v5, and what a record carries

### 5.1 Who steps through versions

| What | What it does | Source |
|---|---|---|
| the timeline viewer | a log-mode `SUB` per resource from time T; finds T by a binary search over segments by their first batch's writer time; merges batches by (`t`, resource, group, position) reading headers only | V5-4 (DEC:3027); LAYERS:542; PATHS 4.10 |
| `changes({ from })` | records from a cursor or a version, forward; the reader folds them itself | API:464-470, 1178 |
| `fero.fork(name, { as, at? })` | a new resource at a cursor or now; "one record per group naming the parent's files; it copies nothing"; not built | API:1017, 1225; LAYERS:352 (`forks`, 7 rules, reasoned) |
| tapes | `tape(name, { window })` with `record(match, input, answer)` and `find(match)`; a tape is one partition | API:1115-1118, 1225; P-18 (API:1669-1686) |
| worlds | `fero.world({ seed })`: seeded time and ids; a run is a function of its seed | API:1022, 1029, 1677-1680 |
| restore | `fero restore`, an admin step per resource, to a past position: base and layers, then replay of segments up to the position | LAYERS 8.7 (LAYERS:887-908); PATHS 5.8 |
| the v4 debugger | `stateAt(capture, uuid, t)` replays a node's journal from the start to event t through the last-writer fold ("TIME TRAVEL") | fero:tools/debug/model.mjs:175-200 |

- **No API reads a row as of a past position.** The ways to a past state are a fork at a cursor, a restore, or a reader that folds `changes` itself (API declarations, API:722-905, 1005-1030; grep for "as of": none).
- **Requirements:** TEST-05 tapes, TEST-06 "a fork costs a record, not a copy", TEST-07 "any recorded input can be re-run on the state just before it, ≤ 10 ms each" (v5-space/REQUIREMENTS.md:187-189).

### 5.2 E-06: what stepping costs today (fork and rewind)

E-06 README "Results" and "Verdict":
- **A runnable fork costs O(rows)** in memory and time: 1.6 ms at 1,000 rows, about 170 ms at 100,000, about 2.6 s at 1,000,000, and 250-300 B of heap a row.
- **A rerun from a snapshot copied back into data costs 0.66-1.1 s at 1e6 rows**, because data adopts a plain object it then writes into, so a kept snapshot must be copied first.
- **A persistent map (Immutable.js 5.1.9, a hash array mapped trie) makes keeping a snapshot free** (a pointer; 1-6 µs a record to keep it beside data) **but not restoring one into data** (0.65-0.82 s at 1e6 rows, to turn it into an object).
- **The floor with a shared-structure store** (no data at all): 0.02 ms a rerun, about 0.1 ms a fork.
- **An undo log costs 0.03-0.05 ms a rerun at every size**, with no snapshot: run the input, read what it wrote, apply the inverses. Limits: it walks in tape order; a jump costs the inputs between; a removed row put back lands at the end of data's key order (not kept, checked at 1e3 and 1e5 rows); views pay their own cost (one `group`: about 165 ms a rerun at 1e6).
- **The inverses are not in the records.** E-06 read each old value "from the row just before its record lands" (E-06 Method, `undo`).

### 5.3 What a record carries: can it be reversed?

- **fero's Rec is `{ type, key, value, at? }`** in v4 (fero:kernel/env.ts:206-217) and in v5's log (LAYERS:437: the slot's sequence, the attempt id, the issue number, and data's change record `{ type, key: [rowKey, ...path], value, at? }`). **No prior value anywhere** (grep of LAYERS, PATHS, DV5, API for `prev`, "prior value", "before-image": none).
- **v2's change is `{ type, key, value }`,** no prior value (v2:messages/change.js:9-13).
- **data's native `CommitBatch` carries `prev` by reference** (data:contract/delta.ts:37, 44). It is in memory, per commit, and not kept (data:contract/index.ts:90-93).
- **So reversing a fero record needs the state before it** (reasoned): from a fold, a snapshot plus replay, or an undo log written beside the fold (E-06's way).
- **The batch header carries writer time `t`** (DV5 4.3; LAYERS 3.2), which never goes back within a group (PATHS 4.10).

### 5.4 Persistent data structures (from memory, except where marked)

- **Path copying** (balanced trees, hash array mapped tries as in Clojure and Immutable.js): O(log n) per update and lookup (log base 32 for a trie), old versions stay whole, an update makes O(log n) new nodes.
- **Fat nodes and node copying** (Driscoll, Sarnak, Sleator and Tarjan, "Making data structures persistent", 1989): O(1) amortized extra space per update for linked structures of bounded in-degree.
- **Version trees with diffs ("Baker's trick", rerooting; used for persistent arrays and union-find by Conchon and Filliâtre):** O(1) access to the current version; moving to another version costs the distance between them.
- **data today** (code): rows are immutable and copied along the written path (1.9); the table is a mutable `Map` (1.11); `snapshot()` is O(rows).
- **E-06 measured the trie (Immutable.js) beside data** (5.2). Nothing else was measured.

---

## 6. Exactly once

### 6.1 In fero v5 today (on paper)

- **Client sessions dedup every retry** (API:1138-1146; E-20; LAYERS:454):
  - Each process has one session in `#sessions`, renewed within `session.ms` (10 s).
  - Each write carries its session and a number. Per session, the leader keeps a floor and the answers it gave; a resend gets the first answer. 13 rules, no time rule (E-20 model-checked).
  - **How long:** for the session's life. A late copy below the floor is answered `stale` (E-20 "In short"). If the session lapses (a pause over `session.ms`), its writes in flight answer `unknown` and it starts a new session (API:1146).
  - Memory: 309 B per active client; about 16 B per client carried with each slot move (E-20 Verdict).
  - A slot move and a snapshot carry the floor, the answers, the marks and the lock tokens (API:1142).
- **`once` names** (API:1143-1145, 1191; LAYERS:462 `caller-keys`, reasoned, not modelled beside sessions):
  - A name the app picks, on a write or a call. A resend or re-run within **1 day** gets the first answer; the same name with a different change is refused `call-diverged`.
  - About 221 B per name for its day; at most 1,000,000 live names per resource, about 211 MB.
  - A call with `once` claims a row in `#calls`: three commits in a row, up to two more trips; if its server dies it is re-run elsewhere after the lease, with the same attempt ids, `ctx.now()` and `ctx.id()` (API:380, 1191).
  - A named write has no early answer stages (API:261).
- **`{ retry: true }`** on a call sends it again if its server is lost; the handler may run twice (API:367; fero:api/methods.ts:22-24).
- **A call with neither** whose server dies answers `unknown` and is not resent (API:1193).
- **derive's marks** (4.5): exactly once for outputs written to fero resources, while the source keeps its log back to the marks.
- **`consumer(...).run()`** gives exactly once for its `out` writes, with the same marks; `for await` batches with `commit()` give at least once; a paused member's commit is refused `fenced` (P-08, API:1499-1516; LAYERS:610: 6 rules, from E-22's library code, membership not modelled).
- **Queues** are at least once: a job that throws is tried again, up to `deliveries`, then moved to a dead-letter resource (P-09, API:1517-1532).
- **What is not covered** (reasoned): an outside side effect inside a handler, a `run` function or a queue worker (an email, a payment) is not made exactly once by any of the above; only fero writes are.

### 6.2 E-20's and E-30's findings on Kafka-style producer ids

- **E-20:** Kafka's producer-id scheme (`pid`) needed 16 rules here and, as first written from KIP-98, could stall a partition after a give-up (Kafka's fix: KIP-360's epoch bump) (E-20 "In short").
- **E-30:** a new producer id per life "applies twice after a short restart"; no dedup option with a horizon (`win`, `sess`, `pid`, `keys`) keeps derived outputs exactly once across a restart longer than its horizon (E-30 "In short").

### 6.3 The marks (E-30)

- **The cursor beside the outputs (`srchi-slot`):** per consumer, source slot and output slot, the highest source sequence applied, written in the output's own entry and carried when the output slot moves. 5 rules, 6 of 6 mutants caught; real Elle agrees on 2,800 histories; 29 B a mark (E-30 "In short", Verdict).
- **Kept per group instead of per output slot, it loses an output when a slot moves** (E-30 "In short").
- **No two-phase commit and no Kafka-style transaction is needed** (E-30 Verdict).
- **The precedent named in E-30:** storing consumer offsets in the same store as the outputs, "Storing Offsets Outside Kafka" in the KafkaConsumer javadoc (E-30 Verdict, citing https://kafka.apache.org/36/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html).

### 6.4 Kafka (from memory)

- **Idempotent producer** (KIP-98, Kafka 0.11; on by default since Kafka 3.0): the broker gives the producer an id and an epoch; the producer numbers its batches per partition; the broker rejects a repeated sequence, keeping the last 5 batches per producer and partition (so `max.in.flight.requests.per.connection` ≤ 5). It dedups retries **within one producer session**; a restarted producer without a `transactional.id` gets a new id and no dedup. Broker-side producer state expires (`producer.id.expiration.ms`, KIP-854, default 1 day).
- **Transactions** (`transactional.id`): writes to many partitions, plus the consumer's offsets (`sendOffsetsToTransaction`), commit or abort together, through a transaction coordinator and commit markers; a new producer with the same `transactional.id` bumps the epoch and fences the old one. Consumers with `isolation.level=read_committed` see only committed data.
- **"Exactly once" in Kafka means read-process-write inside Kafka** (Kafka Streams' `processing.guarantee=exactly_once_v2`, KIP-447). Side effects outside Kafka are not covered.
- **NATS JetStream** dedups by a message id header within a window, 2 minutes by default.

---

## 7. Decisions and rules that bind these designs

- **V4-5:** `methods:` is the door: with methods declared, clients change data only through them; a plain write is refused `methods-only` (fero:CLAUDE.md; API:330-332).
- **V4-7:** a write shows when it commits; no optimistic copy; a refused write never shows (fero:CLAUDE.md; fero:api/substrate.ts:267-268).
- **V5-1:** the log is the truth; a subscription reads from a position; replay, tapes and forks fold from a snapshot to a position (DEC:2997-3005).
- **V5-2:** a resource is its own cluster; the partition (row by default, a prefix, or a function) is the unit of order; a derived resource is a client of each source and records how far it read (DEC:3007-3015).
- **V5-4:** one timeline by writer time (DEC:3027-3035).
- **V5-5 and V5-11:** every write commits on disk at a majority before anyone sees it; answer stages are progress reports; only a write that cannot be refused takes an early stage (DEC:3037-3045, 3097-3113).
- **V5-6:** designs are compared by simplicity, every rule a builder must get right (DEC:3047-3055). The base has 416 rules (SIMPLICITY 0 point 1, section 8).
- **V5-9:** direct routing, one checksum per batch, a byte-rate cap on bulk work now; the rest of PATHS 7.1 after the first build slice (DEC:3077-3085).
- **The owner's latest decision** (2026-11-17, with the request for this brief): data may be rewritten freely, must still work as an independent library, and may move to Rust.

---

## 8. Facts that constrain any design

1. A path step through fero v4's lens costs 0.47 µs at 1e3 rows to 4.5 µs at 1e6 (keys spread); fero's own share is 0.14-0.42 µs a step; data's cached step is about 0.1 µs; a plain `Map` read is 0.03-0.66 µs (measured here, path-step.mjs).
2. data caches every child handle on its parent for the parent's life: about 320 B per distinct key read one step deep, about 990 B two steps deep (100,000 rows), never freed (data:api/index.ts:592-602; measured here, mem-step2.mjs).
3. data's subscriptions and views are held strongly by their source and end only by `dispose()` or a scope; GC timing never changes results in data (data:kernel/scope.ts:1-9; data:kernel/node.ts:45-48, 142-145).
4. data's `connect(anchor, fn)` ignores the anchor; a callback that closes over its anchor keeps it alive for good (data:api/index.ts:357-361; measured here, anchor-life.mjs).
5. fero v4 already ties some view lifetimes to the collector (V4-54): about 4 µs per view, release only when a GC runs, a dropped view is computed on every commit until then, tests must force GC (DEC:2762-2773).
6. A path subscription on a child (`h.a.b.connect(…)`) subscribes the root and checks every row delta of every commit (data:api/index.ts:186-191).
7. A field write copies every object on its path; with 1,000 fields beside it in the row it cost 0.43 ms, with 10,000 it cost 3.6 ms, against 0.9-2.0 µs for a row per item (measured here, nest-cost.mjs).
8. No record in v2, v4 or v5's log carries a prior value; only data's in-memory `CommitBatch` has `prev`, and data keeps no history (5.3).
9. A runnable fork or a snapshot restore into data costs O(rows): 2.6 s and 0.66-1.1 s at 1e6 rows; an undo log reruns in 0.03-0.05 ms at any size; a persistent map makes keeping versions free but not handing them to data (E-06).
10. A v5 SUB selects a resource, partitions, a prefix, a server-side view, or slots (and API adds shares); nothing selects a field path, a range or a predicate except through a server-side view (DV5:633; API:874).
11. E-31 model-checked subscribe for one slot in `state` and `log` modes; it did not model a view selector, many slots, or credits above one record (E-31).
12. User code cannot travel to a server: a partition function must be passed by every process and its text is compared; a closure operator (`filter`, `map`, `group`, `reduce`, `tap`, `to`) is not declarative data (API:169; data:ops/registry.ts:14; 1.7).
13. Serving one change to many readers costs about 0.01-0.46 µs per reader when encoded once, against 2.1-2.4 µs per reader re-encoded as v4 does; a socket write costs 8-14 µs here (PATHS 0, 4.5; E-08).
14. A tap with a parameter costs about 1.7 µs per change (a record built and cloned); a bare tap and a native sink cost about 0; `connect(anchor, fn)` costs 1.4 µs cloned, 0.5 µs with `clone: false`; data's by-reference sink adds 0.017 µs per extra sink per commit (measured here, tap-cost.mjs; data m4 B3).
15. data's `group` view costs O(rows in a bucket) per commit (2,574 µs a record at 1e6 rows); 100 filters cost 9-18 µs a record (E-05).
16. A prefix or function partition needs a partition→rows index on every copy, or a room's first picture scans every row (26-28 ms at 1e6 against 0.47-0.74 ms) (PA-17).
17. Exactly once in v5 covers fero writes only: sessions for retries (session life), `once` names (1 day), marks for derive and `run()` (while the source keeps its log); outside side effects are not covered (6.1).
18. derive's exactly once needs the source's `history` (default 0) or the tier to reach back past the longest stop; otherwise the deriver stops with `expired` (LAYERS:930; API:1342).
19. A plain value import of a server file runs it under Node's type stripping, and bundles it under `verbatimModuleSyntax`; `import type` never does (measured here, typeof/).
20. A user function inside an operator is JavaScript; a Rust data would call back per row at 107 ns (inside a napi call) to 3.8 µs (from a Rust thread) per call; a batch crossing costs under 1 ns a record (E-03).
21. v4 has no subscription by partition: a client either replicates the whole resource or subscribes to a method's view, one SUBREC frame per change per subscriber (fero:kernel/codec.ts:69-72; fero:api/methods.ts:349-358).
22. Methods are the door (V4-5) and writes show only at commit (V4-7); both stand in v5 (API 5.1).

---

## 9. What was run here

All scripts read E-50's scratch tree (`TREE=$TREE`) and ran with `node --expose-gc --experimental-strip-types --no-warnings`, under the study's `timing` lock where timed. Folder: ./bench/

| Script | What it measures | Raw output |
|---|---|---|
| path-step.mjs `<rows>` | one and two path steps through fero's lens and data's handle, keys spread or the same, against a `Map` (1e3, 1e5, 1e6 rows) | path-step.jsonl |
| mem-step2.mjs `<rows> <get1 or sugar2>` | heap kept per distinct key read through data's handle | mem-step2.jsonl |
| tap-cost.mjs | ns per write with each kind of subscription attached | tap-cost.jsonl |
| nest-cost.mjs `<messages per room>` | a field write into a room row against a row per message | nest-cost.jsonl |
| anchor-life.mjs | whether data's `connect(anchor, fn)` follows its anchor's life | anchor-life.jsonl |
| ./typeof/ | `import type` against a plain import of a server file, under Node 22 and esbuild 0.25.12 (with and without `verbatimModuleSyntax`) | printed in section 4.12 |
| data `perf/m3-replication.ts`, `perf/m4-budgets.ts` (in the sibling data repo, unchanged) | data's lane and sink costs | printed in 1.2 and 1.11 |

Raw lines, as printed:
```
path-step  1e3: lens.k.spread 470.1, lens.k.same 259.5, lens.k.n 547.5, handle.k.spread 210.1, handle.k.same 123, handle.k.n 215.7, map.get.spread 31.8, idx.only 16.2
path-step  1e5: 3090.5, 396.9, 822.2, 3207.2, 132.9, 215.7, 267, 40.9
path-step  1e6: 4460.8, 547.2, 1060.7, 4362, 128.5, 245, 660.1, 101
mem-step2  1e5: get1 318 B/key; sugar2 990 B/key   (1e6 runs gave negative numbers: unsettled)
tap-cost   none 2054; tap(()=>) 2051; tap((rec)=>) 3741; sink 1877; connect(anchor,fn) 3409; connect(anchor,fn,{clone:false}) 2564   (ns per write)
nest-cost  M=10: 1102 vs 731; M=1000: 428734 vs 925; M=10000: 3585352 vs 2037   (ns per write: room row vs row per message)
anchor-life closingAnchorCollected false, closingSubFiredAfterDrop true, freeAnchorCollected true, freeSubFiredAfterDrop true
m3         lane/frame16 0.685 µs/rec (best 0.579), lane/rec 2.129, lane/frame512 0.573
m4         B1 131.6 / 129.3 B/rec; B3 marginal 0.0173 µs/sink/commit; B4 1.258x; B5 1.096x
```
