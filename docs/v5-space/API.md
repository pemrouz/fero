# fero v5: the public API

Rewritten 2026-11-16 for the design the owner chose ([DECISIONS V5-1 to V5-11][dec]; [VERDICT 11.7](VERDICT.md)). **Rewritten again 2026-11-18 around the connect lens** ([V5-12][dec]; [LENS.md](LENS.md)): a path is an address, and reads, live links, methods and server work hang off it.

**This page replaces COMP2's API** of 2026-11-11. Git history keeps that one, and the 2026-11-16 form of this page (`git log -- docs/v5-space/API.md`). COMP2 was the study's earlier pick: Raft groups owned by the project, a `#meta` group and one central loop. The owner set it aside (V5-2, V5-6).

- **What this page is.** What an app developer writes against fero v5, what each call promises, and what each call costs.
- **The design in one line.** A resource's truth is a log (V5-1). Each resource is its own small cluster, with its own Raft groups and its own settings in its own log (V5-2). Every write commits on disk at a majority before anyone can see it (V5-5). `data` folds the rows on every copy and on clients.
- **The shape in one line.** `shop.data.widgets.stock` is a **lens**: an address that does no work. The same address then reads once (`get()`), stays live here (`here()`), keeps a target up to date (`connect()`), writes (`set()`) and calls a method (`sell(1)`). The owner asked for this shape after reading the 2026-11-16 page. [LENS.md](LENS.md) took it from three proposals, [E-55] built it small on data's real engine, a skeptic reviewed both, and the owner approved all fourteen of LENS section 7's picks (V5-12).
- **The aim.** The owner asked for an API that is as easy to guess as it can be, and that costs nothing in speed: no hidden copies, trips, decodes or whole-resource work. [API-TOUR.md](API-TOUR.md) walks through the choices, for review.
- **For the layers under the surface:** [LAYERS.md](LAYERS.md) (LENS 4.3 lists what the lens changes there). **For what each path costs:** [PATHS.md](PATHS.md). **For the lens's own evidence:** [LENS.md](LENS.md) and [E-55].

**How each claim is marked.**
- **V5-n**: a decision in [docs/DECISIONS.md][dec]. **E-nn**: an experiment under [experiments/](experiments). **PATHS n**, **PA-n**: [PATHS.md](PATHS.md), a section or a finding. **LENS n**: [LENS.md](LENS.md). **MEMORY 9.n**: [MEMORY.md](MEMORY.md). **A-nn**: [AMENDMENTS.md](AMENDMENTS.md). **code:** a v4 file and line; **code data:** the sibling library at commit 63fea66.
- **E-55 claim n**: one of LENS section 6's 27 claims, measured on E-55's prototype (data 63fea66, Node 22.22.0, one box). Its costs are the lens's and data's share in one process, never a whole fero write: v4's issue path alone is 7.7 to 8.3 µs (PATHS 2.6). **E-55 review**: measured in the review pass, on the prototype as changed for the skeptic's findings. A timed E-55 number is the range over its runs; a verdict is the median of the runs against the bar (LENS 6).
- **SCHEDULE clause n**: a clause of `data`'s contract for when and how its sinks are called (its conformance suite). **rule Y**, **rule W1**: rules of [E-48]'s answer-stage model; each is said in plain words where it is used.
- **(proposed)**: new on this page. No experiment ran it. **(reasoned)**: an argument; nothing ran it. **(a guess)**: a number nobody measured.

**What comes when** (V5-5, V5-12).
- **Built first, in TypeScript:** everything here except the lines below. Every write commits on disk at a majority.
- **Built second:** the early answer stages, `received` and `replicated` (section 3.5). The write handle is there from the first build; until the stages are built, both resolve at the commit.
- **Built third, and only for a timed need the stages cannot meet:** a `memory` commit level per resource. It is not on this page. Nor is the no-disk kind of pub/sub (`durability: 'none'`). Both would be one resource key, and no call changes.
- **Built later, each when what it waits for exists:** work pushed below a partition (class B, section 3.10; V5-12 pick 2), the partition function (section 3.2; pick 4), a browser build in which a server role throws (section 3.8; pick 12), and `asOf` (section 3.12; pick 8). `asOf` is a reader library outside the first build's rule count (V5-12's consequences); no record gives it a build slot, so *this page's reading* puts it after the first build (section 11.1 question 22).

**How sure each part is.**
- **Type-checked here.** Every `ts` block whose first line is `// file: …` compiles with TypeScript 6.0.2 against data's shipped types. That includes all 22 patterns and the lines that must not compile. Section 12 has the command and the result.
- **Built small: the lens.** [E-55] built the lens, `here`, `connect`, `tap`, selections shared through a keyed index, a server in a worker and clients on real `MessagePort`s with resume, and methods on a path, in about 1,000 lines on data 63fea66. Of LENS's 27 claims, **10 pass, 10 pass in part, sit at the edge of their bar or are stand-ins, 1 misses, 3 are records with no bar, and 3 were not run** (LENS 6). Not run: the `view` selector in [E-31]'s model (claim 22), the 22 patterns end to end (claim 25), and a view served by a method, with its cap (claim 27).
- **Run on a prototype, under the earlier spelling.** [E-22] ran all 22 patterns on five kernel operations, with a leader change and a slot move forced into each. This page respells them for the lens; the respelled lines did not run.
- **Model-checked.** The rules under the surface: subscribe ([E-31]), retries ([E-20]), sagas ([E-24]), derived outputs ([E-30]), answer stages ([E-48]), founding and finding a resource ([E-51]), healing ([E-52]). The lens adds rules none of these models has run: the `view` selector, and marks written by app code (section 11.2).
- **Measured.** The costs are [PATHS.md](PATHS.md)'s and the experiments'. Most whole-path totals there are sums of measured parts. No v5 server was timed end to end (PATHS 8).
- **Read by a skeptic.** The 2026-11-16 page had 31 findings, all applied. LENS.md, E-54 and E-55 had 24 more, all applied there and carried here. This rewrite, with LAYERS.md's and the tour's, was read by two skeptics (20 and 21 findings; many the same); each one that held is applied, and the design calls they forced are questions 20 to 24 of section 11.1.
- **One correction to the decisions record.** V5-12's context line named E-55's one miss as the `Proxy` step (claim 1). LENS 6 and E-55 count claim 1 as a pass in part, and **claim 11** as the one miss: 10,000 weak links cost 2.2 times 10,000 strong sinks, against a bar of 1.1. This page follows LENS and E-55, and so does the note "V5-12 amended" appended to [DECISIONS.md][dec].
- **Nothing here is built.**

## 1. Words and layers

**Five words are enough to start.**

| Word | What it is |
|---|---|
| resource | a named, shared map of rows: `fero('shop')`. Every process that opens the name sees the same rows. Underneath it is a small cluster of its own (V5-2) |
| row | one entry of the map: a key and a JSON-like value. It has its own version, expiry and conditions |
| partition | the rows that one leader keeps in one order and can change together. The first key of a path is always the partition. By default each row is its own partition |
| path | an address inside a resource: `shop.data.widgets.stock`. Building one sends nothing and reads nothing. fero calls it a **lens** |
| method | a function the resource's servers host. When `methods:` is declared, clients change rows only by calling them |

**Words you meet later.**

| Word | What it is |
|---|---|
| server, client | a **server** holds a copy of the resource and can lead part of it. A **client** only uses it. The role is per resource and comes from what the open declares (section 3.1) |
| copy | a server's full replica: the log on disk and every row in memory |
| leader | the one server that puts a partition's writes in order and judges them |
| commit | a write is on disk on most of the copies (a majority). Only then can anyone see it (V5-5) |
| stage | how far your own write has got when you hear back: `received`, `replicated`, then committed. A stage changes nothing the servers do (V5-11) |
| step, verb | a **step** is one property read on a lens (`.widgets`). A **verb** is a call on a lens (`.set(4)`). A name is a key until it is called |
| link | one live connection from a lens to this process: a `here()`, a `tap`, or a `connect` to a target. It ends at `close()`, with its scope, when its target closes, or when nobody uses it |
| held on purpose | rows this process keeps because it serves the resource, because it said `hold: 'all'`, or because a live `here()` or `tap` names them. Only these serve a read here |
| picture | the rows a link selects, at the moment it starts |
| view | a live result computed from rows: `room.gt('stars', 0)` |
| version | a row's place in its partition's order. Opaque text. A write's answer gives it; `if: { version }` takes it |
| cursor | a reader's place across many partitions. Opaque text you can save |
| writer time | the leader's clock, held to the median of the members' clocks, never going back. TTLs, leases and delays use it (V5-4) |
| trip | one message there and its answer back (a round trip). On one box about 40 µs at the median ([E-01]) |
| the collector, the net | JavaScript's garbage collector. **The net** is the collector as the last way a link ends, when nothing else did. Nothing a program can see depends on it (section 3.10) |

**Words inside fero.** An app never names these. They show in `f.cluster`, in the debugger and in [LAYERS.md](LAYERS.md): **slot** (one of a resource's 4,096 fixed hash buckets; a partition hashes to one), **group** (one Raft log with one leader, holding some slots), **attempt** (one write and its retries), **session** (one process's life, held by a lease it renews by itself; it is what `while: 'session'` rows die with), **fold** (`data` applying the log's records to the rows in memory), **SUB** (v5's one subscribe message: a selector, a mode and a cursor; LAYERS 4; in **state mode** it sends rows and then their changes, in **log mode** it sends records), **GET** (one read message), **frame** (one message on a link: the writes one turn of the event loop made for one leader, or one commit's records on their way to a reader), **share** (a part of a source's partitions that one consumer owns at a time), **the tier** (older log kept in the object store; not in the first build), **selection** (what one SUB brings into a process: a partition, the whole resource, or a served view; equal lenses share one).

**The layers** are [LAYERS.md](LAYERS.md)'s. **L0** storage and I/O. **L1** the log: Raft per group, founding, the directory, healing. **L2** fold and ops: records to rows, conditions, ops, marks, writer time, retries, expiry, answer stages. **L3** flow: SUBs and the selections they bring (`here`, `tap`, `connect`), `changes`, cursors. **L4** the surface: `fero()`, the lens and its verbs. With the lens, L4 gains its first rules of its own: the lens, links, counts, the net, what "held on purpose" means (LENS 4.3). **L5** libraries, built only from L4: queue, lock, consumer, derive, saga, limiter, service, migrate, tape, the gateways and the CLI.

## 2. The shape on one screen

```ts
// file: shape.ts — the whole surface on one screen (a server file and a client file)
import { fero, op } from 'fero'

// ── server.ts: a seed and methods make a server
const shop = await fero('shop', {
  data: { widgets: { stock: 10, price: 5 } },
  methods: {
    sell: { at: 'row', run: (n: number, ctx) => ctx.at.stock.set(op.incr(-n, { min: 0 })) },   // called on a row
    low: (max: number, ctx) => ctx.data.lt('stock', max),                                        // the root only: a view
  },
  history: '1h',
})
export type Shop = typeof shop                           // the client imports this type, never the handle

// ── client.ts: `import type { Shop } from './server.ts'`
const client = await fero<Shop>('shop')                  // a client. It holds nothing yet
const stock = client.data.widgets.stock                  // steps: an address. No trip, no read. Not a promise
const n = await stock.get()                              // read once: here if held on purpose, else one trip. Keeps nothing
await client.data.widgets.sell(1)                        // a method on a path: runs at widgets' leader
const live = client.data.widgets.here()                  // hold it here, live: one SUB, shared by equal lenses
await live.ready
console.log(n, live.value?.stock)                        // a sync read of what is held: one lookup
const label = stock.connect(el, 'textContent')           // el.textContent is kept up to date, until close() or its scope
const low = client.methods.low(5).here()                 // a view the server named; only its changes cross
low.tap((c) => render(c.now.rows))                       // one call per commit, by reference
for await (const e of client.data.changes({ from: 'earliest', until: 'latest' })) console.log(e.version, e.rec)
live.close(); low.close(); label.close()                 // links end at close(), a scope, their target's close, or a count

// ── writes: on a server, or on a client of a resource with no methods (V4-5: methods are the door)
const w = shop.data.gizmos.set({ stock: 7, price: 9 })   // a write: it shows when it commits (V4-7)
await w.received                                         // optional: the leader has it (a progress report)
const ack = await w                                      // committed: on disk on a majority, visible to all
const sold = await shop.data.widgets.stock.set(op.incr(-1, { min: 0 }))   // the leader computes it
console.log(ack.version, sold.value, shop.rows.widgets?.stock)             // rows: the hot sync read, one lookup
```

**Where each kind of line runs.**

| What you write | Where it runs | What it costs |
|---|---|---|
| a step: `f.data.a.b`, or `f.at(a, b)` | **nowhere.** It builds an address | no trip and nothing kept: 0 to 0.3 B a key; 49 to 99 ns a step with one key (E-55 claims 1, 2) |
| a sync read: `f.rows.k`, `held.rows.k`, `held.value`, a view right of `here()` | **here**, on rows held on purpose. It never leaves this process | no trip, no disk, no copy |
| a read you `await`: `lens.get()` | **here** if its partition is held on purpose; else at a copy (`fresh`: at the leader) | held: no trip. Else one trip, and nothing is kept |
| a change: `lens.set(v)`, `f.set(path, v)`, an assignment, a method | **at the partition's leader.** It is sent whether you `await` it or not; `await` only chooses when you hear back | one trip, and one shared disk sync on a majority |
| a link: `here()`, `tap`, `connect` | **at a copy**, from the moment of the call; then here, for every change | one SUB, shared by every equal lens in this process; the partition once, then its changes |
| a log reader: `lens.changes()` | **at a copy**, from the call | one trip to open, then every record of the selection |

**Seven rules a user learns** (LENS 2.0).
1. **A path is an address.** Building one sends nothing and reads nothing. It is not a promise: `await lens` gives the lens back.
2. **`get()` reads once. `here()` keeps it live. `connect(target, …)` keeps it live for the target.**
3. **Left of `here()`: plain data, and it may run on a server. Right of it: your code, here.**
4. **The wire sends whole partitions.** Hold anything inside a partition and you hold that partition (first build).
5. **A link ends at `close()`, with its scope, when its target closes, or when nobody uses it. You read what is held through what `here()` gave you.** A `connect` never makes rows readable.
6. **A `connect` function takes its target as an argument and changes nothing else.** Anything else belongs in `tap`.
7. **A method says where it may be called (`at:`), and checks what it is given.** A client picks the path and the argument.

**Still true from the page before.**
- **Anything that changes data, or opens a link, sends a message.** `await` does not send it; it only waits. **Awaiting a write's handle means committed**: one trip to the leader and a share of one disk sync, about 1 ms on one box (MEMORY 9.3, computed from [E-02]). The handle's `received` and `replicated` are earlier progress reports for the few who want them (section 3.5).
- **Make writes together, a few hundred at a time.** They leave in one frame, share disk syncs and keep their order within a partition (PATHS 3.6; A-10). A client may hold 512 waiting writes; past that the next plain one is refused `backpressure` (section 3.6).
- **Only a line you wrote walks a whole resource:** `hold: 'all'`, `f.data.here()`, listing `f.rows` or `f.snapshot`, `f.data.changes({ from: 'earliest' })`, and `f.data.asOf(…)`. Nothing else decodes, copies or walks every row.
- **A resource is a table, not a row.** Each one is a small cluster. Users and orders are rows of one resource, not a resource each (V5-2).

**Three places, one job each.** `f.data` is the address of everything: steps, reads, links, writes and calls on a path. `f.rows` is the hot sync read of what this process holds for the whole resource. `f.methods` holds the calls with no path.

## 3. Using it, and what each call costs

### 3.1 Opening a resource: `fero(name, opts)`

```ts
// file: open.ts — roles by declared act, as in v4
import { fero } from 'fero'

const a = await fero('shop', { data: { widgets: { stock: 10 } } })   // a server: it brings the first rows
const b = await fero('shop', { methods: { ping: () => 'pong' } })    // a server: it hosts methods
const c = await fero('shop', { server: true })                       // a server: said plainly
const d = await fero('shop')                                         // a client: nothing but the name. It holds nothing
const e = await fero('scratch', { listen: false })                   // a solo node with no socket, for tests
console.log(a.name, b.name, c.name, d.name, e.name)
```

- **One call opens or creates.** The first server to open a name founds the resource. Later opens join it. There is no "create" call, as in v4.
- **A process that brings something serves.** A seed, `methods` or another code key, `listen`, `dir` or `server: true` make a **server**. A bare name is a **client**. This is v4's rule (code: api/index.ts; README "Roles").
- **The role is per resource** (V5-2 point 4). One process can serve `totals` and be a client of `orders`. `server: false` pins the client role.
- **A resource exists once a server opens it.** Until then a client's writes wait as `pending` rows of `f.cluster.writes`, as in v4's rung 03.
- **Three servers of one name are a cluster of three**, as in v4's rung 13 (rung 01 is two). Each stores the log, keeps every row in memory, and can be elected leader of some partitions (V5-2, V5-6).
- Ctrl-C is a clean stop (V4-8). `fero.spawn` stays (V4-9).

**When `await fero(…)` comes back** *(stated here; reasoned from v4's rung 03 and section 3.9's "never guesses")*.
- **A server:** once it holds the log and has folded it.
- **A client, by default:** once it has reached a server and learned the leaders. No rows come: a client holds nothing until a `here()` or a `tap` says what (V5-12 pick 1).
- **A client with `hold: 'all'`:** once the first picture of every row has arrived and is folded. So a sync read of `f.rows` on the next line is right. At 1,000,000 rows that is seconds (the table below).
- **No server answers:** the open waits `connect.wait` (10 s), prints who is missing, and then resolves all the same. Writes made on that handle wait as `pending`; a `get()` waits; a sync read throws `not-held` ("no server of 'shop' reached yet") until the first picture comes. It never reads as an empty resource. (v4's rung 03 prints `{}` here; that line changes.)

**A server role is real work. Give it to a server process, not to every app process.**
- A server of a resource copies and folds its whole log, keeps a `dir` and syncs it, votes or stands by, takes the per-resource budget (about 8 KB idle, V5-8), and leaves the cluster on Ctrl-C.
- So the code that **creates** a resource (`server: true`, a seed, `methods`) belongs in the few processes meant to hold it. App code that only reads and writes opens the bare name, which holds nothing until a line says what (section 3.3). Section 10's patterns are written that way: a server file, then the app's lines.
- **Open for the owner:** creating a resource needs a server role in some process, because a resource is its own cluster and there is nowhere else to keep it (V5-2). The other way is an admin act (`fero create shop` on the CLI) that founds it on the machines that serve the project, so that no app file ever says `server: true`. See [API-TOUR.md](API-TOUR.md) section 5.

**What `await fero(…)` costs.**

| Case | Cost | Source |
|---|---|---|
| the first server of a new name (it founds the resource) | one create-if-absent in the store and one disk sync: about 5 ms on one box, about 35 ms across machines, once per resource for ever. The other copies join in the background | [E-49]; PATHS 5.11; V5-10 fix 1 |
| a server joining a resource that exists | it copies the log it lacks, then folds it: 1.3 to 3 µs a small row | PATHS 2.1, 5.1 |
| a client, cold (the default holds nothing) | 2 to 3 trips and one commit when built well (7 to 9 trips and two commits as first drawn). A cold browser made its first committed write in 13 to 17 ms. Nothing more until a `here()`, a `tap` or a `get()` | PATHS 3.2 (PA-21); [E-40] |
| a client with `hold: 'all'` | also one picture of every row: its bytes on the wire, and a decode and a fold of each row here. **Then every later write to the resource is sent here too**, for as long as the handle is open | PATHS 4.5; section 3.3 |
| each resource a server holds, idle | about 8 KB of memory, about 30 KB in the first minute after a boot; no frames, no CPU that could be measured | V5-8; [E-49] |

So: **open a resource once, at start-up, and keep the handle.** `fero('doc:' + id)` would found a cluster per document. Use one `docs` resource, with a row or a partition per document (section 3.2).

**The options: ask of each one, who remembers it?**

| Scope | Who remembers | When it can change | Examples |
|---|---|---|---|
| **this process** | this process only | restart it | `listen`, `dir`, `rendezvous`, `secret`, `memory`, `linger` |
| **the resource** | the resource's own log, so every copy and client agrees (V5-2) | `fero.alter(name, change)`, online; `depth` and the partition rule never | `depth`, `history`, `rows`, `copies`, `methods`, `validation`, `views` |
| **this open** | nobody: it is how this open behaves | the next open | `server`, `hold` |

- The open that founds the resource writes the resource options into its first log entry, with the seed (V5-10 fix 5). A later open that passes a different value is refused `config-differs`, and the hint names the key, both values and the `fero.alter` call. An open that leaves a key out takes the stored value.
- v4 does the same thing at the link: two servers whose values differ refuse to link and name the key (README, "The table").

### 3.2 Partitions: the first key, and `depth`

A **partition** is the unit of order. One leader puts all the writes of a partition in one order, and a `batch` can change several of its rows at once. Across partitions there is no order, ever. **The first key of a path is always the partition** (V5-12 pick 4). `depth` says where the row begins.

```ts
// file: partition.ts — where a row begins; the first key is always the partition
import { fero } from 'fero'
type Msg = { text: string; at: number }

const users = await fero('users', { server: true })                  // depth 1 (default): users.data.u42 is a row, and its own partition
const chat = await fero<Msg, 2>('chat', { server: true, depth: 2 })  // chat.data.room1 is a partition; chat.data.room1.m7 is a row
await chat.data.room1[fero.id()].set({ text: 'hi', at: fero.now() }) // a row write. No key string to build or split
const room = chat.data.room1.here()                                  // one partition, held live
console.log(users.name, room.rows)
```

| Form | Who can route by it | Cost |
|---|---|---|
| **`depth: 1`** (default): each row is its own partition | everyone: a hash of the first key | none: a hash per write, nothing stored |
| **`depth: 2`**: the first key is the partition, the second the row | everyone: a hash of the first key, with nothing to learn. It is plain data, kept in the resource's log, so a browser knows it too | a key grows by 2 B. **Partitions of 100 to 10,000 rows:** the fold costs 0.78 to 1.10 times a flat store with PA-17's index from partition to rows, and each partition takes 1.2 KB to 805 KB **less** memory than that index; a 100-row room's first picture takes 0.012 to 0.017 ms at 100,000 to 1,000,000 rows in all. **One-row partitions:** about 0.9 KB more each and 1.3 to 1.5 times the fold, because today's data makes each partition a data source of its own; data's two-level store (D3, LENS 4.5) is what makes them cheap (E-55 claim 19) |
| **a function of the row key** (V5-2), **built later** (V5-12 pick 4) | servers, and any client that passes the same function | the function runs on every write and keyed read, in the process that makes it: keep it pure, sync and cheap. A process **without** it cannot find the leader, so its writes take the forward path: **one more trip each** (V5-9; reasoned, no experiment ran a function). Every copy keeps PA-17's index from partition to rows |

- **Why the second level is a row, not a field** (LENS 1.1). With one level, `chat.data.room1.m7` would be a field of the row `room1`, and a message as a field loses what a row has: its own version and conditions (`if: { absent }` on one message), its own `ttl` and size limit, early answer stages, `e.value` in `changes`, and views over it. A field write also copies its room on every copy and every client: 0.43 ms at 1,000 messages and 3.6 ms at 10,000 (measured in LENS's facts brief; code data:kernel/node.ts:275-291).
- **Why not two levels always.** Then `users.data.u42.name` would be a row, and a user could not be read, expired or versioned as one thing (reasoned).
- **Every process routes by hashing the first key**, as fero v2 did (code v2:partitions.js:20-22). A `{ prefix }` walk of partition names is gone with `{ before }`: with `depth: 2`, a cart, a room or a thread is a partition you name.
- **The partition rule is fixed when the resource is founded.** Changing it would move rows between orders (reasoned, from V5-2's rejection of a changing `% N`).
- **The number of partitions is free.** Use as many as you like.
- **One partition is one leader's work.** Every write to it is judged in one place. A partition busier than one leader can serve must be split by the app ([E-18]).
- **A row write** at 100,000 to 1,000,000 rows in all costs data 2.0 to 3.4 µs flat and 2.1 to 3.9 µs at depth 2 on E-55's box (claim 19): the same, within the noise.
- **The function form** is for partitions a key level cannot say (`'report-7.acme'` belongs to `acme`). A function is code, and code cannot travel: every server must pass the same one; fero compares its text, as it does for `validation`, and a different text is refused `config-differs`.
- Use `depth: 2` for rooms, carts, threads and tenants: a partition per thing, a row per item. It covers all 22 patterns (section 10).

### 3.3 `hold`: what a client keeps

```ts
// file: hold.ts — what a client keeps in memory
import { fero } from 'fero'
type User = { name: string }

const users = await fero<User>('users')                    // the default: it holds nothing
const all = await fero<User>('users', { hold: 'all' })     // every row, kept live: one picture, then every write
const warm = await fero<User>('users', { hold: '200MB' })  // a cache of pictures of closed selections
const me = users.data.u42.here()                           // now u42's partition is held on purpose
await me.ready
console.log(me.value?.name, all.rows.u42?.name, warm.name)
me.close()                                                 // after the linger, the unsubscribe is sent
```

- **A client holds nothing until a `here()` or a `tap` says what** (V5-12 pick 1). It then holds on purpose exactly what its live `here()`s and `tap`s name, for as long as they live. Every download is a line you wrote.
- **`hold: 'all'`** (v4's behaviour, now an option). The open sends one picture of the whole resource, **and then every later write to it, for as long as the handle is open.** `f.rows`, `f.snapshot` and operators over every row then work here. Cost: the resource's size in bytes, memory and decode time, once; then a decode and a fold here for every write anyone makes. At 1,000,000 small rows the first fold alone is seconds of this process's main thread (computed from PATHS 2.1). `f.data.here()` holds the same rows, said as a line, with a handle you can close. You read them through that handle (`all.rows`), and operators over every row go right of it (`all.gt(…)`). `f.rows` and `f.snapshot` stay for a server and for `hold: 'all'` (section 3.9; question 15).
- **`hold: '200MB'`, a size, is a cache of pictures, not a subscription** (LENS 2.2; review F14; reasoned, not built). When the last link on a selection closes, the unsubscribe is sent after the linger, as always. Inside the bound, the rows stay in memory, least recently used first, with the server position they were good at. They are **not held on purpose**: no read is served from them. A re-open sends that position. If the server can still resume from it (its ring of recent frames, or the log when the resource has `history`), only the changes since cross. If not, a new picture crosses. So a re-open is a resume or a download, never free, and nothing crosses while it is closed.
  - The other choice, staying subscribed while warm, would have the server send, and this process decode and fold, every change to every warm partition for nobody; the bound would then have to cap bytes a second too (LENS 2.2).
- **A `get()` never holds** (section 3.9). It reads once.
- **A server holds every row** of the resources it serves (V5-6: `data` folds on every copy), as a voter or a standby. That is true for the first `copies + standbys` servers of a resource: 5 by default.
  - **A server past that number is a spare** *(this page's reading of LAYERS 8.4 and PATHS 4.4, which names the `moved` round trip "with more servers than `standbys`")*. It holds no copy until a leader's healing places one on it. Until then its reads behave like a client's. What a spare does with a method call is not written; LAYERS owns it.
- At 80 % of the process's `memory`, health warns and names the fix: close links, or give `hold` a smaller size.
- `hold: 'asked'` is gone: what it did, hold only what you asked for, is now the default, with nothing kept after a `get()` (section 5.5).

**Copies.** `copies: 3` (1, 3 or 5) is how many copies' disks decide a commit; the default is 3 once three servers exist, and 1 until then. With two servers, the second is a full copy that does not vote: two voters would stop writing when either one died *(this page's reading; LAYERS 8.2 step 9 agrees: a group grows from one voter to three only once two others can join, and a lone second server stays a learner)*. `standbys: 2` adds full copies that do not vote, so more servers read every row locally. Each leader heals its own group: when a copy dies it places a new one on a quieter machine (V5-2; V5-10 fixes 6 to 8). There is no call for it.

### 3.4 Writes

| Form | What it is | Answer |
|---|---|---|
| `f.data.k.set(row)`, `f.data.k.stock.set(4)`, `f.data.k.remove()` | **the path write: the main spelling.** The address is one thing and the verb another, so a component handed `stock` can write it without knowing where it sits | the handle (section 3.5) |
| `f.set([k, 'stock'], 4)`, `f.remove([k])` | the same write as an array: the plain call every other form turns into. No `Proxy`; `ctx.set`, `batch` items and libraries use it | the handle |
| `f.at(k, 'stock').set(4)` | the same lens with no `Proxy`, for computed keys and hot loops (section 3.9) | the handle |
| `f.data.k = row`, `f.data.k.stock = 4`, `delete f.data.k` | on an **untyped** handle: the same write, with no answer wanted | none. It shows when it commits (V4-7). A refused one never shows: it is a `refused` row of `f.cluster.writes` and one stderr line. If this client is full, the assignment itself throws `backpressure` (section 3.6) |
| `f.batch([...])` | several changes to **one partition**, all or none | one handle, at the commit |
| `f.data.k.sell(arg)`, `f.methods.name(arg)` | your function on a server (section 3.8) | its return value, after its writes commit |

- **Three spellings, one record.** Assignment, `lens.set(v)` (and `f.at(…).set(v)`) and `f.set(path, v)` make the same record on the same path: one ASK, encoded once at the issuer (PA-13). "Assignment is `set` without the answer."
- **Typed code writes with `set`** (V5-12 pick 6). TypeScript cannot give a property one type to read (a lens) and another to write (a value); [E-55] tried four ways (claim 5). Assignment still works when run, and compiles on an untyped handle.
- **`f.data.set(k, v)` is gone** (V5-12). It was a third name for the same write. v4's other lens calls go with it: `f.data.k.update(v)` is `f.data.k.set(v)`, and `f.data.patch(pairs)` is one `set` per pair. `f.data.k.remove()` stays: it is the lens verb `remove`.
- **A typed client of a resource with methods has no writes** (V4-5, now in the types): no `set`, `remove`, `touch` or `batch` on its lenses or on its root, and no `mark` or `claim` (a bare mark writes the resource's marks, and a claim leases rows; *this page's reading*, question 23). Untyped code that writes anyway is refused `methods-only` when run, and the hint lists the methods.
- **`touch` is a row's verb.** A ttl and a lease belong to a row, so a field lens has no `touch`, as `f.touch(path)` takes a row's path.
- **A write needs a row.** The root, and a partition at depth 2, are not rows: the types offer no `set` there, and untyped code is refused `bad-path`.
- **What the lens adds to a write** (E-55 claim 3, over `f.set([k, 'n'], v)`, a local data write of 0.7 to 1.3 µs): with two steps +0.18 to +0.73 µs (medians 0.31 to 0.47 by size); a kept lens −0.03 to +0.42 µs (medians 0.16 to 0.28); `at()` about 0. Keep a lens you write often: `const stock = shop.data.widgets.stock`.
- **Two writes are two records.** `a.b.c.set(v)` then `a.b.d.set(w)` commit in that order when `a` is the partition; all or none takes a `batch`.

**The write path** (PATHS 3.1, with V5-9's direct routing):
1. Here: the value is checked and encoded **once**. Those bytes are kept for resends and are what every link, journal and follower carry. No deep copy (PA-13).
2. One trip to the partition's leader. A client learns the leaders from the resource itself, and hashes the path's first key, so it sends there directly (V5-3, V5-9).
3. The leader judges the write, appends it, and sends it to the other copies.
4. A majority writes it to disk. One disk sync covers every write that arrived while the last sync ran, for every resource in that process ([E-12]).
5. The answer comes back. Every copy folds the write. Now readers can see it.

That is **2 trips and 1 disk sync on the path, the least any correct design can do** (PATHS 0). On one box, in TypeScript: 0.97 ms at the median, 4.45 ms at p99 (MEMORY 9.3).

**fero retries by itself**, and an attempt commits at most once ([E-20]). An app never resends a write. To make a write safe to send again from another process, give it a name: `f.data.k.set(v, { once: 'import-7:row-3' })`. A second write under that name within a day gets the first answer. A named write costs one commit, plus about 221 B at the leader for its day; and it answers at its commit only, because the name may already be taken (section 3.5).

### 3.5 What a write gives back: the handle and its stages

`lens.set`, `lens.remove`, `f.set` and `f.remove` return a handle, not a bare promise (MEMORY 9.6; V5-5, V5-11). **Await the handle and you get the committed answer, always.** Code that never reads further is always safe.

The handle also has the two earlier stages as properties. You pick a stage by what you await. No option changes what the servers do.

```ts
// file: stages.ts — one write, three moments
import { fero, FeroError } from 'fero'

const clicks = await fero<{ n: number }>('clicks')        // a client: it holds nothing, and only writes
const w = clicks.data['page-1'].set({ n: 1 })             // the write leaves with this turn's frame
const r = await w.received                                // the leader put it in its log (memory only)
const m = await w.replicated                              // a majority handed it to their operating systems
const ack = await w                                       // committed: on disk on a majority; readers see it
console.log(r.stage, m.stage, ack.version)
w.catch((e: FeroError) => console.log(e.code, e.outcome))
```

| You await | What is true | What can still lose it | Time, p50 / p99 |
|---|---|---|---|
| `w.received` | the leader appended it | a leader crash. The client still has it and sends it again by itself | 0.15 / 0.20 ms |
| `w.replicated` | a majority gave it to their operating systems | a power cut on that majority. Any process crash is survived (V5-11 ruling 5) | 0.36 / 0.69 ms |
| `w` | committed: on disk on a majority; every reader sees it | nothing short of losing a majority's disks | 0.97 / 4.45 ms |

Times: TypeScript, one box, 50,000 writes a second (MEMORY 9.3, computed from [E-02]'s measured stages).

**The rules** (V5-11; [E-48]):
- **An early stage is a progress report, never a promise.** It has no version and no value: `{ key, attempt, stage }`. Only the committed answer has a `version`.
- **Nobody sees the write before it commits.** Not even you, in a sync read (V4-7). A `get()` waits for your own early-answered writes first ([E-48]'s rule Y).
- **Only a write that cannot be refused on state has early stages** (ruling 6). That is a whole-row `set` or `remove` with no `if`, no `once` and no `from`. An op, a condition, a field write (it can be refused `absent-row`), a write with a `once` name (the name can be taken: `call-diverged`, `too-many-keys`), a marked write (`{ from: e }`: it can be skipped at its mark), `set(fn)`, a `batch` and a method call answer at the commit only. The types say so: those return a `Judged`, which has no `received`. On a resource with `rules.write`, a plain write's early stages resolve at the commit, never before (reasoned: the types cannot see that key).
- **A stage the write never reached rejects with the write's own error** (MEMORY 9.6). A plain write can be turned away before the leader appends it: `methods-only`, `invalid`, `schema`, `forbidden`, `too-large`, `backpressure`, a closed gate. Then `w.received`, `w.replicated` and `w` all reject with that one error. Nothing is left waiting.
- **Once a stage has resolved, the handle never ends in a refusal.** It can still end in `timeout` or `unknown`, if the write can never commit. Section 11.2's Q-B1 has the three cases the records leave open. A failure nothing handles prints one stderr line, never Node's crash (MEMORY 9.6).
- **Ask in the turn that makes the write.** The leader sends an early report only for a write that asked (PATHS 3.3). Reading `w.received` is the asking. Read later, it still resolves, but maybe not before the commit (reasoned).
- **Early answers stay fast only while your unfinished writes fit your credit.** Past the number of writes a client may have in flight (A-07), the next early answer waits for an older commit (MEMORY 9.3).
- fero's own locks, sagas and queues never act on an early answer ([E-48]'s rule W1).
- **It costs nothing unless used.** A promise is made only for what you await (PA-13). The servers send no report nobody asked for.
- **The lens changes none of this.** `lens.set(v)` and `f.set(path, v)` make the same record and return the same handle; the types know where a lens points, so only a row lens's plain `set` offers `received` (E-55 claim 5).

**Against v4.** v4's `{ confirm: 'committed' | 'replicated' | 'persisted' }` changed how far the write had to get. In v5 every write goes all the way; you only choose when to stop waiting. v4's words would also mislead now: v4's `committed` was its weakest answer and `replicated` a stronger one (code: api/types.ts:10-16); in v5 it is the other way round. So the option goes and the handle comes.

### 3.6 Many writes: sending them together is the default

```ts
// file: many.ts — make the writes, then await them together
import { fero } from 'fero'
type Reading = { c: number }
const temps = await fero<Reading>('temps')                                     // a client: it holds nothing
const rows: [string, Reading][] = [['a', { c: 20 }], ['b', { c: 21 }], ['c', { c: 19 }]]

const acks = await Promise.all(rows.map(([k, v]) => temps.data[k].set(v)))    // one frame per leader, shared disk syncs

for (const [k, v] of rows) await temps.data[k].set(v)                          // slow: one commit after another

for (let i = 0; i < rows.length; i += 256)                                     // a bulk load: 256 at a time
  await Promise.all(rows.slice(i, i + 256).map(([k, v]) => temps.at(k).set(v)))   // at(): no Proxy in a hot loop
console.log(acks.length)
```

- **Writes made in one turn of the event loop leave in one frame per leader** (PATHS 3.6; v4 does it today, code: shell/runtime.ts:801-863). At the leader they share log entries and disk syncs: about 62 records per sync at 50,000 writes a second ([E-02]).
- **Order is kept without awaiting.** One process's writes to one partition commit in the order it made them (A-10).
- **`await` in a loop is the one slow shape.** Sixteen writes awaited one by one take about 15.5 ms; made together, about 1 ms (PA-40, computed).
- **There is a limit, and it is loud.** A client may have a granted number of writes in flight (its credit, A-07). On top of that it holds at most **512 waiting writes, or 64 MB** (LAYERS 4.2). Past that:
  - a plain `set(…)` returns a handle that rejects `backpressure`, with `retryAfter`. So a `Promise.all` over 5,000 rows rejects.
  - **An assignment throws `backpressure`, there and then** *(proposed; the 2026-11-16 skeptic's finding)*. An assignment has no handle, and fero cannot retry a refusal from its own queue. A stderr line alone would have dropped the write without the code knowing.
  - **A marked write (`{ from: e }`) is never refused `backpressure`** (V5-12). It waits in line, and the `changes()` reader its `e` came from stops yielding until the line is short again. Without this, a loop that does not await would never see the refusal, a later write to the same output slot would move the mark past the dropped record, and that record would be lost for good (section 3.11; E-55 review: 998 of 1,000 seeds lost outputs as written, 0 of 1,000 paced).
  - So **a bulk load goes in chunks of a few hundred**, each awaited: the third form above. Each chunk still leaves in one frame per leader.
- **`batch` is not for speed. It is for all-or-none.** All its changes must be in one partition, or it is refused `cross-partition`. It is one log entry: every change commits or none does.
- **Across partitions** there is no all-or-none write. `saga()` is the unit there: 6 to 7 commits in a row, about 7 ms, and readers may see half of it (PATHS 3.7; [E-24]).

### 3.7 Writes the leader judges: ops, conditions, and `set(fn)`

A read-then-write done in your code has a gap between the two, and another writer can slip into it. v4's example 17 shows the lost increment. In [E-22], a plain read then a plain set sold the last item twice in 120 of 120 races. In v5 the leader can close the gap for you, three ways.

```ts
// file: judged.ts — let the leader decide
import { fero, op } from 'fero'
type Item = { stock: number; price: number }
const parts = await fero<Item>('parts')                                       // a client of a resource with no methods

const sold = await parts.data.widgets.stock.set(op.incr(-1, { min: 0 }))     // an op: refused 'conflict' at 0
const made = await parts.data.gizmos.set({ stock: 1, price: 5 }, { if: { absent: true } })   // a condition: create only
const up = await parts.data.widgets.set((w) => w && w.price < 12 ? { ...w, price: 12 } : undefined)   // read, decide, write
console.log(sold.value, made.version, up?.version)
```

- An **op** (`op.incr`, `push`, `merge`, `max`, `min`, `now`) is computed by the leader on the newest state. The answer carries the result in `value`. Ops are values, so they work in assignment too, on an untyped handle: `f.data.widgets.stock = op.incr(-1)`.
- A **condition** (`if: { absent | present | version | equals | lock | expired }`) is checked by the leader. If it fails, the write is refused `conflict`, with the row's `current` version.
- **`lens.set(fn)`** *(proposed)* reads the value and its version, calls your function, and writes the result `if` the row is unchanged. If another write got there first, it reads again and calls your function again. `undefined` means "write nothing". After 8 tries it gives up with `conflict` (the number is a guess). **It can give up**; React's `setState(fn)`, which it looks like, cannot.
  - It is short for two calls that exist: `lens.get({ version: true })`, then `lens.set(next, { if: { version } })`. No new record, no new rule at the leader.
  - **A row that does not exist** is passed as `undefined`, and the write goes `if: { absent: true }`.
  - **Each retry first waits until this process has applied the version the refusal named** (`current`). The refusal counts as something this process has seen, so the next read cannot be older (section 7, "Reads"). Without this rule a re-read could return the same old row 8 times in under a millisecond, and give up though nobody else was still writing.
  - Your function may run more than once. Keep it pure.
  - It is there so that the safe form is the short form.
- **Which one?** An op when one fits: many ops on one hot key share a commit and never retry (PATHS 3.5). `set(fn)` for everything else.
- **All three answer at the commit only** (section 3.5). A refusal also waits for the commit it was judged on, so nobody is refused because of a write that then vanished (A-04).

**Cost.** The same one trip and one disk sync as a plain write. Judging is at most 3 µs at the leader (a bar; not yet measured). `set(fn)` costs one such write per try; if this process holds the row's partition on purpose, its read is local.

### 3.8 Methods: the door (V4-5), called on a path

Declaring `methods:` protects the resource, as in v4: clients then change data **only** through the methods. A client's plain write is refused `methods-only`, and the hint lists the methods. Reads stay open. **A method called on a path runs at that path's leader** (V5-12 pick 3), and **a method says where it may be called** (pick 13).

```ts
// file: server.ts — the door (V4-5): a seed and methods make a server
import { fero, op } from 'fero'

const shop = await fero('shop', {
  data: { widgets: { stock: 10, price: 10 } },
  methods: {
    sell: { at: 'row', run: async (n: number, ctx) => {               // ctx.at: the row the call was made on
      const a = await ctx.at.stock.set(op.incr(-n, { min: 0 }))       // sold out: 'conflict' to the caller
      return { left: a.value as number }
    } },
    restock: { at: 'row', run: (n: number, ctx) => ctx.at.stock.set(op.incr(n)) },   // the reply waits for this commit
    low: (max: number, ctx) => ctx.data.lt('stock', max),             // a bare function: the root only. A view
  },
})
export type Shop = typeof shop                                        // export the type, never the handle
```

```ts
// file: client.ts — a client typed by the server, with `import type`
import { fero } from 'fero'
import type { Shop } from './server.ts'                               // a type only: the server's code never loads

const shop = await fero<Shop>('shop')
const sale = await shop.data.widgets.sell(1)                          // at widgets' leader: one trip, one commit
await shop.data.widgets.sell(1, { once: 'order-981' })                // at most once, even across retries
await shop.data.widgets.call('restock', 5)                            // a method by name: the way out of a clash
const low = shop.methods.low(5).here()                                // no path: any server. A live view, served
await low.ready                                                       // a sync read waits for the first picture
// @ts-expect-error call() is checked against `at:` too: `low` is root-only, so it is not callable on a path
await shop.data.widgets.call('low', 5)
// @ts-expect-error a method declared `at: 'row'` is offered only on a row, never at the root
await shop.methods.sell(1)
// @ts-expect-error a bare function is called at the root only: it is not offered on a path
await shop.data.widgets.low(5)
// @ts-expect-error V4-5: the typed client of a resource with methods has no set
await shop.data.widgets.stock.set(4)
// @ts-expect-error the typed client knows the methods: there is no such one
shop.methods.refund(1)
console.log(sale.left, low.rows)
```

- **A handler is `(arg, ctx) => result`**, as in v4. `ctx.at` is the lens the call was made on (for a bare function, the root). `ctx.data` is this server's root lens, `ctx.rows` its rows, and `ctx.set`, `ctx.remove` and `ctx.batch` the array-form writes. `ctx.peer` and `ctx.claims` say who called. `ctx.use(other)` gives another resource's handle bound to this call, for a handler that writes a second resource (section 7, "Methods").
- **Where a method may be called** (V5-12 pick 13; LENS 2.4). A bare function may be called only with no path: `f.methods.low(5)`. To be called on a path, it says which kind: `{ at: 'row' | 'partition' | 'any', run }`. **The server refuses any other path with `bad-path`**, and the types offer the method only on lenses of that kind, by its name (`lens.sell(1)`) and through `lens.call('sell', 1)` alike.
  - Why: under V4-5 a method is the only door, and a client picks the path. E-55's first build put every method on every lens; `widgets.left.sell(1)` then ran `ctx.at.left.set(…)` on the field `left` and turned `left: 5` into `{ left: {…} }`: a client changed the row's shape through the door. On the changed build, 202 of 202 calls on a path the method did not declare were refused, with 0 commits (E-55 review, claim 18). Types do not stop an untyped or hostile client; the server's check does.
  - `at: 'partition'` at depth 1 is the row, since each row is its own partition. `at: 'any'` may be called on any lens and at the root: inside one partition it runs at that partition's leader, at the root on any server *(this page's reading of LENS 2.4: "a path that spans partitions has no leader")*.
- **On a path, the call goes to that path's leader.** The caller's line carries the row, so there is no hint to store or learn. The handler's writes to that partition are then local: **one trip and one commit in all, the least a call can cost** (PA-25). E-55 claim 18, a stand-in (the leader table and the forwarding are written in the bench): 1,000 path calls made 1,000 trips and 1,000 commits; after a leader moved, one redirect, then one trip again.
- **With no path**, the call goes to any server, as in v4. Each write the handler makes to a partition that server does not lead is one more trip: 0.66 extra trips a call with three servers and 0.80 with five in E-55's stand-in.
- **It is for speed, never for safety.** A method is not a transaction. It is your code on a server. Each of its writes is judged at the one leader; the code between them is not locked. A handler's read can be old by the time its write lands. So **a check-then-set must be an op, a condition or `set(fn)`** ([E-22] C5, D15). `sell` above uses an op. **And a method checks its argument**: a client picks it, as it picks the path (user rule 7).
- **The clash** (V5-12 pick 3). On a lens, fero's own verbs and operators win. A method named like one (`set`, `top`) is still reached by `f.methods.top(…)` at the root (if it may be called there) and by `lens.call('top', arg)` on a path; the typed lens shows which you get. A verb fero adds later could shadow a method somebody wrote; that is a real cost of the shared space (LENS 2.4).
- **The call answers after every write it made has committed.** Then the caller gets the return value. A call has no early stage (V5-11 ruling 6).
- **A throw** answers the caller `threw` with the message; writes made before it stay. A `FeroError` from a write inside (a sold-out `conflict`) reaches the caller as itself.
- **`{ once: name }`** makes a call run at most once; a retry, from any process, gets the first result. It costs three commits in a row (below).
- **`{ retry: true }`** stays from v4, and means something else: "this handler is safe to run twice, so send the call again if its server is lost" (code: api/methods.ts:549-575). It makes no claim and costs no extra commit. Without either option, a call whose server dies answers `unknown` and is not sent again.
- **A method that returns a view streams**, as in v4's example 09: `await` it for one picture, or `here()` it for a live view kept on a server (class C, section 3.10), under the cap on live served views.

**Typing a client: export the type, not the handle** (LENS 1.3). The server says `export type Shop = typeof shop`; the client says `import type { Shop } from './server.ts'` and `fero<Shop>('shop')`. One type argument types the rows, every method's argument and result, and where each may be called.

| The client says | Node 22 and 26 (type stripping) | `tsc`, `verbatimModuleSyntax` | esbuild, tsconfig with `verbatimModuleSyntax` | esbuild, without |
|---|---|---|---|---|
| `import type { Shop }` | the client runs; the server does not | ok | server not shipped | not shipped |
| `import { Shop }` (the mistake) | **SyntaxError when Node links the modules; nothing runs** | **error TS1484** | **server shipped** | not shipped |
| `import { shop }` (the handle) | **the server runs** | ok | **server shipped** | not shipped |

All measured (E-55 claim 24).

- **Check types before you bundle** (reasoned, LENS 1.3). A bundler that keeps imports as written and checks no types ships the server file for `import { Shop }`: the browser then gets the server's top-level `await fero(…, { server: true })` and its method code. That leaks business logic, not just a side effect. Run `tsc --noEmit` (with `verbatimModuleSyntax`) or the lint rule `consistent-type-imports` before bundling; either turns the mistake into an error. This costs fero no rule: it is a line in the docs and in the project template.
- **A cost that stays** (reasoned). A type-only import still makes the client's type check load the server file's whole import graph. A server that imports Node-only packages can pull Node's types into a browser project's check.
- **Later, a browser build of fero in which a server role throws** (V5-12 pick 12), beside `import type` and the type check. It turns a bundled server into a loud error at start, `no-server-here`, whatever the bundler did. That code comes with this build: the first build has no check of its own (section 8). It does not keep the method code out of the bundle; a spec module that both sides import would, at the price of `typeof shop` (LENS 5).
- **V4-5 now shows in the types**: the typed client of a resource with methods has no `set`, `remove`, `touch`, `batch`, `mark` or `claim` (closes 11.1 question 10).
- **Typing the server.** TypeScript cannot take the row type from you and work out the methods' type in the same call. So there are three honest forms, and one that does not compile:
  - a seed gives the row type: `fero('shop', { data: {…}, methods: {…} })`, as above;
  - no seed: `fero.of<Score>()('scores', { methods: {…} })` *(proposed)*: the row type by hand, the methods worked out; at depth 2, `fero.of<Msg, 2>()`;
  - both by hand: `fero<Score, typeof methods>('scores', { methods })`;
  - `fero<Score>('scores', { methods })` **does not compile.** It would leave `typeof scores` with untyped methods, so a typed client would accept any method name (the 2026-11-16 skeptic found three examples that did it).
- **A handle typed by its rows only** (`fero<Item>('shop')`) has untyped calls: `f.methods.x(anything)` at the root, and `lens.call('x', anything)` on a path.

**What a call costs** (PATHS 3.4).
- **On a path:** one trip, to that partition's leader. The handler runs there; its reads and its writes to that partition are local.
- **With no path:** one trip, to any server. Each write the handler makes to a partition that server does not lead is one more trip: about 2 writes in 3 with three servers (PA-25; E-55 claim 18).
- The server checks the path against the method's `at:` before it runs: a lookup (reasoned).
- A call with `once` is **three commits in a row**: claim the name, run, store the result. The claim and the result are rows of `#calls`, which is a resource of its own with its own leaders (V5-2). So a `once` call also makes **up to two more trips**, to `#calls`' leader, and calling on a path cannot save them: the path places the handler, not the claim. Use `once` for calls that must not run twice, not on every call.

### 3.9 Reads

| Read | Where | Cost | Can it be stale? |
|---|---|---|---|
| `f.rows.k` | here, on a server or with `hold: 'all'`. Anything else throws `not-held` | a `Map` read plus one trap; the row is handed out by reference, frozen. The `Map` read alone is 43 to 51 ns at 1,000 rows, about 1 µs at 1,000,000, where cache misses rule (PATHS 4.1). **The first read of a row after it was written also freezes it**, once, deeply (DATA-07; code data:api/index.ts:152-162) | it is this process's last applied commit. Never older than anything this process already saw or wrote |
| `held.rows.k`, `held.value` (from `here()`) | here, through the handle | the same lookup | the same |
| `await lens.get()`, its partition held on purpose | here | no trip | the same |
| `await lens.get()`, not held on purpose | **one trip** to a copy; nothing is kept | one trip and the value's bytes, every time. After 100,000 misses: 100,000 GETs, 0 SUBs, 0 rows kept (E-55 claim 20) | a copy may trail the leader by a moment, but never behind what this process saw |
| `await lens.get({ fresh: true })` | **always at the leader** | one trip, plus the leader's check with a majority that it still leads. No disk (PATHS 4.3). etcd's same read: 0.43 ms against 0.18 ms ([E-09e]) | no: it sees every write that finished before it began |
| listing `f.rows` or `held.rows`, v4's `f.snapshot` | here | **every held row is walked**: 87 µs at 1,000 rows, 30 ms at 100,000, 0.5 s at 1,000,000 (PA-8, measured on v4's two passes; one pass is owed) | as `f.rows` |

```ts
// file: reads.ts — read once, hold, read fresh
import { fero, FeroError } from 'fero'
type User = { name: string }
const users = await fero<User>('users')                   // a client: it holds nothing

const u = await users.data.u42.get()                      // one trip; nothing is kept
const me = users.data.u42.here()                          // now u42's partition is held on purpose, and live
await me.ready
const again = await users.data.u42.get()                  // held on purpose: served here, no trip
const same = me.value?.name                               // a sync read through the handle: one lookup
const sure = await users.data.u42.get({ fresh: true })    // at the leader: sees every finished write
const name = await users.at('u42', 'name').get()          // the same kind of address, with no Proxy
try { console.log(users.rows.u7) }                        // f.rows needs the whole resource held: 'not-held'
catch (e) { console.log((e as FeroError).hint) }          // "users is not held here: users.data.u7.get(), or .here() it"
console.log(u, again, same, sure, name)
```

**A read is the verb `get()`, and a lens is never a promise** (V5-12 pick 11; LENS 2.1).
- `await lens` gives the lens back. If a lens had `then`, JavaScript would treat every lens as a promise, and anything that resolves a value would make a hidden trip: an `async` function that returns a lens, `Promise.resolve(lens)`, `Promise.all([lens])`. On E-55's first build, returning the **root** lens from an `async` helper downloaded the whole resource: 100,000 rows, 6.8 MB as JSON, in one GET. Now each of those cases makes 0 trips (E-55 review, claim 4: 47 of 47 cases).
- **Seven names read as `undefined`** on every lens, because JavaScript or common libraries probe them on any object: `then` (promises), `toJSON` (`JSON.stringify`), `constructor`, `$$typeof` (React), `asymmetricMatch` (Jest), `nodeType` (DOM checks), `subscribe` (Svelte's store contract). A key with one of these names, a symbol, or a key in a variable takes `at()`. A method with one of these names takes `lens.call(name, arg)`.
- **`get()` reads once and holds nothing.** The 2026-11-16 page's `get` followed its key for the life of the handle; that was a slow leak the line did not show.
- **A read is served here only from rows held on purpose** (V5-12; LENS 2.2 rule 2): a server, `hold: 'all'`, or a live `here()` or `tap` on its partition or on the whole resource. Rows that only a `connect` keeps never serve a read; the read takes a trip. Why: when a dropped `connect`'s rows go is the collector's choice. On E-55's first build the same program made 0 GETs or 1 by when a collection ran: 9.7 different here-or-trip patterns per program over 1,000 collector seeds. With the rule, 1 (E-55 review, claim 14).
- **A GET carries the highest position this process has seen**, and waits for the process's own early-answered writes (rule Y). A copy that is behind waits before it answers, so a process never reads backwards when a link ends and its next read goes to another copy (reasoned; E-55 had one server, which cannot be behind, so this is counted, not tested).

**A lens is for wiring; `rows` is for reading in a loop** (LENS 2.1).
- A read through two steps and a verb costs 0.17 to 0.29 µs with one key, and 1.6 to 1.7 µs with keys spread over 1,000,000 rows, against 0.014 to 0.06 µs and 0.60 to 0.64 µs for a `Map` read (E-55 claim 1). So `rows` stays the hot sync read.
- **A step keeps nothing**: 0 to 0.3 B per key after 100,000 keys, one and two steps deep (E-55 claim 2). data's handle today keeps every child for its parent's life: 318 to 1,333 B per key, which at 1,000,000 keys is 0.3 to 1.3 GB no line shows.
- A step costs 49 to 99 ns with one key read again and again. With keys spread over 1,000,000 rows it costs 162 to 222 ns (median 205, over seven runs; the bar was 150), most of it the `Proxy` on a big heap (E-55 claim 1). The lens stays a full lens all the same, not only an address (V5-12 pick 10): that one missed cell is the case `at()` is for, and there the lens adds under 20 % to a read of 1.1 to 1.3 µs. Keep a lens you use often: a kept lens's verb costs −63 to +24 ns over the direct call.
- **`f.at(...keys)`** builds the same lens with no `Proxy`, and with full types: `shop.at(sku, 'stock')`. Use it for computed keys and in hot loops: it costs −79 to +33 ns over the direct read with keys spread (E-55 claim 1). **A number key becomes its string**, as a property step does: `f.at(1, 'n')` is `f.data[1].n` (on E-55's first build it reached a different row, and with hashed routing a different leader). Any other key type is refused `bad-key`.
- **What gets worse** (LENS 2.1). `typeof lens` is `'function'`. Printing needs a custom inspector: `console.log(lens)` prints `Lens(shop.widgets.stock)`. `JSON.stringify` skips a lens, and `structuredClone(lens)` throws, as for any function.

**`f.rows`** *(proposed; PA-8)* is a read-only view of the rows this process holds **for the whole resource, on purpose**: a server's, or `hold: 'all'`'s (LENS 2.2). A partition held by `here()` is read through its handle (`room.rows`), never through `f.rows` (user rule 5). The same goes for `f.data.here()`: it holds every row, and you read them through its handle; `f.rows` still throws `not-held` (*this page's reading*; question 15).
- `f.rows.k` is one lookup and returns the frozen row itself, or `undefined` when no such row exists. `f.rows.k?.stock` is then a plain property read. At depth 2, `f.rows.room1?.m7`.
- A row you took never changes: it is frozen (DATA-07). `f.rows` itself is always "now".
- Listing it (`Object.keys`, a spread, `JSON.stringify`, `console.log`) walks every row. That cost is in plain sight: you wrote a loop or a print.
- **How it prints.** Node's `console.log` shows a `Proxy`'s target and runs none of its traps: a bare `Proxy` over the store prints `{}` (checked on Node 22; `JSON.stringify`, `Object.keys` and a spread do go through the traps). So `f.rows` is an object of a small class over the store that carries `[util.inspect.custom]`, which lists the rows. Owed: a test that `console.log(f.rows)` prints the rows.
- **Owed: two pins.** `f.rows.k` on a row already read stays within twice a `Map` read. The first read of a row just written is pinned apart: a hot row that is rewritten often pays the freeze again after each write.

**`f.snapshot` keeps v4's meaning** *(a question for the owner, section 11.1)*. It is the whole picture: a new frozen container of every row, on each access. So every `snapshot` in fero is a picture that stands still: `f.snapshot`, `cluster.snapshot()`.
- **Every v4 line keeps its result**, where the process holds the whole resource (a server, or `hold: 'all'`). `console.log(shop.snapshot)` prints the rows, as the READMEs of about 20 examples record. `const s = f.snapshot` kept across an `await` still stands still. On a client that holds less, it throws `not-held`, as v4's does on a scoped node.
- **And with v4's cost**: every row walked on every access (code: api/index.ts:1289-1296). `f.snapshot.widgets` in a loop is the slow line it was in v4. New code reads a row through `f.rows` or a handle; the examples that read one row move to them.
- An earlier draft made `f.snapshot` a second name for the live `f.rows`. That made old lines fast for free. But it left two names for one thing, made `f.snapshot` the only `snapshot` that is not a picture, and changed what a kept `f.snapshot` reads after an `await`.

**Sync reads never guess.** A sync read never returns a stale, empty or partial answer in place of rows that exist somewhere else, and it never makes a hidden trip.
- **A row not held on purpose here throws `not-held`.** The hint names the row's partition and the two calls: `get()` and `here()`.
- **On a process that is not a server and did not say `hold: 'all'`, everything that needs every row throws `not-held`**: listing `f.rows`, `f.snapshot`, and an operator over every row left of `here()`. v4 banned the same silent partial answer: its `f.snapshot` throws on a scoped node (code: api/index.ts:1289-1296). The hint names the two ways out: a method that serves the view (section 3.10), or `f.data.here()` with the operator right of it. A handle's own `rows` list fine, since a `here()` holds all of what it selected.
- **Only a string row key can throw.** Reading a symbol, or one of the seven probe names above (`then`, `toJSON`, `constructor`, `$$typeof`, `asymmetricMatch`, `nodeType`, `subscribe`), off `f.rows` or a handle's `rows` gives `undefined` and never throws: the same list as on a lens, under the same rule. Otherwise `JSON.stringify(f.rows)`, awaiting anything that holds `f.rows`, or a React, Jest, DOM or Svelte check on it, would throw for the wrong reason. A row whose key is one of those names is read with `at()` and `get()`.

### 3.10 The lens: `here`, `tap`, `connect`, and the line between server work and local work

`here()` keeps a selection live in this process. It is the line between a server's work and this process's work: **left of it is plain data, and it may run on a server; right of it is your code, here** (LENS 2.0). `connect(target, fn | 'prop')` is `here()` tied to a target. `tap((c) => …)` is a strong sink on anything live.

```ts
// file: live.ts — here, tap, connect, and the line between server work and local work
import { fero, scope } from 'fero'
type Msg = { text: string; stars: number }
const chat = await fero<Msg, 2>('chat')                          // a client of a depth-2 resource: a room is a partition

const room = chat.data.room1.here()                              // hold room1, live. Counted; shared with every here() on room1
await room.ready
console.log(room.rows.m7?.text)                                  // sync reads go through the handle
const starred = room.filter((m) => m.stars > 0)                  // right of here(): your code, here. It ends with room
starred.tap((c) => console.log(c.first, c.changes.length))       // one call per commit
room.close()

chat.data.room1.connect(ws, (ws, c) => ws.send(c.text()))        // a socket says when it closes: the link ends with it
const page = scope(() => {                                       // a plain object or a DOM node does not: use a scope
  chat.data.room1.connect(list, (list, c) => draw(list, c.changes))   // the target is passed in
  chat.data.room1.m7.text.connect(el, 'textContent')             // el.textContent now and at each commit. Holds room1
  chat.data.room2.here()
})
page.dispose()                                                   // every here() and connect made inside ends here
const best = chat.data.room1.gt('stars', 0).za('stars', 10).here()   // plain data left of here(): may run on a server
await best.ready                                                 // a sync read waits for the first picture
for await (const e of chat.data.room1.changes({ from: 'earliest', until: 'latest' })) console.log(e.version, e.rec)
console.log(best.rows)
best.close()
```

| You write | You get | Where the work runs | What crosses the wire | A slow reader |
|---|---|---|---|---|
| `lens.here()` | a handle: `rows` and `value`, kept live | the fold, here | the partition (or the whole resource) once, then its changes | sees the newest state: changes are folded, one per row |
| `lens.tap((c) => …)` | one call per commit, until `close()` or its scope; it holds as `here()` does | as `here()`, then your function | as `here()` | as `here()` |
| `lens.connect(target, fn \| 'prop')` | the target kept up to date while it lives | as `here()`, then your function | as `here()` | as `here()` |
| operators right of `here()`: `room.filter(…)` | a live view on held rows | here: about 1 µs per affected filter view ([E-05]); 1.6 to 62 µs a change for an ordered view with a window, by partition size (E-55 claim 16) | nothing new | sees the newest state |
| `f.methods.view(arg).here()` | a live view kept on a server | on the server | only the view's own changes | sees the newest state |
| `lens.changes({ from })` | every record, in order, from a position | your loop | every record of the selection | waits; nothing is skipped |

**`here()`: hold it live.**
- **What it does.** It hands over the picture so far, then each commit. No gap, no overlap (data's SCHEDULE clause 7; [E-31] across the network). E-55 claim 7: 93,326 sinks in 1,000 seeds in one process, and 1,000 seeds across 4,337 disconnects over a real port: 0 changes missed, 0 twice. A reconnect sends only what was missed (PATHS 4.6); v4 downloads the whole resource again.
- **Equal lenses share.** Every `here()`, `tap` and `connect` on one selection in a process shares one SUB, one decode and one fold per change, and one `c.text()` per commit. They are counted; when the count reaches zero, the unsubscribe is sent after a short linger (`linger.ms`, section 9). E-55 claim 9: exactly one of each, by counters, for 2,000 links. So 1,000 sockets in one room on one webserver are one subscription and one decode per change, not 1,000.
- **Selections that overlap** (E-55 claim 7). A partition held inside a held whole resource sends no SUB of its own. When the whole ends, the partition subscribes again from the whole's server position. A resume cursor is always the server's position, never the client's own commit number, and a client drops a frame it already applied. Without these, 75 frames were applied twice in 1,000 seeds.
- **The wire sends whole partitions** (user rule 4; V5-12 pick 2). `chat.data.room1.m7.text.connect(…)` holds `room1`: the lens looks finer than the wire. With a row per partition (depth 1) the row is the partition, so there the first build is already exact.
- **`f.data.here()`** holds the whole resource: the line for "everything", with a handle you can close. It holds the same rows as `hold: 'all'`; you read them through the handle, and `f.rows` stays for a server and `hold: 'all'` (section 3.9).

**`tap((c) => …)`: one argument per commit, by reference** (LENS 1.6, 2.7).

| `c.` | What it is |
|---|---|
| `first` | true once: `changes` is then the picture so far, as adds. That first walk is O(rows held), and it runs in your code |
| `changes` | this commit's changes, by reference: each has `type`, `key`, `row` and `prev` (the row before this commit). A commit holds at most one change per row (SCHEDULE clause 8) |
| `now` | the latest state, read where it is: `c.now.rows` and `c.now.value`. A lookup, not a copy |
| `recs()`, `text()` | the wire-shaped records of this commit and their JSON text, for code that forwards them. Each is built once per commit and shared by every sink that asks (E-55 claim 9: 100 builds for 100,000 deliveries) |

- **One call per commit**, so a DOM sink batches its patches. `changes` and `now` are made only when read.
- **Rows handed to a sink are frozen, deeply, on their first hand-out** (LENS 2.7; review F15). SCHEDULE clause 11 calls by-reference values "shared-immutable"; without a freeze that is only a promise, and one sink that changed a row would corrupt the store and every other sink of that commit. `f.rows` already pays this freeze on first read (DATA-07). It costs 163 to 220 ns per changed row of E-05's small row (E-55 review).
- **What a tap costs** (E-55 review, claim 10, the ways interleaved round by round). A tap that reads nothing adds 92 to 198 ns a commit over no sink; 63 to 122 ns of it is data's own delivery to any sink, so **a tap is not free**. Reading `c.changes` with each `prev`, or a row through `c.now`, adds nothing the harness could see (−39 to +32 and −33 to +91 ns). Building `c.recs()` adds 166 to 216 ns. data today pays 1.5 to 1.8 µs more a change for a tap that names a parameter; that shape goes (data's D4, LENS 4.5).
- **`tap` is the strong form**: it lives until `close()` or its scope. A tap is a link like `here()`: it holds its selection on purpose.
- **`here()` and `tap` are strong: only your code ends them.** The collector never does. A `here()` handle that code drops without `close()` and outside a scope keeps its SUB, its rows and its taps for the life of the process: a leak, but never a result that depends on the collector, since its rows stay held on purpose the whole time (*this page's reading* of LENS's words: strong links "end only when your code ends them"). So keep the handle and close it, or make it in a scope.

**`connect(target, fn | 'prop')`: `here()` tied to a target** (LENS 2.2).
- Two forms: `connect(target, (target, c) => …)` and `connect(target, 'prop')`, which sets `target[prop]` to the value now and at each commit. data has the second today (code data:api/index.ts:362-374).
- **fero holds the function strongly and the target weakly, and passes the target in.** A function that closes over its own target keeps it alive for good: never collected, for a plain object and for a DOM node (E-55 claim 15). fero cannot check that for a plain object; for a DOM node it can warn (section 8).
- **A `connect` function changes only its target** (user rule 6). A dropped target is alive until it is collected, so its function keeps running for a time the collector picks. When half the dropped links in E-55's seeded runs also wrote a shared counter, one program gave 433 different results per 1,000 seeds (claim 14, a control). Anything that changes more belongs in `tap`.
- **What it costs** (E-55 claims 6 and 11). Registering the target: 0.13 to 0.33 µs in ordinary jobs, but 0.58 to 0.67 µs inside one long job that made about 150,000 (a `WeakRef` keeps its target alive to the end of its job). Per commit, a weak link costs +28 to +35 ns over a strong sink; 10,000 weak links cost 2.2 times 10,000 strong sinks (a miss against the bar of 1.1). A second `connect` or `here()` on a held selection: a lookup and a count, 39 to 45 ns; a second `here()` 163 to 169 ns.

**How a link ends: at the first of these** (LENS 2.2).

| How | When | For what |
|---|---|---|
| `link.close()` | at once | anything |
| its **scope** ends | at once | a component, a route, a request, a method handler. `scope(fn)` gathers every `here()` and `connect` made inside `fn`; data's `render` makes one scope per mount (code data:render/index.ts:1002-1030) |
| the target **says it closed** | at once | only the kinds fero names: a Node `EventEmitter` (sockets, streams, the `ws` library), a `WebSocket`, a `MessagePort`. fero listens for `close` once. Any other object is left alone unless the call names its event: `connect(t, fn, { closes: 'end' })` |
| the **count** reaches zero | after the linger (`linger.ms`), then the unsubscribe is sent | every link on one selection in a process shares one SUB; the last one out ends it |
| a `connect`'s target was **collected** | some time later, or never | **the net only**, and only for `connect`: a DOM node other code removed, a plain object the program dropped, and the view a `connect` was made on (`room.za('stars', 10).connect(el, fn)`), which goes with its link |

- **Why the collector is only the net.** In a headless Chromium, 0 of 1,000 links whose DOM nodes were removed ended within 30 s, idle, busy, or with a commit every 10 ms (E-55 claim 13). In Node the first link ended after 7 ms to 16 s, and in one harness old targets in a busy process were never collected (LENS 2.2's table). Until then the server keeps sending and this process keeps decoding: one commit with 1,000 dropped, uncollected targets cost 0.80 to 0.90 ms, and all 1,000 functions still ran (E-55 claim 12). fero v4's V4-54 wrote down the same cost.
- **Three rules make the net harmless** (LENS 2.2): before each delivery a link checks its target, and a dead target is never called (E-55 claim 12: 1,000 of 1,000, 0 calls); a read is served here only from rows held on purpose (section 3.9); and a `connect` function changes only its target. With all three, a program gave **1 result and 1 pattern of reads served here or by a trip, over 1,000 collector seeds** (E-55 review, claim 14). So data's own rule stays true: "GC timing can never change observable results" (code data:kernel/scope.ts:1-3).
- **What still depends on the collector is a cost, not a result**: how long a dead link's SUB lives. The count of SUBs a client sent differed 3 ways per program over those seeds.
- **A dev warning names the path of a link the net had to end** (section 8). It is the fix's pointer: a `close()`, a scope or the count was missing.
- **Views right of `here()` end with their handle** (LENS 2.7; data's D6). `room.filter(fn).tap(…)` is a view made from `room`: when `room` closes or its scope ends, the view is released and its sinks are never called again. `room.za('stars', 10).connect(el, fn)` is a weak link like any other. E-55 review, claim 26: 59,958 view sinks in 1,000 seeds, ended by `close()`, a scope, the seeded collector or `link.close()`, with a linger: 0 calls after the end, 0 views left. (The first build leaked both ways; planted, its behaviour fails every seed.)

**What may stand left of `here()`** (LENS 2.3; V5-12 picks 2 and 5).

| Class | Example | The server's work | Guard |
|---|---|---|---|
| **A. a partition** (or the whole resource, where it is held) | `chat.data.room1.here()` | routes committed bytes; each change encoded once for all readers: 0.01 to 0.46 µs per record per reader (PATHS 0) | `rules.read`, once per subscription |
| **B. plain-data operators inside one partition** | `chat.data.room1.gt('stars', 0).za('stars', 10).here()` | **first build: the same as A.** The partition crosses whole and the operators run here. **Later:** one view per distinct shape, on a copy | bounded by the partition; when pushed down, a cap that covers shapes |
| **C. a view over the whole resource that the server named in `methods:`** | `shop.methods.low(5).here()` | whatever the author's view costs; shared by equal calls | **the door (V4-5) says which views**: only a declared method. **A cap says how many**: live served views per client and per resource |

- **A function left of `here()` does not compile**, and untyped code is refused `unencodable`: code cannot travel. `filter(fn)` and `map(fn)` go right of `here()`, or inside a method. The compile error reads "This expression is not callable": the types cannot say why, so section 8's hint does.
- **A whole-resource operator left of `here()`, on a client, is refused `not-held`.** The hint names the two ways out: a method, or `f.data.here()` with the operator right of it (`all.gt(…)`). On a server, or with `hold: 'all'`, it runs here. The types cannot see which process this is, so the line compiles everywhere (section 6).
- **Why class C needs a method.** A view a client makes up over every row is work on every write on a server: 100 distinct filters cost 9 to 18 µs a record, and `group` costs 2,574 µs a record at 1,000,000 rows ([E-05]). `methods:` is how the server's author says what clients may ask for (V5-12 pick 5).
- **Why class C also needs a cap** (LENS 2.3; review F7). The door limits which views a client may ask for, not how many. Each distinct argument is its own served view, so a client that calls `low(i)` in a loop would make the server keep, and update on every write, as many views as it likes. A served view costs the server 9.9 KB to 12.8 MB of memory and its own CPU per change (E-55 claim 16). So a client may hold at most `views.client` live served views, and a resource serves at most `views.max`; past either, the SUB is refused `too-many-views` (section 9). *(Reasoned; not built: E-55 has no class C, claim 27.)*
- **Why class B waits** (V5-12 pick 2). Three things it needs do not exist yet: a cap that covers shapes, the SUB's `view` selector modelled in E-31's model (claim 22), and the order channel on the wire (below). And pushing a view down cannot make it cheaper; it moves the view's CPU and memory from each reader to the server (E-55 claim 16):

  | | The partition crosses, the view runs here (first build) | The view runs on the server, its answer crosses (later) |
  |---|---|---|
  | first picture on the wire, per shape | the partition: 6 KB (100 rows) to 6.6 MB (100,000 rows) | the answer: 677 to 765 B |
  | wire bytes per change | 60 to 63 B | 0 to 32 B for one shape; **26 KB for 1,000 shapes of a 100-row room** |
  | CPU per view per change | the client: 1.6 to 62 µs | the server: 2.3 to 5.2 µs at 100 to 1,000 rows, 8 to 12 µs at 10,000, 51 to 53 µs at 100,000 |
  | memory per shape | the client's | the server's: 9.9 KB to 12.8 MB |

- **Moving `here()` changes the cost, never the settled answer, only if the order travels with the rows** (E-55 claim 17). Where an ordering operator (`za`, `top`, `reverse`, `limit`) stands last left of `here()`, its answer is an order. A client that keeps the rows in a plain keyed copy loses it: 239 of 1,000 seeded runs gave a different answer. Keeping data's order channel (the place of each added row, and `move` records) beside the copy: 0 of 1,000. So class B can be added later with no change to any app line, if the wire carries the order and the client keeps it. Also, `limit` and `reverse` follow arrival order (code data:ops/ordered.ts:540-562); a copy filled in another order than the source was not tested.
- **On the wire.** No new verb. A SUB's `view` selector carries `{ method, arg }` (class C) and, later, `{ path, ops }` (class B). Neither is modelled yet (section 11.2).

**`changes()`: the log, on the lens.** `lens.changes(opts)` reads the log (V5-1): every committed record under the lens, in order, from a position. The lens is the selector; `of:` is gone.
- **What it reads.** On the root, every partition. On a partition lens (or a row lens at depth 1), that partition. On a lens below a partition, the partition's records cross (user rule 4) and the reader gets those under the lens *(this page's reading)*.
- **`from` is `'latest'` by default: from now on. "Now" is the call** *(stated here; reasoned, not modelled)*. The reader opens when `changes()` is called, not when the loop first turns. So **a write this process makes after the call is always seen**, even if it commits before the loop starts.
  - On a process that holds the selection on purpose, `'latest'` is the last position this process had applied when the call was made.
  - On a process that does not, the open is sent with the call, and this process's own later writes to the selection wait in the client until the open is answered with its start: one trip, once.
  - Another process's write that commits at about the same time may fall on either side. That is what "now" means across processes.
- **An entry** is `{ rec, value, partition, version, time, source }`. `e.rec` is the change record itself, shared with every other reader and never copied. **`e.value` is what the record wrote, when it wrote a whole row**: `e.rec.value`, typed. It is `undefined` for a field write and for a remove. It is never looked up, so it is not "the row now". A loop that needs the row after a field write holds the partition and reads its handle; that costs a fold of what it reads (PATHS 4.9 step 4).
- **A cursor is a bookmark.** `r.cursor` is text. Save it; pass it back as `from`. It stays valid across leader changes and moves ([E-31], [E-19]). A wrong text is refused `bad-cursor` when the reader opens.
- `history` on the resource says how much of the log is kept; past it, the reader gets `expired`. `credit` (1 MB by default) keeps a slow loop from filling memory.
- **`changes()` and `here()` give different things on purpose.** `changes()` gives log records, every one, in order, with no `prev`; a count needs it. A slow `here()` reader is folded to one change per row (LAYERS 4).

### 3.11 Derived resources, and exactly once

There are three steps, and each costs more and lasts longer.

| Step | Code | Where it lives | Cost |
|---|---|---|---|
| a view | `orders.data.here().group((o) => o.user)`, right of `here()` | in this process, while its handle lives | the fold: about 1 µs per change for a filter ([E-05]) |
| a served view | a method that returns a view; clients `here()` it | on a server, while a client holds it | one encode per change, shared |
| a derived resource | `derive(orders, totals, fn)` | in its own log and copies, for good | a share of one commit per source record |

```ts
// file: derived.ts — totals from orders, exactly once: the libraries first, then what they are made of
import { fero, op, derive, consumer, lock } from 'fero'
type Order = { user: string; cents: number }

const orders = await fero<Order>('orders')                       // a client of the source: it holds nothing
const totals = await fero<number>('totals', { server: true })    // a server of the target
await derive(orders, totals, (e) => {                            // the library: paced, run once, with bare marks
  if (e.value) totals.data[e.value.user].set(op.incr(e.value.cents), { from: e })
})
const invoices = await fero<{ cents: number }>('invoices')
const billing = await consumer(orders, 'billing')                // the same, into any resource: one owner per share
billing.run((e) => { if (e.value) invoices.data[e.partition].set({ cents: e.value.cents }, { from: e }) })

// what derive() is made of: four lines, shown here for a second target. Exact only because fero paces
// them, and only in one process: so they run under a lock
const spent = await fero<number>('spent', { server: true })
await lock('derive:spent', async () => {
  for await (const e of orders.data.changes({ from: spent.marks('spent') }))
    if (e.value) spent.data[e.value.user].set(op.incr(e.value.cents), { from: e })   // not awaited: writes pipeline
})
```

**Use `derive()` and `consumer().run()` first** (V5-12). They are about fifteen lines of library each over public calls, and nothing in them is a primitive (LENS 2.8). They earn their names in three ways.
- **They pace the loop** (item 1 below).
- **They run it once.** A **share** is a part of the source's partitions that one runner owns at a time; the system resource `#groups` keeps who owns which. The derivers that share a name split the source's shares among them, so three servers do the work once. The name is the target's, by default.
- **`derive()` sends bare marks.** A bare mark, `target.mark(e)`, is a mark with no write. Marks are kept per **output slot**: the slot of the target that an output's partition hashes to. A slot that gets no output for a while would hold the restart point back; a bare mark moves it on.
- **`consumer().run()` needs no bare marks** *(this page's reading, question 24: LENS 2.8 says both libraries send them, but `run` has no target to send one to)*. It restarts from its share's own cursor, kept in `#groups`, not from a target's marks. It moves that cursor only once every marked write made for the records up to it has been answered (LAYERS 3.3). After a crash it reads again from the cursor, and each write it makes again is skipped at its mark. Its marks go under the consumer's name.

**The mark is a write option: `{ from: e }`** (V5-12 pick 7). The write and "source record `e` is applied" land in one log entry of the target. The leader skips a marked write at or below its stored mark and answers it as done. `target.marks(name)` reads the marks back as a cursor for `changes({ from })`. A mark is 29 B in the target's own log, so a restart resumes exactly, and no source record counts twice ([E-30]).
- **Which name a mark goes under** *(this page's reading of LENS 1.7's "`e` knows its reader"; LAYERS section 10 item 32; question 24)*. Marks are kept per reader name. `target.marks(name)` gives a cursor that carries the name; `changes({ from })` hands the name to each `e`; `{ from: e }` marks under it. A first run starts from `marks(name)` too: with no mark stored yet, that is the start of what the source keeps. An `e` from a reader that did not start from `marks(name)` marks under the target's own name, which is `derive()`'s default.
- **A marked write takes no `once` name** *(this page's reading; question 20)*. The mark already makes the write count once per source record, for as long as the source keeps its log. A name lasts a day, and would be a second check for the leader to order against the mark. `if` and `ttl` are allowed. LENS 4.4 priced the option as composing with `once` and `if`, at 0 to +2 rules; leaving `once` out is the low end. The types refuse `{ from: e, once }`. A mark goes on a plain write, an op or a remove; `set(fn)` and `batch` take none.

**The four lines are exact only with two more things** (LENS 1.7; review F2).
1. **fero paces the loop.** A marked write is never refused `backpressure`: it waits, and the reader its `e` came from stops yielding while this client holds 512 waiting writes or 64 MB (section 3.6: the limit is the client's, not the target's). The loop does not await, so it would never see a refusal; a later write to the same output slot would then commit and move the mark past the dropped record, and no leader could see the loss. In E-55's seeded stand-in for E-30's model, **the four lines as written lost outputs in 998 of 1,000 seeds** (with the real cap of 512 and 4,000 records, in 100 of 100); **paced, 0 lost and 0 doubled in 1,000 seeds** (E-55 review, claim 21). A marked write that fails for another reason (a lost link, a leader that saw a gap) ends the loop with that error; started again, it resumes from the marks.
2. **It runs in one process.** With `server: true`, every server process of `totals` that runs these four lines derives. The marks keep the result right (two derivers under one name: 0 doubled, E-55), but the work is done N times. Take a lock (P-10), or use `derive()` or `consumer()`, which split the work.

- **What the loop rests on** (LENS 2.8; reasoned from [E-30]): the leader takes a writer's marked write n to an output slot only after its write n−1 (E-55 review: with that rule off, 756 of 1,000 seeds lost outputs); marks move with their slot and ride snapshots (a move that drops its marks doubled outputs in 1,000 of 1,000 seeds); and a marked write answers at its commit only, since it can be skipped (V5-11 ruling 6).
- **Not awaiting is the point.** Marked writes that are not awaited ran at 122,000 to 134,000 a second, against 239 to 240 a second awaited one by one with a commit every 4 ms (E-55 claim 21). They pipeline, and the pacing keeps them exact.
- **Without bare marks the four lines restart from far back.** `marks()` is the lowest mark over the output slots. A slot that got no output for a while holds the cursor back, so a restart reads again every source record since then (each is skipped at its mark), and the source must keep its log that far.
- **The source needs `history`** (default 0). A long stop needs the source to keep its log back to the marks (`history`, or the tier); past that, the deriver stops with `expired` rather than skip a record (LAYERS 8.8).
- **One source record, several outputs: open** (question 21). Each marked write is its own record and its own log entry, with its own mark. Nothing commits two of them together, so a reader may see one before the other. The 2026-11-16 page's `out` staged one record's outputs to one partition into one entry (PATHS 4.9 step 5); `{ from: e }` on separate writes does not, and a `batch` takes no mark. And the mark is kept per output slot: as the rule is written, a second marked write of the same `e` that lands in the same slot is "at" the mark the first one raised, and **would be skipped**. [E-30]'s model sent at most one output of a record to each slot, so it never met the case (LAYERS section 10 item 31). Until that model is run with marks from app code (section 11.2), make **at most one marked write per source record per target**. *This page's pick:* the mark also carries the write's number within its record, so the leader skips only what it has applied. That changes what is compared, not how many rules there are (reasoned, not modelled).
- **`e.value` is what the record wrote**, so reading it folds nothing. It is `undefined` for a field write. So this `derive` counts an order **once per whole-row write**: write each order whole, once. A field write to an order is skipped by the `if`, and a second whole write counts again.
- There is no transaction across the two. `totals` trails `orders` by about one commit. On the project's one timeline, a derived record is placed after its source (V5-4).
- **Who runs it is the app's choice**: `derive()` splits the source's shares among the processes that run it; the four lines need a lock (closes section 11.2's Q-B8, by LENS 4.3).
- Several sources: `derive([orders, refunds], totals, fn)`; `e.source` names which.
- **By hand without the mark** the loop is at least once from a saved cursor, and at most once from `'latest'`.

**Is fero exactly once?** (LENS 1.2.) **Yes, for writes into fero, in three layers, each with a limit: a resend counts once inside one session (after a pause longer than `session.ms` the answer is `unknown`); a `once` name counts once for a day; a mark counts once per source record while the source keeps its log (`history`) and the loop is paced and runs in one process. Like Kafka, not for an email or a payment made inside your code.**

| Layer | Makes exactly once | For how long | Cost | Kafka's nearest (from memory) |
|---|---|---|---|---|
| **sessions**, always on | a resent write | the session's life; a pause over `session.ms` answers `unknown` | 309 B a client; 13 rules, model-checked ([E-20]) | the idempotent producer: dedups inside one producer session |
| **`once` names** | a write or call the app names, across processes and restarts | 1 day | about 221 B a name (section 3.4) | nothing direct |
| **marks** (`{ from: e }`) | read from a source, write an output | while the source keeps its log back to the mark | 29 B a mark; 5 rules, model-checked ([E-30]); 1 more for pacing | transactions with `sendOffsetsToTransaction` |

- **Weaker than Kafka:** no atomic write across partitions that readers cannot see half of. `batch` is all-or-none in one partition; a saga may be seen half done ([E-24]; V5-1 gave this up knowingly).
- **Simpler than Kafka:** the mark needs no coordinator and no two-phase commit ([E-30]). Kafka's producer-id scheme needed 16 rules here against 13 ([E-20]).
- **Still owed:** E-30's model with `{ from: e }` written by app code, and the pacing rule in a real client (E-55's run is a seeded stand-in: no Raft, no lost log tails).

### 3.12 Looking back: `asOf`

Built after the first build (*this page's reading*: V5-12 counts `asOf` outside the first build's rules, and LAYERS 9.4 lists it among the later steps; question 22).

```ts
// file: asof.ts — a row as it was: a reader, folded here
import { fero } from 'fero'
type Item = { stock: number }
const parts = await fero<Item>('parts')                 // a client of a resource with no methods, so it may write
const ack = await parts.data.widgets.set({ stock: 3 })
const past = await parts.data.widgets.asOf(ack.version) // one log-mode SUB from the nearest snapshot; folded here
console.log(past.value?.stock)                          // the row as it was: 0.6 to 1.4 µs (E-55)
past.step(-1); past.step(+1)                            // one commit back, one forward: each moves this reader
past.close()                                            // memory grows with the window, so close it
```

- **`step` and `seek` move this reader, and return it** *(this page's reading; LENS 2.9 says only "a number changes")*. So `past.step(-1)` and then `past.value` reads the earlier state, and `(await lens.asOf(v)).step(-1).value` reads the same. A second view of another moment is a second `asOf`.

- **A past state is a read handle, never a change to the live rows** (V5-12 pick 8; [E-54]). `lens.asOf(position)` takes a version, a cursor or a writer time (V5-4). No server keeps versions, and no write pays for a reader it does not have. data keeps no version structure, and the log carries no prior value.
- **How.** One log-mode SUB (a SUB that sends records, not rows) from the nearest kept snapshot at or before the position. The reader keeps a sorted list of versions per row (fat nodes as per-row lists; E-54 rejects the smaller back-pointer layout, which read a hot row in 0.3 ms).
- **A step is one commit, not one record.** data gives `prev` once per row per commit (code data:contract/delta.ts:101-103), and nobody can see a state inside a commit. So `step(-1)` after a write lands before that write's whole batch.
- **Prefer `asOf` on a partition lens.** It reads one partition's log. `f.data.asOf(p)` folds every partition: costly (below). Operators work on a past state, and run here.
- **What it costs to open** (E-55 claim 23 on data's real fold; reasoned for the sum): the snapshot load, O(rows) once (LAYERS 8.7), then every record from the snapshot to the position: a decode, then the fold with the version lists, 3.6 to 4.4 µs a record (the lists are +1.5 to 2.0 µs of it; the decode is not in that number). A million records since the snapshot is about 4 s.
- **What it costs to hold:** 103 B a version at 100,000 rows and 285 B at 1,000,000 (E-55; E-54 measured 104 to 219 B beside a plain `Map`). Memory grows with the window, so close it.
- **What a read costs** (E-55 claim 23): a step or a jump 10 to 12 ns; a row at any version 0.6 to 1.4 µs; a row with 150,473 versions 0.14 to 0.21 µs; 0 wrong answers in 1,680 checks against a refold.
- **It needs the log to reach back**: `history` on the resource, or the tier (older log kept in the object store; not in the first build). Past it: `expired`.
- **Why not on the write path** (E-54, measured at 1e5 and 1e6 rows). A hash-tree root kept per write adds 3.3 to 5.7 µs to a 0.79 to 1.4 µs fold, keeps 1.3 to 1.7 KB a version, and takes the collector from 0.5 % to 15 to 22 % of the time. A hash tree used only as the store still adds 1.1 to 2.2 µs a write. A prior value in the log would add 80 to 150 % to a record's bytes. What would change this: a version per write under about 0.2 µs and 20 B on the live path with the collector under 1 %, or a user on the live path who must read several rows as of one position (LENS 2.9).
- **An app's own undo** can take `prev` from a `tap`. The undo write needs a condition (`if: { version }`), or it can overwrite a write that came in between (reasoned).
- **Forks, tapes and restore are unchanged** (V5-1). `asOf` adds about 3 rules, in a reader library, none in the kernel (LENS 4.4).

## 4. What each call costs

"Trip" is one round trip: about 40 µs at the median on one box, the network's between machines ([E-01]). "Commit" is one disk sync on a majority, shared with every other write in flight: about 1 ms at the median on one box (MEMORY 9.3). Times are TypeScript. **The lens's own costs are E-55's: the lens's and data's share in one process, on data 63fea66, never a whole fero write** (v4's issue path alone is 7.7 to 8.3 µs, PATHS 2.6).

| Call | Trips | Commits | Copies, or whole-resource work | Source |
|---|---|---|---|---|
| a step, `f.data.a.b` | 0 | 0 | none. Nothing kept: 0 to 0.3 B a key (data's handle today keeps 318 to 1,333 B a key for ever). A `Proxy` per step: 49 to 99 ns with one key; 162 to 222 ns (median 205) with keys spread over 1e6 rows | E-55 claims 1, 2 |
| `f.at(k1, k2)` | 0 | 0 | none: −79 to +33 ns over the direct read with keys spread | E-55 claim 1 |
| `f.rows.k`, `held.rows.k`, `held.value` | 0 | 0 | none: one lookup, the row by reference; a row's first read after a write freezes it | PATHS 4.1; PA-8 |
| a read through a lens (two steps and `get()`), held on purpose | 0 | 0 | none: 0.17 to 0.29 µs with one key, 1.6 to 1.7 µs with keys spread over 1e6 rows (a `Map` read: 0.014 to 0.06 and 0.60 to 0.64 µs). So `rows` stays the hot read | E-55 claims 1, 14 |
| `lens.get()`, not held on purpose | 1, each time | 0 | the value, and the highest position this process has seen. **Nothing kept**: 0 rows and 0 SUBs after 100,000 misses. A read never comes from rows only a `connect` keeps, so it costs a trip even when such rows are in memory | E-55 claim 20; PATHS 4.4 |
| `lens.get({ fresh: true })` | 1, plus the leader's round with a majority | 0 | one value | PATHS 4.3 |
| listing `f.rows` or a handle's `rows`; v4's `f.snapshot` | 0 | 0 | **every held row walked** | PA-8 |
| `lens.set(v)`, `f.set(path, v)`, an assignment, `lens.remove()` | 1 to the leader (+1 if this process cannot route: a browser, or a missing partition function) | 1, shared | one encode, kept for resends. The steps add 0.18 to 0.73 µs to a 0.7 to 1.3 µs local data write; a kept lens −0.03 to +0.42 µs; `at()` about 0 | PATHS 3.1; V5-9; E-55 claim 3 |
| `await w.received` / `w.replicated` | the same write; you stop waiting sooner | still 1 | none | PATHS 3.3; V5-11 |
| N writes made together | 1 frame per leader | shared: about 62 records a sync when busy | per record: a decode, a judging, a fold. **At most 512 waiting or 64 MB**; then a plain write is refused `backpressure` (an assignment throws) | PATHS 3.6; [E-02]; LAYERS 4.2 |
| a write with `once` | as a write | 1 | about 221 B at the leader for a day; no early stages | [E-20] |
| N writes awaited one by one | N | N in a row | | PA-40 |
| `f.batch([...])` | 1 | 1 | one log entry | PATHS 3.6 |
| `lens.set(fn)` | as a conditional write, per try | 1 per try | a local read if the partition is held on purpose | section 3.7 |
| `lens.set(v, { from: e })`, a marked write | as a write | a share of 1, per output partition | a 29 B mark. Never refused `backpressure`: it waits and pauses its reader. Not awaited: 122,000 to 134,000 a second, against 239 to 240 awaited | [E-30]; PATHS 4.9; E-55 claim 21 |
| a method on a path, `lens.sell(1)` | 1, to the partition's leader | 1 or more, shared | the path and the argument, encoded once; the server checks the path against `at:` | PA-25; E-55 claim 18 (a stand-in) |
| a method with no path, `f.methods.x(arg)` | 1, +1 per write its server does not lead: 0.66 extra trips a call with 3 servers, 0.80 with 5 | 1 or more, shared | the argument and the result, encoded once each | PATHS 3.4; E-55 claim 18 |
| a call with `once` | 1, plus up to 2 to `#calls`' leader; a path does not save those | **3 in a row** | | PATHS 3.4; V5-2 |
| a call with `retry` | as a call; sent again only if its server is lost | as a call | | code: api/methods.ts:549-575 |
| `lens.here()` on a partition | 1 SUB, shared by every equal lens in this process | 0 | **the partition once**, then one shared frame per change. Here: about 3.2 µs to decode and 0.2 to 1.9 µs to fold a small row. A 100-row room's first picture: 26 to 28 µs in the prototype, at 1e5 rows in all | PATHS 4.5; E-55 claim 6 |
| a second `here()`, `tap` or `connect` on a held selection | 0 | 0 | a lookup and a count: 39 to 45 ns; a second `here()` 163 to 169 ns | E-55 claims 6, 9 |
| `lens.connect(target, …)` | as `here()` | 0 | as `here()`, then the function. A `WeakRef` and a registry entry: 0.13 to 0.33 µs in ordinary jobs, 0.58 to 0.67 µs in one long job that made about 150,000. **Per commit, +28 to +35 ns per weak link**: 10,000 cost 2.2 times 10,000 strong sinks | E-55 claims 6, 11 |
| a dead link the net has not found | 0 | 0 | **a cost the line does not show**: the selection's changes go on crossing, decoding and folding, and its function still runs: 0.80 to 0.90 ms a commit for 1,000 such links, for 7 ms to never (never within 30 s in Chromium). `close()`, a scope or the count is the fix | E-55 claims 12, 13 |
| a lens inside a big partition | as `here()` | 0 | **the whole partition** (first build) | user rule 4 |
| `tap((c) => …)` | 0 | 0 | 92 to 198 ns a commit over no sink when it reads nothing, 63 to 122 of it data's delivery to any sink; reading `c.changes` or `c.now` adds nothing measurable; `c.recs()` 166 to 216 ns; each row handed out frozen on first hand-out, 163 to 220 ns | E-55 review, claim 10 |
| operators right of `here()` | 0 | 0 | a filter about 1 µs per affected view; an ordered view with a window 1.6 to 62 µs a change, by partition size; `group` 2,574 µs a record at 1e6 rows. Released when their handle ends | [E-05]; E-55 claims 16, 26 |
| `f.methods.x(arg).here()`, a served view | 1 SUB | 0 | the view's answer, then only its changes. On a server: the view's work, once for all equal calls, and 9.9 KB to 12.8 MB of memory a view; counted against the cap (`too-many-views`). v4 paid 4.4 to 4.6 µs per subscriber, against 2.0 to 2.4 µs shared. **Not built on the prototype** | PATHS 4.5; E-55 claims 16, 27 |
| class B pushed down (later) | 1 SUB | 0 | only the answer: 677 to 765 B first, 0 to 32 B a change per shape (the partition: 6 KB to 6.6 MB, and 60 to 63 B a change). The same view on a server: 2.3 to 53 µs per view per change, 9.9 KB to 12.8 MB a shape | E-55 claim 16 |
| `lens.changes({ from })` | 1 to open | 0 | **every kept record of the selection** | PATHS 4.5 |
| a reconnect | resumes from the server's position | 0 | only the missed records | PATHS 4.6; E-55 claim 7 |
| `lens.asOf(position)` | 1 log-mode SUB | 0 | the window's records once: 3.6 to 4.4 µs a record to fold with the version lists; 103 to 285 B a version, in the reader only; a step 10 to 12 ns. `f.data.asOf` folds every partition | [E-54]; E-55 claim 23 |
| `depth: 2` | | | a key grows 2 B. Partitions of 100 rows and more: the fold is 0.78 to 1.10 times flat with PA-17's index, and 1.2 to 805 KB **less** memory a partition. One-row partitions: 1.3 to 1.5 times, and +0.9 KB each, until data's D3 | E-55 claim 19 |
| a partition function (later) | | | an index from partition to rows on every copy: memory per row, an update per fold | PA-17 |
| `fero(name)`, a client, by default | 2 to 3 built well | 1 (its session) | none: it holds nothing | PATHS 3.2 |
| `hold: 'all'`, or `f.data.here()` | 1 SUB | 0 | **the whole resource, once; then every write to the resource**, decoded and folded here | PATHS 3.2, 4.5 |
| `hold: '200MB'`: a closed selection opened again | 1 SUB | 0 | a resume (the changes since) if the server can; else the picture again. Nothing while closed; never free | reasoned (LENS 2.2) |
| `fero(name, …)` with a server role, joining | | | the whole log copied and folded; a `dir` and its syncs; a vote or a standby | PATHS 2.1, 5.1 |
| `fero(name, …)` founding a resource | one create-if-absent | about 5 ms; about 35 ms across machines | about 8 KB per server while idle | [E-49]; V5-8 |
| `lock(name)` | as a conditional write | 1 | | P-10 |
| `saga([...])` | | **6 to 7 in a row**, about 7 ms | | PATHS 3.7 |
| a queue message | | 3 (add, take, ack) | | PATHS 4.13 |
| a `service` ask | | 3 | | [E-22] D7 |
| a `derive` output | 1 delivery | a share of 1, per output partition | a 29 B mark. The source is read once however many servers run it: they split its shares | PATHS 4.9; [E-30] |

Nothing on the surface decodes, copies or walks a whole resource except the bold "whole" rows. Most of those say so in their shape: a call that returns everything, or a listing you wrote. **Three do not, so learn them:** `hold: 'all'` (an option, not a line of code), v4's `f.snapshot` (no brackets), and a lens inside a partition, which holds the whole partition (user rule 4).

**Where the surface itself used to cost, and what this page did.**
- `f.snapshot` copied every row per read: `f.rows` is a lookup, and row reads move to it (PA-8).
- A `get` that missed followed its key for the life of the handle: `get()` holds nothing (E-55 claim 20).
- A bare `fero(name)` downloaded the whole resource, then every write to it: the default holds nothing (V5-12 pick 1).
- data's handle kept every child for its parent's life, 318 to 1,333 B a key: a step keeps nothing (E-55 claim 2).
- K lenses on K rows cost data O(K) a commit, 26 µs a write at K = 1,000: through a keyed index, 1.09 to 1.52 times K = 0 at K = 10,000 (median 1.25; bar 1.3; at its edge, E-55 claim 8). That is data's change D1; it needs a pin when it is built.
- A tap that named a parameter cost 1.5 to 1.8 µs a change: one `c` per commit, by reference (E-55 claim 10).
- A method's writes were forwarded on about 2 calls in 3: a call on a path goes to its leader (PA-25).
- `derive` invited one commit per output: a marked write is not awaited, and fero paces it (PATHS 4.9; E-55 claim 21).
- A room's first picture needed an index from partition to rows on every copy (PA-17): with `depth: 2` a room is a partition.
- A promise per write: made only when the handle is awaited (PA-13).
- An early report per write: sent only for writes that asked (PATHS 3.3).
- A client's write went through any server: it goes to the leader (V5-9).

## 5. What changes, and why

### 5.1 From v4

**Kept from v4, on purpose:** `fero(name, opts)`; roles by declared act; writes by plain assignment, on an untyped handle; a write shows when it commits (V4-7); `methods:` as the door (V4-5); `validation`; data's operators as live views (now right of `here()`); `connect(target, 'prop')`; a method that returns a view streams; Ctrl-C (V4-8); `fero.spawn` (V4-9); the config cascade (V4-10); the box directory (V4-3); one process per `dir` (V4-59); user throws go to the fault printer (V4-47); `ctx.data`, `ctx.peer`, `ctx.flush()`; `diag(f)` in `fero/internals`. `f.snapshot`, with v4's meaning and cost. `{ retry: true }` on a call. `f.data.k.remove()`, now the lens verb `remove`.

| v4 | v5 | Why |
|---|---|---|
| a cell keeps its newest stamp (last writer wins); example 17 loses an increment | one leader per partition orders writes; ops, conditions, `set(fn)` | V5-1, V5-6. Counters, stock and locks become correct |
| a write shows when its owner stamps it | a write shows when a majority has it on disk | V5-5. Nothing shown can vanish. It shows about 1 ms later |
| `methods.update(change, { confirm })` | `lens.set(v)` returns a handle; await it, or `.received`, or `.replicated` | V5-5, V5-11: every write goes all the way; you choose when to stop waiting |
| built-in `methods.update / insert / remove / read` | `lens.set`, `lens.remove`, `f.batch`, `lens.get`; `f.methods` holds only yours | one write path, and no clash with a method you name `update`. (The door still refuses a client's plain write when it runs, as v4's refused `methods.update`; a typed client now cannot write it at all) |
| v4's lens calls: `f.data.set(k, v)`, `f.data.k.update(v)`, `f.data.patch(pairs)` | `f.data.k.set(v)`; one `set` per pair | V5-12: one write verb on the address; the others were second names |
| reading a row through `f.snapshot`, which builds the whole picture | `f.rows.k` is one lookup; `f.snapshot` stays, with v4's meaning | PA-8: 87 µs to 0.5 s per read becomes one lookup, for code that moves to `rows` |
| `replicas: N`, and `await f.data` gathering from every member | `lens.get()` and `lens.here()`: a row not held is one trip to one copy | PATHS 4.4: the gather cost members × cells per read |
| `ScopedError` on a sync read of a shard | `FeroError` with `not-held` | one error type; the hint names the call |
| a reconnect downloads the whole resource | a reconnect sends what was missed | [E-31]; E-55 claim 7 |
| `tap(() => …)` or `tap((rec) => …)`, chosen by reading the function's source text | `tap((c) => …)`: one argument per commit | LENS 1.6: one shape; a parameter cost 1.5 to 1.8 µs a change (code data:ops/misc.ts:598-611) |
| `connect(anchor, fn)`: the anchor is checked, then ignored | `connect(target, (target, c) => …)`: the target is held weakly and passed in; the link ends at `close()`, with its scope, or when a target of a kind fero knows (a socket) closes | LENS 2.2; code data:api/index.ts:357-361 |
| settings must match on every member, or they refuse to link | resource settings are records in the resource's own log | V5-2 |
| `WriteResolve`, `WriteReject { reached, reason }` | `Ack`, and one `FeroError { code, outcome, reason, hint }` | `outcome` says whether it may have committed. `e.reason` still prints what it printed |
| a call: `{ retry: true }` | `{ retry: true }` stays; `{ once: name }` is added | `retry` sends an idempotent call again at no extra commit; `once` is at most once, from any process, at three commits |
| `replicas`, `heartbeat.ms`, `seams` | `copies` and `standbys`, `ping.ms`; `seams` gone | Raft needs a fixed, odd set of voters; Raft has heartbeats of its own, so the link's ping gets its own word |
| `dir` per resource, off by default | `dir` per process, on by default for a server | one journal and one disk sync for every resource in the process ([E-12]); every write is on disk (V5-5) |
| `cluster.epoch`, `cluster.partitions` | `cluster.groups`, `cluster.health`; `cluster.writes` stays | the ring and the ballots are gone; health says what is wrong and the fix |

**The examples ladder.** Most rungs keep their files, and every `console.log(f.snapshot)` on a server prints what it printed. The ones whose lesson changes: 03 (the pending row now waits for a majority; and a client with no server yet throws `not-held` on a sync read where v4 printed `{}`), 04 and 08 (the built-in methods become verbs), 10 (`confirm` becomes stages), 12 and 13 (`{ confirm: 'persisted' }` becomes a plain `await`), 16 (scoped becomes "holds what its links name"), 17 (the lost increment becomes `op.incr`, with the old race shown as the reason). **And every rung whose client reads rows**: a bare client now holds nothing, so its `client.rows.k` throws `not-held` until a line says `hold: 'all'`, `f.data.here()`, or reads through a handle (V5-12 pick 1; about 20 READMEs, LENS 7 Q1).

### 5.2 From COMP2's API, because the design changed

| COMP2's page | This page | Decision |
|---|---|---|
| one cluster per project; a resource is an entry in the project's catalog; `#meta` holds settings and runs one loop | a resource is its own cluster; its settings are in its own log; each leader heals its own group | V5-2 |
| "an idle resource costs about 85 B per touched slot"; `fero('doc:' + id)` is fine | about 8 KB per server and a few ms to found; make few | V5-8; [E-49] |
| `fero.alter('#meta', …)`, cluster keys, `too-many-resources`, health's `meta-down` | gone. Timing keys are the resource's or the process's own | V5-2 |
| the role is per process | the role is per resource | V5-2 point 4 |
| `seeds` are the founders of a cluster; `hosts` is how it grows | founding needs no list: it is one create-if-absent per resource. `rendezvous` says where the directory is asked, and takes a list across machines | V5-3; V5-10 fix 1 |
| any process may create a resource whose keys are all plain data | a resource exists once a server opens it | V5-2: there are no project groups to hold it |
| every verb answers at the commit; "no per-write confirm" | the write handle has `received` and `replicated` | V5-5, V5-11 |
| `durability` per resource: `persisted`, `none`, `memory`; `needs-persisted` | not a key in the first build: every write commits on disk | V5-5 |
| a server forwards a client's write | a client sends to the leader; forwarding stays for one-link clients | V5-9 |
| `partition` is plain data only | `depth: 1 \| 2` is plain data; a function, later, with its cost stated | V5-2 point 1; V5-12 pick 4 |

V5-10's nine fixes change no call. Two are felt: a client that lost every member it knew asks the directory again by itself (fix 2), so an app never re-opens a resource; and a seed is applied once with no mark (fix 5).

### 5.3 From COMP2's API, to be easier to guess

Each is a rename, a short form of calls that exist, or removes a cost. None adds a trip, a copy, a decode or a pass over a resource. (Rows the lens changed again point to section 5.5.)

| COMP2's page | This page | Why |
|---|---|---|
| `f.snapshot.k`, promised as a property read but built as a full copy | `f.rows.k`, a lookup; `f.snapshot` stays what v4 made it, a copy | "snapshot" says "a copy"; "rows" says "the rows, now" (PA-8) |
| `f.read({ from })` | `lens.changes({ from })`; `from` defaults to `'latest'` | "read" sounds like reading a row; the lens is the selector (5.5) |
| `fero.cursor(text)` to bring back a saved cursor | the saved text goes back in as `from` | one step less; a wrong text is refused `bad-cursor` at the open |
| `shortfall`, `holistic` | one code, `not-held`, whose hint names the call | the two names said nothing; the fix is the same kind |
| `cache: { memory }` | by default a client holds nothing; `hold: 'all'` or a size | the old key hid a change of mode and a whole-resource download (5.5) |
| `id` on a write, `key` on a call | `once` on both | one name for one idea; `key` already means a row key. A write with `once` answers at its commit only |
| a `get` that misses always follows | `get()` reads once and holds nothing; `here()` holds | a read and a hold are two lines (5.5) |
| a cron job named by `once`, which lasts a day | `add(job, { cron, key })` | a schedule lasts as long as its row |
| check-then-set by hand: `get({ version: true })`, then `set({ if: { version } })` | also `lens.set(fn)` | the safe form becomes the short form |
| no placement for methods | a method called on a path runs at that path's leader, and declares `at:` | PA-25: one trip saved on about 2 calls in 3 (5.5) |
| `if: { fence: l.fence }` | `if: { lock: l }`, and `lock(name, fn)` | "fence" is the mechanism's word, not the user's wish |
| `group(orders, 'billing')` | `consumer(orders, 'billing')` | `group` is already data's operator and the design's word for a Raft group |
| `derive`'s `out.set` returns a promise | a marked write, `{ from: e }`, not awaited and paced | the slow way is not the short way (PATHS 4.9; 5.5) |
| `fero<Row, typeof methods>` with `methods` exported by hand | `export type Shop = typeof shop` and `fero<Shop>` for a client; a seed or `fero.of<Row>()` for the server | one type argument; and `fero<Row>(name, { methods })`, which would be untyped, does not compile |
| `copies`, and `standbys` that counted the voters too | `copies` (the voters), `standbys` (more copies that do not vote) | the old `standbys` was hard to explain |
| `erase(partition)` on the resource | `fero.erase(name, partition)`, beside `fero.drop` | an admin act, not a member of every resource |
| "writer" | "leader" | Raft's word and the decisions' word; "writer time" keeps its name |
| `node-config` | `config` | one code for "this key cannot be set here" |

### 5.4 Kept, and explained better

These read as hard on COMP2's page. The shape was right; the explanation was missing.

1. **Assignment and `set`.** "Assignment is `set` without the answer." The old page listed them in different sections.
2. **Roles.** "A process that brings something serves; a process that only names the resource is a client." The old page gave a list of twelve markers first.
3. **The options bag.** Ask "who remembers it?": this process, the resource, or this open (section 3.1).
4. **"A rung per resource, never per write", and then answers per call.** Two different things. What a commit means is the same for every write: on disk at a majority. A **stage** is how far your own write has got when you hear back. The word "rung" leaves the app's page.
5. **`here`, `changes` and `tap`.** Rows, or records. `here()` keeps chosen rows up to date here; `tap` is one call per commit on anything live; `changes` hands you every record in order (section 3.10).
6. **`fresh`.** "A local read can be a moment behind another process's write. `fresh` asks the leader." Most apps never need it: a process always sees its own writes and never reads backwards.
7. **`outcome`.** One question: did my write commit? `refused`: no, and it never will. `unknown`: maybe; fero keeps trying, and `cluster.writes.lookup(attempt)` tells later.
8. **Versions and cursors.** A version is a row's place in its partition's order. A cursor is a bookmark. Both are opaque text. The rest is LAYERS'.
9. **"A check-then-set must carry a condition or be an op."** The most useful rule on the page, once buried under "Methods". It follows from one leader judging on the newest state: your read is a copy, and it can be old by the time your write lands.
10. **`batch`.** Read as "for speed"; it is "all or none".
11. **Twelve words at one level.** An app needs five (section 1). Slots, groups, attempts and sessions are plumbing.
12. **Labels on every line** (L0 to L5, A-nn, RR-nn). Builder's notes; they stay in the source marks and in LAYERS.

### 5.5 From the 2026-11-16 page, for the lens (V5-12)

The owner reviewed the 2026-11-16 page and asked for the lens they had explored before data's rewrite: `resource.a.b.c` builds an address, `connect()` pipes the state and then its changes to a target, calls are a space apart from keys, operators before and after the call split server work from local work, and `r.a.b.c.method()` runs at that path's leader. [LENS.md](LENS.md) is the full answer; V5-12 records the fourteen picks. **What went, what replaced it, and why:**

| Gone | Now | Why |
|---|---|---|
| `f.follow(of)` and the `Follow` handle | `f.data.room1.here()`. A list: two `here()`s in one scope, which ride one link (reasoned). `{ prefix }`: with `depth: 2`, `f.data.ada.here()`, with no walk of partition names. `{ share }` stays inside `consumer`, where it always was | one word, `here()`, for "hold it live", whatever the source (LENS 2.6). A user no longer learns `follow` (LENS 4.4) |
| `f.methods.x(arg).open()` | `f.methods.x(arg).here()` | the same word for a served view as for a partition (LENS 2.6) |
| `near: true \| 'sku'` on a method | a method called on a path runs at that path's leader; `{ at: 'row' \| 'partition' \| 'any', run }` says where it may be called, and the server refuses another path `bad-path` | V5-12 picks 3 and 13. The caller's line carries the row, so there is no hint to store or learn. The declared word is a guard the server enforces: on E-55's first build, with no declared place, a client changed a row's shape through the door (LENS 2.4) |
| `partition: { before: '/' }` | `depth: 2`: the first key is the partition | V5-12 pick 4. `{ before }` was the same idea spelled as a text rule, and it needed an index from partition to rows on every copy (PA-17). A message as a field of its room would lose a row's version, conditions, expiry and early stages (LENS 1.1) |
| `f.data.set(k, v)` | `f.data.k.set(v)`, or `f.set([k], v)` | V5-12. A third spelling of the same write. Three stay: assignment (untyped), `lens.set(v)`, `f.set(path, v)` (LENS 2.5) |
| `hold: 'all'` as the default, and `hold: 'asked'` | by default a client holds nothing until a `here()` or a `tap` says what; `hold: 'all'` (or `f.data.here()`) for everything; a size is a cache of pictures | V5-12 pick 1. Every download is a line you wrote. A bare `fero(name)` in a job no longer downloads the resource and then every write to it |
| `get(k)` that followed `k` for good, and `get(k, { hold: false })` | `lens.get()`: reads once, holds nothing | V5-12. The hidden follow was a slow leak the line did not show; E-55 claim 20 holds nothing after 100,000 misses |
| `f.get(k)` on the resource | `f.data[k].get()`, or `f.at(k).get()` with no `Proxy` | LENS 2.6: the read is a verb on the address (*this page's reading*: LENS names `f.set(path, v)` as the array form that stays, and no array form of `get`) |
| `changes({ of })` | `lens.changes()`: the lens is the selector | V5-12; LENS 4.2 item 7 |
| `derive`'s `out`, `Out`, `OutTo` | a marked write, `{ from: e }`, on any write; `target.marks(name)`; `target.mark(e)`; a loop writes another resource through that resource's own lens. (`ctx.use(other)` stays for a method's handler: no decision removed it) | V5-12 pick 7. The exactness is visible on the write line. `derive()` stays, as a library that paces the loop, runs it once and sends bare marks (LENS 2.8) |
| `f.data.*` untyped (data's own proxy, `LiveData`) | typed lenses: a wrong field, a wrong value, an early stage on a judged write, a method below its declared path, a write on a door-closed client, and `await lens` used as a value are compile errors | LENS 2.1; E-55 claim 5 |
| `f.data.snapshot()`, `view.snapshot()` | a handle's `rows`; the whole frozen picture stays `f.snapshot` | *this page's reading*: on the lens a call is a verb, and `snapshot` is not one of the lens's verbs; a view is read through its handle (user rule 5) |
| a token's `follow` claim | its `read` claim: the partitions a client may read or hold | *this page's reading*: the claim keeps its meaning, under a word that still exists |
| (new) | `here`, `connect`, `get` as a verb, `at`, `depth`, `ctx.at`, a method's `at:`, `{ from: e }` with `marks()` and `mark()`, `asOf`, `call`, connect's `closes`, `scope`, `too-many-views`, `bad-path`, `bad-key` | LENS 4.4 |

- **What a user no longer has to know** (LENS 4.4): `follow`, `.open()`, `{ before }`, the two meanings of `tap`, `f.data.set`, the hidden follow inside `get`, and `near` as a hint to learn.
- **What stays, said plainly** (LENS 4.4): `hold` still has three values (nothing, `'all'`, a size). A write still has three spellings (assignment, `lens.set`, `f.set(path, v)`). A method on a path still declares one word (`at:`), where `near: true` stood.
- **Users learn seven rules** (section 2), and four of them the types cannot check (section 7).
- **The price in rules: about +12 to +18 on 416, 3 to 4 %, for the first build, plus three in a reader library for `asOf`** (reasoned, not modelled; LENS 4.4). By V5-6's measure the lens costs rules and cannot win on rules alone. The trade: the seven places a computation can run (LENS 2.3) are said with one address and one line, `here()`, where the 2026-11-16 page named four of them with four unrelated words; a `get` no longer hides a follow; and `f.data.*` is typed.
- **data changes for it, in TypeScript, none in Rust** (V5-12 pick 9; LENS 4.5): D1 (path subscriptions through a keyed index) and D2 (the uncached, callable lens) first; then D3 (two-level stores) and D4 (one sink shape). Each is useful to data alone.

## 6. The declarations

What every code block on this page compiles against. **Against the 2026-11-16 page's `fero.d.ts`:** the lens (`Lens`, `Verbs`, `WriteVerbs`, `RowVerbs`, path calls, `at`), what a link gives (`Held`, `View`, `Sel`, `Link`, `Commit`, `Change`, `Value`, `Past`), methods that declare where they may be called (`MethodDef`, `Where`, `Ctx.at`, `PathCalls`, `RootCalls`), `depth` and `Role`, marks (`MarkOpts`, `marks`, `mark`), `scope`, `linger`, `views`, and the codes `bad-path`, `bad-key` and `too-many-views`. **Gone:** `Follow`, `Selector`, `Share`, `LiveData`, `LiveCall.open`, `near`, `hold: 'asked'`, `get`'s `hold`, `changes`' `of`, `Out`, `OutTo`, `{ before }`, and `get` on the resource. **Kept:** `ctx.use(other)`, now giving the other resource's handle.

**How the types know a role.** `Resource<Row, M, D, R>` carries the row type, the methods, the depth and what the types know of the role. A server's own handle is `'server'`. `fero<Shop>(name)` turns it into `'client'`, and a client of a resource with methods has no writes on its lenses or its root (V4-5). A handle typed by its rows only (`fero<Row>`) is either role, so the types let it write and leave its calls untyped.

**Where the types are weaker than the text** (stated, not fixed):
- `f.set(path, v)` checks a whole row's value; a field's value (a longer path) is not checked, and neither is a value under `f.at(…)` past the row.
- A depth-2 seed does not give the row type: name it, `fero<Msg, 2>` or `fero.of<Msg, 2>()`. Its `data` is checked against that type.
- The role is known only for a server's own handle and for a client typed by `fero<Shop>`. Elsewhere `methods-only` is found when the write runs.
- `ctx.at` of a method declared `at: 'any'` is untyped: it may be any kind of lens.
- A saga `Step`'s value is not checked against its lens's type.
- **`mark` and `claim` are hidden only from a typed client of a resource with methods.** On any other handle they compile; the server refuses a client's with `methods-only`.
- **The depth type argument is not tied to the founding `depth`.** `fero<Msg, 2>('chat', { server: true })` compiles and would found at depth 1; a later open that disagrees with the stored depth is refused `config-differs`.
- **`connect(target, 'prop')` checks the property's name, not its type.** A number lens connected to a string property compiles (`textContent` takes it as text).
- **A `batch` item's whole-row value may carry an extra field.** A wrong field is caught (section 12), an added one is not: TypeScript checks the item against the field form too.
- **A whole-resource operator left of `here()` compiles on any handle.** A client is refused `not-held` when it runs (section 3.10).
- The probe names, the linger, the cap on served views, `rules.write`'s effect on early stages, and every user rule of section 7 are not in the types.
- The libraries keep their shape.

```ts
// file: fero.d.ts — fero v5's public API for the chosen design (V5-1 to V5-12). Declarations only.
import type { ChangeRecordV2 } from 'data'
/** One change record: data's own, and the wire's. `c.recs()` gives them; an Entry carries one. */
export type Rec = Exclude<ChangeRecordV2, { type: 'move' }>

// ── words ────────────────────────────────────────────────────────────────
export type Key = string
/** A path as an array: a row key, then the fields below it (depth 2: the partition first). */
export type Path = readonly [Key | number, ...(string | number)[]]
export type Partition = string
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`
export type Size = `${number}${'B' | 'KB' | 'MB' | 'GB' | 'TB'}`
/** A row's place in its partition's log. Opaque. Two versions of one partition compare with `<`. */
export type Version = string & { readonly __fero: 'version' }
/** A reader's place across many partitions. Opaque text: save it, pass it back as `from`. */
export type Cursor = string & { readonly __fero: 'cursor' }
export type AttemptId = string & { readonly __fero: 'attempt' }
export type Time = number
/** Where to look back to: a version, a cursor, or a writer time (V5-4). */
export type Position = Version | Cursor | Time
/** 1 (default): `f.data.k` is a row and its own partition. 2: `f.data.p.k` is a row, `p` its partition. */
export type Depth = 1 | 2
/** What the types know of this handle's role: 'server', 'client', or both (they cannot tell). */
export type Role = 'server' | 'client'
/** The rows of a resource as a tree: depth 1 `{ row }`, depth 2 `{ partition: { row } }`. */
export type Tree<Row, D extends Depth> = D extends 2 ? Record<Key, Record<Key, Row>> : Record<Key, Row>

// ── fero(name, opts) ─────────────────────────────────────────────────────
/** Open a resource. Four typed forms:
 *  - `fero<Shop>(name)`, with `export type Shop = typeof shop` on the server: a client typed by the server.
 *    When the server has methods, this client's lenses have no writes (V4-5).
 *  - a seed and methods: `fero(name, { data, methods })`: both types worked out.
 *  - `fero.of<Row>()(name, { methods })`: the row type by hand, the methods worked out.
 *  - `fero<Row>(name, opts)` or `fero<Row, 2>(name, { depth: 2 })`: the row type alone; calls untyped.
 *  `fero<Row>(name, { methods })` does not compile: it would leave the methods untyped. */
export declare function fero<S extends Resource<any, any, any, any> = Resource>(
  name: string,
  opts?: ProcessOptions & OpenOptions,
): Promise<ClientOf<S>>
export declare function fero<Row, M extends Methods<Row, D>, D extends Depth = 1>(
  name: string,
  opts: Options<Row, M, D> & { methods: M },
): Promise<Resource<Row, M, D, 'server'>>
export declare function fero<Row = any, D extends Depth = 1>(
  name: string,
  opts?: Options<Row, {}, D> & { methods?: never },
): Promise<Resource<Row, Methods, D>>
/** A server's handle seen from a client: the same types; a handle the types knew as a server becomes a client. */
export type ClientOf<S> = S extends Resource<infer Row, infer M, infer D, infer R>
  ? Resource<Row, M, D, [R] extends ['server'] ? 'client' : R> : never
export type Options<Row = any, M = {}, D extends Depth = 1> = ProcessOptions & ResourceOptions<Row, M, D> & OpenOptions

/** Remembered by this process only. A restart changes them. */
export interface ProcessOptions {
  project?: string
  uuid?: string
  listen?: string | false       // false: a solo node with no socket, for tests
  advertise?: string
  rendezvous?: string | readonly string[] | false   // where the directory is asked (V4-3, V5-3)
  hosts?: readonly string[]     // this resource's members by hand, when the directory is off
  dir?: string | false          // one per process: every resource it serves shares one journal
  object?: string | false       // the store where a resource's id is created once
  secret?: string | false
  token?: string
  admin?: string
  memory?: Size
  ping?: { ms?: number }
  evict?: { after?: number }
  settle?: { ms?: number }
  handback?: { max?: number }   // leader hand-backs in flight; default 8 (V5-10)
  bulk?: { rate?: Size }        // bytes a second for catch-up and other bulk work (V5-9)
  linger?: { ms?: number }      // how long a selection nobody uses stays subscribed (section 3.10)
  redial?: { ms?: number; tries?: number }
  leave?: { ms?: number }
  journal?: { cap?: number }
  diag?: { allow?: Record<string, string> }
  connect?: { wait?: Duration }
  shuffle?: boolean | number
}

/** Remembered by the resource's own log (V5-2). The founding open writes them; fero.alter changes some. */
export interface ResourceOptions<Row = any, M = {}, D extends Depth = 1> {
  /** Where a row begins. The first key is always the partition. Fixed at founding. */
  depth?: D
  /** Built later (V5-12 pick 4): a function of the row key, for partitions a key level cannot say.
   *  Code: the same on every process that routes by it. Fixed at founding. */
  partition?: (key: Key) => Partition
  history?: History
  rows?: boolean | RowsRule<Row>
  copies?: 1 | 3 | 5            // the copies whose disks decide a commit
  standbys?: number             // more full copies that do not vote
  election?: { ms?: number; jitter?: number }
  /** The cap on live served views (class C, section 3.10): per client, and for the whole resource. */
  views?: { client?: number; max?: number }
  // the seed and code: a server only
  /** The first rows. At depth 1 it gives the row type; at depth 2 name it: `fero<Msg, 2>`. */
  data?: D extends 2 ? Record<Key, Record<Key, NoInfer<Row>>> : Record<Key, Row>
  methods?: M
  validation?: (rec: Rec) => true | string
  schema?: Schema<Row>
  rules?: {
    write?: (who: Who, rec: Rec, current: Row | undefined) => true | string
    read?: (who: Who, partition: Partition) => boolean
  }
  load?: (key: Key, ctx: { now(): Time }) => Row | undefined | Promise<Row | undefined>
  shape?: { version: number; up?: Record<number, Upcaster> }
}
export type History = 0 | 'all' | number | `${number}${'s' | 'm' | 'h' | 'd'}` | `${number}${'KB' | 'MB' | 'GB' | 'TB'}`
export interface RowsRule<Row> { ttl?: Duration; max?: number; where?: (row: Row) => boolean; while?: 'session' }
export type Upcaster = (rec: Rec) => Rec | readonly Rec[] | null
export interface Schema<Row> {
  readonly '~standard': {
    readonly version: 1
    readonly vendor: string
    validate(value: unknown): { value: Row; issues?: undefined } | { issues: readonly { message: string; path?: readonly PropertyKey[] }[] }
  }
}

/** Remembered by nobody: how this open behaves. */
export interface OpenOptions {
  /** true: serve this resource from this process. false: stay a client. Default: by declared act. */
  server?: boolean
  /** A client holds nothing until a here() or a tap says what (the default).
   *  'all': every row, kept live: the open sends the whole resource once, then every write.
   *  A size: a cache of pictures of closed selections, inside that bound. Not subscribed, never read from. */
  hold?: 'all' | Size
  signals?: boolean
  bind?: 'live' | 'sim' | `tape:${string}` | `./${string}`
}

// ── the resource ─────────────────────────────────────────────────────────
/** A handle. `data` is the address of everything; `rows` is the fast sync read. */
export type Resource<Row = any, M = Methods, D extends Depth = 1, R extends Role = Role> =
  Handle<Row, M, D, R> & (Door<M, R> extends true ? {} : RootWrites<Row, D>)
export interface Handle<Row, M, D extends Depth, R extends Role> {
  readonly name: string
  /** The root lens. A step is an address: no trip, no read. */
  readonly data: Lens<Tree<Row, D>, Row, M, 'root', D, R>
  /** The rows this process holds for the whole resource: a server's, or `hold: 'all'`'s. One lookup.
   *  Anything else throws 'not-held': read a partition held by here() through its handle. */
  readonly rows: RowsOf<Row, D>
  /** v4's whole picture, with v4's meaning: a new frozen container of every row on each access. O(rows). */
  readonly snapshot: RowsOf<Row, D>
  /** The calls with no path: bare functions, and methods declared `at: 'any'`. */
  readonly methods: RootCalls<M>
  /** The same address as `f.data.a.b`, with no Proxy. A number key becomes its string. */
  readonly at: AtFn<Row, M, 'root', D, R>
  /** This resource's marks for a reader name, as a cursor for `changes({ from })`. */
  marks(name: string): PromiseLike<Cursor>
  /** This resource's own members, groups, health and writes in flight. */
  readonly cluster: ClusterView
  destroy(): Promise<boolean>
}
/** V4-5: a client typed by a server that has methods changes data only through them. */
export type Door<M, R extends Role> = [R] extends ['client'] ? (keyof M extends never ? false : true) : false
/** The array form of every write, with `mark` and `claim`. No Proxy. `ctx.set`, `batch` items and
 *  libraries use it. A client typed by a server that has methods has none of these (V4-5). */
export interface RootWrites<Row, D extends Depth> {
  set(path: RowPath<D>, value: Op, opts?: UnmarkedOpts | MarkOpts): Judged
  set(path: RowPath<D>, fn: (row: Row | undefined) => Row | undefined, opts?: Omit<WriteOpts, 'if'>): Judged<Ack | undefined>
  set(path: RowPath<D>, value: Row, opts?: PlainOpts): Write
  set(path: RowPath<D>, value: Row, opts: JudgedOpts | MarkOpts): Judged
  set(path: FieldPath<D>, value: unknown, opts?: UnmarkedOpts | MarkOpts): Judged   // a field: its value is not checked
  remove(path: RowPath<D>, opts: JudgedOpts | MarkOpts): Judged
  remove(path: RowPath<D>, opts?: PlainOpts): Write
  remove(path: FieldPath<D>, opts?: UnmarkedOpts | MarkOpts): Judged
  touch(path: RowPath<D>, opts?: TouchOpts): Judged
  /** A bare mark: source record `e` is applied, and nothing is written. A write to this resource's marks. */
  mark(e: Entry<any>): Judged
  /** For libraries: the leader leases the first takeable rows of a partition to the caller. */
  claim(opts: ClaimOpts<Row>): Promise<Claimed<Row>[]>
  /** Several changes to ONE partition: one log entry, all or none. Not needed for speed. */
  batch(writes: readonly BatchWrite<Row, D>[], opts?: { once?: string; timeout?: Duration }): Judged<Ack[]>
}
/** A row's path: `[row]`, or `[partition, row]` at depth 2. A field's path goes on below the row. */
export type RowPath<D extends Depth> = D extends 2 ? readonly [Key | number, Key | number] : readonly [Key | number]
export type FieldPath<D extends Depth> = D extends 2
  ? readonly [Key | number, Key | number, string | number, ...(string | number)[]]
  : readonly [Key | number, string | number, ...(string | number)[]]
export type Rows<Row> = Readonly<Record<Key, Row | undefined>>
export type RowsOf<Row, D extends Depth> = D extends 2 ? Readonly<Record<Key, Rows<Row> | undefined>> : Rows<Row>
export type BatchWrite<Row = any, D extends Depth = 1> =
  | { key: RowPath<D>; value?: Row | Op; remove?: true; if?: Cond; ttl?: Duration }     // a whole row: checked against Row
  | { key: FieldPath<D>; value?: unknown; remove?: true; if?: Cond; ttl?: Duration }   // a field: not checked
export interface ClaimOpts<Row> { partition: Partition; n?: number; lease: Duration; due?: keyof Row & string }
export interface Claimed<Row> { key: Key; value: Row; token: Version; until: Time; deliveries: number }

// ── the lens ─────────────────────────────────────────────────────────────
/** Where a lens points: the root, a partition (depth 2 only), a row, or below a row. */
export type Kind = 'root' | 'part' | 'row' | 'field'
type Child<K extends Kind, D extends Depth> = K extends 'root' ? (D extends 2 ? 'part' : 'row') : K extends 'part' ? 'row' : 'field'
type IsAny<T> = 0 extends 1 & T ? true : false
/** A lens: an address. A property read is a step: no trip, no read, nothing kept. A call is a verb on the
 *  path before it. Not a promise: `await lens` gives the lens back (seven probe names read undefined). */
export type Lens<T, Row, M, K extends Kind, D extends Depth, R extends Role> =
  Verbs<T, Row, M, K, D, R>
  & (K extends 'row' | 'field' ? (Door<M, R> extends true ? {} : WriteVerbs<T, K>) : {})
  & (K extends 'row' ? (Door<M, R> extends true ? {} : RowVerbs) : {})
  & PathCalls<M, K, D>
  & (K extends 'root' | 'part' ? Operators<Row> : {})
  & Steps<T, Row, M, K, D, R>
type Steps<T, Row, M, K extends Kind, D extends Depth, R extends Role> =
  K extends 'root' | 'part' ? (IsAny<Row> extends true ? { [key: string]: any } : { readonly [key: string]: Lens<K extends 'root' ? (D extends 2 ? Record<Key, Row> : Row) : Row, Row, M, Child<K, D>, D, R> })
  : IsAny<T> extends true ? { [key: string]: any }
  : T extends readonly (infer E)[] ? { readonly [i: number]: Lens<E, Row, M, 'field', D, R> }
  : T extends object ? { readonly [P in keyof T]-?: Lens<T[P], Row, M, 'field', D, R> }
  : {}

/** The verbs every lens has. */
export interface Verbs<T, Row, M, K extends Kind, D extends Depth, R extends Role> {
  /** Read once: here if the partition is held on purpose, else one trip. Keeps nothing. */
  get(opts: GetOpts & { version: true }): Promise<{ value: T; version: Version } | undefined>
  get(opts?: GetOpts): Promise<T | undefined>
  /** Hold it here, live: the picture, then each commit. Counted and shared with every equal lens. */
  here(): Held<T, Row>
  /** here() tied to a target: fero holds the target weakly and passes it in. It ends at close(), with its
   *  scope, or when a target of a kind fero knows closes. For any other target the collector is only the net. */
  connect<X extends object>(target: X, apply: (target: X, c: Commit<T, Row>) => void, opts?: ConnectOpts): Link
  connect<X extends object>(target: X, prop: keyof X & string, opts?: ConnectOpts): Link
  /** A strong sink: one call per commit, until close() or its scope. */
  tap(fn: (c: Commit<T, Row>) => void): Link
  /** Records: every committed change under this lens, in order, from a position (default: from now on). */
  changes(opts?: ChangesOpts): Changes<Row>
  /** This lens as it was. Read-only; folded here (section 3.12). */
  asOf(pos: Position): Promise<Past<T, Row>>
  /** A step by a key held in a variable, or a key with a probe name. Numbers become strings. */
  readonly at: AtFn<Row, M, K, D, R>
  /** A method by name: the way out of a clash with a verb. Only the methods this kind of lens may call. */
  call<N extends (string extends keyof M ? string : keyof PathCalls<M, K, D>) & keyof M & string>(name: N, ...args: ArgsOf<M[N]>): CallOf<ReturnOf<M[N]>>
}
type AtFn<Row, M, K extends Kind, D extends Depth, R extends Role> =
  K extends 'root' ? (D extends 2
    ? { (part: Key | number): Lens<Record<Key, Row>, Row, M, 'part', D, R>
        (part: Key | number, row: Key | number): Lens<Row, Row, M, 'row', D, R>
        (part: Key | number, row: Key | number, ...fields: (string | number)[]): Lens<any, Row, M, 'field', D, R> }
    : { (row: Key | number): Lens<Row, Row, M, 'row', D, R>
        (row: Key | number, ...fields: (string | number)[]): Lens<any, Row, M, 'field', D, R> })
  : K extends 'part'
    ? { (row: Key | number): Lens<Row, Row, M, 'row', D, R>
        (row: Key | number, ...fields: (string | number)[]): Lens<any, Row, M, 'field', D, R> }
  : (...fields: (string | number)[]) => Lens<any, Row, M, 'field', D, R>
export interface GetOpts {
  fresh?: boolean      // ask the leader: one trip plus its round with a majority; no disk
  version?: boolean
  timeout?: Duration
}
export interface ConnectOpts {
  /** The event that says the target closed, for a kind fero does not know. fero knows a Node
   *  EventEmitter ('close'), a WebSocket and a MessagePort. Anything else is left alone. */
  closes?: string
}

// ── writes ───────────────────────────────────────────────────────────────
export interface WriteOpts {
  if?: Cond
  ttl?: Duration
  while?: 'session'
  /** A name you pick: a resend under the same name within a day gets the first answer.
   *  A named write is judged (the name may be taken), so it answers at its commit only. */
  once?: string
  timeout?: Duration
}
export type PlainOpts = Omit<WriteOpts, 'if' | 'once'> & { if?: undefined; once?: undefined; from?: undefined }
export type JudgedOpts = WriteOpts & ({ if: Cond } | { once: string }) & { from?: undefined }
/** Any write options but a mark. */
export type UnmarkedOpts = WriteOpts & { from?: undefined }
/** A marked write: the write and "source record `e` is applied" land in one log entry of this resource.
 *  The leader skips it at or below its stored mark. Commit only. Never refused 'backpressure': it waits,
 *  and the reader `e` came from stops yielding until the line is short again.
 *  It takes no `once` name: the mark already makes it count once (section 3.11; this page's reading). */
export type MarkOpts = Omit<WriteOpts, 'once'> & { from: Entry<any>; once?: undefined }
export interface TouchOpts { ttl?: Duration; lease?: Duration; if?: Cond; once?: string; timeout?: Duration }
/** The writes on a row or field lens. Only a plain whole-row write reports early stages (V5-11). */
export interface WriteVerbs<T, K extends Kind> {
  set(value: Op, opts?: UnmarkedOpts | MarkOpts): Judged
  /** Read, decide, write: `fn` gets the value, returns the next one (undefined: write nothing).
   *  Written `if` unchanged since the read; on a conflict it reads again and calls `fn` again. */
  set(fn: (now: T | undefined) => T | undefined, opts?: Omit<WriteOpts, 'if'>): Judged<Ack | undefined>
  set(value: T, opts?: PlainOpts): K extends 'row' ? Write : Judged
  set(value: T, opts: JudgedOpts | MarkOpts): Judged
  remove(opts: JudgedOpts | MarkOpts): Judged
  remove(opts?: PlainOpts): K extends 'row' ? Write : Judged
}
/** On a row lens only: a ttl and a lease belong to a row, not to a field. */
export interface RowVerbs {
  /** Keep the value; reset its ttl or lease. */
  touch(opts?: TouchOpts): Judged
}
export interface Cond {
  absent?: true
  present?: true
  version?: Version
  equals?: unknown
  lock?: LockRef       // refused 'fenced' if this partition's leader has seen a newer holder
  expired?: true
}
export interface Op { readonly __op: 'incr' | 'push' | 'merge' | 'max' | 'min' | 'now' }
export declare const op: {
  incr(n: number, bounds?: { min?: number; max?: number }): Op
  push(...items: unknown[]): Op
  merge(fields: Record<string, unknown>): Op
  max(x: number | string): Op
  min(x: number | string): Op
  now(plus?: Duration): Op
}
/** The committed answer. */
export interface Ack { key: Path; version: Version; attempt: AttemptId; value?: any }
/** A progress report: how far the write got. No version, no value (V5-11). */
export interface Early { key: Path; attempt: AttemptId; stage: 'received' | 'replicated' }
/** A write's handle. Awaiting it answers at the commit. A promise is made only when it is awaited. */
export interface Judged<A = Ack> extends PromiseLike<A> {
  catch(fn: (e: FeroError) => unknown): Promise<unknown>
}
/** A write that cannot be refused on state: it also reports its earlier stages.
 *  A stage the write never reached rejects with the write's own error (a refusal before the
 *  leader appended it, a timeout). Once a stage has resolved, the handle never ends in a refusal. */
export interface Write extends Judged {
  readonly received: Promise<Early>     // the leader appended it
  readonly replicated: Promise<Early>   // a majority handed it to their operating systems
}

// ── staying up to date: here, connect, tap ───────────────────────────────
/** One live connection. It ends at close(), with its scope, when its target closes, or when nobody uses it. */
export interface Link {
  readonly ready: Promise<void>   // the first picture has arrived
  close(): void
}
/** One argument per commit, by reference. `changes` and `now` are made only when read. Rows are frozen. */
export interface Commit<T, Row> {
  /** True once: `changes` is then the picture so far, as adds. */
  readonly first: boolean
  readonly changes: readonly Change<Row>[]
  /** The latest state, read where it is: a lookup, not a copy. */
  readonly now: { readonly rows: Rows<Row>; readonly value: T | undefined }
  /** The wire-shaped records of this commit, built once and shared by every sink that asks. */
  recs(): readonly Rec[]
  /** Their JSON text, built once per commit and shared. */
  text(): string
}
export interface Change<Row> { readonly type: 'add' | 'update' | 'remove'; readonly key: Key; readonly row: Row | undefined; readonly prev: Row | undefined }
/** What here() gives: read through it. Operators right of here() run here, functions included. */
export interface Held<T, Row> extends Link, LocalOps<Row> {
  readonly rows: Rows<Row>
  readonly value: T | undefined
  tap(fn: (c: Commit<T, Row>) => void): Link
  connect<X extends object>(target: X, apply: (target: X, c: Commit<T, Row>) => void, opts?: ConnectOpts): Link
  connect<X extends object>(target: X, prop: keyof X & string, opts?: ConnectOpts): Link
}
/** A live view: right of here(), or served by a method. It ends with the handle it was made from. */
export interface View<Row> extends Held<Rows<Row>, Row> {}
/** A live value computed from rows (a sum, a count). */
export interface Value<V> extends Link {
  readonly value: V
  tap(fn: (c: Commit<V, never>) => void): Link
  connect<X extends object>(target: X, apply: (target: X, c: Commit<V, never>) => void, opts?: ConnectOpts): Link
  connect<X extends object>(target: X, prop: keyof X & string, opts?: ConnectOpts): Link
}
/** Plain data: these may stand left of here() and may run on a server. */
interface PlainOps<Row, Out> {
  gt(field: keyof Row & string, v: number | string): Out
  lt(field: keyof Row & string, v: number | string): Out
  gte(field: keyof Row & string, v: number | string): Out
  lte(field: keyof Row & string, v: number | string): Out
  between(field: keyof Row & string, range: readonly [number, number]): Out
  az(field: keyof Row & string, n?: number): Out
  za(field: keyof Row & string, n?: number): Out
  top(n: number): Out
  limit(n: number): Out
  reverse(): Out
}
/** Left of here(): plain data only, so a function here does not compile ('unencodable' when run untyped). */
export interface Operators<Row> extends PlainOps<Row, Sel<Row>> {}
/** A selection made of plain data, not yet held. */
export interface Sel<Row> extends Operators<Row> {
  here(): View<Row>
  tap(fn: (c: Commit<Rows<Row>, Row>) => void): Link
  connect<X extends object>(target: X, apply: (target: X, c: Commit<Rows<Row>, Row>) => void, opts?: ConnectOpts): Link
  connect<X extends object>(target: X, prop: keyof X & string, opts?: ConnectOpts): Link
}
/** Right of here(): data's operators, run here, on held rows. Functions are fine. */
export interface LocalOps<Row> extends PlainOps<Row, View<Row>> {
  filter(fn: (row: Row, key: Key) => unknown): View<Row>
  map<U>(fn: (row: Row, key: Key) => U): View<U>
  group(fn: (row: Row, key: Key) => unknown): View<Rows<Row>>
  sum(field: keyof Row & string): Value<number>
  length(): Value<number>
}

// ── records, and looking back ────────────────────────────────────────────
export interface ChangesOpts {
  /** 'latest' (default): from now on. "Now" is fixed when `changes()` is called, not when the loop
   *  starts: every write this process makes after the call is seen. 'earliest': everything kept.
   *  Or a saved cursor, a version, or `target.marks(name)`. */
  from?: 'earliest' | 'latest' | (string & {}) | PromiseLike<Cursor>
  until?: 'latest'
  credit?: Size
}
export interface Changes<Row> extends AsyncIterable<Entry<Row>> {
  readonly cursor: Cursor
  close(): void
}
export interface Entry<Row> {
  rec: Rec                  // the record itself, shared with every other reader: never copied
  value?: Row               // rec.value, typed, when the record wrote a whole row. Undefined for a
                            // field write or a remove. Never looked up: it is not "the row now"
  partition: Partition
  version: Version
  time: Time                // the leader's time when it was written (writer time)
  source: string            // the resource it came from
  reason?: 'ttl' | 'max' | 'where' | 'session' | 'erased'
}
/** A lens as it was: read-only, folded in this process from the log. */
export interface Past<T, Row> extends LocalOps<Row> {
  readonly rows: Rows<Row>
  readonly value: T | undefined
  /** One commit back (-1) or forward (+1). It moves this reader and returns it: a number changes. */
  step(n: number): Past<T, Row>
  /** A jump. It moves this reader and returns it: a number changes. */
  seek(pos: Position): Past<T, Row>
  close(): void
}
/** Every here() and connect made inside `fn` ends at `dispose()`. */
export declare function scope(fn: () => void): Scope
export interface Scope { dispose(): void }

// ── methods ──────────────────────────────────────────────────────────────
/** Where a method may be called. A bare function: the root only, `f.methods.x(arg)`. */
export type Where = 'row' | 'partition' | 'any'
export type Handler<Row = any, D extends Depth = 1, K extends Kind = 'root'> = (arg: any, ctx: Ctx<Row, D, K>) => unknown
/** A function (the root only), or `{ at, run }`: the paths it may be called on. The server refuses
 *  any other path with 'bad-path'. On a path, the call runs at that path's leader. */
export type MethodDef<Row = any, D extends Depth = 1> =
  | Handler<Row, D, 'root'>
  | { readonly at: 'row'; readonly run: Handler<Row, D, 'row'> }
  | { readonly at: 'partition'; readonly run: Handler<Row, D, D extends 2 ? 'part' : 'row'> }
  | { readonly at: 'any'; readonly run: Handler<Row, D, 'field'> }
export type Methods<Row = any, D extends Depth = 1> = Record<string, MethodDef<Row, D>>
export interface Ctx<Row = any, D extends Depth = 1, K extends Kind = 'root'> {
  /** The lens the call was made on. For a bare function, the root. */
  readonly at: Lens<K extends 'row' ? Row : K extends 'part' ? Record<Key, Row> : K extends 'root' ? Tree<Row, D> : any, Row, {}, K, D, 'server'>
  /** This server's own resource: its rows held, its writes allowed. */
  readonly data: Lens<Tree<Row, D>, Row, {}, 'root', D, 'server'>
  readonly rows: RowsOf<Row, D>          // this server's rows: one lookup
  set: RootWrites<Row, D>['set']
  remove: RootWrites<Row, D>['remove']
  batch: RootWrites<Row, D>['batch']
  readonly peer: string
  readonly claims: Claims | null
  readonly session: string
  readonly once?: string
  now(): Time
  id(): string
  flush(): Promise<void>
  /** Another resource's handle, bound to this call: its writes carry the call's attempt ids, so a `once`
   *  re-run makes the same writes, and `while: 'session'` binds the caller's session. */
  use<S extends Resource<any, any, any, any>>(other: S): S
}
type RunOf<H> = H extends { run: infer F } ? F : H
type WhereOf<H> = H extends { at: infer W } ? W : 'root'
type ArgsOf<H> = RunOf<H> extends (arg: infer A, ctx: any) => any
  ? (undefined extends A ? [arg?: A, opts?: CallOpts] : [arg: A, opts?: CallOpts]) : never
type ReturnOf<H> = RunOf<H> extends (...a: any[]) => infer X ? X : never
type CallableAt<W, K extends Kind, D extends Depth> =
  W extends 'any' ? true
  : W extends 'row' ? (K extends 'row' ? true : false)
  : W extends 'partition' ? (D extends 2 ? (K extends 'part' ? true : false) : (K extends 'row' ? true : false))
  : false
/** The methods a lens of this kind may call. On a path, a call runs at that path's leader. */
export type PathCalls<M, K extends Kind, D extends Depth> = string extends keyof M ? {} : {
  [N in keyof M as CallableAt<WhereOf<M[N]>, K, D> extends true ? N : never]: (...args: ArgsOf<M[N]>) => CallOf<ReturnOf<M[N]>>
}
/** The calls with no path. A handle typed by its rows only has untyped calls. */
export type RootCalls<M> = string extends keyof M ? { readonly [name: string]: (arg?: any, opts?: CallOpts) => Served<any> } : {
  readonly [N in keyof M as WhereOf<M[N]> extends 'any' ? N : WhereOf<M[N]> extends 'root' ? N : never]: (...args: ArgsOf<M[N]>) => CallOf<ReturnOf<M[N]>>
}
type CallOf<X> = unknown extends X ? Served<any> : Awaited<X> extends Sel<infer V> ? Served<V> : Call<Awaited<X>>
export interface CallOpts {
  /** At most once, from any process: a claim in `#calls`. Three commits in a row. */
  once?: string
  /** v4's: send the call again if its server is lost. No claim, no extra commit. The handler may
   *  run twice, so only for a handler that is safe to run twice. */
  retry?: boolean
  ttl?: Duration
  timeout?: Duration
}
export interface Call<X> extends PromiseLike<X> {}
/** A method that returns a view: await it for one picture, or here() it for a live view on a server. */
export interface Served<Row> extends PromiseLike<Rows<Row>> { here(): View<Row> }

/** What a token allows: `read` the partitions a client may read or hold, `call` the methods, `write` the partitions. */
export interface Claims { sub: string; read?: readonly string[]; call?: readonly string[]; write?: readonly string[]; exp?: Time; [claim: string]: unknown }
export interface Who { peer: string; claims: Claims | null; session: string }

// ── cluster and health ───────────────────────────────────────────────────
export interface ClusterView {
  snapshot(): ClusterShape
  tap(fn: () => void): () => void
  readonly writes: WritesView
}
export interface ClusterShape {
  id: string                  // the resource's id, made when it was founded
  writable: boolean
  me: { id: string; role: 'server' | 'client' | 'solo'; listen: string | false; caughtUp: boolean; lag: number; links: string[] }
  members: Record<string, { listen: string; state: 'live' | 'draining' | 'retiring' | 'gone'; up: boolean }>
  groups: Record<string, { voters: string[]; learners: string[]; leader: string | null; lag: number; slots: number }>
  health: HealthRow[]
}
export interface HealthRow { kind: string; severity: 'info' | 'warn' | 'down'; since: Time; message: string; fix: string }
export interface WritesView {
  snapshot(): WriteRow[]
  tap(fn: () => void): () => void
  lookup(id: AttemptId): Promise<WriteRow>
}
export interface WriteRow {
  id: AttemptId
  key: Path
  state: 'pending' | 'committed' | 'refused' | 'unknown'
  stage?: 'received' | 'replicated'   // how far a pending write got
  version?: Version
  code?: Code
}

// ── errors ───────────────────────────────────────────────────────────────
export declare class FeroError extends Error {
  readonly code: Code
  /** Did it commit? 'refused': no, and it never will. 'unknown': it may have. */
  readonly outcome: 'refused' | 'unknown'
  readonly resource: string
  readonly key?: Path
  readonly attempt?: AttemptId
  readonly retryAfter?: number
  readonly current?: Version
  readonly earliest?: Cursor
  readonly path?: readonly PropertyKey[]
  readonly reason?: string
  readonly cause?: Code
  /** One line: the call to make next. */
  readonly hint: string
}
export type Code =
  | 'conflict' | 'fenced' | 'absent-row' | 'absent-path' | 'sparse-hole' | 'invalid-key' | 'unencodable'
  | 'too-large' | 'cross-partition' | 'no-rows' | 'schema' | 'invalid' | 'rule' | 'rule-threw' | 'rule-timeout'
  | 'methods-only' | 'forbidden' | 'call-diverged' | 'read-only' | 'disk-full' | 'backpressure' | 'too-many-keys'
  | 'not-held' | 'expired' | 'bad-cursor' | 'schema-changed'
  | 'no-method' | 'bad-path' | 'bad-key' | 'too-many-views' | 'threw' | 'busy'
  | 'timeout' | 'unknown' | 'destroyed' | 'restored'
  | 'locked' | 'limited' | 'no-answerer' | 'no-undo'
  | 'config' | 'config-differs' | 'admin-only' | 'dir-held' | 'wrong-project' | 'wrong-cluster'
  | 'no-server-here' | 'unbound'
  | 'no-leader' | 'moved' | 'retry' | 'end' | 'gap' | 'stale-attempt' | 'empty'

// ── fero's statics ───────────────────────────────────────────────────────
export declare namespace fero {
  function id(): string
  function now(): Time
  /** Open with the row type given and the methods' type worked out: `fero.of<Item>()('shop', { methods })`. */
  function of<Row, D extends Depth = 1>(): <M extends Methods<Row, D>>(name: string, opts: Options<Row, M, D> & { methods: M }) => Promise<Resource<Row, M, D, 'server'>>
  /** An admin act: it needs the admin key. The depth, the partition rule and the seed cannot be altered. */
  function alter(name: string, change: Partial<Omit<ResourceOptions<any, any, any>, 'depth' | 'partition' | 'data'>> | { gate: string | null }): Promise<void>
  function drop(name: string): Promise<void>
  function erase(name: string, partition: Partition): Promise<void>
  function fork(name: string, opts: { as: string; at?: Cursor | string }): Promise<void>
  function token(claims: Claims, opts?: { ttl?: Duration }): string
  function revoke(sub: string): Promise<void>
  function clientKey(secret: string): string
  function spawn(file: string, args?: string[], opts?: { stdin?: 'pipe' | 'ignore' }): Spawned
  function world(opts?: { seed?: number; start?: Time; shuffle?: boolean }): World
  namespace version {
    function toNumber(v: Version): bigint
    function fromNumber(n: bigint): Version
  }
}
export interface Spawned { pid: number; out: string; exited: Promise<number | null>; stop(): Promise<number | null>; write(line: string): void; child: unknown }
export interface World { readonly seed: number; now(): Time; id(): string; advance(by: Duration): Promise<void>; close(): Promise<void> }

// ── libraries: each built only from the calls above ──────────────────────
/** What a library's resource takes from the open: the role, and where this process is. */
export type LibOpts = Pick<OpenOptions, 'server'> & ProcessOptions
export interface Runner { readonly lag: number; stop(): Promise<void> }

export declare function queue<Job = unknown>(name: string, opts?: LibOpts & { lease?: Duration; deliveries?: number; history?: History }): Promise<Queue<Job>>
export interface Queue<Job> {
  readonly name: string
  /** `key`: the message's own row key, written only if absent. A `cron` schedule needs one: it is
   *  what keeps a second start-up from adding the schedule again. */
  add(job: Job, opts?: { partition?: Partition; key?: string; once?: string; delay?: Duration; at?: Time; cron?: string; priority?: number }): Promise<{ id: string }>
  take(n?: number, opts?: { partitions?: readonly Partition[]; wait?: Duration; lease?: Duration }): Promise<Msg<Job>[]>
  work(fn: (job: Job, msg: Msg<Job>) => unknown, opts?: { concurrency?: number; partitions?: readonly Partition[] }): Runner
}
export interface Msg<Job> {
  readonly id: string
  readonly job: Job
  readonly deliveries: number
  readonly until: Time
  ack(): Promise<void>
  nack(opts?: { delay?: Duration }): Promise<void>
  extend(lease?: Duration): Promise<void>
}

/** A lock's name and token: what `if: { lock }` carries. Tokens rise; they compare with `<`. */
export interface LockRef { readonly name: string; readonly token: Version }
export interface Lock extends LockRef {
  readonly lost: Promise<void>
  renew(): Promise<void>
  release(): Promise<void>
}
export interface LockOpts { lease?: Duration; wait?: Duration | 'forever'; renew?: boolean }
/** Run `fn` under the lock; it is released when `fn` returns or throws. */
export declare function lock<T>(name: string, fn: (l: Lock) => T | Promise<T>): Promise<T>
export declare function lock<T>(name: string, opts: LockOpts, fn: (l: Lock) => T | Promise<T>): Promise<T>
/** Hold the lock until `release()`: for a leader that holds it for its whole life. */
export declare function lock(name: string, opts?: LockOpts): Promise<Lock>

/** A derived resource: the four lines of section 3.11, run once, paced, with bare marks for idle slots.
 *  `fn` writes with `{ from: e }`. The derivers that share a name split the source's shares. */
export declare function derive<A>(
  source: Resource<A, any, any, any> | readonly Resource<any, any, any, any>[], target: Resource<any, any, any, any>,
  fn: (e: Entry<A>) => unknown,
  opts?: { name?: string; from?: 'earliest' | 'latest' },
): Promise<Runner>

export declare function consumer<Row>(source: Resource<Row, any, any, any>, name: string, opts?: { from?: 'earliest' | 'latest'; lease?: Duration; max?: number; shares?: number }): Promise<Consumer<Row>>
export interface Consumer<Row> extends AsyncIterable<ConsumerBatch<Row>> {
  readonly member: string
  readonly owned: number
  /** Exactly once when `fn` writes with `{ from: e }`: paced, and one owner per share. */
  run(fn: (e: Entry<Row>) => unknown): Runner
  leave(): Promise<void>
}
export interface ConsumerBatch<Row> { readonly entries: Entry<Row>[]; commit(): Promise<void> }

export declare function saga(steps: readonly Step[], opts?: { once?: string; lease?: Duration }): Promise<Ack[]>
export declare namespace saga { function sweep(opts?: { every?: Duration }): Runner }
/** A saga step takes one lens. Its value is not checked against that lens's type. */
export interface Step {
  at: Writable
  value?: unknown
  remove?: true
  if?: Cond
  undo?: Op | { value: unknown } | { remove: true }
}
/** Any lens that has writes: a row or field lens of a handle that may write. */
export interface Writable { set(value: any, opts?: any): Judged; remove(opts?: any): Judged }

export declare function limiter(name: string, opts: LibOpts & { max: number; per: Duration }): Promise<{ take(key: string, n?: number): Promise<{ left: number; reset: Time }> }>
export declare function service<Req = unknown, Res = unknown>(name: string, opts?: LibOpts): Promise<Service<Req, Res>>
export interface Service<Req, Res> {
  answer(fn: (req: Req, info: { from: string }) => Res | Promise<Res>, opts?: { group?: string; concurrency?: number }): Runner
  ask(req: Req, opts?: { timeout?: Duration; group?: string }): Promise<Res>
}
export declare function migrate<A>(res: Resource<A, any, any, any>, opts: { to: number; fn: (row: A) => unknown; perSec?: number }): Promise<{ readonly done: Promise<void>; progress(): { rows: number; of: number }; pause(): void; resume(): void }>
export declare function tape<In = unknown, Out = unknown>(name: string, opts?: LibOpts & { window?: Duration }): Promise<{
  record(match: string, input: In, answer: Out): Promise<void>
  find(match: string): Out | undefined
}>
export declare function gateway(kind: 'resp' | 'nats' | 'kafka' | 'etcd', opts: { listen: string; resource?: string }): Promise<{ close(): Promise<void> }>
```

## 7. What the types cannot say

**The user rules the types cannot check.** Three of section 2's seven rules are in the types: a lens is not a promise (rule 1), a function cannot stand left of `here()` (rule 3), and a method is offered only where it is declared, by name and through `call()` (rule 7's first half). The rest are yours to keep, with two that follow from them:
- **A `connect` function takes its target as an argument, changes only that target, and never captures it** (rule 6). fero holds the function strongly and the target weakly. A function that names its own target in its body keeps the target alive for good: never collected, for a plain object and for a DOM node (E-55 claim 15). A function that changes anything else runs for as long as the collector leaves a dropped target alive, so the program's result then depends on the collector: 433 different results per 1,000 seeds when half the dropped links wrote a shared counter (E-55 claim 14, a control). Anything that changes more than the target belongs in `tap`. fero cannot check this for a plain object; for a DOM node, the dev warning sees a detached node that is still being fed (section 8).
- **Never rely on the collector to end a link** (rule 5). End it with `close()`, a scope, the target's own close, or the count. The collector is the net under those, and it may never run: in a headless Chromium it ended 0 of 1,000 links to removed DOM nodes in 30 s (E-55 claim 13). Until it runs, the server keeps sending and this process keeps decoding.
- **A lens inside a partition holds the whole partition** (rule 4, first build). `chat.data.room1.m7.text.connect(…)` downloads `room1` once, then every change to it. At depth 1 the row is the partition, so there the lens is exact.
- **Read what is held through what `here()` gave you** (rule 5). A `connect` never makes rows readable: a `get()` is served here only from rows held on purpose, and `f.rows` only on a server or with `hold: 'all'`.
- **A method checks its argument** (rule 7). A client picks the argument and the path. The server checks the path against `at:`; the argument's shape and meaning are the method's to check.
- **A sink never changes a row it was handed.** Rows handed out are frozen (section 3.10), so such a change throws in strict-mode code. The types show rows as plain objects.
- **Run the four-line derive in one process** (section 3.11), or use `derive()`, which splits the work.

**Roles.**
- Section 3.1 has the rule. The server markers are: `server: true`, `listen`, `dir`, a `data` seed, `methods`, and the other code keys (`validation`, `schema`, `rules`, `load`, `rows.where`, `shape.up`). A `partition` function alone is not one: a client may pass it to route by itself.
- `listen: false` is a solo node with no socket: the only voter of its groups, for tests.
- A server holds and folds every row of each resource it serves, with `data`, while it is one of the resource's `copies + standbys`. A server past that number is a spare (section 3.3). A client holds what its live `here()`s and `tap`s name, or every row with `hold: 'all'` (section 3.3).
- **The libraries' own resources need a server too.** `queue('thumbs', { server: true })` on a server founds and serves the queue; a worker's `queue('thumbs')` is a client of it. fero's system resources (`#sessions`, `#locks`, `#sagas`, `#calls`, `#groups`) are resources like any other; any process that serves a resource serves them too (this page's reading, with [LAYERS.md](LAYERS.md) section 10 item 5; the records do not say who founds them).

**Answers.**
- Every verb answers **after its commit**. A plain write's handle may also be awaited earlier (section 3.5).
- **A refusal waits too.** A refusal, an empty `claim` and a `call-diverged` answer are sent only once the state they were judged on has committed (A-04; V5-11 ruling 7). Before this fix, a write could be refused because of a write that was then lost (10 of 100 seeds of a planted race, [E-22]).
- If this process holds the partition, the handle resolves only once its own rows show the write. So a process reads its own writes.
- `outcome: 'refused'` means it never committed and never will. `outcome: 'unknown'` means it may have. fero keeps resending that attempt in the background while its session lives, until it gets a definite answer. `f.cluster.writes.lookup(attempt)` says how it ended.
- **fero retries by itself**, with jittered backoff from 200 ms to `election.ms`, and honours every `retryAfter`. An app never resends a write.
- **Order of issue.** One process's writes to one partition commit in the order it made them, even when it does not await each one (A-10). [E-45] saw the prototype break this in 12 of 100 seeds, with a leader change inside a burst; the fix is that each client numbers its writes.
- **Credit.** Each client may have only a granted number of writes in flight (A-07). The rest wait in the client. A client holds at most 512 waiting writes or 64 MB (LAYERS 4.2), then refuses `backpressure`: a verb's handle rejects with it, and an assignment throws it (section 3.6). A marked write is never refused it: it waits, and pauses the reader its `e` came from. A write still waiting at its `timeout` fails `timeout` with `outcome: 'refused'`, since it was never sent.

**Sessions and retries** ([E-20]).
- Each process has one session. fero registers it in `#sessions` and renews its lease within `session.ms` (10 s). `session.ms` is a setting of the `#sessions` resource, not of the app's resources (section 9).
- Each write carries its session and a number. The leader keeps, per session, a floor and the answers it gave. A resend gets the first answer. E-20 model-checked this at 13 rules, with no time rule.
- **The floor comes first on every path that judges a copy** ([E-32]). So a retry of a write under a lock that committed answers `ok`, never `fenced`.
- A slot move and a snapshot carry the floor, the answers, the derived marks and the lock tokens. So retries stay exactly once across both.
- **`once` names.** `once` on a write or a call is a name the app picks. A resend or re-run under the same name within 1 day gets the first answer. The same name with a different change is refused `call-diverged`. A name costs about 221 B for its day ([E-20]), so use them for retries across processes, not on every write. Because a name can be refused, a named write has no early stages (section 3.5).
  - **A name lasts a day, so it cannot guard something that lasts longer.** A cron schedule added at every start-up is keyed by a row, not by `once` (P-22).
  - A resource keeps at most 1,000,000 live names, about 211 MB. Past that, a write or call with a new name is refused `too-many-keys`, with `retryAfter` (proposed on COMP2's page; untested).
- If this process's session lapses (a pause longer than `session.ms`), its writes in flight answer `unknown`. Its session-bound rows go, and it starts a new session.

**At the leader, in this order:**
1. retries (the floor);
2. shape checks (`absent-row`, `absent-path`, `sparse-hole`);
3. `validation`, `schema` and `rules.write`;
4. conditions (a lock's token among them);
5. ops.

- The leader appends results only. Followers, clients and replays apply plain values.
- So leader-side code may give different answers on different runs, but it must be synchronous and must not read app state. `load` is the exception: it is asynchronous and lands later as an ordinary write.
- Leader-side code is only the code keys, the same on every server. A call never carries code to a leader. So a `claim`'s filter is a field name, `due`, not a function.

**Ops on what is missing.** An op on a missing row, or on a missing field of a row that exists, starts from its identity: `incr` from 0, `push` from `[]`, `merge` from `{}`; `max`, `min` and `now` take the value. A field write or field op on a row that does not exist is refused `absent-row`. So a counter is its own row, or a field of a row you created first.

**Reads.**
- `f.rows`, a handle's `rows` and `value`, a view, and `get()` of a partition held on purpose read this process's committed rows, with no trip. Rows held only by a `connect` serve no read (section 3.9).
- A row handed out is frozen, so a read by reference cannot change it (DATA-07), and that covers rows handed to sinks (section 3.10). Open: in E-22's probe, a row read through a `filter` view was not frozen.
- Every awaited read carries the highest position this process has seen. A server answers only once its own rows have reached it. So a process never reads older than what it already saw or wrote, even when a link ends and the next read goes to another copy.
- A `get()` of a partition not held on purpose is answered from a copy, which may trail a write another process already had answered. `get({ fresh: true })` is the form that cannot ([E-22] C11).
- **A `get()` never subscribes** (V5-12). It reads once and keeps nothing; a read that should go on is a `here()`. The 2026-11-16 page made a miss a subscribe (PATHS 4.4), which saved a second trip for a reader that went on reading, at the price of a follow the line did not show.
- A refusal's `current` version counts as seen. So `set(fn)`'s re-read waits for it (section 3.7).
- `fresh: true`: the leader confirms it still leads (Raft's read index), then answers. One trip, no disk sync ([E-46]).

**Cursors** ([E-31], A-06).
- A cursor holds one position per slot it reads. It keeps its meaning across failovers and slot moves.
- A copy that lacks a reader's next record tells the client, and the client moves to another copy with its cursor, by itself.
- A reader hears `expired` only when no live copy of that slot has its next record. E-31 model-checked this through a leader crash, a reload, a dropped link and a slot move: 26 rules, on ten bounds of up to 7.6 million states.
- **Size.** A whole-resource cursor holds up to 4,096 entries: about 4 to 13 KB (reasoned from [E-19]). A reader of 1 to 10 partitions holds 22 to 79 B.

**Order.** Total within a partition. None across partitions, ever. Under a test world, deliveries mix partitions in a seeded order that keeps each partition's own order. So code that leans on order across partitions fails in test: E-22's planted app failed in 25 of 100 shuffled seeds and never without the shuffle.

**Versions.** Two versions of one partition compare with plain `<`, in log order, across failovers, moves and restores. So an outside system can check a lock's token with `<`. `fero.version.toNumber(v)` gives a number below 2^63 that keeps the partition's order; gateways need it ([E-45] F1) and apps never do. `f.data[p].changes({ from: version })` starts at that record.

**Values.** Rows are JSON-like values. `Uint8Array` is a value too, kept as bytes on the wire ([E-45] F3). A bigint, a function, a `Date`, a `Map`, a `Proxy` (a lens among them) or nesting deeper than 60 is refused `unencodable`. So is a function left of `here()`: an operator's argument crosses as a value too.

**Time** (A-23, [E-21]; V5-4).
- Writer time is the median of the members' clocks, the leader's own included. It never goes back. With one wrong clock, the leader's included, every check passed and no failover happened ([E-21]: 7 rules).
- **When most clocks disagree, the group stops writing** rather than expire rows by a wrong time. Health shows `skew`.
- **Expiry, presence and delays are judged while a leader exists.** With none they wait.
- `fero.now()` and `fero.id()` are the wall clock and random ids live, and the world's clock and seeded ids under test. Under a world, `setTimeout` and `setInterval` run on the world's clock ([E-22] D1).
- **One timeline.** A viewer merges the resources' logs by writer time (V5-4). Writes to different resources within the clocks' gap (a few ms) may show in either order.

**Methods.**
- A handler called on a path runs at that path's leader, once the server has checked the path against the method's `at:` (`bad-path` if it does not fit). With no path, it runs on the server the caller reached. `ctx.at` is the lens it was called on; `ctx.rows` and `ctx.data` are that server's committed rows.
- **A call with `once`** claims a row in `#calls` first. It runs at most once within its `ttl`, and a retry gets the first result. If its server dies, it is re-run elsewhere when the claim's lease lapses, with the same attempt ids, `ctx.now()` and `ctx.id()`. So handlers must give the same writes for the same `arg` and `ctx`; a re-run that writes a different change is refused `call-diverged`.
- **A call with `retry: true`** whose server dies is sent again to another server, as in v4. It may run twice; that is what the option says is safe. No claim, no extra commit.
- **A call with neither** whose server dies answers `unknown`: it may have run. fero does not resend it.
- `while: 'session'` inside a method binds the caller's session.
- **A handler writes another resource through `ctx.use(other)`.** Those writes carry the call's attempt ids and the caller's session, as `ctx.set` does, so the two rules above hold for them too. A write through a handle the handler took from its own module is an ordinary write of that server: a `once` re-run sends it again as a new write, and `while: 'session'` binds the server's session, not the caller's.
- A session-bound write is sent only once its session's own record has committed (A-04; [E-22] F2).

**Locks** (A-24, [E-24], [E-21]).
- A lock is a row of `#locks`. Its token is the version of the write that took it; renewals keep it. Tokens rise for ever.
- A write under a lock (`if: { lock: l }`) is judged by its own partition's leader. Each group remembers, per lock, the newest token it has seen, even after the lock row is gone. Leaders do not follow `#locks`.
- **So:** no write commits under a token older than one this partition's leader has seen. A stale write can still land between a new grant and the new holder's first write there ([E-22] F5). To close that at once, write to the partition under the new token first.
- The check does not lean on clocks ([E-21]).

**The door and tokens.**
- With `methods:` declared, clients change data only through the methods (V4-5). Reads stay open unless `rules.read` or a token limits them.
- A token from `fero.token(claims)` limits what a client reads or holds, calls and writes. Servers check it when a SUB or a GET arrives and on every write and call. `rules.read` runs once per subscription and partition, never per record (PA-34).
- `fero.revoke(sub)` ends access within one `ping.ms`. A write that is resent after its token was revoked is judged again and refused `forbidden` (section 11.2, Q-B1). Tokens were not built in E-22. Where a project's door secret and its list of revoked tokens live, with no `#meta`, is not yet written (LAYERS section 10 item 17).

**Sizes and stated ceilings.**
- A record is at most 1 MB and a row at most 64 MB. Larger is refused `too-large` before it is appended.
- 4,096 slots per resource (A-16). One partition is one leader's work. With the app splitting every partition above half a leader's share, a resource reaches about 135 leaders' worth of writes ([E-18]).
- One `data` source holds at most 16,777,216 rows (A-13, [E-34]).
- `rows.max` is kept per group as its share, rounded up.
- A resource costs about 8 KB per server while idle, about 2.5 KB dormant (V5-8). A whole-project cold boot takes 3 to 5 s at 1,000 resources per process (V5-7). After one server restarts, leaders are even again about 31 to 32 s later, most of it `settle.ms` ([E-53]).
- Every other queue is bounded and refuses with a reason.

**Starting, stopping, finding, restoring.**
- **Founding.** The first server to open a name writes a candidate id to its disk, asks the store to create that id if none exists, and founds the resource only if the stored id is its own (V5-10 fix 1; [E-51]). On one box the store is a local folder; across machines it is the object store named by `object`. Every later opener adopts the stored id and joins.
- **Finding.** A client asks the directory once for one address of the resource, then learns the members, the slot table and the leaders from the resource itself (V5-3). While the directory is down, connected clients keep working; only first lookups wait. A client asks it again once every member it learned has failed (V5-10 fix 2).
- One process per `dir`: a second one is refused `dir-held` (V4-59).
- `destroy()` closes one handle. The last handle of a resource in a server process also leaves, cleanly: retiring first, then a leave (LAYERS 8.9). Under `FERO_SUPERVISED` it only hands over, because a restart is coming. With no spare machine to take its place, the leave cannot finish; LAYERS reads that the process exits at `leave.ms` and stays in the group's config, absent, until healing swaps it out (its section 10 item 25; not modelled).
- **Restore** (`fero restore`, an admin step) runs per resource. A cursor from before is refused `bad-cursor`. A retry from before is answered `restored`, never re-run. Lock tokens restart above every token handed out ([E-33]).

**Under test.**
- A name bound to nothing under a world is a loud `unbound`, never a silent network call.
- A tape is one partition ([E-22] D14). `fero.fork` is not built yet.

## 8. Errors and refusal codes

Every failure is a `FeroError`. `code` says what, `outcome` says whether it may have committed, `hint` says the next call to make. The table is sorted by **what to do**.

**Fix the call.** A retry will fail the same way. `outcome: 'refused'`.

| Code | Layer | When | Fields |
|---|---|---|---|
| `invalid-key` | L4 | a key `data` cannot fold | |
| `unencodable` | L4 | a value that would not arrive unchanged (a bigint, a function, a `Date`, a `Map`, a `Proxy` or a lens, deeper than 60); **a function left of `here()`**: code cannot travel. The hint says to move it right of `here()`, or into a method | |
| `bad-key` | L4 | `at()` given a key that is not a string or a finite number (a number becomes its string) | `key` |
| `bad-path` | L2, L4 | a method called on a path its author did not declare (`at:`): the leader checks it before the handler runs (L2; LAYERS 3.3). Or a write above a row (the root, or a partition at depth 2), refused before it is sent (L4). The hint names where the method may be called, or the row lens to write | `path` |
| `too-large` | L3, L4 | a record over 1 MB, a row over 64 MB | |
| `cross-partition` | L4 | a `batch` whose keys span partitions | |
| `no-rows` | L2 | an op, a claim or a condition on a `rows: false` resource | |
| `absent-row` | L2 | a field write or a `touch` on a row that does not exist | |
| `absent-path` | L2 | a field write whose parent field does not exist | |
| `sparse-hole` | L2 | a remove of an array's own element: write the spliced array | |
| `schema` | L2 | `schema` said no | `path`, `reason` |
| `invalid` | L2, L4 | `validation` returned a reason | `reason` |
| `methods-only` | L4 | a client's plain write to a resource with `methods:`; the hint lists the methods. A client typed by `fero<Shop>` cannot write one at all | |
| `forbidden` | L3, L4 | the token or `rules.read` does not allow it; a write resent after its token was revoked | |
| `no-method` | L4 | no method of that name | |
| `no-undo` | L5 | a saga step whose op has no inverse and no `undo` | |

**An expected answer: branch on it.** The state said no. `outcome: 'refused'`.

| Code | Layer | When | Fields |
|---|---|---|---|
| `conflict` | L2 | a condition failed, an op's bound would be crossed, or `lens.set(fn)` ran out of tries; sent once the state it was judged on has committed (A-04) | `current` |
| `fenced` | L2 | a write under a lock token older than one this partition's leader has seen; a consumer's commit from a member that no longer owns the share | `current` |
| `rule` | L2 | `rules.write` returned a reason | `reason` |
| `rule-threw`, `rule-timeout` | L2 | a rule threw, or held the leader too long | |
| `call-diverged` | L2 | a different change under a `once` name already used | |
| `threw` | L4 | the handler threw its own error; writes it made before stay | `reason` |
| `locked` | L5 | the lock is held past `wait` | |
| `limited` | L5 | over the limit | `retryAfter` |
| `no-answerer` | L5 | no live answerer, by this process's view of who is alive | |

**Not now: slow down.** fero already retried. `outcome: 'refused'`, with `retryAfter`.

| Code | Layer | When |
|---|---|---|
| `read-only` | L2 | the write gate is closed, or the server is near its `memory` |
| `disk-full` | L0 | the disk is at its hard limit; reads go on |
| `backpressure` | L4 | this client holds 512 waiting writes or 64 MB on top of its credit. A verb's handle rejects with it. **An assignment throws it**, since it has no handle. **A marked write never gets it**: it waits, and pauses its reader. Write in chunks of a few hundred (section 3.6) |
| `too-many-views` | L3 | a SUB for a served view past the cap: this client holds `views.client` live served views, or the resource serves `views.max` (section 9). The hint says to close a view, or to call with an argument already open: equal calls share one served view |
| `too-many-keys` | L2 | a new `once` name, past the resource's bound of live names |
| `busy` | L4 | every server tried has a stalled main thread |

**It may have committed.** `outcome: 'unknown'`. Usually do nothing: fero keeps resending the same attempt, and it cannot apply twice. To know: `f.cluster.writes.lookup(e.attempt)`.

| Code | Layer | When |
|---|---|---|
| `timeout` | any | no definite answer within `timeout` (`refused` if the write never left the client); `cause` names the inner code |
| `unknown` | L2, L4 | the session lapsed with the write in flight; a call without `once` lost its server |
| `destroyed` | L4 | the handle closed with the write in flight |
| `restored` | L2 | an attempt from before a restore; it will not run now |

**Thrown by a read or a reader.**

| Code | Layer | When | Fields |
|---|---|---|---|
| `not-held` | L4 | a sync read of a row this process does not hold on purpose; `f.rows` on a client without `hold: 'all'` (a live `f.data.here()` is read through its handle); or, on such a client, anything that needs every row: listing `f.rows`, `f.snapshot`, an operator over every row left of `here()`. Also a sync read before the first picture has come. Never a stale or partial answer, never a hidden trip. The hint names the row's partition and `get()` and `here()`, or a method that serves the view, or `f.data.here()` | `key` |
| `expired` | L3 | a reader's cursor is older than `history` | `earliest` |
| `bad-cursor` | L3 | text that is not a cursor, or a cursor of another resource or from before a restore | |
| `schema-changed` | L4 | an old record or tape that the upcasters cannot bring to this version | |

**Thrown by `fero()`, or to an admin.**

| Code | Layer | When |
|---|---|---|
| `config` | L4 | a bad key or value, or a process key unlike the one this process already runs with |
| `config-differs` | L4 | a resource key unlike the stored one; the hint names the key, both values and the `fero.alter` call |
| `dir-held` | L0 | another live process holds `dir` |
| `wrong-project`, `wrong-cluster` | L0 | a dir or a peer of another project, or of another resource's id |
| `no-server-here` | L4 | a server marker in a browser or an edge worker. **It comes with the browser build, later** (V5-12 pick 12; +1 rule, LENS 7). The first build has no such check: there, a server marker in a browser fails wherever the first Node-only call fails (reasoned) |
| `unbound` | L4 | under a world, a name that nothing binds |
| `admin-only` | L0 | an `alter`, `drop`, `erase`, restore or placement hint without the admin key. `alter` is on the list because it can change `rules`, `methods` (the door), `history` and `copies` |

**Inside fero only:** `no-leader`, `moved`, `retry`, `end`, `gap`, `stale-attempt` and `empty`. The client acts on them by itself: it retries, follows `moved`, moves to another copy after `end`, resends in order after `gap`, or resolves an empty `claim` with `[]`. An app sees these only as a `timeout`'s `cause`, in `f.cluster.writes` and in the debugger.

**Good to know.**
- A plain assignment that is refused never shows. It is a `refused` row of `f.cluster.writes` and one stderr line, as in v4.
- A stage the write never reached rejects with the write's own error. Once a stage has resolved, the handle never ends in a refusal (section 3.5; MEMORY 9.6).
- A function of yours that throws in a view, a `tap` or a `connect` never stops fero; it prints one line (V4-47).
- **The dev warning** (LENS 2.2; not a `FeroError`, and nothing throws). In development, fero prints one line naming the path of a link the net had to end: its target was collected while the link was still open, so a `close()`, a scope or the count was missing. It prints one too for a DOM target that says it is detached and is still being fed, which is how a `connect` function that captures its target shows (E-55 claim 15). The collector's timing never changes a result (section 3.10); the warning only points at a cost.
- **Gone with COMP2:** `too-many-resources`, `node-config`, `needs-persisted`, `wrong-group`, health's `meta-down`. **Renamed:** `shortfall` and `holistic` to `not-held`; `unknown-log` to `bad-cursor`; `no-writer` to `no-leader`. **New, inside fero:** `gap`. **New with the lens (V5-12):** `bad-path`, `bad-key`, `too-many-views`, and `unencodable` for a function left of `here()`.

## 9. Config keys

The cascade is v4's and does not change (V4-10; code: api/config.ts): `--fero.<key>` beats the call, then `FERO_<KEY>`, then the project's `fero.opt.ts`, then `$HOME`'s, then the default. Keys are nested lowercase words. Types are in section 6.

**This process.** A change is a restart. (LAYERS calls these node keys.)

| Key | Default | What it does |
|---|---|---|
| `listen` | a free loopback port; `false` is a solo node with no socket | where this server listens |
| `advertise` | `listen` | the address others dial |
| `rendezvous` | `127.0.0.1:3376`; `off` | where the directory is asked (V4-3). **Now also a list**: across machines, a few addresses that `fero deploy` passes in or `FERO_RENDEZVOUS` names. This is V5-3's seed-address key, under the name v4 has *(proposed)* |
| `hosts` | none | addresses to dial by hand, for when the directory is off (v4's example 15); a browser's one address goes here. It says where this process dials, so it is a process key; to give one resource its own list, use the cascade's name rung (`--fero.shop.hosts`) or the call |
| `dir` | a server: `.fero/<project>/m<n>`; `false` is memory only, for tests | this process's disk. **One per process**, holding every resource it serves: one journal, one disk sync ([E-12]). So `--fero.shop.dir` is refused `config` |
| `object` | `.fero/<project>/objects` on one box | the store where a resource's id is created once. Needed across machines ([E-51]) |
| `project` | the `name` in the nearest `package.json` | scopes names in the directory: a project is machines plus a name lookup (V5-2 point 5) |
| `secret`, `token`, `admin` | none | the members' secret (V4-30), a client's credential, the admin key. Never a flag |
| `memory` | none | this process's memory bound; near it, writes are refused `read-only` |
| `ping.ms` | 500 | the ping between two machines when no other frame went that way: one per pair, not per group |
| `evict.after` | as COMP2's page | how long a silent peer counts as live |
| `settle.ms` | 30000 | how long a restarted member must be live and caught up before leadership is handed back to it (V5-7) |
| `handback.max` *(a name proposed here)* | 8 | hand-back transfers in flight per member, busiest groups first; 4 where a 10 ms pause bar must hold (V5-10; [E-53]) |
| `bulk.rate` *(a name proposed here)* | to be measured | the byte-rate cap on catch-up, installs and moves, on the link and the disk (V5-9) |
| `connect.wait` | `10s` | how long an open looks before it says who is missing |
| `linger.ms` *(a name proposed here)* | 1000 *(a guess; nothing measured it)* | how long a selection whose last link closed stays subscribed before the unsubscribe is sent, so that a link closed and made again at once (a re-render, a route change) does not unsubscribe and subscribe again (section 3.10) |
| `uuid`, `redial.ms`, `redial.tries`, `leave.ms`, `journal.cap`, `diag.allow`, `shuffle` | v4's | v4's |

**The resource.** Stored in its own log at founding (V5-2); compared at every later open; changed with `fero.alter(name, change)`, online.

| Key | Default | What it does |
|---|---|---|
| `depth` | 1 | where a row begins: 1, each first key is a row and its own partition; 2, the first key is the partition and the second the row (section 3.2; V5-12 pick 4). Fixed at founding |
| `partition` | none | a function of the row key, for partitions a key level cannot say; **built later** (V5-12 pick 4). Fixed at founding |
| `history` | `0` | how much of the log is kept for `changes`: a count, a time, a size, or `'all'` |
| `rows` | `true` | `false` for a stream; `{ ttl, max, where, while }` for expiry and presence |
| `copies` | 3 (1 while fewer than three servers exist; a second server is a copy that does not vote) | the copies whose disks decide a commit: 1, 3 or 5 |
| `standbys` | every other server that serves the resource, up to 2 | more full copies that do not vote (this page's reading of COMP2's default of 5 in all). A server past `copies + standbys` is a spare: it holds no copy until healing places one on it |
| `data` | none | the first rows: applied once, with the founding entry (V5-10 fix 5) |
| `methods`, `validation`, `schema`, `rules`, `load`, `rows.where`, `shape.up`, a `partition` function | none | code: the call only; the same on every server, compared by its text; a change is a rolling `fero.alter` |
| `shape.version` | 1 | which shape of row is in force |
| `election.ms`, `election.jitter` | 2000, 500 | Raft's random election timers (V5-7); `election.ms` must be more than twice `ping.ms` |
| `skew.max`, `lag.max`, `catchup.max` | 250, 1000 records, as COMP2's page | were cluster keys in `#meta`. Each resource is its own cluster, so they are its own: in its settings record, changed by `alter`, since every copy must agree on them (LAYERS 5.3; reasoned) |
| `views.client`, `views.max` *(names proposed here)* | 16 and 1,000 *(guesses; nothing measured them)* | the cap on live served views (class C, section 3.10): how many one client may hold, and how many the resource serves. Past either, the SUB is refused `too-many-views`. A served view costs the server 9.9 KB to 12.8 MB of memory and its own CPU per change (E-55 claim 16), so the right numbers depend on the views a resource names |

**`session.ms`** (10000) is not a key of an app's resource. Sessions live in the system resource `#sessions` (LAYERS section 10 item 5), so it is `#sessions`' own setting. An app sets it like any config key, in `fero.opt.ts` or `FERO_SESSION_MS`; the server that founds `#sessions` stores it, and a later change is `fero alter '#sessions'` *(proposed; LAYERS has not written who founds the system resources)*. P-13's "within `session.ms`" reads this one value.

**This open.** Never stored.

| Key | Default | What it does |
|---|---|---|
| `server` | by declared act | `true` serves this resource from this process; `false` stays a client |
| `hold` | nothing: a client holds what its live `here()`s and `tap`s name (V5-12 pick 1) | `'all'`: every row, kept live; a size: a cache of pictures of closed selections, not subscribed (section 3.3) |
| `signals` | `true` | Ctrl-C is a clean stop (V4-8) |
| `bind` | `live` | under `fero test`: what this name resolves to |

**The lens's keys, and which layers may carry them** (each a row in `LEAVES`, with why not the others; CLAUDE.md, "The two seams").
- **`linger.ms`** is a process key. Every layer may carry it: the flag, the call, `FERO_LINGER_MS`, the project's and `$HOME`'s `fero.opt.ts`, with the name rung (`--fero.chat.linger.ms`) for one resource. It is safe everywhere because it changes cost, never a result: a lingering selection is not held on purpose, so no read is served from it (reasoned).
- **`views.client` and `views.max`** are resource keys: every server must enforce the same cap, so they live in the resource's settings record. The founding open writes them, from the call or from the cascade on that server, as for every resource key; `fero.alter` changes them, with the admin key. A client's open cannot carry them: a different value is refused `config-differs`, so no client can raise its own cap.
- **No key for the rest.** The seven probe names, the dev warning (development only), the freeze of rows handed to sinks, and the closable kinds of target are fixed behaviour, not settings: each is a rule that keeps a result from depending on timing or on a library (LENS 2.1, 2.2, 2.7).

- **`durability` is not a key in the first build.** Every write commits on disk at a majority (V5-5).
- **Gone from COMP2's page:** `seeds` as "the founders", `copies.meta`, `copies.default`, `cache.memory`, and the whole `fero.alter('#meta', …)` door. **Gone from v4:** `replicas`, `heartbeat.ms`, `seams`. **Gone with the lens (V5-12):** `partition: { before }` (now `depth`) and `hold: 'asked'` (now the default).
- **Proposed, untested** (from COMP2's page): `skew.max` 250 ms, `lag.max` 1,000 records, `session.ms` 10 s, `connect.wait` 10 s, a `once` name's life 1 day, a token's `ttl` 1 hour, a write's `timeout` 10 s (v4's).
- Each new key gets what v4's rule asks: a row in `LEAVES`, a coercion if it needs one, a README row and a `config.test.ts` case ([CLAUDE.md](../../CLAUDE.md), "The two seams").

**The CLI (L5)** keeps v4's verbs and adds `fero run`, `test`, `deploy`, `ls`, `debug`, `recover`, `restore`, `alter`, `drop`, `export`, `migrate`, and the placement hints `drain`, `retire`, `undrain`, `gone`, `lead`, `place`, `move`, `groups`. A hint goes to one resource's leaders; a `lead` hint moves leadership itself, never to a draining or leaving machine (V5-10 fix 9). The flags belong to [LAYERS.md](LAYERS.md).

## 10. Every pattern: the code, the guarantee, the cost, the layer

Each is one of REQUIREMENTS' 22 patterns, in the fewest lines that stay honest, written with the lens (LENS 2.10's lens column).

- **The code** is E-22's pattern code, respelled for the lens. E-22 ran all 22 on a prototype under the earlier spelling, 100 seeds each, with and without the shuffle, with a leader change and a slot move forced into each ([E-22]). **The respelled lines compile here and did not run** (E-55 claim 25 is not run; claim 5 compiled LENS's form of them).
- **Guarantee** is what the call promises. **Cost** is what it costs, from section 4. **Layer** is where the work is done ([LAYERS.md](LAYERS.md)).
- **Evidence** is what was shown. The study judged these cells for COMP2 and for MIN-P+par, whose shape the base is (V5-6). Nobody judged them again for groups per resource, or for the lens. Where the `memory` rung was the only open point (P-10, P-15), the cell counts as met here, since the first build has no such rung (V5-5).
- A line `// ── name.ts` starts a second file. A process that creates a resource says `server: true`, or brings a seed or methods (section 3.1). **Each pattern keeps that in a server file**, and the app's lines open the bare name: an app process that said `server: true` would become one more server of the resource (section 3.1).
- **A bare client holds nothing** (V5-12 pick 1). A pattern that shows every row says so with a line: `f.data.here()` (P-01, P-13).
- **What moved on the wire** (LENS 2.10; reasoned): P-03's `get()` sends one row and opens no stream. P-05 keeps no partition index and builds one JSON text per commit per room, not one per socket. P-14 is the same single ASK to the row's leader that `near` made. P-19's first picture walks one partition, not every partition's name. The rest send the same bytes as the page before.

### P-01 Live shared state

```ts
// file: p01.ts — live shared state (two files)
import { fero } from 'fero'
type Item = { stock: number }
// ── server.ts
const shop = await fero<Item>('shop', { data: { widgets: { stock: 10 } } })   // a seed makes a server
shop.data.tap((c) => console.log(c.now.rows))           // every commit, live: a server holds every row
// ── client.ts: a bare name is a client; it holds nothing yet
const client = await fero<Item>('shop')
const ack = await client.data.gadgets.set({ stock: 4 }) // a write, answered at its commit
const w = await client.data.widgets.get()               // read once: one trip, nothing held
const all = client.data.here()                          // or hold every row, said as a line
await all.ready
console.log(ack.version, w?.stock, all.rows.widgets?.stock)   // a read here: one lookup
```

**Guarantee.** Order per partition. The answer comes once a majority has the write on disk. A process reads its own writes. A `here()` hands over the picture, then each commit, with no gap and no overlap. **Cost.** Each write: one trip to the leader and a share of one disk sync. `get()`: one trip, nothing kept. `client.data.here()`: one picture of the whole resource, then every later write, which is what v4's bare open did; the line now says so. The read through the handle: one lookup (bar: under 100 ns at 1,000 rows). **Layer:** L4, over L2's fold and L3's subscribe.
**Evidence.** Every copy equalled the fold of the committed log (600 of 600 partitions linearizable, [E-22], under the earlier spelling). Picture then changes: 0 wrong in 1,000 seeds in one process and across 4,337 disconnects (E-55 claim 7). The write p99 is not shown on a real kernel; the bar is C + 5 ms in TypeScript.

### P-02 Cache with expiry, session store

```ts
// file: p02.ts — cache with expiry, session store (two files)
import { fero } from 'fero'
// ── cache.ts, on a server
await fero('cache', { server: true, rows: { ttl: '10m', max: 1e6 } })
// ── app.ts, a client: it holds nothing, and writes
const cache = await fero<{ name?: string; n?: number }>('cache')
await cache.data['user:42'].set({ name: 'Ada' })
await cache.data.hot.set({ n: 1 }, { ttl: '30s' })      // this row's own ttl
await cache.data['user:42'].touch()                     // resets the ttl, keeps the value
```

**Guarantee.** The leader removes rows by writer time, as records with a reason (`ttl`, `max`). So every copy agrees on which rows exist at each position. A row goes within one tick of its ttl, never before. With no leader it waits. `max` is kept per group, as its share rounded up. **Cost.** One commit per `set` or `touch`. Expiry work grows with what expires, not with what is held. The app holds nothing. **Layer:** L2.
**Evidence.** Held by writer time while a leader exists ([E-21], [E-22]). With a failover near the ttl, a row went 2,036 ms late ([E-22] D9). Owed: the expiry pin at 1,000 to 1,000,000 rows.

### P-03 Near cache, client data sync

```ts
// file: p03.ts — near cache, client data sync
import { fero, scope } from 'fero'
type User = { name: string }
const users = await fero<User>('users', { hold: '200MB' })   // keeps pictures of closed selections, inside 200MB
const u = await users.data.u42.get()                    // read once: one trip, nothing kept
const me = users.data.u42.here()                        // held and live, by choice: the picture, then each change
await me.ready
const same = me.value?.name                             // here: one lookup
const sure = await users.data.u42.get({ fresh: true })  // at the leader: sees every finished write
const mine = scope(() => { users.data.u43.here(); users.data.u44.here() })   // two more, ended together
mine.dispose(); me.close()                              // after the linger: unsubscribed. The pictures stay warm
console.log(u, same, sure)
```

**Guarantee.** `get()` reads once and keeps nothing. `here()` holds the row's partition by choice: the rows so far, then each change, with no gap and no overlap; a reconnect misses nothing. A read is served here only while a `here()` or `tap` holds the partition; `fresh` asks the leader. A sync read of a row not held throws `not-held`, never a stale answer. With a size, a closed selection's picture stays warm inside the bound, not subscribed: opening it again sends its position, and only the changes since cross if the server can still resume (LENS 2.2; reasoned, not built). **Cost.** One trip per `get()`; one SUB per `here()`, shared by equal lenses; later reads through the handle are one lookup. **Layer:** L3, L4.
**Evidence.** The cursor rule is model-checked across a leader crash, a reload, a slot move and a relay ([E-31]). A read holds nothing: 100,000 GETs, 0 SUBs, 0 rows kept (E-55 claim 20). Reads served here only from rows held on purpose: 1 pattern per program over 1,000 collector seeds (E-55 claim 14). The warm cache is not built.

### P-04 Read-through cache

```ts
// file: p04.ts — read-through cache over another system
import { fero } from 'fero'
const prices = await fero('prices', { rows: { ttl: '5m' }, load: (sku) => db.price(sku) })   // load is code: a server
console.log(await prices.data['sku-1'].get())           // a miss waits for one load, however many miss at once
```

**Guarantee.** One `load` per key however many readers miss at once. The loaded row is written `if: { absent: true }`, so a write that lands during the load wins. `undefined` writes nothing. **Cost.** One `load`, then one commit, per miss. **Layer:** L4, using L2's condition.
**Evidence.** Six readers missing one key made one load, in 100 of 100 seeds in each mode ([E-22]).

### P-05 WebSocket fan-out by room

```ts
// file: p05.ts — websocket fan-out by room (two files)
import { fero } from 'fero'
type Msg = { text: string; at: number }
// ── chat.ts, a server: a room is a partition, a message a row
await fero('chat', { server: true, depth: 2, rows: { ttl: '1d' }, history: '1d' })
// ── web.ts, a webserver: a client that holds only the rooms its sockets are in
const chat = await fero<Msg, 2>('chat')
wss.on('connection', (ws, room) => {
  chat.data[room].connect(ws, (ws, c) => ws.send(c.text()))   // the room so far, then each commit; ends when ws closes
  ws.on('message', (text) => { chat.data[room][fero.id()].set({ text, at: fero.now() }) })
})
```

**Guarantee.** Order per room. A webserver never receives a room none of its sockets is in. A reconnect within `history` misses nothing. A socket's link ends when the socket closes: a `WebSocket` and a Node `EventEmitter` are kinds fero knows. **Cost.** Each change is encoded once at the server, however many hold it: 0.01 to 0.46 µs per record per reader (PATHS 0). On the webserver, the sockets of one room share one SUB, one decode and one fold per change, and **one JSON text per commit** (`c.text()`, E-55 claim 9), not one per socket. A room is a partition (`depth: 2`), so its first picture needs no index from partition to rows (PA-17), and a message is a row with its own `ttl`. About 1,000 sockets a core keep a round near 10 ms ([E-08]). **Layer:** L3.
**Evidence.** Met as the bar was restated (a relay batches a room for a few ms); as first worded, "one hop after the commit" is not met ([E-08]: p99 1.2 ms at 1,000 subscribers). Sharing measured on the prototype: exactly one SUB, one decode and one `c.text()` per commit for 2,000 links (E-55 claim 9).

### P-06 Pub/sub

```ts
// file: p06.ts — pub/sub (two files)
import { fero } from 'fero'
// ── news.ts, on a server
await fero('news', { server: true, rows: false })                // keeps no rows: a stream
// ── app.ts, a client
const news = await fero<{ headline: string }>('news')
const sub = news.data.sports.changes()                           // from now on: "now" is this call
await news.data.sports.set({ headline: 'late winner' })          // made after the call, so the reader sees it
for await (const e of sub) { console.log(e.value); break }       // a live reader ends on break or close()
```

**Guarantee.** Every current subscriber gets every message, in order per subject. A subscriber is current from its `changes()` call: a message this process publishes after that call is always seen (section 3.10). Nothing is kept after delivery (`history` 0, `rows: false`). **Cost.** One commit per publish, shared: every write commits on disk (V5-5). A publisher that cannot wait awaits `.received` (0.15 ms). The no-disk kind is not in the first build. **Layer:** L2, L3.
**Evidence.** Open: not timed against `nats bench` ([E-45]'s NATS gateway is the way).

### P-07 Streams and replay

```ts
// file: p07.ts — streams and replay (two files)
import { fero } from 'fero'
// ── events.ts, on a server
await fero('events', { server: true, rows: false, history: '7d' })
// ── app.ts, a client
const events = await fero<{ type: string; cents: number }>('events')
const ack = await events.data['order:981'].set({ type: 'paid', cents: 1200 })
const r = events.data.changes({ from: savedCursor ?? 'earliest', until: 'latest' })   // every partition; a saved cursor goes back in as it is
for await (const e of r) { console.log(e.partition, e.version, e.value); save(r.cursor) }
events.data['order:981'].changes({ from: ack.version }).close()   // one partition, from a version
```

**Guarantee.** Every committed record of the selection, once, in order per partition. A position keeps its meaning across failovers and moves. Past `history`, the reader gets `expired` with the earliest kept cursor. **Cost.** Every kept record of the selection crosses the wire once. `credit` (1 MB by default) bounds what is in flight. A cursor is 22 to 79 B for 1 to 10 partitions. **Layer:** L1, L3.
**Evidence.** The log-reader rule holds on ten bounds ([E-31]); E-22 resumed from saved cursors.

### P-08 Consumer groups

```ts
// file: p08.ts — consumer groups
import { fero, consumer } from 'fero'
type Order = { user: string; cents: number }
const orders = await fero<Order>('orders')
const invoices = await fero<{ order: Order | undefined; at: number }>('invoices')
const invoicing = await consumer(orders, 'invoicing')
invoicing.run((e) => invoices.data[e.partition].set({ order: e.value, at: e.time }, { from: e }))   // exactly once: the mark is on the line
for await (const batch of await consumer(orders, 'billing')) {                                      // at least once
  for (const e of batch.entries) await bill(e.value)
  await batch.commit()                                  // a paused member's commit is refused 'fenced'
}
```

**Guarantee.** Each share has one live owner at a time, with its own token. A crash hands its shares on within one lease plus one commit. `commit()` gives at least once. `run()` with `{ from: e }` gives exactly once, even after a long restart: each output's own entry carries a mark of the source position it came from ([E-30]), and the library paces the loop, so a marked write is never dropped for `backpressure`. `run()` restarts from its share's cursor, which moves only once the marked writes up to it are answered; a write made again is skipped at its mark (section 3.11; this page's reading). **Cost.** `run`: a share of one commit per output, with a 29 B mark; the outputs are not awaited, so they pipeline. `commit()`: one commit per batch. **Layer:** L5, over L3 and L2's lock check and marks.
**Evidence.** Nothing skipped and no paused member committed (40 of 40, [E-22]; [E-30] past the dedup horizon). Pacing: 0 lost and 0 doubled in 1,000 seeds of E-55's stand-in (claim 21). E-30's model with `{ from: e }` written by app code is owed. The hand-on time is not measured.

### P-09 Work queue

```ts
// file: p09.ts — work queue (two files)
import { queue } from 'fero'
// ── jobs.ts, on a server
const jobs = await queue<{ url: string }>('thumbs', { server: true, lease: '30s', deliveries: 5 })
await jobs.add({ url: 'a.png' })
// ── worker.ts, a client
const work = await queue<{ url: string }>('thumbs')
work.work(async (job) => { await resize(job.url) })     // returns: done. throws: try again; 5 tries, then thumbs.dead
```

**Guarantee.** At most one live lease per message. None is lost while unacked. First in, first out per partition. After `deliveries` tries, the message moves to `thumbs.dead`. **Cost.** Three commits per message: add, take, ack. An empty take writes nothing. **Layer:** L5, on L2's `claim`. Unchanged by the lens.
**Evidence.** One worker killed and one paused 40 s: each job removed once, never under two live leases ([E-22]).

### P-10 Locks and leader election

```ts
// file: p10.ts — locks and leader election
import { fero, lock } from 'fero'
const ledger = await fero<{ by: number }>('ledger')                           // it only writes: it holds nothing
await lock('payroll', { lease: '10s', wait: '5s' }, async (l) => {            // released on return or throw
  await ledger.data['run-42'].set({ by: process.pid }, { if: { lock: l } })   // an older holder: 'fenced'
})
const leader = await lock('leader:billing', { wait: 'forever' })              // held until release()
leader.lost.then(() => process.exit(1))                                       // lost the lease: stop acting
```

**Guarantee.** At most one holder per lease, by writer time. Tokens rise for ever and compare with `<`. A write under a token older than one its partition's leader has seen is refused `fenced`; the check reads no other resource. A stale write can still land before the new holder's first write to that partition. **Cost.** Taking a lock is one conditional write: one commit. A write under a lock is an ordinary write with one more check at its own leader. **Layer:** L5, on L2's conditions.
**Evidence.** The check refused every stale write under every clock fault ([E-21]); E-22's fencing checks were clean in every seed.

### P-11 Counters and rate limits

```ts
// file: p11.ts — counters and rate limits (two files)
import { fero, op, limiter } from 'fero'
// ── counters.ts, on a server
await fero<number>('views', { server: true })
await limiter('api', { server: true, max: 100, per: '1m' })
// ── app.ts, a client
const views = await fero<number>('views')
const a = await views.data['page:/'].set(op.incr(1))    // a.value is the new count; a retry never counts twice
const api = await limiter('api', { max: 100, per: '1m' })
console.log(a.value, (await api.take('user:42')).left)  // past 100 a minute: 'limited', with retryAfter
```

**Guarantee.** Each answered `incr` counts exactly once across retries; `a.value` is the count it made. A bound (`op.incr(-1, { min: 0 })`) is never crossed: the write is refused `conflict`. A refused take writes nothing. **Cost.** One commit per count; the op is at most 3 µs at the leader (a bar, not measured). For a count nobody needs back, do not await it: `views.data['page:/'].set(op.incr(1))`. **Layer:** L2; `limiter` is L5.
**Evidence.** Exactly once and the bounds held ([E-22], [E-20]).

### P-12 Leaderboards, live aggregates

```ts
// file: p12.ts — leaderboards, live aggregates (two files)
import { fero } from 'fero'
type Score = { player: string; room: string; points: number }
// ── server.ts
const scores = await fero.of<Score>()('scores', { methods: { top: (n: number, ctx) => ctx.data.za('points', n) } })
export type Scores = typeof scores
scores.data.za('points', 10).tap((c) => render(c.now.rows))   // a server holds every row: the view runs here
// ── screen.ts: `import type { Scores } from './server.ts'`; it holds nothing
const fan = await fero<Scores>('scores')
const live = fan.methods.top(10).here()                 // the server keeps the view; only its changes cross
live.tap((c) => render(c.now.rows))
live.map((s) => s.player).connect(board, 'rows')        // top on a server, map here; the view ends with `live`
// @ts-expect-error the typed client checks the argument: top takes a number
fan.methods.top('ten')
```

**Guarantee.** A view equals its query over the committed rows after each commit. A whole-resource view on a client that does not hold the resource is refused `not-held`; that is why the screen asks the server's named view (class C). Equal calls share one view on a server. A client holds at most `views.client` served views, and the resource serves at most `views.max`; past either, `too-many-views`. `map` right of `here()` runs here. **Cost.** The view is kept once, on a server, for all equal calls: its own work per change, and 9.9 KB to 12.8 MB of memory (E-55 claim 16). A screen receives only the view's changes. **Layer:** L4, data's operators; L3 for the served view.
**Evidence.** Open: a served view is not built on the prototype (E-55 claim 27), and the `view` selector is not modelled (claim 22). `group` costs 2,574 µs at 1,000,000 rows against the 1 µs bar ([E-05]).

### P-13 Presence

```ts
// file: p13.ts — presence (two files)
import { fero } from 'fero'
// ── online.ts, on a server
await fero('online', { server: true, rows: { while: 'session' } })   // a row dies with the process that wrote it
// ── app.ts, a client
const online = await fero<{ since: number }>('online')
const all = online.data.here()                                       // it shows who is here, so it holds every row: a line
await online.data.ada.set({ since: fero.now() })
await all.ready
console.log(Object.keys(all.rows))
```

**Guarantee.** When a process dies, its rows go on every copy within `session.ms` plus one tick, by a log record. A live process's rows are never removed. **Cost.** One commit per row. Showing who is here holds every row, and the line `online.data.here()` says so. **Layer:** L2.
**Evidence.** A killed client's rows went within 9.8 s of a 10 s lease; a client paused 5 s kept its rows ([E-22]).

### P-14 Invariants

```ts
// file: p14.ts — invariants (two files)
import { fero, op } from 'fero'
type Item = { left: number; price: number }
// ── stock.ts, on a server
const stock = await fero.of<Item>()('stock', { methods: {
  sell: { at: 'row', run: async (_: void, ctx) => (await ctx.at.left.set(op.incr(-1, { min: 0 }))).value as number },
  reprice: { at: 'row', run: (price: number, ctx) => ctx.at.set((row) => row && { ...row, price }) },
} })
export type Stock = typeof stock
// ── shop.ts, a client typed by the server
const shop = await fero<Stock>('stock')
const left: number = await shop.data.widgets.sell()     // at widgets' leader: one trip, one commit
await shop.data.widgets.reprice(12)                     // read, decide, write at the leader
// @ts-expect-error sell is declared `at: 'row'`: it is not offered below the row
await shop.data.widgets.left.sell()
console.log(left)
```

**Guarantee.** Ops, conditions and `set(fn)` are judged at the one leader, on the newest state, and a refusal waits for that state's commit. Two sells of the last item: exactly one succeeds; the loser gets `conflict`. A method declared `at: 'row'` runs only on a row: a call below it or at the root is refused `bad-path`, and does not compile. **Cost.** A sale: one trip and one commit, since a call on a path goes to its row's leader. A reprice: one conditional write per try, at the same leader. **Layer:** L2, the path check too: the leader checks the path before the handler runs.
**Evidence.** One winner in all 300 races under leader changes, slot moves and the shuffle ([E-22]); every history linearizable ([E-22b]). A call on a path: one trip and one commit per call, and 202 of 202 calls on an undeclared path refused (E-55 claim 18, a stand-in). `set(fn)` is the condition form with a retry loop; the loop did not run.

### P-15 Transactions across partitions

```ts
// file: p15.ts — transactions across partitions (a saga)
import { fero, op, saga } from 'fero'
const accounts = await fero<{ cents: number }>('accounts')   // it only writes: it holds nothing
await saga([
  { at: accounts.data.alice.cents, value: op.incr(-5000, { min: 0 }) },   // a step takes one lens
  { at: accounts.data.bob.cents, value: op.incr(5000) },
], { once: 'tx-981' })                                  // all applied or all undone; readers may see half
saga.sweep({ every: '10s' })                            // on a server: finish what a dead holder left
```

**Guarantee.** Every saga ends all applied or all undone, by its holder or a later one, even with paused holders. A step whose op has no inverse needs its own `undo`, or the saga is refused `no-undo` before it starts. Readers may see the steps one at a time. A step takes one lens: a client typed by a resource with methods has none to give (V4-5). **Cost.** 6 to 7 commits in a row, about 7 ms. If both rows can share a partition (`depth: 2`), one `batch` does it in one commit: model for that first. **Layer:** L5.
**Evidence.** Model-checked on seven bounds, up to 2.9 million states ([E-24]); no write cycle in 300 histories ([E-22b]). Readers saw half a unit in 66 to 77 of 100 histories ([E-22]).

### P-16 Event sourcing, CQRS

```ts
// file: p16.ts — event sourcing, CQRS (two files)
import { fero } from 'fero'
type Fact = { account: string; cents: number }
// ── facts.ts, on a server
await fero<Fact>('facts', { server: true, rows: false, history: 'all' })                 // every fact, for ever
// ── app.ts, a client
const facts = await fero<Fact>('facts')
await facts.data['acct:alice'].set({ account: 'alice', cents: 500 })                     // a fact is written whole, once
const balance = new Map<string, number>()
for await (const e of facts.data.changes({ from: 'earliest', until: 'latest' }))         // rebuild, then stop
  if (e.value) balance.set(e.value.account, (balance.get(e.value.account) ?? 0) + e.value.cents)
```

**Guarantee.** `history: 'all'` never drops a record. A rebuilt projection equals the live one, because both fold the same records with `data`. The loop reads `e.value`, which is set only for a whole-row write: so each fact is written whole, once. **Cost.** A rebuild reads the whole kept log once. **Layer:** L2, L4.
**Evidence.** E-22's rebuild check passed. Byte for byte is open for a `sum` (it depends on record order, [E-43]) and for ties in a top-k ([E-23]).

### P-17 Derived resources

```ts
// file: p17.ts — derived resources
import { fero, op, derive } from 'fero'
type Order = { user: string; cents: number }
const orders = await fero<Order>('orders')                       // the deriver is a client of its source
const totals = await fero<number>('totals', { server: true })    // and a server of its own resource
await derive(orders, totals, (e) => { if (e.value) totals.data[e.value.user].set(op.incr(e.value.cents), { from: e }) })
```

**Guarantee.** Each record of `orders` changes `totals` exactly once, across crashes, restarts and moves, as long as `orders` keeps its log (its `history`, or the tier) back to the marks. A deriver that comes back after the log was cut stops with `expired` and says so; it never skips a record (LAYERS 8.8). `op.incr` is not idempotent, so this is the hard case on purpose. An order must be written whole, once: `e.value` is unset for a field write, so the `if` skips it. `derive()` paces the loop, so a marked write is never dropped for `backpressure`, runs it once by splitting the source's shares, and sends bare marks for idle slots (section 3.11). The four lines it is made of are exact only paced and in one process. **Cost.** Per source record: one delivery, one run of the function, a share of one commit, a 29 B mark. Run on three servers, the source is still read once. The writes are not awaited: 122,000 to 134,000 a second against 239 to 240 awaited (E-55 claim 21). **Layer:** L5.
**Evidence.** The mark is model-checked: no output twice ([E-30]). Pacing: as written, 998 of 1,000 seeds of E-55's stand-in lost outputs; paced, 0 lost and 0 doubled (E-55 review, claim 21). E-30's model with marks written by app code is owed.

### P-18 Tapes, forks, replays

```ts
// file: p18.ts — tapes, forks, replays (two files)
import { fero, tape } from 'fero'
// ── try.ts, on the live cluster
await fero.fork('shop', { as: 'shop-try' })             // shares the parent's history: one record per group, no copy
// ── a test run: one world per process, virtual time, seeded ids
const w = fero.world({ seed: 7 })
const shop = await fero<{ at: number }>('shop', { listen: false })   // a solo node with no socket
const ack = await shop.data.k.set({ at: fero.now() })
await w.advance('1h')                                   // ttls, leases and timers fire in order
const past = (await shop.data.k.asOf(ack.version)).step(-1)   // step moves the reader: the row just before that write's commit
const stripe = await tape<{ cents: number }, { ok: boolean }>('stripe', { window: '14d' })
console.log(past.value, stripe.find('charge:981'))
past.close()                                            // a reader's memory grows with its window
```

**Guarantee.** A fork is one consistent cut per group. A world makes a run a function of its seed. A recorded input re-runs on the exact earlier state. `asOf` gives a lens as it was, read-only, folded in this process; a step is one commit. **Cost.** A fork is one record per group, not a copy. It is a new resource, so it has a resource's own cost (section 3.1). `asOf` on one row's partition: its window's records once, 3.6 to 4.4 µs a record to fold, 103 to 285 B a version, in the reader only (E-55 claim 23). **Layer:** L1, L4; `tape` is L5; `asOf` is a reader library.
**Evidence.** Tapes and reruns held on prototypes ([E-22], [E-06]). `asOf` on data's real fold: 0 wrong answers in 1,680 checks against a refold (E-55 claim 23). The fork is not built.

### P-19 Clients everywhere

```ts
// file: p19.ts — clients everywhere (a browser, an edge worker)
import { fero, scope } from 'fero'
type Item = { sku: string; n: number }
const token = 'from your server: fero.token({ sub: "ada", read: ["ada"] })'
const shop = await fero<Item, 2>('carts', { hosts: ['wss://shop.example.com'], token })   // depth 2: a cart is a partition
const page = scope(() => {
  shop.data.ada.connect(el, (el, c) => draw(el, c.now.rows))   // the cart so far, then each commit
})
// page.dispose() when the page or component goes: a DOM node does not say when it is removed
```

**Guarantee.** The same API in Node, Bun, Deno, browsers and edge workers, over WebSocket. A browser build in which a server role throws `no-server-here` is later (V5-12 pick 12). The link ends at `close()` or with its scope. A removed element ends it only through the net, the collector, and in a browser that may never happen (section 3.10). **Cost.** A browser has one link, so its writes take the forward path: one more trip than a Node client's (V5-9). With `depth: 2` a cart is a partition, so its first picture is that partition, with no walk of partition names. The bundle with `data` is 27.9 KB gzip; a cold client's first committed write took 13 to 17 ms ([E-40]). **Layer:** L0's transport, L3, L4.
**Evidence.** Met on E-40's prototype, under the earlier spelling. A headless Chromium ended 0 of 1,000 links to removed DOM nodes within 30 s by collection (E-55 claim 13): a page's links end by its scopes.

### P-20 Change the shape of rows

```ts
// file: p20.ts — change the shape of rows
import { fero, migrate, type Rec } from 'fero'
const shape = { version: 2, up: { 1: (r: Rec) => r } }  // how a version-1 record reads as version 2
await fero.alter('users', { shape, schema: UserV3 })    // online: a record in the resource's own log
const users = await fero('users', { shape, schema: UserV3 })
await (await migrate(users, { to: 2, fn: (row: any) => row, perSec: 500 })).done   // rewrite live rows, paced
```

**Guarantee.** The resource's log records from which position each `shape.version` is in force. An older record passes the upcasters in order on every path (folds, links, replays). An open with a new `shape` is refused `config-differs`, so a bump is a `fero.alter`, which needs the admin key. **Cost.** At the bump, each process passes its held rows through the upcaster once. `migrate` runs at a stated pace, under the bulk byte-rate cap (V5-9). **Layer:** L4; `migrate` is L5. Unchanged by the lens.
**Evidence.** Upcasters held across three versions with the migrating server killed ([E-22]).

### P-21 Request and reply

```ts
// file: p21.ts — request and reply (two files)
import { service } from 'fero'
// ── worker.ts, on each answerer
const thumbs = await service<{ url: string }, { url: string }>('thumbs', { server: true })
thumbs.answer(async (req) => ({ url: await resize(req.url) }))
// ── app.ts, an asker
const asker = await service<{ url: string }, { url: string }>('thumbs')
console.log((await asker.ask({ url: 'a.png' }, { timeout: '5s' })).url)   // one answer, 'timeout' or 'no-answerer'
```

**Guarantee.** Requests spread over the live answerers. Each request gets at most one answer. With no live answerer, `no-answerer` at once, by this process's view of who is alive. **Cost.** Three commits per ask ([E-22] D7). When the answerer is a fero server, a method is the cheaper request and reply: one trip, and commits only for what it writes; on a path, at that path's leader. **Layer:** L5. Unchanged by the lens.
**Evidence.** 383 answers and 17 timeouts of 400 asks, never two answers ([E-22]).

### P-22 Delayed jobs, waiting takes, priorities

```ts
// file: p22.ts — delayed jobs, waiting takes, priorities (two files)
import { queue } from 'fero'
// ── mail.ts, on a server
await queue<{ to: string }>('mail', { server: true })
// ── app.ts, a client
const mail = await queue<{ to: string }>('mail')
await mail.add({ to: 'ada' }, { delay: '15m' })                          // counted from writer time
await mail.add({ to: 'ops' }, { cron: '0 6 * * *', key: 'daily-report' })  // a schedule is a row: added once, for good
await mail.add({ to: 'vip' }, { priority: 0 })
const [m] = await mail.take(1, { wait: '20s' })         // woken by an add; writes nothing while it waits
if (m) { await sendMail(m.job.to); await m.ack() }
```

**Guarantee.** A delayed message becomes takeable within one tick of its time, by writer time, never before. A waiting take writes nothing while it waits. Priorities hold within a partition. A `cron` schedule is a row under its `key`, written only if absent: the line can run at every start-up, for years, and adds the schedule once. (A `once` name would not do: it lasts a day, so a start-up two days later would add a second schedule.) **Cost.** As P-09. A lapsed lease is noticed at the library's next poll, once a second ([E-22] D6). **Layer:** L5. Unchanged by the lens.
**Evidence.** No delayed message was taken early, and priority 0 came first in every seed ([E-22]).

## 11. Open questions

### 11.1 For the owner

Each has this page's pick. [API-TOUR.md](API-TOUR.md) section 5 says more on each. Questions 1 to 14 keep the first tour's numbers. The first tour's 15 and 16 are this page's Q-B1 and Q-B3 (section 11.2), so 15 to 24 here are new numbers, the same as in the tour's section 5.2. **V5-12 closed six of the fourteen** (LENS 4.2 item 12); each says by what. Three more are settled in use.

1. **`f.rows` for reads; what is `f.snapshot`?** This page: `rows` is the lookup, and `snapshot` keeps v4's meaning, a whole frozen picture per access, at v4's cost. The other way makes `snapshot` a second name for the live `rows`: old lines get fast for free, but one word then means two things (section 3.9). With the lens, both read only a whole resource held on purpose (a server, or `hold: 'all'`).
2. **Verbs on the resource (`f.set`), or on `f.data` (`f.data.set`)?** **Closed by V5-12** (its list of what goes names `f.data.set`; LENS 2.5): the path write is the main spelling (`f.data.k.set(v)`); `f.set(path, v)` stays as the array form; `f.data.set` goes.
3. **`near` on a method: now, or after the first build slice is timed?** **Closed by V5-12 picks 3 and 13**: `near` goes. A method called on a path runs at that path's leader, and declares `{ at: 'row' | 'partition' | 'any', run }`; the server refuses any other path with `bad-path`.
4. **`set(key, fn)`: add it?** **Settled in use**: V5-12 approved LENS section 2's shape, and LENS 2.5 writes `lens.set(fn)`. The owner has not ruled on it by name, so a "no" still removes it. This page: yes, as `lens.set(fn)`. It is the one new verb form, and it costs nothing unless called. The risks: a function that is not pure and runs twice; and it can give up with `conflict`.
5. **`changes`, `log` or `read`** for the record reader. **Settled in use**: V5-12's own text says `changes`. This page: `changes`, now a verb on the lens. `log` matches V5-1's word but reads like a logger; `read` reads like reading a row.
6. **What a write does when the client is full** (512 waiting, or 64 MB). This page: a verb's handle rejects `backpressure`; an assignment throws it; a marked write waits and pauses its reader (V5-12). The other way for assignment, one stderr line as for any refused assignment, loses writes without the code knowing.
7. **Must some process say `server: true` to create a resource?** This page: yes, as v4, and the patterns keep it in a server file. The other way is an admin act (`fero create`), so that no app file can become a server by mistake.
8. **A client's default `hold`.** **Closed by V5-12 pick 1**: a bare `fero(name)` holds nothing until a `here()` or a `tap` says what; `hold: 'all'` stays as an option, and a size is a cache of pictures that is not subscribed. The cost the owner accepted: v4's first example and about 20 example READMEs change, and `client.rows.widgets` after a bare open throws `not-held` (LENS 7 Q1).
9. **A `get` that misses: follow for good, or read once?** **Closed by V5-12** (its list of what goes, and pick 11): `lens.get()` reads once and holds nothing; `get`'s `hold: false` goes; a read that should go on is a `here()`.
10. **Should the typed client of a resource with methods have no `set`, `remove`, `batch` or `touch`?** **Closed by V5-12** (LENS 2.4's shape, which pick 14 has this page carry): yes. It is in section 6 now: the typed client's lenses and root have no writes, and the lines in `client.ts` and `types.ts` that try them do not compile.
11. **`{ retry: true }` on a call: keep v4's cheap resend?** This page: yes, beside `once`. Without it an idempotent call pays three commits, or the app writes its own retry.
12. **A write with `once` has no early stages.** **Settled by V5-11 ruling 6**, which the owner approved: a write that can be refused takes no early stage. This page: so, because its name can be refused, and V5-11 ruling 6 forbids an early answer before a refusal. A marked write has none either: it can be skipped at its mark.
13. **The partition function.** **Closed by V5-12 pick 4**: it stays in the API and is built later. `{ before }` goes for `depth: 1 | 2`, and V5-2's "a prefix" reads "the first key".
14. **Names only:** `once`; `not-held`; `consumer`; `if: { lock }`; `hold` (now nothing by default, `'all'` or a size); `copies` and `standbys`; `fero.of<Row>()`; `e.value`; a queue's `key`; `ping.ms` (v4: `heartbeat.ms`); `rendezvous` as a list (the other way: a new `seeds` key); `handback.max`; `bulk.rate`. **New with the lens:** `here`, `connect`, `tap`'s `c`, `at`, `depth`, `ctx.at`, a method's `at:`, `{ from: e }`, `marks`, `mark`, `asOf`, `call`, `closes`, `scope`, `linger.ms`, `views.client`, `views.max`, a token's `read` claim. The old names touch no wire. Of the new ones, `{ from: e }`, a call's path, `depth` (a record's key starts with its partition) and the `view` selector touch the record or the wire (LENS 4.3).

**New on this page: choices the rewrite made where LENS and V5-12 leave room.** Each has this page's pick.

15. **`f.rows` on a client.** This page: only with `hold: 'all'`, as LENS 2.2 writes it; a partition held by `here()` is read through its handle. The other way lets a live `f.data.here()` count too, since it holds the whole resource on purpose.
16. **The lens's config keys** (section 9). This page: `linger.ms` as a process key (1000, a guess), and `views.client` and `views.max` as resource keys (16 and 1,000, guesses). LENS names a linger and a cap but no key and no number.
17. **`bad-path` for a write above a row.** This page reuses `bad-path` for a write on the root, or on a partition at depth 2. LENS defines `bad-path` for methods only; the other way is a code of its own.
18. **`f.get(k)`, `f.data.snapshot()` and a token's `follow` claim go.** This page reads LENS 2.6 (`await f.get(k)` becomes `await f.data[k].get()`) as removing `get` from the resource, keeps `f.remove(path)` and `f.touch(path)` as array forms beside `f.set(path, v)`, drops `snapshot()` as a lens verb, and renames the claim `read`. None of the four is in V5-12's list. **`ctx.use(other)` stays**: a draft of this rewrite dropped it with derive's `out`, but no decision names it, and without it a handler's writes to a second resource would fall outside the `once` re-run rule and the caller's session (section 7). `claim` is not on a handler's `ctx` any more (the 2026-11-16 `ctx` had every verb); no pattern used it there.
19. **`changes()` on a lens below a partition.** This page: the partition's records cross (user rule 4) and the reader gets those under the lens. The other way gives the whole partition's records.
20. **A marked write with a `once` name.** This page: not allowed; the types refuse `{ from: e, once }` (section 3.11). The mark already counts the write once per source record. The other way, which LENS 4.4's row allows for ("must compose with `once` and `if`", 0 to +2 rules), has the leader check the name and the mark on one write, in a stated order. `if` and `ttl` compose with a mark either way.
21. **One source record with several marked outputs.** As LENS 2.8's rule is written, a second marked write of the same `e` to the same output slot would be skipped, and nothing commits a record's outputs together (section 3.11). This page: until it is modelled, one marked write per source record per target; and its pick is that the mark also carries the write's number within its record. The other ways: a `batch` that takes `{ from: e }` (it covers one partition only, and a slot holds many), or a mark per output partition.
22. **When `asOf` is built.** V5-12 counts it outside the first build's rules and gives no slot. This page and LAYERS 9.4: after the first build. It needs nothing from the kernel, so it can come at any time.
23. **Behind the door: `mark` and `claim`; and `touch` on a row only.** This page: a bare mark and a claim are writes, so a client of a resource with methods has neither (`methods-only`), and the typed client does not show them. `touch` is offered on a row lens only, since a ttl is a row's. LENS does not speak to any of the three.
24. **How `consumer().run()` restarts, and which name a mark goes under.** LENS 2.8 says `run` sends bare marks, but `run` has no target. This page: `run` restarts from its share's cursor, moved only once the marked writes up to it are answered, and sends no bare marks; a mark goes under the name its reader was started with (`marks(name)`, or the consumer's name), else under the target's own name (section 3.11). The other way gives `run` a target, as the old `out.use(target)` did.

### 11.2 For the design

Each is a gap the records leave. None changes a call.

- **Q-B1. An early answer, then a refusal that is not about the row.** V5-11 ruling 6 says an early answer is never followed by a refusal. A plain whole-row write cannot be refused on the row's state. But after a failover the resent write is judged again (MEMORY 9.6), and three things may have changed by then:
  - the write gate is closed (`read-only`), or a disk is full (`disk-full`). **This page's pick:** fero keeps retrying through those two, so the handle ends at the commit, `timeout` or `unknown`.
  - the writer's token was revoked (`forbidden`). Retrying cannot clear that. **This page's pick:** the handle rejects `forbidden`. It is the one refusal that can follow an early answer, and it is an admin's act, not the state's. Answering `unknown` would say "it may have committed", which is false.
  - **Decides:** [E-48]'s model with a gate and a revoke.
- **Q-B2. When must a stage be asked for?** PATHS 3.3 sends an early report only for a write that asked. MEMORY 9.6 makes the stage promises lazily. This page joins them as "ask in the turn that makes the write" (section 3.5). **Decides:** the build of the second step.
- **Q-B3. Who serves the system resources and the libraries' resources** (`#sessions`, `#locks`, `#sagas`, `#calls`, `#groups`, a queue)? With no project groups, each is a resource with its own cluster. This page reads: any process that serves a resource serves the system ones, and a library's resource takes `server: true` like any other (section 7 "Roles"). It shows in the cold-open cost and in what a client waits for. **Decides:** [LAYERS.md](LAYERS.md) section 10 item 5.
- **Q-B4. Where the timing keys live** (section 9). Answered by LAYERS 5.3 (reasoned): a value every copy must agree on (`skew.max`, `lag.max`, `catchup.max`) is in the resource's settings record; `session.ms` is in `#sessions`' own; a value one process applies alone (`ping.ms`, `evict.after`, `settle.ms`, `leave.ms`, `handback.max`) is a process key. Section 9 agrees, and puts `linger.ms` with the process keys and `views.*` with the resource's.
- **Q-B5. Is a process-wide `dir` or `listen` a server marker for every open?** v4 reads them per call. With the role per resource, this page reads them as markers only where the call, or a per-name layer, gives them. **Decides:** the config tier's tests.
- **Q-B6. `set(fn)`'s give-up.** 8 tries is a guess. **Decides:** a timed hot-key run.
- **Q-B7. When "now" is, for `changes()`** (section 3.10). The rule "a write made after the call is seen" needs the client to hold its own writes until the open is answered, on a process that does not hold the selection. Nothing modelled it. **Decides:** [E-31]'s model with a writer that also reads.
- **Q-B8. Who runs a `derive`.** **Closed by V5-12** (LENS 4.3 item 4): `derive` and a consumer's `run` are loops of public calls, so who runs them is the app's choice. `derive()` splits the source's shares among the processes that run it; the four lines need a lock (section 3.11). LAYERS 6.3 and 8.8 now say the same, and LAYERS dropped its old reading (the leader of the target's group as the one deriver).
- **Q-B9. Shared links, and when `await fero()` resolves** (sections 3.10 and 3.1). Sharing is now measured on the prototype: one SUB, one decode and one `c.text()` per commit for 2,000 links (E-55 claim 9). When `await fero()` resolves is still stated from reasoning. **Decides:** the build.

**Owed before the lens ships** (LENS 7 Q14; V5-12's consequences):
- **The `view` selector in [E-31]'s model** (E-55 claim 22): failover, a reload, a slot move, a slow reader, a resume by a new picture, with `{ method, arg }`, in at most 8 rules. LENS 4.4 counts +4 to +6 rules when it is modelled; API's old `.open()` owed the same.
- **The 22 patterns end to end** (claim 25): E-22's prototype ported to the lens spelling, 100 seeds each. Section 10's lines compile; none ran.
- **A served view with its cap on the prototype** (claim 27): one SUB with `{ method, arg }`, one server view shared by equal calls, its lifetime, the cap refusing the next view with `too-many-views`, and a resume.
- **E-30's model with marks written by app code** (claim 21 is a seeded stand-in: no Raft, no lost log tails, no dedup horizon), including the leader's order rule per writer per output slot across a slot move (LAYERS 3.6), a source record with two marked outputs in one output slot (question 21; LAYERS section 10 item 31), the reader name a mark goes under, and `run()`'s restart from its share's cursor (question 24).
- **The pacing rule in a real client**: a marked write that waits and a `changes()` reader that stops yielding.
- **Not tested, and counted** (LENS 2.2; E-55's limits): a GET that carries the highest position seen, against copies that lag; rule Y for a `get()`. The prototype had one server.
- **data's changes** (V5-12 pick 9): D1, the keyed index, needs a pin when built (claim 8 sits at its bar: median 1.25 over 15 runs, the changed build's own 1.36, bar 1.3); D3, two-level stores, before small depth-2 partitions are cheap (claim 19); D4, one sink shape, which is most of a tap's cost (claim 10).

**Where this page and [LAYERS.md](LAYERS.md) stand.** LENS 4.3 lists what the lens changes there: L4 gains its first rules of its own (the lens, links, counts, the net, "held on purpose"); L3 keeps the SUB protocol and adds a registry of shared selections with counts and a linger, coverage of a partition by a held whole, the resume cursor as the server's position, a GET that carries the highest position seen, and the cap on served views; L2's key is `[partition, row, ...fields]` under `depth: 2`, the mark becomes a write option, and a call carries a path the server checks; L5's `derive` and `run` are loops of public calls. LAYERS.md was rewritten for V5-12 on the same day and now says all of this (its header table lists where). Who runs a `derive` is closed on both pages (Q-B8; LAYERS 6.3). One point from before stays open between the pages:
- **`busy`**: this page uses it for "every server tried has a stalled main thread"; DESIGN-V5 4.2 uses it for a member already loading two snapshots, an answer between servers that no app sees. LAYERS section 10 item 23 asks for one of them to be renamed.

### 11.3 Carried from COMP2's page

**Still settled:** `get` for one row and a separate verb for the log (Q-A5; both now verbs on the lens); no public `slots` key (Q-A7); a `once` name lasts 1 day (Q-A11); no `publish` verb, since `set` on a `rows: false` resource is publishing (Q-A13); offsets never in answers, a version has a number form for gateways (Q-A14); one error class (Q-A15); the libraries are named exports of `'fero'`, built only from the public calls (Q-A18); durations are `'30s'` or milliseconds, and config keys keep `.ms` numbers (Q-A19); functions run at the leader (Q-A20); shares for consumers (Q-A21); typed rows with an optional schema (Q-A22).

**Settled the other way now:** who creates a resource (Q-A1: a server, section 3.1); partition rules (Q-A6: `depth`, and a function later, V5-2 and V5-12 pick 4); where methods run (Q-A8: on a path, at that path's leader; with no path, where the caller reached; V5-12 picks 3 and 13); answer timing per call (Q-A9: stages, V5-5 and V5-11).

**Still open:**
- **Q-A10. Sagas that readers never see half of.** Not in 5.0. RAMP (modelled in [E-24]) is a possible later add-on (V5-1).
- **Q-A17. Request and reply at three commits.** Either P-21's bar is restated, or a later no-disk service is built and timed with `nats bench`.
- **Q-A25. Changing `copies` online.** With groups per resource, it is a change of the resource's own groups by its own leaders (reasoned). **Decides:** [E-52]'s model with a change of size.
- **Q-A26. A reader that ends** (`until: 'latest'`). Nothing tested it.
- **Q-A28. Rows bound to a named lease.** Not in 5.0: `while: 'session'` stays the one form.

## 12. How this file is checked

`env.d.ts` stands in for the app's own world, so the pattern files compile. `types.ts` holds what must and must not compile: each `@ts-expect-error` line fails the check if it ever compiles.

```ts
// file: env.d.ts — stand-ins for the app's own world, so the pattern files type-check
declare const console: { log(...a: unknown[]): void }
declare const process: { pid: number; argv: string[]; exit(code?: number): never }
interface Socket { send(s: string): void; on(ev: 'message', fn: (text: string) => void): void; on(ev: 'close', fn: () => void): void }
declare const wss: { on(ev: 'connection', fn: (ws: Socket, room: string) => void): void }
declare const ws: Socket
declare const db: { price(sku: string): Promise<{ sku: string; cents: number } | undefined> }
declare function resize(url: string): Promise<string>
declare function sendMail(to: string): Promise<void>
declare function bill(order: unknown): Promise<void>
declare function render(x: unknown): void
declare function draw(el: object, x: unknown): void           // changes only `el`
declare const el: { textContent: string }                     // a DOM node, say
declare const list: { textContent: string }
declare const board: { rows: unknown }
declare const savedCursor: string | undefined      // text from the app's own storage
declare function save(c: string): void
declare const UserV3: import('fero').Schema<{ id: string; name: { first: string; last: string } }>
```

```ts
// file: types.ts — what must and must not type-check
import { fero, op, saga, lock, derive, scope, type Cond, type Early, type Entry, type Judged, type Write, type Version } from 'fero'

// ── writes and their handle (V5-5, V5-11)
type N = { n: number }
const f = await fero<N>('f')
const w: Write = f.data.k.set({ n: 1 })                  // a plain whole-row write: early stages
const e: Early = await w.received
// @ts-expect-error an early answer has no version (V5-11)
console.log(e.version)
// @ts-expect-error an op answers at commit only: no early stage (V5-11 ruling 6)
await f.data.k.set(op.incr(1)).received
// @ts-expect-error a field write can be refused 'absent-row': no early stage
await f.data.k.n.set(5).replicated
// @ts-expect-error the array form of a field write too
await f.set(['k', 'n'], 5).replicated
// @ts-expect-error a condition answers at commit only
await f.data.k.set({ n: 2 }, { if: { absent: true } }).replicated
// @ts-expect-error a conditional remove too
await f.data.k.remove({ if: { present: true } }).received
// @ts-expect-error read-decide-write is judged: no early stage
await f.data.k.set((row) => row && { n: row.n + 1 }).received
// @ts-expect-error a batch is all or none: no early stage
await f.batch([{ key: ['a'], value: { n: 1 } }]).received
// @ts-expect-error a named write is judged (the name may be taken): no early stage
await f.data.k.set({ n: 4 }, { once: 'order-77' }).received
// @ts-expect-error a named remove too
await f.data.k.remove({ once: 'order-78' }).replicated
// @ts-expect-error a marked write answers at commit only: it can be skipped at its mark (V5-11 ruling 6)
await derive(f, f, (x) => f.data.a.set({ n: 1 }, { from: x }).received)
// @ts-expect-error a marked write takes no `once` name: the mark already makes it count once (section 3.11)
await derive(f, f, (x) => f.data.a.set({ n: 1 }, { from: x, once: 'o' }))
// @ts-expect-error nor a marked field write in the array form
await derive(f, f, (x) => f.set(['a', 'n'], op.incr(1), { from: x, once: 'o' }))
// @ts-expect-error nor a marked remove
await derive(f, f, (x) => f.data.a.remove({ from: x, once: 'o' }))
// @ts-expect-error derive's `out` is gone: fn takes the record alone and writes with { from: e }
await derive(f, f, (x: Entry<N>, out: unknown) => 1)
// @ts-expect-error a ttl belongs to a row: a field lens has no touch
await f.data.k.n.touch()
// @ts-expect-error a typed handle's steps are read-only, so assignment does not compile: typed code writes with set (V5-12 pick 6)
f.data.k = { n: 1 } as any
const j: Judged = f.data.k.set({ n: 2 }, { if: { absent: true } })
const acks = await Promise.all([f.data.a.set({ n: 1 }), f.set(['b'], { n: 2 }), j])   // handles await together
// @ts-expect-error the stage is what you await, never a write option
await f.data.k.set({ n: 3 }, { confirm: 'received' })
// @ts-expect-error no commit level per write (V5-5)
await f.data.k.set({ n: 3 }, { durability: 'memory' })
// @ts-expect-error the row type is checked
await f.data.k.set({ m: 1 })
// @ts-expect-error a field's type is checked
await f.data.k.n.set('five')
// @ts-expect-error a wrong field name is caught: a step names a field of the row
await f.data.k.m.set(5)
// @ts-expect-error a batch's whole-row value is checked against the row type
await f.batch([{ key: ['a'], value: { m: 1 } }])
// @ts-expect-error a derived output is checked against the target's row type
await derive(f, f, (x) => f.data.a.set({ m: 1 }, { from: x }))
// @ts-expect-error versions are opaque, never plain strings
const cond: Cond = { version: '9001' }
const v = (await f.data.k.get({ version: true }))?.version
if (v) await f.data.k.set({ n: 2 }, { if: { version: v satisfies Version } })
await f.data.k.set({ n: 4 }, { once: 'order-77' })      // a caller's name for the write
await f.set(['k', 'at'], op.now('15m'))                  // the array form: writer time, plus 15 minutes
// @ts-expect-error incr takes a number
op.incr('1')
const held: number = await lock('l', async (l) => { await f.data.k.set({ n: 5 }, { if: { lock: l } }); return 1 })
// @ts-expect-error a saga step takes a lens, not a key
await saga([{ key: 'a', value: 1 }])

// ── reads and the lens (V5-12)
// @ts-expect-error rows are read-only
f.rows.k = { n: 1 }
const row: N | undefined = f.rows.k                      // a lookup can miss
const pic: N | undefined = f.snapshot.k                  // v4's picture: the same type, a frozen copy
const stock = f.data.k.n                                 // an address: no trip, no read
const n1: number | undefined = await stock.get()         // the read is a verb
// @ts-expect-error a lens is not a promise: awaiting it gives the lens back, not a value
const n2: number | undefined = await stock
// @ts-expect-error nor is a row lens: awaiting it gives no row
const row2: N | undefined = await f.data.k
// @ts-expect-error nor is the root lens: awaiting it gives no rows (the case that once downloaded 100,000 rows)
const all2: Record<string, N> = await f.data
// @ts-expect-error get() holds nothing: there is no `hold: false` to pass
await f.data.k.get({ hold: false })
// @ts-expect-error get() moved onto the lens: the resource has no get
await f.get('k')
// @ts-expect-error f.data.set is gone: on the root, `set` is a step to a row named 'set', and a lens is not callable
await f.data.set('k', { n: 1 })
// @ts-expect-error follow is gone: a path, then here()
f.follow('k')
// @ts-expect-error nor on a lens
f.data.k.follow()
// @ts-expect-error a lens has no open()
f.data.k.open()
// @ts-expect-error changes' `of:` is gone: the lens is the selector
f.data.changes({ of: 'k' })
// @ts-expect-error read() is changes() now
f.read({ from: 'earliest' })
const r = f.data.k.changes({ from: v })                  // one partition, from a version
const text: string = r.cursor                            // a cursor saves as text
f.data.changes({ from: text }).close()                   // and goes back in as it is
const one = f.at(1, 'n')                                 // at(): numbers become strings; no Proxy
// @ts-expect-error at() takes strings and numbers only ('bad-key' when run untyped)
f.at(Symbol('k'))
// @ts-expect-error at() takes strings and numbers only, on any lens
f.data.k.at(true)

// ── options fixed at founding, and names that went
// @ts-expect-error the depth is fixed at founding
await fero.alter('f', { depth: 2 })
// @ts-expect-error the depth is 1 or 2
await fero('x', { depth: 3 })
// @ts-expect-error a seed is applied once, at founding
await fero.alter('f', { data: {} })
// @ts-expect-error `{ before }` is gone: the first key is the partition (V5-12 pick 4)
await fero('x', { partition: { before: '/' } })
// @ts-expect-error `hold: 'asked'` is gone: holding nothing is the default (V5-12 pick 1)
await fero('x', { hold: 'asked' })
// @ts-expect-error copies: 2 cannot keep a majority through one loss
await fero('x', { copies: 2 })
// @ts-expect-error a history is a number of records, a time or a size
await fero('x', { history: '7 days' })

// ── the line: plain data left of here(), your code right of it (depth 2: a room is a partition)
type Msg = { text: string; stars: number }
const chat = await fero<Msg, 2>('chat')
const best = chat.data.room1.gt('stars', 0).za('stars', 10).here()   // plain data: may run on a server
const mine = chat.data.room1.here().filter((m) => m.stars > 0)      // a function right of here(): runs here
// @ts-expect-error a function cannot stand left of here(): code cannot travel ('unencodable' when run untyped)
chat.data.room1.filter((m: Msg) => m.stars > 0).here()
// @ts-expect-error a partition is not a row: it has no `set`, so `set` is a step to a row of that name, and a lens is not callable
await chat.data.room1.set({ text: 'hi', stars: 0 })
await chat.data.room1.m7.set({ text: 'hi', stars: 0 })  // a row of room1
chat.data.room1.connect(el, (el, c) => { el.textContent = String(c.changes.length) })   // the target is passed in
// @ts-expect-error connect(target, 'prop') names a property of the target
chat.data.room1.m7.text.connect(el, 'innerHTML')
const page = scope(() => { chat.data.room2.here() })
page.dispose()

// ── methods: declared where they may be called; callers get typed arguments
const bank = await fero('bank', { data: { ada: { cents: 0 } }, methods: {
  deposit: { at: 'row', run: async (n: number, ctx) => (await ctx.at.cents.set(op.incr(n))).value as number },
  ping: (_, ctx) => ctx.peer,
  rich: (min: number, ctx) => ctx.data.gte('cents', min),
} })
const n: number = await bank.data.ada.deposit(5, { once: 'dep-1' })
// @ts-expect-error the argument is a number
bank.data.ada.deposit('5')
// @ts-expect-error deposit needs its argument
bank.data.ada.deposit()
// @ts-expect-error a plain result has no live form
bank.data.ada.deposit(5).here()
const who: string = await bank.methods.ping()            // an untyped argument may be left out
const rich = bank.methods.rich(100).here()               // a view the server named (class C)
// @ts-expect-error .open() is gone: a served view is here()'d
bank.methods.rich(100).open()
// @ts-expect-error `near` is gone: a method says where it may be called with `at:`
await fero('n', { data: { a: { c: 0 } }, methods: { m: { near: true, run: (_: string) => 1 } } })
type Bank = typeof bank
const typed = await fero<Bank>('bank')                   // a client typed by the server's exported type
const n3: number = await typed.data.ada.deposit(5)
// @ts-expect-error V4-5: the typed client of a resource with methods has no set
await typed.data.ada.set({ cents: 1 })
// @ts-expect-error nor the array form
await typed.set(['ada'], { cents: 1 })
// @ts-expect-error nor remove
await typed.data.ada.remove()
// @ts-expect-error nor touch
await typed.data.ada.touch()
// @ts-expect-error nor a batch
await typed.batch([{ key: ['ada'], value: { cents: 1 } }])
// @ts-expect-error nor a write through at()
await typed.at('ada').set({ cents: 1 })
// @ts-expect-error nor a bare mark: it writes the resource's marks
await derive(f, typed, (x) => typed.mark(x))
// @ts-expect-error nor a claim: it leases rows
await typed.claim({ partition: 'ada', lease: '10s' })
// @ts-expect-error a method declared `at: 'row'` is not offered at the root
await typed.methods.deposit(5)
// @ts-expect-error a bare function is root-only: it is not offered on a path
typed.data.ada.rich(5)
await typed.data.ada.call('deposit', 5)                  // by name, where the method is declared
// @ts-expect-error call() is checked against `at:` too: a root-only method is not callable on a path
typed.data.ada.call('rich', 5)
// @ts-expect-error a row method is not callable on a field
typed.data.ada.cents.call('deposit', 5)
// @ts-expect-error nor on the root lens
typed.data.call('deposit', 5)
// at depth 2, `at: 'row'` and `at: 'partition'` name different lenses
const rooms = await fero.of<Msg, 2>()('rooms', { depth: 2, methods: {
  pin: { at: 'row', run: (_: undefined, ctx) => ctx.at.stars.set(op.incr(1)) },
  clear: { at: 'partition', run: (_: undefined, ctx) => ctx.peer },
} })
await rooms.data.r1.m7.pin()
await rooms.data.r1.clear()
// @ts-expect-error at depth 2 a row method is not offered on a partition
rooms.data.r1.pin()
// @ts-expect-error and a partition method is not offered on a row
rooms.data.r1.m7.clear()
// the row type given by hand, and the methods: `fero.of<Row>()` works out the methods' type
type Acct = { cents: number }
const till = await fero.of<Acct>()('till', { methods: { pay: { at: 'row', run: (n: number, ctx) => ctx.at.set({ cents: n }) } } })
const client = await fero<typeof till>('till')
await client.data.a.pay(5)
// @ts-expect-error an unknown method name is refused on the typed client
client.data.a.nosuchmethod(42)
// @ts-expect-error and a wrong argument
client.data.a.pay('five')
// @ts-expect-error `fero<Row>(name, { methods })` would leave the methods untyped, so it does not compile
await fero<Acct>('till', { methods: { pay: (n: number) => n } })
const loose = await fero<Acct>('till')                  // typed by its rows only: its calls are untyped
await loose.methods.pay('anything')
await loose.data.a.call('pay', 'anything')               // on a path, by name
const u = await fero('u')                               // untyped: assignment compiles; nothing is checked
u.data.k = { any: 'thing' }
delete u.data.k
console.log(cond, acks.length, e.stage, row, pic, held, n1, n2, one, best, mine, rich, n, n3, who)
```

The checker writes every `// file:` block to a fresh folder and runs `tsc` against data's `types/public.d.ts`:

```js check
// API.md checker: every ```ts block whose first line is "// file: <name>" is written to a fresh
// folder and type-checked with tsc against data's shipped types. DATA names data's folder.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const md = readFileSync(process.argv[1], 'utf8')
const data = process.env.DATA ?? join(here, '../../../../../../data')
const out = mkdtempSync(join(tmpdir(), 'fero-api-'))
const files = []
for (const [, body, name] of md.matchAll(/```ts\n(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)```/g)) {
  writeFileSync(join(out, name), body)
  files.push(name)
}
const compilerOptions = {
  target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true,
  types: [], lib: ['es2022'], paths: { fero: ['./fero.d.ts'], data: [join(data, 'types/public.d.ts')] },
}
writeFileSync(join(out, 'tsconfig.json'), JSON.stringify({ compilerOptions, files }))
console.log(`${files.length} blocks → ${out}`)
execFileSync('tsc', ['-p', join(out, 'tsconfig.json')], { stdio: 'inherit' })
console.log(`ok: ${files.length} blocks type-check (tsc ${execFileSync('tsc', ['-v']).toString().trim()})`)
```

Run from the repo root (`DATA` names data's folder; the default is this machine's):

```sh
node --input-type=module -e "$(awk '/^```js check$/{f=1;next} /^```$/{f=0} f' docs/v5-space/API.md)" docs/v5-space/API.md
```

**Result, run here on 2026-11-18, after the lens rewrite and its two skeptics** (Node v22.22.0, TypeScript 6.0.2, data at 63fea66): `ok: 38 blocks type-check (tsc Version 6.0.2)`.
- There are 81 `@ts-expect-error` lines: 74 in `types.ts`, five in `client.ts`, one in `p12.ts` and one in `p14.ts`. With all 81 stripped from a copy of the generated folder, tsc reports 81 errors, one at each stripped line and for the reason its comment gives (two lines' messages are indirect; see below). For example, `await stock` used as a value: "Type 'Lens<number, …>' is not assignable to type 'number | undefined'"; `typed.data.ada.set(…)` on the typed client of a resource with methods: "Property 'set' does not exist"; `typed.methods.deposit(5)` for a method declared `at: 'row'`: "Property 'deposit' does not exist"; `f.at(Symbol('k'))`: "Argument of type 'symbol' is not assignable to parameter of type 'string | number'"; `{ near: true, run }`: "'near' does not exist in type 'MethodDef'".
- **Four must-fail lines fail for a reason the types cannot say in words.** `f.data.set(…)`, a function left of `here()`, `set` on a partition, and a row method called on a depth-2 partition all fail with "This expression is not callable": on those lenses the name is a step to a row or field of that name, and a lens is not callable. Each comment gives the rule; section 8's hints give it at run time. E-55 found the same for a function left of `here()` (claim 5).
- **One message names the wrong member.** A `batch` item with a wrong whole-row value fails, but tsc's message speaks of the item's `key` ("Source has 1 element(s) but target requires 2"): it reports the field form of the item, the last member it tried. The line still fails only because the value is wrong; with a right value it compiles.
- **What the two skeptics of this rewrite found in the types, and what changed.** `{ from: e, once }` compiled, through a union of option types, though the text meant to forbid it: a mark and a name now exclude each other in the types, on `set`, `remove` and the array forms. `lens.call(name)` took any method name on any lens: it now takes only the methods that kind of lens may call. A field lens had `touch`: it is on a row lens only. `mark` and `claim` showed on the typed client of a resource with methods: they are behind the door now. 23 must-fail lines were added for these and for cases that failed already but had no line: `await` on a row lens and on the root lens, `follow()` and `open()` on a lens, the door client's `remove`, `touch`, `batch`, `at().set`, `mark` and `claim`, `depth: 3`, `derive`'s old `(e, out)`, the depth-2 `at:` cases, and assignment on a typed handle.
- **Three faults were found and fixed this way while the declarations were written.** A batch item with a one-key path and a wrong row passed, through the field form, until a field path was typed as two or more keys (`FieldPath`); `f.set(['k'], wrongRow)` had the same hole. A seed inferred its row type through both branches of the depth condition, so `{ widgets: { stock: 10 } }` gave the row type `number`; a seed now gives the row type at depth 1 only, and a depth-2 seed names it. And "versions are opaque" failed only through the last overload's message, which named `undefined`, not `Version`; the line now checks a `Cond` alone, and its error names `Version`.
- **Kept from the 2026-11-16 pass.** Two errors were found and fixed this way in its first draft: the handler's typed `ctx` was lost when `methods` was typed as an intersection, and one type argument could not serve both `fero<Row>` and `fero<typeof shop>`, so `fero` has overloads. And a pass that hid a fault: `fero<Row>(name, { methods })` compiled and left the methods untyped, so `fero<typeof shop>` accepted any method name, and the checker passed because nothing tested a wrong call on those handles. That form still does not compile, and `client.ts`, `p12.ts`, `p14.ts` and `types.ts` each hold a line that must fail on a typed client. A default of "no methods" for the second type argument was tried and dropped: it broke the handlers' typed `ctx`, since TypeScript takes a callback's context from the default.
- **What the types here do not check**: section 6's list, and section 7's user rules.
- **Not checked here: that any of it runs.** [E-55] built the lens small and ran LENS's claims on it; [E-22] ran the patterns under the earlier spelling. Nothing on this page is built.

[dec]: ../DECISIONS.md
[E-01]: experiments/E01-floors/README.md
[E-02]: experiments/E02-pipeline/README.md
[E-05]: experiments/E05-fold-cost/README.md
[E-06]: experiments/E06-fork-rewind/README.md
[E-08]: experiments/E08-relay-fanout/README.md
[E-09e]: experiments/E09e-etcd/README.md
[E-12]: experiments/E12-journal/README.md
[E-18]: experiments/E18-slot-balance/README.md
[E-19]: experiments/E19-slot-positions/README.md
[E-20]: experiments/E20-dedup/README.md
[E-21]: experiments/E21-time/README.md
[E-22]: experiments/E22-api-prototype/README.md
[E-22b]: experiments/E22b-real-elle/README.md
[E-23]: experiments/E23-merged-views/README.md
[E-24]: experiments/E24-sagas-ramp/README.md
[E-30]: experiments/E30-derived-once/README.md
[E-31]: experiments/E31-subscribe/README.md
[E-32]: experiments/E32-composition/README.md
[E-33]: experiments/E33-genesis-restore/README.md
[E-34]: experiments/E34-wake-10gb/README.md
[E-40]: experiments/E40-browser-client/README.md
[E-43]: experiments/E43-fold-versions/README.md
[E-45]: experiments/E45-drivers/README.md
[E-46]: experiments/E46-maelstrom-raft/README.md
[E-48]: experiments/E48-ack-stages/README.md
[E-49]: experiments/E49-per-resource-cost/README.md
[E-51]: experiments/E51-resource-founding/README.md
[E-52]: experiments/E52-resource-healing/README.md
[E-53]: experiments/E53-handback-pace/README.md
[E-54]: experiments/E54-time-travel/README.md
[E-55]: experiments/E55-lens-prototype/README.md
