# CHECKPOINT — the M2–M4 swamp guard (written re-plan before M4)

> Required by [plan-v3.md](../plan-v3.md) build order: "v2's middle year died here;
> before M4, a written re-plan against the de-scoping ladder. Overrun triggers the
> ladder, not schedule denial." This is that document. It is a decision record:
> supersede it, never delete it.

## Verdict

**No overrun. The ladder is NOT triggered. M4 proceeds at full scope, sliced.**

v2's swamp was M2→M4: membership, ownership, and durability landed as one
entangled year and never stabilized. v3 crossed M2 (membership) and M3 (the write
pipeline) as separate, individually-green, adversarially-reviewed milestones —
each with its own monitors, fault schedules, and mutation-killer pins, each
byte-preserving the epoch-0 sweeps beneath it. The swamp's precondition
(entanglement) was designed out; the checkpoint's job reduces to slicing M4 the
same way and keeping the ladder armed.

## Position audit

**Landed.** M0 (deterministic kernel, both shells from the same bytes), M1
(LWW + Lamport + per-origin logs + digest AE + heartbeat floor), M2 (committed
views by joint-consensus ballot, CP write-gate, epoch-staleness contract, boot
modes), M3 (view-derived ring, THE single write ingress, cid dedup with
replication-fed windows + attempt identity on records, typed NACKs, client relay
rule, single-writer + attempt-exactly-once monitors). Current gates: **121 tests,
14 perf gates, 16 dashboard scenarios, 1000×3 + 1000×5 epoch-0 sweeps (byte-
identical since M0: 237,451 / 540,398 events), 400 heartbeat-mode seeds across
3/5-node topologies** — all green. Three adversarial review rounds (21 + 23 + 22
findings) — every confirmed finding fixed with a pin.

**Line budgets (plan §4 table, design-review triggers).** Kernel sources today:
2,462 lines. Against budget: env 90/80, codec 594/550 (attempt extension +
depth caps — earned), link 107/350, ring 88/160, membership 417/400, write
445/350 (absorbed M2's buffer + the review's five hardening fixes — earned),
journal 92/150, node 629/300. node.ts is the one real excursion: it still hosts
streams, log storage, and the AE digest handler — exactly the code M4's
streams.ts/log.ts split extracts. With the remaining budgeted modules (streams
220, log 300, confirm 250, antientropy 200) the projected kernel is ~3,430 vs
the plan's ≈3,400 — on budget, PROVIDED the M4 split actually shrinks node.ts
back toward its 300 (tracked as an M4a exit criterion below).

**Plan deviations, recorded (all documented in code + README, none secret):**
1. **Dedup is an exact bounded window, not high-water + out-of-order set.**
   Per-owner cid streams have legitimate permanent gaps (cids interleave across
   partitions; ownership moves), so "≤ high-water ⇒ dup" would eat first
   deliveries. Window = last DEDUP_KEEP cids per issuer with original
   coordinates; lanes bounded by MAX_ISSUERS. Same O(1)/bounded properties the
   plan wanted; different shape.
2. **Attempt identity rides committed records (FLAG_ATTEMPT) — an addition.**
   The M3 review proved per-node windows cannot survive an ownership move (a
   retry re-committed and resurrected a stale value over a newer acknowledged
   write). Identity-on-records makes replication feed every node's window and
   doubles as an ACK. The plan's §5 dedup story is strictly strengthened; wire
   cost is per-run, not per-record.
3. **The AA#2 install window is closed structurally, not by NACK-in-anger.**
   FIFO links + install-flood + view-on-admit + the minority gate — four
   independent guards; a five-construction fault hunt could not schedule a stale
   forward on an honest network. Owner validation remains as defense-in-depth
   (unit-pinned). The plan's NACK machinery exists and is exercised; it just
   turns out to be the second line, not the first.

## Debt ledger → M4 (every carried debt has a slice that closes it)

| Debt | Source | Closed by |
|---|---|---|
| votedFor + committed view not durable (crash inside a ballot can double-vote) | M2 | M4b boot record |
| issuer cid counter volatile (interim: uuid~incarnation fresh lanes) | M3 | M4b boot record |
| retry can outrace original commit's replication to a new owner (window miss ⇒ same-value supersede) | M3 review | M4c confirm ladder (`confirm:'replicated'` implies the stream reached the R-set) |
| per-origin logs + versions map unbounded (tombstones included) | M0 | M4d compaction |
| suspicion keys off link liveness, not PONG timeouts (hung-but-connected process invisible) | M2 | M4b real-time/disk fault vocabulary (timer-skew + hung-process faults land with the store faults) |
| boot mode derives from constructor opts, not durable facts; no heldPartitions | M2 | M4b boot record {viewEpoch, lamport, incarnation, votedFor, heldPartitions} atomic with the WAL |
| zero-alloc claim structural, not counter-verified | M0 | M8 (unchanged — pinned-runner deliverable) |

## M4 re-plan — five slices, each landable green

The plan's M4 line ("confirm ladder, batched WAL + snapshot/truncate, disk-fault
schedules, full-cluster restore-from-WAL-only") is four subsystems. Landing them
as one commit is how v2 drowned. Slices, in dependency order — each keeps ALL
existing gates green and adds its own:

- **M4a — streams.ts + the three watermarks.** Extract the per-origin Stream into
  kernel/streams.ts as the plan's descriptor: {applied, shippable, durable} as
  FIELDS. applied feeds AE digests ONLY; shippable = logged; durable = storage
  batch resolved. New per-event monitor: applied ≥ shippable ≥ durable. Exit:
  node.ts sheds the stream/log plumbing toward its 300-line budget; all current
  gates green; epoch-0 sweeps still byte-identical.
- **M4b — the storage seam + boot record.** kernel-side Storage interface
  {load, appendBatch → Promise, snapshot+truncate}; sim store with the fault
  vocabulary (torn write, fsync lie, slow batch, crash-before/after-resolve);
  shell store = batched fsync WAL. Boot record {viewEpoch, lamportClock,
  incarnation, votedFor, heldPartitions} written atomically with the WAL; boot
  mode {fresh, solo, rejoining} derives from durable facts; restore replays
  through the SAME ingest (source=replay — the seam kernel/write.ts already
  names) with original provenance, before the network exists. Exit: the M2
  double-vote-after-restart debt is unrepresentable (pin: crash mid-ballot +
  restart cannot grant twice); AA#4 restart schedule re-runs from the real boot
  record instead of constructor opts.
- **M4c — confirm.ts, the guarantee ladder.** Probes: `replicated` answered from
  shippable across the R-set (R=∞ until M6), `persisted` from durable W-quorum —
  NEVER from applied (v2's recvReplProbe false positive stays unwritable by
  construction). View-change recount. Kernel machinery + journal vocabulary now;
  the `methods.update(…, {confirm})` surface is M5's. Exit: new monitor
  no-confirmed-write-lost-after-heal expected-empty across the AA schedules +
  disk faults; the M3 handoff residual demonstrably closed (the aa1 schedule
  extended with a confirm probe).
- **M4d — log.ts + compaction.** Encoded-bytes segments per partition (the bytes
  ARE the log entry, the WAL row, and the wire payload — codec is already the
  single format); snapshot-record-supersedes-prefix with the per-origin frontier
  vector, size-aware trigger; tombstone GC. Property tests: replay-from-0 ≡
  live; compacted catch-up ≡ uncompacted. Exit: logs + versions bounded; the M0
  "unbounded growth" README debt paragraph deleted.
- **M4e — the durability proof.** Full-cluster restore-from-WAL-only as a sim
  scenario + Tier-3 twin (real fsync, real restart); WAL total-loss recovery
  (the plan §6 Tier-3 list); a dashboard card. Exit: kill −9 a whole sim
  cluster mid-workload at any seed, restart from WALs, converge with zero
  confirmed-write loss — expected-empty under sweep.

Review cadence: one adversarial round after M4b (the boot/storage semantics are
the swamp's historical center) and one after M4e, not five rounds.

## The de-scoping ladder — armed, with explicit triggers

Unchanged from the plan, restated with trigger conditions so pulling a rung is a
mechanical act, not a judgment call under sunk-cost pressure:

1. **Defer scoped replication (ship R=∞ first)** — pull if M6 slips after M4+M5
   land, or if exactly-R invariants force redesign of shedding during M4c.
2. **Defer distributed aggregates** — pull if M6's owner-scoped folds/gather
   threaten the M5 API freeze.
3. **Defer eviction (manual admin op only)** — pull if membership churn bugs
   reopen during M4 (eviction already works; this rung exists only if the boot
   record destabilizes it).

**Overrun definition (what "triggers the ladder" means):** any M4 slice failing
to land green — all existing gates + its own exit criteria — within its own
attempt, twice. Not calendar time: attempt count. A slice that needs a third
redesign is the swamp announcing itself; the answer is a rung, not a grind.

## Named risks

- **Sim/shell storage divergence.** The classic: the sim store models semantics
  the real WAL doesn't have (or vice versa), and durability claims hold only in
  sim. Mitigation: ONE Storage interface both implement; the Tier-3 twin runs
  the same scenario shape as the sim proof; fault semantics (torn write = tail
  truncation, fsync lie = resolve-without-durability) documented on the seam.
- **WAL format churn.** Mitigation: the WAL row IS the codec's encoded record —
  no second format to version; the boot record is one control-frame-shaped blob.
- **Compaction correctness.** Mitigation: property tests land BEFORE the trigger
  heuristics (M4d exit criteria are the two equivalences, not the size policy).
- **node.ts split regressions.** M4a moves the hottest code (ingest/AE). The
  receive-path perf gate and byte-identical epoch-0 sweeps are the guard; the
  split is mechanical extraction, no behavior change permitted in the same
  commit.
