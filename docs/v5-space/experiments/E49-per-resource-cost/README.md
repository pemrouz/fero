# E-49: how the overhead of a resource grows, in the chosen design

**Question (Q-49).** The owner dropped the study's 100,000-resource target (V5-2, consequences): "I think exact number instead we can discuss how overhead scales per resource later on". The owner expects mostly fixed resources (users, events, orders) plus derived ones: tens to low thousands per project, 100,000 the extreme. So this page gives a **curve, not a pass or fail**: what one more resource costs, on 3 machines with 3 copies, at R = 1, 10, 100, 1,000, 10,000 and 100,000 resources, and where the cost bends.

**What changed since E-36** (which measured MIN with a project-wide `#meta`):
- No `#meta` catalog row. Each resource's settings, slot table and group records are records in its own **home group's** log (V5-2 (2)).
- 4,096 slots per resource, not 1,024 (V5-2; LAYERS 2.5).
- A **soft-directory** entry per copy, as v4's `#directory` keeps them (V5-3).
- A **genesis per resource**: a create-if-absent of the resource's id in the object store, then founding its home group (SIMPLICITY 3.2, `genesis-conditional-create@per-resource`).

**Threshold.** None (no target is set). The page names the knees and the cheapest forms that stay inside V5-2, with what each costs in rules.

**Checked.** A skeptic's check found 17 problems; this page carries the fixes. The main ones: the first boot runs used a preferred-leader start campaign the base does not have, so the base's own boot (Raft's random timers) is now measured beside it; DEP-13's "an empty copy ≤ 100 MB" is now checked; and a member restart's hand-back time, garbage-collection pauses, the directory on every seed and on a link death, and the genesis run alone are now priced. The new runs are [boot.mjs](boot.mjs) and the `boot`, `gc`, `dirdrop`, `genesis` and `limits` targets in [run.sh](run.sh). A re-check of those fixes found 11 more; this page carries them too. The main one: DEP-13's reading "once V8 has collected" was taken too early at 1,000, before V8's own shrink, so the `settled` target now reads memory 40 s after the collection, at 500 to 3,000.

## The answer, first

A small resource is one Raft group (its home group) plus a few small records, so its cost is mostly the group. **Idle, a resource costs each member about 5.4 KB of live memory in TypeScript (measured; 3.1 KB of it the group), 1.5 KB more on each machine that serves as a seed directory, 0 frames and no CPU you can measure; with its group dormant, about 1.2-2.4 KB; with everything dropped to disk, about 140 B; active, the idle cost plus its rows (about 300 B per small row) and its share of the write path.** Resident memory is larger than live memory, and it depends on when it is read: for the first 20-50 s after each boot about 28 KB per idle resource at 1,000-2,000, 19 KB at 10,000 and 15 KB at 100,000, then about 6-8 KB once V8 has collected (the group's measured RSS in a live cluster, plus the other parts' 2.7 KB). The drafted forms cost far more: 120 KB per resource with a dense typed-array slot table and dense per-slot state (about 284 KB with a row per slot), and 12 KB of disk and 3 inodes with a set of files per group (measured). The cost grows in a straight line with R; only v4's directory as written grows faster.

Two costs already show inside the owner's likely range (tens to low thousands). **DEP-13's "an empty copy ≤ 100 MB" is passed at about 250-500 quiet resources per process at its peak, for 20-50 s after each boot, and at about 2,000 once V8 has collected** (groups only, measured: RSS 94 MB at 100, 106 at 500 and 116 at 1,000 about 11 s after a boot; 93 at 500, 95 at 1,000, 99 at 2,000 and 102 at 3,000 once collected), if an empty copy means one with no rows. And **the base's boot**, by Raft's random timers, takes 3-5 s at 1,000 and 7 s at 10,000 and leaves two thirds of the leaders off their preferred member, so leaders stay uneven for about 1 minute at 1,000 and 4.5 minutes at 10,000 while the hand-back runs (measured counts; time computed); every member restart does the same for 1 and 6 minutes (computed). The first version of this page measured a faster boot (0.6 s and 2 s) because its harness had each group's preferred leader campaign at once, a rule the base does not have.

The rest bends at about **10,000 resources per process**, for reasons that are not CPU: a 256 MB copy holds about 9,000 idle resources soon after a boot and about 25,000 once V8 has collected; v4's directory as written refuses more than 4,096 entries per process and is quadratic both to register (30 s for 10,000) and to drop a dead link's entries (21 s for 10,000); per-resource timers, if kept from v4, pass PERF-12's 1%. The boot's elections bend later, between 10,000 and 100,000. Garbage-collection pauses grow with the heap: a full collection stops JavaScript for about 19-44 ms at 10,000 and 110-261 ms at 100,000. Each has a cheap fix inside V5-2: a boot campaign by preferred leaders (about 1 rule; it partly reverses decision 21a, at a cold start only) for the boot up to 10,000; dormant groups (4 rules, about 6 to drop everything) for memory, the boot, the hand-back and the collector; shared segments per process (about 4 rules) for files and disk, recommended but not needed below about 10,000 on this box; an index in the directory's register and drop (no rule, a bug fix). The owner must say which reading of DEP-13 holds, how long uneven leaders may last after a restart, and which working range to state: up to about 10,000 resources per process with quiet groups only (no new rules; or +1 for the boot campaign), or 100,000 with dormant groups.

How sure: **medium-high** for the per-part memory, the idle CPU and frames, the create times, the directory costs and the leader counts after a boot (measured here on real code: E-10's Raft port, v4's directory and `data` seam; three runs or more each); **medium** for the boot times, the GC pauses and the knee positions (one box, three processes on loopback, election timers in whole ticks; the preferred start's collision at 100,000 seen once in 10 timed runs), and for resident memory, which swings 2-5 × per resource with how long since the boot (V8 shrinks the heap on its own timing; three runs per reading); **low to medium** for the restart, failover and hand-back times (computed, not run) and for the rule counts of the cheap forms (reasoned, not modelled).

## Words used here

- **Resource**: one `fero(name)`; in the chosen design, its own small cluster (V5-2). **Home group**: its first Raft group, whose log holds its settings, slot table and group records. A small resource has only that group.
- **Member**: one process holding a copy. Here 3 machines and 3 copies, so every member holds a copy of every resource.
- **Quiet group**: an idle group that stops its heartbeats (E-11). **Dormant group**: an idle group written to disk and dropped from memory, woken by the next message (E-26). **Awake** or **active**: a group being written.
- **Slot table**: which group holds each of the 4,096 slots. **Per-slot state**: sequence, epoch and fence position per slot (E-36).
- **Fold**: `data`'s rows for the resource on a full copy (`fold-all`).
- **Live heap**: what V8 keeps after a full garbage collection. **RSS**: what the process holds in RAM; in Node it also holds garbage not yet collected, so it is larger.
- **Genesis**: founding a resource (E-33): create its id in the store only if absent, then found its home group.
- **Knee**: the R where a cost stops being small or grows faster than R.
- **Preferred leader**: the member that should lead a group when all are up (DESIGN-V5 4.2: the one the ring ranks first; here process g % 3 + 1). **Hand-back**: once a preferred leader has been back and caught up for `settle.ms` (30 s), leadership is handed back to it, at most ten a second per member.
- **Seed directory**: a directory host that clients start from; every server announces its copies to every seed (V5-3; `soft-directory` rule 7).

## Method

Five harnesses, all in this folder, on the box E-11 and E-26 used (4 vCPU, 15 GB, Node 22.22.0; [results/versions.txt](results/versions.txt)). Nothing earlier was rebuilt: E-26's host runs unchanged (boot.mjs patches a copy of it), and E-05, E-07, E-11, E-12, E-25, E-26, E-27, E-36 and E-39 are cited where they already measured a part.

1. **Parts, one member** ([parts.ts](parts.ts)). One process per part and per R (1,000, 10,000, 100,000; dense forms at 1,000 and 10,000 only, since 100,000 would need 3.3 to 11 GB). It builds R copies of one part and reads the live heap (heapUsed plus array buffers, after two forced collections) and RSS before and after; per resource = the difference / R. It also times the build (what a boot or a create pays). Real code: E-10's TypeScript port of etcd raft for the home group (founded in-process: three replicas, a campaign, the founding batch committed, the logs compacted, and this member keeps one replica, so it leads a third); v4's `data` seam for the fold ([api/substrate.ts](../../../../api/substrate.ts) `proxy`); v4's directory host ([api/directory.ts](../../../../api/directory.ts) `hostMethods`; past its cap of 4,096 entries per caller the harness spreads each server's entries over several caller ids, so the registry itself can be measured) and codec ([kernel/codec.ts](../../../../kernel/codec.ts) `encodeControl`) for directory entries and their bytes. The other records are the plain JS forms they would take. [tree.sh](tree.sh) copies those v4 files to a scratch tree with `data` beside them (read only).
2. **Three processes, R groups each** ([cluster.mjs](cluster.mjs)). E-26's host ([../E26-dormant-groups/host.ts](../E26-dormant-groups/host.ts): E-11's TS host on E-10's port, quiet groups, link pings every 500 ms, ticks of 500 ms, election after 4 to 7 ticks, one journal with one fdatasync per round) with R groups per process, R = 1 to 100,000. At start each group's preferred process campaigns at once (host.ts:323): a preferred-leader boot, not the base's (section 6). Per run: the cold boot (spawn to every group led on all three), the journal bytes, 20 creates (a new group on three processes and its first write), a 5 s idle count of frames and Raft messages, memory, then 10 s later E-11's CPU window (4 s warm-up, 6 s). Three runs per R, each run of all six R inside one `$SP/bin/timing` hold. Then one more run at 10,000 and at 100,000 reads each process's CPU from `/proc` for 90 s in 10 s slices, with V8's `--trace-gc` on (the create times of that run are not used: the tracing slows it).
3. **Disk** ([disk.mjs](disk.mjs)). Two layouts for R groups' founding records (224 B of segment and 16 B of index each): a folder per group with its own segment and index files (LAYERS 1.2's "one set of files per group"), and one shared segment and index per process. Bytes are allocated blocks (`st_blocks`), not file sizes. It also opens every segment at boot, holds as many open as this box allows, and times the one-box genesis (an exclusive create of the id file, fdatasync, folder fsync; E-33's one-box form). Three runs, one hold.
4. **Boots, memory and the collector, added after the skeptic's check** ([boot.mjs](boot.mjs)). A copy of E-26's host with four marked patches: no campaign at start (`start=random`), so groups elect by Raft's random timers as the base does; DESIGN-V5's timing as an option (100 ms ticks, 2 s plus 0-500 ms: `tick=100 elect=20 jitter=5`); a `leaders` command (leaders per process, how many of its preferred groups each leads, and the term each was won at); and the import path. Per run: the cold boot, leaders 3 s later, then optionally memory (RSS 11 s after boot, a forced collection, then RSS again 20 s later, or 40 s later in the `settled` target added after the re-check) or 4 slices of 10 s with `--trace-gc` (CPU per process and each major collection's pause; RSS again 40 s after the forced collection). Three runs per setting, each run of its R values in one hold. [parts.ts](parts.ts) `drop=1` adds a link death to the directory parts: one server's entries dropped at once, in v4's host and in the indexed form. [disk.mjs](disk.mjs) `layout=genesis` ran alone three times.
5. **Outside systems.** Their own documents, fetched from their documentation repositories ([fetch.sh](fetch.sh); docs.nats.io, docs.pingcap.com and cockroachlabs.com were not reachable from this box), Kafka 4.4.0's operations page fetched for E-09c, and NATS's configuration page fetched for E-09b. Read only.

**Timing rules.** Every timed process held `$SP/bin/timing`; load averages are in each raw line (median 1.05, max 1.73 at the start of a process or run in the first runs; up to 4.5 in the boot runs, where the 1-minute average still held the run before's three busy processes, which were already stopped). Medians and ranges below. The parts are memory first; their build times are timings too, so they ran inside one hold.

## Results

All tables are generated by [summarize.py](summarize.py) into [results/tables.md](results/tables.md); the raw lines are [results/parts.jsonl](results/parts.jsonl), [results/cluster.jsonl](results/cluster.jsonl), [results/disk.jsonl](results/disk.jsonl), and from the added runs [results/boot.jsonl](results/boot.jsonl), [results/gc.jsonl](results/gc.jsonl), [results/dirdrop.jsonl](results/dirdrop.jsonl) and [results/genesis.jsonl](results/genesis.jsonl).

### 1. Memory per member, part by part (measured)

Per resource, at R = 100,000 unless marked (live heap after a full collection; RSS in brackets where it says more):

| part | form | bytes per resource | note |
|---|---|---|---|
| Raft state | this member's copy of the home group (leads a third) | **3,107** (RSS 3,464) | etcd's RawNode and its in-memory storage, log compacted; a follower opened from disk: 3,064 |
| Raft state, in a live cluster | E-26's host, three processes | **3,171** live; RSS per group about 11 s after a boot: about 25,000 at 1,000-2,000, 16,000 at 10,000, 12,000 at 100,000; once V8 has collected (40 s after a forced collection): 3,200-3,900 at 1,000-10,000, 5,000 at 100,000 | from the cluster and boot runs, over the R = 1 runs (medians of every process reading). Soon after a boot it is smaller at large R only because V8 has already collected more of the boot's garbage by then (section 3; reasoned) |
| settings | one object, in the home log (was `#meta`'s catalog row) | 225 | |
| group record | one object, in the home log | 169 | slots, replicas, leader hint |
| slot table | 4,096 row objects | 196,762 (at 1,000) | one row per slot, as the draft's `#meta` kept it |
| | two typed arrays of 4,096 | **32,755** (at 10,000) | |
| | run-length, one run | **113** | every slot in the home group |
| | implicit (no record while every slot is home) | 0 | reasoned |
| per-slot state | dense typed arrays of 4,096 | **82,099** (at 10,000) | |
| | Map of touched slots: 1 / 10 / 100 | 233 / 1,001 / 8,457 | about 85 B per touched slot |
| | packed byte array: 1 / 10 / 100 / 4,096 | **203 / 365 / 1,942** / 73,493 | 18 B per touched slot plus about 150-185 B |
| fold | an empty `data` source | **1,262** | v4's seam |
| | 10 rows of about 100 B / 100 rows (at 10,000) | 4,687 / 31,791 | about 300-340 B per row (E-05 measured the same) |
| directory | at a directory host: 3 entries (one per copy) | **1,499** (indexed form) | on every seed directory (`soft-directory` rule 7); a machine's own host that is not a seed holds a third of it |
| | a server's list of the names it announces | 65 | |
| timers | none: one ticker per process | 0 | |
| | one `setInterval` per resource (v4's form) | 218; **3.6% of a core idle at 100,000** (1.3% at 10,000) | measured |
| sockets | none: one listen port and one link per machine pair | 0 | |
| | one listening socket per resource (v4's form) | 646 (RSS 2,614, at 10,000) | plus 2 peer links each, 3.7 KB (TCP) or 49.7 KB (TLS) per link ([E-27]) |
| dormant | group index entry plus name index entry | **138** | E-26 measured 57 B for the group entry; plus a 24 B record on disk. Everything else the resource holds is dropped too (section 2) |

### 2. Idle, dormant and active, per member (assembled)

| state | what is held | live heap per resource | resident (RSS) | basis |
|---|---|---|---|---|
| **Idle, drafted (typed arrays)** | quiet group + a dense slot table in two typed arrays + dense per-slot state + empty fold + records | **120,363 B** | 114,807 B | measured (`asm-drafted`, 10,000 resources). With the slot table as 4,096 row objects (section 1), about 284 KB (computed: 120,363 − 32,755 + 196,762) |
| **Idle, cheap form** | quiet group + one-run slot table + packed per-slot state (10 slots touched) + empty fold + settings, group record, name | **5,404 B** | 6,179 B in one process. In a live cluster it depends on how long since the boot (the group's measured RSS per group, plus the other parts' 2.7 KB): soon after a boot about 28 KB at 1,000-2,000, 19 KB at 10,000 and 15 KB at 100,000; once V8 has collected about 6-6.6 KB at 1,000-10,000 and 7.7 KB at 100,000 | measured (`asm-cheap`, 100,000) and the cluster and boot runs |
| **Dormant group, the rest in memory** | the group's index entry + one-run slot table + packed per-slot state + settings, group record, name, with or without the empty fold | about **1.2 KB** without the fold, **2.4 KB** with it | | computed from the measured parts (5,404 − 3,107 + 138, less the fold's 1,262). E-36's 1.4 KB, which V5-2 quotes, counts fewer parts: a catalog row (185 B), a one-run slot table (120 B), a Map of 10 touched slots (1,008 B) and the dormant group entry (57 B), 1,370 B in all ([E-36], "Memory per idle resource"). It has no fold, no group record (169 B), no announced name (65 B) and no name index. This form with a Map in place of the packed array would be about 1.8 KB without the fold (computed: 1,173 − 365 + 1,001) |
| **Dormant, everything dropped** | the group's index entry and the name only; the group, settings, slot table, per-slot state and rows stay on disk | **138 B** (+ 24 B on disk) | about the same | measured (`dormant`); E-26. It needs more rules than dormant groups' 4 (the cheapest forms, below) |
| **Active** | the idle form + rows (about 300 B each) + touched slots (18 B packed, 85 B in a Map) + an awake group's log tail | idle + rows; an awake group's live state is about a quiet one's once its log is compacted | about 5 KB more RSS per awake group (E-11: 331-336 MB with 100 awake groups of 10,000, 362-372 MB with about 7,000 awake) | measured here and in [E-11] |

**On a seed directory** every form above costs 1.5 KB more per resource (section 8). With all three machines as seeds, the cheap form is about 6.9 KB live per member and the dropped dormant form about 1.6 KB, most of it the directory.

So the drafted form's 120 KB is 95% slot table and per-slot state. The cheap form's 5.4 KB is 57% the group, 23% the empty fold.

**CPU while active** (from [E-11], not redone): a write costs one group round. Writes spread thinly over very many groups cost more than the same writes on a few, because each write wakes a group that then goes quiet again. In TypeScript, the base's language, 10,000 groups at one write a second each used 72% of a core against 49% for 16 groups at the same total rate (+47%), and p99 rose from 10 to 121 ms ([E-11]; Go and Rust rose less: +14-30% CPU, p99 5-6 ×).

### 3. The curve: R resources per member

| R | drafted, live heap | cheap and quiet, live heap | cheap and dormant | measured, three processes: RSS per process about 10 s after boot / 20 s after a forced collection / 40 s after it | its live heap |
|---|---|---|---|---|---|
| 1 | 0.1 MB | 0.01 MB | 0.0 MB | 92 / 92 / - MB | 9.4 MB |
| 10 | 1.2 MB | 0.05 MB | 0.0 MB | 91 / 92 / - MB | 9.5 MB |
| 100 | 11 MB | 0.5 MB | 0.01 MB | 94 / 91 / - MB | 9.9 MB |
| 250 | 29 MB | 1.3 MB | 0.03 MB | 99 / 91 / - MB | 10.3 MB |
| 500 | 57 MB | 2.6 MB | 0.07 MB | 106 / 94 / 93 MB | 11.3 MB |
| 1,000 | 115 MB | 5.2 MB | 0.1 MB | 116 / 114 / 95 MB | 12.9 MB |
| 2,000 | 230 MB | 10 MB | 0.3 MB | 140 / - / 99 MB | 16.3 MB |
| 3,000 | 344 MB | 15 MB | 0.4 MB | 150 / - / 102 MB | 19.3 MB |
| 10,000 | 1.1 GB | 52 MB | 1.3 MB | 247 / 129 / 129 MB | 41.1 MB |
| 100,000 | 11.5 GB | 515 MB | 13 MB | 1,237 / 570 / 568 MB | 312 MB |

The first three columns are R × the measured unit (computed). The measured columns are with groups only (no fold or records), and include this harness's base of about 92 MB. Each is the median of every process reading at that R, from the cluster runs and the boot runs (the DEP-13 table in [results/tables.md](results/tables.md) gives the ranges and sources; R = 250 to 3,000 and the 40 s readings come from [boot.mjs](boot.mjs)). **DEP-13's empty copy** (≤ 100 MB, REQUIREMENTS.md): with groups only, RSS passes 100 MB between 250 and 500 resources soon after a boot, and at about 2,000 once V8 has collected (99 MB there, with 3 of 9 processes just over; all 9 over at 3,000). Memory on this page is in units of 2^20 bytes (summarize.py divides kilobytes by 1,024), so "MB" here means MiB. Read in decimal megabytes, the settled crossing comes a little earlier, between 1,000 and 2,000: at 2,000, 8 of 9 processes were over 100,000,000 bytes (computed from results/boot.jsonl). The 40 s reading is the settled one. At 1,000 the 20 s reading still held the boot's garbage in 5 of 9 processes (94-118 MB), because V8's own shrink there ran 10-30 s after the forced collection; 40 s after it, all 18 readings were 91-97 MB. The first fix of this page read the 20 s column and put the crossing at 500-1,000.

**The curve is a straight line**: no part costs more per resource at 100,000 than at 1,000 (the per-resource figures fall 5-35% as fixed costs spread). Resident memory per group depends mostly on when it is read, not on R: once V8 has collected it is 3.2-3.9 KB at 1,000-10,000 and 5.0 KB at 100,000 (measured). Soon after a boot it is larger, about 25 KB at 1,000-2,000, 16 KB at 10,000 and 12 KB at 100,000; it looks smaller at large R because V8 has already collected more of the boot's garbage by then (4 major collections per process during a boot at 100,000, 1 at 1,000; reasoned from the counts). Nothing measured grows faster than R except v4's directory as written (its register and its drop, section 8). The boot grows more slowly than R (section 6), and the collector's pause per full collection grows with the live heap, so about with R (section 4).

### 4. Idle CPU, frames and garbage collection (measured)

| R per process | CPU per process, % of a core: median of 10 s slices (3 runs) | the one slice after each boot | the first runs' 10 s window | idle Raft messages/s | frames/s per process | pause per long major collection, ms (V8's own and forced); V8's short follow-up |
|---|---|---|---|---|---|---|
| 1 | | | 0.08 | 0 | 2.7 | |
| 10 | | | 0.08 | 0 | 3.2 | |
| 100 | | | 0.08 | 0 | 3.4 | |
| 1,000 | 0.10 | 0.7-0.8 | 0.08 | 0 | 3.0 | 5-11; follow-up 1.5-5; live heap 13 MB |
| 10,000 | 0.20 | 2.0-2.5 | 0.13 | 0 | 3.1 | 19-41 (44 in a re-check's run); follow-up 2-14; 41 MB |
| 100,000 | 0.20 | 16-22, in every traced run (4 of 4) | median 7.6; the busiest process 22-28 in 2 of 3 runs (the slice after the boot fell inside it) | 0 | 3.4 | 110-261; follow-up 24-79; 316 MB |

- **A quiet resource sends nothing.** The frames are link pings: a member pings a peer every 500 ms when nothing else went that way, so at most 2 a second per peer; measured 2.4-4.0 a second per process with two peers, whatever R (as [E-11] and [E-25] found up to 10,000 groups; now to 100,000).
- **So the idle cost is per machine pair, not per resource**: at n machines, about 2n frames a second per member ([E-25]: up to 19,800 a second in all at n = 100, reached from about 10,000 resources; 8,904-9,056 at 1,000, where not every pair of members shares a group).
- **CPU stays at Node's floor** (0.1-0.2% of a core) at every R, except once after every boot: within about 30 s of the first full collection that follows the boot (0-20 s after it at 10,000 and 100,000, 10-30 s at 1,000; measured, [results/tables.md](results/tables.md), "Garbage collection against R"), V8 runs a few major collections to shrink the heap. Resident memory falls only then (section 3). That slice cost 16-28% of a core at 100,000 (about 2 CPU-seconds per process, every boot) and 2-2.5% at 10,000, and did not come back in the next 30-70 s ([results/tables.md](results/tables.md), "Idle CPU over 90 s" and "Garbage collection against R"). The first runs' window came 10 s after the memory reading, too soon to miss it at 100,000, so its median of 7.6% is that slice, not the steady cost; the median of 10 s slices is.
- **Garbage collection pauses grow with the heap.** A full major collection stops JavaScript for about 5-11 ms at 1,000 quiet groups, 19-44 ms at 10,000 and 110-261 ms at 100,000 (every long one: V8's own after the boot and both forced ones, three runs; the 44 ms is from a re-check's run; measured with groups only, [results/gc.jsonl](results/gc.jsonl) and [results/recheck/gc.jsonl](results/recheck/gc.jsonl)). V8's own come in pairs after a boot: the long one, then a short follow-up of 1.5-5, 2-14 and 24-79 ms. A forced collection on the settled heap at 100,000 (312 MB live) still took 194-214 ms. The first version of this page gave medians that mixed the long and the short ones (16-21 ms at 10,000, 95-173 ms at 100,000), which understated the pause a write can hit. Rows add theirs: [E-07] measured 0.2-0.41 s at 1e6 rows of 2 KB and 0.77-0.98 s while loading 5e6 small rows. A write that lands on a major collection waits for it, which fits the create's 87-185 ms tails at 100,000 (section 7). All stay under E-07's 1 s line, so this is a latency cost, not a false-failover risk. Dormant groups take the groups' part out of the heap.
- **Only if nothing per resource ticks.** One ticker and one timer wheel per process: a `setInterval` per resource, as v4 has, costs 1.3% of a core at 10,000 and 3.6% at 100,000 (measured), over PERF-12's 1%.

### 5. Disk: bytes, files and open files per resource (measured)

| R | a set of files per group: files and folders (inodes) | bytes allocated per resource | one shared segment and index: files | bytes allocated per resource |
|---|---|---|---|---|
| 1 | 3 | 12,288 | 2 | 8,192 (two 4 KB blocks) |
| 10 | 30 | 12,288 | 2 | 819 |
| 100 | 300 | 12,288 | 2 | 287 |
| 1,000 | 3,000 | 12,288 | 2 | 242 |
| 10,000 | 30,000 | 12,288 | 2 | 240 |
| 100,000 | 300,000 | 12,288 | 2 | 240 |

- Making a group's files took 85-460 µs per resource (it varied with the disk), against 1.5-4.8 µs to append a resource's founding to a shared segment. A boot that opens, reads and closes every group's segment pays 5.4-5.9 µs per resource from 1,000 up. Each file held open costs about 240 B of kernel memory (from `/proc/meminfo`, at 10,000 and more).

- **The journal** (shared per process, [E-12]) takes each resource's founding: 12-18 B per group in E-26's host (hard state and the leader's empty entry, varints, no checksums) and 28-38 B per create (measured). In [E-12]'s record format (a 16 B batch header that carries a CRC-32 of the batch, then a 12 B header per record; LAYERS 1.2 names a crc32c per journal record instead) the founding batch of about 180 B of settings, slot table and group record (parts.ts `homeBatch`, measured), with Raft's own records, comes to about **300 B per resource per member** (computed).
- **Segments.** A set of files per group costs 12 KB of disk and 3 inodes per resource, whatever its size: 4 KB is the smallest block a file or folder takes here (ext4). One shared segment and index per process cost about 240 B per resource (measured with a 224 B founding record and a 16 B index entry). In the shared form the segments are the journal's own, so its 240 B and the journal's 300 B are two sizes of the same records, not a sum: **about 300 B per resource in all** (computed). At 100,000 resources: about 1.2 GB and 300,000 inodes, against about 30 MB and 2 files.
- **Open files.** This box allows 20,000 open files per process (soft and hard limit; raising it is refused here, measured, [results/limits.txt](results/limits.txt)). That is **this box's limit, not the design's**: the kernel's ceiling here is 1,048,576 (`fs.nr_open`), Node raises its soft limit to the hard limit when it starts (measured: a node started under a soft limit of 1,024 had 20,000), and common Linux hosts allow 524,288 to 1,048,576 (from memory). On this box a store that keeps each group's active segment open stops below 20,000 groups (the harness held 19,000). Kafka recommends "at least 100000 allowed file descriptors" for a broker with many partitions (its operations page). Opening on demand costs 5.4-5.9 µs per open, read and close (measured); a shared segment needs a handful of files whatever R.
- **Inodes, on any box.** The cost that does not depend on the box's limit is the inodes: 3 per group, and the kernel's cache of them, 1,128 B per cached ext4 inode and 192 B per dentry here (measured, `/proc/slabinfo`). So 100,000 groups' 300,000 inodes take about 0.4 GB of kernel memory while they are cached (computed; the kernel can reclaim it).
- **Snapshots.** A small resource needs none until its log is cut. In the files-per-group form each snapshot is one more file (4 KB at least); in the shared form it is a record (reasoned).
- **The object store.** One small object per resource (its id, at genesis), then each group's snapshots and old segments as the tier uploads them ([E-28], LAYERS 1.2): at 100,000 resources, 100,000 id objects, a one-off of 100,000 PUTs (about $0.50 at S3's request price, from memory).

### 6. Boot and restart

Two boots were measured, and they are not the same rule. **Random timers** is the base's boot: every group elects by Raft's randomized timeout, and leaders are spread afterwards by the hand-back (DESIGN-V5 4.2, "Who stands for election" and "Leaders spread"; decision 21a). **Preferred start** is what E-26's host does, and what this page's first runs measured: at start, each group's preferred process (g % 3 + 1) campaigns at once ([E-26]'s host.ts:323, code). That is a boot-campaign rule the base does not have (about +1 rule, reasoned). [boot.mjs](boot.mjs) runs both on a copy of E-26's host with four marked patches (no start campaign; DESIGN-V5's jitter; a `leaders` command; the import path).

**A cold start of the whole project** (three processes, every group elects; measured, three runs each; [results/boot.jsonl](results/boot.jsonl) and [results/cluster.jsonl](results/cluster.jsonl)):

| R per process | random timers, DESIGN-V5's timing (2 s + 0-500 ms): boot | random timers, E-26's timing (2-3.5 s): boot | elections that ran again (DESIGN-V5's / E-26's timing) | leaders off their preferred member, per member | hand-back after the boot (computed) | preferred start: boot | preferred start: leaders |
|---|---|---|---|---|---|---|---|
| 1 to 100 | | | | | | 0.47-0.53 s | exact |
| 1,000 | **3.0-5.0 s** | 4.0-6.1 s | 0-0.9% / 0-1.8% | 182-258 of 333 | about **1 minute** | 0.56-0.82 s | exact, 9 of 9 runs |
| 10,000 | **6.9-7.1 s** | 7.1-7.4 s | 2.8-6.4% / 1.5-3.4% | 1,908-2,513 of 3,333 | about **4.5 minutes** | 1.74-2.18 s | exact, 10 of 10 |
| 100,000 | **20.3-22.0 s**; a fourth run 23.2 s | 24.4-24.9 s | 7-11%, a fourth run 13.5% / 31-35% | 17,292-26,189 of 33,333 | about **43 minutes** | 7.9-11.2 s; 34 s when it collided | exact in 9 of 10 timed runs; once 30 leaders on one process |

- **Random timers (the base).** With DESIGN-V5's timing the boot takes 3-5 s at 1,000, 7 s at 10,000 and 20-23 s at 100,000 (with E-26's: 4-6 s, 7 s and 24-25 s): it grows more slowly than R. The ranges are from three runs each; a fourth run at 100,000 with DESIGN-V5's timing, a re-check's, fell just outside them: 23.2 s, 13.5% of elections run again, 41 minutes of hand-back ([results/recheck/boot.jsonl](results/recheck/boot.jsonl); its runs at 1,000 and 10,000 fell inside). About two thirds of the leaders land off their preferred member, as chance predicts. Each member then takes back its share at ten a second after `settle.ms` (30 s), so leaders stay uneven for about 1 minute at 1,000, 4.5 minutes at 10,000 and 43 minutes at 100,000 (computed: 30 s + the largest per-member count / 10). Some elections ran again (a split vote, or an answer that came late from a busy process): under 1% at 1,000, 2-6% at 10,000, 7-35% at 100,000 (7-14% with DESIGN-V5's timing, the fourth run included). With 100 ms ticks (DESIGN-V5) far fewer ran again at 100,000 than with 500 ms ticks.
- **Preferred start.** 0.5 s up to 100 groups, 0.6-0.8 s at 1,000, 1.7-2.2 s at 10,000 with leaders exact in every run (9 and 10 runs): no election timed out, and the 2.06 s median that matched `election.ms` in the first runs was Node's start plus the work. At 100,000 it booted in 7.9-11.2 s with leaders exact in 9 of 10 timed runs (the first three, the first traced one, three boot runs and three traced runs); in one run (34 s), and in a smoke run (30 s, not counted), one process ended with 0-30 of its 33,333 leaderships, as if its own campaigns came too late and the others' timers won (reasoned).
- **So the boot's knee** is not at 10,000. It lies between 10,000 and 100,000: there the preferred start sometimes collides, and random timers re-run up to a third of the elections and leave about 40 minutes of hand-back. Below it, the base's own boot (random timers, no new rule) costs 3-7 s and 1-4.5 minutes of uneven leaders; a boot campaign by preferred leaders (about +1 rule) brings that to 0.6-2.2 s with leaders exact; at 100,000 it would need pacing (at most k campaigns per tick, the same rule with a limit; reasoned).

**One member restarts, its peers up** (computed: local work from the measured build times; the rest from DESIGN-V5 4.2, [E-05] and the boots above):

| R per process | local open work only: awake groups | the same, dormant groups | journal replay | groups whose leader it was (fail over at once) | hand-back once it is back | a rolling restart of three members, if each restart waits for the last hand-back: hand-backs alone |
|---|---|---|---|---|---|---|
| 1 | under 1 ms | under 1 ms | under 1 ms | 0-1 | 30 s | 1.5 min |
| 100 | 2 ms | under 1 ms | under 1 ms | 33 | 33 s | 1.7 min |
| 1,000 | 21 ms | 4 ms | 3-14 ms | 333 | **63 s** | 3.2 min |
| 10,000 | 0.21 s | 0.04 s | 0.03-0.13 s | 3,333 | **6.1 min** | 18 min |
| 100,000 | 2.1 s | 0.42 s | 0.3-1.3 s | 33,333 | **56 min** | 2.8 h |

- **Local work.** Per resource: open its group from its stored hard state (15 µs), an empty fold (1.7 µs), its records (1 µs), and re-announce its entry at an indexed directory host (3.6 µs at the host): about 21 µs (measured parts, summed). Then the journal replay: 1-3 small records per resource at [E-05]'s 223,000-328,000 records a second with fero v4's codec (about 4.5 µs a record, 2.7 µs of it decoding), so 0.03-0.13 s at 10,000 and 0.3-1.3 s at 100,000 (computed; the first version of this page used E-34's bytes-per-second rate, which was measured on 2 KB rows, and got 0.2 s). With dormant groups the boot reads one 24 B record per resource and wakes nothing ([E-26]: a cold start of three processes with 100,000 dormant groups was as fast as with 100).
- **Failover.** A crash takes the leaders of about R/3 groups. Their quiet followers wake after `election.ms` of link silence (`quiet-groups` rule 6) and elect: R/3 elections at once on the two survivors, after 2-2.5 s (reasoned; E-26's host has no failure detection on quiet groups, so it was not run; the random-timer boots above, R elections at once on three members, are the nearest measured case: 3-5 s at 1,000, 7 s at 10,000, 20-23 s at 100,000). Dormant groups have no leader to lose.
- **Hand-back.** Once the member is back and caught up for `settle.ms` (30 s), it takes back its preferred leaderships at ten a second (DESIGN-V5 4.2): about R/3 of them, so leaders stay uneven for about 1 minute at 1,000, 6 minutes at 10,000 and 56 minutes at 100,000 after every crash and restart (computed). A planned roll drains each member first (DESIGN-V5: leadership transfers, so no failover) but pays the same hand-back after each restart. How long leaders stay uneven then depends on a choice DESIGN-V5 does not make: its roll waits for a caught-up signal (DESIGN-V5.md lines 74 and 444), not for leaders to even out. If each restart waits for the last hand-back, three members in a row take about 3 × (30 s + R/30 s) of hand-backs: about 3 minutes at 1,000, 18 at 10,000 and 2.8 hours at 100,000 (computed). If the roll goes on once a member has caught up, the hand-backs overlap, and leaders stay uneven for about the roll's own length plus one hand-back: the roll plus about 1, 6 and 56 minutes (reasoned). Uneven leaders cost nothing while groups are quiet; while the hand-back runs, two members carry the busy groups' writes (reasoned). A dormant group has no leader to hand back until it wakes (reasoned).
- **Rows.** Folding a resource's rows comes on top: 223,000 records a second ([E-05]); 1e6 rows in 4.5 s.

### 7. Create (genesis) and cold open

| step | p50 | max or p99 | basis |
|---|---|---|---|
| found the home group: a group on three processes, a campaign, its first write | **4.0-4.8 ms** (medians by R) | max of 20: 5.5-11.4 ms in every timed run but one, at every R; at 100,000, 87 ms in one of the three timed runs. The two traced runs, slowed by tracing (their creates are not otherwise used), had 28.7 ms at 10,000 and 185 ms at 100,000 | measured, R = 1 to 100,000; flat at p50 only: the tails at 100,000 match the garbage collector's major pauses there (section 4; reasoned) |
| one-box genesis: exclusive create of the id file, fdatasync, folder fsync | **about 0.45 ms** (run alone: 0.41-0.49) | 1.4 ms (1.4-2.6) (p99) | measured alone ([results/genesis.jsonl](results/genesis.jsonl)). In the disk runs it came after the 100,000-group file layout was removed, in all three runs: 0.74 ms (0.41-3.95), p99 2.9 ms |
| the same, across boxes: a conditional PUT to MinIO | 1.37 ms | 2.67 ms (p99) | [E-28] |
| the same on S3 Standard | about 30 ms | about 80 ms tails | cited in [E-28] |
| **create, one box** | **about 5 ms** | about 11 ms; up to 87-185 ms at 100,000 | sum of the measured steps |
| **create, across boxes with S3** | **about 35 ms** | about 90 ms | sum, the store cited |
| **open a cold resource** (wake its dormant group until one write commits) | 3.3-3.5 ms | max of 20: 4.9-5.4 ms by scale (worst run 7.6 ms) | [E-26], flat from 100 to 100,000 dormant groups |
| load a small resource's fold on wake (10 rows) | about 0.05 ms | | E-05's rate (reasoned) |
| a client's first contact (ask the directory, connect, door, subscribe) | 4 round trips | | reasoned; [E-40] measured a cold browser client to its first committed write in 13-17 ms over TLS |

With no `#meta` row, the create is the group alone. It did not come out faster than E-36's create with `#meta` (4.6-5.3 ms p50): E-26 timed the same group-only create at 2.9-3.4 ms p50 when it ran right after a `#meta` commit ([E-26] `lifecycle.mjs`, "meta, then create"), and here each create came after a 20 ms pause. So the 1 ms gap is the harness (a process that just worked against one that waited), not R and not `#meta` (reasoned). The store's create-if-absent takes `#meta`'s place: cheaper on one box, dearer on S3.

### 8. The directory at R = 100,000 (measured on v4's code)

Three servers, each announcing all 100,000 resources: 300,000 entries at each directory host that hears them. This happens at every boot, and again whenever a directory host moves (SIMPLICITY's `soft-directory` rule 3: "A server announces everything again on every new link to a directory"). A server announces to every seed directory (rule 7), and each machine runs a host of its own (rule 6). This page assumes all three machines are seeds, the natural setup for three; then each of the three hosts holds all 300,000 entries, and every figure per host below is paid three times.

| form | bytes on the wire, per seed | directory host CPU, per seed | notes |
|---|---|---|---|
| **v4 as written**, one register call per entry | 140 B call + 32 B answer: **17 MB per server, 52 MB per seed, 156 MB in all with three seeds** | **quadratic**: 12 ms at 100 resources, 0.2 s at 1,000, 1.75 s at 3,000, **30 s at 10,000** (measured); about 50 minutes at 100,000 (extrapolated by R²) | every register copies the whole registry ([api/directory.ts:229](../../../../api/directory.ts) `rows = () => snapshot(registry)`, read at :275): 44 ms per register once it holds 100,000 names (measured). And it refuses more than 4,096 entries per caller ([api/directory.ts:209](../../../../api/directory.ts) `MAX_PER_CALLER`) |
| v4's registry with the names indexed (a Set in place of the snapshot read) | the same | **3.6 µs per entry: 1.1 s for 300,000** (measured) | 1.5 KB per resource at each seed |
| one list per server, replacing its last | **1.79 MB per server, 5.4 MB per seed** | about the same apply work; 44 ms to encode each (measured) | but every later change resends the whole list (the cheapest forms) |
| **a link death, v4 as written**: one server's R entries dropped | none | **quadratic** too: 92 ms at 1,000, 1.5 s at 3,000, **21 s at 10,000** (measured); about 35-75 minutes at 100,000 (extrapolated: by R² from 10,000, or 100,000 drops at the 44 ms a registry copy takes there) | v4's `forget()` calls `drop()` per entry, and `drop()` reads the whole registry ([api/directory.ts:233](../../../../api/directory.ts)) |
| a link death, the owner map as the index | none | **5 µs per entry: 0.5 s for 100,000** (measured) | `drop()` checks the owner map v4 already keeps, not a copy of the registry ([parts.ts](parts.ts) `forget`) |

- **Clients.** V5-3's client asks once and then learns from the resource, so a host move costs connected clients nothing. v4's `lookup` is a live subscription per name, so a move would also re-subscribe every name every client follows ([E-39] measured 10,000 resubscribes in 1.5 s over TCP and 5.6-7.1 s over TLS).
- **Per member.** Each server keeps its own list (65 B per name). Each seed holds every copy's entry: **1.5 KB per resource** on each seed (measured unit, rule 7). A machine whose host is not a seed holds only its own servers' entries, about 0.5 KB per resource (reasoned: a third of the three entries). With all three machines as seeds, every member pays 1.5 KB per resource for the directory: the cheap form's 5.4 KB live becomes 6.9 KB (+28%; +150 MB at 100,000).

### 9. The client side: a process that follows K resources

A derived resource is a client of each of its K sources (V5-2 (4)).

| K sources | per-source state (members, slot table, leader, cursor, subscription) | links if one per machine (3 machines) | links if one per resource per copy |
|---|---|---|---|
| 1 | 0.4-1.2 KB | 3 | 3 |
| 10 | 4-12 KB | 3 | 30 |
| 100 | 40-120 KB | 3 | 300: 1.1 MB (TCP) or 15 MB (TLS) |
| 1,000 | 0.4-1.2 MB | 3 | 3,000: 11 MB (TCP) or 149 MB (TLS) |
| 10,000 | 4-12 MB | 3 | 30,000: over this box's 20,000 open files |
| 100,000 | 40-120 MB | 3 | 300,000 |

- Per-source state is measured (377 B with a one-number cursor and no table; 1,233 B with a one-run table and a 10-slot cursor). Link costs are [E-27]'s: 3.7 KB per idle TCP link, 49.7 KB per TLS link, and a heartbeat of 0.88% of a core per 10,000 links at one ping per 30 s.
- **So a client must multiplex**: one link per machine carries every resource it follows there, as the members' own links do. Then K costs only its per-source state.
- **The derived log's marks** ("its log records how far it has read in each source", V5-2 (4)): [E-19] measured a cursor of 22-79 B for 1-10 partitions and 1.0-3.3 KB for a whole resource at 1,024 slots (about 4-13 KB at 4,096, reasoned). A mark should name only the sources read since the last mark; a vector of all K sources on every mark would be K × that per batch (reasoned).

### 10. A resource with G groups

Everything above is for G = 1 (the home group is the only data group). With G groups (reasoned from the measured units):

| cost | G = 1 | G groups |
|---|---|---|
| Raft state per member | 3.1 KB live | G × 3.1 KB (dormant: G × 57 B) |
| group records | 169 B | G × 169 B |
| slot table | 0-113 B | about 113 B + 40 B per extra run (one run per contiguous range a group holds) |
| per-slot state | per touched slot | the same (per slot, not per group) |
| journal and shared segments | about 300 B (one copy: the shared segments are the journal's) | G × that at founding |
| files per group form | 12 KB, 3 inodes | G × that |
| idle frames | 0 | 0 (link pings stay per machine pair) |
| boot, whole project | R elections | G × R elections |
| create | one group founded | G groups founded in parallel: about the same latency, G × the CPU |
| directory | one entry per copy | the same (clients learn groups from the home group) |
| client per-source state | one leader | G leaders and the G-run table |

## The knees

Per process, in TypeScript, with 3 machines and 3 copies (so every process holds every resource):

| knee | where | why | measured or reasoned |
|---|---|---|---|
| **DEP-13's empty copy ≤ 100 MB**, if an empty copy means one with no rows, whatever its resources | about **250-500** at its peak, for 20-50 s after each boot; about **2,000** once V8 has collected | this harness's base is 92 MB; each quiet group adds about 25-28 KB of RSS soon after a boot and about 3.2-3.7 KB once V8 has collected, at these R. With the cheap form's other parts (2.7 KB each), about 300 at the peak and 1,300 once collected (computed) | measured, groups only, medians of every process reading: RSS about 11 s after a boot 94 MB at 100, 99 at 250, 106 at 500, 116 at 1,000; 40 s after a forced collection 93 at 500, 95 at 1,000, 99 at 2,000 (3 of 9 over), 102 at 3,000 (9 of 9) |
| **leaders even again after a boot or a restart** | grows from the first resource, no bend: about 1 minute at 1,000, 4.5-6 minutes at 10,000, 43-56 minutes at 100,000 | the base boots by random timers (two thirds of leaders land off-preferred), and a restarted member takes back its R/3 at ten a second after `settle.ms` | computed from the measured counts and DESIGN-V5 4.2 |
| **resident memory in a small copy** | about **9,000** soon after a boot, about **25,000** once V8 has collected, in 256 MB (DEP-13's example) | 92 MB base, then about 19 KB per idle resource soon after a boot and 6.6 KB once V8 has collected (at 10,000; the group's RSS plus the other parts' 2.7 KB) | computed from measured units |
| **v4's directory, reused as written** | **4,096** (refused); 1.75 s at 3,000 and 30 s at 10,000 to register; 21 s to drop a dead link's entries at 10,000 | a per-caller cap, and a register and a drop that each copy the registry | measured on v4's code |
| **timers per resource** (if kept from v4) | about **10,000** | 1.3% of a core at 10,000 (over PERF-12's 1%), 3.6% at 100,000 | measured |
| **the boot's elections** | between **10,000 and 100,000** | to 10,000 the preferred start was exact in every run and random timers re-ran under 7% of elections; at 100,000 the preferred start collided in 1 of 10 timed runs and random timers re-ran 7-35% and left about 43 minutes of hand-back | measured |
| **a pause per full garbage collection** | grows with the heap, no bend: about 5-11 ms at 1,000, 19-44 ms at 10,000, 110-261 ms at 100,000 (each followed after a boot by a short one: 1.5-5, 2-14, 24-79 ms) | V8 stops JavaScript to mark every live object; quiet groups are most of the heap here | measured (groups only); with rows, [E-07] |
| **open files, files per group** | below **20,000** on this box | this box's limit (soft = hard = 20,000; the kernel allows 1,048,576 and common hosts 524,288 or more, from memory); Kafka asks for 100,000. On any box, 3 inodes per group and about 1.3 KB of kernel cache each | measured (this box) |
| **disk and inodes, files per group** | grows from the first resource: 12 KB and 3 inodes each | 4 KB blocks | measured |
| **a client following K sources with a link each** | about **1,000** over TLS (149 MB); 6,600 over TCP on this box (its open files) | E-27's per-link cost | computed |
| **a heap past Node's default** (2 GB) | about **300,000-400,000** idle resources (5.4 KB live each, 6.9 KB on a seed directory), fewer with rows | V8's default limit (SC-10) | computed |
| idle CPU and frames | **none found** up to 100,000 | quiet groups send nothing; pings are per machine pair | measured |

**Where quiet groups stop being enough.** Not on CPU or frames: those stay flat to 100,000. Two costs are already there in the owner's likely range (tens to low thousands). If DEP-13's empty copy counts resources, its 100 MB is passed at a few hundred quiet resources for 20-50 s after each boot, and at about 2,000 once V8 has collected, in this harness. And the base's own boot, by random timers, takes 3-7 s and leaves leaders uneven for 1-4.5 minutes; every member restart leaves them uneven for 1-6 minutes. Quiet groups change neither. The rest bends at about **10,000 resources per process**: resident memory in a 256 MB copy, v4's directory as written, per-resource timers. The boot's elections bend later, between 10,000 and 100,000. **Dormant groups** (4 rules, SIMPLICITY's `dormant-groups`) take most of these away: no group elects at a boot until it is used, a dormant group has no leader to hand back, and the heap the collector marks shrinks. An idle resource then costs about 1.2-2.4 KB with its records in memory, or about 140 B with everything dropped (about +2 rules more). A boot campaign by preferred leaders (about +1 rule) is the cheaper fix for the boot alone, up to 10,000.

## The cheapest forms inside V5-2

Each keeps a resource as its own cluster. Rule counts are SIMPLICITY's grain (a rule that breaks a stated property when dropped).

| form | saves | costs | rules |
|---|---|---|---|
| **The home group is the only data group** of a small resource | one group per resource (3.1 KB live, an election at boot) | a resource grows past one writer only by moving slots to new groups | 0: the drafted slot table already allows it (assumed throughout) |
| **Implicit slot table**: no table record while every slot is in the home group at epoch 0 | 113 B (one run) to 33 KB (dense) | the first slot move writes the first table record | 0-1, reasoned ("no record" reads as "all home") |
| **Packed per-slot state**: one sorted byte array, 18 B per touched slot | 82 KB against dense; 64% against a Map (365 B against 1,001 B at 10 touched; 1,942 against 8,457 at 100) | a binary search per write (a few touched slots) | 0: a format choice (DEV-09) |
| **Shared segments per process**: every group's records in the journal's own segments, with an index per group | 12 KB and 3 inodes per resource (to about 300 B and 0 inodes); 2 open files per group | compaction must copy a group's live records forward before a shared segment goes; the tier, a resource's delete and a fork each work on one group's records inside shared segments | **about 4** (3-5), reasoned: (1) a shared segment is deleted only when no group still needs a record in it; (2) a group's index is swapped only after its copied records are fsynced; (3) the tier uploads one group's records cut out of the shared segments, so each object holds one group in offset order (LAYERS 1.2: old segments are named by group incarnation and offset; `tier` rule 1); (4) a dropped resource's records are only marked dead, and compaction must run within SC-13's `settle.ms` plus one upload to free them. A fork reads one group's records through its index, and the parent's compaction keeps what a committed fork names (`forks` rule 5, stretched to shared segments; not counted again). Precedent from memory: TiKV keeps every region's Raft log in one shared engine, CockroachDB every range's in one store |
| **Dormant groups** ([A-15], [E-26]) | a quiet group (3.1 KB live; 3-5 KB resident once V8 has collected, 12-25 KB soon after a boot) to its 57-138 B index entry; no boot elections; no hand-back while asleep; a smaller heap to collect | a wake: 3.3-3.5 ms p50; the resource's settings, slot table, per-slot state and fold stay in memory: about 1.2 KB without the fold, 2.4 KB with it (E-36's 1.4 KB counts fewer parts, section 2) | **4** (`dormant-groups`, reasoned) |
| **Dormant, everything dropped**: the settings, slot table, per-slot state and fold go to disk with the group | 1.2-2.4 KB more, to 138 B per idle resource | a wake reloads them from the home log or the local snapshot (E-05: 223,000 records a second) | **about +2** beyond dormant groups, reasoned: nothing is answered for a resource before its records are reloaded (`dormant-groups` rule 3, stretched to the whole resource); a resource that holds rows bound to a session wakes when that session lapses, to remove them (`presence-rows` rule 6 needs a running writer). A snapshot before sleeping only keeps the wake short (speed, not counted). Locks and queue claims need no wake: their leases are judged when next claimed (`queue-claims` rule 1; `lock-rows`' claim.free) |
| **A boot campaign**: at a cold start each group's preferred leader stands at once; paced (at most k per tick) for very large R | the random boot's 3-7 s and its 1-4.5 minutes of uneven leaders, up to 10,000 (measured unpaced: 0.6-2.2 s, leaders exact) | at 100,000 the unpaced form collided once in 10 runs; the paced form was not measured | about 1, reasoned. The base has none: decision 21a dropped ranked candidacy and kept Raft's random timers and the `settle.ms` hand-back (DESIGN-V5.md line 1209; DESIGN-V5 4.2). So this partly reverses that cut, at a cold start only |
| **One ticker and one timer wheel per process**; **one listen port and one link per machine pair**; **clients multiplex** | 218 B and 1.3-3.6% of a core per resource (timers); a port and 2 links per resource (v4) | none found | 0 beyond `quiet-groups` (7) and `link-pings` (4), already in the base |
| **Directory: index the names** in register *and* drop | the quadratic register (30 s at 10,000) and the quadratic drop on a link death (21 s at 10,000) | none | 0: a bug fix in v4's code. The drop's index is the owner map v4 already keeps |
| **Directory: a full list on each new link, then numbered changes** | the re-announce: 17 MB to 1.8 MB per server per seed at 100,000; one call per server, not per resource | a list of R names per link; each change after it carries the number of the list it follows, and a change that does not follow the host's current list from that server is dropped, and the server sends its list again | **about 2**, reasoned: rewrites `soft-directory`'s rules 1, 3 and 5. The plain "the latest list replaces the last" (about 1) resends the whole list on every create, drop or slot move: 1.79 MB per change per seed at 100,000, so a burst of 1,000 creates sends 1.8 GB to each seed and costs each host about 6 minutes (computed from the measured list size and 3.6 µs per name). v4's per-entry form with the index fix stays the zero-rule choice |

With all of them, an idle resource costs a member about 5.4 KB live while its group is quiet (6.9 KB on a seed directory), about 1.2-2.4 KB with its group dormant, and about 140 B with everything dropped (1.6 KB on a seed); on disk about 300 B in the shared segments plus a 24 B dormant record.

## Against outside systems that run one consensus group per unit

| system | the unit | what an idle unit costs | limits it publishes | source |
|---|---|---|---|---|
| **NATS JetStream** | a Raft group per replicated stream and per consumer, plus one meta group all servers join, which owns placement | not stated | `max_ha_assets`: "Maximum number of RAFT assets (stream and consumers) which can be placed on this node", default "no limit" (since 2.8.0) | NATS docs: JetStream clustering ("each Stream creates a RAFT group ... each Consumer will have their own group"); configuration page (fetched for E-09b) |
| **CockroachDB** | a Raft group per range (default 512 MiB, `range_max_bytes = 536870912`); small ranges merged by default | ranges quiesce after 6 ticks with no proposals (`quiesceAfterTicks = 6`); leader leases "rely on a shared, store-wide failure detection mechanism" (store liveness) | no range count per node found in the fetched docs; "The maximum recommended storage capacity per node is 10 TiB" (at full size about 20,000 ranges, computed) | docs v25.4: replication layer, distribution layer, zones, production settings; `replica_raft_quiesce.go` |
| **TiKV** | a Raft group per Region (default 256 MiB since v8.4.0; was 96 MiB); Region Merge on by default since v3.0 | Hibernate Region on by default since v5.0.2: idle Regions get no ticks, so no heartbeats | no number; "When a large number of Regions exist, it takes Raftstore some time to process the heartbeats of these Regions"; "With millions of Regions, it might take more than ten seconds or even tens of seconds to get the meta information from etcd" (PD's) | PingCAP docs: massive regions best practices; TiKV configuration |
| **Kafka** (not Raft per partition: a controller and in-sync replicas) | a partition, with log segment files | idle followers fetch (E-25); each segment needs open files and 2 memory maps | "We recommend at least 100000 allowed file descriptors"; "creating 50000 partitions on a broker will result allocation of 100000 map areas and likely cause broker crash with OutOfMemoryError (Map failed)" at the default `vm.max_map_count` of about 65,535; the controller batches leader elections "for a large number of partitions" | Kafka 4.4.0 docs: operations (hardware and OS), design. From memory, not checked: Confluent's old guidance of about 4,000 partitions per broker and 200,000 per cluster (ZooKeeper era) |

- **What they share with this design**: idle units stop heartbeating (CockroachDB's quiescence, TiKV's hibernation; fero's quiet groups) and failure detection is per machine, not per unit (store liveness; fero's link pings). TiKV's hibernation is closest to dormant groups only in name: hibernated Regions stay in memory (from memory; the fetched docs say only that they get no ticks), so fero's dormant form (on disk, woken by `pread`) goes further.
- **What they do that V5-2 rules out**: their units are sized by data (256-512 MiB) and **merge when small**, so a tiny unit does not stay a unit. fero's unit is the resource the user names; it cannot merge. And each has a central place that batches the per-unit storm: Kafka's controller elects in batches, NATS's meta leader and TiKV's PD place units. V5-2 has no such place, so fero's per-resource storms (boot, failover, healing) are paced by rules inside each group.
- **Kafka is the files-per-unit warning**: its own docs put the per-partition limit in file descriptors and memory maps, the same knee as fero's files-per-group form here (20,000 open files per process on this box).

## What the owner must decide

1. **The working range to state** (SC-10: every ceiling stated). Either (a) **up to about 10,000 resources per process with quiet groups only** (no new rules; shared segments are recommended but not required, question 4; covers the expected tens to low thousands by 10 to 1,000 ×). Its price is on this page: a cold boot of 3-7 s, then leaders uneven for 1-4.5 minutes; leaders uneven for 1-6 minutes after each member restart (a rolling restart at 10,000: the roll's own length plus about 6 minutes, or 18 minutes of hand-backs if each restart waits for the last); a 256 MB copy holding about 9,000 idle resources soon after a boot and 25,000 once V8 has collected. A boot campaign by preferred leaders (about +1 rule) brings the boot to 0.6-2.2 s with leaders exact; it partly reverses decision 21a, which cut ranked candidacy, at a cold start only. Or (b) **100,000 with dormant groups** (+4 rules; about +6 to drop everything to 140 B), with a paced boot campaign (about +1) only if many groups are awake at a cold start.
2. **What DEP-13's "an empty copy ≤ 100 MB" means** (REQUIREMENTS.md DEP-13). Read plainly, an empty copy holds no rows, whatever its resources: then this harness passes 100 MB at about 250-500 quiet resources per process at its peak, for 20-50 s after each boot, and at about 2,000 once V8 has collected (groups only, measured; about 300 and 1,300 with the other parts of each resource, computed). Both are inside the likely range. Dormant groups (1.2-2.4 KB per idle resource, or 140 B with everything dropped) would move the crossing to some thousands or tens of thousands (reasoned from the units). A smaller group (E-11: 4 KB of RSS per group in Rust, against 16-26 KB in TS) would remove most of the peak; once V8 has collected, a TS group here holds 3.2-3.9 KB (measured), so Rust would gain little there (reasoned). (In decimal megabytes the settled crossing is between 1,000 and 2,000; see section 3.) Read as "a copy with no resources", the bar is the process's base (this harness: 92 MB; fero v4: 70-100 MB, DEP-13's note), and the cost per resource is a separate stated number, as this page gives it. Which reading holds?
3. **The hand-back's pace.** At ten a second per member, leaders stay uneven for 6 minutes after a restart at 10,000 and 56 minutes at 100,000. A rolling restart adds about one hand-back to the roll's own length if the roll goes on once a member has caught up, or three hand-backs (18 minutes and 2.8 hours) if each restart waits for the last one; DESIGN-V5 does not say which. Keep it, raise it (a number, not a rule), or count on dormant groups (an asleep group has no leader to hand back)?
4. **Segments shared per process, not files per group** (LAYERS 1.2 says one set of files per group). Recommended either way: it removes the inode and open-file costs, for about 4 rules once the tier, a resource's delete and forks are counted. It is not required for range (a): files per group fit up to about 10,000 per process on this box, at 12 KB and 3 inodes each (120 MB and 30,000 inodes at 10,000; measured), below its 20,000 open files. Range (b) is where it pays: with files per group, 100,000 resources take 1.2 GB and 300,000 inodes per process, and more groups than this box lets a process hold open (measured).
5. **The directory's shape and its seeds**: per-resource entries (v4's, with the index fix in both register and drop: no rule) or a list on each new link plus numbered changes (about 2 rules, 10 × fewer bytes per re-announce). Either way v4's per-caller cap of 4,096 must go. The seed count sets the memory: 1.5 KB per resource on each seed.
6. **Clients multiplex** one link per machine for every followed source (assumed by the per-machine-pair costs above; v4 opened a port and links per resource).

## What this box cannot show

- **Three machines on one box, over loopback.** Frames and CPU are per process; real networks add round trips to the create (about 0.5-1 ms, reasoned) and to every boot election.
- **Larger clusters.** With more than three machines a member holds fewer than all R resources; costs per member then scale with the copies it holds (about 3R/n), and idle frames with machine pairs ([E-25]).
- **Failover, healing and hand-back storms were not run.** E-26's host has no failure detection on quiet groups and no hand-back, so a machine loss (about R/3 elections), the hand-back after it and per-resource healing (about 4 Raft changes and a snapshot per resource, paced at two snapshots at a time per member) are computed or reasoned. The random-timer boots (R elections at once on three members) are the nearest measured case.
- **Election timers in whole ticks.** The host draws each timeout in whole ticks: 4 values with E-26's timing, 6 with DESIGN-V5's. A timer drawn to the millisecond would tie less often, and a busy process answers votes late; both make elections run again (reasoned). The preferred start's collision at 100,000 was seen once in 10 timed runs (and once in a smoke run); its cause is reasoned, not traced.
- **Rust.** E-11 measured a quiet group at 4 KB of RSS in Rust against 16-26 KB in TS, read a few seconds after its start. Here a TS group settles to 3.2-5.0 KB once V8 has collected, so the native step (V5-6) would mainly remove the peak after a boot (reasoned); it would move only the Raft state, not the fold.
- **V8's memory.** Resident memory per group swung from 12-25 KB soon after a boot to 3.2-5.0 KB once V8 had collected, at every R from 1,000 to 100,000; live heap (3.1-3.2 KB) is the stable figure. V8 shrinks the heap on its own timing: here 10-30 s after the forced collection at 1,000 and 0-20 s after it at 10,000 and 100,000; at 2,000 one process in nine still held 106 MB 40 s after it. This harness forces one collection about 11 s after each boot; a process left alone may shrink at another time (reasoned), so the peak's 20-50 s is this harness's. The 92 MB base is this harness's (Node, E-10's port loaded by type stripping, E-26's host); fero v4 measured 70-100 MB empty (DEP-13's note).
- **Real disks and the store.** One virtio disk with ext4 without a journal; the object store was not run (E-28's figures are cited). The open-file limit is this box's.
- The cheap forms' rule counts are reasoned, not model-checked.

## Verdict

Q-49: in the chosen design an idle small resource costs each member about 5.4 KB of live memory (3.1 KB of it its home group; 120 KB as drafted with a dense typed-array slot table and dense per-slot state), 1.5 KB more on each seed directory, 0 frames and no measurable CPU (link pings are per machine pair: about 3 frames a second per process from 1 to 100,000 resources), about 1.2-2.4 KB with its group dormant and about 140 B with everything dropped, and about 300 B on disk in shared segments (12 KB and 3 inodes with a set of files per group); its resident memory is about 6-28 KB in all, by how long since the last boot: for the first 20-50 s about 28 KB at 1,000-2,000, 19 KB at 10,000 and 15 KB at 100,000; once V8 has collected about 6-8 KB. A create answers in about 5 ms on one box (4.0-4.8 ms to found the group, flat at p50 to 100,000, with tails of 87-185 ms there from garbage collection, plus a local create-if-absent of about 0.45 ms) and about 35 ms with S3, and a cold open in 3.3-3.5 ms. The cost is a straight line in R. Inside the owner's likely range two costs already show: DEP-13's 100 MB empty copy is passed at about 250-500 quiet resources per process at its peak, for 20-50 s after each boot, and at about 2,000 once V8 has collected (groups only; if it counts resources), and the base's random-timer boot takes 3-7 s and leaves leaders uneven for 1-4.5 minutes, as every member restart does for 1-6 minutes. At about 10,000 per process resident memory fills a 256 MB copy (about 9,000 soon after a boot, 25,000 once V8 has collected), v4's directory as written breaks (capped at 4,096, quadratic to register and to drop: 30 s and 21 s at 10,000), and per-resource timers would pass 1%; the boot's elections bend only between 10,000 and 100,000 (the first version's knee at 10,000 rested on a preferred-leader start campaign the base does not have). Garbage-collection pauses grow with the heap, with no bend: a full collection stops JavaScript for about 5-11 ms at 1,000, 19-44 ms at 10,000 and 110-261 ms at 100,000. Moves: the likely range needs no new rules beyond the base's quiet groups and link pings, provided timers are per process, clients multiplex links, and the directory indexes its register and its drop (a v4 bug fix), and provided the owner accepts the boot and hand-back times above and reads DEP-13's empty copy as one with no resources; shared segments per process (about 4 rules) are recommended there but not required, since files per group fit up to about 10,000 per process on this box (12 KB and 3 inodes each); a boot campaign by preferred leaders (about +1, partly reversing decision 21a at a cold start) shortens the boot to 0.6-2.2 s with leaders exact; 100,000 per process needs dormant groups (+4 rules, about +6 to drop everything), and a list per server with numbered changes (about +2) keeps each directory re-announce at 1.8 MB per server per seed.

## How to rerun

```
sh fetch.sh            # the outside documents, into $SP/dl/e49-cited (read only)
sh run.sh all          # tree, parts (one timing hold), cluster (three holds), disk (one hold), then the
                       # added targets: boot, gc, settled, dirdrop (one hold per run), genesis, limits; then summary
sh run.sh boot         # one added target alone (likewise gc, settled, dirdrop, genesis, limits)
sh run.sh summary      # tables only, into results/tables.md
```

`SP` is the scratchpad (default as in E-26). About 20 minutes on this box for the first targets, 25 more for the added ones and 11 for `settled`; the R = 100,000 runs need about 5 GB of RAM for the three processes. boot.mjs writes its patched copy of E-26's host to `$SP/e49/host/host.ts` each time it starts.

## Files

- [run.sh](run.sh), [tree.sh](tree.sh), [fetch.sh](fetch.sh), [summarize.py](summarize.py)
- [parts.ts](parts.ts): memory and build time per resource, part by part
- [cluster.mjs](cluster.mjs): three processes of E-26's host with R groups each
- [disk.mjs](disk.mjs): segment layouts, open files, one-box genesis
- [boot.mjs](boot.mjs): cold boots by random timers and by the preferred start, leaders per process, memory, and the collector's pauses (a patched copy of E-26's host)
- [results/tables.md](results/tables.md): every table; [results/parts.jsonl](results/parts.jsonl), [results/cluster.jsonl](results/cluster.jsonl), [results/disk.jsonl](results/disk.jsonl): raw lines with load averages; added: [results/boot.jsonl](results/boot.jsonl) (boots and DEP-13 memory, the `settled` runs tagged `dep13w40`), [results/gc.jsonl](results/gc.jsonl) (traced boots), [results/dirdrop.jsonl](results/dirdrop.jsonl) (link deaths), [results/genesis.jsonl](results/genesis.jsonl) (genesis alone), [results/limits.txt](results/limits.txt) (open-file limits, kernel object sizes); [results/versions.txt](results/versions.txt); [results/smoke.jsonl](results/smoke.jsonl): two smoke runs (R = 100 and 100,000), not measurements; [results/recheck/](results/recheck/): the re-check's own single runs of boot.mjs (boots, a traced boot at 10,000, memory 40 s after the collection at 500 to 2,000), quoted where the page says so and not pooled into the tables

[E-05]: ../E05-fold-cost/README.md
[E-07]: ../E07-gc-worker/README.md
[E-11]: ../E11-many-groups/README.md
[E-12]: ../E12-journal/README.md
[E-19]: ../E19-slot-positions/README.md
[E-25]: ../E25-idle-fd/README.md
[E-26]: ../E26-dormant-groups/README.md
[E-27]: ../E27-idle-links/README.md
[E-28]: ../E28-minio-log/README.md
[E-36]: ../E36-many-resources/README.md
[E-39]: ../E39-overload-storm/README.md
[E-40]: ../E40-browser-client/README.md
[A-15]: ../../AMENDMENTS.md
