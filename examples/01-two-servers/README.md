# 01 · One file, run it twice

The whole config is `server: true`. Run the same file in two terminals and you have one replicated
object: each copy finds the other by name through the box's directory, and each writes its own row by
plain assignment. Ctrl-C one and the other carries on alone; start it again and the newcomer joins.

## Terminals

```sh
cd examples/01-two-servers
node server.ts          # terminal 1
node server.ts          # terminal 2
node check.ts           # proves it: form, stop one, the other keeps committing, a new copy joins and catches up
```

Then Ctrl-C terminal 2, watch terminal 1 carry on, and run `node server.ts` in terminal 2 again.

Node 22.18+ or 23.6+ (type stripping is built in — no flags).

## What you should see

Terminal 1, from a real run — terminal 2 started at `ticks 2`, Ctrl-C'd at `ticks 4`, started again at
`ticks 9`:

```
{}
members 0 writable true — I am 7796ce4a on 127.0.0.1:38763
{"7796ce4a":{"ticks":1}}
{"7796ce4a":{"ticks":2}}
members 2 writable true — I am 7796ce4a on 127.0.0.1:38763
{"7796ce4a":{"ticks":2},"61f4a2a2":{"ticks":1}}
{"7796ce4a":{"ticks":3},"61f4a2a2":{"ticks":1}}
{"7796ce4a":{"ticks":4},"61f4a2a2":{"ticks":3}}
members 1 writable true — I am 7796ce4a on 127.0.0.1:38763
{"7796ce4a":{"ticks":5},"61f4a2a2":{"ticks":3}}
{"7796ce4a":{"ticks":9},"61f4a2a2":{"ticks":3}}
members 2 writable true — I am 7796ce4a on 127.0.0.1:38763
{"7796ce4a":{"ticks":9},"61f4a2a2":{"ticks":3},"3894e2e7":{"ticks":1}}
{"7796ce4a":{"ticks":10},"61f4a2a2":{"ticks":3},"3894e2e7":{"ticks":1}}
```

The first line is the empty object at attach. `members 0` is a copy on its own (no view yet, still
writable); `members 2` is the committed view — from then on each copy's row appears on the other screen
one tick after it is written. Ctrl-C terminal 2: `members 1 writable true` prints at once, because a
clean stop is not a crash — `destroy()` asks for a view without itself and waits for the vote (about
10 ms), so the survivor keeps committing alone. Terminal 2 itself prints `members 1 writable false` just
before it exits: it is out, on purpose. Start the file again: the newcomer is voted in (`members 2`),
replays the history line by line (the stopped copy's row included), and its own row appears everywhere.

Terminal 2's second life, same run:

```
{}
members 0 writable true — I am 3894e2e7 on 127.0.0.1:43725
{"7796ce4a":{"ticks":1}}
{"7796ce4a":{"ticks":2}}
members 1 writable false — I am 3894e2e7 on 127.0.0.1:43725
{"7796ce4a":{"ticks":2},"61f4a2a2":{"ticks":1}}
{"7796ce4a":{"ticks":8},"61f4a2a2":{"ticks":3}}
members 2 writable true — I am 3894e2e7 on 127.0.0.1:43725
{"7796ce4a":{"ticks":9},"61f4a2a2":{"ticks":3},"3894e2e7":{"ticks":1}}
```

`members 1 writable false` is the newcomer hearing the survivor's one-member view and knocking to be let
in; `members 2 writable true` is the vote landing. Its own writes wait in between and flush then.

## Shows

- `fero('hello', { server: true })` — a server by declared act: a free loopback port, registered under `'hello'`.
- `f.data[me] = { ticks: n }` — plain assignment is the write; the top-level key is a row.
- `f.data.tap(() => …)` and `f.snapshot` — the render loop; never `JSON.stringify(f.data)`.
- `f.cluster.tap(…)` and `f.cluster.snapshot()` — `members`, `writable`, `me.listen` (through `coalesce`:
  the view's fields land one record at a time).
- `destroy()` — the exit protocol: it LEAVES (a ballot shrinks the view) before the sockets close; Ctrl-C
  runs it through `onExit`.

## Deliberately does NOT show

A client (02), a seed (02), what a write looks like on the wire (03, 04), views over the rows (05),
surviving a crash (13), the same node coming back after a restart (12).

## Honest limits

- A stopped copy that starts again is a NEW identity: a new uuid, a new row; the old row stays (nobody
  deletes it). The same node across restarts needs `dir` (12).
- Two copies survive a clean stop, not a crash. `kill -9` one and the survivor prints `writable false`
  and waits: a dead member's vote is gone, and changing a view needs a majority of the OLD view, so
  nothing can shrink it and no newcomer can be admitted. Three members plus `dir` is the deployment rule
  (13).
- The newcomer applies the others' whole history one record at a time; nothing is compacted while a copy
  runs alone (compaction needs a view).
