# 41 · A kanban board

Terminal 1, the board. Its screen once the two editors below have written:

```
$ cd examples/41-kanban
$ node board.ts
BOARD 413955 — editors 2
{
  todo: { c2: { status: 'todo', title: 'ship it' } },
  doing: { c1: { status: 'doing', title: 'write the docs first' } }
}
```

Terminal 2, ada. Typed: `add c1 write the docs`, `add c2 ship it`, `set c1 title write the docs first`:

```
$ node edit.ts ada
EDIT ada 414076
["c2","status"] committed
["c2","title"] committed
["c1","title"] committed
{
  todo: { c2: { status: 'todo', title: 'ship it' } },
  doing: { c1: { status: 'doing', title: 'write the docs first' } }
}
```

Terminal 3, bob. Typed: `move c1 doing` the moment ada retitled it, then `move c2 nowhere`:

```
$ node edit.ts bob
EDIT bob 414137
["c1","status"] committed
["c2","status"] rejected: unknown column
{
  todo: { c2: { status: 'todo', title: 'ship it' } },
  doing: { c1: { status: 'doing', title: 'write the docs first' } }
}
```

- A card is a row written by its fields: `add` patches `status` and `title`, `move` and `set` write one
  field; `group((c) => c.status)` is the board. Each field is its own cell, so ada's retitle and bob's
  move of one card at the same moment both land; the same field from two at once keeps the last write (17).
- The board and every editor carry `rules.ts` as `seams.validation`: a whole row is refused (`this board
  writes fields, never whole rows`), and a status that names no column, or none at all (`move c2`). An
  editor refuses its own bad write before it leaves: bob's `nowhere` is a `rejected` row of his
  `cluster.writes` (the lines over his board: his own writes, 03) that was never `pending`; a client with
  no rule is refused at the board, in its words.
- The board is an open server: no `methods:`, so editors write cards themselves, and no seed, which would
  be a whole row. Behind `methods:` (08) every plain write is refused `methods-only`: a rule about what a
  record may look like lives in the seam; a rule a caller must hear is thrown from a method.

```sh
node edit.ts carol move c1 done    # one command from the command line, then the live board
node board.ts                      # a second board: every card from the first, and it follows each move
node board.ts --fero.dir ./board   # durable: Ctrl-C it and run it again, every card is where it was
```

`node check.ts` runs this story on its own and ends with `ok 41-kanban`, in a few seconds.
Next: [42 · a browser on the other end](../42-web-bridge/).
