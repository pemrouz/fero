# DESIGN-DATA3 — the data-v3 wishlist + migration plan

> Produced 2026-08-01 by a five-reader research pass over both repos (fero root
> tree usage, fero v3 substrate contract, data v3 surface/seam, both repos'
> ledgers, perf coupling), synthesized, then adversarially verified by a
> two-critic pass (fact-check vs both trees; completeness vs the reports) whose
> findings are folded in. Purpose per the request: BEFORE migrating fero onto
> data v3, collect every way data v3 could serve fero better, so those land in
> data v3 first and the migration starts against a finished substrate. This is
> the wishlist (§3), the fero-side design decisions it forces (§4), and the
> migration plan (§5).

**data v3 state** (sibling repo, branch `v3`; 23 local commits unpushed, 25
past PR #1 as of 2026-08-01 — re-measure at D0): COMPLETE and flipped — bare
`data` IS v3, v2 lives permanently at `data/v2`. 286 tests, corpus geomean
0.940–0.945× of v2 (v3 ahead), crossfilter RSS 0.837× of v2. Methods-only
writes, non-callable non-thenable handle, a closed delta algebra
(`add/remove/update` + a separate order channel + `prev` everywhere), a
permanent v2-ChangeRecord compat profile, and a `seam/` layer (ingest(),
origin tokens, SourceBacking, fromAsync, exportContract()) built with fero
named as the consumer.

**fero state**: two trees consume data v2 by source-relative import of the v2
SOURCE (root tree: `../../data/index.ts`; fero v3 seam:
`../../../data/index.ts` — note the flip re-plumbed dist/package.json only, so
these relative source imports still silently mean v2).
- The **root tree**: 14 modules import data (~45 symbol escapes in sources,
  ~300 incl. tests), the change-record shape IS the binary wire format
  (message.ts), `value` re-exported as fero public API.
- The **fero v3 tree**: ONE import seam — [api/substrate.ts](api/substrate.ts)
  — but THREE proxy populations behind it: the resource `data` proxy (+ Bind's
  echo/overlay machinery in [api/data.ts](api/data.ts)), the `cluster` proxy
  (assignment-written by the post-step fold, api/index.ts:309-374), and the
  per-subscription mirror proxies (applyStreamRec + whole-value root-replace
  on resubscribe, methods.ts). Kernel/shell/sim/debug are data-free by
  construction.

**Scope decision (recommended)**: migrate the **fero v3 tree only**. The root
tree is superseded by fero v3, its wire format is byte-coupled to v2 records,
and data v2 remains permanently published at `data/v2` — freezing the root tree
on v2 costs nothing. (§4.4.)

---

## §1 The coupling today — what any migration must carry

Five load-bearing contracts (all probed, all pinned by tests/perf):

| # | Contract (data v2) | fero consumer |
|---|---|---|
| 1 | `$()` + capture sink: clone-free bare verbs, sync in-trap fan-out, WeakRef retention, sync `[view].disconnect` | substrate.ts `capture()` — the local write path (clone tax avoided: ~30–40% of v2's write budget) |
| 2 | `[view].res.update/insert/remove(value, key, at?)` — keyed-path apply, auto-vivify | `applyRec` (data proxy) + `applyStreamRec` (subscription mirrors) — the record→state ingresses |
| 3 | v2 ChangeRecord `{type, key: string[], value, at?}` | the binary wire format, partition routing (`partitionOf`), LWW cell identity (`versionKey`), log compaction rules |
| 4 | `[value]` snapshot (live mutable alias in v2) | forWire, membership tick, gather, chaos assertions; forces `structuredClone` at every hand-out boundary |
| 5 | Synchronous read-after-write; sink exceptions rethrow after cascade | write pipeline ordering; the loud root-replace throw |

And the wart list the migration should DELETE (all compensations for v2
semantics): echo match-and-consume by cell+value-identity (`#expected`),
the re-entrancy frames stack (transact drains `_pending` INSIDE the outer
apply — the c870bde lost-write class), #healRoot (root replace commits before
sinks can refuse), FunctionSink pinning (no detach / no back-ref / WeakRef-only),
per-cell try/catch in the gather (deep ops crash on missing/null intermediates
in v2, one doomed op aborts the whole transact), the scoped-facade's hardcoded
OPERATORS set (api/index.ts:130), the thenable-await guard order.

## §2 Already answered by data v3 — do NOT re-ask

| fero pain (ledgered) | data v3 mechanism |
|---|---|
| Echo suppression by cell+value identity; verb-rewritten echoes | Origin tokens: `CommitBatch.origin`, kernel-level `if (entry.origin === batch.origin) continue`; reaches derived sinks; the batch-origin-restore bug already found+fixed |
| Symbol reach-through apply (5 sites) | Public `ingest(target, records, {origin})` — both profiles, one commit per call, at-least-once/LWW tolerance written for fero by name |
| Remove of an absent key = crash risk | Already an idempotent no-op at the kernel (node.ts:424) and the seam (out-of-range positional remove) — spec-pinning is the residue (W3b) |
| Deep write under null/scalar intermediates = crash (v2 seed-13/41 class) | pathCopy auto-vivifies null AND scalar intermediates on live rows (node.ts:206-220) — spec-pinning is the residue (W3c) |
| No old value on remove/update | `prev` first-class in the algebra (free inverse records) |
| `move` deltas unstreamable (windowed sorts) | Separate typed order channel + `SourceNode.move()`; both ingest profiles route moves |
| FunctionSink lifetime (no detach/back-ref) | SubscriptionHandle `{dispose()}`, strong scope-owned refs, owner scopes |
| Operator-name/partition-key collision; thenable await | Non-callable non-thenable handle + frozen RESERVED (45 names) + `get()` total read |
| Hand-copied operator sets | `exportContract()` → `{reserved, operators: {category, declarative}}` live from the registry |
| Undocumented cascade timing (c870bde) | Versioned SCHEDULE.md (SCHEDULE_VERSION 1) — on paper; executable suite is W4 |
| Explicit-undefined cells (between/intersect idiom) | Dense snapshots; sparse-undefined version-broken; "absence = key absence" |
| Positional array identity (BR1 shift artifacts) | Minted monotonic int keys at ingress, never reused |
| filter key access | v3 predicate is `(row, key)` — owner-scoping `(_v, k) => owner(k) === me` survives |
| sclone write tax | Clone-free native CommitBatch sinks (internal today — public contract is W2); kernel path-copy, zero clones |
| Resubscribe snapshot reset (mirror root-replace, illegal as `[value] =`) | seam ingest's whole-value-diff path: `{key:[], value}` applied as a DIFF against current state (seam/index.ts:189-212) — built for exactly this |

Also noted, no ask needed: **fromAsync** (per-drain one-commit, `opts.key` LWW
adoption) is the natural substrate for the AsyncIterator-methods open question
when fero picks it up — record that then, not now. A general coalesce facility
is deliberately NOT requested: fero batches at the frame (D1).

## §3 THE WISHLIST — land in data v3 before the migration

Format: **W# [priority] (data module) title** — ask / why / acceptance.
P1 = migration is blocked or lands worse-than-today without it.
P2 = needed for perf-gate parity or deletes real fero machinery.
P3 = wanted, not gating. The P1 set: **W2, W3, W4, W7, W8**.

### Contract / correctness

**W1 [P2] (seam) Native wire egress — the missing half of the profile.**
Nothing in data v3 EMITS WireRecords; the native profile is ingest-only, and
the promised `keyDomain` batch header is a comment, not code
(contract/index.ts:12-15). fero replicating the native profile would hand-write
the CommitBatch→wire translation and freeze it against internals.
Ask: a public `CommitBatch → WireRecord[]` emitter (or a wire-profile
CollectionSink) symmetric with ingest(), plus the keyDomain-tagged batch
envelope, so `emit → wire → ingest` round-trips by construction.
Acceptance: a round-trip conformance test (emit on A, ingest on B, states
byte-equal, minted-int vs adopted-string key domains preserved).
P2, not P1: per §4.3 fero migrates on its own v2-shaped wire; the native
profile is the second step. W1's absence does not block D0–D5.

**W2 [P1] (api/compat) Origin-capable, clone-free public subscription.**
The public `connect()` mints V2RecordSink which hardcodes `origin = null`
(compat/v2-records.ts:24) and structuredClones every value by design — so a
fero consumer on the public record surface CANNOT suppress its own echoes and
re-buys the exact ~30–40% clone tax the fero v3 substrate escaped. The
clone-free path today is the internal `node.connect(EffectEntry)` via
`Symbol.for('data.v3.node')` — a reach-through, the exact pattern plan-v3 §10
was written to kill.
Ask: `connect(..., {origin?, clone?: false, initial?: false})` (or a public
`sink()` accepting a CollectionSink) as a DOCUMENTED stable contract: by-ref
values, opt-out of the initial snapshot, sync dispose, declared origin.
Acceptance: fero-shaped test — ingest with origin X, sink with origin X sees
nothing, sink with origin Y sees by-ref values, zero clones asserted.

**W3 [P1] (contract/seam) Deep-path law: tolerant, isolated, specified.**
fero is field-granular LWW over arbitrary key paths; replication reorders
freely. Two sub-asks are IMPLEMENTATION, two are SPEC-PINNING:
- (a) IMPLEMENT: nested-field remove — throws "unsupported" today in both the
  api (api/index.ts:213) and the v2-profile ingest (seam/index.ts:184-185).
  fero's field-granular cells lawfully remove nested leaves; this is the one
  hole in ingest's at-least-once tolerance.
- (b) SPEC-PIN: remove of an absent key = idempotent no-op — already true
  (node.ts:424, seam positional no-op); write it into the delta algebra /
  SCHEDULE and pin with conformance so it can't regress.
- (c) SPEC-PIN: deep write under a null/scalar intermediate — already
  auto-vivifies on live rows (pathCopy, node.ts:206-220); same treatment. The
  deliberately-loud case (deep write to a NON-live key) stays loud — correct.
- (d) IMPLEMENT: per-record failure isolation inside one ingest() batch.
  Today's failure mode is the worst of both worlds: records apply in a loop
  inside batch() and the finally still flushes dirty sources on throw — so the
  PREFIX commits and emits, the suffix is silently lost, and the error
  propagates (seam/index.ts:93-108 + runtime.ts:115-127). A bad record must
  skip (or collect into a reported reject list); siblings commit.
Acceptance: ingest fuzz — shuffled/duplicated/dropped record streams from N
origins converge to the same state; an injected bad record never loses or
double-applies a sibling.

**W4 [P1] (contract) The executable SCHEDULE suite, riding both CIs.**
SCHEDULE.md:3-5 claims "executable tests in v3/conformance/schedule.test.ts"
run by "data CI and fero CI both" — that file does not exist, and
SCHEDULE_VERSION has no runtime export. The c870bde cluster-wide silent
lost-write is the existence proof for why an unpinned timing contract is a
production hazard, and fero v3's IDEAS carries the same demand ([P2] substrate
contract suite vs data HEAD).
Ask: write schedule.test.ts (one test per clause: sync batch-of-one,
consolidation, topological delivery, effect ordering, re-entrant FIFO +
issue-time origin, snapshot-then-deltas, emission legality, echo suppression);
export SCHEDULE_VERSION; make the suite runnable from fero's CI against data
HEAD.
Acceptance: both repos red if a clause changes without a version bump.

**W5 [P3] (seam) Backing-mounted sources — make SourceBacking constructible.**
SourceBacking{load, apply, subscribe} exists with InMemoryBacking as proof, but
there is NO way to construct a `$()` source ON a custom backing —
InMemoryBacking owns its own SourceNode. The stated design ("a fero distributed
backing implements the same three methods over its log/DHT") is not reachable
from the api.
Ask: `$(backing)` or `source({backing})` — handle + operators over a
caller-supplied backing. Keep `read(key)` parked for fero-L3 as documented
(seam/index.ts:352-355).
P3: no D-phase consumes it — D1 runs on plain sources + ingest; this is the
fero-L3 door, not the migration's.
Acceptance: InMemoryBacking mounted through the public api passes the existing
seam suite unchanged.

**W6 [P3] (kernel/api) Pre-commit veto seam — likely documentation-only.**
data v2 commits the root BEFORE sinks can refuse, forcing fero's #healRoot
microtask re-projection. v3's methods-only surface closes the `[value] =`
hatch (throws), and under §4.1 (fero owns the write trap) every fero-side
validation/auth bounce happens BEFORE data sees the write — W6 collapses to a
documented statement of that pattern. Only if §4.1 is rejected does this
return as a real ask (an optional validate hook on source writes/ingest:
`(deltas) => throw` = nothing commits, no emit, no revert record).

### Performance

**W7 [P1] (seam/perf) The hot ingest lane + the replication-shape corpus row.**
ingest() sniffs the profile per record (`'t' in r` / `'type' in r`) and routes
v2 records through order-resolution; its v2 profile requires STRING-typed
records, while fero's Rec is numeric-typed `{type: 0/1/2, key, value, at?}`
(kernel/env.ts:159-167) consumed today by applyRec with ZERO reshape — so the
naive swap inserts a per-record reshape allocation + numeric→string mapping on
the two pinned hot paths (api.inbound-5k ≈ 169k rec/s, tcp.replicate-20k ≈
73.5k rec/s). fero's inbound is homogeneous pre-validated frame-runs (up to
2k records/frame), and the fero v3 kernel keeps the lazy-RecordView discipline
(codec.ts: key/at/value decode only when read — a relayed record is never
parsed). Separately, the corpus has NO row shaped like replication apply — its
unbatched framing is named "the WORST framing for v3's commit/settle
architecture", with the remove-side floor rows (2.4–2.6×) sitting exactly on
fero's churn/shed paths.
Ask: (a) a pre-declared-profile ingest mode that skips detection and accepts
numeric type tags (or fero Recs / `(key, path, value)` triples directly) and
getter-backed lazy records without forcing value parse beyond state install,
with a documented per-record cost; (b) a corpus row modeling fero: N
interleaved update/remove/insert records ingested per-frame (runs of ~10–2000)
into a source with one native sink + one derived chain; (c) either a remove
fast path when no ordered/bucket views attach, or a measured statement of how
batching amortizes the two-phase floor.
Acceptance: the corpus row exists with a pinned ratio; fero's v3-tree pins
hold (api.inbound-5k, tcp.replicate-20k); the new restore/replay gate (D4)
lands green with replay = batched ingest.

**W8 [P1] (perf) Documented allocation + sink-cost budgets, under fero's
methodology.**
fero M8 shipped alloc gates with teeth (RB budgets: ≤512 B/record at batch 512,
≤640 B/record at batch 16; class-Z zero-garbage rings) that today deliberately
exclude the api/proxy layer. Post-migration the data seam JOINS the steady-state
inbound path, and fero's 1.15× unwatched-ratio gates leave no room for per-sink
surprises. v3's CommitBatch is handed by reference (good) but each
RowDelta/batch is a fresh allocation per commit (v2's bare verbs were flat
arrays).
Ask: document + gate (a) B/record garbage and retention for single-record and
batched ingest — any profile-reshape cost (W7a) counts against it; (b) the
marginal cost of the Nth attached sink per commit, measurable via onCommit
(whose zero-cost-when-unhooked property should itself be a gated contract
clause — it is also the observability join for fero's [diagnostics] plane);
(c) origin-suppression cost = one identity compare per sink per commit.
Numbers stated under the joint methodology: one engine per process, FRESH
values per rep (v3's Object.is no-op drop + consolidation dedup identical
re-writes into the no-op lane — the false-green trap), per-sample gc,
median-of-ratios.
Acceptance: numbers in a perf sibling data's CI runs; fero extends its RB gates
across the seam using them.

**W9 [P2] (api) No-copy reads at the handle + a cheap safe snapshot.**
The kernel has the each()/rowCount() no-copy protocol (~5× faster than
copy-then-iterate) but it is not exposed on the public handle. And v3's
snapshot()/[value] is a fresh container per call whose ROWS are shared by
reference — top-level mutation can't write through, but deep mutation of a
handed-out row silently corrupts the store with no delta — so "hand the caller
a safe value" still costs a deep clone (fero clones at every hand-out
boundary: method returns, the gather's one-shot answer; the root tree gates
the same whole-snapshot-clone shape at 30ms, and the v3 tree's fold gets its
own gate at D4).
Ask: public `d.each(fn)` / `d.rowCount()` (also on views), and a cheap safe
snapshot — COW or frozen rows — so hand-out stops costing a deep clone.
Acceptance: fold/gather projections rebuilt on each() beat the clone version;
deep mutation of a handed-out snapshot provably cannot write through.

**W10 [P3] (ops) Re-scopable filter — predicate over external state.**
The owner-scoping idiom is `filter((_v, k) => owner(k) === me)` where `owner`
reads the RING — external state. v2's filter never re-runs its predicate on an
external change, so fero's root tree tears down and rebuilds every partial on
every rebind (the ~2× setup-class cost, ×partitions, per membership change).
v3's official answer is the same teardown ("transient filter + mirror +
dispose"), and ops/reactive.ts deliberately excludes function-slot args (the
"operators react only to args they explicitly subscribe to" rule).
Ask: `filter(fn, dep)` where `dep` is a reactive input whose change
re-evaluates the predicate over affected keys, reconciling as deltas. This
HONORS the explicit-subscription rule — `dep` IS the explicit subscription —
an extension of the binder pattern (between's hidden bounds source), not a
reversal of the exclusion.
P3 for the migration (the fero v3 tree scopes ownership in its kernel, not via
data filters today) — rises to P1 when the distributed-decomposable-folds
workstream (fero v3 IDEAS P2) builds owner-scoped data views.
Acceptance: an owner-flip over N keys costs O(moved keys), not O(view rebuild).

**W11 [P2] (kernel) Public promote()/adoption control for seed-then-serve.**
$() adopts containers (M6); the keySlot/slots build defers to the first
structural write — a <5ms-at-10k promote spike that would land on fero's FIRST
inbound remove after restore-from-WAL seeds a replica, i.e. on the serving
path. The hook exists (commit.bench.ts calls src.store.promote()) but is
internal.
Ask: public `promote()` (or `$(_, {adopt: false})`) so fero pre-promotes at
boot (the restore path, D1), off the hot path.
Acceptance: documented, typed, and the promote spike measurable as zero on the
first post-boot write.

### Surface / operators

**W12 [P2] (ops) `some(col)` / `every(col)` column overloads.**
fero's R=∞ facade branch crashed live on this ("fn is not a function", Q2
capstone review) and the fero IDEAS ledger names the fix as a data-lib item:
sum/max/min/avg/filter accept a column, some/every don't. v3 is
predicate-only for these too.
Acceptance: `d.some('active')` ≡ `d.some(r => !!r.active)`, conformance-wrapped.

**W13 [P3] (ops) median / percentile / quantile.**
No such operator in v2 or v3; fero Q3 defers to user-side compute over
`methods.read()`. As holistic ops they'd throw under fero scoping until
distributed decomposable folds land (fero v3 IDEAS P2) — still worth having
locally; the t-digest/decomposable question can wait.

**W14 [P3] (kernel) Un-defer per-path connect() / deep-scalar emission.**
Both sit on data STATUS's known-gaps item 5 deferral list (no rationale
recorded for these two) — and fero IS the consumer pressure: partition-scoped
subscriptions (per-client `read()` projections, spoke mirrors, the fero v3
"subscription-scoped tap-forward for spokes" idea) want "subscribe to
`d.get(k)` subtree" without a filter-view per client. Not gating: filter views
cover v1.
Acceptance: `d.get(k).connect(...)` delivers only that subtree's deltas.

**W15 [P3] (contract) Value-domain portability clauses.**
Keep the binary codec fero-owned (fero v3 V3-8, settled). But the contract
should SPECIFY what fero must round-trip: Buffer/typed-array values (JSON
mangles them today), nested NaN/Infinity (become null through JSON — fero's
avg partials depend on the null-ification quirk!), and keys as arbitrary
unicode strings incl. NUL (fero inherited a NUL-separator assumption from the
v2 library; its v3 cellOf already fixed it fero-side).
Acceptance: value-domain table in contract/ (what is representable, what
codecs must preserve); a NUL-key conformance case.

### Housekeeping

**W16 [P3] (docs) Cancel "Phase 0.5 on v2" explicitly.**
data STATUS.md:438 still carries "fero Phase 0.5 items on the v2 side remain
undone" — mooted by fero migrating straight to v3. Write the one-line decision
so nobody builds the v2-side ingress.

**W17 [P3] (docs) A fero-facing tracking artifact in the data repo.**
data's root DECISIONS/ISSUES have zero fero mentions; every fero commitment
lives in plan prose. This wishlist (W1–W15) should land as a tracked list in
the data repo (its IDEAS equivalent) so the two repos stop drifting.

## §4 fero-side design decisions the migration forces

**4.1 fero owns the write surface (recommended).** data v3 removed assignment
writes; fero's public API (`sessions.data.user42 = {…}`, plan.md) keeps them.
Resolution: fero's `data` handle becomes FERO's own thin proxy — assignment/
delete sugar trapped by fero, routed to Bind.issue() (the one ingest, keeping
the OQ6 validation-covers-both construction), committed by the fero kernel,
then applied into the data v3 source via `ingest(..., {origin: mine})`. Reads
and operators delegate to the v3 handle. Consequences: the capture sink and the
ENTIRE echo problem disappear for local writes (fero never subscribes to its
own origin; derived views still serve every other subscriber — verified,
seam.test.ts origin semantics); data v3 becomes storage + operators +
subscription fan-out; W6 becomes free. This preserves fero's public surface
(rethink-not-reskin protects fero's shape, not data's), keeps read-your-writes
via the existing cid overlay, and dodges v3's RESERVED-vs-partition-name
collision for writes (reads through fero's proxy must still route collision
names via `get()` internally).

**4.2 Consolidation stance.** v3 sinks only ever see post-consolidation
batches; A→B→A emits NOTHING, ref-equal updates emit nothing. Under 4.1 this
is correct-by-construction for fero: the fero log captures at fero's ingest
(pre-data), so wire/log granularity is fero's choice; data's consolidation
only affects DERIVED-view emission, where annihilation is a feature (less
wire). Decision to record: fero's replication log is fed by fero, not by a
data sink — no pre-consolidation tap needed from data (drop the idea unless
4.1 is rejected). Corollary for perf work: consolidation + the Object.is no-op
drop mean any benchmark rep re-touching identical values measures the no-op
lane — see W8's methodology clause.

**4.3 Wire profile.** Keep fero's binary wire (v2-record-shaped fields) for the
migration — seam ingest accepts the v2 profile losslessly forever, and fero's
codec already owns framing/provenance (origin/seq/epoch ride the frame ext,
not the record). Adopt the native WireRecord profile (int-vs-string key
domains, `prev`, first-class path) as a SECOND step once W1 lands — it is the
door to streaming ordered projections and prev-carrying inverse records, but
it renumbers nothing fero needs on day one. (Hence W1 is P2.)

**4.4 Root tree: freeze on v2.** The root tree's wire format is byte-coupled to
v2 records and it is superseded by fero v3. `data/v2` is permanent. Migrating
it buys nothing; pin its import (one-line comment) and leave it. Note: the
root tree's public `value` re-export stays v2's symbol forever — v3's is the
DIFFERENT `Symbol.for('data.v3.value')`, and a cross-version symbol read
returns undefined SILENTLY (see D0). If any root module outlives the supersede
(tools/observe bridge), migrate it then.

**4.5 The overlay stays fero's.** data v3's M6 "transaction()" rollback
primitive could replace the cid overlay's revert — but V3-18 (pending state
never marked inside data) stands, the overlay is ~150 lines of O(1) map work,
and re-founding it on data's transactions couples fero's confirm ladder to
data's batch lifecycle. Revisit only if the overlay grows features.

## §5 Migration plan (fero v3 tree, after the P1 set — W2, W3, W4, W7, W8 — lands)

Phased so every step keeps the full suite + perf gates green; each phase is
one commit series with its A/B. The migration surface is
v3/api/{substrate,data,methods,fold,index}.ts — three proxy populations:
resource data, cluster, subscription mirrors.

- **D0 — pin + contract.** Import data v3 explicitly (substrate.ts:27's
  `../../../data/index.ts` currently still resolves to the v2 SOURCE — repoint
  to `../../../data/v3/...` or the package entry; record the data tip SHA).
  Grep both trees for cross-version `value`/`view` symbol use — v3's symbols
  differ (`Symbol.for('data.v3.*')`) and a stale-symbol read fails SILENTLY as
  undefined, not loudly. Wire fero's CI to run the W4 schedule suite against
  data HEAD. Snapshot perf baselines for the A/B under the joint methodology
  (fresh values per rep — the consolidation/no-op trap; one engine per
  process; median-of-ratios; WSL2 rule: judge structurally + back-to-back).
- **D1 — substrate swap.** Rewrite substrate.ts onto: source mint, `ingest()`
  as the apply ingress via the W7 hot lane (batched per frame-run — never
  per-record; fero Recs accepted with zero reshape, the baseline applyRec sets
  today; this is where api.inbound-5k ≈169k rec/s and tcp.replicate-20k
  ≈73.5k rec/s are defended), origin token in place of the echo contract,
  native sink (W2) for capture/streams, reads via W9. Named call-sites beyond
  Bind: the RESTORE-from-WAL path (today: per-record applyRec before the
  network exists, onApply wired BEFORE restore — preserve that ordering)
  becomes one batched ingest + the W11 pre-promote site; the CLUSTER fold's
  bare assignments (`cluster.writes = rows`, epoch/writable/members/peers/
  partitions) throw under v3 — convert to set()/patch() one-batch-per-tick or
  move `cluster` onto fero's own thin proxy per 4.1 (child-path reads like
  `snapshot(c.cluster.writes)` and the no-operator-chaining-off-child-handles
  restriction verified either way). The substrate banner's probed-facts list
  is regenerated against data v3 and pinned by the W4 suite instead of probes.
- **D2 — delete the warts.** api/data.ts: #expected/#captured echo machinery,
  the frames stack (re-entrancy is now FIFO-next-commit with issue-time origin
  — verify fero's commit-on-return semantics against clause 5), #healRoot +
  the index.test.ts:219 root-replace probe (surface = fero's proxy now).
  fold.ts: per-cell try/catch armor shrinks to the W3 contract. methods.ts:
  the move-skip lifted on BOTH halves — serve side streams the order channel;
  the client MIRRORS (applyStreamRec) mint v3 sources, apply order/move
  records, and take resubscribe snapshots via seam ingest's whole-value-diff
  path instead of root-replace. Scoped facade: the hardcoded OPERATORS set
  (api/index.ts:130) → exportContract()'s category map (holistic vs
  aggregate-decomposable drives ScopedError vs allow).
- **D3 — public surface re-point.** fero's own write-trap proxy (4.1) over the
  v3 handle; RESERVED collision routing via get(); `await data` semantics
  re-pinned (v3 handles are non-thenable — fero's thenable one-shot read is
  fero's own and stays).
- **D4 — perf close-out.** Full fero perf suite + the alloc-gate extension over
  the seam (W8 numbers); MINT the v3-tree gates the frozen root tree can no
  longer stand in for: a restore/WAL-replay gate and a fold/gather projection
  gate (the root tree's 60ms replay / 30ms rows / 120ms partial-build gates
  are out of scope but mark the cost classes). Audit every migrated perf
  sibling for the fresh-values/consolidation-dedup trap. The replication-shape
  corpus row (W7b) green in data's CI; baseline.json re-pinned with a
  migration marker.
- **D5 — ledger close.** DECISIONS record (this file's outcome), IDEAS residue
  (W13–W15 + the fromAsync/AsyncIterator note), MIGRATION notes in fero v3
  README.

Perf go/no-go, from the coupling analysis: single-write and batched shapes are
at parity or v3-faster (m1 0.65–0.87, batch rows 0.006–0.8×), so D1 batching
inbound applies should IMPROVE the pinned numbers; the risks to watch are
remove-heavy churn (the 2.4–2.6× floor rows — W7c), the promote spike on the
restore path (W11), the per-record reshape hazard (W7a), and any accidental
ride on the compat profile's sclone (W2 — the one guaranteed regression path;
never consume V2RecordSink on a hot path).

## §6 What this supersedes / feeds

- Feeds the data repo: W1–W15 as its tracked fero workstream (W17).
- Feeds fero v3 IDEAS: a new "data3 migration" workstream pointing here
  (D0–D5), absorbing the existing "[P2] substrate contract suite vs data HEAD"
  item (subsumed by W4/D0).
- plan-v3.md §10's four M0 substrate items: two answered natively by data v3
  (public ingress; sync-detach handles), two answered on paper and gated on
  this wishlist (the no-clone PUBLIC sink → W2; the EXECUTABLE versioned
  timing contract → W4). The wrapper-fallback contingency retires when D1
  lands after those.
