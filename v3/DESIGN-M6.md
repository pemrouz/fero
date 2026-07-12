<!-- The M6 working design reference (CHECKPOINT.md precedent). Produced 2026-07-12 by a
     three-design judge panel (minimal-machinery / explicit-handover / invariant-first lenses,
     three focus judges, adversarial fatals repaired in synthesis). Line-number seams cite the
     tree at commit 1cc08b1; drift is expected as slices land — the mechanisms, not the line
     numbers, are the contract. Slice 5 lifts §6 residuals into IDEAS and writes the DECISIONS
     record; this file then stays as the milestone archive. -->

# M6 FINAL DESIGN — scoped replication + aggregates

**Synthesis provenance.** Panel winner: **Design 2** (explicit-handover state machine), 2-1. This document is D2's skeleton with every judge-found fatal repaired and the recommended grafts folded in:

| Repair/graft | Source | Closes |
|---|---|---|
| Scoped **dual fence** + splice-in ingest law | D3 (scoped-gated per J2's condition) | J1-fatal-1: cross-link partition-filtered interleave → write.ts:491 dup-drop → permanent interior loss at a steady-held node |
| Confirm counts **handshake-attested per-(o,p) marks**, never bare digest `d[o]` | new (forced by J1-fatal-1's confirm leg) | the "confirmed with < W real copies" overclaim |
| **Teacher-only staging + completeness floor at fold** | D1 | J1-fatal-2 / J3-fatal-1: promiscuous staging folds a torn third-party suffix → resurrection + HAVEA overclaim |
| **Announcement-gated AE** (possession learned from HAVEQ, not ring alone) | D3 | same hole, closed at the never-sent leg |
| **Per-key stamped claim merge + parked-empty rule + coverage sweep** | D3 + D1 (parking) | J1-fatal-3 / J3-fatal-2: root-replace coordinator zero-claim; also J2's D3-ghost (stale claim outliving a GC'd remove) |
| **One-teacher-always** (no empty-as-known → multi-source AE fallback) | D1 principle, per J1's graft | D3's H3 pinhole; never inherited |
| **No-interior-rows WAL discipline** (splices/base folds reach disk only via `snapshot()`) | D2, made explicit per J1's graft | D3's ungated walTail/replay change (J2/J3 inertness fatal) — unscoped replay is untouched |
| Stateless shed **decision**, okFrom demoted to evidence cache | D1 via J2/J3 grafts | invalidation-by-construction |
| Batched HAVEQ/HAVEA bodies; ring-level holders memo; `shedWaitingOn`; `bind.shedPartition` as one subtree remove; defer-while-acquiring folds; 14-window crash matrix; escalating `shedStall` | J1/J2/J3 grafts | perf + operability + test coverage |

**The three organizing rules** (everything below hangs off them):

1. **A per-(node, partition) state machine** in a new `v3/kernel/scope.ts`: `out → acquiring → held ⇄ orphan(frozen) → shed`. The **no-bypass rule**: every entry into `held` passes through one atomic one-teacher fold — the sole exception is the owner minting a partition's first-ever record (complete by construction). `orphan → held` re-entry also goes through `acquiring` (delta above frozen marks). Every transition is journaled and re-derivable at boot from `BootRecord.heldPartitions` + the restored ring.
2. **The DIGEST wire shape is untouched in both modes** (node.ts:949-960 emits `{d, r, p?}` byte-for-byte; `d` = log tails, :951). Per-(origin, partition) evidence rides only the churn-priced HAVEQ/HAVEA handshake. There is no digest surface for the byte-identity sweep to defend.
3. **Inert-by-construction at R=∞.** Arming predicate: `node.scoped` (node.ts:212, `replicas ≥ 1`, already landed) **∧ `epoch > 0`** (open genesis is always unscoped — no committed view, no ring). Unscoped: zero new allocations, zero new frames, no ingest/replay/digest change; one predicted-false branch per record at the fan-out and one at inbound. Scoped verbs are simply never sent, `parts` maps never allocated, scope.ts never constructed.

`R_eff = min(replicas, view.members.length)`; `W = (R_eff_holders >> 1) + 1`, derived, never configurable. C1/C2 (config + ring) are already landed in source (NodeOpts.replicas node.ts:60-67, CONFIG_KEYS api/index.ts:26 + validation :56-60, harness.ts:15-25, `holdersOf`/widened `place` ring.ts:94-141); slice 1 only adds `holdsAny`, the per-epoch holders memo, and the `cluster.partitions` projection.

---

## §0 The scoped ingest law (stream keying + the dual fence — C4 folded here, referenced by C3/C7/C8)

`StreamDescriptor` (streams.ts:33-37) keeps scalar `applied/shippable/durable` untouched and gains, **allocated only when scoped**:

```ts
parts?: Map<string, { s: number; d: number }>   // partition → possession floor, durable floor
```

**`parts[p].s` is a possession floor, not a max-in-log**: it attests "my log contains-or-covers every (o,p) record with seq ≤ s". It is the sole scoped possession claim (HAVEA answers, shed evidence, confirm counting, frontier/GC all read it). The per-origin `applied` dedup fence (write.ts:491) **never fragments** and remains the fast path.

For a scoped node ingesting record (lane o, seq q, partition p) on the RECORDS plane (live or AE), after the Lamport merge-up (write.ts:484, always runs) and the epoch-staleness check (node.ts:756, order preserved):

| Condition | Action |
|---|---|
| p not in scope (∉ held ∪ orphaned ∪ acquiring per scope.ts) | **gate-drop**: `JK.gateDrop`, no log, no apply, **`applied` untouched** (C7) |
| p has an open teacher latch (acquiring, or held-with-delta-in-flight) | **stage** into the latch buffer; `applied`/`parts` untouched (C8) |
| `q > applied[o]` | fast path, today's code + one upsert: append, `applied→q`, `parts[p].s → max(s,q)`, apply (write.ts:492-500) |
| `q ≤ applied[o] ∧ q > parts[p].s` | **dual-fence admit** (the D3 graft, scoped-only): binary-search the lane for (o,q); present → dupDrop; absent → **splice-in** at seq position (lane stays ascending for the AE walk node.ts:891-901 and compaction), apply through the one LWW election, `parts[p].s → max(s,q)`, journal `JK.applyInbound` |
| `q ≤ applied[o] ∧ q ≤ parts[p].s` | dupDrop (write.ts:491 unchanged) — genuine dup or floor-covered |

**Why the floor advance `s → max(s,q)` on splice/fast-path is sound** (the §7.1 replacement, an induction the sim's exactly-R monitor shadows): (i) each single source delivers a given (o,p) sub-stream ascending (owner FIFO live; one teacher walking a flat lane; AE answerers walking ascending suffixes); (ii) only steady-held nodes answer AE / HAVEA-ok (no-bypass ⇒ their own floors are sound, inductively down to an atomic one-teacher base); (iii) the scoped compaction frontier for (o,p) ranges over **holders' + announcers' per-(o,p) marks including mine** (§C3), marks are monotone per life and voided at rebirth (node.ts:712-716 → `scope.forget` beside `confirm.forget`), so no lawful compaction has ever dropped a record below a mark I never announced; therefore any record between my old floor and an admitted q is either in my log, in flight and admissible later via the same dual fence, or lawfully-compacted-because-I-provably-had-it. A record admitted below `applied` is never re-lost: nothing above the floor is ever dropped.

**Own-lane stamp site** (node.ts:517-518): when scoped, also `parts[partitionOf(rec)].s = seq` — the minting owner's floor is trivially sound.

**Durable ladder per (o,p)**: `#inflight` cover maps (node.ts:172, persistRun :542-551, snapshot :590) gain a per-partition split when scoped (`Map<batch, Map<origin, Map<partition, maxSeq>>>`); the `persisted` echo (node.ts:260-270) advances `parts[p].d`.

**The no-interior-rows WAL discipline** (repairs J1's replay graft without touching unscoped replay): a dual-fence **splice on a durable node never rides `persistRun`** — raw-appending it would move `walTail` backwards (node.ts:545-546) and replay's dedup (write.ts:548) would both drop it and then condemn the chain. Instead the splice is memory-only and arms `snapshot()` at the next tick (`#walRows = SNAPSHOT_AT`); the whole-WAL swap (node.ts:562-594, env.ts:102-108 atomic contract) captures it in lane order. Until the swap's echo, `parts[p].d` does not cover it and (per the "never attest possession your disk can't restore" rule) a durable node's HAVEA/announced marks for freshly-spliced or freshly-acquired spans advance only on the persisted echo. A crash before the swap restores the pre-splice fold with honest lower marks — the incarnation bump voids the stale higher marks at peers, and the handshake re-heals. Acquisition base folds enter disk the same way (ACQDONE → snapshot; §C8). **Replay is unchanged for unscoped nodes**; for scoped nodes it adds only the boot held-gate: a replayed record whose partition ∉ (`heldPartitions` ∪ ring-held at the restored view) **skips the fold and the marks but still advances `d.applied` and the chain tail** — it was fresh at persist time and counted in the row's `maxSeq`/chain link (node.ts:764, write.ts:539/565), so not advancing would false-positive the walHole detector on rows persisted before a shed. (Live gate-drops, by contrast, were never fresh, never in `maxSeq`, and never advance anything — the two rules are consistent because both track "ingested-at-the-time".)

**Interior-hole healing**: generic AE (keyed on the scalar digest `d[o]`, node.ts:891-901) cannot see an interior (o,p) hole; the handshake plane owns it. HAVEQ rounds run at: view install, **link (re)admit** (covers the post-reconnect multi-source window that creates holes), every `SHED_TICKS = 2` ticks for co-holders whose attested marks trail mine **while a confirm probe or shed is pending on them**, and the orphan's shed poll. A HAVEQ marks-compare that finds the asker behind answers `need=1` and receives a one-teacher per-(o,p) delta (§C8) — which splices through the dual fence. Steady state with no probes and no churn: zero handshake frames.

---

## §1 Decisions

### C3 — shed-confirm evidence: the HAVEQ/HAVEA handshake; stateless shed decision; confirm re-ranged onto handshake marks

**Mechanism.** Per-(o,p) evidence never rides the digest. Each scope entry keeps `marks: Map<uuid, Map<origin, seq>>` — the last **attested** per-lane marks per peer for this partition, fed by HAVEQ-in (the asker's own declared marks) and HAVEA-ok-in (the answerer covers the asked marks ⇒ record the asked marks), monotone per life, cleared wholesale at view install (epoch-scoped), voided per peer by `scope.forget(uuid)` on incarnation bump (hooked beside confirm.forget, node.ts:712-716).

**Wire shape** (bodies via `encodeControl`, codec.ts:381; batched per J3's graft — one frame per co-holder per round, not per partition):

```
HAVEQ = 19  { e, q: { partition: { origin: myParts[o][p].s } } }     // "I possess these; state your coverage"
HAVEA = 20  { e, a: { partition: { ok: 0|1, need: 0|1,
                                   m?: {origin: seq},                 // need=1: my marks, so the delta ships only the gap
                                   md?: {origin: seq} } } }           // durable answerers: per-lane durable marks
```

Sent admitted-only, epoch-guarded (mismatch → drop + journal; re-driven by the next install/tick round). `ok=1` iff the answerer's state for p is `held` (never acquiring — counts for nothing by construction) **and** `parts[o][p].s ≥ asked m_o` for every asked lane. `need=1` iff answerer ∈ its own `holdersOf(p, e)` and is behind — it latches the asker as its one teacher (§C8). Worn by a held node it is the teach/confirm driver; worn by an orphan it is the shed poll — one mechanism, two hats (D2, kept).

**The shed DECISION is stateless** (D1 via J2/J3 grafts): on every HAVEA-in, DIGEST-in with orphans present, view install, and tick, each orphaned p re-evaluates fresh:

> shed(p) iff for every member m ∈ `holdersOf(p, R)` at the **current** ring, for every lane o where my `parts[o][p].s > 0`: `entry.marks(m, o) ≥ my parts[o][p].s`.

There is no stored `shedReady` to invalidate: a changed R-set re-ranges the quantifier ({A,B}→{C,D} cannot shed on one stale confirmation); a tail bump cannot occur at all because orphans are frozen (§C7) — a monitor asserts orphan marks never advance (expected-empty). Evidence is possession (`s`-floors), never applied/seen — per plan §5 verbatim. A sim monitor cross-checks every shed against a fresh recomputation from raw marks (J3's belt-and-braces oracle).

**Confirm re-ranged** (the J1-fatal-1 confirm-leg repair — this is where the synthesis *departs* from D2's §7.2): `Probe` gains `part?: string` (confirm.ts:46); `register` (:59), the env `confirm` event (env.ts:42), node.ts:273-276, the api probe site (api/index.ts:92-103, part = `partitionOf(rec)`), and the system-confirm RPC arg `{o,s,l,t}` → `+pt` (api/index.ts:114-117, spoke call :144) thread it. `recount`/`#count` (confirm.ts:125-152): when `part` present ∧ scoped, members := `holdersOf(part, R)`, threshold := W; **self** counts via own `parts[o][p]` (`s` for replicated, `d` for persisted); **a peer h counts iff the scope entry's attested marks for h cover seq** (`marks(h,o) ≥ seq`; persisted level reads the `md`-fed durable mirror). The bare digest `d[o] ≥ seq` is *never* sufficient scoped evidence — under partition-filtered multi-source shipping a steady-held peer's `d[o]` can run past an interior hole (the proven J1 scenario). Liveness: a pending probe is a handshake trigger (the owner re-HAVEQs p with marks covering seq each tick until W answers land) — evidence converges on tick cadence exactly like unscoped digests, priced per open probe instead of per heartbeat. Probes never wedge: install→recount (membership.ts:379) re-ranges onto the new R-set; acquiring peers simply don't count until their fold + post-fold round.

**Frontier/GC re-ranged** (log.ts): when scoped, `frontier` becomes per-(o,p): min over `holdersOf(p, R)` ∪ announcers-of-p of the per-(o,p) stableMark — self from `parts` (durable nodes at `parts[p].d`, log.ts:71-74 pattern), peers from the scope entry's attested marks (durable peers at the `md` mirror), absent = 0 = pinned. `compact()` (log.ts:91-108) keeps an entry iff winner OR `seq > frontier(o, partitionOf(e.rec))`, memoized per partition per pass. `gcTombstones` (:112-145) quiescence ranges each (lane, partition) over the same set. Named invariant with its own expected-empty monitor (J2 graft): **a mid-acquisition holder contributes 0 to per-(o,p) frontier and quiescence** — it pins both (load-bearing for H3). Non-holders no longer pin (invariant B11 both directions); unscoped keeps today's member-ranged code path verbatim.

**Seams**: confirm.ts:46/59/91-98/117-120/125-152; node.ts:273-276, 712-716; log.ts:71-74/76-85/91-108/112-145; membership.ts:379 (existing hook suffices); codec.ts:48-57 (verbs 19-20); node.ts `#dispatch` beside DIGEST (:842).
**New state + bounds**: scope entry `marks` — O(R × lanes-touching-p) per locally-present partition; `parts` on descriptors — O(partitions per lane), scoped-only; Probe `+part` — one field; **Link: nothing new for evidence**.

### C7 — fan-out + held-gate: never-sent primary, drop-at-inbound secondary; orphans hard-freeze

**Outbound** (THE seam, node.ts:519-525): per committed record, when armed:

```ts
if (link.state === LS.admitted && link.synced &&
    (!scoped || link.client || holders.includes(link.uuid)))   // holders: memoized, ≤ R
  link.add(rec, …)
```

`holders` comes from a **ring-level per-epoch memo** (J1/J2 graft): `Ring.#holdersCache: Map<partition, string[]>` (a copy of the scratch), cleared wholesale in `build()` (ring.ts:54) — one walk per touched partition per epoch; steady-state cost is one `Map.get` per record. The same memo backs the AE answer filter and `holdsAny(uuid, p, r)` (new, early-exit, allocation-free). Flush (node.ts:527) is already per-touched-link. Client links keep the spoke tap (write.ts:506-509 unchanged — a spoke hears its primary's ingested = held subset). **Orphans are excluded from the instant of install** — the freeze. Justification (D2, kept): feeding orphans makes shed-confirm chase a moving target and turns H7 into the common case; freezing fixes the bar at the frozen tails, so the window is bounded by transfer of a *fixed* backlog. New records already have R live copies via the scoped fan-out; the orphan's copy is load-bearing only for the frozen prefix, which is exactly what shed certifies. An orphan is never the owner at the current epoch, so it commits nothing new.

**Inbound held-gate** (write.ts:480-491, per the §0 law): a record for p ∉ (held ∪ orphaned ∪ acquiring) → `JK.gateDrop`, no `applied` advance. It exists for the one lawful race — a sender fanning out on an older epoch's ring — and can never forge evidence (the dropper never attests marks for p) or strand data (the true holders receive it from the sender directly; the committer's own copy survives until shed). Orphans gate-drop p too (hard freeze; H5 stays sound because confirm ranges over the *current* R-set and the committer retains its own copy). **Relays/forwards untouched**: WRITE forwarding targets `ownerOf` = holders[0] (write.ts:257, :263-282); NACK validation order preserved (write.ts:398-402, `holds` at :400 stays owner-equality).

**WAL**: node.ts:764 WALs a frame iff anything fresh; gate-dropped records are not fresh. A mixed epoch-skew frame persists whole bytes; the **replay held-gate** (§0: skip fold, advance applied/chain) re-filters on restore and the next snapshot purges the bytes — re-encoding the held subset per inbound frame is rejected (hot-path copy for a transient skew case).

**AE answer filter** (node.ts:891-901): when scoped, the suffix walk ships an entry iff `partitionOf(e.rec) ∈ link.announced ∧ requester ∈ holdersCache(p)` — `link.announced: Set<partition>` is fed by HAVEQ receipt (possession announcements), cleared per epoch/incarnation. An acquiring node has never HAVEQ'd p ⇒ no AE for it from anyone (the never-sent leg of the J1-fatal-2 repair); an orphan announces but is not ring-held ⇒ excluded ⇒ the freeze needs no extra wire state. `link.synced` (link.ts:45-52) keeps its exact whole-link job — per-link FIFO hygiene; the per-scope sync state the build map anticipated **is** the scope.ts machine.

**Seams**: node.ts:519-525, 527, 764, 891-901; write.ts:480-521 (gate + stage hook), 506-509 (inherits gating upstream); ring.ts:54 (+cache), new `holdsAny`.
**New state + bounds**: `Ring.#holdersCache` O(touched partitions/epoch); `Link.announced` O(peer's held); scope module owns the rest (§C8).

### C8 — acquisition: HAVEQ-latched one teacher, staged, floor-folded, echo-fenced

**Verbs** (codec.ts free from 19; ACQ reuses `encodeRuns(entries, VERB.ACQ)` — the verb param exists, codec.ts:423-425, so provenance + attempt identity ride exactly like AE and dedup windows rebuild):

```
ACQ     = 21   RECORDS-shaped runs — teacher→learner transfer (base or delta), fence-exempt ingest route
ACQDONE = 22   { p, e, t: {origin: cutSeq}, n: entriesShipped }
```

**Latch**: a node behind for p (from-zero acquirer, orphan re-entering the R-set, or a held node found lagging by a HAVEQ marks-compare) answers `HAVEA need=1` to exactly one asker and latches it as teacher; while latched, other HAVEQs for p answer `ok=0, need=0` (busy) and **ACQ frames from any other link drop with `JK.stageDrop`** (one teacher per attempt — D1's rule). There is **no empty-as-known-then-AE fallback** (J1's graft): if nothing announces p after K=2 ticks, the partition is held-with-zero-base (the genesis/new-partition case); a *late* announcer's HAVEQ then marks-compares and triggers a real one-teacher delta from marks 0 — from-zero folds never touch the AE plane, ever.

**Teacher side** (on `need=1` with echoed marks m): synchronously walk every flat lane in seq order shipping (·,p) entries with `seq > m[o]` as ACQ runs (chunked by MAX_FRAME, `link.ship` backpressure), then `ACQDONE {p, e, t: cut, n}` where **cut = own `parts[o][p].s` captured at walk time** (authoritative even where compaction made the last surviving entry's seq < the watermark — J2's pin) and n = entries shipped. Records the teacher ingests after the walk are deliberately outside cut — they reach the learner as staged live or via the post-fold round. Journal `JK.teachShip`.

**Learner side**: ACQ entries and concurrent live RECORDS for a latched p both go to the latch buffer (`entry.buf`) — **nothing touches lanes, state, versions, `applied`, `parts`, or the WAL until the fold**. Bounds: the teacher-stream side is bounded by the partition itself (data the node must hold anyway); the **live-staged side is capped** (`ACQ_LIVE_MAX = 8192`; overflow → abort, safe because nothing folded and the re-offered delta re-ships everything above the learner's marks — this kills J2's big-partition overflow livelock while keeping the burst bound where it matters).

**Fold at ACQDONE** (one synchronous step): verify staged-teacher-entry count = n (a silent whole-queue drop on a live link torns the ship; mismatch → abort); then per lane — splice teacher entries in seq order through the LWW election (fence-exempt; membership-checked), advancing `parts[o][p].s` along the teacher stream **including through membership-dups** (the teacher stream is complete-below by attestation); then **discard staged non-teacher records with `seq ≤ cut[their lane]`** (D1's floor: their effect is in the fold or was lawfully compacted by the teacher — the floor-soundness argument transfers verbatim); replay the remaining staged records (live, above cut) through the normal §0 ingest law; set `parts[o][p].s = cut[o]` (never staged-max — a link death mid-stage can tear the live span, and cut is the only floor the teacher attested); merge `applied[o] = max(applied, cut[o])`; `JK.acquire`; then:
- non-durable: state := held immediately; **the mandatory post-fold round**: HAVEQ every co-holder with the post-fold marks — it trues the floor up over the staged-live span (the teacher answers need=1 and re-ships the gap; dups advance the floor), announces possession (arms AE), and seeds confirm evidence.
- durable: arm `snapshot()` (the base enters disk atomically, lane-ordered — never `persistRun`, per §0); on the swap's persisted echo: add p to `heldPartitions`, `persistBoot()`, state := held, then the post-fold round. **HAVEA ok / possession announcements only from `held`** — a durable node never attests possession its disk can't restore (J1 graft).

**Abort legs** (`JK.acquireAbort` a=partition, b=reason): teacher linkDown; teacher reborn; epoch change (any view install aborts all in-flight latches — the machine is epoch-scoped); DONE count mismatch; live-stage overflow; `STAGE_TICKS` without progress. Abort drops the buffer whole — nothing was folded, nothing to unwind — and the next offer re-drives. **Abort-at-descope with log residue** (the H2 corner: an acquiring *owner* committed own-lane records mid-transfer): if any (·,p) entries exist in the log at abort, the entry becomes `orphan` (possession ⇒ retention obligation ⇒ freeze + poll + shed); else `out`. Learner crash mid-transfer: buffers are volatile and p ∉ `heldPartitions` ⇒ clean re-acquire after boot.

**Held-delta = the same machinery**: a held node's `need=1` opens the same latch (stage live-for-p, fold at DONE with the floor, `parts.s = cut`, post-fold round). One code path, one proof.

**Seams**: codec.ts:48-57 (+21/22); node.ts:842+ dispatch cases; write.ts:480 stage hook; scope.ts (new, owns latch/buf/fold); node.ts:562-594 (snapshot arming), :622-634 (persistBoot).
**New state + bounds** (kernel/scope.ts, owned by Node like `writes`/`confirm`):

```ts
entries: Map<partition, {
  state: 1|2|3                    // held | acquiring | orphan
  holders: readonly string[]      // ring memo reference, rebuilt per install
  marks: Map<uuid, Map<origin, number>>  // attested per-(o,p) marks per peer (≤ R × lanes)
  teacher?: string; buf?: StagedEntry[]  // latch only; live side ≤ ACQ_LIVE_MAX
  cut?: Map<origin, number>              // latch only
}>
```
Total: O(locally-present partitions × (R + lanes)) — the same order as the data; `buf` is the only burst structure.

### C10 — BootRecord.heldPartitions: data-authoritative; the ring is duty-authoritative

`BootRecord` (env.ts:119-125) gains `heldPartitions?: string[]` = current held ∪ orphaned — **absent when unscoped, boot writes byte-identical at R=∞**. Written by every `persistBoot()` (node.ts:622-634; existing sites: start :249, install membership.ts:378, vote :426, clock lease :505) plus the ACQDONE echo and shed step 1. Restore (NodeOpts.boot node.ts:53 → membership.ts:135-146): for each p ∈ heldPartitions — ring at the restored view says holder ⇒ `held`; says non-holder ⇒ `orphan` (frozen at replayed tails, resumes the poll). Ring-held but absent from the record ⇒ `out` (teachers' HAVEQ rounds start acquisition — they enumerate us; we cannot enumerate them). Replay applies the §0 boot held-gate. **Shed execution order** (crash-safe both sides, H1): (1) `persistBoot` with p removed; (2) drop memory — filter (·,p) from every lane (ascending preserved: filtered subsequence), delete p-cells from `state`/`versions`, delete `parts[·][p]`, drop the scope entry, `JK.shed`; (3) durable: `snapshot()` (p's rows leave disk atomically). Recovery is derivable from the boot record + restored view alone — no other state survives.

**Seams**: env.ts:119-125; node.ts:622-634; membership.ts:135-146; write.ts:534-569 (replay gate); harness restore already re-threads NodeOpts (exec.ts:95 `#nodeOpts`; re-apply ring pins after `sim.restart` — durability.test.ts gotcha).
**Bounds**: O(held) strings, cold path.

### C6 — the api surface for non-held partitions

The two-surface model (data.ts:1-30) survives re-scoped: `node.state` **is** the held ∪ orphaned fold — the kernel gate sits upstream of `sink.apply`, so no non-held record ever reaches `Bind.#onApply` (data.ts:215) and the api needs no partition filter on the apply path (one debug assertion keeps it honest).

- **Facade** (built only when `node.scoped || client` — unscoped returns the raw proxy, hot path byte-identical; the v2 dispatch.ts:444 discipline): symbols/builtins → raw; reserved operator names → C5's decomposable/holistic split; key access → held ⇒ raw child proxy; **non-held ⇒ a tagged remote Handle** (plan §9's tagged-Handle machinery): `await data.k` = one-shot `read(k)` CALL routed to the partition's owner; reactive touch = live SUB with re-arm on install. `data.get(key)` always works; the expression means the same at R=2 and R=∞ (J1's graft over D3's typed throw). Unreachable owner ⇒ the handle rejects `ScopedError{reason:'unreachable'}` — typed, never a silent empty stream (§9). Member-to-member routing: the `rpc` event (env.ts:56) gains `to?: string`; node.step's rpc case (node.ts:285-296) routes to `byUuid` when present, else primary — inert unscoped (never set); servers get a gather/read-scoped `Caller` instance (methods.ts:192) wired the same way.
- **Writes to non-held keys**: pipeline unchanged (issue → forward to owner). The resolution gap (a scoped non-holder issuer never sees the committed record on its apply stream, so the data.ts:217-226 join hangs): new **`EffectSink.acked(iss, cid, seq, epoch, owner)`**, emitted **only when scoped** (trace-identical off) from write.ts `onAck` (:418-446, the WACK consumption — precedent for owner-uuid-as-origin: data.ts:251) and the replication-is-an-ACK branch (:510-518). Bind resolves `#pending`, settles the `outcomes` row (data.ts:93), releases overlay — idempotent with the apply join, whichever lands first. **No optimistic echo for non-held partitions** (`#optimistic` data.ts:270 skipped; the facade routes those reads remotely anyway — a local ghost the beneath can't back is banned).
- **Shed → proxy**: on `JK.shed` (the composer fold's cursor, api/index.ts:191-219; JK 59-63 join the FOLD set at :187) Bind runs `shedPartition(p)`: **one synthesized `#apply({type: REC.remove, key: [p]})`** through the ONE projection with the expected-echo consumption arm (data.ts:263-266) — O(1) at the proxy root, downstream operators see an ordinary subtree remove, and the capture fan-back is consumed so nothing re-issues cluster-wide (J2's graft; `#healRoot` data.ts:118-126 stays as the fallback if the substrate can't express the subtree remove). Overlay cells under p drop; pending entries survive (they resolve via `acked`).
- **Spokes**: tap-forward carries the primary's held subset (write.ts:506-509 literally unchanged). **The client contract, stated crisply** (J3 graft): a spoke's whole-resource default read is **gather-backed — complete and typed, never a silent held-subset mirror**; a spoke's non-held `read(k)` is served by the primary forwarding to the owner over its member link (one extra hop, method plane reused). Iteration on a scoped *server's* `data` shows the held shard — documented as the replica view.

**Seams**: new api facade module + data.ts:138-210 (issue branch), :215-259, :263-270, :305-320; env.ts EffectSink; write.ts:418-446/:510-518; api/index.ts:107-110 (read), :187, :191-219; shell/runtime + sim harness sink passthroughs.
**Bounds**: facade is per-instance; `acked` is scalar args, allocation-free.

### C5 — gather + owner-scoped folds: SYSTEM method plane, per-key stamped claims, parking

**Plane**: `gather` lands beside `confirm` in the system table (api/index.ts:113-118); client invocation copies the `SYSTEM + 'confirm'` call shape (:144); `invokeLocal` (methods.ts:158-168) widens to consult the system table (coordinator's self-partial in-process — the v2 1/N lesson). A kernel verb is rejected: CALL/SUB/UNSUB, teardown-on-linkDown (`reapLink` methods.ts:172-175, composer hook api/index.ts:206), retries and failover already live here.

**The rows gather** (repairs J1-fatal-3 + J3-fatal-2 + J2's D3-ghost):
- **Member partial** = stamped claims over held ∪ **unshed-orphan** scope: `{k, v, st: [epoch, seq, origin]}` per cell (stamps from `node.versions`, node.ts:125), plus tombstone claims `{k, st, t:1}` for removes observed on the live delta stream (every local apply is held-scoped by the kernel gate — the tap needs no filter). Rescope pushes (install, ACQDONE, shed) list dropped partitions; **descope sends no per-key retractions** (descope-silent).
- **Coordinator merge** = per-key claimant registry `Map<key, Map<member, claim>>`; the folded value is the LWW-max stamp among live claims (identical total order to the kernel election, node.ts:971-973); a dominating tombstone stamp removes the key. Idempotent under R-fold double-claim; a shed/departed/unsubscribed member's claims clear from the registry; **a key whose claimant set empties without a dominating tombstone is PARKED** — last value stands, flagged — and re-evaluates on every claims change (D1's parking: zero-claim is unrepresentable, not raced-away). **Coverage sweep** (the ghost repair): a parked key drops once every member of `holdersOf(p, epoch)` has an answered, current-epoch subscription and none claims it — absence attested by the full holder set = a real (possibly tombstone-GC'd) delete.
- **One-shot**: CALL every view member + self in-process; merge once. A partition whose entire holder set is unreachable ⇒ reject `ScopedError{reason:'unreachable', missing:[uuids]}` — never a silent partial (plan §5/§9).
- **Live**: `reconcileMembers` on the composer's `JK.viewInstall` fold + tick retry (subscribe-new with retry-on-falsy, record the unsub only on successful subscribe — the v2 admit-race fix), generation-guarded rebind (keep unless M0's synchronous-detach contract provably obviates it), memoized handle behind the default-read swap rule (only when `read` is untouched; the v2 M3 leak). Guarantee, monitored: progressive fill; once visible, a key never vanishes while its data exists anywhere (the H6 monitor).

**Owner-scoped scalar folds** (`sum, length/count, max, min, avg, some, every` with serializable specs): disjoint owner-scoped partials, combine rules ported (`?? 0` never `|| 0`; avg folds {sum,count}; empty `every` ⇒ true). **Defer-while-acquiring** (D2/J1 graft): a member with any owned partition mid-latch answers `{defer: 1}`; the coordinator re-polls ≤ 3 times on the retry cadence, then **falls back to the rows-gather folded locally** (D3's always-correct path, kept for churn), and only then rejects typed. Live scalar folds withhold pushes while acquiring (last-good stands; eventually correct). **Holistic ops** (`az/za, top, limit, group, distinct, reduce`) and closure-argument specs: **throw `ScopedError` synchronously** — v2's console.warn + local partial is not ported anywhere.

**Seams**: new `v3/api/fold.ts`; api/index.ts:113-118/:144/:187/:191-219; methods.ts:158-168/:192-232; env.ts rpc `to`.
**Bounds**: registry O(keys × claimants ≤ R); ×R claim redundancy on the wire is the stated price of zero-claim immunity; per-update cost O(delta).

### C9 — `cluster.partitions` + ScopedError

Bounded, locally-derivable (no gossip of peers' held-sets; partition→holders rows are keyspace-unbounded — rejected). Folded inside the composer's FOLD branch (api/index.ts:211-219; JK 59-63 join FOLD at :187); `ClusterShape` (api/types.ts:98-104) gains the key, re-exported at index.ts:242:

```ts
partitions: {
  replicas: number,          // 0 = unscoped
  epoch: number, w: number,
  held: number, acquiring: number, orphaned: number,   // scope-map tallies
  acquired: number, shed: number,                      // lifetime counters (rates/alarms, not firehose)
  shedWaitingOn: string[],   // uuids currently pinning any orphan's shed (≤ view size) — the H7 surface (J2/J3 graft)
}
```

```ts
export interface ScopedError {
  scoped: true                    // wire/rehydration discriminant
  op: string                      // 'group' | 'top' | 'gather' | 'get' | 'predicate' | …
  reason: 'holistic' | 'closure' | 'unreachable' | 'timeout' | 'shortfall'
  replicas: number
  partition?: string
  missing?: string[]
  hint: string                    // "materialize first: methods.read().group(…) — or define a derived resource"
}
```

Defined beside WriteReject (api/types.ts:29-34), thrown with the `satisfies` idiom (api/index.ts:127 precedent), re-exported (:242). **Wire rehydration**: `Caller.#onResult` (methods.ts:239-250) — a RESULT error value carrying `scoped: true` re-throws as-is instead of the `new Error(string)` wrap at :249; Host replies it as the RESULT error value.

---

## §2 The seven hazards under the final design (each a named sim scenario)

**H1 — orphan crashes mid-shed.** Crash before shed step 1 (boot write): restart sees p ∈ heldPartitions, ring says non-holder ⇒ re-derived frozen orphan at replayed (≤ pre-crash) tails; marks re-accumulate via the poll; the stateless predicate re-fires ⇒ re-shed. My own stale higher marks at peers are voided by the incarnation bump (forget). Crash after step 1: replay's boot gate skips p's rows (advancing applied/chain only) ⇒ boots shed-complete — sound because the predicate had already proven every current holder covered before the boot write. Non-durable orphan crash: total refold; its copy vanishes, but a confirmed record's other copies survive (shed elsewhere still requires all current holders; simultaneous loss of ≥ W holders is the stated fault bound). Never wedges: there is no cross-life shed state to corrupt.

**H2 — {A,B}→{C,D}→{A,D} before shed-confirm.** At e2: A,B freeze + poll; C,D latch teachers, stage, announce nothing, count for nothing. The e3 install aborts all latches (buffers dropped — nothing was folded) and clears every entry's epoch-scoped marks. C: if its log holds own-lane e2 commits (it was owner while acquiring), it becomes an **orphan** (abort-at-descope-with-residue rule) — it possesses those records, announces their marks, teaches them, sheds when covered; else `out`, no residue. Those e2 commits were never falsely confirmed: W={C,D} required D's marks, and D never folded ⇒ the probe never fired. A: ring-held again ⇒ `orphan → acquiring` (delta above frozen marks — never straight to held; teachers: C's orphan lanes, B, or D). B: still orphan; its predicate now quantifies {A,D} at e3 — shedding on any e2-era confirmation is unrepresentable (marks died with the epoch). Every state re-derives from (current ring, local data, current marks); no protocol state crosses the flips.

**H3 — two-teacher resurrection (the log.ts:31-39 residual — closed, scoped).** Cell X: update(o,10), remove(o,20), tombstone GC'd cluster-wide pre-join; T1 uncompacted, T2 compacted. The learner's AE plane is silent for p (never announced); the latch admits one teacher's ACQ only (foreign ACQ → stageDrop; a previous aborted attempt's frames died with its buffer). Teacher=T1: fold holds both records ⇒ election settles removed. Teacher=T2: cut ≥ 20; the fold holds neither; post-fold `parts.s = cut` floor-drops any straggler 10 or 20 (effect-covered: T2's compaction was lawful ⇔ the then-holders' quiescence already materialized the remove as absence). Teacher dies mid-ship ⇒ buffer dropped whole (a half-prefix is unrepresentable — the fold is atomic), re-latch. New GC cannot outrun the window: an acquiring holder contributes 0 to per-(o,p) quiescence ⇒ the pass blocks (the named invariant + expected-empty monitor). Staged live cannot smuggle the mix in: non-teacher staged records ≤ cut are discarded at the fold (the floor). Mutation test: deliberately fold a second teacher and assert `converged()` catches it; then the real path stays empty across the sweep.

**H4 — (A,B)→(B,C), owner moves, holder sets overlap.** B was continuously held ⇒ stays `held`, no re-acquisition (no-bypass is a rule about *entering* held). B re-sequences: e2 commits stamp under B's lane (owner = holders[0]; single-writer-per-(partition,epoch) monitor untouched — the epoch changed). Lane-A's (A,p) sub-stream retires. C acquires (one teacher — B preferred as owner-announcer, or orphan A). A freezes, polls {B,C}: B's marks already cover (it ingested A's lane live, FIFO); C covers post-fold + post-fold round. In-flight e1 attempts at A: `NACK stale-epoch`/`not-owner` (write.ts:398-402 unchanged) ⇒ issuer re-resolves to B with refreshed ae.

**H5 — confirmed-write-loss window.** Claim: a `replicated`-ok answer implies ≥ W current-R-set copies at answer time, and no needed copy is destroyed before all R current holders possess it. Post-handover records: confirm counts handshake-attested per-(o,p) marks over `holdersOf(p, e_now)` — acquiring peers attest nothing; interior holes can't be counted (marks are floors, and `d[o]` is never evidence). Pre-handover (frozen) records: the only destruction path is shed, gated on every current holder's attested marks ≥ the orphan's frozen tails, per lane, at the current epoch, inc-fenced. So at every instant a confirmed record has either its old copies (orphans unshed) or ≥ W new folded copies — and a confirm that can't be evidenced simply never fires (confirm.ts:31-34). Honest residual (plan-bound): evidence is shippable per §5 verbatim — if all R holders are non-durable and crash simultaneously post-shed, the prefix is lost; that is R-replication's stated strength (durable-marks shed refinement → IDEAS).

**H6 — Q3a: live gather during grow-past-R.** Ownership of p moves A→C at the grow install. A freezes but **keeps claiming** (scope = held ∪ unshed-orphan; descope is silent — no retraction exists to race). C's claims appear post-fold with identical-or-newer stamps (idempotent merge). A sheds only after every holder (C included) attests coverage; at A's shed-rescope the coordinator clears A's claims — if C's subscription is still in flight (admit race, severed subscribe frame), the key's claimant set empties ⇒ **parked, value stands** ⇒ never absent. A real remove leaves only via a dominating tombstone claim; a tombstone-GC'd remove clears its parked ghost via the coverage sweep once the full holder set has answered and stays silent. Monitor (scenario-local, `sim.monitors` exec.ts:74): after every event, no key present in the previous union is absent from the current one while any node's `node.state` holds it — swept 0-999 per the build-map §D plan (mid-trajectory `sim.add`, `sim.at`-timed growth, `storeFault` delay on the learner, `severOnFrame` on the subscribe frame, `--capture` on failure). Committed as the regression.

**H7 — a laggard pins a shed.** The bar is frozen (fan-out excludes orphans; new commits live in new-owner lanes the orphan doesn't hold), so write load cannot extend the window — only the laggard's own throughput can. Handshake re-offers every SHED_TICKS ship exactly the per-(o,p) gap. A dead laggard is bounded by suspicion→eviction (membership.ts SUSPECT_TICKS=3) ⇒ new epoch ⇒ the predicate re-ranges onto the replacement. A live-but-slow holder pins indefinitely — the honest CP price, **surfaced, never silent**: `JK.shedStall` at escalating cadence + `cluster.partitions.shedWaitingOn` naming the uuids + `orphaned` sustained non-zero.

**Crash/partition-window matrix** (D3's table, adopted as the slice-3 scenario checklist — every row a named sim schedule): 1 owner dies pre-fan-out (unconfirmed; honest loss/durable replay) · 2 partial fan-out, owner dies (holders heal via handshake/AE; confirm waits for W marks) · 3 view flips mid-replication (freeze + predicate + acquisition) · 4 shed crash between boot/purge/snapshot (H1 both sides) · 5 learner crash mid-ACQ (boot purge → re-acquire) · 6 teacher crash mid-ACQ (abort whole, re-latch) · 7 view flip mid-ACQ (epoch abort; residue→orphan) · 8 ACQDONE races persisted echoes (held only after echo) · 9 old-epoch fan-out hits a non-holder (gate-drop; no evidence forged) · 10 AE/cross-link overlap (dual fence + splice) · 11 lost WACK to a scoped issuer (retry → dup-ACK original coords → `acked`) · 12 reborn holder claims old marks (`scope.forget`) · 13 orphan partitioned away (shed waits, surfaced; claims stamped/superseded) · 14 GC vs mid-acquisition holder (contributes 0 ⇒ quiescence blocked).

---

## §3 Journal vocabulary (append after `rpcFail: 58`, journal.ts:87; 3-scalar JEvent cap respected, :91)

```ts
//! ── M6 scoped-replication vocabulary ──
shed: 59,          // a=partition, b=droppedEntries — every current holder attested; data left this node
acquire: 60,       // a=partition, b=entriesFolded, c=teacherUuid — atomic one-teacher fold committed
orphaned: 61,      // a=partition, b=epoch — held data left the R-set at install; freeze begins
acquireStart: 62,  // a=partition, b=teacherUuid — one-teacher latch opened
acquireAbort: 63,  // a=partition, b=reason ('linkDown'|'epoch'|'overflow'|'reborn'|'torn'|'timeout')
teachShip: 64,     // a=partition, b=entries — teacher-side ACQ transfer
gateDrop: 65,      // a=origin, b=seq — non-held record dropped at the inbound gate (skew window; expected-rare)
stageDrop: 66,     // a=partition, b=seq — non-teacher backfill dropped during an open latch (expected-rare; monitored)
shedStall: 67,     // a=partition, b=ticks — H7 alarm at escalating cadence, never silent
```

FOLD-set additions (api/index.ts:187): 59, 60, 61, 63. No `shedInvalidated` kind: the stateless decision stores no confirmations to invalidate, and frozen orphan tails cannot bump — the journal story is `orphaned → (shedStall)* → shed`.

---

## §4 Per-slice landing plan (5 slices; every gate includes the 1000-seed / 237,451-event unscoped byte-identity re-verification — README.md:32/:422, `sim/run.ts` stays R-off per C12)

**Slice 1 — ring completion + partitions surface (pure projection, provably inert).** `holdsAny` + `#holdersCache` on Ring (ring.ts:54/94-141 — `holdersOf`/`place` already landed); the scoped-arming predicate (`scoped ∧ epoch > 0`); `cluster.partitions` scalars (zeros/`replicas: 0` unscoped) + `ClusterShape` + `ScopedError` type exports. *Gate*: ring.test.ts determinism/dedup/pin/degeneracy for the cache; identity sweep; `ring.perf.ts` case (memoized lookup ≈ Map.get).

**Slice 2 — evidence plumbing (still inert).** `parts` on StreamDescriptor + all advance sites (write.ts:492-500, node.ts:517-518, `#inflight` split node.ts:542-551/:590, persisted echo :260-270); the §0 scoped ingest law (dual fence + membership splice) landed scoped-gated with direct unit tests (cross-partition AE interleave; splice; floor); the no-interior-rows WAL rule + snapshot arming + the **interior-row replay test** (prove a splice survives crash-after-snapshot and heals crash-before); replay boot-gate (advance-applied-skip-fold) unit-tested against mixed and shed-then-crash rows; `Probe.part` + scoped confirm counting (evidence stubbed until slice 3); scoped frontier/GC range functions (member-ranged verbatim when off); `BootRecord.heldPartitions` field + restore threading (unwritten while unscoped). *Gate*: unit suites green; identity sweep (no digest surface exists to diff — re-run anyway); write.perf/node.perf thresholds unchanged with scoping off (structural: one predicted-false branch), judged A/B per the WSL2 memory note.

**Slice 3 — the core (two commits, one slice).** *3a (freeze first — shed without confirmation is not landable)*: scope.ts skeleton (held/orphan derivation hooked after membership.ts:385), fan-out filter (node.ts:519-525), inbound gate, AE announcement-gating (node.ts:891-901 + `link.announced`), orphan freeze; monitors — exactly-R shadow oracle (per-event lawful holding; shed-event coverage assertion; horizon form), orphan-frozen (expected-empty), state-machine legality (no held→out→held bypassing acquiring), acquiring-pins-GC (expected-empty), R-scoped `converged`/`confirmedIntact` (monitors.ts:226/:256 variants); static-membership scoped scenarios. *3b (handover)*: HAVEQ/HAVEA/ACQ/ACQDONE + dispatch, latch/staging/floor/fold + post-fold round, stateless shed + persist ordering, `scope.forget` (node.ts:712-716), confirm evidence activation + probe-driven re-offers, boot classification + replay gate wiring, journal 59-67. *Gate*: H1-H5 + H7 named schedules; the **14-window matrix** as scoped.test.ts scenarios; mini-sweep `cluster(sim, 5, {heartbeatMs: 50, replicas: 2})` with seed-drawn faults, partition/heal, `sim.restart` churn (re-apply ring pins); the shed-vs-stateless-recompute equality monitor; identity sweep.

**Slice 4 — api.** Facade (scoped-only) + remote Handles; `rpc.to` member routing + server-side Caller; `acked` sink + Bind joins + non-held overlay policy; `shedPartition` subtree remove (healRoot fallback); `fold.ts` — claims partial, per-key stamped merge + parking + coverage sweep, one-shot + live + reconcile, scalar folds + defer-while-acquiring + rows-gather fallback, read-swap rule (memoized); ScopedError rehydration (methods.ts:249); `cluster.partitions` fold + `shedWaitingOn`. *Gate*: meaning-equivalence tests (same expression, R=2 vs R=∞ — same value or typed error, never a divergent silent answer); gather correctness under scripted churn; identity sweep.

**Slice 5 — the Q3a hunt + validation.** The H6 scenario + no-vanish monitor as the committed regression (build-map §D verbatim: mid-trajectory `sim.add`, deliberately widened windows via `sim.at`/`storeFault`/`severOnFrame`, seeds 0-999, `--capture`); ad-hoc 150×5 chaos sweep for the commit message (M4e/M5b precedent); final identity re-verification; DECISIONS.md record (including the digest-size trade note: handshake-carried evidence chosen over per-(o,p) digest growth, with D2's frame shapes as the record) + lift the residuals below into the IDEAS scoped-replication workstream; regenerate + commit `readable/`.

---

## §5 Rejected alternatives (one line each)

- **Per-(o,p) marks piggybacked on the DIGEST** (D1/D3) — O(held pairs) on every heartbeat forever = v2's fat-digest cost; the handshake carries identical evidence priced at churn (the perf judge's decisive point).
- **Stored `shedReady` confirmations** — a set you must remember to clear; stateless recomputation makes both invalidation clauses enforcement-by-construction.
- **Feed-orphans-until-shed** — the shed bar chases live load; H7 becomes the common case instead of the surfaced corner.
- **Ungated dual fence / walTail row-maxSeq replay change** (D3 as written) — alters the R=∞ ingest/replay path; fatal on the identity gate (two judges); everything here is `node.scoped`-gated and the WAL never holds interior rows.
- **Trusting digest `d[o] ≥ seq` for scoped confirm** (D2 §7.2) — provably overclaims past an interior hole under partition-filtered multi-source shipping; handshake marks only.
- **Empty-as-known → from-zero multi-source AE** (D3's C8 fallback) — reopens the two-teacher resurrection it was built to close; one teacher, always.
- **Splice-ACQ-directly-with-purge-on-abort** (D3) — needs a partition purge primitive and exposes half-fold windows; stage-then-atomic-fold is smaller and the abort is a buffer drop.
- **Per-scope replacement for `link.synced`** — unnecessary; the whole-link bit keeps its FIFO-hygiene job and scope.ts *is* the per-partition sync state.
- **Ring-only acquisition scoping on the AE answerer** (D2) — ships suffixes to acquiring nodes (the promiscuous-stage hole); possession announcements (HAVEQ-fed `link.announced`) gate it.
- **Root-replace gather union** (D2) — coordinator-side zero-claim under cross-link reorder survives the member-side fix; per-key stamped merge + parking.
- **Owner-preferred gather fold** (D1) — an acquiring owner's empty claim outranks an orphan's data-backed claim (a judge-proven zero-claim leg).
- **Pure descope-silent merge without parking/coverage** (D3) — a tombstone-GC'd remove leaves an immortal ghost claim.
- **Typed throw on non-held `data[key]`** (D3) — violates §9's "data.get always works"; remote Handle instead (typed throws stay for holistic ops + gather shortfall).
- **Synthesized `undefined` / frozen ghost for non-held reads** — a wrong answer; banned by §9.
- **partition→holders rows in `cluster.partitions`** — unbounded in the keyspace; bounded local scalars + `shedWaitingOn`.
- **Ring-recompute-only restart (no heldPartitions)** — replay cannot classify WAL rows across a shed-mid-crash; data authority must be durable.
- **Configurable W** — derived majority of the R-set only; a knob here is a foot-gun against the confirm ladder's meaning.
- **Kernel gather verb** — re-implements the method plane's routing, reaping, retry, and failover.
- **Re-encoding held subsets of mixed skew frames before WAL** — a hot-path copy for a transient window; replay gate + snapshot purge instead.

## §6 Open residuals (honestly deferred; tracked in IDEAS.md → "Scoped replication" workstream unless noted)

1. **Live-but-slow holder pins a shed indefinitely** — surfaced (`shedStall`, `shedWaitingOn`), CP-priced; operator tooling beyond the journal is M7's.
2. **Oversized-partition transfer economics** — the base transfer is memory-bounded by the partition itself and a view-flip storm re-ships it; chunked/streaming folds with resumable cuts → IDEAS.
3. **Handshake fan-out at mass rescope** — O(co-holders) frames per churn event after batching; delta-compression of HAVEQ bodies → IDEAS (DECISIONS records the digest-vs-handshake trade).
4. **Unscoped log.ts:31-39 residual** — the R=∞ fresh-fold two-teacher race is *unchanged* by M6 (its closure is scoped-gated by the identity constraint); stays documented in the log.ts banner; a future gated opt-in of the dual fence at R=∞ → IDEAS.
5. **Shed evidence is shippable, not durable** (plan §5 verbatim) — all-R-non-durable simultaneous crash post-shed loses the prefix; durable-marks shed refinement for durable clusters → IDEAS.
6. **One-shot gather is a documented snapshot union** — monotonicity is the live gather's promise (same staleness class as R=∞ multi-replica reads); wire-optimal disjoint Σ-partials need epoch-fenced disjointness → IDEAS.
7. **Subscription-scoped spoke tap-forward** (only-what-you-watch) → IDEAS; a spoke today mirrors its primary's held shard + gather-backed wholes.
8. **Offline-first durable clients** — already rejected loudly at fero() (api/index.ts:53); unchanged by M6.
9. **Remote-Handle ergonomics** (failover policy defaults per handle, handle caching) — M5 Handle machinery reused as-is; polish → IDEAS (api workstream).

---
**File targets**: new `v3/kernel/scope.ts`, `v3/api/fold.ts`, facade in `v3/api/data.ts`/`index.ts`, `v3/sim/scoped.test.ts`; enumerated seams in ring.ts, streams.ts, write.ts, node.ts, membership.ts, confirm.ts, log.ts, env.ts, journal.ts, codec.ts, link.ts, monitors.ts, harness.ts, api/types.ts, api/index.ts, api/methods.ts. Implementer decisions remaining: none intended.