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
  `constructor` is unknown, never a crash. Flags are lowercase: `--FERO.dir`
  would be parsed under another prefix and silently ignored, so it is
  refused naming the lowercase spelling.
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
