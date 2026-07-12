# fero v3 — M0…M4 (kernel, replication, membership, writes, durability) + the fero() public api (M5a+b: composer, cid-overlay, clients) + the debug tool

The from-scratch rewrite of fero-v2, built to [plan-v3.md](../plan-v3.md). This folder
holds **M0** (the deterministic kernel + thin I/O shells + simulation executive,
proven **both ways from the same kernel bytes**), the **M1 replication slice**
(per-cell LWW + Lamport clock + per-origin logs + digest anti-entropy, so tail loss
from partitions, dial races, and backpressure overflow all HEAL), **M2 membership**
(committed views by joint-consensus ballot + the CP write-gate), the **M3 write
pipeline** (ring ownership over the committed view, forwarded attempts with cid
dedup + typed NACKs — the single-writer invariant v2 spent DECISIONS AA chasing,
now a per-event monitor), **M4 durability** (the watermark ladder, the WAL + boot
record + snapshot/truncate behind an effect seam, the confirm guarantee ladder,
compaction, and the restore-from-WAL-only proof: kill −9 a whole cluster at any
seed and zero persisted-confirmed writes are lost), and the **debug tool** (capture → typed model → viewer
with time-travel replay, plus a live mode) — each piece pulled forward exactly when
a seed sweep or review demanded it, which is the architecture working as designed.

## Run it

```sh
npm test                       # 193 tests: Tier-1 unit/fuzz, Tier-2 sim sweeps + AA/disk fault schedules, Tier-3 real-TCP + real-WAL smoke, debug-model + scenario suites
npm run perf                   # 17 perf gates: counted invariants first, ratios second, absolutes last
npm run sim -- --seeds 1000    # 1000 seeded chaos trajectories (dup faults + partition/heal + writes racing formation)
npm run scenarios              # run the scenario registry, print the table, pin/refresh results/ (--rebase re-pins the baseline)
npm run debug                  # scenario DASHBOARD at /, the debugger at /debug (http://localhost:4699)
npm run sim -- --seeds 5 --capture 3   # force-write a healthy capture to explore in the debugger
npm run debug -- captures/seed-3.json  # open a capture in the debugger
npm run debug -- --live        # spin a REAL 3-node TCP cluster + owner-routed traffic and debug it live
npm run debug -- --live --contend      # ...with a deliberately conflicting workload (LWW elections on demand)
```

Measured on this box (WSL2): `1000/1000 seeds green · 237,451 events in ~4.5s
(~53,000 events/s)`. Every seed is a full cluster lifecycle — dial-race formation
under per-pair delay/duplication faults, a mixed-type write workload issued
DURING formation (deliberately racing the dial-race window), convergence + drain +
per-event invariant monitors. A failing seed prints itself; re-running that seed
reproduces the trajectory bit-for-bit.

## The debug tool

One journal, one model, replay for free (plan §8) — every piece exists because the
kernel is deterministic and the journal vocabulary predates the code that emits
into it:

- **Capture** ([tools/debug/capture.ts](tools/debug/capture.ts)): per-node journals +
  per-origin record logs + end state + watermarks + link tables, values made
  JSON-safe (NaN/±Infinity/-0/undefined/bytes survive). The event vocabulary rides
  INSIDE the capture (generated from the kernel's `JK` const), so a capture is
  self-describing and viewer filters structurally cannot drift from the wire.
  Sim failures write captures automatically — **tests ARE debug artifacts**: a
  failing seed's report opens in the viewer as a rendered timeline.
- **Model** ([tools/debug/model.mjs](tools/debug/model.mjs)): plain-JS ESM imported
  by Node tests AND served raw to the browser — ONE file, so v2's dual-language
  fold drift (a real bug fixed twice) is impossible. Folds: the **write-route
  join** (origin → applied / lww-lost / duplicate / never-arrived, per node — v2's
  flagship feature that its wire format made impossible), **contested cells**
  (every LWW election with candidates and the fold-consistent winner),
  **stateAt(t)** (true time travel: replay journal+logs through the same LWW rules
  the kernel runs), and **verifyReplay** — the replay-refold check: the model's
  fold must reproduce every node's captured end state exactly, proving both
  capture completeness and model/kernel agreement on every capture opened.
- **Debugger** ([tools/debug/viewer.html](tools/debug/viewer.html)): the v2
  explorer idiom (outline tree + inspector + ONE omni filter), rebuilt on v3
  captures. LEFT: a filterable tree — Nodes (→ links, streams), Writes (every
  (origin, seq) with its cluster-wide outcome), Cells (values + provenance +
  divergence), Violations. TOP: one omni box whose facet grammar
  (`is:crit`, `node:n01`, `write:lww-lost`, `kind:aeShip`, …) prunes the whole
  tree at once, auto-expanding to matches — `kind:` values are generated from the
  capture's embedded vocabulary. RIGHT: the inspector — a node's journal
  (human-readable, newest first), a write's change record + per-node route
  timeline, a cell's LWW election with won/lost candidates. Bottom bar:
  breadcrumb + health rollup (converged / replay-verified / violations) + the
  time-travel scrubber (state at any event index, replayed through the model's
  LWW fold). Keyboard: j/k/h/l, `/` to filter, Esc. Honesty by construction:
  renders only folded facts, absence renders as absence, journal truncation
  disables time-travel loudly instead of reconstructing fiction.
- **Scenario dashboard** ([tools/debug/scenarios.ts](tools/debug/scenarios.ts) +
  [scenarios.html](tools/debug/scenarios.html), served at `/`): every high-level
  behaviour as a named, diagrammed, measured card — happy paths (formation,
  owner-routed replication), fault paths (conflict, writes-racing-formation,
  dup/delay chaos, partition+heal, cut-mid-dial, backpressure) and meta rows
  (pinned wire invariants, a 100-seed sweep). Each card: a topology diagram
  (mesh, faults ≋, cuts ✂, writers), pass/fail, counted metrics with DELTAS vs
  the committed baseline (counts exact-compare — drift is always signal; wall-ms
  soft-compared, this box swings 2-3x), and a click-through that opens THAT run
  in the debugger (`/debug?scenario=<id>`). The registry is the data source; the
  page is a projection; baselines are pinned only by the CLI (`npm run
  scenarios`), never by rendering.
- **Contention is elections, not history:** `contested()` derives from the
  kernel's `lwwSkip` journal events — cells where an election actually REJECTED
  a candidate — so a single writer updating its own key reads as history, never
  as conflict (the fold originally counted any multi-candidate cell and painted
  a false contention wall). A genuinely concurrent race always produces at least
  one `lwwSkip` (at minimum where the winner's origin receives the loser), so
  nothing real is missed.
- **Live mode** ([tools/debug/serve.ts](tools/debug/serve.ts)): the pull-spine made
  minimal — `/capture.json` rebuilds a truthful snapshot from a running in-process
  cluster ON REQUEST (no relay buffer with its own cadence to lie about, v2's
  10%-temporal-coverage bug class). The viewer polls; sim captures and live
  clusters are the same format in the same tool. Live traffic lands on
  workload-picked nodes and — once the genesis ballot commits (~2s in) — the
  KERNEL owner-routes every write to its ring owner, so the steady state shows
  zero contention by construction. `--contend` posts random-origin writes to a
  shared key set: it demos real LWW elections in the pre-genesis open window,
  after which the pipeline serializes even a deliberately conflicting workload
  through one sequencer — which is the M3 story on one screen.

## Adversarially reviewed

Each milestone gets an adversarial multi-agent review after its suite goes green
(N lenses → dedup → two independent refuters per finding, confirmation requiring
survival). The pattern has paid for itself every time.

**M0/M1:** 21 findings, all fixed — a **dial-race write-loss window** (a write
flushed only on the link that then lost the one-link-per-pair dedup died with it;
fixed by replay-on-admit: the own-write log is the retransmit buffer), an
**uncaught lazy-decode FrameError** (one crc-valid hostile frame could crash the
node), **crc coverage extended over the header** (a verb flip re-dispatched
RECORDS as PING silently), a `__proto__` decode corruption, a sim zombie-link
race, shell socket/listener leaks, a bypassable purity lint, a tautological
monitor.

**M2:** the headline was a genuine critical — the propose path could double-vote,
committing **two views for one epoch** under an honest schedule (1,514 monitor
violations in the review's own repro); fixed by ballot identity
`(epoch, proposer, members-hash)` enforced at grant AND propose sites, now 0
violations. Widening the sweep to 5 nodes also surfaced a latent M1 self-echo
log-poisoning bug (seed 79), fixed with the never-ingest-own-origin invariant + a
log-monotone monitor.

**M3:** a 6-lens / 50-agent review returned 11 confirmed (2 critical), all fixed:
- **Cross-owner exactly-once (critical).** The cid-dedup window was per-node, so a
  retry after an ownership move hit a new owner with no memory of the cid and
  re-committed — resurrecting a stale value OVER a newer acknowledged write (a
  silent lost update the per-epoch single-writer monitor couldn't see). Fixed by
  making committed forwarded runs **broadcast their attempt identity**
  (FLAG_ATTEMPT: issuer + contiguous cids); replication feeds every node's dedup
  window and doubles as an ACK (a replicated record carrying our issuer clears the
  pending attempt — a lost WACK self-heals via the data path). A new
  **attempt-exactly-once** per-event monitor watches the whole class directly, at
  the re-committing event.
- **Unbounded decode recursion (critical).** A deeply-nested hostile value threw a
  RangeError — not a FrameError — escaping the frame net and crashing the node.
  Fixed with a symmetric MAX_DEPTH cap on encode, decode, and skip.
- **NACK storm (major).** A same-epoch `withheld` NACK re-forwarded instantly via
  settle→flush, spinning at line rate against a minority owner. Same-epoch NACKs
  now re-park onto the RETRY_TICKS clock; only a NACK revealing a newer view (fresh
  routing state) re-drives immediately.
- **Spoofable ACK/NACK (major).** Any admitted link could clear or re-drive another
  node's route with a well-formed control frame. ACK/NACK are now bound to the
  **owner of record** (the forward target).
- Plus: relay ACKs re-batched (one WACK in → one WACK out, not n frames + n allocs),
  a view-learned member whose dial chain gave up is now revived (was parked forever,
  stranding attempts owner-routed to it), dedup lanes bounded by MAX_ISSUERS, the
  drain no-ops when nothing is parked (a `#queued` counter), per-event monitor
  cursors keyed to the node object (a sim restart rescans instead of blinding the
  monitor), and encodeControl/encodeRuns reuse module scratch instead of a fresh 4KB
  Writer per control frame. Seven more findings were refuted on inspection; four
  "contested" perf/observability notes were addressed anyway. The test count went
  110 → 121; every fix has a mutation-killer pin.

**M4:** a 6-lens review over the whole durability arc returned 20 findings;
triaged inline, 13 confirmed and fixed, every fix pinned (158 → 166 tests):
- **Durable froze in name only (critical, four independent finders).** A batch
  in flight behind a persistFail still advanced the durable watermark on its
  late echo — false `confirm:'persisted'` evidence for rows past a real on-disk
  hole, with zero lying disks. persistFail now voids `#inflight` entirely; the
  shell's io-queue latches `#walFailed` so an honest EIO can never leave an
  interior hole for the hole-means-lie verdict to misread.
- **The boot record had no fsync — file or directory (critical).** The one
  record everything fences on (votedFor, the Lamport ceiling, the incarnation)
  could regress across a power crash: a double-vote and cross-life seq reuse in
  one bug. Now write-tmp + fsync + rename + directory-fsync; the WAL swap
  rename gets the same directory fsync (every swap was a correlated rename-lie
  without it), and its fd handoff is failure-ordered (no dangling-fd window).
- **The burned-epoch wedge (critical, repro'd).** A proposer that collected
  durable votes and vanished froze membership FOREVER — every proposal targeted
  view.epoch+1, which the vote-once rule made unwinnable (M4b's durable
  votedFor made the burn survive restarts). Proposals now ESCALATE past known
  burns (own spent vote + the `ve` a refusal carries) and voters grant any
  epoch above their committed view — one-view-per-epoch still rests on
  vote-once-per-epoch, sweep-verified.
- **condemn() kept the condemned dedup window (critical)** — a post-condemn
  retry was dup-ACKed with the stamp of a record existing nowhere (silent
  acknowledged loss). The window resets with the fold; retries degrade to
  at-least-once until replication re-feeds it.
- **Stale evidence across a peer's crash (major).** Confirm marks are monotone
  — right within one life, a lie across lives. A HELLO with a higher
  incarnation now FORGETS every mark that peer announced (probes wait for fresh
  digests; the frontier pins until the reborn re-announces).
- **Tombstone GC's seq-only straggler bound (major).** LWW is epoch-first: an
  in-flight lower-epoch/higher-seq record escaped any seq comparison. GC now
  releases only at FULL quiescence (every member at every lane's known tail, on
  crash-stable marks, digest-only lanes included).
- **Mixed durable/non-durable frontier (major).** Crash-stability is a property
  of the MARK'S OWNER: a peer that ever announced a p map reads at markD
  everywhere; a never-announced-p peer's crash is a total refold, so its
  volatile mark is sound.
- Plus: a clean `destroy()` now flushes queued WAL appends (committed writes
  were silently dropped on shutdown); shell `restore()` distinguishes interior
  corruption (a crc-valid row beyond the failure → the condemn verdict fires)
  from an honest tail tear; `snapshot()` builds every row before mutating any
  state and caps rows at 1024 records; monitor cursors key on the log ARRAY's
  identity (a same-tick append+compact was invisible to a length check); replay
  emits per-record journal events so the debugger's time-travel fold survives a
  restore. Honest residuals, stated where they live (kernel/log.ts): a fresh
  fold racing two teachers can resurrect a GC'd-removed cell (M6 state-transfer
  closes it); dead provenance lanes are immortal in streams/digests (bounded by
  restart count — M6 digest work); durable mode without heartbeats has no
  compaction clock, so log AND WAL bounds require membership.

## Layout

```
kernel/   the deterministic core — no I/O, no ambient time/randomness (purity.test.ts enforces it)
  env.ts        Event/EffectSink/Env — the ONLY doorway to the world
  codec.ts      checksummed binary frames; ONE bounds-checked Cursor; streaming Outbox; lazy RecordViews
  link.ts       identity-before-admission; one logical link per pair; bounded backpressure queue
  node.ts       step(event) → effects; Lamport clock + lease; per-cell LWW; the ONE stamp site (commit); WAL batches + boot record (M4b)
  membership.ts committed views, joint-consensus ballots, the CP write-gate, epoch-stale + boot modes (M2)
  ring.ts       vnode hashring — allocation-free ownerOf(), a pure function of the committed view (M3)
  write.ts      THE single write ingress: local/forwarded/inbound/replay sources, cid dedup, typed NACKs, the ONE pending queue (M3/M4b)
  streams.ts    per-origin StreamDescriptor — the watermark ladder {applied, shippable, durable} as fields (M4a)
  confirm.ts    the guarantee ladder: replicated/persisted probes over watermark evidence, view-change recount (M4c)
  log.ts        compaction: snapshot-record-supersedes-prefix below the crash-stable frontier; tombstone GC (M4d)
  journal.ts    the one typed diagnostics ring (drop-oldest, surfaced drop counter)
shell/    production adapters (TCP + timers + the fsync WAL/boot-record store), zero protocol decisions
api/      the public surface (M5a): fero(name, opts) → {data, methods, cluster, destroy}
  substrate.ts  the ONE seam onto the `data` sibling ($() proxies): record-apply ingress, clone-free capture, sync detach
  data.ts       the binding: capture→ingest, apply→proxy, echo match-and-consume, the cid-keyed overlay (read-your-writes)
  index.ts      the composer: declared config schema (typos throw), seams.validation, default write methods over the confirm ladder
  types.ts      the exported unions: Guarantee, WriteResolve/WriteReject, FeroConfig, Fero
sim/      the executive: virtual time, seeded faults (FIFO-clamped), per-event monitors, sweep CLI
tests/    Tier-3 real-socket smoke (the only wall-clock tier)
utils/    ports/bench/ratio.interleaved — v2's #utils conventions
```

## How this is better than v2 — measured, per dimension

**Testing.** v2 validated ALL protocol behaviour over real sockets + real timers:
a permanently-red 246/249 baseline on the only machine that ran it, 29 bare
`sleep()`s in one test file, a ~1/8 flake ticketed as possibly-a-real-bug, one
frozen soak seed, minutes of serial wall-clock. v3 M0: **30/30 green in ~5s**, the
protocol tier explores **1,300 distinct seeded trajectories per full run** (300 in
`npm test`, 1000 in the CLI), negative assertions are exact quiescence queries, and
the determinism canary (same seed → byte-identical state-hash trace) turns "flaky"
from a verdict into a class of bug that cannot ship. The Tier-3 real-socket tier is
3 tests, because that's all the shell needs.

**Robustness.** The write path is a function (`step({kind:'write'})` → ingest →
LWW → effects): v2's seven re-entrancy guard flags and two side-channel slots — one
of which shipped a cluster-wide silent lost-write — are structurally impossible, not
carefully avoided. Frames carry a crc32c over header AND body (v2 had zero
integrity protection — a flipped epoch byte was silently believed). Identity
precedes admission and is enforced (records before HELLO close the link); the dial
race collapses deterministically to one link per pair with no coordination frame
(v2 needed shadows, a WeakSet, idempotent-identify guards, and still couldn't
retrofit socket dedup). Loss HEALS: per-origin logs are the retransmit buffer,
digests exchange on every admit and after backpressure sheds, and live records
flow only on synced links so a suffix can never be leapfrogged into fake
duplicates. Every buffer is bounded at birth with journal-visible overflow. The
sweeps earned their keep repeatedly DURING the build: they caught the
Lamport-vs-contiguity collision, a non-FIFO sim-link modelling error, and — at
236/1000 seeds red — the live-write-leapfrogs-the-suffix ordering hole in the
first AE draft, each within seconds of being written. v2 found bugs of this class
one flaky wall-clock test at a time, months apart.

**Simplicity.** The M0 kernel is ~1,100 lines across 6 files, each owning one
domain; replication state is explicit fields on one class (v2: a 1604-line closure
with ~20 shared mutable variables that decomposition couldn't crack). One
bounds-checked Cursor replaces ~12 hand-inlined varint loops (two of which shipped
silent-truncation bugs in v2). One journal replaces five uncoordinated diagnostic
channels. Concept count so far: record, stream watermark, LWW cell, link, journal —
five, against a budget of 25 (v2's glossary: 214).

**Performance.** Perf gates are deterministic-first: bytes-per-record pinned
EXACTLY (73B canonical — a wire regression fails on any machine identically),
frames-per-burst counted exactly (one per peer per synchronous batch), lazy-scan <
full-decode asserted as an interleaved same-process ratio (the only pattern that
survived v2's WSL2 2-3x noise), and the kernel-vs-strawman step tax is a tracked
ratio (currently within 6x of the irreducible work, with the state-hash mirror —
the sim's oracle — as the known dominant term). Backpressure exists from commit
one: `write()===false` → pause → bounded queue → drain (v2 ignored every
socket.write return and buffered unboundedly). Encode-once: the streaming Outbox
back-patches one preallocated buffer — no per-frame Writer, no double sizing pass.

**Debug tooling.** The journal vocabulary existed BEFORE the layers that emit into
it (v2 bolted five channels on afterwards). Every drop, dedup, LWW loss, backpressure
transition, redial, and give-up is a typed, cursor-readable event with a surfaced
overflow counter. The sim's failure report IS a debug artifact: seed + violating
monitor + event index. Capture/replay/time-travel (M7) get their substrate for free
because state is a deterministic fold of the journal'd inputs.

## What this deliberately does not have yet (stated, not implied)

- **Anti-entropy: event-driven triggers + the periodic floor.** Digests fire on
  admit and drain-after-overflow (every TCP-real loss mode), AND ride every
  heartbeat as the plan's §5 periodic floor — one reciprocal digest per tick from
  the PING side heals loss that NO event announces (transport bugs, future
  non-TCP shells; the sim test injects exactly that). Heartbeats also REVIVE
  given-up dial targets (`JK.revive`), so give-up is a cool-down, never
  permanent parking. Both are heartbeat-gated: `heartbeatMs: 0` (the sim sweep
  mode) keeps trajectories quiescent and byte-identical. There is deliberately
  NO per-frame drop fault in the sim: TCP cannot drop mid-stream on a live link,
  and modelling it would demand interior-gap healing no real shell needs.
- **M2 membership is LIVE** (kernel/membership.ts): committed views with
  joint-consensus ballots (majority of BOTH old and new sets; at most one view
  per epoch — a per-event sim monitor, not a hope). Ballot identity survived its
  own adversarial review: a vote is (epoch, proposer, members-hash), enforced at
  the grant site AND the propose site (the review's critical: proposing once
  self-voted a vote already granted elsewhere — two views committed for one
  epoch under an honest schedule; the review's own deterministic repro now runs
  0 violations), re-grants to the same proposer are idempotent (a lost VOTE
  frame heals on re-offer instead of burning the epoch), aged-out proposals
  release the epoch, and every proposal path runs single-proposer discipline
  (lowest live member; JOINs relay one hop). Suspicion → eviction through the
  real propose path (held while a dial chain is still trying — give-up ends the
  hold; BOTH sides run chains now, so acceptor-side blips hold too), the CP
  write-gate (minority buffers into ONE bounded drop-oldest queue, flushes at
  the then-current epoch), the epoch-staleness contract (targeted VIEW pull,
  bounded retries, ALARMED release — never a silent wedge), view propagation by
  install-time FLOOD + view-on-admit (a detached evictee learns its fate from
  ANY member), reachability-gated re-joins (a proposer never re-admits a joiner
  it cannot reach — a persistent asymmetric cut stabilizes as CP read-only
  instead of churning epochs), membership frames fully shape-validated (a
  crc-valid garbage VIEW once crashed the node), and boot modes (a restored
  node is read-only until a live peer confirms its view — or, full-cluster
  restart, the lowest restored member self-ballots the restored view). Epoch 0
  is the OPEN genesis — exactly the M0/M1 behaviour until the first view
  commits — and everything membership does rides the heartbeat clock, so
  `heartbeatMs: 0` sweeps never enter it. The data plane stays open by design:
  membership gates COMMITS and majority math, never replication — an evicted
  node still converges, its stale-epoch stamps just lose LWW. v2's V1d
  divergence class is a sim MUTATION test: a deliberately-broken self-fencing
  build diverges and the harness catches it; the real kernel runs the same
  trajectory green.
- **The sweeps kept earning it during M2:** widening to 5-node topologies caught
  a LATENT M1 bug (seed 79) — a digest-snapshot race echoed a node's own
  records back, self-ingest passed the high-water (local writes never advanced
  the own-stream watermark), and the resulting non-ascending log silently broke
  the AE suffix walk, stranding one record forever. Fixed with the missing
  invariant (a node never ingests its own origin) + a per-event log-monotone
  monitor so the whole class now fails at the poisoning event. 2,500 seeds
  across 3/4/5-node topologies green.
- **M3 the write pipeline is LIVE** (kernel/write.ts + kernel/ring.ts): every
  record enters through ONE ingress — source local (a 'write' event mints an
  Attempt {cid, attemptEpoch, issuer} and commits here or FORWARDS to the ring
  owner), forwarded (the owner cid-dedups then VALIDATES: owns-at-my-epoch +
  attemptEpoch === my epoch + gate open, else a typed WNACK {not-owner |
  stale-epoch | withheld, ce}), inbound (M1's replication ingest, moved
  verbatim), replay (the M4 seam, named now). The ring is a pure function of
  the committed view (two parallel typed arrays, allocation-free `ownerOf`), so
  one-view-per-epoch (M2's monitor) makes single-writer-per-(partition, epoch)
  STRUCTURAL — and that is now a per-event sim monitor of its own. All four of
  v2's DECISIONS-AA conflict sources run as named fault schedules
  (sim/write.test.ts): the never-drop fallback is DELETED (lost-ACK retries
  dedup by cid at the owner and the duplicate ACK re-carries the ORIGINAL
  commit coordinates — exactly-once at the commit site), un-validated
  commitForwarded is inverted (owner validation, with the install window also
  squeezed shut structurally: FIFO links + install-flood + view-on-admit + the
  minority gate — four independent guards a five-construction fault hunt could
  not beat), the flush re-stamp is unrepresentable (parked attempts re-resolve
  OWNERSHIP at the flush boundary and forward; attemptEpoch is re-stamped ONLY
  at issuer/flush boundaries, and a purity-suite lint pins node.commit's sole
  caller), and the restore-boot collision dies in M2's rejoining read-only mode
  (its parked writes owner-route at the merged epoch). The AA#3 mutant — a
  v2-shaped local flush — is CAUGHT by the single-writer monitor (the V1d
  pattern applied to M3). The client relay rule is in the kernel now:
  attemptEpoch 0 marks a client attempt; the first server re-stamps at relay
  time, keeps the CLIENT as the cid-dedup issuer, and routes the ACK back on
  the arriving link. The ONE bounded pending queue (drop-oldest, surfaced)
  replaced M2's buffer — gate-closed, owner-unreachable, NACKed, and
  awaiting-ACK attempts are all the same parked work, re-driven at flush
  boundaries and the heartbeat retry clock. Epoch 0 remains the OPEN fast path:
  byte-identical M0/M1 trajectories (the 3-node sweep produces the exact same
  237,451 events as pre-M3), zero attempt machinery below genesis (a counted
  perf pin). Hot-partition ceiling measured on this box: **~125-134k forwarded
  records/s through one owner** (kernel/write.perf.ts prints it; WSL2 swings
  2-3x — the counted invariants are the durable claims: one WRITE frame per
  batch per owner, one WACK per run).
- **M4b the durability core is LIVE** (the storage seam + boot record; confirm
  and compaction are M4c/M4d): storage is an EFFECT/EVENT pair — the kernel
  emits `persist(batch, bytes, prev)` and `boot(record)`, the env echoes
  `persisted`/`persistFail` — so purity and seeded determinism survive intact,
  and durability is an EXPLICIT MODE (`durable: false` default keeps every
  pre-M4 trajectory byte-identical; the 3-node sweep is still the exact same
  237,451 events). The WAL row IS the wire frame (the same Framer reads a
  socket and the file); restore replays rows through the SAME single ingress
  (source=replay) with original provenance, before the network exists. The
  durable-mode chaos sweep (150×3 + 150×5 seeds: torn tails, fsync lies, dead
  disks, random mid-workload restarts) caught THREE real design flaws while
  this slice was built, each now structural: (1) **interior WAL loss is
  unhealable by suffix anti-entropy** (a lying disk drops middle batches;
  Lamport gaps make the hole invisible to seqs) — every row now carries a
  per-origin CHAIN LINK, and since honest crashes tear TAILS (the shell's
  ordered io-queue and the sim's FIFO fsync clock make resolution order =
  append order), a hole PROVES the disk lied: replay CONDEMNS the restore
  (M4e hardening — the fold resets, the WAL swaps clean, the cluster
  re-teaches; a liar's prefix kept alive resurrected removed cells whose
  fences had been compacted away on this disk's own durable claims); (2) **a stale clock floor let a reborn node re-issue spent
  seqs** (silent loss both directions) — the boot record now stores a Lamport
  CEILING (a lease, re-persisted every LAMPORT_LEASE stamps) and a restore
  resumes AT the ceiling; (3) **one log cannot serve two lives** (after the
  ceiling jump, a lost record of your own could never re-enter below the
  watermark) — a reborn node stamps under a fresh PROVENANCE LANE
  (`uuid~incarnation`; first lives keep the bare uuid, so the wire is
  unchanged), making the previous life an immutable foreign stream that heals
  by ordinary suffix AE — the plan's "incarnation fences dead-origin debris",
  made concrete. persistFail is TERMINAL for the WAL (the fsyncgate policy:
  alarm + freeze durable; replication untouched). The boot record carries
  {view, ceiling, incarnation, votedFor} atomically — a crash inside one
  ballot round can no longer double-vote (the M2 debt, closed with a pin),
  and the sim's `restart(uuid)` rebuilds a node from nothing but its store.
- **M2 debts (stated):** ~~votedFor/committed-view durability~~ — closed by
  M4b (the boot record; pinned). Suspicion still keys off link liveness, not
  PONG timeouts (a hung-but-connected process needs a real-time fault vocabulary — deferred past M4, tracked);
  genesis requires one full formation of the configured hosts. ~~A healed
  evictee may flush at its stale epoch~~ — closed by M3: the flush re-resolves
  ownership and the owner validates attemptEpoch (typed NACK, re-stamp at the
  issuer boundary, retry).
- **M3 debts (stated):** owner-side dedup is an EXACT bounded window
  (DEDUP_KEEP=1024 committed cids per issuer with original coordinates), not
  the plan's high-water + out-of-order set — per-owner cid streams have
  legitimate permanent gaps (cids interleave across partitions and ownership
  moves between epochs), so a high-water test would FALSELY eat first
  deliveries. Attempt identity now rides committed records so the window is fed
  by replication cluster-wide (a retry after an ownership move dedups instead of
  re-committing); the remaining residual is narrow — a retry that outraces the
  ORIGINAL commit's replication to the new owner re-commits as a same-value
  higher-stamp LWW supersede (harmless for idempotent records; M4's confirm
  ladder closes it, since a confirmed write implies the new owner holds the
  stream, and M5's non-idempotent methods will size the window against the retry
  horizon). Dedup LANES themselves are bounded (MAX_ISSUERS=1024, oldest-
  evicted, journal-surfaced) so a client churn can't grow kernel memory
  forever. ~~The issuer cid counter is volatile~~ — the incarnation now rides
  the durable boot record (M4b), so the uuid~inc issuer lane is fresh across
  real restarts by construction. Pending overflow drops the OLDEST attempt
  (journal-surfaced) — under sustained gate-closed writes beyond
  MAX_PENDING=1024 that is real, counted loss.
- **M5a+M5b — the public composer AND the client role — are LIVE** (api/):
  `await fero(name, opts)` → `{data, methods, cluster, destroy}` over `$()`
  proxies, sliced (like M4) into four landable increments: **M5a** composer +
  data binding + cid-overlay → **M5b** the client role (below) → **M5c** methods
  (CALL/SUB verbs, sink.invoke with handlers hosted in the impure api layer,
  tagged Handles + failover policies, flush-on-return) → **M5d** cluster
  end-to-end + the scenario library over the public surface + the two-terminal
  demo + the M5 adversarial review. What M5a establishes:
  - **The substrate contract is settled by probe, not promise** (plan §10's
    go/no-go): `data`'s bare-verb sinks are clone-free with synchronous detach;
    `[view].res` is the record-apply ingress; echoes come back verb-REWRITTEN
    (update→insert) and re-entrant user writes drain INSIDE an apply call — all
    pinned facts (api/substrate.ts banner), consumed through ONE wrapper seam.
  - **Two surfaces, no flag family**: kernel state IS the confirmed fold;
    the proxy = confirmed + the cid-keyed pending overlay (read-your-writes).
    Echo suppression is match-and-consume of one expected echo per apply; the
    overlay needs no value bookkeeping (the beneath is always derivable from
    kernel state — revert/bounce re-reads it).
  - **The write-route join**: Applied now carries the attempt identity
    (iss, cid) on every path that knows one (commit/inbound/replay — pinned),
    so the api resolves its own writes off the ONE apply stream; the cross-epoch
    LWW-loss race resolves from the dedup window's original coordinates
    (writes.committed probe) instead of hanging.
  - **One ingest** for assignment sugar and `methods.update/insert/remove`
    ({confirm, timeout} against the M4c ladder, WriteResolve/WriteReject
    unions) — so seams.validation covers both by construction (v2's OQ6).
  - ~~Capture-path overlay entries whose attempt the kernel drops at
    MAX_PENDING overflow released only on the cell's next apply~~ — closed by
    M5b: onAck feeds the dedup window (WACK coordinates ARE original commit
    coordinates), and Bind sweeps on every droppedPending change — cleared
    entries resolve from the window, dropped ones reject + revert visibly.
    Still tracked: the cluster fold rides a post-step hook (first-class
    membership effect is the M5d decision); user methods stash until M5c.
- **M5b — the CLIENT role — is LIVE**: `fero(name, {hosts})` with no `listen`
  is a SPOKE — a kernel node that folds the same replication stream as every
  member but is invisible to membership. The shape:
  - **Role on the wire, one byte**: HELLO gains `r:1`. Servers exclude client
    links from genesis (count, sweep, and the lowest-uuid race — pinned), never
    suspect them, and a client node runs none of the member machinery (no
    propose/vote/JOIN-knock; stale-pulls and settle stay live).
  - **The single-feeder rule**: a client digests exactly ONE server (its
    PRIMARY — first admitted; re-elected on linkDown with immediate repark +
    re-relay). Non-primary digests are consumed for confirm evidence but never
    answered, so `synced` never rises elsewhere — per-origin ordering holds
    because a spoke has ONE feeder by construction, and failover re-enters
    through the same digest→suffix-ship door as every other heal.
  - **The spoke feed**: servers tap-forward fresh INBOUND records to synced
    client links (commit broadcasts already covered own-origin records), so a
    spoke hears every lane live through its primary instead of at AE cadence —
    attempt identity intact (the overlay join reads it). Zero cost to members:
    one set-size check per record when no clients are connected.
  - **Client writes are the plan's §5 contract verbatim**: ae=0 attempts (the
    client marker, regardless of the view the client knows) relayed by the
    primary, which re-stamps at arrival and owns re-resolution; retransmit on
    the tick clock; owner-side cid dedup absorbs every ambiguity — the sim
    pins lost-WACK, lost-WRITE, and feeder-death-mid-flight as exactly-once.
  - Validation: 193 tests (5 kernel client pins, 4 sim spoke suites incl. a
    30-seed in-suite mini-sweep, Tier-3 composer failover), the 150-seed
    client-chaos sweep (per-pair delay/dup faults, feeder partitions, severed
    relay-hop frames — 1.86M events, spokes included in convergence), and the
    epoch-0 sweep still byte-identical (the role is inert when off).
  - Client residuals (stated): a spoke's confirm probes see only its primary's
    digest evidence, so `confirm:'replicated'` needs majority marks it rarely
    holds — honest timeouts today; M5c's CALL verb makes confirm-over-RPC the
    natural fix. Durable clients (offline-first) are refused loudly at
    fero() time — tracked for M6.
- The plan's pre-M4 CHECKPOINT (the M2–M4 swamp guard) is
  [CHECKPOINT.md](CHECKPOINT.md) — verdict: no overrun, ladder armed but not
  triggered, M4 sliced into five landable increments (M4a streams/watermarks →
  M4b storage seam + boot record → M4c confirm ladder → M4d log/compaction →
  M4e the restore proof), each closing named debts from the ledger — all five
  are now LIVE.
- **Not yet verified (tracked, per plan §7/§11):** the zero-alloc claim is
  structural (method-per-kind sink), not yet counter-verified (--expose-gc heap
  deltas are an M8 pinned-runner deliverable). The replay-refold check HAS landed
  (model.mjs verifyReplay, run in tests and on every capture the viewer opens);
  repo CI is not yet stood up (the plan makes it an M0 exit criterion — it is the
  immediate next step).
- **M4d compaction is LIVE** (kernel/log.ts): the snapshot record supersedes
  the prefix — below the per-origin FRONTIER (every committed-view member
  provably past the cut on CRASH-STABLE marks: durable evidence in durable
  mode, applied marks otherwise — M4e's restore sweep proved applied marks
  compact away history a crashed lane still needs) each entry that is not its
  cell's current winner is dropped; winners
  survive as ordinary records with ORIGINAL provenance, so catch-up needs zero
  new machinery and the two plan properties hold as property tests
  (replay-from-0 ≡ live; compacted catch-up ≡ uncompacted). A lagging member
  PINS compaction — memory is spent exactly where a peer still needs history.
  Tombstone GC releases a remove's stamp once no straggler anywhere could
  still resurrect past it (per-lane quiescence), and the next pass drops the
  remove record itself. Size-armed (COMPACT_AT) on the heartbeat tick,
  journal-surfaced, monitors rescan on shrink. The M0 unbounded-growth debt is
  CLOSED in memory and on disk (the M4e WAL snapshot+swap).
- **M4c the confirm ladder is LIVE** (kernel/confirm.ts): a probe asks "has
  (origin, seq) reached this level?" and the ONLY admissible evidence is the
  watermark ladder — `replicated` = a majority of the committed view holds it
  SHIPPABLE, `persisted` = a majority holds it DURABLE, never `applied` (v2's
  recvReplProbe answered off the apply watermark: a documented
  guaranteed-false-positive, now unwritable). Evidence rides the digests that
  already flow (the `d` map is the shippable tails; durable mode adds a `p`
  map) — zero new frame types, convergence on the heartbeat cadence. Every
  view install RECOUNTS every open probe; the kernel never times out on its
  own (evidence is monotone — deadlines are the embedder's, cancel answers
  false with the count reached); the registry is bounded (MAX_PROBES,
  drop-oldest, surfaced). The M3 residual is demonstrably closed for confirmed
  writes: a CONFIRMED write survives an ownership handoff exactly-once (the
  lost-ACK retry cannot outrace what a majority already holds — pinned as a
  sim schedule).
- **M4e the restore proof is LIVE** (the WAL snapshot+swap + the full-cluster
  kill): `sink.snapshot(batch, rows)` atomically REPLACES the whole WAL with
  the current log re-encoded under fresh chain links (the shell writes tmp +
  fsync + rename inside an ordered io-queue — which also fixed a latent M4b
  bug: threadpool fs.write completions are not order-guaranteed, and two
  swapped appends would have replayed as a false chain hole on a CLEAN
  restart); durable advances to the log tails on the swap echo; arming is
  rows-since-last-swap ≥ SNAPSHOT_AT on the tick, after compaction, so the
  file is O(live cells + SNAPSHOT_AT) always. THE PROOF: kill −9 an entire
  3- or 5-node cluster mid-workload at any seed — torn tails, one lying disk,
  io failures, swaps mid-flight — restart every node from its directory
  alone, and the mesh re-forms (boot records + the rejoin self-ballot),
  converges, and loses ZERO persisted-confirmed writes (150×3 + 150×5 seeds
  expected-empty; sim + a real-filesystem Tier-3 twin). The sweep caught a
  REAL M4d soundness bug while this slice was built: the compaction frontier
  and tombstone quiescence trusted `applied` marks, which a crash regresses —
  a lying disk's reborn lane resurrected a removed cell after every fence was
  compacted away cluster-wide (seed 27). Both now read CRASH-STABLE durable
  marks in durable mode, and a detected lie condemns the restore outright
  (`node.condemn()`: fold reset + clean swap + refold from the cluster — the
  proven wiped-disk path). Honest limits, stated: `replicated` does not
  survive a majority-simultaneous crash (that is `persisted`'s rung);
  persisted-intact assumes a MINORITY of lying disks (fsyncgate's fault
  model — a quorum counted mostly on betrayals is unrecoverable by any
  design); and a lie confined to the newest un-chained-over row of a lane
  evades the hole detector (closing it needs chained-over durable marks in
  the digest — M6 digest work, tracked).
