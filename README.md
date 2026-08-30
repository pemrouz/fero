# fero v3 — M0…M8: kernel, replication, membership, writes, durability, the fero() api, scoped replication, debug tooling, hardening

> **fero v4 — NOW THE REPO ROOT** (promoted 2026-08-16; the v2 surface and the frozen v3 tree live on at the `master` branch tip). This tree is fero v3 MIGRATED ONTO DATA v4 (../data — the sibling repo, whose own v4 tree was promoted to its root the same day; the DESIGN-DATA3 wishlist, all landed). See [STATUS.md](STATUS.md) for the migration ledger; the inherited milestone log below describes the v3 lineage this tree carries.

The from-scratch rewrite of fero-v2, built to plan-v3.md (`master` branch tip). This folder
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
seed and zero persisted-confirmed writes are lost), **M6 scoped replication** (R-sets,
keep-until-confirmed shedding, the one-teacher handover, owner-scoped folds and the
gather — hardened by a 55-finding adversarial review whose centerpiece is the pp
floor law), and **M7 debug tooling, full** (the authenticated DIAG wire channel, the
trajectory shrinker, the Symbol-keyed `[diagnostics]` handle, the 5-node live dash,
and the honesty promotion gate) over a debug tool (capture → typed model → viewer with
time-travel replay) that has co-evolved with the protocol since M0 — each piece pulled
forward exactly when a seed sweep or review demanded it, which is the architecture
working as designed.

## Run it

```sh
npm test                       # 292 tests: Tier-1 unit/fuzz, Tier-2 sim sweeps + AA/disk/scoped fault schedules, Tier-3 real-TCP + real-WAL smoke, debug-model + scenario suites
npm run perf                   # perf gates: counted invariants first, ratios second, absolutes last — now incl. the alloc gates (--expose-gc) + the baseline gate
npm run perf:alloc             # just the allocation gates (kernel/alloc.perf.ts)
npm run perf:absolute          # run the persisted-baseline probes, print the delta table (tools/perf/BASELINE.md)
npm run perf:pin -- --runner=<label> --reason "why"   # pin the baseline (the ONLY writer; advisory on this box)
npm run sim -- --seeds 1000    # 1000 seeded chaos trajectories (dup faults + partition/heal + writes racing formation)
npm run scenarios              # run the scenario registry, print the table, pin/refresh results/ (--rebase re-pins the baseline)
npm run debug                  # scenario DASHBOARD at /, the debugger at /debug (http://localhost:4699)
npm run sim -- --seeds 5 --capture 3   # force-write a healthy capture to explore in the debugger
npm run debug -- captures/seed-3.json  # open a capture in the debugger
npm run debug -- --live        # spin a REAL 5-node TCP cluster + owner-routed traffic and debug it live
npm run debug -- --live --nodes 3      # ...at another size
npm run debug -- --live --contend      # ...with a deliberately conflicting workload (LWW elections on demand)
npm run shrink -- --seed 42            # minimize a failing sweep seed → captures/seed-42.shrunk.json
npm run shrink -- --replay captures/seed-42.shrunk.json   # re-run a minimal repro from DATA (the fix-verification loop)
FERO_DIAG_TOKEN=… npm run debug -- --attach h:p,h:p       # dash a REAL multi-process cluster over the DIAG wire
```

Measured on this box (WSL2): `1000/1000 seeds green · 237,451 events in ~4.5s
(~53,000 events/s)`. Every seed is a full cluster lifecycle — dial-race formation
under per-pair delay/duplication faults, a mixed-type write workload issued
DURING formation (deliberately racing the dial-race window), convergence + drain +
per-event invariant monitors. A failing seed prints itself; re-running that seed
reproduces the trajectory bit-for-bit.

## Green-or-quarantined (the policy, stated)

The suite has NO ambient-red baseline and no flakes-as-backlog: every test either
passes or is QUARANTINED — an explicit `t.skip` carrying (a) the reason, (b) a
pointer to the IDEAS entry with the repro seed, and (c) the un-quarantine
condition. A bare skip with none of those is a review reject. Two skip classes
are sanctioned WITHOUT an IDEAS entry because they are environment honesty, not
defects: the absolute-tier gate on a box whose fingerprint did not pin the
baseline ("no baseline for this runner" — tools/perf/BASELINE.md), and a Tier-3
probe that declared its own run invalid (probe-error: formation flake after
retry, a mid-run backpressure shed). A flake is reproduced under seed sweep and
classified product-bug vs test-bug before any other work continues; any
real-socket failure must be reproduced as a sim fault primitive before its fix
merges. Scope honesty: this policy governs v3/ — the root v1/v2 tree is other
sessions' domain.

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
- **ELI5 tooltips** ([tools/debug/eli5.mjs](tools/debug/eli5.mjs)): hover anything
  on either page — a stat, a pill, a journal-kind badge, a route stop, a metric
  key, a phase chip, a header fact — for a plain-English card (one term line,
  one or two sentences in the house words: computer, diary, ticket number,
  record book, member list, tie-break). ONE glossary + ONE hover layer, plain-JS
  ESM shared verbatim by both pages and the tests, the same way model.mjs is:
  every `data-tip="<key>"` resolves there or paints nothing. Copy explains what a
  label MEANS and never asserts a fact about the loaded capture (a repeated fact
  rides `data-tip-fact`, escaped, as a dim second line). `eli5.test` polices it
  both ways: every key either page paints must resolve (a sweep boots the real
  page scripts over every scenario capture, a mid-flight live capture, an
  overflowed-ring cluster, a never-healed cut run to quiescence and an attach
  envelope with every absent reason), every entry must be reachable (dead copy
  fails, with a short documented list of what no truthful offline producer can
  paint), and the closed vocabularies — all 71 journal kinds, every registry
  metric key and phase label — are pinned in both directions.
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
  clusters are the same format in the same tool. `--live` runs **5 real TCP nodes**
  by default (M7's live-dash bar): the workload's key→writer rule is uncorrelated
  with the kernel's ring, so most writes enter at a non-owner and the KERNEL
  owner-forwards them — the cid write-route timeline (issued → forwarded →
  sequenced → applied at every node) lights up on real traffic. Measured on a
  fresh 5-node run: 44 route rows, 25 owner-forwarded writes, converged,
  replay-verified. `--contend` posts random-origin writes to a shared key set: it
  demos real LWW elections in the pre-genesis open window, after which the pipeline
  serializes even a deliberately conflicting workload through one sequencer — which
  is the M3 story on one screen.
- **The DIAG channel + attach mode** (M7 — [kernel/diag.ts](kernel/diag.ts),
  [tools/debug/attach.ts](tools/debug/attach.ts)): the same debugger, pointed at a
  REAL multi-process cluster. A debug client opens a normal link, HELLOs with `r:2`
  + a bearer token from the node's `diag.allow` allowlist, and latches into a
  session that is **structurally outside membership** — never in `byUuid` (a spoofed
  uuid cannot evict a real member), never admitted (invisible to genesis, suspicion,
  heartbeats, anti-entropy), never in the client set (zero per-record cost while
  attached). Pulls are cursor-chunked (journal / logs / node fold / state), so a busy
  node stays servable where a monolithic pull would frame-overflow into a dial loop.
  The wire says only `denied`; the TYPED reason (`no-config` / `bad-token` /
  `malformed`) and the audit identity (the allowlist NAME, never the token) live in
  the journal. `--attach h:p,h:p` rebuilds `/capture.json` from fresh pulls per HTTP
  request; a node that will not answer becomes an `absent` row with a typed reason,
  never an invented node card.
- **The shrinker** ([sim/shrink.ts](sim/shrink.ts)): a failing seed's capture is
  joined by a MINIMAL one. Every schedule is a list of literal `Step`s and every
  build-time rng draw runs unconditionally, so removing a step cannot shift another
  step's randomness — determinism is self-enforcing rather than bookkept. The oracle
  is the first failure's CLASS (monitor name / named end-check / normalized crash),
  never its detail, and the artifact carries the original and minimal failure lines
  side by side so a shrink that landed on a different bug is visible rather than
  hidden. The final run is frozen AT the violating event, so the capture opens there
  by construction — time-travel needs no scrubber machinery. Measured on the M7
  acceptance demo: **40 steps → 1**, in 6 candidate runs, replay-verified.
- **The honesty promotion gate** ([tools/debug/honesty.test.ts](tools/debug/honesty.test.ts)):
  plan §3.6 made executable. Empty-but-valid REAL-PRODUCER captures are folded and
  deep-equal-pinned (any field a fold learns to invent breaks it); every string leaf
  every fold emits must trace to a capture fact, a closed enum, or a composite
  identity whose every PART traces; `verifyReplay`'s prose is the one carve-out,
  pinned by template and exercised by a deliberately-truncated fixture so it can
  never go dormant; an absent row must change the header and nothing else; and the
  viewer is pinned at source to exactly one model import with no local fold
  redefinition (v2's dual-language drift bug, made structurally impossible).

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

**M5:** a 6-lens review over the whole `api/` layer returned 14 findings; the
verify pass (two adversarial skeptics per finding) confirmed 13, all fixed and
pinned (205 → 215 tests). The headline was a genuine **critical the panel split
on** — resolved by an empirical repro, not a vote:
- **Re-entrant fast-path write orphans the outer write (critical).** At epoch 0
  (the solo/forming-server operating mode), a local write mints no kernel cid, so
  the binding PREDICTS cids and settles positionally. A user tap that writes from
  inside the apply drains a re-entrant `issue()` INSIDE the outer one (the
  substrate contract); it re-sampled the SAME predicted cid and clobbered the
  outer's single-slot collector + `#pending` key, so the outer write's promise
  never resolved — flush-on-return HUNG and `cluster.writes` stuck 'pending'
  (and a sibling case mis-rejected the trailing records 'superseded'). One refuter
  argued `data`'s `transact` serializes the writes; a 3-line repro showed the
  `_pending` drain runs INSIDE the outer apply, before the outer settle — the bug
  is real. Fixed with a STACK of per-call collectors + settling OWN promise refs
  (not colliding map keys).
- **Server-local methods skipped flush-on-return and returned a live alias
  (major, two findings).** The server-local dispatch used a no-op flush and blind-
  awaited the handler (collapsing thenable proxies), so local and wire invocation
  of one handler gave opposite durability, and `read()` handed back a mutable
  alias of committed kernel state. Both now route through `host.invokeLocal` — the
  same ALS flush + non-blind-await + clone-on-proxy-return as a wire CALL.
- **`'unreachable'` sentinel collision (major).** A handler throwing the exact
  string was misread as the kernel's no-primary failure — the call hung to timeout
  then re-executed on failover. The result effect now carries an unforgeable
  `local` channel bit; a wire reply is never mistaken for a pre-dispatch failure.
- **The dual-mode handle opened a subscription on introspection (major).**
  `String(h)`, `JSON.stringify`, an `in`-check, a symbol access all hit the get
  trap and leaked a client+server subscription. Coercion hooks and symbols are now
  passive (a marker, never a SUB); only a genuine reactive read opens the stream.
- **Subscription lifecycle races (major, two findings).** A SUB's `#subs` entry
  was registered AFTER the flush-on-return await, so an UNSUB or a link death
  during that window was lost, leaking a live server stream. The entry now
  registers up front with a cancelled flag the deferred open checks. And a live
  sub over a DERIVED (operator) proxy died after GC — the stream pinned only the
  leaf sink, not the operator chain; the entry now retains the live proxy.
- Plus: `write()` captured + cleared its timeout timer (a bare `setTimeout` leaked
  one timer + reject closure per write on the hot path) and normalizes async kernel
  rejections ('superseded'/'dropped'/'destroyed') into typed `WriteReject`s; the
  illegal `data[value] = x` root hatch now throws loudly AND heals the proxy back
  to the confirmed fold on a microtask (data sets the root before the sink can
  refuse it). Every fix has a mutation-killer pin; one finding was refuted (the
  clone-free read alias is `data`'s inherent shared-mutable model, reachable via
  the primary `data.k` read path too — not specific to the method surface).

## The cross-partition recipe (M8, plan §5 "Ordering")

fero orders exactly one thing: each (origin, partition) stream — strictly
increasing seqs, in order, from exactly one broadcaster. There is **no cross-origin
or cross-partition ordering and no cross-partition atomicity**, and no API implies
it. A method handler that writes two partitions performs two independent commits:
each is exactly-once and confirmable, but there is no transaction spanning them.
When you need more:

1. **Model it single-partition.** The partition IS the atomicity domain — the
   top-level key (`data.user42 = {…}` → partition `user42`). Co-locate state that
   must move together under one top-level key and write it in one assignment: one
   record run, one owner, one sequencer, atomic by construction. This is the
   answer for the overwhelming majority of "transactions" (an entity + its
   sub-entities as one nested value).
2. **The outbox pattern for cross-partition effects.** Write the primary state AND
   an intent row in the SAME partition (atomic): `data.order17 = { …order,
   outbox: { creditUser: 'user42', amount: 5 } }`. A consumer — a method or a
   subscription on `.filter(o => o.outbox)` — applies the second-partition effect
   and clears the intent. Retries are safe: the consumer's write is idempotent by
   key, the intent row is the durable cursor, and `confirm: 'persisted'` on the
   first write makes the intent crash-proof before anything acts on it.
3. **Read-after-cross-partition-write:** the cid overlay gives read-your-writes
   per client per partition; to OBSERVE another client's cross-partition pair,
   await `confirm: 'replicated'` on the first write before reading the second —
   ordering is then yours, purchased explicitly, not implied by the API.

## The availability posture (M8, plan §5 "Membership"/"Scoped")

**Writes are CP.** Commit requires the majority side of the committed view: the
minority's writes park in ONE bounded drop-oldest buffer (`writeBuffered`, depth
surfaced; overflow drops the OLDEST batch and says so — `writeBufferDrop`), and
flush at the then-current epoch on heal. A stale-epoch node pulls the newer view
with bounded retries, then releases its gate ALARMED (`gateAlarm`) — availability
degrades loudly, never a silent wedge.

**Reads stay open.** Membership gates COMMITS and majority math, never
replication: every node keeps serving its local (possibly stale) state through a
partition, an evicted node still converges as a reader, and its stale-epoch
stamps simply lose LWW. Clients (spokes) fail over their primary on link death,
re-park in-flight attempts at the new relay, and re-subscribe live handles — the
handle survives its server dying.

**Durability is explicit.** `confirm: 'persisted'` = a majority holds the write
DURABLE (storage batch resolved — never merely applied). Kill −9 the whole
cluster at any seed: restore replays the WAL through the ingest path and zero
persisted-confirmed writes are lost (the M4e proof, a pinned test). A rejoining
node is read-only until a committed view ≥ its restored epoch is confirmed live;
a full-cluster restart self-ballots from the restored view.

**Scoped mode trades memory for loss, never the reverse.** Exactly-R holders is a
two-sided invariant; a non-holder sheds only when every current holder attests
coverage (keep-until-confirmed: under churn the node HOLDS — memory grows,
`shedStall` alarms escalate, data never silently disappears). Data whose holders
left the R-set freezes as an ORPHAN: its owner's writes NACK `withheld` (typed,
retryable) until the one-teacher handover re-homes the data — a bounded
availability dent in exchange for zero-loss handover, which is the posture
everywhere: fero prefers refusing loudly over answering wrong.

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
  diag.ts       the authenticated DIAG plane (M7): the r:2 session latch + cursor-chunked pulls, structurally outside membership
shell/    production adapters (TCP + timers + the fsync WAL/boot-record store), zero protocol decisions
api/      the public surface: fero(name, opts) → {name, data, methods, cluster, snapshot, destroy} (V4-2: role by declared act; V4-3: bare fero(name) = a client that looks the name up in the box's #directory, a server binds a free port and registers — api/directory.ts)
  substrate.ts  the ONE seam onto the `data` sibling ($() proxies): record-apply ingress, clone-free capture, sync detach
  data.ts       the binding: capture→ingest, apply→proxy, echo match-and-consume, the cid-keyed overlay (read-your-writes)
  index.ts      the composer: declared config schema (typos throw), seams.validation, default write methods over the confirm ladder
  methods.ts    the method plane (M5c): the invoke HOST (flush-on-return via ALS) + the rpc CALLER (dual-mode Handles, failover policies)
  types.ts      the exported unions: Guarantee, WriteResolve/WriteReject, FeroConfig, Fero
  diagnostics.ts the Symbol-keyed internals seam (M7): capture/journal/served/confirms/compact/drop — absent beats faked
sim/      the executive: virtual time, seeded faults (FIFO-clamped), per-event monitors, sweep CLI
  shrink.ts     the trajectory minimizer (M7): literal Steps + unconditional build draws ⇒ removal cannot shift randomness
tools/debug/ the debug tool: capture → model folds → viewer; scenarios dashboard; live + DIAG attach modes (M7)
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
monitor + event index. Capture/replay/time-travel get their substrate for free
because state is a deterministic fold of the journal'd inputs — M7 spent that
substrate on the shrinker (a failing seed's capture is joined by a minimal one,
frozen at the violating event) and on the DIAG channel (the same folds, pulled off
a real multi-process cluster over the wire).

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
- **M5 — the public api — is COMPLETE** (M5a composer + M5b clients + M5c
  methods + M5d cluster/scenarios/demo; adversarial review pending) (api/):
  `await fero(name, opts)` → `{data, methods, cluster, destroy}` over `$()`
  (V4-2 widened the surface to `{name, data, methods, cluster, snapshot, destroy}`)
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
  - ~~A spoke's confirm probes see only its primary's digest evidence~~ —
    closed by M5c: confirm-over-RPC (the system plane) proves a spoke's
    guarantee AT its primary, which holds the full member evidence. Durable
    clients (offline-first) remain refused loudly at fero() time — M6.
- **M5c — the METHOD PLANE — is LIVE**: RPC + live subscriptions over five new
  control verbs (CALL/RESULT/SUB/UNSUB/SUBREC), with the kernel ROUTING and the
  api HOSTING (purity: a user handler is arbitrary async code — it surfaces as
  the `invoke` effect and answers via `reply`/`subOut` events; the kernel never
  runs it and tracks no rpc state). The shape:
  - **Return-type dispatch, both ends** (plan §9): the host probes the handler's
    return with the view symbol (a ViewProxy is subscribable, a value is a
    value); the caller's dual-mode HANDLE picks consumption by touch — `await`
    is a one-shot CALL, any reactive touch opens the live subscription into a
    local mirror proxy (then/open/close/mode are the reserved handle surface).
    The never-blind-await lesson is pinned: a ViewProxy is THENABLE, so awaiting
    a handler result would collapse the live view to one frozen frame — the
    host probes before awaiting (and an async handler returning a proxy still
    collapses by promise adoption — return live views from sync handlers).
  - **flush-on-return is BUILT** (plan §9, not documented-and-deferred): an
    AsyncLocalStorage collector attributes every write a handler issues (across
    awaits) to its invocation; the reply awaits them all at 'committed', and
    `ctx.flush()` is the mid-body barrier — pinned by a Tier-3 test that holds
    a reply hostage behind a closed write-gate.
  - **Failover policies close v2's OQ2**: live handles RE-SUBSCRIBE on the new
    primary (same id — server subs are per-link; the fresh initial snapshot
    root-replaces the mirror); 'unreachable' (never-shipped ⇒ never-executed)
    calls re-dispatch safely for everyone; shipped-and-lost calls fail fast
    unless {retry: true} (re-execution is only safe when declared idempotent —
    method invocations are NOT cid-deduped; only the writes they issue are).
  - **The client methods namespace is OPEN** (a spoke cannot know its servers'
    method names): any name yields a handle; unknown names reject typed from
    the server. Server-local calls are one-shot invokes (v2's localMethods
    rule) — live local projections are `data` + operators directly.
  - Stated limitations: SUBREC bodies ride the control value codec (per-delta
    clone + value encode — the perf tripwire bounds it); 'move' records
    (windowed sorts) do not stream — subscribe to the source and sort on the
    client proxy; async handlers returning proxies collapse to snapshots.
  - Validation: 201 tests (3 kernel routing pins, 5 Tier-3 method suites incl.
    flush-hostage and failover re-subscribe), 18 perf gates, epoch-0 sweep
    byte-identical, 17/17 scenarios zero drift.
- **M5d — cluster end-to-end + the public scenario library + the demo**:
  - **cluster.writes is the bounded confirm ring** (plan §9): the last
    WRITES_KEEP=64 write outcomes as reactive rows {key, state: pending →
    committed | rejected, origin/seq/epoch/cid, reason}. Plan Q4 is DECIDED:
    pending rows are visible in cluster.writes and never marked inside `data`
    itself — observability is a cluster concern; the data surface stays pure
    value. The ring lives in the binding; the composer folds it on the same
    post-step hook as the view (one integer compare per event when quiet).
  - **The fold decision (deferred from M5a) is DECIDED**: the post-step hook +
    journal cursor IS the mechanism for cluster reactivity — a first-class
    membership sink effect would duplicate journal facts for one consumer.
    Revisit only if M7's diagnostics work wants membership effects for replay.
  - **The scenario library runs against the PUBLIC surface**
    (tests/api-scenarios.test.ts): v2's chaos vocabulary — 5-node formation +
    concurrent-writer convergence, kill/restart-from-WAL through
    fero(name,{dir}), the FULL-CLUSTER kill + restore-from-WALs-only (the M4e
    proof, public edition), and cluster.writes observability — no kernel
    reach-through in any scenario body. Partition/heal stays sim-only by
    design (real-TCP partition injection tests the harness, not fero).
  - **The two-terminal demo** (examples/two-terminals.ts): `npm run demo --
    serve` / `npm run demo -- watch` — a server mutating an inventory by
    plain assignment, a client re-rendering through one tap AND writing back
    (a client's assignment rides a WRITE frame to its server, is stamped
    there, and echoes to every watcher); kill and restart the server and
    anti-entropy reconciles both ways. Since V4-2 the demo needs
    ZERO addresses/identities: the server is a server because it declares a
    `data:` seed, the watcher is bare fero(name) — and since V4-3 both meet
    through the box's directory: the server binds a FREE port and registers
    it with `#directory`, the watcher looks the name up live (no hashing; a
    second `serve` in a third terminal joins the first as a cluster).
- **V4-3 — the per-box directory** ([DESIGN-DIRECTORY.md](DESIGN-DIRECTORY.md),
  DECISIONS V4-3): the name-derived port is gone. `#directory` is a SYSTEM
  resource (the `#` prefix is reserved — fero() refuses it for users) at one
  well-known loopback rendezvous, `127.0.0.1:3376` ("FERO" on a keypad, below
  the ephemeral range; `FERO_RENDEZVOUS` env / `rendezvous:` config, `false`
  = no directory). The first server on the box to bind it hosts a soft-state
  registry `name → {uuid: listen}` on the method plane (never a log, never a
  WAL); every dialable instance opens a `#directory` client: servers bind a
  free port (`127.0.0.1:0`, the shell publishes the real address to the
  kernel before start) and `register`, everyone opens `lookup(name)` as a
  LIVE subscription whose folded addresses feed the kernel's new `discover`
  event (static ∪ dynamic hosts, cached; forgotten targets park, never
  closed). Entries die with their registrant's link; a host's death makes
  the surviving servers race for the port and the lookups re-subscribe —
  registrants re-register on every primary change. Measured before/after:
  N bare servers of one name now form a view with no addresses and no uuid
  pins (the genesis coin-flip is closed), a bare client finds explicit-listen
  servers, two names never collide, a NEW joiner after the host died still
  finds the survivors, and a non-fero squatter on the port is survived.
  `cluster.me` carries the effective `hosts` and `rendezvous: {addr, hosting,
  up, error?}`; the diagnostics seam exposes the directory nodes. Precedence:
  `rendezvous:` config > `FERO_RENDEZVOUS` env (an address, or `off`; it sets
  the PROCESS DEFAULT and never overrides an explicit key) > the constant.
  Trust boundary, stated: the directory is as unauthenticated as the peer
  plane — loopback IS the boundary; any local process can register any name
  (it could equally dial the resource and HELLO with that name); a per-caller
  cap bounds a runaway, nothing authenticates. A user resource may not listen
  on a rendezvous socket under any spelling (`0.0.0.0:3376`, `localhost:3376`
  …), and a name-rejected target is revived at heartbeat cadence, so a squat
  is a bounded nuisance, not a strand. The battery runs with the directory OFF
  (every non-directory suite pins `FERO_RENDEZVOUS ??= 'off'` at import, so a
  single-file run never meets a live box directory); api/directory.test.ts
  opts in with a free rendezvous port per test. The post-landing adversarial
  panel and its fixes: DESIGN-DIRECTORY §10.
- **M8 — hardening is LIVE** (panel-designed like M6/M7: 2 candidates + a skeptic
  judge per open question + a plan-coverage critic; the alloc judge ran its OWN V8
  probes to adjudicate a factual dispute between candidates). What landed:
  - **Allocation verification with teeth** (kernel/alloc.perf.ts, `npm run
    perf:alloc`, and inside the default perf gate): the panel's adjudicated finding
    is that a naked gc-fenced heap delta is UNSOUND for exactly the failures it
    exists to catch — scavenges EAT the delta, so the signal SHRINKS as a
    regression grows and min-of-k selects the most-truncated window. The sound
    instrument is a conjunct: delta-≤-slack AND `gcEvents === 0` (GC-event physics:
    a loop that allocates nothing can never scavenge — categorical at every
    regression magnitude, and immune to WSL2 CPU noise). Three claim classes
    (DECISIONS V3-21): zero-GARBAGE ring lookups, zero-RETENTION steady cycles
    (duplicate-absorb, Outbox, issuer leg), retention-BUDGETS on the fresh path
    (retention IS the product — the honest claim is ≤512 B/record, batch-
    independent). The suite's mutation control (D6) proves the instrument can see.
    **Its first run found a real bug**: ring.holdersOf discarded its scratch's
    backing store every call (~7 scavenges/100k calls) — fixed to index-cursor
    writes (0 events), gate Z4 fencing it forever.
  - **The persisted absolute tier** (tools/perf/: fixtures single-sourced with the
    perf siblings, a 9-row probe registry, a pure compare module, the pin CLI, and
    [BASELINE.md](tools/perf/BASELINE.md) — the never-widen escape hatch written
    down). Counts (bytes-per-record 73, frames-per-burst 3, per-forward 1,
    per-owner-run 3) exact-compare on ANY machine; wall medians compare only on
    the runner FINGERPRINT that pinned them (host + OS + CPU + Node major), with
    `advisory` posture printing and only a `pinned` posture (refused on WSL/VM
    boxes) enforcing. A pin refuses on missing --runner/--reason, any erroring
    probe, an out-of-band baseline move, and a tolerance outside the validated
    10–50% cap (the bypass a candidate design left open). First pin: advisory,
    wsl2-devbox.
  - **Socket throughput, measured honestly** (tools/perf/probes.tcp.ts): ~62k
    records/s through the real TCP shell on this box — completion clocked by an
    onApply COUNTER (never the Lamport watermark, which is not a record count —
    a panel-caught trap), validity by JOURNAL physics (a tap counting
    dropOldest/aeShip: a mid-run shed that AE heals passes every end-state check
    while the median measures anti-entropy — so both must be zero or the run is a
    typed probe-error, never a number). Plus the digest-build gate (100 origin
    lanes, entry count exact) closing plan §7's last counted-invariant gap.
  - **The v2 referent, classified** (DECISIONS V3-20): v2's L2 write path is
    socket-coupled at construction — the plan's headless interleaved A/B is
    unconstructible against it, and against v2's bare L1 (array push + project,
    no dedup/LWW/provenance/watermarks) it is a category error: measured ~9× in
    v2's favor, which prices exactly the machinery v2's L1 does not do (v3's own
    strawman ratio, ~3×, is the tracked analogue). The real referent — both
    stacks over sockets — is specified beside the pinned-runner IDEAS entry.
  - **The ledgers + the recipes**: v3/DECISIONS.md (V3-1…V3-21 + carried v2
    rejections) and v3/IDEAS.md (every DESIGN-M6/M7 residual, the carried module
    debts, the Tier-3 descope, the CI provisioning entry) seeded; the
    cross-partition recipe and the availability posture written (above); the
    green-or-quarantined policy stated with its two sanctioned skip classes.
- **M7 — debug tooling, full is LIVE** (design record: [DESIGN-M7.md](DESIGN-M7.md),
  panel-synthesized: 3 open questions × 2 independent candidate designs × 1 skeptic
  judge, every citation verified against the tree before synthesis). Most of plan §8
  had already been pulled forward — the journal spine (M0), the capture format, the
  typed model with time-travel + replay-verify, the full viewer, the scenario
  dashboard. M7 closed the five things that were genuinely absent:
  - **The DIAG wire channel + its allowlist** (kernel/diag.ts, verbs 23/24, JK
    68–70): the authenticated diagnostics plane plan §8 reserved from the first
    protocol byte, and — per plan §12 — the only auth v3.0 ships. The panel killed
    the obvious design: a monolithic whole-node pull frame-overflows on exactly the
    busy nodes you attach a debugger to, and the resulting FrameError → link drop →
    re-dial is a deterministic loop, so pulls are cursor-chunked instead. The
    session is a LINK STATE, not a peer: never in `byUuid` (so a diag client
    presenting a member's uuid cannot trip the dup-link keeper and evict it), never
    admitted, never in the client set. The HELLO path — the kernel's most
    safety-critical code — grew exactly one branch. The wire deny is one constant
    (`denied`) so an unauthenticated prober learns nothing, while the journal keeps
    the typed reason and the allowlist NAME; the token never rides the journal.
    Journal pulls are deliberately NOT journaled: journaling reads-of-the-journal at
    follow cadence evicts the very history being followed (a 1 Hz dash would eat a
    4096-row ring in minutes) — the audit anchor is the session latch plus its
    linkDown.
  - **Parity by construction:** `captureNode` is re-based onto the same `diagNode`
    fold the wire serves. One producer, two consumers — an in-process capture and a
    remote attach cannot drift, and a deepEqual pin backstops it anyway.
  - **The shrinker** (sim/shrink.ts) and the acceptance loop: chaos failure →
    minimal repro → the capture opens AT the violating event. Measured on the
    acceptance demo (a fence-blind log re-append mutant, the V1d precedent):
    **40 steps → 1 step in 6 candidate runs**, replay-verified, with the
    original and minimal failure lines side by side in the artifact so a shrink
    that wandered onto a different bug is visible rather than hidden. The repro
    block is standalone-replayable from DATA (`npm run shrink -- --replay`) — the
    fix-verification loop.
  - **The `[diagnostics]` handle** (api/diagnostics.ts): v2's Symbol-keyed idiom on
    v3's organs — capture / journal cursor / served / confirms / logSize / compact /
    drop. Nothing is stubbed: `observe`/`isolate`/`heal` are ABSENT rather than
    faked (the journal cursor and the public tap are the pull-spine answers; a TCP
    shell cannot hold a partition honestly). The review's shared defect is fixed
    here: `compact()` is size-gate-free (v2's drive-it-deterministically purpose)
    but REFUSES on an armed node — forcing a member-ranged frontier pass on a scoped
    holder could drop the only real copy, so the pin wins and says so.
  - **The 5-node live dash** and **the honesty promotion gate**: measured on a fresh
    `--live` run — 5 nodes, converged, 44 write-route rows, 25 owner-forwarded
    writes with acks, replay-verified. The gate makes plan §3.6 executable, and it
    caught a real derived-key case on its first run (it now verifies the DERIVATION
    of composite identities rather than blanket-allowing their shape).
  - Full battery after M7: **288/288 tests, 20/20 perf gates, 1000/1000 identity
    sweep at exactly 237,451 events** — every byte of the new surface is
    unreachable without an `r:2` HELLO or a DIAGQ arriving, so the frozen sweep is
    untouched, and the harness refactor the shrinker required is pinned by a
    200-seed golden against the frozen pre-split scenario.
- **M6 — scoped replication + aggregates** (design record: [DESIGN-M6.md](DESIGN-M6.md),
  a three-design judge panel synthesis; landed as six slices, M6a-M6f):
  - **R-sets**: `replicas: N` config (explicit mode like durable/client — unset
    is R=∞ and every scoped branch is provably inert: the 1000-seed epoch-0
    sweep stayed byte-identical at exactly 237,451 events through all six
    slices). `ring.holdersOf` extends ownerOf — holder[0] IS the owner, so
    single-writer is untouched; a per-epoch memo makes the fan-out filter one
    Map.get per record.
  - **The scope machine** (kernel/scope.ts): held | acquiring | orphan per
    partition. Commits fan out to holders only; the inbound gate drops
    non-assigned records before the fence; orphans HARD-FREEZE (floors never
    advance — monitored expected-empty).
  - **The evidence plane**: per-(origin, partition) POSSESSION FLOORS
    ("contains-or-covers ≤ s") beside the untouched per-origin dedup fence;
    the DUAL FENCE splices lawful cross-link interiors; the no-interior-rows
    WAL discipline (splices reach disk only via the snapshot swap; a dirty
    ledger in the boot record keeps replay floors honest across crashes).
    HAVEQ/HAVEA carry attested marks (the DIGEST wire shape is untouched in
    both modes); scoped confirm counts W-of-the-R-set on attested marks only.
  - **The handover**: one-teacher ACQ/ACQDONE latches (stage → verify count →
    atomic fold → floors := the attested cut → staged live replays above it);
    five abort legs drop the buffer whole. The STATELESS shed re-evaluates
    fresh per arrival/install/tick — every current holder must attest
    coverage of every frozen lane; crash-safe both sides (H1 proven both
    legs); shedStall alarms at doubling cadence, shedWaitingOn names pinners.
  - **The gather** (api/fold.ts, v2 Q3 carried): whole-resource read() IS the
    download — stamped claims over held ∪ unshed-orphan scope, per-key LWW
    merge, PARKING + the coverage sweep. §9 holds end-to-end: holistic
    operators throw typed ScopedError (never a silent shard fold), `await
    data` routes through the gather, non-held keys answer via typed remote
    handles, ScopedError rehydrates typed across the wire.
  - **THE Q3A VERDICT: real, reproduced, closed** (sim/q3a.test.ts). The plan
    called it a "suspected real bug" — the mutation study (a v2-faithful
    owned-only root-replace gather in the identical harness) vanishes keys on
    60/60 {A,B}→{C,D} seeds; v3's parked union survives 1000/1000 seeds of
    the same windows (500 organic grows + 500 pin-flip double handovers, 5ms
    refresh slices through the acquisition window). The hunt also caught
    three real v3 projection bugs before they shipped: parent-tombstone
    ordering over live nested cells, explicit-undefined representability
    (tombstone-equivalent, pending the value-codec ticket), and one doomed
    cell aborting the whole projection transact (now per-cell isolated) —
    plus refresh serialization (a one-shot read racing a shed re-gather
    answered a mid-flight partial).
  - **Deferred with rationale** (the M6 residual ledger, for the review round
    and the next milestone): announcement-gated AE + scoped compaction
    un-pinning are COUPLED (ring-gated AE is provably safe while compaction
    is pinned — the H3 resurrection needs differently-compacted teachers);
    tombstone GC stays pinned when armed; the distributed decomposable folds
    (sum/max/avg facade) deferred by de-scoping rung 2 — holistic ops throw
    with the materialize-first hint instead; spokes mirror their primary's
    held shard (whole reads are gather-backed; subscription-scoped
    tap-forward is future work); explicit-undefined cells do not cross the
    gather; the live gather re-arms by install + paced re-poll (a push-based
    claim stream is a wire optimization).
  - **THE M6 ADVERSARIAL REVIEW ROUND** (6 find-lenses × 2 skeptics per
    finding, every verdict traced against the real code): 55 findings, **50
    confirmed**, 1 split, 4 rejected — every survivor fixed with a
    mutation-killer pin. The centerpiece fix is **the pp floor law**
    (DESIGN-M6 §7 addendum): the fast-path possession-floor advance's old
    license ("single-source ascending sub-stream delivery") was locally
    unverifiable and false in three confirmed-critical windows (mid-lane
    first arrivals minted held with a forged prefix claim; an AE re-admit
    race dropped the healing span at the dual fence; two senders serving one
    lane interleaved into the same forgery — each breaking exactly-R/P2/P3
    permanently). Every armed record now carries `pp`, its sender-stamped
    (origin, partition) predecessor (FLAG_PP, one varint per record; wire 0 =
    unknown, which FAILS CLOSED), and a floor advances only when it already
    covers the predecessor — locally-verifiable sub-stream contiguity, with
    the boot record now carrying a floor SEED the replay chain-rebuild
    advances from. Companion structural fixes: the shed bar re-based onto
    frozen lane TAILS (floors lawfully under-claim under pp — the old
    empty-floors husk drop destroyed epoch-0/bootDirty data with zero
    coverage proof); durable ACQDONE attestation gated on the snapshot
    swap's echo (`sealed` — an orphan can never shed against marks one crash
    erases); the boot record's held/orphan split (a restored orphan
    re-enters only through the latch, never a silent un-freeze); the install
    order fixed to VIEW-flood → rescope → boot-write; evidence-plane
    liveness closed (round-on-admit, marks-lag re-rounds, the orphan
    re-entry latch at equal floors, non-holder confirm probes with
    probe-local evidence); the armed fan-out's run-discontinuity frame
    rotation (a latent wire corruption on multi-record scoped batches); and
    the gather's coverage sweep re-based onto per-answer ATTESTATION sets
    (an acquiring or post-shed answerer can never attest absence) with
    departed-member claim reaping. Test honesty landed alongside: the scoped
    P2 oracle (`scopedConfirmedIntact`), engagement guards on the CHURN and
    Q3A sweeps, and monitor snapshot/vacuity fixes. Full battery after the
    round: **254/254 tests, 20/20 perf gates, 1000/1000 identity sweep at
    exactly 237,451 events** — the entire fix round is byte-invisible at
    R=∞.
- The plan's pre-M4 CHECKPOINT (the M2–M4 swamp guard) is
  [CHECKPOINT.md](CHECKPOINT.md) — verdict: no overrun, ladder armed but not
  triggered, M4 sliced into five landable increments (M4a streams/watermarks →
  M4b storage seam + boot record → M4c confirm ladder → M4d log/compaction →
  M4e the restore proof), each closing named debts from the ledger — all five
  are now LIVE.
- **Verification status (per plan §7/§11), updated at M8:** the allocation claims
  ARE now counter-verified — kernel/alloc.perf.ts under --expose-gc (DECISIONS
  V3-21: zero-garbage ring lookups by GC-event physics, zero-retention steady
  cycles, fresh-path retention budgets; the suite's first run found and fixed a
  real holdersOf violation). Absolute medians + socket throughput ARE persisted —
  tools/perf/results/baseline.json (advisory posture on this box; see
  tools/perf/BASELINE.md for the runner-identity rules and the escape hatch). The
  replay-refold check has been live since the debug tool landed. Repo CI remains
  unprovisioned: no git remote exists, so workflows would be dead files — the
  provisioning entry is IDEAS P1, and the baseline machinery is ready to accept
  the pinned runner's numbers the day it exists.
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
