# The build plan: how v5 is built, steered and kept lean

2026-11-24. [V5-23](../DECISIONS.md) decided Rust from the start for the native core, a first build in ordered slices, a quiet machine for timing and a short spec to steer by. It left four things owed: the build plan, the three first spec pages, the quiet machine, and slice 0's probes. This page is the plan, and it places the other three. Nothing of v5 is built.

**One thing is out of order, and this page says so.** V5-23 item 7 puts the three first spec pages (the system page, the rule ledger, the first shapes in bytes) *before* the build plan. This page was written before them. It does not change that decision. So the three pages are the first step (section 3.3), every rule spend on this page is provisional until the ledger is whole, and the owner accepts the real budgets at the end of that step.

**What was asked, in this page's words.** How is v5 built so that it never turns into a patchwork: clean and lean, very fast, and quick to change as it grows? How is a knock-on effect noticed, and when is a simpler shape across the board the right move instead of a local patch? How does an owner who does not read code still understand and steer the work, without letting it run blind and without reviewing every decision? In what order is the work done? How is the Rust choice made as good as it can be? What else matters?

**How this page was made.** Three proposals were written apart, each from one angle: how the owner steers, how the code stays lean and fast, and the order of work. A synthesis merged them: where they overlap it keeps one, and where they disagree it picks and says why (section 6.1). Then a skeptic read the merged page against the record and listed what did not hold: 5 blocking findings, 14 that should be fixed and 13 small ones. Each was checked against its source. All 32 held in substance and are fixed here; three were taken in a changed form, and section 6.3 says which and why. Nothing was run for this page but counts.

**Marks.** *(measured)*: timed in the named experiment. *(checked)*: read in the named place for this page. *(counted)*: a count made for this page. *(reasoned)*: an argument; nothing ran it. *(a guess)*: nobody measured it. *(from page X)*: taken from that page.

**Words.** The **builder** is whoever writes the code, people or tools. A **rule** is one thing a builder must get right ([SIMPLICITY](SIMPLICITY.md) 1.2). A **mechanism** is one named piece of state plus the rules that write it. A **layer** is one of L0 to L5 ([LAYERS](LAYERS.md) 0.2): L0 storage and links, L1 the log, L2 judging and folding, L3 flow to readers, L4 the public calls, L5 libraries. A **slice** is one ordered piece of the build that ends on something the owner can see. A **bar** is a number the build must meet ([REQUIREMENTS](REQUIREMENTS.md)). A **pin** is a test that holds a bar and is never loosened. A **seed** is one number that fixes every random choice of a simulated run, so the run replays exactly. A **model** is a small description of a rule set that a tool explores in full. A **planted mistake** is the code with one rule switched off on purpose, to see whether a test notices. The **kernel** is the code that decides what happens and does no I/O. The **shell** is the thin code around it that touches disks, sockets and clocks. A **crate** is one Rust package. **WASM** is the portable binary form that Node and browsers run. The **ledger** is the list of every rule, one sentence each. The **map** is the picture drawn from the ledger. A **kill line** is a result that stops a piece of work and forces a new choice. **`data`** is the sibling engine that holds rows and runs views; **`data` 5** is the version v5 needs.

---

## 0. The answer

1. **Copy v4's method, in Rust.** A kernel with no I/O, a thin shell, a simulator that runs the same kernel code on seeded schedules, pins that never loosen, examples with checks. The compiler holds the walls, not reviews.
2. **Go deep first, then widen.** First come the three spec pages V5-23 asks for. Slice 0 lays the ground and runs seven probes, each with a kill line. Slice 1 is one write through every layer on the final bytes, first simulated, then on real disks. Seven more slices each add rules beside that path. The work past one process's memory comes last.
3. **Three things go across from day one, on paper and in tools:** the shapes in bytes, the models, and `data` 5. That is the one good thing "rounds across" offers: far-apart parts clash early, while a fix is cheap.
4. **Every rule is one record in a ledger a tool can read.** Its code carries its id. A nightly run switches each rule off and records which tests fail. So any change prints what it touches: rules, tests, models, pins, pages. A second run changes lines that carry no id, to find rules nobody listed. Slice 0 proves this is cheap enough, or the plan falls back to a typed link (probe P6).
5. **The owner steers from one picture, the map, and from question cards.** A tool draws the map from the ledger, the test results and the pin results. Nobody types a status into it, so it cannot drift from the code *(reasoned)*.
6. **Nine gates send a decision to the owner.** Everything else the builder decides and logs in one line. The owner can pull any logged line up within a week.
7. **Budgets are checked by machines:** rules per layer and slice, pins that only tighten, counts at the line between Rust and JavaScript, no unsafe code in the kernel, fixed bytes, suite time, and the time to change one kernel rule and rerun (30 s, fixed now).
8. **Simplifying has a fixed moment.** Each slice ends with a short review that names the three hottest spots by count, and any check that never fired, so the process can shrink too. A proposal that drops rules across layers goes to the owner as a card.
9. **Each slice ends green or the next does not start:** models, 1,000 seeds, planted mistakes, pins on the quiet machine, the rule count, and one command the owner runs themselves that ends `ok`.
10. **Size, all a guess.** The first pages and nine slices, about 500 to 640 rules. With three streams of work side by side (the slices; `data` 5; the models), about 44 to 75 weeks: 10 to 17 months. With one stream, about 66 to 116 weeks: 15 to 27 months. Of that, the steering tools and checks are about 5 to 9 weeks, about one week in eight of the slices' own time. Nobody has said how many hands the builder has (section 7). The owner's share is about ten minutes a week, thirty minutes at most slice ends, about two hours at the end of slice 1, and one to three cards a slice.

---

## 1. How the owner steers

### 1.1 Three levels of spec

All in present tense. No dates and no history in the text. A decision's id sits only in the margin (V5-23 item 7). The pages live in a `spec/` folder inside v5's tree.

| Level | File | Holds | Size | The owner reads it |
|---|---|---|---|---|
| 1 | `spec/SYSTEM.md` | What fero is. The six layers, one sentence each. The line between Rust and JavaScript. The bars by id. The slices in order. One walk-through of a write. What is not built yet | One screen, about 600 words | Once, then when it changes (a gate) |
| 2 | `spec/L0.md` to `spec/L5.md` | One fixed template: the job; the state it keeps; its one interface, the only calls the layer above may make; its mechanisms, with their rules pulled in by id; its bars; its rule budget; what is not on yet | Two to three screens each | At the start and end of a slice that widens it |
| 2 | `spec/SHAPES.md` | The shapes in bytes: record header, positions, wire frames, the journal. One list of names and codes | As long as needed | Not in detail. A change to a fixed shape is a gate |
| 3 | `spec/ledger.json` | Every rule, one record each | About 500 to 640 records at the end *(from [READY](READY.md) M2)* | Through the map only |
| 3 | `spec/slices.json` | Each slice: its order, the rules it turns on, its budget, its models, its pins, what the owner sees | One record per slice | Through the map only |

**One ledger record.**

```
id        slot-move.4               mechanism . number; never reused
layer     L1                        a field, not part of the id: the split by layer is a reading (LAYERS 0.2) and may change
text      one plain sentence, present tense
known     model | seeds | spec | code | measured | reasoned
evidence  the model file and its run log, or the seed set
touches   the named state this rule reads or writes
decision  V5-18 pick 4              the "why", in DECISIONS
slice     3                         the slice that turns it on
low,high  the count's bounds, where the grain is unsure
sites     filled by a scan: where the rule's code is
tests     filled by the nightly run: which tests fail with the rule off
proof     switch | oracle | none-yet(reason)    how "proven" is earned (section 2.6)
```

`sites` and `tests` are never typed (section 2.6). `data` 5's items are records too, in a row of their own, "D", with a budget of their own (section 3.7). A rule that moves across the seam into `data` still counts.

**How the levels link.**

- **Up.** Each rule names its decision. [DECISIONS](../DECISIONS.md) stays append-only and is the record of why. The study pages stay as they are.
- **Down.** A rule's code carries its id. A model names the rules it covers.
- **Sideways.** `touches` gives every pair of mechanisms that share state. This is DEV-02's interaction list *(from REQUIREMENTS)*. `touches` is typed, so it can drift. The nightly run checks it: if switching rule A off fails a test that proves mechanism B, and the ledger shows no state shared by A and B, the map flags an **undeclared link**.
- **One home for each sentence.** A layer page does not retype a rule. It names the id and a tool fills in the text.

**The ledger gate** is one check in the test run. It fails when a rule claims a status it has no evidence for; when a marker in code names a rule that does not exist; when a layer page and the ledger disagree on which rules exist; or when a count is over its budget, by layer or by slice. It cannot see a rule whose code carries no marker. Section 2.6's second net is for that. Cost: one small script, the same shape as v4's glossary test, which already rejects dangling keys both ways *(checked: [eli5.test.ts](../../tools/debug/eli5.test.ts))*.

**The first job, before any budget is set.** The study's [simplicity.json](judging/simplicity.json) holds 126 records and 1,135 rules, but that is the whole catalogue, with v4's and the rival designs' mechanisms in it. The base is 55 of those records and 416 rules *(checked: SIMPLICITY 3.1 and its summary; LAYERS 0.2)*. Some of the 55 predate later decisions; the slot move's record is one, written before V5-18's one-commit form *(from the skeptic's reading; not rechecked here)*. The other 90 to 220 rules are prose, with known double counts *(from READY M2 and LAYERS 0.2)*. So the job is 55 records to bring up to date and 90 to 220 to write. It is the step before slice 0. A budget on a count nobody can list is not a budget.

### 1.2 The map

**One page. Rows are layers. Columns are slices.** A cell holds the mechanisms that slice builds in that layer. The right edge shows each layer's rules against its budget, and its bars against their pins.

```
fero v5                 S0 ground  S1 one write  S2 groups  S3 move ...  |  rules: on / budget    bars
--------------------------------------------------------------------------------------------------------
L5 libraries               .          [1]          .          .          |    8 / 59-69           -
L4 the surface             .          [1]          .          .          |    5 / 12-36           PERF-10 not judged
L3 flow                    .          [2]          .          .          |   14 / 82-133          PERF-11 3.4M / 3M
L2 fold and ops            .          [4]          .         [1]         |   33 / 76-81           -
========== the line: Rust below, JavaScript above =======================================================
L1 the log                [1]         [7]         [9]        [3]         |   91 / 193-195         PERF-08 0.71 / 1.2 ms
L0 storage and I/O         .          [4]         [3]         .          |   30 / 78              PERF-09 not judged
--------------------------------------------------------------------------------------------------------
data 5 (sibling)          D1 D2      lane        snapshots   by slot     |  its own perf suite
time to change one kernel rule and rerun 200 seeds:  22 s / bar 30 s
slice 1: week 6 of a guessed 7 to 11          steering tools and checks so far: 9 % of the time spent
open questions: 1      decided without the owner this week: 14      open bugs: 3 (was 2)      bars not judged: 9
unproven, reason given: 12 rules     undeclared links: 0     unmarked lines that carry behaviour: 3 of 40 sampled
```

The budgets are LAYERS 0.2's first-build counts *(checked)*. They sum to 500 to 592. This page's slice spends sum to 501 to 640, because they also hold the changes for many groups (+6 to +26) and V5-15's unpriced items, which LAYERS' sum leaves out *(checked, LAYERS 0.2)*. Two budget tables that disagree are one too many: the step before slice 0 ends with one table, layer by slice, cut from the ledger's real count, and both of these go. Every other number is made up, to show the form. `[7]` means seven mechanisms.

**The colour of a mechanism is its weakest rule.** Five states and one exception mark, each computed, none typed.

| State | It means | Computed from |
|---|---|---|
| planned | In the ledger. No evidence yet | The ledger alone |
| modelled | A model holds the rule and catches its share of planted mistakes (85 %, DEV-03) | The model's run log |
| built | Its code is marked and its seeds pass | The scan and the test results |
| proven | With the rule switched off, some test fails. For the ported Raft: etcd's files pass and the mechanical mutant score holds (section 2.6) | The planted-mistake run |
| unproven, reason given | The rule is built, no test catches it switched off, and a reason is written. It does not pull its mechanism's colour down, so a cell can still reach "proven"; it shows as a small count on the cell and on the map's last line. That count may rise only by a card | The planted-mistake run and the ledger |
| timed | Its pins are green on the quiet machine | The pin results |

Two more marks sit on top. **Not judged**: a bar with no run on the quiet machine. It is grey, never green. v4's perf baseline already has this honest third state *(checked: [BASELINE.md](../../tools/perf/BASELINE.md))*. **Reasoned only**: a rule known only by argument. It is hatched, so the owner sees at a glance how much of a layer rests on argument. In the base that is 128 of 416 *(from LAYERS 0.2)*.

**How it is made, so it cannot drift.**

- The page is a view of one file, `map.json`. That file is computed from the ledger, the slice records, the test results, the model logs, the pin results and the open cards. Nothing else feeds it.
- A gate test fails on any data-derived string that does not trace to a fact in those files. Absent data shows as absent. v4's debugger has this gate today, with a stated limit: it covers the strings made from data, and it names the page's own fixed words (labels, units) as a residue held by review *(checked: [honesty.test.ts](../../tools/debug/honesty.test.ts), its header)*. So the map page keeps its own fixed words in one short list, and the glossary test covers that list both ways.
- Every word a newcomer could not read at a glance has a tooltip from one glossary, as v4's [eli5.mjs](../../tools/debug/eli5.mjs) does *(checked)*.
- `map.json` is committed at each slice end. The next one is compared with it, as v4's scenario dashboard compares its numbers with a committed baseline *(checked: [scenarios.ts](../../tools/debug/scenarios.ts))*. A rule that vanishes, or a state that goes backwards, is a visible diff.

**From the whole to one rule: four steps, one click each.**

1. **The whole.** The grid. One look answers: where is the work, is a layer over budget, is a bar red, is anything waiting on me.
2. **A layer.** Its page, with live state beside each mechanism, its rule count over time and each pin's history.
3. **A mechanism.** Its rules as sentences. Its neighbours: every mechanism that shares state with it. Its bugs.
4. **A rule.** One card:

```
slot-move.4   L1   proven, timed                                   slice 3
"A slot's writes stop at the old group in the same commit that starts them at the new one."
Why:          V5-18 pick 4
Known by:     model (catches 34 of 45 planted mistakes; the other 11 change nothing)
Seeds:        1,000 pass.  Open the worst seed in the viewer >
Switched off: 2 tests fail.
Pins:         move window p99 4.1 ms against 10 ms, quiet machine, 12 runs
Touches:      slot table, carried set.  Shared with: sessions, subscribe, the merger
```

The sentence and the pin numbers are made up; the model's score is from READY M6. "Open the worst seed" goes to that exact run in v4's capture viewer, where the owner steps through it with tooltips. And up: from any rule, one click to its decision; from any decision, the rules it made.

**Reused from v4, and new.** Reused: the one shared model file ([model.mjs](../../tools/debug/model.mjs)), the glossary and its test, the honesty gate, the scenario cards with a click through to a run, the viewer, the server, the perf baseline's "advisory" and "pinned" states, and the study's own [simplicity.py](tools/simplicity.py) as the first ledger reader *(all checked to exist; read at their headers, not end to end)*. New: the ledger's extra fields, the grid page, the rule card, the change overlay, the question card.

**Built in two stages, so the tool is never ahead of the work.** With the first spec pages: the ledger, the ledger gate, and the grid printed as plain text. Days *(a guess)*. At the end of slice 1: the page, the rule card, the overlay. About a week *(a guess)*. Before that there is nothing to click through to.

### 1.3 What reaches the owner, and what never does

**The nine gates.** Each is found by a tool or a fixed count, not by the builder's feeling.

| # | Gate | How it is noticed |
|---|---|---|
| 1 | **A rule budget is breached.** A slice or a layer would go over | The ledger gate fails |
| 2 | **A bar is missed.** A pin is red on the quiet machine after one round of looking into it. Or anyone wants a bar restated | The pin results. A pin is never loosened (PERF-14) |
| 3 | **The spec changes above the work.** The system page, a fixed shape, anything a user sees (a public call, a default, a refusal code), or a rule in a layer the slice does not build | The list of pages a change touches |
| 4 | **A simpler whole is proposed.** One shape across layers in place of local rules | A change that drops more rules than it adds, across two or more layers |
| 5 | **A slice ends.** The owner sees it work and accepts it, or does not | The slice's record |
| 6 | **A kill line trips.** A probe or a model misses its stated line | The run log |
| 7 | **The stop rule trips.** Open bugs rise two weeks running, or one piece of work passes four review rounds (DEV-08). Or a slice passes twice its planned time *(the factor is a guess)* | Weekly counts on the map |
| 8 | **Evidence gets weaker, or a promise slips.** A rule moves from checked to reasoned. Something a slice promised moves to a later slice. The "unproven, reason given" count rises | The ledger's diff |
| 9 | **Anything is published outside the repo.** A package under the project's name, a release tag, the site (section 4.4) | The release script refuses to run without the card's id |

**Never reaches the owner:** names; how modules are laid out; data structures inside a layer; which helper library, within the list the budget allows; how a test is written; a bug fix that changes no rule; a rule reworded with the same meaning; a tidy-up inside one layer with the budget held and the pins green; speed work inside the bars.

**But all of it is visible.** Each such call is one line in a "decided without the owner" list on the map: what, which rule ids, one sentence of why. The list is seeded by a tool from the week's diff of the ledger and `SHAPES.md`, so a call that changed a rule or a shape cannot go unlisted; the builder types only the reason. A line with no reason is red. The owner can pull any line up within a week, and it then becomes a card. So the owner reads a few lines, not the code. Cost: one sentence per call.

### 1.4 How a question arrives

As a card, one at a time, in the form READY section 5 used.

```
Question 12.  Blocks: slice 3, the slot move.  Work goes on elsewhere for about 5 days.
Background   at most 150 words; every term explained; stands alone
The picture  the map with the change laid over it
Recommended  A. ...        costs: -1 rule in L1, one new field, 2 models run again, about 3 days
Other ways   B. ...        costs: ...
             C. leave it   costs: the bar stays a stated miss
If no answer the builder takes A's reversible part only, and waits.
```

The queue is ordered by what each card blocks. One card is open at a time. Every option names its cost in rules, bars and days. The answer becomes one line in DECISIONS and the card closes.

**How many cards, and what silence means.** A guess: one to three cards a slice beside the slice-end one. More than three in one slice means the gates are set wrong, and the builder stops to re-plan them with the owner instead of sending a fourth. If a card has no answer after five working days, the builder keeps to work that no open card blocks, and the map says in its first line what is waiting and since when. The builder never takes silence as a yes.

**Cadence.**

- **Any time:** the open card, if there is one.
- **Weekly, one screen:** the digest. What changed on the map: rules in and out by layer, pins that moved, the time-to-change number, bugs, the "decided without the owner" lines. About ten minutes *(a guess)*.
- **Each slice end:** the thing working, the map before and after, the simplify review (2.7). About thirty minutes *(a guess)*. Slice 1's end is the exception: the viewer, the dashboard, the first example, the pin sheet, the new map page and six thin layer pages. About two hours *(a guess)*, and the checkpoint at the end of 1a (section 3.4) takes the viewer's share early.
- **With the owner's own hands.** Each slice ends with one command the owner runs themselves, which ends `ok` as v4's example checks do. The dashboard takes any seed number the owner types and plays that run. So the showing is not only the builder's. Cost: nothing new; it is the example's check.

**What keeps the picture honest.** "Proven" is earned by a run, not claimed. The builder does not mark its own work: a second reader checks each slice's ledger records against its layer pages before the slice closes, as the study used a skeptic at each step *(from READY)*. Cost: an hour or two per slice *(a guess)*.

---

## 2. How the build stays lean, fast and quick to change

### 2.1 The shape of the code

One Rust workspace and the TypeScript layers, in one tree. The crates mirror the layers. v4 already has this shape: its kernel is 9,831 lines and its shell 885, tests and perf files left out *(counted)*.

| Piece | Language | Holds | May depend on | I/O |
|---|---|---|---|---|
| `wire` | Rust, no standard library | Every shape in bytes. Encode and decode only | nothing | no |
| `raft` | Rust, no standard library | The port of etcd's Raft, with etcd's test files as its proof | `wire` | no |
| `kernel` | Rust, no standard library | L1, and L0's decisions: groups, the home log, slots, routing, founding, healing, what to write to the journal and when. Events in, effects out | `wire`, `raft` | no |
| `flow` | Rust, no standard library | The part of L3 that only moves committed bytes: who is subscribed to what, credits, one batch per link per round | `wire` | no |
| `sim` | Rust | The simulation executive: the seeded scheduler, the fake network, disk and clock, crashes, replay for the shrinker | the four above | none real |
| `io` | Rust | The shell: disk flushes, sockets (TCP, and WebSocket for browsers), TLS, the door's crypto, timers, threads | all above; a short list of outside crates | yes |
| `node` | Rust | The addon Node loads. The only crate that crosses into JavaScript | `io` and below | the line |
| `wasm` | Rust | `kernel`, `flow`, `wire` and `sim` built as WASM, for the full-stack simulator, the site and the viewer | no `io` | no |
| `server/` | TypeScript | L2 to L5 on a server: judging, the seam to `data`, served views, the public calls, libraries | the addon through one seam file; `data` through one seam file | through the addon |
| `client/` | TypeScript | The client, the browser included (V5-23 item 1) | its own codec | sockets |
| `spec/` | text | Section 1.1's pages | | |

Why this split:

- **A crate is a wall the compiler checks.** `kernel` cannot call `io` because it does not depend on it.
- **A rule change recompiles little.** Editing `kernel` rebuilds `kernel` and what sits on it, not `wire` or `raft`.
- **Three seams, each one file**, as v4 has one seam onto `data` and one onto its config library: the addon seam, the `data` seam, the config seam. Nothing else imports across.

**One simulator, built twice.** The scheduler and the fake network live in Rust beside the kernel. Built native, it runs the kernel alone with no Node: the fast loop for kernel rules. Built as WASM, the same executive runs under Node with hooks into JavaScript, so `data`'s fold and the TypeScript layers run as steps of the same seed (TEST-09). The reason is measured: a real Raft in WASM was no faster than the TypeScript port because every message was packed to cross the line ([E-04](experiments/E04-wasm-kernel/README.md)) *(measured)*. With the network model on the Rust side, messages between simulated servers never cross it *(reasoned)*. Cost: v4's scheduler is written again. Slice 0's probe P2 holds the kill line (section 3.3).

### 2.2 The one boundary rule

**JavaScript is paid once per decision, never once per delivery. Bytes cross the line in batches** (READY 3.2).

- **A fixed, short list of calls** in one checked file. Adding a call fails the build until a layer page names it. A first cut: hand in a batch of judged writes; take a batch of committed records into a buffer the caller owns; open or close a subscription; read health; drain the recorder.
- **No call per record.** One crossing with 256 records costs 52 ns a record; one crossing per record costs 3.8 µs ([E-03](experiments/E03-napi-cost/README.md)) *(measured)*.
- **Fan-out never enters JavaScript.** Committed bytes go from the log to client links inside Rust, many records per socket write ([E-08](experiments/E08-relay-fanout/README.md): records per write set the rate) *(measured)*.
- **Native threads wake JavaScript once per round**, never once per record.
- **Rows are read only through `data`** (V5-21). No Rust code builds a row.

### 2.3 Two kinds of pin

A **counted pin** counts things. It gives the same answer on any machine, so it runs on every change. A **timed pin** measures time, and runs only on the quiet machine.

| Counted pin | Number | Source |
|---|---|---|
| Crossings per committed record at 50,000 writes a second | at most 1 per 64 | *(a guess; slice 0 sets it from E-03's curve)* |
| JavaScript calls per delivery on fan-out | 0 | *(reasoned)* |
| Encodes per record per link | 1 (PERF-11) | *(from REQUIREMENTS)* |
| Socket writes per link per round | 1 | *(from READY section 4)* |
| Heap allocations per record in the kernel's steady state | 0 | *(reasoned; v4 pins allocation today)* |

Cost: a counter at each boundary and a few tests. Why it pays: a speed regression is caught on the change that made it, on any machine.

### 2.4 Budgets a machine enforces

Each row is a check. A red check blocks the change. Numbers marked as guesses are set by slice 0 on real code, then held. The time to change is the exception: it is fixed now.

| Budget | Number | How it is checked | When |
|---|---|---|---|
| Rules per slice | The slice's budget | The ledger gate counts the slice's records | Every change |
| A pin never loosens | Any pin's number may only tighten | A script compares the pin file with the last commit. There is no override | Every change |
| No I/O, clock, thread or randomly ordered map in the kernel | 0 | The four kernel crates build without the standard library. A randomly ordered map broke 994 of 1,000 seeds when planted (E-04) *(measured)* | Compile time |
| Unsafe code | 0 lines in `wire`, `raft`, `kernel`, `flow`, `sim`. A counted, listed set in `node` and `io` | The compiler; a count that may only rise with a ledger line | Compile time |
| Layering | No upward edge between crates; three seam files in TypeScript | A graph check; an import check | Every change |
| Shapes are fixed (DEV-09), in two states | **Fixed for the build** (from the end of slice 1): a change is a gate 3 card; the format version rises; the golden files are made again; no reader of the old form stays in the code. **Fixed for users** (from the first public release): bytes change only by adding | A golden byte file per frame and journal batch; a changed file with no card id is red | Every change |
| Outside crates | Kernel crates: none. `io` and `node`: a named list of about ten *(a guess)* | An allow-list; a licence and advisory check | Every change |
| No stand-in in product code | 0 at each slice end (section 3.2) | A count | Every slice |
| The time to change | Edit one kernel rule, rebuild native and WASM, run 200 seeds. The bar is 30 s, fixed now for the whole build, and not reset from what slice 0 happens to measure. The native loop alone is reported beside it (a target of 10 s, a guess). Kill line 60 s | A script applies a canned one-line edit and times each step | Quiet machine, nightly |
| No platform-sized number in kernel state or on the wire | 0 uses of pointer-sized integers or floats there. The WASM build is 32-bit and the native one 64-bit; building without the standard library does not hide that | A lint; P2's byte check is the backstop | Every change |
| Suite time | Each layer's suite under 30 s (DEV-06). The whole per-change lane under 5 minutes *(a guess)* | CI timing | Every change |
| Binary size | The addon under 4 MB per platform; the WASM kernel under 500 KB *(both a guess)*. The browser client at its measured 27.9 KB gzipped ([E-40](experiments/E40-browser-client/README.md)) *(measured)* | A size check | Every change |
| System clock and random source in TypeScript | One file only, so a run stays a function of its seed (TEST-02) | A lint | Every change |
| Lines | Reported per layer and per rule (DEV-05). Not a gate: a line count is easy to game | A report | Every slice |

Cost: about a dozen small scripts and one pin file. Why it pays: each replaces something a reviewer would have to notice by eye, every time. The owner does not read code, so a line that only review holds is a line nobody holds.

### 2.5 The tests, simulation first

Everything deterministic runs anywhere. Only time needs the quiet machine.

| Tier | What it proves | Budget | Runs |
|---|---|---|---|
| T0. The compiler | No I/O in the kernel, no unsafe code, layering | Free | Every build |
| T1. Unit and oracle | The Rust Raft passes etcd's 41 test files, and random scripts give the same bytes as etcd's own Go code. CI carries a Go toolchain for that reference. Golden bytes for wire and journal | Seconds | Every change |
| T2. Kernel simulation, native | The kernel's rules under crashes, cut links, lost and late messages, torn disk writes. Monitors check each stated property at every step, as v4's M1 to M12 do | 1,000 seeds per change; far more overnight | Every change; nightly deep |
| T3. Full-stack simulation, WASM | The same seeds with `data` folding and the TypeScript layers as steps. Client histories pass an outside checker (TEST-13). Order across partitions is shuffled (TEST-12) | 200 seeds per scenario in 1 s (TEST-01) | Every change |
| T4. Planted mistakes | Each ledger rule that can be switched off, switched off, turns a named test red. Gate: 85 % caught, the rest listed on the map as unproven with a reason. Plus, at each slice end, mechanical one-line changes to a sample of lines that carry no marker (section 2.6). v4 has the idea in small: six hand-written mutations for one class of rule *(checked: [scoped-sweep.ts](../../sim/scoped-sweep.ts))*. That shows the method, not its cost at 500 rules; probe P6 measures the cost | About 500 short runs *(a guess; P6 times it)* | Nightly; touched rules on every change |
| T5. Models | The safety rules of replication and placement, explored in full, catching 85 % of planted mistakes (DEV-03). The simulator's traces replay through the model (DEV-07) | Under 1 hour each | When a rule in the model changes; at each slice end |
| T6. Contract with `data` | `data`'s own conformance suite, run from fero as v4 does. The codec guard between the Rust kernel and the TypeScript client, comparing state and not only output, with E-04's input classes (non-ASCII keys, integers past 2^32, numbers past 2^53) | Seconds to a minute | Every change |
| T7. Fuzzing | The wire decoder, journal recovery, the handshake and the WebSocket upgrade parser never crash, hang or read out of bounds on any bytes. The corpus lives in the repo | Seconds per change; 10 minutes a target overnight | Every change; nightly |
| T8. Real machines | Real sockets and disks: crash tests with a hard kill, the timed pins | Tens of minutes | Quiet machine, after each merge and nightly |
| T9. Examples | Each example's check starts the roles, asserts and stops them, as v4's 28 do | A budget per example | Every change |

Three rules keep this honest. Every bug arrives as a seed or a test (DEV-08), and the seed joins a list that runs on every change. A failing seed is shrunk to the shortest schedule that still fails, and opens in the viewer; v4 has both tools. Simulated and live runs write one trace format, so one viewer reads both (TEST-08).

**Two lanes of CI.** Lane A runs on any runner, on every change: T0 to T7, T9 and every counted pin. Nothing in it depends on timing. Lane B is the quiet machine, one job at a time: T8 and the timed pins.

**How a timed pin is judged.** Each run first measures the machine's own floors, the disk's flush and the socket write, as [E-01](experiments/E01-floors/README.md) did. Each run includes a control with no work in it. On the study's machine a control that judged nothing still missed the write bar *(measured, READY M5)*. So if the control fails, the run is void and is taken again. It is never a reason to move a pin. Every run appends its numbers to a file in the repo. A pin with under 10 % of margin left is flagged before it breaks.

### 2.6 How a knock-on effect is caught

A change in one place can break another in three ways. Each has its own net.

**Net 1: the ledger, for knock-ons that can be known.** The code that carries a rule is wrapped in a small marker with the rule's id. In Rust it is a macro around the block. In TypeScript (about half the rules live in L2 to L5) it is one call, `rule('id', () => ...)`, from one small file, which a test run can switch off by id and which costs one plain call otherwise. A scan lists every site. In a test build the marker can switch its rule off. The nightly run does that for each rule and records the tests that go red. So one command, given a change, prints: the rules whose code it touches; the tests that prove them; the other rules that share their state; the models to run again; the pins on that path; the pages that change; the budget after; and the gates it trips, if any. CI posts that list on every change. The map can draw it as an overlay: a local patch lights one cell, a knock-on lights a column.

A rule that no test catches when switched off is listed as unproven. A rule with code in more than three places is listed as smeared.

**What a marker cannot hold, said plainly.**

- **Not every rule is a block that can be switched off.** A field carried in a message, an order held by a type, a rule held by something being absent. Such a rule's record says `proof: oracle` and names the test or model that would fail without it, by hand. The map shows how many rules are of this kind. If fewer than 80 % of rules can be a switch, P6's kill line trips.
- **The ported Raft carries no markers.** Its 64 rules live in a faithful port, and wrapping blocks would end "faithful". Its proof stays etcd's 41 files, the random scripts against etcd's Go code, and the mechanical mutant score, as E-10 did it *(checked: 1,147 one-rule changes there)*.
- **Code with no marker is invisible to the ledger, and the budget rewards counting low.** The builder writes the records, picks the grain and is judged on the count. The second reader checks records against pages, not against code. So there is a second net that needs nobody's honesty.

**The second net: changes to unmarked lines.** At each slice end a tool makes mechanical one-line changes (E-10's operators: flip a comparison, drop a statement, change a constant) to a sample of lines in `kernel`, `flow` and `server/` that sit outside every marker. If a test catches such a change, that line carries behaviour no rule names. It enters the ledger as a rule and counts against the budget. The map shows it as one number: unmarked lines that carry behaviour, out of those sampled. Cost: one run per slice, about an hour of machine time *(a guess)*, and the tool, which E-10 already has for TypeScript *(checked: its mutation runner)*; the Rust one is new.

**Net 2: the simulator, monitors and models, for knock-ons nobody thought of.** A change that breaks a property turns a seed red, whatever the ledger says.

**Net 3: the pins, for knock-ons in speed.** Counted pins catch a new allocation or a new crossing on the change that adds it. Timed pins catch the rest that night.

**A change proposal is written only when a gate is in play.** The proposals differed here. One asked the builder to write a small change file before every rule-level change. The other let the tool work the list out from the change itself. This page picks the tool, because it costs the builder nothing and cannot be forgotten. A written proposal (which rules it drops, adds and rewrites, which shapes change, two sentences of why) is needed only for a change that trips gate 3 or 4, where it becomes the picture on the owner's card.

Cost: about 400 to 550 markers (Raft's 64 and the rules held by an oracle have none), one scan, one nightly run, one sampled run per slice. The marker costs nothing in a release build *(reasoned; P6 checks it for Rust and counts the call in TypeScript)*. Why it pays: it is the only link between the pages the owner steers by and the code. Without it the ledger drifts within a slice, and "what does this touch?" goes back to someone's memory.

### 2.7 How a simpler shape across the board happens

A local patch is the cheap move every time. A simpler whole has to be looked for on purpose, at a fixed moment.

**The signals, each computed and shown on the map.**

| Signal | Trips at |
|---|---|
| Rules per layer over time. Flow went from 33 counted rules to a range of 82 to 133 in the study *(from READY section 2)* | A layer or a slice over its budget |
| One rule's code in many places | More than 3 sites |
| Mechanisms that share state (DEV-02) | More than 10 pairs for one mechanism |
| Special cases of one idea in one layer | The third |
| A rule known only by argument added to a mechanism that was model-checked | Any |
| Rules added to a slice after it closed | Any |
| Bugs by pair of mechanisms. v4's open bugs sat where mechanisms meet *(from REQUIREMENTS section 5)* | A pair with a second bug |
| A pin's margin | Under 10 % |
| The time to change | Over 80 % of its bar |

**The simplify review** is a fixed half page at each slice end, half a day to two days of work *(a guess)*. It names the three hottest spots by these counts. For each it says either "no simpler shape found, because ..." or it becomes a gate 4 card. It looks across layers, not inside one. A change that drops rules is the only kind that may spend time on a closed slice without a bug.

**The process is reviewed the same way.** The review also lists every gate, budget check and signal that never fired in the slice, and the hours the tools took. A check that has not fired in three slices is dropped or merged unless someone can say what it guards. The share of time spent on steering tools is a line on the map.

**The gate for taking one.** Fewer rules in total, or the same rules with a better pin. No pin worse. Every model that covers a changed rule runs again.

**How a big one is done safely.**

1. The layer's interface stays. The new shape is built behind it, beside the old one.
2. Both run in the simulator on the same seeds. A monitor compares their state at every step, not only their output.
3. The switch is one commit. The old shape is deleted in the next.
4. Two shapes never live past one slice. A switch that cannot finish inside the slice is backed out.
5. If it changes a fixed shape in bytes, it carries a new format version and the owner's yes, and the old form's reader is deleted with the old shape. Before the first public release there is no user's data to keep, so nothing dead stays behind (section 2.4).

Why it pays: without a fixed moment, the simpler shape is always less urgent than the next patch.

### 2.8 How a change stays quick to make

The loop that matters: change one kernel rule, see it tested, pinned and watched.

| Step | Target | How it is kept short |
|---|---|---|
| Type-check | Seconds | Small crates; no code-generating dependencies in the kernel; a hand-written codec |
| Rebuild native, run 200 kernel seeds | 10 s *(a guess)* | Only `kernel` and above rebuild. No Node and no WASM in this loop. 200 seeds took 102 to 384 ms in E-04 *(measured)*, so the compile is the cost |
| The rule's own tests first | Seconds | The ledger names them |
| Rebuild WASM, run the full-stack seeds | 30 s in all *(a guess)* | One WASM instance reused: a fresh one per test took 7.3 ms against a 5 ms bar (E-04) *(measured)* |
| Counted pins | Under a minute | They count, so they need no quiet machine |
| Watch it | At once | The seed opens in the viewer |
| Timed pins | That night | Lane B |

The TypeScript layers keep v4's way: served from source, no build step.

**The loop is itself a pin**, fixed at 30 s now, first measured in slice 0, shown on the map and never loosened. Two things would slow it as the code grows, and each has a guard: compile time (the crate split and the outside-crate budget) and test time (the suite budgets, with deep runs moved to the night, never dropped).

**Habits that stop a patchwork.** One seam per boundary, one codec, one list of names. No second path behind a flag past the end of a slice. No note to fix later without a line in the ledger or the status page. A rule that turns out to be needed mid-slice goes into the ledger before its code, and counts against the budget. A slice does not start while the last one's exits are red.

---

## 3. The order of work

### 3.1 The pick: one thin path, then widen, with one paper round across

| Way | What it means here | Good at | Bad at |
|---|---|---|---|
| A. Layer by layer, bottom up | Finish L0 and L1 in full, then L2, and so on | Each layer written once | Nothing is whole for months. The hard parts meet at the very end. No end-to-end pin until then |
| B. Rounds across | Sketch every layer, then improve all in rounds | Far-apart parts clash early | Every rule is half on, so no budget can be read. A pin on a sketch means nothing. Every model is owed before round 1, which V5-23 rejected. All of `data` 5 is needed at once |
| C. One thin path, then widen | One write through every layer, then slices that add rules | Two of the five hard parts meet in slice 1, the rest in slices 3, 5 and 8, with models covering the gap. Pins exist from slice 1. Each slice ends on something to see | A thin path invites shortcuts, and a shortcut that stays is how a patchwork starts |

**The pick is C, with one paper round taken from B.** All three proposals agreed. The reasons:

- **The hard parts have never met.** Raft, slot moves, the merger, served views and exactly-once marks were each checked alone, most in one process *(checked, READY M4)*. Way C makes Raft and exactly-once marks meet in slice 1, with two groups and a simple live view over both. The slot move joins in slice 3, served views in slice 5 and the merger in slice 8. Until each lands, its model stands in for the meeting: the move's full model and E-67's merger rule on the one-commit move both run by the end of slice 3 (section 3.5).
- **v4 shows the cost of meeting late.** One fix where views met "rows move" took 41 commits and eight review rounds *(from [TRANSFORMS](TRANSFORMS.md) section 2's table, on V4-62)*.
- **Shapes are fixed early (DEV-09).** A shape nobody has run a write through is a guess. The thin path is the test of the shapes, so the bytes are drafted before slice 0 and fixed for the build at the end of slice 1.
- **Speed cannot be learned late.** No real run on separate disks exists *(checked, READY M5)*. Way C puts the whole hot path on the quiet machine in slice 1.
- **`data` 5 is a second project** *(READY M3)*. Way C needs a few of its items per slice.
- **Most late rules are only reasoned.** Way C builds the model-checked core first.

**The paper round.** Before slice 1 ends, the builder walks LAYERS section 8's walk-throughs (a write, founding, a heal, a slot move, a derived resource, a live link) against the bytes page, on paper. For each later slice the builder lists the seams it needs from L1 to L3. Cost: about a week of writing *(a guess)*. Why it pays: a field is cheap to add on paper and dear to add after the freeze.

### 3.2 Three guards that keep a thin path clean

1. **A thing left out is a named refusal.** A call that needs a later slice ends with a code, and the code is on the slice's page. Never a fake that says yes.
2. **Final shapes from the first write.** The final record header, the final wire, the final threads. No "simple version for now" of a shape. Thin in rules, never thin in shape.
3. **No stand-in lives in product code.** A stub may live in the simulator or the tests. The count in product code at each slice end is 0.

**A slice is done** when its models pass, 1,000 seeds are green, 85 % of its planted mistakes are caught, its pins are recorded on the quiet machine with every earlier pin rerun, its rules are within budget, its stand-in count is 0, the sampled run over unmarked lines has been read, the simplify review is written, and the owner has run its one command and seen `ok`. Then its layer interfaces are fixed as far as built.

**The same steps in every slice.** Write or extend the layer pages and the budget. Add the ledger records. Pass the owed models. Fix new shapes, with golden files. Write the monitors and the scenario first, and see them fail. Write the code, each rule marked; counted pins from the first commit. Add timed pins when the path is real. Run the planted mistakes. Run the simplify review. Show it working, with a one-page report: budget against actual for rules, pins, loop time and lines.

### 3.3 The first pages, then slice 0: ground

**The step before slice 0: the three first pages** (V5-23 item 7). No code.

- `SYSTEM.md`, with the list of server platforms in it, since that list shapes the I/O loop *(from READY section 4)*.
- The ledger, whole: the base's 55 records brought up to date, every other first-build rule as a record, including the 21 changes for many groups that live only in GROUPS today *(from READY M2)*, and `data` 5's items in their own row.
- `SHAPES.md` as a draft, with the recorder and health interface in it.
- With them, the smallest tools: the ledger gate and the grid as plain text.

**Size:** 1 to 2 weeks *(a guess, READY's own)*. **Its exit is an owner's yes:** the owner accepts one budget table, layer by slice, cut from the ledger's real count. It replaces every spend on this page. Until then gate 1 has nothing fixed to breach.

**Slice 0.** No product rule is built. Each probe has a kill line. A probe that hits it changes the plan before any slice starts.

| Probe | What runs | Kill line | If killed |
|---|---|---|---|
| **P1. The Rust Raft** | etcd's Raft ported to Rust, with etcd's own test harness (READY section 4). The reference is etcd's Go code, so the run needs a Go toolchain | Not 41 of 41 test files plus 4,000 random scripts byte for byte against etcd's Go code within 10 working days. A failing file is a bug to fix, so only a clock makes this a real line. The mutant score is reported, and must not fall below the TypeScript port's: about 74 % by the files alone and about 89 % with the random scripts, both estimated there from a hand-read sample ([E-10](experiments/E10-raft-port/README.md)) *(an estimate, not a measured score)* | A card to the owner. There is no ready fallback: the one Rust Raft crate the study ran passes none of etcd's 28 interaction files, and the other known one has not been read *(from READY section 4)* |
| **P2. The kernel in the simulator** | The Rust executive of 2.1, native and as WASM with JavaScript hooks, one instance reused. "Full-stack" here means: three simulated servers, two groups, and `data` 4 folding each committed batch as a step of the seed. No other TypeScript layer exists yet | 200 full-stack seeds over 1 s, or a fresh world over 5 ms (TEST-01). Or the two builds give different bytes on any of 1,000 seeds | Keep the executive in TypeScript as E-04 ran it (102 to 384 ms for 200 seeds *(measured)*), with the Rust kernel as WASM under it |
| **P3. The time to change** | A canned one-line edit to a Raft rule, rebuild native and WASM, 200 seeds. Reported as seconds per thousand lines for each build, then projected to a full kernel of about 10,000 lines (v4's is 9,831 *(counted)*) | The projection is over 30 s after the usual fixes (a light build for the simulator, no code-generating crates). A Raft-only crate passing says little by itself | Split `kernel` by mechanism into several crates before slice 1, and measure again. Still over: a card |
| **P4. Judge, cross and fold on one thread** | On a leader, judging and the fold share the main thread (V5-20 item 14). So: a real addon; JavaScript judges a write, hands it in, takes committed records back in batches of 256 into buffers the caller owns, and `data` folds them with a lean record format. At 10,000 rows held and at 1,000,000. Reported: records a second, and the p99 of time spent on the main thread per batch at 50,000 writes a second, garbage collection pauses included | Under 500,000 records a second at a million rows (PERF-09's per-process number: 2 µs a record for judging and the fold together, where a lean fold alone took 1,515 ns in READY's own probe *(from READY 3.3; its files are not in the repo)*). Or main-thread p99 over 0.3 ms, which leaves 0.2 ms of PERF-08's 0.5 ms for the Rust side *(the split is a guess; slice 0 sets it from the floors)* | Run READY 3.6's numbered experiment on rows as bytes. A card to the owner, since it could reopen V5-21 |
| **P5. One number for "applied once, in order"** | A model study, 2 to 3 days. Can one number per stream replace the five high marks, 32 rules? (READY section 2) | No saving of 3 rules or more, or a model fails | Keep the five. Nothing lost but the days |
| **P6. The markers** | Raft's 64 rules marked in a throwaway copy of the port (the real port stays unmarked, section 2.6), plus ten L2 rules marked in TypeScript. The switch-off pass runs over all of them and is timed. Each rule is sorted: a switch, or held by an oracle | More than 30 minutes projected for 640 rules. Or fewer than 80 % of the rules can be a switch | Fall back to the way section 6.1 turned down: a rule id typed on each test. The map's "proven" then rests on a typed link, and the map says so. The second net of 2.6 stays either way |
| **P7. The commit path on real disks, with no JavaScript** | [E-02](experiments/E02-pipeline/README.md)'s Rust stub, which is in the repo *(checked)*, run again on the quiet machine's separate disks. Hours | Commit p99 over the disk's floor plus a round trip plus 0.5 ms (PERF-08) | PERF-08's native number cannot be met by any kernel on this hardware. The bar goes to the owner in week 3, not week 12 |

P4 and P7 are here because slice 1's kill line dies on two things, and each should be tested first in the shape that will fail. PERF-08 has only ever been met by Rust on emulated disks, with a stub and no JavaScript in the path; no run on real separate disks exists *(checked, READY M5)*. P7 tests the disks alone, and P4 tests what JavaScript adds on the main thread. P4's only earlier timing is a probe whose files are not in the repo *(checked, READY 3.3)*. P5 is here because write numbering is built in slice 1. P6 is here because sections 1.2 and 2.6 lean on the markers, and nobody has timed them.

**Also in slice 0.**

- **The quiet machine** (V5-23 item 6): E-01's floors rerun on it, the bars restated in one column from those floors, both CI lanes turned on.
- **The rivals' numbers, alone.** Redis, NATS, etcd and a Kafka-like log, each run with its own tool on the quiet machine, with no fero. A few days *(a guess)*. It is an early warning, not PERF-01's fair run; that comes in slice 7.
- **The tools**: the marker and its scan (P6), the budget scripts. The ledger gate and the plain-text grid came with the first pages.
- **`data` 5 starts**: D1 and D2, its largest breaking pieces, and the small pieces slices 1 to 3 need (section 3.7), with `data`'s own perf suite.
- **The models start**: the one-commit slot move in full (READY M6), and founding with several groups.
- **Reported**: the share of the Raft layer that is fero's own by line count (DEV-04), and the ported Raft's licence notice.

**Rule spend:** 0 new; it proves Raft's 64. **Size:** 2 to 4 weeks *(a guess)*. **What the owner sees:** a one-page probe sheet. Each of the seven probes passed or killed, its number beside its line. The quiet machine's floors. The rivals' numbers. The grid in plain text. **What the owner runs:** one command that plays etcd's 41 files against the Rust port and ends `ok`.

### 3.4 Slice 1: one write, all the way

**The path.** A client writes a row to `orders`. `orders` is founded with two groups on three servers. The write commits on disk at a majority. Every copy folds it. A second client holds a live link to all of `orders` and keeps a running total over both groups in its own store. A deriver reads `orders` and writes `totals`, exactly once per record, through a leader's death.

**Order inside the slice: the simulator first, the real thing second.** The proposals differed on whether these are one slice or two. This page keeps one slice with two halves, because V5-23 asks each slice to end on pins and on something working, and the first half alone has no timed pin.

- **1a, simulated.** The bytes. The kernel in the simulator. Judging and the fold on top. The client and the live link. The deriver with marks. 1,000 green seeds. The recorder across the line. **The end of 1a is a formal checkpoint**, with its own size and its own showing: the owner follows one write in the viewer, types a seed into the dashboard, and runs one command that plays 1,000 seeds and ends `ok`. It is the first time the owner sees v5 run, about two to three months in *(a guess)*. Gate 7's clock runs on each half apart.
- **1b, real.** The journal, the sockets, the threads, the addon. Three processes and a hard kill. The pins on the quiet machine. A packed install run with plain `node` (DEP-20). The example. And one early number: the member and client links wrapped in the chosen TLS crate with a fixed test key, with PERF-08 and PERF-11 recorded both ways as advisory numbers on the map. Encryption per link changes the cost of "encode once, one write per link" and touches who owns a buffer, so its cost is learned here, in days, not in slice 7. The door's rules stay in slice 7.

| | In | Left out, each a named refusal |
|---|---|---|
| **L0** | One journal per process with group commit. One checksum per batch. A version on every frame and file. Member links on plain TCP. The lock file. The recorder, with its own cost held by a counted pin (bytes and calls per record) and a timed one (commit p99 with it on against off) | The object store. Old segments. Snapshots. Repair from a peer. TLS and the door: a server listens off the local machine only under a test setting |
| **L1** | The ported Raft, per group. Two groups fixed at founding. Three fixed voters. Elections. Write numbering. Routing by a fixed slot table | Healing, learners, hand-back, growth, a clean leave, the soft directory, the watchdog, the slot move |
| **L2** | Judging on main. Plain set and remove, and one conditional op. Sessions. Writer time. Marks ([E-61](experiments/E61-marks-from-code/README.md)'s three rules). `data`'s fold | Answer stages. The shape rule below a row, room writes, field guards |
| **L3** | Subscribe to a whole resource. Fan-out from committed bytes. Positions. Resume from the ring | Credits and pacing: a slow link is cut with a code. Served views. The merger. Scans. Folds |
| **L4** | `fero(name)`, `get`, `connect`, plain writes, one method. The TypeScript client for Node | The rest of the lens, `changes`, `past`, `memory`, most config keys |
| **L5** | `derive` in its record form, with marks | Every other library |

The view over both groups is the simple kind: one store in one process, fed by both groups. That costs about 2 rules and held on 19 million checks ([E-57](experiments/E57-transforms/README.md)) *(from GROUPS)*. The merger itself stays last.

- **Rule spend:** about 160 to 185 *(a guess, provisional until the ledger is whole)*. L0 about 30, L1 about 85 to 95 (64 are Raft's, proved in slice 0, so about 96 to 121 are new), L2 about 30 to 35, L3 about 12 to 15, L4 about 5, L5 about 8.
- **Gating models and checks:** P1's proof stays green on every change. A model for write numbering (owed). E-61's marks. Monitors over 1,000 seeds with a leader killed, a partition and a retry that lands twice: every acknowledged write applied once (F-02), nothing seen is undone (F-04), client histories pass the outside checker (TEST-13), the client's total equals the sum of both groups at every cut, the deriver's output equals a fold of its input. The codec guard. The decoder's fuzz test, nightly from here on. A small model of whether plain writes need `#sessions` to have a majority (item 12 of section 5).
- **Pins:** PERF-08, commit p99 within the disk's floor plus a round trip plus 0.5 ms, on separate disks. PERF-09, 500,000 persisted writes a second per process, fold included. PERF-09's other half, 2 million a second per writer, is recorded from this slice as an advisory number and pinned in slice 4, when the client's write path is whole. The recorder's two pins. PERF-11, 3 million deliveries a core-second. Section 2.3's counted pins. TEST-01's two numbers. The time to change.
- **`data` 5 items:** the version argument on `write` and the lane. Both change `data`'s surface, so slice 1 already runs on a `data` 5 pre-release, and that pre-release passing `data`'s own perf pins is one of this slice's exits. Everything else is as `data` 4 has it.
- **Spec pages:** all six layer pages start here, thin: the rules that are on, the rest named as "not on yet". `SHAPES.md` is fixed for the build at the end of this slice (section 2.4), except a short list of open fields: those the slot move's carried set adds (READY M6), and those of any mechanism in L1 to L3 that is still known only by argument. Each open field closes when its model passes, by the end of slice 3.
- **Size:** 1a 4 to 6 weeks, 1b 3 to 5 weeks, so 7 to 11 *(a guess)*. That is 9 to 17 new rules a week, against 4 to 10 in slice 5. The gap is on purpose but unproven: slice 1's rules are the model-checked ones with a port and experiments behind them, and slice 5's are mostly reasoned. If 1a runs past twice its size, gate 7 says so early.
- **What the owner sees:**
  1. **The viewer**: one write followed hop by hop, from the client's call to the disk flush, to both followers, to the fold, to the second client's callback, to the deriver's output, with the time of each hop.
  2. **The dashboard**: 1,000 seeds, green, with the chaos named.
  3. **The first example**: four terminals, three servers and one client, a check that ends `ok`. Stop the leader and the total keeps counting.
  4. **The pin sheet**: each bar, the floor, fero's number, the rival's number from slice 0.
  5. **The map as a page**, with the rule card and the overlay (section 1.2's second stage).
- **What the owner runs:** the example's check, which ends `ok`.

**Kill line for the slice:** if PERF-08 or PERF-09's per-process number misses on the quiet machine with the whole path in place, no later slice starts. Every later slice only adds weight to the hot path. PERF-08 is a MUST in REQUIREMENTS. PERF-09 is a SHOULD there *(checked)*; this plan holds it as a stop anyway, because V5-23's line (the fold in JavaScript on every copy) rests on it. A miss on either is a card, and restating PERF-09 is the owner's to choose.

### 3.5 Slices 2 to 8

Rule spends and sizes are guesses, and the spends are provisional: this page's split of LAYERS 0.2's counts, by reading. The budget table the owner accepts before slice 0 replaces them. Every slice that takes a `data` 5 pre-release has one more exit not written in each row: that pre-release passes `data`'s own perf pins. Every slice ends with one command the owner runs.

| Slice | Adds | Rule spend | Gating models and checks | Pins | `data` 5 items | What the owner sees | Size |
|---|---|---|---|---|---|---|---|
| **2. Groups that look after themselves** | Membership changes and learners. Healing. The hand-back with its cap. Growth from one voter. A clean stop and a leave. The watchdog. The soft directory. Founding with a candidate id. Local snapshots and log trimming. Repair of a damaged batch from a peer. A roll across two kernel builds (OPS-05), as a test of the mechanism. Health in full (OPS-02): this is the first slice where things fail, so every wait shows its reason, and what the native threads are doing is in health and in the recorder | 100 to 120 (L0 25 to 30, L1 75 to 90) | E-51, E-52 and E-59's models, now as monitors on real code. GROUPS 4.2 models 1 to 3. Founding with the directory; a clean stop behind a partition; many elections at once after a crash. A health test per failure (OPS-02) | PERF-12: 2,000 idle groups under 1 % of a core. The hand-back's pace and idle memory, measured again in Rust. Time from a death to a healed group. Restart time | Snapshots in a named format, rows as key, version and bytes | A server dies, a spare is promoted, the dead one returns and leadership is handed back, each step named in plain words. The same in terminals, with a fourth server joining | 4 to 8 weeks |
| **3. The slot move** | The move in one commit. The slot table in the home log. The carried set. The grow rule by size and load. Clients that learn new routes. The fold's two rules for a moved slot | 25 to 40 | The full move model at 85 %, started in slice 0. GROUPS 4.3 models 8 to 11. The carried set as one final list. [E-67](experiments/E67-merge-rule4/README.md)'s merger rule run on the one-commit move, so slice 8 is not surprised. Models, on the model track, for every mechanism of slices 5 and 8 that adds a field to L1 to L3 and is only reasoned today (`scan()` at one cut, the merger's pairing); a field whose model has not passed stays listed as open. **If the move's model fails:** the fallbacks are READY M6's, a move by reference or a restated window bar; either is a card, and costs this slice again, 3 to 5 weeks *(a guess)* | The move's window at or under 10 ms at p99, at 2,000 and 10,000 writes a second, with a real carried set. Growth from 1 to 16 groups, timed | List, snapshot and drop one slot's rows. The key index split into small tables. The row version as a column | A resource under steady load grows from one group to sixteen. No write fails. The total never slips. The viewer shows one move's window in milliseconds | 3 to 5 weeks |
| **4. The read surface** | The lens in full. The four read verbs. Positions. Credits and pacing. Methods on a path and at the root. The shape rule, room writes, field guards (V5-15). The memory guard. Config. The browser client, and its way in: a WebSocket listener in `io` (LAYERS calls it first class), with its own rules, counted in L0 (about 3 to 6, a guess, inside this slice's spend) | 90 to 110 (L0 3 to 6, L2 45 to 50, L3 20 to 30, L4 15 to 30, L5 about 3). V5-15's 13 items are priced first | E-55 and E-56's claims as checks on real code. E-61's planted-mistake score from 84 % to 90 %. Pacing in a real client and a reconnect storm. TEST-12's shuffle. The WebSocket upgrade parser joins the fuzz targets | PERF-10: a held-row read under 100 ns. 10,000 path lenses at no more than 1.3 times no lens. PERF-11 again with credits on. Fan-out over WebSocket at least 0.7 times TCP's (E-40's bar). PERF-09's 2 million a second per writer. The browser client's size | D1, D2, D3, D4, D6, D8a, N6, N7, F1 to F3, V1. The largest `data` 5 pre-release | The example ladder, ported rung by rung with its checks. The API tour runs as written. A browser tab live on a row, on the local machine only: with no TLS until slice 7, a browser on another machine is refused. v5 first looks like the product | 5 to 9 weeks |
| **5. Served views and transformations** | A served view on one copy off the leader. The cost-weighted cap and placement. Pages. `lookup`. The order channel. The `view` selector. `derive` in its view form | 30 to 50 | E-57's checks as monitors; each of its planted bugs must fail seeds here too. E-60. Paging across a failover. A `data` upgrade under live views | No view build blocks its copy longer than a stated slice of time (today 0.2 to 1.9 s in one block *(measured, from LAYERS 11)*). The ordered index against its guessed bar. The cost of a served frame | The merge contract C1 to C10, N1 to N5, N8, N9, D7, D8b, D8c, D9, chunked ordered views, operators that keep keys | A live leaderboard and a dashboard example, fed by one server, read by many clients | 5 to 8 weeks |
| **6. The libraries** | Locks, queues, consumer groups, sagas, `once` calls. They sit on slice 4's surface only | 45 to 55. 36 of the base's 50 are model-checked *(from LAYERS 0.2)*: the lowest-risk slice | The fencing checker and the outside checker on lock and queue histories. A paused holder, clock skew, a crash at every step of a saga | Lock acquire within one commit. Queue take and ack rates. An empty take writes nothing | None new | The 22 patterns end to end, each a short runnable example | 4 to 6 weeks |
| **7. The door, the tools and the rivals** | TLS and the door in Rust. Hostile-client tests. The CLI. The protocol gateways PERF-01 needs. The fair runs against the rivals. Prebuilt binaries for other runtimes and any platform added to the system page's list | 20 to 25 | The door's rules get a model; they are only reasoned today *(from READY 3.5)*. The fuzz corpus grown since slice 1 | PERF-02 to PERF-07 as far as the first build reaches. PERF-04 stays a stated miss (V5-23 item 6). Every earlier pin again with TLS on; slice 1b's advisory numbers say in advance what to expect | None new | One table: fero beside each rival, on the same machine, by the rival's own tool | 3 to 5 weeks |
| **8. Work past one process's memory** | Partials and the merger. `scan()` at one cut. Folds with fero's combines, and the audit. The sorted column for a live median. Slice 4's refusal goes away | 31 to 55, almost all reasoned today: the most to prove, so the most seeds | E-67 on real code. The models for `scan()` and the merger's pairing passed by the end of slice 3; here they run as monitors. Seeded checks for the folds. The merger on real sockets. A model that fails this late can no longer cost a field in L1 to L3; it can cost this slice's own rules | The cost of one change through a merged view. Scan pages a second. The rebuilt merger's floor | The merger's pieces, chunked quantiles, freeing a dropped source. `data` 5.0.0 final is cut here | A live total and a median over a resource larger than one process holds, right through slot moves and a server's death | 5 to 8 weeks |

**All nine:** about 500 to 640 rules, about 38 to 64 weeks *(a guess)*.

**What that sum leaves out, and the hands it assumes.**

| Track | Size *(all a guess)* | In the slices' sum? |
|---|---|---|
| The first pages, before slice 0 | 1 to 2 weeks | No |
| The nine slices | 38 to 64 weeks | Yes |
| The steering tools and checks: the map in two stages, about a dozen scripts, the markers, the paper round, nine simplify reviews | 5 to 9 weeks, about one week in eight of the slices | No |
| `data` 5 | 16 to 30 weeks: 5,000 to 10,000 lines against an engine of 7,699 (LAYERS 3.7), with its own tests and perf pins. Nobody has sized it in weeks before this line | No |
| The models | 6 to 11 weeks one after another, 3 to 5 side by side *(from GROUPS 0 item 10, for many groups alone; the later models add to it)* | No |

- **With three streams side by side** (the slices with their tools; `data` 5; the models): about 44 to 75 weeks, 10 to 17 months. Two sentences on this page assume it: that slices 1 and 2 are the time the move's model needs, and that slices 1 to 3 give D1 and D2 their months.
- **With one stream:** the tracks add up, about 66 to 116 weeks, 15 to 27 months.
- How many streams there are is not known (section 7). It is the first thing to settle after the owner's four answers, because it picks between these two figures.

**Why the move is third.** Its model needs one to two weeks or more *(from READY section 0)* and it needs membership changes to exist, so slices 1 and 2 are the time the model needs. It is not later because it touches the log, the fold, flow, sessions and the client's routes; everything built after it is built knowing rows move.

**Why the door is seventh.** Nothing in slices 3 to 6 leans on its rules, and the handshake's slot is in slice 1's bytes, so it adds no shape in bytes. It does change the shape of the cost: encryption per link. So slice 1b times the links with TLS on and shows both numbers on the map from then on. The cost of the late door: until slice 7, v5 runs only on a trusted network, and the system page says so. The decoder is still fuzzed from slice 1. This is a question for the owner (section 6.2).

**After slice 8** the first build is whole. What the record places later stays later: answer stages, the mode that answers before the disk, relays, the tier and restore, regions *(from READY section 4)*.

### 3.6 Where the spec pages are written

| When | Page | State |
|---|---|---|
| Before slice 0 | `SYSTEM.md` | Written, with the server platforms. Updated at each slice end with what is on |
| Before slice 0 | The ledger | Whole. Each rule carries its slice. The owner accepts the budget table cut from it. "Known" moves from reasoned to checked as slices land |
| Before slice 0 | `SHAPES.md` | Draft |
| Start of slice 1 | All six layer pages | Thin: the rules that are on, the rest named |
| End of slice 1 | `SHAPES.md` | Fixed for the build, but for the listed open fields |
| Start of each later slice | The layer pages it touches | Extended first, then built |
| End of slice 3 | `SHAPES.md` | No open field left. A change is still possible, by a gate 3 card with a new version and no old reader kept |
| The first public release | `SHAPES.md` | Fixed for users. Later changes only add |

V5-23 item 7 says one page per layer, written as the first task of the slice that builds it. With a thin path, every layer is first touched in slice 1. So this page reads the rule as: a layer's page starts at the first slice that touches it, and each later slice's first task is to extend it. A page is never more than one slice ahead of the code *(reasoned)*.

### 3.7 How `data` 5 runs beside the slices

`data` 5 is its own track, in its own repo, with its own perf suite. Section 3.5's column says what each slice needs. It is also where a patchwork could grow unseen, next door, in a published package. So the plan's guards reach it.

- **It is in the ledger.** Each `data` 5 item is a record in the "D" row, with a budget. A rule that moves across the seam still counts; it does not leave fero's total by moving. The simplify review looks across the seam too.
- **Its pins are a slice exit.** A slice that takes a pre-release does not close until that pre-release passes `data`'s own perf pins.
- **It is on the critical path from slice 1,** not slice 4: slice 1 needs the version argument and the lane, slice 2 snapshots in a named format, slice 3 the split key index and the version column.

- **Pre-releases.** `data` 5 lands on a branch as numbered pre-releases, one per slice that needs one. v5 pins a commit of that branch. Each pre-release passes `data`'s own perf and schedule suites. So fero's one seam onto `data` changes at most once per slice.
- **D1 and D2 start in slice 0**, though fero needs them only at slice 4. Slices 1 to 3 give them about three to five months *(a guess)*.
- **v4 is pinned to a `data` 4 tag** before `data` 5's first breaking change. Today v4's contract test follows `data`'s head.
- **Two checkouts of `data`, while two trees live.** v4 reaches `data` through one sibling folder, and one folder cannot sit at two commits. So v5's seam file points at a second sibling checkout, on the `data` 5 branch, and CI checks out both. Cost: one more folder for every builder to keep, and a CI step. It ends when v4 leaves the root (question 4).
- **A slice does not start until its `data` items are released.** If they are late, fero does the next slice that needs nothing new (slice 6 before 5, for one), or waits. It never builds its own copy of a `data` piece.
- **It has a lane on the map**, so L2 cannot stall with no warning.
- **Size:** about 5,000 to 10,000 lines against an engine of 7,699 *(a guess against a count, LAYERS 3.7)*; about 16 to 30 weeks *(a guess; section 3.5's table)*.

---

## 4. Rust, made as good as it can be

### 4.1 What the native core does, and what it never does

**It does** (V5-23 item 1): the journal, Raft, the links, replication, the wire, and the fan-out of committed bytes. That is L0, L1 and the byte-moving part of L3.

**It never does:**

- **It never builds a row** or runs a view. Rows stay in `data` (V5-21).
- **It never judges a write.** Judging stays in JavaScript on the main thread.
- **It never calls into JavaScript once per record or once per delivery** (section 2.2).
- **The kernel crates never touch a file, a socket, a clock or a thread**, and never use a map whose order can differ between runs.
- **It never runs user code.**

### 4.2 How it is written

- **Plain state machines.** The kernel is functions from an event to effects, as etcd's Raft is. No async code in it.
- **Bytes stay bytes.** The codec reads fields in place from a borrowed buffer. Records are not copied or turned into objects between the journal and the socket.
- **Fixed, reused buffers.** Per group, state lives in flat tables addressed by index. The steady state allocates nothing (a counted pin).
- **Checks stay on.** Integer overflow checks and the kernel's own invariant checks stay on in release builds, and the timed pins are taken with them on.
- **Threads at the edge.** One kernel thread owns a set of groups. A journal thread flushes. Link threads read and write sockets. They pass batches through queues, with no lock on the hot path. Slice 1 times 1, 2 and 4 link threads (READY section 4).
- **No async runtime in the shell to start with.** A small readiness loop per thread: fewer outside crates and a steadier tail *(reasoned; slice 1 times it)*.
- **One toolchain file** pins the compiler version. A strict lint list is part of the build.
- **One list of names and codes**, written once and generated for both Rust and TypeScript, so one code cannot mean two things.
- **Memory checks, nightly.** The kernel crates' tests run under Rust's interpreter that finds undefined behaviour. The `io` and `node` tests run under the address and thread sanitizers.

### 4.3 The costs V5-23 names, and how each is kept small

| Cost | How it is kept small | Where it is held |
|---|---|---|
| **A compile on every kernel change, native and WASM** | Small crates, so a rule change rebuilds little. The kernel loop needs no Node and no WASM. A light build for the simulator. The loop is a pin with a kill line at 60 s | P3; the time-to-change pin on the map |
| **A prebuilt binary per platform (DEP-20)** | The server platforms are listed on the system page before slice 0. CI builds them from slice 1, and a packed install is tested with plain `node` on every change, so the release path is run many times before it matters. Other runtimes come in slice 7. Size budgets in 2.4. Section 4.4 says who builds and publishes | Slice 1b; slice 7 |
| **A native crash takes the app down** | Few ways to crash: no unsafe code in the kernel, a counted set at the edge, sanitizers nightly, fuzzing on every byte that comes from outside. And one policy when it does: a kernel fault stops the process loudly, after the recorder writes its last inputs. Raft's state on disk makes a stop safe. The written inputs replay in the simulator, so every crash arrives as a seed. A test plants a fault and checks that nothing acknowledged is lost | Slice 1; the unsafe count on the map |
| **TLS and the door move to Rust** | A well-used TLS crate from the allow-list, never hand-written crypto. Its cost on the links is timed in slice 1b. The door's rules get a model and hostile-client tests. The handshake's slot is in the bytes from slice 1 | Slice 1b for the cost; slice 7 for the rules; hatched on the map until then |
| **A fuzz test of the wire decoder** | It starts in slice 1 with the decoder itself. The corpus lives in the repo and replays in seconds on every change; deep runs are nightly. Journal recovery and the handshake join as they are built | T7 |
| **Two kernels can disagree** (the codec guard, V5-23 item 3) | One kernel, built twice from one source; P2 checks the two builds give the same bytes. The only second codec is the TypeScript client's, held by the codec guard comparing state | P2; T6 |
| **Numbers taken on TypeScript are stale** (V5-8, V5-10) | Measured again in slice 2 on the quiet machine | Slice 2's pins |

The crash policy was a difference between proposals. One would stop only fero's copy and leave the app running where safe. This page picks stopping the process, because a half-alive native core inside an app is harder to reason about than a clean stop, and V5-23 already accepts that a native crash takes the app down *(reasoned)*.

### 4.4 Releases

Publishing is the owner's call every time (gate 9). Nothing leaves the repo by the builder's choice.

- **Tags.** Each closed slice may be published as a numbered pre-release, never as the package's main version. The first version without a pre-release tag is cut after slice 8, and is the moment shapes become fixed for users (section 2.4).
- **Binaries come only from CI.** The per-platform binaries are built by lane A from a tagged commit, with a record of which commit and which toolchain made each. No binary built on a builder's own machine is ever published.
- **`data` 5 inside the package.** The package depends on a pinned `data` 5 version and is tested as packed, with plain `node`, on every change (DEP-20). `data` 5's own releases are the owner's call too.
- **The site** changes with a release, not with a slice (question 4).

Cost: one release script and one card per release. Why it pays: a package under the project's name is a promise to strangers, and that is not the builder's promise to make.

---

## 5. What else matters, ranked

1. **Count the rules before budgeting them.** A fifth to a third of the first build's rules have no rule text, and the range has double counts *(from READY M2)*. Every budget and the map rest on the ledger being whole. It is the step before slice 0, and the owner accepts the budgets cut from it.
2. **Two speed risks are unmeasured: the commit path on real separate disks, and judging plus the fold on one thread.** Probes P7 and P4 measure them before any slice. If either misses, the owner hears in slice 0, not at slice 1's kill line.
3. **The owner's window is built in slice 1.** The recorder, the viewer and the dashboard are how a person who reads no code sees a run. Their interface across the line is one of the first shapes. If it comes late, each layer grows its own way of reporting, and slices 1 to 3 are invisible.
4. **`data` 5 is a second build on the same critical path, from slice 1** *(READY M3)*. It has a row in the ledger with a budget, a lane on the map, numbered pre-releases whose own perf pins are a slice exit, and a rule that fero never builds its own copy of a `data` piece.
5. **The quiet machine is a single point.** If it is late, slices can pass their models but not their pins. Rule: work may run at most one slice ahead of a slice whose pins are not judged. And bars stay grey until judged; the map shows the count of grey bars beside the green.
6. **A private timing machine on a public repo is a risk.** It runs only code from trusted branches, never from an outside change. Lane A on shared runners takes outside changes.
7. **Someone other than the builder checks each slice.** The planted-mistake run and a second reader. A builder marking its own rules green is the quiet way a map turns false.
8. **The repo must carry all the context a new builder needs.** At each slice end, a builder who has seen only the system page, one layer page and the ledger makes one small change in that layer. If they cannot, the spec has fallen behind the code. Cost: an hour or two *(a guess)*.
9. **Versions on every byte from the first day, and a roll test in slice 2.** Even with no users, the builder's own journals and traces cross slices.
10. **A crash is a seed** (section 4.3). Decided in slice 1, with its test.
11. **Close the old pages as the new ones open.** The study is more than half a million words *(from READY)*. Each study page that a spec page replaces says so at its top, or a builder will build from the wrong one.
12. **`#sessions` is one shared dependency under every resource.** While it has no majority, no new client can start writing anywhere *(reasoned, LAYERS 0.4)*. A small model in slice 1 shows whether plain writes need it. After slice 1 the answer is dear to change.
13. **The fair runs against rivals come late.** They need gateways, which are slice 7 and a lot of code that counts toward the code budget (DEV-05). Slice 0's solo runs are the early warning.
14. **When v5 takes the public root and the site** (section 6.2, question 4). Left open, two trees and two checkouts of `data` live side by side with no end date.
15. **Publishing is a gate** (section 4.4). Nothing in the first draft of this plan said when v5 is first published or who builds the binaries.
16. **What an operator sees is built early, not last.** The recorder's own cost is pinned in slice 1 and health is whole in slice 2 (OPS-02), so the native threads are never a dark box.
17. **The process must be able to shrink.** Its share of time is a line on the map, and a check that never fires is dropped at a simplify review (section 2.7).
18. **Two things to time once slice 1 is real,** each with a kill line and neither in the first build: judging off the main thread, and a server with no Node in it *(both from READY section 2)*.

---

## 6. What is decided here, and what needs the owner

### 6.1 Decided here

These are the builder's kind of call, or picks between proposals. Each can be pulled up.

| Pick | Other way | Why |
|---|---|---|
| Nine slices, 0 to 8; the merger last | Eleven slices, with a simulated-only slice and hardening after the merger | V5-23 item 5 puts the merger last and wants each slice to end on pins and something working |
| Slice 1 is one slice with two halves, simulated then real; the end of 1a is a formal checkpoint with its own size and showing | Two slices | The simulated half alone has no timed pin, but the owner should not wait for 1b to see v5 run |
| The simulator's executive is in Rust, built native and as WASM | Keep v4's TypeScript executive over a WASM kernel | Messages between simulated servers never cross the line; a kernel loop with no Node. P2's kill line falls back to the other way |
| Markers in code, and the nightly run finds which tests prove a rule; the ported Raft exempt; a sampled run over unmarked lines beside it | A rule tag typed on each test | A machine fills the link, so it cannot go stale. P6 holds the kill line and falls back to the other way |
| The tool works out what a change touches; a written proposal only when a gate is in play | A change file before every rule-level change | No cost to the builder; cannot be forgotten |
| Planted mistakes: 85 % is the gate, on models and on code; the rest listed as unproven | 90 % on code | One number, DEV-03's; the unproven list is on the map either way |
| Over budget stops the slice for a simplify look; still over is a card | A 10 % allowance, or a stop only at 1.5 times | One rule, and the budget is already a range's high end |
| The simplify review is half a day to two days; taking a change is separate, carded work | A fifth of every slice set aside | A fixed share is spent whether or not a simpler shape exists |
| The time-to-change bar is 30 s, fixed now; kill line 60 s; P3 kills on a projection to the full kernel | A bar set from what slice 0 measures | A bar set from a first measurement is a bar that fits whatever was built |
| Shapes are fixed for the build from slice 1 (a change is a card and leaves no old reader), and fixed for users only from the first public release | Additive-only from the end of slice 1 | With no user for the whole build, additive-only would keep dead fields and block the simpler-shape move |
| While two trees live, v5 sits in its own folder and reaches `data` 5 through a second sibling checkout; v4 keeps its per-change test run on a `data` 4 tag | Drop v4's test run once slice 1 passes | v4's tools are reused by v5, so they should stay tested. Layout is the builder's call |
| The step before slice 0 is the three first pages, as V5-23 item 7 orders | Keep them inside slice 0 | That would change a decision; this page does not |
| A kernel fault stops the process, after the recorder flushes | Stop only fero's copy, keep the app up | Section 4.3 |
| File and folder names (`spec/`, the crate names) | Any | Names never reach the owner |

### 6.2 Questions for the owner

Four, in the order they block work. Each stands alone.

**Question 1. Is this the way you want to steer?**
You do not read code. This page proposes that you steer from one picture, the map: layers down the side, slices across, each cell coloured by how well its rules are proven, drawn by a tool from test and timing results so nobody can type a status into it. Nine kinds of event reach you as a one-page card with a recommended pick:

1. A rule budget is breached.
2. A speed bar is missed.
3. The system page, a fixed byte shape, or anything a user sees changes.
4. A simpler shape across layers is proposed.
5. A slice ends.
6. A probe or a model hits its kill line.
7. The stop rule trips: bugs rising, review rounds piling up, or a slice at twice its time.
8. Evidence gets weaker, or a promise slips to a later slice.
9. Anything is published outside the repo.

Everything else the builder decides and logs in one line you can pull up within a week. Each slice ends with one command you run yourself. Your time: about ten minutes a week, thirty minutes at most slice ends, about two hours at the end of slice 1, and one to three cards a slice *(a guess)*.
- **Recommended: A.** The map, the nine gates, the weekly digest. Cost: one to two weeks of tool work in two stages, and one ledger record per rule *(a guess)*.
- **B.** The three levels of spec and the cards, with the map as plain text only. Saves about a week. You lose the click from the whole down to one rule and its run.
- **C.** A with fewer gates: drop 3 and 8. You then hear of a changed shape or call, and of weaker evidence, only in the weekly list, after the fact. Less of your time, more decided without you.

**Question 2. Is this the order, with the network door late?**
The plan is one thin path first: slice 1 takes a single write through every layer on real disks. Then groups that heal (2), the slot move (3), the read surface and the examples (4), served views (5), libraries (6), the door, tools and rival runs (7), and work past one process's memory (8). The door (TLS and the check that a peer may join) is seventh because nothing in between leans on it and its place in the bytes is fixed from slice 1. The cost: until slice 7, v5 runs only on a trusted network, and the first fair table against rivals comes near the end.
- **Recommended: A.** The order as written.
- **B.** The door moves to slice 2. v5 can run on an open network five to eight months sooner *(a guess, from this page's sizes for slices 2 to 6)*. Slices 3 to 7 each start three to five weeks later; slice 8 starts when it would have. The door's rules are then built before their model has had time. The plan already times the links with TLS on in slice 1b under either pick, so B's gain is the open network, not the timing.
- **C.** The rival runs move earlier, to just after slice 4. It needs the gateways built early, about three to five weeks, before the surface they sit on has settled.

**Question 3. Which quiet machine, and who holds it?**
No speed bar can be judged without it (V5-23 item 6), and slice 0 needs it. "Quiet" has to mean: real hardware with nothing else on it, with its own local disks. The study's own machine was not: a control that did no work still missed the write bar, and its disk stalled 22 to 52 ms in every run *(from READY M5)*. A rented virtual machine shares its disk and processor with strangers, so it cannot be counted on to be quiet either *(reasoned)*. It must also run only trusted code, since the repo is public. Whichever you pick, the recommendation is that you hold the account and pay for it, and the builder gets a key that can only start timing jobs: it is money, and it outlives any one builder.
- **Recommended: A.** Three small dedicated machines in one place, each with its own local disk. The commit bar includes a network round trip, and only this has a real one *(reasoned)*. Cost: about 150 to 400 US dollars a month to rent *(a guess; nobody has priced it)*, or three small machines bought once, and their upkeep.
- **B.** One dedicated machine with three disks. About 60 to 150 US dollars a month *(a guess)*, and simpler to keep. The network hop is loopback, so the commit bar is judged without a real round trip and is taken again when real machines exist.
- **C.** Start on B for slice 0's probes and move to A before slice 1's pins. Costs one re-baseline, and probe P7 then runs twice.

**Question 4. When does v5 become what the public sees?**
Where the code sits while it is built is the builder's call (section 6.1: v5 grows in its own folder beside v4, and v4's viewer, dashboard and examples stay tested because v5 reuses them). What is yours is the public face: the repo's root, the README a visitor lands on, and the site. v4 has no users. While both trees live there is a running cost: two test runs, and two checkouts of `data` at two versions.
- **Recommended: A.** When slice 4's examples pass. v5 then first looks like the product: the example ladder and the API tour run. v5 takes the root and the site; v4 moves to a branch, as the older trees did. The two-tree cost lasts until then, about 5 to 9 months *(a guess)*.
- **B.** Now. The root and the site say v5 from today, and v4 moves to a branch. No two-tree cost. But v4's tools must be copied over first, a visitor finds nothing that runs until slice 1, and the site shows a product that does not exist yet.
- **C.** At the first public release, after slice 8. The public face changes once, when v5 is whole. The two-tree cost lasts the whole build.

### 6.3 What the skeptic's review changed

All 32 findings were checked against their sources and held in substance. The main changes: the three first pages moved in front of slice 0, as V5-23 orders, and every spend became provisional; the size now names its streams and the tracks it had left out; the markers got a probe with a kill line, an exemption for the ported Raft, a TypeScript form and a second net over unmarked code; slice 0 got two speed probes in the shape slice 1 can fail in; shapes got two states, so nothing dead is kept while there are no users; publishing became a gate; `data` 5 came under the ledger and the budgets; the WebSocket way in, health and the recorder's cost each got a slice.

Three were taken in a changed form.

- **The pace of slice 1.** The finding counted 20 to 37 rules a week. 64 of slice 1's rules are Raft's and are proved in slice 0, so the new ones are 96 to 121. The slice was still too tight: it is now two sized halves, 7 to 11 weeks, 9 to 17 rules a week. That is still faster than slice 5, and the page says why and marks it unproven.
- **PERF-09 at the kill line.** The finding is right that PERF-09 is a SHOULD. The plan keeps it as a stop for slice 1 anyway and says so, because V5-23's line rests on the fold being affordable. The per-writer half is recorded from slice 1 and pinned in slice 4.
- **The second Rust Raft crate.** The finding said, from memory, that it is built on async code. Nobody has read it, so this page does not repeat that. It says only that there is no ready fallback, and P1's miss is a card.

---

## 7. What this page did not settle

- **Nothing was run.** Every *(measured)* is the named experiment's own. No tool here is built.
- **Every rule spend and every size is a guess**: a split of LAYERS 0.2's counts by reading. The ledger replaces the spends before slice 0. Nobody has built any of this, so the months are the weakest numbers on the page, and `data` 5's weeks and the machine's price the weakest of those.
- **The guessed numbers that slice 0 must set**: the crossings-per-record pin, the split of PERF-08's 0.5 ms between the main thread and the Rust side, the binary sizes, the per-change lane's time, the list of outside crates.
- **Whether a planted-mistake run is cheap, and how many rules can be a switch.** Probe P6 measures both, with a kill line and a fallback. The sampled run over unmarked lines is new for Rust; its cost is a guess.
- **The `data` 5 items per slice** were placed by layer, not checked one by one against code, since there is none.
- **Who the builder is, and how many.** The size has two figures because of it (section 3.5). Slice 6 can run beside slice 5 only with spare hands. The second reader of section 1.4 needs a second someone.
- **What happens if P1, P4 or P7 misses.** Each goes to the owner as a card; this page does not pre-decide them. P7's miss would mean a bar restated before any code.
- **The first release's version numbers and the exact platform list.** The system page names the platforms; the release card names the version.
- **v4's tools were read at their headers**, not end to end. How much of the viewer carries over to v5's recorder is known only after slice 1a.
- **The gateways for rival tools**: which ones the first build needs is not listed here.
- **The study pages' "this is a record" notes** (item 11 of section 5) are owed with the first spec pages; this page edits no other file.
