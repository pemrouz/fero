# E-15: the slot move in TLA+, checked against slot_move.py

**Question (Q-15).** Does a TLA+ model of the slot move give the same verdicts as [slot_move.py](../../../v5-spec/slot_move.py)?

RESULTS-IN-SHORT

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
| [tools/segments.py](tools/segments.py) | Runs one TLC run too big for one lock hold (`fixed three`) in pieces: TLC checkpoints, stops, and the next hold resumes it (`-recover`); the pieces' outputs are merged. |
| [tools/mdcheck.py](tools/mdcheck.py) | Puts slot_move.md's printed numbers beside both checkers' numbers here. |

**How the TLA+ spec was written.** From slot_move.md's description of the model and its fixed rules, step by step, with slot_move.py open beside it to keep the same abstraction: the same state (each shard's committed log, tail, deposition count, lost tails, waiting answers; the table; the client; the message set; the moves started, the recovery flag, and the ghost "highest position ever committed"), the same reports (a message enters the network the moment a log makes it true), the same bounds. Values are encoded one for one (a position is `<<epoch, seq>>`, a table version is slot_move.py's nested tuple, flattened). This was a deliberate choice: with the same state, the two checkers must agree not only on verdicts but on **state counts**, and every Python counterexample must be a legal TLA+ behavior. Any difference then points at a bug in one of them.

## How the two checkers are compared

1. **The same 76 runs.** slot_move.py's `plan()`: 26 variants (design, fixed, 6 readings, 18 mutants) on the bounds where each matters, among `move`, `moves`, `write`, `dedup`, `deep` and `three`. Both checkers explore every run **in full**. slot_move.md's table stopped a mutant once a property failed past 1,000,000 states (`--cap`); here no run is capped, so a capped run's counts differ from slot_move.md's.
2. **Verdicts:** the set of properties that fail. This is Q-15's threshold.
3. **State counts**, for the main search and for the calm graph.
4. **Steps** in each shortest counterexample. slot_move.py searches breadth first. TLC does too, and each property's failure is printed with its depth, with the search going on (so one run gives every property). With two TLC workers a depth could in principle come out one too high; a run whose steps differed would be re-run with one worker. None differed.
5. **Replays:** every counterexample slot_move.py printed is replayed in TLC (method above). A safety replay succeeds when TLC reaches the last state with the same property broken, in the same number of steps. A liveness replay succeeds when the trace's last state, after the calm step, lands on slot_move.py's stuck state, and TLC then explores everything reachable from it and finds no way to end the moves.
6. **Property 7 in TLC.** TLC cannot check "AG EF" (a branching-time property) itself. The spec adds slot_move.py's calm step as an action, so the calm world is part of TLC's state graph; TLC prints each calm state (with whether it is Done) and each calm step, and [tools/agef.py](tools/agef.py) finds the calm states from which no Done state can be reached. This is how E-14 checked liveness too.

## Results

### 1. The plan's runs: both checkers, side by side

slot_move.py's `plan()` has 76 runs. Both checkers explored **PLAN_BOTH of them in full, and agree on all PLAN_BOTH**: the same failing properties, the same number of states (for the main search and for the calm graph), and the same number of steps in every shortest counterexample.

| Variants | Runs in the plan | Done on both | Same verdict | Same states | Same steps |
|---|---|---|---|---|---|
| `design`, `fixed` | 11 | 10 | 10 | 10 | 10 |
| the six readings | 18 | 18 | 18 | 18 | 18 |
| the 18 mutants | 47 | 45 | 45 | 45 | 45 |
| **all** | **76** | **73** | **73** | **73** | **73** |

Not run on both: `no-exporting moves` (slot_move.py only); `fixed three` (slot_move.py only); `no-exporting three` (slot_move.py only).

The runs range from 23,547 states (`abort-keeps-table` on `move`) to 7,510,764 (`fixed` on `three`). The three runs TLC did not explore in full:
- `no-exporting` on `moves` (14,724,097 states in slot_move.py, in 941 s) and on `three` (which slot_move.py, like slot_move.md, stops once a property has failed past 1,000,000 states: 6,554,885 states here, 6,554,919 in slot_move.md). An earlier TLC run of `moves`, in checkpointed pieces, reached 6.85 million states; the output of its last piece was not kept, so its calm graph is incomplete, and it is not counted. Both runs were then dropped to stay near the CPU budget. This mutant is already caught on `move` and `write` by both checkers in full, and every counterexample slot_move.py prints for it on `moves` (properties 1, 6, 7, 9) and `three` (7, 9) replays in TLC (section 2).
- THREE_NOTE

The full table, run by run, is [results/compare.md](results/compare.md) (raw: [results/py/](results/py) and [results/tlc/](results/tlc), one JSON a run, with TLC's trimmed log beside it). For property 7, TLC's column gives no step count: TLC's calm graph says only *that* a stuck state exists; the steps to it come from slot_move.py, and the replays below confirm them.

### 2. Every slot_move.py counterexample is a real TLA+ behavior

**117 of 117 replays succeed** ([results/replays.json](results/replays.json)). They cover all 51 runs where slot_move.py finds a failure (50 of the plan's runs, plus `design quick`), and every property that fails in each: property 1 (23 traces), 2 (9), 3 (4), 4 (11), 5 (8), 6 (14, of which 7 break it on a commit step rather than in a state), 7 (14) and 9 (34). The longest trace has 32 steps (`fixed-but-recovery-resumes` on `moves`, property 1). Each safety replay reaches its broken state in TLA+ in exactly slot_move.py's number of steps; each liveness replay lands on slot_move.py's stuck state, and TLC then finds no way from there to end the moves. Two of the replays are of runs TLC did not explore in full here: `no-exporting` on `three` (properties 7 and 9, with shard C) and on `moves` (properties 1, 6, 7 and 9).

### 3. slot_move.md's printed numbers

slot_move.py, re-run here unchanged, gives every number slot_move.md prints for its full runs: the 29 rows of its table of the text, the fix and the readings (states, failing properties and steps), and the liveness graph sizes for `fixed` (205, 3,694, 1,725, 5,694, 16,923 and 17,819 states). TLC gives the same on TBD-MD of the 29 rows ([results/mdcheck.md](results/mdcheck.md)).

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

Lines tagged `\* env` are bounds of the model (moves allowed, the calm world, one recovery), not rules, and are left alone. **SlotMoveFixed is the fixed protocol:** it has exactly SlotMove's (and slot_move.py's) states and calm states on `move` (47,457 and 205), `dedup` (351,262 and 5,694), `deep` (308,274 and 16,923) and `write0` (191,617 and 1,725), with every property holding ([results/fixed-equiv.json](results/fixed-equiv.json)). `write0` is `write` without depositions: one write to s with one resend, a move and a recovery, at a sixth of `write`'s size.

**How they were run.** Each mutant runs in TLC (one worker) with properties 1 to 6, 8 and 9 as invariants: first on `move`, then, if nothing broke there and property 7 holds on `move`'s calm graph, on `write0`, `deep` and `dedup` in turn, until one breaks. A mutant is:
- **caught** when some property breaks on some bound;
- **ill-formed** when TLC cannot evaluate it: dropping a guard such as `n \in DOMAIN mv` makes the model read a move that does not exist. In code this would be a crash or a read of garbage; the checker treats it as an error, so it is not silent, but it is counted apart;
- **unbounded** when the state space grows past 10 times the fixed protocol's on that bound with no property broken in the part searched (the cap is a TLC constraint; with one worker the search order, and so the cut, is fixed). This kind was added after mutant m063 ran for 55 minutes on `move` with no end in sight ([results/capcheck.txt](results/capcheck.txt) checks the cap);
- **equivalent** when nothing breaks and its state counts equal the fixed protocol's on every bound it ran: at these bounds the guard or update changes nothing that can be reached;
- **survived** when nothing breaks, but it reaches states the fixed protocol does not.

DEV10-RESULTS

### 6. Disagreements

**None remains.** On every run both checkers explored, they agree on the verdict, on both state counts, and on the length of every shortest counterexample; every slot_move.py counterexample is a legal TLA+ behavior. So, at these bounds, neither model has a bug that changes a result: slot_move.py's search, its breadth-first step counts, its calm-world liveness check and its encoding of the rules all match an independent TLC run of a TLA+ text. One difference in *reporting* is not a disagreement: slot_move.md's mutant table lists fewer failing properties for three mutants than the full runs find (section 3), because that table stopped each mutant early on purpose.

Two cautions about what agreement means here (see "What the model leaves out"). The TLA+ text was written to match slot_move.py's state one for one, so the two share any misreading of DESIGN-V5 §4.2 that slot_move.md itself makes. And agreement on state counts across 60-odd configurations, from 18,070 to 7.5 million states, makes an encoding slip that cancels out on every run very unlikely, but it does not prove the two transition relations equal beyond these bounds.

### 7. Cost

TBD-COST

## What the model leaves out

Everything slot_move.md lists under "What this round leaves out" is left out here too, since the TLA+ spec keeps slot_move.py's abstraction on purpose:
- one recovery per run, then calm (no deposition, no new client send); liveness only before a recovery;
- `#meta` never fails (only delays); the residual case (the old majority still alive); links that do not check incarnations;
- only A exports, at most two moves and three shards, at most two writes; each write is one opaque cell; no reads, subscribers or cursors; no clocks; no lock fence tables or segment names in the carried state.

And, for this cross-check itself:
- **The two models are not independent readings of DESIGN-V5.** The TLA+ spec was written from slot_move.md with slot_move.py's state and steps in view, to make exact comparison possible. It checks that slot_move.py's search, its liveness algorithm and its encoding of the rules are right, and that each of its counterexamples is real. It is not a second, independent interpretation of the design text. Where the TLA+ text and slot_move.md's prose could be read differently, this README says so.
- **Property 7 is checked by a script on TLC's graph,** not by TLC's own liveness checker (see above). The graph is TLC's; the reachability check is 40 lines of Python.
- `TLCCache` (TLC's memo of an expression by its inputs) speeds up the log views. It is a pure speed-up; the counts with it equal slot_move.py's.

## What this run did not finish

GAPS-LIST

## Reproduce

`./run.sh` (all steps; about 15 CPU-hours on this box when it is shared, in lock holds of at most about 25 minutes), or one step: `./run.sh plan | three | replay | compare | equiv | mutants`. One run: `python3 tools/tlcrun.py fixed move --workers 1`. The README's summary tables: `python3 tools/summary.py > results/summary.md`. Needs Java 21, Python 3.13 and the TLA+ tools jar ([fetch.sh](fetch.sh)). Box: 4 vCPU, 15 GB, Linux 6.18 (Firecracker VM), TLC2 2026.11.06.005304 (rev 3ec1cc4), OpenJDK 21.0.12, Python 3.13. Raw results: [results/](results).

VERDICT
