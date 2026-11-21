# fero v5: the public API

Rewritten 2026-11-16 for the design the owner chose ([DECISIONS V5-1 to V5-11][dec]; [VERDICT 11.7](VERDICT.md)). Rewritten again 2026-11-18 around the connect lens ([V5-12][dec]; [LENS.md](LENS.md)). **Rewritten a third time 2026-11-20 for V5-13 to V5-15** ([dec]): how code reads data ([CONNECT.md](CONNECT.md), [READS.md](READS.md)), where transformations run ([TRANSFORMS.md](TRANSFORMS.md)), and reads and writes at any path ([ANYPATH.md](ANYPATH.md)). **Amended the same day for V5-16**: a sync read is `.value`, and only where it is sure; `f.rows`, `ctx.rows` and the cluster's `snapshot()` go. Section 5.6 lists every change from the 2026-11-18 page, with its decision. **Amended 2026-11-21 for V5-17**, the owner's answers to section 11.1's questions. Most kept this page's pick. Four went the other way and change the API: a service's answer that throws sends the request back to be taken again; `past` comes in the first build; two refusals get codes of their own; and the open-links list is `f.cluster.value.links`. Section 5.7 lists those four.

**This page replaces COMP2's API** of 2026-11-11. Git history keeps that one, and the earlier forms of this page (`git log -- docs/v5-space/API.md`). COMP2 was the study's earlier pick: Raft groups owned by the project, a `#meta` group and one central loop. The owner set it aside (V5-2, V5-6).

- **What this page is.** What an app developer writes against fero v5, what each call promises, and what each call costs.
- **The design in one line.** A resource's truth is a log (V5-1). Each resource is its own small cluster, with its own Raft groups and its own settings in its own log (V5-2). Every write commits on disk at a majority before anyone can see it (V5-5). `data` folds the rows on every copy and on clients.
- **The shape in one line.** `shop.data.widgets.stock` is a **lens**: an address that does no work. The same address then reads once (`get()`), keeps the newest state live here (`connect()`), reads the log from a place (`changes()`), reads one partition as it was (`past()`), writes (`set()`) and calls a method (`sell(1)`). Four read verbs, one job each, named by what you get (V5-13).
- **The aim.** The owner asked for an API that is as easy to guess as it can be, and that costs nothing in speed: no hidden copies, trips, decodes or whole-resource work. [API-TOUR.md](API-TOUR.md) walks through the choices, for review.
- **For the layers under the surface:** [LAYERS.md](LAYERS.md). **For what each path costs:** [PATHS.md](PATHS.md). **For the evidence behind the read surface, transformations and paths:** [CONNECT.md](CONNECT.md) with [E-56], [TRANSFORMS.md](TRANSFORMS.md) with [E-57], [ANYPATH.md](ANYPATH.md) with [E-58]; for the lens itself, [LENS.md](LENS.md) with [E-55].

**How each claim is marked.**
- **V5-n**: a decision in [docs/DECISIONS.md][dec]. **E-nn**: an experiment under [experiments/](experiments). **PATHS n**, **PA-n**: [PATHS.md](PATHS.md), a section or a finding. **LENS n**, **CONNECT n**, **TRANSFORMS n**, **ANYPATH n**, **READS n**: a section of that page. **MEMORY 9.n**: [MEMORY.md](MEMORY.md). **A-nn**: [AMENDMENTS.md](AMENDMENTS.md). **code:** a v4 file and line; **code data:** the sibling library at commit 63fea66.
- **E-55 claim n**: one of LENS section 6's 27 claims, measured on E-55's prototype (data 63fea66, Node 22.22.0, one box). **E-56 probe n**, **E-57 A1, XA-n, B1, XB-n**, **E-58 part n**: a probe, claim or part of that experiment. Their costs are the lens's and data's share in one process, never a whole fero write: v4's issue path alone is 7.7 to 8.3 µs (PATHS 2.6). A timed number is the range over three runs, each process alone on the box.
- **SCHEDULE clause n**: a clause of `data`'s contract for when and how its sinks are called (its conformance suite). **rule Y**, **rule W1**: rules of [E-48]'s answer-stage model; each is said in plain words where it is used.
- **(measured)**: timed. **(checked)**: a seeded run, a model, a probe or tsc ran it. **(reasoned)**: an argument; nothing ran it. **(a guess)**: a number nobody measured. **(from memory)**: an outside fact not checked here. **(proposed)**: new on this page. *This page's reading*: where the records leave room and this page picks.

**What comes when** (V5-5, V5-12, V5-14).
- **Built first, in TypeScript:** everything here except the lines below, `past` included (V5-17). Every write commits on disk at a majority.
- **Built second:** the early answer stages, `received` and `replicated` (section 3.5). The write handle is there from the first build; until the stages are built, both resolve at the commit.
- **Built third, and only for a timed need the stages cannot meet:** a `memory` commit level per resource. It is not on this page. Nor is the no-disk kind of pub/sub (`durability: 'none'`). Both would be one resource key, and no call changes.
- **Waiting for data 5's ordered index** (D8c; V5-14 pick 1): an ordered served view over more than 5,000 rows and `{ pages }` over more than 2,000 are refused when built until then (section 3.10). data 5.0.0 is one large major version, in TypeScript (V5-14 pick 6).
- **Built later, each when what it waits for exists:** work pushed below a partition (class B, section 3.10; V5-12 pick 2), the partition function (section 3.2; pick 4), and a browser build in which a server role throws (section 3.8; pick 12). A folded resume on a live link, `connect({ resume })`, is modelled first (V5-13 pick 7).

**How sure each part is.**
- **Type-checked here.** Every `ts` block whose first line is `// file: …` compiles with TypeScript 6.0.2 against data's shipped types. That includes all 22 patterns and the lines that must not compile; each of those fails at its own line, for the reason its comment gives. Section 12 has the command and the result.
- **Built small.** [E-55] built the lens on data 63fea66. [E-56] built `connect` on it: callbacks, handles and loops, `disconnect`, `signal`, `until`, and the `ended` guard, through E-55's seeded lifetime checks (CONNECT 0). [E-57] built served views, pages, `derive`'s view form, `lookup` and the store fed by slot, each against a seeded oracle with planted bugs: 0 wrong answers on the final code (TRANSFORMS 7). [E-58] checked writes at every level and readers at every level on data's real engine: 0 wrong states (ANYPATH 0). None of the four built fero's log reader (E-58 checked an "on the path" reader on its stand-in, part 1), the positions, or `past` as a value.
- **Run on a prototype, under an earlier spelling.** [E-22] ran all 22 patterns on five kernel operations, with a leader change and a slot move forced into each. This page respells them; the respelled lines did not run.
- **Model-checked.** The rules under the surface: subscribe ([E-31]), retries ([E-20]), sagas ([E-24]), derived outputs ([E-30]; with two outputs of one record in one slot, E-57 B5), answer stages ([E-48]), founding and finding a resource ([E-51]), healing ([E-52]). Not yet: the `view` selector (V5-14's owed list), marks written by app code (section 11.2).
- **Measured.** The costs are [PATHS.md](PATHS.md)'s and the experiments'. No v5 server was timed end to end (PATHS 8).
- **Read by a skeptic.** The 2026-11-16 page had 31 findings; LENS.md, E-54 and E-55 had 24; the 2026-11-18 rewrite had two skeptics (20 and 21 findings); CONNECT.md had 21, TRANSFORMS.md 30 and ANYPATH.md 19. Each that held was applied there. **This rewrite had two reviews the same day**: one against the decisions and their sources (27 findings), one of the mechanics: types against prose, line cites, links (16). Each that held is applied here, with one part left for other files: line cites in CONNECT.md and two E-56 READMEs, and the v5-space index (docs/v5-space/README.md), are a follow-up. **V5-16's study had a skeptic too** (12 findings), and the amendment had two reviews: one for consistency across the three pages (14 findings), one of the mechanics (9). The ones that held are applied here. Left for other files: CONNECT.md, LENS.md and READS.md still offer `f.rows` as a current read, from before V5-16, and the V5-16 record in DECISIONS.md must carry what this page cites it for.
- **Nothing here is built.**

## 1. Words and layers

**Five words are enough to start.**

| Word | What it is |
|---|---|
| resource | a named, shared map of rows: `fero('shop')`. Every process that opens the name sees the same rows. Underneath it is a small cluster of its own (V5-2) |
| row | one entry of the map: a key and a JSON-like value. It has its own version, expiry and conditions |
| partition | the rows that one leader keeps in one order and can change together. The first key of a path is always the partition. By default each row is its own partition; at `depth: 2` a partition is a **room** of rows |
| path | an address inside a resource: `shop.data.widgets.stock`. Building one sends nothing and reads nothing. fero calls it a **lens** |
| method | a function the resource's servers host. When `methods:` is declared, clients change rows only by calling them |

**Words you meet later.**

| Word | What it is |
|---|---|
| server, client | a **server** holds a copy of the resource and can lead part of it. A **client** only uses it. The role is per resource and comes from what the open declares (section 3.1) |
| copy | a server's full replica: the log on disk and every row in memory |
| leader | the one server that puts a partition's writes in order and judges them |
| commit | a write is on disk on most of the copies (a majority). Only then can anyone see it (V5-5). What a reader calls one commit is one leader's batch, cut down to the rows the reader reads |
| stage | how far your own write has got when you hear back: `received`, `replicated`, then committed. A stage changes nothing the servers do (V5-11) |
| step, verb | a **step** is one property read on a lens (`.widgets`). A **verb** is a call on a lens (`.set(4)`). A name is a key until it is called |
| field | a key inside a row's value; a **nested field** is a field inside a field. "Below a row" means a field lens |
| link | one live connection from a lens into this process: a `connect()` or a `changes()` reader. It ends at `disconnect()`, its `signal`, its `until`, `break`, or the count. Never by the collector (V5-13 pick 2) |
| held on purpose | rows this process keeps because it serves the resource, said `hold: 'all'`, or has a live link on them. Only these serve a read here |
| picture | the rows a link selects, at the moment it starts. A link gets the picture first, then each commit |
| live state, the log | **live state** is the newest rows, folded: a slow reader skips to the newest, one change per row. **The log** is every record, in order: it waits for a slow reader. They differ on purpose, and by verb: `connect()` and `changes()` |
| record | one change on the log: a key path and a value. To **fold** is to apply records to rows |
| view | a live answer computed from rows: `room.gt('stars', 0)`. A **served view** is one the server names in `methods:` and keeps on one copy for every client that asks |
| version | a record's place in its partition's log, as short text that keeps log order under `<` (`38S9`). One version per row: its last write's. A commit's id, inside one partition, is the version of its last record there (V5-13 pick 4) |
| cursor | a reader's place, one position per slot it reads. Text you save and give back. Across partitions a place is a cursor; there is no single commit id |
| `-N` | "N commits back", a start for `changes()` and `past()`, on a lens inside one partition (section 3.10) |
| above, at, below, beside | where a write lands, seen from a lens: for `w.stock`, a write to `w` is **above**, to `w.stock` **at**, to `w.stock.x` **below**, to `w.price` **beside**. A record **on the path** of a lens is at, below or above it (V5-15) |
| writer time | the leader's clock, held to the median of the members' clocks, never going back. TTLs, leases, delays and `Date` positions use it (V5-4) |
| trip | one message there and its answer back (a round trip). On one box about 40 µs at the median ([E-01]) |
| the collector | JavaScript's garbage collector. It never ends a link; in development it only makes fero print a warning (section 3.10) |

**Words inside fero.** An app never names these. They show in `f.cluster`, in the debugger and in [LAYERS.md](LAYERS.md): **slot** (one of a resource's 4,096 fixed hash buckets; a partition hashes to one), **group** (one Raft log with one leader, holding some slots), **attempt** (one write and its retries), **session** (one process's life, held by a lease it renews by itself; it is what `while: 'session'` rows die with), **fold** (`data` applying the log's records to the rows in memory), **SUB** (v5's one subscribe message: a selector, a mode and a cursor; LAYERS 4; in **state mode** it sends rows and then their changes, in **log mode** it sends records), **GET** (one read message), **frame** (one message on a link: the writes one turn of the event loop made for one leader, or one commit's records on their way to a reader), **share** (a part of a source's partitions that one consumer owns at a time), **the tier** (older log kept in the object store; not in the first build), **selection** (what one SUB brings into a process: a partition, the whole resource, or a served view; equal lenses share one), **entry** (a copy's record of one served view: its key, instance, ring of recent frames and holders; TRANSFORMS 3.8), **the linger** (a short wait before an unused selection or entry is dropped).

**The layers** are [LAYERS.md](LAYERS.md)'s. **L0** storage and I/O. **L1** the log: Raft per group, founding, the directory, healing. **L2** fold and ops: records to rows, conditions, ops, marks, writer time, retries, expiry, answer stages, the one shape rule. **L3** flow: SUBs and the selections they bring (`connect`), `changes`, cursors and positions, served views and pages. **L4** the surface: `fero()`, the lens and its verbs, links and their ends. **L5** libraries, built only from L4: queue, lock, consumer, derive, saga, limiter, service, migrate, tape, the gateways and the CLI.

## 2. The shape on one screen

```ts
// file: shape.ts — the whole surface on one screen (a server file and a client file)
import { fero, op } from 'fero'

// ── server.ts: a seed and methods make a server
const shop = await fero('shop', {
  data: { widgets: { stock: 10, price: 5 } },
  methods: {
    sell: { at: 'row', run: (n: number, ctx) => ctx.at.stock.set(op.incr(-n, { min: 0 })) },   // an action on a row
    low: { view: (max: number, ctx) => ctx.data.lt('stock', max).az('stock', 10) },             // a view the server names
  },
  history: '1h',
})
export type Shop = typeof shop                             // the client imports this type, never the handle

// ── client.ts: `import type { Shop } from './server.ts'`
const client = await fero<Shop>('shop')                    // a client. It holds nothing yet
const stock = client.data.widgets.stock                    // steps: an address. No trip, no read. Not a promise
const n = await stock.get()                                // ONCE: here if held on purpose, else one GET. Keeps nothing
await client.data.widgets.sell(1)                          // a method on a path: runs at widgets' leader
const row = client.data.widgets.connect()                  // LIVE: one SUB, shared by equal lenses; a handle
await row.ready
console.log(n, row.value?.stock)                           // a sync read of what the link holds: one lookup
const shown = stock.connect((s, c) => draw(s, c.version))  // LIVE, AND CALL ME: the picture, then once per commit
const low = client.data.low(5).connect((top) => draw(top)) // a view the server named: an address; only its changes cross
for await (const e of client.data.widgets.changes({ from: -5, to: 'latest' })) console.log(e.version, e.rec)   // THE LOG
const was = await client.data.widgets.past(-1)             // AS IT WAS: a value, folded here; nothing to end
row.disconnect(); shown.disconnect(); low.disconnect()     // a link ends by your code: disconnect, a signal, until, break

// ── writes: on a server, or on a client of a resource with no methods (V4-5: methods are the door)
const w = shop.data.gizmos.set({ stock: 7, price: 9 })     // a write: it shows when it commits (V4-7)
await w.received                                           // optional: the leader has it (a progress report)
const ack = await w                                        // committed: on disk on a majority, visible to all
const sold = await shop.data.widgets.stock.set(op.incr(-1, { min: 0 }))   // the leader computes it
console.log(ack.version, sold.value, was.value?.stock, shop.cluster.value.writable)   // f.cluster: this process's own state
```

**Where each kind of line runs.**

| What you write | Where it runs | What it costs |
|---|---|---|
| a step: `f.data.a.b`, or `f.at(a, b)` | **nowhere.** It builds an address | no trip and nothing kept: 0 to 0.3 B a key; 49 to 99 ns a step with one key (E-55 claims 1, 2) |
| a sync read: `h.value`, a view right of `connect()`, `f.cluster.value` | **here**, on what a live link holds. It never leaves this process (V5-16) | no trip, no disk, no copy |
| a read you `await`: `lens.get()` | **here** if its partition is held on purpose; else at a copy (`fresh`: at the leader) | held: no trip. Else one GET, and nothing is kept |
| a change: `lens.set(v)`, `room.set(rows)`, `f.set(path, v)`, an assignment, a method | **at the partition's leader.** It is sent whether you `await` it or not; `await` only chooses when you hear back | one trip, and one shared disk sync on a majority |
| a link: `connect()`, `connect(fn)`, a loop over `connect()` | **at a copy**, from the moment of the call; then here, for every change | one SUB, shared by every equal lens in this process; the partition once, then its changes |
| a log reader: `lens.changes()` | **at a copy**, from the call | one trip to open, then every record on the lens's path |
| a past read: `lens.past(pos)` | **here**: a log read from the nearest snapshot, folded once | a snapshot load and 3.6 to 4.4 µs a record (E-55 claim 23); then nothing |
| a served view: `f.data.best(10)` | **on one copy**, never the leader, kept for every equal call | the view's own work on every write to the resource, under a cap (section 3.10) |

**Seven rules a user learns** (CONNECT 8.5; V5-13; `pages` in rule 7 is V5-14 pick 4, and "first build" in rule 5 is V5-12 pick 2).
1. **A path is an address.** Building one sends nothing. It is never a promise, and neither is a handle.
2. **`get()` reads a value once. `connect()` keeps the newest state here, and calls you or loops. `changes()` is every record from a place, and it waits for you. `past()` is one partition as it was: a value.**
3. **A version names a record, and so the commit that holds it; a cursor, a time and `-N` name a place. `from` starts at it, `past` reads right after it, `to` stops after it.** A version and `-N` work inside one partition; save the cursor to resume.
4. **Left of `connect()`: plain data, which may run on a server. Right of it: your code, here.**
5. **The wire sends whole partitions** (first build).
6. **Every live thing ends by your code:** `disconnect()`, `break`, a signal, `until`, or the count. Never the collector. A link's rows are read only while it is live; after the end, `ended`. A `past` is a value: nothing to end.
7. **A method says where it may be called (`at:`, `view` or `pages`), never takes a fero word, and checks what it is given.**

Transformations add ten more, for served views, `derive` and `lookup` (TRANSFORMS 8.4; V5-14), in sections 3.10 and 3.11. Reads and writes at any path follow data's rule for when a reader above or below a write hears of it (V5-15 pick 1), and one shape rule at the leader (pick 6); sections 3.4 and 3.10 say both. The types show neither. No record counts them as user rules, and this page adds no count.

**Still true from the page before.**
- **Anything that changes data, or opens a link, sends a message.** `await` does not send it; it only waits. **Awaiting a write's handle means committed**: one trip to the leader and a share of one disk sync, about 1 ms on one box (MEMORY 9.3, computed from [E-02]). The handle's `received` and `replicated` are earlier progress reports for the few who want them (section 3.5).
- **Make writes together, a few hundred at a time.** They leave in one frame, share disk syncs and keep their order within a partition (PATHS 3.6; A-10). A client may hold 512 waiting writes; past that the next plain one is refused `backpressure` (section 3.6).
- **Only a line you wrote walks a whole resource:** `hold: 'all'`, `f.data.connect()`, `f.data.get()`, listing a whole resource's `h.value`, `f.data.changes({ from: 'earliest' })`, a served view on its copy, and an operator over every row on a server. Nothing else decodes, copies or walks every row. On a spare server, that last line also downloads the resource first (section 3.3).
- **A resource is a table, not a row.** Each one is a small cluster. Users and orders are rows of one resource, not a resource each (V5-2).

**One address, and one sync read** (V5-13 pick 6; V5-16). `f.data` is the address of everything: steps, reads, links, writes, and calls on a path or at the root (`f.data.low(5)`). `.value` is the one sync read, and it is there only where it is sure: a live handle's `h.value`, a `past`'s `value`, and `f.cluster.value`, this process's own state. Everywhere else, `get()` reads once and `connect()` keeps a link. Section 5.6 lists the words that went.

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
- **Three servers of one name are a cluster of three**, as in v4's rung 13 (rung 01 is two). Each stores the log, keeps every row in memory, and can be elected leader: of every partition in the first build, which has one group per resource, and of some partitions once a resource has more groups (V5-2, V5-6).
- Ctrl-C is a clean stop (V4-8). `fero.spawn` stays (V4-9).

**When `await fero(…)` comes back** *(stated here; reasoned from v4's rung 03 and section 3.9's "never guesses")*.
- **A server:** once it holds the log and has folded it.
- **A client, by default:** once it has reached a server and learned the leaders. No rows come: a client holds nothing until a `connect()` says what (V5-12 pick 1).
- **A client with `hold: 'all'`:** once the first picture of every row has arrived and is folded. So `f.data.connect()` on the next line shares those rows, with no SUB of its own (reasoned). At 1,000,000 rows that is seconds (the table below).
- **No server answers:** the open waits `connect.wait` (10 s), prints who is missing, and then resolves all the same. Writes made on that handle wait as `pending`; a `get()` waits; a handle's `value` throws `not-ready` until its first picture comes; `f.cluster.value` shows `members` as `undefined`, with a health row that says no server was reached yet (V5-16). It never reads as an empty resource. (v4's rung 03 prints `{}` here; that line changes.)

**A server role is real work. Give it to a server process, not to every app process.**
- A server of a resource copies and folds its whole log, keeps a `dir` and syncs it, votes or stands by, takes the per-resource budget (about 8 KB idle, V5-8), and leaves the cluster on Ctrl-C.
- So the code that **creates** a resource (`server: true`, a seed, `methods`) belongs in the few processes meant to hold it. App code that only reads and writes opens the bare name, which holds nothing until a line says what (section 3.3). Section 10's patterns are written that way: a server file, then the app's lines.
- **Opening a name as a server creates the resource, as in v4** (V5-17). A resource is its own cluster, so there is nowhere else to keep it (V5-2). The other way was an admin act (`fero create shop` on the CLI), so that no app file ever says `server: true`; it was not taken.

**What `await fero(…)` costs.**

| Case | Cost | Source |
|---|---|---|
| the first server of a new name (it founds the resource) | one create-if-absent in the store and one disk sync: about 5 ms on one box, about 35 ms across machines, once per resource for ever. The other copies join in the background | [E-49]; PATHS 5.11; V5-10 fix 1 |
| a server joining a resource that exists | it copies the log it lacks, then folds it: 1.3 to 3 µs a small row | PATHS 2.1, 5.1 |
| a client, cold (the default holds nothing) | 2 to 3 trips and one commit when built well (7 to 9 trips and two commits as first drawn). A cold browser made its first committed write in 13 to 17 ms. Nothing more until a `connect()` or a `get()` | PATHS 3.2 (PA-21); [E-40] |
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
const room = chat.data.room1.connect()                               // one partition, held live
await room.ready
console.log(users.name, room.value)
```

| Form | Who can route by it | Cost |
|---|---|---|
| **`depth: 1`** (default): each row is its own partition | everyone: a hash of the first key | none: a hash per write, nothing stored |
| **`depth: 2`**: the first key is the partition, the second the row | everyone: a hash of the first key, with nothing to learn. It is plain data, kept in the resource's log, so a browser knows it too | a key grows by 2 B. **Partitions of 100 to 10,000 rows:** the fold costs 0.78 to 1.10 times a flat store with PA-17's index from partition to rows, and each partition takes 1.2 KB to 805 KB **less** memory than that index; a 100-row room's first picture takes 0.012 to 0.017 ms at 100,000 to 1,000,000 rows in all. **One-row partitions:** about 0.9 KB more each and 1.3 to 1.5 times the fold, because today's data makes each partition a data source of its own; data's two-level store (D3, LENS 4.5) is what makes them cheap (E-55 claim 19) |
| **a function of the row key** (V5-2), **built later** (V5-12 pick 4) | servers, and any client that passes the same function | the function runs on every write and keyed read, in the process that makes it: keep it pure, sync and cheap. A process **without** it cannot find the leader, so its writes take the forward path: **one more trip each** (V5-9; reasoned, no experiment ran a function). Every copy keeps PA-17's index from partition to rows |

- **Why the second level is a row, not a field** (LENS 1.1). With one level, `chat.data.room1.m7` would be a field of the row `room1`, and a message as a field loses what a row has: its own version (a field has its row's, V5-15 pick 5), its own `ttl` and size limit, early answer stages, `e.value` in `changes`, and views over it. A field write also copies its room on every copy and every client: 0.43 ms at 1,000 messages and 3.6 ms at 10,000 (measured in LENS's facts brief; code data:kernel/node.ts:275-291).
- **Why not two levels always.** Then `users.data.u42.name` would be a row, and a user could not be read, expired or versioned as one thing (reasoned).
- **Every process routes by hashing the first key**, as fero v2 did (code v2:partitions.js:20-22). A `{ prefix }` walk of partition names is gone with `{ before }`: with `depth: 2`, a cart, a room or a thread is a partition you name.
- **The partition rule is fixed when the resource is founded.** Changing it would move rows between orders (reasoned, from V5-2's rejection of a changing `% N`).
- **The number of partitions is free.** Use as many as you like.
- **One partition is one leader's work.** Every write to it is judged in one place. A partition busier than one leader can serve must be split by the app ([E-18]).
- **A row write** at 100,000 to 1,000,000 rows in all costs data 2.0 to 3.4 µs flat and 2.1 to 3.9 µs at depth 2 on E-55's box (claim 19): the same, within the noise.
- **The function form** is for partitions a key level cannot say (`'report-7.acme'` belongs to `acme`). A function is code, and code cannot travel: every server must pass the same one; fero compares its text, as it does for `validation`, and a different text is refused `config-differs`.
- Use `depth: 2` for rooms, carts, threads and tenants: a partition per thing, a row per item. It covers all 22 patterns (section 10). A room is replaced whole with `room.set(rows)` and emptied with `room.remove()` (section 3.4; V5-15 pick 3).

### 3.3 `hold`: what a client keeps

```ts
// file: hold.ts — what a client keeps in memory
import { fero } from 'fero'
type User = { name: string }

const users = await fero<User>('users')                    // the default: it holds what its links name, nothing yet
const all = await fero<User>('users', { hold: 'all' })     // every row, kept live: one picture, then every write
const warm = await fero<User>('users', { hold: '200MB' })  // a cache of pictures of closed selections
const me = users.data.u42.connect()                        // now u42's partition is held on purpose
const every = all.data.connect()                           // a handle on what hold: 'all' holds: no new SUB
await me.ready; await every.ready
console.log(me.value?.name, every.value.u42?.name, warm.name)   // a sync read is a live handle's value (V5-16)
me.disconnect()                                            // after the linger, the unsubscribe is sent
every.disconnect()                                         // the rows stay: hold: 'all' still holds them
```

- **A client holds nothing until a `connect()` says what** (V5-12 pick 1, in V5-13's words). It then holds on purpose exactly what its live links name, for as long as they live. Every download is a line you wrote.
- **`hold: 'all'`** (v4's behaviour, now an option). The open sends one picture of the whole resource, **and then every later write to it, for as long as the handle is open.** A local `get()` and operators over every row then work here. Cost: the resource's size in bytes, memory and decode time, once; then a decode and a fold here for every write anyone makes. At 1,000,000 small rows the first fold alone is seconds of this process's main thread (computed from PATHS 2.1). `f.data.connect()` holds the same rows, said as a line, with a handle you can end, and operators over every row go right of it. **A sync read of every row is that handle's `value`**, on any role (V5-16): with `hold: 'all'`, `f.data.connect()` shares the open's rows and sends no SUB of its own (section 3.10, "Equal lenses share"; reasoned). There is no `f.rows`.
- **`hold: '200MB'`, a size, is a cache of pictures, not a subscription** (LENS 2.2; reasoned, not built). When the last link on a selection ends, the unsubscribe is sent after the linger, as always. Inside the bound, the rows stay in memory, least recently used first, with the server position they were good at. They are **not held on purpose**: no read is served from them. A new link sends that position. If the server can still resume from it (its ring of recent frames, or the log when the resource has `history`), only the changes since cross. If not, a new picture crosses. So opening it again is a resume or a download, never free, and nothing crosses while it is closed.
  - The other choice, staying subscribed while warm, would have the server send, and this process decode and fold, every change to every warm partition for nobody (LENS 2.2).
- **A `get()` never holds** (section 3.9). It reads once. `get({ when })` holds the partition while it waits, then lets go.
- **A server holds every row** of the resources it serves (V5-6: `data` folds on every copy), as a voter or a standby. That is true for the first `copies + standbys` servers of a resource: 5 by default. The first build has one group per resource (TRANSFORMS' "Words"), so a server holds every row or none.
  - **A server past that number is a spare** *(this page's reading of LAYERS 8.4 and PATHS 4.4)*. It holds no copy until a leader's healing places one on it. Until then its links behave like a client's: `f.data.connect()` subscribes, and a SUB for a served view there is answered `moved`, naming a copy (TRANSFORMS N-8).
  - **An operator over every row on a spare holds what it lacks first** *(this page's reading of TRANSFORMS 3.9's R0: a process that runs a view over every row holds any slot it lacks the way `hold: 'all'` does)*. That covers its root operators and a handler's `ctx.data`, if a root call reaches it. A `connect()` of such a line takes one picture of the whole resource and then every write, as `hold: 'all'` does, for as long as its link lives. A `get()` of it takes one picture, answers, and keeps nothing, as every `get()` does. So the line works on every server, and only its cost depends on the deployment: a download on the sixth server, none on the first five. Health shows the download. Not measured (TRANSFORMS 10 item 10).
  - **That is why there is no sync lookup of every row, on any role** (V5-16). A sync read cannot wait for that download, so on a spare it would have to throw: the same line would work on five servers and throw on the sixth, and the deployment would decide, not the line. `get()` and `connect()` can wait. So a server, too, reads every row in sync through `f.data.connect()`'s handle.
- At 80 % of the process's `memory`, health warns and names the fix: end links, or give `hold` a smaller size.
- `hold: 'asked'` is gone: what it did, hold only what you asked for, is the default, with nothing kept after a `get()` (section 5.5).

**Copies.** `copies: 3` (1, 3 or 5) is how many copies' disks decide a commit; the default is 3 once three servers exist, and 1 until then. With two servers, the second is a full copy that does not vote: two voters would stop writing when either one died *(this page's reading; LAYERS 8.2 step 9 agrees)*. `standbys: 2` adds full copies that do not vote, so more servers read every row locally. Each leader heals its own group: when a copy dies it places a new one on a quieter machine (V5-2; V5-10 fixes 6 to 8). There is no call for it.

### 3.4 Writes, at any path

| Form | What it is | Answer |
|---|---|---|
| `f.data.k.set(row)`, `f.data.k.stock.set(4)`, `f.data.k.remove()` | **the path write: the main spelling.** The address is one thing and the verb another, so a component handed `stock` can write it without knowing where it sits | the handle (section 3.5) |
| `room.set(rows)`, `room.remove()` | **a room** (a partition at depth 2), replaced or emptied as one batch the leader expands from the rows it holds (V5-15 pick 3) | at the commit only |
| `f.set([k, 'stock'], 4)`, `f.remove([k])` | the same write as an array: the plain call every other form turns into. No `Proxy`; `ctx.set`, `batch` items and libraries use it | the handle |
| `f.at(k, 'stock').set(4)` | the same lens with no `Proxy`, for computed keys and hot loops (section 3.9) | the handle |
| `f.data.k = row`, `f.data.k.stock = 4`, `delete f.data.k` | on an **untyped** handle: the same write, with no answer wanted | none. It shows when it commits (V4-7). A refused one never shows: it is a `refused` row of `f.cluster.writes` and one stderr line. If this client is full, the assignment itself throws `backpressure` (section 3.6) |
| `f.batch([...])` | several changes to **one partition**, all or none | one handle, at the commit |
| `f.data.k.sell(arg)`, `f.data.low(arg)` | your function on a server: on a path, or at the root (section 3.8) | its return value, after its writes commit |

```ts
// file: paths.ts — writes at any path inside one partition (V5-15)
import { fero, op } from 'fero'
type Item = { stock: number; price: number; tags: string[] }
type Msg = { text: string; at: number }
const shop = await fero<Item>('shop')                              // a client of a resource with no methods: it may write
const chat = await fero<Msg, 2>('chat')                            // depth 2: a room is a partition
await shop.data.w.set({ stock: 4, price: 9, tags: [] }, { ttl: '1h' })   // a row, whole, with its ttl
await shop.data.w.stock.set(3)                                     // a field: commit only; 'absent-row' if w is missing
await shop.data.w.stock.set(2, { if: { equals: 3 } })              // a field guard: this field only
await shop.data.w.stock.set((n) => (n ?? 0) - 1)                   // set(fn) on a field: guarded by the field
await shop.data.w.set(op.merge({ price: 10 }))                     // on a row that exists: one field record per key
await chat.data.room1.set({ m1: { text: 'hi', at: 1 }, m2: { text: 'yo', at: 2 } })   // replace a room: one batch
await chat.data.room2.remove()                                     // empty a room: one batch
```

- **Three spellings, one record.** Assignment, `lens.set(v)` (and `f.at(…).set(v)`) and `f.set(path, v)` make the same record on the same path: one ASK, encoded once at the issuer (PA-13). "Assignment is `set` without the answer."
- **Typed code writes with `set`** (V5-12 pick 6). TypeScript cannot give a property one type to read (a lens) and another to write (a value); [E-55] tried four ways (claim 5). Assignment still works when run, and compiles on an untyped handle.
- **A write needs a partition or less** (V5-15 pick 3). Inside one partition a write may land at any level: a room, a row, a field, a nested field. Every reader of any part then gets that part right (section 3.10, "data's rule"). Across partitions it may not: they share no order, so a write split into one commit per partition shows half of it to a reader of two rows. In [E-58] part 3 a loop that woke every 1 to 4 commits saw a half-done state in 63.1 % of root replaces and 39.1 % of moves between rooms; a room replaced as one batch, 0 *(checked)*.
  - **The root is refused.** The types offer no `set` or `remove` there, and the error's text names the way: write each row or room, or empty everything with `fero.drop(name)`. Untyped code is refused `bad-path`.
  - **A room takes `room.set(rows)` and `room.remove()`, and nothing else.** One batch: one log entry, all or none, commit only. The leader knows the room's keys, so there is no race with a writer that adds a row between your read and your removes, and no need to hold the room to learn its keys. Readers get plain row records. Assignment to a room, `delete` of a room, `f.set([room], …)` and a `batch` item at a room key stay refused `bad-path`, since one careless line would replace or empty a room. A row given as `undefined` is refused, by the types and by the leader (`unencodable`). A row named `set` or `remove` in a room is reached with `at()`. **Owed:** a size rule for a room write, which is one log entry (V5-15's consequences); past it, the leader refuses `room-too-large`, a code of its own (V5-17). `room.remove()` leaves one tombstone per row.
- **One version per row, said plainly** (V5-15 pick 5). A row's version is that of its last write, wherever in the row it landed. `if: { version }` is always the row's. On a field lens, `if: { equals }`, `absent` and `present` test the field, also inside `set(fn)` (section 3.7). The reason: a row version refused 8 % to 45 % of guarded field writes only because a sibling field changed, in E-58's mix of writes (part 5, a model of the leader's guard; the shares depend on the mix) *(checked)*.
- **One shape rule at the leader** (V5-15 pick 6), beside `absent-row`:
  - a parent field that is missing: `absent-path`, as before;
  - a parent (or the row) that is a string, a number or `null`, an index past an array's end, or a step on an array that is not an index (a named field, `length`): **`bad-shape`** (new);
  - a key `__proto__` at any step: `bad-key`, at `at()` and at the leader.
  - Why: `data` fills such shapes in, or lets them through, and five of them break the state or the wire; three get past data's own reader rule (E-58's shape and edge runs). With the rule, every write v5 takes keeps data's rule exact *(reasoned)*. The price: code ported from `data` or v4 that relied on the fill-in must write the parent whole; about 1 in 9 commits in E-58's mix were such writes *(checked; the share is the mix's)*. data's five holes are listed in STATUS for its owner; fero needs none of them fixed (V5-15's consequences).
- **No `ttl` or `while` on a field write** (V5-15 pick 7). A ttl, a lease and a session lifetime belong to a row: the types take them off the field forms, a field `batch` item included, and the leader refuses them, `field-ttl`, a code of its own (V5-17). `touch` is a row's verb, so a field lens has no `touch`.
- **`op.merge` on a row that exists is appended as one field record per merged key** (V5-15 pick 7); on a missing row, as the whole row. So a link on an unchanged field does not run again on every copy that applies the record (section 3.10). A merge of k fields is k records.
- **`f.data.set(k, v)` is gone** (V5-12): `f.data.set` on the root is the root's refused write. v4's other lens calls went with it: `f.data.k.update(v)` is `f.data.k.set(v)`, and `f.data.patch(pairs)` is one `set` per pair.
- **A typed client of a resource with methods has no writes** (V4-5, now in the types): no `set`, `remove`, `touch` or `batch` on its lenses, rooms or root, and no `mark` or `claim` (a bare mark writes the resource's marks, and a claim leases rows; V5-17). Untyped code that writes anyway is refused `methods-only`, and the hint lists the methods.
- **What the lens adds to a write** (E-55 claim 3, over `f.set([k, 'n'], v)`, a local data write of 0.7 to 1.3 µs): with two steps +0.18 to +0.73 µs (medians 0.31 to 0.47 by size); a kept lens −0.03 to +0.42 µs (medians 0.16 to 0.28); `at()` about 0. Keep a lens you write often: `const stock = shop.data.widgets.stock`.
- **Two writes are two records.** `a.b.c.set(v)` then `a.b.d.set(w)` commit in that order when `a` is the partition; all or none takes a `batch`, or a room write.
- **A remove that finds nothing answers as done** (V5-17; ANYPATH 4 reasoned it: data commits nothing, and v5 says it answers). A remove of an array's own element is refused `sparse-hole`: write the spliced array.

**The write path** (PATHS 3.1, with V5-9's direct routing):
1. Here: the value is checked and encoded **once**. Those bytes are kept for resends and are what every link, journal and follower carry. No deep copy (PA-13).
2. One trip to the partition's leader. A client learns the leaders from the resource itself, and hashes the path's first key, so it sends there directly (V5-3, V5-9).
3. The leader judges the write (the shape rule, the conditions, the ops), appends it, and sends it to the other copies. A room write is expanded into row records here.
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
- **Only a write that cannot be refused on state has early stages** (ruling 6). That is a whole-row `set` or `remove` with no `if`, no `once` and no `from`. An op, a condition, a field write (it can be refused `absent-row`, `absent-path` or `bad-shape`), a room write, a write with a `once` name (the name can be taken: `call-diverged`, `too-many-keys`), a marked write (`{ from: e }`: it can be skipped at its mark), `set(fn)`, a `batch` and a method call answer at the commit only. The types say so: those return a `Judged`, which has no `received`. On a resource with `rules.write`, a plain write's early stages resolve at the commit, never before (reasoned: the types cannot see that key).
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
  - **An assignment throws `backpressure`, there and then** (V5-17; the 2026-11-16 skeptic found the need). An assignment has no handle, and fero cannot retry a refusal from its own queue. A stderr line alone would have dropped the write without the code knowing.
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
const priced = await parts.data.widgets.price.set(12, { if: { equals: 10 } })   // a field guard: the leader compares the field
console.log(sold.value, made.version, up?.version, priced.version)
```

- An **op** (`op.incr`, `push`, `merge`, `max`, `min`, `now`) is computed by the leader on the newest state. The answer carries the result in `value`. Ops are values, so they work in assignment too, on an untyped handle: `f.data.widgets.stock = op.incr(-1)`.
- A **condition** (`if: { absent | present | version | equals | lock | expired }`) is checked by the leader. If it fails, the write is refused `conflict`, with the row's `current` version. `version` is always the row's: one version per row (V5-15 pick 5). **On a field lens, `equals`, `absent` and `present` test that field**, so a write to a sibling field does not refuse it.
- **`lens.set(fn)`** *(proposed)* reads the value and its version, calls your function, and writes the result `if` the row is unchanged. If another write got there first, it reads again and calls your function again. `undefined` means "write nothing". After 8 tries it gives up with `conflict` (the number is a guess). **It can give up**; React's `setState(fn)`, which it looks like, cannot.
  - On a row it is short for two calls that exist: `lens.get({ version: true })`, then `lens.set(next, { if: { version } })`.
  - **On a field it is guarded by the field** (V5-15 pick 5): it sends `if: { equals: now }`, or `if: { absent: true }` when it read `undefined` (an `equals: undefined` would drop out of the JSON and leave the write unguarded). So a write to a sibling field does not make it try again. **This amends what this section said before, "no new rule at the leader"**: the leader now compares a field's value at a path. `equals` lets a write through after a change and back, which is safe for `set(fn)`, since it reads only the field; and it carries the old value in each request, where a version is a few bytes. **Owed:** the cost of an `equals` guard at the leader (V5-15's consequences).
  - **A row that does not exist** is passed as `undefined`, and the write goes `if: { absent: true }`.
  - **Each retry first waits until this process has applied the version the refusal named** (`current`). The refusal counts as something this process has seen, so the next read cannot be older (section 7, "Reads"). Without this rule a re-read could return the same old row 8 times in under a millisecond, and give up though nobody else was still writing.
  - Your function may run more than once. Keep it pure.
  - It is there so that the safe form is the short form.
- **Which one?** An op when one fits: many ops on one hot key share a commit and never retry (PATHS 3.5). `set(fn)` for everything else.
- **All three answer at the commit only** (section 3.5). A refusal also waits for the commit it was judged on, so nobody is refused because of a write that then vanished (A-04).

**Cost.** The same one trip and one disk sync as a plain write. Judging is at most 3 µs at the leader (a bar; not yet measured); an `equals` guard is not priced. `set(fn)` costs one such write per try; if this process holds the row's partition on purpose, its read is local.

### 3.8 Methods: the door (V4-5), on a path or at the root

Declaring `methods:` protects the resource, as in v4: clients then change data **only** through the methods. A client's plain write is refused `methods-only`, and the hint lists the methods. Reads stay open. **A method called on a path runs at that path's leader** (V5-12 pick 3), **a method says where it may be called** (pick 13), and **a root method is called on the root lens, `f.data.x(arg)`** (V5-13 pick 6). There are three kinds: an **action** (a function, or `{ at, run }`), a **served view** (`{ view }`), and **pages** (`{ pages }`, V5-14 pick 4).

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
    low: { view: (max: number, ctx) => ctx.data.lt('stock', max).az('stock', 20) },   // a view: bounded, blind to the caller
    byPrice: { pages: (_: null, ctx) => ctx.data.az('price'), size: 50 },             // one sorted list, read a page at a time
    ping: () => 'pong',                                               // a bare function: an action at the root
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
await shop.data.widgets.call('restock', 5)                            // a method by a name held in a variable
const pong = await shop.data.ping()                                   // a root action: called on the root lens
const low = shop.data.low(5).connect()                                // a view the server named: an address, then a link
await low.ready                                                       // a sync read waits for the first picture
const first = await shop.data.byPrice(null).page()                    // pages: a read of one page; it holds nothing
// @ts-expect-error call() is checked against where a method may be called: `low` is a root view, not a row's
shop.data.widgets.call('low', 5)
// @ts-expect-error a method declared `at: 'row'` is offered only on a row: at the root `sell` is a step to a row
await shop.data.sell(1)
// @ts-expect-error a root method is not offered on a path
shop.data.widgets.ping()
// @ts-expect-error V4-5: the typed client of a resource with methods has no set
await shop.data.widgets.stock.set(4)
// @ts-expect-error f.methods is gone: a root method is called on f.data
shop.methods.ping()
// @ts-expect-error a served view is an address, not a promise: get() it, or connect() it
const rows: readonly { stock: number }[] = await shop.data.low(5)
console.log(sale.left, pong, low.value, first.rows, rows)
```

- **A handler is `(arg, ctx) => result`**, as in v4. `ctx.at` is the lens the call was made on (for a root action, the root). `ctx.data` is this server's root lens, where operators run here, functions included (at `depth: 2` the types give the root no operators: a name there is a room, section 3.10); `ctx.set`, `ctx.remove` and `ctx.batch` are the array-form writes. **A handler reads a row once with `get()`** (V5-16; `ctx.rows` went): `await ctx.at.get()` on a path, which runs at the leader, so the read makes no trip; at the root, where `ctx.at` is every row, `await ctx.data[k].get()`. `ctx.peer` and `ctx.claims` say who called. `ctx.signal` aborts when the call ends, so a handler's links end with the call. `ctx.use(other)` gives another resource's handle bound to this call (section 7, "Methods").
- **Where a method may be called** (V5-12 pick 13; LENS 2.4). A bare function, a `{ view }` and a `{ pages }` are called at the root only: `f.data.ping()`, `f.data.low(5)`. To be called on a path, a method says which kind: `{ at: 'row' | 'partition' | 'any', run }`. **The server refuses any other path with `bad-path`**, and the types offer the method only on lenses of that kind, by its name (`lens.sell(1)`) and through `lens.call('sell', 1)` alike.
  - Why: under V4-5 a method is the only door, and a client picks the path. On E-55's first build a method on every lens let a client change a row's shape through the door; on the changed build, 202 of 202 calls on a path the method did not declare were refused, with 0 commits (E-55 review, claim 18).
  - `at: 'partition'` at depth 1 is the row, since each row is its own partition. `at: 'any'` may be called on any lens and at the root: inside one partition it runs at that partition's leader, at the root on any server *(this page's reading of LENS 2.4)*.
- **Root methods sit on `f.data`** (V5-13 pick 6; READS 4). One rule covers every method: it is called on the lens where it runs, and the root is a lens. A name is a key until it is called: `f.data.low(5)` calls, `f.data.low.get()` reads the row named `low`.
- **A method may not take a fero word where it would be called** (V5-13 pick 6). At the root those are the read verbs, the operators, `set`, `remove` and the probe names; on a row, the read verbs, `set`, `remove` and `touch`. An `at: 'any'` method avoids both lists. The types refuse a clash where it is declared, and the server refuses it at open with `bad-name`, naming the method. This replaces V5-12's "fero's names win", which hid a method behind a verb without a word. The cost: a word fero adds in a later version breaks an app that used it as a method's name, loudly, at its next start (READS 4).
- **The method table.** A client gets the table of method names at open. An unknown name is refused here with no trip, `no-such-method`, so a library that probes objects by their names fails loudly instead of sending a call (READS 4). A client whose open resolved before any server answered has no table yet, so a call waits for it, as a write waits as `pending`. In a rolling deploy each server's answers carry its table's version, and a client fetches the table again when it sees a newer one *(reasoned)*.
- **`lens.call(name, arg)`** calls a method by a name held in a variable, checked against where it may be called. A handle typed by its rows only (`fero<Row>`) has untyped calls through `call()` alone: `f.data.call('x', anything)`.
- **On a path, the call goes to that path's leader.** The caller's line carries the row, so there is no hint to store or learn. The handler's writes to that partition are then local: **one trip and one commit in all, the least a call can cost** (PA-25). E-55 claim 18, a stand-in: 1,000 path calls made 1,000 trips and 1,000 commits; after a leader moved, one redirect, then one trip again.
- **At the root**, an action goes to any server, as in v4. Each write the handler makes to a partition that server does not lead is one more trip: 0.66 extra trips a call with three servers and 0.80 with five in E-55's stand-in.
- **It is for speed, never for safety.** A method is not a transaction. Each of its writes is judged at the one leader; the code between them is not locked. So **a check-then-set must be an op, a condition or `set(fn)`** ([E-22] C5, D15). **And a method checks its argument**: a client picks it, as it picks the path (user rule 7).
- **An action answers after every write it made has committed.** It has no early stage (V5-11 ruling 6). **A throw** answers the caller `threw` with the message; writes made before it stay. A `FeroError` from a write inside reaches the caller as itself.
- **`{ once: name }`** makes a call run at most once; a retry, from any process, gets the first result. It costs three commits in a row (below). **`{ retry: true }`** stays from v4: "this handler is safe to run twice, so send the call again if its server is lost" (code: api/methods.ts:549-575). Without either option, a call whose server dies answers `unknown` and is not sent again.
- **A `{ view }` is an address, never a promise** (V5-13 pick 6). `f.data.low(5)` sends nothing: you `get()` it for one picture, or `connect()` it for a live view kept on one copy (section 3.10). A view takes no call options. **A `{ pages }` is one sorted list read a page at a time**: `page(after)` is one read that holds nothing (section 3.10).

**Typing a client: export the type, not the handle** (LENS 1.3). The server says `export type Shop = typeof shop`; the client says `import type { Shop } from './server.ts'` and `fero<Shop>('shop')`. One type argument types the rows, every method's argument and result, and where each may be called.

| The client says | Node 22 and 26 (type stripping) | `tsc`, `verbatimModuleSyntax` | esbuild, tsconfig with `verbatimModuleSyntax` | esbuild, without |
|---|---|---|---|---|
| `import type { Shop }` | the client runs; the server does not | ok | server not shipped | not shipped |
| `import { Shop }` (the mistake) | **SyntaxError when Node links the modules; nothing runs** | **error TS1484** | **server shipped** | not shipped |
| `import { shop }` (the handle) | **the server runs** | ok | **server shipped** | not shipped |

All measured (E-55 claim 24).

- **Check types before you bundle** (reasoned, LENS 1.3). A bundler that keeps imports as written and checks no types ships the server file for `import { Shop }`: the browser then gets the server's method code. Run `tsc --noEmit` (with `verbatimModuleSyntax`) or the lint rule `consistent-type-imports` before bundling. This costs fero no rule.
- **A cost that stays** (reasoned). A type-only import still makes the client's type check load the server file's whole import graph.
- **Later, a browser build of fero in which a server role throws** (V5-12 pick 12), `no-server-here`. The first build has no check of its own (section 8).
- **Typing the server.** TypeScript cannot take the row type from you and work out the methods' type in the same call. So there are three honest forms, and one that does not compile:
  - a seed gives the row type: `fero('shop', { data: {…}, methods: {…} })`, as above;
  - no seed: `fero.of<Score>()('scores', { methods: {…} })` (V5-17 keeps the name); at depth 2, `fero.of<Msg, 2>()`;
  - both by hand: `fero<Score, typeof methods>('scores', { methods })`;
  - `fero<Score>('scores', { methods })` **does not compile.** It would leave the methods untyped, so a typed client would accept any method name.

**What a call costs** (PATHS 3.4).
- **On a path:** one trip, to that partition's leader. The handler runs there; its reads and its writes to that partition are local. The server checks the path against `at:` before it runs: a lookup (reasoned).
- **At the root:** one trip, to any server, plus one per write its server does not lead: about 2 writes in 3 with three servers (PA-25; E-55 claim 18).
- A call with `once` is **three commits in a row**: claim the name, run, store the result. The claim and the result are rows of `#calls`, a resource of its own (V5-2), so a `once` call also makes **up to two more trips**, which calling on a path cannot save.
- A view and pages: section 3.10.

### 3.9 Reads: `get()`, `.value`, and what a sync read never does

| Read | Where | Cost | Can it be stale? |
|---|---|---|---|
| `h.value`, `h.value[k]` (from `connect()`) | here, through the handle, while the link is live | a `Map` read plus one trap and the `ended` check; the row is handed out by reference, frozen. The `Map` read alone is 43 to 51 ns at 1,000 rows, about 1 µs at 1,000,000, where cache misses rule (PATHS 4.1). **The first read of a row after it was written also freezes it**, once, deeply (DATA-07) | it is this process's last applied commit. Never older than anything this process already saw or wrote |
| `f.cluster.value`, `f.cluster.writes.value` | here: this process's own state (V5-16) | a property read; a new frozen object at each change | members and leaders as this process last learned them |
| `await lens.get()`, its partition held on purpose | here | no trip: the lens's walk, 0.17 to 0.29 µs with one key (section 4), and a promise, about 50 to 90 ns more than a sync read on a stand-in (V5-16). So about 3 to 5 times a handle's lookup: in a hot loop, read `h.value` | the same as `h.value` |
| `await lens.get()`, not held on purpose | **one GET** to a copy; nothing is kept | one trip and the value's bytes, every time. After 100,000 misses: 100,000 GETs, 0 SUBs, 0 rows kept (E-55 claim 20) | a copy may trail the leader by a moment, but never behind what this process saw |
| `await lens.get({ fresh: true })` | **always at the leader** | one trip, plus the leader's check with a majority that it still leads. No disk (PATHS 4.3). etcd's same read: 0.43 ms against 0.18 ms ([E-09e]) | no: it sees every write that finished before it began |
| `await lens.get({ when })` | holds the partition live until the test passes, reads, and lets go; ends at the test, its `signal` or its `timeout` | as `connect()` while it waits | as a link |
| listing a partition's or a whole resource's `value` | here | **every held row is walked**: 87 µs at 1,000 rows, 30 ms at 100,000, 0.5 s at 1,000,000 (PA-8, measured on v4's two passes; one pass is owed) | as `h.value` |

```ts
// file: reads.ts — read once, hold, read fresh, wait until
import { fero, FeroError } from 'fero'
type User = { name: string; age: number }
const users = await fero<User>('users')                   // a client: it holds nothing

const u = await users.data.u42.get()                      // one GET; nothing is kept
const me = users.data.u42.connect()                       // now u42's partition is held on purpose, and live
await me.ready
const again = await users.data.u42.get()                  // held on purpose: served here, no trip
const same = me.value?.name                               // a sync read through the handle: one lookup
const sure = await users.data.u42.get({ fresh: true })    // at the leader: sees every finished write
const name = await users.at('u42', 'name').get()          // the same kind of address, with no Proxy
const v = await users.data.u42.get({ version: true })     // the value and the row's version
const adult = await users.data.u7.age.get({ when: (a) => (a ?? 0) >= 18, timeout: '1m' })   // waits until the test passes
me.disconnect()
try { console.log(me.value) }                             // after the end: 'ended', never an old answer
catch (e) { console.log((e as FeroError).code, (e as FeroError).hint) }
console.log(u, again, same, sure, name, v?.version, adult)
```

**`get()` reads once, and it is the only way to read once** (V5-13 pick 1; CONNECT 5).
- `await lens.get()` is one GET, or no trip where the rows are held on purpose. `{ fresh }` asks the leader. `{ version: true }` gives the value and the row's version. `{ when }` waits until a test passes: it holds the partition while it waits, with its cost on the line. `{ signal }` and `{ timeout }` end a wait.
- **`get()` is not `connect({ once })`.** Built that way on a client it subscribed the whole partition: 65,671 B and 1,000 rows folded to read one number, against 1 B by a GET (E-56 probe 1) *(checked)*. So `once` on `connect` is refused by the types, and the message names `get()`.
- **`get({ at })` is refused**: a read as it was loads a snapshot and folds the log, so it has its own word, `past` (section 3.12). **`get(key)` is refused**: the step by a key is `at(key)`, then `get()` (CONNECT I10). In plain JavaScript a first argument that is not an options object is refused `bad-arg` *(reasoned)*.

**A lens is never a promise, and neither is a handle, a served view or a `past` before it resolves** (V5-12 pick 11; V5-13 pick 3).
- `await lens` gives the lens back. If a lens had `then`, anything that resolves a value would make a hidden trip: on E-55's first build, returning the **root** lens from an `async` helper downloaded 100,000 rows in one GET; now each such case makes 0 trips (E-55 review, claim 4: 47 of 47 cases).
- **A thenable handle lost every link** that passed through code that resolves values: an `async` helper that returned `lens.connect(fn)`, called 1,000 times, left 1,000 links open with 0 handles to end them (E-56 probe 1) *(checked)*. So the handle has no `then` either.
- **Seven names read as `undefined`** on every lens, because JavaScript or common libraries probe them on any object: `then`, `toJSON`, `constructor`, `$$typeof` (React), `asymmetricMatch` (Jest), `nodeType` (DOM checks); and `subscribe` (Svelte's store contract) is a type error that names `connect(fn)`. A key with one of these names, a symbol, or a key in a variable takes `at()`. `String(lens)` gives its path, `'shop.widgets.stock'`, a stable key for a framework.
- **One slip the types do not catch:** a forgotten `.get()` that is printed, `JSON.stringify(await shop.at(id))`, compiles and prints `undefined` (CONNECT 5.2). A lint rule catches it.

**A read is served here only from rows held on purpose** (V5-12; LENS 2.2 rule 2): a server, `hold: 'all'`, or a live link on its partition or on the whole resource. **A GET carries the highest position this process has seen**, and waits for the process's own early-answered writes (rule Y). A copy that is behind waits before it answers, so a process never reads backwards when a link ends and its next read goes to another copy (reasoned; counted, not tested).

**A lens is for wiring; a handle's `value` is for reading in a loop** (LENS 2.1; V5-16).
- A read through two steps and a verb costs 0.17 to 0.29 µs with one key, and 1.6 to 1.7 µs with keys spread over 1,000,000 rows, against 0.014 to 0.06 µs and 0.60 to 0.64 µs for a `Map` read (E-55 claim 1). So the hot sync read is a handle's lookup, `h.value[k]`: the reason LENS kept `rows` holds for it too.
- **A step keeps nothing**: 0 to 0.3 B per key after 100,000 keys (E-55 claim 2). data's handle today keeps 318 to 1,333 B per key.
- A step costs 49 to 99 ns with one key read again and again; with keys spread over 1,000,000 rows, 162 to 222 ns, most of it the `Proxy` on a big heap (E-55 claim 1). **`f.at(...keys)`** builds the same lens with no `Proxy`, and with full types: use it for computed keys and in hot loops (−79 to +33 ns over the direct read with keys spread). **A number key becomes its string**: `f.at(1, 'n')` is `f.data[1].n`. Any other key type, and a key `__proto__`, is refused `bad-key` (V5-15 pick 6).
- **What gets worse** (LENS 2.1). `typeof lens` is `'function'`. `console.log(lens)` prints `Lens(shop.widgets.stock)`. `JSON.stringify` skips a lens, and `structuredClone(lens)` throws.

**To read every row in sync, take `f.data.connect()`'s handle** (V5-16, which drops V5-13 pick 6's `f.rows`). It works on every role: on a server and with `hold: 'all'` it shares the rows already held, with no SUB of its own; on a bare client or a spare it subscribes, and if the link fails, `h.closed` says why.
- With `h = f.data.connect()`, `h.value.k` is one lookup and returns the frozen row itself, or `undefined` when no such row exists. At depth 2, `h.value.room1?.m7`. A partition held by `connect()` is read the same way (`room.value.m7`).
- A row you took never changes: it is frozen (DATA-07). A partition's or the whole resource's `h.value` is one live view, always "now" while the link lives.
- Listing it walks every row; that cost is in plain sight. **Owed: two pins**: `h.value.k` on a row already read within twice a `Map` read; the first read of a row just written, apart.

**No whole picture per read** (V5-13 pick 6; READS 9 question 5; section 5.6). One row is `h.value[k]`; a copy is a spread you write, `{ ...h.value }`, O(rows) on the line. It closes question 1 of section 11.1. The price: 89 lines in 52 example files read `.snapshot`, that read the old whole picture, and their printed output changes (READS 9) *(checked there)*.

**Sync reads never guess** (V5-16). A sync read never returns a stale, empty or partial answer in place of rows that exist somewhere else, and it never makes a hidden trip. So **there is one sync read, `.value`, and only where that is sure**:
- **a live handle's `h.value`**: its link holds what it reads. Before its first picture it throws `not-ready`; after its link ended, `ended` (V5-13 pick 5; section 3.10);
- **a `past`'s `value`**: a value that never changes (section 3.12);
- **`f.cluster.value` and `f.cluster.writes.value`**: this process's own state, kept by a link the open holds (section 3.10).
- **Nowhere else.** There is no `f.rows`, no `f.value` and no `ctx.rows`, and a lens has no `.value`: a property on a lens is a step, so `lens.value` is the row or field named `value` (`f.data.value` is a row named `value`, not every row). Elsewhere, `get()` reads once and `connect()` keeps a link.
- **On a process that is not a server and did not say `hold: 'all'`, an operator over every row left of `connect()` throws `not-held`.** The types refuse it on a bare client and name the way out: a view the server named (section 3.10), or `f.data.connect()` with the operator right of it. At `depth: 2` that handle has no operators in the types: your own code reads its value, rooms of rows (section 3.10).

### 3.10 Reads that stay: `connect`, the log, positions, and where a transform runs

**Four read verbs, one job each** (V5-13 pick 1). `get()` is a value once (3.9). **`connect()` keeps the lens's partition live here** and gives the newest state: a handle, a callback, or a loop. **`changes()` is the log**: every record on the lens's path from a place, then live; it waits for its reader. **`past(pos)` is one partition as it was**: a value (3.12). Live state and the log differ on purpose, and here they differ **by verb**, never by an option (V5-13 pick 3). **Every lens has every read verb, a field included** (V5-15 pick 2): the root has three, since `past` reads one partition.

```ts
// file: live.ts — connect, the line between server work and local work, and how a link ends
import { fero } from 'fero'
type Msg = { text: string; stars: number; hidden?: boolean }
const chat = await fero<Msg, 2>('chat')                            // a client of a depth-2 resource: a room is a partition

const room = chat.data.room1.connect()                             // a handle: room1 held live. Counted, shared
await room.ready
console.log(room.value.m7?.text)                                   // a sync read of the live view
const shown = room.filter((m) => !m.hidden).connect((rows, c) => draw(rows, c.diff))   // right of connect(): your code, here
const best = chat.data.room1.gt('stars', 0).za('stars', 10).connect()   // left of it: plain data; a copy may run it later
for await (const [rows, c] of chat.data.room2.connect({ signal })) { draw(rows, c.version); break }   // a loop; break ends it
chat.data.room1.connect((_, c) => ws.send(c.text()), { until: ws })   // a socket says when it closes: the link ends with it
const label = chat.data.room1.m7.text.connect((t) => { el.textContent = t ?? '' })   // holds room1: the wire sends partitions
setTimeout(label.disconnect, 60_000)                               // bound, so it can be passed on; safe twice
room.disconnect()                                                  // the views made from it end with it: `shown` too
console.log(best.value, shown.cursor)
```

| You write | You get | Where the work runs | What crosses the wire | A slow reader |
|---|---|---|---|---|
| `lens.connect()` | a handle: `value`, `ready`, `cursor`, `closed`, `disconnect`; and a loop | the fold, here | the partition (or the whole resource) once, then its changes | sees the newest state: changes are folded, one per row |
| `lens.connect((value, c) => …)` | the same, plus a call on the picture and once per commit, a microtask after `connect()` returns. Not a loop | as `connect()`, then your function | as `connect()` | as `connect()` |
| `for await (const [value, c] of lens.connect())` | the newest state each turn, with the diff merged since the last turn; `break` ends the link | as `connect()` | as `connect()` | skips to the newest: 1 to 50 rows waiting with a loop 10 times slower than the writes (E-56 probe 2) |
| operators right of `connect()`: `room.filter(…)` | a live view on held rows; it ends with its handle | here | nothing new | sees the newest state |
| `f.data.best(10).connect()` | a view the server named, kept on one copy | on that copy | only the view's own changes | sees the newest state |
| `lens.changes({ from })` | every record on the path, in order, from a place, then live | your loop | every record of the selection | waits; nothing is skipped |
| `lens.past(pos, { to })` | one partition as it was: a value, walked with `for…of` | here, once | the window's log, once | nothing to fall behind |

**`connect()`: three forms on one verb** (V5-13 pick 1; CONNECT 2.1).
- **What it does.** It hands over the picture so far, then each commit. No gap, no overlap (data's SCHEDULE clause 7; [E-31] across the network). E-55 claim 7: 0 changes missed or doubled in 1,000 seeds in one process and across 4,337 disconnects over a real port; on `connect`, 73,789 links in 1,000 seeds with 0 doubled, 0 missed, 0 wrong `prev` and 0 calls after the end (E-56 probe 4) *(checked)*. A reconnect sends only what was missed (PATHS 4.6).
- **The handle.** `h.value` is the state now, a sync read. A row or a field is a new frozen object at each write, a value you may keep. A partition or the whole resource is one live view, the same object at each commit: nothing is copied, so code that compares by identity wraps it each commit, `setView({ rows })` (CONNECT 2.1; E-56 probe 3). `h.ready` resolves to the handle once the picture is here. `h.cursor` is the place of this state, built only when read. `h.closed` settles when the link ends and rejects with why it failed (`expired`, `too-many-views`, a lost lease); it is made only when first read, so a failure nobody reads prints one stderr line and never becomes an unhandled rejection. `h.disconnect` ends the link: it is bound, so a framework effect can return it, and safe twice.
- **The commit, `c`** (CONNECT 2.1; V5-15 pick 7):

  | `c.` | What it is |
  |---|---|
  | `first` | true once: `diff` is then the picture so far, as adds. That first walk is O(rows held), in your code |
  | `diff` | this commit's changes, one per row, by reference and frozen: each with `type`, `key`, `partition` (its room at depth 2, the row's own key at depth 1), `row`, `prev` (the row before) and `version` (the row's version after this commit, for an undo's `if: { version }`). At depth 2 a commit is cut to the link's rows |
  | `version` | inside one partition only: this commit's id, the version of its last record there, such as `38S9`. The same text as `ack.version` and a diff entry's version. A link wider than one partition has no single commit id, and the types offer none |
  | `cursor` | the place right after this commit: save it, give it to `changes({ from })` or `past()`. Built only when read |
  | `order` | on an ordered answer only (a window, a sorted view): how ranks changed, after the row changes |
  | `recs()`, `text()` | this commit's records, built from the log's bytes, and their JSON text, for code that forwards them. Each is built once per commit and shared by every sink that asks (E-55 claim 9: 100 builds for 100,000 deliveries). A callback and a `past` step have them; **a loop turn has neither**, since a merged turn's records would be whole rows made up per loop (CONNECT I12) |

- **One call per commit**, so a DOM sink batches its patches. **Rows handed to a sink are frozen**, deeply, on their first hand-out (LENS 2.7): 163 to 220 ns per changed row (E-55 review).
- **A loop is the newest state each turn.** If `break` ended only the loop, a loop that breaks would leave a link nobody holds open for good; so `break` ends the link, and a handle made with a callback is not a loop (CONNECT I12; E-56 probe 4). A partition's state can run ahead of its turn's diff when commits land between turns: 5,640 of 196,267 merged turns (2.9 %) on the prototype; a row's never (E-56 probe 4) *(checked)*. A callback runs inside the commit and never sees this.
- **Equal lenses share.** Every `connect()` on one selection in a process shares one SUB, one decode and one fold per change, and one `c.text()` per commit. When the count reaches zero the unsubscribe is sent after the linger (`linger.ms`, section 9). E-56 probe 4 (claim 9 on `connect`): 2,000 handles on one row, 100 writes: 1 SUB, 100 decodes, 100 `text()` builds for 200,000 deliveries. So 1,000 sockets in one room on one webserver are one subscription and one decode per change.
- **Selections that overlap** (E-55 claim 7). A partition held inside a held whole resource sends no SUB of its own; when the whole ends, the partition subscribes again from the whole's server position. A resume cursor is always the server's position.
- **The wire sends whole partitions** (user rule 5; V5-12 pick 2). `chat.data.room1.m7.text.connect(…)` holds `room1`: the lens looks finer than the wire. At depth 1 the row is the partition, so there the first build is already exact.
- **`f.data.connect()`** holds the whole resource: the line for "everything", with a handle you can end.
- **Refused by the types, with a message that names the right line** (V5-13 pick 3): `from` on `connect` (the log is `changes({ from })`; the state at each step is `past(pos, { to })`), `at` on `connect` (`past(pos)`), and `once` on `connect` (`get()`). With `from` on `connect`, one word would turn a shared live link into a private reader that waits; in E-56 that one word moved a slow loop from 1 to 50 waiting rows to a queue of about 45,600 commits, though 7,777 such loops ran with 0 wrong answers. So this is a judgement, not a measurement (CONNECT 2.4).

**How a link ends: by your code, at the first of these** (V5-13 pick 2; CONNECT 2.3).

| How | When | For what |
|---|---|---|
| `h.disconnect()` | at once | anything. Bound and safe twice |
| `{ signal }` aborts | at once | a request, a job, a component, a handler (`ctx.signal`), a lock (`l.signal`). One listener per signal and a set entry per link: 0.11 to 0.16 µs to join and 0.05 to 0.07 µs to leave, at 1,000 to 10,000 links on one signal (E-56 probe 4b, the mechanism alone) *(measured)* |
| `{ until }` says it closed | at once | a Node socket, stream or HTTP response, the `ws` library's socket, a WebSocket: things that can say they **already** closed. Never an HTTP request: on Node 22.22.0 a request whose body was read said it closed at 19 ms while its client stayed until 315 ms (E-56 probe 5), so pass the response. A DOM node, an `EventSource` and a plain emitter are refused by the types, and anything else at run time, `bad-target`. +0.39 to 0.59 µs a link (E-56 probe 4b) *(measured)* |
| `break`, or a throw, in a loop over `connect()` | at once | a loop |
| the **count** reaches zero | after the linger, then the unsubscribe is sent | every link on one selection in a process shares one SUB; the last one out ends it |
| the process's clean stop | at once | everything (V4-8) |

- **Three rules make several ends safe** (V5-13 pick 2; E-56 probe 4: every lifetime case passes, and taking any one rule away broke a case) *(checked)*:
  1. **Every end is safe twice and removes the other ends' listeners.** Without it, 1,000 listeners stayed on a signal where 500 should, and a planted double release broke 28,137 checks.
  2. **`until` takes only things that can say they already closed**, and never an HTTP request. Without the check, a plain emitter that had closed never ended its link.
  3. **The first call comes a microtask after `connect()` returns**, so `const h = lens.connect((v) => { if (done(v)) h.disconnect() })` is safe. Without it, `h.disconnect()` inside the first call threw, the link leaked, and every later write threw data's `AggregateError`.
- **No weak links, no net, no `scope`** (V5-13 pick 2; what went is in 5.6). No link is tied to an object's life, and no block of code gathers links: each link carries its own end. The collector never ends a link: in a headless Chromium it collected 0 of 1,000 removed DOM nodes in 30 s (E-55 claim 13), and a weak link cost 2.2 times a strong sink (claim 11). A link nobody ends runs until the process stops: 1,000 of them cost 0.80 to 0.90 ms a commit (*measured* for weak links whose targets were never collected, E-55 claim 12; the same work here, *reasoned*). So **end every link**: `disconnect()` where the code removes what it drew, a signal for a request, a job or a component, `until` for a socket.
- **The dev warning.** In development fero prints one line, with the path, when an open link's handle is collected while the link has no `signal`, no `until` and no parent. The link keeps running, so no result depends on the collector. It is only a net, and often silent: it needs the collector to run, and a handle kept in a variable is never collected (CONNECT 2.3).
- **`f.cluster.value.links` lists the open links**, by path, with counts: what always shows a leak (V5-13 pick 2; V5-16; section 6, `ClusterShape.links`). The name is V5-17's.
- **`f.cluster` is a live link the open holds for you** (V5-16): on a client it follows the home group's records, members and leaders (LAYERS 8.3 step 5), and it adds this process's own writes and links. `f.cluster.value` and `f.cluster.writes.value` are sync reads of it: a new frozen object at each change, which you may keep. Until a server answers, `id`, `members` and `groups` read `undefined`, never `{}`. After `destroy()`, both throw `ended`. `f.cluster.connect((shape) => …)` and `f.cluster.writes.connect((rows) => …)` (V5-17) follow a lens's three rules above: the first call a microtask after `connect()` returns, then one per change; `disconnect()`, `signal` and `until` end it, each safe twice. Neither has `get()` or `snapshot()`: the value is already here, so a wait ("until three members") is `connect(fn)` with `disconnect()` inside. **Owed:** how often `lag` makes a new shape; at every commit, a screen would redraw per commit.
- **The ended rule** (V5-13 pick 5). **A partition's value is readable only while its link is live; after the link ends, a read throws `ended`**, and so does `h.value`. As first built, E-56 handed out the shared view, and a read after the end gave a different answer on a client with no linger, with a 50 ms linger, on a server, and with another link on the same rows; with a guard per link every such read threw `ended` (E-56 probe 4) *(checked)*. **To keep rows, copy them while the link is live**: `{ ...h.value }`, O(rows), on the line. A row or field value you took stays yours; a `past` is a value that never changes. **Owed:** the guard's cost in a real build, one flag check in the view's read trap (V5-13's consequences).
- **What `connect` costs** (section 4): the first on a partition is one SUB; a 100-row room's picture 26 to 28 µs (E-55 claim 6); another on a held selection 163 to 169 ns. A callback 161 to 189 ns a commit over no link on E-56's build; a loop +166 to +241 ns a commit over a callback when commits merge in bursts (E-56 probe 2) *(measured)*.

**The state forms: data's rule** (V5-15 pick 1). The state forms are `get()`, a link's value and its callback, a loop turn, and `past(pos).value`. For each of them, **a write at or below the lens gives a change relative to the lens; a write above it counts only when the lens's value changed (a new object counts); a write beside it gives nothing.** This is `data`'s own per-path rule (code data:api/index.ts:164-224), written down as fero's.
- So a field link runs when its field changed, never for a write to a sibling field. In [E-58], 2,000 seeds of writes at every level (rooms, rows, fields, nested fields, type changes, ops, batches) gave 0 wrong states, 0 missed changes and 0 wrong values-before, on 13 lenses, on a server and on a client that held only some partitions *(checked, parts 1 and 2)*.
- **"Changed" means a new object.** A record that crossed the wire is a new object, so on a client, and on every copy but the leader, a link on an object or list value runs again for a whole-row write that left it equal (E-58's T11) *(checked)*. `op.merge` sent as field records removes the case it makes (section 3.4). A link skips a value equal by `Object.is` to the last one it gave, so a row add does not hand `undefined` to a link whose part the row lacks *(reasoned; ANYPATH 4)*.
- It costs +6.7 to +11.2 ns a link a commit at 100 links over E-55's rule, and calls the user's function 5 times a commit where E-55's called it 100 (E-58 T2, number fields) *(measured)*.

**`changes()`: the log, on any lens** (V5-13 pick 1; V5-15 pick 2). `lens.changes(opts)` reads the log (V5-1): every committed record on the lens's path, in order, from a place, then live. The lens is the selector.
- **What it reads.** On the root, every partition. On a room or a row, that partition's records at or under the lens; nothing is above a row, since a room write is expanded into row records. **Below a row, the records on the lens's path: at, below or above it** (V5-15 pick 2). A reader below a row takes its part from a record above it (a whole row, or a field that holds the lens), folds a record below it into the value it kept, and **gives an entry only when its value changed**: data's rule applied to the log. Each such entry carries the lens's value right after the record (`e.value`; V5-17, as ANYPATH's section 8 sketch has it: the reader keeps that value anyway, so the entry hands it out). In E-58, reading "on the path" missed 0 changes and kept the right value after all 240,000 commits; reading only the records under the lens, as the 2026-11-18 page wrote it, missed 74 % and 78 % of the changes below a row *(checked, part 1)*. This closes question 19 of section 11.1.
- **An entry** is `{ rec, value, partition, version, time, source }`, plus `reason` on a remove that fero made, not your code: `ttl`, `max`, `where` or `session` when the resource's `rows` rule dropped the row, `erased` for `fero.erase`. `e.rec` is the record as written, shared with every other reader and never copied. At a row or wider, **`e.value` is what the record wrote, when it wrote a whole row**: it is `undefined` for a field write and for a remove, and it is never looked up, so it is not "the row now". Below a row, `e.value` is the lens's value after the record, as above. An entry has no `prev` and no folded state: the log is every record, not a state.
- **`from` is `'latest'` by default: from now on. "Now" is the call** *(reasoned, not modelled)*. The reader opens when `changes()` is called, so **a write this process makes after the call is always seen**. On a process that does not hold the selection, the open is sent with the call, and this process's own later writes to the selection wait in the client until the open is answered: one trip, once.
- **A cursor is a bookmark.** `r.cursor` is text: save it after each entry you handled, give it back as `from`. It stays valid across leader changes and moves ([E-31], [E-19]). A wrong text is refused `bad-cursor`. A saved cursor resumes at least once; for exactly once, `derive()` or `consumer()` keep marks in the target's own log (3.11).
- **It ends** at `break`, `disconnect()`, its `signal`, its `until`, or at `to`. `credit` (1 MB by default) bounds what is in flight to a slow reader, which then lags behind the log rather than filling memory here. `history` on the resource says how much log is kept; past it, the reader gets `expired`, with the earliest kept cursor.
- **It costs** one trip to open; the SUB carries the cursor, 22 to 79 B for 1 to 10 partitions ([E-19]); each kept record crosses once.

**Positions** (V5-13 pick 4; CONNECT 3). **A version names a record, and so the commit that holds it. A cursor, a time and `-N` name a place between commits. `from` starts at it, `past` reads right after it, `to` stops after it.** A version and `-N` work inside one partition only, and the types refuse them on the root.

| You give | It names | `changes({ from })` | `past(pos)` reads | `to` |
|---|---|---|---|---|
| a version, `38S9` | a record, and so the commit that holds it | starts **at** that commit: it comes again, whole | right after that commit | stops after it |
| a cursor | the place after what a reader saw | starts after it: nothing comes twice | the state at that place | stops there |
| `-5` | the place just before the 5th last commit whose records reached this lens | the last 5 such commits, then live | the state just before them | (as a place) |
| a `Date` | the place just before the first batch, in log order, stamped after that writer time | from that batch | the state just before that batch | stops there |
| `'earliest'`, `'latest'` | all that is kept; now (the default, fixed at the call) | | | `'latest'`: what was newest when the reader opened |

- **A version** is short text that keeps log order under plain `<`: a length character, then the (epoch, sequence) pair in base32, such as `38S9` (0 order errors in 1,000,000 seeded pairs, E-56 positions) *(checked)*. The same text everywhere: `ack.version`, `c.version`, a diff entry, a log entry, `if: { version }`, a lock token and `from`, so code compares with `===`. A version does not say whose it is: given to another partition, most such mistakes are refused `bad-position`, but one from another slot can land on this partition's own record and give a quiet wrong answer (CONNECT 3.2) *(reasoned)*. **So the place to save is the cursor**; a version is the id to show, compare and guard with. `changes({ from: version })` starts at the commit that holds it, not at that one record.
- **A cursor** is the resource's id and incarnation, then one (epoch, sequence) per slot it reads: 28 to 35 characters for one partition (E-56 positions) *(checked)*, 4 to 13 KB for a whole resource *(reasoned, from [E-19])*.
- **`-N`** (V5-15 pick 2) **counts the commits whose records reached the lens**: at or under it, or above it and changing its value. At a room or a row nothing is above, so it is the count by key; on a field it is found by reading the row's log back, which is not priced. It is a negative literal: `5` is refused, and so is a value typed `number` (most often a time); a `const` that holds `-5` is fine. The server counts back, since versions have gaps: with P partitions over 4,096 slots, about 5 × P / 4,096 of a slot's records when writes spread evenly, 0.6 to 2 ms at 10^6 partitions; for a cold partition beside a hot one it can be all of `history` (CONNECT 3.4) *(reasoned)*. **Owed:** counting back on a real log (V5-13's consequences). It counts from the call's "now", needs the log kept, and past it gives `expired`.
- **A time is a `Date`, never a bare number**, and it is approximate across partitions: writer time may differ by the members' clock gap, 100 ms early to 300 ms late with 250 ms of skew in [E-21]'s runs. A log entry's `time` is a number; as a position it is `new Date(e.time)`.
- **No Merkle trees** (V5-13 pick 4). Every partition has one leader and one order, so a position already says what is missing. No Merkle way kept per write came under 0.2 µs, and "rows newer than mine plus tombstones" beat a Merkle walk in all 8 resume cases (E-56 positions) *(measured, checked)*.
- **Replaying a field from an old place starts with a `past` read of its row** (V5-15 pick 2): the reader needs the field's value at that place before it can tell which later records changed it.
- **What to save to resume:** a log reader saves `r.cursor`; a live link you want to replay from later saves `h.cursor` or `c.cursor`, then reads `changes({ from })` for every record since, or `past(saved, { to: 'latest' })` for the state at each step; a live link after a restart saves nothing and takes a new picture. "Replay the last 5 with state, then live" is two calls with a seam (`past(-5, { to: 'latest' })`, then `connect()`): a commit that lands between them shows inside the new picture (CONNECT 6, S18). A folded resume, `connect({ resume })`, would close the seam; it is not taken now and is modelled first in E-31's model (V5-13 pick 7).

```ts
// file: log.ts — the log on any lens, and the positions it takes
import { fero } from 'fero'
type Msg = { text: string; stars: number }
const chat = await fero<Msg, 2>('chat')

const r = chat.data.changes({ from: saved ?? 'earliest', to: 'latest' })   // every room: from a cursor or a place
for await (const e of r) { console.log(e.partition, e.version, e.rec); keep(r.cursor) }   // save the cursor as you go
for await (const e of chat.data.room1.changes({ from: -5, signal })) console.log(e.version)   // one room: 5 commits back, then live
const hour = new Date(Date.now() - 3_600_000)
for await (const e of chat.data.room1.m7.stars.changes({ from: hour, signal })) console.log(e.value)   // a field: its value, each time it changed
```

**The line between server work and local work** (V5-14). **One line, the live verb, decides where a transform runs. Right of `connect()`, any code runs here, on rows held on purpose. Left of it stands plain data only, which a copy may run inside one partition later.** Over every row a client gets only a view the server names, or `{ pages }`. Across partitions there is no merger: a process that runs a view over every row keeps one store fed by slot. `derive` keeps a resource equal to a view (3.11); `lookup` is the one join; the log is read in the app's own loop; the past is read here (3.12).

| Class | Example | Where it runs | Guard |
|---|---|---|---|
| **A. a partition, then your code** | `chat.data.room1.connect().filter(fn)` | the partition crosses whole; the chain runs here | `rules.read`, once per subscription |
| **B. plain data inside one partition** | `chat.data.room1.gt('stars', 0).za('stars', 10).connect()` | **first build: as A.** Later a copy may run the chain and send only the answer (V5-12 pick 2) | bounded by the partition; past `views.shapes` (a guess), served as class A with the same answer |
| **C. a view over every row, named by the server** | `fans.data.best(10).connect()` | on one copy, never the leader | the door says which views; a cap says how many |

- **A function left of `connect()` does not compile**, and untyped code is refused `unencodable`: code cannot travel. So do `limit` and `reverse` left of it (write `za(field, n)`), `byFn`, and `lookup`. Each type error names the fix.
- **An operator over every row, on a bare client, is refused by the types**, and at run time `not-held`; the message names a view the server named. On a server, with `hold: 'all'`, and in a handler's `ctx.data`, the root's operators run here, over this process's one store, functions included. On a spare server, which holds no copy yet, such a `get()` or `connect()` first takes every row, the way `hold: 'all'` does (a `get()` for its one read, a `connect()` while its link lives), and then runs here (section 3.3; *this page's reading of TRANSFORMS R0*).
- **At `depth: 2` the types give the root no operators, on any role** (*this page's reading*; question 28). A name on that root is a room, so `f.data.za` is the room named `za`, and `f.data.connect()` gives a handle with no operators. Over every row at depth 2, a server declares a view, whose `ctx` is typed over rows; any process with `f.data.connect()` reads its value, rooms of rows, with its own code. A room lens keeps its plain-data operators (`chat.data.room1.za('stars', 10)`). CONNECT's and TRANSFORMS' sketches have the same gap.
- **Class B is the same answer, not cheaper CPU.** It buys bytes: a shape costs the copy 1.2 to 3.2 µs a change, about what the client pays in class A (1.3 to 5.0 µs), and the wire carries 0.1 to 28 B a change against 108 to 113 B (E-57 A7) *(measured)*. It equalled the chain run here in 79,209 checks through disconnects, resumes and the fallback to class A *(checked)*. It waits for the `view` selector in E-31's model and the order channel on the wire.

**The merge contract** (V5-14 pick 6; TRANSFORMS 2, 9). data 5's merge contract makes every view a function of its rows only, not of the order they came in:
- ties break by row key, in UTF-16 code units, and there is one total order per direction;
- one numeric projection serves sums, averages, extremes, quantiles, steps and range filters, and a sum is exact over every finite double;
- bucket keys are typed and compared by SameValueZero (`1` and `'1'` are two buckets);
- `limit` over a sorted parent reads its order; `limit` and `reverse` over unordered rows are marked "arrival" and stay right of the line.

Then two copies, a rebuilt view, a failed-over view and a client agree as values. Built small in E-57, every correctness check held with 0 unequal, and each planted bug was caught in 159 to 1,000 of 1,000 seeds *(checked)*. Today's data breaks the contract in many places: with 1 % strings in a number column, deleted rows stayed in a sorted view in 20 of 20 seeds (TRANSFORMS 2) *(checked)*.

**The operators.** Plain data, which may stand left of the line: `eq`, `in` (new), `gt`, `gte`, `lt`, `lte`, `between` (numbers only), `az` and `za` (with `n`, a window; with `{ after }`, a page), `by(field, { step })` with one aggregate per bucket (new), `group(field)`, `distinct(field)`, `length`, `sum`, `avg`, `min`, `max`, `median`. Code, right of the line: `filter`, `map`, `limit`, `reverse`, `byFn`, and `lookup`. Dashboards move from `group(fn)` to `by(field)`: 78 to 94 ms a change at 10^6 rows becomes about 0.66 to 1.84 µs (E-57 B2) *(measured)*. **Bucket answers are a `Map` with typed keys** (V5-14 pick 7): `teams.value.get('red')`, not `teams.value.red`.

**Served views** (class C; V5-13 pick 6; V5-14 picks 2 to 4).

```ts
// file: servers.ts — servers for views.ts: a { view } is bounded and blind to the caller; { pages } is one sorted list
import { fero } from 'fero'
export type Fan = { name: string; team: string; points: number }
export type Order = { user: string; sku: string; cents: number }
export type Product = { title: string; price: number }
const fans = await fero.of<Fan>()('fans', { views: { client: 16, max: 64, rows: 1000 }, methods: {
  best: { view: (n: number, ctx) => ctx.data.za('points', Math.min(n, 100)), version: 1 },   // a window: bounded
  byTeam: { view: (_: null, ctx) => ctx.data.by('team').sum('points') },                     // buckets: one number each
  total: { view: (_: null, ctx) => ctx.data.sum('points') },                                 // one value
  mine: { view: (user: string, ctx) => ctx.data.eq('name', user).length(),                   // per user: the user is the argument
          allow: (user: string, claims) => claims?.sub === user },                          // checked on every SUB, with the caller
  ranked: { pages: (_: null, ctx) => ctx.data.za('points'), size: 20 },                      // one sorted list, read in pages
} })
export type Fans = typeof fans
const orders = await fero.of<Order, 2>()('orders', { depth: 2, methods: {          // a user is a partition, an order a row
  byCents: { pages: (_: null, ctx) => ctx.data.za('cents'), size: 50 },              // depth 2: a cursor names (partition, row)
} })
export type Orders = typeof orders
const products = await fero<Product>('products', { server: true })
export type Products = typeof products
```

```ts
// file: views.ts — views the server names, pages, and the one join
import { fero } from 'fero'
import type { Fans, Orders, Products } from './servers.ts'
const fans = await fero<Fans>('fans'), orders = await fero<Orders>('orders'), products = await fero<Products>('products')

const top = fans.data.best(10).connect((rows, c) => draw(rows, c.order))   // a window: an array in rank order, with rank changes
const teams = fans.data.byTeam(null).connect()                              // buckets: a Map from team to number
const total = await fans.data.total(null).get()                             // one value, read once
await fans.data.best(10).connect().sync()                                   // after my own write: wait until the view has it
const p1 = await fans.data.ranked(null).page()                              // pages: one shared index on one copy
const p2 = p1.next && await fans.data.ranked(null).page(p1.next)            // the next page after a cursor
orders.data.ada.connect().lookup(products.data, 'sku').connect((rows) => {   // the one join, right of connect()
  for (const k in rows) { const j = rows[k]; if (j?.other) draw(j.row.cents, j.other.price) }   // undefined: loading; null: none
})
await teams.ready
console.log(top.cursor, teams.value.get('red'), total, p2)
```

- **Declared `{ view: (arg, ctx) => … }`, an address you `get` or `connect`.** The server's author decides what work every write may carry; a client picks only the argument. A view must be:
  - **bounded**: a window, one value, or buckets. A view of unbounded rows, of `group`, of `limit` over unordered rows, or of a page after a cursor does not compile, and each error names the fix. Buckets cannot be bounded by a type, so `views.rows` (1,000, a guess) is checked on every commit; past it the view ends `view-too-big`, which stays until the method's code changes (E-57 A5, XA-12);
  - **blind to the caller**: one view serves every equal call, so its `ctx` has the rows only, no claims. A per-user view takes the user as its argument, and `allow(arg, claims)` checks it with the caller on every SUB (E-57 A4: 3,188 denials, 0 frames to them) *(checked)*;
  - **a function of its argument and the rows**: no clock, no random number, no module state. A view with a `Date.now()` threshold gave another answer after a failover in 822 of 1,000 seeds (E-57 XA-8) *(checked)*. The types cannot see this; it is a user rule;
  - **of one resource**: `lookup` inside a view does not compile, since its positions cover one resource. A handler may join, once.
- **Placement** (V5-14 pick 3). **Each served view lives on one copy, chosen by a hash over every copy but the leader.** A SUB at another copy gets `moved`, naming the right one. The leader, which takes the writes, never builds a view while another copy can serve it. **A group whose only copy is the leader**, as with one server process or while a group grows from one voter (section 3.3), **has the leader serve its views until a second copy is ready, and health says so** (V5-17). Meanwhile a build stalls the write path *(reasoned; not run)*. Serving from standbys first refused a held view in 377 of 1,000 seeds with one standby; with every copy but the leader serving, 5 and 6 of 1,000 (E-57 xa2s2x, xa2sbx) *(checked)*. The price: a new leader hands its views on, 1,796 to 3,271 hand-offs per 1,000 seeds with standbys.
- **The cap** (V5-14 pick 2). **At most 64 served views per copy (`views.max`), weighted by cost**: each entry counts by data 5's cost class for its call, O(1), O(log n) or O(n) a change, so the cap bounds cost, not only count (E-57 XA-9, on guessed classes) *(checked)*. Lingering entries count; a `{ pages }` index counts as an ordered view. **A client holds at most `views.client` (16) per copy.** **Headroom:** with k serving copies, k of 2 or more, `views.max / k` is kept free on each for clients that held a view on a copy that died; **with one serving copy, none**, since its failover goes to copies that hold no views. So k copies admit about (k − 1) × `views.max` fresh views. Past a cap the SUB is refused `too-many-views`. This replaces the 2026-11-18 page's 1,000 per resource.
  - **Why so few.** Every live served view sees every write to its resource. At PERF-09's 50,000 writes a second one core has 20 µs a write, about 18 µs of it left for views. A bucket or sum view costs 1.8 to 4.9 µs a change with its frame, so about 3 to 10 fit; a leaderboard costs 5.7 to 6.7 µs at 1,000 rows, 12.2 to 15.7 at 5,000, 17.4 to 20.6 at 10,000 and 134 to 155 at 100,000 (E-57 A1 and pagecost) *(measured)*. Class C is for **a few shared views per resource**, not a query per user.
  - **What headroom does not cover.** A client that held a view was still refused after failures, in 1 to 21 of 1,000 seeds by configuration (TRANSFORMS 3.8: E-57 XA-2 and its reruns; V5-14's consequences quote 5 to 21, its standby and leader-kill runs) *(checked)*. It is one of V5-14's three missed bars. A failover may refuse a held view, rarely, while copies come and go.
- **The row guards** (V5-14 pick 1). **Until data 5's ordered index (D8c), an ordered `{ view }` over more than 5,000 rows and a `{ pages }` over more than 2,000 are refused when built** (`view-too-big`). The numbers are guesses at the edge of the budget. D8c's chunked index costs 3.0 to 4.6 µs a write at 10^5 rows and 9.5 to 15.1 at 10^6, still above its guessed 3 µs (V5-14's missed bar XB-1) *(measured)*.
- **Builds.** A copy builds one view at a time per resource; a `get()` with no live entry builds like a SUB, counted and paced. Today a build over 10^6 rows stalls its copy for 0.49 to 1.9 s in one piece, 0.21 to 0.24 s sliced, until data builds every view in slices (V5-14's missed bar XA-1) *(measured)*. Off the leader, a stall slows that copy's fold, never the writers.
- **What a client gets.** A window is an array in rank order, and each commit carries `c.order`; operators right of a served ordered view keep its order. A served scalar is a number. A new picture, after a failover, a ring miss or a redeploy, arrives as one commit of differences with one call (E-57 XA-4). A resume within the entry's ring of recent frames sends only the frames missed. **`sync()`** on a held view resolves once the view has passed every write this process saw resolve: read-your-writes for a served view (E-57 XA-13: 1,965 answers, 0 early) *(checked)*. A method's version (`version` beside `view`, else the deploy's build id) is part of its entries' key: a new version ends old entries `redeployed`, and a client never shows an older version than it has seen; an older typed client gets `stale-client`.
- **On the wire.** A SUB's `view` selector carries `{ method, arg }`, with the client's `seen` and the method's version. **Owed:** the `view` selector in E-31's model (V5-14's consequences).

**Pages** (V5-14 pick 4). **`{ pages: (arg, ctx) => ctx.data.za(field), size }` is a third kind of method**: one sorted list, read a page at a time. The copy keeps one shared index for it; `page(after)` is one read of the next `size` rows after the cursor, 10 to 16 µs and 32 B on the copy, and it holds nothing (E-57 XA-7) *(measured)*. The plan of one served view per cursor cost 0.7 to 8.3 MB a page and was refused by the 17th page. **The index is not free**: it is an ordered view of every row with no window, kept on every write while it lives: 8.3 to 9.1 µs a write at 1,000 rows, 29 to 33 at 10,000, 509 to 525 at 100,000 on today's data (E-57 pagecost) *(measured)*. Pages are exact within one cut; across fetches a row is shown once if its sort value did not change between them (E-57 XB-7). At depth 2 a cursor names (partition, row). **Owed:** paging across a failover (V5-14's consequences).

**`lookup`: the one join** (TRANSFORMS 6). `left.lookup(other.data, field)` gives, for each row of the left view, the row of `other` whose key is `row[field]`, as a frozen `{ row, other }`, kept live when either side changes. **`other` is `undefined` while that key's first picture is on its way, `null` when there is no such row, else the row.** fero opens one link per distinct key the left rows name, counted, lingered and ended with the view, so those rows are held on purpose: a new key costs one trip, from the one line the user wrote. There is **no common cut**: `other` may lag behind the left side by as much as its link lags. It runs right of `connect()` or in a handler; never left of the line, never inside a `{ view }`. 537,670 checks, 0 unequal (E-57 B4); 2.9 to 3.9 µs a left change, 161 B a left row *(measured)*. Many to many, a join on a field that is not the other's key, and a join at a common cut are not supported (TRANSFORMS 6.2).

**Ten rules for transformations** (TRANSFORMS 8.4; V5-14).
1. Left of the live verb stands plain data whose answer depends on the rows only.
2. Over every row, a client asks for a view the server named: bounded, capped and blind to the caller.
3. A served view depends on its argument and the rows only.
4. Views agree as values, not as bytes, and a view over several groups is defined at a cut.
5. `derive` has two forms (3.11).
6. A `lookup` holds the rows it names, and has no common cut.
7. A served view can be refused by a cap, also after failures.
8. Pages are exact within one cut.
9. `limit` and `reverse` over unordered rows follow this process's arrival order.
10. The record form sees records, not rows, unless it asks for rows (3.11).

### 3.11 Derived resources, and exactly once

There are three steps, and each costs more and lasts longer.

| Step | Code | Where it lives | Cost |
|---|---|---|---|
| a view | `orders.data.ada.connect().filter(fn)`, right of `connect()` | in this process, while its handle lives | the fold: about 1 µs per change for a filter ([E-05]) |
| a served view | a `{ view }` clients `connect` | on one copy, while a client holds it | its work on every write, once for all equal calls |
| a derived resource | `derive(view, target)` or `derive(source, target, fn)` | in its own log and copies, for good | a share of one commit per change |

```ts
// file: derived.ts — totals from orders: the two forms of derive, then what the record form is made of
import { fero, op, derive, consumer, lock } from 'fero'
type Order = { user: string; cents: number; paid: boolean }
const orders = await fero<Order>('orders', { server: true, history: '7d' })   // every row, for views; 7 days of log, for the record form
const totals = await fero<number>('totals', { server: true })    // a server of the target
await derive(orders.data.by('user').sum('cents'), totals)         // the view form: totals equals the view; no history needed

const counts = await fero<number>('counts', { server: true })
await derive(orders, counts, (e) => {                             // the record form: once per record, by marks; needs history
  if (e.value) counts.data[e.value.user].set(op.incr(1), { from: e })   // e.value: whole-row writes only (a dev warning)
})
const paid = await fero<number>('paid', { server: true })
await derive(orders, paid, (e, { row, prev }) => {                // the record form with rows: the row after and before
  if (row?.paid && !prev?.paid) paid.data[row.user].set(op.incr(row.cents), { from: e })   // a field write counts too
}, { rows: true })

const invoices = await fero<{ cents: number }>('invoices')
const billing = await consumer(orders, 'billing')                 // the same, into any resource: one owner per share
billing.run((e) => { if (e.value) invoices.data[e.partition].set({ cents: e.value.cents }, { from: e }) })

const spent = await fero<number>('spent', { server: true })       // what the record form is made of: four lines, under a lock
await lock('derive:spent', async () => {
  for await (const e of orders.data.changes({ from: spent.marks('spent') }))
    if (e.value) spent.data[e.value.user].set(op.incr(e.value.cents), { from: e })   // not awaited: writes pipeline
})
```

**`derive` keeps a resource equal to a view, in two forms** (V5-14 pick 5; V5-15 pick 4).
- **The view form, `derive(view, target)`**: the target's rows are kept equal to a bucket view of the source with one value per bucket, over a string or a number field. The view's answer is a `Map` from bucket to value, with typed keys (V5-14 pick 7); each bucket names one target row: a string by itself, a number by its decimal form. It reads rows, not history, so it needs no `history` and survives compaction. It runs this way:
  1. Take the lock `derive:<target>`; its row carries the deriver's **code version** and data build. A deriver never takes over from newer code; after a rollback an admin resets the lock row's version.
  2. **Bump** every target group: one fenced no-op write each, and wait for each answer.
  3. Read the source's position **after** the bumps: the **read barrier**. Fold up to it silently.
  4. Read the target, then write the difference: a set per changed bucket, a remove per bucket that went. Every write carries the lock token.
  5. Follow the source: one fenced write per changed bucket per commit.
  - As first planned (a lock, fenced writes, a full difference) it failed 514 of 1,000 seeds: the target was wrong at idle in 28 and handed back to older code in 452. With the bump, the barrier and the code version: 0 of 1,000, through 11,810 deriver changes and 7,475 starts after the source's log was cut (E-57 B3, XB-8 to XB-10) *(checked)*.
  - Only the deriver writes the target; any other write is refused `derived`. Two buckets with one name at run time (`1` and `'1'`) stop the deriver with `bucket-collision`, named in health *(reasoned; not run)*.
  - **Its log is a log of states**: each restart's difference is in it. A consumer that counts records there miscounts; events go through the record form.
- **The record form, `derive(source, target, fn)`**: `fn` runs once per source record and writes with `{ from: e }`. Marks make it exact across restarts; it needs the source's `history`. **It sees the record, not the row**: `e.value` is set only for a whole-row write, so a filter on row content in `fn` is exact only for a source written by whole rows. A dev warning names the line when `fn` reads `e.value` on a field record (V5-15 pick 4). In E-58's mix a filter on the record alone left the final set wrong in 582 and 584 of 1,000 seeds (part 4) *(checked)*.
- **The record form with rows, `derive(source, target, (e, { row, prev }) => …, { rows: true })`**, is in the first build (V5-15 pick 4, superseding V5-14 pick 8). The deriver folds its share of the source, so `fn` also gets the row after the record and the row before it: a field write counts too. It costs one fold per record (0.63 to 1.5 µs at 10^3 to 10^5 rows, E-57 A1) and about 330 B a row of its share ([E-05]) *(measured)*; on a restart it opens the source's past at its mark and folds forward. **Owed:** a build of it (V5-15's consequences).

**Use `derive()` and `consumer().run()` first** (V5-12). They are libraries over public calls, and nothing in them is a primitive (LENS 2.8). They **pace the loop** (item 1 below); they **run it once**: a **share** is a part of the source's partitions that one runner owns at a time, `#groups` keeps who owns which, and the derivers that share a name split the source's shares; and **`derive()` sends bare marks** for output slots that get no output for a while. `consumer().run()` restarts from its share's own cursor and needs no bare marks (V5-17).

**The mark is a write option: `{ from: e }`** (V5-12 pick 7). The write and "source record `e` is applied" land in one log entry of the target. The leader skips a marked write at or below its stored mark and answers it as done. `target.marks(name)` reads the marks back as a cursor for `changes({ from })`. A mark is 29 B in the target's own log, so a restart resumes exactly, and no source record counts twice ([E-30]).
- **The mark carries the write's number within its record**, and a record's outputs to one slot go out in that order. E-30's model, widened to two outputs of one record in one slot, holds on all 12 bounds; without the number, or without the order, an output is lost (E-57 B5) *(checked)*. Packed into one number the mark stays 29 B; a record whose `fn` writes more than 256 outputs to one slot is refused `too-many-outputs` (TRANSFORMS 3.4). This closes question 21's case of several outputs.
- **Which name a mark goes under** (V5-17): marks are kept per reader name; `target.marks(name)` gives a cursor that carries the name, and `{ from: e }` marks under it, else under the target's own name.
- **A marked write takes no `once` name** (V5-17). `if` and `ttl` are allowed. A mark goes on a plain write, an op or a remove; `set(fn)`, `batch` and a room write take none.

**The four lines are exact only with two more things** (LENS 1.7).
1. **fero paces the loop.** A marked write is never refused `backpressure`: it waits, and the `changes()` reader its `e` came from stops yielding while this client holds 512 waiting writes or 64 MB. Unpaced, E-55's stand-in lost outputs in 998 of 1,000 seeds; paced, 0 lost and 0 doubled (E-55 review, claim 21).
2. **It runs in one process.** With `server: true`, every server process of the target that runs the four lines derives: the marks keep the result right, but the work is done N times. Take a lock (P-10), or use `derive()`, which splits the work.

- **Not awaiting is the point.** Marked writes not awaited ran at 122,000 to 134,000 a second, against 239 to 240 awaited one by one (E-55 claim 21).
- **The source needs `history`** for the record form, and the default keeps none (section 9), so the source's server opens it with one, as above. Past it, the deriver stops with `expired` rather than skip a record (LAYERS 8.8).
- There is no transaction across the two. The target trails the source by about one commit. On the project's one timeline, a derived record is placed after its source (V5-4).

**Is fero exactly once?** (LENS 1.2.) **Yes, for writes into fero, in three layers, each with a limit: a resend counts once inside one session; a `once` name counts once for a day; a mark counts once per source record while the source keeps its log and the loop is paced and runs in one process. Like Kafka, not for an email or a payment made inside your code.**

| Layer | Makes exactly once | For how long | Cost | Kafka's nearest (from memory) |
|---|---|---|---|---|
| **sessions**, always on | a resent write | the session's life; a pause over `session.ms` answers `unknown` | 309 B a client; 13 rules, model-checked ([E-20]) | the idempotent producer |
| **`once` names** | a write or call the app names, across processes and restarts | 1 day | about 221 B a name (section 3.4) | nothing direct |
| **marks** (`{ from: e }`) | read from a source, write an output | while the source keeps its log back to the mark | 29 B a mark; 5 rules, model-checked ([E-30]); 1 more for pacing | transactions with `sendOffsetsToTransaction` |

- **Weaker than Kafka:** no atomic write across partitions that readers cannot see half of ([E-24]; V5-1 gave this up knowingly). **Simpler:** the mark needs no coordinator and no two-phase commit ([E-30]).
- **Still owed:** E-30's model with `{ from: e }` written by app code, and the pacing rule in a real client.

### 3.12 Looking back: `past`

`past(pos)` is one partition as it was: a value, folded here once, with nothing to end (V5-13 pick 1; section 5.6). It is in the first build, with the other three read verbs (V5-17).

```ts
// file: past.ts — one partition as it was: a value, folded here once
import { fero } from 'fero'
type Item = { stock: number }
const parts = await fero<Item>('parts')                      // a client of a resource with no methods, so it may write

const ack = await parts.data.widgets.set({ stock: 3 })
const was = await parts.data.widgets.past(ack.version)       // one log read from the nearest snapshot, folded here
console.log(was.value?.stock, was.step(-1)?.value?.stock)    // a value: nothing to end; undefined past the window's edge
const audit = await parts.data.widgets.past(new Date('2026-11-19T12:00:00Z'), { to: 'latest' })   // a window, to now
for (const [row, c] of audit) console.log(c.version, row?.stock, c.diff.length)   // every commit since, with its state
const old = await parts.data.widgets.stock.past(-3)          // a field: 3 commits back that reached it, from its row's log
console.log(old.value)
```

- **A value, not a link.** Its window is read before the promise resolves, and it keeps no SUB and no link. It never changes, and it never serves `get()` or a handle's value, so dropping it changes nothing anyone can read (CONNECT 2.3). Its memory, 103 to 285 B a version (E-55 claim 23), goes when your code drops every value of that window.
- **`value`, `version`, `cursor`.** `p.value` is the state right after the position: after a version's commit, or at a place. `p.version` is the commit that made it, and `p.cursor` the place right after it. A row's value is the row that version made; a room's is a view fixed at that place, which you may keep.
- **`step(n)` gives a new value** n commits back or forward, sharing the window, or `undefined` past the window's edge, which starts at the nearest snapshot before the place asked. It never changes the value you have. A step is one commit, not one record: nobody can see a state inside a commit. 10 to 12 ns a step, plus one small object (E-55 claim 23) *(measured; the object reasoned)*.
- **`for…of` walks the window**: `past(pos, { to })` yields exactly the commits `changes({ from: pos, to })` would yield, each as `[value, c]`, the state right after it and its diff, with `c.version`, `c.cursor`, `c.recs()` and `c.text()`.
- **Inside one partition only.** On the root it would fold every partition, so the types refuse it and name the way: read the log from a time, `changes({ from: new Date(…) })`. A version and `-N` work here as on the log. On a field, the state forms follow data's rule (3.10). `-N` counts commits whose records reached the lens: at or under it, or above it and changing its value; it is found by reading the row's log back. Replaying a field from an old place starts with a `past` read of its row (V5-15 pick 2).
- **How.** One log read from the nearest kept snapshot at or before the position, folded here with a sorted list of versions per row (E-54). To open: the snapshot load, O(rows of the partition), then 3.6 to 4.4 µs a record (E-55 claim 23); a million records since the snapshot is about 4 s. A room's row at a step: 0.6 to 1.4 µs (E-55 claim 23). 0 wrong answers in 1,680 checks against a refold *(checked)*.
- **It needs the log to reach back**: `history`, or the tier. Past it: `expired`.
- **No views on a past value in this page's types.** TRANSFORMS 3.7 showed views stepping with a past reader in an earlier spelling (E-57 B6: one call a step); with `past` as a value, a view is rebuilt per value or fed from each step's diff *(reasoned; not run)*.
- **Why not on the write path** (E-54, at 10^5 and 10^6 rows). A hash-tree root kept per write adds 3.3 to 5.7 µs to a 0.79 to 1.4 µs fold; a prior value in the log would add 80 to 150 % to a record's bytes. No version structure in data, and no prior value in the log (V5-12 pick 8, kept by V5-13).
- **An undo** takes `prev` and `version` from a diff entry and writes `set(prev, { if: { version } })`, so a write that came in between is not overwritten (CONNECT 6, S11).
- **Owed:** `past` as a value in a real build (V5-13's consequences).

## 4. What each call costs

"Trip" is one round trip: about 40 µs at the median on one box, the network's between machines ([E-01]). "Commit" is one disk sync on a majority, shared with every other write in flight: about 1 ms at the median on one box (MEMORY 9.3). Times are TypeScript. **The lens's, `connect`'s and the views' own costs are the prototypes': the lens's and data's share in one process, never a whole fero write** (v4's issue path alone is 7.7 to 8.3 µs, PATHS 2.6). E-56's and E-57's timed numbers were made again on 2026-11-20 and moved between sessions: E-56's most by up to about 30 %, a few more (the callback 110-141 → 161-189 ns; E-56 README, "When it ran"); E-57's by 10 to 25 % (TRANSFORMS 3.8).

| Call | Trips | Commits | Copies, or whole-resource work | Source |
|---|---|---|---|---|
| a step, `f.data.a.b` | 0 | 0 | none. Nothing kept: 0 to 0.3 B a key (data's handle today keeps 318 to 1,333 B a key for ever). A `Proxy` per step: 49 to 99 ns with one key; 162 to 222 ns (median 205) with keys spread over 10^6 rows | E-55 claims 1, 2 |
| `f.at(k1, k2)` | 0 | 0 | none: −79 to +33 ns over the direct read with keys spread | E-55 claim 1 |
| `h.value`, `h.value.k`, `f.cluster.value` | 0 | 0 | none: one lookup, the row by reference; a row's first read after a write freezes it | PATHS 4.1; PA-8 |
| a read through a lens (two steps and `get()`), held on purpose | 0 | 0 | none: 0.17 to 0.29 µs with one key, 1.6 to 1.7 µs with keys spread over 10^6 rows (a `Map` read: 0.014 to 0.06 and 0.60 to 0.64 µs), timed without the promise; the promise adds about 50 to 90 ns on a stand-in | E-55 claims 1, 14; V5-16 |
| `lens.get()`, not held on purpose | 1, each time | 0 | the value, and the highest position this process has seen. **Nothing kept**: 0 rows and 0 SUBs after 100,000 misses. `get()` built as a one-shot subscription moved 65,671 B to read 1 B | E-55 claim 20; E-56 probe 1; PATHS 4.4 |
| `lens.get({ fresh: true })` | 1, plus the leader's round with a majority | 0 | one value | PATHS 4.3 |
| `lens.get({ when })` | as `connect()` while it waits | 0 | the partition, held until the test passes | CONNECT 2.1 |
| listing a partition's or a whole resource's `value` | 0 | 0 | **every held row walked** | PA-8 |
| `lens.set(v)`, `f.set(path, v)`, an assignment, `lens.remove()` | 1 to the leader (+1 if this process cannot route: a browser, or a missing partition function) | 1, shared | one encode, kept for resends. The steps add 0.18 to 0.73 µs to a 0.7 to 1.3 µs local data write; a kept lens −0.03 to +0.42 µs; `at()` about 0 | PATHS 3.1; V5-9; E-55 claim 3 |
| a field write with `if: { equals }` | as a write | 1 | the old value in the request; a compare at the leader. **Not priced** | V5-15's consequences |
| `room.set(rows)`, `room.remove()` | 1 | 1 | one log entry, expanded by the leader into row records; one tombstone per removed row. In data's fold alone, one batch was 2.3 to 5.9 times less work than the same rows as separate local commits. **A size rule is owed** | E-58 T1; V5-15's consequences |
| `await w.received` / `w.replicated` | the same write; you stop waiting sooner | still 1 | none | PATHS 3.3; V5-11 |
| N writes made together | 1 frame per leader | shared: about 62 records a sync when busy | per record: a decode, a judging, a fold. **At most 512 waiting or 64 MB**; then a plain write is refused `backpressure` (an assignment throws) | PATHS 3.6; [E-02]; LAYERS 4.2 |
| a write with `once` | as a write | 1 | about 221 B at the leader for a day; no early stages | [E-20] |
| N writes awaited one by one | N | N in a row | | PA-40 |
| `f.batch([...])` | 1 | 1 | one log entry | PATHS 3.6 |
| `lens.set(fn)` | as a conditional write, per try | 1 per try | a local read if the partition is held on purpose | section 3.7 |
| `lens.set(v, { from: e })`, a marked write | as a write | a share of 1, per output partition | a 29 B mark. Never refused `backpressure`: it waits and pauses its reader. Not awaited: 122,000 to 134,000 a second, against 239 to 240 awaited | [E-30]; PATHS 4.9; E-55 claim 21 |
| a method on a path, `lens.sell(1)` | 1, to the partition's leader | 1 or more, shared | the path and the argument, encoded once; the server checks the path against `at:` | PA-25; E-55 claim 18 (a stand-in) |
| a root action, `f.data.x(arg)` | 1, +1 per write its server does not lead: 0.66 extra trips a call with 3 servers, 0.80 with 5 | 1 or more, shared | the argument and the result, encoded once each | PATHS 3.4; E-55 claim 18 |
| a call with `once` | 1, plus up to 2 to `#calls`' leader | **3 in a row** | | PATHS 3.4; V5-2 |
| `lens.connect()` on a partition | 1 SUB, shared by every equal lens in this process | 0 | **the partition once**, then one shared frame per change. Here: about 3.2 µs to decode and 0.2 to 1.9 µs to fold a small row. A 100-row room's first picture: 26 to 28 µs in the prototype | PATHS 4.5; E-55 claim 6 |
| another `connect()` on a held selection | 0 | 0 | a second handle, 163 to 169 ns; the lookup and count inside it, 39 to 45 ns (measured for V5-12's `here()`) | E-55 claim 6 |
| `connect(fn)`: a callback | 0 | 0 | 161 to 189 ns a commit over no link on E-56's build (E-55's: 92 to 198, of which 63 to 122 is data's delivery to any sink); each row handed out frozen on first hand-out, 163 to 220 ns | E-56 probe 2; E-55 review, claim 10 |
| a loop over `connect()` | 0 | 0 | +166 to +241 ns a commit over a callback when commits merge in bursts; +116 to +137 when it keeps up; 1 to 50 rows waiting and 0.3 to 0.4 MB with a loop 10 times slower than the writes | E-56 probe 2 |
| reading `c.diff` and `prev`; `c.recs()`; `c.text()` | 0 | 0 | `prev` 8.2 to 11.5 ns a change; the records 137.6 to 170.3 ns a change; their JSON 278.6 to 376.9 ns; each built once per commit and shared | E-56 probe 3; E-55 claim 9 |
| `c.version`, `c.cursor`, a diff entry's `version` | 0 | 0 | built only when read. **Not measured** (bar: 50 ns a commit); a whole-resource cursor is 4 to 13 KB | V5-13's consequences; CONNECT 9 |
| a field link under data's rule | 0 | 0 | +6.7 to +11.2 ns a link a commit at 100 links over E-55's rule; the function runs 5 times a commit, not 100 (number fields) | E-58 T2 |
| `{ signal }` on a link | 0 | 0 | 0.11 to 0.16 µs to join one listener per signal, 0.05 to 0.07 µs to leave, at 1,000 to 10,000 links. A listener per link, as E-56's prototype does, is the trap: 19 µs to add at 10,000 links | E-56 probe 4b |
| `{ until }` on a link | 0 | 0 | +0.39 to +0.59 µs a link (a shape check and one `once('close')`) | E-56 probe 4b |
| the `ended` guard | 0 | 0 | one flag check in the view's read trap *(reasoned)*. **Owed** in a real build | V5-13's consequences |
| a link nobody ended | 0 | 0 | **a cost the line does not show**: its changes go on crossing, decoding and folding, and its function runs, until the process stops: 0.80 to 0.90 ms a commit for 1,000 such links (measured for weak links never collected; the same work here, reasoned). The fix is `disconnect()`, a signal, `until` or `break`; `f.cluster.value.links` shows it | E-55 claim 12; CONNECT 2.3 |
| a lens inside a big partition | as `connect()` | 0 | **the whole partition** (first build) | user rule 5 |
| operators right of `connect()` | 0 | 0 | a filter about 1 µs per affected view; an ordered view with a window 1.6 to 62 µs a change, by partition size; `by().sum()` 0.66 to 1.84 µs at 10^6 rows, where `group(fn)` is 78 to 94 ms. Released when their handle ends | [E-05]; E-55 claims 16, 26; E-57 B2 |
| `lookup(other, field)` | 1 per new key named | 0 | 2.9 to 3.9 µs a left change; a right change 1.9 to 3.3 µs when one left row names it, 39 to 48 at 100; 161 B a left row | E-57 B4 |
| a served view, `f.data.best(10).connect()` | 1 SUB | 0 | on its copy, on **every write to the resource**: a bucket or sum view 1.8 to 4.9 µs a change with its frame; a leaderboard on today's data 5.7 to 6.7 µs at 10^3 rows, 12.2 to 15.7 at 5,000, 17.4 to 20.6 at 10^4, 134 to 155 at 10^5 (1.1 MB at 10^4, 9.1 MB at 10^5). One encode per frame for every subscriber: 288 encodes for 288,000 sends. One more subscriber 2.0 to 2.1 µs to join. Counted against the cap (64 a copy) | E-57 A1, A5, pagecost |
| a served view's build | 0 | 0 | on its copy, one at a time: today 0.49 to 1.9 s at 10^6 rows in one piece, 0.21 to 0.24 s sliced (a missed bar until data builds in slices) | E-57 XA-1 |
| `{ pages }`: `page(after)` | 1 | 0 | a read: 10 to 16 µs and 32 B on the copy; holds nothing. **The shared index costs every write while it lives**: 8.3 to 9.1 µs at 10^3 rows, 29 to 33 at 10^4, 509 to 525 at 10^5 on today's data; D8c's index 3.8 to 5.1 at 10^5 | E-57 XA-7, pagecost, pageindex-cost |
| class B pushed down (later) | 1 SUB | 0 | only the answer: 0.1 to 28 B a change against 108 to 113 B for the partition; the copy pays 1.2 to 3.2 µs a shape, about what the client pays here | E-57 A7 |
| `lens.changes({ from })` | 1 to open | 0 | **every kept record on the path**; the SUB carries the cursor, 22 to 79 B for 1 to 10 partitions | PATHS 4.5; [E-19] |
| `changes({ from: -5 })` | 1 to open | 0 | the server counts back: about 5 × P / 4,096 records of the slot when writes spread evenly, 0.6 to 2 ms at 10^6 partitions; up to all of `history` for a cold partition beside a hot one; on a field, the row's log read back. **Not priced on a real log** | CONNECT 3.4; V5-13, V5-15 consequences |
| `changes({ from: date })` | 1 to open | 0 | a binary search over segments by their first batch's time; no time index | CONNECT 3.5 |
| a reconnect | resumes from the server's position | 0 | only the missed records | PATHS 4.6; E-55 claim 7 |
| `lens.past(pos)` | 1 log read | 0 | a snapshot load, O(rows of the partition), then 3.6 to 4.4 µs a record to fold with the version lists; 103 to 285 B a version, in this process only, until every value of the window is dropped; a step 10 to 12 ns plus one small object | [E-54]; E-55 claim 23 |
| `derive(view, target)`, the view form | 1 SUB to the source | 0.748 target writes per source commit, fenced; one bump per target group at a takeover | the view, on the deriver; a restart 48.7 to 51.8 ms at 10^5 source rows and 10^3 buckets | E-57 B3 |
| `derive(source, target, fn)`, the record form | 1 delivery a record | a share of 1, per output partition | a 29 B mark. With `{ rows: true }`: one fold a record, 0.63 to 1.5 µs, and about 330 B a row of the deriver's share | PATHS 4.9; [E-30]; E-57 A1; [E-05] |
| `depth: 2` | | | a key grows 2 B. Partitions of 100 rows and more: the fold is 0.78 to 1.10 times flat with PA-17's index, and 1.2 to 805 KB **less** memory a partition. One-row partitions: 1.3 to 1.5 times, and +0.9 KB each, until data's D3 | E-55 claim 19 |
| a partition function (later) | | | an index from partition to rows on every copy: memory per row, an update per fold | PA-17 |
| `fero(name)`, a client, by default | 2 to 3 built well | 1 (its session) | none: it holds nothing | PATHS 3.2 |
| `hold: 'all'`, or `f.data.connect()` | 1 SUB (none for `f.data.connect()` on a server or with `hold: 'all'`: it shares the rows held) | 0 | **the whole resource, once; then every write to the resource**, decoded and folded here | PATHS 3.2, 4.5 |
| an operator over every row on a spare server: its root operators, or `ctx.data` | 1 SUB per such `connect()`; one picture per such `get()` | 0 | **the whole resource**: a `connect()` takes it once and then every write while its link lives; a `get()` takes it for each read and keeps nothing. None on the first `copies + standbys` servers. **Not measured** | section 3.3; TRANSFORMS R0 and 10 item 10 |
| `hold: '200MB'`: a closed selection opened again | 1 SUB | 0 | a resume (the changes since) if the server can; else the picture again. Nothing while closed; never free | reasoned (LENS 2.2) |
| `fero(name, …)` with a server role, joining | | | the whole log copied and folded; a `dir` and its syncs; a vote or a standby | PATHS 2.1, 5.1 |
| `fero(name, …)` founding a resource | one create-if-absent | about 5 ms; about 35 ms across machines | about 8 KB per server while idle | [E-49]; V5-8 |
| `lock(name)` | as a conditional write | 1 | | P-10 |
| a lock, kept | | 3 a lease: it renews every third of its lease; 1 more to release | | V5-17; [E-22]'s library. **Times owed** |
| a consumer member | | 3 a lease for each share it owns, renewed as a lock is | | V5-17; P-08 |
| a consumer's `commit()` | 1 | 1 per share the batch read: 1 for a batch from one share | | V5-17; P-08 |
| `consumer().run()` | | a share of 1 per output, as a marked write; a cursor write per share now and then, at a rate not yet set | a 29 B mark | V5-17; P-08; [E-30] |
| a library's own links: an asker's, a waiting take's | 1 SUB each | 0 | as `connect()` on a partition; for a waiting take, every job row of the queue's partition, then every add, take and ack there. **Not measured** | V5-17 (question 39) |
| `saga([...])` | | **6 to 7 in a row**, about 7 ms | | PATHS 3.7 |
| a queue message | | 3 (add, take, ack) | | PATHS 4.13 |
| a `service` ask | | 3; 2 more for each try after a throw (a release and a new claim) | | [E-22] D7; V5-17; reasoned |

Nothing on the surface decodes, copies or walks a whole resource except the bold "whole" and "every" rows. Most of those say so in their shape: a call that returns everything, or a listing you wrote. **Four do not, so learn them:** `hold: 'all'` (an option, not a line of code), a lens inside a partition, which holds the whole partition (user rule 5), a served view or a `{ pages }` index, which costs its copy something on every write to the resource, and an operator over every row on a spare server, which downloads the resource first (the deployment, not the line, says whether this server is a spare).

**Where the surface itself used to cost, and what this page did.**
- A whole picture copied every row per read: a sync read is a handle's lookup, and the picture went (PA-8; V5-13 pick 6; V5-16).
- A `get` that missed followed its key for the life of the handle: `get()` holds nothing (E-55 claim 20); and it is not a one-shot subscription (E-56 probe 1).
- A bare `fero(name)` downloaded the whole resource, then every write to it: the default holds nothing (V5-12 pick 1).
- data's handle kept every child for its parent's life, 318 to 1,333 B a key: a step keeps nothing (E-55 claim 2).
- A weak link cost 2.2 times a strong sink, and dropped links ran until the collector found them: every link is strong and ended by your code (V5-13 pick 2).
- A listener per link on a shared signal cost up to 19 µs to add at 10,000 links: one listener per signal (E-56 probe 4b).
- K lenses on K rows cost data O(K) a commit: through a keyed index, 1.09 to 1.52 times K = 0 at K = 10,000 (E-55 claim 8; data's change D1; it needs a pin).
- A sink that named a parameter cost 1.5 to 1.8 µs a change: one `c` per commit, by reference (E-55 claim 10).
- A field link ran on every write to its row, 2.3 to 2.6 times a change on E-55's prototype: data's rule runs it when its value changed (E-58 part 1).
- A method's writes were forwarded on about 2 calls in 3: a call on a path goes to its leader (PA-25).
- One served view per page cursor cost 0.7 to 8.3 MB a page: one shared index (E-57 XA-7).
- `group(fn)` rebuilt a bucket per change, 78 to 94 ms at 10^6 rows: `by(field)` with one aggregate, about 1 to 2 µs (E-57 B2).
- `derive` invited one commit per output: a marked write is not awaited, and fero paces it (PATHS 4.9; E-55 claim 21).
- A room's first picture needed an index from partition to rows on every copy (PA-17): with `depth: 2` a room is a partition.
- A promise per write: made only when the handle is awaited (PA-13). An early report per write: sent only for writes that asked (PATHS 3.3). A client's write went through any server: it goes to the leader (V5-9).

## 5. What changes, and why

### 5.1 From v4

**Kept from v4, on purpose:** `fero(name, opts)`; roles by declared act; writes by plain assignment, on an untyped handle; a write shows when it commits (V4-7); `methods:` as the door (V4-5); `validation`; data's operators as live views (now right of `connect()`); a view a server serves streams (now a `{ view }`); Ctrl-C (V4-8); `fero.spawn` (V4-9); the config cascade (V4-10); the box directory (V4-3); one process per `dir` (V4-59); user throws go to the fault printer (V4-47); `ctx.data`, `ctx.peer`, `ctx.flush()`; `diag(f)` in `fero/internals`. `{ retry: true }` on a call. `f.data.k.remove()`, now the lens verb `remove`.

| v4 | v5 | Why |
|---|---|---|
| a cell keeps its newest stamp (last writer wins); example 17 loses an increment | one leader per partition orders writes; ops, conditions, `set(fn)` | V5-1, V5-6. Counters, stock and locks become correct |
| a write shows when its owner stamps it | a write shows when a majority has it on disk | V5-5. Nothing shown can vanish. It shows about 1 ms later |
| `methods.update(change, { confirm })` | `lens.set(v)` returns a handle; await it, or `.received`, or `.replicated` | V5-5, V5-11: every write goes all the way; you choose when to stop waiting |
| built-in `methods.update / insert / remove / read` | `lens.set`, `lens.remove`, `f.batch`, `lens.get`; your methods sit on `f.data` | one write path, and no clash with a method you name `update`. (The door still refuses a client's plain write when it runs, as v4's refused `methods.update`; a typed client now cannot write it at all) |
| v4's lens calls: `f.data.set(k, v)`, `f.data.k.update(v)`, `f.data.patch(pairs)` | `f.data.k.set(v)`; one `set` per pair | V5-12: one write verb on the address; the others were second names |
| reading a row through `f.snapshot`, which builds the whole picture | `h.value.k`, through a `connect()` handle, is one lookup; `f.snapshot` is gone | PA-8, V5-13 pick 6, V5-16: 87 µs to 0.5 s per read becomes one lookup |
| `replicas: N`, and `await f.data` gathering from every member | `lens.get()` and `lens.connect()`: a row not held is one trip to one copy | PATHS 4.4: the gather cost members × cells per read |
| `ScopedError` on a sync read of a shard | no sync read of a shard: a handle's `value` covers what its link holds; else `get()` or `connect()` (V5-16). One error type, `FeroError` | one error type; the hint names the call |
| a reconnect downloads the whole resource | a reconnect sends what was missed | [E-31]; E-55 claim 7 |
| `tap(() => …)` or `tap((rec) => …)`, chosen by reading the function's source text | `connect((value, c) => …)`: one call per commit, the value first | LENS 1.6, V5-13 pick 1: one shape; a parameter cost 1.5 to 1.8 µs a change (code data:ops/misc.ts:598-611) |
| `connect(anchor, fn)`: the anchor is checked, then ignored | `connect(fn, { signal, until })`: a strong link that ends by your code, at `disconnect()`, a signal, `until` (a socket that closes), `break` or the count | V5-13 pick 2; code data:api/index.ts:357-361 |
| settings must match on every member, or they refuse to link | resource settings are records in the resource's own log | V5-2 |
| `WriteResolve`, `WriteReject { reached, reason }` | `Ack`, and one `FeroError { code, outcome, reason, hint }` | `outcome` says whether it may have committed. `e.reason` still prints what it printed |
| a call: `{ retry: true }` | `{ retry: true }` stays; `{ once: name }` is added | `retry` sends an idempotent call again at no extra commit; `once` is at most once, from any process, at three commits |
| `replicas`, `heartbeat.ms`, `seams` | `copies` and `standbys`, `ping.ms`; `seams` gone | Raft needs a fixed, odd set of voters; Raft has heartbeats of its own, so the link's ping gets its own word |
| `dir` per resource, off by default | `dir` per process, on by default for a server | one journal and one disk sync for every resource in the process ([E-12]); every write is on disk (V5-5) |
| `cluster.epoch`, `cluster.partitions` | `cluster.groups`, `cluster.health`; `cluster.writes` stays | the ring and the ballots are gone; health says what is wrong and the fix |
| `f.cluster.snapshot()`, `f.cluster.me.snapshot()`, `f.cluster.writes.snapshot()`, `tap(fn)` on each | `f.cluster.value` (with `me` inside it), `f.cluster.writes.value`, `connect((shape) => …)` | V5-16: one sync read, of this process's own state |

**The examples ladder.** Most rungs keep their files. Every `console.log(f.snapshot)` changes, since `f.snapshot` is gone: 89 lines in 52 example files (READS 9). The ones whose lesson changes: 03 (the pending row now waits for a majority; and a client with no server yet has a handle that throws `not-ready`, and `f.cluster.value.members` that reads `undefined`, where v4 printed `{}`), 04 and 08 (the built-in methods become verbs), 10 (`confirm` becomes stages), 12 and 13 (`{ confirm: 'persisted' }` becomes a plain `await`), 16 (scoped becomes "holds what its links name"), 17 (the lost increment becomes `op.incr`, with the old race shown as the reason). **And every rung that reads rows in sync**: a bare client now holds nothing, and no role has a sync lookup of every row, so such a line reads through a handle, `f.data.connect()` or a partition's `connect()`, or reads once with `get()` (V5-12 pick 1; V5-16; about 20 READMEs, LENS 7 Q1). **And 46 lines in 33 files read the cluster** with `snapshot()` or `tap` *(checked: grep)*. Each becomes `value` or `connect(fn)`, but 23 of them, in 23 files, also read a field v5's shape lacks: `peers` (10 lines), `epoch` (8), `me.uuid` (5), `me.hosts` (2), `me.origin` (1), `partitions` (1). The table's `cluster.epoch` row maps `epoch` and `partitions`; the rest are owed (section 11.2).

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

Each is a rename, a short form of calls that exist, or removes a cost. None adds a trip, a copy, a decode or a pass over a resource. (Rows the lens and V5-13 to V5-15 changed again point to sections 5.5 and 5.6.)

| COMP2's page | This page | Why |
|---|---|---|
| `f.snapshot.k`, promised as a property read but built as a full copy | `h.value.k`, a lookup through a live handle; `f.snapshot` is gone (V5-13 pick 6; V5-16) | "snapshot" says "a copy"; a handle's `value` is "the state, now", and only while its link lives (PA-8) |
| `f.read({ from })` | `lens.changes({ from })`; `from` defaults to `'latest'` | "read" sounds like reading a row; the lens is the selector (5.5) |
| `fero.cursor(text)` to bring back a saved cursor | the saved text goes back in as `from` | one step less; a wrong text is refused `bad-cursor` at the open |
| `shortfall`, `holistic` | one code, `not-held`, whose hint names the call | the two names said nothing; the fix is the same kind |
| `cache: { memory }` | by default a client holds nothing; `hold: 'all'` or a size | the old key hid a change of mode and a whole-resource download (5.5) |
| `id` on a write, `key` on a call | `once` on both | one name for one idea; `key` already means a row key. A write with `once` answers at its commit only |
| a `get` that misses always follows | `get()` reads once and holds nothing; `connect()` holds | a read and a hold are two lines (5.5) |
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
5. **`connect` and `changes`.** Live state, or the log. `connect()` keeps the newest state here, and calls you or loops; `changes()` hands you every record in order, and waits for you (section 3.10).
6. **`fresh`.** "A local read can be a moment behind another process's write. `fresh` asks the leader." Most apps never need it: a process always sees its own writes and never reads backwards.
7. **`outcome`.** One question: did my write commit? `refused`: no, and it never will. `unknown`: maybe; fero keeps trying, and `cluster.writes.lookup(attempt)` tells later.
8. **Versions and cursors.** A version is a record's place in its partition's log, short text that keeps order under `<`, and inside one partition a commit's id. A cursor is a bookmark across partitions. The rest is LAYERS'.
9. **"A check-then-set must carry a condition or be an op."** The most useful rule on the page, once buried under "Methods". It follows from one leader judging on the newest state: your read is a copy, and it can be old by the time your write lands.
10. **`batch`.** Read as "for speed"; it is "all or none".
11. **Twelve words at one level.** An app needs five (section 1). Slots, groups, attempts and sessions are plumbing.
12. **Labels on every line** (L0 to L5, A-nn, RR-nn). Builder's notes; they stay in the source marks and in LAYERS.

### 5.5 From the 2026-11-16 page, for the lens (V5-12)

The owner reviewed the 2026-11-16 page and asked for the lens they had explored before data's rewrite: `resource.a.b.c` builds an address, `connect()` pipes the state and then its changes to a target, calls are a space apart from keys, operators before and after the call split server work from local work, and `r.a.b.c.method()` runs at that path's leader. [LENS.md](LENS.md) is the full answer; V5-12 records the fourteen picks. **What went, what replaced it, and why** *(V5-12's change, as written then. Its words `here`, `tap`, `scope`, `closes`, `asOf`, the weak `connect`, `f.methods` and `f.data.snapshot()` were replaced in turn by V5-13 to V5-15: section 5.6)*:

| Gone | Now | Why |
|---|---|---|
| `f.follow(of)` and the `Follow` handle | `f.data.room1.here()`. A list: two `here()`s in one scope, which ride one link (reasoned). `{ prefix }`: with `depth: 2`, `f.data.ada.here()`, with no walk of partition names. `{ share }` stays inside `consumer`, where it always was | one word, `here()`, for "hold it live", whatever the source (LENS 2.6). A user no longer learns `follow` (LENS 4.4) |
| `f.methods.x(arg).open()` | `f.methods.x(arg).here()` | the same word for a served view as for a partition (LENS 2.6) |
| `near: true \| 'sku'` on a method | a method called on a path runs at that path's leader; `{ at: 'row' \| 'partition' \| 'any', run }` says where it may be called, and the server refuses another path `bad-path` | V5-12 picks 3 and 13. The caller's line carries the row, so there is no hint to store or learn. The declared word is a guard the server enforces: on E-55's first build, with no declared place, a client changed a row's shape through the door (LENS 2.4) |
| `partition: { before: '/' }` | `depth: 2`: the first key is the partition | V5-12 pick 4. `{ before }` was the same idea spelled as a text rule, and it needed an index from partition to rows on every copy (PA-17). A message as a field of its room would lose a row's version, conditions, expiry and early stages (LENS 1.1) |
| `f.data.set(k, v)` | `f.data.k.set(v)`, or `f.set([k], v)` | V5-12. A third spelling of the same write. Three stay: assignment (untyped), `lens.set(v)`, `f.set(path, v)` (LENS 2.5) |
| `hold: 'all'` as the default, and `hold: 'asked'` | by default a client holds nothing until a `here()` or a `tap` says what; `hold: 'all'` (or `f.data.here()`) for everything; a size is a cache of pictures | V5-12 pick 1. Every download is a line you wrote. A bare `fero(name)` in a job no longer downloads the resource and then every write to it |
| `get(k)` that followed `k` for good, and `get(k, { hold: false })` | `lens.get()`: reads once, holds nothing | V5-12. The hidden follow was a slow leak the line did not show; E-55 claim 20 holds nothing after 100,000 misses |
| `f.get(k)` on the resource | `f.data[k].get()`, or `f.at(k).get()` with no `Proxy` | LENS 2.6: the read is a verb on the address. V5-17: `get` is a verb on a lens only; LENS names `f.set(path, v)` as the array form that stays |
| `changes({ of })` | `lens.changes()`: the lens is the selector | V5-12; LENS 4.2 item 7 |
| `derive`'s `out`, `Out`, `OutTo` | a marked write, `{ from: e }`, on any write; `target.marks(name)`; `target.mark(e)`; a loop writes another resource through that resource's own lens. (`ctx.use(other)` stays for a method's handler: no decision removed it) | V5-12 pick 7. The exactness is visible on the write line. `derive()` stays, as a library that paces the loop, runs it once and sends bare marks (LENS 2.8) |
| `f.data.*` untyped (data's own proxy, `LiveData`) | typed lenses: a wrong field, a wrong value, an early stage on a judged write, a method below its declared path, a write on a door-closed client, and `await lens` used as a value are compile errors | LENS 2.1; E-55 claim 5 |
| `f.data.snapshot()`, `view.snapshot()` | a handle's `rows`; the whole frozen picture stays `f.snapshot` | on the lens a call is a verb, and `snapshot` is not one of the lens's verbs; a view is read through its handle (user rule 5). V5-17 keeps it gone |
| a token's `follow` claim | its `read` claim: the partitions a client may read or hold | V5-17: the claim keeps its meaning, under a word that still exists |
| (new) | `here`, `connect`, `get` as a verb, `at`, `depth`, `ctx.at`, a method's `at:`, `{ from: e }` with `marks()` and `mark()`, `asOf`, `call`, connect's `closes`, `scope`, `too-many-views`, `bad-path`, `bad-key` | LENS 4.4 |

- **What a user no longer has to know** (LENS 4.4): `follow`, `.open()`, `{ before }`, the two meanings of `tap`, `f.data.set`, the hidden follow inside `get`, and `near` as a hint to learn.
- **What stays, said plainly** (LENS 4.4): `hold` still has three values (nothing, `'all'`, a size). A write still has three spellings (assignment, `lens.set`, `f.set(path, v)`). A method on a path still declares one word (`at:`), where `near: true` stood.
- **Users learn seven rules** (section 2), and four of them the types cannot check (section 7).
- **The price in rules: about +12 to +18 on 416, 3 to 4 %, for the first build, plus three in a reader library for `asOf`** (reasoned, not modelled; LENS 4.4). By V5-6's measure the lens costs rules and cannot win on rules alone. The trade: the seven places a computation can run (LENS 2.3) are said with one address and one line, `here()`, where the 2026-11-16 page named four of them with four unrelated words; a `get` no longer hides a follow; and `f.data.*` is typed.
- **data changes for it, in TypeScript, none in Rust** (V5-12 pick 9; LENS 4.5): D1 (path subscriptions through a keyed index) and D2 (the uncached, callable lens) first; then D3 (two-level stores) and D4 (one sink shape). Each is useful to data alone.

### 5.6 From the 2026-11-18 page, for V5-13 to V5-16

The owner found the mix of `here`, `tap`, `connect` and `changes` unclear, asked why a root method was `f.methods.x` while a path method was `f.data.k.x`, proposed one `connect` with options, asked for a validated plan for transformations, and asked whether v5 keeps reads and writes at any level of a resource. READS.md and [CONNECT.md](CONNECT.md) answered the first (V5-13), [TRANSFORMS.md](TRANSFORMS.md) the second (V5-14), and [ANYPATH.md](ANYPATH.md) the third (V5-15). Later the same day the owner asked whether the remaining snapshot reads could go as well, keeping a sync `.value` read only where it is safe beyond doubt, and reading through `get()` or `connect()` elsewhere (V5-16). Each row below is a change from the 2026-11-18 page; section 5.5's table is V5-12's change as written then, and its words that this table replaces are not current.

**Reads** (V5-13).

| Gone | Now | Decision, and why |
|---|---|---|
| `lens.here()` and its `Held` handle | `lens.connect()`: a handle (`value`, `ready`, `cursor`, `closed`, `disconnect`) that is also a loop | V5-13 pick 1. One live verb; the owner's word |
| `tap((c) => …)` | `connect((value, c) => …)`, a microtask after `connect()` returns | pick 1; the value first, the commit second |
| the weak `connect(target, fn \| 'prop')`, its net, `closes`, `scope(fn)`, `dispose()`, and "a `connect` function changes only its target" | every link is strong and ends by your code: `disconnect()`, `{ signal }`, `{ until }`, `break`, or the count; a dev warning names a link whose handle was collected; `f.cluster` shows open links | pick 2. The collector ended 0 of 1,000 links in Chromium in 30 s, and a weak link cost 2.2 times a strong sink (E-55 claims 11, 13); `scope` lost links made after an `await` (READS 1) |
| `link.close()` | `h.disconnect`, bound and safe twice; `h.closed` | pick 2; the platform's word for ending a watch |
| `held.rows`, `held.value`, readable after `close()` | `h.value`; a partition's value is readable only while its link is live, then `ended` | pick 5; a read after the end gave four answers in four settings (E-56 probe 4) |
| `c.changes`, `c.now` | `c.diff` (each entry with `prev`, `version` and `partition`), the value as the first argument | picks 1, 4; V5-15 pick 7. "changes" now names only the log |
| a commit with no id and no place | `c.version` inside one partition, `c.cursor` everywhere, `h.cursor` | pick 4 |
| `changes({ from, until: 'latest' })`; `from` a cursor or a version, "starts at that record" | `changes({ from, to, credit, signal, until })`; `from` also `-N` and a `Date`; a version starts at the commit that holds it; `until` is only a thing that closes | pick 4 |
| `asOf(pos)` on any lens: a reader with `step`, `seek` and `close` | `past(pos, { to })` inside one partition: a value with `value`, `version`, `cursor`, `step(n)` (a new value) and `for…of`; nothing to end | pick 1 (superseding V5-12 pick 8) |
| `Position = Version \| Cursor \| Time`, a time a bare number | a version, a cursor, a `Date`, `-N` (a negative literal), `'earliest'`, `'latest'`; a version and `-N` inside one partition only | pick 4 |
| a version as opaque text | short text that keeps log order under `<`, the same everywhere | pick 4; no Merkle trees |
| `get()` | gains `{ when }` and `{ signal }`; `at` and a key are refused | picks 1, 3, 6 |
| a handle and a served view that could be awaited (`Served` was a `PromiseLike`) | no `then` on a handle; a served view is an address | pick 3; a thenable handle lost 1,000 of 1,000 links (E-56 probe 1) |
| `f.methods.x(arg)`; "fero's names win" with `lens.call` as the way out | `f.data.x(arg)`; a method named like a fero word is refused where it is declared (`bad-name`); an unknown name `no-such-method`; `call()` stays for a name in a variable | pick 6 |
| a method that returns a view, `here()`'d | `{ view }`, an address you `get` or `connect` | pick 6 |
| `f.snapshot` | gone: `h.value[k]` through a `connect()` handle, or a spread you write | pick 6; V5-16 |
| (new) | `from`, `at` and `once` on `connect` refused by the types, naming `changes()` and `past()` | pick 3 |
| (not taken) | a folded resume, `connect({ resume })` | pick 7: modelled first in E-31's model |
| `f.cluster.tap(fn)`, `f.cluster.writes.tap(fn)` | `connect((shape) => …)`, giving a handle with `disconnect` | pick 1's one live verb, carried to the cluster (V5-17) |

**Sync reads** (V5-16, the same day).

| Gone | Now | Decision, and why |
|---|---|---|
| `f.rows`, on a server and with `hold: 'all'` (V5-13 pick 6 kept it) | every row read in sync through `f.data.connect()`'s handle, on any role: `h.value[k]`. No `f.value` | a lookup on "a server" works on five servers and throws on a spare, which cannot wait for its download: the deployment, not the line, would decide (section 3.3). The handle costs what `f.rows` did, one lookup and one trap, plus the `ended` check; and it says when it fails (`h.closed`) |
| `f.cluster.snapshot()`, `f.cluster.writes.snapshot()` | `f.cluster.value`, `f.cluster.writes.value`: sync, this process's own state; `id`, `members` and `groups` are `undefined` until a server answers; `ended` after `destroy()` | the one sync read, `.value`, where it is sure. No `get()` there: the value is already here |
| `ctx.rows` | `await ctx.at.get()`, local at a path's leader; at the root, `await ctx.data[k].get()` | right on any server, with no trip where the rows are held |
| (not taken) | `.value` on a lens; an `f.value` of every row with `hold: 'all'` | a property on a lens is a step: `lens.value` is the row or field named `value`. `f.value` would need a new role in the types and a rule for `hold` on a server, for what the handle already gives |

**Transformations** (V5-14).

| Gone | Now | Decision, and why |
|---|---|---|
| `views.client` per client and `views.max` 1,000 per resource | a cost-weighted cap of 64 served views per copy, 16 per client per copy, headroom `views.max / k` with k ≥ 2 serving copies and none with one; `views.rows` for buckets | pick 2 (superseding V5-12 pick 5's cap) |
| a served view on whichever server took the SUB | one copy, chosen by a hash over every copy but the leader | pick 3; standbys first refused a held view in 377 of 1,000 seeds |
| (none) | `{ pages }`, a third kind of method: one shared index, a page read that holds nothing | pick 4 |
| (none) | ordered views over more than 5,000 rows and pages over more than 2,000 refused until data 5's ordered index | pick 1 |
| `derive(source, target, fn)` only | also the view form, `derive(view, target)`, with the bump, the read barrier and the code version in the lock row, over a string or number bucket | pick 5; as first planned it failed 514 of 1,000 seeds |
| the operators of data today (`top`, ties by arrival, float sums) | data 5's merge contract; new `eq`, `in`, `by`; range filters on numbers; `top` gone (write `za(field, n)`); bucket answers as a `Map` with typed keys | picks 6, 7 |
| (none) | `lookup`, the one join, with three states | the frame |
| (none) | `c.order` on ordered answers; `sync()` on a held served view; a method's `version` and `allow` | TRANSFORMS 3.8 |

**Paths** (V5-15).

| Gone | Now | Decision, and why |
|---|---|---|
| no rule for when a reader below a write hears of it | data's rule for every state form | pick 1 |
| `changes()` reads the records "under the lens"; `-N` is "the unit a callback sees" | the records on the lens's path; below a row an entry only when the lens's value changed; `-N` counts commits whose records reached the lens. API.md question 19 closes | pick 2; "under" missed 74 % and 78 % of the changes below a row (E-58) |
| "a write needs a row": the root and a room refused `bad-path` | `room.set(rows)` and `room.remove()`, the only room writes; the root still refused, and the type error names the way | pick 3 |
| one version per row, unstated; `set(fn)` "no new rule at the leader" | said plainly; on a field lens `if: { equals }`, `absent` and `present` test the field, also inside `set(fn)`; the leader compares a field's value | pick 5 (an amendment to 3.7) |
| `absent-path` only; shapes `data` fills in | `bad-shape` (new); `bad-key` for `__proto__`, at `at()` too | pick 6 |
| `ttl` and `while` compiled on a field write | refused | pick 7 |
| a diff entry without its room; a depth-2 commit not cut; `c.recs()` as data's merged row; `op.merge` as the whole row | `partition` on every entry; commits cut to the link's rows; `c.recs()` from the log's bytes; `op.merge` as one field record per key | pick 7 |
| the record form sees records only (V5-14 pick 8) | the record form with rows, `{ rows: true }`, in the first build, with a dev warning | pick 4 |

- **What a user no longer has to know:** `here`, `tap`, the weak `connect` and its rule, `scope`, `closes`, `asOf` and its `seek` and `close`, `f.methods`, `f.snapshot`, `c.changes`, `c.now`, and "fero's names win"; since V5-16, `f.rows`, `ctx.rows` and `snapshot()` on the cluster.
- **What a user learns instead:** seven read rules (section 2; V5-13's consequences) and ten for transformations (3.10; V5-14's). Paths bring data's rule and the shape rule (V5-15 picks 1 and 6), which the types cannot show and no record counts as user rules.
- **The price in rules** (reasoned, SIMPLICITY's measure): the read surface about 0 to +16 over READS.md's pick (V5-13; READS put its pick at +10 to +25 on 416, so +10 to +41 in all); transformations about +26 (21 to 45) for the first build (V5-14); the "on the path" reader for the log below a row, and the room write, the shape rule and the field guard, not counted together yet (V5-15's consequences name the reader and the field `-N`); V5-16 about −1 to +1, in L4 (LAYERS 5.4; reasoned). V5-17 brings the `past` reader's +3 into the first build (LAYERS 0.2).
- **data changes for it, in TypeScript, none in Rust** (V5-14 pick 6): data 5.0.0, a large major version: D1 and D2 first, then the merge contract (C1 to C10), the new operators (N1 to N5), D3, D4, D6 to D9 (TRANSFORMS 9.1). data's five path-rule holes are listed in STATUS for its owner; fero needs none of them fixed if its leader refuses those shapes first (V5-15).

### 5.7 From the 2026-11-20 page, for V5-17

The owner answered section 11.1's questions on 2026-11-21 ([V5-17][dec]). Most kept this page's pick, and the page now cites V5-17 for each. Four went the other way, and they change the API:

| The 2026-11-20 page | Now | Question |
|---|---|---|
| a service's answer function that throws: the ask rejects `threw` at once, and no other worker runs the request | the request goes back to be taken again, as a queue job does; it ends when the asker's timeout runs out, and the asker gets `timeout`. After `deliveries` tries, 5 by default, the ask rejects `threw` (*this page's reading*, question 41) | 38 |
| `past` after the first build | `past` in the first build, with the other three read verbs: about +3 rules (LAYERS 0.2) | 22 |
| `bad-arg` for a `ttl` or `while` on a field write; `too-large` for a room write past the size rule | `field-ttl` and `room-too-large`, codes of their own | 33 |
| `f.cluster.value.open` | `f.cluster.value.links` | 26 |

- **The answers that kept this page's pick** are listed in section 11.1, each with its question. Where the page said *this page's pick* or *this page's reading* for one of them, it now says V5-17.
- **Question 28 stays open** until the audit of what one group per resource assumes ([GROUPS.md](GROUPS.md)) reports. That audit has reported, and [V5-18][dec] now has question 28 wait for the study of how work over every row is merged across groups, and of its alternatives (MERGE.md, in progress). Question 41 is new.

## 6. The declarations

What every code block on this page compiles against. They merge three type sketches into one self-contained file: [CONNECT.md](CONNECT.md)'s read surface (section 11), [TRANSFORMS.md](TRANSFORMS.md)'s operators, served views and `derive` (section 12), and [ANYPATH.md](ANYPATH.md)'s writes at any path (section 8), on top of the 2026-11-18 page's writes, stages, methods, options, errors and libraries.

**Against the 2026-11-18 page's `fero.d.ts`.**
- **New, for reads:** `Reads`, `PastRead`, `Link`, `Live`, `Held`, `Diff`, `Commit` with `version` and `order`, `Turn`, `Change` with `partition` and `version`, `LinkOpts`, `Closes`, `Past` as a value, `Changes` and `FieldEntry`; positions (`Place`, `Pos`, a count back as a negative literal); a stream's lenses (`Stream`, `LogLens`).
- **New, for transformations:** the operators of data 5 (`eq`, `in`, `by` with `Grouped`, numbers-only range filters, windows and pages, `CodeOps`, `lookup` with `Joined`); served views and pages (`ViewDef`, `PagesDef`, `ViewCtx`, `CheckViews`, `Served`, `ServedLive` with `sync()`, `Paged`, `Page`, `After`); `derive`'s view form and its record form with rows.
- **New, for writes and the rest:** room writes (`PartWrites`, `NewRows`); field options without `ttl` and `while` (`FieldOpts`); the name rule (`NoClash`); `ctx.signal`, `Lock.signal`, `ClusterShape.links` (named `open` until V5-17), `Role`'s `'all'`; `ResourceOptions`' timing keys (`skew`, `lag`, `catchup`); and the codes the decisions add.
- **Gone:** `Held`'s `rows`, `View`, `Value`, `Sel`, `LocalOps`, `Link.close`, `Commit.changes` and `now`, `tap`, `here`, `asOf`, `seek`, `scope`, `Scope`, `ConnectOpts` and its `closes`, `Position`, `f.methods` (`RootCalls` moved onto the root lens), `f.snapshot`, the operator `top`, and the code `no-method` (now `no-such-method`).
- **V5-16, the same day.** New: `ClusterView.value` and `WritesView.value`; `connect((value) => …, { signal, until })` on both; `ClusterShape`'s `id`, `members` and `groups` typed `| undefined` until a server answers. Gone: `Handle.rows` (`f.rows`), `Ctx.rows`, `ClusterView.snapshot` and `WritesView.snapshot`. After its two reviews: every field of `ClusterShape`, `HealthRow` and `WriteRow` is read-only, as a frozen value is; `hold` is in a client's open only (`ClientOpen`), not in a server's; and a stream (`rows: false`) has `cluster` too.
- **V5-17, 2026-11-21.** `ClusterShape.open` is now `ClusterShape.links`. `Code` gains `field-ttl` and `room-too-large`. `service()` takes `deliveries`. Comments give the defaults of `LockOpts.renew` and of `consumer()`'s options, the unit of `Runner.lag`, what a refused `saga()` gives and that its steps may span resources, and that a service's `deliveries` is a setting of its resource.

**How the types know a role.** `Resource<Row, M, D, R>` carries the row type, the methods, the depth and what the types know of the role: `'server'`, `'client'` (a bare client, which holds what its links name) or `'all'` (a client that said `hold: 'all'`). A server marker in the open makes `'server'` (section 3.1). `fero<Shop>(name)` turns a server's type into `'client'`, or `'all'` with `{ hold: 'all' }`. A client of a resource with methods has no writes on its lenses, rooms or root (V4-5). A bare client has no operators over every row. No role has a sync lookup of every row (V5-16): `f.data.connect()` gives a handle on every role. A handle typed by its rows only (`fero<Row>(name)`) has no methods in its type, so it may write, and calls through `call()` are untyped.

**Where the types are weaker than the text** (stated, not fixed):
- `f.set(path, v)` checks a whole row's value; a field's value (a longer path) is not checked, and neither is a value under `f.at(…)` past the row.
- A depth-2 seed does not give the row type: name it, `fero<Msg, 2>` or `fero.of<Msg, 2>()`. The depth type argument is not tied to the founding `depth`; a later open that disagrees with the stored depth is refused `config-differs`.
- The role is known from the open's markers and from `fero<Shop>`. A server marker given through the config cascade, not the call, is not seen by the types.
- `ctx.at` of a method declared `at: 'any'` is untyped: it may be any kind of lens.
- `ClusterShape`'s `id`, `members` and `groups` are `| undefined` on every role, though a server that holds a copy has them: `ClusterView` does not carry the role, and a spare may not have them yet.
- The types cannot tell a spare server from a copy (section 3.3): a spare's root operators compile as a copy's do, and first download the resource.
- `session.ms` is `#sessions`' own setting (section 9), not a key of an app's resource, so no type carries it: an app sets it through the cascade (`fero.opt.ts`, `FERO_SESSION_MS`).
- At `depth: 2` the root has no operators in the types, on any role, and `f.data.connect()` gives a handle with none: a name on that root is a room (section 3.10; question 28). The text's root operators on a server, with `hold: 'all'` and in `ctx.data` hold at depth 1 only.
- A saga `Step`'s value is not checked against its lens's type.
- `mark` and `claim` are hidden only from a typed client of a resource with methods; elsewhere the server refuses a client's with `methods-only`.
- A `batch` item's whole-row value may carry an extra field: TypeScript also checks the item against the field form.
- The operator types are a hand-written copy of data's; a real build generates them from data 5's exported contract (TRANSFORMS 2, row 8). The cost classes the cap weighs by are data 5's, and are guesses until then.
- A bucket view's `c.diff` is typed as row changes; a whole-resource view's keys at depth 2 in `c.order` are not typed by depth (TRANSFORMS 12).
- The probe names, the linger, the caps, `rules.write`'s effect on early stages, and section 7's rules are not in the types.
- The libraries keep their shape.

```ts
// file: fero.d.ts — fero v5's public API for the chosen design (V5-1 to V5-16). Declarations only.
//   lens.get(opts?)              read once; hold nothing. One GET, or no trip where the rows are held on purpose
//   lens.connect(opts?)          the newest state, kept here: a handle (value, ready, cursor, closed, disconnect), and a loop
//   lens.connect(fn, opts?)      the same, plus fn(value, c) on the picture and once per commit. Not a loop
//   lens.changes(opts?)          the log: every record on the lens's path from a place, then live. It waits for you
//   lens.past(pos, opts?)        one partition as it was: folded here once, then a value with step(n) and for..of
//   { signal }, { until }        how a live thing ends, beside disconnect() and break. Never by the collector
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
/** A record's place in its partition's log, as short text that keeps log order under plain `<`, such as '38S9'.
 *  A commit's id is the version of its last record there. The same text in ack.version, c.version, a diff entry,
 *  a log entry, if: { version } and a lock token. One version per row: its last write's. It does not say which
 *  partition it belongs to. */
export type Version = string & { readonly __fero: 'version' }
/** A reader's place: the resource's id, then one (epoch, sequence) per slot it reads. Save it to resume. */
export type Cursor = string & { readonly __fero: 'cursor' }
export type AttemptId = string & { readonly __fero: 'attempt' }
export type Time = number
/** 1 (default): `f.data.k` is a row and its own partition. 2: `f.data.p.k` is a row, `p` its partition. */
export type Depth = 1 | 2
/** What the types know of a handle: a server, a bare client (it holds what its links name), or a client that
 *  said hold: 'all'. A handle typed by its rows only, with no role marker, is a bare client. */
export type Role = 'server' | 'client' | 'all'
/** The rows of a resource as a tree: depth 1 `{ row }`, depth 2 `{ partition: { row } }`. */
export type Tree<Row, D extends Depth> = D extends 2 ? Record<Key, Record<Key, Row>> : Record<Key, Row>
/** What eq, in and by compare: a value with its type (1 and '1' differ), by SameValueZero. */
export type Scalar = string | number | boolean | null
/** A compile error that names the line to write instead. */
export interface Steer<Msg extends string> { readonly 'fero: write this instead': Msg }

// ── positions (V5-13 pick 4) ─────────────────────────────────────────────
/** A place every lens takes: after a cursor; a writer time, as a Date (approximate across partitions);
 *  all that is kept; or now. */
export type Place = Cursor | Date | 'earliest' | 'latest'
/** Inside one partition also a commit (a Version) and a count back (-5). On the root neither has one meaning. */
export type Pos<O extends boolean> = Place | (O extends true ? Version | number
  : Steer<'a version or a count back names one partition: on the root give a cursor or a time, new Date(...)'>)
/** A count back is a negative literal: the commits whose records reached this lens. A value typed number (most
 *  often a time) or a positive number is refused: a time is a Date. A const that holds -5 has the type -5: fine. */
type Back<P> = P extends number
  ? (number extends P ? Steer<'a time is a Date; a count back is a literal such as -5'>
    : `${P}` extends `-${string}` ? P : Steer<'a count back is negative: -5 is 5 commits back'>)
  : P
type BackOpt<P, K extends string> = [Extract<P, number>] extends [never] ? {} : { readonly [k in K]?: Back<P> }

// ── fero(name, opts) ─────────────────────────────────────────────────────
type AnyResource = { readonly name: string; readonly data: unknown; destroy(): Promise<boolean> }
/** A server's handle seen from a client: the same rows and methods, another role. */
export type ClientOf<S, H extends 'client' | 'all'> =
  S extends { readonly [keepsNoRows]: { row: infer Row; depth: infer D extends Depth } } ? Stream<Row, D, H>
  : S extends { readonly [typesOf]?: { row: infer Row; methods: infer M; depth: infer D extends Depth } } ? Resource<Row, M, D, H> : never
/** What makes a process a server of this resource (section 3.1): it brings something. */
type ServerMark<Row, D extends Depth> =
  | { server: true } | { data: D extends 2 ? Record<Key, Record<Key, NoInfer<Row>>> : Record<Key, Row> }
  | { listen: string | false } | { dir: string | false } | { load: ResourceOptions<Row>['load'] }
  | { validation: ResourceOptions<Row>['validation'] } | { schema: Schema<Row> } | { rules: ResourceOptions<Row>['rules'] }
/** Open a resource. The typed forms:
 *  - `fero<Shop>(name)`, with `export type Shop = typeof shop` on the server: a client typed by the server.
 *    When the server has methods, this client changes data only through them (V4-5). `{ hold: 'all' }` holds every row.
 *  - a seed and methods, `fero(name, { data, methods })`, or `fero.of<Row>()(name, { methods })`: a server.
 *  - `fero<Row>(name, { server: true })` and the other server markers: a server typed by its rows.
 *  - `fero<Row>(name)` or `fero<Row, 2>(name)`: a bare client typed by its rows; its calls go through call().
 *  `fero<Row>(name, { methods })` does not compile: it would leave the methods untyped. */
export declare function fero<S extends AnyResource = Resource<any, {}, 1, 'all'>>(name: string, opts: ProcessOptions & ClientOpen & { hold: 'all' }): Promise<ClientOf<S, 'all'>>
export declare function fero<S extends AnyResource = Resource<any, {}, 1, 'client'>>(name: string, opts?: ProcessOptions & ClientOpen): Promise<ClientOf<S, 'client'>>
export declare function fero<Row, M extends Methods<Row, D>, D extends Depth = 1>(
  name: string,
  opts: Options<Row, M, D> & { methods: M & NoInfer<NoClash<M, D>> & NoInfer<CheckViews<M, Row>> },
): Promise<Resource<Row, M, D, 'server'>>
/** A resource that keeps no rows: a stream. Its lenses publish with set() and read the log with changes(). */
export declare function fero<Row = any, D extends Depth = 1>(name: string, opts: Options<Row, {}, D> & { server: true; rows: false; methods?: never }): Promise<Stream<Row, D, 'server'>>
export declare function fero<Row = any, D extends Depth = 1>(name: string, opts: Options<Row, {}, D> & ServerMark<Row, D> & { methods?: never }): Promise<Resource<Row, {}, D, 'server'>>
export declare function fero<Row = any, D extends Depth = 1>(name: string, opts: ProcessOptions & ClientOpen & { hold: 'all' }): Promise<Resource<Row, {}, D, 'all'>>
export declare function fero<Row = any, D extends Depth = 1>(name: string, opts?: ProcessOptions & ClientOpen): Promise<Resource<Row, {}, D, 'client'>>
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
  linger?: { ms?: number }      // how long a selection no link uses stays subscribed (section 3.10)
  redial?: { ms?: number; tries?: number }
  leave?: { ms?: number }
  journal?: { cap?: number }
  diag?: { allow?: Record<string, string> }
  connect?: { wait?: Duration }
  shuffle?: boolean | number
}
/** What a client's open may carry: no server marker. `hold` is a client's key only: a server's open does not take it.
 *  A client holds what its live links name (the default). 'all': every row, kept live: the open sends the
 *  whole resource once, then every write. A size: a cache of pictures of closed selections, never read from. */
type ClientOpen = Omit<ProcessOptions, 'listen' | 'dir'> & { server?: false; hold?: 'all' | Size; signals?: boolean; bind?: OpenOptions['bind'] }

/** Remembered by the resource's own log (V5-2). The founding open writes them; fero.alter changes some. */
export interface ResourceOptions<Row = any, M = {}, D extends Depth = 1> {
  /** Where a row begins. The first key is always the partition. Fixed at founding. */
  depth?: D
  /** Built later (V5-12 pick 4): a function of the row key, for partitions a key level cannot say. */
  partition?: (key: Key) => Partition
  history?: History
  rows?: boolean | RowsRule<Row>
  copies?: 1 | 3 | 5            // the copies whose disks decide a commit
  standbys?: number             // more full copies that do not vote
  election?: { ms?: number; jitter?: number }
  /** Timing keys every copy must agree on (section 9; LAYERS 5.3): writer-time skew in ms; lag and catch-up in records. */
  skew?: { max?: number }; lag?: { max?: number }; catchup?: { max?: number }
  /** Served views (section 3.10): per client per copy, per copy (weighted by cost), buckets per view, shapes. */
  views?: { client?: number; max?: number; rows?: number; shapes?: number }
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
  signals?: boolean
  bind?: 'live' | 'sim' | `tape:${string}` | `./${string}`
}

// ── the resource ─────────────────────────────────────────────────────────
/** A handle. `data` is the address of everything, root methods included. Its one sync read is a live handle's
 *  value: `f.data.connect()` for every row (V5-16). */
export type Resource<Row = any, M = {}, D extends Depth = 1, R extends Role = Role> =
  Handle<Row, M, D, R> & (Door<M, R> extends true ? {} : RootWrites<Row, D>)
declare const typesOf: unique symbol
export interface Handle<Row, M, D extends Depth, R extends Role> {
  /** A phantom: the row type, the methods and the depth, for ClientOf. */
  readonly [typesOf]?: { row: Row; methods: M; depth: D }
  readonly name: string
  /** The root lens: the address of everything. Root methods are called on it: `f.data.low(5)`. */
  readonly data: Lens<Tree<Row, D>, Row, M, 'root', D, R>
  /** The same address as f.data.a.b, with no Proxy: keys from input, keys named like fero words, hot loops. */
  readonly at: AtFn<Row, M, 'root', D, R>
  /** A reader name's marks, as a cursor for changes({ from }). */
  marks(name: string): Promise<Cursor>
  /** This resource's members, groups, health, writes in flight, and the links this process has open: a live
   *  link the open holds for you. `f.cluster.value` is a sync read of it (V5-16). */
  readonly cluster: ClusterView
  destroy(): Promise<boolean>
}
/** V4-5: the typed client of a resource with methods changes data only through them. */
export type Door<M, R extends Role> = [R] extends ['server'] ? false : keyof M extends never ? false : true
/** The array form of every write, with `mark` and `claim`. No Proxy. `ctx.set`, `batch` items and libraries
 *  use it. A client typed by a server that has methods has none of these (V4-5). */
export interface RootWrites<Row, D extends Depth> {
  set(path: RowPath<D>, value: Op, opts?: UnmarkedOpts | MarkOpts): Judged
  set(path: RowPath<D>, fn: (row: Row | undefined) => Row | undefined, opts?: Omit<WriteOpts, 'if'>): Judged<Ack | undefined>
  set(path: RowPath<D>, value: Row, opts?: PlainOpts): Write
  set(path: RowPath<D>, value: Row, opts: JudgedOpts | MarkOpts): Judged
  set(path: FieldPath<D>, value: unknown, opts?: FieldOpts | FieldMarkOpts): Judged   // a field: its value is not checked
  remove(path: RowPath<D>, opts: JudgedOpts | MarkOpts): Judged
  remove(path: RowPath<D>, opts?: PlainOpts): Write
  remove(path: FieldPath<D>, opts?: FieldOpts | FieldMarkOpts): Judged
  touch(path: RowPath<D>, opts?: TouchOpts): Judged
  /** A bare mark: source record `e` is applied, and nothing is written. A write to this resource's marks. */
  mark(e: Entry<any>): Judged
  /** For libraries: the leader leases the first takeable rows of a partition to the caller. */
  claim(opts: ClaimOpts<Row>): Promise<Claimed<Row>[]>
  /** Several changes to ONE partition: one log entry, all or none. Not needed for speed. A room is
   *  written with room.set(rows) and room.remove(), never by a batch item at the room's key. */
  batch(writes: readonly BatchWrite<Row, D>[], opts?: { once?: string; timeout?: Duration }): Judged<Ack[]>
}
/** A row's path: `[row]`, or `[partition, row]` at depth 2. A field's path goes on below the row. */
export type RowPath<D extends Depth> = D extends 2 ? readonly [Key | number, Key | number] : readonly [Key | number]
export type FieldPath<D extends Depth> = D extends 2
  ? readonly [Key | number, Key | number, string | number, ...(string | number)[]]
  : readonly [Key | number, string | number, ...(string | number)[]]
export type Rows<Row> = { readonly [key: string]: Row | undefined }
/** The rows given to room.set: every value a row, never undefined. */
export type NewRows<Row> = { readonly [key: string]: Row }
export type RowsOf<Row, D extends Depth> = D extends 2 ? { readonly [part: string]: Rows<Row> | undefined } : Rows<Row>
export type BatchWrite<Row = any, D extends Depth = 1> =
  | { key: RowPath<D>; value?: Row | Op; remove?: true; if?: Cond; ttl?: Duration }                    // a whole row: checked
  | { key: FieldPath<D>; value?: unknown; remove?: true; if?: Cond; readonly ttl?: Steer<OnRow> }    // a field: not checked
export interface ClaimOpts<Row> { partition: Partition; n?: number; lease: Duration; due?: keyof Row & string }
export interface Claimed<Row> { key: Key; value: Row; token: Version; until: Time; deliveries: number }

/** A resource opened with rows: false: a stream. You publish with set(); you read its log with changes(). */
declare const keepsNoRows: unique symbol
export interface Stream<Row = any, D extends Depth = 1, R extends Role = Role> {
  readonly [keepsNoRows]: { row: Row; depth: D; role: R }
  readonly name: string
  readonly data: LogLens<Row, 'root', D>
  readonly at: (...keys: (Key | number)[]) => LogLens<Row, 'row', D>
  marks(name: string): Promise<Cursor>
  /** As a Resource's: members, groups, health, writes in flight and open links. */
  readonly cluster: ClusterView
  destroy(): Promise<boolean>
}
type NoRows = 'this resource keeps no rows (rows: false): read its log with changes()'
/** A lens on a stream: steps, the log, and publishing. No state to get, connect or look back on. */
export type LogLens<Row, K extends Kind, D extends Depth> = {
  changes<const F extends Pos<One<K>> = 'latest', const T extends Pos<One<K>> = 'latest'>(opts?: ChangesOpts<F, T>): Changes<Entry<Row>>
  set(value: Row, opts?: PlainOpts): Write
  readonly get: Steer<NoRows>
  readonly connect: Steer<NoRows>
  readonly past: Steer<NoRows>
} & { readonly [key: string]: LogLens<Row, K extends 'root' ? (D extends 2 ? 'part' : 'row') : 'row', D> }

// ── the lens: an address. A property read is a step; a call is a verb ───
/** Where a lens points: the root, a partition (depth 2 only), a row, or below a row. */
export type Kind = 'root' | 'part' | 'row' | 'field'
type Child<K extends Kind, D extends Depth> = K extends 'root' ? (D extends 2 ? 'part' : 'row') : K extends 'part' ? 'row' : 'field'
type IsAny<T> = 0 extends 1 & T ? true : false
/** Is this lens inside one partition? Every lens but the root is (at depth 1 a row is its own partition). */
type One<K extends Kind> = K extends 'root' ? false : true
/** What a read gives: a row or field (undefined when absent), or the rows of a partition or of everything. */
type Val<T, Row, K extends Kind, D extends Depth> = K extends 'row' | 'field' ? T | undefined : K extends 'part' ? Rows<Row> : RowsOf<Row, D>
/** What connect() gives: a collection has operators right of the line; a row or field does not. */
type LiveOf<T, Row, K extends Kind, D extends Depth> =
  K extends 'row' | 'field' ? Live<T | undefined, Row, true> : K extends 'part' ? Held<Rows<Row>, Row, 'rows', true>
  : D extends 2 ? Live<RowsOf<Row, 2>, Row, false> : Held<Rows<Row>, Row, 'rows', false>
/** What the log gives: at a row or wider, the record as written; below a row, also the lens's value after it. */
type EntryOf<T, Row, K extends Kind> = K extends 'field' ? FieldEntry<Row, T | undefined> : Entry<Row>
type Writes<T, Row, K extends Kind, D extends Depth, M, R extends Role> =
  K extends 'root' ? RootSteers
  : Door<M, R> extends true ? {}
  : K extends 'part' ? PartWrites<Row> : K extends 'row' ? RowWrites<T> : FieldWrites<T>
type RootSteers = { readonly set: Steer<NoRoot>; readonly remove: Steer<NoRoot> }
type NoRoot = 'the root spans partitions, which share no order: write each row or room, or empty it all with fero.drop(name)'
declare const rowsOf: unique symbol
/** A phantom on a root lens: which rows it names, and its depth. Lets lookup and derive check types. */
export interface RootOf<Row, D extends Depth = Depth> { readonly [rowsOf]?: { row: Row; depth: D } }

/** A lens: an address. A property read is a step: no trip, no read, nothing kept. A call is a verb on the
 *  path before it. Not a promise: `await lens` gives the lens back (six probe names read undefined; subscribe is refused). */
export type Lens<T, Row, M, K extends Kind, D extends Depth, R extends Role> =
  Reads<Val<T, Row, K, D>, Row, LiveOf<T, Row, K, D>, One<K>, EntryOf<T, Row, K>>
  & (One<K> extends true ? PastRead<Val<T, Row, K, D>, Row>
    : { readonly past: Steer<'past() reads one partition as it was; here it would fold every partition: read the log from a time, changes({ from: new Date(...) })'> })
  & { readonly at: AtFn<Row, M, K, D, R>; readonly call: CallFn<M, K, D> }
  & Writes<T, Row, K, D, M, R>
  & (K extends 'root' ? RootCalls<M, StepOf<Row, M, K, D, R>, D> & RootOps<Row, D, R> & RootOf<Row, D> : K extends 'part' ? Ops<Row, 'left', 'rows', true> : {})
  & PathCalls<M, K, D, StepOf<Row, M, K, D, R>>
  & { readonly subscribe: Steer<'a lens is not a store: lens.connect(fn)'>
      /** `${lens}` and String(lens) give its path, 'shop.widgets.stock': a stable key for a framework. */
      [Symbol.toPrimitive](hint: string): string }
  & Steps<T, Row, M, K, D, R>
type StepOf<Row, M, K extends Kind, D extends Depth, R extends Role> =
  K extends 'root' | 'part' ? Lens<K extends 'root' ? (D extends 2 ? Record<Key, Row> : Row) : Row, Row, M, Child<K, D>, D, R> : unknown
type Probe = 'then' | 'toJSON' | 'constructor' | '$$typeof' | 'asymmetricMatch' | 'nodeType' | 'subscribe'
/** Six probe names read undefined, so a lens is never a promise or JSON (subscribe is a Steer above).
 *  A row so named is reached with f.at('then'). */
type Probes = { readonly [P in Exclude<Probe, 'subscribe'>]: undefined }
type Steps<T, Row, M, K extends Kind, D extends Depth, R extends Role> =
  K extends 'root' | 'part' ? (IsAny<Row> extends true ? { [key: string]: any } : { readonly [key: string]: StepOf<Row, M, K, D, R> } & Probes)
  : IsAny<T> extends true ? { [key: string]: any }
  : T extends readonly (infer E)[] ? { readonly [i: number]: Lens<E, Row, M, 'field', D, R> }
  : T extends object ? { readonly [P in keyof T]-?: Lens<T[P], Row, M, 'field', D, R> }
  : {}
type AtFn<Row, M, K extends Kind, D extends Depth, R extends Role> =
  K extends 'root' ? (D extends 2
    ? { (part: Key | number): Lens<Record<Key, Row>, Row, M, 'part', D, R>
        (part: Key | number, row: Key | number): Lens<Row, Row, M, 'row', D, R>
        (part: Key | number, row: Key | number, ...fields: (string | number)[]): Lens<any, Row, M, 'field', D, R> }
    : { <F extends keyof Row & string>(row: Key | number, field: F): Lens<Row[F], Row, M, 'field', D, R>
        (row: Key | number): Lens<Row, Row, M, 'row', D, R>
        (row: Key | number, ...fields: (string | number)[]): Lens<any, Row, M, 'field', D, R> })
  : K extends 'part'
    ? { (row: Key | number): Lens<Row, Row, M, 'row', D, R>
        (row: Key | number, ...fields: (string | number)[]): Lens<any, Row, M, 'field', D, R> }
  : (...fields: (string | number)[]) => Lens<any, Row, M, 'field', D, R>

// ── reads: get, connect, changes on every lens; past inside one partition (V5-13, V5-15) ──
/** The state forms (get, a link's value and its callback, a loop turn, past(pos).value) follow data's rule: a write
 *  at or below the lens gives a change relative to it; a write above counts only when the lens's value changed
 *  (a new object counts); a write beside it gives nothing. The log forms take the records on the lens's path. */
export interface Reads<V, Row, L, O extends boolean, E> {
  /** Read once, with the row's version (one version per row, inside a field too). */
  get(opts: GetOpts & { version: true }): Promise<{ value: V; version: Version } | undefined>
  /** Read once: here if this process holds the partition on purpose, else one GET. Holds nothing.
   *  With `when`, it holds the partition live until when(value) is true, reads, and lets go. */
  get(opts?: GetOpts & { when?: (value: V) => unknown }): Promise<V>
  /** The newest state, kept here: the picture, then each commit that changed it. Counted, and shared with every
   *  equal lens. The handle is also a loop: `for await (const [value, c] of lens.connect())`, the newest each turn. */
  connect(opts?: LinkOpts): L
  /** connect(), plus fn on the picture and once per commit, a microtask after connect() returns. Not a loop. */
  connect(fn: (value: V, c: Commit<Row, O>) => void, opts?: LinkOpts): Link<V, Row>
  /** The log: the records on this lens's path (at, below, or above it), in order, from a place (default: from this
   *  call), then live. Below a row it gives an entry only when the lens's value changed. It waits for you. */
  changes<const F extends Pos<O> = 'latest', const T extends Pos<O> = 'latest'>(opts?: ChangesOpts<F, T>): Changes<E>
}
/** One partition as it was: a log read from the nearest snapshot, folded here once. A value, not a link. */
export interface PastRead<V, Row> {
  /** value is the state right after pos: after a version's commit, or at a place. for..of walks every commit
   *  changes() would give from pos to `to` (default: pos alone), each as [value, c]. */
  past<const P extends Pos<true>, const T extends Pos<true> = P>(pos: Back<P>, opts?: { to?: T } & BackOpt<T, 'to'>): Promise<Past<V, Row>>
}
export interface GetOpts {
  fresh?: boolean      // ask the leader: one trip plus its round with a majority; no disk
  signal?: AbortSignal
  timeout?: Duration
  readonly at?: Steer<'a read as it was folds the log here, so it has its own word: (await lens.past(pos)).value'>
}
/** How a live link ends, beside disconnect() and break. The collector never ends one. */
export interface LinkOpts {
  /** It ends when this aborts: a request's, a job's, a component's, a handler's (ctx.signal), a lock's. */
  signal?: AbortSignal
  /** It ends when this says it closed: a Node socket, stream or HTTP response, the ws library's socket, a WebSocket.
   *  Never an HTTP request: it may say it closed once its body is read, while the client stays. */
  until?: Closes
  readonly from?: Steer<'connect() is the newest state; every commit from a place is the log: lens.changes({ from }); with state at each step: await lens.past(pos, { to: "latest" })'>
  readonly at?: Steer<'connect() is now; the lens as it was is await lens.past(pos)'>
  readonly once?: Steer<'to read once: await lens.get()'>
}
/** A check of the object's shape, not a promise that it will ever close. */
export type Closes =
  | { once(event: 'close', fn: () => void): unknown; readonly destroyed: boolean; readonly method?: never }   // a Node socket, stream or response
  | { once(event: 'close', fn: () => void): unknown; readonly readyState: number }   // the ws library's WebSocket
  | { close(): void; readonly readyState: number; onclose: unknown }                 // a WebSocket in a browser or Node 22

// ── live handles ─────────────────────────────────────────────────────────
/** One live link. It holds its selection on purpose until disconnect(), its signal, its `until`, or break. */
export interface Link<V, Row = unknown> {
  /** Resolves to this handle once the first picture is here. */
  readonly ready: Promise<this>
  /** The latest committed state, by reference. A row or field is frozen, a value you may keep; a partition is a
   *  live view, readable only while this link is live. Before ready it throws 'not-ready', after the end
   *  'ended': a sync read never guesses. */
  readonly value: V
  /** Where this state is: save it, then pass it to changes({ from }) or past(). Built only when read. */
  readonly cursor: Cursor
  /** Settles when the link ends: resolves on disconnect(), the signal, `until` or break; rejects with why it
   *  failed ('expired', 'too-many-views', a lost lease). Made only when first read; a failure nobody reads
   *  prints one stderr line, never an unhandled rejection. */
  readonly closed: Promise<void>
  /** End the link now. Bound, so a framework effect can return it. Safe twice; it drops the other ends' listeners. */
  readonly disconnect: () => void
}
/** connect() with no function: a link that is also a loop over the newest state. break ends the link. */
export interface Live<V, Row = unknown, O extends boolean = false, Q extends boolean = false> extends Link<V, Row>, AsyncIterable<[value: V, c: Turn<Row, O, Q>]> {
  /** One more call per commit, for this handle's life. */
  connect(fn: (value: V, c: Commit<Row, O, Q>) => void): Link<V, Row>
}
/** One change of rank in an ordered answer: data's order channel, after the row changes of the same commit. */
export type OrderChange =
  | { readonly type: 'insert'; readonly key: Key; readonly at: number }
  | { readonly type: 'remove'; readonly key: Key; readonly at: number }
  | { readonly type: 'move'; readonly key: Key; readonly from: number; readonly to: number }
/** What changed: the second argument of a callback and of a past step; a loop turn has it without recs and text. */
export interface Diff<Row> {
  /** True once: diff is then the picture so far, as adds. */
  readonly first: boolean
  /** One entry per row this commit (or this loop turn) changed. Rows are frozen. */
  readonly diff: readonly Change<Row>[]
  /** The place after this commit: save it to replay from here later. Built only when read. */
  readonly cursor: Cursor
  /** This commit's records, built from the log's bytes, and their JSON text: each built once per commit and
   *  shared. Not on a loop turn. */
  recs(): readonly Rec[]
  text(): string
}
/** Inside one partition a commit also carries its id: the version of its last record there. An ordered answer
 *  also says how ranks changed. A new picture (after a failover or a redeploy) is one commit of differences. */
export type Commit<Row, O extends boolean = false, Q extends boolean = false> = Diff<Row>
  & (O extends true ? { readonly version: Version } : {})
  & (Q extends true ? { readonly order: readonly OrderChange[] } : {})
/** A loop turn: every commit since the last turn, merged to one change per row. Its version and cursor are the
 *  newest commit's. It has no wire records: merged, they would be whole rows made up for this loop. */
export type Turn<Row, O extends boolean = false, Q extends boolean = false> = Omit<Commit<Row, O, Q>, 'recs' | 'text'> & {
  readonly recs: Steer<'a loop turn merges commits: to forward the records, use connect(fn) or changes()'>
  readonly text: Steer<'a loop turn merges commits: to forward the records, use connect(fn) or changes()'>
}
export interface Change<Row> {
  readonly type: 'add' | 'update' | 'remove'
  readonly key: Key
  /** The partition this row is in: its room at depth 2, the row's own key at depth 1 (V5-15 pick 7). */
  readonly partition: Partition
  readonly row: Row | undefined
  readonly prev: Row | undefined
  /** The row's version after this commit: for if: { version } (an undo). */
  readonly version: Version
}

// ── operators: left of connect() plain data, right of it your code ───────
/** left: left of connect() on a lens inside a partition (plain data; a copy may run it later). right: right of
 *  connect(), here, on held rows. server: where this process holds every row (a server, hold: 'all', a handler's
 *  ctx.data): it runs here; a spare server first takes every row, as hold: 'all' does (section 3.3).
 *  view: inside { view } or { pages }: this resource only, and no caller. */
type Mode = 'left' | 'right' | 'server' | 'view'
/** rows: unordered, unbounded. sorted: ordered, unbounded. window: ordered, at most n. page: a window after a cursor.
 *  scalar: one value. buckets: one value per bucket. members: rows per bucket. arrival: this process's arrival order. */
type Bound = 'rows' | 'sorted' | 'window' | 'page' | 'scalar' | 'buckets' | 'members' | 'arrival'
type Bounded = 'window' | 'scalar' | 'buckets'
type Ord = 'sorted' | 'window' | 'page' | 'arrival'
type IsOrdered<B extends Bound> = [B] extends [Ord] ? true : false
/** An ordered answer is an array in rank order. */
type Out<Row, B extends Bound> = [B] extends [Ord] ? readonly Row[] : Rows<Row>
type Res<V, Row, B extends Bound, M extends Mode, O extends boolean> = M extends 'right' ? Held<V, Row, B, O> : Addr<V, Row, B, M, O>
declare const shape: unique symbol
/** An address made of operators: nothing runs until it is read or connected. */
export type Addr<V, Row, B extends Bound, M extends Mode, O extends boolean = false> = AddrReads<V, Row, B, O>
  & { readonly [shape]?: { bound: B; mode: M } }
  & ([B] extends ['rows' | 'sorted'] ? Ops<Row, M, B, O> : {})
interface AddrReads<V, Row, B extends Bound, O extends boolean> {
  get(opts?: GetOpts): Promise<V>
  connect(opts?: LinkOpts): Held<V, Row, B, O>
  connect(fn: (value: V, c: Commit<Row, O, IsOrdered<B>>) => void, opts?: LinkOpts): Link<V, Row>
}
/** A held selection or view, here. Row-shaped ones take operators right of the line. */
export type Held<V, Row, B extends Bound, O extends boolean = false> =
  Live<V, Row, O, IsOrdered<B>> & ([B] extends ['rows' | Ord] ? Ops<Row, 'right', B, O> : {})
/** Plain data: values only; an answer that depends on the rows only. May stand left of connect(). */
interface Plain<Row, M extends Mode, O extends boolean> {
  eq<K extends ScalarF<Row>>(field: K, v: Row[K] & Scalar): Res<Rows<Row>, Row, 'rows', M, O>
  in<K extends ScalarF<Row>>(field: K, vs: readonly (Row[K] & Scalar)[]): Res<Rows<Row>, Row, 'rows', M, O>
  /** Range filters under one numeric projection: a number field, number bounds. */
  gt(field: NumF<Row>, v: number): Res<Rows<Row>, Row, 'rows', M, O>
  gte(field: NumF<Row>, v: number): Res<Rows<Row>, Row, 'rows', M, O>
  lt(field: NumF<Row>, v: number): Res<Rows<Row>, Row, 'rows', M, O>
  lte(field: NumF<Row>, v: number): Res<Rows<Row>, Row, 'rows', M, O>
  between(field: NumF<Row>, bounds: readonly [number, number]): Res<Rows<Row>, Row, 'rows', M, O>
  /** Sorted by the field under one total order per direction; ties by row key. With n: a window. With after: a page. */
  za(field: F<Row>): Res<readonly Row[], Row, 'sorted', M, O>
  za(field: F<Row>, n: number, opts: { after: After }): Res<readonly Row[], Row, 'page', M, O>
  za(field: F<Row>, n: number): Res<readonly Row[], Row, 'window', M, O>
  az(field: F<Row>): Res<readonly Row[], Row, 'sorted', M, O>
  az(field: F<Row>, n: number, opts: { after: After }): Res<readonly Row[], Row, 'page', M, O>
  az(field: F<Row>, n: number): Res<readonly Row[], Row, 'window', M, O>
  /** Buckets by a field's value, or by a numeric step of it (a time bucket), then one aggregate per bucket.
   *  The answer is a Map keyed by the typed value: 1 and '1' are two buckets. */
  by<K extends ScalarF<Row>>(field: K, opts?: { step?: number }): Grouped<Row, M, Row[K] & Scalar, O>
  /** The member rows of each bucket: as big as the rows. */
  group(field: ScalarF<Row>): Res<{ readonly [bucket: string]: Rows<Row> }, Row, 'members', M, O>
  distinct(field: ScalarF<Row>): Res<readonly Scalar[], Row, 'members', M, O>
  length(): Res<number, Row, 'scalar', M, O>
  /** Exact sums over the numbers only. No numbers: undefined for avg, min, max, median. */
  sum(field: NumF<Row>): Res<number, Row, 'scalar', M, O>
  avg(field: NumF<Row>): Res<number | undefined, Row, 'scalar', M, O>
  min(field: NumF<Row>): Res<number | undefined, Row, 'scalar', M, O>
  max(field: NumF<Row>): Res<number | undefined, Row, 'scalar', M, O>
  median(field: NumF<Row>): Res<number | undefined, Row, 'scalar', M, O>
}
interface Grouped<Row, M extends Mode, V, O extends boolean> {
  length(): Res<ReadonlyMap<V, number>, Row, 'buckets', M, O>
  sum(field: NumF<Row>): Res<ReadonlyMap<V, number>, Row, 'buckets', M, O>
  avg(field: NumF<Row>): Res<ReadonlyMap<V, number>, Row, 'buckets', M, O>
  min(field: NumF<Row>): Res<ReadonlyMap<V, number>, Row, 'buckets', M, O>
  max(field: NumF<Row>): Res<ReadonlyMap<V, number>, Row, 'buckets', M, O>
}
/** Code and arrival order: right of connect(), or where this process holds every row. An ordered answer stays ordered. */
interface CodeOps<Row, M extends Mode, B extends Bound, O extends boolean> {
  filter(fn: (row: Row, key: Key) => unknown): Res<Out<Row, B>, Row, [B] extends [Ord] ? B : 'rows', M, O>
  map<U>(fn: (row: Row, key: Key) => U): Res<Out<U, B>, U, [B] extends [Ord] ? B : 'rows', M, O>
  /** Over a sorted parent, the first n by its order: a window. Over unordered rows, arrival order. */
  limit(n: number): Res<readonly Row[], Row, [B] extends ['sorted'] ? 'window' : 'arrival', M, O>
  reverse(): Res<readonly Row[], Row, [B] extends ['sorted'] ? 'sorted' : 'arrival', M, O>
  byFn(fn: (row: Row, key: Key) => Scalar): Grouped<Row, M, Scalar, O>
}
/** For each row, the row of `other` whose key is row[field], kept live: a row, null for none, undefined while loading. */
interface Join<Row, M extends Mode, O extends boolean> {
  lookup<X, XD extends Depth, K extends ScalarF<Row>>(other: RootOf<X, XD>, field: K): Res<Rows<Joined<Row, X, XD>>, Joined<Row, X, XD>, 'rows', M, O>
}
export type Joined<Row, X, D extends Depth> = { readonly row: Row; readonly other: (D extends 2 ? Rows<X> : X) | null | undefined }
interface LeftSteers {
  readonly filter: Steer<'a function cannot run on a server: connect() first, then filter right of it'>
  readonly map: Steer<'a function cannot run on a server: connect() first, then map right of it'>
  readonly limit: Steer<'left of connect() a window is za(field, n); limit right of connect() is this process\'s own'>
  readonly reverse: Steer<'left of connect() write az or za; reverse right of connect() is this process\'s own'>
  readonly byFn: Steer<'a function cannot run on a server: by(field) here, or byFn right of connect()'>
  readonly lookup: Steer<'a lookup holds another resource\'s rows here: connect() first, then lookup right of it'>
}
interface ViewSteers {
  readonly lookup: Steer<'a served view reads one resource, so its positions cover one: join in a handler, or derive the joined rows into a resource'>
}
type Ops<Row, M extends Mode, B extends Bound, O extends boolean> =
  M extends 'left' ? Plain<Row, 'left', O> & LeftSteers
  : M extends 'view' ? Plain<Row, 'view', O> & CodeOps<Row, 'view', B, O> & ViewSteers
  : Plain<Row, M, O> & CodeOps<Row, M, B, O> & Join<Row, M, O>
type F<Row> = keyof Row & string
/** Fields whose values are numbers: sum, avg, the range filters take only these. */
type NumF<Row> = { [K in F<Row>]-?: NonNullable<Row[K]> extends number ? K : never }[F<Row>]
/** Fields whose values are scalars: eq, in, by and group take only these. */
type ScalarF<Row> = { [K in F<Row>]-?: NonNullable<Row[K]> extends Scalar ? K : never }[F<Row>]
/** A page cursor: the last row's sort value and its key; over every row at depth 2, (value, partition, row). */
export type After<D extends Depth = 1> = D extends 2 ? readonly [value: Scalar, partition: Key, row: Key] : readonly [value: Scalar, key: Key]
/** The root of a bare client: an operator over every row would be work on every write at a server. */
type RootOps<Row, D extends Depth, R extends Role> =
  [R] extends ['client'] ? { readonly [N in keyof Plain<Row, 'left', false>]: Steer<'an operator over every row, on a client: call a view the server named, f.data.<view>(arg)'> }
  : D extends 2 ? {} : Ops<Row, 'server', 'rows', false>

// ── the log, and the past ────────────────────────────────────────────────
export type ChangesOpts<F, T> = LogOpts<F, T> & BackOpt<F, 'from'> & BackOpt<T, 'to'>
export interface LogOpts<F, T> {
  /** 'latest' (default): from this call on. 'earliest': all that is kept. A cursor: after it. A Date: from the
   *  first batch after that writer time. Inside one partition also a version (at its commit, which comes again)
   *  or a count back, -5 (the 5th last commit whose records reached this lens, and what follows). Or marks(name). */
  from?: F | Promise<Cursor>
  /** Stop after this place or commit. 'latest': what was newest when the reader opened. */
  to?: T
  /** Bytes in flight to this reader (1 MB by default). */
  credit?: Size
  signal?: AbortSignal
  until?: Closes
}
export interface Changes<E> extends AsyncIterable<E> {
  /** Where this reader is, after the last entry it gave: save it, pass it back as `from`. */
  readonly cursor: Cursor
  readonly closed: Promise<void>
  readonly disconnect: () => void
}
/** One log record. No prev and no folded state: the log is every record, not a state. */
export interface Entry<Row> {
  /** The record itself, as written, shared with every other reader: never copied. */
  readonly rec: Rec
  /** What the record wrote, when it wrote a whole row. Undefined for a field write and a remove. Not the row now. */
  readonly value?: Row
  readonly partition: Partition
  readonly version: Version
  /** The writer time of its batch, in ms. As a position: new Date(e.time). */
  readonly time: Time
  /** The resource it came from. */
  readonly source: string
  /** Set on a remove fero made, not the app: the rows rule that dropped the row (ttl, max, where, session), or fero.erase. */
  readonly reason?: 'ttl' | 'max' | 'where' | 'session' | 'erased'
}
/** An entry on a lens below a row: a record on its path that changed the lens's value. The reader keeps that
 *  value, so the entry carries it: `value` is the lens's value right after the record (undefined: gone). */
export interface FieldEntry<Row, V> extends Omit<Entry<Row>, 'value'> { readonly value: V }
/** One partition as it was: a value that never changes. It keeps no link, so it needs no end; its memory goes when
 *  you drop every value of its window. */
export interface Past<V, Row> extends Iterable<[value: V, c: Commit<Row, true>]> {
  /** The state here: right after a version's commit, or at a place. */
  readonly value: V
  /** The commit that made that state (its id), and the place right after it. */
  readonly version: Version
  readonly cursor: Cursor
  /** The state n commits back (-) or forward (+), as a new value sharing this window; undefined past the window's
   *  edge. It never changes this one. */
  step(n: number): Past<V, Row> | undefined
}

// ── writes ───────────────────────────────────────────────────────────────
export interface WriteOpts {
  /** `version` is the row's. On a field lens, `equals`, `absent` and `present` test that field (V5-15 pick 5). */
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
 *  and the reader `e` came from stops yielding until the line is short again. It takes no `once` name. */
export type MarkOpts = Omit<WriteOpts, 'once'> & { from: Entry<any>; once?: undefined }
type OnRow = 'a ttl and a lease belong to a row: give them on the row lens, f.data.k.set(row, { ttl })'
/** A field write's options: no ttl and no while, which are a row's (V5-15 pick 7). */
export type FieldOpts = Omit<WriteOpts, 'ttl' | 'while'> & { from?: undefined; readonly ttl?: Steer<OnRow>; readonly while?: Steer<OnRow> }
export type FieldMarkOpts = Omit<FieldOpts, 'from' | 'once'> & { from: Entry<any>; once?: undefined }
export interface TouchOpts { ttl?: Duration; lease?: Duration; if?: Cond; once?: string; timeout?: Duration }
/** The writes on a row lens. Only a plain whole-row write reports early stages (V5-11). */
export interface RowWrites<T> {
  set(value: Op, opts?: UnmarkedOpts | MarkOpts): Judged
  /** Read, decide, write: `fn` gets the row, returns the next one (undefined: write nothing).
   *  Written if the row's version is unchanged since the read; on a conflict it reads again and calls `fn` again. */
  set(fn: (now: T | undefined) => T | undefined, opts?: Omit<WriteOpts, 'if'>): Judged<Ack | undefined>
  set(value: T, opts?: PlainOpts): Write
  set(value: T, opts: JudgedOpts | MarkOpts): Judged
  remove(opts: JudgedOpts | MarkOpts): Judged
  remove(opts?: PlainOpts): Write
  /** Keep the value; reset its ttl or lease. A row's verb. */
  touch(opts?: TouchOpts): Judged
}
/** The writes on a field lens: judged (a field write can be refused 'absent-row', 'absent-path' or 'bad-shape'). */
export interface FieldWrites<T> {
  set(value: Op, opts?: FieldOpts | FieldMarkOpts): Judged
  /** Read, decide, write, guarded by this field: if: { equals: now }, or if: { absent: true } when now is undefined.
   *  A write to a sibling field does not make it try again. */
  set(fn: (now: T | undefined) => T | undefined, opts?: Omit<FieldOpts, 'if'>): Judged<Ack | undefined>
  set(value: T, opts?: FieldOpts | FieldMarkOpts): Judged
  remove(opts?: FieldOpts | FieldMarkOpts): Judged
}
/** The writes on a room (a partition at depth 2): the only ways to write one (V5-15 pick 3). */
export interface PartWrites<Row> {
  /** Replace the room: each row of `rows` set whole, every other row of the room removed. One batch the leader
   *  expands from the rows it holds: one log entry, all or none, commit only. Readers get plain row records. */
  set(rows: NewRows<Row>, opts?: { once?: string; timeout?: Duration }): Judged
  /** Empty the room: every row removed, as one batch. */
  remove(opts?: { once?: string; timeout?: Duration }): Judged
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
  /** On a row that exists, the leader appends one field record per merged key; on a missing row, the row. */
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
/** A write that cannot be refused on state: it also reports its earlier stages. */
export interface Write extends Judged {
  readonly received: Promise<Early>     // the leader appended it
  readonly replicated: Promise<Early>   // a majority handed it to their operating systems
}

// ── methods: actions, served views and pages (V5-13 pick 6, V5-14) ───────
/** Where a method may be called. A bare function: the root only, `f.data.x(arg)`. */
export type Where = 'row' | 'partition' | 'any'
export type Handler<Row = any, D extends Depth = 1, K extends Kind = 'root'> = (arg: any, ctx: Ctx<Row, D, K>) => unknown
/** A live view over every row that clients may keep: bounded (a window, one value, or buckets), blind to the
 *  caller, a function of its argument and the rows. Calling it gives an address. */
export interface ViewDef<Row = any> {
  readonly view: (arg: any, ctx: ViewCtx<Row>) => unknown
  /** Part of its entries' key. None: the deploy's build id, so its entries end at every deploy. */
  readonly version?: number | string
  /** Run on every SUB with the caller: may this caller hold this view? The view itself never sees the caller. */
  readonly allow?: (arg: any, claims: Claims | null) => boolean
}
/** One sorted list read a page at a time: one shared index on one copy; a page read holds nothing. */
export interface PagesDef<Row = any> {
  readonly pages: (arg: any, ctx: ViewCtx<Row>) => unknown
  readonly size?: number
  readonly version?: number | string
  readonly allow?: (arg: any, claims: Claims | null) => boolean
}
/** A function (the root only); `{ at, run }` (the paths it may be called on, at that path's leader; the server
 *  refuses any other path with 'bad-path'); `{ view }`; or `{ pages }`. */
export type MethodDef<Row = any, D extends Depth = 1> =
  | Handler<Row, D, 'root'>
  | { readonly at: 'row'; readonly run: Handler<Row, D, 'row'> }
  | { readonly at: 'partition'; readonly run: Handler<Row, D, D extends 2 ? 'part' : 'row'> }
  | { readonly at: 'any'; readonly run: Handler<Row, D, 'field'> }
  | ViewDef<Row>
  | PagesDef<Row>
export type Methods<Row = any, D extends Depth = 1> = Record<string, MethodDef<Row, D>>
export interface Ctx<Row = any, D extends Depth = 1, K extends Kind = 'root'> {
  /** The lens the call was made on. For a bare function, the root. */
  readonly at: Lens<K extends 'row' ? Row : K extends 'part' ? Record<Key, Row> : K extends 'root' ? Tree<Row, D> : any, Row, {}, K, D, 'server'>
  /** This server's own resource: its rows held, its writes allowed; operators run here (at depth 1; at depth 2 a name on the root is a room). */
  readonly data: Lens<Tree<Row, D>, Row, {}, 'root', D, 'server'>
  set: RootWrites<Row, D>['set']
  remove: RootWrites<Row, D>['remove']
  batch: RootWrites<Row, D>['batch']
  readonly peer: string
  readonly claims: Claims | null
  readonly session: string
  readonly once?: string
  /** Aborts when the call ends: pass it to the handler's live reads, and they end with the call. */
  readonly signal: AbortSignal
  now(): Time
  id(): string
  flush(): Promise<void>
  /** Another resource's handle, bound to this call: its writes carry the call's attempt ids, so a `once`
   *  re-run makes the same writes, and `while: 'session'` binds the caller's session. */
  use<S extends AnyResource>(other: S): S
}
/** A served view's context: its rows only. No caller, no second resource: one view serves every equal call. */
export interface ViewCtx<Row = any> { readonly data: Addr<Rows<Row>, Row, 'rows', 'view'> }
type NoCaller = Steer<'a served view is shared by every equal call, so it cannot see the caller: take the user as the argument, and check it in allow'>
/** A { view } must be bounded; { pages } must be one sorted list. Each wrong shape names the fix. */
export type CheckViews<M, Row> = { [N in keyof M]:
  M[N] extends { view: (arg: any, ctx: infer C) => infer X }
    ? ViewCtx<Row> extends C
      ? X extends Addr<any, any, Bounded, 'view', any> ? M[N]
      : X extends Addr<any, any, 'arrival', 'view', any> ? Steer<'limit and reverse over unordered rows follow this copy\'s arrival; another copy would differ: sort first, za(field, n)'>
      : X extends Addr<any, any, 'page', 'view', any> ? Steer<'one served view per cursor builds an index of every row per cursor: declare { pages } and read page(after)'>
      : X extends Addr<any, any, 'members', 'view', any> ? Steer<'group and distinct are as big as the rows: count with by(field).length(), or derive a resource'>
      : Steer<'a served view must be bounded: end it with za(field, n), an aggregate, or by(field).<aggregate>()'>
      : NoCaller
  : M[N] extends { pages: (arg: any, ctx: infer C) => infer X }
    ? ViewCtx<Row> extends C
      ? X extends Addr<any, any, 'sorted', 'view', any> ? M[N] : Steer<'{ pages } returns one sorted list: ctx.data.za(field) or az(field), with filters before it'>
      : NoCaller
  : M[N] }
type Verb = 'get' | 'connect' | 'changes' | 'past' | 'at' | 'call'
type OpName = keyof Plain<unknown, 'left', false> | keyof CodeOps<unknown, 'left', 'rows', false> | 'lookup'
type WhereOf<H> = H extends { at: infer W } ? W : 'root'
/** fero's own names on the lens a method would be called on; for 'any', the root's and a row's together. */
type Taken<W, D extends Depth> = W extends 'root' ? Verb | OpName | 'set' | 'remove' | Probe
  : W extends 'any' ? Verb | OpName | 'set' | 'remove' | 'touch' | Probe
  : W extends 'partition' ? (D extends 2 ? Verb | OpName | 'set' | 'remove' | Probe : Verb | 'set' | 'remove' | 'touch' | Probe)
  : Verb | 'set' | 'remove' | 'touch' | Probe
/** A method named like a fero word, where it would be called, is refused where it is declared ('bad-name'). */
export type NoClash<M, D extends Depth> = {
  [N in keyof M]: N extends Taken<WhereOf<M[N]>, D> ? Steer<'this name is a fero word on the lens it would be called on: rename the method'> : M[N]
}
type RunOf<H> = H extends { run: infer F } ? F : H extends { view: infer F } ? F : H extends { pages: infer F } ? F : H
type ArgsOf<H> = RunOf<H> extends (arg: infer A, ctx: any) => any
  ? H extends { view: any } | { pages: any } ? (undefined extends A ? [arg?: A] : [arg: A])
  : (undefined extends A ? [arg?: A, opts?: CallOpts] : [arg: A, opts?: CallOpts]) : never
/** An action answers once its writes commit; a view is an address you get() or connect(); pages are read a page at a time. */
type CallOf<H, D extends Depth> =
  H extends { view: (...a: any[]) => Addr<infer V, infer R, infer B, any, any> } ? Served<V, R, B>
  : H extends { pages: (...a: any[]) => Addr<any, infer R, any, any, any> } ? Paged<R, D>
  : Call<Awaited<RunOf<H> extends (...a: any[]) => infer X ? X : never>>
type CallableAt<W, K extends Kind, D extends Depth> =
  W extends 'any' ? true
  : W extends 'row' ? (K extends 'row' ? true : false)
  : W extends 'partition' ? (D extends 2 ? (K extends 'part' ? true : false) : (K extends 'row' ? true : false))
  : false
/** The methods a path of this kind may call; each name is also the step to the row of that name. */
type PathCalls<M, K extends Kind, D extends Depth, S> = K extends 'root' ? {} : {
  readonly [N in keyof M as CallableAt<WhereOf<M[N]>, K, D> extends true ? N : never]: ((...args: ArgsOf<M[N]>) => CallOf<M[N], D>) & S
}
/** The root's methods: `f.data.low(5)` calls; `f.data.low.get()` still reads the row named 'low'. */
type RootCalls<M, S, D extends Depth> = {
  readonly [N in keyof M as WhereOf<M[N]> extends 'root' | 'any' ? N : never]: ((...args: ArgsOf<M[N]>) => CallOf<M[N], D>) & S
}
/** A method by name: for a name in a variable. An unknown name is refused here, with no trip ('no-such-method').
 *  A handle typed by its rows only takes any name. */
type CallFn<M, K extends Kind, D extends Depth> = keyof M extends never
  ? (name: string, ...args: unknown[]) => Call<unknown>
  : <N extends keyof (K extends 'root' ? RootCalls<M, unknown, D> : PathCalls<M, K, D, unknown>) & keyof M & string>(name: N, ...args: ArgsOf<M[N]>) => CallOf<M[N], D>
export interface CallOpts {
  /** At most once, from any process: a claim in `#calls`. Three commits in a row. */
  once?: string
  /** v4's: send the call again if its server is lost. No claim, no extra commit. Only for a handler that is safe to run twice. */
  retry?: boolean
  ttl?: Duration
  timeout?: Duration
}
/** An action's answer, after every write it made has committed. */
export interface Call<X> extends PromiseLike<X> {}
/** A view the server named, seen from a client: an address, never a promise, and no operators left of the line. */
export interface Served<V, Row, B extends Bound> {
  get(opts?: GetOpts): Promise<V>
  connect(opts?: LinkOpts): ServedLive<V, Row, B>
  connect(fn: (value: V, c: Commit<Row, false, IsOrdered<B>>) => void, opts?: LinkOpts): Link<V, Row>
}
/** sync(): resolves once the view is at or past every write this process saw resolve (read-your-writes). */
export type ServedLive<V, Row, B extends Bound> = Held<V, Row, B, false> & { sync(): Promise<void> }
export interface Paged<Row, D extends Depth> {
  /** The next page after a cursor (the first page without one). One trip; it holds nothing on the copy. */
  page(after?: After<D>): Promise<Page<Row, D>>
}
export interface Page<Row, D extends Depth> { readonly rows: readonly Row[]; readonly next: After<D> | undefined }

/** What a token allows: `read` the partitions a client may read or hold, `call` the methods, `write` the partitions. */
export interface Claims { sub: string; read?: readonly string[]; call?: readonly string[]; write?: readonly string[]; exp?: Time; [claim: string]: unknown }
export interface Who { peer: string; claims: Claims | null; session: string }

// ── cluster and health ───────────────────────────────────────────────────
export interface ClusterView {
  /** What this process knows of the resource now: a sync read, never a trip, a new frozen object at each change.
   *  After destroy(), 'ended' (V5-16). There is no get() and no snapshot(): the value is already here. */
  readonly value: ClusterShape
  /** fn(shape) a microtask after the call, then after each change, as a lens's connect(fn). */
  connect(fn: (value: ClusterShape) => void, opts?: Pick<LinkOpts, 'signal' | 'until'>): { readonly disconnect: () => void }
  readonly writes: WritesView
}
/** id, members and groups are learned from a server: undefined until one answers, never {} (V5-16).
 *  Frozen, deeply: every field is read-only. */
export interface ClusterShape {
  readonly id: string | undefined      // the resource's id, made when it was founded
  readonly writable: boolean
  readonly me: {
    readonly id: string; readonly role: 'server' | 'client' | 'solo'; readonly listen: string | false
    readonly caughtUp: boolean; readonly lag: number; readonly links: readonly string[]
  }
  readonly members: Readonly<Record<string, {
    readonly listen: string; readonly state: 'live' | 'draining' | 'retiring' | 'gone'; readonly up: boolean
  }>> | undefined
  readonly groups: Readonly<Record<string, {
    readonly voters: readonly string[]; readonly learners: readonly string[]; readonly leader: string | null
    readonly lag: number; readonly slots: number
  }>> | undefined
  /** This process's open links on this resource, by path, with counts: a leak shows here (V5-17 names it `links`). */
  readonly links: readonly {
    readonly path: string; readonly kind: 'connect' | 'changes' | 'view' | 'pages'; readonly count: number; readonly since: Time
  }[]
  readonly health: readonly HealthRow[]
}
export interface HealthRow {
  readonly kind: string; readonly severity: 'info' | 'warn' | 'down'; readonly since: Time
  readonly message: string; readonly fix: string
}
export interface WritesView {
  /** This process's writes in flight and its recent answers: its own state, a sync read. After destroy(), 'ended'. */
  readonly value: readonly WriteRow[]
  /** fn(rows) a microtask after the call, then after each change, as a lens's connect(fn). */
  connect(fn: (value: readonly WriteRow[]) => void, opts?: Pick<LinkOpts, 'signal' | 'until'>): { readonly disconnect: () => void }
  lookup(id: AttemptId): Promise<WriteRow>
}
/** Frozen, as the list it is in. */
export interface WriteRow {
  readonly id: AttemptId
  readonly key: Path
  readonly state: 'pending' | 'committed' | 'refused' | 'unknown'
  readonly stage?: 'received' | 'replicated'   // how far a pending write got
  readonly version?: Version
  readonly code?: Code
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
  | 'conflict' | 'fenced' | 'absent-row' | 'absent-path' | 'bad-shape' | 'sparse-hole' | 'invalid-key' | 'unencodable'
  | 'too-large' | 'cross-partition' | 'no-rows' | 'schema' | 'invalid' | 'rule' | 'rule-threw' | 'rule-timeout'
  | 'field-ttl' | 'room-too-large'
  | 'methods-only' | 'forbidden' | 'call-diverged' | 'read-only' | 'disk-full' | 'backpressure' | 'too-many-keys'
  | 'not-held' | 'not-ready' | 'ended' | 'expired' | 'bad-cursor' | 'bad-position' | 'schema-changed'
  | 'no-such-method' | 'bad-path' | 'bad-key' | 'bad-name' | 'bad-arg' | 'bad-target' | 'threw' | 'busy' | 'aborted'
  | 'too-many-views' | 'view-too-big' | 'redeployed' | 'stale-client' | 'derived' | 'bucket-collision' | 'too-many-outputs'
  | 'timeout' | 'unknown' | 'destroyed' | 'restored'
  | 'locked' | 'limited' | 'no-answerer' | 'no-undo'
  | 'config' | 'config-differs' | 'admin-only' | 'dir-held' | 'wrong-project' | 'wrong-cluster'
  | 'no-server-here' | 'unbound'
  | 'no-leader' | 'moved' | 'retry' | 'end' | 'gap' | 'stale-attempt' | 'empty'

// ── fero's statics ───────────────────────────────────────────────────────
export declare namespace fero {
  function id(): string
  function now(): Time
  /** A server with methods: the row type by hand, the methods worked out. `fero.of<Score>()('scores', { methods })`. */
  function of<Row, D extends Depth = 1>(): <const M extends Methods<Row, D>>(
    name: string, opts: Options<Row, M, D> & { methods: M & NoInfer<NoClash<M, D>> & NoInfer<CheckViews<M, Row>> },
  ) => Promise<Resource<Row, M, D, 'server'>>
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
/** `lag` counts records not yet run in the shares this process owns; for a queue's `work` and a service's `answer`,
 *  the due jobs or requests not yet taken (V5-17). */
export interface Runner { readonly lag: number; stop(): Promise<void> }

export declare function queue<Job = unknown>(name: string, opts?: LibOpts & { lease?: Duration; deliveries?: number; history?: History }): Promise<Queue<Job>>
export interface Queue<Job> {
  readonly name: string
  /** `key`: the message's own row key, written only if absent. A `cron` schedule needs one. */
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
  /** Aborts when the lock is lost or released: give it to the job's live reads. */
  readonly signal: AbortSignal
  renew(): Promise<void>
  release(): Promise<void>
}
/** `renew` is true by default: fero renews the lease every third of it while the lock is held. With false, the holder
 *  calls `l.renew()`, and the lock is lost if it does not (V5-17). */
export interface LockOpts { lease?: Duration; wait?: Duration | 'forever'; renew?: boolean }
/** Run `fn` under the lock; it is released when `fn` returns or throws. */
export declare function lock<T>(name: string, fn: (l: Lock) => T | Promise<T>): Promise<T>
export declare function lock<T>(name: string, opts: LockOpts, fn: (l: Lock) => T | Promise<T>): Promise<T>
/** Hold the lock until `release()`: for a leader that holds it for its whole life. */
export declare function lock(name: string, opts?: LockOpts): Promise<Lock>

/** A source a library reads: anything whose root lens has a log. */
type Source<S> = { readonly name: string; readonly data: { changes(opts?: { from?: Cursor | Promise<Cursor> }): Changes<Entry<S>> } }
/** A target a library writes: a resource, with its marks. */
type Target<T> = { readonly name: string; readonly data: RootOf<T, any>; marks(name: string): Promise<Cursor> }
export interface DeriveOpts { name?: string; from?: 'earliest' | 'latest' }
/** The record form: once per source record, by marks; needs the source's history. `fn` writes with `{ from: e }`.
 *  It sees the record, not the row: e.value is set only for a whole-row write (a dev warning says so). */
export declare function derive<S>(source: Source<S> | readonly Source<any>[], target: Target<any>, fn: (e: Entry<S>) => unknown, opts?: DeriveOpts): Promise<Runner>
/** The record form with rows: the deriver folds its share of the source, so fn also gets the row after the record
 *  and the row before it (undefined when there is none). */
export declare function derive<S>(source: Source<S>, target: Target<any>,
  fn: (e: Entry<S>, rows: { readonly row: S | undefined; readonly prev: S | undefined }) => unknown, opts: DeriveOpts & { rows: true }): Promise<Runner>
/** The view form: the target's rows are kept equal to a bucket view with one value per bucket. Reads rows, not
 *  history. Buckets name target rows, so only a string field or a number field (its decimal form). */
export declare function derive<T>(view: Addr<ReadonlyMap<string, T>, any, 'buckets', 'server', any> | Addr<ReadonlyMap<number, T>, any, 'buckets', 'server', any>,
  target: Target<T>, opts?: { name?: string }): Promise<Runner>

/** The defaults (V5-17): 16 shares, fixed for the group's life; a 10 s lease, renewed every third of it; 100 entries a
 *  batch; from 'earliest', used only by a share with no saved cursor. */
export declare function consumer<Row>(source: Source<Row>, name: string, opts?: { from?: 'earliest' | 'latest'; lease?: Duration; max?: number; shares?: number }): Promise<Consumer<Row>>
export interface Consumer<Row> extends AsyncIterable<ConsumerBatch<Row>> {
  readonly member: string
  readonly owned: number
  /** Exactly once when `fn` writes with `{ from: e }`: paced, and one owner per share. */
  run(fn: (e: Entry<Row>) => unknown): Runner
  leave(): Promise<void>
}
export interface ConsumerBatch<Row> { readonly entries: Entry<Row>[]; commit(): Promise<void> }

/** The steps may sit in different resources (V5-17). A refused step rejects the call with that step's own error, once the
 *  undo has committed; a retry under the same `once` name gets the same refusal (V5-17). */
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
/** A request is a row of the service's own resource. When the answer function throws, the request goes back to be taken
 *  again, as a queue job does (V5-17), up to `deliveries` tries, 5 by default; after the last, the ask rejects 'threw'
 *  (this page's reading, question 41). An ask whose timeout runs out first rejects 'timeout'. `deliveries` is a setting of
 *  the service's resource: the open that founds it stores it, an open that leaves it out takes it, and an open that passes
 *  another value is refused 'config-differs' (section 3.1; this page's reading). */
export declare function service<Req = unknown, Res = unknown>(name: string, opts?: LibOpts & { deliveries?: number }): Promise<Service<Req, Res>>
export interface Service<Req, Res> {
  answer(fn: (req: Req, info: { from: string }) => Res | Promise<Res>, opts?: { group?: string; concurrency?: number }): Runner
  ask(req: Req, opts?: { timeout?: Duration; group?: string }): Promise<Res>
}
export declare function migrate<A>(res: { readonly name: string; readonly data: RootOf<A, any> }, opts: { to: number; fn: (row: A) => unknown; perSec?: number }): Promise<{ readonly done: Promise<void>; progress(): { rows: number; of: number }; pause(): void; resume(): void }>
export declare function tape<In = unknown, Out = unknown>(name: string, opts?: LibOpts & { window?: Duration }): Promise<{
  record(match: string, input: In, answer: Out): Promise<void>
  find(match: string): Out | undefined
}>
export declare function gateway(kind: 'resp' | 'nats' | 'kafka' | 'etcd', opts: { listen: string; resource?: string }): Promise<{ close(): Promise<void> }>
```

## 7. What the types cannot say

**The rules the types cannot check.** Most of section 2's seven rules are in the types: a lens and a handle are never promises (rule 1), each verb gives what it says (rule 2), a version and `-N` are refused on the root (rule 3), a function cannot stand left of `connect()` (rule 4), `until` refuses what cannot say it closed (rule 6), and a method is offered only where it is declared and never takes a fero word (rule 7). These are yours to keep:
- **End every link** (rule 6). The types cannot see that a handle is ended. A link nobody ends runs until the process stops: its changes go on crossing and decoding, and its function runs (E-55 claim 12). The dev warning fires only if the collector runs and the handle has no signal, no `until` and no parent; a handle kept in a variable never warns. `f.cluster.value.links` always lists open links by path (section 3.10).
- **Read a partition's value only while its link is live** (V5-13 pick 5). A read after the end compiles and throws `ended`. Copy what you keep, `{ ...h.value }`, while the link is live. The same holds for `f.cluster.value` and `f.cluster.writes.value` after `destroy()` (V5-16).
- **`f.data.value` is a row named `value`**, not every row: a property on a lens is a step, so the slip compiles and reads one row. Every row is `f.data.connect()`'s `value`.
- **A lens inside a partition holds the whole partition** (rule 5, first build). `chat.data.room1.m7.text.connect(…)` downloads `room1` once, then every change to it.
- **data's rule is a run-time rule** (V5-15 pick 1). That a link or a field's log runs only when its value changed, and never for a write beside it, is in the comments of section 6, not in the types. "Changed" means a new object, so an object value's link may run again on every copy but the leader after a whole-row write that left it equal.
- **The shape rule is the leader's** (V5-15 pick 6). That a field write's parent is an object, that an array step is an index, and that no key is `__proto__` depend on the row's shape at run time, not its type: the leader refuses `absent-path`, `bad-shape` and `bad-key`.
- **A room write fits the size rule** (owed). The types do not count a room's rows; past the rule, the leader refuses `room-too-large` (V5-17).
- **A version from another partition**, given as `from` or to `past` on one partition, compiles. The server refuses most such versions `bad-position`, but one from another slot can land on this partition's own record and give a quiet wrong answer (CONNECT 3.2). Save the cursor to resume.
- **A `Date` that is not valid** compiles and is refused `bad-position`. **A target of the right shape that never closes**, such as a Node stream made with `emitClose: false`, compiles as `until` *(from memory)*.
- **A forgotten `.get()`** that is printed, `JSON.stringify(await shop.at(id))`, compiles and prints `undefined` (CONNECT 5.2). A lint rule catches it.
- **A served view depends on its argument and the rows only**: no clock, no random number, no module state (TRANSFORMS 8.4 rule 3). A view with a `Date.now()` threshold gave another answer after a failover in 822 of 1,000 seeds (E-57 XA-8). **And its buckets stay under `views.rows`**, checked on every commit at run time (E-57 A5, XA-12).
- **The record form sees records, not rows**, unless it says `{ rows: true }`. A filter on `e.value` compiles and misses every field write; a dev warning names the line (V5-15 pick 4).
- **A method checks its argument** (rule 7). A client picks the argument and the path. The server checks the path against `at:`; the argument's shape and meaning are the method's to check.
- **A sink never changes a row it was handed.** Rows handed out are frozen, so such a change throws in strict-mode code; the types show `c.diff`'s entries as read-only, not the rows inside them.
- **Run the four-line derive in one process** (section 3.11), or use `derive()`, which splits the work.

**Roles.**
- Section 3.1 has the rule. The server markers are: `server: true`, `listen`, `dir`, a `data` seed, `methods`, and the other code keys (`validation`, `schema`, `rules`, `load`, `rows.where`, `shape.up`). A `partition` function alone is not one: a client may pass it to route by itself.
- `listen: false` is a solo node with no socket: the only voter of its groups, for tests.
- A server holds and folds every row of each resource it serves, with `data`, while it is one of the resource's `copies + standbys`. A server past that number is a spare (section 3.3): the types cannot tell it from a copy, and its first operator over every row downloads the resource. A client holds what its live links name, or every row with `hold: 'all'` (section 3.3).
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
2. shape checks (`absent-row`, `absent-path`, `bad-shape`, `bad-key`, `sparse-hole`; V5-15 pick 6); a room write is expanded into row records;
3. `validation`, `schema` and `rules.write`;
4. conditions (a lock's token among them);
5. ops.

- The leader appends results only. Followers, clients and replays apply plain values.
- So leader-side code may give different answers on different runs, but it must be synchronous and must not read app state. `load` is the exception: it is asynchronous and lands later as an ordinary write.
- Leader-side code is only the code keys, the same on every server. A call never carries code to a leader. So a `claim`'s filter is a field name, `due`, not a function.

**Ops on what is missing.** An op on a missing row, or on a missing field of a row that exists, starts from its identity: `incr` from 0, `push` from `[]`, `merge` from `{}`; `max`, `min` and `now` take the value. A field write or field op on a row that does not exist is refused `absent-row`. So a counter is its own row, or a field of a row you created first. `op.merge` on a row that exists is appended as one field record per merged key (V5-15 pick 7).

**Reads.**
- A handle's `value`, a view, and `get()` of a partition held on purpose read this process's committed rows, with no trip. `.value` is the one sync read, and only where it is sure: a live handle, a `past`, and `f.cluster` (V5-16).
- A row handed out is frozen, so a read by reference cannot change it (DATA-07), and that covers rows handed to sinks (section 3.10). Open: in E-22's probe, a row read through a `filter` view was not frozen.
- Every awaited read carries the highest position this process has seen. A server answers only once its own rows have reached it. So a process never reads older than what it already saw or wrote, even when a link ends and the next read goes to another copy.
- A `get()` of a partition not held on purpose is answered from a copy, which may trail a write another process already had answered. `get({ fresh: true })` is the form that cannot ([E-22] C11).
- **A `get()` never subscribes**, except `get({ when })`, which holds the partition while it waits and says so on the line (V5-13 pick 6). It reads once and keeps nothing; a read that should go on is a `connect()`.
- A refusal's `current` version counts as seen. So `set(fn)`'s re-read waits for it (section 3.7).
- `fresh: true`: the leader confirms it still leads (Raft's read index), then answers. One trip, no disk sync ([E-46]).
- **The state forms follow data's rule; the log forms take the records on the lens's path** (V5-15 picks 1, 2; section 3.10). A log reader below a row keeps the lens's value and folds into it; it is exact in E-58, and its build is owed.

**Cursors** ([E-31], A-06).
- A cursor holds one position per slot it reads. It keeps its meaning across failovers and slot moves.
- A copy that lacks a reader's next record tells the client, and the client moves to another copy with its cursor, by itself.
- A reader hears `expired` only when no live copy of that slot has its next record. E-31 model-checked this through a leader crash, a reload, a dropped link and a slot move: 26 rules, on ten bounds of up to 7.6 million states.
- **Size.** A whole-resource cursor holds up to 4,096 entries: about 4 to 13 KB (reasoned from [E-19]). A reader of 1 to 10 partitions holds 22 to 79 B.

**Order.** Total within a partition. None across partitions, ever. Under a test world, deliveries mix partitions in a seeded order that keeps each partition's own order. So code that leans on order across partitions fails in test: E-22's planted app failed in 25 of 100 shuffled seeds and never without the shuffle.

**Versions.** Two versions of one partition compare with plain `<`, in log order, across failovers, moves and restores. So an outside system can check a lock's token with `<`. `fero.version.toNumber(v)` gives a number below 2^63 that keeps the partition's order; gateways need it ([E-45] F1) and apps never do. `f.data[p].changes({ from: version })` starts at the commit that holds that record (V5-13 pick 4). A version is short text, such as `38S9`: a length character, then the (epoch, sequence) pair in base32 (E-56 positions). One version per row: its last write's (V5-15 pick 5).

**Values.** Rows are JSON-like values. `Uint8Array` is a value too, kept as bytes on the wire ([E-45] F3). A bigint, a function, a `Date`, a `Map`, a `Proxy` (a lens among them) or nesting deeper than 60 is refused `unencodable`. So is a function left of `connect()`: an operator's argument crosses as a value too.

**Time** (A-23, [E-21]; V5-4).
- Writer time is the median of the members' clocks, the leader's own included. It never goes back. With one wrong clock, the leader's included, every check passed and no failover happened ([E-21]: 7 rules).
- **When most clocks are wrong, the group keeps writing by a wrong time.** A-23 has no agreement guard. In [E-21]'s 30 runs where two of three clocks jumped, 104 rows expired early (the worst by 28.5 s), 370 late, and 2 locks were granted early. A guard that makes the group stop instead costs 2 more rules, 9 in all. Whether to add it is still open ([AMENDMENTS.md](AMENDMENTS.md) G-11, and its question 12). The records disagree until the owner rules. [VERDICT.md](VERDICT.md) section 8 item 12 lists the guard as in force now. A-23 leaves it out, and so does LAYERS' count for writer time. This page follows A-23.
- **Expiry, presence and delays are judged while a leader exists.** With none they wait.
- `fero.now()` and `fero.id()` are the wall clock and random ids live, and the world's clock and seeded ids under test. Under a world, `setTimeout` and `setInterval` run on the world's clock ([E-22] D1).
- **One timeline.** A viewer merges the resources' logs by writer time (V5-4). Writes to different resources within the clocks' gap (a few ms) may show in either order.

**Methods.**
- A handler called on a path runs at that path's leader, once the server has checked the path against the method's `at:` (`bad-path` if it does not fit). At the root, it runs on the server the caller reached. `ctx.at` is the lens it was called on; `ctx.data` is that server's own resource; `await ctx.at.get()` reads the called row, with no trip at the leader (at the root, `await ctx.data[k].get()`; V5-16); `ctx.signal` aborts when the call ends.
- **A call with `once`** claims a row in `#calls` first. It runs at most once within its `ttl`, and a retry gets the first result. If its server dies, it is re-run elsewhere when the claim's lease lapses, with the same attempt ids, `ctx.now()` and `ctx.id()`. So handlers must give the same writes for the same `arg` and `ctx`; a re-run that writes a different change is refused `call-diverged`.
- **A call with `retry: true`** whose server dies is sent again to another server, as in v4. It may run twice; that is what the option says is safe. No claim, no extra commit.
- **A call with neither** whose server dies answers `unknown`: it may have run. fero does not resend it.
- `while: 'session'` inside a method binds the caller's session.
- **A handler writes another resource through `ctx.use(other)`.** Those writes carry the call's attempt ids and the caller's session, as `ctx.set` does, so the two rules above hold for them too. A write through a handle the handler took from its own module is an ordinary write of that server: a `once` re-run sends it again as a new write, and `while: 'session'` binds the server's session, not the caller's.
- A session-bound write is sent only once its session's own record has committed (A-04; [E-22] F2).

**Locks** (A-24, [E-24], [E-21]).
- A lock is a row of `#locks`. Its token is the version of the write that took it; renewals keep it. fero renews it every third of its lease, unless `renew: false` (V5-17). Tokens rise for ever.
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
- A served view's buckets are capped by `views.rows`, a copy's served views by `views.max` weighted by cost, a client's by `views.client` (section 3.10).
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
| `unencodable` | L4 | a value that would not arrive unchanged (a bigint, a function, a `Date`, a `Map`, a `Proxy` or a lens, deeper than 60); **a function left of `connect()`**: code cannot travel, and the hint says to move it right of `connect()`, or into a method; a row given as `undefined` to `room.set` | |
| `bad-key` | L2, L4 | `at()` given a key that is not a string or a finite number (a number becomes its string); **a key `__proto__` at any step**, at `at()` and at the leader (V5-15 pick 6) | `key` |
| `bad-path` | L2, L4 | a method called on a path its author did not declare (`at:`): the leader checks it before the handler runs. A write at the root. A room written any way but `room.set(rows)` and `room.remove()`: assignment, `delete`, `f.set([room], …)`, a `batch` item at a room key. A lens that steps into an array by name, when read. The hint names where the method may be called, the row or room lens to write, or `fero.drop(name)` | `path` |
| `bad-shape` | L2 | **new (V5-15 pick 6):** a field write under a parent (or a row) that is a string, a number or `null`; an index past an array's end; a step on an array that is not an index (a named field, `length`) | `path` |
| `bad-name` | L4 | **new (V5-13 pick 6):** a method named like a fero word on the lens it would be called on (a verb, an operator, `set`, `remove`, `touch`, a probe name), refused when the server opens; the hint names the method | `reason` |
| `bad-arg` | L2, L4 | **new:** `get()` or `connect()` given an argument of the wrong kind, such as a key (`get(key)`: the step by a key is `at(key)`); a view or a page call with an argument the method refuses | |
| `field-ttl` | L2 | **new (V5-17):** a `ttl` or `while` on a field write, at the leader (V5-15 pick 7). The types already refuse it; untyped code meets it here. The hint says to set them on the row | |
| `bad-target` | L4 | **new (V5-13 pick 2):** `until` given a thing that cannot say it already closed (a DOM node, an `EventSource`, a plain emitter), or an HTTP request (pass the response) | |
| `bad-position` | L3 | **new (V5-13 pick 4):** a version whose record is in another partition; a `Date` that is not valid; `-N` on the root, in untyped code | |
| `too-large` | L3, L4 | a record over 1 MB, a row over 64 MB | |
| `room-too-large` | L2 | **new (V5-17):** a room write past the size rule. The rule is owed (V5-15's consequences) | |
| `cross-partition` | L4 | a `batch` whose keys span partitions | |
| `no-rows` | L2, L4 | an op, a claim or a condition on a `rows: false` resource; `get`, `connect` or `past` on a stream's lens | |
| `absent-row` | L2 | a field write or a `touch` on a row that does not exist | |
| `absent-path` | L2 | a field write whose parent field does not exist | |
| `sparse-hole` | L2 | a remove of an array's own element: write the spliced array | |
| `schema` | L2 | `schema` said no | `path`, `reason` |
| `invalid` | L2, L4 | `validation` returned a reason | `reason` |
| `methods-only` | L4 | a client's plain write to a resource with `methods:`; the hint lists the methods. A client typed by `fero<Shop>` cannot write one at all | |
| `forbidden` | L3, L4 | the token or `rules.read` does not allow it; a write resent after its token was revoked; a served view's `allow` said no | |
| `no-such-method` | L4 | **renamed from `no-method`:** no method of that name, refused here with no trip, from the method table the client got at open (V5-13 pick 6) | |
| `derived` | L2 | **new (V5-14 pick 5):** a write to a target that `derive`'s view form keeps, by anyone but its deriver | |
| `too-many-outputs` | L2 | **new:** a record whose marked writes to one output slot pass 256 (the mark's packing; TRANSFORMS 3.4) | |
| `stale-client` | L3 | **new (V5-14):** a client older than the method version it asks a view of | |
| `no-undo` | L5 | a saga step whose op has no inverse and no `undo` | |

**An expected answer: branch on it.** The state said no. `outcome: 'refused'`.

| Code | Layer | When | Fields |
|---|---|---|---|
| `conflict` | L2 | a condition failed (on a field lens, `equals`, `absent` or `present` of that field), an op's bound would be crossed, or `lens.set(fn)` ran out of tries; sent once the state it was judged on has committed (A-04) | `current` |
| `fenced` | L2 | a write under a lock token older than one this partition's leader has seen; a consumer's commit from a member that no longer owns the share; a stale deriver's write | `current` |
| `rule` | L2 | `rules.write` returned a reason | `reason` |
| `rule-threw`, `rule-timeout` | L2 | a rule threw, or held the leader too long | |
| `call-diverged` | L2 | a different change under a `once` name already used | |
| `threw` | L4, L5 | a method's handler threw its own error, and writes it made before stay; a service's answer function threw on the request's last try (*this page's reading*, question 41) | `reason` |
| `locked` | L5 | the lock is held past `wait` | |
| `limited` | L5 | over the limit | `retryAfter` |
| `no-answerer` | L5 | no live answerer, by this process's view of who is alive | |

**Not now: slow down.** fero already retried. `outcome: 'refused'`, with `retryAfter`.

| Code | Layer | When |
|---|---|---|
| `read-only` | L2 | the write gate is closed, or the server is near its `memory` |
| `disk-full` | L0 | the disk is at its hard limit; reads go on |
| `backpressure` | L4 | this client holds 512 waiting writes or 64 MB on top of its credit. A verb's handle rejects with it. **An assignment throws it**, since it has no handle. **A marked write never gets it**: it waits, and pauses its reader. Write in chunks of a few hundred (section 3.6) |
| `too-many-views` | L3 | a SUB for a served view past a cap: this client holds `views.client` live served views on that copy, or the copy's served views weigh `views.max` by cost, less its headroom (section 3.10). The hint says to end a view, or to call with an argument already open: equal calls share one view |
| `too-many-keys` | L2 | a new `once` name, past the resource's bound of live names |
| `busy` | L4 | every server tried has a stalled main thread |

**It may have committed.** `outcome: 'unknown'`. Usually do nothing: fero keeps resending the same attempt, and it cannot apply twice. To know: `f.cluster.writes.lookup(e.attempt)`.

| Code | Layer | When |
|---|---|---|
| `timeout` | any | no definite answer within `timeout` (`refused` if the write never left the client); `cause` names the inner code. Also an ask whose request was not answered in time, tries that threw included (V5-17) |
| `unknown` | L2, L4 | the session lapsed with the write in flight; a call without `once` lost its server |
| `destroyed` | L4 | the handle closed with the write in flight |
| `restored` | L2 | an attempt from before a restore; it will not run now |

**Thrown by a read, or the reason a link ended.**

| Code | Layer | When | Fields |
|---|---|---|---|
| `not-held` | L4 | an operator over every row left of `connect()` on a client without `hold: 'all'` (the types refuse it on a bare client; untyped code meets it at run time). Never a stale or partial answer, never a hidden trip. No sync read throws it since V5-16: a handle's `value` throws `not-ready` or `ended` instead. The hint names a view the server named, or `f.data.connect()` with the operator right of it | |
| `not-ready` | L4 | **new (V5-13):** a handle's `value` read before its first picture: await `h.ready` | |
| `ended` | L4 | **new (V5-13 pick 5):** a read of a partition's value, or of `h.value`, after its link ended. Copy what you keep while the link is live. Also `f.cluster.value` and `f.cluster.writes.value` after `destroy()` (V5-16) | |
| `aborted` | L4 | a `get({ when })` or a link ended by its `signal` before it had what it waited for | |
| `expired` | L3 | a reader's cursor, `-N` or `Date` is older than `history`; a past read before what is kept; a deriver whose source cut its log | `earliest` |
| `bad-cursor` | L3 | text that is not a cursor, or a cursor of another resource or from before a restore | |
| `redeployed` | L3 | **new (V5-14):** a served view whose method version or data build changed; the client takes a new picture | |
| `view-too-big` | L3 | **new (V5-14):** a served view whose buckets pass `views.rows`; an ordered view over more than 5,000 rows, or `{ pages }` over more than 2,000, until data 5's ordered index. It refuses the SUB or ends the view, and stays until the method's code changes: a retry cannot help | |
| `schema-changed` | L4 | an old record or tape that the upcasters cannot bring to this version | |

A link that ends for a reason other than your own end rejects its `closed` promise with the code (`expired`, `too-many-views`, a lost lease). `closed` is made only when first read, so a failure nobody reads prints one stderr line, never an unhandled rejection.

**Thrown by `fero()`, to an admin, or shown in health.**

| Code | Layer | When |
|---|---|---|
| `config` | L4 | a bad key or value, or a process key unlike the one this process already runs with |
| `config-differs` | L4 | a resource key unlike the stored one; the hint names the key, both values and the `fero.alter` call |
| `dir-held` | L0 | another live process holds `dir` |
| `wrong-project`, `wrong-cluster` | L0 | a dir or a peer of another project, or of another resource's id |
| `bucket-collision` | L5 | **new (V5-14):** `derive`'s view form met two buckets with one name (`1` and `'1'`); it stops and says so in health |
| `no-server-here` | L4 | a server marker in a browser or an edge worker. **It comes with the browser build, later** (V5-12 pick 12). The first build has no such check |
| `unbound` | L4 | under a world, a name that nothing binds |
| `admin-only` | L0 | an `alter`, `drop`, `erase`, restore or placement hint without the admin key |

**Inside fero only:** `no-leader`, `moved` (since V5-14 also a SUB for a served view at a copy that does not hold it), `retry`, `end`, `gap`, `stale-attempt` and `empty`. The client acts on them by itself: it follows `moved` to the copy it names. An app sees these only as a `timeout`'s `cause`, in `f.cluster.writes` and in the debugger.

**Good to know.**
- A plain assignment that is refused never shows. It is a `refused` row of `f.cluster.writes` and one stderr line, as in v4.
- A stage the write never reached rejects with the write's own error. Once a stage has resolved, the handle never ends in a refusal (section 3.5; MEMORY 9.6).
- A function of yours that throws in a view or a `connect` callback never stops fero; it prints one line (V4-47).
- A remove that finds nothing answers as done.
- **The dev warnings** (not `FeroError`s; nothing throws). In development, fero prints one line naming the path of an open link whose handle was collected and that has no `signal`, no `until` and no parent (V5-13 pick 2); and one naming the line when a record-form `fn` reads `e.value` on a field record (V5-15 pick 4). The collector's timing never changes a result; the warning only points at a cost or a bug.
- **Gone with COMP2:** `too-many-resources`, `node-config`, `needs-persisted`, `wrong-group`, health's `meta-down`. **Renamed:** `shortfall` and `holistic` to `not-held`; `unknown-log` to `bad-cursor`; `no-writer` to `no-leader`; `no-method` to `no-such-method`. **New with the lens (V5-12):** `bad-path`, `bad-key`, `too-many-views`. **New with V5-13 to V5-15:** `ended`, `not-ready`, `aborted`, `bad-name`, `bad-arg`, `bad-target`, `bad-position`, `bad-shape`, `view-too-big`, `redeployed`, `stale-client`, `derived`, `bucket-collision`, `too-many-outputs`; `moved` is now also a served view's `END` reason, which the client follows by itself. **New with V5-17:** `field-ttl` and `room-too-large`.

## 9. Config keys

The cascade is v4's and does not change (V4-10; code: api/config.ts): `--fero.<key>` beats the call, then `FERO_<KEY>`, then the project's `fero.opt.ts`, then `$HOME`'s, then the default. Keys are nested lowercase words. Types are in section 6.

**This process.** A change is a restart. (LAYERS calls these node keys.)

| Key | Default | What it does |
|---|---|---|
| `listen` | a free loopback port; `false` is a solo node with no socket | where this server listens |
| `advertise` | `listen` | the address others dial |
| `rendezvous` | `127.0.0.1:3376`; `off` | where the directory is asked (V4-3). **Now also a list**: across machines, a few addresses that `fero deploy` passes in or `FERO_RENDEZVOUS` names. This is V5-3's seed-address key, under the name v4 has (V5-17 keeps it) |
| `hosts` | none | addresses to dial by hand, for when the directory is off (v4's example 15); a browser's one address goes here. It says where this process dials, so it is a process key; to give one resource its own list, use the cascade's name rung (`--fero.shop.hosts`) or the call |
| `dir` | a server: `.fero/<project>/m<n>`; `false` is memory only, for tests | this process's disk. **One per process**, holding every resource it serves: one journal, one disk sync ([E-12]). So `--fero.shop.dir` is refused `config` |
| `object` | `.fero/<project>/objects` on one box | the store where a resource's id is created once. Needed across machines ([E-51]) |
| `project` | the `name` in the nearest `package.json` | scopes names in the directory: a project is machines plus a name lookup (V5-2 point 5) |
| `secret`, `token`, `admin` | none | the members' secret (V4-30), a client's credential, the admin key. Never a flag |
| `memory` | none | this process's memory bound; near it, writes are refused `read-only` |
| `ping.ms` | 500 | the ping between two machines when no other frame went that way: one per pair, not per group |
| `evict.after` | as COMP2's page | how long a silent peer counts as live |
| `settle.ms` | 30000 | how long a restarted member must be live and caught up before leadership is handed back to it (V5-7) |
| `handback.max` (V5-17) | 8 | hand-back transfers in flight per member, busiest groups first; 4 where a 10 ms pause bar must hold (V5-10; [E-53]) |
| `bulk.rate` (V5-17) | to be measured | the byte-rate cap on catch-up, installs and moves, on the link and the disk (V5-9) |
| `connect.wait` | `10s` | how long an open looks before it says who is missing |
| `linger.ms` (V5-17) | 1000 *(a guess, kept until measured: V5-17)* | how long a selection whose last link ended stays subscribed before the unsubscribe is sent, so that a link ended and made again at once (a re-render, a route change) does not unsubscribe and subscribe again (section 3.10) |
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
| `skew.max`, `lag.max`, `catchup.max` | 250, 1000 records, as COMP2's page | were cluster keys in `#meta`. Each resource is its own cluster, so they are its own: in its settings record, changed by `alter`, since every copy must agree on them (LAYERS 5.3; reasoned). Under A-23 writer time has no window, so no member clamps it by `skew.max`; in [E-21] it is still the clock gap the time bounds allow, and part of a lock holder's margin (a round trip plus `skew.max`) |
| `views.max` | 64 per copy, weighted by cost (V5-14 pick 2) | the cap on served views a copy keeps, each counted by data 5's cost class for its call (O(1), O(log n) or O(n) a change); lingering entries and `{ pages }` indexes count. With k ≥ 2 serving copies, `views.max / k` is kept free as headroom; with one, none. Past it, a SUB is refused `too-many-views` |
| `views.client` (V5-17) | 16 per client per copy *(a guess, kept until measured: V5-17)* | how many served views one client may hold on a copy; a join counts |
| `views.rows` (V5-17) | 1,000 *(a guess, kept until measured: V5-17)* | the most buckets a served view may hold, checked on every commit; past it, the view ends `view-too-big` until its code changes (TRANSFORMS 3.2) |
| `views.shapes` *(later, with class B)* | *(a guess, not set)* | how many class B shapes a copy runs; past it, a SUB is served as class A with the same answer |

**`session.ms`** (10000) is not a key of an app's resource. Sessions live in the system resource `#sessions` (LAYERS section 10 item 5), so it is `#sessions`' own setting. An app sets it like any config key, in `fero.opt.ts` or `FERO_SESSION_MS`; the server that founds `#sessions` stores it, and a later change is `fero alter '#sessions'` *(proposed; LAYERS has not written who founds the system resources)*. P-13's "within `session.ms`" reads this one value.

**This open.** Never stored.

| Key | Default | What it does |
|---|---|---|
| `server` | by declared act | `true` serves this resource from this process; `false` stays a client |
| `hold` | nothing: a client holds what its live links name (V5-12 pick 1) | `'all'`: every row, kept live; a size: a cache of pictures of closed selections, not subscribed (section 3.3). A client's key only: a server's open does not take it in the types |
| `signals` | `true` | Ctrl-C is a clean stop (V4-8) |
| `bind` | `live` | under `fero test`: what this name resolves to |

**The lens's keys, and which layers may carry them** (each a row in `LEAVES`, with why not the others; CLAUDE.md, "The two seams").
- **`linger.ms`** is a process key. Every layer may carry it: the flag, the call, `FERO_LINGER_MS`, the project's and `$HOME`'s `fero.opt.ts`, with the name rung (`--fero.chat.linger.ms`) for one resource. It is safe everywhere because it changes cost, never a result: a lingering selection is not held on purpose, so no read is served from it (reasoned).
- **`views.max`, `views.client` and `views.rows`** are resource keys: every server must enforce the same caps, so they live in the resource's settings record. The founding open writes them, from the call or from the cascade on that server, as for every resource key; `fero.alter` changes them, with the admin key. A client's open cannot carry them: a different value is refused `config-differs`, so no client can raise its own cap.
- **No key for the rest.** The seven probe names, the dev warning (development only), the freeze of rows handed to sinks, the kinds of thing `until` takes, the row guards until data 5's index (5,000 and 2,000 rows), and a served entry's ring of 64 frames are fixed behaviour, not settings: each is a rule that keeps a result from depending on timing or on a library (LENS 2.1, 2.2, 2.7).

- **`durability` is not a key in the first build.** Every write commits on disk at a majority (V5-5).
- **Gone from COMP2's page:** `seeds` as "the founders", `copies.meta`, `copies.default`, `cache.memory`, and the whole `fero.alter('#meta', …)` door. **Gone from v4:** `replicas`, `heartbeat.ms`, `seams`. **Gone with the lens (V5-12):** `partition: { before }` (now `depth`) and `hold: 'asked'` (now the default). **Changed by V5-14:** `views.max` from 1,000 per resource to 64 per copy, weighted by cost; `views.client` now counts per copy.
- **Proposed, untested** (from COMP2's page): `skew.max` 250 ms, `lag.max` 1,000 records, `session.ms` 10 s, `connect.wait` 10 s, a `once` name's life 1 day, a token's `ttl` 1 hour, a write's `timeout` 10 s (v4's).
- Each new key gets what v4's rule asks: a row in `LEAVES`, a coercion if it needs one, a README row and a `config.test.ts` case ([CLAUDE.md](../../CLAUDE.md), "The two seams").

**The CLI (L5)** keeps v4's verbs and adds `fero run`, `test`, `deploy`, `ls`, `debug`, `recover`, `restore`, `alter`, `drop`, `export`, `migrate`, and the placement hints `drain`, `retire`, `undrain`, `gone`, `lead`, `place`, `move`, `groups`. A hint goes to one resource's leaders; a `lead` hint moves leadership itself, never to a draining or leaving machine (V5-10 fix 9). The flags belong to [LAYERS.md](LAYERS.md).

## 10. Every pattern: the code, the guarantee, the cost, the layer

Each is one of REQUIREMENTS' 22 patterns, in the fewest lines that stay honest, written with the lens (LENS 2.10's lens column).

- **The code** is E-22's pattern code, respelled for the lens and for V5-13 to V5-15. E-22 ran all 22 on a prototype under the earlier spelling, 100 seeds each, with and without the shuffle, with a leader change and a slot move forced into each ([E-22]). **The respelled lines compile here and did not run** (E-55 claim 25 is not run; claim 5 compiled LENS's form of them).
- **Guarantee** is what the call promises. **Cost** is what it costs, from section 4. **Layer** is where the work is done ([LAYERS.md](LAYERS.md)).
- **Evidence** is what was shown. The study judged these cells for COMP2 and for MIN-P+par, whose shape the base is (V5-6). Nobody judged them again for groups per resource, or for the lens. Where the `memory` rung was the only open point (P-10, P-15), the cell counts as met here, since the first build has no such rung (V5-5).
- A line `// ── name.ts` starts a second file. A process that creates a resource says `server: true`, or brings a seed or methods (section 3.1). **Each pattern keeps that in a server file**, and the app's lines open the bare name: an app process that said `server: true` would become one more server of the resource (section 3.1).
- **A bare client holds nothing** (V5-12 pick 1). A pattern that shows every row says so with a line: `f.data.connect()` (P-01). P-13 now holds one room, not every row.
- **What moved on the wire** (LENS 2.10; reasoned): P-03's `get()` sends one row and opens no stream. P-05 keeps no partition index and builds one JSON text per commit per room, not one per socket. P-14 is the same single ASK to the row's leader that `near` made. P-19's first picture walks one partition, not every partition's name. The rest send the same bytes as the page before.

### P-01 Live shared state

```ts
// file: p01.ts — live shared state (two files)
import { fero } from 'fero'
type Item = { stock: number }
// ── server.ts
const shop = await fero<Item>('shop', { data: { widgets: { stock: 10 } } })   // a seed makes a server
shop.data.connect((rows) => console.log(rows))           // every commit, live: a server holds every row
// ── client.ts: a bare name is a client; it holds nothing yet
const client = await fero<Item>('shop')
const ack = await client.data.gadgets.set({ stock: 4 })  // a write, answered at its commit
const w = await client.data.widgets.get()                // read once: one GET, nothing held
const all = client.data.connect()                        // or hold every row, said as a line
await all.ready
console.log(ack.version, w?.stock, all.value.widgets?.stock)   // a read of the live view: one lookup
```

**Guarantee.** Order per partition. The answer comes once a majority has the write on disk. A process reads its own writes. A `connect()` hands over the picture, then each commit, with no gap and no overlap. **Cost.** Each write: one trip to the leader and a share of one disk sync. `get()`: one trip, nothing kept. `client.data.connect()`: one picture of the whole resource, then every later write, which is what v4's bare open did; the line now says so. The read through the handle: one lookup (bar: under 100 ns at 1,000 rows). **Layer:** L4, over L2's fold and L3's subscribe.
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

**Guarantee.** The leader removes rows by writer time, as records with a reason (`ttl`, `max`). So every copy agrees on which rows exist at each position. A row goes within one tick of its ttl, never before, while most clocks are sound (section 7, "Time"). With no leader it waits. `max` is kept per group, as its share rounded up. **Cost.** One commit per `set` or `touch`. Expiry work grows with what expires, not with what is held. The app holds nothing. **Layer:** L2.
**Evidence.** Held by writer time while a leader exists ([E-21], [E-22]). With a failover near the ttl, a row went 2,036 ms late ([E-22] D9). Owed: the expiry pin at 1,000 to 1,000,000 rows.

### P-03 Near cache, client data sync

```ts
// file: p03.ts — near cache, client data sync
import { fero } from 'fero'
type User = { name: string }
const users = await fero<User>('users', { hold: '200MB' })   // keeps pictures of closed selections, inside 200MB
const u = await users.data.u42.get()                    // read once: one GET, nothing kept
const me = users.data.u42.connect()                     // held and live, by choice: the picture, then each change
await me.ready
const same = me.value?.name                             // here: one lookup
const sure = await users.data.u42.get({ fresh: true })  // at the leader: sees every finished write
const page = new AbortController()                      // a page's lifetime: one signal for all its links
users.data.u43.connect({ signal: page.signal }); users.data.u44.connect({ signal: page.signal })
page.abort(); me.disconnect()                           // after the linger: unsubscribed. The pictures stay warm
console.log(u, same, sure)
```

**Guarantee.** `get()` reads once and keeps nothing. `connect()` holds the row's partition by choice: the rows so far, then each change, with no gap and no overlap; a reconnect misses nothing. A read is served here only while a link holds the partition; a page's links end together on one signal; `fresh` asks the leader. The one sync read is a live handle's `value` (V5-16): after its link ends it throws `ended`, and a warm picture never answers one, so it is never a stale answer. With a size, a closed selection's picture stays warm inside the bound, not subscribed: opening it again sends its position, and only the changes since cross if the server can still resume (LENS 2.2; reasoned, not built). **Cost.** One trip per `get()`; one SUB per `connect()`, shared by equal lenses; later reads through the handle are one lookup. **Layer:** L3, L4.
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
  chat.data[room].connect((_, c) => ws.send(c.text()), { until: ws })   // the room so far, then each commit; ends when ws closes
  ws.on('message', (text) => { chat.data[room][fero.id()].set({ text, at: fero.now() }) })
})
```

**Guarantee.** Order per room. A webserver never receives a room none of its sockets is in. A reconnect within `history` misses nothing. A socket's link ends when the socket closes: `{ until: ws }` takes a socket that can say it already closed (V5-13 pick 2). **Cost.** Each change is encoded once at the server, however many hold it: 0.01 to 0.46 µs per record per reader (PATHS 0). On the webserver, the sockets of one room share one SUB, one decode and one fold per change, and **one JSON text per commit** (`c.text()`, E-55 claim 9), not one per socket. A room is a partition (`depth: 2`), so its first picture needs no index from partition to rows (PA-17), and a message is a row with its own `ttl`. About 1,000 sockets a core keep a round near 10 ms ([E-08]). **Layer:** L3.
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
for await (const e of sub) { console.log(e.value); break }       // a log reader ends on break or disconnect()
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
const r = events.data.changes({ from: saved ?? 'earliest', to: 'latest' })   // every partition; a saved cursor goes back in as it is
for await (const e of r) { console.log(e.partition, e.version, e.value); keep(r.cursor) }
events.data['order:981'].changes({ from: ack.version }).disconnect()        // one partition, from a commit
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

**Guarantee.** Each share has one live owner at a time, with its own token, while most clocks are sound; when most are wrong, two can overlap, and the token still fences the older one's `commit()` (section 7, "Time"). A crash hands its shares on within one lease plus one commit. `commit()` gives at least once. `run()` with `{ from: e }` gives exactly once, even after a long restart: each output's own entry carries a mark of the source position it came from ([E-30]), and the library paces the loop, so a marked write is never dropped for `backpressure`. `run()` restarts from its share's cursor, which moves only once the marked writes up to it are answered; a write made again is skipped at its mark (section 3.11; the restart from the share's cursor is V5-17's). **Cost.** `run`: a share of one commit per output, with a 29 B mark; the outputs are not awaited, so they pipeline. `commit()`: one commit per share the batch read, so one for a batch from one share. Each share's lease: 3 commits a lease (V5-17; section 4). **Layer:** L5, over L3 and L2's lock check and marks.
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

**Guarantee.** At most one live lease per message, while most clocks are sound (section 7, "Time"). None is lost while unacked. First in, first out per partition. After `deliveries` tries, the message moves to `thumbs.dead`. **Cost.** Three commits per message: add, take, ack. An empty take writes nothing. **Layer:** L5, on L2's `claim`. Unchanged by the lens.
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

**Guarantee.** At most one holder per lease, by writer time, while most clocks are sound; when most are wrong, two holders can overlap, and only the fence protects writes (section 7, "Time"). Tokens rise for ever and compare with `<`. A write under a token older than one its partition's leader has seen is refused `fenced`; the check reads no other resource. A stale write can still land before the new holder's first write to that partition. **Cost.** Taking a lock is one conditional write: one commit. Keeping it: it renews every third of its lease, so 3 commits a lease, and 1 more to release (V5-17; the times are owed). A write under a lock is an ordinary write with one more check at its own leader. **Layer:** L5, on L2's conditions.
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
type Score = { player: string; team: string; points: number }
// ── server.ts
const scores = await fero.of<Score>()('scores', { methods: {
  best: { view: (n: number, ctx) => ctx.data.za('points', Math.min(n, 100)) },   // a window: bounded, blind to the caller
  teams: { view: (_: null, ctx) => ctx.data.by('team').sum('points') },          // buckets: a Map from team to points
} })
export type Scores = typeof scores
scores.data.za('points', 10).connect((top) => render(top))   // a server holds every row: the view runs here
// ── screen.ts: `import type { Scores } from './server.ts'`; it holds nothing
const fan = await fero<Scores>('scores')
const top = fan.data.best(10).connect()                 // the server keeps the view; only its changes cross
top.connect((rows, c) => render(rows, c.order))         // an array in rank order, and the rank changes
top.map((s) => s.player).connect((names) => draw(names))   // best on a server, map here; it ends with `top`
// @ts-expect-error the typed client checks the argument: best takes a number
fan.data.best('ten')
```

**Guarantee.** A view equals its query over the committed rows after each commit, as a value (data 5's merge contract). A view over every row on a client that does not hold the resource does not compile; that is why the screen calls the server's named view (class C). Equal calls share one view, on one copy chosen by a hash, never the leader. A copy keeps at most `views.max` (64) served views weighted by cost, a client `views.client` per copy; past either, `too-many-views`, and after failures a held view can still be refused, rarely (V5-14). Until data 5's ordered index, the leaderboard is refused past 5,000 rows. `map` right of `connect()` runs here and keeps the served order. **Cost.** The view is kept once, on its copy, for all equal calls, and costs that copy on every write to `scores`: 5.7 to 6.7 µs a change at 1,000 rows, 17.4 to 20.6 at 10,000 (E-57 A1); the team sums 1.8 to 4.9 µs. A screen receives only the view's changes, one encode for every subscriber. **Layer:** L4, data's operators; L3 for the served view.
**Evidence.** E-57 A built served views small: a window, buckets, a scalar and a page, 144,843 checks with 0 unequal, through resumes, copy kills and redeploys (A1 to A8) *(checked)*. The `view` selector is not modelled (V5-14's owed list). `group` costs 2,574 µs a record at 1,000,000 rows against the 1 µs bar ([E-05]); `by(field).sum()` is 0.66 to 1.84 µs (E-57 B2).

### P-13 Presence

```ts
// file: p13.ts — presence (two files)
import { fero } from 'fero'
// ── online.ts, on a server
await fero('online', { server: true, depth: 2, rows: { while: 'session' } })   // a row dies with the process that wrote it
// ── app.ts, a client
const online = await fero<{ since: number }, 2>('online')
await online.data.lobby[fero.id()].set({ since: fero.now() })   // a room is a partition, a person a row in it
const who = online.data.lobby.connect()                         // who is in the lobby: one room held, not every row
await who.ready
console.log(Object.keys(who.value))
```

**Guarantee.** When a process dies, its rows go on every copy within `session.ms` plus one tick, by a log record. A live process's rows are never removed, while most clocks are sound (section 7, "Time"). **Cost.** One commit per row. Showing who is in a room holds that one room, and the line `online.data.lobby.connect()` says so. **Layer:** L2.
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

**Guarantee.** Every saga ends all applied or all undone, by its holder or a later one, even with paused holders. A step whose op has no inverse needs its own `undo`, or the saga is refused `no-undo` before it starts. Readers may see the steps one at a time. A step takes one lens: a client typed by a resource with methods has none to give (V4-5). The steps may sit in different resources (V5-17). A refused step rejects the call with that step's own error, such as `conflict`, once the undo has committed; a retry under the same `once` name gets the same refusal (V5-17). **Cost.** 6 to 7 commits in a row, about 7 ms. If both rows can share a partition (`depth: 2`), one `batch` does it in one commit: model for that first. **Layer:** L5.
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
for await (const e of facts.data.changes({ from: 'earliest', to: 'latest' }))         // rebuild, then stop
  if (e.value) balance.set(e.value.account, (balance.get(e.value.account) ?? 0) + e.value.cents)
```

**Guarantee.** `history: 'all'` never drops a record. A rebuilt projection equals the live one, because both fold the same records with `data`. The loop reads `e.value`, which is set only for a whole-row write: so each fact is written whole, once (a dev warning names a record-form `fn` that reads `e.value` on a field record, V5-15 pick 4). **Cost.** A rebuild reads the whole kept log once. **Layer:** L2, L4.
**Evidence.** E-22's rebuild check passed. Byte for byte is open for a `sum` (it depends on record order, [E-43]) and for ties in a top-k ([E-23]).

### P-17 Derived resources

```ts
// file: p17.ts — derived resources
import { fero, op, derive } from 'fero'
type Order = { user: string; cents: number }
const orders = await fero<Order>('orders', { server: true, history: '7d' })   // its rows, for the view form; its log, for the record form
const totals = await fero<number>('totals', { server: true })   // the deriver serves the target too
await derive(orders.data.by('user').sum('cents'), totals)        // the view form: totals equals the view, rebuilt from rows
const counts = await fero<number>('counts', { server: true })   // the record form: each order counted once, by marks
await derive(orders, counts, (e) => { if (e.value) counts.data[e.value.user].set(op.incr(1), { from: e }) })
```

**Guarantee.** The view form keeps `totals` equal to the sum per user over the rows of `orders`: it reads rows, not history, and after a deriver changes hands it bumps every target group, folds to a read barrier and writes the difference, so the target never steps back and never goes back to older code (V5-14 pick 5; E-57 B3: 0 of 1,000 seeds fail). In the record form, each record of `orders` changes `counts` exactly once, across crashes, restarts and moves, as long as `orders` keeps its log (its `history`, or the tier) back to the marks. A deriver that comes back after the log was cut stops with `expired` and says so; it never skips a record (LAYERS 8.8). `op.incr` is not idempotent, so this is the hard case on purpose. In the plain record form an order must be written whole, once: `e.value` is unset for a field write, so the `if` skips it; with `{ rows: true }` the function gets the row after and before, and a field write counts too (3.11). `derive()` paces the loop, so a marked write is never dropped for `backpressure`, runs it once by splitting the source's shares, and sends bare marks for idle slots (section 3.11). The four lines it is made of are exact only paced and in one process. **Cost.** The view form: the view on the deriver, 0.748 target writes per source commit, one fenced bump per target group at a takeover (E-57 B3). The record form, per source record: one delivery, one run of the function, a share of one commit, a 29 B mark. Run on three servers, the source is still read once. The writes are not awaited: 122,000 to 134,000 a second against 239 to 240 awaited (E-55 claim 21). **Layer:** L5.
**Evidence.** The view form: 0 of 1,000 seeds fail through 11,810 deriver changes; as first planned, 514 failed (E-57 B3). The mark is model-checked: no output twice ([E-30]), and with two outputs of one record in one slot (E-57 B5). Pacing: as written, 998 of 1,000 seeds of E-55's stand-in lost outputs; paced, 0 lost and 0 doubled (E-55 review, claim 21). E-30's model with marks written by app code is owed.

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
const before = (await shop.data.k.past(ack.version)).step(-1)   // a new value: the row just before that write's commit
const stripe = await tape<{ cents: number }, { ok: boolean }>('stripe', { window: '14d' })
console.log(before?.value, stripe.find('charge:981'))   // nothing to close: a past is a value
```

**Guarantee.** A fork is one consistent cut per group. A world makes a run a function of its seed. A recorded input re-runs on the exact earlier state. `past` gives one partition as it was: a value, folded in this process; `step(n)` gives a new value n commits away. **Cost.** A fork is one record per group, not a copy. It is a new resource, so it has a resource's own cost (section 3.1). `past` on one row's partition: its window's records once, 3.6 to 4.4 µs a record to fold, 103 to 285 B a version, in the reader only (E-55 claim 23). **Layer:** L1, L4; `tape` is L5; `past` is a reader library.
**Evidence.** Tapes and reruns held on prototypes ([E-22], [E-06]). The past fold on data's real engine: 0 wrong answers in 1,680 checks against a refold (E-55 claim 23). The fork is not built.

### P-19 Clients everywhere

```ts
// file: p19.ts — clients everywhere (a browser, an edge worker)
import { fero } from 'fero'
type Item = { sku: string; n: number }
const token = 'from your server: fero.token({ sub: "ada", read: ["ada"] })'
const shop = await fero<Item, 2>('carts', { hosts: ['wss://shop.example.com'], token })   // depth 2: a cart is a partition
const cart = shop.data.ada.connect((rows) => draw(el, rows))   // the cart so far, then each commit
// cart.disconnect() when the page or component goes: a DOM node never says it was removed
export const unmount = cart.disconnect                  // bound: a framework's cleanup can return it
```

**Guarantee.** The same API in Node, Bun, Deno, browsers and edge workers, over WebSocket. A browser build in which a server role throws `no-server-here` is later (V5-12 pick 12). The link ends at `disconnect()`, a signal or `until`. A DOM node never says it was removed, so the page's code ends the link; the collector never does (section 3.10). **Cost.** A browser has one link, so its writes take the forward path: one more trip than a Node client's (V5-9). With `depth: 2` a cart is a partition, so its first picture is that partition, with no walk of partition names. The bundle with `data` is 27.9 KB gzip; a cold client's first committed write took 13 to 17 ms ([E-40]). **Layer:** L0's transport, L3, L4.
**Evidence.** Met on E-40's prototype, under the earlier spelling. A headless Chromium ended 0 of 1,000 links to removed DOM nodes within 30 s by collection (E-55 claim 13): a page's links end by its code.

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
// file: p21.ts — request and reply (three files)
import { service } from 'fero'
// ── svc.ts, on a server: it founds and serves the service's own resource
await service<{ url: string }, { url: string }>('thumbs', { server: true, deliveries: 5 })
// ── worker.ts, on each answerer, a client
const thumbs = await service<{ url: string }, { url: string }>('thumbs')
thumbs.answer(async (req) => ({ url: await resize(req.url) }))   // a throw: the request is taken again
// ── app.ts, an asker
const asker = await service<{ url: string }, { url: string }>('thumbs')
console.log((await asker.ask({ url: 'a.png' }, { timeout: '5s' })).url)   // one answer; or 'timeout', 'no-answerer', 'threw'
```

**Guarantee.** Requests spread over the live answerers. Each request gets at most one answer. With no live answerer, `no-answerer` at once, by this process's view of who is alive: the asker follows the answerers' presence rows, a link the library opens and ends itself (V5-17). **When the answer function throws, the request goes back to be taken again**, as a queue job does, until the asker's timeout runs out; then the ask rejects `timeout` (V5-17). After `deliveries` tries, 5 by default, it rejects `threw` instead, with the last message (*this page's reading*, question 41). **Cost.** Three commits per ask ([E-22] D7), and two more for each try after a throw (reasoned). When the answerer is a fero server, a method is the cheaper request and reply: one trip, and commits only for what it writes; on a path, at that path's leader. **Layer:** L5. Unchanged by the lens.
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

**Guarantee.** A delayed message becomes takeable within one tick of its time, by writer time, never before, while most clocks are sound (section 7, "Time"). A waiting take writes nothing while it waits. Priorities hold within a partition. A `cron` schedule is a row under its `key`, written only if absent: the line can run at every start-up, for years, and adds the schedule once. (A `once` name would not do: it lasts a day, so a start-up two days later would add a second schedule.) **Cost.** As P-09. A lapsed lease is noticed at the library's next poll, once a second ([E-22] D6). **Layer:** L5. Unchanged by the lens.
**Evidence.** No delayed message was taken early, and priority 0 came first in every seed ([E-22]).

## 11. Open questions

### 11.1 For the owner

The owner answered these one at a time on 2026-11-21 ([V5-17][dec]). **V5-17 closes 26 of them.** Each kept this page's pick, except four that went the other way: 22, 26, 33 and 38 (section 5.7). **Still open: question 28**, which waited for the audit of what one group per resource assumes ([GROUPS.md](GROUPS.md)) and now, by [V5-18][dec], waits for the study of how work over every row is merged across groups, and of its alternatives (MERGE.md, in progress), **and question 41**, new with V5-17. Question 4 is settled in use; V5-17 does not name it. The other twelve were closed before V5-17: V5-11 and V5-12 closed seven of the first fourteen, V5-13 to V5-16 closed 1, 5, 15 and 19 and the served-view half of 16, and TRANSFORMS 3.4 settled 21. Questions 1 to 14 keep the first tour's numbers; 15 to 24 came with the 2026-11-18 page; 25 to 33 were this page's picks where V5-13 to V5-15 leave room; 34 to 40 came from the patterns walk-through ([PATTERNS.md](PATTERNS.md)). Each says by what. [API-TOUR.md](API-TOUR.md) section 6 lists them the same way.

1. **`f.rows` for reads; what is `f.snapshot`?** **Closed by V5-13 pick 6 and V5-16**: `f.snapshot` goes (pick 6); `f.rows` goes too (V5-16, which supersedes pick 6's "`f.rows` stays"): every row is read in sync through `f.data.connect()`'s handle.
2. **Verbs on the resource (`f.set`), or on `f.data` (`f.data.set`)?** **Closed by V5-12**: the path write is the main spelling; `f.set(path, v)` stays as the array form; `f.data.set` is the root's refused write.
3. **`near` on a method.** **Closed by V5-12 picks 3 and 13**: a method on a path runs at that path's leader and declares `at:`.
4. **`set(key, fn)`: add it?** **Settled in use** (V5-12, LENS 2.5): `lens.set(fn)`. On a field lens it is guarded by the field (V5-15 pick 5). The owner has not ruled on it by name, so a "no" still removes it.
5. **`changes`, `log` or `read`** for the record reader. **Closed by V5-13 pick 1**: `changes()` is one of the four read verbs, the log.
6. **What a write does when the client is full** (512 waiting, or 64 MB). **Closed by V5-17**: a verb's handle rejects `backpressure`, and an assignment throws it; a marked write waits and pauses its reader (V5-12).
7. **Must some process say `server: true` to create a resource?** **Closed by V5-17**: yes. Opening a name as a server creates it, as in v4.
8. **A client's default `hold`.** **Closed by V5-12 pick 1**: a bare `fero(name)` holds nothing until a `connect()` says what (V5-13's words).
9. **A `get` that misses: follow for good, or read once?** **Closed by V5-12** and V5-13 pick 1: `get()` reads once; `get({ when })` is the one form that holds while it waits.
10. **Should the typed client of a resource with methods have no writes?** **Closed by V5-12**: yes; section 6.
11. **`{ retry: true }` on a call.** **Closed by V5-17**: it stays, beside `once`.
12. **A write with `once` has no early stages.** **Settled by V5-11 ruling 6.** A marked write and a room write have none either.
13. **The partition function.** **Closed by V5-12 pick 4**: it stays in the API and is built later.
14. **Names only.** **Closed by V5-17**: every name on this list stays. They are `once`; `not-held`; `consumer`; `if: { lock }`; `hold`; `copies` and `standbys`; `fero.of<Row>()`; `e.value`; a queue's `key`; `ping.ms`; `rendezvous` as a list; `handback.max`; `bulk.rate`; `at`; `depth`; `ctx.at`; a method's `at:`; `{ from: e }`, `marks`, `mark`; `call`; `linger.ms`; a token's `read` claim; `views.rows`, `sync()` and `FieldEntry`. The one exception is the open-links list, which is `links` (question 26). V5-13 to V5-16 had already settled `connect`, `disconnect`, `changes`, `past`, `c.diff`, `c.version`, `c.cursor`, `to`, `{ view }`, `{ pages }`, `room.set`, `bad-shape`, `.value` as the one sync read, and `f.cluster.value`.

**From the 2026-11-18 page.**

15. **`f.rows` on a client.** **Closed by V5-16**: `f.rows` is gone on every role, and there is no `f.value`; a `connect()` handle is the sync read on a bare client, with `hold: 'all'` and on a server alike. (V5-13 pick 6 had closed it the other way: only on a server or with `hold: 'all'`.)
16. **The config keys for links and served views** (section 9). The served-view half was closed by V5-14 pick 2: `views.max` is 64 per copy, weighted by cost, with headroom. **The rest is closed by V5-17**: `linger.ms` 1000, `views.client` 16 per client per copy and `views.rows` 1,000 stay as defaults, marked as guesses, until measured.
17. **`bad-path` for a write above a row.** **Closed by V5-17**: a write at the root, or to a room by any way but `room.set` and `room.remove()`, is refused `bad-path`.
18. **`f.get(k)`, `f.data.snapshot()` and a token's `follow` claim go.** **Closed by V5-17**: `get` is a verb on a lens only (the path, then the verb; it takes options, never a key); `f.remove(path)` and `f.touch(path)` stay as array forms; the claim is renamed `read`; `ctx.use(other)` stays.
19. **`changes()` on a lens below a partition.** **Closed by V5-15 pick 2**: every lens has the log, a field too; below a row it takes the records on its path and gives an entry only when its value changed.
20. **A marked write with a `once` name.** **Closed by V5-17**: not allowed; the types refuse `{ from: e, once }`.
21. **One source record with several marked outputs.** **Settled by TRANSFORMS 3.4 (E-57 B5)** for one target, approved in general with V5-14; it is not one of V5-14's eight numbered picks: the mark carries the write's number inside its record, and a record's outputs to one slot go out in that order; past 256 outputs to one slot, `too-many-outputs`. Still owed: the model with marks from app code (11.2).
22. **When `past` is built.** **Closed by V5-17, the other way**: `past` is in the first build, with the other three read verbs. That adds about +3 rules (LAYERS 0.2). This page had put it after the first build.
23. **Behind the door: `mark` and `claim`; `touch` on a row only.** **Closed by V5-17**: a client of a resource with methods has no bare mark and no claim; `touch` is a row's verb.
24. **How `consumer().run()` restarts, and which name a mark goes under.** **Closed by V5-17**: `run` restarts from each share's cursor and sends no bare marks; a mark counts under its reader's name, else the target's.

**Choices the 2026-11-20 rewrite made where V5-13 to V5-15 leave room.**

25. **What a log entry below a row carries.** **Closed by V5-17**: `e.value` is the lens's value right after the record (`FieldEntry`).
26. **The name of the open-links list.** **Closed by V5-17, the other way**: `f.cluster.value.links`, each with its path, kind, count and start time. This page had `open`.
27. **Roles in the types.** **Closed by V5-17**: any server marker of section 3.1 types a server, and a handle opened with none is a client. So a handle typed by its rows only has no root operators.
28. **Operators on a server's root.** **Still open.** The owner pointed out that moving from one group per resource to many may break what this question assumes, and asked for a study before building (V5-17). That audit, [GROUPS.md](GROUPS.md), has reported; the question now waits for the study of how work over every row is merged across groups, and of its alternatives (MERGE.md, in progress) (V5-18). The question as it stood: TRANSFORMS types a server's own root as a place where functions run (it holds every row). This page does the same for `hold: 'all'` and a handler's `ctx.data`; a partition lens stays plain data left of `connect()` everywhere. **At `depth: 2` the types give the root no operators on any role**, since a name there is a room; CONNECT's and TRANSFORMS' sketches have the same gap. There a server declares a view, and code over every row reads `f.data.connect()`'s value. The other way types a depth-2 root's operators over (partition, row) keys and says how an operator name and a room name share the root. **On a spare server**, which holds no copy, this page reads TRANSFORMS R0: such a read first takes every row, as `hold: 'all'` does, so the line works on every server and only its cost depends on the deployment (section 3.3). The other way refuses it `not-held` there, as on a bare client: the line would then work on five servers and throw on the sixth.
29. **How `moved` and `stale-client` show.** **Closed by V5-17**: fero follows `moved` itself; `stale-client` reaches the app.
30. **A remove that finds nothing.** **Closed by V5-17**: it answers as done.
31. **`f.cluster.tap(fn)` and `f.cluster.writes.tap(fn)`.** **Closed by V5-17**: they become `f.cluster.connect((shape) => …)` and `f.cluster.writes.connect((rows) => …)`, under a lens's link rules.
32. **Who serves a view when the leader is the only copy.** **Closed by V5-17**: the leader serves its views until a second copy is ready, and health says so. Meanwhile it pays a build's stall on the write path. Not run.
33. **Codes for two V5-15 refusals.** **Closed by V5-17, the other way**: each has a code of its own. `field-ttl` is for a `ttl` or `while` on a field write, and `room-too-large` for a room write past the size rule, which is still owed. This page had `bad-arg` and `too-large`.

**From the patterns walk-through ([PATTERNS.md](PATTERNS.md)): meanings the declarations left out.** Where PATTERNS.md already took a reading, it is the pick here. Where a pick follows [E-22]'s library, that library was a prototype under older names, not a design.

34. **What `LockOpts.renew` means.** **Closed by V5-17**: a lock renews itself every third of its lease by default; `renew: false` leaves it to `l.renew()`, and the lock is lost if the holder does not call it.
35. **What `saga()` gives when a step is refused.** **Closed by V5-17**: the call rejects with the refused step's own error (such as `conflict`), once the undo has committed, with a `reason` that says the saga was undone. A retry under the same `once` name gets the same refusal.
36. **May a saga span resources?** **Closed by V5-17**: yes.
37. **`consumer()`'s options, and the unit of `Runner.lag`.** **Closed by V5-17**: 16 shares, fixed for the group's life; a 10 s lease, renewed every third of it; 100 entries a batch; `from: 'earliest'`, used only by a share with no saved cursor. `lag` counts records not yet run in the shares this process owns; for a queue's `work` and a service's `answer`, the due jobs or requests not yet taken.
38. **What an asker gets when the answer function throws.** **Closed by V5-17, the other way**: the request goes back to be taken again, as a queue job does. It ends when its time to live, the asker's timeout, runs out, and the asker then gets `timeout`. How many times it is taken is question 41. This page had the ask reject `threw` at the first throw.
39. **The live links a library opens, and their cost.** **Closed by V5-17**: a library opens, ends and lists the links it needs itself: an asker's links to the answerers' presence rows and to its own reply rows, and a waiting take's link to the queue's partition. They show in `f.cluster.value.links`. Each costs what `connect()` on a partition costs (section 4) *(reasoned; not measured)*.
40. **Cost rows for keeping a lock, and for a consumer.** **Closed by V5-17**: leases renew every third of their lease, and the rows are in section 4. A held lock costs 3 commits a lease, and 1 to release; a consumer member the same for each share it owns; `commit()` one commit per share the batch read; `run` a share of one per output, plus a cursor write now and then. The times are owed.

**New with V5-17.**

41. **How many times a service request is taken.** V5-17 sends a request whose answer function threw back to be taken again, and its consequences ask the pages to say which rule ends it. **This page's reading: the queue's rule.** A request is taken at most `deliveries` times, 5 by default, as a queue's job is in E-22's library; `service(name, { server: true, deliveries })` changes it. It is a setting of the service's resource, as section 3.1 says of every resource option: the founding open stores it, a later open that leaves it out takes it, and one that passes another value is refused `config-differs`, so a client cannot change it. Where a queue moves such a job to its dead-letter resource, a service answers the asker instead: after the last try throws, the ask rejects `threw`, with the last message in `reason`, and no worker takes the request again. An ask whose timeout runs out first gets `timeout`, as V5-17 says. Each try after a throw costs two more commits, a release and a new claim *(reasoned, from E-22's queue library)*. The other way: no count, so a request that always throws is taken by every worker in turn until its timeout, and the asker always gets `timeout`.

### 11.2 For the design

Each is a gap the records leave. None changes a call.

- **Q-B1. An early answer, then a refusal that is not about the row.** After a failover the resent write is judged again (MEMORY 9.6). **This page's pick:** fero keeps retrying through `read-only` and `disk-full`; a revoked token rejects `forbidden`, the one refusal that can follow an early answer. **Decides:** [E-48]'s model with a gate and a revoke.
- **Q-B2. When must a stage be asked for?** This page: "ask in the turn that makes the write" (section 3.5). **Decides:** the build of the second step.
- **Q-B3. Who serves the system resources and the libraries' resources** (`#sessions`, `#locks`, `#sagas`, `#calls`, `#groups`, a queue)? This page reads: any process that serves a resource serves the system ones. **Decides:** [LAYERS.md](LAYERS.md) section 10 item 5.
- **Q-B4. Where the timing keys live.** Answered by LAYERS 5.3 (reasoned); section 9 agrees, and puts `linger.ms` with the process keys and `views.*` with the resource's.
- **Q-B5. Is a process-wide `dir` or `listen` a server marker for every open?** This page reads them as markers only where the call, or a per-name layer, gives them. **Decides:** the config tier's tests.
- **Q-B6. `set(fn)`'s give-up.** 8 tries is a guess. **Decides:** a timed hot-key run.
- **Q-B7. When "now" is, for `changes()`.** "A write made after the call is seen" needs the client to hold its own writes until the open is answered. **Decides:** [E-31]'s model with a writer that also reads.
- **Q-B8. Who runs a `derive`.** **Closed by V5-12**: the app's choice; `derive()` splits the shares.
- **Q-B9. Shared links, and when `await fero()` resolves.** Sharing is measured on `connect` (E-56 probe 4: one SUB, 100 decodes and 100 `text()` builds for 200,000 deliveries). When `await fero()` resolves is still reasoned. **Decides:** the build.
- **Q-B10. The method table in a rolling deploy, and before any server answered** (READS 8). A stale or missing table must never refuse a valid call. **Decides:** a sim with servers on two table versions, and an open with no server up.
- **Q-B11. A data upgrade under live served views and derivers** (V5-14's consequences; TRANSFORMS 10 item 18). The rule is reasoned: served entries and the deriver's lock row carry the data build, and end or rebuild at the offset. **Decides:** XA-10's rolling deploy with a data build in the key.

**Owed, by decision.**
- **V5-13:** the cost of `c.version` and `c.cursor` (bar 50 ns a commit); counting back for `-N` on a real log, a cold partition beside a hot one included; `past` as a value in a real build; the `ended` guard in a real build; the per-row version store that `if: { version }`, diff entries and `c.version` rest on, kept inside the row's entry and timed (CONNECT 3.6 and 9; +10.5 to +276 ns a write as a separate `Map`, *measured*, E-56 positions). Also owed from CONNECT 9: whether the dev warning fires in a browser, how often real apps leak with no net, whether React needs `useSyncExternalStore`, and a loop that takes its turn's diff when the body resumes.
- **V5-13 pick 7:** a folded resume on a live link, `connect({ resume })`, in E-31's model with a client-held base, before it is offered.
- **V5-14:** the `view` selector in [E-31]'s model (E-57 XA-14, not run); paging across a failover; a data upgrade under live views (Q-B11). **Three missed bars, stated:** a view build over 10^6 rows stalls its copy 0.2 to 1.9 s until data builds in slices (XA-1); a client that held a view can still be refused after failures, in 1 to 21 of 1,000 seeds by configuration (XA-2; TRANSFORMS 3.8; V5-14's consequences quote 5 to 21, its standby and leader-kill runs); the chunked ordered index costs 9.5 to 15.1 µs a write at 10^6 rows against a guessed 3 (XB-1). And the defaults: `views.client`, `views.max`, `views.rows`, the ring of 64 and the row guards are guesses.
- **V5-15:** the cost of an `equals` guard at the leader, and its size on the wire; a size rule for room writes; a build of the record form with rows; the "on the path" reader for the log below a row, with its run-time rule; a field's `-N`, read from the row's log back, unpriced.
- **V5-16:** how often `lag` makes a new cluster shape (at every commit, a screen would redraw per commit); what replaces v4's `peers`, `me.uuid`, `me.hosts` and `me.origin`, which 23 of the 46 example lines that read the cluster use (section 5.1); the `ended` guard on `f.cluster.value` in a real build; the promise's cost on a real `get()`, measured here only on a stand-in; what an operator over every row costs on a spare server, which first downloads the resource (section 3.3; TRANSFORMS 10 item 10).
- **V5-17:** the times of the lock, consumer and service rows of section 4; a service's delivery count (question 41) in E-22's checks; the merger study (MERGE.md) before question 28 is answered (V5-18); and `past` built in the first build, with claim 23 run on it (V5-13's list above).
- **From V5-12, still owed:** the 22 patterns end to end on the new spelling (E-55 claim 25); a served view with its cap on the prototype (claim 27; E-57 A built one on its own harness); E-30's model with marks written by app code, including the reader name a mark goes under and `run()`'s restart from its share's cursor (questions 20 and 24, now V5-17's rules); the pacing rule in a real client; a GET that carries the highest position seen, against copies that lag.
- **data's changes** (V5-14 pick 6): data 5.0.0, D1 and D2 first (D1 needs a pin: claim 8 sits at its bar), then the merge contract C1 to C10 with its SCHEDULE clause and version bump, N1 to N9, D3, D4, D6 to D9, F1 to F3 (TRANSFORMS 9.1).

**Where this page and [LAYERS.md](LAYERS.md) stand.** LAYERS.md was updated for V5-13 to V5-16 on the same day, and for V5-17 on 2026-11-21; its table "What V5-12 to V5-17 changed" says where each change lands there. It carries V5-17's answers to questions 25 to 33 in its section 10 item 46, and counts `past` in the first build (its 0.2). Questions 34 to 41 are about the libraries' meanings and are not in it. Its section 10 item 23 asks for one of the two meanings of `busy` to be renamed: this page uses it for "every server tried has a stalled main thread"; DESIGN-V5 4.2 uses it for a member already loading two snapshots.

### 11.3 Carried from COMP2's page

**Still settled:** `get` for one row and a separate verb for the log (Q-A5; both now verbs on the lens); no public `slots` key (Q-A7); a `once` name lasts 1 day (Q-A11); no `publish` verb, since `set` on a `rows: false` resource is publishing (Q-A13); offsets never in answers, a version has a number form for gateways (Q-A14); one error class (Q-A15); the libraries are named exports of `'fero'`, built only from the public calls (Q-A18); durations are `'30s'` or milliseconds, and config keys keep `.ms` numbers (Q-A19); functions run at the leader (Q-A20); shares for consumers (Q-A21); typed rows with an optional schema (Q-A22).

**Settled the other way now:** who creates a resource (Q-A1: a server, section 3.1); partition rules (Q-A6: `depth`, and a function later); where methods run (Q-A8: on a path, at that path's leader; at the root, where the caller reached); answer timing per call (Q-A9: stages, V5-5 and V5-11).

**Still open:**
- **Q-A10. Sagas that readers never see half of.** Not in 5.0. RAMP (modelled in [E-24]) is a possible later add-on (V5-1).
- **Q-A17. Request and reply at three commits.** Either P-21's bar is restated, or a later no-disk service is built and timed with `nats bench`.
- **Q-A25. Changing `copies` online.** **Decides:** [E-52]'s model with a change of size.
- **Q-A26. A reader that ends** (`to: 'latest'`). Nothing tested it.
- **Q-A28. Rows bound to a named lease.** Not in 5.0: `while: 'session'` stays the one form.

## 12. How this file is checked

`env.d.ts` stands in for the app's own world, so the page's files compile. `types.ts` holds what must and must not compile: each `@ts-expect-error` line fails the check if it ever compiles, and the strip proof below makes each of them fail at its own line.

```ts
// file: env.d.ts — stand-ins for the app's own world, so the page's files type-check (lib: es2022 and dom)
declare const process: { pid: number; argv: string[]; exit(code?: number): never }
/** The ws library's socket: it says when it closed. */
interface Socket { send(s: string): void; on(ev: 'message', fn: (text: string) => void): void; once(ev: 'close', fn: () => void): unknown; readonly readyState: number }
declare const wss: { on(ev: 'connection', fn: (ws: Socket, room: string) => void): void }
declare const ws: Socket
/** Node's HTTP request and response, as far as `until` looks: a request has a method, a response has none. */
declare const req: { once(ev: 'close', fn: () => void): unknown; readonly destroyed: boolean; readonly method: string }
declare const res: { once(ev: 'close', fn: () => void): unknown; readonly destroyed: boolean; write(s: string): boolean }
declare const emitter: { once(ev: string, fn: () => void): unknown; emit(ev: string): boolean }   // a plain emitter
declare const signal: AbortSignal
declare const db: { price(sku: string): Promise<{ sku: string; cents: number } | undefined> }
declare function resize(url: string): Promise<string>
declare function sendMail(to: string): Promise<void>
declare function bill(order: unknown): Promise<void>
declare function render(...x: unknown[]): void
declare function draw(...x: unknown[]): void
declare const el: HTMLElement                                  // a DOM node: it never says it was removed
declare const saved: import('fero').Cursor | undefined         // a cursor from the app's own storage
declare function keep(c: import('fero').Cursor): void
declare const UserV3: import('fero').Schema<{ id: string; name: { first: string; last: string } }>
```

```ts
// file: types.ts — what must and must not type-check
import { fero, op, saga, lock, derive, type Cond, type Early, type Entry, type FieldEntry, type Judged, type Write,
  type Version, type Cursor, type Rows, type Live, type Link, type Commit, type Turn, type Past, type Changes } from 'fero'
import type { Fans, Fan, Orders, Products } from './servers.ts'

// ── writes and their handle (V5-5, V5-11)
type N = { n: number; tags: string[] }
const f = await fero<N>('f', { server: true })
const w: Write = f.data.k.set({ n: 1, tags: [] })        // a plain whole-row write: early stages
const e: Early = await w.received
// @ts-expect-error an early answer has no version (V5-11)
console.log(e.version)
// @ts-expect-error an op answers at commit only: no early stage (V5-11 ruling 6)
await f.data.k.set(op.incr(1)).received
// @ts-expect-error a field write can be refused ('absent-row', 'absent-path', 'bad-shape'): no early stage
await f.data.k.n.set(5).replicated
// @ts-expect-error the array form of a field write too
await f.set(['k', 'n'], 5).replicated
// @ts-expect-error a condition answers at commit only
await f.data.k.set({ n: 2, tags: [] }, { if: { absent: true } }).replicated
// @ts-expect-error a conditional remove too
await f.data.k.remove({ if: { present: true } }).received
// @ts-expect-error read-decide-write is judged: no early stage
await f.data.k.set((row) => row && { ...row, n: row.n + 1 }).received
// @ts-expect-error a batch is all or none: no early stage
await f.batch([{ key: ['a'], value: { n: 1, tags: [] } }]).received
// @ts-expect-error a named write is judged (the name may be taken): no early stage
await f.data.k.set({ n: 4, tags: [] }, { once: 'order-77' }).received
// @ts-expect-error a named remove too
await f.data.k.remove({ once: 'order-78' }).replicated
// @ts-expect-error a marked write answers at commit only: it can be skipped at its mark (V5-11 ruling 6)
await derive(f, f, (x) => f.data.a.set({ n: 1, tags: [] }, { from: x }).received)
// @ts-expect-error a marked write takes no `once` name: the mark already makes it count once (section 3.11)
await derive(f, f, (x) => f.data.a.set({ n: 1, tags: [] }, { from: x, once: 'o' }))
// @ts-expect-error nor a marked field write in the array form
await derive(f, f, (x) => f.set(['a', 'n'], op.incr(1), { from: x, once: 'o' }))
// @ts-expect-error nor a marked remove
await derive(f, f, (x) => f.data.a.remove({ from: x, once: 'o' }))
// @ts-expect-error the row after and before come only with { rows: true } (V5-15 pick 4)
await derive(f, f, (x: Entry<N>, r: { row: N | undefined }) => r)
await derive(f, f, (x, { row, prev }) => (row?.n ?? 0) - (prev?.n ?? 0), { rows: true })   // the record form with rows
// @ts-expect-error a ttl belongs to a row: a field lens has no touch
await f.data.k.n.touch()
// @ts-expect-error nor a ttl on a field write (V5-15 pick 7)
await f.data.k.n.set(4, { ttl: '1m' })
// @ts-expect-error nor a session lifetime
await f.data.k.n.set(4, { while: 'session' })
// @ts-expect-error a field item of a batch takes no ttl either
await f.batch([{ key: ['k', 'n'], value: 4, ttl: '1m' }])
await f.data.k.n.set(3, { if: { equals: 4 } })           // a field guard: this field only (V5-15 pick 5)
await f.data.k.n.set((x) => (x ?? 0) + 1)                // set(fn) on a field: guarded by the field
// @ts-expect-error set(fn) brings its own guard: no if
await f.data.k.n.set((x) => (x ?? 0) + 1, { if: { equals: 1 } })
// @ts-expect-error the root spans partitions, so no write there; the type's text names the way (V5-15 pick 3)
await f.data.set({ k: { n: 1, tags: [] } })
// @ts-expect-error nor a remove of everything
await f.data.remove()
// @ts-expect-error a typed handle's steps are read-only, so assignment does not compile: typed code writes with set (V5-12 pick 6)
f.data.k = { n: 1, tags: [] } as any
const j: Judged = f.data.k.set({ n: 2, tags: [] }, { if: { absent: true } })
const acks = await Promise.all([f.data.a.set({ n: 1, tags: [] }), f.set(['b'], { n: 2, tags: [] }), j])   // handles await together
// @ts-expect-error the stage is what you await, never a write option
await f.data.k.set({ n: 3, tags: [] }, { confirm: 'received' })
// @ts-expect-error no commit level per write (V5-5)
await f.data.k.set({ n: 3, tags: [] }, { durability: 'memory' })
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
if (v) await f.data.k.set({ n: 2, tags: [] }, { if: { version: v satisfies Version } })
await f.data.k.set({ n: 4, tags: [] }, { once: 'order-77' })   // a caller's name for the write
await f.set(['k', 'at'], op.now('15m'))                  // the array form: writer time, plus 15 minutes
// @ts-expect-error incr takes a number
op.incr('1')
const held: number = await lock('l', async (l) => { await f.data.k.set({ n: 5, tags: [] }, { if: { lock: l } }); return 1 })
// @ts-expect-error a saga step takes a lens, not a key
await saga([{ key: 'a', value: 1 }])

// ── rooms (V5-15 pick 3): room.set(rows) and room.remove() are the only room writes
type Msg = { text: string; stars: number; hidden?: boolean }
const chat = await fero<Msg, 2>('chat', { server: true, depth: 2 })
await chat.data.room1.set({ m1: { text: 'hi', stars: 0 } })   // replace a room: one batch, one log entry
await chat.data.room2.remove()                           // empty a room: one batch
await chat.data.room1.m7.set({ text: 'hi', stars: 0 })   // a row of room1
// @ts-expect-error a room is replaced by rows, not by one row
await chat.data.room1.set({ text: 'hi', stars: 0 })
// @ts-expect-error a room write takes no ttl
await chat.data.room1.set({}, { ttl: '1m' })
// @ts-expect-error every value given to a room is a row: no undefined
await chat.data.room1.set({ m1: undefined })
// @ts-expect-error nor the array form at a room's key: a write path names a row or a field
await chat.set(['room1'], { m1: { text: 'hi', stars: 0 } })

// ── reads (V5-13) and reads at any path (V5-15)
type Part = { stock: number; title: string }
const parts = await fero<Part>('parts')                  // a bare client, typed by its rows
const stock = parts.data.widgets.stock                   // an address: no trip, no read
const n1: number | undefined = await stock.get()         // the read is a verb
// @ts-expect-error a lens is never a promise: awaiting it gives the lens back, not a value
const n2: number | undefined = await stock
// @ts-expect-error nor is a root lens: awaiting it gives no rows (the case that once downloaded 100,000 rows)
const all2: Rows<Part> = await parts.data
// @ts-expect-error a lens that went through Promise.resolve is still an address, never a row
const viaResolve: Part | undefined = await Promise.resolve(parts.at('widgets'))
// @ts-expect-error the thenable trap: a handle is not thenable, so `await connect()` gives the handle, not the row
const row1: Part | undefined = await parts.data.widgets.connect()
// @ts-expect-error ... and it has no then(): read once with get()
parts.data.widgets.connect().then((r: Part) => r)
// @ts-expect-error get takes no key: the step by a key is at(key), then get()
await parts.data.get('widgets')
// @ts-expect-error get at a position hides a fold of the log: as it was is past(pos)
await parts.data.widgets.get({ at: v })
// @ts-expect-error `from` on connect: every commit from a place is the log, changes({ from }), or a past() window
parts.data.widgets.connect(draw, { from: v })
// @ts-expect-error `at` on connect: connect is now; as it was is past(pos)
parts.data.widgets.connect(draw, { at: v })
// @ts-expect-error a read once is get(), not connect({ once })
parts.data.widgets.connect({ once: true })
// @ts-expect-error a handle made with a callback is not also a loop (one handle cannot get break right for both)
for await (const x of parts.data.widgets.connect(draw)) console.log(x)
// @ts-expect-error the log looped as live state: a log entry is one record, with no state to destructure
for await (const [rows] of chat.data.room1.changes()) console.log(rows)
// @ts-expect-error live state looped as the log: a turn is [value, c], the newest state; it has no per-record version
for await (const t of chat.data.room1.connect()) console.log(t.version)
// @ts-expect-error a log entry has no prev: the log is every record, not a folded state
for await (const en of parts.data.changes()) console.log(en.prev)
// @ts-expect-error a loop turn merges commits: it has no wire records to forward; use connect(fn) or changes()
for await (const [, c] of chat.data.room1.connect()) ws.send(c.text())
// @ts-expect-error rows handed to a function are frozen: read-only
parts.data.widgets.connect((wr, c) => { c.diff[0]!.prev = undefined })
// @ts-expect-error c.changes is c.diff, so "changes" names only the log
parts.data.widgets.connect((wr, c) => c.changes)
// @ts-expect-error a whole-resource commit has no single id (no order across partitions): save c.cursor
chat.data.connect((rooms, c) => console.log(c.version))
// @ts-expect-error a count back names one partition: on the root give a time, new Date(...)
chat.data.changes({ from: -5 })
// @ts-expect-error ... and so does a version: it names one partition's commit, and does not say whose
chat.data.changes({ from: v })
// @ts-expect-error a time is a Date, never a bare number: inside one partition a number would be a count back
parts.data.widgets.past(Date.now() - 3_600_000)
// @ts-expect-error ... the same on the log
chat.data.room1.changes({ from: Date.now() - 60_000 })
// @ts-expect-error a count back is a literal: a value typed number is refused (it is most often a time)
chat.data.room1.changes({ from: -n1! })
// @ts-expect-error a count back is negative: -5 is 5 commits back
chat.data.room1.changes({ from: 5 })
// @ts-expect-error past() reads one partition: on the root it would fold every partition; read the log from a time
parts.data.past(new Date('2026-11-19T12:00:00Z'))
// @ts-expect-error past() is a promise of the value: await it first, (await lens.past(v)).value
console.log(parts.data.widgets.past(-1).value)
// @ts-expect-error `until` takes a thing that says it closed; a place to stop the log at is `to`
chat.data.room1.changes({ from: -5, until: 'latest' })
// @ts-expect-error a DOM node never says it closed, so `until` refuses it: pass a signal, or disconnect()
parts.data.widgets.stock.connect((s) => { el.textContent = String(s) }, { until: el })
// @ts-expect-error ... and a plain emitter: it cannot say it already closed, so a late one would never end the link
parts.data.widgets.connect(draw, { until: emitter })
// @ts-expect-error an HTTP request may say it closed once its body is read, while the client stays: pass the response
parts.data.widgets.connect(draw, { until: req })
parts.data.widgets.connect(draw, { until: res, signal })   // the first of the two ends it, and drops the other's listener
// @ts-expect-error one live verb: here, tap and on are gone; connect(fn) does their job
parts.data.widgets.tap(draw)
// @ts-expect-error asOf is past: one partition as it was, a value
parts.data.widgets.asOf(v)
// @ts-expect-error a lens is not a store: connect(fn)
parts.data.widgets.subscribe(() => {})
// @ts-expect-error f.rows is gone, on every role (V5-16): the one sync read is a live handle's value, f.data.connect()
f.rows.k
// @ts-expect-error f.snapshot is gone: h.value[k] for one row; a copy is a spread you write
f.snapshot
const heldAll = await fero<Part>('parts', { hold: 'all' })   // every row held, said at the open
// @ts-expect-error nor an f.value: read every row through a handle; heldAll.data.connect() shares the held rows
heldAll.value
const everyRow = heldAll.data.connect()                  // no new SUB: it shares the open's selection (3.10)
const w1: Part | undefined = everyRow.value.widgets      // a sync read: a live handle's value, one lookup
everyRow.disconnect()                                    // the rows stay: the open's hold: 'all' still holds them
// @ts-expect-error a lens has no sync read: .value is a step to a field named value, and Part has none
parts.data.widgets.value
// @ts-expect-error a probe name reads undefined: a row named 'then' is f.at('then')
parts.data.then.get()
// @ts-expect-error a function cannot travel to a server: connect() first, then filter right of it
chat.data.room1.filter((m: Msg) => m.stars > 0).connect()
// @ts-expect-error limit left of connect(): a window there is za(field, n)
chat.data.room1.limit(10).connect()
// @ts-expect-error by() left of the line takes a field, not a function
chat.data.room1.by((m: Msg) => m.text).length().connect()
// @ts-expect-error a lookup holds another resource's rows here: not left of the line
chat.data.room1.lookup(parts.data, 'text').connect()
// @ts-expect-error sum takes a number field only
chat.data.room1.sum('text').connect()
// @ts-expect-error eq, in and by take scalars: an object never equals by value
chat.data.room1.eq('hidden', { a: 1 }).connect()
// @ts-expect-error range filters take a number field and number bounds: not a string
chat.data.room1.gt('text', 'm').connect()
// @ts-expect-error an operator over every row, on a client that holds nothing: call a view the server named
parts.data.za('stock', 10).connect()
const best = chat.data.room1.gt('stars', 0).za('stars', 10).connect()   // plain data left of connect(): may run on a server
const mine = chat.data.room1.connect().filter((m) => m.stars > 0)         // a function right of connect(): runs here
for await (const en of parts.data.widgets.stock.changes({ from: -5 })) console.log(en.value)   // a field's log: on its path (V5-15)
const back5 = -5, last5 = chat.data.room1.changes({ from: back5 })       // a const holding -5 is a count
f.cluster.value.links.forEach((l) => console.log(l.path, l.count))  // the links this process has open, by path
// @ts-expect-error the open-links list is `links` (V5-17): `open` is gone
f.cluster.value.open
const inFlight: number = f.cluster.writes.value.length   // this process's own writes: a sync read
f.cluster.connect((shape) => draw(shape.health), { signal })   // the shape a microtask after the call, then each change
// @ts-expect-error snapshot() is gone (V5-16): the cluster is this process's own state; read f.cluster.value
f.cluster.snapshot()
// @ts-expect-error ... and on its writes: f.cluster.writes.value
f.cluster.writes.snapshot()
// @ts-expect-error no get() on the cluster: its value is already here, so a promise would wait for nothing
await f.cluster.get()
// @ts-expect-error members are learned from a server: undefined until one answers, never {} in place of members elsewhere
console.log(f.cluster.value.members.s1)

// ── the types carry through: each line fails to compile if a type is any or wrong
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type ItemOf<I> = I extends AsyncIterable<infer T> ? T : I extends Iterable<infer T> ? T : never
const rowLive = parts.data.widgets.connect(), rowLink = parts.data.widgets.connect(draw), roomLive = chat.data.room1.connect()
const audit = await parts.data.widgets.past(-5, { to: 'latest' })
const t1: Eq<Awaited<ReturnType<typeof parts.data.widgets.get>>, Part | undefined> = true          // get: the row
const t2: Eq<typeof rowLive, Live<Part | undefined, Part, true>> = true                            // connect(): a handle and a loop
const t3: Eq<typeof rowLink, Link<Part | undefined, Part>> = true                                   // connect(fn): a handle, not a loop
const t4: Eq<ItemOf<typeof roomLive>, [value: Rows<Msg>, c: Turn<Msg, true>]> = true               // a loop turn: [value, c]
const t5: Eq<ItemOf<ReturnType<typeof chat.data.room1.changes>>, Entry<Msg>> = true                 // the log: one record
const t6: Eq<ItemOf<ReturnType<typeof parts.data.widgets.stock.changes>>, FieldEntry<Part, number | undefined>> = true   // below a row: the value too
const t7: Eq<ItemOf<typeof audit>, [value: Part | undefined, c: Commit<Part, true>]> = true         // a past walk: [value, c]
const t8: Eq<ReturnType<typeof audit.step>, Past<Part | undefined, Part> | undefined> = true        // a step: a new value
const t9: Eq<Commit<Part>['cursor'], Cursor> = true                                                 // every commit has a place
const t10: Eq<Commit<Part, true>['version'], Version> = true                                        // inside one partition, an id
const t11: Eq<'version' extends keyof Commit<Msg, false> ? true : false, false> = true              // a whole resource: no one id
const t12: Eq<ReturnType<typeof chat.data.changes>, Changes<Entry<Msg>>> = true

// ── methods: declared where they may be called; root methods on f.data; views and pages (V5-13 pick 6, V5-14)
const bank = await fero('bank', { data: { ada: { cents: 0 } }, methods: {
  deposit: { at: 'row', run: async (n: number, ctx) => (await ctx.at.cents.set(op.incr(n))).value as number },
  ping: (_, ctx) => ctx.peer,
  rich: { view: (min: number, ctx) => ctx.data.gte('cents', min).za('cents', 10) },
} })
const n: number = await bank.data.ada.deposit(5, { once: 'dep-1' })
// @ts-expect-error the argument is a number
bank.data.ada.deposit('5')
// @ts-expect-error deposit needs its argument
bank.data.ada.deposit()
// @ts-expect-error an action's answer has no live form
bank.data.ada.deposit(5).connect()
const who: string = await bank.data.ping()               // a root action, on the root lens; an untyped argument may be left out
const rich = bank.data.rich(100).connect()               // a view the server named: an address, then a link
const richRows: readonly { cents: number }[] = rich.value
// @ts-expect-error a view is an address: it takes no { once }, and it is not awaited
bank.data.rich(100, { once: 'x' })
// @ts-expect-error f.methods is gone: a root method is called on f.data
bank.methods.ping()
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
// @ts-expect-error a method declared `at: 'row'` is not offered at the root: there `deposit` is a step to a row
await typed.data.deposit(5)
// @ts-expect-error a root method is not offered on a path
typed.data.ada.ping()
await typed.data.ada.call('deposit', 5)                  // by name, where the method is declared
// @ts-expect-error call() is checked against where a method may be called: a root view is not callable on a path
typed.data.ada.call('rich', 5)
// @ts-expect-error a row method is not callable on a field
typed.data.ada.cents.call('deposit', 5)
// @ts-expect-error nor on the root lens
typed.data.call('deposit', 5)
// @ts-expect-error an unknown method name is refused here, with no trip ('no-such-method')
typed.data.call('refund', 5)
// at depth 2, `at: 'row'` and `at: 'partition'` name different lenses
const rooms = await fero.of<Msg, 2>()('rooms', { depth: 2, methods: {
  pin: { at: 'row', run: (_: undefined, ctx) => ctx.at.stars.set(op.incr(1)) },
  clear: { at: 'partition', run: (_: undefined, ctx) => ctx.at.remove() },   // a room's own write: one batch
} })
await rooms.data.r1.m7.pin()
await rooms.data.r1.clear()
// @ts-expect-error at depth 2 a row method is not offered on a partition
rooms.data.r1.pin()
// @ts-expect-error and a partition method is not offered on a row
rooms.data.r1.m7.clear()
await fero.of<Part>()('names', { methods: {
  // @ts-expect-error a method named like a fero verb where it is called (connect, on a row) is refused where it is declared
  connect: { at: 'row', run: (k: number, ctx) => ctx.at.stock.set(k) },
  // @ts-expect-error nor an operator's name at the root ('bad-name' when the server opens)
  za: { view: (k: number, ctx) => ctx.data.za('stock', k) },
  best: { view: (k: number, ctx) => ctx.data.za('stock', k) },
} })
await fero.of<{ cents: number }>()('wallet', { methods: {
  pay: { at: 'row', run: async (n: number, ctx) => ((await ctx.at.get())?.cents ?? 0) >= n },   // local at the leader
  // @ts-expect-error ctx.rows is gone (V5-16): read the called row once, await ctx.at.get(), local at the leader
  peek: { at: 'row', run: (_: null, ctx) => ctx.rows },
} })
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
const loose = await fero<Acct>('till')                  // typed by its rows only: its calls go through call(), untyped
await loose.data.call('pay', 'anything')
await loose.data.a.call('pay', 'anything')               // on a path, by name
const u = await fero('u')                               // untyped: assignment compiles; nothing is checked
u.data.k = { any: 'thing' }
delete u.data.k

// ── served views and pages (V5-14): bounded, blind to the caller, one resource
const fans = await fero<Fans>('fans'), orders = await fero<Orders>('orders'), products = await fero<Products>('products')
const top = fans.data.best(10).connect()
const t13: Eq<typeof top.value, readonly Fan[]> = true                                              // a window: rank order
const t14: Eq<Awaited<ReturnType<ReturnType<typeof fans.data.byTeam>['get']>>, ReadonlyMap<string, number>> = true   // buckets: a Map
// @ts-expect-error a served view takes no operators left of the line
fans.data.best(10).za('points', 3)
// @ts-expect-error a served view is an address, not a promise: get() it
const wrongRows: readonly Fan[] = await fans.data.best(10)
// @ts-expect-error only an ordered answer has order changes
fans.data.total(null).connect((t, c) => draw(t, c.order))
// @ts-expect-error a lookup's other side is a row, null (none) or undefined (loading): check before use
orders.data.ada.connect().lookup(products.data, 'sku').connect((rows) => draw(rows.o1?.other.price))
// @ts-expect-error a lookup's field must be a field of the row
orders.data.ada.connect().lookup(products.data, 'nope')
// @ts-expect-error over every row at depth 2 a page cursor names (partition, row)
await orders.data.byCents(null).page([500, 'o1'])
type Item = { stock: number; title: string; team: string; on: boolean }
const items = await fero<Item>('items', { server: true })
// @ts-expect-error derive's view form takes one value per bucket: group's buckets are as big as the rows
await derive(items.data.group('team'), f)
// @ts-expect-error derive's view form needs the target's row type (f holds { n, tags }, not numbers)
await derive(items.data.by('team').sum('stock'), f)
// @ts-expect-error derive's view form names target rows by a string or number bucket: not by a boolean field
await derive(items.data.by('on').length(), await fero<number>('counts', { server: true }))
await derive(items.data.by('team').sum('stock'), await fero<number>('byTeam', { server: true }))   // the view form
export const shop = await fero.of<Item>()('shop', { methods: {
  lowest: { view: (n: number, ctx) => ctx.data.lt('stock', 5).az('stock', n) },   // a window: bounded
  // @ts-expect-error unbounded rows: a served view ends in a window, an aggregate, or buckets
  low: { view: (max: number, ctx) => ctx.data.lt('stock', max) },
  // @ts-expect-error limit over unordered rows follows this copy's arrival: a failed-over view would differ
  firstSeen: { view: (n: number, ctx) => ctx.data.limit(n) },
  // @ts-expect-error group is as big as the rows: count with by(field).length()
  everyone: { view: (_: null, ctx) => ctx.data.group('team') },
  // @ts-expect-error one served view per cursor builds an index of every row per cursor: declare { pages }
  after: { view: (cur: readonly [number, string], ctx) => ctx.data.za('stock', 20, { after: cur }) },
  // @ts-expect-error { pages } returns one sorted list
  bucketPages: { pages: (_: null, ctx) => ctx.data.by('team').length() },
} })
export const leaks = await fero.of<Item>()('leaks', { methods: {
  // @ts-expect-error a served view is shared by equal calls: it cannot read who called (its ctx has no claims)
  leak: { view: (n: number, ctx) => ctx.data.eq('title', ctx.claims?.sub ?? '').az('stock', n) },
  // @ts-expect-error a served view reads one resource: join in a handler, or derive the joined rows
  joined: { view: (_: null, ctx) => ctx.data.lookup(products.data, 'title').length() },
} })

// ── options fixed at founding, and names that went
// @ts-expect-error the depth is fixed at founding
await fero.alter('f', { depth: 2 })
// @ts-expect-error the depth is 1 or 2
await fero('x', { server: true, depth: 3 })
// @ts-expect-error a seed is applied once, at founding
await fero.alter('f', { data: {} })
// @ts-expect-error `{ before }` is gone: the first key is the partition (V5-12 pick 4)
await fero('x', { server: true, partition: { before: '/' } })
// @ts-expect-error `hold: 'asked'` is gone: holding what the links name is the default (V5-12 pick 1)
await fero('x', { hold: 'asked' })
// @ts-expect-error copies: 2 cannot keep a majority through one loss
await fero('x', { server: true, copies: 2 })
// @ts-expect-error a history is a number of records, a time or a size
await fero('x', { server: true, history: '7 days' })
// @ts-expect-error a stream keeps no rows (rows: false): there is no state to connect to; read its log
await fero<Msg>('news', { server: true, rows: false }).then((s) => s.data.x.connect())
console.log(cond, acks, held, n1, n2, all2, viaResolve, row1, best, mine, last5, t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11, t12,
  n, who, rich, richRows, n3, t13, t14, wrongRows, w1, inFlight)
```

The checker writes every `// file:` block to a fresh folder and runs `tsc` against data's `types/public.d.ts`. Then, in a copy where each `@ts-expect-error` is a plain comment, each line it marks must fail at its own line, and nothing else may (the strip proof, as on CONNECT.md, TRANSFORMS.md and ANYPATH.md):

```js check
// API.md checker: every ```ts block whose first line is "// file: <name>" is written to a fresh folder and
// type-checked with tsc against data's shipped types (DATA names data's folder; ../data by default). Then, in a
// copy where each @ts-expect-error is a plain comment, each line it marks must fail, and nothing else may (the strip proof).
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const blocks = [...readFileSync(process.argv[1], 'utf8').matchAll(/^```ts\n(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)^```$/gm)]
  .map(([, body, name]) => [name, body])
const data = resolve(process.env.DATA ?? '../data')
const root = mkdtempSync(join(tmpdir(), 'fero-api-'))
const compilerOptions = { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true,
  types: [], lib: ['es2022', 'dom'], paths: { fero: ['./fero.d.ts'], data: [join(data, 'types/public.d.ts')] } }
const put = (dir, strip) => {
  const marked = []
  mkdirSync(dir)
  for (const [name, body] of blocks) {
    const lines = body.split('\n')
    if (strip) lines.forEach((l, i) => {
      if (l.includes('// @ts-expect-error')) { marked.push(`${name}:${i + 2}`); lines[i] = l.replace('@ts-expect-error', '(must fail below)') }
    })
    writeFileSync(join(dir, name), lines.join('\n'))
  }
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: blocks.map(([name]) => name) }))
  return marked
}
put(join(root, 'page'), false)
console.log(`${blocks.length} blocks → ${join(root, 'page')}`)
execFileSync('tsc', ['-p', join(root, 'page', 'tsconfig.json')], { stdio: 'inherit' })
console.log(`ok: ${blocks.length} blocks type-check (tsc ${execFileSync('tsc', ['-v']).toString().trim()})`)
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
node --input-type=module -e "$(awk '/^```js check$/{f=1;next} /^```$/{f=0} f' docs/v5-space/API.md)" docs/v5-space/API.md
```

**Result, run here on 2026-11-21, after the V5-17 amendment** (Node v22.22.0, TypeScript 6.0.2, data at 63fea66): `ok: 42 blocks type-check (tsc Version 6.0.2)`, then `147 marked lines, 147 fail at their own line, 0 errors elsewhere`. The one new line is the cluster's `open`, now `links`.
- **Where the 147 are:** 139 in `types.ts`, six in `client.ts`, one in `p12.ts` and one in `p14.ts`. Each fails for the reason its comment gives:

| `types.ts` group | The wrong uses | tsc |
|---|---|---|
| writes and their handle | an early stage on a judged write (an op, a field write, a condition, `set(fn)`, a batch, a named or marked write); `{ from: e, once }`; a typed value that is wrong; an opaque version given as text | TS2339: no `received` or `replicated` on `Judged`; TS2769 and TS2322 on the overloads and the row type; TS2322: a string is not a `Version` |
| paths (V5-15) | the row after and before without `{ rows: true }`; `touch`, `ttl` and `while` on a field, a field `batch` item with `ttl`; `set(fn)` given its own `if`; a write or a remove at the root; assignment on a typed handle | TS2769 (with TS7006 on the same line); TS2339; TS2322 against `BatchWrite`; TS2349: the root's `set` is a `Steer` whose text names `fero.drop`; TS2542: read-only |
| rooms | a room set to one row, with `ttl`, with an `undefined` row; `f.set([room], …)` | TS2322: a string is not a `Msg`; TS2353; TS2322; TS2769 |
| reads (V5-13) | `await` a lens, a root lens, a lens through `Promise.resolve`, a handle; `.then` on a handle; `get(key)`; `get({ at })`; `from`, `at` and `once` on `connect`; a loop over a callback handle; the log looped as state and state as the log; `prev` on an entry; `text()` on a loop turn; changing a frozen row; `c.changes` | TS2322 and TS2739: a lens or a handle is not a row; TS2339: no `then`; TS2769; TS2322 against the `Steer` that names `changes()` and `past()`; TS2504; TS2488; TS2339; TS2349; TS2540; TS2339 |
| positions | `-5` and a version on the root; a bare number as a time; a count typed `number`; a positive count; `past` on the root; `.value` on `past(…)` before `await`; a place in `until` | TS2322 on `Pos<false>`, whose text says a version or a count back names one partition; TS2345 and TS2322: "a time is a Date"; "a count back is negative"; TS2349; TS2339 on a `Promise`; TS2322 |
| ends | `until` with a DOM node, a plain emitter, an HTTP request | TS2322: not `Closes` (a request has a `method`) |
| words that went | `tap`, `asOf`, `subscribe`, `f.snapshot`, a row named `then`, the cluster's `open` (now `links`, V5-17) | TS2339; TS2349 (`subscribe` is a `Steer`); TS18048: a probe name reads `undefined` |
| sync reads (V5-16) | `f.rows` on a server; `f.value` with `hold: 'all'`; `.value` on a lens; `snapshot()` on the cluster and on its writes; `get()` on the cluster; `members` read with no check for `undefined`; `ctx.rows` | TS2339; TS18048 on `members` |
| the line | `filter`, `limit`, `lookup` left of `connect()`; `by(fn)`; `sum('text')`; `eq` on an object; `gt` on a string; an operator over every row on a bare client | TS2349 with the fix in the type's text; TS2345 against `ScalarF` and `NumF` |
| methods | a wrong or missing argument; `connect()` on an action's answer; a view given `{ once }`; `f.methods`; the door client's `set`, `remove`, `touch`, `batch`, `at().set`, `mark`, `claim`; a row method at the root or on a field; a root method on a path; `call()` with a name not allowed there, or unknown; the depth-2 `at:` cases; a method named `connect` or `za`; `fero<Row>(name, { methods })` | TS2345; TS2554; TS2339; TS2349; TS2345 on `call()`'s names; TS2322 on the method, with the `NoClash` text; TS2769 |
| served views and pages (V5-14) | an operator after a served view; `await` a served view; `c.order` on a scalar; a lookup's `other` used unchecked; a lookup on a missing field; a 2-part cursor at depth 2; `derive` of `group`, into the wrong target, by a boolean; a `{ view }` unbounded, of `limit`, of `group`, of a page after a cursor; `{ pages }` over buckets; a view that reads `claims`; `lookup` inside a view | TS2339; TS2740; TS2339; TS18049; TS2345; TS2345; TS2345 against the view form; TS2322 on the method, with `CheckViews`' text; TS2339: no `claims` on `ViewCtx`; TS2349 |
| options | `depth` and `data` in `fero.alter`; `depth: 3`; `{ before }`; `hold: 'asked'`; `copies: 2`; a history in words; `connect()` on a stream | TS2353; TS2769; TS2349: a stream's lens has no state |

- **Several must-fail lines fail for a reason the types cannot say in words.** A step named like a verb (`shop.data.sell(1)` at the root, `f.data.set(…)`, a row method on a depth-2 partition) fails with "This expression is not callable": on those lenses the name is a step to a row or field of that name, and a lens is not callable. Where a `Steer` is involved, its text in the message names the fix.
- **Some messages name the wrong member.** A `batch` item with a wrong whole-row value fails, but tsc's message speaks of the item's `key`: it reports the field form, the last member it tried. Four option lines in `types.ts`, `depth: 3`, `{ before }`, `copies: 2` and `history: '7 days'`, fail with TS2769, whose shown text is the last overload's and blames `server: true`. Each fails for its stated reason: with only that option made valid, each line compiles (a control run).
- **Kept from the 2026-11-18 pass.** `fero<Row>(name, { methods })` does not compile; a mark and a `once` name exclude each other; `call()` takes only the methods that kind of lens may call; a typed client of a resource with methods has no writes, `mark` or `claim`.
- **Found while the declarations were merged.** A client typed by a server's exported type was `never` until the role was inferred from a phantom on the handle, not from the whole handle; and `migrate` refused a server's handle until it took any handle with a root lens.
- **What the types here do not check**: section 6's list, and section 7's rules.
- **Not checked here: that any of it runs.** [E-55] built the lens small, [E-56] `connect`, [E-57] the transformations, [E-58] the path rules; [E-22] ran the patterns under an earlier spelling. Nothing on this page is built.

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
[E-56]: experiments/E56-one-connect/README.md
[E-57]: experiments/E57-transforms/README.md
[E-58]: experiments/E58-any-path/README.md
