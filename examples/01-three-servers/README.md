# 01 · One file, run it three times

The whole config is `server: true`. Run the same file in three terminals and you have one replicated
object: each copy finds the others by name through the box's directory, and each writes its own row by
plain assignment. Kill any one and the other two keep going; start it again and the newcomer joins.

## Terminals

```sh
cd examples/01-three-servers
node server.ts          # terminal 1
node server.ts          # terminal 2
node server.ts          # terminal 3
node check.ts           # proves it: form, kill one, keep committing, a new copy joins and catches up
```

Then Ctrl-C terminal 2 (a clean stop: the view shrinks to `members 2` at once), watch terminals 1 and 3
carry on, and run `node server.ts` in terminal 2 again (`members 3`).

Node 22.18+ or 23.6+ (type stripping is built in — no flags).

## What you should see

Terminal 1 during `node check.ts`, from a real run (the others print the mirror image):

```
{}
members 0 writable true — I am 2b8b6e9b on 127.0.0.1:39681
members 3 writable true — I am 2b8b6e9b on 127.0.0.1:39681
{"89a4115e":{"ticks":1}}
{"89a4115e":{"ticks":1},"17f0c17b":{"ticks":1}}
{"89a4115e":{"ticks":1},"17f0c17b":{"ticks":1},"2b8b6e9b":{"ticks":1}}
{"89a4115e":{"ticks":2},"17f0c17b":{"ticks":1},"2b8b6e9b":{"ticks":1}}
{"89a4115e":{"ticks":2},"17f0c17b":{"ticks":1},"2b8b6e9b":{"ticks":2}}
{"89a4115e":{"ticks":3},"17f0c17b":{"ticks":1},"2b8b6e9b":{"ticks":2}}
members 4 writable true — I am 2b8b6e9b on 127.0.0.1:39681
```

The first line is the empty object at attach. `members N` is the committed view — from then on each
copy's row appears on the other screens one tick after it is written. Kill one copy: `writable` stays
`true` (two of three is a majority) and the survivors keep committing. Start the file again: the newcomer
joins at once (`members 4` — the dead member is still in the view), replays the others' history line by
line (anti-entropy catch-up), and its new row appears everywhere; the dead member is evicted once its
redials give up (about 20 s at the default settings), and `members 3` prints again.

Two copies and a clean stop — terminal 1, from a real run with only terminals 1 and 2 open; Ctrl-C
terminal 2 at `ticks 4`, start it again at `ticks 9`:

```
members 2 writable true — I am 7796ce4a on 127.0.0.1:38763
{"7796ce4a":{"ticks":4},"61f4a2a2":{"ticks":3}}
members 1 writable true — I am 7796ce4a on 127.0.0.1:38763
{"7796ce4a":{"ticks":5},"61f4a2a2":{"ticks":3}}
{"7796ce4a":{"ticks":9},"61f4a2a2":{"ticks":3}}
members 2 writable true — I am 7796ce4a on 127.0.0.1:38763
{"7796ce4a":{"ticks":9},"61f4a2a2":{"ticks":3},"3894e2e7":{"ticks":1}}
```

Ctrl-C is not a crash: `destroy()` asks the others for a view without it and waits for the vote (about
10 ms here), so the survivor prints `members 1 writable true` and keeps committing alone, and the restarted
copy is voted in as `members 2`. Terminal 2 itself prints `members 1 writable false` just before it exits —
it is out, on purpose. Compare the crash above: there the dead member lingers in the view for ~20 s.

## Shows

- `fero('hello', { server: true })` — a server by declared act: a free loopback port, registered under `'hello'`.
- `f.data[me] = { ticks: n }` — plain assignment is the write; the top-level key is a row.
- `f.data.tap(() => …)` and `f.snapshot` — the render loop; never `JSON.stringify(f.data)`.
- `f.cluster.tap(() => …)` and `f.cluster.snapshot()` — `members`, `writable`, `me.listen`.
- `destroy()` — the exit protocol: it LEAVES (a ballot shrinks the view) before the sockets close; Ctrl-C
  runs it through `onExit`.

## Deliberately does NOT show

A client (02), a seed (02), what a write looks like on the wire (03, 04), views over the rows (05),
the same node coming back after a restart (12).

## Honest limits

- A stopped copy that starts again is a NEW identity: a new uuid, a new row; the old row stays (nobody
  deletes it) and the old member is evicted. The same node across restarts needs `dir` (12).
- Two copies replicate, and one of two can STOP cleanly (Ctrl-C leaves by ballot; the other carries on;
  a newcomer joins). But two cannot lose one to a CRASH (`kill -9`, a pulled plug): a dead member's vote
  is gone and changing a view needs a majority of the OLD view, so the survivor prints `writable false`,
  its writes wait, and no newcomer can be admitted. Run three (13 is the full deployment rule: three
  members plus `dir`).
- The newcomer applies the others' whole history one record at a time; nothing is compacted while a copy
  runs alone (compaction needs a view).
