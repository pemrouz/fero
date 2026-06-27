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
| `won` | an inbound replicated record that won LWW and was applied | trace successful replication | `ProvKind` (`observe.ts:24`) · ◦ *(on observe stream, not folded to a row)* |
| `local` | committed under this node's own provenance (owner-sequenced) | "what did this owner write" | `ProvKind` · ◦ |
| `forwarded` | a write forwarded from another node that this owner committed | trace owner-routed writes | `ProvKind` · ◦ |
| `fence` | a write **rejected by the epoch fence** — `cur && record.epoch < cur.epoch` (stamped under a STRICTLY-lower view than the winner we hold); **never logged**, `seen` still advances (B1 sticky skip) | "whose writes are being silently dropped for being on an old view" | `foldOutcomes` over observe `lost`, classified `record.epoch < winner.epoch` (`export.ts:297`, fence at `index.ts:524`) · ● |
| `conflict` | a **same-epoch LWW loser** — `cur && record.epoch === cur.epoch` and loses the `(seq, origin)` tie-break; **stays logged**. NOT eliminable by removing the never-drop fallback — it has FOUR sources ([DECISIONS AA](../../DECISIONS.md)), the fallback being the dominant one | "where are concurrent writers colliding" | `foldOutcomes`, classified same-epoch (`index.ts:536`) · ● |
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
> **Two sub-axes, one key.** A commit row carries both a record *type* and an *outcome*;
> `commit:` filters either. To AND them — *removes that were fenced* — repeat the key:
> `commit:remove commit:fence` (the whitespace-AND rule). The comma stays OR *within* an
> axis (`commit:update,remove`). This is why `commit:` doesn't need splitting into separate
> type/outcome keys.

### `key:` — a partition (= a top-level key, 1:1)
*A `partitionOf = key[0]` shard. Deep keys (`user42.score`) live **inside** a partition.*

| Value | Definition | Use case | Derived from · tier |
|---|---|---|---|
| `healthy` | converged, held on exactly R | the calm baseline | `foldSnapshots` · ● |
| `under` | **under-replicated** — held on fewer than R nodes; one failure from data loss (transient, self-heals) | "what's at durability risk right now" | `foldSnapshots`, `held < R` · ● |
| `diverged` | some replica holds an older value than the owner | forensic: who's serving stale | `foldDivergence` · † in-process only *(omitted on the bridge, `export.ts:303`)* |
| `orphan` | held but **no longer in the committed R-set** — over-replicated/draining, kept-until-confirmed-shed (opposite direction from `under`) | "see a rebalance in flight" | `snapshot.orphans` (stored, ships on wire) · ● |
| `shed` | terminal: the orphan copy was dropped (proxy+log+seen removed) | confirm a handoff completed | node-local lifecycle; visible only as the claim disappearing · transient |
| `has-fence` | this partition has ≥1 `outcomes[].out = fence` | "which partitions are fencing writes" | ▸ derived predicate over `outcomes[]` |
| `has-conflict` | this partition has ≥1 `outcomes[].out = conflict` (this **replaces** the old `contended`) | "which partitions are write-contended" | ▸ derived predicate · ● (counts are live) |

> The old `contended` partition status is **dropped** — it was sample-only with no live
> producer; its real signal is the conflict count, now `has-conflict` / `commit:conflict`.

### `server:` — a dialed, ring-eligible peer (`cluster.me` defined)
*A fero node. Servers own/replicate partitions and sequence writes.*

| Value | Definition | Use case | Derived from · tier |
|---|---|---|---|
| `healthy` | in the current view, writable, caught up | baseline | `foldSnapshots` · ● |
| `stale-epoch` | on an **old view-epoch** (`epoch < maxEpoch`) → its forwarded writes get fenced | "who's on a stale view" | `InspectSnapshot.epoch < maxEpoch` · ● *(split from the old flattened `stale`)* |
| `quorum-loss` | **write-gated** (`writable === false`) — a minority-side node buffering writes it can't commit | "who can't accept writes (CP minority)" | `InspectSnapshot.writable === false` (write-gate, `index.ts:1061`) · ● *(split from `stale`)* |
| `under` | holds ≥1 orphan awaiting shed (over-replicated, draining) | node-side view of a rebalance | `foldSnapshots` · ● |
| `lagging` | the node's log broadly **trails the live frontier** beyond tolerance; self-heals via anti-entropy | "which nodes are behind overall" | bridge `topLag`/`excess` rollup (`bridge.ts:232-250`) · ● live on the bridge |
| `disconnected` | the peer's socket dropped | "who fell off" | `snapshot.peers` STATUS enum (`peer.ts:34-41`) · ⊘ **needs-fold** *(stored, exporter drops it)* |
| `suspect` | failure-detector suspects the peer (pre-eviction) | "who's about to be evicted" | `peer.ts:84-94` · ⊘ needs-fold |

> `server:diverged` is **dropped** — it appears only in the mock sample; `foldSnapshots`
> caps at `stale|under|healthy` and can never live-derive it.
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

### `replica:` — a holder's convergence vs the owner (per partition)
*The convergence dimension — distinct from the partition's placement dimension, and the new home for "lagging."*

| Value | Definition | Use case | Derived from · tier |
|---|---|---|---|
| `behind` | parked on a lower `(epoch,seq)` than the owner's winner (the relocated `commits:lagging`) | "which holders are stuck behind on which partition" | `foldDivergence` stuck row, `lag = owner.seq − replica.seq` (`export.ts:166`); also bridge `lagOf` (`bridge.ts:241`) · ●/† |
| `caught-up` | holds the partition, none behind (explicit — was an omission) | confirm a replica is in sync | `export.ts:166` (expose positively) · ● |
| `won` | an inbound record this replica applied as the LWW winner | per-replica apply trace | `ProvKind` (`index.ts:500-555`) · ◦ observe-only, no per-replica row |
| `fenced` | an inbound record this replica epoch-fenced | per-replica fence trace | same · ◦ |
| `conflict-loser` | an inbound record this replica logged but lost on same-epoch LWW | per-replica conflict trace | same · ◦ |

> `replica:missing` is **dropped** — redundant with `key:under`; there's no live
> per-replica "this R-set member is absent" seam.

### `write:` — a `cluster.writes` confirm-lifecycle record
*Keyed by write id. Three sub-axes, all stored on a runtime ViewProxy — but **no debug
export today** (the whole family is ⊘ needs-fold).*

| Axis | Value | Definition | Use case | Source |
|---|---|---|---|---|
| **tier** (requested guarantee) | `accepted` | local-apply, latency ≈ 0 | "fastest tier" | `writes.ts:24-43` · ⊘ |
| | `committed` | owner-sequenced (not necessarily LWW winner) | | DECISIONS Z · ⊘ |
| | `replicated` | W of the R-set hold it | "confirmed-durable writes" | · ⊘ |
| | `persisted` | W durably appended (needs a storage seam) | "fsync'd writes" | · ⊘ |
| **state** | `pending` | in flight | "what's stuck right now" | · ⊘ |
| | `confirmed` | reached its bar | | · ⊘ |
| | `rejected` | fell short | "what failed and why" | · ⊘ |
| **reason** (rejected only) | `withheld` | quorum-less write-gate buffered it (⇐ `server:quorum-loss`) | "writes dropped by the CP gate" | · ⊘ |
| | `timeout` | no ACK within `callTimeout` | | · ⊘ |
| | `quorum` | sequenced but never reached W | "writes that missed replication" | · ⊘ |
| | `unconfirmed` | default fallback | | · ⊘ |

> Fire-and-forget writes (no tier requested) are **not recorded** — the zero-overhead hot
> path. `seq`/`epoch`/`origin` on a write row are JOIN fields to the commit it produced,
> not values. This resolves the `committed` overload: `write:committed` (a tier) vs a
> confirmed `reachedTier` vs a rejected one all stay on **this** row, disambiguated by
> `state` — `committed` never leaks to `commit:`.

---

## 4. Cross-cuts (the two sanctioned exceptions)

The exact-type rule deliberately *loses* cross-type queries. These two recover them:

### `is:` — severity sweep
| Value | Definition | Rolls up |
|---|---|---|
| `is:crit` | data at risk — durability/correctness | `key:diverged`/`under`, `server:stale-epoch`, `commit:fence`, `replica:behind` (stuck), `write:rejected` |
| `is:warn` | degraded but expected/self-healing | `server:lagging`/`quorum-loss`, `commit:conflict`, `key:orphan` |
| `is:info` | expected lifecycle | `server:disconnected`, epoch transitions |

The **one** "show me everything unhealthy" query. ◆ derived from per-type states (the
existing `clsOf` severity map).

### `origin:<uuid>` / `seq:<n>` — the LWW-triple JOIN
One logical write has **four faces**: a `write:` row (tier/state/reason), a `commit:`
outcome (won/fence/conflict) on some replica, a `key:` `outcomes[]` entry, and a
`server:quorum-loss` cause. They share `(epoch, seq, origin)`. `origin:X seq:42` scopes
**all types at once** to that single write — a cross-type correlate, not a state value.

---

## 5. Diff from the prior (cross-cutting) grammar

**Re-homed:**
- `commits:lagging` → `replica:behind` (per-partition) **+** `server:lagging` (node rollup) — two faces, two types.
- `commits:diverged` → `key:diverged`.
- `commits:rejected-fenced` / `rejected-conflict` → `commit:fence` / `commit:conflict` (+ `key:has-fence`/`has-conflict`).
- `commits:accepted` → `write:accepted` (it's a write tier, not a commit-record state).
- `view:lagging` → `server:stale-epoch` (a client is never stale; view-lag is a server's epoch staleness).
- `link:disconnected` → `server:disconnected` (⊘ needs-fold).

**Dropped (sample-only / no live producer / unimplemented):**
- `client:{slow,resub,stale,gone,writer}` — all fiction.
- partition `contended` → `key:has-conflict`.
- `delivery:lagging` — unmeasured (O1).
- `replicas:missing` — redundant with `key:under`.
- `owner:{moved,resubscribing}` — `moved` is an epoch rollup count; `resubscribing` is unimplemented.

**Net:** ~7 fiction tokens removed; the honest live grammar is smaller — but a real,
valuable **missing** surface appears (`write:`, `server:quorum-loss`, `key:orphan`, the
epoch/membership feeds).

---

## 6. Fold-seam punch-list (to make ⊘ / ◦ values live)

Each item is a real stored/streamed signal the viewer just doesn't consume yet.

| Want live | What it needs | Source today |
|---|---|---|
| `write:*` (whole family) | a `cluster.writes` → snapshot fold seam (none exists) | runtime ViewProxy, `writes.ts` |
| `server:disconnected` / `suspect` | `export.ts` to fold `snapshot.peers` STATUS | stored, ships on wire (`peer.ts:34-41`) |
| membership `admitted/evicting/evicted` | fold ViewManager transition state | stored, only count ships |
| `epoch:past` timeline / `server:quorum-loss` history | bridge to consume the `kind:'view'`/`'writable'` observe transitions (it drops them) | `observe.ts:99`, dropped at `bridge.ts:354` |
| `commit:` log values (`update`/`won`/…) on a row | a change-record-log export seam | none (`export.ts:21,64`) |
| `sub:` delivery lag | a per-sub delivery counter (sent vs acked) | unmeasured (O1) |
| `replica:` per-replica apply rows (`won`/`fenced`/…) | fold per-replica ProvKind | observe-stream only |

---

## 7. Open decisions

1. **Honesty in the UI** — show ⊘/◦ tokens greyed (as a roadmap) so the grammar is
   complete, or hide them until their seam exists so a filter never returns nothing?
2. **`is:` + `origin:`/`seq:` exceptions** — bless as first-class grammar, or keep as a
   separate UI affordance outside `key:value`?
3. **Data-plane lag's two faces** — expose both `server:lagging` and `replica:behind` and
   union via OR, or add a derived `is:behind` that expands to the union? (They're different
   granularities — node-level vs per-partition — so "one home" is genuinely ambiguous.)
4. **List `write:` now (driving the fold seam) or omit until folded?** Listing a queryable
   that returns nothing risks the same fiction we just removed.
5. **Build the missing fold seams as part of this**, or grammar-first and seams as a
   follow-on workstream?
