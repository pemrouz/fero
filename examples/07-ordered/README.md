# 07 · Sorted, top, latest

```
$ cd examples/07-ordered
$ node server.ts
az price        [ 'nut 1', 'cog 3', 'bolt 3', 'gear 5' ]
az price, name  [ 'nut 1', 'bolt 3', 'cog 3', 'gear 5' ]
limit 2         [ 'cog 3', 'nut 1' ]
reverse         [ 'bolt 3', 'gear 5', 'nut 1', 'cog 3' ]
za price 2      [ 'gear 5', 'cog 3' ]
za price 2      [ 'nut 9', 'gear 5' ]
top 2           [ 91, 85 ]
```

- `f.data.az('price')` is a live view of the rows sorted by a column, and its `.snapshot()` is an ARRAY
  in rank order (`za` is the same, descending). Two rows share the price 3, and a tie keeps arrival order:
  the order the rows reached this node, which another node need not share. A comparator with a tiebreak,
  `a.price - b.price || a.name.localeCompare(b.name)`, makes the order the same everywhere: bolt first.
  `za` with a comparator reverses all of it, the tiebreak too (cog before bolt); for descending price
  with names A→Z, flip the price term — `b.price - a.price || a.name.localeCompare(b.name)` — under `az`.
- `limit(2)` is the first two rows in arrival order and `reverse()` is that order newest first: no sort,
  just the order the rows came. `za('price', 2)` is a bounded window. The tap prints it once when it
  attaches, and once more when the whole-row rewrite `f.data.w2 = { name: 'nut', price: 9 }` lifts nut in
  and cog out: one batch, one line, never a row at a time.
- `top(2)` is for numeric rows: the two largest values, as numbers. Two collections are two resources,
  `parts` and `scores`, in one file. A seed makes each a server, and `await f.destroy()` is the exit: the
  process ends by itself.

```sh
node server.ts --no-fero.listen            # no port and no directory: the same seven lines
node server.ts --fero.parts.dir ./parts    # twice: the second run has the first's rows, so nothing rotates
```

`node check.ts` runs this file on its own and ends with `ok 07-ordered`, in about five seconds.
Next: [08 · a function that runs on the server](../08-methods/).
