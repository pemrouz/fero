# sim-run

The native runner of the simulator. No Node, no fold: the fast loop for
kernel rules.

    cargo run -q --release -p sim-run -- seeds <start> <count>          # one line per seed: seed, events, trace hash
    cargo run -q --release -p sim-run -- fresh <start> <count>          # the same for the fresh-world scenario
    cargo run -q --release -p sim-run -- time  <start> <count> <reps>   # times the seeds, one line per repeat

The lines of `seeds` are what probe P2's byte check compares with the WASM
build's: [probes/p2](../../probes/p2/README.md).

It is a crate of its own so that the `sim` library stays free of `std`.
