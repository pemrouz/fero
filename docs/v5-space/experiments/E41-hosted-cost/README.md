# E-41: what each candidate costs the hosted platform

**Question (Q-41, [QUESTIONS.md](../../QUESTIONS.md) §8).** What does each row cost the hosted platform, per project per month? It decides DEP-21, OBJ and SLOG against the Raft rows for hosting, axis N (who shares a machine with whom), and decision 2b (the hosted shape).

**Threshold.** A row more than 2 × the cheapest at any load needs a written reason in VERDICT.md. If OBJ or SLOG is the cheapest by more than 2 × at 5,000 writes/s, the hosted shape is reopened.

**DEP-21's three loads and two bars.** A sleeping free project (bar: at most $2.19 a month, J's figure for a free project with a live app). 10 writes/s of 1 KB with 100 subscribers (bar: at most $10). 5,000 writes/s of 1 KB (no bar).

## Method

A spreadsheet, written as code so anyone can re-run it and change a number: [cost.py](cost.py). `./run.sh` prints the tables and writes [results/tables.md](results/tables.md), [results/inputs.md](results/inputs.md) (every input with its label) and [results/cost.csv](results/cost.csv) (every row with its items).

Every number in it is one of three kinds:

- **Cited:** a published price. 23 of them: Fly.io (machines, RAM, volumes, stopped machines, traffic), Tigris (Fly's object store), AWS (EC2, EBS, traffic between zones and to the internet, S3 Standard, S3 Express One Zone). Each has its link, how it was read and the date in `inputs.md`.
- **Measured:** a number from this study. 14 of them, from E-02 (CPU per process), E-05 (heap per row, fold cost, replay time), E-09b (JetStream's CPU), E-11 and E-25 (idle cost), E-26 (dormant groups), E-27 (subscriber CPU and link memory), E-35 (a tenant's byte budget) and two v4 measurements quoted in REQUIREMENTS.
- **Assumed:** a size DEP-21 leaves open. 16 of them: rows per project (312, 10,000 and 1,000,000 rows of 1 KB), an hour of log on each replica's own disk, a day of log in the object store, 64 MB upload segments, a log-tier node's size and budget, a pooled server's size.

**How the prices were read. This matters.** This session cannot open `fly.io` or `aws.amazon.com`: both are outside its allowed network (the fetch fails with "host not found"). So no price was read from the vendor's own page. Each was read on 2026-11-10 from a web search's summary of that page or of copies of it, and `inputs.md` says which. Three are weaker still: Fly's price for a stopped machine's disk (third-party copies only), Tigris's prices (not confirmed; set equal to S3 Standard), and AWS's internet traffic price (the long-standing list price, from memory). **Every price must be re-read on the vendor's page before VERDICT.md is final.** The links are in `inputs.md` for that. One check passed: the Fly machine price found ($2.19 a month for a shared CPU with 256 MB) equals J's own figure, which REQUIREMENTS quotes.

**What a row is made of, for cost.** Rows that differ only on axes that do not change the machines at these loads share a shape (the table is in `inputs.md`):

| Shape | Rows | What runs |
|---|---|---|
| three full copies, a process per project | MIN, MIN-TS, MIN-P, RUST, SIDE, ISR, V4 | 3 machines that each hold the log and fold the rows; a volume each; an object store for a day of log (not V4) |
| two that fold, one log-only voter of its own | LEAN | as above, the third machine without the rows |
| two full copies and a log-only voter on a shared log tier | DRAFT, CELL, LANE, SPLIT | 2 machines, and a share of one log-tier node |
| a log tier of three, servers that only fold | SLOG, RLOG | 2 servers (one would make failover cold: 36 s per GB of rows, E-05), and a share of three log-tier nodes |
| the object store is the log | OBJ | 2 machines, and one PUT per 10 ms commit window |
| pooled | EMB-V8 | a share of three big shared servers, by memory and CPU |
| a separate server | SRV, PD, BUY | 3 server machines, and the app on 2 machines of its own beside them (PD: 3 more small machines; BUY: three NATS servers, and the app folds) |

**The rules the arithmetic uses.**

- **Machine size.** RAM = an empty process (85 MB, v4 measured) + rows × (1,000 B + 230 B of heap overhead, E-05) + 50 KB per TLS subscriber link (E-27). CPU = 1 % of a core when nearly idle (E-25), or 0.25 core per process from about 1,000 writes/s (E-02: this fixed part is the same in TypeScript, Rust and Go), plus 4.6 µs per record for decode and fold (E-05), plus 0.17 core per 1,000 subscribers at 10 messages a second (E-27). The smallest machine that fits is taken. On Fly a shared CPU is used only for a few percent of a core; anything more gets a whole "performance" CPU, whose smallest size has 2 GB.
- **Disk.** Each replica's volume holds an hour of log, two snapshots and a reserve (E-29), at least 1 GB.
- **Bytes across failure domains.** On Fly, traffic between machines in one region is free, so replication costs nothing there. On AWS, three zones hold the bytes, so they cross a zone line twice, at $0.02 a GB (in and out). Fan-out to subscribers outside the platform is priced apart, because it is the same for every row.
- **Object store.** A day of log and one copy of the rows, uploaded in 64 MB segments or once a minute. OBJ instead pays one PUT per commit window.
- **Log tier share.** A node (two CPUs, 4 GB, a 500 GB volume: $141 a month) is budgeted to take 50 MB/s from all tenants together, a fifth of E-02's ceiling. A project's share is its bytes per second over that, or its disk over 500 GB, whichever is larger.
- **Asleep.** A free project keeps one copy. A row with its own disk pays for a stopped machine's root disk and a 1 GB volume. A row whose bytes live on the log tier or the object store pays for the stopped machine only. A pooled row pays for nothing in memory.

## Results

### Fly.io, one region (J's platform): $ per project per month

| candidate | sleeping | 10 writes/s, 100 subscribers inside | 5,000 writes/s | × cheapest (10 / 5,000) |
|---|---|---|---|---|
| MIN, MIN-TS, MIN-P, RUST, SIDE, ISR | 0.19 | 7.26 | 118 | 1.5 / 1.5 |
| LEAN | 0.19 | 7.26 | 118 | 1.5 / 1.5 |
| DRAFT, CELL, LANE, SPLIT | 0.04 | 4.94 | 96 | 1.0 / 1.2 |
| SLOG, RLOG | 0.04 | 5.00 | 124 | 1.0 / 1.6 |
| OBJ | 0.04 | 135.80 | 1,389 | 27.5 / 17.5 |
| EMB-V8 | 0.00 | 5.86 | 79 | 1.2 / 1.0 |
| SRV | 0.23 | 11.64 | 123 | 2.4 / 1.5 |
| PD | 0.23 | 18.21 | 129 | 3.7 / 1.6 |
| V4 | 0.19 | 7.02 | cannot: v4 measured 250 writes/s a member | 1.4 / - |
| BUY (reference, never the base) | 0.60 | 15.90 | 134 | 3.2 / 1.7 |

### AWS, three zones: $ per project per month

| candidate | sleeping | 10 writes/s, 100 subscribers inside | 5,000 writes/s | × cheapest (10 / 5,000) |
|---|---|---|---|---|
| MIN, MIN-TS, MIN-P, RUST, SIDE, ISR, LEAN | 0.72 | 10.73 | 621 | 1.6 / 1.0 |
| DRAFT, CELL, LANE, SPLIT | 0.64 | 7.61 | 607 | 1.1 / 1.0 |
| SLOG, RLOG | 0.64 | 7.67 | 635 | 1.1 / 1.1 |
| OBJ on S3 Standard | 0.64 | 137.55 | 1,377 | 20.5 / 2.3 |
| OBJ on S3 Express One Zone (one zone: not the same durability) | - | 36.01 | 440 | - |
| EMB-V8 | 0.00 | 6.70 | 602 | 1.0 / 1.0 |
| SRV | 1.36 | 16.86 | 627 | 2.5 / 1.0 |
| PD | 1.36 | 26.06 | 636 | 3.9 / 1.1 |
| V4 | 0.72 | 10.49 | cannot | 1.6 / - |
| BUY | 2.80 | 16.62 | 635 | 2.5 / 1.1 |

Asleep, the cheapest row costs about nothing, so a ratio says nothing there; the dollars do. The full tables, with every row's items, are in [results/tables.md](results/tables.md).

### What the money goes on

- **MIN at 10 writes/s on Fly, $7.26:** three machines with 256 MB $6.57; three 1 GB volumes $0.45; object store $0.24.
- **MIN at 5,000 writes/s on Fly, $118:** three machines with one whole CPU and 2 GB $99; three 21 GB volumes $9.45; object store (433 GB, 205,000 uploads) $9.69.
- **MIN at 5,000 writes/s on AWS, $621:** machines $79.50; volumes $5; **replication across zones $525.60** (13,140 GB a month, crossing twice); S3 $11. Traffic between zones is 85 % of the bill.
- **DRAFT at 5,000 writes/s on Fly, $96:** two machines $66; two volumes $6.30; 10 % of one log-tier node $14.10; object store $9.69.
- **SLOG at 5,000 writes/s on Fly, $124:** two machines $66; two volumes $6.30; 10 % of three log-tier nodes $42.30; object store $9.69.
- **OBJ at 10 writes/s on Fly, $135.80:** two machines $4.38; **26.3 million commit PUTs $131.42.** At 5,000 writes/s: 262.8 million PUTs (one per 10 ms window), $1,323.
- **BUY at 10 writes/s on Fly, $15.90:** three NATS servers with 512 MB $11.07; volumes $0.45; two app machines that fold $4.38.

### Against DEP-21's two bars (Fly)

| candidate | free project asleep (bar $2.19) | free project awake all month, one copy | 10 writes/s, subscribers inside (bar $10) | 10 writes/s, subscribers outside, each gets every write |
|---|---|---|---|---|
| MIN family, LEAN, ISR, V4 | 0.19 ok | 2.34 over by the volume's $0.15 | 7.26 ok (V4 7.02) | 59.82 over |
| DRAFT family, SLOG, RLOG | 0.04 ok | 2.19 ok | 4.94 to 5.00 ok | 57.50 over |
| OBJ | 0.04 ok | 2.19 ok | 135.80 over | 188.36 over |
| EMB-V8 | 0.00 ok | 1.42 ok | 5.86 ok | 58.42 over |
| SRV | 0.23 ok | 4.53 over | 11.64 over | 64.20 over |
| PD | 0.23 ok | 6.72 over | 18.21 over | 70.77 over |
| BUY | 0.60 ok | 8.91 over | 15.90 over | 68.46 over |

### Fan-out to subscribers outside the platform (the same for every row)

| each of the 100 subscribers receives | GB a month | Fly, to North America or Europe | AWS |
|---|---|---|---|
| every write | 2,628 | $52.56 | $236.52 |
| a tenth of the writes | 263 | $5.26 | $23.65 |
| a hundredth | 26 | $0.53 | $2.37 |

### Two sensitivities

- **More rows (5,000 writes/s over 10 GB of rows, Fly):** MIN $379, LEAN $295, DRAFT $270, SLOG $298, EMB-V8 $618. Here LEAN's saving shows (1.3 ×), because RAM is now most of the machine. At 1 GB of rows it does not show at all: the smallest machine with a whole CPU already has 2 GB.
- **SLOG or RLOG with one server (Fly, 5,000 writes/s):** $88, 0.75 × MIN. But a failover then rebuilds 1 GB of rows from the log, about 36 s (E-05), against F-05's 2.5 s. The two-server shape is the one that meets the MUSTs.

## What the numbers say

1. **No row with its own disks is far from another.** On Fly, every Raft row is within 1.6 × of the cheapest at both loads. The split is in three steps: a shared log tier in place of the third machine saves about a third (DRAFT's family, $4.94 against $7.26, and $96 against $118); pooling saves a little more at small sizes (EMB-V8); a separate server costs two more machines for the app (SRV 2.4 ×, PD 3.7 ×, BUY 3.2 × at 10 writes/s).
2. **OBJ is the most expensive row, not the cheapest: 17 to 28 × on Fly.** Every commit window is a PUT, and PUTs cost $0.005 per thousand. At 10 writes/s that is $131 a month for a project the bar puts at $10. On AWS it is 2.3 × the rest at 5,000 writes/s on S3 Standard. On S3 Express One Zone it is $440, 0.7 × the Raft rows, but in one zone only, which is not the durability F-01 asks for.
3. **SLOG is never cheaper than MIN by 2 ×.** Fly: $124 against $118. AWS: $635 against $621. So the threshold's second line does not fire: the hosted shape (decision 2b) is not reopened by cost.
4. **The language does not move the bill at these loads.** E-02 measured the same fixed 0.2 to 0.3 core per process in TypeScript, Rust and Go, and DEP-21's loads are far below where the per-append cost matters. RUST and SRV buy nothing here; they would above tens of thousands of writes a second.
5. **On AWS the bill is the network, not the machines.** At 5,000 writes/s, 85 % is traffic between zones. Every row with three copies in three zones pays the same $526, so the rows end within 6 % of each other. A design can only lower it by sending fewer bytes: compression (not counted here), or two zones.
6. **The free bar is exactly one always-on machine.** $2.19 is the price of one shared CPU with 256 MB. A row that needs its own volume is over by $0.15 when the project is awake all month. A row that needs a second machine (SRV, PD, BUY) is over by 2 to 4 ×. Asleep, every row is under $0.60.
7. **The $10 bar holds only if the subscribers are inside.** If the 100 subscribers are browsers and each gets every 1 KB write, the traffic is 2,628 GB a month: $52.56 on Fly, on every row alike. MIN stays under $10 only if each subscriber receives at most 5.2 % of the writes (DRAFT: 9.6 %). DEP-21 does not say where the subscribers are or how much each follows. It should.

## What the model leaves out

- **The vendor's own pages.** See "How the prices were read". A wrong price moves every row together, except OBJ (PUT price) and the AWS rows (zone traffic price).
- **Reserved and spot prices, and volume discounts.** List prices only.
- **Compression.** It would cut zone traffic, fan-out and object storage for every row by the same factor.
- **Catch-up traffic** (a new replica copies the rows and the log tail): 1 GB now and then, small beside steady replication. Rolls restart on their own disks and copy nothing.
- **The platform's own parts:** its control plane, its TLS terminator (E-27 says one is needed in front of a TypeScript edge), monitoring, backups beyond one day of log, support.
- **The cost of OPS-14 for the shared rows.** DRAFT's family, SLOG, RLOG and EMB-V8 are cheaper because projects share machines. E-35 found that tenants on one disk move each other's p99 past SC-11's bar unless each has a byte budget, and J promises today that no other project shares the machine. The saving is real only if the user accepts the shared tier.
- **Above 5,000 writes/s.** Where CPU per append and the journal's ceiling start to matter, the language and the kernel boundary would separate the rows. DEP-21 does not ask.
- **Sizes DEP-21 leaves open.** Rows per project, history kept, and what a subscriber receives are assumed. Change them in `cost.py` and re-run.

## Verdict

- **DEP-21 is met by MIN's family, LEAN, DRAFT's family, SLOG, RLOG, ISR and EMB-V8 on Fly** (asleep $0.00 to $0.19; 10 writes/s $4.94 to $7.26 with subscribers inside). **It is not met by OBJ, SRV, PD or BUY at 10 writes/s** ($135.80, $11.64, $18.21, $15.90).
- **More than 2 × the cheapest, so a written reason is owed in VERDICT.md:** OBJ at both loads (27.5 × and 17.5 × on Fly; the PUT per commit), SRV (2.4 ×), PD (3.7 ×) and BUY (3.2 ×) at 10 writes/s (the app's own machines beside the servers).
- **The hosted shape is not reopened:** neither OBJ nor SLOG is the cheapest at 5,000 writes/s, on either platform.
- **Two things for the user:** say where DEP-21's subscribers are and what each receives (it decides whether the $10 bar can be met at all), and confirm every price on the vendor's page.

Q-41: on Fly a project costs $0.00 to $0.60 asleep, $4.94 to $7.26 at 10 writes/s for every row that runs inside the app (DRAFT's shared third voter cheapest, MIN 1.5 ×) and $79 to $129 at 5,000 writes/s, with OBJ 17 to 28 × the cheapest (a PUT per commit window: $131 a month at 10 writes/s) and SRV, PD and BUY 2.4 to 3.7 × at 10 writes/s (the app's machines beside the servers); on AWS traffic between zones is 85 % of the bill at 5,000 writes/s and levels every three-copy row at about $620; neither OBJ nor SLOG is cheapest by 2 ×, so decision 2b is not reopened; all prices are cited from search summaries, not the vendors' pages (this session cannot open them). Moves: OBJ down on DEP-21 (fails the $10 bar by 13 ×); SRV, PD and BUY down on DEP-21 at small loads (over both bars when awake); DRAFT, CELL, LANE, SPLIT, SLOG, RLOG and EMB-V8 up a little on DEP-21 (a shared tier or pool saves a third, if OPS-14 and J allow it); MIN, MIN-TS, MIN-P, RUST, SIDE, LEAN and ISR hold DEP-21 (LEAN's saving shows only above about 2 GB of rows per copy; RUST and SRV gain nothing from their language at these loads); every row: DEP-21's $10 bar needs the subscribers placed (inside, or at most 5 % of the writes each).

## Price re-check (2026-11-10)

**Why.** The verdict above said every price must be re-read at the vendor before VERDICT.md is final. A checker re-read them on 2026-11-10, during the VERDICT review ([judging/VERDICT.review.json](../../judging/VERDICT.review.json), "check: E-41 prices").

**How.** The vendors' rendered pages still fail from this session ("host not found"). So the checker read the vendors' own published sources through git instead:
- Fly: the source of `fly.io/docs/about/pricing/` in `github.com/superfly/docs`, commit `ed9082f9` of 2026-11-09 (`about/pricing.mdx`, `about/billing.mdx`, `snippets/RegionPricingSelector.jsx`, which holds the per-second rates and the region markups).
- Tigris: Tigris's own docs, `github.com/tigrisdata/tigris-os-docs`, commit `358b7edb` of 2026-11-10 (`docs/ai-agents/tigris-vs-cloudflare-r2.md`, `tigris-vs-s3.md`).
- AWS: not read. Its hosts are outside this session's network. The 13 AWS prices stay unconfirmed. No DEP-21 cell uses them.

**What matched.** All 10 Fly and Tigris prices E-41 uses match the vendor's source: the shared machine ($2.19 per 30 days), RAM ($6.00 a GB), the shared and performance CPU (derived, $0.69 and $21), volumes and root disks ($0.15 a GB), egress ($0.02, $0.04, $0.12 a GB by region group), same-region private traffic (free for organizations on granular transfer rates, which is every one made after 18 July 2024), Tigris storage ($0.02 a GB, which E-41 had marked unconfirmed) and Tigris writes ($0.005 per 1,000).

**What did not match.** E-41 assumed that sending data from Fly to Tigris is free. Fly's billing page says the opposite: "You will be billed separately for data transfer to these external third-party services, including Tigris Object Storage." It names no rate. So the re-check bills the log's upload at two bounds: $0.006 a GB (Fly's private cross-region rate) and $0.02 a GB (its internet rate in North America and Europe). Two smaller corrections: Fly bills per second, so a month is 730 hours, not the 720 its list prices assume; and the exact per-second rates move each row by a few cents.

**The numbers** (`recheck/run.sh` reruns them; [recheck/results/](recheck/results)):

| Row (Fly, iad) | Asleep | 10 writes/s, subscribers inside | 5,000 writes/s |
|---|---|---|---|
| MIN's shape (MIN, MIN-TS, MIN-P, RUST, SIDE, LEAN, ISR, COMP) | $0.19 | $7.52 to $7.89 (was $7.26) | $198 to $382 (was $118) |
| DRAFT's shape | $0.04 | $5.17 to $5.54 | $176 to $360 |
| SLOG, RLOG | $0.04 | $5.23 to $5.60 | $204 to $388 |
| EMB-V8 | $0.00 | $6.02 to $6.38 | $158 to $342 |
| SRV | $0.23 | $11.97 to $12.34 | $203 to $387 |
| PD | $0.23 | $18.64 to $19.01 | $209 to $393 |
| BUY | $0.60 | $16.14 | $136 |
| OBJ | $0.04 | $136.02 to $136.39 | $1,468 to $1,652 |

- **At 10 writes/s nothing changes in DEP-21.** The same rows pass the $10 bar, with margins of 1.3 to 2 times instead of 1.4 to 2. In other Fly regions MIN's shape passes $10 at the top of its range: São Paulo $11.86 to $12.52, Johannesburg $10.70 to $12.54, Tokyo $9.81 to $10.46, Singapore and Sydney $9.55 to $10.21 (`recheck/results/regions.md`).
- **At 5,000 writes/s the upload dominates.** The log is 13,140 GB a month. At $0.02 a GB that is $263, and BUY, which keeps no log in the object store, becomes the cheapest row. Every row with the store tier is then 1.2 to 2.9 times BUY, and OBJ 12 times. E-41's reopening test (OBJ or SLOG cheapest by 2 times) is still not met. But the store tier's transfer is now the largest cost at high load, and a row that uploads less (compacted state, not the raw log) would save most of it.
- **Other machine shapes** (`recheck/results/floors.md`): SRV with one app machine is $9.58 to $10.11. PD with one app machine is $16.26 to $16.78. PD with its placement process inside the stores and one app machine is $9.58 to $10.11.
- **Still open.** AWS's 13 prices, and Fly's rate for traffic to Tigris. To read them, the session's network must allow `aws.amazon.com`, `pricing.us-east-1.amazonaws.com`, `fly.io` and `www.tigrisdata.com`.
