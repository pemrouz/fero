# The connect lens: one recommendation

Written 2026-11-18. It answers the owner's feedback on [API.md](API.md) and [API-TOUR.md](API-TOUR.md) (2026-11-16). **Revised the same day**, after [E-55](experiments/E55-lens-prototype/README.md) built the shape small on data's real engine, and after a skeptic reviewed this page, E-54 and E-55 (24 findings; E-55's README has them under "The review"). **API.md, API-TOUR.md and LAYERS.md are not changed yet: the owner decides first** (section 7).

**What this page is.** Three designers each wrote a full proposal from one facts brief: one took the owner's lens as far as it goes (**lens-first**), one priced every construct and doubted the lens (**cost-first**), one mapped every place a computation can run (**space**). [E-54](experiments/E54-time-travel/README.md) measured time travel. E-55 then built the recommended shape and ran this page's claims (section 6). This page takes the best answer to each question, says why, and says what the build and the review changed.

**Words.**
- **lens**: an address. It names a resource and a path inside it, such as `chat.data.room1.m7`. It holds no data.
- **step**: one property read on a lens (`.room1`). **verb**: a call on a lens (`.set(4)`).
- **row**: one entry of a resource. It has its own version, expiry and conditions. **partition**: the rows one leader keeps in one order.
- **link**: one live connection from a lens to a target. **strong**: it ends only when your code ends it (`here()`, `tap`). **weak**: it also ends when its target is collected (`connect`).
- **held on purpose**: rows this process keeps because of a server role, `hold: 'all'`, or a live strong link. Rows that only a weak link keeps are not held on purpose.
- **SUB**: v5's one subscribe message: a selector, a mode and a cursor (LAYERS 4). **GET**: one read message. **trip**: one message there and its answer back. **commit**: the write is on disk on most copies (V5-5).
- **picture**: the rows of a selection at the moment a link starts.
- **the collector**: JavaScript's garbage collector. **the net**: the collector as the last way a link ends.
- **rule**: one thing a builder of fero must get right (SIMPLICITY 1; V5-6). The base has 416. A **user rule** is one thing a user of fero must know.

**How each claim is marked.**
- **measured (brief)**, **measured (lens-first)**, **measured (cost-first)**, **checked (space)**: run in this study before E-55, for the facts brief or for one of the three proposals. The brief, the three proposals, their scripts and their raw lines are in [experiments/E55-lens-prototype/brief/](experiments/E55-lens-prototype/brief/) (`brief.md`, `lens-first.md`, `cost-first.md`, `space.md`; `bench/`, `lensfirst/`, `cost-bench/`, `space-types/`, `typeof/`). Where E-55 measured the same thing on the real shape, this page quotes E-55 and says so.
- **E-55**: measured on the prototype, three runs under the box's timing lock, or seeded runs under its heavy lock. **E-55 review**: measured in the review pass, on the prototype as changed for the findings (`results/review-*.jsonl`, `review/`). **E-54**, **E-nn**: an experiment under [experiments/](experiments). **PATHS n**, **PA-n**, **API n**, **LAYERS n**, **V5-n**, **V4-n**: those pages and decisions.
- Every run used **Node v22.22.0** and TypeScript 6.0.2, except E-55's import matrix, which also ran Node 26.13.0. Nothing was run for this page itself.
- **code** `repo:file:line`: `data:` is the sibling library at commit 63fea66, `fero:` is this repo's v4 code, `v2:` is `origin/master`, `E-55:` is the prototype's folder.
- **reasoned**: an argument; nothing ran it. **from memory**: an outside fact nobody checked here. **web**: a URL, read only as a search summary (the pages could not be opened from this box).
- **A verdict on a timed claim** is the median of its runs against its bar, with the lowest and highest run shown (one rule for every claim, section 6).

---

## 0. The answer in ten lines

1. **Yes, the lens is better than API.md's shape, as the address and as the grammar for flow.** `shop.data.a.b.c` names a place and does no work. One address then reads, writes, calls and streams. E-55 built it on data's real engine, and every seeded check holds on the build as fixed in the review.
2. **`here()` is the line between a server's work and this process's work.** Left of it is plain data and may run on a server. Right of it is your code, here. `connect(target, fn)` is `here()` plus a sink that lives as long as its target.
3. **`follow`, `.open()`, `near`, `{ before }`, the hidden follow inside `get`, and the spelling `f.data.set` go.** A client holds on purpose exactly what its live `here()`s and `tap`s name.
4. **A method called on a path runs at that path's leader**: `shop.data.widgets.sell(1)`. One trip, one commit (PA-25; E-55). **The method declares where it may be called (`at: 'row'`), and the server refuses any other path.** A client picks the path, so the door must check it.
5. **A lens is never a promise, and never the hot read path.** A read is `await lens.get()`. `rows` stays for hot reads: a lens read costs 0.17 to 0.29 µs (two steps and a verb, E-55) against 0.014 to 0.06 µs for a `Map` read. `at()` is the form for computed keys and hot loops.
6. **Not the garbage collector as the way a link ends.** Chromium ended 0 of 1,000 links to removed DOM nodes in 30 s (E-55). Links end by `close()`, a scope, the target's own close, or a count. The collector is a net under those, and **nothing a program can see may depend on it**: a read is served here only from rows held on purpose, and a `connect` function changes only its target.
7. **Not server work a client makes up over a whole resource.** Three things may stand left of `here()`: a partition, plain-data operators inside one partition, and a view the server named in `methods:` (V4-5), with a cap on live served views per client. The first build sends whole partitions. Pushing work below a partition waits: it moves CPU and memory to the server to save wire bytes, and three things it needs are not built.
8. **A message is a row, not a field.** `depth: 2` makes `chat.data.room1.m7` a row and `room1` its partition. One level stays the default. On today's data it passes for partitions of 100 rows and more (E-55); small partitions need data's two-level store (D3).
9. **`tap` gets one argument per commit, by reference, with frozen rows.** It costs 0.1 to 0.4 µs a commit, not zero. **`derive` stops being a primitive**: the source mark becomes a write option, `{ from: e }`. The four-line loop is exactly once only if fero paces it and it runs in one process; `derive()` stays as the library that does both. **Time travel stays off the write path** (E-54): `lens.asOf(position)` is a reader.
10. **The price: about +12 to +18 rules on 416 (3 to 4 %, reasoned), seven user rules, three more rules in a reader library, and seven changes in data, none in Rust.** Not run yet: the view selector's model (claim 22), the 22 patterns end to end (claim 25), and a served view on the prototype (claim 27).

### 0.1 What the build and the review changed on this page

**E-55 built it** (about 1,000 lines on data 63fea66: a `Proxy` lens, `here`, `connect`, `tap`, selections shared through a keyed index, a server in a worker and clients on real `MessagePort`s with resume, methods on a path). **Of 27 claims** (section 6; 25 from the first form of this page, 2 added by the review): **10 pass, 10 pass in part, sit at the edge of their bar or are stand-ins, 1 misses, 3 are records with no bar, 3 were not run.**

**What E-55 found that this page did not have** (each is now in the section named):
- **Four rules.** A partition held inside a held whole resource sends no SUB of its own. A resume starts from the server's position, and a client drops a frame it already applied. A `connect` function may change only its target. Moving `here()` keeps the answer only if the wire carries the order and the client keeps it (2.2, 2.3).
- **The collector in a browser may never run**: 0 of 1,000 in 30 s (2.2).
- **A weak link is not free**: +28 to +35 ns per link per commit, 2.2 times a strong sink at 10,000 links (section 3).
- **A tap is not free**: data's own delivery to any sink is most of it (1.6).
- **A step costs more than its bar when keys are spread over 1,000,000 rows** (162 to 222 ns over seven runs, median 205; bar 150). `at()` is the form for that case (2.1).
- **A bundler can ship the server** for `import { Shop }` (1.3).
- **A pushed-down view costs what the view costs, on either side** (2.3). **`depth: 2` is heavy for one-row partitions on today's data** (1.1). **`asOf` costs more on data's real fold** than beside a `Map` (2.9).

**What the review found, and what this page now says:**
- **A read must not depend on the collector.** The first build served `await lens` from any rows it happened to hold, even rows only a dropped `connect` kept. The same program then made 0 GETs or 1, by when the collector ran. Now: served here only from rows held on purpose (2.2). E-55 review: 1 pattern per program over 1,000 collector seeds, against 9.7 before.
- **A lens must not be a promise.** With `then`, returning the root lens from an `async` function downloaded 100,000 rows. Now: `lens.get()`, and seven probe names read as `undefined` (2.1).
- **The four-line derive lost records under load.** A write refused `backpressure` was dropped, and a later write moved the mark past it. Now: a marked write is never refused for backpressure; it pauses its reader (1.7, 2.8). E-55 review: 998 of 1,000 seeds lost outputs as written, 0 of 1,000 paced.
- **A method must check its path** (2.4). **Served views need a cap** (2.3). **Views right of `here()` leaked** in the first build (fixed; claim 26). **`at()` with a number key reached a different row** (fixed; 2.1). **Rows handed to a sink must be frozen** (2.7). **A warm near cache is not subscribed** (2.2).
- **Numbers.** The fat-node costs are now the picked layout's only (1.4). A hash-tree store costs +1.1 to +2.2 µs a write, not +3.3 to 5.7 (section 5). Claim 10's harness had more noise than its bar; it was rerun interleaved (1.6). Claim 16's bar measured the wrong thing (2.3). The rule count was understated (4.4).

---

## 1. The owner's seven points

### 1.1 Keys: `[prefix][suffix]` as the default, in place of `prefix/suffix` with `{ before }`

**Yes to the shape. No to making it the default, as data stands.** With one level of rows, `chat.data.room1.m7` would be a **field** of the row `room1`. A message as a field loses what a row has:

| A row has | A message as a field of a room row | Mark |
|---|---|---|
| a cheap write: 0.7 to 2.0 µs at 10 to 10,000 messages a room | the write copies the room: **0.43 ms at 1,000 messages, 3.6 ms at 10,000**, on every copy and every client | measured (brief, `bench/nest-cost.mjs`: 731 to 2,037 ns a row write); code data:kernel/node.ts:275-291 |
| its own version and conditions | the room's: `if: { absent }` on one message cannot be said; an edit conflicts with any post | API 3.5; reasoned |
| its own `ttl`, `max`, `while: 'session'` | none: only the room can expire | API:728 |
| up to 64 MB of its own | the whole room must fit in 64 MB | API:1209 |
| early answer stages | none: a field write can be refused `absent-row` | API:261, 1159 |
| `e.value` in `changes` | unset: P-06, P-16 and P-17 would skip every message | API 3.10 |
| views over it | none: an operator on a child path throws | code data:api/index.ts:543-548 |

**So make the second level a row, and say so once per resource.**

```ts
await fero('users', { server: true })              // depth 1 (default): users.data.u42 is a row, and its own partition
await fero('chat',  { server: true, depth: 2 })    // chat.data.room1 is a partition; chat.data.room1.m7 is a row
chat.data[room][fero.id()].set({ text, at: fero.now() })   // a row write. No key string to build or split
chat.data.room1.here()                                     // one partition, held live
```

- **The first key is always the partition**, as in fero v2 (code v2:partitions.js:20-22). `depth` says where the row begins. Every process can route by hashing the first key, with nothing to learn.
- **`{ before }` goes.** It is the same idea spelled as a text convention, and it needs a second index from partition to rows on every copy, kept on every fold (PA-17). A two-level store is that index.
- **Measured (E-55, claim 19), on today's data with one data source per partition:**
  - **Partitions of 100 to 10,000 rows pass.** The fold costs 0.78 to 1.10 times a flat store with PA-17's index. A partition costs 1.2 KB to 805 KB less memory than the index for it. A 100-row room's first picture takes 0.012 to 0.017 ms at 100,000 to 1,000,000 rows in all (a flat store with no index walks every row: 30 to 40 ms). A key grows by 2 bytes.
  - **One-row partitions miss.** Each costs about 0.9 KB more than its index entry, and the fold costs 1.3 to 1.5 times. A plain two-level `Map` was the cheapest store at every size, so the cost is a data source per partition, not two levels. That is data's change D3 (4.5).
  - **A row write** at 100,000 to 1,000,000 rows in all costs 2.0 to 3.4 µs flat and 2.1 to 3.9 µs at depth 2 on this box. The 0.7 to 2.0 µs above is one small room.
- **Why not two levels always?** Then `users.data.u42.name` would be a row, and a user could not be read, expired or versioned as one thing (reasoned).
- **The function form** (V5-2) stays, built later, for partitions a key level cannot say. That is the owner's call (section 7, Q4).

### 1.2 Exactly-once behaviour, as Kafka has it

**Yes, for writes into fero, in three layers, each with a limit: a resend counts once inside one session (after a pause longer than `session.ms` the answer is `unknown`); a `once` name counts once for a day; a mark counts once per source record while the source keeps its log (`history`) and the loop is paced and runs in one process (1.7). Like Kafka, not for an email or a payment made inside your code.**

```ts
await views.data['page:/'].set(op.incr(1))                           // 1. sessions: a resend never counts twice. Nothing to write
await orders.data[id].set(order, { once: 'import-7:row-3' })         // 2. a name: safe to send again from any process, for a day
totals.data[e.value.user].set(op.incr(e.value.cents), { from: e })   // 3. a mark: once per source record, across any restart
```

| Layer | Makes exactly once | For how long | Cost | Kafka's nearest (from memory) |
|---|---|---|---|---|
| **sessions**, always on | a resent write | the session's life; a pause over `session.ms` answers `unknown` | 309 B a client; 13 rules, model-checked (E-20) | the idempotent producer: dedups inside one producer session |
| **`once` names** | a write or call the app names, across processes and restarts | 1 day | about 221 B a name (API 3.4) | nothing direct |
| **marks** | read from a source, write an output | while the source keeps its log back to the mark | 29 B a mark; 5 rules, model-checked (E-30); 1 more for pacing (1.7) | transactions with `sendOffsetsToTransaction` |

- **Weaker than Kafka:** no atomic write across partitions that readers cannot see half of. `batch` is all-or-none in one partition; a saga may be seen half done (E-24; V5-1 gave this up knowingly).
- **Simpler than Kafka:** the mark needs no coordinator and no two-phase commit (E-30). Kafka's producer-id scheme needed 16 rules here against 13 (E-20).
- **A cost the tour did not show:** a derived resource needs `history` set on its source (default 0). Past it the deriver stops with `expired`; it never skips (LAYERS 8.8).

### 1.3 Whether `typeof shop` pulls the server into the client

**In Node and under `tsc`: no with `import type`, and the mistake is caught. In a browser bundle: it can ship the server, unless the types are checked first.**

| The client says | Node 22 and 26 (type stripping) | `tsc`, `verbatimModuleSyntax` | esbuild, tsconfig with `verbatimModuleSyntax` | esbuild, without |
|---|---|---|---|---|
| `import type { Shop }` | the client runs; the server does not | ok | server not shipped | not shipped |
| `import { Shop }` (the mistake) | **SyntaxError when Node links the modules; nothing runs** | **error TS1484** | **server shipped** | not shipped |
| `import { shop }` (the handle) | **the server runs** | ok | **server shipped** | not shipped |

All measured (E-55 claim 24; the brief's `typeof/` saw the same for Node).

**The safer shape: export the type, not the handle, and check types before you bundle.**

```ts
// ── server.ts
const shop = await fero('shop', { data: { widgets: { stock: 10 } }, methods: { /* … */ } })
export type Shop = typeof shop
// ── client.ts
import type { Shop } from './server.ts'
const client = await fero<Shop>('shop')
```

- **Why the bundler case matters most.** A bundler that keeps imports as written and checks no types ships the server file for `import { Shop }`. The browser then gets the server's top-level `await fero(…, { server: true })` and its method code. That leaks business logic, not just a side effect.
- **What to do** (reasoned): write `import type`; run `tsc --noEmit` (with `verbatimModuleSyntax`) or the lint rule `consistent-type-imports` before bundling. Either turns the mistake into an error. This costs fero no rule; it is a line in the docs and in the project template.
- **A cost that stays** (reasoned): a type-only import still makes the client's type check load the server file's whole import graph. A server that imports Node-only packages can pull Node's types into a browser project's check.
- **Two stronger shapes were weighed** and are in section 5: a spec module that both sides import, and a browser build of fero in which a server role throws.

### 1.4 Stepping back through changes, what needs it, and persistent data at O(log n) or O(1)

- **fero holds the current state and merges new records in: yes** (V5-1).
- **Stepping back by reversing old records: not from the records alone.** No record in v2, v4 or v5's log carries the value before (brief 5.3). data has it in memory at the moment of the write (`prev`, by reference; code data:contract/delta.ts:44) and then lets it go. `prev` comes once per commit, not once per record (code data:contract/delta.ts:101-103).
- **What needs it:** the timeline viewer and `fero debug`, test reruns (TEST-07), forks, restore, an audit read. **None is on the live write path**; each reads the log, which is already the history (E-54; reasoned from API and LAYERS).
- **The two approaches**, most likely: path copying in a hash tree (O(log n), every version a root) and Baker's rerooting (O(1) only at the version that holds the real table). Which one the owner meant by "O(1)" is **reasoned** from their words (E-54). Other readings exist: Driscoll's node copying is O(1) amortised, and a hash tree's log32 n is often called "effectively constant" (from memory).
- **Should we use them? Not on the write path** (E-54, measured at 1e5 and 1e6 rows):
  - a hash-tree root kept per write adds 3.3 to 5.7 µs to a 0.79 to 1.4 µs fold and keeps 1.3 to 1.7 KB a version; the collector goes from 0.5 % to 15 to 22 % of the time;
  - a hash tree used only as the store, with no version kept, still adds 1.1 to 2.2 µs a write (E-54, measured in the review); Rust's trees cost 8 to 10 µs a write;
  - **on a reader, fat nodes win**: a sorted list of versions per row (the layout E-54 picks; its smaller back-pointer layout reads a hot row in 0.3 ms and is not picked). Beside a plain `Map`: about +1.0 µs a record and 104 to 219 B a version, 6 to 14 times less than a hash tree (E-54). On data's real fold: +1.5 to 2.0 µs a record and 103 to 285 B a version (E-55 claim 23). A step or a jump is a number that changes: 10 to 12 ns. A row at any version: 0.6 to 1.4 µs (E-55), 2.1 to 2.4 µs (E-54). A picture is a version number, frozen by construction;
  - a record needs nothing new: the prior value in the log would add 80 to 150 % to its bytes.
- **The interface: `lens.asOf(position)`**, a read-only lens folded in the asking process (section 2.9).
- **An app's own undo** can take `prev` from a `tap` (1.6). The undo write needs a condition (`if: { version }`), or it can overwrite a write that came in between (reasoned).

### 1.5 The lens: `resource.a.b.c.connect()`, weak references, operators before and after, methods on a path, `shop.data.a.b.c.set()`, no `follow`

Section 2 is the full answer. Point by point:

| The owner's point | Answer | Where |
|---|---|---|
| a proxy builds a lens; `connect()` pipes state, then changes | yes; built and checked in 1,000 seeds, in one process and across disconnects (E-55 claim 7) | 2.1, 2.2 |
| how an app manages the state it downloads | a process holds on purpose what its live `here()`s and `tap`s name, for as long as they live. A page connects in a route's or a component's scope | 2.2, 2.3 |
| the most efficient way, end to end | yes down to the partition: one trip, the bytes once, one shared encode per change. **Not below the partition in the first build** | 2.3 |
| weak references, so that no code has to end a link | as a net, yes. As the mechanism, no: 7 ms to never, and never in a browser within 30 s (E-55) | 2.2 |
| calls are a different space from keys | yes: a name is a key until it is called. 47 of 47 cases (E-55 claim 4) | 2.1 |
| `r.a.b.c.method()` runs at that path's leader | yes, and `near` goes. The method declares where it may be called | 2.4 |
| operators before and after: server side and local | yes: `here()` is the line | 2.3 |
| no clear place for server-side transformations | the map of seven places is in 2.3; today's API names four of them with four unrelated words | 2.3 |
| `shop.data.a.b.c.set()` over `shop.set` | yes, the path write is the main spelling. `shop.set(path, v)` stays as the array form | 2.5 |
| `follow` is no longer needed | right: `lens.here()` | 2.6 |

### 1.6 What `tap`'s argument gives: changes, nothing, or the latest copy

**Today it depends on how the function is spelled.** data reads the function's source text (code data:ops/misc.ts:598-611). No parameter: nothing. A parameter: one cloned record per row change, 1.5 to 1.8 µs each (E-55 review; the brief saw about 1.7), and never the latest copy. **Proposed: one argument per commit, by reference, with both.**

```ts
view.tap((c) => {
  c.first                         // true once: `changes` is then the picture so far
  for (const ch of c.changes)     // this commit's changes, by reference: ch.type, ch.key, ch.row, ch.prev
    patch(ch.key, ch.row, ch.prev)
  c.now                           // the latest state: the view itself. A lookup, not a copy
})
```

**What it costs** (E-55 review, `bench/connect.mjs tap2`: 10,000 rows, 200,000 field writes, the ways interleaved round by round, 3 runs; each number is the median of 9 rounds, as the range over the runs):

| What | ns a commit (one change a commit) | Against the bar |
|---|---|---|
| the harness's own noise: two copies of "no sink" | −8 to +2 | |
| a bare data sink, no lens, over no sink | 63 to 122 | |
| **`tap((c) => …)` that reads nothing, over no sink** | **92 to 198** | 50: missed |
| the lens's own share: that tap over a bare data sink | 31 to 103 | 50: not resolved |
| reading `c.changes` and each `prev`, over reading nothing | −39 to +32 | 300: met |
| reading a row through `c.now`, over reading nothing | −33 to +91 | 300: met |
| building `c.recs()`, over reading nothing | 166 to 216 | |
| data today: `tap(() => …)` over no tap | 126 to 168 | |
| data today: `tap((rec) => …)` over `tap(() => …)` | 1,525 to 1,788 | |
| freezing each row handed out, deeply, over reading the changes | 163 to 220 | |

- **A tap is not free: 0.1 to 0.4 µs a commit in these harnesses.** 0.09 to 0.20 µs here; 0.15 to 0.17 µs in E-55's first harness, 0.22 µs in the reviewer's rerun of it, and 0.29 to 0.39 µs for data's own bare `tap` in the brief's loop. The first form of this page said "about 0 per change". Any sink at all costs data's delivery of a commit, and the lens adds its commit object on top.
- **The first harness could not show this.** It ran each way in its own resource, one after another, and two copies of the same way differed by 37 to 530 ns, more than the 50 ns bar (review finding F5). The interleaved harness measures a difference inside one round; its own noise is the first row.
- **Rows are frozen on first hand-out** (2.7). That is the last row of the table.

### 1.7 Whether `derive` needs a separate function

**It does not need to be a primitive. But the plain pipe is not exactly once, and the four lines below are exact only with two more things.** v2's README did the owner's pattern in one line, with no position kept (code v2:README.md:251-271): after a restart it loses records or counts some twice. What `derive` adds is five things (cost-first 5.7): the source position inside the output's own log entry, a mark per output slot, no `await` per output (else about 240 records a second: E-55 measured 239 to 240 awaited against 122,000 to 134,000 not awaited), one runner, and no network read of rows already held. **Make the mark a write option:**

```ts
const orders = await fero<Order>('orders')                      // a client of the source
const totals = await fero<number>('totals', { server: true })   // a server of the target
for await (const e of orders.data.changes({ from: totals.marks('totals') }))
  if (e.value) totals.data[e.value.user].set(op.incr(e.value.cents), { from: e })   // not awaited: writes pipeline
```

**The two more things** (review finding F2; E-55 review, claim 21's second form):

1. **fero paces the loop.** A client may hold 512 waiting writes; past that a plain `set()` is refused `backpressure` (API 3.6). The loop does not await, so it would never see the refusal. A later write to the same output slot would then commit and move the mark past the dropped record. That record is lost for good, and no leader can see it, because a write refused on the client was never sent. **So a marked write is never refused for backpressure.** It waits in line, and the `changes()` reader its `e` came from stops yielding until the line is short again. `e` knows its reader, so there is no new option to write. A marked write that fails for another reason (a lost link, a leader that saw a gap) ends the loop with that error; started again, it resumes from the marks. (Reasoned as an API; its logic is what E-55's seeded stand-in runs as "pace".)
   - Measured, seeded, a stand-in for E-30's model: **as written, 998 of 1,000 seeds lost outputs** (7,262 outputs short; with the real cap of 512 and 4,000 records, 100 of 100 seeds lost every output). **Paced: 0 lost and 0 doubled in 1,000 seeds** (0 and 0 in 100 seeds at cap 512). Blocking the slot after a refusal, the other fix, also gave 0. With the leader's order rule switched off, a write lost in a slot move followed by a later one delivered lost outputs in 756 of 1,000 seeds, so that rule (2.8 item 3) is needed too.
2. **It runs in one process.** With `server: true`, every server process of `totals` that runs these four lines derives. The marks keep the result right (two derivers under one name: 0 doubled, E-55), but the work is done N times. Take a lock (P-10), or use `derive()` or `consumer()`, which split the work.

`derive(source, target, fn)` stays as about fifteen lines of library over those public calls. Nothing in it is a primitive (section 2.8). **It is the form the docs should show first**; the four lines are what it is made of.

---

## 2. The recommended shape

### 2.0 On one screen

```ts
import { fero, op } from 'fero'
import type { Shop } from './server.ts'
const shop = await fero<Shop>('shop')                    // a client. It holds nothing yet

const stock = shop.data.widgets.stock                    // steps: an address. No trip, no read. Not a promise
const n = await stock.get()                              // read once: here if held on purpose, else one trip. Keeps nothing
await shop.data.widgets.sell(1)                          // a method on a path: runs at widgets' leader

const live = shop.data.widgets.here()                    // hold it here, live: one SUB (the old follow)
await live.ready
live.value?.stock                                        // a sync read of what is held: one lookup

shop.data.widgets.stock.connect(el, 'textContent')       // el.textContent is kept up to date; ends with el, close() or the scope
const low = shop.methods.low(5).here()                   // a view the server named; only its changes cross
low.tap((c) => render(c.now.rows))                       // one call per commit, by reference

// writes: on a server, or on a client of a resource with no methods (V4-5: methods are the door)
await notes.data.n1.title.set('hi')                      // a write: one trip, one commit (V4-7: it shows when it commits)
await views.data['page:/'].set(op.incr(1))               // the leader computes it
```

The first form of this screen wrote `stock.set(4)` through the typed client of `shop`, which has methods. Section 2.4 says that client has no `set`, and it did not compile (E-55 claim 5). The screen above compiles (E-55 review, `types/screens.ts`).

**Seven rules a user learns.**
1. **A path is an address.** Building one sends nothing and reads nothing. It is not a promise: `await lens` gives the lens back.
2. **`get()` reads once. `here()` keeps it live. `connect(target, …)` keeps it live for the target.**
3. **Left of `here()`: plain data, and it may run on a server. Right of it: your code, here.**
4. **The wire sends whole partitions.** Hold anything inside a partition and you hold that partition (first build).
5. **A link ends at `close()`, with its scope, when its target closes, or when nobody uses it. You read what is held through what `here()` gave you.** A `connect` never makes rows readable.
6. **A `connect` function takes its target as an argument and changes nothing else.** Anything else belongs in `tap`.
7. **A method says where it may be called (`at:`), and checks what it is given.** A client picks the path and the argument.

### 2.1 The lens

- **`f.data` is a lens, and every step from it is a lens.** One `Proxy` handler serves all of them (E-55: `proto/lens.mjs`).
- **A name is a key until it is called.** `a.b.set(5)` is the verb `set` on `a.b`. `a.b.set.set(5)` writes the field named `set`. So keys, verbs, operators and methods are different spaces. 47 of 47 cases pass on the prototype, and the typed sketch compiles (E-55 claims 4 and 5, with the review's cases).
- **A lens is not a promise, and no verb is reserved.** A read is the verb `get`: `await stock.get()`.
  - The first form of this page reserved `then`, so that `await stock` read. JavaScript then treats every lens as a promise. Anything that resolves a value made a hidden trip: an `async` function that returns a lens, `Promise.resolve(lens)`, `Promise.all([lens])`. Returning the **root** lens from an `async` helper downloaded the whole resource: 100,000 rows, 6.8 MB as JSON, in one GET (E-55 review, `review/probe3.mjs`, on the first build).
  - Now `await lens` gives the lens back: 0 trips in each of those cases (E-55 review, claim 4).
  - **Seven names read as `undefined`**, because JavaScript or common libraries probe them on any object: `then` (promises), `toJSON` (`JSON.stringify`), `constructor`, `$$typeof` (React), `asymmetricMatch` (Jest), `nodeType` (DOM checks), `subscribe` (Svelte's store contract). API 3.9 already does this for `f.rows`. On the first build each of them was a function, and `JSON.stringify({ a: lens })` threw. A key with one of these names, a symbol, or a key in a variable takes `at`. A method with one of these names takes `lens.call(name, arg)`.
  - This is the pick; the other choice (keep `then`, refuse it on the root and on a partition) is the owner's call (section 7, Q11).
- **`f.at(...keys)` builds the same lens with no `Proxy`** and full types: `shop.at(sku, 'stock')`. Use it for computed keys and in hot code. **It turns a number key into its string**, as a property step does. On the first build `f.data[1].n` gave 7 and `f.at(1, 'n')` gave `undefined`: a different row, and with hashed routing a different leader (E-55 review, `review/probe4.mjs`; fixed, claim 4). Any other key type is refused `bad-key`.
- **A lens caches nothing**: 0 to 0.3 B kept per key after 100,000 keys, one and two steps deep (E-55 claim 2). data's handle today keeps every child for its parent's life: 318 B per key one step deep and 990 B two deep in the brief's bench (`bench/mem-step2.mjs`), 1,333 B two deep in E-55's (`bench/step.mjs mem`, 100,000 keys). At 1,000,000 keys that is 0.3 to 1.3 GB no line shows.
- **What a step costs** (E-55 claim 1; the lens's own share, ns a step):

  | rows | one key read again and again | a different key each time |
  |---|---|---|
  | 1,000 | 49 to 56 | 54 to 67 |
  | 100,000 | 51 to 83 | 95 to 236 (median 116) |
  | 1,000,000 | 66 to 99 | **162 to 222 (median 205)** |

  (Six or seven runs a cell: E-55's three, the reviewer's one where there is one, and the review pass's three on the changed build.)

  The bar was 150 ns. It is missed only with keys spread over 1,000,000 rows. There the read under the lens costs 1.1 to 1.3 µs, most of it cache misses, and two runs of the same cell differ by about 100 ns, so this cell is at the edge of what the harness can tell. A plain object per step, with no `Proxy`, costs 71 to 106 ns there, so the `Proxy` is about 100 ns of it. `at(k1, k2)` costs −79 to +33 ns over the direct read with keys spread.
- **A lens is for wiring, not for reading in a loop.** A read through two steps and a verb costs 0.17 to 0.29 µs with one key (E-55), and 1.6 to 1.7 µs with keys spread over 1,000,000 rows, against 0.014 to 0.06 µs and 0.60 to 0.64 µs for a `Map` read. Keep a lens you use often: `const stock = shop.data.widgets.stock`. A kept lens's verb costs −63 to +24 ns over the direct call.
- **Typed paths are new.** API.md leaves `f.data.*` untyped (API 6). Here a wrong field name, a wrong value, an early stage on a judged write, a method below its declared path, and `await lens` used as a value are compile errors (E-55 claim 5: 11 lines that must not compile, each failing for its reason).
- **What gets worse.** `typeof lens` is `'function'`. Printing needs a custom inspector (built: `console.log(lens)` prints `Lens(shop.r1.set)`). `JSON.stringify` skips a lens, and `structuredClone(lens)` throws, as for any function. Plain assignment (`f.data.k = row`) cannot be typed on a typed lens (E-55: tried four ways), so typed code writes with `set`. Assignment still works when run, and compiles on an untyped handle.

### 2.2 `connect`, `here` and lifetimes

```ts
const room = chat.data.room1.here()                       // hold room1, live. Counted; shared with every other here() on room1
await room.ready
room.rows.m7                                              // sync reads go through the handle
room.close()

chat.data.room1.connect(listEl, (el, c) => { for (const ch of c.changes) patch(el, ch) })
chat.data.room1.m7.text.connect(label, 'textContent')     // sets label.textContent now and at each commit
chat.data.room1.connect(ws, (ws, c) => ws.send(c.text())) // c.text(): one JSON text per commit, shared by every socket in the room

const page = scope(() => { /* every here() and connect made inside ends at page.dispose() */ })
```

- **What it does.** It hands over the picture so far, then each commit. No gap, no overlap (data's SCHEDULE clause 7; E-31 across the network). E-55 claim 7: 93,326 sinks in 1,000 seeds in one process, and 1,000 seeds across 4,337 disconnects over a real port: 0 changes missed, 0 twice.
- **Two forms.** `connect(target, (target, c) => …)` and `connect(target, 'prop')`. data has the second today (code data:api/index.ts:362-374).
- **The function gets its target as an argument.** fero holds the function strongly and the target weakly. A function that closes over its target keeps it alive for good (E-55 claim 15: never collected). fero cannot check this for a plain object. For a DOM node it can warn: the node says it is detached and is still being fed.
- **A link ends at the first of these.**

| How | When | For what |
|---|---|---|
| `link.close()` | at once | anything |
| its **scope** ends | at once | a component, a route, a request, a method handler. data's `render` makes one scope per mount (code data:render/index.ts:1002-1030) |
| the target **says it closed** | at once | only the kinds fero names: a Node `EventEmitter` (sockets, streams, the `ws` library), a `WebSocket`, a `MessagePort`. fero listens for `close` once. Any other object is left alone unless the call names its event: `connect(t, fn, { closes: 'end' })`. The first build called `.once('close', …)` on anything that had a `once` method (review F19) |
| the **count** reaches zero | after a short linger, then the unsubscribe is sent | every `here()` and `connect` on one selection in a process shares one SUB and one fold (E-55 claim 9: exactly one SUB, one decode and one `c.text()` per commit for 2,000 links) |
| the target was **collected** | some time later, or never | the net: a DOM node other code removed; a dropped handle |

- **Why the collector is only the net.** 1,000 dropped targets, no forced collection:

| Where (source) | The dropped targets were | The process then | First link ended after | Ended within 30 s |
|---|---|---|---|---|
| Node (cost-first, `cost-bench/fin-time.mjs`) | young | idle | 16.2 s | 999 of 1,000 |
| Node (cost-first) | young | busy | 1.3 s | 999 |
| Node (cost-first) | old | idle | 8.1 s | 999 |
| Node (cost-first) | old | busy | **never** | **0** |
| Node (E-55 claim 13) | young | idle | 1.2 to 1.4 s | 999 |
| Node (E-55) | young | busy | 7 to 8 ms | 999 |
| Node (E-55) | old | idle or busy | 0.33 to 0.40 s | 1,000 |
| **Chromium 153 (E-55)** | DOM nodes, removed | idle, busy, or a commit every 10 ms | **never** | **0** |

  The two Node harnesses differ in how they aged the targets; both say the collector, not the program, picks the moment. Until then the server keeps sending and this process keeps decoding: one commit with 1,000 dropped, uncollected targets cost 0.80 to 0.90 ms and all 1,000 functions still ran (E-55 claim 12). fero v4's V4-54 wrote down the same cost. So the docs call the collector a net only, and the dev warning is required (claim 13's condition).
- **Three rules make the net harmless.** E-55's seeded adversary ends each dropped link at a random step, from "at once" to "never". With all three rules, a program gave **1 result, and 1 pattern of reads served here or by a trip, over 1,000 collector seeds** (claim 14, E-55 review).
  1. **Before each delivery the link checks its target.** A dead target is never called, and its link ends at that commit even if no finalizer ran (claim 12: 1,000 of 1,000, 0 calls).
  2. **Only rows held on purpose can be read here.** `room.rows`, `room.value` and views made from `room` read through the handle. `f.rows` shows only a server's rows or `hold: 'all'`. **`lens.get()` is served here only when the partition is held on purpose**: a server, `hold: 'all'`, or a live `here()` or `tap` on it or on the whole resource. Rows that only a `connect` keeps never serve a read; the read takes a trip.
     - The first build broke this for `await lens`: it read locally whenever any selection held the rows. The same program made 0 GETs, or 1 GET and an UNSUB, by whether a collection ran (review, `review/probe2.mjs`). Over 1,000 collector seeds a program showed 9.7 different here-or-trip patterns (E-55 review, the planted bug `weakread`).
     - **Every GET carries the highest position this process has seen**, and waits for the process's own early-answered writes (rule Y). A copy that is behind waits before it answers, so a process never reads backwards when a link ends and the next read goes to another copy (reasoned; the prototype has one server, which cannot be behind, so this is counted but not tested).
  3. **A `connect` function changes only its target.** A dropped target is alive until it is collected, so its function keeps running for a time the collector picks. When half the dropped links also wrote a shared counter, a program gave 433 different results per 1,000 seeds (E-55 claim 14, control 2). Anything that changes more belongs in `tap`.
- **What still depends on the collector, and is a cost, not a result:** how long a dead link's SUB lives. The count of SUBs a client sent differed 3 ways per program over the seeds (E-55 review). That is the cost row "a dead link the net has not found" (section 3).
- **This goes beyond data's rule.** data keeps `WeakRef` only as a dev-mode leak detector: "GC timing can never change observable results" (code data:kernel/scope.ts:1-3). The lens puts the collector on a live path, as a net. The three rules are what keep data's sentence true for results, and they let the seeded simulator switch the net off or fire it at a random step.
- **A dev warning** names the path of a link the net had to end.
- **Selections that overlap** (E-55 claim 7; not in the first form of this page). A partition held inside a held whole resource sends no SUB of its own. When the whole ends, the partition subscribes again from the whole's server position. A resume cursor is always the server's position, never the client's own commit number, and a client drops a frame it already applied. Without these, 75 frames were applied twice in 1,000 seeds.
- **`get` reads once and holds nothing.** `lens.get()` is one trip on a miss and keeps no subscription (E-55 claim 20: 100,000 misses, 100,000 GETs, 0 SUBs, 0 rows kept). API.md's `get` follows its key for the life of the handle (API 3.3); that is a slow leak the line does not show.
- **`hold`.** The default client holds nothing until it says `here()` or `tap`. `shop.data.here()` is the visible line for "everything". `hold: 'all'` stays as that line said in the options.
- **`hold: '200MB'` is a cache of pictures, not a subscription** (review F14; reasoned, not built). When the last link on a selection closes, the unsubscribe is sent after the linger, as always. Inside the bound, the rows stay in memory, least recently used first, with the server position they were good at. They are **not held on purpose**: no read is served from them. A re-open sends that position. If the server can still resume from it (its ring of recent frames, or the log when the resource has `history`), only the changes since cross. If not, a new picture crosses. So a re-open is a resume or a download, never free. The other choice, staying subscribed while warm, would have the server send, and this process decode and fold, every change to every warm partition for nobody; the bound would then have to cap bytes a second too. This changes the tour's ten lines (section 7, Q1).

### 2.3 The line between server work and local work

**A computation can run in seven places** (space, section 2). Today's API names four of them with four unrelated words, and one has no name.

| # | Place | Who pays, per change | Today | With the lens |
|---|---|---|---|---|
| 1 | a local view on rows held here | this process: about 1 µs per affected filter view (E-05); 1.6 to 62 µs for an ordered view with a window, by partition size (E-55 claim 16) | `f.data.gt(…)` | anything right of `here()` |
| 2 | the server sends only some partitions | the server: a route lookup, 1 to 4 ns, no encode (PATHS 4.5) | `f.follow(of)` | a path, then `here()` |
| 3 | the server sends part of a partition | the server: the view's own cost (as in place 1) and one encode per change per shape | none | plain-data operators inside one partition, then `here()` (second step) |
| 4 | a served view over every row | the server: the view's work, one encode per view change | a method that returns a view, `.open()` | the same method, then `here()` |
| 5 | a method: your code on a server, once | the server: one run | `f.methods.x(arg)` | the same; on a path, the path picks the leader |
| 6 | a derived resource | the deriver: one run and a share of a commit per source record | `derive()` | a `changes` loop with `{ from: e }` |
| 7 | a chain split across the network | both, each for its part | by hand | operators left and right of `here()` in one line |

**What may stand left of `here()`.**

| Class | Example | The server's work | Guard |
|---|---|---|---|
| **A. a partition** | `chat.data.room1.here()` | routes committed bytes; encoded once for all readers (0.01 to 0.46 µs per record per reader, PATHS 0) | read rules, once per subscription |
| **B. inside one partition**: a row, a field, plain-data operators | `chat.data.room1.gt('stars', 0).top(10).here()` | **first build: the same as A**; the partition crosses and the operators run here. **Second step:** a view per distinct shape on a copy | bounded by the partition; when pushed down, the cap below |
| **C. over the whole resource** | `shop.methods.low(5).here()` | whatever the author's view costs; shared by equal calls | **the door (V4-5) says which views**: only a declared method. **A cap says how many**: live served views per client and per resource |

- **A function left of `here()` does not compile**, and is refused `unencodable` in untyped code (E-55 claims 4 and 5). Code cannot travel (brief fact 12). `filter(fn)` and `map(fn)` go right of `here()`, or inside a method. The compile error reads "This expression is not callable"; the types should say why.
- **A whole-resource operator left of `here()` on a process that does not hold the resource is refused `not-held`**, as today (API 3.9). The hint names the two ways out: a method, or `shop.data.here()`.
- **Why class C needs a method.** A view a client makes up over every row is work on every write on a server: 100 distinct filters cost 9 to 18 µs a record, and `group` costs 2,574 µs a record at 1,000,000 rows (E-05). `methods:` is how the server's author says what clients may ask for.
- **Why class C also needs a cap** (review F7). The door limits which views a client may ask for, not how many. Each distinct argument is its own served view. A client that calls `low(i)` in a loop makes the server keep, and update on every write, as many views as it likes. A served view costs the server 9.9 KB to 12.8 MB of memory (E-55 claim 16) and its own CPU per change. So: a limit on live served views per client and per resource; past it the SUB is refused `too-many-views`, with a hint (reasoned; not built: the prototype has no class C). API.md's `.open()` owes the same cap. It is counted in 4.4.
- **Why class B waits.** The honest sentence for the first build is rule 4: **the wire sends whole partitions**. `chat.data.room1.m7.text.connect(…)` holds `room1`. The line looks finer than the wire, so the docs must say so. With a row per partition (the default) the row is the partition, and the first build is already exact.
- **What pushing class B down buys and costs** (E-55 claim 16; the server holds one data view per distinct shape):

  | | The partition crosses, the view runs here | The view runs on the server, its answer crosses |
  |---|---|---|
  | first picture on the wire, per shape | the partition: 6 KB (100 rows) to 6.6 MB (100,000 rows) | the answer: 677 to 765 B |
  | wire bytes per change | 60 to 63 B | 0 to 32 B for one shape; **26 KB for 1,000 shapes of a 100-row room** |
  | CPU per view per change | the client: 1.6 to 62 µs | the server: 2.3 to 5.2 µs at 100 to 1,000 rows, 8 to 12 µs at 10,000, 51 to 53 µs at 100,000 |
  | memory per shape | the client's | the server's: 9.9 KB to 12.8 MB |

  **The view costs about the same on either side.** Pushing it down moves that CPU and memory from each reader to the server, and saves each reader the partition's bytes and decodes. It cannot make the view cheaper. The first form of claim 16 asked for at most 1 µs per view on the server; no placement can meet that for an ordered view, so that bar said nothing about pushdown. It is restated in section 6.
- **So class B is not built yet, for three reasons** (not for the old bar): there is no budget for shapes (the cap above would have to cover them); the SUB's `view` selector is still unmodelled (claim 22); and the order channel below must be part of the wire.
- **Moving `here()` changes cost, never the settled answer, only if the order travels with the rows** (E-55 claim 17). Where an ordering operator (`za`, `top`, `reverse`, `limit`) stands last left of `here()`, its answer is an order. A client that keeps the rows in a plain keyed copy loses it: 239 of 1,000 seeded runs gave a different answer. Keeping data's order channel (the place of each added row, and `move` records) beside the copy: 0 of 1,000. So class B pushdown can be added later with no change to any app line, if the wire carries the order and the client keeps it. Also, `limit` and `reverse` follow arrival order (code data:ops/ordered.ts:540-562); a copy filled in another order than the source was not tested.
- **On the wire.** No new verb. A SUB's `view` selector carries `{ method, arg }` (class C) and, later, `{ path, ops }` (class B). Section 3 has the costs.

### 2.4 Methods on a path

```ts
// ── server.ts
const stock = await fero('stock', {
  data: {} as Record<string, Item>,
  methods: {
    sell: { at: 'row', run: (n: number, ctx) => ctx.at.left.set(op.incr(-n, { min: 0 })) },   // ctx.at: the row the call was made on
    low:  (max: number, ctx) => ctx.data.lt('left', max),                                     // a bare function: the root only. Returns a view
  },
})
export type Stock = typeof stock
// ── client.ts
const client = await fero<Stock>('stock')
await client.data.widgets.sell(1)          // goes straight to the leader of widgets' partition: one trip, one commit
const low = client.methods.low(5).here()   // no path: any server
```

- **The caller's line carries the row**, so there is no `near` hint to store or learn. The cost is `near`'s: one trip and one commit, "the least a call can cost" (PA-25). E-55 claim 18 (a stand-in: the leader table and the forwarding are written in the bench): 1,000 path calls made 1,000 trips and 1,000 commits; after a leader moved, one redirect, then one trip again; with no path an extra trip 0.66 of the time with three servers and 0.80 with five.
- **A method declares where it may be called, and the server checks it** (review F8). A bare function may be called only with no path: `f.methods.low(5)`. To be called on a path it says which kind: `{ at: 'row' | 'partition' | 'any', run }`. The server refuses any other path with `bad-path`, and the types offer the method only on lenses of that kind.
  - Why: under V4-5 a method is the only door, and a client picks the path. The first build put every method on every lens at every depth. `widgets.left.sell(1)` then ran `ctx.at.left.set(…)` on the field `widgets.left` and turned `left: 5` into `{ left: {…} }`: a client changed the row's shape through the door (review, `review/probe1.mjs`). Types do not stop an untyped or hostile client.
  - Measured on the changed prototype: 202 of 202 calls on a wrong path refused, 0 commits (E-55 review, claim 18); the three wrong lines do not compile (claim 5).
  - What it costs: one declared word comes back where `near: true` stood. It is a guard the server enforces, not a hint the client must learn.
- **It is for speed, never for safety.** A method is not a transaction (API 3.8). The op, the condition or `set(fn)` makes the write safe. And a method must still check its argument.
- **A path that spans partitions has no leader.** A method declared `at: 'any'` then runs anywhere, as today. `f.methods.name(arg)` stays as the spelling for a call with no path.
- **The clash.** On a lens, fero's own verbs and operators win. A method named like one (`set`, `top`) is still reached by `f.methods.top(…)` at the root and by `lens.call('top', arg)` on a path; the typed lens shows which you get. A verb fero adds later could shadow a method somebody wrote; that is a real cost of the shared space (section 7, Q3).
- **V4-5 is unchanged**, and now shows in the types: the typed client lens of a resource with methods has no `set` and no `remove` (API 11.1 question 10).

### 2.5 Writes on a path

```ts
const w = shop.data.gizmos.set({ stock: 7, price: 9 })      // a whole row: a handle with early stages (V5-11)
await w.received
await shop.data.widgets.stock.set(4)                        // a field: answers at its commit
await shop.data.gizmos.set(row, { if: { absent: true } })   // a condition
await shop.data.widgets.set((w) => w && { ...w, price: 12 })
await shop.data.gizmos.remove()
await shop.set([sku, 'stock'], 4)                           // the array spelling of the same write
```

(These lines are a server's, or a client's of a resource with no methods.)

- **The path write is the main spelling.** The address is one thing and the verb another, so a component handed `stock` can write it without knowing where it sits.
- **`f.set(path, v)` stays** as the plain call every other form turns into. It needs no `Proxy`; `ctx.set` and `batch` items use it.
- **`f.data.set(k, v)` goes.** It was a third spelling of the same write (API 3.4). **Three spellings stay**: plain assignment (untyped code), `lens.set(v)` (and `f.at(…).set(v)`, the same call with no `Proxy`), and `f.set(path, v)`.
- **Same record, same handle, same stages.** One ASK, encoded once at the issuer (PA-13). Only a plain row `set` has `received` and `replicated`; the types know where a lens points (E-55 claim 5).
- **What the lens adds to a write** (E-55 claim 3, over `f.set([k, 'n'], v)`, a local data write of 0.7 to 1.3 µs): with two steps +0.18 to +0.73 µs (medians 0.31 to 0.47 by size); a kept lens −0.03 to +0.42 µs (medians 0.16 to 0.28); `at()` about 0. v4's whole issue path is 7.7 to 8.3 µs (PATHS 2.6).
- **Two writes are two records.** `a.b.c.set(v)` then `a.b.d.set(w)` are ordered when `a` is the partition; all-or-none takes a `batch`.

### 2.6 What replaces `follow`

| Today | Becomes |
|---|---|
| `f.follow('room1')` | `f.data.room1.here()` |
| `f.follow(['a', 'b'])` | two `here()`s in one scope; they ride one link (reasoned) |
| `f.follow({ prefix: 'ada' })` | with `depth: 2`: `f.data.ada.here()`. No walk of partition names (API 3.2) |
| `f.follow({ share })` | stays inside `consumer`; it was never an app's call |
| `f.methods.low(5).open()` | `f.methods.low(5).here()` |
| `await f.get(k)`, which then followed `k` | `await f.data[k].get()`: reads once, holds nothing |
| `await f.get(k, { hold: false })` | the same line |
| `hold: 'all'` (the default) | `f.data.here()`, or `hold: 'all'` said out loud |

### 2.7 `tap`

Section 1.6 has the shape and the cost. More detail:
- **One call per commit**, so a DOM sink batches its patches. A commit holds at most one change per row (SCHEDULE clause 8).
- **`c.changes` and `c.now` are by reference and made only when read.** On the first call `c.changes` walks the picture so far as adds; that loop is O(rows held) and it is in your code.
- **A row handed to a sink is frozen, deeply, on its first hand-out** (review F15). SCHEDULE clause 11 calls by-reference values "shared-immutable". Without a freeze that is only a promise: a sink that changed a row would corrupt the store and every other sink of that commit. API.md's `f.rows` already pays this freeze on first read (DATA-07). The prototype's sinks did not freeze. Measured in a sink (E-55 review): 163 to 220 ns per changed row for E-05's small row. The other choice, a user rule "a sink must not change a row", costs nothing to run and is not picked: it cannot be checked.
- **`c.recs()` and `c.text()`** give the wire-shaped records and their JSON text for code that forwards them. Each is built once per commit and shared by every sink that asks (E-55 claim 9: 100 builds for 100,000 deliveries). Building `c.recs()` costs 0.17 to 0.22 µs a commit.
- **`tap(fn)` is the strong form**: it lives until `close()` or its scope. `connect(target, fn)` also ends with its target. Both get the same `c`.
- **Views right of `here()` end with their handle** (data's D6; review F4). `room.gt('stars', 0).tap(fn)` is a view made from `room`. When `room` closes or its scope ends, the view is released and `fn` is never called again. `room.gt(…).top(10).connect(el, fn)` is a weak link like any other `connect`. The first build did neither: a view's tap ran after `close()`, and that `connect` held its target for good (review, `review/probe1.mjs`). Fixed and checked: 59,958 view sinks in 1,000 seeds, ended by `close()`, a scope, the seeded collector or `link.close()`, with a linger: 0 calls after the end, 0 views left (E-55 review, claim 26; the first build's behaviour, planted, fails every seed).
- **`changes()` gives something else on purpose**: log records, every one, in order, with no `prev`. A count needs `changes()`; a slow `here()` reader is conflated to one change per row (LAYERS 4).

### 2.8 `derive` as a pattern

The four lines in 1.7 are exact across any restart only if the API gives nine things (space 5.7; reasoned from E-30; E-55's seeded stand-in is not E-30's model):
1. **`{ from: e }` on any write**: the write and "source record `e` is applied" land in one log entry of the target.
2. **The leader skips a marked write at or below its stored mark**, and answers it as done.
3. **Order per writer per output slot**: the leader takes a writer's write n only after its write n−1. v5's issue order gives it; its model across a slot move is owed (LAYERS 3.6). E-55 review: with this rule off, a write lost in a slot move followed by a later one delivered lost outputs in 756 of 1,000 seeds.
4. **Marks move with their slot and ride snapshots** (E-30: kept per group, a move loses an output; E-55: a move that drops its marks doubled outputs in 1,000 of 1,000 seeds).
5. **`target.marks(name)`** reads the marks back as a cursor.
6. **`target.mark(e)`**: a bare mark, for a source record that writes nothing.
7. **The source keeps its log back to the marks** (`history`).
8. **A marked write is never refused for backpressure.** It waits, and the reader that `e` came from stops yielding while the target has 512 waiting writes (1.7).
9. **A marked write that fails for another reason ends the loop with its error.** The loop is started again from the marks.

- **Without bare marks the four lines restart from far back.** `marks()` is the lowest mark over the output slots. A slot that got no output for a while holds the cursor back, so a restart reads again every source record since then (each is skipped at its mark), and the source must keep its log that far. `derive()` sends bare marks so that idle slots keep up.
- **`derive()` and `consumer().run()` stay as library code** over these. They earn their names: they cannot be written the slow way, they send the bare marks, they run once, and they split the source's shares so three servers do the work once.
- **A marked write answers at commit only**: it can be skipped, so it takes no early stage (V5-11 ruling 6).
- **By hand without the mark** the loop is at least once from a saved cursor, and at most once from `'latest'`.

### 2.9 Time travel

```ts
const past = await shop.data.widgets.asOf(cursor)   // a partition, as it was. Or a version, or a writer time (V5-4). Read-only. Folded here
past.value                                           // the row as it was: about 1 µs
past.step(-1); past.step(+1)                         // one commit back, one forward: a number changes
past.seek(otherCursor)                               // a jump: a number changes
past.close()
const all = await shop.data.asOf(cursor)             // the whole resource as it was: every partition is folded. Costly; see below
all.lt('stock', 5)                                   // data's operators work on it; they run here
```

- **A past state is a read handle, never a change to the live rows.** No server keeps versions, and no write pays for a reader it does not have (E-54).
- **How.** One log-mode SUB from the nearest kept snapshot at or before the position. The reader keeps a sorted list of versions per row (fat nodes as per-row lists; E-54's hot-row finding rejects the smaller back-pointer layout).
- **A step is one commit, not one record.** data gives `prev` once per row per commit (code data:contract/delta.ts:101-103; E-54), and nobody can see a state inside a commit. So `step(-1)` after a write lands before that write's whole batch.
- **What it costs to open** (E-55 claim 23, on data's real fold; reasoned for the sum): the snapshot load, O(rows) once (LAYERS 8.7), then every record from the snapshot to the position: a decode, then the fold with the version lists, 3.6 to 4.4 µs a record (the lists are +1.5 to 2.0 µs of it; the decode is not in that number). A million records since the snapshot is about 4 s. `shop.data.asOf(p)` pays that for every partition; **prefer `asOf` on a partition lens**, which reads one partition's log.
- **What it costs to hold:** 103 B a version at 100,000 rows and 285 B at 1,000,000 (E-55; heap after minus heap before, the same measure as E-54's 104 to 219 B beside a `Map`). Memory grows with the window, so close it.
- **What a read costs** (E-55): a step or a jump 10 to 12 ns; a row at any version 0.6 to 1.4 µs; a row with 150,473 versions 0.14 to 0.21 µs; 0 wrong answers in 1,680 checks against a refold.
- **It needs the log to reach back**: `history` on the resource, or the tier. Past it: `expired`.
- **Forks, tapes and restore are unchanged** (V5-1).
- **What would change this:** a version per write under about 0.2 µs and 20 B on the live path with the collector under 1 %, or a user on the live path (a handler that must read several rows as of one position). The cheapest that can jump costs +1.0 µs and 104 B beside a `Map`, on a reader.

### 2.10 The 22 patterns, side by side

Key lines only. `// today` is API.md section 10's line. `// lens` is this page's. **The lens lines compile**: E-55 checks them against a sketch built on API.md's own declarations (`types/patterns.ts`, tsc 6.0.2, exit 0). The first form of this page had four lines that needed an edit, one of them a real defect (P-01 began with `(`, so the line before it was called); the lines below are the edited ones, with reads as `get()` and P-14's method declared `at: 'row'`. **They were not run end to end** (claim 25). Guarantees and evidence are API.md's unless a note says otherwise.

```ts
// P-01 live shared state
shop.data.tap(() => console.log(shop.rows))                             // today (server)
shop.data.tap((c) => console.log(c.now.rows))                           // lens
const ack = await client.set('gadgets', { stock: 4 })                   // today
const ack = await client.data.gadgets.set({ stock: 4 })                 // lens
client.rows.widgets?.stock                                              // today: the client holds every row
const w = await client.data.widgets.get(); w?.stock                     // lens: one trip, nothing held; or client.data.here() first

// P-02 cache with expiry
await cache.set('hot', { n: 1 }, { ttl: '30s' }); await cache.touch('user:42')              // today
await cache.data.hot.set({ n: 1 }, { ttl: '30s' }); await cache.data['user:42'].touch()     // lens

// P-03 near cache, client data sync
const u = await users.get('u42'); const same = users.rows.u42           // today: the miss follows u42 for good
const mine = users.follow(['u42', 'u43'])                               // today
const u = await users.data.u42.get()                                    // lens: read once, nothing kept
const me = users.data.u42.here(); await me.ready; me.value              // lens: held and live, by choice

// P-04 read-through cache
await prices.get('sku-1')                                               // today
await prices.data['sku-1'].get()                                        // lens

// P-05 websocket fan-out by room
await fero('chat', { server: true, partition: { before: '/' }, rows: { ttl: '1d' }, history: '1d' })   // today
const live = chat.follow(room); live.tap((rec) => ws.send(JSON.stringify(rec))); ws.on('close', () => live.close())
chat.data[`${room}/${fero.id()}`] = { text, at: fero.now() }
await fero('chat', { server: true, depth: 2, rows: { ttl: '1d' }, history: '1d' })                     // lens
chat.data[room].connect(ws, (ws, c) => ws.send(c.text()))               // one JSON text per commit per room; ends when ws closes
chat.data[room][fero.id()].set({ text, at: fero.now() })

// P-06 pub/sub
const sub = news.changes({ of: 'sports' }); await news.set('sports', { headline })          // today
const sub = news.data.sports.changes(); await news.data.sports.set({ headline })            // lens

// P-07 streams and replay
events.changes({ from: savedCursor ?? 'earliest', until: 'latest' })                        // today
events.changes({ of: 'order:981', from: ack.version })
events.data.changes({ from: savedCursor ?? 'earliest', until: 'latest' })                   // lens
events.data['order:981'].changes({ from: ack.version })

// P-08 consumer groups
invoicing.run((e, out) => out.use(invoices).set(e.partition, { order: e.value, at: e.time }))               // today
invoicing.run((e) => invoices.data[e.partition].set({ order: e.value, at: e.time }, { from: e }))           // lens: the mark is on the line
for await (const batch of await consumer(orders, 'billing')) { /* … */ await batch.commit() }               // both: at least once

// P-09 work queue: unchanged
work.work(async (job) => { await resize(job.url) })

// P-10 locks
await ledger.set('run-42', { by: process.pid }, { if: { lock: l } })                        // today
await ledger.data['run-42'].set({ by: process.pid }, { if: { lock: l } })                   // lens

// P-11 counters and rate limits
const a = await views.set('page:/', op.incr(1))                                             // today
const a = await views.data['page:/'].set(op.incr(1))                                        // lens

// P-12 leaderboards, live aggregates
const live = fan.methods.top(10).open(); live.tap(() => render(live.snapshot()))            // today
const live = fan.methods.top(10).here(); live.tap((c) => render(c.now.rows))                // lens: the same served view
fan.methods.top(10).here().map((s) => s.player).connect(board, 'rows')                      // lens: top on a server, map here

// P-13 presence
const online = await fero('online'); await online.set('ada', { since: fero.now() })         // today: holds every row by default
const all = online.data.here(); await online.data.ada.set({ since: fero.now() })            // lens: "holds every row" is a line

// P-14 invariants
sell: { near: true, run: async (sku: string, ctx) => (await ctx.set([sku, 'left'], op.incr(-1, { min: 0 }))).value }   // today
sell: { at: 'row', run: async (_: void, ctx) => (await ctx.at.left.set(op.incr(-1, { min: 0 }))).value }               // lens
await client.data.widgets.sell()                                        // lens: at widgets' leader; one trip, one commit

// P-15 transactions across partitions
await saga([{ to: accounts, key: ['alice', 'cents'], value: op.incr(-5000, { min: 0 }) }])  // today (a saga step)
await saga([{ at: accounts.data.alice.cents, value: op.incr(-5000, { min: 0 }) }])          // lens: a step takes one lens

// P-16 event sourcing, CQRS
for await (const e of facts.changes({ from: 'earliest', until: 'latest' })) apply(e)        // today
for await (const e of facts.data.changes({ from: 'earliest', until: 'latest' })) apply(e)   // lens

// P-17 derived resources
await derive(orders, totals, (e, out) => { if (e.value) out.set(e.value.user, op.incr(e.value.cents)) })   // today
await derive(orders, totals, (e) => { if (e.value) totals.data[e.value.user].set(op.incr(e.value.cents), { from: e }) })   // lens: the library, shown first
for await (const e of orders.data.changes({ from: totals.marks('totals') }))                               // lens: what it is made of (1.7)
  if (e.value) totals.data[e.value.user].set(op.incr(e.value.cents), { from: e })

// P-18 tapes, forks, replays
await fero.fork('shop', { as: 'shop-try' })                             // both: unchanged
const before = (await shop.data.k.asOf(ack.version)).step(-1)           // lens, new: the row just before that write's commit

// P-19 clients everywhere (a browser)
const cart = shop.follow({ prefix: 'ada' }); cart.tap(() => render(cart.rows))              // today
shop.data.ada.connect(el, (el, c) => render(el, c.now.rows))            // lens: with depth 2 a cart is a partition

// P-20 change the shape of rows: unchanged (fero.alter, migrate)
// P-21 request and reply: unchanged (service); or a method on a path
// P-22 delayed jobs, waiting takes, priorities: unchanged (queue)
```

**What moved on the wire** (reasoned): P-03's miss sends one row and opens no stream. P-05 keeps no partition index (PA-17) and builds one JSON text per commit per room, not one per socket. P-14 is the same single ASK to the row's leader. P-19's first picture walks one partition, not every partition's name. The rest send the same bytes as today.

---

## 3. Costs per construct

"Adds" and "removes" are against today's API.md. A dash means no change. Where E-55 measured the construct on the prototype, its number stands here and the study's earlier number is gone; E-55's numbers are the lens's and data's share in one process, never a whole fero write (v4's issue path is 7.7 to 8.3 µs, PATHS 2.6).

| Construct | Trips | Bytes on the wire | Decodes and folds | Whole-resource work | Memory | Against API.md | Source |
|---|---|---|---|---|---|---|---|
| a step, `f.data.a.b` | 0 | 0 | 0 | none | 0 to 0.3 B kept per key | removes data's 318 to 1,333 B per key kept for ever. Costs an allocation and a `Proxy` per step: 49 to 99 ns with one key; 162 to 222 ns (median 205; bar 150) with keys spread over 1e6 rows | E-55 claims 1, 2 |
| `f.at(k1, k2)` | 0 | 0 | 0 | none | 0 | −79 to +33 ns over the direct read with keys spread; 54 to 154 ns with one key at 1e6 rows | E-55 claim 1 |
| a sync read through a lens | 0 | 0 | 0 | none | — | two steps and a verb: 0.17 to 0.29 µs with one key, 1.6 to 1.7 µs with keys spread over 1e6 rows; a `Map` read 0.014 to 0.06 µs and 0.60 to 0.64 µs. So `rows` stays | E-55 claim 1 |
| `lens.get()` held on purpose | 0 | 0 | 0 | none | — | — | E-55 review, claim 14 |
| `lens.get()` not held on purpose | 1 | the value, and the highest position seen | 1 | none | **nothing kept**: 0 rows and 0 SUBs after 100,000 misses | removes the hidden follow per `get`. A read never comes from rows only a weak link keeps, so it costs a trip even when such rows are in memory | E-55 claim 20; PATHS 4.4 |
| `lens.set(v)` | 1, and a share of one disk sync | one record, encoded once | — | none | — | the same ASK. The steps add 0.18 to 0.73 µs to a 0.7 to 1.3 µs local write; a kept lens −0.03 to +0.42 µs | E-55 claim 3; PATHS 2.6 |
| `lens.method(arg)` | 1, to the partition's leader | the path and the argument | — | none | — | the same as `near`; removes the stored hint; adds the path check on the server. No path: an extra trip 0.66 of the time with 3 servers | E-55 claim 18 (a stand-in); PA-25; V5-9 |
| `lens.here()` on a partition | 1 SUB | the partition once, then one shared frame per change | here: about 3.2 µs decode and 0.2 to 1.9 µs fold a small row | none; a 100-row room's first picture is 26 to 28 µs in the prototype (0.15 to 0.22 ms right after a full collection), at 1e5 rows in all | the partition's rows | the same as `follow` | PATHS 4.5; E-55 claim 6 |
| a second `here()` or `connect` on it | 0 | 0 | 0 | none | a count | a lookup and a count: 39 to 45 ns; a second `here()` 163 to 169 ns | E-55 claims 6, 9 |
| `lens.connect(target, …)` | as `here()` | as `here()` | as `here()`, then the sink | none | a `WeakRef` and a registry entry | registering the target: 0.13 to 0.33 µs in ordinary jobs; **0.58 to 0.67 µs in one long job that made about 150,000** (a `WeakRef` keeps its target alive to the end of its job). **Per commit: +28 to +35 ns per weak link** (the target check is 26 to 35 ns of it); 10,000 weak links cost 2.2 times 10,000 strong sinks | E-55 claims 6, 11 |
| a dead link the net has not found | 0 | the selection's changes go on | decode and fold go on; its function still runs (0.80 to 0.90 ms a commit for 1,000) | none | the selection | **a cost the line does not show**: 7 ms to never; never within 30 s in Chromium. `close()`, a scope or the count is the fix | E-55 claims 12, 13 |
| a field or row lens inside a big partition | — | **the whole partition** (first build) | all of its changes | none | the partition | the lens looks finer than the wire; rule 4 says it | brief 4.9; reasoned |
| K lenses on K rows, per commit | 0 | 0 | — | **today O(K)**: 26 µs a write at K=1,000, 368 to 397 µs at 10,000. With a keyed index 1.57 to 2.50 µs at K=10,000 against 1.23 to 1.65 µs at K=0: the ratio is 1.09 to 1.52 over 15 runs, median 1.25 (bar 1.3) | an index entry per lens | the one data change the lens cannot do without (D1) | E-55 claim 8 |
| `methods.x(arg).here()` | 1 SUB | the view's answer, then only its changes | the view's work on a server, once for all equal calls | whatever the author wrote | per view, on a server: 9.9 KB to 12.8 MB in E-55's shapes | the same as `.open()`; adds the cap on live served views. v4 paid 4.4 to 4.6 µs per subscriber against 2.0 to 2.4 µs shared. **Not built on the prototype** (claim 27) | PATHS 4.5; E-55 claim 16 for the memory |
| operators right of `here()` | 0 | 0 | a filter about 1 µs per affected view (E-05); an ordered view with a window 1.6 to 62 µs a change by partition size; `group` 2,574 µs a record at 1e6 rows | as the operator | the view; released when its handle ends | — | E-05; E-55 claims 16, 26 |
| class B pushed down (second step) | 1 SUB | only the answer: 677 to 765 B first, 0 to 32 B a change per shape (the partition: 6 KB to 6.6 MB, 60 to 63 B) | the same view, on a server: 2.3 to 53 µs per view per change; one encode per shape per change | bounded by the partition | 9.9 KB to 12.8 MB per shape on the server | moves the view's CPU and memory to the server; saves the partition's bytes and decodes per reader; adds 4 rules, the order channel and a cap | E-55 claim 16 |
| `tap((c) => …)` | 0 | 0 | 0 | none; the first `c.changes` walks what is held | 0 | 92 to 198 ns a commit over no sink when it reads nothing (63 to 122 of it is data's delivery to any sink); reading `c.changes` or `c.now` adds nothing measurable; `c.recs()` adds 166 to 216 ns. Removes 1.5 to 1.8 µs a change for a tap that names a parameter | E-55 review, claim 10 |
| a row handed to a sink, frozen | 0 | 0 | 0 | none | 0 | 163 to 220 ns per changed row on first hand-out (a small row) | E-55 review, claim 10 |
| `set(v, { from: e })` | 1, a share of a commit | +29 B | — | none | a mark per reader per slot pair | the same as `derive`'s output. Not awaited: 122,000 to 134,000 a second against 239 to 240 awaited, with a commit every 4 ms | E-30; PATHS 4.9; E-55 claim 21 |
| `asOf(pos)` | 1 log-mode SUB | the window's records once | decode, fold, +1.5 to 2.0 µs a record for the version lists; a step 10 to 12 ns; a row at a version 0.6 to 1.4 µs | a snapshot load if the position is before the window; `f.data.asOf` folds every partition | 103 to 285 B a version, in the reader only | new; nothing on any write | E-54; E-55 claim 23 |
| `depth: 2` | — | the key gains 2 B | partitions of 100 rows and more: the fold is 0.78 to 1.10 times flat with PA-17's index. One-row partitions: 1.3 to 1.5 times (D3 not built) | removes the partition-to-rows index kept per fold | 1.2 to 805 KB **less** a partition than the index at 100 rows and more; +0.9 KB for a one-row partition | removes `{ before }`'s text split and PA-17's index | E-55 claim 19 |
| `hold: '200MB'`, a closed selection kept warm | 1 SUB at re-open | a resume (the changes since) if the server can; else the picture again | — | none | the warm rows, inside the bound | no bytes or decodes while closed; a re-open is never free | reasoned (review F14) |

---

## 4. What changes

### 4.1 Where the three proposals disagreed

"Taken" is the first form of this page. The last column says what the build or the review then changed.

| Question | Lens-first | Cost-first | Space | Taken | Why | After E-55 and the review |
|---|---|---|---|---|---|---|
| What is the lens? | every handle; the engine of everything | the address only; `at()` first, the dot as sugar | a callable lens | the dot lens with a call space, plus `at()` | the owner asked for it and the prototype works; `at()` covers computed keys and hot code for no rule | stands; `at()` turns number keys into strings |
| Reserved names | only `then` | six verbs and `then` | none (a name is a key until called) | only `then` | checked in a prototype and in the types | **no verb reserved; seven probe names read as `undefined`; a read is `get()`** |
| A read | `await lens` | `await lens` | `await lens` | `await lens` | the shortest | **`await lens.get()`**: a lens with `then` is a promise to JavaScript (2.1) |
| The boundary word | `here()`; `connect` puts it at itself | `connect()` alone | `here()` | `here()`, and `connect` always has a target | local operators over a remote selection need a spelling; one word then has one meaning | stands |
| What may stand left of it | any plain-data operator, with a budget per client and a switch | a path or a named view only | A, B and C | A, B and C as the grammar; **the first build serves B as A** | keeps V4-5 for whole-resource work; the commuting rule lets pushdown come later with no app change | stands, with a cap on served views, and the order channel for B |
| The wire unit | the partition | the partition; a row selector priced as a next step | per shape inside a partition | the partition, first | one sentence, no new rule, and E-31's model already covers it | stands |
| How a link ends | close, scope, the target's close, the collector | close, scope; the collector as a net; read through the handle | close, scope, count and linger, the collector as a backstop | all of them, in that order of trust, with cost-first's read-through-the-handle rule | each measured the collector as late | stands; plus "a read only from rows held on purpose" and "a `connect` function changes only its target" |
| A sync read of a lens | `peek()` | `live.rows` | `x.rows` | through the handle; no `peek` | one name fewer, and it is the handle rule | stands |
| Default `hold` | `'all'` or `'asked'` stay | nothing until you connect | `hold` goes | nothing by default; `hold: 'all'` and a size stay as options | the owner's aim that a client gets only what it needs; the cost shows on a line. The owner's call (Q1) | stands; a size is a cache of pictures, not a subscription |
| Writes | only on the lens; `f.set` goes | all spellings stay | the lens first; `f.set(path, v)` stays; `f.data.set` goes | space's | the array form is free, needs no `Proxy`, and `batch` and `ctx.set` use it | stands |
| Methods | `lens.sell()`; `f.methods` goes | `lens.methods.sell()` | `lens.sell()`; `f.methods` at the root | `lens.sell()` on a path; `f.methods.x()` with no path; `lens.call(name)` as the way out | the owner's shape; the root keeps a space where nothing can clash. The owner's call (Q3) | stands; **a method declares `at:` and the server checks the path** |
| Nesting | `depth: 2` | `depth: 2` | `keys: 2` | `depth: 2` | two of three; `keys` reads like a list | stands |
| `tap`'s argument | `c`: `first`, `value`, `changes` | `(changes, now)` | `c`: `first`, `rows`, `now` | one `c`: `first`, `changes`, `now`, plus `c.recs()` and `c.text()` | one argument reads the same in `tap` and after a target in `connect` | stands; rows are frozen on first hand-out |
| `derive` | a `connect` whose target is a resource | a wrapper over `{ after: e }` | a pattern over `{ from: e }`, `marks()`, `mark()` | space's, with `derive()` kept as a library | the exactness is visible on the write line | stands, **with pacing**; `derive()` is shown first |
| Time travel | an undo ring in memory, `asOf().step()` | `history()`, a reader | `asOf()`, a reader with fat nodes | `asOf()`, a reader with fat nodes | E-54: a ring can walk but not jump (a random jump took 0.18 to 0.48 s), and nothing on the live path needs it | stands |
| Typing a client | `fero.as<Shop>()` | `fero<Shop>()` | `fero<Shop>()` | `fero<Shop>()` | it compiles against API.md's declarations today; no new name | stands |
| A client pin (`FERO_SERVER=off`) | yes, +1 rule | no | no | no | the exported type makes the wrong import fail in Node and `tsc` | **open again for bundles** (section 5, the browser build) |

### 4.2 In API.md (after the owner decides)

1. **Section 2, the shape:** `data` is the address of everything; `rows` is the fast read. The seven rules of 2.0.
2. **3.2 Partitions:** the first key is the partition; `depth: 1 | 2`; `{ before }` goes; the function form by Q4.
3. **3.3 `hold`:** the default holds nothing; `hold: 'all'`; a size is a cache of pictures. A `get` never holds.
4. **3.4 to 3.7 Writes:** the path write first; `f.set(path, v)` as the array form; `f.data.set` goes; `{ from: e }`; a marked write is never refused `backpressure`.
5. **3.8 Methods:** called on a path; `{ at, run }` and `bad-path`; `ctx.at`; `near` goes; `lens.call`; `export type Shop = typeof shop`, `import type`, and a type check before bundling; no `set` on the typed client of a resource with methods.
6. **3.9 Reads:** `await lens.get()`, served here only from rows held on purpose; `rows` on a handle; `f.rows` shows what is held on purpose. A lens is not a promise; the seven probe names.
7. **3.10 becomes "the lens":** `here`, `connect`, lifetimes, the closable kinds, the three classes, the cap on served views, `tap((c) => …)` with frozen rows, the commuting rule with the order channel. `follow` and `.open()` go. `changes()` moves onto the lens; `of:` goes.
8. **3.11:** `derive()` and `consumer()` first, as libraries; then the four lines they are made of, with pacing and "one process". Say that the source needs `history`.
9. **New:** `asOf`, on a partition first. The exactly-once sentence of 1.2, with its limits.
10. **Section 6, declarations:** `Lens`, `Held`, `Link`, `Commit`, `MethodDef`, path calls. **Section 7:** the function must not capture its target and changes only its target; a lens inside a partition holds the partition.
11. **Section 8, refusals:** `unencodable` (a function left of `here()`); `bad-path`; `bad-key`; `too-many-views`; the dev warning for a link the net ended.
12. **Section 10:** the 22 patterns as in 2.10. **Section 11:** closes questions 2, 3, 8, 9, 10 and 13.
13. **API-TOUR.md:** the ten lines gain one (`here()` or a `get()`), and every typed example uses `Shop` with `import type`.

### 4.3 In LAYERS.md

1. **L4, the surface:** it gains its first rules of its own: the lens, links, counts, the net, what "held on purpose" means.
2. **L3, flow:** the SUB protocol is unchanged. State added: per process, a registry of shared selections with counts, strong counts and a linger; coverage of a partition by a held whole; the resume cursor as the server's position. A GET carries the highest position seen. A cap on live served views. Owed, as before: the `view` selector's rules, modelled.
3. **L2:** a record's key is `[partition, row, ...fields]` under `depth: 2`, and the header's partition hash is the hash of the first key. The mark becomes a write option; `marks()` is a read; a bare mark exists; a marked write waits where a plain one is refused `backpressure`. A call carries a path, and the server checks its shape.
4. **L5:** `derive` and a consumer's `run` are loops of public calls. Who runs a deriver is then the app's choice (a lock, or shares), which closes API's Q-B8.
5. **Section 7, the wire:** no new verb. An ASK for a call carries a path. A SUB's `view` selector carries `{ method, arg }`, and later `{ path, ops }` with the order channel.

### 4.4 The rule count (SIMPLICITY's measure)

Every count is **reasoned**. None is modelled. The base has 416, of which 197 are model-checked (LAYERS 0.2). The first form of this table said "about +4"; its own rows summed to +4 to +7, and it had none of the rows below the first block (review F9).

| Change | + | − | Net | Note |
|---|---|---|---|---|
| **This page's first form** | | | | |
| the lens and the call space | 3 | 0 | +3 | a step does no work and keeps no state; a call pops its last step as the verb; probe names read as `undefined` and fero's names win |
| `get` holds nothing; read through the handle | 1 | 2 | −1 | gone: the hidden follow and its drop order |
| writes on a path | 0 | 1 | −1 | gone: the lens calls as a second name |
| a method on a path | 2 | 2 | 0 | route by the path; `ctx.at`. Gone: the hint's two forms, and learning it |
| `here`, `connect`, lifetimes | 5 | 2 | +3 | weak target passed in; end at the first of five; check the target at each delivery; count, linger, then unsubscribe; the net is safe twice and at any time. Gone: `Follow` as its own verb; `LiveCall.open` |
| the line | 2 | 0 | +2 | a function left of `here()` is refused; a whole-resource operator not held is refused with the hint |
| `tap`'s one shape | 0 | 1 | −1 | in data: the mode from source text |
| `{ from: e }`, `marks()`, `mark()` | 0 to 2 | 0 | 0 to +2 | E-30's 5 exist; the option must compose with `once` and `if` |
| `depth` for `{ before }` | 1 | 1 to 2 | −1 to 0 | gone: the text rule and its escape; the index was owed anyway |
| *sum* | | | *+4 to +7* | |
| **Found by building it (E-55)** | | | | |
| a partition inside a held whole sends no SUB; it subscribes again when the whole ends | 1 | 0 | +1 | claim 7; planted out, 536 sinks unequal |
| a resume starts from the server's position; a client drops a frame it already applied | 1 | 0 | +1 | claim 7 [net]; without it 75 frames applied twice |
| a `connect` function changes only its target | 1 | 0 | +1 | claim 14; fero cannot check it, so it is also a user rule |
| *sum* | | | *+3* | |
| **Found by the review** | | | | |
| a read is served here only from rows held on purpose; a GET carries the highest position seen | 1 | 0 | +1 | F1 |
| a marked write waits instead of `backpressure` and pauses its reader; a failed one ends the loop | 1 | 0 | +1 | F2 |
| a cap on live served views per client and per resource | 1 to 2 | 0 | +1 to +2 | F7; API.md's `.open()` owes the same |
| a method declares its path shape; the server refuses another | 1 | 0 | +1 | F8 |
| a warm closed selection is not subscribed; a re-open resumes or takes a new picture | 1 | 0 | +1 | F14 |
| `at()` turns a number key into a string and refuses other types | 0 to 1 | 0 | 0 to +1 | F23 |
| the target's close is listened for only on named kinds, or a named event | 0 to 1 | 0 | 0 to +1 | F19 |
| *sum* | | | *+5 to +8* | |
| **the first build, net** | | | **+12 to +18** | about 3 to 4 % of 416 |
| `asOf` | 3 | 0 | +3, in a reader library | none in the kernel (E-54) |
| owed already: the `view` selector | | | +4 to +6 when modelled | API.md's `.open()` owes the same |
| owed already: the lazy freeze of rows handed out (DATA-07) | | | 0 here | it now also covers sinks (2.7) |
| later: class B pushdown | 5 | 0 | +5 (4 to 7) | 4 for the views and the resume, 1 for the order channel (E-55 claim 17) |

- **By V5-6's measure the lens costs rules and cannot win on rules alone.** The trade is about 3 to 4 % more rules for what follows. The reviewer's own estimate was +9 to +14 (2 to 3 %); it left out two rows it had itself asked to be counted (F14, F19).
- **What a user no longer has to know:** `follow`, `.open()`, `{ before }`, the two meanings of `tap`, `f.data.set`, the hidden follow inside `get`, and `near` as a hint to learn.
- **What stays, said plainly** (the first form overstated this): `hold` still has three values (nothing, `'all'`, a size). A write still has three spellings (assignment, `lens.set`, `f.set(path, v)`). A method on a path still declares one word (`at:`), where `near: true` stood.
- **User rules: seven** (2.0), where the first form said five.
- **Names.** Go: `follow`, `.open()`, `near`, `{ before }`, `get`'s `hold: false`, `hold: 'asked'`, `f.data.set`, `changes`'s `of:`, derive's `out`. Come: `here`, `connect`, `get` as a verb, `at`, `depth`, `ctx.at`, a method's `at:`, `{ from: e }` with `marks`, `asOf`, `call`, connect's `closes`.

### 4.5 In data

The owner allows a rewrite. data must stay a library of its own. **Each change below is useful to data alone**: `$(state).a.b.connect(el, 'textContent')`, `at()`, scopes and `tap((c) => …)` mean the same with no network, and `here()` is then a no-op.

| # | Change | Why | Size | Rust? | What E-55 showed |
|---|---|---|---|---|---|
| D1 | **Path subscriptions through a keyed index** | today each one subscribes the root and checks every row delta: O(lenses) per commit (code data:api/index.ts:186-191) | a map from row key to subscribers; a small tree below the row | no | built in the prototype: flat to K = 10,000 within 1.09 to 1.52 (median 1.25) times; data today about 120 times |
| D2 | **The handle becomes the lens**: callable steps, no child kept for life, `at()`, `get()` | 318 to 1,333 B per key today; the call space; not a promise | medium | no | built: 0 to 0.3 B a key |
| D3 | **Two-level stores**, and operators at a partition | `depth: 2`; PA-17's index; "child handles are addresses, not views" (code data:api/index.ts:543-548) | the largest change. Open: pair keys for a view over every row of a depth-2 resource | no | **needed for small partitions**: a data source per partition costs +0.9 KB and 1.3 to 1.5 times the fold for one-row partitions; a plain two-level `Map` was the cheapest store at every size |
| D4 | **One sink shape**: the commit by reference, lazy; `recs()` and `text()` shared; a cheaper delivery | a tap that names a parameter costs 1.5 to 1.8 µs a change today; `tapHasParam` goes | small | no | **the floor under every tap is data's delivery to any sink**: 63 to 122 ns a commit |
| D5 | **`connect` holds its target weakly, passes it in, and has the net** | today the anchor is checked and then ignored (code data:api/index.ts:357-361) | small, in the API layer; the kernel keeps its scope rule | no | built; the three rules of 2.2 keep "GC timing never changes a result" |
| D6 | **Views belong to the scope or handle they were made in** | V4-54's dead filters | data's scopes exist | no | the prototype's first build leaked them; fixed and checked (claim 26) |
| D7 | **Operator chains as plain data**: write one down, send it, build it again elsewhere; **with the order channel** | class B and the commuting test; the registry already marks which operators are plain data (code data:ops/registry.ts:14) | small | no | 0 of 1,000 runs differ with the order kept, 239 without |
| D8 | owed already: the lazy freeze (DATA-07), now for rows handed to sinks too; `group` at O(change) (DATA-05); **the cost of an ordered view with a window** | API:390; E-05; E-55 claim 16 | — | no | an ordered windowed view costs 1.6 to 62 µs a change, growing with the partition |

**Order of work** (E-55): D1 and D2 first, since the lens cannot work without them. D3 and D4 next: they are where the prototype's misses come from.

**Not planned:** a hash-tree store in data, or a prior value in the log (E-54).

**Rust.** None of this needs it (reasoned from E-03 and E-54; nothing in E-55 asks for it). A user's function is JavaScript, and a call from Rust into it costs 107 ns to 3.8 µs each (E-03). A row must stay a plain JavaScript object, or `rows.k.stock` stops being a short read. E-54's Rust trees were slower than Node's. Rust pays where bytes never become objects: L0 and L1, as LAYERS 0.2 reads today. **But the line of this design is also the clean cut for a native step later**: what stands left of `here()` is plain data only, so a server-side engine never calls back into JavaScript for it.

---

## 5. Alternatives weighed, and why not

| Alternative | Why not |
|---|---|
| **Keep API.md's shape** (`follow`, `.open()`, `near`, `{ before }`, `derive`) | it works and has the fewest rules. But it names four of seven places with four unrelated words, hides a follow in every `get`, and leaves `f.data.*` untyped. The lens costs about 3 to 4 % more rules to remove those |
| **The collector as the way a link ends** (the owner's first form) | 7 ms to never in Node; never within 30 s in Chromium (E-55). Results would depend on the collector's timing, which breaks data's scope rule and the seeded simulator. Kept as the net |
| **`await lens` as the read** (this page's first form) | a lens with `then` is a promise to JavaScript: an `async` helper that returns the root lens downloaded 100,000 rows (E-55 review). Six more characters, `.get()`, remove the whole class |
| **Keep `then`, but refuse it on the root and on a partition** (`whole-read`) | it stops the big download, but a row or field lens returned from an `async` function still makes a hidden trip, and it adds a user rule: "never return a lens from an async function". The owner's call (Q11) |
| **Serve a read from any rows in memory** (the first build) | the trip count, and over a network the value, then depend on when the collector ends a dead link (E-55 review: 9.7 patterns per program) |
| **Any plain-data operator from any client, over the whole resource** (lens-first) | a client could make a server keep 10,000 views. It needs a budget, a switch and the unmodelled selector: +5 to +8 rules. The door (V4-5) already says who may order server work. The door alone does not limit how many, so class C gets a cap too (2.3) |
| **No operator at all left of the line** (cost-first) | cheapest, but it cuts the owner's operators before and after the call down to named views. Taken as what the first build *serves*; not as the grammar |
| **`connect()` alone as the boundary word** | a handle with no target and a sink with a target would share one word |
| **A message as a field, with data's objects as persistent trees** | a field write would be O(log n), but versions, conditions, expiry, sizes, stages and `e.value` are all per row; each would need a per-path form at the leader. A row one level down gets them for no rule |
| **Two levels always, no option** | a user's fields would become rows; a user could not be read or expired as one thing |
| **`lens.methods.sell()`** | never clashes, but reserves a second key (`methods`) and is not the owner's shape. It is the fallback (Q3) |
| **Every method on every lens, with no declared path** (the first build) | a client picks the path: `widgets.left.sell(1)` changed a row's shape through the door (E-55 review). The method author would have to check `ctx.at` by hand in every method |
| **`peek()` on a lens** | a sync read that works only while something else holds the rows is the read the handle rule forbids |
| **`derive` as `changes().connect(resource.data, fn)`** | the exact form and the at-most-once form would differ only in the kind of the target |
| **The four lines as the documented way to derive, with no pacing** | exactly once only until the 513th waiting write: 998 of 1,000 seeds lost outputs (E-55 review). With pacing they are exact; `derive()` is still shown first, since it also runs once and sends bare marks |
| **An undo ring, or reverse records in the log** | a ring walks but cannot jump; no live reader needs it; the prior value in the log costs 80 to 150 % more bytes (E-54) |
| **A hash-tree row table in data** | **+1.1 to +2.2 µs a write** (2.4 to 3.6 times a `Map`), and the collector's work rises 6 to 28 times, as a store with no versions kept (E-54, measured in the review; the first form of this row quoted +3.3 to 5.7 µs, which is the cost with every root kept). It would buy an O(1) `snapshot()` and fast in-memory forks; nothing on the live path asks for those |
| **A row or field selector on the wire, now** | a key decode per record of a partition with row readers (0.48 to 0.64 µs), +2 to +3 rules, and E-31 again. It pays only for large partitions read a row at a time |
| **Typed plain assignment** | TypeScript cannot give a mapped property one type to read and another to write (E-55 claim 5: tried four ways) |
| **A warm near cache that stays subscribed** | the server would send, and this process decode and fold, every change to every warm partition for nobody. The memory bound would not bound that (review F14) |
| **A user rule "a sink must not change a row", in place of a freeze** | free to run, but nothing can check it, and one bad sink corrupts the store for every other sink |
| **A spec module** for types: `shop.spec.ts` holds the seed's type and the methods' signatures, with no top-level side effect; the server and the client both import it | the safest import: nothing to ship by mistake. But the handlers' types must then be written twice or pulled apart from their code, and `typeof shop`, whose full typing the owner liked, goes. Not picked as the default; worth offering for browser projects (reasoned) |
| **A browser build of fero in which a server role throws** | it turns a shipped server into a loud error at start, whatever the bundler did. It does not stop the server's code from being in the bundle, so the method code still leaks. +1 rule. Worth having beside `import type` and a type check; the owner's call (Q12) (reasoned) |

**From other systems** (space, section 3; search summaries and memory, not pages read): every system that pushes work to a server sends plain data, never code (Electric's shapes, RethinkDB's changefeeds, Zero's queries, Firebase's paths); each limits what may stand before its line; and none ends a subscription across a network by garbage collection. Firestore's subcollections are the `depth: 2` idea; Firebase's "keep it flat" is the field-in-a-big-value failure. Datomic's as-of is a read handle, which is 2.9's shape.

---

## 6. The claims, and what E-55 measured

Each claim keeps its bar from the first form of this page, then its result. **[data]** was measured on data's real engine in one process. **[net]** used two threads joined by a real `MessagePort`, or a stand-in that the result names. Details, tables and raw lines: [E-55's README](experiments/E55-lens-prototype/README.md).

**One verdict rule** (review F13): a timed claim passes if the **median of its runs** meets the bar; the lowest and highest run are shown. "E-55" runs are three; where the reviewer's rerun and the review pass add runs, the count is given. A seeded claim passes if no seed fails. The first form of E-55 judged claim 1 by its worst cell and claim 8 by two runs of three; under one rule both are borderline, and they are marked so. Where the first build and the changed build differ, both are shown.

**Count: of 27 claims, 10 pass (2, 3, 4, 7, 9, 12, 14, 17, 20, 26), 10 pass in part, sit at the edge of their bar, or are stand-ins (1, 5, 6, 8, 10, 18, 19, 21, 23, 24), 1 misses (11), 3 are records with no bar (13, 15, 16), 3 were not run (22, 25, 27).**

**The lens**

1. **A step is cheap.** [data] **Bar:** the lens's own share is at most 0.15 µs a step; a kept lens's verb costs at most 0.2 µs over the direct call; `at(k1, k2)` at most 0.1 µs.
   **Result:** one key: 49 to 99 ns a step at 1e3 to 1e6 rows. Keys spread: 54 to 67 ns at 1e3; at 1e5 95 to 236 ns over six runs, median 116; **at 1e6 162 to 222 ns over seven runs, median 205**. A kept verb: −63 to +24 ns. `at()`: −79 to +33 ns with keys spread; with one key at 1e6 rows 54 to 154 ns (median 82).
   **Verdict: pass in part.** It misses in one cell, keys spread over 1e6 rows, where the read under it costs 1.1 to 1.3 µs and two runs of the same cell differ by about 100 ns. That cell is the case 2.1 sends to `at()`.
2. **A step keeps nothing.** [data] **Bar:** at most 16 B kept per key. **Result:** 0 to 0.3 B per key, one and two steps deep (100,000 keys). data's handle today: 1,333 B two deep. **Verdict: pass.**
3. **A write through the lens.** [data] **Bar:** at most +1.0 µs with steps, +0.3 µs kept. **Result** (six or seven runs a size): steps +0.18 to +0.73 µs, medians 0.31 to 0.47 by size; kept −0.03 to +0.42 µs, medians 0.16 to 0.28. **Verdict: pass** on the medians; the kept lens is at the edge at 1e6 rows, where 3 of 6 runs were over 0.3 µs (median 0.28).
4. **The call space holds.** [data] **Bar:** every case passes. **Result:** 22 of 22 on the first build; **47 of 47** on the changed build, with the review's cases: a lens is not a promise (five ways to resolve one: 0 trips), the seven probe names, `at()` with a number key, a method refused on a wrong path. **Verdict: pass.**
5. **The types hold.** [data] **Bar:** the 22 key lines compile as written; six named lines do not. **Result:** on the first form, the 22 lines needed four edits, one a real defect (P-01), and 2.0's own `stock.set(4)` failed by 2.4's rule. This page now carries the edited lines: exit 0 as written. **11 lines that must not compile fail, each for its reason** (the first 8, plus a row method below its row, a row method at the root, and `await lens` used as a value). Typed assignment is still impossible on a mapped type. **Verdict: pass in part** (the bar was "as written", and the first form missed it).

**Connect and lifetimes**

6. **Set-up.** [data] **Bar:** a second `connect` is a lookup and a count, at most 0.3 µs; registering the target at most 0.3 µs; the first picture in proportion to the selection only. **Result:** the lookup and count 39 to 45 ns; a second `here()` 163 to 169 ns. Registering a target 0.13 to 0.33 µs when links are made 1 to 10,000 a job, **0.58 to 0.67 µs inside one job that made about 150,000**, where a whole second `connect` cost 0.69 to 0.74 µs. A 100-row room's first picture: 0.16 to 0.23 ms at 1e4 rows in all and 0.16 to 0.19 ms at 1e6 (each right after a forced collection, which is most of it); 26 to 28 µs with no collection before, measured at 1e5 rows only. **Verdict: pass in part** (one very long job misses).
7. **The picture, then the changes, equal the final state.** [data] **Bar:** equal in every seed; none missed, none twice; [net] the same across a reconnect. **Result:** [data] 1,000 seeds, 93,326 sinks: 0 wrong. [net] 1,000 seeds, 4,337 disconnects, 5,968 resumes, 4,743 new pictures: 0 wrong, after the first pass found 75 frames applied twice (2.2, "selections that overlap"). Both again on the changed build: 0 wrong. All five planted bugs are caught. **Verdict: pass.**
8. **Path subscriptions are flat.** [data] **Bar:** ns per write at K = 10,000 within 1.3 times K = 0. **Result** (15 runs: 8 on the first build, 7 on the changed build; 8 of the 15 are an A/B that alternated the two builds in one hold): the ratio is 1.09 to 1.52, **median 1.25**. First build: 1.09 to 1.36, median 1.19 (1.57 to 1.86 µs a write at K = 10,000 against 1.24 to 1.54 at K = 0). Changed build: 1.21 to 1.52, median 1.36 (1.63 to 2.50 µs against 1.23 to 1.65). data today: about 120 times. **Verdict: at the edge, counted as "in part"**: it meets the bar on the median of all runs and on the first build, and misses on the changed build's own median. The changed build's K = 0 is 0.11 µs faster and its K = 10,000 is 0.07 µs slower (medians); the review's changes touch neither path, and the cause was not found.
9. **Equal lenses share.** [data] [net] **Bar:** one upstream subscription, one fold per change, one `c.text()` per commit, one unsubscribe after the linger; one SUB and one decode per change. **Result:** exactly one of each, by counters, for 2,000 links. **Verdict: pass.**
10. **The sink by reference.** [data] **Bar:** at most 0.05 µs per commit over no tap when it reads nothing; at most 0.3 µs per change read. **Result** (the review's interleaved harness, 3 runs; the first harness's noise was larger than the bar): a tap that reads nothing 92 to 198 ns a commit over no sink; a bare data sink 63 to 122 ns; the lens's own share 31 to 103 ns; reading `c.changes` with `prev` −39 to +32 ns; reading `c.now` −33 to +91 ns; two copies of the same way differ by −8 to +2 ns. data's tap today with a parameter: 1.5 to 1.8 µs more. **Verdict: pass in part.** Reading the changes meets its bar. A tap that reads nothing misses 0.05 µs, mostly through data's own delivery to any sink; the lens's own share is not resolved against 50 ns.
11. **A weak link is as cheap as a strong sink.** [data] **Bar:** 10,000 of each within 1.1 times; the target check at most 50 ns. **Result:** 2.18 to 2.21 times with sinks that write their own target, 3.7 to 4.6 times with sinks that do nothing; +28 to +35 ns per link per commit. The check alone: 26 to 35 ns. **Verdict: miss** (the ratio); the check passes.
12. **Unsubscribe by a forced collection.** [data] **Bar:** 1,000 of 1,000 links end; no function is called for a collected target, even before its finalizer. **Result:** 1,000 of 1,000 ended by the check before delivery, in the same turn as the collection, with 0 calls; 1,000 of 1,000 by finalizers when nothing was written. One commit with 1,000 dropped, uncollected targets: 0.80 to 0.90 ms. **Verdict: pass.**
13. **Unsubscribe by a natural collection.** [data] **Bar:** none; if a busy p99 is over 10 s anywhere, the docs call the collector a net only and the dev warning is required. **Result:** Node: young targets 7 to 8 ms busy, 1.2 to 1.4 s idle; old targets 0.33 to 0.40 s. **Chromium: 0 of 1,000 removed DOM nodes within 30 s**, idle and busy. **Recorded; the condition holds.**
14. **Collector timing never changes a result.** [data] **Bar:** everything a live handle can read, and every live target's final state, is equal across 1,000 seeds; `f.rows` never shows a row held only by a link. **Result:** on the first build, those were equal (1 result per program), **but `await lens` was not in the result**: with it, a program showed 9.7 different here-or-trip patterns over 1,000 seeds (the reviewer first saw 8 over 300). **On the changed build: 1 result and 1 here-or-trip pattern per program over 1,000 seeds**, 556,000 reads served here and 1,604,000 by a trip. Controls differ as they must: reads from weakly held rows (9.7 patterns), a `connect` function that writes outside its target (433 results), a client whose `f.rows` reads its whole cache (33.7 row histories). The count of SUBs sent still differs 3 ways per program; that is a cost (2.2). **Verdict: pass**, with the read rule and the "changes only its target" rule.
15. **The capture trap.** [data] **Bar:** none. **Result:** a function that names its target: never collected (a plain object and a DOM node); the same link using its argument: collected. A dev check sees the detached DOM node, not the plain object. **Recorded.**

**The line**

16. **A filter pushed to the server against one run locally.** [net] **The first bar** (the server pays at most 1 µs per affected view; at most 1 KB plus its answer per shape; the wire carries the answer) **measured the wrong thing** (review F6): the view costs about the same wherever it runs, so no placement can meet 1 µs for an ordered view. **Restated, with no pass or fail:** per shape, the server CPU and memory moved, against the bytes and decodes saved per reader. **Result:** moved to the server: 2.3 to 5.2 µs per view per change at 100 to 1,000-row rooms, 8 to 12 µs at 10,000, 51 to 53 µs at 100,000 (one view on a 100,000-row room: 124 to 201 µs, unexplained), and 9.9 KB to 12.8 MB a shape. Saved per reader: a first picture of 677 to 765 B against 6 KB to 6.6 MB, and 0 to 32 B a change against 60 to 63 B; but 26 KB a change for 1,000 shapes of a 100-row room. Every answer was right. **Recorded.** Class B is not built yet for the three reasons in 2.3.
17. **Moving `here()` never changes the answer.** [data] **Bar:** equal in 1,000 seeded runs. **Result:** 0 of 1,000 differ when the client keeps the order channel; 239 of 1,000 differ with a plain keyed copy. **Verdict: pass**, with that condition (2.3).
18. **A method on a path reaches that path's leader.** [net, a stand-in: the leader table and the forwarding are written in the bench, so "one trip, one commit" is true by construction once the table is right] **Bar:** one trip and one commit with a fresh table; one redirect after a leader change; one more trip about 2 times in 3 with no path. **Result:** exactly so with 3 and 5 servers (0.66 and 0.80 extra trips with no path). **Added by the review:** 202 of 202 calls on a path the method did not declare were refused `bad-path`, with 0 commits. **Verdict: stand-in.** What it checks is the redirect path, the share of extra trips, and the path check.

**Nesting, reads, marks, versions**

19. **`depth: 2`.** [data] **Bar:** fold within 1.1 times flat with PA-17's index; a 100-row room's first picture at most 0.74 ms at 1e6 rows; at most 300 B per partition; a row write at 0.9 to 2.0 µs at any room size; at most 8 B more per record. **Result:** partitions of 100 to 10,000 rows: fold 0.78 to 1.10 times, 1.2 to 805 KB a partition **less** than flat with the index, first picture 0.012 to 0.017 ms, key +2 B. One-row partitions: 1.31 to 1.53 times and +887 to 893 B a partition. A row write is 2.1 to 3.9 µs, but flat's is 2.0 to 3.4 µs on this box at 1e5 to 1e6 rows, so no store met that bar. **Verdict: pass in part**: it passes for partitions of 100 rows and more and misses for one-row partitions (D3 not built).
20. **A read holds nothing.** [net] **Bar:** 0 rows held and 0 subscriptions after 100,000 misses; one trip each. **Result:** 0 and 0; 100,000 GETs, 0 SUBs; again on the changed build with `lens.get()`. **Verdict: pass.**
21. **Marks from app code.** [net, a seeded stand-in, not E-30's model: no Raft, no lost log tails] **Bar:** no source record lost or applied twice; the loop that does not await runs at least 100 times faster than the awaited one. **Result:** the rate: 510 to 558 times (122,000 to 134,000 against 239 to 240 writes a second). The first form of the sim passed (0 lost, 0 doubled in 1,000 seeds) **but could not fail on the rule the pattern depends on**: its queues had no limit, a loss always took the whole rest of a queue, and it sent bare marks the four lines do not send. **The second form** (a cap on waiting writes, a `backpressure` refusal mid-stream, a write lost in a slot move and a later one delivered, no bare marks): **the four lines as written lose outputs in 998 of 1,000 seeds** (cap 8) and in 100 of 100 (cap 512, 4,000 records); **paced, 0 lost and 0 doubled** in 1,000 seeds and in 100 seeds at cap 512; with a slot blocked after a refusal, 0 and 0; with the leader's order rule off, 756 of 1,000 seeds lose outputs; with marks not moved with their slot, 1,000 of 1,000 double. **Verdict: pass with the pacing rule; a stand-in.** E-30's model with `{ from: e }` from app code is still owed.
22. **The view selector.** [net] E-31's model with a `view` selector: failover, a reload, a slot move, a slow reader, a resume by a new picture. **Bar:** every property holds, in at most 8 rules. **Not run.** It needs E-31's model extended; it is a separate experiment.
23. **`asOf` on data's real fold.** [data] **Bar:** at most +1.0 µs a record and 220 B a version; a step at most 0.2 µs; a row at a version at most 2.4 µs; a row with 150,000 versions at most 2 µs; every answer equal to a refold. **Result:** +1.5 to +2.0 µs a record; 103 B a version at 1e5 rows and 285 B at 1e6 (heap after minus heap before, as E-54 measures its 104 to 219 B); a step 10 to 12 ns; a row 0.6 to 1.4 µs; the hot row (150,473 versions) 0.14 to 0.21 µs; 0 wrong in 1,680 checks. **Verdict: pass in part**: every read passes; the fold's cost misses, and the memory misses at 1e6 rows. It is a reader's cost either way.
24. **The import matrix.** [data] **Bar:** only `import { shop }` runs or ships the server. **Result:** Node 22 and 26 and `tsc`: yes. esbuild with `verbatimModuleSyntax` also ships the server for `import { Shop }`. **Verdict: pass in part** (one bundler cell misses; 1.3).
25. **The patterns run.** [net] E-22's 22 patterns respelled as in 2.10, 100 seeds each. **Bar:** as E-22. **Not run.** It needs E-22's prototype ported; claim 5 compiles the lines.

**Added by the review**

26. **Views right of `here()` end with their handle.** [data] A view made from a handle, and every sink on it, under `close()`, a scope, the seeded collector and the linger. **Bar:** no sink is called after its end; no view and no selection is left. **Result:** 1,000 seeds, 59,958 view sinks: 0 calls after the end, 0 views left, 0 selections left. The first build's behaviour, planted: 22,539 calls after the end in 300 seeds. **Verdict: pass.**
27. **A served view on the prototype (class C).** [net] `f.methods.x(arg).here()`: one SUB with `{ method, arg }`, one server view shared by equal calls, its lifetime, the cap on live served views, a resume. **Bar:** as claims 7 and 9 for a served view; the cap refuses the next view with `too-many-views`. **Not run: class C is not built in the prototype.** Claim 16 built a pushed-down view for one partition only.

---

## 7. Questions for the owner

Each has this page's pick. Questions 10 to 13 are new or changed by the build and the review.

1. **Should a bare `fero('shop')` hold nothing until `here()` or `tap`?** Pick: **yes**, with `hold: 'all'` kept as an option, and a size as a cache of pictures that is not subscribed. Every download is then a line you wrote. Against: v4's first example and about 20 example READMEs change, and `client.rows.widgets` after a bare open would throw `not-held`.
2. **Is "the wire sends whole partitions" enough for the first build?** Pick: **yes.** Class B (work pushed below a partition) is in the grammar from day one. It is built when three things exist: a cap that covers shapes, the modelled `view` selector, and the order channel on the wire. E-55 shows what it buys: 677 to 765 B against 6 KB to 6.6 MB for a first picture, for the view's CPU and memory moved to the server. Against: a lens on one field of a big partition downloads the partition.
3. **A method on a path: `lens.sell(1)` or `lens.methods.sell(1)`?** Pick: **`lens.sell(1)`**, your shape, with fero's names winning and `lens.call('name', arg)` as the way out. Against: a verb fero adds later could shadow a method somebody wrote; `lens.methods.sell(1)` can never clash, but it reserves the key `methods`.
4. **Drop `{ before }` for `depth: 2`, and keep the partition function for later?** Pick: **yes to both.** V5-2's wording changes ("a prefix" becomes "the first key"); its substance does not.
5. **May a client make up server work over a whole resource without a method?** Pick: **no.** The door (V4-5) guards server compute as well as writes. A named view is one line on the server, and a cap limits how many a client may hold open.
6. **Typed code cannot use plain assignment on a lens.** Pick: **accept it**; typed code writes with `set`, and assignment stays for untyped handles. The other way is to leave `f.data` untyped, as API.md does, and check nothing.
7. **The mark's name: `{ from: e }` or `{ after: e }`?** Pick: **`{ from: e }`**: you read `changes({ from: marks })` and write `{ from: e }`.
8. **Time travel as `lens.asOf(position)`, on the reader only?** Pick: **yes** (E-54). No version structure in data, no prior value in the log. It costs the reader +1.5 to 2.0 µs a record and 103 to 285 B a version (E-55).
9. **Should data's rewrite start now, in TypeScript, with D1 to D7?** Pick: **yes, D1 and D2 first** (the keyed index and the uncached lens): the lens cannot work without them, and both help data alone. **Then D3 and D4**: E-55's misses come from a data source per partition and from data's delivery to a sink. Rust stays for L0 and L1.
10. **The fallback: does the lens stay a full lens, or only an address (`at()`)?** The first form of this page said: if claims 1, 8 or 14 miss, the lens stays an address. The prototype is built, and the three came out like this:
    - **Claim 14 passes**, but only with the review's read rule (2.2). On the first build it failed once `await lens` was counted.
    - **Claim 8 is at the edge**: the ratio's median over 15 runs is 1.25 (1.09 to 1.52), and the changed build's own median is 1.36, against a bar of 1.3.
    - **Claim 1 misses in one cell**: 162 to 222 ns over seven runs, median 205, against 150 ns, with keys spread over 1,000,000 rows. That cell's own noise is about 100 ns, and its case is the one 2.1 sends to `at()`.
    Both speed claims are borderline, and neither is a clear pass or a clear miss. Claim 8 measures the keyed index (data's D1), which `at()` lenses need just as much, so it does not decide between the full lens and `at()`; it says D1 must be built with care and pinned. Pick: **keep the full lens.** By the letter of the old sentence claim 1 triggers the fallback; by its purpose it does not, since the lens adds under 20 % to a read that costs 1.1 to 1.3 µs there, and the hot-read form (`rows`, `at()`) is untouched. Against: a `Proxy` step costs about 100 ns more than a plain object on a big heap, and no way of building it fixed that.
11. **A read: `await lens.get()`, or `await lens` with guards?** Pick: **`get()`.** A lens is then never a promise, so no helper, `Promise.all` or framework can read through it by accident, and no name is reserved for it. Against: six more characters on every read, and `await stock` was the nicest line of the first form. The other choice keeps `then`, refuses it on the root and on a partition, and adds the user rule "never return a lens from an async function".
12. **Should fero have a browser build in which a server role throws?** Pick: **yes, later, beside `import type` and a type check before bundling** (1.3). It turns a bundled server into an error at start. It costs one rule, and it does not keep the method code out of the bundle; a spec module does, at the price of `typeof shop` (section 5).
13. **A method's default place: the root only?** Pick: **yes.** A bare function may be called only as `f.methods.x(arg)`; to be called on a path it says `{ at: 'row' | 'partition' | 'any', run }`, and the server refuses any other path (2.4). Against: one declared word returns where `near: true` stood. The other default, "anywhere", is what let a client change a row's shape in the first build.
14. **Rewrite API.md around the lens now?** Pick: **yes for the shape of sections 0 to 2, as revised here; build next what is still owed.** Owed: the `view` selector in E-31's model (claim 22), the 22 patterns end to end (claim 25), a served view with its cap on the prototype (claim 27), E-30's model with marks from app code (claim 21), and the pacing rule in a real client.
