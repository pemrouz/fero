# raft

etcd's Raft library, ported to Rust. Raft is how a group of servers agrees on
one log of records, even when some of them crash.

The port is **faithful**. It keeps Go's names, order and control flow, with one
Rust module per Go file. The Go source at commit `c51f010` is the reference:
when in doubt, the Go code is right. See [NOTICE](NOTICE) for the source, the
licence and what was left out.

## What it is

A pure state machine. It does no I/O, reads no clock and draws no random
number on its own. The host feeds it ticks and messages and reads back what to
save, send and apply.

## Rules the crate keeps

- `#![no_std]`, with `alloc`. No outside crates.
- `#![forbid(unsafe_code)]`.
- No `HashMap` or `HashSet`: their order can change between runs. Sorted maps
  and sets are used where Go uses a map.
- No `usize`, `isize` or floats in state or messages. Terms, indexes and ids
  are `u64`, as in Go. The one file that names `usize` is
  [src/num.rs](src/num.rs), the bridge to slice positions. (The WASM build is
  32-bit, so a machine-sized integer would change meaning there.)

A test in `raft-harness` (`tests/rules.rs`) reads the source and fails if a
rule is broken.

## The messages

`raftpb`'s messages are plain Rust structs for now. They follow `raft.proto`
field for field. An optional field is an `Option`; `get_x()` gives the zero
value when it is absent, as Go's getters do. The real byte shapes on the wire
come later, in a `wire` crate (slice 1). The only encoding kept here is what
Raft itself depends on: conf changes ride inside entries as bytes, and limits
count an entry's encoded size.

## How the port maps Go to Rust

| Go | Rust |
|---|---|
| `MaybeUpdate`, `maybeUpdate` | `maybe_update` (exported: `pub`; unexported: private or `pub(crate)`) |
| `pb.MsgHup`, `pb.ConfChangeAddNode` | the same names, as constants |
| `map[uint64]struct{}` | `BTreeSet<u64>`; where Go tells a nil map from an empty one, `Option<BTreeSet<u64>>` |
| `map[uint64]*Progress` | `BTreeMap<u64, Progress>` (the map owns the values) |
| `(x, ok)` | `Option<x>` |
| `(a, b, error)` | `Result<(a, b), Error>` |
| `int` in state | `u64` for counts and sizes; `i64` for tick counts (Go compares them with zero and subtracts them) |
| `fmt.Sprintf("%x ...")` | `core::fmt` (`{:x}`), with `String()` as `Display` |
| `panic(...)` | `panic!(...)` |
| `l.logger.Panicf(...)` | `self.logger.panicf(format_args!(...))`, which never returns |
| `Storage` interface | a `Storage` trait; the log, `Raft`, `RawNode` and `Config` are generic over it |
| `r.step = stepLeader`, `r.tick = r.tickHeartbeat` (function values) | two small enums, `StepFn` and `TickFn` |
| `pr := r.trk.Progress[id]` held across calls | looked up again by id after a call that changes the Raft struct |
| `globalRand` (a locked `crypto/rand`) | injected: `Config::rand`, the trait `Rand` |
| `Step(m *pb.Message)` | `step(m: pb::Message)`: the message is handed over |
| `raft.None` | `NONE` (Rust's `Option` owns the name `None`) |
| unsigned arithmetic | checked in every build profile; where Go's wrap-around is meant, `wrapping_*` says so |

## What is ported

| Go | Here | State |
|---|---|---|
| `quorum` | [src/quorum](src/quorum) | done; etcd's 4 files pass |
| `tracker` | [src/tracker](src/tracker) | done |
| `confchange` | [src/confchange](src/confchange) | done; etcd's 9 files pass |
| `raftpb` | [src/raftpb](src/raftpb) | types, getters, conf change helpers, the encoding Raft needs |
| `logger.go`, `types.go` | [src/logger.rs](src/logger.rs), [src/types.rs](src/types.rs) | done |
| `log_unstable.go`, `log.go` | [src/log_unstable.rs](src/log_unstable.rs), [src/log.rs](src/log.rs) | done; 5 of Go's log tests ported and passing |
| `storage.go` | [src/storage.rs](src/storage.rs) | done |
| `read_only.go` | [src/read_only.rs](src/read_only.rs) | done |
| `util.go` | [src/util.rs](src/util.rs) | done |
| `raft.go` | [src/raft.rs](src/raft.rs) | done; the trace hooks are left out |
| `rawnode.go` | [src/rawnode.rs](src/rawnode.rs) | done |
| `status.go`, `bootstrap.go` | [src/status.rs](src/status.rs), [src/bootstrap.rs](src/bootstrap.rs) | done |
| `node.go` | [src/node.rs](src/node.rs) | only what the core needs: `SoftState`, `Ready`, `Peer`, `SnapshotStatus` and helpers. The goroutine `Node` is left out. |

Two files are not Go files: [src/num.rs](src/num.rs) and
[src/gostd.rs](src/gostd.rs). They hold what Go's `int` and Go's standard
library give for free.

## Known costs of this round

- Entries and messages are copied where Go shares pointers (`Ready` copies
  the outgoing messages and the entries). The contents are the same. Making
  an entry's data cheap to share is left to slice 1, with the wire crate.
- A conf change copies the whole progress tracker (Go copies the struct and
  shares the `Inflights`).

## Tests

etcd's 41 datadriven files are under [testdata](testdata), unchanged
([PROVENANCE.md](testdata/PROVENANCE.md)). Run them all with:

    cargo run -q --release -p raft-harness --bin raft-datadriven

It ends with `ok raft: 41 of 41 etcd files` when every file passes byte for
byte. Today 41 of 41 pass (measured).
