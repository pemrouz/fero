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
- [P3] (kernel) DIAG token transport: cleartext by design in v3.0 (trusted
  networks / tunnel); allowlist object values ({token, scopes}) reserved.

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
