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

## V4-31 — the owner's answers on scaling out and scaling down (2026-10-09)
Context: two design records ended in questions for the owner:
docs/DESIGN-SCALE.md §14 (scoped replication at scale, fifteen questions)
and docs/DESIGN-LEAVE.md §7 and §9 (the two-member crash; how to continue
the parked I-20 fix). The owner found the records too long to read, so the
choices that change what fero does or risks were put to them in chat as
four plain questions, with the technical rest on its defaults. On
2026-10-09 they answered "rest looks all fine, can record", and asked
whether the directory could be the third view in a two-member crash.
Decision: (1) Scoped replication at scale is built as DESIGN-SCALE records
it, with every default of its §14. On a scoped cluster the member heartbeat
digest is retired for announce-on-change plus a sweep of eight links per
tick; compaction runs behind a frontier over the current holders'
crash-stable floors; tombstone GC runs under a census, a holder quorum and
lane accounting, released in one step. When a member crashes and is voted
out, GC WAITS: the tombstones of the partitions it owned stay until it
returns or an operator forgets it, shown in `gcWaitingOn`. A clean leave
on a scoped member drains first, bounded by `drainTicks` (16), and
`destroy()` resolves false past the bound. With `replicas: 1` a crash loses
that member's partitions until its disk returns (for good without `dir`);
accepted, with a one-time note. The design's ceiling is 100 members. The
order: stage 0 (the harness) and stage 1, then stages 2 to 4 one at a
time, each with two reviews. (2) The I-20 fix continues design first
(DESIGN-LEAVE §9): the safety argument per vote source and the adversarial
harness on the base before any code, and the zero-risk candidate first: a
leaver keeps knocking while its link to a member is up, for a longer
window the operator can set, with no new vote source. (3) A two-member
crash keeps the majority rule (DESIGN-LEAVE §7 (a)) while the owner weighs
a third vote. The box's `#directory` cannot be that vote as it stands: it
runs on one of the members' boxes, so it shares that box's fate; it keeps
nothing on disk, so "my partner is not registered" is not proof of death
and a restarted directory forgets what it answered, which lets both
members go on alone; and it is unauthenticated and shared by every
resource on its box. The safe form is a witness member: a third member on
a third machine that votes in the ordinary ballot, keeps its vote on disk,
holds the secret and stores no rows (DESIGN-LEAVE §7, the dated note).
REJECTED: a fence that releases tombstones sooner but can drop a write
only the evicted member had (DESIGN-SCALE Q5); the directory as a
tie-breaker (above); protocol stages before the harness.
Consequences: wave 5a builds DESIGN-SCALE stages 0 and 1, the drain
excepted; the drain and the I-20 design-first work come next; the witness
member is on STATUS as a choice the owner is weighing. No code changed
with this entry.

## V4-32 — DESIGN-SCALE stage 0: the scale harness, and a restored floor capped at the durable floor (2026-10-09)
Context: docs/DESIGN-SCALE.md §6 and the I-20 lesson (docs/DESIGN-LEAVE.md
§9): every later scoped rule (announce-on-change anti-entropy, compaction,
tombstone GC, the drain on leave) must turn a named monitor red when it is
switched off, on a schedule the harness can build, BEFORE the rule lands.
Built by Opus, reviewed three times by Fable; 18 commits; sim only, plus
one kernel line.
Decision: the sim keeps a ledger of every record ever appended to any log
and every tombstone any node released, and ten monitors read it where
`converged()` runs, on stepped scoped nodes. M1 stamp oracle: a cell shown
below a remove its node already covers is a resurrection; its horizon form
compares each holder to the fold of every committed record by stamp, so it
also sees a resurrection every node agrees on, which `converged()` passes.
M2: a scoped compaction keeps winners and stays below every holder's real
floor. M3: nothing older than a released tombstone is ever applied. M4: a
stub until stage 1's index exists (stage 1 made it live). M5: every floor
advance, and a restored node's whole seed, is backed by records the node
holds or covers. M6: at each release, no node, no frame on the wire and no
down node's stored WAL holds an older record the releaser lacks. M7:
holders' floors agree at a quiet point. M8: logs are bounded (red today by
design). M9: a clean leaver keeps nothing only it held (red today at R=1).
M10 resync-end, added when the sweep found a spoke's resync ending on a
stale reply: a resync may end only on the reply to a digest the spoke sent
after the resync began. Each monitor has a planted-violation test and a
non-vacuity count, and each was proven by switching it off and watching a
test go red; M3 and M6 find releases through one shared step but each
stands alone with the other off. The adversaries A1-A11 of §6 run as seeded
schedules over scoped clusters in `sim/scoped-sweep.ts`, each with an
engagement count that proves its chaos bit (A2's key counts a demoted
owner's commit on a partition that moved, nothing looser); 2 seeds per
family in the battery plus every pinned unsafe seed, more with
`FERO_SCOPED_SEEDS`; the pinned set was checked over seeds 1-8 for every
family and 1-12 for A11. A10 (a killed member's frame landing after its
eviction) is representable after all: a sever's link-down travels at the
pair's delay, so the frame lands on a link still up and is applied — the
shared residual of §5, so Q15's one-epoch GC floor is warranted. The
mutation runner performs the releases a broken rule would (one tombstone
and its record dropped at one holder; every tombstone at every holder with
the remove's entry dropped; the stamp only, every lane kept); five pinned
schedules must be caught by M1, M3 or M6; the stamp-only mutation is caught
only where an older record still arrives (A1, A11), because today every
lane keeps the remove — stage 3's compaction is what makes it bite
everywhere. The pins: the two unscoped holes of V4-31's record are pinned
RED TODAY in `sim/scale-probes.test.ts`, built without test seams (a short
lane brings a removed row back after GC and compaction; a write stranded on
an evicted owner beats a newer remove after a heal), each asserting today's
wrong outcome so the fix flips it; three counted floors from a frame tally
that reads each frame's verb at the sink (idle: members send n(n−1) digests
per tick; 300 writes cost 1,067 HAVEQ; one join at n=30, R=3, 300 rows
costs 2,446 HAVEQ — the record said 2,555 because the panel's probe fired
its writes inside the window it called idle); and two shapes the sweep
found unsafe on today's kernel, pinned with their findings (STATUS): one
forwarded write committed twice across an ownership move (A3 seed 6, the
zombie's class), and a spoke's resync ending on a stale digest reply (A11
seeds 2, 5, 6, 10). The kernel line: the record's §2 asked whether a
restored floor could claim rows the disk never kept. It can: the boot
record is written synchronously and carries each floor, while WAL rows are
fsynced later, so a crash between them restored a floor for rows that were
gone. A restored possession floor is now capped at the durable floor; rows
up to it are on disk, and replay advances the floor from there. Today the
member digest re-sent the lost rows, so the node healed; stage 2 retires
that digest, which would have made the overclaim permanent.
REJECTED: a test seam to move ownership for the red-today pins (a clean
leave does it); calling A10 "not representable" (a Fable review showed the
shape with an asymmetric delay); the loose A2 engagement key; a pinned set
that claims to be exact over seed ranges never swept.
Consequences: 662 → 689 tests; no perf pin moved; the exec golden, the
300-seed sweep, 59,500 and 104,050 unchanged. Only scoped durable restart
trajectories moved for the floor cap (4 of 12 of the restart family, 0 of
the 25 CHURN seeds). The sweep costs about 25-40 s in the battery at low
priority. Not yet in the harness: M6's wire and WAL legs have no planted
test; the sweep builds no n=1, n=8 or durable cluster outside A4; there is
no oracle for spokes on a scoped cluster (M1's horizon form skips them).

## V4-33 — DESIGN-SCALE stage 1 without the drain: the `acked` effect, the owner re-check of a forwarded remove, the per-partition indexes (2026-10-09)
Context: three parts of the stage-1 row of docs/DESIGN-SCALE.md §7 were
owner-independent and are what stages 2-4 build on; the drain-then-go
(Q8) was held back until the owner answered (they did, V4-31; it is the
next wave's). Built by Fable, reviewed three times by Opus.
Decision: (1) The `acked` effect. An ARMED owner names the lane it stamped
on, with its incarnation, in its WACK (`o`). When that WACK clears an
attempt this node issued and the record can never fold here — a scoped
member that does not hold, acquire or get assigned the partition — the
kernel emits a new optional effect `sink.acked(iss, cid, origin, seq,
epoch)`, and the api settles the write's promise from it, committed on the
owner's lane, through the same idempotent path as `lost`. A relay hops `o`
to its spoke only when the relay itself will not tap the record, so a
spoke settles from `acked` only when its feeder's tap will stay silent.
Where the record will fold here the WACK stays silent and the apply join
settles after the value shows, as V4-7 asks. The decision is not made only
once: the kernel keeps every cleared attempt whose record is still expected
(write.ts `#awaiting`), the fold sites drop the entry when the record
lands, and the install's rescope settles every entry whose partition no
longer folds here (an aborted latch, a new orphan, an unassigned
partition): `acked` for an own attempt, a second WACK carrying the lane for
a relayed one, which its spoke reads as the settlement for its own cid.
Every commit that enters the dedup window names the lane (the local
commit, the WACK, the inbound fold, the ACQ fold, WAL replay), so a write
re-sent after a lost WACK is answered with it. Unscoped nodes and clients
never set, read or keep any of this. This closes the STATUS bug
"`methods.update` from a node that does not hold the partition never
resolves committed" for every shape the reviews named (a non-holder, a
co-holder acquiring, a co-holder assigned with no entry, a spoke through
either); one residual stays on STATUS: a spoke whose feeder dies between
the WACK and the tap. Rules the old hang had hidden: the lens swallowed a
delete of a cell absent from the local fold as a no-op, which on a scoped
non-holder is wrong (the row lives at the owner); now a scoped node's fold
speaks only for the partitions it holds (Bind `#local`), and a client's
rule fails toward sending — the kernel remembers the contract of every
primary it elects and answers with it while there is no primary (an outage
keeps the fold's judgment), and with no contract known at all (before the
first HELLO) the api forwards the delete. `until()` in #utils now awaits an
async check: nine `until(async …)` pins in api/scoped.test.ts could never
fail before. (2) The owner re-check (Q12). NodeOpts gains `admit(rec)`; the
api passes the sparse-hole half of Bind.admit. An armed owner runs it on a
member-forwarded remove whose key is below the row (the issuer could not
see the row's shape): refused ⇒ WNACK invalid with the reason, so the
issuer sees the same typed `sparse-hole` reject a local refusal gives; a
partition whose fold is staged (an open latch) ⇒ withheld, re-forwarded
after the fold. Updates, row removes and unscoped nodes are never asked.
(3) The per-partition indexes. Node gains `byPart` (partition → lane →
that lane's entries of the partition, ascending, the same objects the lanes
hold) and `tombs` (partition → the cells whose version is a tombstone),
allocated with `scope` and null unscoped, so an unscoped node pays one null
check per site. Every site that adds or removes a lane entry keeps byPart
in step (commit, inbound, splice, both replay branches, the ACQDONE fold,
the shed, compaction, the fold reset); apply's remove arm, its sweep and
its live-again arm, tombstone GC, the shed and the fold reset keep tombs.
`#teach`, `#tailsOf`, `#abort`, `#shed` and rescope's partition census read
through them, with lanes visited in node.logs order so frame order did not
move; the shed also drops the partition's floors from every stream. M4
index-oracle re-derives both indexes after every event of a stepped scoped
node; dropping one site turns it red. Pin R1 (kernel/scope.perf.ts, the
two nodes timed interleaved): teaching a 1,000-entry partition from a
200,000-entry node costs at most 2× the same partition from a 1,000-entry
node — 1.08 at landing, 9.40 with the old walk.
REJECTED: deciding `acked` once at the WACK (a view change could then
strand the write); a narrowed STATUS line instead of the rescope
settlement; a settlement hook in `#abort` (an abort to orphan keeps the
duty; the rescope covers every reachable case); the drain in this wave.
Consequences: 689 → 701 tests, 47 → 48 pins; the golden, the sweep, 59,500
and 104,050 unchanged. The wire gains an optional WACK key `o` an old node
ignores, and a relay may send its spoke a second WACK for an already-
cleared cid at a rescope (an old client ignores it): no MAGIC bump
(V4-14). A behaviour change on every client before its first HELLO: a
delete of a row the client has never seen now issues a remove (it was
swallowed), so a forwarded delete of a row absent at the owner commits a
tombstone for nothing, as `methods.remove` of an absent key does. Still
open: the feeder-death residual (STATUS); M9 stays red at R=1 until the
drain; env.ts's "never fires where the record will fold here" promise is
now "the api absorbs a repeat".

## V4-34 — one redial chain per target; the sim's restart drops the old life's echoes; the relay is pinned (2026-10-09)
Context: three leftovers of the door's reviews (STATUS, 2026-10-09).
`#redial` never checked for a timer already pending toward its target, so a
crossing pair cut while both links were up armed two timer lines on one
backoff entry that shared the tries, and the chain — with the eviction hold
it carries — gave up in about half its time; a sweep found it in about a
quarter of pair schedules on both paths. The sim's restart left the first
life's timer fires and WAL echoes in the queue, and a reborn node numbered
its timers from 1 again, so a `TAG.prove` deadline fired at 12 ms and the
node refused an honest peer `timeout`. And since V4-28 every open server
runs a check on each relayed client record with no pin on that path.
Built by Opus, reviewed three times by Fable.
Decision: (1) A redial timer already pending toward a target owns that
target: `#redial` walks the timer map and arms nothing if it finds one (the
rule the view install already follows, V4-28; one walk per linkDown over a
handful of timers). The guard alone was wrong for a crashed member in two
measured cases (an identify deletes the backoff entry but leaves an older
chain's timer pending, up to 32× the base delay away; on the open path the
peer closes my duplicate dial before I identified it and that close starts
a GENERIC chain toward a live member), so a dead member's linkDown that
finds anything other than a member chain cancels it and starts the member
chain fresh at the base delay (V4-20's clock); a member chain already
running is never restarted. A NON-member linkDown that finds an orphaned
timer with no entry writes a fresh entry (tries 0), so `dialing()` reads
true while that timer is out and a view install leaves the peer to it. (2)
Sim only: `Sim.add` bumps a life number per uuid and the sink it makes
captures it; a timer fire, a `persisted` or a `persistFail` scheduled by an
earlier life is dropped when it falls due, at the persist site and the
snapshot swap site. The queue entry still runs, so the event count is
unchanged. A real shell already cancels its timers on destroy. (3)
tests/baseline.perf.ts pins one client's relayed updates through a solo
open server that uses the composer's own check: 512 updates mean 512
checks, 512 commits, 0 pending, exactly one stream frame and one WACK out
(exact on any machine; CI's `^counts:` run takes it), and a wall tripwire
of 80 ms per 512.
REJECTED: cancelling the pending timer and re-arming from every second
linkDown (the backoff would restart, the lengthening V4-20 rejected);
letting the one-chain guard alone decide for a dead member (eviction
delayed by up to 3.2 s, or back at about 20 s through a generic chain);
dropping the non-member orphan entry (it keeps the view install from a
second dial, pinned); starting a reborn node's timer ids above the old
life's (WAL batch numbers would need the same trick; one life tag covers
both); the relay count as a row of baseline.json.
Consequences: the sweep golden in sim/exec.test.ts moved for 2 of its 20
seeds, 11 (270 → 252 events) and 17 (224 → 219), exactly the two whose cut
armed a second line; 18 are byte-identical. On the 300-seed sweep 41 seeds
carried a double arm before and 0 now; an independent checker finds none
in 700. A crash soon after a reconnect is evicted within 3.96 s over 600
trials, open and secured (the base had cases near 20 s). Unchanged: the
plain crash eviction (3.41 / 1.41 / 7.91 s), 59,500 and 104,050, AA#2's
1855 give-up, heartbeat revival of a given-up target. On the old exec 72 of
120 restart-at-deadline seeds carried a false `timeout`; none do now. 662 →
670 tests, 47 → 49 pins. Still open (STATUS): on the open path a dup-link
close of my own dial starts a generic chain toward a live member (bounded;
no effect on eviction). Two early commits of the lane are signed by Fable
and the rest by Opus; both models built it.

## V4-35 — 18-secret, the door's rung (2026-10-09)
Context: DESIGN-DOOR §14 Q5 deferred the secret rung to after the door
landed. It landed (V4-30); the rung follows. Built by Fable, reviewed three
times by Opus.
Decision: examples/18-secret sits between 17 and 20 on the ladder, and
01-18 climb one feature at a time. The lesson: the secret is config, never
code or a flag — `FERO_SECRET` in the environment, or `secret:` in a
`fero.opt.ts` in the home directory. Two members started with it form a
cluster; a third started without it is refused at the door, and both ends
say so on stderr, one line per peer and reason, naming `FERO_SECRET` and
the fix; nothing of the refused server lands and it still stops cleanly on
Ctrl-C; the same command with the secret is admitted. The rung uses the
static shape (listen + hosts, directory off) so the lines are exact: the
members never dial the third, so it prints one line per member it dialed
and each member one line for the peer that connected. The role file never
reads the secret; its screen line is `MEMBER <pid> on <addr> — members N`.
The check starts the roles with `fero.spawn` and gives each the environment
its terminal would have and nothing else: `FERO_SECRET` set or not,
`FERO_CONFIG` lifted (the battery pins it off, which silences every
variable), every other `FERO_*` variable dropped, and `HOME` pointed at an
empty folder, all restored afterwards — an unset `HOME` still resolves to
the passwd home, so a `$HOME/fero.opt.ts` with a secret would otherwise
reach the roles. The check reads the refusal lines off the children's
stderr, matches the MEMBER line whole, and asserts over all four roles and
both streams that the secret is printed on no screen.
REJECTED: a role file that prints `secret set|none` from `process.env` (it
lies on the file and call routes); a fourth-member scale-it line (four rows
print over six lines and break the one-line screen rule); a check that
reads only stdout.
Consequences: 28 rungs; +1 test (663 before the other lanes); the check runs
in about 7 s against the default 40 s budget. The members' refusal line is about 170 characters (V4-36 reworded it the
same day, and the README was re-recorded at the merge) and wraps on an
80-column terminal; the wrong-secret line differs from the no-secret line
by the word "by" only; neither was changed.

## V4-36 — the derived client key: a client follows without holding the member secret (2026-10-09)
Context: V4-30 landed the door with one shared secret, so every client held
the member secret, and a dishonest client could omit `r: 1` and be a member
on the wire. DESIGN-DOOR §14 Q2 named the derived client key as the first
follow-up and the owner took that default. Designed in a dated note (§15),
built by Fable in five commits, settled in three Opus review rounds.
Decision: one secret still. The client key is `HMAC-SHA256(secret,
'fero/client/1')` as base64url, 43 characters; `fero.clientKey(secret)`
prints it (also a named export), and an openssl one-liner in README gives
the same string (a test proves they agree; the openssl form does not trim
the secret, fero does). A link is a CLIENT LINK when the DIALER's HELLO says
exactly `r === 1`; both proofs on it, the client's and the member's answer,
are made with the client key, and every other proof with the secret. Why
the dialer's `r` and not the prover's role: the member proves BACK to a
client, and the client holds nothing but the client key; the dialer's `r`
is inside its own proof, so it cannot be checked as a client and admitted
as anything else (a kernel test pins that `sign` and the admit tail make
the same `r === 1` test). The kernel stays crypto-free: `Door` grows one
optional function, `clientMac`; a door without it keeps the one-key rule.
The api builds the doors from one secret: a member, or a client trusted
with the secret, gets `mac = HMAC(secret)` and `clientMac = HMAC(client
key)`; a CLIENT-ONLY process (`secret.client` and no `secret`) holds the
client key under both names, so every proof it can make is a client-key
proof. The config key `secret.client`: the call as `secret: { client }`,
`FERO_SECRET_CLIENT` (per resource `FERO_SHOP_SECRET_CLIENT`), a file;
never a flag; trimmed; 16 characters or more; `''` unset; no off word; a
wrong shape is refused naming `fero.clientKey(secret)`, never the value;
`diag(f).config()` shows `<set>` with the source. A process holds ONE of
the two: `secret` and `secret.client` from any two layers is refused naming
both sources. envdeep nests `FERO_SECRET_CLIENT` under `FERO_SECRET` and the
nested one wins, so the raw environment is read first, every name the way
envdeep reads it (lowercased, split on `_`, empty parts dropped): an empty
`*_SECRET_CLIENT` is dropped, a non-empty one beside its own rung's
`*_SECRET` is refused naming both variables as typed. A server with only
the client key is refused at `fero()`. A launch-flag clash where one flag
is a group of the other (`--fero.secret S --fero.secret.client K`) is named
from the flag names alone, because minimist's error quotes the first flag's
value and that value may be a secret. What it protects: a client-key holder
is admitted only as a client after a client-key proof; without `r: 1` its
proof is checked with the secret and is `bad-proof` the moment it arrives,
so it cannot become a member, vote, write another lane, LEAVE a member out
or take a member's uuid; it cannot learn the secret from the key. What it
does NOT protect, said in README and §15: a client-key holder can pose as
a server to another CLIENT that dials it, because a client can only verify
client-key proofs (a member is never fooled); the directory and the address
rule limit where that is reachable; closing it needs a server signing key
or TLS at the shell. The client key is shared by every client, a leaked one
is a client, there is no per-client identity, and it changes with the
secret. So the feature is "a client that can only follow", not "a client a
member can tell from an impostor".
REJECTED: a second independent secret typed on every member; picking the
key by the prover's role; requiring exactly 43 characters for
`secret.client` (one line later if wanted); an off word; a per-client
identity or revocation (later, with a server key); a new frame, HELLO key
or proof label; a kernel change for the open-path redial loop found on the
way (below).
Consequences: no new frame and no new HMAC per link; one HMAC per process
at `fero()` time; 59,500 and 104,050 unchanged; the config walk gains one
LEAVES row (api/config.perf.ts about 80 µs per resolve, ceiling 500). 662 →
670 tests. A client that held the secret proves with the derived key now,
which the member checks with the same derivation, so nothing an operator
set changes. Found and recorded, not fixed (STATUS): on the OPEN path a
client refused `uuid-taken` reads only a bare close, so it redials at its
redial cadence for good and the member journals one row per dial.

## V4-37 — I-20 design first: the safety argument per vote source, the adversarial harness on today's kernel, and the three holes the argument's own reviews found (2026-10-10)
Context: three fix rounds of the parked I-20 branch (DESIGN-LEAVE §0) each argued one vote source and broke on another, and the reviewers' generators that found the holes died with their scratch folders. The owner chose design first (V4-31): the argument and the harness before any code, the zero-risk knock window first. This step wrote the argument, built the harness, and had the argument reviewed three times the same day. No kernel line changed.
Decision:
- The invariant every rule must keep is the sweep's split check, not one view per epoch alone: at no quiet point are two nodes writable in different views, at any epochs (DESIGN-LEAVE §10.1). One view per epoch is one way to break it; a stale majority of an old view writable beside the view without it is the other, and the per-event monitor cannot see it.
- The argument, one page per vote source (§10.2-§10.6), concludes: a LIVE GRANT keeps one view per epoch by vote-once over one old view, and keeps the writable split only by arithmetic for a ballot that changes one member, so the multi-suspect eviction at five members breaks it, and so does a ballot kept across an install (below); a PLEDGE may complete exactly one change, the pledger's own view minus members who asked to leave, and every wider use is a vote for a change the voter never gave — and even so restricted it is unsafe with two pledgers at n ≥ 5, because a stayer's gate counts a read-only leaver's link (pledgeTwo); a LEAVER'S OWN PROPOSAL and a leaver lingering after `left` are safe on today's kernel and cost liveness only; on a RESTART the base's restored leaver is safe by the one-member count and live, the branch's floor is the right idea on the wrong condition, a forgotten pledge is a lost vote and never a second one, and a restored leaver may lead, announce and write nothing — but its GRANT is sound only as a re-grant to the same proposer at the same epoch: a new grant while its vote sits above its view is the spend that makes two views (evictTwoB, keptBallot); a COMMIT THE VOTER NEVER SEES is the pledge's defining trade, and its price is that a pledged leaver that times out and restarts is read-only until told, for good at three members when the one stayer is dead (H12), a price recommended not to accept as a blanket rule and not before the knock window.
- Today's kernel has THREE holes of its own, found by the argument and the harness together and pinned red on the base. Two are one ballot that evicts two suspects at once at five members with the third voter cut or crashed right after its grant: two views commit at one epoch and both sides write. In `evictTwo` the stale voter is the far side's lowest member and leads; in `evictTwoB` (the second review) it is not, a never-voted member leads, and the stale voter GRANTS its higher ballot over the old view. Seeds 1, 2, 4 and 5 of 5 each; the one-evictee control never splits; the parked branch has them too. The third (the third review) is a ballot KEPT across an install: at four members the loser of a duel at 2 escalates to `{aa,cc,dd}`@3 over view 1, installs `{bb,cc,dd}`@2 evicted, keeps the ballot and commits it on two granters at view 2 — the view it commits is two members apart from the view it was kept across, so the one-member count does not protect it; two writable views at the quiet point, two views at epoch 4 once the chains give up (`keptBallot`, one fixed schedule on real Nodes). The page had called that shape undrawn. STATUS carries all three as bugs of the kernel.
- The rule for those holes is NOT finished, and this is the second and third reviews' finding. The first draft's "a vote above my view closes my gate and I lead nothing" was built on a scratch kernel: it turns evictTwo green and leaves evictTwoB red on the same four seeds, and clears keptBallot's quiet point but not its epoch-4 split (the stale voter grants at 4 holding a vote at 3). The rule needs a third part, the grant: (α) a node whose vote sits above its view grants no new ballot that keeps it in (the same-proposer same-epoch re-grant stays; a LEAVER's exit stays grantable), or (β) a PROPOSE carries the epoch of the view it is over and a voter refuses a ballot over a view below its vote, which also settles the kept ballot at the voter. With (α) the scratch kernel is safe on every family and closes all three. What it costs, measured: pledgeTwo's far side settles on 0 of 5 (today 5 of 5), evictsplit and joinsplit 0 of 10 (two parts alone leave them settled), the isolate grid loses the 36 five-millisecond cases, the seeded family 11 of 50, rebirth 6 of 100, the sweep 7 of 200, the crash grid 4 of 96 that are not H12's (the stayer comes back, nothing ever proposes a view at or above the failed ballot, a leaver holds its vote for good) — and, the third review's finding, EVERY live member of a healthy cluster for good whenever a ballot fails there: one member flaps during an eviction ballot and the proposer abandons it, or the proposer crashes mid-ballot, open or committed with its VIEW unsent. That cost falls on the gate and lead parts alone as much as on the grant (measured on both scratch kernels; today's kernel heals both: `flapDuringBallot`, `proposerCrash`, pinned writable), and the one release the second draft named — the vote's proposer reporting its ballot uncommitted — cannot fire with the proposer dead. So the open question, to be answered on the step-2 page before a line is written, is the RELEASE for a vote whose ballot failed and that nothing supersedes: it must fire with the proposer dead, fire when the proposer abandoned the ballot, and never fire while a majority of the old view may still commit the vote. The base's alarmed release is unsafe for it (it would reopen evictTwoB's far side). §10.2 lists three candidates to weigh, none argued: the proposer's report (fails with the proposer dead); a hold that ages out with the ballot (the proposer may commit on its last tick); a hold bound only to ballots that change two or more members, since the one-member count already protects every other ballot, the crash's committed variant included (a per-ballot fact the voter must learn from the PROPOSE, a wire change of (β)'s class).
- The zero-risk candidate (§10.7) adds no vote source: a leaver spends a tick of its bound only while it has no admitted link to a member that has neither knocked LEAVE at it nor proposed its own exit to it, and otherwise keeps knocking up to a window the operator sets; nothing is counted without a link, nothing is seeded, nothing is remembered across a restart, so every argument above holds line for line. It does not cover a survivor stalled longer than the window. It costs a slow Ctrl-C while the survivor stalls, a shell cap that grows with the window, and one config key the tune row does not have today. It is built first.
- The harness exists (sim/leave-harness.ts, sim/leave-harness.test.ts; §10.8): the round-2 cut-and-rebirth generator with leavers reborn as NEW identities and the reviewer's seed-157 and n=3 two-stop shapes as fixed schedules; the round-3 isolate grid of 108 and a seeded stale-stayer family with a joiner on the proposer's side; the evictsplit and joinsplit pins; the first review's n=4 two-leaver schedule; pledgeTwo with its cut the instant the proposer has read both knocks (a 3 ms cut lets the VOTEs in flight land, both kernels commit a four-member view, and the family has no teeth — the second review's catch); evictTwo and evictTwoB; keptBallot, flapDuringBallot and proposerCrash as fixed schedules move by move on real Nodes (the third review's probes); the round-3 crash grid (96 by default, 576 with FERO_LEAVE_FULL=1); the mesh explorer with an opt-in quiet-point split check, and hand pins for both split checks (an epoch-0 node is in no view and is no side of a split). Safety is asserted on every schedule, in its own test or its own line; liveness is pinned as exact sets in both directions and never in the same list as safety, pledgeTwo's, evictsplit's and joinsplit's settled sets and the two failed-ballot shapes' read-only sets included. Today's kernel is the floor: rebirth 78 of 100 live, isolate 84 of 108 settled with the cut-off proposer writable on none, crash 86 of 96, pledgeTwo 5 of 5 settled, evictsplit and joinsplit 5 of 5, the flap and the crash writable everywhere, explorer 300 clean. Teeth, measured by overlaying each parked kernel on a scratch copy: round 0 splits twoLeavers 10 of 10 (H1); the review fix wedges both n=3 shapes (H3); round 1 loses seed 157 (H7); rounds 1 and 3 split evictsplit, joinsplit, the isolate grid (11 and 9 of 108) and the seeded family (12 and 8 of 100) (H11); round 3 wedges the 24 crash-twin cases (H12), loses 3 of 1200 rebirth seeds the base heals (H9), and splits pledgeTwo 5 of 5; the rebirth test's three liveness teeth print in one list, so each fires on its own on the kernel it is for. The three red pins and the two cost pins turn red on the scratch candidate kernels with their own messages. About 18 s alone at low priority, 30 s under load.
- Step 3's order (§10.9): the knock window; then the page for "a vote above my view" — gate, lead and GRANT, what a stale stayer's gate may count, and the release — whose acceptance is evictTwo, evictTwoB AND keptBallot green, every family safe, flapDuringBallot and proposerCrash WRITABLE everywhere as on the base (a rule that leaves them read-only has no release and is not done), pledgeTwo safe (not necessarily settled), and every liveness pin and red-today witness (the three pins and the quiet-point test's evictTwo run) moved only with the why; then, if still wanted, the pledge restricted to one change on top of that rule, with the owner's yes or no on H12 in writing; and a review of the argument before any of them.
REJECTED: the two-part rule as the step-2 acceptance (it closes one hole of three and leaves the kept ballot's epoch-4 split); asserting liveness on any family or in any safety list, pledgeTwo's, evictsplit's and joinsplit's far sides included (the floor is counted, never claimed); rebuilding the reviewer's seeds 469, 740 and 1077 as named shapes (the reports omit the slow-link pairs and a cut's length; their count reproduces instead); reborn leavers under the same uuid without a dir (fero never does it); fixing evictTwo, evictTwoB or keptBallot in this step (design first means the rule gets its page, and its release, before its code); the alarmed release as that release (unsafe); designing the release on this page (three candidates are listed, none argued).
Consequences: STATUS's I-20 line says the argument and the harness exist, that today's kernel has three known splits, names the knock window as next and the step-2 page with its release as the open design question; STATUS gains the two-evictee line (evictTwo and evictTwoB) and its kept-ballot line becomes a bug line of today's kernel, red today as keptBallot; the harness adds 12 tests (730 in the battery) and about 18-30 s; a kernel change on any leave, eviction, grant or restart path runs sim/leave-harness.test.ts and diffs its pins against this entry's numbers; a kernel that turns evictTwo green must turn evictTwoB and keptBallot green too and must leave flapDuringBallot and proposerCrash writable.

## V4-38 — DESIGN-SCALE stage 1 (b): drain-then-go, a scoped clean leave hands its partitions over before it goes (2026-10-10)
Context: docs/DESIGN-SCALE.md §7's stage-1 row has four parts; three landed in V4-33 and the fourth, the drain (part (b), §14 Q8), waited for the owner, who said yes (V4-31). Until now a clean leave on a scoped member ended at the exit proof (V4-6): the view without the leaver committed, a survivor echoed it, and the shell tore the node down. At `replicas: 1` that took the only copy of the leaver's rows with it: the new holder's acquisition raced the teardown, and the harness's M9 leave-drain monitor was red today at R=1 (V4-32). The owner's wish was plain: scaling down loses nothing.
Decision: (1) What "drained" means: the shed bar. The install that takes the leaver out of the view freezes every partition it held into an orphan (kernel/scope.ts rescope) and the new holders acquire from it as from any orphan. A partition is drained when every REACHABLE current holder (an admitted, live link) has attested, in a HAVEA ok answer or a HAVEQ announcement, floors at or above the orphan's frozen content tails on every lane. That bar is ONE predicate, `covers(per, lanes)` in kernel/scope.ts, read by `evaluateSheds` (the shed), `Scope.undrained` (the drain, returning `waiting` and `stranded` counts) and `shedWaitingOn` (the H7 surface), so the three cannot drift apart; an ok answer whose floors sit below the tail is not cover, because under the pp law floors lawfully under-claim (M6 findings 12/21). When every holder covers, the entry sheds and leaves the count by construction: the journal reads orphaned → teachShip → shed → left. The acquirer's ACQDONE is not proof; its attestation follows its fold (durable: its snapshot echo, `sealed`) on the leaver's next shed poll. (2) Where the hold lives: `Membership.#finishLeave` no longer ends a scoped leave at the exit proof. It marks the view half done (`leaving.done`) and asks `#exit` whenever the node is armed and either the view half was clean or its own view no longer holds it: something waiting and the heartbeat clock on ⇒ hold `left`, count drain ticks (`leaving.drain`) against the new tune row `drainTicks` (default 16, a row and not a config key) and carry the view half's verdict (`leaving.clean`); the tick re-checks, and the scope calls `membership.drain()` after every `evaluateSheds`, so a shed or an attestation ends the wait the instant it lands. The final `left` is clean only when BOTH halves were: a leaver bounded out of the view half after committing the shrunk view itself (the proposer; every survivor echo lost inside leaveTicks) still drains — its partitions are orphans with reachable holders all the same — but goes b=0 even when every holder covers, since the commit was never proved to have reached a survivor; a late echo during the drain does not re-open the view half. (3) When it goes anyway: past the bound, or when nobody can be drained to — every holder of some partition unreachable, or the solo view (the last member, reached through `leave()`'s "nothing to leave" branch, which asks `#exit` too on an armed node) — the leaver goes at once with a new journal row `undrained` (a = partitions, b = epoch) and `left` b=0. `left` b=0 therefore has two readings, told apart by the `undrained` row before it: none ⇒ the view half was not proved (a leaver still in its own view goes like a crash and drains nothing; one out of its own view drained everything it could), a row ⇒ that many partitions went with it. Heartbeats off: no drain clock and no shed poll, so the leaver decides at once from the evidence. (4) The surfaces: `Runtime.leave()`'s wall-clock cap adds `drainTicks` on a scoped node (23 ticks, 11.5 s at the default cadence, so a lawful stop can outlast `fero.spawn`'s 5 s grace and run past docker stop's 10 s; the README says so, the grace is not raised); `destroy()` resolves the verdict (`Promise<boolean>`); the diagnostics `crash()` door resolves the same teardown verdict, always false (no leave, no drain; `Promise<boolean>`); the api folds `undrained` into `cluster.me.undrained` — on `me`, not on `cluster.partitions` as §9 listed it, because a stopping node paints no partitions frame; the ELI5 gains `undrained` and re-reads `left`. (5) What stays: the ballot rules, the vote count, the knock window and `leaving.ticks` are untouched. A leaver cut off while draining has left its own view; when the survivors installed it too they never suspect or evict it, and a leaver bounded out of the view half, which they may still hold, may be evicted under V4-20 while it drains at no cost (cut off, it is stranded and goes at the next tick); it goes at the bound, or at the next tick once every holder is unreachable (a link loss is not a tick). Two leavers at once: the first drains to the second, which drains on. Unscoped leavers never reach `#exit`: byte-identical. (6) Readings of the §7 row and §6 I13 that were settled: nobody-to-drain-to is `left(false)` with `undrained` counted (I13 amended); the hold waits for every REACHABLE holder, leaving or not; at R≥2 an unreachable holder does not hold the leaver once the reachable ones cover (left(true), the orphan stays for the teardown); a vote that never came back, the leaver still in its own view, goes at leaveTicks + 1 and never drains — `undrained` counts the drain window only, so at R=1 those rows go uncounted (README, api/types.ts). (7) A cost the row chose, named and left to the owner: at R=1 a new holder that crashes mid-drain takes with it the rows it was about to receive; the leaver goes at the next tick with `left(false)` and `undrained` counted — honest, and lost unless it kept a `dir`. Waiting for a re-range while other members are reachable kept every row in a 5-seed probe but ended only just inside the 16-tick bound (the eviction waits out the redial chain).
REJECTED: ending the drain at ACQDONE (a fold is not an attestation; a durable base that never seals must not count); holding with heartbeats off (nothing could end the hold); tracking which peers are leaving to skip them as drain targets (a leaving holder still acquires and drains on; the tracking would touch onPropose, the leave chain's); keeping `destroy(): Promise<void>` (the verdict was computed and dropped); raising `fero.spawn`'s grace (spawn cannot know the child's cadence, and every broken stop in the example checks would wait that long to fail); two or three copies of the shed bar (the review changed one and no test noticed; the H7 surface was the third); reporting a bounded-out leaver's drained stop as clean (the commit was never proved to have reached a survivor); only re-wording the README for the lost-echo case (at R=1 the only copy was going uncounted while its new holder was reachable).
Consequences: 718 → 735 tests (+9 kernel/drain.test.ts incl. the right-event case and the timed-out view half, +3 sim/scale-probes, +2 api/scoped, +1 tests/wal, +1 sweep A7 always-on seed 4 and assertions moved; +1 strictEqual on the crash door inside an existing api test). Perf pins unchanged (59,500, 104,050, the golden, the 300-seed sweep, the idle floor, fan-out, R1 ≤2x). M9 leave-drain flips from red-today to green in the scoped sweep (a violation is unsafe like any other; A7 always runs its n=2 R=1 seed 4) and in sim/scale-probes.test.ts (3→2→1 at R=1 keeps every row; two leavers at once; a leaver cut off mid-drain). Scoped trajectories with leaves moved (A6's leave leg, A7); no counted pin moved. A behaviour change on every scoped member's clean stop: it takes up to 16 heartbeats longer when a holder is slow to attest (about 2-3 heartbeats even when the copy is instant, the shed-poll cadence), the last member's stop resolves false, and a proposer whose echo was lost now copies its rows before it goes. DESIGN-SCALE stage 1 is complete; stages 2-4 follow one at a time.

## V4-39 — the knock window: a leaver keeps knocking while a member that could answer is linked, for a window the operator sets (2026-10-10)
Context: a clean stop (V4-6) gave up after four heartbeats whatever its links looked like. A survivor stalled for longer — a long GC pause, a swap-in — woke to a leaver that was already gone, and with two members that was a permanent wedge (STATUS I-20). The owner chose design first (V4-31): the argument and the harness (V4-37), then the zero-risk candidate of DESIGN-LEAVE §10.7, which adds no vote source and changes no ballot rule. Built in wave 5c, reviewed twice the same day; the review's six findings are settled in the record and in code.
Decision:
- The rule. A tick counts toward the four-tick bound (the tune row `leaveTicks`) only while the leaver has NO admitted, live, non-client link to a member of its committed view that could answer its knock: one that has neither knocked LEAVE at it nor proposed its own exit to it. With such a link up the leaver keeps knocking — a non-lowest member re-knocks LEAVE every tick, the lowest keeps its own exit ballot re-offered — up to `leaveWindow` ticks in all, a new tune row with default 16 (LEAVE_WINDOW). `leaving` carries both counts, `ticks` toward the bound and `total` toward the window. The window never cuts the bound short: the kernel reads max(leaveWindow, leaveTicks), so a row at or below four is the bound alone. At epoch 0 there are no members, so the bound alone applies, as before. Once the leaver's own shrunk view is installed, the survivors are still members of that view and their links keep the window open for the echo. A link that dies is not a tick; from the loss the old bound counts.
- Which links count. The kernel remembers, in memory only (`#leavers`), the members that knocked LEAVE at it (onLeave) or proposed a ballot that leaves its own proposer out (onPropose, beside the `leave(proposer)` journal row V4-25's fix already wrote). The set is pruned of non-members on every install and forgotten for a uuid on a fresh admit (a redial or a new life: a non-lowest leaver still leaving knocks again next tick; the lowest re-offers its ballot only to members that have not voted, so a voter that re-admitted it hears nothing more until the ballot ages out — in the shell the leaver's own teardown closes the link first). A fellow leaver can commit nothing, so its link keeps no window open; at three members with the one stayer crashed, two leavers go at the old bound once each has heard the other.
- No new vote source. The leaver still votes only in onPropose over a live link, or proposes its own exit; nothing is counted without a link, nothing is seeded, nothing rides the boot record. The kernel's code diff with comments stripped is the two counters, the set, `#answerable`, the constant and three `#leavers` lines; the grant expression, onVote, #propose, #nextEpoch, gate() and majority() are byte-identical. No new frame, no new journal kind.
- The default is 16 ticks because it is the drain's number (the README says 16 heartbeats for both halves of a scoped stop), 8 s at the default cadence covers the stalls a process meets, and an unscoped stop's shell cap (the window plus two ticks, 9 s) stays inside docker stop's 10 s grace. A healthy survivor answers in the first tick or two, so nothing changes for it.
- The config key is `leave.ms` (V4-10: the call `leave: { ms }`, `--fero.leave.ms`, `FERO_LEAVE_MS`, a fero.opt file, and the name rung in each). The composer divides by the effective heartbeat and rounds up into the row; 0 (or anything under four heartbeats) means the bound alone; with heartbeats off there is no clock and the row stays at its default. The diagnostics door shows the value set or the effective default (8000 at 500 ms; nothing with heartbeats off and nothing set), and `diag(f).tune()` shows the row the node runs with. Two tune rows have a fero() key now: redial.tries and leave.ms. Two consequences in the config layer: `leave` is a reserved resource name, as every declared top-level name is — a resource named exactly `leave` and configured through its own rung stops every resource in the process from starting (the README lists the reserved names); and the layer's near-miss rule changed, because `leave` is two edits from live, lease, level, league, save, wave and lane (and `seams` from teams, `diag` from dial on the base), so a sibling resource so named refused to start. An undeclared top-level object within two edits of a group is a typo only when it holds one of that group's own options (`heartbeats: { ms }`, `lease: { ms }`, `seam: { validation }`), and the hint names that leaf; one that holds none (`live: { heartbeat }`, `teams: { dir }`, `live: { heartbeats }`) is a sibling's rung, whatever its name is near, and a typo inside it is that sibling's to catch when it composes. A first fix that asked for ANY declared name in the object let `seam: { validation }` pass silently and blamed `leave.ms` for a typo inside `live`'s rung; the review's second look caught both.
- The shell's destroy cap follows: max(leaveWindow, leaveTicks) + (the drain + 1 on a scoped node) + 2 ticks — 18 ticks unscoped, 35 ticks (17.5 s) scoped when the survivor was stalled AND a holder is slow to attest; the usual stop is one or two heartbeats. The cap is clamped to Node's timer ceiling (2^31 − 1 ms, about 24.8 days): setTimeout fires a longer delay after 1 ms, so a huge `leave.ms` — an operator meaning 'wait as long as it takes' — made every stop with a slow survivor a crash within milliseconds, before the kernel ticked once. fero.spawn's 5 s grace is not raised; a stop cut short reads `null`, as the README says.
- The sweep's stalled survivor is a PAUSE now (Sim.pause: every event bound for the node held in order and replayed at the wake, each as its own event, so the monitors run between them as after every other event — the first build replayed the batch in one task and one-view-per-epoch sampled the woken node once per batch, 12 of 64 wakes in family 1 passing through two to four views unsampled; `cluster()` takes tune; run/run2 take the window and a stall factor). The old model, a constant delay on every link lifted once the leavers were gone, stays beside it as its own pinned family: a survivor alive but SLOW, each knock and each answer paying the stall in turn, the second shape of I-20 — the build first claimed it could never go live under the window, the review measured it and that was false. Re-derived on the base kernel first: pause 25 of 100 not live, delay 36 (the eleven that differ had the stalled node not the proposer; under the pause its vote landed inside the proposal's age once it woke). With the window: pause 0 of 100 at the default, 22 with the pauses tripled (750-2100 ms against the 800 ms window — every 300/450/700 ms stall tripled, the class the window does not cover) and 0 at a 64-tick window; delay 36 → 20 at the default and 1 at 64 ticks (seed 42: three leaves in turn at four stalls a round trip outlast 3.2 s; live at 200 ticks); family 2 13 → 10 (4, 44, 89 live: a leaver cut from the proposer but linked to another member knocked on until the cut healed inside the window), the same 10 at 64 ticks since a longer window heals no cut; family 3 safe on every seed. The harness: only rebirth moved, 78 → 80 of 100 live (seeds 61 and 72, the same cut-then-heal shape under a 300 ms cut); the isolate grid's 24, the seeded family's 8, the crash grid's 10, pledgeTwo's, evictsplit's and joinsplit's settled sets, evictTwo, evictTwoB and keptBallot red exactly as pinned, flapDuringBallot and proposerCrash writable everywhere, the explorer's 300 clean. The counted pins 59,500 and 104,050, the 20-seed golden and the 300-seed sweep are unchanged.
- A cost the design did not foresee, found by the review and recorded, not fixed: a cluster running on a bare majority (three members with one crashed and not yet evicted, five with two), whichever member stops, the lowest included. Three members, one crashed, a second one stops: the lowest stayer's leave ballot leaves the leaver out, so its new set is {stayer, dead}, whose majority needs the dead member's vote. The leaver knocks the whole window and goes unclean all the same, where before it went at the fifth tick (measured at heartbeat 50 with the third member cut 200 ms before the stop: `left` b=0 at 250 / 850 / 3250 ms for a 4 / 16 / 64-tick window; at the default cadence about 8.5 s, past fero.spawn's 5 s grace; clean in one tick once the eviction ran first). The knocks also starve that eviction: the tick's eviction branch runs only with no ballot in flight, the leave ballot ages out in the same tick after it, and the next knock, between ticks, re-proposes it through onLeave. The outcome is no worse than the base (the stayer sits `minority` either way) but the wait is new and a longer `leave.ms` cannot help. A fix is proposer logic, outside this candidate's scope: a STATUS line of its own, and the README says to let the eviction finish first.
- Tests: eight window tests in kernel/membership.test.ts (a linked leaver knocks past the old bound until the vote lands; the window's end at leaveWindow + 1, the row moving it, a row below the bound being the bound alone; fellow leavers keeping no window open and the admit-forget; the last link dying — a loss is not a tick, the bound counts from it; a link dead on a wire fault before linkDown counting nothing; heartbeats off unchanged; the lowest leaving with a late vote and a later echo; the two round-1 two-leaver shapes at n=3 and n=4 on real Nodes) — six red under the base rule (every leaving tick counts) at the fifth tick, the heartbeats-off and two-leaver tests being guards; two kernel/drain.test.ts cases that assumed the bound fires with both member links up now wait for the window; tests/knock.test.ts stops the survivor's process with SIGSTOP for 1.2 s over real sockets — clean with the window open, `left` b=0 at the fifth tick with it shut, and clean after the wake with a 3e9 ms window (took 0 ms without the clamp); sim/exec.test.ts pins one monitor pass per replayed event (1 pass for 17 steps before); api/config.test.ts carries the key through every layer, the nine sibling names and the three near-miss escapes; api/index.test.ts reads the kernel row through `diag(f).tune()`; every new guard was red before its fix.
REJECTED: counting the window from the knock regardless of links (a survivor whose link is down would wait the window for nothing); letting the window cut the bound short (leave.ms 0 is today's behaviour); a journal row or a frame for the window (no new vocabulary; the ELI5 and the wire are untouched); dropping the delay model from the sweep (it stays measured and pinned as the slow-survivor shape); refusing a huge leave.ms in the composer (the clamp keeps the operator's meaning and the kernel's bound); telling a sibling resource from a typo by ANY declared name in the object (the escapes); renaming the key to dodge the reserved name (V4-10's vocabulary; the clash is named instead); a code fix for the three-member starvation here (proposer logic; the leave chain's); raising fero.spawn's grace (spawn cannot know the child's cadence); any change to the ballot rules, the three splits of §10.2 included (they are the release page's, §10.9 step 2).
Consequences: STATUS's I-20 line narrows from 'about four heartbeats' to 'longer than the window' and gains the slow-survivor model's numbers; a new STATUS line for the knock that reopens an aged-out leave ballot ahead of an evictable suspect; the scoped-leaver line reads the two bounds; 747 → 762 tests (+7 kernel/membership, +1 api/config, +1 api/index, +3 tests/knock, +2 sim/leave-sweep, +1 sim/exec); 50 perf pins unchanged; the leave sweep runs about 16 s idle (was 6); a clean stop whose survivor is stalled, or whose ballot waits on a dead member's vote, takes up to leave.ms (8 s) instead of 2 s, by design; a scoped stop's worst case is 17.5 s (README, api/spawn.ts); `leave` is a reserved resource name (an app with a resource so named, configured through its rung, must rename it); the README's per-resource paragraph lists the reserved names and the near-miss rule as built. Next: the page for 'a vote above my view' and its release (§10.9 step 2), before any pledge.

## V4-40 — DESIGN-SCALE stage 2: announce-on-change anti-entropy replaces the member heartbeat digest on scoped clusters (2026-10-10)
Context: docs/DESIGN-SCALE.md §3 and §7's stage-2 row, the owner's yes on §14 Q1 (V4-31). On a scoped cluster anti-entropy cost n(n−1) DIGEST frames every tick whether or not anything moved (9,900 frames and 2.93 MB per tick at n=100, with a suffix walk that visited 868,353 entries and shipped none), the lag round re-announced every held partition every two ticks under steady writes, and the ring-filtered suffix a digest could ship to a member was a second teacher — the shape the H3 resurrection needs once compaction runs, so stage 3 requires this stage. Built in four commits with the harness green at every step, then three reviews with their fixes; stage 0's monitors and stage 1's indexes are what it stands on.
Decision: (1) On an ARMED node the heartbeat sends no DIGEST on a member link, and the DIGEST handler ships no suffix to a member: the frame still syncs the link and still answers r=0 to r=1 (an admit, a drain), so live records flow, and what the peer lacks it learns through the one-teacher latch with its attested cut. A client link is unchanged: it floors on its digest and gets the held subset. (2) An owner marks the partitions whose floor it ADVANCED AT ITS STAMP SITE dirty (one Set.add per committed record) and at the next tick announces them to each co-holder in one batched HAVEQ per link; the ok answers carry the co-holders' floors back, so marks converge in one round trip. A co-holder that has never attested a held partition is asked every tick until it does. The inbound path marks nothing: a holder's floor moves there only as the echo of the owner's stamp, which the owner announces; a fold, a seal, the arming truing and a boot run their own round; a durable echo rides the next answer (md) or sweep (d). (3) round(node, only?, parts?): the post-fold and sealed rounds go to the acquired partition's holders only, the admit round to the admitted peer for the partitions the two share, the drain round to that peer on every drain of an armed member link (every announcement skipped it while paused), the probe-driven round to the probe partitions' holders, the orphan poll to the current holders; only the install's full round clears the dirty set. The lag round's trails clause is gone. (4) The sweep: each tick the next `aeFan` co-holder links in uuid order, behind a cursor that survives installs, are told every held partition they share, so every pair is re-proved within ⌈c / aeFan⌉ ticks. `aeFan` is a tune row (default 8, AE_FAN), not a config key; 0 switches the sweep off, a measurement posture the counted pins use. Paused links are skipped by every leg. (5) HAVEQ gains three optional top-level keys — `d` (a durable node's durable floors per partition, feeding marksD on the asking leg too), `g` (the partitions the sender is gapless for: content tail equals floor on every lane), `x` (the partitions it just released, sent by the shed to the current holders, batched per link per step; the receiver voids that peer's marks) — and a HAVEA partition gains `g: 1` and `x: 1` (none: neither held nor assigned, where the old code was silent, so a stale pin clears on the next ask). No MAGIC bump (V4-14). (6) A node teaches WHATEVER it holds — a held base, an orphan's frozen content, the pre-latch base of an acquiring entry — with its current floors as the cut (sound whatever its latch state: floors never regress inside a life and a latch stages new records outside the lanes). The digest's suffixes had masked a deadlock: two holders of one partition each ahead on a different lane (an owner change leaves exactly this) latched each other, neither taught, both timed out to orphan on their residue and cycled for ever. (7) The spoke path, which this stage owns: every r=1 a client sends carries `q`, a server's r=0 toward a client echoes it, and a resync ends only on a reply whose q is at or above its own (no q = an old server, ends as before); what a stale reply shipped stays in the fold; in resync a client announces d = {} on every digest; a client of a SCOPED feeder (`replicas=` in the feeder's HELLO contract, node.feederScoped) resyncs at every failover and at a feeder elected at an admit when it holds anything, unioning the sweep set when begun mid-resync. A resync asks ONCE: on this FIFO link the feeder answers an ask in the step that handles it, and an answer whose ship tears is resumed at the feeder's drain with its reply after the whole ship (item 9), so the only way a live feeder leaves an ask unanswered is the ask arriving while its link is paused (swallowed), and the feeder knows that — its drain digest toward a client carries `h: 1`. A spoke in resync sends no heartbeat floor to its primary (the ask is the floor), answers a feeder's r=1 that carries `h: 1` with an r=1 of its own (a fresh q: the exchange ships everything and its reply ends the resync, one exchange after the drain, at any age of the ask), and answers any other r=1 from its feeder with nothing (it was sent before the feeder handled the ask — the heartbeat floor crossing it at a failover — and an r=0 with d = {} bought a second ship). A feeder that dies is a failover, which asks afresh. Members never send or read `q` or `h`; an unscoped client's r=1 gains the one key `q`, and a server's drain digest toward it the one key `h`. The sim's scoped clusters carry the api's contract so a sim spoke reads it as a real one does. (8) The monitors M11 resync-behind and the per-spoke screen check come in from the parked branch w5b/a11; the sweep's verdict names a screen-only row UNSAFE. (9) A TORN answer (the third re-check): the shell steps `pause` inside a send, so a digest answer's suffix ship can pause partway and its bounded queue overflow before the ship ends — link.ts clears the whole queue. The ship stops at that first clear, the link stays unsynced, no reply goes out, and the rest of the answer is kept on the link (`Link.torn`: the peer's tails, the digest's r and q, and the first frame the socket did not take; encodeRuns reports each frame's first record through an optional `starts` out-param; the link counts its clears, `drops`, while droppedWhilePaused stays the sticky debt the drain settles). The drain handler resumes it from that frame BEFORE the drain digest and the drain round, and the reply follows the whole ship; a resume that tears again leaves the drain digest for the drain that completes it; a flush that fills the socket again waits for the next drain. Every drain round delivers at least what the socket takes, so a ship larger than the socket plus the queue still ends. This holds for every link that ships suffixes — a client's (resync, first connect) and an unscoped member's — and the spoke side is unchanged: a torn ship is a late reply, never a missing one. Before: the loop ran on past the clear, the reply went out with the ship's last frames, the spoke's tails rose above the hole, a spoke in resync swept the hole's rows as ghosts, and the drain's h: 1 exchange shipped nothing — 5 of 10 rows lost with a queue of 4, 257 of 600 at the default bound of 256; a first connect and an unscoped member exchange lost the same rows on every tree since M0. The sim could not see it (it posts pause and drain between steps).
REJECTED: marking dirty at the inbound fast path and splice too (R(R−1) entries per write where R−1 do the work; the record's own arithmetic counts R−1); a drain round only after a drop (the round skipped the link while paused); aeFan as a config key (V4-19); a sweep over all member links (P1's law counts co-holders; a link sharing nothing gets no frame); pinning P2 at the record's 1,000 frames / 100 KB (its own §3 arithmetic is 1,600 frames; a sweep frame is ~156 bytes — 250 KB, 11.7× under today; stage 5's 'lanes changed since the last answer' is the next cut); a per-link shared-partition index now (the sweep's walk is O(held × R) per tick; stage 5's install work); resolving the mutual latch by a uuid tie-break (two sequential latches where one symmetric exchange does); wiping the fold under a stale reply (drops cells the screen still shows); a q gated on feederScoped (the stale reply is a crossing, not a scoping fact); re-asking on a tick age — the spoke's own floor every tick, or an answer to the feeder's heartbeat r=1 once the ask was a tick old (the first stage-2 rule: one ship on a normal link, but a ship of the feeder's held subset per heartbeat on a link slower than one heartbeat — 5 and 9 ships at 200 ms each way with a 50 ms heartbeat — because a heartbeat r=1 and a drain r=1 were the same frame); the feeder answering a swallowed ask itself at the drain (it would have to keep the ask and could not tell when its reply was dropped; the drain digest already exists and one key makes it say what it is); 'once per resync' with no further re-ask (a second overflow would strand the resync until a failover); for the torn answer, the reviewer's trial as it stood — stop the ship, send no reply, let the drain's h: 1 re-ask (a spoke in resync asks with d = {}, so it downloads from zero again, and a ship bigger than the socket plus the queue that tears at the same frame each round never ends: a livelock where the loss was); the reply carrying the shipped count as ACQDONE carries n (the spoke cannot tell the ship's records from live tap-forwards, and it still re-asks from zero); resuming from the torn origin's start instead of the tear frame (one origin bigger than the socket plus the queue would tear at the same frame for ever: mutation-checked red).
Consequences: counted floors re-recorded in sim/scale-probes.test.ts and the test named after them — idle member DIGEST per tick 870 → 0 (930 → 0 after a join), the join window's DIGEST 52,110 → 60 (the joiner's 30 admit exchanges), the 300-writes window 1,067 → 5,337 HAVEQ (the sweep plus the owners' announcements) with RECORDS exactly 600, the join 2,446 → 14,791 HAVEQ; new pins P1-P3 in sim/announce.test.ts (P1 200 HAVEQ = HAVEA per idle tick at n=25; P2 1,600 frames and 249,878 bytes per idle tick at n=100 R=3 3,000 rows; P3 one write = 2 RECORDS, 2 HAVEQ, 2 HAVEA, then silence). Unscoped: byte-identical — the golden, the 300-seed sweep, 59,500, 104,050 and the idle law stand; an unscoped spoke's digests across a failover, a full outage and a re-admit are identical to base once q is stripped; a torn member answer changes only under a real socket (it stops, stays unsynced and resumes, where it re-synced over a hole); 50 perf pins pass. Harness: every family safe and live at 2 and 8 seeds (the review compared marks at seeds 9-16 too), A8 heals, floors and marks agree (M7's knowledge form, marksAgree, with the two stage-2 mutations no-sweep and drop-dirty red where they should be); KNOWN_UNSAFE loses A11 seeds 2, 5, 6, 10 (fixed; kept as RESYNC_SEEDS) and A3 seed 6 (safe only because its window does not open on the new trajectory) and gains A2 seed 9 (the double-commit class, the zombie's, unchanged). Three STATUS bug lines close (the stale reply; the scoped spoke's failover below a learned tail; the paused-feeder late end — ended by the drain digest at any age of a swallowed ask, and by the resumed reply after a torn ship: nothing is lost, the four torn-answer tests in kernel/client.test.ts prove it, first connect and the unscoped member link included). A scoped failover ships the new feeder's held subset exactly once on any link speed (the four-seed and the slow-link tests in sim/scale-probes; before the second review's fix, once per heartbeat until the reply landed). The mutation pins follow the trajectory (drop-one on A6 s3, A7 s4, A1 s8; version-only on A11 s7). The retired kernel test: 'AE FILTER — a digest answer ships a member only the partitions ITS R-set covers'. Two debugger fixtures (tools/debug) follow the trajectory, no law changed. One bounded cost recorded: a drain whose drop preceded the ask re-asks once more than needed, one per drop event. Stage 3 (compaction) may now begin; its compaction must keep `Link.torn`'s (origin, seq) resumable or clear it (a note for that stage).
The third re-check (2026-10-10) found two costs of the resume, recorded on STATUS and not fixed here: its CPU grows with the square of a torn ship's size (every drain round re-walks and re-encodes the rest of the torn lane and ships one socket buffer: 160k sparse records cost 15.8 s of feeder CPU over 93 rounds), and a clear that takes a queued r=0 reply with it makes a spoke in resync download the feeder's held subset again from zero through the `h: 1` re-ask (no row is lost). The reviewer's fix for both: find the resume point by binary search and encode only what ships; never overflow the queue on purpose (stop at the next frame when the queue is full); keep the answer resumable until its reply has left the queue.

## V4-41 — the rule for a vote above my view, and its release: two members apart, the proposer's word or supersession, never a clock; the holds ride the HELLO and the ask, and a HELLO that names them is an announcement (2026-10-10)
Context: V4-37 left the I-20 rule unfinished. "A vote above my view closes my gate, I lead nothing, I grant nothing new that keeps me in" closed today's three splits on a scratch kernel but froze every live member of a healthy cluster for good whenever a ballot failed there (one member flaps, the proposer crashes). §10.9 step 2 asked for a page before any kernel line: the rule in full, what a stale stayer's gate may count, and a RELEASE that fires with the proposer dead, fires when the proposer abandoned the ballot, and never fires while the view the vote is for may still be live. This step wrote the page (DESIGN-LEAVE §10.10), grew the harness first with every shape the rule must stay live and safe on, and measured the rule on a scratch kernel copied outside any git tree (docs/leave-release.diff). The page was reviewed four times the same day; each review found something and each is closed on the page, in the harness and in the scratch kernel. No kernel line changed.
Decision:
- The scope. A vote above my view warns (a HOLD) only when it is for a view two or more members apart from the view I hold now, re-read at every install from the vote's member list (votedFor.h). One apart, the count of §10.2 (a) protects every pair of views at a quiet point: two linked members hold the same view, so a writable majority of X and a writable majority of a view one apart from X need n+1 of n members. This is §10.2's third candidate counted against the voter's OWN view, not the proposer's base: it needs no wire change for the count and it catches the kept ballot in both orders (keptBallot, keptBallotReversed). Today's kernel opens a two-apart ballot only as the eviction of two or more suspects at once, as a stale or kept ballot seen from a voter that moved on, and at genesis, where every granter's vote is n apart from its empty view. Every leave, join, one-suspect eviction and rejoin self-ballot holds nobody; that is why flapDuringBallot and proposerCrash stay writable everywhere, where the rule drafted in §10.2 froze them.
- The four parts. A held member's gate is closed (`held`); no stayer counts its link; its own ballots are joint over every view its holds are for (it leads like any member — the lowest live member leads, held or not; a rule under which a held member leads nothing leaves nobody to lead when every live member is held, allHeld and genesisProposerDies); and it grants only a ballot that is joint over the view each of its holds is for, or the same proposer's ballot at the same epoch (today's lost-VOTE heal), or a ballot whose member set IS the held view's members (its new-set majority is that view's majority, so it is joint by construction; without this clause an escalation past a burn left each voter an older vote for the same proposer's same set at the lower epoch, the re-offer was refused, and a frozen cluster burned an epoch at every age-out — now pinned by genesisProposerAndGranterDie's proposal list, which must stay at one epoch). A proposer's ballot is joint over its own holds, over every hold a linked MEMBER of its view named (its HELLO, its asks; at epoch 0 every linked server), and over every hold a refusal names; it commits only with a majority of its old set, its new set, and each held view. Why joint is enough: a ballot over X needs a majority of X; the voters of a committed view M two apart from X were a majority of X too, so the ballot cannot gather its old majority without a held voter's grant, which comes only for a ballot joint over M; a ballot joint over M commits only when a majority of M's members granted it and are therefore not at M, so M can never again have a writable majority. The held view is not released; it is outvoted by its own majority.
- The grant takes form (β). A PROPOSE carries the epoch of the view it is over (`o`) and the held views it is joint over (`j`); a voter refuses a ballot whose base is below its own view (the refusal's `ce` teaches the proposer), and a refusal while held carries the held views (`hm`) so the proposer re-offers joint. No ballot outlives an install at the proposer. The kept ballot therefore dies at the voter: cc and dd refuse aa's {aa,cc,dd}@3 over view 1, and the cluster ends with ONE writable view and more of it live than under (α), where the granters would have been held for good.
- The release, two halves, and a rejection. REJECTED: a hold that ends on a clock. From the voter's seat a committed view whose VIEW was lost and a ballot its proposer dropped look the same; on the clock variant of the scratch kernel releasedEarly splits on seeds 1-4, evictTwo on 1, 2, 4, 5 cut and crash, evictTwoB on 1, 2, 4, 5, lateView's mid point shows two writable views, genesisSplit splits again, freshLinkSim splits through its window — every hole back; the base's alarmed release is the same clock. FIRST HALF, the proposer's word: a held member asks, on every member link, PULL {e, vs:[{e,h,p}]} with its holds; the vote's proposer answers with its VIEW when it holds a view at or above the vote, else, when it holds no open ballot of that identity, DISOWNS it (NACK {e,h}, verb 27). A disowned vote is marked `f`, durably, stays spent for vote-once and warns no more; the next grant to that proposer at that epoch replaces it. It can never be a committing vote: only its proposer installs that ballot, from VOTE frames that reached it after the ballot opened, and the voter's next VOTE re-reads the hold before it leaves; and the word cannot overtake the view on one FIFO link (lateView). It fires on the abandoned ballot (twoFailedBallots, twice). SECOND HALF, supersession: with the proposer dead or cut nothing releases the hold and nothing needs to; the lowest live member leads a ballot joint over it, which commits exactly when a majority of the held view's members are reachable and consent (proposerDeadStale: the four re-form at 3 in all three variants; allHeld at n=7; genesisProposerDies at n=3 and 5), and waits when they are not — the CP answer, Raft's for a follower holding an uncommitted configuration entry.
- What the rule COSTS, named and pinned so the build pays it on purpose, three shapes where supersession cannot fire: the far side of a cut (evictTwo: read-only until the cut heals); the proposer and one granter of a two-evictee ballot dead for good with no cut among the living (proposerAndGranterDie: the third granter and the two evictees frozen, where today's kernel re-forms them — unsafely, since from that seat dead and cut are the same); and the same at epoch 0 (genesisProposerAndGranterDie: one survivor of a genesis ballot, with memory, never forms a view with a newcomer or with the others reborn memory-only, where today it does; it re-proposes at the SAME epoch at every age-out). The remedy is the operator's, as for the crash-at-two class (§7): forget the dead, or start the survivor fresh. The genesis hold is not free; it buys genesisSplit (below).
- Every vote above my view, not the latest. A node remembers every vote it gave above its view (`prior` inside votedFor, so the boot record and both restart paths carry it unchanged), pruned at every install; a disown releases one, a VIEW at or above an epoch releases every vote at or below it. The first scratch kernel kept only the latest and split evictTwo again at epoch 5. The list is unbounded on purpose: a dropped entry is a dropped hold.
- The own vote never warns, in life or restored: the view persists before the VIEW floods and the vote before the PROPOSE leaves, so a restored own vote above the boot view never committed. The leaver needs no exemption: a held leaver's exit is a ballot joint over its hold.
- What a stale stayer's gate may count, and the wire. A stayer counts no link to a member whose last word names a hold above the stayer's view. The wire is two frames that exist already, each carrying the sender's holds as [{e,h,p}]: the HELLO (`v`), so a fresh link is admitted KNOWING them, and the PULL (`vs`), the ask, on every tick while held, the instant the holds change, once more when the last hold ends, and at admit only when they changed while the HELLO was in flight. A HELLO that names holds is itself an announcement (the fourth review): what it said is the sender's last word, so the first change after it goes out as the ask — at epoch 0 the HELLO is the only word there is, and without this a hold it announced was never taken back and a stayer stayed `minority` with a reachable majority until its own ballot, joint over the phantom, aged out and was disowned (helloHold; the cost is one empty ask per member link, once, for a node whose HELLO carried a hold). The receiver keeps what a SERVER last said until that server's next word replaces it — never a clock (the second review: a two-tick memory counted a held member again when its heartbeat was late, lateAsk) and never a window (the third review: forgetting the old link's word at admit and learning the new one from an ask one round trip later had the stayer write at the old view across the cut on every flap, freshLink; measured in the Sim at 5 to 70 split-ms per flap, 0 with the HELLO — and freshLinkSim now pins that on the node's OWN HELLO, which no mesh shape reads because the mesh writes its own: without the node's `v` the window is 15 to 160 ms per flap). A CLIENT's word is never read, not its HELLO's `v` nor its PULL's `vs` (I-23; the third review: one client PULL stopped every ballot of the server it reached, clientAsk; the fourth review pins each half of that fix alone: clientGenesis — one client linked in before genesis stops genesis — and serverAsk — a server in no view widens every ballot), and only a MEMBER's word widens a ballot. The gate needs `e`, the next proposer `h`, the disown `p`. Nothing at epoch 0 but the HELLO.
- Genesis. At genesis the old set is empty, so the joint argument has nothing to bite on by itself; what protects is the grant, the lead and the HELLO: a held node's own ballot is joint over the first view, a held voter grants only such a ballot, and a fresh proposer reads the hold from the held node's HELLO before its first ballot (the genesis condition is a fully-formed mesh). That closes today's genesis split (genesisSplit: two granters cut before the VIEW form {dd,ee}@2 beside {aa,bb,cc}@2, both writable, hostless) and costs genesisProposerAndGranterDie. One gap stays by design: a hold that arises after a HELLO left is learned only from the refusal, so two genesis ballots over overlapping sets in flight at once are a genesis duel the hosts rule (I-22) exists to prevent, not I-20.
- The measurement meets §10.9 step 2's acceptance on the rebuilt scratch kernel: evictTwo, evictTwoB, keptBallot, releasedEarly, keptBallotReversed, lateAsk, freshLink, freshLinkSim and genesisSplit green; every family safe; flapDuringBallot and proposerCrash writable everywhere; pledgeTwo safe and still settled 5 of 5 (its ballot is one apart); clientAsk, clientGenesis, serverAsk, helloHold, allHeld and genesisProposerDies as today; and NOT ONE liveness pin of rebirth, both isolate families, the crash grid, evictsplit, joinsplit or the in-tree sweep moves; the explorer's floors hold; sweep, explorer and membership suites 35/35. The pins that move: the red ones to safe, the quiet-point witness, the mid states of three release shapes to held members, and exactly TWO liveness end states, proposerAndGranterDie and genesisProposerAndGranterDie, frozen on purpose. Every variant is re-measured (timeout, forget, counted, nojoint, nolead, noviewcheck, and the second draft that the third review measured), and each reopens exactly the pins its page row names.
- One pin per kernel line of the wire (the fourth review). Each of the lines the third review added is guarded by a pin that goes red on a scratch kernel missing that one line and nothing else: freshLinkSim for the node's own HELLO `v`; clientGenesis for the client guards; serverAsk for the member filter; genesisProposerAndGranterDie's proposal list for the same-members clause; helloHold for the announcement. Measured on five one-line mutants of the scratch kernel with the pins re-recorded to its values: five of five pass on it, and exactly one is red on each mutant (§10.10.8's mutant table).
- The harness gained eighteen shapes across the four reviews, each pinned on today's kernel first: releasedEarly, proposerDeadStale (open, committed, restart), retrySameEpoch (one, two), twoFailedBallots, lateView; lateAsk, keptBallotReversed, allHeld, genesisProposerDies, proposerAndGranterDie; clientAsk, freshLink, genesisProposerAndGranterDie (fresh, reborn; now with its proposals), genesisSplit; clientGenesis (hello, pull), serverAsk, helloHold, freshLinkSim. 752 tests.
REJECTED: a clock-based release of any length (unsafe, measured); the alarmed release as the release (the same clock); (α) alone as the grant (it holds the kept ballot's granters for good where (β) frees them); counting the two-apart hold against the proposer's base (misses the re-ordered kept ballot); a bound on the list of votes above the view (a dropped entry is a hole); a stayer's memory of a hold that expires (a clock); forgetting a held member's word at a fresh link's admit (a window, measured); silence as the release of a hold a HELLO announced (helloHold: a stayer frozen with a reachable majority for a proposal age); an ask on every member link at every first install as that release (a frame at every genesis install, where one empty ask only after a HELLO that carried a hold costs nothing in the common case); reading a hold from any admitted link (a client's word, I-23) or widening a ballot with a non-member's; "nothing rides HELLO" (the HELLO is the one frame read before a link is counted, which is what the fresh link needs; a key on it is no new frame); a held member that leads nothing (nobody leads when all are held); the pledge (not built; argued safe under this rule because a pledge is a hold from the knock); building any of it in this step (design first).
Consequences: STATUS's I-20 line points at §10.10 for the rule, its wire and its two named costs, and names the build as next; the two split lines say the rule for them is written and measured; a new STATUS line names today's genesis split (genesisSplit) as a base hole; docs/leave-release.diff (six files, +242/−23) is the build's starting point — strip the FERO_SCRATCH_VARIANT line and every use of it, #voteTick, #tickNo and the tick field; give Link the saidHolds field and keep helloHolds setting #lastAsk from a HELLO that names holds; give HELLO's `v` a shape check and sign it in proofMsg as the canonical #keyOf string (consistency with the other HELLO keys, not protection: every PULL `vs` after admission is unsigned); keep holds()'s common-case fast path and let the build's perf pins see the gate's per-call holds() on the write path; the build re-records the moved pins with this entry as the why (freshLinkSim to 0 of 4000 everywhere, the genesis cost's proposal pin to the same epoch with one earlier vote behind bb's) and leaves every other pin as it is; the ELI5 and the debugger learn the gate word `held`, the journal row `release` and the verb NACK; the real-TCP tier measures the ask's traffic and the growth of `prior`; the kernel is still unchanged.
The fourth re-check (2026-10-10) left two minors and two nits, written into §10.10 as open items for the build: a HELLO that names holds sets the node-wide last ask, so at the next install the ask is skipped on member links that never carried that HELLO and a stayer counts a held member for up to a heartbeat (let such a HELLO force the next change's ask onto every member link); two `onAdmit` lines of the diff have no pin (the fresh HELLO replacing a peer's old word, which matters for liveness after a lost release, and the ask at admit when the holds changed in flight); `freshLinkSim` counts every writable split in its window and never checks the two-evictee shape; the signing note must sign `v` inside the JSON array as strings and numbers, say what an old peer does with the new keys, and bump or keep the proof label on purpose (mixed versions are unsupported before 1.0, V4-14).

## V4-42 — the torn digest answer's resume costs: a binary-search resume point, no deliberate overflow, resumable until the reply has left the queue (2026-10-11)
Context: V4-40 item 9 made a torn digest answer resume at the drain. Its third re-check recorded two costs and named the fix (the last paragraph of V4-40, and two STATUS lines). (1) CPU grew with the square of a torn ship. Every drain round re-walked the rest of the torn lane, re-encoded all of it, shipped about one socket buffer, and queued 257 more frames only to clear them. 160k sparse records cost 15.8 s of feeder CPU over 93 rounds (20.8 s on this box). (2) A reply still in the paused queue went out with any later clear (one live tap-forward, or the drain digest right after a resume). A spoke in resync then asked again on h: 1 and downloaded the feeder's whole held subset again. No row was lost, but each such clear cost a full re-download (the re-check's cases B, C and C0). So the premise 'a torn ship is a late reply, never a missing one' was false.
Decision: (1) Each lane's resume point is a binary search. Lanes are in seq order, and a splice inserts at its seq. (2) The answer collects one frame's run at a time by the codec's own rule. The rule is now one exported predicate, continuesRun, and encodeRuns splits by it too, so the frames are the same. A frame is encoded only when it is handed to the link. (3) No deliberate overflow. When the link is paused and its queue is full, the ship stops BEFORE the next frame. The reply is one more frame and follows the same rule. Nothing is cleared, so no encoding is wasted. The drain delivers the queue, then the resume goes on past it. Each drain round delivers the queue plus what the socket takes, so a ship bigger than both still ends. (4) `Link.torn` is a cover map plus the digest's r and q. The map is the peer's tails, raised to what the answer has already handed the link. The resume is just an answer to that map, so it also covers records committed on a lane the answer had already walked while the ship was stopped. While torn, the link stays unsynced, so live records wait instead of overflowing the full queue. (5) `Link.inQueue` holds the cover at the answer's FIRST queued frame (or at its reply, when only the reply is queued). A clear in Link.ship turns it into the torn answer, so the drain re-sends only what the clear took, then the reply. The drain's flush empties inQueue. An answer stays resumable until its reply has left the queue. (6) A cover is a map of tails, so it cannot hold a record below it. A record spliced into a lane's interior under a cover (an armed feeder's dual fence, a scoped fetch fold) lowers that lane's cover to just under it. This happens in Node.indexInsert, the one place every interior insert passes. The check walks only the client links where #answer set a cover (a small set, pruned once a link holds neither cover, and at linkDown), so an interior insert with no answer stopped or queued pays one size check. (7) The drain digest is never sent into a full queue. The debt stays, and the next drain sends it, after the reply. (8) encodeRuns loses its `starts` out-param, and Link loses its `drops` counter (only the old resume used them). The premise is now true: a torn ship or a cleared reply is a late reply, never a missing one. The one ask a live feeder leaves unanswered is an ask that arrived while its link was paused, and the drain digest's h: 1 is for that. node.ts and DESIGN-SCALE (dated notes of 2026-10-11) say so.
The cost claim has one limit. The ship costs what it ships when nothing is spliced under its cover. Lowering a cover re-sends that lane's whole suffix above the splice, frames the peer already holds included. So splices that keep landing under one long torn answer keep moving its resume point back, and its reply waits until they stop. Every row still arrives. A probe (1,000 sparse records, a socket that pauses after every frame, a queue of 4): a splice every round shipped 3,998 records (ideal 1,999) in 999 rounds; every 50 rounds, 110,505 (ideal 1,877) in 43,850 rounds. Splices are cold on a feeder, so this stays, and a STATUS idea names the cheaper shape (a per-link list of spliced entries sent ahead of the cover walk, falling back to lowering the cover past a size cap).
REJECTED: keeping the overflow and only adding the binary search (each round would still encode and clear 257 frames). A dedicated batch-and-carry walk over encodeRuns (a run that crosses a batch boundary gets re-encoded, which is quadratic on a dense lane). Holding the link unsynced until the answer's reply leaves the queue (records committed meanwhile would need their own resume; the clear-to-torn rule covers it with one field). The old origin-skip resume with an (origin, seq) point (it missed records committed on an already-walked lane; the drain exchange had to catch them, and that exchange no longer follows a stop). For now, the per-link splice list (a design change across the resume, the clear and the drain, for a cold path; filed as an idea).
Consequences: measured on this box for a first connect, sparse lane, 64 KiB socket, queue 256: 20k records went from 166-186 ms to 48-55 ms, and 160k from 20.8 s to 246-262 ms, where an untorn ship of 160k is 310 ms. Frames handed to the link: 22,829 -> 20,001 for 20k and 183,903 -> 160,001 for 160k (N plus the reply, each once). aeShip rows: C0 [10, 11] -> [10, 4]; C [2, 8, 11] -> [6, 4, 4]; B [2, 8, 10] -> [6, 4] with no clear. Only a link that really pauses inside a send behaves differently. A stopped ship keeps its queue, writes no dropOldest row and sends no h: 1 drain digest after it, and aeShip counts what the answer handed the link. The sim never pauses inside a send, and an untorn walk ships the same frames in the same order, so the golden, the 300-seed sweep, 59,500 and 104,050 are byte-identical; unscoped wire bytes match base. The four torn-answer tests in kernel/client.test.ts keep their scenarios and their end checks; their middle checks now assert the stop. New tests: C0, C, B, the reply that would overflow, the cover over a walked lane (first connect and resync), a 3,000-record cost probe, a splice under the cover (pause inside frame 2, 7 and 10), a cleared reply with only the reply queued, and a stop on an already-synced link. kernel/node.perf.ts pins the cost on two shapes: handed = sent = N + 1, and 160k / 20k CPU under 20x (about 6-8x measured; 76.7x with the old re-encode put back; 124-134x on the 512-byte, queue-4 shape with a linear resume-point scan put back). The splice cover check's cost per interior insert went from 3,891 ns with 1,000 idle client links to 10-29 ns. Mutations, each caught: no inQueue -> torn on a clear, no drain-digest wait, a cover that skips walked lanes, no stop at a full queue, a reply that may overflow, no cover lowering (either line), no reply-only inQueue, no unsync at a stop, and #covered missing the inQueue add or pruning a link that still holds a cover. The #covered add at the torn line can never turn a test red: tune.queued is at least 1, so a stop always queues a frame first, and that frame's inQueue add already put the link in the set. Two STATUS bug lines close. One older bug, a spliced tap-forward cleared in steady state, is filed (base loses it too). 810 tests + 18, 51 pins. For stage 3: V4-40 asked compaction to keep Link.torn's (origin, seq) resumable. torn is now a cover map answered like any digest, so a resume after compaction ships what the lanes still hold above it, as a fresh answer would.

## V4-43 — a spoke's write settles when its feeder dies between the WACK and the tap: the feeder names the lane as `l`, the spoke keeps it, and the failover's resync end settles what the new feeder did not bring (2026-10-11)
Context: this was the one residual of V4-33's `acked` effect (STATUS; DESIGN-SCALE, the stage-1 second-review note of 2026-10-09). When a client writes to a partition its feeder holds, the write settles when the value arrives on the feeder's tap (V4-7). The feeder sends the WACK first and the tap right behind it on the same link. If the link dies in that gap, the spoke has already dropped the attempt from its queue, so nothing is re-sent. The value then reaches the spoke only if its next feeder holds the partition. The repro (sim/feeder-death.test.ts, n=3 R=2, the tap frame killed in the feeder's buffer by severOnFrame) showed that the usual order does not involve the owner's WACK. The owner flushes its fan-out before it answers. So a co-holder relay folds the record first, the replicated record clears the relayed attempt and hops the WACK at once, and the tap is flushed after it. On four of four seeds the write never settled.
Decision: settle, never re-commit.
(1) An armed relay that expects to tap the record names the owner's lane in its hop to the spoke, as a new optional WACK key `l`. It is set at all three hop sites. The first is the owner's WACK in onAck, where the relay expects the partition and `o` is not hopped. The other two are the replicated record clearing the relayed attempt: in order in inbound, and in the interior in #splice. `o` keeps its meaning: settle now, no tap is coming. `l` means: wait for the tap, but here is where it committed. `l` is an expectation, not a promise: an ACQUIRING relay folds the teacher's copy without tapping it (a STATUS line, older than this change).
(2) A client that reads `l` on a WACK clearing its own attempt keeps the coordinates in write.ts #awaiting while the record is unseen. The fold sites drop the entry when the record lands. A relay's second WACK with `o` (V4-33's rescope) drops it too. The client's dedup window also takes the lane, so the api's probe and sweep resolve on the owner's lane, not under the spoke's own name.
(3) At a primary failover the client marks every kept entry (Writes.strand, from node.ts linkDown). At the end of the resync onto the next feeder (node.ts #resyncEnd), it settles every marked entry still unseen through `acked`, committed on the owner's lane from the WACK's coordinates (Writes.settleStranded). If the next feeder holds the record, the record arrives in its download first and settles through the join, after its value shows, as V4-7 asks. Entries the new feeder WACKed are not marked; they wait for its tap.
(4) A scoped feeder elected at an admit (the failover's second path, when no other link is up) starts a resync when anything is stranded, even with an empty fold, so the resync's end comes.
(5) A client with more than dedupKeep kept entries settles the evicted one from its coordinates instead of forgetting it. A member forgets as before.
Nothing asks the owner's dedup window, so a window that aged out changes nothing, and no WACKed attempt is ever re-sent. So on this path a re-stamped second copy cannot happen; such a copy could overwrite a newer write from another issuer (the A3 seed 6 class). An unscoped feeder never sends `l`, so unscoped clients and members send the same bytes as before.
REJECTED:
- Asking the new feeder to settle each attempt, with the owner answering from its dedup window and an aged-out attempt settling 'unknown' (the plan's shape (a) as written). Once the feeder names the lane, the spoke already holds the answer the window would give, so the round trip, the new frame and the 'unknown' outcome are not needed.
- The new feeder learning the spoke's awaiting set at the resync (shape (b)). It needs a new key on the resync ask, and the feeder would need coordinates it does not have.
- Settling at the failover itself. It pre-empts the join where the next feeder holds the record; mutation-checked red on the control.
- Re-sending the stranded attempts. That re-commits whatever the owner's window has forgotten.
- Making the api's settlement probe skip applies that carry our own issuer identity (it would close the follow-on below). Proving that such an apply is never the only thing that settles a write needs an argument across V4-18's swept field writes and the cross-epoch race. The protocol fix for the trade removes the case anyway.
Consequences: tests 798 → 807; pins unchanged at 50. The golden, the 300-seed sweep, 59,500 and 104,050 are unchanged, and the scoped sweep is green. Two kernel/scoped.test.ts assertions moved on purpose: a relay's hop for a partition it expects to tap now carries `l` (the ACKED test, and ACKED after a view change). The wire gains an optional WACK key `l`, sent only on an armed relay's hop to a client. An old client ignores it, so there is no MAGIC bump (V4-14). env.ts's acked contract now reads: not before the feeder that named `l` is gone (or the entry is evicted past dedupKeep).
One trade the fix makes, which is new and was not there before. Take a next feeder that holds the partition but has not yet received the record when its download leaves. Before this change, that schedule kept V4-7's order. Now the write settles at the resync's end and the value shows as long afterwards as that feeder lags the record (nothing bounds it; 43-48 ms in the pinned schedule, sim/feeder-death.test.ts 'known cost') — or never, while that feeder lives, if it learns the record through the repair latch (which taps nothing) after a later record on that lane has reached the spoke (the second review's probe P2). The trade reaches one step further. A later write of ours to the same cell, WACKed but not yet tapped, can also resolve before its value shows: the early-settled write's late record runs the api's settlement probe. The spoke cannot tell 'holds it but lags' from 'does not hold it' without knowing its new feeder's holdings, so keeping the order needs a new piece of protocol (STATUS).
Costs that stay: a spoke with no feeder at all keeps the write pending until a feeder admits it. A feeder older than this change sends no `l` and still strands its spokes (mixed versions, V4-14).
The STATUS line closes. Two lines enter: the trade, and the wider, older bug the second review found behind it: a feeder that folds records through the latch (an acquire, or the repair round after one lost owner-to-holder frame, with no view change) taps none of them to its spokes, so a spoke whose tail on that lane has passed them never sees those rows while that feeder lives. Probe P2 (n=4, R=3, one owner-to-holder frame lost, 40 later writes, epoch 1 throughout): the spoke's lane reads 9, 11..41, rows 1-8 and 10 missing, on this branch and on the base alike (the base also leaves the write pending for ever). The fix is in kernel/scope.ts (forward to spokes the folded records they expect) and is next week's, with stage 3.

## V4-44 — A sim monitor pass reads only the nodes a step changed (wave 5e, 2026-10-11)
The problem. Every monitor pass used to read every node on every event. At n=100 that cost about 15 ms a pass, more than the event itself. Four cursor monitors (log-monotone, single-writer, attempt-exactly-once, watermark-monotone) took about 3.1 to 3.6 ms each, and the stamp oracle's ledger scan took 3.6 ms.

The rule. A node's state changes only inside its own step. So a monitor that judges one node only needs to look at the nodes that stepped. sim/monitors.ts now puts each per-event monitor in one of three classes, in a table:
- LOCAL: it reads one node's state, or feeds a shared memory from that node's own view or log tail. This covers the nine original monitors plus M2, M4, M5, M10 and M11.
- CROSS-NODE: none runs per event. The cross-node laws are horizon checks, read at a quiet point.
- LEDGER: M1, M3, M6 and M9. These run on the events that touched the ledger.

How a LOCAL monitor walks. It reads the nodes that stepped since the last pass, in node order. It stops at the first violation, as the full walk does. It keeps owing the node that failed, plus any due node it did not reach, so a repeated violation shows up in the same rows.

When a pass reads every node. Three things mark the next pass to read every node, because hand edits and restarts happen there: run() entry, an at() task, and building a Sim.

The ledger's scan. It reads only the stepped nodes, and only when two things are true: it runs inside a monitor pass (Sim.checking), and its last scan ran in the pass just before. A scan made between passes, such as stampOracle's horizon read, reads every node. The pass clears the stepped set when it ends, so the set means nothing between passes. The review found that hole, and it was fixed before merge.

The switch. `Sim.fullWalk = true` before a Sim is built (or `sim.full` on one Sim) keeps the old full walk. It was an environment variable in the lane; the integrator made it a static switch on the class at the merge, because only api/config.ts reads a FERO_* variable (CLAUDE.md) and sim/exec.ts is also stripped into the browser site. With the switch ignored, 41 of the equality suite's 47 tests go red.

The tests. sim/monitor-walk.test.ts (47 tests) runs the same seeded runs both ways and requires the same violation list, the same engagement counts and the same trace of node hashes. It covers:
- one plant per original monitor, at checkEvery 1 and 7, with the scale monitors armed and unarmed;
- the scoped-sweep families, mutated and clean;
- a real attempt-exactly-once violation (A2 seed 9);
- an n=100 run;
- hand edits made outside any step;
- a change made inside a pause replay;
- a ledger read between passes.
One more test pins the stop-at-the-first-violation rule to v4's own answer (n05 is named for epoch 9). Both walks share that code, so comparing the two walks alone could not catch a bug there.

Results. At n=100 a pass costs 0.13 ms instead of 15.0, or 0.46 ms instead of 19.4 with the scale monitors armed. The full battery went from 753 s (798 tests) to 622 s (845 tests). sim/scale.test.ts barely changes (23.0 s to 22.7 s), because it samples the monitors only every 1,000 to 2,000 events. Monitors only read state, so no trajectory, golden or counted pin moved: 59,500 and 104,050 hold.
Built in two hands: Sonnet made the first two commits before Sonnet was blocked for Claude Code on this account; Opus finished it, and Opus reviewed it twice.

## V4-45 — the directory's leftovers: IPv4-mapped loopback, a failed lookup reopened, a failure detector over client links, one directory client per process (2026-10-11)
Decision: (1) IPv4-mapped spellings of loopback ([::ffff:127.0.0.1], the bare, long-zero and hex forms, any legal IPv6 spelling, put first in its one standard form) read as loopback everywhere fero judges a host address: the squat guard, the explicit-listen rule, the off-loopback secret rule and the asking side's guard. They dial and bind the same socket as 127.0.0.1. A mapped routable address stays routable, and a scoped address comes back unchanged. (2) A failed lookup, on this box or an asked box, is opened again after a jittered delay that doubles up to 5 s. The directory keeps its bind, register and lookup troubles apart. A lookup's error clears only when a lookup opened after the failure answers, never because another part succeeded. (3) The #directory host runs a failure detector over its client links. It PINGs every client link every heartbeat, whatever the uuid order, and closes one that has carried nothing for 20 of its heartbeats (10 s at the default). A hung registrant's entry goes with its link. A live one is never closed, whatever its own heartbeat. This is a kernel option (watchClients) set only on the directory host. Without it nothing changes, and no journal kind is added. (4) There is one directory client per process for each directory and settings (heartbeat.ms, redial.ms), counted by reference. The last instance to stop closes it. A server that stops while others stay ALWAYS calls the host's new owner-only unregister, whatever it believes about its own register, because the shared link does not drop. The call carries retry, so it lands after every register that instance sent (same link, call order). It is sent once, at the stop, and never again when a register is answered after the stop. A second call then would drop the live entry of the same identity restarted in the same process (a dir server keeps its uuid), because the host keys unregister by (name, uuid) and the shared link. This reverses DESIGN-DIRECTORY Q5 (a client per instance). A host from before this change lacks unregister, so such an entry lives until the shared link drops. (5) The I-19 probe (a survivor racing the newcomer for the port) did not reproduce the bug. The guard stays. Record: docs/DESIGN-DIRECTORY.md §12.

## V4-46 — the debugger judges each row among its holders, each client by its feeder, a member that left by its tenure, and each resource on its own; the DIAG wire sends deltas, caches log entries and reads a big state in pages (2026-10-11)
Context: the debugger page made three wrong paints, all from comparing nodes that were never meant to match. On a scoped capture each member holds only its own rows, so one fingerprint per node always differed and every node was pilled `differs`. A client, and a member that left cleanly or was voted out, got red stops for rows or writes they were never meant to get. A capture with the user's server beside its `#directory` painted both nodes `differs`. Separately, the attach bridge pulled every node's whole journal and every record book on every rebuild (about every 1.5 s), and a state too big for one frame could not be pulled at all.
Decision: (1) The capture carries two more facts from the kernel, both additive. `held` is the partitions a node's scope machine holds now, sorted; a row being copied in, or frozen on its way out, is not in it. `feeder` is a client's primary link's uuid. (2) A new model fold, agreement(), is the one answer to 'do the nodes agree?'. It works per resource (the node's name). Only members of the resource's newest committed view, and clients, are compared: a member that left keeps a copy that later writes lawfully never reach. In an unscoped resource the old rule stays. Each node has one fingerprint, the strict-majority side is the cluster, and in an even split every side is off. In a scoped resource, each row is compared among the nodes that hold it. These are the members whose `held` names it; the members the ring names as its holders (a writer's `holders` fact on the newest view), so a holder that never got a record of the row, or is still copying it in, counts as lagging; and every client whose feeder holds it. The row's cells are compared by value, and a missing cell disagrees. A node is off when it sits outside a row's strict majority. The header's converged, the node pills, the fingerprint colour and the Cells pane all read this fold. In the Cells pane, a cell that only a member that left still holds is shown from that member and judged among no one. (3) routes() fills stops only for the nodes of the write's own resource. A client is meant to get a write only when its feeder holds the write's row at capture end. A node outside the view is judged by its tenure. 'Last member epoch' is its own view's epoch while that view still names it; otherwise it is the view it installed just before its own evict row. Where the writer gives a holder fact (scoped), a node outside the view is judged only for rows it can be shown to have held while it was in: what it holds now, rows it acquired, and rows that froze into orphans after its last member epoch. It is judged only for writes stamped at or below that epoch. Where there is no holder fact (unscoped, or an older capture), a write stamped after its last member epoch is quiet, and a write whose epoch no captured log holds keeps the old rule. Everything left out is the quiet `not-a-holder`. When the writer is not in the capture (a live attach that could not reach it), the route takes its partition from a captured log entry and its view from the resource's newest committed view, the same one the header judges by. Its holders come from a `holders` fact for that row on the newest view, else from the members of that view whose `held` names the row. With none of these, the old rule stays. (4) On a capture that mixes resources, each cell and write row wears its resource as a quiet tag, and a cell's key gets its resource. The `#` tag on the node row stays. (5) The DIAG wire moves to DIAG_P 2. The bridge keeps a cache per attached node life (uuid, incarnation). Journal rows are read from a cursor (the last snapshot's head). Rows below the node's dropped count leave the cache. A ring wrap past the cursor drops the cache and raises the slice's `dropped`, never splicing across a hole. A new read, q:'seqs' (not journaled, paged at 65536), lists each origin's seqs. The bridge pulls only the entries it lacks and keeps exactly the listed seqs, so compaction, sheds, splices and acquires leave nothing stale, and nothing below the base survives. q:'state' takes an optional page (f, n), and every page carries sh and sz, the torn-snapshot marker. The bridge pages only after a 'too-large', at 2^20 cells and halving, and says `torn` when a marker moves or the cells are not exactly sz distinct keys. Every data-bearing read (node, logs, each state page) writes its diagPull audit row only when its reply went out; a reply refused as 'too-large' leaves no row. An older node gets the old reads.
REJECTED: recomputing placement in the browser (the ring's answer travels in the capture, V4-23); comparing a member that left (its copy is old by design); guessing a leaver's duty from today's ring (it is no longer in it); falling back to the old never-arrived rule when the writer is missing from a live capture (the header and the writes then contradict each other); a cache keyed on 'everything after my tail' (the set of records changes below the tail); a per-origin count or checksum to skip the seq list (an insert and a drop can cancel); offset pages with no marker; a per-session iterator in the kernel.
Consequences: the scoped registry scenario paints converged. The real page was driven in Chromium on the scoped scenario, a lagging-holder capture, a tenure capture, an unscoped leaver, and both of those with the writer missing. The new comparison found a real kernel gap: a client of a scoped cluster misses, for good, a row its feeder takes over in a hand-off (STATUS). Limits: holder and feeder facts are as of capture end. A row the ring gave a leaver that never sent it a record leaves no fact after it exits, so that miss shows quiet, never red. A leaver's real misses from while it was in still show on the write's route, under a header that judges only today's members. A client with no feeder fact is not compared per row. With the writer missing, a holder still copying the row in reads as not a holder. Under rewind, the per-row participants are the end-of-capture ones. The links-and-streams replay still does not fold a hand-off's watermark jump (STATUS). Cost: nothing on the kernel's hot path. A rebuild of an unchanged node now costs one seq list per origin and no log entries.
The last re-check (Opus, 2026-10-11) recommended ship and left two minors as follow-ups, both in a live attach with a node missing from the capture: when a client's feeder is missing, the header can read converged while the Writes pane shows a stop for that client; and when the writer is missing, a ring holder still copying its row in, with an old value, is silent on every pane (the capture carries the open acquire that would keep the signal). Neither paints something false as broken.

## V4-47 — the user's own code never stops fero: what it throws after a change lands is printed once per bug on stderr, and fero carries on (2026-10-11)
Context: data runs the user's views and taps when a commit closes, after the change has landed. Until data's SCHEDULE_VERSION 5 a throw there also wedged data's runtime for every later write in the process; since then data isolates it and throws one AggregateError after the commit (a filter or map leaves the row out, any other view that throws is stopped). fero applies records from inside its own work: the kernel's step, between a record's commit and the rest of that step (the local commit loop, the inbound ingest and its spoke feed, the projection repairs), a socket handler, a timer, the post-step fold, a microtask. A throw there cut that work short (the later records of a local write were never stamped, the rest of a frame never folded, a spoke was not fed) and, out of a socket handler, was uncaught: a client whose filter met a row its server set to null exited with code 1. Found 2026-10-11 with a server and a client on a private rendezvous, while checking data's fix. Three rounds of review (a reader and a prober, 2026-10-11) found the same class elsewhere: a `validation:` rule that throws on a client's relayed record, and a method result the wire cannot carry, each ended the server.
Decision: (1) Every place fero writes into a source the user can watch hands what the user's code throws to a Fault (api/substrate.ts): applyRec and applyStreamRec for the resource's data, a method's live mirror and the scoped union (the lane or ingest throw can only come after the records folded), and commit(fault, fn) for the composer's own writes (the cluster view's fold, its writes ring, the directory's callbacks): one data batch, what the views and taps throw at its close to the fault, a throw from fn itself rethrown (from a microtask when data deferred the batch). (2) The composer's Fault, sayFault, prints one line on stderr, `fero('<name>'): <what threw> (<the error>, at <file:line:col>) — the change stands; fero carried on`. A bug is the resource, what threw (data's operator name or `tap`), the thrown value's constructor and the user's own place in the stack: the frames after the message, at most 32, skipping frames with no file, data's install (resolved the way the loader resolves it) and fero's own runtime files; never the row or the message, so a filter that throws on ten thousand rows, or a peer that keeps sending bad rows, is one line. data's own errors are known by their shape (an own `cause`, data's wording and one of data's operator names), never by a `data: ` prefix a peer's text can carry; a stack is read only off a real Error, never off plain data a peer wrote. A stack is read at most 64 times per resource, operator and kind, then once a second (V8 formats it on first read). Its own capped sets; every part cleaned of control characters and cut; total, whatever was thrown (errText). data's cut of a write loop prints its own line, which says this node may show the loop's last writes late. Lines for fero's own refusals (below) end `— fero carried on`. (3) A live method subscription or a one-shot call (remote or server-local) over a view data has stopped is refused, never answered with a frozen picture: at open or call time, and for a live sub later too (reapStopped, once per microtask burst, when a fault stopped a view, when data cut a write loop, whose dropped errors may have stopped one, or when disposeMinted released a view another sub still read, the I-29 cousin). The Host's streams take their records by reference (`records(…, { clone: false })`; subOut encodes them into frame bytes at once), so a value the wire cannot carry fails in fero's own sink, which ends that sub with the reason and prints the line; data's own copy used to fail first and drop the row under a sub that read 'live'. disposeMinted walks on through a stopped view, and a sub closed while its handler still flushed releases what the handler minted. The composer's post-step fold is fero's own code: its throw stays an uncaught error, but leaves from a microtask, never through the node.step whose caller guards it. (4) A `validation:` rule that throws on a client's relayed record refuses it `validation-threw` and prints the line; the server's own write keeps throwing to its caller, before anything is stamped. A method result (or a value SUB's frame) the wire cannot carry rejects that call, `the result could not be sent: …`, and whatever a handler throws or returns (a Proxy whose traps throw included) is read without throwing.
REJECTED: rethrowing after the step, in a microtask (an uncaught exception still ends the process, and the call was to keep running); an `onError` option now (a function the config layer would have to refuse in every text layer, and stderr is where fero already reports; a hook can come later); one catch at the shell's apply hook (it would hide fero's own bugs in the binding too); a journal row (a new kind ripples through the debugger's fold and the ELI5 gate, and nothing reads it yet); keying a line on the message or the top frame (a row's text in a message forged the place and bought a line per row).
Consequences: a fero process survives its user's views, taps, validation rules and method results, and the user sees each bug once. A record data refuses after the vivify retry still throws, as before: that is fero's own fault. Known limits, in STATUS: a value with a getter that throws is stamped before its encode fails; a seed rule that throws leaves fero() with a bare TypeError; after data cuts a write loop this node shows one write less than its kernel (older, now said); and since data runs one runtime per process, a view of another resource whose commit was drained in this one's prints under this one's name. data's other function operators (a sort's comparator, reduce, group, distinct, the function forms of some/every/max/min) stop on a throw rather than leave the row out (data's STATUS). Tests (22): api/substrate.test.ts (commit's three cases, the apply seam, errText), api/data.test.ts (an inbound frame and a two-record local write, each folding whole), api/index.test.ts (the cafe client and server over TCP; cluster and cluster.writes taps; the printer's totality and keys; the write-loop line; validation that throws), api/methods.test.ts (a live mirror; a stopped served view, at open, later and for a call; a view stopped inside a write loop; a stream value the wire cannot carry; a result that cannot be sent; a handler that throws or returns a hostile value; a sub closed mid-flush), api/index.test.ts also (a tap's text posing as data's; a row's own fields); each fails on the tree before it.

## V4-48 — a value fero cannot send is refused before it is stamped, and a method argument before it is sent; a data: seed fails fero() named for anything of the user's (2026-10-11)
Context: the codec carries null, undefined, true and false, numbers, strings, Uint8Array, and arrays and objects of these (an object as its own enumerable fields), at most 64 levels deep and one frame (MAX_FRAME, 256 MiB) big. A local write of anything else — a `bigint`, a function, a symbol, a getter that throws, deeper nesting, a bigger value — was stamped first (logged and applied), and every frame that carried it afterwards failed to encode: the WAL append, each link's ship, each digest answer. Replication stopped for good, silently (later rows never reached a client, a late client never caught up, the write's `cluster.writes` row stayed `pending`); a getter that throws ended the server from its socket handler. A `data:` seed with such a value started fine and did the same. The built-in reads wrap a stored value in more levels — a keyed call one, a whole call two, a keyed live sub three, a live sub of the whole resource four, the scoped gather's claim four — and a field's value sits a level under its row, so a value 61 to 64 levels deep was written and replicated and then could not be read back on those paths. A method call's argument was encoded inside the kernel step, so one the wire cannot carry threw out of it and ended the client, at once with a server and, with none yet, when the held call replayed on the next primary. A seed whose rule throws, whose object has a getter that throws, or whose rule answers a Symbol escaped fero() bare, past abort's teardown, with the Ctrl-C listener left installed. A `validation:` rule that answered neither `true` nor a string (`false`, the common slip, or nothing) broke the write path, which read the answer as a commit's promise: `r.then is not a function` at `methods.update`, `r.catch is not a function` at the assignment. And `Writer.value` wrote an array's length and then its elements by for-of, so an array whose own iterator disagreed with its length wrote a frame that would not decode. Found by the V4-47 review and three V4-48 reviews (2026-10-11).
Decision: the question is asked before the stamp, and before the send. kernel/codec.ts `encodable(v, limit, from, spent)` walks a value as `Writer.value` encodes it — the same classes, told by typeof; arrays by index over their length; objects by their own enumerable keys, each getter run once, and one that throws is the answer — and writes nothing. It charges bytes as `Writer.ensure` reserves them (a string 4 + 3 per character, each element its tag byte, a length before its parts are visited), so the walk is bounded by the budget. It refuses by throwing a private marker compared by identity, so no user code runs to tell a refusal from a user's throw, and it says where the bad part sits (`a bigint at toys[1]`). `Writer.value` reads an array by index over the length it writes, so the count and the elements are one reading; plain arrays encode to the same bytes. api/data.ts asks with two limits: WRITE (60 levels counted from the row, 255 MiB) for a local write's record (`unsendable`: a field write starts a level down; the key and `at` count into the bytes, a remove's key too; a live view written as the value, `data.b = data.a`, is refused) and ARG (63 levels, 255 MiB, a live view refused) for a method call's argument. The lens sink (an assignment, `set`, `update`, `patch`) throws a TypeError before anything of the batch is issued: its first line names the key and why, its second says what fero sends. `issue()` refuses such a record `unencodable` before the user's rule sees it (`methods.*`, whose reject says why, and the seed). `Caller.call` rejects, and `Caller.subscribe` fails at once, with `methods.<m>: the argument cannot be sent: <why>`. The seed reads its rows, asks each row, runs the rule and issues inside abort: every failure names the resource (and the row) and runs the teardown. A rule's answer other than `true` or a non-empty string refuses, with its text as the reason (`the rule returned false`). Relayed records are not asked: they were decoded from the wire.
REJECTED: a dry-run Writer.value (the same answer for more work: every string's UTF-8 encoded twice); encoding once and handing the bytes to the kernel (a frame is a run of records with their provenance; a kernel change for a programming error); a quiet refusal for an assignment (a programming error, as a root replace is, and an assignment has no await surface); asking in the kernel after the stamp (the bug itself); the codec's own 64 levels for a local write (61 to 64 would be written and could not be read back); counting UTF-8 exactly (a pass over every string on the write path, where 3 per character is what the writer reserves anyway); vtOf and Object.entries in the walk (a quarter of its cost on a small object); a path that costs nothing until a refusal (a second walk to find it runs the user's getters again); a live view anywhere inside a value (a test per part, where the slip is the value itself); copying the value at the write, cutting grouped frames by size, a linear Framer (each costs every write or is a kernel change on the hot path: the owner's calls, in STATUS).
Consequences: a local write fero takes can be encoded alone in a frame and, by depth and size, read back on every built-in path; a method call cannot end its client by its argument. A value 61 to 64 levels deep, an object with a method in it, and a live view as the value used to be written (and broke later); all are refused now. The cost: number writes unchanged (same-process A/B, inside the noise); on a small object the walk is about 3% of the write in a profile and about 0.35 µs alone. A new ratio pin in api/data.perf.ts holds the check under a tenth of the write it guards (it reads about 0.03x; a check that copies the value reads 0.14-0.20x). Known limits, in STATUS: the kernel keeps the caller's object, so a value changed after the write is not asked again and the copies then disagree; records that travel together (a catch-up run, a WAL snapshot chunk, a whole read) can pass the frame cap though each fits, and the snapshot then ends a durable server; a big frame takes quadratic time to arrive; a Date, a Map, a Set, another typed array or a live view inside a value arrive changed; a Proxy, a WeakMap or a Promise breaks the server's own reads (structuredClone); `methods.insert` with a two-part key is stamped and then refused by data. A relayed record from a client that skips the check can be 61 to 64 deep; the deep reads then refuse it, typed. Tests: kernel/codec.test.ts 3 (Writer.value by index with its decode round trip; parity with Writer.value within the codec's bounds, each refusal's reason and path, a getter that throws a revoked Proxy; the byte budget), api/data.test.ts 5 (the lens throws and stamps nothing, a patch is all or nothing; the depth counts from the row; a rule's answer that is not text; a live view and a remove's key; issue() refuses one record of a batch), api/index.test.ts 4 (methods.update rejects `unencodable` with why on a server and a client while replication keeps flowing; seven seed failures each fail fero() named with no Ctrl-C listener left; a value at the limit reads back through every built-in read; a method argument fails the call with no server, with one, on a live sub, and as a live view). Each fails on the tree before.

## V4-49 — a clear on a synced client link leaves a ceiling on the link (2026-10-11)
Context: the review of V4-42 filed an older bug on STATUS. In steady state (no digest answer in flight) a client link is synced, so its feeder tap-forwards every record it folds. A record spliced into a lane's interior is tap-forwarded too, below the spoke's tails. If the link pauses and a clear (the paused queue overflowing) takes that frame, only the drain digest is left to heal it. That digest answers above the spoke's tails, so the record was never sent again: 6 of 7 rows in the review's shape, on the wave-5e tree and the base alike. Building the repro found a second hole of the same kind. A flush can ship several frames: on a scoped feeder one inbound frame's tap is gappy, because a record of a partition it does not hold, or one it already has, breaks the run. The frames after the clear are queued and survive it. They land first and raise the spoke's tail above what the clear took, so plain appends were lost as well. Two reviews corrected the first versions. (a) A clear of control frames only (method replies, SUBREC deltas, a relay's WACK hop) left no cover. Then a splice before the drain was lost (also on the base), and a second clear that took a surviving tap frame set its cover above a record folded in between (a regression: 8 of 9 rows). (b) A cover set at the feeder's tails and resumed at the drain assumed every record the feeder had folded was tapped. A record folded through the latch (scope.ts onAcqDone) never is (the open STATUS latch bug). So the resume shipped a later record on that lane alone, the spoke's tail rose past the latch row, and the row never arrived while the feeder lived (7 of 8 rows). The base heals that row through the drain digest, so this was a regression too.
Decision: (1) Link gains `onClear`, set on client links only, at admit. A clear in Link.ship hands it the frames it took and the link's synced flag from just before the clear, after V4-42's inQueue→torn move. (2) Node #clearCover reads each record frame's header (origin and first seq) and lowers each lane of the link's cover (`Link.torn`) to just under the lowest record the clear took there. (3) When an answer's frames were in the queue, that is the torn answer's own cover, built from the spoke's real tails, and the drain resumes it as before, reply included. (4) Otherwise no answer was owed, and every clear on a SYNCED link sets a cover at the feeder's tails right now, marked `c`: a CEILING, never a claim about what the spoke holds. This happens even when the clear took no record frame. The drain does not resume a ceiling. It sends the drain digest as before, and the spoke's reply is answered from the lower of the spoke's own tail and the ceiling on each lane, which uses the ceiling up. A lane the clear did not touch is answered from the spoke's tail, exactly the old drain exchange, so a latch-folded row is healed as before. A lane the clear took a record from is answered from just under the lowest one. (5) The link joins #covered, so a splice before that answer lowers the cover through indexInsert, and a second clear lowers it again and never raises it. A clear on an unsynced link with no cover changes nothing: such a link has had no answer complete since its admit, so nothing was tapped to it. Why nothing else is lost: after a clear the link is unsynced, so nothing is tapped until the answer that uses the cover. A record committed before that answer is above the spoke's tail, so the answer ships it. A splice lowers the cover. A clear that takes an answer's frames, its reply and tap frames together keeps the answer's cover and its reply, because a tap record sits above that cover or a splice already lowered it. Member links are unchanged. An unscoped member gets one frame per flush (a commit is one contiguous run, and a member never taps), so nothing survives a clear and the drain digest heals the tail. An armed member is repaired by the holder handshake and the drain round, not by the digest.
REJECTED: tracking spliced tap-forwards at the splice site only (cheaper, but it misses the leapfrog of plain appends inside one flush). A cover only when the clear took a record frame (the first version: it loses a splice after a control-only clear, and the WACK-hop double clear). Resuming the clear's cover at the drain, before the drain digest (the second version: it trusts the feeder's tails, and it loses a latch-folded row the base heals). Tapping latch-folded records in scope.ts to make the tails true (that is the open latch bug's own fix, in another lane's file, and it needs the spoke to accept interior records and the repair-round path checked). The feeder's tails at the drain instead of at the clear (a record committed in between would sit under the cover). Dropping every frame after a clear until the drain (it would also drop control frames, and a later surviving WACK or reply). The same hook on member links (an unscoped member drops a re-sent record below its fence as a duplicate, and it has no such hole anyway).
Consequences: kernel/client.test.ts gains ten tests. The steady splice (red on base: 9 of 10, missing r11). The leapfrog inside one flush (red: 12 of 14, missing r32 and r34). Two clears in a row with a splice and a commit before the drain (red: 16 of 17, missing r11). Two control-only clears, with method replies and with SUBREC deltas, then a splice (red on base: r11 missing). The WACK-hop clear then a second clear (red on the first version: c25 missing). A clear on a never-synced link leaves no cover. The mixed clear (the answer keeps its cover d.bb 17, its reply and q; ONE ask). An unscoped member clear unchanged. And 'a clear's cover is a ceiling, never a claim' (red on the second version: the latch row did not reach the spoke). Mutations, each caught: no onClear at admit, a fresh cover on every clear, no #covered add, no lowering, the last lost seq instead of the lowest, no synced guard, the drain resuming the ceiling, no ceiling mark, the reply answered from the spoke's tails alone (6 red), the reply answered from the ceiling alone. Cost: one frame-header read per frame a clear takes (a cold path that already writes a journal row). The answer that uses the cover re-sends a lowered lane's suffix above the lowest lost record, including frames the spoke holds (its lane drops them), as V4-42 already accepts for splices. One cover per link. No deliberate overflow. No re-encode loop. Hot path: one null check of link.torn in the digest handler. What moves: only a client link that was synced when a clear emptied its queue. The drain exchange's answer starts, on each lane the clear took a record from, just under the lowest one. The timing does not move: it still goes out one round trip after the drain. The sim never pauses inside a send, so the golden, the 300-seed sweep, 59,500 and 104,050 are byte-identical, and the V4-42 cost pin in kernel/node.perf.ts is unchanged. The latch bug itself stays open and is no worse: with no clear, a later record on the lane goes live and the latch row is lost, on this tree and the base alike. DESIGN-SCALE has the dated note of 2026-10-11 (wave 5f), with both corrections. One STATUS bug line closes. 902 → 912 tests, 51 pins.
The last re-check (Opus) recommended ship: every probe gives at least what the base gives, and the capped answer always ships at least what the base's answer to the same digest ships. Two minors left: the ceiling also closes a loss on an UNSCOPED feeder's client link (a frame leapfrogged inside one flush), which no test pins and the docs do not name; and on an unscoped feeder a row can still be lost when the spoke fails over after the drain and before the capped answer arrives (STATUS). Numbered V4-49 at the merge: another session landed V4-47 and V4-48 on the same day.


## V4-50 — a live attach with a node missing tells one story, and the rewind replays a hand-off without running ahead of the kernel (2026-10-11)
Context: the last re-check of V4-46 left two minors, both in a live attach that could not reach one node. When a client's feeder was missing, the header read converged (agreement() could not compare the client per row) while the Writes pane showed in-flight stops for that client (routes() fell back to the old rule). When the writer was missing, a ring holder still copying its row in, with an old value, was silent on every pane: `held` leaves out a row being copied in, and with no writer no `holders` fact names the holder. Separately, the links-and-streams replay did not fold a hand-off's watermark jump, so the end-of-capture proof refused every node that had acquired a row, and under rewind those nodes showed `@ end` (a STATUS line).
Decision: (1) One helper, feederHeld(), decides for both folds whether a client can be judged: its feeder must be in the capture and carry `held`. On a scoped resource (some node carries `held`), a client without one is not judged. agreement() puts it on no row and names it in its group's `unjudged`. routes() gives each stop it lacks a new closed status, `feeder-unknown` (the 8th route status). The page treats that stop as quiet, outside the 'applied n/m holders' count, and writes 'not judged — its feeder X is not in the capture' (or 'no feeder at capture end'). The header adds an info chip, 'not judged: <client> (<why>)', so converged is never read as a verdict on it. An older capture with no `held` anywhere keeps the old rule. (2) copying() reads a member's open copy-in from its journal: an acquireStart for a row that no later acquire of that row, and no later viewInstall, has closed. A copy-in opens only on a row the ring makes the node hold, and the ring changes only at a view install (the kernel journals viewInstall right after the rescope that aborts every open copy-in). So an abort for any other reason (teacher link down, timeout, torn, overflow) keeps the claim: the ring is the same, the next round re-latches the row (from `out`, or from an orphan when the node already holds records of it), and the holder still lags. agreement() judges such a member on the row, and routes() (when the writer is not captured) counts it among the row's holders. With the writer captured nothing changes. (3) What an acquire folded is one helper, handoffs(), shared by stateAt (cells), topologyAt (links and streams) and, in effect, routes() (the `acquired` stop). It names the records in the node's book that have no apply row of their own after the acquire. topologyAt raises each lane's applied and shippable to the highest seq the acquire folded, and grows the folded count once per record that had no apply row before it. When a node acquires the same row more than once (a heal re-latches a holder that fell behind), a record with no row of its own could have come in at either acquire, and the journal cannot say which (the acquire row carries only the count the teacher shipped). It is folded at the row's LAST acquire, and an earlier acquire of that row folds nothing. The replay may then trail the kernel between the two, but never leads it. The live header's 'absent:' chip keeps its space ('absent: 127.0.0.1:9001 (timeout)'), and a test pins it.
REJECTED: painting a feederless client's stops `never-arrived` or `not-a-holder` (the first contradicts the header, the second claims something the capture cannot show); guessing a client's feeder from today's links (the feeder fact is the kernel's own primary); ending a copy-in's claim at any abort (only an install can move the row); a new kernel journal field carrying the cut (kernel/ is another lane's, and the folded records give a sound floor); folding a twice-acquired row's records at the first acquire (the first build: the rewind ran up to 10 records ahead of the kernel for dozens of rows, and the end proof could not see it); a '≥' mark on lanes an earlier acquire may already have moved (the cut also makes lanes trail where nothing can be marked, so a partial mark would read as 'no mark means exact'); keeping the refusal for every node that acquired a row.
Consequences: the scoped registry scenario's joiner and the tenure fixture's two acquirers now replay under rewind; only the reborn writer is still refused, on purpose. Two per-step oracles check the replay against the real kernel's marks after every event: a clean scoped join (885 steps; applied, shippable and the folded count exact) and a chaotic run where a heal makes the joiner copy two rows in twice (never ahead). A wider chaos check (30 seeds, 34576 steps) found 3255 steps ahead with the first-acquire rule and 0 with the last-acquire rule. The real page was driven in Chromium on the feeder-missing capture, the writer-missing capture with a holder copying in, both aborted copy-ins, the scoped scenario scrubbed to the joiner's acquire row, and the twice-acquired capture. There were zero console errors. Two glossary entries are new ('clients-unjudged', 'stop:feeder-unknown'). With the writer missing and only two holders left, the copying holder and the other holder split one against one, so both are pilled (the even-split rule). Limits: under rewind the replay can trail the kernel, with no mark, until a lane's next row after a hand-off (the cut covers seqs past the row's last record; seen often in chaos) and between two acquires of one row. A cut that waits on a gap could put a lane ahead until its next row, but no chaos seed has shown it. A row shed again before capture end has left the book, so its records are not refolded. The end-of-capture proof still refuses a node whose end tables the replay misses. A truncated journal may have lost an opening acquireStart, and then nothing is claimed. Cost: nothing on the kernel's hot path; handoffs() is built only on a capture's first acquire row.
The last re-check (Opus) recommended ship and left one minor: the Cells-replay half of the twice-copied-row fix has no regression test (a stateAt-only revert stays green). Numbered V4-50 at the merge.

## V4-51 — records are cut into frames by size where they are grouped; a read too big for one frame is refused typed; a split frame arrives in linear time (2026-10-12)
Context: V4-48 made every record fero takes fit one frame alone (255 MiB). Records that travel together could still pass one frame (256 MiB), and nothing cut them by size. A catch-up answer shipped a writer's whole run as one frame; the commit's WAL entry kept only the first frame of its run; a snapshot chunk held up to 1,024 records in one frame and asserted it; WRITE and ACQ frames were one per run. So rows written apart overflowed later: a late client got nothing (its link was dropped at every retry), and a durable server's snapshot threw from its timer and ended the process. A whole read is one value in one RESULT, and a live read's first picture one record in one SUBREC: past one frame the caller got the untyped 'the result could not be sent: Error: frame exceeds MAX_FRAME', and on a scoped cluster the gather called that member unreachable, or parked its claims silently. The Framer copied a split frame's carry again for every chunk: 16 MiB took 79 times as long as 2 MiB. The design's probes found more: the writer's bound sat on its doubled buffer, so no smaller cap could be asked; an overflow left half a record in the open frame, and the next flush shipped a frame its receiver refused; once one flush can ship several frames, a frame shipped after a clear sits above the hole, and an unscoped member kept 4 of 10 rows for good; a client's relayed record that fits the wire but not the writer would be stamped and then throw from the socket handler; and the shell built the whole snapshot FILE in one frame-capped writer, so any durable store whose live data passed 256 MiB lost its WAL at its first swap. Found by the V4-48 review (2026-10-11); the owner asked to "cut frames by size, and refuse a whole read that can't fit" and to build each frame once.
Decision: cut by size where the group is built, with one rule. (1) The Writer has an exact limit and throws one shared marker, FULL (a FrameError), when the bytes it needs pass it. (2) Outbox.put adds a record only if it fits and rolls back on any throw; Outbox.add cuts: the open frame goes to `pending`, and the record opens the next frame of the same run at its own seq and cid. A record that cannot fit even an empty frame is a loud plain Error: it must never have been stamped. (3) encodeRun encodes one frame of a run and says how many records it took; encodeRuns is that in a loop, with a cap. (4) Every grouping site cuts at the node's cap: the per-link outbox (the commit fan-out and the client tap); the digest answer, frame by frame, with the queue check before each frame and the cover and the tear at frame boundaries; the commit's WAL entry, one row per frame, each with its own batch, chain link and partition cover; each snapshot chunk, one row per frame; WRITE and ACQ frames. (5) A flush that clears a member link's queue ships nothing more of it; a client link (wave 5f's onClear) ships on, because its cover re-sends what a surviving frame leapfrogged (the merge rule with V4-49). (6) Before the stamp the relay asks whether a client's record could go alone in a frame, by V4-48's own count, at one compare per frame below about 64 MiB, and refuses it `invalid` 'unencodable: …' if not. (7) RESULT and SUBREC carry one value and are not cut: past the cap the Host answers a ScopedError, reason 'too-large', with a plain hint (read one key at a time; a read that already named one key is told to read a smaller part of the row), and prints one line; a live sub ends with the same error; the gather files a member that answers too-large apart from the unreachable ones, rejects with it (it wins over unreachable), ends the live reads it feeds, and refuses new ones until a generation gathers every share. A server's own read is refused by the same rule and by the reply's real size (V4-52's replyCopy: the real encoder decides whenever the copy's worst-case charge passes the room). (8) The Framer builds a split frame once, in a buffer that doubles as its bytes arrive, never sized by a header alone. (9) The shell builds each WAL row at its exact size and streams the snapshot file, every write through writeAll. (10) The tune row `frame` is the test seam: MAX_FRAME by default, 1024 to MAX_FRAME, no config key, never passed by the composer; WRITE, ARG and RESULT follow it (atCap). (11) The writer reserves a string's worst case (3 bytes a character) only when that fits its limit. Otherwise it first asks the least the string can take (a byte a character, and one for its length), so a string far past the room is refused without being encoded, and only then encodes it and takes its real bytes, so a frame holds what really fits (a 3 KB string was refused a frame of 8 KiB). A string under 2 MiB takes the same 3-byte length wherever it lands, so a value that fits a smaller room fits a bigger one. Every frame the old writer produced is byte-identical.
REJECTED: a size check or byte budget per record (a walk per record on the hot path); cutting RESULT and SUBREC (a protocol change); allocating a split frame at its header (one 11-byte header would make a node hold 256 MiB); a module-global test cap (shared by every node in a process); shipping the rest of a flush after a clear on a member link (the hole stays for good); stopping every link's flush at a clear (M0: right end state, but four of wave 5f's queue checks would have to go, and its cover already heals client links); a finally around encodeControl's encode (about 8% on small control frames; a catch that rethrows costs nothing).
Consequences: no wire change. A frame under the cap is byte-identical: 3,716 random frames, 150 Link.add streams and 600 control and run batches compared with the old codec. Sim trajectories under the cap are unchanged: the 20-seed golden passes, and 59,500 and 104,050 are exact. Old WAL files replay on the new kernel, and cut rows replay on the old one. Perf, same-process A/B against an identical-copy control: Outbox.add 0.994 (control 0.988), encodeRuns 1.010 (0.998), encodeControl 0.970 (1.013), the Framer's whole-frame path 0.959 and 0.996 (1.005, 1.006), the kernel's write fan-out 0.964 (0.992), ingest with the client tap 1.007 (1.009), the relay 1.009 (0.985), a digest answer 1.025 (1.013). A split 16 MiB frame arrives 6-9 times as slowly as a 2 MiB one (79 times before). Two new pins in kernel/codec.perf.ts: the arrival ratio under 20x, and a 20-million-character string refused in under 5 ms (an exact path that encoded first took about 20 ms). Known limits (STATUS): a paused link's queue is bounded by count, not bytes; an issuer or origin name is not bounded in size. Tests: 27 new (codec 10, tune 1, client 2, node 1, durability 2, write 2, scoped 1, sim/durability 1, tests/wal 1, api/host 4, api/scoped 1, api/index 1) and the pins, each mutation-checked; with V4-52 and three review rounds, more on the meeting points (the writer's exact strings; a server's own read and a client's refused alike, by the reply's real size; the gather's own rows and its stored refusal; the keyed hint). Known limit (STATUS): a keyed read during a handover gathers whole shares.

## V4-52 — a write keeps fero's own copy of its value; a value that would arrive changed is refused at the write; a server's own reads answer what a client's read decodes; a key data cannot fold is refused before the stamp (2026-10-12)
Context: V4-48's reviews found four limits in how fero takes and hands out values. (1) fero kept the program's object. After `const o = { n: 1 }; data.r = o; o.n = 2` the writer read 2 at once, and no write was made; a copy that already had the write kept 1, one that caught up later got 2 (the writer's log held the same object), and changed to a bigint, a late client never caught up. A client's held write, and a held or retried method call, re-encoded the program's object the same way; a held call whose argument became a bigint threw from the client's socket handler. (2) The codec sends an object's own fields, so a Date or a Map arrived as {} on every other copy, a Float64Array as an object of its indices, a Proxy as whatever its traps answered, and a live view inside a value as empty objects, while the writer kept the real thing; a method argument arrived the same way. (3) A server answered its own calls, and the scoped gather its one-shot reads, through structuredClone: that kept what the wire changes, threw a DataCloneError on a view of Proxies, handed a plain result out by reference, and gave a local handler the caller's own argument object. (4) methods.insert with a key of two parts or more, or an empty `at`, was stamped and then refused by data at apply: on a server the call rejected after the stamp and its write stayed pending for ever; a client's such insert threw in the server's socket handler, and again in every client that caught up on it. The owner picked (2026-10-11 and 2026-10-12): for (1) a copy at the write over a freeze (the freeze cost the same inside the write, but arrays it froze read up to 14-78 times slower, it froze objects the program still uses, and it could not freeze a Uint8Array's bytes or a getter); for (2) "refuse them at the write, like a bigint", taking class instances as their own fields; for (3) "make local reads copy through the codec, so they match remote reads"; for (4) "refuse it before the stamp".
Decision: kernel/codec.ts `copyOf(v, limit, from, spent)` builds the value Cursor.value would build from Writer.value's bytes, without the bytes: the same classes, order, limits and byte charges as encodable's walk; a string as UTF-8 returns it (a lone surrogate becomes U+FFFD; the decoder now keeps a leading U+FEFF, ignoreBOM, and so does the copy); a Uint8Array or a Buffer as a plain Uint8Array of its own bytes; arrays by index over their length; objects as plain objects of their own enumerable fields, with '__proto__' defined. It throws Unsendable with encodable's own text (one shared reasonOf), marked `over` when only the size stopped it. `Limit.part` is the api's rule for an array or object the codec would carry but change; both walks ask it once per part, never for a Uint8Array, so the kernel stays pure. api/data.ts `partOf` is WRITE's and ARG's rule: a Proxy by brand (a live view keeps V4-48's text, at any depth); an array or an object whose constructor is Object passes on one load; otherwise a Date, Map, Set, WeakMap, WeakSet, a typed array other than this realm's Uint8Array (a Buffer is one), DataView, ArrayBuffer, RegExp, Promise, Error, a boxed primitive, URL or a module namespace is refused with what to send instead, and any other object whose tag is not 'Object' is refused by its tag (a URLSearchParams, Headers, a Blob, a WeakRef, an iterator); a null-prototype object, another realm's plain object and a class instance are taken (INSTANCES flips the last). `unsendable` replaces the record's value with that copy, so one walk checks and copies, and the kernel, its log, the WAL, each link's frames and this node's own fold hold the value every other copy decodes; a copy spends at most a sixteenth of its budget before encodable (no allocation) answers first, and the same bounded copy (copyBounded: a part copy to a sixteenth of the budget, then the walk, then the whole copy) is the one road for a call's argument and a reply's copy, so a value refused for its size is never copied to the whole budget first; a key (a row, a field, a remove, an insert's `at`) with half of a surrogate pair is refused. Caller.argOf copies a call's argument once, when the handle is made, and every call and sub of that handle sends that copy. Host.invokeLocal copies the argument (ARG) and the result, and the gather its one-shot answer, through `replyCopy`: copyOf with RESULT's limits at the node's cap, where a charge past the room asks the real encoder once, at the depth a RESULT carries the value, and the answer is those bytes read back (roundTrip: what a client decodes, bounded by the frame); only a reply that really would not fit is refused, typed 'too-large' (V4-51). A keyed read during a handover copies only its row, the gather reads only the union's own rows, and a refresh nobody reads builds no answer. The remote failure path gives the local words ('the result could not be sent: a bigint at r0'), with no byte bound and at the frame's own depth; a refused methods.update keeps the reason issue() found, so its value is walked once. The tag rule asks the nearest prototype up the chain that is not a class the program wrote: a class over a plain object or an EventTarget is taken as its own fields, whatever tag it names; one over a built-in that hides its data (a URLSearchParams, Headers, a Blob, a WeakRef) is refused as that built-in. Each refusal says what to send instead: Object.fromEntries(it), [...it], await Array.fromAsync(it), it.toString(), or a plain copy. `unfoldable` (api/substrate.ts) names a record data cannot fold — an insert with a key of two parts or more, or with no row; an update or a remove with no key: write() refuses such an insert 'invalid-key' with a hint before anything is stamped or relayed, Bind.admit (the issue's rule and the relay's) refuses every such shape before the user's rule, and applyRec folds one already stamped as the cell the kernel holds it under.
REJECTED: freezing what a write takes (above); decode(encode(v)) as the copy (the same answer at 3.6-3.9 times structuredClone: a TextEncoder and a TextDecoder per string, a DataView per number); structuredClone (not the wire's answer); refusing every object that is not plain, class instances included (V4-48 took class instances as their own fields, and the copy makes them plain on the writer too); judging a read's size by the copy's worst-case charge (it runs 1.5-4.5 times the real reply: a server refused its own whole read, and a scoped cluster every whole read, from about 57-90 MiB — the review's major finding); a walk over every method result (a walk per result and per streamed record, for values the codec already carries the same way to everyone); fixing the read door in this change (an inbound hot-path cost, to measure first).
Consequences: a value fero takes is one value on every copy, the writer's included, and nothing the program does to its object afterwards reaches any copy. A value that would arrive changed is refused where it is written, with what to send instead. A server's own call or read equals a client's, and a local handler cannot change the caller's argument. A key data cannot fold never reaches the kernel, and one already stamped still folds. Behaviour changes a program may notice: a Buffer reads back as a plain Uint8Array and a class instance as a plain object, on the writer too; a string with a lone surrogate reads back with U+FFFD; a server-local call's plain result is a copy, and a Date in it comes back as {}; a Date, a Map and the like, and a key with half of a surrogate pair, are refused. Cost: on a small object the write's check and copy read 0.03-0.06 of the write (the V4-48 pin, its 0.1 budget unchanged); in a same-process A/B against an identical-copy control, number writes stay within a few percent, small-object writes cost 5-16% more and object-heavy values up to 20% (the copy's own work); a server's own whole read of 1k rows takes 0.63 of v4's time; inbound applies are inside the noise. New pins: copyOf of 1k small rows under structuredClone (it reads 0.44-0.69; the byte round trip reads 3.6-3.9); a write refused for its size leaves under a sixteenth of its budget in garbage (about 4 MiB and no collection at a 16 MiB cap, where the whole-budget copy left 64 MiB). A reply whose real bytes fit is answered even when it is a DAG whose decoded copy is large; a client decoding it builds the same tree. Known limits (STATUS): the read door; a keyed read during a handover gathers every member's whole share. Tests: 15 new and 2 changed in the build, and more from three review rounds (api/data, api/index, api/host, api/scoped, kernel/codec), each failing on the tree before; a mutant that keeps the program's object on the bounded copy's last pass fails one. New pin: a call's argument and a reply's copy too big to send are copied no further than the first share.

## V4-53 — the latch forwards to the spokes: a synced spoke holds the whole of what its feeder feeds, and M12 is the oracle for spokes (2026-10-12)
Context: The latch forwards to the spokes; a spoke holds the whole of what its feeder feeds; M12 is the oracle for spokes (wave 6a, 2026-10-12, with its two reviews the same day). A scoped feeder that took a partition's records in through the latch (an acquire in a hand-off, or the repair of a lost owner-to-holder frame) folded them through node.apply alone and told its spokes nothing. A spoke's own floor exchange ships only what is above its tail on each lane, so once a later record on that lane had been tapped live, the rows the latch brought were below the tail for good: missing while that feeder lived, with no monitor to see it (two STATUS sightings; both are tests now, sim/scale-probes.test.ts: sighting 1, P2's shape, lost ONE row of fifty on the base — k124 or k125 — not the '1-8 and 10' the STATUS line quoted; sighting 2, the debugger's recipe, reproduces only with a client of all four members and writes from 2.5 s).
Decision: (1) THE RULE: a synced spoke holds the whole of every partition its feeder FEEDS it. Scope.feeds(p) is: held, or acquiring from a held base or from nothing (a repair, a hand-off); only an orphan's frozen copy, and a latch re-entering from one, is withheld. A client's digest answer (node.ts #answer) walks the lanes with feeds, where it used held — so a spoke that syncs while its feeder repairs a partition gets the base at once (with held it missed the base for good, and when the forwarded delta was older than a base record it never got it showed an overwritten value as current). (2) The ACQDONE fold forwards every teacher record it takes in (not one already in the lane) to each SYNCED client link exactly as the live tap does: the record, its lane coordinates, its attempt identity, no pp (a spoke attests nothing); then one flush per fold on each client link after the live replay, so the replayed live span leaves in the same step too. A fold that RE-ENTERS from an orphan forwards the WHOLE partition instead (#forwardWhole: every lane entry of p in lane order, identity intact; a spoke synced since the freeze has nothing of it, one synced before holds the frozen rows and drops the copies), and lowers a stopped or queued answer's cover (Link.torn and Link.inQueue, a clear's ceiling included) to just under p's lowest row on each of its lanes, so the answer that resumes from it ships p whole (indexInsert alone lowers it only under the row the fold added). The forward feeds a synced link only, as the live tap does; an unsynced link (a torn answer, a clear's ceiling, never answered since admit) is covered by the answer that syncs it, and a link whose answer's reply merely sits in the queue, or a spoke resyncing on the same feeder, is synced and fed, the forward queued behind the answer. The spoke's side needed nothing: its dual fence takes an interior record below its tail and drops one it holds. V4-7 holds: the record is in the feeder's lane and fold before any outbox sees it, and a spoke whose write a relay WACKed with `l` while acquiring the partition sees the value and then settles through the join, once, never through `acked` — tested end to end through a from-zero latch and through a re-entry from an orphan (with the identity dropped from either forward the value shows and the promise never settles). No new round trip; unscoped bytes byte-identical (the golden, the 300-seed sweep, 59,500 and 104,050 stand). (3) The V4-40 question: stage 2 did not introduce the repair variant and the acquire variant is as old as the latch. On the tree before stage 2 the same probe lost MORE rows (seqs 10-13 and 10-15 of fifty where the base lost one): at the re-admit the holder's HAVEQ round latched before the admit digest's suffix landed, and the digest's live copy staged and was discarded at ACQDONE as covered by the cut. Stage 2 made the latch the only repair path; it did not open the hole. (4) WHAT THE FIX LEAVES, named honestly: the vanish-and-return at a resync ending across the fold. The failover's resync answer carries what the new feeder feeds when it builds it; the rows it lacks (a lost frame's delta it is about to fold) or withholds (an orphan's frozen copy, a re-entry) are not in it, and the spoke had them from its first feeder, so the ghost sweep at the end removes them and the fold's forward brings them back. Neither the answer rule nor the per-link memory it replaced (which spokes held the base when the latch opened; built and dropped because the answer rule needs no per-link state) closes it. Measured on sighting 3's schedule with the cut 0-30 ms after the latch, seeds 2, 4, 5, 6, 56 runs: the spoke mirrors its feeder at the horizon on all 56 (M12 green, screen = kernel); the sweep removed 7-20 of forty cells on 22 (9, 10, 7, 8 on the four pinned seeds at the exact cut); M11 fires on two (seed 2 cut 1 ms later: a delta row folded while the reply flew; seed 6 cut 10 ms later: a base row withheld because the repair latches had aborted into orphans on a link loss and were re-entering when the answer was built), rightly — its one exact line says a record at or below the reply's tail was shipped before the reply, and an interior latch fold between the build and the end breaks that. The base tree on the same runs: M11 on 8, the rows never back on 23 — not a regression, a cost. Pinned as KNOWN (the two M11 schedules: the swept count, the one monitor, the message's shape, the mirror at the horizon) and a STATUS line; closing it needs the answer to carry an open latch's staged records, or the spoke to keep its rows across the end until the fold lands. M11 now picks the rows it judges with feeds, not held (a superset: the base rows of a partition under repair at the end are judged too). (5) M12 spoke-mirror (sim/monitors.ts spokeMirror): at the quiet point a spoke of a scoped cluster holds exactly its feeder's HELD subset, cell for cell by value, read from the kernel, with the partitions and cells compared counted; it runs on every spoke in the scoped sweep's verdict (UNSAFE, red spoke-mirror), in sim/scale-probes.test.ts on the three sightings, and on three spoked families: A11; A12-spoke-handoff (a client of every member; a join; a clean leave of a non-feeder so the feeder acquires through the latch; a second write burst; engagement = the feeder's acquires); A13-spoke-repair (a client of every member; four times one RECORDS frame from another member O to the spoke's feeder F dies with their link and O writes twenty rows over the next 40 ms to the partitions it owns and F holds, so the lost rows fold below the spoke's tail on O's lane — sighting 1's shape; the first 5 ms slice that finds F mid-repair cuts F from its teacher for 60 ms, so the open latches abort into orphans and re-enter; a per-event probe classes F's folds by the partition's state when its latch opened; engagement = a repair AND a re-entry fold, met on every seed of 1-8). Mutation-checked: with the forward out M12 names the missing row on both sightings and on A12 seeds 1-4; with the re-entry forward out, or the delta forward out, on A13 seeds 1 and 2; with feeds narrowed to held, five kernel and sim tests red including sighting 3 (A13's spoke is synced all along, so that rule is sighting 3's and the kernel tests'). (6) M1's per-event form reads a spoke of a SCOPED feeder as covering nothing (as it already read a spoke in resync): its copy of each lane is the feeder's held subset, sparse by design, and the forward lawfully lands interior records — a write and its later remove in separate events while the fence sits above both; for as many events as there are frames between them the spoke shows a row the next frame removes (A12 seeds 2, 4 and 5; seed 4 showed p27 at two older stamps in two events), the resync flicker's shape, a cost named on STATUS. An unscoped spoke's applied is still coverage. (7) What the oracle found: a spoke keeps the rows of a partition that moved off its feeder (an orphan there, then shed) until a failover's resync wipes them — counted by spokeStale, pinned as a known count in the sweep (A12 seeds 2 and 3: 1 and 6 rows), a STATUS line. And a pre-existing lane duplicate: a teacher record above the cut that also staged live is spliced by the fold and appended again by the live replay (lane bb at aa [3, 5, 7, 7]); benign today, a lane-invariant break for stage 3; a STATUS line. (8) V4-49's ceiling (a clear's cover is a ceiling, never a claim) was motivated by this bug. With the rule as it stands a cover at a synced link's feeder tails, lowered by what a clear took, is sound for every fed partition and the re-entry fold repairs it at the one transition where it is not; the ceiling stays as recorded (belt and braces) and its test is re-recorded to what the kernel does now (the fold taps the latch row onto the paused link; the clear takes it and lowers the ceiling to bb: 22; the row arrives). The cost of the fix: on a fold, one link.add per forwarded record per synced client link and one flush per client link; one field read per entry the answer already visits; nothing on the member or unscoped paths. Tests: kernel/scoped.test.ts 'ACQUISITION forwards to spokes' (red on the base: the synced spoke heard []) and 'the two legs'; kernel/client.test.ts the review's four shapes end to end (synced mid-repair with and without another partition on the lane; synced while the partition was an orphan; the superseded value; a stopped answer across a re-entry, its cover lowered to 2 where indexInsert alone left 6), the V4-7 join through an acquiring relay, its re-entry twin (0 joins with the identity dropped), a clear between the re-entry fold and the drain (lane [7, 10, 12, 14, 16] without the inQueue lowering), the ceiling test re-recorded; sim/scale-probes.test.ts the three sightings with M12's plants and the KNOWN vanish-and-return; sim/scoped-sweep.test.ts A12 and A13 with their engagement, M12 non-vacuity on the three spoked families, the spokeStale pin; tools/debug/model.test.ts the scopedTenure client pinned as converged and the never-arrived naming on a planted miss. 970 tests, 52 pins.
Two Opus review rounds the same day; the second's one open nit is a millisecond timeline in the DESIGN-SCALE note. Numbered V4-53 at the merge (the lane wrote V4-51; another session's V4-51 and V4-52 landed first).

## V4-54 — a handler's views are released when the collector finds that the handler let go of them (I-29, built 2026-10-11, rebased onto V4-47..V4-50 and landed 2026-10-12)
Context: a handler that made a view (ctx.data.filter(…)) and returned a plain value left that view on the source for good, and data worked it out again on every commit: 100 such calls left 100 dead filters. V4-16 tried releasing every unhooked view made during the call and backed it out, because a handler may keep a view for its next call (`cached ??= ctx.data.filter(…)`), and in the data graph a kept view and a dropped one look the same. The proxy-return path had a cousin: a view cached on the first call and returned there was disposed after that call, so later calls read stale data. Three reviews on 2026-10-11 (the first two each found a view released while module code still held it) and one more on the rebase.
Decision: only JavaScript reachability tells a kept view from a dropped one, so fero asks the garbage collector. ctx.data is now a thin scope over the surface (api/substrate.ts handlerScope): one object per server, no longer f.data itself. Every view a call through it makes comes back wrapped in a small Proxy, and so does every view made off a wrapper and every child handle read off one. A wrapper is the only public road to the raw handle under it. Each wrapper is registered with a FinalizationRegistry, and a count per view tracks how many of its wrappers are still alive. When the last one is collected, the view is disposed, unless it still has a child view, still has a subscription, or module code can reach it. Then its parents are tried in turn, so a chain goes whole.
When module code can reach a view: data reuses some views per parent (sum('n'), top(3), keys…), so f.data.sum('n') in module code can return the very handle a handler made. The public lens marks every operator view it hands out as ESCAPED. ctx.data never passes that mark: for an operator it calls data's own operator on the raw handle, after the surface answers first, so the scoped facade still throws its typed error. There is deliberately no "a handler call is running" flag: the first cut had one, and a write through ctx.data (set, patch) commits synchronously and can run module code; a sink that made f.data.sum('n') during that commit went unmarked, and a handler that later dropped its own sum('n') released the sum module code still held, which then read stale numbers. A view made off an escaped view counts as escaped too, in either order, because module code holding the escaped view can ask it for the same deduped child. The one exception is a PRIVATE view, made by an operator data never reuses (filter, map, reduce, group, tap, to, union, intersect, except: their dedupKey is always null). No parent's reuse table lists such a view, so only the handler's wrappers can reach it, and the walk up stops there. Without that, one debug print of f.data.top(10) kept every ctx.data.top(10).filter(fn) a handler ever made. A test pins the rule against data: each private operator called twice gives two views, so it goes red before data can start reusing one under fero.
Under V4-47 (data stops a view whose function threw), the collector's release walks THROUGH a stopped node to that node's parents, as disposeMinted does: a filter whose own wrapper died while its za was still a child was refused then, and once data stopped the za nothing else would have tried the filter again. A view a handler returned for a live sub is held by the sub's entry; when the sub fails because its view stopped (reapStopped), the entry lets go and the collector releases the chain. The eager path (disposeMinted, for a view made some other way) keeps V4-47's walk-through and its 'shared' answer, so the Host still checks its live subs after it; a handler view never takes that path (Host.#release; disposeMinted also skips any node the collector tracks, each guard backing the other).
A wrapper is not held by its raw handle (a WeakRef maps raw to wrapper), so a reused view the source still lists is released once no wrapper of it is alive; data drops a disposed reuse entry and makes a fresh view on the next call. A subscription made through a wrapper re-tries the release when it is disposed. The proxy-return cousin is fixed the same way: a view returned through ctx.data is no longer disposed when the reply collapses it or its stream closes; the collector releases it if nobody kept it. A view made some other way (f.data.filter in a closure) keeps the old eager release.
Two traps, each pinned: a wrapper's Proxy target is an empty object, never the data handle, because the engine checks every trap's answer against the target and data answers by building the whole view (a ratio pin reads 3.27x with that mistake); and the subscription's dispose hook is built outside the trap, or its closure kept the wrapper alive as long as the caller held the subscription. The wrapper cache is asked first on a child read (2.3-2.9x a raw read; 3.2-3.9x when asked last; about 15x with no cache). The pin guards the cache, not the order: on this box the two orders' ranges nearly touch.
Cost: about 4 µs per view a handler makes (Proxy, WeakRef, registry cell); 1.05-1.10x for 1000 views over a 200-row source (pin budget 1.5x). Every operator call through the public lens pays the escape mark: one more closure, a node read and a WeakSet add, about 0.2-0.3 µs. Nothing next to a view build, but a deduped hit (f.data.sum('n') called again) goes from 1.15x to about 1.45x of the same hit on data's raw handle (pin budget 2x; a lighter mark measured the same). The rebase added no hot-path work: the walk-through runs only at release time.
REJECTED: releasing at the end of the call (the V4-16 bug: it froze a cached view); a global "handler call running" flag to skip the escape mark (a write through ctx.data runs module code synchronously, and that code's views went unmarked and were released early); keeping the wrapper alive from its raw handle (a reused view would never be released, one per key forever, and keys can come from caller arguments); making the target the raw handle (a full view build on every read); tracking views made through any handle (needs the raw handle of every view, which data does not expose); choosing private views by "some argument is a function" (data's dedupKey ignores or stringifies some arguments, so that could release a reused view early; the name list can only be late, never early); a 3x budget for the child-read pin (flakes here); releasing the views under a stopped view eagerly when the sub ends (the filter may be a handler's cache: V4-16 again).
Consequences: release happens when the collector runs, not when the call ends. A dropped view keeps being worked out on every commit until a GC finds it; a long-lived one may wait for a major GC. ctx.data is a different object from f.data: code that keyed a Map by f.data and read it back by ctx.data finds nothing (one V4-47 test did; it keys by ctx.data now). The I-29 tests, and the three V4-47 tests that count what the server keeps, run the collector before they count (two of the three can pass without it on a natural GC; the third goes red) (npm test has no --expose-gc, so the tests turn it on through v8.setFlagsFromString; the battery runs each file in its own process). Not tracked, on the STATUS page: views made through anything but ctx.data, raw handles from internals' `unwrap`, a handler's non-private view (sum(fn), distinct(fn) …) under a view module code touched, which stays for good, and a view passed as a reactive argument whose own wrapper dies before the view it feeds. 13 tests in api/views.test.ts and 3 perf pins in api/methods.perf.ts: 954 -> 967 tests, 52 -> 55 pins.
The Fable review of the rebase found no hole (ten early-release probes, nine mutations each turning its own test red) and left two nits about the report, not the code. Numbered V4-54 at the merge (the lane wrote V4-51).
