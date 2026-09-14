# 02 · A shop and its watchers

```sh
cd examples/02-server-client
node server.ts     # terminal 1: the shop
node client.ts     # terminal 2: a watcher — either order; a third terminal is another watcher
node check.ts      # proves it, about 14 s, on its own private directory (your terminals are not touched)
```

Terminal 1 after the watcher's third sale, from a real run (each screen is one header line and the object;
it redraws on every change):

```
fero two-terminal demo — SHOP on 127.0.0.1:37109 — watchers 1
{
  widgets: { stock: 12 },
  gadgets: { stock: 3 },
  'sale-651628-1': { item: 'gadgets', qty: 1 },
  'sale-651628-2': { item: 'gadgets', qty: 1 },
  'sale-651628-3': { item: 'gadgets', qty: 1 }
}
```

Terminal 2's header line over the same run, each time it changed. It started first; later the shop was
Ctrl-C'd and started again:

```
WATCHER 651628 — shop not found yet          ← no shop yet: it waits
WATCHER 651628 — shop 127.0.0.1:37109        ← found it by name; the object under it is the shop's
WATCHER 651628 — shop 127.0.0.1:33543        ← node server.ts again: a NEW port, re-found by name
```

What is going on:

- `fero('shop', { data: {…} })` — a seed makes the server. It picks a free port and registers the name `shop`
  with the directory on your box. `fero('shop')` with nothing else is a client: it looks `shop` up and
  follows. Start them in either order.
- Stock flows down: the shop rewrites `widgets` whole every second and every watcher's screen follows. Sales
  flow up: a watcher's `shop.data['sale-<pid>-<n>'] = { item, qty }` is a NEW row; it goes up to the shop, is
  stamped there, and comes back to everyone — the watcher's own screen included, which shows a sale only
  when the shop's copy comes back. A write shows when it commits, never before.
- One `shop.data.tap` per file is the whole screen; `shop.snapshot` is the object. `shop.cluster.me.snapshot()`
  says where I listen (`listen`) and which shop the directory found (`hosts`); `shop.cluster.snapshot().peers`
  are the live links (`watchers`).
- Ctrl-C the shop and the watcher keeps its last screen, under the old address; a sale it makes meanwhile
  shows nowhere yet. `node server.ts` again and it finds the new port by itself. This shop is memory-only: it
  starts again from the seed, the old sales are gone (the watcher resyncs to the shop's truth), and the sale
  made while it was down lands on the new one.
- This shop is OPEN: it declares no `methods:`, so any process on the box can write anything. `methods:`
  closes it (08).

Scale it:

- More watchers: `node client.ts` in as many terminals as you like — every sale on every screen (`watchers 2`).
- Keep the sales: `{ data: {…}, dir: './shop' }` and the shop comes back after a restart as itself, with every
  sale, on a fresh port (12).
- Sales are counted as rows here, never folded into `gadgets.stock` — turning facts into a total is 06's lesson.
- Another `node server.ts` joins the first as a second server (01's shape) — but both would rewrite `widgets`;
  one writer per row is the rule (10, 13).

Next: 03 — what one write looks like on the wire.
