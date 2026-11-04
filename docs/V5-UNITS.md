# Where partitions live: shards that split, 64 lanes, 16 fixed, or slots

A judgement on DESIGN-V5 decision 20, written 2026-11-04 against DESIGN-V5.md and V5-PRIMITIVE.md.

**Verdict in one line:** take option 4 as *slots per resource, groups per resource*: 1,024 fixed slots per resource, one Raft group per resource to start, a per-slot sequence on every record, and one move mechanism (fence, copy, open) for scale-up, scale-down, rebalancing and hot slots. Delete splits and merges.

## 1. The plain explainer

**What is a Raft group?** Three copies of one log on three machines. They vote for one leader. The leader writes records in order, and a write counts once two of the three have it on disk. One group means one writer, one commit queue, one election, one snapshot and one block of memory. A group is the unit of *cost*. A partition (a row, or a room) is the unit of *order*: what users see. A group holds many partitions so they share one fsync and one election. So the real question is: how many cost units, and how do partitions move between them without anyone noticing?

**Are lanes just 64 shards per project?** Yes. A lane is a shard every resource shares. The differences from the draft: the count is fixed, and a resource no longer owns its groups.

**Does that move the problem to the project level?** Mostly, yes. A project can never have more than 64 writers, so write speed stops at 64 cores. Every resource rides every lane, so one slow or failed lane touches 1/64 of every resource at once. And past 64 lanes you must move key ranges between groups, the very mechanism lanes were meant to avoid, only later and under pressure. Lanes also make `copies` and durability project-wide.

**When do you need more or fewer groups, and what happens?** More when one leader's core, disk or memory is full: in TypeScript about 150k writes a second, and a few GB, per group. Fewer when groups are so small their fixed cost (election, snapshot, memory) is waste, or when servers leave. Then: option 1 splits (no copy) but cannot merge until phase 5. Option 2 does nothing until 64 is passed, then moves key ranges. Option 3 does nothing until a library copies the whole resource into a new one, breaking every cursor. Option 4 moves one slot's rows, once.

**Does the number matter, if it is hidden and dynamic?** The *group* count should not matter and should not be fixed: it is a cost unit and should follow load. What must stay fixed is the *names* that cursors and versions use, because renaming is what breaks cursors. So: fix the names, free the groups. That is option 4.

**Why 16 and 64?** Round guesses: 16 is "the cores of one box", 64 "a few boxes". Neither is measured, and both fix the cost unit, the wrong thing. In option 4 the magic number is the slot count, where being wrong is cheap: it only caps a resource's groups and the size of a whole-resource cursor.

## 2. The table

| Criterion | 1. Shards that split | 2. 64 lanes | 3. 16 fixed | 4. Slots + groups |
|---|---|---|---|---|
| Scale up; limit | no limit; a split copies nothing | 64 writers per project; then move key ranges (phase 5) | 16 writers per resource; then re-key the whole resource | up to 1,024 writers per resource; a move copies one slot once |
| Scale down | merges, phase 5 | lanes move to fewer servers; never below 64 | never | the same move empties a group, which is deleted |
| Mechanism; published? | split entry, shared term, lineage, inherited state: novel; merges "took years" | move whole lanes (MongoDB, Pulsar); range moves later (Vitess) | copy-and-flip library; no kernel code | slot move (Redis Cluster, Couchbase vBuckets, Kafka reassignment) |
| Novel rules | about 8 | 2 now; option 4's later anyway | 1, at L5 | 3: slot sequence; fence/open with carried state; group create/delete |
| Cursors on a move | per-group offset; lineage forever | per-lane offset; lineage in phase 5 | `unknown-log`; restart from a snapshot | (slot, seq): nothing to resolve |
| Dedup, fences, in-flight | inherited by children, filtered | untouched until phase 5 | a retry across the flip is a duplicate unless the library carries outcomes | carried with the slot; `moved` names the new group |
| Blast radius, one leader crash | one resource's slice | 1/64 of every resource | one resource's slice | one resource's slice |
| Tiny project; sleep, wake; hosted | R groups for R resources | 64 groups and 64 log replicas per free project | 16R groups | R groups |
| Hot partition | one writer | one writer; its lane is a noisy neighbour to every resource | one writer | one writer; a hot slot gets a group of its own |
| Per-resource `copies`, `durability` | yes | `copies` project-wide; `none` and `persisted` share a log | yes | yes |
| Changes to the draft | none | deletes splits; adds a lane table and project `copies`; a fork is 64 forks | deletes splits; adds the re-key library | deletes splits, merges, lineage, the 10,000 pin; adds the slot sequence, slot table and move |

## 3. The verdict

**Option 4, slots per resource, groups per resource.** The shape:

1. **`slots`: 1,024 per resource**, fixed at create (Couchbase's 1,024 vBuckets). A partition hashes to one slot forever; users never see slots.
2. **Groups follow load.** Every resource starts as one Raft group holding all 1,024 slots, as the draft's one starting shard. A **slot table** (slot → group) sits in the resource's `#meta` record as a hint; the truth is the fence and open entries in the groups' own logs.
3. **A per-slot sequence on every record.** The writer keeps `lastSeq` per slot in the group's state (≤1,024 small integers) and stamps each record with its slot's next number. The slot id is the hash of the key, not stored. Cost: one varint per record. Then a row's **version** is (slot, seq); a **cursor** is a sparse map slot → seq; a **fence token** is the lock's (slot, seq), monotonic across moves because a lock is one row, so one slot; **`none`** cursors still carry the group's term and resume at `latest` after a move, as after a new term today.
4. **One move mechanism**, pull-style as Redis Cluster's IMPORTING. B's leader appends `importing(slot, from A)`. A's leader appends `fenced(slot, to B)` and from then answers `moved(B)` for that slot, and streams the slot's rows at the fence (cut from the copy-on-write fold) plus the carried state. B appends `open(slot, seq N)` and serves. Vitess-style, B copies from an earlier snapshot first and takes only the delta after the fence, so the slot is unwritable for about one round trip: the draft's handover budget. A crashed leader on either side resumes from its own log; a cancel at A needs B's `abort` first. The TLA+ property is one sentence: *at most one group has a slot open at any time*.
5. **Carried state per slot** is what the split already inherited: the rows and `lastSeq`; per issuer, the committed outcomes for that slot; each issuer's highest call id, merged by `max` at B (ids rise globally, so a higher floor is always safe); the highest token per lock. Without the `max` merge a late copy of a committed write could land as fresh at B: the one trap, and option 3's library has it too.
6. **The group rule**, the only automatic policy, run by each group's leader as healing is. Over `group.bytes` (4 GB) or `group.rate` (half the leader's measured capacity): create a group (one `#meta` record; healing places it by the ring) and move half its slots there. Under a quarter of both for `settle.ms`, and not the resource's last group: move its slots to the smallest sibling and delete itself. One move at a time per resource, by a lease row in `#meta`. The planner may say `move(slot, group)` and `group(resource, n)`, checked like any hint.
7. **Phasing.** The header, versions and cursors take the slot shape in phase 1, before any move exists, so nothing changes shape later. Phases 2 and 3 run one group per resource. Moves land in phase 4, where splits were planned; shrink comes free. Merges and the phase-5 cut-over leave the plan. Option 3's re-key stays as an L5 escape hatch.

**Why not the others.** Lanes delete splits today but keep the hard part for phase 5, cap writers at 64, couple every resource's availability, take away per-resource `copies`, and smear a ten-row resource over 64 groups. Option 4 is lanes with the count free and the names fixed. Splits copy nothing, their one advantage, but are a second novel protocol with no merge yet, in the layer where every critical review bug lived. Sixteen fixed is the honest fallback, but the re-key breaks cursors, risks duplicates, never shrinks, and costs 16 quiet groups per resource.

**Cursors, concretely.** Today a cursor is (group incarnation, offset), so a move needs lineage: a reader at (A, o) whose slot s moved to B at offset Y must re-read B from Y filtered to s while continuing B from its own offset for the rest. Per-slot sequences remove that. A room follower holds one entry: (slot of room42, seq). A Kafka-style reader of a whole resource holds one entry per slot with records: at most 1,024, about 8 KB, sent once per subscribe, against 64 under lanes. A per-*partition* sequence is not needed: the slot is what moves, so the slot is the right level.

**What it costs.** One varint per record. A per-slot index in segments and snapshots. Whole-resource cursors up to 8 KB. Data copied once per slot move, paced. One two-phase protocol to model, smaller than splits and needed by every option that ever scales past a fixed count. Quiet groups cost what they cost today; lower the idle pin from 10,000 to 2,000.

## 4. What DESIGN-V5 would change, by section

- **§1.** "Shards split by size and load" becomes "each resource starts as one group over 1,024 fixed slots; groups come and go with load, and slots move between them one at a time, with cursors unchanged."
- **§2.** Add **slot**: a fixed hash bucket of partitions, 1,024 per resource, the unit that moves. **Shard** becomes **group**: a set of slots with one log and one leader. **Version** becomes (slot, seq). Drop `shards`; add `slots` (create-time only).
- **§4.1.** The per-partition segment index becomes per slot. In the drop rule, "no split child still needs it" becomes "no slot move in progress needs it". Snapshots carry the slot table and `lastSeq`.
- **§4.2.** Delete "Splits" and the `split` hint. Add "Slot moves" (fence, copy, open; carried state; `moved`) and "Groups" (create, delete, the group rule, the move lease). The split row of "Scaling up and down" becomes "a group gets big or busy: it adds a group and moves slots; a small group empties itself". In "What stays limited", row 7 drops to 2,000 and a row adds "at most `slots` writers per resource". Healing is unchanged.
- **§4.3.** The header gains the slot sequence. Dedup outcomes are per (issuer, slot); the issuer's highest call id merges by `max` on a move. Versions are (slot, seq).
- **§4.4.** The cursor is "the cluster id, the resource's incarnation, then slot → seq", with no lineage. A whole-resource subscription is served per group, each filtering to its slots.
- **§5.3, §6.2.** A fence token moves with its lock's slot. A fork names one snapshot per group.
- **§8.** Add a pin: slot move, unwritable window about 10 ms. Note +1 varint per record.
- **§10.2.** "Splits as one entry, with lineage" becomes "slot moves, with per-slot sequences". The TLA+ property becomes "a slot is open in at most one group, and its sequence never goes back"; model 2 groups, 1 slot, crashes on both sides, a stale planner.
- **§11.** Phase 1: the slot header and cursor shape. Phase 4: moves, in place of splits. Phase 5: merges and the lane cut-over are gone.
- **§12, §13.** Decision 20 gains (d), this pick. Decision 7 becomes "one starting group over 1,024 slots; `group.bytes` 4 GB, `group.rate` half of measured capacity". §13 records this as the third view: splits go; lanes fix the wrong number.
