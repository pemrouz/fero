# 06 · Live numbers

One terminal, one run. Five sales are rung up, and every number on the screen is a fold over the rows:

```
$ cd examples/06-numbers
$ node server.ts
nothing = 0
3 = 3
3 + 8 = 11
3 + 8 + 4 = 15
3 + 8 + 4 + 9 = 24
3 + 8 + 4 + 9 + 6 = 30
{ n: 5, avg: 6, min: 3, max: 9, median: 6, p75: 8, big: 23, cash: 50 }
```

- A sale is a fact. `till.data['sale-<pid>-<n>'] = { amount }` is a NEW row for every sale, written once and
  never edited — two sales of 9 would be two rows. The rows are the truth, and every number is worked out
  from them.
- `till.data.sum('amount')` is a live number, a scalar: `snapshot()` reads it, `tap` runs when it changes —
  once when attached, so the first line is the empty fold. `length`, `avg`, `min`, `max`, `median` and
  `percentile` are the same kind. `filter(…).sum(…)` folds over a view (`big`: the sales over 5).
  `reduce(add, remove, init)` is a fold of your own, stepped one row in or out (`cash`: the drawer opened
  with 20); the one-function `reduce(fn, init)` is the same fold rebuilt from every row, fine for small.
  `to(fn)` builds one value from the whole snapshot: the left side of every line. When the tap runs, all of
  them have settled.
- The tempting model is a total you read, add to, and write back. Two tills doing that at once lose a
  sale: the last write wins. Facts never collide, and the same rows fold to the same numbers on every
  screen. [17](../17-lww-honesty/) shows what last-write-wins loses.

```sh
node server.ts --fero.dir ./till   # twice: the first line is last run's facts, and it counts on to 60
node server.ts --no-fero.listen    # no port, no directory: the same numbers, alone in this process
```

`node check.ts` runs this story on its own and ends with `ok 06-numbers`, in about five seconds.
Next: [07 · sorted, top, latest](../07-ordered/).
