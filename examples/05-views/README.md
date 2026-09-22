# 05 · Live views

```
$ cd examples/05-views
$ node server.ts
shelf = {
  nail: { cat: 'tool', price: 2 },
  glue: { cat: 'art', price: 6 },
  saw: { cat: 'tool', price: 25 },
  kite: { cat: 'toy', price: 30 }
}
 prices { nail: 2, glue: 6, saw: 25, kite: 30 }
 cheap { nail: { cat: 'tool', price: 2 } }
 pricey { saw: { cat: 'tool', price: 25 }, kite: { cat: 'toy', price: 30 } }
 cats { tool: 'tool', art: 'art', toy: 'toy' }
 count { tool: { value: 2 }, art: { value: 1 }, toy: { value: 1 } }
 cheapTools { nail: { cat: 'tool', price: 2 } }
saw = { cat: 'tool', price: 4 }
 prices { nail: 2, glue: 6, saw: 4, kite: 30 }
 cheap { nail: { cat: 'tool', price: 2 }, saw: { cat: 'tool', price: 4 } }
 pricey { kite: { cat: 'toy', price: 30 } }
 cheapTools { nail: { cat: 'tool', price: 2 }, saw: { cat: 'tool', price: 4 } }
kite = { cat: 'art', price: 30 }
 pricey { kite: { cat: 'art', price: 30 } }
 cats { tool: 'tool', art: 'art' }
 count { tool: { value: 2 }, art: { value: 2 }, toy: { value: 0 } }
```

- `fero('shelf', { data })` seeds four rows. Every name under `views` is an operator on `f.data` — `map`,
  `lt`, `gt`, `distinct`, `length` by a function — or on another view: `cheapTools` is
  `lt(…).intersect(filter(…))`, a view built from two views. Each one is a live VIEW: a read-only object
  that follows the rows. `view.snapshot()` reads it any time; `view.tap(fn)` runs fn now and again on every
  change, and that is the whole screen.
- `saw = …` is a plain whole-row assignment. It prints as it lands, then only the views the saw crossed
  redraw: it left `pricey` for `cheap`, `cheapTools` followed, `prices` shows the 4. `cats` and `count`
  say nothing — nothing crossed their edge.
- The kite keeps its price and changes aisle, so the `toy` bucket empties: `cats` forgets it, `count` keeps
  it at `{ value: 0 }` for as long as this view lives, `pricey` redraws because its kite row was rewritten,
  and `prices` is quiet — 30 is still 30. `group((r) => r.cat)` gives the rows per bucket and forgets an
  empty one.

```sh
node server.ts --no-fero.listen     # no port, no directory: the same screen, all local
node server.ts --fero.dir ./shelf   # twice: the second run moves no row; views with a rewritten one redraw
```

`node check.ts` runs this file once and ends with `ok 05-views`, in under ten seconds.
Next: [06 · live numbers](../06-numbers/).
