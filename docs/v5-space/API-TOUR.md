# fero v5's API: a tour for review

Written 2026-11-16 for the owner, rewritten 2026-11-18 for the connect lens (V5-12), and **rewritten again 2026-11-20 for V5-13 to V5-15** ([DECISIONS.md](../DECISIONS.md)), then amended the same day for V5-16 (sync reads). **Amended 2026-11-21 for V5-17**: your answers to API.md's open questions. Four went against API.md's pick and change the API (2.12). **Amended 2026-11-23 for V5-20 to V5-22**: work over every row past one process, with no fixed row ceiling (2.13), and what E-59 to E-61 left on marks, served views and a clean stop (2.14); compact rows ([COMPACT.md](COMPACT.md), V5-21) and the merger's rule 4 ([E-67](experiments/E67-merge-rule4/README.md), V5-22) are in 2.13 too. It walks through [API.md](API.md), which was amended the same day for each of those decisions. Read this first. API.md is the full reference; [CONNECT.md](CONNECT.md), [TRANSFORMS.md](TRANSFORMS.md) and [ANYPATH.md](ANYPATH.md) hold the evidence.

**What you asked, since the last tour.**
- **Reads.** You found the mix of `here`, `tap`, `connect` and `changes` unclear, and asked why a root method was `f.methods.x` while a method on a path was `f.data.k.x`. You then proposed one `connect` with options: the state and the diff on each call, `disconnect()` with a lifetime option beside it, a start at a commit id or a few commits back, a read once by awaiting, and `for await`. You also asked what a commit id looks like, and whether Merkle trees help (V5-13).
- **Transformations.** They made earlier versions hard, so you asked for a plan worked out and checked in full, and whether data needs a new version for it (V5-14).
- **Sync reads.** After `f.snapshot` went, you asked whether the other snapshot reads could go as well: a sync `.value` read only where it is safe beyond doubt, and `get()` or `connect()` elsewhere (V5-16).
- **Paths.** You asked whether v5 keeps what data and earlier fero had: a write at any level of a resource, and every reader of any part seeing that part right. When the first answer stopped the log at the row, you asked whether a field could keep a log of its own, as every other lens does (V5-15).
- **Your answers.** You answered API.md's open questions one at a time (V5-17), and left question 28 open until the move from one group per resource to many was studied. It then waited for MERGE.md, a study of how work over every row is merged across groups (V5-18). **V5-20 closed it on 2026-11-23** (6.1).
- **Every row, past one process.** MERGE.md kept a fixed one-process ceiling for four features. You asked whether a ceiling was needed at all, since a process can read each group's rows from the servers that hold them (V5-20). You asked for a study of compact rows before the first build fixes the layers below, since adding them late could force a rewrite (V5-20 item 9, answered by V5-21). And the merger ships only once its rule 4, a host that fails during a slot move, passes seeded runs (V5-20 item 1, met by V5-22).
- **The models' leftovers.** E-59 to E-63 closed the models LAYERS owed and left choices only you could make: how a marked write that is refused or skipped answers, how `fn` is awaited, which slots marks cover, what END `view-too-big` ends, which thread judges writes, and how a clean stop with no spare ends. You answered them one at a time (V5-20).

**How this pass was made.**
- READS.md proposed five read verbs, one job each. CONNECT.md then weighed three designs against your one `connect`, with two judges and a review of 21 findings. It rests on [E-56](experiments/E56-one-connect/README.md), which built `connect` on E-55's prototype and measured commit ids, hash chains and Merkle trees.
- TRANSFORMS.md started from a history of 70 sources of complexity in fero v2 to v4 and in data. It built every piece small on data's real engine ([E-57](experiments/E57-transforms/README.md): each claim against a seeded oracle with planted bugs) and took a review of 30 findings.
- ANYPATH.md checked writes and readers at every level with [E-58](experiments/E58-any-path/README.md), a seeded oracle on data's real engine, and took a review of 19 findings.
- You approved V5-13 and V5-14 in general, and V5-15 with its pick 2 changed to "on the path". API.md was rewritten for all three, and this tour follows API.md.
- For V5-20 to V5-22: [MERGE.md](MERGE.md) ([E-64](experiments/E64-past-one-process/README.md)) designed the merger across groups. [EVERYROW.md](EVERYROW.md) ([E-65](experiments/E65-every-row/README.md)) built five ways round MERGE's ceiling, each against a seeded oracle with planted bugs. [E-59](experiments/E59-growth-and-stop/README.md), [E-60](experiments/E60-view-selector/README.md), [E-61](experiments/E61-marks-from-code/README.md) and [E-63](experiments/E63-judge-thread/README.md) modelled growth and a clean stop, the `view` selector, marks written by app code, and the judging thread. [COMPACT.md](COMPACT.md) ([E-66](experiments/E66-compact-rows/README.md)) mapped where the design depends on how rows sit in memory. [E-67](experiments/E67-merge-rule4/README.md) ran the merger's slot moves, takeovers, outages and rebuilds on 4,000 seeds. You answered each study's questions one at a time, and API.md and this tour follow the answers.

**What is sure.**
- Every code block in API.md compiles with TypeScript 6.0.2: 43 blocks. Each of its 153 lines that must not compile fails at its own line (API 12, run 2026-11-23). That run used a stand-in for the one type API.md's declarations take from data. The same check, run again with this tour's on 2026-11-23 against data's shipped types at 63fea66, gave the same result (the 2026-11-21 run gave 42 blocks and 148 lines).
- Every `ts` block in this tour compiles against API.md's own declarations and data's shipped types, at 63fea66, and each of its 27 lines that must not compile fails at its own line (section 8, run 2026-11-23).
- Built small, on data at commit 63fea66: the lens ([E-55](experiments/E55-lens-prototype/README.md)); `connect` with its ends and the `ended` guard (E-56); served views, pages, `derive`'s view form, `lookup` and the store fed by slot (E-57: 0 wrong answers on the final code); writes and readers at every level (E-58: 0 wrong states). None of them built fero's log reader (E-58 checked an "on the path" reader on its stand-in), the positions or `past` as a value. Since 2026-11-23 also: `scan()`, folds per group and a sorted column for a median over every row, each against a seeded oracle with planted bugs (E-65); and the merger's slot moves, takeovers and rebuilds, on 4,000 seeds (E-67).
- Model-checked since 2026-11-23: the `view` selector (E-60: every property holds but the old wording of END `view-too-big`, which V5-20 item 20 restates), marks written by app code (E-61), and growth from one voter and a clean stop (E-59).
- Nothing of fero v5 is built. The 22 patterns compile in the new spelling; none ran.
- **API.md's third rewrite and this tour had two reviews the same day**, one against the decisions and one of the mechanics, and each finding that held is applied. The V5-16 amendment had a skeptic and then two reviews of its own, one for consistency and one of the mechanics; each finding that held is applied too. CONNECT.md, TRANSFORMS.md and ANYPATH.md each had a skeptic before, and each finding that held is applied there.

**How numbers are marked**, as in API.md. **E-nn** is an experiment; **E-55 claim n**, **E-56 probe n**, **E-57 A1, XA-n, B1, XB-n**, **E-58 part n** and **E-65 X1 to X3** are parts of one. Their costs are the lens's and data's share in one process, never a whole fero write. **CONNECT n**, **TRANSFORMS n**, **ANYPATH n**, **READS n**, **LENS n**, **PATHS n**, **MERGE n**, **EVERYROW n**, **COMPACT n**, **LAYERS n** and **V5-n** are sections of those pages and the decisions; **V5-n item m** is one numbered item of a decision. **(measured)**: timed, the range over three runs. **(checked)**: a seeded run, a model or tsc ran it. **(reasoned)**: an argument; nothing ran it. **(a guess)**: a number nobody measured. **(from memory)**: an outside fact not checked here. A number with no mark is cited from a page that marks it.

**Words.** Each is said again where it first matters.
- A **resource** is a named, shared map of rows. A **partition** is the rows one **leader** (one server) keeps in one order. The first key of a path is always the partition. At `depth: 2` a partition is a **room** of rows.
- A **commit** is the moment a write is on disk on most of the **copies**, the servers that hold the resource. Only then can anyone see it (V5-5).
- A **lens** is an address inside a resource, such as `shop.data.widgets.stock`. It holds no data and does no work. A **verb** is a call on a lens.
- A **link** is one live connection from a lens into this process. Its **picture** is the rows it selects, at the moment it starts. Rows are **held on purpose** when this process serves the resource, said `hold: 'all'`, or has a live link on them. Only those serve a read here.
- **Live state** is the newest rows, folded: a slow reader skips to the newest. **The log** is every record, in order: it waits for a slow reader.
- A **version** is a record's place in its partition's log, as short text such as `38S9`. A **cursor** is a reader's place, across partitions: text you save and give back.
- Seen from a lens on `w.stock`, a write to `w` is **above** it, to `w.stock` **at** it, to `w.stock.x` **below** it, and to `w.price` **beside** it. A record **on the path** is at, below or above.
- A resource's partitions are spread over several **groups**, each one log with one leader (V5-18 pick 1). A **cut** is one place in each group: a read at one cut never shows part of a commit.
- A **served view** is a live answer over every row that the server names in `methods:` and keeps for every client that asks: on one copy, or, over several groups, as one **partial** per group that the **merger**, one server, adds up by key at one cut (V5-20 item 1). A **fold** is a method of that kind for live code over every row (2.13); it is not the same as folding records into rows.
- A **trip** is one message there and its answer back. **SUB** is v5's one subscribe message, **GET** its one read message.
- A **rule** is one thing a builder of fero must get right (V5-6); the base design has 416. A **user rule** is one thing a user must know.

## 1. The shape, in about twenty lines that do something real

```ts
// file: server.ts — a seed and methods make a server
import { fero, op } from 'fero'
const shop = await fero('shop', {
  data: { widgets: { stock: 10, price: 5 } },                                                  // the first rows
  methods: {
    sell: { at: 'row', run: (n: number, ctx) => ctx.at.stock.set(op.incr(-n, { min: 0 })) },   // an action, called on a row
    low: { view: (max: number, ctx) => ctx.data.lt('stock', max).az('stock', 10) },            // a served view: bounded
    byPrice: { pages: (_: null, ctx) => ctx.data.az('price'), size: 50 },                      // one sorted list, in pages
    ping: () => 'pong',                                                                        // a bare function: at the root
  },
  history: '1h',                                                                               // an hour of the log
})
export type Shop = typeof shop                                     // export the type, never the handle
```

```ts
// file: client.ts — only the name: a client
import { fero } from 'fero'
import type { Shop } from './server.ts'                            // a type only: the server's code never loads
const shop = await fero<Shop>('shop')                              // a client. It holds nothing yet
const n = await shop.data.widgets.stock.get()                      // ONCE: one GET; nothing kept
const row = shop.data.widgets.connect()                            // LIVE: one SUB, shared by equal lenses; a handle
const shown = shop.data.widgets.stock.connect((s, c) => draw(s, c.version))   // LIVE, AND CALL ME: the picture, then each commit
for await (const e of shop.data.widgets.changes({ from: -5, to: 'latest' })) console.log(e.version)   // THE LOG, from 5 commits back
const was = await shop.data.widgets.past(-1)                       // AS IT WAS: a value; nothing to end
for await (const [key, item] of shop.data.scan()) console.log(key, item.stock)   // EVERY ROW ONCE: pages, one cut; nothing kept
const sold = await shop.data.widgets.sell(1)                       // a method on a path: runs at widgets' leader
const low = shop.data.low(5).connect()                             // a view the server named: an address, then a link
await row.ready
console.log(n, row.value?.stock, was.value?.stock, sold, await shop.data.ping())   // a root method sits on f.data
row.disconnect(); shown.disconnect(); low.disconnect()             // every link ends by your code
```

**One address, and one sync read** (V5-13 pick 6; V5-16). `f.data` is the address of everything: steps, reads, links, writes, and every method call, the root's too. `.value` is the one sync read, and only where it is sure: a live handle (`h.value`), a `past`, and `f.cluster`, this process's own state. Every row, read in sync, is `f.data.connect()`'s `h.value`, on any role, under this process's `memory` (V5-20 item 3). Every row once, with nothing kept, is `f.data.scan()` (V5-20 item 4).

**Seven rules a user learns** (CONNECT 8.5; V5-13; `pages` in rule 7 is V5-14 pick 4, "first build" in rule 5 is V5-12 pick 2, and `scan()` in rule 2 and `fold` in rule 7 are V5-20 items 4 and 5).
1. **A path is an address.** Building one sends nothing. It is never a promise, and neither is a handle.
2. **`get()` reads a value once. `connect()` keeps the newest state here, and calls you or loops. `changes()` is every record from a place, and it waits for you. `past()` is one partition as it was: a value. `scan()` reads every row once, in pages, and keeps nothing.**
3. **A version names a record, and so the commit that holds it; a cursor, a time and `-N` name a place. `from` starts at it, `past` reads right after it, `to` stops after it.** A version and `-N` work inside one partition; save the cursor to resume.
4. **Left of `connect()`: plain data, which may run on a server. Right of it: your code, here.**
5. **The wire sends whole partitions** (first build).
6. **Every live thing ends by your code:** `disconnect()`, `break`, a signal, `until`, or the count. Never the collector. A link's rows are read only while it is live; after the end, `ended`. A `past` is a value: nothing to end.
7. **A method says where it may be called (`at:`, `view`, `pages` or `fold`), never takes a fero word, and checks what it is given.**

Transformations add ten user rules (2.7). V5-20 adds a few more: a sync read of every row is bounded by this process's `memory` (2.13), and code that writes marks keeps two rules (2.14). Paths follow data's rule (2.4) and one shape rule at the leader (2.5). The types show neither, and no record counts them as user rules. **The first tour's rules still hold**: a sync read never leaves this process and never guesses (since V5-16 it is `.value`: a live handle's, a `past`'s, or `f.cluster`'s), and a change is sent whether you `await` it or not, and shows, to everyone, when it commits.

## 2. The decided changes, first

Each says what it looks like now, what it looked like before (the 2026-11-18 page, unless marked; for 2.13 and 2.14, the 2026-11-21 page), why, and what it costs. **Rules** are the source pages' counts, all reasoned and none modelled; 2.11 adds them up.

### 2.1 Four read verbs, one job each (V5-13 picks 1 and 3)

- **Now.** One verb per job, named by what you get.
  ```ts
  // file: verbs.ts — four read verbs, one job each
  import { fero } from 'fero'
  type Msg = { text: string; stars: number }
  const chat = await fero<Msg, 2>('chat')                                 // depth 2: a room is a partition, a message a row
  const m7 = await chat.data.room1.m7.get()                               // get: a value once. One GET; nothing kept
  const room = chat.data.room1.connect()                                  // connect: room1 live here. A handle; one SUB
  await room.ready
  console.log(m7?.text, room.value.m7?.text)                              // a sync read, through the handle
  const link = chat.data.room1.connect((rows, c) => draw(rows, c.diff))   // connect(fn): the picture, then once per commit
  for await (const [rows, c] of chat.data.room2.connect()) { draw(rows, c.version); break }   // a loop: the newest each turn
  for await (const e of chat.data.room1.changes({ from: -5, signal })) console.log(e.version, e.rec)   // changes: every record
  const was = await chat.data.room1.past(-1)                              // past: the room as it was, a value
  room.disconnect(); link.disconnect(); console.log(was.value.m7?.text)
  // @ts-expect-error a read once is get(), not connect({ once }): that would subscribe the whole partition
  chat.data.room1.m7.connect({ once: true })
  // @ts-expect-error from on connect would turn a shared live link into a private reader that waits: use changes({ from })
  chat.data.room1.connect(draw, { from: -5 })
  // @ts-expect-error a handle has no then(): `await` gives the handle back, never the row; read once with get()
  const row: Msg | undefined = await chat.data.room1.m7.connect()
  ```
  - `get()` reads once and holds nothing: one GET, or no trip where the rows are held on purpose. It takes `{ fresh }` (ask the leader), `{ version: true }`, `{ when }` (wait until a test passes, holding the partition meanwhile), `{ signal }` and `{ timeout }`.
  - `connect()` keeps the lens's partition live here, in three forms: a handle (`value`, `ready`, `cursor`, `closed`, `disconnect`); `connect(fn)`, which calls `fn(value, c)` on the picture and then once per commit; and a loop, the newest state each turn. `c.diff` holds the commit's changes, each with `prev` and its row's `version`.
  - `changes()` is the log: every record on the lens's path from a place, then live. It waits for its reader. `past(pos)` is one partition as it was: a value, walked with `for…of` and `step(n)`, with nothing to end. It is in the first build (V5-17).
  - **A fifth read verb, the root's alone, came with V5-20**: `f.data.scan()` reads every row once, in pages, and keeps nothing (V5-20 item 4; 2.13). These four are on every lens.
- **Before.** `get()`; `here()` for a handle; `tap((c) => …)` for a call per commit; a weak `connect(target, fn)`; `changes()`; and `asOf(pos)`, a reader you moved and closed. In v4, data's `tap` chose its argument by reading the function's source text.
- **Why.** It is your one `connect` for live state, with its three forms (CONNECT 2.1). The log and the past keep their own verbs: `from`, `at` and `once` on `connect` are type errors that name `changes()`, `past()` and `get()`. Three things were built your way first:
  - `get()` built as `connect({ once })` subscribed the whole partition: 65,671 B and 1,000 rows folded to read one number, against 1 B by a GET (E-56 probe 1) *(checked)*.
  - A handle you could `await` lost every link that passed through code that resolves values: 1,000 of 1,000 left open, with no handle to end them (E-56 probe 1) *(checked)*. So a handle has no `then`.
  - `from` on `connect` turned the same slow loop from 1 to 50 waiting rows into a queue of about 45,600 commits. That is a judgement, not a measurement: 7,777 such loops ran with 0 wrong answers (CONNECT 2.4).
- **Cost.**
  - Rules: CONNECT's share is 0 to +16 over READS.md's pick; the read surface as a whole, with V5-12's rows, is +10 to +41 on the 416 (CONNECT 8.5).
  - Speed: a callback costs 161 to 189 ns a commit over no link. A loop costs +166 to +241 ns over a callback when commits merge in bursts, and holds 1 to 50 waiting rows when it runs 10 times slower than the writes (E-56 probe 2) *(measured)*. Equal lenses share: 2,000 handles on one row and 100 writes made 1 SUB and 100 decodes (E-56 probe 4) *(checked)*.
  - What gets worse. One word has three forms and two return types; a loop over a callback handle is a type error. A loop turn has no `c.recs()` or `c.text()`. A partition's state can run ahead of its turn's diff, in 2.9 % of merged turns (E-56 probe 4). "Replay the last 5 with state, then live" is two calls with a seam: `past(-5, { to: 'latest' })`, then `connect()`. And words you approved two days earlier are renamed again.

### 2.2 Every link ends by your code (V5-13 picks 2 and 5)

- **Now.** A link ends at the first of: `disconnect()`, its `signal`, its `until`, `break` in a loop, the count, or the process's clean stop. The collector never ends one.
  ```ts
  // file: ends.ts — every link ends by your code, at the first of these
  import { fero } from 'fero'
  type Msg = { text: string; stars: number }
  const chat = await fero<Msg, 2>('chat')
  const h = chat.data.room1.connect()
  h.disconnect(); h.disconnect()                                          // 1. disconnect(): at once. Bound, and safe twice
  chat.data.room2.connect(draw, { signal })                               // 2. a signal aborts: a request, a job, a component
  chat.data.room3.connect((_, c) => ws.send(c.text()), { until: ws })     // 3. a socket says it closed
  chat.data.room4.connect(draw, { until: res, signal })                   //    the first of the two ends it; the other's listener goes
  for await (const [rows] of chat.data.room5.connect()) { draw(rows); break }   // 4. break ends a loop's link
  // 5. the count: equal links share one SUB; the last one out unsubscribes after `linger.ms`
  const room = chat.data.room6.connect()
  await room.ready
  const kept = { ...room.value }                                          // to keep rows, copy them while the link is live
  room.disconnect()                                                       // from here, room.value throws 'ended'
  // @ts-expect-error a DOM node never says it was removed, so until refuses it: disconnect where your code removes it
  chat.data.room1.m7.connect(draw, { until: el })
  // @ts-expect-error an HTTP request may say it closed while its client stays: pass the response
  chat.data.room1.connect(draw, { until: req })
  // @ts-expect-error tap is gone: connect(fn) does its job
  chat.data.room1.tap(draw)
  ```
  - **Three rules make several ends safe.** Every end is safe twice and removes the other ends' listeners. `until` takes only things that can say they already closed (a Node socket, stream or HTTP response, a WebSocket). The first call comes a microtask after `connect()` returns. Taking any one away broke a case (E-56 probe 4) *(checked)*.
  - **The ended rule.** A partition's value is readable only while its link is live; after the end, a read throws `ended`. To keep rows, copy them while the link is live.
  - **No weak links, no net, no `scope`.** In development fero prints one line when an open link's handle is collected and the link has no `signal`, `until` or parent. `f.cluster.value.links` lists the open links by path (V5-16; the name is V5-17's).
- **Before.** `connect(target, fn)` held its target weakly, so the collector could end it. `scope(fn)` gathered links for `dispose()`; `closes` named a target's close event; `close()` ended a handle; and a handle's rows stayed readable after `close()`.
- **Why.**
  - **The collector may never run.** In a headless Chromium it collected 0 of 1,000 removed DOM nodes in 30 s (E-55 claim 13). A weak link cost 2.2 times a strong sink (claim 11). `scope` lost links made after an `await` (READS 1).
  - **An HTTP request is not a close.** On Node 22.22.0 a request whose body was read said it closed at 19 ms, while its client stayed until 315 ms (E-56 probe 5) *(checked)*. So pass the response.
  - **A read after the end had four answers.** As first built, it gave a different answer on a client with no linger, with a 50 ms linger, on a server, and with another link on the same rows. With a guard per link, every such read threw `ended` (E-56 probe 4) *(checked)*.
- **Cost.**
  - **A link nobody ends runs until the process stops**, and the line does not show it: 1,000 such links cost 0.80 to 0.90 ms a commit (*measured* for weak links whose targets were never collected, E-55 claim 12; the same work here, *reasoned*). The dev warning needs the collector to run, and a handle kept in a variable never warns.
  - `{ signal }`: 0.11 to 0.16 µs to join one listener per signal and 0.05 to 0.07 µs to leave, at 1,000 to 10,000 links. `{ until }`: +0.39 to +0.59 µs a link (E-56 probe 4b) *(measured)*.
  - Copying rows to keep them is O(rows), on the line. A React hook that keeps a room's rows must drop them in its cleanup (CONNECT 10).
  - The `ended` guard is one flag check in the view's read trap *(reasoned)*. Its cost in a real build is owed.

### 2.3 Positions: a version inside one partition, a cursor across (V5-13 pick 4)

- **Now.** A **version** is short text that keeps log order under plain `<`, such as `38S9`. The same text is `ack.version`, `c.version`, a diff entry's and a log entry's version, and `if: { version }`, so code compares with `===`. Inside one partition, a commit's id is the version of its last record there. Across partitions there is no single id; a place is a **cursor**. The log and the past also take `-N` (a negative literal, N commits back) and a `Date`.
  ```ts
  // file: positions.ts — a version names a record, and so its commit, inside one partition; a cursor names a place anywhere
  import { fero } from 'fero'
  type Item = { stock: number }
  const parts = await fero<Item>('parts')                                 // a client of a resource with no methods: it may write
  const ack = await parts.data.widgets.set({ stock: 3 })                  // ack.version: such as '38S9', in log order under <
  const h = parts.data.widgets.connect((row, c) => console.log(c.version === ack.version, c.cursor))   // the same text
  for await (const e of parts.data.widgets.changes({ from: ack.version, to: 'latest' })) console.log(e.version)   // from that commit
  const r = parts.data.changes({ from: saved ?? 'earliest', to: 'latest' })   // every partition: from a saved cursor
  for await (const e of r) { console.log(e.partition, e.version); keep(r.cursor) }   // save the cursor as you go
  const hour = await parts.data.widgets.past(new Date(Date.now() - 3_600_000))   // a time is a Date
  const back = await parts.data.widgets.past(-5)                          // 5 commits back: a negative literal
  h.disconnect()
  console.log(hour.version < ack.version, back.cursor)
  // @ts-expect-error a version names one partition's commit and does not say whose: on the root, save a cursor
  parts.data.changes({ from: ack.version })
  // @ts-expect-error a count back names one partition too: on the root, give a Date
  parts.data.changes({ from: -5 })
  // @ts-expect-error a time is a Date, never a bare number: in one partition a number would be a count back
  parts.data.widgets.changes({ from: Date.now() - 60_000 })
  ```
  | You give | It names | `changes({ from })` | `past(pos)` reads | `to` |
  |---|---|---|---|---|
  | a version | a record, and so the commit that holds it | starts **at** that commit: it comes again, whole | right after that commit | stops after it |
  | a cursor | the place after what a reader saw | starts after it: nothing comes twice | the state there | stops there |
  | `-5` | the place before the 5th last commit that reached this lens | those 5 commits, then live | the state before them | |
  | a `Date` | the place before the first batch stamped after that writer time | from that batch | the state before it | stops there |
- **Before.** A version was opaque text. A commit had no id and no place. A time was a bare number, and the log stopped at `until: 'latest'`.
- **Why.** You asked what a commit id looks like, and whether Merkle trees help.
  - Every partition has one leader and one order, so a position already says what is missing. A version's text kept log order with 0 errors in 1,000,000 seeded pairs (E-56 positions) *(checked)*.
  - **No Merkle trees.** Kept per write, a Merkle tree that keeps only its leaf sums cost +254 to +309 ns at 1,000 rows; a tree rehashed on each write cost +598 to +605 ns at 1,000 rows and +1,395 to +1,747 at 1,000,000. None came under the 0.2 µs bar for a version kept per write. And a resume by "the rows newer than mine, plus tombstones" beat a Merkle walk in all 8 cases: 1.7 to 5.3 times fewer bytes, in 1 trip against 3 to 5 (E-56 positions) *(measured; the bytes checked)*.
  - A version and `-N` are refused on the root by the types: across partitions there is no one order.
- **Cost.**
  - **A version does not say whose it is.** Most wrong ones are refused `bad-position`, but one from another slot can land on this partition's own record and give a quiet wrong answer (CONNECT 3.2) *(reasoned)*. So **save the cursor to resume**; show, compare and guard with the version.
  - A cursor is 28 to 35 characters for one partition (E-56) *(checked)*, and 4 to 13 KB for a whole resource *(reasoned)*.
  - `-N` makes the server count back, since versions have gaps: about 0.6 to 2 ms at 10^6 partitions when writes spread evenly, and up to all of `history` for a cold partition beside a hot one (CONNECT 3.4) *(reasoned)*. Owed on a real log.
  - `c.version` and `c.cursor` are built only when read, and are not measured (bar: 50 ns a commit). A `Date` is approximate across partitions: 100 ms early to 300 ms late with 250 ms of clock skew (E-21).
  - A folded resume, `connect({ resume })`, would close 2.1's seam. E-60 modelled it in E-31's model, as V5-13 pick 7 asked: it keeps every property, and after 1 to 100 missed writes it sends 0.01 % to 10 % of a picture *(checked)*. **It comes later, when restarted screens matter** (V5-20 item 21): it needs per-row versions, which are owed anyway, and tombstones kept for a window.

### 2.4 Any path: every lens reads, a field too (V5-15 picks 1 and 2)

- **Now.**
  - **data's rule is the one rule for the state forms** (`get`, a link's value and its callback, a loop turn, `past(pos).value`): a write at or below the lens gives a change; a write above it counts only when the lens's value changed (a new object counts); a write beside it gives nothing.
  - **Every lens has the four read verbs of 2.1**, a field too; `scan()` is the root's alone (V5-20 item 4). The log forms (`changes()`, `-N`, stepping through `past`) take the records **on the lens's path**. A reader below a row takes its part from a record above it (a whole row, or a field that holds the lens), folds a record below it into the value it kept, and gives an entry only when its value changed.
  ```ts
  // file: anypath.ts — every lens has the four read verbs, a field too (V5-15)
  import { fero } from 'fero'
  type Item = { stock: number; price: number }
  const shop = await fero<Item>('shop')
  const stock = shop.data.w.stock                                         // a field lens
  const s = await stock.get()                                             // its value, once
  const h = stock.connect((n) => draw(n))                                 // runs when stock changed, never for a write to price
  for await (const e of stock.changes({ from: -3, signal })) console.log(e.value)   // its own log: the value after each change
  const was = await stock.past(-1)                                        // starts with a past read of its row
  await shop.data.w.set({ stock: 4, price: 9 })                           // above: the link runs only if stock changed
  await shop.data.w.price.set(10)                                         // beside: the field link gets nothing
  console.log(s, was.value)
  h.disconnect()
  ```
  - On a field, `e.value` is the field's value right after the record (V5-17). `-N` counts commits whose records reached the lens: at or under it, or above it and changing its value. On a field it is found by reading the row's log back. Replaying a field from an old place starts with a `past` read of its row.
- **Before.** No rule said when a reader below a write hears of it. `changes()` read the records "under the lens", and `-N` was "the unit a callback sees". ANYPATH.md's first answer stopped the log at the row; you asked whether a field could keep a log of its own, and the pick changed. On E-55's prototype a field link ran on every write to its row.
- **Why.**
  - "Under the lens" missed 74 % and 78 % of the changes below a row. "On the path" missed 0, and held the right value after all 240,000 commits (E-58 part 1) *(checked)*.
  - Stopping the log at the row would give a field fewer verbs than every other lens: a special case for users.
  - With data's rule, 2,000 seeds of writes at every level gave 0 wrong states, 0 missed changes and 0 wrong values-before, on 13 lenses, on a server and on a client that held only some partitions (E-58 parts 1 and 2) *(checked)*.
- **Cost.**
  - Speed: +6.7 to +11.2 ns a link a commit at 100 links over E-55's rule, and the user's function runs 5 times a commit where it ran 100 (E-58 T2, number fields) *(measured)*.
  - **"Changed" means a new object.** A record that crossed the wire is a new object, so on a client and on every copy but the leader, a link on an object value runs again after a whole-row write that left it equal (E-58 T11) *(checked)*.
  - Builders get a new reader for the log below a row, with a run-time rule the types cannot show. A field's `-N` reads the row's log back, which is not priced.
  - Rules: V5-15's changes are not priced: 13 items, about 0 to +13 at 0 to +1 each *(a guess; LAYERS 0.2)*.

### 2.5 Writes at any path, and rooms (V5-15 picks 3, 5, 6 and 7)

- **Now.** Inside one partition a write may land at any level: a room, a row, a field, a nested field.
  ```ts
  // file: writes.ts — writes at any path inside one partition, and rooms (V5-15)
  import { fero, op } from 'fero'
  type Item = { stock: number; price: number }
  type Msg = { text: string; at: number }
  const shop = await fero<Item>('shop')                                   // a client of a resource with no methods: it may write
  const chat = await fero<Msg, 2>('chat')                                 // depth 2: a room is a partition
  await shop.data.w.set({ stock: 4, price: 9 }, { ttl: '1h' })            // a row, whole, with its ttl
  await shop.data.w.stock.set(2, { if: { equals: 4 } })                   // a field guard: this field only
  await shop.data.w.stock.set((n) => (n ?? 0) - 1)                        // set(fn) on a field: guarded by the field
  await shop.data.w.set(op.merge({ price: 10 }))                          // one field record per merged key
  await chat.data.room1.set({ m1: { text: 'hi', at: 1 }, m2: { text: 'yo', at: 2 } })   // replace a room: one batch
  await chat.data.room2.remove()                                          // empty a room: one batch
  // @ts-expect-error the root spans partitions, which share no order: write each row or room, or fero.drop(name)
  await shop.data.set({ w: { stock: 1, price: 1 } })
  // @ts-expect-error a ttl belongs to a row: not on a field write
  await shop.data.w.stock.set(1, { ttl: '1m' })
  // @ts-expect-error a room is replaced by rows, not by one row
  await chat.data.room1.set({ text: 'hi', at: 1 })
  ```
  - **A room takes `room.set(rows)` and `room.remove()`, and nothing else.** Each is one batch, which the leader expands into row records from the keys it holds, and each answers at the commit only. The root stays refused, and its type error names the way: write each row or room, or `fero.drop(name)`.
  - **One version per row, said plainly.** `if: { version }` is always the row's. On a field lens, `if: { equals }`, `absent` and `present` test the field, also inside `set(fn)`.
  - **One shape rule at the leader.** A missing parent field is `absent-path`. A parent that is a string, a number or `null`, an index past an array's end, or a named step on an array is `bad-shape` (new). A key `__proto__` is `bad-key`, at `at()` too.
  - A field write takes no `ttl` or `while`: those belong to a row, and the leader refuses them `field-ttl` (V5-17). `op.merge` on a row that exists is sent as one field record per merged key.
- **Before.** "A write needs a row": a write to the root or to a room was refused `bad-path`. One version per row went unsaid, and `set(fn)` guarded a field write with the row's version. Shapes that data fills in went through, and `ttl` compiled on a field write.
- **Why.**
  - **Across partitions a write stays refused.** Partitions share no order, so a root write split into one commit per partition shows half of it to a reader of two rows. A loop that woke every 1 to 4 commits saw a half-done state in 63.1 % of root replaces and 39.1 % of moves between rooms; with a room replaced as one batch, 0 (E-58 part 3) *(checked)*.
  - **A room write has no race.** The leader knows the room's keys, so no writer can add a row between your read and your removes, and you need not hold the room to learn its keys.
  - **Field guards.** A row version refused 8 % to 45 % of guarded field writes only because a sibling field changed, in E-58's mix of writes (part 5) *(checked)*.
  - **The shape rule.** data fills such shapes in, or lets them through. Five of them break the state or the wire, and three get past data's own reader rule (E-58's shape runs) *(checked)*. With the rule, every write v5 takes keeps data's rule exact *(reasoned)*.
- **Cost.**
  - A room write is one log entry. In data's fold alone, it was 2.3 to 5.9 times less work than the same rows as separate commits (E-58 T1) *(measured)*. A size rule for it is owed; past it, the leader refuses `room-too-large` (V5-17). `room.remove()` leaves one tombstone per row.
  - An `equals` guard carries the old value in each request, where a version is a few bytes, and the leader now compares a field's value. This amends API.md 3.7's "no new rule at the leader". Its cost is owed.
  - Code ported from data or v4 that relied on the fill-in must write the parent whole: about 1 in 9 commits in E-58's mix *(checked; the share is the mix's)*.
  - A remove that finds nothing answers as done (V5-17).

### 2.6 Methods: root calls on `f.data`, and four kinds (V5-13 pick 6, V5-14 pick 4, V5-20 item 5)

- **Now.** A root method is called on the root lens: `f.data.ping()`. A method comes in four kinds: an **action** (a function, or `{ at, run }` to be called on a path), a **served view** (`{ view }`: an address you `get` or `connect`), **pages** (`{ pages }`: one sorted list read a page at a time), and, since V5-20 item 5, a **fold** (`{ fold }`: live code over every row, read as a served view with no argument; 2.13).
  ```ts
  // file: methods.ts — root methods sit on f.data; three of the four kinds of method (a fold is in 2.13)
  import { fero } from 'fero'
  import type { Shop } from './server.ts'
  const shop = await fero<Shop>('shop')
  const pong = await shop.data.ping()                                     // a root action: called on the root lens
  await shop.data.widgets.sell(1, { once: 'order-981' })                  // an action on a row, at most once
  const low = shop.data.low(5)                                            // a view: an address; nothing is sent yet
  const top = await low.get()                                             // one picture
  const live = low.connect()                                              // or live, kept for every equal call
  const page = await shop.data.byPrice(null).page()                       // pages: one read; it holds nothing
  console.log(pong, top, page.rows, page.next)
  live.disconnect()
  // @ts-expect-error f.methods is gone: a root method is called on f.data
  shop.methods.ping()
  // @ts-expect-error a served view is an address, not a promise: get() it, or connect() it
  const rows: readonly { stock: number }[] = await shop.data.low(5)
  await fero.of<{ stock: number }>()('names', { methods: {
    // @ts-expect-error a method may not take a fero word where it is called: 'bad-name' when the server opens
    connect: { at: 'row', run: (k: number, ctx) => ctx.at.stock.set(k) },
  } })
  ```
  - **A method may not take a fero word where it would be called**: at the root, the read verbs (`scan` among them, V5-20 item 4), the operators, `set`, `remove` and the probe names; on a row, the read verbs, `set`, `remove` and `touch`. The types refuse it where it is declared, and the server refuses it at open, `bad-name`.
  - **A client gets the method table at open.** An unknown name is refused here, with no trip: `no-such-method`. `lens.call(name, arg)` stays for a name held in a variable.
- **Before.** `f.methods.x(arg)`. On a lens, fero's names won, and `lens.call` was the way out. A view was a method that returned one, then `here()`'d, and it could be awaited.
- **Why.** You asked why a root method was `f.methods.x` and a path method `f.data.k.x`. Now one rule covers both: a method is called on the lens where it runs, and the root is a lens (READS 4). "fero's names win" hid a method behind a verb without a word. And a library that probes objects by name now fails loudly, where before it could send a call.
- **Cost.** A word fero adds in a later version breaks an app that used it as a method's name, loudly, at its next start. In a rolling deploy a stale or missing table must never refuse a valid call: that is reasoned, and a sim is owed (Q-B10).

### 2.7 Where a transform runs: the line, served views and pages (V5-14 picks 1 to 4 and 7; V5-20 items 1, 11, 13 and 20)

- **Now.** **One line, the live verb, decides where a transform runs.** Right of `connect()`, any code runs here, on rows held on purpose. Left of it stands plain data only (`eq`, `in`, `gt`, `az`, `za`, `by`, …), which a copy may run inside one partition later (class B). Over every row a client gets only a view the server names (a `{ view }` or a `{ fold }`), `{ pages }`, or `scan()`. **Across groups, a served view whose operators merge is merged**: one partial per group, added up by key at one cut by the merger (V5-20 item 1; 2.13).
  ```ts
  // file: views.ts — the line: your code right of connect(); views the server names; pages; the one join
  import { fero } from 'fero'
  type Fan = { name: string; team: string; points: number }
  type Order = { user: string; sku: string; cents: number }
  const server = await fero.of<Fan>()('fans', { methods: {                // on a server: the views it names
    best: { view: (n: number, ctx) => ctx.data.za('points', Math.min(n, 100)) },   // a window: bounded
    byTeam: { view: (_: null, ctx) => ctx.data.by('team').sum('points') },          // buckets: one number each
    ranked: { pages: (_: null, ctx) => ctx.data.za('points'), size: 20 },           // one sorted list, in pages
  } })
  const fans = await fero<typeof server>('fans')                          // a client, typed by the server
  const top = fans.data.best(10).connect((rows, c) => draw(rows, c.order))   // kept for every equal call; only its changes cross
  const teams = fans.data.byTeam(null).connect()                          // a Map from team to number
  const p1 = await fans.data.ranked(null).page()                          // one page, every group asked in one round; it holds nothing
  const orders = await fero<Order, 2>('orders'), products = await fero<{ price: number }>('products')
  const big = orders.data.ada.connect().filter((o) => o.cents > 100)      // right of connect(): your code, here
  big.lookup(products.data, 'sku').connect((rows) => draw(rows))          // the one join: undefined loading, null none
  await teams.ready
  console.log(teams.value.get('red'), p1.next, top.cursor)
  // @ts-expect-error a function cannot stand left of connect(): code cannot travel; connect() first
  orders.data.ada.filter((o: Order) => o.cents > 100).connect()
  // @ts-expect-error an operator over every row, on a client that holds nothing: call a view the server named
  orders.data.za('cents', 10).connect()
  await fero.of<Fan>()('more', { methods: {
    // @ts-expect-error a served view must be bounded: a window, one value, or buckets
    low: { view: (max: number, ctx) => ctx.data.lt('points', max) },
  } })
  ```
  - **Placement** (V5-14 pick 3, changed by V5-20 item 13). **A served view lives on a server that holds its rows, chosen by a hash, preferring one that leads no group of its resource.** Over several groups that is one partial per group, each on a copy of its group, and the merger on one server. A SUB at another server gets `moved`, naming the right one. When a group's only copy is its leader, as with one server process, the leader serves its views until a second copy is ready, and health says so (V5-17). Until `data` builds views in slices, a build on a server that leads a group can stall that leader's writes.
  - **The cap.** At most 64 served views per copy (`views.max`), each weighted by its cost class: O(1), O(log n) or O(n) a change. A client holds at most 16 per copy (`views.client`). With k ≥ 2 serving copies, `views.max / k` is kept free on each for clients whose copy died; with one, none. Past a cap: `too-many-views`.
  - **The row guards.** Until data 5's ordered index, an ordered view over more than 5,000 rows and `{ pages }` over more than 2,000 are refused when built, `view-too-big` *(the numbers are guesses)*.
  - **Past `views.rows` (1,000 buckets), the served instance a client follows ends `view-too-big`** (V5-20 item 20). After a reload or a failover the view may be built again, and if it fits, it is served. An ended instance never serves again, so the build does not loop.
  - **Pages over several groups** (V5-20 item 11): each group keeps its own index, and a page asks every group in one round; each sends its next `size` entries, and the asker keeps the first `size`. A two-round form comes once a pinned read exists.
  - **A view must be** bounded (a window, one value, or buckets); blind to the caller (a per-user view takes the user as its argument, and `allow` checks it); a function of its argument and the rows (no clock, no random number); and of one resource.
  - **`lookup`** is the one join, right of the line: for each left row, the other resource's row with that key, kept live: `undefined` while loading, `null` when there is none. **Bucket answers are a `Map`** with typed keys: `teams.value.get('red')`.
- **Before.** A served view lived on whichever server took the SUB, under a cap of 1,000 per resource and 16 per client, both guesses. On the 2026-11-21 page it lived on one copy, never the leader; `{ pages }` kept one shared index on that copy; and END `view-too-big` "stays until the method's code changes". TRANSFORMS' first plan made one served view per page cursor. Dashboards used `group(fn)`, ties broke by arrival, and sums were plain floats. In fero v2 to v4 and in data, transformations were 70 sources of complexity and bugs (TRANSFORMS 2).
- **Why.**
  - **Off the leader where it can be.** Serving from standbys first refused a held view in 377 of 1,000 seeds with one standby; with every copy but the leader serving, 5 and 6 of 1,000 (E-57) *(checked)*. Once a resource has several groups, its leaders spread over the servers, so a view may have to live on a server that leads a group; keeping served views only on servers that lead nothing was rejected (V5-20).
  - **END per instance.** E-60 found that "stays until the method's code changes" cannot hold: a copy that reloads before it folds the too-big commit never meets it (V5-20 item 20) *(checked)*. Holding END on every server was rejected (V5-20).
  - **So few.** Every live served view sees every write to its resource. At 50,000 writes a second, one core has about 18 µs a write left for views. A bucket or sum view costs 1.8 to 4.9 µs a change, and a leaderboard 5.7 to 6.7 µs at 1,000 rows and 134 to 155 µs at 100,000 (E-57 A1, pagecost) *(measured)*. Served views are for a few shared answers per resource, not a query per user.
  - **Pages.** One view per cursor cost 0.7 to 8.3 MB a page and was refused by the 17th page. With one shared index, a page read is 10 to 16 µs and 32 B on the copy (E-57 XA-7) *(measured)*. A global range index across groups was rejected (V5-20).
  - **`by(field)`** costs 0.66 to 1.84 µs a change at 10^6 rows, where `group(fn)` took 78 to 94 ms (E-57 B2) *(measured)*. `lookup`: 537,670 checks, 0 unequal (E-57 B4) *(checked)*.
- **Cost.**
  - Rules: about +26 (21 to 45) on the 416 for the first build (TRANSFORMS 8.3). Users learn ten more rules (TRANSFORMS 8.4; API 3.10).
  - **Three bars are missed, and stated.** A view build over 10^6 rows stalls its copy 0.2 to 1.9 s until data builds in slices (XA-1); on a server that leads a group, that stalls the leader's writes too (V5-20 item 13). A client that held a view can still be refused after failures, in 1 to 21 of 1,000 seeds by configuration (XA-2; TRANSFORMS 3.8; V5-14's consequences quote 5 to 21, its standby and leader-kill runs). The chunked ordered index costs 9.5 to 15.1 µs a write at 10^6 rows, against a guessed 3 (XB-1).
  - **A `{ pages }` index costs every write while it lives**: 8.3 to 9.1 µs at 1,000 rows, 29 to 33 at 10,000, 509 to 525 at 100,000, on today's data (E-57 pagecost) *(measured)*. Over several groups a page costs more: at 256 groups, about 5,000 entries and 1.2 to 2.6 ms of work, about 400 to 860 pages a second for one asking process (MERGE 5.4 item 5) *(measured and arithmetic)*.
  - A new leader hands its views on: 1,796 to 3,271 hand-offs per 1,000 seeds with standbys (E-57) *(checked)*.
  - Owed: paging across a failover, and a data upgrade under live views. The `view` selector in E-31's model is done: E-60 found every property holds but the old END wording, now restated (V5-20 item 20).

### 2.8 data's merge contract, and data 5.0.0 (V5-14 pick 6; V5-20 item 7; V5-21)

- **Now.** **data 5.0.0 is one large major version, in TypeScript.** D1 (path subscriptions through a keyed index) and D2 (the callable lens that keeps nothing) come first. Then the merge contract (C1 to C10), the new operators (N1 to N5: `eq`, `in`, `by` and their kin), D3 (two-level stores), D4 (one sink shape) and D6 to D9, among them the ordered index. No Rust.
  - **The merge contract** makes every view a function of its rows only, not of the order they came in: ties break by row key; one total order per direction; one numeric projection; an exact sum over every finite double; typed bucket keys (`1` and `'1'` are two buckets); and `limit` and `reverse` over unordered rows are marked "arrival" and stay right of the line.
  - **Added since 2026-11-23.** Chunked ordered views and quantiles, so live views on a big hold stay fast and every operator keeps working over every row (V5-20 item 7), and lifting the cap of 16,777,216 rows a source. Its first storage piece splits each source's key index into small tables chosen by the key's hash (V5-21 item 2). Operators keep keys and the values they project, never whole rows (V5-21 item 5). A compact backing, behind data's own store, comes later, designed to cover servers' own rows as well as big holds (V5-21 items 3 and 6).
- **Before.** V5-12 pick 9 asked data for D1 to D4, in TypeScript, and kept Rust for L0 and L1. Today's data breaks the contract in many places: with 1 % strings in a number column, deleted rows stayed in a sorted view in 20 of 20 seeds (TRANSFORMS 2) *(checked)*.
- **Why.** You asked whether data needs a new version. It does: two copies, a rebuilt view, a failed-over view and a client must agree as values. Built small in E-57, every check held with 0 unequal, and each planted bug was caught in 159 to 1,000 of 1,000 seeds *(checked)*. No Rust: rows stay JavaScript objects and user functions are JavaScript, and a plain Rust map fold measured no faster (E-54).
- **Why the additions.** Until data 5, a top 10 over 1e6 held rows costs 2.5 to 2.6 ms a write (E-65) *(measured)*. data's one key `Map` per source stalls 249 to 304 ms as it grows past 4.2e6 keys, and stops at 16,777,216; 64 small tables kept every rebuild under 20 ms and passed that count (E-66) *(measured)*. An operator that keeps whole rows would have to be rewritten the day a compact backing comes; one that keeps keys stays cheap to move (COMPACT.md section 2; 4 of data's classes change, and 3 keep a key where they kept a whole-row projection) *(checked: read)*.
- **Cost.** About 33 changes, 20 of them breaking, and about 5,000 to 10,000 lines written or changed against an engine of 7,699 lines *(a guess, against a count; TRANSFORMS 0)*: by lines it may touch as much code as the engine has. data's own users meet the breaking changes too. data's five path-rule holes (E-58) are listed in STATUS for its owner; fero needs none fixed, since its leader refuses those shapes first (V5-15).

### 2.9 `derive` in two forms (V5-14 pick 5, V5-15 pick 4; V5-20 items 10 and 18)

- **Now.**
  ```ts
  // file: derive.ts — derive in two forms: the view form, and the record form, with rows or without
  import { fero, op, derive } from 'fero'
  type Order = { user: string; cents: number; paid: boolean }
  const orders = await fero<Order>('orders', { server: true, history: '7d' })   // every row, and 7 days of log for the record form
  const totals = await fero<number>('totals', { server: true })
  await derive(orders.data.by('user').sum('cents'), totals)               // the view form: totals equals the view
  const counts = await fero<number>('counts', { server: true })
  await derive(orders, counts, (e) => {                                   // the record form: once per record, by marks
    if (e.value) counts.data[e.value.user].set(op.incr(1), { from: e })   // e.value: whole-row writes only
  })
  const paid = await fero<number>('paid', { server: true })
  await derive(orders, paid, (e, { row, prev }) => {                      // with rows: the row after and before the record
    if (row?.paid && !prev?.paid) paid.data[row.user].set(op.incr(row.cents), { from: e })   // a field write counts too
  }, { rows: true })
  // @ts-expect-error the view form takes one value per bucket: group's buckets are as big as the rows
  await derive(orders.data.group('user'), totals)
  ```
  - **The view form, `derive(view, target)`**: the target's rows equal a bucket view of the source, one value per bucket, over a string or number field. It reads rows, not history, so it needs no `history` and survives the log being cut. It takes the lock `derive:<target>`, with the code version in the lock row; **bumps** every target group (one fenced no-op write each); reads the source's position after the bumps (the **read barrier**); writes the difference; then follows. Only the deriver writes the target; any other write is refused `derived`.
    - **Over several groups it follows the merged view**: it holds the buckets, never the source rows (MERGE 5.2). **Its buckets have a stated limit** (V5-20 item 10): about 1.6e5 at 16 groups, 1e4 at 256, since it keeps each group's sum for every bucket. Past it, use the record form; O4, shards by output key, comes next, beside the merger.
  - **The record form, `derive(source, target, fn)`**: `fn` runs once per source record and writes with `{ from: e }`, a mark that makes it exact across restarts. `fn` is awaited before the next record, and makes every write before its promise settles (V5-20 item 18; 2.14). It needs the source's `history`. It sees the record, not the row: `e.value` is set only for a whole-row write.
  - **The record form with rows**, `{ rows: true }`, is in the first build: `fn` also gets the row after the record and before it, so a field write counts too. A dev warning names the line when the plain record form reads `e.value` on a field record.
- **Before.** Only the record form, with marks. V5-14 pick 8 kept the first build to records only; V5-15 pick 4 replaced it the same day. A record with several outputs was open (question 21).
- **Why.**
  - The view form as first planned (a lock, fenced writes, a full difference) failed 514 of 1,000 seeds: the target was wrong at idle in 28 and handed back to older code in 452. With the bump, the barrier and the code version: 0 of 1,000, through 11,810 deriver changes (E-57 B3) *(checked)*.
  - A filter on `e.value` alone left the final set wrong in 582 and 584 of 1,000 seeds of E-58's mix (part 4) *(checked)*. With rows, such a filter is exact.
  - Several outputs of one record: the mark carries the write's number within its record, and a record's outputs to one slot go out in order. E-30's model, widened to two outputs in one slot, held on all 12 bounds; without the number or the order, an output is lost (E-57 B5) *(checked)*.
- **Cost.**
  - The view form: 0.748 target writes per source commit, and a restart takes 48.7 to 51.8 ms at 10^5 source rows and 10^3 buckets (E-57 B3) *(measured)*. Its log is a log of states, so a reader that counts its records miscounts.
  - The record form with rows: one fold a record, 0.63 to 1.5 µs, and about 330 B a row of the deriver's share (E-57 A1; E-05) *(measured)*. A build of it is owed.
  - Past 256 outputs of one record to one slot: `too-many-outputs`. Two buckets with one name at run time stop the view form with `bucket-collision` *(reasoned; not run)*.
  - The view form's bucket limit over several groups comes from the memory each group's sum takes: about 2.5 million (bucket, group) pairs in a GB (MERGE 5.4 item 3; the GB is a guess). O4 in the first build was rejected (V5-20).

### 2.10 One sync read, `.value`, only where it is sure (V5-16)

```ts
// file: sync.ts — the one sync read is a live handle's value; the cluster is this process's own state
import { fero } from 'fero'
type Item = { stock: number }
const shop = await fero<Item>('shop', { server: true })
const all = shop.data.connect()                                    // every row, on any role, under memory; held here already, no SUB
await all.ready
const n = all.value.widgets?.stock                                 // a sync read: one lookup through the handle
const known = shop.cluster.value.members                           // undefined until a server answers: check it
const inFlight = shop.cluster.writes.value.length                  // this process's own writes
const watch = shop.cluster.connect((shape) => draw(shape.health))  // the shape a microtask after the call, then each change
// @ts-expect-error f.rows is gone: read every row through a connect() handle
shop.rows.widgets
// @ts-expect-error snapshot() is gone from the cluster: read f.cluster.value
shop.cluster.snapshot()
console.log(n, known ? Object.keys(known) : 'no server yet', inFlight); watch.disconnect(); all.disconnect()
```

- **Now.**
  - **`.value` is the one sync read**, and it is there only where it is sure: a live handle's `h.value`, a `past`'s `value`, and `f.cluster.value` with `f.cluster.writes.value`. Everywhere else, `get()` reads once and `connect()` keeps a link.
  - **Every row, read in sync, is `f.data.connect()`'s handle**, on any role. On a server that holds every group, or with `hold: 'all'`, it shares the rows already held. On a bare client, a spare, or a server that holds only some groups, it subscribes to what it lacks. Either way every row must fit this process's `memory` (V5-20 item 3; 2.13).
  - **Two reads of an unchanged row give the same object (`===`)**, for data's object rows, as today (V5-21 item 4). A compact source, when data 5 builds one, makes a row on read: there a row is a frozen value, new at each write, and code compares `version`, not identity (V5-21 items 4 and 7).
  - **`f.cluster` is a live link the open holds for you.** Its value is a new frozen object at each change. `id`, `members` and `groups` read `undefined` until a server answers, never `{}`; after `destroy()`, a read throws `ended`. `connect((shape) => …)` follows a lens's link rules (V5-17). There is no `get()` and no `snapshot()` on it.
  - **A handler reads its row once**: `await ctx.at.get()`, with no trip at the leader; at the root, `await ctx.data[k].get()`.
  - **A lens has no `.value`**: a property on a lens is a step, so `lens.value` is the row or field named `value`.
- **Before.** `f.rows` on a server and with `hold: 'all'` (V5-13 pick 6 kept it); `f.cluster.snapshot()` and `f.cluster.writes.snapshot()`; `ctx.rows`; the cluster's `connect(fn)` with no value. On the 2026-11-21 page, a spare's root operators took the whole resource for a `get()` as for a `connect()`, and a row was "a new frozen object at each write", with nothing said of two reads of an unchanged row.
- **Why.**
  - **On a server, `f.rows` was not sure.** A resource has several groups (V5-18 pick 1), and a server may hold only some of them, or none, as a spare. A sync read cannot wait for a download, so the same line would work on a server that holds every group and throw on one that lacks some: the deployment would decide, not the line. A handle is sure everywhere: where rows are missing it subscribes, and if its link fails, `h.closed` says why.
  - **`connect()` can wait.** So on a server that lacks some groups, a `connect()` of an operator over every row (its root operators, or a handler's `ctx.data`) first takes what the server lacks, the way `hold: 'all'` does, under this process's `memory`, and then runs (V5-20 item 3; API 3.3; API.md's reading of TRANSFORMS R0, now bounded by `memory`; not measured). **A one-time `get()` of such a line does not take what it lacks**: one-time work over every row is `scan()`'s (V5-20 item 4), and one-time work through a full copy was rejected (V5-20). Whether that `get()` runs over a scan or is refused with a hint that names `scan()` is owed (6.3).
  - **A handle costs what `f.rows` did**: one lookup and one trap, plus the `ended` check, one flag whose real cost V5-13 already owes. No pattern reads `f.rows` (0 of 22), and P-01 already reads `client.data.connect()`'s value.
  - **`f.value`, every row with `hold: 'all'`, was weighed and not taken.** It needed a new role in the types and a rule for `hold` on a server, for a read the handle already gives, and it sits one slip from `f.data.value`, a step to a row named `value`.
  - **`.value` on a lens was weighed and not taken.** It would clash with a row or field named `value`, and the same line would read or throw by what other links hold.
  - **The cluster is this process's own state**, kept by a link the open holds, so a sync read of it cannot miss rows elsewhere, and a promise would wait for nothing.
- **Cost.**
  - Rules: about −1 to +1, in L4 (LAYERS 5.4; reasoned).
  - A `get()` on rows held here: the lens's walk, 0.17 to 0.29 µs (E-55 claim 1), plus a promise, about 50 to 90 ns on a stand-in: about 3 to 5 times a handle's lookup. In a hot loop, read `h.value`.
  - v4's examples: 46 lines in 33 files read the cluster with `snapshot()` or `tap`. 23 of them also read a field v5's shape lacks (`peers`, `epoch`, `me.uuid`, `me.hosts`, `me.origin`, `partitions`); what replaces the three `me` fields is owed, and `me.peers` (V5-19) lists only members, where v4's `peers` also counted clients.

### 2.11 What the rules add up to

| Source | Rules on the base's 416 (reasoned; LAYERS 0.2) | User rules |
|---|---|---|
| the read surface: the lens's rows (V5-12, LENS 4.4, +12 to +18), READS 7 (−2 to +7), CONNECT 8.5 (0 to +16) and V5-16 (−1 to +1) | +9 to +42 | seven (section 1) |
| the `past` reader, in the first build since V5-17 (LENS 4.4's `asOf` row) | +3 | |
| transformations, first build (V5-14; TRANSFORMS 8.3) | +21 to +45, about +26 | ten (2.7) |
| paths (V5-15; ANYPATH) | 13 items, not priced: about 0 to +13 *(a guess)* | none counted; data's rule and the shape rule apply (2.4, 2.5) |
| *the read surface and transformations* | ***+33 to +90: 449 to 506***, before V5-15's items | |
| V5-20 to V5-22 (LAYERS 0.2's third table): growth and a clean stop (E-59, +8); the watchdog (E-63, +2 to +4); refusals and skips (E-61, +3); rows only through data (V5-21, 0 to +1); the `view` selector (E-60, +7, 2 to 9); the merger (+11 to +18 net, V5-22 item 6); `scan()` (+9 to +19); folds (+4 to +6); the sorted column (+3 to +5); the budget by RSS (+4 to +7); the loop's rules (E-61, +5 to +6) | +51 to +86 | about +2 to +5 (a hold is bounded by `memory`; one pass over every row is a scan; live code over every row is a fold), and two for code that writes marks (2.13, 2.14) |
| **the first build** | **+84 to +176: 500 to 592**, before V5-15's items and GROUPS' rules for many groups | |
| later: class B; a folded resume; the browser build | +4 (3 to 6); +2 to +3; +1 | |
| later, from V5-20 to V5-22: combines the author writes, histograms per group, O4, the two-round `{ pages }`, a fallback for the move's wait, a standby merger, a compact backing | not counted | |

- The `view` selector stood outside the first build at +4 to +6 on the 2026-11-21 page. E-60 modelled it, and V5-20 puts its count, +7 (2 to 9), in the first build (LAYERS 4.3).
- With TRANSFORMS' central +26, the read surface and transformations come to about 454 to 487 (LAYERS 0.2; arithmetic). GROUPS' +6 to +26 for many groups (V5-18) are not in LAYERS' sum yet.
- **By V5-6's measure these choices cost rules, and cannot win on rules alone.** The trade: one verb per read job; links that end by code you can see; one text for a position everywhere; views that agree as values on every copy; every lens reading and writing right at any level; and, since V5-20, work over every row with no fixed row ceiling.
- **What you no longer have to know:** `here`, `tap`, the weak `connect` and its rule, `scope`, `closes`, `asOf` with its `seek` and `close`, `f.methods`, `f.snapshot`, `c.changes`, `c.now`, "fero's names win", the operator `top`, and since V5-16 `f.rows`, `ctx.rows` and the cluster's `snapshot()`.
- **What stays, said plainly:** `hold` has three values (nothing, `'all'`, a size); a write has three spellings (assignment on an untyped handle, `lens.set(v)`, `f.set(path, v)`); and `connect` has three forms.

### 2.12 Your answers that change the API (V5-17)

- **Now.**
  - **A service's answer that throws is taken again** (question 38). The request goes back, as a queue job does, until the asker's timeout runs out; then the asker gets `timeout`. API.md adds the queue's count: after `deliveries` tries, 5 by default, the ask rejects `threw` with the last message (question 41, V5-19).
  - **`past` is in the first build** (question 22), beside `get`, `connect` and `changes`, in a reader library.
  - **Two refusals have codes of their own** (question 33): `field-ttl` for a `ttl` or `while` on a field write, and `room-too-large` for a room write past the size rule, which is still owed.
  - **The open-links list is `f.cluster.value.links`** (question 26).
- **Before.** The ask rejected `threw` at the first throw, and no other worker ran the request; `past` came after the first build; the two refusals reused `bad-arg` and `too-large`; the list was `f.cluster.value.open`.
- **Why.** They are your answers (V5-17), each the other way from API.md's pick.
- **Cost.**
  - Each try after a throw costs two more commits, a release and a new claim *(reasoned, from E-22's queue library)*.
  - Rules: the `past` reader's +3 moves into the first build, then 449 to 506; with V5-20 to V5-22, 500 to 592 (2.11; LAYERS 0.2).

### 2.13 Every row, with no fixed ceiling (V5-20 items 1 to 13; V5-21; V5-22)

- **Now.** One-time work over every row is a **scan**. Live code over every row is a **fold**. A served view over several groups is **merged** at one cut. A sync read of every row is bounded by this process's **`memory`**. No feature has a fixed row ceiling.
  ```ts
  // file: everyrow.ts — every row once with scan(); live code over every row as a fold; views merged across groups
  import { fero } from 'fero'
  type Fan = { name: string; team: string; points: number }
  const server = await fero.of<Fan>()('fans', { methods: {                // on a server: what it serves over every row
    best: { view: (n: number, ctx) => ctx.data.za('points', Math.min(n, 100)) },   // a partial per group, merged at one cut
    mid: { view: (_: null, ctx) => ctx.data.median('points') },             // exact: a sorted column at the merger
    tiers: { fold: { emit: (f) => [[f.points >= 100 ? 'gold' : 'plain', f.points]], combine: 'sum' } },   // live code: a piece per group
  } })
  const fans = await fero<typeof server>('fans')                          // a client: it holds nothing, and a scan keeps nothing
  let points = 0
  for await (const [, fan] of fans.data.scan()) points += fan.points       // every row once, at one cut: no commit shown in part
  for await (const [key, fan] of fans.data.scan({ cut: false, signal }))  // no cut: each row once; a commit may show in part
    if (fan.points > 1000) console.log(key, fan.team)
  const tiers = fans.data.tiers().connect()                               // a fold: a Map from bucket to sum, merged from each group
  const mid = await fans.data.mid(null).get()                             // the median, read once
  const all = await fero<Fan>('players', { hold: 'all', memory: '2GB' })  // every row here: refused at open, not-held, if it will not fit
  await tiers.ready
  console.log(points, tiers.value.get('gold'), mid, all.cluster.value.health)
  tiers.disconnect()
  // @ts-expect-error scan() reads every row of the resource, at the root: read one row once with get()
  fans.data.ada.scan()
  // @ts-expect-error a fold takes no argument: one answer for every caller
  fans.data.tiers(5)
  await fero.of<Fan>()('sums', { methods: {
    // @ts-expect-error a fold's combine is one of fero's own: combines the author writes come later
    own: { fold: { emit: (f) => [['all', f.points]], combine: (a: number, b: number) => a + b } },
  } })
  await fero.of<Fan>()('names', { methods: {
    // @ts-expect-error nor may a method take the name scan, the root's own read verb
    scan: { view: (n: number, ctx) => ctx.data.za('points', n) },
  } })
  ```
  - **`scan()` reads every row once, in pages, and keeps nothing** (V5-20 item 4). It is for one-time work: a read of every row, `migrate`, `export`, and root code or a handler's loop over `ctx.data` that runs once. It reads pages from one copy of each group. This process keeps at most two pages a group, so its memory stays flat at any number of rows; on a server, the groups held there are read in place. **At one cut by default**: each group is pinned at one place, so no commit shows in part. **`cut: false`** opts out: a row that lived through the whole scan comes exactly once, any other at most once, and a commit may show in part. Each entry is `[key, row, partition]`. A scan is not live: it ends at `break`, `disconnect()`, its `signal` or its last row. While a group is down it waits, and health names the group.
  - **A fold is live code over every row** (V5-20 item 5): `{ fold: { emit, combine } }`. `emit(row, key)` gives the row's (bucket, value) pairs, and `combine` is one of fero's own: `'sum'`, `'count'`, `'min'`, `'max'`, `'distinct'` or `{ top: k }`. Each group's copy folds its own rows, and the merger adds the pieces by bucket at one cut. A client reads it as a served view, with no argument: a `Map` from bucket to value (the spelling is API.md's; V5-20 names the combines, not the words). `emit` depends on its row only, as a view does. A **merger audit** rebuilds the answer now and then from fresh pieces of every group, and compares. Combines the author writes come later, behind a self-check at build and the audit.
  - **A served view over several groups is merged** (V5-20 item 1; V5-22 item 1): one partial per group, on a copy of that group, and the merger, which adds them up by key at one cut. A client sees the answer at one cut: never back, and no commit shown in part. **A live median over every row is exact** (V5-20 item 6): the merger keeps a sorted column of that one field. Histograms per group come later.
  - **At a slot move**, when a slot moves from one group to another, the merged view waits about one move window (V5-20 item 12). If that wait proves too long, keys by blocks of slots, or a part for the moving slot, are the fallbacks; the timed window chooses, and neither is in the first build (V5-22 item 5).
  - **A group that cannot be reached** (V5-20 item 2, which changes V5-18 pick 5 for live merged views): the view keeps serving with that group's part frozen at its last place, health names the group, and a one-time fresh read waits. A group whose next step of a slot move needs a step from the down group waits too, frozen at the same cut, and health names each group it holds back. Such a pair is never given up (V5-22 item 3).
  - **The gap through a merger rebuild is stated, not closed** (V5-22 item 4). The frozen part lives in the merger's memory. A merger rebuilt while a group is down has no part for that group, so it serves nothing new until the group is back: the view stays at the old merger's last frame, and health says why. A rebuilt merger starts every group's picture from one cut of the old merger, which each group's copies keep from its acks (V5-22 item 2). A standby merger is studied later; whether it is built is not decided.
  - **`memory` bounds a sync read of every row** (V5-20 item 3). `hold: 'all'`, a whole-resource `connect()`, and a `connect()` of an operator over every row that takes what a server lacks all keep every row in this process. The bound is this process's `memory`, counted as RSS (the memory the box sees the process use, garbage and all): about 1.4 M small rows a GB. Health warns at 80 %. A hold that will not fit is refused when it opens, `not-held`. A live hold that passes the line ends `not-held`, and its rows are removed. Near the line, whole-resource holds end first; then a server refuses writes `read-only`.
  - **Two more limits of a big hold, stated** (V5-20 items 7 and 8). Every write to the resource is folded on this process's main thread, and `data` 5's chunked ordered views and quantiles keep live views on it fast. A full collection of a big hold pauses its process; a process that leads groups may still hold one under its `memory`, and health warns once a full collection there passes 0.5 s.
  - **Question 28 closes** (V5-20; 6.1). On a server that lacks some groups, one-time root code reads with `scan()`; live work that merges is a served view, and live code that is a fold is a `{ fold }`; only a sync read of every row and live code that is not a fold take what the server lacks, under `memory` (2.10).
  - **Compact rows: not in the first build, with six seams now** (V5-21 items 1, 3 and 7). So that one stays a cheap addition, the first build keeps six seams: fero reads rows only through `data` and keeps none of its row objects; snapshots and pictures name their format (rows as key, version and bytes), never a dump of V8's objects; the row version is a column of `data`'s store; `data` 5's operators keep keys, not rows; the read promise allows a row made on read for a compact source (2.10); and `data` 5 splits each source's key index into small tables (2.8). When a compact store comes, it sits inside `data`, as a second backing behind its own store, so every operator still runs. A resource turns to it only by an explicit setting its author chooses, reading field types from its schema (P-20); nothing switches by size, or by declaring a schema alone. No store key is named yet.
- **Before** (the 2026-11-21 page). Four read verbs, and no folds. "Across partitions there is no merger": a process that ran a view over every row kept one store fed by slot. MERGE.md's draft kept a fixed one-process ceiling for four features (its question 2). `memory` said only "near it, writes are refused `read-only`", with a warning at 80 %. A median over every row, and what a client of a merged view sees while a group is down, went unsaid. Question 28 waited.
- **Why.**
  - **No ceiling.** You asked whether one was needed at all, since a process can read each group's rows from the servers that hold them. EVERYROW.md built five ways round it, and E-65 checked each against a seeded oracle with planted bugs. A fixed row ceiling was rejected (V5-20).
  - **Scans.** 0 failed in 14,100 seeds; at one cut, 0 of 1,119,674 commits over several slots were torn *(checked)*. Through 1e7 rows the asker's heap peaked at 7 to 59 MB (E-65 X2) *(measured)*. One-time work through a full copy, and no cut by default, were rejected (V5-20).
  - **Folds.** 0 wrong in 1,375,885 checks over 3,502 seeds, through slot moves, resyncs, outages and deploys (E-65 X3) *(checked)*. fero's own run-time checks missed the merger's planted bugs, and only the test oracle saw them: hence the audit. The self-check at build named the broken law in 300 of 300 seeds for each of nine mistakes, so combines the author writes can come later behind it. Folds later was rejected (V5-20).
  - **The merger's rule 4** (V5-22). Under O1's three rules, 114 to 923 of 1,000 seeds failed, each with a picture that passed a half of a slot move. With a picture that carries its moves, form (a), 0 of 1,000 failed in each of four worlds (2,066,979 checks). Each group starting a rebuild from its own place wedged 107 and 732 seeds, and giving up a pair whose partner is down failed 81 to 611 (E-67) *(checked)*.
  - **RSS, not the live heap.** The box kills a process on RSS, and RSS ran 2.3 to 2.6 times the live heap: 698 to 703 B of RSS a small row (E-65 X1) *(measured)*. Counting the heap would let a hold be killed before the warning. Keeping a live hold past its line with only a warning was rejected (V5-20).
  - **An exact median first.** The sorted column costs about 12.8 B a value at 1e7 values, within the merger's `memory` (E-65) *(measured)*. An approximate median first was rejected (V5-20).
  - **Compact rows later, seams now.** No first-build bar needs a compact store: rows take about 700 B of RSS against DEP-13's 2 KB, and a leader's full collection passes 0.5 s only near 2e6 to 3e6 small rows. A row made from columns costs about twice `data`'s read at 1e6 rows, and three to six times at 1e4 (COMPACT.md; E-66) *(measured)*. Without the six seams, 11 of COMPACT's 18 places would become rewrites or broken promises the day one is built (COMPACT 5) *(counted)*.
- **Cost.**
  - **A scan's limit is time**: about 0.8 M whole rows a second at one asker, 16 to 20 M a second for one number field; on a server, its own groups at 9 to 10 M rows a second (E-65 X2) *(measured)*. **At one cut it costs the servers**: every copy keeps a before-image (the row as it was at the cut) of each pinned row the first time it changes, until the scan passes it: 127 B each, up to about 70 MB a copy for a 625,000-row group under steady writes *(measured and counted)*. So a copy keeps an image budget, and past it the scan ends `scan-lost`, never the writes. The budget, `scan-lost` and the scan's lease are owed.
  - **A fold**: on a group's copy, 0.73 to 4.47 µs a write of its own group for `sum`, `count` and `distinct`, 5.7 to 19.6 µs for `max` and `top`; at the merger, 18,000 to 26,000 writes a second for `max` or `top` at 256 groups (E-65 X3) *(measured)*. **Its buckets have a stated limit**, as `derive`'s view form's do: about 1.6e5 at 16 groups, 1e4 at 256 (V5-20 item 10). What a fold does past it is owed.
  - **A merged view costs one more hop**: 20 µs p50 on one box (MERGE 3.2) *(measured)*. While a group is down, the view does not move for that group; through a merger rebuild while a group is down, it does not move at all. In E-67 that gap was 40 to 65 sim steps on average, against 4.8 to 35 with every group up *(counted)*.
  - **A big hold**: every write is folded on this process's main thread, about 0.28 M writes a second with no live view on it. Until `data` 5, a top 10 over 1e6 rows costs 2.5 to 2.6 ms a write, and a median 0.15 to 0.19 ms; stores per group inside this process are the measured fallback (V5-20 item 7). A full collection is about 1 s at 5e6 small rows (E-65) *(measured)*.
  - Rules: users learn `scan()` (+1 to +3), a fold (0 to +1), and the `memory` bound in place of a fixed ceiling (net +1) (EVERYROW 5; reasoned). Builders: about +20 to +37 for EVERYROW's first build, and the merger +11 to +18 net, not +9 to +14 (V5-22 item 6; 2.11).
  - Owed: 6.3 lists them, from the scan's image budget to the standby merger study.

### 2.14 Marks, END, and a clean stop (V5-20 items 14 to 23)

- **Now.**
  ```ts
  // file: marks.ts — exactly once, said plainly: fn is awaited, a skip says so, marks cover the slots a name joined
  import { fero, op, derive, lock } from 'fero'
  type Image = { url: string }
  type Order = { user: string; cents: number }
  const images = await fero<Image>('images', { server: true, history: '7d' })   // the record form needs the source's history
  const thumbs = await fero<Image>('thumbs', { server: true })
  await derive(images, thumbs, async (e) => {                             // fn may be async: it is awaited before the next record
    if (e.value) thumbs.data[e.partition].set({ url: await resize(e.value.url) }, { from: e })   // written before fn's promise settles
  })
  const orders = await fero<Order>('orders', { server: true, history: '7d' })
  const spent = await fero<number>('spent', { server: true })
  await lock('derive:spent', async () => {                                // the four lines: one process, under a lock
    for await (const e of orders.data.changes({ from: spent.marks('spent') }))   // marks(): over the slots this name joined
      if (e.value) spent.data[e.value.user].set(op.incr(e.value.cents), { from: e })
        .then((ack) => { if (ack.skipped) console.log('handled before', e.version) })   // at or below its mark: skipped, not applied
  })
  ```
  - **`derive()` and `run()` await `fn`** before the next record (V5-20 item 18). run()'s cursor passes a record only once `fn` has returned for it and its writes are answered. It moves only up, and its writes carry the share's token, so a cursor write from an owner that lost the share is fenced (E-61's pick, taken with V5-20).
  - **The app's code keeps two rules** in any loop that writes marks (V5-20 item 18, and E-61's pick to put them in the docs). For one record, make the same writes in the same order on every run. Make every write before `fn`'s promise settles. The types cannot check either; a dev check that runs `fn` twice on one record and compares the writes comes later.
  - **A write skipped at its mark answers `skipped`**: "handled before", never `applied` (V5-20 item 17). Its answer carries `skipped: true`, and the leader never judges it again.
  - **A refused marked write** (V5-20 item 16). Refused on the row (a condition about the row, a shape check), it raises the mark and is final, so a copy sent again after a restart is skipped. Refused `fenced` or `forbidden`, which are about the writer and not the row, it leaves no mark, so the right writer's copy still lands. One that nobody awaits prints one line, once, and the loop goes on (E-61's pick).
  - **Marks cover the slots a reader name joined** (V5-20 item 19). A deriver joins each output slot in `#groups` before its first write there; `target.marks(name)` reads only those slots, and bare marks go only to them. `derive()` joins for you. In the four lines, `spent.marks('spent')` joins a home slot under the name, and a marked write joins its slot before its first write there *(API.md's reading: V5-20 says a deriver joins, not who joins in hand-written code)*.
  - **A reader whose source cut its log reads its marks again before it stops `expired`**, and goes on if they are at or past the earliest record the source keeps, so a share move and a cut do not stop a reader that lost nothing (E-61's pick).
  - **END `view-too-big` ends one served instance**; after a reload or a failover a view that fits is served again (V5-20 item 20; 2.7).
  - **A clean stop with no spare** (V5-20 items 22 and 23). The leaver stays in the group's config, absent, until healing swaps it out; the group does not shrink. It exits as soon as the voters left have the new config, can commit without it, and hold every committed entry. At `leave.ms`, if nothing can carry the group without it, it stops as a crash would, and the group waits for its restart; otherwise it waits while a hand-over can still finish. A leader that has appended its own removal takes no new write.
  - **Which thread judges writes** (V5-20 items 14 and 15). Judging stays on the main thread, beside `data`'s rows, with a watchdog that hands a group's leadership to a peer when main stops answering. F-14 takes the loose reading: one hand-over gap of about 0.5 s during a 5 s main-thread stall counts as keeping writes going. P-01 keeps its absolute bar, checked on a quiet machine with its own small shape; on shared machines a relative pin, judging's p99 over a no-judging control in the same run, catches regressions. No call changes.
- **Before** (the 2026-11-21 page). A skipped write was "answered as done". A refused marked write, whether `fn` is awaited, and which slots `marks()` reads went unsaid. END `view-too-big` "stays until the method's code changes". A clean stop with no spare "exits at `leave.ms`", read from LAYERS and not modelled. E-30's model with marks written by app code was owed.
- **Why.**
  - **E-61 modelled marks written by app code**: each source record changed the target exactly once on 42 bounds and in 4,000 seeded runs, through bare marks, refusals, an async `fn`, lost log tails, share and slot moves and a cut source log *(checked)*. It needs 25 rules, 23 of them shown needed; E-30 had 5.
  - **Await `fn`.** Without the wait, an async `fn` lost records in 327 to 485 of 1,000 seeded runs (E-61) *(checked)*. A synchronous-only `fn` was rejected (V5-20).
  - **The same writes on every run.** A condition read from outside `e`, such as a version taken from the target, makes a run again a different write: E-61's model found a record handled wrongly in 9 steps *(checked)*.
  - **Joined slots.** Reading only the slots that hold a mark loses records, and marks on every slot would send up to 4,095 bare marks a round for a deriver that writes one slot (E-61) *(checked)*. The app naming the slot of a bare mark was rejected (V5-20).
  - **Skips and refusals.** A skip answered with the earlier outcome, and locks forbidden on marked writes, were rejected (V5-20).
  - **The exit.** Exiting at `leave.ms` whatever happens left an only voter's group with no voter, in 3 steps (E-59) *(checked)*. Shrinking the config, and a hard exit at `leave.ms`, were rejected (V5-20).
  - **The judging thread.** Judging on the kernel worker was rejected, and with it E-63's questions on a worker copy of the rows; so was a relative-only P-01 (V5-20).
- **Cost.**
  - Rules: E-61's +3 in L2 and +5 to +6 in L5; E-59's +8 in L1; E-63's watchdog +2 to +4; the `view` selector +7 (2 to 9) (LAYERS 0.2; 2.11). Users learn the two rules for code that writes marks.
  - A clean stop with no spare may wait up to `leave.ms`; if nothing can carry the group without it, the group waits for the leaver's restart.
  - Under F-14's loose reading, writes stop for about 0.5 s while leadership moves off a stalled main thread.
  - Owed: the exit rules under network partitions and stale messages, which E-59 did not model; the dev check for the two rules; the pacing rule in a real client; a quiet machine for P-01 (6.3).

## 3. Choices from the earlier tours that stand

V5-13 to V5-15 changed their spelling, not their meaning. Each says the choice, why, and its cost, in short; the 2026-11-18 tour had the long form.

```ts
// file: address.ts — a path is an address: no trip, no read, nothing kept
import { fero } from 'fero'
type Item = { stock: number; price: number }
const shop = await fero<Item>('shop')
const stock = shop.data.widgets.stock                     // two steps: an address. Not a promise
const n = await stock.get()                               // a verb: read once
const same = await shop.at('widgets', 'stock').get()      // the same address, with no Proxy
// @ts-expect-error a lens is not a promise: `await` gives the lens back, not a value
const wrong: number | undefined = await stock
// @ts-expect-error a step names a field of the row, so a wrong name does not compile
shop.data.widgets.stok.get()
console.log(n, same, wrong)
```

- **A path is an address** (V5-12 picks 10, 11). Each step is a lens, and a name is a key until it is called. `f.at(...keys)` builds the same lens with no `Proxy`. Why: one address reads, writes, calls and streams, and a lens with `then` once made an `async` helper download 100,000 rows in one GET (E-55 review). Cost: a step keeps 0 to 0.3 B a key, against data's 318 to 1,333 B today (E-55 claim 2), and costs 49 to 99 ns, or 162 to 222 ns with keys spread over 10^6 rows, the case `at()` is for (claim 1). `typeof lens` is `'function'`; seven probe names read as `undefined`. And typed code writes with `set` (V5-12 pick 6), since TypeScript cannot give a property one type to read and another to write (E-55 claim 5); assignment stays on untyped handles.
- **A client holds nothing until a `connect()` says what** (V5-12 pick 1). `hold: 'all'` holds every row, under this process's `memory` (V5-20 item 3); a size is a cache of pictures, not subscribed. Why: every download is a line you wrote. Cost: v4's first example and about 20 example READMEs change, and a sync read of every row is `f.data.connect()`'s handle (2.10).
- **A read is served here only from rows held on purpose**, and a GET carries the highest position this process has seen. Why: on E-55's first build a program showed 9.7 patterns of reads served here or by a trip over 1,000 seeds, by when the collector ran; with the rule, 1 (claim 14).
- **A method on a path runs at that path's leader, and declares `at:`** (V5-12 picks 3, 13). The server refuses another path, `bad-path`: on E-55's changed build, 202 of 202 such calls were refused with 0 commits (claim 18). Cost: on a path, one trip and one commit; at the root, 0.66 extra trips a call with three servers. Type a client with `import type`, and check types before bundling: esbuild with `verbatimModuleSyntax` ships the server's code for `import { Shop }` by mistake (E-55 claim 24).
- **`depth: 2`: the first key is the partition** (V5-12 pick 4). Why: a message as a field of its room would lose a row's version, ttl and early stages, and a field write copies its room on every copy, 0.43 ms at 1,000 messages (LENS 1.1). Cost: one-row partitions take 1.3 to 1.5 times the fold until data's D3 (claim 19).
- **The mark is a write option, `{ from: e }`** (V5-12 pick 7). fero paces it: a marked write is never refused `backpressure`, and its reader stops yielding instead. Unpaced, E-55's stand-in lost outputs in 998 of 1,000 seeds; paced, 0 (claim 21). `derive()` and `consumer()` run it once. A write skipped at its mark answers `skipped`, never `applied` (V5-20 item 17; 2.14).
- **One handle, three moments** (V5-5, V5-11). `await w` is always the commit, 0.97 ms; `w.received` (the leader has it, 0.15 ms) and `w.replicated` (most copies have it, 0.36 ms) are progress reports for your own write (TypeScript, one box, median; MEMORY 9.3). Only a plain whole-row write has early moments, and the types say so: a field write, a room write, a condition, a `once` name and a mark answer at the commit only.
- **Writes made together leave together.** `await` in a loop is the one slow shape: 16 writes take about 15.5 ms one by one and about 1 ms together (PA-40, computed). Past 512 waiting writes, a plain write's handle rejects `backpressure`, and an assignment throws it.
- **Read, decide, write: three safe forms**: an op, a condition, and `lens.set(fn)`. A plain read then a plain set sold the last item twice in 120 of 120 races ([E-22](experiments/E22-api-prototype/README.md)).
- **A resource is a table, not a row**: about 8 KB per server while idle (V5-8).
- **Errors: one class.** Every failure is a `FeroError` with a `code`, an `outcome` (did it commit?) and a `hint` that names the next call. V5-13 to V5-15 add `ended`, `not-ready`, `aborted`, `bad-shape`, `bad-name`, `bad-arg`, `bad-target`, `bad-position`, `view-too-big`, `redeployed`, `stale-client`, `derived`, `bucket-collision` and `too-many-outputs`, and V5-17 adds `field-ttl` and `room-too-large`; `no-method` is now `no-such-method` (API 8). V5-20 adds `scan-lost`, and `not-held` also ends a hold that passes `memory` (2.13).

**What the 2026-11-18 spellings became:**

| 2026-11-18 | Now | Where |
|---|---|---|
| `lens.here()` and its handle | `lens.connect()` | 2.1 |
| `tap((c) => …)`, with `c.changes` and `c.now` | `connect((value, c) => …)`, with `c.diff` | 2.1 |
| a weak `connect(target, fn)`, `scope`, `closes`, `close()` | `connect(fn, { signal, until })`, `disconnect()` | 2.2 |
| `asOf(pos)`, with `step`, `seek` and `close` | `past(pos, { to })`, a value | 2.1, 2.3 |
| `changes({ from, until: 'latest' })` | `changes({ from, to })` | 2.3 |
| a write to a room, refused | `room.set(rows)`, `room.remove()` | 2.5 |
| `f.methods.x(arg)` | `f.data.x(arg)` | 2.6 |
| a method that returns a view, `here()`'d | `{ view }`, an address | 2.6 |
| `f.snapshot` | `h.value[k]` through a `connect()` handle, or a spread you write | question 1; 2.10 |
| `f.rows` | `f.data.connect()`'s `h.value[k]`, on any role | 2.10 |
| `f.cluster.snapshot()`, `f.cluster.writes.snapshot()` | `f.cluster.value`, `f.cluster.writes.value` | 2.10 |
| `f.cluster.tap(fn)`, `f.cluster.writes.tap(fn)` | `connect((shape) => …)`, with `disconnect` | 2.10 |
| `ctx.rows` | `await ctx.at.get()`; at the root, `await ctx.data[k].get()` | 2.10 |

## 4. What every call costs, on one card

| Call | Trips | Commits | Whole-resource work, or the cost |
|---|---|---|---|
| a step, `f.data.a.b` or `f.at(a, b)` | 0 | 0 | none; nothing kept |
| `h.value`, `h.value.k`, `f.cluster.value` | 0 | 0 | none: one lookup |
| `lens.get()`: held on purpose / not | 0 / 1, each time | 0 | none; nothing kept |
| `lens.get({ when })` | as `connect()` while it waits | 0 | the partition, until the test passes |
| a write: `lens.set`, `f.set(path, v)`, an assignment, `lens.remove` | 1 | 1, shared | none |
| a field write with `if: { equals }` | 1 | 1 | the old value in the request; **not priced** |
| `room.set(rows)`, `room.remove()` | 1 | 1 | one log entry, one tombstone per removed row; **a size rule is owed**, past it `room-too-large` |
| a marked write, `{ from: e }` | 1 | a share of 1 | a 29 B mark; never refused `backpressure`; at or below its mark, answered `skipped` |
| N writes made together | 1 frame per leader | shared | at most 512 waiting, or 64 MB; then `backpressure` |
| a method on a path | 1, to its leader | 1 or more | none |
| a root action, `f.data.x(arg)` | 1, +1 per write its server does not lead | 1 or more | none |
| `lens.connect()` on a partition | 1 SUB, shared | 0 | the partition once, then its changes |
| another `connect()` on a held selection | 0 | 0 | a second handle, 163 to 169 ns; the lookup and count inside it, 39 to 45 ns (E-55 claim 6, for V5-12's `here()`) |
| `connect(fn)` / a loop over `connect()` | 0 | 0 | 161 to 189 ns a commit / +166 to +241 ns over a callback |
| a field link under data's rule | 0 | 0 | +6.7 to +11.2 ns a link a commit at 100 links |
| **a link nobody ended** | 0 | 0 | **its changes go on crossing and folding until the process stops** |
| a lens inside a big partition | as `connect()` | 0 | **the whole partition** (first build) |
| operators right of `connect()` | 0 | 0 | a filter about 1 µs a change; `by().sum()` 0.66 to 1.84 µs at 10^6 rows |
| `lookup(other, field)` | 1 per new key named | 0 | 2.9 to 3.9 µs a left change |
| a served view, `f.data.best(10).connect()` | 1 SUB | 0 | **its work on its copy, on every write to the resource**; counted against the cap. Over several groups, the same on each group's partial, and one more hop to the merger: 20 µs p50 on one box |
| a fold, `f.data.tiers().connect()` | 1 SUB | 0 | **on a copy of each group, on every write to that group**: 0.73 to 4.47 µs for `sum`, `count` and `distinct`, 5.7 to 19.6 µs for `max` and `top`; buckets about 1.6e5 at 16 groups |
| `{ pages }`: `page(after)` | 1 to each group, in one round | 0 | 10 to 16 µs on the copy; at 256 groups, 1.2 to 2.6 ms a page; **each index costs every write while it lives** |
| `lens.changes({ from })` | 1 to open | 0 | every kept record on the path |
| `changes({ from: -5 })` | 1 to open | 0 | the server counts back; **not priced on a real log** |
| `lens.past(pos)` | 1 log read | 0 | a snapshot load, then 3.6 to 4.4 µs a record, folded here once |
| `f.data.scan()`, or `scan({ cut: false })` | 1 a page a group, two pages a group in flight | 0 | **every row once, kept nowhere**: about 0.8 M whole rows a second; this process's memory flat. At one cut, every copy keeps a 127 B before-image of each pinned row that changes, until the scan passes it |
| `derive(view, target)` | 1 SUB to the source | 0.748 target writes per source commit | the view, on the deriver |
| `derive(source, target, fn)` | 1 delivery a record | a share of 1 per output partition | a 29 B mark; with `{ rows: true }`, one fold a record |
| opening a client, by default | 2 to 3 | 1 | none: it holds nothing |
| `hold: 'all'`, or `f.data.connect()` | 1 SUB (none for `f.data.connect()` on a server that holds every group, or with `hold: 'all'`: it shares) | 0 | **the whole resource, once; then every write to it**, under this process's `memory`: about 1.4 M small rows a GB; refused at open past it, ended `not-held` if it grows past it |
| an operator over every row on a server that lacks some groups | 1 SUB per `connect()` | 0 | **the groups it lacks**: once, then every write while the link lives, under `memory`. A one-time `get()` takes none; how it answers is owed. Not measured |
| opening with a server role | | | **the whole log, a disk, a vote** |
| a lock kept, or a consumer's share | | 3 a lease, renewed every third of it; 1 more to release a lock | the times are owed (V5-17) |
| a `service` ask | | 3; 2 more for each try after a throw | |
| listing a partition's or a whole resource's `value` | 0 | 0 | **every held row** |

A write's own path is 2 trips and 1 disk sync, the least any correct design can do (PATHS 0). API.md section 4 has the full card, with `once`, sagas and queues, and the sources. **Five costs do not show in the line, so learn them**: `hold: 'all'` (an option, not a line of code), a lens inside a partition (it holds the whole partition), a served view, a fold or a `{ pages }` index (its servers pay on every write), a link nobody ended, and an operator over every row on a server that lacks some groups (its `connect()` takes what the server lacks first, under `memory`; the deployment, not the line, says which groups a server holds).

## 5. Explained badly before, and the same now

These did not change. They only get a plainer sentence.

1. **Assignment and `set`.** "Assignment is `set` without the answer." Only on untyped handles; typed code writes with `set`.
2. **Roles.** "A process that brings something serves. A process that only names the resource is a client."
3. **The options.** Ask of each: who remembers it? This process (`linger.ms`, `memory`), the resource (`depth`, `views`, `history`), or this open (`hold`, `server`).
4. **A commit and a stage.** Every write commits the same way: on disk at a majority. A stage is only how far your own write has got when you hear back.
5. **Versions and cursors.** A version names a record, and so the commit that holds it, inside one partition. A cursor is a bookmark anywhere. Both are text you pass back.
6. **"A check-then-set must carry a condition or be an op."** Or be `set(fn)`. One leader judges every write on the newest state, so your read is a copy that can be old.
7. **`batch`.** Not "for speed". It means "all or none", inside one partition. A room write is the same kind of thing for a whole room.
8. **`connect` and `changes`.** Live state, or the log. `connect()` keeps the newest state here, and a slow reader skips ahead. `changes()` hands you every record, in order, and a slow reader waits.

## 6. Questions for you

API.md 11.1 numbers the questions 1 to 41, and this tour keeps its numbers: 1 to 14 are the first tour's, 15 to 24 came with the 2026-11-18 page, 25 to 33 were API.md's picks where V5-13 to V5-15 leave room, 34 to 40 are meanings the declarations left out, found by the patterns walk-through ([PATTERNS.md](PATTERNS.md)), and 41 is new with V5-17. **You answered them one at a time on 2026-11-21 (V5-17), questions 4 and 41 the same day (V5-19), and question 28 on 2026-11-23 (V5-20), so none of the 41 is open now.** Q-B1 and Q-B3 are the first tour's 15 and 16.

### 6.1 Decided

- **1.** `f.rows` and `f.snapshot`: decided, V5-13 pick 6 (`f.snapshot` goes) and V5-16 (`f.rows` goes too; every row is read through a `connect()` handle).
- **2.** Verbs on the resource or on `data`: decided, V5-12 (the path write; `f.set(path, v)` as the array form).
- **3.** `near` on a method: decided, V5-12 picks 3 and 13 (a method on a path runs at its leader and declares `at:`).
- **5.** `changes`, `log` or `read`: closed by V5-13 pick 1 (`changes()` is the log verb).
- **8.** A client's default `hold`: decided, V5-12 pick 1 (nothing, until a `connect()` says what).
- **9.** A `get` that misses: decided, V5-12 and V5-13 pick 1 (it reads once; `get({ when })` holds only while it waits).
- **10.** No writes on a door client's types: decided, V5-12.
- **12.** No early stages with a `once` name: decided, V5-11 ruling 6 (a mark and a room write have none either).
- **13.** The partition function: decided, V5-12 pick 4 (in the API, built later).
- **15.** `f.rows` on a client: decided, V5-16 (gone on every role; no `f.value`), where V5-13 pick 6 had kept it on a server and with `hold: 'all'`.
- **16, its served-view half.** The caps: decided, V5-14 pick 2 (64 per copy, weighted by cost, with headroom). The other keys: V5-17, below.
- **19.** `changes()` below a partition: decided, V5-15 pick 2 (the records on the lens's path).
- **21.** Several marked outputs of one record: settled by TRANSFORMS 3.4 (E-57 B5), approved in general with V5-14; it is not one of V5-14's eight numbered picks (the mark carries the write's number). The model with marks from app code, owed then, is done: E-61 (V5-20 items 16 to 19; 2.14).
- **Q-B8.** Who runs a `derive`: decided, V5-12 (the app's choice; `derive()` splits the shares).

**Decided by V5-17, as API.md picked.** API.md now cites V5-17 for each.
- **6.** A write when the client is full: a verb's handle rejects `backpressure`, and an assignment throws it; a marked write waits.
- **7.** Opening a name as a server creates the resource, as in v4.
- **11.** `{ retry: true }` stays, beside `once`.
- **14.** Every small name stays, except the open-links list (26).
- **16, the other half.** `linger.ms` 1000, `views.client` 16 and `views.rows` 1,000 stay as defaults, marked as guesses, until measured.
- **17.** A write at the root, or to a room any way but `room.set` and `room.remove()`, is refused `bad-path`.
- **18.** `get` is a verb on a lens only; `f.remove(path)` and `f.touch(path)` stay as array forms; the `follow` claim is renamed `read`; `ctx.use(other)` stays.
- **20.** A marked write takes no `once` name.
- **23.** Behind the door a client has no bare mark and no claim; `touch` is a row's verb.
- **24.** `consumer().run()` restarts from each share's cursor and sends no bare marks; a mark counts under its reader's name, else the target's.
- **25.** A log entry below a row carries the lens's value right after the record, in `e.value`.
- **27.** Any server marker types a server; a handle opened with none is a client.
- **29.** fero follows `moved` itself; `stale-client` reaches the app.
- **30.** A remove that finds nothing answers as done.
- **31.** `f.cluster.connect` and `f.cluster.writes.connect` follow a lens's link rules.
- **32.** When a group's only copy is its leader, the leader serves its views until a second copy is ready, and health says so.
- **34.** A lock renews itself every third of its lease; `renew: false` leaves it to `l.renew()`.
- **35.** A refused saga rejects with the refused step's own error, once the undo has committed; a retry under the same `once` name gets the same refusal.
- **36.** A saga may span resources.
- **37.** `consumer()`: 16 shares, fixed for the group's life; a 10 s lease, renewed every third of it; 100 entries a batch; `from: 'earliest'`; `lag` counts records.
- **39.** A library opens, ends and lists the live links it needs itself.
- **40.** Leases renew every third of their lease; the cost rows are in API.md section 4, and their times are owed.

**Decided by V5-17, the other way.** Each changes the API (2.12).
- **22.** `past` is in the first build, with `get`, `connect` and `changes`.
- **26.** The open-links list is `f.cluster.value.links`.
- **33.** `field-ttl` and `room-too-large`, codes of their own.
- **38.** When a service's answer function throws, the request goes back to be taken again, as a queue job does, until the asker's timeout runs out; the asker then gets `timeout`.

**Decided by V5-19**, the same day.
- **4.** `lens.set(fn)` stays, by that name. On a field lens it is guarded by the field (V5-15 pick 5). The give-up after 8 tries is a guess (Q-B6).
- **41.** A service request is taken at most `deliveries` times, 5 by default, as a queue job is; after the last throw the ask rejects `threw` with the last message. `deliveries` is a setting of the service's resource: the founding open stores it, and another value is refused `config-differs`. An ask whose timeout runs out first gets `timeout`.
- **Also:** `f.cluster.value.me.links` is renamed `me.peers` (the members this process is connected to), so `links` names only the open links.

**Decided by V5-20**, on 2026-11-23, after GROUPS.md, MERGE.md and EVERYROW.md (2.13).
- **28.** Operators on a server's root. **One-time root code and a handler's loops over every row read with `scan()`**, on every server, a spare too, with no download. **Live work over every row that merges is a served view, merged across groups, and live code that is a fold is a `{ fold }`.** **Only a sync read of every row and live code that is not a fold** (`f.data.connect()`, an operator over every row at a server's root, with `hold: 'all'` or in `ctx.data`) take what the server lacks first, as `hold: 'all'` does, bounded by this process's `memory`, and never refused for being a spare (V5-20 items 1, 3, 4 and 5). So the types keep operators at a server's root, with `hold: 'all'` and in `ctx.data`; a partition lens stays plain data left of `connect()` everywhere. **At `depth: 2` the types still give the root no operators**, since a name there is a room (API.md's reading; V5-20 does not touch it): a server declares a view or a fold, and code over every row reads `f.data.connect()`'s value or a scan. What a one-time `get()` of a root operator answers where the rows are not held, a scan or a refusal that names `scan()`, is owed (6.3).
- **The rest of V5-20, and V5-21 and V5-22**, answer no numbered question here; 2.13 and 2.14 walk through them, each with its item.
- **Taken as the studies' picks, unless you say otherwise** (V5-20): a refused marked write that nobody awaits is printed once and the loop goes on; run()'s cursor keeps its fence and moves only up; a reader reads its marks again before it stops `expired`; the two rules for app code go in the docs, with a dev check later; and E-60's count for the `view` selector, +7 (2 to 9), goes in LAYERS 4.3.

### 6.2 Still open

None of API.md's 41 numbered questions is open: V5-20 closed the last, question 28 (6.1). What stays open are gaps of the design, from API.md 11.2. Each has API.md's pick. **Say yes to any, and both pages mark it closed.**

- **Q-B1 (the first tour's 15). An early answer, then a refusal not about the row.** **Pick:** through a closed write gate or a full disk fero keeps retrying; a revoked token ends `forbidden`. **Decides:** E-48's model with a gate and a revoke.
- **Q-B3 (the first tour's 16). Who serves fero's own resources.** **Pick:** any process that serves a resource serves the system ones too. **Decides:** LAYERS section 10 item 5.
- **Q-B10 and Q-B11 (new).** A stale or missing method table, in a rolling deploy or before any server answered, must never refuse a valid call; **decides:** a sim with servers on two table versions. A data upgrade under live served views and derivers: entries and the deriver's lock row carry the data build *(reasoned)*; **decides:** a rolling deploy with the build in the key.

API.md 11.2 lists six more gaps of the design (Q-B2, Q-B4 to Q-B7, Q-B9). None changes a call.

### 6.3 Still owed, by decision

**Nothing here changes a line of the API unless it fails.**
- **V5-13:** the cost of `c.version` and `c.cursor` (bar: 50 ns a commit); counting back for `-N` on a real log, a cold partition beside a hot one included; `past` as a value in a real build; the `ended` guard in a real build; the per-row version store that `if: { version }`, diff entries and `c.version` rest on, as a column by slot of data's store, read by key, never a field of the row handed out and never a separate `Map` (V5-21 item 1; COMPACT 5 fix 3), and timed (CONNECT 3.6; a separate `Map` cost +10.5 to +276 ns a write, E-56 positions) *(measured)*. From CONNECT 9: whether the dev warning fires in a browser, and whether React needs `useSyncExternalStore`.
- **V5-13 pick 7:** a folded resume, `connect({ resume })`, in E-31's model with a client-held base. **Done by E-60**: it keeps every property; V5-20 item 21 offers it later, when restarted screens matter, with the per-row versions owed above.
- **V5-14:** the `view` selector in [E-31](experiments/E31-subscribe/README.md)'s model, **done by E-60**: every property holds but the old END wording, now restated (V5-20 item 20); paging across a failover; a data upgrade under live views (Q-B11). And the guessed defaults: `views.client`, `views.max`, `views.rows`, the ring of 64 frames and the row guards.
- **V5-15:** the cost of an `equals` guard at the leader, and its size on the wire; a size rule for room writes; a build of the record form with rows; the "on the path" reader for the log below a row; a field's `-N`, read from the row's log back.
- **V5-16:** how often `lag` makes a new cluster shape (at every commit, a screen would redraw per commit); what replaces v4's `peers` (`me.peers`, V5-19, lists only members; v4's also counted clients), `me.uuid`, `me.hosts` and `me.origin`; the `ended` guard on `f.cluster.value`; the promise's cost on a real `get()`; what an operator over every row costs on a server that lacks some groups, which first takes what it lacks, under its `memory`.
- **From V5-12:** the 22 patterns end to end on the new spelling (E-55 claim 25); a served view with its cap on the prototype (claim 27); E-30's model with marks written by app code, **done by E-61** (V5-20 items 16 to 19); the pacing rule in a real client; a GET that carries the highest position seen, against copies that lag.
- **V5-17:** the times of the lock, consumer and service cost rows; the merger study before question 28 (V5-18), **done**: MERGE.md and EVERYROW.md, and V5-20 closed question 28; `past` built in the first build.
- **V5-20 to V5-22:** the scan's image budget, its lease and `scan-lost`; how a one-time `get()` over every row answers where those rows are not held, over a scan or refused with a hint that names `scan()` (V5-20 item 4); what a scan does with a partition its reader may not read; the merger audit for folds; the sorted column at the merger, with a part per group, a resync, a slot move and a loud remove; what a fold does past its stated bucket limit; the guard by RSS in a seeded run, and which hold ends first when several share it; the merger on real sockets, with data's views as the partials; the move window timed, which chooses between waiting and the two fallbacks (V5-22 item 5); a partial whose max and distinct keep an index; the standby merger study, which would close the gap through a rebuild; the exit rules of a clean stop under partitions and stale messages; a dev check for the two rules of code that writes marks; a `memory` default; and a quiet machine for P-01 (V5-20 item 15).
- **data 5.0.0** (V5-14 pick 6): D1 and D2 first, D1 with a pin (claim 8 sits at its bar), then the merge contract, the operators, D3, D4 and D6 to D9. V5-20 adds chunked ordered views and quantiles, and lifting the cap of 16,777,216 rows a source; V5-21 adds the key index in small tables, operators that keep keys and the values they project, and later a compact backing that covers holds and servers' own rows (2.8).

## 7. Stated from reasoning; say if any is wrong

No experiment ran these. API.md marks each one.
- **When `await fero(name)` comes back.** A client, by default: once it has reached a server and learned the leaders. With `hold: 'all'`: once the first picture of every row is folded; a resource that will not fit this process's `memory` is refused at the open, `not-held` (decided, V5-20 item 3). With no server up: after `connect.wait`; then a handle's `value` throws `not-ready` until its picture comes, and `f.cluster.value.members` reads `undefined` (v4 printed `{}`).
- **"Now", for `changes()`, is the call**, not the first turn of the loop (Q-B7).
- **A size is a cache of pictures**, not subscribed, never read from.
- **A version from another slot can give a quiet wrong answer** (CONNECT 3.2), and a whole-resource cursor is 4 to 13 KB.
- **A method declared `at: 'any'`** runs at the partition's leader inside one partition, and on any server at the root.
- **A spare server**, one that holds no group of the resource, holds no copy until healing places one on it, and answers a served view's SUB `moved`, naming a server that holds it. On a server that lacks some groups, a spare among them, a `connect()` of an operator over every row first takes what it lacks, as `hold: 'all'` does, under this process's `memory` (API 3.3, reading TRANSFORMS R0, now bounded by `memory`; V5-20 item 3).
- **Around `scan()`** (API 3.13): `rules.read` runs once per partition the scan reads, and `f.cluster.value.links` lists a running scan with kind `'scan'`.
- **Around folds** (API 3.10): a fold counts against `views.max` and `views.client` as a served view does, and `views.rows` does not apply to it; its own bucket limit, stated and not enforced, takes that place.
- **Around marks** (API 3.11 and 6): who joins the slots in the four lines (`marks()` joins a home slot under the reader name, and a marked write joins its slot before its first write there); and a skipped write's row in `f.cluster.writes` reads `committed` with `skipped: true`.

**Follow-ups this pass leaves for other files.**
- **[LAYERS.md](LAYERS.md)** was updated for V5-13 to V5-16 the same day. It carries V5-17's answers to questions 25 to 33 in its section 10 item 46, and counts `past` in the first build; 34 to 41 are not in it. V5-20 to V5-22 change it in the same rewrite as API.md, in the sections their consequences name; its 0.2 counts their rules (2.11).
- **CONNECT.md, LENS.md and READS.md** still offer `f.rows` as a current read, from before V5-16. API.md and this tour cite them as evidence, not as the surface.
- **The V5-16 record in DECISIONS.md** must carry what these pages cite V5-16 for: the stand-in promise cost (50 to 90 ns) and the counts of v4 example lines (46 lines in 33 files read the cluster; 23 of them a field v5 lacks).
- **The examples ladder.** `f.snapshot` is gone, so 89 lines in 52 example files change (READS 9). Rungs 03, 04, 08, 10, 12, 13, 16 and 17 change their lesson, and so does every rung whose client reads rows, since a bare client now holds nothing (about 20 READMEs; API 5.1). And 46 lines in 33 files read the cluster with `snapshot()` or `tap`; 23 of them also read a field v5's shape lacks (API 5.1).
- **Owed tests:** two pins on `h.value.k`, for data's object rows (whether they bind a compact source is open until a compact backing is built: V5-21 does not say); D1's pin.

## 8. How this page is checked

Every `ts` block on this page whose first line is `// file: <name>` is written to a fresh folder beside API.md's own `fero.d.ts` and `env.d.ts`, and type-checked with `tsc` against data's shipped types. API.md's `env.d.ts` gives the stand-ins (`draw`, `ws`, `el`, `req`, `res`, `signal`, `saved`, `keep`). Then, in a copy where each `@ts-expect-error` of this page is a plain comment, each line it marks must fail at its own line, and nothing else may: the strip proof, as on API.md.

```js check
// API-TOUR.md checker: this page's "// file: <name>" blocks, with API.md's own fero.d.ts and env.d.ts, are written to
// a fresh folder and type-checked with tsc against data's shipped types (DATA names data's folder; ../data by
// default). Then, in a copy where each of this page's @ts-expect-error is a plain comment, each line it marks must
// fail, and nothing else may.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const tour = process.argv[1]
const data = resolve(process.env.DATA ?? '../data')
// a block may sit indented inside a list item: its own indent is taken off every line
const blocks = (file) => [...readFileSync(file, 'utf8').matchAll(/^( *)```ts\n\1(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)^\1```/gm)]
  .map(([, pad, body, name]) => [name, body.replace(new RegExp('^' + pad, 'gm'), '')])
const base = blocks(join(dirname(tour), 'API.md')).filter(([name]) => name === 'fero.d.ts' || name === 'env.d.ts')
const own = blocks(tour)
const root = mkdtempSync(join(tmpdir(), 'fero-tour-'))
const compilerOptions = { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true,
  types: [], lib: ['es2022', 'dom'], paths: { fero: ['./fero.d.ts'], data: [join(data, 'types/public.d.ts')] } }
const put = (dir, strip) => {
  const marked = []
  mkdirSync(dir)
  for (const [name, body] of base) writeFileSync(join(dir, name), body)
  for (const [name, body] of own) {
    const lines = body.split('\n')
    if (strip) lines.forEach((l, i) => {
      if (l.includes('// @ts-expect-error')) { marked.push(`${name}:${i + 2}`); lines[i] = l.replace('@ts-expect-error', '(must fail below)') }
    })
    writeFileSync(join(dir, name), lines.join('\n'))
  }
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: [...base, ...own].map(([name]) => name) }))
  return marked
}
put(join(root, 'page'), false)
console.log(`${own.length} blocks of this page → ${join(root, 'page')}`)
execFileSync('tsc', ['-p', join(root, 'page', 'tsconfig.json')], { stdio: 'inherit' })
console.log(`ok: ${own.length} blocks type-check (tsc ${execFileSync('tsc', ['-v']).toString().trim()})`)
const marked = put(join(root, 'stripped'), true)
let out = ''
try { execFileSync('tsc', ['-p', join(root, 'stripped', 'tsconfig.json')], { encoding: 'utf8' }) } catch (e) { out = e.stdout }
const errors = out.split('\n').filter((l) => /^\S+\(\d+,\d+\): error/.test(l))
const at = errors.map((l) => l.replace(/^(\S+?)\((\d+),\d+\).*$/, (_, f, n) => `${f.split('/').pop()}:${n}`))
for (const l of errors) console.log('  ' + l.split('/').pop().slice(0, 150))
const missed = marked.filter((m) => !at.includes(m)), stray = at.filter((a) => !marked.includes(a))
console.log(`stripped → ${join(root, 'stripped')}: ${marked.length} marked lines, ${marked.length - missed.length} fail at their own line, ${stray.length} errors elsewhere`)
if (!marked.length || missed.length || stray.length) { console.log({ missed, stray }); process.exit(1) }
```

Run from the repo root, with tsc on `PATH` (`DATA` names data's folder; the default is `../data`, next to this repo):

```sh
node --input-type=module -e "$(awk '/^```js check$/{f=1;next} /^```$/{f=0} f' docs/v5-space/API-TOUR.md)" docs/v5-space/API-TOUR.md
```

**Result, run here on 2026-11-23, after the V5-20 to V5-22 amendment** (Node v22.23.5, TypeScript 6.0.2, data at 63fea66, against API.md's declarations of the same day): `ok: 14 blocks type-check (tsc Version 6.0.2)`, then `27 marked lines, 27 fail at their own line, 0 errors elsewhere`. The amendment added the blocks `everyrow.ts` and `marks.ts` and four lines. The 2026-11-21 run, after the V5-17 amendment, gave 12 blocks and 23 lines.
- **Where the 27 are:** four in `everyrow.ts`; three each in `verbs.ts`, `ends.ts`, `positions.ts`, `writes.ts`, `methods.ts` and `views.ts`; two each in `address.ts` and `sync.ts`; and one in `derive.ts`. Each fails for the reason its comment gives: `scan()` on a row (TS2339: a row lens has no `scan`); a fold given an argument (TS2554); a fold whose combine the author wrote (TS2322: not a `Combine`); a method named `scan` (TS2322 on the method, with the text that names it a fero word); `connect({ once })` and `{ from }` on `connect` against the options whose text names `get()` and `changes()` (TS2769, TS2322); an awaited handle is not a row (TS2739); `until` with a DOM node or an HTTP request is not `Closes` (TS2322); `tap`, a root `set`, a function or a root operator left of `connect()` are not callable (TS2349); a version or `-5` on the root, and a bare number as a time, against `Pos` and its "a time is a Date" text (TS2322); `ttl` on a field (TS2769); a room set to one row (TS2322); `f.methods` (TS2339); an awaited served view (TS2740); a method named `connect` and an unbounded view, on the method (TS2322); `derive` of `group` (TS2345); `await stock` and `stok`, as before; `f.rows` and the cluster's `snapshot()`, gone (TS2339).
- **Two fail for a reason the types cannot say in words**: a root `set` and a function left of `connect()` fail with "This expression is not callable", as in API.md (its section 12).
- **Not checked here: that any of it runs.** Nothing on this page is built.
