# log — per-partition change-record log + $() projection (L1)

L1 sits directly above the `data` sibling and below the resource layer. It owns the **record-as-log-entry** model: a `data` change record (`{type, key, value, at?}`) IS a log entry — no translation — so the log is just ordered records **segmented by partition** (their top-level key). That log is two things at once: the durable history a node replays on restart, and the replication source a peer catches up on. L1 also owns the read side: [`view(log)`](index.ts) materializes a log into a `$()` ViewProxy and keeps it in sync.

Segmenting by partition (not one flat log) means ownership — which moves per-partition via the DHT — maps cleanly onto log segments for rebalancing and shedding.

## Files

| File | Role |
|---|---|
| [log.ts](log.ts) | The `Log` class: append + the two sync vocabularies (offset-vector `heads`/`since`/`diff`; provenance anti-entropy `marks`/`recordsSince`), `drop` for scoped shedding, and the per-origin vs per-(origin,partition) index granularity. |
| [index.ts](index.ts) | L1 public surface: `log()`, `view()` (the day-0 projection), `applyRecord` (the apply contract, shared with L2), and `distribute()` (the standalone arch-A demonstrator on an L0 mesh). Re-exports `Log` + `value`. |
| [log.test.ts](log.test.ts) | Log unit tests — segmentation, heads/since/diff, and both anti-entropy modes incl. the rebalance-acquisition case. |
| [index.test.ts](index.test.ts) | view/replay + 2-node `distribute()` replication (and the no-echo guard). |
| [log.perf.ts](log.perf.ts) | Hot-path thresholds: append 10k records (<12ms), project a 10k-record log into a view (<60ms). |

## Public surface

```js
import { log, view, applyRecord, distribute, Log } from 'fero/internals'

const l = log()                                  // standalone, no network
l.append({ type: 'update', key: ['user42'], value: { name: 'P' } })

const data = view(l)                             // a $() ViewProxy over the log
data.tap(...)                                    // reactive read side works
l.append({ type: 'update', key: ['user42', 'active'], value: true })
// data now reflects { user42: { name: 'P', active: true } }
```

| Export | What it is |
|---|---|
| `log()` | A fresh `Log` (full-replication granularity). |
| `Log` | The class — `append` · `onAppend` · `head`/`heads`/`since`/`diff` · `marks`/`recordsSince` · `drop` · `compact` · `partitions` · `size`. Construct scoped via `new Log({ scoped: true })`. |
| `versionKey(record)` | The LWW-contention key (`at` folded into the path). Shared with L2 so compaction collapses EXACTLY the records LWW treats as one cell. |
| `view(log)` | A `$()` ViewProxy projecting the log: replays existing records, then applies each future append. Pure read-side (log → view, one direction). |
| `applyRecord(res, record)` | The terminal apply contract — `update`/`insert`/`remove` onto a `data` `res`. The one place records become state; shared with L2. |
| `distribute(opts)` | `{ data, log, mesh }` — a log+view wired to an L0 transport mesh. **Arch A** (log is the write API); the demonstrator, not the resource core (see Design notes). |
| `originKey(origin, partition)` | The `origin\x00partition` composite key for scoped mode. Shared with L2 so digest and reply agree byte-for-byte. |

## How it works

**One append, two indexes** ([log.ts:76-90](log.ts)). `#segments` maps `partition → ordered records` (the durable history). `#index` maps a *provenance key → records, seq-ascending* (the anti-entropy index, populated only for records carrying `origin`). `append()` pushes to both, returns the partition's new head (entry count), and notifies `onAppend` listeners synchronously — the view and the replicator both subscribe there.

**Index granularity is the subtle bit** ([log.ts:24-36](log.ts)), fixed once at construction and gated on R:

- **Full replication** (`scoped: false`, default) keys `#index` by **origin**. Every node holds every partition, so one origin's whole seq stream is a single contiguous in-order run — a compact O(origins) digest, and catch-up frames coalesce into one.
- **Scoped holding** (finite R) keys by **(origin, partition)** via [`originKey`](log.ts) (`origin + '\x00' + partition`). A scoped node materializes only the partitions it replicates, so it sees only a *subset* of an origin's writes; a per-origin mark would conflate partitions, and a node acquiring a partition on rebalance couldn't tell what it's missing — catch-up would silently drop records. Keying by (origin,partition) makes each partition's stream independently complete (its single owner is one in-order source), bounds the digest to held partitions, and re-syncs an acquired partition from seq 0.

Only **one** index is ever maintained, so full replication pays nothing for scoped's existence.

**Anti-entropy** ([log.ts:165-182](log.ts)). `recordsSince(vector)` ships every record whose seq exceeds the peer's high-water for its provenance key. Each index group is seq-sorted (the resource layer dedups before appending, so streams arrive in strictly increasing seq order), so the first record past the peer's mark is a **binary search**. A key the peer has *never* seen (absent from `vector`) ships in full — that's the rebalance-acquisition case ([log.test.ts:97-104](log.test.ts)): a record's seq can sit *below* another origin's high-water yet still ship, because the peer has no mark for *that* (origin,partition). In scoped mode the output is re-sorted by `(origin, seq)` so an origin's records coalesce into the fewest downstream frames. `marks()` ([log.ts:150-154](log.ts)) is the inverse digest a node *sends*, same granularity; because it iterates `#index`, a dropped group leaves no zombie mark.

> **Invariant:** records for a given provenance key must be appended in seq-ascending order — `recordsSince`/`marks` assume it. Enforced upstream (the resource layer dedups + stamps monotonic seqs); appending out-of-seq would corrupt the binary search silently. This is the exact reason owner-*relay* was reverted (multi-path → out-of-order → loss): see [DECISIONS F](../DECISIONS.md).

**Shedding** ([log.ts:139-144](log.ts)). `drop(partition)` removes the segment plus every (origin,partition) index group whose key `endsWith('\x00' + partition)` (the `\0` anchors the suffix). Scoped-only — in full mode there's nothing to shed. After it, the node no longer claims the partition in its digest, so a stale shed copy can't mislead anti-entropy.

**Projection** ([index.ts:37-43](index.ts)). `view()` is **arch A**: create `$({})`, reach its `.res`, replay every record through [`applyRecord`](index.ts), then subscribe so each future append projects too. `applyRecord` ([index.ts:29-33](index.ts)) maps `update→res.update`, `insert→res.insert(value, key, at)`, `remove→res.remove`; `'move'` is intentionally unhandled ([DECISIONS E](../DECISIONS.md)). `distribute()` ([index.ts:51-71](index.ts)) wires view+log onto a [transport](../transport/) mesh with a one-line echo guard: an `inbound` flag set while applying a received record stops `onAppend` re-broadcasting it (one-hop, no echo storm). v1 is full replication via dialed broadcast.

## Design notes

- **Arch A vs arch B — [DECISIONS H](../DECISIONS.md).** L1's `distribute()`/`view()` derive state *from the log* (arch A — the log is the write API). The resource layer ([L2](../resource/)) **inverts** this: the proxy is the source of truth, the log a history sidecar (arch B), because routing assignment writes (`data.x = y`) back through the log would loop. So `distribute()` is the **standalone demonstrator**, not the production replication path — the two are a deliberate divergence, captured so it isn't mistaken for drift. (Converging them — making `distribute()` proxy-sourced too — is an open follow-up.)
- **R-gated granularity — [DECISIONS P](../DECISIONS.md).** The per-origin → per-(origin,partition) split is the L1 half of scoped R-way holding. Full replication (R=∞) keeps the per-origin path byte-for-byte; the planning detour that tried per-(origin,partition) *under* full replication (P1) was reverted because it grows the digest to ~every key and gaps the seqs.
- **Catch-up / LWW — [DECISIONS A](../DECISIONS.md) + [B](../DECISIONS.md).** The Log only *stores* records (with provenance); the Lamport clock, dedup high-water, and last-writer-wins resolution live in [resource](../resource/). `marks()`/`recordsSince()` are the per-(re)connect sync primitives those decisions build on.
- **The single `sclone` — [DECISIONS G](../DECISIONS.md).** The log needs a deep owned copy (because `data` mutates nested objects in place), so the write-path clone is essential, not redundant; broadcast piggybacks on it. The structural win (store *encoded* bytes in the log) is deferred.

## Open work

Tracked in [IDEAS.md](../IDEAS.md), tagged `(log)`:

- **Bounded memory & compaction [P1]** — in-memory `compact()` LANDED ([DECISIONS W](../DECISIONS.md)): collapses strictly-superseded same-origin updates on an unref'd timer (marks/catch-up/shed preserved), and the index rebuild is single-pass (one union over all partitions, not one rebuild per partition). Remaining: insert/remove-churn collapse + array element-identity; a per-partition dirty-set so the sweep is O(written); WAL snapshot+truncate; `versions`/`seen` tombstone GC. `heads()` still allocates per call (cache + invalidate on append).
- **Catch-up & anti-entropy hardening [P2]** — Merkle/range digest (P3) to cut the per-origin-coarse comparison for huge logs; stream `diff()`/`recordsSince` instead of allocating the whole tail; verify asymmetric (inbound-only) reachability.
- **Store encoded records in the log [P2]** — retain bytes / lazy `RecordView`s so the log needs no `sclone` and catch-up re-ships verbatim ([DECISIONS G](../DECISIONS.md)); gate retention behind a `durable`/`catchup` config.
- **Surfaces / subset views [P2]** — `view(log, filter)` / single-partition projection so L2's per-client `read()` projections can derive from the log.
- **Housekeeping:** `applyRecord` is the single home for the record→state contract — the [utils](../utils/index.ts) test fixture `apply` re-exports it (done), so the two can't drift. (Tightening the `any`-typed `view()`/`applyRecord` surface is blocked upstream: `data` is `@ts-nocheck` and exports no `$()`-return type, and fero has no typecheck step — tracked cross-cutting in [IDEAS.md](../IDEAS.md).)
