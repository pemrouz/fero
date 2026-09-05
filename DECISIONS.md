# DECISIONS — fero v3 (settled; append-only)

Seeded at M8 per plan §11: the load-bearing decisions from M0–M7 (full rationale
lives in the DESIGN-M*.md records and the README milestone entries — this ledger is
the index of what is SETTLED, so nobody relitigates it by accident), plus the
carried v2 rejections (plan §12). Never delete a record — supersede it.

NOTE: the repo convention wants one ledger pair at the repo ROOT. The root pair
belongs to the v1/v2 tree and its active sessions; this file is the v3 pair,
path-scoped, and merges into the root ledgers when v3 supersedes the root source.

## V3-1 — the deterministic kernel behind an effect sink (M0)
Context: v2 validated all protocol behaviour over real sockets/timers — a
permanently-red baseline, sleep-and-hope tests, one frozen soak seed.
Decision: kernel/ is pure (`node.step(event)` → effects into a reusable
EffectSink; no I/O, no ambient time/randomness — purity.test.ts enforces it);
shells are <200-line adapters; the sim executive explores seeded trajectories.
Consequences: 1000-seed sweeps in seconds; any failure replays bit-for-bit;
capture/replay/time-travel fall out (M7 spent them on the shrinker + DIAG).

## V3-2 — one typed journal before the layers that emit into it (M0, plan §8)
Context: v2 grew five uncoordinated diagnostic channels retrofitted per milestone.
Decision: kernel/journal.ts defines the closed JK vocabulary FIRST (flat scalars,
bounded drop-oldest ring, surfaced drop counter, `j.armed &&` zero-cost-off);
every diagnostic surface is a view over this ring; kinds are append-only, never
renumbered.
Consequences: captures are self-describing (vocab rides inside); viewer filters
cannot drift from the wire; every loss mode is journal-visible by law (§3.4).

## V3-3 — LWW + Lamport stays; no CRDT merge model (M1; v2 OQ9 carried)
Decision: per-cell LWW over Lamport stamps is the conflict model; hierarchy-aware
LWW is a post-1.0 investigation. Contention is ELECTIONS, not history: only
`lwwSkip` (an election that actually rejected a candidate) counts as conflict.
Consequences: single-writer workloads read as history everywhere (dashboards,
folds); the fold-equality oracle (state == LWW fold of the log) is total.

## V3-4 — synced-gating on live records (M1)
Context: 24% of seeds diverged when a live frame leapfrogged the digest-triggered
suffix ship: the receiver's monotone high-water discarded the suffix as dups — an
interior gap no suffix digest heals.
Decision: live records flow on a link ONLY after the peer's digest arrived
(`link.synced`); overflow de-syncs until the drain-time digest exchange.
Consequences: loss is always a pure TAIL; suffix AE is sufficient by construction.

## V3-5 — committed views by joint-consensus ballot + the CP write-gate (M2)
Decision: views commit by majority of BOTH old and new member sets; ballot
identity is (epoch, proposer, members-hash) enforced at grant AND propose sites;
minority buffers writes into ONE bounded drop-oldest queue; epoch-staleness pulls
the view with bounded retries then releases ALARMED (never a silent wedge).
Consequences: at most one view per epoch is a per-event monitor, not a hope; the
data plane stays open (membership gates COMMITS, never replication).

## V3-6 — ring ownership + forwarded attempts + cid dedup (M3)
Decision: the partition owner is the single sequencer; non-owners forward
attempts [issuer, baseCid, attemptEpoch]; owners dedup by per-issuer cid
high-water; rejections are typed NACKs; ONE stamp site (kernel/write.ts commit).
Consequences: v2's DECISIONS-AA conflict class is a monitor-enforced invariant;
exactly-once survives ownership moves (attempt identity rides replication).

## V3-7 — evidence for confirms is the watermark ladder, never `applied` (M4)
Decision: `replicated` = majority holds it SHIPPABLE; `persisted` = majority holds
it DURABLE; the kernel never times out on its own (evidence is monotone; deadlines
are the embedder's); every view install recounts every open probe.
Consequences: v2's guaranteed-false-positive probe answer is unwritable.

## V3-8 — encode-once; the bytes are the log entry, the WAL row, and the wire (M4)
Decision: a record serializes exactly once at commit; the binary value codec is
the storage format; RecordViews are valid only within dispatch (copy-on-retain);
compaction = snapshot-record-supersedes-prefix below the CRASH-STABLE frontier
(durable evidence in durable mode — applied marks provably compact away history a
crashed lane still needs); a lagging member PINS compaction.
Consequences: no JSON on hot loops; catch-up needs zero new machinery; the
restore proof (kill −9 the cluster, zero persisted-confirmed writes lost) holds.

## V3-9 — the public surface is {data, methods, cluster, destroy}; zero events (M5)
Decision: reads/writes via ViewProxy assignment; methods are function-valued opts
(recognized by value type, not key name); the caller's await-or-not picks
value-vs-subscription; no `.on()`, no hooks; reserved top-level keys stay the
four — new surface nests under one of the three reactive surfaces.
Consequences: the v2 API's event/hook sprawl is unrepresentable; failover
policies live on Handles; read-your-writes rides the cid overlay.

## V3-10 — scoped replication: keep-until-confirmed + the one-teacher latch (M6)
Decision: R-sets via ring.holdersOf; a non-holder sheds ONLY when every current
holder attests coverage; handover is an atomic one-teacher fold (ACQ/ACQDONE);
data whose holders left the R-set at install FREEZES as orphan (re-enters only
through the latch, never a silent un-freeze); epoch 0 is always unscoped.
Consequences: the frozen sweep is byte-identical at R=∞ (inertness is a pinned
property); availability degrades to withheld-writes rather than silent loss.

## V3-11 — THE PP FLOOR LAW (M6 adversarial review; DESIGN-M6 §7)
Context: the possession-floor fast-path advance assumed single-source ascending
delivery — false in three confirmed-critical windows (mid-lane first arrivals, AE
re-admit races, multi-source lane interleave), each a silent permanent data loss.
Decision: every armed record carries `pp` (sender-stamped (origin,partition)
predecessor; wire 0 = UNKNOWN fails CLOSED); floors advance only on locally
verified sub-stream contiguity; the boot record seeds the replay chain-rebuild;
shed evidence re-based onto frozen lane TAILS; durable attestation `sealed` on
the snapshot echo.
Consequences: floor forgeries are unrepresentable; epoch-0 bytes untouched.

## V3-12 — the DIAG plane: a link STATE outside membership (M7; DESIGN-M7)
Decision: diagnostics attach via HELLO r:2 + bearer token against `diag.allow`
(name → token; names are audit identities, tokens never journaled) latching to
LS.diag — never in byUuid/clientLinks/admitted(); pulls are cursor-chunked (the
monolithic pull deterministically drop-loops on big nodes); the wire deny is ONE
constant; journal/meta pulls are NOT journaled (journaling reads-of-the-journal
evicts the history being followed — the audit anchor is diagAuth + linkDown).
Consequences: a spoofed uuid cannot evict a member; attach costs the hot path
nothing; captureNode is re-based on the wire's own diagNode fold (parity by
construction).

## V3-13 — pull-spine everywhere; absent beats faked (v2 DECISIONS O, extended M7)
Decision: /capture.json rebuilds truthfully ON REQUEST (no push relay with its
own cadence); the attach bridge's only cadence is the viewer's poll (in-flight
coalescer, budget under the poll); a node that won't answer is an `absent` row
with a typed closed-set reason, never a synthesized card; handle members that
cannot be honest on a TCP shell (observe/isolate/heal) are ABSENT, not stubbed.
Consequences: no fold can mint a claim about an uncaptured node — structurally.

## V3-14 — compact() on the diagnostics handle refuses when armed (M7)
Context: both panel candidates got this wrong; one design would have forced a
member-ranged frontier pass on a scoped holder — a diagnostics member able to
destroy the only real copy.
Decision: size-gate-free forced pass (v2's drive-it-deterministically purpose)
but 0 on `node.armed` and 0 after destroy, documented and asserted.
Consequences: memory-over-loss holds even under operator tooling.

## V3-15 — perf validation order: counts → ratios → absolutes-on-pinned-runner
Decision (plan §7, operationalized M8): deterministic counts gate everywhere
(incl. WSL2); interleaved same-process A/B ratios are the hot-path guard;
absolute ms/records-per-sec medians persist as tracked JSON keyed by RUNNER
IDENTITY, advisory off the pinned runner. Never widen a threshold; the escape
hatch procedure lives beside the baselines.
Consequences: a noisy box can never fake-green or fake-red the absolute tier.

## V3-16 — the data contract go/no-go: bare verbs, no clone (M0/M5; plan §10)
Context: plan §10 demanded a WRITTEN decision on whether the `data` sibling's sink
contract could carry fero's capture path without structuredClone.
Decision: settled by measured probe (the M0 wrapper-fallback bake-off): the bare-verb
capture path landed; api/substrate.ts is the ONE seam and its banner carries the
timing contract. The clone-based fallback (~30-40% write-path tax) was not needed.
Consequences: capture stays clone-free; the substrate contract-suite-vs-data-HEAD
ride is tracked in IDEAS with the CI entry.

## V3-17 — M3 deviation: exact bounded cid-dedup window, not high-water + OOO set
Context: the plan sketched issuer dedup as a high-water plus an out-of-order set.
Decision: v3 ships a bounded per-issuer exact window (MAX_ISSUERS × window), with
eviction journal-visible (dedupEvict) — the reasoned rejection of the sketch is in
the README M3 record (the OOO set's unbounded tail was the same lie EVENT_CAP told).
Consequences: exactly-once claims are window-bounded and SAY so; retries outside the
window surface as typed conflicts instead of silent double-commits.

## V3-18 — cluster.writes carries pending rows; data never marks them (M5d; plan Q4)
Decision: the client overlay's pending writes are visible as rows of the reactive
`cluster.writes` fold — never as markers inside `data` (a value that changes shape
by delivery state would poison every consumer's equality logic).
Consequences: read-your-writes stays value-clean; UIs that want delivery state join
`cluster.writes` explicitly.

## V3-19 — the honesty gate verifies DERIVATIONS, not shapes (M7/M8)
Context: the promotion gate's first run flagged `routes`' composite keys
(`origin#seq`) as untraceable; the tempting fix was to allow the shape.
Decision: the gate traces every PART of a composite identity to a capture fact —
an invented word inside a composite still fails. Same rule for cellKey encodings.
Consequences: fold output can never smuggle prose through an identity-shaped hole.

## V3-20 — the v2 performance referent: classified, measured, and re-homed (M8)
Context: plan §7 demanded "v3 beats v2" on interleaved same-box A/B for the L2
write path and the composed replica apply path.
Decision: the headless A/B against v2's L2 is UNCONSTRUCTIBLE — v2's resource layer
is socket-coupled at fero() construction (its own test suite was wholly wall-clock
TCP; that is half of why v3 exists). The constructible headless comparison is
v2's L1 (a bare array-append + proxy-project with no dedup/LWW/provenance/
watermarks/journal/wire) — measured this session at ~9× FASTER than v3's full
composed paths, which is a CATEGORY ERROR as a referent, not a regression: it is
strawman-class, and v3's own tracked kernel-vs-strawman ratio (~3×, gated < 6× at
node.perf.ts, persisted in the baseline) already prices the machinery v2's L1
simply does not do. The honest referent set is: (1) v3's strawman ratio, tracked
and gated; (2) absolute records/sec persisted per-runner (the baseline artifact);
(3) the REAL v2-vs-v3 A/B — both stacks over localhost sockets, request-for-
request — which needs the pinned quiet runner and is recorded in IDEAS beside it.
Consequences: no gate compares a replicated database's write path to an array
push; "durably faster" gets its number on hardware that can hold one.

## V3-21 — the allocation claims, narrowed and counter-verified (M8; DESIGN-M8)
Context: plan §7.1's literal "zero heap allocations per steady-state inbound
record" is not what the code claims — retention IS the product on the fresh path
(the log entry is the retransmit buffer), and RecordViews are transient by design.
Decision: three verified claim classes (kernel/alloc.perf.ts): Z zero-GARBAGE
(ring lookups — gcEvents===0 is the categorical witness; the naked heap delta
alone is unsound because scavenges EAT it, shrinking the signal as a regression
grows), R0 zero-RETENTION cycles (duplicate-absorb, Outbox cycle, issuer leg),
RB retention-BUDGETS on the fresh path (≤512 B/record at batch 512, batch-
independence at batch 16). The instrument's mutation control (D6) proves the
gates can see. Found and fixed in the same change: ring.holdersOf violated its
own allocation-free contract (`length = 0` + push discarded the scratch's backing
store every call — ~7 scavenges/100k calls; 0 after the index-cursor rewrite).
Consequences: "allocation-free" in a banner now has a gate with teeth behind it;
the root plan's §7.1 wording amendment is left to the session that owns root files
(pointer in IDEAS).

## Carried v2 rejections (plan §12 — decided OUT of v3.0)
- **L3 planner** (distributed operator graph): out of scope entirely.
- **fero.all, UDP multicast discovery, cluster.peers.send**: deleted from the
  spec; static discovery + broker is the rendezvous (multicast returns only with
  a demand signal).
- **Peer-to-peer auth**: post-1.0; the handshake reserves bytes; DIAG's allowlist
  is the only v3.0 auth (and DIAG's spoof-immunity is NOT the client plane's
  closure — the r:1 uuid-spoof hole is tracked in IDEAS under this heading).
- **v2 migration/compat**: none — greenfield deploy; no wire/WAL/cluster interop.
- **CRDT / OR-set merge**: LWW stays (V3-3).

## V4-1 — fero v4 runs on data v4; fero owns the write surface (D0–D4, 2026-08-01)
Context: data v4 landed fero's entire DESIGN-DATA3 wishlist (W1–W17 — hot lane,
origin tokens, clause-10 deep-path law, executable SCHEDULE, public sink/each/
promote, wire egress, rescopable filter, quantiles, per-path connect, mount).
Decision: the api layer consumes data v4 through the one substrate seam; fero's
assignment-writable public surface is FERO'S OWN LENS (writes trap into
Bind.issue BEFORE data — validation covers assignment and methods.* by
construction), deleting the capture/echo/heal wart family instead of porting
it. The #frames stack stays (fero-kernel re-entrancy, orthogonal to data's
clause-5 queue). The 16-clause SCHEDULE suite rides fero CI (test:contract).
Consequences: 297/297 + 16/16 green; perf 36/36 at the v3-era thresholds; the
seam is contract-pinned in both CIs (the c870bde class is structurally closed);
residue tracked in IDEAS (move-streaming mirror keying, frame-batched apply,
armor slimming).

## V4-2 — the v4.1 surface: role by declared act, derived ports, recovered identity, f.snapshot (2026-08-23)
Context: three config questions the surface couldn't answer cleanly — why must
a caller mint a uuid, why must localhost topologies name addresses, why does a
render loop import internals. Each closed with a real defect en route.
Decision:
- **Identity**: the boot record carries `uuid`; restore recovers it; the
  composer resolves config ?? restored ?? random and THROWS on a config/dir
  contradiction. (Closed en route: the silent evicted-heir bug — uuid omitted
  on a durable dir half-restored under a fresh identity.) uuid validates at
  fero() time: non-empty, no '~' (the incarnation-lane separator).
- **Role by DECLARED ACT** (supersedes v2's hosts-without-listen rule): any
  server marker — server: true, listen ('host:port' | false = the socketless
  solo), dir, replicas, a data seed, any function-valued option — makes a
  server; no marker = a CLIENT. hosts is pure dial targets (alone = the v2
  client shape; beside a marker = a dialing member). Role is a pure function
  of CONFIG. REJECTED: bind-arbitration (first to bind serves) — role must
  never depend on timing or launch order; and client: true — with client the
  default it pins nothing (add on demand for asymmetric-intent processes).
- **The derived default port**: fnv1a32(name) into 127.0.0.1:[44800,45824) —
  a bare server binds it, a bare client dials it; zero addresses on
  localhost, zero scanning. Prerequisite shipped FIRST: HELLO echoes the
  resource name; both ends refuse a mismatch (JK.nameReject 71, dead +
  noRedial) — a misdial used to be ADMITTED and digest-on-admit silently
  cross-replicated two resources' logs. Absent name = legacy embedder/sim:
  no check, HELLO bytes unchanged. Loopback ONLY — the peer plane is
  unauthenticated; a routable derived bind is never a default.
- **The data seed**: `data: {...}` applies only when the local fold is empty
  at boot (a restore/replay never re-seeds — the restored Lamport ceiling
  would clobber newer values); rides the validated lens ingest like any write.
- **f.snapshot**: the synchronous whole-resource read on the INSTANCE
  (data's [value]); armed-scoped nodes throw the typed ScopedError (a sync
  local read is the shard — the banned silent partial). REJECTED: delegating
  toJSON through the lens — it quasi-reserves a name on the data surface and
  adds a compare to the hot get trap; JSON.stringify(f.data) stays
  documented-wrong (leaves render {}), f.snapshot is the idiom.
Consequences: BREAKING — bare fero(name) is a client now (the old bare solo
is `listen: false`); the durable-client and replicas-on-a-client refusals
retire, unrepresentable by construction (dir/replicas imply server); the
two-terminal demo runs with zero addresses/identities/internals imports.
Battery: 331/331 + 18/18 contract + perf 41/41 (cold paths only — compose,
boot, HELLO admission).

## V4-3 — the per-box directory: no name hashing, servers on free ports, `#` system resources (2026-08-30)
Context: the derived port welded WHERE a resource lives to HOW it is found, and
live experiments against the tree measured the cost: 1024 slots per box
(P(collision) ≈ 4% at 10 names, 17% at 20, 50% at 38); one bare server per
name per box (the second is EADDRINUSE); a bare hub has no `hosts`, so genesis
— proposed only by a lowest-uuid node WITH hosts — was a uuid coin-flip
(pinned: `aaaa` never forms, `zzzz` forms); a bare client could only START from
the derived port; a dead hub left every NEW joiner blind. The old fero's
discovery on `master` (static `hosts × ports` + a well-known `#broker`
candidate, handshake gossip of known servers) pointed at the shape: a
well-known RENDEZVOUS, not a well-known port PER RESOURCE. Spec:
DESIGN-DIRECTORY.md (the panel run was refused by a usage limit; the
adversarial pass was done by hand, §9).
Decision:
- **`#directory`, a system resource at `127.0.0.1:3376`** ("FERO" on a keypad;
  below Linux's ephemeral range so `listen(0)` never hands it to a resource;
  loopback only — the peer plane is unauthenticated). The first SERVER on the
  box to bind it hosts a soft-state registry `name → {uuid: listen}`; every
  dialable instance opens a `#directory` client (api/directory.ts): servers
  `register`, everyone opens `lookup(name)` as a LIVE subscription, and the
  folded addresses feed the kernel through the new `discover` event. Hosting
  is first-to-bind — a DISCOVERY role only; the data role stays a pure
  function of config (V4-2). Clients host nothing; a host's death makes every
  server's directory client retry the bind (jittered) until one hosts.
- **Method-plane state, not replicated data.** The registry is a data proxy on
  the host; an entry lives exactly as long as its registrant's link to the
  CURRENT host — peer-down cleanup keyed by uuid transitions, read AFTER the
  fold (a reaction reading `peers` inside a tap sees the row from BEFORE the
  fold, which dropped registrations arriving in the same TCP chunk as their
  HELLO; a microtask defer + a 3-pass grace for not-yet-published callers).
  Takeover = the existing Caller failover (re-subscribe, root-replace) +
  re-register on every primary change. No `unregister`: link death IS the
  mechanism. REJECTED: the registry as replicated `data` — soft state through
  a CRDT log needs a takeover sweep against lanes anti-entropy resurrects.
- **Servers bind a FREE port** (`listen` omitted ⇒ `127.0.0.1:0`; the shell
  publishes the OS-chosen address to the kernel inside its listen callback —
  before start, before any accept can HELLO). `derivedAddr` deleted.
- **Kernel `discover`** (`{kind, hosts}`): `node.hosts` = static ∪ dynamic
  (cached; own listen excluded), read by genesis and revival unchanged; added
  targets dial unless a live link or an active chain covers them; forgotten
  targets PARK at the cap (a mid-flight chain stops at its next failure,
  revival ignores them, a re-add clears the park); static hosts and committed
  members are never parked. No new journal kind. Genesis over a discovered
  set: concurrent proposals resolve by the ballot (one vote per epoch), a late
  registrant joins at the next epoch — no settle window (sim-pinned).
- **`#` is reserved**: `fero('#…')` throws for users; the composer's internal
  entry mints system resources; the name rides HELLO, so `#directory` reads as
  a system node in captures and journals. A user resource may not `listen` ON
  the rendezvous (its HELLO would name-reject every directory client dead +
  noRedial — never revived — stranding discovery on the box). A NON-fero
  squatter is survivable: bounded chain → give-up → heartbeat revival, and
  the servers' bind-retry loop hosts the moment the port frees.
- **Config**: `rendezvous?: string | false` (default the constant; the
  `FERO_RENDEZVOUS` env var overrides the default — an address, or `off`).
  `npm test` / `npm run perf` run with `off`, so explicit-topology tests never
  meet another tenant's directory on a shared box; discovery tests opt in with
  a free port EACH. A client with no directory and no hosts refuses loudly.
  `cluster.me` carries `hosts` (static ∪ discovered) on every role and
  `rendezvous: {addr, hosting, up} | false`; the diagnostics seam exposes the
  directory nodes (`rendezvous()`); `Context.peer` names a wire caller.
- Panel answers (§9): Q1 clients host nothing; Q2 no settle; Q3 no dial-back;
  Q4 3376 + env; Q5 per-instance directory clients (uniform, no process-level
  state); Q6 the strands found were closed by construction (above).
Consequences: BREAKING within 4.x — `derivedAddr` is gone, a bare client with
the directory off refuses, `cluster.me.hosts` exists on servers too. What it
does NOT fix: a 2-member view has no fault tolerance and a bare restart is a
new identity — `dir` + ≥3 members stays the deployment rule. A debugger badge
for `#` resources is an IDEAS line (viewer.html is mid-edit in another
session). Battery: 355/355 + 18/18 contract + perf 41/41.
Addendum (the implementation panel, same day — DESIGN-DIRECTORY §10): 25
confirmed findings, 8 major, all reproduced; fixed in the follow-up commits —
the squat strand (a `sameSocket` guard against every spelling + kernel
revival of a name-rejected target at heartbeat cadence), JSON owner keys
(names with spaces), per-cell ownership (the later registrant wins; only the
owner's death drops), `FERO_RENDEZVOUS ??= 'off'` pinned inside every
non-directory suite, `hostMethods` as a unit-test seam (the fold-order defect
pinned deterministically), a probe-gated, exponentially backed-off bind retry
with errnos on `cluster.me.rendezvous.error`, discover's park cancelling the
armed timer and dropping entries nothing names. Precedence documented: config
> env > constant. Battery: 372/372 + 18/18 contract + perf 41/41.

## V4-4 — the relay validates: seams.validation is an issuer-boundary hook, on the wire too (2026-09-05)
Context: a site review probed a server with `seams: { validation: r =>
r.key[0] !== 'admin' || 'reserved' }`. It refused its own `data.admin = …`
and a hosted method's `ctx.data.admin = …`, but a bare client's
`data.admin = …` LANDED and the client read `committed`. The validator was
wired into Bind.issue (the ONE local ingest); a relayed WRITE frame (ae 0)
entered kernel/write.ts onWrite → #enqueue directly. The relay "re-stamps ae
(relay time is an issuer boundary)" — yet ran no validator, so validation was
a local-invariant hook, not a bound on what an admitted client may write.
Decision:
- **The relay runs the server's validator.** The composer hands
  `seams.validation` down as `NodeOpts.validate` — a pure predicate, so the
  kernel stays I/O-free and deterministic; onWrite's ae-0 branch runs it per
  record before `#enqueue`. Absent ⇒ every relayed record admitted and
  trajectories stay byte-identical (one undefined check per frame).
- **`invalid` is a fourth NACK class, and it is TERMINAL.** WNACK
  `{r:'invalid', m: reason, ce}`, batched per contiguous same-reason run like
  the three routing reasons; `m` is bounded on the way out (REASON_MAX 256).
  At the ISSUER the attempt leaves the queue for good — `Writes.rejected`
  ('issuer|cid' → m, bounded at MAX_PENDING) + `rejectedPending`; the api's
  `Bind.sweep` (the droppedPending probe, widened) rejects the promise with
  the reason and reverts the overlay cell — called from the composer's
  post-step fold, because a WNACK step applies nothing. At a RELAY (via ≥ 0)
  it hops onward to the client. Owner-of-record gating is unchanged. The
  journal records the typed class, never the free text.
- **A committed retransmit skips the check.** A cid in the dedup window
  passed once; a state-dependent predicate must not turn a retransmit of a
  committed record into a lie — the ordinary path dup-ACKs it.
- **Forwarded (ae > 0) peer attempts are NOT re-validated.** The issuing
  server ran its validator; peers are trusted at this layer (same code, same
  config — the deployer's contract, like replicas). REJECTED: validating at
  the owner too — it doubles the check on every cluster write and buys
  nothing while peers are trusted.
- REJECTED: a new sink effect for the reject (an EffectSink change through
  shell/sim/every harness for what the counter+probe idiom already says).
  REJECTED: carrying the free-text reason in `r` (the vocabulary stays closed
  and journal-typed; the text rides as `m`).
- **The relay is keyed on the ADMISSION FACT, not the claim.** `ae === 0` is
  what an honest spoke sends; a client link forging ae = epoch used to skip
  the relay into the owner leg (dedup → epoch/owner/gate → commit, no
  validator). The branch is now `ae === 0 || link.client` (the HELLO r:1
  fact the server recorded), so any WRITE on a client link is relayed:
  validated and re-stamped. One boolean per member WRITE frame; honest
  clients byte-identical.
- **An ACK/NACK on a client link is dropped** (`frameDrop 'write-ack from
  client'`, link kept). A client owns nothing to answer for; a parked
  relayed attempt has no owner of record yet (`to` ''), so the owner gate
  alone let a forged WACK clear it — or a forged terminal `invalid` end it
  and hop a fake reason to the victim.
- What this is NOT: authorization, or peer auth. The hook sees the record,
  never the caller; per-caller rules live on the method plane (ctx.peer). It
  bounds what the fero CLIENT (the SDK's write surface) may write; a raw
  socket forging pre-stamped RECORDS frames still lands as replication —
  spokes legitimately ship suffixes back through AE, so that is the r:1
  peer-auth question (IDEAS), not a one-line drop. The "methods only" door
  (IDEAS Security, step 2) is a separate decision, under design review —
  including whether that door makes the per-record hook redundant.
Consequences: a plain client assignment a server's validator refuses now
bounces at the client with the server's reason (cluster.writes shows
rejected + reason; methods.update rejects a WriteReject at reached 'issued').
Pinned: kernel/write.test.ts ×5 (the relay refuses, batches, dedup-skips;
terminal at the issuer + owner-of-record + malformed `m`; the relay hop; the
forged-ae client; the client-link ACK/NACK drop), sim/client.test.ts (under
the executive, every monitor green), api/index.test.ts (the probe) — each
mutation-checked. Battery: 379/379 + 18/18 + perf 41/41.
