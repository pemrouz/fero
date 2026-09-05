# IDEAS — fero v3 (open work only, by workstream)

Seeded at M8. Only OPEN work lives here — when a workstream lands, its record goes
to [DECISIONS.md](DECISIONS.md) and its remaining sub-points come back here.
Priorities: [P1] blocks 1.0 quality, [P2] wanted, [P3] someday. Module tags in
parens. (Merges into the root ledgers when v3 supersedes the root source.)

## Infrastructure / CI
- [P1] (repo) **Provision the pinned quiet runner + remote CI.** The plan makes CI
  an M0 exit criterion and the absolute perf tier pinned-runner-only; this repo has
  NO git remote, so .github/ workflows would be dead files. When a remote exists:
  standard runners for the deterministic tiers (unit + sim sweeps), ONE pinned
  self-hosted box for Tier-3 + the absolute tier; the baseline machinery (M8) is
  ready for it — record the pinned baseline there with `pinned: true`.
- [P2] (perf) **The REAL v2-vs-v3 A/B + p99 targets** on the pinned runner. The
  headless interleaved A/B is settled as unconstructible-vs-L2 / category-error-
  vs-L1 (DECISIONS V3-20, with this session's measured numbers); what remains is
  the socket-tier referent — both stacks real over localhost, request-for-request
  — plus p99 recording (the baseline schema's per-probe object is open for a
  `p99` key; bench gains per-op sampling the day the quiet box exists).

## Scoped replication (M6 residual ledger)
- [P1] (kernel) **Announcement-gated AE + scoped compaction un-pinning** — COUPLED:
  ring-gated AE is provably safe only while compaction is pinned (the H3
  resurrection needs differently-compacted teachers). Design them together or not
  at all.
- [P2] (kernel) Tombstone GC stays pinned when armed — un-pin wants the same
  coupled design as above.
- [P2] (api) **Distributed decomposable folds** (sum/max/avg facade) — deferred by
  de-scoping rung 2; holistic ops currently throw with the materialize-first hint.
- [P2] (api) **Subscription-scoped tap-forward for spokes** — spokes mirror their
  primary's held shard; whole reads are gather-backed today.
- [P3] (kernel) Explicit-undefined cells do not cross the gather (tombstone-
  equivalent pending the value-codec ticket).
- [P3] (api) Push-based claim stream for the live gather (a wire optimization; the
  install-armed + paced re-poll is correct today).

## Diagnostics / debug tooling (M7 residual ledger)
- [P2] (kernel,tools) **`jf` journal splicing over DIAG** — verified journal-suffix
  pulls (t-contiguity checkable, `dropped` authoritative) so the bridge ships
  deltas instead of full journals at follow cadence; the op-space reserves it.
- [P2] (tools) **Bridge immutable-log caching** between rebuilds — mandatory rule
  when built: evict-below-base (a capture must never show entries the node no
  longer holds).
- [P3] (kernel) Keyed range cursor + EXPLICIT torn-snapshot marker for a state map
  exceeding MAX_FRAME (today: typed 'too-large', honestly unpullable).
- [P3] (tools) Viewer DOM chrome strings are the honesty gate's named residue —
  policed by review; extend the gate if the viewer ever grows a templating layer.

## Security (post-1.0 peer auth, plan §12)
- [P1-at-1.0] (kernel) **The r:1 client-plane uuid-spoof hole**: any client HELLO
  presenting a member's uuid can trip the dup-link keeper against the real member.
  DIAG (r:2) is structurally immune; the client plane is NOT — belongs to the
  peer-auth workstream; DIAG's immunity must not be mistaken for closure.
  Evidence added 2026-09-05 (V4-4's panel): an admitted r:1 link may still
  send RECORDS frames — kernel/node.ts's RECORDS case checks admission, not
  `link.client`, so a forged, pre-stamped record lands as replication under
  any origin lane, past seams.validation and past any methods-only door. It
  is NOT a one-line drop: spokes legitimately ship suffixes back to a server
  that digests them (a restored server re-learns from its clients through
  ordinary AE), so "are spokes trusted replicas?" is the design question.
  Closed the same day, cheaply: a client's WRITE is relayed by ADMISSION FACT
  (`ae === 0 || link.client`), and ACK/NACK frames on a client link are
  dropped (`write-ack from client`).
- [P3] (kernel) DIAG token transport: cleartext by design in v3.0 (trusted
  networks / tunnel); allowlist object values ({token, scopes}) reserved.
- [P2] (api,kernel) **Relayed client writes bypass the server's
  `seams.validation`; there is no "methods only" door** (site review,
  2026-09-05). Evidence, probed that day: a server with
  `seams: { validation: r => r.key[0] !== 'admin' || 'reserved' }` refuses its
  OWN `data.admin = …` and a hosted method's `ctx.data.admin = …` (neither lands),
  but a bare client's `data.admin = …` LANDS on it and the client's write reads
  `committed`. Why: the validator is wired into Bind (api/index.ts passes
  `validate: seams.validation` into api/data.ts issue(), the ONE local ingest),
  while a relayed WRITE frame (ae 0) enters kernel/write.ts onWrite → #enqueue
  directly — the relay "re-stamps ae (relay time is an issuer boundary)" but
  runs no validator. So today validation is a local-invariant hook for the writes
  a node issues itself, not authorization: nothing bounds what an admitted client
  may write. Two steps, in order:
  1. **Validate at the relay — DONE 2026-09-05** (DECISIONS V4-4). The api
     hands `seams.validation` down as `NodeOpts.validate`; the relay ingress
     (kernel/write.ts onWrite, ae 0) runs it before `#enqueue`. A refusal is a
     WNACK `{r:'invalid', m: reason}` — a fourth, TERMINAL reason class: the
     issuer drops the attempt for good (`Writes.rejected` + `rejectedPending`,
     read by `Bind.sweep` off the composer's post-step fold), so the client's
     promise rejects with the server's reason and a plain assignment bounces;
     a relay hearing `invalid` hops it onward. A cid already in the dedup
     window skips the check (a committed retransmit is never turned into a
     lie by a state-dependent predicate). Forwarded ae>0 peer attempts are NOT
     re-validated (peers are trusted at this layer — same code, same config).
     Two forgeries adjacent to the door closed with it: a client link forging
     ae = epoch is relayed anyway (the relay keys on `link.client`, the
     server's admission fact), and an ACK/NACK arriving on a client link is
     dropped (it could clear or terminally end another client's parked
     route). Pinned: kernel/write.test.ts ×5, sim/client.test.ts,
     api/index.test.ts (the probe above), each mutation-checked. Honest
     scope: this bounds what the fero CLIENT may write; a raw socket that
     forges RECORDS frames still bypasses it (the r:1 item above) — so it is
     a bound on the SDK's write surface, not peer auth. What the hook still
     is NOT: authorization — it sees the record, never the caller (ctx.peer
     lives on the method plane).
  2. **Methods as the only door (opt-in) — OPEN; proposed design 2026-09-05,
     not built.** Three independent proposals converged (the panel's critique
     and judge legs did not run — session limit — so this is the author's
     synthesis over uncritiqued proposals; re-run the critique before building):
     - **Config:** `writes?: 'methods' | ('update' | 'insert' | 'remove')[]`,
       a DECLARED FeroConfig key. Omitted = open (the demo's contract).
       `'methods'` ≡ `[]`; a list REOPENS built-in verbs for clients
       (`['update']` admits type-0 records — plain assignment AND
       methods.update, same bytes — and refuses inserts/removes). A string or
       array, so the value-type rule holds untouched; NOT under `seams` (that
       key is for function-valued config). A SERVER MARKER like data/replicas
       (role stays a pure function of config). REJECTED spellings: a
       `methods:` wrapper word (plan §9 rejected it), top-level `update: true`
       (`update` is a refused method name — two natures), `update:
       resource.update` (no instance yet at fero() time), `relay: false`
       (kernel jargon), `clients: …` (collides with the rejected `client:`).
     - **Mechanics — zero kernel change beyond V4-4:** the door is a
       degenerate validator the composer FOLDS INTO `NodeOpts.validate`:
       `admit = door open ? validation : rec => allowed.has(rec.type) ?
       (validation?.(rec) ?? true) : 'methods-only'`. Door before validator
       (authorization precedes schema; a closed verb never runs user code).
       The refusal rides V4-4's terminal WNACK `invalid` with `m:
       'methods-only'`; the client sees WriteReject reason 'methods-only' or
       a bounce — the path already pinned. Open servers hand the kernel
       exactly V4-4's value (zero cost); pinned servers pay one Set.has per
       RELAYED record. Alternative considered: a kernel mode flag + a typed
       `NACK.methodsOnly` that refuses on the tag byte without decoding the
       body — cheaper under hostile spam, but a second refusal mechanism and
       more kernel; add it only if a consumer needs the typed class.
     - **The pin is about the wire:** the server's own writes and its
       handlers' ctx.data writes never arrive on a client link, so they never
       meet the door; they still meet the validator (below).
     - **The silent-bounce residue — decided YES:** a validator-refused
       ctx.data write inside a handler must REJECT the call with the reason
       (and `ctx.flush()` must throw it): under the pin the handler is the
       client's only door, and a bounce the caller cannot see is exactly the
       silent partial §9 bans. Mechanism: Bind.issue pushes a pre-rejected
       promise into the live handler collector; Host's flush-on-return stops
       swallowing refusals. Kernel outcomes ('dropped'/'superseded') inside a
       handler stay as today — a separate decision (retry semantics).
     - **`#directory` host** composes with `writes: 'methods'` (its clients
       only CALL) — a free hardening.
     - **Tests:** api/index.test.ts (the door closes assignment AND the
       built-ins; reopen `['update']` under a validator — the two doors
       compose; config refusals + the server marker; the pin is about the
       wire; the OPEN default keeps the two-terminal shape),
       api/methods.test.ts (a refused handler write rejects the call; flush
       throws), api/directory.test.ts (host is methods-only), one
       sim/client.test.ts case with `validate: () => 'methods-only'`. No new
       kernel path ⇒ perf is structural (nothing to widen).
     - **Does it obviate seams.validation? Partly.** It replaces validation
       as the answer to WHO may change WHAT — completely (a `(rec)` predicate
       never saw the caller; a handler has the argument, ctx.peer, current
       state, atomic multi-record changes). It does NOT replace the
       per-record SCHEMA hook, which guards four writers no method can: the
       server's own plain writes, a handler's own bugs (one invariant in one
       place instead of in every handler), the `data:` seed at boot, and
       open-mode servers (the demo shape — the only per-record bound there).
       So the hook stays, narrowed in pitch: "what a record may look like",
       never "who may write". Retiring it entirely means "open mode = trust
       your clients entirely" + no seed check + no invariant on the server's
       own writes — a bigger surface decision, not recommended.
     - **For the user to decide:** (a) advertise the pin in the server→client
       HELLO so a client refuses at issue() with zero RTT (HELLO bytes are a
       stability surface; the round-trip bounce is honest today); (b) a
       default-closed rule for servers that declare ≥1 method ("if you
       declared methods, you meant methods") — the demo survives, mixed
       servers do not; (c) whether kernel outcomes inside a handler should
       also fail the call; (d) `writes` on a bare client: imply server (the
       data/replicas precedent) or throw; (e) a second demo rung (`sell` +
       the pin) for the site and the examples series.
  Observed alongside: a hosted method's ctx.data write that the validator
  refuses bounces SILENTLY — the call still resolves — flush-on-return does not
  surface it. Decide whether a refused write inside a handler should reject the
  call. Not a substitute for peer auth (above): a client can still dial; this
  bounds what it can do once admitted.

## api surface
- [P3] (shell,api) **isolate/heal on the diagnostics handle** — rejected in v3.0
  (a TCP shell cannot hold a partition honestly); the sketch if ever wanted:
  dial-refusal set + identified-kill + revive suppression in the shell — three
  coupled pieces, not a one-liner.
- [P3] (api) Confirm-lane visualization on the live dash (the write-route timeline
  reads the route join only; confirm probes are a separate lens).

## Scoped replication — DESIGN-M6 §6 residuals (carried verbatim into the ledger)
- [P2] (kernel) Oversized-partition transfer economics: one-teacher ACQ folds a whole
  partition through memory; huge partitions want chunked teach runs + a resumable cut.
- [P3] (kernel) HAVEQ delta-compression (floors re-announced whole each round today).
- [P2] (kernel) The R=∞ log.ts two-teacher residual: the gated dual-fence opt-in
  stays OFF unscoped; revisit with announcement-gated AE (same coupled design).
- [P3] (kernel) Durable-marks shed refinement (shed evidence could weigh d-marks).
- [P3] (api) Disjoint Σ-partials for the gather (decomposable folds substrate).
- [P3] (api) Offline-first durable clients (spoke WAL + replay-on-reconnect).
- [P3] (api) Remote-Handle ergonomics (tagged Handles across the method plane).

## Scale (n≈100 residue, 2026-08-23)
- [P2] (sim) **Monitor passes walk O(nodes×lanes) Maps even when nothing changed**
  (~15ms per invocation at n=100). `run({checkEvery})` is the mitigation; the real
  fix is stepped-node-scoped incremental checks — the executive knows which node
  stepped each event, so the hot four could walk one node's lanes, not all.
- [P2] (kernel) **Digest AE is O(n²) exchanges per heartbeat tick, full-mesh**
  (exactly k·n(n-1) digest frames per k ticks — pinned in sim/scale.perf.ts):
  hb=100 at n=100 costs ~10M events per 60s virtual in floor traffic alone.
  Couple any change with the announcement-gated-AE ticket above; maybeCompact's
  O(lanes×members)-per-tick unscoped walk belongs to the same budget.
- [P2] (kernel) **MAX_QUEUED=256 whole-queue drop under full-mesh pause bursts**:
  scale.test.ts pins today's law (one drop per link, de-sync withholds, AE heals)
  at fanout 99; window sizing joins the open MAX_PENDING/writeBufferDrop ticket.
- [P3] (sim) Scale-golden caveats: sweepBuild's draw order is nNodes-scoped, so
  every golden pins its own (n, writes, seed); scale-run failure captures are
  ~50-100× the n=3 sizes (100 × 64k-cap journals) — triage-grade, and the
  restart/storeFault scenarios are not Step-shrinkable by construction.

## Carried module debts (M2/M3/M4 records — tracked, not silent)
- [P2] (kernel) M2: suspicion keys off link liveness, not PONG round-trips — a
  half-open TCP link can look live longer than it is; revisit with the shell's
  keepalive posture.
- [P2] (kernel) M3: MAX_PENDING oldest-drop is a counted loss (writeBufferDrop) —
  window sizing vs the retry horizon deserves a measured ticket (the M8 issuer
  probe documents the 1024-cap behavior under a 2k burst).
- [P3] (kernel) M4e digest residual: chained-over durable marks would close the
  newest-row-lie evasion for the fsync-lie class.
- [P3] (kernel) plan §14.2: the wy/xxhash32 bake-off via the seams.hash injection
  point (djb2+fmix32 carries over meanwhile).

## Testing / infrastructure residuals (M8 record)
- [P2] (tests) Tier-3 breadth descope, stated: the plan's ~15-test list includes
  confirm-latency-ladder ORDERINGS and mid-frame-close smokes not yet written
  (current Tier 3: 11 tests + the throughput probe). The two named are the
  load-bearing ones when picked up; anything real-socket must reproduce as a sim
  primitive before its fix merges (plan §6 rule, unchanged).
- [P2] (tests) The substrate contract suite vs `data` HEAD rides the CI entry
  (plan §6: the c870bde lost-write is the existence proof).
- [P3] (perf) Per-scenario frames-delivered metric on the dashboard cards —
  events-exact already subsumes message inflation (sim.events counts deliveries);
  a separate frame counter is attribution polish, not coverage.
- [P3] (repo) Root plan-v3.md §7.1 wording ("zero heap allocations per steady-state
  inbound record") is narrowed by DECISIONS V3-21 to zero-RETENTION + budgets —
  the amendment belongs to the session that owns root files.

## Open questions (from plan §11 threads not yet forced by the build)
- [P2] (api) Cross-partition ordering guidance beyond the recipe (a derived
  `cluster.writes` join was the M5 sketch; revisit if users ask for transactions).
- [P3] (kernel) AsyncIterator methods (plan §11's deferred thread).

## data-v4 migration residue (V4-1)
- [P3] (api) Windowed-sort subscription streaming: data v4 round-trips moves
  (W1/W3); fero mirrors are keyed (object-born) — streaming positional sorts
  needs a mirror-keying redesign. Both skips (serve + apply) kept, documented.
- [P3] (api,perf) Frame-batched inbound apply: the lane applies per-record
  today (0.547× the v2 path even unbatched, m3 gate); batching per shell frame
  is a further win when a workload wants it.
- [P3] (api) fold.ts cell-isolation armor is mostly moot under clause 10d —
  slim it when the file is next touched.

## The v4.1 surface (V4-2 residue)
- [P3] (api) `client: true` as an explicit role pin — deliberately absent (with
  client the default it pins nothing); add the day an asymmetric-intent process
  wants to refuse accidental server markers.
- [P3] (api,shell) A non-loopback RENDEZVOUS / default listen — never a default
  (unauthenticated peer plane); an explicit `rendezvous: '10.0.0.5:3376'` is an
  operator's declared act today; revisit defaults only alongside peer-to-peer
  auth (see the carried v2 rejection).
- [P3] (api) A held-shard local read under scoping (f.snapshot throws typed
  today) — needs a name that cannot be mistaken for the resource ('shard'?);
  wait for demand.
- [P3] (api) A transitional diagnostic for v4.0 solo idioms — a bare config that
  was a solo pre-V4-2 ({uuid} alone, {seams} alone) boots as a client silently;
  cluster.me.role now names it, but a one-release composer warning would catch
  migrations earlier. Add only if migration reports appear.
- [P2] (kernel,api) OVERLAPPING CELLS — a row-level record (`key:['gadgets']`,
  e.g. a `data:` seed or `data.gadgets = {…}`) and a leaf record
  (`key:['gadgets','stock']`) are INDEPENDENT LWW cells: the kernel fold
  converges cell-for-cell (converged() is satisfied) but the DATA PROJECTION
  depends on the order the two cells were applied, which differs per node.
  Repro (2026-08-30, scratch parked-probe): memory-only server seeded
  {gadgets:{stock:3}}, client writes stock=9 while the server is down, server
  restarts (re-seeds) → the client's parked write commits at the new server,
  yet the server's snapshot reads 3 (old-life row record arrived after the
  leaf) while the client reads 9 — persistent until the next leaf write.
  Candidates: order a parent cell against its descendants at apply (a parent
  write tombstones/subsumes older child cells; a child write newer than the
  parent re-applies over it), or project from the kernel fold by key depth.
  Reproduced 2026-08-31 by the site's recorded demo (scratch site/record.mjs →
  demo-transcript.json): after the memory-only restart BOTH projections show
  the seed values (widgets 10, gadgets 3) although the watcher's leaf cells are
  newer, and the watcher's write parked during the outage (gadgets 1→0) never
  shows at the new server.
  Needs a sim oracle on the PROJECTION, not only the cell map.

## The directory (V4-3 residue)
- [P2] (tools/debug) Badge `#`-prefixed SYSTEM resources in the viewer/scenarios
  pages (the name rides HELLO and the boot record, so a capture can tell), and
  capture the directory nodes through `diag(f).rendezvous()` — viewer.html was
  mid-edit in another session when V4-3 landed, so the seam exists and the
  rendering does not.
- [P2] (api) Cross-box discovery: `hosts: ['10.0.0.5']` (host, no port) meaning
  "ask THAT box's directory" — the old `hosts × ports` idea with ports = [the
  rendezvous]; the HELLO name echo already guards the misdial. Needs the
  explicit-listen rule (a loopback listen must never be gossiped off-box).
- [P3] (kernel) A one-heartbeat settle after the last `discover` change before
  genesis proposes — only if partial-first-view + JOIN churn ever shows up in a
  real deployment (the ballot arbitrates today; sim-pinned).
- [P3] (api) A shared per-process directory client (one socket per process
  instead of one per instance) — rejected at V4-3 for uniformity; revisit if a
  process hosting hundreds of resources minds the sockets.
- [P3] (kernel) A failure detector over CLIENT links (PONG accounting): today a
  hung-but-connected client keeps its directory entry and its served
  subscriptions until TCP notices; crashes and clean closes are immediate. The
  panel accepted the gap; close it the day a hung watcher matters.
- [P3] (shell) Ref'd timers/sockets: a process holding only a bare client never
  exits without `destroy()` (pre-existing; V4-3 adds a second Runtime per
  instance, so the demo's "just fero(name)" now pins the loop harder). Decide
  deliberately: unref the directory client's timers/sockets, or document
  `destroy()` as the exit protocol.
