# 01 · One file, run it twice

```sh
cd examples/01-two-servers
node server.ts     # terminal 1
node server.ts     # terminal 2 — then Ctrl-C it, and run it again
node check.ts      # proves it, about 11 s, on its own private directory (your terminals are not touched)
```

Terminal 1 from a real run. Terminal 2 started at `ticks 2`, got Ctrl-C at `ticks 6`, and a third copy was
started at `ticks 10`:

```
pid 651328 members 0 writable true {}
pid 651328 members 0 writable true { '651328': { ticks: 1 } }
pid 651328 members 0 writable true { '651328': { ticks: 2 } }
pid 651328 members 2 writable true { '651328': { ticks: 3 } }                          ← terminal 2 is in
pid 651328 members 2 writable true { '651328': { ticks: 3 }, '651370': { ticks: 1 } }  ← and here is its row
pid 651328 members 2 writable true { '651328': { ticks: 6 }, '651370': { ticks: 3 } }
pid 651328 members 1 writable true { '651328': { ticks: 7 }, '651370': { ticks: 3 } }  ← Ctrl-C terminal 2: it left, its row stays
pid 651328 members 1 writable true { '651328': { ticks: 10 }, '651370': { ticks: 3 } }
pid 651328 members 2 writable true {                                                   ← node server.ts again: a new pid joins
  '651328': { ticks: 10 },
  '651370': { ticks: 3 },
  '651524': { ticks: 1 }
}
```

What is going on:

- `fero('hello', { server: true })` is the whole setup. Each copy picks a free port and registers the name
  `hello` with the directory on your box; that is how the copies find each other. No addresses in the code.
- Each copy owns one row, keyed by its pid, and writes it once a second: `f.data[process.pid] = { ticks: n }`.
  Plain assignment is the write. Every screen shows the same object, one line per change.
- `f.data.tap(...)` runs once now and again on every change that lands; `f.snapshot` is the plain object.
  `members` is how many copies are in the agreed group (`0` = alone, still writable). The screen redraws on
  data changes, so `members` catches up at the next tick.
- Ctrl-C is a clean stop, built in: the copy asks the group to shrink before it exits, so the other one shows
  `members 1 writable true` at its next tick and keeps counting. Run the file again: a new pid is voted in
  and catches up on everything, the stopped copy's old row included (it prints `members 1 writable false`
  for a moment while the vote runs).
- `kill -9` instead and the survivor sits at `members 2 writable false`: two cannot outvote a member that
  just went quiet. Its own ticks still print (they wait in its log), nothing commits. Ctrl-C it and it gives
  up after a couple of seconds and exits 0.

Scale it — the same file, nothing added:

- Down: run it once. `members 0 writable true`, one row counting on its own. Alone, a stop forgets
  everything: this copy is memory-only.
- Three copies: three rows on three screens — and now `kill -9` one: the two left keep writing and vote it
  out after about 20 seconds (`members 2 writable true`). That is why three is the deployment rule (13).
- A client: `fero('hello')` with no options, in any file, follows these rows and can write its own — that
  is [02](../02-server-client/).
- Durable: `{ server: true, dir: './copy-1' }` (one folder per copy) and a copy comes back after a restart as
  itself, with its rows, on a fresh port (12).

Next: [02 · a shop and its watchers](../02-server-client/).
