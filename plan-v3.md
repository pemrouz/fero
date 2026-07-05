# fero v3 — rewrite plan

A from-scratch rewrite of fero-v2, keeping its settled public API and its expensive
lessons, replacing its architecture. This document is the working spec — iterate here
before code. v2's [plan.md](plan.md), [DECISIONS.md](DECISIONS.md), and
[IDEAS.md](IDEAS.md) remain the record of how we got here; this plan is written so a
fresh session can build v3 without re-learning them.

**Provenance.** Produced from a full audit of fero-v2 (every subsystem + all four
ledgers read end-to-end), six dimension critiques (simplicity, robustness, testing,
performance, debuggability, API), three independently-designed candidate
architectures, and an adversarial three-lens judge panel. The winning architecture
("Keel": deterministic kernel + thin I/O shells) won the correctness and delivery
lenses; the grafts below fold in the best elements of the other two designs
("Streamline": minimal partition-stream kernel — won the maintainer lens;
"Chronicle": event-sourced journal-first kernel — best debug story).

---

## 1. Why rewrite — the verdict on v2

v2 validated the product thesis completely: one call, three reactive surfaces, zero
events, change-record-as-wire-format, return-type dispatch, the guarantee ladder.
None of that changes. What failed is structural, and each failure traces to a day-0
choice that cannot be retrofitted:

1. **The write pipeline is a side effect of a reactive proxy sink.** Seven ambient
   guard flags + two side-channel slots reconstruct control flow a function call
   would carry in its arguments; their validity depends on the sibling `data`
   library's undocumented cascade timing, which already shipped a cluster-wide
   silent lost-write (data `c870bde`, DECISIONS Z). The 1604-line `fero()` closure
   exists because replication state was never reified — decomposition (S) stopped
   exactly where closure capture begins.
2. **Protocol correctness is validated only by wall-clock TCP tests.** No injectable
   time or network anywhere; a permanently-red 246/249 baseline on the only machine
   that runs it; 29 bare sleeps in one test file; a ~1/8 flake that v2's own ledger
   suspects is a masked product bug; the open AA.3 conflict residual is exactly the
   narrow interleaving wall-clock tests can't reach. Retrofitting a virtual clock
   means rewriting the modules a v3 rewrites anyway.
3. **Every discovered bug was fixed by adding a named mechanism, not deleting a
   concept.** 214 glossary terms pre-1.0 (44 for replication alone); 110 milestone-code
   references in source; four independent point-guards defending one invariant, with
   the fourth (AA.3) admittedly unfixable in the current design; the same logical fact
   (per-stream high-water) tracked in four parallel string-keyed maps kept consistent
   by folklore — one consumer (`recvReplProbe`) still answers `confirm:'replicated'`
   off the wrong one, a documented guaranteed-false-positive.
4. **The macro perf layer is missing.** Zero backpressure (every `socket.write`
   return ignored, every buffer unbounded), a structural double-serialization tax
   (structuredClone ≈30-40% of the write budget, then JSON.stringify again), the
   receive path — which runs (N-1)× more than anything measured — has no perf test,
   and absolute-ms thresholds on a WSL2 box that swings 2-3× cannot detect
   regressions.
5. **Debug tooling is five uncoordinated bolt-on channels.** Per-write provenance is
   destroyed at commit ("the original writer's identity is preserved NOWHERE"), the
   most diagnostic events survive only in a 100ms relay buffer sampled at 1s (~10%
   coverage), there is no capture-replay or time-travel, and the production viewer is
   a promoted mockup with hand-authored incident fiction in its render functions.

**What v2 proved and v3 keeps verbatim:** the public API shape; the change record as
memory/log/wire format; lazy zero-copy decode with per-frame provenance amortization;
the microtask-coalesced outbox with a per-subscription delta lane; the two-array DHT
with allocation-free `holds()`; view-synchronous membership with joint-consensus
ballots; the (epoch, seq, origin) LWW order; the guarantee ladder with honest
rejects; the chaos-scenario vocabulary; the WAL-total-loss durability proof shape;
zero-cost-when-unwatched observability gating; and the measured rejections (hot-key
hash memo, lazy key0, median subtraction) so they are never re-litigated.

---

## 2. The one organizing idea

**The entire distributed core is a single-threaded deterministic kernel advanced only
by explicit events and emitting only explicit effects.** Real sockets, timers, and
files are thin adapters; the simulator is just another adapter that runs thousands of
seeded whole-cluster trajectories per second with invariant monitors evaluated after
every event.

This one inversion fixes the root diseases simultaneously:

- The write path becomes an explicit function (`ingest(attempt) → Outcome`) —
  the guard-flag family and side-channel slots are structurally unrepresentable.
- Every protocol behavior is a seeded, shrinkable, reproducible trajectory — the
  sleep-and-hope test class and the flake/product-bug ambiguity are deleted.
- The kernel's event stream IS the canonical diagnostics journal — capture, replay,
  and time-travel fall out instead of being bolted on.
- Performance becomes countable (frames per tick, allocations per record, bytes per
  record, messages per scenario) — deterministic on any machine, including WSL2.

## 3. Design principles (review-blocking rules, not values)

1. **Kernel purity is mechanical.** `kernel/` may not import net/fs/timers/
   `Date.now`/`Math.random` — enforced by an import-lint that fails CI, plus a
   determinism canary (same seed twice per CI job, byte-diff the traces) and a
   replay check (every sim run re-folds its capture and asserts per-event state
   hashes — catches unrecorded nondeterminism the day it lands).
2. **Concept budget: ≤25 named terms at 1.0** (v2: 214). A fix that introduces a new
   named mechanism instead of deleting one triggers a redesign review. Milestone
   codes never appear in source identifiers or comments (lint) — history lives in
   DECISIONS.md only.
3. **One projection path.** The dedup/LWW/fence-aware `applyRecord` is THE
   record→state function at every level: replication, restore, replay, subscriptions,
   and the debug viewer's time-travel. No verbatim-replay demonstrator, no parallel
   sync vocabulary. `fero/internals` exports the real layers ({kernel, codec, sim}).
4. **Every buffer bounded at birth** with a declared per-class overflow policy, and
   **every loss journal-visible**: any write the system decides not to deliver
   (buffered-drop, fence, out-of-window retry) emits a typed journal event with an
   expected-empty or budgeted filter. No silent loss modes.
5. **Failure is always a value.** Request/response frames carry ids; outcomes are
   typed discriminated unions; no caller-convention ACK semantics; no
   `console.warn` + plausible-looking wrong answer.
6. **Honesty in the format.** Every data-bearing debug field is tagged measured
   (sampled/folded/journaled) or absent; `normalize()` may derive, never synthesize;
   a promotion-gate test renders an empty-but-valid capture and fails on any string
   not traceable to a folded fact. Never document a guarantee ahead of
   implementation.
7. **Green-or-quarantined.** No ambient-red baseline, no flakes-as-backlog. A flake
   is reproduced under seed sweep and classified product-bug vs test-bug. Any real-
   socket (Tier 3) failure must be reproduced as a sim fault primitive before its
   fix merges — this keeps the sim's fault vocabulary honest over years.
8. **Perf is validated deterministically first** (counts), relatively second
   (interleaved same-process A/B ratios), absolutely last (pinned quiet CI runner
   only, medians persisted as tracked JSON). Never widen a threshold; the
   noisy-environment escape hatch procedure lives in the repo.

---

## 4. Architecture

Four layers, boundary enforced by import-lint (v2 proved unenforced layers are
violated within one milestone):

```
api/      fero(name, opts) → {data, methods, cluster, destroy}  — the settled surface
kernel/   THE deterministic core: codec, links, ring, membership,
          streams, log, write pipeline, anti-entropy, confirm, journal
shell/    production adapters: net (TCP), time, store (WAL), boot   — each <200 lines,
          zero protocol decisions
sim/      the simulation executive: event queue, virtual clock, seeded PRNG,
          fault schedules, invariant monitors, shrinker, scenario DSL
─── data (sibling) ─── $() ViewProxy, operators — bound strictly downstream of kernel
```

The kernel's top is `node.step(event)` where `Event` is a closed union (Dial,
BytesIn, TimerFired, WriteIssued, StorageResolved, AdminOp); outputs are pushed into
a caller-provided reusable `EffectSink` (zero steady-state allocation per event).
Replication state (clock, stream watermarks, version stamps, buffered writes, probe
tallies) is reified into explicit objects owned by kernel modules — confirm, shedding,
and retry live in real files, not closure capture.

### Module layout (line budgets are design-review triggers)

| Module | Responsibility | Budget |
|---|---|---|
| kernel/env.ts | Env/Event/Effect types + EffectSink | 80 |
| kernel/record.ts | ChangeRecord + Provenance {origin,seq,epoch} + Attempt {cid,attemptEpoch,issuer}; length-prefixed keys (no `\0` separators) | 120 |
| kernel/codec.ts | ONE bounds-checked Cursor (not 12 inlined varint loops), frame encode/decode + run-splitter, streaming per-peer Outbox encoder, binary value codec (typed-array-safe, NaN-preserving), frame checksum, FrameError, MAX_FRAME both directions | 550 |
| kernel/link.ts | per-peer state machine: socket → HELLO+version → identify(uuid, incarnation) → admitted; ONE logical link per pair; heartbeat (lower-uuid originator); bounded outbox with flowing/paused/spilled states; the three-class send contract | 350 |
| kernel/ring.ts | vnode hashring, two parallel sorted arrays, allocation-free holds(), injectable hash + test placement override | 160 |
| kernel/membership.ts | joint-consensus view ballots, write-gate, epoch-stale gate + release protocol, boot modes {fresh, solo, rejoining} from the durable boot record, eviction through the real propose path | 400 |
| kernel/streams.ts | per-(origin,partition) StreamDescriptor: {applied, shippable, durable} watermarks + version stamps as FIELDS (replacing seen/marks/persisted/versions) | 220 |
| kernel/log.ts | encoded-bytes segments per partition; snapshot-record-supersedes-prefix compaction (per-origin frontier vector, size-aware trigger) | 300 |
| kernel/write.ts | THE single write ingress: ingest(source: local\|forwarded\|inbound\|replay, attempt) → Outcome; per-issuer cid high-water dedup; owner validation; ONE bounded buffered queue; single stamp site | 350 |
| kernel/antientropy.ts | reciprocal digests, direction-independent triggers, periodic floor in ALL modes, streamed catch-up, compact-digest (range-hash) verb reserved day 0 | 200 |
| kernel/confirm.ts | guarantee ladder probes: replicated reads shippable, persisted reads durable — never applied; view-change recount | 250 |
| kernel/journal.ts | the canonical typed diagnostics event ring (flat scalars, bounded drop-oldest, surfaced drop counter, predicted-false emit gates) | 150 |
| kernel/node.ts | composes step(event); fail-closed dispatch | 300 |
| shell/net,time,store,boot | TCP+framer+drain backpressure; real timers; batched fsync WAL + snapshot/truncate; restore-then-connect | 520 |
| sim/exec,net,store,monitors,shrink,harness | executive + faults (incl. the lost-ACK primitive, torn write, fsync lie) + per-event monitors + shrinker + the cluster() scenario DSL with v2's vocabulary | 1220 |
| api/index,data,handle,cluster,methods,types | composer, assignment-as-sugar, tagged Handle, cluster-as-ViewProxy end-to-end, RPC/subs, exported types | 1180 |
| tools/model.ts + bridge + viewer + replay | ONE typed debug model (enums + folds; grammar VOCAB generated from kernel event union), journal-cursor SSE bridge, viewer, deterministic replay | 1750 |
| utils/ | bench.time, ratio.interleaved (promoted), counters, until, ports | 200 |

Kernel total ≈3,400 lines. Every file has a `.test.ts` sibling; hot-path files have a
`.perf.ts` sibling (counter-based primary, ratio-based secondary). The `readable/`
mirror convention carries over.

---

## 5. Core semantics — the contracts

Stated as what is guaranteed, to whom, when. These absorb every DECISIONS lesson;
deviations require a decision record.

**Write contract.** Every attempt carries from issue time: `cid` (issuer-uuid +
monotone counter), `attemptEpoch` (issuer's committed epoch at issue), `issuer`
(caller identity, distinct from sequencing origin). **The attemptEpoch law:
attemptEpoch may be re-stamped ONLY at the issuer/flush boundary, never at commit**
(sim-monitored + lint on the stamp-site module). One stamp site (`kernel/write.ts`,
source=local at the owner): stamps {origin: owner, seq: ++lamport, epoch: viewEpoch}.
The owner commits iff it owns the partition at its current committed epoch AND
attemptEpoch === its epoch AND its write-gate is open; otherwise a typed NACK
{reason: 'not-owner'|'stale-epoch'|'withheld', currentEpoch} and the issuer
re-resolves + re-forwards with refreshed attemptEpoch. Buffered writes keep their
ORIGINAL attemptEpoch and re-validate at flush — v2's open AA.3 residual is
unrepresentable. The epoch-dominance stamp (`max(viewEpoch, cur.epoch)`) is deleted;
the X knowing-overwrite case is preserved (post-view-install writes stamp at the new
higher epoch). **Dedup:** per-issuer cids are sequential, so the owner keeps a
per-issuer high-water + small out-of-order set — an O(1), complete duplicate test;
duplicate ACKs carry the ORIGINAL commit coordinates (exactly-once at the commit
site; lost-ACK retries safe for future non-idempotent ops).
`methods.update(change, {confirm, timeout})` — options are a separate argument, never
in-band payload keys — resolves/rejects the exported discriminated unions
`WriteResolve {guarantee, key, seq, epoch, origin, cid}` /
`WriteReject {guarantee, reached, reason, localCommit}`.

**Client writes.** A client never stamps provenance. Its attempts carry
{cid, issuer, attemptEpoch: 0 (client marker)}; the FIRST server to relay stamps
attemptEpoch at relay time and owns re-resolution on NACK; retries reuse the cid, so
owner-side dedup covers the relay path. (This closes the client-path gap the judge
panel flagged: the epoch-validation story now covers both server- and client-issued
writes.)

**Read-your-writes (decided, was v2's silence).** v3 deletes optimistic
apply-then-discard (it shipped v2's lost-write bug class) but replaces it with a
designed client-side **cid-keyed overlay**: pending writes layer over the client's
confirmed proxy state locally, never enter replication, and are dropped on
confirm-ACK (superseded by the real record) or NACK (journal event + surfaced
rejection). Default ON for client handles; the overlay is a pure view concern in
api/, structurally unable to leak into the kernel.

**Epoch-staleness contract.** A node observing ANY record with epoch > its committed
view epoch is view-stale: set epoch-stale, close the write-gate, request the missing
view (targeted VIEW pull + re-announce bound the window). **Gate release protocol
(new):** bounded retries of the targeted pull; if the implied view is unfetchable
(all holders dead), release the gate after re-announce confirms no higher committed
view among reachable members, and raise a journal alarm — a wedged gate is a named,
alarmed state, never silent. Frames carry a checksum so a flipped epoch byte is a
FrameError (drop the link), not a wedged gate.

**Conflict/convergence.** LWW total order is lexicographic (epoch, seq, origin),
identical everywhere; Lamport merges up on inbound, increments on local commit.
Version keys are field-granular. Guaranteed: per-cell convergence at quiescence.
Explicitly NOT guaranteed (documented, carried from v2 OQ9): cross-cell-hierarchy
materialization when whole-object and nested-leaf writes race. Writes at any depth
route uniformly by key[0] — no depth-1 cliff; hierarchy-aware LWW (child write bumps
ancestor cell) is a post-1.0 investigation, not silence. `conflict` remains in the
vocabulary as an expected-empty invariant alarm; a detected divergence freezes the
partition into an operator-visible 'diverged' state (surface + re-acquire from
majority) — loud and recoverable, never a silent fork.

**Ordering.** Each (origin, partition) stream: strictly increasing seqs, in order,
over exactly one identified link, from exactly one broadcaster (the owner
re-sequences forwards under its own provenance — the reverted-F lesson). This
in-order-single-broadcaster property is a stated protocol requirement — it is what
licenses scalar high-water dedup. No cross-origin or cross-partition ordering; no
API implies it. Cross-partition writes in one handler: no atomicity, documented, with
a userland recipe in the README (single-partition modeling guidance + an outbox
pattern example).

**Watermarks.** Each stream descriptor: applied ≥ shippable ≥ durable, asserted per
event in sim. Applied (dedup; advances past fence-skips) feeds AE digests ONLY.
Shippable (logged) is the sole evidence for `confirm:'replicated'` and shed
confirmation. Durable (storage batch resolved) is the sole evidence for
`confirm:'persisted'`. v2's `recvReplProbe` false positive becomes unwritable.

**Membership.** Joint-consensus ballots (majority of BOTH old and new sets; at most
one view commits per epoch). Ring is a pure function of (members, epoch), rebuilt
only on view commit. Write availability: majority-of-committed-view (CP; minority
buffers bounded drop-oldest with surfaced counter). Split-brain heal via periodic
re-announce + epoch high-water. Every node persists a boot record
{viewEpoch, lamportClock, incarnation, heldPartitions} atomically with the WAL; boot
mode {fresh, solo, rejoining} derives from durable facts; a rejoining node is
read-only until it joins a committed view ≥ its restored epoch. Incarnation fences
flappers and stops dead-origin debris. (Deletes v2's live V1d self-fencing divergence
bug and the 3000ms boot-gate sniff.)

**Durability.** `confirm:'persisted'` = W-quorum of the R-set has RESOLVED a storage
append covering (origin, seq); strength equals the plugged seam's (stated where
surfaced). Storage = {load, appendBatch → Promise, snapshot+truncate} — batched,
fd-held, fsync per batch, append-ordered. Restore replays through the SAME ingest
path (source=replay), original provenance, before the network exists.

**Backpressure — both directions (the judges flagged v2 reopened this on the inbox).**
Send plane: pause on `write()===false`, resume on drain; replication overflow spills
to the log (the log IS the retransmit buffer, healed by AE); subscription deltas
drop-and-resnapshot; control frames fail explicitly. Receive plane: a bounded apply
queue; when full, stop reading the socket and let TCP flow control push back — AE
heals any resulting gap. Stated policy, monitored in sim.

**Scoped replication.** Exactly-R holders is an invariant (both directions).
Shedding only after every current R-set member is confirmed caught up against
shippable, confirmations invalidated on any high-water bump. Holistic ops on scoped
nodes throw typed errors or require the explicit gather — never a warn + local
partial.

---

## 6. Testing strategy

Three tiers, hard green-or-quarantined policy.

**Tier 1 — pure unit + seeded fuzz.** Codec (v2's message.test.ts adversarial
posture verbatim, against ONE Cursor), ring, streams, log compaction property tests
(replay-from-0 ≡ live; compacted catch-up ≡ uncompacted), record encoding (keys with
'.', '\0', unicode).

**Tier 2 — deterministic simulation (the bulk).** Every protocol behavior as
`run(seed, scenario)`; monitors evaluated after EVERY event:
- single-writer-per-(partition, epoch) — expected-empty;
- **fold-equality: each node's state == the LWW/fence-aware fold of its log** — the
  cheapest total oracle any candidate design produced;
- watermark ordering; exactly-R holders; no-confirmed-write-lost-after-heal;
- convergence-at-quiescence; journal loss-accounting filters (expected-empty).

Fault schedules are first-class: the lost-ACK primitive (deliver WRITE, drop ACK),
asymmetric one-directional cuts, dup/reorder/delay distributions, torn write, fsync
lie, crash points, partitions installable between any two events. Key placement is
injectable (deletes the probe-64-keys pattern and the passed-by-luck class,
f80500f). Protocol modes are explicit config (eviction: on|off; boot: fresh|rejoin),
never magic durations. Negative assertions use the quiescence query — the entire
sleep-and-hope class is deleted. CI sweeps thousands of seeds per push; failures ship
{seed, shrunk trace, violated invariant} and the capture opens in the viewer
(**tests ARE debug artifacts**). v2's scenario library (P2 convergence, V1e gate, the
four AA conflict sources + the #3 residual + lost-ACK as named fault schedules,
split-brain heal, Q1–Q3 routing, full-cluster WAL recovery) ports as seeds — the
scenarios are the expensive knowledge; the harness they ran on is not.

**Tier 3 — thin real-socket smoke (~15 tests, serial, the only wall-clock tier).**
Real TCP through shell/net incl. mid-frame close, stalled-reader backpressure,
half-open sockets; real WAL total-loss recovery; confirm latency ladder asserted as
ORDERINGS; one multi-node sanity run. Any Tier-3 failure must be reproduced as a sim
fault primitive before its fix merges.

**The simulator itself is tested** (the panel's "untested trusted infrastructure"
gap): executive unit tests for fault-schedule correctness, fairness, and quiescence;
plus mutation tests — deliberately-broken protocol builds (e.g. v2's V1d bug
reintroduced) MUST fail their seeds, proving the monitors can see.

**Substrate gating.** `data` is pinned/vendored with a contract-test suite over the
sink-timing invariants fero depends on, run against data HEAD in CI (the c870bde
lost-write is the existence proof).

**CI exists before the first kernel module lands.** Sim tiers are deterministic and
run on standard GitHub runners; Tier 3 + the absolute perf tier run on one pinned
quiet runner (a small dedicated box or self-hosted runner — to be provisioned in M0;
this is a hard prerequisite, currently missing: the repo has no .github/). Dev-box
(WSL2) results are advisory only.

---

## 7. Performance strategy

**Regression detection, priority order:**
1. **Counted invariants** (deterministic anywhere, incl. WSL2): exactly one frame per
   peer per tick under a burst; zero heap allocations per steady-state inbound record
   (EffectSink push discipline + --expose-gc heap-delta verification); bytes/record;
   digest entry counts; **per-scenario message-count and op-count budgets in sim** —
   a protocol change that doubles messages fails a count on any machine.
2. **Interleaved same-process A/B ratios** — v2's pattern that survived WSL2,
   promoted to `utils/ratio` as THE hot-path guard. The kernel.step-vs-direct-call
   strawman ratio is a PERMANENT tracked perf sibling, not a one-shot M0 decision.
3. **Absolute ms ceilings only on the pinned runner**, medians persisted as tracked
   JSON so drift and recalibration are data-driven. Never-widen stays; the escape
   hatch procedure lives in the repo.

**External referent (the panel's "no absolute target" gap):** v3 must beat v2 on
interleaved same-box A/B for (a) the L2 write path and (b) the composed replica apply
path, and absolute records/sec + p99 targets are recorded on the pinned runner at M1
and tracked thereafter. "Durably faster" gets a number.

**Hot-path design (designed in):** encode-once — a record is serialized exactly once
at commit; those immutable bytes are the log entry, the WAL row, and the wire payload
(no structuredClone — requires the data contract below; no JSON on any hot loop — the
binary value codec is chosen day 0 because it becomes the storage format). Streaming
per-peer outbox encoder (preallocated buffer, back-patched header, one write per
flush). One link per pair halves N² overhead. Copy-on-retain at the decode boundary
(RecordViews valid only within dispatch; `.retain()` copies). Durability as a batched
pipeline stage. Compact-digest verb reserved in the protocol day 0.

**Coverage allocation inverted to execution frequency:** the receive/replica path
gets the FIRST perf sibling (M1), then socket throughput (records/sec, not just RTT),
then digest build at realistic origins×partitions, then storage batching. Exactly one
integration latency-ladder file; everything else fabricates input state.

**Hot-partition ceiling (the panel's product-risk gap):** the single-sequencer
throughput ceiling for one hot partition is measured at M3 and stated in the docs
with the mitigation (owner-side batching; partition-granularity guidance). Not
discovered by a user.

---

## 8. Debug tooling — built in, not bolted on

**The journal is the spine.** `kernel/journal.ts` defines the closed typed event
vocabulary BEFORE the layers are written: transport (dial/error WITH errno, handshake
phase, drop reason, backpressure transitions), membership (propose/promise/commit/
evict/epoch-stale/gate-release), write pipeline (issued/forwarded/buffered/committed/
fenced/conflict/shed — cid on every event), storage, confirm. Flat scalars in a
purpose-built bounded ring (NOT a ViewProxy — kills the reorder-by-t burden and the
~3x proxy-trap tax), drop counter surfaced. v2's five channels collapse to two seams:
the in-process Symbol-keyed `[diagnostics]` handle (kept exactly as v2 designed it)
and a dedicated authenticated DIAG wire verb reserved from the first protocol byte —
no `__`-prefixed magic names, no shadowing rules. Per-subscriber stream liveness is a
transport feature (sub-death notification).

**cid makes the write-route timeline a join, not a fiction:** issuer → forward →
owner sequencing → replica applies → confirm, rendered from real journal joins.

**Capture = journal segments + WAL segments + seed/config; replay is deterministic.**
One projection path + deterministic kernel ⇒ time-travel is "replay to t", divergence
forensics is "diff two replays at the same frontier". Sim traces and production
captures are the same format in the same tool.

**One typed model module** (`tools/model.ts`): every enum and pure fold, imported by
bridge AND viewer (the dashboard accepts a build step — v2's no-build constraint
caused the dual-language drift and its dual-fix bug). The filter grammar's VOCAB is
**generated from the kernel's typed event union** (append-only kinds with
deprecation), so grammar/viewer/wire structurally cannot drift. Captures are
version-stamped. Honesty is enforced by the format + the promotion-gate test.

**The viewer is an M0 deliverable** (graft from Chronicle): a minimal journal-trace
renderer lands with the first sim run, so debug tooling co-evolves with the protocol
instead of arriving at the end — and every sim failure is immediately a rendered
timeline.

---

## 9. The public API — settled shape, hardened edges

The v2 surface is unchanged: `fero(name)` / `fero(name, {method, …config})` →
`{data, methods, cluster, destroy}`; zero events; return-type dispatch;
await-fero-as-ready. The edges are fixed:

- **Typed end-to-end.** Exported `Fero<T>`, `WriteResolve`/`WriteReject`, `Guarantee`,
  `Cluster`, `Context`. Tests and perf consume the typed surface (no `const r: any`).
  Substrate `any` is wrapped at one seam, never propagated.
- **cluster is a ViewProxy end-to-end**: peers as rows; the committed view
  {epoch, members, writable} reactive (a writable flip is one change record); `me` a
  derived row (closes OQ5); `writes` the bounded confirm ring; `partitions` as a
  derived ownership projection (lands with scoped replication). `cluster.peers.send`
  is deleted from the spec.
- **Config recognition by value type, backed by a declared schema** constructed by
  PICKING known keys — typos rejected loudly at `fero()` time. One reserved nested
  **`seams`** config key holds function-valued config (hash, codec, storage,
  validation) so the recognition rule survives without forbidding functional seams.
  "Expect peers" is an explicit boot-mode option, not config-shape sniffing.
- **Tagged Handle class** ({mode: oneshot|live, open, close, failoverPolicy}) with a
  dispatch table replaces Proxy-identity probing. Failover on server death (v2's OQ2
  hole) is a per-handle policy: re-dispatch idempotent calls by cid, re-subscribe
  live handles to a surviving server. AsyncIterator mode stays decided-out (one more
  tag if ever needed).
- **Namespace split:** `data[key]` always means the partition; operators resolve only
  from a formally reserved exported name set; `data.get(key)` escape hatch always
  works. An expression means the same thing at R=2 and R=∞ (typed errors, never
  warn + wrong answer). Failed subscriptions deliver a typed error frame, never a
  silent empty stream.
- **Assignment and `methods.update` pass through the same user-overridable
  validation hook** (closes v2's OQ6 auth-on-assignment gap by construction, since
  both are sugar over the one ingest function).
- **Flush-on-return is BUILT, not documented-and-deferred:** a handler's `return`
  awaits pending assignment cids at the 'committed' guarantee (never the network
  tiers); an explicit `await context.flush()` barrier exists for mid-body use. v2's
  plan §6 "reply is post-commit" claim finally becomes true — or would have been
  struck (rule 6).

## 10. The `data` substrate contract — M0 go/no-go

v3 requires from the sibling `data` library: a public record-apply ingress (v2
reaches through a symbol at 5 sites), a **non-cloning sink mode** (the clone is
~30-40% of v2's write budget), subscription handles with synchronous detach and
strong retention, and a versioned re-entrancy/timing contract — pinned and
contract-tested against data HEAD in CI.

This is the single largest external dependency. It is settled during M0 as an
explicit go/no-go with a written decision: if the contract can't land upstream on
schedule, the fallback is a thin typed wrapper (accepting a measured perf floor,
stated in the decision record) — NOT an open-ended fork. A vendor-and-patch fork of a
co-evolving reactive substrate is a permanent second project and is rejected unless
the wrapper's measured cost is unacceptable.

## 11. Build order — centerpiece first, checkpointed middle

Each milestone independently demonstrable; the riskiest hypothesis dies in week one
or the plan is revised.

- **M0 — THE CENTERPIECE.** sim/exec + kernel/{env,record,codec,link} +
  shell/{net,time} + minimal ingest (2-node full broadcast). Demonstrable BOTH ways
  from the same kernel bytes: (a) `npm run sim -- --seeds 1000` — 1,000 seeded 2-node
  trajectories with drop/reorder faults + convergence monitor in ~10s, repro seed on
  violation; (b) the SAME kernel over real localhost TCP, $() on A replicating to $()
  on B. Also lands: import-lint, CI (sim sweep on push), utils/ratio + counters, the
  zero-alloc-per-event counter, the kernel.step strawman ratio, **per-event
  state-hash replay check**, the **minimal journal-trace viewer**, and the **data
  contract go/no-go decision**. Exit = all of the above executable, or the
  architecture is rethought at week-one cost.
- **M1 — replication core.** streams/log/AE + LWW/(epoch,seq,origin)/fence + the
  three watermarks. 10k-seed sweeps green under partition/heal, dup, asymmetric
  cuts, lost-ACK-on-catch-up; **fold-equality monitor on**; the receive-path perf
  sibling lands HERE (pulled forward — it's the hottest path); zero-alloc and
  one-frame-per-tick counts pinned; absolute baseline recorded on the pinned runner.
- **M2 — membership.** Ballots, write-gate, epoch-stale gate + release protocol,
  boot record, eviction through the REAL propose path under simulated partition.
  v2's V1d divergence bug reproduced as a seed against a deliberately-broken build
  (sim mutation test), then green.
- **M3 — the write pipeline.** cid high-water dedup, attemptEpoch validation, the
  ONE buffered queue, NACKs, client relay rule. The single-writer monitor
  expected-empty across sweeps INCLUDING v2's four AA conflict sources + the open #3
  residual + lost-ACK, each as a named fault schedule. Hot-partition ceiling
  measured and documented.
- **CHECKPOINT (the M2–M4 swamp guard).** v2's middle year died here; before M4, a
  written re-plan against the de-scoping ladder: (1) defer scoped replication
  (ship R=∞ first), (2) defer distributed aggregates, (3) defer eviction (manual
  admin op only). Overrun triggers the ladder, not schedule denial.
- **M4 — guarantees + durability.** confirm ladder, batched WAL + snapshot/truncate,
  disk-fault schedules, full-cluster restore-from-WAL-only (sim + Tier-3 twin).
- **M5 — public API.** Composer, assignment sugar, tagged Handles + failover
  policies, cluster reactive end-to-end, typed config + `seams`, exported unions,
  flush-on-return, the client cid-overlay (read-your-writes). v2's scenario library
  ported against the PUBLIC surface; two-terminal real-socket demo.
- **M6 — scoped replication + aggregates.** R-sets, keep-until-confirmed shedding,
  owner-scoped folds, gather, typed holistic errors, cluster.partitions. The v2 Q3a
  flake hunted deliberately under seed sweep (suspected real bug).
- **M7 — debug tooling, full.** DIAG verb + auth allowlist, model.ts + bridge +
  full viewer + replay/time-travel; capture a seeded chaos failure, open the shrunk
  trace, time-travel to the violating event; live-dash a real 5-node cluster with
  the cid write-route timeline; honesty promotion-gate green on an empty capture.
- **M8 — hardening.** Pinned absolute suite with persisted baselines; allocation
  verification of every "allocation-free" claim; throughput test; green-or-
  quarantined repo-wide; DECISIONS/IDEAS seeded with v3 records + carried v2
  rejections; README with the cross-partition recipe and the availability posture.

## 12. Decided out (written, not silent)

- **L3 planner** (distributed operator graph): out of v3.0 scope entirely.
- **fero.all, UDP multicast discovery, cluster.peers.send:** deleted from the spec
  (static discovery + broker is the shipped rendezvous; multicast returns only with
  a demand signal).
- **Peer-to-peer auth** (who may join a view / forward writes): out of scope for
  v3.0, said out loud; the handshake reserves bytes for it; the DIAG channel ships
  with its allowlist.
- **v2 migration/compat:** none. No wire, WAL, or cluster interop; v3 is a greenfield
  deploy; v2 artifacts are abandoned (pre-1.0, no external deployments).
- **CRDT / OR-set merge model:** LWW stays (v2 OQ9 outcome); hierarchy-aware LWW is
  a post-1.0 investigation.

## 13. Honest residual risks

1. **Sim fidelity gap** — bugs in the four shells or in the sim's TCP/fs assumptions
   are invisible to Tier 2. Mitigated by <200-line shells, the targeted Tier-3 smoke
   set, and the sim-fault-before-fix rule. Residual: real.
2. **True-parallelism classes** (GC pauses mid-protocol, event-loop starvation —
   v2's bridge at n=50, multi-process contention) are permanently outside the fault
   model. Mitigation: nightly real-socket soak with journal-attached monitors AND
   production journal-based stall detectors (watchdog events), so detection exists
   outside tests. Residual: named, accepted.
3. **The data contract may not land** — the M0 go/no-go with a measured-cost wrapper
   fallback bounds this; the perf floor without it is ~30-40% on the write path.
4. **Kernel purity erosion** — mechanical enforcement (lint + canary + replay-hash)
   catches what manifests; review treats violations as correctness bugs.
5. **Epoch-stale gate availability** — new semantics; the window is measured across
   seeds (its distribution is a tracked sim metric) and the release protocol bounds
   the worst case; the per-event single-writer monitor is the backstop for any
   unenumerated X-case corner.
6. **M0 is the biggest sequencing bet** — six modules before the first demo.
   Bounded by its deliberately minimal scope (no membership, no LWW) and executable
   exit criteria; if M0 exceeds two weeks, the fallback (direct method calls on
   injected interfaces — still deterministic, less uniform) is adopted by
   measurement.
7. **A permanent style tax** — events-in/effects-out on every contributor. Accepted:
   this repo optimizes for correctness-per-maintainer-hour over drive-by
   contributions.

## 14. Open questions for the build (small, by design)

1. Value codec final form: the CBOR-class binary codec is decided; whether to adopt
   an existing minimal encoder or write the ~200-line subset is an M0 measurement.
2. Hash: djb2+fmix32 carries over; the wy/xxhash32 bake-off is an M1 perf ticket via
   the `seams.hash` injection point.
3. Pinned-runner provisioning: which box, who owns it — must close during M0.
4. Overlay UX detail: whether the client overlay marks pending rows visibly
   (e.g. via a derived `cluster.writes` join) — decide at M5 with the viewer in hand.
