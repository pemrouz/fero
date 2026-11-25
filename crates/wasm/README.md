# wasm

The simulator built as a WASM module, for Node. This is the boundary with
JavaScript on the simulator's side.

- No outside crates. The ABI is plain numbers and one view of bytes; a 64-bit
  number crosses as two 32-bit halves.
- One instance is made once and used for every seed. The world resets inside
  it.
- One import, `fero.batch`: called once per batch of committed entries of one
  replica. It returns nothing.
- `unsafe` appears only where an export or the import is named, each with its
  reason. The import is declared `safe`.

The exports, the import and the shape of a batch are in
[src/lib.rs](src/lib.rs) and in [probes/p2](../../probes/p2/README.md).

Today the module holds the simulator and the probe P2 world. BUILD 2.1 gives
this crate the kernel, the wire and the flow crates too, as they arrive.

## Build it

    cargo build --release -p wasm --target wasm32-unknown-unknown

The module is `target/wasm32-unknown-unknown/release/fero_sim.wasm`.
