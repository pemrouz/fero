## Cited prices

| key | value | unit | link | how it was read | date |
|---|---|---|---|---|---|
| fly.shared1x.256 | 2.19 | $/month, always on | https://fly.io/docs/about/pricing/ | search summary; equals J's own figure for a free project with a live app | 2026-11-10 |
| fly.ram.gb | 6 | $/GB-month of extra RAM on any preset | https://fly.io/pricing/ | search summary of Fly's pricing page | 2026-11-10 |
| fly.shared.cpu | 0.69 | $/month for one shared vCPU without RAM (2.19 less 0.25 GB of RAM) | https://fly.io/docs/about/pricing/ | derived from the two rows above; 512 MB = 3.69 and 1 GB = 6.70 agree | 2026-11-10 |
| fly.perf.cpu | 21 | $/month for one performance vCPU without RAM (performance-1x with 2 GB is 33.00) | https://fly.io/pricing/ | search summary of Fly's pricing page | 2026-11-10 |
| fly.volume.gb | 0.15 | $/GB-month, provisioned size | https://fly.io/docs/about/pricing/ | search summary | 2026-11-10 |
| fly.rootfs.gb | 0.15 | $/GB-month for a stopped Machine's root filesystem | https://fly.io/docs/about/pricing/ | third-party copies only; no primary text seen | 2026-11-10 |
| fly.egress.gb | 0.02 | $/GB out to North America and Europe (0.04 Asia Pacific, 0.12 Africa and India) | https://fly.io/docs/about/pricing/ | search summary | 2026-11-10 |
| fly.private.gb | 0 | $/GB between Machines in one region | https://fly.io/docs/about/pricing/ | search summary: "same-region transfer is free" | 2026-11-10 |
| tigris.storage.gb | 0.02 | $/GB-month (Fly's object store partner) | https://www.tigrisdata.com/docs/pricing/ | NOT confirmed by the search; taken as S3-like. Traffic from Fly to Tigris is free (Fly docs, search summary) | 2026-11-10 |
| tigris.put.k | 0.005 | $ per 1,000 write requests | https://www.tigrisdata.com/docs/pricing/ | NOT confirmed by the search; set equal to S3 Standard | 2026-11-10 |
| aws.t4g.nano | 0.0042 | $/hour on demand (2 vCPU burstable, 0.5 GB) | https://aws.amazon.com/ec2/pricing/on-demand/ | search summary (ec2instances.info and an AWS page copy) | 2026-11-10 |
| aws.t4g.small | 0.0168 | $/hour on demand (2 vCPU burstable, 2 GB) | https://aws.amazon.com/ec2/pricing/on-demand/ | search summary | 2026-11-10 |
| aws.c7g.medium | 0.0363 | $/hour on demand (1 vCPU, 2 GB) | https://aws.amazon.com/ec2/pricing/on-demand/ | search summary (third-party calculators) | 2026-11-10 |
| aws.c7g.large | 0.0725 | $/hour on demand (2 vCPU, 4 GB) | https://aws.amazon.com/ec2/pricing/on-demand/ | search summary (two third-party calculators agree) | 2026-11-10 |
| aws.gp3.gb | 0.08 | $/GB-month (3,000 IOPS and 125 MB/s included) | https://aws.amazon.com/ebs/pricing/ | search summary | 2026-11-10 |
| aws.interaz.gb | 0.02 | $/GB between Availability Zones (0.01 out plus 0.01 in) | https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer | search summary; REQUIREMENTS DEP-21 cites the same 0.01 each way | 2026-11-10 |
| aws.egress.gb | 0.09 | $/GB out to the internet (first 10 TB a month) | https://aws.amazon.com/ec2/pricing/on-demand/#Data_Transfer | not searched: the long-standing list price, from memory | 2026-11-10 |
| s3.storage.gb | 0.023 | $/GB-month, S3 Standard, first 50 TB | https://aws.amazon.com/s3/pricing/ | search summary | 2026-11-10 |
| s3.put.k | 0.005 | $ per 1,000 PUT, COPY, POST or LIST, S3 Standard | https://aws.amazon.com/s3/pricing/ | search summary (third-party guides agree) | 2026-11-10 |
| s3.get.k | 0.0004 | $ per 1,000 GET, S3 Standard | https://aws.amazon.com/s3/pricing/ | search summary | 2026-11-10 |
| s3x.storage.gb | 0.11 | $/GB-month, S3 Express One Zone (one zone only) | https://aws.amazon.com/s3/pricing/ | search summary | 2026-11-10 |
| s3x.put.k | 0.00113 | $ per 1,000 PUT, S3 Express One Zone, since 2025-04-10 | https://aws.amazon.com/blogs/aws/up-to-85-price-reductions-for-amazon-s3-express-one-zone | search summary of AWS's own post | 2026-11-10 |
| s3x.upload.gb | 0.0032 | $/GB uploaded, S3 Express One Zone | https://aws.amazon.com/blogs/aws/up-to-85-price-reductions-for-amazon-s3-express-one-zone | search summary | 2026-11-10 |

## Measured in this study

| key | value | what | where |
|---|---|---|---|
| row.heap.overhead | 230 | bytes of V8 heap per row on top of its ~100 B of data (315-338 B per 100 B row) | E-05 |
| row.heap.d13 | 1.6 | x: decision 13's two-thread form holds 510-528 B per 100 B row, 1.6 x the one-thread form | E-05 |
| process.fixed.core | 0.25 | core: a pipeline process uses 0.2-0.3 core at up to tens of thousands of appends a second, in TS, Rust and Go alike | E-02 |
| fold.us | 4.6 | us per record: fero v4's decode 2.7 us plus data's fold 0.22-1.9 us (batches of 256) | E-05 |
| idle.core | 0.01 | core: an idle member with 2,000 quiet groups and 99 links (0.95% in Node, 0.33% in Rust) | E-25, E-11 |
| subs.core.per.1000 | 0.17 | core for 1,000 subscribers at 10 messages a second each over TLS (0.088 over plain TCP) | E-27 |
| tls.link.kb | 49.7 | KB of memory per idle TLS client link in Node (3.7 KB plain TCP) | E-27 |
| dormant.group.bytes | 57 | bytes of memory per dormant group on a log-tier process (24 B on disk) | E-26 |
| empty.process.mb | 85 | MB: an empty fero v4 copy (70-100 MB; DEP-13's bar is 100 MB) | REQUIREMENTS DEP-13 (v4 measured) |
| replay.s.per.gb | 36 | s per GB to rebuild rows from the log (so a cold failover of 1 GB of rows fails F-05's 2.5 s) | E-05 |
| jetstream.us | 23 | us of server CPU per message, three JetStream servers, default sync | E-09b |
| v4.writes.per.member | 250 | persisted writes a second per member, fero v4 | REQUIREMENTS PERF-09 (v4 measured) |
| journal.ceiling.mb | 280 | MB/s: the pipeline's ceiling on this disk (2.8M appends of 100 B a second) | E-02 |
| tenant.budget.mb | 5 | MB/s of big-record bytes one tenant may write before a neighbour's p99 moves past SC-11's bar (1 MiB/s on a shared journal, 5 with a journal per tenant) | E-35 |

## Assumed

| key | value | why |
|---|---|---|
| row.bytes | 1000 | bytes per row: DEP-21 says writes of 1 KB |
| free.rows | 312 | rows in the sleeping free project (J's small project) |
| small.rows | 10000 | rows in the 10 writes/s project (DEP-13: 256 MB holds 10,000 small rows) |
| big.rows | 1e+06 | rows in the 5,000 writes/s project (1 GB of rows: one Node heap, SC-10) |
| history.hours.local | 1 | hours of log kept on each replica's own disk |
| history.hours.store | 24 | hours of log kept in the object store (replay, forks, new replicas) |
| segment.mb | 64 | MB per uploaded log segment |
| upload.every.s | 60 | at low rates a segment is uploaded at least this often |
| image.gb | 0.25 | GB of root filesystem per Machine (a Node app image) |
| min.volume.gb | 1 | GB: the smallest volume |
| obj.batch.ms | 10 | ms: OBJ groups commits into one PUT per window (its latency floor, E-28) |
| tier.node.month | 141 | $: one log-tier node: two performance vCPUs, 4 GB, a 500 GB volume |
| tier.node.mb | 50 | MB/s a log-tier node is budgeted to take from all its tenants (a fifth of E-02's ceiling, for headroom and tails) |
| pool.node.month | 255 | $: one pooled server (EMB-V8): four performance vCPUs, 16 GB, a 500 GB volume |
| isolate.mb | 30 | MB per awake V8 isolate in a pooled server (reasoned; E-03 measured isolate memory in its own form) |
| subs.share | 1 | share of the writes each subscriber receives (1 = every subscriber gets every write) |

## Shapes

| candidate | full copies | log-only voters of its own | log-tier replicas | app machines beside it | why |
|---|---|---|---|---|---|
| MIN | 3 | 0 | 0 | 0 | three full copies, each folds; a process per project |
| MIN-TS | 3 | 0 | 0 | 0 | as MIN (the language does not change the machine at these loads, E-02) |
| MIN-P | 3 | 0 | 0 | 0 | as MIN (project-owned groups save memory per resource, E-36, not per row) |
| RUST | 3 | 0 | 0 | 0 | as MIN (E-02: 0.2-0.3 core per process in Rust too) |
| SIDE | 3 | 0 | 0 | 0 | as MIN plus a daemon per host (inside the same machine) |
| LEAN | 2 | 1 | 0 | 0 | the leader and one warm standby fold; the third voter keeps only the log |
| V4 | 3 | 0 | 0 | 0 | three members that each apply every write; no object store |
| DRAFT | 2 | 0 | 1 | 0 | two full copies plus a log-only voter on the shared log tier |
| CELL | 2 | 0 | 1 | 0 | as DRAFT |
| LANE | 2 | 0 | 1 | 0 | as DRAFT |
| SPLIT | 2 | 0 | 1 | 0 | as DRAFT |
| SLOG | 2 | 0 | 3 | 0 | three log members on the shared tier; two servers that fold (one would make failover cold: 36 s per GB) |
| RLOG | 2 | 0 | 3 | 0 | as SLOG: Raft runs on three log members; two servers are learners that fold |
| OBJ | 2 | 0 | 0 | 0 | the object store is the log: one PUT per commit window; a leader and one lazy standby |
| SRV | 3 | 0 | 0 | 2 | three server machines, and the app runs beside them (two app machines, so one can fail) |
| ISR | 3 | 0 | 0 | 0 | three brokers, the controller inside them |
| PD | 3 | 0 | 0 | 2 | three stores, three placement-driver machines, and the app beside them |
| EMB-V8 | 3 | 0 | 0 | 0 | isolates inside three pooled servers shared by many projects |
| BUY | 0 | 3 | 0 | 2 | three NATS servers (log only) and the app, which folds, beside them |
