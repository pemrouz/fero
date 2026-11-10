
### Fly.io, one region (J's platform): $ per project per month

| candidate | sleeping | 10 writes/s, 100 subscribers inside | 5,000 writes/s | x cheapest (sleeping / 10 / 5,000; BUY is never the base) |
|---|---|---|---|---|
| MIN | 0.19 | 7.26 | 118 | - / 1.5 / 1.5 |
| MIN-TS | 0.19 | 7.26 | 118 | - / 1.5 / 1.5 |
| MIN-P | 0.19 | 7.26 | 118 | - / 1.5 / 1.5 |
| RUST | 0.19 | 7.26 | 118 | - / 1.5 / 1.5 |
| SIDE | 0.19 | 7.26 | 118 | - / 1.5 / 1.5 |
| LEAN | 0.19 | 7.26 | 118 | - / 1.5 / 1.5 |
| DRAFT | 0.04 | 4.94 | 96 | - / 1.0 / 1.2 |
| CELL | 0.04 | 4.94 | 96 | - / 1.0 / 1.2 |
| LANE | 0.04 | 4.94 | 96 | - / 1.0 / 1.2 |
| SPLIT | 0.04 | 4.94 | 96 | - / 1.0 / 1.2 |
| SLOG | 0.04 | 5.00 | 124 | - / 1.0 / 1.6 |
| RLOG | 0.04 | 5.00 | 124 | - / 1.0 / 1.6 |
| OBJ | 0.04 | 135.80 | 1389 | - / 27.5 / 17.5 |
| EMB-V8 | 0.00 | 5.86 | 79 | - / 1.2 / 1.0 |
| SRV | 0.23 | 11.64 | 123 | - / 2.4 / 1.5 |
| ISR | 0.19 | 7.26 | 118 | - / 1.5 / 1.5 |
| PD | 0.23 | 18.21 | 129 | - / 3.7 / 1.6 |
| V4 | 0.19 | 7.02 | cannot (v4 measured 250 writes/s a member) | - / 1.4 / - |
| BUY | 0.60 | 15.90 | 134 | - / 3.2 / 1.7 |

### AWS, three zones: $ per project per month

| candidate | sleeping | 10 writes/s, 100 subscribers inside | 5,000 writes/s | x cheapest (sleeping / 10 / 5,000; BUY is never the base) |
|---|---|---|---|---|
| MIN | 0.72 | 10.73 | 621 | - / 1.6 / 1.0 |
| MIN-TS | 0.72 | 10.73 | 621 | - / 1.6 / 1.0 |
| MIN-P | 0.72 | 10.73 | 621 | - / 1.6 / 1.0 |
| RUST | 0.72 | 10.73 | 621 | - / 1.6 / 1.0 |
| SIDE | 0.72 | 10.73 | 621 | - / 1.6 / 1.0 |
| LEAN | 0.72 | 10.73 | 621 | - / 1.6 / 1.0 |
| DRAFT | 0.64 | 7.61 | 607 | - / 1.1 / 1.0 |
| CELL | 0.64 | 7.61 | 607 | - / 1.1 / 1.0 |
| LANE | 0.64 | 7.61 | 607 | - / 1.1 / 1.0 |
| SPLIT | 0.64 | 7.61 | 607 | - / 1.1 / 1.0 |
| SLOG | 0.64 | 7.67 | 635 | - / 1.1 / 1.1 |
| RLOG | 0.64 | 7.67 | 635 | - / 1.1 / 1.1 |
| OBJ | 0.64 | 137.55 | 1377 | - / 20.5 / 2.3 |
| EMB-V8 | 0.00 | 6.70 | 602 | - / 1.0 / 1.0 |
| SRV | 1.36 | 16.86 | 627 | - / 2.5 / 1.0 |
| ISR | 0.72 | 10.73 | 621 | - / 1.6 / 1.0 |
| PD | 1.36 | 26.06 | 636 | - / 3.9 / 1.1 |
| V4 | 0.72 | 10.49 | cannot (v4 measured 250 writes/s a member) | - / 1.6 / - |
| BUY | 2.80 | 16.62 | 635 | - / 2.5 / 1.1 |
| OBJ on S3 Express One Zone (one zone: not the same durability) | - | 36.01 | 440 | - |

### Fan-out to subscribers outside the platform (added to every row alike)

| each subscriber receives | GB a month | Fly, to North America or Europe | AWS |
|---|---|---|---|
| all of the writes | 2628 | $52.56 | $236.52 |
| a tenth of the writes | 263 | $5.26 | $23.65 |
| a hundredth of the writes | 26 | $0.53 | $2.37 |

### Against DEP-21's bars (Fly)

| candidate | free project asleep (bar $2.19) | free project awake all month, one copy | 10 writes/s (bar $10), subscribers inside | 10 writes/s, subscribers outside and each gets every write |
|---|---|---|---|---|
| MIN | 0.19 ok | 2.34 OVER | 7.26 ok | 59.82 OVER |
| MIN-TS | 0.19 ok | 2.34 OVER | 7.26 ok | 59.82 OVER |
| MIN-P | 0.19 ok | 2.34 OVER | 7.26 ok | 59.82 OVER |
| RUST | 0.19 ok | 2.34 OVER | 7.26 ok | 59.82 OVER |
| SIDE | 0.19 ok | 2.34 OVER | 7.26 ok | 59.82 OVER |
| LEAN | 0.19 ok | 2.34 OVER | 7.26 ok | 59.82 OVER |
| DRAFT | 0.04 ok | 2.19 ok | 4.94 ok | 57.50 OVER |
| CELL | 0.04 ok | 2.19 ok | 4.94 ok | 57.50 OVER |
| LANE | 0.04 ok | 2.19 ok | 4.94 ok | 57.50 OVER |
| SPLIT | 0.04 ok | 2.19 ok | 4.94 ok | 57.50 OVER |
| SLOG | 0.04 ok | 2.19 ok | 5.00 ok | 57.56 OVER |
| RLOG | 0.04 ok | 2.19 ok | 5.00 ok | 57.56 OVER |
| OBJ | 0.04 ok | 2.19 ok | 135.80 OVER | 188.36 OVER |
| EMB-V8 | 0.00 ok | 1.42 ok | 5.86 ok | 58.42 OVER |
| SRV | 0.23 ok | 4.53 OVER | 11.64 OVER | 64.20 OVER |
| ISR | 0.19 ok | 2.34 OVER | 7.26 ok | 59.82 OVER |
| PD | 0.23 ok | 6.72 OVER | 18.21 OVER | 70.77 OVER |
| V4 | 0.19 ok | 2.34 OVER | 7.02 ok | 59.58 OVER |
| BUY | 0.60 ok | 8.91 OVER | 15.90 OVER | 68.46 OVER |

### What the money goes on (Fly)

- **MIN, a sleeping free project:** 1 stopped machine(s), root filesystem only $0.04; 1 volume(s) of 1 GB $0.15; object store: 0 GB kept, 0k uploads $0.00. 
- **MIN, 10 writes/s of 1 KB, 100 subscribers:** 3 x shared-cpu-1x 256 MB (fold) $6.57; 3 x 1 GB volume $0.45; object store: 1 GB kept, 44k uploads $0.24. 
- **MIN, 5,000 writes/s of 1 KB:** 3 x performance-1x 2 GB (fold) $99.00; 3 x 21 GB volume $9.45; object store: 433 GB kept, 205k uploads $9.69. 
- **LEAN, a sleeping free project:** 1 stopped machine(s), root filesystem only $0.04; 1 volume(s) of 1 GB $0.15; object store: 0 GB kept, 0k uploads $0.00. 
- **LEAN, 10 writes/s of 1 KB, 100 subscribers:** 2 x shared-cpu-1x 256 MB (fold) $4.38; 2 x 1 GB volume $0.30; 1 x shared-cpu-1x 256 MB (log only) $2.19; 1 x 1 GB volume $0.15; object store: 1 GB kept, 44k uploads $0.24. 
- **LEAN, 5,000 writes/s of 1 KB:** 2 x performance-1x 2 GB (fold) $66.00; 2 x 21 GB volume $6.30; 1 x performance-1x 2 GB (log only) $33.00; 1 x 21 GB volume $3.15; object store: 433 GB kept, 205k uploads $9.69. 
- **DRAFT, a sleeping free project:** 1 stopped machine(s), root filesystem only $0.04; share of 1 log-tier node(s) (0.000% each) $0.00; object store: 0 GB kept, 0k uploads $0.00. 
- **DRAFT, 10 writes/s of 1 KB, 100 subscribers:** 2 x shared-cpu-1x 256 MB (fold) $4.38; 2 x 1 GB volume $0.30; share of 1 log-tier node(s) (0.020% each) $0.03; object store: 1 GB kept, 44k uploads $0.24. 
- **DRAFT, 5,000 writes/s of 1 KB:** 2 x performance-1x 2 GB (fold) $66.00; 2 x 21 GB volume $6.30; share of 1 log-tier node(s) (10.000% each) $14.10; object store: 433 GB kept, 205k uploads $9.69. 
- **SLOG, a sleeping free project:** 1 stopped machine(s), root filesystem only $0.04; share of 3 log-tier node(s) (0.000% each) $0.00; object store: 0 GB kept, 0k uploads $0.00. 
- **SLOG, 10 writes/s of 1 KB, 100 subscribers:** 2 x shared-cpu-1x 256 MB (fold) $4.38; 2 x 1 GB volume $0.30; share of 3 log-tier node(s) (0.020% each) $0.08; object store: 1 GB kept, 44k uploads $0.24. 
- **SLOG, 5,000 writes/s of 1 KB:** 2 x performance-1x 2 GB (fold) $66.00; 2 x 21 GB volume $6.30; share of 3 log-tier node(s) (10.000% each) $42.30; object store: 433 GB kept, 205k uploads $9.69. 
- **OBJ, a sleeping free project:** 1 stopped machine(s), root filesystem only $0.04; object store: 0.0M commit PUTs, 0 GB kept $0.00. 
- **OBJ, 10 writes/s of 1 KB, 100 subscribers:** 2 x shared-cpu-1x 256 MB (fold) $4.38; object store: 26.3M commit PUTs, 1 GB kept $131.42. 
- **OBJ, 5,000 writes/s of 1 KB:** 2 x performance-1x 2 GB (fold) $66.00; object store: 262.8M commit PUTs, 433 GB kept $1322.66. 
- **EMB-V8, a sleeping free project:** share of 3 pooled servers (0.00% each) $0.00; disk on the pooled servers $0.00; object store: 0 GB kept, 0k uploads $0.00. 
- **EMB-V8, 10 writes/s of 1 KB, 100 subscribers:** share of 3 pooled servers (0.68% each) $5.17; disk on the pooled servers $0.45; object store: 1 GB kept, 44k uploads $0.24. 
- **EMB-V8, 5,000 writes/s of 1 KB:** share of 3 pooled servers (7.87% each) $60.21; disk on the pooled servers $9.45; object store: 433 GB kept, 205k uploads $9.69. 
- **SRV, a sleeping free project:** 2 stopped machine(s), root filesystem only $0.07; 1 volume(s) of 1 GB $0.15; object store: 0 GB kept, 0k uploads $0.00. 
- **SRV, 10 writes/s of 1 KB, 100 subscribers:** 3 x shared-cpu-1x 256 MB (fold) $6.57; 3 x 1 GB volume $0.45; 2 x shared-cpu-1x 256 MB (the app) $4.38; object store: 1 GB kept, 44k uploads $0.24. 
- **SRV, 5,000 writes/s of 1 KB:** 3 x performance-1x 2 GB (fold) $99.00; 3 x 21 GB volume $9.45; 2 x shared-cpu-1x 256 MB (the app) $4.38; object store: 433 GB kept, 205k uploads $9.69. 
- **BUY, a sleeping free project:** 4 stopped machine(s), root filesystem only $0.15; 3 volume(s) of 1 GB $0.45. 
- **BUY, 10 writes/s of 1 KB, 100 subscribers:** 3 x shared-cpu-1x 512 MB (log only) $11.07; 3 x 1 GB volume $0.45; 2 x shared-cpu-1x 256 MB (the app, which folds) $4.38. 
- **BUY, 5,000 writes/s of 1 KB:** 3 x performance-1x 2 GB (log only) $99.00; 3 x 21 GB volume $9.45; 2 x shared-cpu-1x 2048 MB (the app, which folds) $25.38. 

### Sensitivity: 5,000 writes/s over 10 GB of rows (1e7 rows), Fly

| candidate | $ a month | what |
|---|---|---|
| MIN | 379 | 3 x performance-1x 16 GB (fold) $351; 3 x 41 GB volume $18; object store: 442 GB kept, 205k uploads $10 |
| LEAN | 295 | 2 x performance-1x 16 GB (fold) $234; 2 x 41 GB volume $12; 1 x performance-1x 2 GB (log only) $33; 1 x 41 GB volume $6; object store: 442 GB kept, 205k uploads $10 |
| DRAFT | 270 | 2 x performance-1x 16 GB (fold) $234; 2 x 41 GB volume $12; share of 1 log-tier node(s) (10.000% each) $14; object store: 442 GB kept, 205k uploads $10 |
| SLOG | 298 | 2 x performance-1x 16 GB (fold) $234; 2 x 41 GB volume $12; share of 3 log-tier node(s) (10.000% each) $42; object store: 442 GB kept, 205k uploads $10 |
| EMB-V8 | 618 | share of 3 pooled servers (77.06% each) $589; disk on the pooled servers $18; object store: 442 GB kept, 205k uploads $10 |

### Sensitivity: SLOG or RLOG with one server, Fly, 5,000 writes/s

- $88 a month, 0.75 x MIN. A failover then rebuilds 1 GB of rows from the log: about 36 s (E-05), against F-05's 2.5 s. So the two-server shape is the one that meets the MUSTs.

### The same on AWS, 5,000 writes/s

- **MIN:** 3 x c7g.medium (fold) $79.50; 3 x 21 GB volume $5.04; replication across zones (2 crossings of 13140 GB) $525.60; object store: 433 GB kept, 205k uploads $10.99.
- **LEAN:** 2 x c7g.medium (fold) $53.00; 2 x 21 GB volume $3.36; 1 x c7g.medium (log only) $26.50; 1 x 21 GB volume $1.68; replication across zones (2 crossings of 13140 GB) $525.60; object store: 433 GB kept, 205k uploads $10.99.
- **DRAFT:** 2 x c7g.medium (fold) $53.00; 2 x 21 GB volume $3.36; share of 1 log-tier node(s) (10.000% each) $14.10; replication across zones (2 crossings of 13140 GB) $525.60; object store: 433 GB kept, 205k uploads $10.99.
- **SLOG:** 2 x c7g.medium (fold) $53.00; 2 x 21 GB volume $3.36; share of 3 log-tier node(s) (10.000% each) $42.30; replication across zones (2 crossings of 13140 GB) $525.60; object store: 433 GB kept, 205k uploads $10.99.
- **OBJ:** 2 x c7g.medium (fold) $53.00; object store: 262.8M commit PUTs, 433 GB kept $1323.96;   (the same on S3 Express One Zone, one zone only) $0.00.

### The threshold

- **Fly, 5,000 writes/s:** the cheapest is EMB-V8 ($79). OBJ is $1389 (17.5 x the cheapest row that is not OBJ or SLOG); SLOG is $124 (1.57 x). Neither is cheaper than the rest by 2 x, so the hosted shape is not reopened on cost.
  - more than 2 x the cheapest at 10 writes/s of 1 KB, 100 subscribers: OBJ (27.5 x), SRV (2.4 x), PD (3.7 x), BUY (3.2 x)
  - more than 2 x the cheapest at 5,000 writes/s of 1 KB: OBJ (17.5 x)
- **AWS, 5,000 writes/s:** the cheapest is EMB-V8 ($602). OBJ is $1377 (2.3 x the cheapest row that is not OBJ or SLOG); SLOG is $635 (1.06 x). Neither is cheaper than the rest by 2 x, so the hosted shape is not reopened on cost.
  - more than 2 x the cheapest at 10 writes/s of 1 KB, 100 subscribers: OBJ (20.5 x), SRV (2.5 x), PD (3.9 x), BUY (2.5 x)
  - more than 2 x the cheapest at 5,000 writes/s of 1 KB: OBJ (2.3 x)
- **The $10 bar and fan-out:** with subscribers outside Fly, MIN stays under $10 only if each subscriber receives at most 5.2% of the writes (DRAFT: 9.6%).
