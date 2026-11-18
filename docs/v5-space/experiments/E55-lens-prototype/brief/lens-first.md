# LENS-FIRST: an API proposal for fero v5

Written 2026-11-17. One of three independent proposals that answer the owner's feedback on [API.md](../../../API.md) and [API-TOUR.md](../../../API-TOUR.md).

**The angle.** Take the owner's model as far as it goes. Every handle is a path lens: `r.a.b.c`. Reads, writes, methods, live flow and derived resources are all calls on a lens. Then say where that is better than API.md, and where it is worse.

**Nothing here is built.** The declarations in section 5 type-check and a small prototype ran (section 10). The short code blocks in sections 1 to 4 show the shape; only section 5's lines were compiled. The costs are PATHS', the experiments' and the brief's.

**How each claim is marked.**
- **measured here**: run for this page. The script is named. Files are in `./lensfirst/`. Node v22.22.0, TypeScript 6.0.2. Node 26 was not used.
- **brief n**: the facts brief `./brief.md`, a section. Its own marks stand behind it.
- **E-nn**: an experiment under `docs/v5-space/experiments/`. **PATHS n**, **PA-n**, **API n**, **LAYERS n**: those pages. **code:** a file and line.
- **reasoned**: an argument. Nothing ran it. **from memory**: an outside fact nobody checked here.

**Words.**
- **lens**: an address. It names a resource and a path inside it. It holds no data.
- **step**: one property read on a lens: `.widgets`. It makes a longer address.
- **verb**: a call on a lens: `.set(4)`. It does the work.
- **row**: one entry of a resource, with its own version, expiry and conditions. **partition**: the rows kept in one order by one leader.
- **link**: one live connection from a lens to a target.
- **trip**: one message there and its answer back. **commit**: a write is on disk on a majority (V5-5).

---

## 0. The proposal in short

1. **`f.data` is a lens, and every step from it is a lens.** `shop.data.widgets.stock` is an address. Making it costs no trip and reads no data.
2. **A call is a verb on the path before it.** `shop.data.widgets.stock.set(4)`. Steps and calls are two spaces, so a field named `set` or `filter` never collides with a verb.
3. **A method is called on a path, and runs at that path's leader.** `stock.data.widgets.sell()`. This replaces `near`.
4. **`connect(target)` pipes the picture so far, then each commit, into the target.** fero holds the target by a weak reference (a `WeakRef`: a pointer that does not keep its object alive). When the target is collected, the link ends. A link also ends by `close()`, by its scope, or when a socket closes.
5. **`here()` is the boundary.** In `lens.za('points', 10).here().map(fn).connect(el)`, what is left of `here()` runs where the rows live (a server, if this process does not hold them). What is right of it runs in this process. A `connect` with no `here()` before it puts the boundary at the `connect`.
6. **`follow` goes.** `lens.here()` is the old `follow`. `get` reads once and keeps nothing.
7. **`derive` goes as a function.** A derived resource is a `connect` whose target is another resource's lens. The exactly-once marks stay; they ride that connect.
8. **A resource may be two keys deep.** `depth: 2` makes `chat.data.room1.m7` a row and `room1` its partition. This replaces `partition: { before: '/' }`.
9. **`f.rows` stays** as the fast sync read. A read through a lens costs more than a `Map` read (section 3.2).
10. **A sink gets one argument per commit**: the commit, with `value` and `changes`, both lazy and by reference.
11. **`lens.asOf(position)`** reads a past value from an undo ring kept in memory. Far positions use a fork.

**The honest headline.** The model makes the surface smaller and more regular: 9 names go and 8 come (section 7). It also makes four things worse: lifetimes tied to the collector are not exact; a hot read through a lens is slower than `rows`; typed code cannot use plain assignment; and client-chosen server views open a cost door on the servers. Section 6 lists both sides.

---

## 1. The model: five ideas

### 1.1 A step is an address; a call is a verb

```ts
const stock = shop.data.widgets.stock        // three steps: an address. No trip, no read.
const n = await stock                        // a verb (get): here if held, else one trip
stock.set(4)                                 // a verb: one write
shop.data.widgets.set.set(5)                 // the FIELD named 'set', set to 5
```

- A property read on a lens always returns a lens. It never returns a value, a method or `undefined`.
- A call on a lens takes the **last step as the verb's name** and runs it on the path before it. So `a.b.set(5)` is the verb `set` on `a.b`.
- That is the owner's separate space for calls. A row or a field can be named `set`, `filter`, `connect` or `sell`. It is reached by a step. The verb is reached by a call. Checked: a prototype handler does exactly this (**measured here**, `run/lens-proto.mjs`), and the types allow `f.data.k.set.set(5)` (**measured here**, `types/collide.ts` compiles).
- **One name is reserved: `then`.** JavaScript's `await` reads it. So `await lens` is the verb `get`, as in v4 (code: api/substrate.ts:323-327). A key named `then`, or a key held in a variable that might be a verb's name, takes `lens.at(key)`.

### 1.2 A lens is a value you can pass

```ts
await saga([{ at: accounts.data.alice.cents, value: op.incr(-5000, { min: 0 }) },
            { at: accounts.data.bob.cents,   value: op.incr(5000) }])
function Badge(count: Lens<number>) { count.connect(el, (node, c) => { node.textContent = String(c.value) }) }
```

A lens carries its resource and its path. A saga step, a component and a library take one argument where API.md takes a resource and a key.

### 1.3 The boundary: `here()`

Left of `here()`: where the rows live. Right of it: this process. One rule, read off the line (section 3.6).

### 1.4 A link dies with its target

`connect(target, …)` returns a **link**. It ends at the first of: `link.close()`; its scope is disposed; the target says it closed (a socket); the target was collected (section 3.5).

### 1.5 The first key is the partition

By default a row is its own partition, as today. With `depth: 2` the first key is the partition and the second is the row. No separator character, no string building (section 3.10).

---

## 2. The surface on one screen

```ts
import { fero, op } from 'fero'

const shop = await fero('shop', { data: { widgets: { stock: 10, price: 5 } } })   // a seed makes a server
const w = shop.data.gizmos.set({ stock: 7, price: 9 })       // a write, with a handle
await w.received                                             // optional: a progress report (V5-11)
const ack = await w                                          // committed
const sold = await shop.data.widgets.stock.set(op.incr(-1, { min: 0 }))   // the leader computes it
const left = shop.rows.widgets?.stock                        // the fast read here: one lookup
const same = shop.data.widgets.stock.peek()                  // the same value through the lens
const sure = await shop.data.gadgets.get({ fresh: true })    // a read at the leader: one trip
const low = shop.data.lt('stock', 5)                         // a view: an address plus an operator
low.connect(panel, 'rows')                                   // live: panel.rows is the view, kept up to date
low.tap((c) => console.log('low', c.value))                  // a strong sink: lives until close()
for await (const e of shop.data.changes({ from: 'earliest', until: 'latest' })) console.log(e.version, e.value)
```

**Where each kind of line runs, and what crosses the network.** "ASK", "ANSWER", "SUB", "SNAP", "DELTA", "END" and "CREDIT" are v5's wire verbs (LAYERS 7).

| You write | Where it runs | What crosses the network |
|---|---|---|
| a step: `f.data.a.b` | here | nothing |
| `f.rows.k`, `lens.peek()` | here, on rows held here. Not held: throws `not-held` | nothing |
| `await lens`, `lens.get()` | here if held; else at a copy (`fresh`: at the leader) | held: nothing. Else one ASK and one ANSWER with the value at that path. **Nothing is kept** |
| `lens.set(v)`, assignment, `remove()`, `touch()` | at the partition's leader | one ASK with the record `{ type, key: [...path], value }`, encoded once; ANSWERs for the stages asked for, and the commit |
| `lens.method(arg)` | at the leader of the lens's partition (the root lens: any server) | one ASK `{ method, path, arg }`; one ANSWER after the handler's writes commit |
| `lens.here()` | the fold runs here | one SUB (selector, `state` mode, cursor); one SNAP with the selection once; one DELTA frame per change, encoded once for all readers; CREDIT; END at `close()` |
| `lens.connect(target, …)` | the sink runs here | as `here()` if the selection is not held yet; else nothing new. END when the last link on that selection ends |
| operators left of the boundary, rows not held | on a copy | SUB with a `view` selector (the operator chain as plain data); SNAP and DELTAs carry only the view's own output |
| operators right of the boundary, or rows held | here | nothing new |
| `lens.changes(opts)` | your loop | SUB in `log` mode from a cursor; every record of the selection; CREDIT in bytes |
| `source.changes().connect(target.data, fn)` | `fn` runs here | the `log` SUB above; one ASK per output partition per source record, batched per turn, each with a 29 B mark |
| `lens.asOf(pos)` | here, in the undo ring | nothing. Past the ring: throws `expired`; use a fork |
| `lens.tap(fn)` | here | nothing new |

**The four rules of thumb.** The first three are API.md's (API 2), unchanged.
1. A read with no `await` never leaves this process.
2. Anything that changes data, or brings data here, sends a message. `await` only waits.
3. Awaiting a write means committed.
4. **`here()` and `connect()` bring data here; `get` does not keep it.** *(new)*

---

## 3. The constructs

Each one gives the code, where it runs, the wire, the cost, the decisions it touches, and the change in rules. A **rule** is one thing a builder must get right (SIMPLICITY 1; V5-6). The base has 416 (LAYERS 0.2). Every rule count below is **reasoned**; no model ran one.

### 3.1 The lens and the call space

```ts
const shop = await fero<Record<string, Item>>('shop')
shop.data.widgets.stock            // Lens<number>: typed steps
shop.data[sku].stock               // a key in a variable: a bracket step
shop.data.at(key).stock            // a key that may be 'then' or a symbol
// @ts-expect-error the path is typed: no such field
shop.data.widgets.stok.set(5)
// @ts-expect-error the value is typed too
shop.data.widgets.stock.set('five')
```

- **Runs:** here. **Wire:** nothing.
- **How it works.** One `Proxy` handler serves every lens. Its `get` trap makes a child lens. Its `apply` trap pops the last step and runs that verb. Every lens is callable, so `typeof lens` is `'function'`.
- **Typed paths, which API.md does not have.** API.md leaves `f.data.k` and everything below it untyped, "since it is data's own proxy" (API 6). Here a step is typed from the row type, and a field write's value is checked. Both lines above fail to compile (**measured here**, `types/patterns.ts`: the 22 patterns compile, and the 5 lines there that must not compile do not).
- **Cost of a step** (**measured here**, `run/lens-proto.mjs`, 10,000 rows, keys spread, median of 5 rounds of 200,000):

| What | ns |
|---|---|
| a `Map` read and a field, as `rows` does: `map.get(k).n` | 76 |
| data's handle today, two cached steps, no value read | 328 |
| **a lens, `L[k].n.peek()`**: two steps, the verb's step and the call; three proxies made, none cached | **496** |
| **a kept lens, `.peek()`**: the verb's step and the call | **173** |
| a write through data's handle: `s.get(k).get('n').update(v)` | 1,889 |
| a write through the lens: `L[k].n.set(v)` | 3,685 (not a fair pair: see below) |

  - So a lens read costs about 6.5× the `Map` read, and a kept lens about 2.3×. The lens's own share is about 140 ns per step or call. This is why `rows` stays (3.2).
  - **The write row is not a fair pair.** In that run the lens loop wrote non-integer numbers and the handle loop wrote integers, and the prototype's `set` re-walks data's handle. The script was fixed and a rerun was queued behind E-54's timing lock; it had not run when this page was finished (its lines will append to `run/lens-proto.jsonl`). From the read rows, the lens's own share of a write should be about 0.4 to 0.6 µs: three steps and a call (**reasoned**). That is 5 to 8 % of v4's 7.7 to 8.3 µs issue path (PATHS 2.6). A kept lens pays about a third of it.

- **A lens caches nothing.** data's handle today caches every child on its parent for the parent's life: 318 B per key read one step deep, 990 B two steps deep, never freed (brief 1.1). At 1,000,000 rows read once each, that is hundreds of megabytes that no API line shows. A lens must not do that. The price is an allocation per step, which the table above measures.
- **So: keep a lens you use often.** `const stock = shop.data.widgets.stock`, once, outside the loop. A kept lens costs one call per use.
- **What it prints.** Node's `console.log` shows a `Proxy`'s target and runs no trap (API 3.9). The target is a function, so a bare lens would print `[Function]`. The target carries `[util.inspect.custom]`, which prints `Lens(shop.data.widgets.stock)`. Owed: a test.
- **Touches:** nothing in V5-1 to V5-11. V4-5 and V4-7 are in 3.3.
- **Rules: +4.** (1) A step does no work and keeps no state. (2) A call pops the last step as its verb; an unknown verb is refused `no-method` with a hint. (3) `then` is the one reserved step. (4) A method cannot take a verb's name; the founding open refuses it `config`.

### 3.2 Reads: `rows`, `peek`, `get`

```ts
const a = shop.rows.widgets?.stock                 // fastest: one lookup, the frozen row by reference
const b = shop.data.widgets.stock.peek()           // the same value, by address. Throws 'not-held'
const c = await shop.data.widgets.stock            // here if held; else one trip. Keeps nothing
const d = await shop.data.widgets.get({ fresh: true })   // at the leader
```

- **`rows` stays.** A lens read is steps plus a call: several times a `Map` read (the table in 3.1). Performance is a hard requirement, so the hot sync read keeps its own door. This is a place where the lens model is **worse**: it does not get the surface down to one read form.
- **`peek()`** is for code that already holds a lens. It never trips and never guesses (API 3.9's rule).
- **`get` reads once and keeps nothing.** In API.md a `get` that misses follows the row's partition for good, and with `hold: 'asked'` and no size "nothing is ever dropped" (API 3.3). That is a slow leak the line does not show. API.md patched it with `get(k, { hold: false })`. Here the split is the verbs': **`get` reads, `here()` holds.**
  - PATHS 4.4 says a miss should be one state-mode SUB, since a GET then a SUB costs two trips. That still holds: code that wants the row kept calls `here()`, which is that one SUB. Code that wants it once calls `get`, which is one ASK.
- **`hold`** keeps two values: `'all'` (the open downloads the resource) and `'asked'` (nothing until a `here()` or a `connect`). A size (`'200MB'`) bounds what `here()` and `connect` brought: selections with no live link are dropped first.
- **Wire:** the table in section 2. A `get` of a field sends the field, not the row (the server walks the path: reasoned, about 0.1 µs).
- **Cost.** `rows.k`: a `Map` read plus one trap, 43 ns to about 1 µs (PATHS 4.1). `get` on a miss: one trip, about 40 µs on one box (E-01).
- **Touches:** V5-5 (a `fresh` read is the leader's read index, unchanged).
- **Rules: −2, +1.** Gone: `get`'s `hold: false`; "with no size, a `get` holds for ever". New: `peek` and `rows` read only what is **strongly** held (3.5 explains why).

### 3.3 Writes: `set`, assignment, `remove`

```ts
const w = shop.data.gizmos.set({ stock: 7, price: 9 })     // a whole row: a Write, with early stages
await w.received
await shop.data.widgets.stock.set(4)                       // a field: answers at its commit (it can be refused 'absent-row')
await shop.data.widgets.stock.set(op.incr(-1, { min: 0 })) // an op
await shop.data.gizmos.set(row, { if: { absent: true } })  // a condition
await shop.data.widgets.set((w) => w && { ...w, price: 12 })   // read, decide, write
shop.data.gadgets = { stock: 3, price: 2 }                 // assignment: the same write, no answer (untyped handles only)
await shop.data.gizmos.remove()
```

- **`shop.data.a.b.c.set(v)` against `shop.set(['a','b','c'], v)`.** The owner is right that the first composes better. The address is one thing, the verb another. A component that was handed `stock` can write it without knowing where it sits. So **`f.set`, `f.get`, `f.remove`, `f.touch` go**; API.md's "lens calls" (`f.data.set(k, v)`, `f.data.k.update(v)`) are no longer a second spelling of them (API 3.4): there is one spelling.
- **The types know where the lens points.** A plain `set` on a row lens returns a `Write`, which has `received` and `replicated`. On a field, on a partition, with an op, a condition, a function or a `once` name it returns a `Judged`, which answers at its commit only (V5-11 ruling 6). `await client.data.gadgets.stock.set(5).received` does not compile (**measured here**, `types/patterns.ts`).
- **Assignment cannot be typed on a typed lens.** TypeScript has no way to say "this property reads as a lens and takes a row" on a mapped type. So `f.data.k = row` is a compile error on `fero<Row>(…)` (**measured here**, `types/collide.ts`). It works when the code runs, and it compiles on an untyped handle. **Typed code writes with `set`.** This is a real loss against the owner's taste for plain assignment. API.md escapes it only by leaving `f.data` untyped, which also means it checks nothing.
- **Runs:** at the partition's leader. **Wire:** one ASK, the record encoded once at the issuer (PA-13); the same bytes as API.md's `f.set`.
- **Cost.** One trip and a share of one disk sync: 0.97 ms at the median on one box in TypeScript (MEMORY 9.3). The lens adds its steps and one call at the issuer (the table in 3.1), against about 8 µs for v4's whole issue path (PATHS 2.6).
- **Touches.** **V4-7:** unchanged. The write shows in `rows`, `peek` and every link when it commits; a refused one never shows. **V4-5:** on a resource with methods, a client's `set` is refused `methods-only`; the typed client lens of such a resource has no `set` and no `remove`, so the door shows at compile time (API.md's question 10, answered yes). **V5-5, V5-11:** the stages are in the types.
- **Rules: −1.** Gone: "the lens calls are the verbs under another name and return the same handle" (API 3.4).

### 3.4 Methods on a path, and `near`

```ts
// ── server.ts
const stock = await fero('stock', {
  data: {} as Record<string, Item>,
  methods: {
    sell: (_: void, ctx) => ctx.at.left.set(op.incr(-1, { min: 0 })),          // ctx.at: the lens the call was made on
    reprice: (price: number, ctx) => ctx.at.set((row: Item | undefined) => row && { ...row, price }),
    top: (n: number, ctx) => ctx.data.za('left', n),                           // returns a view
  },
})
export type Stock = typeof stock
// ── client.ts
const client = await fero.as<Stock>('stock')
await client.data.widgets.sell()               // runs at widgets' leader: one trip, one commit
await client.data.widgets.reprice(12)
client.data.top(10).connect(board, 'rows')     // called on the root: any server; live
```

- **A call on a path says where it runs:** at the one leader of that path's partition. The owner asked whether this replaces `near`. **It does.**
  - API.md's `{ near: 'sku', run }` is a hint stored in the resource's settings. It says "the argument's `sku` field is the row this call is about" (API 3.8). The client reads the hint and routes.
  - Here the caller's own line carries the row: `client.data.widgets.sell()`. There is no hint to declare, store or learn. The argument no longer repeats the key.
  - The cost is the same as `near`'s: one trip and one commit, "the least a call can cost" (PA-25). Without it, about 2 writes in 3 take one more trip with three servers.
- **It is still for speed, not safety.** A method is not a transaction (API 3.8). The op, the condition or `set(fn)` makes the write safe.
- **A method called on the root lens** (`client.data.top(10)`) runs at any server, as a plain call does today.
- **A method that returns a view** is awaited for one picture or connected for a live one. `LiveCall.open()` goes: `connect` is the live form everywhere.
- **`f.methods` goes** as a namespace. V4-5's key stays: `methods:` in the options still closes the door.
- **Where this is worse.** Methods now share the call space with fero's verbs. A method cannot be named `set`, `get`, `connect`, `here`, `tap`, `filter` or any other verb, and a verb fero adds later could clash with a method somebody wrote. API.md's 2.3 made the opposite point: "`methods` holds only yours, so a method named `update` clashes with nothing." The way out is `lens.call('update', arg)`, which reaches any method by name.
- **Runs:** at a leader. **Wire:** one ASK `{ method, path, arg }`, one ANSWER. The client routes by the partition's hash and the leader table it already has (V5-9).
- **Touches:** V4-5 (kept), V5-9 (direct routing does the work).
- **Rules: 0.** +2: route a call by its path's partition; `ctx.at` is the caller's lens. −2: the `near` hint's two forms; a client learning the hint from the settings.

### 3.5 `here()` and `connect()`: flow and lifetimes

```ts
const chat = await fero<Rooms, {}, 2>('chat', { depth: 2, hold: 'asked' })

const room = chat.data.room1.here()                      // hold room1 here, live: the old follow
await room.ready
room.m7.peek()                                           // sync reads work under a here()
room.close()

chat.data.room1.connect(el, (node, c) => {               // el: a DOM node. fero holds it weakly
  for (const ch of c.changes) patch(node, ch)            // first call: the room so far, as adds
})
chat.data.room1.connect(state, 'room')                   // state.room is always the latest room
chat.data.room1.connect(ws)                              // a socket: one JSON text per commit; ends when ws closes
const link = chat.data.room1.m7.text.connect(label, 'textContent')
link.close()                                             // any link can be ended by hand
```

**What `connect` does.** It hands the target the picture so far, then each commit. No gap, no overlap (data's SCHEDULE clause 7; E-31 across the network).

**The four forms.**

| Form | What the target gets |
|---|---|
| `connect(target, (target, commit) => …)` | your function, called with the target and the commit (3.8) |
| `connect(target, 'prop')` | `target.prop` is set to the latest value, by reference, after each commit (data has this form today: code data api/index.ts:362-374) |
| `connect(sendable)` | `sendable.send(text)`, one JSON text per commit. The text is made once per commit per lens and shared by every socket on that lens |
| `connect(otherResource.data, (out, entry) => …)` | a derived resource (3.7) |

**Why the function gets the target as an argument.** fero must hold the function strongly, or it would vanish. If the function closed over the target, the target could never be collected: data's `connect(anchor, fn)` today keeps a closed-over anchor alive for good, and keeps firing (brief 1.4, measured). So the function takes the target as its first argument and must not capture it. **fero cannot check this.** It is a rule for the app.

**When a link ends.** At the first of these:

| How | When exactly | For what |
|---|---|---|
| `link.close()` | at once | anything |
| its **scope** is disposed | at once | a component mount; a method handler; data's `render` makes one scope per mount (brief 1.8) |
| the target **says it closed** | at once | a socket or stream: fero listens for `close` once |
| the target is **collected** | some time after nothing can reach it | a DOM node other code removed; a plain object |

- **The collector is the backstop, not the clock.** A `FinalizationRegistry` callback runs some time after a collection, and is not promised to run at all (brief 1.4, from memory). fero v4 already uses one for handler views, and its record says what that costs: release only when a collection runs; "a dropped view keeps being worked out on every commit until a GC finds it; a long-lived one may wait for a major GC"; tests must force the collector (V4-54, DEC:2762-2773).
- **What the prototype showed** (**measured here**, `run/lens-proto.mjs`):

| Case | Result |
|---|---|
| one write with a strong sink attached | 2,228 ns |
| one write with one weak link attached (a `deref` per commit) | 2,122 ns: no cost that shows |
| 1,000 links whose targets were dropped, **before** any collection: one commit | 0.80 ms: every dead link still ran, about 0.8 µs each |
| the same, after forced collections | all 1,000 links ended |
| 1,000 more, no forced collection, the program **allocating** | all ended within 294 ms |
| 1,000 more, no forced collection, the program **idle** for 2 s | **0 of 1,000 ended** |

  - So the collector finds dead targets quickly in a busy program, and not at all in an idle one. An idle page with dead links keeps receiving their changes until something else makes garbage. One Node process, plain objects as targets; no browser and no DOM was tried.

- **A socket is never collected while it is open**: the runtime holds it. So for a socket the `close` event ends the link, not the collector. For a DOM node built by data's renderer, the mount's scope ends it. The collector matters only for a node that other code removed, and for plain objects.
- **So the owner's promise that nobody has to unsubscribe holds in this form:** you never leak for ever, and with a scope or a socket you are exact. Without them you pay for a dead link until a collection finds it.

**What a dead link costs until then.** The server keeps sending its selection's changes. This process keeps decoding and folding them. That is bounded by the selection's own write rate and by the link's byte credits (LAYERS 4.2). It is not free, and nothing in the line shows it.

**GC must never change what a program can see.** data's kernel has this rule: "GC timing can never change observable results" (code: data kernel/scope.ts:1-3). A weak link keeps it only with one more rule:
- A weak link's function may touch only its target. Then nobody can see whether a dead target's link still runs.
- **A partition held only by weak links is not readable through `rows` or `peek`.** Otherwise `peek()` would work until some collection and then throw `not-held`. A sync read needs a strong hold: `here()`, `hold: 'all'`, or a server role.

**Sharing.** Links and `here()`s on the same selection in one process share one SUB and one fold, counted (API 3.10 states this for follows; reasoned there and here). 1,000 sockets in one room are one subscription, one decode per change, and one JSON text per commit.

**A field lens does not narrow the wire.** `chat.data.room1.m7.text.connect(…)` subscribes to the partition `room1`. This process receives every change to the room and drops what is not under `m7.text`. v5's SUB selects partitions, not rows or fields (brief 4.9). The lens *looks* minimal; the wire unit is the partition. Routing by row on the server is possible in the first build, where deltas are made after the fold and the key is known (a `Map` lookup); it is not possible once deltas are sent from the log's bytes off the main thread, where reading a key costs a 0.5 to 3.0 µs decode against 1 to 4 ns for the slot in the header (PATHS 4.5; PA-3). This page keeps the partition as the unit.

- **Runs:** the fold and the sink run here. **Wire:** section 2's table.
- **Cost.** Open: one trip and the selection's bytes once. Per change: one shared encode on the server, 0.01 to 0.46 µs per record per reader (PATHS 0); one decode and fold here; then the sink. A weak link adds one `deref` per commit to a strong sink (the table above). data's path subscription today checks every row delta of every commit against its key (brief 1.2); the rewrite must index sinks by row key (section 8).
- **Touches:** V5-1 (a link is a subscription from a position; a reconnect resumes from its cursor). V4-7 (a target sees commits only). E-31's 26 rules are unchanged: the wire protocol is the same SUB.
- **Rules: +7, −2.** New: (1) hold the target weakly and the function strongly, and pass the target in; (2) end at the first of close, scope, the target's own close, collection; (3) check `deref` at each delivery, so a dead target ends the link at the next commit even if no finalizer ran; (4) count links per selection, and send END at zero; (5) wait a short linger before that END, so a re-mount does not resubscribe; (6) `rows` and `peek` need a strong hold; (7) the shared JSON text per commit for sendables. Gone: `follow` as a separate verb with its own `Follow` type; `LiveCall.open()` and `close()`.

### 3.6 Operators and the boundary

```ts
// rows NOT held here (hold: 'asked'):
fan.data.za('points', 10).connect(board, 'rows')                       // za runs on a server; 10 rows and their changes cross
fan.data.za('points', 10).here().map((s) => s.player).connect(board, 'rows')   // za on a server, map here
fan.data.room1.here().filter((m) => m.text.includes('fero')).connect(el, show) // the room crosses; filter runs here
fan.data.filter((s) => s.points > 9).connect(board, 'rows')            // refused 'not-held' when it runs: a function cannot travel

// rows held here (a server, or hold: 'all'): everything runs here, nothing new crosses
scores.data.za('points', 10).tap((c) => render(c.value))
```

**The rule.** Operators **left of `here()`** are part of the question. They run where the rows live. Operators **right of `here()`** run in this process, on what crossed. A `connect`, a `tap` or an `await` with no `here()` before it puts the boundary at itself.

**Which spelling for the boundary?** Three were open: `connect` itself, a marker, or the operator's own kind.

| Spelling | For | Against |
|---|---|---|
| `connect` is the boundary; no operators after it | nothing new to learn | local operators over a remote selection have no spelling |
| **a marker: `here()`** (this page's pick) | the line shows where each operator runs; `here()` alone is the old `follow` | one more word |
| the operator's kind decides: plain-data operators go to the server, functions stay | no marker | changing `gt('n', 5)` to `filter(fn)` silently turns "10 rows cross" into "the whole selection crosses". A hidden cost |

**Only plain-data operators can sit left of the boundary when the rows are not here.** A function cannot travel to a server (API 3.2 says the same of a partition function). data marks each operator as `declarative` or not (code: data ops/registry.ts:14):
- **Can travel:** `gt`, `lt`, `gte`, `lte`, `between`, `az`, `za`, `top`, `limit`, `sum`, `avg`, `length`, `max`, `min`, the quantiles, the set operators, `pick`, `prefix`.
- **Cannot:** `filter`, `map`, `group`, `reduce`, `tap`, `to`, `some`, `every`, `distinct`. Left of the boundary on rows not held, they are refused `not-held`, and the hint says: "put `.here()` before `filter`, or make it a method".
- **A function on a server is a method.** `methods: { mine: (user, ctx) => ctx.data.filter((o) => o.user === user) }`, then `client.data.mine('ada').connect(…)`. The server's author wrote that code, so it can run there (V4-5's spirit).

**This is the server-side transformation space the owner found missing.** API.md has it only behind a method (`methods.top(10).open()`, API 3.10). Here a client can ask for any plain-data view directly. That is more expressive, and it opens a cost door:
- **Each distinct shape is a view kept on a copy.** A view costs fold work on every change: the bar is 1 µs per affected view, `group` misses it at 2,574 µs a record at 1,000,000 rows, and 100 filters cost 9 to 18 µs a record (E-05). Making a view over a whole resource walks every row once.
- **Views of the same plain-data shape are shared** (DESIGN-V5 4.5). 10,000 screens asking for `za('points', 10)` are one view and one encode per change.
- **A client could ask for 10,000 different shapes.** So the server needs a budget, and the resource needs a switch:
  - **inside one partition**, stateless row operators (`gt`, `lt`, `between`, `pick`) are free to ask: the work is bounded by the partition the SUB already reads;
  - **over the whole resource**, or with state (`za`, `top`, `sum`), a client's view counts against `views.max` per client (a config key; a guess: 16), and the resource may say `views: 'methods'` to allow served views only through methods, which is API.md's rule today.
- **E-31 did not model the `view` selector** (brief 4.13). This page makes that selector a main read path. That is a debt before it is built.

**The same line can cost differently.** `x.data.za('points', 10).connect(t)` runs on a server when this process does not hold the rows, and here when it does. API.md's line `f.data.za(…)` always runs here, and throws `not-held` when it cannot. The lens form is more convenient and less plain. `here()` written out removes the doubt.

- **Runs:** as the rule says. **Wire:** a `view` SUB: the chain as plain data, then the view's output once, then its own changes. One encode per view change, shared by its subscribers (PATHS 4.5).
- **Cost.** On the server: the view's fold per change (E-05). On the wire: only the view's output. Here: a fold of that output, then the local operators.
- **Touches:** V4-5 (reads stay open, API 3.8; the switch above lets an owner close this door too). V5-1 (a view SUB still reads from a position; a served view's cursor is the fold's position under it: reasoned, not modelled).
- **Rules: +5.** (1) Left of the boundary on rows not held, only plain-data operators; else `not-held` with the hint. (2) Share by plain-data shape, counted. (3) A per-client view budget. (4) The `views` switch. (5) A view SUB's snapshot and deltas obey E-31's rules for a selector E-31 did not model.

### 3.7 `changes`, and a resource as the target (derive)

```ts
for await (const e of events.data.changes({ from: saved ?? 'earliest' })) handle(e)   // every record, in order
events.data['order:981'].changes({ from: ack.version })                                // one partition, from a version

// a derived resource: the source's log, connected to another resource's lens
const orders = await fero<Record<string, Order>>('orders', { hold: 'asked' })   // a client of the source
const totals = await fero<Record<string, number>>('totals', { server: true })   // the owner of the target
orders.data.changes().connect(totals.data, (out, e) => {
  if (e.value) out[e.value.user].set(op.incr(e.value.cents))                    // returns nothing; carries the mark
})
```

- **`changes` is a verb on a lens.** The lens is the selection: the root, a partition, or a row. `of:` goes.
- **The owner's question 7: why is `derive` a separate function?** It need not be. The owner's pattern is right: a client of the source, a server of the target, and a pipe between them. fero v2's README did it in one line: `stream1.on('change').reduce(…).map(d => counts.update('stream1', d))` (code: v2 README.md:251-271).
- **But the plain pattern counts twice or skips.** That v2 line keeps no position and does no dedup (brief 3.2). After a restart it either starts from "now" and misses records, or starts from a saved cursor and applies some twice. Three things make it exact, and none can be left to the app without a trap:
  1. **The mark.** Each output's own log entry carries the source position it came from (29 B). A restart resumes from the marks, and no source record counts twice. It must be per output slot, or a slot move loses an output (E-30).
  2. **No await per output.** A loop that awaits each output runs at about 250 source records a second (PA-19).
  3. **One runner.** Run on three servers, the work must be done once.
- **So `derive()` goes, and its mechanism rides `connect`.** When the target of a `connect` is another resource's root lens, fero knows three things: the target can store marks; `out`'s writes should return nothing; and the link's life is the target's. `out` is the target's lens with write verbs only.
- **The plain pattern stays legal**, and its promise is said plainly:
  ```ts
  orders.data.changes({ from: 'latest' }).connect(totals, (totals, e) => {
    if (e.value) totals.data[e.value.user].set(op.incr(e.value.cents))      // a plain write on a captured handle: no mark
  })
  ```
  That is at most once from `'latest'`, and at least once from a saved cursor. Writes through `out` are exactly once.
- **Consumer groups** are the same connect with a name: `orders.data.changes({ as: 'invoicing' }).connect(invoices.data, fn)`. The members that share the name split the source's shares (API 3.11). `consumer()` goes as a function; a plain `for await` over `changes({ as })` is the at-least-once form.
- **Runs:** `fn` runs in the deriving process. **Wire:** a `log`-mode SUB from the marks; the outputs as ASKs, batched per turn, each with its mark.
- **Cost.** Per source record: one delivery, one run of `fn`, a share of one commit, 29 B (PATHS 4.9; E-30).
- **Exactly once holds only while the source keeps its log back to the marks** (`history`, default 0, or the tier). Past that the link stops with `expired` (LAYERS 8.8). Unchanged.
- **Touches:** V5-2 point 4 (a derived resource is a client of its source and records how far it read): this is that sentence as code. V5-1.
- **Rules: 0.** The 5 mark rules (E-30) and the 6 consumer-group rules (LAYERS 6.3) stand. Two exported names go.

### 3.8 `tap`, and what a sink gets

```ts
low.tap((c) => {                    // one call per commit
  c.first                           // true on the first call: `changes` is then the picture so far
  c.value                           // the latest value at this lens: by reference, frozen, no copy
  for (const ch of c.changes)       // the commit's changes under this lens: by reference
    console.log(ch.type, ch.key, ch.value, ch.prev)
})
```

**The owner's question 6: what does `tap`'s argument hold: the changes, nothing, or also the latest copy?**

- **Today, in data:** it depends on how the function is *written*. data reads the function's source text to see whether it has a parameter (code: data ops/misc.ts:598-611).
  - No parameter: called once per commit with nothing. Cost: about 0.
  - A parameter: called once per row change with a v2-shaped record, copied with `structuredClone`. Cost: about 1.7 µs per change (brief 1.2, measured).
  - It never gets the latest copy, except that the first record carries the whole current value (brief 1.5).
  - API.md says two things: its declarations give data's `tap`; its text says "the first call carries the picture so far" (brief 4.3).
- **Proposed: one argument per commit, the commit itself, with both, lazily.**
  - `c.changes`: the changes, by reference. Made only when read. Each has `prev`, the value before: data's commit already carries it by reference (code: data contract/delta.ts:37, 44), so it is free here.
  - `c.value`: the latest value at this lens, by reference, frozen. For a row or a field that is one lookup. For a view it is the view's current picture; listing it walks it, and the loop is in your code.
  - A sink that reads neither pays nothing.
- **Why per commit, not per change.** One call per commit lets a DOM sink batch its patches. A commit holds at most one change per row (data's SCHEDULE clause 8).
- **Why no copy.** Rows are immutable values: a write copies the objects on its path and never changes a row in place (brief 1.9). So a reference is safe. data's own by-reference sink costs 0.017 µs per extra sink per commit (brief 1.2).
- **`tap` against `connect`.** `tap(fn)` is the strong form: it lives until `close()` or its scope ends. `connect(target, fn)` is the weak form: it also dies with its target. Both get the same commit.
- **Runs:** here. **Wire:** nothing.
- **Touches:** V4-7 (a sink is called only for commits).
- **Rules: −1, +1.** Gone: choosing the mode from the function's source text. New: `changes` and `value` are lazy and by reference.

### 3.9 `asOf`: stepping back in time

```ts
const before = shop.data.widgets.asOf(ack.version).step(-1)   // the row just before that write
console.log(await before)
const then = shop.data.asOf(cursor)                           // the whole resource at a saved cursor: read-only
then.widgets.stock.peek()
```

The owner's question 4 has four parts. Section 4.4 answers them in order. The construct:

- **`lens.asOf(position)`** gives a read-only lens on the past. A position is a version, a cursor or a writer time. `step(n)` moves it by n records.
- **How.** Each process may keep an **undo ring**: for the last N records it folded, the key and the value before. The value before is a reference to the old row, which the fold already has in hand, so the ring costs one small entry per record and keeps the old rows alive. A past lens is the live store plus an **overlay** of the undone entries between now and its position. A read checks the overlay, then the store.
- **Cost** (E-06): undoing costs 0.03 to 0.05 ms per rerun **at every size**, with no snapshot. Moving k records costs k entries. A far jump costs the records between.
- **Past the ring** `asOf` throws `expired`, and the hint names the two ways that reach any position: `fero.fork(name, { at })` (API 6) and a reader that folds `changes({ from })` itself.
- **The ring is off by default** (`undo: 0`), like `history`.
- **Runs:** here. **Wire:** nothing.
- **Touches:** V5-1 (the log stays the truth; the ring is a local cache of inverses, never shipped). V5-4 (a writer time is a legal position within one group; across groups the viewer's merge rule applies).
- **Rules: +3.** (1) The ring takes each folded record's key and prior value, per held partition. (2) A past lens is the store plus an overlay; it is read-only. (3) Past the ring: `expired`.

### 3.10 `depth`: a resource may be two keys deep

```ts
await fero('users', { server: true })                       // depth 1 (default): users.data.u42 is a row and its own partition
await fero('chat', { server: true, depth: 2 })              // chat.data.room1.m7 is a row; room1 is its partition

chat.data[room][fero.id()].set({ text, at: fero.now() })    // a message: a row write. No key string to build
chat.data.room1.connect(ws)                                 // a room: a partition
chat.data.room1.gt('stars', 0)                              // a view over one room's rows
chat.data.room1.set(op.merge({ m8, m9 }))                   // two rows of one partition: one entry, all or none
```

- **The partition is always the first key.** That is fero v2's rule (code: v2 partitions.js:20-22). What `depth` says is where the **row** sits: at the first key (1) or the second (2).
- **It replaces `partition: { before: '/' }`.** Section 4.1 gives the full answer to the owner's question 1.
- **Runs:** routing reads the first key. **Wire:** a record's key is `[partition, row, ...fields]` for depth 2. The slot in the batch header is the hash of the first key.
- **Cost.** A write: no string concat here, no split at the router. The store is a map of maps, so a room's rows are found by one lookup, and its first picture walks only that room. `{ before }` needs a separate index from partition to rows on every copy, kept on every fold (PA-17); the nested store **is** that index. A read pays one more `Map` lookup: 32 to 660 ns (brief 1.1).
- **Touches:** **V5-2** says the partition is "the row by default, a prefix, or a function". Depth 2 is the prefix, spelled as a key level. The function form stays for the cases a level cannot say (API 3.2's `byTenant`). The wording of V5-2 would change; its substance would not.
- **Rules: about 0.** +3: the first key routes; the store nests one level; a set on a partition lens is a batch. −3: the prefix parse; the partition-to-rows index kept per fold; `follow({ prefix })`'s walk of partition names for the room case.

---

## 4. The owner's seven points

### 4.1 Nesting against `{ before }`

**The question.** Why not nest `[prefix][suffix]`, with the row as the default partition? That is: let each top-level key be a partition, as v2 did, and put a message at `chat.data.room1.m7`.

**Short answer.** Yes to the shape. No to making the message a *field*. Make the second level a **row**, drop `{ before }`, and keep one level as the default.

**Why not a field.** With today's rule (a resource is one level of rows), `chat.data.room1.m7` is a field of the row `room1`. A message then loses what a row has:

| A row has | A message as a field of a room row |
|---|---|
| a cheap write | **a write copies the room.** A write copies every object on its path (code: data kernel/node.ts:275-291). With 1,000 messages in the room a write costs 0.43 ms; with 10,000, 3.6 ms; a row per message costs 0.9 to 2.0 µs (brief 1.9, measured). Every copy and every following client pays it |
| its own conditions | `if: { absent }`, `{ version }`, `{ equals }` are checked on the row, so on the whole room. "Create this message only if it is absent" cannot be said. A field write to a room that does not exist is refused `absent-row` (API 3.5) |
| early answer stages | none: a field write is judged (API 3.5) |
| its own expiry | `rows: { ttl, max, where, while: 'session' }` act per row (API 6). A message cannot expire alone, and cannot die with its writer's session |
| a size of its own | a row may be at most 64 MB (brief 4.8). A room of 100,000 messages of 1 KB is 100 MB: refused |
| a cheap freeze on read | the first read of a row after a write freezes it (API 3.9). The room is a new object after every message, so every message makes the next read walk the room's fields again |
| `e.value` | set only when a record wrote a whole row (API 3.10). A message write is a field write: `e.value` is unset, so P-06, P-16 and P-17 as written would skip every message |
| views | data's operators work only at the root of a view; `h.k.filter(…)` on a child throws (code: data api/index.ts:543-548). No "starred messages of room1" |
| holding part of it | the room is one row. A reader gets all of it or none |

**So: make the second level a row.** `depth: 2`. Then `chat.data.room1.m7` has everything in the left column, and `room1` is the partition, with one order and all-or-none sets inside it. The code in 3.10.

**Should it be the default?** No. Most resources are one level: users, sessions, counters, a cache. With depth 2 as the default, `users.data.u42` would be a partition holding rows, and a user's fields would need a second key. Depth 1 keeps the ten-line demo true.

**What `depth: 2` cannot say, and `{ before }` could.** A partition named by a key's *end* or *middle*. API 3.2's own example is `'report-7.acme'` → `'acme'`, and it already uses the function form. So the function form stays; `{ before }` goes.

**The other way, which this page does not pick:** rewrite data so that *every* object is a persistent map (a tree of small nodes), and a field write costs O(log n) at any depth. Then a message as a field would write fast. But conditions, expiry, sizes, stages and `e.value` would all still be per row; each would need a "per path" form, and each is new rules at the leader. Putting the row one level down gets all of them for no new rule.

**Decisions touched:** V5-2's wording. **Rules:** about 0 (3.10).

### 4.2 Exactly once

**Short answer.** Yes, for writes to fero, in three layers. It is the same promise Kafka makes ("inside the system"), built more simply. Neither covers a side effect outside, like an email.

```ts
await views.data['page:/'].set(op.incr(1))                         // 1. a retry never counts twice: nothing to write
await orders.data[id].set(order, { once: 'import-7:row-3' })       // 2. safe to send again from another process, for a day
await client.data.widgets.reprice(12, { once: 'order-981' })       //    the same, for a method call
orders.data.changes().connect(totals.data, (out, e) => {           // 3. read, compute, write: each source record counts once
  if (e.value) out[e.value.user].set(op.incr(e.value.cents))
})
```

| | fero v5 | Kafka (from memory; brief 6.4) |
|---|---|---|
| **A retried write** | **Client sessions**, always on. Each process has a session; each write carries the session and a number; the leader keeps a floor and the answers it gave, and a resend gets the first answer. Holds across leader changes and slot moves, for the session's life. 13 rules, model-checked (E-20). 309 B per active client | **The idempotent producer.** A producer id, an epoch and a sequence per partition; the broker rejects a repeat. Holds within one producer session; the last 5 batches per producer |
| **A restart of the sender** | The new process has a new session. Use a **`once` name**: a name the app picks; a resend under it within a day gets the first answer. About 221 B per name for its day (API 3.4) | A new producer id, so no dedup, unless a `transactional.id` is set |
| **A call that must run once** | `{ once }` on a method call: a claim row in `#calls`, three commits, re-run elsewhere with the same write ids if its server dies (API 3.8) | no such thing; an app builds it |
| **Read, compute, write** | **Marks.** Each output's log entry carries the source position it came from. No transaction is needed. 5 rules, model-checked; real Elle agrees on 2,800 histories (E-30) | **Transactions.** Writes to many partitions and the consumer's offsets commit together, through a coordinator and commit markers |
| **Several partitions, all or none** | `batch`: one partition only. Across partitions, a **saga**: all applied or all undone, but readers may see half (E-24). Not in 5.0: isolation across partitions | Transactions do this, and `read_committed` readers never see half |
| **How long it holds** | sessions: the session's life. `once`: 1 day. Marks: while the source keeps its log back to the marks; past that the deriver stops with `expired`, it never skips (LAYERS 8.8) | producer state expires (1 day by default); a transaction's offsets live with the group |
| **Outside effects** (an email, a payment) | **not covered.** A queue job is at least once; a handler with `{ retry: true }` may run twice | **not covered** |

- **Where fero is weaker than Kafka:** no atomic write across partitions that readers cannot see half of. That is API.md's open Q-A10.
- **Where fero is simpler:** E-20 tried Kafka's producer-id scheme here. It needed 16 rules against 13, and as first written it could stall a partition (E-20). E-30 found that no dedup scheme with a time horizon keeps derived outputs exact across a long restart; the mark does (E-30).
- **The lens changes nothing here** except the spelling. **Rules: 0.**

### 4.3 `fero<typeof shop>`: does the client pull the server in?

**Short answer.** With `import type`, no: it is erased. With a plain `import`, **yes, and it starts a server.** A safer shape exists: export the **type**, not the handle.

**What was checked.**
- `import type { shop } from './server.ts'` and `fero<typeof shop>('shop')` compile against API.md's own declarations, with and without `verbatimModuleSyntax` (**measured here**, `types/client-type.ts`, `tsconfig.vms.json`).
- Under Node's type stripping, `import type` does not run the server module. A plain `import { shop }`, used only as a type, **does** run it (brief 4.12, measured).
- A bundler (esbuild) leaves the server out for both forms by default, and **bundles the server's code** for the plain form under `verbatimModuleSyntax` (brief 4.12, measured).

**The trap.** The server file has a top-level `await fero('shop', { data, methods })` (API 3.8). Any value import of that file runs that line. By the role rule ("a process that brings something serves", API 3.1), the importing process becomes one more server of `shop`: it copies the whole log, keeps a disk and may be elected leader. One missing word, `type`, does that, and nothing fails.

**A safer shape: export the type only.**

```ts
// ── server.ts
const shop = await fero('shop', { data: { widgets: { stock: 10, price: 10 } }, methods: { … } })
export type Shop = typeof shop                 // a type. The handle itself is not exported

// ── client.ts
import type { Shop } from './server.ts'
const client = await fero.as<Shop>('shop')
```

Now there is nothing a plain import could use, and every wrong form is loud or harmless (**measured here**, `run/typeexp/`):

| The client writes | Node, type stripping | `tsc` with `verbatimModuleSyntax` | `tsc` or a bundler without it |
|---|---|---|---|
| `import type { Shop }` | the server file does not run | compiles | erased |
| `import { Shop }` (the mistake) | **fails at link time**: "does not provide an export named 'Shop'". The server file **never runs** | **error TS1484**: "must be imported using a type-only import" | erased |

**Two more guards.**
- **A process can pin itself a client:** `FERO_SERVER=off` (a config key). Then any open in that process that brings a seed, methods or `server: true` is refused `no-server-here`. A browser is refused that way already (API P-19).
- **For a big app, keep the types in a file with no code**: `shop.types.ts` exports `Item` and the methods' signatures; the server file and the client both import it. Then no client file ever names the server file.

**The lens helps a little.** A typed client gets typed paths and typed path calls from the one type: `client.data.widgets.sell()` checks the row name's type, the method's name and its argument (**measured here**, `types/patterns.ts`, P-14).

**Rules: +1** (the client pin).

### 4.4 Changes, reversing them, and persistent data

**Does fero hold the current state, and fold each new change record into it?** Yes. Each copy and each client keeps the current rows in memory, and `data` folds each committed record into them (V5-1; API 1).

**Can old change records be applied in reverse to step back in time?** Not from the records alone. **No record carries the value before.** fero's record is `{ type, key, value }` in v2, in v4 and in v5's log (brief 5.3). To undo "stock = 4" you must know it was 5.
- The value before **is** known at the moment of the fold: data's commit carries `prev` by reference (code: data contract/delta.ts:37, 44). data then drops it: "the engine itself only moves forward" (code: data contract/index.ts:90-93).
- So stepping back needs one of: an undo ring kept beside the fold (3.9); a snapshot plus a replay forward (V5-1's way, for forks and restores); or a store whose old versions stay whole (below).
- Writing `prev` into the log would double the bytes of every update on every disk and wire, to serve a few readers. This page does not propose it.

**What needs this?** (brief 5.1)

| Who | What it needs | How often |
|---|---|---|
| the timeline viewer (V5-4) and the debugger | step one record forward or back, on one process's rows | interactive |
| tapes (TEST-07) | re-run a recorded input on the state just before it, in 10 ms or less | per test |
| a fork (TEST-06) | a second resource at a past cursor, for a record, not a copy | rare |
| a restore | every row at a past position | very rare |
| an app's own undo | the value before my write | per user action |
| a slow reader that wants a picture that stands still | a consistent view while writes go on | per read |

Nothing in the 22 patterns reads "a row as of last Tuesday" in a hot path.

**The owner recalled two known ways to build immutable data, one O(log n) and one O(1).** Yes (brief 5.4, from memory):

| Way | Update | Read | Old versions | Fits |
|---|---|---|---|---|
| **Path copying** (a tree of small nodes; Clojure's and Immutable.js's maps) | O(log n), base 32: about 4 levels at 1,000,000 | O(log n) | **all stay whole and readable at once** | pictures that stand still, forks in memory, any version at any time |
| **A version tree of diffs** ("rerooting": the current version is a plain mutable table; an old version is a chain of inverses) | **O(1)**, at native speed | O(1) for the current version | reaching one costs the **distance** to it | stepping back and forward near "now" |
| **Fat nodes** (each field keeps a list of stamped values) | O(1) amortized | O(log versions) | all readable | linked structures; not a hash table of rows |

- **data today is half of the first.** Rows are immutable and copied along the written path; the table is a mutable `Map`; `snapshot()` is O(rows) (brief 1.11).
- **E-06's undo log is the second**, and it measured well: 0.03 to 0.05 ms a rerun at every size. A runnable fork cost 2.6 s at 1,000,000 rows, and a persistent map beside data made keeping a snapshot free but not handing it back to data (0.65 to 0.82 s), because data adopts a plain object (E-06).

**Should fero use one?** This page's answer, before E-54's numbers:
1. **Use the O(1) way now: the undo ring** (3.9). It serves the viewer, tapes and app undo, which are all "near now". It costs nothing when off, one small entry per record when on, and it leaves the hot path a plain `Map`.
2. **Use path copying inside wide values, whatever E-54 says.** A write into an object with 1,000 fields copies 1,000 slots today (0.43 ms, brief 1.9). A tree of small nodes makes that O(log n). It only matters for wide rows, and `depth: 2` removes the main reason to have them.
3. **Make the row table persistent only if E-54 shows it is nearly free.** It would buy an O(1) `snapshot()` (0.5 s at 1,000,000 rows today, PA-8), free in-memory forks and exact pictures for slow readers.

**The number that would change this answer.** E-54 runs in parallel; this page did not wait for it. Adopt a persistent row table if, at 1,000,000 rows, **both** hold: its fold is within 1.25× of today's (0.57 to 0.69 µs a record in data's lane, brief 1.11), and a keyed read is within 2× of a `Map` read (0.66 µs spread, brief 1.1). If the fold is 2× or worse, stay with the `Map` and the ring. Between the two, it is the owner's call, and the gain to weigh is `snapshot()`'s 0.5 s.

**Fast, efficient and safe.** Safe is the part the ring gets by construction: a past lens is read-only, it never touches the live rows, and rows are immutable values, so a reader of the past cannot change the present.

### 4.5 The connect lens, end to end

The construct is 3.5 and 3.6. The owner's points, one by one:

- **A proxy builds a lens, such as `resource.a.b.c.connect()`, that sends the current state and then the changes to whatever it is connected to.** Yes: 3.5. Snapshot-then-deltas is already data's rule locally (SCHEDULE clause 7) and E-31's across the network.
- **It is the most efficient way, over the whole path from server to client.** Mostly. A `connect` on rows not held opens one SUB for the lens's **partition**, shared by every link on it. It is at PATHS' lower bound per partition: one trip, the bytes once, one shared encode per change. **It is not minimal below the partition**: a lens on one field still receives its whole row's (or room's) changes (3.5).
- **Weak references tie a link's lifetime to its object.** Yes, as a backstop. Exact ends come from `close()`, a scope or a socket's `close` (3.5). data dropped this idiom on purpose (code: data compat/v2-records.ts:145-147; brief 1.4), and fero v4 brought a form of it back for handler views and wrote down what it costs (V4-54). Both lessons are in 3.5's rules.
- **A process always gets the least it needs, and nobody has to unsubscribe.** True for memory and for never leaking for ever. Not true for bytes until a collection runs.
- **A function call at any step lives in a different space from keys, so the two never collide.** Yes: 1.1. Checked in a prototype and in the types.
- **`r.a.b.c.method()` asks for the call to run on the one leader for that path.** Yes, and it replaces `near`: 3.4.
- **Operators before and after connect: transformations on the server, and transformations here.** Yes, with `here()` as the boundary and one limit: only plain-data operators can run on a server; a function runs here or inside a method: 3.6.
- **Server-side transformations looked missing and needed exploring.** 3.6 opens it: any plain-data view, shared by shape, under a budget.
- **Does this settle `shop.data.set` against `shop.set`?** Yes: the lens form, one spelling: 3.3.
- **`follow` is no longer needed.** Right. `here()` is `follow`; `get` no longer holds: 3.2, 3.5.
- **It needs much more work to show that this works well.** Section 9 lists what must be measured. The two largest unknowns are how late a collection can be in a real browser, and the unmodelled `view` selector.

### 4.6 `tap`'s argument

3.8. One argument per commit: `{ first, value, changes }`, lazy and by reference. Today data gives a cloned record per change or nothing, chosen by reading the function's source text.

### 4.7 `derive` as plain clients and servers

3.7. The owner's pattern is the right shape. `derive()` goes as a function. Its exactness (the mark, no await per output, one runner) rides a `connect` whose target is a resource. The hand-made pipe stays legal and is at most once or at least once.

---

## 5. The 22 patterns, in this shape

The key lines only. All of them type-check against the sketch declarations (**measured here**, `types/patterns.ts` against `types/lens.d.ts`, 187 lines). None ran. Guarantees, costs and evidence are API.md's (API 10) unless a line says otherwise.

```ts
// P-01 live shared state
shop.data.tap((c) => console.log(c.value))
const ack = await client.data.gadgets.set({ stock: 4 })
console.log(ack.version, client.rows.widgets?.stock)

// P-02 cache with expiry
await cache.data['user:42'].set({ name: 'Ada' })
await cache.data.hot.set({ n: 1 }, { ttl: '30s' })
await cache.data['user:42'].touch()

// P-03 near cache, client data sync
const u = await users.data.u42                              // a miss: one trip; nothing kept
const mine = users.data.pick(['u42', 'u43']).here()         // held and live
await mine.ready
const same = users.data.u42.peek()

// P-04 read-through cache
const prices = await fero('prices', { rows: { ttl: '5m' }, load: (sku) => db.price(sku) })
console.log(await prices.data['sku-1'])

// P-05 websocket fan-out by room: a room is a partition, a message a row
const chat = await fero<Rooms, {}, 2>('chat', { depth: 2, hold: '200MB' })
wss.on('connection', (ws, room) => {
  chat.data[room].connect(ws)                               // the room so far, then each change; ends with ws
  ws.on('message', (text) => { chat.data[room][fero.id()].set({ text, at: fero.now() }) })
})

// P-06 pub/sub
const sub = news.data.sports.changes()
await news.data.sports.set({ headline: 'late winner' })
for await (const e of sub) { console.log(e.value?.headline); break }

// P-07 streams and replay
const r = events.data.changes({ from: savedCursor ?? 'earliest', until: 'latest' })
for await (const e of r) { console.log(e.partition, e.version, e.value); save(r.cursor) }
events.data['order:981'].changes({ from: ack.version }).close()

// P-08 consumer groups
orders.data.changes({ as: 'invoicing' }).connect(invoices.data, (out, e) => out[e.partition].set({ order: e.value, at: e.time }))   // exactly once
for await (const e of orders.data.changes({ as: 'billing' })) await bill(e.value)                                                  // at least once

// P-09 work queue: unchanged
work.work(async (job) => { await resize(job.url) })

// P-10 locks
await lock('payroll', { lease: '10s', wait: '5s' }, async (l) => {
  await ledger.data['run-42'].set({ by: process.pid }, { if: { lock: l } })
})

// P-11 counters and rate limits
const a = await views.data['page:/'].set(op.incr(1))

// P-12 leaderboards, live aggregates
fan.data.za('points', 10).connect(board, 'rows')                               // za on a server; 10 rows cross
fan.data.za('points', 10).here().map((s) => s.player).connect(board, 'rows')   // map here

// P-13 presence
await online.data.ada.set({ since: fero.now() })

// P-14 invariants
methods: { sell: (_: void, ctx) => ctx.at.left.set(op.incr(-1, { min: 0 })) }
await client.data.widgets.sell()                            // at widgets' leader: one trip, one commit

// P-15 transactions across partitions
await saga([{ at: accounts.data.alice.cents, value: op.incr(-5000, { min: 0 }) },
            { at: accounts.data.bob.cents,   value: op.incr(5000) }], { once: 'tx-981' })

// P-16 event sourcing, CQRS
for await (const e of facts.data.changes({ from: 'earliest', until: 'latest' }))
  if (e.value) balance.set(e.value.account, (balance.get(e.value.account) ?? 0) + e.value.cents)

// P-17 derived resources
orders.data.changes().connect(totals.data, (out, e) => { if (e.value) out[e.value.user].set(op.incr(e.value.cents)) })

// P-18 tapes, forks, replays
const before = shop.data.k.asOf(ack.version).step(-1)       // new: the row just before that write
await fero.fork('shop', { as: 'shop-try' })                 // unchanged

// P-19 clients everywhere (a browser): a cart is a partition
const shop = await fero.as<Shop>('shop', { hosts: ['wss://shop.example.com'], token, hold: '20MB' })
shop.data.ada.connect(el, (node, c) => { node.textContent = String(Object.keys(c.value ?? {}).length) })

// P-20 change the shape of rows: unchanged (fero.alter, migrate)
// P-21 request and reply: unchanged (service), or a method on a path
// P-22 delayed jobs, waiting takes, priorities: unchanged (queue)
```

**What moved, pattern by pattern.**

| Pattern | Change | Wire against API.md |
|---|---|---|
| P-01, P-02, P-10, P-11, P-13 | `f.set(k, v)` → `f.data[k].set(v)` | the same |
| P-03 | `get` keeps nothing; `follow([…])` → `pick([…]).here()` | a miss sends one row and no stream; `here()` is the same SUB |
| P-05 | `{ before: '/' }` → `depth: 2`; `follow` + `tap` + `close` → `connect(ws)` | the same SUB. One JSON text per commit per room, not one per socket. No partition index to keep (PA-17) |
| P-06, P-07, P-16 | `changes({ of })` → `lens.changes()` | the same |
| P-08, P-17 | `consumer().run`, `derive()` → `changes().connect(target.data, fn)` | the same |
| P-12 | `methods.top(10).open()` → `data.za('points', 10).connect(…)` | the same `view` SUB; no method needed for a plain-data view |
| P-14 | `{ near: true, run }` → a call on the path | the same: one ASK to the row's leader |
| P-15 | `{ to, key }` → `{ at: lens }` | the same |
| P-18 | adds `asOf` | nothing |
| P-19 | `follow({ prefix: 'ada' })` → `shop.data.ada.connect(…)` with `depth: 2` | no walk of partition names for the first picture (API 3.2) |
| P-04, P-09, P-20, P-21, P-22 | none | the same |

---

## 6. Better and worse than API.md

### Better

1. **One address form, and it is a value.** API.md has three places (`rows`, `data`, `methods`), verbs on the resource, and "lens calls" that repeat them (API 2, 3.4). Here everything hangs off a path. A lens can be passed to a saga, a component or a library.
2. **Typed paths.** API.md's `f.data.*` is untyped (API 6). Here a wrong field name, a wrong value and an early stage on a judged write are compile errors (**measured here**).
3. **Placement is on the line.** `client.data.widgets.sell()` replaces `{ near: 'sku', run }`: no hint to declare, store and learn; the same one trip and one commit (PA-25).
4. **One flow verb.** `connect` and `here` replace `follow`, a method's `.open()`, `derive()`, `consumer().run()` and the shared-follow rule. Where each operator runs is on the line.
5. **Server-side views without a method**, for plain-data operators, shared by shape. API.md has them only behind `methods`.
6. **`get` does not leak.** It never holds. API.md needs `hold: false` and a warning (API 3.3).
7. **`depth: 2` beats `{ before }`.** No key strings, no index kept on every fold, a first picture that walks only the partition.
8. **A sink's argument is one thing**, lazy and by reference, with `prev`. No reading of function source text.
9. **A plain-data boundary is what a native engine needs.** If data's server side moves to Rust, an operator with a JavaScript function costs a callback per row: 107 ns inside a napi call, 3.8 µs from a Rust thread (E-03). The rule "only plain-data operators run on a server" means the server side never calls JavaScript for a client's view (**reasoned**).

### Worse

1. **Lifetimes tied to the collector are not exact.** A dead link costs bytes and folds until a collection finds it; that can be late; tests must force the collector (V4-54). The app must keep its function from capturing the target, and fero cannot check. Exactness still needs `close()`, a scope or a socket. So the promise that nobody thinks about unsubscribing is delivered only in part.
2. **A hot read through a lens is slower than `rows`** (the table in 3.1). So `rows` stays, and there are still two ways to read.
3. **Typed code cannot assign.** `f.data.k = row` does not compile on a typed lens. The owner likes assignment; API.md keeps it by leaving `f.data` untyped.
4. **Methods share the call space with verbs.** A method cannot be named like a verb, and a new verb could clash with an old method. API.md's `f.methods` cannot clash.
5. **Client-chosen server views are a cost door on the servers.** They need a budget and a switch, and they lean on the one selector E-31 did not model.
6. **The same line can run here or on a server**, by whether the rows are held. API.md's `f.data.za(…)` always runs here.
7. **The lens looks finer than the wire.** A lens on a field subscribes to its partition.
8. **Proxies everywhere.** Every lens is `typeof 'function'`; printing needs a custom inspector; `then` is reserved; a lens returned from an `async` function is awaited into its value, which is a trip nobody wrote.
9. **More rules, and more of them only reasoned.** Section 7.

---

## 7. The ledger: rules and names

**Rules** (SIMPLICITY's measure; every count reasoned, none modelled).

| Construct | + | − | Net |
|---|---|---|---|
| 3.1 the lens and the call space | 4 | 0 | +4 |
| 3.2 reads | 1 | 2 | −1 |
| 3.3 writes | 0 | 1 | −1 |
| 3.4 methods on a path | 2 | 2 | 0 |
| 3.5 `here` and `connect` | 7 | 2 | +5 |
| 3.6 operators and the boundary | 5 | 0 | +5 |
| 3.7 a resource as the target | 0 | 0 | 0 |
| 3.8 a sink's argument | 1 | 1 | 0 |
| 3.9 `asOf` | 3 | 0 | +3 |
| 3.10 `depth` | 3 | 3 | 0 |
| 4.3 the client pin | 1 | 0 | +1 |
| **all** | **27** | **11** | **+16** |

- **+16 on 416 is about +4 %.** Nearly all of it is in L4 and L3, and all of it is "reasoned". The base has 197 model-checked rules of 416 (LAYERS 0.2); this adds none.
- **Without `asOf` (−3) and with served views only through methods, as API.md has them** (−3: the budget, the switch, and the selector debt that API.md already carries), the net is **+10**.
- By V5-6 the design is judged by this number. **On rules alone, lens-first loses to API.md by 10 to 16.** It wins on names:

**Names an app must learn.**

| Goes (9) | Comes (8) |
|---|---|
| `f.set`, `f.get`, `f.remove`, `f.touch` as a second spelling | `here()` |
| `f.follow` and its `Selector` forms | `connect()` |
| `f.methods` as a namespace; `LiveCall.open()` | `peek()` |
| `near` | `asOf()` |
| `get`'s `hold: false` | `depth` |
| `derive()` | `at()` for an odd key |
| `consumer()` | `call()` for a method named like a verb |
| `partition: { before }` | `fero.as<Shop>()` |
| `changes`'s `of:` | |

**Decisions, at a glance.**

| Decision | Touched? |
|---|---|
| V4-5 `methods:` is the door | kept. The typed client lens of a resource with methods has no `set` and no `remove`. Calls move onto paths |
| V4-7 a write shows when it commits | kept. A link, a `tap`, `rows` and `peek` see commits only |
| V5-1 the log is the truth | kept. A link is a subscription from a position; the undo ring is a local cache |
| V5-2 a resource is its own cluster; the partition | the wording: "a prefix" becomes "the first key" (`depth: 2`). The function form stays |
| V5-4 one timeline | kept. A writer time is a legal `asOf` position |
| V5-5, V5-11 one commit point; stages | kept, and in the types: only a plain row `set` has stages |
| V5-6 judged by rules | **+10 to +16 rules**, all reasoned |
| V5-9 direct routing | used: a path call routes by its path's partition |
| V5-3, V5-7, V5-8, V5-10 | not touched |

---

## 8. What changes

### In API.md

- **Section 2 (the shape):** "three places, one job each" becomes "`data` is the address of everything; `rows` is the fast read". Rule of thumb 4 added.
- **3.2 Partitions:** `{ before }` goes; `depth: 2` comes; the function form stays.
- **3.3 `hold`:** `'all'` or `'asked'`; a size bounds what links brought. A `get` never holds.
- **3.4 to 3.7 Writes:** verbs move onto the lens. Stages, ops, conditions and `set(fn)` keep their meaning. Assignment: untyped handles only.
- **3.8 Methods:** called on a path; `near` goes; `ctx.at` comes; `f.methods` goes; `lens.call(name, arg)` is the escape.
- **3.9 Reads:** `rows`, `peek`, `get`.
- **3.10 Views and subscriptions:** rewritten around `here`, `connect`, `tap`, the boundary and the view budget.
- **3.11 Derived resources:** a `connect` whose target is a resource.
- **Section 6 (declarations):** `Lens`, `Verbs`, `Flow`, `Link`, `Commit`, `PathCalls`; `Kind` in the types so that stages stay honest. The sketch is `types/lens.d.ts`.
- **Section 7 (what the types cannot say):** the function must not capture its target; a field lens does not narrow the wire.
- **Section 9 (config):** `depth`, `undo`, `views`, `views.max`, the client pin.
- **Section 10:** the 22 patterns as in section 5.
- **Section 11:** questions 2, 3, 9 and 13 are answered by the model. New ones: the view budget; whether `await lens` should read; the linger.
- **Typing a client:** `export type Shop = typeof shop`, and `fero.as<Shop>(name)`.

### In LAYERS.md

- **L3 (flow):** the SUB protocol is unchanged. Added: the `view` selector as a first-class path, with its rules owed to a model; the subscriber index may be by row inside a partition in the first build. State kept: a link count per selection on the client.
- **L4 (the surface):** it gains a rule record of its own for the first time: the lens, links, the boundary (about 16 rules).
- **L2:** the fold may write an undo ring. A record's key is `[partition, row, ...fields]` under `depth: 2`.
- **L5:** `derive` and the consumer's `run` become "a link whose target is a resource". The marks and the share leases are unchanged.
- **Section 7 (the wire):** no new verb. An ASK for a call carries a path. A SUB may carry an operator chain as plain data.

### In data

The owner says data may be rewritten, must stay an independent library, and may move to Rust. The lens model is data's own old idea, so most of this belongs in data, and works there with no network: `$(state).a.b.connect(el)`.

1. **The handle becomes the lens.** Callable, verbs in the call space, operators allowed on any collection node, not only at the root (today: code data api/index.ts:543-548).
2. **No child cache**, or a weak one (today: 318 to 990 B per key read, kept for ever, brief 1.1).
3. **Sinks indexed by row key.** A path subscription today subscribes the root and checks every row delta of every commit (brief 1.2).
4. **Weak links, in data's API layer.** The kernel keeps its rule: scopes are the lifecycle; a weak link is a scope-owned sink whose `dispose` a registry may call. `connect(anchor, fn)` stops ignoring its anchor (today: code data api/index.ts:357-361).
5. **One sink argument:** the commit, lazy, by reference. `tapHasParam` goes.
6. **Nested collections**, for `depth: 2`: a map of maps, each inner entry a row with its own freeze and its own delta.
7. **An undo ring** fed from `prev`, and a read-only overlay.
8. **The lazy freeze** that DATA-07 needs (it is API.md's text, not code yet: brief 1.10).
9. **Wide values as trees of small nodes**, so a write into a wide object is O(log n) (4.4).
10. **Rust.** LAYERS reads that L0 and L1 move to Rust and data stays JavaScript (LAYERS 0.2). The boundary rule gives a cleaner cut: the **server side** of a view takes only plain-data operators, so it can be a native engine with no JavaScript callback; the **client side**, where functions live, stays JavaScript. Crossing a batch costs under 1 ns a record (E-03).

---

## 9. Risks, and what must be measured

### Risks

1. **The collector is late in real browsers.** A DOM node that lived a while is freed only by a full collection; an idle page may not run one soon (from memory). Until then the link costs bytes and folds. If "late" is minutes, weak links are only a leak guard, and the model's main promise shrinks to "use a scope".
2. **Apps capture the target.** `connect(el, () => { el.textContent = … })` looks right and never ends. fero cannot see it.
3. **Server views become a cost attack**, or just an accident: 10,000 screens with 10,000 slightly different `gt` values.
4. **The `view` selector is unmodelled** (E-31), and its cursor rule is only reasoned here.
5. **The call space ages badly.** Every verb fero adds is a name some method may already use.
6. **Two keys deep is not enough for someone.** Then `depth: 3`, and the rules about what a partition lens means grow.
7. **Proxy cost creeps into hot paths** when people write `shop.data[k].a.b.peek()` in loops instead of `rows`.
8. **The owner loses typed assignment**, and the ladder's first examples change their look.

### What must be measured before this is chosen

| Question | Measure | It works if |
|---|---|---|
| How late is a collection for a removed DOM node? | Chrome, Firefox, Safari: 1,000 connected nodes removed, page idle and page busy; time until the finalizers ran | p99 under about 10 s when busy, and bounded when idle |
| What does a lens step cost in a real write and read path? | the prototype's table (3.1) on v5's first build slice | a write through `data[k].f.set(v)` adds under 5 % to the issuer's cost |
| Does a weak link slow a busy fold? | 10,000 links on one store; ns per commit against strong sinks | within 1.1× |
| Server views: cost per shape and under churn | E-05's harness with 1 to 10,000 shapes, opened and closed at 100 a second, at 1e5 and 1e6 rows | a budget of 16 per client keeps a copy's fold within its 1 µs bar |
| Is the `view` selector correct across a leader change, a reload and a move? | E-31's model with a view selector | every property holds, as for partitions |
| `depth: 2` against `{ before }` | fold and first-picture cost with a nested store, at 1e6 rows in 1e4 rooms | fold within 1.1× of flat; a room's first picture at or under 0.47 to 0.74 ms (PATHS 4.5) |
| The undo ring | E-06's rerun with the ring inside data's fold | fold within 1.05× with the ring on; a step under 1 µs |
| A persistent row table | **E-54** | the thresholds in 4.4 |
| Do the 22 patterns still pass? | E-22's prototype respelled in this shape, 100 seeds each | as E-22 |
| Is it easier to guess? | the tour's ten lines and five patterns, shown cold to readers in both shapes | fewer wrong guesses about where a line runs |

---

## 10. What was run for this page

Folder: `./lensfirst/`. Node v22.22.0, TypeScript 6.0.2. Nothing was committed and no file outside that folder and this page was written.

| File | What it shows | Result |
|---|---|---|
| `types/lens.d.ts` (187 lines) | the surface as declarations, on top of API.md's own `fero.d.ts` | compiles |
| `types/patterns.ts` (157 lines) | the 22 patterns' key lines | compiles; its 5 `@ts-expect-error` lines each fail for their stated reason when stripped |
| `types/collide.ts` | a field named `set` and the verb `set` on one lens; typed assignment | the first compiles; typed assignment does not |
| `types/server.ts`, `types/client-type.ts` | `import type` and `fero<typeof shop>` on API.md's declarations, with and without `verbatimModuleSyntax` | compiles both ways; 1 expected error bites |
| `run/typeexp/` | a type-only export, imported the wrong way | Node: fails at link time, the server file does not run. `tsc` with `verbatimModuleSyntax`: TS1484 |
| `run/lens-proto.mjs`, `run/lens-proto.jsonl` | a callable-`Proxy` lens over data, and `connect` with a `WeakRef` and a `FinalizationRegistry` | the tables in 3.1 and 3.5 |

**Raw line, as printed** (the first run, under the study's `timing` lock; 10,000 rows; `ns` is per operation, median of 5 rounds of 200,000):

```
{"bench":"lens-proto","node":"v22.22.0","rows":10000,"ns":{"map.get(k).n":76,"L[k].n.peek()":496,"kept lens .peek()":173,"data handle s.get(k).get(n)[value]":328,"write: data handle":1889,"write: L[k].n.set(v)":3685,"write + strong sink":2228,"write + weak connect":2122},"fired":1000000,"weak":{"made":1000,"endedAfterGc":1000,"msOneCommitWith1000DeadTargets":0.799},"weakNoForcedGc":{"made":1000,"ended":1001,"ms":294},"weakIdle2s":{"made":1000,"ended":0},"sinkGuard":true}
```

- `weakNoForcedGc.ended` reads 1,001 because one link from the forced-collection batch ended late and was counted here.
- The script on disk is the fixed one (integer values in every write loop, and two more write rows). The line above came from the version before that fix; only its `write: L[k].n.set(v)` number is affected.
- The type checks: `cd types && tsc -p tsconfig.c.json` (exit 0); with the `@ts-expect-error` lines stripped (`types/strip/`), `tsc` reports errors on exactly those 7 lines.
- Not run: any browser; any DOM; any network; the 22 patterns themselves.
