# E-35: big records and a busy tenant on a shared journal

> **Status: in progress.** Results and the verdict are filled in when the timed runs finish.

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
