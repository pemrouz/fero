# E-28 (timing part): MinIO as an object-store log

## The question

Q-28 ([QUESTIONS.md](../../QUESTIONS.md) §7): how fast is a commit when the object store is the log, a conditional PUT per commit?

OBJ (SPACE §4) commits by writing an object: `If-None-Match: *` creates the next log object only if it does not exist yet (two writers cannot both win), and `If-Match: <ETag>` swaps a manifest only if nobody changed it since it was read (a compare-and-swap, for leadership and the log head). E-28 has two parts: the literature (S3's latency and request prices, WarpStream, SlateDB, and how they erase one tenant) and **this part: MinIO on this disk, conditional PUT p50 and p99 for 1 KB to 1 MB, to separate the protocol's cost from the network's.** The literature part is not in this folder; two cited figures are quoted below only to apply the threshold.

**Threshold** (QUESTIONS.md): a real store's p99 PUT > 10 × C → OBJ fails PERF-08 at `persisted` and stays only as a storage tier (sleep, wake, forks, history). The request cost at 1,000 commits/s is stated per month. C = 0.73 ms here (E-01), so 10 × C = 7.3 ms.

## Method

- **MinIO** `RELEASE.2025-10-15T17-29-55Z` (built with `go install` by the toolsmith, TOOLS.md), on this box's one ext4 disk, two layouts: one drive (`single`), and four drives in one erasure set (`ec4`, MinIO's normal production shape; all four folders on the same disk, `MINIO_CI_CD=1` so MinIO accepts drives on the root disk).
- **How MinIO persists a small object** (seen with `strace -f` on the server during PUTs: [results/strace-create-1k.txt](results/strace-create-1k.txt) counts the syscalls, [results/strace-openat-flags.txt](results/strace-openat-flags.txt) shows the open flags): each PUT writes its `xl.meta` (with the data inlined for small objects) into a temporary folder with `O_DSYNC`, then renames it into place. No `fsync` or `fdatasync` calls; the rename is not followed by a directory sync. So each PUT is one synchronous write, as a journal commit is.
- **The client** ([put/main.go](put/main.go)): Go's standard library only; it signs requests itself (AWS Signature V4, `UNSIGNED-PAYLOAD` as S3 clients use over TLS) over plain HTTP on loopback, keep-alive connections. Modes: `create` (a new key per PUT with `If-None-Match: *`), `cas` (one key rewritten with `If-Match: <its ETag>`), `plain` (a new key, unconditional: the floor). Sizes 1 KB, 16 KB, 64 KB, 256 KB, 1 MB; one writer (latency), and 8 writers for `create` at 1 KB and 64 KB (throughput). Each config runs 6 s after a 2 s warm-up; every PUT must answer 200.
- **Timing rules**: each run block held `$SP/bin/timing`, 3 runs, load average recorded per config (1.3 to 3.0, from MinIO's own work). Medians and ranges below. The first `ec4` attempt and two `single` runs failed (MinIO refused drives on the root disk and kept the port; every PUT got 503) and were re-run; the failed rows are kept apart in [results/failed-runs.jsonl](results/failed-runs.jsonl).

**Files.** [bench.sh](bench.sh), [fetch.sh](fetch.sh), [summarize.py](summarize.py). Raw: [results/runs.jsonl](results/runs.jsonl). Table: [results/tables.md](results/tables.md).

## Results

All measured here, one writer unless marked.

| drives | mode | size | PUTs/s | p50, ms | p99, ms | p99 / C |
|---|---|---|---|---|---|---|
| single | create (`If-None-Match`) | 1 KB | 698 | **1.37** | **2.67** (2.03-3.20) | 3.7 |
| single | cas (`If-Match`) | 1 KB | 521 | 1.82 | 3.63 (3.41-3.86) | 5.0 |
| single | plain | 1 KB | 701 | 1.35 | 2.64 | 3.6 |
| single | create | 16 KB | 619 | 1.55 | 3.03 | 4.2 |
| single | create | 64 KB | 539 | 1.79 | 4.00 | 5.5 |
| single | cas | 64 KB | 398 | 2.38 | 4.59 | 6.3 |
| single | create | 256 KB | 336 | 2.83 | 4.71 | 6.5 |
| single | create | 1 MB | 181 | 5.21 | 7.25 (7.05-8.02) | 9.9 |
| single | cas | 1 MB | 145 | 6.10 | 10.94 | 15.0 |
| single | create, 8 writers | 1 KB | 2,551 | 2.82 | 6.99 | 9.6 |
| single | create, 8 writers | 64 KB | 1,750 | 3.92 | 11.52 | 15.8 |
| ec4 | create | 1 KB | 348 | 2.78 | **4.26** (4.24-4.58) | 5.8 |
| ec4 | cas | 1 KB | 273 | 3.44 | 6.01 | 8.2 |
| ec4 | create | 64 KB | 308 | 3.07 | 7.10 | 9.7 |
| ec4 | create | 1 MB | 122 | 7.97 | 10.95 | 15.0 |

- **The protocol itself is cheap**: on local disk a conditional 1 KB PUT costs 1.4 ms at the median and 2.7 ms at p99, about 1 ms more than a bare `fdatasync` commit (C = 0.73 ms). The condition adds nothing measurable for `If-None-Match` (create 1.37 against plain 1.35 ms) and about 0.5 ms for `If-Match` (MinIO reads the current version first).
- **Erasure coding doubles it** (four synchronous writes per PUT): 1 KB p99 4.3 ms, CAS 6.0 ms.
- **Size dominates above 64 KB**: 1 MB costs 5-8 ms at the median.
- One writer reaches 700 PUTs/s; 8 writers 2,551/s at 7 ms p99. A log committing 1,000 times a second needs several PUTs in flight, or batching.

### What a real store adds (cited, not measured here)

- S3 Express One Zone: "consistent single-digit millisecond first byte" latency for reads and writes ([AWS, Optimizing S3 Express One Zone performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-express-performance.html)); a customer reports upload latency falling from 132 ms (S3 Standard) to 11.4 ms (Express One Zone) ([AWS Storage Blog, Fetch](https://aws.amazon.com/blogs/storage/how-fetch-reduces-latency-on-image-uploads-using-amazon-s3-express-one-zone)).
- S3 Standard: about 30 ms to first byte typical and 80 ms tails are common ([Quickwit, S3 Express speculations](https://quickwit.io/blog/s3-express-speculations)).
- Request prices (cited from memory of AWS's S3 pricing page, not fetched in this session): S3 Standard PUT $0.005 per 1,000; S3 Express One Zone PUT about $0.00113 per 1,000 (after the 2025 price cut). At 1,000 commits/s (2.59 billion PUTs a month): about **$13,000 a month** on S3 Standard and about **$2,900** on Express One Zone, before storage and reads. E-41 owns the cost table.

## Against the threshold

- **MinIO on this disk** (the protocol without a network): p99 2.7 ms (1 KB create) to 4.3 ms (1 KB, erasure-coded) = 3.7-5.8 × C, under 10 × C. CAS on erasure-coded drives, 6.0 ms, is 8.2 × C. So the protocol alone does not fail PERF-08's 10 × C line here.
- **A real store**: S3 Standard's typical 30 ms and tails of 80 ms or more are 40-110 × C; Express One Zone's "single-digit ms" puts its p99 at or above 7.3 ms (Fetch's 11.4 ms average upload is already 16 × C). Both are above 10 × C at p99 (cited). By the threshold, **OBJ fails PERF-08 at `persisted` and stays only as a storage tier** (sleep, wake, forks, history). The gap is the network and the store's own replication, which this box cannot show, not the conditional-PUT protocol.
- **Cost**: about $13,000 a month per 1,000 commits/s on S3 Standard, $2,900 on Express One Zone (cited prices). Batching cuts requests in proportion but adds its window to every commit's latency, so it cannot rescue the p99 bar at the same time.

## What this box cannot show

- Any network or store-side replication: MinIO here is on loopback and one disk. Real S3 latency is cited.
- Whether MinIO's `O_DSYNC` write without a directory sync survives a power loss at the rename (E-29's LazyFS tier could test it).
- TLS: the client spoke plain HTTP; HTTPS adds a handshake per new connection and some CPU per request (connections are kept alive here).
- MinIO across several machines (its distributed mode adds a network round trip per drive write).

## Verdict

Q-28: on this disk a conditional PUT to MinIO costs 1.37 ms p50 and 2.67 ms p99 for 1 KB (3.7 × C; 4.3 ms p99 with 4-drive erasure coding, 7-11 ms at 1 MB), so the conditional-PUT protocol itself is cheap, but a real object store adds its network and replication (S3 Standard about 30 ms typical and 80 ms tails; Express One Zone single-digit ms, cited), which puts p99 above 10 × C = 7.3 ms, and 1,000 commits/s costs about $13,000 a month on S3 Standard ($2,900 on Express One Zone, cited prices). Moves: OBJ down on PERF-08 at `persisted` (fails the 10 × C line on a real store) and stays as a storage tier only (S `+tier` up as the home for sleep, wake, forks and history: SC-05, DEP-04); no disk-based row moves; decision 2b (hosted shape) is not reopened by latency, and E-41's cost table decides the rest.
