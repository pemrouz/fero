# fero v5's API: a tour for review

Written 2026-11-16 for the owner, rewritten 2026-11-18 for the connect lens (V5-12), and **rewritten again 2026-11-20 for V5-13 to V5-15** ([DECISIONS.md](../DECISIONS.md)), then amended the same day for V5-16 (sync reads). **Amended 2026-11-21 for V5-17**: your answers to API.md's open questions. Four went against API.md's pick and change the API (2.12). It walks through [API.md](API.md), which was rewritten the same day for those decisions. Read this first. API.md is the full reference; [CONNECT.md](CONNECT.md), [TRANSFORMS.md](TRANSFORMS.md) and [ANYPATH.md](ANYPATH.md) hold the evidence.

**What you asked, since the last tour.**
- **Reads.** You found the mix of `here`, `tap`, `connect` and `changes` unclear, and asked why a root method was `f.methods.x` while a method on a path was `f.data.k.x`. You then proposed one `connect` with options: the state and the diff on each call, `disconnect()` with a lifetime option beside it, a start at a commit id or a few commits back, a read once by awaiting, and `for await`. You also asked what a commit id looks like, and whether Merkle trees help (V5-13).
- **Transformations.** They made earlier versions hard, so you asked for a plan worked out and checked in full, and whether data needs a new version for it (V5-14).
- **Sync reads.** After `f.snapshot` went, you asked whether the other snapshot reads could go as well: a sync `.value` read only where it is safe beyond doubt, and `get()` or `connect()` elsewhere (V5-16).
- **Paths.** You asked whether v5 keeps what data and earlier fero had: a write at any level of a resource, and every reader of any part seeing that part right. When the first answer stopped the log at the row, you asked whether a field could keep a log of its own, as every other lens does (V5-15).
- **Your answers.** You answered API.md's open questions one at a time (V5-17), and left question 28 open until the move from one group per resource to many is studied. It now waits for MERGE.md, a study of how work over every row is merged across groups (V5-18).

**How this pass was made.**
- READS.md proposed five read verbs, one job each. CONNECT.md then weighed three designs against your one `connect`, with two judges and a review of 21 findings. It rests on [E-56](experiments/E56-one-connect/README.md), which built `connect` on E-55's prototype and measured commit ids, hash chains and Merkle trees.
- TRANSFORMS.md started from a history of 70 sources of complexity in fero v2 to v4 and in data. It built every piece small on data's real engine ([E-57](experiments/E57-transforms/README.md): each claim against a seeded oracle with planted bugs) and took a review of 30 findings.
- ANYPATH.md checked writes and readers at every level with [E-58](experiments/E58-any-path/README.md), a seeded oracle on data's real engine, and took a review of 19 findings.
- You approved V5-13 and V5-14 in general, and V5-15 with its pick 2 changed to "on the path". API.md was rewritten for all three, and this tour follows API.md.

**What is sure.**
- Every code block in API.md compiles with TypeScript 6.0.2 against data's shipped types: 42 blocks. Each of its 147 lines that must not compile fails at its own line (API 12, run 2026-11-21).
- Every `ts` block in this tour compiles against API.md's own declarations, and each of its 23 lines that must not compile fails at its own line (section 8, run 2026-11-21).
- Built small, on data at commit 63fea66: the lens ([E-55](experiments/E55-lens-prototype/README.md)); `connect` with its ends and the `ended` guard (E-56); served views, pages, `derive`'s view form, `lookup` and the store fed by slot (E-57: 0 wrong answers on the final code); writes and readers at every level (E-58: 0 wrong states). None of them built fero's log reader (E-58 checked an "on the path" reader on its stand-in), the positions or `past` as a value.
- Nothing of fero v5 is built. The 22 patterns compile in the new spelling; none ran.
- **API.md's third rewrite and this tour had two reviews the same day**, one against the decisions and one of the mechanics, and each finding that held is applied. The V5-16 amendment had a skeptic and then two reviews of its own, one for consistency and one of the mechanics; each finding that held is applied too. CONNECT.md, TRANSFORMS.md and ANYPATH.md each had a skeptic before, and each finding that held is applied there.

**How numbers are marked**, as in API.md. **E-nn** is an experiment; **E-55 claim n**, **E-56 probe n**, **E-57 A1, XA-n, B1, XB-n** and **E-58 part n** are parts of one. Their costs are the lens's and data's share in one process, never a whole fero write. **CONNECT n**, **TRANSFORMS n**, **ANYPATH n**, **READS n**, **LENS n**, **PATHS n** and **V5-n** are sections of those pages and the decisions. **(measured)**: timed, the range over three runs. **(checked)**: a seeded run, a model or tsc ran it. **(reasoned)**: an argument; nothing ran it. **(a guess)**: a number nobody measured. **(from memory)**: an outside fact not checked here. A number with no mark is cited from a page that marks it.

**Words.** Each is said again where it first matters.
- A **resource** is a named, shared map of rows. A **partition** is the rows one **leader** (one server) keeps in one order. The first key of a path is always the partition. At `depth: 2` a partition is a **room** of rows.
- A **commit** is the moment a write is on disk on most of the **copies**, the servers that hold the resource. Only then can anyone see it (V5-5).
- A **lens** is an address inside a resource, such as `shop.data.widgets.stock`. It holds no data and does no work. A **verb** is a call on a lens.
- A **link** is one live connection from a lens into this process. Its **picture** is the rows it selects, at the moment it starts. Rows are **held on purpose** when this process serves the resource, said `hold: 'all'`, or has a live link on them. Only those serve a read here.
- **Live state** is the newest rows, folded: a slow reader skips to the newest. **The log** is every record, in order: it waits for a slow reader.
- A **version** is a record's place in its partition's log, as short text such as `38S9`. A **cursor** is a reader's place, across partitions: text you save and give back.
- Seen from a lens on `w.stock`, a write to `w` is **above** it, to `w.stock` **at** it, to `w.stock.x` **below** it, and to `w.price` **beside** it. A record **on the path** is at, below or above.
- A **served view** is a live answer over every row that the server names in `methods:` and keeps on one copy for every client that asks.
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
const sold = await shop.data.widgets.sell(1)                       // a method on a path: runs at widgets' leader
const low = shop.data.low(5).connect()                             // a view the server named: an address, then a link
await row.ready
console.log(n, row.value?.stock, was.value?.stock, sold, await shop.data.ping())   // a root method sits on f.data
row.disconnect(); shown.disconnect(); low.disconnect()             // every link ends by your code
```

**One address, and one sync read** (V5-13 pick 6; V5-16). `f.data` is the address of everything: steps, reads, links, writes, and every method call, the root's too. `.value` is the one sync read, and only where it is sure: a live handle (`h.value`), a `past`, and `f.cluster`, this process's own state. Every row, read in sync, is `f.data.connect()`'s `h.value`, on any role.

**Seven rules a user learns** (CONNECT 8.5; V5-13; `pages` in rule 7 is V5-14 pick 4, and "first build" in rule 5 is V5-12 pick 2).
1. **A path is an address.** Building one sends nothing. It is never a promise, and neither is a handle.
2. **`get()` reads a value once. `connect()` keeps the newest state here, and calls you or loops. `changes()` is every record from a place, and it waits for you. `past()` is one partition as it was: a value.**
3. **A version names a record, and so the commit that holds it; a cursor, a time and `-N` name a place. `from` starts at it, `past` reads right after it, `to` stops after it.** A version and `-N` work inside one partition; save the cursor to resume.
4. **Left of `connect()`: plain data, which may run on a server. Right of it: your code, here.**
5. **The wire sends whole partitions** (first build).
6. **Every live thing ends by your code:** `disconnect()`, `break`, a signal, `until`, or the count. Never the collector. A link's rows are read only while it is live; after the end, `ended`. A `past` is a value: nothing to end.
7. **A method says where it may be called (`at:`, `view` or `pages`), never takes a fero word, and checks what it is given.**

Transformations add ten user rules (2.7). Paths follow data's rule (2.4) and one shape rule at the leader (2.5). The types show neither, and no record counts them as user rules. **The first tour's rules still hold**: a sync read never leaves this process and never guesses (since V5-16 it is `.value`: a live handle's, a `past`'s, or `f.cluster`'s), and a change is sent whether you `await` it or not, and shows, to everyone, when it commits.

## 2. The decided changes, first

Each says what it looks like now, what it looked like before (the 2026-11-18 page, unless marked), why, and what it costs. **Rules** are the source pages' counts, all reasoned and none modelled; 2.11 adds them up.

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
  - A folded resume, `connect({ resume })`, would close 2.1's seam. It is not taken now, and is modelled first in E-31's model (V5-13 pick 7).

### 2.4 Any path: every lens reads, a field too (V5-15 picks 1 and 2)

- **Now.**
  - **data's rule is the one rule for the state forms** (`get`, a link's value and its callback, a loop turn, `past(pos).value`): a write at or below the lens gives a change; a write above it counts only when the lens's value changed (a new object counts); a write beside it gives nothing.
  - **Every lens has every read verb**, a field too. The log forms (`changes()`, `-N`, stepping through `past`) take the records **on the lens's path**. A reader below a row takes its part from a record above it (a whole row, or a field that holds the lens), folds a record below it into the value it kept, and gives an entry only when its value changed.
  ```ts
  // file: anypath.ts — every lens has every read verb, a field too (V5-15)
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

### 2.6 Methods: root calls on `f.data`, and three kinds (V5-13 pick 6, V5-14 pick 4)

- **Now.** A root method is called on the root lens: `f.data.ping()`. A method comes in three kinds: an **action** (a function, or `{ at, run }` to be called on a path), a **served view** (`{ view }`: an address you `get` or `connect`), and **pages** (`{ pages }`: one sorted list read a page at a time).
  ```ts
  // file: methods.ts — root methods sit on f.data; three kinds of method
  import { fero } from 'fero'
  import type { Shop } from './server.ts'
  const shop = await fero<Shop>('shop')
  const pong = await shop.data.ping()                                     // a root action: called on the root lens
  await shop.data.widgets.sell(1, { once: 'order-981' })                  // an action on a row, at most once
  const low = shop.data.low(5)                                            // a view: an address; nothing is sent yet
  const top = await low.get()                                             // one picture
  const live = low.connect()                                              // or live, kept on one copy
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
  - **A method may not take a fero word where it would be called**: at the root, the read verbs, the operators, `set`, `remove` and the probe names; on a row, the read verbs, `set`, `remove` and `touch`. The types refuse it where it is declared, and the server refuses it at open, `bad-name`.
  - **A client gets the method table at open.** An unknown name is refused here, with no trip: `no-such-method`. `lens.call(name, arg)` stays for a name held in a variable.
- **Before.** `f.methods.x(arg)`. On a lens, fero's names won, and `lens.call` was the way out. A view was a method that returned one, then `here()`'d, and it could be awaited.
- **Why.** You asked why a root method was `f.methods.x` and a path method `f.data.k.x`. Now one rule covers both: a method is called on the lens where it runs, and the root is a lens (READS 4). "fero's names win" hid a method behind a verb without a word. And a library that probes objects by name now fails loudly, where before it could send a call.
- **Cost.** A word fero adds in a later version breaks an app that used it as a method's name, loudly, at its next start. In a rolling deploy a stale or missing table must never refuse a valid call: that is reasoned, and a sim is owed (Q-B10).

### 2.7 Where a transform runs: the line, served views and pages (V5-14 picks 1 to 4 and 7)

- **Now.** **One line, the live verb, decides where a transform runs.** Right of `connect()`, any code runs here, on rows held on purpose. Left of it stands plain data only (`eq`, `in`, `gt`, `az`, `za`, `by`, …), which a copy may run inside one partition later (class B). Over every row a client gets only a view the server names, or `{ pages }`. Across partitions there is no merger.
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
  const top = fans.data.best(10).connect((rows, c) => draw(rows, c.order))   // on one copy; only its changes cross
  const teams = fans.data.byTeam(null).connect()                          // a Map from team to number
  const p1 = await fans.data.ranked(null).page()                          // one page; it holds nothing
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
  - **Placement.** Each served view lives on one copy, chosen by a hash over every copy but the leader. The leader, which takes the writes, never builds one while another copy can serve it. When the leader is the only copy, as with one server process, the leader serves its views until a second copy is ready, and health says so (V5-17).
  - **The cap.** At most 64 served views per copy (`views.max`), each weighted by its cost class: O(1), O(log n) or O(n) a change. A client holds at most 16 per copy (`views.client`). With k ≥ 2 serving copies, `views.max / k` is kept free on each for clients whose copy died; with one, none. Past a cap: `too-many-views`.
  - **The row guards.** Until data 5's ordered index, an ordered view over more than 5,000 rows and `{ pages }` over more than 2,000 are refused when built, `view-too-big` *(the numbers are guesses)*.
  - **A view must be** bounded (a window, one value, or buckets); blind to the caller (a per-user view takes the user as its argument, and `allow` checks it); a function of its argument and the rows (no clock, no random number); and of one resource.
  - **`lookup`** is the one join, right of the line: for each left row, the other resource's row with that key, kept live: `undefined` while loading, `null` when there is none. **Bucket answers are a `Map`** with typed keys: `teams.value.get('red')`.
- **Before.** A served view lived on whichever server took the SUB, under a cap of 1,000 per resource and 16 per client, both guesses. TRANSFORMS' first plan made one served view per page cursor. Dashboards used `group(fn)`, ties broke by arrival, and sums were plain floats. In fero v2 to v4 and in data, transformations were 70 sources of complexity and bugs (TRANSFORMS 2).
- **Why.**
  - **Off the leader, on every other copy.** Serving from standbys first refused a held view in 377 of 1,000 seeds with one standby; with every copy but the leader serving, 5 and 6 of 1,000 (E-57) *(checked)*.
  - **So few.** Every live served view sees every write to its resource. At 50,000 writes a second, one core has about 18 µs a write left for views. A bucket or sum view costs 1.8 to 4.9 µs a change, and a leaderboard 5.7 to 6.7 µs at 1,000 rows and 134 to 155 µs at 100,000 (E-57 A1, pagecost) *(measured)*. Served views are for a few shared answers per resource, not a query per user.
  - **Pages.** One view per cursor cost 0.7 to 8.3 MB a page and was refused by the 17th page. With one shared index, a page read is 10 to 16 µs and 32 B on the copy (E-57 XA-7) *(measured)*.
  - **`by(field)`** costs 0.66 to 1.84 µs a change at 10^6 rows, where `group(fn)` took 78 to 94 ms (E-57 B2) *(measured)*. `lookup`: 537,670 checks, 0 unequal (E-57 B4) *(checked)*.
- **Cost.**
  - Rules: about +26 (21 to 45) on the 416 for the first build (TRANSFORMS 8.3). Users learn ten more rules (TRANSFORMS 8.4; API 3.10).
  - **Three bars are missed, and stated.** A view build over 10^6 rows stalls its copy 0.2 to 1.9 s until data builds in slices (XA-1). A client that held a view can still be refused after failures, in 1 to 21 of 1,000 seeds by configuration (XA-2; TRANSFORMS 3.8; V5-14's consequences quote 5 to 21, its standby and leader-kill runs). The chunked ordered index costs 9.5 to 15.1 µs a write at 10^6 rows, against a guessed 3 (XB-1).
  - **A `{ pages }` index costs every write while it lives**: 8.3 to 9.1 µs at 1,000 rows, 29 to 33 at 10,000, 509 to 525 at 100,000, on today's data (E-57 pagecost) *(measured)*.
  - A new leader hands its views on: 1,796 to 3,271 hand-offs per 1,000 seeds with standbys (E-57) *(checked)*.
  - Owed: the `view` selector in E-31's model, paging across a failover, and a data upgrade under live views.

### 2.8 data's merge contract, and data 5.0.0 (V5-14 pick 6)

- **Now.** **data 5.0.0 is one large major version, in TypeScript.** D1 (path subscriptions through a keyed index) and D2 (the callable lens that keeps nothing) come first. Then the merge contract (C1 to C10), the new operators (N1 to N5: `eq`, `in`, `by` and their kin), D3 (two-level stores), D4 (one sink shape) and D6 to D9, among them the ordered index. No Rust.
  - **The merge contract** makes every view a function of its rows only, not of the order they came in: ties break by row key; one total order per direction; one numeric projection; an exact sum over every finite double; typed bucket keys (`1` and `'1'` are two buckets); and `limit` and `reverse` over unordered rows are marked "arrival" and stay right of the line.
- **Before.** V5-12 pick 9 asked data for D1 to D4, in TypeScript, and kept Rust for L0 and L1. Today's data breaks the contract in many places: with 1 % strings in a number column, deleted rows stayed in a sorted view in 20 of 20 seeds (TRANSFORMS 2) *(checked)*.
- **Why.** You asked whether data needs a new version. It does: two copies, a rebuilt view, a failed-over view and a client must agree as values. Built small in E-57, every check held with 0 unequal, and each planted bug was caught in 159 to 1,000 of 1,000 seeds *(checked)*. No Rust: rows stay JavaScript objects and user functions are JavaScript, and a plain Rust map fold measured no faster (E-54).
- **Cost.** About 33 changes, 20 of them breaking, and about 5,000 to 10,000 lines written or changed against an engine of 7,699 lines *(a guess, against a count; TRANSFORMS 0)*: by lines it may touch as much code as the engine has. data's own users meet the breaking changes too. data's five path-rule holes (E-58) are listed in STATUS for its owner; fero needs none fixed, since its leader refuses those shapes first (V5-15).

### 2.9 `derive` in two forms (V5-14 pick 5, V5-15 pick 4)

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
  - **The record form, `derive(source, target, fn)`**: `fn` runs once per source record and writes with `{ from: e }`, a mark that makes it exact across restarts. It needs the source's `history`. It sees the record, not the row: `e.value` is set only for a whole-row write.
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

### 2.10 One sync read, `.value`, only where it is sure (V5-16)

```ts
// file: sync.ts — the one sync read is a live handle's value; the cluster is this process's own state
import { fero } from 'fero'
type Item = { stock: number }
const shop = await fero<Item>('shop', { server: true })
const all = shop.data.connect()                                    // every row, on any role; on a server, no SUB
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
  - **Every row, read in sync, is `f.data.connect()`'s handle**, on any role. On a server, or with `hold: 'all'`, it shares the rows already held.
  - **`f.cluster` is a live link the open holds for you.** Its value is a new frozen object at each change. `id`, `members` and `groups` read `undefined` until a server answers, never `{}`; after `destroy()`, a read throws `ended`. `connect((shape) => …)` follows a lens's link rules (V5-17). There is no `get()` and no `snapshot()` on it.
  - **A handler reads its row once**: `await ctx.at.get()`, with no trip at the leader; at the root, `await ctx.data[k].get()`.
  - **A lens has no `.value`**: a property on a lens is a step, so `lens.value` is the row or field named `value`.
- **Before.** `f.rows` on a server and with `hold: 'all'` (V5-13 pick 6 kept it); `f.cluster.snapshot()` and `f.cluster.writes.snapshot()`; `ctx.rows`; the cluster's `connect(fn)` with no value.
- **Why.**
  - **On a server, `f.rows` was not sure.** A server past `copies + standbys` (5 by default) is a spare that holds nothing. A sync read cannot wait for a download, so the same line worked on five servers and threw on the sixth: the deployment decided, not the line. A handle is sure everywhere: on a spare it subscribes, and if its link fails, `h.closed` says why.
  - **`get()` and `connect()` can wait.** So on a spare, an operator over every row (its root operators, or a handler's `ctx.data`) first takes every row, the way `hold: 'all'` does, and then runs. The line works on every server; only its cost depends on the deployment (API 3.3; API.md's reading of TRANSFORMS R0, not measured).
  - **A handle costs what `f.rows` did**: one lookup and one trap, plus the `ended` check, one flag whose real cost V5-13 already owes. No pattern reads `f.rows` (0 of 22), and P-01 already reads `client.data.connect()`'s value.
  - **`f.value`, every row with `hold: 'all'`, was weighed and not taken.** It needed a new role in the types and a rule for `hold` on a server, for a read the handle already gives, and it sits one slip from `f.data.value`, a step to a row named `value`.
  - **`.value` on a lens was weighed and not taken.** It would clash with a row or field named `value`, and the same line would read or throw by what other links hold.
  - **The cluster is this process's own state**, kept by a link the open holds, so a sync read of it cannot miss rows elsewhere, and a promise would wait for nothing.
- **Cost.**
  - Rules: about −1 to +1, in L4 (LAYERS 5.4; reasoned).
  - A `get()` on rows held here: the lens's walk, 0.17 to 0.29 µs (E-55 claim 1), plus a promise, about 50 to 90 ns on a stand-in: about 3 to 5 times a handle's lookup. In a hot loop, read `h.value`.
  - v4's examples: 46 lines in 33 files read the cluster with `snapshot()` or `tap`. 23 of them also read a field v5's shape lacks (`peers`, `epoch`, `me.uuid`, `me.hosts`, `me.origin`, `partitions`); what replaces `peers` and the three `me` fields is owed.

### 2.11 What the rules add up to

| Source | Rules on the base's 416 (reasoned; LAYERS 0.2) | User rules |
|---|---|---|
| the read surface: the lens's rows (V5-12, LENS 4.4, +12 to +18), READS 7 (−2 to +7), CONNECT 8.5 (0 to +16) and V5-16 (−1 to +1) | +9 to +42 | seven (section 1) |
| the `past` reader, in the first build since V5-17 (LENS 4.4's `asOf` row) | +3 | |
| transformations, first build (V5-14; TRANSFORMS 8.3) | +21 to +45, about +26 | ten (2.7) |
| paths (V5-15; ANYPATH) | 13 items, not priced: about 0 to +13 *(a guess)* | none counted; data's rule and the shape rule apply (2.4, 2.5) |
| **the first build** | **+33 to +90: 449 to 506**, before V5-15's items | |
| outside it: the `view` selector, modelled | +4 to +6 | |
| later: class B; a folded resume; the browser build | +4 (3 to 6); +2 to +3; +1 | |

- With TRANSFORMS' central +26, the first build is about 454 to 487 (LAYERS 0.2; arithmetic).
- **By V5-6's measure these choices cost rules, and cannot win on rules alone.** The trade: one verb per read job; links that end by code you can see; one text for a position everywhere; views that agree as values on every copy; and every lens reading and writing right at any level.
- **What you no longer have to know:** `here`, `tap`, the weak `connect` and its rule, `scope`, `closes`, `asOf` with its `seek` and `close`, `f.methods`, `f.snapshot`, `c.changes`, `c.now`, "fero's names win", the operator `top`, and since V5-16 `f.rows`, `ctx.rows` and the cluster's `snapshot()`.
- **What stays, said plainly:** `hold` has three values (nothing, `'all'`, a size); a write has three spellings (assignment on an untyped handle, `lens.set(v)`, `f.set(path, v)`); and `connect` has three forms.

### 2.12 Your answers that change the API (V5-17)

- **Now.**
  - **A service's answer that throws is taken again** (question 38). The request goes back, as a queue job does, until the asker's timeout runs out; then the asker gets `timeout`. API.md adds the queue's count: after `deliveries` tries, 5 by default, the ask rejects `threw` with the last message (question 41, still open).
  - **`past` is in the first build** (question 22), beside `get`, `connect` and `changes`, in a reader library.
  - **Two refusals have codes of their own** (question 33): `field-ttl` for a `ttl` or `while` on a field write, and `room-too-large` for a room write past the size rule, which is still owed.
  - **The open-links list is `f.cluster.value.links`** (question 26).
- **Before.** The ask rejected `threw` at the first throw, and no other worker ran the request; `past` came after the first build; the two refusals reused `bad-arg` and `too-large`; the list was `f.cluster.value.open`.
- **Why.** They are your answers (V5-17), each the other way from API.md's pick.
- **Cost.**
  - Each try after a throw costs two more commits, a release and a new claim *(reasoned, from E-22's queue library)*.
  - Rules: the `past` reader's +3 moves into the first build, now 449 to 506 (2.11; LAYERS 0.2).

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
- **A client holds nothing until a `connect()` says what** (V5-12 pick 1). `hold: 'all'` holds every row; a size is a cache of pictures, not subscribed. Why: every download is a line you wrote. Cost: v4's first example and about 20 example READMEs change, and a sync read of every row is `f.data.connect()`'s handle (2.10).
- **A read is served here only from rows held on purpose**, and a GET carries the highest position this process has seen. Why: on E-55's first build a program showed 9.7 patterns of reads served here or by a trip over 1,000 seeds, by when the collector ran; with the rule, 1 (claim 14).
- **A method on a path runs at that path's leader, and declares `at:`** (V5-12 picks 3, 13). The server refuses another path, `bad-path`: on E-55's changed build, 202 of 202 such calls were refused with 0 commits (claim 18). Cost: on a path, one trip and one commit; at the root, 0.66 extra trips a call with three servers. Type a client with `import type`, and check types before bundling: esbuild with `verbatimModuleSyntax` ships the server's code for `import { Shop }` by mistake (E-55 claim 24).
- **`depth: 2`: the first key is the partition** (V5-12 pick 4). Why: a message as a field of its room would lose a row's version, ttl and early stages, and a field write copies its room on every copy, 0.43 ms at 1,000 messages (LENS 1.1). Cost: one-row partitions take 1.3 to 1.5 times the fold until data's D3 (claim 19).
- **The mark is a write option, `{ from: e }`** (V5-12 pick 7). fero paces it: a marked write is never refused `backpressure`, and its reader stops yielding instead. Unpaced, E-55's stand-in lost outputs in 998 of 1,000 seeds; paced, 0 (claim 21). `derive()` and `consumer()` run it once.
- **One handle, three moments** (V5-5, V5-11). `await w` is always the commit, 0.97 ms; `w.received` (the leader has it, 0.15 ms) and `w.replicated` (most copies have it, 0.36 ms) are progress reports for your own write (TypeScript, one box, median; MEMORY 9.3). Only a plain whole-row write has early moments, and the types say so: a field write, a room write, a condition, a `once` name and a mark answer at the commit only.
- **Writes made together leave together.** `await` in a loop is the one slow shape: 16 writes take about 15.5 ms one by one and about 1 ms together (PA-40, computed). Past 512 waiting writes, a plain write's handle rejects `backpressure`, and an assignment throws it.
- **Read, decide, write: three safe forms**: an op, a condition, and `lens.set(fn)`. A plain read then a plain set sold the last item twice in 120 of 120 races ([E-22](experiments/E22-api-prototype/README.md)).
- **A resource is a table, not a row**: about 8 KB per server while idle (V5-8).
- **Errors: one class.** Every failure is a `FeroError` with a `code`, an `outcome` (did it commit?) and a `hint` that names the next call. V5-13 to V5-15 add `ended`, `not-ready`, `aborted`, `bad-shape`, `bad-name`, `bad-arg`, `bad-target`, `bad-position`, `view-too-big`, `redeployed`, `stale-client`, `derived`, `bucket-collision` and `too-many-outputs`, and V5-17 adds `field-ttl` and `room-too-large`; `no-method` is now `no-such-method` (API 8).

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
| a marked write, `{ from: e }` | 1 | a share of 1 | a 29 B mark; never refused `backpressure` |
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
| a served view, `f.data.best(10).connect()` | 1 SUB | 0 | **its work on its copy, on every write to the resource**; counted against the cap |
| `{ pages }`: `page(after)` | 1 | 0 | 10 to 16 µs on the copy; **its index costs every write while it lives** |
| `lens.changes({ from })` | 1 to open | 0 | every kept record on the path |
| `changes({ from: -5 })` | 1 to open | 0 | the server counts back; **not priced on a real log** |
| `lens.past(pos)` | 1 log read | 0 | a snapshot load, then 3.6 to 4.4 µs a record, folded here once |
| `derive(view, target)` | 1 SUB to the source | 0.748 target writes per source commit | the view, on the deriver |
| `derive(source, target, fn)` | 1 delivery a record | a share of 1 per output partition | a 29 B mark; with `{ rows: true }`, one fold a record |
| opening a client, by default | 2 to 3 | 1 | none: it holds nothing |
| `hold: 'all'`, or `f.data.connect()` | 1 SUB (none for `f.data.connect()` on a server or with `hold: 'all'`: it shares) | 0 | **the whole resource, once; then every write to it** |
| an operator over every row on a spare server | 1 SUB per `connect()`; a `get()` takes one picture | 0 | **the whole resource**: once and then every write for a `connect()`, each time for a `get()`; not measured |
| opening with a server role | | | **the whole log, a disk, a vote** |
| a lock kept, or a consumer's share | | 3 a lease, renewed every third of it; 1 more to release a lock | the times are owed (V5-17) |
| a `service` ask | | 3; 2 more for each try after a throw | |
| listing a partition's or a whole resource's `value` | 0 | 0 | **every held row** |

A write's own path is 2 trips and 1 disk sync, the least any correct design can do (PATHS 0). API.md section 4 has the full card, with `once`, sagas and queues, and the sources. **Five costs do not show in the line, so learn them**: `hold: 'all'` (an option, not a line of code), a lens inside a partition (it holds the whole partition), a served view or a `{ pages }` index (its copy pays on every write), a link nobody ended, and an operator over every row on a spare server (it downloads the resource first).

## 5. Explained badly before, and the same now

These did not change. They only get a plainer sentence.

1. **Assignment and `set`.** "Assignment is `set` without the answer." Only on untyped handles; typed code writes with `set`.
2. **Roles.** "A process that brings something serves. A process that only names the resource is a client."
3. **The options.** Ask of each: who remembers it? This process (`linger.ms`), the resource (`depth`, `views`, `history`), or this open (`hold`, `server`).
4. **A commit and a stage.** Every write commits the same way: on disk at a majority. A stage is only how far your own write has got when you hear back.
5. **Versions and cursors.** A version names a record, and so the commit that holds it, inside one partition. A cursor is a bookmark anywhere. Both are text you pass back.
6. **"A check-then-set must carry a condition or be an op."** Or be `set(fn)`. One leader judges every write on the newest state, so your read is a copy that can be old.
7. **`batch`.** Not "for speed". It means "all or none", inside one partition. A room write is the same kind of thing for a whole room.
8. **`connect` and `changes`.** Live state, or the log. `connect()` keeps the newest state here, and a slow reader skips ahead. `changes()` hands you every record, in order, and a slow reader waits.

## 6. Questions for you

API.md 11.1 numbers the questions 1 to 41, and this tour keeps its numbers: 1 to 14 are the first tour's, 15 to 24 came with the 2026-11-18 page, 25 to 33 were API.md's picks where V5-13 to V5-15 leave room, 34 to 40 are meanings the declarations left out, found by the patterns walk-through ([PATTERNS.md](PATTERNS.md)), and 41 is new with V5-17. **You answered them one at a time on 2026-11-21 (V5-17).** Q-B1 and Q-B3 are the first tour's 15 and 16.

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
- **21.** Several marked outputs of one record: settled by TRANSFORMS 3.4 (E-57 B5), approved in general with V5-14; it is not one of V5-14's eight numbered picks (the mark carries the write's number). The model with marks from app code is still owed.
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
- **22.** `past` is in the first build, with the other three read verbs.
- **26.** The open-links list is `f.cluster.value.links`.
- **33.** `field-ttl` and `room-too-large`, codes of their own.
- **38.** When a service's answer function throws, the request goes back to be taken again, as a queue job does, until the asker's timeout runs out; the asker then gets `timeout`.

### 6.2 Still open

Each has API.md's pick. **Say yes to any but 28, and both pages mark it closed.** Question 28 waits for a study first, as you asked, so a yes cannot close it yet.

- **4. `lens.set(fn)`.** **Pick: yes.** It is settled in use, but you have not ruled on it by name, and V5-17 does not name it. On a field lens it is guarded by the field (V5-15 pick 5). The give-up after 8 tries is a guess (Q-B6).
- **28. Operators on a server's root.** **It waits for a study** (V5-17): you pointed out that moving from one group per resource to many may break what it assumes, and asked for a study before building. That audit, [GROUPS.md](GROUPS.md), has reported; the question now waits for the study of how work over every row is merged across groups, and of its alternatives (MERGE.md, in progress) (V5-18). The question as it stands: **Pick:** they run here, functions too, on a server, with `hold: 'all'` and in a handler's `ctx.data`. A partition lens stays plain data left of `connect()` everywhere. **At `depth: 2` the types give the root no operators**, since a name there is a room: a server declares a view instead, and code over every row reads `f.data.connect()`'s value. The other way types a depth-2 root's operators and says how an operator name and a room name share the root. **On a spare server**, which holds no copy yet, the pick is API 3.3's: an operator over every row there first takes every row, as `hold: 'all'` does, so the line works on every server and only its cost depends on the deployment. The other way refuses it `not-held` there, as on a bare client; the line would then work on five servers and throw on the sixth.
- **41 (new with V5-17). How many times a service request is taken.** V5-17's consequences ask the pages to say which rule ends a request that keeps throwing. **Pick (API.md's reading): the queue's.** A request is taken at most `deliveries` times, 5 by default, as in E-22's queue library; after the last throw the ask rejects `threw` with the last message, and no worker takes it again. Each try after a throw costs two more commits *(reasoned)*. The other way: no count, so a request that always throws is taken by every worker in turn until its timeout, and the asker always gets `timeout`.
- **Q-B1 (the first tour's 15). An early answer, then a refusal not about the row.** **Pick:** through a closed write gate or a full disk fero keeps retrying; a revoked token ends `forbidden`. **Decides:** E-48's model with a gate and a revoke.
- **Q-B3 (the first tour's 16). Who serves fero's own resources.** **Pick:** any process that serves a resource serves the system ones too. **Decides:** LAYERS section 10 item 5.
- **Q-B10 and Q-B11 (new).** A stale or missing method table, in a rolling deploy or before any server answered, must never refuse a valid call; **decides:** a sim with servers on two table versions. A data upgrade under live served views and derivers: entries and the deriver's lock row carry the data build *(reasoned)*; **decides:** a rolling deploy with the build in the key.

API.md 11.2 lists six more gaps of the design (Q-B2, Q-B4 to Q-B7, Q-B9). None changes a call.

### 6.3 Still owed, by decision

**Nothing here changes a line of the API unless it fails.**
- **V5-13:** the cost of `c.version` and `c.cursor` (bar: 50 ns a commit); counting back for `-N` on a real log, a cold partition beside a hot one included; `past` as a value in a real build; the `ended` guard in a real build; the per-row version store that `if: { version }`, diff entries and `c.version` rest on, kept inside the row's entry and timed (CONNECT 3.6; +10.5 to +276 ns a write as a separate `Map`, E-56 positions) *(measured)*. From CONNECT 9: whether the dev warning fires in a browser, and whether React needs `useSyncExternalStore`.
- **V5-13 pick 7:** a folded resume, `connect({ resume })`, in E-31's model with a client-held base, before it is offered.
- **V5-14:** the `view` selector in [E-31](experiments/E31-subscribe/README.md)'s model; paging across a failover; a data upgrade under live views (Q-B11). And the guessed defaults: `views.client`, `views.max`, `views.rows`, the ring of 64 frames and the row guards.
- **V5-15:** the cost of an `equals` guard at the leader, and its size on the wire; a size rule for room writes; a build of the record form with rows; the "on the path" reader for the log below a row; a field's `-N`, read from the row's log back.
- **V5-16:** how often `lag` makes a new cluster shape (at every commit, a screen would redraw per commit); what replaces v4's `peers`, `me.uuid`, `me.hosts` and `me.origin`; the `ended` guard on `f.cluster.value`; the promise's cost on a real `get()`; what an operator over every row costs on a spare server, which first downloads the resource.
- **From V5-12:** the 22 patterns end to end on the new spelling (E-55 claim 25); a served view with its cap on the prototype (claim 27); E-30's model with marks written by app code; the pacing rule in a real client; a GET that carries the highest position seen, against copies that lag.
- **V5-17:** the times of the lock, consumer and service cost rows; the merger study (MERGE.md) before question 28 (V5-18); `past` built in the first build.
- **data 5.0.0** (V5-14 pick 6): D1 and D2 first, D1 with a pin (claim 8 sits at its bar), then the merge contract, the operators, D3, D4 and D6 to D9.

## 7. Stated from reasoning; say if any is wrong

No experiment ran these. API.md marks each one.
- **When `await fero(name)` comes back.** A client, by default: once it has reached a server and learned the leaders. With `hold: 'all'`: once the first picture of every row is folded. With no server up: after `connect.wait`; then a handle's `value` throws `not-ready` until its picture comes, and `f.cluster.value.members` reads `undefined` (v4 printed `{}`).
- **"Now", for `changes()`, is the call**, not the first turn of the loop (Q-B7).
- **A size is a cache of pictures**, not subscribed, never read from.
- **A version from another slot can give a quiet wrong answer** (CONNECT 3.2), and a whole-resource cursor is 4 to 13 KB.
- **A method declared `at: 'any'`** runs at the partition's leader inside one partition, and on any server at the root.
- **A spare server**, past `copies + standbys`, holds no copy, and answers a served view's SUB `moved`. An operator over every row there first takes every row, as `hold: 'all'` does (API 3.3, reading TRANSFORMS R0).

**Follow-ups this pass leaves for other files.**
- **[LAYERS.md](LAYERS.md)** was updated for V5-13 to V5-16 the same day. It carries V5-17's answers to questions 25 to 33 in its section 10 item 46, and counts `past` in the first build; 34 to 41 are not in it.
- **CONNECT.md, LENS.md and READS.md** still offer `f.rows` as a current read, from before V5-16. API.md and this tour cite them as evidence, not as the surface.
- **The V5-16 record in DECISIONS.md** must carry what these pages cite V5-16 for: the stand-in promise cost (50 to 90 ns) and the counts of v4 example lines (46 lines in 33 files read the cluster; 23 of them a field v5 lacks).
- **The examples ladder.** `f.snapshot` is gone, so 89 lines in 52 example files change (READS 9). Rungs 03, 04, 08, 10, 12, 13, 16 and 17 change their lesson, and so does every rung whose client reads rows, since a bare client now holds nothing (about 20 READMEs; API 5.1). And 46 lines in 33 files read the cluster with `snapshot()` or `tap`; 23 of them also read a field v5's shape lacks (API 5.1).
- **Owed tests:** two pins on `h.value.k`; D1's pin.

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

**Result, run here on 2026-11-21, after the V5-17 amendment** (Node v22.22.0, TypeScript 6.0.2, data at 63fea66): `ok: 12 blocks type-check (tsc Version 6.0.2)`, then `23 marked lines, 23 fail at their own line, 0 errors elsewhere`.
- **Where the 23 are:** three each in `verbs.ts`, `ends.ts`, `positions.ts`, `writes.ts`, `methods.ts` and `views.ts`, two each in `address.ts` and `sync.ts`, and one in `derive.ts`. Each fails for the reason its comment gives: `connect({ once })` and `{ from }` on `connect` against the options whose text names `get()` and `changes()` (TS2769, TS2322); an awaited handle is not a row (TS2739); `until` with a DOM node or an HTTP request is not `Closes` (TS2322); `tap`, a root `set`, a function or a root operator left of `connect()` are not callable (TS2349); a version or `-5` on the root, and a bare number as a time, against `Pos` and its "a time is a Date" text (TS2322); `ttl` on a field (TS2769); a room set to one row (TS2322); `f.methods` (TS2339); an awaited served view (TS2740); a method named `connect` and an unbounded view, on the method (TS2322); `derive` of `group` (TS2345); `await stock` and `stok`, as before; `f.rows` and the cluster's `snapshot()`, gone (TS2339).
- **Two fail for a reason the types cannot say in words**: a root `set` and a function left of `connect()` fail with "This expression is not callable", as in API.md (its section 12).
- **Not checked here: that any of it runs.** Nothing on this page is built.
