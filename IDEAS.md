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
- [P3] (kernel) **`writeAck` is journaled twice per forwarded write.** The
  relay hears one commit twice — as the replicated record carrying its
  attempt identity (kernel/write.ts:677, :750, "replication IS an ACK") and
  as the owner's WACK frame (:501, `onAck`). The record path emits only when
  it clears a pending attempt; the WACK path emits before it looks, so the
  second row clears nothing although journal.ts:62 says "pending attempts
  cleared". A diary reader counts two acks per write (rung 21's probe-A rows
  24-26; sim/write.test.ts:43 already words it "replication-ACK or duplicate
  WACK"). Fix: emit at :501 only when an attempt was cleared, or carry the
  cleared count; eli5.mjs:227 then reads true.
- [P3] (kernel,tools) **`gateClose evicted` on a newcomer that was never
  in.** The gate names every non-member of a committed view 'evicted'
  (kernel/membership.ts:173) and `settle` journals it (:473). A joiner that
  learns the view on admit — before its JOIN is voted — installs it
  (`onView`, :407), is not in it, and its first gate row reads `gateClose
  evicted`; the ELI5 glossary explains the word as "it was voted out"
  (eli5.mjs:217). Rung 21's probe-C rows 16-17. A distinct reason when no
  earlier view held this node ('joining'); the reason is a free string
  (journal.ts:53), the ELI5 line grows one clause.
- [P3] (kernel,tools) **Two spellings of a clean leave in the survivor's
  diary.** A leaver that is the lowest live member proposes the shrunk view
  itself (kernel/membership.ts:520-523), so the survivor's diary shows only
  `vote e 1 <leaver>` then `viewInstall`; a leaver that is not the lowest
  knocks LEAVE and the survivor shows `leave <uuid>` then `propose`
  (:339-345, :525). A reader grepping `leave` misses half of all clean stops
  (rung 21: story-A rows 16-17 vs check-1.log:32). Options: emit `JK.leave`
  on the survivor when a PROPOSE arrives whose members omit the proposer, or
  say so in 21's README and the ELI5 card for `vote`.
- [P3] (tools/debug) **A truncated journal switches the scrubber off in
  silence, and paints `replay ✗` red.** When a node's event ring overflowed
  (`dropped > 0` — 23's `--fero.journal.cap 64` line) the row gets a
  `truncated` pill and `8 +69 jrnl` (viewer.html:494-495, :523) with
  "dropped" only in the hover; the scrubber goes `disabled` with the reason
  as a tooltip alone (:942-944, eli5.mjs:43); and the header's replay fact
  goes crit — `replay ✗ a: journal truncated (69 dropped)` (model.mjs:121
  returns `ok:false` for any `dropped > 0`; `headerFacts` :890 paints every
  `!ok` crit) — red on a healthy cluster whose ring did what it was sized to
  do. Options: a visible word at each site (`+69 dropped`, `rewind off —
  journal truncated`) and warn, not crit, when the only reason is `dropped >
  0` (the softening `shrunk` already gets at :880). Found by 20 and 23.

## Security (post-1.0 peer auth, plan §12)
- [P1-at-1.0] (kernel) **The r:1 client-plane uuid-spoof hole**: any client HELLO
  presenting a member's uuid can trip the dup-link keeper against the real member.
  DIAG (r:2) is structurally immune; the client plane is NOT — belongs to the
  peer-auth workstream; DIAG's immunity must not be mistaken for closure.
  Narrowed 2026-09-05/06 (V4-4, V4-5): a client's WRITE is relayed by
  ADMISSION FACT (`ae === 0 || link.client`); ACK/NACK frames on a client
  link drop; RECORDS on a client link drop and a spoke never ships a suffix
  (spokes are views — they resync to the cluster's truth). What remains is
  the HELLO itself: an r:1 HELLO presenting a member's uuid still trips the
  dup-link keeper against the real member — the peer-auth question proper.
- [P3] (kernel) DIAG token transport: cleartext by design in v3.0 (trusted
  networks / tunnel); allowlist object values ({token, scopes}) reserved.
- [P3] (api,kernel) **Residue of the methods door (DECISIONS V4-4/V4-5, both
  steps LANDED 2026-09-05/06):** (a) advertise the pin in the server→client
  HELLO so a client refuses at issue() with zero RTT — a typed local reject
  instead of a round-trip WNACK (since V4-7 nothing shows meanwhile, so this
  is only the latency of the answer; HELLO bytes are a stability surface);
  (b) a typed `NACK.methodsOnly` refusing on the tag byte without decoding
  the body — only if a consumer needs the typed class (today the door rides
  `invalid` + `m`); (c) whether the kernel's own outcomes inside a handler
  ('superseded' | 'dropped') should fail the call like a validator refusal
  does (retry semantics for non-idempotent methods); (d) a `sell` rung for
  the site and the examples series — the homepage narrative: the demo, "you
  probably don't want everyone to change anything", protect with `methods:`.

## api surface
- [P3] (api) **The `seams:` nest is vestigial since V4-5.** `Seams` exists as
  "the ONE reserved nested config key for function-valued config, so the
  'functions are methods' recognition rule survives" (api/types.ts, plan §9).
  V4-5 retired that rule: recognition is by declared key alone, a top-level
  function THROWS with the `methods:` pointer, and `seams` is itself just a
  CONFIG_KEY with one member (SEAM_KEYS = validation, api/index.ts). The
  nest no longer buys anything; it costs every caller a brace and a name
  (the owner's 2026-09-13 site comment on the config snippet: "is this
  seams thing still valid/necessary?"). Options: (a) promote `validation:`
  to a top-level key and keep `seams.validation` as an alias for one
  release; (b) keep the nest as the declared home for hash/codec/storage
  when they land, and say so where Seams is documented. `validation` itself
  stays valid and is the only hook of its kind: the schema check on an OPEN
  server's relayed client writes, on the server's own writes, on handler
  ctx.data writes and on the data: seed (DECISIONS V4-4/V4-5); under
  `methods:` the door refuses client records before it.
  V4-10 note: no layer but the call can carry a function, so the config
  layer neither forces nor settles this — `seams.validation` is call-only
  in the carriers table under either spelling, and a rename here is a
  one-line table edit.
- [P3] (api) **SUB-leg handler errors are silent at the client.** A handler
  that throws — or, since V4-5, whose ctx.data write the validator refuses —
  on a SUBSCRIPTION answers a RESULT for a sub id, which Caller.#onResult
  drops (no call to settle): the live handle stays `{}` forever and
  onPrimaryChange re-subscribes into the same failure. Pre-existing for
  thrown handlers; V4-5 routes refusals into it too. Surface it on the
  handle (an error on open()/the proxy, or a journal row) — the CALL leg is
  loud already.
- [P3] (shell,api) **isolate/heal on the diagnostics handle** — rejected in v3.0
  (a TCP shell cannot hold a partition honestly); the sketch if ever wanted:
  dial-refusal set + identified-kill + revive suppression in the shell — three
  coupled pieces, not a one-liner.
- [P3] (api) Confirm-lane visualization on the live dash (the write-route timeline
  reads the route join only; confirm probes are a separate lens).
- [P2] (api) **An uncaught WriteReject dies with no stack, no method and no
  resource name.** `write()` throws bare objects (`{ guarantee, reached,
  reason }`, api/index.ts:405/412/426), so `instanceof Error` is false and
  `.stack` is undefined; Node's uncaught report is one line — `{ guarantee:
  'committed', reached: 'issued', reason: 'timeout' }` — and a reader who
  forgot `server: true` sees exactly that after 10 s, with no hint that a
  bare `fero(name)` is a client. Options: a `WriteRejectError extends Error`
  carrying the three fields (every `satisfies WriteReject` consumer keeps
  working) with a message like `fero('shop') update ["x"]: timeout after
  10000ms — reached issued (nobody to write to: a bare fero(name) is a
  client; pass server: true to host)`; or keep the object and add `message`
  + `stack`. Found by rung 04.
- [P2] (api,kernel) **`confirm: 'persisted'` on a memory-only node waits out
  the full timeout for a rung it can never reach.** A node without `dir` has
  no durable ladder (kernel/confirm.ts:197 reads the `d` mark, which never
  advances), so the probe can only time out — 10 s by default. The kernel
  knows both facts at issue time: its own `durable` mode (kernel/node.ts:54-57)
  and whether any peer has announced durable evidence (`Confirm.durablePeer`,
  confirm.ts:119-120). When neither holds, `write()` (api/index.ts:421-426)
  could reject at once with a typed reason and `pass dir: to persist` —
  refuse only when no durable evidence source exists; a memory-only member
  with durable peers CAN reach it. Found by rung 12; 10's README already says
  "nobody here has a disk, so the third rung can never be proven".
- [P3] (api) **The Guarantee comment does not say the bar is SELF alone at
  epoch 0 and in a view of one.** api/types.ts:10-13 defines 'replicated' /
  'persisted' as "a majority of the committed view"; kernel/confirm.ts:26-30
  and :183 (`members === 0 ? 1 : (members >> 1) + 1`) make the threshold 1 at
  open genesis and after a clean leave to one. A memory-only solo resolves
  `replicated` in 1 ms, a durable solo `persisted` in 7 ms. Examples 10 and 12
  say it ("a majority of one is one"); the typed comment a reader hovers does
  not. One sentence. Found by rungs 10, 12, 17.
- [P3] (api) **`ctx.peer` is undefined on a server-local call.**
  `Host.invokeLocal` builds its Context without `peer` (api/methods.ts:188;
  stated at :68-69). A server calling its own method writes the field away —
  a `post` in 40's shape writes `{ text }` with no `from`, and every joiner's
  comparator would throw. Options: set `peer` to the server's own uuid for a
  local invoke (it IS the caller) — one line — and say so in the Context doc;
  or keep undefined and warn in 08 and 40. Found by rung 40.
- [P3] (api) **Peer rows carry no role, so a screen cannot count clients.**
  `cluster.peers` is every identified live link (api/index.ts:569-571),
  members included; a row is `{ uuid, incarnation, up }` (api/types.ts:157-161).
  The kernel knows each link's role (`client`, kernel/link.ts:62-65) but the
  row does not carry it, so 02's `watchers N`, 03's and 11's `clients N` and
  41's `editors N` count a joined server. Fix: a `client: boolean` (or
  `role`) on the Peer row, one field in the same fold; until then a header
  should say `peers N`, as 15 does. Found by rungs 02, 03, 11, 41.
- [P2] (api) **A client cannot say who feeds it: no `primary` on
  `cluster.me`.** A client digests exactly one server. The kernel holds it as
  a link id (kernel/node.ts:344-346) and the composer already watches it
  change (`lastPrimary`, api/index.ts:505, 546-548) to re-subscribe live
  handles — but the view exposes nothing. Rung 14's check and story pin the
  feeder by SPAWN ORDER, and its failover story cannot name the survivor.
  Fix: `me.primary: string | null` (the uuid) set in the same fold, or a
  `primary: true` flag on the Peer row. Found by rung 14.
- [P3] (api,doc) **A new row's key rides `at`, not `key` — the record shape
  is documented only in rung 04.** A record tap delivers data's v2 record
  profile (api/substrate.ts:116, typed `{ type, key, value?, at? }`). A NEW
  top-level row arrives as `{ type: 'insert', key: [], value, at: '<row>' }`
  — the row key in `at` — while a rewrite and a remove carry it in `key[0]`
  (../data/compat/v2-records.ts:108/112/127). 42's page (`key[0] ?? at`) and
  43's notifier (`r.at`) depend on it; only 04's README says it; kernel/env.ts:183
  calls `at` "the ordered-insert position key" although `partitionOf`
  (env.ts:206) reads it as the partition of a keyless insert. Fix: one
  sentence where `tap` is introduced in the root README, the same on
  `records`'s type, and widen env.ts:183. Found by rungs 42 and 43.

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
- [P2] (kernel) **Every admit ships each missing suffix TWICE.** Both ends
  send an r=1 digest on admit (kernel/node.ts:1148-1153). Each r=1 gets the
  missing suffix plus an r=0 reply (1366-1389); the reply's tails were
  computed before the other side's suffix arrived on the FIFO, so the reply
  shows the same lane missing again and the suffix ships a second time; the
  receiver `dupDrop`s it. On a large log a join costs twice its bytes.
  Evidence: every rung 21 transcript (`aeShip`, `aeShip`, `dupDrop`); the
  paused-link comment at node.ts:691-694 already knows the shape for drains.
  Options: only the lower-uuid side opens the exchange on admit (the PING
  rule at 690); or remember per link the tail shipped per origin and skip a
  re-ship the reply cannot have seen. Wire bytes change: a sim golden and the
  AE perf pin move with it.

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
- [P3] (data,doc) **`za(comparator)` reverses the WHOLE comparator, tiebreak
  included — say so.** `za(src, cmp)` is `(a, b) => cmp(b, a)`
  (../data/ops/ordered.ts:528-531), so `a.price - b.price ||
  a.name.localeCompare(b.name)` lists tied names Z→A under `za`; the column
  form `za('price')` returns 0 on a tie and falls to insertion order
  (ordered.ts:188). Not a bug — the only meaning an opaque comparator allows
  — but nothing says it: the type `za(by, n?)` (public.d.ts:295) carries no
  comment, and 07's README says "`za` is the same, descending" one sentence
  before recommending the comparator-with-tiebreak. A reader who wants
  "descending price, names A→Z" writes that comparator and uses `az`. One
  line on the type, one in 07. Found by rung 07 (probe 2026-09-28, scratch
  `land/warts-data/probe2-za.txt`).

## The v4.1 surface (V4-2 residue)
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
  2026-09-12: the demo (now examples/02-server-client) no longer has this
  shape — the server rewrites WHOLE rows and the client appends FACT rows, so
  no row record ever overlaps a leaf; the wart itself is still open and still
  reproducible by a leaf write on a seeded row (the 02 README warns). Its
  post-V4-5 shape (probed 2026-09-12, a spoke never teaches now): after the
  memory-only restart the server re-seeds the row and the CLIENT's resync
  ghost-removes the stale leaf cell from the re-seeded row — the client's row
  loses the field ({price} without {stock}) until the next whole-row write.

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

## The example series (V4-8 residue, 2026-09-14)
- [P2] (api) **`cluster.writes` out of the cluster tap's domain.** The confirm
  ring lives in the same view as `members`/`writable`/`peers`, so a bare
  `cluster.tap` fires on every write outcome (pending, then committed) — the
  one honest noise left after V4-8's one-batch fold. Options: its own proxy
  behind a `cluster.writes` getter (rung 03 reads it — the public shape must
  survive), or data-side child-handle taps (`cluster.members.tap`). Until
  then the examples render from the DATA tap and read the members there.
  Rung 13 saw the same tap paint 23 identical frames in 8 s while its cluster
  was wedged: the confirm ring's pending rows change on every retried write.
- [P2] (kernel) **A crashed member is evicted only after the redial chain
  gives up (~20 s at the defaults: MAX_REDIALS × the backoff cap).** During
  that window the survivors keep writing but the dead member's partitions
  park, so its rows freeze on every screen and then catch up. Rung 13 will
  say so; a shorter chain for admitted members (they were reachable a moment
  ago) is the knob to weigh.
- [P2] (api) **`cluster.writes` lags the value by one kernel step.** A write
  shows in `data` the moment it commits, but its row in `cluster.writes`
  flips from `pending` to `committed` only when the composer's fold runs —
  after a kernel step (api/index.ts:513-518; the row itself settles in a
  microtask, api/data.ts:97-99, 174-177). On a quiet node the next step is
  the heartbeat, so a screen reads `pending` above an object already holding
  the row for up to `heartbeat.ms`; a LOCALLY refused assignment's `rejected`
  row is in `Bind.outcomes` at once (data.ts:150) and in `cluster.writes` at
  the next tick. Probe 2026-09-28 (scratch `land/warts-api-cluster/writes-lag.txt`,
  `refused-lag.txt`): `pending` at 0 and 50 ms, `committed` at 650 ms. Fix:
  publish the ring from a microtask on every outcome change (one coalesced
  `cluster.set('writes', …)`) instead of waiting for a step — pairs with the
  entry above. Found by rungs 11 and 41.
- [P3] (api) **A leaving member paints its own leave view as its last
  frame.** `destroy()` leaves by ballot first (V4-6) and the vote installs
  the shrunk view on the leaver too, so the cluster tap fires after
  `destroy()` was called and a live-picture screen's last frame reads
  `writable false — members N-1` as the process exits (api/index.ts:677; the
  fold at 508-580 has no `stopping` guard). Rung 10's server transcript ends
  that way. Options: stop setting the cluster proxy once `stopping` is set,
  or say in the examples that the last frame is the goodbye. Found by rung 10.
- [P3] (api) **Ctrl-C before `fero()` resolves is Node's default, not the
  clean stop.** The signal registry arms at `track(inst)` (api/index.ts:725),
  after `await rt.start()` (617 — the listen bind and, with `dir`, the whole
  WAL restore) and `await directory.start()` (632). A SIGINT in that window
  ends the process by signal: the port is bound, the directory entry may be
  registered, and nothing leaves or tears down. Small, but V4-8 promises
  "Ctrl-C is a clean stop". Fix: track a provisional `{ destroy: abort }`
  right after Runtime construction (the `abort` closure at 584 already tears
  down what was built) and swap it for `inst` at 725. Found by rung 12;
  source-read, not probed.
- [P3] (examples,api) **Role files that take ports on the command line
  cannot take `--fero.<key>` flags.** 13, 15 and 16 read
  `process.argv.slice(2)` as ports while examples/README.md says every option
  can come as a flag. `node client.ts 4801 --fero.heartbeat.ms 50` builds
  `hosts ["127.0.0.1:4801","127.0.0.1:--fero.heartbeat.ms","127.0.0.1:50"]`
  and dies with Node's raw `Port should be >= 0 and < 65536` (probe
  2026-09-28, scratch `land/warts-api-cluster/flags.txt`): the composer checks
  `hosts` entries only for non-empty strings (api/index.ts:112-113), though
  `isAddr` is imported there. Two lines: the series README says the
  port-taking files take the variable form (`FERO_HEARTBEAT_MS=50 node
  client.ts 4801`); the composer runs `isAddr` over every `hosts` entry and
  names the bad one. Found by rungs 15 and 16.
- [P2] (api) **`fero.spawn` has no stdin.** api/spawn.ts:21 hard-codes
  `stdio: ['ignore', 'pipe', 'pipe']`, so `handle.child.stdin` is null and a
  check cannot type into a role's readline. 41's edit.ts grew an argv
  one-shot mode that exists only so the check can drive it, and 40's check
  drives a separate scripted role (bot.ts) and can only WATCH the reader's
  join.ts. Fix: a third argument `{ stdin: 'pipe' }` (default `'ignore'`, so
  existing checks and the parent's Ctrl-C story are unchanged) and a
  `write(line)` on `Spawned`; the README's terminals then match the check's
  keystrokes. Found by rungs 40 and 41.
- [P2] (api) **A method handle is a callable Proxy with no `apply` trap, so
  `assert.rejects(f.methods.x(…))` fails with ERR_INVALID_RETURN_VALUE.**
  `handle()` wraps `function () {}` (api/methods.ts:359) and traps only get /
  set / has; `typeof h === 'function'` and `h()` returns undefined, so
  `assert.rejects` treats the handle as a promise factory, calls it, and
  throws `Expected instance of Promise to be returned from the "promiseFn"
  function but got undefined`. `assert.rejects(async () => f.methods.x(…))`
  works — 43's check writes it that way, 40's uses `.then(ok, err)`. Fix: an
  `apply` trap returning `caller.call(m, a, opts)`, so `h()` is the one-shot
  promise and every promise utility works. Found by rungs 40 and 43.
- [P3] (api,data) **Refusal messages run past 120 characters and wrap at
  80.** api/substrate.ts:206 (`insert()`) is 140 chars, :210 (`ingest()`)
  133, :214 (`raf()`) 121, data's child-operator refusal
  (../data/api/index.ts:546) 162 — the only lines in the series' transcripts
  that wrap, so 04's README prints only the clause before ` — `. Put the
  pointer on a second line or cap the first clause near 80. Found by rung 04.
- [P3] (tools,examples) **A driver cannot Ctrl-C `npm run debug` through
  pipes.** `npm run debug -- <file>` is npm → `sh -c` → node; from a Node
  driver holding the pipes, `child.kill('SIGINT')` on the npm pid stops
  nothing (probe 2026-09-28, scratch `land/warts-tools/probe-npm-sigint.txt`:
  all three alive 5.5 s later), while `detached: true` + `process.kill(-pid,
  'SIGINT')` stops them in 510 ms. By hand it never shows — the terminal
  signals the foreground group — so the `^C` in the 20/22/23 READMEs is
  true; it bites every driver, and `fero.spawn` (no `detached`, SIGINT to the
  pid) cannot stop the debugger at all. Options: a `node tools/debug/serve.ts
  <file>` spelling plus a SIGINT handler in serve.ts that closes and exits 0,
  so the debugger stops like a fero role; or a `/quit` route. Found by 22,
  20, 23.
- [P3] (tests) **The harness's private rendezvous port can collide with a
  check's member ports.** tests/examples.test.ts:36 picks each check's
  `FERO_RENDEZVOUS` by bind-0/close ("a now-snapshot, not a reservation",
  utils/index.ts:11-18); moments later the check picks its member ports the
  same way in a new process (13, 15, 16, 30, 43). Linux hands bind-0 ports at
  random in 32768-60999, so a member port equals the rendezvous in about 3
  of 28,000 checks; then `fero()` refuses the role (`listen … would take the
  directory's socket`, api/index.ts:175-178), the check's first `until`
  waits 30 s and fails with the '(is this example open in another
  terminal?)' hint, and the real reason sits in the harness's stderr tail.
  Seen once by 13's builder; 0/40 in a targeted repeat. Options: pick the
  rendezvous port outside the ephemeral range (try 20000-32767 until one
  binds), one line in the harness; or each check re-draws a port equal to
  `FERO_RENDEZVOUS`.
- [P3] (examples) **Durable checks leave their dirs on failure.** 12, 13,
  40, 42 and 43 remove their WAL dirs before and after with no try/finally,
  so a failed assertion or the harness's group SIGKILL skips the trailing rm;
  fixed-name dirs (`./inventory`, `./notes`, `./room-general`) are rm'd at the
  next start, the port-named ones (`vault-<port>`, `ledger-<port>`,
  `fleet-<port>`) pile up, gitignored, one set per failed run. 30's
  `fleet.ts` wipes only its own three ports for a reason: a folder-wide wipe
  clobbered a concurrent story's live WAL dirs, and two members died with
  `ENOENT … boot.json.tmp` at their leave (I-36). Options: one sweep in the
  harness before and after each check (every `<word>-<digits>` dir in the
  folder), zero lines per rung. Found by 13, 43 and 30.
- [P3] (examples) **A live-picture role that also takes typed lines wipes
  the half-typed line on every redraw.** 40's join.ts and 41's edit.ts follow
  the V4-11 screen rule — clear and redraw on every change — in the terminal
  the reader types into: every incoming row clears the screen under the
  half-typed line; the characters stay in readline's buffer and post on
  Enter, but they are no longer visible, and there is no prompt. The READMEs
  sidestep it ("Typed: `add c1 …`"). Options: redraw with
  `readline.cursorTo` / `clearScreenDown` then `rl.prompt(true)` (reprints
  the pending line); a fixed prompt line under the picture; or interactive
  roles as sequence rungs. A house choice for the screen rule, not a bug in
  fero. Found by 40 and 41.

## The config layer (V4-10 residue, 2026-09-19)
- [P2] (kernel) **The tune table.** The kernel's timing and bound constants
  stay constants after V4-10; the config layer exposes only the keys the
  composer already took. The design (DESIGN-CONFIG.md §7 step 7): a frozen
  per-node `tune` object built once in the Node constructor, defaults equal
  to today's constants so sweep bytes stay identical, hot sites reading a
  field set at construction. Constants: `MAX_REDIALS` (the crashed-member
  knob, filed above), `SUSPECT_TICKS`, `LEAVE_TICKS`, the redial backoff
  cap, `COMPACT_AT`, the cid-dedup window, the stream/AE bounds. Read sites
  to touch: kernel/write.ts:207/219/356/363/498/533, membership.ts:218/249,
  scope.ts:137/697/702/710, node.ts:324/406/439/719/1045/1099, link.ts:106,
  log.ts:158, confirm.ts:75, shell/runtime.ts:397, sim/monitors.ts:30.
  Land only with an interleaved A/B on the write, node, alloc and data
  perf pins; own DECISIONS line. `MAX_REDIALS` and a separate live-read
  cadence are the two with a filed need.
- [P3] (kernel,api) **A HELLO-carried hash of the cluster-contract keys**
  (`heartbeat.ms`, `replicas`, `seams.validation`). These must be the same
  on every member, and V4-10 lets one member's shell set them alone
  (`FERO_HEARTBEAT_MS=50` on one box). Today the mismatch shows as behavior
  (suspicion at the wrong cadence, a partition map that disagrees), not as
  a refusal. A short hash in HELLO, checked beside the name echo, would
  refuse the misdial at the door. Needs a spelling for `seams.validation`
  (a function hashes by nothing — its source text, or a declared version).
- [P3] (api) **The `diag` key.** `NodeOpts.diag { allow: { name: token } }`
  exists (kernel/node.ts) but is not a FeroConfig key, so the M7
  diagnostics channel's SERVER side is unreachable from the public
  `fero()`: every `npm run debug -- --attach` against a real cluster is
  denied. The config layer is its natural home (`diag: { allow: { alice:
  'token' } }`, `FERO_DIAG_ALLOW_ALICE=token`, refused as a flag — a secret
  never rides argv). Deferred from V4-10 because its natural env shorthand
  `FERO_DIAG_TOKEN` is the debug VIEWER's variable (tools/debug/serve.ts),
  which the layer strips. Land it with `FERO_DIAG_TOKEN` stated as the
  viewer's only and token values redacted from `diag(f).config()`.
- [P3] (repo) **optcascade wishes** (1.1.0 of 2026-09-21 shipped the
  lowercased flag keys and the prefixed bad-flag error; these remain — none
  blocks; each would let api/config.ts shrink): a declared-keys mode for the
  PREFIXED form, with
  case-insensitive env matching as the no-prefix form already does — fero
  could then drop its own schema walk for unknown keys; provenance per key
  (which layer, and which file path, won), so a file error and `from(key)`
  can name the path; a `strings` list of keys never coerced, so
  `--fero.uuid 12345678` survives without fero's number refusal.
- [P2] (api) **`journal.cap` below one step's burst starves the cluster
  fold.** The composer folds `cluster` from the kernel journal by cursor once
  per step (api/index.ts:504, 528-533, hooked at 580); the journal is a ring
  of `cap` rows (kernel/journal.ts:125-135: `read(from)` starts at `max(from,
  n - cap)`), so a step that emits more rows than the cap loses its earliest
  rows before the fold sees them — and the fold's side effects ride those
  rows (`linkDown → host.reapLink`, `shed → bind.shedPartition`, `viewInstall
  → gather.refresh`, the refold kinds). The layer accepts `journal.cap` down
  to 1 (api/index.ts:152); at the default 4096 only a very large single frame
  does it. Nothing reads `j.dropped` on this path. Options: read `j.dropped`
  in the fold and re-derive from live state when it moved; or floor
  `journal.cap` at a safe minimum and say why in the README row. Found by
  rung 21 (source-confirmed, not probed).
