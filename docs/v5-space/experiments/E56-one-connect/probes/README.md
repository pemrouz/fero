# E-56 probes: the owner's one `connect`, built on E-55's prototype

**Question.** The owner asked for one verb, `connect`, with options (2026-11-20). Built small on E-55's prototype, what happens at run time and in the types with the owner's ideas I1-I4, I9, I11 and I12? (The ideas are numbered in the experiment's brief: I1 one verb with options; I2 each call gets `(state, commit)`; I3 `disconnect()`; I4 a lifetime option as well; I9 a read once is a subscription that ends after one, perhaps awaited; I11 `get()` as a small wrapper to await one value; I12 the same handle is an async iterable.)

**What was built** ([proto/connect.mjs](proto/connect.mjs), about 330 lines). E-55's [proto/lens.mjs](../../E55-lens-prototype/proto/lens.mjs) is imported from its folder and never edited; its lens verbs `connect` and `get` are pointed at this file's code at load. Its worker and `MessagePort` half, `proto/net.mjs`, is not used: every probe runs in one process with E-55's loopback client.

- `lens.connect(fn?, opts?)`: `fn(state, commit)` once per commit, the first call with the picture so far (`commit.first`). `opts`: `{ from, until, signal, once }`. It returns a handle: `disconnect()` (bound; `close` is an alias), `state` (a sync read), `ready`, and `Symbol.asyncIterator`, which yields `{ state, commit }`.
- `state` is the row (or field) for a row or field lens, and the selection's live view for a partition or the whole resource. `commit` is E-55's commit object: `first`, `changes` (data's row deltas by reference, each with `prev`), `seq`, `recs()`, `text()`.
- Three variants of awaiting. **V-a**: the handle is thenable; `await handle` gives the first state and the link stays open. **V-a1**: the same, but awaiting also ends the link. **V-b** (the default): the handle has no `then`; `lens.get()` is `connect({ once })` as a promise.
- A `for await` loop gets **merged** turns without `from` (the newest state, and one change per row since its last turn: live state) and **every** commit with `from: 'now'` (kept here in order until the loop takes it: the log's rule). The prototype has no log, so `from` takes only `'now'`.
- Four policies a probe can switch: the first call a **microtask** after `connect()` returns (the default) or **inside** it (E-55's `Link.attach` as built); `break` in a loop ends the **whole handle** (the default) or **only that loop**; `until` takes only a thing that **can say it already closed** (a Node socket's `destroyed`, a WebSocket's `readyState`) and is not an HTTP request (it has a `method`) (the default), or anything with `once` or `addEventListener`; a partition's `state` read after its link ends is the **shared live view** (the default, as first built) or goes through a **guard per link** that throws `ended` (the fix CONNECT.md takes; lifetimes case 11 switches it).
- Views right of a handle and operators left of `connect` reuse E-55's `LocalView`.

**Words.** A *link* is one live connection from a lens into this process. A *picture* is the rows so far, which a link gets first. A *selection* is what one subscription brings in; equal lenses share one. A *SUB* is the subscribe message, a *GET* a one-off read. A *microtask* is a step JavaScript runs right after the current code. *Planted bug*: a bug put in on purpose, to show a check can fail.

**Marks.** *(checked)*: a probe or tsc ran it and the line is in [results/](results). *(measured)*: timed, three runs, each process alone under the box's timing lock; tables show the range over the runs. *(reasoned)*: an argument, not run.

## The probes and their results

| # | Idea | Probe | What it shows | Result |
|---|---|---|---|---|
| 1 | I9, I11 | [bench/thenable.mjs](bench/thenable.mjs) | a thenable handle (V-a, V-a1) against none (V-b), in seven ways code resolves values; and what reading once costs on a client | see "Probe 1" |
| 2 | I12 | [bench/foreach.mjs](bench/foreach.mjs) | a `for await` loop 10 times slower than the writes: merged against every commit; the cost per delivery against a callback | see "Probe 2" |
| 3 | I2 | [bench/commit.mjs](bench/commit.mjs) | what `state` and `commit` are for a row, a field, a partition, the whole resource; what `prev` costs | see "Probe 3" |
| 4 | I3, I4 | [bench/lifetimes.mjs](bench/lifetimes.mjs), [bench/sims.mjs](bench/sims.mjs), [bench/signal.mjs](bench/signal.mjs) | `disconnect()` and a lifetime on one link: 17 cases and 6 limits; E-55's seeded lifetime checks (its claims 7, 9 and 26) on connect, each with planted bugs; what `{ signal }` and `{ until }` cost a link | see "Probe 4" |
| 5 | I1, I9-I12 | [check/](check), [bench/slips.mjs](bench/slips.mjs) | a `fero.d.ts` sketch of the owner's connect: which forms type well, which misuses fail, and with what message; two slips types cannot catch, run | see "Probe 5" |

### Probe 1: a thenable handle (I9, I11)

One client over E-55's loopback transport with JSON frames, so SUBs, UNSUBs, GETs and bytes are counted ([results/checks.jsonl](results/checks.jsonl), checked).

| What the code does | V-a (thenable, the link stays) | V-a1 (thenable, await ends it) | V-b (no `then`) |
|---|---|---|---|
| an `async` helper returns `lens.connect(fn)`, called 1,000 times | the caller gets 1,000 states and **0 handles; 1,000 links stay open** and all run at the next write; nothing can end them | the caller gets 1,000 states; each `fn` is called **once and then never again**, silently; 1,000 SUBs (no linger here), where V-a and V-b sent 1 | 1,000 handles; the caller ends all of them |
| `const h = await lens.connect(fn)` | `h` is the state; 1 link left open | `h` is the state; `fn` stops after one call | `h` is the handle |
| `Promise.all` of 3 handles | 3 states, 3 links left open | 3 states, 0 links, `fn` stopped | 3 handles |
| `Promise.race([handle, timeout])`, a `.then` callback that returns it, `Promise.resolve(handle)`, a library's "if it has a `then`, await it" | the state each time; 1 link left open each time | the state; `fn` stopped | the handle |
| a handle kept in a variable, then `await h` | the state; the link stays | the state; **the link ends** | (`await h.ready`) |
| read once | `await lens.connect()`: 1 SUB, **0 UNSUB; the link stays** | `await lens.connect()`: 1 SUB, 1 UNSUB | `await lens.get()`: 1 SUB, 1 UNSUB |

- **A thenable handle is evidence 1 again, one level down** (checked). E-55 removed `then` from the lens because an `async` function that returned the root lens downloaded every row. A thenable handle does the same thing to a link: any code that resolves a value (an `async` return, `Promise.all`, `race`, a `.then` callback, a library's check) swaps the handle for the state. With V-a the link then runs for the life of the process; with V-a1 the callback silently stops after its first call. V-b has neither failure.
- **`get()` built as `connect({ once })` hides whole-partition work on a client** (checked). Reading one number of a 1,000-row partition the client does not hold: E-55's `get()` made 1 GET and moved 1 byte; `get()` as `connect({ once })` made 1 SUB, moved the partition's whole picture (65,671 bytes), folded 1,000 rows into the cache, then sent an UNSUB and evicted them. When the partition is already held here, both read locally with no trip. So `get()` must stay a GET where nothing is held (evidence 8); it can share `connect`'s code only where the rows are already here.

### Probe 2: `for await` over connect (I12)

**A slow loop** ([results/timing.jsonl](results/timing.jsonl), `foreach.mjs grow`; measured, three runs). A writer makes 10,000 commits a second for 5 s on a 1,000-row server resource; the loop waits a 1 ms timer each turn (I/O-like work), so it manages about 870 turns a second.

| Loop | Link on | Turns | Commits the loop has seen | Commits a turn | Waiting at the end | Most waiting | Heap growth | Bytes per waiting commit |
|---|---|---|---|---|---|---|---|---|
| merged (no `from`) | one row | 4,314-4,367 | 49,990-49,996 of 50,000 | 11.4-11.6 | 1 | 1 | 0.3-0.4 MB | |
| merged (no `from`) | the whole resource | 4,322-4,395 | 49,991-49,995 of 50,000 | 11.4-11.6 | 5-9 rows | 27-50 rows | 0.3 MB | |
| every commit (`from: 'now'`) | one row | 4,363-4,413 | 4,362-4,412 | 1 | **45,588-45,638** | 45,588-45,638 | **16.1 MB** | 353 |
| every commit (`from: 'now'`) | the whole resource | 4,373-4,388 | 4,372-4,387 | 1 | **45,613-45,628** | 45,613-45,628 | **17.1 MB** | 375 |

- **Every commit, in order, means a queue that grows for as long as the loop is slower** (measured): 9,116-9,127 more each second, in a straight line (about 4,600 waiting at 0.5 s, 41,300 at 4.5 s), 353-375 bytes each with the rows they hold. At the end the loop was 52 s of its own work behind (reasoned from the numbers).
- **Merged turns stay small** (measured): at most one waiting change per row changed since the last turn (1 for a row, at most 27-50 for the whole resource), and every commit's effect still reached the loop, 11.4-11.6 commits a turn.
- **That is evidence 5, measured on one verb**: the live state (merged; a slow reader sees the newest) and the log (every record; it waits for you) behave differently on purpose. With one `connect`, the single option `from` switches the same loop from bounded memory to a queue with no bound. This prototype keeps that queue in the process; a real log reader reads the server's log by position, so there the cost is lag behind the log, not memory here (reasoned). What this measures is the gap between the two rules, which a design with a separate log verb has too; whether the switch may sit behind one option is a judgement, not something this probe settles (CONNECT.md 2.4).

**The cost per delivery** (`foreach.mjs cost`; measured, three runs; one link on the whole resource of 10,000 rows, a field write per commit; the ways interleaved, the median of 7 rounds; differences taken inside each round):

| Way | ns a commit | Over no link | Over the callback |
|---|---|---|---|
| no link | 931-976 | | |
| a callback `fn(state, commit)` that reads nothing | 1,087-1,162 | **161-189** | |
| a callback that reads `commit.changes` and each `prev` | 1,119-1,147 | 157-192 | |
| `for await`, every commit, the writer writes 100 then waits for the loop to drain | 1,209-1,279 | 311-336 | **116-137** |
| `for await`, merged, the same | 1,308-1,394 | 358-446 | **166-241** |
| `for await`, one commit at a time (every), over the writer's own `await` (1,011-1,096 with no link) | 1,763-1,830 | | **707-789** over that `await` |
| `for await`, one commit at a time (merged), the same | 1,918-1,982 | | **874-910** over that `await` |

- **A loop costs more than a callback per delivery** (measured): 116-137 ns more a commit when it keeps up in bursts, 166-241 ns when it merges (a map entry per changed row), and 707-910 ns more than a writer that awaits each commit with no link, when each commit is its own turn (a promise and its turns each time; no callback was timed that way). The callback's own 161-189 ns is within E-55's 92-198 ns for a tap (claim 10).

### Probe 3: the callback's `(state, commit)` (I2)

What `state` is ([results/checks.jsonl](results/checks.jsonl), `commit.mjs identity`, checked; 6 calls each: the picture and 5 writes):

| Lens | `state` | the same object as the call before | frozen | a React-style setter (skips when `Object.is`) renders | a state kept from the first call, read after the writes |
|---|---|---|---|---|---|
| a row `shop.data.k1` | the row: a new object at each write (data copies on write) | 0 of 5 | 0 of 6 | 6 of 6 | unchanged (the row as it was) |
| a field `shop.data.k1.n` | the value | n/a | n/a | 6 of 6 | unchanged |
| the whole resource `shop.data` | the live view: one object | **5 of 5** | 0 of 6 | **1 of 6** | **moved on**: shows the newest rows |
| a partition `chat.data.room1` (depth 2) | the live view: one object | **5 of 5** | 0 of 6 | **1 of 6** | **moved on**: shows the newest rows |

- **For a partition or the whole resource, identity checks miss every commit** (checked): a React-style setter rendered once in six calls. A new small wrapper each call (`set({ rows: state })`) rendered 6 of 6. A fresh copy each commit would be a hidden O(rows) copy (evidence 8; reasoned).
- **Rows are not frozen on the prototype** (checked: 0 of 6): it hands data's rows by reference, as E-55 did. Freezing each changed row costs 163-220 ns (E-55 claim 10, measured there).
- **The commit holds** `first`, `changes` (each `{ op, key, row, prev, path }`), `seq`, `recs()` and `text()`. **No change carries a version**: a per-row version would have to come with the frame (checked: `version` absent). For a row lens, `prev` is data's old row object, by reference (checked: it is the row the call before handed out); for a partition the live view cannot give the old row, only `prev` can. For a field lens, `state` is the value but `prev` and `row` are whole rows: the code takes the field down itself.
- **In a `for await` loop, a partition's `state` runs ahead of its `commit`** (checked, seeded): the loop reads the live view when its turn runs, and commits made in between are not in that turn's changes yet. In 196,267 merged turns, a partition's or the whole resource's state differed from the source at the moment the turn was taken 5,640 times (2.9 %); a row's state never did. A callback runs inside the commit, so it never sees this.

**What `prev` costs** (`commit.mjs prev`; measured, three runs). End to end, one link on the whole resource of 10,000 rows, the ways interleaved, the median of 9 rounds:

| Read in the callback, over a callback that reads nothing | 1 change a commit | 10 changes a commit |
|---|---|---|
| `commit.recs()` (the records only) | −70 to +29 ns | −118 to +177 ns |
| `commit.changes` and each `prev` | −57 to +3 ns | −94 to +112 ns |
| a fresh diff array `{ op, key, row, prev, version }` | −65 to +21 ns | −137 to +52 ns |
| the same, taken down to the written field | −80 to +7 ns | −239 to +114 ns |
| `commit.text()` | −23 to +24 ns | −82 to +47 ns |

The same work alone, with no writes in the timed loop (each way run over 100,000 commits' changes captured by reference from a real fold; ns per change):

| Way | 1 change a commit | 10 changes a commit |
|---|---|---|
| read `prev` (by reference) | 8.5-11.1 | 8.2-11.5 |
| build a diff object with `prev` and a version | 21.0-22.4 | 28.1-29.2 |
| build a field diff (`leafAt` on `row` and `prev`) | 30.5-35.3 | 50.3-59.0 |
| build the records | 137.6-170.3 | 155.1-164.2 |
| the records as JSON | 334.4-376.9 | 278.6-289.2 |

- **`prev` costs nothing to hand over** (measured): data already has it from its copy-on-write fold, and the commit passes it by reference (about 10 ns a change to read). End to end, no read of the commit was told apart from reading nothing at one change a commit; at ten, the rounds' spread (hundreds of ns) hides any of them.
- **Code that wants only the records pays for the records, not for `prev`** (measured): building the records costs 138-170 ns a change and their JSON 279-377 ns, against 21-29 ns for a fresh diff object. E-55 builds both once a commit, only when asked, and shares them across links (claim 9).

### Probe 4: `disconnect()` and a lifetime on one link (I3, I4)

**The cases** ([bench/lifetimes.mjs](bench/lifetimes.mjs), [results/checks.jsonl](results/checks.jsonl), checked). With the defaults (first call a microtask later, `break` ends the handle, strict `until`), **17 of 17 cases pass**: `disconnect()` twice; a signal that aborts after `disconnect()` (its listener was removed); `disconnect()` then the signal aborts; `until` on a Node socket already destroyed (the link is born ended, no selection); `until` on a thing that cannot say it closed (refused `bad-target`); `once` with `until` (one call; `once` removes the `until` listener); a loop over a handle nobody kept, ended by `break` (no link left); `disconnect()` from inside the callback's first call; one link ending another inside the same commit (not called for it); 1,000 links on one signal, 500 ended by hand first; `for await` over `connect({ once: true })` (one item); `until` and `signal` on one link (the first to fire removes the other's listener); a signal already aborted (no selection; `get()` with it rejects `aborted`); `until` closing while a loop waits (the loop ends); the callback aborting its own signal on its first call; with a guard per link, a partition's state read after its link ends throws `ended` in all four settings below; `until` with an HTTP request is refused `bad-target`.

**What breaks, and under which choice** (checked):

| Choice | What happens |
|---|---|
| the first call **inside** `connect()` (E-55's way) | `const h = lens.connect((s) => h.disconnect())` throws `ReferenceError: Cannot access 'h' before initialization` out of `connect()`; the link stays open, is called again at the next write, and **every later write throws** data's `AggregateError`. `for await (… of lens.connect({ once: true }))` gets **0 items**. 2 of 17 cases fail |
| `until` takes anything with `once` or `addEventListener` | a plain `EventEmitter` or a `MessagePort` that already closed is taken, and **the link never ends** |
| `break` ends only that loop | `for await (const x of lens.connect()) { …; break }` **leaves the link open for good** (1 link left), since nobody holds the handle |
| `break` ends the whole handle | a callback on the same handle **stops** when another piece of code breaks out of a loop over it (0 calls after the break) |
| a partition's `state` kept and read after its link ends, as first built (the shared live view) | **a different answer in each setting**: a client with no linger, 2 rows before and **0 after** (evicted); a client with a 50 ms linger, still 2 rows, and a server write after the end **shows** (`k1.n` 1 then 41), then 0 after the linger; a server, the write after the end **shows** (42); a client with another link on the same rows, the write **shows** (43). With a guard per link, every one of those reads, and `handle.state`, throws `ended` (a check above) |
| `from: 'now'`, commits made after `connect()` returns but before the loop starts | folded into the loop's first picture, not seen one by one: this prototype keeps commits only for loops that exist (a limit of the stand-in; a real `from` is a log position) |

**E-55's seeded lifetime checks, on connect** ([bench/sims.mjs](bench/sims.mjs), [results/sims.jsonl](results/sims.jsonl); each ran once under the heavy lock; a seed gives the same line every time):

| Check (E-55 claim) | What ran | Result |
|---|---|---|
| picture then changes (7) | 1,000 seeds, 150 steps each: writes, batches, several commits in one job, a removed key coming back; links made at random points (inside an open batch, inside another link's call) on a server and on a client (loopback, JSON frames), on the whole resource, a row, a depth-2 partition; 73,789 links: 40,778 callbacks, 7,467 `once`, 17,767 merged loops, 7,777 every-commit loops; ended by `disconnect()` 36,892, `signal` 18,387, `until` 18,510; 22,237 ended a second time | **0 doubled, 0 missed, 0 wrong `prev`, 0 unequal, 0 calls after the end, 0 merged turns unequal to the source at their take, 0 every-commit loops unequal once drained, 0 selections left** |
| the same, the first call inside `connect()` | 1,000 seeds, 74,356 links | 0 wrong; 14,354 first calls came inside an open batch and 13,800 inside a commit's effects; 8,184 first pictures of client links were taken while the server was mid-commit, where the check's oracle (the server's rows) is ahead of what the client can have, so those checks were skipped and counted |
| views end with their handle (26) | 1,000 seeds, 59,941 view sinks ended by the handle's `disconnect()` 20,758, its signal 17,579, `until` 9,597, `once` 4,670, the view link's own `disconnect()` 7,337 | **0 calls after the end, 0 views left, 0 selections left** |
| equal lenses share (9) | 1,000 bare handles and 1,000 callbacks on one row of a client, 100 writes; every handle disconnected twice | 1 SUB, 100 decodes, 100 folds, 100 `text()` builds for 200,000 deliveries; 0 UNSUB before the linger, 1 timer, 1 UNSUB after; 0 selections and 0 cache rows left |

**What `{ signal }` and `{ until }` cost a link** ([bench/signal.mjs](bench/signal.mjs), [results/timing.jsonl](results/timing.jsonl); measured, three runs, each process alone under the timing lock; each run the median of 7 interleaved rounds; ns a link). One signal shared by n links, the mechanism alone:

| links on one signal | a listener per link: add | its remove | one listener per signal and a Set: join | leave |
|---|---|---|---|---|
| 10 | 4,237-6,517 | 1,448-1,601 | 1,014-1,118 | 346-375 |
| 100 | 5,150-5,242 | 650-660 | 235-246 | 127-131 |
| 1,000 | 1,932-7,223 | 290-499 | 114-124 | 54-64 |
| 10,000 | 18,782-19,165 | 355-391 | 148-161 | 69-71 |

The prototype as built (a listener per link): n links on one row of a server, `connect()` then `disconnect()`, both together:

| links | no end option | `{ signal }`, one shared | `{ until }`, one socket-like thing | signal over none | until over none |
|---|---|---|---|---|---|
| 10 | 4,622-4,812 | 9,414-11,313 | 5,139-5,712 | +4,486 to +6,309 | +389 to +593 |
| 100 | 2,562-3,508 | 6,590-6,950 | 5,360-6,833 | +3,400 to +4,089 | +2,605 to +3,123 |
| 1,000 | 570-631 | 3,349-3,587 | 2,459-5,299 | +2,718 to +2,986 | +1,940 to +4,397 |
| 10,000 | 803-877 | 26,180-28,452 | 22,675-24,563 | +25,308 to +27,656 | +21,873 to +23,690 |

- **Listen once per signal, not once per link** (measured). A listener per link costs microseconds to add at every size (4-7 µs even at 10 and 100 links, so Node's `AbortSignal.addEventListener` is slow in itself, reasoned from those rows) and grows with the number of listeners (19 µs at 10,000), so the prototype's `{ signal }` adds 2.7-6.3 µs a link up to 1,000 links and 25-28 µs at 10,000. One listener and a Set cost 0.11-0.16 µs to join and 0.05-0.07 µs to leave at 1,000 and 10,000 links. That confirms READS.md's rough number (0.13-0.19 µs a link, from a bench not kept) and its rule; this prototype does not follow the rule.
- **`until` on a socket costs well under a microsecond for a few links** (measured): +0.39-0.59 µs a link with 10 links on one socket-like thing. With thousands of links on one emitter it grows the same way (a removal walks the list), which a real socket never sees.
- Small n is the noisiest row: at 10 links the per-round setup is spread over few links.

**The checks have teeth** (each planted bug must make its run fail):

| Planted bug | Where | What the run saw |
|---|---|---|
| `twice`: a second end releases the selection again | proto/connect.mjs, `disconnect` | picture: 28,137 unequal, 24 calls after the end (300 seeds); share: 2,001 linger timers; lifetimes: 1 case fails |
| `mergeprev`: a merged change keeps the newest `prev`, not the first | `mergeInto` | 4,953 wrong `prev` |
| `mergedrop`: a remove then an add of one key merges as an add | `mergeInto` | 388 doubled, 87 merged turns unequal |
| `percopy`: a new commit object per link | `deliver` | share: 100,000 `text()` builds, not 100 |
| `onceheld`: `once` ends the view's sink but not its hold | `viewConnect` | 1,273 views and 729 selections left |
| `nosignalcleanup`: `disconnect()` leaves the abort listener | `disconnect` | lifetimes: 2 cases fail (1,000 listeners on the signal where 500 should be) |
| `untilclosed`: no check that `until` already closed | constructor | lifetimes: 2 cases fail |
| E-55's `viewleak` | E-55's view ownership | 39,841 calls after the end, 8,171 views left |
| E-55's `cover` | E-55's nested selections | 95 merged turns unequal (first call a microtask later); 126 (inside) |
| E-55's `bornseq`, `settled` | E-55's clause-7 rules | **not caught with the first call a microtask later: 0 of 73,789 first calls came inside a batch or a commit's effects, so neither rule is ever reached.** With the first call inside `connect()`: 1,315 doubled, 883 missed, 3,822 wrong `prev` (`bornseq`); 533 doubled, 406 missed, 1,756 wrong `prev` (`settled`) |

### Probe 5: the types (I1, I9-I12)

[check/fero.d.ts](check/fero.d.ts) declares the owner's connect in both variants (`fero<Shop, 'a'>` and `fero<Shop>`), with `get()` as the read and `get(key)` as the step by a key (I10, next to I11). [check/forms.ts](check/forms.ts) holds the forms that must compile, each pinned by a type equality; [check/misuse.ts](check/misuse.ts) holds 17 lines that must not. tsc 6.0.2, `strict`: exit 0; with the 17 `@ts-expect-error` lines stripped, **17 of 17 fail at their own line** ([strip.mjs](strip.mjs); [results/types.jsonl](results/types.jsonl), [results/types-stripped.txt](results/types-stripped.txt); checked).

| Form | Types |
|---|---|
| `connect(fn)`, `connect(opts)`, `connect(fn, opts)` with `until`, `signal`, `once`, `from` | compile, with `state` typed per lens (a row: the row; the whole resource: its rows) |
| `for await (const { state, commit } of shop.data.connect({ from: v }))` | compiles; `state` and `commit` typed |
| V-a `await lens.connect()`; an `async` helper that returns `connect(fn)`; `Promise.all` | compile, and **the type is the state**: TypeScript unwraps the thenable, so the handle is gone from the types too. Misuse is caught only when the code later calls `disconnect()` on it (M7-M9, TS2339); a link nobody tries to end compiles silently |
| V-b `await lens.connect()` | compiles (awaiting a non-promise is allowed) and gives the handle; using it as the row fails (M10, M11) |
| `get()` and `get(key)` on one name | both type correctly by their argument (`shop.data.get(sku)` is a lens; `shop.data.get(sku).get()` reads) |
| `await shop.data.get(sku)` | **compiles**, and is a lens: `console.log((await shop.data.get(sku)).stock)` prints an address. It fails only where the value is used as a row (M14 `>`: TS2365; M15: TS2322) |
| `shop.data.get(body.sku)` with `body: any` | compiles as the step (a lens). At run time the call must then choose by the count of its arguments and refuse an undefined key; choosing by the key's value would turn a missing key into a read of the whole resource (reasoned) |
| `useEffect(() => lens.connect(fn).disconnect, [])` | compiles; returning the handle itself is refused (M17) |

The messages for a wrong call are poor (checked): `connect(draw, draw)` says "Type '(w: Readonly<Widget>) => void' has no properties in common with type 'ConnectOpts'" (TS2559); `connect({ once: true }, draw)` says "'once' does not exist in type '(state: Readonly<Widget>, commit: Commit<Widget>) => void'" (TS2353); `connect('textContent')` lists both overloads (TS2769).

**Two slips the types cannot catch, run** ([bench/slips.mjs](bench/slips.mjs), [results/checks.jsonl](results/checks.jsonl), checked; not timed):

| Slip | What it did on Node 22.22.0 |
|---|---|
| a forgotten `.get()`, printed: `JSON.stringify(lens)` | `undefined`; inside an object the field is dropped, `{}`. `console.log(lens)` prints `Lens(shop.widgets)`, `String(lens)` gives `shop.widgets`, and the lens is truthy |
| `{ until: req }` on a long response, the request's body read (as a body parser does) | the request said `close` at 19 ms, with `destroyed` true, while the client stayed until 315 ms; the response said `close` at 318 ms. So a link ended by the request would end at once |
| the same, the body not read | the request said `close` with the client, at 304 ms |

The prototype's strict `until` now refuses a thing with a `method` (an HTTP request) with `bad-target` (lifetimes case 16).

## Limits

- The prototype's `connect` sits on E-55's prototype: no fero kernel, no log, no positions. `from` takes only `'now'`, and an every-commit loop keeps its commits in this process; a real one would read the server's log by position.
- The seeded runs use small worlds (12-30 rows, 4 partitions), on a server and a loopback client in one process; no worker, no real port, no reconnect.
- The timed parts are this folder's harness, not data's perf suite. The for-await loop's slowness is a 1 ms timer (I/O-like work), not CPU work.
- The types are a sketch of the owner's connect, not API.md's declarations.
- The guard that makes a read after the end throw `ended` is a second `Proxy` per link over the shared view; it shows the rule can be kept in every setting, not what it costs. A real build would check one flag inside the read trap the view already has.
- The prototype listens to a signal once per link (`addEventListener` per link), not once per signal as CONNECT.md says fero does; `signal.mjs` times both ways.

## How to rerun

```sh
SP=<your scratch folder> ./run.sh types    # probe 5 (tsc 6.0.2), under the heavy lock
SP=<your scratch folder> ./run.sh checks   # probes 1, 3 (identity), 4 (lifetimes, its planted bugs) and 5's slips, under the heavy lock
SP=<your scratch folder> ./run.sh sims     # E-55's seeded checks on connect, then every planted bug, under the heavy lock
SP=<your scratch folder> ./run.sh timing   # probes 2, 3 and 4's signal cost, three runs each under the timing lock
SP=<your scratch folder> ./run.sh summary  # the timed tables from results/timing.jsonl
```

Env: `SP` (required: holds the lock helpers `bin/timing` and `bin/heavy`), `NODE` (default `node` on PATH, Node 22.22.0; tsc 6.0.2 from PATH, or from `NODE`'s folder when `NODE` is a path), `RUNS` (default `1 2 3`), `DATA` (data's folder, default `../data` next to this repo, at 63fea66), `OUT` (temp files, default `$SP/e56/probes`). Versions: [results/versions.txt](results/versions.txt).
