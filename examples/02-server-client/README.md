# 02 · A shop and its watchers

Terminal 1, the shop, over two runs. A screen is the header line and the object, redrawn on every change:

```
$ cd examples/02-server-client
$ node server.ts
SHOP 1034672 on 127.0.0.1:44605 — watchers 1
{
  widgets: { stock: 8 },
  gadgets: { stock: 3 },
  'sale-1034692-1': { item: 'gadgets', qty: 1 },
  'sale-1034692-2': { item: 'gadgets', qty: 1 }
}
^C
$ node server.ts
SHOP 1034791 on 127.0.0.1:41687 — watchers 1
{
  widgets: { stock: 9 },
  gadgets: { stock: 3 },
  'sale-1034692-3': { item: 'gadgets', qty: 1 },
  'sale-1034692-4': { item: 'gadgets', qty: 1 }
}
```

Terminal 2, a watcher. It started first; its header line, each time it changed:

```
$ node client.ts
WATCHER 1034692 — shop not found yet
WATCHER 1034692 — shop 127.0.0.1:44605
WATCHER 1034692 — shop 127.0.0.1:41687
```

- `fero('shop', { data: {…} })` — a seed makes the server. It picks a free port and registers the name `shop`
  with the directory on your box. `fero('shop')` with nothing else is a client: it looks `shop` up and
  follows, and like a server it holds the process open until Ctrl-C or `await shop.destroy()`. Start them
  in either order.
- Stock flows down: the shop rewrites `widgets` whole every second and every watcher's screen follows. Sales
  flow up: a watcher's `shop.data['sale-<pid>-<n>'] = { item, qty }` is a NEW row; it goes up to the shop, is
  stamped there, and comes back to everyone — the watcher's own screen included. A write shows when it
  commits, never before. Another `node server.ts` joins the first as a second server, but both would
  rewrite `widgets`: one writer per row is the rule.
- Ctrl-C the shop and the watcher keeps its last screen, under the old address; a sale it makes meanwhile
  shows nowhere yet. `node server.ts` again and it finds the new port by itself. The new shop is memory-only,
  so it starts from the seed: the old sales are gone (the watcher takes the shop's truth) and the sale made
  while it was down lands on the new one.

```sh
node client.ts                     # another watcher: every sale on every screen, watchers 2
node server.ts --fero.dir ./shop   # the shop comes back after a restart as itself, with every sale
```

`node check.ts` runs this story on its own and ends with `ok 02-server-client`, in about ten seconds.
Next: [03 · one write](../03-one-write/).
