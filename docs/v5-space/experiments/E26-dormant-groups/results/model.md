# E-26 (model): 1,000 sleeping projects (10652 resources, 1-20 per project, seeded)

Quiet group memory from E-11 (RSS growth per group at 10,000 groups): TS 16 KB, Go 6.5 KB, Rust 4.0 KB. Dormant group memory, measured here: not yet measured.

| candidate | N | groups in all | groups per log-tier process, k = 3 | k = 6 | memory per process, quiet groups in memory (TS / Rust), k = 3 | with dormant groups, k = 3 | note |
|---|---|---|---|---|---|---|---|
| MIN, RUST, MIN-TS, LEAN, SRV, SIDE | proc | 11,652 | 0 (a sleeping project has no process; its groups are on its own disk or in the object store) | 0 | 0 | 0 | a group per resource + `#meta` per project (decision 17a) |
| DRAFT | tier | 11,652 | 11,652 | 5,826 | 0.19 GB / 0.05 GB | - | a group per resource + `#meta` per project |
| DRAFT with one shared metadata group (17b) | tier | 10,653 | 10,653 | 5,326 | 0.17 GB / 0.04 GB | - | a group per resource; one `#meta` for the tier |
| MIN-P | proc | 2,000 | 0 (a sleeping project has no process; its groups are on its own disk or in the object store) | 0 | 0 | 0 | one project group (small projects) + `#meta` |
| MIN-P on a tier | tier | 2,000 | 2,000 | 1,000 | 0.03 GB / 0.01 GB | - | one project group + `#meta` |
| CELL | tier | 171,432 | 171,432 | 85,716 | 2.74 GB / 0.69 GB | - | 16 cells per resource |
| LANE | tier | 65,000 | 65,000 | 32,500 | 1.04 GB / 0.26 GB | - | 64 lanes per project |
| SPLIT | tier | 11,652 | 11,652 | 5,826 | 0.19 GB / 0.05 GB | - | one range per resource at rest |
| SLOG | tier | 10,652 | 10,652 | 5,326 | 0.17 GB / 0.04 GB | - | a log group per resource; metadata in the controller |
| RLOG | tier | 11,652 | 11,652 | 5,826 | 0.19 GB / 0.05 GB | - | groups run on log members |
| EMB-V8 | pool | 11,652 | 11,652 | 5,826 | 0.19 GB / 0.05 GB | - | a pooled server holds every tenant |
| OBJ | tier | 0 | 0 | 0 | 0.00 GB / 0.00 GB | - | no group in memory: the log is the object store |

The bar (Q-26): 1,000 projects in at most 2 GB per process. A `tier` or `pool` row over 2 GB with quiet groups in memory needs dormant groups (one mechanism) or decision 17b.
