# Ready to build? A last review before the build plan

2026-11-24. The design study has 22 decision records (V5-1 to V5-22, [DECISIONS](../DECISIONS.md)). Nothing of v5 is built. The question now is whether the design is ready for a build plan, or whether something big must be settled first. The owner also now leans to building in Rust from the start, where the record says TypeScript first (V5-6), and asks why a JavaScript layer on top should stop fero from being very fast when projects such as uWebSockets.js are. This page treats Rust from the start as a direction to assess. It is not a decision until a record says so.

**How this review was made.** Five reviews read the design, each through one lens: what is still owed, whether the pages are one spec, Rust and speed, whether a simpler whole exists, and what could force a redesign in the middle of the build. A synthesis merged them, dropped the doubles and ranked what was left. A skeptic then checked the merged page against the experiments and the decisions. The skeptic's findings held on every main point, and this page is the corrected one. What changed: the page no longer proposes to undo yesterday's decision on compact rows; the gain from Rust is stated as the experiments state it; the list of things owed before a plan fell from eight to two; the owner questions fell from eight to four. One review also ran a small probe (section 3.3). Its files are not in the repo, so its numbers are marked as such and nothing here leans on them.

**Marks.** *(measured)*: timed in the study, in the named experiment. *(measured here)*: timed by this review's probe, not an experiment in the repo. *(checked)*: a reviewer read the line in the named place. *(counted)*: a count. *(reasoned)*: an argument; nothing ran it. *(a guess)*: nobody measured it. *(from page X)*: taken from that page.

**Ranks.** MAJOR: settle before the build plan, or it forces a redesign in the middle of the build. MINOR: settle while building, in the step that needs it. NOTE: worth knowing.

**Words.** A **group** is one Raft group: a set of servers that agree on one log. A **slot** is one of 4,096 fixed buckets a row key hashes into. A **slot move** hands a slot from one group to another. A **copy** is a server that holds a resource's rows. To **fold** is to apply change records to rows. **`data`** is the sibling engine that holds rows and runs views. The **merger** adds up each group's part of a view over every row. A **rule** is one thing a builder must get right. A **compact row** is a row kept as bytes, not as a JavaScript object. The **kernel** is the part with no I/O that decides what happens: the log and its rules. The layers are L0 (storage and links), L1 (the log), L2 (judging a write and folding it), L3 (flow to readers), L4 (the public calls), L5 (libraries on top) ([LAYERS](LAYERS.md) 0.2).

---

## 0. The answer

**Nearly ready. Nothing found says the design is wrong, and no design question is open. Two things must happen before the build plan: one owner decision, and a short spec of the shapes the first step fixes.**

1. **No open design question.** [API.md](API.md) 11.1 says no owner question is open, and [GROUPS](GROUPS.md) 5.5 says all are answered *(checked)*. No review found a clash between two pages on the points it sampled *(checked)*.
2. **The one decision owed is where the line between Rust and JavaScript sits.** Rust from the start is a sound direction. In its plain form (Rust for the disk, the log, the links and the copying between servers; rows stay in `data`, in JavaScript) it changes one decision, V5-6, plus one wording in V5-9, and keeps every other *(checked)*. A wider form, where Rust also holds the rows as bytes, would undo V5-21, decided on 2026-11-23. This page does not recommend that now (section 3).
3. **Why fero can be very fast with a JavaScript layer, and where Rust helps.** A JavaScript layer is fine when it runs once per decision, not once per delivery. That is the uWebSockets.js lesson, and fero's design can follow it. One JavaScript cost per record stays on every copy: `data` applying the record to its rows. With a lean record format it has room (section 3.4). fero's floors are the disk's flush and the socket write; no language moves them. The study measured that a TypeScript kernel is already fast at the log. Rust buys a steadier tail and headroom above about 100,000 writes a second ([E-02](experiments/E02-pipeline/README.md)) *(measured)*. For fan-out, the number of records in each socket write sets the rate, not the language ([E-08](experiments/E08-relay-fanout/README.md)) *(measured)*.
4. **There is no one page to build from yet.** The main inside page is not yet rewritten for many groups, and the wire and the disk are named, not specified (M2). The fix can be staged: three short pages before the plan, then one page per layer as each slice starts.
5. **The slot move in one commit has run in its core form only.** Its full form is owed before the slice that builds it, not before the plan (M6).

**What happens, and when.** Sizes are guesses unless marked.

| When | What | Who or what settles it | Size |
|---|---|---|---|
| Before the plan | The owner's answers to section 5. The first is the line between Rust and JavaScript. | The owner; then one new decision record (V5-23) | Days |
| Before the plan | The first spec pages: one page for the whole system, the rule ledger, and the first step's shapes in bytes (M2) | Writing; no new design | 1 to 2 weeks |
| In the plan | `data` 5's order (M3), the slice order with a rule budget (M4), the speed ruler (M5) | The plan itself | Part of the plan |
| Slice 0, the first tasks of the build | The Rust Raft passes etcd's 41 test files; the same code runs in the simulator as WASM; the time to change a kernel rule and rerun is measured (section 4) | Probes, each with a kill line | Hours to days each |
| From day one, beside the build | The model of the full one-commit slot move, then the merger on top (M6) | A model. It gates the slot-move slice | 1 to 2 weeks; [GROUPS](GROUPS.md) 4.3 row 6 sizes it L |
| Before the first timed step | A quiet machine with its own disks, and CI turned on (M5) | Equipment | Days |

So the honest distance to a build plan is days for the decision and one to two weeks for the first spec pages *(a guess)*.

---

## 1. The MAJOR issues, ranked

Two are owed before the plan (M1, M2). Three are what the plan must contain (M3, M4, M5). One gates a later slice and starts on day one (M6).

### M1. Where the line between Rust and JavaScript sits is not decided (before the plan)

- **What it is.** The record says TypeScript first, with Rust later and only for L0 and L1 (V5-6; [LAYERS](LAYERS.md) 9.3) *(checked)*. It says `data` 5 is TypeScript with no Rust (V5-12 pick 9; V5-14 pick 6) *(checked)*. It says there is no compact row store in the first build, and that when one comes it sits inside `data` and is turned on only by a setting (V5-21 items 1, 3 and 7) *(checked)*. Rust from the start can mean three designs (section 3.4): Rust below the fold only (A); Rust also holds rows as bytes on servers (B); Rust also runs the views that have no app function (C).
- **Why it cannot wait.** It decides the thread layout, which Raft core is used, how the simulator runs the kernel, which speed bars apply and what a release ships. Shapes like these are fixed in the first build step (DEV-09, [REQUIREMENTS](REQUIREMENTS.md) 5) *(checked)*.
- **Recommended.** A. Rust for L0, L1 and the part of L3 that only moves bytes. Rows stay in `data`, as V5-21 says. The kernel hands committed records to one "state" interface, and the first build keeps V5-21's six seams, so a compact store can still be added later with no rewrite *(reasoned)*. Among the decisions, A changes V5-6 and one wording in V5-9, and nothing else (section 3.5).
- **The other ways.** Stay with TypeScript first, as recorded: E-02 shows a TypeScript kernel passes its own bars *(measured)*, and Rust comes later as a port. Or B now: that reverses V5-21 items 1, 3 and 7 and one option it rejected (section 3.5). C waits in any case; it needs no API change later ([LENS](LENS.md) 4.5) *(from that page)*.
- **A caution.** The reviews did not agree on B. Two read it as a redesign that should not start now. One read it as the form with the most speed to gain. The skeptic's check settled the page's stand: B was decided against one day before this review, on measured costs ([COMPACT](COMPACT.md); [E-66](experiments/E66-compact-rows/README.md)), and the probe here does not overturn those (section 3.3).
- **What settles it.** An owner answer (question 1), then V5-23.

### M2. There is no one true page to build from (before the plan, staged)

- **What it is.**
  - [LAYERS](LAYERS.md) says of itself, in its header and sections 10 and 11, that its rewrite for many groups (V5-18) is still owed *(checked)*. [GROUPS](GROUPS.md) found 84 places that lean on one group, of which 21 break (GROUPS 0) *(counted)*. Those 21 changes live only in GROUPS today.
  - Three V5-18 picks have no mechanism text in LAYERS at all: every copy keeps the home group's records (pick 6), how a resource grows by size and load (pick 7), when a settings change is in force (pick 8) *(checked by search)*.
  - Each rule is stated as "was X, now Y, by V5-n", in several pages. In LAYERS, 551 of 1,849 lines cite a decision *(counted)*. Its section 10 holds 50 readings the page filled in itself; about 32 are still the page's own guess *(counted)*.
  - The only place where each rule is one plain sentence is `judging/simplicity.json`: 55 records, 416 rules, last changed at V5-10 *(checked)*. Everything from V5-12 to V5-22 is prose. The first build is about 506 to 636 rules by the pages' own numbers ([LAYERS](LAYERS.md) 0.2; GROUPS 0 item 10) *(reasoned: arithmetic, with some known double counts)*. So about a fifth to a third of the first build's rules have no rule text.
  - The wire and the disk are named, not specified. LAYERS 7 gives verb names and what each message carries in words, with no field lists; the slot move's messages are open; some names clash (`busy` has two meanings) *(checked)*.
  - [DESIGN-V5.md](../DESIGN-V5.md) is the older draft with patches. It still describes 1,024 slots and one shard per resource, and its build plan builds things V5-2 and V5-18 reject *(checked)*. Four old build orders stand in four pages *(checked)*.
- **Why it cannot wait.** The owner steers from pages, not code. A builder who reads LAYERS today builds one-group text in places. With Rust below and JavaScript above, bytes are the contract between two code bases, so the first step's shapes must be exact.
- **Recommended: a staged spec.** Before the plan, three things only. One page for the whole system on one screen. The rule ledger: every first-build rule as one sentence, with how it is known (a model, a seeded run, or only an argument). The first step's shapes in bytes: the record header, positions, the wire messages, the journal (DEV-09). Then each layer's page is written when its slice starts, as that slice's first piece of work. Present tense, no dates, a decision id only in a margin. The decisions record stays append-only and becomes the "why". The end state is the same as one big rewrite, with no stall before the plan *(reasoned)*.
- **The other ways.** Rewrite every page before any plan: 2 to 3 weeks *(a guess)*, and it is itself the kind of stall the build should avoid. Or patch LAYERS in place for V5-18: smaller, but it leaves the history-shaped text and the missing rule records.
- **What settles it.** Writing. No owner answer is needed, except a yes to the shape (question 4).

### M3. `data` 5 is a second project on the critical path, not started (in the plan)

- **What it is.** The sibling repo is at 4.0.0, the commit the study measured on *(checked)*. fero's first build needs about 33 changes from it, about 20 of them breaking, plus more from V5-20 and V5-21 ([LAYERS](LAYERS.md) 3.7, 11) *(from that page)*. One item is missing from that list: `data` must list, snapshot and drop one slot's rows (GROUPS G7) *(checked)*. The three stated misses all wait on it: a view build over a million rows stalls its copy 0.2 to 1.9 s; the ordered index costs 9.5 to 15.1 µs a write; a held view can be refused after failures *(measured, from LAYERS 11)*.
- **Why it matters.** L2 to L4 are written against `data` 5's surface. A plan that does not place its pieces stalls at L2. v4 pins `data`'s head too, so a breaking version needs a branch plan *(reasoned)*.
- **Recommended.** One page in the plan: `data` 5's items in the order fero's slices need them ([TRANSFORMS](TRANSFORMS.md) 9.1's order with the later adds), built beside fero's kernel, the first two (D1 and D2) at the very start with `data`'s own perf suite.
- **What settles it.** A page in the plan.

### M4. "The first build" is the whole product, with no order inside (in the plan)

- **What it is.** The first slice in the study was thin ([VERDICT](VERDICT.md) 9 step 4). Today it holds the Raft base, the whole read surface, transformations, the merger, `scan()`, folds, several groups and the slot move ([LAYERS](LAYERS.md) 11) *(checked)*. Only three things about order are decided *(checked)*. One of them: the slot move comes last in its slice, once it is modelled and timed (V5-18 pick 1) *(checked)*. Of the rules added since the base was counted, most are reasoned, not checked ([LAYERS](LAYERS.md) 0.2) *(from that page)*.
- **Five hard parts have never met.** Raft, slot moves, the merger, served views and exactly-once marks were each checked alone, each in its own stand-in, most in one process *(checked)*.
- **Why it matters.** A build that must get 500 to 630 rules right before anything is whole has no early point where the owner can see it work and no early point where speed is pinned. That is how a design turns into a patchwork.
- **Recommended.** Nothing leaves the design. First, one thin path through the hard parts, in the simulator: the Raft core, two groups, one merged view, one deriver with marks, 1,000 seeds. The slot move joins that path once its model passes (M6), as V5-18 pick 1 says. Then widen in slices. Each slice names the spec rules it turns on, a rule budget, the models that gate it, its perf pins, and what the owner can see at its end. Work past one process's memory (the merger and its parts, +27 to +48 rules, mostly reasoned) comes in the last slices; until then the simpler way serves (section 2).
- **What settles it.** The build plan itself, and one owner answer on the order (question 2).

### M5. There is no ruler for speed (in the plan; needed before the first timed step)

- **What it is.** On the study's machine, even the control that judges nothing missed the write bar: p99 of 5.7 to 13.2 ms against 5.73 ms ([LAYERS](LAYERS.md) 3.6; [E-63](experiments/E63-judge-thread/README.md)) *(measured)*. Its disk stalls 22 to 52 ms in every run ([E-01](experiments/E01-floors/README.md)) *(measured)*. A quiet machine is owed (V5-20 item 15). CI is written and not turned on ([STATUS](../../STATUS.md)) *(checked)*. None of the rival timings ran on this design.
- **Why it matters.** Speed is the hard requirement. The native bars are five to ten times tighter. Rust met the native latency bar only on emulated separate disks: memory files plus a wait drawn from the disk's measured flush times, with the disk's rare 20 to 50 ms stalls left out. No run on real separate disks exists ([E-02](experiments/E02-pipeline/README.md), "The answer in short" and its limits) *(checked)*.
- **Recommended.** Name the machine (best, three with their own disks), rerun E-01's floors on it, restate the bars from those floors, turn CI on. Before the first timed step.
- **What settles it.** Equipment (question 3).

### M6. The one-commit slot move's core is modelled; its full form is not (gates the slot-move slice)

- **What it is.** V5-18 pick 4 cuts the move to one commit and keeps the 10 ms bar. The core of that form was modelled: probe `pslot-fused` in [E-17b](experiments/E17b-partitioning-part2/README.md) has 24 rules and catches 34 of 45 planted mistakes, with the other 11 changing nothing *(measured there)*. A one-commit window was timed at or under 4.7 ms at p99, where the three-commit form took 16.7 ms at 10,000 writes a second ([E-13](experiments/E13-handover/README.md)) *(measured)*. What is still owed is the full form ([LAYERS](LAYERS.md) 2.6): the real carried set (the session and dedup state that travels with a slot), the slot table in the home log, the home group down, and a move that meets a membership change at two faults. The carried set is listed two ways in two pages, with no final list *(checked)*. [E-15](experiments/E15-slot-move-tla/README.md)'s older model catches 39 % of planted mistakes against an 85 % bar ([VERDICT](VERDICT.md) 9) *(checked)*.
- **Why it is still MAJOR.** The move touches the log, the fold, flow, sessions, locks, the merger and the client's routes. A fault found late could change L1's record shapes, which the first step fixes. The merger's main rule was checked on seeds with the three-commit move; [E-67](experiments/E67-merge-rule4/README.md) argues it carries over *(reasoned there, not run)*.
- **Why it does not block the plan.** V5-18 pick 1 already orders it: the move comes last in its slice, once modelled and timed. A model gates the slice that builds it.
- **Recommended.** Start the model on day one, beside the build: the one-commit move with the full carried set, the slot table in the home log, the home group down, lost and late messages, and a membership change, to the 85 % bar. Then E-67's merger run on top. In the first step, hold open only the record fields the carried set adds.
- **The other way.** If the model finds a fault, the fallbacks the record already names: move by reference, or a restated bar on a quiet disk.
- **What settles it.** A model. The timing of the window waits for real code and the quiet machine.

---

## 2. Is there a simpler whole?

**The core is already the simple one.** The log as the truth, a resource as its own cluster, fixed slots, one journal per process, one commit point first: about 333 counted rules, most model-checked or from Raft's spec ([LAYERS](LAYERS.md) 0.2) *(from that page)*. No review found a simpler core. The growth is on top: flow (L3) went from 33 rules to 82 to 133 *(from that page)*.

**Worth taking before the build.**

| Candidate | What it saves | What it costs | Mark |
|---|---|---|---|
| One Rust kernel, built native and as WASM | The second kernel, the twin test between two kernels, and the later port | The Raft proof (slice 0); a compile step on every kernel change | reasoned; E-04 measured the form |
| Fan-out from committed bytes as the first form | It was a deferred step ([PATHS](PATHS.md) 7.1); with a native core it is the natural path. The gain is from batching, not from the language (E-08) | Nothing new | reasoned |
| Cut the first build into ordered slices; serve whole-resource work by the simple way first | +27 to +48 mostly reasoned rules leave the early slices | No view past one process's memory until the last slices | reasoned |
| A whole rule ledger, with a budget per slice | The cheapest guard against patchwork growth; a number the owner can steer by | The ledger of M2 | reasoned |
| One number for "a write applied once, in order" | Perhaps 3 to 8 rules and one number on every record (a guess). Five mechanisms, 32 rules, each keep a high mark per stream today | Three models run again. Low confidence | reasoned |

**Looked at and not taken now: rows as bytes on servers as the first form (option B).** It would save JavaScript work per record on copies whose app does not read the rows, and it would lift the 16.7 million key limit of one JavaScript `Map` ([COMPACT](COMPACT.md) 0). But it reverses V5-21, and V5-21 already lifts the key limit another way (item 2: the key index split into small tables). Section 3 has the numbers.

On the third row: work over every row exists twice in the design. One way keeps one store in one process, fed by every group. It costs about 2 rules and held on 19 million checks through 6,122 slot moves (E-57, from [GROUPS](GROUPS.md)) *(checked)*. Its limit is the process's memory. The other way is the merger. It is needed past that limit. It should leave room in the early slices: write the short list of seams it needs from L1 to L3, as [COMPACT](COMPACT.md) did for rows.

On the last row: now is the cheap moment, because the record for write numbering (`issue-order`) and its model are not written yet ([LAYERS](LAYERS.md) 11) *(checked)*.

**Can wait.**

- Folds and the sorted column (+7 to +11 rules): add them on a measured need. They add to the API; they do not change it *(reasoned)*.
- The one shared dependency under "a resource is its own cluster": while `#sessions` has no majority, no new client can start writing anywhere. A model can show whether plain writes need it *(reasoned)*.
- Judging off the main thread. It was rejected on its TypeScript costs (V5-20 item 14). With a Rust kernel two of those costs change. Ask again, timed, after the first slice.
- A native engine for views with no app function (option C).
- A server with no Node in it. It comes almost free once the core is a Rust crate. Do not rule it out *(reasoned)*.
- The 13 unpriced items below a row (V5-15). Price them; place them late. Whole-row writes work without them.

---

## 3. Rust from the start

### 3.1 What the study measured about Rust

**The plain answer: the study did not find that JavaScript makes fero slow. It found that the disk and the socket set the pace, and that a lean design is fast in either language. Rust's measured gains are real and modest.**

- **The log, where Rust wins** ([E-02](experiments/E02-pipeline/README.md), on a pipeline stub with no real Raft) *(measured)*:
  - The tail: commit p99 of 0.67 ms in Rust against 2.4 ms in TypeScript at 50,000 writes a second, on emulated separate disks. On the real shared disk Rust's p99 is 1.6 ms and TypeScript's 4.3 ms.
  - The ceiling off the disk: 10.1 million writes a second against 4.0 million, about 2.5 times.
  - CPU at high rates: Rust is under 2 µs a write from about 130,000 writes a second.
- **The log, where it does not** (same experiment) *(measured)*:
  - At 50,000 writes a second the leader costs 5.5 µs a write in TypeScript and 4.7 µs in Rust. A fixed cost per batch rules, not the language.
  - On the real disk all four builds commit 2.2 to 2.8 million writes a second. The disk is the limit.
  - TypeScript passes its own bars, and commits about 4 million writes a second when the disk is not the limit.
- **Fan-out: records per socket write set the rate, not the language** ([E-08](experiments/E08-relay-fanout/README.md)) *(measured)*. Rust pushed 11.9 to 13.4 million deliveries a core-second with big rounds. Node pushed 0.57 to 1.5 million with no added wait, and 20.6 to 32.3 million with 10 ms rounds. At equal load the two used about the same CPU. E-08's own verdict: native relays are not needed for throughput.
- **Idle groups cost a third to a half in Rust** ([E-11](experiments/E11-many-groups/README.md)) *(measured, with raft-rs, a library this page does not propose to build on)*.
- **Crossing between Rust and JavaScript is cheap in batches**: 52 ns a record at 256 records a call, 3.8 µs for one call per record ([E-03](experiments/E03-napi-cost/README.md)) *(measured)*.
- **Rows.** Rust building JavaScript row objects costs 888 ns a record, against 712 ns for JavaScript's own decode (E-03) *(measured)*. Most of a follower's cost in v4's form is turning bytes into objects: 2.7 µs to decode, 0.9 µs to fold; the record format, not the language, is the lever ([E-05](experiments/E05-fold-cost/README.md)) *(measured)*. v5 replaces that format in any option.
- **Rows with no row object were tried, in JavaScript.** [E-65](experiments/E65-every-row/README.md) X1 folded into a column store at 1,132 to 1,374 ns a write and read a row from it in 2.5 to 3.4 µs. [E-66](experiments/E66-compact-rows/README.md) made a row from columns in 936 to 1,082 ns at a million rows, against `data`'s 455 to 497; and in 199 to 251 ns at ten thousand rows, against 42 to 65, which is over the 100 ns promise for a held read (P-01) *(measured)*. No experiment did it in Rust *(checked by search)*.

So the honest summary: a TypeScript kernel is already fast at the log; Rust buys a steadier tail, headroom above about 100,000 writes a second, and one kernel in place of two.

### 3.2 How uWebSockets.js does it, and what fero would copy

*(Reasoned from that project's public design; nothing was measured or read in code here.)* Its native code owns the sockets, the parsing, TLS, the topic tree and the joining of many small sends into one system call. JavaScript gets one call per incoming message. A publish to 10,000 subscribers is one call from JavaScript; the 10,000 sends happen in native code. The app's own state stays in JavaScript.

**The rule behind it: JavaScript is paid once per decision. It is never paid per delivery.**

Two cautions keep this fair. First, that project is compared with Node's own HTTP and WebSocket stack, with a near-empty handler, no disk flush and no copies on other servers. The study's stand-ins were already lean, which is why its gaps are 1 to 2.5 times, not 10 *(reasoned)*. Second, its shape is option A plus fan-out from bytes: native sockets and topics, state in JavaScript. It is not option B. B is the shape of a native database with script hooks *(reasoned)*.

The same rule for fero:

| Path | Must it touch JavaScript? | Why |
|---|---|---|
| Log append, Raft, the journal, replication | No | No app code runs |
| Fan-out of change records to client links | No | It only moves committed bytes |
| Snapshots, restore, slot moves, the hash check, scan pages | Not in principle | They read bytes and send bytes. The hash of a million rows: 259 ms from bytes, 1,919 ms from objects (E-05) *(measured)*. With rows in `data` (A), they read through `data` |
| Applying records on a copy | Under A, yes: `data` folds on every copy (V5-6) | Every server is the app's own process, and the app may read its copy at once (P-01). A copy runs no app code for a record unless its own app reads that row |
| A method or a guard, at the leader | Yes, one call per write or per batch | The app's function is JavaScript. 107 ns a call (E-03) *(measured)* |
| A view with the app's own function | Yes, per changed row, on the one copy that serves it | Same reason |
| Reads in the app's own process | Yes | The app needs an object |

**Three floors do not move in any language:** the disk's flush, the cost of a socket write (8 to 14 µs in both languages on the study's virtual machine; a few µs on bare metal, reasoned in E-08) *(measured)*, and the time the app's own function takes.

### 3.3 The probe run for this review

**Question.** What does a copy pay per record if Rust keeps the row as bytes and no JavaScript object is made?

**What ran.** One stream of change records, the same bytes for both sides: half whole-row sets of a 137-byte row, half updates of one number field, random keys, 2,000,000 records. Rust kept each row as bytes in a hash table. Node 22 used a lean decoder and a plain `Map` of row objects. Both ended with the same sum over all rows. Three runs, median and range, one thread each.

| ns per record or read *(measured here)* | 10,000 rows | 1,000,000 rows |
|---|---|---|
| Rust: apply a record to byte rows | 95 (93 to 97) | 406 (335 to 411) |
| Node: decode and fold into objects | 418 (373 to 437) | 1,515 (1,487 to 1,626) |
| Node: read a held row object | 49 (36 to 52) | 421 (349 to 426) |
| Node: make a row object from bytes on each read | 431 (376 to 439) | 678 (602 to 690) |
| Memory per row | Rust 247 B; Node 299 B of heap | Rust 252 B; Node about 355 B of heap |

**What it says.**

- For rows that no JavaScript reads on that copy, applying as bytes is about 4 times cheaper (3.7 to 4.4).
- If each applied row is then read once on that copy, the gain shrinks. At a million rows: 406 + 678 = 1,084 ns against 1,515 + 421 = 1,936 ns, about 1.8 times. At ten thousand rows: 95 + 431 = 526 ns against 418 + 49 = 467 ns, so bytes are slower *(arithmetic on the table)*.
- The Node side alone folds 0.66 to 2.4 million records a second on one thread *(arithmetic on the table)*. That is above the native write bar of 500,000 a second (PERF-09), with little left for app code at the top end.
- It agrees with E-66: a row made on read costs more than a held one, and at small sizes misses the 100 ns promise.
- The memory numbers set Rust's bytes against Node's heap, not against the whole process. E-65 measured the whole process: 698 to 703 B a row for `data`, 296 to 300 B for a column store *(measured)*.

**Its limits.** The Node side is kinder to JavaScript than fero would be (no `data`). The Rust store is naive. No real crossing was made. No views, no Raft, no disk. A shared 4-core machine. Its files are not in the repo. **No recommendation on this page leans on it.** If the owner wants B weighed again, it is redone first as a numbered experiment (section 3.6).

### 3.4 The three places the line can sit

| | A. Native core | B. Native state | C. Native engine |
|---|---|---|---|
| Rust holds | The journal, Raft, links, replication, the wire, fan-out of committed bytes (L0, L1, part of L3) | A, plus the rows as bytes, the apply on every copy, snapshots, scans, hashing | B, plus the views that have no app function |
| JavaScript holds | `data` folding every record on every copy; L2 to L5 | `data` as the view engine, fed what app code and served views look at; methods; the client | Only app functions and the client |
| Wins | The tail and the ceiling at the log. No garbage collector in the kernel. One kernel, not two | A's wins. No JavaScript work for rows nobody reads on that copy. Less memory per row | B's wins. Served views run off the main thread |
| Costs | Every copy still folds in JavaScript. With a lean record format that is about 0.7 to 2.4 million records a second of one thread *(measured here)*; with v4's codec, 0.3 to 0.8 million (E-03, E-05) *(measured)*. Full garbage collections grow long past a few million rows per process ([E-07](experiments/E07-gc-worker/README.md); [COMPACT](COMPACT.md) 0) | A row is made on read, which misses the 100 ns promise (E-66). A second fold in Rust must match `data`. A second kind of row for app code | A rewrite of `data`'s engine in Rust, and a browser engine as WASM or a twin |
| Fits the record | It changes V5-6 only. V5-12, V5-14 and V5-21 stand | **It reverses V5-21 items 1, 3 and 7 and one rejected option, decided 2026-11-23.** It also needs Rust in or beside `data`, against V5-12 pick 9 and V5-14 pick 6 | Kept open for later by [LENS](LENS.md) 4.5 |

**When B would start to pay** *(reasoned from the numbers above)*: above a few hundred thousand records a second per process, or past about 2 to 5 million rows per process, and only for rows the app on that copy does not read. Below that, A's JavaScript fold has room.

A is inside B, and B is inside C. A build can stop at A and go on later with no work undone, if the first build keeps V5-21's six seams *(reasoned; that is what V5-21 item 1 is for)*.

### 3.5 What changes in the record if the owner confirms

One new record, V5-23, append-only.

**Under A, it supersedes by name:**

- **V5-6**: "TypeScript first" and "Raft from the TypeScript port". "`data` folding on every copy" and "inside the app's own Node process" stand.
- **[LAYERS](LAYERS.md) 9.3 and [VERDICT](VERDICT.md) 9 step 8**: the later native step becomes the first step.
- **TEST-10 and A-30**: the twin test between two kernels goes. A small codec guard between Rust and the TypeScript client comes.
- **V5-9 pick 2**: the checksum names the algorithm, not Node's function.
- **V5-8 and V5-10**: they stand. Their numbers (idle memory, the hand-back cap) were taken on TypeScript and are measured again.

**Under A, what stands** *(checked)*: V5-12 pick 9 and V5-14 pick 6 (`data` 5 is TypeScript). All of V5-21. DATA-01 as worded (rows are folded by `data`'s own code).

**Under B, on top of A's list**, V5-23 would have to reverse:

- **V5-21 item 1** (no compact row store in the first build), **item 3** (when one comes, it sits inside `data`) and **item 7** (a resource turns compact only by its author's setting, never by default). And the rejected option "a store of fero's own" *(checked)*.
- **V5-12 pick 9 and V5-14 pick 6**, if the byte store is to sit inside `data` as item 3 says.
- **DATA-01's strict reading.** The owner chose the loose reading once: a server may apply records with code that is not `data`'s own, if a test proves equal rows ([VERDICT](VERDICT.md) 11.6 item 15; DATA-09 names the test) *(checked)*. V5-6 and V5-21 then kept rows in `data`.
- **Nothing about `===`.** V5-21 item 4 already says it: `===` holds for `data`'s object rows; on a compact row, code compares `version`. Promising `===` on compact rows too was rejected there *(checked)*.

**What does not change in either case** *(checked by search of the decisions for language words)*: V5-1 to V5-5, V5-7, V5-11, V5-13, V5-15 to V5-20 and V5-22 name no language. [API.md](API.md)'s calls do not change. The models do not change. The rule counts barely move: the Rust row in [SIMPLICITY](SIMPLICITY.md) has the same count as the TypeScript ones. Judging stays on the main thread with its watchdog (V5-20 item 14), because a method is JavaScript. Rust does not mean no stalls.

**What Rust first costs, in any option.**

- **A build step.** Today everything is served from source with no build. With Rust, each kernel change is compiled twice, native and WASM, before a test runs *(reasoned)*. This is a direct cost to the speed of making a change. Slice 0 should measure it and pin it (section 4).
- **A prebuilt binary per platform.** `npm install fero` must still run with plain `node` (DEP-20), so a release carries one binary for each server platform *(reasoned)*.
- **A crash in native code takes the app's process down with it**, because fero runs inside the app's own process (V5-6) *(reasoned)*. Unsafe code sits at the boundary with Node.
- **TLS and the door move to Rust**, if Rust owns the links. The door is the handshake that admits a peer. The study timed Node's TLS ([E-27](experiments/E27-idle-links/README.md), [E-50](experiments/E50-path-costs/README.md)); the door's rules are reasoned, not modelled ([LAYERS](LAYERS.md) 1.3, `cluster-credentials`) *(checked)*. A fuzz test of the wire decoder is owed.
- **Clients stay pure TypeScript**, the browser included.

### 3.6 If B is to be weighed again later

One numbered experiment, about a day of work *(a guess)*, in slice 0 or later. A real native addon. Rust holds 10,000 and 1,000,000 rows as bytes; `data` reads them through one backing seam, as V5-21 item 3 describes. Time: a read by key with the crossing, first read and cached; one served view with an app function fed changed rows in batches of 256; a copy applying 50,000 and 500,000 records a second, with and without JavaScript. E-66 already shows the first read of a made row misses 100 ns; the experiment tests the rest. Its result is evidence for reopening V5-21, or for leaving it.

### 3.7 What it does to the bars

The bars have a TypeScript column and a native column ([REQUIREMENTS](REQUIREMENTS.md) 2). With Rust first, the native column is the bar *(reasoned)*. None can be judged before the quiet machine (M5).

| Bar | With Rust first | Mark |
|---|---|---|
| PERF-08: commit p99 within the floor + 0.5 ms (was + 5 ms) | Met on emulated separate disks (0.67 ms against 1.2 ms). On one shared disk 1.6 ms: a miss, from the disk. No run on real separate disks exists | measured on E-02's stub; open for a real kernel |
| PERF-09: 500,000 writes a second per process (was 50,000) | The log can (E-02). Under A the JavaScript fold has about 0.7 to 2.4 million a second of one thread with a lean record format, so the bar is in reach with little room for app code at the top | reasoned from measured parts; the fold number is measured here |
| PERF-11: 3 million deliveries a core-second (was 100,000) | Met in either language with batching; the choice is a latency budget | measured, E-08 |
| PERF-07 (etcd's line), PERF-06 (Redpanda's) | Likely or open until run on a real kernel | reasoned; from VERDICT |
| PERF-04 (the comparison with NATS JetStream as it ships) | **Does not move.** One disk flush of the three is already above the bar. Only a later mode that answers before the disk has the write could win it ([MEMORY](MEMORY.md)) | measured floor, [VERDICT](VERDICT.md) RR-15 |
| Rows per process, pauses | A does not lift them. V5-21 item 2 lifts the key limit. B and C would lift the rest | reasoned |
| The slow ordered index; the stall of a big view build | Not helped by Rust. They wait on `data` 5 | from TRANSFORMS 9.2 |

One caution: Rust was not always faster. A relay measured 1.2 ms at p99 in Node and 3.5 ms in Rust at one working point (E-08) *(measured)*.

---

## 4. MINOR issues, by the slice they belong to

All are owed by the record ([LAYERS](LAYERS.md) 11 unless named). Each is settled in the slice that builds it.

**Slice 0: the first tasks of the build, each a probe with a kill line.**

- **The Rust Raft.** V5-6 names the TypeScript port of etcd's Raft. It passes all 41 of etcd's test files and 4,000 random scripts against etcd's own code ([E-10](experiments/E10-raft-port/README.md)) *(measured)*. Every Raft number in the study is from that port. In Rust, raft-rs runs none of etcd's 28 interaction files; openraft was not looked at; a Rust port was not tried (E-10; [AMENDMENTS](AMENDMENTS.md) G-24) *(checked)*. The choice follows from V5-6 and DEV-04: port etcd's Raft to Rust with its test harness, and hold it to the same proof. Kill line: fewer than 41 of 41, or fewer planted mistakes caught than the TypeScript port's 89 %. E-10's port reached 41 of 41 in minutes of work *(measured there)*, so this is hours to days *(a guess)*. It also retires a second risk: the real port in a simple host had a commit p99 of 84 to 127 ms at 50,000 writes a second ([PATHS](PATHS.md) B11) *(measured)*.
- **The same code in the simulator, as WASM.** fero proves its rules by running the kernel in a seeded simulator (TEST-10); the website and the debugger run it in a browser. With one Rust kernel there is no second kernel to keep equal: build it native for the server and as WASM for the simulator and the site ([REQUIREMENTS](REQUIREMENTS.md) X2). [E-04](experiments/E04-wasm-kernel/README.md) already answered the main question: a Rust kernel as WASM meets the simulator's bar, 200 chaos seeds in 102 ms on a small kernel and 384 ms with raft-rs, against 1 s *(measured)*. Two things to carry. The simulator must reuse one WASM instance: a fresh instance per test takes 7.3 ms against the 5 ms bar (TEST-01). And a real Raft in WASM was no faster than the TypeScript port, because each message is packed at the crossing. Rule for the crate: no I/O and no threads inside, as v4's kernel is today.
- **The client's rules exist twice.** Sessions, routing, the slot table and the wire codec are in Rust on servers and in TypeScript in the client. The browser client today is 27.9 KB gzipped ([E-40](experiments/E40-browser-client/README.md)) *(measured)*. A guard must compare state, not only output (E-04).
- **The time to make a change.** A bar for slice 0: edit one kernel rule, rebuild native and WASM, run 200 seeds, in under a stated number of seconds. Measure it in the Raft probe and pin it.

**The first step: shapes that must not change later (DEV-09).**
- A version on every frame, journal and snapshot (OPS-05, OPS-12; [LAYERS](LAYERS.md) `cluster-version`, reasoned there).
- The interface for the recorder, health and the debugger across the Rust line ([E-42](experiments/E42-recorder/README.md); OPS-02, OPS-04). These are how the owner sees a run.
- The text of a version and a cursor. Two read costs miss their 50 ns bar in the forms tried ([E-62](experiments/E62-read-costs/README.md)); time them again in Rust.
- The value's encoding and one shared log per process (V5-9 put both off). Both are format changes. Decide in or out now.
- The boundary rules: cross in batches, fill buffers the caller owns, one write per socket per round.
- One list of names and codes; `busy` has two meanings ([API.md](API.md) 11.2).
- The server platforms list; a check that other runtimes load the addon.
- The bars restated in one column.

**The log (L0, L1).**
- Repair of a damaged batch from a peer, with a damaged header and lost messages.
- Founding and the directory together; founding when the store cannot be reached.
- How a follower learns the home group's records ([LAYERS](LAYERS.md) 10 item 22).
- Settings adopted by every group; placement by load; growth from 1 to 16 groups, timed.
- A clean stop behind a partition ([E-59](experiments/E59-growth-and-stop/README.md) checked it without one).
- The watchdog in a real group; its wait has no config key.
- Write numbering (`issue-order`): the record and its model across a slot move.
- Quiet groups with failure detection; many elections at once after a crash.
- The slot move's window, timed with a real carried set.
- Writes from client sockets owned by native threads, at 1, 2 and 4 threads.
- The numbers taken on the TypeScript port, measured again.

**Judging and flow (L2, L3).**
- [E-61](experiments/E61-marks-from-code/README.md)'s planted-mistake score: 84 % against 90 %.
- Pacing in a real client; credits with forwarding and moves; a reconnect storm.
- The served-view cap's unit with many groups: per server or per group copy.
- Where a merger lives, whether a live view moves when its server becomes leader, how feeds ride the wire ([LAYERS](LAYERS.md) 10 items 48 to 50).
- Models: a restore with removes, writer time with moves, sessions with a restore.

**The surface and libraries (L4, L5).**
- The 22 patterns end to end; today their key lines only compile.
- The small API questions Q-B1 to Q-B11 ([API.md](API.md) 11.2).
- What replaces v4's `peers` and `me` fields.
- v4 has no users, so there is no move from v4 to v5: DEP-19 (`fero migrate`) drops, and v5 need not keep v4's API, wire or files. Left: which of the 28 examples and the site are ported to v5 before v4 is retired, and where v5's code lives beside v4 in this repo.
- The queue, lock and consumer libraries' timings and checks.
- Door, TLS and hostile-client tests.

**Transformations and work over every row (late slices).**
- Paging across a failover; a `data` upgrade under live views.
- Defaults that are guesses (`views.client`, `views.rows`, `linger.ms`, a `memory` default).
- The merger on real sockets with `data`'s views as its parts; the audit; the scan's lease and image budget.
- A stated gap: a merger rebuilt while a group is down serves nothing new until it is back (V5-22 item 4).

**Records to bring in step (with the spec, M2).**
- Three stale rule records (`handback`, `par-repair`, `consumer-groups`).
- [STATUS](../../STATUS.md)'s one-line summaries of V5-12 and V5-14, which describe shapes later replaced.
- [DESIGN-V5.md](../DESIGN-V5.md) marked as a record of its day.
- The slot-listing item added to `data` 5's list.
- A link to this page from the [index](README.md) and from STATUS, when it is committed. Neither links it today *(counted)*.

**After the first build, as the record already says.** Answer stages, the mode that answers before the disk, relays, the tier and restore, the browser build, regions.

---

## 5. Questions for the owner

Four questions. Each stands alone. Earlier answers inform later ones.

**Question 1. Where should the line between Rust and JavaScript sit?**
Background: the record says TypeScript first, with Rust later. Rust from the start can mean three things. (A) Rust runs the disk, the log, the links and the copying between servers, and sends committed changes to clients. Rows stay in `data`, in JavaScript, on every server, as decided. (B) As A, and Rust also holds the rows as bytes on servers; JavaScript makes a row object only when app code looks at one. (C) As B, and Rust also runs the views that have no app function. What the study measured: a TypeScript kernel is already fast at the log; Rust buys a steadier tail and headroom above about 100,000 writes a second; the disk's flush and the socket write are the floors in any language. A is the shape of the fast native-core projects: native sockets and log, the app's state in JavaScript. B would reopen yesterday's decision on compact rows (V5-21): no compact rows in the first build, and later only inside `data` and only by a setting. A probe says B is about 4 times cheaper for rows no JavaScript reads on that server, about 1.8 times at a million rows and no gain at ten thousand rows if each row is read once; it is not yet a numbered experiment. Rust first has three costs in any form. fero ships one prebuilt binary per server platform, where today everything runs from source. A crash in native code takes the app's process down with it. Each kernel change needs a compile before its tests run, so a change takes longer to try.
- **Recommended:** A. Rust for the disk, the log, the links and fan-out; rows stay in `data`; V5-21 stands. One new record (V5-23) replaces "TypeScript first" in V5-6. B is weighed again only on a numbered experiment, and C later, if ever.
- Other ways: stay with TypeScript first, as recorded, and port to Rust later. Or B now, which undoes V5-21. Or a separate Rust server process beside the app, which keeps native crashes out of the app but changes "inside the app's own process".

**Question 2. May the first build be delivered as ordered slices, with work past one process's memory last?**
Background: the first build now holds the whole product, about 500 to 630 rules (a rule is one thing a builder must get right). The plan would cut it into slices. Each ends on something the owner can see and on pinned speed. The first is one thin path through the hard parts. The last slices are the merger and its parts: the pieces that add up a view or a scan over a resource bigger than one process's memory. You chose the merger in the first build (V5-20). This keeps that; it only means that until the last slices, a view past one process's memory is refused. It also means each model gates the slice that builds it, not all models before any code.
- **Recommended:** yes.
- Other ways: keep the stricter reading: every owed model first (about 6 to 11 weeks, a guess), and nothing called a first build until all of it is in.

**Question 3. Can a quiet machine be set aside for timing, and are the native speed bars the bars once it exists?**
Background: the machine the study ran on is shared and noisy. Even a control with no work in it missed the write bar there, and its disk stalls for tens of milliseconds. Each speed bar has two numbers, one for TypeScript and a tighter one for native code. For example, a write must commit within the hardware's floor plus 5 ms in TypeScript, plus 0.5 ms native. Rust met the tight one only in a test that imitated separate disks; no run on real separate disks exists. One bar cannot be met by any language while every write waits for the disk: the comparison with NATS JetStream as it ships, which does not wait for the disk on every write.
- **Recommended:** yes to both. Three small machines, or one with three disks, before the first timed step, and CI turned on. With Rust first, the native numbers are the bars, judged only on that machine; until it exists they are not judged. The one bar the disk rules out stays a stated miss until a later mode that answers before the disk has the write.
- Other ways: one quiet machine with one disk, with the disk-bound bars marked as not yet judged. Or keep the TypeScript numbers for the first build and tighten later.

**Question 4. Should a short spec, written in stages, replace the study pages as the thing to steer by?**
Background: the design now lives in more than 550,000 words of study pages, written as a history of changes. The proposal is a short spec in plain present tense. Before the build plan: one page for the whole system, a ledger with every rule as one sentence and how it is known, and the first step's shapes in bytes. Then one page per layer, written as the first piece of work of the slice that builds it, with a rule budget per slice. The study pages and the decisions stay as the record of why.
- **Recommended:** yes, in stages: the three first pages before the plan (1 to 2 weeks, a guess), the rest slice by slice.
- Other ways: rewrite everything before any plan (2 to 3 weeks, a guess). Or patch the main page in place and steer from it.

---

## 6. What this review did not check

- **Nothing in the study was run again.** Every number marked *(measured)* is the experiment's own, as its page reports it.
- **Pages were read in sections.** The decisions were read in full. [LAYERS](LAYERS.md) was read at 0.2, 0.4, parts of 3, 4 and 6, and 9 to 11. [API.md](API.md), [PATHS](PATHS.md), [TRANSFORMS](TRANSFORMS.md), [MERGE](MERGE.md), [EVERYROW](EVERYROW.md), CONNECT and ANYPATH were mostly searched, not read end to end.
- **Few experiments were opened.** E-02, E-03, E-04, E-05, E-08, E-10, E-11, E-13, E-17b, E-40, E-54, E-63, E-65, E-66 and E-67 were read in summary. E-53 is cited through other pages.
- **Some counts were not checked a second time:** PATHS B11's 84 to 127 ms, the line and reading counts in M2, DESIGN-V5's stale-slot claims, and VERDICT 9's kill row.
- **The probe of section 3.3 is not in the repo** and has the limits stated there. It made no real crossing between Rust and JavaScript.
- **uWebSockets.js was not measured or read in code.** Section 3.2 is reasoned from its public design.
- **No Rust Raft library was tried.** openraft has still not been looked at.
- **The cost of Rust's build step was not measured.** Section 3.5 states it as a reasoned cost; slice 0 measures it.
- **The sums are arithmetic on the pages' own numbers.** The rule range of 506 to 636 has known double counts. The counts of owed items are counts of lines, not of distinct pieces of work.
- **Every size in section 0 is a guess**, except where a page is named.
- **Not looked at:** the cost of hosting, regions, security beyond what the pages say, and how the build itself should be run and steered. The last is the build plan's subject, not this page's.
