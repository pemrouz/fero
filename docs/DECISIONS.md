# DECISIONS — fero (settled; append-only)

The load-bearing decisions, V3-1 to V3-21 from the v3 build (full rationale in the DESIGN-M*.md
records and in HISTORY.md) and V4-1 onward for fero v4, plus the carried v2 rejections. This is
the index of what is SETTLED, so nobody relitigates it by accident. Never delete a record —
supersede it. The one-line index, and everything still open, is [../STATUS.md](../STATUS.md).

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
policies live on Handles; read-your-writes rides the cid overlay (V4-7: by
commit — the overlay is gone).

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
`cluster.writes` explicitly. (V4-7: the overlay itself is gone — an in-flight
write is ONLY a pending row here; `data` shows it when it commits.)

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

## V4-5 — `methods:` is the door; spokes are views (2026-09-06)
Context: V4-4 left two things open. (1) The "methods only" door — three
independent design proposals converged on a new `writes:` config key with a
verb-granular reopen list. (2) Evidence that an admitted spoke could ship
RECORDS to a server: kernel/node.ts's RECORDS case checked admission, not
`link.client`, and the DIGEST handler's suffix-ship loop ran on spokes too, so
a spoke ahead of its feeder re-taught it. The user cut both: "open or
protected, nothing in between"; `methods:` is the word, its presence protects;
a spoke never teaches — it resyncs to the cluster's truth.
Decision:
- **`methods:` — the one spelling for hosted methods, and THE DOOR.** A
  declared FeroConfig key: a plain object of handlers `(arg, ctx) => …`;
  names off the system plane and off the built-in writers, exactly as before.
  A top-level function-valued option now THROWS with a pointer (`'sell' is a
  function — methods live under methods: { sell }, and declaring them makes
  clients change data only through them`): the pre-V4-5 "any function is a
  method" recognition rule is retired, so recognition is by declared key
  alone (FeroOpts = FeroConfig — TypeScript catches typos too). Presence =
  PROTECTED: every relayed client record — assignment, delete, the write
  builtins, methods.update/insert/remove (one ingest, the same bytes) — is
  refused at the relay with the terminal reason 'methods-only' (V4-4's
  `invalid` WNACK, `m` 'methods-only') BEFORE any user code runs; the client's
  promise rejects typed, a plain assignment bounces, cluster.writes names the
  door. Reads and subscriptions stay open (reads are not writes). The pin is
  about the WIRE: the server's own writes and its handlers' ctx.data writes
  are trusted — and still meet seams.validation. `methods: {}` = a resource
  clients may only read. Implies server. No reopen knob.
  Mechanics: ZERO kernel change — the door is a degenerate admission
  predicate (`() => 'methods-only'`) the composer folds into V4-4's one hook
  (NodeOpts.validate) instead of the server's validator; open servers hand
  the kernel exactly what V4-4 did. The `#directory` host declares its methods
  and is protected for free.
  REJECTED: a `writes:` key (a second word for what `methods:` already says;
  its reopen list is the "in between" ruled out). Keeping top-level functions
  as an open-server spelling beside `methods:` (two spellings whose placement
  changes who may write). A kernel mode flag + a typed `NACK.methodsOnly`
  refusing on the tag byte without decoding the body (cheaper under hostile
  spam, but a second refusal mechanism and more kernel; add it only if a
  consumer needs the typed class — IDEAS). Advertising the pin in HELLO for a
  zero-RTT client refusal (a wire-surface change; the round-trip bounce is
  honest — IDEAS; V4-7: nothing shows meanwhile, so the round trip only
  decides the outcome row).
- **A validator-refused write inside a handler FAILS the call.** Bind.issue
  leaves a `Refused {refused, key, reason}` rejection in the live handler
  collector; the Host's flush-on-return and `ctx.flush()` throw
  `write refused (<cell>): <reason>` — wire CALL and invokeLocal alike. Under
  the door the handler is the client's only way in, so a reply that claims an
  effect that never happened is §9's banned silent partial. The kernel's own
  outcomes ('superseded' | 'dropped' | 'destroyed') stay swallowed — whether
  they should fail the call too is a separate decision (retry semantics —
  IDEAS). Handler READ idiom, stated: `await ctx.data.x` is the current value
  (the live view is thenable, v2 parity); a bare `ctx.data.x` is the live
  child view, not the number. Panel notes (the one review lens that ran):
  the Refused rides the LENS path only — a handler calling the instance's
  own methods.update gets its typed WriteReject alone, so a handler that
  catches it recovers (a double report would have overridden it); `methods:`
  must be a PLAIN object (a class instance keeps its handlers on the
  prototype — it would host nothing and protect everything — refused at
  fero() time); and the loudness holds for CALL and invokeLocal — on the SUB
  leg a refused handler write, like ANY thrown SUB handler, leaves a stream
  that never opens with no client-side error: a pre-existing gap of the
  subscription leg, filed in IDEAS, not widened here.
- **Spokes are VIEWS, not replicas.** (i) A client never ships a suffix: the
  DIGEST handler's client branch answers r=1 with its tails and ships nothing.
  (ii) A server drops RECORDS arriving on a client link (frameDrop 'records
  from client', link kept — a pre-fix spoke that is ahead still ships: stale,
  not hostile). (iii) RESYNC: when the feeder's digest shows a lane tail BELOW
  the spoke's, the cluster's truth moved under it (records died with a server;
  a failover landed on a lagging feeder). The spoke resets its fold
  (#resetFold, shared with condemn), sends an EMPTY r=1 digest, and on the
  feeder's r=0 reply — sent after the suffix on the same FIFO link — removes
  every cell held at the reset that did not come back, through the ordinary
  apply effect (a synthesized remove under its own name, seq 0: never logged,
  never on the wire; V4-7: a still-pending own write shows again as its echo).
  The projection is left as it is until then: no remove-everything flicker.
  "Ahead of my feeder" is a TRUE signal on the single-feeder FIFO — at the
  instant a feeder builds a digest its tails cover everything it has shipped.
  Journal `resync`(a=cells) / `resynced`(a=ghosts); the debug fold model
  treats `resync` exactly like `walTaint`. Survives a failover (the new
  primary's reply completes it).
  REJECTED: per-lane truncation with a local refold (compaction keeps only
  current winners, so a cell's previous value may be gone locally — only a
  full re-download is honest). Keeping the spoke's extra records forever (the
  cluster is the truth; a spoke holding what the cluster lost would diverge
  permanently). A remove-everything projection reset at the start (visible
  flicker on every failover onto a lagging feeder; the completion diff
  removes only real ghosts).
Consequences: BREAKING within 4.x — `fero(name, { sell: fn })` throws; write
`methods: { sell }` and know it now protects. Open servers (no `methods:`)
are unchanged: the two-terminal demo's client keeps writing plainly — that
is the intended homepage narrative (the demo; "you probably don't want
everyone to change anything"; protect with named methods). Site claims to
re-pitch: "any function: a hosted method" → `methods:`; the seams.validation
rows → a schema check (V4-4). IDEAS Security P2 closes (both steps); the r:1
peer-auth item narrows to the HELLO uuid spoof (RECORDS from a spoke now
drop; a spoke never ships). Tests: api/index.test.ts (recognition rewritten;
the door: assignment + builtins bounce 'methods-only', the method writes, the
server's own writes land, the validator guards the trusted side, `methods:
{}` is a server; the spoke resync over real sockets), api/methods.test.ts
(a refused handler write fails the call, flush throws, recovery, local
rule), kernel/client.test.ts (a spoke never ships + resyncs with ghost
removes; RECORDS on a client link drop), sim/client.test.ts (a feeder dies
holding a record only it and its spoke had — the spoke fails over to a
lagging member, resyncs down, and the record returns through the cluster),
tools/debug/eli5 + model gates. Battery: 385/385 + 18/18 + perf 41/41.

## V4-6 — the graceful leave: a clean destroy() shrinks the view by ballot (2026-09-07)
Context: the user's by-hand run of the first example (two copies of one file,
Ctrl-C one, start it again) wedged: the survivor at `writable false` forever,
the newcomer never admitted. Arithmetic, not a bug: a view change needs a
strict majority of the OLD view (membership.ts's joint check), a two-member
view's old majority is both members, a dead member cannot vote, and the
survivor never even proposes an eviction (the live-majority guard). Two facts
made a clean stop indistinguishable from a crash: destroy() sent nothing (no
LEAVE verb existed) and a bare restart is a new uuid (V4-2/V4-3). "Why does a
cluster of 1 or 2 not work, what would it take, and the trade-off" was
answered from source (a rules reader, an options reader, a skeptic): 1 works
(open genesis); 2 works while both are up, and heals restarts with `dir` on
both (a pause-while-down cluster); 2 losing a member for good cannot be made
both safe and automatic by any symmetric rule (equal-epoch views are ignored
forever — a wrong guess is a permanent fork). Options: `dir` on both (works
today); LEAVE on a clean destroy (no safety cost); an opt-in asymmetric
tie-break for n=2 (one-directional — heals only the light member's crash);
an operator force (a guarded door in front of the existing hand-edited-
boot.json self-ballot). Rejected: a quorum-of-one gate (half a keyspace, no
recovery path), automatic unilateral eviction (symmetric split-brain), a
derived uuid without `dir` (two copies of one file collide; a vote without
stable storage double-votes), a witness (needs a third failure domain, and a
third bare copy already is one that also holds data). The user chose LEAVE
alone: "tie-break would just work for one server going down".
Decision:
- **A clean destroy() LEAVES before it tears down.** The kernel gains a
  `leave` stimulus (Event) and a LEAVE verb (25, value `{}`): a member that
  is stopping on purpose proposes the view WITHOUT itself when it is the
  lowest live member, else knocks LEAVE on every member link each tick and
  the lowest live member proposes the shrunk view — the single-proposer
  discipline kept; the frame carries no identity, the leaver IS the link's
  authenticated uuid. The leaver's own grant is the old-majority vote an
  eviction of a DEAD member can never get, so joint consensus passes on a
  two-member view (2-of-2 old, 1-of-1 new) and the survivor is writable alone
  (one of one is a majority). Journal `leave` (a=uuid: self when sent, the
  leaver when received) and `left` (a=epoch, b=clean).
- **The exit proof.** The leaver goes only when a VIEW at or above its epoch
  that does not hold it arrives from a peer that stays — the proposer's VIEW,
  or a survivor's flood-back of its own self-proposed view. Going before that
  could take the only copy of the commit with it. Bounded: LEAVE_TICKS (4
  heartbeat ticks — ~2 s at the 500 ms default) without the echo and it goes
  anyway (`left` b=0), from where it looks like a crash and the pre-V4-6 path
  (suspicion, redials, eviction) takes over. Runtime.leave() adds a wall-clock
  cap (the tick bound at this node's cadence plus slack; heartbeats off ⇒ no
  view ⇒ answered at once) so destroy() can never hang on it. A leaver never
  knocks JOIN back in between `left` and the teardown (the evictee branch
  skips a leaver); a leaver's ballot REBASES on any newer view that still
  holds it (a member admitted meanwhile is never dropped); the last member of
  a view simply goes (never an empty view). Nothing to leave (open genesis, a
  client, a non-member, a rejoiner, a stale gate) answers clean at once.
- **Nothing else moved.** Ballots, majorities, vote-once-per-epoch, escalation
  past burns, view-on-admit, the gate: untouched. `evict` keeps meaning "left
  the committed view at install" for a leaver too (the ELI5 says so). The
  sink effect `left(clean)` is OPTIONAL — only the shell waits on it; the sim
  records it per uuid (`sim.left`). A peer that predates the verb drops the
  frame and keeps the link (the unknown-verb rule): the leave then times out
  and degrades to a crash — a rolling upgrade is safe, just slow for the
  first stops.
- **`diag(f).crash()`** — drop()'s fault-injection twin: tear down WITHOUT the
  leave, a process death as the cluster sees it (destroy() = leave + the same
  teardown). api/methods.test's hold-path test uses it: its premise "kill one
  of two → minority" needs a crash now, since a clean leave hands the
  survivor a writable one-member view.
- **Example 01** stays three copies (a CRASH of one of two still wedges — the
  deployment rule is unchanged: three plus `dir`), but its banner and README
  now say a clean stop of one of two works, with the real two-copy paste.
  (Amended 2026-09-12: 01 went back to TWO copies — `01-two-servers` — the
  user's original ask. The leave made the crash story unnecessary at rung 01;
  the check stops a copy cleanly instead of killing it, and the crash rule
  lives at rung 13.) New
  lib helper `coalesce`: the cluster view sets its fields one record at a
  time (`writable` lands before `members`), so a tap that renders inside the
  callback sees a half-updated line — `coalesce` renders once per turn.
AMENDED 2026-09-14 (the leave shortcut wedge, found by the example series'
skeptics — "one clean stop in five, under load, left the survivor at
`members 2 writable false`"; hunted to a deterministic sim repro): `leave()`
answered "nothing to leave" at once whenever the leaver held no view yet
(`view.epoch === 0`), and likewise when it was rejoining or epoch-stale. But
those are statements about how current MY knowledge is, not about whether a
PEER holds me: the leaver may already have granted the genesis ballot while
the survivor has installed the two-member view (its VIEW frame in flight,
unread under CPU load, or dropped from a paused outbox — one dropped VIEW
frame leaves a node at epoch 0 for good on an idle cluster, since only VIEW
teaches). The shell tore the node down, exit 0, no LEAVE sent, nothing
journaled — and a two-member survivor can never shrink alone. Fix: "nothing
to leave" needs EVIDENCE — a client, or a committed view that does not hold
me with someone else, or, while I hold no view, no admitted non-client link
at all; otherwise knock (at epoch 0 LEAVE goes to every admitted peer, and
the peer that has a view proposes the shrunk one; the knock keeps going
while epoch 0). The at-once path latches `leaving` so the microtask hop
before teardown cannot vote the node back in, and `onPropose` refuses a
ballot that puts a node that has ANSWERED its leave back into a view, while
a ballot that takes me OUT is grantable even when epoch-stale. Joint
consensus is untouched: refusing a vote can only cost liveness, and the
ballot it costs must not commit; the extra grant rests on vote-once plus the
proposer's joint majorities, never on the voter's freshness. A rejoiner now
knocks like any member and, unanswered, goes like a crash after LEAVE_TICKS
— journaled, never silent (kernel/membership.test's rejoiner pin changed to
say so). Pinned in sim/membership.test.ts (three shapes, red on the old
kernel); 80 real-socket iterations under a 12-thread CPU load: 6 wedges
before, 0 after. The second failure mode is filed, not fixed (ISSUES I-20):
a SURVIVOR stalled longer than LEAVE_TICKS × heartbeatMs across the leave
never sees the knock, the leaver goes with `left` b=0, and at n=2 that is
permanent — the graceful leave is the only exit a two-member view has.
REJECTED/DEFERRED: the n=2 tie-break (one-directional; "two cannot lose the
primary"); the operator force (the unguarded self-ballot via a hand-edited
boot.json already exists — a loud guarded door is a last resort to file if
ever needed); a scoped-mode handover BEFORE leaving (a leaving holder is
exactly as safe as an evicted one today — the R-set re-acquires from the
other holders; a pre-leave shed is future work); warning spokes before
leaving (they fail over on the link death, as for a crash).
Consequences: the two-terminals story works with two copies — Ctrl-C one,
the other prints `members 1 writable true` and keeps committing, start the
file again and it prints `members 2` (verified by hand over real processes;
the stopping copy exits in ~10 ms). Every clean stop of any member shrinks the
view at once instead of after ~20 s of suspicion and redials. Tests:
kernel/membership.test.ts (+7: both leaver shapes, the receiver, ignored
knocks, the bound, nothing-to-leave, the rebase), sim/membership.test.ts
(+2: n=2 then a newcomer; n=3 under writes, monitors quiet),
api/index.test.ts (+1: two fero servers over real sockets — destroy one, the
survivor alone and writable, a new identity joins and catches up).
Battery: 396/396 + 18/18 + perf 41/41.

## V4-7 — no ghost: a write shows when it commits, never before (2026-09-13)
Context: the user asked whether client writes are applied optimistically by
default, and said they should not be. They were: every accepted record —
plain assignment, the lens builtins, methods.update/insert/remove, the data:
seed — was projected into the local proxy BEFORE the kernel saw it
(Bind.#optimistic), on every role, with no switch (the `fromCapture` off-switch
existed but no caller ever set it). On a server writing a cell it owns that
was moot: the commit lands inside the same assignment and data's Object.is
chokepoint drops the second apply. On a client it was the only reason its own
write showed before the server's echo, and it misled four ways: under
`methods:` a plain client write is doomed but showed for a round trip and then
"bounced" (IDEAS' "overlay flicker"); a validator refusal did the same; an
object-valued write painted twice on a client (the ghost, then the echo — a
fresh reference); and the 02 check's "echoed back" line was once satisfied by
the ghost (STATUS 2026-09-12). Nothing depended on it: no handler, test,
example, fold, diagnostics or debugger read a forwarded write back from the
proxy; three api/index.test.ts pins and one binding pin asserted it. Five
readers and five skeptics over the source established all of this.
Decision: ONE surface. The proxy IS the confirmed fold. A write shows when it
COMMITS: inside the assignment on the server that owns the cell (the epoch-0
fast path or the self-owned attempt — read-your-writes by commit), and as the
owner's stamped echo everywhere else — a client, or a server writing a cell
another server owns — the same apply every other node sees. Until then the
in-flight write is a `pending` row of cluster.writes (V3-18: delivery state
never lives inside `data`). A refused write — the local validator, a relay's
validator, the methods door — never shows: nothing to revert, nothing to
bounce. The optimistic overlay (#optimistic, #revert, `fromCapture`, the
branch that hid foreign commits under an in-flight cell) is DELETED, not
ported. What survives is a settlement INDEX (#inflight: cell → newest pending
cid) that decides promises only: the cross-epoch LWW-loss race still resolves
from the dedup window on the next foreign apply, or rejects 'superseded'. The
lens asks that index before swallowing a delete as a no-op: `data.k = v;
delete data.k` still issues the remove (the fold does not show k yet, but k
is not absent). No opt-in: the user chose "only a server owning and writing
should commit" — one rule everywhere, no role or per-write flag.
REJECTED: a role-based default (client off, server on) behind an
`optimistic:` opt-in — a server's forwarded write has the same ghost, and a
flag that changes what `data` means per process is the shape-by-delivery-state
V3-18 banned; keeping the overlay ENTRY without the value (foreign commits
would hide under a stale fold — worse than either policy); a per-write option
(plain assignment has no option slot).
Consequences: a client reads the old value until the echo (`snapshot` too);
`await methods.update()` resolves on commit, by which time the value is
visible; a client's tap fires once per own write (the echo), not twice; the
IDEAS "overlay flicker" item loses its premise (the zero-RTT HELLO
advertisement is now only the latency of the answer); DESIGN-M6 C6's "no
optimistic echo for non-held partitions" (never implemented) is the universal
rule. Amends V3-9's consequence line and V3-18 (pending rows: still
cluster.writes only). Kernel and wire untouched; the issue path does one apply
fewer per record. Examples: 02's "shows now and again as its echo" wording and
the check's optimistic-copy comment are gone (the watcher's count is a
round-trip proof too). Tests: api/data.test.ts (the forwarded-write pin
INVERTED — not visible, a foreign commit projects, the echo settles; the
delete-in-flight pin; a CLIENT-role binding pin — WNACK invisible, echo
visible), api/index.test.ts (the three client pins inverted: nothing shows,
refused is invisible, the echo paints). Battery: 399/399 + 18/18 + perf 41/41.

## V4-8 — the clean stop on Ctrl-C is built in; the cluster view folds in one batch (2026-09-14)
Context: the user found the first two examples "a little bit overwhelming" —
the code, the comments and the READMEs — and asked for the most minimal, fun
version, one that scales down as well as up, and for a look at what
examples/lib.ts's helpers were doing and whether fero itself should be
improved to make them unnecessary. Four of the nine helpers had leaked into
the role files (the lesson): `onExit`, `ticks`, `coalesce`, `logChanges`.
Two of them were fero's fault. `onExit` existed because a fero process never
ends on its own (the shell's timers and sockets are ref'd on purpose) and
because Ctrl-C without a handler is a CRASH as the cluster sees it — no
leave (V4-6), so a two-member cluster wedged on the most natural gesture a
reader makes. `coalesce` existed because the composer's cluster fold set
`epoch`, `writable`, `members`, `peers` one record at a time, and data's bare
tap fires per record, so a render loop inside the tap saw a half-updated
view (`epoch 1, members 0`). `ticks` was test plumbing leaking into the
lesson (a role bounding itself so a check could wait for it). `logChanges`
hid repeated lines whose real sources were the per-field fold and the
confirm ring. Verified by experiment: data's `batch(fn)` lands every set
inside fn as ONE commit and a parameterless tap fires once per batch; a
same-value primitive set fires nothing, an equal-but-new object fires.
Decision:
- **Ctrl-C / SIGTERM is a clean stop, built in.** The composer keeps a
  registry of live instances and ONE listener per signal for the whole
  module, installed by the first live instance and removed by the last (a
  process with no live instance keeps Node's default). On a signal every
  live instance `destroy()`s — the graceful leave by ballot, then the
  teardown — and then, if nothing else in the process listens for that
  signal, the process exits 0: a clean stop is a clean exit. If the host app
  has its own listener, fero still leaves and tears down but leaves the exit
  to that listener (Node semantics: any listener disables the default).
  `signals: false` (a new config key, `api/types.ts`) keeps an instance out
  of the registry. `destroy()` is idempotent (the handler and the owner's own
  destroy may race; the second call joins the first), and the diagnostics
  `crash()` door untracks too. The `#directory` system instance is owned by
  its host and never tracked. Pinned by three composer tests, including a
  real child process holding a member with NO signal code that gets SIGINT,
  leaves, and exits 0 while the survivor is alone and writable — the
  six-line `node server.ts` a reader writes.
- **The cluster view folds in one batch, and only what moved is set.** The
  fold's FOLD branch and the partitions row now land inside data's `batch()`
  (re-exported by api/substrate.ts — the ONE seam grows by one named import,
  nothing else touches data), so a bare `cluster.tap(() => …)` fires once
  per fold with the whole picture landed. `members`, `peers` and the
  partitions row are compared by signature before they are set (an
  equal-but-new object would fire), so a refold that changed nothing —
  `identified`, `linkDown`, `start` — fires nothing. Cost: a short string
  build per membership event (rare) and a nine-field compare per partitions
  recompute; nothing on the write path. Pinned: no half-updated picture ever,
  and a settled view fires nothing more.
- **What still fires, honestly.** `cluster.writes` (the confirm ring) lives
  in the same view and changes on every write outcome (pending, then
  committed), so a bare cluster tap on a copy that writes once a second fires
  about twice a second; `cluster.me` re-sets on directory events. A client's
  own write shows once, as the owner's echo (V4-7 — no ghost). The examples
  render from the DATA tap and read the member count there.
REJECTED: exiting with the conventional 130/143 instead of 0 (the stop was
clean; the examples' checks and a reader's shell script both want 0);
installing the listener only when no other listener exists at fero() time
(order-dependent, invisible); a per-process opt-out spelling (`signals:
false` per instance composes: no tracked instance, no listener); moving
`writes` out of the cluster view to quiet the tap (an API change rung 03
depends on — deferred, an IDEAS line); an echo skip for a client's own write
(built and mutation-checked in this session — Pending kept the issued value
and the join branch skipped an equal echo — then DROPPED: V4-7, no ghost,
landed underneath it and removed the second apply at the source, so the
skip would have hidden a client's only apply).
The examples decision that came with this is recorded below.
- **The examples carry no plumbing (the same day).** Rungs 01 and 02 were
  rebuilt at the smallest honest size — a design panel of three angles
  (fewest lines, most fun to run, README-first), two skeptics per proposal
  running and mutating each, then one synthesis. 01/server.ts is eight lines
  of code: `fero('hello', { server: true })`, one data tap that prints
  `pid … members N writable B` and the object, a one-second timer writing
  `f.data[process.pid] = { ticks }`. 02's shop and watcher are nine and eight:
  a seed, one tap that clears the screen and prints a header (the port, the
  watcher count; the shop the directory found) and the object, one timer. No
  cluster tap anywhere (the confirm ring would repaint it), no renderer, no
  dedupe, no tick bound, no exit hook: fero does those. Rows are keyed by
  `process.pid`, so a second terminal's row appears in the first and a
  check reads each role's row by `child.pid`. The checks stop roles with
  Ctrl-C through lib's `stop()`, which SIGKILLs after five seconds and
  returns null so a broken clean stop FAILS a check instead of hanging it
  (a skeptic hung one); a check's own Ctrl-C forwards SIGTERM to its roles.
  lib.ts kept four helpers, all check-only: `until`, `sleep`,
  `privateDirectory`, `spawnRole`. Gone: `onExit` (fero), `coalesce` (fero),
  `ticks` (the check stops roles), `logChanges` (V4-7: one apply per write),
  `story` (the exit hook), and 02's demo-ui.ts. READMEs are under fifty
  lines: the run lines, one real screen, five bullets, a "scale it" list
  (down to one copy; up to three, a client, `dir`), a "next" line. The
  skeptics' corrections folded in: a `kill -9`'d third copy is voted out
  after ~20 s (the redial chain), not "a few seconds"; `dir` brings a node
  back as itself on a FRESH port (no listen is persisted); a joining copy
  prints `members 1 writable false` for a moment; a memory-only copy alone
  forgets everything; two seeded servers would fight over one row.

## V4-9 — fero.spawn: the other terminal, from code; a check meets the box (2026-09-19)
Context: the owner asked why every check called `privateDirectory()` —
"to not overlap with a similarly named resource? can just prefix resource
name in that case, but even that is not needed here as just examples,
shorter is better" — and suggested `fero.spawn` as a built-in for starting
a role as a separate process. The private directory was never about names:
a check's roles meet the box directory like anything else, so a check run
by hand while the same example was open in the owner's terminals joined
them, its counts never held, and the terminals watched strangers arrive
and die. A name prefix could not have fixed that (the roles are the lesson
and carry no plumbing, so a check cannot rename them), and nine lines of
socket code in lib.ts was the price of running a check with terminals up.
Decision:
- **A check meets the box.** `privateDirectory()` is gone. By hand,
  `node check.ts` runs on the box directory and the README says to close
  the terminals of that example first; inside `npm test` the smoke tier
  passes every check its own free port, as it always did (the call was a
  no-op there).
- **`fero.spawn(file, args?)` is public** (api/spawn.ts; the handle type
  is `Spawned`). It runs `node <file> …` as a separate process — the file
  resolves as the terminal would, against the cwd — and returns `{ pid,
  out, exited, stop, child }`: `out` is the stdout so far, `exited` the
  exit code, `stop()` the reader's Ctrl-C (SIGINT; a fero process leaves
  by ballot and exits 0, V4-8) that gives up after five seconds (SIGKILL,
  null) so a broken clean stop FAILS a caller instead of hanging it, and
  `child` Node's handle for the rest. stdout and stderr are echoed
  prefixed `[name pid]` so two copies of one file tell apart. A spawned
  child is tracked in the same registry as a live instance (moved to
  api/signals.ts, generic over anything with a `destroy()`): the parent's
  own Ctrl-C stops its children and waits for them before exiting 0, and
  a parent that dies on an error — a thrown assertion — SIGKILLs them on
  'exit' (the loop is gone; there is nothing left to wait with; a
  SIGKILLed parent runs nothing and orphans them, which is why the smoke
  tier kills its whole process group itself). This is
  the other half of V4-8: fero built the clean stop in, so the thing that
  sends it and waits for it is fero's too.
- **A stop untracks when it SETTLES (a V4-8 amendment).** `destroy()`
  untracked the instance at its start, so for the whole leave — a ballot
  round trip — the last instance's process had Node's default disposition
  back, and a second SIGINT killed it by signal mid-leave: a crash, the
  thing V4-6 and V4-8 exist to avoid. `fero.spawn` made that reachable from
  ONE keystroke: a terminal's Ctrl-C reaches a spawned child twice, from
  the tty (the foreground group) and from its parent's `stop()`. Found by
  the review panel and reproduced by its verifier with a real process
  group. Now `stopping = rt.leave().then(teardown).finally(() =>
  untrack(inst))`: the listener stays for the leave and a second signal
  joins it (destroy() is idempotent; a second `process.exit(0)` is a
  no-op). The trade, taken knowingly: a second Ctrl-C no longer force-quits
  mid-leave — the leave is capped in the shell and SIGKILL remains the hard
  escape, which `stop()`'s own grace sends. The diagnostics `crash()` door
  still untracks at once: it means a crash. Pinned: a spawned member gets a
  second SIGINT 20 ms into its stop and still leaves by ballot and exits 0.
- **lib.ts is `until` and `sleep`.** `spawnRole` and `privateDirectory`
  are gone with the process plumbing; a check is `fero.spawn`, `until`,
  `assert`. Pinned by three tests over real processes (api/spawn.test.ts):
  the member that leaves and exits 0 through `stop()`; the child that
  ignores SIGINT and is SIGKILLed after the grace (null); a parent whose
  Ctrl-C stops its child, WAITS for its child's own stop, and exits 0, and
  whose thrown error takes the child with it, the echo prefixed
  `[idle <pid>]` and stderr kept out of `out`.
REJECTED: a `{ grace }` option (one number, one rule; a test eats the five
seconds); variadic args or a command-line string (`spawn(file, args?)`
mirrors Node's own); resolving the file against the calling script instead
of the cwd (two rules to explain; the README already says `cd` into the
folder and the smoke tier sets cwd); detached children (a terminal's
Ctrl-C must reach them directly); SIGINT instead of SIGKILL on the parent's
'exit' (a child whose clean stop wedged would outlive its check as an
orphan on the box directory); keeping `privateDirectory()` behind an
option; a resource-name prefix per check (the roles carry no plumbing).

## V4-10 — one config door: a flag, the call, the environment, a file (2026-09-19)
Context: the call was the only way to configure a resource. The one
exception was `FERO_RENDEZVOUS`, read by hand in api/directory.ts. So a
role file could not be turned into a server from the shell, a check could
not point two copies at two dirs without editing code, and the examples'
"scale it" lines had to say "change the file". The owner asked for a config
study (DESIGN-CONFIG.md, 2026-09-15: a 26-agent audit, 401 parameter rows
checked against file and line) and then decided the open points: the
owner's own `copts` module is published on npm as `optcascade` 1.0.0; keys
are nested lowercase words, not camelCase; there is a pre-check layer that
validates and coerces; scoping is per resource name; and copt itself may
be amended. The audit had found four problems with a naive wiring, each
fixed below: an env variable cannot reach a camelCase key
(`FERO_HEARTBEATMS` arrived as a NEW key beside `heartbeatMs`); an
undeclared `FERO_*` name leaks through the prefix and would break every
`fero()` in that shell; some spellings arrive as the wrong type
(`FERO_HOSTS=a,b` is a string, `FERO_SIGNALS=0` a number); and the file
layer has a cost (~0.7 ms per resolve on a 9p mount) and a reach (a
`fero.opt.ts` in `$HOME` reaches the whole test battery).
Decision:
- **One door, one seam.** `api/config.ts` is the ONLY importer of
  `optcascade`. Its `resolveConfig(name, call)` runs once per public
  `fero()`, before the composer's own checks, and hands back the folded
  config plus `from(key)` — the layer a value came from. Three optcascade
  reads per resolve (flags, env, files), each with the other two sources
  emptied, so every value has exactly one origin and a message can name
  it. The composer appends that origin to every refusal (`at(key)`):
  "server must be true or false (from FERO_SERVER)".
- **Nested lowercase keys.** `heartbeat.ms`, `redial.ms`, `journal.cap`
  replace `heartbeatMs`, `redialMs`, `journalCap`. In the call that is
  `heartbeat: { ms: 250 }`; as a flag `--fero.heartbeat.ms 250`; in the
  environment `FERO_HEARTBEAT_MS=250`; in a file the object itself. One
  spelling survives every layer because env keys are lowercased and split
  on `_`, flags nest on `.`, and a file is an object. The old spellings are
  REFUSED with the pointer, from every layer (`'heartbeatMs' is spelled
  heartbeat: { ms } since V4-10 — …`). BREAKING within 4.x, the V4-3 rule:
  a rename that would otherwise be a silent second key is worse than a
  loud one.
- **Precedence: `--fero.<key>` > the call > `FERO_<KEY>` > the project
  `fero.opt.ts|js` (the nearest package.json directory at or above cwd) >
  `$HOME/fero.opt.ts|js` > the default.** The flag above the call is the
  ONE new rung (V4-3 settled only key > env > constant). It lets an
  operator flip a process's role or dir from the command line without
  touching the file — `node server.ts --fero.dir ./a`. Inside every layer
  the name rung beats the global one. Arrays and objects replace whole;
  `''` in a string layer means unset and the fold keeps looking down.
- **The per-resource rung, and its one softening.** `--fero.shop.dir`,
  `FERO_SHOP_DIR`, `{ shop: { dir } }` reach only `fero('shop')`, so two
  resources in one process get two dirs from one shell. The rung's key is
  the name lowercased, when it can be spelled in every layer
  (`[a-z0-9]+`: env cannot carry a dash, and `_` is the separator) and does
  not collide with a declared top-level key (`fero('journal')` would read
  the group); otherwise the resource has the global rung only. Because the
  global rung of a string layer now legitimately holds OTHER resources'
  subtrees, an undeclared OBJECT at its top level is left alone — sibling
  names one edit apart included (`order` beside `orders`, `shop1` beside
  `shop2`: the normal way to run several instances) — unless it is a near
  miss (edit distance ≤ 2) of a declared GROUP, the only declared keys
  that hold objects (`heartbeats` beside `heartbeat` is a typo and throws,
  hinting the group's leaf). A misspelt resource name in a scoped variable
  therefore sets nothing; `diag(f).config()` shows what was read. Every
  other unknown key throws naming its spelling in that layer, with the
  nearest declared LEAF as the hint (a group hints its leaf, so the hint is
  always settable). The call is walked by the same code, so a typo in code
  and a typo in a shell get the same message; a dotted key in the call or a
  file (`{ 'heartbeat.ms': 1 }`) is refused as the flat spelling of a
  nested key. The schema tables are null-prototype: a key named
  `constructor` is unknown, never a crash. A flag's key is read lowercased
  at every depth, as a variable's is: `--fero.Dir`, `--FERO.dir` and
  `FERO_DIR` are one key (optcascade 1.1.0 does this; fero pins `^1.1.0`.
  Under 1.0.0 `--FERO.dir` was parsed under another prefix and silently
  ignored, so the landing refused it; 2026-09-21 lifted that with the pin).
- **Coercions for the string layers only.** A flag, a variable and a file
  can only carry text, so they get the spellings text needs: `hosts`
  `a:1,b:2` splits on commas (and a repeated flag flattens); `off`, `false`
  and `0` are `false` for `rendezvous` and `listen`; `server` takes
  `1/true/0/false`; a `uuid` or `dir` that arrives as a NUMBER is refused
  (an all-digit value loses its leading zeros — give it a letter, or set it
  in the call); an EMPTY string from any string layer means unset and the
  fold keeps looking down (a templated `FERO_DIR=` in a container is not a
  refusal); a raw minimist failure is rethrown with the fero prefix naming
  the launch flags. The call is typed and means what it says: `server: 1` or a
  CSV `hosts` string IN THE CALL is refused by the composer, not coerced.
  The numeric keys get a shape check in the composer (`heartbeat.ms` a
  finite number ≥ 0, `redial.ms` ≥ 0, `journal.cap` an integer ≥ 1)
  because a string layer can now carry `abc`, and `('abc' ?? 0) > 0` in
  the kernel would silently turn heartbeats off.
- **Which layer may carry which key (the carriers table).** `methods`,
  `seams.validation` and `signals` are the CALL's alone: the first two are
  functions, and `methods` is also the door (V4-5) — a resource closes from
  the source line that hosts it, never from a shell; `signals` is
  per instance, never per process (V4-8). `data` rides the call or a file
  (an object of rows). `uuid` rides a flag, the call or a variable — never
  a file: one shared file would give every process the same identity.
  Everything else rides all four. A key from a layer that may not carry
  it throws naming both.
- **`server: false` is the client pin, from any layer.** With the layers,
  a server marker can now arrive from a flag, a variable or a file. A
  process that means to follow says `server: false`, and any marker
  (`listen`, `dir`, `replicas`, `data`, `methods`) then throws naming the
  pin's source and the marker's: `server: false pins the client role, but
  'dir' makes a server (from --fero.dir) — drop one`. The pin is STICKY:
  `server: true` from a higher rung (`--fero.server` over the call's false)
  is refused the same way, so a following process cannot be flipped by a
  stray flag. Closes the IDEAS `client: true` line: the pin is the false
  side of the key that exists.
- **`FERO_CONFIG=off` and `utils/battery.ts`.** `off` means the call
  alone, with ZERO optcascade calls — no argv parse, no env walk, no
  filesystem probe — so the battery is deterministic on any box and no
  `fero.opt.ts` in a checkout or a home directory can reach a test.
  `utils/battery.ts` sets `FERO_RENDEZVOUS = 'off'` and
  `FERO_CONFIG = 'off'` (plain assignment — the pins win over whatever the
  parent shell exports, as the old npm script's `FERO_RENDEZVOUS=off`
  prefix did; a suite that wants a value sets it after the import, inside
  its tests); every suite that composes a real `fero()`
  imports it FIRST, and the npm `test`/`perf`/`perf:alloc` scripts pass
  it as `--import`, so a single-file `node --test` and the whole battery
  run under the same two pins. The layer's own suites inject their
  sources (`api/config.test.ts`, 13 cases) or spawn children with
  `FERO_CONFIG` DELETED (`tests/config.test.ts`, over real processes: a
  project file sets `listen`, a flag beats it, a flag alone makes a server
  and the WAL lands in its dir, two resources get two dirs, a `$HOME` file
  reaches a process and the project file beats it, every refusal names its
  source, the sticky client pin, the door's defaults, and `off` in a real
  process). Three guards: the checkout holds no `fero.opt.*`, the tracked
  `package-lock.json` pins `optcascade` as the one dependency, and README's
  Configuration section names every declared leaf (the docs drift gate).
- **The first npm dependency.** `optcascade ^1.0.0` in `dependencies`,
  `package-lock.json` tracked, `engines.node >= 22.18` (a `.ts` config
  file loads through `require()` with type stripping). `npm install` once
  after a clone is now a step (README, examples/README, CLAUDE.md say so);
  nothing else changes (still source-served, no build). Cost: ~30 µs per resolve with injected
  sources, ~3 µs with the layer off, pinned as tripwires
  (`api/config.perf.ts`: 1000 resolves under 500 ms / 100 ms — wide on
  purpose for WSL2, never to be widened). The file walk is memoized per
  `(cwd, home)` for the life of the process. Construction only; nothing
  on the write path.
- **System resources bypass the layer.** The `#directory` client and host
  get the explicit opts the composer hands them, so a `FERO_LISTEN` in the
  shell never touches the directory's listen (api/directory.test.ts
  untouched and green).
- **`diag(f).config()`.** The Symbol door returns every resolved leaf as
  `{ value, from }` — the coerced value the composer read and the layer it
  came from, or the effective default (`heartbeat.ms` 500, `redial.ms`
  100, `journal.cap` 4096, the rendezvous) as `'the default'`; a function
  shows as `'[function]'`, the hosted methods and the data seed as their
  names (rows are data, not config). The answer to "why is this node a
  server?" without a debugger.
REJECTED: camelCase keys with a case-fold (`FERO_HEARTBEATMS` folded onto
`heartbeatMs`: one more rule per layer, readable in none of them, and a
fold hides a typo); silently ignoring unknown `FERO_*` names (a misspelt
variable would set nothing and say nothing — the call's "typos throw" rule
holds in every layer; the object-subtree skip is the one bounded
exception, and a near miss still throws); a `file:` link to the sibling
copt checkout (a link makes `npm install` fail for anyone without the
sibling; the published name settles it); vendoring optcascade into
`utils/` (a fork with no upstream); exposing the kernel constants now
(`MAX_REDIALS`, `SUSPECT_TICKS`, `LEAVE_TICKS` …: hot read sites, needs an
interleaved A/B on the write/node/alloc pins — its own series, IDEAS);
per-name scoping through a separate prefix (`FERO_SHOP__DIR`,
`optcascade('fero-shop')`: a second vocabulary, and a file would need two
top-level shapes — the name is a key under the same prefix, one rule in
every layer); throwing on a near miss of the resource NAME (the review
showed `order`/`orders`, `cart`/`card`, `shop1`/`shop2` refusing each
other, and a resource named `host` refusing its own rung as a typo of
`hosts` — a sibling one edit away is normal, a group one edit away is
not); coercing the call (`server: 1` in code was a pinned refusal, and a
typed call should mean what it says); a `diag` key in this landing (its natural env shorthand
`FERO_DIAG_TOKEN` is the viewer's variable already).
Consequences: the review's 26 findings (four lenses) are folded in above.
A role file stays bare and the shell does the scaling
(`FERO_DIR=./a node server.ts`, `--fero.dir ./b`); the examples' index
says so. Every `heartbeatMs`/`redialMs`/`journalCap` in the tree moved to
the nested spelling (seven suites, the directory's two system composes,
the types banner); a caller on 4.0 gets a pointer, not a silent default.
`FeroConfig.server` is `boolean`. A stray `FERO_*` variable in a shell is
now a loud stop for every `fero()` there, on purpose, unless it is another
resource's subtree. A `$HOME/fero.opt.ts` reaches every fero process of
that user on the box, so it must never name a routable `listen` or
`rendezvous` (the V4-3 loopback posture is the file's too). The battery's
two pins live in one file now and win over the shell; a suite that wants
a value sets it inside its tests.
Not in this landing: the kernel tune table (`MAX_REDIALS` and friends stay
constants; IDEAS); the `diag` key (`diag.allow` is still unreachable from
the public `fero()`; IDEAS); a HELLO-carried hash of the cluster-contract
keys (`heartbeat.ms`, `replicas`, `seams.validation`) — today a mismatch
set by one member's shell shows up as behavior, not as a refusal (IDEAS).
Battery: 431/431 + 18/18 contract + perf 43/43.

## V4-11 — the example series' shape: a README is the terminals, a screen is one line or one frame; rung 03 (2026-09-20)
Context: the owner asked for "refining and better options for the readme
and also the output", then one more example. A design panel (three
proposals, each attacked by an owner's-taste skeptic against the owner's
own old README and the V4-8 bar; the "does it work" skeptics died on the
model cap, so the synthesis re-ran every claim itself on private ports)
produced one template and one screen rule. Both were applied to 01 and
02, and rung 03 was built in that shape.
Decision:
- **The README template, for every rung.** A title; one code block per
  terminal — the command you type is the block's FIRST line, then the real
  output of one contiguous run, `^C` at column 0 where it was pressed; at
  most three bullets for what the screen cannot show; a `sh` block of
  runnable scale-it commands (`node server.ts --fero.dir ./a` is where
  V4-10 earns its place); the check as one sentence at the end; `Next:`.
  No separate run block (the command is already the output block's first
  line), no right-hand arrows (invisible past a phone's ~45-character cut;
  `$ node server.ts` and `^C` at column 0 say the same thing). The caveat
  "close your other terminals of this example first" is said once, in
  examples/README.md, and in each check's first assertion message — where
  a reader who forgot will actually look.
- **The screen rule, two shapes for one reason.** A rung whose lesson is a
  SEQUENCE logs one line per change with no clear (01: copies come and
  go; the terminal keeps the history, the README can paste it, the check
  reads the last line). A rung whose lesson is a LIVE PICTURE redraws a
  frame after `console.clear()`: a header line beginning with the role
  word in CAPS, then the object (02: `SHOP` / `WATCHER`; 03: `CLIENT` /
  `SERVER`). The role word is the frame delimiter a check and the site
  recorder split on. Every screen names its process (`pid`); where wire
  identity is the lesson it names its fero id too (`me`). No line wraps
  at 80 columns.
- **01 prints `pid` once, then `members N <object>`.** Rows are numbers
  (`f.data[process.pid] = ++n`): three rows fit one line, five rows in 68
  characters, where `{ ticks: n }` wrapped at three. `writable` left the
  line: it never printed `false` in 01's story — a `kill -9` survivor's
  screen freezes entirely for 8-12 s (its own writes do not commit, so the
  data tap never fires), so the old bullet "its own ticks still print" was
  wrong and the word carried a case the reader cannot see. The pid moved
  off every line so two terminals print the IDENTICAL line for the same
  state (that is the lesson) and the spawn tag does not repeat it. The
  check's `writable false` assertion went with it: `members 1` within 5 s
  IS the clean-leave proof (a crash leaves A at `members 2`).
- **02 loses the `fero two-terminal demo — ` prefix and gains its pid.**
  The prefix existed only so the site's recorder could split frames — and
  the page stripped it before painting, so it bought nothing; a lesson
  file carried a tool's delimiter, the very thing V4-8 cleared out of the
  roles; on a phone it ate 25 of ~45 visible characters. The site's
  recorder, page and checker now split and paint on the role word, and the
  demo was re-recorded in the same sitting (the half step — new source
  beside an old recording — is caught by nothing automated).
- **03-one-write: a client's write is a request.** `client.ts` (10 lines)
  renders from a CLUSTER tap on purpose, against the 01/02 data-tap rule:
  a pending write changes nothing in `data` (V4-7), so a data tap could
  never draw the waiting state, and the confirm ring IS this rung's
  lesson — the last three rows of `cluster.writes` as `<key> <state> by
  <origin>`, then the object. `server.ts` (6 lines) writes nothing: it
  stamps and shows. Verified and pinned by the check: a client alone keeps
  every assignment `pending` — no timeout, no reject, `{}`; when a server
  appears every waiting row commits in ONE fold, `origin` = the SERVER's
  id, and the data lands in the same frame; Ctrl-C the server and the next
  notes wait again; the next server (new id, new port) stamps them, and
  the client takes its truth — the notes the old memory-only server held
  vanish from both screens. Facts kept out of the screen: `hosts` keeps
  the OLD address after a clean leave until the next server registers
  (screens use `peers`); a durable server's second life stamps as
  `uuid~2`; with a server up a new write is pending for 1-41 ms (a blink).
- **api/spawn.ts is unchanged.** Silencing the child's echo and printing
  story lines was the panel's most tempting idea and is wrong: the echo is
  the ONLY failure evidence the smoke tier has (its 12-line tail on a
  failed check IS the last screens), and the quiet mode costs zero code by
  hand — `node check.ts | tail -1`. What made the echo unreadable was the
  screen, not the echo: 01's check now prints 21 one-line screens.
REJECTED: story lines instead of the echo (above); `pid` on every 01 line;
`writable` on the line; `{ ticks: n }` rows; `console.clear()` frames for
01 (a frame erases a sequence); right-hand arrows; a separate `sh` run
block above the output; the caveat on the check line; a fast-fail so the
caveat fires in 2 s (two lines to save 28 seconds of an already-failing
run); `privateDirectory()` or name prefixes (V4-9, not reopened); a
log-style 03 client (a batch commits in ONE fold, so a log prints one line
for four transitions); `console.table` for the ring (61-80 columns, a
dead index column, triple quoting); `cid`/`seq`/`epoch` on the row (three
more words; at epoch 0 `cid` is 1 for every own write); all 64 ring rows
(a 64-line screen in two minutes — the "scale down" half of the ask);
one 03 file with the role from a flag (that is 01's lesson; kept as 03's
scale-it line); a `hosts`/`links` field in 03's header (stale after a
leave); a fourth pasted 03 frame; `methods.update` with its timeout reject
(rung 10's awaited form); a shared `screen()` helper in lib.ts (01 reads a
line, 03 reads a frame — one helper would drag screen shapes into shared
glue); keeping 02's prefix "for the site" (the site strips it).

## V4-12 — the series is complete: the capstone and the four apps (2026-09-28)
Context: the owner asked to "finish off the examples series". Rungs 01-23
were committed by 2026-09-22 (04-23 in eighteen commits that day, with no
ledger line — this entry is theirs too); 30 and 40-43 had been built by one
agent each against the V4-11 brief, attacked by a skeptic (two re-runs,
every README claim against the source, a mutation of its own), fixed, and
left staged in a landing worktree. Before landing, each was attacked once
more at HEAD; five verifiers checked every wart the builders had noted
across the four phases against the source before it was filed; a critic
asked what was still missing. The final skeptics found three things the
first round had not: the capstone's clean stop hung under load (a real
shell bug, fixed in 717441e — ISSUES I-21), its prune audit counted rows
instead of checking what survived, and 40's check never ran the file the
reader opens. The two heavier checks were then timed on this box's 9p
mount, where `npm test` runs, not the tmpfs the builders used.
Decision:
- **A story file is a driver, not a role.** 30's `fleet.ts` (89 lines)
  spawns the members, the sensors and the clock, kills and restarts them,
  and prints the audit — it is the reader's `node fleet.ts`, but it is the
  thing that RUNS the roles, so the role-file bar (≤ ~10 code lines, no
  plumbing) does not apply to it; it imports node built-ins and the api
  only, every wait in it is loud (`stuck: …`) so the audit can never pass on
  a fleet that never formed, and it wipes only its own three `fleet-<port>`
  dirs (a folder-wide wipe clobbered a concurrent story's live WAL dirs).
  `member.ts`, `sensor.ts` and `dashboard.ts` stay roles. 22's `story.ts`
  was the precedent. Its README's first block is a run-once output cut to
  the lines that matter, with the `…` that were really there (nine of
  them), because a contiguous 60 s transcript is 200 lines.
- **An app may run past ten lines; the bar otherwise stands.** 40-43 run
  12-51 lines per file because a chat, a board, a bridge and a ledger are
  more than one lesson; every line still has to earn its place: a comment
  is one line above the block, four-space indent, no `//!`, one import from
  the api, a folder-local `./rules.ts` allowed (41). A check may run to ~47
  lines (43) where the story has five terminals, and a README to 77 (30),
  66 (43), 61 (41), 54 (40), 50 (42) — every line real output or an
  assertion. The ladder's ~10 / ~28 / ~55 bars are unchanged.
- **The check runs the file the reader runs.** 40's first check drove two
  scripted bots and never started `join.ts`; a reversed comparator in the
  reader's own screen passed. Now the check spawns `join.ts` as a watcher
  too (fero.spawn closes its stdin, so it only draws) and pins its screen
  equal to a bot's. A check that cannot type into a role (spawn has no
  stdin — IDEAS) may add a scripted role, but it must still run every file
  a README names.
- **An audit checks what survived, not how many.** 30's prune audit
  compared counts, so a prune that deleted the NEWEST facts passed; it now
  keeps the cutoff and asserts every surviving row on every member is newer
  than it. The mutation that flips the comparison fails at `audit prune
  passed`.
- **41 is an OPEN server with one shared rule.** The plan had a `move`
  METHOD beside plain leaf writes; under V4-5 `methods:` is the door and
  would refuse every editor's write `methods-only`. So the board declares no
  methods, carries `seams: { validation: rules }`, and every editor imports
  the same `rules.ts`: a whole row is refused ("this board writes fields,
  never whole rows"), a status that names no column is refused ("unknown
  column") — by the editor itself before the write leaves, by the board for
  a client that carries no rule. 08's rule of thumb holds: a rule about what
  a record may LOOK like is a seam; a rule a caller must HEAR is thrown
  from a method.
- **30's audit has no read-your-writes check.** The plan's RYW line assumed
  an optimistic copy; V4-7 has none, so a client's own write shows only as
  the server's echo. The audit keeps convergence, durability of every
  `persisted` receipt, no phantoms, the unproven receipts counted and landed
  ("a reject is not a rollback") and `prune` last. `dropped` left the
  receipt classes (MAX_PENDING is 1024; a fact a second never nears it); the
  random chaos loop became `node fleet.ts 120` (the same schedule, then
  quiet facts); the chaos log prints whole seconds — the numbers the reader
  needs are the receipts' latencies on the sensor lines.
- **43's genesis is the mint.** No seed (a seed row is a whole row the
  notifier never sees land): `transfer` lets `mint` alone go below zero, so
  `node teller.ts mint alice 100` is the first row and the balances always
  sum to zero. The rule is best-effort on the ONE member the teller reached
  — two tellers at once can both pass it (17's lesson, said in the README).
  `await ctx.flush()` before `return id` was dropped: flush-on-return
  (api/methods.ts) already holds the reply until the write settles.
- **40's tiebreak is `localeCompare` on `from`.** The plan's `(a.from <
  b.from ? -1 : 1)` is not symmetric on equal ids; `a.at - b.at ||
  a.from.localeCompare(b.from)` is a total order, so every joiner's screen
  is a function of the rows alone. The server orders nothing. The plan's
  `talkers` histogram and presence rows are gone (the reap predicate orphans
  presence rows when the server that handled `hello` dies).
- **No separate slow tier and no `test:examples` script.** The plan put 13,
  14, 30 and 43 behind a skipped tier; a skipped tier rots. Every check runs
  inside `npm test` under a per-rung budget measured on this box's 9p mount
  (30: 100 s for a ~34 s story of fixed sleeps; 43: 60 s for ~13 s, 13's
  ratio; the rest under the 40 s default). 30's first wait widened from the
  10 s default to 30 s, as 13's and 14's already were: on 9p under load the
  dashboard's first frame took longer than 10 s.
- **The warts go to the ledgers, verified.** Every wart the builders noted
  (phases 1-4, forty-odd lines) was checked against HEAD by a verifier, with
  a probe where one was cheap, before it was written: nineteen became ISSUES
  I-22…I-40 (kernel membership and ring, the write surface and methods, the
  cluster view, the directory, the config layer, the shell, two in data, two
  in the viewer), one was fixed on the spot (I-21), twenty-five became IDEAS
  lines in their workstreams, and twelve were dropped as already filed,
  unreproducible or plain facts.
REJECTED: a `move` method on 41 beside plain writes (the door); presence
rows in 40; a `dropped` receipt class and a seeded random chaos loop in 30;
`writable` on 30's dashboard (on a CLIENT it is `true` at epoch 0 and
`false` once it holds a view — I-33, not a screen); `online N` on 40's room
header (the admitted-link count, refreshed only on a landed message);
renaming 41's `editors N` (02's `watchers` counts peers the same way; the
Peer row carries no role — IDEAS); a `console.log` instead of the throw
when a member's stop hangs in 30 (it would have hidden I-21 from the smoke
tier); a try/finally in every durable check so a FAILING run removes its
dirs (lines in every durable rung for a gitignored leftover — IDEAS,
series-wide); a shared `screen()` in lib.ts (V4-11, not reopened); a JSON
guard on 42's POST (http plumbing, not fero; the curl line shows the
shape); renaming 30's `FLEET` header to `DASHBOARD` (02's `SHOP` is the
precedent for the resource word).

## V4-13 — one ledger: STATUS.md is the page, the records live in docs/, the obvious warts are fixed (2026-09-28)
Context: twelve markdown files sat at the repo root, about 6,250 lines: a README
that was still the v3 milestone diary ("fero v3 — M0…M8"), a STATUS log,
DECISIONS, ISSUES with 40 entries, IDEAS with about 80, the pre-M4 checkpoint
and four design records. The owner asked for them to be consolidated into a
simpler set, "perhaps even just one I need to look at", with the obvious
things fixed along the way so that what is left is only what truly needs a
decision, and written more simply than the ledgers were.
Decision:
- **STATUS.md is the one page.** Five sections: where it stands (the counts,
  the series, the site, no CI); bugs (what happens, where, the fix if known,
  grouped kernel / api / directory-config-shell / data / debugger); worth doing
  (next, someday, by area); decided (one line per V4 decision); history (a
  pointer). Short sentences. A fixed bug leaves the page. The evidence behind
  an open one is one command away: `git show 0055e6e:ISSUES.md`. ISSUES.md and
  IDEAS.md are deleted: two open lists beside one page drift.
- **The records move to docs/**: this file (still append-only), DESIGN-M6,
  DESIGN-M7, DESIGN-DIRECTORY, DESIGN-CONFIG, CHECKPOINT, and a new HISTORY.md
  holding the v4 status log and the v3 milestone diary the README carried.
  Relative links repointed; three source comments and the fold header follow.
- **README.md says what fero is and how to run it**: the shape in one code
  block and eight bullets, the ordering and availability posture, the
  Configuration section verbatim (the docs drift gate and the website's
  claims check anchor to it), the debugger in one paragraph, the testing
  policy, the layout, the record. CLAUDE.md is a third of its old size and
  keeps the four phrases the website's claims check reads.
- **42 warts fixed in one pass**: six agents in six worktrees, one area each,
  every fix with a regression test that was red on the old code, all landed
  under one battery. The ones a user can see:
  - the api: `WriteRejectError` — every write rejection is an Error with a
    stack and a message naming the resource, the verb, the key and the rung
    (`{ ...e }` is still the plain `WriteReject`); two new reject reasons,
    `invalid-key` (an empty key on `update`/`remove`, refused before any
    stamp — it used to kill the process) and `not-durable` (`confirm:
    'persisted'` on a server with no disk anywhere rejects at once instead of
    waiting out the timeout); a lens coerces to its cell (`data.k + 1` is
    k+1 and `data.k++` commits k+1; they used to commit the debug label and
    NaN); a method handle is callable (`h()` is the one-shot promise, so
    `assert.rejects(f.methods.x())` works); every `hosts` entry is checked as
    an address and the bad one named; `cluster.me.origin` is the bare uuid in
    life 1, as the stamps are, and `me.incarnation` is the life counter;
    `me.primary` names a client's feeder; a Peer row carries `client:
    boolean`; `ctx.peer` on a server-local call is the server's own uuid; a
    subscription's derived view is disposed when the subscription ends (one
    operator node per subscription used to live for ever); "open, then act"
    right after a client's `fero()` shows the delta; Ctrl-C before `fero()`
    resolves is the clean stop too; `fero.spawn(file, args, { stdin: 'pipe'
    })` and `write(line)`; the scoped hint is a recipe that runs; the
    substrate's three long refusals wrap after the dash.
  - the kernel: a spoke never teaches a view (VIEW, PROPOSE, VOTE, JOIN and
    LEAVE on a client link are dropped, a client ships no view, and it adopts
    an equal-epoch view with different members — reborn memory-only members
    used to adopt a client's stale view and never re-form); a hostless static
    listener proposes genesis once one member has dialed it and its uuid is
    lowest (half of all one-sided pairs used to sit at epoch 0 for ever);
    `writeAck` is journaled once per cleared attempt. The 1000-seed sweep
    stays at exactly 237,451 events.
  - directory, config, shell: a cleanly-left server's entry leaves the
    directory at once; a `FERO_*` name that extends a leaf is refused naming
    that name instead of blaming the good variable; a `dir` deleted under a
    running member condemns the store and the leave completes, instead of an
    uncaught ENOENT mid-leave.
  - the debugger: the pages and the banner say v4; a capture file that is not
    there yet is waited for; `differs (in flight)` in amber where a
    divergence cannot be proved; an even split says `split`; the debugger's
    own DIAG link is an `observer`; a reborn writer's own writes replay; a
    torn attach read is named and attach pulls one instant; zero-row kinds
    leave the suggestions; the dashboard's baseline note tells the truth;
    `npm run debug` stops on Ctrl-C.
  - the harness: the rendezvous port is drawn outside the ephemeral range, and
    a failed durable check's port-named WAL dirs are swept.
- **Left on purpose**, on the page: the ring hash (every member must agree
  and the goldens move — its own decision), the n=2 stall across the leave
  window (V4-6's reasons stand), a client's `writable` (needs a rule), a live
  scalar on subscribe (a mirror redesign), the two-cells-per-row projection
  (needs an oracle), the half-typed line under a redraw (a house choice).
REJECTED: keeping ISSUES.md and IDEAS.md beside STATUS.md (two lists drift;
the page is the list); deleting the records (append-only stays append-only,
one directory down); an archive copy of the old ledgers under docs/ (git
history is the archive); a per-bug file or an issue tracker (no remote).
Consequences: three files at the root a reader meets (README, STATUS,
CLAUDE) and a docs/ folder. Battery after the pass: 495 + 18 contract,
perf 43.

## V4-14 — the ring hash is fnv-1a finished with fmix32, and it is part of the wire contract (2026-10-08)
Context: STATUS carried "the ring is skewed" (I-24). Plain fnv-1a ends with
`(h ^ c) * P`, so a member's 32 vnode points (`uuid#0` to `uuid#31`) differ
only in their last characters and land in about four narrow bands. Measured
over 300 random 4-member sets of 8-hex ids (the ids api/index.ts mints), by
exact arc length: the biggest member owned 2.85× its fair share and 160 of
300 sets had a member outside [0.5×, 2×]; over 3000 sets the smallest member
owned 1/39 of fair. The old ledger's "5-7×" described the starved side.
Sequential keys k1..k24 changed owner 4 times (fair is about 18), and one
owner held 17.6 of 24: example 16 showed exactly that. Sim ids n01..n04 spread
fine under plain fnv, which is why no sim test ever caught it.
Decision: kernel/ring.ts `fnv` keeps fnv-1a's loop, then mixes the result
with murmur3's fmix32 (`h ^= h >>> 16; h *= 0x85ebca6b; h ^= h >>> 13;
h *= 0xc2b2ae35; h ^= h >>> 16`). With it: worst member 1.57× (1.79× over
3000 sets), 0 of 300 sets outside [0.5×, 2×], 18.3 owner changes over
k1..k24. Every member must compute the same owner for every key, so this
exact function, VNODES 32 and the `#` separator are part of the wire contract
from this commit; members on different ring hashes in one cluster are
unsupported before 1.0, and nothing polices it yet (the HELLO contract hash,
when it lands, should carry `ring=fmix32`). The state hash in kernel/node.ts
is a separate plain fnv and does not change. Two pins in kernel/ring.test.ts:
a spread pin with hex-shaped ids (50 seeded 4-member sets, 5k keys each, every
member within [0.5×, 2×], no owner holding more than 16 of k1..k24; red on
the old hash, 28 of 200 members outside) and a golden that pins the exact
function (five known values, 2000 inputs against a BigInt reference, the
owners of k1..k12 over four fixed ids), because a weaker mix keeps the spread
pin green while moving every owner. `fnv` is exported only for that test.
Cost: ownerOf is about 50-110 ns slower per 8-char key, flat for 36-char
keys, under 1% of a write; it still allocates nothing; no threshold moved.
REJECTED: more vnodes under plain fnv (the bands come from the hash, not from
too few points); a different whole hash such as xxhash or full murmur3
(fmix32 alone fixes the spread and keeps the integer math); moving the ring
onto the state hash (they were already separate); running both hashes behind
a version switch (there is no 1.0 contract to keep); a golden of owners only
(a weak mix moved 1 owner in 5000).
Consequences: every key's owner moved. Example 16's blocks are re-recorded;
17's second line changed; 20 now waits until both members hold every cell's
last write; 22 renamed its keys to `spot` and `missed`, which hash to the
owners its story needs; sim/exec.test.ts's AE-floor test reads its key's
owner off the real ring. docs/DESIGN-CONFIG.md's frozen row names fmix32.
The advisory baseline row `ring.ownerof-1m` drifts until re-recorded on a
quiet box. site/lib is regenerated.

## V4-15 — the lower uuid opens the admit digest exchange; the formation count re-pins 69,400 → 59,500 (2026-10-08)
Context: STATUS "Next" carried "every admit ships each missing suffix twice".
Both ends opened a digest (r=1) on admit. Each end shipped its missing suffix
when the peer's r=1 arrived, then shipped the same suffix again when the
peer's r=0 reply arrived, because that reply's tails were built before the
first suffix had landed on the FIFO; the receiver dropped the second copy.
Measured: heal probe aeShip 2+2 and dupDrop 1+7; cold formation four digest
frames per pair.
Decision: when two members admit each other, only the one whose uuid sorts
lower sends the opening digest. The higher side ships what the opener's tails
show missing and answers r=0; that answer's tails pull what the higher side
lacks. One exchange heals both ways. The rule asks who sorts lowest, never who
dialed, so it is direction-independent (v2's dialer-gated catch-up trap stays
the counterexample), and it is the rule the heartbeat floor already uses for
PINGs and floor digests, so admit, drain and floor are all single-opener now.
A client still opens to its primary (the single-feeder rule). A server no
longer opens toward a client: the client's own r=1 syncs that link, and no
guarantee a client gives read the dropped frame. View-on-admit still goes
from both ends. After: heal probe aeShip 1+1, dupDrop 0+0; two digest frames
per pair. Accepted trade: under backpressure or a cut between the r=1 and the
r=0, the single opener heals one round trip later than the redundant second
digest sometimes did; every such case still converges on drain or relink, and
one lower-side floor tick heals a lost suffix in either direction. Unchanged:
the dial race (both members dial at once, both raced links admitted before
dupLink hangs one up) makes one side's diary show aeShip twice, about 1 run in
10 in a 200-seed probe; the second ship goes down a dead link and nothing
arrives twice. The count re-pin: sim/scale.perf.ts "100-node formation" moves
69,400 → 59,500 events at seed 0, exactly 2 digest frames × 4,950 pairs;
the pairs ratio, the idle floor 4·25·24, kernel/node.perf.ts's digest-build
pin and the tests/baseline.perf.ts count tier do not move. This is the
deliberate wire change tools/perf/BASELINE.md asks to land with a record and
the re-pin in one change. sim/membership.test.ts "a burned epoch cannot wedge
membership" was re-derived, not weakened: it stepped 200 ms at a time and only
by luck partitioned n01 before its re-proposal landed; it now steps 1 ms to
the grant, asserts both members are still at epoch 1 there, keeps every old
assert, is green on the old kernel, and still fails when the escalation fix
it guards is removed.
REJECTED: remembering the tail already shipped per link (new per-link state
to invalidate on every drop, and it would wrongly skip a re-ship after a
backpressure drop, which the drain path relies on).
Consequences: a join costs its bytes once. examples/21-journal is
re-recorded (each side logs aeShip once, applyInbound once, no dupDrop) and
its bullet names the dial-race shape. Three new kernel tests. The website's
wire card still tells the two-opener story (STATUS, the website).

## V4-16 — the method plane: a live scalar arrives as `{ value }`; a subscription has a `ready` per attempt and an `onError`; a kernel outcome on an assignment fails the call; a plain-value handler keeps its views (2026-10-08)
Context: four holes. (1) A method that returns a live number
(`count: (_, ctx) => ctx.data.count`), or a plain number on the subscribe
leg, streamed root records carrying the bare number; the client's mirror is
a source born an object, data has no source born a number, and the refusal
was swallowed, so `.open()` stayed `{}` for good (I-27). (2) A handler that
threw on the subscribe leg, or whose write was refused, replied ok:false for
the sub's id; the caller looked that id up among its calls only, so the reply
was dropped and every failover re-subscribed into the same failure. (3)
Flush-on-return failed a call only when a validator refused a write; a write
the node itself lost (dropped at queue overflow, superseded, destroyed) or an
owner refused still let the call resolve as if it had happened. (4) A handler
that made a view and returned a plain value leaked that view (the I-29
residue).
Decision 1: on the client, a root record (key [] and no `at`) whose value is
a number, string or boolean becomes a whole-value update of `{ value: v }`
(whole-value, so stale keys drop if a value flips from an object to a
number); a root remove empties the mirror; `at` is the guard, because an
object source's keyed insert is also key [] and carries its key in `at`. The
one-shot call still gives the bare number. REJECTED: building the mirror
from the first record's type (open() hands the mirror out before any record
exists, and data has no scalar-born source); wrapping on the host (two sites
and a wire change for the same result).
Decision 2: a subscription has an eager `ready` promise per ATTEMPT (made
when the sub opens, and again when a primary change re-subscribes a sub that
already had a frame) and an `onError` option. `ready` resolves on that
attempt's first frame, with nothing (the mirror is thenable; resolving with
it would turn it into a snapshot). It rejects with `methods.<m>: <reason>`
when the host fails the sub or the mirror refuses a record (then the client
also unsubscribes). Because it is eager, a failure nobody handles is an
unhandled rejection and stops the process with the handler's message, as
loud as an uncaught call, after a failover too. `methods.feed(arg, {
onError })` hears every failure of a long-lived sub (called in a microtask,
never inside a kernel step) and with it set no failure stops the process;
the directory's own lookup uses it and puts the error on
`cluster.me.rendezvous.error`. A failed sub is dropped and never
re-subscribed; `mode` reads 'failed', `open()` and every read throw the
reason, `close()` does nothing. A ScopedError passes through. A LOCAL
failure (no primary yet, the frame never left) is not a failure: that sub is
held and replayed (I-28), and the local bit decides it. A sub that ends
before its first frame rejects `ready` with `closed` or `destroyed`, marked
handled, so an awaiting caller learns it and a shutdown never stops the
process. Reading `ready` on a closed handle never opens a new sub. `open()`
still returns the raw mirror. REJECTED: a lazy `ready` (the bug itself); one
`ready` for the sub's whole life (a failure after the first frame landed on a
settled promise and was silent); failing reads only (no way to await the
first frame); a second lifetime promise beside `ready`.
Decision 3: an ASSIGNMENT inside a handler that the node did not commit fails
the call with `write dropped|superseded|destroyed (<cell>)`, and one an owner
refused with `write refused (<cell>): <reason>` (semantics A of V4-5: the
reply is true). Only assignments: a write made through methods.* already gave
the handler its own typed reject, and a handler that caught it and recovered
keeps its reply. api/data.ts marks an assignment's promise in a WeakMap, only
inside a handler. REJECTED: the plan's two-line change in settle (every
write's promise sat in the collector, so it overrode a handler's recovery;
the test showed it); keeping kernel outcomes silent.
Decision 4: a handler that returns a plain value KEEPS the views it made; the
I-29 residue stays on the page. Releasing every unhooked view made in the
handler's synchronous window also killed a view it kept on purpose (a lazily
cached module-level `cached ??= ctx.data.filter(…)` built on the first call):
later calls read the frozen first answer, silent stale data, worse than the
leak. In the data graph a dropped view and a kept one look the same, so there
is no safe rule without JS reachability. A returned sum() is now released on
close, like a returned operator. REJECTED: releasing every unhooked view of
the synchronous window; making "keep it by hooking a sink" the user's job;
releasing everything newer than the mark (kills views of calls running at the
same time). The way forward, if wanted: a FinalizationRegistry over the
handles minted inside a handler, its own decision.
Consequences: examples/09's README says a live scalar arrives as `{ value }`;
Directory.start() checks that its client composed as a client and names the
role if not (I-19 stays on the page with a race test); seven new api tests.

## V4-17 — the shell's `start()` always settles; a store whose boot record failed mid-life is condemned on restart (I-36) (2026-10-08)
Context: two shell residues. `Runtime.start()` awaited a promise settled only
by 'listening' or a listen error, so a `destroy()` before the socket was up
left it pending for ever (the composer raced it against the stop and masked
it). And after a boot record (boot.json) failed to land (EIO, EACCES, ENOSPC,
a boot.json.tmp that is a directory) the shell latched the store dead and
voted from memory, but nothing marked the dir: a restart replayed an honest
prefix under a stale votedFor and could vote twice in one epoch. STATUS's
"the existing policy already condemns such a dir on restart" was not backed by
code.
Decision: `start()` always settles. A stop before the listen socket is up, or
a `start()` after `destroy()`, rejects typed `code: 'stopped'` and binds
nothing; a second `start()` rejects typed `code: 'started'` and binds nothing
(it used to leak the first server); whichever of 'listening', 'error' and
'close' fires first settles it and the other listeners are removed. A caller
must await `start()` or attach a handler. The composer treats a 'stopped'
reject during a running stop as the stop path, so `fero()` resolves stopped;
once Ctrl-C has started a stop, a listen error that lands meanwhile also takes
the stop path. For I-36: `boot()`'s catch marks the dir in two best-effort
steps, a `condemned` marker naming the reason, then the unlink of boot.json;
`restoreOpts` refuses a dir holding the marker, and the older rule (a non-
empty wal.log with no boot.json) catches the unlink alone, its message naming
both cases. To start the node again the operator moves the dir aside. The sim
mirrors it: `StoreFault.bootFailP` fails a boot record, the store is marked
condemned and takes no later record, `Sim.restart()` refuses it before
touching anything.
REJECTED: the plan's silent `return` for a `start()` after `destroy()` (every
early-stop case should settle the same way); the unlink alone (a member whose
wal.log is still empty would read as a pristine boot and forget its votedFor);
trusting the stale record.
Consequences: a dir deleted under a running member (the case that found I-36)
can carry no mark, so its next life starts fresh like any wiped dir; neither
mark is fsynced, so a power loss right after the failure can lose both. README
and docs/DESIGN-CONFIG.md name the `condemned` marker. Five new tests
(tests/tcp.test.ts, tests/wal.test.ts, sim/durability.test.ts).

## V4-13 amended — a client follows its feeder's view, even to a lower number (I-23, 2026-10-08)
Context: since 348dfa5 a client adopted a view with the SAME number but other
members (I-23). A LOWER number fell through: when a client had seen epoch 2
and the memory-only members were reborn under fresh uuids at epoch 1, the
client kept the dead ids in its members row for good, because its number was
bigger. The stale number never poisoned a server (a client's attempts carry
ae 0 and `staleObserved` never sees it); the damage was the screen and
`cluster.epoch`.
Decision: a client is a picture of its feeder's cluster, not a vote in it. On
its PRIMARY link, a view whose members differ installs at any epoch of 1 or
more, equal or lower (epoch 0 is open genesis, never a view). Every other
link stays "higher only", so a stale non-primary server cannot teach a stale
row; the old equal-epoch rule from ANY link is gone. A member refuses all of
it: one view per epoch is the safety rule, and a VIEW is not a ballot.
`cluster.epoch` on a client therefore means "my feeder's number", and the
sim's epoch-monotone monitor skips clients (it checks members' numbers only).
REJECTED: resetting the client to epoch 0 when its last member link dies (the
row would flash empty on every redial blip).
Consequences: kernel/client.test.ts pins the primary's lower view adopted and
a non-primary's lower view ignored; sim/client.test.ts's I-23 pin bumps the
spoke to epoch 2 before the kill and expects members [n03, n04] at epoch 1
after the rebirth. The `evict` rows a feeder install journals are harmless:
the debugger's topologyAt does not read them.

## V4-19 — the kernel tune table: one frozen `node.tune`, defaults equal to the old constants (2026-10-08)
Context: MAX_REDIALS, SUSPECT_TICKS, LEAVE_TICKS, the backoff cap and the
queue bounds were constants spread over seven kernel files, with a shell
weld (shell/runtime.ts read LEAVE_TICKS) and a sim monitor reading a kernel
bound. The filed need was a shorter redial chain for a dead member (V4-20),
and docs/DESIGN-CONFIG.md §5 listed these constants as the next config
candidates. A table with one validator and one read idiom is cheaper than a
NodeOpts field per knob.
Decision: every kernel bound and tick count is a row of one frozen object
per node, `node.tune` (kernel/tune.ts: the `Tune` type, `TUNE` the defaults,
`tuneOf` the validator). It is built FIRST in the Node constructor from TUNE
plus `NodeOpts.tune`; an unknown row, a fraction, or an integer under the
row's floor throws. The floor is 0 for the two redial counts (no redial at
all) and 1 for every other row, because 0 there is an off switch, not a
tuning (shedTicks 0 makes `% shedTicks` NaN so no orphan ever polls;
dedupKeep or issuers 0 turns exactly-once dedup off; pending 0 drops every
attempt; redialGrowth 0 makes every later wait pure jitter). No overrides
means the shared frozen TUNE itself. Rows: redials 10, memberRedials 5,
redialGrowth 2, redialCap 32, suspectTicks 3, leaveTicks 4, pulls 5,
proposalAge 10, rejoinTicks 10, retryTicks 2, pending 1024, dedupKeep 1024,
issuers 1024, probes 1024, queued 256, compactAt 4096, snapshotAt 4096,
lamportLease 4096, shedTicks 2, stageTicks 8, acqLiveMax 8192, stallAt 8. The
old constants keep their names and exports as the defaults (MAX_REDIALS,
LAMPORT_LEASE and SNAPSHOT_AT live in tune.ts; node.ts re-exports them,
because node.ts imports tune.ts). Every read site reads a row: the hot ones
(the write pipeline, the confirm registry, the paused-link queue — a Link
has no node, so the node hands its `queued` row in at construction) and the
cold ones (membership, scope, log, the WAL snapshot arm, the clock lease,
the redial chain and its curve). The shell's leave cap reads
node.tune.leaveTicks (the weld is gone); the sim's queue monitor reads the
node's row. MAX_PENDING was also the wire bound on a WACK/WNACK run; that
use is split into the fixed constant MAX_RUN, so tuning a queue can never
change what the wire accepts (a test pins it). Config: one key now,
`redial.tries` (call, flag, env, file; an integer ≥ 0; not passed to the
#directory client; `diag(f).config()` shows TUNE.redials as its default).
Evidence that it is the same kernel: a 200-seed trace diff against the
previous tree, four variants (the sweep build; heartbeats on with a client
and a partition/heal window; a member crash; scoped replicas), comparing
event counts, a hash of the per-event state-hash trace and the bytes sent:
identical; 20 sweep seeds are frozen as a golden in sim/exec.test.ts.
Evidence that it is perf-neutral: interleaved base/tune runs of the write,
node, alloc and data perf files, three rounds each, one at a time: 0
failures in 24 runs, medians within this box's noise (write-path ceiling
293 → 263 ms, issuer leg 34.9 → 30.4 ms, 2k inbound apply 105.0 → 104.3 ms,
5k assignments 518 → 524 ms); the COUNT tier is identical.
REJECTED: a config key per row now (`suspect.ticks` waits for the HELLO
contract hash because it is a cluster contract; `pending` stays table-only
until it is measured); keeping the constants as the read sites; a NodeOpts
field per knob; the table in node.ts (an import cycle); allowing 0 on every
row.
Consequences: what stays fixed on purpose: REASON_MAX, MAX_RUN, the 4096
member bound, DIAG_*, VNODES, the snapshot chunk, the jitter (wire hygiene
and protocol identity). docs/DESIGN-CONFIG.md's §5 constant rows are the
tune-table row now; its §7 step 7 is landed.

## V4-20 — a dead member is dialed 5 times, not 10: eviction in about 4 s instead of 20 (2026-10-08)
Context: eviction is held while the proposer is still dialing the suspect
(an un-exhausted chain means reachability is unknown), so the redial chain's
length IS the time from a crash to the eviction ballot: 10 tries at the
100 ms base was 19.1 s plus jitter. Its rows froze on every screen
meanwhile.
Decision: on a SERVER, the chain started by the death of an ADMITTED MEMBER
link is capped at the tune row memberRedials (MEMBER_REDIALS = 5), never
more than `redials`: 100+200+400+800+1600 = 3.1 s plus up to 0.5 s of
jitter, eviction at the next tick, about 4 s. A dial that never linked up,
a link that died before HELLO, an admitted peer outside the committed view,
and anything a CLIENT dials keep the long chain. The backoff entry carries a
`member` flag, set on a fresh chain only. The heartbeat revival of a
given-up target keeps the member chain when the target is still a committed
member's listen (the revive loop re-seeds the flag before it dials);
without that, whenever the member chain ended before suspicion fired
(heartbeat.ms 2000 at the default base, or redial.ms 30 at the default
heartbeat), the revived dial started a fresh 10-try chain and the hold
covered all of it: 23.9 s at heartbeat 2000, slower than before. A revived
dial in flight now holds eviction like any timer-fired dial (the shell has
no connect timeout; the revival was the one accidental exception). A client
is excluded because it evicts nobody, so its chain is no clock, and with
heartbeats off a short chain would strand it from a restarting server.
Measured in the sim (3 servers, one crashed): 3.4 s at the defaults against
19.9 s; 1.4 s at redial.ms 30; 7.9 s at heartbeat.ms 2000. On examples 13
and 14 at redial.ms 30 the vote is in 1.1 s and 1.4 s after the kill (was
about six); both READMEs are re-recorded. This is a behaviour change, so it
does not ride V4-19's "defaults equal today" rule: the 200-seed trace diff
moves exactly the crash-variant rows, and with memberRedials pinned at 10
the crash rows are identical.
REJECTED: 4 tries (about 2 s, the same as suspicion — too close to a blip);
making redial.tries set the member chain directly (the member row keeps its
own default; the kernel caps it at redials, so a lower redial.tries still
shortens it); marking a revived chain by the old entry's flag rather than
by current membership (a host evicted meanwhile would keep the short chain
for ever).
Consequences: four sim tests whose windows were derived from the 10-chain
were re-derived from measured trajectories (sim/write.test.ts AA#2 and AA#3;
sim/scale-chaos.test.ts batch-eviction, now at heartbeat 100, and
pending-overflow); three membership tests now suspect first, then exhaust,
then tick, the order the defaults produce. Known and not changed: a view
install dials every member it holds no link to even when a chain to that
member is mid-backoff, and that failed dial forks the chain into two timer
lines that share the tries (STATUS, kernel). The glossary (tools/debug/
eli5.mjs) names the member chain.

## V4-21 — a client's `cluster.writable` is its feeder's gate, carried on the DIGEST reply (I-33) (2026-10-08)
Context: every role read `writable` from its own write-gate, which is a
member's rule (in the committed view, reaching a majority). A client is
never in the view, so it read open genesis (`true`) before it had any link,
`false` once it learned a view, and `false` while its relayed writes
committed in 13 ms. What decides whether a client's write goes through is
its feeder's gate: a closed gate at the feeder parks the relayed write.
Decision: a server's DIGEST toward a CLIENT link carries `w: 0|1`, the
server's gate at that moment; member-to-member digests are unchanged. The
client reads `w` only off its primary, into `node.feederOpen` (null =
unknown), resets it to null whenever the primary changes, and an older
server that sends no `w` leaves it null. The api sets `writable` by role: a
member reads its own gate; a client reads `primary !== null && feederOpen
=== true`, and starts `false`. The client refolds on a field compare, not a
journal row (the gate's journal rows are the member's). A digest crosses
every client link every heartbeat, so a client is one heartbeat behind its
feeder at worst.
REJECTED: VIEW as the carrier (sent on install and on PULL only, never when
a gate opens or closes); `writable: null` on a client (honest but useless
to a screen; it stays the fallback if a feeder-side signal ever proves too
costly).
Consequences: kernel/client.test.ts pins that `w` rides only to client
links and only the primary's `w` counts, reset on failover; sim/client.test.ts
pins that a feeder cut off from the other two closes its gate and the spoke
follows within two heartbeats, then reopens on heal; api/index.test.ts pins
false before a link, true once fed, false when the feeder's gate closes.

## V4-22 — `cluster.writes` is its own handle, published one microtask after an outcome (2026-10-08)
Context: the confirm ring (the last 64 write outcomes of this node) was a
key of the one `cluster` data source, so a bare `cluster.tap` fired on
every write outcome, and the ring was published only from the post-step
fold while a row settled in a promise microtask after that step: on a solo
node with heartbeat.ms 1000 a write read `pending` for over a second under
an object that already held the value.
Decision: Bind settles a ring row in the same call that settles the write's
promise (first settle wins) and names every row that moved (`onOutcome(id)`:
new, settled, evicted). The composer keeps the ring in its own data source
and publishes only the moved rows, in one batch, from one queueMicrotask
per burst. `f.cluster` is a thin Proxy over the view: its `writes` key
returns the ring's source, every other key forwards. So
`f.cluster.writes.snapshot()` and `f.cluster.writes.tap(...)` work, and
`f.cluster.snapshot()` is the picture without the ring. A solo write reads
`committed` one microtask after it applied; a burst of a thousand
assignments is one ring fire; the cluster tap fires only when the view
moves. destroy() rejects a write still in flight with 'destroyed', and the
ring shows that reject once, then never moves again: the ring tells the
same story as the write's promise. With it: a `journal.cap` below one step's
burst no longer starves the fold (the fold reads `journal.dropped` past its
cursor and reconciles from live state), and a leaving member paints no
cluster frame after destroy().
REJECTED: merging `writes` back into the cluster view's value, snapshot and
toJSON (puts the ring back in the tap's domain, which is the bug); the
settle in the promise's `.then` (two microtasks before `committed` shows);
publishing the whole ring per microtask (64 changed rows per publish
downstream); freezing the ring at destroy (an in-flight write read
`pending` for ever after its promise had rejected).
Consequences: `cluster.snapshot().writes` is gone; readers use
`cluster.writes.snapshot()`; screens that show the ring also tap
`cluster.writes` (examples 03, 08, 11, 40, 41), or a refused write, which
changes no data, would never repaint. examples/10-confirm's README is
re-recorded (no goodbye frame after Ctrl-C).

## V4-23 — the debugger says what it knows and no more (2026-10-08)
Context: four debugger lines on the page. Scoped captures painted
`never-arrived` in red for every non-holder; a truncated journal switched
the scrubber off in silence and painted `replay ✗`; a newcomer's first gate
row said `evicted`; a clean leave had two spellings in the survivor's diary;
a too-big DIAG answer was named `error`.
Decision: (1) the capture carries scoped placement facts: diagNode adds
`replicas` and, on an armed node, `holders`: for each row the node itself
wrote (from its own log and its own writeLocal journal rows, so a row it
stamped before the view armed and then handed off still has its list), the
ring's own holder list. routes() calls a member outside that list
`not-a-holder` (quiet) instead of `never-arrived`; the viewer counts
"applied n/m holders". The browser cannot import ring.ts and a re-implemented
hash would drift, so the ring's answer travels in the capture. (2) Hand-offs
are facts the page folds: routes() gives `acquired` when the node's record
book holds the write and the node journaled an acquire of that row; stateAt
follows the kernel (shed drops the row's cells outside the election; acquire
folds the row's captured entries). (3) A truncated journal makes the replay
unchecked, not failed: the fold adds `truncated: true`, the header says in
amber "replay unchecked — journal truncated (node: N dropped)", the bar
says "rewind off — truncated". (4) The gate has a fifth word, `joining`: the
node is not in the view and no view it held ever named it; a member voted
out still says `evicted`. (5) A survivor writes leave(proposer) in its
journal when a proposal leaves out its own proposer. (6) A DIAG answer too
big for one frame is absent `frame`, not `error`; the paged read stays
Someday.
REJECTED: recomputing placement in model.mjs; carrying the whole ring;
painting a copied-in write as plain `applied`; a new journal kind for the
self-proposed leave; a registry scenario for truncation (every scenario must
replay-verify); the plan's longer bar text (it ran into the crumb at 820 px).
Consequences: a `scoped` registry scenario replay-verifies the fold; the
real page was driven in Chromium. Limits, on the page: the holder list is
as of capture end; a client, and a member that left, keep the old rule; a
scoped capture paints every node `differs` (a new bug line).

## V4-24 — the sell rung, the half-typed line, and the series on the website (2026-10-08)
Context: the owner's questions 6 and 7: yes to the sell rung (an example
with methods:), and the house choice for the half-typed line left to us.
Decision: the series is 27 rungs. 44-sell is the story the website tells,
in three files: open.ts is a seeded shop with no methods:, so every client
may change every row, the price included; door.ts is the same shop with
`methods: { sell }`, where a sale is a new row at the shop's own price;
customer.ts does the same two things to either shop (set the price to 0,
then sell one): against the open shop the price lands and there is no sell;
against the door the price write is refused `methods-only` and the sale
comes back at 10. It sits in the apps tier (40-44) because it repeats 02 and
08 as one story. The screen rule gains one sentence: a role that also reads
typed lines gives its readline the screen (output: process.stdout, an empty
prompt) and ends every frame with `rl.prevRows = 0; rl.prompt(true)`, so a
half-typed line comes back after a redraw (the prevRows reset is needed
because readline climbs back over the rows its last copy wrapped onto; after
console.clear() the line starts on a fresh row). Giving readline the screen
puts the terminal in raw mode, so the role hands Ctrl-C on with
`rl.on('SIGINT', () => process.kill(process.pid, 'SIGINT'))`. A
terminal-only behaviour gets a terminal test: tests/examples-tty.test.ts
runs 40's join and 41's edit on a real pseudo-terminal (a python3 pty
bridge; the suite skips without one). The website's section 03 links the
series table and the wire card tells the one-opener story (V4-15).
REJECTED: a fixed prompt line under the picture (a visible prompt would land
in every check's output); sequencing the interactive rungs (loses the live
picture); writing the typed line back by hand (readline's row memory stays
wrong); a pty library as a dependency; a cluster.writes-based screen for the
customer; an always-on GitHub link beside a "not public yet" chip.
Consequences: examples/README.md's tiers sentence names 40-44 in one
sentence (the website's sync reads only the first sentence); 43 points to
44; the battery has one more example check and three terminal tests.

## V4-25 — a fresh ballot of mine never opens below my own last ballot: a double vote latent since M2, closed (2026-10-08)
Context: a node remembers only its latest vote (votedFor). One that granted
another proposer at epoch 2, then opened a ballot of its own at 3 and lost
it, held votedFor = {3, me}; the epoch for its next ballot treated "my own
ballot" as nothing to step past and started again at view+1 = 2, spending at
2 a vote it had already given away there. With two old-set majorities that
share only this voter, two views commit at one epoch. The parked I-20 branch
found it with a random explorer (docs/DESIGN-LEAVE.md §8.2); it is now
reproduced three ways on today's kernel: by hand on three real nodes with a
chosen delivery order (kernel/membership.test.ts: both proposers end
writable in different views at epoch 2), and by chance in the explorer
(sim/explore.test.ts: seeds 947 and 1855 of 1..2000 split at epoch 3; an
in-life split with no restart at n=4 at seed 3512 of a wider run).
Decision: the epoch a fresh ballot targets is max(the committed view, every
known burn, my own last ballot if the vote is mine, else the epoch my vote
is spent at) + 1: my own ballots never go down in epoch, within a life and
across a restart (votedFor is durable). The same epoch again stays allowed
(the same-proposer case the kernel already permits; at most one of my
ballots at an epoch can commit). One view per epoch rests on one vote per
epoch; grants were already monotone, proposals now are too, and a
same-proposer re-grant at a lower epoch cannot happen because a proposer's
offers travel one FIFO link in the order it made them. Cost: nothing on the
normal path; only a lost ballot of mine above view+1 now re-proposes at its
own epoch instead of lower. Formation never re-proposes; the 59,500-event
formation pin is unchanged. Guards: the two kernel pins; the random
explorer over real Nodes (sim/mesh.ts, sim/explore.test.ts: 2000 seeds of
leaves, cuts, heals, give-ups, teardowns, restarts and a join, every frame
delivery chosen by the seed, red on the kernel before the fix, clean over
40,000 seeds with it); the seeded leave sweep (sim/leave-sweep.ts and its
test: 100 + 100 + 40 schedules, safety asserted on every one, liveness
pinned as exact not-live seed sets) guards the clean stop on today's kernel,
the breadth behind V4-6, though it cannot draw this shape.
REJECTED: bringing the rest of the parked I-20 branch (the pledge protocol)
with it; trimming the sweep to 50/40/24 seeds (the timing behind the trim
was taken under load). Not fixed here: a ballot built on an older view still
commits after a newer view installs (on the base, does not break one view
per epoch; STATUS, kernel; DESIGN-LEAVE §9's argument).
Consequences: kernel/membership.ts's BALLOT IDENTITY list names the rule;
the explorer's reach floors are a third of today's measured values and are
meant to trip on a kernel change that moves the random trajectories a lot.

## V4-18 — overlapping cells: the newer stamp wins across depth (2026-10-08; numbered before V4-19 to V4-25, which landed first)
Context: a cell is a full key path, so a whole-row write (`['gadgets']`)
and a field write (`['gadgets','stock']`) were two cells that never met in
the LWW election. Each kept its own last writer; the projection downstream
applied them in kernel-apply order, which differs per node (own commits
apply at once, a peer's lane arrives later, the suffix ship walks lanes one
by one, a spoke's resync ghost-removed a field under a re-seeded row). Two
nodes with the same cell map could show different rows for ever. STATUS
reproduced it with a seeded row plus a client's field write across a
memory-only restart; the sim sweeps never saw it, because converged()
compared cells only and the sim sink threw every apply away. The owner
chose option A on 2026-10-05. Four review rounds found one more interaction
each (a fast-path regression, non-object row values, the scoped gather, an
in-flight write that never settled under an ownership move); all are closed
below, and the array edge is stated as it is.
Decision: the newer stamp wins across depth, with the one stamp order fero
already has, lexicographic (epoch, seq, origin), the `newer` predicate, now
one exported function used by both elections. In apply(): (1) a cell of
depth ≥ 2 loses to ANY ancestor whose stamp is at or above its own, at every
depth; journaled as the new kind `subsumed`. (2) A write that wins its cell
sweeps every cell under it stamped at or below it: a live field leaves
state, the entry hash and the rolling hash exactly like a remove; a field
remove's tombstone under it leaves the index; both get the parent's stamp as
their version, so a late copy loses for free. No remove goes downstream for
a swept cell: the parent's apply carries the whole value. (3) A cell under
it stamped ABOVE it stays and is re-applied downstream after the parent's
apply, shallowest first, under its own stamp and no attempt identity (a live
field is set again from its log entry, a field remove is deleted again), so
the object reads the same as if it had arrived after. A row remove is a
parent write like any other. (4) A field remove takes back what the field
alone had made up: the projection vivifies the rows a field write lands in,
and makes `{}` up over a value a field cannot land in (a number, null, a
string); after a remove the kernel walks up from the removed cell's parent
to the nearest live ancestor and emits, at seq 0, a repair for each level
with nothing live left under it that the live ancestor's own value does not
hold, and re-emits the ancestor's own value when nothing live is left under
it and that value is not a plain object; an array put back that way has
the newer removes under it taken out again, shallowest first, as repairs
(never the array's own keys, which data refuses). A repair is never logged
and never on the wire; the api's fast-path collector takes no settlement from a seq-0
apply, and inside our own issue() no settlement probe runs at all. (5)
Tombstone GC keeps a field remove that a live ancestor still fences (its
stamp stays the winner, so compaction keeps the entry and a late joiner
folds the same row); a row write above it sweeps and releases it. (6) A
refused record that carries an attempt identity is a settlement: when
apply() refuses a record at its own cell (lwwSkip) or under an ancestor
(subsumed) and the record carries iss/cid, the kernel calls the sink's
optional `lost(iss, cid, origin, seq, epoch)`: the record committed at
exactly those coordinates (the WACK's) and lost, and no apply will ever
carry it; the runtime surfaces it as onLost and Bind settles the write
committed on the owner's lane.
The index: `node.deep` is keyed by ANCESTOR key: every cell of depth ≥ 2,
live or tombstone, is registered under each of its ancestors, so a write at
any depth finds exactly its own subtree in one lookup and a row-only
partition has no entry. Invariant, checked by the sim oracle: an indexed
cell's stamp is strictly newer than every ancestor's version; no set is
ever empty. Kept by apply, dropCell, tombstone GC and #resetFold; shed walks
it. A spoke's resync skips a ghost field whose ancestor is live now or was
held at the reset, and puts newer fields back on top of a ghost row.
The api: a parent's apply probes our in-flight field writes under its own
cell (the in-flight index is keyed by every ancestor like the kernel's; one
lookup, no copy; a row apply asks only after the kernel let one of ours
go), settling a swept field from the dedup window or as 'superseded'; a
write settled from the window names the owner's lane. Both probes are
skipped while one of our own issue() calls is on the stack. The `lost`
effect settles a write of ours the kernel refused at its echo as committed
from the refused record's own stamp: before it, a field write of ours whose
newer foreign row reached us before our WACK stayed `pending` for ever and
methods.update failed with a false timeout; the same-cell twin hung on the
base tree too. A local `delete data.g[i]` of an owned array element is
refused before it commits, with data's own message (write the spliced
array); the substrate folds a REPLICATED remove under an array-valued row
that data would refuse (a sparse hole) as a no-op, the array stays whole,
instead of the refusal killing the process in the orders where the kernel
re-applied a newer field over an older array.
The gather (scoped reads, `await data` and methods.read()): the winner per
cell as before, then across depth a field cell whose winning stamp is at or
below an ancestor's winning stamp is dropped (at or below: a swept field
ships as a tombstone at exactly its row's stamp), and the survivors project
shallow to deep, a live cell set, a tombstone deleted at its own depth,
after the unstamped coverage drops of parked cells; then the gather's own
un-vivify: for each deep cell deleted this generation, the parent levels
are walked up, and an empty object nobody claims, that the nearest projected
ancestor's own value does not hold, goes (a level whose own live claim
projected stays, `{}` included; a parked level keeps its last value). So
the gather's object no longer depends on which generations it saw, and it
agrees with the node's screen.
The sim: every node's sink folds its applies into the object a screen would
show (sim/fold.ts, modelling data); projected(), run by converged(), checks
the index, the stamps, that the sink object equals the kernel's cells folded
by depth, and that it is one object across nodes; the cells workload draws
non-object row and field values. The debugger's stateAt mirrors the rule on
state and the honesty gate holds it to the kernel.
REJECTED: B, the field always wins (one stale field write would shadow
every later whole-row write for ever). C, refuse mixing with a typed reject
(unenforceable across concurrent writers, a reborn server, or records
already in logs; a `data:` seed plus field writes is the natural app shape).
Emitting downstream removes for swept children. Indexing live cells only (a
field remove stamped above its row is a fact a late older row must meet
again: 112 of 600 random histories still depended on order). Indexing by
partition (a mid-depth write walked every field cell of the partition: 155×
on a 10k-cell partition). Keying the api's in-flight index by row (2.3-2.5×
per foreign field apply with 1k in flight). Leaving a vivified empty row
behind after its last field is removed, on the screen or in the gather.
Skipping every un-vivify repair when the live ancestor's value is any
non-plain value (data makes `{}` up over a scalar and a live sibling field
keeps it; only an array is the value nothing is made up inside). Skipping
the api's settlement probes for every seq-0 apply. Settling a WACKed write
from the window at the post-step sweep instead of the `lost` effect (it
would resolve early, and on a spoke under the spoke's own uuid). Keeping
the gather's removes-then-updates order with a special case. Letting data's
sparse-hole refusal of a replicated remove throw out of step().
Consequences, what is guaranteed: for plain-object, number, null and string
values, writes and removes at any depth fold to the same object on every
node (by value, not by key order), in every arrival order, on the node's
own screen, in the sim's sink and in the scoped gather (0 order-dependent
histories in 3,620 random ones and in a 500-history array brute force); a
write of ours that commits settles as committed once its echo arrives,
whether the echo projects, is swept, or is refused at its election. What is
not: an ARRAY row. data does write into arrays (an index write replaces the
element, a field inside an element lands, a non-index key becomes a hidden
array property), the kernel makes no repair inside an array, so an
array-valued row's screen can still depend on arrival order; write the
spliced array. `methods.remove({ key: ['g', 0] })` does not go through the
lens, so it still commits a tombstone that shows nothing; a typed reject
for it is the next step (STATUS). A field remove under a STRING row with a numeric key can
depend on order, and the sim's fold models strings differently from data
(both self-consistent). A parked level (a handover window) is never
un-vivified by the gather until it is claimed or covered. A write of ours
whose refused echo never arrives (the owner died after its WACK) still
waits for a later foreign write on that cell or row to probe it, the base's
rule. A seq-0 repair that reaches the api outside our own issue() still
runs the settlement probes, the base's rule for ghost removes. A spoke's
write settled from the window names the spoke's own uuid when the WACK came
through its relay. The sim's object oracle compares at the end of a run.
Cost: a field-cell apply pays one ancestor key string, one Map lookup and
one Set add per ancestor; a parent write pays its own subtree; the two
refusal paths pay one compare; the whole-row and duplicate paths pay
nothing measurable (R0a, RB1, RB2 unchanged); three ratio pins guard it
(mid-depth 0.95×, in-flight field 1.0×, in-flight row apply) under a 1.6×
budget. examples/README.md's rule 2 ("one write style per row") is advice
now. JK.subsumed is 76. The sweep golden of V4-19 (20 seeds by event count
and trace hash) is re-recorded: every event count stayed, every trace hash
moved, because the state hash over a mixed history now follows the
across-depth election (a swept field leaves the rolling hash, a tombstone
takes its parent's stamp).

## V4-26 — `validation:` is a top-level key; the `diag` key arms the debugger's attach (2026-10-09)
Context: the owner asked (question 5) whether `seams.validation` is needed
at all. It is: it is the only guard on an open resource (one with no
`methods:`), and it also covers the server's own writes, its handlers'
writes and the `data:` seed. So it gets a plain name instead of living alone
under `seams`. And `NodeOpts.diag { allow }` existed in the kernel (M7) but
was not a config key, so `npm run debug -- --attach` was denied by every real
`fero()`.
Decision: `validation: rule` in the call is the schema check every write
meets as it enters. It comes from the call only and must be a function at
`fero()` time. `seams: { validation }` works for one release: api/config.ts
folds it into `validation`, so the composer reads one key, and prints one
note to stderr per process; setting both is refused. The seed error says
"rejected by validation". Examples 11 and 41 use the new spelling; no
printed line changed. The `diag` key, as docs/DESIGN-CONFIG.md §4 planned:
`diag: { allow: { <name>: <token> } }` from the call, `FERO_DIAG_ALLOW_<NAME>`
or a `fero.opt.ts` file, with the per-resource rung like every key; never a
launch flag, because every user on the box can read a command line, and a
flag is refused in plain words that name the variable to use instead; no
message ever repeats a token. A name in a variable is one word of letters
and digits (an `_` would nest it); a token that reads as a number or a
boolean is refused because its text is lost; an empty token is unset; the
allow that wins replaces the others whole. `FERO_DIAG_TOKEN` stays the
viewer's variable and is still stripped before the layer looks.
`diag(f).config()` shows the names and `[redacted]` for each token. Without
the key the channel stays dead, as before. The node's resource name now
rides the capture and the DIAG wire (additive), and the viewer marks a `#`
name as a system resource with a quiet tag beside the label, never in the
pill slot, so a problem pill cannot hide it. A client holds its process open
while it follows, so a script that reads and is done ends with `await
f.destroy()` (README, examples/02).
REJECTED: refusing object inits of `seams` silently (both spellings set is
an error, not a pick); a token from a flag; a token that could nest or lose
its text; the badge in the pill slot.
Consequences: the token still crosses the wire in clear text, so attach on
a trusted network or through a tunnel. A `#directory` node cannot be
attached: the system compose takes no `diag.allow` (STATUS). A capture that
mixes resources paints every node `differs` (STATUS, the debugger).

## V4-27 — cross-box discovery: a host with no port asks that box's directory, under the explicit-listen rule (2026-10-09)
Context: a box knew only its own directory; a server on another box could
be reached only by its full `host:port` in `hosts`.
Decision: a `hosts` entry with no port names another box: `hosts:
['10.0.0.5']` means "ask that box's directory", at this instance's
rendezvous port (`rendezvous:`, else `FERO_RENDEZVOUS`'s port, else 3376;
every box runs its directory on one port). The instance opens one more
`#directory` client per named box and looks its own name up there; the
addresses from every directory are joined and go to the kernel as one
`discover` event, the union of all sources (a test pins it). It only asks:
it never registers or hosts on another box, so a box's directory still
lists exactly that box's servers, and an entry lives as long as its
registrant's link to its own box's directory. The asked box must make its
directory reachable (`FERO_RENDEZVOUS=10.0.0.5:3376` there); the default is
still loopback. A misdial (the far port holds a user resource) is refused
by the HELLO name echo and dialed again at heartbeat cadence. A loopback or
wildcard address another box hands out is dropped unless it sits on the
host that answered. Spellings that dial this box's own directory are not
asked twice (`LOCALHOST`, `0.0.0.0`); `[::1]` is a different socket and is
asked like another box. `cluster.me.rendezvous.boxes` shows each asked box
as `{ up, error? }`; a failed lookup is never asked again, so `error` stays
set (clearing it would make a dead lookup look healthy). A bare host with
the directory off is refused. The explicit-listen rule replaces V4-2's
loopback guard: a server is refused at `fero()` with "to be reachable from
another box, listen on a routable address" when its listen is loopback or a
wildcard (127.*, localhost, ::1, 0.0.0.0, ::; the default counts) AND the
listen would leave the box (a routable rendezvous, or `hosts` naming
another box). Clients are never refused; with nothing set the rule never
applies. On a box whose `FERO_RENDEZVOUS` is routable, every server must
name a routable listen, even one meant to stay local: that directory hands
every listen it holds to other boxes.
REJECTED: registering on every asked box (it copies what the view gossips,
and an entry's life would hang on a link between boxes); picking 3376 in
silence when the directory is off; clearing a box's lookup error on relink.
Consequences: two boxes on one machine are tested as 127.0.0.1 and
127.0.0.2 with one rendezvous port; example 15's refusal line is
re-recorded; docs/DESIGN-DIRECTORY.md §11 is the record. An askable
directory is as unauthenticated as the peer plane: the door
(docs/DESIGN-DOOR.md) is what makes it safe off a trusted network.

## V4-28 — a remove of an array's own element is refused `sparse-hole`; a view install leaves a member to its running redial chain (2026-10-09)
Context: two leftovers from V4-18 and V4-20. data will not delete an
array's own key (a sparse hole); the lens refused `delete data.g[0]` but
`methods.remove({ key: ['g', 0] })` skipped the lens and committed a
tombstone that showed nothing. And membership's install loop dialed every
member it held no link to, even one whose redial chain was mid-backoff; the
failed dial armed a second timer line that shared the chain's tries, so a
member cut while another view installed gave up in about half its chain.
Decision: (1) the binding has one admission rule, `Bind.admit`: the
embedder's `validation`, then the hole check (a remove at depth 2 or more
whose parent, in this node's view, is an array that owns that index).
`issue()` uses it, so every local spelling is covered; when there is no
`methods:` door the composer gives the same rule to the kernel's relay
check, so a client's relayed remove is refused at the server too. One
WriteRejectError: reason `sparse-hole`, reached `issued`, data's own words;
the reason rides the WNACK like `methods-only` and shows as a rejected row
in `cluster.writes`. The check reads the shape the node shows when the
remove is issued (V4-7's rule). Any key an array owns is refused, `length`
included. (2) The install loop skips a member the node is still dialing
(`node.dialing(listen)`, the check the eviction hold reads); a chain that
gave up is not dialing, so a parked member is still dialed on install.
REJECTED: refusing only inside methods.remove's own code (a relayed record
would slip past a server); judging the remove against writes still in
flight (a second, guessed view, which V4-7 rules out); re-checking forwarded
owner-leg writes on scoped nodes (peers are trusted at that layer; the
door's question); cancelling the chain's timer and letting the install dial
take over (the lengthening V4-20 rejected for revivals).
Consequences: an open server with no `validation` now always hands the
relay a check, about 7.5 ns per relayed update against about 110 µs per
relayed record; no pin covers relayed client writes yet (STATUS). Two gaps
still commit a tombstone that shows nothing: a remove from a scoped node
that does not hold the row, and a remove in the same batch as a pending
write that turns the row into an array (STATUS, the array line). A dead
member's chain gives up after its full five tries even when a view install
lands meanwhile; this supersedes V4-20's "known and not changed" sentence.
Only sim/write.test.ts AA#2's give-up moved (1420 → about 1855); the sweep
golden and the 59,500-event formation count are unchanged.

## V4-29 — CI runs the tiers whose results do not depend on timing (2026-10-09)
Context: the remote `pemrouz/fero` exists and runs nothing; the owner has
no quiet box yet.
Decision: `.github/workflows/test.yml` runs on pushes to `main` and on pull
requests (a push to a PR branch runs once, not twice), on ubuntu-latest with
Node '26'. fero reaches data by path, so the workflow checks out fero and
`pemrouz/data`'s v4 branch side by side, the same rule as `test:contract`
(data HEAD): data's v4 must be pushed before a fero commit that needs it,
and a red run right after a data push points at data. It runs `npm ci` in
fero only, checks that python3 has the pty module (so the tty example tier
cannot skip unnoticed), then `npm test` and the count tier of
tests/baseline.perf.ts alone (`--test-name-pattern="^counts:"`). It does
not run `npm run perf`: on a shared runner the wall-time pins measure the
neighbours, and tools/perf/BASELINE.md keeps them for a pinned quiet box. A
new push to the same ref cancels the run still going. Proved locally in the
CI layout against the data commit GitHub has today (63fea66): 584 + 18
green, about 6 minutes. The file is written, not pushed.
REJECTED: running the wall-time perf tier in CI; pinning data to a fixed
commit (stricter, but then every data fix needs a fero bump; left as the
option if drift bites).
Consequences: the pinned quiet box still waits for hardware; after it comes
the v2-vs-v4 socket A/B with p99s. The example time limits leave about 3×
headroom on a runner.

## V4-30 — The door: the cluster contract, the methods-only hint and peer authentication as one HELLO change (2026-10-09)
Context: three STATUS items changed the same frame. One box's shell could
set `heartbeat.ms` or `replicas` alone and the mismatch showed only as
behaviour; a client learned that a resource is methods-only only after a
round trip; and a client's HELLO that presented a member's uuid tripped the
duplicate-link rule against the real member, so any process that could
connect could knock a member off. The owner chose BUILD for peer
authentication on 2026-10-05, and on 2026-10-09 took every default of the
design record docs/DESIGN-DOOR.md §14 (a three-proposal panel: kernel HMAC,
shell TLS, operator-first). Built the same day in three stages and settled
in three review rounds by the other model; 32 commits.
Decision: HELLO grows once, by three optional keys. `c` is the cluster
contract, a readable string, not a hash:
`v1;heartbeat.ms=<effective>;replicas=<n|0>;methods=<1|0>;validation=<8 hex
fnv of the rule's source|none>;ring=fmix32` — the api writes the front, the
kernel appends the ring label from `RING` in kernel/ring.ts so it cannot
drift from the ring code. `m: 1` is the methods-only hint. `k` is a fresh
nonce per link, 16 to 64 characters, sent only when a secret is set. Only
user-resource servers send `c` and `m`; clients, the `#directory` and every
embedder send nothing, so a node with nothing set sends the v4.0 bytes
(pinned as a literal and as a journal golden) and the system plane's bytes
do not move. Two servers whose contracts differ refuse at the door:
`contractReject: 77` names the first key that differs (or `missing:<key>`)
and the other side's value, the dialed target is parked and heartbeat
revival re-dials it. A client reads the hint live off its primary
(`feederMethodsOnly`, never copied, so a failover refreshes it) and
`Bind.issue` refuses a plain write locally as `methods-only`, the same
WriteRejectError the relay throws, before any record ships. The role rule,
with or without a secret: a client HELLO (`r: 1`) whose uuid is a committed
member's, or an admitted member link's, is refused `doorReject: 78`
`uuid-taken`; the member's link is never touched and no dupLink row is
written; a member HELLO evicts a client squatting on its uuid; two clients
keep the duplicate-link rule. The door itself: `NodeOpts.door = { mac,
nonce }` is injected like `validate`, so the kernel holds no crypto and no
secret (the api builds HMAC-SHA256 as base64url and 16 random bytes from
node:crypto; the sim injects a seeded toy, so the schedules prove the
protocol and real sockets prove the cryptography). One new verb, `DOOR` 26,
carries a proof `{ p }` (exactly 43 characters) or a best-effort notice
`{ e: 'denied' | 'uuid-taken' }`. The proof is
`mac(JSON.stringify(['fero-door/1', side, verifierNonce, proverNonce,
verifierUuid, verifierListen, u, i, l, r ?? 0, n ?? '', c ?? '', m ?? 0]))`.
The dialer proves first; the acceptor proves back only to a verified dialer
that has passed the role rule, and before anything admission ships.
`verifierListen` is the listen the prover was SHOWN and the verifier
rebuilds it over the one it SENT, so a relay that rewrites the address is
`bad-proof`; the address rule (a discovered or view-learned target must
answer as the address it was dialed at; typed `hosts` are exempt) catches a
relay that forwards verbatim. A proving link (`LS.proving`) is outside
`byUuid`, `clientLinks` and `admitted()`, carries nothing but DOOR, and
dies `timeout` at `tune.proveMs` (5000, floor 1, no config key). The
reasons: `no-secret` · `peer-secret` · `bad-proof` · `uuid-taken` ·
`address` · `timeout` · `refused`; `c` carries the dial target or the
claimed listen (for `uuid-taken` the uuid on the refusing side, the dial
target on the refused client). A second HELLO on a secured node is dropped
and the link lives (the golden's dup fault re-delivers HELLO in 14 of 20
seeds); a notice on a link I never proved on is dropped and closed. THE
CLOSE RULE, settled at the third review: the door speaks only through a
DOOR notice. A notice read while proving parks the dialed target as
`refused` (or `uuid-taken`, the one word kept, so the line can name
`FERO_UUID`) and heartbeat revival re-dials it once per tick. A bare close
while proving, before or after my proof, is a LINK LOSS: no row, no park,
the ordinary bounded redial chain a link that died before HELLO gets, then
the ordinary give-up. The one silent close: when a live link already
reaches the target (one I dialed there, or one whose peer PROVED that
listen: `#held`, the revive loop's rule) the close is a crossing dial's
keeper close and starts no chain; `held` is judged on facts this node owns,
never on the closing peer's unproven claimed uuid. The `secret` key: the
call, `FERO_SECRET` (per resource `FERO_<NAME>_SECRET`), a `fero.opt.ts`
file; never a flag (ps and shell history show every flag); a 16-character
floor; trimmed in every layer; the OFF set means `false` = open on purpose;
`diag(f).config()` shows `<set>`, never the value; nothing a secret touches
prints (no secret, nonce or proof in a row, a capture, an error, a line or a
log). A server that listens off loopback must set a secret or say
`secret: false`; a client is never refused for having none;
`FERO_CONFIG=off` with `FERO_SECRET` set prints one line saying the process
runs open. The stderr lines: one per dialed target and reason; inbound
refusals once per reason per process as "a peer that connected as
<claim>", claims cleaned and cut at 64 characters, a 1024-entry cap;
`nameReject` stays silent. Not protected, said plainly in §7: everything
after the handshake is cleartext (TLS is a later layer and this handshake
runs unchanged under it); a relay at a typed static host; a dishonest
client that holds the one shared secret is a member on the wire; a leaked
secret; the loopback `#directory`.
REJECTED: TLS with a pre-shared key at the shell (the kernel never sees the
door, so the sim cannot prove it, and a plain client gets no message at
all); mTLS (a CA, certs, rotation, files in every example); hand-rolled
crypto in kernel/; both sides proving at once (every member would sign any
nonce for anyone who can connect); an HMAC in HELLO alone (a captured
HELLO replays); the incarnation as the replay bound (a reconnect looks the
same); an 8-hex contract hash (the operator cannot see which key differs);
one `door=` field (hides validation drift under `methods:`); "the first
holder keeps the uuid" (a client that connects first locks a member out);
binding the dialed address for every target (typed hosts differ in
spelling); two secrets now (the derived client key is the follow-up); a
secret required on loopback (breaks the 27 examples for a boundary loopback
already gives); a park on a bare close (the design's "refused is a guess":
it stranded 41 of 480 secured pairs and 71 of 210 secured clients cut
during the handshake with heartbeats off, where the open path healed every
one); keying the keeper close on the claimed uuid (unproven); a `refused`
row at the end of a notice-less chain (one row, two meanings); a new
example rung in this change.
Consequences: the open path did not move: the 20-seed golden, the sweep,
the v4.0 byte literal, the journal golden and the 100-node formation at
exactly 59,500 events; a secured 100-node formation is pinned at exactly
104,050 events (4 handshake frames per link against 2). Pre-1.0 breaking:
an off-loopback listen with no secret refuses to start, and a rolling
change of a contract key or of the secret splits the cluster until every
member runs the new value (STATUS). Still open and on STATUS: a discovered
target that never admits holds genesis at the lowest-uuid member (a V4-3
property the door family found); a secured crossing dial costs one extra
dial; a lost notice costs one bounded chain; the journal ring fills in about
34 minutes under two mis-keyed members re-dialing every 500 ms; the refusal
printer reads the composer's journal cursor and can skip a line on a ring
overflow; the sim's restart leaves the old life's timers in the queue, so
a reborn node can time out an honest peer on a stale fire (sim-only; a
real shell cancels its timers); redial chains can double-arm toward one
target on both paths. Follow-ups the owner deferred: the derived client
key, a rotation window `secret: [new, old]`, TLS at the shell, a secret
example rung.
