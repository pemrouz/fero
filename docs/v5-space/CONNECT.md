# One connect: the owner's idea, explored

Written 2026-11-20. Docs only; nothing here is built. It answers the owner's message of 2026-11-20 about one `connect` with options (summed up in section 1), which asked for a broad look and whether the idea is better. "Better" here means better than [READS.md](READS.md), the latest recommendation for how code gets data (2026-11-19), which the owner has not decided yet. **The short answer is: partly.** The owner's `connect` is better for live state, and the owner's positions are better than anything READS.md had. Folding the log and the past into `connect` as options is worse in our judgement: both judges said so, and the types can refuse it. That part is not a measurement. E-56 measured how far one word moves a loop, not which shape is better. Section 0 says in what.

**How it was made.** Three designers each proposed a read surface from the owner's message. P1 took the owner's `connect` whole: one verb whose options pick live state, the log or the past. P2 used two read verbs, `get` and `connect`, with positions first. P3 looked first at what other systems learned, then shaped the owner's ideas around that. Each wrote all 23 scenarios and type-checked them. Two judges, each working alone, scored the three, READS.md's pick and today's [API.md](API.md) out of 50. Both picked P3: 41 and 42, against 36 and 35.5 for READS.md's pick. This page is P3 with the parts the judges named from the others, checked again (section 11). The new measurements are [E-56](experiments/E56-one-connect/README.md). The proposals and the judges' notes are working files, not kept in the repo; section 7 says what came from each.

**Words.** A **lens** is an address, such as `shop.data.widgets.stock`: building one does no work. The **key step** `f.at(key)` builds a lens from a key that comes from input (API.md 3.9); on this page "at" never means a time. A **link** is one live connection from a lens into this process. The **picture** is the rows so far, which a link gets first; then it gets each **commit**: one leader's batch of writes, cut down to the rows the link reads. A **partition** is the rows one leader keeps in one order: at depth 1 each row is its own, at depth 2 a room is one. A **record** is one change to one row. To **fold** is to apply records to rows to get the state they make. **Live state** is the newest rows, folded: a slow reader skips to the newest. The **log** is every record, in order: it waits for a slow reader. A **version** is a record's place in its partition's log; a commit's id is the version of its last record there. A **cursor** is a reader's place, one position per slot it reads. A **slot** is one of a resource's 4,096 fixed hash buckets; apps never see them. A **group** is the set of servers that runs some slots with one leader; a **slot move** hands a slot from one group to another. **Writer time** is the time a leader stamps on each batch (V5-4). **History** is how much log a resource keeps (the default is 0). A **trip** is one message and its answer, about 40 µs on one box ([E-01](experiments/E01-floors)). A **SUB** is fero's subscribe message; a **GET** is a one-off read. **Held on purpose**: rows this process keeps because it serves the resource, said `hold: 'all'`, or has a live link on them. **The collector** is JavaScript's garbage collector. A **microtask** is a step JavaScript runs right after the current code. A **thenable** is an object with a `then` method; `await` treats it as a promise. A **Merkle tree** is a tree of hashes: each leaf hashes some rows, each inner node hashes its children, so two sides find where they differ by comparing hashes from the top down. A **rule** is one thing a builder of fero must get right ([SIMPLICITY](SIMPLICITY.md); the base has 416).

**More words, for later sections.** A **selection** is what one subscription brings into this process; equal lenses share one. A **frame** is one message on the wire, carrying one batch's records. A **snapshot** is a saved copy of a partition's rows at one place in the log; **compaction** drops log that a snapshot covers. A **tombstone** is a kept note that a row was removed. A **saga** is a change across partitions made of ordinary writes, one step at a time (V5-1). **Marks** are the places a reader such as `derive()` saved in its target's own log, so it can go on exactly once.

**Marks.** *(measured, source)*: a number from a named experiment; E-56's are three runs, each process alone under the box's timing lock, given as the range over the runs, all run again on 2026-11-20 after the box restarted (E-56 README, "When it ran"). *(checked)*: tsc 6.0.2 compiled it or refused it in section 11, or a probe ran it and its line is in E-56's `results/`. *(reasoned)*: an argument; nothing ran it. *(a guess)*: nobody measured it. *(from memory)*: an outside fact not checked here. The judges' scores are judgement, not measurement.

---

## 0. What to review

```ts
// file: combo.ts — how code gets data, on one screen
import { fero } from 'fero'; import { useEffect } from 'react'; import type { Shop, Msg, Part } from './server.js'
const shop = await fero<Shop>('shop'), chat = await fero<Msg, 2>('chat'), parts = await fero<Part>('parts')  // clients
const item = await shop.at(sku).get()                                              // ONCE: one GET, or none if held here
const link = shop.at(sku).connect((row, c) => draw(row, c.diff), { until: ws })    // LIVE: the picture, then each commit
for await (const [rows, c] of chat.at('room1').connect({ signal })) draw(rows, c.version)   // LIVE, as a loop: the newest
chat.at('room1').connect({ signal }).filter((m) => !m.hidden).connect(draw)       // left of connect(): a server's; right: here
const low = shop.data.low(5).connect(draw)                                         // a view the server named: an address
useEffect(() => shop.at(id).connect(draw).disconnect, [id])                         // ENDS: disconnect, signal, until, break
for await (const e of chat.at('room1').changes({ from: -5 })) save(e)              // THE LOG: every record from 5 commits back
for await (const e of chat.data.changes({ from: cursor })) save(e)                 // ... after a saved cursor, or a Date
for (const [row, c] of await parts.at('w1').past(version, { to: 'latest' })) draw(row, c.version)   // AS IT WAS: a value
const hot = await fero<Shop>('shop', { hold: 'all' }); hot.rows[k]                 // HOT: one lookup, every row held here
```

1. **Is it better than READS.md's pick? Partly, yes.** It is READS.md's pick with the owner's words and the owner's positions put in where the evidence allows.
   - **Better, on new ground:** one live verb, `connect`, ended by `disconnect`, the platform's word for ending a watch (READS has `live`, `on` and `close`); a `for await` loop over live state; a commit id inside one partition (`c.version`, such as `38S9`) and a place on every commit (`c.cursor`); `from: -5` and a `Date` on the log; a `past` that is a value you walk with `for…of`.
   - **The same, where READS was right:** live state and the log stay apart by verb, every link ends by your code, and the cost shows on the line.
   - **The judges:** both put it ahead, 41 and 42 of 50 against 36 and 35.5. On the six axes READS's own judges used, the two are within 1 point, so the gain is the new ground (section 7).
2. **Four verbs, named by what you get.** `get()` a value once. `connect()` the newest state, kept here: a handle, a callback (`connect(fn)`) or a loop. `changes()` every record from a place; it waits for you. `past()` one partition as it was: a value, nothing to end.
3. **What the owner's message gains, and what it does not.** Taken: one `connect` for live state (I1), state and diff in each call (I2), `disconnect()` with a lifetime option beside it, which does no damage given three rules (I3, I4), commit ids (I6), `-5` (I8), a loop (I12). Not taken as asked: `from`, `at` and `once` as options on `connect` (one word would turn a shared live link into a private log reader, with nothing else on the line to show it; *reasoned and judged*, and the types refuse it, *checked*); awaiting the connect (a thenable handle lost 1,000 of 1,000 links, *checked, E-56 probe 1*); `get` for the key step; Merkle trees (each partition has one leader and one order, so a position already says what is missing, and in E-56 a Merkle walk never beat a plain resume, *checked: exact bytes, E-56 positions*). Section 1 goes idea by idea.
4. **Positions in one sentence.** A version names a record, and so the commit that holds it; a cursor, a time and `-N` name a place. `from` starts at it, `past` reads right after it, `to` stops after it. A version and `-N` work inside one partition only, and the types refuse them wider.
5. **What changes.** Against READS.md's pick: `live` and `on` become `connect`, `close` becomes `disconnect`, `past` becomes a value inside one partition with `for…of` and `{ to }` (its `close` and `seek` go), the log gains `-N`, a `Date` and `to`, and every commit carries `cursor` (and `version` inside one partition). Against [V5-12](../DECISIONS.md)'s picks it changes the same picks READS's pick changes (1, 3, 5, 8 and 11, and the review rules on how a link ends), so each needs a new decision (section 8).
6. **The price.** "Replay the last 5 with state, then live" is two calls with a seam: a commit that lands between them shows inside the new picture, not as its own step (S18); READS's pick has the same seam. The builder pays about 0 to +16 rules over READS's pick *(reasoned)*, mostly for positions READS did not price, and users learn seven rules, one more than READS. Nothing runs yet: E-56 built `connect` on E-55's prototype, but not the log, the positions or `past` as a value.

---

## 1. The owner's ideas, one by one

On 2026-11-20 the owner asked whether one `connect` with several options would work better. In that idea, `connect` does the streaming, and each call gets the state and the diff of a commit. `disconnect` ends it, and the question was whether an option that also ties it to a lifetime does any harm. A `from` option would start at a given commit id, or at `-5` to replay the last five commits. The owner also asked how to identify a commit and what its id looks like, whether Merkle trees help with anything, whether a read once could be an awaited `connect` or an await without `connect`, whether `get` should replace `at` (to pair with `set`) and serve as a small way to await one value, which other options must compose, whether `connect` could also be an async iterable for `for await`, and whether `at` with a position could walk through versions from a cursor on `connect`, or read the version at that time on `get`. It ended by asking for a broad look and whether the idea is better.

The message uses "at" in two senses: the key step `f.at(key)` (I10) and a position in time (I13). They are kept apart below.

| # | Idea | Verdict | Why, and the evidence |
|---|---|---|---|
| I1 | one verb, `connect`, whose options choose what it streams | **adapt** | One `connect` for **live state**, in three forms: `connect()` (a handle), `connect(fn)` (a callback), and `for await` over `connect()` (a loop). It replaces today's `here`, `tap` and weak `connect`, and READS's `live` and `on`. Built on E-55's prototype, it passed E-55's seeded lifetime checks: 0 wrong over 73,789 links in 1,000 seeds *(checked, E-56 probe 4)*. The log and the past keep their own verbs, by judgement: with `from` on `connect`, one word would turn a shared link into a private reader that waits *(reasoned; both judges; the types refuse it, wrong.ts item 11)*. Section 2.4 gives E-56's numbers and why they do not settle it |
| I2 | each call gets the state and the diff of that commit | **adopt** | `connect((value, c) => …)`; a loop turn is `[value, c]`; a `past` step is `[value, c]` too. `c.diff` has one entry per changed row, each with `prev` and the row's `version`. `prev` costs 8.2-11.5 ns a change to read, since data has it from its fold *(measured, E-56 probe 3)*. A row is a new object at each write; a partition's value is one live object, so a React setter rendered 1 of 6 calls unless the code wraps it, `setView({ rows })` *(checked, E-56 probe 3)* |
| I3 | `disconnect()` ends it | **adopt** | Bound, so a framework effect can return it, and safe to call twice. A planted double release broke 28,137 checks, so the "safe twice" rule is load-bearing *(checked, E-56 probe 4)*. `disconnect` is the platform's word for ending a watch: the DOM observers pair `observe()` with `disconnect()`, and Web Audio nodes pair `connect()` with `disconnect()` *(from memory)*. So the end word is the platform's; the start word is Web Audio's |
| I4 | an option that ties the link to a lifetime, beside `disconnect()`, and whether having both does harm | **adopt: no damage, given three rules** | `{ signal }` (an `AbortSignal`) and `{ until: socket }` beside `disconnect()` and `break`. Every lifetime case passes, and taking away any one rule broke a case *(checked, E-56 probe 4)*. The rules: (1) every end is safe twice and removes the other ends' listeners; (2) `until` takes only a thing that can say it already closed, and never an HTTP request; (3) the first call comes a microtask after `connect()` returns. Section 2.3 says what broke without each. Keep `signal` and `until` as two names: `signal` is the platform's word |
| I5 | a `from` option that starts at a given commit id | **adapt** | `from` lives on `changes()`: every record from there, then live. A position is `past()`'s argument: the lens as it was. On `connect` the types refuse `from` and the message names both *(checked: wrong.ts item 11)*. A live link that started in the past would have to be a log reader until it caught up, which joins what evidence 5 keeps apart *(reasoned)*. A version starts **at** its commit (it comes again); a cursor starts **after** its place |
| I6 | how to identify a commit, and what its id looks like | **answered** | Two kinds, not three. Inside one partition a commit's id is a **version**, the version of its last record there: short text such as `38S9` (epoch 0, sequence 9,001) that keeps log order under plain `<` (0 wrong in 1,000,000 seeded pairs, *checked, E-56 positions*). It is the same text as `ack.version`, a diff entry's version and `if: { version }`, and it is new here as `c.version`. A whole resource has no single commit id, since partitions share no order (API.md:1674); its place is a **cursor** (section 3) |
| I7 | whether a Merkle tree helps | **reject, for now** | Every fero partition has one leader and one order, so every copy and every client holds a prefix of one log, and "how far did you get?" already says what is missing *(reasoned)*. That is the main reason. The costs agree: no Merkle way kept per write came under 0.2 µs in any run, the yardstick E-54 set for a version kept per write; the cheapest, leaf sums alone, cost +254 ns to +0.85 µs a write over a plain `Map`, or +243 ns to +0.60 µs over the per-row version store it needs *(measured, E-56 positions)*. For a resume after compaction, "rows newer than mine plus tombstones" was smallest in all 8 cases, in 1 trip; a Merkle walk sent 1.08 to 5.28 times the bytes in 3 to 5 trips *(checked: exact bytes, E-56 positions)*. Section 4 |
| I8 | `from: -5` replays from 5 commits ago | **adapt** | On `changes({ from: -5 })` and `past(-5)`, on a lens inside one partition: the 5th last commit that touched **this lens** (a room, a row in it, or a field), and all after. That is the unit a callback on the same lens sees. The server counts back, since versions have gaps; it needs the log kept (`history`), and past it the reader gets `expired`. On a wider lens a count has no single meaning, so the types refuse it and name a `Date` *(checked: wrong.ts item 16)*. A count is a negative literal: `5` is refused, and so is a value typed `number` (most often a time); a `const` that holds `-5` is fine *(checked: items 20, 21; scenarios.ts `minus5`)* |
| I9 | a read once is a subscription that ends after one: await the connect, or await without it | **adapt: await without the connect** | `await lens.get()`. The handle has no `then`. A thenable handle lost every link that passed through code that resolves values (an `async` return, `Promise.all`, a library that awaits anything with a `then`): 1,000 of 1,000 links left open with 0 handles to end them *(checked, E-56 probe 1)*. That is evidence 1 (a lens is never a promise) one level down. The types refuse `await lens.connect()` used as a row *(checked: wrong.ts items 2, 3)* |
| I10 | `get` in place of `at` for the key step, to pair with `set` | **reject** | `await shop.data.get(id)` reads like `Map.get`, but the step gives an address, and in plain JavaScript an address is always truthy, so the slip is silent *(checked for the types, E-56 probe 5)*. The type guard that catches the slip at the `await` (P1's) also lets a lens that went through `Promise.resolve` land in a row variable with no error *(checked by judge 1 on P1's declarations, not on this page)*. So `get` keeps one meaning, read, and `at(key)` keeps one meaning, the key step. A key passed to `get` is refused by the types *(checked: wrong.ts item 32)* and, in plain JavaScript, by the run time (`bad-arg`) *(reasoned)*. **The other reading, weighed:** `get(key)` as `Map.get`, a read of the child, sugar for `at(key).get()`. It has no truthy-address slip. But it adds one overload and a second way to say the same read, and the run time must choose by the number of arguments, since a key from input that is `undefined` must not turn `get(key)` into `get()`, a read of the whole partition *(reasoned; E-56 probe 5 notes the same trap for the step)*. Pick: not now; it can be added later without breaking any line |
| I11 | `get` as a small way to await one value | **adopt in meaning, as a GET** | `await lens.get()`: one GET, or no trip where the rows are held on purpose. Built as `connect({ once })` on a client it subscribed the whole partition: 65,671 B and 1,000 rows folded to read one number, against 1 B by a GET *(checked, E-56 probe 1)*. A subscription that ends after one exists as `get({ when })`: it waits until a test passes, then reads |
| I12 | the same `connect` as an async iterable, so `for await` works | **adopt, with the policy in the verb** | `for await (const [value, c] of lens.connect())` gets the newest state each turn, its diff merged since the last turn: 1-50 rows waiting with a loop 10 times slower than the writes *(measured, E-56 probe 2)*. `for await (const e of lens.changes())` gets every record. A loop costs +166 to +241 ns a commit over a callback when commits come in bursts and merge *(measured, E-56 probe 2)*. `break` ends the link. A handle made with a callback is not a loop, since one handle cannot get `break` right for both *(checked: E-56 probe 4; wrong.ts item 10)*. A loop turn has no `recs()` or `text()`: a merged turn's records would be whole rows made up per loop, not the wire records *(checked: wrong.ts item 42)* |
| I13 | a position: on `connect` it walks the versions from there; on `get` it reads the version at that time | **adapt: both go to `past(pos)`** | `(await lens.past(v)).value` is the row at that version; `for (const [value, c] of await lens.past(v, { to: 'latest' }))` walks every version since, each with its state and diff; `step(±n)` gives the state n commits back or forward, as a new value, or `undefined` at the window's edge. `get({ at })` is refused, because a past read loads a snapshot and folds the log (about 2.6 to 6.1 µs a record, *reasoned*), and `get` must stay one trip *(checked: wrong.ts items 13, 14)* |
| I14 | which other options must compose | **answered** | Section 2.2: `get` takes `fresh`, `when`, `version`, `signal`, `timeout`; `connect` takes `signal`, `until`; `changes` takes `from`, `to`, `credit`, `signal`, `until`; `past` takes `to`. Refused, each with a message that names the right line: `from`, `at` and `once` on `connect`, `at` on `get`, a version or `-N` on a lens wider than one partition, a bare number as a time, `past` wider than one partition, `recs()` and `text()` on a loop turn, and an HTTP request as `until` |

---

## 2. The surface

### 2.1 Each word, its one job, its cost

| Word | Its one job | What it costs |
|---|---|---|
| `lens.get()` | read once; hold nothing. `{ fresh }` asks the leader; `{ when }` waits until a test passes, then reads; `{ version: true }` gives the version too | held here: no trip; the read under it 0.17-0.29 µs with one key, 1.6-1.7 µs with keys spread over 10^6 rows *(measured, E-55 claim 1)*. Not held: one GET, and nothing kept: 100,000 misses made 100,000 GETs and 0 SUBs *(measured, E-55 claim 20)* |
| `lens.connect()` | keep the lens's partition live here; a handle to read it and to loop over it | the first on a partition: one SUB; a 100-row room's picture 26-28 µs, or 0.16-0.23 ms right after a full collection. Another on a held selection: 163-169 ns *(measured for `here()`, E-55 claim 6)* |
| `lens.connect(fn)` | the same, plus `fn(value, c)` on the picture and once per commit, a microtask after the call | 92-198 ns a commit over no sink, of which 63-122 ns is data's own delivery; freezing each row handed out, once, 163-220 ns per changed row *(measured, E-55 claim 10)*. On E-56's build: 161-189 ns *(measured, E-56 probe 2)* |
| `for await (const [value, c] of lens.connect())` | the newest state each turn, with the diff merged since the last turn; `break` ends the link | +166 to +241 ns a commit over a callback when it merges in bursts; when each commit is its own turn, +874 to +910 ns over a writer that awaits each commit with no link; 1-50 rows waiting and 0.3-0.4 MB of heap with a loop 10 times slower than the writes *(measured, E-56 probe 2)* |
| `h.value`, `h.ready` | the state now, a sync read; a promise of the handle once the picture is here. `h.value` throws `not-ready` before the picture and `ended` after the link ends. A partition's value, wherever you keep it, is readable only while its link is live (2.1, "What `value` is") | one lookup; after the end, one flag check inside the read trap the view already has *(reasoned)* |
| `h.disconnect`, `h.closed` | end the link now (bound, safe twice); a promise that settles when the link ends, and rejects with why it failed (`expired`, `too-many-views`, a lost lease). `closed` is made only when first read, so a failure nobody reads prints one stderr line and never becomes an unhandled rejection | when the last link on a selection ends, the unsubscribe goes after a short wait (the linger) |
| `c.first`, `c.diff` | true once (the picture); this commit's rows, each with `prev` and the row's `version` | reading `diff` and each `prev`: −39 to +32 ns *(measured, E-55 claim 10)*; `prev` alone 8.2-11.5 ns a change *(measured, E-56 probe 3)*. A diff entry's `version`: not measured; READS.md's bar is 50 ns a commit |
| `c.version` | inside one partition: this commit's id, the version of its last record there. The types offer it nowhere else *(checked: wrong.ts item 23)* | it comes with the frame; not measured; the same 50 ns bar *(reasoned)* |
| `c.cursor`, `h.cursor`, `p.cursor` | the place right after this commit or this state: save it, give it to `changes({ from })` or `past()` | built only when read: 28-35 characters for one partition *(checked, E-56 positions)*, 4-13 KB for a whole resource *(reasoned, API.md:1672)*. Not measured; the same bar |
| `c.text()`, `c.recs()` | this commit's records as JSON text and as records, for code that forwards them. A callback and a `past` step have them; a loop turn merges commits, so it has neither *(checked: wrong.ts item 42)* | built once per commit and shared: 100 builds for 100,000 deliveries *(measured, E-55 claim 9)*; the records 137.6-170.3 ns a change, their JSON 278.6-376.9 ns *(measured, E-56 probe 3)* |
| `{ signal }`, `{ until }` | end a link when a signal aborts, or when a socket, stream, HTTP response or WebSocket says it closed | one listener per signal and a set entry per link: 0.11-0.16 µs to join and 0.05-0.07 µs to leave, at 1,000 to 10,000 links on one signal *(measured, E-56 probe 4b, the mechanism alone)*. A listener per link, as E-56's prototype does, is the trap: adding one cost 1.9-7.2 µs at 1,000 links and 19 µs at 10,000, and the prototype's `connect()` plus `disconnect()` cost +2.7-3.0 µs a link with `{ signal }` at 1,000 links, +25-28 µs at 10,000 *(measured, E-56 probe 4b)*. `until`: a shape check and one `once('close')`, +0.39-0.59 µs a link with 10 links on one socket-like thing *(measured on the prototype, E-56 probe 4b)* |
| `lens.changes()` | the log: every committed record under the lens, in order, from a place, then live; it waits for you. `r.cursor` is a bookmark | one trip to open; the SUB carries the cursor (22-79 B for 1-10 partitions, *measured, [E-19](experiments/E19-slot-positions)*); each kept record crosses once; `credit` (1 MB) bounds what is in flight. From the object store a ranged GET: 1.37 ms p50 on MinIO *(measured, [E-28](experiments/E28-minio-log) via PATHS.md)* |
| `from`, `to` | where the log starts and stops (section 3.3) | `-5`: the server reads back through the slot's kept log. When writes spread evenly that is about 5 × P / 4,096 records for P partitions, 0.6-2 ms at 10^6; for a cold partition beside a hot one it can be all of `history` *(reasoned, section 3.4)*. A `Date`: a binary search over segments by their first batch's time, no index (PATHS.md:886) |
| `lens.past(pos, { to })` | one partition as it was: a window of the log, folded here once, then a value with `value`, `version`, `cursor`, `step(n)` and `for…of`. `step(n)` gives a new value n commits away, or `undefined` past the window's edge; it never changes the one you have | to open: a snapshot load, O(rows of the partition), then 3.6-4.4 µs a record with the version lists *(measured, E-55 claim 23)*; a step 10-12 ns to move *(measured, E-55 claim 23)*, plus one small object *(reasoned)*; a room's rows at a step read each row's version list, 0.6-1.4 µs a row *(measured, E-55 claim 23)*; 103-285 B a version held until every value of the window is dropped *(measured, E-55 claim 23)* |
| `f.rows[k]` | the hot sync read, where every row is held: a server, or `hold: 'all'` | a `Map` read plus one trap; the `Map` read 43-51 ns at 1,000 rows, about 1 µs at 10^6 *(measured, PATHS 4.1)* |
| `f.at(...keys)`, `lens.call(name, arg)` | the key step, for a key from input or named like a fero word; a method by a name in a variable | `at`: −79 to +33 ns over the direct read *(measured, E-55 claim 1)* |
| `f.data.name(arg)` | a root method: an action, sent at once; or a `{ view }`, an address you `get` or `connect` | as a call; a view as `connect()` |

- **Gone:** `here`, `tap`, today's weak `connect(target, fn | 'prop')`, `closes`, `scope`, `dispose`, `asOf` (now `past`), `c.now` (the value is the first argument), `c.changes` (now `c.diff`), a handle's `rows` (its `value` is the rows), `f.snapshot` and `f.methods`. From READS.md's pick: `live`, `on`, `close` (now `disconnect`), `seek` (a new `past` does it) and `until` as a place on the log (now `to`).
- **Kept from READS.md as they are:** root methods on `f.data` with clashing names refused, a served view declared `{ view }` and called as an address, the method table at open, the line between server work and local work, no weak links and no net, `get({ when })` (with neither a `signal` nor a `timeout`, it waits as long as the test fails), the bound end function, a dev warning (with the path) when an open link's handle is collected, `f.cluster` listing live links by path with counts so a leak shows, and `closed` that never becomes an unhandled rejection.
- **A stream** (`rows: false`, API.md 3.3) offers only `changes()` and `set()` on its lenses: the types refuse `get`, `connect` and `past` there *(checked: wrong.ts items 29-31)*; the server answers `no-rows`.
- **What `value` is.** For a row or a field, a new frozen object at each write: a value you may keep. For a partition or the whole resource, one live view, the same object at each commit: nothing is copied. So code that compares by identity wraps it each commit, `setView({ rows })` *(checked: scenarios.ts S3)*. A copy per commit would be a hidden O(rows) copy *(reasoned)*.
- **A partition's value is readable only while its link is live.** After `disconnect()`, `break`, a signal or `until`, any read of it throws `ended`, and so does `h.value`. As first built, E-56's prototype handed out the shared view, and a read after the end gave a different answer in each setting: on a client with no linger, 2 rows before and 0 after; with a 50 ms linger, the rows stayed and took a later write, then went; on a server, or with another link on the same rows, it kept changing. With a guard per link, every such read threw `ended` in all four settings *(checked, E-56 probe 4)*. That is evidence 2's rule: no answer may depend on other code, the role or a timer. To keep the rows, copy them while the link is live, `{ ...rows }`: O(rows), on the line. A `past` value is different: it never changes, so it may be kept (2.3).
- **The count of read words,** counted READS.md's way (each name a user learns to read data, once; values such as `'latest'`, `-5` and a `Date` are not names): this page 25 (`get`, `fresh`, `when`, `connect`, `disconnect`, `signal`, `until`, `value`, `ready`, `closed`, `cursor`, `first`, `diff`, `prev`, `version`, `text`, `recs`, `changes`, `from`, `to`, `past`, `step`, `rows`, `at`, `call`); READS.md's pick 27 by its own count, 26 by this list; READS's fewest-words runner-up 20; today 31 *(reasoned)*. The words for "keep it live, then end it" are four: `connect`, `disconnect`, `signal`, `until`.

### 2.2 What composes with what

| Option | `get` | `connect` | `changes` | `past` | Note |
|---|---|---|---|---|---|
| `fresh` | yes | — | — | — | asks the leader |
| `when` | yes | — | — | — | holds the partition while it waits; ends at the test, `signal` or `timeout` |
| `version: true` | yes | — | — | — | the value and its version |
| `signal` | yes | yes | yes | — | one listener per signal, never one per link (2.1) |
| `until` | — | yes | yes | — | a thing that says it closed; never a place, never an HTTP request: pass the response *(checked: wrong.ts items 24, 43)* |
| `from` | refused | **refused**, with a message that names `changes()` and `past()` *(checked: item 11)* | yes | its first argument | a cursor, a version, `-5`, a `Date`, `'earliest'`, `'latest'` (section 3.3) |
| `at` (a time) | **refused**: use `past` *(checked: item 13)* | **refused** *(checked: item 14)* | — | — | `at(key)` stays the key step |
| `to` | — | — | yes | yes | the end; `'latest'` is what was newest at the call |
| `credit` | — | — | yes | — | bytes in flight to this reader |
| `once` | — | **refused**: `get()` *(checked: item 12)* | — | — | |

Two ends on one link (`signal` and `until`): the first to fire ends it and removes the other's listener *(checked: E-56 probe 4, case "until + signal")*.

### 2.3 Lifetimes: every live thing ends by your code

| The live thing | It ends at the first of |
|---|---|
| a handle from `connect()` or `connect(fn)` | `disconnect()`; its `signal` aborts; its `until` says it closed; a framework effect's cleanup, which returns `disconnect`; for a loop over `connect()`, `break` or a throw. When the last link on a selection ends, the unsubscribe goes after the linger |
| a callback added with `h.connect(fn)` | the end of `h` |
| a view right of `connect()` (`filter`, `map`, …) | its own `disconnect()`, or the end of the handle it was made from (59,958 view sinks, 0 calls after the end, *measured, E-55 claim 26*; 59,941 again on `connect`, *checked, E-56 probe 4*) |
| `get({ when })` | the test passes, its `signal` aborts, or its `timeout` |
| a `changes()` reader | `break`, `disconnect()`, its `signal`, its `until`, or reaching `to` |
| a `past()` value | **nothing to end.** Its window was read before the promise resolved, and it keeps no SUB and no link. It never changes: `step(n)` gives a new value. Its memory (103-285 B a version) goes when your code drops every value of that window. That is a cost, never a result: nothing it holds ever serves another read |
| a method handler's links, a lock's job | `ctx.signal`; the lock's signal |
| everything | the process's clean stop (V4-8) |

**The three rules that make several ends safe** *(checked: E-56 probe 4, every lifetime case passes; each rule's absence broke a case)*:
1. **Every end is safe twice and removes the other ends' listeners.** `disconnect()` twice, a signal that fires after `disconnect()`, and `until` with `signal` are all safe. Without it, 1,000 listeners stayed on a signal where 500 should, and a planted double release broke 28,137 checks.
2. **`until` checks a shape:** a Node socket, stream or HTTP response (`once('close')` and `destroyed`); the `ws` library's socket (`once('close')` and `readyState`); a WebSocket (`close()`, `readyState`, `onclose`). It refuses a DOM element, an `EventSource` and a plain emitter, none of which can say it already closed *(checked: wrong.ts items 25-27)*; without that, a plain emitter that had closed never ended its link. It also refuses an HTTP request, which has the same shape as a response: on Node 22.22.0 a request whose body was read said it closed at 19 ms, while its client stayed until 315 ms (one loopback GET), so `{ until: req }` would end a long response's link at once *(checked: wrong.ts item 43; E-56 probes 4 and 5)*. Use the response. At run time anything else is refused `bad-target` *(checked, E-56 probe 4)*.
3. **The first call comes a microtask after `connect()` returns,** so `const h = lens.connect((v) => { if (done(v)) h.disconnect() })` is safe. Without it, `h.disconnect()` inside the first call threw a `ReferenceError`, the link leaked, and every later write threw data's `AggregateError`. With it, E-55's rules "bornseq" and "settled" were never reached (0 of 73,789 first calls came inside a batch or a commit's effects), so a builder may drop them *(checked; the drop reasoned, E-56 probe 4)*. READS.md's pick has the same microtask rule, so it gains the same drop.

**The collector never ends a link.** Evidence 3: 0 of 1,000 removed DOM nodes were collected in 30 s in Chromium *(measured, E-55 claim 13)*. A link nobody ends runs until the process stops: 1,000 such links cost 0.80-0.90 ms a commit *(measured for uncollected weak targets, E-55 claim 12; the same work here, reasoned)*. In development fero warns, with the path, when an open link's handle is collected and it has no `signal`, no `until` and no parent; the link keeps running, so no result depends on the collector *(reasoned, as READS.md 2.2)*. **That warning is only a net, and it often stays silent.** It needs the collector to run, which in Chromium may be never (above). A handle kept in a variable is never collected, so it never warns: S2's `shown`, S11's `undoLink` and S14's `who` would run for good if the code that removes their screen forgot `disconnect()` *(reasoned)*. What always shows a leak is `f.cluster`, which lists live links by path, with counts *(reasoned, as READS.md 2.2)*.

**Why `past` may be a value when a link may not.** Evidence 2 and 3 are about live things: rows a dropped link still holds might serve a read, and work keeps running for a time the collector picks. A `past` does no work after it resolves, never changes, and never serves `get()` or `f.rows`. So dropping it changes nothing anyone can read *(reasoned)*. Two pieces of code that share one `past` cannot move each other, since `step(n)` gives a new value. Datomic's database value works the same way: nobody closes it, and it never changes *(from memory)*.

### 2.4 How live state and the log stay apart (evidence 5)

Evidence 5 says the newest state (folded: a slow reader sees the newest, one change per row) and the log (every record, in order, it waits for you) are different on purpose. Here they differ **by verb**, never by an option:

| | `connect()` (live state) | `changes()` (the log) |
|---|---|---|
| a slow reader | skips to the newest: one change per row since its last turn | waits: it gets every record, in order |
| with a loop 10 times slower than the writes, 5 s | 1 waiting change on a row; 5-9 rows (at most 27-50) on the whole resource; 0.3-0.4 MB *(measured, E-56 probe 2)* | in E-56's stand-in, an every-commit queue in the process: 45,588-45,638 commits and 16.1-17.1 MB, growing about 9,120 a second *(measured, E-56 probe 2)*. A real log reader reads the server's log by position, so there the cost is lag behind the log, not memory here *(reasoned)* |
| what an item is | `[value, c]`: the state and the commit's diff, with `prev` | `Entry`: one record, its version and writer time; no `prev`, no state |
| the types | a loop turn has no per-record `version` *(checked: wrong.ts item 8)* | an entry cannot be read as `[rows]` *(item 7)* and has no `prev` *(item 9)* |
| where it starts | the picture now (a new picture after a restart) | a place: a cursor, a version, `-5`, a `Date`, `'earliest'` |

- **One option would have hidden the switch.** In P1 and P2, `room.connect((rows) => render(rows))` and `room.connect((rows) => render(rows), { from: saved })` both compile, and only the word `from` says the second one waits and folds privately (checked by both judges). Here the second is refused, and the message names `changes()` and `past()` *(checked: wrong.ts item 11)*.
- **This is a case, not a measurement.** The table above measures evidence 5's two rules, and this page keeps both. A `changes()` loop 10 times slower than the writes falls behind by the same commits *(reasoned)*. E-56's seeded run also passed 7,777 every-commit loops opened with `from` on `connect`, with 0 wrong *(checked, E-56 probe 4)*, so correctness does not tell the two shapes apart. In a real build P1's `from` link would read the server's log by position and lag until `history` runs out, then fail `expired`, not fill memory here (P1's own table). So the danger is a loop that silently falls behind, behind one word. P3 said it plainly: "a case, not a measurement … A judge could weigh that lower than this page does." Both judges weighed it as this page does.
- **Other systems agree, from memory.** Every system I know that has both live state and a log names them apart: Kafka Streams (KTable, KStream), Datomic (a database value, the transaction log), ElectricSQL (Shape, ShapeStream), Replicache (subscribe, watch), Deno KV (watch, a queue), Redis (GET, XREAD), MongoDB (find, watch), RxJS (BehaviorSubject, ReplaySubject) *(from memory)*. Row-level change capture (Debezium's before and after, MongoDB change streams with pre- and post-images and `resumeAfter`) does give a row's before and after from a position, then live *(from memory)*. None gives a folded collection state, replayed from a position and then live, in one call *(from memory)*. So the case for two verbs rests on evidence 5 and the judges' reading of it, with E-56 showing how far one word moves a loop and the outside world as support, not proof.

### 2.5 The evidence it must respect

| # | E-55's evidence ([LENS 6](LENS.md)) | How this page meets it |
|---|---|---|
| 1 | a lens is never a promise | kept, and neither is a handle, a served view or a `past` before it resolves *(checked: wrong.ts items 1-4, 15)*; a lens that went through `Promise.resolve` is still an address *(item 40)* |
| 2 | a read is served here only from rows held on purpose | every link is strong, so every held row is held on purpose; a link's rows are readable only while it is live, then `ended` *(checked, E-56 probe 4)*; a `past` never serves a read |
| 3 | the collector is only a net | not even a net: it never ends a link; in development it only warns |
| 4 | a function that closes over its target keeps it; a weak link costs 2.2 times | no weak link, so no target to capture and no 2.2 times |
| 5 | live state and the log differ on purpose | two verbs, `connect()` and `changes()`; `from` on `connect` refused (2.4) |
| 6 | whole partitions; a client's view over every row is a method the server named, with a cap | kept from READS: the types refuse the operator and name the view *(checked: items 5, 6)* |
| 7 | one call per commit, rows by reference and frozen; a callback is not free | kept *(checked: item 34)*; the call 92-198 ns a commit *(measured, E-55 claim 10)* |
| 8 | no hidden trips, copies, decodes or whole-resource work | `get` stays a GET (no `once`, no `at`); `past` names its fold and is refused wider than one partition *(item 22)*; `c.cursor` is built only when read; `f.snapshot` goes |
| 9 | types work for a typed client | `fero<Shop>('shop')` with `import type` *(checked: fifteen type equalities in scenarios.ts)* |

---

## 3. Commit ids and positions, in plain words

### 3.1 What a commit is

A commit has no id of its own today. Each record carries its slot's **sequence**, the slot's own counter (LAYERS.md:504); the slot's **epoch**, its era number, is read with it (LAYERS.md:507). The epoch rises only at rare events: an unclean recovery (DESIGN-V5.md:125), a restore, or a slot move, which records its new epoch before use (LAYERS.md:250, 1063). So the pair (epoch, sequence) only ever goes up. A row's version is that pair at the row's last write. What a callback calls "a commit" is **one leader's batch, cut down to the rows the link reads**, with at most one change per row (API.md:1279; LENS.md:454). For one partition it is usually one write, sometimes several: a `batch` call, or the writes one process made in one turn of the event loop *(reasoned from API.md:132)*.

### 3.2 What an id looks like

**Inside one partition, a commit's id is the version of its last record there.** API.md promises that two versions of one partition compare with plain `<` (API.md:1676), so the text must keep the order. A plain form such as `0-9001` would not: as text, `0-10000` sorts before `0-9001` *(reasoned)*. A length prefix keeps it: one character says how many digits follow *(checked: 0 wrong in 1,000,000 seeded pairs, and every text turns back into its number; E-56 positions, textform.mjs)*.

| Epoch | Sequence | The version as text | Its length |
|---|---|---|---|
| 0 | 1 | `11` | 2 |
| 0 | 9,001 | `38S9` | 4 |
| 0 | 16,777,215 | `5FZZZZ` | 6 |
| 0 | 2,000,000,000 | `71VKB500` | 8 |
| 3 | 12 | `930000000C` | 10 |

- The digits are Crockford's base32 (digits and capitals without I, L, O, U). The examples run 2 to 10 characters *(checked, E-56 positions)*; the largest 63-bit number takes 13 digits plus the length character, 14 *(reasoned)*. The split of 63 bits between epoch and sequence is not fixed (E-19's DEV-09) *(a guess: 23 bits of epoch above 40 of sequence, 1.1 × 10^12 records a slot)*.
- **One text everywhere.** The same text, byte for byte, in `ack.version`, `c.version`, a diff entry, a log entry's `version`, `if: { version }`, a lock token and `from`, so code can compare an answer with a commit using `===` and pass either to `if` or to `from` *(reasoned)*.
- **A cursor** is a reader's place: the resource's id and incarnation, then one (epoch, last sequence seen) per slot it reads (LAYERS.md:609). For one partition it is 21-26 bytes, 28-35 characters, for example `CzBVep_E6Q4zWH2ix-wRNgMBnAMAqUY` *(checked, E-56 positions)*. Most of it is the 16-byte resource id, which lets a server refuse another resource's cursor with `bad-cursor`. For 10 partitions 57-79 B *(measured, E-19)*; for a whole resource up to 4,096 entries, about 4 to 13 KB *(reasoned, API.md:1672)*.
- **A whole resource has no single commit id.** Order is total inside a partition and absent across partitions (API.md:1674); one batch belongs to one group, a resource may have several groups, and a batch's physical place changes at a slot move ([E-31](experiments/E31-subscribe); [E-19](experiments/E19-slot-positions)). So the place of a whole-resource reader is a cursor, and `c.version` exists only on a link inside one partition *(checked: wrong.ts item 23; scenarios.ts t11, t12)*.
- **A version does not say whose it is.** Passed to another partition's `from` or `past`, most such mistakes can be refused for free: the server reads the record at that version anyway, its key names its partition, so a record of another partition is refused `bad-position` *(reasoned)*. One case slips through. A version carries no slot, so a version from another slot may land, in this partition's slot, on a record of this very partition, and then it gives a quiet wrong answer *(reasoned)*. Putting the slot in the version (12 bits, 2 to 3 more characters) would close that gap; it is not priced. A cursor carries the resource id and is refused when wrong. So **the place to save is the cursor**; a version is the id to show, compare and guard with.
- **A writer time is not an id.** It is one number per batch, so every record of a batch shares it, and a busy group writes many batches in one millisecond (LAYERS.md:503) *(reasoned)*.

### 3.3 The grammar: `from`, `past`, `to`

**A version names a record, and so the commit that holds it. A cursor, a time and `-N` name a place between commits. `from` starts at it, `past` reads right after it, `to` stops after it.** A version and `-N` work inside one partition only. `from: v`, `past(v)` and `to: v` all act on the whole commit that holds `v`. So `past(ack.version)` shows the row as its whole commit left it: if the same process wrote the row twice in one turn, the two writes left in one batch (API.md:132), and `past` shows the second. That is the state every reader saw, since no reader sees half a commit *(reasoned)*. It changes API.md:1676, where `changes({ from: version })` "starts at that record" (8.3).

| You give | It names | `changes({ from })` | `past(pos)` reads | `to` |
|---|---|---|---|---|
| a version, `38S9` | a record, and so the commit that holds it | starts **at** that commit: it comes again, whole, even if the version is one record inside it | right after that commit | stops after it |
| a cursor | the place after what a reader saw | starts after it: nothing comes twice | the state at that place | stops there |
| `-5` | the place just before the 5th last commit that touched this lens | the last 5 commits, then live | the state just before them | (as a place) |
| a `Date` | the place just before the first batch, in log order, stamped after that time | from that batch | the state just before that batch | stops there |
| `'earliest'`, `'latest'` | all that is kept; now (the default, fixed at the call) | | | `'latest'`: what was newest when the reader opened |

- **Walking a window.** `for (const [value, c] of await lens.past(pos, { to }))` yields exactly the commits `changes({ from: pos, to })` would yield, each with the state right after it and its diff. So `past(-5, { to: 'latest' })` walks the last 5 commits with state, and `past(v, { to: 'latest' })` starts with commit `v` itself *(reasoned; checked for the types: scenarios.ts S18, S20, t8)*.
- **Why a version starts at its commit and a cursor after it.** A version names a record, and its commit is the unit every reader sees; a cursor names the gap after what was read (LAYERS.md:609). A saved text loses its type, so fero tells them apart by length: a cursor carries the 16-byte resource id, a version is short *(reasoned)*. For a `from` that names a commit id (I5), starting at it is the natural meaning; for resuming, the cursor's.
- **What the types refuse** *(checked: wrong.ts)*: a version or `-N` on the whole resource (items 16, 17: "a version or a count back names one partition: on a wider lens give a cursor or a time"); a bare number as a time (items 18, 19: "a time is a Date"); a count typed `number` (item 20; a `const` that holds `-5` has the type `-5` and is fine); a positive count (item 21); a place in `until` (item 24).

### 3.4 `-N`: a count back

- **One clean meaning:** "the N-th last commit that touched this lens, and everything after it". On a room that is the room's commits; on a row inside a room, or a field, only the commits that touched that row or field. It counts commits as a callback on the same lens sees them, which is also `past.step(-1)`'s unit *(reasoned)*. Counting the room's commits for a row lens would replay commits that hold none of the row's records.
- **On a wider lens it has no single meaning** *(reasoned)*. "5 commits of every partition" at 10^6 partitions replays 5 × 10^6 commits, the whole-resource work evidence 8 forbids; "5 of every slot" lands at different times in each slot, and slots are hidden; "the last 5 batches by writer time" is a time, not a count. So the types refuse it and name a `Date`.
- **The server counts back.** A slot's sequence also counts every other partition in the slot, so `v − 5` is not 5 commits back (DESIGN-V5.md:122, 126). With P partitions over 4,096 slots, 5 commits of one partition sit among about 5 × P / 4,096 of its slot's records: about 5 records up to P = 4,096, 1,221 at 10^6 *(reasoned arithmetic)*. Each needs its key read, 0.5-0.8 µs, or 1.3-1.6 µs inside a batch read *(measured, PATHS.md:1336)*. So about 0.6-2 ms at 10^6 partitions, once, when the reader opens, **when writes spread evenly** *(reasoned)*. That is the easy case. A cold partition that shares its slot with a hot one lies much further back: the count may read through all of `history`, cross a slot move into another group's segments, and read from the object store *(reasoned; not measured)*. That worst case belongs on the line too (section 6, S18). A cheap bound exists: if each record carried its partition's previous version (a few bytes a record), counting back would be N reads *(reasoned; not priced)*.
- **It needs the log kept** (`history`, default 0, API.md:1847). Past it the reader gets `expired`, with the earliest kept cursor. With `history: '1h'`, a row last changed two hours ago gives `expired` for `-5`, though "5 changes ago" is a clear idea: the line reads the kept log *(reasoned)*. If fewer than 5 were ever written and nothing was compacted, it starts at the first.
- **"Now" is the call.** `changes()` fixes `'latest'` when it is called (API.md:1342), and `-5` counts from the same point, so a commit that lands between the call and the server's count cannot shift it *(reasoned)*.
- **A saga** is ordinary writes in each partition, so `-5` counts each saga step and may start mid-saga, as any reader may see half a saga (V5-1) *(reasoned)*.

### 3.5 Time

- **A time is a `Date`, never a bare number** *(checked: wrong.ts items 18, 19)*. A log entry's `time` is a number in ms, so as a position it is `new Date(e.time)`.
- **It means the same for every scope, at the price of being approximate.** Writer time is the median of the members' clocks and never goes back within a group (LAYERS.md:503, 524). Across partitions and resources a time is not an exact cut: writes inside the members' clock gap may fall either way. E-21's simulated runs put the error at 100 ms early to 300 ms late with 250 ms of skew *(measured, simulated, [E-21](experiments/E21-time))*. At a slot move a slot's times come from another group's clocks and may step back by up to the two groups' clock gap *(reasoned)*.
- **A time names a place in the log, not a set of batches.** T is the place just before the first batch, in log order, stamped after T. `past(T)` is the state at that place, and `changes({ from: T })` starts there, so the two meet with no gap and no overlap by construction *(reasoned)*. This matters at a slot move: there a slot's times may step back, so a batch after the cut can carry a time at or before T. Defined by "every batch stamped at or before T", `past(T)` would then not be a state the log ever had. Defined by place, it always is; the step back only makes the cut approximate, as above.
- **Finding the place:** per group, a binary search over segments by their first batch's time; no time index is needed (PATHS.md:886).

### 3.6 What to save to resume

| Reader | Save | Then |
|---|---|---|
| a log reader | `r.cursor`, after each entry you handled | `changes({ from: saved })`: at least once. For exactly once, `derive()` or `consumer()` keep marks in the target's own log (29 B a mark, API.md 3.11) |
| a live link you want to replay from later | `h.cursor` or `c.cursor` (S17) | `changes({ from: saved })` for every record since; `past(saved, { to: 'latest' })` for the state at each step since |
| a live link after a restart | nothing | a new picture: the right default for live state, which shows the newest. A resume that sends only the rows changed since a saved cursor is section 10's question 3 |
| a write | `ack.version` | `past(ack.version)`, `if: { version }` |
| a commit you show or guard with | `c.version` (one partition) | `===` against `ack.version`; `from: v` replays from that commit |

**Owed, not new here.** The per-row version that `if: { version }`, `get({ version: true })`, lock tokens and every diff entry need is not in LAYERS 3.2. Kept as a separate `Map` it cost +10.5-15.1 / +26.8-64.1 / +213-276 ns a write at 1,000 / 100,000 / 1,000,000 rows, and 29-37 B a row *(measured, E-56 positions, tree.mjs `ver`)*. Kept inside the row's own entry it would likely cost less *(reasoned)*.

---

## 4. Merkle trees

### 4.1 Where they help, and why fero is different

A Merkle tree answers "where do two copies differ?" when the copies share no position: each took writes in its own order, as in Dynamo-style stores, whose repair builds such trees, or as in git, which has many writers and no single order *(from memory)*. In fero every partition has one leader and one order. Every copy and every client holds a prefix of that one log. So "how far did you get?" (a version or a cursor) already says what the other side lacks, in one message. A difference between two copies at the same position is a bug, which the replica check F-21 exists to catch ([REQUIREMENTS.md](REQUIREMENTS.md)), not a normal state to repair *(reasoned)*. v4 weighed "Merkle or range digests per partition" for its sync and rejected them as "heavier and still periodic" ([DESIGN-SCALE.md](../DESIGN-SCALE.md)). One name to untangle: API.md 3.12's "hash-tree root" is a persistent map (a HAMT, [E-54](experiments/E54-time-travel)), not a Merkle tree.

### 4.2 What E-56 measured

The yardstick for anything kept per write is the bar E-54 set for a version kept per write on the live path: **under about 0.2 µs and 20 B a write** (API.md:747). It is used here as a yardstick, not as a rule; the verdict rests on the single order and on the resume bytes (4.3). The times are *(measured, E-56 positions, [results/tables.md](experiments/E56-one-connect/positions/results/tables.md))*; the resume bytes are exact counts, the same in every run *(checked)*.

**Hashing one commit's records**, what a content-addressed commit id or a hash chain (each commit hashes the one before, as git does) would cost the leader:

| Way | 1 record, 100 B | 1 record, 1 KB | a record in a batch of 256 × 100 B |
|---|---|---|---|
| CRC-32 (native; every batch already pays it) | 194-204 ns | 350-371 ns | 23.3-24.0 ns |
| SHA-256 | 1.15-1.25 µs | 1.75-1.83 µs | 76.5-78.5 ns |
| SHA-256 chain (the previous 32 B hashed in) | 1.63-1.68 µs | 2.33-2.43 µs | 79.8-82.6 ns |

A chain meets the yardstick only in full batches of small records; a quiet partition's one-record commit pays about 1.6 µs.

**Keeping a hash structure over one partition's rows, per write** (extra over a plain `Map` write):

| Structure | 1,000 rows | 100,000 rows | 1,000,000 rows |
|---|---|---|---|
| a per-row version in a `Map` (what "rows newer than mine" needs; owed anyway) | +10.5 to +15.1 ns | +26.8 to +64.1 ns | +213 to +276 ns |
| a 16-ary Merkle tree over (key, version), the path rehashed each write | +598 to +605 ns | +1,202 to +1,224 ns | +1,395 to +1,747 ns |
| the same, only the leaf sums kept (inner nodes built when asked) | +254 to +309 ns | +360 to +382 ns | +695 to +854 ns |
| ... the leaf sums over the per-row version they ride on | +243 to +296 ns | +296 to +355 ns | +420 to +602 ns |
| a SHA-256 Merkle tree | +8.3 to +8.5 µs | +16.8 to +17.3 µs | +19.2 to +20.4 µs |

No Merkle way kept per write came under the yardstick in any run, not even the leaf sums alone, and not even counted over the per-row version store. (One pre-restart run of the leaf sums at 1,000 rows came in at +190 ns; the rerun's lowest was +243 ns over the version store.)

**A resume after compaction** (one partition; k rows changed since the client's version, a tenth of them removed; the log since is gone). Bytes up plus down, exact, 100 B rows:

| Rows | k | a full picture, 1 trip | a Merkle walk | rows newer than mine + tombstones, 1 trip | the client lists keys and versions, 1 trip |
|---|---|---|---|---|---|
| 1,000 | 1 | 122 KB | 510 B, 3 trips | **164 B** | 13.0 KB |
| 100,000 | 100 | 12.8 MB | 42.1 KB, 5 trips | **11.8 KB** | 1.50 MB |
| 1,000,000 | 1 | 131 MB | 910 B, 5 trips | **173 B** | 15.9 MB |
| 1,000,000 | 100,000 | 130 MB | 25.9 MB, 5 trips | **12.3 MB** | 28.2 MB |

"Rows newer than mine, plus tombstones" was smallest in all 8 cases, in one trip; the walk sent 1.68 to 5.28 times its bytes with 100 B rows and 1.08 to 1.68 times with 1 KB rows, in 3 to 5 trips. The walk's one edge is server CPU when few rows changed in a huge partition: 18-35 µs for one change, where scanning for newer rows took 23.9-43.0 ms at a million rows *(measured)*; an index kept in version order would remove that edge, at a per-write cost not measured.

### 4.3 The verdict, use by use

| Use | What it would buy | The simpler thing | Verdict |
|---|---|---|---|
| **commit ids as a hash chain** (content-addressed, like git) | an id equal on every copy; tamper evidence | the version: it names the place, compares with `<` (locks need that, API.md:1676) and survives slot moves; the batch CRC guards the bytes | **No.** A chain runs through one group's log, so a slot move puts a partition's commits in another chain; a one-partition reader sees part of a batch and cannot check a hash over the whole of it; it does not compare with `<`; it costs 1.6-1.7 µs a one-record commit |
| **a client resumes after the log it needs was compacted** | only the rows that differ, removes included, with no log | rows newer than the client's version, plus tombstones kept for a window; past the window, a new picture | **No to the walk** (it never beat the simpler way, and costs every write). The simpler way **later**, if resumes past `history` matter (question 3) |
| **two replicas hold the same rows (F-21), and which rows differ** | finds differing rows in a few steps | E-05's order-free sum at a named offset to detect; per-slot sums computed at check time to find (32 KB to compare): a one-level tree kept by nobody | **Later, built only at check time** |
| **verifying a snapshot or a restore** | check a restored copy without moving every row | the batch CRC; F-21's sum at the snapshot's offset; E-33's epochs | **No** |
| **comparing a fork with its parent** | what differs between the two | what either side changed since the fork's start: rows newer than the fork's position | **No** |
| **edge caches and offline clients** | a cheap catch-up | an edge cache is a reader with a cursor; v5 keeps no optimistic copy, so a client's rows are a prefix of the log | **No** |
| **proofs to a third party** | an outsider checks one row against one signed root | a reader library that folds the log off the write path and publishes a signed root per position; kept per write, a SHA-256 tree costs 41 to 102 times the yardstick | **No for the base**; possible later as a library |

---

## 5. Await, `for await`, and `get`

### 5.1 Reading once: `await lens.get()`, never `await` the handle

E-56 built three ways to "await the connect" on E-55's prototype *(checked, E-56 probe 1)*:

| What the code does | V-a: the handle is thenable; the link stays | V-a1: thenable; awaiting ends the link | V-b: no `then`; `get()` reads once (this page) |
|---|---|---|---|
| an `async` helper returns `lens.connect(fn)`, called 1,000 times | 1,000 states, **0 handles, 1,000 links left open**, all called at the next write | 1,000 states; each `fn` called **once, then never**, silently | 1,000 handles; all ended |
| `const h = await lens.connect(fn)` | `h` is the state; 1 link left open | `h` is the state; `fn` stops | `h` is the handle |
| `Promise.all`, `Promise.race`, `Promise.resolve`, a `.then` that returns it, a library that awaits anything with a `then` | the state; a link left open each time | the state; `fn` stopped | the handle |

- **A thenable handle is evidence 1 again, one level down.** E-55 removed `then` from the lens because an `async` function that returned the root lens downloaded every row. A thenable handle does the same to a link: anything that resolves values swaps the handle for its state, and the only way to end the link is gone.
- **The types agree** *(checked)*. `await lens.connect()` gives the handle, which is not a row (wrong.ts item 2), and the handle has no `then` (item 3). A lens that went through `Promise.resolve` is still a lens, not a row (item 40).
- **`get()` is not `connect({ once })`.** Reading one number of a 1,000-row partition a client does not hold: E-55's `get()` made 1 GET and moved 1 byte; `get()` built as `connect({ once })` made 1 SUB, moved the partition's whole picture (65,671 bytes), folded 1,000 rows, then unsubscribed and dropped them *(checked, E-56 probe 1)*. Where the rows are held here, both read locally with no trip. So `get` may share `connect`'s code only where the rows are already here; elsewhere it stays a GET (evidence 8). `connect({ once })` is refused *(checked: item 12)*.

### 5.2 `get` as the small wrapper, and what it refuses

- `await lens.get()` one value; `get({ fresh: true })` asks the leader; `get({ version: true })` gives `{ value, version }`; `get({ when: (v) => …, signal })` holds the partition until the test passes, reads, and lets go. That last one is the read-once subscription of I9, with its cost on the line (`when`).
- `get({ at: v })` is refused: a read as it was loads a snapshot and folds the log, about 2.6 to 6.1 µs a record from the nearest snapshot, so up to seconds for a million records *(reasoned: E-55 claim 23's 3.6-4.4 µs less the version lists, plus a decode, PATHS.md)*. It has its own word, `past` *(checked: item 13)*.
- `get(key)` is refused (I10): `await shop.data.get(id)` would be an address, always truthy in plain JavaScript. The types refuse it *(checked: item 32)*, and the run time refuses a first argument that is not an options object, `bad-arg`, so the slip is loud in plain JavaScript too *(reasoned)*. `get(key)` as a read, like `Map.get`, is weighed in I10: not now.
- **One slip the types do not catch:** a forgotten `.get()`, `JSON.stringify(await shop.at(id))`, compiles (judge 2's probe J14). It prints nothing: `undefined`, and inside an object the field is dropped, `{}`. `console.log` prints `Lens(shop.widgets)` *(checked on E-55's lens, E-56 probe 5's slips line)*. So the slip is quieter than an address: an empty body or a missing field. P1's guard caught it by giving the lens a `then` that takes an impossible value, but then the types say a lens has a `then` the run time does not have, an `async` helper that returns an address must wrap it, and `Promise.all` still lets a lens into a row variable *(checked by both judges on P1's declarations, not on this page)*. This page leaves it to a lint rule *(reasoned)*.

### 5.3 `for await`

- **Over `connect()`: the newest state each turn.** Each turn is `[value, c]`, with `c.diff` merged since the last turn (one change per row, the first `prev` kept). With a loop 10 times slower than the writes it saw 49,990-49,996 of 50,000 commits' effects in 11.4-11.6 commits a turn, with 1-50 rows waiting *(measured, E-56 probe 2)*.
- **Over `changes()`: every record.** It waits for you; the reader's credit bounds what is in flight, so a slow reader lags behind the log rather than filling memory here *(reasoned, PATHS.md)*.
- **Cost over a callback** *(measured, E-56 probe 2)*: +116 to +137 ns a commit when an every-commit loop keeps up in bursts, and +166 to +241 ns when it merges. When each commit is its own turn, a loop costs +707 to +910 ns a commit over a writer that awaits each commit with no link at all (a promise and its turns each time); no callback was timed that way.
- **A loop turn has no `recs()` or `text()`.** A merged turn holds one change per row since the last turn, so its records would be whole rows made up for that loop, built per loop and shared with no one, not the wire records a callback forwards *(checked: E-56's `Merged.recs()`; wrong.ts item 42)*. Code that forwards records uses `connect(fn)` or `changes()`.
- **`break` ends the link.** If `break` ended only the loop, `for await (const x of lens.connect()) { …; break }` would leave the link open for good, since nobody holds the handle; if one handle were both a callback and a loop, a `break` somewhere else would silence the callback. So a handle made with a callback is not a loop *(checked: E-56 probe 4; wrong.ts item 10)*.
- **A partition's state can run ahead of its turn's diff.** The loop reads the live view when its turn runs, and commits made in between are not in that turn's diff yet: 5,640 of 196,267 merged turns (2.9 %) on a partition or the whole resource; a row's never *(checked, seeded: E-56 probe 4's seeded run, `sims.mjs picture`)*. Taking the turn's diff when the loop body resumes would fix the plain case *(reasoned only)*. A callback runs inside the commit and never sees this.
- **A `past` is a sync `for…of`,** since its window is already here. Each item is `[value, c]`: for a row, the row object that version made; for a room, a view fixed at that step, which you may keep, since a `past` never changes. Reading a room's row at a step searches that row's version list, 0.6-1.4 µs a row *(measured, E-55 claim 23)*.

---

## 6. Every scenario: READS.md's line and this page's line

S1-S16 are READS.md section 3's; S17-S23 come from the owner's message. Each line on the right is in `scenarios.ts` (section 11), which compiles *(checked)*. READS.md wrote no S17-S23; the lines in its column were written by judge 1 on READS's own declarations, and compile *(checked by the judge)*.

| S | What | READS.md's pick | This page |
|---|---|---|---|
| 1 | read a row once in an HTTP handler, and a field | `await shop.at(id).get()`; `shop.at(id, 'stock').get()` | the same |
| 2 | a field in a DOM element, until the element goes | `stock.on((n) => { el.textContent = String(n) }, { signal })`, and `abort()` where the code removes `el` | `const shown = stock.connect((n) => { el.textContent = String(n) })`, and `shown.disconnect()` where the code removes `el` |
| 3 | React (and Svelte, Vue), stop on unmount | `useEffect(() => shop.at(id).on(setRow).close, [id])` | `useEffect(() => shop.at(id).connect(setRow).disconnect, [id])`; the same `disconnect` in `$effect` and `watchEffect`; a room wraps its value, `setView({ rows })`, and drops it in the cleanup, since its rows end with the link |
| 4 | a room to 1,000 sockets; each ends with its socket | `chat.at(room).on((_, c) => ws.send(c.text()), { until: ws })` | `chat.at(room).connect((_, c) => ws.send(c.text()), { until: ws })` |
| 5 | a top-10 served view, shown here | `fan.data.best(10).on(render)` | `fan.data.best(10).connect(render)` |
| 6 | filter a room here, render it | `room.live().filter(fn).on(render)` | `room.connect().filter(fn).connect(render)` |
| 7 | count every order exactly once | `derive(orders, totals, fn)` | the same |
| 8 | replay from a saved cursor, save as you go | `changes({ from })`, `r.cursor` | the same |
| 9 | a hot loop on a server | `shop.rows[k]` | the same |
| 10 | a row at a version, then one commit back | `(await lens.past(v)).step(-1)`, then `close()` | `(await lens.past(v)).step(-1)?.value`: a new value, or `undefined` at the window's edge; nothing to close |
| 11 | an undo with the previous value | `on((_, c) => c.diff[0])`: `prev` and `version`; `set(prev, { if: { version } })` | `connect((_, c) => c.diff[0])`; the same guard |
| 12 | a handler reads a row, then writes | `await ctx.at.get()` | the same |
| 13 | wait until stock > 0 | `await stock.get({ when: (n) => (n ?? 0) > 0 })` | the same |
| 14 | who is online in a room | `online.at('room1').on(render)` | `online.at('room1').connect(render)` |
| 15 | a few rows from different partitions | `Promise.all(ids.map((id) => f.at(id).get()))` | the same |
| 16 | stop a request's or a job's live reads when it ends | `{ until: res }`; a job: `await lens.live({ signal }).ready` | `{ until: res }`; a job: `for await (const [w] of lens.connect({ signal })) { …; if (done) break }` |
| 17 | replay from a saved commit id, then keep going live | a live commit has no id; the newest diff entry's version stands in, and holds only if every record shows as a change; then `changes({ from: savedVersion })` | `c.version` is the commit's id (`38S9`); save the link's `cursor`, then `changes({ from: saved })`: every record after it, in order, then live. That gives records, as a feed. A screen that shows the room again needs its state too: S18's two calls, with their seam, or question 3's resume |
| 18 | replay the last 5 commits of a room, then keep going live | the log: no clean line, since there is no `-N`: read the room's whole kept log into a ring of the last 5 records (records, not commits), then `changes({ from: first.cursor })`. With state: `const p = await room.past(Date.now()); p.step(-5)`, then `p.step(+1)` five times, then `room.on(render)`: two calls with the same seam as this page, but each step has no diff and no version, and `p` must be closed (this form was added here from READS.md's declarations, *reasoned, not compiled*) | `changes({ from: -5 })`. With state at each step: `past(-5, { to: 'latest' })` walked with `for…of`, then `connect()`: two calls, with a seam |
| 19 | a row as it was at a version, and at a writer time | `past(version)`, `past(Date.parse(…))` (a time is a bare number); each closed | `(await lens.past(version)).value`; `past(new Date(…))`; nothing to close |
| 20 | step through a row's versions, forward and back | `past(version)`, `step(-1)`, `step(+1)`, `close()`; a step has no version to label it | `past(version, { to: 'latest' })`; `for (const [row, step] of audit) show(step.version, row)`; `audit.step(-1)?.step(+1)`: each a new value, `undefined` past the window |
| 21 | read one value once with await | `await shop.at(sku, 'stock').get()` | the same |
| 22 | tie a link to a lifetime and end it by hand early | `const h = lens.on(fn, { until: res }); setTimeout(h.close, 60_000)` | `const link = lens.connect(fn, { until: res }); setTimeout(link.disconnect, 60_000)` |
| 23 | an events resource with no rows: every record from a saved cursor, saving as you go | `events.data.changes({ from })`, saving `feed.cursor` | the same; the types refuse `get`, `connect` and `past` on a stream |

Nine scenarios do not change (1, 7, 8, 9, 12, 13, 15, 21, 23). Nine change only words (2-6, 11, 14, 16, 22; S2 ends by `disconnect()` where READS used a signal, and both work). S10 drops its `close()`. Four get better, each in a narrow way. S17: a commit has an id, and a live link can save its place; what comes back is records, not the room. S18: `-5` gives a clean line for the log, which READS lacks; with state, both pages need two calls with the same seam, and here each step also carries its diff and version. S19: a time is a `Date`, nothing to close. S20: each step carries its version, and the window walks with `for…of`.

**What the new lines cost** *(costs from section 2.1, marks there)*:

| S | The line | What runs | Cost |
|---|---|---|---|
| 17 | `shown17.cursor` saved; later `changes({ from: saved })` | the cursor is built once, when read; the log reader opens after that place and then stays live | 28-35 characters saved; one trip to open, then each record once. Needs the record still kept (`history: '1d'` here), else `expired` |
| 18 | `changes({ from: -5 })` on one room | the server counts back 5 commits of `room1` in its slot, then streams | to count back: about 5 × P / 4,096 records when writes spread evenly; up to all of `history` for a cold room beside a hot one *(reasoned)*; then as S17 |
| 18 with state | `past(-5, { to: 'latest' })`, then `connect()` | a snapshot load and a fold of the window here; then a new picture | as S19, then a SUB. The seam: a commit that lands between the walk and the picture shows inside the picture, not as its own step *(reasoned)* |
| 19 | `past(version)`, `past(new Date(…))` | a snapshot load and a fold of the window, here; then a value | O(rows of the partition) once, plus 3.6-4.4 µs a record *(measured, E-55 claim 23)*; the time form is approximate across partitions |
| 20 | `past(version, { to: 'latest' })`, `for…of`, `step(±1)` | one window, from the nearest snapshot before `version` to now; walking it is in memory. To look further back than that snapshot, open a new `past` at an earlier place | the open as S19, but to now; 10-12 ns a step plus one small object; 103-285 B a version held until dropped |
| 21 | `await shop.at(sku, 'stock').get()` | one GET, or a lookup if held | one trip or none; nothing kept |
| 22 | `connect(fn, { until: res })` plus `setTimeout(link.disconnect, …)` | one link with two ends; the first removes the other's listener | one `once('close')`; `disconnect` safe twice *(checked, E-56 probe 4)* |
| 23 | `events.data.changes({ from })`, saving `feed.cursor` | a log reader on a stream that keeps no rows | each record once; at least once across a restart; `derive()` for exactly once |

---

## 7. The runners-up, and what came from each

| Shape | Judge 1 | Judge 2 | In one line |
|---|---|---|---|
| **P3 "table, log, value"** (this page's base) | **41** | **42** | `get`, `connect` (live only: a callback, a handle or a loop), `changes({ from, to })`, `past(pos, { to })` as a value; `c.cursor` on every commit |
| P2 "two read verbs" | 38 | 35.5 | `get` (now, `{ asOf }`, `{ when }`) and `connect` (live, or the log with `{ from, to }`); the cleanest positions |
| READS.md's pick (P0) | 36 | 35.5 | `get`, `live`, `on`, `changes`, `past`; `close`, `{ signal }`, `{ until }` |
| P1 "the owner's connect, whole" | 34 | 34 | one `connect` whose options pick live, the log (`from`) or the past (`at`); `get` reads and also steps by a key |
| today's API.md (P-1) | 20 | 21.5 | `here`, `tap`, a weak `connect(target, fn)`, `scope`, `changes`, `asOf`, `f.snapshot` |

Each judge scored ten axes from 0 to 5: guessable, few words, cost visible, safe lifetimes, state against the log, positions, scenarios covered, platform fit, types work, and the owner's wishes. Both judges re-ran every proposal's type checks; all passed. The scores are judgement *(both judges say so)*: P2 and P3 are 3 points apart for judge 1, and a judge who weighed "one verb" above evidence 5 would rank P1 or P2 first. P3 itself called its case for keeping the log apart from `connect` "a case, not a measurement" (2.4). Judge 1 expected the grafts below to add about a point each on types, positions and cost visible *(reasoned; not rescored)*.

**P2, "two read verbs".** *Right:* the positions. One sentence of grammar ("a version names a commit; a cursor, a time and `-N` name a place; `from` starts at it, `asOf` reads right after it, `to` stops after it"). A count must be a negative literal and a time a `Date`, both in the types. A version refused on a wide lens. `c.version` inside one partition. `at(key)` kept. *Not the pick:* it has P1's main flaw, a `from` on `connect` that turns a live link into a private log reader that folds the partition, shown only by one word (both judges' probe J1); `get({ asOf })` hides a fold behind `get`; a one-partition log always folds, even when only the records are read; S20 is an array the app fills, since nothing steps; it drops `c.recs()`. **Taken:** the position types, the grammar (as user rule 3, with "a version names a record, and so the commit that holds it"), "a version is refused wider than one partition", "`from` a version takes the whole commit that holds it", and `c.version`.

**P1, "the owner's connect, whole".** *Right:* the best coverage (every one of S1-S23 in one line) and the most faithful to the owner. Good rules: no thenable handle, `get` stays a GET, a past read wider than one partition refused, `c.cursor` and `c.version`, `{ once }` refused. *Not the pick:* one option swings a link from shared and folded to private and waiting, and only `from` shows it. S4 with "the last 5, then live" per socket, `connect(fn, { until: ws, from: -5 })`, compiles and makes 1,000 private log readers, each loading a snapshot and folding the room *(reasoned by judge 2 from P1's own text)*. `get({ at })` hides a fold. `get` has two meanings, and `await shop.get(id)` in plain JavaScript is an address, always truthy. Its type guard for that (a lens whose `then` takes an impossible value) makes `Awaited<Lens>` equal `never`, so a lens passed through `Promise.resolve` or `Promise.all` lands in a row variable with no error *(checked by judge 1 on P1's declarations)*. It refuses `{ signal }`, the platform's word. By its own count it costs +1 to +18 builder rules on 416, the most. **Taken:** `c.version` typed for one partition only, a past read refused wider than one partition, and the plainest wording of the three lifetime rules ("the first one wins").

**READS.md's pick.** *Right:* the base of everything here: five jobs named by what you get, state and log apart by verb, no weak links, `get` a GET, every link ending by your code, cost on the line. *Missing* on the new ground: the owner's words (`connect`, `disconnect`), a loop over live state, `-N`, a `Date` on the log (its time is a bare number), a place or id on a live commit, and a clean S18. **Taken whole:** `get({ when })`, `{ view }`, root methods on `f.data` with clashing names refused, the method table, `closed` that never becomes an unhandled rejection, one listener per signal, the bound end function, the dev warning, and the line between server work and local work.

**Today's API.md.** Six words for "keep it live, then end it", a served view that is a promise, a weak link at 2.2 times a strong sink, `f.snapshot`'s hidden walk, and `scope` that loses links after an `await` (READS.md section 1). Nothing new is taken.

**Not grafted, on purpose.** P1's `await` guard (section 5.2; a lint rule instead). P1's `get(key)` (I10). P1's single `until` that refuses `signal`. P2's dropping of `c.recs()`. `seek` on `past` (judge 2's graft 6): a new `past` does the job, and it can come back if a jump inside a window proves needed. A folded one-partition log as an option on `changes()` (judge 2's graft 7) and a folded resume on `connect` (judge 1's graft 7): both close S18's seam, neither is modelled, and section 10's question 3 asks about the second.

---

## 8. What changes

### 8.1 Against READS.md's pick

| READS.md's pick | This page | Why |
|---|---|---|
| `lens.live()` and `lens.on(fn)` | `lens.connect()` and `lens.connect(fn)` | the owner's word; one verb with two forms; `disconnect` is the platform's word for ending a watch, and Web Audio pairs it with `connect` |
| `h.close` | `h.disconnect` | the owner's word (I3); still bound, still safe twice |
| no loop over live state (a live handle is not iterable) | `for await (const [value, c] of lens.connect())`: the newest state each turn; `break` ends it | I12; the policy is in the verb (2.4) |
| a commit carries no place and no id | `c.cursor` always; `c.version` inside one partition; `h.cursor`; `p.version`, `p.cursor` | I5, I6; built only when read |
| `changes({ from, until })`: a cursor, a version, `'earliest'`, `'latest'` | `changes({ from, to })`: also `-5` and a `Date`; a version and `-5` only inside one partition; `until` is only "a thing that closes" | I8; one meaning for `until` |
| `past(pos)` on any lens, a reader with `step`, `seek` and `close`; `step` moves the reader | `past(pos, { to })` inside one partition only: a value with `value`, `version`, `cursor`, `step` and `for…of`; `step(n)` gives a new value, or `undefined` past the window; no `close`, no `seek` | I13; evidence 8 (a past read wider than one partition folds every partition) |
| a live value read after its link ends: not said | a partition's value is readable only while its link is live; then `ended` | evidence 2; E-56 probe 4 |
| a time is a number | a time is a `Date`; a count back is a negative literal | P2's types |
| six user rules | seven: the positions grammar is rule 3 | |
| `on` refuses a non-function | `get` and `connect` refuse an argument of the wrong kind (`bad-arg`) | I10, the Map habit; `on` is gone |
| `{ until }` takes any thing that says it closed | also refuses an HTTP request (`bad-target`): pass the response | a request may say it closed long before its client goes (E-56 probe 5) |

Everything else on READS.md's page stands: `get` and `get({ when })`, `{ signal }` and `{ until }` on a link, no weak links, root methods and `{ view }`, the method table, `f.snapshot` gone, `asOf`'s new name `past`.

### 8.2 Against V5-12's picks

The owner approved these on 2026-11-18 ([DECISIONS V5-12](../DECISIONS.md)). Each change needs a new decision; it is the same list as READS.md's, with this page's words.

| V5-12 | What changes |
|---|---|
| pick 1: a client holds nothing "until `here()` or `tap`" | the words only: until `connect()` |
| pick 3: `lens.sell(1)`; `f.methods.x(arg)` at the root; fero's names win | as READS: root calls are `f.data.x(arg)`; `f.methods` goes; a method named like a fero word is refused where it is declared |
| pick 5: server views are named in `methods:`, with a cap | as READS: a view is declared `{ view }`, and is an address |
| pick 8: `lens.asOf(position)`, a reader | renamed `past(position)`; a value, not a reader; one partition only; it walks with `for…of` and `{ to }` |
| pick 11: `get()`; a lens is never a promise | kept; `get` gains `{ when }`; a handle, a served view and a `past` are never promises either |
| pick 13: a method declares `{ at: 'row' \| 'partition' \| 'any', run }` | as READS: kept, and gains `{ view }` |
| the review rules: a `connect` function changes only its target; a link ends at `close()`, its scope, its target's own close or a count, and the collector is only a net | **the big one**, as in READS: the weak `connect`, the net and `scope` go. A link ends at `disconnect()`, a `signal`, `until`, `break` or the count. The collector never ends one. The verb `connect` comes back with a new meaning: a strong link, ended by your code |
| picks 2, 4, 6, 7, 9, 10, 12 and 14 | unchanged |

### 8.3 In API.md and the pages around it

- **[API.md](API.md):** section 2 (the screen; seven user rules, rewritten), 3.8 (root calls; `{ view }`; the name rule; the method table), 3.9 (`f.snapshot` goes; `get` refuses `at` and a key), 3.10 (rewritten around `connect`, `disconnect`, `signal`, `until`, `closed` and the loop; the weak `connect`, the net and its three rules go; `changes()` gains `-N`, a `Date` and `to`, and `until` as a place on the log goes), 3.11 (names only), 3.12 (`past`: a value inside one partition, with `version`, `cursor`, `for…of` and `{ to }`; `step(n)` gives a new value), 6 (the declarations: `Live`, `Link`, `Commit<Row, O>`, `Turn`, `Past`, `Pos`, `Closes`, `Served` as an address; line 1676, where `changes({ from: version })` "starts at that record", becomes "starts at the commit that holds it"), 8 (codes `bad-name`, `bad-target`, `bad-arg`, `bad-position`, `no-such-method`, `no-rows`, `ended`), and the patterns that use `tap`, `here`, `scope`, `connect` and `asOf` (P-01, P-03, P-05, P-12, P-13, P-18, P-19, as READS.md 7 lists).
- **[API-TOUR.md](API-TOUR.md):** about 75 lines use the old words (READS.md 7's count).
- **[LAYERS.md](LAYERS.md):** as READS.md 7 says, plus one row: the frame carries each partition's last version, so a commit can carry `c.version`, and the per-row version store (owed, section 3.6) becomes a row of 3.2.
- **[READS.md](READS.md):** this page supersedes its sections 0, 2 and 3 if the owner takes it; its sections 4 (methods at the root) and 5 (`asOf`'s name) stand as they are.

### 8.4 In data

LENS 4.5 lists data's planned changes, D1 to D8. **D5**, a weak `connect` with the net, goes (as in READS). **D4**'s one sink shape becomes `(value, c)` with `c.diff`; a diff entry's `version`, `c.version` and `c.cursor` come from fero's frame, so data alone has none *(reasoned)*. **D2**'s lens takes `connect`, `changes` and `past` where it had `here`, `tap` and `asOf`. **D6** (views end with their handle) stays and was checked again on `connect` (59,941 view sinks, 0 calls after the end, *checked, E-56 probe 4*). D1, D3, D7 and D8 are unchanged. Nothing here edits data; the seam stays fero's `api/substrate.ts`.

### 8.5 The counts

**Read words:** 25, against READS.md's 26 counted the same way (section 2.1).

**User rules: seven**, one more than READS.md's six (today's API.md has seven):
1. **A path is an address.** Building one sends nothing. It is never a promise, and neither is a handle.
2. **`get()` reads a value once. `connect()` keeps the newest state here, and calls you or loops. `changes()` is every record from a place, and it waits for you. `past()` is one partition as it was: a value.**
3. **A version names a record, and so the commit that holds it; a cursor, a time and `-N` name a place. `from` starts at it, `past` reads right after it, `to` stops after it.** A version and `-N` work inside one partition; save the cursor to resume.
4. **Left of `connect()`: plain data, which may run on a server. Right of it: your code, here.**
5. **The wire sends whole partitions.**
6. **Every live thing ends by your code:** `disconnect()`, `break`, a signal, `until`, or the count. Never the collector. A link's rows are read only while it is live; after the end, `ended`. A `past` is a value: nothing to end.
7. **A method says where it may be called (`at:` or `view`), never takes a fero word, and checks what it is given.**

**Builder rules,** against READS.md's pick, by SIMPLICITY's measure *(every row reasoned)*:

| Change | Rules |
|---|---|
| `live` and `on` become one `connect` with three forms; a loop turn merges what came since the last turn; `break` ends the link; a handle made with a callback is not a loop | +1 to +2 |
| `close` becomes `disconnect`; the log's end becomes `to` | 0 |
| `seek` goes: a new `past` does it | 0 to −1 |
| a `past` is a value: its window is read before the promise resolves; it keeps no SUB and needs no end | −1 to 0 |
| a `past` walks with `for…of`; `{ to }` stretches its window | 0 to +1 |
| `past` only inside one partition: no fold across partitions | −1 to 0 |
| `-N`: the server counts back, from the call's "now", the commits that touched this lens; refused wider; `expired` past `history` | +1 to +2 |
| a `Date` position: ties inside a millisecond, a step back at a slot move | 0 to +1 |
| `c.cursor`, `h.cursor` and `p.cursor`, built only when read | +1 |
| `c.version` inside one partition: the frame carries each partition's last version | 0 to +1 |
| `from` tells a version (at it, its whole commit) from a cursor (after it) by its text | 0 to +2 |
| a version refused on a wider lens | 0 to +1 |
| `get` refuses a non-object argument (`bad-arg`) | 0 to +1 |
| a stream's lenses offer only `changes()` and `set()` (`no-rows`) | 0 |
| a version whose record is in another partition is refused `bad-position` | 0 to +1 |
| `past.step(n)` gives a new value that shares the window, or `undefined` past its edge | 0 to +1 |
| a loop turn has no `recs()` or `text()` | 0 |
| a partition's value is guarded per link: after the end any read throws `ended` (READS's pick needs it too) | 0 to +1 |
| `until` refuses an HTTP request (READS's pick needs it too) | 0 to +1 |
| **net, against READS.md's pick** | **about 0 to +16** |

READS.md put its pick at about +10 to +25 on 416, so this page is about **+10 to +41 on 416**. Most of the extra is the owner's positions (`-N`, a `Date`, a place and an id on each commit), which READS.md did not price; READS's pick would pay most of them too if it took them, and it needs the last two rows as they stand. Both pages may drop E-55's "bornseq" and "settled" rules (−2 to 0) thanks to the microtask first call, so that is not counted as a difference. The per-row version store is owed by both and priced by neither.

---

## 9. What is not known yet

| Not known | Why it matters | What would settle it |
|---|---|---|
| none of it runs. E-56's probes built `connect` with callbacks, loops, `signal`, `until` and `once` on E-55's prototype; not the log, not the positions, not `past` as a value, not `c.cursor` or `c.version` | the costs above are E-55's and E-56's paths under new names *(reasoned)* | extend E-56's `proto/connect.mjs` with `c.cursor`, `c.version` and a value-shaped `past`; rerun E-55's claims 7, 9, 10, 23 and 26 |
| the cost of `c.version`, `c.cursor` and a diff entry's `version` | they sit on every commit's path when read; a whole-resource cursor is 4-13 KB | E-55 claim 10's harness with each field read; bar 50 ns a commit |
| counting back for `-5` on a real log, and a cold partition beside a hot one | could be far more than 5 × P / 4,096 records | a bench on E-19's slot layout |
| the seam in S18 "with state": how often an app needs every step with state and then live with no gap | the one thing the owner asked for that this page does in two calls | write S18 with state against E-22's patterns; if common, model a folded resume (question 3) in E-31's model with a client-held base |
| a merged loop's partition state runs ahead of its turn's diff | 5,640 of 196,267 merged turns on the prototype *(checked, seeded: E-56 probe 4's seeded run)*; taking the turn at the loop's resume is reasoned to fix the plain case only | a seeded run with the turn taken at resume |
| the per-row version store | owed by `if: { version }`, diff entries and `c.version`; +10.5 to +276 ns a write as a separate `Map` *(measured, E-56 positions)* | a version inside the row's own entry in data's store, timed |
| the epoch and sequence split of a version | fixes the longest text and the most records a slot holds | the record format (E-19's DEV-09) |
| a `past` window's memory | 103-285 B a version until every value of the window is dropped: 100-285 MB for a million records *(measured per version, E-55 claim 23; the total reasoned)* | a pin on the open window, and a line in the docs |
| the cost of the `ended` guard in a real build | E-56 checked that it makes every read after the end loud, as a second `Proxy` over the view; a real build would put one flag check in the read trap the view already has *(reasoned)* | E-55 claim 1's harness with the flag in the trap |
| how often real apps leak with no net; whether the dev warning fires in a browser (a handle kept in a variable never warns); whether React needs `useSyncExternalStore` | shared with READS.md's pick (its section 8) | READS.md section 8's tests, counting open links through `f.cluster` |

---

## 10. Questions for the owner

1. **Take `connect` / `disconnect` as the one live verb**, in three forms (`connect()`, `connect(fn)`, a loop), in place of READS.md's `live`, `on` and `close`? **Pick: yes.** It is the owner's word, `disconnect` is the platform's word for ending a watch, and it is one verb fewer. *Against:* one word with three forms and two return types (a loopable handle, a callback link); the types catch a loop over a callback link, the run time gives a `TypeError`. And it renames words approved on 2026-11-18 a second time.
2. **Keep the log and the past as their own verbs, `changes()` and `past()`, not options on `connect` (`from`, `at`)?** **Pick: yes.** The two judges agreed: with `from` on `connect`, one word turns a shared, folded link into a private reader that waits, and nothing else on the line shows it; here the types refuse it. This is a judgement, not a measurement. E-56 measured only how far the one word moves a slow loop: 1-50 rows waiting against about 45,600 commits behind after 5 s. *Against:* it says no to the heart of the message, on judgement. Correctness does not tell the two shapes apart (7,777 such loops, 0 wrong). "Replay with state, then live" is two calls with a seam (S18), as in READS.
3. **Later, a folded resume on a live link: `connect({ resume: cursor })`, which sends only the rows changed since a saved place, then goes live?** It would close S18's seam without a log reader inside `connect`: it is E-31's state-mode reconnect, and past the log it is "rows newer than mine plus tombstones", the smallest resume in all 8 of E-56's cases. **Pick: not now; model it first in E-31's model with a client-held base.** *Against:* it adds `resume` beside `from`, needs tombstones kept for a window (+2 to +3 rules, *reasoned*), and until then a restarted screen starts from a new picture.
4. **Commit ids: `c.version` inside one partition, a cursor across, one text everywhere, and no Merkle trees?** **Pick: yes.** *Against:* a version does not say whose it is. Most wrong ones are refused for free, but one from another slot can land on this partition's own record and give a quiet wrong answer (save the cursor to resume; or put the slot in the version, not priced). The bit split is not fixed; a whole resource has no one id to show.
5. **`past` only inside one partition, as a value that walks with `for…of`, never changes (`step(n)` gives a new value) and needs no end?** **Pick: yes.** *Against:* "the whole resource as it was at noon" is no longer one line (read the log from a `Date` and fold it in your code); a big window holds 103-285 B a version until dropped, and nothing but dropping it frees that memory; a step makes one small object, where READS's moved the reader in place.
6. **Positions in the types: a count back only as a negative literal, a time only as a `Date`, a version and `-N` refused wider than one partition?** **Pick: yes.** *Against:* a count typed `number` needs a cast (a `const` that holds `-5` is fine); a `Date` is an object made for every time position; and the types now carry a little machinery a reader of `fero.d.ts` must follow.
7. **A partition's value readable only while its link is live, then `ended`?** **Pick: yes.** It gives the same answer in every role, with any linger and any number of links (E-56 probe 4); the other ways to get that, a copy at each commit or at the end, are hidden O(rows) work *(reasoned)*. *Against:* code that keeps `rows` past a `disconnect()` now throws where it once read stale rows; it must copy, `{ ...rows }`, at O(rows). A React hook that keeps a room's rows in state must drop them in its cleanup, one more line (S3).

---

## 11. How this page is checked

Every ` ```ts ` block whose first line is `// file: <name>` is written into a fresh folder and type-checked with tsc: the combo in section 0 and the five files below (`fero.d.ts`, `env.d.ts`, `server.ts`, `scenarios.ts`, `wrong.ts`). Then a copy is made with every `@ts-expect-error` turned into a plain comment, and each of those lines must fail at its own line, with no error anywhere else (the strip proof). `fero.d.ts` is self-contained: the read surface, with writes and methods only as far as the scenarios need. It types servers with `fero.of` only; API.md's seed form, `fero(name, { data, methods })`, and call options such as `{ once }` on a method call are not declared here.

<details><summary>fero.d.ts: the declarations</summary>

```ts
// file: fero.d.ts — the read surface this page recommends, as declarations. Self-contained: it imports nothing.
// A sketch to type-check the page; nothing is built. Writes and methods are here only as far as the scenarios need.
//   lens.get(opts?)            read once; hold nothing. A GET, or no trip where the rows are held on purpose
//   lens.connect(opts?)        the newest state, kept here: a handle (value, ready, cursor, closed, disconnect) and a loop
//   lens.connect(fn, opts?)    the same, plus fn(value, c) on the picture and once per commit. Not a loop
//   lens.changes(opts?)        the log: every record from a place (a cursor, a version, -5, a Date), then live
//   lens.past(pos, opts?)      one partition as it was: folded here once, then a value with step(n) and for..of
//   { signal }, { until }      how a live thing ends, besides disconnect() and break. Never by the collector
declare module 'fero' {
  // ── words ──────────────────────────────────────────────────────────────
  export type Key = string
  export type Depth = 1 | 2
  /** What the types know of a handle: a server, a bare client, or a client that said hold: 'all'. */
  export type Role = 'server' | 'client' | 'all'
  /** A record's place in its partition's log, its slot's (epoch, sequence), as short text that keeps log order under
   *  plain `<`, such as '38S9'. A commit's id is the version of its last record there; from, past and to act on the
   *  whole commit that holds a version. The same text in ack.version, c.version, a diff entry, a log entry,
   *  if: { version } and a lock token. It does not say which partition it belongs to. */
  export type Version = string & { readonly __fero: 'version' }
  /** A reader's place: the resource's id, then one (epoch, sequence) per slot it reads. Save it to resume.
   *  28-35 characters for one partition; kilobytes for a whole resource. Another resource's cursor is refused. */
  export type Cursor = string & { readonly __fero: 'cursor' }
  /** A place every lens takes: after a cursor; a writer time, as a Date (approximate across partitions);
   *  all that is kept; or now. */
  export type Place = Cursor | Date | 'earliest' | 'latest'
  /** Inside one partition also a commit (a Version) and a count back (-5). On a wider lens neither has one meaning. */
  export type Pos<O extends boolean> = Place | (O extends true ? Version | number
    : Steer<'a version or a count back names one partition: on a wider lens give a cursor or a time, new Date(...)'>)
  /** A count back is a negative literal: commits that touched this lens. A value typed number (most often a time,
   *  Date.now()) or a positive number is refused: a time is a Date. A const that holds -5 has the type -5: fine. */
  type Back<P> = P extends number
    ? (number extends P ? Steer<'a time is a Date; a count back is a literal such as -5'>
      : `${P}` extends `-${string}` ? P : Steer<'a count back is negative: -5 is 5 commits back'>)
    : P
  /** The same check on an option: a count back in `from` or `to` must be a negative literal. */
  type BackOpt<P, K extends string> = [Extract<P, number>] extends [never] ? {} : { readonly [k in K]?: Back<P> }
  export type Duration = number | `${number}${'ms' | 's' | 'm' | 'h' | 'd'}`
  export type Size = `${number}${'KB' | 'MB' | 'GB'}`
  export type Rows<Row> = { readonly [key: string]: Row | undefined }
  type Tree<Row, D extends Depth> = D extends 2 ? Record<Key, Record<Key, Row>> : Record<Key, Row>
  export type RowsOf<Row, D extends Depth> = D extends 2 ? { readonly [part: string]: Rows<Row> | undefined } : Rows<Row>
  /** fero's wire record: what c.recs() gives and what a log entry carries. */
  export interface Rec { readonly type: 0 | 1 | 2; readonly key: readonly (string | number)[]; readonly value?: unknown }
  /** A compile error that names the line to write instead. */
  export interface Steer<Msg extends string> { readonly 'fero: write this instead': Msg }

  // ── opening ────────────────────────────────────────────────────────────
  export interface OpenOptions { hold?: 'all' | Size; linger?: { ms?: number } }
  export interface ServerOptions<D extends Depth> extends OpenOptions {
    server?: true; depth?: D; history?: 0 | 'all' | Duration
    rows?: { ttl?: Duration; while?: 'session' }; views?: { client?: number; max?: number }
  }
  type AnyResource = { readonly name: string; readonly data: unknown; destroy(): Promise<boolean> }
  /** A server's handle seen from a client: the same rows and methods, another role. */
  type ClientOf<S, H extends 'client' | 'all'> =
    S extends Stream<infer Row, infer D, any> ? Stream<Row, D, H>
    : S extends Resource<infer Row, infer M, infer D, any> ? Resource<Row, M, D, H> : never
  /** A typed client: `fero<Shop>('shop')`, with `import type { Shop }` from the server file. */
  export function fero<S extends AnyResource>(name: string, opts: OpenOptions & { hold: 'all' }): Promise<ClientOf<S, 'all'>>
  export function fero<S extends AnyResource>(name: string, opts?: OpenOptions & { hold?: Size }): Promise<ClientOf<S, 'client'>>
  /** A resource that keeps no rows: a stream. Its lenses read the log only. */
  export function fero<Row, D extends Depth = 1>(name: string, opts: Omit<ServerOptions<D>, 'rows'> & { server: true; rows: false }): Promise<Stream<Row, D, 'server'>>
  /** Typed by its rows only: a server, a client that holds every row, or a bare client. */
  export function fero<Row, D extends Depth = 1>(name: string, opts: ServerOptions<D> & { server: true }): Promise<Resource<Row, {}, D, 'server'>>
  export function fero<Row, D extends Depth = 1>(name: string, opts: OpenOptions & { hold: 'all' }): Promise<Resource<Row, {}, D, 'all'>>
  export function fero<Row = any, D extends Depth = 1>(name: string, opts?: OpenOptions & { hold?: Size }): Promise<Resource<Row, {}, D, 'client'>>
  export namespace fero {
    /** A server with methods: the row type by hand, the methods worked out. `fero.of<Score>()('scores', { methods })`. */
    function of<Row, D extends Depth = 1>(): <const M extends Methods<Row, D>>(
      name: string, opts: ServerOptions<D> & { methods: M & NoInfer<NoClash<M, D>> },
    ) => Promise<Resource<Row, M, D, 'server'>>
    function id(): string
  }

  // ── the resource ───────────────────────────────────────────────────────
  export interface Resource<Row = any, M = {}, D extends Depth = 1, R extends Role = Role> {
    readonly name: string
    /** The root lens: the address of everything. Root methods are called on it: `f.data.low(5)`. */
    readonly data: Lens<Tree<Row, D>, Row, M, 'root', D, R>
    /** The hot sync read: one lookup, frozen rows. Only where every row is held: a server, or hold: 'all'. */
    readonly rows: [R] extends ['client'] ? Steer<'f.rows needs every row held here: read through a connect() handle, or open with hold: "all"'> : RowsOf<Row, D>
    /** The same address as f.data.a.b, with no Proxy: keys from input, keys named like fero words, hot loops. */
    readonly at: AtFn<Row, M, 'root', D, R>
    /** A reader name's marks, as a cursor for changes({ from }). */
    marks(name: string): Promise<Cursor>
    destroy(): Promise<boolean>
  }
  const keepsNoRows: unique symbol
  /** A resource opened with rows: false: a stream. You publish with set(); you read its log with changes(). */
  export interface Stream<Row = any, D extends Depth = 1, R extends Role = Role> {
    readonly [keepsNoRows]: true
    readonly name: string
    readonly data: LogLens<Row, 'root', D, R>
    readonly at: (...keys: (Key | number)[]) => LogLens<Row, 'row', D, R>
    destroy(): Promise<boolean>
  }
  type NoRows = 'this resource keeps no rows (rows: false): read its log with changes()'
  /** A lens on a stream: steps, the log, and publishing. No state to get, connect or look back on. */
  export type LogLens<Row, K extends Kind, D extends Depth, R extends Role> = {
    changes<const F extends Pos<One<K>> = 'latest', const T extends Pos<One<K>> = 'latest'>(opts?: ChangesOpts<F, T>): Changes<Row>
    set(value: Row, opts?: WriteOpts): Judged
    readonly get: Steer<NoRows>
    readonly connect: Steer<NoRows>
    readonly past: Steer<NoRows>
  } & { readonly [key: string]: LogLens<Row, K extends 'root' ? (D extends 2 ? 'part' : 'row') : 'row', D, R> }

  // ── the lens: an address. A property read is a step; a call is a verb ──
  export type Kind = 'root' | 'part' | 'row' | 'field'
  type Child<K extends Kind, D extends Depth> = K extends 'root' ? (D extends 2 ? 'part' : 'row') : K extends 'part' ? 'row' : 'field'
  /** Is this lens inside one partition? Every lens but the root is (at depth 1 a row is its own partition). */
  type One<K extends Kind> = K extends 'root' ? false : true
  /** What a read gives: a row or field (undefined when absent), or the rows of a partition or of everything. */
  type Val<T, Row, K extends Kind, D extends Depth> = K extends 'row' | 'field' ? T | undefined : K extends 'part' ? Rows<Row> : RowsOf<Row, D>
  /** What connect() gives: a collection has local operators right of the line; a row or field does not. */
  type LiveOf<T, Row, K extends Kind, D extends Depth> =
    K extends 'row' | 'field' ? Live<T | undefined, Row, true> : K extends 'part' ? LiveRows<Row, true>
    : D extends 2 ? Live<RowsOf<Row, 2>, Row, false> : LiveRows<Row, false>
  /** V4-5: the typed client of a resource with methods changes data only through them. */
  type Door<M, R extends Role> = [R] extends ['server'] ? false : keyof M extends never ? false : true

  export type Lens<T, Row, M, K extends Kind, D extends Depth, R extends Role> =
    Reads<Val<T, Row, K, D>, Row, LiveOf<T, Row, K, D>, One<K>>
    & (One<K> extends true ? PastRead<Val<T, Row, K, D>, Row>
      : { readonly past: Steer<'past() reads one partition as it was; here it would fold every partition: read the log from a time, changes({ from: new Date(...) })'> })
    & { readonly at: AtFn<Row, M, K, D, R>; readonly call: CallFn<M, K, D> }
    & (K extends 'row' | 'field' ? (Door<M, R> extends true ? {} : WriteVerbs<T>) : {})
    & (K extends 'root' ? RootCalls<M, StepOf<Row, M, K, D, R>> & RootOps<Row, D, R> : K extends 'part' ? Operators<Row, true> : {})
    & PathCalls<M, K, D, StepOf<Row, M, K, D, R>>
    & { readonly subscribe: Steer<'a lens is not a store: lens.connect(fn)'>
        /** `${lens}` and String(lens) give its path, 'shop.widgets.stock': a stable key for a framework. */
        [Symbol.toPrimitive](hint: string): string }
    & Steps<T, Row, M, K, D, R>
  type StepOf<Row, M, K extends Kind, D extends Depth, R extends Role> =
    K extends 'root' | 'part' ? Lens<K extends 'root' ? (D extends 2 ? Record<Key, Row> : Row) : Row, Row, M, Child<K, D>, D, R> : unknown
  /** Six probe names read undefined, so a lens is never a promise or JSON (subscribe is a Steer above).
   *  A row so named is reached with f.at('then'). */
  type Probes = { readonly [P in Exclude<Probe, 'subscribe'>]: undefined }
  type Steps<T, Row, M, K extends Kind, D extends Depth, R extends Role> =
    K extends 'root' | 'part' ? { readonly [key: string]: StepOf<Row, M, K, D, R> } & Probes
    : T extends object ? { readonly [P in keyof T]-?: Lens<T[P], Row, M, 'field', D, R> }
    : {}
  type AtFn<Row, M, K extends Kind, D extends Depth, R extends Role> =
    K extends 'root' ? (D extends 2
      ? { (part: Key | number): Lens<Record<Key, Row>, Row, M, 'part', D, R>
          (part: Key | number, row: Key | number): Lens<Row, Row, M, 'row', D, R>
          (part: Key | number, row: Key | number, ...fields: (string | number)[]): Lens<any, Row, M, 'field', D, R> }
      : { <F extends keyof Row & string>(row: Key | number, field: F): Lens<Row[F], Row, M, 'field', D, R>
          (row: Key | number): Lens<Row, Row, M, 'row', D, R> })
    : K extends 'part' ? { (row: Key | number): Lens<Row, Row, M, 'row', D, R> }
    : (...fields: (string | number)[]) => Lens<any, Row, M, 'field', D, R>

  /** How you get data: get, connect and changes on every lens; past inside one partition. */
  export interface Reads<V, Row, L, O extends boolean> {
    /** Read once, with the row's version. */
    get(opts: GetOpts & { version: true }): Promise<{ value: V; version: Version } | undefined>
    /** Read once: here if this process holds the partition on purpose, else one GET. Holds nothing.
     *  With `when`, it holds the partition live until when(value) is true, reads, and lets go. */
    get(opts?: GetOpts & { when?: (value: V) => unknown }): Promise<V>
    /** The newest state, kept here: the picture, then each commit. Counted, and shared with every equal lens.
     *  The handle is also a loop: `for await (const [value, c] of lens.connect())`, the newest state each turn. */
    connect(opts?: LinkOpts): L
    /** connect(), plus fn on the picture and once per commit, a microtask after connect() returns. Not a loop. */
    connect(fn: (value: V, c: Commit<Row, O>) => void, opts?: LinkOpts): Link<V, Row>
    /** The log: every committed record under this lens, in order, from a place (default: from this call), then
     *  live. It waits for you; nothing is skipped. */
    changes<const F extends Pos<O> = 'latest', const T extends Pos<O> = 'latest'>(opts?: ChangesOpts<F, T>): Changes<Row>
  }
  /** One partition as it was: a log read from the nearest snapshot, folded here once. A value, not a link. */
  export interface PastRead<V, Row> {
    /** value is the state right after pos: after a version's commit, or at a place. for..of walks every commit
     *  changes() would give from pos to `to` (default: pos alone), each as [value, c]. */
    past<const P extends Pos<true>, const T extends Pos<true> = P>(pos: Back<P>, opts?: { to?: T } & BackOpt<T, 'to'>): Promise<Past<V, Row>>
  }
  export interface GetOpts {
    fresh?: boolean; signal?: AbortSignal; timeout?: Duration
    readonly at?: Steer<'a read as it was folds the log here, so it has its own word: (await lens.past(pos)).value'>
  }
  /** How a live link ends, besides disconnect() and break. The collector never ends one. */
  export interface LinkOpts {
    /** It ends when this aborts: a request's, a job's, a component's, a handler's (ctx.signal). */
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
    | { once(event: 'close', fn: () => void): unknown; readonly destroyed: boolean; readonly method?: never }   // a Node socket, stream or response; a request has a method
    | { once(event: 'close', fn: () => void): unknown; readonly readyState: number }   // the ws library's WebSocket
    | { close(): void; readonly readyState: number; onclose: unknown }                 // a WebSocket in a browser or Node 22

  // ── live handles ───────────────────────────────────────────────────────
  /** One live link. It holds its selection on purpose until disconnect(), its signal, its `until`, or break. */
  export interface Link<V, Row = unknown> {
    /** Resolves to this handle once the first picture is here. */
    readonly ready: Promise<this>
    /** The latest committed state, by reference. A row is frozen, a value you may keep; a partition is a live view,
     *  readable only while this link is live. Before ready it throws 'not-ready', after the end 'ended': a sync read
     *  never guesses. */
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
  export interface Live<V, Row = unknown, O extends boolean = false> extends Link<V, Row>, AsyncIterable<[value: V, c: Turn<Row, O>]> {
    /** One more call per commit, for this handle's life. */
    connect(fn: (value: V, c: Commit<Row, O>) => void): Link<V, Row>
  }
  /** A live collection: a partition, the whole resource, a served view, or a view made here. */
  export interface LiveRows<Row, O extends boolean = false> extends Live<Rows<Row>, Row, O>, LocalOps<Row, O> {}
  /** What changed: the second argument of a callback and of a past step; a loop turn has it without recs and text. */
  export interface Diff<Row> {
    /** True once: diff is then the picture so far, as adds. */
    readonly first: boolean
    /** One entry per row this commit (or this loop turn) changed. Rows are frozen. */
    readonly diff: readonly Change<Row>[]
    /** The place after this commit: save it to replay from here later. Built only when read. */
    readonly cursor: Cursor
    /** The wire records of this commit, and their JSON text: each built once per commit and shared. Not on a loop turn. */
    recs(): readonly Rec[]
    text(): string
  }
  /** Inside one partition a commit also carries its id: the version of its last record there. A wider link has
   *  no single commit id, since partitions share no order; its place is the cursor. */
  export type Commit<Row, O extends boolean = false> = Diff<Row> & (O extends true ? { readonly version: Version } : {})
  /** A loop turn: every commit since the last turn, merged to one change per row. Its version and cursor are the
   *  newest commit's. It has no wire records: merged, they would be whole rows made up for this loop. */
  export type Turn<Row, O extends boolean = false> = Omit<Commit<Row, O>, 'recs' | 'text'> & {
    readonly recs: Steer<'a loop turn merges commits: to forward the records, use connect(fn) or changes()'>
    readonly text: Steer<'a loop turn merges commits: to forward the records, use connect(fn) or changes()'>
  }
  export interface Change<Row> {
    readonly type: 'add' | 'update' | 'remove'
    readonly key: Key
    readonly row: Row | undefined
    readonly prev: Row | undefined
    /** The row's version after this commit: for if: { version } (an undo). */
    readonly version: Version
  }
  /** Plain data: may stand left of connect(), and may run on a server. */
  interface PlainOps<Row, Out> {
    gt(field: keyof Row & string, v: number | string): Out
    lt(field: keyof Row & string, v: number | string): Out
    az(field: keyof Row & string, n?: number): Out
    za(field: keyof Row & string, n?: number): Out
    top(n: number): Out
    limit(n: number): Out
  }
  /** Left of connect(): plain data only. A function here does not compile. */
  export interface Operators<Row, O extends boolean = false> extends PlainOps<Row, Sel<Row, O>> {
    readonly filter: Steer<'a function cannot run on a server: connect() first, then filter right of it'>
    readonly map: Steer<'a function cannot run on a server: connect() first, then map right of it'>
  }
  /** The root of a bare client: an operator over every row would be work on every write at a server. */
  type RootOps<Row, D extends Depth, R extends Role> = D extends 2 ? {}
    : [R] extends ['client'] ? { readonly [N in keyof PlainOps<Row, unknown>]: Steer<'an operator over every row, on a client: call a view the server named, f.data.<view>(arg)'> }
    : Operators<Row, false>
  /** A view the server named: an address, like a lens. Never a promise. No operators left of the line. */
  export interface Served<Row, O extends boolean = false> {
    get(opts?: GetOpts): Promise<Rows<Row>>
    connect(opts?: LinkOpts): LiveRows<Row, O>
    connect(fn: (value: Rows<Row>, c: Commit<Row, O>) => void, opts?: LinkOpts): Link<Rows<Row>, Row>
  }
  /** A selection made of plain data: an address too. */
  export interface Sel<Row, O extends boolean = false> extends Operators<Row, O>, Served<Row, O> {}
  /** Right of connect(): your code, here, on held rows. A view ends with the handle it was made from. */
  export interface LocalOps<Row, O extends boolean = false> extends PlainOps<Row, LiveRows<Row, O>> {
    filter(fn: (row: Row, key: Key) => unknown): LiveRows<Row, O>
    map<U>(fn: (row: Row, key: Key) => U): LiveRows<U, O>
  }

  // ── the log, and the past ──────────────────────────────────────────────
  export type ChangesOpts<F, T> = LogOpts<F, T> & BackOpt<F, 'from'> & BackOpt<T, 'to'>
  export interface LogOpts<F, T> {
    /** 'latest' (default): from this call on. 'earliest': all that is kept. A cursor: after it. A Date: from the
     *  first batch after that writer time. Inside one partition also a version (at its commit, which comes again)
     *  or a count back, -5 (the 5th last commit and what follows). Or marks(name). */
    from?: F | Promise<Cursor>
    /** Stop after this place or commit. 'latest': what was newest when the reader opened. */
    to?: T
    credit?: Size
    signal?: AbortSignal
    until?: Closes
  }
  export interface Changes<Row> extends AsyncIterable<Entry<Row>> {
    /** Where this reader is, after the last entry it gave: save it, pass it back as `from`. */
    readonly cursor: Cursor
    readonly closed: Promise<void>
    readonly disconnect: () => void
  }
  /** One log record. No prev and no state: the log is every record, not a folded state. */
  export interface Entry<Row> {
    readonly rec: Rec
    /** What the record wrote, when it wrote a whole row. Not the row now. */
    readonly value?: Row
    readonly partition: string
    readonly version: Version
    /** The writer time of its batch, in ms (a number: no Date is made per record). As a position: new Date(e.time). */
    readonly time: number
  }
  /** One partition as it was: a value that never changes. It keeps no link, so it needs no end; its memory goes when
   *  you drop every value of its window. */
  export interface Past<V, Row> extends Iterable<[value: V, c: Commit<Row, true>]> {
    /** The state here: right after a version's commit, or at a place. A row is the row that version made; a room is
     *  a view fixed at this place, which you may keep. */
    readonly value: V
    /** The commit that made that state (its id), and the place right after it. */
    readonly version: Version
    readonly cursor: Cursor
    /** The state n commits back (-) or forward (+), as a new value sharing this window; undefined past the window's
     *  edge (it starts at the nearest snapshot before the place asked). It never changes this one. */
    step(n: number): Past<V, Row> | undefined
  }

  // ── writes (only as far as the scenarios need) ─────────────────────────
  export interface Op { readonly __op: 'incr' }
  export const op: { incr(n: number, bounds?: { min?: number; max?: number }): Op }
  export interface WriteOpts { if?: { version?: Version; absent?: true } }
  /** A marked write: the write and "source record e is applied" land in one log entry. */
  export interface MarkOpts { from: Entry<any> }
  export interface Ack { version: Version; value?: unknown }
  export interface Judged<A = Ack> extends PromiseLike<A> {}
  export interface WriteVerbs<T> {
    set(value: T | Op, opts?: WriteOpts | MarkOpts): Judged
    /** Read, decide, write: written only if unchanged since the read; on a conflict fn runs again. */
    set(fn: (now: T | undefined) => T | undefined): Judged<Ack | undefined>
    remove(opts?: WriteOpts): Judged
  }

  // ── methods: actions and served views ──────────────────────────────────
  type Handler<Row, D extends Depth, K extends Kind> = (arg: any, ctx: Ctx<Row, D, K>) => unknown
  /** A bare function: an action at the root. `{ at, run }`: an action on a path of that kind, at its leader;
   *  'any': at the root and on every lens (V5-12 pick 13). `{ view }`: a view over every row that clients may
   *  keep live; calling it gives an address. */
  export type MethodDef<Row = any, D extends Depth = 1> =
    | Handler<Row, D, 'root'>
    | { readonly at: 'row'; readonly run: Handler<Row, D, 'row'> }
    | { readonly at: 'partition'; readonly run: Handler<Row, D, D extends 2 ? 'part' : 'row'> }
    | { readonly at: 'any'; readonly run: Handler<Row, D, Kind> }
    | { readonly view: (arg: any, ctx: Ctx<Row, D, 'root'>) => Sel<Row, any> }
  export type Methods<Row = any, D extends Depth = 1> = Record<string, MethodDef<Row, D>>
  export interface Ctx<Row, D extends Depth, K extends Kind> {
    /** The lens the call was made on; for a root action or a view, the root. */
    readonly at: Lens<K extends 'row' ? Row : K extends 'part' ? Record<Key, Row> : Tree<Row, D>, Row, {}, K, D, 'server'>
    /** This server's root lens. */
    readonly data: Lens<Tree<Row, D>, Row, {}, 'root', D, 'server'>
    /** Aborts when the call ends: pass it to the handler's live reads, and they end with the call. */
    readonly signal: AbortSignal
  }
  type Verb = 'get' | 'connect' | 'changes' | 'past' | 'at' | 'call'
  type OpName = keyof PlainOps<unknown, unknown> | 'filter' | 'map'
  type Probe = 'then' | 'toJSON' | 'constructor' | '$$typeof' | 'asymmetricMatch' | 'nodeType' | 'subscribe'
  type WhereOf<H> = H extends { at: infer W } ? W : 'root'
  /** fero's own names on the lens a method would be called on; for 'any', the root's and a row's together. */
  type Taken<W, D extends Depth> = W extends 'root' ? Verb | OpName | Probe
    : W extends 'any' ? Verb | OpName | 'set' | 'remove' | Probe
    : W extends 'partition' ? (D extends 2 ? Verb | OpName | Probe : Verb | 'set' | 'remove' | Probe)
    : Verb | 'set' | 'remove' | Probe
  /** A method named like a fero word, where it would be called, is refused where it is declared. */
  export type NoClash<M, D extends Depth> = {
    [N in keyof M]: N extends Taken<WhereOf<M[N]>, D> ? Steer<'this name is a fero word on the lens it would be called on: rename the method'> : M[N]
  }
  type RunOf<H> = H extends { run: infer F } ? F : H extends { view: infer F } ? F : H
  type ArgsOf<H> = RunOf<H> extends (arg: infer A, ctx: any) => any ? (undefined extends A ? [arg?: A] : [arg: A]) : never
  /** An action answers once its writes commit; a view is an address you get() or connect(). */
  type CallOf<H> = H extends { view: (...a: any[]) => Sel<infer V, any> } ? Served<V> : Judged<Awaited<RunOf<H> extends (...a: any[]) => infer X ? X : never>>
  type CallableAt<W, K extends Kind, D extends Depth> =
    W extends 'any' ? true
    : W extends 'row' ? (K extends 'row' ? true : false)
    : W extends 'partition' ? (D extends 2 ? (K extends 'part' ? true : false) : (K extends 'row' ? true : false))
    : false
  /** The methods a path of this kind may call; each is also the step to the row of that name. */
  type PathCalls<M, K extends Kind, D extends Depth, S> = K extends 'root' ? {} : {
    readonly [N in keyof M as CallableAt<WhereOf<M[N]>, K, D> extends true ? N : never]: ((...args: ArgsOf<M[N]>) => CallOf<M[N]>) & S
  }
  /** The root's methods: `f.data.low(5)` calls; `f.data.low.get()` still reads the row named 'low'. */
  type RootCalls<M, S> = {
    readonly [N in keyof M as WhereOf<M[N]> extends 'root' | 'any' ? N : never]: ((...args: ArgsOf<M[N]>) => CallOf<M[N]>) & S
  }
  /** A method by name: for a name in a variable. An unknown name is refused here, with no trip. */
  type CallFn<M, K extends Kind, D extends Depth> = keyof M extends never
    ? (name: string, ...args: unknown[]) => Judged<unknown> | Served<any>
    : <N extends keyof (K extends 'root' ? RootCalls<M, unknown> : PathCalls<M, K, D, unknown>) & keyof M & string>(name: N, ...args: ArgsOf<M[N]>) => CallOf<M[N]>

  // ── libraries the scenarios use ────────────────────────────────────────
  /** Exactly once from a source's log into a target: paced, and run once across the processes that run it. */
  export function derive<S>(
    source: { readonly name: string; readonly data: { changes(opts?: { from?: Cursor | Promise<Cursor> }): Changes<S> } },
    target: { readonly name: string; marks(name: string): Promise<Cursor> },
    fn: (e: Entry<S>) => void,
  ): Promise<{ readonly disconnect: () => void }>
  /** Run fn while this process holds the lock. Its signal aborts when the lock is lost or fn ends. */
  export function lock(name: string, fn: (signal: AbortSignal) => Promise<void>): Promise<void>
  export class FeroError extends Error {
    readonly code: 'not-held' | 'not-ready' | 'ended' | 'expired' | 'too-many-views' | 'conflict' | 'methods-only'
      | 'bad-path' | 'bad-name' | 'bad-target' | 'bad-arg' | 'bad-cursor' | 'bad-position' | 'no-such-method' | 'aborted' | 'no-rows'
    readonly hint: string
  }
}
```

</details>

<details><summary>env.d.ts, server.ts: the app's world and the servers</summary>

```ts
// file: env.d.ts — the app's world, as tiny stand-ins (this box has no @types packages). Nothing here is fero.
declare module 'node:http' {
  export interface IncomingMessage { url?: string; method?: string; once(event: 'close', fn: () => void): this; readonly destroyed: boolean }
  export interface ServerResponse { end(body?: string): void; write(chunk: string): boolean; once(event: 'close', fn: () => void): this; readonly destroyed: boolean }
  export function createServer(fn: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): { listen(port: number): void }
}
declare module 'node:events' {   // a plain emitter: it has once(), but it cannot say it already closed
  export class EventEmitter { once(event: string, fn: () => void): this; emit(event: string): boolean }
}
declare module 'ws' {
  export class WebSocket { send(text: string): void; once(event: 'close', fn: () => void): this; readonly readyState: number }
  export class WebSocketServer {
    constructor(opts: { port: number })
    on(event: 'connection', fn: (ws: WebSocket, req: import('node:http').IncomingMessage) => void): this
  }
}
declare module 'react' {   // React's own types: an effect returns nothing or a function
  export function useState<S>(): [S | undefined, (value: S | undefined) => void]
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}
declare module 'vue' {
  export function shallowRef<T>(): { value: T | undefined }
  export function watchEffect(fn: (onCleanup: (cleanup: () => void) => void) => void): void
}
declare function $effect(fn: () => void | (() => void)): void   // Svelte 5's rune
// the app's own helpers and values
declare function render(...a: unknown[]): void
declare function draw(...a: unknown[]): void
declare function show(...a: unknown[]): void
declare function save(...a: unknown[]): void
declare function report(n: number | undefined): void
declare function handle(e: unknown): Promise<void>
declare function loadCursor(): Promise<import('fero').Cursor | undefined>
declare function saveCursor(c: import('fero').Cursor): Promise<void>
declare const sku: string, id: string, k: string, keys: string[]
declare const signal: AbortSignal, ws: import('ws').WebSocket, req: import('node:http').IncomingMessage
declare const cursor: import('fero').Cursor, version: import('fero').Version
```

```ts
// file: server.ts — the servers the other files name with `import type`. In an app each is its own process.
import { fero, op } from 'fero'

export type Item = { name: string; stock: number; price: number }
const shop = await fero.of<Item>()('shop', {
  methods: {
    sell: { at: 'row', run: (n: number, ctx) => ctx.at.stock.set(op.incr(-n, { min: 0 })) },   // an action on a row
    restocked: { at: 'row', run: (min: number, ctx) =>                                         // a wait that ends with the call
      ctx.at.stock.get({ when: (n) => (n ?? 0) >= min, signal: ctx.signal }) },
    low: { view: (max: number, ctx) => ctx.data.lt('stock', max) },                           // a view the server names
    ping: () => 'pong',                                                                        // an action at the root
  },
})
export type Shop = typeof shop

export type Score = { player: string; points: number }
const scores = await fero.of<Score>()('scores', {
  methods: { best: { view: (n: number, ctx) => ctx.data.za('points', n) } },   // S5: the server names the view; a cap counts it
})
export type Scores = typeof scores

export type Msg = { text: string; stars: number; hidden?: boolean }
await fero<Msg, 2>('chat', { server: true, depth: 2, history: '1d' })        // a room is a partition, a message a row
export type Here = { name: string }
await fero<Here, 2>('online', { server: true, depth: 2, rows: { while: 'session' } })   // a row dies with its writer
export type Part = { stock: number }
await fero<Part>('parts', { server: true, history: '30d' })                   // no methods: clients may write; a month of log

export type Order = { user: string; cents: number; refunded?: boolean }
const orders = await fero.of<Order>()('orders', {
  history: '7d',
  methods: {
    refund: { at: 'row', run: async (_: undefined, ctx) => {                  // S12: read a row, then write
      const o = await ctx.at.get()                                            // at the row's leader: served here, no trip
      if (!o || o.refunded) return { refunded: 0 }
      await ctx.at.set((now) => (now && !now.refunded ? { ...now, refunded: true } : now))   // re-checks at the write
      return { refunded: o.cents }
    } },
  },
})
export type Orders = typeof orders

export type Ev = { type: string; cents: number }
const events = await fero<Ev>('events', { server: true, rows: false, history: '7d' })   // S23: keeps no rows, a week of log
export type Events = typeof events
```

</details>

<details><summary>scenarios.ts: S1 to S23, and fifteen type equalities</summary>

```ts
// file: scenarios.ts — S1 to S23 on the surface this page recommends (S12's handler is in server.ts). Each compiles; none runs
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { useEffect, useState } from 'react'
import { shallowRef, watchEffect } from 'vue'
import { fero, op, derive, lock, type Version, type Cursor, type Rows, type RowsOf, type Live, type LiveRows, type Link,
  type Commit, type Turn, type Entry, type Changes, type Served, type Past } from 'fero'
import type { Item, Shop, Scores, Score, Msg, Here, Part, Orders, Events, Ev } from './server.js'
const shop = await fero<Shop>('shop')                                 // a client: it holds nothing
const chat = await fero<Msg, 2>('chat')                               // depth 2: a room is a partition

// S1 read one row once in an HTTP handler, and a field of it
createServer(async (req, res) => {
  const id = new URL(req.url ?? '/', 'http://x').searchParams.get('sku') ?? 'widgets'
  const item = await shop.at(id).get()                                // one GET, or none if held here; keeps nothing
  const stock = await shop.at(id, 'stock').get()                      // the field alone: one more GET (item?.stock: none)
  res.end(JSON.stringify({ name: item?.name, stock }))
}).listen(8080)

// S2 one field in a DOM element, live, until the element goes away
const label = document.querySelector('#stock')!
const shown = shop.data.widgets.stock.connect((n) => { label.textContent = String(n ?? '-') })
export function removeLabel() { label.remove(); shown.disconnect() }  // the code that removes it ends the link

// S3 a component that shows a row live and stops on unmount: disconnect is bound, so the effect returns it
export function useRow(id: string) {                                  // React
  const [row, setRow] = useState<Item>()
  useEffect(() => shop.at(id).connect(setRow).disconnect, [id])
  return row
}
export function useRoom(room: string) {                               // a room's value is one live object, the same at
  const [view, setView] = useState<{ rows: Rows<Msg> }>()             // each commit: wrap it, so React sees a new object
  useEffect(() => {
    const h = chat.at(room).connect((rows) => setView({ rows }))
    return () => { h.disconnect(); setView(undefined) }               // its rows end with the link ('ended'): drop them too
  }, [room])
  return view?.rows
}
let svelteRow: Item | undefined
$effect(() => shop.at(sku).connect((r) => { svelteRow = r }).disconnect)   // Svelte 5
export function useRowVue(id: string) {                               // Vue 3
  const row = shallowRef<Item>()
  watchEffect((onCleanup) => onCleanup(shop.at(id).connect((r) => { row.value = r }).disconnect))
  return row
}

// S4 forward a chat room to 1,000 WebSocket clients; each link ends when its socket closes
new WebSocketServer({ port: 8081 }).on('connection', (ws, req) => {
  const room = new URL(req.url ?? '/', 'http://x').searchParams.get('room') ?? 'lobby'
  chat.at(room).connect((_, c) => ws.send(c.text()), { until: ws })   // one SUB, one decode, one text() for every socket
})

// S5 a live top-10 leaderboard computed on a server (a served view), shown here
const fan = await fero<Scores>('scores')
const board = fan.data.best(10).connect((top) => render(Object.values(top)))   // an address: one SUB; only its changes cross

// S6 filter a room's messages here (local work) and render them
const room = chat.data.room1.connect()                                // the line: the room crosses whole, then its changes
room.filter((m) => !m.hidden).connect((shownMsgs) => render(shownMsgs))   // right of connect(): here. It ends with room

// S7 count every order exactly once into a totals resource (the log)
const orders = await fero<Orders>('orders')
const totals = await fero<number>('totals', { server: true })
await derive(orders, totals, (e) => { if (e.value) totals.at(e.value.user).set(op.incr(e.value.cents), { from: e }) })

// S8 replay a stream from a saved cursor, and save the cursor as you go
const log = orders.data.changes({ from: (await loadCursor()) ?? 'earliest' })
let n = 0
for await (const e of log) { save(e); if (++n % 100 === 0) await saveCursor(log.cursor) }   // at least once

// S9 a hot loop on a server, reading rows by key millions of times
const local = await fero<Item>('stock', { server: true })             // a server holds every row
let sum = 0
for (let i = 0; i < 1_000_000; i++) sum += local.rows[keys[i % keys.length]!]?.stock ?? 0   // one lookup each

// S10 a row as it was at a version, then one commit back
const parts = await fero<Part>('parts')                               // no methods, so this client may write
const ack = await parts.data.widgets.set({ stock: 3 })
const was = await parts.data.widgets.past(ack.version)               // one log read from the nearest snapshot, folded here
console.log(was.value?.stock, was.step(-1)?.value?.stock)            // a value: no link to end; undefined past the window

// S11 an undo button that uses the previous value of the last change
let undo: { prev: Part | undefined; version: Version } | undefined
const undoLink = parts.data.widgets.connect((_, c) => { const d = c.diff[0]; if (!c.first && d) undo = { prev: d.prev, version: d.version } })
export async function onUndo() {
  if (!undo) return
  const w = parts.data.widgets, guard = { if: { version: undo.version } }   // only if nothing came in between
  await (undo.prev ? w.set(undo.prev, guard) : w.remove(guard))
}

// S12 a method handler reading a row before it writes: refund in server.ts. The call:
const r12 = await orders.data.o7.refund()                            // at o7's leader: one trip, one commit

// S13 wait until a condition holds (stock > 0), then go on
const back = await shop.data.widgets.stock.get({ when: (s) => (s ?? 0) > 0, signal: AbortSignal.timeout(30_000) })

// S14 presence: who is online in a room, live
const online = await fero<Here, 2>('online')
await online.at('room1', fero.id()).set({ name: 'ada' })             // this row dies with this process's session
const who = online.at('room1').connect((people) => render(Object.values(people).map((p) => p?.name)))

// S15 read a few rows from different partitions at once
const [a, b, c] = await Promise.all(['widgets', 'gizmos', 'bolts'].map((key) => shop.at(key).get()))

// S16 a server-side job that must stop all its live reads when a request or job ends
createServer((req, res) => {                                          // a request: each link ends when res closes
  shop.data.widgets.connect((w) => res.write(`data: ${w?.stock}\n\n`), { until: res })
  shop.data.low(5).connect((low) => res.write(`data: ${Object.keys(low).length} low\n\n`), { until: res })
}).listen(8082)
await lock('nightly', async (signal) => {                             // a job: its signal ends its links, after any await
  for await (const [w] of shop.data.widgets.connect({ signal })) {    // a loop over live state: the newest each turn
    report(w?.stock)
    if ((w?.stock ?? 0) > 100) break                                  // break ends the link
  }
})

// S17 replay from a saved commit id, then keep going live
const shown17 = chat.at('room1').connect((rows, c) => render(rows, c.version))   // c.version: this commit's id, such as '38S9'
addEventListener('pagehide', () => localStorage.setItem('room1', shown17.cursor)) // save the place after it (built when read)
const mark = localStorage.getItem('room1') as Cursor | null          // later, on the next load: a feed of what came since
for await (const e of chat.at('room1').changes({ from: mark ?? 'latest', signal })) show(e.version, e.value)
// every record after that place, in order, then live: records, not the room. Given a saved version instead, { from: v }
// starts AT its commit. A screen that shows the room again needs its state too: S18's two calls, or question 3's resume

// S18 replay the last 5 commits of a room, then keep going live
for await (const e of chat.at('room1').changes({ from: -5, signal })) show(e.version, e.value)
// -5: the 5th last commit that touched room1, and all after it; the server counts back. It needs the log kept (history)
// ... and with state at each step: a past window to now, walked here, then a live link. Two calls, with a seam:
const recent = await chat.at('room1').past(-5, { to: 'latest' })
for (const [rows, step] of recent) show(Object.keys(rows).length, step.version, step.diff)   // the last 5, with state
const room1 = chat.at('room1').connect((rows, c) => render(rows, c.diff))       // its first call is a new picture

// S19 read a row as it was at a version, and as it was at a time (a writer time)
const { value: atVersion } = await parts.data.widgets.past(version)
const { value: atTime } = await parts.data.widgets.past(new Date('2026-11-19T12:00:00Z'))   // approximate across partitions

// S20 step through a row's versions from a version, forward and back (an audit or undo-history view)
const audit = await parts.data.widgets.past(version, { to: 'latest' })   // the window: from the nearest snapshot to now
for (const [row, step] of audit) show(step.version, row?.stock)      // forward, from version's own commit to now
const back1 = audit.step(-1), again = back1?.step(+1)                 // back and forth: each step a new value, never a move
show(back1?.version, back1?.value, again?.version)                   // undefined past the window's edge; 10-12 ns a step

// S21 read one value once with await, as simply as possible
const stockNow = await shop.at(sku, 'stock').get()                    // or await shop.data.widgets.stock.get()

// S22 tie a link to a lifetime (a request, a socket, a component) AND be able to disconnect it by hand early
createServer((req, res) => {
  const link = shop.at(sku).connect((row) => { res.write(`data: ${row?.stock}\n\n`); if (!row) link.disconnect() }, { until: res })
  setTimeout(link.disconnect, 60_000)                                 // by hand, early: safe twice, and it drops res's listener
}).listen(8083)
export function useStock(id: string, stop: AbortSignal) {             // a component, with a signal from its parent too
  const [n, setN] = useState<number>()
  useEffect(() => shop.at(id, 'stock').connect(setN, { signal: stop }).disconnect, [id])
  return n
}

// S23 an events resource with no rows kept (rows: false): every record from a saved cursor, saving as you go
const events = await fero<Events>('events')
const feed = events.data.changes({ from: (await loadCursor()) ?? 'earliest' })
for await (const e of feed) { await handle(e); await saveCursor(feed.cursor) }   // at least once; marks make it exactly once

console.log(board, who, r12, back, a, b, c, svelteRow, sum, atVersion, atTime, stockNow, undoLink, room1)

// the types carry through: each line fails to compile if a type is any or wrong
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type Item0<I> = I extends AsyncIterable<infer T> ? T : I extends Iterable<infer T> ? T : never
const rowLive = shop.data.widgets.connect(), roomLive = chat.data.room1.connect(), rowLink = shop.data.widgets.connect(draw)
const chatLive = chat.data.connect()
const t1: Eq<Awaited<ReturnType<typeof shop.data.widgets.get>>, Item | undefined> = true          // get: the row
const t2: Eq<typeof rowLive, Live<Item | undefined, Item, true>> = true                            // connect(): a handle and a loop
const t3: Eq<typeof roomLive, LiveRows<Msg, true>> = true                                          // a room: operators right of the line
const t4: Eq<typeof rowLink, Link<Item | undefined, Item>> = true                                  // connect(fn): a handle, not a loop
const t5: Eq<Item0<typeof roomLive>, [value: Rows<Msg>, c: Turn<Msg, true>]> = true               // a loop turn: [value, c]
const t6: Eq<Item0<ReturnType<typeof chat.data.room1.changes>>, Entry<Msg>> = true                 // the log: one record
const t7: Eq<Awaited<ReturnType<typeof parts.data.widgets.past>>, Past<Part | undefined, Part>> = true
const t8: Eq<Item0<typeof audit>, [value: Part | undefined, c: Commit<Part, true>]> = true         // a past walk: [value, c]
const t9: Eq<ReturnType<typeof fan.data.best>, Served<Score>> = true                               // a served view: an address
const t10: Eq<Commit<Item>['cursor'], Cursor> = true                                               // every commit has a place
const t11: Eq<Commit<Item, true>['version'], Version> = true                                       // inside one partition, an id
const t12: Eq<'version' extends keyof Commit<Msg, false> ? true : false, false> = true             // a whole resource: no one id
const t13: Eq<typeof chatLive, Live<RowsOf<Msg, 2>, Msg, false>> = true                           // the whole chat: a wide link
const t14: Eq<ReturnType<typeof events.data.e1.changes>, Changes<Ev>> = true                       // a stream: its log
const t15: Eq<ReturnType<typeof was.step>, Past<Part | undefined, Part> | undefined> = true      // a step: a new value
const minus5 = -5, lastFive = chat.data.room1.changes({ from: minus5 })                              // a const holding -5: a count
console.log(t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11, t12, t13, t14, t15, lastFive)
```

</details>

<details><summary>wrong.ts: the wrong uses refused</summary>

```ts
// file: wrong.ts — the wrong uses this page refuses. Each line under a @ts-expect-error must fail there, for the reason given
import { fero, type Rows } from 'fero'
import { useEffect, useState } from 'react'
import { EventEmitter } from 'node:events'
import type { Item, Shop, Msg, Part, Events } from './server.js'
const shop = await fero<Shop>('shop'), chat = await fero<Msg, 2>('chat'), parts = await fero<Part>('parts')
const events = await fero<Events>('events'), el = document.createElement('b'), n = 5
// @ts-expect-error 1. a lens is an address, never a promise: `await lens` gives the lens back. Read with get()
const stock: number | undefined = await shop.data.widgets.stock
// @ts-expect-error 2. the thenable trap: a handle is not thenable, so `await connect()` gives the handle, not the row
const row: Item | undefined = await shop.data.widgets.connect()
// @ts-expect-error 3. ... and it has no then(): "await the connect" is not a read once. Read once with get()
shop.data.widgets.connect().then((r: Item) => r)
// @ts-expect-error 4. a served view is an address too: awaiting it sends nothing and gives no rows
const low: Rows<Item> = await shop.data.low(5)
// @ts-expect-error 5. a function cannot travel to a server: connect() first, then filter right of it
chat.data.room1.filter((m: Msg) => !m.hidden).connect()
// @ts-expect-error 6. an operator over every row, on a client that holds nothing: call a view the server named
shop.data.za('stock', 10).connect()
// @ts-expect-error 7. the log looped as live state: a log entry is one record, with no state to destructure
for await (const [rows] of chat.data.room1.changes()) console.log(rows)
// @ts-expect-error 8. live state looped as the log: a turn is [value, c], newest state; it has no per-record version
for await (const e of chat.data.room1.connect()) console.log(e.version)
// @ts-expect-error 9. a log entry has no prev: the log is every record, not a folded state
for await (const e of shop.data.changes()) console.log(e.prev)
// @ts-expect-error 10. a handle with a callback is not also a loop (one handle cannot get break right for both)
for await (const x of shop.data.widgets.connect(draw)) console.log(x)
// @ts-expect-error 11. `from` on connect: every commit from a place is the log, changes({ from }), or a past() window
shop.data.widgets.connect(draw, { from: version })
// @ts-expect-error 12. a read once is get(), not connect({ once })
shop.data.widgets.connect({ once: true })
// @ts-expect-error 13. get at a position hides a fold of the log: as it was is past(pos)
shop.data.widgets.get({ at: version })
// @ts-expect-error 14. `at` on connect: connect is now; as it was is past(pos)
shop.data.widgets.connect(draw, { at: version })
// @ts-expect-error 15. past() is a promise of the value: await it first, (await lens.past(v)).value
console.log(parts.data.widgets.past(version).value)
// @ts-expect-error 16. a count back needs one partition: on the whole resource give a time, new Date(...)
chat.data.changes({ from: -5 })
// @ts-expect-error 17. ... and so does a version: it names one partition's commit, and does not say whose
chat.data.changes({ from: version })
// @ts-expect-error 18. a time is a Date, never a bare number: on one partition a number would be a count back
parts.data.widgets.past(Date.now() - 3_600_000)
// @ts-expect-error 19. ... the same on the log
chat.data.room1.changes({ from: Date.now() - 60_000 })
// @ts-expect-error 20. a count back is a literal: a value typed number is refused (it is most often a time)
chat.data.room1.changes({ from: -n })
// @ts-expect-error 21. a count back is negative: -5 is 5 commits back
chat.data.room1.changes({ from: 5 })
// @ts-expect-error 22. past() reads one partition: on a wider lens it would fold every partition here; read the log from a time
shop.data.past(new Date('2026-11-19T12:00:00Z'))
// @ts-expect-error 23. a whole-resource commit has no single id (no order across partitions): save c.cursor
chat.data.connect((rows, c) => console.log(c.version))
// @ts-expect-error 24. `until` takes a thing that says it closed; a place to stop the log at is `to`
chat.data.room1.changes({ from: -5, until: 'latest' })
// @ts-expect-error 25. a DOM node never says it closed, so `until` refuses it: pass a signal, or disconnect()
shop.data.widgets.stock.connect((v) => { el.textContent = String(v) }, { until: el })
// @ts-expect-error 26. ... and so is an EventSource (it has close(), but no 'close' event)
shop.data.widgets.connect(draw, { until: new EventSource('/x') })
// @ts-expect-error 27. ... and a plain emitter: it cannot say it already closed, so a late one would never end the link
shop.data.widgets.connect(draw, { until: new EventEmitter() })
// @ts-expect-error 28. an effect must return disconnect, not the handle, or the link never ends (React's own type)
export function Bad() { const [, set] = useState<Item>(); useEffect(() => shop.data.widgets.connect(set), []) }
// @ts-expect-error 29. a stream keeps no rows (rows: false): there is no state to connect to; read its log
events.data.e1.connect()
// @ts-expect-error 30. ... nor a value to get
events.data.e1.get()
// @ts-expect-error 31. ... nor a past
events.data.e1.past(-1)
// @ts-expect-error 32. get takes no key: the step by a key is at(key), then get()
await shop.data.get(sku)
// @ts-expect-error 33. one live verb: on, live, here and tap are gone; connect(fn) does their job
shop.data.widgets.on(draw)
// @ts-expect-error 34. rows handed to a function are frozen: read-only
shop.data.widgets.connect((w, c) => { c.diff[0]!.prev = undefined })
// @ts-expect-error 35. c.changes is c.diff, so "changes" names only the log
shop.data.widgets.connect((w, c) => c.changes)
// @ts-expect-error 36. a lens is not a store: connect(fn)
shop.data.widgets.subscribe(() => {})
// @ts-expect-error 37. f.rows on a bare client: every row is not held here
shop.rows.widgets
// @ts-expect-error 38. a probe name reads undefined: a row named 'then' is f.at('then')
shop.data.then.get()
// @ts-expect-error 39. f.snapshot is gone: rows[k] for one row; a copy is a spread you write, { ...h.value }
shop.snapshot
// @ts-expect-error 40. a lens that went through Promise.resolve (or Promise.all) is still an address, never a row
const viaResolve: Item | undefined = await Promise.resolve(shop.at(sku))
await fero.of<Item>()('shop2', { methods: {
  // @ts-expect-error 41. a method named like a fero verb where it is called (connect, on a row) is refused here
  connect: { at: 'row', run: (k: number, ctx) => ctx.at.stock.set(k) },
  best: { view: (k: number, ctx) => ctx.data.za('stock', k) },
} })
// @ts-expect-error 42. a loop turn merges commits: it has no wire records to forward; use connect(fn) or changes()
for await (const [, c] of chat.data.room1.connect()) ws.send(c.text())
// @ts-expect-error 43. an HTTP request may say it closed once its body is read, while the client stays: pass the response
shop.data.widgets.connect(draw, { until: req })
console.log(stock, row, low, viaResolve)
```

</details>

```js check
// CONNECT.md checker: every ```ts block of this page whose first line is "// file: <name>" goes into a fresh folder
// and must type-check. Then, in a copy where each @ts-expect-error is a plain comment, each line it marks must
// fail, and nothing else may (the strip proof). Self-contained: tsc on PATH is all it needs. Adapted from READS.md's.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const blocks = [...readFileSync(process.argv[1], 'utf8').matchAll(/^```ts\n(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)^```$/gm)]
  .map(([, body, name]) => [name, body])
const want = ['combo.ts', 'fero.d.ts', 'env.d.ts', 'server.ts', 'scenarios.ts', 'wrong.ts']
const lost = want.filter((w) => !blocks.some(([name]) => name === w))
if (lost.length) { console.log('missing blocks:', lost); process.exit(1) }
const root = mkdtempSync(join(tmpdir(), 'fero-connect-'))
const compilerOptions = { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true,
  types: [], lib: ['es2022', 'dom', 'esnext.disposable'] }
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

Run from the repo root, with tsc on `PATH`:

```sh
node --input-type=module -e "$(awk '/^```js check$/{f=1;next} /^```$/{f=0} f' docs/v5-space/CONNECT.md)" docs/v5-space/CONNECT.md
```

**Result, run here on 2026-11-20** (Node v22.22.0, TypeScript 6.0.2): `ok: 6 blocks type-check (tsc Version 6.0.2)`, then `43 marked lines, 43 fail at their own line, 0 errors elsewhere`. Each stripped line fails for the reason its comment gives:

| wrong.ts line (item) | The wrong use | tsc |
|---|---|---|
| 9 (1) | `await` a lens, used as a number | TS2322: `Lens<number, …>` is not a number |
| 11, 13 (2, 3) | `await lens.connect()` used as the row; `.then` on a handle | TS2739: the handle lacks `name`, `stock`, `price`; TS2339: no `then` |
| 15 (4) | `await` a served view, used as rows | TS2322: `Served<Item, false>` is not `Rows<Item>` |
| 17, 19 (5, 6) | `filter(fn)` left of `connect()`; an operator over every row on a bare client | TS2349, with the fix in the type's text |
| 21, 23, 25 (7, 8, 9) | the log looped as live state; live state looped as the log; `e.prev` on a log entry | TS2488; TS2339 (no `version` on a `[value, c]` turn); TS2339 (no `prev` on `Entry`) |
| 27 (10) | a loop over a handle made with a callback | TS2504: no `[Symbol.asyncIterator]` on `Link` |
| 29, 31, 33, 35 (11-14) | `from` on `connect`; `{ once }`; `get({ at })`; `at` on `connect` | TS2322 with the message's text (it names `changes()` and `past()`); TS2769; TS2769; TS2322 |
| 37 (15) | `.value` on `past(v)` before `await` | TS2339 on `Promise<Past<…>>` |
| 39, 41 (16, 17) | `from: -5` and `from: version` on the whole resource | TS2322 on `Pos<false>`, whose text says "a version or a count back names one partition" |
| 43, 45 (18, 19) | a bare number as a time, on `past` and on the log | TS2345 and TS2322: "a time is a Date; a count back is a literal such as -5" |
| 47, 49 (20, 21) | a count in a variable; a positive count | TS2322: "a time is a Date…"; "a count back is negative" |
| 51 (22) | `past` on the whole resource | TS2349: its text names `changes({ from: new Date(...) })` |
| 53 (23) | `c.version` on a whole-resource link | TS2339: no `version` on `Diff<Msg>` |
| 55 (24) | a place in `until` | TS2322: `until` takes `Closes` |
| 57, 59, 61 (25, 26, 27) | `until` with a DOM element, an `EventSource`, a plain emitter | TS2322: not `Closes` |
| 63 (28) | a React effect that returns the handle, not `disconnect` | TS2322 against React's effect type (a stand-in in env.d.ts) |
| 65, 67, 69 (29, 30, 31) | `connect()`, `get()` and `past()` on a stream (`rows: false`) | TS2349, the type's text says "read its log with changes()" |
| 71 (32) | `shop.data.get(sku)`: a key passed to `get` | TS2769 |
| 73, 77 (33, 35) | `on` (gone); `c.changes` (now `c.diff`) | TS2339 |
| 75 (34) | changing a row handed to a callback | TS2540: read-only |
| 79 (36) | `subscribe` | TS2349: "a lens is not a store: lens.connect(fn)" |
| 81 (37) | `shop.rows` on a bare client | TS2339 on the `f.rows` message |
| 83 (38) | `shop.data.then` | TS18048: a probe name reads `undefined` |
| 85 (39) | `shop.snapshot` | TS2339 |
| 87 (40) | a lens through `Promise.resolve`, used as a row | TS2322: a `Lens` is not an `Item` |
| 90 (41) | a row method named `connect` | TS2322: a fero word where it would be called |
| 94 (42) | `c.text()` on a loop turn | TS2349: `text` on a `Turn` is a message that names `connect(fn)` and `changes()` |
| 96 (43) | an HTTP request as `until` | TS2322: `IncomingMessage` is not `Closes` (it has a `method`) |

- **What the types cannot say** *(reasoned)*. A forgotten `.get()` that is printed, not assigned, `JSON.stringify(await shop.at(id))`, compiles and prints `undefined` (5.2). A version from another partition, given as `from` on one partition, compiles; the server refuses most such versions `bad-position`, but one from another slot can land on this partition's own record and give a quiet wrong answer (3.2). Reading a partition's value after its link ended compiles and throws `ended` at run time (2.1). A target of the right shape that never closes, such as a Node stream made with `emitClose: false`, compiles *(from memory)*. A `Date` that is not valid compiles and is refused `bad-position` at run time.
- **Not checked here: that any of it runs.** Nothing on this page is built. What ran is E-56: the owner's `connect` on E-55's prototype, and the costs of positions, hash chains and Merkle trees ([E-56 README](experiments/E56-one-connect/README.md)).
