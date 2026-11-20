# Transformations: how they work in v5

Written 2026-11-20. Docs only; nothing here is built for real. On 2026-11-20 the owner asked for a validated plan for how transformations can work in v5, since they brought much complexity into earlier versions, and asked whether data needs a new version for it (an earlier answer said data need not be rewritten in Rust).

**How it was made.** First, a history of what made transformations hard in fero v2, v3, v4 and in data: 70 sources of complexity and bugs, each with its evidence, and 12 problems new in v5. Then a plan. Then a critic attacked the plan before anything was built: it timed a leaderboard on data's real engine, probed data's edges, found 31 problems and added 27 claims to test. Then two builders built the plan small on data's real engine, in [E-57](experiments/E57-transforms/README.md): group A built served views and pushdown, group B built everything across partitions, resources and time. Each claim had a seeded oracle and a planted bug. This page is the plan **as the validation left it**: where a claim missed or the critic was right, the plan changed, and each change says so. Then a skeptic checked this page against its sources and found 30 problems, four of them blocking; each is taken in, and where a fix needed a run, the run is in E-57 and marked "after the skeptic". The history, the plan and the critique are working files, not kept in the repo; this page carries what they found, and the probes it cites are kept in [E-57's probes](experiments/E57-transforms/probes/README.md). It reads [LENS.md](LENS.md) (2.3, 4.4, 4.5, 6), [READS.md](READS.md), [API.md](API.md) (3.3, 3.8 to 3.12), [LAYERS.md](LAYERS.md), [SIMPLICITY.md](SIMPLICITY.md), [VERDICT.md](VERDICT.md) and the experiments E-03, E-04, E-05, E-23, E-24, E-30, E-31, E-43, E-54, E-55 and E-57. data was read at commit `63fea66` and never changed.

**Words.** A **row** is one entry of a resource. A **partition** is the rows one leader keeps in one order: with `depth: 1` each row is its own partition; with `depth: 2` the first key is the partition. A **slot** is one of a resource's fixed hash buckets; a **group** is one Raft log that owns some slots (the first build has one group per resource). A **copy** is a server that holds a full replica of a group: a **voter** (one of them is the **leader**) or a **standby**, which holds a copy but does not vote. **To fold** is to apply committed records to rows; a **store** is the data source that holds a resource's rows in one process. A **view** is a live answer that data keeps up to date from rows, change by change. The **live verb** is the call that keeps a selection live in this process: API.md spells it `here()`, READS.md `live()` and `on(fn)`, and [CONNECT.md](CONNECT.md) `connect()`. This page's code uses READS.md's spelling. **Left of the live verb** stands only plain data, which may run on a server; **right of it** is your code, here. **Plain data** means operator arguments that are values (numbers, strings, field names), never functions. **Class A, B, C** (LENS 2.3): A, a partition crosses whole and your chain runs here; B, a plain chain runs on a copy inside one partition (later); C, a view over every row that the server named in `methods:`. A **served view** is a view a copy keeps for clients (class C). An **entry** is the copy's record of one served view. A **picture** is a view's whole value, sent when a link starts or cannot resume; a **frame** is one commit's changes to it; a **ring** is the last frames an entry keeps for resumes; an **instance** names one life of an entry. **Seen** is the highest position a client has seen. The **linger** is a short wait before something unused is dropped. A **cut** is one position per slot. The **merge contract** is a set of rules in data that make a view a function of its rows only, not of the order they came in ([E-23](experiments/E23-merged-views/README.md)). The **order channel** is data's record of where each row sits in an ordered view. A **mark** is the source position a derived write carries, so a restart applies each source record once. A **deriver** is the process that keeps a target resource equal to a view of a source. A **lock token** goes up each time a new deriver takes the lock; a **fence** makes a group refuse a write whose token is older than one it has seen; a **bump** is a fenced no-op write that raises the fence; a **read barrier** is a source position a new deriver folds up to before it writes. A **rule** is one thing a builder of fero must get right; the base design has 416 ([SIMPLICITY](SIMPLICITY.md)). A **user rule** is one thing a user must know. An **oracle** is the same query run from scratch on the true rows, by code that does not use data; a **planted bug** breaks one rule on purpose, to show the oracle can fail.

**Marks.** *(measured, source)*: a timed number, three runs, each process alone on the box under the timing lock, given as the range over the runs. *(checked, source)*: a seeded run, a model or tsc ran it, and its line is in that source's results. *(reasoned)*: an argument; nothing ran it. *(a guess)*: nobody measured it. *(from memory)*: an outside fact not checked here. **Status words**: **decided** (a V5-n decision), **picked here** (this page's choice, for the owner to approve), **owed** (named in the records, not done), **later** (designed, not in the first build), **not covered** (left out on purpose, section 10).

---

## 0. What to review

The plan on one screen. Each line is one place a transformation runs.

```ts
// file: screen.ts — where a transformation runs, on one screen
import { derive } from 'fero'
import { chat, fans, orders, products } from './clients.js'; import { fans as fansOnServer, orders as ordersOnServer, totals } from './server.js'
chat.data.room1.live().filter((m) => !m.hidden).za('at', 50).on(draw)    // HERE: your code, right of the live verb
chat.data.room1.gt('stars', 0).za('stars', 10).on(draw)                  // LEFT of it: plain data; later a copy may run it
fans.data.best(10).on((rows, c) => draw(rows, c.order))                 // SERVED: a view the server named; bounded, capped
const p2 = await fans.data.ranked(null).page([42, 'u7'])                // PAGES: one shared index on one copy, kept on every write
fansOnServer.data.za('points', 10).on(draw)                             // ACROSS PARTITIONS: on a copy, one store holds every slot
await derive(ordersOnServer.data.by('user').sum('cents'), totals)       // DERIVE: a resource kept equal to a view
orders.data.ada.live().lookup(products.data, 'sku').on(draw)            // JOIN: each order with its product, both live
for await (const e of orders.data.changes({ from: cur })) send(e)       // THE LOG: every record, in your own loop
const was = await orders.data.ada.past(v); was.za('at', 5).on(draw)     // THE PAST: a reader here; a step is one commit
```

1. **Where a transform runs is set by one line, the live verb, plus named exits.** Right of it: any code, here, on rows this process holds on purpose. Left of it: plain data whose answer depends on the rows only; a copy may run it inside one partition (class B, later). Over every row, from a client: only a view the server named, bounded, capped, blind to who called, kept on **one** copy chosen by a hash and never on a leader; or `{ pages }`, one sorted list read a page at a time, whose index of every row costs every write like a leaderboard. Into another resource: `derive`, in two forms. Into the past: a reader here. Across partitions: **no merger**; a process that runs a view over every row keeps one store fed by slot. *(decided frame, V5-12; the rest picked here, and checked in E-57)*
2. **It is exact because data's merge contract makes every view a function of its rows.** Ties break by row key; one total order per direction; one numeric projection for aggregates and range filters; an exact sum over every finite double; typed bucket keys; `limit` over a sorted parent reads its order. Then two copies, a rebuilt view, a failed-over view and a client agree as values. Built small, every correctness check held: 0 unequal in every seeded run on the final code, and each planted bug was caught in 159 to 1,000 of 1,000 seeds *(checked, E-57)*. Three bars missed (XA-1, XA-2, XB-1; section 7).
3. **The validation changed the plan.** `derive`'s view form as first written left the target wrong at idle in 28 of 1,000 seeds and handed it back to older code in 452 (514 seeds failed in all, 796 when every stale write counts); it now takes the critic's three fixes. Served views need eight more rules than the plan had. Paging moved to one shared index. "Refuse a past window that crosses a data upgrade" was replaced, since it refused every position after the change, all of them answerable. `lookup` tells "loading" from "none". Views are placed on every copy but the leader, since "standbys first" refused held views in 377 of 1,000 seeds with one standby. *(checked, E-57; section 7)*
4. **What does not fit yet, said plainly.** A served leaderboard over a big, busy resource does not fit a write budget with today's data: 134 to 155 µs a change at 100,000 rows *(measured, E-57 A1 and pagecost)* against 20 µs for a whole write, and already 17.4 to 20.6 µs at 10,000 rows, the whole share left for views *(measured, two sessions in E-57; the skeptic's third gave 20.6 to 21.9)*. A `{ pages }` index of every row costs more: 29 to 33 µs a write at 10,000 rows and 509 to 525 µs at 100,000 *(measured, E-57 pagecost, after the skeptic)*. A chunked ordered index cuts a leaderboard to 3.0 to 4.6 µs at 1e5 and 9.5 to 15.1 µs at 1e6 *(measured, E-57 XB-1)*, still above its guessed 3 µs, and a page index to 3.8 to 5.1 µs at 1e5 *(measured, after the skeptic)*. And building a view over 1e6 rows stalls its copy for 0.2 to 1.9 s until data can build in slices *(measured, E-57 XA-1)*. So, until data 5's new index, an ordered served view over more than 5,000 rows and a `{ pages }` over more than 2,000 are refused at build (picked here; guesses at the edge of the budget).
5. **The price.** About **+26 builder rules (21 to 45)** on the base's 416 for the first build, about 6.3 % *(reasoned, section 8)*, beside the `view` selector's model, which is owed and not run. Users learn **ten rules**.
6. **data needs a new version: data 5.0.0, a large major version, in TypeScript, and it needs no Rust.** About 33 changes, 20 of them breaking, about 5,000 to 10,000 lines written or changed against an engine of 7,699 *(a guess, against a count)*: by lines it may touch as much code as the engine has. What stays is the keyed model and the commit schedule. Every piece E-57 built ran in JavaScript on data 4's public API plus a few of its kernel internals. The cost that still misses its bar looks like memory layout, which a typed-array layout in TypeScript may fix (not tried); a native index would have to copy sort keys out of JavaScript rows on every write (E-03). *(section 9)*

---

## 1. What transformations are, in fero's words

A **transformation** is any way code turns a resource's rows or records into something derived. That covers:
- **operators**: `filter`, `map`, the sorts `az` and `za`, windows, `limit`, buckets, counts, sums, ranges, quantiles, set operators;
- **views** over one partition or over the whole resource;
- **where they run**: here on a client, on a server as a named view, pushed below a partition, or into another resource with `derive`;
- **joins** across resources;
- **transforms of the log** for consumers;
- **views of the past**.

Two facts shape all of it.
- **Code cannot travel.** A function left of the live verb does not compile, and untyped code is refused `unencodable` (decided, V5-12; LENS 2.3). A server runs only plain data from a client, or its own code in `methods:`.
- **A client may not make up work over every row on a server.** Each such view costs every write on the server: 100 distinct filters cost 9 to 18 µs a record at 1e5 to 1e6 rows, and `group` 2,574 µs a record at 1e6 in batches of 256 (41.5 ms with one commit per record) *(measured, E-05)*. So a view over every row, for a client, is a method the server named, with a cap (decided, V5-12 pick 5).

And one fact the evidence insists on: **live state and the log differ on purpose** (decided, API 3.10). A slow live reader is folded to one change per row; `changes()` gives every record. A count of events needs the log.

**Three lifetimes.** API 3.11 names three steps. This page makes them a rule of thumb.

| You need | Pick | Why |
|---|---|---|
| a view of rows you hold: a room, a cart, your own rows | **here**, right of the live verb | no server work: the partition crosses once, then about 60 B a change *(measured, E-55 claim 16)* |
| a small live answer over every row: a top 10, totals per team, one number | **a served view** | one view on one copy for every equal call, one encode per change shared by every subscriber *(checked, E-57 A1: 288 encodes for 288,000 sends)* |
| an answer over every row that is big, must survive restarts, must resume from a cursor, has a past, or has thousands of readers | **`derive`'s view form** into a resource | a resource has a log, per-slot cursors, history, `past` and failover already; a served view has none of these |
| every event counted once | **`derive`'s record form** | marks make it exact across restarts *(checked by a model, E-30; E-57 B5)* |
| a reshaped log for consumers | the record form, then `changes()` on the target | a derived resource's log is resumable and replayable; the record form sees records, not rows, so a filter on row content needs whole-row writes (3.6) |

**Names.** The jobs are the same in every spelling; this page uses READS.md's.

| Job | API.md (decided) | READS.md (proposed; this page's code) | CONNECT.md (proposed) |
|---|---|---|---|
| keep a selection live here | `here()` | `live()` | `connect()` |
| keep it live and call me per commit | `tap(fn)` | `on(fn)` | `connect(fn)` |
| a view the server named | `f.methods.best(10).here()` | `f.data.best(10).live()` | `f.data.best(10).connect()` |
| read once | `get()` | `get()` | `get()` |
| every record | `changes()` | `changes()` | `changes()` |
| the past | `asOf(pos)`, a reader | `past(pos)`, a reader with `step` and `seek` | `past(version)`, a value walked with `for…of` |

---

## 2. What went wrong before, and how this plan avoids it

The history found eight causes behind 70 sources of complexity *(checked by the ground study: fero's records, v2 and v3 in git, data's history of 716 commits, and a probe of nine cases on data `63fea66`)*. Each row says what broke, where, the evidence, and what this plan does: **removed** (v5's design or this plan takes away the cause), **fixed** (a named rule or data change answers it, and E-57 checked it), or **accepted** (it stays, on purpose).

| # | What went wrong | Where | Evidence | This plan | Checked by |
|---|---|---|---|---|---|
| 1 | **A view's answer depended on history, not only on its rows.** Ties broken by arrival; `limit` and `reverse` by arrival; float running sums; a `NaN` that stays after its row left; a comparator that is not a total order over mixed types; `distinct`'s first-come value; empty buckets kept; `top(n)` over object rows silently acting as `limit(n)` | data, every version; worse in v5, where there is no order across groups | E-23: a merged top 10 held other rows in 95 % of checks with more than one group; `limit(10)` differed in 99 %; float sums differed from the exact sum in 97 to 99 % *(checked: E-23's seeded runs)*. Probes on data `63fea66`: with 1 % strings in a number column, deleted rows stayed in `az`/`za` in 20 of 20 seeds; `top(1)` over objects was whichever row arrived first; `max` over mixed types depended on arrival *(checked: [data-bugs.out](experiments/E57-transforms/probes/data-bugs.out), [top-objects.out](experiments/E57-transforms/probes/top-objects.out), [maxprobe.out](experiments/E57-transforms/probes/maxprobe.out))* | **Fixed** in data 5's merge contract (C1 to C10, section 9): ties by key, one total order per direction, one numeric projection, an exact sum over every finite double, typed keys; `limit` over a sorted parent reads its order; `limit` and `reverse` over unordered rows stay right of the live verb | E-57 A3 (ties by arrival planted: 895 of 1,000 seeds fail), B1 (1,000 of 1,000), XB-2 to XB-6, XB-13 (0 failures; planted 992 to 1,000) |
| 2 | **The rows under a view moved, and views assumed they did not.** The scoped gather: per-key stamped claims, parking, a coverage sweep, attestation sets, a keyed-read variant, spoke feeds | v2 (Q2, Q3), v3 and v4 (M6, V4-53, V4-62, V4-65) | 23 commits to `api/fold.ts`, 32 to `kernel/scope.ts`; V4-62 alone took 41 commits and eight review rounds; two read bugs still open; in the end a scoped server ran **no** operator on `f.data`, all 33 throw *(checked by the ground study: git log, STATUS, `api/index.ts`)* | **Removed.** One writer per slot (PATHS 4.4). A process that runs a view over every row holds every slot in one store; a slot move is two fold rules, R1 and R2 (section 3.9). No claims, no gather, no spokes | E-57 B1: 19,167,410 checks through 6,122 slot moves, 0 mismatches; R2 off fails 743 and 990 of 1,000 seeds, R1 off 685 and 880 |
| 3 | **Order was a second channel nobody carried.** v2's client mirror ignored `move` records; v3 and v4's method plane skipped them | v2, v3, v4, at the wire | E-55 claim 17: a plain keyed copy of an ordered view was wrong in 239 of 1,000 seeded runs, 0 of 1,000 with data's order channel *(checked: seeded runs)* | **Fixed.** Frames and pictures carry the order; the sink gets `c.order`; operators right of a served ordered view run on an ordered mirror | E-57 A1 (999), A7 (961), XA-5 (981), XA-6 (958 of 1,000 seeds fail when planted) |
| 4 | **No owner for a view's lifetime.** Views kept alive by accident or freed by the collector | v2 (Q2b), v3 (M5), v4 (I-29, V4-16, V4-54: three residues still open) | five open-and-close cycles left five filters worked out on every commit; V4-16 tried to free every unhooked view and backed out, because it froze a view a handler kept on purpose *(checked by the ground study: ISSUES, DECISIONS)* | **Fixed.** A served view is owned by its entry: counted, lingered, taken out of the map, then disposed. A handler's views end with the call. Views right of the live verb end with their handle. No collector decides | E-57 A6: 0 live data views at the end of every run; planted bugs 159 and 817; E-55 claim 26 |
| 5 | **The client's copy had another shape than the server's view.** A live scalar arrived as `{ value }`; views were thenable; `move` was skipped | v3, v4 | I-27 (a live scalar streamed nothing), V4-16, M5c *(checked by the ground study)* | **Fixed.** A served scalar is a number; an ordered answer is an array in rank order with `c.order`; a served view is an address, never a promise; the types say so | tsc, section 12 (`wrong.ts` items 9 and 10; `pins.ts`) |
| 6 | **The cost of a view was hidden.** `group` rebuilt a bucket per change; v4 encoded per subscriber; a reconnect downloaded everything; a gather re-polled on a timer | data; v2 to v4 | `group` 2,574 µs a record at 1e6 rows in batches of 256 (E-05); v4's encode 4.4 to 4.6 µs per subscriber against 2.0 to 2.4 shared (PATHS 4.5) *(measured)* | **Fixed** where it can be: `by(field)` with one aggregate; `group` with per-row deltas in data 5; one encode per frame; resume from a ring or a bounded picture; a cap weighted by cost; ordered served views wait for data 5's index. **Accepted** where it cannot: a view moved to a server still costs the server (class C is for a few shared views) | E-57 A1 (1 encode for 1,000 subscribers), B2 (`by().sum()` 0.66 to 1.84 µs at 1e6 against `group(fn)`'s 78 to 94 ms), XA-9, XB-1 |
| 7 | **Code cannot travel, and the plain-data forms were bolted on.** v2 sent `{ op, col, val }` specs; v3 dropped distributed operators; data's "plain data" flag is per operator, not per call | v2, v3; data's registry | `az` with a comparator is marked plain data, `some('col')` is not *(checked by the ground study: a dump of data's registry)* | **Fixed.** Left of the live verb stands plain data only, and data 5 answers per call whether a call is plain, how it merges and what it costs | tsc, section 12 (`wrong.ts` items 1 to 5) |
| 8 | **Two repos, one contract, many copies of it.** fero kept a hand-copied list of data's operators; a fold change shipped without a SCHEDULE bump; fero v4 needs a SCHEDULE_VERSION that is not published | fero and data | two "VERSION 4" commits of data differ after 47,994 records, in 578 rows *(measured, E-43)* | **Fixed** by data 5: it states its contract per call, exports its exact build id for LAYERS' `fold-version`, and ships the contract as a SCHEDULE clause with a version bump. fero keeps no hand-copied list: its operator types are generated from data 5's exported contract (data's registry names itself the one source for its generated `Ops<T>` types, not built yet; this page's type sketch is still a hand-written copy, section 12) | reasoned; E-57 B6 and XB-12 fold each stretch of the past under its own build |

**New in v5.** The history also found twelve problems no earlier version had, because v5 has groups, slot moves, served views and per-slot positions.

| # | New problem | This plan | Checked by |
|---|---|---|---|
| N-1 | no order across groups: two copies fold groups in other interleavings | every view is a function of its rows (the contract), defined at its store's cut, equal as values | B1: two stores in other orders agreed at all 204 sync points |
| N-2 | slot moves seen by views | R1 and R2 (3.9) | B1 |
| N-3 | failover of a served view | a new picture at or past `seen`, applied as one commit of differences | A3, XA-4 |
| N-4 | compaction cuts the log | served views and `derive`'s view form read rows, not history; the record form stops at `expired` | B3: 7,475 deriver starts after the source's log was cut |
| N-5 | a served view has no position | (instance, frame sequence), plus slot positions in every frame and picture | A2, XA-3 |
| N-6 | views of the past across a data upgrade | fold each stretch under its own data build; refuse only a build that cannot be loaded | B6, XB-12 |
| N-7 | operators at a partition need two-level stores | **accepted as owed**: data's D3 | E-55 claim 19 |
| N-8 | spare servers hold no copy | a spare answers `moved`, naming a copy | reasoned |
| N-9 | joins across resources | one join, `lookup`, kept live, with three states (section 6) | B4, XB-11 |
| N-10 | class B is later | designed (3.3 and 5), with a fallback to class A; waits for the `view` selector's model | A7 |
| N-11 | every reader folds | **accepted** (decided, V5-6); bounded served views keep what crosses small | A1 |
| N-12 | live state against the log | a reshaped log is a derived resource's log; no content filter on a server; the record form sees records, not rows (3.6, section 6) | reasoned |

---

## 3. The plan: where a transform runs

Every place has three answers: who decides, how the API spells it, and why there and not elsewhere. Every code block below is type-checked with the rest of the page (section 12).

| # | Place | Who decides | Who pays, per change | Status |
|---|---|---|---|---|
| P1 | **here**: right of the live verb, on rows held on purpose | the reader's code | this process | decided; data today |
| P2 | **a served view** (class C), or **`{ pages }`** | the server's author names it; the client picks the argument; the copy's caps admit it | one copy: the view's own work, and one encode per frame shared by every subscriber | decided (V5-12 pick 5); its shape picked here; built small (E-57 A) |
| P3 | **below a partition** (class B) | the serving copy, by its shape budget; the answer is the same either way | the copy instead of each reader | later (V5-12 pick 2); built small (E-57 A7) |
| P4 | **into another resource** (`derive`) | the app's author; one deriver under a lock, or `derive()`'s shares | the deriver | record form decided (V5-12 pick 7); view form picked here; the record form with rows later |
| P5 | **across partitions** | nobody: it is the store of a process that holds every slot | that process's fold | picked here; built small (E-57 B1) |
| P6 | **the log**, for a consumer | the consumer | the consumer: every record of its selection crosses once | decided (API 3.10) |
| P7 | **the past** | the reader's code | the reader | decided as a reader (V5-12 pick 8) |

### 3.1 P1, here

```ts
// file: p1-here.ts — P1, here: right of the live verb, on rows this process holds on purpose
import { chat } from './clients.js'
const room = chat.data.room1.live()                                  // one SUB: the partition crosses whole
room.filter((m) => !m.hidden).za('at', 50).on(draw)                  // a function and a window, here
room.za('at').limit(20).on((rows, c) => draw(rows, c.order))         // the newest 20: a window, in data 5 (XB-13)
room.limit(20).on(draw)                                              // unordered: this process's own arrival order
```

- **Who decides:** the code that holds the rows. **Spelling:** anything after the live verb. **Why here:** the rows are already held on purpose, so a view costs nothing on a server and can run any code, functions included.
- `limit` and `reverse` over unordered rows follow this process's own arrival order; that is fine here because nothing else needs to agree with it. Over a sorted parent, `limit(n)` takes the parent's order in data 5, so `za('at').limit(20)` really is the newest 20 *(checked, E-57 XB-13: 200,000 checks; data's `limit` today follows arrival and fails 1,000 of 1,000 seeds)*. This fixes a trap the critic found: today `za('s').limit(3)` keeps showing the old top 3 after a re-rank *(checked: the critic's probe on data `63fea66`, [limitprobe.out](experiments/E57-transforms/probes/limitprobe.out))*.

### 3.2 P2, a view the server named

```ts
// file: p2-served.ts — P2, a view the server named: an address; bounded, capped, shared by every equal call
import { fans } from './clients.js'
fans.data.best(10).on((rows, c) => draw(rows, c.order))      // the picture, then each change, with its rank changes
const top10 = await fans.data.best(10).get()                 // one picture; the entry lingers, then goes
const total: number = fans.data.total(null).live().value     // a served scalar is a number
const teams = fans.data.byTeam(null).live()                  // buckets: a Map from team to number (typed keys)
const names = fans.data.best(10).live().map((f) => f.name)   // right of it: here, kept in the served order (XA-6)
await fans.data.best(10).live().sync()                       // after my own write: wait until the view has it (XA-13)
const first = await fans.data.ranked(null).page()            // pages: one shared index on one copy; a read
const second = first.next && await fans.data.ranked(null).page(first.next)
void [top10, total, teams, names, second]
```

- **Who decides:** the server's author names the view in `methods:` and so decides what work every write may carry. The client picks only the argument. The copy's caps decide whether one more view fits.
- **Spelling:** `{ view: (arg, ctx) => … }` for a live view, `{ pages: (arg, ctx) => …, size }` for a sorted list read a page at a time, and `allow: (arg, claims) => boolean` beside either. The client calls it like a method and gets an address: `get()`, `live()` or `on(fn)`.
- **Why there:** a view over every row needs every row, which only a copy holds. The server names it so that a client cannot make up work on every write.
- **What a served view must be** (picked here; each enforced as shown):
  - **bounded**: a window, one value, or buckets. A view of unbounded rows, of `group`, or of a page after a cursor does not compile (section 12). Buckets cannot be bounded by a type, so `views.rows` (1,000, a guess) is checked on every commit: past it, `END view-too-big`, which stays until the method's code changes *(checked, E-57 A5, XA-12)*.
  - **blind to the caller**: one view serves every equal call, so its function gets `ctx.data` only, no `claims`. A per-user view takes the user as its argument, and `allow` checks it with the caller on every SUB *(checked, E-57 A4: 3,188 denials, 0 frames to them; tsc refuses `ctx.claims`)*.
  - **a function of its argument and the rows**: no clock, no random number, no module state. A view with a `Date.now()` threshold gave another answer after a failover in 822 of 1,000 seeds *(checked, E-57 XA-8)*. The types cannot catch this; it is a user rule. "The last hour" is `by('at', { step })` buckets, and the client picks which buckets to show.
  - **one resource**: `lookup` inside a `{ view }` does not compile, because its positions cover one resource (XA-11). A handler may still join, once.
- **Pages** (changed after the critic and XA-7). The plan made each cursor its own served view, and each built an index of every row: 0.72 MB a page at 1e4 rows and 8.3 MB at 1e5, and the 17th page within a linger was refused. Now `{ pages }` names one sorted list. The copy keeps one shared index for it; `page(after)` is a read of the next `size` rows after the cursor. A read costs 32 B and 10 to 16 µs and holds nothing *(measured, E-57 XA-7)*.
  - **The index is not free** (added after the skeptic). It is an ordered view of every row with no window, kept up on every write while it lives, and each page read pushes its linger forward. On today's data it costs 8.3 to 9.1 µs a write at 1,000 rows, 18.7 to 19.5 at 5,000, 29 to 33 at 10,000 and 509 to 525 at 100,000: more than a leaderboard over the same rows (6.1 to 6.7, 12.2 to 15.7, 19.8 to 20.6 and 147 to 155) *(measured, E-57 pagecost)*. D8c's chunked index without a window costs 1.7 to 2.4 µs at 1e4 rows, 3.8 to 5.1 at 1e5 and 9.7 to 11.2 at 1e6 *(measured, E-57 pageindex-cost)*. So `{ pages }` counts in the cap as an ordered view, and until D8c a `{ pages }` over more than 2,000 rows is refused at build (3.8).
  - **The promise** is exact within one cut; across fetches, a row is shown exactly once if its sort value did not change between the fetches *(checked, E-57 XB-7: 984,927 such rows, each seen once)*. A page read carries the client's `seen`, and a copy behind it waits (as the prototype does), so the fetches of one walk are at positions that never go back, even when the walk moves to another copy: that is the model XB-7 checked *(reasoned; a seeded walk with a failover between fetches was not run, section 10)*. At `depth: 2` a cursor names (partition, row) *(checked, XB-6)*.
- **Read-your-writes**: `sync()` resolves once the view has passed every write this process saw resolve. The client sends `SYNC { seen }`; the copy answers when its store passes it *(checked, E-57 XA-13: 1,965 answers, 0 early)*. The plan had left this out; the critic showed it is one rule.

### 3.3 P3, below a partition (class B, later)

```ts
// file: p3-pushdown.ts — P3, plain data left of the live verb, inside one partition (class B, later)
import { chat } from './clients.js'
chat.data.room1.gt('stars', 0).za('stars', 10).on(draw)          // the first build sends room1 and runs the chain here
chat.data.room1.by('at', { step: 60_000 }).length().on(draw)      // a time bucket: one count per minute
chat.data.room1.eq('text', 'hi').length().on((n) => draw(n))      // the same answer wherever it runs
```

- **Who decides:** the serving copy, by its shape budget. **Spelling:** plain data left of the live verb, on a partition. **Why it is later:** the first build sends whole partitions (V5-12 pick 2). Later, a copy may run the chain and send only the answer.
- **The answer is the same either way.** Class B through disconnects, ring resumes, pictures and the fallback to class A equalled the chain run here in 79,209 checks *(checked, E-57 A7)*.
- **What it buys is bytes, not CPU.** A shape costs the copy 1.2 to 3.2 µs a change, about what it costs the client in class A (1.3 to 5.0 µs); the wire carries 0.1 to 28 B a change against 108 to 113 B *(measured, E-57 A7)*. Past `views.shapes` (a guess), the copy serves the SUB as class A, with the same answer.

### 3.4 P4, into another resource

```ts
// file: p4-derive.ts — P4, into another resource: the view form and the record form
import { derive, op } from 'fero'
import { orders, totals, counts } from './server.js'
await derive(orders.data.by('user').sum('cents'), totals)       // view form: totals equals the view; rebuilt from rows
await derive(orders, counts, (e) => {                           // record form: once per record, by marks; needs history
  if (e.value) void counts.data[e.value.user].set(op.incr(1), { from: e })   // e.value: whole-row writes only
})
```

- **Who decides:** the app's author. **Spelling:** `derive(view, target)` for the view form, `derive(source, target, fn)` for the record form. **Why a resource:** it has a log, cursors, history, `past` and failover already.
- **The view form** (picked here; changed after B3). The target's rows are kept equal to a bucket view of the source with one value per bucket. As the plan first wrote it (a lock, fenced writes, a full difference on takeover) it left the target wrong at idle in 28 of 1,000 seeds and brought the old code's output back after a deploy in 452: **514 seeds failed** on the bar the fixed design meets, and 796 if every stale write that landed also counts (688 seeds had one) *(checked, E-57 B3; the like-for-like count rerun after the skeptic)*. It now runs this way:
  1. Take the lock `derive:<target>`; its row carries the deriver's code version and data build. A deriver never takes over from newer code. After a rollback, an admin resets the lock row's version; until then health warns that the target has no deriver that may take it (picked here, after the skeptic).
  2. **Bump** every target group: one fenced no-op write each, and wait for each answer.
  3. Read the source's commit position **after** the bumps: that is the **read barrier**. Fold up to it **silently**, sending no writes.
  4. Read the target, then write the difference: a set for each changed bucket, a remove for each bucket that went. Every write carries the lock token.
  5. Follow the source: one fenced write per changed bucket per commit.
  
  With these: 0 of 1,000 seeds fail, through 11,810 deriver changes and 7,475 starts after the source's log was cut, with 0 step-backs *(checked, E-57 B3, XB-8, XB-9, XB-10)*. The plan's user rule "the target may step back once" goes.
- **Who writes the target, and how buckets name its rows** (picked here, after the skeptic; reasoned, not run). Only the deriver writes the target; any other write to it is refused `derived`, since a stray write would stay until the next restart's difference. Each bucket names one target row: a string bucket by the string, a number bucket (a `step` bucket's start) by its decimal form. By type the view form takes only a string field or a number field (section 12, item 23). Two buckets with one name at run time (`1` and `'1'`, which only an untyped writer can make) stop the deriver with `bucket-collision`, named in health. B3's buckets were strings only, so mixed bucket types never ran.
- **What the view form does not promise.** A stale write can still land at a target group in the gap between the lock change and the bump's arrival there; no fence carried by a message can stop that. It is harmless, because the new deriver reads the target only after every bump and its difference repairs it: 1,389 such writes landed, all repaired *(checked, XB-8 as restated)*. And its log is a log of **states** (each restart's difference is in it), not of events: a consumer that counts records there miscounts. Events go through the record form.
- **The record form** (decided, V5-12 pick 7) is kept, with one change from B5: the mark carries the write's number inside its record, and a record's outputs to one slot go out in that order. E-30's model, widened to two outputs of one record in one slot, holds on all 12 bounds; without the number, or without the order, an output is lost *(checked, E-57 B5)*. Packed into one number (sequence × 256 + w), the mark stays 29 B. That holds 256 outputs of one record to one slot and sequences below 2^45 per slot *(arithmetic)*: a record whose `fn` writes more to one slot is refused `too-many-outputs`, and past 2^45 a slot's marks take the pair form, 93 B (picked here, after the skeptic).
- **The record form sees the record, not the row** (a limit, stated after the skeptic). `fn` gets `e`, and `e.value` is set only for a whole-row write (API 3.10). A field write or a remove carries no row, so a filter on row content in `fn` is exact only for a source written by whole-row writes. **Later, the record form with rows**: `derive(source, target, (e, { row, prev }) => …, { rows: true })`. The deriver then folds its share of the source, so `fn` also gets the row after the record and before it. It costs one fold per record (0.63 to 1.5 µs at 1e3 to 1e5 rows, *measured, A1*) and the rows' memory (about 330 B a row, *measured, E-05*). On a restart it opens the source's past at its mark and folds forward, which needs the history the record form needs anyway *(picked here; reasoned; not built)*.

### 3.5 P5, across partitions

```ts
// file: p5-across.ts — P5, across partitions: a process that holds every slot runs it over its one store
import { fans } from './server.js'
const best = fans.data.za('points', 10).live()                  // on a copy: every row, every group, one view
void best
```

- **Who decides:** nobody. A process that holds every slot (a copy, or a client with `hold: 'all'`) runs a view at the root over its one store. **Why no merger:** see 3.9.

### 3.6 P6, the log

```ts
// file: p6-log.ts — P6, the log: every record, in your own loop; a reshaped log is a derived resource's log
import { derive } from 'fero'
import { orders as ordersOnServer, big } from './server.js'
import { orders } from './clients.js'
for await (const e of orders.data.changes({ from: cur })) if ((e.value?.cents ?? 0) > 100) send(e)   // here: whole-row writes only
await derive(ordersOnServer, big, (e, { row, prev }) => {                                      // or once, for every reader (later)
  const k = `${e.partition}/${e.key}`
  if (row && row.cents > 100) void big.data[k].set(row, { from: e })                           // in, or changed while in
  else if (prev && prev.cents > 100) void big.data[k].remove({ from: e })                      // left the filter, or removed
}, { rows: true })                                                                              // the deriver folds its share of orders
for await (const e of big.data.changes({ from: cur })) send(e)                                 // its own log, cursors, history
```

- **Who decides:** the consumer. Its map or filter runs in its own loop; every record of its selection crosses once (API P-07, streams and replay). **A filtered log for many consumers** is a derived resource's log, written once with the record form; its readers get their own cursors, history and resume. A filter on row content needs the row: in the first build that means a source written by whole-row writes; for any source, the record form with rows (later, 3.4), as the example writes it. There is **no server-side filter of the log by row content** (section 6).

### 3.7 P7, the past, and the one join

```ts
// file: p7-past.ts — P7, the past: a reader here; views on it step with it, one commit per step
import { orders } from './clients.js'
const was = await orders.data.ada.past(v)                       // asOf in API.md
was.za('at', 5).on(draw)                                        // a view on the past, here
was.by('sku').sum('cents').on(draw)
was.step(-1)                                                    // each view gets one call: the rows that differ
```

```ts
// file: p8-join.ts — the one join: a lookup by key, kept live, right of the live verb
import { orders, products } from './clients.js'
orders.data.ada.live().lookup(products.data, 'sku').on((rows) => {
  for (const k in rows) {
    const j = rows[k]
    if (!j) continue
    if (j.other === undefined) draw(j.row.sku, 'loading')        // its picture is on its way
    else if (j.other === null) draw(j.row.sku, 'no such product') // none, or removed
    else draw(j.row.cents, j.other.price)                         // both sides live; no common cut
  }
})
```

- **The past** is a reader here (decided, V5-12 pick 8). In READS.md's model, views on it step with it: a step or a seek reaches each view as **one commit** of the rows that differ, with one call *(checked, E-57 B6: 41,000 checks, 0 extra calls; planted record-by-record steps fail 1,000 of 1,000 seeds)*. B6 checks READS.md's model only. In CONNECT.md's spelling `past` gives a value, and `step(n)` gives a new value without changing the old one, so views made on one value do not move. There, a view kept across a walk is fed from each step's differences (`for…of` yields the state and its diff), or rebuilt per value at O(rows of the view) a step *(reasoned; not run)*.
- **The join** is section 6.

### 3.8 How a served view works, written out

This is the state and the messages a builder writes (picked here; built small in E-57 A, 1,000 seeds a claim). Each rule's mark says what showed it is needed: a planted bug that the oracle caught, or a seeded run that failed until the rule was added.

**Where it lives.** Each served view lives on **one** copy, chosen by a hash of its key over the serving copies (rendezvous hashing, *from memory: a standard way*). The serving copies are **every live copy except the leader**: standbys and voters alike. A SUB at another copy gets `END moved`, naming the right one. *(checked, E-57 XA-2: 50 views for 50 keys, none on two copies; planted free choice built 100; XA-1: 0 entries on a leader in every run)*. This changed after the skeptic. The page first said "standbys first". With one standby that put every view on it: its failure moved every view to the voters, its return moved every view back, and a client that held a view was refused in 377 of 1,000 seeds (36 with two standbys). With every copy but the leader serving, 6 and 5 of 1,000 *(checked, E-57 xa2sb, xa2s2, xa2sbx, xa2s2x)*. The price: a new leader hands its views on, 1,796 to 3,271 hand-offs per 1,000 seeds with standbys and 608 to 3,644 with three voters only *(checked, E-57 xa2s2x, xa2sbx, A3)*. Values never went back, but each hand-off is a trip and a rebuild.

**The entry**, one per served view on its copy:

| Field | What it is |
|---|---|
| key | the method's name, the argument's canonical bytes (object keys sorted), the method's version, and the data build. The version is the one the method declares (`version` beside `view`), else the deploy's build id, so a method that declares none ends its entries at every deploy. (Changed after the skeptic: a hash of the method's own text missed a changed helper or constant.) |
| instance | (copy, incarnation, counter): unique across copies *(checked, XA-3: per-copy counters planted, 319 of 1,000 seeds fail)* |
| view | the data view the `{ view }` function built over the copy's whole-resource store, in a data scope the entry owns |
| holders and counts | who holds it, counted against `views.client` and `views.max` |
| linger | started when the count reaches zero; at its end the entry leaves the map, **then** its view is disposed |
| ring | the last frames (64, a guess) and the frame sequence |

**The messages.**
- **`SUB { view: { method, arg }, resume?: { instance, seq }, seen, minVer }`**. `seen` is the client's highest position per slot; `minVer` the highest version of this method it has seen.
- **The check.** `allow(arg, claims)` runs with the caller's claims on every SUB, joins included *(checked, A4: `allow` only at build, planted, 163 of 1,000 seeds leak)*.
- **The answer.** If `resume` names this entry's instance and the ring reaches back, the answer carries the missed frames **inside it** (found by A7: frames sent beside it arrived out of turn). Otherwise, or when a picture is smaller (true for small bucket views: 179 B against 543 B, *measured, A2*), the copy waits until its store is at or past `seen`, then sends a picture: the value, its order, the instance, the sequence and the slot positions *(checked, A3: a picture before `seen`, planted, went back in time in 799 of 1,000 seeds)*.
- **A frame**: one per commit that changed the view, encoded once and shared, with the order changes after the row changes and the positions of the slots the commit touched. Its position is set before the sink runs (found by A1).
- **`END`** with a reason: `view-too-big`, `redeployed` (the method's version changed), or `moved`. **Refusals**: `too-many-views`, `no-such-method`, `bad-arg`, `retry` (a copy behind or still building), `stale-client` (a client older than the method it asks for).
- **`SYNC { seen }`**: an empty frame once the store passes `seen`.
- **`PAGE { method, arg, after, seen }`** (added after the skeptic): once the store passes `seen`, the next `size` rows after the cursor on the list's shared index, and the next cursor. It builds the index if none lives (counted and paced like a SUB), pushes its linger forward, and holds nothing.

**The client.**
- One selection per distinct call; equal calls in one process share it.
- It applies every new picture (after a failover, a ring miss or a redeploy) as **one commit of differences**, with one sink call *(checked, XA-4: a wholesale replace, planted, fails 969 of 1,000 seeds)*.
- It keeps an **ordered mirror** (rows and order), so operators right of a served ordered view keep its order *(checked, XA-6)*.
- It routes a frame to every selection it holds on that instance (found by A7). It drops a frame from another instance, one it already applied, and one below the highest version of that method it has seen. The copy-side floor alone failed 15 of 1,000 seeds in a rolling deploy *(checked, XA-10)*.
- An empty aggregate travels as "no value", which the codec must keep apart from `null` (found by A7).

**Caps** (picked here; the numbers are guesses):
- `views.client` (16) live served views per client per copy. A join counts (found by A5). A `get()` that reuses an entry moves no count (found by A5: it let a client pass its cap in 2 of 100 seeds).
- `views.max` (**64**, down from API.md's 1,000) per copy. Lingering entries count. Each entry is weighted by data 5's cost class for its call (O(1), O(log n) or O(n) per change), so the cap bounds cost, not only count *(checked, XA-9, on guessed cost classes: 0 mismatches against an independent sum)*. A `{ pages }` index counts as an ordered view.
- **Headroom** (changed after the skeptic). With k serving copies, k of 2 or more, `views.max / k` is kept free on each for clients that held a view on a copy that died; with one serving copy, none, since its failover goes to copies that hold no views. A SUB from a client that held the view may evict lingering entries. So the copies together admit about (k − 1) × `views.max` fresh views: at k = 2, `views.max` in all, half their room *(arithmetic)*. The first formula kept `views.max / k` at k = 1 too, which is all of it, so a lone serving copy admitted no fresh view; planted, it refused 3,334 fresh SUBs wrongly in 841 of 1,000 seeds *(checked, E-57 xa2sbx)*.
- **What headroom covers.** Not every failure. With the rule above, a client that held a view was refused in 1 of 1,000 seeds with three voters and copy kills (XA-2), 21 with leader kills too (xa2l), and 5 to 6 with one or two standbys (xa2sbx, xa2s2x) *(checked)*. In the page's configuration each traced refusal came at the run's end, when the sim restarts every dead copy at once and views move back in bulk *(checked: five seeds of xa2sbx traced)*; with leader kills on three voters they came late in the run, at steps 272 to 300 of 300, and were not diagnosed further *(checked: five seeds of xa2l)*. This page says so rather than promise more: a failover may refuse a held view, rarely, while copies come and go.
- **The row guards** (changed after the skeptic). Before data 5's ordered index (D8c), an ordered `{ view }` over more than **5,000** rows, or a `{ pages }` over more than **2,000**, ends `view-too-big` at build *(picked here; guesses at the edge of the 18 µs left for views, 8.2: a window costs 12.2 to 15.7 µs a change at 5,000 rows and 17.4 to 20.6 at 10,000; a page index 8.3 to 9.1 at 1,000 and 18.7 to 19.5 at 5,000; measured, E-57 A1 and pagecost)*. Timed ranges move 10 to 25 % between sessions: the leaderboard at 1e4 rows gave 17.4 to 19.1 µs in one session, 19.8 to 20.6 in a second and 20.6 to 21.9 in the skeptic's *(measured)*.
- **Windows over one sorted list** (after the skeptic). `best(n)` with n from 1 to 100 is up to 100 entries, and on today's data each keeps its own index of every row (9.1 MB and 134 to 155 µs a write each at 1e5 rows). With data 5 (D8c, N4), windows over one sorted parent share one ordered node and n only trims each frame, so they cost one index *(reasoned; not built)*. Until then the cost-weighted cap and the row guard bound them. A cap per method is not taken (section 10).

**Builds.** A copy builds one view at a time per resource; a `get()` with no live entry builds like a SUB, counted and paced, never a hidden multi-second block. Today a build over 1e6 rows blocks its copy's main thread for 0.49 to 1.9 s in one piece; sliced into 20,000-row slices the bucket and sum builds still block 0.21 to 0.24 s, because data's only way to list its keys copies the store, and `best(10)`'s index cannot be sliced from outside data at all *(measured, XA-1)*. At 1e5 rows the sliced builds block 15 to 16 ms. So data 5 needs a resumable key iterator and every view built in slices (N9, D9). Serving off the leader keeps these stalls off the write path: the leader, which takes the writes, never builds; a copy that builds slows only its own fold, which a commit does not wait for *(reasoned)*.

### 3.9 Across partitions: one store fed by slot

This is what cost v3 and v4 the most (row 2 of section 2). v5 removes its cause: one writer per slot. So the plan takes the simplest form that is exact, and E-57 B1 checked it.

- **R0. A whole-resource store holds every slot.** A process that runs a view over every row keeps one data store for the resource, fed from every group it holds a copy of; any slot it lacks, it holds the way `hold: 'all'` does. In the first build R0 is free: one group, and every copy holds it.
- **R1. Per slot, a record at or below the store's position is dropped.** A slot move carries the slot's position, so a move does not change it (E-19).
- **R2. An importing group's copy of a slot never feeds the store before that slot opens there.** It is kept apart, per (slot, importing group): a store that lags can see one slot move twice before it folds the first, and a copy kept per slot alone mixed the two (B1's first run stopped on exactly this). When the slot opens: if the store already reached that position, the copy is dropped; if it is behind, the store takes it as **one commit of differences**.

Result: eight views over every row (a top 10 with ties, a page, counts and exact sums per bucket, a count, an exact sum, two filters) equalled the query on the true rows at the store's cut after every entry: 19,167,410 checks over 1e5 commits for 1, 4, 16 and a changing number of groups, 0 mismatches, through 6,122 moves of 138,843 slots, and 23,498 slot opens taken while the store was behind *(checked, E-57 B1)*. Cost: +0.31 to 0.61 µs a record over a plain fold; about 2 µs a row for R2's difference *(measured, B1)*.

**When a real merger is needed:** only when no process can hold every row, a resource larger than one server's memory. Then E-23's merger is the design. It is **not covered** (section 10).

---

## 4. Each operator

"Left" is left of the live verb (plain data; a copy may run it inside a partition, class B, later). "Here" is right of it. "View" is inside a server's `{ view }` or `{ pages }`. "Derive" is `derive`'s view form. "Merges" says whether the answer is a function of the rows only once data 5's contract holds, so copies, rebuilt views and clients agree. Costs are per change that reaches the view; E-57's prototype costs are the prototype's, not data 5's. The contract rules C1 to C10 are listed in section 9.

| Operators | Class | Left | Here | View | Derive | Merges | Cost per change | Rules |
|---|---|---|---|---|---|---|---|---|
| `eq`, `in` (new) | row filter | yes | yes | in a bounded chain | — | yes | `eq` 0.13 to 0.24 µs at 2,000 rows *(measured, E-57 B1)* | scalars only; typed, SameValueZero: `1` ≠ `'1'`, `NaN` = `NaN`, `-0` = `0` (C10; XB-5) |
| `gt`, `gte`, `lt`, `lte`, `between` | row filter | yes | yes | in a bounded chain | — | yes | `gt` 0.15 to 0.23 µs at 2,000 rows *(measured, B1)*; `between` keeps a sorted index of every row, re-sorted lazily *(checked: data ops/between.ts)* | the numeric projection: fields and bounds are numbers, by type too (section 12, item 24); today `'60' > 50` passes *(checked: data ops/rowops.ts:279)* (C9) |
| `filter(fn)`, `map(fn)`, `byFn(fn)` | row code | **no** | yes | the server's own code | — | yes | about 1 µs plus the function *(measured, E-05)* | over an ordered parent they keep its order (XA-6) |
| `length`, `sum`, `avg` | add | yes | yes | yes: one value | — | yes | exact `sum` 0.36 to 0.44 µs at 2,000 rows *(measured, B1)*; served, with its frame on every write, 1.8 to 3.5 µs *(measured, A1)* | exact over every finite double, `NaN` and the infinities counted apart, `-0` kept (C3; XB-4); numbers only (C9) |
| `min`, `max` | extreme | yes | yes | yes | — | yes | O(1); an O(n) rescan when the extreme leaves *(checked: data ops/misc.ts)* | numbers only (C9). Today data's `min` and `max` keep any non-null value and compare with `>` and `<`, so over a mixed column the answer depends on arrival order: rows `{a: 5, b: 'x'}` give 5 or `'x'` *(checked: [maxprobe.out](experiments/E57-transforms/probes/maxprobe.out); data ops/misc.ts)*. C9 changes their answers. (XB-3 put a numbers-only filter before them, so it did not test them as they are) |
| `median`, `quantile`, `percentile` | column | on a partition | yes | allowed, weighted as O(n) | — | yes | an O(n) memory move per change *(checked: data ops/quantile.ts)* | numbers only (data already skips the rest) |
| `some(field)`, `every(field)` | flag | yes | yes | yes | — | yes | O(1) *(reasoned)* | the field forms become plain data (N3) |
| `by(field, { step })` then `length`, `sum`, `avg`, `min`, `max` (new) | add per bucket | yes | yes | yes, up to `views.rows` buckets | **yes: the only form it takes** | yes | `by().sum()` 1.30 to 1.63 µs at 1e4 rows, 0.66 to 1.84 at 1e6 *(measured, B2)*; served, with its frame, 3.7 to 4.9 µs *(measured, A1)*; 118 B a bucket with a count, 399 B with an exact sum | typed bucket keys (C10): the answer is a `Map` from the bucket's value, so `1` and `'1'` are two entries (picked here, after the skeptic); an emptied bucket goes (C5); `step` takes finite numbers only |
| `group(field)`, `group(fn)` | rows per bucket | the field form | yes | **no**: as big as the rows | **no** | yes | today 264 to 282 µs at 1e4 rows, 4.1 to 4.9 ms at 1e5, **78 to 94 ms at 1e6** *(measured, B2)*; data 5: per-row deltas, O(1) *(reasoned; the deltas checked exact, B2)* | per-row deltas (D8b); prefer `by().length()` when only counts show |
| `distinct(field)` | rows per value | yes | yes | **no** | no | yes | O(1); O(holders) when its representative leaves *(checked: data ops/misc.ts)* | the smallest key's value (C4); typed (C10) |
| `az`/`za(field, n)` | window | yes | yes | **yes**: the leaderboard | no | yes | data today, served: 5.7 to 6.7 µs at 1e3 rows, 12.2 to 15.7 at 5,000, 17.4 to 20.6 at 1e4, **134 to 155 at 1e5** *(measured, A1 and pagecost, two sessions)*; 1,305 to 1,385 at 1e6 *(measured by the critic: [ordcost.jsonl](experiments/E57-transforms/probes/ordcost.jsonl))*. A chunked index: 2.4 to 3.7, 3.0 to 4.6, **9.5 to 15.1 µs** at 1e4, 1e5, 1e6 *(measured, XB-1)*. 1.1 MB at 1e4 rows, 9.1 MB at 1e5, whatever n is *(measured, A5)* | ties by row key, in UTF-16 code units; one total order per direction (C1, C2; XB-2); an O(log N) index (D8c) |
| `az`/`za(field)` | sorted, unbounded | on a partition | yes | only as `{ pages }` | no | yes | one shared index of every row, kept on every write: today 8.3 to 9.1 µs at 1e3 rows, 29 to 33 at 1e4, 509 to 525 at 1e5 *(measured, pagecost)*; D8c's index 1.7 to 2.4, 3.8 to 5.1 and 9.7 to 11.2 at 1e4, 1e5, 1e6 *(measured, pageindex-cost)* | as above |
| `az`/`za(field, n, { after })`; `page(after)` | page | on a partition | yes | only through `{ pages }` | no | exact within one cut | a page read 10 to 16 µs, 32 B, on one shared index *(measured, XA-7)*; the index's own cost is the row above | a cursor is (value, key), or (value, partition, row) over every row at depth 2 (XB-6, XB-7) |
| `limit(n)` over a sorted parent | window (data 5) | no: write `za(field, n)` | yes | yes | no | yes | as `za` | reads the parent's order channel (XB-13) |
| `limit(n)`, `reverse()` over unordered rows | arrival | **no** | yes | **no** | no | **no** | as `za` *(reasoned)* | marked "arrival" (C7) |
| `intersect`, `union`, `except` | rows | when both sides are plain chains on one lens | yes | in a bounded chain | no | yes | O(touched rows) *(checked: data ops/setops.ts)* | — |
| `reduce`, `to` | none | **no** | yes | the server's own code, bounded | no | **no** | `to(fn)` hands the whole value per change: O(N) *(checked: data ops/misc.ts)* | the 3-argument `reduce` must not share its `init` (F2) |
| `top(n)` | — | no | no | no | no | — | — | over object rows it throws, where today it acts as `limit(n)` (C8); write `za(field, n)` |
| `lookup(other, field)` (new) | rows by the left key | **no** | yes | **no**: a handler may | no | per side, no common cut | 2.9 to 3.9 µs a left change; a right change about 0.4 µs per left row that names it; 161 B a left row *(measured, B4)* | three states (section 6) |
| `length(fn)` (data's `lengthBuckets`) | count per bucket, by code | **no** | yes | the server's own code, up to `views.rows` | no: the view form takes `by(field)` | yes, once emptied buckets go (C5; today they stay, *checked: [data-bugs.out](experiments/E57-transforms/probes/data-bugs.out)*) | 0.25 to 0.42 µs at 1e4 rows, 0.37 to 1.48 at 1e5 *(measured, B2)* | `by(field).length()` is its plain-data form |
| `keys()`, `values()` | the key list, the row list | on a partition | yes | **no**: as big as the rows | no | as sets; their order is arrival (as C7) | O(1) a change *(reasoned)* | — |
| `tap(fn)` | an effect per change | **no** | yes | **no** | no | — | a call per change, data's older record shape | the sink is `on(fn)`; `tap` stays for code that wants records |
| `on(fn)` (a sink) | — | — | yes | — | — | — | 92 to 198 ns a commit, +163 to 220 ns per changed row for the freeze *(measured, E-55 claim 10)* | one call per commit; rows frozen |

What the table means:
- **Every operator that may stand left of the line is plain data and merges.** That is the per-call test fero needs, and data 5 answers it, so fero's operator types can be generated from data 5's contract instead of copied by hand (this page's sketch is still a hand-written copy, section 12).
- **Dashboards move from `group(fn)` to `by(field)`**: from 78 to 94 ms a change at 1e6 rows to about 1 to 2 µs *(measured, B2)*, and from code to plain data. data's `length(fn)` already counts per bucket for 0.25 to 0.42 µs at 1e4 rows *(measured, B2)*; `by(field).length()` is the same count as plain data.
- **The ordered window is the dearest common view, and the one that does not fit yet.** At 1e4 rows one served leaderboard already costs 17.4 to 20.6 µs, about the whole 20 µs of a write *(measured, A1 and pagecost; arithmetic)*, and a `{ pages }` index more (29 to 33 µs).
- **No expression language.** A filter as data is a chain of field tests: AND is a chain, OR over one field is `in`, OR across fields is a `union` of two chains. Anything more is code: right of the line, or in a method *(reasoned)*.

---

## 5. Lifecycle: what each kind of view does when things change

One row per event, one column per kind of view. "As P1" means the column follows the P1 cell. The marks follow the table.

| Event | P1, here | P2, a served view | P3, class B (later) | `derive`, view form | `derive`, record form | `lookup` | a past reader |
|---|---|---|---|---|---|---|---|
| **reconnect and resume** | resume from the per-slot cursor; the missed commits arrive as commits; past the ring or the log, a picture as one commit of differences | from the ring, its frames inside the answer; else, or when smaller, a picture at or past `seen`; never back in time | as P2, keyed by partition and chain | the deriver's source link as P1; target writes retry | resume from the marks | each link as P1 | the reader's log link resumes from its cursor |
| **the serving copy fails** | the link moves to another copy with its cursor | SUB at the next copy by hash; it builds the view or joins one, then a picture at or past `seen`, as one commit of differences | as P2; a rebuild is O(partition) | if the deriver dies, the next takes the lock: bump, barrier, difference | as today (E-30) | as P1 | as P1 |
| **a leader changes** | nothing: copies keep folding | the new leader hands the views it served on: `END moved`, then a picture as one commit of differences (every copy but the leader serves) | as P2 | target writes wait and retry | as today | nothing | nothing |
| **a slot moves** | `END` at the fence; subscribe again at the new group from the same position | nothing visible on a store fed by slot (R1, R2). The first build has one group, so no moves | `END` at the fence; SUB again | R1 and R2 on the deriver's store; the target's moves are ordinary writes | marks move with their slot | as P1 | below the fence it reads the old group's segments |
| **compaction** | nothing; a resume past what is kept takes a picture | nothing: it reads rows; a resume uses its ring | as P2 | **nothing**: it reads rows, not history | needs history; past the marks, `expired`, and no rebuild without the whole log | as P1 | opening before what is kept: `expired` |
| **a copy restarts** | as a failover | entries are memory only; each view still wanted is built again once, one at a time per resource, from the copy's current rows | as P2 | the restart rebuilds the view and writes the difference | from the marks | as P1 | — |
| **a deploy changes the view** | your new build builds new views | the method's version changes: its entries end `redeployed`; a client never shows an older version than it has seen; an older typed client gets `stale-client` | the chain is data; a new data build is a new `fold-version` | the lock row carries the code version; a deriver never takes over from newer code | the new code goes on from the marks | — | a new data build: each stretch is folded under its own build |
| **a data upgrade** (a `fold-version` change at an offset; added after the skeptic) | past the offset the client folds under the new build or is refused `old-fold` (LAYERS `fold-version`); its views rebuild under it, one commit of differences | entries are keyed by the data build too: at the offset each ends `redeployed` and is built again once; the client's floor counts the build, so it never shows an old build's answer after a new one's | as P2 | the lock row carries the data build: at the source's offset the deriver rebuilds its view under the new build and writes the difference; a deriver on the old build cannot fold past the offset | records are not folded again; `fn` decides the outputs (with rows, as the view form) | each side folds under its own resource's build; a link past an offset takes a new picture | each stretch is folded under its own build (XB-12) |
| **a cap is reached** | none: local | `too-many-views` past `views.client` or `views.max` (weighted by cost), with headroom for held views; past `views.rows`, `END view-too-big`, which stays until the code changes | past `views.shapes`, served as class A: same answer, nothing refused | — | pacing (LAYERS 8.8) | none designed (section 10) | — |
| **the last holder leaves** | the handle closes; the view ends with it | the linger starts; a SUB inside it reuses the entry; at its end the entry leaves the map, then the view is disposed | as P2 | — | — | a key no longer named lingers, then its link ends | the reader and its views end with it |
| **time travel** | build the same view on a past reader | not served (V5-12 pick 8); a handler may open a past reader and return a value | — | the target is a resource, so it has a past of its own | as the view form | each side's past is a reader of its own; no common cut | a step or a seek is one commit to every view on it |

**The evidence, cell by cell** (all from E-57 unless named):
- **Resume.** P1: 0 wrong across 4,337 disconnects *(checked, E-55 claim 7)*. P2: 12,870 disconnects, 6,166 ring resumes, 5,909 resume pictures, 0 doubled, missed, unequal or back in time; resuming from the client's own frame count, planted, fails 329 of 1,000 seeds *(checked, A2)*. A ring answer costs the copy 1.4 to 1.7 µs against 5.8 to 6.2 µs for a picture at 1e4 rows, but is bigger for small bucket views (543 B against 179 B) *(measured, A2)*.
- **Failover.** 5,371 copy kills, 22,040 pictures, 16,139 builds on copies restarted from a snapshot, 0 unequal *(checked, A3)*. A picture applied wholesale instead of as one commit of differences, planted, fails 969 of 1,000 seeds *(checked, XA-4)*.
- **Leader change.** 0 entries on a leader in every run; with three voters and no standbys, 608 to 3,644 hand-offs per 1,000 seeds; with one or two standbys and every copy but the leader serving, 1,796 to 3,271 *(checked, XA-1, A3, xa2s2x, xa2sbx)*. Serving from standbys only would remove most of them (57 to 564), but with one standby it refused a held view in 377 of 1,000 seeds *(checked, xa2s2, xa2sb)*.
- **Slot move.** B1, section 3.9 *(checked)*. The first build has one group *(checked: LAYERS section 10 item 12)*.
- **Compaction.** 7,475 deriver starts after the source's log was cut, 0 unequal *(checked, B3)*.
- **Restart.** One view's build: `best(10)` 90 to 97 ms at 1e5 rows and 1,440 to 1,521 ms at 1e6; the bucket view 32 to 38 ms and 643 to 720 ms; the sum 30 to 35 ms and 498 to 523 ms *(measured, A3)*. A `derive` restart at 1e5 source rows and 1e3 buckets: 48.7 to 51.8 ms *(measured, B3)*. So 64 views over 1e6 rows would take about 32 to 97 s of builds in a row *(arithmetic: 64 times 0.5 to 1.5 s)*, which is one more reason for few served views and data 5's sliced builds.
- **Deploy.** 1,000 deploys, 1,365 entries ended `redeployed`, 0 frames from an old version; a key without the version, planted, fails 765 *(checked, A8)*. A rolling deploy with kills: 0 back in version over 3,000 deploys, 2,751 `stale-client`; without the client's floor, 15 of 1,000 seeds failed *(checked, XA-10)*. A deriver without the version in its lock row handed the target back to old code in 225 of 1,000 seeds *(checked, XB-10)*.
- **Data upgrade.** *(reasoned; not run)*. A served view built under the old build gives another answer at the offset with no write, which is why its key and the deriver's lock row carry the build. XA-10 tested method versions and XB-12 past readers only. The first data 5 rollout is exactly this event, so it runs as a rolling deploy: every copy loads data 5 beside data 4, the leader writes the `fold-version` entry at an offset, every copy switches there, served entries end `redeployed` and are built once more, and derivers rebuild. What would settle it: XA-10's rolling deploy with a data build in the key (section 10).
- **Caps.** 28,211 admissions, 0 unlike an independent count *(checked, A5)*; 1,641 `view-too-big` ends, 0 rebuilds after *(checked, XA-12)*; held views refused rarely after membership changes: 1 to 21 of 1,000 seeds by configuration *(checked, XA-2 and its reruns after the skeptic, 3.8)*.
- **Linger.** 3,124 reuses inside the linger; 0 sink calls after a dispose; 0 live data views at the end; disposing before leaving the map, planted, fails 159 *(checked, A6)*. Links ended after their linger: 61,011 *(checked, B4)*.
- **Time travel.** 41,000 checks across a data-build change, 0 unequal; the plan's rule ("refuse a window that crosses the change") would have refused every position after the change, because the reader's snapshot was before it: 60,000 positions in the run, which the two-build reader answered exactly *(checked, B6, XB-12)*. That a past reader keeps a second store, about doubling memory, is *(reasoned)*.

**A view made inside a handler** ends when the call ends: the call is a data scope. A handler that wants a view kept across calls declares a `{ view }` *(checked, A6: 3,559 handler calls, each in a disposed scope; a handler's views not scoped, planted, leave views in 817 of 1,000 seeds)*.

---

## 6. Joins and log transforms

### 6.1 The one join: a lookup by key, kept live

`left.lookup(other, field)` gives, for each row of the left view, the row of resource `other` whose key is `row[field]`, as a frozen `{ row, other }`. It is many to one: many orders name one product. It stays live when either side changes (code in 3.7).

**How it works** *(picked here; built small, E-57 B4)*:
- **In data 5: `lookup(otherSource, field)`** over two data sources in one process, with a reverse index from the other side's key to the left rows that name it. A left change touches one joined row; a change of an other row touches the k left rows that name it. It is useful to data alone, with no network.
- **In fero: hold what the lookup names.** For each distinct key the left rows name, fero opens one link on `other.data[key]`, counted by how many left rows name it, ended after the linger when no row names it, and ended with the view. Those rows are then held on purpose, so the read rule holds (LENS 2.2). A new key costs one trip, from the one `lookup` line the user wrote: no hidden trips.
- **Three states.** `other` is `undefined` only while that key's first picture is on its way, `null` when there is no such row (after a picture or a remove), else the row. The plan had one `undefined` for both; a screen could not tell "loading" from "deleted product" (changed after the critic and XB-11).
- **No common cut.** Each side is in order on its own and never goes back, but `other` may lag behind the left side by as much as its link lags: the network, a copy that is behind, a failover. In B4 a key's records arrived 0 to 3 steps late *(checked, B4)*. Two resources are two clusters with no shared position (V5-2, V5-4), so this is the honest promise.

**Checked** *(E-57 B4, XB-11)*: 537,670 checks after every step on either side, 0 unequal; links equal the keys named after every step and 0 after the view ends; 97,836 trips, one per new key. Planted, each fails 1,000 of 1,000 seeds: the reverse index not moved on a field change; a link's count not released; a remove shown as `undefined`. **Cost** *(measured, B4)*: 2.9 to 3.9 µs a left change; a right change 1.9 to 3.3 µs when one left row names it, 6.3 to 9.4 at 10, 39 to 48 at 100; 161 B a left row.

**Where it may run.** Right of the live verb, or in a handler. Never left of the line, and never inside a `{ view }`: its answer would depend on two resources' positions while `seen`, frames and pictures carry one *(checked: tsc, section 12, item 20; E-57 XA-11)*.

### 6.2 Joins that are not supported

| Join | Why not | Instead |
|---|---|---|
| on a field that is not the other side's key | the other side would need a secondary index on every copy, kept on every fold, or a scan *(reasoned)* | later: a `lookup` into a resource re-keyed by that field with the record form with rows (3.4), when the field is unique; not covered in the first build (the view form holds one number per bucket, not rows) |
| many to many | one change can fan out without bound on both sides *(reasoned)* | two lookups through a link resource, or a method |
| at a common cut of two resources | two resources have no common position (V5-4) | one resource with `depth: 2`, so both kinds of row share a partition and a leader |
| durable, replayable, or read as a log | a live view has no log | not covered in the first build. Later, the record form with rows (3.4) can write joined rows on the left side's changes; following the other side needs a second deriver and a reverse index, which is not designed |
| below a partition (class B) | the other side's rows are not in the partition | — |
| inside a served view | its positions cover one resource | a handler that joins once, or a derived resource |

No version of fero designed a join before *(checked by the ground study: a search of the records)*. This plan keeps one kind because screens need it most and it costs O(1) per left change. It leaves the general kinds out rather than add a join engine.

### 6.3 Transforms of the log

- **Live state and the log differ on purpose** (decided, API 3.10). A slow live reader is folded to one change per row; `changes()` gives every record, in order. A count of events needs `changes()`.
- **A consumer's map or filter runs in its own loop** (code in 3.6). Every record of the selection crosses once (API P-07, streams and replay).
- **A filtered or reshaped log for many consumers is a derived resource's log**, written by the record form. Its readers get their own per-slot cursors, history, resume and `past`. This is the shape stream processors use (*from memory*: Kafka Streams writes to topics), with fero's mark in place of a transaction (E-30).
- **A filter on row content needs the row, and the record form sees records** (stated after the skeptic). In the first build `fn` gets only `e`, and `e.value` is set only for a whole-row write. Take an order whose `cents` goes from 50 to 150 by a field write: `e.value` is unset, so a filter on `e.value.cents` never lets it in, and a remove never takes it out. So a content filter by the record form is exact only for a source written by whole-row writes. For any source it needs the record form with rows (later, 3.4). This is the same fact that rules out a server-side filter, next. Nothing in E-57 ran a log transform; B5 checked the mark only.
- **Which log is an event log.** The record form's target log is one: one output per source record, once. The view form's target log is a log of **states**: it holds each restart's difference, so a consumer that counts records there miscounts *(reasoned; changed after the critic)*.
- **No server-side filter of the log by row content** *(picked here; reasoned)*. A field write's record carries only the field, not the row: `e.value` is set only for whole-row writes (API 3.10). To test "is this order over 100", a copy would need the row as it was at that record's position, and a copy has rows only at its current position. A cheap filter by a record's key path could come later with class B.
- **Old records** go through `shape.up` upcasters, and `migrate` runs at a stated pace (decided, API P-20: changing the shape of rows).

### 6.4 Windows over time

- **A tumbling window is a bucket over a time field**: `by('at', { step: 60_000 }).length()` counts rows per minute (code in 3.3). It is a view over rows, so a row written late lands in its own minute *(reasoned)*. The row must carry its time as a field.
- **Old windows go when their rows expire** (`rows: { ttl }`, API P-02: rows with an expiry); an emptied bucket goes (C5).
- **Counting events that are not kept as rows** (requests per minute from a log) is the record form: `op.incr` into a resource keyed by minute, with `{ from: e }`.
- **Not covered**: sliding, hopping and session windows, and watermarks for late records (section 10).

---

## 7. What was validated

E-57 built the plan small on data's real engine (data 4.0.0 at `63fea66`, read only): group A on E-55's prototype, about 2,000 lines; group B on data's public API, about 2,800 lines ([E-57's README](experiments/E57-transforms/README.md); [group A](experiments/E57-transforms/a-served/README.md); [group B](experiments/E57-transforms/b-merge/README.md)). **Method, for every claim:** after every frame, picture, entry, commit, step or idle point, the live answer was compared with the same query run from scratch on the true rows by code that does not use data; 1,000 seeds, faults drawn from the seed; at least one planted bug, which must fail at least 100 of 1,000 seeds; timed numbers three runs, each process alone under the timing lock (load averages 1.00 to 2.87 at process start). On the final code every seeded run had 0 unequal, 0 back in time, 0 doubled and 0 missed; the one bar that failed in seeded runs is XA-2's refusals of held views. Every planted bug failed 159 to 1,000 of 1,000 seeds *(checked)*. After the skeptic, five more XA-2 runs, a like-for-like B3 count, two timed page-index benches and the probes the page cites were added to E-57; each is marked so below.

**Group A: served views and pushdown.** Results: [sims.jsonl](experiments/E57-transforms/a-served/results/sims.jsonl), [mutants.jsonl](experiments/E57-transforms/a-served/results/mutants.jsonl), [timing.jsonl](experiments/E57-transforms/a-served/results/timing.jsonl), [types.jsonl](experiments/E57-transforms/a-served/results/types.jsonl), [summary.md](experiments/E57-transforms/a-served/results/summary.md).

| Claim | Bar | Result | Verdict |
|---|---|---|---|
| A1: a served view, end to end | 0 unequal for a window, buckets, a scalar and a page; one encode per change with 1 and 1,000 subscribers | 144,843 checks, 0 unequal; 288 encodes for 288,000 sends; a keyed copy without order, planted: 999 | pass |
| A2: resume | 0 doubled, missed, unequal, back in time over 4,000+ disconnects | 12,870 disconnects, 6,166 ring resumes, 5,909 pictures: 0; planted 329 and 425 | pass |
| A3: failover | 0 unequal, 0 back in time, a kill in every seed | 5,371 kills, 22,040 pictures: 0; planted 895 and 799 | pass; a leader change is not invisible with voters only |
| A4: sharing, `allow`, no caller | builds = distinct keys; 0 frames to a refused caller | 25 builds for 2,000 subscribers over 25 keys; 3,188 denials, 0 frames; planted 163 and 355 | pass |
| A5: caps and bounds | each refusal exactly when an independent count says | 28,211 admissions, 0 mismatches; a real bug found and fixed first; planted 417 and 645 | pass, after the fix |
| A6: linger, dispose order, handler views | 0 rebuilds in the linger; 0 calls after dispose; 0 views left | all 0; planted 159 and 817 | pass |
| A7: class B through resumes and the fallback | 0 unequal; 1,000+ resumes; 100+ fallbacks | 79,209 checks, 0 unequal; 4,554 fallbacks; planted 961 and 613 | pass |
| A8: a redeploy | 0 frames from an old version | 1,365 entries ended `redeployed`, 0 old frames; planted 765 | pass |
| XA-1: builds do not stall; no leader serves | stall ≤ 50 ms (a guess) at 1e6 rows; 0 views on a leader | 0 on a leader (planted: 1,000); stalls 0.49 to 1.9 s in one block, 0.21 to 0.24 s sliced, at 1e6 | **miss** at 1e6 |
| XA-2: one copy per view; failover refuses no holder | builds = keys; 0 holders refused | 50 for 50; **1 holder refused in 1,000 seeds** after two failures; planted 811 and 925. After the skeptic, with the headroom rule: 21 of 1,000 with leader kills (xa2l); with one and two standbys, 377 and 36 when standbys serve first (xa2sb, xa2s2), **6 and 5** when every copy but the leader serves (xa2sbx, xa2s2x); the first formula, planted, 841 | **miss** (5 to 21 of 1,000 in the configurations kept) |
| XA-3: an instance is unique across copies | 0 frames from another instance | 0; planted 319 | pass |
| XA-4: a picture is one commit of differences | one call; previous + diff = new | 0 violations; planted 969 | pass |
| XA-5: `c` carries order changes | a list rebuilt from `c` alone is right | 0 unequal; planted 981 | pass |
| XA-6: operators right of a served ordered view keep its order | `map`, `filter` after `best(10)` in order | 0 over 37,076 and 68,296 checks; planted 958 | pass |
| XA-7: pages share one index | ≤ 1 index for 1,000 reads; 0 refusals | 1 index, 0 refused; one entry per cursor refused from the 17th read. After the skeptic: the index costs every write, 29 to 33 µs at 1e4 rows (pagecost) | pass on reads; the write cost is a finding (3.2) |
| XA-8: purity matters | an impure view differs after failover in 100+ seeds | 822 of 1,000; control 0 | pass |
| XA-9: the cap bounds cost | refusals equal an independent cost sum | 0 mismatches; planted 363 | pass, on guessed cost classes |
| XA-10: a rolling deploy never goes back | 0 v1 after v2; `stale-client` | 0 over 3,000 deploys; first run failed 15 of 1,000 before the client floor; planted 202 | pass, with the client floor |
| XA-11: a view over two resources is refused | tsc refuses it | refused (TS2339 on `lookup`, `use`, `claims`) | pass (types only) |
| XA-12: `view-too-big` does not loop | built at most once per deploy | 1,641 ends, 0 rebuilds; planted 833 | pass |
| XA-13: read-your-writes through `SYNC` | the answer is at or past the write | 1,965, 0 early; planted 934 | pass |
| XA-14: the view selector model-checked | E-31's bounds | — | **not run** |

**Group B: across partitions, resources and time.** Results: [b1.jsonl](experiments/E57-transforms/b-merge/results/b1.jsonl), [b1-seeds.jsonl](experiments/E57-transforms/b-merge/results/b1-seeds.jsonl), [b2.jsonl](experiments/E57-transforms/b-merge/results/b2.jsonl), [b3.jsonl](experiments/E57-transforms/b-merge/results/b3.jsonl), [b4.jsonl](experiments/E57-transforms/b-merge/results/b4.jsonl), [b5-model.txt](experiments/E57-transforms/b-merge/results/b5-model.txt), [b6.jsonl](experiments/E57-transforms/b-merge/results/b6.jsonl), [xb.jsonl](experiments/E57-transforms/b-merge/results/xb.jsonl), [timing.jsonl](experiments/E57-transforms/b-merge/results/timing.jsonl).

| Claim | Bar | Result | Verdict |
|---|---|---|---|
| B1: one store fed by slot | 0 mismatches over 1e5 commits for 1, 4, 16 and elastic groups; 1,000+ moves | 19,167,410 checks, 0; 6,122 moves; planted 685 to 1,000 | pass (one group has no moves) |
| B2: the new operators | 0 mismatches, value domain 10; page joins equal | 4,085,362 checks, 0; 99,435 page walks equal; planted 1,000 and 278 | pass |
| B3: `derive`'s view form converges | 0 unequal at idle; 0 stale writes | **as planned: 514 of 1,000 seeds fail** on the fixed design's bar (unequal 28, older code 452), 796 when every stale write counts; with bump, barrier and code version: 0 | **miss as planned**; pass with the fixes |
| B4: a live lookup | 0 unequal; links = keys named | 537,670 checks, 0; planted 1,000 each | pass |
| B5: the mark carries the write number | every bound; planted gives a counterexample | 12 of 12 bounds; planted and the order rule dropped each lose an output | pass; full ablation not run |
| B6: views of the past | 0 unequal; one call a step | 41,000 checks, 0; planted 1,000, 1,000, 995 | pass, with XB-12's rule |
| XB-1: an O(log N) leaderboard index | ≤ 3 µs a sort-field write at 1e6 (a guess) | 9.5 to 15.1 µs (today 1,305 to 1,385); batches 6.2 to 7.5; build 0.69 to 0.80 s (today 3.40 to 3.59); exact | **miss** on cost at 1e6 |
| XB-2: the total order per direction | no non-number in a window while ten numbers exist | 979,098 checks, 0; planted 1,000 and 1,000 | pass |
| XB-3: one numeric projection | six aggregates equal one pure query | 1,200,000 checks, 0; data's own `sum`, planted, 1,000. `min` and `max` ran behind a numbers-only filter, so data's own (arrival-dependent) were not tested | pass |
| XB-4: the exact sum over every finite double | 0 mismatches; ≤ 2 times E-23's cost | 1,000,000 checks, 0; 8 of 8 edges; 0.88 to 1.22 times; E-23's sum, planted, 992 | pass |
| XB-5: typed keys, SameValueZero | `by`, `eq` equal the typed rule | 1,800,000 checks, 0; planted 1,000 | pass |
| XB-6: depth 2 by (partition, row) | ties and pages by key path | 400,000 checks, 0; planted 1,000 | pass |
| XB-7: paging across cuts | each unchanged row seen once | 984,927 rows, each once; planted 1,000 | pass |
| XB-8: the bump | 0 stale writes after a takeover | 0 after the bump reached a group; 1,389 before it, all repaired; planted 898 | pass as restated |
| XB-9: the read barrier | 0 step-backs | 0; planted 995 | pass |
| XB-10: no older code | never v1 after v2 | 0; planted 225 | pass |
| XB-11: loading against none | `undefined` only while loading | 0 failures; planted 1,000 | pass |
| XB-12: past views across a data build change | equal the live fold with both builds | 0 unequal; 94,323 positions right; planted 995 | pass; the 1e5-row seek not run |
| XB-13: `limit` over a sorted parent | equals `za(field, n)` | 200,000 checks, 0; data's `limit` today 1,000 | pass for the prototype; data must change |

**What missed, and what the plan does about it.**
- **XA-1, builds stall a copy.** The plan now never builds on a leader, paces builds, and asks data 5 for a resumable key iterator and views built in slices (D9). Until then, an ordered `{ view }` over more than 5,000 rows, or a `{ pages }` over more than 2,000, ends `view-too-big` at build.
- **XA-2, headroom does not cover every failure.** The plan now says so: a held view may be refused, rarely, while copies come and go. After the skeptic it also places views on every copy but the leader, and keeps no headroom when one copy serves. Counting live views across every serving copy against what the survivors can hold would cover more; it is not taken (more rules, a shared count).
- **XB-1, the chunked index misses its guessed 3 µs at 1e6 rows.** It is still 86 to 146 times cheaper than today. The plan counts about 10 to 15 µs a sort-field write at 1e6 until a cache-friendly layout reaches the bar; the next thing to try is each chunk's values in a `Float64Array` *(reasoned)*.
- **B3, the view form as planned.** It now takes the bump, the barrier read after the bumps, a silent fold to it, and the code version in the lock row.
- **Not run:** XA-14 (the `view` selector in E-31's model) and B5's full ablation.

**What else changed from the first plan**, each because a claim or the critic showed it: eight served-view rules (3.8); placement on one copy by hash, off the leader; pages on one shared index; `c.order` at the sink and an ordered mirror; a version per method and a client floor; `SYNC`; a cost-weighted cap of 64; `group` and `distinct` not allowed in a `{ view }`; `lookup` refused inside a `{ view }` and given three states; R2 kept per (slot, importing group); the total order per direction; one numeric projection for aggregates and range filters; the exact sum widened to every finite double; typed keys; (partition, row) at depth 2; `limit` over a sorted parent as a window; the past folded per build; the mark with the write number; D8c counted at 10 to 15 µs, not "a few". **After the skeptic:** every copy but the leader serves (not standbys first); headroom by the number of serving copies; the page index's write cost and its own row guard, and the window guard lowered to 5,000 rows; the data build in served keys and lock rows; a declared method version; the record form's limit, and its form with rows (later); bucket answers as a `Map`; range filters typed as numbers; `derive`'s rollback rule and its only writer; the mark's packing limits.

---

## 8. Costs and rules

### 8.1 What each place costs

All *(measured)* from E-57 unless named; prototype operators are the prototype's costs.

| Place | Per change | Memory | Bytes on the wire |
|---|---|---|---|
| P1, a filter here | about 1 µs per view that takes the row; 0.09 to 0.18 µs per view that rejects it *(E-05)* | +31 to 46 B a row for 100 filters *(E-05)* | the partition's frames: about 60 B a change *(E-55 claim 16)* |
| P1, an ordered window here | 1.6 to 62 µs, growing with the partition *(E-55 claim 16)* | an index entry per row | as above |
| P2, a served leaderboard (data today) | 5.7 to 6.7 µs at 1e3 rows, 12.2 to 15.7 at 5,000, 17.4 to 20.6 at 1e4, 134 to 155 at 1e5 (two sessions) | 1.1 MB at 1e4, 9.1 MB at 1e5 | 135 to 137 B a frame, only when the top changes |
| P2, a served bucket or sum view | 1.8 to 4.9 µs, flat from 1e3 to 1e5 (a frame on every write) | 118 to 399 B a bucket | 56 to 66 B a frame |
| P2, one more subscriber | 2.0 to 2.1 µs to join, plus 4.4 to 5.2 µs to encode its picture | 496 B | its picture: 87 B to 1.8 KB |
| P2, `{ pages }`' shared index, on every write while it lives (data today) | 8.3 to 9.1 µs at 1e3 rows, 18.7 to 19.5 at 5,000, 29 to 33 at 1e4, 509 to 525 at 1e5 (pagecost, after the skeptic); D8c's index: 1.7 to 2.4 at 1e4, 3.8 to 5.1 at 1e5, 9.7 to 11.2 at 1e6 (pageindex-cost) | an index of every row | — |
| P2, a page read | 10 to 16 µs | 32 B | one page |
| P2, a build at 1e6 rows | 0.49 to 1.9 s of one thread today | — | — |
| P3, class B | 1.2 to 3.2 µs per shape on the copy | per shape | 0.1 to 28 B against 108 to 113 B for class A |
| P4, the view form | the view's cost, plus 0.748 target writes per source commit; a restart 48.7 to 51.8 ms at 1e5 rows | the view | the target's frames |
| P4, the record form | one run of `fn` and a share of a commit per record | 29 B a mark | the target's frames |
| P5, the store fed by slot | +0.31 to 0.61 µs a record; an R2 difference about 2 µs a row, once per move | one store | — |
| the join | 2.9 to 3.9 µs a left change; about 0.4 µs per joined row on a right change | 161 B a left row | each named row's partition, once |
| P7, the past | a step 17.9 to 32.1 µs on 1e4 rows with 1 to 10 views; a seek 3 to 5 µs per differing row | a second store *(reasoned)* | one log SUB |

### 8.2 The write budget: how many served views a copy can keep

Every live served view sees every write to its resource *(reasoned)*.
- **The budget.** PERF-09 asks for at least 50,000 persisted appends a second per process: on one core that leaves **20 µs a write** for everything *(arithmetic)*. The fold alone is 0.63 to 1.5 µs at 1e3 to 1e5 rows *(measured, A1)*, and decoding a record about 0.7 µs *(measured, E-03: 712 ns)*. That leaves about 18 µs for views.
- **Bucket and sum views:** 1.8 to 4.9 µs each with their frame, so **about 3 to 10 per copy** fit *(arithmetic)*. A frame per batch of writes, not per write, would cut the encode share; v5 folds a batch per lane call (LAYERS 3.4) *(reasoned; not measured here)*.
- **Leaderboards:** **none** at 1e5 rows on today's data (134 to 155 µs each), and at 1e4 rows one takes the whole 18 µs (17.4 to 20.6; the skeptic's session 20.6 to 21.9); **one** at 5,000 rows (12.2 to 15.7 µs). With a chunked index, 3.0 to 4.6 µs at 1e5 rows, so about 4 to 6 fit; at 1e6 rows, 9.5 to 15.1 µs, so **one** *(arithmetic on measured costs)*.
- **A `{ pages }` index:** dearer than a leaderboard on today's data: one fits at 1,000 rows (8.3 to 9.1 µs), none at 5,000 (18.7 to 19.5). With D8c's index, 3.8 to 5.1 µs at 1e5 rows *(arithmetic on measured costs, after the skeptic)*.
- **So** *(picked here)*: class C is for **a few shared views per resource** (a leaderboard, totals per team, a page of the newest), not a query per user. The cap is weighted by cost (3.8), its default count is 64 as a memory guard, health warns when the served views of a resource cost more than half the budget, and ordered served views and `{ pages }` over more than a few thousand rows wait for D8c (3.8's row guards). A query per user over every row is a page over a partition, a derived resource keyed for it, or a method that answers once.
- **Where the views run changes who pays.** Off the leader, a view that is too dear slows its copy's fold, not the writers; that copy's served views then lag *(reasoned)*. That is better than stalling writes, but it is not free.

### 8.3 Builder rules, by SIMPLICITY's measure

A rule counts when a builder must write it and getting it wrong breaks a stated property (SIMPLICITY 1.2). Every count is *(reasoned)*. data's own operator rules stay outside fero's count, as SIMPLICITY treats data. Rows LENS 4.4 already counts are not counted again.

| Rule (first build) | + | Guards | Where it came from |
|---|---|---|---|
| served-view entries: one per (method, canonical argument, method version, data build) per copy; no caller in a `{ view }`, `allow` on every SUB; `views.rows` per commit; linger, then leave the map, then dispose; a new method version ends old entries; builds paced | 6 (5 to 8) | sharing; no leak between users; memory; no disposed view served; no mixed code | the plan |
| the order channel in frames and pictures | 1 (1 to 2) | an ordered view's answer | the plan; E-55 claim 17 |
| `c.order` at the sink, and an ordered mirror for operators right of a served view | 1 | a screen patched from `c` keeps the order | the critic; XA-5, XA-6 |
| the line, per call: left of the live verb only what data 5 marks plain and mergeable | 0 (0 to 1) | code never travels | the plan |
| `derive`'s view form: write the whole difference, every write fenced | 1 (1 to 2) | the target converges | the plan |
| the link manager behind `lookup`, on top of data's N5: one link per key named, opened, counted, lingered and ended | 1 (1 to 3) | no leaked or missing links; no hidden trips | the plan; counted after the skeptic |
| placement: one copy by hash over every copy but the leader; headroom `views.max / k` with k of 2 or more serving copies, none with one | 1 to 2 | one build per view; failover mostly fits | the critic; XA-1, XA-2; changed after the skeptic (xa2sb, xa2sbx) |
| the cap weighted by cost: data 5's cost classes summed per copy, refused by cost | 1 (1 to 2) | a bound on cost, not only on count | XA-9; counted after the skeptic |
| `PAGE { after, seen }`: the wait for `seen`, the shared index's build, linger and place | 1 (1 to 2) | a walk never goes back; one index | XA-7; added after the skeptic |
| the row guards until D8c: 5,000 rows for an ordered view, 2,000 for pages | 1 (0 to 1) | the write budget | pagecost, after the skeptic |
| the data build in served keys, lock rows and the client's floor | 1 (1 to 2) | no old build's answer after a new one's | the skeptic *(reasoned; not run)* |
| `derive`'s view form: only the deriver writes the target; a rollback resets the lock row's version; `bucket-collision` | 1 (1 to 3) | the target converges; it never stops in silence | the skeptic *(reasoned; not run)* |
| the mark's packing limits: `too-many-outputs`; the pair form past 2^45 | 0 to 1 | no output lost | the skeptic *(arithmetic)* |
| an instance unique across copies | 0 to 1 | no frame of another view | XA-3 |
| a new picture is one commit of differences | 1 | sinks that count do not double count | XA-4 |
| a version per method and a client floor | 1 | never back to older code | XA-10 |
| `derive`: the bump at every target group | 1 | stale writes refused | XB-8 |
| `derive`: the read barrier, read after the bumps, folded silently | 1 | no step back | XB-9 |
| `derive`: never take over from newer code | 0 to 1 | never back to older code | XB-10 |
| builds in slices; no hidden build in `get()` | 1 | no long stall | XA-1 |
| `view-too-big` stays until the code changes | 0 to 1 | no rebuild loop | XA-12 |
| pages read one shared index, no entry per cursor | 0 to 1 | memory; no refusals while paging | XA-7 |
| `SYNC` for read-your-writes | 0 to 1 | "my score is in the leaderboard" | XA-13 |
| a resume answer carries its ring frames | 1 | no frame out of turn | found by A7 |
| a frame goes to every selection on its instance | 1 | no lost frame | found by A7 |
| refinements: a frame's position before its sink; a reused entry moves no count; joins count; a holder may evict lingering entries; an empty aggregate is "no value"; `lookup`'s three states | 0 to 3 | counts, caps, the codec | found by A1, A5, A7, XA-2, XB-11 |
| **first build** | **about 26 (21 to 45)** | about 6.3 % of 416 | |
| later: R0, R1, R2 (groups per resource) | 2 (1 to 4) | a slot move never doubles or drops rows | B1 |
| later: the past folded per data build | 1 (1 to 2) | a past view across a data upgrade | XB-12 |
| later: class B (LENS's +5 less the order channel counted above) | 4 (3 to 6) | pushdown | A7 |
| owed: the `view` selector in E-31's model | 4 to 6, perhaps more | never back in time; no doubled or missed frame | XA-14, not run |

- **Against the base:** about +26 on 416 is about 6.3 % *(arithmetic)*. With LENS's +12 to +18 for the lens and the owed `view` selector (4 to 6), transformations and the lens together come to about +37 to +69 over the base *(arithmetic on reasoned counts)*.
- **What does not come back:** the gather, its claims, parking, coverage, attestation and spoke feeds. They were never in the 416, and v4 spent its largest review effort on them. E-23's merger is not built.
- **The plan said +8 for the first build.** The critic's findings and the build's own failures more than doubled it, and the skeptic's review added about 7 more, so it is now about three times the plan's. Each added rule came from a planted bug the oracle caught, a seeded run that failed until the rule was added, the critic's or the skeptic's reasoning; the last column says which.

### 8.4 User rules

Ten things a user must know *(picked here; reasoned)*:
1. **Left of the live verb: plain data whose answer depends on the rows only.** No functions, no `lookup`, and no `limit` or `reverse` (write `za(field, n)`). Your code goes right of it.
2. **Over every row, a client asks for a view the server named.** It is bounded and capped, and it cannot see who called: pass the user as the argument and check it in `allow`.
3. **A served view depends on its argument and the rows only**: no clock, no random number, no module state.
4. **Views agree as values, not as bytes**, and a view over several groups is defined at a cut.
5. **`derive` has two forms.** The view form keeps a resource equal to a view of the rows and needs no history; its log is a log of states. The record form counts each record once and needs the source's history.
6. **A `lookup` holds the rows it names and has no common cut**: `other` may lag behind the left side by as much as its link lags, and each side never goes back; `undefined` while loading, `null` when there is none.
7. **A served view can be refused by a cap**, also after failures when copies are short.
8. **Pages are exact within one cut.** Across fetches, a row whose sort value changed may show twice or not at all.
9. **`limit` and `reverse` over unordered rows follow this process's arrival order.** Over a sorted parent, `limit(n)` is the first n.
10. **The record form sees records, not rows.** A filter on row content in its `fn` is exact only when the source is written by whole-row writes, until the record form with rows comes.

The plan had five; the critic added four (3, 7, 8, 9), and the skeptic one (10). The read barrier removed one clause from the rule on `derive`: "the target may step back once" is no longer true.

---

## 9. data: what must change, and the answer

### 9.1 The list

"Breaking" means an app or fero sees a different API or a different answer, or loses a name: a new operator name is reserved, so a row or field of that name is no longer reachable by property access, only by `get(key)` (data's own rule: "new operators may only claim new names in a major", *checked: data contract/index.ts*). Sizes are lines of engine code written or changed, not counting tests, and all are *(a guess)*, made against data's line counts: ops 4,548, kernel 1,456, contract 262, api 640, seam 793, tests excluded, **7,699 in all** *(checked: wc at `63fea66`)*. "Evidence" says what showed the need.

| # | Change | Breaking? | Size | Evidence |
|---|---|---|---|---|
| D1 | path subscriptions through a keyed index | no | 200 to 400 | LENS 4.5; E-55 claim 8 |
| D2 | the handle becomes the lens: callable steps, `at()`, `get()`; READS's `live`, `on`, `past` | **yes** | 500 to 1,000: a rewrite of the handle layer | LENS 4.5; READS 7 |
| D3 | two-level stores and operators at a partition; whole-resource views at depth 2 keyed, tied and paged by (partition, row) | new for depth 2 | 850 to 1,650, the largest | LENS 4.5; E-55 claim 19; E-57 XB-6 |
| D4 | one sink shape by reference: `(value, c)` with `c.diff`, and `c.order` for ordered views | **yes** | 200 to 400 | LENS 4.5; E-57 XA-5 |
| D5 | weak `connect` | dropped (READS) | 0 | READS 7 |
| D6 | views belong to the scope or handle they were made in | **yes** | 150 to 300 | E-55 claim 26; E-57 A6 |
| D7 | operator chains as plain data, with the order channel on the wire | no | 200 to 400 | E-55 claim 17; E-57 A7 |
| D8a | the lazy freeze, for rows handed to sinks too | no | 100 to 200 | LENS 4.5 |
| D8b | `group` emits per-row deltas into a bucket | **yes** | 200 to 400 | E-05; E-57 B2 |
| D8c | an ordered index in O(log N), for single writes **and** the batch path, with a cache-friendly layout; it also serves a page reader with no window | no | 500 to 1,000: a rewrite of the ordered index | the critic's probe ([ordcost](experiments/E57-transforms/probes/ordcost.jsonl)); E-57 A1, XA-1, XB-1, pagecost |
| D9 | every view builds resumably, in slices (bucket, sum and filter views too, not only the ordered index), with a stated readiness rule: a view is not equal to its query until its build ends, a SCHEDULE clause and perhaps a `ready` state (added after the skeptic) | **yes**: a view made today is complete at once | 300 to 600 | E-57 XA-1 (the sliced bucket and sum builds were the prototype's own nodes, not data's) |
| C1 | ties by row key, in UTF-16 code units | **yes** | 20 to 50 | E-23; E-57 A3, B1, XB-2 |
| C2 | one total order per direction: `za` is numbers descending, then the rest in `az`'s order | **yes** | 50 to 100 | E-23; E-57 XB-2 |
| C3 | an exact sum over every finite double (a wide path near the limit), `-0` kept, `NaN` and the infinities counted apart | **yes** | 200 to 400 | E-23; the critic's probe; E-57 XB-4 |
| C4 | `distinct` keeps the smallest key's value | **yes** | 30 to 60 | E-23 |
| C5 | buckets drop when empty | **yes** | 10 to 30 | E-23; E-57 B2 |
| C6 | each call states whether it is plain data, its merge class and its cost class, in `exportContract()` | no | 80 to 230 | E-23; E-57 XA-9 |
| C7 | `limit` and `reverse` over unordered rows marked "arrival"; `limit` over a sorted parent reads its order | **yes** | 30 to 60 | the critic's probe; E-57 XB-13 |
| C8 | `top(n)` over object rows throws | **yes** | 10 to 20 | the ground probe |
| C9 | one numeric projection for `sum`, `avg`, `min`, `max`, quantiles, buckets with a step, and the range filters `gt`, `gte`, `lt`, `lte`, `between` | **yes** (for `min` and `max` too: today they keep any non-null value) | 70 to 150 | E-57 XB-3; data ops/rowops.ts:279; [maxprobe.out](experiments/E57-transforms/probes/maxprobe.out) |
| C10 | typed bucket keys and SameValueZero for `by`, `eq`, `in`, `distinct` | **yes** | 50 to 100 | E-57 XB-5 |
| N1 | `eq`, `in` | **yes**: two new reserved names | 50 to 100 | E-57 B2 |
| N2 | `by(field, { step })` with one aggregate per bucket; the answer a `Map` with typed keys | **yes**: a new reserved name | 250 to 450 | E-57 B2, XB-5 |
| N3 | the field forms of `group`, `distinct`, `some`, `every` as plain data | no | 50 to 100 | E-57 B2 |
| N4 | `az`/`za(field, n, { after })` and a page reader over one shared ordered node | no | 300 to 600 | E-57 B2, XA-7 |
| N5 | `lookup(otherSource, field)` with a reverse index (or under the name `join`, which data already reserves with no operator behind it, so that name breaks nothing) | **yes** as `lookup`: a new reserved name | 250 to 500 | E-57 B4 |
| N6 | export the exact build id, for `fold-version` | no | 10 to 30 | E-43; E-57 B6 |
| N7 | a version tag on each diff entry (READS's `c.diff`) | no | 50 to 150 | READS 2.1 |
| N8 | an ordered mirror source that applies wire records with `at` and `move` and hands its order to the operators after it | no | 150 to 300 | E-57 XA-6 |
| N9 | a resumable key iterator | no | 50 to 150 | E-57 XA-1 |
| F1 | `distinct()` folds object rows into one bucket | **yes** | 30 to 60 | the ground probe (I-37) |
| F2 | the 3-argument `reduce` shares an object `init` across views | **yes** | 30 to 60 | the ground probe (I-38) |
| F3 | `package.json` must list the source operator modules as having side effects, or a bundle of the source drops `group`, the set operators and the quantiles | no | a line | E-57 group B |
| V1 | publish SCHEDULE_VERSION 5 (fero v4 needs it), then the contract's bump, in both repos | **yes** | — | E-23; E-43 |

**What data does not need** *(reasoned)*: no Rust, no hash tree and no version structure (E-54), no expression language, no join engine beyond `lookup`, and no distributed merger.

**Order of work.** D1 and D2 first, then D3 and D4 (V5-12 pick 9). Then the contract (C1 to C10) with its SCHEDULE clause and bump, D6 and D7, since served views and the line need them. Then D8 (the deltas, the index), D9 with N9 (sliced builds), N1 to N8, F1 to F3. Each step is useful to data alone, as LENS 4.5 asks.

### 9.2 The answer to the owner

**Does data need a new version? Yes: data 5.0.0, a new major version, in TypeScript.**
- **Why a major.** 20 of the 33 changes to build are breaking: the handle, the sink, view lifetimes, `group`'s emission, nine contract rules that change answers (ties, the order, sums, `distinct`, empty buckets, `limit`, `top`, the numeric projection, typed keys), new reserved names (`eq`, `in`, `by`, `lookup`), views that become ready only after their slices, two faults, and the version. Under semver that is a major *(reasoned)*. The contract also needs a SCHEDULE_VERSION bump in both repos.
- **How big.** About **5,000 to 10,000 lines** written or changed *(a guess; the sizes above sum to 4,970 to 10,050, and some overlap)*, against an engine of 7,699 lines *(checked)*, plus tests: 65 % to 131 % of the engine *(arithmetic)*. By lines, data 5 may touch as much code as the engine has.
- **Is any of it a rewrite?** **What stays is the model, not the lines.** The keyed model, the commit schedule (SCHEDULE's clauses) and most operators' incremental logic stay *(reasoned)*. The evidence: E-57 built every piece in JavaScript, beside data 4 and without changing it (the contract, the new operators, the exact sum, the chunked index, the store fed by slot, `lookup`), and each was exact *(checked)*. It used data's public API **and some kernel internals** (said plainly after the skeptic): group A's copy imports `kernel/scope.ts` (`scope`, `runInScope`) and `kernel/node.ts` (`SourceNode`), group B bundles `SourceNode` and `leafAt`, and the page index reads `currentOrder()` and `rowAt()`, methods of a class data exports only for its devtools *(checked: E-57 sources; data api/index.ts)*. One piece could not be built from outside at all: `best(10)`'s index cannot be sliced (XA-1), and views built in slices are not built (D9). **Three parts are rewrites in the small:** the handle layer (D2), the ordered index (D8c) and the store's two-level form (D3). data was rewritten once already, when v3 replaced positions with keys *(checked by the ground study: data's git log)*; nothing here undoes that.
- **Rust? No.** The evidence, in order:
  - **E-03** *(measured)*: handing a 256-record batch from Rust to data's JavaScript fold costs under 1 ns a record for the crossing, but Rust building the record objects through napi costs 888 ns a record, more than JavaScript's own decode at 712 ns. "Hand bytes, decode in JS." A row must stay a plain JavaScript object.
  - **E-04** *(measured)*: a Rust kernel in WASM met the simulator's bar with every applied entry folded by data's hot lane in JavaScript. It is about the kernel, and it shows data staying in JavaScript beside a native core.
  - **E-54** *(measured)*, finding 6: "Rust does not change the choice." With rows shared as in Node, a plain Rust `HashMap` fold costs 0.64 to 0.85 µs a write, against Node's 0.79 to 1.4 µs: about the same.
  - **LENS 4.5** *(reasoned)*: "None of this needs it." A user's function is JavaScript.
  - **VERDICT RR-17** (a design rule): a native core, when it comes, holds only L0 and L1 (the journal, Raft and the log) and never folds rows.
  - **V5-12 pick 9** (decided): "data's changes start now, in TypeScript … Rust stays for L0 and L1."
  - **E-57** *(measured)*: today's ordered index moves memory on every insert, O(N): 1.3 ms a write at 1e6 rows. The chunked index fixes the algorithm in JavaScript (86 to 146 times cheaper). What remains, 9.5 to 15.1 µs, looks like memory layout *(reasoned, not isolated)*. Layout is what native code controls best, so this is the one place Rust could help. But a typed-array layout in TypeScript (each chunk's sort values in a `Float64Array`) may fix it too, and it was not tried. And a native index would have to copy each sort key out of a JavaScript row on every write, the crossing E-03 priced *(reasoned)*. So the answer stands on E-03, LENS 4.5, RR-17 and V5-12, not on this item.
- **What the line of the live verb keeps open.** What stands left of it is plain data only, so a native engine for served views could come later without calling back into JavaScript (LENS 4.5), if it passes DATA-09's differential test against data (the requirement that a native kernel keep data's results), with keys whose UTF-16 and byte orders differ in its inputs (E-04's guard caught two twins sorting keys in those two orders in 523 of 1,000 seeds).

---

## 10. What is not covered or not known, and what would settle it

| # | Left out or not known | Why | What would settle it |
|---|---|---|---|
| 1 | **A resource larger than one server's memory** | no process can hold every slot, so R0 fails; E-23's merger and its four rules are the design; quantiles, `limit`, `reverse` and `reduce` would need one process folding every group | a design for SC-06 (state larger than one server); E-23's merger built |
| 2 | **The `view` selector in E-31's model** (XA-14) | it adds instances, a second resume form, the wait for `seen` and a terminal `END` to a model that has none; the seeded runs are not a proof | E-31's model extended, every bound, ablation, 90 % of mutants caught |
| 3 | **Real network, Raft and threads** | E-57 ran in one process: logs are lists, links are queues, time is steps | the first build's own seeded tier on real sockets |
| 4 | **Ordered served views and pages over big resources** | the chunked index reaches 9.5 to 15.1 µs at 1e6 rows, not 3; builds stall until data builds in slices | D8c with a typed-array layout, timed on E-57's grid; N9 and D9's sliced builds |
| 5 | **Held views while copies come and go** | held views were refused in 1 to 21 of 1,000 seeds (XA-2 and its reruns); the traced ones came when copies came back in bulk | a count of live views across serving copies, if owners need the promise; a run where copies come back one at a time |
| 6 | **The cost classes the cap weighs by** | XA-9 passed on guessed classes | data 5's cost class per call, timed |
| 7 | **How a typed client knows the shape it was compiled for** (`stale-client`) | `import type` carries no value at run time; E-57 simulated the client's version | a declared method version the client imports as a value, or a build step |
| 8 | **`lookup`'s cost on the other side** | its copies hold one selection per (client, key): 10,000 clients naming 50 keys each is 500,000 selections *(arithmetic)*; no cap is designed | a per-client link cap, measured |
| 9 | **The store fed by slot together with `derive`** | B3's source had one group; B1 had no deriver | B3 on B1's store |
| 10 | **R0 when groups heal apart** | a server missing a group holds it as `hold: 'all'`; nobody measured that | B1's cost run with a server missing one group |
| 11 | **Two real data builds for past views** | B6 used a stand-in (one record kind folded two ways) | B6 on two real data versions, as E-43 had |
| 12 | **B5's full ablation** | started and stopped so the timed runs could finish | the ablation, run to the end |
| 13 | **General joins; sliding and session windows; watermarks; search; secondary indexes; sketches** | no bound on work per write, or new engines | a use case and a cost model; a library over `derive`; an outside engine fed by `changes()` |
| 14 | **A server-side filter of the log by row content; served views of the past** | a copy has rows only at its current position; the past is a reader (V5-12 pick 8) | class B's key-path filter, later |
| 15 | **Equality as bytes** (P-16, event sourcing, says a rebuilt projection equals the live one "byte for byte") | data lists rows in arrival order; this page promises equality as values *(checked, E-23 run B)* | an order rule for rows in data, if P-16 must hold as written |
| 16 | **A tap that writes what it reads** | data's 1,000-commit cap stays | a data change, if it bites |
| 17 | **The defaults**: `views.client` 16, `views.max` 64, `views.rows` 1,000, a ring of 64, the row guards (5,000 and 2,000), `views.shapes` | guesses | the first build's own cost runs |
| 18 | **A data upgrade under live served views and derivers** (added after the skeptic) | the rule (3.8, section 5) is reasoned; XA-10 tested method versions and XB-12 past readers only | XA-10's rolling deploy with a data build in the key; B3 across a `fold-version` change |
| 19 | **Paging across a failover** | XA-7 is deterministic on one copy and XB-7 runs on one store; the `seen` wait is reasoned to cover it | a seeded walk with a failover between fetches |
| 20 | **The record form with rows** | not built; its restart opens the source's past at its mark | a model run in B5's style and a seeded run with field writes and removes |
| 21 | **Mixed-type buckets in `derive`'s view form**; `bucket-collision` | B3's buckets were strings only | B3 with mixed bucket values |
| 22 | **A cap per method; entries keyed by the built chain** | not taken: windows over one sorted parent share one node in data 5 instead (3.8) | `best(1)` to `best(100)` timed on D8c |

---

## 11. Questions for the owner

1. **Ship ordered served views and `{ pages }` only once data 5's index (D8c) lands, and before then refuse an ordered view over more than 5,000 rows and pages over more than 2,000?** Pick: yes. A leaderboard over 1e5 rows costs 134 to 155 µs a change today, seven times a whole write's budget, and a page index 509 to 525 µs. *Against:* the most-wanted served views wait for data 5; the guards are guesses, and timings move 10 to 25 % between sessions; even the chunked index misses its bar at 1e6 rows.
2. **A cost-weighted cap of 64 served views per copy, with headroom `views.max / k` (none for one serving copy), in place of API.md's 1,000 per resource?** Pick: yes. *Against:* it changes words already decided (V5-12 pick 5 said "per resource"); a client that held a view can still be refused, 5 to 21 times in 1,000 seeds; at two serving copies headroom halves the room; the cost classes are guesses until data 5 states them.
3. **Serve views on one copy chosen by a hash over every copy but the leader?** Pick: yes. It builds each view once and keeps build stalls off the write path, and it refused held views in 5 to 6 of 1,000 seeds with standbys, where "standbys first" refused them in 36 to 377. *Against:* a leader change hands on the new leader's views, 1,796 to 3,271 hand-offs per 1,000 seeds; voters carry read work beside their fold.
4. **Add `{ pages }` as a third kind of method, beside handlers and `{ view }`?** Pick: yes. One shared index costs 32 B a page read, where a view per cursor cost 0.7 to 8.3 MB a page and was refused by the 17th page. *Against:* its index costs every write, more than a leaderboard; one more method shape to learn; pages are reads, not live; a row whose sort value changes between two fetches can show twice or not at all.
5. **`derive`'s view form with the bump, the read barrier and the code version, for bucket views with one value per bucket, over a string or number field?** Pick: yes; without them it failed 514 of 1,000 seeds (796 counting every stale write). *Against:* about four more rules and one write per target group at every takeover; only the deriver may write the target; its log is a log of states, so event counting must use the record form.
6. **data 5.0.0 as one large major version in TypeScript, with the contract changing answers?** Pick: yes, D1 and D2 first, then the contract. *Against:* about 5,000 to 10,000 lines, as much code as the engine has; 20 breaking changes: every app that relied on tie order, coerced sums, `'60' > 50` or a field named `in` sees a change; a SCHEDULE_VERSION bump in both repos.
7. **Bucket answers as a `Map` with typed keys?** (added after the skeptic) Pick: yes. `1` and `'1'` stay two buckets, as C10 needs, and the types say what a key is. *Against:* `teams.get('red')`, not `teams.red`; the wire carries pairs; `group`'s answer stays an object, so there are two shapes.
8. **The record form sees records only in the first build, and gets rows later?** (added after the skeptic) Pick: yes. *Against:* until then a filtered log is exact only for whole-row writers; with rows, the deriver holds its share of the source (about 330 B a row) and folds every record.

---

## 12. How this page is checked

Every ` ```ts ` block whose first line is `// file: <name>` is written into a fresh folder and type-checked with tsc: the screen in section 0, the eight place files in section 3, and the six files below. Then a copy is made with every `@ts-expect-error` turned into a plain comment, and each of those lines must fail at its own line, with no error anywhere else (the strip proof). `fero.d.ts` is self-contained: the surface transformations touch, in READS.md's spelling, with servers typed by `fero.of` only. The sketch types a `{ view }`'s `ctx` by hand as `ViewCtx<Row>`; a real build would infer it. It does not show: API.md's seed form `fero(name, { data, methods })`; `hold: 'all'`; the keys of a whole-resource view at depth 2 in `c.order` (only page cursors are typed by depth); the depth of a handler's `ctx.data`; the shape of a bucket view's `c.diff` (typed as row changes); and any run-time behaviour. Its operator types (`Plain`, `Code`) are a hand-written copy of data's operators; a real build would generate them from data 5's exported contract (section 2, row 8). Every TypeScript block on this page is one of these files, so none of the page's code is only illustrative.

<details><summary>fero.d.ts, env.d.ts, server.ts and clients.ts</summary>

```ts
// file: fero.d.ts — the transformations surface this page proposes, as declarations. Self-contained: it imports nothing.
// A sketch to type-check the page; nothing is built. Reads use READS.md's spelling (live, on, get, past); API.md's
// here, tap and asOf map one to one. Only what transformations touch is declared.
declare module 'fero' {
  export type Key = string
  export type Version = string & { readonly __fero: 'version' }
  export type Cursor = string & { readonly __fero: 'cursor' }
  export type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json }
  /** What eq, in and by compare: a value with its type (1 and '1' differ), by SameValueZero (XB-5). */
  export type Scalar = string | number | boolean | null
  /** Who called: the token's claims. A handler sees them; a served view never does. */
  export type Claims = { readonly sub?: string; readonly [k: string]: Json | undefined }
  export type Depth = 1 | 2
  export type Rows<Row> = { readonly [key: string]: Row | undefined }
  /** A compile error that names the line to write instead. */
  export interface Steer<Msg extends string> { readonly 'fero: write this instead': Msg }
  type F<Row> = keyof Row & string
  /** Fields whose values are numbers: sum, avg, median take only these. */
  type NumF<Row> = { [K in F<Row>]-?: NonNullable<Row[K]> extends number ? K : never }[F<Row>]
  /** Fields whose values are scalars: eq, in, by and group take only these. */
  type ScalarF<Row> = { [K in F<Row>]-?: NonNullable<Row[K]> extends Scalar ? K : never }[F<Row>]
  /** A page cursor: the last row's sort value and its key. Over every row at depth 2 the key is (partition, row) (XB-6). */
  export type After<D extends Depth = 1> = D extends 2 ? readonly [value: Scalar, partition: Key, row: Key] : readonly [value: Scalar, key: Key]

  // ── where an operator stands, and what it gives back ───────────────────────────────
  /** left: left of the live verb (plain data; a copy may run it). right: right of it, here, on rows held on purpose.
   *  server: a handler's own code on a copy. view: inside { view } or { pages }: this resource only, no caller. */
  type Mode = 'left' | 'right' | 'server' | 'view'
  /** rows: unordered, unbounded. sorted: ordered, unbounded. window: ordered, at most n. page: a window after a cursor.
   *  scalar: one value. buckets: one value per bucket. members: rows per bucket (as big as the rows).
   *  arrival: this process's arrival order (limit or reverse over unordered rows). */
  type Bound = 'rows' | 'sorted' | 'window' | 'page' | 'scalar' | 'buckets' | 'members' | 'arrival'
  type Bounded = 'window' | 'scalar' | 'buckets'
  type Ord = 'sorted' | 'window' | 'page' | 'arrival'
  /** Ordered answers carry their order changes in c.order (XA-5). */
  type IsOrdered<B extends Bound> = [B] extends [Ord] ? true : false
  /** An ordered answer is an array in rank order, as data's ordered views are. */
  type Out<Row, B extends Bound> = [B] extends [Ord] ? readonly Row[] : Rows<Row>
  type Res<V, Row, B extends Bound, M extends Mode> = M extends 'right' ? Held<V, Row, B> : Addr<V, Row, B, M>

  /** An address: nothing runs until it is held or read. */
  export type Addr<V, Row, B extends Bound, M extends Mode> = Reads<V, Row, B>
    & { readonly __bound?: B; readonly __mode?: M }
    & ([B] extends ['rows' | 'sorted'] ? Ops<Row, M, B> : {})
  /** A held selection or view, here. Row-shaped ones take operators right of the line. */
  export type Held<V, Row, B extends Bound> = Live<V, Row, IsOrdered<B>> & ([B] extends ['rows' | Ord] ? Ops<Row, 'right', B> : {})

  export interface Reads<V, Row, B extends Bound> {
    get(): Promise<V>
    live(opts?: LinkOpts): Held<V, Row, B>
    on(fn: (value: V, c: Commit<Row, IsOrdered<B>>) => void, opts?: LinkOpts): Held<V, Row, B>
  }
  export interface LinkOpts { signal?: AbortSignal }
  export interface Live<V, Row = unknown, O extends boolean = false> {
    readonly ready: Promise<this>
    readonly value: V
    readonly closed: Promise<void>
    readonly close: () => void
    on(fn: (value: V, c: Commit<Row, O>) => void): this
  }
  export interface Change<Row> { readonly type: 'add' | 'update' | 'remove'; readonly key: Key; readonly row: Row | undefined; readonly prev: Row | undefined }
  /** One change of rank: data's order channel, applied after the row changes of the same commit. */
  export type OrderChange =
    | { readonly type: 'insert'; readonly key: Key; readonly at: number }
    | { readonly type: 'remove'; readonly key: Key; readonly at: number }
    | { readonly type: 'move'; readonly key: Key; readonly from: number; readonly to: number }
  /** What one commit changed. A new picture (after a failover, a ring miss or a redeploy) is one commit of
   *  differences too, with one call (XA-4). An ordered answer also says how ranks changed. */
  export type Commit<Row, O extends boolean = false> = { readonly first: boolean; readonly diff: readonly Change<Row>[] }
    & (O extends true ? { readonly order: readonly OrderChange[] } : {})

  // ── the operators ─────────────────────────────────────────────────────────────────
  /** Plain data: values only, an answer that depends on the rows only. May stand left of the live verb. */
  interface Plain<Row, M extends Mode> {
    eq<K extends ScalarF<Row>>(field: K, v: Row[K] & Scalar): Res<Rows<Row>, Row, 'rows', M>
    in<K extends ScalarF<Row>>(field: K, vs: readonly (Row[K] & Scalar)[]): Res<Rows<Row>, Row, 'rows', M>
    /** Range filters under the one numeric projection (C9): a number field, number bounds. */
    gt(field: NumF<Row>, v: number): Res<Rows<Row>, Row, 'rows', M>
    gte(field: NumF<Row>, v: number): Res<Rows<Row>, Row, 'rows', M>
    lt(field: NumF<Row>, v: number): Res<Rows<Row>, Row, 'rows', M>
    lte(field: NumF<Row>, v: number): Res<Rows<Row>, Row, 'rows', M>
    between(field: NumF<Row>, bounds: readonly [number, number]): Res<Rows<Row>, Row, 'rows', M>
    /** Sorted by the field under one total order per direction; ties by row key. With n: a window. With after: a page. */
    za(field: F<Row>): Res<readonly Row[], Row, 'sorted', M>
    za(field: F<Row>, n: number, opts: { after: After }): Res<readonly Row[], Row, 'page', M>
    za(field: F<Row>, n: number): Res<readonly Row[], Row, 'window', M>
    az(field: F<Row>): Res<readonly Row[], Row, 'sorted', M>
    az(field: F<Row>, n: number, opts: { after: After }): Res<readonly Row[], Row, 'page', M>
    az(field: F<Row>, n: number): Res<readonly Row[], Row, 'window', M>
    /** Buckets by a field's value, or by a numeric step of it (a time bucket), then one aggregate per bucket.
     *  The answer is a Map keyed by the typed value: 1 and '1' are two buckets (C10). */
    by<K extends ScalarF<Row>>(field: K, opts?: { step?: number }): Grouped<Row, M, Row[K] & Scalar>
    /** The member rows of each bucket: as big as the rows. */
    group(field: ScalarF<Row>): Res<{ readonly [bucket: string]: Rows<Row> }, Row, 'members', M>
    distinct(field: ScalarF<Row>): Res<readonly Scalar[], Row, 'members', M>
    length(): Res<number, Row, 'scalar', M>
    /** Exact sums over the numbers only (one numeric projection, XB-3, XB-4). No numbers: undefined. */
    sum(field: NumF<Row>): Res<number, Row, 'scalar', M>
    avg(field: NumF<Row>): Res<number | undefined, Row, 'scalar', M>
    min(field: NumF<Row>): Res<number | undefined, Row, 'scalar', M>
    max(field: NumF<Row>): Res<number | undefined, Row, 'scalar', M>
    median(field: NumF<Row>): Res<number | undefined, Row, 'scalar', M>
  }
  interface Grouped<Row, M extends Mode, V> {
    length(): Res<ReadonlyMap<V, number>, Row, 'buckets', M>
    sum(field: NumF<Row>): Res<ReadonlyMap<V, number>, Row, 'buckets', M>
    avg(field: NumF<Row>): Res<ReadonlyMap<V, number>, Row, 'buckets', M>
    min(field: NumF<Row>): Res<ReadonlyMap<V, number>, Row, 'buckets', M>
    max(field: NumF<Row>): Res<ReadonlyMap<V, number>, Row, 'buckets', M>
  }
  /** Code and arrival order: right of the live verb, or in a server's own method. An ordered answer stays ordered. */
  interface Code<Row, M extends Mode, B extends Bound> {
    filter(fn: (row: Row, key: Key) => unknown): Res<Out<Row, B>, Row, [B] extends [Ord] ? B : 'rows', M>
    map<U>(fn: (row: Row, key: Key) => U): Res<Out<U, B>, U, [B] extends [Ord] ? B : 'rows', M>
    /** Over a sorted parent, the first n by its order: a window (data 5, XB-13). Over unordered rows, arrival order. */
    limit(n: number): Res<readonly Row[], Row, [B] extends ['sorted'] ? 'window' : 'arrival', M>
    reverse(): Res<readonly Row[], Row, [B] extends ['sorted'] ? 'sorted' : 'arrival', M>
    byFn(fn: (row: Row, key: Key) => Scalar): Grouped<Row, M, Scalar>
  }
  /** For each row, the row of `other` whose key is row[field], kept live: a row, null for none, undefined while loading. */
  interface Join<Row, M extends Mode> {
    lookup<O, OD extends Depth, K extends ScalarF<Row>>(other: RootOf<O, OD>, field: K): Res<Rows<Joined<Row, O, OD>>, Joined<Row, O, OD>, 'rows', M>
  }
  export type Joined<Row, O, D extends Depth> = { readonly row: Row; readonly other: (D extends 2 ? Rows<O> : O) | null | undefined }
  interface LeftSteers {
    readonly filter: Steer<'a function cannot run on a server: live() first, then filter right of it'>
    readonly map: Steer<'a function cannot run on a server: live() first, then map right of it'>
    readonly limit: Steer<'left of live() a window is za(field, n); limit right of live() is this process\'s own'>
    readonly reverse: Steer<'left of live() write az or za; reverse right of live() is this process\'s own'>
    readonly byFn: Steer<'a function cannot run on a server: by(field) here, or byFn right of live()'>
    readonly lookup: Steer<'a lookup holds another resource\'s rows here: live() first, then lookup right of it'>
  }
  interface ViewSteers {
    readonly lookup: Steer<'a served view reads one resource, so its positions cover one: join in a handler, or derive the joined rows into a resource'>
  }
  type Ops<Row, M extends Mode, B extends Bound> =
    M extends 'left' ? Plain<Row, 'left'> & LeftSteers
    : M extends 'view' ? Plain<Row, 'view'> & Code<Row, 'view', B> & ViewSteers
    : Plain<Row, M> & Code<Row, M, B> & Join<Row, M>

  // ── resources, lenses, methods ────────────────────────────────────────────────────
  /** A phantom: which rows a root lens names, and its depth. Lets lookup and derive check types. */
  export interface RootOf<Row, D extends Depth = Depth> { readonly __row?: Row; readonly __depth?: D }
  /** A handler's context: its own code over every row this copy holds, and the caller. */
  export interface Ctx<Row> { readonly data: Addr<Rows<Row>, Row, 'rows', 'server'>; readonly signal: AbortSignal; readonly claims: Claims; readonly peer: string }
  /** A served view's context: no caller, no second resource. One view serves every equal call. */
  export interface ViewCtx<Row> { readonly data: Addr<Rows<Row>, Row, 'rows', 'view'> }
  /** A live view the server names. It must be bounded: a window, one value, or buckets. */
  export interface ViewDef<A, R> {
    view: (arg: A, ctx: ViewCtx<any>) => R
    /** The method's version, part of its entries' key. None: the deploy's build id, so its entries end at every deploy. */
    version?: number | string
    /** Run on every SUB with the caller: may this caller hold this view? The view itself never sees the caller. */
    allow?: (arg: A, claims: Claims) => boolean
  }
  /** One sorted list the server names, read a page at a time: one shared index on one copy; a page holds nothing. */
  export interface PagesDef<A, R> {
    pages: (arg: A, ctx: ViewCtx<any>) => R
    size?: number
    version?: number | string
    allow?: (arg: A, claims: Claims) => boolean
  }
  type Method = ((arg: any, ctx: any) => unknown) | ViewDef<any, any> | PagesDef<any, any>
  type NoCaller = Steer<'a served view is shared by every equal call, so it cannot see the caller: take the user as the argument, and check it in allow'>
  type CheckViews<M, Row> = { [K in keyof M]:
    M[K] extends { view: (arg: any, ctx: infer C) => infer R }
      ? ViewCtx<Row> extends C
        ? R extends Addr<any, any, Bounded, 'view'> ? M[K]
        : R extends Addr<any, any, 'arrival', 'view'> ? Steer<'limit and reverse over unordered rows follow this copy\'s arrival; another copy would differ: sort first, za(field, n)'>
        : R extends Addr<any, any, 'page', 'view'> ? Steer<'one served view per cursor builds an index of every row per cursor: declare { pages } and read page(after)'>
        : R extends Addr<any, any, 'members', 'view'> ? Steer<'group and distinct are as big as the rows: count with by(field).length(), or derive a resource'>
        : Steer<'a served view must be bounded: end it with za(field, n), an aggregate, or by(field).<aggregate>()'>
        : NoCaller
    : M[K] extends { pages: (arg: any, ctx: infer C) => infer R }
      ? ViewCtx<Row> extends C
        ? R extends Addr<any, any, 'sorted', 'view'> ? M[K] : Steer<'{ pages } returns one sorted list: ctx.data.za(field) or az(field), with filters before it'>
        : NoCaller
    : M[K] }
  /** A view the server named, seen from a client: an address, never a promise, and no operators left of the line. */
  export interface Served<V, Row, B extends Bound> {
    get(): Promise<V>
    live(opts?: LinkOpts): ServedLive<V, Row, B>
    on(fn: (value: V, c: Commit<Row, IsOrdered<B>>) => void, opts?: LinkOpts): ServedLive<V, Row, B>
  }
  /** sync(): resolves once the view is at or past every write this process saw resolve (read-your-writes, XA-13). */
  export type ServedLive<V, Row, B extends Bound> = Held<V, Row, B> & { sync(): Promise<void> }
  export interface Paged<Row, D extends Depth> {
    /** The next page after a cursor (the first page without one). One trip; it holds nothing on the copy. */
    page(after?: After<D>): Promise<Page<Row, D>>
  }
  export interface Page<Row, D extends Depth> { readonly rows: readonly Row[]; readonly next: After<D> | undefined }
  type ClientCall<Dm, D extends Depth> =
    Dm extends { view: (arg: infer A, ctx: any) => Addr<infer V, infer R, infer B, 'view'> } ? (arg: A) => Served<V, R, B>
    : Dm extends { pages: (arg: infer A, ctx: any) => Addr<any, infer R, any, 'view'> } ? (arg: A) => Paged<R, D>
    : Dm extends (arg: infer A, ctx: any) => infer R ? (arg: A) => Promise<Awaited<R>> : never
  export interface Entry<Row> { readonly value?: Row; readonly partition: string; readonly key: Key; readonly version: Version }
  export interface Changes<Row> extends AsyncIterable<Entry<Row>> { readonly cursor: Cursor; readonly close: () => void }
  export interface ChangesOpts { from?: 'earliest' | 'latest' | Cursor }
  export interface Op<T> { readonly __op?: T }
  export const op: { incr(n: number): Op<number> }
  type Logged<Row> = { changes(opts?: ChangesOpts): Changes<Row> }
  type PartLens<Row> = Addr<Rows<Row>, Row, 'rows', 'left'> & Logged<Row> & { past(v: Version): Promise<Past<Row>> }
  type RowLens<Row> = Reads<Row | undefined, Row, 'scalar'> & Logged<Row> & {
    past(v: Version): Promise<Past<Row>>
    /** A write; with { from: e } it is marked with its source record, so a restart applies it once (the record form). */
    set(v: Row | Op<Row>, opts?: { from?: Entry<unknown> }): Promise<void>
    remove(opts?: { from?: Entry<unknown> }): Promise<void>
  }
  type RootSteers = { readonly [N in keyof Plain<any, 'left'>]: Steer<'an operator over every row, on a client: call a view the server named, f.data.<view>(arg)'> }
  export type ClientRoot<Row, M, D extends Depth> = { readonly [key: string]: D extends 2 ? PartLens<Row> : RowLens<Row> }
    & RootOf<Row, D> & Logged<Row> & { readonly [K in keyof M]: ClientCall<M[K], D> } & RootSteers
  export type ServerRoot<Row, D extends Depth> = Addr<Rows<Row>, Row, 'rows', 'server'> & RootOf<Row, D> & Logged<Row>
    & { readonly [key: string]: D extends 2 ? PartLens<Row> : RowLens<Row> }
  export interface Resource<Row, M, D extends Depth, R extends 'server' | 'client'> {
    readonly name: string
    readonly data: R extends 'server' ? ServerRoot<Row, D> : ClientRoot<Row, M, D>
    readonly __m?: M
  }
  /** A past reader: the lens as it was, folded here. Views on it step with it, one commit per step. */
  export type Past<Row> = Live<Rows<Row>, Row> & Plain<Row, 'right'> & { step(n: number): Past<Row>; seek(v: Version): Past<Row> }
  type AnyRes = { readonly name: string; readonly __m?: unknown }
  type ClientOf<S> = S extends Resource<infer Row, infer M, infer D, any> ? Resource<Row, M, D, 'client'> : never
  export function fero<S extends AnyRes>(name: string): Promise<ClientOf<S>>
  export interface ViewCaps { client?: number; max?: number; rows?: number }
  export namespace fero {
    function of<Row, D extends Depth = 1>(): <const M extends Record<string, Method>>(
      name: string, opts: { server: true; depth?: D; methods?: M & NoInfer<CheckViews<M, Row>>; views?: ViewCaps },
    ) => Promise<Resource<Row, M, D, 'server'>>
  }
  // ── derived resources ─────────────────────────────────────────────────────────────
  /** The record form: once per source record, by marks; needs the source's history. fn sees the record, not the row:
   *  e.value is set only for a whole-row write. */
  export function derive<S, T>(source: { readonly data: RootOf<S, any> }, target: { readonly data: RootOf<T, any> }, fn: (e: Entry<S>) => void): Promise<void>
  /** The record form with rows (later): the deriver folds its share of the source, so fn also gets the row after the
   *  record and the row before it (undefined when there is none). */
  export function derive<S, T>(source: { readonly data: RootOf<S, any> }, target: { readonly data: RootOf<T, any> },
    fn: (e: Entry<S>, rows: { readonly row: S | undefined; readonly prev: S | undefined }) => void, opts: { rows: true }): Promise<void>
  /** The view form: the target's rows are kept equal to a bucket view with one value per bucket. Reads rows, not history.
   *  Buckets name target rows, so only a string field or a number field (its decimal form). */
  export function derive<T>(view: Addr<ReadonlyMap<string, T>, any, 'buckets', 'server'> | Addr<ReadonlyMap<number, T>, any, 'buckets', 'server'>, target: { readonly data: RootOf<T, any> }): Promise<void>
}
```

```ts
// file: env.d.ts — names the examples use and do not define
declare function draw(...what: unknown[]): void
declare function send(what: unknown): void
declare const cur: import('fero').Cursor
declare const v: import('fero').Version
```

```ts
// file: server.ts — the servers of this page's examples, typed by their rows
import { fero, type ViewCtx, type Ctx } from 'fero'
export type Msg = { text: string; stars: number; at: number; hidden?: boolean; meta?: { lang: string } }
export type Fan = { name: string; team: string; points: number }
export type Order = { user: string; sku: string; cents: number; at: number }
export type Product = { title: string; price: number }

export const chat = await fero.of<Msg, 2>()('chat', { server: true, depth: 2 })
export const fans = await fero.of<Fan>()('fans', {
  server: true,
  views: { client: 16, max: 64, rows: 1000 },
  methods: {
    best: { view: (n: number, ctx: ViewCtx<Fan>) => ctx.data.za('points', Math.min(n, 100)), version: 1 },   // a window: bounded
    leaders: { view: (n: number, ctx: ViewCtx<Fan>) => ctx.data.za('points').limit(n) },         // the same window (data 5)
    ranked: { pages: (_: null, ctx: ViewCtx<Fan>) => ctx.data.za('points'), size: 20 },          // one sorted list, read in pages
    byTeam: { view: (_: null, ctx: ViewCtx<Fan>) => ctx.data.by('team').sum('points') },          // buckets: one number each
    total: { view: (_: null, ctx: ViewCtx<Fan>) => ctx.data.sum('points') },                      // one value
    mine: { view: (user: string, ctx: ViewCtx<Fan>) => ctx.data.eq('name', user).length(),       // per user: the user is the argument
            allow: (user: string, claims) => claims.sub === user },                              // checked on every SUB, with the caller
    rename: (name: string, _ctx: Ctx<Fan>) => ({ ok: name.length > 0 }),                         // an action, not a view
  },
})
export const products = await fero.of<Product>()('products', { server: true })
export const orders = await fero.of<Order, 2>()('orders', {
  server: true, depth: 2,
  methods: {
    byCents: { pages: (_: null, ctx: ViewCtx<Order>) => ctx.data.za('cents'), size: 50 },       // depth 2: a cursor names (partition, row)
    withProducts: (user: string, ctx: Ctx<Order>) => ctx.data.eq('user', user).lookup(products.data, 'sku').get(),   // a handler may join, once
  },
})
export const totals = await fero.of<number>()('totals', { server: true })
export const counts = await fero.of<number>()('counts', { server: true })
export const big = await fero.of<Order>()('big', { server: true })
export type Chat = typeof chat
export type Fans = typeof fans
export type Products = typeof products
export type Orders = typeof orders
```

```ts
// file: clients.ts — typed clients of those servers: they hold nothing yet
import { fero } from 'fero'
import type { Chat, Fans, Orders, Products } from './server.js'
export const chat = await fero<Chat>('chat'), fans = await fero<Fans>('fans')
export const orders = await fero<Orders>('orders'), products = await fero<Products>('products')
```

</details>

```ts
// file: wrong.ts — what must not compile. Each marked line fails for the reason its comment gives (section 12)
import { fero, derive, type ViewCtx, type Claims } from 'fero'
import { chat, fans, orders, products } from './clients.js'
import { orders as ordersOnServer, chat as chatOnServer, totals, counts, products as productsOnServer, type Fan, type Msg } from './server.js'
// @ts-expect-error 1. a function cannot stand left of the live verb
chat.data.room1.filter((m: Msg) => m.stars > 0).live()
// @ts-expect-error 2. limit left of the live verb: a window there is za(field, n)
chat.data.room1.limit(10).live()
// @ts-expect-error 3. by() left of the line takes a field, not a function
chat.data.room1.by((m: Msg) => m.text).length().live()
// @ts-expect-error 4. a lookup holds another resource's rows here: not left of the line
chat.data.room1.lookup(products.data, 'text').live()
// @ts-expect-error 5. sum takes a number field only
chat.data.room1.sum('text').live()
// @ts-expect-error 6. eq, in and by take scalars: an object never equals by value
chat.data.room1.eq('meta', { lang: 'en' }).live()
// @ts-expect-error 7. an operator over every row, on a client: call a view the server named
fans.data.za('points', 10).live()
// @ts-expect-error 8. a served view takes no operators left of the line
fans.data.best(10).za('points', 3)
// @ts-expect-error 9. a served view is an address, not a promise: get() it
const wrong: readonly Fan[] = await fans.data.best(10)
// @ts-expect-error 10. only an ordered answer has order changes
fans.data.total(null).on((n, c) => draw(n, c.order))
// @ts-expect-error 11. a lookup's other side is a row, null (none) or undefined (loading): check before use
orders.data.ada.live().lookup(products.data, 'sku').on((rows) => draw(rows.o1?.other.price))
// @ts-expect-error 12. a lookup's field must be a field of the row
orders.data.ada.live().lookup(products.data, 'nope')
// @ts-expect-error 13. over every row at depth 2 a cursor names (partition, row)
await orders.data.byCents(null).page([500, 'o1'])
// @ts-expect-error 14. derive's view form takes one value per bucket: group's buckets are as big as the rows
await derive(ordersOnServer.data.group('user'), totals)
// @ts-expect-error 15. derive's view form needs the target's row type (chat holds messages, not numbers)
await derive(ordersOnServer.data.by('user').sum('cents'), chatOnServer)
// @ts-expect-error 23. derive's view form names target rows by a string or number bucket: not by a boolean field
await derive(chatOnServer.data.by('hidden').length(), counts)
// @ts-expect-error 24. range filters take a number field and number bounds (C9): not a string
chat.data.room1.gt('text', 'm').live()
type Item = { stock: number; title: string; team: string }
export const shop = await fero.of<Item>()('shop', {
  server: true,
  methods: {
    lowest: { view: (n: number, ctx: ViewCtx<Item>) => ctx.data.lt('stock', 5).az('stock', n) },  // a window: bounded
    // @ts-expect-error 16. unbounded rows: a served view ends in a window, an aggregate, or buckets
    low: { view: (max: number, ctx: ViewCtx<Item>) => ctx.data.lt('stock', max) },
    // @ts-expect-error 17. limit over unordered rows follows this copy's arrival: a failed-over view would differ
    firstSeen: { view: (n: number, ctx: ViewCtx<Item>) => ctx.data.limit(n) },
    // @ts-expect-error 19. group is as big as the rows: count with by(field).length()
    everyone: { view: (_: null, ctx: ViewCtx<Item>) => ctx.data.group('team') },
    // @ts-expect-error 21. one served view per cursor builds an index of every row per cursor: declare { pages }
    after: { view: (cur: readonly [number, string], ctx: ViewCtx<Item>) => ctx.data.za('stock', 20, { after: cur }) },
    // @ts-expect-error 22. { pages } returns one sorted list
    bucketPages: { pages: (_: null, ctx: ViewCtx<Item>) => ctx.data.by('team').length() },
  },
})
export const leaks = await fero.of<Item>()('leaks', {   // these two break the inference of the methods: their own server
  server: true,
  methods: {
    // @ts-expect-error 18. a served view is shared by equal calls: it cannot read who called
    leak: { view: (n: number, ctx: ViewCtx<Item> & { claims: Claims }) => ctx.data.eq('title', ctx.claims.sub ?? '').az('stock', n) },
    // @ts-expect-error 20. a served view reads one resource: join in a handler, or derive the joined rows
    joined: { view: (_: null, ctx: ViewCtx<Item>) => ctx.data.lookup(productsOnServer.data, 'title').length() },
  },
})
void [wrong, chatOnServer]
```

```ts
// file: pins.ts — what the sketch's types give, pinned by type equality
import type { Live, Commit, OrderChange, Page, Joined, Rows } from 'fero'
import { chat, fans, orders, products } from './clients.js'
import type { Fan, Order, Product } from './server.js'
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
type CommitOf<H> = H extends Live<any, any, infer O> ? O : never
const best = fans.data.best(10).live()
const t1: Eq<typeof best.value, readonly Fan[]> = true                          // a window is an array in rank order
const t2: Eq<CommitOf<typeof best>, true> = true                                // and its commits carry c.order
const t3: Eq<Commit<Fan, true>['order'], readonly OrderChange[]> = true
const t4: Eq<typeof fans.data.total extends (a: null) => { get(): Promise<infer V> } ? V : never, number> = true
const t5: Eq<Awaited<ReturnType<ReturnType<typeof orders.data.byCents>['page']>>, Page<Order, 2>> = true
const t6: Eq<Page<Order, 2>['next'], readonly [value: string | number | boolean | null, partition: string, row: string] | undefined> = true
const j = orders.data.ada.live().lookup(products.data, 'sku')
const t7: Eq<typeof j.value, Rows<Joined<Order, Product, 1>>> = true
const t8: Eq<Joined<Order, Product, 1>['other'], Product | null | undefined> = true
const t9: Eq<typeof chat.data.room1.live extends () => Live<infer V, any, any> ? V : never, Rows<import('./server.js').Msg>> = true
const teams = fans.data.byTeam(null).live()
const t10: Eq<typeof teams.value, ReadonlyMap<string, number>> = true            // buckets: a Map with typed keys (C10)
draw(t1, t2, t3, t4, t5, t6, t7, t8, t9, t10)
```

```js check
// TRANSFORMS.md checker: every ```ts block of this page whose first line is "// file: <name>" goes into a fresh folder
// and must type-check. Then, in a copy where each @ts-expect-error is a plain comment, each line it marks must fail,
// and nothing else may (the strip proof). Self-contained: tsc on PATH is all it needs. Adapted from READS.md's.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
const blocks = [...readFileSync(process.argv[1], 'utf8').matchAll(/^```ts\n(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)^```$/gm)]
  .map(([, body, name]) => [name, body])
const root = mkdtempSync(join(tmpdir(), 'fero-transforms-'))
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
node --input-type=module -e "$(awk '/^```js check$/{f=1;next} /^```$/{f=0} f' docs/v5-space/TRANSFORMS.md)" docs/v5-space/TRANSFORMS.md
```

**Result, run here on 2026-11-20** (Node v22.22.0, TypeScript 6.0.2), after the skeptic's fixes: `ok: 15 blocks type-check (tsc Version 6.0.2)`, then `24 marked lines, 24 fail at their own line, 0 errors elsewhere`. `pins.ts` compiles, so its ten type equalities hold. Each stripped line of `wrong.ts` fails for the reason its comment gives:

| Item | The wrong use | tsc |
|---|---|---|
| 1, 2, 4, 7 | `filter(fn)`, `limit`, `lookup` left of `live()`; `za(…)` over every row on a bare client | TS2349, not callable, with the fix in the type's text: "live() first, then filter right of it"; "left of live() a window is za(field, n)…"; "live() first, then lookup right of it"; "call a view the server named, f.data.<view>(arg)" |
| 3, 6, 12 | `by(fn)` left of the line; `eq` on an object field; `lookup` on a field the row lacks | TS2345: the argument is not a scalar field of the row (`ScalarF`) |
| 5, 24 | `sum('text')`; `gt('text', 'm')` | TS2345: not a number field (`NumF`); range filters take numbers (C9) |
| 8 | an operator after a served view | TS2339: `Served` has no `za` |
| 9 | `await` a served view, used as rows | TS2740: `Served` is not an array of rows |
| 10 | `c.order` on a scalar view | TS2339: only an ordered answer's commit has `order` |
| 11 | `rows.o1?.other.price` without a check | TS18049: `other` is possibly `null` or `undefined` |
| 13 | a 2-part page cursor over every row at depth 2 | TS2345: the cursor is `[value, partition, row]` |
| 14 | `derive(group(…), totals)` | TS2345: a "members" view is not a bucket view with one value per bucket |
| 15 | `derive(…sum…, chat)` | TS2345: the target's rows are messages, not numbers |
| 23 | `derive(by('hidden').length(), counts)` | TS2345: a `Map` keyed by booleans names no target row; the view form takes a string or number field |
| 16, 17, 19, 21, 22 | a `{ view }` of unbounded rows; of `limit` over unordered rows; of `group`; of a page after a cursor; `{ pages }` over buckets | TS2322, on the method, with the fix: "a served view must be bounded…"; "…sort first, za(field, n)"; "group and distinct are as big as the rows…"; "…declare { pages } and read page(after)"; "{ pages } returns one sorted list…" |
| 18 | a `{ view }` whose `ctx` reads `claims` | TS2322: the function does not accept a `ViewCtx`, which has no caller |
| 20 | `lookup` inside a `{ view }` | TS2349, not callable: "a served view reads one resource, so its positions cover one: join in a handler, or derive the joined rows into a resource" |

Two things the types cannot catch, and what catches them instead: a `{ view }` that reads a clock or module state (a user rule; E-57 XA-8 shows it matters), and a served view whose buckets grow past `views.rows` (checked at run time on every commit; E-57 A5, XA-12).
