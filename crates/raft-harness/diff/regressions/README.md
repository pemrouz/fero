# Regression scripts of the differential fuzz

A script goes here when the fuzz finds a place where the port and etcd's Go code differ.
It is the shortest failing script, with Go's outputs filled in. It stays as a permanent test.

- `<name>.txt`: the script with Go's outputs.
- `<name>.txt.panic` and `in/<name>.txt`: only when Go panics in the script. The note names the
  step; `in/` holds the script as generated, with the step that panics still in it.

`cargo test -p raft-harness --test diff` replays every file here and in `../samples`.

Today this folder holds no script: the first run of the 4,000 scripts found no difference (measured).
