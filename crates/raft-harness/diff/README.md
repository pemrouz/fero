# The differential fuzz

Random scripts run on etcd's own Go code, and then on the Rust port. The port must print
the same bytes.

- `gen_scripts.ts` writes random scripts in the datadriven format, with empty outputs.
- `zz_raft_diff_test.go` runs each script on etcd's Go `InteractionEnv` and writes the real outputs.
- `../src/diff.rs` and the `raft-diff` binary replay them on the port.
- `run_diff.sh` does all three. It needs an etcd raft checkout at the vendored commit
  (`RAFT_SRC`), node, go and cargo. Scratch files go to `WORK`.

      RAFT_SRC=<etcd raft checkout> WORK=<scratch dir> sh crates/raft-harness/diff/run_diff.sh corpus

`corpus` is four runs of 1,000 scripts: seeds 2 and 3 (base), seed 5 (`readindex`),
seed 7 (`readindex,restart`). Each run ends with a line that starts `ok raft-diff:`.

Two commands are not etcd harness commands. Both sides add them:

- `read-index <node> <ctx>`: a linearizable read. No etcd file has one.
- `restart <node>`: a crash. The node is built again from its storage, and work queued for
  its append and apply threads is lost. No etcd file restarts a node.

Both sides return 0 for the election jitter, so both are deterministic. On the Go side that
is a three-line patch that `run_diff.sh` applies to its scratch copy. On the Rust side the
random source is handed in, so no patch is needed.

A script where Go panics is cut before that step. The port must panic at the same step.

The generator and the Go driver are study code from the design record's raft port experiment.
Each file says at its top what was changed.

`samples/` holds four Go-filled scripts, one per kind, so that `cargo test` checks the replay
without Go. `regressions/` is for scripts that once found a difference.

Limits (reasoned, from the generator): it never compacts storage at random, it keeps nodes 1
and 2 voters, it never sets the size limits, and `restart` does not bring back the applied
configuration (so a later leave-joint entry can panic, the same on both sides).

## The edge value check

The random scripts only send messages that a correct peer sends. A real peer's message can
hold any number. Go's `uint64` arithmetic wraps; Rust's panics when overflow checks are on
(they are, in every profile here). So where Go wraps, the port must say `wrapping_add` or
`wrapping_sub`, or it is not the same machine.

- `zz_edge_values_test.go` is the Go side. It steps messages with fields from the bottom and
  the top of `uint64` into one node, in four states, and prints the node after each step, or
  `P` when Go panics. It prints the number of cases and a hash of all the lines.
- `../tests/edge_values.rs` builds the same lines on the port and wants the same hash. It runs
  with `cargo test --release`: 1,035,000 single messages and 500,000 runs of four messages.

The first run found three places where Go wraps and the port panicked (measured): a leader
that gets an append answer for the top index (`Progress::maybe_update`, then
`become_replicate` and `maybe_send_append`), and with runs of messages the other `+ 1` and
`- 1` on `Match` and `Next`, and `Unstable::maybe_last_index`. They wrap now.

Limits (reasoned): one node, at most four messages, no storage writes between them, values
only from the two ends of the range. Two overflow panics are left where Go also panics at the
same step, for its own reason: a campaign at the top term, and a snapshot at the top index.
