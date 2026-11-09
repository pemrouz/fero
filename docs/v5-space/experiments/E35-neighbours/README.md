# E-35: big records and a busy tenant on a shared journal

## The question

Q-35 ([QUESTIONS.md](../../QUESTIONS.md) §8): on a shared journal, how much do big records and a busy tenant hurt everyone else's p99?

It decides SC-11's neighbour clause (one project at its quota raises another's p99 by ≤ 10%) and SC-15 (a 1 MB record written 10 times a second raises other partitions' commit p99 in the same group, journal or log tier by ≤ 20%); axis S (`jrnl` against `walg`) for the log tier; axis N (`tier` and `pool`, where projects share a process); DEP-12.

**Threshold** (from QUESTIONS.md): the victim's p99 rises ≤ 1.2× (SC-15) and ≤ 1.1× between tenants (SC-11) → the shared journal holds. Above → the cheapest passing variant is priced now as a mechanism, and L0's record format carries it (DEV-09).

**Known before this run** (a critic's probe on this box, `$SP/critic/hol/`): batches of 64 × 100 B had p99 0.39-0.43 ms; one 1 MB record in every 10th batch raised it to 1.76-1.82 ms, 4.2×. This experiment re-runs that probe and then measures the clauses themselves.

## Method

**The journal** is E-12's Node journal ([../E12-journal/ts/journal.ts](../E12-journal/ts/journal.ts)): one process, storage only, a record is committed when the `fdatasync` that covers it returns, latency from each record's ideal arrival time (open loop). Here the load is several **classes** of records, each with its own size, rate and set of groups (a group stands for a partition in (a) and for a tenant in (b)). Node only: the effect under test is the disk's (a big write in front of small ones), which E-12 shows is the same in Node and Rust at these rates.

**(a) SC-15, one partition with big records.** Victims: 16 partitions of 100 B records, 10,000/s in all. Load: one partition writing 1 MiB records 10 times a second (SC-15's own words). Victim p99 alone, then beside the big writer.

**(b) SC-11, 100 tenants on one log-tier process.** Tenant B writes 100 records/s of 100 B; 98 other tenants write 10/s each (980/s in all). Tenant A writes at its **quota**, in 1 MiB records or in 64 KiB records. No quota is fixed anywhere in the study yet, so two are tried: **10 MiB/s** (SC-15's 1 MiB × 10/s) and **40 MiB/s**. B's p99 alone (with the 98 others), then beside A. Windows of 20 s (B makes 2,000 records in a window), so B's p99 rests on about 20 samples above it; the p99 of all 99 light tenants together (about 21,600 records a window) is shown beside it as a steadier check.

**Variants** (each run alone and beside the load):

| Variant | What |
|---|---|
| `base` | one shared journal, FIFO, batches uncapped (E-12's mode a) |
| `blob` | records of 64 KiB or more go to a side file and are fdatasynced there; only a 24-byte pointer enters the journal, after the side file is durable (big values outside the log, as WiscKey and Kafka's tiered designs keep big data apart) |
| `cap` | batches capped at 64 KiB, FIFO; a record bigger than the cap is cut into 64 KiB frames in consecutive batches |
| `rr` | capped at 64 KiB, and each batch is filled round robin across groups (one record or frame from each group in turn) |
| `own` | one journal per group or tenant, each synced on its own (E-12's mode b; 4 sync threads) |

**Timing rules.** Every block holds `$SP/bin/timing`. Each configuration runs 3 times (repeats interleaved); tables show the median and the range. Each run records the load average, busy cores outside the process, and the whole disk's write rate.

**Files.** [bench.mjs](bench.mjs) (driver and the configurations), [run.sh](run.sh), [summarize.py](summarize.py), [probe/hol.mjs](probe/hol.mjs) (the critic's probe, copied unchanged), [fetch.sh](fetch.sh). Raw rows: [results/runs.jsonl](results/runs.jsonl), [results/probe.jsonl](results/probe.jsonl). Tables: [results/tables.md](results/tables.md).

**Machine.** As [E-12](../E12-journal/README.md): 4 vCPU Firecracker VM, one virtio disk with ext4 without a journal, Node 22.22.0.

## Results

Medians of 3 runs; ranges in [results/tables.md](results/tables.md). Latency is commit p99 in ms.

**A bug found and fixed on the way.** The first set of runs used a load generator that made record k when `(k+1)/rate` had passed but timed it from `k/rate`, adding one inter-arrival time to every latency: 0.1 ms for the 10,000/s victims, but 10 ms for tenant B (100/s) and 100 ms for the 1 MiB class (10/s). That blurred every ratio towards 1. The generator was fixed and every E-35 configuration was run again; the 34 old rows are kept, marked, in [results/discarded.jsonl](results/discarded.jsonl). (The bias in E-12 is at most 0.1 ms; see E-12's notes.)

### The critic's probe, re-run

| run | 64 × 100 B batches, p99 | every 10th batch also carries 1 MiB, p99 | ratio |
|---|---|---|---|
| 1 | 0.43 | 2.08 | 4.8 × |
| 2 | 0.90 | 1.86 | 2.1 × |
| 3 | 0.44 | 2.14 | 4.9 × |

It reproduces the critic's 4.2 × (median 4.8 ×). But the probe puts a big record in 10% of all batches and times batches, not records. The clauses below are the real tests: a big record 10 times a second among about 800 batches a second touches about 1% of them.

### (a) SC-15: 1 MiB records 10 times a second beside 16 partitions at 10,000 records/s

| variant | victims' p99 alone | beside the 1 MiB writer | ratio (bar ≤ 1.2 ×) | the 1 MiB record's own p99 |
|---|---|---|---|---|
| `base`: one shared journal | 3.21 | 3.78 | **1.18 ×** (first set: 1.26 ×) | 5.2 |
| `blob`: big records in a side file | 3.26 | 3.66 | **1.12 ×** | 22.7 |
| `cap`: 64 KiB batches, FIFO | 3.19 | 12.45 | 3.90 × | 35.2 |
| `rr`: 64 KiB batches, round robin | 3.72 | 8.29 | 2.23 × | 21.8 |
| `own`: a journal per partition | 3.83 | 4.43 | **1.16 ×** (1.38 × against `base` alone) | 6.6 |

- **The shared journal sits right at SC-15's bar on this disk.** Two sets of three runs gave 1.18 × and 1.26 × (the first set carried the 0.1 ms bias, which if anything lowers the ratio). The victims' p50 did not move (1.29 → 1.32 ms); only the batches that carry a 1 MiB record, about 1% of them, are slow.
- **Cutting big records into 64 KiB batches makes it worse, not better.** A 1 MiB record becomes 16 consecutive batches, and with FIFO every victim queued behind it waits for all 16 fsyncs (3.9 ×). Round robin lets victims into each of those batches, but they still pay 16 slower fsyncs instead of one (2.2 ×), and the big record itself takes 4 × longer.
- **A side file for big records helps the victims a little (1.12 ×) and costs the big record a lot** (its p99 goes from 5 to 23 ms: two fsyncs in sequence, the side file's then the pointer's).
- **A journal per partition** keeps the victims within the bar too (1.16 ×), but it is E-12's mode b: its victims are already 1.19 × slower alone (p50 1.56 against 1.29 ms), and it brings E-12's costs (fsyncs grow with partitions).

### (b) SC-11: 100 tenants on one log-tier process; tenant B writes 100/s, 98 others 10/s each

Tenant B's p99 alone, and beside tenant A at its quota. "All light" is the p99 of all 99 light tenants together (about 21,600 records per window, so a steadier number than B's 2,000).

| A's quota and record size | variant | B's p99: alone → beside | ratio (bar ≤ 1.1 ×) | all light: ratio |
|---|---|---|---|---|
| 10 MiB/s in 1 MiB | `base` | 2.86 → 4.46 | 1.56 × | 1.40 × |
| | `blob` | 2.76 → 3.88 | 1.41 × | 1.18 × |
| | `cap` | 2.82 → 17.22 | 6.10 × | 4.85 × |
| | `rr` | 3.08 → 5.01 | 1.63 × | 1.38 × |
| | `own` | 3.56 → 4.85 | 1.36 × | 1.20 × |
| 10 MiB/s in 64 KiB | `base` | 2.86 → 3.38 | 1.18 × | 1.09 × |
| | `blob` | 2.76 → 3.16 | 1.14 × | 1.13 × |
| | `cap` | 2.82 → 3.85 | 1.36 × | 1.32 × |
| | `rr` | 3.08 → 3.42 | 1.11 × | 1.05 × |
| | `own` | 3.56 → 3.14 | **0.88 ×** | **0.91 ×** |
| 40 MiB/s in 1 MiB | `base` | 2.86 → 4.53 | 1.59 × | 1.52 × |
| | `blob` | 2.76 → 4.06 | 1.47 × | 1.28 × |
| | `own` | 3.56 → 4.62 | 1.30 × | 1.24 × |
| 40 MiB/s in 64 KiB | `base` | 2.86 → 3.96 | 1.39 × | 1.26 × |
| | `blob` | 2.76 → 3.35 | 1.21 × | 1.13 × |
| | `own` | 3.56 → 3.29 | **0.92 ×** | **0.98 ×** |

(`cap` and `rr` at 40 MiB/s: 1.5-6.3 ×; all rows in the tables.)

- **No layout keeps a neighbour within 1.1 × when a tenant writes 1 MiB records at 10 or 40 MiB/s.** The best, a journal per tenant, still gives 1.30-1.36 × for B and 1.20-1.24 × for all light tenants. The tenants share one disk, and a big write slows every flush on it, whichever file it lands in (E-01 saw the same: flushes wait behind bulk data).
- **With A's data in 64 KiB records, a journal per tenant passes** (0.88-0.92 × for B, 0.91-0.98 × for all light), and round robin on the shared journal comes close at 10 MiB/s (1.11 ×, all light 1.05 ×) but not at 40 MiB/s (1.54 ×). The shared journal alone does not pass with 64 KiB records (1.18-1.39 ×).
- **The bar is close to this box's noise.** B's p99 alone ranged 2.42-3.40 ms across three runs of the shared journal (1.4 ×). A 1.1 × clause can only be judged on medians here, and the "all light" column is the steadier guide.

### (b) Where the neighbour clause holds: tenant A in 1 MiB records at lower quotas

| A's quota | shared journal: B's ratio | shared journal: all light | journal per tenant: B's ratio | journal per tenant: all light |
|---|---|---|---|---|
| 1 MiB/s | 1.20 × | **1.05 ×** | 1.17 × | **0.95 ×** |
| 2.5 MiB/s | 1.41 × | 1.14 × | 1.17 × | **0.91 ×** |
| 5 MiB/s | 1.51 × | 1.31 × | 1.14 × | **1.06 ×** |
| 10 MiB/s | 1.56 × | 1.40 × | 1.36 × | 1.20 × |
| 40 MiB/s | 1.59 × | 1.52 × | 1.30 × | 1.24 × |

On the steadier "all light" measure, the shared journal keeps neighbours within 1.1 × up to about 1 MiB/s of big records per tenant (one 1 MiB record a second), and a journal per tenant up to about 5 MiB/s. Tenant B's own p99 (2,000 samples) sits at 1.14-1.20 × in all of these, inside its own run-to-run spread.

## What this box cannot show

- **Separate disks.** Here every tenant's journal is on one virtual disk, so a big write slows every flush. On a log tier where each tenant has its own volume, or on NVMe with many queues, the per-tenant journal may isolate better; on a cloud volume shared by tenants it will not. This is the main limit of (b).
- **Quotas.** No quota is fixed anywhere in the study; 1-40 MiB/s were tried. The levels that pass are this disk's (about 600 MB/s at its ceiling, E-12), not a cloud disk's.
- **Real tenants.** Each tenant here is one group with a steady rate; bursts, many big tenants at once, and reads beside the writes are not tested.
- **Durability of the host**, as E-01 says.

## Verdict

**SC-15 (1.2 × within one journal) holds on the shared journal, just.** At SC-15's own load (1 MiB records 10 times a second beside 10,000 small records a second) the victims' p99 rose 1.18 × (and 1.26 × in a first set of three runs), with their p50 unchanged. Nothing needs to be added for it. Cutting big records into 64 KiB batches made it worse (2.2-3.9 ×), so a batch cap is not the fix; a side file for big records helped a little (1.12 ×) but made the big records 4 × slower, so it is not worth a mechanism now.

**SC-11 (1.1 × between tenants) does not hold on a shared journal at a 10-40 MiB/s quota of 1 MiB records, and no journal layout fixes it on one disk.** Tenant B's p99 rose 1.56-1.59 × (all light 1.40-1.52 ×) beside A on the shared journal, and still 1.30-1.36 × (all light 1.20-1.24 ×) with a journal per tenant, because the tenants share the disk. It held only below about 1 MiB/s of 1 MiB records per tenant on the shared journal, about 5 MiB/s with a journal per tenant, or with A's data in 64 KiB records (a journal per tenant: 0.88-0.98 ×; the shared journal: all light 1.09 × at 10 MiB/s but 1.26 × at 40, and B 1.18-1.39 ×). So the cheapest passing rule is a **per-tenant byte budget on the log tier** (about 1 MiB/s of big-record bytes per tenant on this disk, more with separate volumes), which is OPS-14's "each project has its own disk and fsync budget" made concrete. That is one more mechanism for every row that pools tenants in one log process (N `tier` or `pool`). A journal per tenant is not the answer at scale: E-12 showed hundreds of journals in one process cost 4.5-186 × in p99.

Q-35: on this one disk, a 1 MiB record 10 times a second raised other partitions' p99 in the same journal by 1.18-1.26 × (SC-15's 1.2 × bar: holds, just; 64 KiB batch caps make it worse at 2.2-3.9 ×; a side file gives 1.12 × but slows big records 4 ×), while a tenant at a 10-40 MiB/s quota in 1 MiB records raised another tenant's p99 by 1.40-1.59 × on a shared journal and 1.20-1.36 × with a journal per tenant (SC-11's 1.1 × bar: fails; it holds only up to about 1 MiB/s of big records per tenant on the shared journal and about 5 MiB/s with a journal per tenant), because tenants share the disk; the critic's 4.2 × probe reproduces (4.8 ×) but overstates the clause, as it puts a big record in 10% of batches. Moves: S `jrnl` holds SC-15 with no new mechanism (every `jrnl` row up on SC-15); the rows that pool tenants in one log process (N `tier`: DRAFT, CELL, LANE, SPLIT, SLOG, RLOG, OBJ; N `pool`: EMB-V8) down on SC-11 and OPS-14 until they price one more mechanism, a per-tenant byte budget on the log tier (about 1 MiB/s of big-record bytes per tenant on this disk) or a volume per tenant; N `proc` rows (MIN, RUST, LEAN, MIN-P, MIN-TS, SRV, SIDE) up on SC-11 (reasoned, not tested here: a process and volume per project, J's promise, keeps tenants off one disk); L0's format needs no pointer record kind for this (DEV-09 unaffected), but frames of at most 64 KiB, which SC-15's 64 MB rows already need, are not by themselves a fix.
