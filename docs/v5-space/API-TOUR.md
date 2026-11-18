# fero v5's API: a tour for review

Written 2026-11-16 for the owner, and **rewritten 2026-11-18 for the connect lens** ([V5-12](../DECISIONS.md)). It walks through [API.md](API.md), which was rewritten the same day around the lens. Read this first. API.md is the full reference, and [LENS.md](LENS.md) holds the evidence.

**What you asked for.** First, an API that is easier to guess, without hurting speed: no hidden copies, trips, decodes or whole-resource work. Then, after reading the first tour, the lens you had explored before data's rewrite: `resource.a.b.c` builds an address; `connect()` pipes the state and then its changes to a target; calls are a space apart from keys; operators before and after the call split server work from local work; and `r.a.b.c.method()` runs at that path's leader (LENS 1.5).

**How this pass was made.** LENS.md took three proposals, written from one facts brief, and picked one shape. [E-55](experiments/E55-lens-prototype/README.md) built that shape small on data's real engine: about 1,000 lines, data at commit 63fea66. A skeptic then read LENS, E-54 and E-55 and made 24 findings, all applied. You approved all fourteen of LENS section 7's picks (V5-12). API.md was rewritten around them, and this tour follows API.md.

**What is sure.**
- Every code block in API.md compiles with TypeScript 6.0.2 against data's shipped types: 38 blocks. Its 81 lines that must not compile do not, each for the reason its comment gives (API 12, run 2026-11-18).
- Every `ts` block in this tour compiles against API.md's own declarations, and its 7 lines that must not compile do not, each for the reason its comment gives (section 7, run 2026-11-18).
- The lens was built small. Of E-55's 27 claims, 10 pass, 10 pass in part, sit at the edge of their bar or are stand-ins, 1 misses, 3 are records with no bar, and 3 were not run (LENS 6).
- Nothing of fero v5 is built. The 22 patterns, in the lens's spelling, compile and did not run (E-55 claim 25).
- Two skeptics read API.md's rewrite, LAYERS.md's and this tour (20 and 21 findings, many the same). Each one that held is applied. The design calls they forced are questions 20 to 24 (section 5.2).
- One correction to the decisions record: V5-12's context line named E-55's one miss as the `Proxy` step (claim 1). LENS 6 and E-55 count claim 11 as the miss (2.3 below), and claim 1 as a pass in part. The pages follow LENS and E-55, and so does the note "V5-12 amended" appended to [DECISIONS.md](../DECISIONS.md).

**How numbers are marked**, as in API.md. **E-55 claim n** is one of LENS section 6's claims, measured on E-55's prototype: the lens's and data's share in one process, never a whole fero write. **E-nn** is another experiment. **LENS n**, **PATHS n** (and **PA-n**), **MEMORY 9.n** and **V5-n** are those pages and decisions. **Reasoned**: an argument; nothing ran it. **A guess**: a number nobody measured.

**Words.**
- A **trip** is one message there and its answer back.
- A **commit** is the moment a write is on disk on most of the copies. Only then can anyone see it (V5-5). A **stage** is how far your own write has got when you hear back: `received`, `replicated`, then committed.
- A **partition** is the rows that one **leader** (one server) keeps in one order and can change together.
- To **fold** is to apply the log's records to the rows in memory. data does it, on every copy and on clients.
- A **lens** is an address inside a resource, such as `shop.data.widgets.stock`. It holds no data and does no work.
- A **step** is one property read on a lens (`.widgets`). A **verb** is a call on a lens (`.get()`, `.set(4)`).
- A **link** is one live connection from a lens to this process: a `here()`, a `tap`, or a `connect` to a target.
- Rows are **held on purpose** when this process serves the resource, said `hold: 'all'`, or has a live `here()` or `tap` on them.
- A **picture** is the rows a link selects, at the moment it starts.
- **SUB** is v5's one subscribe message, and **GET** its one read message. A **selection** is what one SUB brings into this process: a partition, the whole resource, or a view a server serves. Equal lenses share one.
- **The net** is JavaScript's garbage collector, as the last way a link ends.
- A **rule** is one thing a builder of fero must get right (V5-6). The base design has 416. A **user rule** is one thing a user of fero must know.

## 1. The shape, in about ten lines that do something real

```ts
// file: server.ts — a seed and methods make a server
import { fero, op } from 'fero'
const shop = await fero('shop', {
  data: { widgets: { stock: 10, price: 5 } },                                                  // the first rows
  methods: {
    sell: { at: 'row', run: (n: number, ctx) => ctx.at.stock.set(op.incr(-n, { min: 0 })) },   // called on a row
    low: (max: number, ctx) => ctx.data.lt('stock', max),                                      // the root only: a view
  },
  history: '1h',                                                                               // an hour of the log
})
export type Shop = typeof shop                                     // export the type, never the handle
```

```ts
// file: client.ts — only the name: a client
import { fero } from 'fero'
import type { Shop } from './server.ts'                            // a type only: the server's code never loads
const client = await fero<Shop>('shop')                            // a client. It holds nothing yet
console.log(await client.data.widgets.stock.get())                 // 10. Read once: one trip, nothing kept
const live = client.data.widgets.here()                            // hold widgets here, live: one SUB
live.tap((c) => console.log('stock', c.now.value?.stock))          // the picture (10), then once per commit (9)
const sold = await client.data.widgets.sell(1)                     // a method on a path: at widgets' leader
console.log(sold.value)                                            // 9. Back when it is on disk
```

**Three places, one job each.**
- `data` is the address of everything. A step builds an address. A verb on it reads (`get`), keeps it live (`here`, `tap`, `connect`), writes (`set`) or calls a method (`sell`).
- `rows` is the fast sync read of a whole resource this process holds: a server's, or one opened with `hold: 'all'`. A partition held by `here()` is read through its handle: `live.value`, `live.rows`.
- `methods` holds the calls with no path: `client.methods.low(5)`.

**Seven rules a user learns** (LENS 2.0). The first tour had three.
1. **A path is an address.** Building one sends nothing and reads nothing. It is not a promise: `await lens` gives the lens back.
2. **`get()` reads once. `here()` keeps it live. `connect(target, …)` keeps it live for the target.**
3. **Left of `here()`: plain data, and it may run on a server. Right of it: your code, here.**
4. **The wire sends whole partitions.** Hold anything inside a partition and you hold that partition (first build).
5. **A link ends at `close()`, with its scope, when its target closes, or when nobody uses it. You read what is held through what `here()` gave you.** A `connect` never makes rows readable.
6. **A `connect` function takes its target as an argument and changes nothing else.** Anything else belongs in `tap`.
7. **A method says where it may be called (`at:`), and checks what it is given.** A client picks the path and the argument.

**The first tour's three rules still hold.** A sync read never leaves this process and never guesses: if this process does not hold the row on purpose, it throws `not-held`. A change is sent whether you `await` it or not, and shows, to you and to everyone, when it commits. Awaiting a change means committed.

## 2. The choices that matter most

Each one says what it looks like now, what it looked like before (API.md of 2026-11-16, or v4), why it is easier, and what it costs. **Rules** are LENS 4.4's rows, all reasoned and none modelled; this tour puts each row under the choice it belongs to (section 2.12 adds them up). **Speed** is E-55's unless marked.

### 2.1 A path is an address

- **Now.** `shop.data.widgets.stock` is a lens. Each step is a lens too. A name is a key until it is called: `a.b.set(5)` is the verb `set`, and `a.b.set.set(5)` writes the field named `set`. `f.at(...keys)` builds the same lens with no `Proxy`, for keys in a variable and for hot loops.
  ```ts
  // file: address.ts — a path is an address: no trip, no read, nothing kept
  import { fero } from 'fero'
  import type { Shop } from './server.ts'
  const shop = await fero<Shop>('shop')
  const stock = shop.data.widgets.stock                     // two steps: an address. Not a promise
  const n = await stock.get()                               // a verb: read once
  const same = await shop.at('widgets', 'stock').get()      // the same address, with no Proxy
  // @ts-expect-error a lens is not a promise: `await` gives the lens back, not a value
  const wrong: number | undefined = await stock
  // @ts-expect-error a step names a field of the row, so a wrong name does not compile
  shop.data.widgets.stok.get()
  console.log(n, same, wrong)
  ```
- **Before.** In the 2026-11-16 API.md, `f.data.*` was data's own proxy, with no types: a wrong field name compiled. Reads went through `f.rows.k` or `await f.get(k)`. In v4 too, `f.data.k` was a handle and not a value, and no line said so. data's handle keeps every child for its parent's life: 318 to 1,333 B per key (LENS 2.1).
- **Why easier.**
  - One address then reads, writes, calls and streams (LENS 0). A component handed `stock` can use it without knowing where it sits.
  - Keys, verbs and methods are separate spaces: 47 of 47 cases pass on the prototype (E-55 claim 4).
  - **A lens is never a promise** (V5-12 pick 11). On E-55's first build a lens had `then`, so `await lens` read it. Then an `async` helper that returned the root lens downloaded the whole resource: 100,000 rows, 6.8 MB of JSON, in one GET (E-55 review). Now `await lens` gives the lens back. Seven names that JavaScript and common libraries probe on any object read as `undefined`: `then`, `toJSON`, `constructor`, `$$typeof`, `asymmetricMatch`, `nodeType` and `subscribe`. A key with one of those names takes `at()`.
  - Paths are typed. A wrong field, a wrong value, a method below its declared path and `await lens` used as a value do not compile (E-55 claim 5; API 12).
  - The lens stays a full lens, not only an address (V5-12 pick 10).
- **Cost.**
  - Rules: +3 for the lens and the call space, and 0 to +1 for `at()`, which turns a number key into its string and refuses other keys with `bad-key`.
  - Memory: a step keeps 0 to 0.3 B per key, against data's 318 to 1,333 B today (E-55 claim 2).
  - Speed: a step costs 49 to 99 ns with one key. With keys spread over 1,000,000 rows it costs 162 to 222 ns, median 205, against a bar of 150: the one cell of claim 1 that misses. That is the case `at()` is for: −79 to +33 ns over the direct read (E-55 claim 1).
  - **A lens is for wiring, not for a hot loop.** Two steps and a verb cost 0.17 to 0.29 µs, against 0.014 to 0.06 µs for a `Map` read (E-55 claim 1). So `rows` stays the fast read, and a lens you use often goes in a variable.
  - What gets worse: `typeof lens` is `'function'`, `JSON.stringify` skips a lens, and `structuredClone` throws on one. Plain assignment cannot be typed: E-55 tried four ways (claim 5). So typed code writes with `set` (2.7).

### 2.2 A client holds nothing until a line says what

- **Now.** A bare `fero('users')` holds no rows. It holds what its live `here()`s and `tap`s name, for as long as they live. `hold: 'all'`, or the line `users.data.here()`, holds every row. A size is a cache of the pictures of links that have closed, never read from.
  ```ts
  // file: hold.ts — what a client keeps
  import { fero } from 'fero'
  type User = { name: string }
  const users = await fero<User>('users')                    // holds nothing: every download is a line you write
  const me = users.data.u42.here()                           // now u42's partition is held on purpose, and live
  const all = await fero<User>('users', { hold: 'all' })     // v4's way, said out loud: every row, then every write
  const warm = await fero<User>('users', { hold: '200MB' })  // keeps pictures of closed links, inside 200 MB
  await me.ready
  console.log(me.value?.name, all.rows.u42?.name, warm.name)
  ```
- **Before.** In the 2026-11-16 API.md, `'all'` was the default, as in v4. `hold: 'asked'` held what you read or followed, and a size was `'asked'` inside a bound. The first tour called the default "the closest call" (its question 8). v4: a bare client downloads the whole resource; `replicas: N` and `ScopedError` for less.
- **Why easier.** V5-12 pick 1 (LENS 2.2). Every download is now a line you wrote. Under the old default, a bare `fero(name)` in a job downloaded the resource and then received every write anyone made to it, and nothing in the line said so.
  - **A size is not a subscription** (review F14). If a warm picture stayed subscribed, the server would send, and this process decode and fold, every change to every warm partition for nobody. Closed, it costs nothing. Reopened, it sends its position: if the server can still resume from there, only the changes since cross; if not, a new picture does (reasoned, not built).
  - `f.rows` now works only on a server or with `hold: 'all'` (API 3.9; question 15).
- **Cost.**
  - Rules: no row of its own; +1 for the size's rule (a closed link's picture is not subscribed, and a reopen resumes or takes a new picture).
  - The price you accepted (LENS 7 Q1): v4's first example and about 20 example READMEs change, and `client.rows.widgets` after a bare open throws `not-held`.
  - Speed: a cold client makes 2 to 3 trips and one commit (its session) when built well, and nothing more until a line asks (PATHS 3.2). `hold: 'all'` costs the whole resource once, then every write anyone makes, decoded and folded here. At 1,000,000 small rows the first fold alone is seconds of this process's main thread (computed from PATHS 2.1).

### 2.3 Read once, or keep it live: `get`, `here`, `connect`

- **Now.** Three verbs, one on each line.
  ```ts
  // file: links.ts — read once, keep it live, keep a target up to date
  import { fero } from 'fero'
  type Msg = { text: string; stars: number }
  const chat = await fero<Msg, 2>('chat')                          // a room is a partition, a message a row (2.9)
  const m7 = await chat.data.room1.m7.get()                        // read once: one trip; nothing kept
  const room = chat.data.room1.here()                              // hold room1, live: one SUB, shared by equal lenses
  await room.ready
  console.log(m7?.text, room.rows.m7?.text)                        // a sync read goes through the handle
  const label = chat.data.room1.m7.text.connect(el, 'textContent') // el.textContent now and at each commit
  chat.data.room1.connect(ws, (ws, c) => ws.send(c.text()))        // the target is passed in; a socket's link ends when it closes
  room.close(); label.close()                                      // an element does not say when it goes: close, or use a scope
  ```
  - `get()` is served here only from rows held on purpose; else it makes one trip. A GET carries the highest position this process has seen.
  - `here()` gives a handle: `ready`, `rows`, `value`, `close()`. The same word holds a row, a partition, the whole resource (`f.data.here()`) or a view a server serves (`f.methods.low(5).here()`).
  - `connect(target, fn | 'prop')` is `here()` tied to a target. fero holds the target weakly and passes it to your function.
- **Before.** In the 2026-11-16 API.md, `await users.get('u7')` brought the row's partition and kept it live for the life of the handle, and `get(k, { hold: false })` read once. `users.follow('u42')` gave a `Follow` handle; `follow({ prefix })` walked partition names; a served view was `.open()`ed. In v4, `await f.data` gathered from every member. data's `connect(anchor, fn)` today checks the anchor and then ignores it (code data:api/index.ts:357-361).
- **Why easier.**
  - V5-12 pick 11 (a read is `get()`), and V5-12's list of what goes: `follow`, `.open()` and `get`'s `hold: false` (LENS 2.2, 2.6). One word, `here()`, means "hold it live", whatever it holds.
  - **`get()` holds nothing.** 100,000 misses made 100,000 GETs, 0 SUBs, and kept 0 rows (E-55 claim 20). The old `get` hid a follow: a slow leak the line did not show.
  - **A read is served here only from rows held on purpose** (V5-12; review F1). Rows that only a `connect` keeps never serve a read, since when they go is the collector's choice. On E-55's first build the same program made 0 GETs or 1, by when a collection ran. Over 1,000 seeded runs, each ending dropped links at a random moment, a program showed 9.7 different patterns of reads served here or by a trip. With the rule: 1 (E-55 claim 14).
  - Equal lenses share one SUB, one decode and one `c.text()` per commit: exactly one of each for 2,000 links (E-55 claim 9). So 1,000 sockets in one room on one webserver cost one subscription.
  - The picture, then each commit, with no gap and no overlap: 0 wrong in 1,000 seeds in one process, and in 1,000 seeds across 4,337 disconnects over a real port (E-55 claim 7).
- **Cost.**
  - Rules: −1 for `get` (gone: the hidden follow and its drop order); +1 for the read rule and the GET's position; +1 because a partition held inside a held whole resource sends no SUB of its own; +1 because a resume starts from the server's position. So +2.
  - `get()` held on purpose: no trip. Not held: one trip, every time, and nothing kept. It takes the trip even when rows that only a `connect` keeps are in memory (E-55 claim 20; PATHS 4.4).
  - `here()` on a partition: one SUB, the partition once, then one shared message per change. Here, about 3.2 µs to decode and 0.2 to 1.9 µs to fold a small row (PATHS 4.5). A 100-row room's first picture, with 100,000 rows in all: 26 to 28 µs on the prototype (E-55 claim 6).
  - A second `here()`, `tap` or `connect` on a held selection: a lookup and a count, 39 to 45 ns; a second `here()` 163 to 169 ns (E-55 claims 6, 9).
  - `connect`: registering the target costs 0.13 to 0.33 µs, and 0.58 to 0.67 µs inside one long turn of the event loop that made about 150,000. Per commit, a weak link costs +28 to +35 ns over a strong sink, and 10,000 weak links cost 2.2 times 10,000 strong sinks. That is E-55's one miss: the bar was 1.1 (claim 11).
  - Not tested: the GET's position against copies that lag. E-55 had one server (API 11.2).

### 2.4 How a link ends: never by the collector alone

- **Now.** A link ends at the first of five things.
  ```ts
  // file: ends.ts — a link ends at the first of five
  import { fero, scope } from 'fero'
  type Msg = { text: string; stars: number }
  declare const feed: { push(text: string): void; on(ev: 'end', fn: () => void): void }
  const chat = await fero<Msg, 2>('chat')
  chat.data.room1.here().close()                                         // 1. close(): at once
  const page = scope(() => { chat.data.room2.here() })                   // 2. a scope: all made inside end at dispose()
  page.dispose()
  chat.data.room3.connect(ws, (ws, c) => ws.send(c.text()))              // 3. the target closes: a socket, say
  chat.data.room4.connect(feed, (feed, c) => feed.push(c.text()), { closes: 'end' })   //    or an event you name
  // 4. the count: equal links share one SUB; the last one out unsubscribes after `linger.ms`
  // 5. the collector: only the net, and only for a connect whose target other code dropped. A dev warning names the link's path
  ```
  fero knows when a Node `EventEmitter` (sockets, streams, the `ws` library), a `WebSocket` or a `MessagePort` closes. Any other target is left alone unless the call names its event. Views made right of `here()` end with their handle. **`here()` and `tap` are strong: only your code ends them**, never the collector. A handle you drop without `close()` or a scope is a leak for the life of the process, never a result that changes (API 3.10, its reading).
- **Before.** Your first form: weak references, so that no code has to end a link (LENS 1.5). The 2026-11-16 API.md: a `follow` or an `.open()`ed view ended at `close()`. v4's V4-54 let the collector release a method handler's views, and wrote down what that cost.
- **Why easier.** V5-12's rules: a link ends at `close()`, its scope, its target's own close, or a count with a linger, and the collector is only a net. V5-12 rejected the collector as the way a link ends.
  - **The collector may never run.** In a headless Chromium, 0 of 1,000 links whose DOM nodes were removed ended within 30 s, idle, busy, or with a commit every 10 ms (E-55 claim 13). In Node the first link ended after 7 ms to 16 s, and in one harness old targets in a busy process were never collected (LENS 2.2).
  - Until it runs, the server keeps sending and this process keeps decoding. One commit with 1,000 dropped, uncollected targets cost 0.80 to 0.90 ms, and all 1,000 functions still ran (E-55 claim 12).
  - **Three rules make the net harmless** (LENS 2.2). A link checks its target before each delivery, so a dead target is never called. A read is served here only from rows held on purpose (2.3). And a `connect` function changes only its target. With all three, a program gave 1 result over 1,000 seeded runs. When half the dropped links also wrote a shared counter, it gave 433 different results per 1,000 seeds (E-55 claim 14).
  - The function gets its target as an argument. A function that names its own target in its body keeps that target alive for good (E-55 claim 15).
  - Views right of `here()` now end with their handle: 59,958 view sinks over 1,000 seeds, 0 calls after the end, 0 views left. The first build leaked them (E-55 claim 26).
- **Cost.**
  - Rules: +3 for `here`, `connect` and how they end; +1 for "a `connect` function changes only its target"; 0 to +1 for listening for a close only on the named kinds. So +4 to +5.
  - Two user rules, 5 and 6. fero cannot check rule 6 for a plain object. For a DOM node the dev warning sees a detached node that is still being fed.
  - **A dead link the net has not found costs what a live one does, and the line does not show it**: its selection goes on crossing, decoding and folding for 7 ms to never. `close()`, a scope or the count is the fix. How long a dead link's SUB lives is the one thing the collector still decides: a cost, never a result (E-55 review).
  - A new process key, `linger.ms`, 1000 by default: a guess (API 9).

### 2.5 `tap`: one argument per commit

- **Now.** `tap((c) => …)` is called once per commit, with one argument, by reference.
  ```ts
  // file: tap.ts — one argument per commit, by reference
  import { fero } from 'fero'
  type Msg = { text: string; stars: number }
  const chat = await fero<Msg, 2>('chat')
  const sink = chat.data.room1.tap((c) => {
    if (c.first) console.log('the picture so far comes first, as adds')
    for (const ch of c.changes) draw(list, [ch.type, ch.key, ch.row, ch.prev])   // this commit's changes
    console.log(c.now.rows.m7?.text)                                             // the latest state: a lookup, not a copy
  })
  // a tap is strong: it lives, and holds room1, until sink.close() or its scope ends. The collector never ends it
  ```
  `c.recs()` and `c.text()` give the wire-shaped records and their JSON text, for code that forwards them. Rows handed to a sink are frozen.
- **Before.** In v4 and in the 2026-11-16 API.md, data reads the function's source text to choose (code data:ops/misc.ts:598-611). `tap(() => …)` gets nothing. `tap((rec) => …)` gets one cloned record per row change, at 1.5 to 1.8 µs each, and never the latest copy (E-55 review).
- **Why easier.** You asked whether `tap`'s argument gives changes, nothing, or the latest copy (LENS 1.6). Now it gives both, by reference, in one shape. The same `c` comes after a target in `connect`. It is part of the approved shape (V5-12 pick 14) and of data's change D4 (pick 9).
  - **Rows handed to a sink are frozen** on their first hand-out (V5-12; review F15). Without it, one sink that changed a row would corrupt the store and every other sink of that commit.
  - `c.recs()` and `c.text()` are built once per commit and shared: 100 builds for 100,000 deliveries (E-55 claim 9).
- **Cost.**
  - Rules: −1, in data: the choice by source text goes. The freeze was owed already (DATA-07), so 0 here.
  - **A tap is not free.** One that reads nothing adds 92 to 198 ns a commit over no sink, and 63 to 122 ns of that is data's own delivery to any sink. The bar was 50: missed, and the lens's own share (31 to 103 ns) is not resolved against it (E-55 claim 10, the review's harness).
  - Reading `c.changes` or `c.now` adds nothing the harness could see. `c.recs()` adds 166 to 216 ns. Freezing a changed row adds 163 to 220 ns.
  - It removes 1.5 to 1.8 µs a change for a tap that names a parameter.
  - The first `c.changes` walks the picture so far: O(rows held), in your code.

### 2.6 The line: plain data left of `here()`, your code right of it

- **Now.** Three kinds of thing may stand left of `here()`.
  - **A. a partition**: `chat.data.room1.here()`.
  - **B. plain-data operators inside one partition**: `chat.data.room1.gt('stars', 0).za('stars', 10).here()`. In the first build the partition crosses whole and the operators run here.
  - **C. a view over the whole resource that the server named in `methods:`**: `shop.methods.low(5).here()`, under a cap on live served views.
  ```ts
  // file: line.ts — plain data left of here(), your code right of it
  import { fero } from 'fero'
  import type { Shop } from './server.ts'
  type Msg = { text: string; stars: number }
  const chat = await fero<Msg, 2>('chat')
  const best = chat.data.room1.gt('stars', 0).za('stars', 10).here()   // B: may run on a server, later
  const mine = chat.data.room1.here().filter((m) => m.stars > 2)       // A, then a function right of here(): here
  // @ts-expect-error a function cannot stand left of here(): code cannot travel
  chat.data.room1.filter((m: Msg) => m.stars > 2).here()
  const shop = await fero<Shop>('shop')
  const low = shop.methods.low(5).here()                               // C: the server keeps the view; its changes cross
  await Promise.all([best.ready, mine.ready, low.ready])               // a sync read waits for the first picture
  console.log(best.rows, mine.rows, low.rows)
  ```
  Untyped code that puts a function left of `here()` is refused `unencodable`. A whole-resource operator left of `here()` on a client is refused `not-held`, and the hint names a method, or `f.data.here()` with the operator right of it. Past the cap, a served view is refused `too-many-views`.
- **Before.** The 2026-11-16 API.md named four of the seven places a computation can run with four unrelated words: `f.data.gt(…)` for a local view, `f.follow(of)` for some partitions, a method's `.open()` for a served view, and `derive()`. Part of a partition had no name at all (LENS 2.3). v4: views over held rows, and a method that returns a view streams (example 09).
- **Why easier.** You asked for operators before and after the call, one for server work and one for local work (LENS 1.5). V5-12 picks 2 and 5.
  - **Class C needs a method.** A view a client makes up over every row is work on every write, on a server: 100 distinct filters cost 9 to 18 µs a record, and `group` 2,574 µs a record at 1,000,000 rows (E-05). `methods:` is the door (V4-5): with it, clients change rows only through the methods, and now they ask only for the views the methods name.
  - **And a cap.** Each distinct argument is its own served view, at 9.9 KB to 12.8 MB of server memory each (E-55 claim 16). A client that called `low(i)` in a loop could make the server keep as many as it liked.
  - **Class B waits.** A view costs about the same on either side. Pushing it down moves its CPU and memory to the server and saves each reader the partition's bytes: a first picture of 677 to 765 B against 6 KB to 6.6 MB (E-55 claim 16). It needs three things that do not exist yet: a cap that covers shapes, the SUB's `view` selector modelled (claim 22), and the order channel on the wire (data's record of each row's place in an ordered view). With a plain keyed copy, 239 of 1,000 seeded runs gave a different answer; with the order kept, 0 (claim 17). With those three, class B can come later with no change to any app line.
- **Cost.**
  - Rules: +2 for the line; +1 to +2 for the cap. Owed when modelled: +4 to +6 for the `view` selector, which the old `.open()` owed too. Later: +5 (4 to 7) for class B.
  - User rules 3 and 4. **Rule 4 is a cost the line hides**: `chat.data.room1.m7.text.connect(…)` holds all of `room1`. With a row per partition (depth 1) the row is the partition, so there the first build is exact.
  - Operators right of `here()`: a filter about 1 µs per affected view (E-05); an ordered view with a window 1.6 to 62 µs a change, by partition size (E-55 claim 16).
  - A served view: its own work on a server, once for all equal calls; a client receives only its changes. Not built on the prototype (E-55 claim 27).
  - Two new resource keys, `views.client` and `views.max`, 16 and 1,000: guesses (API 9).

### 2.7 Writes on the path

- **Now.** The path write is the main spelling.
  ```ts
  // file: writes.ts — the path write is the main spelling
  import { fero, op } from 'fero'
  type Item = { stock: number; price: number }
  const parts = await fero<Item>('parts')                                  // a resource with no methods: a client may write
  const w = parts.data.gizmos.set({ stock: 7, price: 9 })                  // a whole row: a handle with early stages
  await w.received                                                         // optional: the leader has it
  await parts.data.widgets.stock.set(op.incr(-1, { min: 0 }))              // an op: the leader computes it
  await parts.data.widgets.set((row) => row && { ...row, price: 12 })      // read, decide, write; tried again on a conflict
  await parts.data.gizmos.remove()
  await parts.set(['widgets', 'stock'], 4)                                 // the array form of the same kind of write
  ```
  `f.set(path, v)` and `f.remove(path)` stay as the array form. Plain assignment (`f.data.k = row`) stays on untyped handles. A typed client of a resource with methods has no writes at all (2.8). A write above a row, at the root or on a partition at depth 2, is refused `bad-path`.
- **Before.** In the 2026-11-16 API.md, the verbs were on the resource: `shop.set('k', row)`, `shop.get(k)`, `shop.remove(k)`. v4's lens call `shop.data.set('k', row)` stayed as a second name for the same write (the first tour's 2.3). v4 itself had the built-in `methods.update(change, { confirm })`, `insert`, `remove` and `read`, and `f.data.set`, `update` and `patch`.
- **Why easier.** You preferred `shop.data.a.b.c.set()` (LENS 1.5). V5-12 drops `f.data.set`, and pick 6 says typed code writes with `set`.
  - The address is one thing and the verb another (LENS 2.5).
  - `f.set(path, v)` stays because it needs no `Proxy`, and `ctx.set`, `batch` items and libraries use it.
  - Plain assignment cannot be typed: TypeScript cannot give a property one type to read (a lens) and another to write (a value). E-55 tried four ways (claim 5).
  - Everything the first tour said about a write's handle stands (2.13).
- **Cost.**
  - Rules: −1. The lens calls as a second name go.
  - Speed: the same record and the same message as before. The steps add 0.18 to 0.73 µs to a 0.7 to 1.3 µs local data write; a kept lens adds −0.03 to +0.42 µs; `at()` about 0 (E-55 claim 3). A whole fero write is far more: v4's issue path alone is 7.7 to 8.3 µs (PATHS 2.6), and the commit about 1 ms (MEMORY 9.3).
  - What stays: three spellings (assignment, `lens.set(v)`, `f.set(path, v)`).

### 2.8 Methods on a path, with `at:`

- **Now.** `shop.data.widgets.sell(1)` runs at the leader of `widgets`' partition. A method says where it may be called. A bare function may be called only at the root: `shop.methods.low(5)`. To be called on a path it says which kind, `{ at: 'row' | 'partition' | 'any', run }`, and the server refuses any other path with `bad-path`. `ctx.at` is the lens the call was made on.
  ```ts
  // file: methods.ts — a client typed by the server, with `import type`
  import { fero } from 'fero'
  import type { Shop } from './server.ts'                 // a type only: the server's code never loads
  const shop = await fero<Shop>('shop')
  await shop.data.widgets.sell(1)                         // at widgets' leader: one trip, one commit
  await shop.data.widgets.sell(1, { once: 'order-981' })  // at most once, even across retries
  await shop.data.widgets.call('sell', 1)                 // by name: the way out of a clash with a verb
  // @ts-expect-error `sell` is declared `at: 'row'`: it is not offered at the root
  await shop.methods.sell(1)
  // @ts-expect-error nor below the row
  await shop.data.widgets.stock.sell(1)
  // @ts-expect-error nor through call(): it is checked against `at:` too
  await shop.data.widgets.stock.call('sell', 1)
  // @ts-expect-error V4-5: the typed client of a resource with methods has no set
  await shop.data.widgets.stock.set(4)
  ```
  **Type a client by the server's type, not its handle.** The server says `export type Shop = typeof shop`; the client says `import type { Shop } from './server.ts'` and `fero<Shop>('shop')`. Check types before you bundle. A resource with no methods can be typed by its rows alone, `fero<Item>('parts')`, as in 2.7.
- **Before.** The 2026-11-16 API.md had `{ near: true, run }` (the argument is the row key) or `{ near: 'sku', run }`: a hint kept with the resource's settings, so a client learned it and sent the call to that row's leader. The server exported its handle (`export const shop`), and a client was typed as `fero<typeof shop>`. v4: `{ retry: true }`, no placement, and types by hand.
- **Why easier.** You asked that `r.a.b.c.method()` run at that path's leader (LENS 1.5). V5-12 picks 3, 12 and 13.
  - The caller's line carries the row, so there is no hint to store or learn.
  - **The server checks the path.** On E-55's first build every method was on every lens. `widgets.left.sell(1)` then ran `ctx.at.left.set(…)` on the field `left` and turned `left: 5` into `{ left: {…} }`: a client changed a row's shape through the door. On the changed build, 202 of 202 calls on a path the method did not declare were refused, with 0 commits (E-55 review, claim 18). Types do not stop an untyped or hostile client; the server's check does.
  - On a lens, fero's own verbs win; `lens.call(name, arg)` reaches a method named like one (pick 3). The types check `call` against `at:` as they check the name; for untyped code the server refuses a wrong path with `bad-path`.
  - **`import type` and a type check** (LENS 1.3). In Node, `import { Shop }` by mistake is a SyntaxError when the modules link, and `tsc` says TS1484. But esbuild with `verbatimModuleSyntax` ships the server for it, method code and all (E-55 claim 24). So run `tsc --noEmit` or the lint rule `consistent-type-imports` before bundling. A browser build of fero in which a server role throws comes later (pick 12).
- **Cost.**
  - Rules: 0 for the call on a path (routing by the path and `ctx.at` come in; the hint's two forms go), and +1 for the path check (review F8). So +1.
  - User rule 7: a method checks its argument, since a client picks it as it picks the path.
  - Speed: on a path, one trip and one commit, the least a call can cost (PA-25). In E-55's stand-in (the leader table and the forwarding are written in the bench), 1,000 path calls made 1,000 trips and 1,000 commits; after a leader moved, one redirect, then one trip again. With no path, a call makes 0.66 extra trips with three servers and 0.80 with five (E-55 claim 18). The path check is a lookup (reasoned).
  - A call with `once` still costs three commits in a row and up to two trips to `#calls`' leader; the path does not save them (PATHS 3.4).
  - Two costs of the shape. A verb fero adds later could shadow a method somebody wrote (LENS 2.4). And a type-only import still makes the client's type check load the server file's whole import graph (LENS 1.3, reasoned).

### 2.9 `depth: 2`: the first key is the partition

- **Now.** The first key of a path is always the partition. `depth` says where the row begins, and it is fixed when the resource is founded.
  ```ts
  // file: depth.ts — the first key is always the partition
  import { fero } from 'fero'
  type Msg = { text: string; at: number }
  const users = await fero('users', { server: true })                    // depth 1, the default: users.data.u42 is a row and its own partition
  const chat = await fero<Msg, 2>('chat', { server: true, depth: 2 })    // chat.data.room1 is a partition; chat.data.room1.m7 a row
  await chat.data.room1[fero.id()].set({ text: 'hi', at: fero.now() })   // a row write: no key string to build or split
  const room = chat.data.room1.here()                                    // one partition, held live
  console.log(users.name, room.rows)
  ```
- **Before.** The 2026-11-16 API.md had `partition: { before: '/' }`, with keys like `'room1/m7'` built by hand, and `follow({ prefix })` walked the partition names. v4 hashed partitions and hid them.
- **Why easier.** You asked whether `[prefix][suffix]` should be the default (LENS 1.1). V5-12 pick 4: yes to the shape.
  - With one level of rows, `chat.data.room1.m7` would be a field of the row `room1`. A message as a field loses what a row has: its own version and conditions, its own `ttl` and size limit, early stages, `e.value` in `changes`, and views over it. And a field write copies its room on every copy: 0.43 ms at 1,000 messages, 3.6 ms at 10,000 (LENS 1.1, measured in its facts brief).
  - `{ before }` was the same idea spelled as a text rule, and it needed an index from partition to rows on every copy (PA-17).
  - Every process routes by hashing the first key, as fero v2 did, with nothing to learn.
  - Two levels always would make `users.data.u42.name` a row, so a user could not be read or expired as one thing (reasoned).
  - The partition function stays, built later (pick 4).
- **Cost.**
  - Rules: −1 to 0. The text rule and its escape go; the index was owed anyway.
  - Speed, on today's data (E-55 claim 19). **Partitions of 100 to 10,000 rows pass**: the fold costs 0.78 to 1.10 times a flat store with PA-17's index; each partition takes 1.2 KB to 805 KB less memory; a 100-row room's first picture takes 0.012 to 0.017 ms at 100,000 to 1,000,000 rows in all, where a flat store with no index walks every row (30 to 40 ms). **One-row partitions miss**: about 0.9 KB more each, and 1.3 to 1.5 times the fold, until data's two-level store (D3, pick 9). A key grows 2 B. A row write costs about the same either way: 2.1 to 3.9 µs at depth 2, 2.0 to 3.4 µs flat.
  - A depth-2 seed does not give the row type: you name it, `fero<Msg, 2>` (API 6).

### 2.10 `derive` as a pattern, paced

- **Now.** The mark is a write option, `{ from: e }`: "this write applies source record `e`". `derive()` and `consumer().run()` are shown first. The four lines they are made of come second.
  ```ts
  // file: derive.ts — totals from orders, exactly once: the library first, then what it is made of
  import { fero, op, derive, lock } from 'fero'
  type Order = { user: string; cents: number }
  const orders = await fero<Order>('orders')                       // a client of the source: it holds nothing
  const totals = await fero<number>('totals', { server: true })    // a server of the target
  await derive(orders, totals, (e) => {                            // paced, run once, with bare marks for idle slots
    if (e.value) totals.data[e.value.user].set(op.incr(e.value.cents), { from: e })
  })
  // what derive() is made of, shown for a second target: exact only paced, and only in one process, so under a lock
  const spent = await fero<number>('spent', { server: true })
  await lock('derive:spent', async () => {
    for await (const e of orders.data.changes({ from: spent.marks('spent') }))
      if (e.value) spent.data[e.value.user].set(op.incr(e.value.cents), { from: e })   // not awaited: writes pipeline
  })
  ```
- **Before.** The 2026-11-16 API.md: `derive(orders, totals, (e, out) => { if (e.value) out.set(e.value.user, op.incr(e.value.cents)) })`. `out`'s writes returned nothing, and the mark was hidden inside `out`. Who runs a derive was open (its Q-B8). v4 had no `derive`.
- **Why easier.** You asked why `derive` needs a separate function (LENS 1.7). It does not need to be a primitive. V5-12 pick 7 puts the mark on the write line, where you can see it.
  - **But the plain pipe is not exactly once.** The four lines are exact only with two more things (V5-12's rules; review F2).
  - **fero paces them.** A client holds at most 512 waiting writes; past that a plain write is refused `backpressure`. The loop does not await, so it would never see the refusal, and a later write would move the mark past the lost record. So a marked write is never refused for backpressure: it waits, and the reader its `e` came from stops yielding. In E-55's seeded stand-in for E-30's model, the four lines as written lost outputs in 998 of 1,000 seeds; paced, 0 lost and 0 doubled (E-55 claim 21).
  - **They run in one process.** With `server: true`, every server of `totals` that runs the four lines derives. The marks keep the answer right, but the work is done once per server. `derive()` and `consumer()` split the source's shares. So who runs a derive is now the app's choice, and Q-B8 closes (LENS 4.3).
  - `derive()` also sends bare marks (`target.mark(e)`: a mark with no write), so a part of the target that gets no output for a while does not hold the restart point back. It is about fifteen lines of library over public calls (LENS 1.7, 2.8). `consumer().run()` has no target, so it sends none: it restarts from its own place in the source, moved only once its marked writes are answered (API 3.11's reading; question 24).
  - **One open point: a source record with several outputs.** As the rule is written, a second marked write of the same `e` to the same part of the target would be skipped at the mark the first one raised, and nothing commits the two together. Until it is modelled: one marked write per source record per target (question 21).
  - **Is there exactly-once behaviour, as in Kafka?** (LENS 1.2.) Yes, for writes into fero, in three layers, each with a limit. A resend counts once inside a session. A `once` name counts once for a day. A mark counts once per source record, while the source keeps its log and the loop is paced in one process. Like Kafka, not for an email or a payment made inside your code. Weaker than Kafka: no atomic write across partitions. Simpler: no coordinator and no two-phase commit (E-30).
- **Cost.**
  - Rules: 0 to +2 for `{ from: e }`, `marks()` and `mark()` (E-30's 5 rules exist); +1 for the marked write that waits. So +1 to +3.
  - Speed: a 29 B mark, and a share of one commit per output partition. Not awaited, marked writes ran at 122,000 to 134,000 a second, against 239 to 240 a second awaited one by one (E-55 claim 21).
  - The source needs `history` (default 0). Past it, the deriver stops with `expired` and never skips a record (LAYERS 8.8).
  - A marked write answers at its commit only, since it can be skipped at its mark (V5-11 ruling 6). It cannot also carry a `once` name: API.md's types now refuse `{ from: e, once }`. LENS 4.4 counted it as composing with `once` and `if` (question 20).
  - Owed: E-30's model with marks written by app code, and the pacing rule in a real client. Claim 21 is a seeded stand-in: no Raft, no lost log tails.

### 2.11 `asOf`: looking back, on a reader

- **Now.** `lens.asOf(position)` gives that lens as it was: read-only, folded in this process from the log. The position is a version, a cursor or a writer time (V5-4). `step` and `seek` move the reader. It is built after the first build (API.md's and LAYERS' reading; question 22).
  ```ts
  // file: asof.ts — a row as it was: a reader, folded here
  import { fero } from 'fero'
  import type { Shop } from './server.ts'
  const shop = await fero<Shop>('shop')
  const sold = await shop.data.widgets.sell(1)               // the answer carries the version of its write
  const past = await shop.data.widgets.asOf(sold.version)   // one log-mode SUB from the nearest snapshot; folded here
  console.log(past.value?.stock)                            // the row as it was at that version
  past.step(-1)                                             // one commit back: it moves this reader
  console.log(past.value?.stock)                            // the row just before that write's commit
  past.close()                                              // memory grows with the window, so close it
  ```
- **Before.** Nothing in the 2026-11-16 API.md: only forks, tapes and restore. You asked whether to step back by reversing old records, and whether to use O(log n) or O(1) persistent data (LENS 1.4).
- **Why easier.** V5-12 pick 8 (E-54). No record carries the value before, and none needs to: the log is already the history (V5-1). No persistent structure belongs on the live write path. A hash-tree root kept per write adds 3.3 to 5.7 µs to a 0.79 to 1.4 µs fold and keeps 1.3 to 1.7 KB a version, and the collector goes from 0.5 % to 15 to 22 % of the time. A hash tree used only as the store still adds 1.1 to 2.2 µs a write. A prior value in the log would add 80 to 150 % to a record's bytes (E-54). On a reader, fat nodes win: a sorted list of versions per row. No server keeps versions, and no write pays for a reader it does not have.
- **Cost.**
  - Rules: +3, in a reader library; none in the kernel.
  - Speed, on data's real fold (E-55 claim 23). To open, it folds every record from the nearest snapshot to the position: 3.6 to 4.4 µs a record, of which the version lists are +1.5 to 2.0 µs. So a million records since the snapshot take about 4 s (a reasoned sum). To hold: 103 B a version at 100,000 rows, 285 B at 1,000,000. A step or a jump: 10 to 12 ns. A row at any version: 0.6 to 1.4 µs. 0 wrong answers in 1,680 checks against a refold.
  - Prefer it on a partition lens. `f.data.asOf(p)` folds every partition.
  - It needs the log to reach back: `history` on the resource, or the tier. Past it: `expired`. A step is one commit, never part of one.

### 2.12 What the rules add up to

| Choice | Rules (LENS 4.4's rows; reasoned) | User rules (LENS 2.0) |
|---|---|---|
| 2.1 a path is an address | +3 to +4 | 1 |
| 2.2 a client holds nothing | +1 | |
| 2.3 `get`, `here`, `connect` | +2 | 2 |
| 2.4 how a link ends | +4 to +5 | 5, 6 |
| 2.5 `tap`'s argument | −1 | |
| 2.6 the line | +3 to +4 | 3, 4 |
| 2.7 writes on the path | −1 | |
| 2.8 methods on a path | +1 | 7 |
| 2.9 `depth: 2` | −1 to 0 | |
| 2.10 `derive`, paced | +1 to +3 | |
| **the first build** | **+12 to +18 on 416: 3 to 4 %** (V5-12) | **seven** |
| 2.11 `asOf`, after the first build | +3, in a reader library | |
| owed: the `view` selector, when modelled | +4 to +6 | |
| later: class B | +5 (4 to 7) | |

- **The rows and their sum are LENS 4.4's.** Which choice each row sits under is this tour's.
- **By V5-6's measure the lens costs rules, and cannot win on rules alone.** The trade (LENS 4.4; API 5.5): the seven places a computation can run are said with one address and one line, `here()`; a `get` no longer hides a follow; and `f.data.*` is typed.
- **What you no longer have to know:** `follow`, `.open()`, `{ before }`, the two meanings of `tap`, `f.data.set`, the follow hidden in `get`, and `near` as a hint to learn.
- **What stays, said plainly:** `hold` still has three values (nothing, `'all'`, a size). A write still has three spellings. A method on a path still declares one word, `at:`, where `near: true` stood.
- **data changes for it, in TypeScript, none in Rust** (V5-12 pick 9; LENS 4.5): D1 (path subscriptions through a keyed index) and D2 (the callable lens that keeps nothing) first, then D3 (two-level stores) and D4 (one sink shape). Each is useful to data alone.

### 2.13 Choices from the first tour that stand

The lens changes their spelling, not their meaning.

```ts
// file: handle.ts — one write, three moments; many writes, together
import { fero } from 'fero'
type Reading = { c: number }
const temps = await fero<Reading>('temps')                                    // a client: it holds nothing, and only writes
const w = temps.data.a.set({ c: 20 })                                         // the write leaves with this turn's other writes
await w.received                                                              // the leader has it          0.15 ms
await w.replicated                                                            // most copies have it        0.36 ms
const ack = await w                                                           // committed, on disk         0.97 ms
const rows: [string, Reading][] = [['b', { c: 21 }], ['c', { c: 19 }]]
for (let i = 0; i < rows.length; i += 256)                                    // a bulk load: a few hundred at a time
  await Promise.all(rows.slice(i, i + 256).map(([k, v]) => temps.at(k).set(v)))
console.log(ack.version)
```

- **One handle, three moments** (V5-5, V5-11). `await w` is always the commit. `received` and `replicated` are progress reports for your own write, and nobody sees the write before it commits. Times: TypeScript, one box, median (MEMORY 9.3). Only a plain whole-row write has early moments. An op, a condition, a field write, a `once` name, a marked write, `set(fn)`, a batch and a method call answer at the commit only, and the types say so.
- **Sending writes together is the default.** Writes made in one turn of the event loop leave in one message per leader and share disk syncs. `await` in a loop is the one slow shape: 16 writes take about 15.5 ms one by one and about 1 ms together (PA-40, computed). A client holds at most 512 waiting writes, or 64 MB. Past that a plain write's handle rejects `backpressure`, an assignment throws it, and a marked write waits (2.10).
- **Read, decide, write: three safe forms**: an op, a condition (`if: { absent: true }`), and `lens.set(fn)`. On the prototype, a plain read then a plain set sold the last item twice in 120 of 120 races ([E-22](experiments/E22-api-prototype/README.md)). A method is not a transaction, even on a path.
- **A resource is its own small cluster** (V5-2). It costs about 8 KB per server while idle (V5-8), so a resource is a table, not a row. A server role is real work, so it belongs in a server file.
- **Errors: one class, sorted by what to do.** Every failure is a `FeroError` with a `code`, an `outcome` (did it commit?) and a `hint` that names the next call. The lens adds three codes: `bad-path`, `bad-key` and `too-many-views`, and a function left of `here()` is `unencodable`.
- **`rows` and `snapshot`.** `f.rows.k` is one lookup; `f.snapshot` keeps v4's meaning, a whole picture per access. Both now read only a whole resource held on purpose (question 1).

**What the old spellings became:**

| 2026-11-16 API.md | Now | Why |
|---|---|---|
| `f.follow(of)`, `.open()` | `lens.here()` | one word for "hold it live" (2.3) |
| `near: true \| 'sku'` | `{ at: 'row' \| 'partition' \| 'any', run }` | a guard the server checks, not a hint to learn (2.8) |
| `partition: { before: '/' }` | `depth: 2` | the first key is the partition (2.9) |
| `await f.get(k)` | `await f.data[k].get()`, or `f.at(k).get()` | the read is a verb on the address (2.3) |
| `changes({ of: k })` | `f.data[k].changes()` | the lens is the selector |
| `derive`'s `out.set(k, v)` | `target.data[k].set(v, { from: e })` | the mark is on the write line (2.10) |
| `fero<typeof shop>` with the handle exported | `export type Shop = typeof shop`, `import type`, `fero<Shop>` | the client never loads the server (2.8) |
| a token's `follow` claim | its `read` claim | the claim keeps its meaning, under a word that still exists (question 18) |

## 3. What every call costs, on one card

| Call | Trips | Commits | Whole-resource work |
|---|---|---|---|
| a step, `f.data.a.b` or `f.at(a, b)` | 0 | 0 | none; nothing kept |
| `f.rows.k`, `held.rows.k`, `held.value` | 0 | 0 | none |
| `lens.get()`: held on purpose / not | 0 / 1, each time | 0 | none; nothing kept |
| `lens.get({ fresh: true })` | 1, plus the leader's check | 0 | none |
| a write: `lens.set`, `f.set(path, v)`, an assignment, `lens.remove` | 1 | 1, shared | none |
| a write with `once` | 1 | 1 | none; about 221 B for a day |
| a marked write, `{ from: e }` | 1 | a share of 1 | none; a 29 B mark. Never refused `backpressure` |
| N writes made together | 1 message per leader | shared | none. At most 512 waiting, or 64 MB; then `backpressure` |
| a method on a path | 1, to its leader | 1 or more | none |
| a method with no path | 1, +1 per write its server does not lead | 1 or more | none |
| a call with `once` | 1, plus up to 2 to `#calls`' leader | 3 in a row | none |
| `lens.here()` on a partition | 1 SUB, shared | 0 | the partition once, then its changes |
| a second `here()`, `tap` or `connect` on it | 0 | 0 | none: a lookup and a count |
| `lens.connect(target, …)` | as `here()` | 0 | as `here()`; +28 to +35 ns a commit per weak link |
| a dead link the net has not found | 0 | 0 | **its selection goes on crossing, for 7 ms to never** |
| a lens inside a big partition | as `here()` | 0 | **the whole partition** (first build) |
| `tap((c) => …)` | 0 | 0 | none; 92 to 198 ns a commit |
| `f.methods.x(arg).here()`, a served view | 1 SUB | 0 | the view's work on a server, once for all equal calls; counted against the cap |
| `lens.changes({ from })` | 1 to open | 0 | every kept record of the selection |
| `lens.asOf(position)` | 1 log-mode SUB | 0 | the window's records once, folded here; `f.data.asOf` folds every partition |
| opening a client, by default | 2 to 3 | 1 | none: it holds nothing |
| `hold: 'all'`, or `f.data.here()` | 1 SUB | 0 | **the whole resource, once; then every write to it** |
| opening with a server role | | | **the whole log, a disk, a vote** |
| listing `f.rows` or a handle's `rows`; v4's `f.snapshot` | 0 | 0 | **every held row** |
| a saga | | 6 to 7 in a row | none |
| a queue message; a `service` ask | | 3 | none |

A write's own path is 2 trips and 1 disk sync, which is the least any correct design can do (PATHS 0). API.md section 4 has the full card, with sources. **Three whole-resource costs do not show in the line, so learn them**: `hold: 'all'` (an option, not a line of code), v4's `f.snapshot` (no brackets), and a lens inside a partition, which holds the whole partition (API 4).

## 4. Explained badly before, and the same now

These did not change. They only get a plainer sentence.

1. **Assignment and `set`.** "Assignment is `set` without the answer." Now only on untyped handles; typed code writes with `set`.
2. **Roles.** "A process that brings something serves. A process that only names the resource is a client."
3. **The options.** Ask of each: who remembers it? This process (`linger`), the resource (`depth`, `views`, `history`), or this open (`hold`, `server`).
4. **"A rung per resource, never per write", and then answers per call.** Two different things. Every write commits the same way: on disk at a majority. A stage is only how far your own write has got when you hear back.
5. **`fresh`.** "A local read can be a moment behind another process's write. `fresh` asks the leader." Most apps never need it.
6. **`outcome`.** "Did it commit?" Most apps only log it.
7. **Versions and cursors.** A version is a row's place in its partition's order. A cursor is a bookmark. Both are text you pass back.
8. **"A check-then-set must carry a condition or be an op."** Or be `set(fn)`. One leader judges every write on the newest state, so your read is a copy that can be old. A method on a path does not change that.
9. **`batch`.** Not "for speed". It means "all or none", inside one partition.
10. **Five words to start**: resource, row, partition, path (the lens), method. Slots, groups, attempts and sessions are plumbing; they show only in `f.cluster`.
11. **`here` and `changes`.** Rows, or records. `here()` keeps chosen rows up to date here, and a slow reader sees the newest state. `changes()` hands you every record, in order, and a slow reader waits.

## 5. Questions for you

### 5.1 The first tour's sixteen questions: where each stands

Numbers 1 to 14 are the first tour's, and API.md 11.1 keeps them. The first tour's 15 and 16 are now API.md 11.2's Q-B1 and Q-B3, because API.md 11.1 uses 15 to 24 for new questions. "Closed" means a pick of V5-12 answers it by name. "Settled in use" means an approved decision already writes the answer, though you have not ruled on the question by name; API.md 11.1 marks the same three the same way.

| # | The question | Where it stands | By |
|---|---|---|---|
| 1 | `rows` for reads; what should `snapshot` be? | **open** (5.2) | |
| 2 | verbs on the resource, or on `data`? | **closed**: the path write `f.data.k.set(v)` is the main spelling; `f.set(path, v)` is the array form; `f.data.set` goes | V5-12, its list of what goes; LENS 2.5 |
| 3 | `near` now, or after the first build is timed? | **closed**: `near` goes; a method on a path runs at its leader and declares `at:` | V5-12 picks 3 and 13 |
| 4 | `set(key, fn)`: add it? | **settled in use**: `lens.set(fn)`. The give-up after 8 tries stays a guess (Q-B6) | V5-12 approved LENS section 2's shape, and LENS 2.5 writes it |
| 5 | `changes`, `log` or `read`? | **settled in use**: `changes()`, now a verb on the lens | V5-12, which drops `changes`'s `of:` and paces the `changes()` reader |
| 6 | what a write does when the client is full | **in part**: a marked write waits and pauses its reader. The rest is **open** (5.2) | V5-12's rules |
| 7 | must some process say `server: true` to create a resource? | **open** (5.2) | |
| 8 | a client's default `hold` | **closed**: nothing, until a `here()` or a `tap`; `'all'` and a size stay as options | V5-12 pick 1 |
| 9 | a `get` that misses: follow, or read once? | **closed**: `get()` reads once and holds nothing; `hold: false` goes | V5-12 pick 11, and its list of what goes |
| 10 | no `set` on the typed client of a resource with methods? | **closed**: yes, in the types | V5-12 (LENS 2.4); V4-5 |
| 11 | `{ retry: true }` on a call? | **open** (5.2) | |
| 12 | a write with a `once` name has no early moments | **settled in use**: a named write can be refused, so it answers at its commit only | V5-11 ruling 6 |
| 13 | the partition function in the first build? | **closed**: in the API, built later; `{ before }` goes for `depth` | V5-12 pick 4 |
| 14 | the small names | **open** (5.2) | |
| 15 | V5-11's gap: an early answer, then a refusal that is not about the row | **open**, for the design: API 11.2 Q-B1 (5.2) | |
| 16 | who serves fero's own resources | **open**, for the design: API 11.2 Q-B3 (5.2) | |

Six closed, three settled in use, one in part, six open.

### 5.2 Still open

Each has a pick. 1 to 14 are the first tour's numbers, and 15 to 24 are API.md 11.1's new ones. 15 to 19 are choices the rewrite made; 20 to 24 are calls the two skeptics' findings forced.

- **1. `rows` for reads. What should `snapshot` be?**
  **Pick: `snapshot` keeps v4's meaning**, a whole frozen picture per access, at v4's cost; new code reads through `rows` or a handle. Then every `snapshot` in fero is a picture, and no v4 line changes its result. With the lens, both read only a whole resource held on purpose: a server's, or `hold: 'all'`'s. The other way makes `snapshot` a second name for the live `rows`: old lines get fast for free, but one word then means two things.
- **4, 5 and 12. Say yes, and both pages mark them closed**: `lens.set(fn)` (4), `changes()` as the name (5), and no early moments for a named write (12). The give-up after 8 tries stays a guess until a timed hot-key run (API 11.2 Q-B6).
- **6. What should a plain write do when the client is full** (512 waiting writes, or 64 MB)?
  **Pick: a verb's handle rejects `backpressure`, and an assignment throws it.** A marked write waits instead, as V5-12 says. An assignment has no handle, so a throw is the only way the code can know. The other way, one line on stderr, loses writes without telling the code.
- **7. Must some process say `server: true` to create a resource?**
  **Pick: yes, as v4.** One file run three times is a cluster, with no ceremony. The patterns keep that line in a server file. The other way: an admin act (`fero create shop`) founds the resource on the project's server machines, so that no app file can become a server by mistake. Safer, and one more step before the first line works.
- **11. `{ retry: true }` on a call: keep v4's cheap resend?**
  **Pick: yes, beside `once`.** They mean different things. Without `retry`, a call that is safe to run twice pays `once`'s three commits, or the app writes its own retry.
- **14. The small names**: `once`, `not-held`, `consumer`, `if: { lock }`, `copies` and `standbys`, `fero.of<Row>()`, `e.value`, a queue's `key`, `ping.ms`, `rendezvous` as a list, `handback.max`, `bulk.rate`. The lens's own names (`here`, `connect`, `at`, `depth`, `{ from: e }`, `marks`, `asOf`, `call`, `closes`, `scope`) came with V5-12's picks.
  **Pick: as written.** Any of them can be renamed; each is a one-word change.
- **15. `f.rows` on a client.**
  **Pick: only with `hold: 'all'`**, as LENS 2.2 writes it; a partition held by `here()` is read through its handle. The other way lets a live `f.data.here()` count too, since it also holds the whole resource on purpose.
- **16. The lens's config keys** (API 9).
  **Pick: `linger.ms`** as a process key, 1000 by default (a guess); **`views.client` and `views.max`** as resource keys, 16 and 1,000 (guesses). LENS names a linger and a cap, but no keys and no numbers. The cap's numbers should come from the first served view on the prototype (E-55 claim 27).
- **17. `bad-path` for a write above a row** (at the root, or on a partition at depth 2).
  **Pick: reuse `bad-path`**: in both cases a call was made on a path that cannot take it. LENS defines it for methods only; the other way is a code of its own.
- **18. `f.get(k)`, `f.data.snapshot()`, `view.snapshot()` and a token's `follow` claim go; `f.remove(path)` and `f.touch(path)` stay as array forms; `ctx.use(other)` stays.**
  **Pick: as API.md has it.** None of these is in V5-12's list. The read is a verb on the address, a view is read through its handle, and the claim is renamed `read` because `follow` is gone. A draft of the rewrite dropped `ctx.use` with derive's `out`; a skeptic found that no decision names it, and that without it a handler's writes to a second resource fall outside the `once` re-run rule and the caller's session. So it stays.
- **19. `changes()` on a lens below a partition.**
  **Pick: the partition's records cross (rule 4), and the reader gets only those under the lens.** The other way gives the whole partition's records.
- **20. A marked write with a `once` name.** API.md's types let `{ from: e }` take `if` and `ttl`, and refuse `once` (the first draft's types let it through by mistake; fixed, with lines that must fail). LENS 4.4 counted the mark as composing with `once` and `if`, at 0 to +2 rules.
  **Pick: not allowed.** A mark already makes the write count once per source record, for as long as the source keeps its log; a `once` name lasts only a day. That is the low end of LENS 4.4's row (reasoned). The other way allows both, and the leader checks both, in a stated order.
- **21. One source record with several marked outputs.** As LENS 2.8's rule is written, a second marked write of the same `e` to the same output slot would be skipped at the mark the first raised. And nothing commits a record's outputs together any more: the old `out` staged them into one entry, and separate marked writes do not. E-30's model sent one output per record and slot, so it never met this.
  **Pick: until it is modelled, one marked write per source record per target. Then: the mark also carries the write's number within its record**, so the leader skips only what it applied. The other ways: a `batch` that takes `{ from: e }` (it covers one partition, and a slot holds many), or a mark per output partition.
- **22. When is `asOf` built?** V5-12 counts it outside the first build's rules and gives it no slot.
  **Pick: after the first build.** It needs nothing from the kernel, so it can come at any time. (API.md's first draft had it in the first build, and LAYERS had it later; both now say later.)
- **23. Behind the door: `mark` and `claim`; and `touch` on a row only.**
  **Pick: a bare mark and a claim are writes**, so a client of a resource with methods has neither, and the typed client does not show them. **`touch` is on a row lens only**, since a ttl is a row's. LENS speaks to none of the three.
- **24. How `consumer().run()` restarts, and which name a mark goes under.** LENS 2.8 says `run` sends bare marks, but `run` has no target to send one to.
  **Pick: `run` restarts from its share's own cursor**, moved only once the marked writes up to it are answered, and sends no bare marks. **A mark goes under the name its reader was started with** (`marks(name)`, or the consumer's name), else under the target's own name. The other way gives `run` a target, as the old `out.use(target)` did.
- **Q-B1 (the first tour's 15). An early answer, then a refusal that is not about the row.** After a leader change, a resent plain write is judged again, and by then the write gate may be closed, a disk may be full, or the token may be revoked.
  **Pick:** through a closed gate or a full disk, fero keeps retrying, so the handle ends at the commit, a `timeout` or `unknown`. A revoked token is the one exception: the handle ends `forbidden`, because retrying cannot clear it and `unknown` would be false. **Decides:** E-48's model with a gate and a revoke.
- **Q-B3 (the first tour's 16). Who serves fero's own resources** (sessions, locks, sagas, calls, a queue), now that there is no project level?
  **Pick:** any process that serves a resource also serves the system ones; a library's resource takes `server: true` like any other. **Decides:** [LAYERS.md](LAYERS.md) section 10 item 5. No call changes with it.

API.md 11.2 lists seven more gaps of the design (Q-B2 and Q-B4 to Q-B9). None changes a call, and Q-B8 (who runs a `derive`) is closed by 2.10.

### 5.3 Still owed before the lens ships

From LENS 7 Q14 and V5-12's consequences, with API 11.2's additions. **Nothing here changes a line of the API unless it fails.**
- **The `view` selector in [E-31](experiments/E31-subscribe/README.md)'s model** (E-55 claim 22): failover, a reload, a slot move, a slow reader, a resume by a new picture, in at most 8 rules.
- **The 22 patterns end to end** (claim 25): E-22's prototype ported to the lens's spelling, 100 seeds each. API.md's lines compile; none ran.
- **A served view with its cap, on the prototype** (claim 27).
- **E-30's model with marks written by app code** (claim 21 is a seeded stand-in), with the leader's order rule per writer per output slot across a slot move, a source record with two outputs in one output slot (question 21), the name a mark goes under, and `run()`'s restart (question 24).
- **The pacing rule in a real client**: a marked write that waits, and a `changes()` reader that stops yielding.
- **A GET that carries the highest position seen, against copies that lag**, and rule Y for `get()`. The prototype had one server.
- **data's changes** (V5-12 pick 9): D1, the keyed index, needs a pin when it is built, since claim 8 sits at its bar (median 1.25 over 15 runs, the changed build's own 1.36, bar 1.3); D3 before small depth-2 partitions are cheap (claim 19); D4, since data's delivery is most of a tap's cost (claim 10).

## 6. Stated from reasoning; say if any is wrong

No experiment ran these. API.md marks each one.
- **When `await fero(name)` comes back.** A client, by default: once it has reached a server and learned the leaders. With `hold: 'all'`: once the first picture of every row has arrived. With no server up: after `connect.wait`, and then a sync read throws `not-held` until rows come (v4 printed `{}`).
- **"Now", for `changes()`, is the call**, not the first turn of the loop (Q-B7).
- **A size is a cache of pictures**, not subscribed, never read from (not built).
- **The cap on served views and its numbers** (not built: claim 27).
- **Two `here()`s in one scope ride one link** (LENS 2.6).
- **A method declared `at: 'any'`** runs at the partition's leader when called inside one partition, and on any server at the root (API's reading of LENS 2.4).
- **With two servers the second does not vote.** A server past `copies + standbys` (5) is a spare that holds no copy until healing gives it one.

**Follow-ups this pass leaves for other files.**
- **[LAYERS.md](LAYERS.md)** was rewritten for V5-12 on the same day; it carries what LENS 4.3 lists (its header table says where).
- **Done in the same commit series:** [DECISIONS.md](../DECISIONS.md) has the note "V5-12 amended" (the one miss is claim 11); [LENS.md](LENS.md) line 3 and [VERDICT.md](VERDICT.md) 11.7 now say the owner decided (V5-12) and the three pages were rewritten on 2026-11-18; LENS 2.8 points to API.md section 3.11 for how `consumer().run()` restarts (question 24).
- **The examples ladder.** Rungs 03, 04, 08, 10, 12, 13, 16 and 17 change their lesson, and so does every rung whose client reads rows, since a bare client now holds nothing (about 20 READMEs; API 5.1).
- **Owed tests**: `console.log(f.rows)` prints the rows (a bare `Proxy` would print `{}`); two pins on `f.rows.k`, one for a row already read and one for a row just written; and D1's pin.

## 7. How this page is checked

Every `ts` block on this page whose first line is `// file: <name>` is written to a fresh folder beside API.md's own `fero.d.ts` and `env.d.ts`, and type-checked with `tsc` against data's shipped types. API.md's `env.d.ts` gives the stand-ins (`el`, `ws`, `list`, `draw`). Each `@ts-expect-error` line fails the check if it ever compiles.

```js check
// API-TOUR.md checker: this page's "// file: <name>" blocks, type-checked with tsc against
// API.md's own fero.d.ts and env.d.ts, in a fresh folder. DATA names data's folder.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
const tour = process.argv[1]
const data = process.env.DATA ?? join(here, '../../../../../../data')
// a block may sit indented inside a list item: its own indent is taken off every line
const blocks = (file) => [...readFileSync(file, 'utf8').matchAll(/^( *)```ts\n\1(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)^\1```/gm)]
  .map(([, pad, body, name]) => [name, body.replace(new RegExp('^' + pad, 'gm'), '')])
const out = mkdtempSync(join(tmpdir(), 'fero-tour-'))
const files = []
const put = (name, body) => { writeFileSync(join(out, name), body); files.push(name) }
for (const [name, body] of blocks(join(dirname(tour), 'API.md'))) if (name === 'fero.d.ts' || name === 'env.d.ts') put(name, body)
for (const [name, body] of blocks(tour)) put(name, body)
const compilerOptions = {
  target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true,
  types: [], lib: ['es2022'], paths: { fero: ['./fero.d.ts'], data: [join(data, 'types/public.d.ts')] },
}
writeFileSync(join(out, 'tsconfig.json'), JSON.stringify({ compilerOptions, files }))
console.log(`${files.length - 2} blocks of this page → ${out}`)
execFileSync('tsc', ['-p', join(out, 'tsconfig.json')], { stdio: 'inherit' })
console.log(`ok: ${files.length - 2} blocks type-check (tsc ${execFileSync('tsc', ['-v']).toString().trim()})`)
```

Run from the repo root (`DATA` names data's folder; the default is this machine's):

```sh
node --input-type=module -e "$(awk '/^```js check$/{f=1;next} /^```$/{f=0} f' docs/v5-space/API-TOUR.md)" docs/v5-space/API-TOUR.md
```

**Result, run here on 2026-11-18, after the two skeptics' fixes** (Node v22.22.0, TypeScript 6.0.2, data at 63fea66): `ok: 14 blocks type-check (tsc Version 6.0.2)`.
- There are 7 `@ts-expect-error` lines: two in `address.ts`, one in `line.ts` and four in `methods.ts`. With all 7 stripped from a copy of the generated folder, tsc reports 7 errors, each at the stripped line and for the reason its comment gives: `await stock` used as a value, "Type 'Lens<number, …>' is not assignable to type 'number | undefined'"; `stok`, "Property 'stok' does not exist … Did you mean 'stock'?"; `shop.methods.sell(1)`, `stock.sell(1)` and `stock.set(4)`, "Property 'sell' (or 'set') does not exist"; `stock.call('sell', 1)`, "Argument of type '"sell"' is not assignable to parameter of type 'never'".
- **One fails for a reason the types cannot say in words**: a function left of `here()` fails with "This expression is not callable", as in API.md (its section 12).
- **One gap the first check found is now closed in API.md's types**: `lens.call(name, arg)` compiled for any method name on any lens. It now takes only the methods that kind of lens may call (2.8).
- **Not checked here: that any of it runs.** Nothing on this page is built.
