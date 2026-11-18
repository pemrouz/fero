# The connect lens, cost first

Written 2026-11-17. One of three independent API proposals that answer the owner's feedback on [API.md](../../../API.md) and [API-TOUR.md](../../../API-TOUR.md). This one's angle: **cost first, and a skeptic of the lens.** It asks of every construct: what runs, where, what crosses the network, and which rule a builder must get right for it.

**Nothing here is built.** No repo file was changed. Two small benches and one type check were run for this page (section 11).

## How to read this

**Marks.** Every claim carries one.
- **measured here**: run for this page; the script is named in section 11.
- **brief n.n**: the facts brief, ./brief.md, and its own mark there (its benches were run on Node v22.22.0).
- **E-nn**: an experiment under docs/v5-space/experiments/.
- **code** `repo:file:line`; `data:` is the sibling data repo (`../data`), `fero:` is this repo.
- **docs**: API, TOUR, LAYERS, PATHS, SIMPLICITY, DEC (docs/DECISIONS.md), with a line or a section.
- **reasoned**: an argument from the sources; nothing ran it.
- **from memory**: an outside fact nobody checked here.

**Node.** Every run here used Node v22.22.0. Node 26 was not used.

**Words.**
- A **lens** is an address: a resource plus a path of keys, such as `chat.data.room1.m7`. The owner's idea is that one address serves to read, to write, to subscribe and to call.
- **connect** starts a stream: the state now, then each change.
- A **partition** is the unit of order: one leader puts its writes in one order (V5-2). A **slot** is a hash bucket of partitions; a server group leads some slots.
- A **SUB** is v5's one subscribe message: a selector, a mode and a cursor (LAYERS:518).
- A **trip** is one message there and its answer back. A **commit** is the moment a write is on disk on most copies.
- A **rule** is one thing a builder must get right, or a stated property breaks (SIMPLICITY 1.2). The base design has 416 (SIMPLICITY 0).

---

## 0. The proposal in short

1. **Take the lens as the address, not as the engine.** A path such as `chat.data.room1.m7` (or `chat.at('room1', 'm7')`, the same thing without a `Proxy`) names a place. Building it sends nothing and reads nothing. One address then reads (`get`), writes (`set`), streams (`connect`) and calls (`methods`).
2. **`connect()` is the one word that starts a stream, and it is the border.** What stands left of `connect()` is the server's work. What stands right of it is this process's work. The bytes that cross are the output of the left side. So `follow` and a served view's `open()` both go: they become `connect()`.
3. **Left of the border only two things are allowed at first: a keyed path, and a view the server named in `methods:`.** A keyed path costs the server a lookup. A named view costs what the server's author chose to offer. An operator a client makes up (`filter`, `top`, `group`) may not cross to the server: it is refused, loudly, at compile time and at run time. This keeps V4-5: the server's author decides what work a client can put on the server.
4. **The wire sends whole partitions.** A `connect` on anything inside `room1` holds `room1`. One sentence, no surprise. A selector for one row inside a partition is a second step, with its price named (section 4.3).
5. **A stream ends at `close()`, or when its scope ends. The garbage collector is a safety net only.** Measured here: a dropped object's finalizer ran after 1.3 s in a busy young heap, after 8 to 16 s in an idle process, and **not at all within 30 s** for a long-lived object in a busy process. So a stream tied only to the collector would keep a server sending for that long. And one rule makes the timing harmless: what a stream holds can be read only through what `connect()` returned.
6. **Make the second level a row, and drop `{ before }`.** `fero('chat', { depth: 2 })`: the first key is always the partition; rows live one level down. The owner's `chat.data.room1.m7` then works, and `m7` keeps everything a row has. With data as it is today, `m7` would be a field, and one write into a room of 10,000 messages costs 3.6 ms against 2.0 µs (brief 1.9).
7. **A method called on a path runs at that path's leader.** `shop.at('widgets').methods.sell(1)`. The path is the routing hint, so `near` goes. A path that spans partitions has no leader, and the call then runs anywhere, as today.
8. **`tap(fn)` gets `(changes, now)`**: the commit's changes by reference, and the live view itself. Never a copy. data's switch on the function's source text goes.
9. **`derive` stays, as a small library function over public calls.** The one thing a plain client and a plain server could not do by hand is put the source mark inside the output's own log entry. Make that a public write option (`{ after: e }`), and `derive` is a pattern.
10. **Exactly once**: fero gives it for writes into fero, by three tools with three horizons. It is Kafka's idempotent producer plus its "offsets with the outputs", without Kafka's transactions across partitions.
11. **`fero<typeof shop>` does not pull the server in when written with `import type`** (measured here against API.md's declarations). The safer shape is to export a type, `export type Shop = typeof shop`: then the wrong import fails loudly and never starts the server (measured here).
12. **Time travel stays off the write path.** It is a reader that folds the log (E-54). Its interface is one call, `history()`, in the reading process.
13. **`get` on a miss reads once and holds nothing.** You hold what you connect. Today's text has a `get` follow its key for the life of the handle; that is a hidden, growing cost.
14. **data needs five changes**, none of them Rust: keyed path subscriptions, no child handle kept for life, operators at a partition (two-level stores), one `tap` shape, and an anchor that is honest or gone.
15. **Rules: about −3 to +3 against the base for the first step** (reasoned, section 8). The parts not taken (operators made up by clients and run on the server) would add 5 to 8 rules and lean on a selector E-31 never modelled.

---

## 1. The map: each piece of the lens, on the wire, in the kernel, in data

The owner's line is `r.a.b.c.filter().map().connect(target)`. Here is what each piece can turn into.

### 1.1 What a SUB can select

The cluster knows four units: a resource, a slot, a partition, a row. What a server can route cheaply follows from that.

| The lens names | What the SUB selects | How the server routes each record | Server cost per record | In the design today? |
|---|---|---|---|---|
| the whole resource, `r.data` | `resource` | by the slot in the batch header | 1 to 4 ns when nobody follows the slot (PATHS 4.5 step 3) | yes (DV5:633) |
| one partition, `r.data.room1` | `partitions: [room1]` | by the partition; needs a partition hash in the record header, or a key decode | a few ns with the hash; 0.48 to 0.64 µs with a key decode (PATHS 4.5; PA-3 b) | yes |
| a row inside a partition, `r.data.room1.m7` | **nothing today** selects below a partition (brief 4.9) | a key decode, then a lookup in a row index | 0.48 to 0.64 µs, once per record, not per reader (reasoned from PATHS 4.5) | no |
| a field inside a row, `r.data.room1.m7.text` | nothing | the record's key holds the field path, but a whole-row write above the field needs the old and new leaf compared: that needs the fold | a decode of the value and a compare, on the folding thread (reasoned from data:api/index.ts:186-219) | no |
| a path across partitions, `r.data` with a row per partition | `resource`: every slot, so every group | as the first row | a cursor of 1.0 to 13 KB (PATHS 4.5 step 1; E-19) | yes |
| a test on the row, `.filter(…)`, `.gt('stars', 0)` | a `view` selector: a view kept on a server | the server's fold makes the view's own changes | the view's work, per **different** view, per change (section 1.2) | named in DV5:633; **not modelled** (E-31) |

**Three facts decide the rest.**
- **Bytes route by slot and by partition. Nothing finer routes without a decode** (PATHS 4.5, "Lower bound").
- **"Encode once" holds only while many readers want the same bytes.** One shared frame costs 0.01 to 0.46 µs per reader; a frame encoded per reader costs 2.1 to 2.4 µs a small row (brief 8 fact 13). Every selector that differs per reader gives that saving up.
- **Each subscriber still costs one socket write per tick: 8 to 14 µs** (E-08). No selector changes that.

### 1.2 Operators: which could run on the server, and what that costs

| Kind (brief 1.7) | Examples | Needs state on the server? | Server cost | Can its arguments travel? |
|---|---|---|---|---|
| per row, plain data | `gt`, `lt`, `between`, a field pick | no, if the server has the row before and after (data's delta has `prev`; data:contract/delta.ts:44) | the test runs per record **per different lens**: 100 `filter` views cost 9.0 µs a record at 100,000 rows, 17.9 µs at 1,000,000 (E-05) | yes: plain data (data:ops/registry.ts:14) |
| per row, a closure | `filter(fn)`, `map(fn)` | no | as above | **no**: code cannot travel (brief 8 fact 12) |
| ordered | `az`, `za`, `top`, `limit` | yes: an order | kept per view | yes |
| buckets | `group`, `distinct` | yes | `group` costs 2,574 µs a record at 1,000,000 rows today (E-05) | `group(fn)` no |
| running values | `sum`, `avg`, `length`, `max` | yes | kept per view | yes |

- **Sharing.** Two lenses with the same path and the same plain-data operators can share one server view and one encode. data already dedups such views in one process (data:api/index.ts:480-517). The key would be: resource, path, and the operators' arguments as text.
- **Where sharing fails.** A test that holds a per-user value, `where('owner', me)`, is a different view per user. 100,000 users are 100,000 tests per record: about 9 to 18 ms of the server's folding thread per record (computed from E-05's 100 filters). The lens makes that line look free.
- **A resume cannot use the log for a filtered stream.** A record has no prior value (brief 5.3), so the server cannot tell from an old record whether a row was in the set. A filtered stream that reconnects gets a new first picture, not the records it missed (reasoned). `follow`'s cheap resume (PATHS 4.6) is lost for it.

### 1.3 A `Proxy` per path step (PA-31)

- fero v4's lens makes a new `Proxy` and a new path array on every step: 0.14 to 0.42 µs a step on top of data's (brief 1.1).
- data keeps every child handle on its parent **for the parent's life**: 318 B per key read one step deep, 990 B two steps deep, never freed (brief 1.1; code data:api/index.ts:592-602). A server that touches 1,000,000 different keys through `ctx.data[sku]` keeps about 0.3 to 1 GB (computed).
- One read through the lens costs 0.47 to 4.5 µs; a `Map` read costs 0.03 to 0.66 µs (brief 1.1).
- **So a lens is for wiring, not for reading in a loop.** Built once and kept, its cost is paid once. This is API's rule already: "read through `rows`; write and derive through `data`" (API:423).

### 1.4 Lifetimes by `WeakRef` and `FinalizationRegistry`

- **data's own rule forbids it as a mechanism**: "Scopes are the lifecycle semantics; GC timing can never change observable results" (data:kernel/scope.ts:1-3).
- **data's `connect(anchor, fn)` ignores the anchor today** (data:api/index.ts:357-361). A callback that closes over its anchor keeps the anchor alive for good (brief 1.4, measured).
- **fero v4 already ties handler views to the collector (V4-54)** and wrote down the cost: about 4 µs per view; "a dropped view keeps being worked out on every commit until a GC finds it"; tests must force the collector (DEC:2762-2773).
- **How long the collector takes (measured here, fin-time.mjs).** 1,000 objects are registered, then dropped. No forced collection in the timed part.

| The dropped objects were | The process then | First finalizer ran after | Ran within 30 s |
|---|---|---|---|
| young | sits idle | 16.2 s | 999 of 1,000 |
| young | makes about 10 MB of garbage a second | 1.3 s | 999 |
| old (had lived through two collections) | sits idle | 8.1 s | 999 |
| old | makes about 10 MB of garbage a second | **never in 30 s** | **0** |

- The last row is the common server case: a stream that lived for a while, in a process that keeps working. Young garbage is cleaned by small collections, which never look at old objects. A registration costs 0.20 to 0.30 µs (same run).
- **Across the network the wait is not local.** Until the finalizer runs, the server keeps routing, the link keeps carrying, and this process keeps decoding and folding (2.7 to 3.2 plus 0.2 to 1.9 µs a small row, PATHS 4.5) for rows nothing can reach.
- **A DOM node that was removed is collected only when nothing in JavaScript reaches it** (from memory): a framework's tree, a closure, a devtools panel can each hold it. "Removed" and "collected" are different moments, with no bound between them.
- **Edge workers** (from memory, not checked): an isolate may live for one request. A finalizer may never run there.
- **The simulator.** fero's sim runs seeded schedules (fero:CLAUDE.md, `sim/`). A collector is not seeded. An unsubscribe driven by it can be allowed in a simulated world only if no result depends on when it comes.

### 1.5 Browsers (E-40) and many subscribers (E-08)

- A browser has one link and pays the decode and the fold on its page thread (PATHS 4.8). So what a browser lens selects decides the page's CPU, not only its bytes.
- data plus a client is 27.9 KB gzip (E-40). A lens adds an address object and a registry: small (reasoned).
- 1,000 sockets in one room on one web server should be **one** subscription and one decode per change (API:462). A lens per socket must not turn that into 1,000. So equal paths must share, counted.
- data today runs a child path subscription by subscribing the **root** and checking every row delta of every commit (data:api/index.ts:186-191). So K path subscriptions cost K checks per commit. Measured here: section 6.1.

---

## 2. Where the lens hides a cost or breaks a decision

| # | The line looks like | What it hides or breaks | Evidence |
|---|---|---|---|
| H1 | `r.a.b.c.connect(el)`: "I get only c" | Nothing on the wire selects below a partition. Either the partition comes whole, or the server pays a decode per record for a row index | brief 4.9; PATHS 4.5 |
| H2 | `r.data.filter(fn).connect()`: "the server filters" | `fn` cannot travel. It would run here, after the whole resource came down. The line would hide a full download | brief 8 fact 12 |
| H3 | `r.data.where('owner', me).connect()` | A different view per user on the server's folding thread: about 0.09 to 0.18 µs per user per record | E-05 |
| H4 | `r.data.group('team').connect()` from any client | A client makes the server keep state and work it never offered. **V4-5 in spirit**: `methods:` is how a server's author says what clients may ask of it. `group` is 2.5 ms a record at 1,000,000 rows | E-05; API:330 |
| H5 | the promise that nobody needs to unsubscribe | The stream runs on until a collection: 1.3 s to more than 30 s, measured. The server pays for all of it | section 1.4 |
| H6 | a sync read of a row that only a dropped lens held | It works until the collector runs, then throws `not-held`. **A result that depends on the collector.** Breaks data's scope rule and the simulator | data:kernel/scope.ts:1-3; API:426 |
| H7 | `r.data.methods…` on a path that spans partitions | No single leader exists for it. "Run by the leader for that path" has no meaning there | V5-2 |
| H8 | `r.a.b.c.set(v)` then `r.a.b.d.set(w)` | Two records. If `a` is the partition they are ordered; they are not one all-or-none write unless sent as a `batch` | API:298 |
| H9 | `connect` used to count events | `connect` is state: a slow reader is conflated to one change per row (DV5 4.4). A count needs every record: `changes()` | brief 4.9 |
| H10 | `shop.data.widgets.stock` read in a loop | 0.5 to 5 µs and a kept handle per key, against 43 ns | PA-31; brief 1.1 |
| H11 | a row named `filter`, `set`, `connect` or `then` | One dot is three name spaces: keys, operators, verbs. `await` reads `then` off anything | fero:api/substrate.ts:323-327 |
| H12 | operators right of `connect` made per request | data holds a view from its source, strongly, until disposed: "100 such calls left 100 dead filters" | DEC:2763 |

None of these kills the lens. Each needs one visible rule. Section 3 gives the rules.

---

## 3. The lens that keeps every cost in sight

### 3.1 Four rules a user learns

1. **A path is an address.** Building one sends nothing and reads nothing.
2. **`connect()` starts a stream, and it is the border.** Left of it is the server's work; right of it is yours.
3. **The wire sends whole partitions.** Connect inside a partition and you hold that partition.
4. **A stream ends at `close()` or with its scope. You read what a stream holds through what `connect()` gave you.**

### 3.2 The code

```ts
// file: lens.ts — one address: read, write, stream, call
import { fero, op } from 'fero'
type Msg = { text: string; stars: number }
const chat = await fero<Msg>('chat', { depth: 2 })       // a client. Holds nothing yet (section 5.5.7)

// 1. An address. No trip, no read.
const room = chat.data.room1                             // a partition
const msg  = chat.data.room1.m7                          // a row
const same = chat.at('room1', 'm7')                      // the same address, no Proxy, fully typed

// 2. Write. One record, one trip, shows at its commit (V4-7).
await msg.set({ text: 'hi', stars: 0 })                  // the same handle chat.set(['room1','m7'], …) returns
await msg.stars.set(op.incr(1))                          // a field: the leader judges it

// 3. Read once. One trip if not held; nothing is kept.
const m = await msg.get()

// 4. Stream. Left of connect(): the server. Right of it: here.
const live = room.connect()                              // SUB room1: its rows once, then its changes
await live.ready
const starred = live.filter((r) => r.stars > 0)          // here; a closure is fine on this side
starred.tap((changes, now) => render(now.rows))          // changes by reference; `now` is the view itself
live.close()                                             // ends the stream, and every view made from it

// 5. Stream into a target. The stream lasts until close(), or the scope's end.
const sub = msg.text.connect(el, 'textContent')          // sets el.textContent now, and at each commit
sub.close()

// 6. A view the server named. Left of connect(): the server runs it. Only its changes cross.
const top = scores.methods.top(10).connect()             // was .open()

// 7. A call at the path's leader. One trip, one commit.
await shop.at('widgets').methods.sell(1)                 // was near: true
```

### 3.3 What each line costs

| Line | Runs where | Crosses the network | Cost | Touches |
|---|---|---|---|---|
| `chat.data.room1.m7` | here | nothing | two small objects; with today's data 0.5 to 1.1 µs for two steps (brief 1.1). `chat.at(…)` is a plain call: no trap (reasoned) | PA-31 |
| `lens.set(v)` | the record is made here, judged at the partition's leader | one `ASK`, one `ANSWER` | as `f.set`: the trap was 1.5 % of v4's 7.7 to 8.3 µs write (PATHS 2.6) | V4-5: refused `methods-only` on a client when methods are declared. V4-7, V5-5, V5-11 unchanged |
| `lens.get()` | here if held, else a copy | one trip, one partition's bytes, kept by nobody | PATHS 4.4 | section 5.5.7 |
| `room.connect()` | the server routes; the fold runs here | one `SUB`; the partition once (`SNAP`); then one shared frame per tick (`DELTA`) | first picture 0.47 to 0.74 ms for a 100-row room with an index (PATHS 4.5); per change 0.01 to 0.46 µs per reader on the server; decode and fold here | V5-1 (a stream reads from a position). E-31's rules, unchanged |
| a second `room.connect()` in this process | here | nothing | a `Map` lookup and a count (reasoned) | API:462 |
| `live.filter(fn)` | here | nothing | data's: about the changed rows; ≤ 1 µs per view per change is the bar (API:459) | — |
| `msg.text.connect(el, 'textContent')` | here, after the fold | as `room.connect()` if room1 is not held, else nothing | one keyed lookup per changed row (needs section 6.1's change) | — |
| `scores.methods.top(10).connect()` | on a server | one `SUB` with a `view` selector; the view's rows once; then only the view's changes, encoded once per change, shared | the view's own work on the server, once however many clients | V4-5: only views the server named |
| `shop.at('widgets').methods.sell(1)` | at the leader of `widgets`' partition | one `ASK` straight to that leader | one trip, one commit: "the least a call can cost" (API:382) | V5-9 (direct routing); PA-25 |

### 3.4 Left of the border: what is allowed, and why so little

**Allowed left of `connect()`:**
- a keyed path: the resource, a partition, and (for the address) rows and fields inside it;
- a call of a method that returns a view.

**Refused left of `connect()`:** every operator. `chat.data.gt('stars', 0).connect()` does not compile, and at run time is refused `not-served` with a hint: "connect first, then filter here; or ask the server for a view".

```ts
// file: border.ts — the same question, asked on each side
import { fero } from 'fero'
type Score = { team: string; points: number }

// ── server.ts: the author says what work clients may ask for (V4-5)
export const scores = await fero('scores', {
  data: { ada: { team: 'red', points: 3 } } as Record<string, Score>,
  methods: { top: (n: number, ctx) => ctx.data.za('points').limit(Math.min(n, 100)) },
})
export type Scores = typeof scores

// ── client.ts
const c = await fero<Scores>('scores')
const a = c.methods.top(10).connect()        // the server sorts. 10 rows cross, then their changes
const b = c.data.connect().za('points').limit(10)   // this process sorts. Every row crosses
// @ts-expect-error an operator left of connect(): the server never offered it
c.data.za('points').limit(10).connect()
```

- **Line `a`**: one view on the server for every client that asks `top(10)`; one encode per change of the view (PATHS 4.5). The author capped `n` at 100, so no client can ask for a sort of a million.
- **Line `b`**: the whole resource comes down once, then every change to it. The line shows it: `data.connect()` has nothing left of it but the resource.
- **This keeps the owner's idea of operators before and after the boundary.** What is cut is the part where a client invents the server's work.

**Why not let plain-data operators cross?** It is the natural next step, and it has a price that should be paid on purpose.
- Each **different** pushed lens is its own test per record and its own encode (H3). Sharing saves only equal lenses.
- A resume needs a new picture (section 1.2).
- The `view` selector is the part of SUB that E-31 did not model (E-31, "What the model leaves out").
- Rules: about 5 to 8 more (reasoned): a row entering the set; a row leaving it; a field write to a row in the set; a picture on resume; a cap on pushed lenses per link; the sharing key; ending a shared view at its last reader; a view's position after a failover.
- A named view needs most of the same machinery, but the server's author bounds it. So build the named view first. If pushed `where` is wanted later, it rides the same selector, with the cap.

### 3.5 Lifetimes

```ts
// file: life.ts — three ways a stream ends; the collector is the fourth, and only a net
import { fero, scope } from 'fero'
const chat = await fero('chat', { depth: 2 })

// 1. By hand.
const live = chat.data.room1.connect()
live.close()

// 2. By scope: everything connected inside ends together. data has scopes today (data:kernel/scope.ts).
const page = scope(() => {
  chat.data.room1.connect(listEl, 'rows')
  chat.data.room2.m1.text.connect(titleEl, 'textContent')
})
page.dispose()                                  // a route change, a component unmount, a request's end

// 3. `using`, where the runtime has it.
{ using s = chat.data.room1.connect(); await work(s) }

// 4. The net: a handle or a target that was dropped without any of the above.
//    fero notices at some later collection, ends the stream, and (in dev) warns once with the path.
```

- **The net changes no result**, because of rule 4. `live.rows`, `live.value` and views made from `live` are the only way to read what the stream holds. If you can still read, the handle is alive, and the stream is too. `chat.rows` shows only what was held on purpose (`hold: 'all'`, or a size).
  - So H6 cannot happen: no sync read works "until the collector runs".
  - The simulator and `fero.world({ seed })` switch the net off. A test may add an adversary that ends a dropped stream at a random step; results must not change (reasoned; owed as a sim monitor).
- **`connect(target, prop)`** holds the target weakly and has no closure, so it cannot pin the target. **`connect(target, fn)`** calls `fn(target, changes, now)`: the target comes in as an argument, so `fn` need not close over it. A `fn` that does close over its target pins it for good; that is the one trap left, and the dev warning cannot see it (brief 1.4, measured).
- **Views made right of `connect()` belong to that connect** (H12). Closing it disposes them. A view needed for one request is made from a `connect()` made for that request; a second connect to a held partition costs a lookup and a count.
- **The last close sends the unsubscribe.** A process that opens and closes the same partition again and again would download it each time. The existing knob covers it: `hold: '200MB'` keeps closed streams' rows live, least recently used first (API:197). No new setting.
- **`using`** is not in Node 22 (from memory), and type stripping does not rewrite it. So `close()` and scopes are the forms the examples use.

### 3.6 Names that collide (H11)

- **`at(...)` is the canonical spelling.** `chat.at('room1', 'm7')` is a plain method on a plain object: no `Proxy`, no trap, and TypeScript types every step (measured here: section 11, `lens-use.ts`).
- **The dot is sugar for `at`.** `lens.k` is `lens.at('k')`, except when `k` is spelled like a verb (`at`, `get`, `set`, `remove`, `connect`, `methods`), like `then`, or is a symbol. Then the dot is the verb, and the row is reached with `at('set')`. Six verbs, so six reserved names; operators are not on a lens at all (they are right of `connect()`), so `filter` and `map` are free as keys.
- The owner's idea that a function call lives in a different space from a key would need every step to be a callable `Proxy` that waits to see if it is called. That is a function object per step, an `apply` trap, and a type TypeScript cannot give a row map (reasoned). The six reserved names cost less.

---

## 4. Costs the proposal leaves in sight, and the next steps it prices

### 4.1 What a user must still know

| You wrote | You pay |
|---|---|
| `fero('shop')` | nothing but the open: 2 to 3 trips (TOUR:228) |
| `shop.data.connect()` | the whole resource once, then every write to it |
| `chat.data.room1.m7.text.connect(…)` | room1 once, then room1's changes |
| `lens.get()` in a loop | a trip each time. The fix is one `connect()` |
| `c.methods.top(10).connect()` | what the server's view costs; here, 10 rows |
| a view right of `connect()` | data's fold here, per change |
| no `close()` and no scope | the stream runs until a collection finds it: seconds to never (section 1.4). Dev mode warns |

### 4.2 Sharing

- **In one process**: one registry, `Map<key, { stream, count }>`. The key for a path is the resource and the partition. The key for a named view is the method and its argument as canonical text. `connect()` adds one; `close()` takes one; zero sends the unsubscribe (API:462 says the same of `follow`).
- **On the server**: the same key across clients. One view, one encode per change (PATHS 4.5).
- **Never shared**: views right of `connect()` built from closures. data cannot compare two functions (data:api/index.ts:480-517).

### 4.3 The next step: a row selector (not in the first step)

- **What**: `SUB` gains "these rows of this partition". A `connect` on a row then holds that row only.
- **Server**: a key decode per record of a partition that has row readers (0.48 to 0.64 µs, once per record), then a hash lookup. An index entry per (row, reader).
- **Rules**: +2 to +3 on `subscribe`'s 26 (reasoned): the row index; the picture of a row that does not exist yet; the cursor moves past records that were not sent.
- **Debt**: E-31 run again with a selector narrower than its slot.
- **When it pays** (reasoned): when partitions are large and readers want single rows of them. With a row per partition (the default) the row **is** the partition, so the first step is already exact.
- **Why not now**: rule 3 ("the wire sends whole partitions") is one sentence, costs no rule, and matches what `get` on a miss already does (API:392).

### 4.4 What is not taken, and what it would cost

| Idea | Why not, for now | Would cost |
|---|---|---|
| operators made up by a client, run on the server | H2, H3, H4; the `view` selector is unmodelled | +5 to +8 rules; a new first picture on each resume |
| the collector as the way a stream ends | H5, H6; data's scope rule; the simulator | results that depend on timing |
| a field selector on the wire | needs the fold to compare leaves | a value decode per record per field reader |
| every path step a callable `Proxy` | section 3.6 | a function per step; untyped paths |

---

## 5. The owner's seven points

### 5.1 Nesting against `{ before }`

**The question.** Why key a message `'room1/m7'` and say `partition: { before: '/' }`? Why not `chat.data.room1.m7`, with the top key as the partition, as fero v2 did (v2:partitions.js:20-22)?

**Is the default enough, with data as it is? No.** Under today's default, `room1` would be a **row** and `m7` a **field** of it. A field loses this:

| A row has | A field of a room row has |
|---|---|
| a write that costs the same at any room size: 0.7 to 2.0 µs | a write that copies the room's top level: 1.1 µs at 10 messages, **429 µs at 1,000, 3.6 ms at 10,000** (brief 1.9, measured). Every copy and every follower pays it again in its fold |
| its own version; `if: { version }` fails only when **it** changed | the room's version: an edit to `m7` fails whenever anyone posted |
| `ttl`, `max`, `where`, `while`-session, each per row (API:728) | none: a message cannot expire alone |
| a size limit of 64 MB for itself (API:1209) | the whole room must fit in 64 MB |
| a freeze once after it was written (API:390) | the room's new top object is walked again after every post: a check per message (reasoned from data:api/index.ts:152-162) |
| `e.value`: a whole-row write carries the row (API:469) | `e.value` is `undefined`: it was a field write. `derive` and `consumer` loops that read `e.value` see nothing |
| views: `chat.data.gt('stars', 0)` | none: an operator on a child path throws, "child handles are addresses, not views" (data:api/index.ts:543-548) |
| a first write that cannot be refused, so early answer stages | `absent-row` if the room row is not there yet, so no early stage (API:261, 1159) |
| insertion order | a JavaScript object's key order: number-like keys jump ahead (from memory) |

Holding and following part of a partition is the same either way: the partition is the unit.

**So which: make the second level a row, drop `{ before }`, or keep it?**

**Make the second level a row, and drop `{ before }`.**

```ts
// file: depth.ts — the first key is always the partition
import { fero } from 'fero'
type User = { name: string }
type Msg = { text: string; stars: number }

const users = await fero<User>('users', { server: true })            // depth 1 (default): users.data.u42 is a row, and its own partition
const chat  = await fero<Msg>('chat', { server: true, depth: 2 })    // chat.data.room1 is a partition; chat.data.room1.m7 is a row

chat.data.room1.m7 = { text: 'hi', stars: 0 }                        // a whole row, in room1's order
chat.set(['room1', 'm7', 'stars'], 1)                                // a field of that row
console.log(chat.rows.room1?.m7?.text)                               // a lookup, then a lookup
const room = chat.data.room1.connect()                               // one partition
console.log(Object.keys(room.rows))                                  // its rows; walks room1 only
```

- **What runs where.** Every process routes by hashing the first key. No option is needed to route, so a browser routes with nothing learned (today a function rule cannot travel, and a client without it pays one more trip each write, API:174). `depth` matters only to the fold: it says where the row begins. It is fixed at founding and kept in the resource's log, as the partition rule is today (API:177).
- **On the wire.** The record's key becomes `[partition, rowKey, ...fieldPath]` for depth 2. It carries the same text as `'room1/m7'`, split (reasoned). No `/` to escape; a room named `a/b` just works.
- **In data.** The store becomes two levels: a map of partitions, each a small row store. That **is** PA-17's partition-to-rows index, as the store's own shape instead of a second structure kept in step with it. A room's first picture is then a walk of that room: 0.47 to 0.74 ms for 100 rows, not 26 to 28 ms (PATHS 4.5).
- **Cost.** One container per partition. Not measured; a small `Map` is a few hundred bytes (from memory). Right for rooms; wrong for a resource of 1,000,000 partitions with one row each, which is what depth 1 is for.
- **Decisions.** V5-2 says the partition is "a row key by default, a prefix, or the user's function". Depth 2 is the prefix form, made by structure. The function form can stay as V5-2's escape hatch; with depth, no pattern in API section 10 needs it (API:181 says the prefix covers all 22). Dropping it is the owner's call.
- **Rules.** −1: the text rule and its escape. 0: the index was owed anyway (PA-17). +1: `depth` checked at founding and on every open. Net about 0, and one concept fewer for the user: no key syntax.
- **What goes.** `follow({ prefix })` over partition names (API:179 walks every name for it). P-19's `shop.follow({ prefix: 'ada' })` becomes `shop.data.ada.connect()`.
- **Open.** A view over **every** row of a depth-2 resource needs a key per row that is a pair. data's keys are one string or number today. Either data carries pair keys, or such a view is refused and the app asks per partition. To be decided with the data change (section 6).
- **Why not always two levels, with no option, as the owner partly suggests.** Then `users.data.u42.name` would be a row, and a user would be a partition of field-rows. Views over users, `e.value`, a TTL per user and a whole-user condition would each need the partition put back together as one object. Something has to say where the object begins. One number says it.

### 5.2 Exactly once

**Short answer.** fero gives exactly once **for writes into fero**, by three tools. No system gives it for an email or a payment made inside your code; Kafka does not either (brief 6.4, from memory).

| Tool | What it makes exactly once | For how long | Cost | Kafka's nearest (from memory) |
|---|---|---|---|---|
| **client sessions**, always on | a resend of a write: the first answer comes back, the write lands once | the session's life; a pause over `session.ms` (10 s) answers `unknown` for writes in flight | 309 B per active client; 13 rules (E-20) | the **idempotent producer**: a producer id and a sequence per partition; the last 5 batches; lost when the producer restarts |
| **`once` names** | a write or a call named by the app, from any process, across restarts | 1 day | 221 B a name for its day; a named call is 3 commits and up to 2 more trips (API:380) | none in the producer. A `transactional.id` fences an old producer, but does not dedup a named message. NATS JetStream's message id is the same idea, for 2 minutes |
| **marks** | a source record's effect on a derived resource: `derive`, `consumer(…).run()` | as long as the source keeps its log back to the mark (`history`, default 0, or the tier) | 29 B a mark, inside the output's own log entry; 5 rules (E-30) | **offsets stored with the outputs**: `sendOffsetsToTransaction`, or offsets kept in the output store |

```ts
// file: once.ts — the three tools
import { fero, op, derive } from 'fero'
const orders = await fero<{ user: string; cents: number }>('orders')
const totals = await fero<number>('totals', { server: true })

await orders.set('o1', { user: 'ada', cents: 500 })                        // 1. a lost answer is retried under the session: lands once
await orders.set('o2', { user: 'ada', cents: 900 }, { once: 'cart-77' })   // 2. safe to send again tomorrow morning, from another process
await derive(orders, totals, (e, out) => {                                 // 3. each order counts once, across any restart
  if (e.value) out.set(e.value.user, op.incr(e.value.cents))
})
```

**Where fero gives less than Kafka.**
- **Kafka's transactions write to many partitions all-or-none**, and a `read_committed` reader never sees half. fero has no transaction across partitions (V5-1 gave it up). A `derive`'s outputs to several partitions commit one by one; each still counts once, but a reader may see some before the rest (API:497).
- E-30 found fero does not need the transaction for exactly once: the mark in the output's own entry is enough, with no two-phase commit (E-30 Verdict).

**Where fero gives more.**
- A `once` name outlives the process. Kafka's idempotent producer forgets on restart.
- E-20 found Kafka's producer-id scheme needs 16 rules against 13 for sessions, and as first written could stall a partition (E-20).

**What is not exactly once, said plainly.**
- A handler's own side effect. A queue worker: at least once (API:1517). A `for await` over `changes()` with a hand-saved cursor: at least once. A call with neither `once` nor `retry` whose server dies: `unknown`, at most once (API:1193).
- A `derive` whose source log was cut before its mark stops with `expired`. It never skips (LAYERS:930). With `history` at its default of 0, that is any stop longer than the tier keeps. **This is a cost the tour did not show**: a `derive` needs `history` set on its source.

**Rules.** No change.

### 5.3 `fero<typeof shop>`: does the client pull in the server?

**With `import type`: no.** Checked three ways.
- **It compiles against API.md's declarations** (measured here: `types/`, TypeScript 6.0.2, with `verbatimModuleSyntax` on). A wrong method name on the typed client is still an error.
- **Node's type stripping drops an `import type` line whole**: the server file does not run (measured here, and brief 4.12).
- **A bundler leaves the server out** (brief 4.12: esbuild 0.25.12).

**The footgun.** A plain `import { shop } from './server.ts'`, used only in `typeof shop`:
- under Node's type stripping it **runs the server file**: the client process founds or joins as a server (measured here: "SERVER MODULE RAN"; and brief 4.12);
- under `verbatimModuleSyntax` a bundler **ships the server's code** to the browser (brief 4.12);
- TypeScript does not complain, because `shop` is a value (reasoned, and it compiled here).

**A safer shape: export the type, not the handle.**

```ts
// ── server.ts
export const shop = await fero('shop', { data: { widgets: { stock: 10, price: 10 } }, methods: { /* … */ } })
export type Shop = typeof shop                     // the client's contract

// ── client.ts
import type { Shop } from './server.ts'
const customer = await fero<Shop>('shop')
```

- **Now the wrong import fails loudly, and starts nothing.** `import { Shop } from './server.ts'` under Node: "does not provide an export named 'Shop'", raised when modules are linked, **before the server file runs** (measured here: no "SERVER MODULE RAN" line). Under `verbatimModuleSyntax` it is a compile error (measured here: the `@ts-expect-error` line holds).
- **Cost.** Nothing at run time. One more line in the server file.
- **A second net, already in the design**: a server marker in a browser is refused `no-server-here` (API P-19).
- **Decisions.** None. **Rules.** None. A docs change: every typed example uses `Shop`.

### 5.4 Time travel

**The owner's picture is right.** fero holds the current state, and each new change record is folded in. But the records cannot be run backwards as they are: **a record holds the new value only, never the old one** (brief 5.3). data has the old row in memory at the moment of the write (`prev`, by reference, data:contract/delta.ts:44) and then lets it go.

**What needs it** (E-54; brief 5.1).

| Who | Needs | Where it runs |
|---|---|---|
| the timeline viewer, `fero debug` | step, jump, show rows at a moment | the viewer's process |
| tapes and reruns (TEST-07) | the state just before input i, in tape order | the test runner |
| forks | a resource cut at a position | storage, then one fold |
| restore | cut and rebuild | an admin step |
| an audit page, "this row last Tuesday" | one row's history | a reader |

**None of them is on the live write path.** Each is a reader of the log, which is already the history (V5-1).

**The two approaches the owner recalls** (E-54, from the literature).
- **O(log n): path copying.** A hash trie (Clojure, Immutable.js). Every version is a root that can be kept and shared. A write copies about 4 nodes at 1,000,000 keys.
- **O(1): rerooting** (Baker). A write is one small diff node. But a read is O(1) only at the version that holds the real table; any other version costs the distance to it first, and two readers at two versions fight over the table. Not safe to share.

**What they cost here** (E-54's answer; its result tables were still being filled when this page was written).
- A hash trie root per write adds 3.4 to 5.8 µs to a 0.76 to 1.4 µs fold, keeps 1.3 to 1.7 KB a version, and pushes the collector from 0.5 % to 14 to 22 % of the time. Rust's tries were no cheaper: about 10 µs a write.
- Reverse records, the cheapest, add 0.14 to 0.31 µs and 16 to 49 B a record, on every copy.
- **On the reader**, "fat nodes over the log" add 0.4 to 0.5 µs a record while folding and keep 54 to 76 B a version. A step or a jump is under 0.2 µs. A row at any version is 2.5 to 3 µs. A picture is a version number, frozen by construction.

**So: do not put it on the write path. Give the reader one call.**

```ts
// file: history.ts — step through a resource's versions, in the process that looks
import { fero } from 'fero'
const shop = await fero<{ stock: number }>('shop', { hold: 'asked' })

const h = await shop.history({ of: 'widgets', from: '2026-11-10', until: 'latest' })   // reads the log's window once
console.log(h.versions)                    // how many steps it holds
const then = h.at(h.versions - 100)        // a picture: a number. Frozen. Free
console.log(then.rows.widgets)             // a row as of then: about 3 µs
for (const c of h.changes(then, h.latest)) console.log(c.key, c.prev, c.row)   // what changed between two moments, old and new
h.close()
```

- **What runs where.** All of it here. The server does what it does for any `changes()` reader.
- **Over the network.** The window's records, once: a log-mode `SUB` from a position (V5-1). Then nothing per step.
- **Cost.** Per record of the window: a decode (2.7 to 3.2 µs), the fold, and 0.4 to 0.5 µs and 54 to 76 B for the history (PATHS 4.5; E-54). Memory grows with the window, so `from` is required.
- **It needs the log to reach back**: `history` on the resource (default 0, API:1342) or the tier. Past it: `expired`.
- **Safe.** A picture is a number into shared, frozen rows; nobody can change it, and stepping changes nothing another reader sees (E-54, "What is safe").
- **Decisions.** V5-1: this is "replay folds from a snapshot to a position", as an API. Nothing else.
- **Rules.** 0 in the kernel. About 3 in the reader (reasoned): the previous-record pointer per row; the window's start is a snapshot; a row written very often switches to a searchable list (E-54's hot-row finding).

**What number would change this answer.**
- If keeping a version per write cost **under about 0.2 µs and 20 B on the live path, with the collector's share staying under 1 %**, an always-on "any row at any recent version" on servers would be worth a look. E-54's best is 0.14 to 0.31 µs and 16 to 49 B (reverse records), which can only walk, not jump; its best that can jump is 0.4 to 0.5 µs and 54 to 76 B. Close, but there is still no user on the live path.
- If a **use on the live path** appears: a handler that must read several rows as of one position (a consistent read across partitions), or a `fresh` read at a past version. Then a short window of versions on servers (the last few seconds) is the thing to measure, not the whole history.
- If a fork must **start** in under about 10 ms at 1,000,000 rows (E-06: 2.6 s today), data's store itself would need shared structure. E-54 prices that at the trie's write cost. It is the one place the O(log n) structure buys something no reader-side structure can.

### 5.5 The connect lens

Sections 1 to 4 are the answer. The owner's sub-points, one by one.

**5.5.1 How an app manages the state it downloads.** By `connect` and by scope. A process holds what it connected, for as long as the connect lives. A page connects in the scope of a route or a component; a server connects at module level for what it always needs, and in a request's scope for the rest (section 3.5).

**5.5.2 Over the whole path, server to client.** Yes for the path: the address names the partition, the partition is what the wire routes, and equal addresses share one stream on each side (sections 1.1, 4.2). **Not below the partition yet** (section 4.3), and not for made-up operators (section 3.4).

**5.5.3 Weak references, so nobody has to unsubscribe.** As a net, yes; as the mechanism, no. Measured: 1.3 s to never (section 1.4). Rule 4 makes the net safe.

**5.5.4 Operators before and after connect.** Kept exactly: left is the server, right is here. Left takes paths and the server's named views only (section 3.4). The owner found server-side transformations missing: they are in API.md as a method that returns a view (API:349), but said in one bullet. This page makes them one of the two things that may stand left of `connect()`.

**5.5.5 Methods on a path, and `near`.**

```ts
// file: near.ts — the path is the routing hint
import { fero, op } from 'fero'
export const shop = await fero('shop', {
  data: { widgets: { stock: 10, price: 10 } },
  methods: {
    sell:    (n: number, ctx) => ctx.at.stock.set(op.incr(-n, { min: 0 })),   // ctx.at: the address the call was made on
    restock: (n: number, ctx) => { ctx.at.stock = op.incr(n) },
    low:     (max: number, ctx) => ctx.data.lt('stock', max),                 // called on the resource: runs on any server
  },
})
export type Shop = typeof shop
const c = await fero<Shop>('shop')             // in the client's file, after `import type { Shop }`
await c.at('widgets').methods.sell(1)          // goes to the leader of widgets' partition: one trip, one commit
const low = c.methods.low(5).connect()         // no path: any server
```

- **What runs where.** The client hashes the path's first key and sends the `ASK` to that slot's leader (V5-9's direct routing). The handler's writes through `ctx.at` are local to that leader.
- **Cost.** One trip and one commit, as `near` gives today (API:382). Without a path, about 2 writes in 3 take one more trip with three servers (PA-25).
- **It stays a hint for speed, never for safety.** A call that lands on another server still works, one trip slower (API:383). A method is still not a transaction (API:364).
- **A path that spans partitions** (the resource itself; in depth 2, nothing above a partition but the resource) has no leader. The call runs anywhere. The code shows which case it is: there is a key after `at`, or there is not.
- **What goes.** The `near` option and its hint in the resource's settings, which clients had to learn. **Rules.** −1 (the learned hint), +1 (`ctx.at`). Net 0.
- **V4-5.** Unchanged: the call is a method; the path only routes it and is handed to the handler.
- **Not claimed.** That the handler's writes are all-or-none. They could be staged into one batch, since they share a partition (API:298), but a handler that awaits between them would see its own half. Left open.

**5.5.6 `shop.data.a.b.c.set()` against `shop.set`.**
- **Both stay, and they are the same record.** `shop.set(['a','b','c'], v)`, `shop.at('a','b','c').set(v)`, `shop.data.a.b.c.set(v)` and `shop.data.a.b.c = v` all send one `Rec` with key `['a','b','c']`. The first three return the same write handle (API:861 already says so for `data.set`).
- **The lens form is the more useful one, but not for speed.** Its gain is that an address can be kept and passed: `const stock = shop.at(sku, 'stock')`, then `stock.set(…)`, `stock.get()`, `stock.connect(el, 'textContent')`. At the issuer the path steps cost 0.3 to 1 µs against an array literal (brief 1.1); on a 7.7 to 8.3 µs write that is noise (PATHS 2.6).
- **`shop.set(path, v)` stays as the plain verb** every other form turns into. It needs no `Proxy`, and a handler's `ctx.set` and a `batch` entry are written with it.
- **V4-5 in the types.** On a typed client of a resource with methods, a lens has no `set` and no `remove`. API:375 left this open; the lens is the place to close it, since one type covers every spelling.
- **V4-7.** A lens write shows at its commit. `connect` delivers commits. No optimistic copy anywhere.

**5.5.7 Whether `follow` is still needed.** It is not.

| Today | Becomes | Why |
|---|---|---|
| `f.follow('room1')` | `f.data.room1.connect()` or `f.at('room1').connect()` | one word for "start a stream" |
| `f.follow(['a', 'b'])` | two `connect()` calls in one scope | they ride one link, and one `SUB` frame per tick (reasoned) |
| `f.follow({ prefix })` | gone; with depth, `f.data.ada.connect()` | it walked every partition name (API:179) |
| `f.follow({ share })` | stays inside `consumer` | it was never an app's call |
| `f.methods.low(5).open()` | `f.methods.low(5).connect()` | the same stream, the same word |
| `hold: 'all'` | `f.data.connect()` | the cost is on the line |
| `await f.get(k)` on a miss, which then followed `k` for good | reads once, holds nothing | today "every key this process ever read stays followed for the life of the handle" (API:198) |

- **So the default `hold` becomes "nothing until you connect".** TOUR question 8 called it the closest call and said that with `'asked'` "every cost would show". With `connect` the ten-line example gains one line, `const live = shop.data.connect()`, and that line is the download.
- **`hold: '200MB'` stays**, with one meaning: keep what was read or closed, least recently used first, inside this bound. It is the near cache (P-03).
- **Names.** −2 (`follow`, `open`), −1 option (`near`), −1 form (`{ before }`); +2 (`at`, `connect`), +1 option (`depth`).
- **Rules.** −2 (reasoned): the hidden follow on a `get` miss with its drop order, and the prefix walk. +2: rule 4's read-through-the-handle, and the net's unsubscribe being safe to run twice and at any time.

### 5.6 What `tap` gets

**Today in data** (brief 1.5).
- data looks at the function's **source text** to choose: `fn.length`, then a pattern match on `toString()` (data:ops/misc.ts:598-611).
- No parameter: called once at the start and once per commit, with nothing. Cost about 0.
- A parameter: called once per changed row with a record that was built and deep-copied. **About 1.7 µs per change** (brief 1.2, measured). Its first call carries a deep copy of the **whole** current value: O(rows), unseen.
- It never gets the latest copy.
- API.md says two things: "A tap gets one [record]" (API:641) and "the first call carries the picture so far" (API:463).

**The trouble.** Naming a parameter you do not use makes every change 1.7 µs dearer. A minifier, a default value or `...args` can flip the mode (reasoned from the pattern match). A cost that depends on how a function is spelled is a hidden cost.

**Proposal: one shape, no copy.**

```ts
// file: tap.ts — changes by reference, and the view itself
view.tap((changes, now) => {
  if (changes.first) return draw(now.rows)            // the first call: no changes yet; read the picture from `now`
  for (const c of changes.rows) patch(c.key, c.row, c.prev)   // c.op: 'add' | 'update' | 'remove'; c.prev: the row before
})
```

- **`changes`** is the commit's own list, by reference: at most one entry per row, each with the new row and the old one (data's `CommitBatch`, data:contract/delta.ts:28-86). Rows cannot change after a write (data:contract/SCHEDULE.md:96-97), so sharing them is safe.
- **`now`** is the view the tap is on. Reading `now.rows.k` is a lookup. It gives the latest copy without making one. Handing a fresh copy each time would cost O(rows) per change, so that is refused.
- **Cost.** A by-reference sink costs 0.017 µs per sink per commit (brief 1.2, data's own gate). One call per commit, not per row.
- **Records for the wire**, for code that forwards them (P-05): `changes.recs()`. A call you can see; it builds them once per commit and every tap that asks shares them (reasoned).
- **`prev` is the old value the log does not carry.** So an undo button, a diff, an audit line are written in a tap with no history kept anywhere.
- **`connect(target, fn)`** gets the same two, after the target: `fn(target, changes, now)`.
- **Decisions.** V4-7 holds: a tap runs after a commit applied. **Rules.** −1: the mode chosen from source text. data's SCHEDULE clause 4 (effects run after state settles) is unchanged.

### 5.7 `derive` as plain clients and servers

**The owner's way works, and v2 did it** (v2:README.md:251-271):

```ts
// file: derive-by-hand.ts — a client of orders, a server of totals, a loop between
import { fero, op } from 'fero'
const orders = await fero<{ user: string; cents: number }>('orders')
const totals = await fero<number>('totals', { server: true })
const r = orders.changes({ from: savedCursor ?? 'earliest' })
for await (const e of r) {
  if (e.value) await totals.set(e.value.user, op.incr(e.value.cents))
  save(r.cursor)
}
```

**What this loop gets wrong, each one a rule the app must then get right.**

| # | The gap | What happens | The fix `derive` holds |
|---|---|---|---|
| 1 | a crash between the output's commit and `save` | the order counts twice on restart. Save first instead, and it is lost | the source position rides **inside** the output's own log entry: 29 B (E-30) |
| 2 | the outputs' partitions are not the cursor's | no `batch` can write both: a batch is all-or-none in one partition only (API:298) | a mark per (source slot, output slot), carried when a slot moves. Kept per group instead, it loses an output on a move (E-30) |
| 3 | `await` on each output | about 250 source records a second (PA-19) | outputs are staged; nothing to await (API:496) |
| 4 | the file runs on three servers | three loops, three times the outputs | the derivers split the source's shares; one live owner each (API:499) |
| 5 | the process already holds `orders` | it still reads it over the network: a hop and a decode per record (PATHS 4.9) | hand over the folded records in-process |

- Gap 1 can be closed by hand with a `once` name per source record: `totals.set(user, op.incr(c), { once: 'orders@' + e.version })`. It holds for 1 day, costs 221 B a record against 29 B, and takes no early stage (API:261, 1143). A stop longer than a day counts twice.

**So `derive` is not new machinery. It is five rules held in one place.** What makes it look special in API.md is that the mark can only be written from inside. Make it public, and `derive` is a pattern:

```ts
// file: derive-pattern.ts — the same loop, exact, on public calls only
import { fero, op, consumer } from 'fero'
const orders = await fero<{ user: string; cents: number }>('orders')
const totals = await fero<number>('totals', { server: true })

await consumer(orders, { name: 'totals', marks: totals }).run((e) => {            // gap 4: shares. Resumes from totals' own marks
  if (e.value) totals.set(e.value.user, op.incr(e.value.cents), { after: e })    // gaps 1, 2: the mark rides the entry. Not awaited: gap 3
})
```

- **`{ after: e }`** *(proposed)* says: "this write is the effect of source record `e`". The leader applies it only if `e` is above the mark it holds for that source slot and this output slot (E-30's rule). It answers at commit only, since it can be turned down as a repeat (V5-11 ruling 6).
- **`derive(orders, totals, fn)` stays as the two-line wrapper** of that. Its `out.set` is `totals.set(…, { after: e })`.
- **What runs where, the network, the cost.** As PATHS 4.9: one delivery, one run of the function, a share of one commit per source record.
- **Decisions.** V5-2 point 4, as code: "a client of each source… the owner of its own resource. Its log records how far it has read."
- **Rules.** 0: E-30's 5 rules exist either way. One more public option to explain. **Risk**: a wrong `e` passed by hand writes a wrong mark; the wrapper cannot do that.
- **Never `connect` for this.** `connect` is state: a slow reader gets one change per row, not every record (H9). A count over a `connect` stream is wrong under load.

---

## 6. What data would have to change

The owner allows a rewrite; data must still stand alone. Each change below is useful to data alone.

| # | Change | Why | Size | Rust? |
|---|---|---|---|---|
| D1 | **Path subscriptions through a keyed index**, not a scan of every delta by every subscription | section 6.1 | a `Map` from row key to subscribers at each source; a small trie below the row | no |
| D2 | **No child handle kept for its parent's life.** A lens is a small value (source, path); `at()` builds one without a `Proxy` | 318 to 990 B per key touched, never freed (brief 1.1) | the handle cache becomes per scope, or goes | no |
| D3 | **Two-level stores**: a map of partitions, each a row store; operators work at a partition | section 5.1; PA-17's index; "child handles are addresses, not views" (data:api/index.ts:543-548) | the largest change. Views over one partition are today's views over a smaller source | no |
| D4 | **One `tap` shape**: `(changes, now)`, by reference. No look at the source text, no deep copy | section 5.6 | small; the v2-shaped record becomes `changes.recs()` | no |
| D5 | **`connect(target, prop | fn)` holds its target weakly**, hands it to `fn`, and has the net of section 3.5. Or the anchor argument goes | today the anchor is checked and then ignored (data:api/index.ts:357-361) | small | no |
| D6 | **Views belong to the scope or connect they were made in** | V4-54's dead filters (DEC:2763) | data's scopes exist; this makes them the default owner | no |
| D7 | Owed already: the lazy freeze (DATA-07), `group` at O(change) (DATA-05) | API:390; E-05 | — | no |

**Standing alone.** `$(obj).a.b.connect(el, 'textContent')`, `at()`, scopes and `tap((changes, now))` all mean the same with no network. fero adds one thing: `connect()` on a path not held here sends a `SUB`.

**Rust.** Not for any of this (reasoned from E-03 and E-54).
- A user's function in an operator is JavaScript. A Rust data would call back per row: 107 ns inside a napi call, 3.8 µs from a Rust thread (E-03).
- A row must be a plain JavaScript object, or `rows.k.stock` stops being a 43 ns read. Objects built from Rust cost 888 ns a record against 712 ns for the JavaScript decode (E-03).
- E-54's Rust tries were slower per write than Node's.
- Where Rust pays is where bytes never become objects: routing, the log, the relay, checksums. That is L0 and L1, as LAYERS:64 already reads.

### 6.1 D1, measured

10,000 rows; K subscriptions, each on a different row; one write changes one field of one row. data today, against one sink that looks the row up in a `Map` (measured here, path-fan.mjs; ns per write, median of 5 rounds of 50,000 writes):

| K subscriptions | data today: each subscribes the root | one sink and a `Map` |
|---|---|---|
| 0 | 1,715 | 1,973 |
| 10 | 2,037 | 2,028 |
| 100 | 4,179 | 2,123 |
| 1,000 | 23,098 | 2,219 |
| 10,000 | 356,437 | 2,459 |

- **data today costs about 21 to 35 ns per subscription per write, whichever row the write touched** (computed from the table). With 1,000 lenses on one page or one web server, every write costs 23 µs instead of 2.2 µs; with 10,000, 0.36 ms.
- **A keyed index costs about the same at any K**: 2.0 to 2.5 µs, of which the write itself is 1.7 to 2.0.
- The index here sits beside data, in a sink. Inside data it should cost no more (reasoned); M2 checks it.
- **This is the one change the lens cannot do without.** A lens per DOM node is the owner's picture, and today it is O(lenses) per commit.

---

## 7. What changes in the docs

### 7.1 API.md

| Section | Change |
|---|---|
| 2, the shape | add `at(...keys)` and the lens verbs: `get`, `set`, `remove`, `connect`, `methods` |
| 3.2 partitions | the first key is the partition; `depth: 1 | 2`; `{ before }` goes; the function form by the owner's call |
| 3.3 `hold` | the default holds nothing; `data.connect()` is "everything"; a size is the near cache |
| 3.8 methods | a call on a path runs at its leader; `ctx.at`; `near` goes; `export type Shop = typeof shop`; a typed client's lens has no `set` when methods are declared |
| 3.9 reads | `get` on a miss reads once; `f.rows` shows what was held on purpose; a stream's rows are read through its handle |
| 3.10 | one table: left of `connect()`, right of `connect()`. `follow` and `open` go. `tap((changes, now))`. `changes()` stays, for every record in order |
| 3.11 | `derive` shown as the wrapper of `consumer` plus `{ after: e }`; say that it needs `history` on its source |
| new 3.12 | `history()`: the reader for versions |
| 6, declarations | `Lens`, `Live`, `Sub`, `Changes`, `Delta`; drop `Follow`, `Selector`'s prefix, `LiveCall.open`. A sketch that compiles against today's declarations is in section 11 |
| 7 and 8 | new refusals: `not-served` (an operator left of `connect()`); the dev warning for a dropped stream |
| 10, patterns | P-03, P-05, P-12, P-13, P-19 use `connect`; P-17 uses the wrapper |
| 11, questions | closes 8 (default hold) and 9 (a `get` that misses); opens: the function partition, pair keys in whole-resource views, row selectors |

### 7.2 LAYERS.md

| Place | Change |
|---|---|
| L3 4.2, the subscriber index | add: per process, the registry of shared streams by key, with counts |
| L3 4.3, `subscribe` | no new rule in the first step. Owed: the `view` selector's rules, modelled (it was already owed: PA-5, PA-11, E-31's left-out list). Later: the row selector, +2 to +3 |
| L3 4.4 | "up to L4": `connect`, in place of "live views of followed partitions" |
| L2, the record | the key is `[partition, rowKey, ...fieldPath]` when depth is 2; the partition hash in the header is the hash of the first key (PA-3 b) |
| L4 | a call's routing key comes from the caller's path, not a learned hint |
| 7, the wire | no new verb. `SUB` carries a `view` selector as method name plus canonical argument |
| 8.8, derive | the mark is a public write option; who runs it stays open (API Q-B8) |

### 7.3 data

Section 6's D1 to D6, and SCHEDULE's text for `tap` and for scopes owning views.

---

## 8. The change in rules (SIMPLICITY's measure)

All reasoned; nothing below was modelled. The base has 416 (SIMPLICITY 0).

| Change | Rules | Note |
|---|---|---|
| `depth` in place of `{ before }` | −1, +1 | the text rule and its escape go; `depth` is checked at founding and open |
| `get` on a miss holds nothing; no prefix follow | −2 | the hidden follow with its drop order; the walk of partition names |
| streams read through their handle; the net | +2 | rule 4; an unsubscribe safe at any time and twice |
| shared streams by key, counted | 0 | API:462 already states it for `follow` |
| a method on a path; `near` goes | −1, +1 | the learned hint; `ctx.at` |
| `tap((changes, now))` | −1 | in data: the mode from source text |
| `{ after: e }` public | 0 | E-30's 5 exist |
| `history()` | +3, in a reader | none on the write path |
| named views through `SUB` | 0 new, **debt** | already the design (PATHS 4.5); its rules were never counted: likely +4 to +6 when modelled |
| **the first step, net** | **about −3 to +3**, plus the reader's 3 | |
| later: a row selector | +2 to +3 | E-31 again |
| not taken: operators made up by clients | +5 to +8 | plus the view selector's debt |

**For the user**, the count that matters is what must be held in the head: four rules (section 3.1), in place of `follow`, `open`, `hold`'s three modes, `near`, `{ before }`, and the two meanings of `tap`.

---

## 9. Risks

1. **Two-level stores in data are a real rewrite** (D3). Until it lands, depth 2 can be faked with a joined key and PA-17's index, at today's `{ before }` cost. The API would be the same; the wire key would not, so the wire shape should be chosen first.
2. **"The wire sends whole partitions" may be too coarse** for large partitions read one row at a time. The row selector is priced (section 4.3) but not modelled.
3. **Refusing operators left of `connect()` may feel like the lens with its best part cut.** It is the part with the hidden costs. The named view covers it, but each one must be written on the server first.
4. **The named view is the least proven piece.** Its selector is in DV5 but not in E-31's model: no resume, failover or slot move was checked for it.
5. **Rule 4 changes what `f.rows` means** on a process that holds part: it shows what was held on purpose, not what happens to be in memory. That is a second read path to explain (`live.rows` and `f.rows`).
6. **A default that holds nothing changes every v4 example's first lines.** `shop.rows.widgets` after a bare `fero('shop')` would throw `not-held` until a `connect`. The tour's ten lines gain one.
7. **The net can hide a missing `close()`** in development, where collections are frequent, and then cost a server for minutes in production (section 1.4's last row). The dev warning is the guard; it must name the path.
8. **A `fn` that closes over its target** still pins it. No tool here can see that.
9. **Pair keys** for a view over every row of a depth-2 resource are undecided.
10. **`{ after: e }` by hand** can write a wrong mark.

---

## 10. What must be measured to know it works

| # | Measure | It decides |
|---|---|---|
| M1 | a two-level store against a flat store with PA-17's index: memory per partition, a fold's cost, a room's first picture, at 1e3 to 1e6 rows and 1 to 10,000 rows a partition | D3; whether depth 2 costs a write anything |
| M2 | K path subscriptions through a keyed index inside data (not beside it, as here) at K = 1 to 100,000 | D1 |
| M3 | `at()` against the dot, built once and built per use; heap kept per key after D2 | PA-31 closed or not |
| M4 | a named view through `SUB`: E-31's model with a `view` selector: resume, failover, a slot move, a shared view's last reader | whether "left of `connect()`" is safe |
| M5 | a named view served to 1, 100, 10,000 clients: server CPU per change, against v4's 4.4 to 4.6 µs per subscriber | that sharing holds |
| M6 | finalizer timing in a browser and in an edge worker (here: Node 22 only) | how long the net can leave a stream open there |
| M7 | a sim monitor: end a dropped stream at a random step; no result changes | rule 4 |
| M8 | a row selector: server CPU per record with 0, 1, 1,000 row readers on a partition; E-31 again | the second step |
| M9 | a call on a path against `near` and against no hint: trips and p99, three and five servers | section 5.5.5 |
| M10 | `tap((changes, now))` in data against today's two modes | D4; the 0.017 µs figure in place |
| M11 | E-54's tables, when filled: reverse records and fat nodes at 1e5 and 1e6 rows | section 5.4's numbers |
| M12 | the type check of the lens with depth 2, and with the door (no `set` on a typed client) | the declarations |

---

## 11. What was run here

Folder: ./cost-bench/. Node v22.22.0. The data tree is E-50's scratch copy (data 63fea66), as in the brief.

| Script | What it does | Output |
|---|---|---|
| `fin-time.mjs <idle or alloc or old-idle or old-alloc>` | registers 1,000 objects with a `FinalizationRegistry`, drops them, and counts callbacks at 0.1, 1, 5, 15 and 30 s with no forced collection; "old" objects first live through two forced collections; "alloc" makes about 100 KB of garbage every 10 ms. Not a CPU timing: the four ran side by side, outside the `timing` lock | `fin-time.jsonl` |
| `path-fan.mjs` | K child path subscriptions on one data source against one sink with a `Map`, under the `timing` lock | `path-fan.jsonl` |
| `types/` | TypeScript 6.0.2, `verbatimModuleSyntax` on, against `fero.d.ts` cut from API.md lines 639 on and data's `types/public.d.ts`: `client-type.ts` (`import type { shop }`), `client-alias.ts` (`import type { Shop }`), `client-alias-plain.ts` (the plain import of the type is an error), `lens.d.ts` and `lens-use.ts` (the lens of section 3 types: typed paths, a wrong field and a wrong target property are errors, `d.set` is the verb and `d.at('set')` the row). Exit 0 | printed "tsc=0" |
| `types/rt/` | Node's type stripping on three clients of a server file that prints when it runs: `import type { Shop }` (the server did not run), `import { Shop }` (a link error, the server did not run), `import { shop }` (the server ran) | printed in section 5.3 |

Raw lines:

```
fin-time idle      registerNs 198  firstMs 16156  fired by 0.1/1/5/15/30 s: 0/0/0/0/999
fin-time alloc     registerNs 222  firstMs 1343   fired: 0/0/999/999/999
fin-time old-idle  registerNs 287  firstMs 8055   fired: 0/0/0/999/999
fin-time old-alloc registerNs 304  firstMs none   fired: 0/0/0/0/0
path-fan  ns per write, K = 0/10/100/1000/10000:  path 1715/2037/4179/23098/356437   router 1973/2028/2123/2219/2459
```

**Not checked here.** No web page was fetched. Kafka's and NATS's behaviour is from the brief's memory. Nothing in sections 3 to 5 was built; the type check covers shapes only, and `lens.d.ts` is a sketch (it has no `depth`, and its `Live` has one operator).
