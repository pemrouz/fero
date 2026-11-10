# E-31: the subscribe protocol across failover, slot moves and relays

**Question (Q-31).** Does the subscribe protocol (L3) keep its promises across failover, slot moves and relays?

**Threshold.** All properties hold at the stated bounds within 1 h. Any counterexample is a rule change in DESIGN-V5 §4.4 before phase 1 fixes the cursor shape.

**In short.**
- **The draft breaks one promise** (model-checked, 7 steps, one fault): a follower that reloaded a snapshot tells a `log` reader `expired`, though the leader still holds every record. A routine reload ends the reader's stream for good.
- **The fix is one rule change in DESIGN-V5 4.4** (option `fixed`): a replica that does not hold the reader's next record answers `END` (go elsewhere, with your cursor); only the holding group's leader says `expired`. With it, **every property holds on all ten bounds** (a leader crash, a follower's reload, a dropped link, a relay crash, a slot move, a relay; modes `state` and `log`), each explored in full, up to 7.6 million states, in about 15 minutes of CPU, inside the 1 h.
- **Cursors must be per-slot sequences** (O `slot`, the draft's shape). With each group's own offsets (O `off`), the first slot move breaks both modes in 5 steps: in `state` the cursor names another position than the rows show; in `log` the new group gives a false `expired`.
- **A move must leave the records below its fence reachable** (DESIGN-V5 4.2's carried segment names). Without them, B tells every `log` reader behind the fence `expired` while A's replicas still hold the records (8 steps, a targeted check with a stronger reading of "no false `expired`"). So that carried item is a needed rule, not an extra.
- **DEV-10:** 26 rules needed by ablation, of 62 written (4 more are pinned), and 27 with the segment names. 31 of 32 non-equivalent mutants caught (97%).
- **Not finished:** every feature at once with **two** faults (`all-state`, `all-log`). Each ran to 3 million states with no counterexample (a partial check). Every feature at once with one fault of any kind finishes and holds in both modes; so do the move with two faults and the relay with one.

## Words used here

- **Subscribe** (DESIGN-V5 4.4, layer L3, "flow"): one verb that serves followers, clients and relays. A subscriber sends a **cursor** (here, for one slot: the slot's sequence last seen) and a **mode**:
  - **`state`**: a snapshot of the selected partitions, then **deltas** (record by record, or **conflated** per row for a slow reader: one diff from the cursor to the server's fold, carrying rows set and rows removed). A snapshot **replaces** the subscriber's whole view.
  - **`log`**: every record from the cursor, never conflated.
- A server's **fold** is its replica's applied state: the rows at some position. It is **loaded** once its snapshot has loaded. A server **holds** a slot while the slot is open in its group.
- **Answers that send a subscriber elsewhere**: `moved` (this server does not serve the slot; go to the one named), `retry` (not ready yet; try again), `END` (this server stops serving; resubscribe elsewhere with your cursor), `expired` (your cursor is older than anything kept; the reader throws it to the app).
- **Credits**: a subscriber grants credit; here every link carries at most one message at a time (a credit of one record).
- A **relay** subscribes upstream like any client and serves its own subscribers from its fold.
- **Positions**: per slot, a sequence that goes on across a slot move (O `slot`). The option `off` gives each group its own offsets instead (O `off`).
- **The fence**: a slot move stops the slot at the old group at a position N; the new group goes on from N + 1.
- **AG EF**: "from every reachable state, the goal can still be reached" (the liveness check of E-14, E-16 and E-17).
- **DEV-10**: a **rule** is one guard conjunct or one state update in a model action, counted only if removing it lets the checker find a counterexample (ablation). **Mutants** are made by script: drop each guard, drop each update, flip each comparison, swap each pair of updates in one action.

## Method

One exhaustive model in plain Python, in slot_move.py's style (states, faults, shortest counterexample traces), written on E-16's engine ([../E16-controller-loop/engine/engine.py](../E16-controller-loop/engine/engine.py)), which uses E-17's shared rule language unchanged and E-17's ablation and mutant procedure, as E-24 and E-33 do. E-17's world (partitions moving between groups, no subscribers) does not fit; this model brings its own. Rule counts here compare only with each other.

### The world (not counted)

- **One followed slot s** and its committed log, written from a fixed script: record 1 `set a`, record 2 `set b` (the client's own write), record 3 `del a`. Each prefix has a different fold ({}, {a}, {a, b}, {b}), so a stale view, a ghost row or a skipped record shows.
- **Group A** holds s at first: its leader LA and its follower FA. **Group B**'s leader LB takes s when the bound moves it. The holding group's leader has at most one uncommitted entry (the tail). A commit appends it to the log. A leader crash loses it; the client retries its own write, other writers do not, so a different record may take that position (which is what makes a leaked uncommitted record visible).
- **A server's fold** is (loaded, fold, base): it holds the records in (base, fold] and the rows at fold. LA keeps every segment (base 0). FA catches up one record at a time. FA may fall behind the tail and **reload a snapshot** (a fault): while it loads it is unloaded; then its fold is the commit offset and its base the same offset (it holds no older records).
- **The slot move** (bounds `mv`, `fo2`, `mvrl`): A fences s at N, the commit offset (with no tail), then B opens s with A's rows at N. A answers `moved` for s once it has fenced; B answers `retry` until it opens. E-15 checks the move itself; here it is two steps.
- **A relay** R (bounds `rl`, `mvrl`) subscribes upstream to any server and serves the client from its own fold. It may crash and restart empty.
- **The client** C has one subscription in the bound's mode, and writes record 2. It may resubscribe anywhere at any time a link ends.
- **Faults** (a budget): LA crashes (FA leads A from then on); FA reloads; the relay crashes; a link drops (a bounded queue overflowed). Calm steps for liveness: every protocol step, commits, catch-up, a reload finishing, a relay restart, a subscriber noticing a dead server. Starting the move is a control step.

### The protocol (counted, DEV-10)

As DESIGN-V5 4.4 writes it:
- **Who serves**: a server sends a snapshot, a diff or a record only if it is loaded (a relay: once its upstream snapshot has landed) and holds the slot; never before its fold has reached the subscriber's cursor; a record only up to its fold (committed records only) and only if it holds it; a diff only if it holds the records after the cursor (else a snapshot replaces).
- **Answers**: an unloaded server, or B before it opens, answers `retry` (or `moved`, naming a ready one; the client treats both the same: it goes elsewhere, with its cursor). A, once fenced, answers `moved`. In `log` mode, a server that no longer holds the record after the cursor ends the subscription: the **draft** answers `expired` (DESIGN-V5 4.4: "A follower that falls behind the tail and reloads a snapshot ends its `log` subscriptions on that shard with `expired`"); the **fixed** option answers `END`, and only the holding group's leader, whose log is the group's retention, answers `expired`.
- **The subscriber**: a snapshot clears the view and applies the rows, then sets the cursor; a diff adds the rows set and removes the rows removed; a record is applied and moves the cursor one on. `moved`, `retry` and `END` make it resubscribe elsewhere with its cursor; `expired` is thrown to the app.
- **The move's carried state that serving needs**: B starts from A's rows at N, and with the names of A's segments below N, so B can serve `log` readers from before N, as far back as a live A replica still holds them. There is no object store in this model: with one, every replica could reach every kept segment, and `expired` would come only from retention. (DESIGN-V5 4.2 gives this job to B only once A is deleted; before that B answers `moved(A)` and A serves the records below N. The model takes the one-server form; see "What the model leaves out".)
- **The client's write** resolves when it has committed and the client's own subscription has passed its position.

### Options

| Option | What differs |
|---|---|
| `draft` | DESIGN-V5 4.4 as written. |
| `fixed` | A replica that cannot serve a `log` cursor answers `END`, not `expired`; only the holding group's leader says `expired`. |
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
| P5 | AG EF: from every state, with faults over, the client reaches a serving replica and catches up: the script written, its cursor at the commit offset, its write resolved (or it was told a true `expired`, which P7 checks). This is "after `moved`, `END` or `retry`, a fault-free path reaches a serving replica". |
| P7s | (the targeted check of section 3 only) P7 with any live, loaded replica, in either group, whether or not its group still holds the slot. |

### Bounds

| Bound | Mode | Move | Relay | Faults |
|---|---|---|---|---|
| `fo-state`, `fo-log` | state, log | no | no | 1 of: LA crash, FA reload, link drop |
| `mv-state`, `mv-log` | state, log | yes | no | 1 of: LA crash, link drop |
| `rl-state`, `rl-log` | state, log | no | yes | 1 of: LA crash, relay crash |
| `fo2-state`, `fo2-log` (verify) | state, log | yes | no | 2 of: LA crash, FA reload, link drop |
| `mvrl-log` (verify) | log | yes | yes | 1 of any kind |
| `mvrl-state` (one run, 6 GB) | state | yes | yes | 1 of any kind |
| `all-state`, `all-log` (do not finish) | state, log | yes | yes | 2 of any kind |

The first six are the sweep; the next three are the verify bounds, each adding one thing to the sweep. `mvrl-state` has 7.6 million states: too large for the ablation's many runs, so it is run once, in full, on the design. The last two passed 3 million states without an end, so they cannot decide a run; section 4 gives their partial result.

## Results

### 1. Which designs hold (model-checked here, [results/design.txt](results/design.txt))

| Option | fo-log | fo-state | mv-log | mv-state | rl-log | rl-state | fo2-state | fo2-log | mvrl-log | mvrl-state |
|---|---|---|---|---|---|---|---|---|---|---|
| `draft` | **P7**, 7 steps | holds | holds | holds | holds | holds | holds | **P7** | **P7** | as `fixed` (see below) |
| `fixed` | holds | holds | holds | holds | holds | holds | holds | holds | holds | holds |
| `off` | holds | holds | **P7**, 5 steps | **P2**, 5 steps | holds | holds | **P2** | **P7** | **P7** | not run |
| states (`fixed`) | 5,467 | 8,081 | 18,646 | 24,989 | 54,404 | 390,164 | 118,772 | 96,177 | 1,491,048 | 7,590,751 |
| seconds (`fixed`) | 0.3 | 0.4 | 1.0 | 1.5 | 3.9 | 37.0 | 11.8 | 9.0 | 161.2 | 669.7 |

Every run that holds is complete (every reachable state explored, liveness included); a run that breaks stops at its first, shortest counterexample. All ten `fixed` runs together take 896 seconds (about 15 minutes) on one core, inside Q-31's 1 h. `mvrl-state` is in [results/design-mvrl-state.txt](results/design-mvrl-state.txt); it was run on `fixed` only. In `state` mode `draft` and `fixed` are the same model (the change is in an answer to `log` readers; their state counts are equal on every other `state` bound), so that run stands for `draft` too. A second search of the same bound with different code ([safety_reach.py](safety_reach.py): safety only, hashed states, [results/safety-reach.txt](results/safety-reach.txt)) finds the same 7,590,751 states and no broken property.

**The draft's false `expired`, 7 steps (P7).**
1. Record 1 commits at A.
2. FA falls behind the tail and reloads a snapshot at 1: it now holds the rows at 1, but no record before it.
3. The client opens a `log` subscription at FA from the start (cursor 0).
4. FA cannot send record 1. DESIGN-V5 4.4 says a reloaded follower "ends its `log` subscriptions on that shard with `expired`", so it does.
5. The client's reader throws `expired` to the app (API.md: "Iterating throws 'expired'"), although LA, alive, holds record 1 and every record after it.

So a follower's routine snapshot reload, which is not a loss of data, ends a log reader's stream for good. The fix (option `fixed`, holds on every bound): a replica that does not hold the reader's next record answers `END` (resubscribe elsewhere, with the cursor), and only the holding group's leader, whose log is the group's retention, says `expired`. With LA dead as well (two faults, `fo2-log`), the leader FA does say `expired`, and it is true: no live replica holds record 1 (in this model, with no object store).

The nearest precedent for the fix is Kafka's follower fetching ([KIP-392](https://cwiki.apache.org/confluence/display/KAFKA/KIP-392%3A+Allow+consumers+to+fetch+from+closest+replica)), SPACE's own precedent for W `any`: a consumer that gets "offset out of range" from a follower checks with the leader before it resets its position (cited from memory of the KIP's out-of-range section; not re-read here).

**Cursors as each group's own offsets fail at the first move (`off`).** B's log holds a record of another slot before s's records, so B's offsets for s are one higher than A's. In `state` mode (P2, 5 steps), B's snapshot carries B's offset, and the client's cursor then names a different position of s than its rows show. In `log` mode (P7, 5 steps), B reads the client's fresh cursor as its own offset and decides it no longer holds the next record, though it holds every record of s. A per-slot sequence (O `slot`, the draft's cursor) has neither problem: positions go on unchanged at B, and `fixed` holds on every move bound. This is the cursor shape DEV-09 fixes in phase 1.

### 2. DEV-10: rules and mutants (model-checked here, [results/summary.md](results/summary.md), [results/fixed-ablation.json](results/fixed-ablation.json))

The ablation ran on `fixed`: E-17's procedure on E-16's engine, driven by [ablate_groups.py](ablate_groups.py). Two things differ from the engine's plain run, and the script says both:
- **Two paths are put back as groups.** On the sweep bounds alone, the ablation drops the whole snapshot path and the whole `expired` path: with one fault, a record stream from the start is always there. The verify bound `fo2` (a leader crash, then the new leader reloads) needs them back, several rules at once, which the engine's "put one rule back" step cannot do. So the script puts the two paths back, then makes the result 1-minimal on the sweep and verify bounds together.
- **Four rules are pinned** (never dropped or mutated): the world step `bopen.phase`, and three guards that are physics, not protocol: a server can send only records it holds (`rec.held`, `diff.held`, `open.held`). The model takes a sent record's value from the committed log, so without these pins the ablation lets a server send records it has lost.

**26 rules needed** of 62 written. The smallest model holds on every sweep bound and on the verify bounds (`fo2-state` 90,711 states, `fo2-log` 68,172, `mvrl-log` 871,859; each complete). The ablation took 1,793 runs and 5.6 CPU hours.

| Group | Rules needed | What they say, and what breaks without one |
|---|---|---|
| Who serves (6) | `snap.loaded`, `rec.loaded` | nobody answers from an unloaded fold (P3, 2 and 6 steps) |
| | `snap.cursor` | a snapshot only once the fold has reached the subscriber's cursor (P6: the cursor goes back, 10 steps) |
| | `rec.committed` | a record only up to the fold, so committed records only (alone on `fo-log`: P1 in 4 steps, a reader takes a record that a crash then loses) |
| | `snap.send`, `rec.send` | the snapshot and the record themselves (P5) |
| Answers (3) | `notready.send` | `retry`: go elsewhere, with the cursor (P5) |
| | `expire.lost`, `expire.send` | a replica that lacks the next record says so: `END`, or `expired` from the holding group's leader (P7, P5) |
| The subscriber (13) | `gotsnap.is`, `.clear`, `.rows`, `.cursor` | a snapshot replaces the whole view, then sets the cursor (P2; without `clear`, a ghost row in 14 steps) |
| | `gotrec.is`, `.apply`, `.cursor`, `.credit` | a record is applied once, moves the cursor one on, and frees the credit (P1, P2) |
| | `gotretry.leave`, `.credit`, `connect.link` | on `retry`: leave, and subscribe elsewhere with the cursor (P5) |
| | `gotexp.is`, `.dead` | `expired` ends the reader (P7, P5) |
| The move (1) | `bopen.fold` | B starts from A's rows at N (P5) |
| The writer (3) | `resolve.committed`, `.seen`, `.res` | a write resolves once it has committed and its writer's own subscription has passed its position (P4, 5 steps) |

**What drops out (36 rules), and what that means.** The count is of the smallest protocol that keeps every property; a path that drops out is not wrong, it is not needed for correctness.
- **Conflated diffs** (10 rules: `diff.*`, `gotdiff.*`): a snapshot does a diff's job, so no property needs the diff path. It is a speed path. While it is there its own rules are needed: dropped alone from the full design, `gotdiff.del` leaves a ghost row (P2, 14 steps), `diff.loaded` breaks P3 and `diff.behind` breaks P6.
- **The `open` step** (5 rules: `open.*`, `rec.on`): a record stream needs no opening step of its own; each record is already guarded (`rec.held`, `rec.loaded`, `rec.committed`).
- **`moved` and `END` as answers of their own** (8 rules), and the guards on `retry` (2): the subscriber does the same thing on `moved`, `retry` and `END` (leave, resubscribe with the cursor), so one of them is enough. Liveness here is "a path exists", so a server that may say `retry` at any time passes; a real server says it only when it is true. The count is one "go elsewhere" answer with one handler.
- **"A shard serves a slot only while it holds it open"** (the two left of the four `holds` guards): safety does not need it here, because a fenced A's fold stops at its fence, so A has nothing past N to send. The guard only stops a subscriber from waiting at A, which `retry` covers.
- **Sequencing that other rules cover** (8 rules), among them the relay's `loaded` flag: without it the relay never serves, and the client reaches a server instead.
- **`bopen.segs`** (the segment names): see section 3.

In the full design, with those paths in, **39 of the 62 rules are needed alone** (dropping any one of them breaks a property on a sweep bound).

**Mutants: 37 made from the smallest model; 31 caught, 5 equivalent, 1 survived; 31 of 32 non-equivalent (97%).** The mutant bar of DEV-03 is 85%.
- The 26 drops are caught (that is what "needed" means). Of 4 flips, 3 are caught. Of 7 swaps, 2 are caught (a snapshot's `clear` after its `rows`, or after its `cursor`) and 5 leave the reachable states unchanged.
- **The survivor** is the flip of `snap.cursor` (`>=` to `>`): a snapshot only when the fold is past the cursor, not at it. No property can tell: a snapshot at exactly the cursor changes nothing for a subscriber that has its rows, and a new subscriber (cursor 0, no rows) already holds the fold of nothing. It would matter only for a subscriber that kept its cursor and lost its rows, which this model does not have (a restarted relay starts again from cursor 0).

### 3. A move must leave the records below its fence reachable (model-checked here, [results/segs-check.txt](results/segs-check.txt))

The ablation drops `bopen.segs`, the update that gives B the names of A's segments below N. The reason is how P7 is written: an `expired` is false only if a live, loaded replica **that holds the slot** has the reader's next record. After a move only B holds the slot, so a B with no segment names says `expired` for every cursor below N, and P7 calls that true. P-07 does not: the records are inside retention, and A's replicas still have them.

[segs_check.py](segs_check.py) checks the stronger reading, P7s (any live, loaded replica, in either group), on the same model with no rule changed:

| Run | `mv-log` | `fo2-log` |
|---|---|---|
| `fixed`, as designed | holds (18,646 states) | holds (96,177 states) |
| `fixed` without `bopen.segs` | **P7s**, 8 steps | **P7s**, 8 steps |

The trace: record 1 commits; A fences s at 1; the client (cursor 0) subscribes at LB; B opens with A's rows at 1 and no segment names; B, the holding group's leader, lacks record 1 and says `expired`; LA is alive and holds record 1.

So the rule is needed, and the count is **27**. It is already in DESIGN-V5 4.2's carried state ("the names of the segments that hold s's records below N ... so ... B can serve `log` readers once A is gone"); the check shows it is not optional. While A still exists, the draft has B answer `moved(A)` and A serve the records below N (4.2: "a replay across a move reads A's segments for s, then B's"). The model does not have that two-server form. For it to work, 4.4's "A answers `moved(B)` once its fence commits" must mean "for positions at or past N": read without that, a `log` reader below N is sent from B to A and from A to B without end (reasoned, not modelled).

### 4. The bounds that do not finish (a partial check, [results/design-partial.txt](results/design-partial.txt))

Every feature at once (the move and the relay) with **two** faults of any kind does not finish in a 3,000,000-state run (about 5 minutes and 2 GB each; the engine keeps the whole graph for the liveness check, about 600 bytes a state):

| Bound | Result |
|---|---|
| `all-state` | 3,000,001 states, 231 s: no counterexample, stopped at the limit |
| `all-log` | 3,000,002 states, 318 s: no counterexample, stopped at the limit |

A run stopped at the limit says only that no property breaks in the states nearest the start (breadth first); it is a partial check. What the finished bounds cover between them: two faults with the move (`fo2`), and every feature at once with one fault of any kind (`mvrl`), in both modes. Two faults with the relay and the move together are not covered in full. (The file also holds `mvrl-state` stopped at 3,000,001 states; the full run of section 1 replaces it.)

## What the model leaves out

- **One slot, one subscriber, one write of its own.** A selection of many slots is many copies of this one, as long as each delta carries its slot's sequence (DESIGN-V5 4.4); a cursor over 1,024 slots is not modelled.
- **Unclean recovery and epochs.** A slot's epoch changes only on `fero recover --unclean`; the `unknown-log` and "a newer epoch means retry" rules are not exercised. slot_move.py and E-15 own recovery.
- **The move's own protocol** (fence, copy, `open`, the slot table): two atomic steps here; E-15 and E-17 check it. Reading below the fence is modelled in one form only (B serves through carried segment names); the two-server form (B says `moved(A)`, A serves below N) is not.
- **Retention.** There is no retention timer and no object store. A record is out of a reader's reach only when every replica that held it has crashed or reloaded past it (two faults); P7 checks that `expired` is said only then.
- **Credits above one record, conflation inside a relay's tombstones, frame splitting of big rows.** A relay's diff is computed from the committed log at the cursor; a real relay needs per-row change positions and tombstones kept since its last snapshot to do the same.
- **The pending-write minimum** ("waiting writes' positions go along as a minimum"): not modelled as a rule; resolution already waits for the cursor (`resolve.seen`).
- **Time and far links.** A far relay is the same relay with any delay; there are no clocks.
- **Liveness is "a path exists"** (AG EF), not a fairness proof: it does not show that a subscriber is never bounced without end, only that it never gets stuck.

## Against the threshold

The threshold: "All hold at the stated bounds within 1 h. Any counterexample is a rule change in DESIGN-V5 §4.4 before phase 1 fixes the cursor shape."

- **As drafted, one property breaks** (P7, a false `expired` from a reloaded follower). That is a counterexample, so it is a rule change in 4.4.
- **With that one change, all hold** on the ten bounds that finish, in about 15 minutes of CPU, inside the 1 h. The two largest bounds (every feature at once with two faults) do not finish; each shows no counterexample in its first 3 million states.
- **The rule changes for DESIGN-V5, before phase 1:**
  1. 4.4, "Who serves": a follower that falls behind the tail and reloads a snapshot ends its `log` subscriptions on that shard with **`END`** and the cursor. Only the leader of the group that holds the slot says `expired`.
  2. 4.4, to agree with 4.2: A's `moved(B)` is for positions at or past the fence; below it, A serves from its segments and ends at the fence (reasoned). And 4.2's carried segment names are a needed rule (the 27th), so they belong in the move's model (E-15) too.
  3. The cursor shape stands: a per-slot sequence. A cursor made of group offsets breaks at the first move.

## How to rerun

```sh
./run.sh          # everything: the designs, the big bound, the partial bounds, the ablation (5.6 CPU hours, in 25-minute holds), the report
./run.sh check    # every option on every bound, with traces, and the segment-names check (about 10 minutes)
./run.sh big      # mvrl-state in full (about 12 minutes, 6 GB), then the hashed safety search of the same bound (11 minutes)
./run.sh partial  # the bounds that stop at 3,000,000 states (about 13 minutes, 2 GB)
python3 ../E16-controller-loop/engine/cli.py models/subscribe.py draft --bound fo-log    # one run, with its trace
```

## Files

- [models/subscribe.py](models/subscribe.py): the model. [ablate_groups.py](ablate_groups.py): the ablation driver. [segs_check.py](segs_check.py): the targeted check of section 3. [safety_reach.py](safety_reach.py): a safety-only search that keeps a hash of each state. [run.sh](run.sh): every run above. [fetch.sh](fetch.sh): nothing to fetch.
- [results/](results): `design.txt` (every option on every bound, with traces), `design-mvrl-state.txt` (the 7.6 million-state bound, in full), `safety-reach.txt` (the same bound, safety only), `design-partial.txt` (the bounds stopped at 3,000,000 states), `segs-check.txt`, `fixed-ablation.json` (DEV-10; the ablation also leaves a `.cache` of every run it made beside it, which git ignores), `summary.md` (the rule table and the mutants).
- Machine: Ubuntu 24.04 in a Firecracker VM, 4 vCPU, 15 GB RAM; Python 3.13.17, standard library. Every run held `$SP/bin/heavy` (shared) while other agents' jobs ran, so the seconds are not timings.

Q-31: Yes, after one rule change. As drafted, a follower that reloaded a snapshot tells a `log` reader `expired` while the leader holds every record (model-checked, 7 steps, one fault). With "a replica that lacks the reader's next record answers `END`; only the holding group's leader says `expired`", every property holds on ten bounds, each explored in full (up to 7.6 million states, 15 minutes of CPU in all): a leader crash, a follower's reload, a dropped link, a slot move and a relay, in `state` and `log` modes, every feature at once with one fault, and the move with two; only every feature at once with two faults is partial (no counterexample in 3 million states each). Cursors must be per-slot sequences: group offsets break both modes at the first move (5 steps). The move's carried segment names are a needed rule (a false `expired` in 8 steps without them). DEV-10: 26 rules by ablation, 27 with the segment names; 31 of 32 non-equivalent mutants caught (97%). Moves: every row that serves subscriptions from followers (W `any`: DRAFT, MIN, RUST, SRV, CELL, LANE, SPLIT, SLOG, MIN-P, MIN-TS, RLOG, EMB-V8; LEAN and SIDE for logs) keeps P-03, P-05, P-07 and F-04 once DESIGN-V5 4.4 says `END` (a changed answer, no new mechanism); O `slot` rows (DRAFT, MIN and its variants, RUST, SRV, LEAN, SLOG, OBJ) up on P-03, P-07 and DEV-09 (the cursor shape stands, with no translation at a move); O `off` rows down on P-07 and DEV-09 wherever a partition's records go on in another group's log (CELL's re-key; LANE if a lane's range ever moves; SPLIT only through its lineage rule); SC-14's far reads unchanged (a relay with any delay keeps every property; lag is not modelled).
