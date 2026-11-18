# The space of server-side work: where a computation runs, and how fero's API names the line

Written 2026-11-18. One of three independent API proposals answering the owner's feedback on [API.md](../../../API.md) and [API-TOUR.md](../../../API-TOUR.md). This one's angle: **map every place a computation can run, then pick the fewest words that name the line between a server's work and this process's work.** Nothing here is built. No file but this one was changed.

## 0. The answer in short

1. **A computation can run in seven places** (section 2). fero v5's API names four of them with four unrelated words (`data` operators, `follow`, a method that returns a view plus `.open()`, `derive`). The owner's lens can name all seven with **one grammar and one line**.
2. **The grammar.** `shop.data.a.b.c` is a place. Nothing runs when you write it. Four things make it run: `await` it (read once), `.here()` (keep the answer in this process, live), `.connect(target, fn)` (the same, with the target's lifetime), and a write (`.set`, `.remove`, or a method call).
3. **The line is `here()`.** What stands before it is plain data and may run on a server. What stands after it is code and runs in this process. `connect` is `here()` plus a callback. If this process already holds what the left side reads, `here()` costs no trip, like `get` on a held row.
4. **Only three kinds of thing may stand before the line:** a path, declarative operators inside one partition, or a method that returns a view. Code cannot travel (brief fact 12), and a whole-resource view is server work a client must not be able to order up freely. So the door (V4-5) also guards server compute.
5. **`follow`, `hold`, `near`, `.open()` and `get(k, { hold: false })` go.** Each is a special case of the grammar. A client holds exactly what its live `here()`s and `connect`s name. Seven public names go (section 4.4); five come in (`here`, `connect`, `keys`, `from`, `asOf`).
6. **Lifetimes are counted, with the collector as a backstop, not as the mechanism.** A `connect` holds its target weakly and hands it to the callback. It ends by `close()`, by its scope, or when the target is collected. Measured here by a sibling bench: a dropped target's finalizer ran after 1.3 s to 16 s, and never within 30 s for an old target in a quiet heap. So a server-side view also ends by count plus a short linger, and a leak costs work, never a wrong answer.
7. **Nesting replaces `{ before: '/' }`.** `fero('chat', { keys: 2 })`: the first key is the partition, the second is the row. `chat.data.room1.m7` is then a row, with its own version, TTL, size and `e.value`. The default stays one key (a row is its own partition). Making a message a *field* of a room row costs 0.43 ms a write at 1,000 messages and 3.6 ms at 10,000 (measured, brief 1.9), so nesting under today's default is not enough.
8. **Exactly once:** fero gives three tools with three horizons (sessions, `once` names, source marks). It has no Kafka-style transaction and does not need one for derive (E-30).
9. **`fero<typeof shop>` with `import type` pulls nothing in** (checked: it compiles and emits no import). A plain import runs the server file. The safer shape: the server file exports the **type** (`export type Shop = typeof shop`); then the wrong import is a compile error, and under Node it fails to link before the server file runs (measured here).
10. **Time travel is a reader's job**, not the live path's (E-54's answer as it stands today). Interface: `shop.data.asOf(position)`, a read-only lens folded in the asking process.
11. **`tap` gets one argument: the commit's changes, by reference, with `now` on it.** Nothing is copied, so it costs what a bare tap costs today (about 0, against 1.7 µs for today's cloned record).
12. **`derive` becomes a pattern.** The one primitive is a source mark on any write: `totals.data[k].set(v, { from: e })`. `derive()` stays as about fifteen lines of library code over it.
13. **Rules:** about +6 (4 to 10) on the base's 416, almost all for the served-view selector that E-31 never modelled. The names an app must learn fall.
14. **The invariant that makes it testable:** for declarative operators, moving `here()` left or right in a chain changes the cost and never the settled answer, because the same `data` operators run on both sides.
15. **The biggest unknowns:** the view selector's rules under failover, server memory per served view, and whether a callable lens (a name is a key until you call it) is fast enough.

## 1. How to read this

**Marks.** Every claim carries one: **measured here** (run for this page, section 9), **measured (sibling)** (run in this study by another designer's bench, path given), **E-nn** (an experiment's README), **code** `repo:file:line`, **docs** (a page and section), **brief** (the facts brief `./brief.md` and its section), **reasoned**, **from memory**, **web** (a URL).

**About the web marks.** The study box could not open most documentation hosts (`zero.rocicorp.dev`, `docs.convex.dev`, `electric-sql.com`, `docs.meteor.com`, `firebase.google.com`, `www.usenix.org` all failed to resolve: they are outside the box's allowed network). The search tool did work. So a **web** mark here means: the search tool's summary of that URL said this; I did not read the page itself. Where a fact is only my own recollection it says **from memory**.

**Machine.** 4 shared vCPUs, 15 GB. **Node v22.22.0**; Node 26 was not used. TypeScript 6.0.2.

**Words.**
- **lens**: a JavaScript `Proxy` that turns `shop.data.a.b` into a path. A path is an address, not a value.
- **view**: a live answer of an operator (`gt`, `top`, `sum`), kept up to date as rows change. **IVM** (incremental view maintenance): keeping a view up to date with work that grows with the change, not with the data.
- **declarative operator**: one whose arguments are plain data, with no function in them: `gt('stock', 5)`, `top(10, 'score')`, `sum('cents')`. `filter(fn)` and `map(fn)` are not (code: data:ops/registry.ts:14).
- **partition**: the rows one leader keeps in one order. **row**: the unit a write replaces, versions, expires and freezes.
- **SUB**: v5's one subscribe message: a selector, a mode and a cursor (docs: LAYERS 4.1).
- **mark**: a source position stored beside an output, in the output's own log entry (E-30).
- **trip**: one message there and its answer back. **commit**: on disk at most copies (V5-5).

## 2. The map: seven places a computation can run

| # | Place | The answer lives | Who pays, per change | What crosses the wire | v5 API today | This proposal |
|---|---|---|---|---|---|---|
| 1 | **A local view** on rows this process holds | here, while the process runs | this process: about 1 µs per affected view (bar; E-05) | nothing new | `f.data.gt(…)` | the same; also anything after `here()` |
| 2 | **A pushed-down selection**: the server sends only some partitions | here, as rows | the server: a route lookup, 1-4 ns with the slot in the header; no encode (docs: PATHS 4.5) | those partitions once, then their records, bytes shared by all readers | `f.follow(of)` | a path, then `here()` |
| 3 | **A pushed-down projection or filter**: the server sends part of a partition | here, as rows | the server: a decode and one encode per change **per distinct shape** (2.1-2.7 µs a row; PATHS 4.5), shared by that shape's readers | the view's own changes | none (brief fact 10) | a deeper path or declarative operators **inside one partition**, then `here()` |
| 4 | **A served view**: a server runs code over every row | on a server, while someone reads it | the server: the view's IVM, plus one encode per change per view | the view's own changes | a method that returns a view, `.open()` | a method that returns a view, then `here()` |
| 5 | **A method**: your code on a server, once | nowhere: an answer | the server: one run; one commit per write | the argument and the result | `f.methods.x(arg)` | the same; called on a path, the path picks the leader |
| 6 | **A derived resource**: an answer with its own log and copies | in its own resource, for good | the deriver: one run of `fn` and a share of one commit per source record (docs: PATHS 4.9) | the source's records to the deriver | `derive(source, target, fn)` | a `changes` loop that writes with `{ from: e }`; `derive` is a library |
| 7 | **IVM across the network**: a server keeps part of a chain, this process keeps the rest | split | both, each for its own part | only the server part's output | by hand: `.open()`, then local operators | operators before `here()` and after it, in one chain |

What the table shows (reasoned):
- **Places 2, 3, 4 and 7 are one idea at different prices**: some work before the wire, the rest after. Today they have three spellings and place 3 has none.
- **The price steps are real and must stay visible.** Place 2 is nearly free at the server (bytes can route). Place 3 needs a decode and an encode per shape. Place 4 needs a view over every row on a server. A design that hides which one a line is breaks the TOUR's rule 2.1 ("you can tell where a line runs").
- **Place 6 differs in kind**: its answer outlives every reader and is exactly once. It is not a point on the same line; it is a client plus a server (section 5.7).

## 3. Prior art: how others name the line, what they get right, what it costs

| System | How it names the line | What it gets right | What it costs | Mark |
|---|---|---|---|---|
| **Meteor** (publications, minimongo) | `Meteor.publish(name, fn)` runs on the server and returns a cursor; `Meteor.subscribe(name)` on the client; the client then runs the same query language on a local store | the same query language on both sides; a subscription made inside a reactive computation stops with it (from memory) | the server kept a copy of each client's subscribed data in memory; each process reads the whole database log, "fewer, larger servers"; sorted and limited queries fall back to poll-and-diff | web: https://forums.meteor.com/t/proposal-for-scaling-meteor-without-oplog-tailing/4017 , https://guide.meteor.com/performance-improvement ; the rest from memory |
| **Firebase Realtime Database** | a path is a reference: `ref('rooms/r1/messages').limitToLast(50).on(…)`. Operators on the reference run on the server | the path **is** the subscription: closest to the owner's lens | listening at a path downloads its whole subtree, so the docs tell you to keep data flat; `off()` by hand | from memory |
| **Firestore** | collection / document / subcollection: `collection('rooms').doc('r1').collection('messages').where(…).onSnapshot(fn)` returns an unsubscribe function | two-level nesting where **each level-two item is its own document**, not a field. A document is capped (1 MiB, from memory), which forces the split | no local operators; local writes show before the server takes them (the opposite of V4-7); a listener offline for over 30 minutes is billed as a new query | web: https://firebase.google.com/docs/firestore/pricing ; the rest from memory |
| **Convex** | a `query` function is server code; the client subscribes to its result. Mutations are the only write path | the server tracks what a query read (index ranges) and re-runs it when that changes; all subscriptions update at one logical time | a whole re-run of the function per change, not IVM; every read path is a named server function | web: https://docs.convex.dev/understanding/ , https://discord-questions.convex.dev/m/1181762550971515020 |
| **Replicache** | no line for reads: the client holds a key-value "client view"; `subscribe(fn)` re-runs a local function. Named mutators run on the client, then again on the server | mutators as the one door for writes | optimistic: pending mutations are replayed on new server state ("like a git rebase"); the app writes the server's pull itself | web: https://doc.replicache.dev/concepts/how-it-works |
| **Zero** (ZQL) | one declarative query, run on both sides. The server's IVM decides which rows to sync; the client's IVM answers at once from rows already synced | **no line to name, because the query is plain data and the same engine runs on both sides**; a query's lifetime is a `ttl` after its last reader, not garbage collection | a query engine and a replica on the server, one pipeline per query; only declarative queries | web: https://zero.rocicorp.dev/docs/synced-queries , https://zero.rocicorp.dev/docs/release-notes/0.17 (search summaries; some results were mirrors) |
| **ElectricSQL** shapes | a shape is plain data: one table, a `where`, a column list | pushed-down filter and projection as data; the same shape is shared by all its readers; equality filters are indexed | one table only, joins on the client; a shape cannot change; a `where` that is not an indexed equality is run per change | web: https://electric-sql.com/docs/guides/shapes |
| **Noria** | the app gives a schema and queries with parameters; the system compiles a dataflow | **partial state**: a missing answer is filled on demand by an "upquery" to the parents; cold state is evicted | where an upquery would scan a parent's whole state, partial state is switched off for that operator | web: https://www.usenix.org/conference/osdi18/presentation/gjengset , https://blog.acolyer.org/2018/10/29/noria-dynamic-partially-stateful-data-flow-for-high-performance-web-applications/ |
| **Materialize** (differential dataflow) | `SUBSCRIBE` to any view: a snapshot at a time, then rows with a `mz_diff` of +n or −n and a timestamp that never goes back | a view's changes have **positions** (timestamps, progress marks), so a reader can resume `AS OF` | memory for each view's arranged state; resuming needs history kept | web: https://materialize.com/docs/sql/subscribe/ |
| **RethinkDB** changefeeds | `.changes()` at the end of a query chain; **what stands before it runs on the server** | the owner's idea of operators before the boundary, shipped. `includeInitial` is snapshot-then-deltas; `squash` conflates for a slow reader | only chains the shards can keep are allowed: no changefeed after `concatMap`; `orderBy` needs an index and a `limit`; no `filter` after `orderBy.limit`. A feed cannot resume after a dropped link (from memory) | web: https://rethinkdb.com/docs/changefeeds |
| **Falcor** (JSON Graph) | paths: `model.get('a.b[0..9].name')`; `model.call(path, args)` calls a function **at a path** | paths are plain data, so they batch and dedup ("if there is already an outstanding request, no additional request is made"); calls live at paths | pull only, nothing is pushed; a route handler per path pattern on the server | web: https://netflix.github.io/falcor/documentation/model.html , https://netflix.github.io/falcor/starter/how-does-falcor-work.html |
| **GraphQL subscriptions** | a named field on the server; the selection set is a projection | projection as plain data in the request | no snapshot-then-deltas contract, no cursor; the server resolves per subscriber (no shared encode) | from memory |
| **Datomic** | the database is a value; `(d/as-of db t)`, `since`, `history` are filters on a read handle. Queries run in the reader's process over index segments it fetched | **a past state is a read handle, never a change to the live store**; the reader pays for its own queries | every reader caches index segments | web: https://docs.datomic.com/reference/filters.html |
| **MobX, Valtio** | none (one process). A proxy tracks reads; MobX's `reaction` returns a dispose function; Valtio's `subscribe` returns an unsubscribe | Valtio's `snapshot()` shares unchanged parts and returns the **same object** when nothing changed; MobX stops computing a value nobody observes (from memory): lifetime by **count of observers** | no network; disposal is by hand or by the framework | web: https://valtio.pmnd.rs/docs/how-tos/how-valtio-works |

**Six lessons** (reasoned from the table):
1. **What crosses the line must be plain data.** Every system that pushes work to a server sends data, not code: a shape (Electric), a query (Zero, RethinkDB), a path (Falcor, Firebase), or a name (Meteor, Convex, GraphQL). fero's own fact 12 says the same.
2. **A name or a shape.** Server code is reached by a name the server declared (Meteor, Convex): fero's methods. Server work without code is reached by a shape with a small grammar (Electric, RethinkDB): fero has `follow`'s selector, which stops at the partition.
3. **Restrict what may stand before the line** to what a server can keep cheaply (RethinkDB's list, Electric's single table, Noria switching partial state off). An open grammar is a way to make a server do unbounded work.
4. **The same engine on both sides** makes the line movable (Zero, Meteor). fero has this already: `data` runs on servers and in the browser (E-40: 27.9 KB gzip).
5. **Lifetimes: by count, by time, by scope. Nobody ships lifetimes by garbage collection across a network.** Zero uses a TTL; MobX counts observers; Meteor uses the reactive scope; the rest return a function to call.
6. **Two-level nesting works when the second level is a unit of its own** (Firestore's subcollections; a partition key plus a sort key in wide-column stores, from memory), and fails when it is a field of one big value (Firebase's "keep it flat").

## 4. The proposal: one lens, one line

### 4.1 The whole grammar

```ts
// file: lens.ts — one grammar for every place of section 2
import { fero, op } from 'fero'
type Msg = { text: string; stars: number; by: string }
const chat = await fero<Record<string, Record<string, Msg>>>('chat')   // founded with { keys: 2 }: room, then message

chat.data.room1                      // a place. Plain data. Nothing runs, nothing is sent
chat.data.room1.last(50)             // a place plus a declarative operator: still plain data

// four things make it run
const m = await chat.data.room1.m7                                   // 1. read once: one trip if not held; keeps nothing
const room = chat.data.room1.last(50).here()                         // 2. keep it here, live: one SUB if not held
const link = chat.data.room1.last(50).connect(ul, (ul, c) => draw(ul, c))   // 3. the same, for as long as `ul` lives
chat.data.room1.m9.set({ text: 'hi', stars: 0, by: 'me' })           // 4. a write: one trip, one commit
chat.data.room1.m9.stars.set(op.incr(1))
await chat.data.room1.m9.star()                                      //    a method, called on a path: its leader runs it

// after here(): code, in this process
const mine = room.filter((x) => x.by === 'me').map(render)           // data's operators on the mirror
room.rows.m7                                                         // a sync read of what is held: one lookup
```

**Five rules a builder learns.**
1. **A path is a place.** Writing it costs a `Proxy` step and sends nothing.
2. **`await` reads once. `here()` keeps it live. `connect(target, fn)` keeps it live for the target's life.**
3. **Before `here()`: plain data, and it may run on a server. After `here()`: your code, here.**
4. **If this process already holds what the left side reads, nothing is sent.** Otherwise one SUB.
5. **A name is a key until you call it.** `chat.data.room1.last` is the row `last`; `chat.data.room1.last(50)` is the operator. So row keys, operators and methods never collide (this is the owner's idea that a function call lives in a different space from a key).

**What the rules replace.**

| v5 API today | Here | Why it is the same thing |
|---|---|---|
| `chat.follow('room1')` | `chat.data.room1.here()` | a state-mode SUB of a partition |
| `chat.follow(['a', 'b'])`, `{ prefix }` | two `here()`s; a `{ prefix }` follow has no lens form and stays as `changes`' `of` for libraries | shared SUBs are counted either way |
| `await users.get('u7', { hold: false })` | `await users.data.u7` | a read that keeps nothing |
| `await users.get('u7')` (a miss follows) | `users.data.u7.here()` | a read that keeps |
| `shop.methods.low(5).open()` | `shop.methods.low(5).here()` | a served view |
| `hold: 'all'` | `shop.data.here()` at the root, one visible line | the whole resource, once, then every write |
| `hold: 'asked'` | the default: a client holds what its live `here()`s name | |
| `{ near: 'sku', run }` | `shop.data[sku].restock(n)` | the path is the hint |
| `shop.data.set(k, v)`, `shop.set(k, v)` | `shop.data[k].set(v)`; `shop.set(path, v)` stays (section 5.5) | one write |

### 4.2 What may stand before `here()`, and what the server then does

| Class | Example | The server's work per change | Shared by | Guard |
|---|---|---|---|---|
| **A. A partition** (one path step; two steps name a row under `keys: 2`) | `chat.data.room1.here()` | a route lookup; the committed bytes are the delta (PATHS 4.5, PA-3b: 1-4 ns, no encode) | every reader of the partition | `rules.read(who, partition)`, once per subscription (PA-34) |
| **B. Inside one partition**: a row, a field path, or declarative operators over the partition's rows | `chat.data.room1.last(50)`, `users.data.u1.name`, `chat.data.room1.gt('stars', 0)` | a decode, the view's IVM, and **one encode per change per distinct shape** | every reader of the same shape (data already dedups declarative operators by value: code data:api/index.ts:480-517) | the same `rules.read`; the work is bounded by the partition's size |
| **C. Over the whole resource** | `shop.methods.low(5)` | whatever the handler's view costs | readers of the same method and argument | **the door**: only a declared method (V4-5) |

- **A closure before `here()` does not compile**, and is refused at run time in untyped code (`unencodable`): code cannot travel (brief fact 12). Checked: `chat.data.room1.filter((m) => …)` is a type error in the sketch (measured here, section 9).
- **A whole-resource operator before `here()` on a process that does not hold the resource is refused `not-held`**, as today (API 3.9), and the hint names the two ways out: a method, or `shop.data.here()`.
- **Why class C needs a method.** A client-chosen view over every row is server work on every write: 100 distinct `filter` views cost 9-18 µs a record (E-05). `lt('stock', n)` for a thousand values of `n` is a thousand views. Inside one partition the same attack is bounded by that partition. So reads stay open (API 3.8), and unbounded server compute goes through the door (reasoned).
- **What crosses the wire.** One `SUB` whose selector is `{ path, ops }` (plain data, tens of bytes) or `{ method, arg }`; then `SNAP` (the answer once) and `DELTA`s (the answer's own changes). No new verb: DV5 4.4 already lists a `view` selector (brief 4.9); this fills in what it carries.
- **Which server.** Any full copy holds every row (V5-6), so any copy can serve classes B and C. Class A is served as E-31 models it.
- **Resume.** Class A resumes from its cursor (E-31). Classes B and C resume **by a new picture**, unless the same copy still holds the same view: a view's output has no position of its own that another copy could continue from, and across partitions there is no order at all (V5-2). v4 does the same on a feeder change (code: fero:api/methods.ts:13-17). The cost is the view's size, per failover (reasoned).

### 4.3 Lifetimes: counted, with a backstop

The owner's design ties a subscription to its target by a weak reference, so that no code has to end it. The facts against relying on it alone:
- data's kernel rule today: "GC timing can never change observable results" (code: data:kernel/scope.ts:1-3). `connect(anchor, fn)` ignores its anchor (code: data:api/index.ts:357-361).
- A callback that closes over its target keeps the target alive for good (brief 1.4, measured there).
- **Finalizers are late** (measured (sibling): `…/lens/cost-bench/fin-time.mjs`, Node v22.22.0, 1,000 dropped targets, no forced GC): the first callback came after 1.3 s when the program was allocating, after 8-16 s when idle, and **not within 30 s** for targets already in the old generation while only young objects were made. Registering one costs 0.20-0.30 µs.
- V4-54 already pays this in fero: "a dropped view keeps being worked out on every commit until a GC finds it" (docs: DECISIONS V4-54).
- Across a network the leak is dearer: a server keeps a view and sends frames for a reader that is gone.

**So: four ways a `connect` ends, in this order of trust.**
1. `link.close()`, or `using link = …` (it is `Disposable`).
2. **Its scope ends**: data's `Scope`, which `render()` already makes per mount and per row (code: data:render/index.ts:1002-1030). This is the common case for DOM work and it is exact.
3. **The count reaches zero.** Every `here()` and `connect` of the same shape in one process shares one SUB and one fold, counted (API 3.10 already says this for follows). At zero the SUB lingers (`linger`, default a few seconds, so a route change does not download the room again; Zero's TTL is the precedent), then `UNSUB`. The server's view of a shape lives by the same count.
4. **The backstop: the target was collected.** `connect` keeps a `WeakRef` to the target and registers it with a `FinalizationRegistry`. The callback is `fn(target, change)`, so it need not close over the target. Before each delivery the link checks `deref()`: a dead target ends the link at once, without waiting for the finalizer.

**Why this keeps data's rule.** The callback only ever runs with a live target. Once the target is gone there is nobody to call. So the collector's timing changes **how long work is wasted**, never what any live code sees (reasoned). A callback with side effects outside its target (a `console.log`) can see the difference; the docs say so.

**Cost.** One `WeakRef` and one registration per `connect` (0.2-0.3 µs, measured (sibling)); one `deref()` per delivery (tens of ns, from memory; owed). A leaked link wastes the callback's skipped delivery and, if it was the last of its shape, the SUB, for up to the times above.

### 4.4 Every construct: code, where it runs, the wire, the cost, the decisions, the rules

"Rules" is SIMPLICITY's measure (V5-6): the change in rules a builder of fero must get right. All rule counts here are **reasoned**; none is modelled.

| Construct | Code | Runs where | Over the network | Cost | Touches | Rules |
|---|---|---|---|---|---|---|
| a path | `shop.data.a.b` | here | nothing | per step: fero's lens adds 0.14-0.42 µs over data's 0.1 µs (measured, brief 1.1). **Not cached per key**: data's cache keeps 320-990 B per key for good (brief 1.1) | none | 0 |
| read once | `await shop.data.k` | here if held; else a copy | 1 trip; one row's bytes | held: a lookup. A miss: 1 trip (PATHS 4.4) | V4-7 (a read never guesses) | 0 (it is `get` with `hold: false`) |
| sync read | `x.rows.k` on a `here()` | here | nothing | a `Map` read: 43 ns to about 1 µs (PATHS 4.1) | V4-7 | 0 |
| keep a partition | `chat.data.room1.here()` | fold here | 1 SUB; the partition once; then its records, bytes shared | server: 0.01-0.46 µs a record a reader (PATHS 0); here: decode 3.2 + fold 0.2-1.9 µs a row (PATHS 4.5) | V5-1 (reads from a position) | 0 (E-31's 26) |
| keep part of a partition | `chat.data.room1.last(50).here()` | the view on a copy; a mirror here | 1 SUB with `{ path, ops }`; the answer once; the answer's changes | server: decode 0.5-3.0 µs + IVM + one encode per change **per shape** (2.1-2.7 µs a row); memory per view not measured | V5-1; V5-9 (encode once holds per shape, not per record) | **+4 (3 to 6)**: the picture and its deltas are cut at one commit; resume by a new picture; a shape's count and linger; admission (inside one partition, or a method) |
| a served view | `shop.methods.low(5).here()` | handler's view on a server | as above, selector `{ method, arg }` | as above; v4's per-subscriber frames cost 4.4-4.6 µs against 2.0-2.4 µs shared (PATHS 4.5) | V4-5 (the door guards compute) | 0 more (the same four) |
| local operators | `….here().filter(fn).map(fn)` | here | nothing | about 1 µs per affected view per change (bar); `group` 2,574 µs at 1e6 rows (E-05) | none | 0 |
| connect | `….connect(el, fn)` | here | as its left side | + 0.2-0.3 µs to make; a `deref()` per delivery | none | **+2**: never call a dead target; count, linger, then `UNSUB` |
| a path write | `shop.data.k.f.set(v)` | the partition's leader | 1 trip, 1 commit | 2 lens steps (about 0.5-1 µs) on v4's 7.7-8.3 µs issuer path (PATHS 2.6) | V4-5 (`methods-only` on a protected resource), V4-7, V5-5, V5-11 (same handle, same stages) | 0 |
| a method on a path | `shop.data.k.sell(2)` | the leader of `k`'s partition | 1 trip, 1 commit (PA-25) | the least a call can cost | V4-5, V5-9 (direct routing) | 0 (`near` was plain data; it goes) |
| the log of a path | `chat.data.room1.changes({ from })` | your loop | a log-mode SUB | as `changes` today | V5-1 | 0 |
| a marked write | `t.data[k].set(v, { from: e })` | the target's leader | 1 trip, a share of a commit, +29 B (E-30) | as a judged write | V5-2 point 4, V5-4, V5-11 ruling 6 (it can be skipped, so no early stage) | **0 to +1** (E-30's 5 exist; the option on any write must compose with `once` and `if`) |
| as-of | `shop.data.asOf(pos)` | here | a log-mode SUB from the nearest kept snapshot | build 0.4-1.1 µs a record, 54-220 B a version; a step under 0.2 µs (E-54) | V5-1 | 0 kernel; about 3 in a library |
| `keys: 2` | `fero('chat', { keys: 2 })` | every copy | the Rec's key gains one part | the store is a map of maps; no separate partition index (reasoned; owed) | V5-2 (the prefix form, spelled as nesting) | **0 (−1 to +1)**: replaces `{ before }` and PA-17's index upkeep |

**Sum:** about **+6 (4 to 10)** rules on 416. Public names: `follow`, `hold`, `near`, `.open()`, `{ hold: false }`, `{ before }` and `derive`'s `Out` go (7); `here`, `connect`, `keys`, `from`, `asOf` come (5).

### 4.5 The invariant: `here()` commutes with declarative operators

`chat.data.room1.gt('stars', 0).top(10, 'stars').here()` and `chat.data.room1.here().gt('stars', 0).top(10, 'stars')` settle to the same answer. The first sends ten rows and their changes; the second sends the room. The same `data` operator code runs on either side (lesson 4). So **the line is a cost choice, never a meaning choice**, and one conformance test can pin it: for every declarative operator chain and every position of `here()`, the settled answers are equal (reasoned; the test is owed, section 8).

It holds only once settled. A served view shows the serving copy's last applied commit; a local view shows this process's. Neither shows anything uncommitted (V4-7).

## 5. The owner's seven points

### 5.1 Nesting against `{ before }`: make the second level a row, by a declared `keys: 2`

**The question.** Why write `'room1/m7'` with `partition: { before: '/' }`, when `chat.data.room1.m7` with the default (each top-level key a partition, as fero v2 did: code v2:partitions.js:20-22) says the same?

**Is the default enough? No.** Under the default, `room1` is one **row**, and `m7` is a **field** of it. That is what a message loses:

| What | A message as a field of a room row | A message as a row | Mark |
|---|---|---|---|
| one write | copies the room's top level: **0.43 ms at 1,000 messages, 3.6 ms at 10,000**, on every copy and every following client | 0.9-2.0 µs | measured (brief 1.9, nest-cost.mjs) |
| size | the room is one row: at most 64 MB, and a `get` or a first picture sends all of it | each message at most 64 MB; a room of any size | docs: API:1209 |
| version | one version for the whole room, so `if: { version }` on one message conflicts with a write to any other | each message has its own | docs: API (a version is a row's place in its partition's order); reasoned |
| TTL, `max`, `while: 'session'` | act per row: they would expire the room, not a message | per message | docs: API:728 |
| the freeze on read | the first read after any message write walks the room's top level again | one message | reasoned from API:390 and data:api/index.ts:152-162 |
| `e.value` in `changes` | undefined: a field write has none, so a loop that counts messages must parse `e.rec` | the message | docs: API 3.10 |
| the first message of a new room | refused `absent-row`: the room row must be made first | a plain write | docs: API:1159 |
| early answer stages | none: a field write is judged | `received`, `replicated` | docs: API 3.5 |
| views over messages | none today: operators work only at the root of a source ("child handles are addresses, not views", code data:api/index.ts:543-548) | data's operators over the room's rows | code |
| holding part of a room | all or nothing: the room is one row | class B of section 4.2: `last(50)` | reasoned |
| a slow reader | conflation is per row, so it gets a diff of the whole room | per message | docs: DV5 4.4; reasoned |

**What `{ before: '/' }` costs instead** (docs: API 3.2; PA-17): a second index on every copy, from partition to rows, kept right on every fold; keys built and split as text by the app (`'room1/' + id`), which the types cannot check; a `{ prefix }` follow that walks partition names.

**The proposal: the second level is a row, when the resource says so.**

```ts
// file: keys.ts — the first key is the partition, the second is the row
const chat = await fero<Record<string, Record<string, Msg>>>('chat', { server: true, keys: 2 })
chat.data.room1.m7.set(msg)                  // one row write: about 1-2 µs of fold, its own version, its own ttl
chat.data.room1.m7.stars.set(op.incr(1))     // a field write inside the message
chat.rows.room1?.m7                          // one lookup in a map of maps
const room = chat.data.room1.here()          // the partition: every message of room1, kept live
await chat.batch([{ key: ['room1', 'm8'], value: a }, { key: ['room1', 'm9'], value: b }])   // all or none, one room
```

- **`keys: 1` stays the default**: a row is its own partition, a hash and nothing stored (docs: API 3.2). `users.data.u1` is a row, as today.
- **`keys: 2`**: the partition is the first key; the row is the pair. The store is a map of maps, so "the rows of a partition" is one lookup and the separate index of PA-17 is not needed (reasoned; owed a measurement: memory per row and fold cost against a flat map plus an index).
- **Everyone can route**: the partition is the first element of the record's key. No rule text to carry or compare, no string to split, no function.
- **`{ before }` is dropped.** It is the same mechanism spelled as a text convention. V5-2 says "a row key by default, a prefix, or the user's function": nesting **is** the prefix form. **The function form stays as V5-2 says**, built after it (API 11.1 q13 already puts it there).
- **Fixed at founding**, like the partition rule today (docs: API:177).
- **Why not make the second level a row always?** Then `users.data.u1.name` would be a row and `u1` only a partition: a user could not be read, expired, versioned or frozen as one thing. The unit must be said once per resource (reasoned).
- **Why not deeper?** Three levels can wait for a use (reasoned).

**Where it runs, wire, cost, decisions, rules.** Every copy; a Rec's key is `[partition, row, ...fields]`, one more short string per record on the wire and in the log (owed: bytes, against E-19's bar); V5-2 (spelling only); rules 0 (−1 to +1).

### 5.2 Exactly once: what fero gives, beside Kafka

**The plain answer.** fero makes its own writes happen exactly once in three ways, each with its own horizon. Like Kafka, it cannot make an outside effect (an email, a payment) happen once; only an idempotent receiver can.

| Need | fero | Horizon | Cost | Kafka's nearest | Mark |
|---|---|---|---|---|---|
| a write resent after a lost answer or a new leader | **client sessions**: every write carries its session and a number; the leader keeps a floor and the answers it gave | the session's life; a pause over `session.ms` (10 s) ends it and writes in flight answer `unknown` | 309 B a client; 13 rules, model-checked (E-20) | the **idempotent producer**: a producer id and a sequence number per partition; a restarted producer gets a new id and no dedup | brief 6.1, 6.4; web: https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging |
| "this order must be taken once, whoever sends it, even after a restart" | a **`once` name** the app picks | 1 day | about 221 B a name; a named call is 3 commits (API 3.8) | **nothing direct**: a `transactional.id` fences an old producer but does not dedup by an app's key | brief 6.1 |
| read from a source, write an output, count each source record once | a **source mark** beside the output, in the output's own log entry | for as long as the source keeps its log back to the mark (`history`, default 0: it must be set) | 29 B a mark; 5 rules, model-checked (E-30) | **transactions**: `sendOffsetsToTransaction` commits the consumer's offsets with the outputs, through a coordinator and commit markers | brief 6.3, 6.4 |
| several rows, all or none | `batch`, **within one partition**; a saga across partitions, where a reader can see half | — | 1 commit; a saga 6-7 (TOUR 3) | a transaction across partitions, hidden from `read_committed` readers until it commits | V5-1; brief 6.4 |

```ts
// file: once.ts — the three tools
await shop.data.widgets.stock.set(op.incr(-1, { min: 0 }))                 // sessions: a resend never counts twice
await shop.data.widgets.sell(1, { once: 'order-981' })                     // a name: at most once for a day, from any process
totals.data[e.value.user].set(op.incr(e.value.cents), { from: e })        // a mark: once per source record, for good
```

- **Where fero is weaker than Kafka:** no atomic write across partitions, and no reader isolation for a multi-partition output (V5-1 gave these up, knowingly).
- **Where it is stronger:** `once` names dedup across processes and restarts; the mark needs no coordinator and no two-phase commit (E-30 verdict); E-20 found Kafka's producer-id scheme needs 16 rules here against 13, and a new producer id per life "applies twice after a short restart" (E-30).
- **Say it plainly in API.md:** "exactly once" means **fero's writes**. A handler that sends an email can send it twice.

Runs where: the leader judges all three. Wire: the session and number (every write), the name, or the 29 B mark. Decisions: V5-5, V5-11 ruling 6 (a named or marked write can be refused or skipped, so it answers at commit only). Rules: 0; all three exist.

### 5.3 `fero<typeof shop>`: it pulls nothing in, if the import is a type import. Export the type to make the wrong import fail

**Checked here** (section 9; API.md's own declarations, TypeScript 6.0.2, Node v22.22.0):
- `import type { shop } from './server.ts'` with `fero<typeof shop>('shop')` **compiles**, and the emitted client has **one import, `'fero'`**. Under Node's type stripping the server file **does not run**.
- `import { shop } from './server.ts'`, used only in `typeof shop`, **runs the server file** under Node (the brief measured the same, and that esbuild bundles it under `verbatimModuleSyntax`). The server file has a top-level `await fero(…)` with `methods:`, so this client process would **become a server** (docs: API:114, the role rule). TypeScript gives no error: `shop` is a value, so a value import is legal.

**The safer shape: export the type, not the handle.**

```ts
// server.ts
const shop = await fero('shop', { data: { … }, methods: { … } })
export type Shop = typeof shop                       // a type: there is nothing to import at run time

// client.ts
import type { Shop } from './server.ts'
const client = await fero<Shop>('shop')
```

- The wrong line, `import { Shop } from './server.ts'`, is now **a compile error** under `verbatimModuleSyntax` (TS1484; checked here with an `@ts-expect-error`).
- And under Node it **fails to link before anything runs**: "The requested module './server.ts' does not provide an export named 'Shop'", and the server module's first line never printed (measured here).
- Cost: none. Rules: 0. Decisions: none.
- A second guard, for the owner's question 7 in the TOUR: if only `server: true` could make a server (not `methods:` or a seed alone), an accidental import could start nothing. That is a bigger change and not this page's call.

### 5.4 Time travel: a reader's job, with the lens as its interface

**What the owner assumed, and what is true.** fero keeps the current rows and merges each new record in: yes (V5-1: every copy folds the log). Reversing old records to step back: **the records cannot be reversed as they are**; no record in v2, v4 or v5's log carries the prior value (brief 5.3). data's in-memory batch does (`prev`, by reference, code data:contract/delta.ts:44), so a reader can keep it as it folds.

**What needs it** (brief 5.1): the timeline viewer and the debugger (scrub to time T, step one record), a rerun of a recorded input "on the state just before it, ≤ 10 ms" (TEST-07), a fork at a cursor, a restore. **No app pattern on API.md's list reads a past row** today.

**The two approaches the owner remembers** are path copying in a persistent tree (O(log n), every version a root) and rerooting (O(1) at the version that holds the real table; any other version costs the distance to it) (E-54, from the literature; brief 5.4).

**E-54's answer as its README stands today** (it may still change; read 2026-11-18):
- None of them belongs on the live write path: a tree root per write adds 3.4-5.8 µs to a 0.76-1.4 µs fold and keeps 1.3-1.7 KB a version; the collector then takes 14-22 % of the time against 0.5 %.
- For a reader, a **fat node** per row (the list of versions at which the row changed) is the fit: +0.4-1.1 µs a record to build, 54-220 B a version, a step or a jump under 0.2 µs, a row at any version 1.5-3 µs, and a picture is just a version number.
- Reverse records are smallest (16-49 B a version) but a jump costs the distance.
- A record needs to carry nothing new: putting the prior value in the log would add 80 % to 150 % to its bytes.

**The interface this page proposes: Datomic's lesson, in the lens.** A past state is a read handle, never a change to the live rows.

```ts
// file: asof.ts — a read-only lens on the past, folded in this process
const past = await shop.data.asOf(cursor)       // or a time: the viewer's T (V5-4)
past.rows.widgets                               // the row as it was
past.step(-1); past.step(+1)                    // one record back, one forward
past.seek(otherCursor)                          // a jump
const low = past.lt('stock', 5)                 // data's operators work on it: they run here
past.close()
```

- **Runs where:** in the asking process. No server keeps versions; no copy pays for a reader it does not have.
- **Over the network:** one log-mode SUB, from the nearest kept snapshot at or before the position. The source must keep its log that far (`history`), or the answer is `expired`.
- **Cost:** E-54's fat-node numbers above, per record read. A jump far before the reader's window costs a snapshot load, which is O(rows) once (docs: LAYERS 8.7).
- **Decisions:** V5-1 ("replay, tapes and forks fold from a snapshot to a position"). Rules: 0 in the kernel.
- **What number would change this answer.** If a version root per write cost under about 0.3 µs and under 100 B a version at 1,000,000 rows (E-54 measured 3.4-5.8 µs and 1.3-1.7 KB), versions could live in data's store itself, and every copy could answer as-of reads with no reader-side fold. If the fat node's build cost rose above about three folds a record (over about 4 µs), reverse records plus snapshots would be the better reader.

### 5.5 The connect lens, end to end

Sections 4.1 to 4.5 are the answer. The owner's sub-points, one by one:

- **A proxy builds a lens, such as `resource.a.b.c.connect()`, that sends the current state and then the changes.** Yes: `connect` is `here()` plus a callback; every attach is snapshot-then-deltas already (data's SCHEDULE clause 7; E-31 across the network).
- **It is the most efficient way, over the whole path from server to client.** With one caution: the work a path needs at the server depends on its depth. A partition is routed by bytes (class A). Anything inside a partition costs a decode and an encode per shape (class B). Today's data would also check every path subscription on every commit: 1,000 path subscriptions on one source cost 23 µs a write against 2.2 µs with a keyed router, and 10,000 cost 356 µs against 2.5 µs (measured (sibling): `…/lens/cost-bench/path-fan.mjs`). So data needs a path router for this (section 6).
- **Weak references tie a link's lifetime to its object.** Kept as the backstop, behind count and scope (4.3). On its own it would leave server views running for seconds to minutes.
- **A process always gets the least it needs.** Yes, and so `hold` goes: a client holds the union of its live shapes. `shop.data.here()` is the visible line for "everything". This answers the TOUR's question 8 with `'asked'` as the only mode. It changes the tour's ten lines: `client.rows.widgets?.stock` becomes `(await client.data.widgets)?.stock`, or a `here()` first.
- **A function call lives in a different space from keys, so the two never collide.** Rule 5: a name is a key until it is called. This needs the lens to be callable at every step (a `Proxy` over a function). Its cost is not measured (section 8), and such a lens prints as a function unless it carries `util.inspect.custom`. The fallback if it is slow: methods and operators only after an explicit step, `shop.data.widgets.do.sell(2)`.
- **`r.a.b.c.method()` asks for the call to run at the leader for that path.** Yes: `shop.data.widgets.sell(2)` goes straight to the leader of `widgets`' partition, and the handler's writes to it are local: one trip and one commit (PA-25). `near` goes; the handler gets the path as `ctx.at`, a lens rooted there:
  ```ts
  methods: { sell: (n: number, ctx) => ctx.at.stock.set(op.incr(-n, { min: 0 })) }
  await shop.data.widgets.sell(2)            // at the row: its leader
  await shop.methods.report()                // at the root: any server
  ```
  It stays "for speed, never for safety" (API 3.8): the op makes the write safe.
- **Operators before and after connect: transformations on the server, and transformations here.** Section 4.2 and 4.5. The line is `here()`; `connect` at the end of a chain puts the line just before it.
- **Server-side transformations looked missing and needed exploring.** Section 2 is that map. What was missing is place 3 (part of a partition) and one spelling for places 2, 3, 4 and 7.
- **`shop.data.a.b.c.set()` against `shop.set`.** The path form becomes the main one: it composes (`.set`, `.here`, `.changes`, a method, all on one path), and it returns the same handle with the same stages. **Keep `shop.set(path, value)` as the array spelling of the same write**, for three uses: a computed path, the items of a `batch`, and a hot loop (no `Proxy` steps: each step costs 0.14-0.42 µs of fero's own, brief 1.1). Drop `shop.data.set(k, v)`, the third spelling. Assignment (`shop.data.k = v`) stays as "set without the answer" (TOUR 2.3).
- **`follow` is no longer needed.** Right. `follow` goes as a verb. Its `{ share }` selector, which only consumer libraries use, stays on `changes`.

Decisions touched: V4-5 (a path write on a protected resource is refused `methods-only`; the door also guards class C), V4-7 (a lens has no optimistic copy; a served view shows committed rows only), V5-1, V5-9. Rules: +6 (4.4).

### 5.6 What `tap`'s argument is: the commit's changes, by reference, with `now` on it

**Today** (brief 1.5): data looks at the callback's **source text** to pick a mode. No parameter: one call per commit, no argument, about 0 cost. A parameter: one call per row change with a **cloned** record, about 1.7 µs a change, and the first call carries a clone of the whole value. A tap never gets the latest copy. A minifier or a default parameter can flip the mode and the cost. That is a hidden cost and a rule nobody would guess.

**Proposed: one mode.**

```ts
view.tap((c) => {
  c.first        // true once: the picture so far
  c.rows         // this commit's changes: { type: 'add' | 'remove' | 'update', key, row, prev, path }
  c.now          // the latest value: the view itself, a lookup, not a copy
})
```

- **The change: yes, by reference.** It is data's own commit batch (code data:contract/delta.ts:78-86), which already carries `row` and `prev` "structurally shared". Rows are immutable (DATA-07), so handing them out is safe.
- **The latest copy: yes, and it is not a copy.** `c.now` is the view; reading a row from it is a lookup.
- **One call per commit**, not per row change.
- **Cost:** what a native sink costs today: about 0 per change, 0.017 µs per extra sink per commit (measured, brief 1.2), against 1.7 µs for today's cloned record. The opening picture is iterated lazily, not cloned.
- **`connect`'s callback gets the same `c`**, after its target. **`changes` gives something else on purpose**: a log record, which is what was asked for and has no `prev`; `c.rows` is what changed in the rows.
- Across the network the client folds the server's deltas into its mirror, and data makes the same batch there, with `prev` from the mirror (reasoned).
- Decisions: none. Rules: 0, and data loses its mode-by-source-text rule.

### 5.7 `derive` as a pattern of plain clients and servers

**The owner's question.** Why is `derive` a separate function, when an app can open the clients and the servers it needs and update the servers from the clients?

**The honest answer: you can, and v2's README did** (`stream1.on('change')…map(d => counts.update('stream1', d))`, code v2:README.md:251-271). **But as written it is not exactly once.** It keeps no position. After a restart it either starts from now (records lost) or from the start (records counted twice). The 29 B mark is the whole difference (E-30).

**So make the mark a thing any write can carry. Then derive is a pattern.**

```ts
// file: derived.ts — totals from orders, exactly once, with no derive()
const orders = await fero<Record<string, Order>>('orders')          // a client of the source
const totals = await fero<Record<string, number>>('totals', { server: true })   // a server of the target
for await (const e of orders.data.changes({ from: totals.marks('totals') }))
  if (e.value) totals.data[e.value.user].set(op.incr(e.value.cents), { from: e })   // not awaited: writes pipeline
```

**What the API must give for those four lines to be exactly once across any restart** (reasoned from E-30, LAYERS 8.8 and PATHS 4.9; not modelled in this form):
1. **An atomic mark on any write: `{ from: e }`.** The write and "I have applied source record `e`" land in one log entry of the target (E-30's `srchi-slot`: per reader, per source slot, per output slot).
2. **The leader skips a marked write at or below the stored mark**, and answers it as done, not as an error. So a replay after a restart is harmless.
3. **Order per writer per output slot.** A marked write must not land after a later one from the same reader. v5's issue order (`O.seq`: each writer numbers its writes; docs: V5-5) gives this, but its model across a slot move is owed (docs: LAYERS 3.6). If that model fails, the fallback is one more rule: a marked write also names the mark it expects to follow, and the leader refuses a gap.
4. **Marks move with their slot and ride snapshots** (E-30: kept per group instead, a slot move loses an output).
5. **Reading the marks back: `totals.marks(reader)`** returns a cursor, the furthest position below which every source record is known done. On a server of the target it is a local read.
6. **A mark with no output: `totals.mark(e)`.** A source record that writes nothing leaves no mark, so the cursor would never pass it. The loop sends a bare mark now and then; it bounds how much is replayed after a restart.
7. **The source keeps its log back to the marks** (`history`), or the reader stops with `expired` and never skips (docs: LAYERS 8.8). This is the app owner's setting, and the docs must say so beside the pattern.

**What it does not need:** a lock for safety. Two processes running the same loop under the same reader name both send; the leader applies each record once and skips the other's (by 2). A lock (`lock('totals', fn)`) only saves the wasted reads and sends (reasoned).

**Should `derive()` still exist? Yes, as a library of about fifteen lines** over those verbs (L5's own rule: "each built only from the verbs above", docs: API section 6). It earns its name three ways: it cannot be written the slow way (awaiting each output runs at about 250 source records a second, PA-19); it sends the bare marks; it takes the lock or splits the source's shares. The owner's point stands: **nothing in it is a primitive.**

- Runs where: the loop, in a process that is a client of the source and a server (or a client) of the target. Wire: a log-mode SUB to the source; one marked write per output.
- Cost: one delivery, one run of your code, a share of one commit per source record (PATHS 4.9); 29 B a mark.
- Decisions: V5-2 point 4 (kept to the letter: "a client of each source… its log records how far it has read"), V5-4 (the mark carries the source position the timeline needs), V5-11 ruling 6 (a marked write can be skipped, so it has no early stage).
- Rules: 0 to +1 (E-30's 5 exist; `from` on any write must compose with `once` and `if`).

## 6. What changes

**API.md**
- 3.2 Partitions: `{ before }` goes; `keys: 2` comes; the function form stays, later.
- 3.3 `hold` goes. A client holds what its live `here()`s name; `memory` stays as the bound. The tour's ten lines and the examples that read `rows` on a bare client change.
- 3.4 Writes: the path form first; `shop.set(path, v)` as the array spelling; `shop.data.set` goes; `{ from }` on a write.
- 3.8 Methods: called on a path; `ctx.at`; `near` goes. The typed client pattern becomes `export type Shop` and `import type { Shop }`.
- 3.9 Reads: `await path` (once), `get(…, { hold: false })` goes.
- 3.10 becomes "the lens": the grammar, the three classes, lifetimes, `tap`'s argument, the commuting invariant. `follow` and `.open()` go.
- 3.11 `derive` moves to the libraries, with the four-line pattern shown first.
- New: `asOf`. New refusal use: `not-held` for a whole-resource operator before `here()`; `unencodable` for a closure before `here()`.
- Section 6 declarations: `Lens`, `There`, `Here`, `Change`, `Link` (a sketch compiles: section 9). Section 4's cost card gains the three classes.
- The "exactly once" paragraph of 5.2, with "fero's writes only".

**LAYERS.md**
- L3 `subscribe`: the `view` selector's content (`{ path, ops }` or `{ method, arg }`) and its four rules (4.4). E-31 must be run again with it.
- L3 state: the subscriber index gains shapes, with a count and a linger.
- L2: the mark as an option on any write; `marks()` as a read; the bare mark.
- L4: the lens, links and counts; two rules.
- Section 7, the wire: no new verb. `SUB` carries the shape; a Rec's key carries the partition as its first part under `keys: 2`.
- 8.8: derive as a loop of public verbs; who runs it is then the app's choice (a lock, or shares), which closes API Q-B8.

**data** (the owner allows a rewrite; it must still stand alone)
- **Operators at any path**, not only at the root, so `chat.data.room1.last(50)` is a view over a partition's rows.
- **A path router**: subscriptions indexed by path, so a commit visits only the subscriptions on its changed paths (today each path subscription checks every row delta: 23 µs a write at 1,000 subscriptions, measured (sibling)).
- **A two-level store** for `keys: 2`: a map of maps, with a row at the second level.
- **Uncached, callable path steps**: no per-key cache that lives for ever (320-990 B a key today).
- **`tap` and `connect` hand out the commit batch by reference**; the mode-by-source-text goes; `connect` holds its anchor weakly and passes it to the callback.
- **Plain-data operator descriptions**: a declarative chain can be written down, sent, and built again on another process (the registry already knows which operators are declarative: code data:ops/registry.ts:14).
- **Rust.** None of this needs it. If the fold moves to Rust, the served part of a chain (declarative, no JavaScript callback) is exactly the part that can run there with no call back into JavaScript; closures after `here()` stay in JavaScript, where a call from Rust costs 107 ns to 3.8 µs each (E-03). So the line of this proposal is also a clean line for a native step (reasoned).
- As a library of its own, data gains a lens that works on one process with `here()` as a no-op: the same code, with or without a network.

## 7. Risks

1. **The served-view selector is unmodelled.** E-31 left it out. Failover, a slot move under a view, credits and a slow reader of a view are all reasoned here. The count of +4 rules could be +8.
2. **Server memory and CPU per shape.** Class B is bounded by a partition, but a busy room with many distinct shapes (`last(50)`, `last(51)`, …) still makes one view each. A cap per partition may be needed (one more rule and one more setting).
3. **Resume by a new picture** for classes B and C costs the view's size on every failover. For a large served view that is a burst of bytes at the worst time.
4. **Dropping `hold: 'all'` as the default breaks v4's first example** and about 20 example READMEs (TOUR question 8 calls this "the closest call"). It can be softened: keep `hold: 'all'` as sugar for `shop.data.here()`.
5. **The callable lens may be slow or odd.** Every step is a `Proxy` over a function; `typeof shop.data.x` is `'function'`. If the cost is more than about twice today's step, fall back to an explicit step for calls.
6. **Weak targets are subtle.** A callback that still closes over its target defeats the backstop, silently. The count and the scope carry the load; the docs must say the backstop is only that.
7. **`keys: 2` changes the record's key shape**, a wire-stability surface in both repos (docs: fero's project guide, "The two seams").
8. **`{ from }` on any write widens a model-checked mechanism.** E-30 checked marks as derive uses them, one writer in order. Any-order use by app code leans on issue order, whose model is owed.
9. **Two spellings of a write remain** (`path.set(v)` and `shop.set(path, v)`). That is one more than ideal, kept for cost.

## 8. What must be measured or modelled to know it works

| # | What | Decides | Changes the answer if |
|---|---|---|---|
| 1 | E-31 again with a view selector: failover, a slot move, a slow reader, resume by a new picture | the +4 rules | it needs more than about 8 rules, or a property breaks |
| 2 | Server cost of class B: `last(50)`, `gt`, `top` over one partition of 1e2 to 1e5 rows, 1 to 1,000 shapes; memory per view | whether in-partition pushdown is open by default | a view costs over the 1 µs bar per change, or over about 1 KB plus its answer |
| 3 | A callable, uncached lens step against today's (0.14-0.42 µs of fero's share) at 1e3, 1e5, 1e6 rows; memory per step | rule 5 | over about twice today's step |
| 4 | A path router in data: ns a write with 1 to 10,000 path subscriptions | the lens at depth | not flat (today: 2.0 to 356 µs) |
| 5 | `keys: 2`: memory per row and fold cost of a map of maps against a flat map plus PA-17's index; record bytes | dropping `{ before }` | worse than the index on both |
| 6 | `deref()` per delivery; a leak's real cost with 10,000 dropped targets on a browser and on Node | 4.3's backstop | a `deref()` costs over about 50 ns, or leaks last minutes under load |
| 7 | The commuting test: every declarative chain, every position of `here()`, equal settled answers, in the sim | the invariant of 4.5 | any chain differs |
| 8 | Marks from app code: E-30's model with pipelined writes, a refused write in the middle, two readers of one name, a slot move | derive as a pattern | a record is lost or doubled without the "expects to follow" rule |
| 9 | `tap` by reference against today's two modes on data's perf suite | 5.6 | not within noise of a bare tap |
| 10 | The first build's own number for a path write through the lens against `shop.set(path, v)` | whether the array spelling is still needed | under about 5 % apart |

## 9. What was run for this page

Folder: `./space-types/`. Node v22.22.0, TypeScript 6.0.2. Nothing was timed.

| File | What it shows | Result |
|---|---|---|
| `fero.d.ts` | API.md's section 6 declarations, cut from the page by `awk` | identical to the sibling bench's copy (`diff -q`) |
| `server.ts`, `client-type.ts` | `import type { shop }` and `fero<typeof shop>('shop')` | compiles; `out/client-type.js` imports only `'fero'` |
| `client-alias.ts` | `export type Shop`, `import type { Shop }`, `fero<Shop>('shop')` | compiles; emits only `'fero'` |
| `client-alias-plain.ts` | `import { Shop }` (not a type import) under `verbatimModuleSyntax` | a compile error, as its `@ts-expect-error` requires |
| `rt/a.ts` to `rt/d.ts` | the four imports under `node --experimental-strip-types` | `import type { shop }`: server not run. Plain `import { shop }` used as a type: **server ran**. `import type { Shop }`: not run. Plain `import { Shop }`: a link error, server not run |
| `space.d.ts`, `use.ts` | a sketch of `Lens`, `There`, `Here`, `Change`, `Link`, `{ from }`, `marks`; section 4.1's and 5.7's lines | compiles (`tsc` exit 0); a closure before `here()` is a type error |

**Not checked by the sketch:** a method called at depth (`shop.data.widgets.sell(2)`; the sketch types methods at the root only), `asOf`, `keys: 2` on `fero()`'s own options, and `ctx.at`. `use.ts` wraps the resource in a stand-in `lens()` function so that API.md's declarations stay untouched.

Sibling measurements cited (not run by this page): `…/lens/cost-bench/fin-time.jsonl`, `…/lens/cost-bench/path-fan.jsonl`, and the brief's section 9.

## 10. Sources

- fero: docs/DECISIONS.md V4-5, V4-7, V4-54, V5-1 to V5-11; docs/v5-space/API.md, API-TOUR.md, LAYERS.md (4, 7, 8.8), PATHS.md (4.4, 4.5, 4.9), SIMPLICITY.md; experiments E-05, E-06, E-20, E-30, E-31, E-40, E-54.
- The facts brief: `./brief.md`.
- Web (search summaries; see section 1): https://zero.rocicorp.dev/docs/synced-queries · https://zero.rocicorp.dev/docs/release-notes/0.17 · https://docs.convex.dev/understanding/ · https://discord-questions.convex.dev/m/1181762550971515020 · https://electric-sql.com/docs/guides/shapes · https://forums.meteor.com/t/proposal-for-scaling-meteor-without-oplog-tailing/4017 · https://guide.meteor.com/performance-improvement · https://firebase.google.com/docs/firestore/pricing · https://doc.replicache.dev/concepts/how-it-works · https://www.usenix.org/conference/osdi18/presentation/gjengset · https://blog.acolyer.org/2018/10/29/noria-dynamic-partially-stateful-data-flow-for-high-performance-web-applications/ · https://materialize.com/docs/sql/subscribe/ · https://rethinkdb.com/docs/changefeeds · https://netflix.github.io/falcor/documentation/model.html · https://netflix.github.io/falcor/starter/how-does-falcor-work.html · https://docs.datomic.com/reference/filters.html · https://valtio.pmnd.rs/docs/how-tos/how-valtio-works · https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging
- Hosts the study box's network must allow for the pages themselves to be read: zero.rocicorp.dev, docs.convex.dev, electric-sql.com, docs.meteor.com, firebase.google.com, www.usenix.org.
