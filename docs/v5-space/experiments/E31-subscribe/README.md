# E-31: the subscribe protocol across failover, slot moves and relays

**Question (Q-31).** Does the subscribe protocol (L3) keep its promises across failover, slot moves and relays?

**Threshold.** All properties hold at the stated bounds within 1 h. Any counterexample is a rule change in DESIGN-V5 §4.4 before phase 1 fixes the cursor shape.

@@INSHORT@@

## Words used here

- **Subscribe** (DESIGN-V5 4.4, layer L3, "flow"): one verb that serves followers, clients and relays. A subscriber sends a **cursor** (here, for one slot: the slot's sequence last seen) and a **mode**:
  - **`state`**: a snapshot of the selected partitions, then **deltas** (record by record, or **conflated** per row for a slow reader: one diff from the cursor to the server's fold, carrying rows set and rows removed). A snapshot **replaces** the subscriber's whole view.
  - **`log`**: every record from the cursor, never conflated.
- A server's **fold** is its replica's applied state: the rows at some position. It is **loaded** once its snapshot has loaded. A server **holds** a slot while the slot is open in its group.
- **Answers that send a subscriber elsewhere**: `moved` (this server does not serve the slot; go to the one named), `retry` (not ready yet; try again), `END` (this server stops serving; resubscribe elsewhere with your cursor), `expired` (your cursor is older than anything kept; the reader throws it to the app).
- **Credits**: a subscriber grants credit; here every link carries at most one message at a time (a credit of one record).
- A **relay** subscribes upstream like any client and serves its own subscribers from its fold.
- **Positions**: per slot, a sequence that goes on across a slot move (O `slot`). The option `off` gives each group its own offsets instead (O `off`).
- **AG EF**: "from every reachable state, the goal can still be reached" (the liveness check of E-14, E-16 and E-17).
- **DEV-10**: a **rule** is one guard conjunct or one state update in a model action, counted only if removing it lets the checker find a counterexample (ablation). **Mutants** are made by script: drop each guard, drop each update, flip each comparison, swap each pair of updates in one action.

## Method

One exhaustive model in plain Python, in slot_move.py's style (states, faults, shortest counterexample traces), written on E-16's engine ([../E16-controller-loop/engine/engine.py](../E16-controller-loop/engine/engine.py)), which uses E-17's shared rule language unchanged and E-17's ablation and mutant procedure, as E-24 and E-33 do. E-17's world (partitions moving between groups, no subscribers) does not fit; this model brings its own. Rule counts here compare only with each other.

### The world (not counted)

- **One followed slot s** and its committed log, written from a fixed script: record 1 `set a`, record 2 `set b` (the client's own write), record 3 `del a`. Each prefix has a different fold ({}, {a}, {a, b}, {b}), so a stale view, a ghost row or a skipped record shows.
- **Group A** holds s at first: its leader LA and its follower FA. **Group B**'s leader LB takes s when the bound moves it. The holding group's leader has at most one uncommitted entry (the tail). A commit appends it to the log. A leader crash loses it; the client retries its own write, other writers do not, so a different record may take that position (which is what makes a leaked uncommitted record visible).
- A **server's fold** is (loaded, fold, base): it holds the records in (base, fold] and the rows at fold. LA keeps every segment (base 0). FA catches up one record at a time. FA may fall behind the tail and **reload a snapshot** (a fault): while it loads it is unloaded; then its fold is the commit offset and its base the same offset (it holds no older records).
- **The slot move** (bounds `mv`, `all`): A fences s at N, the commit offset (with no tail), then B opens s with A's rows at N. A answers `moved` for s once it has fenced; B answers `retry` until it opens. E-15 checks the move itself; here it is two steps.
- **A relay** R (bounds `rl`, `all`) subscribes upstream to any server and serves the client from its own fold. It may crash and restart empty.
- **The client** C has one subscription in the bound's mode, and writes record 2. It may resubscribe anywhere at any time a link ends.
- **Faults** (a budget): LA crashes (FA leads A from then on); FA reloads; the relay crashes; a link drops (a bounded queue overflowed). Calm steps for liveness: every protocol step, commits, catch-up, a reload finishing, a relay restart, a subscriber noticing a dead server. Starting the move is a control step.

### The protocol (counted, DEV-10)

As DESIGN-V5 4.4 writes it:
- **Who serves**: a server sends a snapshot, a diff or a record only if it is loaded (a relay: once its upstream snapshot has landed) and holds the slot; never before its fold has reached the subscriber's cursor; a record only up to its fold (committed records only) and only if it holds it; a diff only if it holds the records after the cursor (else a snapshot replaces).
- **Answers**: an unloaded server, or B before it opens, answers `retry` (or `moved`, naming a ready one; the client treats both the same: it goes elsewhere, with its cursor). A, once fenced, answers `moved`. In `log` mode, a server that no longer holds the record after the cursor ends the subscription: the **draft** answers `expired` (DESIGN-V5 4.4: "A follower that falls behind the tail and reloads a snapshot ends its log subscriptions on that shard with `expired`"); the **fixed** option answers `END`.
- **The subscriber**: a snapshot clears the view and applies the rows, then sets the cursor; a diff adds the rows set and removes the rows removed; a record is applied and moves the cursor one on. `moved`, `retry` and `END` make it resubscribe elsewhere with its cursor; `expired` is thrown to the app.
- **The move's carried state that serving needs**: B starts from A's rows at N, and with the names of A's segments below N (so B can serve `log` readers from before N).
- **The client's write** resolves when it has committed and the client's own subscription has passed its position.

### Options

| Option | What differs |
|---|---|
| `draft` | DESIGN-V5 4.4 as written. |
| `fixed` | A server that cannot serve a `log` cursor answers `END`, not `expired`. |
| `off` | `fixed`, with positions as each group's own offsets (O `off`): B's log holds one record of another slot first, so B's offsets for s are one higher than A's. |

### Properties

| Id | Property |
|---|---|
| P1 | `log`: what the client took is the committed log's prefix, in order, each record once. |
| P2 | `state`: the client's view equals the fold of the committed log at its cursor, after every message (no ghost rows, nothing uncommitted, nothing skipped). |
| P3 | Nobody answers from an unloaded fold: no snapshot, record or diff from a server or relay that has not loaded. |
| P4 | A resolved write is visible to its writer's own subscription, and stays visible (the cursor is at or past it). |
| P6 | The client's cursor never goes back. |
| P7 | No false `expired`: the client is told `expired` only when no live, loaded replica that holds the slot has its next record. |
| P5 | AG EF: from every state, with faults over, the client reaches a serving replica and catches up: the script written, its cursor at the commit offset, its write resolved. This is "after `moved`, `END` or `retry`, a fault-free path reaches a serving replica". |

### Bounds

| Bound | Mode | Move | Relay | Faults |
|---|---|---|---|---|
| `fo-state`, `fo-log` | state, log | no | no | 1 of: LA crash, FA reload, link drop |
| `mv-state`, `mv-log` | state, log | yes | no | 1 of: LA crash, link drop |
| `rl-state`, `rl-log` | state, log | no | yes | 1 of: LA crash, relay crash, link drop |
| `all-state`, `all-log` (verify) | state, log | yes | yes | 2 of any kind |

@@RESULTS@@

## What the model leaves out

- **One slot, one subscriber, one write of its own.** A selection of many slots is many copies of this one, as long as each delta carries its slot's sequence (DESIGN-V5 4.4); a cursor over 1,024 slots is not modelled.
- **Unclean recovery and epochs.** A slot's epoch changes only on `fero recover --unclean`; the `unknown-log` and "a newer epoch means retry" rules are not exercised. slot_move.py and E-15 own recovery.
- **The move's own protocol** (fence, copy, `open`, the slot table): two atomic steps here; E-15 and E-17 check it.
- **Retention.** Every record is kept somewhere (LA, or B's carried segment names), so a true `expired` never happens here; P7 checks that none is given falsely.
- **Credits above one record, conflation inside a relay's tombstones, frame splitting of big rows.** A relay's diff is computed from the committed log at the cursor; a real relay needs per-row change positions and tombstones kept since its last snapshot to do the same.
- **The pending-write minimum** ("waiting writes' positions go along as a minimum"): not modelled as a rule; resolution already waits for the cursor (see the results).
- **Time and far links.** A far relay is the same relay with any delay; there are no clocks.

## Files

- [models/subscribe.py](models/subscribe.py): the model. [run.sh](run.sh): every run below. [fetch.sh](fetch.sh): nothing to fetch.
- [results/](results): `design.txt` (every option on every bound, with traces), `fixed-ablation.json` (DEV-10), `summary.md` (the rule table and mutants).
- Machine: Ubuntu 24.04 in a Firecracker VM, 4 vCPU, 15 GB RAM; Python 3.13. Every run held `$SP/bin/heavy` (shared) while other agents' jobs ran.

@@VERDICT@@
