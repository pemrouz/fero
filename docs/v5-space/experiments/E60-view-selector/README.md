# E-60: the `view` selector and a folded resume, in E-31's subscribe model

**Question.** LAYERS section 11 owes two models of the read surface before the first build slice ("Owed for the read surface", items 1 and 9):
1. **The `view` selector** (E-55 claim 22; TRANSFORMS XA-14, never run). E-31's subscribe model with a `view` selector: view instances (one copy serves each, off the leader, V5-14 pick 3), the ring resume, the wait for `seen` and a terminal `END`, through a failover, a reload, a slot move, a slow reader and a resume by a new picture. The bar: every property held, and at least 90 % of mutants caught. The result decides L3's +4 to +6 rules.
2. **A folded resume** (V5-13 pick 7; CONNECT 10 Q3). E-31's model with a base the client holds, so a client that comes back sends what it holds and gets only what it lacks, before `connect({ resume })` is taken. Does it keep every property, and what does it save?

This is the second form of E-60. A review found that the first form checked the selector over a link that never kept a late message, with a copy that read the client's live state, with a group B that never failed, and with a floor for tombstones that a wrong rule could not break. This form fixes those and runs everything again. Section 7 lists each finding and what changed.

**In short.**
- **The `view` selector holds every property but the docs' END** (model-checked, every reachable state explored). On thirteen bounds that finish, of up to 2,650,788 states: three copies and a slot move to a group of two, one client, a leader crash, follower crashes and reloads in both groups, a dropped link, a `SUB` given up and sent again on the same connection, a slow reader, a ring of one or two frames, and the leader serving when it is the only ready copy. The copy knows only what the `SUB` carried. The client only ever shows the view's value at a committed prefix, never goes back on its FIFO connection, never doubles or misses a change, and gets a picture at or past what it had seen when it subscribed, its answered write included. Two bounds too big to finish: 3,000,000 states and 20,000 walks each, nothing broken. Planted bugs: 7 of 8 caught in 4 to 12 steps; the eighth (`noinst`) cannot fail on a FIFO connection.
- **The docs' END fails; the design's END holds per entry** (model-checked, 15 steps). API.md 3.10 says `views.rows` is checked on every commit and the end stays. But a copy that reloads before it folds the too-big commit builds the view again from newer rows, and if it fits, serves it: the client passes the end with no END. Per entry, END is never false, never early, final, and an ended entry never serves again (E3, new). Writing the end into the log is not enough on its own. Either the docs say so, or every copy checks every declared view on every commit. Questions for the owner, item 1.
- **L3: +7 rules for the `view` selector, past the top of +4 to +6.** Each is needed alone in the design: `seen` from the write's answer and from each picture, ring resume and frame, and END told apart, ending the link and never followed by a new `SUB`. DEV-10's smallest model keeps only 2 (`seen` from the answer and from a picture), because on this short script a client can reach the end without END. With the docs' END and a link that can reorder, about +9 *(reasoned)*.
- **Mutants: 100 % of the finished smallest model's** (27 of 27 non-equivalent), 95 % of the folded resume's (20 of 21). The ablation's own smallest model, as it left it, scores 76 % (41 of 54): it kept 12 rules only because their runs hit the state limit, and the capped runs show 11 of them are not needed.
- **The folded resume keeps every property**, and now with real tombstones: a copy holds only what it folded, and a snapshot or a move carries none. Its own checks: answer folded only while the floor reaches back to the cursor (without it, a ghost row in 14 steps), save the base as one record (8 steps), and keep the floor right at a snapshot, at the window and at the move (14 to 16 steps each, checked now). That is +2 by DEV-10, +3 grouped, the low end of CONNECT's +2 to +3. **It saves most bytes when the client missed few writes:** 0.01 % to 10 % of a picture for 1 to 100 missed writes (1,000 seeds, 8,000 resumes, 0 wrong). When the client missed about as many writes as there are rows, send the picture instead (a cost rule).
- **What the review changed** (section 7): a faithful copy and P9 as the docs promise it, pass 1 on the two-fault bounds, FIFO connections with late messages, faults in group B and the leader serving, E3, real tombstones and three floor rules, a row set twice, harness gaps near the window, and every claim run and kept. Eleven of its twelve findings hold as written; the link finding holds for late messages, not for loss or reordering, which TCP does not do.

## Words used here

- **Served view** (TRANSFORMS 3.8): a live view a method declares with `{ view }`. The client asks for it with a `SUB` whose **`view` selector** names the method and its argument. One copy keeps it for every client that asks.
- **Copy**: a server that holds a full replica of the slot. **Leader**: the copy that takes writes. **Owner**: the one copy that serves a given view: the first live, loaded copy that is not the leader, in an order fixed by the view's key (rendezvous hashing, V5-14 pick 3). If the leader is the only ready copy of its group, the leader is the owner until a second copy is ready (V5-17).
- **Entry**: the owner's record of one served view. Its **instance** is (copy, incarnation, counter), unique across copies. Its **frames** are the commits that changed the view, numbered 1, 2, ... (the **frame sequence**). Its **ring** keeps the last K frames.
- **Picture**: the view's whole value, with its instance, frame sequence and log position. The client takes a picture as one commit that replaces what it shows.
- **Ring resume**: a `SUB` that names (instance, sequence). If the owner's entry has that instance and the ring reaches back, the answer carries the missed frames inside it. Otherwise a picture.
- **`seen`**: the highest log position the client has seen, in any frame, picture or write's answer. The `SUB` carries it, and a picture waits until the copy's store is at or past it.
- **Connection**: one FIFO queue of messages from one copy to the client. Nothing in it is lost, doubled or reordered (TCP). A **late message** is one the copy sent for a `SUB` the client has since given up; a `SUB` again on the same connection still gets it, first.
- **END**: `END moved` sends the client to the owner; `END view-too-big` ends the view (terminal). `views.rows` (R here) is the most rows a view may have.
- **Slow reader**: a connection holds one message (two in the `fifo` bounds), so a reader is as slow as the interleaving makes it. A reader whose next frame has left the ring gets a picture.
- **Folded resume** (CONNECT 10 Q3): `connect({ resume: cursor })`. The client keeps a **base** (its rows at a cursor) and sends the cursor; the copy answers with the rows whose version is newer than the cursor, plus its **tombstones** (removed rows) newer than it, if its tombstones reach back that far. Else a new picture.
- **Tombstone floor**: the oldest cursor a copy claims its tombstones reach back to. A snapshot carries rows and versions but no tombstones.
- **DEV-10**: a **rule** is one guard conjunct or one state update in a model action; it is **needed** if removing it lets the checker find a counterexample (ablation). **Mutants** are made by script: drop each kept rule, flip each comparison, swap each pair of updates in one action. **Planted bugs** are hand-made options, as E-57 plants them; the review's hand-made mutants that survived the first form are planted here too.
- **AG EF**: from every reachable state, the goal can still be reached (E-31's liveness check).
- Marks: *(checked)* a model or a seeded run ran it and its output is in `results/`; *(reasoned)* an argument, not run; *(a guess)* nobody measured it; *(not kept: a claim)* a run whose output is not in `results/`. Nothing here is timed, so nothing is *(measured)*.

## Method

Two exhaustive models in plain Python on E-16's engine ([../E16-controller-loop/engine/engine.py](../E16-controller-loop/engine/engine.py)), which uses E-17's rule language unchanged, as E-31 does. So a rule, a mutant and a needed rule mean here what they mean in E-31, and the counts compare. Each model starts from E-31's world ([../E31-subscribe/models/subscribe.py](../E31-subscribe/models/subscribe.py)): one followed slot, E-31's script of three records (1 `set a`, 2 `set b`, the client's own write, 3 `del a`; every prefix has different rows, so a stale view, a ghost row or a skipped record shows), a leader crash that loses its uncommitted tail, a follower's snapshot reload, a dropped link and a slot move. Liveness is E-31's: AG EF over calm steps. Bounds too large to finish are checked part way (breadth first, to 3,000,000 states) and by 20,000 seeded random walks ([walk.py](walk.py), safety only).

### Part 1: the `view` selector ([models/view.py](models/view.py))

**The world (not counted).** E-31's, with these changes:
- **A served view over the slot's rows.** Its value at position p is V(p), the rows at p. Its frames carry rows added and rows removed. In the `big` bounds `views.rows` is 1, so V(2) = {a, b} is too big: the view ends there. With `del a` at 3 it would fit again.
- **Three copies in group A** (LA, its leader at first, FA1 and FA2) and **two in group B** (LB, its leader, and FB). Placement is the rendezvous order (FA1, FA2, LA) in A and (FB, LB) in B: the owner is the first copy in it that is alive, loaded and not the leader; if no such copy is ready, the leader.
- **A crashed copy restarts** with a new incarnation, from a snapshot at the commit offset; a follower may also reload a snapshot. Entries live in memory only. A crash resets the copy's connections.
- **A leader folds each record as it commits it** (its fold is the commit offset).
- **One client with one subscription to the view.** It writes record 2. Its connection to a copy is a FIFO queue of at most 1 message (2 in the `fifo` bounds). A `SUB` again at the same copy keeps what is in flight; a `SUB` at another copy is another connection, and the client reads only the connection of its `SUB`. A crash or a dropped link loses what is in flight.
- **The copy knows only what the `SUB` carried** (the client's instance, sequence and `seen`) and its own record of what it sent on the link. It never reads the client's live state.
- **Faults** (a budget of one or two): A's leader crashes (the next live copy in (LA, FA1, FA2) leads), a follower of A crashes or reloads, the client's link drops, the client gives up its `SUB` and sends it again on the same connection (`resub`), and after the move B's follower crashes or reloads (`bcrash`, `breload`). B's leader never fails: a group of two cannot elect with one copy down.
- Two reductions, both sound for the design's own steps: once B opens, A's copies drop their entries (A no longer holds the slot; this is in the pinned world step), and a crashed or reloaded follower of B loads a snapshot at the commit offset, as one of A's does.

**The protocol (counted, DEV-10).** As TRANSFORMS 3.8 and API.md 3.10 write it:
- **Who serves.** Only the owner builds an entry and serves it (a picture, a ring resume or a frame); any other copy answers `END moved`, and so does an owner that stops being one (a hand-off, and the leader's hand-back once a second copy is ready). A copy that is loading or does not hold the slot answers `retry`. An entry's instance is (copy, incarnation, counter).
- **A picture** waits until the copy's fold is at or past the `seen` the `SUB` carried, and only from a live entry. **A ring resume** answers a `SUB` whose (instance, sequence) names this entry, when the ring reaches back: the missed frames ride inside the answer. **A frame** goes on a live link that follows this instance, the next one after what the copy last sent, while it is in the ring; a reader whose next frame has left the ring gets a picture. Each send updates the copy's record of the link.
- **END `view-too-big`.** An entry that has met a too-big commit ends; it sends nothing more but END. It stays while it lives.
- **The client** takes a picture as one commit that replaces its view and sets its position, instance, sequence and `seen`; drops the frames of a ring resume that it already applied, then applies the rest; applies a frame only if it is the next of the instance it follows (else it drops it and subscribes again); on `END moved` or `retry` it subscribes elsewhere with its (instance, sequence) and `seen`; on END `view-too-big` it stops for good. Its `seen` also takes the position in its write's answer. `sync()` resolves once the view has passed the write.

**Properties.**

| Id | Property |
|---|---|
| V1 | The client's view is V(pos) at its position pos, and pos is committed: a state the view's own function gives on a prefix of the log. |
| P6 | The client's position never goes back. |
| D1 | No doubled or missed change: each frame the client applies, alone or inside a ring resume, adds only rows not shown and removes only rows shown (E-57's check; set deltas are idempotent, so V1 alone would miss a doubled frame). |
| P9 | A picture is never behind the client's view, nor behind the client's own write if the write's answer reached it before it sent the `SUB`. This is what the docs promise: the `SUB` carries `seen` (TRANSFORMS 3.8), and a read carries what the process has seen, its writes' answers included (API.md 3.10, section 7). A write answered while the `SUB` waits is left to `sync()` (P4). Stated on world facts (a ghost field that no rule reads), not on the client's own `seen`. |
| P3 | Nobody serves from an unloaded fold. |
| PL1 | No picture, ring resume or frame comes from a group's leader while another copy of the group is ready (V5-17). |
| PL2 | A copy builds an entry only while it is the view's owner. |
| P4 | A resolved write (`sync()`) is in the writer's view, and stays. |
| E1 | END `view-too-big` only when the view has truly ended: a committed prefix makes it too big, and the copy that says so has folded that prefix. |
| E2 | The client never shows a too-big view, and after END it takes nothing and never subscribes again. |
| E3 | An entry that has met a too-big commit (`views.rows` checked on every commit it folded) never serves again while it lives. Stated on the log, not on the model's own `ended` flag. |
| P5 | AG EF: with faults over, the client reaches the end: the script written, and either its END, or its view at the commit offset with its write resolved. |
| E4 | (targeted check, option `strict`) The docs' END: a client that follows the view never crosses the view's end without END. |

V1, P6, D1 and P9 say "after any failover, reload or move the client either resumes exactly or takes a fresh picture at or past what it has seen". E1, E2, E3 and P5 say "it gets END exactly when its entry ends, and an ended entry stays ended". E4 is what API.md 3.10 promises: "checked on every commit; past it the view ends `view-too-big`, which stays until the method's code changes" (section 2).

**Bounds.**

| Bound | Move | `views.rows` | Ring | Queue | Faults | Role |
|---|---|---|---|---|---|---|
| `fo` | no | any | 1 | 1 | 1 of: A's leader crash, a follower crash, a reload, a link drop | sweep |
| `mv` | yes | any | 1 | 1 | 1 of: A's leader crash, a link drop | sweep |
| `big` | no | 1 (with the linger) | 1 | 1 | 1 of: a follower crash, a reload, a link drop | sweep |
| `ring2` | no | any | 2 | 1 | 1 of: a follower crash, a reload, a link drop | sweep |
| `fifo` | no | any | 2 | 2 | 1 of: `resub`, a follower crash, a reload, a link drop | sweep |
| `bfo` | yes | any | 1 | 1 | 1 of: B's follower crashes or reloads, a link drop | sweep |
| `fo2` | no | any | 1 | 1 | 2 of: a follower crash, a reload, a link drop | verify |
| `mvf` | yes | any | 1 | 1 | 1 of: a follower crash, a reload, a link drop | verify |
| `fifo2` | no | any | 2 | 2 | 2 of: `resub`, a follower crash, a reload, a link drop | once, in full |
| `fo2all` | no | any | 1 | 1 | 2 of A's kinds | once, in full |
| `big2` | no | 1 | 1 | 1 | 2 of A's kinds | once, in full |
| `mvbig` | yes | 1 | 1 | 1 | 1 of A's kinds | once, in full |
| `bfo2` | yes | any | 1 | 1 | 2 of: B's follower crashes or reloads, a link drop, `resub` | once, in full |
| `mv2` | yes | any | 1 | 1 | 2 of A's kinds | part way, and walks |
| `all2` | yes | 1 | 1 | 1 | 2 of A's kinds | part way, and walks |

A slow reader is in every bound. A resume by a new picture happens in every bound (a ring miss, an instance from another copy or incarnation, a reload).

**Planted bugs** (options, each must give a counterexample): `copyinst` (the instance without the copy: per-copy counters, E-57 XA-3's bug), `incinst` (without the incarnation), `framepos` (a frame stamped with the copy's fold, not its own position: E-57 A1's bug), `ownseq` (the client resumes from its own frame count since its last picture: E-57 A2's bug), `leadserve` (the leader may own a view while another copy is ready: E-57 XA-1's bug), and three the review wrote by hand that survived the first form: `noinst` (the client takes a frame by its sequence only, not its instance), `endatfold` (`views.rows` checked on the copy's current value only, not on every commit), `picfits` (an ended entry serves a picture again once the view fits).

**Coverage** ([cover.py](cover.py)): each scenario the review asked about is written as a marker that the checker reports like a broken property, so its shortest trace proves it is reached.

### Part 2: the folded resume ([models/resume.py](models/resume.py))

**The world (not counted).** E-31's, mode `state` (no relay, no `log` mode), with these changes:
- **Each copy keeps each row's version** (the slot position of its last write) and **its own tombstones**: a removal adds one as the copy folds it, a set of the same row drops it, a time step `gc` drops those at or below the fold (the window passes), and a snapshot or a move starts the copy with none. Beside them the copy keeps its **floor**: the oldest cursor it claims its tombstones reach back to.
- **A row's value is the record that set it last**, so a row set again is a different row. The bound `tw` writes a fourth record, 4 `set b` again, so one row is set twice.
- **The client may restart** (a fault): its link closes, and the new process starts from the base it last saved (its rows with their cursor). It may save its base at any calm moment. A restart is a new process: the write's promise ends with the old one, and P6 does not span a restart.

**The options.** `e31`: E-31's design, mode `state`: a conflated diff from the records the copy holds after the cursor; a restarted client starts from nothing. `fold`: the folded resume: the client keeps its base across a restart, and the copy answers a `SUB` with the rows newer than the cursor plus its tombstones newer than it, when its floor is at or below the cursor; else a new picture. It never reads the log. Planted: `torn` (the base is saved in two steps), `firstver` (a row's version is its first set, not its last: the review's).

**Counted beside E-31's rules:** the folded answer and its guards, the client's base, and the floor's upkeep: `load.floor` (a loaded snapshot starts the floor at its position), `gc.floor` (the floor follows the tombstones dropped), `bopen.floor` (B's floor starts at the move). The tombstones themselves, a snapshot's load and the window's drop are the world.

**Properties:** E-31's P2 (the view equals the fold of the committed log at the cursor, after every message), P3, P4, P6 (within one process life) and P5, and **F1**: a folded resume leaves the client exactly where a new picture from the same copy would (its rows the copy's rows, its cursor the copy's fold): "the client's state after resume equals a fresh subscribe's".

**Bounds:** `fo` (1 fault of: a leader crash, a reload, a link drop, a client restart; the window passes at any time), `mv` (the move, 1 of: a leader crash, a link drop, a client restart) and `tw` (four records, 1 of: a reload, a link drop, a client restart) as the sweep; `fo2` (2 faults) as the verify bound; `mv2` (the move and 2 faults) once, in full.

**What it saves** is counted in a seeded harness ([resume_sim.py](resume_sim.py)), at sizes the model cannot hold: one partition of 1,000 or 10,000 rows, writes that set (new or old keys) or remove, tombstone windows of 1,000 or 10,000 positions or for ever, a client away for 1 to 10,000 writes or for a gap **near the window** (the window plus or minus up to 130 writes, so a cursor often lands just below the floor), 1,000 seeds of 8 resumes. After every resume the client's rows must equal a plain fold of the log (an oracle that shares no code with the copy's versions and tombstones). Planted bugs: `window` (the folded form past the window), `tombs` (no tombstones), `versions` (a version compared with `>=`: a cost bug, harmless to the rows), `gcfloor` (the floor one gc batch, 64 writes, low: the review's).

## Results

### 1. The `view` selector holds every property but the docs' END ([results/view-design.txt](results/view-design.txt), [results/view-big.txt](results/view-big.txt))

| Option | `fo` | `mv` | `big` | `ring2` | `fifo` | `bfo` | `fo2` | `mvf` |
|---|---|---|---|---|---|---|---|---|
| `view` (the design) | holds | holds | holds | holds | holds | holds | holds | holds |
| states | 129,355 | 313,416 | 70,483 | 85,666 | 156,832 | 136,072 | 898,392 | 463,751 |
| `strict` (E4) | holds | holds | **E4**, 15 steps | holds | holds | holds | holds | holds |

| Option | `fifo2` | `fo2all` | `big2` | `mvbig` | `bfo2` |
|---|---|---|---|---|---|
| `view` (the design) | holds, 1,846,025 | holds, 2,082,127 | holds, 2,650,788 | holds, 639,598 | holds, 687,347 |
| `strict` (E4) | | | | **E4**, 15 steps | |

Every run that holds is complete: every reachable state explored, liveness included *(checked)*. Thirteen bounds finish, the largest 2,650,788 states.

**The scenarios are reached** ([results/view-cover.txt](results/view-cover.txt)) *(checked)*:
| Scenario | Bound | Edges that reach it | Shortest trace |
|---|---|---|---|
| The leader serves the view (it is the only ready copy: B's follower down after the move; both of A's followers down) | `bfo`; `fo2` | 5,618; 15,725 | 6; 5 steps |
| The leader that served hands the view back (`END moved`) once a second copy is ready | `bfo`; `fo2` | 796; 2,802 | 9; 8 steps |
| B's follower fails after the move while the client follows the view | `bfo` | 9,742 | 7 steps |
| The client takes a late message of a `SUB` it gave up on that connection | `fifo` | 9,382 | 5 steps |
| The client drops ring frames it already applied | `fifo` | 1,152 | 13 steps |
| The client takes END `view-too-big` | `big` | 6,374 | 10 steps |

The first form's own scenarios (a picture after a leader crash, from a new incarnation, from B after the move, a slow reader past the ring, END moved on a live link, a fence while a `SUB` waits) were reached in the first form, as the review counted; the same bounds and fault kinds are here, so they are reached here too *(reasoned; not counted again)*.

**The planted bugs** (each on the sweep and verify bounds; each must break a property):

| Planted bug | What it does | First caught | Bounds that catch it |
|---|---|---|---|
| `copyinst` | an instance without its copy (per-copy counters; E-57 XA-3's bug) | V1 and P6, 12 steps, `fo` | all eight |
| `incinst` | an instance without its incarnation | V1, 12 steps, `fo` | all but `mv` |
| `framepos` | a frame stamped with the copy's fold (E-57 A1's bug) | V1, 12 steps, `ring2` | `ring2` and `fifo` only (a ring of two lets a slow reader take an old frame) |
| `ownseq` | the client resumes from its own frame count (E-57 A2's bug) | D1, 11 steps, `fo` | all eight |
| `leadserve` | the leader may own a view while another copy is ready (E-57 XA-1's bug) | PL1, 4 steps, `fo` | `fo` and `mv` only (where A's leader is first in the order after a crash) |
| `endatfold` | `views.rows` checked on the current value only (the review's VM7) | E3, 12 steps, `big` | `big` only (the only sweep or verify bound with `views.rows` of 1) |
| `picfits` | an ended entry serves a picture again once the view fits (the review's VM8) | E3, 12 steps, `big` | `big` only |
| `noinst` | the client takes a frame by its sequence only (the review's VM5) | **survives** every bound | none: on a FIFO connection no frame of another instance is ever next in sequence |

Seven of eight are caught *(checked)*. `noinst` survives for a reason, not by chance: on a connection that keeps order and loses nothing, a frame of another instance never arrives where a frame of this one is due. The instance check guards links that lose or reorder messages, which this model leaves out (section 6; the review's own lossy model needed it, *(not kept: a claim)* here).

### 2. What the model found

**The docs' END fails, and the design's END holds per entry** (model-checked here, option `strict`: E4 in 15 steps on `big`, and again on `mvbig`). API.md 3.10 promises that `views.rows` "is checked on every commit; past it the view ends `view-too-big`, which stays until the method's code changes". The design keeps a weaker promise, per entry: an END is never false and never early (E1), it is terminal (E2), and an entry that met a too-big commit never serves again while it lives (E3). But a client can pass the view's end without an END:
1. Records 1, 2 and 3 commit. The view is too big at 2 ({a, b}) and fits again at 3 ({b}).
2. The client subscribes at FA1, the owner, whose fold is still 0. FA1 builds the entry and sends a picture at 0.
3. FA1 reloads a snapshot before it folds record 2. Its entry, kept in memory only, is gone.
4. FA1 loads at 3, builds a new entry there (it fits), and sends a picture at 3. The client goes from position 0 to 3 and never sees END.

No entry ever met position 2, so no copy could know. This is not a wrong state: every state the client shows is the view's value at a prefix of the log (V1). **Making the end a fact in the log is not enough on its own** *(reasoned)*: the copy that would write the fact is the one that met the too-big commit, and here none did. To keep the docs' promise, some copy must check the view at every commit, even one it never builds from (every copy computing every declared view's size as it folds), or a snapshot must carry the end. So either the docs say "END `view-too-big` ends the entry you follow; after a failover a view that fits again may be served" (no rule), or the design adds a per-commit check on every copy (+1 rule at least, and a cost on every fold; not modelled). Questions for the owner, item 1.

**"`view-too-big` stays" per entry is now testable** (E3). Dropping `pic.live`, `res.live` or `frm.live` alone breaks E3 in 9 to 13 steps, and the review's two survivors on END (`endatfold`, `picfits`) are caught by E3 in 12 steps. The linger's "stays" across a rebuild (`dispose.stays`) is still not needed: a rebuilt entry is a new entry, and the client that got END never subscribes again. The rule stops a rebuild loop (E-57 XA-12), so it stays in the design as a cost rule.

**The leader serves when it is the only copy, and hands the view back** (V5-17; checked: reached on `bfo` and `fo2`, section 1, and every bound holds). When B's follower fails after the move, or both of A's followers fail, the leader builds the entry and serves it; when a second copy is ready it answers `END moved` and the client moves. PL1, stated as "never from a leader while another copy is ready", holds on every bound.

**Late messages need one client check: drop the ring frames already applied** (checked, `fifo`). When the client gives up a `SUB` and sends it again on the same connection, a message sent for the old `SUB` (in the shortest trace, a second picture, at position 1) arrives before the new answer, and the new ring resume, built from the `SUB`'s sequence 0, carries frame 1 again. Without the check (`gotres.fresh`) the client applies it twice: D1 in 13 steps. This is the docs' rule ("drops a frame ... it already applied", TRANSFORMS 3.8); the first form's perfect link could not need it.

**A folded resume can be bigger than a picture** (checked, the harness, section 5). When the client missed about as many writes as there are rows, the rows newer than its cursor plus the tombstones can pass the size of the whole picture. So the copy sends whichever is smaller, as E-57 A2 already does for a ring resume against a picture. That is a cost rule; the model, which counts no bytes, cannot need it.

### 3. DEV-10 for the `view` selector: each rule alone, the smallest model, the mutants ([results/view-ablation.json](results/view-ablation.json), [results/summary.md](results/summary.md))

The model has **92 rules: 90 counted and 2 pinned** (the world step `bopen.phase`, and `frm.ring`, which is physics: a copy can send only a frame its ring still holds). Each rule's [`KIN`](models/view.py) says where it is already counted: **e31**, the same check as one of E-31's subscribe rules (a picture is E-31's snapshot, a frame its record); **read**, LAYERS 4.3's read-surface row "a resume cursor is always the server's position ... a client drops a frame it already applied"; **tf**, one of LAYERS 4.3's transformations rows (placement, served-view entries with `views.rows` and the linger, an instance unique across copies, a resume answer that carries its ring frames); **new**, counted in no table yet.

**Each rule alone** (dropped alone from the full design, on the six sweep bounds, then on the two verify bounds if it held there; [prerun.py](prerun.py) runs this pass in three processes into the same cache) *(checked)*:

| Counted in | Written | Needed alone (the ablation) | Of those, stopped at the state limit | Needed alone once those are decided on the capped bounds |
|---|---|---|---|---|
| e31 | 40 | 28 | 6 (`notready.unready`, `gotfrm.credit`, `gotmoved.is`, `gotmoved.credit`, `gotretry.is`, `gotretry.credit`) | 22 |
| tf | 31 | 20 | 5 (`moved.notowner`, `build.none`, `build.ent`, `pic.rec`, `frm.rec`) | 17 (2 still undecided: `build.none`, `build.ent`) |
| read | 7 | 5 | 0 | 5 |
| new | 12 | 9 | 1 (`gotgap.gap`) | 8 |
| **all** | **90** | **62** | **12** | **52** |

"Stopped at the state limit" (1,000,000 states in the ablation): with that rule gone, the run grew past the limit, either because something churns without end or because the space is only somewhat bigger than `fo2`'s 898,392. The engine counts such a run as a failure, so the ablation keeps these rules. On the capped bounds ([decide.py](decide.py), [results/view-limited.txt](results/view-limited.txt)) 10 of the 12 hold when dropped alone: they are not needed. `build.none` and `build.ent` still stop at the limit even with the cap (without them a copy builds or counts without end); by reading, without `build.ent` no entry is ever kept and no picture is ever sent (P5), which its drop from the smallest model shows at once *(checked there; reasoned for the full design)*.

**The view selector's own rules (new), one by one** *(checked)*:

| Rule | What it says | Dropped alone |
|---|---|---|
| `ack.seen` | `seen` takes the position in the client's write's answer | P9 in 8 steps on `fo`: the write is answered before the client subscribes, its `SUB` carries a `seen` without the write, and the owner, whose fold is still 0, sends a picture from before it |
| `gotpic.seen` | `seen` takes each picture's position | P9 in 11 steps on `fo` |
| `gotres.seen` | `seen` takes a ring resume's position | P9 in 15 steps on `fo2` (a drop, a ring resume, the owner fails, the next copy sends a picture at its fold): needed only with two faults, which the first form's sweep never had |
| `gotfrm.seen` | `seen` takes each frame's position | P9 in 13 steps on `fo` |
| `gotbig.is` | END `view-too-big` is told apart from other messages | E1 in 3 steps (a `retry` read as END) |
| `gotbig.ended` | END `view-too-big` ends the link | P5 on `big` in 2 steps |
| `connect.open` | an ended link never subscribes again | E2 on `big` in 11 steps |
| `gotgap.is`, `gotgap.gap` | a frame that is not the next is told apart | an evaluation error in 3 steps (an evaluation-error guard, left out of the count); the state limit on `fo2`, then not needed on the capped bounds |
| `gotpic.inst`, `gotgap.leave`, `gotgap.credit` | the client keeps its picture's instance; after a wrong frame it subscribes again | hold: on a FIFO connection the copy never sends a wrong frame, and without the instance the client's `SUB` never names one, so pictures do the job |

The **read** rules needed alone: the client's frame sequence taken from the server (`gotpic.seq`, `gotres.seq`, `gotfrm.seq`: D1 in 11 to 19 steps, E-57 A2's planted bug as a model counterexample) and, new in this form, the drop of ring frames already applied (`gotres.fresh`: D1 in 13 steps on `fifo`; `skip.trim`: P5 in 11 steps on `fifo`, without it the client waits for ever). `gotfrm.next` (a frame is taken only if it is the next of its instance) and `skip.old` hold: on a FIFO connection every frame that arrives is the next.

**The smallest model, as the ablation leaves it** (E-16's procedure: greedy drops on the six sweep bounds, a final pass, then the two verify bounds) *(checked)*: 44 rules and the 2 pinned, of 92: e31 24, tf 13, new 7 (`ack.seen`, `gotpic.seen`, `gotbig.is`, `gotbig.ended`, `connect.open`, `gotgap.is`, `gotgap.gap`), read 0. It holds on every sweep bound (`fo` 106,900 states, `mv` 328,928, `big` 40,237, `ring2` 60,766, `fifo` 103,885, `bfo` 112,232) and on both verify bounds (`fo2` 476,689, `mvf` 409,554); no rule was put back. The ring resume drops out whole, and with it `gotres.seen`, `gotres.fresh` and the frame sequences: a picture does a ring resume's job, as E-31's snapshot did its diff's. But 12 of the 44 are kept only because their drop alone stopped at the state limit, and that leaves odd rules in: a frame action that sends nothing but updates its record (`frm.rec` kept, `frm.send` dropped).

**3a. The smallest model, finished on the capped bounds** ([capped.py](capped.py), [results/view-capped.txt](results/view-capped.txt)) *(checked)*. On the `*-cap` bounds (the sweep and verify bounds with one more world limit: once a copy has built 3 entries in one life, its linger stops expiring and it builds over no live entry; the design and the ablation's smallest model both hold on all eight), one more greedy pass from the ablation's smallest model, then final passes until one drops nothing:
- 24 more rules drop: the 11 kept only for the state limit whose drop holds there (all but `build.ent`), then `notready.send`, `frm.owner`, `frm.live`, `endbig.send`, `gotpic.credit`, `gotfrm.is`, `gotgap.is`, `gotmoved.leave`, `gotbig.ended`, `connect.open`, and in the final passes `frm.behind`, `endbig.ended`, `gotbig.is`. `build.ent` is kept (without it, P5 at once).
- **The smallest model on the capped bounds: 20 rules and the 2 pinned**: `moved.send`, `build.owner`, `build.ent`, `pic.owner`, `pic.live`, `pic.seen`, `pic.send`, the picture's five client rules (`is`, `clear`, `rows`, `pos`, `seen`), `gotretry.leave`, `connect.link`, `ack.committed`, `ack.seen`, `ack.acked` and the three `resolve` rules. By kind: e31 14, tf 4, new 2 (`gotpic.seen`, `ack.seen`). It holds on all eight capped bounds (`fo-cap` 421,788 states to `fo2-cap` 1,171,316).
- **Why END drops out of it.** Once an owner may answer `END moved` at any time (`moved.notowner` gone) and an ended entry may be dropped and built again (`dispose.stays` gone), a client that met the end is bounced and served again when the view fits, and on this script it fits again at 3. So the client reaches the end of the script without END, and nothing makes END needed. A smallest model is one minimal set of rules for these properties, not the design: it trades rules against each other. The design keeps END, and each of END's rules is needed alone in it (the table above).

**Mutants** *(checked)*. Two sets, made by script as E-16 makes them: drop each kept rule, flip each comparison, swap each pair of updates in one action; a swap whose two orders give the same next state from every reachable state is equivalent.

| Smallest model | Made | Caught | Equivalent | Survived | Undecided | Caught of non-equivalent |
|---|---|---|---|---|---|---|
| the ablation's (44 rules), on the sweep and verify bounds | 61 | 40, and `build.ent`'s drop caught on the capped bounds: 41 | 7 | 12: the `frm.behind` flip, and 11 drops of rules the capped runs show are not needed | 1 (`frm.behind`'s drop: the frame action counts without end) | 41 of 54 (76 %) |
| finished on the capped bounds (20 rules) | 29 | 27 | 2 | 0 | 0 | **27 of 27 (100 %)** |

The first row is what the review asked to see run ([results/view-ablation.json](results/view-ablation.json), [results/view-limited.txt](results/view-limited.txt)): its six undecided mutants of the first form became 13 here, and the capped runs settle 12 of them, 11 as survivors. A survivor that is the drop of a rule the model does not need says the model was not yet the smallest, not that a bug went unseen; the second row is the smallest model those runs give, and every mutant of it that is not equivalent is caught ([results/view-capped.txt](results/view-capped.txt)). The `frm.behind` flip survives in the first row because there the frame action sends nothing (`frm.send` was dropped) and the flip changes only the copy's record.

### 4. The count for L3

LAYERS 4.3 holds three counts this model touches: subscribe's 26 (E-31), the read surface's rows (LENS's resume row among them), and the transformations' rows (TRANSFORMS 8.3: placement, served-view entries, an instance unique across copies, a resume answer carrying its ring frames). The owed `view` selector's "+4 to +6, perhaps more" is what is left: the rules the selector needs that none of those rows count.

| Reading | New rules | Which |
|---|---|---|
| **Needed alone in the design** (each rule dropped alone from the full design; the 12 stopped at the state limit decided on the capped bounds; `gotgap.is`, which only guards an evaluation error, left out) | **7** | `ack.seen`, `gotpic.seen`, `gotres.seen`, `gotfrm.seen`, `gotbig.is`, `gotbig.ended`, `connect.open` *(checked)* |
| the same, with one record's updates counted once (`seen` from the views' messages, `seen` from the write's answer, END told apart and terminal) | 3 to 4 | *(reasoned from the checked list)* |
| the same, with the frame sequence counted as the selector's own, not under LENS's resume row | 8 | add one for `gotpic.seq`, `gotres.seq`, `gotfrm.seq` *(checked; the grouping is reasoned)* |
| the ablation's smallest model | 7 | `ack.seen`, `gotpic.seen`, `gotbig.is`, `gotbig.ended`, `connect.open`, `gotgap.is`, `gotgap.gap` *(checked; two of them are kept only for the state limit)* |
| **the smallest model finished on the capped bounds** (DEV-10's count, as E-31 gives its 26) | **2** | `ack.seen`, `gotpic.seen` *(checked)*: END drops out of it on this script (section 3a) |
| left out of this model (each would add to the first reading) | about +2 | the docs' END on every copy's every commit (+1 or more, section 2); a link that loses or reorders (+1: a picture guard or a `SUB` id; `gotfrm.next` would then be needed too, under the read row) *(reasoned)* |

**The answer: +7 rules a builder writes for the `view` selector (needed alone in the design), of which DEV-10's smallest model keeps only 2; about +9 with the docs' END and a link that can reorder.** The first form's "+5 to +6, the upper half of +4 to +6" was a floor, as the review said: `gotres.seen` is needed with two faults, and the frame path's `seen` is needed too. The smallest-model count fell, not rose, because the faithful copy and the capped runs let it drop END; that says END is needed for the design's promise (a client is told its view ended), which P5 on this three-record script does not force. Against E-55 claim 22's bar, "every property in at most 8 rules": 7 is within it; 9 is not.

The selector's rules are about two things E-31 has no word for: `seen` (which a picture must wait for, and which every message and the write's answer raise) and a terminal END (which the client must obey). The rest of what it needs is already in other rows:
- **TRANSFORMS 8.3** (needed alone in the design, *checked*): placement, "a copy serves a view only while it owns it" (`pic.owner`, `res.owner`, `frm.owner`, `build.owner`: PL1 and PL2 in 2 to 9 steps) and `END moved` (`moved.send`: P5); an instance unique across copies and incarnations (`build.ctr`: V1 in 13 steps; the planted `copyinst` and `incinst`); the ring resume (`res.inst`, `res.ring`: V1 in 7 and 14 steps); `views.rows` and END (`pic.live`, `frm.live`, `res.live`: E3; `endbig.ended`: E1; `endbig.send`: P5). The leader serving when it is the only copy is part of the placement function here, not a separate rule. The linger's "stays" (`dispose.stays`) is not needed (section 2).
- **The read row** (LENS: "a client drops a frame it already applied"): `gotres.fresh` and `skip.trim`, newly needed on a FIFO connection with late messages, and the three frame sequences.

### 5. The folded resume ([results/resume-design.txt](results/resume-design.txt), [results/resume-big.txt](results/resume-big.txt), [results/resume-ablation.json](results/resume-ablation.json), [results/resume-sim.txt](results/resume-sim.txt))

**It keeps every property** *(checked)*:

| Option | `fo` | `mv` | `tw` | `fo2` | `mv2` |
|---|---|---|---|---|---|
| `e31` (E-31's design, mode `state`) | holds, 7,493 | holds, 23,087 | holds, 17,141 | holds, 22,109 | holds, 104,288 |
| `fold` (the folded resume) | holds, 96,837 | holds, 327,908 | holds, 349,571 | holds, 270,263 | holds, 1,324,233 |
| `torn` (planted: the base saved in two steps) | **P2**, 8 steps | **P2**, 8 steps | **P2**, 8 steps | **P2**, 8 steps | |
| `firstver` (planted: a row's version is its first set) | holds | holds | **F1 and P2**, 16 steps | holds | |

With a client restart, a tombstone window that passes at any time, a follower's reload and a slot move, the client's rows after a folded resume equal the copy's rows at the copy's fold (F1), and so a fresh subscribe's; P2, P3, P4, P6 and liveness hold. The planted `torn` base fails at once: the client takes a picture at position 1, saves its rows but not yet their cursor, and restarts. `firstver` fails only where a row is set twice (`tw`): the copy does not send the row set again, and the client keeps the old one.

**Each new rule alone** (pass 1: the three sweep bounds, then `fo2` for each rule that held there) *(checked)*:

| Rule | What it says | Dropped alone |
|---|---|---|
| `fres.window` | answer folded only if the copy's floor is at or below the cursor; else a picture | P2 in 14 steps on `fo`: a ghost row (the tombstone was dropped by the window, or never came with a snapshot) |
| `save.rows`, `save.cur` | the base is saved as one record: rows with their cursor | P2 in 8 steps each |
| `load.floor` | a loaded snapshot starts the floor at its position | P2 in 14 steps on `fo`: a reloaded copy keeps its old floor, claims tombstones its snapshot did not carry, and the client keeps a removed row (the review's RM2) |
| `gc.floor` | the floor follows the tombstones the window drops | P2 in 15 steps on `fo` |
| `bopen.floor` | B's floor starts at the move | P2 in 16 steps on `mv`: B opens with floor 0 and no tombstones (the review's RM3) |
| `fres.cursor` | wait until the copy's fold reaches the cursor | P2 in 10 steps (E-31's `snap.cursor`, again) |
| `fres.loaded` | only from a loaded fold | P3 in 3 steps (E-31's `snap.loaded`, again) |
| `gotfres.is`, `.add`, `.del`, `.cursor`, `.credit` | apply rows set and tombstones, move the cursor, free the credit | F1 in 3 steps, P2 in 6 to 14 steps, P5 in 2 steps (E-31's `gotdiff.*`, needed while the folded path is there) |
| `fres.req`, `fres.holds`, `fres.send` | | hold (as E-31's) |

So the folded resume has **six rules of its own that are needed alone**: the window, the base saved as one record (two updates), and the floor's upkeep at a snapshot, at the window and at the move. Grouped by idea, that is three: the window, the base, the floor. The floor's upkeep was reasoned in the first form; now each of its three rules breaks P2 when dropped *(checked)*. The rest repeats eight of E-31's checks in a new answer.

**The smallest model** drops the whole folded path, as E-31's drops its diff path, because a new picture does its job: it keeps 17 rules (15 of E-31's and `save.rows`, `save.cur`) and the 4 pinned, with 0 put back; it holds on `fo` (24,894 states), `mv` (64,152), `tw` (84,737) and `fo2` (65,726) *(checked)*. Its **24 mutants**: 20 caught, 3 equivalent swaps, 1 survivor, `snap.cursor` flipped from `>=` to `>`, which is E-31's own survivor for E-31's reason (a picture at exactly the client's cursor changes nothing): **20 of 21 non-equivalent caught (95 %)** *(checked)*. Both planted bugs are caught: `torn` (P2, 8 steps, `fo`) and `firstver` (P2 and F1, 16 steps, `tw` only).

**The count, against CONNECT 10 Q3's +2 to +3:** +2 by E-31's measure (the smallest model: the base saved as one record), +3 grouped by idea with the folded path a builder writes (window, base, floor), +6 counting each needed guard and update. Per-row versions are owed anyway (CONNECT 3.6).

**What it saves** (the harness, 1,000 seeds of 8 resumes, rows of 100 B, tombstones of 24 B, a guess) *(checked)*:

| planted bug | seeds | resumes | wrong resumes | seeds with a wrong resume | new pictures |
|---|---|---|---|---|---|
| none (the design) | 1,000 | 8,000 | 0 | 0 | 745 |
| window | 1,000 | 8,000 | 1,911 | 339 | 0 |
| tombs | 1,000 | 8,000 | 6,819 | 1,000 | 745 |
| versions | 1,000 | 8,000 | 0 | 0 | 745 |
| gcfloor | 1,000 | 8,000 | 349 | 96 | 559 |

The planted `gcfloor` (the floor one gc batch low) is caught only by the gaps near the window: 349 wrong resumes in 96 of 1,000 seeds. With fixed gaps, as in the first form, a cursor never lands just below the floor.

The design: bytes sent by a resume against a new picture (median over the resumes in each cell; 100 B rows, 24 B tombstones). "window" is how many positions of tombstones a copy keeps.

| rows | window | writes missed | resumes | past the window (a picture) | folded bigger than a picture | median bytes | median picture bytes | median share | largest share | median share, the smaller sent |
|---|---|---|---|---|---|---|---|---|---|---|
| 1,000 | 1,000 | 1 | 251 | 0 | 0 | 100 | 91,000 | 0.11 % | 0.1 % | 0.11 % |
| 1,000 | 1,000 | 10 | 232 | 0 | 0 | 924 | 90,750 | 0.93 % | 1.3 % | 0.93 % |
| 1,000 | 1,000 | 100 | 232 | 0 | 0 | 8,356 | 91,200 | 9.02 % | 11.8 % | 9.02 % |
| 1,000 | 1,000 | 1,000 | 226 | 0 | 0 | 57,926 | 92,100 | 62.00 % | 68.9 % | 62.00 % |
| 1,000 | 1,000 | 10,000 | 228 | 228 | 0 | 91,450 | 91,450 | 100.00 % | 100.0 % | 100.00 % |
| 1,000 | 1,000 | near | 191 | 79 | 0 | 62,360 | 90,800 | 64.02 % | 100.0 % | 64.02 % |
| 1,000 | 10,000 | 1 | 215 | 0 | 0 | 100 | 92,300 | 0.10 % | 0.1 % | 0.10 % |
| 1,000 | 10,000 | 10 | 231 | 0 | 0 | 924 | 91,700 | 0.92 % | 1.3 % | 0.92 % |
| 1,000 | 10,000 | 100 | 229 | 0 | 0 | 8,612 | 93,000 | 8.80 % | 11.5 % | 8.80 % |
| 1,000 | 10,000 | 1,000 | 231 | 0 | 0 | 62,012 | 102,000 | 61.48 % | 68.8 % | 61.48 % |
| 1,000 | 10,000 | 10,000 | 229 | 0 | 229 | 100,732 | 93,100 | 108.17 % | 110.9 % | 100.00 % |
| 1,000 | 10,000 | near | 209 | 74 | 135 | 112,200 | 111,200 | 102.60 % | 110.4 % | 100.00 % |
| 1,000 | for ever | 1 | 225 | 0 | 0 | 100 | 91,700 | 0.11 % | 0.1 % | 0.11 % |
| 1,000 | for ever | 10 | 219 | 0 | 0 | 924 | 90,800 | 0.94 % | 1.3 % | 0.94 % |
| 1,000 | for ever | 100 | 211 | 0 | 0 | 8,436 | 91,100 | 8.95 % | 10.9 % | 8.95 % |
| 1,000 | for ever | 1,000 | 235 | 0 | 0 | 58,184 | 91,800 | 61.82 % | 69.2 % | 61.82 % |
| 1,000 | for ever | 10,000 | 226 | 0 | 226 | 101,288 | 93,800 | 107.98 % | 110.8 % | 100.00 % |
| 1,000 | for ever | near | 204 | 0 | 0 | 59,728 | 92,400 | 61.58 % | 72.9 % | 61.58 % |
| 10,000 | 1,000 | 1 | 220 | 0 | 0 | 100 | 917,350 | 0.01 % | 0.0 % | 0.01 % |
| 10,000 | 1,000 | 10 | 210 | 0 | 0 | 924 | 894,500 | 0.10 % | 0.1 % | 0.10 % |
| 10,000 | 1,000 | 100 | 208 | 0 | 0 | 9,088 | 921,900 | 0.99 % | 1.1 % | 0.99 % |
| 10,000 | 1,000 | 1,000 | 226 | 0 | 0 | 89,132 | 935,300 | 9.47 % | 10.6 % | 9.47 % |
| 10,000 | 1,000 | 10,000 | 222 | 222 | 0 | 1,030,700 | 1,030,700 | 100.00 % | 100.0 % | 100.00 % |
| 10,000 | 1,000 | near | 218 | 75 | 0 | 86,980 | 930,450 | 9.55 % | 100.0 % | 9.55 % |
| 10,000 | 10,000 | 1 | 253 | 0 | 0 | 100 | 918,200 | 0.01 % | 0.0 % | 0.01 % |
| 10,000 | 10,000 | 10 | 223 | 0 | 0 | 924 | 919,800 | 0.10 % | 0.1 % | 0.10 % |
| 10,000 | 10,000 | 100 | 219 | 0 | 0 | 9,088 | 917,700 | 0.96 % | 1.2 % | 0.96 % |
| 10,000 | 10,000 | 1,000 | 204 | 0 | 0 | 87,416 | 929,550 | 9.32 % | 10.6 % | 9.32 % |
| 10,000 | 10,000 | 10,000 | 233 | 0 | 0 | 571,328 | 902,200 | 62.36 % | 67.5 % | 62.36 % |
| 10,000 | 10,000 | near | 212 | 67 | 0 | 639,150 | 1,033,350 | 63.01 % | 100.0 % | 63.01 % |
| 10,000 | for ever | 1 | 201 | 0 | 0 | 100 | 918,400 | 0.01 % | 0.0 % | 0.01 % |
| 10,000 | for ever | 10 | 223 | 0 | 0 | 924 | 922,100 | 0.10 % | 0.1 % | 0.10 % |
| 10,000 | for ever | 100 | 207 | 0 | 0 | 9,012 | 921,300 | 0.97 % | 1.1 % | 0.97 % |
| 10,000 | for ever | 1,000 | 194 | 0 | 0 | 88,984 | 934,500 | 9.41 % | 10.6 % | 9.41 % |
| 10,000 | for ever | 10,000 | 250 | 0 | 0 | 604,974 | 973,200 | 62.41 % | 66.8 % | 62.41 % |
| 10,000 | for ever | near | 253 | 0 | 0 | 84,996 | 902,900 | 9.38 % | 11.6 % | 9.38 % |

So a client that comes back after a few writes gets a few rows instead of the whole partition: for 1 to 100 missed writes, about 0.01 % to 10 % of a picture's bytes. When it missed about as many writes as there are rows, the folded answer passes the picture's size (up to 111 %), which is why the copy sends the smaller of the two. Near the window, a cursor just below the floor gets a picture (67 to 79 of about 200 resumes in each cell with a window). E-56 measured the same shape in exact bytes for 8 cases (164 B against 122 KB for one change in 1,000 rows); the harness adds the distribution, the window and the fallbacks.

### 6. The bounds that do not finish

The two bounds with the move and two faults of any kind are too large to finish. They were not run in the first form; here they are run part way ([results/view-partial.txt](results/view-partial.txt)) *(checked)*:

| Bound | Breadth first | 20,000 seeded walks of up to 120 steps | `strict` (E4), 20,000 walks |
|---|---|---|---|
| `mv2` (the move, two faults) | 3,000,001 states, no property broken | 2,400,000 steps, 86,532 distinct states, none broken | |
| `all2` (the move, `views.rows` of 1, two faults) | 3,000,003 states, none broken | 1,278,091 steps, 81,207 distinct states, none broken | **E4** in a 24-step walk (the docs' END, as on `big`) |

A partial run proves nothing past its limit: these two bounds are evidence, not proof.

### 7. What the review found, and what changed

The review re-ran the first form's quick mode state for state, re-checked its five planted bugs, measured which scenarios its bounds reach, and wrote 24 mutants by hand (17 caught). Each finding was checked against the model code and the docs before it was acted on.

| # | The review's finding | Checked here | What changed |
|---|---|---|---|
| 1 | The copy read the client's live `seen` (and its live instance and sequence); P9's "own write" half rested on it | **Holds.** The picture's wait read the client's state, not the `SUB`'s | The copy now reads only the `SUB`'s fields and its own record of the link (rules `pic.rec`, `res.rec`, `frm.rec`). P9 is stated as the docs promise: never behind the client's view, nor behind a write answered before the `SUB`; a write answered while the `SUB` waits is `sync()`'s job. `ack.seen` stays needed under this P9 (8 steps: the `SUB` must carry the answer) |
| 2 | `gotres.seen` is needed, but pass 1 ran on one-fault bounds only | **Holds.** Dropped alone it breaks P9 on `fo2` in 15 steps | Pass 1 now runs each rule that holds on the sweep bounds on the verify bounds too; `gotres.seen` is counted |
| 3 | The link was a perfect pipe: one message, never late; the client's frame checks were untested | **Holds** for late messages; loss, doubling and reordering are not TCP | A connection is a FIFO queue of up to two messages that a `SUB` again on the same connection does not wipe (`fifo`, `fifo2`, fault `resub`). The client's drop of ring frames already applied is now needed (`gotres.fresh`, `skip.trim`). `gotfrm.next` and the review's `noinst` still pass: on a FIFO connection no wrong frame arrives. A lossy or reordering link is left out (section "What the models leave out") |
| 4 | The L3 count was a floor | **Holds** | Section 4 gives the count on this model and what it leaves out |
| 5 | The 90 % mutant bar was not met (87 % with six undecided) | **Holds** | The undecided mutants are now run on the capped bounds (section 3a), and the bar is stated as the runs give it |
| 6 | The docs' END fails, and E1, E2, P5 could not tell "every commit" or "stays" apart | **Holds.** API.md 3.10 promises "checked on every commit ... stays until the method's code changes" | E3 (an entry that met a too-big commit never serves again) is added; the review's `endatfold` and `picfits` are planted and caught by E3. The headline says "every property but the docs' END". END as a log fact alone would not keep the docs' promise (section 2) |
| 7 | Group B never failed, and the leader never served | **Holds.** API.md 3.10 and V5-17: the leader serves when it is the only copy | B's follower crashes and reloads (`bfo`, `bfo2`); the leader serves when it is the only ready copy and hands the view back; PL1 is restated. B's leader still never fails (a group of two cannot elect with one down) |
| 8 | Folded resume: tombstones came from the whole log, so a wrong floor still gave right rows; no row was set twice; the harness never put a cursor just below the floor | **Holds** | Each copy keeps its own tombstones; the floor's upkeep is three counted rules, each needed alone (section 5); bound `tw` sets a row twice and catches `firstver`; the harness adds gaps near the window and catches `gcfloor` (349 wrong resumes in 96 of 1,000 seeds) |
| 9 | Claims marked checked with no output (`mv2` of the folded resume, the undecided mutants, the partial bounds) | **Holds** | All three are run and kept in `results/`; the one claim left from the review's own lossy model is marked *(not kept: a claim)* |
| 10 | "86 rules (and 2 pinned)" read as 88 | **Holds** | Written as "92 rules: 90 counted and 2 pinned" |
| 11 | "Every planted bug in 4 to 12 steps" hid which bound catches each | **Holds** | The planted-bug table names the bounds |
| 12 | "Never goes back" holds only on a FIFO link | **Holds** | Said so: P6 is checked on FIFO connections |

The review's 24 hand mutants: of its seven survivors, five are now caught in this form (`endatfold` and `picfits` by E3, the two floor mutants by the floor rules' drops, `firstver` on `tw`), `gcfloor` is caught by the harness, and `noinst` still survives, for the reason in section 1.

## What the models leave out

- **One slot, one view, one client, one subscription.** Several selections of one client on one instance (E-57 A7's "a frame goes to every selection on its instance"), joins by other clients, the caps (`views.client`, `views.max`, headroom) and `allow` are not modelled; E-57's seeded runs remain their evidence. A view over many slots, fed by a store per slot (TRANSFORMS 3.9), is not modelled.
- **Links that lose, double or reorder.** A connection here is TCP: FIFO, with loss only when the whole connection resets. A relay or a transport that resends could double or reorder; the review's own model of such a link found that a doubled or swapped picture breaks P6 in 10 to 11 steps and that the frame's instance check is then needed *(not kept: a claim; not rerun here)*. A guard such as "never take a picture behind your position" or a `SUB` id would cost +1 rule on such a link.
- **The view's function is the rows themselves**, with frames of rows added and removed. An ordered view's order channel, buckets and scalars are not modelled; their frames are the same kind of message with another payload.
- **Placement is one fixed order per group**, and the election is fixed too. Rendezvous hashing over changing sets and standbys are not modelled. B's leader never fails (a group of two cannot elect with one copy down); a group of one copy from the start is reached only as "every other copy is down".
- **A redeploy, the method's version and the client's floor** (E-57 A8, XA-10) and `stale-client` are not modelled; nor are `SYNC` and `PAGE` messages (`sync()` is modelled as the client waiting for its view to pass its write). TRANSFORMS 8.3's rows may already count the version floor.
- **The docs' END** (E4) is checked and fails; a design that keeps it is not modelled (section 2).
- **Liveness is "a path exists"** (AG EF), as in E-31: it shows no client is stuck, not that a client is never bounced without end.
- **Sizes.** Three or four records, five copies and one client: the models search orderings, not sizes. The harness of part 2 counts sizes, in one process, with no network, Raft or faults; the copy's versions and tombstones there are a plain map, and its window is cut every 64 writes.
- **The folded resume's snapshot and move carry no tombstones**, so after a reload or a move the window starts there (a picture for older cursors). A design that carries tombstones in snapshots would resume more often; it is not modelled. Two process lives are told apart only by the restart step; a saved base from another incarnation of the resource, or from before an unclean recovery, is not modelled (E-31 leaves epochs out too).

## Against the bar

| Bar (LAYERS 11, items 1 and 9) | Result | Mark |
|---|---|---|
| The `view` selector: every property held, through a failover, a reload, a slot move, a slow reader and a resume by a new picture | **Met for every property but the docs' END**, on every bound that finishes, thirteen of them, up to 2,650,788 states, with a copy that knows only what the `SUB` carried, FIFO connections with late messages, faults in group B and the leader serving when it is the only copy. The docs' END (E4, API.md 3.10) fails in 15 steps; the design's per-entry END (E1, E2, E3) holds. Two bounds too big to finish: 3,000,000 states and 20,000 walks each, no property broken | *(checked)* |
| At least 90 % of mutants caught | **Met on the smallest model finished on the capped bounds** (27 of 27, 100 %) and on the folded resume (20 of 21, 95 %). **Not met on the ablation's smallest model as it left it** (41 of 54, 76 %): its 11 surviving drops are of rules the capped runs show are not needed. Planted bugs: 7 of 8 in the view model (`noinst` survives: no wrong frame arrives on a FIFO connection), 2 of 2 in the resume model, 3 of 3 harmful ones in the harness | *(checked)* |
| At least 20 mutants | 61 + 29 + 24 by script, 8 + 2 planted in the models, 4 planted in the harness | *(checked)* |
| An ablation of each new rule | Sections 3 and 5: each rule dropped alone from the full design (sweep, then verify bounds), DEV-10's smallest model, and for the view model the smallest model finished on the capped bounds | *(checked)* |
| Decide L3's +4 to +6 | **+7 by the rules each needed alone in the design**, 2 by DEV-10's smallest model, about 9 with what is left out: past the top of +4 to +6 | *(checked; the grouping into tables and the left-out rules are reasoned)* |
| A folded resume: does it keep every property, and what does it save | **It keeps every property**, with +2 rules by DEV-10 (+3 grouped by idea with the folded path, +6 by each needed guard and update, the floor's upkeep now checked); a resume after 1 to 100 missed writes costs 0.01 % to 10 % of a picture; send the smaller of the two | *(checked)* |

## Questions for the owner

1. **Is END `view-too-big` a fact of the entry or of the view?** The design ends the entry; after a reload or a failover a view that fits again may be served, and a client that followed it can pass the end without an END (section 2, 15 steps). API.md 3.10 promises the view. **Pick: the entry**, and API.md 3.10 and TRANSFORMS 3.8 say so in one sentence ("after a failover a view may be built again; if it fits, it is served"). *Against:* a user who reads "stays until the code changes" as "for good, everywhere" is surprised. Keeping the docs' promise needs a check of every declared view on every copy's every commit, or an end carried in snapshots: a cost on every fold, not modelled.
2. **Which count goes into L3 for the `view` selector?** **Pick: write +7 (2 to 9) in LAYERS 4.3**, beside subscribe's 26 (22 to 29): 7 is what a builder writes (each rule needed alone in the design), 2 is DEV-10's smallest model on this script, 9 adds the docs' END and a link that can reorder. *Against:* it mixes two measures; E-31's 26 is a smallest-model count, so like for like the selector adds 2. But a smallest model that drops END is not a design anyone would build.
3. **Take the folded resume, `connect({ resume })`, now?** It holds every property, with its own checks (section 5), and saves most of the bytes when the client missed few writes. **Pick: yes when restarted screens matter, not before the first slice**: it needs per-row versions (CONNECT 3.6, owed and not priced) and tombstones kept for a window, and both cost every write. *Against:* without it a restarted screen takes a whole picture, which is correct and simple.
4. **Should a snapshot carry the tombstone window?** Without it, every reload and every move starts a copy's window afresh, and a client whose cursor is older gets a whole picture. Carrying it costs snapshot bytes. Not modelled; reasoned only.

## How to rerun

```sh
./run.sh quick    # both models on their sweep and verify bounds, every planted bug, the strict reading of END,
                  # the coverage markers, and 100 seeds of the resume harness (about an hour on a quiet box)
./run.sh full     # quick, then the bigger bounds in full, the partial bounds and their random walks, both
                  # ablations with their mutants (resumable, in holds of at most 25 minutes), the rules
                  # stopped at the state limit on the capped bounds, 1,000 seeds of the resume harness with
                  # its planted bugs, and results/summary.md
./run.sh ablate   # one step: check, big, partial, ablate, decide, sim, simq, report
python3 ../E16-controller-loop/engine/cli.py models/view.py strict --bound big    # one run, with its trace
```

Every model step runs under `$SP/bin/heavy` (shared with other jobs) and a 4 GB address-space limit. The ablation resumes from `results/*-ablation.json.cache`; after a model change, delete the cache, its `.prerun` mark and the `.json` (the cache key does not hold the model's text).

## Files

- [models/view.py](models/view.py): part 1, E-31's model with a `view` selector; its options are the design (`view`), the strict reading of END (`strict`) and eight planted bugs. [models/resume.py](models/resume.py): part 2, E-31's model (mode `state`) with a client-held base; options `e31`, `fold` and the planted `torn` and `firstver`. Each model's `KIN` says where each rule is already counted.
- [ablate.py](ablate.py): DEV-10's ablation, each rule alone (sweep, then verify bounds), the mutants of the smallest model and the planted bugs, on E-16's engine. [prerun.py](prerun.py): its pass 1 in three processes. [decide.py](decide.py): the rules stopped at the state limit, on the capped bounds. [capped.py](capped.py): the smallest model finished on the capped bounds, and its mutants. [cover.py](cover.py): the coverage markers. [walk.py](walk.py): seeded random walks for bounds too big to finish. [resume_sim.py](resume_sim.py): the folded resume at 1,000 and 10,000 rows, with an independent oracle. [summarize.py](summarize.py): the tables. [run.sh](run.sh): every run above.
- [results/](results): `view-design.txt` and `resume-design.txt` (every option on the sweep and verify bounds, with traces), `view-cover.txt`, `view-big.txt` and `resume-big.txt` (the bounds run once in full), `view-partial.txt`, `view-limited.txt` and `view-capped.txt` / `view-capped.json` (the capped runs), `view-ablation.json` and `resume-ablation.json` (DEV-10; each leaves a `.cache` of its runs beside it, which git ignores), `resume-sim.jsonl` and `resume-sim.txt` (the harness), `summary.md` (the rule tables and the mutants).
- Machine: Ubuntu 24.04 in a Firecracker VM, 4 vCPU, 15 GB RAM; Python 3.13.17, standard library only. Every run held the shared heavy lock while other jobs ran, so the seconds in `results/` are not timings.
