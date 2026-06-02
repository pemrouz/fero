# L1 log/view — ideas & suggestions ledger

Companion to [../transport/IDEAS.md](../transport/IDEAS.md). Improvements deferred
from the first cut of L1, by concern. Legend: **[P1]** soon / **[P2]** when it
matters / **[P3]** nice-to-have.

v1 L1 is **full replication** (every server materializes every record, via
dialed-broadcast) with an **in-memory** log. The big gaps below — catch-up on
(re)connect, a conflict rule, persistence, compaction — are what separate it from
production-grade, and several interlock with the deferred handshake state-sync.

---

## Correctness / robustness
- **[ADDRESSED — Milestone B] Catch-up on (re)connect.** When a dialed peer's
  handshake completes (transport `onConnect`), the two nodes exchange per-origin
  high-water **digests** (`Log.originHeads()` / resource's `seen`) and each ships
  the records the other lacks (`Log.recordsSince(vector)`, framed by `catchupTo`).
  The receiver folds them through dedup + LWW, so a late joiner or a blipped peer
  converges without anyone staying connected throughout. Reconnect is automatic:
  a dropped dial reconnects (Peer retry) → handshake re-fires → digest again.
  Remaining: (a) the digest+diff is per-origin-coarse — fine, but a Merkle/range
  digest would cut the comparison for huge logs; (b) a true partition-heal chaos
  test (kill a link mid-stream, heal, assert convergence) belongs in L4; (c)
  catch-up currently ships over the dialed connection only — verify behaviour when
  ONLY an inbound connection exists (asymmetric reachability). See
  [../resource/IDEAS.md](../resource/IDEAS.md).
- **[ADDRESSED at L2 — Milestone A] Conflict rule.** Records now carry provenance
  (origin uuid + Lamport `seq`); L2's replication core resolves concurrent same-key
  writes by last-writer-wins (lexicographic seq, origin) and dedups by per-origin
  high-water mark. The logical clock lives in [../resource/index.ts](../resource/index.ts),
  not the Log itself — the Log just stores records (now with provenance) as the
  per-origin history catch-up forwards. Remaining: an HLC/wall-clock refinement,
  and applying the same merge inside the (still-deferred) handshake state-sync.
  See [../resource/IDEAS.md](../resource/IDEAS.md). Ties to plan §11.3.
- **[ADDRESSED — Milestone C] Persistence.** A `storage` seam (plan §4): on boot
  fero replays `storage.load()` through the same accept path as inbound records
  (rebuilding seen/clock/versions + the proxy), then appends every accepted record
  via `log.onAppend`. A built-in append-only-file WAL (`fileStorage`) ships;
  bring-your-own implements `{ load, append }`. Remaining: (a) throughput — the
  file adapter does a synchronous `fsync` per write; batch / async / coalesce for
  high write rates; (b) the WAL grows unbounded → needs the compaction below
  (snapshot + truncate); (c) restore re-keys nothing — records keep their ORIGINAL
  origin uuid (correct: the new instance continues under its own uuid, history
  stays attributed). See [../resource/IDEAS.md](../resource/IDEAS.md).
- **[P2] Full-replication only.** No DHT-partitioned ownership at L1 (every node
  holds everything). Partitioned holding (a node materializes only its owned
  partitions, routes the rest) is the L2 refinement — the DHT + `mesh.send`/
  `replicate` are ready for it; L1 v1 just uses `broadcast`.

## Perf
- **[P1] Unbounded log → compaction.** Segments grow forever. Need compaction
  (collapse to latest value per key) and/or snapshot+truncate so a long-running,
  high-churn partition doesn't exhaust memory.
- **[P2] Lazy-RecordView buffer retention.** Inbound records stored in the log are lazy
  `RecordView`s pinning their frame buffers (one retained record pins a whole frame).
  Either materialize fields on append (copy out) or accept it — measure. Cross-ref
  the message.ts lazy-buffer item.
- **[P2] `diff()` allocates the whole tail.** A big catch-up builds one large
  array; stream it (generator / chunked frames) so a fresh join doesn't spike
  memory on the sender.
- **[P3] `heads()` allocates per call** — cache and invalidate on append.

## Testing
- **[P2] Concurrent-write divergence** — a test that demonstrates two nodes
  diverging under simultaneous same-key writes (motivates the conflict rule).
- **[P2] Catch-up correctness** — once handshake sync lands: a node that missed
  records converges via `diff` on (re)connect.
- **[P2] N-node + partition/heal** — chaos (L4).

## API
- **[P2] Subset/projection views** — `view(log, filter)` or projecting a single
  partition, for L2's per-client `read()` projections.
- **[P3] `log()` options** — storage adapter, compaction policy.

## Alternatives
- **[P2] CRDT / OR-set** conflict-free merge vs LWW-by-ptime — the trade is merge
  semantics (intent-preserving) vs simplicity. Decide with the conflict rule.
- **[P3] WAL + checkpoint** (DB-style) as the persistence+compaction shape.
