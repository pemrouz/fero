# raft-harness

Test tooling for the [raft](../raft) crate. It is never shipped.

| File | What it is |
|---|---|
| [src/datadriven.rs](src/datadriven.rs) | The reader for cockroachdb/datadriven's file format, and the byte-for-byte check. The first mismatch in a file ends that file, as in Go. |
| [src/gofmt.rs](src/gofmt.rs) | The small part of Go's `fmt` the expected outputs need. |
| [src/quorum_dd.rs](src/quorum_dd.rs) | etcd's quorum test driver. |
| [src/confchange_dd.rs](src/confchange_dd.rs) | etcd's confchange test driver. |
| [src/rafttest](src/rafttest) | etcd's `InteractionEnv`, which drives whole clusters: one module per Go file, all 21 handler files. |
| [src/bin/raft-datadriven.rs](src/bin/raft-datadriven.rs) | Runs every file. |
| [src/diff.rs](src/diff.rs), [src/bin/raft-diff.rs](src/bin/raft-diff.rs), [diff/](diff/README.md) | The differential fuzz: random scripts filled in by etcd's Go code, replayed on the port byte for byte. Adds `read-index` and `restart`. |
| [tests/edge_values.rs](tests/edge_values.rs), [diff/zz_edge_values_test.go](diff/zz_edge_values_test.go) | The edge value check: messages with fields from the two ends of `u64`, stepped into one node, compared with Go by a hash. It finds a `+ 1` that panics where Go wraps. Runs with `cargo test --release`. |
| [scripts/negative-control.sh](scripts/negative-control.sh) | Proves the check can fail: three files with one corrupted line each must be the only new failures. |

## Run

    cargo run -q --release -p raft-harness --bin raft-datadriven
    cargo run -q --release -p raft-harness --bin raft-datadriven -- --verbose --diff
    cargo test --release
    sh crates/raft-harness/scripts/negative-control.sh
    RAFT_SRC=<etcd raft checkout> WORK=<scratch dir> sh crates/raft-harness/diff/run_diff.sh corpus

The first command ends with `ok raft: 41 of 41 etcd files` when every file
passes. Otherwise it prints one `FAIL <file> at <file:line>: <why>` line per
failing file, then `FAIL raft: N of 41 etcd files`, and exits 1.
