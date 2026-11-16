# fero v5: the public API

Rewritten 2026-11-16 for the design the owner chose ([DECISIONS V5-1 to V5-11][dec]; [VERDICT 11.7](VERDICT.md)).

**This page replaces COMP2's API** of 2026-11-11. Git history keeps that one (`git log -- docs/v5-space/API.md`). COMP2 was the study's earlier pick: Raft groups owned by the project, a `#meta` group and one central loop. The owner set it aside (V5-2, V5-6).

- **What this page is.** What an app developer writes against fero v5, what each call promises, and what each call costs.
- **The design in one line.** A resource's truth is a log (V5-1). Each resource is its own small cluster, with its own Raft groups and its own settings in its own log (V5-2). Every write commits on disk at a majority before anyone can see it (V5-5). `data` folds the rows on every copy and on clients.
- **The aim of this pass.** The owner asked for an API that is as easy to guess as it can be, and that costs nothing in speed: no hidden copies, trips, decodes or whole-resource work. Three proposals were written from three angles (keep v4, guess first, show the cost), and this page takes the best answer to each question. [API-TOUR.md](API-TOUR.md) walks through the choices, for review.
- **For the layers under the surface:** [LAYERS.md](LAYERS.md). **For what each path costs:** [PATHS.md](PATHS.md).

**How each claim is marked.**
- **V5-n**: a decision in [docs/DECISIONS.md][dec]. **E-nn**: an experiment under [experiments/](experiments). **PATHS n**, **PA-n**: [PATHS.md](PATHS.md), a section or a finding. **MEMORY 9.n**: [MEMORY.md](MEMORY.md). **A-nn**: [AMENDMENTS.md](AMENDMENTS.md). **code:** a v4 file and line.
- **(proposed)**: new on this page. No experiment ran it. **(reasoned)**: an argument; nothing ran it.

**What comes when** (V5-5).
- **Built first, in TypeScript:** everything here except the two lines below. Every write commits on disk at a majority.
- **Built second:** the early answer stages, `received` and `replicated` (section 3.5). The write handle is there from the first build; until the stages are built, both resolve at the commit.
- **Built third, and only for a timed need the stages cannot meet:** a `memory` commit level per resource. It is not on this page. Nor is the no-disk kind of pub/sub (`durability: 'none'`). Both would be one resource key, and no call changes.

**How sure each part is.**
- **Type-checked here.** Every `ts` block whose first line is `// file: …` compiles with TypeScript 6.0.2 against data's shipped types. That includes all 22 patterns and the lines that must not compile. Section 12 has the command and the result.
- **Run on a prototype, under the earlier spelling.** [E-22] ran all 22 patterns on five kernel operations, with a leader change and a slot move forced into each. This page respells some calls; the respelled lines did not run.
- **Model-checked.** The rules under the surface: subscribe ([E-31]), retries ([E-20]), sagas ([E-24]), derived outputs ([E-30]), answer stages ([E-48]), founding and finding a resource ([E-51]), healing ([E-52]).
- **Measured.** The costs are [PATHS.md](PATHS.md)'s and the experiments'. Most whole-path totals there are sums of measured parts. No v5 server was timed end to end (PATHS 8).
- **Read by a skeptic.** A second reader checked this page against its sources and against `tsc`, and made 31 findings. All 31 are applied here; the ones that are choices for the owner are questions in [API-TOUR.md](API-TOUR.md) section 5.
- **Nothing here is built.**

## 1. Words and layers

**Five words are enough to start.**

| Word | What it is |
|---|---|
| resource | a named, shared map of rows: `fero('shop')`. Every process that opens the name sees the same rows. Underneath it is a small cluster of its own (V5-2) |
| row | one entry of the map: a key and a JSON-like value |
| method | a function the resource's servers host. Clients change rows by calling it |
| view | a live result computed from rows: `shop.data.lt('stock', 5)` |
| partition | the rows that are kept in one order and can change together. By default each row is its own partition |

**Words you meet later.**

| Word | What it is |
|---|---|
| server, client | a **server** holds a copy of the resource and can lead part of it. A **client** only uses it. The role is per resource and comes from what the open declares (section 3.1) |
| copy | a server's full replica: the log on disk and every row in memory |
| leader | the one server that puts a partition's writes in order and judges them |
| commit | a write is on disk on most of the copies (a majority). Only then can anyone see it (V5-5) |
| stage | how far your own write has got when you hear back: `received`, `replicated`, then committed. A stage changes nothing the servers do (V5-11) |
| version | a row's place in its partition's order. Opaque text. A write's answer gives it; `if: { version }` takes it |
| cursor | a reader's place across many partitions. Opaque text you can save |
| writer time | the leader's clock, held to the median of the members' clocks, never going back. TTLs, leases and delays use it (V5-4) |
| trip | one message there and its answer back (a round trip). On one box about 40 µs at the median ([E-01]) |

**Words inside fero.** An app never names these. They show in `f.cluster`, in the debugger and in [LAYERS.md](LAYERS.md): **slot** (one of a resource's 4,096 fixed hash buckets; a partition hashes to one), **group** (one Raft log with one leader, holding some slots), **attempt** (one write and its retries), **session** (one process's life, held by a lease it renews by itself; it is what `while: 'session'` rows die with), **fold** (`data` applying the log's records to the rows in memory).

**The layers** are [LAYERS.md](LAYERS.md)'s. **L0** storage and I/O. **L1** the log: Raft per group, founding, the directory, healing. **L2** fold and ops: records to rows, conditions, ops, writer time, retries, expiry, answer stages. **L3** flow: `follow`, `changes`, cursors. **L4** the surface: `fero()` and this page's verbs. **L5** libraries, built only from L4: queue, lock, consumer, derive, saga, limiter, service, migrate, tape, the gateways and the CLI.

## 2. The shape on one screen

```ts
// file: shape.ts — the whole surface on one screen
import { fero, op } from 'fero'

const shop = await fero('shop', { data: { widgets: { stock: 10 } }, history: '1h' })   // a seed makes a server
shop.data.gadgets = { stock: 3 }                             // a write, no answer wanted: it shows when it commits
const w = shop.set('gizmos', { stock: 7 })                   // the same kind of write, with a handle
await w.received                                             // optional: the leader has it (a progress report)
const ack = await w                                          // committed: on disk on a majority, visible to all
const sold = await shop.set(['widgets', 'stock'], op.incr(-1, { min: 0 }))   // the leader computes it
const left = shop.rows.widgets?.stock                        // a read here: one lookup, no trip
const low = shop.data.lt('stock', 5)                         // a live view, kept here
low.tap(() => console.log('low', low.snapshot()))
const sure = await shop.get('gadgets', { fresh: true })      // a read at the leader: one trip
for await (const e of shop.changes({ from: 'earliest', until: 'latest' })) console.log(e.version, e.rec)
console.log(ack.version, sold.value, left, sure)
```

**Where each kind of line runs.**

| What you write | Where it runs | What it costs |
|---|---|---|
| a read with no `await`: `f.rows.k`, a view (`f.data.filter(…)`) | **here**, in this process's own rows. It never leaves this process | no trip, no disk, no copy |
| a change: an assignment, `f.set`, a method call | **at the partition's leader.** It is sent whether you `await` it or not; `await` only chooses when you hear back | one trip, and one shared disk sync on a majority |
| a read you `await`: `f.get` | **here** if the row is held; else at a copy (`fresh`: at the leader) | held: no trip. Else one trip |
| a stream you open: `f.follow`, `f.changes`, a method's `.open()` | **at a copy**, from the moment of the call, awaited or not | one trip to open, then bytes for what you selected |

**Five rules of thumb.**
1. **A read with no `await` never leaves this process.** It never touches the network and never guesses. If the row is not held here it throws `not-held`; it does not fetch.
2. **Anything that changes data, or opens a stream, sends a message.** `await` does not send it; it only waits. **Awaiting a write's handle means committed**: one trip to the leader and a share of one disk sync, about 1 ms on one box (MEMORY 9.3, computed from [E-02]). The handle's `received` and `replicated` are earlier progress reports for the few who want them (section 3.5).
3. **Make writes together, a few hundred at a time.** Make the writes, then await them together. They leave in one frame, share disk syncs and keep their order within a partition (PATHS 3.6; A-10). A client may hold 512 waiting writes; past that the next one is refused `backpressure` (section 3.6).
4. **A call with `()` that returns everything costs everything.** `f.data.snapshot()`, `f.changes({ from: 'earliest' })` and an open with `hold: 'all'` are the three. So do listing `f.rows`, and v4's `f.snapshot`. Nothing else walks a whole resource.
5. **A resource is a table, not a row.** Each one is a small cluster. Users and orders are rows of one resource, not a resource each (V5-2).

**Three places, one job each.** `f.rows` reads. `f.data` changes and watches: an assignment is a write, an operator is a live view. `f.methods` holds your own functions, and nothing else.

## 3. Using it, and what each call costs

### 3.1 Opening a resource: `fero(name, opts)`

```ts
// file: open.ts — roles by declared act, as in v4
import { fero } from 'fero'

const a = await fero('shop', { data: { widgets: { stock: 10 } } })   // a server: it brings the first rows
const b = await fero('shop', { methods: { ping: () => 'pong' } })    // a server: it hosts methods
const c = await fero('shop', { server: true })                       // a server: said plainly
const d = await fero('shop')                                         // a client: nothing but the name
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
- **A client with `hold: 'all'`:** once the first picture of every row has arrived and is folded. So a sync read on the next line is right. At 1,000,000 rows that is seconds (the table below).
- **A client with `hold: 'asked'`:** once it has reached a server and learned the leaders.
- **No server answers:** the open waits `connect.wait` (10 s), prints who is missing, and then resolves all the same. Writes made on that handle wait as `pending`; awaited reads wait; a sync read throws `not-held` ("no server of 'shop' reached yet") until the first picture comes. It never reads as an empty resource. (v4's rung 03 prints `{}` here; that line changes.)

**A server role is real work. Give it to a server process, not to every app process.**
- A server of a resource copies and folds its whole log, keeps a `dir` and syncs it, votes or stands by, takes the per-resource budget (about 8 KB idle, V5-8), and leaves the cluster on Ctrl-C.
- So the code that **creates** a resource (`server: true`, a seed, `methods`) belongs in the few processes meant to hold it. App code that only reads and writes opens the bare name, usually with `hold: 'asked'` (section 3.3). Section 10's patterns are written that way: a server file, then the app's lines.
- **Open for the owner:** creating a resource needs a server role in some process, because a resource is its own cluster and there is nowhere else to keep it (V5-2). The other way is an admin act (`fero create shop` on the CLI) that founds it on the machines that serve the project, so that no app file ever says `server: true`. See [API-TOUR.md](API-TOUR.md) section 5.

**What `await fero(…)` costs.**

| Case | Cost | Source |
|---|---|---|
| the first server of a new name (it founds the resource) | one create-if-absent in the store and one disk sync: about 5 ms on one box, about 35 ms across machines, once per resource for ever. The other copies join in the background | [E-49]; PATHS 5.11; V5-10 fix 1 |
| a server joining a resource that exists | it copies the log it lacks, then folds it: 1.3 to 3 µs a small row | PATHS 2.1, 5.1 |
| a client, cold | 2 to 3 trips and one commit when built well (7 to 9 trips and two commits as first drawn). A cold browser made its first committed write in 13 to 17 ms | PATHS 3.2 (PA-21); [E-40] |
| a client that holds the whole resource (the default) | also one picture of every row: its bytes on the wire, and a decode and a fold of each row here. **Then every later write to the resource is sent here too**, for as long as the handle is open | PATHS 4.5; section 3.3 |
| each resource a server holds, idle | about 8 KB of memory, about 30 KB in the first minute after a boot; no frames, no CPU that could be measured | V5-8; [E-49] |

So: **open a resource once, at start-up, and keep the handle.** `fero('doc:' + id)` would found a cluster per document. Use one `docs` resource, with a row or a partition per document.

**The options: ask of each one, who remembers it?**

| Scope | Who remembers | When it can change | Examples |
|---|---|---|---|
| **this process** | this process only | restart it | `listen`, `dir`, `rendezvous`, `secret`, `memory` |
| **the resource** | the resource's own log, so every copy and client agrees (V5-2) | `fero.alter(name, change)`, online | `partition`, `history`, `rows`, `copies`, `methods`, `validation` |
| **this open** | nobody: it is how this open behaves | the next open | `server`, `hold` |

- The open that founds the resource writes the resource options into its first log entry, with the seed (V5-10 fix 5). A later open that passes a different value is refused `config-differs`, and the hint names the key, both values and the `fero.alter` call. An open that leaves a key out takes the stored value.
- v4 does the same thing at the link: two servers whose values differ refuse to link and name the key (README, "The table").

### 3.2 Partitions: the row, a prefix, or a function

A **partition** is the unit of order. One leader puts all the writes of a partition in one order, and a `batch` can change several of its rows at once. Across partitions there is no order, ever.

```ts
// file: partition.ts — three ways to say which rows belong together
import { fero } from 'fero'

await fero('users', { server: true })                                  // default: each row is its own partition
await fero('chat', { server: true, partition: { before: '/' } })       // 'room1/m9' and 'room1/m10' share 'room1'
const byTenant = (key: string) => key.slice(key.lastIndexOf('.') + 1)  // code: 'report-7.acme' → 'acme'
await fero('docs', { server: true, partition: byTenant })
const docs = await fero('docs', { partition: byTenant })               // a client that can route by itself
console.log(docs.name)
```

| Form | Who can route by it | Cost |
|---|---|---|
| the row key (default) | everyone | none: a hash per write, nothing stored |
| `{ before: '/' }`: the key's text before the first `/` | everyone. It is plain data, kept in the resource's log, so a browser learns it too | **an index on every copy**, from each partition to its rows: memory per row and an update per fold (PA-17, a build note V5-9 takes). Without it, a room's first picture would scan every row: 26 to 28 ms at 1,000,000 rows, against 0.5 to 0.7 ms with the index |
| a function of the row key (V5-2) | servers, and any client that passes the same function | the same index, and the function runs on every write and keyed read, in the process that makes it: keep it pure, sync and cheap. A process **without** it cannot find the leader, so its writes take the forward path: **one more trip each** (V5-9; reasoned, no experiment ran a function) |

- A function is code, and code cannot travel. Every server must pass the same one; fero compares its text, as it does for `validation`. A different text is refused `config-differs`.
- **The partition rule is fixed when the resource is founded.** Changing it would move rows between orders (reasoned, from V5-2's rejection of a changing `% N`).
- **Each row as its own partition costs nothing**: a hash, and nothing stored. **A prefix or a function rule costs the index above**, on every copy. The number of partitions is free either way: use as many as you like.
- **A `follow({ prefix })` matches partition names by their start.** A hash cannot route that, so its first picture walks the partition names on a copy (or an ordered index of names, if one is built; PA-17 does not price one). Following one partition by name is the cheap form.
- **One partition is one leader's work.** Every write to it is judged in one place. A partition busier than one leader can serve must be split by the app ([E-18]).
- Prefer the prefix. It covers all 22 patterns, and every client can route by it.

### 3.3 `hold`: how much of the resource this open keeps

```ts
// file: hold.ts — what a client keeps in memory
import { fero } from 'fero'

const all = await fero('shop')                             // hold: 'all' (default, as v4): every row, kept live
const some = await fero('users', { hold: 'asked' })        // only rows it reads or follows
const capped = await fero('users', { hold: '200MB' })      // the same, inside a memory bound
console.log(all.rows, some.name, capped.name)
```

- **`hold: 'all'`** (the default, v4's behaviour). The open sends one picture of the whole resource, **and then every later write to it, for as long as the handle is open.** Sync reads and views work on everything. Cost: the resource's size in bytes, memory and decode time, once; then a decode and a fold here for every write anyone makes. At 1,000,000 small rows the first fold alone is seconds of this process's main thread (computed from PATHS 2.1).
  - So **a process that only writes, or reads a few rows, says `hold: 'asked'`.** A job that takes a lock and writes one row should not download the ledger first. Whether `'asked'` should be the default is a question for the owner (section 11.1).
- **`hold: 'asked'`**, or a size. The open sends no rows. A row's **partition** arrives when you `get` a row of it or `follow` it, and is kept live from then on (PATHS 4.4: the miss is the subscribe). A sync read of a row never asked for throws `not-held`.
  - **With no size, nothing is ever dropped.** Every key this process ever read, a key that names no row included, stays followed for the life of the handle. A process that reads many different keys gives a size: then the least recently read partitions are dropped when it is full.
  - To read a row once and keep nothing: `get(key, { hold: false })` (section 3.9).
- **A server holds every row** of the resources it serves (V5-6: `data` folds on every copy), as a voter or a standby. That is true for the first `copies + standbys` servers of a resource: 5 by default.
  - **A server past that number is a spare** *(this page's reading of LAYERS 8.4 and PATHS 4.4, which names the `moved` round trip "with more servers than `standbys`")*. It holds no copy until a leader's healing places one on it. Until then its reads behave like a client's with `hold: 'asked'`. What a spare does with a method call is not written; LAYERS owns it.
- At 80 % of the process's `memory`, health warns and names the fix: `hold: 'asked'`.
- *(proposed)* The COMP2 page spelled the second mode `cache: { memory: '200MB' }`: a memory size that also, without saying so, changed a client from "everything" to "only what I touch". `hold` names the choice itself. Nothing under it changes ([E-31]'s subscribe rules).

**Copies.** `copies: 3` (1, 3 or 5) is how many copies' disks decide a commit; the default is 3 once three servers exist, and 1 until then. With two servers, the second is a full copy that does not vote: two voters would stop writing when either one died *(this page's reading; LAYERS 8.2 step 9 agrees: a group grows from one voter to three only once two others can join, and a lone second server stays a learner)*. `standbys: 2` adds full copies that do not vote, so more servers read every row locally. Each leader heals its own group: when a copy dies it places a new one on a quieter machine (V5-2; V5-10 fixes 6 to 8). There is no call for it.

### 3.4 Writes

| Form | What it is | Answer |
|---|---|---|
| `f.data.k = row`, `f.data.k.stock = 4`, `delete f.data.k` | a write with no answer wanted | none. It shows when it commits (V4-7). A refused one never shows: it is a `refused` row of `f.cluster.writes` and one stderr line. If this client is full, the assignment itself throws `backpressure` (section 3.6) |
| `f.set(k, row)`, `f.set([k, 'stock'], 4)`, `f.remove(k)` | the same write, with a **handle** | the handle (section 3.5) |
| `f.batch([...])` | several changes to **one partition**, all or none | one handle, at the commit |
| `f.methods.name(arg)` | your function on a server (section 3.8) | its return value, after its writes commit |

**Assignment is `set` without the answer.** It is the same record on the same path. Use assignment when you do not need to know; use `set` when you do.

**v4's lens calls are the verbs under another name** *(changed by the skeptic's pass)*. `f.data.set(k, v)` is `f.set(k, v)`; `f.data.k.update(v)` and `f.data.k.remove()` are `f.set` and `f.remove`; `f.data.patch(pairs)` is one `set` per pair. Each returns the same handle its verb returns. So `await f.data.set(k, v)` waits for the commit, as it reads. They already go through the one write path (code: api/substrate.ts:339-360); in v4 they return nothing. The cost is one handle object per call, with no promise unless it is awaited.

**The write path** (PATHS 3.1, with V5-9's direct routing):
1. Here: the value is checked and encoded **once**. Those bytes are kept for resends and are what every link, journal and follower carry. No deep copy (PA-13).
2. One trip to the partition's leader. A client learns the leaders from the resource itself, so it sends there directly (V5-3, V5-9).
3. The leader judges the write, appends it, and sends it to the other copies.
4. A majority writes it to disk. One disk sync covers every write that arrived while the last sync ran, for every resource in that process ([E-12]).
5. The answer comes back. Every copy folds the write. Now readers can see it.

That is **2 trips and 1 disk sync on the path, the least any correct design can do** (PATHS 0). On one box, in TypeScript: 0.97 ms at the median, 4.45 ms at p99 (MEMORY 9.3).

**fero retries by itself**, and an attempt commits at most once ([E-20]). An app never resends a write. To make a write safe to send again from another process, give it a name: `f.set(k, v, { once: 'import-7:row-3' })`. A second write under that name within a day gets the first answer. A named write costs one commit, plus about 221 B at the leader for its day; and it answers at its commit only, because the name may already be taken (section 3.5).

### 3.5 What a write gives back: the handle and its stages

`f.set` and `f.remove` return a handle, not a bare promise (MEMORY 9.6; V5-5, V5-11). **Await the handle and you get the committed answer, always.** Code that never reads further is always safe.

The handle also has the two earlier stages as properties. You pick a stage by what you await. No option changes what the servers do.

```ts
// file: stages.ts — one write, three moments
import { fero, FeroError } from 'fero'

const clicks = await fero<{ n: number }>('clicks', { hold: 'asked' })   // it only writes: hold nothing
const w = clicks.set('page-1', { n: 1 })       // the write leaves with this turn's frame
const r = await w.received                     // the leader put it in its log (memory only)
const m = await w.replicated                   // a majority handed it to their operating systems
const ack = await w                            // committed: on disk on a majority; readers see it
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
- **Nobody sees the write before it commits.** Not even you, in a sync read (V4-7). A read you `await` waits for your own early-answered writes first ([E-48]'s rule Y).
- **Only a write that cannot be refused on state has early stages** (ruling 6). That is a whole-row `set` or `remove` with no `if` and no `once`. An op, a condition, a field write (it can be refused `absent-row`), a write with a `once` name (the name can be taken: `call-diverged`, `too-many-keys`), `set(key, fn)`, a `batch` and a method call answer at the commit only. The types say so: those return a `Judged`, which has no `received`. On a resource with `rules.write`, a plain write's early stages resolve at the commit, never before (reasoned: the types cannot see that key).
- **A stage the write never reached rejects with the write's own error** (MEMORY 9.6). A plain write can be turned away before the leader appends it: `methods-only`, `invalid`, `schema`, `forbidden`, `too-large`, `backpressure`, a closed gate. Then `w.received`, `w.replicated` and `w` all reject with that one error. Nothing is left waiting.
- **Once a stage has resolved, the handle never ends in a refusal.** It can still end in `timeout` or `unknown`, if the write can never commit. Section 11.2's Q-B1 has the three cases the records leave open. A failure nothing handles prints one stderr line, never Node's crash (MEMORY 9.6).
- **Ask in the turn that makes the write.** The leader sends an early report only for a write that asked (PATHS 3.3). Reading `w.received` is the asking. Read later, it still resolves, but maybe not before the commit (reasoned).
- **Early answers stay fast only while your unfinished writes fit your credit.** Past the number of writes a client may have in flight (A-07), the next early answer waits for an older commit (MEMORY 9.3).
- fero's own locks, sagas and queues never act on an early answer ([E-48]'s rule W1).
- **It costs nothing unless used.** A promise is made only for what you await (PA-13). The servers send no report nobody asked for.

**Against v4.** v4's `{ confirm: 'committed' | 'replicated' | 'persisted' }` changed how far the write had to get. In v5 every write goes all the way; you only choose when to stop waiting. v4's words would also mislead now: v4's `committed` was its weakest answer and `replicated` a stronger one (code: api/types.ts:10-16); in v5 it is the other way round. So the option goes and the handle comes.

### 3.6 Many writes: sending them together is the default

```ts
// file: many.ts — make the writes, then await them together
import { fero } from 'fero'
type Reading = { c: number }
const temps = await fero<Reading>('temps', { hold: 'asked' })           // it only writes: hold nothing
const rows: [string, Reading][] = [['a', { c: 20 }], ['b', { c: 21 }], ['c', { c: 19 }]]

const acks = await Promise.all(rows.map(([k, v]) => temps.set(k, v)))   // one frame per leader, shared disk syncs

for (const [k, v] of rows) await temps.set(k, v)                         // slow: one commit after another

for (let i = 0; i < rows.length; i += 256)                               // a bulk load: 256 at a time
  await Promise.all(rows.slice(i, i + 256).map(([k, v]) => temps.set(k, v)))

for (const [k, v] of rows) temps.data[k] = v                             // no answers; throws 'backpressure' when full
console.log(acks.length)
```

- **Writes made in one turn of the event loop leave in one frame per leader** (PATHS 3.6; v4 does it today, code: shell/runtime.ts:801-863). At the leader they share log entries and disk syncs: about 62 records per sync at 50,000 writes a second ([E-02]).
- **Order is kept without awaiting.** One process's writes to one partition commit in the order it made them (A-10).
- **`await` in a loop is the one slow shape.** Sixteen writes awaited one by one take about 15.5 ms; made together, about 1 ms (PA-40, computed).
- **There is a limit, and it is loud.** A client may have a granted number of writes in flight (its credit, A-07). On top of that it holds at most **512 waiting writes, or 64 MB** (LAYERS 4.2). Past that:
  - `f.set(…)` returns a handle that rejects `backpressure`, with `retryAfter`. So a `Promise.all` over 5,000 rows rejects.
  - **An assignment throws `backpressure`, there and then** *(proposed; the skeptic's finding)*. An assignment has no handle, and fero cannot retry a refusal from its own queue. A stderr line alone would have dropped the write without the code knowing.
  - So **a bulk load goes in chunks of a few hundred**, each awaited: the third form above. Each chunk still leaves in one frame per leader.
- **`batch` is not for speed. It is for all-or-none.** All its changes must be in one partition, or it is refused `cross-partition`. It is one log entry: every change commits or none does.
- **Across partitions** there is no all-or-none write. `saga()` is the unit there: 6 to 7 commits in a row, about 7 ms, and readers may see half of it (PATHS 3.7; [E-24]).

### 3.7 Writes the leader judges: ops, conditions, and `set(key, fn)`

A read-then-write done in your code has a gap between the two, and another writer can slip into it. v4's example 17 shows the lost increment. In [E-22], a plain read then a plain set sold the last item twice in 120 of 120 races. In v5 the leader can close the gap for you, three ways.

```ts
// file: judged.ts — let the leader decide
import { fero, op } from 'fero'
type Item = { stock: number; price: number }
const shop = await fero<Item>('shop', { hold: 'asked' })

const sold = await shop.set(['widgets', 'stock'], op.incr(-1, { min: 0 }))                // an op: refused 'conflict' at 0
const made = await shop.set('gizmos', { stock: 1, price: 5 }, { if: { absent: true } })   // a condition: create only
const up = await shop.set('widgets', (w) => w && w.price < 12 ? { ...w, price: 12 } : undefined)   // read, decide, write
console.log(sold.value, made.version, up?.version)
```

- An **op** (`op.incr`, `push`, `merge`, `max`, `min`, `now`) is computed by the leader on the newest state. The answer carries the result in `value`. Ops are values, so they work in assignment too: `shop.data.widgets.stock = op.incr(-1)`.
- A **condition** (`if: { absent | present | version | equals | lock | expired }`) is checked by the leader. If it fails, the write is refused `conflict`, with the row's `current` version.
- **`set(key, fn)`** *(proposed)* reads the row and its version, calls your function, and writes the result `if` the row is unchanged. If another write got there first, it reads again and calls your function again. `undefined` means "write nothing". After 8 tries it gives up with `conflict` (the number is a guess). **It can give up**; React's `setState(fn)`, which it looks like, cannot.
  - It is short for two calls that exist: `get(key, { version: true })`, then `set(key, next, { if: { version } })`. No new record, no new rule at the leader.
  - **A row that does not exist** is passed as `undefined`, and the write goes `if: { absent: true }`.
  - **Each retry first waits until this process has applied the version the refusal named** (`current`). The refusal counts as something this process has seen, so the next read cannot be older (section 7, "Reads"). Without this rule a local re-read could return the same old row 8 times in under a millisecond, and give up though nobody else was still writing.
  - Your function may run more than once. Keep it pure.
  - It is there so that the safe form is the short form.
- **Which one?** An op when one fits: many ops on one hot key share a commit and never retry (PATHS 3.5). `set(key, fn)` for everything else.
- **All three answer at the commit only** (section 3.5). A refusal also waits for the commit it was judged on, so nobody is refused because of a write that then vanished (A-04).

**Cost.** The same one trip and one disk sync as a plain write. Judging is at most 3 µs at the leader (a bar; not yet measured). `set(key, fn)` costs one such write per try; if this process holds the row, its read is local.

### 3.8 Methods: the door (V4-5)

Declaring `methods:` protects the resource, as in v4: clients then change data **only** through the methods. A client's plain write is refused `methods-only`, and the hint lists the methods. Reads stay open.

```ts
// file: methods.ts — the door
import { fero, op } from 'fero'

// ── server.ts: the seed gives the row type, so the methods' types are worked out too
export const shop = await fero('shop', {
  data: { widgets: { stock: 10, price: 10 } },
  methods: {
    sell: async (sku: string, ctx) => {
      const a = await ctx.set([sku, 'stock'], op.incr(-1, { min: 0 }))   // sold out, or no such sku: an error to the caller
      return { sku, left: a.value as number, price: ctx.rows[sku]?.price }
    },
    restock: { near: 'sku', run: ({ sku, n }: { sku: string; n: number }, ctx) => {
      ctx.data[sku].stock = op.incr(n)                                   // the reply waits for this commit
    } },
    low: (max: number, ctx) => ctx.data.lt('stock', max),                // returns a view: a client can open it live
  },
})

// ── client.ts: typed by the server's handle (`import type { shop } from './server.ts'`)
const customer = await fero<typeof shop>('shop')
const sale = await customer.methods.sell('widgets')
await customer.methods.sell('widgets', { once: 'order-981' })            // at most once, even across retries
// @ts-expect-error the typed client knows the methods: there is no such one
customer.methods.refund('widgets')
console.log(sale.left)
```

- **A handler is `(arg, ctx) => result`**, as in v4. `ctx` has the resource's own verbs and `data` and `rows`, plus who called (`ctx.peer`, `ctx.claims`).
- **The call answers after every write it made has committed.** Then the caller gets the return value. A call has no early stage (V5-11 ruling 6).
- **A method is not a transaction.** It is your code on a server. Each of its writes is judged at the one leader; the code between them is not locked. A handler's read can be old by the time its write lands. So **a check-then-set must be an op, a condition or `set(key, fn)`** ([E-22] C5, D15). `sell` above uses an op.
- **A throw** answers the caller `threw` with the message; writes made before it stay. A `FeroError` from a write inside (a sold-out `conflict`) reaches the caller as itself.
- **`{ once: name }`** makes a call run at most once; a retry, from any process, gets the first result. It costs three commits in a row (below).
- **`{ retry: true }`** stays from v4, and means something else: "this handler is safe to run twice, so send the call again if its server is lost" (code: api/methods.ts:549-575). It makes no claim and costs no extra commit. Without either option, a call whose server dies answers `unknown` and is not sent again.
- **A method that returns a view streams**, as in v4's example 09: `await` it for one picture, `.open()` it for a live mirror (section 3.10).
- **Typing a client** *(proposed)*: `fero<typeof shop>('shop')` types the rows and the methods from the server's exported handle, in one argument. `import type` keeps the server's code out of the client's bundle.
- **Typing the server.** TypeScript cannot take the row type from you and work out the methods' type in the same call. So there are three honest forms, and one that does not compile:
  - a seed gives the row type: `fero('shop', { data: {…}, methods: {…} })`, as above;
  - no seed: `fero.of<Score>()('scores', { methods: {…} })` *(proposed)*: the row type by hand, the methods worked out;
  - both by hand: `fero<Score, typeof methods>('scores', { methods })`;
  - `fero<Score>('scores', { methods })` **does not compile.** It used to, and left `typeof scores` with untyped methods, so a typed client accepted any method name. The skeptic found that both of this page's own examples did it.
- **The door is not in the types yet.** A client typed `fero<typeof shop>` still has `set` and `remove`, and they are refused `methods-only` when run. Dropping those verbs from the typed client of a resource with methods is a question for the owner (section 11.1).

**What a call costs** (PATHS 3.4).
- One trip to a server. The handler runs there. Its reads (`ctx.rows`, `ctx.data`) are that server's own rows: no trip.
- Each write the handler makes goes to its partition's leader. **If the handler's server is not that leader, each such write is one more trip.** With three servers that is about 2 writes in 3 (PA-25).
- A call with `once` is **three commits in a row**: claim the name, run, store the result. The claim and the result are rows of `#calls`, which is a resource of its own with its own leaders (V5-2). So a `once` call also makes **up to two more trips**, to `#calls`' leader, and `near` cannot save them: it places the handler, not the claim. Use `once` for calls that must not run twice, not on every call.

**`near`: send the call to its row's leader** *(proposed; PA-25, which PATHS 7.1 leaves to this page)*. A method can say which row it is about: `{ near: true, run }` means the argument is the row key; `{ near: 'sku', run }` means `arg.sku` is. The hint is plain data, kept with the resource's settings, so a client learns it and sends the call straight to that row's leader. The handler's writes to that partition are then local: **one trip and one commit in all, the least a call can cost** (without `once`).
- `near` is **for speed, never for safety.** A call that lands on another server still works, one trip slower. The op or the condition is what makes a write safe.
- A bare function stays valid. Add `near` when the call matters.

### 3.9 Reads

| Read | Where | Cost | Can it be stale? |
|---|---|---|---|
| `f.rows.k` | here | a `Map` read plus one trap; the row is handed out by reference, frozen. The `Map` read alone is 43 to 51 ns at 1,000 rows, about 1 µs at 1,000,000, where cache misses rule (PATHS 4.1). **The first read of a row after it was written also freezes it**, once, deeply (DATA-07; code: data api/index.ts:152-162) | it is this process's last applied commit. Never older than anything this process already saw or wrote |
| `await f.get(k)` | here if held; else **one trip** to a copy, and the row's partition is followed from then on | held: no trip. A miss: one trip, and **the row's whole partition once**, then its changes for as long as it is held (PATHS 4.4). With each row its own partition, that is one row | a copy may trail the leader by a moment |
| `await f.get(k, { hold: false })` *(proposed)* | here if held; else one trip to a copy, and nothing is kept | a miss: one trip, one row's bytes, every time | as above |
| `await f.get(k, { fresh: true })` | **always at the leader** | one trip, plus the leader's check with a majority that it still leads. No disk (PATHS 4.3). etcd's same read: 0.43 ms against 0.18 ms ([E-09e]) | no: it sees every write that finished before it began |
| `f.data.snapshot()`, v4's `f.snapshot`, or listing `f.rows` | here | **every held row is walked**: 87 µs at 1,000 rows, 30 ms at 100,000, 0.5 s at 1,000,000 (PA-8, measured on v4's two passes; one pass is owed) | as `f.rows` |

```ts
// file: reads.ts — a local read, a trip, a fresh read
import { fero, FeroError } from 'fero'
type User = { name: string }
const users = await fero<User>('users', { hold: 'asked' })

const u = await users.get('u42')                      // a miss: one trip; u42's partition is now held and kept live
const once = await users.get('u43', { hold: false })  // a miss: one trip; nothing is kept
const same = users.rows.u42                           // here: one lookup
const sure = await users.get('u42', { fresh: true })  // at the leader: sees every finished write
try { console.log(users.rows.u7) }                    // never asked for: throws 'not-held', does not fetch
catch (e) { console.log((e as FeroError).hint) }      // "u7 is not held here: await users.get('u7') or users.follow('u7')"
console.log(u, once, same, sure)
```

**`f.rows`** *(proposed; PA-8)* is a read-only view of the rows this process holds.
- `f.rows.k` is one lookup and returns the frozen row itself, or `undefined` when no such row exists. `f.rows.k?.stock` is then a plain property read.
- A row you took never changes: it is frozen (DATA-07). `f.rows` itself is always "now".
- Listing it (`Object.keys`, a spread, `JSON.stringify`, `console.log`) walks every row. That cost is in plain sight: you wrote a loop or a print.
- **How it prints.** Node's `console.log` shows a `Proxy`'s target and runs none of its traps: a bare `Proxy` over the store prints `{}` (checked on Node 22; `JSON.stringify`, `Object.keys` and a spread do go through the traps). So `f.rows` is an object of a small class over the store that carries `[util.inspect.custom]`, which lists the rows. Owed: a test that `console.log(f.rows)` prints the rows.
- **Owed: two pins.** `f.rows.k` on a row already read stays within twice a `Map` read. The first read of a row just written is pinned apart: a hot row that is rewritten often pays the freeze again after each write.

**`f.snapshot` keeps v4's meaning** *(changed by the skeptic's pass; a question for the owner, section 11.1)*. It is the whole picture: a new frozen container of every row, on each access, the same as `f.data.snapshot()`. So every `snapshot` in fero is a picture that stands still: `f.snapshot`, `f.data.snapshot()`, `view.snapshot()`, `cluster.snapshot()`.
- **Every v4 line keeps working, with v4's result.** `console.log(shop.snapshot)` prints the rows, as the READMEs of about 20 examples record. `const s = f.snapshot` kept across an `await` still stands still.
- **And with v4's cost**: every row walked on every access (code: api/index.ts:1289-1296). `f.snapshot.widgets` in a loop is the slow line it was in v4. New code reads a row through `f.rows`; the examples that read one row move to it.
- An earlier draft made `f.snapshot` a second name for the live `f.rows`. That made old lines fast for free. But it left two names for one thing, made `f.snapshot` the only `snapshot` that is not a picture, and changed what a kept `f.snapshot` reads after an `await`.

**`f.data` is for changing and for views, not for reading values.** `f.data.widgets.stock` is a handle to that cell, not the number 10. It makes a handle per step: 0.5 to 5 µs today, against 43 ns for the lookup (PA-31). **Read through `rows`; write and derive through `data`.**

**Sync reads never guess.** A sync read never returns a stale, empty or partial answer in place of rows that exist somewhere else, and it never makes a hidden trip.
- **A row not held here throws `not-held`.** The hint names the row's partition and the two calls: `get` and `follow`.
- **On a process that holds only part of the resource** (`hold: 'asked'`, a size, a spare), **everything that needs every row throws `not-held`**: listing `f.rows`, `f.snapshot`, `f.data.snapshot()`, and an operator over every row. v4 banned the same silent partial answer: its `f.snapshot` throws on a scoped node (code: api/index.ts:1289-1296). The hint says to open a served view (section 3.10) or to `follow` what you need; a follow's own `rows` list fine, since a follow holds all of what it selected.
- **Only a string row key can throw.** Reading `then`, `toJSON`, `constructor` or any symbol off `f.rows` never throws. Otherwise `JSON.stringify(f.rows)`, or awaiting anything that holds `f.rows`, would throw for the wrong reason.

### 3.10 Views and subscriptions

Four ways to stay up to date. They differ in **where the work runs** and **what crosses the wire**.

| You write | You get | Where the work runs | What crosses the wire | A slow reader |
|---|---|---|---|---|
| `f.data.filter(…)`, `.sum(…)`, `.za(…)`, with `.tap(fn)` | a live view | here, on held rows. Work grows with the change, not with the data | nothing new: it rides the rows this process already holds | sees the newest state |
| `f.follow(of)` | some partitions, kept live: rows | the fold runs here | those partitions once, then their changes | sees the newest state |
| `f.changes({ of, from })` | every record, in order, from a position | your loop | every record of the selection | waits; nothing is skipped |
| `f.methods.view(arg).open()` | a live mirror of a view kept on a server | on the server | only the view's own changes | sees the newest state |

```ts
// file: live.ts — a view, a follow, the log
import { fero } from 'fero'
type Msg = { text: string; stars: number }
const chat = await fero<Msg>('chat', { server: true, partition: { before: '/' }, history: '7d' })

const starred = chat.data.gt('stars', 0)                 // 1. a view: data's operator, kept as rows change
starred.tap(() => console.log(starred.snapshot()))

const room = chat.follow('room1')                        // 2. a follow: one room, as it is, then each change
await room.ready
room.tap(() => console.log(room.rows))
room.close()

const r = chat.changes({ of: 'room1', from: 'earliest', until: 'latest' })   // 3. the log: every record, then stop
for await (const e of r) console.log(e.partition, e.version, e.time, e.rec)
console.log(r.cursor)                                    // text: save it, pass it back as `from`
```

- **Views are data's**, unchanged from v4: every operator works on `f.data` and on a follow. The bar is at most 1 µs per affected view per change. One known miss: `group` costs 2,574 µs at 1,000,000 rows ([E-05]).
- **`follow(of)`** takes a partition, a list, `{ prefix }` or `{ share }`. Cost: one trip, the bytes of those partitions once, then one small frame per change. The server encodes each change once however many follow it: 0.01 to 0.46 µs per record per follower (PATHS 0). A reconnect sends only what was missed (PATHS 4.6); v4 downloads the whole resource again. A `{ prefix }` follow's first picture walks the partition names (section 3.2).
- **Follows of the same selection in one process share one subscription and one fold** *(stated here; reasoned)*. They are counted: the subscription closes with the last `close()`. So 1,000 sockets in one room on one webserver are one subscription and one decode per change, not 1,000. What each `tap` then does (a `JSON.stringify` per socket, say) is the app's own cost.
- **`tap` fires once when it is added, then once per change**, as v4's does (rung 05). The first call carries the picture so far; on a follow it comes when the first picture has arrived. So a `tap` alone sends "the room so far, then each change"; sending `rows` as well would send the room twice.
- **`changes(opts)`** *(renamed from `read`, proposed)* reads the log (V5-1). `of` takes what `follow` takes. `history` on the resource says how much of the log is kept; past it, the reader gets `expired`. `credit` (1 MB by default) keeps a slow loop from filling memory.
- **`from` is `'latest'` by default: from now on. "Now" is the call** *(stated here; reasoned, not modelled)*. The reader opens when `changes()` is called, not when the loop first turns. So **a write this process makes after the call is always seen**, even if it commits before the loop starts.
  - On a process that holds the selection, `'latest'` is the last position this process had applied when the call was made.
  - On a process that does not, the open is sent with the call, and this process's own later writes to the selection wait in the client until the open is answered with its start: one trip, once.
  - Another process's write that commits at about the same time may fall on either side. That is what "now" means across processes.
- **An entry** is `{ rec, value, partition, version, time, source }`. `e.rec` is the change record itself, the one a `tap` gets, shared with every other reader and never copied. **`e.value` is what the record wrote, when it wrote a whole row**: `e.rec.value`, typed. It is `undefined` for a field write and for a remove. It is never looked up, so it is not "the row now". A loop that needs the row after a field write follows the partition and reads `rows`; that costs a fold of what it reads (PATHS 4.9 step 4).
- **A cursor is a bookmark.** `r.cursor` is text. Save it; pass it back as `from`. It stays valid across leader changes and moves ([E-31], [E-19]). A wrong text is refused `bad-cursor` when the reader opens.
- **A view served by a server** is how a client that holds little gets a whole-resource answer: section 3.8's `low`, opened with `customer.methods.low(5).open()`.

### 3.11 Derived resources

There are three steps, and each costs more and lasts longer.

| Step | Code | Where it lives | Cost |
|---|---|---|---|
| a view | `orders.data.group((o) => o.user)` | in this process, while it runs | the fold: about 1 µs per change |
| a served view | a method that returns a view; clients `open()` it | on a server, while a client has it open | one encode per change, shared |
| a derived resource | `derive(orders, totals, fn)` | in its own log and copies, for good | a share of one commit per source record |

```ts
// file: derived.ts — totals, computed from orders, exactly once
import { fero, op, derive } from 'fero'
type Order = { user: string; cents: number }

const orders = await fero<Order>('orders', { hold: 'asked' })   // the deriver is a client of its source
const totals = await fero<number>('totals', { server: true })   // and the owner of its own resource
await derive(orders, totals, (e, out) => { if (e.value) out.set(e.value.user, op.incr(e.value.cents)) })
```

- **This is V5-2's point 4 as code.** The deriving process reads `orders`' log like any `changes()` reader. It knows only `orders`' members and leaders, learned from `orders` itself.
- Each output it writes to `totals` carries the source position it came from. That mark (29 B) is in `totals`' own log, so a restart resumes exactly, and no source record counts twice ([E-30]). A long stop needs the source to keep its log that far back (`history`, or the tier); past that, the deriver stops with `expired` rather than skip a record (LAYERS 8.8).
- There is no transaction across the two. `totals` trails `orders` by about one commit. On the project's one timeline, a derived record is placed after its source (V5-4).
- **`out`'s writes return nothing** *(proposed)*. With nothing to await, the slow way cannot be written: a loop that awaits each output runs at about 250 source records a second (PATHS 4.9, PA-19).
- **What commits together.** One source record's outputs to **one partition** commit together, in one entry with their mark (PATHS 4.9 step 5). Its outputs to different partitions commit one by one, each with its own mark, maybe at different leaders. So each still counts exactly once, but a reader may see some before the rest.
- **`e.value` is what the record wrote**, so reading it folds nothing. It is `undefined` for a field write. So this `derive` counts an order **once per whole-row write**: write each order whole, once. A field write to an order (`orders.data.o1.cents = 9`) is skipped by the `if`, and a second whole write counts again. `hold: 'asked'` keeps the deriver from holding the source in memory.
- **Run the file on every server of `totals`; the work is done once** *(stated here; reasoned from P-08, whose `run` is the same mechanism)*. `derive` is a `consumer` with a target: the derivers that share a `name` (default: the target's name) split the source's shares through `#groups`, and each share has one live owner at a time. Three servers do one third of the reading and sending each, not all of it three times. (PATHS 4.9 reads the deriver as the leader of `totals`' groups, which also does the work once; which of the two is built is LAYERS' call, section 11.2.) A deriver that dies hands its shares on within one lease, and the next owner resumes from the marks. A server that owns no share pays only its lease's renewals.
- Several sources: `derive([orders, refunds], totals, fn)`; `e.source` names which.

## 4. What each call costs

"Trip" is one round trip: about 40 µs at the median on one box, the network's between machines ([E-01]). "Commit" is one disk sync on a majority, shared with every other write in flight: about 1 ms at the median on one box (MEMORY 9.3). Times are TypeScript.

| Call | Trips | Commits | Copies, or whole-resource work | Source |
|---|---|---|---|---|
| `f.rows.k` | 0 | 0 | none: one lookup, the row by reference; a row's first read after a write freezes it | PATHS 4.1; PA-8 |
| listing `f.rows`; `f.data.snapshot()`; v4's `f.snapshot` | 0 | 0 | **every held row walked** | PA-8 |
| `f.data.k` (a handle, not a value) | 0 | 0 | a small object per step: 0.5 to 5 µs | PA-31 |
| a view, per change | 0 | 0 | work for the changed rows only | data; [E-05] |
| `f.data.k = v`, `f.set`, `f.remove` | 1 to the leader (+1 if this process cannot route: a browser, or a missing partition function) | 1, shared | one encode, kept for resends | PATHS 3.1; V5-9 |
| `await w.received` / `w.replicated` | the same write; you stop waiting sooner | still 1 | none | PATHS 3.3; V5-11 |
| N writes made together | 1 frame per leader | shared: about 62 records a sync when busy | per record: a decode, a judging, a fold. **At most 512 waiting or 64 MB**; then `backpressure` (an assignment throws) | PATHS 3.6; [E-02]; LAYERS 4.2 |
| a write with `once` | as a write | 1 | about 221 B at the leader for a day; no early stages | [E-20] |
| N writes awaited one by one | N | N in a row | | PA-40 |
| `f.batch([...])` | 1 | 1 | one log entry | PATHS 3.6 |
| `f.set(key, fn)` | as a conditional write, per try | 1 per try | a local read if the row is held | section 3.7 |
| a method call | 1, +1 per write its server does not lead; 1 in all with `near` | 1 or more, shared | the argument and the result encoded once each | PATHS 3.4; PA-25 |
| a call with `once` | 1, plus up to 2 to `#calls`' leader; `near` does not save those | **3 in a row** | | PATHS 3.4; V5-2 |
| a call with `retry` | as a call; sent again only if its server is lost | as a call | | code: api/methods.ts:549-575 |
| `await f.get(k)`, held | 0 | 0 | none | PATHS 4.1 |
| `await f.get(k)`, a miss | 1, once | 0 | **the row's partition, once; then its changes for as long as it is held.** With `hold: 'asked'` and no size, that is for the life of the handle | PATHS 4.4 |
| `await f.get(k, { hold: false })`, a miss | 1, each time | 0 | one row; nothing kept | reasoned |
| `f.get(k, { fresh: true })` | 1, plus the leader's round with a majority | 0 | one row | PATHS 4.3 |
| `f.follow(of)` | 1 to open; shared by every follow of the same selection in this process | 0 | the selected partitions, once, then their changes. `{ prefix }`: its first picture walks the partition names | PATHS 4.5; PA-17 |
| a `{ before }` or function partition rule | | | an index from partition to rows on every copy: memory per row, an update per fold | PA-17 |
| `f.changes({ from })` | 1 to open | 0 | **every kept record of the selection** | PATHS 4.5 |
| a reconnect | resumes from the cursor | 0 | only the missed records | PATHS 4.6 |
| `fero(name)`, a client, `hold: 'all'` | 2 to 3 built well | 1 (its session) | **the whole resource, once; then every write to the resource**, decoded and folded here | PATHS 3.2, 4.5 |
| `fero(name, …)` with a server role, joining | | | the whole log copied and folded; a `dir` and its syncs; a vote or a standby | PATHS 2.1, 5.1 |
| `fero(name, …)` founding a resource | one create-if-absent | about 5 ms; about 35 ms across machines | about 8 KB per server while idle | [E-49]; V5-8 |
| `lock(name)` | as a conditional write | 1 | | P-10 |
| `saga([...])` | | **6 to 7 in a row**, about 7 ms | | PATHS 3.7 |
| a queue message | | 3 (add, take, ack) | | PATHS 4.13 |
| a `service` ask | | 3 | | [E-22] D7 |
| a `derive` output | 1 delivery | a share of 1, per output partition | a 29 B mark. The source is read once however many servers run the file: they split its shares | PATHS 4.9; [E-30] |

Nothing on the surface decodes, copies or walks a whole resource except the bold "whole" rows. Most of those say so in their shape: a call with brackets that returns everything, or a listing you wrote. **Two do not, so learn them:** a bare `fero(name)` holds everything (`hold: 'all'` is the default), and v4's `f.snapshot` has no brackets.

**Where the surface itself used to cost, and what this page did.**
- `f.snapshot` copied every row per read: `f.rows` is a lookup, and row reads move to it (PA-8).
- A method's writes were forwarded on about 2 calls in 3: `near` (PA-25).
- `derive` invited one commit per output: `out` returns nothing (PATHS 4.9).
- A promise per write: made only when the handle is awaited (PA-13).
- An early report per write: sent only for writes that asked (PATHS 3.3).
- A client's write went through any server: it goes to the leader (V5-9).

## 5. What changes, and why

### 5.1 From v4

**Kept from v4, on purpose:** `fero(name, opts)`; roles by declared act; writes by plain assignment; a write shows when it commits (V4-7); `methods:` as the door (V4-5); `validation`; data's operators as live views; `tap`; a method that returns a view streams; Ctrl-C (V4-8); `fero.spawn` (V4-9); the config cascade (V4-10); the box directory (V4-3); one process per `dir` (V4-59); user throws go to the fault printer (V4-47); `ctx.data`, `ctx.peer`, `ctx.flush()`; `diag(f)` in `fero/internals`. `f.snapshot`, with v4's meaning and cost. `{ retry: true }` on a call. v4's lens calls (`f.data.set(k, v)`, `f.data.k.remove()`, `f.data.patch([...])`) keep working, and now return the handle their verb returns (section 3.4).

| v4 | v5 | Why |
|---|---|---|
| a cell keeps its newest stamp (last writer wins); example 17 loses an increment | one leader per partition orders writes; ops, conditions, `set(key, fn)` | V5-1, V5-6. Counters, stock and locks become correct |
| a write shows when its owner stamps it | a write shows when a majority has it on disk | V5-5. Nothing shown can vanish. It shows about 1 ms later |
| `methods.update(change, { confirm })` | `f.set(k, v)` returns a handle; await it, or `.received`, or `.replicated` | V5-5, V5-11: every write goes all the way; you choose when to stop waiting |
| built-in `methods.update / insert / remove / read` | `f.set`, `f.remove`, `f.batch`, `f.get`; `f.methods` holds only yours | one write path, and no clash with a method you name `update`. (The door still refuses a client's plain write when it runs, as v4's refused `methods.update`; that oddity moved, it did not go) |
| reading a row through `f.snapshot`, which builds the whole picture | `f.rows.k` is one lookup; `f.snapshot` stays, with v4's meaning | PA-8: 87 µs to 0.5 s per read becomes one lookup, for code that moves to `rows` |
| `replicas: N`, and `await f.data` gathering from every member | `hold: 'asked'`, `get`, `follow`: a row not held is one trip to one copy | PATHS 4.4: the gather cost members × cells per read |
| `ScopedError` on a sync read of a shard | `FeroError` with `not-held` | one error type; the hint names the call |
| a reconnect downloads the whole resource | a reconnect sends what was missed | [E-31] |
| settings must match on every member, or they refuse to link | resource settings are records in the resource's own log | V5-2 |
| `WriteResolve`, `WriteReject { reached, reason }` | `Ack`, and one `FeroError { code, outcome, reason, hint }` | `outcome` says whether it may have committed. `e.reason` still prints what it printed |
| a call: `{ retry: true }` | `{ retry: true }` stays; `{ once: name }` is added | `retry` sends an idempotent call again at no extra commit; `once` is at most once, from any process, at three commits |
| `replicas`, `heartbeat.ms`, `seams` | `copies` and `standbys`, `ping.ms`; `seams` gone | Raft needs a fixed, odd set of voters; Raft has heartbeats of its own, so the link's ping gets its own word |
| `dir` per resource, off by default | `dir` per process, on by default for a server | one journal and one disk sync for every resource in the process ([E-12]); every write is on disk (V5-5) |
| `cluster.epoch`, `cluster.partitions` | `cluster.groups`, `cluster.health`; `cluster.writes` stays | the ring and the ballots are gone; health says what is wrong and the fix |

**The examples ladder.** Most rungs keep their files, and every `console.log(f.snapshot)` prints what it printed. The ones whose lesson changes: 03 (the pending row now waits for a majority; and a client with no server yet throws `not-held` on a sync read where v4 printed `{}`), 04 and 08 (the built-in methods become verbs), 10 (`confirm` becomes stages), 12 and 13 (`{ confirm: 'persisted' }` becomes a plain `await`), 16 (scoped becomes `hold`), 17 (the lost increment becomes `op.incr`, with the old race shown as the reason).

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
| `partition` is plain data only | also a function, with its cost stated | V5-2 point 1 |

V5-10's nine fixes change no call. Two are felt: a client that lost every member it knew asks the directory again by itself (fix 2), so an app never re-opens a resource; and a seed is applied once with no mark (fix 5).

### 5.3 From COMP2's API, to be easier to guess

Each is a rename, a short form of calls that exist, or removes a cost. None adds a trip, a copy, a decode or a pass over a resource.

| COMP2's page | This page | Why |
|---|---|---|
| `f.snapshot.k`, promised as a property read but built as a full copy | `f.rows.k`, a lookup; `f.snapshot` stays what v4 made it, a copy | "snapshot" says "a copy"; "rows" says "the rows, now" (PA-8) |
| `f.read({ from })` | `f.changes({ of, from })`; `from` defaults to `'latest'` | "read" sounds like reading a row; one selector, the same as `follow`'s |
| `fero.cursor(text)` to bring back a saved cursor | the saved text goes back in as `from` | one step less; a wrong text is refused `bad-cursor` at the open |
| `shortfall`, `holistic` | one code, `not-held`, whose hint names the call | the two names said nothing; the fix is the same kind |
| `cache: { memory }` | `hold: 'all' \| 'asked' \| size` | the old key hid a change of mode and a whole-resource download |
| `id` on a write, `key` on a call | `once` on both | one name for one idea; `key` already means a row key. A write with `once` answers at its commit only |
| a `get` that misses always follows | also `get(key, { hold: false })` | a one-shot read that keeps nothing |
| a cron job named by `once`, which lasts a day | `add(job, { cron, key })` | a schedule lasts as long as its row |
| check-then-set by hand: `get({ version: true })`, then `set({ if: { version } })` | also `set(key, fn)` | the safe form becomes the short form |
| no placement for methods | `{ near, run }`: the call goes to its row's leader, for speed only | PA-25: one trip saved on about 2 calls in 3 |
| `if: { fence: l.fence }` | `if: { lock: l }`, and `lock(name, fn)` | "fence" is the mechanism's word, not the user's wish |
| `group(orders, 'billing')` | `consumer(orders, 'billing')` | `group` is already data's operator and the design's word for a Raft group |
| `derive`'s `out.set` returns a promise | it returns nothing | the slow way cannot be written (PATHS 4.9) |
| `fero<Row, typeof methods>` with `methods` exported by hand | `fero<typeof shop>` for a client; a seed or `fero.of<Row>()` for the server | one type argument; and `fero<Row>(name, { methods })`, which would be untyped, does not compile |
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
5. **`follow`, `changes` and `tap`.** Rows, or records. `tap` is a callback on anything live; `follow` keeps chosen rows up to date here; `changes` hands you every record in order (section 3.10).
6. **`fresh`.** "A local read can be a moment behind another process's write. `fresh` asks the leader." Most apps never need it: a process always sees its own writes and never reads backwards.
7. **`outcome`.** One question: did my write commit? `refused`: no, and it never will. `unknown`: maybe; fero keeps trying, and `cluster.writes.lookup(attempt)` tells later.
8. **Versions and cursors.** A version is a row's place in its partition's order. A cursor is a bookmark. Both are opaque text. The rest is LAYERS'.
9. **"A check-then-set must carry a condition or be an op."** The most useful rule on the page, once buried under "Methods". It follows from one leader judging on the newest state: your read is a copy, and it can be old by the time your write lands.
10. **`batch`.** Read as "for speed"; it is "all or none".
11. **Twelve words at one level.** An app needs five (section 1). Slots, groups, attempts and sessions are plumbing.
12. **Labels on every line** (L0 to L5, A-nn, RR-nn). Builder's notes; they stay in the source marks and in LAYERS.
## 6. The declarations

What every code block on this page compiles against. Against the COMP2 page's `fero.d.ts`: the write handle and its stages, `rows`, `changes`, `hold`, `once`, the method hint `near`, `set(key, fn)`, `if: { lock }`, the partition function, `fero.of`, `get`'s `hold: false`, and every project-level part removed.

**Where the types are weaker than the text** (stated, not fixed): `f.data.k` and everything below it is untyped, since it is data's own proxy; a saga `Step`'s value is not checked against its resource's row type; a field write's value (a `Path` key) is not checked. Whole-row values in `set`, `batch` and `derive`'s `out` are checked. The libraries keep their shape.

```ts
// file: fero.d.ts — fero v5's public API for the chosen design (V5-1 to V5-11). Declarations only.
import type { Ops, View, ChangeRecordV2, ReadonlyData } from 'data'
/** One change record: data's own, and the wire's. A tap gets one; an Entry carries one. */
export type Rec = Exclude<ChangeRecordV2, { type: 'move' }>

// ── words ────────────────────────────────────────────────────────────────
export type Key = string
/** A row key, then the fields below it: ['widgets', 'stock']. */
export type Path = readonly [Key, ...(string | number)[]]
export type Partition = string
export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`
export type Size = `${number}${'B' | 'KB' | 'MB' | 'GB' | 'TB'}`
/** A row's place in its partition's log. Opaque. Two versions of one partition compare with `<`. */
export type Version = string & { readonly __fero: 'version' }
/** A reader's place across many partitions. Opaque text: save it, pass it back as `from`. */
export type Cursor = string & { readonly __fero: 'cursor' }
export type AttemptId = string & { readonly __fero: 'attempt' }
export type Time = number

// ── fero(name, opts) ─────────────────────────────────────────────────────
/** Open a resource. The row type comes from a `data` seed, from `fero<Row>(name, opts)`, or from
 *  `fero.of<Row>()(name, opts)`. TypeScript cannot take one type argument and work out the other,
 *  so `fero<Row>(name, { methods })` does not compile: it would leave the methods untyped.
 *  With methods, let the seed give the row type, or use `fero.of<Row>()`. */
export declare function fero<R extends Resource<any, any> = Resource<any, Methods<any>>>(
  name: string,
  opts?: ProcessOptions & OpenOptions,
): Promise<R>   // `fero<typeof shop>(name)`: a client typed by a server's exported handle
export declare function fero<Row, M extends Methods<Row>>(
  name: string,
  opts?: Options<Row, M>,
): Promise<Resource<Row, M>>   // both worked out from the options, or both given: `fero<Row, typeof methods>`
export declare function fero<Row>(
  name: string,
  opts?: Omit<Options<Row, Methods<Row>>, 'methods'> & { methods?: never },
): Promise<Resource<Row, Methods<Row>>>   // the row type alone: no `methods` here; a client's calls are untyped
export type Options<Row = any, M extends Methods<any> = Methods<any>> =
  ProcessOptions & ResourceOptions<Row, M> & OpenOptions

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
  redial?: { ms?: number; tries?: number }
  leave?: { ms?: number }
  journal?: { cap?: number }
  diag?: { allow?: Record<string, string> }
  connect?: { wait?: Duration }
  shuffle?: boolean | number
}

/** Remembered by the resource's own log (V5-2). The founding open writes them; fero.alter changes them. */
export interface ResourceOptions<Row = any, M extends Methods<any> = Methods<any>> {
  /** The unit of order. Default: each row. `{ before: '/' }`: the key's text before the first '/'.
   *  A function of the row key: code, the same on every process that routes by it. Fixed at founding. */
  partition?: { before: string } | ((key: Key) => Partition)
  history?: History
  rows?: boolean | RowsRule<Row>
  copies?: 1 | 3 | 5            // the copies whose disks decide a commit
  standbys?: number             // more full copies that do not vote
  election?: { ms?: number; jitter?: number }
  // the seed and code: a server only
  data?: Record<Key, Row>
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
  /** 'all' (default): every row, kept live; the open sends the whole resource once.
   *  'asked': only what this open gets or follows. A size: the same, inside that bound. */
  hold?: 'all' | 'asked' | Size
  signals?: boolean
  bind?: 'live' | 'sim' | `tape:${string}` | `./${string}`
}

// ── the resource ─────────────────────────────────────────────────────────
export interface Resource<Row = any, M extends Methods<any> = Methods<any>> extends Verbs<Row> {
  readonly name: string
  /** Change and watch: assignment writes, and data's operators as live views. */
  readonly data: LiveData<Row>
  /** Read: `f.rows.k` is one lookup and hands out the frozen row. Listing it walks the rows.
   *  A row not held here throws 'not-held'; so does listing on a process that holds only part.
   *  Never a trip, never a copy (PA-8). */
  readonly rows: Rows<Row>
  /** v4's whole picture, with v4's meaning: a new frozen container of every row on each access.
   *  O(rows). The same as `data.snapshot()`. To read a row, use `rows`. */
  readonly snapshot: Rows<Row>
  /** Your functions on the resource's servers, and nothing else. */
  readonly methods: Callers<M>
  /** This resource's own members, groups, health and writes in flight. */
  readonly cluster: ClusterView
  destroy(): Promise<boolean>
}
/** A lookup can miss: a key that names no row reads `undefined`. */
export type Rows<Row> = Readonly<Record<Key, Row | undefined>>

export interface Verbs<Row = any> {
  // reads: anything awaited may make one trip
  get(key: Key, opts: GetOpts & { version: true }): Promise<{ value: Row; version: Version } | undefined>
  get(key: Key, opts?: GetOpts): Promise<Row | undefined>
  get(key: Path, opts?: GetOpts): Promise<unknown>
  // writes: every one commits on disk at a majority (V5-5). A plain whole-row write returns a
  // Write, which also reports its earlier stages. A write the leader can refuse on state, or that
  // answers a value, returns a Judged: it answers at its commit only (V5-11 ruling 6). A write
  // with a `once` name is one of those: the name may be taken ('call-diverged', 'too-many-keys').
  /** Read, decide, write: `fn` gets the row, returns the next one (undefined: write nothing).
   *  Written `if` unchanged since the read; on a conflict it reads again and calls `fn` again. */
  set(key: Key, fn: (row: Row | undefined) => Row | undefined, opts?: Omit<WriteOpts, 'if'>): Judged<Ack | undefined>
  set(key: Key, value: Op, opts?: WriteOpts): Judged
  set(key: Key, value: Row, opts: JudgedOpts): Judged
  set(key: Key, value: Row, opts?: PlainOpts): Write
  set(key: Path, value: unknown, opts?: WriteOpts): Judged
  remove(key: Key, opts: JudgedOpts): Judged
  remove(key: Key, opts?: PlainOpts): Write
  remove(key: Path, opts?: WriteOpts): Judged
  /** Several changes to ONE partition: one log entry, all or none. Not needed for speed. */
  batch(writes: readonly BatchWrite<Row>[], opts?: { once?: string; timeout?: Duration }): Judged<Ack[]>
  /** Keep the value; reset its ttl or lease. */
  touch(key: Key, opts?: TouchOpts): Judged
  // staying up to date
  /** Rows: these partitions as they are now, then each change. */
  follow(of: Selector): Follow<Row>
  /** Records: every committed change, in order, from a position (default: from now on). */
  changes(opts?: ChangesOpts): Changes<Row>
  /** For libraries: the leader leases the first takeable rows of a partition to the caller. */
  claim(opts: ClaimOpts<Row>): Promise<Claimed<Row>[]>
}

export interface GetOpts {
  fresh?: boolean      // ask the leader: one trip plus its round with a majority; no disk
  hold?: false         // a miss is read once and not kept: one trip, one row's bytes, no follow
  version?: boolean
  timeout?: Duration
}
export interface WriteOpts {
  if?: Cond
  ttl?: Duration
  while?: 'session'
  /** A name you pick: a resend under the same name within a day gets the first answer.
   *  A named write is judged (the name may be taken), so it answers at its commit only. */
  once?: string
  timeout?: Duration
}
export type PlainOpts = Omit<WriteOpts, 'if' | 'once'> & { if?: undefined; once?: undefined }
export type JudgedOpts = WriteOpts & ({ if: Cond } | { once: string })
export interface TouchOpts { ttl?: Duration; lease?: Duration; if?: Cond; once?: string; timeout?: Duration }
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
export type BatchWrite<Row = any> =
  | { key: Key; value?: Row | Op; remove?: true; if?: Cond; ttl?: Duration }     // a whole row: checked against Row
  | { key: Path; value?: unknown; remove?: true; if?: Cond; ttl?: Duration }    // a field: not checked
export interface ClaimOpts<Row> { partition: Partition; n?: number; lease: Duration; due?: keyof Row & string }
export interface Claimed<Row> { key: Key; value: Row; token: Version; until: Time; deliveries: number }

// ── staying up to date ───────────────────────────────────────────────────
export interface LiveData<Row> extends Omit<Ops<Record<Key, Row>>, 'patch'> {
  /** A row's or a field's handle: `f.data.k`, `f.data.k.stock`. Untyped: it is data's own proxy.
   *  Its `update(v)` and `remove()` are writes, and return what `f.set` and `f.remove` return. */
  [key: string]: any
  /** A whole frozen picture: a new container of every held row. O(rows). */
  snapshot(): Rows<Row>
  /** v4's lens calls. Each is the resource's verb under another name: the same handle comes back. */
  set(key: Key, value: Op): Judged
  set(key: Key, value: Row): Write
  /** One `set` per pair. The handle answers when every one has committed. Not all-or-none. */
  patch(pairs: readonly (readonly [Key, Row])[]): Judged<Ack[]>
}
/** Which partitions: one, a list, every one whose name starts with a prefix, or one share of all. */
export type Selector = Partition | readonly Partition[] | { prefix: string } | { share: Share }
export interface Share { index: number; of: number }
export interface Follow<Row> extends LiveData<Row> {
  readonly ready: Promise<void>
  readonly rows: Rows<Row>
  readonly cursor: Cursor
  close(): void
}
export interface ChangesOpts {
  of?: Selector
  /** 'latest' (default): from now on. "Now" is fixed when `changes()` is called, not when the loop
   *  starts: every write this process makes after the call is seen. 'earliest': everything kept.
   *  Or a saved cursor, or a version. */
  from?: 'earliest' | 'latest' | (string & {})
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

// ── methods ──────────────────────────────────────────────────────────────
export type Handler<Row = any> = (arg: any, ctx: Ctx<Row>) => unknown
/** A function, or a function with a hint: `near: true` says the argument is the row key this call
 *  is about, `near: 'sku'` says `arg.sku` is. The call then goes to that row's leader. Speed only. */
export type Method<Row = any> = Handler<Row> | { near: true | string; run: Handler<Row> }
export type Methods<Row = any> = Record<string, Method<Row>>
export interface Ctx<Row = any> extends Verbs<Row> {
  readonly data: LiveData<Row>
  readonly rows: Rows<Row>          // this server's rows: one lookup
  readonly peer: string
  readonly claims: Claims | null
  readonly session: string
  readonly once?: string
  now(): Time
  id(): string
  flush(): Promise<void>
  use<R2>(other: Resource<R2, any>): Verbs<R2>
}
type RunOf<H> = H extends { run: infer F } ? F : H
export type Callers<M> = {
  [K in keyof M]: RunOf<M[K]> extends (arg: infer A, ctx: any) => infer R
    ? (...args: undefined extends A ? [arg?: A, opts?: CallOpts] : [arg: A, opts?: CallOpts]) => CallOf<R>
    : never
}
type CallOf<R> = unknown extends R ? LiveCall<any> : Awaited<R> extends View<infer T> ? LiveCall<T> : Call<Awaited<R>>
export interface CallOpts {
  /** At most once, from any process: a claim in `#calls`. Three commits in a row. */
  once?: string
  /** v4's: send the call again if its server is lost. No claim, no extra commit. The handler may
   *  run twice, so only for a handler that is safe to run twice. */
  retry?: boolean
  ttl?: Duration
  timeout?: Duration
}
export interface Call<R> extends PromiseLike<R> {}
export interface LiveCall<T> extends Call<T> {
  open(): ReadonlyData<T> & { readonly ready: Promise<void> }
  close(): void
}

export interface Claims { sub: string; follow?: readonly string[]; call?: readonly string[]; write?: readonly string[]; exp?: Time; [claim: string]: unknown }
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
  | 'no-method' | 'threw' | 'busy'
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
  function of<Row>(): <M extends Methods<Row>>(name: string, opts?: Options<Row, M>) => Promise<Resource<Row, M>>
  /** An admin act: it needs the admin key. The partition rule and the seed cannot be altered. */
  function alter(name: string, change: Partial<Omit<ResourceOptions<any, any>, 'partition' | 'data'>> | { gate: string | null }): Promise<void>
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

// ── libraries: each built only from the verbs above ──────────────────────
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

/** Staged writes: they return nothing and commit together with the source mark. */
export interface Out<Row = any> extends OutTo {
  set(key: Key, value: Row | Op, opts?: { ttl?: Duration }): void     // a whole row: checked against Row
  set(key: Path, value: unknown, opts?: { ttl?: Duration }): void     // a field: not checked
  remove(key: Key | Path): void
}
export interface OutTo { use<R2>(target: Resource<R2, any>): Out<R2> }

export declare function consumer<Row>(source: Resource<Row, any>, name: string, opts?: { from?: 'earliest' | 'latest'; lease?: Duration; max?: number; shares?: number }): Promise<Consumer<Row>>
export interface Consumer<Row> extends AsyncIterable<ConsumerBatch<Row>> {
  readonly member: string
  readonly owned: number
  run(fn: (e: Entry<Row>, out: OutTo) => unknown): Runner
  leave(): Promise<void>
}
export interface ConsumerBatch<Row> { readonly entries: Entry<Row>[]; commit(): Promise<void> }

export declare function derive<A, B>(
  source: Resource<A, any>, target: Resource<B, any>,
  fn: (e: Entry<A>, out: Out<B>) => unknown,
  opts?: { name?: string; from?: 'earliest' | 'latest' },
): Promise<Runner>
export declare function derive<B>(
  sources: readonly Resource<any, any>[], target: Resource<B, any>,
  fn: (e: Entry<any>, out: Out<B>) => unknown,
  opts?: { name?: string; from?: 'earliest' | 'latest' },
): Promise<Runner>

export declare function saga(steps: readonly Step[], opts?: { once?: string; lease?: Duration }): Promise<Ack[]>
export declare namespace saga { function sweep(opts?: { every?: Duration }): Runner }
export interface Step {
  to: Resource<any, any>
  key: Key | Path
  value?: unknown           // not checked against `to`'s row type: steps name different resources
  remove?: true
  if?: Cond
  undo?: Op | { value: unknown } | { remove: true }
}

export declare function limiter(name: string, opts: LibOpts & { max: number; per: Duration }): Promise<{ take(key: string, n?: number): Promise<{ left: number; reset: Time }> }>
export declare function service<Req = unknown, Res = unknown>(name: string, opts?: LibOpts): Promise<Service<Req, Res>>
export interface Service<Req, Res> {
  answer(fn: (req: Req, info: { from: string }) => Res | Promise<Res>, opts?: { group?: string; concurrency?: number }): Runner
  ask(req: Req, opts?: { timeout?: Duration; group?: string }): Promise<Res>
}
export declare function migrate<A, B>(res: Resource<A, any>, opts: { to: number; fn: (row: A) => B; perSec?: number }): Promise<{ readonly done: Promise<void>; progress(): { rows: number; of: number }; pause(): void; resume(): void }>
export declare function tape<In = unknown, Out = unknown>(name: string, opts?: LibOpts & { window?: Duration }): Promise<{
  record(match: string, input: In, answer: Out): Promise<void>
  find(match: string): Out | undefined
}>
export declare function gateway(kind: 'resp' | 'nats' | 'kafka' | 'etcd', opts: { listen: string; resource?: string }): Promise<{ close(): Promise<void> }>
```
## 7. What the types cannot say

**Roles.**
- Section 3.1 has the rule. The server markers are: `server: true`, `listen`, `dir`, a `data` seed, `methods`, and the other code keys (`validation`, `schema`, `rules`, `load`, `rows.where`, `shape.up`). A `partition` function alone is not one: a client may pass it to route by itself.
- `listen: false` is a solo node with no socket: the only voter of its groups, for tests.
- A server holds and folds every row of each resource it serves, with `data`, while it is one of the resource's `copies + standbys`. A server past that number is a spare (section 3.3). A client holds what `hold` says.
- **The libraries' own resources need a server too.** `queue('thumbs', { server: true })` on a server founds and serves the queue; a worker's `queue('thumbs')` is a client of it. fero's system resources (`#sessions`, `#locks`, `#sagas`, `#calls`, `#groups`) are resources like any other; any process that serves a resource serves them too (this page's reading, with [LAYERS.md](LAYERS.md) section 10 item 5; the records do not say who founds them).

**Answers.**
- Every verb answers **after its commit**. A plain write's handle may also be awaited earlier (section 3.5).
- **A refusal waits too.** A refusal, an empty `claim` and a `call-diverged` answer are sent only once the state they were judged on has committed (A-04; V5-11 ruling 7). Before this fix, a write could be refused because of a write that was then lost (10 of 100 seeds of a planted race, [E-22]).
- If this process holds the partition, the handle resolves only once its own rows show the write. So a process reads its own writes.
- `outcome: 'refused'` means it never committed and never will. `outcome: 'unknown'` means it may have. fero keeps resending that attempt in the background while its session lives, until it gets a definite answer. `f.cluster.writes.lookup(attempt)` says how it ended.
- **fero retries by itself**, with jittered backoff from 200 ms to `election.ms`, and honours every `retryAfter`. An app never resends a write.
- **Order of issue.** One process's writes to one partition commit in the order it made them, even when it does not await each one (A-10). [E-45] saw the prototype break this in 12 of 100 seeds, with a leader change inside a burst; the fix is that each client numbers its writes.
- **Credit.** Each client may have only a granted number of writes in flight (A-07). The rest wait in the client. A client holds at most 512 waiting writes or 64 MB (LAYERS 4.2), then refuses `backpressure`: a verb's handle rejects with it, and an assignment throws it (section 3.6). A write still waiting at its `timeout` fails `timeout` with `outcome: 'refused'`, since it was never sent.

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
- `f.rows`, a view, a `follow`, and `get` of a held row read this process's committed rows, with no trip.
- A row handed out is frozen, so a read by reference cannot change it (DATA-07). Open: in E-22's probe, a row read through a `filter` view was not frozen.
- Every awaited read carries the highest version this process has seen in that partition. A server answers only once its own rows have reached it. So a process never reads older than what it already saw or wrote.
- A miss (`get` of a row not held) is answered from a copy, which may trail a write another process already had answered. `get(key, { fresh: true })` is the form that cannot ([E-22] C11).
- **A miss is a subscribe** (PATHS 4.4): the row's partition is sent once and followed from then on. That saves a second trip and closes the window between a read and a follow. It only pays when the reader goes on reading; `get(key, { hold: false })` is the one-shot form, and it keeps nothing.
- A refusal's `current` version counts as seen. So `set(key, fn)`'s re-read waits for it (section 3.7).
- `fresh: true`: the leader confirms it still leads (Raft's read index), then answers. One trip, no disk sync ([E-46]).

**Cursors** ([E-31], A-06).
- A cursor holds one position per slot it reads. It keeps its meaning across failovers and slot moves.
- A copy that lacks a reader's next record tells the client, and the client moves to another copy with its cursor, by itself.
- A reader hears `expired` only when no live copy of that slot has its next record. E-31 model-checked this through a leader crash, a reload, a dropped link and a slot move: 26 rules, on ten bounds of up to 7.6 million states.
- **Size.** A whole-resource cursor holds up to 4,096 entries: about 4 to 13 KB (reasoned from [E-19]). A reader of 1 to 10 partitions holds 22 to 79 B.

**Order.** Total within a partition. None across partitions, ever. Under a test world, deliveries mix partitions in a seeded order that keeps each partition's own order. So code that leans on order across partitions fails in test: E-22's planted app failed in 25 of 100 shuffled seeds and never without the shuffle.

**Versions.** Two versions of one partition compare with plain `<`, in log order, across failovers, moves and restores. So an outside system can check a lock's token with `<`. `fero.version.toNumber(v)` gives a number below 2^63 that keeps the partition's order; gateways need it ([E-45] F1) and apps never do. `changes({ of: p, from: version })` starts at that record.

**Values.** Rows are JSON-like values. `Uint8Array` is a value too, kept as bytes on the wire ([E-45] F3). A bigint, a function, a `Date`, a `Map`, a `Proxy` or nesting deeper than 60 is refused `unencodable`.

**Time** (A-23, [E-21]; V5-4).
- Writer time is the median of the members' clocks, the leader's own included. It never goes back. With one wrong clock, the leader's included, every check passed and no failover happened ([E-21]: 7 rules).
- **When most clocks disagree, the group stops writing** rather than expire rows by a wrong time. Health shows `skew`.
- **Expiry, presence and delays are judged while a leader exists.** With none they wait.
- `fero.now()` and `fero.id()` are the wall clock and random ids live, and the world's clock and seeded ids under test. Under a world, `setTimeout` and `setInterval` run on the world's clock ([E-22] D1).
- **One timeline.** A viewer merges the resources' logs by writer time (V5-4). Writes to different resources within the clocks' gap (a few ms) may show in either order.

**Methods.**
- A handler runs on the server the caller reached; with `near`, on its row's leader when the caller can route. `ctx.rows` and `ctx.data` are that server's committed rows.
- **A call with `once`** claims a row in `#calls` first. It runs at most once within its `ttl`, and a retry gets the first result. If its server dies, it is re-run elsewhere when the claim's lease lapses, with the same attempt ids, `ctx.now()` and `ctx.id()`. So handlers must give the same writes for the same `arg` and `ctx`; a re-run that writes a different change is refused `call-diverged`.
- **A call with `retry: true`** whose server dies is sent again to another server, as in v4. It may run twice; that is what the option says is safe. No claim, no extra commit.
- **A call with neither** whose server dies answers `unknown`: it may have run. fero does not resend it.
- `while: 'session'` inside a method binds the caller's session.
- A session-bound write is sent only once its session's own record has committed (A-04; [E-22] F2).

**Locks** (A-24, [E-24], [E-21]).
- A lock is a row of `#locks`. Its token is the version of the write that took it; renewals keep it. Tokens rise for ever.
- A write under a lock (`if: { lock: l }`) is judged by its own partition's leader. Each group remembers, per lock, the newest token it has seen, even after the lock row is gone. Leaders do not follow `#locks`.
- **So:** no write commits under a token older than one this partition's leader has seen. A stale write can still land between a new grant and the new holder's first write there ([E-22] F5). To close that at once, write to the partition under the new token first.
- The check does not lean on clocks ([E-21]).

**The door and tokens.**
- With `methods:` declared, clients change data only through the methods (V4-5). Reads stay open unless `rules.read` or a token limits them.
- A token from `fero.token(claims)` limits what a client follows, calls and writes. Servers check it when a follow opens and on every write and call. `rules.read` runs once per subscription and partition, never per record (PA-34).
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
| `unencodable` | L4 | a value that would not arrive unchanged (a bigint, a function, a `Date`, a `Map`, a `Proxy`, deeper than 60) | |
| `too-large` | L3, L4 | a record over 1 MB, a row over 64 MB | |
| `cross-partition` | L4 | a `batch` whose keys span partitions | |
| `no-rows` | L2 | an op, a claim or a condition on a `rows: false` resource | |
| `absent-row` | L2 | a field write or a `touch` on a row that does not exist | |
| `absent-path` | L2 | a field write whose parent field does not exist | |
| `sparse-hole` | L2 | a remove of an array's own element: write the spliced array | |
| `schema` | L2 | `schema` said no | `path`, `reason` |
| `invalid` | L2, L4 | `validation` returned a reason | `reason` |
| `methods-only` | L4 | a client's plain write to a resource with `methods:`; the hint lists the methods | |
| `forbidden` | L3, L4 | the token or `rules.read` does not allow it; a write resent after its token was revoked | |
| `no-method` | L4 | no method of that name | |
| `no-undo` | L5 | a saga step whose op has no inverse and no `undo` | |

**An expected answer: branch on it.** The state said no. `outcome: 'refused'`.

| Code | Layer | When | Fields |
|---|---|---|---|
| `conflict` | L2 | a condition failed, an op's bound would be crossed, or `set(key, fn)` ran out of tries; sent once the state it was judged on has committed (A-04) | `current` |
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
| `backpressure` | L4 | this client holds 512 waiting writes or 64 MB on top of its credit. A verb's handle rejects with it. **An assignment throws it**, since it has no handle. Write in chunks of a few hundred (section 3.6) |
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
| `not-held` | L4 | a sync read of a row this process does not hold; or, on a process that holds only part, anything that needs every row: listing `f.rows`, `f.snapshot`, `f.data.snapshot()`, an operator over every row. Also a sync read before the first picture has come. Never a stale or partial answer, never a hidden trip. The hint names the row's partition and `get` and `follow`, or a method that returns the view | `key` |
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
| `no-server-here` | L4 | a server marker in a browser or an edge worker |
| `unbound` | L4 | under a world, a name that nothing binds |
| `admin-only` | L0 | an `alter`, `drop`, `erase`, restore or placement hint without the admin key. `alter` is on the list because it can change `rules`, `methods` (the door), `history` and `copies` |

**Inside fero only:** `no-leader`, `moved`, `retry`, `end`, `gap`, `stale-attempt` and `empty`. The client acts on them by itself: it retries, follows `moved`, moves to another copy after `end`, resends in order after `gap`, or resolves an empty `claim` with `[]`. An app sees these only as a `timeout`'s `cause`, in `f.cluster.writes` and in the debugger.

**Good to know.**
- A plain assignment that is refused never shows. It is a `refused` row of `f.cluster.writes` and one stderr line, as in v4.
- A stage the write never reached rejects with the write's own error. Once a stage has resolved, the handle never ends in a refusal (section 3.5; MEMORY 9.6).
- A function of yours that throws in a view, a tap or a subscriber never stops fero; it prints one line (V4-47).
- **Gone with COMP2:** `too-many-resources`, `node-config`, `needs-persisted`, `wrong-group`, health's `meta-down`. **Renamed:** `shortfall` and `holistic` to `not-held`; `unknown-log` to `bad-cursor`; `no-writer` to `no-leader`. **New, inside fero:** `gap`.

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
| `uuid`, `redial.ms`, `redial.tries`, `leave.ms`, `journal.cap`, `diag.allow`, `shuffle` | v4's | v4's |

**The resource.** Stored in its own log at founding (V5-2); compared at every later open; changed with `fero.alter(name, change)`, online.

| Key | Default | What it does |
|---|---|---|
| `partition` | each row | `{ before }` or a function (section 3.2). Fixed at founding |
| `history` | `0` | how much of the log is kept for `changes`: a count, a time, a size, or `'all'` |
| `rows` | `true` | `false` for a stream; `{ ttl, max, where, while }` for expiry and presence |
| `copies` | 3 (1 while fewer than three servers exist; a second server is a copy that does not vote) | the copies whose disks decide a commit: 1, 3 or 5 |
| `standbys` | every other server that serves the resource, up to 2 | more full copies that do not vote (this page's reading of COMP2's default of 5 in all). A server past `copies + standbys` is a spare: it holds no copy until healing places one on it |
| `data` | none | the first rows: applied once, with the founding entry (V5-10 fix 5) |
| `methods`, `validation`, `schema`, `rules`, `load`, `rows.where`, `shape.up`, a `partition` function | none | code: the call only; the same on every server, compared by its text; a change is a rolling `fero.alter` |
| `shape.version` | 1 | which shape of row is in force |
| `election.ms`, `election.jitter` | 2000, 500 | Raft's random election timers (V5-7); `election.ms` must be more than twice `ping.ms` |
| `skew.max`, `lag.max`, `catchup.max` | 250, 1000 records, as COMP2's page | were cluster keys in `#meta`. Each resource is its own cluster, so they are its own: in its settings record, changed by `alter`, since every copy must agree on them (LAYERS 5.3; reasoned) |

**`session.ms`** (10000) is not a key of an app's resource. Sessions live in the system resource `#sessions` (LAYERS section 10 item 5), so it is `#sessions`' own setting. An app sets it like any config key, in `fero.opt.ts` or `FERO_SESSION_MS`; the server that founds `#sessions` stores it, and a later change is `fero alter '#sessions'` *(proposed; LAYERS has not written who founds the system resources)*. P-13's "within `session.ms`" reads this one value.

**This open.** Never stored.

| Key | Default | What it does |
|---|---|---|
| `server` | by declared act | `true` serves this resource from this process; `false` stays a client |
| `hold` | `'all'` | `'asked'` or a size: hold only what this open reads or follows (section 3.3) |
| `signals` | `true` | Ctrl-C is a clean stop (V4-8) |
| `bind` | `live` | under `fero test`: what this name resolves to |

- **`durability` is not a key in the first build.** Every write commits on disk at a majority (V5-5).
- **Gone from COMP2's page:** `seeds` as "the founders", `copies.meta`, `copies.default`, `cache.memory`, and the whole `fero.alter('#meta', …)` door. **Gone from v4:** `replicas`, `heartbeat.ms`, `seams`.
- **Proposed, untested** (from COMP2's page): `skew.max` 250 ms, `lag.max` 1,000 records, `session.ms` 10 s, `connect.wait` 10 s, a `once` name's life 1 day, a token's `ttl` 1 hour, a write's `timeout` 10 s (v4's).
- Each new key gets what v4's rule asks: a row in `LEAVES`, a coercion if it needs one, a README row and a `config.test.ts` case ([CLAUDE.md](../../CLAUDE.md), "The two seams").

**The CLI (L5)** keeps v4's verbs and adds `fero run`, `test`, `deploy`, `ls`, `debug`, `recover`, `restore`, `alter`, `drop`, `export`, `migrate`, and the placement hints `drain`, `retire`, `undrain`, `gone`, `lead`, `place`, `move`, `groups`. A hint goes to one resource's leaders; a `lead` hint moves leadership itself, never to a draining or leaving machine (V5-10 fix 9). The flags belong to [LAYERS.md](LAYERS.md).
## 10. Every pattern: the code, the guarantee, the cost, the layer

Each is one of REQUIREMENTS' 22 patterns, in the fewest lines that stay honest.

- **The code** is E-22's pattern code, respelled for this page's surface. E-22 ran all 22 on a prototype, 100 seeds each, with and without the shuffle, with a leader change and a slot move forced into each ([E-22]). The respelled lines did not run.
- **Guarantee** is what the call promises. **Cost** is what it costs, from section 4. **Layer** is where the work is done ([LAYERS.md](LAYERS.md)).
- **Evidence** is what was shown. The study judged these cells for COMP2 and for MIN-P+par, whose shape the base is (V5-6). Nobody judged them again for groups per resource. Where the `memory` rung was the only open point (P-10, P-15), the cell counts as met here, since the first build has no such rung (V5-5).
- A line `// ── name.ts` starts a second file. A process that creates a resource says `server: true`, or brings a seed or methods (section 3.1). **Each pattern keeps that in a server file**, and the app's lines open the bare name: an app process that said `server: true` would become one more server of the resource (section 3.1).
- **App lines that only write, or read a few rows, say `hold: 'asked'`.** A bare `fero(name)` would download the resource and then receive every write to it (section 3.3).

### P-01 Live shared state

```ts
// file: p01.ts — live shared state (two files)
import { fero } from 'fero'
type Item = { stock: number }
// ── server.ts
const shop = await fero<Item>('shop', { data: { widgets: { stock: 10 } } })   // a seed makes a server
shop.data.tap(() => console.log(shop.rows))             // every commit, live
// ── client.ts: a bare name is a client; it holds the whole resource
const client = await fero<Item>('shop')
client.data.gadgets = { stock: 3 }                      // a write, no answer: it shows when it commits (V4-7)
const ack = await client.set('gadgets', { stock: 4 })   // the same write, answered at its commit
console.log(ack.version, client.rows.widgets?.stock)    // a read here: one lookup
```

**Guarantee.** Order per partition. The answer comes once a majority has the write on disk. A process reads its own writes. **Cost.** Each write: one trip to the leader and a share of one disk sync. The read: one lookup (bar: under 100 ns at 1,000 rows). The client holds every row (`hold: 'all'`): one picture at the open, then every later write. **Layer:** L4, over L2's fold and L3's follow.
**Evidence.** Every copy equalled the fold of the committed log (600 of 600 partitions linearizable, [E-22]). The write p99 is not shown on a real kernel; the bar is C + 5 ms in TypeScript.

### P-02 Cache with expiry, session store

```ts
// file: p02.ts — cache with expiry, session store (two files)
import { fero } from 'fero'
// ── cache.ts, on a server
await fero('cache', { server: true, rows: { ttl: '10m', max: 1e6 } })
// ── app.ts, a client that holds only what it reads
const cache = await fero('cache', { hold: '50MB' })
await cache.set('user:42', { name: 'Ada' })
await cache.set('hot', { n: 1 }, { ttl: '30s' })        // this row's own ttl
await cache.touch('user:42')                            // resets the ttl, keeps the value
```

**Guarantee.** The leader removes rows by writer time, as records with a reason (`ttl`, `max`). So every copy agrees on which rows exist at each position. A row goes within one tick of its ttl, never before. With no leader it waits. `max` is kept per group, as its share rounded up. **Cost.** One commit per `set` or `touch`. Expiry work grows with what expires, not with what is held. **Layer:** L2.
**Evidence.** Held by writer time while a leader exists ([E-21], [E-22]). With a failover near the ttl, a row went 2,036 ms late ([E-22] D9). Owed: the expiry pin at 1,000 to 1,000,000 rows.

### P-03 Near cache, client data sync

```ts
// file: p03.ts — near cache, client data sync
import { fero } from 'fero'
const users = await fero('users', { hold: '200MB' })    // holds only what it reads or follows
const u = await users.get('u42')                        // a miss: one trip; from now on u42 is held and live
const same = users.rows.u42                             // here; u7 (never read) would throw 'not-held'
const sure = await users.get('u42', { fresh: true })    // at the leader: sees every finished write
const mine = users.follow(['u42', 'u43'])               // these rows as they are, then each change
await mine.ready
console.log(u, same, sure, mine.cursor)                 // a reconnect resumes from the cursor by itself
```

**Guarantee.** A miss is one trip that brings the row's partition, which is then followed (here each row is its own partition). The rows so far, then each change, with no gap and no overlap. A reconnect misses nothing. A sync read of a row not held throws `not-held`, never a stale answer. Memory stays inside the bound. **Cost.** One trip per first touch; later reads are one lookup. A reconnect sends only what was missed. **Layer:** L3.
**Evidence.** The cursor rule is model-checked across a leader crash, a reload, a slot move and a relay ([E-31]).

### P-04 Read-through cache

```ts
// file: p04.ts — read-through cache over another system
import { fero } from 'fero'
const prices = await fero('prices', { rows: { ttl: '5m' }, load: (sku) => db.price(sku) })   // load is code: a server
console.log(await prices.get('sku-1'))                  // a miss waits for one load, however many miss at once
```

**Guarantee.** One `load` per key however many readers miss at once. The loaded row is written `if: { absent: true }`, so a write that lands during the load wins. `undefined` writes nothing. **Cost.** One `load`, then one commit, per miss. **Layer:** L4, using L2's condition.
**Evidence.** Six readers missing one key made one load, in 100 of 100 seeds in each mode ([E-22]).

### P-05 WebSocket fan-out by room

```ts
// file: p05.ts — websocket fan-out by room (two files)
import { fero } from 'fero'
// ── chat.ts, a server: a room is a partition, a message a row
await fero('chat', { server: true, partition: { before: '/' }, rows: { ttl: '1d' }, history: '1d' })
// ── web.ts, a webserver: a client that follows only the rooms its sockets joined
const chat = await fero('chat', { hold: '200MB' })
wss.on('connection', (ws, room) => {
  const live = chat.follow(room)                                 // sockets in one room share one subscription
  live.tap((rec) => ws.send(JSON.stringify(rec)))                // first the room so far, then each change
  ws.on('message', (text) => { chat.data[`${room}/${fero.id()}`] = { text, at: fero.now() } })
  ws.on('close', () => live.close())
})
```

**Guarantee.** Order per room. A webserver never receives a room it does not follow. A reconnect within `history` misses nothing. **Cost.** Each change is encoded once at the server, however many follow it: 0.01 to 0.46 µs per record per follower. On the webserver, the sockets of one room share one subscription, so each change is decoded and folded once (section 3.10). The `JSON.stringify` per socket is the app's own; to pay it once per change, keep one `tap` per room and send the same text to that room's sockets. A room's first picture needs the partition index on the server (PA-17). About 1,000 sockets a core keep a round near 10 ms ([E-08]). **Layer:** L3.
**Evidence.** Met as the bar was restated (a relay batches a room for a few ms); as first worded, "one hop after the commit" is not met ([E-08]: p99 1.2 ms at 1,000 subscribers).

### P-06 Pub/sub

```ts
// file: p06.ts — pub/sub (two files)
import { fero } from 'fero'
// ── news.ts, on a server
await fero('news', { server: true, rows: false })                // keeps no rows: a stream
// ── app.ts, a client
const news = await fero('news', { hold: 'asked' })
const sub = news.changes({ of: 'sports' })                       // from now on: "now" is this call
await news.set('sports', { headline: 'late winner' })            // made after the call, so the reader sees it
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
const events = await fero('events', { hold: 'asked' })
const ack = await events.set('order:981', { type: 'paid', cents: 1200 })
const r = events.changes({ from: savedCursor ?? 'earliest', until: 'latest' })   // a saved cursor goes back in as it is
for await (const e of r) { console.log(e.partition, e.version, e.value); save(r.cursor) }
events.changes({ of: 'order:981', from: ack.version }).close()   // one partition, from a version
```

**Guarantee.** Every committed record of the selection, once, in order per partition. A position keeps its meaning across failovers and moves. Past `history`, the reader gets `expired` with the earliest kept cursor. **Cost.** Every kept record of the selection crosses the wire once. `credit` (1 MB by default) bounds what is in flight. A cursor is 22 to 79 B for 1 to 10 partitions. **Layer:** L1, L3.
**Evidence.** The log-reader rule holds on ten bounds ([E-31]); E-22 resumed from saved cursors.

### P-08 Consumer groups

```ts
// file: p08.ts — consumer groups
import { fero, consumer } from 'fero'
const orders = await fero('orders', { hold: 'asked' })
const invoices = await fero('invoices', { hold: 'asked' })
const invoicing = await consumer(orders, 'invoicing')
invoicing.run((e, out) => out.use(invoices).set(e.partition, { order: e.value, at: e.time })) // exactly once
for await (const batch of await consumer(orders, 'billing')) {                                // at least once
  for (const e of batch.entries) await bill(e.value)
  await batch.commit()                                  // a paused member's commit is refused 'fenced'
}
```

**Guarantee.** Each share has one live owner at a time, with its own token. A crash hands its shares on within one lease plus one commit. `commit()` gives at least once. `run()` gives exactly once, even after a long restart: each output's own entry carries a mark of the source position it came from ([E-30]). **Cost.** `run`: a share of one commit per output, with a 29 B mark; `out`'s writes return nothing, so they batch. `commit()`: one commit per batch. **Layer:** L5, over L3 and L2's lock check.
**Evidence.** Nothing skipped and no paused member committed (40 of 40, [E-22]; [E-30] past the dedup horizon). The hand-on time is not measured.

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

**Guarantee.** At most one live lease per message. None is lost while unacked. First in, first out per partition. After `deliveries` tries, the message moves to `thumbs.dead`. **Cost.** Three commits per message: add, take, ack. An empty take writes nothing. **Layer:** L5, on L2's `claim`.
**Evidence.** One worker killed and one paused 40 s: each job removed once, never under two live leases ([E-22]).

### P-10 Locks and leader election

```ts
// file: p10.ts — locks and leader election
import { fero, lock } from 'fero'
const ledger = await fero('ledger', { hold: 'asked' })                        // it only writes: hold nothing
await lock('payroll', { lease: '10s', wait: '5s' }, async (l) => {            // released on return or throw
  await ledger.set('run-42', { by: process.pid }, { if: { lock: l } })        // an older holder: 'fenced'
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
const views = await fero<number>('views', { hold: 'asked' })
const a = await views.set('page:/', op.incr(1))         // a.value is the new count; a retry never counts twice
const api = await limiter('api', { max: 100, per: '1m' })
console.log(a.value, (await api.take('user:42')).left)  // past 100 a minute: 'limited', with retryAfter
```

**Guarantee.** Each answered `incr` counts exactly once across retries; `a.value` is the count it made. A bound (`op.incr(-1, { min: 0 })`) is never crossed: the write is refused `conflict`. A refused take writes nothing. **Cost.** One commit per count; the op is at most 3 µs at the leader (a bar, not measured). For a count nobody needs back, `views.data['page:/'] = op.incr(1)` skips the answer. **Layer:** L2; `limiter` is L5.
**Evidence.** Exactly once and the bounds held ([E-22], [E-20]).

### P-12 Leaderboards, live aggregates

```ts
// file: p12.ts — leaderboards, live aggregates (two files)
import { fero } from 'fero'
type Score = { player: string; room: string; points: number }
// ── server.ts
export const scores = await fero.of<Score>()('scores', { methods: { top: (n: number, ctx) => ctx.data.za('points', n) } })
const top10 = scores.data.za('points', 10)              // a server holds every row
top10.tap(() => render(top10.snapshot()))
// ── screen.ts: a client typed by the server's handle; it holds nothing
const fan = await fero<typeof scores>('scores', { hold: 'asked' })
const live = fan.methods.top(10).open()                 // the server keeps the view; only its changes cross
await live.ready
live.tap(() => render(live.snapshot()))
// @ts-expect-error the typed client checks the argument: top takes a number
fan.methods.top('ten')
```

**Guarantee.** A view equals its query over the committed rows after each commit. A whole-resource view on a process that holds only part throws `not-held`; that is why the screen opens the server's view. **Cost.** At most 1 µs per affected view per change (a bar). The view is kept once, on a server; a screen receives only its changes. **Layer:** L4, data's operators.
**Evidence.** Open: `group` costs 2,574 µs at 1,000,000 rows against the 1 µs bar ([E-05]).

### P-13 Presence

```ts
// file: p13.ts — presence (two files)
import { fero } from 'fero'
// ── online.ts, on a server
await fero('online', { server: true, rows: { while: 'session' } })   // a row dies with the process that wrote it
// ── app.ts, a client
const online = await fero('online')                                  // it shows who is here, so it holds every row
await online.set('ada', { since: fero.now() })
```

**Guarantee.** When a process dies, its rows go on every copy within `session.ms` plus one tick, by a log record. A live process's rows are never removed. **Cost.** One commit per row. **Layer:** L2.
**Evidence.** A killed client's rows went within 9.8 s of a 10 s lease; a client paused 5 s kept its rows ([E-22]).

### P-14 Invariants

```ts
// file: p14.ts — invariants
import { fero, op } from 'fero'
type Item = { left: number; price: number }
const stock = await fero.of<Item>()('stock', { methods: {
  sell: { near: true, run: async (sku: string, ctx) => (await ctx.set([sku, 'left'], op.incr(-1, { min: 0 }))).value },
  reprice: ({ sku, price }: { sku: string; price: number }, ctx) => ctx.set(sku, (row) => row && { ...row, price }),
} })
console.log(stock.rows)
```

**Guarantee.** Ops, conditions and `set(key, fn)` are judged at the one leader, on the newest state, and a refusal waits for that state's commit. Two sells of the last item through two servers: exactly one succeeds; the loser gets `conflict`. **Cost.** A sale: one trip and one commit, since `near` sends the call to its row's leader. A reprice: one conditional write per try. **Layer:** L2.
**Evidence.** One winner in all 300 races under leader changes, slot moves and the shuffle ([E-22]); every history linearizable ([E-22b]). `set(key, fn)` is the condition form with a retry loop; the loop did not run.

### P-15 Transactions across partitions

```ts
// file: p15.ts — transactions across partitions (a saga)
import { fero, op, saga } from 'fero'
const accounts = await fero('accounts', { hold: 'asked' })   // it only writes: hold nothing
await saga([
  { to: accounts, key: ['alice', 'cents'], value: op.incr(-5000, { min: 0 }) },
  { to: accounts, key: ['bob', 'cents'], value: op.incr(5000) },
], { once: 'tx-981' })                                  // all applied or all undone; readers may see half
saga.sweep({ every: '10s' })                            // on a server: finish what a dead holder left
```

**Guarantee.** Every saga ends all applied or all undone, by its holder or a later one, even with paused holders. A step whose op has no inverse needs its own `undo`, or the saga is refused `no-undo` before it starts. Readers may see the steps one at a time. **Cost.** 6 to 7 commits in a row, about 7 ms. If both rows can share a partition, one `batch` does it in one commit: model for that first. **Layer:** L5.
**Evidence.** Model-checked on seven bounds, up to 2.9 million states ([E-24]); no write cycle in 300 histories ([E-22b]). Readers saw half a unit in 66 to 77 of 100 histories ([E-22]).

### P-16 Event sourcing, CQRS

```ts
// file: p16.ts — event sourcing, CQRS (two files)
import { fero } from 'fero'
type Fact = { account: string; cents: number }
// ── facts.ts, on a server
await fero<Fact>('facts', { server: true, rows: false, history: 'all' })                 // every fact, for ever
// ── app.ts, a client
const facts = await fero<Fact>('facts', { hold: 'asked' })
await facts.set('acct:alice', { account: 'alice', cents: 500 })                          // a fact is written whole, once
const balance = new Map<string, number>()
for await (const e of facts.changes({ from: 'earliest', until: 'latest' }))              // rebuild, then stop
  if (e.value) balance.set(e.value.account, (balance.get(e.value.account) ?? 0) + e.value.cents)
```

**Guarantee.** `history: 'all'` never drops a record. A rebuilt projection equals the live one, because both fold the same records with `data`. The loop reads `e.value`, which is set only for a whole-row write: so each fact is written whole, once. **Cost.** A rebuild reads the whole kept log once. **Layer:** L2, L4.
**Evidence.** E-22's rebuild check passed. Byte for byte is open for a `sum` (it depends on record order, [E-43]) and for ties in a top-k ([E-23]).

### P-17 Derived resources

```ts
// file: p17.ts — derived resources
import { fero, op, derive } from 'fero'
type Order = { user: string; cents: number }
const orders = await fero<Order>('orders', { hold: 'asked' })    // the deriver is a client of its source
const totals = await fero<number>('totals', { server: true })    // and the owner of its own resource
await derive(orders, totals, (e, out) => { if (e.value) out.set(e.value.user, op.incr(e.value.cents)) })
```

**Guarantee.** Each record of `orders` changes `totals` exactly once, across crashes, restarts and moves, as long as `orders` keeps its log (its `history`, or the tier) back to the deriver's marks. A deriver that comes back after the log was cut stops with `expired` and says so; it never skips a record (LAYERS 8.8). `op.incr` is not idempotent, so this is the hard case on purpose. An order must be written whole, once: `e.value` is unset for a field write, so the `if` skips it. **Cost.** Per source record: one delivery, one run of the function, a share of one commit, a 29 B mark. Run on three servers, the source is still read once (section 3.11; who runs it is Q-B8). `out`'s writes return nothing, so the slow way (one commit per output, about 250 records a second) cannot be written. **Layer:** L5.
**Evidence.** The mark is model-checked: no output twice ([E-30]).

### P-18 Tapes, forks, replays

```ts
// file: p18.ts — tapes, forks, replays (two files)
import { fero, tape } from 'fero'
// ── try.ts, on the live cluster
await fero.fork('shop', { as: 'shop-try' })             // shares the parent's history: one record per group, no copy
// ── a test run: one world per process, virtual time, seeded ids
const w = fero.world({ seed: 7 })
const shop = await fero('shop', { listen: false })      // a solo node with no socket
await shop.set('k', { at: fero.now() })
await w.advance('1h')                                   // ttls, leases and timers fire in order
const stripe = await tape<{ cents: number }, { ok: boolean }>('stripe', { window: '14d' })
console.log(stripe.find('charge:981'))
```

**Guarantee.** A fork is one consistent cut per group. A world makes a run a function of its seed. A recorded input re-runs on the exact earlier state. **Cost.** A fork is one record per group, not a copy. It is a new resource, so it has a resource's own cost (section 3.1). **Layer:** L1, L4; `tape` is L5.
**Evidence.** Tapes and reruns held on prototypes ([E-22], [E-06]). The fork is not built.

### P-19 Clients everywhere

```ts
// file: p19.ts — clients everywhere (a browser, an edge worker)
import { fero } from 'fero'
const token = 'from your server: fero.token({ sub: "ada", follow: ["ada*"] })'
const shop = await fero('shop', { hosts: ['wss://shop.example.com'], token, hold: '20MB' })
const cart = shop.follow({ prefix: 'ada' })
await cart.ready
cart.tap(() => render(cart.rows))
```

**Guarantee.** The same API in Node, Bun, Deno, browsers and edge workers, over WebSocket. A server marker in a browser is refused `no-server-here`. **Cost.** A browser has one link, so its writes take the forward path: one more trip than a Node client's (V5-9). The `{ prefix }` follow's first picture walks the partition names on the server (section 3.2). The bundle with `data` is 27.9 KB gzip; a cold client's first committed write took 13 to 17 ms ([E-40]). **Layer:** L0's transport, L3, L4.
**Evidence.** Met on E-40's prototype.

### P-20 Change the shape of rows

```ts
// file: p20.ts — change the shape of rows
import { fero, migrate, type Rec } from 'fero'
const shape = { version: 2, up: { 1: (r: Rec) => r } }  // how a version-1 record reads as version 2
await fero.alter('users', { shape, schema: UserV3 })    // online: a record in the resource's own log
const users = await fero('users', { shape, schema: UserV3 })
await (await migrate(users, { to: 2, fn: (row: any) => row, perSec: 500 })).done   // rewrite live rows, paced
```

**Guarantee.** The resource's log records from which position each `shape.version` is in force. An older record passes the upcasters in order on every path (folds, follows, replays). An open with a new `shape` is refused `config-differs`, so a bump is a `fero.alter`, which needs the admin key. **Cost.** At the bump, each process passes its held rows through the upcaster once. `migrate` runs at a stated pace, under the bulk byte-rate cap (V5-9). **Layer:** L4; `migrate` is L5.
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

**Guarantee.** Requests spread over the live answerers. Each request gets at most one answer. With no live answerer, `no-answerer` at once, by this process's view of who is alive. **Cost.** Three commits per ask ([E-22] D7). When the answerer is a fero server, a method is the cheaper request and reply: one trip, and commits only for what it writes. **Layer:** L5.
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

**Guarantee.** A delayed message becomes takeable within one tick of its time, by writer time, never before. A waiting take writes nothing while it waits. Priorities hold within a partition. A `cron` schedule is a row under its `key`, written only if absent: the line can run at every start-up, for years, and adds the schedule once. (A `once` name would not do: it lasts a day, so a start-up two days later would add a second schedule.) **Cost.** As P-09. A lapsed lease is noticed at the library's next poll, once a second ([E-22] D6). **Layer:** L5.
**Evidence.** No delayed message was taken early, and priority 0 came first in every seed ([E-22]).
## 11. Open questions

### 11.1 For the owner

Each has this page's pick. [API-TOUR.md](API-TOUR.md) section 5 says more on each.

The numbers are the tour's. Questions 6 to 12 came from the skeptic's pass, or were reopened by it. The tour's questions 15 and 16 are gaps in the records: Q-B1 and Q-B3 in section 11.2.

1. **`f.rows` for reads; what is `f.snapshot`?** This page: `rows` is the lookup, and `snapshot` keeps v4's meaning, a whole frozen picture per access, at v4's cost. The other way makes `snapshot` a second name for the live `rows`: old lines get fast for free, but one word then means two things (section 3.9).
2. **Verbs on the resource (`f.set`), or on `f.data` (`f.data.set`)?** This page: on the resource. It is shorter, and it has no row names to collide with. (Speed is not a reason: `f.data.set` is one property read that returns a closure, code: api/substrate.ts:339-340.) v4's lens calls stay and return the same handle.
3. **`near` on a method: now, or after the first build slice is timed?** This page: now. It is plain data and no kernel rule (PATHS 7.1 row 19), and without it the door's own path pays a forward on about 2 calls in 3. It can also be added later without breaking a call.
4. **`set(key, fn)`: add it?** This page: yes. It is the one new verb form, and it costs nothing unless called. The risks: a function that is not pure and runs twice; and it can give up with `conflict`.
5. **`changes`, `log` or `read`** for the record reader. This page: `changes`. `log` matches V5-1's word but reads like a logger; `read` reads like reading a row.
6. **What a write does when the client is full** (512 waiting, or 64 MB). This page: a verb's handle rejects `backpressure`; an assignment throws it. The other way, one stderr line as for any refused assignment, loses writes without the code knowing.
7. **Must some process say `server: true` to create a resource?** This page: yes, as v4, and the patterns keep it in a server file. The other way is an admin act (`fero create`), so that no app file can become a server by mistake.
8. **A client's default `hold`.** This page: `'all'`, as v4. It keeps the ten-line demo and the ladder true. Against it: a bare `fero(name)` in a job downloads the resource and then receives every write to it, and nothing in the line says so. `'asked'` would be the safer default.
9. **A `get` that misses: follow for good, or read once?** This page: it follows (PATHS 4.4), and `get(key, { hold: false })` reads once and keeps nothing.
10. **Should the typed client of a resource with methods have no `set`, `remove`, `batch` or `touch`?** This page's pick: yes, so the door shows when the code is compiled. It is not in section 6 yet; today those calls compile and are refused `methods-only` when run.
11. **`{ retry: true }` on a call: keep v4's cheap resend?** This page: yes, beside `once`. Without it an idempotent call pays three commits, or the app writes its own retry.
12. **A write with `once` has no early stages.** This page: so, because its name can be refused, and V5-11 ruling 6 forbids an early answer before a refusal.
13. **The partition function.** V5-2 names it, so it is in. It costs a text check across servers, a forward for processes without it, and the same index as a prefix. `{ before }` covers all 22 patterns. This page's pick: in the API, built after the prefix.
14. **Names only:** `once`; `not-held`; `consumer`; `if: { lock }`; `hold` (and `hold: false` on a `get`); `copies` and `standbys`; `fero.of<Row>()`; `e.value`; a queue's `key`; `ping.ms` (v4: `heartbeat.ms`); `rendezvous` as a list (the other way: a new `seeds` key); `handback.max`; `bulk.rate`. None touches the wire.

### 11.2 For the design

Each is a gap the records leave. None changes a call.

- **Q-B1. An early answer, then a refusal that is not about the row.** V5-11 ruling 6 says an early answer is never followed by a refusal. A plain whole-row write cannot be refused on the row's state. But after a failover the resent write is judged again (MEMORY 9.6), and three things may have changed by then:
  - the write gate is closed (`read-only`), or a disk is full (`disk-full`). **This page's pick:** fero keeps retrying through those two, so the handle ends at the commit, `timeout` or `unknown`.
  - the writer's token was revoked (`forbidden`). Retrying cannot clear that. **This page's pick:** the handle rejects `forbidden`. It is the one refusal that can follow an early answer, and it is an admin's act, not the state's. Answering `unknown` would say "it may have committed", which is false.
  - **Decides:** [E-48]'s model with a gate and a revoke.
- **Q-B2. When must a stage be asked for?** PATHS 3.3 sends an early report only for a write that asked. MEMORY 9.6 makes the stage promises lazily. This page joins them as "ask in the turn that makes the write" (section 3.5). **Decides:** the build of the second step.
- **Q-B3. Who serves the system resources and the libraries' resources** (`#sessions`, `#locks`, `#sagas`, `#calls`, `#groups`, a queue)? With no project groups, each is a resource with its own cluster. This page reads: any process that serves a resource serves the system ones, and a library's resource takes `server: true` like any other (section 7 "Roles"). It shows in the cold-open cost and in what a client waits for. **Decides:** [LAYERS.md](LAYERS.md) section 10 item 5.
- **Q-B4. Where the timing keys live** (section 9). Answered by LAYERS 5.3 (reasoned): a value every copy must agree on (`skew.max`, `lag.max`, `catchup.max`) is in the resource's settings record; `session.ms` is in `#sessions`' own; a value one process applies alone (`ping.ms`, `evict.after`, `settle.ms`, `leave.ms`, `handback.max`) is a process key. Section 9 agrees.
- **Q-B5. Is a process-wide `dir` or `listen` a server marker for every open?** v4 reads them per call. With the role per resource, this page reads them as markers only where the call, or a per-name layer, gives them. **Decides:** the config tier's tests.
- **Q-B6. `set(key, fn)`'s give-up.** 8 tries is a guess. **Decides:** a timed hot-key run.
- **Q-B7. When "now" is, for `changes()`** (section 3.10). The rule "a write made after the call is seen" needs the client to hold its own writes until the open is answered, on a process that does not hold the selection. Nothing modelled it. **Decides:** [E-31]'s model with a writer that also reads.
- **Q-B8. Who runs a `derive`.** This page: the derivers split the source's shares, as consumers do. PATHS 4.9 and LAYERS 8.8 read the deriver as the leader of the target's group. Both do the work once; the leader needs no lease, the split spreads a big source. **Decides:** LAYERS section 11, before `derive` is built.
- **Q-B9. Shared follows, and when `await fero()` resolves** (sections 3.10 and 3.1) are stated here from reasoning. **Decides:** the build.

**Where this page and [LAYERS.md](LAYERS.md) stand.** LAYERS now agrees on the handle's members (`rows` and the verbs), on `rendezvous` as the seed addresses' key, on `once` as the caller key, on what two servers hold (8.2 step 9), on `session.ms` as `#sessions`' own setting (5.3), and on dropping `stale-plan` (E-52 found the check not needed). Two points stay open between the pages:
- **Who runs a `derive`** (Q-B8 above): this page's split by shares, or LAYERS 8.8's leader of the target's group.
- **`busy`**: this page uses it for "every server tried has a stalled main thread"; DESIGN-V5 4.2 uses it for a member already loading two snapshots, an answer between servers that no app sees. LAYERS section 10 item 23 asks for one of them to be renamed.

### 11.3 Carried from COMP2's page

**Still settled:** `get` for one row and a separate verb for the log (Q-A5); no public `slots` key (Q-A7); a `once` name lasts 1 day (Q-A11); no `publish` verb, since `set` on a `rows: false` resource is publishing (Q-A13); offsets never in answers, a version has a number form for gateways (Q-A14); one error class (Q-A15); the libraries are named exports of `'fero'`, built only from the verbs (Q-A18); durations are `'30s'` or milliseconds, and config keys keep `.ms` numbers (Q-A19); functions run at the leader (Q-A20); shares for consumers (Q-A21); typed rows with an optional schema (Q-A22).

**Settled the other way now:** who creates a resource (Q-A1: a server, section 3.1); partition rules (Q-A6: a function is allowed, V5-2); where methods run (Q-A8: still where the caller reached, plus `near` for speed); answer timing per call (Q-A9: stages, V5-5 and V5-11).

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
declare const db: { price(sku: string): Promise<{ sku: string; cents: number } | undefined> }
declare function resize(url: string): Promise<string>
declare function sendMail(to: string): Promise<void>
declare function bill(order: unknown): Promise<void>
declare function render(x: unknown): void
declare const savedCursor: string | undefined      // text from the app's own storage
declare function save(c: string): void
declare const UserV3: import('fero').Schema<{ id: string; name: { first: string; last: string } }>
```

```ts
// file: types.ts — what must and must not type-check
import { fero, op, saga, lock, derive, type Early, type Judged, type Write, type Version } from 'fero'

const f = await fero<{ n: number }>('f')
const w: Write = f.set('k', { n: 1 })
const e: Early = await w.received
// @ts-expect-error an early answer has no version (V5-11)
console.log(e.version)
// @ts-expect-error an op answers at commit only: no early stage (V5-11 ruling 6)
await f.set('k', op.incr(1)).received
// @ts-expect-error a field write can be refused 'absent-row': no early stage
await f.set(['k', 'n'], 5).replicated
// @ts-expect-error a condition answers at commit only
await f.set('k', { n: 2 }, { if: { absent: true } }).replicated
// @ts-expect-error a conditional remove too
await f.remove('k', { if: { present: true } }).received
// @ts-expect-error read-decide-write is judged: no early stage
await f.set('k', (row) => row && { n: row.n + 1 }).received
// @ts-expect-error a batch is all or none: no early stage
await f.batch([{ key: 'a', value: { n: 1 } }]).received
const j: Judged = f.set('k', { n: 2 }, { if: { absent: true } })
const acks = await Promise.all([f.set('a', { n: 1 }), f.set('b', { n: 2 }), j])   // handles await together
// @ts-expect-error the stage is what you await, never a write option
await f.set('k', { n: 3 }, { confirm: 'received' })
// @ts-expect-error no commit level per write (V5-5)
await f.set('k', { n: 3 }, { durability: 'memory' })
// @ts-expect-error the row type is checked
await f.set('k', { m: 1 })
// @ts-expect-error rows are read-only
f.rows.k = { n: 1 }
const row: { n: number } | undefined = f.rows.k          // a lookup can miss
const pic: { n: number } | undefined = f.snapshot.k     // v4's picture: the same type, a frozen copy
// @ts-expect-error a named write is judged (the name may be taken): no early stage
await f.set('k', { n: 4 }, { once: 'order-77' }).received
// @ts-expect-error a named remove too
await f.remove('k', { once: 'order-78' }).replicated
const lens: Write = f.data.set('k', { n: 1 })            // v4's lens call returns the same handle as f.set
// @ts-expect-error a batch's whole-row value is checked against the row type
await f.batch([{ key: 'a', value: { m: 1 } }])
// @ts-expect-error a derive output is checked against the target's row type
await derive(f, f, (x, out) => out.set('a', { m: 1 }))
// @ts-expect-error the partition rule is fixed at founding
await fero.alter('f', { partition: { before: '/' } })
// @ts-expect-error a seed is applied once, at founding
await fero.alter('f', { data: {} })
await f.get('k', { hold: false })                        // a one-shot read: nothing is kept
// @ts-expect-error hold is 'all', 'asked' or a size
await fero('x', { hold: true })
// @ts-expect-error copies: 2 cannot keep a majority through one loss
await fero('x', { copies: 2 })
// @ts-expect-error a history is a number of records, a time or a size
await fero('x', { history: '7 days' })
// @ts-expect-error incr takes a number
op.incr('1')
// @ts-expect-error versions are opaque, never plain strings
await f.set('k', { n: 1 }, { if: { version: '9001' } })
const v = (await f.get('k', { version: true }))?.version
if (v) await f.set('k', { n: 2 }, { if: { version: v satisfies Version } })
f.data.k = op.incr(1)                                    // an op by assignment
await f.set('k', { n: 4 }, { once: 'order-77' })         // a caller's name for the write
await f.set(['k', 'at'], op.now('15m'))                  // writer time, plus 15 minutes
const r = f.changes({ of: 'k', from: v })                // from a version
const text: string = r.cursor                            // a cursor saves as text
f.changes({ from: text }).close()                        // and goes back in as it is
// @ts-expect-error read() is changes() now
f.read({ from: 'earliest' })
// @ts-expect-error a saga step names its resource
await saga([{ key: 'a', value: 1 }])
// @ts-expect-error a staged output returns nothing: there is nothing to await
await derive(f, f, (x, out) => out.set('a', op.incr(1)).received)
const held: number = await lock('l', async (l) => { await f.set('k', { n: 5 }, { if: { lock: l } }); return 1 })

// methods: handlers get a typed ctx, callers get typed arguments, with or without the hint
const bank = await fero('bank', { methods: {
  deposit: { near: true, run: async (who: string, ctx) => (await ctx.set([who, 'cents'], op.incr(5))).value as number },
  ping: (_, ctx) => ctx.peer,
} })
const n: number = await bank.methods.deposit('ada', { once: 'dep-1' })
// @ts-expect-error the argument is a string
bank.methods.deposit(5)
// @ts-expect-error deposit needs its argument
bank.methods.deposit()
// @ts-expect-error a plain result has no live form
bank.methods.deposit('ada').open()
const who: string = await bank.methods.ping()            // an untyped argument may be left out
const typed = await fero<typeof bank>('bank')            // a client typed by the server's handle
const n2: number = await typed.methods.deposit('ada')
// @ts-expect-error the typed client checks arguments too
typed.methods.deposit(5)
// the row type given by hand, and the methods: `fero.of<Row>()` works out the methods' type
type Acct = { cents: number }
const till = await fero.of<Acct>()('till', { methods: { pay: (n: number, ctx) => ctx.set('a', { cents: n }) } })
const client = await fero<typeof till>('till')
await client.methods.pay(5)
// @ts-expect-error an unknown method name is refused on the typed client
client.methods.nosuchmethod(42)
// @ts-expect-error and a wrong argument
client.methods.pay('five')
// @ts-expect-error `fero<Row>(name, { methods })` would leave the methods untyped, so it does not compile
await fero<Acct>('till', { methods: { pay: (n: number) => n } })
const loose = await fero<Acct>('till')                  // typed by its rows only: its calls are untyped
await loose.methods.pay('anything')
console.log(acks.length, e.stage, row, pic, lens, held, n, n2, who)
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

**Result, run here on 2026-11-16, after the skeptic's pass** (Node v22.22.0, TypeScript 6.0.2, data at 63fea66): `ok: 36 blocks type-check (tsc Version 6.0.2)`.
- There are 34 `@ts-expect-error` lines: 32 in `types.ts`, one in `methods.ts` and one in `p12.ts`. With all 34 stripped, tsc reports 34 errors, each for the reason its comment gives. For example, `received` "does not exist on type 'Judged<Ack>'" for a write with `once`, `nosuchmethod` "does not exist on type 'Callers<{ pay: … }>'", and `copies: 2` matches no overload.
- Two errors were found and fixed this way in the first draft. The handler's typed `ctx` was lost when `methods` was typed as an intersection. And one type argument could not serve both `fero<Row>` and `fero<typeof shop>`, so `fero` has overloads.
- **A pass that hid a fault.** The skeptic found that `fero<Row>(name, { methods })` compiled and left the methods untyped, so `fero<typeof shop>` accepted any method name. Three blocks did it (`methods.ts`, P-12, P-14), and the checker passed, because nothing tested a wrong call on those handles. Now that form does not compile, the three blocks use a seed or `fero.of<Row>()`, and `methods.ts`, `p12.ts` and `types.ts` each hold a line that must fail. A default of "no methods" for the second type argument was tried and dropped: it broke the handlers' typed `ctx`, since TypeScript takes a callback's context from the default.
- **Not checked here: that any of it runs.** [E-22] ran the earlier spelling. Nothing on this page is built.

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
