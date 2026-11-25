# sim

The simulation executive. It runs servers that are not real, on a schedule a
seed fixes. The same seed gives the same run, byte for byte, on every machine.

It is built twice from one source. Built native, it runs with no Node: see
[sim-run](../sim-run). Built as WASM, it runs under Node with one hook into
JavaScript: see [wasm](../wasm). Probe P2 checks that the two builds give the
same bytes: [probes/p2](../../probes/p2/README.md).

## Two parts

| Part | Files | What it holds |
|---|---|---|
| The executive | `rng.rs`, `exec.rs`, `net.rs`, `trace.rs`, `num.rs` | The seeded generator, the clock in ticks, the order of steps, crashes, the fake network, the trace hash. It knows nothing about Raft. |
| The probe P2 world | `p2.rs`, `payload.rs` | Three servers, two Raft groups, each replica the ported `raft::RawNode` on a memory disk; the monitors; the probe's payload bytes. |

A **world** is what each server runs. It plugs into the executive through the
`exec::World` trait. The P2 world is a stand-in: the real kernel takes its
place in slice 1.

## One tick

1. maybe crash one server for a while;
2. maybe cut one server's links for a while;
3. restart each server whose time down has ended;
4. hand over each message that is due, in the order it was sent;
5. maybe one client write;
6. tick each live server.

A crashed server keeps only what it saved. A restarted replica applies its
committed entries again from the first one.

## Rules the crate keeps

- `#![no_std]`, with `alloc`. No outside crates; it depends on `raft` only.
- No `unsafe`.
- No `HashMap` or `HashSet`.
- No floats. A chance is a whole number of parts per 1,000.
- No `usize` or `isize` outside `num.rs`. The WASM build is 32-bit and the
  native build is 64-bit.

`tests/rules.rs` reads the source and fails if a rule is broken.

## The feature `trap-width`

Off in every normal build. It hashes a machine-sized number into the trace,
so the two builds must differ. Probe P2 uses it to prove its byte check can
fail.

## Run the tests

    cargo test --release -p sim
