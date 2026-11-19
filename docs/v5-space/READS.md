# How code gets data: one recommendation

Written 2026-11-19. Docs only; nothing here is built. It answers the owner's note on [API.md](API.md) after the connect lens ([DECISIONS V5-12](../DECISIONS.md)): the owner was unsure about the mix of `tap`, `connect`, `here` and `changes`, the ways code gets data, and expected a better mix to exist. It also answers two questions: why a root method is `f.methods.low(5)` when a path method is `f.data.widgets.sell(1)` (section 4), and what the other names for `asOf` are (section 5).

**How it was made.** Four designers each proposed a read surface from one brief. Each had a different aim: the fewest words, the platform's own habits, the owner's own picture, and what a newcomer would guess. Each wrote all sixteen scenarios and type-checked them. Two judges scored the four and today's shape. Both picked the "newcomer's guess" proposal (32 of 40 from each), with parts taken from the others. This page is that pick with those parts in, checked again (section 10). The proposals and the judges' notes are working files, not kept in the repo; section 6 says what came from each. A skeptic then checked this page, and its fixes are in.

**Words.** A **lens** is an address, such as `shop.data.widgets.stock`: building one does no work. A **trip** is one message there and its answer back, about 40 µs on one box ([E-01](experiments/E01-floors)). A **SUB** is fero's one subscribe message; in state mode it sends rows then their changes, in log mode every record. A **partition** is the rows one leader keeps in one order (by default each row is its own). A **link** is one live connection from a lens into this process. The **picture** is the rows so far, which a link gets first; then it gets each commit. **Held on purpose**: rows this process keeps because it serves the resource, said `hold: 'all'`, or has a live link on them. **The collector** is JavaScript's garbage collector. **The net** is today's backstop: the collector may end a weak link once its target is gone. The **linger** is a short wait before an unsubscribe, so a link closed and opened again reuses its SUB. **Probe names** are seven names libraries read to test what an object is, such as `then` and `toJSON`; on a lens they read `undefined`. A **microtask** is a step JavaScript runs right after the current code, before any new event. **Duck-typing** is a library guessing what an object is from the names it has. A **frame** is one message on the wire; it may carry several commits. A **rule** is one thing a builder of fero must get right ([SIMPLICITY](SIMPLICITY.md)); the base has 416.

**Marks.** *(measured, source)*: a number from a named experiment or page. *(checked)*: tsc 6.0.2 compiled it, or refused it, in section 10. *(reasoned)*: an argument; nothing ran it. *(a guess)*: nobody measured it. *(from memory)*: an outside fact not checked here. The judges' scores are judgement, not measurement.

---

## 0. What to review

```ts
// file: combo.ts — how code gets data, on one screen
import { fero } from 'fero'
import { useEffect } from 'react'
import type { Shop, Msg } from './server.js'
const shop = await fero<Shop>('shop'), chat = await fero<Msg, 2>('chat')   // clients: they hold nothing yet

const item = await shop.at(sku).get()                               // ONCE: one trip, or none if held here. Keeps nothing
const w = await shop.data.widgets.live({ signal }).ready            // LIVE: keep it here; then w.value is a sync read
shop.at(sku).on((row, c) => draw(row, c.diff), { until: ws })       // LIVE, AND CALL ME: once per commit, value first
chat.data.room1.live().filter((m) => !m.hidden).on(render)          // left of live(): may run on a server. Right: here
shop.data.low(5).on(render)                                         // a view the server named: an address, not a promise
for await (const e of shop.data.changes({ from: cursor })) save(e)  // THE LOG: every record, in order; it waits for you
const p = await shop.at(sku).past(version); p.step(-1)              // AS IT WAS: a reader, folded here (was asOf)
useEffect(() => shop.at(id).on(draw).close, [id])                   // ends at close(), { signal }, { until }: never the GC
const hot = await fero<Shop>('shop', { hold: 'all' }); hot.rows[k]  // HOT: one lookup, where every row is held
console.log(item, w.value)
```

1. **Five verbs, one job each, named by what you get back.** `get()` once. `live()` keep it here. `on(fn)` keep it here and call me. `changes()` every record. `past(pos)` as it was. They match the wire's three messages: `get` is a GET (but `get({ when })` holds a SUB while it waits), `live` and `on` are a SUB of state, `changes` and `past` are a SUB of the log. **`connect` and `scope` go; `here`, `tap` and `asOf` are renamed `live`, `on` and `past`.** So the jobs are today's. What changes is smaller than the names: how long a link lives leaves the verbs and becomes an option, the weak link goes, the callback gets the value first, and a served view becomes an address.
2. **How long a link lives is an option, not a verb:** `close()`, `{ signal }`, or `{ until: socket }`. `close` is bound, so a framework effect can return it. Every link is strong, and the collector never ends one. That is a plain no to the owner's first wish, weak links that nobody has to end, because the collector cannot do that job: 0 of 1,000 links ended in 30 s in Chromium *(measured, [E-55](experiments/E55-lens-prototype/README.md) claim 13)*.
3. **A root method goes on the root lens: `f.data.low(5)`; `f.methods` goes.** A method named like a fero word is refused where it is declared. A served view is declared `{ view }`, and calling it gives an address, never a promise. `at: 'row' | 'partition' | 'any'` stays as V5-12 approved it.
4. **`asOf` becomes `past`.** Keeping `asOf` is the runner-up (section 5).
5. **The price.** S2 on a page with no framework needs an `AbortController` and an `abort()` where today one `connect(el, 'textContent')` did. A link nobody closes runs until the process ends: there is no net. A job's links each take an option, where one `scope` covered them. The rules move about −2 to +7 on 416 *(reasoned)*. Six choices are the owner's (section 9).

---

## 1. What is wrong with today's combo

The owner's feeling, made specific. Each point quotes [API.md](API.md).

- **Three live verbs that differ only in who gets the commits and how long the link lasts.** "`connect(target, fn | 'prop')` is `here()` tied to a target. `tap((c) => …)` is a strong sink on anything live" (3.10). All three open the same subscription: "Every `here()`, `tap` and `connect` on one selection in a process shares one SUB" (3.10). So each word answers two separate questions at once: who gets the commits, and how long the link lasts. Add `scope(fn)`, `dispose()` and `closes:`, and there are six words for "keep it live, then end it".
- **"changes" names two different things.** `c.changes` is "this commit's changes … each has `prev`", folded one per row. `lens.changes()` is "every committed record … with no `prev`", and "`changes()` and `here()` give different things on purpose" (3.10). The shared name says they are the same.
- **The weak link is E-55's one measured miss, and it buys little.** "10,000 weak links cost 2.2 times 10,000 strong sinks (a miss against the bar of 1.1)" (3.10; E-55 claim 11). It needs a user rule of its own ("A `connect` function takes its target as an argument and changes nothing else", rule 6) and three builder rules "to make the net harmless" (3.10). In a browser the net did not fire at all within 30 s (claim 13).
- **A served view is a promise.** `export interface Served<Row> extends PromiseLike<Rows<Row>> { here(): View<Row> }` (section 6), and "`await` it for one picture, or `here()` it" (3.8). So an `async` helper that returns `f.methods.low(5)` sends the call, and a page that awaits it and also holds it runs the view twice *(reasoned)*. That is the mistake E-55 removed from the lens (claim 4), one level up.
- **`scope(fn)` sees only links made before the first `await` inside it.** E-55's prototype sets a variable around a synchronous call *(code: E-55's `proto/lens.mjs` lines 56-64)*. So a job that awaits makes its links outside the scope *(reasoned)*.
- **One scenario has no clean line, and one has only a coarse guard.** S13, "wait until stock > 0", needs a `tap` that resolves a promise and a `close()` by hand. S11, an undo, can guard its write only by the whole row: `set(prev, { if: { equals: row } })`, or `set(fn)` (3.7). "The undo write needs a condition (`if: { version }`)" (3.12), but the commit argument carries no version. A version is a smaller guard, and it also catches a row that was changed and then changed back.
- **Three places for one job.** "`f.data` is the address of everything … `f.methods` holds the calls with no path" (section 2). A method is `lens.sell(1)` on a path but `f.methods.low(5)` at the root.

The judges scored today's shape 19 and 20 of 40, last of the five.

---

## 2. The recommended surface

### 2.1 Each word and its one job

| Word | Its one job | What it costs |
|---|---|---|
| `lens.get()` | read once; hold nothing. `{ fresh }` asks the leader; `{ when }` waits until a test passes, then reads | held here: no trip. The read under it is 0.17-0.29 µs with one key, 1.6-1.7 µs with keys spread over 1e6 rows *(measured as a sync read, E-55 claim 1, via API.md 3.9)*; the promise adds a microtask, not measured. Not held: one trip and nothing kept: 100,000 misses made 100,000 GETs, 0 SUBs *(measured, claim 20)* |
| `lens.live()` | keep the lens's partition live here, and give a handle to read it | the first on a partition: one SUB; a 100-row room's first picture 26-28 µs, or 0.16-0.23 ms right after a full collection. Another on a held selection: 163-169 ns, of which the lookup and count are 39-45 ns *(measured for `here()`, claim 6)* |
| `lens.on(fn)` | `live()`, plus `fn(value, c)` on the picture and once per commit. Returns the same handle. A first argument that is not a function is refused `bad-arg` | 92-198 ns a commit over no sink, of which 63-122 ns is data's own delivery; and freezing each row handed out, once, 163-220 ns per changed row *(measured, claim 10)* |
| `lens.changes()` | the log: every committed record under the lens, in order, from a position. `r.cursor` is a bookmark | one trip to open, then every record (API.md 3.10) |
| `lens.past(pos)` | the lens as it was at a version, cursor or time. `step(n)` and `seek(pos)` move it | to open 3.6-4.4 µs a record; a step 10-12 ns *(measured, claim 23)* |
| `h.value`, `h.ready` | the state now, a sync read (it throws `not-ready` before the first picture); a promise of the handle once the picture is here | one lookup |
| `h.close`, `h.closed` | end the link now (a bound function); a promise that settles when the link ends, and rejects with why if it failed (`expired`, `too-many-views`, a lost lease). It is made only when first read (2.2) | — |
| `c.first`, `c.diff`, `c.text()`, `c.recs()` | true once; this commit's rows, each with `prev` and the row's `version`; the records as JSON text and as records, each built once per commit and shared | reading `diff` and each `prev`: −39 to +32 ns *(measured, claim 10)*. `version`: not measured |
| `{ signal }`, `{ until }` | end a link when a signal aborts, or when a socket, stream, HTTP response or WebSocket says it closed | one listener per signal, a set entry per link (2.2) |
| `f.rows[k]` | the hot sync read, where every row is held: a server, or `hold: 'all'` | a `Map` read plus one trap. The `Map` read alone: 43-51 ns at 1,000 rows, about 1 µs at 1e6 *(measured, [PATHS 4.1](PATHS.md))*; the trap is not measured apart |
| `f.data.name(arg)` | a root method (a bare function, or `at: 'any'`): an action, sent at once; or a `{ view }`, an address you `get`, `live` or `on` | as a call; a view as `live()` |
| `f.at(...keys)`, `lens.call(name, arg)` | a step by a key from input or a key named like a fero word; a method by a name in a variable, or any method on a handle typed by its rows only | `at`: −79 to +33 ns over the direct read *(measured, claim 1)* |

- **Gone:** `here`, `tap`, `connect`, `closes`, `scope`, `dispose`, `c.now` (the value is now the first argument), `c.changes` (now `c.diff`), a handle's `rows` (its `value` is the rows), `asOf`, `f.snapshot` and `f.methods`.
- **What `value` is.** For a row or a field, a new frozen object at each write. For a partition or the whole resource, one live view, the same object at each commit; nothing is copied. So code that compares by identity, such as React's state setter, Vue's `shallowRef` or Svelte's `$state`, needs a new small wrapper each commit: `setView({ rows })`, as S3's `useRoom` does *(checked: scenarios.ts S3)*. A fresh copy each commit would be a hidden O(rows) copy *(reasoned; found by the fewest-words proposal)*.
- **Overlaps, kept on purpose.** `lens.on(fn)` is `lens.live().on(fn)` in one call. `get({ when })` holds a partition while it waits, so "`get` holds nothing" has that one exception. `until` is a thing that closes on a link, and a position on `changes()`; in both places it says when a thing ends.
- **Count.** Counted the fewest-words proposal's way (every name a user learns to read data; `until` once): today 31 words, this page 27, the fewest-words proposal 20 *(reasoned)*. The words for "keep it live, then end it" go from six (`here`, `tap`, `connect`, `closes`, `scope`, `dispose`) to four (`live`, `on`, `signal`, `until`), and `signal` is the platform's own.

### 2.2 Lifetimes: every live thing ends by your code

| The live thing | It ends at the first of |
|---|---|
| a handle from `live()` or `on()` | `close()`; its `signal` aborts; its `until` says it closed; a framework effect's cleanup, which returns `close`. When the last link on a selection ends, the unsubscribe goes after a short linger |
| a view right of `live()` (`filter`, `map`, …) | its own `close()`, or the end of the handle it was made from *(measured: 59,958 view sinks, 0 calls after the end, E-55 claim 26)* |
| `get({ when })` | the test passes, its `signal` aborts, or its `timeout`. With neither, it waits as long as the test fails |
| a `changes()` reader | `break`, `close()` or its `signal` |
| a `past()` reader | `close()` |
| the live reads of a method handler, or of a lock's job | `ctx.signal` (the call ends) or the lock's signal (the lock is lost, or the job ends) |
| everything | the process's clean stop (V4-8) |

- **The collector never ends a link.** In development, fero warns, with the path, when a link's handle is collected while the link is open. It warns only for a link with no `signal`, no `until` and no parent handle. A kept `close` keeps its handle, so an effect that returns `close` never warns. The link keeps running, so no result depends on the collector *(reasoned; not built)*. A script that opens a link for its whole life and drops the handle would warn; it keeps the handle in a variable (section 8 counts this on the 28 examples). That is how data already uses `WeakRef`: "GC timing can never change observable results" *(code: data's `kernel/scope.ts` lines 1-3, as LENS 2.2 cites it)*. `f.cluster` lists live links by path, with counts, so a leak shows *(reasoned)*.
- **`until` checks a shape, not a promise to close.** It takes three shapes: a Node socket, stream or HTTP response (`once('close')` and `destroyed`); the `ws` library's socket (`once('close')` and `readyState`); a WebSocket in a browser or in Node 22 (`close()`, `readyState` and `onclose`). The types refuse a DOM element, a `<dialog>`, `window`, `document`, an `EventSource`, a `BroadcastChannel` and an `AudioContext`; none of them says it closed *(checked: wrong.ts items 5, 20, 21; the rest by probes, section 10)*. At run time fero checks the same shape, and refuses another object `bad-target` *(reasoned)*. A target of the right shape may still never close, such as a Node stream made with `emitClose: false` *(from memory)*. A `MessagePort` takes a signal.
- **`close` is bound.** So `useEffect(() => lens.on(fn).close, [id])` works in React. The same `close` works in Svelte's `$effect`, and in Vue's `watchEffect` through its `onCleanup`, with no fero package *(checked: scenarios.ts S3)*. For a room, see "What `value` is" in 2.1. Returning the handle instead of its `close` is refused by React's effect type *(checked against a stand-in of that type: wrong.ts item 16)*. A handle is also `Disposable`, so `using` works where it parses; Node 22 cannot parse `using` when it strips types (found by three of the proposals), so `close()` is the form shown.
- **The first call of `fn` comes after `on()` returns**, a microtask later. So `const h = lens.on((v) => { if (done(v)) h.close() })` is always safe. E-55's prototype calls it inside the call when the selection is ready *(code: `proto/lens.mjs` lines 411-424)*. Here fero registers the link and takes the picture in that same microtask, so no commit can fall between them, even when one frame carries several commits *(reasoned; not run)*.
- **fero listens once per signal, not once per link.** With a listener per link, adding one cost 1.6-1.7 µs at 1,000 links on one signal and 20.8-21.5 µs at 10,000: the total grows like n squared. One listener and a set cost 0.13-0.19 µs a link at 1,000 to 10,000 links; at 10 and 100 links, set-up rules (7.2-8.8 and 0.45-0.61 µs) *(measured in the platform proposal's bench, three runs, not under the timing lock; the bench is not kept in the repo)*.
- **A failure is never lost, and never crashes the process.** `closed` is made only when code first reads it. A link that fails while nobody reads `closed` prints one stderr line with its path and code, as V4-47's `Fault` does for a user's throw. It never becomes an unhandled rejection, which Node 15 and later turn into a crash *(reasoned; Node's default from memory)*.
- **`on` refuses a first argument that is not a function** (`bad-arg`). Every step on a lens is a function, so Node's stream helpers, which look for `on` and `pipe` functions, can take a lens for a stream and call `lens.on('error', fn)`. The refusal makes that loud *(reasoned)*.

### 2.3 The line between server work and local work

Unchanged from V5-12, but for the word: **the line is `live()` or `on()`**. Left of it is plain data, which may run on a server (later: V5-12 pick 2). Right of it is your code, here.

- A function left of the line does not compile *(checked: wrong.ts item 7)*. An operator over every row on a client that holds nothing does not compile either, and the error names the way out, a view the server named *(checked: wrong.ts item 8)*.
- A view the server named takes no operators left of the line: each new shape would be work on a server for every write, past the cap's count. Put them right of `live()`, here *(checked: wrong.ts item 22)*.
- The first build sends whole partitions (V5-12 pick 2). `shop.at(sku).on(fn)` holds that row's partition.

### 2.4 The evidence it must respect

| # | E-55's evidence ([LENS 6](LENS.md)) | How this meets it |
|---|---|---|
| 1 | a lens is never a promise | kept, and a served view is an address too; the probe names read `undefined` in the types as well *(checked: wrong.ts items 1, 2, 23)* |
| 2 | a read is served here only from rows held on purpose | every link is strong, so every held row is held on purpose |
| 3 | the collector is only a net | it is not even a net; in development it only warns, and only for a link with no `signal`, `until` or parent |
| 4 | a function that names its target keeps it; a weak link costs 2.2 times | no weak link, so no target to capture and no 2.2 times |
| 5 | live state and the log differ on purpose | `c.diff` and `changes()`; a live handle cannot be looped like the log *(checked: wrong.ts items 3, 4)* |
| 6 | whole partitions; a client's view over every row is a named method with a cap | kept; the types refuse the operator, name the view, and refuse operators on a served view *(checked: wrong.ts items 8, 22)* |
| 7 | one call per commit, rows frozen, a callback is not free | kept *(checked: wrong.ts item 15)*; the call costs 92-198 ns a commit, the freeze 163-220 ns per changed row (2.1) |
| 8 | no hidden trips, copies, decodes or whole-resource work | `f.snapshot`'s walk goes; `get({ when })` holds a partition, and says so on the line |
| 9 | types work for a typed client | `fero<Shop>('shop')` with `import type` *(checked: types.ts, twelve type equalities)* |

### 2.5 What it costs, against today

| What | Change | Mark |
|---|---|---|
| no weak link | **saves** +28 to +35 ns per link per commit, and 0.13-0.33 µs to set each one up. For S4's 1,000 sockets, 28-35 µs a commit: about 0.3 % beside the socket writes (8-14 µs each, 8-14 ms a tick) | measured parts, E-55 claims 6 and 11, [E-08](experiments/E08-relay-fanout) via PATHS 4.7; the sum reasoned |
| no `f.snapshot` | **removes** a hidden walk of every row on each access: 87 µs at 1,000 rows, 0.5 s at 1e6. A copy is now a spread you write, `{ ...h.value }` | measured, PATHS 4.1 |
| a served view as an address | **saves** the second run of a view that was both awaited and held | reasoned |
| `{ signal }` | one listener per signal; 0.13-0.19 µs a link at 1,000 to 10,000 links | measured in a proposal's bench, rough |
| `{ until }` | a shape check and one `once('close')` per link | a guess: under 1 µs |
| `version` on each diff entry | the row's place in its log, already known where the frame lands | reasoned; not measured |
| the method table at open | a few bytes a method, so a client knows actions from views and refuses an unknown name; fetched again when a server shows a newer one (section 4) | reasoned |
| `get({ when })` | as `live()` while it waits, then an unsubscribe after the linger | reasoned |
| **a link nobody closed** | its SUB, decode, fold and callback on every commit until the process ends: 0.80-0.90 ms a commit per 1,000 such links | measured for uncollected weak targets, E-55 claim 12; the same work here, reasoned |

---

## 3. Every scenario: today and recommended

Each recommended line is in `scenarios.ts` (section 10), which compiles *(checked)*. "Today" is API.md's shape.

| S | What | Today | Recommended |
|---|---|---|---|
| 1 | read a row once in an HTTP handler, and a field | `await shop.at(id).get()` | the same; `shop.at(id, 'stock').get()` for the field |
| 2 | a field in a DOM element until it goes | `stock.connect(el, 'textContent')`; ends at `close()`, a scope, or the net (never within 30 s in Chromium) | `stock.on((n) => { el.textContent = String(n) }, { signal })`, and `abort()` where your code removes `el` |
| 3 | React (and Svelte, Vue), stops on unmount | `useEffect` with a `tap` (it holds by itself) and a cleanup that calls its `close()` | `useEffect(() => shop.at(id).on(setRow).close, [id])`; the same `close` in `$effect` and `watchEffect`. A room wraps its value: `setView({ rows })` |
| 4 | a room to 1,000 sockets; each ends with its socket | `chat.data[room].connect(ws, (ws, c) => ws.send(c.text()))`, held weakly | `chat.at(room).on((_, c) => ws.send(c.text()), { until: ws })`, held strongly |
| 5 | a top-10 served view, shown here | `fan.methods.top(10).here()`, also a promise | `fan.data.best(10).on(render)`, an address |
| 6 | filter a room here, render it | `room.filter(fn).tap((c) => render(c.now.rows))` | `room.filter(fn).on(render)` |
| 7 | count every order exactly once | `derive(orders, totals, fn)` | the same |
| 8 | replay from a saved cursor, save as you go | `changes({ from })`, `r.cursor` | the same |
| 9 | a hot loop on a server | `shop.rows[k]` | the same |
| 10 | a row at a version, then one commit back | `(await lens.asOf(v)).step(-1)` | `(await lens.past(v)).step(-1)` |
| 11 | an undo with the previous value | `tap((c) => c.changes.at(-1))`: `prev`; the write guarded by the whole row, `if: { equals: row }`, or `set(fn)` | `on((_, c) => c.diff[0])`: `prev` and `version`; `set(prev, { if: { version } })`, a smaller guard |
| 12 | a handler reads a row, then writes | `await ctx.at.get()` | the same |
| 13 | wait until stock > 0 | a `tap` that resolves a promise, then `close()`: by hand | `await stock.get({ when: (n) => (n ?? 0) > 0 })` |
| 14 | who is online in a room | P-13 holds every row, `online.data.here()`, since it has no rooms; `online.data.room1.here()` would work today | `online.at('room1').on(render)`: one room. A fix to the pattern, not to the surface |
| 15 | a few rows from different partitions | `Promise.all(ids.map((id) => f.at(id).get()))` | the same |
| 16 | stop a request's or a job's live reads when it ends | `scope(fn)` and `dispose()`, around sync code only: a link made after an `await` escapes it | `{ until: res }` for a request; `lock(name, (signal) => …)` or `{ signal }` for a job; `ctx.signal` in a handler. One option on each link, after any `await`; a link that forgets it has no net |

Six scenarios do not change (1, 7, 8, 9, 12, 15). One that had no clean line gets one (13). One gets a smaller guard (11), and one a pattern fix (14). One gets longer (2). One is a trade (16): it works after an `await`, but each link carries its option, and a forgotten one has no net.

---

## 4. Methods at the root

**The owner asked** whether a root method should be called as `resource.data.method()`, since a method on a path is called as `resource.data.foo.method()`.

**Why it was `f.methods`.** v4 had `f.methods`, because v4 had no methods on paths. LENS kept it at the root for one reason: the names after `f.data` are row keys, which are data, not a schema, so "the root keeps a space where nothing can clash" ([LENS 4.1](LENS.md)). The lens-first proposal in that study had already dropped it.

| For `f.data.low(5)` | For `f.methods.low(5)` |
|---|---|
| one rule covers every method: it is called on the lens where it runs, and the root is a lens *(reasoned)* | the root has the most fero words (verbs, operators, probe names: about 30), so a clash is likelier there; in `f.methods` no root method needs renaming *(reasoned)* |
| a name is a key until it is called: `f.data.low(5)` calls, `f.data.low.get()` reads the row named `low` *(reasoned from claim 4's mechanism, which E-55 tested on paths and with `f.data.call('low', 5)`, not beside a row named `low`; checked: types.ts t8)* | `f.methods.` lists only methods in an editor |
| a key from input already takes `at()` (API.md 3.9), so the root was never a clean data space | a word fero adds later can break an app that used it as a root method's name |
| one place fewer: "three places, one job each" becomes two | 50 lines in 30 example files call `.methods.` *(checked here, grep)* |
| | no method table needed at the root, so none can be missing or stale (rule 3) |

**Pick: `f.data.low(5)`, and `f.methods` goes.** The owner's instinct holds. Four rules make it safe:
1. **A method may not take a fero word where it would be called**: at the root the verbs, operators and probe names; on a row the verbs and writes. An `at: 'any'` method is called at the root and on every lens, so it avoids both lists. The types refuse a clash where it is declared *(checked: wrong.ts items 17, 18, 19)*, and the server refuses it at open with `bad-name`, naming the method. On a path this replaces "fero's names win", which hid a method behind a verb without a word. At the root, today's `f.methods` kept the two apart. Under the pick, P-12's root method `top` would clash with the operator `top`, so it becomes `best`.
2. **A view is declared `{ view }`.** `f.data.best(10)` is then an address you `get()`, `live()` or `on()`, never a promise *(checked: wrong.ts item 2, types.ts t6)*.
3. **An unknown method name is refused here, with no trip** (`no-such-method`), from the method table a client gets at open. A library that duck-types objects then fails loudly instead of sending a call. RxJS's `from()` treats anything with a `getReader` function as a stream and calls it *(from memory; not run)*; on a lens every name is a function. Two cases need care *(reasoned)*. A client whose open resolved before any server answered (API.md 3.1) has no table yet, so a call waits for it, as a write waits as `pending`. In a rolling deploy, an old table lacks a new method; so each server's answers carry its table's version, and a client fetches the table again when it sees a newer one.
4. **`call(name, ...args)` stays**, for a name in a variable. On a handle typed by its rows only it takes any name, as `f.methods.x(…)` does today; awaited it gives `unknown`, and a view needs the server's type *(checked: types.ts t12)*.

The cost: a word fero adds in a later version breaks an app that used it as a root method's name, loudly, at its next start *(reasoned)*. Today, on a path, the new word would hide the method without a word; at the root, `f.methods` keeps them apart.

---

## 5. `asOf`'s name

| Name | For it | Against it |
|---|---|---|
| **`past(pos)`**, the pick | one plain word, like `get`, `live`, `on`, `changes`. It is already the reader's type (`Past`) and the docs' variable name | no other system uses it; database people look for "as of". `past(ack.version)` on the newest version reads oddly, and S10 does just that |
| `asOf(pos)`, the runner-up | SQL:2011 `FOR SYSTEM_TIME AS OF`, Datomic `as-of`, CockroachDB `AS OF SYSTEM TIME`, Delta Lake `versionAsOf` *(from memory)*. Everyday English. Exact for any position, the newest included | two words run together: the one verb that is not a plain word |
| `at(pos)` | short; Snowflake's `AT` *(from memory)* | `f.at`, `lens.at`, a method's `at:` and `ctx.at` already mean a key or a path |
| `version(v)` | familiar | `get({ version })`, `if: { version }`, `Version`; and a position may be a cursor or a time |
| `snapshot(pos)` | familiar | `cluster.snapshot()`; it suggests a still copy, but this reader steps |
| `history(pos)` | familiar | the `history` option; it suggests a list |
| `seek(pos)` | familiar | `Past.seek` |
| `rewind`, `checkout` | familiar | they suggest changing the live rows; this only reads (V5-12 pick 8) |
| `replay(pos)` | event sourcing | tapes and replays (P-18); it suggests running writes again |
| `was(pos)` | reads as a sentence | odd as a handle's name; hard to search for |
| `before(pos)` | Snowflake's `BEFORE` *(from memory)* | off by one commit; V5-12 removed `{ before }` |
| `when(pos)` | short | `get({ when })`, which this page adds |
| `then(pos)` | — | a probe name: impossible |
| `get({ asOf })` | an option, as in SQL | stepping back needs a reader, so a verb comes back anyway |

**Pick: `past(pos)`.** One line in the docs covers the habit: "`past` is what SQL calls AS OF". The judges split on it (one kept `asOf`, one picked `past`), and three of the four proposals picked `past`. It is a name only; nothing else on this page depends on it.

---

## 6. The runners-up

**Fewest words (scored 30 and 31 of 40, a close second).** One live verb, `here(fn?, { until })`, in place of `here`, `tap`, `connect` and `scope`: 31 read words become 20 (this page: 27, counted the same way). *Right:* the bound `close`, the first call after the verb returns, dropping `f.snapshot`, `c.diff`, and the caveat on a collection's `value`; all are taken here. *Not the pick:* `until` takes four kinds of thing (a signal, a socket, a condition, a log position). Its types let `until: el` compile, the likeliest slip in S2, and that link never ends *(checked by both judges)*. This page's types refuse it, though no type can promise a close (2.2). Its served view is still a promise *(checked by both judges)*. And it reads the hot path as `f.data.here().value`, which is free on a server and downloads every row on a client, where `f.rows` refuses. **If the owner wants one live verb, this is the fallback** (question 1).

**The platform's habits (24 and 29).** `get`, `hold`, `subscribe(fn)`, `log`, `past`, with `{ signal }` and `using`. *Right:* the best-measured platform costs (one listener per signal, taken here; `for await` at +150 to +185 ns a delivery; `EventTarget` turned away, since Node warns at 11 listeners); `ctx.signal` and the lock's signal, the `closed` promise, and the RxJS finding, all taken here. *Not the pick:* it makes every lens a Svelte store, so `subscribe` stops being a probe name and E-55's fix is undone; then anything that checks for a store opens a whole partition. S4 needs a hand-written `ws.once('close', off)`, easy to forget. A held handle can be looped over like the log.

**The owner's picture (25 and 24).** One verb, `connect()`, and the argument decides: nothing, a function, a socket, or a DOM node that ends its link when it leaves the page (`isConnected`, +12 to +13 ns a delivery, *measured in its Chromium micro-bench*). S2 and S4 are one line each. *Right:* the teaching frame (three verbs, three wire messages), `String(lens)` as the path, and a version on each change; all taken here. The `isConnected` price is kept for later. *Not the pick:* one word with five meanings and two return types. The weak link stays for plain objects, with its 2.2 times cost and rule 6. A node taken out and put back silently stops updating. Its async `scope` uses AsyncLocalStorage, which costs every promise in the process on Node 22 *(from memory; not measured)*. And it adds 4 to 6 rules by its own count.

**Today's shape (19 and 20).** Section 1.

---

## 7. What it changes

**V5-12's picks.** The owner approved these on 2026-11-18; each change needs a new decision.

| V5-12 | What changes |
|---|---|
| pick 1: a client holds nothing "until `here()` or `tap`" | the words only: until `live()` or `on()` |
| pick 3: `lens.sell(1)`; `f.methods.x(arg)` at the root; fero's names win | root calls are `f.data.x(arg)`; `f.methods` goes; a method named like a fero word is refused where it is declared and at open |
| pick 5: server views are named in `methods:`, with a cap | kept, and made exact: a view is declared `{ view }`, and is an address |
| pick 8: `lens.asOf(position)` | renamed `past(position)`; still a reader only |
| pick 11: `get()`; a lens is never a promise | kept; `get` gains `{ when }`; a served view is never a promise either |
| pick 13: a method declares `{ at: 'row' \| 'partition' \| 'any', run }` | kept, 'any' included; gains `{ view }`. An 'any' method is now called as `f.data.x()` at the root, so its name avoids the root's words and a row's |
| the review rules: "a `connect` function changes only its target"; "a link ends at `close()`, its scope, its target's own close … or a count …, and the collector is only a net" | **the big one.** `connect`, weak links, the net and `scope` go. A link ends at `close()`, a `signal`, `until`, or the count. The collector never ends one |
| picks 2, 4, 6, 7, 9, 10, 12 and 14 | unchanged |

**In [API.md](API.md):** section 2 (the screen; seven user rules become six), 3.3 (`hold`'s wording), 3.8 (root calls; `{ view }`; the name rule; the method table; "a method that returns a view … `await` it" goes), 3.9 (`f.snapshot` goes; settles open question 1), 3.10 (rewritten around `live`, `on`, `signal`, `until`, `closed`; `connect`, the net and its three rules go), 3.11 (names only), 3.12 (`past`; the undo uses a diff entry's `version`), 6 (`Served` becomes an address with no operators; `Live`; `Commit`; `Closes`), 8 (codes `bad-name`, `bad-target`, `bad-arg`, `no-such-method`), and patterns P-01 (`tap`, `here`), P-03 (`scope`), P-05 (`connect`), P-12 (`top` becomes `best`), P-13 (one room, not every row), P-18 (`asOf`) and P-19 (`scope`, `connect`). The sketch here types servers with `fero.of` only; API.md's seed form, `fero(name, { data, methods })`, and call options such as `{ once }` are not declared here.

**In [API-TOUR.md](API-TOUR.md):** about 75 lines use these words *(grep for `here(`, `tap(`, `connect(`, `asOf`, `scope(`, `.methods.` and `.snapshot`)*.

**In [LAYERS.md](LAYERS.md):** section 5.4's rows "`here`, `connect`, lifetimes" (+3) and "a `connect` function changes only its target" (+1) shrink or go. Its row "the lens and the call space" changes: "fero's own verbs and operators win over a method's name" becomes "a method may not take a fero word". The words "link" and "held on purpose" lose their weak half. L4's state keeps no `WeakRef` or finalizer per link. The seven user rules become six.

**In data** (LENS 4.5 lists data's planned changes, D1 to D8): D5, a weak `connect` with the net, goes. D4's one sink shape becomes `(value, c)` with `c.diff`; a diff entry's `version` comes from fero's frame, so data alone has none *(reasoned)*. D2's lens takes `live`, `on` and `past` where it had `here`, `tap` and `asOf`. D1, D3, D6, D7 and D8 are unchanged.

**The price in rules** (SIMPLICITY's measure; every row reasoned, against [LENS 4.4](LENS.md)'s rows):

| Change | Rules |
|---|---|
| go: a weak target passed in; a check of the target before each delivery; "the net is safe at any time, and twice" | −3 |
| go: "a `connect` function changes only its target" | −1 |
| go: `f.snapshot`'s walk | 0 to −1 |
| kept, smaller: a link ends at the first of four (`close`, `signal`, `until`, the count), not five | 0 |
| come: one listener per signal; the first call after `on()` returns | 0 to +2 |
| come: `{ view }` with the method table at open; an unknown name refused here; the table's version, and a fetch when a newer one shows | +1 to +3 |
| come: a clashing name refused at open (it replaces "fero's names win") | 0 to +1 |
| come: `get({ when })`; a `version` on each diff entry | +2 |
| come: `closed` carries a later failure; `ctx.signal` and the lock's signal | 0 to +2 |
| come: `until`'s shape check; the dev warning's exemptions; `on` refuses a non-function | 0 to +1 |
| **net** | **about −2 to +7** |

So the lens's +12 to +18 on 416 (V5-12) becomes about +10 to +25: the same, within the width of the reasoning. **User rules: seven become six.** (1) A path is an address; building one sends nothing, and it is never a promise. (2) `get()` reads once; `live()` keeps it here; `on(fn)` keeps it here and calls you; `changes()` is every record; `past()` is as it was. (3) Left of `live()`: plain data, which may run on a server; right of it: your code, here. (4) The wire sends whole partitions. (5) Every live thing ends by your code: `close()`, a signal, `until`, or the count; never the collector. (6) A method says where it may be called (`at:` or `view`), never takes a fero word, and checks what it is given.

---

## 8. What is not known yet

| Not known | Why it matters | What would settle it |
|---|---|---|
| None of it runs. E-55 built `here`, `tap` and `connect`, not `live`, `on`, `signal` and `until` | the costs above are E-55's paths under new names *(reasoned)* | rename E-55's prototype and rerun claims 6, 7, 9, 10 and 26 |
| a served view and its cap are not built (E-55 claim 27); nor is `{ view }` with the method table | the view's cost and the address form are reasoned only | claim 27 on the prototype |
| the cost of `version` on each diff entry | it is on every commit's path | claim 10's harness with the field read; bar 50 ns a commit |
| one listener per signal, in fero | S16 with many links on one request | a pin with 10,000 links on one signal |
| the first call a microtask later | a gap between the picture and the first commit | claim 7's 1,000 seeds with the deferred call |
| how often real apps leak with no net | the cost of saying no to weak links | run the 28 examples and the 22 patterns (claim 25) on this shape, and count links still open at a clean stop through `f.cluster` |
| whether the dev warning fires in a browser | the collector may never run there (claim 13), so the warning may never show | claim 13's Chromium harness, with the warning |
| whether React needs `useSyncExternalStore` after all | `useEffect` plus state may tear under concurrent rendering *(from memory)* | a React 19 concurrent test; if it tears, a small `fero/react` hook |
| the RxJS duck-typing case | `no-such-method` is the guard | RxJS's `from(lens)` against the prototype |
| `f.data.low(5)` beside a row named `low` | reasoned from claim 4's mechanism, not run | add the case to E-55's call-space bench |
| the method table in a rolling deploy, and before any server answered | a stale or missing table must never refuse a valid call | a sim with servers on two table versions, and an open with no server up |
| how often the dev warning fires on correct code | a warning people learn to ignore is no warning | count warnings on the 28 examples |
| a failed link nobody watches | an unhandled rejection would crash S4's web server | fail 1,000 links with nobody reading `closed`: 1,000 stderr lines, no crash |

---

## 9. Questions for the owner

1. **One live verb or two?** First, plainly: this is mostly today's combo with new names. The jobs are the same; what changes is that a link's life is an option, the weak link goes, the callback gets the value first, and a served view is an address. Pick: two, `live()` and `on(fn)`. A callback verb is the first thing a newcomer reaches for, and `room.live().filter(f).on(render)` reads once, left to right. *Against:* one word more than the fewest-words proposal's `here(fn?)`, and `lens.on(fn)` overlaps `lens.live().on(fn)`.
2. **Rename `here` to `live`, `tap` to `on`, and `asOf` to `past`?** Pick: yes. *Against:* churn in words approved on 2026-11-18, across API.md, API-TOUR.md, LAYERS.md and LENS.md. Keeping `here` alone works with everything else on this page.
3. **No weak links at all: `connect`, its net and `scope` go.** Pick: yes. *Against:* the owner's first wish, weak links that nobody has to end, gets a plain no. S2 with no framework needs a signal or a `close()`. A forgotten link runs until the process ends (1,000 of them cost 0.80-0.90 ms a commit, *measured, E-55 claim 12*). A job's links each take an option.
4. **Root methods on `f.data`, with clashing names refused and views declared `{ view }`.** Pick: yes. *Against:* a word fero adds later breaks an app at its next start; P-12's `top` must be renamed; an `at: 'any'` name avoids two lists; a handle typed by its rows only calls with `call('x')`; the method table needs a rule for when it is stale; 50 example lines change.
5. **Drop `f.snapshot`** (API.md open question 1). Pick: drop it; read a row with `f.rows[k]`, and copy with a spread you write. *Against:* 89 lines in 52 example files read `.snapshot` *(checked here, grep, not counting `cluster.snapshot`)*, and their printed output changes.
6. **`get({ when })` for "wait until".** Pick: yes. *Against:* `get` then sometimes holds a partition while it waits; the word `when` is on the line, but "`get` holds nothing" gains an exception.

**Not on this page.** The owner also asked about the libraries built on top: why `answer` is a thing and not just a method for request and reply, and what `consume`, `work` and `queue` do. No proposal covered them. They need a short page of their own.

---

## 10. How this page is checked

Every ` ```ts ` block whose first line is `// file: <name>` is written into a fresh folder and type-checked with tsc: the combo in section 0 and the six files below. Then a copy is made with every `@ts-expect-error` turned into a plain comment. Each of those lines must fail at its own line, with no error anywhere else. `fero.d.ts` is self-contained: the read surface, with writes and methods only as far as the scenarios need. It types servers with `fero.of` only.

<details><summary>fero.d.ts: the declarations</summary>

```ts
// file: fero.d.ts — the read surface this page recommends, as declarations. Self-contained: it imports nothing.
// A sketch to type-check the page; nothing is built. Writes and methods are here only as far as the scenarios need.
//   lens.get(opts?)       read once; hold nothing. { when } waits until a test passes, then reads once
//   lens.live(opts?)      keep it live here: a handle with value, ready, closed, on(fn), close
//   lens.on(fn, opts?)    live(opts) plus fn(value, c) on the picture and once per commit; the same handle
//   lens.changes(opts?)   the log: every record, in order, from a position
//   lens.past(position)   the lens as it was: a reader with step and seek (was asOf)
//   { signal }, { until } how a live thing ends, besides close(). Never by the collector
declare module 'fero' {
  // ── words ──────────────────────────────────────────────────────────────
  export type Key = string
  export type Depth = 1 | 2
  /** What the types know of a handle: a server, a bare client, or a client that said hold: 'all'. */
  export type Role = 'server' | 'client' | 'all'
  export type Version = string & { readonly __fero: 'version' }
  export type Cursor = string & { readonly __fero: 'cursor' }
  export type Time = number
  /** Where to look back to: a version, a cursor or a writer time. */
  export type Position = Version | Cursor | Time
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
  type ClientOf<S, H extends 'client' | 'all'> = S extends Resource<infer Row, infer M, infer D, any> ? Resource<Row, M, D, H> : never
  /** A typed client: `fero<Shop>('shop')`, with `import type { Shop }` from the server file. */
  export function fero<S extends AnyResource>(name: string, opts: OpenOptions & { hold: 'all' }): Promise<ClientOf<S, 'all'>>
  export function fero<S extends AnyResource>(name: string, opts?: OpenOptions & { hold?: Size }): Promise<ClientOf<S, 'client'>>
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
    function now(): Time
  }

  // ── the resource ───────────────────────────────────────────────────────
  export interface Resource<Row = any, M = {}, D extends Depth = 1, R extends Role = Role> {
    readonly name: string
    /** The root lens: the address of everything. Root methods are called on it: `f.data.low(5)`. */
    readonly data: Lens<Tree<Row, D>, Row, M, 'root', D, R>
    /** The hot sync read: one lookup, frozen rows. Only where every row is held: a server, or hold: 'all'. */
    readonly rows: [R] extends ['client'] ? Steer<'f.rows needs every row held here: read through a live() handle, or open with hold: "all"'> : RowsOf<Row, D>
    /** The same address as f.data.a.b, with no Proxy: keys from input, keys named like fero words, hot loops. */
    readonly at: AtFn<Row, M, 'root', D, R>
    /** A reader name's marks, as a cursor for changes({ from }). */
    marks(name: string): Promise<Cursor>
    destroy(): Promise<boolean>
  }

  // ── the lens: an address. A property read is a step; a call is a verb ──
  export type Kind = 'root' | 'part' | 'row' | 'field'
  type Child<K extends Kind, D extends Depth> = K extends 'root' ? (D extends 2 ? 'part' : 'row') : K extends 'part' ? 'row' : 'field'
  /** What a read gives: a row or field (undefined when absent), or the rows of a partition or of everything. */
  type Val<T, Row, K extends Kind, D extends Depth> = K extends 'row' | 'field' ? T | undefined : K extends 'part' ? Rows<Row> : RowsOf<Row, D>
  /** What live() gives: a collection has local operators; a row or field does not. */
  type LiveOf<T, Row, K extends Kind, D extends Depth> =
    K extends 'row' | 'field' ? Live<T | undefined, Row> : K extends 'part' ? LiveRows<Row> : D extends 2 ? Live<RowsOf<Row, 2>, Row> : LiveRows<Row>
  /** V4-5: the typed client of a resource with methods changes data only through them. */
  type Door<M, R extends Role> = [R] extends ['server'] ? false : keyof M extends never ? false : true

  export type Lens<T, Row, M, K extends Kind, D extends Depth, R extends Role> =
    Reads<Val<T, Row, K, D>, Row, LiveOf<T, Row, K, D>>
    & { readonly at: AtFn<Row, M, K, D, R>; readonly call: CallFn<M, K, D> }
    & (K extends 'row' | 'field' ? (Door<M, R> extends true ? {} : WriteVerbs<T>) : {})
    & (K extends 'root' ? RootCalls<M, StepOf<Row, M, K, D, R>> & RootOps<Row, D, R> : K extends 'part' ? Operators<Row> : {})
    & PathCalls<M, K, D, StepOf<Row, M, K, D, R>>
    & { readonly subscribe: Steer<'a lens is not a store: lens.on(fn)'>
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

  /** How you get data: five verbs on every lens. */
  export interface Reads<V, Row, L> {
    /** Read once, with the version. */
    get(opts: GetOpts & { version: true }): Promise<{ value: V; version: Version } | undefined>
    /** Read once: here if this process holds the partition on purpose, else one trip. Holds nothing.
     *  With `when`, it holds the partition live until when(value) is true, reads, and lets go. */
    get(opts?: GetOpts & { when?: (value: V) => unknown }): Promise<V>
    /** Keep it live here: the picture, then each commit. Counted, and shared with every equal lens. */
    live(opts?: LinkOpts): L
    /** live(opts), plus fn on the picture and once per commit. The first call comes after on() returns. */
    on(fn: (value: V, c: Commit<Row>) => void, opts?: LinkOpts): L
    /** The log: every committed record under this lens, in order, from a position (default: from the call). */
    changes(opts?: ChangesOpts): Changes<Row>
    /** This lens as it was at a position. Read-only and folded here; the log must reach back (history). */
    past(pos: Position): Promise<Past<V, Row>>
  }
  export interface GetOpts { fresh?: boolean; signal?: AbortSignal; timeout?: Duration }
  /** How a live link ends, besides close(). The collector never ends one. */
  export interface LinkOpts {
    /** It ends when this aborts: a request's, a job's, a component's, a handler's (ctx.signal). */
    signal?: AbortSignal
    /** It ends when this says it closed: a Node socket, stream or HTTP response, the ws library's socket, a WebSocket. */
    until?: Closes
  }
  /** A check of the object's shape, not a promise that it will ever close. */
  export type Closes =
    | { once(event: 'close', fn: () => void): unknown; readonly destroyed: boolean }   // a Node socket, stream or response
    | { once(event: 'close', fn: () => void): unknown; readonly readyState: number }   // the ws library's WebSocket
    | { close(): void; readonly readyState: number; onclose: unknown }                 // a WebSocket in a browser or Node 22

  // ── live handles ───────────────────────────────────────────────────────
  /** One live link. It holds its selection on purpose until close(), its signal or its `until`. */
  export interface Live<V, Row = unknown> {
    /** Resolves to this handle once the first picture is here. */
    readonly ready: Promise<this>
    /** The latest committed state, by reference, frozen. Before ready it throws 'not-ready': a sync read never guesses. */
    readonly value: V
    /** Settles when the link ends: resolves on close(), the signal or `until`; rejects with why it failed
     *  ('expired', 'too-many-views', a lost lease). Made only when first read; a failure nobody reads
     *  prints one stderr line, never an unhandled rejection. */
    readonly closed: Promise<void>
    /** One more call per commit, for this handle's life. */
    on(fn: (value: V, c: Commit<Row>) => void): this
    /** End the link now. Bound, so it can be passed on or returned from an effect. */
    readonly close: () => void
    [Symbol.dispose](): void
  }
  /** A live collection: a partition, the whole resource, a served view, or a view made here. */
  export interface LiveRows<Row> extends Live<Rows<Row>, Row>, LocalOps<Row> {}
  /** The second argument of a callback: what this commit changed. By reference, made only when read. */
  export interface Commit<Row> {
    /** True once: diff is then the picture so far, as adds. */
    readonly first: boolean
    /** One entry per row this commit changed. Rows are frozen. */
    readonly diff: readonly Change<Row>[]
    /** The wire records of this commit, and their JSON text: each built once per commit and shared. */
    recs(): readonly Rec[]
    text(): string
  }
  export interface Change<Row> {
    readonly type: 'add' | 'update' | 'remove'
    readonly key: Key
    readonly row: Row | undefined
    readonly prev: Row | undefined
    /** The row's version after this commit: for if: { version } (an undo). */
    readonly version: Version
  }
  /** Plain data: may stand left of live(), and may run on a server. */
  interface PlainOps<Row, Out> {
    gt(field: keyof Row & string, v: number | string): Out
    lt(field: keyof Row & string, v: number | string): Out
    az(field: keyof Row & string, n?: number): Out
    za(field: keyof Row & string, n?: number): Out
    top(n: number): Out
    limit(n: number): Out
  }
  /** Left of live(): plain data only. A function here does not compile. */
  export interface Operators<Row> extends PlainOps<Row, Sel<Row>> {
    readonly filter: Steer<'a function cannot run on a server: live() first, then filter right of it'>
    readonly map: Steer<'a function cannot run on a server: live() first, then map right of it'>
  }
  /** The root of a bare client: an operator over every row would be work on every write at a server. */
  type RootOps<Row, D extends Depth, R extends Role> = D extends 2 ? {}
    : [R] extends ['client'] ? { readonly [N in keyof PlainOps<Row, unknown>]: Steer<'an operator over every row, on a client: call a view the server named, f.data.<view>(arg)'> }
    : Operators<Row>
  /** A view the server named: an address, like a lens. Never a promise. No operators: one more would be
   *  new work on a server for every write; put them right of live(), here. */
  export interface Served<Row> {
    get(opts?: GetOpts): Promise<Rows<Row>>
    live(opts?: LinkOpts): LiveRows<Row>
    on(fn: (value: Rows<Row>, c: Commit<Row>) => void, opts?: LinkOpts): LiveRows<Row>
  }
  /** A selection made of plain data: an address too. */
  export interface Sel<Row> extends Operators<Row>, Served<Row> {}
  /** Right of live(): your code, here, on held rows. A view ends with the handle it was made from. */
  export interface LocalOps<Row> extends PlainOps<Row, LiveRows<Row>> {
    filter(fn: (row: Row, key: Key) => unknown): LiveRows<Row>
    map<U>(fn: (row: Row, key: Key) => U): LiveRows<U>
  }

  // ── the log, and the past ──────────────────────────────────────────────
  export interface ChangesOpts {
    /** 'latest' (default): from the call on. 'earliest': all that is kept. Or a saved cursor, or marks(name). */
    from?: 'earliest' | 'latest' | Cursor | Version | Promise<Cursor>
    /** Stop at this position. */
    until?: 'latest' | Cursor | Version
    credit?: Size
    signal?: AbortSignal
  }
  export interface Changes<Row> extends AsyncIterable<Entry<Row>> {
    /** Where this reader is: save it, pass it back as `from`. */
    readonly cursor: Cursor
    readonly close: () => void
  }
  /** One log record. No prev: the log is every record, not a folded state. */
  export interface Entry<Row> {
    readonly rec: Rec
    /** What the record wrote, when it wrote a whole row. */
    readonly value?: Row
    readonly partition: string
    readonly version: Version
    readonly time: Time
  }
  export interface Past<V, Row> {
    readonly value: V
    /** One commit back (-1) or forward (+1). Moves this reader and returns it. */
    step(n: number): Past<V, Row>
    seek(pos: Position): Past<V, Row>
    readonly close: () => void
    [Symbol.dispose](): void
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
    | { readonly view: (arg: any, ctx: Ctx<Row, D, 'root'>) => Sel<Row> }
  export type Methods<Row = any, D extends Depth = 1> = Record<string, MethodDef<Row, D>>
  export interface Ctx<Row, D extends Depth, K extends Kind> {
    /** The lens the call was made on; for a root action or a view, the root. */
    readonly at: Lens<K extends 'row' ? Row : K extends 'part' ? Record<Key, Row> : Tree<Row, D>, Row, {}, K, D, 'server'>
    /** This server's root lens. */
    readonly data: Lens<Tree<Row, D>, Row, {}, 'root', D, 'server'>
    /** Aborts when the call ends: pass it to the handler's live reads, and they end with the call. */
    readonly signal: AbortSignal
  }
  type Verb = 'get' | 'live' | 'on' | 'changes' | 'past' | 'at' | 'call'
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
  /** An action answers once its writes commit; a view is an address you get(), live() or on(). */
  type CallOf<H> = H extends { view: (...a: any[]) => Sel<infer V> } ? Served<V> : Judged<Awaited<RunOf<H> extends (...a: any[]) => infer X ? X : never>>
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
  /** A method by name: for a name in a variable. An unknown name is refused here, with no trip. On a handle
   *  typed by its rows only (M is {}), any name: an action's answer, or a view's address, which needs a cast. */
  type CallFn<M, K extends Kind, D extends Depth> = keyof M extends never
    ? (name: string, ...args: unknown[]) => Judged<unknown> | Served<any>
    : <N extends keyof (K extends 'root' ? RootCalls<M, unknown> : PathCalls<M, K, D, unknown>) & keyof M & string>(name: N, ...args: ArgsOf<M[N]>) => CallOf<M[N]>

  // ── libraries the scenarios use ────────────────────────────────────────
  /** Exactly once from a source's log into a target: paced, and run once across the processes that run it. */
  export function derive<S>(
    source: { readonly name: string; readonly data: { changes(opts?: ChangesOpts): Changes<S> } },
    target: { readonly name: string; marks(name: string): Promise<Cursor> },
    fn: (e: Entry<S>) => void,
  ): Promise<{ readonly close: () => void }>
  /** Run fn while this process holds the lock. Its signal aborts when the lock is lost or fn ends. */
  export function lock(name: string, fn: (signal: AbortSignal) => Promise<void>): Promise<void>
  export class FeroError extends Error {
    readonly code: 'not-held' | 'not-ready' | 'expired' | 'too-many-views' | 'conflict' | 'methods-only'
      | 'bad-path' | 'bad-name' | 'bad-target' | 'bad-arg' | 'no-such-method' | 'aborted'
    readonly hint: string
  }
}
```

</details>

<details><summary>env.d.ts, server.ts: the app's world and the servers</summary>

```ts
// file: env.d.ts — the app's world, as tiny stand-ins (this box has no @types packages). Nothing here is fero.
declare module 'node:http' {
  export interface IncomingMessage { url?: string }
  export interface ServerResponse { end(body?: string): void; write(chunk: string): boolean; once(event: 'close', fn: () => void): this; readonly destroyed: boolean }
  export function createServer(fn: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): { listen(port: number): void }
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
declare function save(e: unknown): void
declare function report(n: number | undefined): void
declare function loadCursor(): Promise<import('fero').Cursor | undefined>
declare function saveCursor(c: import('fero').Cursor): Promise<void>
declare const sku: string, id: string, k: string, keys: string[]
declare const signal: AbortSignal, ws: import('ws').WebSocket
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
await fero<Part>('parts', { server: true, history: '1h' })                    // no methods: clients may write

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
```

</details>

<details><summary>scenarios.ts: S1 to S16</summary>

```ts
// file: scenarios.ts — S1 to S16 on the recommended surface (S12's handler is in server.ts). Each compiles; none runs
import { createServer } from 'node:http'
import { WebSocketServer } from 'ws'
import { useEffect, useState } from 'react'
import { shallowRef, watchEffect } from 'vue'
import { fero, op, derive, lock, type Version, type Rows } from 'fero'
import type { Item, Shop, Scores, Msg, Here, Part, Orders } from './server.js'
const shop = await fero<Shop>('shop')                                 // a client: it holds nothing
const chat = await fero<Msg, 2>('chat')                               // depth 2: a room is a partition

// S1 read one row once in an HTTP handler, and a field of it
createServer(async (req, res) => {
  const id = new URL(req.url ?? '/', 'http://x').searchParams.get('sku') ?? 'widgets'
  const item = await shop.at(id).get()                                // one trip, or none if held here; keeps nothing
  const stock = await shop.at(id, 'stock').get()                      // the field alone: one more trip (item?.stock: none)
  res.end(JSON.stringify({ name: item?.name, stock }))
}).listen(8080)

// S2 one field in a DOM element, live, until the element goes away
const label = document.querySelector('#stock')!
const shown = new AbortController()                                   // no browser event says "this element is gone"
shop.data.widgets.stock.on((n) => { label.textContent = String(n ?? '-') }, { signal: shown.signal })
export function removeLabel() { label.remove(); shown.abort() }       // the code that removes it ends the link

// S3 a component that shows a row live and stops on unmount: close is bound, so the effect returns it
export function useRow(id: string) {                                  // React
  const [row, setRow] = useState<Item>()
  useEffect(() => shop.at(id).on(setRow).close, [id])
  return row
}
export function useRoom(room: string) {                               // a room's value is one live object, the same at
  const [view, setView] = useState<{ rows: Rows<Msg> }>()             // each commit: wrap it, so React sees a new object
  useEffect(() => chat.at(room).on((rows) => setView({ rows })).close, [room])
  return view?.rows
}
let svelteRow: Item | undefined
$effect(() => shop.at(sku).on((r) => { svelteRow = r }).close)       // Svelte 5
export function useRowVue(id: string) {                               // Vue 3
  const row = shallowRef<Item>()
  watchEffect((onCleanup) => onCleanup(shop.at(id).on((r) => { row.value = r }).close))
  return row
}

// S4 forward a chat room to 1,000 WebSocket clients; each ends when its socket closes
new WebSocketServer({ port: 8081 }).on('connection', (ws, req) => {
  const room = new URL(req.url ?? '/', 'http://x').searchParams.get('room') ?? 'lobby'
  chat.at(room).on((_, c) => ws.send(c.text()), { until: ws })        // one SUB, one decode, one text() for every socket
})

// S5 a live top-10 leaderboard computed on a server (a served view), shown here
const fan = await fero<Scores>('scores')
const board = fan.data.best(10).on((top) => render(Object.values(top)))   // an address: one SUB; only the view's changes cross

// S6 filter a room's messages here (local work) and render them
const room = chat.data.room1.live()                                   // the line: the room crosses whole, then its changes
room.filter((m) => !m.hidden).on((shownMsgs) => render(shownMsgs))   // right of live(): here. It ends with room

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
const was = await parts.data.widgets.past(ack.version)               // a reader from the nearest snapshot, folded here
console.log(was.value?.stock, was.step(-1).value?.stock); was.close()

// S11 an undo button that uses the previous value of the last change
let undo: { prev: Part | undefined; version: Version } | undefined
parts.data.widgets.on((_, c) => { const d = c.diff[0]; if (!c.first && d) undo = { prev: d.prev, version: d.version } })
export async function onUndo() {
  if (!undo) return
  const w = parts.data.widgets, guard = { if: { version: undo.version } }   // only if nothing came in between
  await (undo.prev ? w.set(undo.prev, guard) : w.remove(guard))
}

// S12 a method handler reading a row before it writes: refund in server.ts. The call:
const r = await orders.data.o7.refund()                              // at o7's leader: one trip, one commit

// S13 wait until a condition holds (stock > 0), then go on
const back = await shop.data.widgets.stock.get({ when: (s) => (s ?? 0) > 0, signal: AbortSignal.timeout(30_000) })

// S14 presence: who is online in a room, live
const online = await fero<Here, 2>('online')
await online.at('room1', fero.id()).set({ name: 'ada' })             // this row dies with this process's session
const who = online.at('room1').on((people) => render(Object.values(people).map((p) => p?.name)))

// S15 read a few rows from different partitions at once
const [a, b, c] = await Promise.all(['widgets', 'gizmos', 'bolts'].map((key) => shop.at(key).get()))

// S16 a server-side job that must stop all its live reads when a request or job ends
createServer((req, res) => {                                          // a request: each link ends when res closes
  shop.data.widgets.on((w) => res.write(`data: ${w?.stock}\n\n`), { until: res })
  shop.data.low(5).on((low) => res.write(`data: ${Object.keys(low).length} low\n\n`), { until: res })
}).listen(8082)
await lock('nightly', async (signal) => {                             // a job: its signal ends its links, after any await
  const w = await shop.data.widgets.live({ signal }).ready
  report(w.value?.stock)
})
console.log(board, who, r, back, a, b, c, svelteRow, sum)
```

</details>

<details><summary>wrong.ts and types.ts: the wrong uses refused, and the types that carry through</summary>

```ts
// file: wrong.ts — the main wrong uses. Each line under a @ts-expect-error must fail there, for the reason given
import { fero } from 'fero'
import { useEffect, useState } from 'react'
import type { Item, Shop, Msg } from './server.js'
const shop = await fero<Shop>('shop'), chat = await fero<Msg, 2>('chat'), el = document.createElement('b')

// @ts-expect-error 1. a lens is an address, never a promise: `await lens` gives the lens back. Read with get()
const stock: number | undefined = await shop.data.widgets.stock
// @ts-expect-error 2. a served view is an address too: awaiting it sends nothing and gives no rows
const low: Readonly<Record<string, Item | undefined>> = await shop.data.low(5)
// @ts-expect-error 3. live state is not the log: `for await` reads changes(), every record in order
for await (const x of shop.data.widgets.live()) console.log(x)
// @ts-expect-error 4. a log entry has no prev: the log is every record, not a folded state
for await (const e of shop.data.changes()) console.log(e.prev)
// @ts-expect-error 5. a DOM node never says it closed, so `until` refuses it: pass a signal, or close()
shop.data.widgets.stock.on((n) => { el.textContent = String(n) }, { until: el })
// @ts-expect-error 6. a lens is not a store: on(fn)
shop.data.widgets.subscribe(() => {})
// @ts-expect-error 7. a function cannot travel to a server: live() first, then filter right of it
chat.data.room1.filter((m: Msg) => !m.hidden).live()
// @ts-expect-error 8. an operator over every row, on a client that holds nothing: call a view the server named
shop.data.za('stock', 10).live()
// @ts-expect-error 9. f.rows on a bare client: every row is not held here
shop.rows.widgets
// @ts-expect-error 10. f.snapshot is gone: rows[k] for one row; a copy is a spread you write, { ...h.value }
shop.snapshot
// @ts-expect-error 11. f.methods is gone: a root method is called on the root lens, shop.data.low(5)
shop.methods.low(5)
// @ts-expect-error 12. a root method is offered at the root only, never on a path
shop.data.widgets.low(5)
// @ts-expect-error 13. connect is gone: on(fn, { signal }) or on(fn, { until: socket }) does its job
shop.data.widgets.stock.connect(el, 'textContent')
// @ts-expect-error 14. c.changes is now c.diff, so "changes" names only the log
shop.data.widgets.on((w, c) => c.changes)
// @ts-expect-error 15. rows handed to a function are frozen: read-only
shop.data.widgets.on((w, c) => { c.diff[0]!.prev = undefined })
// @ts-expect-error 16. an effect must return close, not the handle, or the link never ends (React's own type)
export function Bad() { const [, set] = useState<Item>(); useEffect(() => shop.data.widgets.on(set), []) }
await fero.of<Item>()('shop2', { methods: {
  // @ts-expect-error 17. a method named like a fero word where it is called (the root operator top) is refused here
  top: { view: (n: number, ctx) => ctx.data.za('stock', n) },
  // @ts-expect-error 18. ... and so is one named like a row verb
  set: { at: 'row', run: (n: number, ctx) => ctx.at.stock.set(n) },
  // @ts-expect-error 19. ... and an `at: 'any'` method avoids the root's words and a row's words at once
  remove: { at: 'any', run: (_: undefined, ctx) => 1 },
  best: { view: (n: number, ctx) => ctx.data.za('stock', n) },
} })
// @ts-expect-error 20. `until` checks a shape: an EventSource never says it closed, so it is refused
shop.data.widgets.on(() => {}, { until: new EventSource('/x') })
// @ts-expect-error 21. ... and so is window (it has close(), but no 'close' event of its own)
shop.data.widgets.on(() => {}, { until: window })
// @ts-expect-error 22. a served view takes no operators (new server work for each shape): put them right of live()
shop.data.low(5).za('stock', 2).live()
// @ts-expect-error 23. a probe name reads undefined: a row named 'then' is f.at('then')
shop.data.then.get()
const all = await fero<Shop>('shop', { hold: 'all' })                 // hold: 'all' may read rows and sort every row here
console.log(stock, low, all.rows.widgets?.stock, all.data.za('stock', 3).live(), shop.data.low(5).live().za('stock', 2))
```

```ts
// file: types.ts — the types carry through: each line fails to compile if a type is any or wrong
import { fero, type Rows, type Live, type LiveRows, type Commit, type Served, type Version, type Judged } from 'fero'
import type { Item, Shop, Msg, Score, Scores } from './server.js'
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const shop = await fero<Shop>('shop'), chat = await fero<Msg, 2>('chat'), fan = await fero<Scores>('scores')

const t1: Eq<Awaited<ReturnType<typeof shop.data.widgets.get>>, Item | undefined> = true
const t2: Eq<Awaited<ReturnType<ReturnType<typeof shop.at<'stock'>>['get']>>, number | undefined> = true
const t3: Eq<ReturnType<typeof shop.data.widgets.live>, Live<Item | undefined, Item>> = true
const t4: Eq<ReturnType<typeof chat.data.room1.live>, LiveRows<Msg>> = true
const t5: Eq<Parameters<Parameters<typeof chat.data.room1.on>[0]>, [value: Rows<Msg>, c: Commit<Msg>]> = true
const t6: Eq<ReturnType<typeof fan.data.best>, Served<Score>> = true                       // a view: an address
const t7: Eq<ReturnType<typeof shop.data.ping>, Judged<string>> = true                      // an action: it answers
const t8: Eq<Awaited<ReturnType<typeof shop.data.low.get>>, Item | undefined> = true        // the row named 'low'
const t9: Eq<Commit<Item>['diff'][number]['version'], Version> = true
const t10: Eq<Awaited<ReturnType<typeof shop.data.widgets.past>>['value'], Item | undefined> = true
const anyShop = await fero.of<Item>()('any', { methods: { touch: { at: 'any', run: (_: undefined, ctx) => 1 } } })
const t11: Eq<ReturnType<typeof anyShop.data.touch>, ReturnType<typeof anyShop.data.w.touch>> = true   // 'any': root and row
const bare = await fero<Item>('shop')                                                      // typed by its rows only
const t12: Eq<ReturnType<typeof bare.data.call>, Judged<unknown> | Served<any>> = true      // call takes any name
console.log(t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, t11, t12, await bare.data.call('ping'))
```

</details>

```js check
// READS.md checker: every ```ts block of this page whose first line is "// file: <name>" goes into a fresh folder
// and must type-check. Then, in a copy where each @ts-expect-error is a plain comment, each line it marks must
// fail, and nothing else may. Self-contained: tsc on PATH is all it needs.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const blocks = [...readFileSync(process.argv[1], 'utf8').matchAll(/^```ts\n(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)^```$/gm)]
  .map(([, body, name]) => [name, body])
const root = mkdtempSync(join(tmpdir(), 'fero-reads-'))
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
if (missed.length || stray.length) { console.log({ missed, stray }); process.exit(1) }
```

Run from the repo root, with tsc on `PATH`:

```sh
node --input-type=module -e "$(awk '/^```js check$/{f=1;next} /^```$/{f=0} f' docs/v5-space/READS.md)" docs/v5-space/READS.md
```

**Result, run here on 2026-11-19** (Node v22.22.0, TypeScript 6.0.2): `ok: 7 blocks type-check (tsc Version 6.0.2)`, then `23 marked lines, 23 fail at their own line, 0 errors elsewhere`. Each stripped line fails for the reason its comment gives:

| wrong.ts line (item) | The wrong use | tsc |
|---|---|---|
| 8 (1) | `await` a lens, used as a number | TS2322: `Lens<number, …>` is not assignable to `number \| undefined` |
| 10 (2) | `await` a served view, used as rows | TS2322: `Served<Item>` is not assignable to the rows |
| 12 (3) | `for await` over a live handle | TS2504: no `[Symbol.asyncIterator]()` |
| 14 (4) | `e.prev` on a log entry | TS2339: no `prev` on `Entry<Item>` |
| 16 (5) | `{ until: el }` with a DOM element | TS2322: `HTMLElement` is not assignable to `Closes` (not one of its three shapes) |
| 18, 20, 22 (6, 7, 8) | `lens.subscribe(fn)`; `filter(fn)` left of `live()`; `za(…)` over every row on a bare client | TS2349, with the fix in the type's text: "a lens is not a store: lens.on(fn)"; "live() first, then filter right of it"; "call a view the server named" |
| 24 (9) | `shop.rows` on a bare client | TS2339, on "f.rows needs every row held here: read through a live() handle, or open with hold: "all"" |
| 26, 28, 32, 34 (10, 11, 13, 14) | `f.snapshot`, `f.methods`, `connect`, `c.changes` | TS2339: no such property |
| 30 (12) | a root method on a path | TS2339 |
| 36 (15) | changing a row handed to a callback | TS2540: `prev` is read-only |
| 38 (16) | an effect that returns the handle, not its `close` | TS2322: `Live<…>` is not assignable to `void \| (() => void)` (a stand-in of React's effect type, in env.d.ts) |
| 41, 43, 45 (17, 18, 19) | a method named `top` at the root; one named `set` on a row; an `at: 'any'` one named `remove` | TS2322, on "this name is a fero word on the lens it would be called on: rename the method" |
| 49, 51 (20, 21) | `{ until }` with an `EventSource`; with `window` | TS2322: not assignable to `Closes` |
| 53 (22) | an operator on a served view | TS2339: no `za` on `Served<Item>` |
| 55 (23) | `shop.data.then.get()`, a probe name | TS18048: `shop.data.then` is possibly `undefined` |

- **Probes run beside it** (not on the page; each refused line needed, the rest compile): an `async` helper that returns `shop.data.low(5)` still gives `Served<Item>`, so it sends nothing. As `until`, these are refused: an `XMLHttpRequest`, `{ a: 1 }`, a `<dialog>`, `document`, a `BroadcastChannel`, an `AudioContext`, and an object with only `once` (a plain event emitter, or `process`). These compile: a Node stream's shape, a browser `WebSocket`. `` `${lens}` `` is a string; `await shop.data` gives the lens back; `shop.data.toJSON.live()` and operators on `fan.data.best(10)` are refused, while `fan.data.best(10).live().gt(…)` compiles. An `at: 'any'` method is offered at the root and on a row; a handle typed by its rows only takes `call('ping')`. `shop.data.live()` compiles on a bare client: it holds every row, and says so on the line. `get({ when })` with no `signal` or `timeout` compiles, and waits while the test fails.
- **Not declared here:** API.md's seed form, `fero(name, { data, methods })`, and call options such as `{ once }`. So items 17 to 19 are checked for servers made with `fero.of` only.
- **Not checked here: that any of it runs.** Nothing on this page is built.
