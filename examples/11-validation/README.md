# 11 · One rule for every write

Terminal 1, the shop. Its screen once the client below has written:

```
$ cd examples/11-validation
$ node server.ts
SHOP 1623499 — clients 1
["nails"] committed
["nails"] rejected: negative stock
{ nails: { stock: 5 }, 'saw-1623681': { stock: 1 } }
```

Terminal 2, a client — one good row and one bad one:

```
$ node client.ts
CLIENT 1623681
["saw-1623681"] committed
["hammer-1623681"] rejected: negative stock
{ nails: { stock: 5 }, 'saw-1623681': { stock: 1 } }
```

- `validation: rule` — the rule sees each record (its `key`, its `value`) and answers `true` or
  the reason. It runs wherever a write enters the shop: the seed, the shop's own assignment, and a client's
  write as it arrives. A seed row it refuses stops `fero()` itself, naming the row and the reason.
- A refused write never shows, anywhere: nothing lands, no value comes back to undo. Its one trace is a
  `rejected` row of `cluster.writes` — the ring of what THIS node wrote, 03's `pending` and `committed`
  rows — with the reason. The client's `hammer` reads the shop's words; its `saw` lands on both screens.
  The shop's own `nails = { stock: -1 }` is refused the same way, and nails keeps 5.
- The rule says what a record may look like, never who may write it. Any client may write any row:
  `methods:` (08) is the door for that, and behind it a handler's own write the rule refuses fails the call
  with `write refused (["axe"]): negative stock`. Servers trust each other's writes, so every server must
  carry the rule — the last line below is one that does not.

```sh
node client.ts                     # again: another saw on every screen, another hammer refused
node client.ts --fero.server=true  # the same file as a server: it carries no rule, so its hammer lands
```

`node check.ts` runs this story on its own and ends with `ok 11-validation`, in about five seconds.
Next: [12 · the same node, next life](../12-durable/).
