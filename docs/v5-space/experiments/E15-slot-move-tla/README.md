# E-15: the slot move in TLA+, checked against slot_move.py

**Question (Q-15).** Does a TLA+ model of the slot move give the same verdicts as [slot_move.py](../../../v5-spec/slot_move.py)?

**The answer, in short.**
- **Yes, the two models agree.** On all 74 of slot_move.py's 76 planned runs that both explored in full, TLC on [tla/SlotMove.tla](tla/SlotMove.tla) and slot_move.py give the same failing properties, the same number of states (for the main search and for the calm graph), and the same length for every shortest counterexample. That includes `fixed` on Q-15's own bound (shards A, B and C, two moves, one unclean recovery): 7,510,764 states, every property holding in both. All 117 counterexamples slot_move.py prints replay step for step as TLA+ behaviors. So no bug was found in either model, and slot_move.md's five-fix protocol stands.
- **The same 16 of 18 mutants are caught,** and the same two are missed, for slot_move.md's reasons. Run in full, three mutants fail more properties than slot_move.md's capped table lists; both checkers agree on the longer lists.
- **DEV-10's mechanical mutants tell a second story.** Of 154 mutants made by script from the fixed protocol's text, 35 are caught, 8 crash the model, 7 blow its state space up, 64 change nothing reachable at `move` and `write0`, and 40 survive. That is 39% of the 90 that change something (56% counting crashes and blow-ups), against DEV-03's 85%. Most survivors are second checks of a fact already checked, reports that the receiver checks again, or steps made into no-ops. So the protocol as written carries spare guards: only 31 of its 138 guards and updates are rules by DEV-10's count at these bounds.
- **One new finding:** links that let a recovered shard receive messages sent to its old incarnation break no property at four bounds (mutant m131). slot_move.md said, without checking, that such links would need more fixes. Fix 4's incarnation check inside the fence seems to cover it.

## Words used here

- A **slot** is one of a resource's 1,024 fixed hash buckets. A **shard** is a Raft group that holds some slots. A **move** hands slot s from shard A to shard B (or C). The steps are slot_move.md's: A logs `exporting`, B logs `importing` and copies s, B reports **ready**, A logs **`fenced`** at position N, A sends the rest and `END(N)` with the **carried state** (dedup outcomes, the highest call id, the sequence), B writes `s -> B` into the **slot table** in `#meta`, and B logs **`open`**.
- An **unclean recovery** rebuilds one shard from a lagging copy: its log is cut back, its **epoch** goes to 1, and it becomes a new **incarnation** (messages sent to the old one are dropped).
- **slot_move.md's five fixes** are the rules its second round found missing in DESIGN-V5 §4.2. "fixed" is the protocol with all five. A **reading** is the protocol with one fix left out. A **mutant** removes or changes one rule of the fixed protocol.
- **TLC** is the TLA+ model checker. It visits every state the model can reach within the bounds.
- A **replay** takes one counterexample that slot_move.py printed and asks TLC to walk the same states, step by step, using only the TLA+ spec's own steps.
- The **calm world** is slot_move.py's check of property 7 (liveness): from each reachable state with no recovery, every message in flight is lost, and then no fault happens again. Property 7 holds when, from every such state, some path still ends every move (AG EF: "from everywhere, the goal can still be reached").
- **DEV-10** (REQUIREMENTS) is the study's rule for mutants: made by script from the model text (drop each guard conjunct, flip each `<`/`<=`, drop each state update, swap each pair of updates), never hand-picked.

## What was built

| File | What it is |
|---|---|
| [tla/SlotMove.tla](tla/SlotMove.tla) | The slot move in TLA+: shards as ordered logs with a leader's uncommitted tail, depositions, at most one unclean recovery, the `#meta` table row, fence, copy, ready, open, cancel and abort, the per-slot sequence `(epoch, seq)`, carried dedup, one client with resends. The 9 properties. A constant `V` picks the variant: `design`, `fixed`, the six readings, the 18 mutants. |
| [tla/SlotMoveFixed.tla](tla/SlotMoveFixed.tla) | The fixed protocol alone, with no variant switches and one guard per line, for DEV-10's mechanical mutants. It reuses SlotMove's views of a log, its properties and its environment. |
| [tools/tlcrun.py](tools/tlcrun.py) | Runs TLC on one (variant, bound) pair. The bounds and each variant's fixes are read from slot_move.py's own `BOUNDS` and `VARIANTS`, so both checkers run the same configurations. |
| [tools/agef.py](tools/agef.py) | Checks property 7 (AG EF Done) on the calm graph TLC prints. |
| [tools/pyrun.py](tools/pyrun.py) | Runs slot_move.py's own search, in full (no cap), and turns each of its counterexamples into a TLA+ replay module. slot_move.py is imported unchanged. |
| [tools/replay.py](tools/replay.py) | Runs every replay in TLC. |
| [tools/compare.py](tools/compare.py) | Puts the two checkers' results side by side. |
| [tools/mutants.py](tools/mutants.py) | Makes DEV-10's mutants from SlotMoveFixed's text and runs them. |
| [tools/batch.py](tools/batch.py) | Runs the plan in batches, each under one hold of the study's heavy lock. |
| [tools/segments.py](tools/segments.py) | Runs one TLC run too big for one lock hold (`fixed three`) in pieces: TLC checkpoints, stops, and the next hold resumes it (`-recover`); the pieces' outputs are merged. The log is fsynced at each checkpoint, and a run resumes only from a checkpoint recorded that way, so a crash cannot lose prints for good. (`fixed three` in the end needed only one piece.) |
| [tools/summary.py](tools/summary.py) | The README's summary tables, from results/ only ([results/summary.md](results/summary.md)). |
| [tools/mdcheck.py](tools/mdcheck.py) | Puts slot_move.md's printed numbers beside both checkers' numbers here. |

**How the TLA+ spec was written.** From slot_move.md's description of the model and its fixed rules, step by step, with slot_move.py open beside it to keep the same abstraction: the same state (each shard's committed log, tail, deposition count, lost tails, waiting answers; the table; the client; the message set; the moves started, the recovery flag, and the ghost "highest position ever committed"), the same reports (a message enters the network the moment a log makes it true), the same bounds. Values are encoded one for one (a position is `<<epoch, seq>>`, a table version is slot_move.py's nested tuple, flattened). This was a deliberate choice: with the same state, the two checkers must agree not only on verdicts but on **state counts**, and every Python counterexample must be a legal TLA+ behavior. Any difference then points at a bug in one of them.

## How the two checkers are compared

1. **The same 76 runs.** slot_move.py's `plan()`: 26 variants (design, fixed, 6 readings, 18 mutants) on the bounds where each matters, among `move`, `moves`, `write`, `dedup`, `deep` and `three`. Both checkers were to explore every run **in full** (TLC did not, on two; section 1). slot_move.md's table stopped a mutant once a property failed past 1,000,000 states (`--cap`); here no run is capped, so a capped run's counts differ from slot_move.md's.
2. **Verdicts:** the set of properties that fail. This is Q-15's threshold.
3. **State counts**, for the main search and for the calm graph.
4. **Steps** in each shortest counterexample. slot_move.py searches breadth first. TLC does too, and each property's failure is printed with its depth, with the search going on (so one run gives every property). With two TLC workers a depth could in principle come out one too high; a run whose steps differed would be re-run with one worker. None differed.
5. **Replays:** every counterexample slot_move.py printed is replayed in TLC (method above). A safety replay succeeds when TLC reaches the last state with the same property broken, in the same number of steps. A liveness replay succeeds when the trace's last state, after the calm step, lands on slot_move.py's stuck state, and TLC then explores everything reachable from it and finds no way to end the moves.
6. **Property 7 in TLC.** TLC cannot check "AG EF" (a branching-time property) itself. The spec adds slot_move.py's calm step as an action, so the calm world is part of TLC's state graph; TLC prints each calm state (with whether it is Done) and each calm step, and [tools/agef.py](tools/agef.py) finds the calm states from which no Done state can be reached. This is how E-14 checked liveness too.

## Results

### 1. The plan's runs: both checkers, side by side

slot_move.py's `plan()` has 76 runs. Both checkers explored **74 of them in full, and agree on all 74**: the same failing properties, the same number of states (for the main search and for the calm graph), and the same number of steps in every shortest counterexample.

| Variants | Runs in the plan | Done on both | Same verdict | Same states | Same steps |
|---|---|---|---|---|---|
| `design`, `fixed` | 11 | 11 | 11 | 11 | 11 |
| the six readings | 18 | 18 | 18 | 18 | 18 |
| the 18 mutants | 47 | 45 | 45 | 45 | 45 |
| **all** | **76** | **74** | **74** | **74** | **74** |

Not run on both: `no-exporting moves` (slot_move.py only); `no-exporting three` (slot_move.py only).

The runs both explored range from 23,547 states (`abort-keeps-table` on `move`) to 7,510,764 (`fixed` on `three`). The two runs TLC did not explore in full:
- `no-exporting` on `moves` (14,724,097 states in slot_move.py, in 941 s) and on `three` (which slot_move.py, like slot_move.md, stops once a property has failed past 1,000,000 states: 6,554,885 states here, 6,554,919 in slot_move.md). An earlier TLC run of `moves`, in checkpointed pieces, reached 6.85 million states; the output of its last piece was not kept, so its calm graph is incomplete, and it is not counted. Both runs were then dropped to stay near the CPU budget. This mutant is already caught on `move` and `write` by both checkers in full, and every counterexample slot_move.py prints for it on `moves` (properties 1, 6, 7, 9) and `three` (7, 9) replays in TLC (section 2).

`fixed` on `three` is the bound Q-15 names: shards A, B and C, two moves, one unclean recovery. TLC explored it in full: 7,510,764 states plus 17,819 calm states (7,528,583 distinct), every property holding and no stuck calm state, the same as slot_move.py ([results/tlc/fixed-three.json](results/tlc/fixed-three.json)). It took one 22.9-minute hold with two workers. Two earlier tries, in checkpointed pieces, were cut by container restarts. The second cut lost TLC's last prints before its newest checkpoint (the log had not reached the disk), so resuming from that checkpoint would have lost calm-graph lines for good; the run was started again from scratch instead. [tools/segments.py](tools/segments.py) now fsyncs its log at each checkpoint and resumes only from a checkpoint it recorded that way.

The full table, run by run, is [results/compare.md](results/compare.md) (raw: [results/py/](results/py) and [results/tlc/](results/tlc), one JSON a run, with TLC's trimmed log beside it). For property 7, TLC's column gives no step count: TLC's calm graph says only *that* a stuck state exists; the steps to it come from slot_move.py, and the replays below confirm them.

### 2. Every slot_move.py counterexample is a real TLA+ behavior

**117 of 117 replays succeed** ([results/replays.json](results/replays.json)). They cover all 51 runs where slot_move.py finds a failure (50 of the plan's runs, plus `design quick`), and every property that fails in each: property 1 (23 traces), 2 (9), 3 (4), 4 (11), 5 (8), 6 (14, of which 7 break it on a commit step rather than in a state), 7 (14) and 9 (34). The longest trace has 32 steps (`fixed-but-recovery-resumes` on `moves`, property 1). Each safety replay reaches its broken state in TLA+ in exactly slot_move.py's number of steps; each liveness replay lands on slot_move.py's stuck state, and TLC then finds no way from there to end the moves. Two of the replays are of runs TLC did not explore in full here: `no-exporting` on `three` (properties 7 and 9, with shard C) and on `moves` (properties 1, 6, 7 and 9).

### 3. slot_move.md's printed numbers

slot_move.py, re-run here unchanged, gives every number slot_move.md prints for its full runs: the 29 rows of its table of the text, the fix and the readings (states, failing properties and steps), and the liveness graph sizes for `fixed` (205, 3,694, 1,725, 5,694, 16,923 and 17,819 states). TLC gives the same on all 29 rows ([results/mdcheck.md](results/mdcheck.md)).

slot_move.md's mutant table stopped a mutant once a property had failed past 1,000,000 states, and says that properties not listed may fail too. Run in full here, three mutants fail more properties than it lists, and both checkers agree on the longer lists:
- `a-unfences-alone`, on `write`: also 2 (24 steps), 4 (21), 5 (24) and 6 (24);
- `unfence-on-appended-abort`, on `write`: also 2 (25), 4 (22), 5 (25) and 6 (25);
- `no-exporting`, on `moves`: also 6 (24) (slot_move.py only; TLC did not run `moves` in full for this mutant, but replayed the trace).

These are not disagreements. They do not change which mutants are caught.

### 4. The 18 mutants, one line each

Each mutant on every bound of the plan that both checkers ran, with the failing properties summed over those bounds. slot_move.md's own mutant table, for reference, is in [results/mdcheck.md](results/mdcheck.md).

| Mutant | Bounds run on both | slot_move.py: fails | TLC: fails | Same |
|---|---|---|---|---|
| `table-after-open` | move, write | 9 | 9 | yes |
| `recovery-trusts-table` | move, write | none | none | yes |
| `abort-keeps-table` | move, write | 1, 9 | 1, 9 | yes |
| `a-unfences-alone` | move, write | 1, 2, 4, 5, 6, 9 | 1, 2, 4, 5, 6, 9 | yes |
| `no-exporting` | move, write (and moves, three in slot_move.py only) | 7 | 7 | yes |
| `ready-before-copy-commits` | move, write | 7 | 7 | yes |
| `fence-without-ready` | move, write | 7 | 7 | yes |
| `stream-before-fence-commits` | move, write | 1, 2, 3, 4, 5, 6, 7, 9 | 1, 2, 3, 4, 5, 6, 7, 9 | yes |
| `b-serves-before-open-commits` | move, write, dedup, deep | none | none | yes |
| `b-serves-before-open` | move, write, deep | 2, 4, 5, 6 | 2, 4, 5, 6 | yes |
| `fence-N-from-committed` | move, write, deep | 2, 3, 4, 6, 7 | 2, 3, 4, 6, 7 | yes |
| `stamp-from-committed` | move, write, deep | 3, 4, 6 | 3, 4, 6 | yes |
| `no-carried-sequence` | move, write, deep | 2, 6 | 2, 6 | yes |
| `no-carried-outcomes` | move, write, dedup | 5 | 5 | yes |
| `no-max-merge` | move, write, dedup | 5 | 5 | yes |
| `unfence-on-appended-abort` | move, write | 1, 2, 4, 5, 6, 7, 9 | 1, 2, 4, 5, 6, 7, 9 | yes |
| `b-aborts-after-open` | move, write | 4 | 4 | yes |
| `guards-on-committed` | move, write, deep | 1, 2, 4, 5, 6, 9 | 1, 2, 4, 5, 6, 9 | yes |

So both checkers catch the same 16 of 18 mutants, and miss the same two: (b) `recovery-trusts-table` (fix 3 already covers it) and `b-serves-before-open-commits` (B serving after it appends `open` but before `open` commits). slot_move.md explains both; nothing here changes its account.

### 5. DEV-10's mechanical mutants of the fixed protocol

**How they were made.** [tools/mutants.py](tools/mutants.py) reads [tla/SlotMoveFixed.tla](tla/SlotMoveFixed.tla) (the fixed protocol written once more with no variant switches, one guard conjunct per line, and every protocol update that is not a plain step argument marked `Upd(old, new)`) and makes every mutant DEV-10 (d) names, by script, from the text between its `MUTATE-BEGIN` and `MUTATE-END` marks:
- **G**, drop a guard conjunct: each bullet `/\ ...` that holds no step becomes `TRUE` (111 mutants);
- **C**, flip a comparison: each `<` to `<=`, `<=` to `<`, `>` to `>=`, `>=` to `>`, and on positions and table versions `PLt` to `PLe`, `PLe` to `PLt`, `VLt` to `VLe`, one at a time (16);
- **U**, drop a state update: `Upd(old, new)` keeps `old`, and each changed variable in a step `Go(shards', table', cl', net', ...)` is left unchanged (27);
- **S**, swap two updates in one action: none arise. A TLA+ action's updates happen at once, so their order cannot be swapped; the one order that exists, the order of entries a step appends to one log, never has two entries, since every action here appends at most one.

Lines tagged `\* env` are bounds of the model (moves allowed, the calm world, one recovery), not rules, and are left alone. **SlotMoveFixed is the fixed protocol:** it has exactly SlotMove's (and slot_move.py's) states and calm states on `move` (47,457 and 205), `dedup` (351,262 and 5,694), `deep` (308,274 and 16,923) and `write0` (191,617 and 1,725), with every property holding ([results/fixed-equiv.json](results/fixed-equiv.json)); its safety runs on `write` and `moves` reach slot_move.py's 1,107,824 and 898,312 states too ([results/fixed-counts.json](results/fixed-counts.json)). `write0` is `write` without depositions: one write to s with one resend, a move and a recovery, at a sixth of `write`'s size.

**How they were run.** Each mutant runs in TLC (one worker) with properties 1 to 6, 8 and 9 as invariants, first on `move`; if nothing breaks there, property 7 is checked on `move`'s calm graph; if that holds too, the safety run is repeated on `write0`. The plan was to go on to `deep` and `dedup`; that step was not run (CPU budget, see the gaps). A mutant is:
- **caught** when some property breaks on some bound;
- **ill-formed** when TLC cannot evaluate it: dropping a guard such as `n \in DOMAIN mv` makes the model read a move that does not exist. In code this would be a crash or a read of garbage; the checker treats it as an error, so it is not silent, but it is counted apart;
- **unbounded** when the state space grows past 10 times the fixed protocol's on that bound with no property broken in the part searched (the cap is a TLC constraint; with one worker the search order, and so the cut, is fixed). This kind was added after mutant m063 ran for 55 minutes on `move` with no end in sight ([results/capcheck.txt](results/capcheck.txt) checks the cap);
- **equivalent** when nothing breaks and its state counts equal the fixed protocol's on every bound it ran: at these bounds the guard or update changes nothing that can be reached;
- **survived** when nothing breaks, but it reaches states the fixed protocol does not.

**What came out.** All 154 mutants ran on `move`; the 110 that `move` did not catch ran again on `write0`; one of them (m131, below) also ran on `write` and `moves`. Mutant by mutant: [results/mutants.md](results/mutants.md) (raw: [results/mutants.json](results/mutants.json)); the tallies: [results/summary.md](results/summary.md).

| Kind | Made | Run | caught | ill-formed | unbounded | survived | equivalent |
|---|---|---|---|---|---|---|---|
| G: drop a guard conjunct | 111 | 111 | 15 | 8 | 6 | 28 | 54 |
| C: flip a comparison | 16 | 16 | 4 | 0 | 1 | 2 | 9 |
| U: drop a state update | 27 | 27 | 16 | 0 | 0 | 10 | 1 |
| **all** | **154** | **154** | **35** | **8** | **7** | **40** | **64** |

- **Caught: 35** (30 on `move`, 5 more on `write0`). Property 7 catches 15 (a step that never happens leaves a move hanging), property 9 catches 14, and properties 1, 3, 4 and 6 the rest.
- **Ill-formed: 8.** Each drops a guard that keeps a read in range (`n \in DOMAIN mv`, `F # <<>>`, `mv[n].N # <<>>`), so the model reads a move or a fence that does not exist and TLC stops with an error.
- **Unbounded: 7.** Each lets a step that should happen once repeat, so the same entry can be appended again and again: six drop such a guard (`~mv[n].can`, `~lm[n].ab`, `lmv[n].end = <<>>`, ...), and one (m122) weakens the check that drops a repeated copy. Past 10 times the fixed protocol's states, nothing had broken.
- **Equivalent: 64.** On `move` and `write0` they change no reachable state. 19 of them sit on paths only `dedup` and `deep` exercise: the dedup window (`Judge`, `Carried`), stamping with two writes in flight (`NextPos`, the delta filter in `OnReadySend`, the position checks in `OnData`) and writes to t. Those two bounds were not run for them (see the gaps), so here "equivalent" only means "changes nothing at `move` and `write0`".
- **Survived: 40.** They reach new states and still break nothing. Read from the spec's text (reasoned, not checked one by one), they fall into six groups:
  1. **A step that does nothing** (7, all U): the request is not applied (m134) or its answer not recorded (m135); export (m136), cancel (m147), abort (m149) and either branch of recovery (m150, m152) change nothing. An optional step that does nothing is the same as a step not taken or a message lost, which the protocol must survive anyway.
  2. **Links that do not check incarnations** (3, all U): recovery keeps the messages addressed to the old incarnation (m131, and its two halves m151 and m154). See the next paragraph.
  3. **A report sent when its sender's condition no longer holds** (7 G, in `AReports` and `TRep`): for example B asks A for the copy after B has aborted (m015). The receiver checks the same fact again and ignores the report.
  4. **A second check of a fact another guard on the path already checks** (16 G and C). For example, B may abort only if the move's `open` is not in its log (`~lm[n].open`) and s is not open in its log (`~IsOpen(FG(sh), FALSE)`): either check alone is enough, so dropping the first survives (m097) and dropping the second changes nothing (m098); dropping both is slot_move.md's mutant `b-aborts-after-open`, which property 4 catches. Others: `OnReady`'s checks on the appended log beside the committed log's (m044, m045), `FenceOf`'s (m051, m053), `OnAborted`'s (m078, m080), `OnData`'s (m059, m062, m065, m121).
  5. **A check that only makes a step rarer** (4): m008 treats an aborted import as still live, m100 treats every target as busy when a shard recovers, and m072 and m125 make `#meta` refuse a rewrite at the same version. They remove behaviours, and no move hangs because of it at `move`.
  6. **Three that no property here can see:** the two slot_move.md's own mutant table also found uncaught, m001 (B serves once `open` is appended, before it commits: `b-serves-before-open-commits`) and m111 (recovery reopens without asking the other shards: (b) `recovery-trusts-table`); and m110 (recovery reopens without its copy holding s's rows), which is a loss, but property 4 is checked only before a recovery.

**Links without incarnation checks.** slot_move.md says, under what it leaves out, that "a design whose links did not check incarnations would need more fixes than these five". It did not check this. Mutant m131 is exactly that design: after a recovery, messages sent to the old incarnation can still be delivered to the new one. Run on `move`, `write0`, `write` (1,129,562 states) and `moves` (1,273,965 states), it breaks none of the nine properties ([results/mutants.json](results/mutants.json), m131). The likely reason (reasoned): fix 4 already binds the target's incarnation inside the fence, and B checks that epoch on `END` (`car[3] = Epoch(FG(sh))` in `OnData`), so a stale message cannot open the slot at the wrong incarnation. So, at these bounds, the link check is not one more rule the slot move needs. It was not run on `three`, and with only one recovery a second incarnation never appears.

**The rates.** Caught over all 154: 23%. Caught over the 90 that change something at these bounds: **39%**. Counting ill-formed and unbounded as found too: 56%. DEV-03 asks for 85%. slot_move.md's 18 hand-made mutants are caught 16 times (89%), but those were chosen as the rules the design text states; DEV-10's mechanical mutants also hit every second check and every sender-side condition, and most of those turn out to be spare at these bounds.

**The rule count.** By DEV-10 (c), a guard or update is a rule only if removing it lets the checker find a counterexample: **31** (15 guards, 16 updates), or 39 if the 8 dropped domain guards count. The fixed protocol's text has 138 guard conjuncts and updates (111 G and 27 U mutants). Of all 154 mutants, 104 (40 survived, 64 equivalent) were not caught at `move` and `write0`; the 19 equivalent ones on the dedup and stamping paths are the most likely to become rules on `dedup` and `deep`, which would raise the count to at most 43 (12 of those 19 are G or U mutants; the other 7 are comparisons, which DEV-10 (c) does not count as rules).

### 6. Disagreements

**None remains.** On every run both checkers explored, they agree on the verdict, on both state counts, and on the length of every shortest counterexample; every slot_move.py counterexample is a legal TLA+ behavior. So, at these bounds, neither model has a bug that changes a result: slot_move.py's search, its breadth-first step counts, its calm-world liveness check and its encoding of the rules all match an independent TLC run of a TLA+ text. One difference in *reporting* is not a disagreement: slot_move.md's mutant table lists fewer failing properties for three mutants than the full runs find (section 3), because that table stopped each mutant early on purpose.

Two cautions about what agreement means here (see "What the model leaves out"). The TLA+ text was written to match slot_move.py's state one for one, so the two share any misreading of DESIGN-V5 §4.2 that slot_move.md itself makes. And agreement on state counts across 76 configurations, from 18,070 to 7.5 million states, makes an encoding slip that cancels out on every run very unlikely, but it does not prove the two transition relations equal beyond these bounds.

### 7. Cost

Measured from the run records in [results/](results) (wall seconds times TLC workers, on a box shared with other agents, so a core-hour here is often less than a full core):
- the plan in TLC: 8.5 core-hours (74 plan runs and the two `quick` runs, including `fixed three` at 22.9 minutes on two workers); slot_move.py's plan, in full and uncapped: 3.0; the 117 replays: 0.1; the equivalence runs: 0.2; the 154 mechanical mutants and the m131 follow-up: 3.3;
- runs that were cut or dropped and count for nothing: about 3.5 (`no-exporting moves` in pieces, 1.3; the two cut tries at `fixed three`, 0.9; mutant m063 before the state cap, 0.9; the check of the segment method, 0.2).

So about **19 core-hours** against QUESTIONS' estimate of 5 (and its limit of twice that), and about 15 hours of agent wall time from start to verdict, much of it waiting for the shared lock, against an estimate of 10. Most of the overrun is the decision to run every plan run in full on both checkers with no cap (slot_move.md's own plan took 95 CPU-minutes because it capped the mutants), and DEV-10's 154 mutants, which QUESTIONS' estimate did not include.

## What the model leaves out

Everything slot_move.md lists under "What this round leaves out" is left out here too, since the TLA+ spec keeps slot_move.py's abstraction on purpose:
- one recovery per run, then calm (no deposition, no new client send); liveness only before a recovery;
- `#meta` never fails (only delays); the residual case (the old majority still alive); two recoveries, so a third incarnation never appears (links that do not check incarnations are now one of DEV-10's mutants, m131, section 5);
- only A exports, at most two moves and three shards, at most two writes; each write is one opaque cell; no reads, subscribers or cursors; no clocks; no lock fence tables or segment names in the carried state.

And, for this cross-check itself:
- **The two models are not independent readings of DESIGN-V5.** The TLA+ spec was written from slot_move.md with slot_move.py's state and steps in view, to make exact comparison possible. It checks that slot_move.py's search, its liveness algorithm and its encoding of the rules are right, and that each of its counterexamples is real. It is not a second, independent interpretation of the design text. Where the TLA+ text and slot_move.md's prose could be read differently, this README says so.
- **Property 7 is checked by a script on TLC's graph,** not by TLC's own liveness checker (see above). The graph is TLC's; the reachability check is 40 lines of Python.
- `TLCCache` (TLC's memo of an expression by its inputs) speeds up the log views. It is a pure speed-up; the counts with it equal slot_move.py's.

## What this run did not finish

- **Two plan runs are not explored in full by TLC:** `no-exporting` on `moves` (14.7 million states) and on `three` (capped at about 6.6 million in slot_move.py, as in slot_move.md). The mutant is caught by both checkers in full on `move` and `write`, and all six of slot_move.py's counterexamples on these two bounds replay in TLC; what is not shown is that TLC finds no *other* failing property there. Command, not run: `python3 tools/segments.py no-exporting moves --loop`, after moving `$SP/e15/runs/no-exporting-moves-seg` aside (about 2 core-hours).
- **DEV-10's mutants ran on `move` and `write0` only** (and m131 also on `write` and `moves`). The 104 not caught there were not run on `dedup`, `deep`, `moves`, `write` or `three`. The 19 equivalent mutants on the dedup and stamping paths are the ones those bounds are most likely to catch. Command, not run: `./run.sh mutants_more` (about 2 to 3 core-hours for `dedup` and `deep`). Property 7 was checked for the mechanical mutants on `move` only.
- **`write0` stands in for `write`** in the mutant passes: `write` without depositions, a sixth of the size. A mutant that needs a deposition and a write together to fail would be missed there; slot_move.md's 18 mutants did run on `write` itself.
- **No S mutants** (swap two updates): none arise in this text (section 5).
- **slot_move.md's untested claim about links** (that links without incarnation checks need more fixes) is answered at four bounds only, and never with two recoveries.

## Reproduce

`./run.sh` (all steps; about 15 core-hours on this box when it is shared, in lock holds of at most about 25 minutes), or one step: `./run.sh plan | three | replay | compare | equiv | mutants | link`. One run: `python3 tools/tlcrun.py fixed move --workers 1`. The README's summary tables: `python3 tools/summary.py > results/summary.md`. Needs Java 21, Python 3.13 and the TLA+ tools jar ([fetch.sh](fetch.sh)). Box: 4 vCPU, 15 GB, Linux 6.18 (Firecracker VM), TLC2 2026.11.06.005304 (rev 3ec1cc4), OpenJDK 21.0.12, Python 3.13. Raw results: [results/](results).

Q-15: Yes: TLC on a TLA+ spec of the slot move agrees with slot_move.py on all 74 runs both explored in full (the same failing properties, state counts and shortest-trace lengths, up to 7.5 million states at Q-15's bound of three shards, two moves and one unclean recovery), all 117 slot_move.py counterexamples replay in TLC, and both catch the same 16 of 18 mutants, so neither model has a bug and the five-fix move stands; but DEV-10's 154 mechanical mutants are caught only 35 times (39% of the 90 that change anything at `move` and `write0`, bar 85%), because most of the fixed protocol's guards are spare at these bounds (31 rules), and links without incarnation checks break nothing (m131). Moves: every `slot` row (MIN, MIN-P, MIN-TS, DRAFT, RUST, SRV, LEAN, SLOG, OBJ, RLOG, EMB-V8, SIDE) up on DEV-03's model clause for the slot move (a second checker, TLC, agrees run for run; the largest bound finishes in 23 minutes); DEV-03's 85% mutant clause stays open for P `slot` (39% here); DEV-01 and DEV-10 count the slot move at 31 rules, and the link incarnation check is not one of them.
