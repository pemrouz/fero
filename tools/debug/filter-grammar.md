# Debug viewer — filter grammar & state catalog

> **Status: DRAFT for review.** This is the converged design from the grammar rethink +
> the from-scratch enum audit of the fero codebase. Every value below is traced to real
> code and tagged by whether it's *live today*, *needs a new seam*, or *can never exist*.
> Question / annotate freely — nothing here is built yet, and `tree.html` is untouched.

---

## 1. The grammar

```
commit:fence                  # one facet (a key:value)
commit:fence,conflict         # comma = OR    → fence OR conflict
commit:remove commit:fence    # repeat = AND  → a remove that was ALSO fenced
key:user42 commit:conflict    # space = AND   → user42's rows that are also conflicts
key:user42,billing            # comma = OR    → partition user42 OR billing
key:user42 key:billing        # repeat = AND ⇒ ∅  (no row is two partitions — use the comma above)
user42                        # bare: a type word filters that type, else a substring name-match
```

- **Exact-type rule (new):** every entity key matches rows of **exactly that type**; the
  value filters *within* that type. `commit:` matches commit records, `server:` matches
  server rows — a value never cross-cuts types. This is what dissolves the old overloads.
- **Comma = OR, whitespace = AND.** The query is a conjunction of `key:v1,v2,…` clauses:
  a comma lists acceptable values for one clause (OR within), and every space-separated
  term — *a different key **or** a repeat of the same key* — is AND-ed. Repeating a key is
  just another AND term: useful for a multi-axis key like `commit:` (`commit:remove
  commit:fence` = a removed *and* fenced record), but an **empty set** for a single-valued
  key like `key:` (repeating it asks for a row that is two partitions at once — use the
  comma there; the UI can nudge when a repeat collapses to ∅).
- **Bare token** = filter to that type if it's a type word (`server`, `commit`), else a
  case-insensitive substring match on the row label (`user42`, `:49803`).
- **Autocomplete** offers specific ids for entity keys: `key:user42`, `server::49803`,
  `epoch:e2`, `sub:user42.score`.
- **Two sanctioned exceptions** to the exact-type rule (see §4): `is:` (a severity
  cross-cut) and `origin:`/`seq:` (a JOIN that scopes every type to one logical write).

---

## 2. Derivation legend

How real is each value *today*? This is the load-bearing column — a filter is only
honest if a live signal backs it.

| Tag | Meaning |
|---|---|
| **● live** | Computed from real cluster state and folded into the snapshot/SSE feed the viewer renders. Works now. |
| **◦ observe-only** | Exists on the live `__observe` ProvKind stream (or only in the mock sample), but is **not** folded into a viewer row. Renders only if we add a fold. |
| **⊘ needs-fold** | A real, *stored* cluster state, but `export.ts`/`bridge.ts` drops it today. Needs a new fold seam to become queryable. |
| **† in-process only** | Live only in an in-process forensic capture (`captureInProcess`/`foldDivergence`); deliberately omitted on the streamed SSE bridge (cross-node / too costly). |
| **▸ derived predicate** | Not a stored value — a computed predicate over a sub-list (e.g. "partition has ≥1 conflict"). |
| **◆ severity cross-cut** | A derived rollup over per-type states (the `is:` exception). |

---

## 3. The entity types

### `commit:` — one sequenced/applied/rejected change-record outcome
*A single row in a partition's log: one change record and what happened to it.*

| Value | Definition | Use case | Derived from · tier |
|---|---|---|---|
| `update` | a change record that updated an existing key path | "show only updates" | `ChangeRecord.type` (`message.ts:65`) · ◦ *(no live log-export seam yet)* |
| `insert` | a record that created a key (root insert carries the key in `at`) | "find the births / root inserts" | same · ◦ |
| `remove` | a record that deleted a key path | "what got deleted" | same · ◦ |
| `applied` | an inbound replicated record this replica applied (it won LWW) | trace successful replication | `ProvKind` (`observe.ts:24`) · ◦ *(on observe stream, not folded to a row)* |
| `local` | committed under this node's own provenance (owner-sequenced) | "what did this owner write" | `ProvKind` · ◦ |
| `forwarded` | a write forwarded from another node that this owner committed | trace owner-routed writes | `ProvKind` · ◦ |
| `fence` | a write **rejected by the epoch fence** — `cur && record.epoch < cur.epoch` (stamped under a STRICTLY-lower view than the winner we hold); **never logged**, `seen` still advances (B1 sticky skip) | "whose writes are being silently dropped for being on an old view" | `foldOutcomes` over observe `lost`, classified `record.epoch < winner.epoch` (`export.ts:297`, fence at `index.ts:524`) · ● |
| `conflict` | a **same-epoch LWW loser** — `cur && record.epoch === cur.epoch` and loses the `(seq, origin)` tie-break; **stays logged**. NOT eliminable by removing the never-drop fallback — it has FOUR sources ([DECISIONS AA](../../DECISIONS.md)), the fallback being the dominant one | "where are concurrent writers colliding" | `foldOutcomes`, classified same-epoch (`index.ts:536`) · ● |
| `committed` | **durability (reached):** sequenced + logged — the baseline every commit attains the instant it's in the log (objective, **all origins**, `confirm`-independent) | "every change that committed" | a logged record's existence IS the committed fact — ships in every digest · ● |
| `replicated` | **durability (reached):** ≥W of the partition's **current** R-set hold this record as their **live** value — the objective, all-origins face of `confirm:'replicated'` | "which commits are W-durable right now" | `foldReplicated` over the R-set's `log.marks()` (**NOT** `seen` — see note) + a live-winner gate; **eventually-true** (≤ `antiEntropyMs` stale) · ⊘ needs-fold |
| `persisted` | **durability (reached):** ≥W of the R-set have **durably appended** it (their `storage.append` resolved) | "which commits are fsync-durable" | needs **durable marks** in the digest — today only `seen` ships (`index.ts:638`) · ▸ planned |
| `dropped` | a dedup re-delivery (drop) | debugging duplicate delivery | `ProvKind`, gated on `observe.verbose` (default off) · ◦ verbose-only |

> **`move` is excluded.** It's a reserved wire type but fero's commit path **never emits
> it** and `applyRecord` ignores it (`dispatch.ts:430`, DECISIONS E). Filtering for it
> could never match — so it's not offered.
>
> `fence`/`conflict` are **derived, not stored** — the `lost` push event carries no
> fence/conflict tag; `foldOutcomes` reconstructs it by comparing `record.epoch` to the
> winner's epoch. They land canonically on the **partition** row's `outcomes[]`; the
> commit row only borrows them for colour.
>
> **Both stay.** A `conflict` is a violation of the single-writer invariant ("at most one
> origin stamps a partition's records per epoch"). The never-drop fallback is the DOMINANT
> source, but **not the only one** — a design review proposed removing it to make `conflict`
> structurally impossible, and that was rigorously REFUTED: three more same-epoch/two-origin
> paths remain (`commitForwarded`'s missing ownership recheck, `flushPending`'s current-epoch
> re-stamp, the durable epoch-1-boot bug). So `commit:conflict`, `key:has-conflict`, and
> `ProvKind lost` (NOT fence-only) all stay. The authoritative write-path / fence-vs-conflict
> reference — exact triggers, the complete source list, and the four-part elimination
> program — is **[DECISIONS AA](../../DECISIONS.md)**.
>
> **Four axes, one key.** A commit row carries a record *type* (`update`/`insert`/`remove`),
> a *provenance* (`applied`/`local`/`forwarded`), an *outcome* (`fence`/`conflict`), and a
> *durability reached* (`committed` < `replicated` < `persisted`) — all on `commit:`, filtered
> by value. AND across axes by repeating the key (`commit:applied commit:replicated` = an inbound
> winner that is also W-durable; `commit:remove commit:fence` = a removed *and* fenced record); OR
> within an axis by comma (`commit:fence,conflict`, `commit:update,remove`). The durability axis is
> **objective and monotonic** — every commit climbs it regardless of whether the writer opted into
> `confirm:` — which is exactly what lets one key trace a write *and the commit it becomes* (the
> write/commit unification, [DECISIONS AC](../../DECISIONS.md)).
>
> **`committed` legitimately lives on `commit:` now** — it's the baseline reached-durability,
> superseding the old "`committed` never leaks to `commit:`" rule. The collision with the
> *requested* tier is resolved by **key**, not by banning the word: `commit:committed` = the
> objective rung a record REACHED; `write:committed` = the bar a writer REQUESTED (see `write:`).
>
> **Honesty hazard — `replicated` folds off `log.marks()`, never `seen`.** `seen` advances even
> for epoch-fenced records that are never logged and never held (`index.ts:509`/`524`, the B1
> sticky skip), so a `seen`-based fold would tag such a record `replicated` on *every* replica
> when it is held by *none* — the exact lie [DECISIONS B1] removed (`shedConfirmed` confirms an
> R-set member against `log.marks()`, **not** `seen`). The fold therefore (1) derives the
> W-threshold from the **shippable** `log.marks()` high-water, (2) labels **only the live LWW
> winner** for a key — a scalar high-water can't tell a superseded / conflict-loser row from the
> live value — and (3) recomputes against the **live** R-set. The result is an *eventually-true*
> property (≤ `antiEntropyMs` stale), strictly weaker than `confirm:'replicated'`'s synchronous
> probe but objective for **every** matched row.
>
> **Issuer lifecycle stays on `write:`, JOINed — not merged here.** `latency`, `state`
> (pending/confirmed/rejected), `reason`, and the *requested* tier exist only for opt-in confirm
> writes and are structurally absent on fire-and-forget and inbound commits, so they are **not**
> `commit:` values — a `commit:` row borrows them via the `origin:`/`seq:` JOIN (§4).

### `key:` — a partition (= a top-level key, 1:1)
*A `partitionOf = key[0]` shard. Deep keys (`user42.score`) live **inside** a partition.
It carries **both** axes of replica-set health — placement (`under`/`draining`) and
convergence (`lagging`/`caught-up`) — because a replica is a (partition × holder) cell, not
its own row (see the note below the table).*

| Value | Definition | Use case | Derived from · tier |
|---|---|---|---|
| `healthy` | converged, held on exactly R | the calm baseline | `foldSnapshots` · ● |
| `under` | **under-replicated** — held on fewer than R nodes; one failure from data loss (transient, self-heals) | "what's at durability risk right now" | `foldSnapshots`, `held < R` · ● |
| `lagging` | a holder is behind the owner's log — *transient* (converges via anti-entropy, no permanent split); severity marks the acute case: `is:crit` = stuck / serving stale reads now, `is:warn` = catching up | who's serving stale | `foldDivergence` stuck row (`lag = owner.seq − replica.seq`, `export.ts:166`); node-level live via bridge `lagOf` (`bridge.ts:241`) · ●/† |
| `caught-up` | every holder is in sync with the owner — the **positive** of `lagging` (explicit, so "confirm convergence" is queryable) | confirm a partition's replicas are all current | same signal, inverted (`export.ts:166`, expose positively) · ●/† |
| `draining` | a now-redundant copy: held but **no longer in the committed R-set** — kept until the new replicas confirm caught up, then dropped (over-replicated, the opposite direction from `under`) | "see a rebalance in flight" | `snapshot.orphans` (stored, ships on wire) · ● |
| `drained` | terminal: the redundant copy was dropped (proxy+log+seen removed). Weak as a filter — the row *vanishes* when drained, so `draining` is the queryable state | confirm a handoff completed | node-local lifecycle; visible only as the claim disappearing · transient |
| `has-fence` | this partition has ≥1 `outcomes[].out = fence` | "which partitions are fencing writes" | ▸ derived predicate over `outcomes[]` |
| `has-conflict` | this partition has ≥1 `outcomes[].out = conflict` (this **replaces** the old `contended`) | "which partitions are write-contended" | ▸ derived predicate · ● (counts are live) |

> The old `contended` partition status is **dropped** — it was sample-only with no live
> producer; its real signal is the conflict count, now `has-conflict` / `commit:conflict`.
>
> **No `replica:` type.** A replica is a (partition × holder) cell, not a row, and every
> state it could carry already lives elsewhere: its rollups are `key:lagging`/`caught-up`
> (here) and `server:lagging` (node); its per-record apply outcomes are `commit:` faces
> (`applied`/`fence`/`conflict`) attributed to a holder; its per-cell lag detail is the partition
> **inspector**'s "Replica health · lag" grid (and/or replica rows nested *under* the
> partition in the tree, inheriting the partition's filter). `replica:missing` was redundant
> with `key:under`. So there is no top-level `replica:` filter — you narrow partitions, then
> drill in.

### `server:` — a dialed, ring-eligible peer (`cluster.me` defined)
*A fero node. Servers own/replicate partitions and sequence writes.*

| Value | Definition | Use case | Derived from · tier |
|---|---|---|---|
| `healthy` | in the current view, writable, caught up | baseline | `foldSnapshots` · ● |
| `stale-epoch` | on an **old view-epoch** (`epoch < maxEpoch`) → its forwarded writes get fenced | "who's on a stale view" | `InspectSnapshot.epoch < maxEpoch` · ● *(split from the old flattened `stale`)* |
| `quorum-loss` | **write-gated** (`writable === false`) — a minority-side node buffering writes it can't commit | "who can't accept writes (CP minority)" | `InspectSnapshot.writable === false` (write-gate, `index.ts:1061`) · ● *(split from `stale`)* |
| `under` | holds ≥1 draining copy (over-replicated, awaiting drain) | node-side view of a rebalance | `foldSnapshots` · ● |
| `lagging` | the node's log broadly **trails the live frontier** beyond tolerance; self-heals via anti-entropy | "which nodes are behind overall" | bridge `topLag`/`excess` rollup (`bridge.ts:232-250`) · ● live on the bridge |
| `disconnected` | the peer's socket dropped | "who fell off" | `snapshot.peers` STATUS enum (`peer.ts:34-41`) · ⊘ **needs-fold** *(stored, exporter drops it)* |
| `suspect` | failure-detector suspects the peer (pre-eviction) | "who's about to be evicted" | `peer.ts:84-94` · ⊘ needs-fold |

> `server:diverged` is **dropped** — it appeared only in the mock sample; `foldSnapshots`
> caps at `stale|under|healthy` and can never live-derive it. (Node-level data-plane staleness
> is `server:lagging`; the per-partition form is `key:lagging`.)
> Membership transitions `admitted / evicting / evicted` are stored in ViewManager but
> only an epoch member *count* ships — see the punch-list (§6).

### `client:` — a downstream topology row (a `to` addr that isn't a committed member)
*Derived purely from subscription topology — not a transport peer row.*

| Value | Definition | Use case | Derived from · tier |
|---|---|---|---|
| `reader` | a plain consumer (its `to` addr isn't a member) | "list real clients" | `foldSubs`: `members.includes(s.to) ? 'server' : 'reader'` (`export.ts:261`) · ● |
| `server` | a relay's *upstream* in a forward chain (client→relay→owner) | trace read-forward chains | same · ● |

> **Every status pill is dropped** — `writer` (no producer; a writer forwards + drops its
> optimistic copy), `slow` (no per-sub classification is emitted), `resub` (failover
> re-subscribe is **unimplemented**, IDEAS Q2), `stale` (a client has no ViewManager →
> epoch ≡ 1 forever), `gone` (a disconnected client just vanishes — `reapPeer` deletes its
> subs). All sample-only. The only honest client values are the two roles.

### `sub:` — a served subscription
*The one stored per-sub fact is its `kind`, captured once at subscribe.*

| Value | Definition | Use case | Derived from · tier |
|---|---|---|---|
| `forward` | a relayed non-held read from the owner | trace read-forwarding | `SubMeta.kind` (`dispatch.ts:159-234`) · ● |
| `gather` | a reactive no-key whole-resource read union (Q3) | find fan-in reads | same · ● |
| `fold` | a client distributed aggregate (Q2e) | find global aggregates | same · ● |
| `partial` | a served aggregate that re-scopes on its own view commit **without** re-subscribing (the only live owner-move re-targeting) | the real "owner moved" surface | same · ● |
| `observe` | the L4 provenance ring stream | find debug observers | same · ● |
| `projection` | the default ViewProxy delta path | the common case | same · ● |

> Per-sub **delivery lag** (`head`/`delivered`) is **unmeasured** — a subscription delta is
> a synthetic `{type,key,value}` with no provenance (DECISIONS O1). No `lag` value is
> offered until a per-sub counter exists (see §6). Lifecycle is active-or-gone; a
> `released`/`reaped` sub is deleted (no tombstone), so there's no `released` value.

### `epoch:` — a committed membership view
| Value | Definition | Use case | Derived from · tier |
|---|---|---|---|
| `current` | `e === latest` | "the live view" | `export.ts:226` · ● |
| `past` | a superseded committed view | "who owned this partition 3 epochs ago" (owner-by-epoch history) | `viewHistory`/`ownerByEpoch`, `foldOwnership` · ● |

> The in-flight **Paxos ballot** (PREPARE/PROMISE/ACK) is entirely internal to ViewManager
> and never reaches the snapshot — an `epoch:` filter can only ever distinguish *committed*
> views. Epoch rows carry no severity. `moved`/`placed` are per-epoch rollup **counts**
> (owner changed vs prior / born at this view), not row states.

### `write:` — the issuer-side confirm lifecycle (an annotation surface, JOINed onto `commit:`)
*Keyed by a node-local write id. Exists **only** for opt-in `confirm:` writes (fire-and-forget
and inbound commits never produce one) — so `write:` is a strict, node-local **subset** of
`commit:`. These are exactly the fields that can't live on a `commit:` row because they don't
exist for every commit; a `commit:` row pulls them in by the `origin:`/`seq:` JOIN (§4). Stored on
the `cluster.writes` runtime ViewProxy — **no debug export today** (the whole family is ⊘ needs-fold).*

| Axis | Value | Definition | Use case | Source |
|---|---|---|---|---|
| **bar** (tier REQUESTED — the writer's wait-point, *not* the reached durability) | `accepted` | local-apply only — the **only** bar with no `commit:` rung (a wait-point, never a durability stage) | "resolved as soon as it applied here" | `writes.ts:24-43` · ⊘ |
| | `committed` | waited for owner-sequencing (objective rung: `commit:committed`) | "asked to wait for the owner" | DECISIONS Z · ⊘ |
| | `replicated` | waited for W of the R-set (objective rung: `commit:replicated`) | "asked to wait for W-durability" | · ⊘ |
| | `persisted` | waited for W durable appends (objective rung: `commit:persisted`) | "asked to wait for fsync" | · ⊘ |
| **state** | `pending` | in flight | "what's stuck right now" | · ⊘ |
| | `confirmed` | reached its bar | | · ⊘ |
| | `rejected` | fell short | "what failed and why" | · ⊘ |
| **reason** (rejected only) | `withheld` | quorum-less write-gate buffered it (⇐ `server:quorum-loss`) | "writes dropped by the CP gate" | · ⊘ |
| | `timeout` | no ACK within `callTimeout` | | · ⊘ |
| | `quorum` | sequenced but never reached W | "writes that missed replication" | · ⊘ |
| | `unconfirmed` | default fallback | | · ⊘ |
| **latency** | (scalar, ms) | `settledAt − startedAt` — how long the requested bar took | `cluster.writes.filter('bar','replicated').avg('latency')` | `writes.ts:40-42` · ⊘ |

> Fire-and-forget writes (no `confirm:`) are **not recorded** — the zero-overhead hot path —
> which is why `write:` can never host the union of all commits. `seq`/`epoch`/`origin` on a
> write row are the JOIN fields to the commit it became (§4), not values. The `committed` overload
> is resolved by **key + axis**: `commit:committed` = the objective rung a record REACHED;
> `write:committed` = the bar the writer REQUESTED. Both are honest because they live on different
> keys — superseding the earlier "`committed` never leaks to `commit:`" framing now that durability
> is a first-class `commit:` axis ([DECISIONS AC](../../DECISIONS.md)). `accepted` is the one bar
> with **no** `commit:` counterpart: it's a local-apply wait-point, never a durability stage
> reached by a committed record (`ProvKind` has no `accepted`; `reachedTier` is `committed`/`none`).

---

## 4. Cross-cuts (the two sanctioned exceptions)

The exact-type rule deliberately *loses* cross-type queries. These two recover them:

### `is:` — severity sweep
| Value | Definition | Rolls up |
|---|---|---|
| `is:crit` | data at risk — durability/correctness | `key:lagging` (stuck)/`under`, `server:stale-epoch`, `commit:fence`, `write:rejected` |
| `is:warn` | degraded but expected/self-healing | `server:lagging`/`quorum-loss`, `commit:conflict`, `key:draining` |
| `is:info` | expected lifecycle | `server:disconnected`, epoch transitions |

The **one** "show me everything unhealthy" query. ◆ derived from per-type states (the
existing `clsOf` severity map).

### `origin:<uuid>` / `seq:<n>` — the LWW-triple JOIN
One logical write has **four faces**: a `write:` row (the issuer lifecycle — requested
bar / state / reason / latency), a `commit:` row (the objective outcome **and** reached
durability — `applied`/`fence`/`conflict` × `committed`/`replicated`/`persisted`) on each
replica that saw it, a `key:` `outcomes[]` entry, and a `server:quorum-loss` cause. They
share `(epoch, seq, origin)`. `origin:X seq:42` scopes **all types at once** to that single
write — and it is precisely how a `commit:` row borrows the issuer-only `write:` fields
(latency / state) that don't exist on every commit. A cross-type correlate, not a state value.

---

## 5. Diff from the prior (cross-cutting) grammar

**Re-homed:**
- `commits:lagging` → `key:lagging` (per-partition) **+** `server:lagging` (node rollup) — two faces, two types.
- `commits:diverged` → `key:lagging`.
- `commits:rejected-fenced` / `rejected-conflict` → `commit:fence` / `commit:conflict` (+ `key:has-fence`/`has-conflict`).
- `commits:accepted` → `write:accepted` (it's a write tier, not a commit-record state).
- `write:{committed,replicated,persisted}` (the *tier* axis) **split by vantage** ([DECISIONS AC](../../DECISIONS.md)): the objective durability a record REACHED → `commit:{committed,replicated,persisted}` (a new monotonic `commit:` axis, all origins, `confirm`-independent); the bar a writer REQUESTED stays an issuer annotation on `write:` (relabelled `bar`). The old "`committed` never leaks to `commit:`" rule is **superseded** — the overload is resolved by key (`commit:` = reached, `write:` = requested), not by banning the word.
- `view:lagging` → `server:stale-epoch` (a client is never stale; view-lag is a server's epoch staleness).
- `link:disconnected` → `server:disconnected` (⊘ needs-fold).

**Dropped (sample-only / no live producer / unimplemented):**
- `client:{slow,resub,stale,gone,writer}` — all fiction.
- partition `contended` → `key:has-conflict`.
- `delivery:lagging` — unmeasured (O1).
- `replicas:missing` — redundant with `key:under`.
- `replica:` (whole type, revised out) — a replica is a (partition × holder) cell, not a row; folded into `key:lagging`/`caught-up` + `server:lagging` (rollups), `commit:` (apply outcomes), and the partition inspector (per-cell detail).
- `owner:{moved,resubscribing}` — `moved` is an epoch rollup count; `resubscribing` is unimplemented.

**Net:** ~7 fiction tokens removed; the honest live grammar is smaller — but a real,
valuable **missing** surface appears (`write:`, `server:quorum-loss`, `key:draining`, the
epoch/membership feeds).

---

## 6. Fold-seam punch-list (to make ⊘ / ◦ values live)

Each item is a real stored/streamed signal the viewer just doesn't consume yet.

| Want live | What it needs | Source today |
|---|---|---|
| `commit:replicated` (objective, all commits) | ship `log.marks()` in the snapshot + retain each peer's R-set marks on `onDigest` + a `foldReplicated` (W-th-largest `log.marks()` threshold, live-winner gate). **Zero hot-path cost** — a cold export fold off existing digests, mirroring `deriveAggregate`'s frontier pass | digests already ship `seen` (`index.ts:638`); `log.marks()` exists (`log.ts:175`) but isn't shipped |
| `commit:persisted` (objective, all commits) | the above **plus** durable marks (the `persisted` high-water) added to the digest/snapshot — today only `seen` ships | `persisted` map exists (`index.ts:316`) but never leaves the node |
| `write:*` issuer fields (`bar`/`state`/`reason`/`latency`) | a `cluster.writes` → snapshot fold seam (none exists); these JOIN onto `commit:` rows by `origin:`/`seq:` | runtime ViewProxy, `writes.ts` |
| `server:disconnected` / `suspect` | `export.ts` to fold `snapshot.peers` STATUS | stored, ships on wire (`peer.ts:34-41`) |
| membership `admitted/evicting/evicted` | fold ViewManager transition state | stored, only count ships |
| `epoch:past` timeline / `server:quorum-loss` history | bridge to consume the `kind:'view'`/`'writable'` observe transitions (it drops them) | `observe.ts:99`, dropped at `bridge.ts:354` |
| `commit:` log values (`update`/`applied`/…) on a row | a change-record-log export seam | none (`export.ts:21,64`) |
| `sub:` delivery lag | a per-sub delivery counter (sent vs acked) | unmeasured (O1) |
| per-holder apply attribution on `commit:` rows (which holder `applied`/`fenced`/lost a record) | fold per-replica ProvKind onto the commit row | observe-stream only |

---

## 7. Open decisions

1. **Honesty in the UI** — show ⊘/◦ tokens greyed (as a roadmap) so the grammar is
   complete, or hide them until their seam exists so a filter never returns nothing?
2. **`is:` + `origin:`/`seq:` exceptions** — bless as first-class grammar, or keep as a
   separate UI affordance outside `key:value`?
3. **Data-plane lag's two faces** — expose both `server:lagging` (node) and `key:lagging`
   (partition) and union via OR, or add a derived cross-cut that expands to the union?
   (They're different granularities — node-level vs per-partition — so "one home" is
   genuinely ambiguous.)
4. **~~List `write:` now or omit until folded?~~ — RESOLVED: write/commit unification ([DECISIONS AC](../../DECISIONS.md)).**
   The durability lifecycle unifies onto `commit:` as the objective `committed`/`replicated`/`persisted`
   axis (one key traces a write *and the commit it becomes*); the issuer-only `write:` fields
   (`bar`/`state`/`reason`/`latency`) stay a JOIN-recovered annotation, not a merged row. List
   `commit:committed` now (● live once a log-export seam exists), grey `commit:replicated` (⊘ needs the
   `log.marks()` fold, §6) and `commit:persisted` (▸ planned, needs durable marks), and keep the `write:`
   annotations behind the `cluster.writes` fold seam. No token returns nothing once its §6 seam lands;
   until then they grey per #1.
5. **Build the missing fold seams as part of this**, or grammar-first and seams as a
   follow-on workstream?

---

## 8. Action points — debug-view changes to execute

The grammar above is the spec; this is the build list for the viewer (`tools/debug/` +
`tree.html`) to pick up **once we're ready to execute** — nothing here is built yet. Each
item is independently shippable. §6 is the *data*-layer punch-list (fold seams); this is
the *view* layer. An item that depends on a fold is marked ⛓ — land the seam first, or ship
the token greyed per §7 #1.

**Parser / grammar engine**
- [ ] Core grammar (§1): comma = OR within a clause, whitespace = AND across clauses,
      repeat-key = AND (collapses to ∅ for a single-valued key like `key:` — nudge the user
      toward the comma).
- [ ] Exact-type key matching: `commit:`/`key:`/`server:`/`client:`/`sub:`/`epoch:`/`write:`
      each match rows of **exactly** that type; a value never cross-cuts types.
- [ ] Bare token = type-filter if it's a type word, else case-insensitive substring on the
      row label.
- [ ] The two sanctioned exceptions: `is:` severity sweep, and the `origin:`/`seq:` JOIN that
      scopes every type to one logical write.
- [ ] Autocomplete: offer ids per key (`key:user42`, `server::49803`, `epoch:e2`,
      `sub:user42.score`).

**Drop the fiction tokens from the current mockup** (none has a live producer — §5)
- [ ] Remove `client:{slow,resub,stale,gone,writer}`, partition `contended`,
      `server:diverged`, the **whole `replica:` type**, `replicas:missing`,
      `owner:{moved,resubscribing}`, `delivery:lagging`.

**Rows & nesting**
- [ ] Partitions stay nested under their **owner** node (today's tree); replicated copies are
      NOT top-level rows.
- [ ] Render replica health as the partition's sub-view — the inspector "Replica health · lag"
      grid, and/or replica rows nested *under* the partition (inheriting its filter). Never a
      top-level `replica:` filter.
- [ ] `key:` values: add **`caught-up`**; ensure `healthy`/`under`/`lagging`/`draining`/
      `drained`/`has-fence`/`has-conflict` all render with the correct severity class.

**Severity**
- [ ] Wire `is:crit`/`is:warn`/`is:info` to the `clsOf` severity map (the `is:` rollup, §4).

**Honesty (decide via §7 #1)**
- [ ] ⛓ Either grey out ⊘/◦ tokens as a roadmap, or hide them until their §6 seam lands — a
      filter must never silently return nothing because its signal isn't folded yet.

**Gated on data seams (§6) / open investigations**
- [ ] ⛓ Durability axis — add `commit:{committed,replicated,persisted}` to the `commit:` value set
      (write/commit unification **resolved**, [DECISIONS AC](../../DECISIONS.md)). `commit:committed`
      lights up with the log-export seam; `commit:replicated` needs the `log.marks()` fold (§6);
      `commit:persisted` is ▸ planned. The issuer-only `write:` annotations (`bar`/`state`/`reason`/
      `latency`) stay behind the `cluster.writes` fold seam and attach to a `commit:` row via the
      `origin:`/`seq:` JOIN — never a merged row.
- [ ] ⛓ `server:disconnected`/`suspect`, membership `admitted/evicting/evicted`, `epoch:past`
      timeline, `commit:` log values, `sub:` delivery lag, per-holder `commit:` apply
      attribution — each lights up only when its §6 seam ships.
