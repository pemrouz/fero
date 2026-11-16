# fero v5's API: a tour for review

Written 2026-11-16, for the owner. It walks through [API.md](API.md), which was rewritten the same day for the chosen design ([DECISIONS V5-1 to V5-11](../DECISIONS.md)). Read this first; API.md is the full reference.

**What you asked for.** An API that is easier to guess, without hurting speed: no hidden copies, trips, decodes or whole-resource work. And, where the old page was only explained badly, a better explanation in place of a change.

**How this pass was made.** Three drafts were written from three angles: keep v4 where it works, guess first, and show the cost. This tour takes the best answer to each question from whichever draft had it. Then a skeptic read the result against its sources and against the type checker, and made 31 findings. All 31 are applied. Some of them are choices only you can make; those are questions 1 and 6 to 12 in section 5.

**What is sure.** Every code block in API.md compiles (TypeScript 6.0.2), and 34 lines that must not compile do not. Nothing is built. The costs are [PATHS.md](PATHS.md)'s and the experiments'. Things marked **new** were not in the earlier API.md and no experiment ran them.

**Two words.** A **trip** is one message there and its answer back. A **commit** is the moment a write is on disk on most of the copies; only then can anyone see it (V5-5).

## 1. The shape, in ten lines that do something real

```ts
// server.ts
import { fero, op } from 'fero'
export const shop = await fero('shop', {
  data: { widgets: { stock: 10, price: 5 } },                                             // the first rows
  methods: { sell: (sku: string, ctx) => ctx.set([sku, 'stock'], op.incr(-1, { min: 0 })) },
})

// client.ts
const client = await fero<typeof shop>('shop')          // only the name: a client. Back when it has the rows
console.log(client.rows.widgets?.stock)                 // 10. Read here: one lookup
const low = client.data.lt('stock', 5)                  // a live view
low.tap(() => console.log('low on', low.snapshot()))    // runs when its answer changes
const sold = await client.methods.sell('widgets')       // a change, through the door. Back when it is on disk
console.log(sold.value)                                 // 9
```

**Three places, one job each.**
- `rows` reads.
- `data` changes and watches. An assignment is a write. An operator is a live view.
- `methods` holds your own functions, and nothing else.

**Three rules.**
1. **A read with no `await` never leaves this process.** No trip. It never guesses: if this process does not hold the row, it says so.
2. **Changes are requests.** A change is sent whether you `await` it or not. It shows, to you and to everyone, when it has committed. Nothing shows early. A refused change never shows.
3. **Awaiting a change means committed.** `await shop.set(…)` and `await shop.methods.sell(…)` come back at the commit. (A write's handle also has two earlier progress reports, for the few who want them: 2.4.)

## 2. The choices that matter most

Each one says what it looks like now, what it looked like before, why it is easier, and what it costs.

### 2.1 You can tell where a line runs

- **Now.**
  - A read with no `await` runs here (`shop.rows.k`, a view). It never leaves this process.
  - Anything that changes data or opens a stream sends a message, awaited or not: an assignment, `shop.set`, a method, `follow`, `changes`. `await` only chooses when you hear back.
  - A read you `await` (`shop.get`) runs here if the row is held, and makes one trip if not.
- **Before.** v4 and the earlier API.md had the same calls, but no rule that tied them together.
- **Why easier.** You can tell most costs from the line.
- **Where the rule fails, so learn these two.** A bare `fero('shop')` holds the whole resource: it downloads it once, and then receives every write to it (2.8). And v4's `shop.snapshot` has no brackets, but walks every row (2.2).
- **Cost.** None. It is a way to read the API.

### 2.2 `rows`: reading a row is one lookup (new)

- **Now.** `shop.rows.widgets?.stock`. `shop.rows` is a read-only view of the rows this process holds. A row you took is frozen. A key that names no row reads `undefined`. Printing or listing `shop.rows` walks every row, and you can see that you asked for it.
- **`shop.snapshot` stays what v4 made it:** a whole picture, built on each access, that stands still. Every v4 line keeps its result and its cost. New code reads a row through `rows`.
- **Before.** v4: `shop.snapshot.widgets.stock`, where `snapshot` built a new copy of every row on every access. The earlier API.md used the same line and called it "a property read".
- **Why easier.** "snapshot" says "a copy", and now every `snapshot` in fero is one. "rows" says "the rows, now".
- **Cost.** It removes a cost, for code that uses it. v4's read was 87 µs at 1,000 rows and half a second at a million (PATHS PA-8, measured). `rows.k` is a `Map` read plus one trap: 43 ns to about 1 µs for the `Map` read. The first read of a row after it was written also freezes it, once.
- **What the skeptic changed.** The first draft made `snapshot` a second name for the live `rows`. That is question 1.

### 2.3 Verbs on the resource; `methods` holds only yours

- **Now.** `shop.set(key, row)`, `shop.get(key)`, `shop.remove(key)`. And one sentence: **assignment is `set` without the answer.** `shop.data.k = row` and `shop.set('k', row)` are the same write; the second one tells you how it went.
- **Before.** v4: `shop.methods.update(change, { confirm })`, `methods.insert`, `methods.remove`, `methods.read`, built in. The earlier API.md already had `set`, `get` and `remove`.
- **Why easier.** `methods` is now only what you declared, so a method you name `update` clashes with nothing.
- **v4's lens calls stay, and now answer.** `shop.data.set('k', row)` returns the same handle as `shop.set('k', row)`. In the first draft it returned nothing, so `await shop.data.set(…)` came back at once: one word meant two things.
- **One oddity is still here.** On a resource with `methods`, a client still has `shop.set`, and it is refused `methods-only` when it runs, as v4's built-in `methods.update` was. Question 10 asks whether the types should take it away.
- **Cost.** None. It is the same record on the same path.

### 2.4 What a write gives back: one handle, three moments

- **Now.**
  ```ts
  const w = clicks.set(id, row)   // the write leaves
  await w.received                // the leader has it          0.15 ms
  await w.replicated              // most copies have it        0.36 ms
  const ack = await w             // committed, on disk         0.97 ms
  ```
  `await w` is always the commit. Code that never reads further is always safe. The two early moments are progress reports for your own write. Nobody else sees the write before it commits, not even your own sync read.
- **Before.** v4: `{ confirm: 'committed' | 'replicated' | 'persisted' }` per write. The earlier API.md: one answer at the commit, no choice.
- **Why easier.** In v4 the option changed how far the write had to get. Now every write goes all the way, and you only choose when to stop waiting. v4's words would also mislead: v4's `committed` was its weakest answer, and here it is the strongest. So the option is gone, on purpose.
- **Only plain writes have early moments.** A write the leader can refuse answers at the commit only: an op, a condition, a field write, a batch, a method call, and a write with a `once` name (the name may be taken). The types enforce it.
- **Two rules for the early moments.** A moment the write never reached rejects with the write's own error, so nothing waits for ever. And once a moment has resolved, the write never ends in a refusal (V5-11).
- **Cost.** None unless used. A promise is made only for what you await, and the servers send a report only for a write that asked. (Times: TypeScript, one box, median; MEMORY 9.3.)

### 2.5 Sending writes together is the default, a few hundred at a time

- **Now.**
  ```ts
  await Promise.all(rows.map((r) => temps.set(r.id, r)))   // about 1 ms for 16
  for (const r of rows) await temps.set(r.id, r)           // about 15.5 ms for 16: the one slow shape
  for (let i = 0; i < rows.length; i += 256)               // a bulk load: 256 at a time
    await Promise.all(rows.slice(i, i + 256).map((r) => temps.set(r.id, r)))
  ```
  Writes made in the same turn leave in one frame, share disk syncs, and keep their order within a partition. `batch` is for something else: several changes to one partition, all or none.
- **There is a limit.** A client holds at most 512 waiting writes, or 64 MB. Past that, `set` returns a handle that rejects `backpressure`, and an assignment throws `backpressure`. So a load of thousands of rows goes in chunks.
- **Before.** v4 batched frames the same way but never said so. The earlier API.md's `batch` read as "for speed". The first draft of this pass said "do not `await` inside a loop" and showed a bare loop of assignments as "fast too"; past the limit that loop would have dropped writes with only a line on stderr.
- **Why easier.** One rule to remember: make writes together, a few hundred at a time.
- **Cost.** This is the cheap path. It is how a write gets down to one share of one disk sync (PATHS 3.6).

### 2.6 Read, decide, write: three safe forms (one is new)

- **Now.**
  ```ts
  await shop.set(['widgets', 'stock'], op.incr(-1, { min: 0 }))                 // the leader computes it
  await shop.set('gizmos', row, { if: { absent: true } })                       // the leader checks it
  await shop.set('widgets', (w) => w && { ...w, price: 12 })                    // new: read, decide, write, retried
  ```
- **Before.** v4: read, then write, and the last writer won. Its own example 17 loses an increment. The earlier API.md had the op and the `if`, and four lines by hand for the third.
- **Why easier.** The short thing to write used to be the unsafe one. On the prototype, a plain read then a plain set sold the last item twice in 120 of 120 races ([E-22](experiments/E22-api-prototype/README.md)). `set(key, fn)` makes the safe form the short form. It looks like React's `setState(fn)`.
- **Unlike `setState`, it can give up.** After 8 tries it ends in `conflict`. Each retry first waits until this process has seen the write that beat it, so the tries are not wasted on the same old row.
- **Cost.** An op or a condition costs the same as a plain write. `set(key, fn)` is one conditional write per try; your function may run again if another write got there first.

### 2.7 Methods: the door, with small helpers

- **Now.** `methods:` closes the door, as in v4: clients change data only through them. On top:
  - **`{ once: 'order-981' }`** on a call: it runs at most once, and a retry from any process gets the first result.
  - **`{ retry: true }`** stays from v4: "this handler is safe to run twice, so send the call again if its server is lost". It costs nothing extra.
  - **`{ near: true, run }`** (new): "this method is about the row named by its argument". The call then goes straight to that row's leader.
  - **`fero<typeof shop>('shop')`** (new): a client typed from the server's exported handle, rows and methods in one go.
- **Before.** v4: `{ retry: true }`; no placement; types by hand. The earlier API.md: `key` on a call and `id` on a write (two words for one idea); "there is no `at: 'writer'`".
- **Why easier.** `once` says what you want. `near` is honest about what it is: placement for speed. The safety rule does not move: **a method is not a transaction, so a check-then-set must be one of 2.6's three forms.**
- **A fault the skeptic found in the types.** `fero<Item>('shop', { methods })` compiled, and left the methods untyped. So `fero<typeof shop>` accepted any method name, in both of the page's own examples. Now that line does not compile. On the server, the seed gives the row type, or you write `fero.of<Item>()('shop', { methods })` (new).
- **Cost.**
  - A plain call is one trip, plus one more for each write its server does not lead: about 2 writes in 3 with three servers.
  - With `near` it is one trip and one commit, the least a call can cost (PATHS PA-25).
  - A call with `once` is three commits in a row, and up to two more trips: its claim is a row of fero's own `#calls` resource, which has leaders of its own. `near` does not save those. Use `once` only where a second run would hurt.
  - A write with `once` costs one commit, plus about 221 B for a day.

### 2.8 `hold`: say how much a client keeps (new name)

- **Now.** `fero('users')` holds every row, as in v4. `fero('users', { hold: 'asked' })` holds only what it reads or follows. `{ hold: '200MB' }` is the same inside a bound. A sync read of a row not held throws `not-held`, and its hint names the call: "await users.get('u7') or users.follow('u7')".
- **Before.** v4: `replicas: N` and `ScopedError`, with `await f.data` gathering from every member. The earlier API.md: `cache: { memory: '200MB' }`, and two codes, `shortfall` and `holistic`.
- **Why easier.** The old key was a memory size that also, without saying so, changed the client from "everything" to "only what I touch". `hold` names the choice. One error code with a hint beats two names that said nothing.
- **Cost, stated more fully after the skeptic's pass.**
  - `hold: 'all'`: the open downloads the whole resource once, **and then every write anyone makes to it is sent here.** So a job that only writes says `hold: 'asked'`; the patterns now do.
  - A `get` of a row not held is one trip. It brings **the row's partition** and keeps it live. With each row its own partition, that is one row. With a room as the partition, it is the room.
  - `hold: 'asked'` with no size never drops anything. Give a size, or read once with `get(key, { hold: false })` (new), which keeps nothing.
  - A process that holds only part never gives a partial answer: listing `rows`, or a view over every row, throws `not-held` there.

### 2.9 Staying up to date: `tap`, `follow`, `changes`

- **Now.** Three tools, one table:

  | You write | You get | A slow reader |
  |---|---|---|
  | `view.tap(fn)` | "the answer changed" | sees the newest state |
  | `chat.follow('room1')` | one part of the resource, kept live: rows | sees the newest state |
  | `orders.changes({ from })` | every record, one by one, from a position | waits; nothing is skipped |

- **Before.** v4 had `tap` and views. The earlier API.md had all three, in three sections, and called the last one `read`.
- **Why easier.** `read` sounded like reading a row. `changes` says what you get. A saved cursor is plain text and goes back in as it is (the earlier page needed `fero.cursor(text)`).
- **Three things now said plainly.**
  - `changes()` starts "from now on", and **"now" is the call**, not the first turn of the loop. A write you make after the call is always seen.
  - Follows of the same selection in one process share one subscription. A thousand sockets in one room cost one, not a thousand.
  - `tap` fires once when it is added, with the picture so far, then once per change, as in v4.
- **Cost.** None new. A reconnect sends only what was missed; v4 downloads everything again.

### 2.10 Derived resources: the slow way cannot be written (new)

- **Now.** `derive(orders, totals, (e, out) => { if (e.value) out.set(e.value.user, op.incr(e.value.cents)) })`. `out`'s writes return nothing. Each output carries a mark of the source record it came from, so each source record counts exactly once across any restart.
- **Before.** v4 had no such call. The earlier API.md's `out.set` returned a promise.
- **Why easier.** Nothing to await, so nothing to get wrong.
- **What commits together.** One source record's outputs to one partition commit together. Its outputs to different partitions commit one by one, so a reader may see some before the rest. Each still counts once.
- **`e.value` is what the record wrote**, when it wrote a whole row. It was called `e.row`, which sounded like "the row now". A field write has no `e.value`, so the line above counts an order only when it is written whole.
- **Cost.** It removes a trap: a loop that awaits each output runs at about 250 source records a second (PATHS 4.9). And when the file runs on three servers, the source is still read once: the three split it.

### 2.11 A resource is its own small cluster

- **Now.** Run the same server file three times and you have a cluster of three, as in v4. The role is per resource: one process can serve `totals` and be a client of `orders`. A resource's settings live in its own log; a later open that disagrees is refused `config-differs`, and the hint names the key and the `fero.alter` call that changes it. `fero.alter` needs the admin key.
- **Before.** v4 was like this. The earlier API.md was not: one cluster per project, a catalog, `#meta`, `fero.alter('#meta', …)`, a limit on resources.
- **Why easier.** There is no project level to learn. It also makes the surface smaller: `#meta`, the cluster keys, `too-many-resources` and `meta-down` are all gone.
- **Cost, stated plainly.**
  - A resource is not free: about 8 KB per server while idle and a few milliseconds to found (V5-8, E-49). So **a resource is a table, not a row.** `fero('doc:' + id)` is out; use one `docs` resource with a row or a partition per document.
  - **A server role is real work.** A process that says `server: true` copies the whole log, keeps a disk, and votes. So that line belongs in a server file, not in app code that runs twenty times. The patterns are now split that way. Question 7 asks whether creating a resource should need that line at all.

### 2.12 Partitions: the row, a prefix, or a function

- **Now.** By default each row is its own partition. `partition: { before: '/' }` reads aloud: "the partition is the key before the first slash", so `room1/m7` and `room1/m8` are ordered together. A function of the key also works (V5-2).
- **Before.** v4 hashed partitions and hid them. The earlier API.md allowed only the prefix.
- **Why easier.** One idea ("rows that are ordered together"), one default that is right for most resources.
- **Cost.**
  - Each row as its own partition costs nothing.
  - A prefix or a function costs an index on every copy, from each partition to its rows (PATHS PA-17). Without it, a room's first picture would scan every row.
  - A function costs more again: every server must pass the same one, and a process without it (a browser) pays one more trip per write. So prefer the prefix.
  - Following by `{ prefix }` walks the partition names for its first picture. Following one partition by name is the cheap form.

### 2.13 Errors: one class, sorted by what to do

- **Now.** Every failure is a `FeroError` with a `code`, an `outcome` and a `hint`. `outcome` answers one question: did it commit? `refused`: no, and it never will. `unknown`: maybe; fero keeps trying. The codes are listed by what to do: fix the call, branch on it, slow down, or check later. A hint names the next call to make.
- **Before.** v4: `WriteReject { reached, reason }`, and `ScopedError`. The earlier API.md: the same one class, shown as one table of 45 rows.
- **Why easier.** Four things to do in place of 45 codes to learn. `e.reason` still prints what it printed in v4.
- **Cost.** None.

### 2.14 Small names

Each is a rename only. None touches the wire.

| Earlier API.md | Now | Why |
|---|---|---|
| `if: { fence: l.fence }` | `if: { lock: l }`, and `lock(name, fn)` | "fence" is the mechanism's word |
| `group(orders, 'billing')` | `consumer(orders, 'billing')` | `group` is already data's operator and a Raft word |
| `copies`, and `standbys` that counted the voters too | `copies` (they vote), `standbys` (more copies that do not) | the old `standbys` was hard to explain |
| `seeds` (the founders), `hosts` | no founders list; `rendezvous` takes a list of directory addresses across machines | V5-3; v4 already has the key |
| a cron job named by `once` | `add(job, { cron, key: 'daily-report' })` | a `once` name lasts a day; a schedule lasts as long as its row |
| "writer" | "leader" | one word for one thing |

## 3. What every call costs, on one card

| Call | Trips | Commits | Whole-resource work |
|---|---|---|---|
| `f.rows.k` | 0 | 0 | none |
| a view, per change | 0 | 0 | none |
| a write (assignment, `set`, `remove`) | 1 | 1, shared | none |
| a write with `once` | 1 | 1 | none; about 221 B for a day |
| N writes made together | 1 frame per leader | shared | none. At most 512 waiting, or 64 MB; then `backpressure` |
| a method call | 1, +1 per write its server does not lead; 1 with `near` | 1 or more | none |
| a call with `once` | 1, plus up to 2 to `#calls`' leader | 3 in a row | none |
| `get`, held / not held / `fresh` | 0 / 1 / 1 plus the leader's check | 0 | not held: the row's partition once, then its changes while it is held |
| `get(k, { hold: false })`, not held | 1, each time | 0 | none |
| `follow`, `changes` | 1 to open | 0 | what you selected |
| a `{ before }` or function partition rule | | | an index on every copy |
| opening a client with `hold: 'all'` | 2 to 3 | 1 | **the whole resource, once; then every write to it** |
| opening with a server role | | | **the whole log, a disk, a vote** |
| listing `f.rows`, `f.data.snapshot()`, v4's `f.snapshot` | 0 | 0 | **every held row** |
| a saga | | 6 to 7 in a row | none |
| a queue message; a `service` ask | | 3 | none |

A write's own path is 2 trips and 1 disk sync, which is the least any correct design can do (PATHS 0). API.md section 4 has the full card with sources.

## 4. Explained badly before, and the same now

These did not change. They only get a plainer sentence.

1. **Assignment and `set`.** "Assignment is `set` without the answer."
2. **Roles.** "A process that brings something serves. A process that only names the resource is a client."
3. **The options.** Ask of each: who remembers it? This process, the resource, or this open.
4. **"A rung per resource, never per write", and then answers per call.** Two different things. Every write commits the same way: on disk at a majority. A stage is only how far your own write has got when you hear back. The word "rung" is gone from the app's page.
5. **`fresh`.** "A local read can be a moment behind another process's write. `fresh` asks the leader." Most apps never need it.
6. **`outcome`.** "Did it commit?" Most apps only log it.
7. **Versions and cursors.** A version is a row's place in its partition's order. A cursor is a bookmark. Both are text you pass back.
8. **"A check-then-set must carry a condition or be an op."** It read like a trap. It is the price of one honest change: one leader judges every write on the newest state, so your read is a copy that can be old. And it is why counters and stock are now correct.
9. **`batch`.** Not "for speed". It means "all or none".
10. **Twelve words at one level.** An app needs five: resource, row, method, view, partition. Slots, groups, attempts and sessions are plumbing; they show only in `f.cluster`.
11. **`data` and `rows`.** "Read through `rows`; write and derive through `data`." `f.data.k` is a handle, not a value; that was true in v4 and never said in one line.

## 5. Questions for you

Each has a recommendation. Questions 1 to 5 are where the three drafts disagreed. Questions 6 to 12 came from the skeptic's pass, or were reopened by it: they are the decisions this page most needs from you. Questions 15 and 16 are gaps in the design's records.

1. **`rows` for reads. What should `snapshot` be?**
   **Recommended: `snapshot` keeps v4's meaning**, a whole picture per access, at v4's cost; new code reads through `rows`. Then every `snapshot` in fero is a picture, no v4 line changes its result, and about 20 example READMEs stay true.
   The other way: `snapshot` becomes a second name for the live `rows`. Old lines get fast for free. But one word then means two things, and a kept `shop.snapshot` reads differently after an `await`.

2. **Verbs on the resource (`shop.set`) or on `data` (`shop.data.set`)?**
   **Recommended: on the resource.** It is shorter, and no row name can collide with a verb. (Speed is not a reason; the skeptic checked.) v4's lens calls keep working and return the same handle.

3. **`near` on a method: now, or after the first build is timed?**
   **Recommended: now, spelled `near`.** Methods are the door, so this is the main write path of a protected resource, and without the hint it pays an extra trip on about 2 calls in 3. It is plain data and no kernel rule.

4. **`set(key, fn)`: add it?**
   **Recommended: yes.** It costs nothing unless called, and it turns the unsafe short form into a safe one. Two risks, both stated in the docs: a function that is not pure and runs twice; and it gives up with `conflict` after 8 tries.

5. **`changes`, `log` or `read`?**
   **Recommended: `changes`.** `shop.log(…)` looks like a logger. `changes` is also `data`'s own word for what comes out.

6. **What should a write do when the client is full** (512 waiting writes, or 64 MB)?
   **Recommended: `set`'s handle rejects `backpressure`, and an assignment throws `backpressure`.** An assignment has no handle, so a throw is the only way the code can know. The other way, one line on stderr, loses writes without telling the code.

7. **Must some process say `server: true` to create a resource?**
   **Recommended: yes, as v4.** One file run three times is a cluster, with no ceremony. The cost is a trap: put that line in app code and every app process becomes a server. The docs and the patterns now keep it in a server file.
   The other way: an admin act (`fero create shop`) founds the resource on the project's server machines, and no app file ever says `server: true`. Safer, and one more step before the first line works.

8. **A client's default `hold`: `'all'` or `'asked'`?**
   **Recommended: `'all'`, as v4, but this is the closest call.** It keeps the ten lines above and the examples true: a sync read and a view work at once. Against it: a bare `fero(name)` in a job downloads the resource and then receives every write to it, and nothing in the line says so. With `'asked'` as the default, the ten lines would need `hold: 'all'` written out, and every cost would show.

9. **A `get` that misses: follow for good, or read once?**
   **Recommended: it follows, and `get(key, { hold: false })` reads once.** Following saves a trip for a reader that comes back. But with `hold: 'asked'` and no size it keeps every key ever read, so the one-shot form is needed.

10. **Should the typed client of a resource with methods have no `set`, `remove`, `batch` or `touch`?**
    **Recommended: yes.** Then the door shows when the code is compiled, and it costs nothing when it runs. It is not in the declarations yet. Untyped code would still be refused `methods-only` when it runs.

11. **`{ retry: true }` on a call: keep v4's cheap resend?**
    **Recommended: yes, beside `once`.** They mean different things. Without `retry`, a call that is safe to run twice pays `once`'s three commits, or the app writes its own retry.

12. **A write with a `once` name has no early moments.**
    **Recommended: accept it.** Its name may be taken, so it can be refused, and V5-11 forbids an early answer before a refusal. The cost: a named write always waits for its commit.

13. **The partition function: in the first build?**
    **Recommended: in the API (V5-2 names it), built after the prefix.** The prefix covers all 22 patterns.

14. **The small names**, in one line: `once`, `not-held`, `hold`, `consumer`, `if: { lock }`, `copies` and `standbys`, `fero.of<Row>()`, `e.value`, a queue's `key`, `ping.ms`, `rendezvous` as a list, `handback.max`, `bulk.rate`.
    **Recommended: as written.** Any of them can be renamed; each is a one-word change.

15. **One gap in V5-11, for a ruling.** "An early answer is never followed by a refusal." After a leader change a resent plain write is judged again. By then three things may have changed.
    **Recommended:** through a closed write gate or a full disk, fero keeps retrying, so the handle ends at the commit, a `timeout` or `unknown`. A revoked token is the one exception: the handle ends `forbidden`, because retrying cannot clear it and `unknown` would be false.

16. **Who serves fero's own resources** (sessions, locks, sagas, calls, a queue), now that there is no project level?
    **Recommended:** any process that serves a resource also serves the system ones; a library's resource takes `server: true` like any other. `session.ms` is then a setting of `#sessions`, set like any config key. [LAYERS.md](LAYERS.md) section 10 item 5 owns the answer; no call changes with it.

**Stated in this pass from reasoning; say if any is wrong.** No experiment ran these, and API.md marks each one.
- `await fero(name)` on a client that holds everything comes back once the rows have arrived. With no server up, it comes back after `connect.wait`, and a sync read throws `not-held` until the rows come (v4 printed `{}`).
- "Now", for `changes()`, is the call.
- Follows of the same selection share one subscription.
- A `derive` run on several servers does the work once. API.md reads it as derivers splitting the source, as consumers do; LAYERS reads it as the target's leader doing it alone. Both are open (API.md Q-B8).
- With two servers the second does not vote. A server past `copies + standbys` (5) is a spare that holds no copy until healing gives it one.

**Follow-ups this pass leaves for other files.**
- [LAYERS.md](LAYERS.md) now agrees with API.md on the handle's members, `rendezvous`, `once`, what two servers hold, `session.ms` and dropping `stale-plan`. Two points stay open between them: who runs a `derive` (one leader, or derivers that split the source), and the word `busy`, which DESIGN-V5 also uses for an answer between servers. API.md section 11.2 lists both.
- The examples ladder changes its lesson on rungs 03, 04, 08, 10, 12, 13, 16 and 17 (API.md section 5.1).
- Owed tests: `console.log(f.rows)` prints the rows (a bare `Proxy` would print `{}`); two pins on `f.rows.k`, one for a row already read and one for a row just written.
