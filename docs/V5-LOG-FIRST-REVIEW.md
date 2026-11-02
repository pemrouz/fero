# v5 log-first: a second opinion

The same independent reviewer as [V5-REPLICATION.md](V5-REPLICATION.md), asked to critique the log-first rewrite of [DESIGN-V5.md](DESIGN-V5.md) (commit 75128c1). Saved as written; DESIGN-V5 answers its conditions in the draft after it.


**Verdict in three lines.** The skeleton is sound: seal-then-CAS is the right fence, and Raft + BookKeeper loglets + a Delos chain is a published, checkable trio (Neon's safekeepers and Pulsar-over-BookKeeper are this shape in production). As written it is not ready for phase 1: recovery is under-specified exactly where BookKeeper's real bugs lived, two actors reconfigure one loglet, and splits/merges in phase 2 re-create the "many interacting mechanisms" problem. Take it over (b) only if the hosted shape is the primary product; for a self-hosted library, (b) is still the cheaper, safer kernel.

## 1. Critique: failing or under-specified sequences

**F1. Recovery counts "unknown" as "absent".** E=3, Q=2. Writer S1 commits batch 1499 on {A,B}; C never got it. S1 dies. S2 seals; A and B answer (E−Q+1 = 2). S2 reads forward: B answers 1499, A times out. §4.2 says "stops at the first batch none of them holds": counting A's silence as not-holding closes the chain at 1498, below a committed batch. Vanlightly's BookKeeper TLA+ work found this class (negative vs. unknown answers in recovery). Rule: a batch is absent only when every node in the seal set answers "no entry"; a silent node means re-seal wider, or wait.

**F2. What is "committed" on a sealed, unclosed loglet.** Recovery re-writes batches to Q before the CAS closes the chain. A follower that "falls back to reading the log nodes" (§4.4) can see 1499–1500 on B and C after S2's re-write while a rival recoverer's CAS closes at 1498. L-06 asserts readers see only committed records, but nothing says how a reader learns the committed point once the writer is gone. Rule: the writer's last stamped committed point on an open loglet, the chain's recorded end on a closed one, nothing in between.

**F3. Two reconfigurers.** Log node C's session lapses: the controller "seals its open loglets and re-opens them on other log nodes" (§4.2). The writer S1, seeing C time out, also seals and CASes a new loglet (BookKeeper's writer-side ensemble change). Safe by CAS, but both run recovery and pick ensembles, and the loser must re-read the chain and replay in-flight batches. One actor: the writer changes its ensemble; the controller changes writers.

**F4. Planned close racing a failover.** S1's planned handover "seals its own loglet at a known end, with no recovery" while the controller, seeing S1 slow, assigns S2, which seals and recovers. If S1's close is a plain metadata write rather than a CAS on the chain version it saw, S1 can overwrite S2's end. Say: every close is the same CAS, and a loser adopts the winner's end.

**F5. Splits "at offset X".** A seal cannot choose its offset; only the writer can stop at X. If the writer dies mid-split, recovery fixes X′≠X. Children must start at (recovered end)+1 in the same CAS that closes the parent. And "children inherit the parent's snapshot at the split": no snapshot exists at exactly X; a child's cold start is the parent's latest snapshot ≤X plus the parent's tail to X filtered by the child's hash bit, so the parent's loglets between snapshot and X must be retained until each child has its own snapshot. L-10 glosses this.

**F6. Merges.** "One shard continues both offset ranges" is not one log: offsets restart at max(end₇, end₂₃)+1, cursors on both parents resolve through two lineages, and two dedup windows combine (safe only because the issuer window is global; say so). CockroachDB's range merges took years of split/merge/lease races to settle. Cut from phase 2.

**F7. Snapshot layers vs. deletion.** "A loglet copy is deleted only after it is uploaded or covered by a named snapshot" (L-13): a layer at offset X covers nothing alone; it needs every earlier layer in its chain, and a background merge in progress may still read loglets. Rule: deletion needs the merged base at ≥X named and uploaded.

**F8. The two-machine witness.** "A third, tiny process holding only the metadata" (L-19) needs a third failure domain. On one of the two machines it heals only the *other* machine's crash: v4's one-directional tie-break again (DESIGN-LEAVE §7b). Say where it runs.

**F9. "No data moved between servers" overstates.** A new server folds every shard it stands by (snapshot plus tail: "seconds per gigabyte"), and `standbys: every server, up to 5` means every server folds everything: a Raft learner's catch-up, from S3 instead of a peer. Removed is the follower's disk write, not the copy.

**F10. Writer fan-out.** The writer pushes to E log nodes plus up to 5 standbys plus subscribers: 7 copies per batch where Raft R=3 sends 2. Pulsar's answer is tailing readers on the bookies with long-poll LAC. The default should not be "the writer pushes to everyone".

**F11. Hosted metadata per project (L-22).** One Raft group per project on a shared tier is multi-Raft on the platform side: 10k projects = 10k groups needing quiescence. Delos runs one MetaStore. Name the choice.

**F12. Co-located crash (L-20).** Correct as written (batch on {A(writer),B}; A dies; seal {B,C}; B holds it; re-write). The cost: with E=3 on three co-located processes, every server crash under-replicates every loglet until re-copy. State it.

## 2. Trade-offs versus (b)

| | (b) Raft per shard | (d) log first |
|---|---|---|
| Commit latency | leader fsync ∥ median follower | co-located: equal; separate log tier: +1 hop (0.1–0.3 ms) and no local fsync counts |
| Takeover | never cold: every voter holds the log | warm only if a standby folds the shard; cold = snapshot read + fold |
| Roles | member (+ optional witness) | server, log node, voter, object store; co-located by default, but four code paths |
| Follower reads | free: followers have the log | writer push or log-node tailing (F10) |
| What got simpler / what moved | — | simpler: no per-shard elections; durability independent of server count; sleep, wake and forks are pointers. Moved: catch-up from peers to S3, fencing from terms to seals, membership into chain CAS; ensemble repair (BookKeeper's auditor) is new work |
| Novel mechanisms | 0 in safety | split/merge lineage in the chain, cursor resolution through lineage, controller-vs-writer reconfiguration, snapshot-layer/loglet retention coupling: 3–4 |
| Formal models | raft.tla | raft.tla + Vanlightly's BookKeeper spec; the Delos chain and the splits have no public spec |
| L1 size (TS) | ≈5–6k: Raft 2.5k, multi-raft 0.8k, placement 0.8k, snapshots 1k | ≈10–11k: Raft 2.5k, log node 2k, loglet client 1.2k, chain/handover 1k, object store 0.8k, snapshot layers 1k, splits/merges 1.5k, placement 0.8k |
| Dev-speed risk | one protocol, one sim node kind | three protocols, three node kinds plus a store in the sim, composition to prove; splits/merges in phase 2 |
| Still better at | local dev and self-hosting, follower reads, never-cold failover, no store dependency, fewer words for users | hosted: free-tier durability equals paid, servers disposable for durability, storage scales without moving logs, forks and tapes trivial |

## 3. "Scale up and down without limit and worry": what remains

1. **Memory.** With `standbys` = all, every server holds the whole dataset; adding servers adds clients and CPU, not row capacity. Row capacity grows only with `standbys` < all plus partial follow sets (then reads hop) or the opt-in on-disk state (then reads hit S3).
2. **Fold CPU.** Every standby folds every write of the shards it follows; project write throughput is bounded by one server's fold rate unless servers follow subsets.
3. **One partition = one writer core.** Unchanged.
4. **Metadata rate.** Every seal, CAS, snapshot name and split is a Raft commit. Loglets must roll by size or by writer/log-node change, never by time, or 10k shards saturate the group.
5. **Chain length.** Every writer or ensemble change adds a loglet; chains need trimming as loglets are deleted (Delos does this).
6. **Wake time** = snapshot read from S3: a second for small, a minute for 10 GB.
7. **Shared log tier.** Per-project quotas do not stop fsync contention (Pulsar operators split journal disks).
8. **Under-replication windows.** Between a log node's failure and its session lapse plus ensemble change, batches commit on two copies.

Only 1 and 2 are hidden, by the headline "with no data copied between them".

## 4. Refinements and cuts

- **Cut merges** from phase 2 (merge only empty shards, or defer to phase 5). Land splits after the 1,000-seed sweep is green without them.
- **One reconfigurer per loglet:** the writer changes ensembles (BookKeeper); the controller changes writers.
- **Write the recovery rule precisely** (F1, F2, F4): seal set, "unknown ≠ absent", the committed point on sealed-unclosed loglets, every close a CAS.
- **Followers tail from log nodes** by default (long-poll on the committed point); the writer pushes to subscribers and at most two standbys. Measure first.
- **Snapshots cut by the writer only**, named by CAS, keyed (shard incarnation, offset), put-if-absent; children point at the parent's snapshot and tail until their first own.
- **Co-location (8a) and optional store (9a): yes.** Say plainly that at ≤5 co-located processes cost and durability equal Raft's; the gain is the hosted shape.
- **Witness** on a third failure domain, or documented as one-directional.
- **Hosted metadata:** one group per log-tier cell with project namespaces, or per-project groups with quiescence; name the choice.
- **Skip Delos's log-structured protocols** (SOSP 2021): fero's L2–L4 already are that.
- **No per-shard Raft fast path.** Two L1s double the specs, the sim and the bugs.
- `fresh` reads via a no-op append cost an fsync each; say so.

## 5. Fit

- **fero deploy:** the best fit of any option: free-tier durability equals paid, sleep/wake is natural, "two copies refused" vanishes, a roll is a handover per shard, caught-up is "warm follower". The price: the platform operates a BookKeeper-class storage tier (placement, re-replication, disk balancing, offload) plus per-project metadata (F11), the hard half of running Pulsar.
- **fero test:** excellent. A solo node is the whole stack in process; forks as chain pointers and tapes as resources are exactly right; store completions are already sim events.
- **Local dev:** example 01 works through `leave`; a crash at two processes is read-only without a third-domain witness, as in v4 and (b). `.fero/` grows a journal, entry store, snapshots and a store folder, invisible to the user.

## 6. Recommendation

Choose (d) **only if** fero deploy is the primary product and the author accepts roughly twice the L1 code, a third protocol to model, and a storage tier to operate. Otherwise (b): below the hosted tier, co-located (d) is Raft with more parts. Both keep L2–L5 unchanged; the choice is about hosting and ops, not fero's surface.

If (d), these must change before phase 1: (1) the recovery rule of F1/F2/F4, written as the TLA+ property it is; (2) one reconfigurer (F3); (3) splits recorded as recovered ends, merges cut (F5, F6); (4) the retention rule of F7; (5) the follower read path decided (F10); (6) the witness domain (F8) and the hosted-metadata choice (F11); (7) the "no data moved" sentences rewritten as F9 states; (8) L-cases added for F1, F2, F3, F5 and F7, each a named test. With those, the skeleton is one I would sign off for phase 1.
