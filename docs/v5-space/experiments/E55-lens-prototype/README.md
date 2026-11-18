# E-55: the connect lens, built small on data's real engine

**Question (Q-55).** [LENS.md](../../LENS.md) recommends a new shape for fero v5's API: `f.data.a.b.c` is a lens (an address that does no work), `here()` is the line between a server's work and this process's work, `connect(target, …)` keeps a target up to date for as long as the target lives, a method called on a path runs at that path's leader, and `tap` gets one argument per commit. Nothing of it was built. Its section 6 lists 25 claims, each with a bar. Built small on data's real engine, does the shape meet those bars? And what does building it show that LENS.md got wrong or left out?

**It decides** whether API.md is rewritten around the lens (LENS.md section 7, question 10), and LENS.md's fallback: "if claims 1, 8 or 14 miss their bars, the lens stays an address (`at()`), and the rest holds."

<!-- answer:start -->
## The answer first

This page was revised on 2026-11-18 after a skeptic's review (24 findings; "The review" below). The prototype was changed for the findings, and the seeded runs and the touched timed parts were run again. "The first build" is the prototype as first measured.

- **Mostly yes.** Built small on data's real engine (a lens, `here()`, `connect`, `tap`, selections shared through a keyed index, a client in one thread and a server in a worker joined by a real `MessagePort`, methods on a path), the shape works. Of 27 claims (LENS.md's 25 and 2 the review added), **10 pass, 10 pass in part, sit at the edge of their bar or are stand-ins, 1 misses, 3 are records with no bar, and 3 were not run** (measured; one verdict rule for every timed claim: the median of its runs against its bar).
- **The correctness claims hold on the changed build, and they cover less than the first form of this page said** (measured, seeded). A link's picture then its changes equalled the source in 1,000 seeds in one process and in 1,000 seeds across disconnects and resumes over a port. Equal lenses shared one subscription, one fold and one `c.text()` per commit. Moving `here()` never changed an answer when the order travelled with the rows. Each check caught the bug planted in it. **But the first build had four holes the first checks could not see**: a read (`await lens`) depended on when the collector ran; a lens was a promise to JavaScript, so an `async` helper that returned the root lens downloaded every row; views right of `here()` outlived their handle; and a method could be called on any path. All four are fixed and now checked (claims 4, 14, 18 and the new 26).
- **"Collector timing never changes a result" needed a rule about reads** (measured). On the first build the same program made 0 GETs or 1 by when a collection ran, and showed 9.7 here-or-trip patterns per program over 1,000 collector seeds. Now a read is served here only from rows held on purpose (a server, `hold: 'all'`, a live `here()` or `tap`): 1 result and 1 pattern per program over 1,000 seeds.
- **The four-line derive is exactly once only when it is paced** (measured, a seeded stand-in). With a cap on waiting writes and a `backpressure` refusal the loop ignores, 998 of 1,000 seeds lost outputs. With the reader paused while the target's queue is full, or the slot blocked after a refusal: 0 lost and 0 doubled, at a cap of 8 and at the real cap of 512. The first form of claim 21 passed because it could not fail on this.
- **Of the three claims that decide LENS.md's fallback, one passes and two are borderline** (measured). Claim 14 passes on the changed build. Claim 8: K lenses on K rows cost 1.09 to 1.52 times no lens at K = 10,000 over 15 runs, median 1.25 (bar 1.3; data today about 120 times); the first build's own median is 1.19 and the changed build's is 1.36. Claim 1: a step costs 49 to 99 ns with one key at any size, but **162 to 222 ns (median 205) with keys spread over 1e6 rows** (bar 150), a cell whose own noise is about 100 ns. A plain object per step costs 71 to 106 ns there, so the `Proxy` costs about 100 ns a step on a big heap. That is the case LENS.md already sends to `at()`. The owner decides.
- **A step keeps nothing** (0 to 0.3 B a key; data's handle today 1,333 B), **a write through a lens adds 0.18 to 0.73 µs** (bar 1.0), **a read through `lens.get()` holds nothing**, and **un-awaited marked writes run 510 to 558 times faster** than awaited ones (measured).
- **A tap is not free, and the first harness could not say whose cost it is** (measured). Interleaved round by round, a tap that reads nothing adds 92 to 198 ns a commit; data's own delivery to any sink is 63 to 122 ns of it and the lens's share 31 to 103 ns (bar 50: not resolved). Reading `c.changes` or `c.now` adds nothing measurable. Freezing each row handed to a sink adds 163 to 220 ns per changed row.
- **A pushed-down view costs what the view costs, on either side** (measured): 2.3 to 53 µs per view per change on the server, 1.6 to 62 µs run on the client. So claim 16's first bar (1 µs on the server) said nothing about pushdown. What pushdown buys is wire bytes: a first picture of 677 to 765 B against 6 KB to 6.6 MB. It moves the view's CPU and 9.9 KB to 12.8 MB of memory per shape to the server.
- **`depth: 2` passes for partitions of 100 rows and more, and misses for one-row partitions**, because today's data makes each partition a full data source (D3). **`asOf` reads pass; its fold adds 1.5 to 2.0 µs a record** on data's real fold (bar 1.0) and keeps 103 B a version at 1e5 rows and 285 B at 1e6 (bar 220).
- **Weak links cost more than LENS.md first said** (measured). A target check is 26 to 35 ns (bar 50), but 10,000 weak links cost 2.2 times 10,000 strong sinks (bar 1.1). Registering a target costs 0.13 to 0.33 µs in ordinary jobs (bar 0.3), but 0.58 to 0.67 µs in one long job that made about 150,000.
- **The collector is only a net.** In a headless Chromium, 0 of 1,000 links to removed DOM nodes ended within 30 s, idle or busy; in Node, 7 ms to 1.4 s, depending on what the heap did before (measured). Forced, it ended 1,000 of 1,000 links, and no function ran for a collected target even before its finalizer (measured).
- **Not run**: claim 22 (the view selector in E-31's model), claim 25 (the 22 patterns on E-22's prototype) and claim 27 (a served view, class C: `f.methods.x(arg).here()` is not built here). Claims 18 and 21 are stand-ins.

<!-- answer:end -->

## Words used

- **Lens**: an address. It names a resource and a path inside it (`shop.data.widgets.stock`) and holds no data.
- **Step**: one property read on a lens (`.widgets`). **Verb**: a call on a lens (`.set(4)`).
- **Kept lens**: a lens made once and stored in a variable, so a verb on it takes no steps.
- **Selection**: what one subscription brings into a process: a partition, the whole resource, or (class B) a view of a partition. Equal lenses share one selection.
- **Link**: one live connection from a selection to a target: a `here()` hold, a `connect(target, …)`, or a `tap(fn)`.
- **Strong sink, weak link**: a `tap(fn)` keeps its function alive until it is closed. A `connect(target, fn)` holds its target only by a `WeakRef`, so the target can be collected.
- **The net**: the garbage collector as the last way a link ends (a `WeakRef` to the target, a `FinalizationRegistry` entry, and a check of the target before every delivery).
- **Picture**: the selection's rows at the moment a link starts. **Frame**: one commit's records on the wire.
- **Class A / B / C** (LENS 2.3): left of `here()` may stand a partition (A), plain-data operators inside one partition (B), or a view the server named in `methods:` (C).
- **Pushdown**: running class B's operators on the server and sending only their answer.
- **Coverage** (named here): a partition selection inside a live whole-resource selection sends no subscription of its own.
- **Order channel**: data's `wireSink` sends, with each added row, its place in an ordered view (`at`), and `move` records when a row's place changes. A plain keyed copy drops them.
- **Spread keys** and **one key**: a timed loop that reads a different row each time (the rows are spread over memory, so most reads miss the CPU cache) or the same row each time.
- **Job**: one turn of the JavaScript event loop. A `WeakRef` keeps its target alive until the job that made or read it ends.

## Method

All code is in this folder. Node 22.22.0 (V8 12.4) for every run unless a line says Node 26.13.0; TypeScript 6.0.2; esbuild 0.25.12; Chromium 153 (Chrome for Testing, through Playwright 1.63.0). data at commit 63fea66, imported read-only from the sibling data repo, `../data` (its `api/index.ts`, and `kernel/node.ts` for `SourceNode` and `leafAt`). Nothing in data was changed. Box: 4 shared vCPU, 15 GB, Linux 6.18. Versions: [results/versions.txt](results/versions.txt).

**What was built** ([proto/lens.mjs](proto/lens.mjs), 831 lines after the review, 702 before; [proto/net.mjs](proto/net.mjs), 213 lines). The table describes the changed build; "The review" says what each row was before:

| Piece | How | LENS.md |
|---|---|---|
| the lens | one `Proxy` per step over a callable target (a fresh function carrying four fields: resource, parent, key, path); one shared handler; nothing cached. A call pops the last step as the verb. A lens is not a promise: `then` and six other probe names read as `undefined`, and a read is the verb `get()`. `f.at(...keys)` is a plain class, no `Proxy`; it turns number keys into strings | 2.1 |
| writes | `lens.set(v)` and `f.set(path, v)` both end in data's `SourceNode.write(key, path, v)`: one data commit | 2.5 |
| selections | one per partition (depth 1: a row; depth 2: the first key) and one for the whole resource; a count and a linger; equal lenses share one | 2.2 |
| D1, the keyed index | depth 1: ONE data sink per store routes each row delta through a `Map` from row key to selection (proto/lens.mjs:254-272). Depth 2: each partition is its own data source, so a selection sinks its own source | 4.5 D1 |
| `here()`, `connect`, `tap` | `here()` is a counted hold with `ready`, `rows`, `value`, `close()`. `connect(target, fn)` and `connect(target, 'prop')` hold the target by `WeakRef`; `tap(fn)` holds `fn` strongly | 2.2 |
| the commit object `c` | one per selection per commit, shared by its sinks: `first`, `changes` (data's `RowDelta`s by reference, with `prev`), `now` (the selection's rows, read where they are), `recs()` and `text()` built once and kept on `c`. A new link's first call gets its own `c` whose `changes` is the picture as adds (proto/lens.mjs:68-84) | 1.6, 2.7 |
| lifetimes | `close()`, a scope, the target's own `'close'` (only for a Node `EventEmitter`, a `WebSocket`, a `MessagePort`, or an event the caller names), the count reaching zero (after a linger), and the net: a `FinalizationRegistry` entry and a check of the target before every delivery. A view right of `here()` ends with the handle it was made from | 2.2, 2.7 |
| reads | `lens.get()` is served here only from rows held on purpose (a server, `hold: 'all'`, a live `here()` or `tap` on the partition or the whole resource); else one GET, which carries the highest server position the client has seen | 2.2 |
| clause 7 | a link made inside an open data batch takes its picture at the batch's commit (data's `attachWhenSettled`); a link made inside a commit's effects skips that commit (`connectSeq`) (proto/lens.mjs:393-411) | 2.2 |
| a client | a cache (data sources on its own data runtime) fed by an upstream transport; `f.rows` throws `not-held` unless the client holds everything on purpose (`hold: 'all'`); rows a selection brought are evicted when no live selection names them | 2.2, 2.6 |
| coverage (not in LENS.md) | found by claim 7: a partition selection inside a live whole-resource selection sends no SUB; when the whole ends, the partitions it covered SUB again from the whole's server position (proto/lens.mjs:190-223) | none |
| the wire | a server Resource in a worker thread; clients on real `MessagePort`s; JSON text frames; one frame text per selection per commit, shared by every port; a ring of the last 1 to 64 frames per selection for resume, else a new picture | 2.3, LAYERS 4 |
| class B pushed down | for claim 16 only: a SUB with `{ part, ops }` builds one data view per distinct shape on the server and sends its wire records (data's `wireSink`, with the order channel) | 2.3 |
| methods on a path | a method declares where it may be called (a bare function: the root; `{ at: 'row' \| 'partition' \| 'any', run }`: a path of that kind) and the server refuses any other path, `bad-path`. `lens.sell(1)` runs the handler with `ctx.at` = that lens; `lens.call(name, arg)`; for claim 18, 3 or 5 server workers with a leader table, forwarding and redirects ([bench/leader.mjs](bench/leader.mjs)) | 2.4 |
| `asOf` | for claim 23 only: fat nodes (per row: the versions it changed at and the row each made) fed by one data sink from each commit's `row` and `prev` ([bench/asof.mjs](bench/asof.mjs)) | 2.9 |

**How each claim was measured.** Every timed number is from three runs, each process alone under the box's timing lock and preceded by its load average ([run.sh](run.sh)). A timed loop is the median of 5 rounds (7 for some), the ways interleaved round by round, a full collection before each round ([bench/common.mjs](bench/common.mjs)). Tables show the range over the three runs. The seeded runs ran once, under the heavy lock. Each seeded check was also run with a planted bug, which it must catch (see "The checks have teeth").

**The review pass** ran every seeded run again on the changed build, with the new checks and their planted bugs, under the heavy lock ([results/review-sims.jsonl](results/review-sims.jsonl)), and three more runs of the timed parts the changes touch, under the timing lock ([results/review-timing.jsonl](results/review-timing.jsonl)): claim 10 with the ways interleaved, claims 1 and 3, claim 8, claim 20. Claim 8 also got an A/B of the two builds, alternated in one hold ([results/review-fan-ab.jsonl](results/review-fan-ab.jsonl)). The other timed tables below are the first build's; the review did not touch what they measure.

**Six follow-ups were added in the first pass**, each because a first-run number missed its bar and the reason was not clear. Each ran three times under the timing lock: [bench/stepvariant.mjs](bench/stepvariant.mjs) (claim 1: four ways to build a step), [bench/weakprobe.mjs](bench/weakprobe.mjs) (claim 6: a registration made 1 to 10,000 in one job, in a clean and in a loaded process), [bench/firstprobe.mjs](bench/firstprobe.mjs) (claim 6: a first picture with and without a full collection right before), a bare data sink in [bench/connect.mjs](bench/connect.mjs)'s `tap` part (claim 10: data's own delivery cost; runs 2 and 3 only), a fairer `weak work` in the same file (claim 11: each strong sink writes its own object, as each weak link writes its target; run 1's first line is kept and marked), and [bench/viewprobe.mjs](bench/viewprobe.mjs) (claim 16: the view alone in data; its `wireSink` way in runs 2 and 3 only).

## Results

Each claim, its bar (LENS.md section 6 in its first form), what was measured, and the verdict. Timed numbers are the range over three runs of the first build, unless a row says "review" (then: every run on record, and "The review" has the table). **A verdict on a timed claim is the median of its runs against its bar.** "Today" is LENS.md's number for data or fero as they stand. Every table below is also in [results/summary.md](results/summary.md), made by `./run.sh summary` from the raw lines.

| # | Claim | Bar | Measured here | Verdict |
|---|---|---|---|---|
| 1 | a step is cheap | the lens's own share ≤ 0.15 µs a step; a kept lens's verb ≤ 0.2 µs over the direct call; `at(k1, k2)` ≤ 0.1 µs over it | review, 6 or 7 runs a cell: one key: 49-99 ns a step at 1e3-1e6 rows. Keys spread: 54-67 ns at 1e3, 95-236 ns at 1e5 (median 116), **162-222 ns at 1e6 (median 205)**. Two other `Proxy` builds: 114-203 ns at 1e6; a plain object per step, no `Proxy`: 71-106 ns. Kept verb: −63 to +24 ns. `at()`: −79 to +33 ns with keys spread; one key at 1e6 rows 54-154 ns (median 82) | **pass in part**: a miss at 1e6 rows with keys spread (a cell with about 100 ns of noise); every other median meets its bar |
| 2 | a step keeps nothing | ≤ 16 B kept per key, one and two steps deep | 0-0.3 B per key, both depths (100,000 keys). data's handle today: 1,333 B two deep. A lens the app keeps costs 296 B | **pass** |
| 3 | a write through the lens | ≤ +1.0 µs with steps, ≤ +0.3 µs kept, over `f.set([k,'n'], v)` | review, 6 or 7 runs a size: steps +176 to +734 ns (medians 311, 474, 340); kept −26 to +424 ns (medians 163, 165, 276), at 1e4-1e6 rows | **pass** on every median; the kept lens is at the edge at 1e6 rows (3 of 6 runs over 0.3 µs) |
| 4 | the call space holds | every case passes | 22 of 22 on the first build; **47 of 47** on the changed build, with the review's cases (a lens is not a promise, the probe names, `at()` with a number key, a method on a wrong path) | **pass** |
| 5 | the types hold | the 22 lines compile; six named lines do not; retry typed assignment | first form: the 22 lines compiled with four small edits, one a real defect (P-01); LENS.md 2.0's own `stock.set(4)` failed, as its own 2.4 says it must. LENS.md now carries the edited lines: exit 0 as written. 11 must-fail lines fail, each for its reason (the first 8, plus a row method below its row, a row method at the root, `await lens` used as a value); typed assignment still impossible for a mapped type | **pass in part**: the bar was "as written" and the first form missed it (finding 5) |
| 6 | set-up | a second `connect` ≤ 0.3 µs (a lookup and a count); registering the target ≤ 0.3 µs; first picture in proportion to the selection only | the lookup and count 39-45 ns; a second `here()` 163-169 ns. Registering a target: 0.13-0.33 µs made 1 to 10,000 a job (clean, or with 100,000 rows held), but 0.58-0.67 µs inside one job that made about 150,000, where a whole second `connect` cost 691-739 ns. A 100-row room's first picture: 0.17-0.23 ms at 1e4 rows in all and 0.16-0.19 ms at 1e6, each right after a full collection (the setup bench); 26-28 µs with no collection before, measured at 1e5 rows only (the follow-up) | **pass in part**: lookup, count, registration in ordinary jobs, and the picture pass; one very long job misses |
| 7 | picture then changes equal the final state | equal in 1,000 seeds; none missed or twice; [net] across a reconnect | [data] 1,000 seeds, 93,326 sinks: 0 wrong. [net] 1,000 seeds, 4,337 disconnects, 5,968 resumes, 4,743 new pictures: 0 wrong (second pass) | **pass**, with finding 2 |
| 8 | path subscriptions are flat | ns per write at K = 10,000 within 1.3× of K = 0 | first build, 3 runs: 1.20, 1.25, 1.36 (1.66-1.69 µs against 1.24-1.39 µs; data today: 368-397 µs). Review, 15 runs on record: 1.09-1.52, **median 1.25**; the first build alone 1.19 (8 runs), the changed build alone 1.36 (7 runs). From K = 10 to K = 10,000: 1.06-1.13×; the first lens pays data's own sink | **at the edge, counted "in part"**: the median of all runs meets 1.3; the changed build's own does not, and the cause was not found |
| 9 | equal lenses share | one upstream subscription, one fold per change, one `c.text()` per commit, one unsubscribe after the linger; [net] one SUB, one decode per change | exactly one of each, by counters, both | **pass** |
| 10 | the sink by reference | ≤ 0.05 µs per commit over no tap when it reads nothing; ≤ 0.3 µs per change read | review, the ways interleaved, 3 runs: reads nothing: 92-198 ns a commit, of which data's own delivery to any sink is 63-122 ns and the lens's share 31-103 ns. Reading `c.changes` with `prev`: −39 to +32 ns; `c.now`: −33 to +91 ns. Freezing each row handed out: 163-220 ns. data's tap today with a parameter: 1.5-1.8 µs. (The first harness: 149-165, 102-124 and 38-46 ns; its noise was 37-530 ns) | **pass in part**: the read bar is met; "reads nothing" misses; the lens's own share is not resolved against 50 ns |
| 11 | a weak link is as cheap as a strong sink | 10,000 of each within 1.1×; the target check ≤ 50 ns | 2.18-2.21× with sinks that write their target; 3.7-4.6× with sinks that do nothing; +28 to +35 ns per link per commit. The check alone: 26-35 ns | **miss** (ratio); the check passes |
| 12 | unsubscribe by a forced collection | 1,000 of 1,000 end; no function called for a collected target, even before its finalizer | 1,000 of 1,000 ended by the delivery check in the same turn as the collection, before any finalizer, with 0 calls; 1,000 of 1,000 by finalizers when nothing was written. One commit with 1,000 dropped, uncollected targets: 0.80-0.90 ms (all 1,000 functions still ran) | **pass** |
| 13 | unsubscribe by a natural collection | none; record p50 and p99; if a busy p99 is over 10 s, the collector is a net only and the dev warning is required | Node: young targets 7-8 ms busy, 1.2-1.4 s idle (999 of 1,000; one never); old targets 0.33-0.40 s. **Chromium: 0 of 1,000 removed DOM nodes in 30 s**, idle and busy | recorded; **the condition holds**: busy p99 over 10 s in the browser, so the collector is a net only and the dev warning is required |
| 14 | collector timing never changes a result | equal across 1,000 seeds; `f.rows` never shows a row held only by a link | first build: 1 distinct result per program over 1,000 collector seeds, **but `await lens` was computed and left out of the result**; counted, 9.7 here-or-trip patterns per program. Changed build (review): **1 result and 1 here-or-trip pattern per program**; `f.rows` of a client without `hold: 'all'` always `not-held` | **pass** on the changed build, with finding 3 and the read rule |
| 15 | the capture trap | none; record it | a function that names its target: never collected (a plain object and a DOM node); the same link using its argument: collected. A dev check sees the detached DOM node, not the plain object | recorded |
| 16 | a filter pushed to the server | first bar: server ≤ 1 µs per affected view plus one encode per shape per change; ≤ 1 KB plus the answer per shape; the wire carries the answer. **Restated by the review, with no pass or fail**: the server CPU and memory moved per shape, against the bytes and decodes saved per reader | moved: server 2.3-5.2 µs per view per change at 100-1,000-row rooms (10 shapes or more), 8-12 µs at 10,000 rows, 51-53 µs at 100,000 (one view: 124-201 µs); server memory 9.9 KB to 12.8 MB a shape. The same views run here cost the client the same (1.6-62 µs); the view alone in data costs 1.0-2.4 µs at 1e3 rows and 9.3-12.5 µs at 1e5. Saved: 0-32 B a change per shape against 60-63 B for the partition; first picture 677-765 B a shape against 6 KB to 6.6 MB | **recorded.** The first bar measured the wrong thing: no placement makes a view cheaper. Class B is not built for other reasons: no budget for shapes, the unmodelled `view` selector, the order channel |
| 17 | moving `here()` never changes the answer | equal in 1,000 seeded runs | 0 of 1,000 differ when the client keeps the order channel; 239 of 1,000 differ with a plain keyed copy | **pass**, with finding 4 |
| 18 | a method on a path reaches its leader | one trip and one commit with a fresh table; one redirect after a move; about 2 in 3 extra trips with no path | exactly so, 3 and 5 servers (0.662 and 0.797 extra trips with no path). Review: 202 of 202 calls on a path the method did not declare refused `bad-path`, 0 commits | **a stand-in**: one trip and one commit are true by construction once the table is right |
| 19 | `depth: 2` | fold within 1.1× flat + PA-17's index; a 100-row room's first picture ≤ 0.74 ms at 1e6 rows; ≤ 300 B per partition; a row write 0.9-2.0 µs; ≤ 8 B more per record | partitions of 100-10,000 rows: fold 0.78-1.10× flat + index, bytes 1.2-805 KB a partition **less** than flat + index, first picture 0.012-0.013 ms, key +2 B. One-row partitions: 1.31-1.53× and +887-893 B a partition. A row write is 2.1-3.9 µs, but flat's is 2.0-3.4 µs on this box at 1e5-1e6 rows | **pass** for partitions of 100 rows and more; **miss** for one-row partitions (D3 not built) |
| 20 | a read holds nothing | 0 rows and 0 subscriptions after 100,000 misses; one trip each | 0, 0; 100,000 GETs, 0 SUBs | **pass** |
| 21 | marks from app code | none lost or twice; the un-awaited loop ≥ 100× the awaited one | rate: 510-558× (122,054-134,082 against 239-240 writes a second). First form of the sim: 0 lost, 0 doubled in 1,000 seeds, but it could not fail on the rule the pattern rests on. Second form (review; a cap, a `backpressure` refusal, lost-then-delivered across a slot move, no bare marks): **as written 998 of 1,000 seeds lose outputs; paced, or blocked after a refusal, 0 lost and 0 doubled**, at cap 8 and at cap 512 | **pass with the pacing rule; a stand-in** (not E-30's model) |
| 22 | the view selector in E-31's model | every property in ≤ 8 rules | not run | **not run** |
| 23 | `asOf` on data's real fold | ≤ +1.0 µs a record; ≤ 220 B a version; a step ≤ 0.2 µs; a row at a version ≤ 2.4 µs; a 150,000-version row ≤ 2 µs; every answer equal to a refold | +1.5 to +2.0 µs a record; **103 B a version at 1e5 rows, 285 B at 1e6** (heap after minus heap before, E-54's method); a step 10-12 ns; a row 0.6-1.4 µs; the hot row (150,473 versions) 142-211 ns; 0 wrong in 1,680 checks | **pass in part**: reads pass; the fold's cost and, at 1e6 rows, the memory miss |
| 24 | the import matrix | only `import { shop }` runs or ships the server | Node 22 and 26 and tsc: yes. esbuild with `verbatimModuleSyntax` also ships the server for `import { Shop }`; without it, ships it for neither plain import | **pass in part**: Node and tsc pass; one bundler cell misses (finding 6) |
| 25 | the 22 patterns on E-22's prototype | as E-22 | not run | **not run** |
| 26 | (review) views right of `here()` end with their handle | no sink called after its end; no view and no selection left | 1,000 seeds, 59,958 view sinks ended by `close()`, a scope, the seeded collector or `link.close()`, with a linger: 0 calls after the end, 0 views left, 0 selections left. The first build's behaviour, planted: 22,539 calls after the end in 300 seeds | **pass** |
| 27 | (review) a served view on the prototype, class C: `f.methods.x(arg).here()` | as claims 7 and 9 for a served view; the cap refuses the next view | not built | **not run** |

**Count**: of 27 claims, 10 pass (2, 3, 4, 7, 9, 12, 14, 17, 20, 26), 10 pass in part, sit at the edge of their bar or are stand-ins (1, 5, 6, 8, 10, 18, 19, 21, 23, 24), 1 misses (11), 3 are records with no bar (13, 15, 16), and 3 were not run (22, 25, 27). The first form of this page counted 13 passes of 25; "The review" has the recount.

### Claims 1 to 3: a step, what it keeps, a write

[bench/step.mjs](bench/step.mjs). A read verb on a lens is `lens[VALUE]` (a symbol, so it is not a key); `direct` is the call every verb turns into, with no `Proxy`. Keys spread: row `(j × 7919) mod N`. 200,000 operations a way, the median of 5 rounds.

All in ns. Each cell is the range over three runs (one key, except the two "spread" columns).

| rows | direct read | kept lens, read verb | one step and the verb | two steps and the verb | `at(k, n)` | data's handle today, two deep | a `Map` read | **a step, one key** | **a step, keys spread** | kept verb over direct | `at` over direct, one key |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1000 | 55.3-65.5 | 64.3-65.6 | 93.3-96.1 | 174-178 | 60.7-68.9 | 177-199 | 14.3-18.4 | 54.7-56.1 | 60.7-66.8 | 0.1-10.1 | 3.4-10.9 |
| 100000 | 63.9-73.2 | 64.7-71 | 104-119 | 203-236 | 84.7-93.4 | 193-227 | 27.8-33.7 | 69.4-83.3 | 118-236 | −4 to +7.1 | 11.5-29.5 |
| 1000000 | 73.8-112 | 71.5-135 | 116-127 | 235-292 | 147-228 | 234-331 | 27.2-62.2 | 78.3-99.2 | 188-210 | −5.8 to +24 | 60.7-154 |

**With keys spread over 1e6 rows, a `Proxy` step misses the bar however it is built** ([bench/stepvariant.mjs](bench/stepvariant.mjs); ns per step, (two steps and the read − the direct read) / 2):

| rows | keys | proto | handler | shared | plain | direct read |
|---|---|---|---|---|---|---|
| 100000 | same | 75.2-82.2 | 59.6-69.9 | 53.4-60.4 | 14.9-16.6 | 44.6-49.2 |
| 100000 | spread | 105-137 | 102-126 | 99.7-119 | 58-89.7 | 425-447 |
| 1000000 | same | 76.8-105 | 52.4-94 | 46.7-89.6 | 16.3-48.1 | 72.1-83.4 |
| 1000000 | spread | 192-229 | 153-203 | 114-189 | 71.3-106 | 1118-1271 |

- `proto` is lens.mjs as built: a fresh function per step as the `Proxy`'s target, with four fields and a custom inspector set on it, so `console.log(lens)` prints the path (Node inspects a `Proxy`'s target, not its traps).
- `handler` keeps the step's fields on a small object used as the `Proxy`'s handler, and `shared` uses one shared function as every step's target. Both lose the printed path. They save 10 to 40 ns a step, not enough.
- `plain` is a small class per step with no `Proxy` at all. It shows what a step costs before the `Proxy`: about half.
- So with keys spread over 1e6 rows a `Proxy` step costs about 100 ns more than a plain object step, and the read itself is then 1.1 to 1.3 µs (most of it cache misses). The lens's share stays under 20 % of that read.

**Claim 2** (bytes kept per distinct key after 100,000 distinct keys and a full collection):

| way | B per key |
|---|---|
| one step, read | 0-0.3 |
| two steps, read | 0-0.3 |
| two steps, kept by the app | 296 |
| data's handle today, two deep | 1,333 |

**Claim 3** (ns per write of the same integer values; 200,000 writes a way):

| rows | f.set([k,n],v) | L[k].n.set(v) | kept.set(v) | f.at(k,n).set(v) | data handle today | steps over direct | kept over direct |
|---|---|---|---|---|---|---|---|
| 10000 | 732-947 | 1046-1135 | 883-959 | 718-788 | 1656-1701 | 176-403 | −19 to +227 |
| 100000 | 1187-1283 | 1592-1772 | 1323-1465 | 1203-1226 | 2177-2375 | 309-585 | 40.3-259 |
| 1000000 | 751-898 | 1047-1170 | 873-1107 | 780-786 | 1658-1843 | 225-420 | −26 to +313 |

### Claims 6, 8, 10, 11: set-up, many lenses, the sink, weak links

[bench/connect.mjs](bench/connect.mjs), on a server resource in one process.

**Claim 6, set-up** (ns each, 10,000 of each, the selection already held; 100,000 rows):

| what | ns |
|---|---|
| here (kept lens) | 163-169 |
| here (at) | 69.8-74.2 |
| connect fn (kept lens) | 691-739 |
| connect prop (kept lens) | 904-1054 |
| tap (kept lens) | 140-323 |
| lookup + count | 38.8-44.5 |
| weakref | 491-557 |
| register | 79.1-127 |
| register with token | 255-261 |
| target registration | 584-668 |

**Claim 6, the first picture** of a fresh room (a `tap` that walks `c.changes`), depth 2, each timed right after a full collection:

| rows in all | rows in the room | first picture ms |
|---|---|---|
| 10000 | 100 | 0.17-0.23 |
| 1000000 | 100 | 0.16-0.19 |
| 100000 | 1 | 0.13-0.15 |
| 1000000 | 10000 | 0.72-0.78 |
| 100000 | 10000 | 0.67-0.68 |

**Claim 6, a registration made B at a time in one job** ([bench/weakprobe.mjs](bench/weakprobe.mjs); ns each, the loop and clock subtracted; a new job between batches; "100,000 rows held" first loads the setup bench's resource and makes and closes 50,000 links):

| process | runs | way | B=1 | B=10 | B=100 | B=1000 | B=10000 |
|---|---|---|---|---|---|---|---|
| a clean process | 3 | weakref | 158-261 | 116-151 | 86.7-97.2 | 81.8-85.2 | 126-137 |
| a clean process | 3 | register | 57.3-85.6 | 39-45.1 | 23.6-38.9 | 22-36.4 | 21.2-51.7 |
| a clean process | 3 | both | 183-334 | 157-187 | 111-133 | 112-124 | 147-170 |
| a clean process | 3 | object | 44.8-61.9 | 8.9-17.4 | 7.3-11.3 | 8.7-10.7 | 9.3-11.3 |
| 100,000 rows held | 3 | weakref | 127-182 | 105-111 | 81.7-105 | 75.9-88.3 | 130-145 |
| 100,000 rows held | 3 | register | 13.4-53 | 46.6-62.7 | 46.8-55 | 42.3-52.5 | 52.2-77 |
| 100,000 rows held | 3 | both | 165-226 | 160-183 | 139-151 | 129-140 | 169-184 |
| 100,000 rows held | 3 | object | 16-56.9 | 18.3-30.3 | 9.7-19 | 10.8-18.4 | 12-16.2 |

**Claim 6, a first picture with and without a full collection right before** ([bench/firstprobe.mjs](bench/firstprobe.mjs); 200 different 100-row rooms of 100,000 rows; µs):

| what | runs | p50 | p90 |
|---|---|---|---|
| tap + close, no collection before | 3 | 26-27.6 | 37.2-41.1 |
| tap + close, a full collection before | 3 | 149-166 | 185-218 |
| data connect + dispose, a full collection before | 3 | 37.1-42.4 | 51-63.1 |
| data connect + dispose, no collection before | 3 | 0.8-0.9 | 1.2-1.4 |

- **Registering a target meets the 0.3 µs bar when links are made in ordinary jobs**: 0.13-0.33 µs for a `WeakRef` and a registry entry, in a clean process or one holding 100,000 rows (measured). The setup bench's 0.58-0.67 µs came from a process that made about 150,000 of them, with their `deref()` calls, in one job with no `await`; a `WeakRef` keeps its target in the job's kept set until the job ends, so that set grows the whole time (reasoned from the probe; not isolated further).
- **The first picture is in proportion to the selection**: the same at 1e4 and 1e6 rows. Its 0.15 ms floor in the setup table is the first work after the full collection the bench makes before each picture; without one, a 100-row room's first `tap` and `close` take 26-28 µs, of which data's own `connect` is under 1 µs (measured).

**Claim 8, K lenses on K rows** (ns per write; 100,000 rows; writes spread over every row, so a write meets a lens K/N of the time):

| K | lens (keyed index) | data path connect today |
|---|---|---|
| 0 | 1243-1388 | 2947-3293 |
| 10 | 1495-1568 | n/a |
| 100 | 1467-1585 | 5448-5867 |
| 1000 | 1388-1516 | 25849-26238 |
| 10000 | 1659-1692 | 367894-396546 |
| 100000 | 2344-2379 | n/a |

The ratio K = 10,000 over K = 0, run by run: 1.20, 1.25, 1.36. K = 100,000 over K = 0: 1.69-1.91.

**Claim 10, the sink** (ns per write over the same loop with no sink; 10,000 rows, 200,000 field writes, one sink on the whole resource):

| what | ns |
|---|---|
| a tap that reads nothing, over no sink | 149-165 |
| reading `c.changes` and each `prev`, over reading nothing (one change a commit) | −36 to −11 |
| reading a row through `c.now`, over reading nothing | −45 to +89 |
| building `c.recs()`, over reading nothing | 130-166 |
| data today: `tap((rec) => …)` over `tap(() => …)` | 1289-1772 |
| a bare data sink (no lens), over no sink (runs 2 and 3) | 102-124 |
| the lens's own share: a tap that reads nothing, over a bare data sink (runs 2 and 3) | 38.2-46.1 |

**Claim 11, weak links against strong sinks** (ns per commit, 10,000 of each on one selection, 2,000 writes):

| sinks | runs | strong ns/commit | weak ns/commit | ratio | per link delta ns | deref check ns |
|---|---|---|---|---|---|---|
| no work | 3 | 92520-151903 | 384795-517224 | 3.73-4.61 | 28.16-35.02 | 26.38-30.46 |
| work, own target | 3 | 269058-304186 | 586472-661134 | 2.18-2.21 | 31.74-34.24 | 27.53-34.77 |
| work, shared object (first harness) | 1 | 187469-198405 | 638452-660066 | 3.41 | 45.1 | 29.46 |

Run 1's first harness had every strong sink write one shared object while each weak link wrote its own target, so cache misses fell on the weak side only; that line is kept but not used. The fixed harness (each strong sink writes its own object) ran in all three runs.

### Claims 12, 13, 15: links whose targets the program drops

[bench/gc.mjs](bench/gc.mjs), [browser/run.mjs](browser/run.mjs).

**Claim 12, a forced collection** (`--expose-gc`; 1,000 connects on one row, the targets promoted to the old generation, then dropped):

| one commit before any collection | functions run then | a commit in the same turn as a full collection | functions run then | links ended by the delivery check | by finalizers (a second round with no writes) |
|---|---|---|---|---|---|
| 0.80-0.90 ms | 1,000 | 1.24-1.30 ms | **0** | **1,000** | **1,000** |

Until a collection runs, a dropped target's function keeps running (LENS.md 2.2 cites 0.54-0.80 ms for that commit from lens-first's prototype). After one, no function runs for it, even before any finalizer: the check before delivery (rule 1) ends all 1,000 links at the first commit. With no commit, the finalizers end them. A dev warning names the path once.

**Claim 13, natural collection** (no `--expose-gc`; 1,000 links on one row, their targets dropped; 30 s a cell; three runs; [results/natural.jsonl](results/natural.jsonl)). **idle**: nothing runs; **busy**: 2,000 small objects every 10 ms (about 100 KB); **busy-writes**: the same plus one commit to the row every 10 ms; **old**: the targets aged into the old generation by allocation before the drop.

| Where | Targets | Mode | Ended by 0.1 s | by 1 s | by 5 s | by 15 s | by 30 s | p50 | p99 |
|---|---|---|---|---|---|---|---|---|---|
| Node 22 | young | idle | 0 | 0 | 999 | 999 | 999 | 1.19-1.43 s | 1.19-1.43 s |
| Node 22 | young | busy | 999 | 999 | 999 | 999 | 999 | 7 ms | 7-8 ms |
| Node 22 | young | busy-writes | 999 | 999 | 999 | 999 | 999 | 7-8 ms | 8 ms |
| Node 22 | old | idle | 1,000 | 1,000 | 1,000 | 1,000 | 1,000 | 0.33-0.39 s | 0.33-0.39 s |
| Node 22 | old | busy | 1,000 | 1,000 | 1,000 | 1,000 | 1,000 | 0.34-0.36 s | 0.34-0.36 s |
| Node 22 | old | busy-writes | 1,000 | 1,000 | 1,000 | 1,000 | 1,000 | 0.33-0.40 s | 0.34-0.40 s |
| Chromium 153 | DOM nodes, removed | idle | 0 | 0 | 0 | 0 | **0** | never | never |
| Chromium 153 | DOM nodes, removed | busy | 0 | 0 | 0 | 0 | **0** | never | never |
| Chromium 153 | DOM nodes, removed | busy-writes | 0 | 0 | 0 | 0 | **0** | never | never |

- **In the browser, not one of 1,000 removed DOM nodes was collected within 30 s**, idle or busy, in any run (measured; one headless Chromium, [browser/links.js](browser/links.js)). So the busy p99 is over 10 s, and claim 13's condition holds: the docs must call the collector a net only, and the dev warning is required. LENS.md already plans both.
- **In Node, the time depends on what the heap did before** (measured). Young targets went at the next minor collection: 7 ms when the program allocates, 1.2-1.4 s when it is idle. Old targets went at 0.33-0.40 s here, because the allocation that aged them had started a major collection that finished soon after the drop. cost-first's harness aged them without one and saw 8.1 s idle and never within 30 s busy (LENS.md 2.2). Both are the same fact: the collector, not the program, picks the moment.
- **In every young cell one target of 1,000 was never collected**, the same in all three runs. Nothing in the program names it ([bench/gc.mjs](bench/gc.mjs)); the likely holder is the suspended top-level `async` frame, which keeps a stale copy of the loop's last `t` (reasoned, not checked). An app can hit the same thing.

**Claim 15, the capture trap** (`--expose-gc`; five commits and five full collections, then 1 s; [results/gc.jsonl](results/gc.jsonl)):

| The link's function | Its target collected? | What a dev check saw |
|---|---|---|
| `(t, c) => { t.last = c.seq }` (uses its argument) | **yes**; the net ended the link | the warning "the net ended links on f.k1: close them, or end them with a scope" |
| `(_t, c) => { a.last = c.seq }` (names its target `a`) | **never** | nothing |
| the same on a DOM node another piece of code removed (`isConnected === false`) | **never** | "a link on f.k1 feeds a detached DOM node that is still alive: does its function close over its target?" |

So a function that names its target keeps it alive for good, and only the DOM case can be seen: a target that says it is detached but keeps being fed (code proto/lens.mjs:416-417). A plain object gives no sign.

### Claim 16: a class B view pushed to the server, against the partition held and the view run here

[bench/net.mjs](bench/net.mjs) `pushdown`: one room (a depth-2 partition) of P rows on a server worker; S distinct shapes `room.gt('stars', t).za('stars', 10)`, one per threshold t; 2,000 writes of `stars` to random rows. **push**: one data view per shape on the server, its `wireSink` records encoded once and sent. **local**: the client holds the room (one SUB) and builds the S views here. Server and client time is the time spent handling messages (decode, fold, views, encode, send).

| room rows | shapes | server µs a change, push | server µs a change, local | **server µs per view, push − local** | client µs per view, local | encodes a change, push | wire B a change, push / local | first picture B a shape, push / local | server memory a shape, push | answers right |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 1 | 17.6-22.9 | 9.20-11.4 | 7.66-11.6 | 15.6-20.5 | 0.20 | 31.6 / 60.2 | 705 / 6,002 | 74.4-74.5 KB | yes |
| 100 | 10 | 43.8-58.0 | 8.25-9.51 | 3.42-4.94 | 4.13-4.86 | 1.58 | 264 / 60.2 | 707 / 5,999 | 26.1 KB | yes |
| 100 | 100 | 243-264 | 7.63-8.84 | 2.34-2.56 | 1.63-1.83 | 13.8 | 2,281 / 60.2 | 677 / 6,004 | 11.9 KB | yes |
| 100 | 1,000 | 2,981-3,228 | 8.31-9.21 | 2.97-3.22 | 2.27-2.82 | 161 | 26,455 / 60.2 | 680 / 5,996 | 9.70 KB | yes |
| 1,000 | 1 | 17.5-20.0 | 7.99-11.1 | 8.72-11.1 | 13.3-17.6 | 0.02 | 3.00 / 61.2 | 721 / 61,706 | 168-169 KB | yes |
| 1,000 | 10 | 47.0-52.4 | 8.63-12.0 | 3.74-4.38 | 4.08-4.58 | 0.27 | 44.9 / 61.2 | 725 / 61,677 | 94.9-95.0 KB | yes |
| 1,000 | 100 | 326-395 | 11.0-12.9 | 3.13-3.82 | 3.26-3.98 | 1.35 | 229 / 61.2 | 730 / 61,694 | 71.2 KB | yes |
| 1,000 | 1,000 | 4,528-5,227 | 9.04-9.64 | 4.52-5.22 | 5.90-6.21 | 17.9 | 3,034 / 61.2 | 722 / 61,686 | 66.5 KB | yes |
| 10,000 | 1 | 28.8-38.1 | 8.30-9.18 | 20.5-29.0 | 17.2-18.4 | 0.00 | 0.30 / 62.2 | 745 / 636,647 | 1,571-1,572 KB | yes |
| 10,000 | 10 | 90.5-111 | 8.74-9.24 | 8.12-10.2 | 8.63-10.4 | 0.02 | 3.40 / 62.2 | 749 / 636,701 | 876-877 KB | yes |
| 10,000 | 100 | 1,046-1,169 | 10.7-12.7 | 10.4-11.6 | 11.9-12.4 | 0.25 | 42.8 / 62.2 | 746 / 636,734 | 721 KB | yes |
| 100,000 | 1 | 133-215 | 9.16-14.1 | 124-201 | 41.0-44.3 | 0.00 | 0.10 / 63.2 | 765 / 6,566,627 | 12,502-12,503 KB | yes |
| 100,000 | 10 | 520-540 | 9.05-10.3 | 51.0-53.1 | 54.5-62.1 | 0.00 | 0.00 / 63.2 | 763 / 6,566,919 | 8,043 KB | yes |

**The view itself** ([bench/viewprobe.mjs](bench/viewprobe.mjs): data alone, no lens, no wire, no worker; the shape `gt('stars', 500000).za('stars', 10)`; 2,000 field writes, the median of 5):

| partition rows | the fold alone | the view adds: source seeded and promoted (claim 16's server) | seeded, not promoted | filled by writes (a client cache) | `wireSink` on the view, then JSON (runs 2 and 3) |
|---|---|---|---|---|---|
| 1,000 | 1.03-1.18 µs | 2.30-2.41 µs | 1.23-2.06 µs | 1.04-1.84 µs | none seen (−0.9 to −0.8 µs: noise) |
| 10,000 | 1.48-2.21 µs | 3.12-4.04 µs | 1.93-2.67 µs | 1.96-2.36 µs | none seen (−0.6 to −0.5 µs: noise) |
| 100,000 | 2.24-2.60 µs | 11.8-12.5 µs | 9.26-10.5 µs | 10.1-12.0 µs | none seen (−1.7 to −0.9 µs: noise) |

- **A class B view costs what the view costs, on either side.** The server's cost per view (push − local) and the client's cost per view (local) are within 2× of each other in every cell but one: 1.6-6.2 µs at 100-1,000 rows with 10 shapes or more, 8-12 µs at 10,000, 51-62 µs at 100,000 (measured). data's ordered view with a window is far from the "about 1 µs per affected view" LENS.md 2.3 takes from E-05, and grows with the partition.
- **One cell is unexplained**: a single view on a 100,000-row room cost the server 124-201 µs a change, 3 to 5 times the client's 41-44 µs for the same view. The view alone in data costs 9-12.5 µs there (the probe). The server worker runs without the main process's `--max-old-space-size` (code proto/net.mjs:125), which may change how its collector sizes the young generation; not tested.
- **The wire does what LENS.md says**: pushed, it carries only the answer (0-32 B a change for one shape, against 60-63 B for the whole room), and a shape's first picture is its answer, 677-765 B, against 6 KB to 6.6 MB for the room. But a process that asks for 1,000 shapes of one room gets 26 KB a change, against the room's 60 B (measured, 100-row room).

### Claim 19: `depth: 2`

[bench/depth2.mjs](bench/depth2.mjs). `flat`: one data source keyed `'p/r'`. `flatidx`: the same plus PA-17's index (a `Map` from partition to its row keys, kept on every fold). `d2data`: one data source per partition, today's data (D3 is not built). `d2plain` and `flatplain`: the same two shapes as plain `Map`s with data's copy rule and no engine, as floors. Fold: 1,000,000 records at 1e6 rows (200,000 below), E-54's mix (45 % field writes, 45 % row writes, 5 % adds, 5 % removes), one commit each. Bytes per partition: the store's heap after a full collection, minus flat's, over the partition count.

| rows | rows a partition | partitions | fold ns a record: flat / flat + index / **depth 2 (data)** / depth 2 (plain `Map`s) | depth 2 over flat + index, same run | **bytes a partition, depth 2 − (flat + index)** | a partition's first picture ms: flat / flat + index / depth 2 | row write ns: flat / depth 2 |
|---|---|---|---|---|---|---|---|
| 1,000 | 1 | 1,000 | 905-924 / 969-1,019 / **1,069-1,247** / 160-214 | 1.10-1.24 | **1,196** | 0.03-0.04 / 0.00 / 0.00 | 672-690 / 943-1,136 |
| 1,000 | 100 | 10 | 851-1,068 / 962-1,149 / **894-951** / 142-172 | 0.78-0.99 | **−1,154** | 0.03-0.05 / 0.00 / 0.00 | 710-846 / 697-902 |
| 100,000 | 1 | 100,000 | 2,040-2,108 / 2,327-2,434 / **3,188-3,453** / 816-1,106 | 1.31-1.48 | **887** | 3.40-3.64 / 0.00 / 0.00 | 2,318-2,462 / 3,303-3,707 |
| 100,000 | 100 | 1,000 | 1,771-2,140 / 1,781-2,174 / **1,940-2,077** / 609-682 | 0.96-1.10 | **−4,727** | 2.98-3.43 / 0.04-0.05 / 0.01-0.02 | 2,129-2,501 / 2,487-2,871 |
| 100,000 | 10,000 | 10 | 1,731-1,900 / 1,765-2,100 / **1,690-1,912** / 557-638 | 0.82-0.97 | **−805 KB** | 3.02-3.12 / 2.02-2.12 / 0.21-0.30 | 2,043-2,636 / 2,144-2,528 |
| 1,000,000 | 1 | 1,000,000 | 2,773-2,860 / 3,136-3,201 / **4,514-4,906** / 1,627-1,742 | 1.42-1.53 | **893** | 34.9-37.9 / 0.00-0.01 / 0.00-0.01 | 2,975-3,164 / 5,268-5,624 |
| 1,000,000 | 100 | 10,000 | 2,840-3,005 / 2,830-3,134 / **2,989-3,214** / 1,344-1,351 | 1.03-1.10 | **−9,241** | 32.6-40.2 / 0.07-0.10 / 0.01 | 3,227-3,378 / 3,744-3,923 |
| 1,000,000 | 10,000 | 100 | 2,499-2,563 / 2,694-2,738 / **2,412-2,495** / 1,118-1,288 | 0.89-0.92 | **−639 KB** | 30.8-32.3 / 6.31-6.82 / 0.17-0.21 | 2,812-3,098 / 2,790-3,135 |

- **Partitions of 100 rows and more pass**: the fold is 0.78-1.10 times flat + index, a partition costs less memory than PA-17's index for it, and a 100-row room's first picture takes 0.012-0.017 ms at 1e5-1e6 rows (bar 0.74 ms; flat with no index walks every row: 30-40 ms at 1e6).
- **One-row partitions miss**: today's data makes each partition a full data source, 0.9 KB more than the index entry, and the fold costs 1.3-1.5 times. A plain two-level `Map` (the `d2plain` column) is the cheapest store of all at every size, so the miss is the cost of a data source per partition, not of two levels: that is D3.
- **The row write bar (0.9-2.0 µs) is not met by any store at 1e5-1e6 rows on this box**, flat included (2.0-3.4 µs). Depth 2 is 0.9-1.2 times flat for partitions of 100 rows and more, 1.4-1.9 times for one-row partitions.
- **A record's key** grows by 2 B in JSON (`["p12","m1234"]` against `["p12/m1234"]`; bar 8 B).

### Claim 20: a read holds nothing

[bench/net.mjs](bench/net.mjs) `miss`: a client over a real `MessagePort`; 100,000 reads (`await client.data['k' + i]` on the first build, `await client.data['k' + i].get()` on the changed one) on rows it does not hold. The server saw 100,000 GETs and 0 SUBs. Afterwards the client had 0 selections and 0 cached rows; its heap had grown 197 KB (2 B a read: noise). 42.9-44.4 µs a read, a port round trip. The review's three runs on the changed build: the same counts, 43.4-45.1 µs a read, and 0 answers behind the position the client had seen. **Pass.**

### Claim 21: the rate of un-awaited marked writes

[bench/marks.mjs](bench/marks.mjs) `rate`: a server worker that answers writes at a group commit every 4 ms (a stand-in for a disk sync), over a real `MessagePort`. Awaited one at a time: 239-240 writes a second (LENS.md: 250). Sent without waiting: 122,054-134,082 a second, 510-558 times as many. **Pass** (bar: at least 100 times).

### Claim 23: `asOf` on data's real fold

[bench/asof.mjs](bench/asof.mjs): E-54's tape (1,000,000 records), folded by data's `SourceNode`; `fat` adds one data sink that keeps, per row, its versions and the row each made (a row's first change also keeps `prev` as its version 0). Kept bytes per version: fat's heap growth over the records (heap after minus heap before, full collections at both ends), E-54's method. The first form of this table subtracted base's heap growth, which is negative (−20 and −133 B a record), and so showed 123 and 418 B; the raw lines are unchanged.

| rows | the fold alone, ns a record | with fat nodes, ns a record | **added a record** | **kept a version** | a step | a row at a version | the hot row (150,473 versions) at a version | wrong answers |
|---|---|---|---|---|---|---|---|---|
| 100,000 | 1,843-2,070 | 3,576-3,837 | **+1.68-1.83 µs** | **103 B** | 10.0-10.6 ns | 0.61-0.92 µs | | 0 of 1,680 |
| 1,000,000 | 2,452-2,512 | 4,151-4,412 | **+1.64-1.96 µs** | **285 B** | 9.72-10.2 ns | 1.09-1.37 µs | | 0 of 1,680 |
| 1,000,000, 15 % of records to one row | | 3,742-3,932 | | | 10.4-11.9 ns | 1.03-1.30 µs | 142-211 ns | 0 of 1,680 |

- **Reads pass**: a step is a number (10-12 ns), a row at any version 0.6-1.4 µs, the hot row 142-211 ns, and every answer equal to a refold from the start.
- **The fold misses**: fat nodes on data's real fold add 1.5-1.9 µs a record, against E-54's +0.97-1.02 µs for the same layout beside a plain `Map` (E-54 README, measured). The extra is data's delivery to a sink at all (claim 10: about 0.1 µs a commit) and the collector: every version keeps a row that would otherwise be garbage.
- **Memory at 1e6 rows misses**: 285 B a version (bar 220; E-54 measured 219 B beside a plain `Map`, by the same method), because most rows change only once in 1,000,000 records, and a row's first change keeps its `prev` (the old row) and makes its version lists. At 1e5 rows (about 10 changes a row) it is 103 B (E-54: 104 B).

### Claims 5 and 24: types and imports

**Claim 5** ([types/](types); tsc 6.0.2, strict). The bullets below are the first form ([results/types-first-pass.jsonl](results/types-first-pass.jsonl)): LENS.md's lines as it first wrote them. After the review LENS.md carries the edited lines, with reads as `lens.get()` and methods declared `{ at, run }`; [types/patterns.ts](types/patterns.ts), [types/screens.ts](types/screens.ts) and [types/lens.d.ts](types/lens.d.ts) were changed to match, three must-fail lines were added to [types/negatives.ts](types/negatives.ts), and the check ran again ([results/types.jsonl](results/types.jsonl)): the three configs exit 0, and the 11 must-fail lines fail (TS2551, TS2769, TS2339, TS2349, TS2339, TS2339, TS2349, then the review's three: a row method below its row TS2339, a row method at the root TS2339, `await lens` used as a value TS2322; and a method's argument TS2345). [types/lens.d.ts](types/lens.d.ts) (201 lines) declares LENS.md's shape on API.md section 6's own declarations, which run.sh extracts from API.md as API.md's checker does.

- **The 22 patterns' lens lines** (LENS.md 2.10), in [types/patterns.ts](types/patterns.ts): exit 0, with four edits, each marked EDIT. P-01's `(await client.data.widgets)?.stock` needs a leading `;`: as written, the line before it is called (TS2349). That is a real defect of the line. P-15's step object goes inside `saga([...])` (a bare object line is a block), P-16's `…` becomes `void e`, and P-07 needed none.
- **LENS.md's other code blocks** (2.0, 2.2, 2.4, 2.5, 2.9, 1.1, 1.2, 1.6, 1.7), in [types/screens.ts](types/screens.ts): exit 0, with three edits (`live.value?.stock`; a `client` that 2.4 uses without making; a guard on `e.value`) and two lines that must carry `@ts-expect-error`: 2.0's `await stock.set(4)` and `stock.set(op.incr(…))` write on the typed client of a resource with methods, which 2.4 itself says has no `set` (V4-5).
- **The lines that must not compile**, in [types/negatives.ts](types/negatives.ts): all 8 fail, each for its reason when its `@ts-expect-error` is stripped: a wrong field (TS2551), a wrong value type (TS2769), an early stage on a field write (TS2339), a function left of `here()` (TS2349, "not callable", which does not say why), `set`, `remove` and the array `set` on the typed client of a resource with methods (TS2339, TS2339, TS2349), and a method's argument of the wrong type (TS2345). The sixth named line, a plain import of the exported type under `verbatimModuleSyntax`, gives TS1484 (claim 24).
- **Typed assignment, retried** ([types/assign.ts](types/assign.ts)): still not possible on a mapped type. Steps typed as read-only lenses refuse it (TS2540). Steps typed as lenses refuse a number (TS2322). Steps typed as "a value or a lens" accept it, but `.set` then stops typing (TS2339). An accessor pair with different get and set types works for a named key only (`interface { get stock(): Lens; set stock(v: number) }` compiles); the same pair in a mapped type is not valid syntax (TS1005, [types/assign-mapped.ts](types/assign-mapped.ts)). LENS.md 2.1 stands: typed code writes with `set`.

**Claim 24** ([imports/](imports), [results/imports.jsonl](results/imports.jsonl)): a server file that prints when it runs, and four clients.

| The client says | Node 22.22.0 and 26.13.0 (type stripping) | tsc, `verbatimModuleSyntax` | tsc, without | esbuild 0.25.12, tsconfig with `verbatimModuleSyntax` | esbuild, without |
|---|---|---|---|---|---|
| `import type { Shop }` | client runs; server does not | ok | ok | server not shipped | not shipped |
| `import { Shop }` (the exported type) | **SyntaxError at link time**; nothing runs | **TS1484** | ok | **server shipped** | not shipped |
| `import type { shop }` | client runs; server does not | ok | ok | not shipped | not shipped |
| `import { shop }` (the handle) | **the server runs** | ok | ok | **server shipped** | not shipped |

The bar: only the last runs or ships the server. Node and tsc meet it. esbuild with `verbatimModuleSyntax` also ships the server for `import { Shop }` (it keeps every import as written and does not check types), and without that setting ships it for neither plain import (it drops imports used only as types).

### The seeded runs (claims 4, 7, 9, 14, 17, 18, 21)

Each ran once, under the heavy lock ([results/sims.jsonl](results/sims.jsonl)). A seeded run is exact: the same seed gives the same line. **This table is the first build's.** The review ran every one again on the changed build, with new checks for claims 4, 14, 18 and 21 and the new claim 26 ([results/review-sims.jsonl](results/review-sims.jsonl)); "The review" has what changed. Two rows below are superseded there: claim 14 (its result left out `await lens`) and claim 21 (its sim could not fail on the rule the pattern rests on).

| Claim | What ran | Result | Bar | Verdict |
|---|---|---|---|---|
| 4 call space | a row with fields `set`, `filter`, `connect`, `here`, `then`, `sell`, `top`; methods `sell` and `top`; 22 cases | 22 of 22 pass: each field by a step (`then` by `at`), each verb by a call, `.top(3)` is fero's operator and `.call('top', 3)` the method, `util.inspect(lens)` prints `Lens(shop.r1.set)`, `String(lens)` prints `shop.widgets.left` | every case | **pass** |
| 7 [data] picture then changes | 1,000 seeds, 150 steps each: writes, batches of 1-5 writes, links made at random points (25% of them inside an open batch, some inside another sink's call), on a server and on a client (loopback, JSON frames), on the whole resource, a row, a field, a depth-2 partition; 93,326 sinks | 0 doubled, 0 missed, 0 unequal, 0 `prop` targets unequal, every first call on an empty sink | equal in every seed | **pass** |
| 7 [net] across a reconnect | 1,000 seeds over a real `MessagePort` to a server worker; a ring of 1 to 8 frames; 43,794 steps, 4,337 disconnects with writes while down, 5,968 resumes from the ring, 4,743 new pictures | 0 doubled, 0 missed, 0 phantom (an update that changes nothing: a frame applied twice), 0 unequal | the same | **pass** (second pass; see "The first pass") |
| 9 [data] equal lenses share | 1,000 `here()`s and 1,000 `connect`s on one row of a client (loopback, JSON frames), 100 writes | 1 upstream subscription; 100 frames decoded, 100 folds, 100 `c.text()` builds for 100,000 deliveries; every target current; 0 unsubscribes before the linger, 1 timer, 1 unsubscribe after it; 0 selections and 0 cache rows after | one of each | **pass** |
| 9 [net] | the same over a `MessagePort`, 200 writes | the server saw 1 SUB and made 200 encodes; this client got 200 frames, made 200 decodes and 200 `c.text()` builds | one SUB, one decode per change | **pass** |
| 14 collector timing | 3 programs × 1,000 collector seeds: an adversary ends each dropped link at a random step ("at once" to "never") and runs its finalizer later or never; 58,178 links ended by the net | everything live handles read, every live target's state, `f.rows` of a `hold: 'all'` client and `cl.rows` (always `not-held`) are the same in all 1,000 seeds: **1 distinct result per program** | equal across 1,000 seeds | **pass** |
| 14, control 1 | the same programs on a client whose `f.rows` reads its whole cache (the read-through-the-handle rule broken) | 33.7 distinct row histories per program | must differ | differs, as it must |
| 14, control 2 | half the dropped links run a function that writes **outside** its target (a shared counter) | 432.7 distinct results per program | must differ | differs: see finding 3 |
| 17 moving `here()` | 1,000 seeds, chains of 1-3 plain-data operators (11 kinds, 5 aggregates), every position of `here()` (3,000 positions, 438 distinct chains); left part a data view on a "server" source, its `wireSink` records to a client source, right part there | with the client keeping the **order channel** (`at` and `move` records): **0 of 1,000 runs differ**. With a plain keyed copy: 239 of 1,000 runs differ, every one at the position where an ordering operator is the last thing left of `here()` (`reverse`, `za`, `top`, `az.top`, …) | equal in 1,000 runs | **pass, with a condition LENS.md does not state** (finding 4) |
| 18 method on a path | 3 and 5 server workers, 300 partitions, a leader table, real ports between client and servers and between servers | fresh table: 1,000 calls, 1,000 trips, 1,000 commits, 0 forwards. After 30 leader moves: first call 2 trips (1 redirect), next call 1 trip. No path: an extra trip 0.662 of the time with 3 servers (2/3 expected), 0.797 with 5 (4/5) | one trip, one commit; one redirect; about 2 in 3 | **pass** (a stand-in: see the limits) |
| 21 marks from app code | 1,000 seeds: un-awaited `{ from: e }` writes over per-slot FIFO queues, crashes losing in-flight writes, 10% refused writes, two derivers under one name, slot moves | 0 lost, 0 doubled in 1,000 seeds (54,018 applied, 5,982 refused, 121,758 skipped at the mark, 19,686 moves, 11,421 crashes). Control (a move that loses its marks): 1,000 of 1,000 seeds wrong, 7,006 doubled | none lost or twice | **pass** |

### The checks have teeth

Each seeded check was run with a planted bug ([results/mutants.jsonl](results/mutants.jsonl), this pass; the first pass's are in [results/mutants-first-pass.jsonl](results/mutants-first-pass.jsonl)). Every one makes its run fail:

| Planted bug (env) | Where | What the run saw |
|---|---|---|
| `bornseq`: a link made inside a commit's effects also gets that commit | proto/lens.mjs:411 | 1,396 doubled, 1,113 missed, in 300 seeds |
| `settled`: a link made inside an open batch takes its picture at once, not at the batch's commit | proto/lens.mjs:398 | 514 doubled, 392 missed, 204 unequal |
| `cover`: a partition selection inside a live whole-resource selection sends its own SUB | proto/lens.mjs:197 | 536 unequal, 83 `prop` targets wrong |
| `floor`: the server resumes from a cursor older than its ring | proto/net.mjs:88 | 999 unequal, in 100 seeds |
| `resend` + `nodedupe`: the server resends the frame at the cursor, and the client does not drop it | proto/net.mjs:89, 197 | 697 phantom updates |

### The first pass, and why the harness changed

The seeded runs ran twice. The first pass is kept as [results/sims-first-pass.jsonl](results/sims-first-pass.jsonl). It found three things, and the code was changed before the second pass ([results/sims.jsonl](results/sims.jsonl)):

1. **Claim 7 [net] failed**: 75 phantom updates (a frame applied twice) and 49 unequal sinks in 1,000 seeds (first failing seed 86). The code now carries two fixes, each marked "found by claim 7's [net] sim": a resume cursor is the server's position (`upSeq`), never the client's local commit number, and a partition that a whole-resource selection covered resumes from the whole's position when the whole ends (code proto/net.mjs:166-168, proto/lens.mjs:216); and a client drops records it already applied when one partition is seen through two selections around that hand-over (code proto/net.mjs:195-198). Second pass: 0 of each. This is a real bug in the prototype's resume, and a rule the design needs (finding 2).
2. **Claim 18 did not start**: its workers inherited `--expose-gc` and `--max-old-space-size` from run.sh's command line, and Node refused them (`ERR_WORKER_INVALID_EXEC_ARGV`). Both worker launchers now drop those flags (code bench/leader.mjs:60, proto/net.mjs:125). A harness bug, not a lens finding.
3. **Claim 4 was added**: the first pass has no call-space line.

The lines for claims 7 [data], 9, 14, 17 and 21 are the same, byte for byte, in both passes. The two lines of [results/sims.jsonl](results/sims.jsonl) that contain the word "failed" are `"failedSeeds":[]` (claim 7 [data] and [net]): empty lists, so no failure. The first pass's two `"part":"failed"` lines were the claim 18 start-up error above. The real misses in the second pass are not marked "failed": claim 17's keyed copy (239 runs) and claim 14's second control (432.7 results), and both are explained above.

## What the prototype shows LENS.md got wrong, or left out

1. **A step costs more than 0.15 µs when keys are spread over a big resource** (claim 1; measured). With one key, a step's own share is 55-99 ns, under the 0.15 µs bar at every size. With keys spread over 1e5 rows it is 105-236 ns (5 of 6 measures under the bar), and over 1e6 rows 188-229 ns (none). Building the step differently does not fix it: with the fields on the `Proxy`'s handler, or one shared target, a step costs 114-203 ns at 1e6 rows, and printing the path is lost; a plain object per step, with no `Proxy`, costs 71-106 ns ([bench/stepvariant.mjs](bench/stepvariant.mjs)). So the `Proxy` itself costs about 100 ns a step when the heap is big and the keys are spread. The read under it costs 1.1-1.3 µs there, so the lens adds under 20 %. LENS.md's own advice covers this case (2.1: `at()` "for computed keys and in hot code"; `at()` costs −34 to +29 ns over the direct read with keys spread). But claim 1 is one of the three that decide LENS.md's fallback (section 7, question 10), and by its letter it misses. LENS.md 3 says a step "costs an allocation per step"; at 1e6 rows with keys spread, that allocation costs more than its bar.
2. **Nested selections need a rule LENS.md does not have** (claim 7; measured, and code). LENS.md says equal lenses share one selection. It says nothing of a partition held inside a held whole resource. The prototype needed "coverage": the partition sends no SUB of its own while the whole is held, and SUBs again, from the whole's server position, when the whole ends (code proto/lens.mjs:190-223). With the rule planted out, 536 sinks ended unequal in 300 seeds. Over the network it also needed two resume rules: the cursor is the server's position, never the client's own commit number, and a client drops a frame it already applied when one partition reaches it through two selections around a hand-over (code proto/net.mjs:166-168, 194-198). The first pass, without them, had 75 frames applied twice and 49 unequal sinks in 1,000 seeds. That is about +2 rules on LENS.md's count (reasoned).
3. **The net's two rules are not enough: a third is needed** (claim 14; measured). "GC timing never changes a result" held in every seed (1 distinct result per program) only while each link's function changed nothing but its own target. When half the dropped links' functions also wrote a shared counter, the same program gave 432.7 distinct results per 1,000 collector seeds. Rule 1 (check the target before each delivery) cannot help: a dropped target is alive until it is collected, so its function keeps running for a time the collector picks. So: **a `connect` function may change only its target**; anything else belongs in `tap` (ended by `close()` or a scope). The capture trap (claim 15) is the same rule seen from the other side.
4. **Moving `here()` keeps the answer only if the order travels with the rows** (claim 17; measured). Where an ordering operator (`za`, `top`, `reverse`, `limit`, …) stands last left of `here()`, its answer is an order, and a client that keeps the rows in a keyed copy loses it: 239 of 1,000 runs gave a different answer. Keeping data's order channel (`wireSink`'s `at` and `move` records) beside the copy: 0 of 1,000. LENS.md 2.3's reason ("the same data code runs on both sides") is not enough; the wire must also carry the order, and the client must keep it. Also, `limit` and `reverse` follow arrival order (code data:ops/ordered.ts:540-562), so a copy filled in a different order than the source would give a different answer; the sim's copies were always filled in the source's order, so this was not tested (reasoned).
5. **Three of LENS.md's own lines do not compile as written** (claim 5; measured, tsc 6.0.2). P-01's lens line `(await client.data.widgets)?.stock` starts with `(`, so the line before it is called (TS2349); it needs a leading `;`. Section 2.0's `await stock.set(4)` and `stock.set(op.incr(-1, { min: 0 }))` are on a typed client of a resource that has methods (it calls `sell`), and section 2.4 says such a client has no `set` (V4-5): they fail with TS2339, as 2.4 says they should. And 2.4 uses `client` without making it. Also, a function left of `here()` is refused by the types, but the message is "This expression is not callable" (TS2349), which does not say why.
6. **A bundler can still ship the server** (claim 24; measured, esbuild 0.25.12). Node refuses `import { Shop }` at link time, before any module runs, and tsc with `verbatimModuleSyntax` refuses it (TS1484), as LENS.md 1.3 says. But esbuild with `verbatimModuleSyntax` in its tsconfig keeps every import as written, so it ships the server for `import { Shop }` and for `import { shop }`. Without that setting, esbuild ships the server for neither, since it drops imports used only as types. So "the wrong import fails at link time" is true for Node and tsc; a project that bundles without type-checking first gets no error.
7. **Registering a target is cheap only in ordinary jobs** (claim 6; measured). A `WeakRef` and a registry entry cost 0.13-0.33 µs when links are made 1 to 10,000 a job, in a clean process or one holding 100,000 rows ([bench/weakprobe.mjs](bench/weakprobe.mjs)): the bar holds. But in a job that made about 150,000 of them with no `await` (the setup bench), each cost 0.58-0.67 µs, and a second `connect` 0.69-0.74 µs. The language keeps every target a `WeakRef` made or read alive to the end of the job, so one long job pays for all of them (reasoned from the probe). A page that connects thousands of nodes in one render is such a job; LENS.md's 0.20 to 0.30 µs is right for the ordinary case.
8. **A tap that reads nothing is not free** (claim 10; measured; the first form of this item said "but the lens's part is": the review's interleaved rerun does not support that, see "Claim 10, interleaved": the lens's share is 31-103 ns, the harness below had 37-530 ns of noise). A tap that reads nothing adds 149-165 ns a commit over no sink. Of that, 102-124 ns is data delivering a commit to any sink at all (a bare data sink, no lens), and 38-46 ns is the lens's own share, which meets the 50 ns bar. LENS.md 1.6 says the new `tap` "costs what a bare tap costs today: about 0 per change"; in this harness data's bare `tap(() => …)` costs 0.29-0.39 µs a commit over no tap (measured, bench/connect.mjs `tap`), and with a parameter 1.3-1.8 µs more, as LENS.md says. Reading `c.changes` with `prev`, or a row through `c.now`, costs nothing measurable. So the by-reference sink works; the floor under it is data's (D4).
9. **A weak link is not as cheap as a strong sink when the sinks do little** (claim 11; measured). 10,000 weak links cost 2.18-2.21 times 10,000 strong sinks when each sink writes its own target, and 3.7-4.6 times when the sinks do nothing: +28 to +35 ns per link per commit. The target check itself (`WeakRef.deref()`) is 26-35 ns, within its 50 ns bar; it is most of the difference, it is paid per link per commit, and by the language's rules each `deref()` also keeps the target alive to the end of the job. LENS.md 3's "a weak link cost nothing that shows per commit (2.1 to 2.6 µs with or without)" was a measure with few links per commit.
10. **Class B pushdown is far over its bar, and the cost is data's view** (claim 16; measured). A pushed-down `gt().za(10)` view cost the server 2.3-5.2 µs per view per change at 100-1,000-row rooms, 8-12 µs at 10,000 rows and 51-53 µs at 100,000 (one view: 124-201 µs, unexplained), against a bar of 1 µs. The same views run here cost the client about the same (1.6-62 µs), and the view alone in data costs 1.0-12.5 µs. So the cost is data's ordered view with a window, wherever it runs; LENS.md 2.3's "about 1 µs per affected view" (from E-05) does not hold for it. Server memory: 9.9 KB to 12.8 MB a shape. The wire part holds: only the answer crosses. By LENS.md's own rule class B is not built yet, which is LENS.md's pick already (section 7, question 2).
11. **`depth: 2` on today's data is heavy for small partitions** (claim 19; measured). With one data source per partition, a one-row partition costs about 0.9 KB more than PA-17's index entry and the fold 1.3-1.5 times; partitions of 100 rows and more pass every bar. A plain two-level `Map` was the cheapest store at every size, so data's D3 (a real two-level store, not a source per partition) is what makes small partitions cheap.
12. **`asOf` on data's real fold costs more than E-54 measured beside a plain `Map`** (claim 23; measured). +1.5 to +2.0 µs a record (bar 1.0) and, at 1e6 rows, 285 B a version (bar 220; E-54: 219 B). Reads meet every bar. It stays off the write path either way (E-54), so this is a cost of the reader; the number LENS.md 2.9 quotes should say "beside a plain `Map`".
13. **The collector in a browser may never end a link** (claim 13; measured). LENS.md 2.2 says "No browser was tried". In a headless Chromium 153, 0 of 1,000 links whose DOM nodes were removed ended within 30 s, idle, busy or with a commit every 10 ms. So in a page, a removed node's link lives on, and the server keeps sending, unless a scope, `close()` or the count ends it. The net is a net only; the docs and the dev warning must say it plainly.
14. **Two smaller things.** A kept lens's verb still makes one `Proxy` for the verb name (`kept.set` is a step, then a call), which is why a kept write costs up to +0.31 µs over `f.set` (code proto/lens.mjs:517-531). And claim 6's first picture of a room looked like a 0.15 ms fixed cost; it is the first work after a full collection, which the bench forces before each timed picture ([bench/firstprobe.mjs](bench/firstprobe.mjs): 26-28 µs for a 100-row room without the collection, 149-166 µs right after one).

## The review (2026-11-18)

A skeptic reviewed LENS.md, E-54 and this experiment and filed 24 findings (F1 to F24). Each was checked against its source here. Where a finding was about the prototype, the prototype was changed, the seeded runs were run again on the changed code ([results/review-sims.jsonl](results/review-sims.jsonl), under the heavy lock), and the timed parts the changes touch were run again three times ([results/review-timing.jsonl](results/review-timing.jsonl), under the timing lock). The reviewer's own probes are in [review/](review): `probe1.mjs` to `probe4.mjs`, their output on the first build ([review/before.txt](review/before.txt)) and on the changed build ([review/after.txt](review/after.txt)), and the reviewer's one rerun of four timed parts ([review/rerun.jsonl](review/rerun.jsonl)). "The first build" below is the prototype as first measured (the tables above); every finding was confirmed on it.

**What changed in the prototype** ([proto/lens.mjs](proto/lens.mjs), [proto/net.mjs](proto/net.mjs)):

| Finding | The first build | Now | Checked by |
|---|---|---|---|
| F1 a read depended on the collector | `await lens` read locally whenever any selection held the rows, even rows only a dropped `connect` kept: 0 GETs without a forced collection, 1 GET and an UNSUB with one (`probe2`) | a read is served here only from rows **held on purpose**: a server, `hold: 'all'`, a live `here()` or `tap` on the partition or on the whole resource (`Sel.strong`, `Resource.purposeSel`). A read on a selection whose first picture is still on the way waits for it. A GET carries the highest server position the client has seen, and the answer carries the server's (one server here, so it only counts answers that are behind: 0) | claim 14 now records, per step and per partition, whether a read is served here or takes a trip: **1 pattern and 1 result per program over 1,000 collector seeds** (556,000 reads here, 1,604,000 trips). The first build's rule, planted (`E55_MUTATE=weakread`): 9.7 patterns per program |
| F3 a lens was a promise | `then` was a function on every lens: an `async` function that returned a lens made a GET; one that returned the root lens got all 100,000 rows, 6.8 MB as JSON (`probe3`); `subscribe`, `$$typeof`, `asymmetricMatch` were functions; `JSON.stringify({ a: lens })` threw | a read is the verb `lens.get()`; `then`, `toJSON`, `constructor`, `$$typeof`, `asymmetricMatch`, `nodeType`, `subscribe` read as `undefined` | claim 4: 47 of 47 cases, with five ways to resolve a lens (0 trips each) and the probe names |
| F4 views right of `here()` leaked | a view's tap ran after `close()`, and the resource kept the view (`probe1`); `lens.gt(…).connect(target, fn)` closed over its target, so it was never collected; a local view had no `connect` | a view belongs to the handle it was made from: the handle's end (close, scope) ends every sink on the view and releases it; a local view has `connect`; `Selection.connect` makes a weak link that owns its handle | new claim 26: 1,000 seeds, 59,958 view sinks ended by `close()`, a scope, the seeded collector or `link.close()`, with a linger: **0 calls after the end, 0 views left, 0 selections left**. The first build, planted (`viewleak`): 22,539 calls after the end in 300 seeds |
| F8 a method ran on any path | every method was on every lens at every depth; `widgets.left.sell(1)` turned the field `left: 5` into `{ left: {…} }` (`probe1`) | a method declares where it may be called: a bare function at the root only; `{ at: 'row' \| 'partition' \| 'any', run }` on a path. The server refuses any other path, `bad-path`; the typed sketch offers a method only on lenses of its kind | claim 4 (4 cases); claim 18: 202 of 202 calls on a wrong path refused, 0 commits; claim 5: a row method below its row and at the root do not compile |
| F19 the target's close was duck-typed | `.once('close', …)` was called on anything with a `once` method | only a Node `EventEmitter`, a `WebSocket` or a `MessagePort`, or an event the caller names (`{ closes: 'end' }`) | by reading; no separate run |
| F23 `at()` with a number key | `f.data[1].n` gave 7, `f.at(1, 'n')` gave `undefined` (`probe4`) | `at()` turns a finite number into its string and refuses other key types, `bad-key` | claim 4 (4 cases) |

**What changed in the benches:**

| Finding | The first form | Now | Result |
|---|---|---|---|
| F2 claim 21 could not fail on the rule the pattern depends on | queues with no limit; a loss dropped the whole rest of a queue; a bare mark to every slot every 5 records | [bench/marks.mjs](bench/marks.mjs)'s second form: a cap on waiting writes; a `backpressure` refusal on the client (never sent, no number); the source in bursts; a crash loses a tail, a slot move loses a head and delivers the rest; no bare marks; the leader's order rule per (writer, slot) | see "Claim 21, second form" below |
| F5 claim 10's noise was larger than its bar | each way in its own resource, one after another, the lower of two copies; two copies of the same way differed by 37 to 530 ns | [bench/connect.mjs](bench/connect.mjs) `tap2`: every way's resource made up front, the ways interleaved round by round with their order rotated, differences taken inside a round, the median of 9 rounds | see "Claim 10, interleaved" below |
| F15 no freeze was measured | sinks got rows by reference, not frozen | `tap2` has a way that freezes each row a sink is handed, deeply | 163 to 220 ns per changed row |
| F10 two kept-bytes methods | claim 23's "123 B, 418 B" were fat minus base, and base's kept bytes are negative | one method, E-54's: heap after minus heap before | **103 B a version at 1e5 rows, 285 B at 1e6** (the raw lines never changed) |
| F13 uneven verdicts | claim 1 judged by its worst cell, claim 8 by 2 runs of 3, claim 3 passed with one run over | one rule: the median of every run against the bar, with the lowest and highest run | see "One verdict rule" below |
| F24 files pointed into a scratch folder | `run.sh` and `imports/matrix.sh` had a scratch path as a default | `SP` is required from the environment; `ESBUILD` and `OUT` come from it | by `grep` |
| F18 LENS.md's first evidence lived only in a scratch folder | the facts brief, the three proposals and their benches | copied into [brief/](brief) (`brief.md`, `lens-first.md`, `cost-first.md`, `space.md`, and their bench folders with raw lines), with the scratch paths replaced by `$SP`, `$TREE` or relative paths | by `grep` |

**Findings that changed only words** (here and in LENS.md): F6 (claim 16's bar measured the wrong thing: the view costs the same on either side; the bar is restated as what is moved against what is saved), F7 (the door limits which views a client may ask for, not how many: a cap is needed; not built, class C is not in the prototype), F9 (the rule count), F11 (E-54's hash-tree store cost, measured there), F12 (LENS.md did not yet carry these results), F14 (a warm near cache: not built here), F16 (the import matrix's bundler cell), F17 (`asOf`: a step is one commit; the cost to open), F20 (the exactly-once headline), F21 (generous verdicts: recounted below), F22 (smaller number errors; the "26-28 µs at 1e4 and 1e6 rows" above mixed two benches and is corrected in the claim 6 row).

**No finding was wrong.** Two were applied with a different number than the finding gave: F9's own total (+9 to +14 rules) left out two rows the review itself asked to be counted (F14, F19), so LENS.md says +12 to +18; and F11's "+1.3 to +2.1 µs" became +1.1 to +2.2 µs with a third run.

### Claim 14 on the changed build

[bench/sim.mjs](bench/sim.mjs) `collector`, 3 programs × 1,000 collector seeds, the same adversary as before. The result now includes, at every step and for every partition, whether `cl.data[p].get()` would be served here or take a trip, and the rows it would read when served here.

| Build | Results per program | Here-or-trip patterns per program | Reads served here / by a trip | Client SUB counts per program |
|---|---|---|---|---|
| the changed build: reads only from rows held on purpose | **1** | **1** | 556,000 / 1,604,000 | 3 |
| the first build's rule, planted (`weakread`) | 9.7 | 9.7 | 1,003,642 / 1,156,358 | 3 |
| control 2, half the dropped links write a shared counter (changed build) | 432.7 | 1 | 435,000 / 1,725,000 | 3 |

The count of SUBs a client sent still depends on the collector (3 different counts per program): a dead link's subscription lives until the net finds it. That is a cost LENS.md already names, not a result a program reads.

### Claim 21, second form

[bench/marks.mjs](bench/marks.mjs) `sim`. Outputs are 8 users over 4 slots; an output is "lost" if it ends below f(source), "doubled" if above. After the faults the deriver is restarted from the marks and run with no faults, up to 10 times, until a pass loses nothing; then every output is compared.

| Variant | cap 8, 60 records, 1,000 seeds: seeds with a wrong output / lost / doubled | cap 512, 4,000 records, 100 seeds |
|---|---|---|
| **as written**: a `backpressure` refusal is ignored and the loop goes on | **998** / 7,262 / 0 | **100** / 800 / 0 |
| **block**: a marked write refused on the client blocks later marked writes to that slot until the loop restarts | **0** / 0 / 0 | **0** / 0 / 0 |
| **pace**: the reader stops yielding while the target has `cap` waiting writes | **0** / 0 / 0 | **0** / 0 / 0 |
| pace, the leader's order rule off | 756 / 1,497 / 0 | 100 / 800 / 0 |
| pace, a slot move drops its marks (the first form's control) | 1,000 / 0 / 7,856 | 100 / 0 / 800 |

- **The four lines as written are not exactly once under load.** A write refused `backpressure` is never sent; a later write to the same slot commits and moves the mark past the dropped record; a restart then skips it at the mark. Lost for good (56,317 such refusals in the cap-8 run).
- **Either fix closes it**, and both rest on the leader's order rule: with that rule off, a write lost in a slot move followed by a later one delivered (1,759 such moves in the paced cap-8 run) loses outputs.
- **Limits.** Still a stand-in: no Raft, no lost log tails, no dedup horizon. "The loop is started again" is the sim's supervisor, not app code. Without bare marks a restart begins at the lowest mark over the slots, which an idle slot holds back; that costs re-reads, not correctness.

### Claim 10, interleaved

[bench/connect.mjs](bench/connect.mjs) `tap2`: 10,000 rows, 200,000 field writes a round, one sink on the whole resource, 11 ways interleaved over 9 rounds, 3 runs. Each number is a difference taken inside one round; a cell is the median of the 9 rounds, as the range over the 3 runs; the last column is the lowest and highest single round of any run.

| difference, inside one round | runs: median | each run | rounds: lowest to highest |
|---|---|---|---|
| the noise: "no sink" B − "no sink" A | -7.6 to 2.2 | -1, 2.2, -7.6 | -281 to 420 |
| a bare data sink (no lens) over no sink | 63 to 122 | 122, 67.9, 63 | -160 to 525 |
| a tap that reads nothing, over no sink | 92.4 to 198 | 198, 92.4, 112 | -136 to 875 |
| the lens's own share: that tap over a bare data sink | 31 to 103 | 103, 55.1, 31 | -460 to 799 |
| reading `c.changes` and each `prev`, over reading nothing | -39.2 to 31.7 | -39.2, 11.3, 31.7 | -767 to 418 |
| freezing each row handed out, over reading the changes | 163 to 220 | 163, 220, 211 | -162 to 736 |
| reading a row through `c.now`, over reading nothing | -33.3 to 91.3 | -33.3, -10.3, 91.3 | -704 to 363 |
| building `c.recs()`, over reading nothing | 166 to 216 | 216, 210, 166 | -552 to 445 |
| data today: `tap(() => …)` over no tap | 126 to 168 | 126, 167, 168 | -318 to 820 |
| data today: `tap((rec) => …)` over `tap(() => …)` | 1525 to 1788 | 1788, 1662, 1525 | 937 to 2461 |

- **The harness's own noise** is the first row: two copies of the same way. Per round they differ by up to a few hundred ns; the median of 9 rounds is within 8 ns of zero.
- **A tap that reads nothing costs 92 to 198 ns a commit**; data's own delivery to any sink is 63 to 122 ns of it and the lens's share 31 to 103 ns (bar 50). The first harness's "38-46 ns" for the lens's share was inside its noise. So the lens's own share does not clearly meet 50 ns; the claim stays "miss as a whole", and the split between data and the lens is not resolved to better than about 50 ns.
- **Reading `c.changes` with `prev`, or a row through `c.now`, costs −39 to +32 and −33 to +91 ns**: nothing this harness can see (bar 300).
- **Freezing each row handed out costs 163 to 220 ns** per changed row (E-05's small row: 7 fields and a 2-item array; the array is shared between versions, so it is frozen once).

### One verdict rule

The median of every run against the bar: the three first runs, the reviewer's one rerun where there is one, and the review pass's three runs on the changed build.

| what | bar | runs | median | lowest to highest | every run | the median |
|---|---|---|---|---|---|---|
| claim 1: a step, keys spread, 1000 rows (ns) | 150 | 6 | 60.2 | 54.2 to 66.8 | 66.8, 60.7, 66.2, 54.2, 59.7, 58.6 | meets |
| claim 1: a step, keys spread, 100000 rows (ns) | 150 | 6 | 116 | 95 to 236 | 236, 132, 118, 112, 95, 113 | meets |
| claim 1: a step, keys spread, 1000000 rows (ns) | 150 | 7 | 205 | 162 to 222 | 188, 205, 210, 162, 222, 205, 178 | misses |
| claim 1: a step, one key, 1000 rows (ns) | 150 | 6 | 53.9 | 49.2 to 56.1 | 54.9, 56.1, 54.7, 49.2, 51.6, 53 | meets |
| claim 1: a step, one key, 100000 rows (ns) | 150 | 6 | 65 | 51.4 to 83.3 | 75.6, 69.4, 83.3, 51.4, 54.2, 60.5 | meets |
| claim 1: a step, one key, 1000000 rows (ns) | 150 | 7 | 73.2 | 66 to 99.2 | 99.2, 81.6, 78.3, 72.9, 73.2, 66, 68.5 | meets |
| claim 1: a kept verb over direct, 1000 rows (ns) | 200 | 6 | 8.2 | 0.1 to 11.5 | 0.1, 10.1, 8.4, 11.5, 6.8, 8 | meets |
| claim 1: a kept verb over direct, 100000 rows (ns) | 200 | 6 | 8 | -4 to 13 | 7.1, -3.2, -4, 8.9, 13, 10.7 | meets |
| claim 1: a kept verb over direct, 1000000 rows (ns) | 200 | 7 | -7 | -63 to 23.6 | -5.8, -2.3, 23.6, -11.5, -7, -63, -14 | meets |
| claim 1: at() over direct, keys spread, 1000 rows (ns) | 100 | 6 | 9.8 | 3.6 to 15.1 | 4.6, 7.2, 12.3, 3.6, 15.1, 13.9 | meets |
| claim 1: at() over direct, keys spread, 100000 rows (ns) | 100 | 6 | -19.5 | -61 to 32.8 | -29.5, -9.5, -33.8, -61, 16.9, 32.8 | meets |
| claim 1: at() over direct, keys spread, 1000000 rows (ns) | 100 | 7 | -47.9 | -78.6 to 1.9 | 1.9, -2.6, -16, -53.1, -66, -47.9, -78.6 | meets |
| claim 1: at() over direct, one key, 1000 rows (ns) | 100 | 6 | 8.6 | 3.4 to 14.2 | 3.4, 5.4, 10.9, 8, 14.2, 9.1 | meets |
| claim 1: at() over direct, one key, 100000 rows (ns) | 100 | 6 | 24.4 | 11.5 to 33.5 | 29.5, 24.8, 11.5, 24, 23.8, 33.5 | meets |
| claim 1: at() over direct, one key, 1000000 rows (ns) | 100 | 7 | 81.9 | 54.1 to 154 | 69.6, 154, 60.7, 81.9, 106, 54.1, 106 | meets |
| claim 3: steps over direct, 10000 rows (ns) | 1000 | 6 | 311 | 176 to 403 | 403, 176, 308, 362, 310, 312 | meets |
| claim 3: steps over direct, 100000 rows (ns) | 1000 | 7 | 474 | 309 to 734 | 309, 474, 585, 734, 544, 402, 337 | meets |
| claim 3: steps over direct, 1000000 rows (ns) | 1000 | 6 | 340 | 225 to 499 | 420, 225, 252, 320, 359, 499 | meets |
| claim 3: kept over direct, 10000 rows (ns) | 300 | 6 | 163 | -18.5 to 227 | 227, -18.5, 144, 131, 183, 199 | meets |
| claim 3: kept over direct, 100000 rows (ns) | 300 | 7 | 165 | 40.3 to 306 | 40.3, 259, 207, 165, 306, 152, 144 | meets |
| claim 3: kept over direct, 1000000 rows (ns) | 300 | 6 | 276 | -25.7 to 424 | 240, -25.7, 313, 424, 179, 333 | meets |
| claim 8: K = 10,000 over K = 0 (ratio), every run | 1.3 | 15 | 1.25 | 1.09 to 1.52 | 1.20, 1.25, 1.36, 1.26, 1.14, 1.09, 1.12, 1.18, 1.52, 1.34, 1.41, 1.21, 1.36, 1.40, 1.24 | meets |
| claim 8: the first build only | 1.3 | 8 | 1.19 | 1.09 to 1.36 | 1.20, 1.25, 1.36, 1.26, 1.14, 1.09, 1.12, 1.18 | meets |
| claim 8: the changed build only | 1.3 | 7 | 1.36 | 1.21 to 1.52 | 1.52, 1.34, 1.41, 1.21, 1.36, 1.40, 1.24 | misses |

- **Claim 1's one miss stays a miss**: keys spread over 1e6 rows. The same cell's runs span about 60 ns, and the reviewer saw a one-step lens read (1,194 ns) beat the direct read (1,277 ns) there, so the cell's noise is about 100 ns on a read of 1.1 to 1.3 µs.
- **Claim 8 is at the edge**: the median of all 15 runs is 1.25 and meets 1.3. The first build alone: 1.19 (8 runs; K = 10,000 costs 1.57 to 1.86 µs a write against 1.24 to 1.54 µs at K = 0). The changed build alone: 1.36 (7 runs; 1.63 to 2.50 µs against 1.23 to 1.65), which misses. Eight of the runs are an A/B that alternated the two builds in one hold ([results/review-fan-ab.jsonl](results/review-fan-ab.jsonl)): first 1.09 to 1.18, changed 1.21 to 1.40. The changed build's K = 0 is 0.11 µs faster and its K = 10,000 is 0.07 µs slower (medians). The review's changes touch neither path (a `Link` and a `Sel` each gained two fields); the cause was not found. So claim 8 is counted "in part", and the keyed index needs a pin when data builds it (D1).
- **Claim 3 passes on every median**; single runs of the kept lens went over 300 ns once at 1e5 rows (306) and three times of six at 1e6 rows (313, 333, 424; median 276).

### The recount (F21)

| | First form | After the review |
|---|---|---|
| pass | 13 (2, 3, 4, 5, 7, 8, 9, 12, 14, 17, 18, 20, 21) | **10** (2, 3, 4, 7, 9, 12, 14, 17, 20, and the new 26) |
| pass in part, at the edge of its bar, or a stand-in | 6 (1, 6, 10, 19, 23, 24) | **10** (1, 5, 6, 8, 10, 18, 19, 21, 23, 24) |
| miss | 2 (11, 16) | **1** (11) |
| a record, no bar | 2 (13, 15) | **3** (13, 15, 16: its bar is restated with no pass or fail) |
| not run | 2 (22, 25) | **3** (22, 25, and the new 27: a served view, class C) |

Claim 5 moves to "in part": its bar was that the 22 lines compile as written, and they needed four edits. Claim 18 is a stand-in: one trip and one commit are true by construction. Claim 21 is a stand-in, and its first form did not test the rule the pattern rests on. Claim 14 passes only on the changed build. Claim 8 meets its bar on the median of all runs but not on the changed build's own, so it is counted "in part".

## What the prototype leaves out

- **Class C: a served view.** `f.methods.x(arg).here()`, LENS.md's replacement for `.open()`, is not built: no SUB with `{ method, arg }`, no server view shared by equal calls, no cap on live served views (claim 27). Claim 16's pushed-down view is one partition's, built for that bench only.
- **What the lifetime claims covered.** In the first form, claims 7, 9 and 14 tested links on the whole resource, partitions, rows and fields only. Views right of `here()`, and `connect` after operators left of `here()`, were not tested, and they leaked (review F4). Claim 26 now covers them. `asOf`, `changes()` and the near cache have no lifetime test, because they are not built as lens verbs.
- **"Never reads backwards".** A GET carries the highest position the client has seen, but there is one server, which cannot be behind its own client. Copies that lag, and the wait for a client's own early-answered writes (rule Y), are not here.
- **The cap on waiting writes in a real client.** Claim 21's second form models the cap, the refusal and the pacing in a seeded sim. The prototype's transports have no cap and no pacing.
- **A freeze in the lens.** Rows handed to sinks are not frozen by the prototype; claim 10's interleaved bench measures a freeze done inside the sink.
- **The typed `at:`.** The sketch offers a method only on lenses of its declared kind; it does not type a key shape.

- **fero's kernel.** No log, no ASK, no stages, no sessions, no disk, no Raft, no slots. A "server" is data's engine in a worker thread; a "commit" is one data commit. Claim 21's group commit is a 4 ms timer standing in for a disk sync. The costs here are the lens's and data's own share, never a whole fero write (v4's issue path is 7.7-8.3 µs, PATHS 2.6).
- **The near cache** (`hold: '200MB'`), `once` names, TTLs, conditions other than claim 21's refusal, ops other than a decrement, `changes()` as a log reader, schema types. `asOf` exists only as claim 23's reader, not as a lens verb.
- **Pushdown is built only for claim 16**, over data's existing views. Every other claim uses the first build's shape: the partition crosses, operators run here.
- **Claim 22 (the view selector in E-31's model) and claim 25 (the 22 patterns on E-22's prototype) were not run.** The first needs E-31's Python model ([../E31-subscribe/models/subscribe.py](../E31-subscribe/models/subscribe.py)) extended with a view selector and its resume rule; the second needs E-22's 7,100-line prototype ported to the lens spelling. Both are separate experiments. What this one has instead: claim 5 compiles the 22 lines; claims 7 and 16 run partition and view selectors over a real port with resume, but without failover or slot moves.
- **Claim 18 is a stand-in.** The leader table and the forwarding are written here, so "one trip, one commit" is true by construction once the client's table is right. What it checks is the redirect path and the share of extra trips with no path.
- **Claim 21 is not E-30's model.** It is a seeded simulation with crashes, lost in-flight writes, two derivers under one name, a refused write and slot moves, on lens.mjs's server Resource as the output's leader. It has no Raft, no lost log tails, no long restart past a dedup horizon. E-30 model-checked those for the same mark rule (`srchi-slot`).
- **Claim 10 ran on this folder's harness**, a copy of the brief's `tap-cost.mjs` loop, not on data's own perf suite.
- **Claim 13's Node cells depend on how the targets were aged**: here the aging allocation started a major collection, so the old targets went within 0.4 s; cost-first's harness did not, and saw 8 s to never. The browser cells have no such step.
- **The seeded runs ran once** each (a seed gives the same line every time); the timed runs three times. The sims' worlds are small (10-30 rows, 4-6 partitions), so they search orderings, not sizes.
- **One shape of row** (E-05's small row, about 100 B), writes spread evenly, one hot row in claim 23.
- **The browser**: one browser (Chromium 153, headless). [browser/links.js](browser/links.js) is a copy of the link mechanism without data, so the page needs no bundle. Firefox and Safari were not tried.
- **Rust.** Nothing here was built in Rust. LENS.md plans none (4.5), and nothing measured here asks for it.

## How to rerun

```sh
./run.sh types     # claims 5 and 24: tsc 6.0.2 on API.md's own declarations; the import matrix (Node 22 and 26, tsc, esbuild)
./run.sh sims      # the seeded runs (4, 7, 9, 14, 17, 18, 21), then the planted bugs, under the heavy lock
./run.sh mutants   # only the planted bugs
./run.sh timing    # the timed claims, RUNS times each, under the timing lock (about 15 minutes a run on this box)
./run.sh gc        # claim 13 (Node, 30 s a cell, and a headless Chromium; about 15 minutes for 3 runs) and claim 15
./run.sh review-sims    # the review pass: every seeded run on the changed build, the new checks and all planted bugs
./run.sh review-timing  # the review pass: claim 10 interleaved, claims 1, 3, 8 and 20, RUNS times each
./run.sh summary   # the tables (node summarize.mjs); this pass's are in results/summary.md
```

Env: `SP` (required: a scratch folder of your own that holds the lock helpers `bin/timing` and `bin/heavy` and `dl/esbuild`; nothing in this folder points at one), `NODE` (default `node` on PATH), `RUNS` (default `1 2 3`), `DATA` (data's folder; default `../data`, next to this repo, at 63fea66), `E55_HERE` (this folder, when the script runs from a copy). Prerequisites: esbuild 0.25.12 at `$SP/dl/esbuild` (E-40's fetch.sh), Playwright 1.63.0 at `/opt/node-tools` with Chromium at `/opt/pw-browsers` (installed on the study box). Raw lines are in [results/](results). `sims-first-pass.jsonl` and `mutants-first-pass.jsonl` are the first pass, kept for the bug it found (claim 7 [net]). `sims.jsonl`, `mutants.jsonl` and the timed files are the first build. `review-sims.jsonl`, `review-timing.jsonl` and `review-fan-ab.jsonl` are the review pass, on the changed build; `types.jsonl` is the review pass's type check and `types-first-pass.jsonl` the first one; `imports.jsonl` holds both passes of the import matrix (the same cells, the same outcomes). The reviewer's probes are in [review/](review). The facts brief, the three proposals LENS.md was written from, and their benches and raw lines are in [brief/](brief) ([brief/README.md](brief/README.md)).

## Verdict

**The lens works, and on the changed build it is correct for everything the checks cover; the review found four holes in the first build that the first checks could not see, and two of the three gating speed claims are borderline.** The picture-then-changes, sharing and commuting claims held under seeded runs and planted bugs, over a real port and across reconnects, once the prototype had two rules LENS.md lacked (nested selections and the resume cursor). The review then showed that a read depended on the collector, that a lens was a promise, that views right of `here()` leaked, and that a method ran on any path; each is fixed, and each now has a check with a planted bug or a refused case. The four-line derive is exactly once only when it is paced. Claim 14 passes on the changed build. Claim 1 misses only with keys spread over 1e6 rows, where a `Proxy` step costs about 100 ns more than a plain object and `at()` is LENS.md's own advice. Claim 8 meets 1.3 on the median of 15 runs (1.25) but not on the changed build's own (1.36). A step keeps nothing; a lens write adds 0.2 to 0.7 µs; equal lenses share one subscription. Where bars were missed (a bare tap, small depth-2 partitions, `asOf`'s fold), most of the cost is data's delivery to a sink, a data source per partition, or the collector: D4, D3. A pushed-down view costs what the view costs on either side, so its first bar was the wrong one. The collector is a net only: a headless Chromium collected none of 1,000 removed DOM nodes in 30 s. Not built: a served view (class C). Not run: claims 22, 25 and 27.

Q-55: built small on data 63fea66 (a `Proxy` lens, `here`/`connect`/`tap` over selections shared through a keyed index, a worker server and `MessagePort` clients with resume, methods on a path, about 1,000 lines), then changed for a 24-finding review and run again: of 27 claims 10 pass, 10 pass in part, sit at the edge or are stand-ins, 1 misses, 3 are records, 3 were not run. Correctness on the changed build: claim 7, 0 wrong in 1,000 seeds in one process and 1,000 across 4,337 disconnects (after the first pass found 75 frames applied twice, from a resume cursor taken from the client's own commit number); 9, one SUB, one decode, one `c.text()` per commit for 2,000 links; 14, 1 result and 1 here-or-trip pattern per program over 1,000 collector seeds, once a read is served here only from rows held on purpose (the first build: 9.7 patterns; the same program made 0 GETs or 1 by when a collection ran); 17, 0 of 1,000 with the order channel kept, 239 without; 18 (a stand-in), one trip, one redirect after a move, 0.66 and 0.80 extra trips with no path, and 202 of 202 calls on an undeclared path refused; 21 (a stand-in), the four lines as written lose outputs in 998 of 1,000 seeds once a cap and a `backpressure` refusal exist, and 0 when paced or blocked, at cap 8 and at cap 512, with un-awaited writes 510-558× faster; 26, 59,958 view sinks, 0 calls after the end; 4, 47 of 47 cases with a lens that is not a promise (`lens.get()`; on the first build an `async` helper returning the root lens downloaded 100,000 rows), seven probe names that read as `undefined`, `at()` that turns number keys into strings, and methods that declare `at:`. Speed: a step costs 49-99 ns with one key but 162-222 ns (median 205) with keys spread over 1e6 rows (bar 150; a plain object 71-106 ns), keeps 0-0.3 B a key (data today 1,333 B), and a lens write adds 0.18-0.73 µs (kept −0.03 to +0.42); K = 10,000 path lenses cost 1.09-1.52× none over 15 runs, median 1.25, the changed build alone 1.36 (bar 1.3; data today about 120×); interleaved, a tap that reads nothing costs 92-198 ns a commit, 63-122 of it data's delivery and 31-103 the lens's (bar 50, not resolved), and freezing each row handed out adds 163-220 ns; a weak link costs 2.2× a strong sink with a 26-35 ns check; registration costs 0.13-0.33 µs in ordinary jobs and 0.58-0.67 µs in one 150,000-link job; a pushed `gt().za(10)` view costs 2.3-53 µs per view per change on the server and 1.6-62 µs on the client, and saves a 6 KB to 6.6 MB first picture for a 677-765 B one, so claim 16's 1 µs bar measured the wrong thing; depth 2 passes for partitions of 100+ rows and misses for one-row ones (1.3-1.5×, +0.9 KB); `asOf` reads pass (step 10-12 ns, row 0.6-1.4 µs, 150,473-version row 0.14-0.21 µs) but its fold adds 1.5-2.0 µs a record and keeps 103 B a version at 1e5 rows and 285 B at 1e6 (bar 220); Node collected dropped targets in 7 ms to 1.4 s and Chromium none of 1,000 DOM nodes in 30 s; the 22 lines needed four edits at first (P-01 needed a leading `;`) and compile as LENS.md now writes them, 11 must-fail lines fail, typed assignment stays impossible on a mapped type, and esbuild with `verbatimModuleSyntax` ships the server for `import { Shop }`. Moves: no candidate up or down; LENS.md's fallback is the owner's call, with claims 1 and 8 both borderline and claim 8 not deciding between the lens and `at()`; LENS.md gains E-55's three first-build rules (nested selections, the server-position resume cursor with a drop of frames already applied, a `connect` function may change only its target) and one later (class B carries the order channel), and the review's five to eight (reads only from rows held on purpose, pacing for marked writes, a cap on served views, a method's declared path, a warm cache that is not subscribed, `at()` key coercion, named closable kinds): +12 to +18 on 416 in all (reasoned); its five user rules become seven; data's D3 and D4 rise in priority beside D1 and D2, and a view cost item joins D8; claims 22, 25 and 27 stay owed as separate work, and E-30's model with marks from app code.
