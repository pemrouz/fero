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

**How the TLA+ spec was written.** From slot_move.md's description of the model and its fixed rules, step by step, with slot_move.py open beside it to keep the same abstraction: the same state (each shard's committed log, tail, deposition count, lost tails, waiting answers; the table; the client; the message set; the moves started, the recovery flag, and the ghost "highest position ever committed"), the same reports (a message enters the network the moment a log makes it true), the same bounds. Values are encoded one for one (a position is `<<epoch, seq>>`, a table version is slot_move.py's nested tuple, flattened). This was a deliberate choice: with the same state, the two checkers must agree not only on verdicts but on **state counts**, and every Python counterexample must be a legal TLA+ behavior. Any difference then points at a bug in one of them.

## How the two checkers are compared

1. **The same 76 runs.** slot_move.py's `plan()`: 26 variants (design, fixed, 6 readings, 18 mutants) on the bounds where each matters, among `move`, `moves`, `write`, `dedup`, `deep` and `three`. Both checkers explore every run **in full**. slot_move.md's table stopped a mutant once a property failed past 1,000,000 states (`--cap`); here no run is capped, so a capped run's counts differ from slot_move.md's.
2. **Verdicts:** the set of properties that fail. This is Q-15's threshold.
3. **State counts**, for the main search and for the calm graph.
4. **Steps** in each shortest counterexample. slot_move.py searches breadth first. TLC does too, and each property's failure is printed with its depth, with the search going on (so one run gives every property). With two TLC workers a depth can come out one too high, so a run whose steps differ is re-run with one worker.
5. **Replays:** every counterexample slot_move.py printed is replayed in TLC (method above). A safety replay succeeds when TLC reaches the last state with the same property broken, in the same number of steps. A liveness replay succeeds when the trace's last state, after the calm step, lands on slot_move.py's stuck state, and TLC then explores everything reachable from it and finds no way to end the moves.
6. **Property 7 in TLC.** TLC cannot check "AG EF" (a branching-time property) itself. The spec adds slot_move.py's calm step as an action, so the calm world is part of TLC's state graph; TLC prints each calm state (with whether it is Done) and each calm step, and [tools/agef.py](tools/agef.py) finds the calm states from which no Done state can be reached. This is how E-14 checked liveness too.

RESULTS

## What the model leaves out

Everything slot_move.md lists under "What this round leaves out" is left out here too, since the TLA+ spec keeps slot_move.py's abstraction on purpose:
- one recovery per run, then calm (no deposition, no new client send); liveness only before a recovery;
- `#meta` never fails (only delays); the residual case (the old majority still alive); links that do not check incarnations;
- only A exports, at most two moves and three shards, at most two writes; each write is one opaque cell; no reads, subscribers or cursors; no clocks; no lock fence tables or segment names in the carried state.

And, for this cross-check itself:
- **The two models are not independent readings of DESIGN-V5.** The TLA+ spec was written from slot_move.md with slot_move.py's state and steps in view, to make exact comparison possible. It checks that slot_move.py's search, its liveness algorithm and its encoding of the rules are right, and that each of its counterexamples is real. It is not a second, independent interpretation of the design text. Where the TLA+ text and slot_move.md's prose could be read differently, this README says so.
- **Property 7 is checked by a script on TLC's graph,** not by TLC's own liveness checker (see above). The graph is TLC's; the reachability check is 40 lines of Python.
- `TLCCache` (TLC's memo of an expression by its inputs) speeds up the log views. It is a pure speed-up; the counts with it equal slot_move.py's.

## Reproduce

`./run.sh` (all steps; about 8 CPU-hours on this box, in lock holds of at most about 25 minutes), or one step: `./run.sh plan | replay | compare | equiv | mutants`. One run: `python3 tools/tlcrun.py fixed move --workers 1`. Needs Java 21, Python 3.13 and the TLA+ tools jar ([fetch.sh](fetch.sh)). Box: 4 vCPU, 15 GB, Linux 6.18 (Firecracker VM), TLC2 2026.11.06.005304 (rev 3ec1cc4), OpenJDK 21.0.12, Python 3.13. Raw results: [results/](results).

VERDICT
