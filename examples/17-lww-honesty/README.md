# 17 · What last-writer-wins loses

One terminal, one run:

```
$ cd examples/17-lww-honesty
$ node race.ts
two increments of 0, stamped a:2 and a:3 → count is 1 on a, 1 on b
two facts { n: 1 }, stamped a:4 and b:4 → sum is 2 on a, 2 on b
```

- `a` and `b` are two members in one process, so every read and write happens in a known order. Both read
  `count` (0), both write it back plus one. One member owns the cell and stamps both writes in turn — `a:2`,
  then `a:3` — and a cell keeps its last stamp: fero is last-writer-wins, per cell. Neither write knew about
  the other, so both said 1. One increment is gone, and nothing reports it.
- The fix is the model, not a lock. Write what happened, not the total: one row per increment, never
  rewritten, and a fold over the rows — `data.sum('n')` — is 2 on every member, under any interleaving.
  Each fact row has one writer: the series' rule 1, and the other fix — give a cell one writer, and its
  increments happen in turn. A hosted method is not a compare-and-swap either: it runs on the server the
  caller reached, over that server's copy.
- The writes are `methods.update(…, { confirm: 'replicated' })` — the same write as assignment, awaited
  until both members hold it. Before the first view forms each member stamps for itself, and the same race
  still loses one; the file waits for the view so the story is the same every run.

```sh
node race.ts --fero.heartbeat.ms 50    # sooner: the view and every 'replicated' settle on the heartbeat
for i in 1 2 3; do node race.ts; done  # the same numbers every run: the loss is the model, not luck
```

`node check.ts` runs this story on its own and ends with `ok 17-lww-honesty`, in about ten seconds.
Next: [20 · looking inside](../20-inside/).
