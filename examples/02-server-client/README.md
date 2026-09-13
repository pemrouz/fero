# 02 · A server and a client

A `data:` seed makes a server. A bare `fero(name)` is a client: it looks the name up in the box's
directory and follows every change through one tap — no addresses, no config at all. The client writes
too: a sale is a new row, relayed to the server, stamped there, and echoed back.

## Terminals

```sh
cd examples/02-server-client
node server.ts          # terminal 1
node client.ts          # terminal 2   (either order — a client waits for the name to appear)
node check.ts           # proves it: client first, then the server; rows flow down, sales flow up
```

Then kill the server (Ctrl-C, or `kill -9`) and run `node server.ts` again: a new port, and the client
re-finds it. `npm run demo` / `npm run demo:watch` from the repo root run the same two files. The check
meets its own private directory, so it can run while your terminals are up.

Node 22.18+ or 23.6+ (type stripping is built in — no flags).

## What you should see

Terminal 1 after the client's first sale, from a real run (every screen is one header line and the
whole object):

```
fero two-terminal demo — SERVER on 127.0.0.1:45903 — directory 127.0.0.1:38061 (hosting) — servers [] (tick 6, watchers 1, sales 1)

{
  "widgets": {
    "stock": 15,
    "price": 4.5
  },
  "gadgets": {
    "stock": 3,
    "price": 19.99
  },
  "sale-mtyymcya": {
    "item": "gadgets",
    "qty": 1
  }
}
```

The server is `on` a port the OS chose and is `hosting` the directory (the first server on the box
does). `servers` lists the other servers the directory knows for this name (none here); `watchers 1` is
the client's link; `sales` counts the sale rows live. `widgets.stock` moves every second by a whole-row
rewrite; `gadgets` is never touched — the sale is its own row.

Terminal 2's header line over the same run, each time it changed (the object under it is the same as
the server's, one hop later):

```
WATCHER — directory 127.0.0.1:38061 (down) — servers []                    ← started first: no server, so no directory — this line stays until one appears
WATCHER — directory 127.0.0.1:38061 — servers []                           ← the server came up and hosts the directory
WATCHER — directory 127.0.0.1:38061 — servers ["127.0.0.1:45903"]          ← looked the name up, dialed, downloaded the rows
WATCHER — directory 127.0.0.1:38061 (down) — servers ["127.0.0.1:45903"]   ← kill -9 the server: directory down; the old address stays listed until a new one replaces it
WATCHER — directory 127.0.0.1:38061 — servers ["127.0.0.1:45903"]          ← node server.ts again: it hosts the directory before it has registered
WATCHER — directory 127.0.0.1:38061 — servers ["127.0.0.1:42743"]          ← registered: a NEW port, re-found by name
```

Every client's very first line says `(down)`: it draws before its directory link is up. What shows the
client started first is the line staying that way, with no rows, until a server appears.

After the restart the client's screen briefly shows its old sale next to the new server's rows, then
the old sale vanishes: the new server is memory-only, so it re-seeded and never had it, and a client
resyncs to the cluster's truth rather than teaching the server what it lost. A sale made while the
server was down waits and lands on the new one. The last frame of that run:

```
fero two-terminal demo — WATCHER — directory 127.0.0.1:38061 — servers ["127.0.0.1:42743"]

{
  "widgets": {
    "stock": 15,
    "price": 4.5
  },
  "gadgets": {
    "stock": 3,
    "price": 19.99
  },
  "sale-mtyymg1e": {
    "item": "gadgets",
    "qty": 1
  },
  "sale-mtyymj4i": {
    "item": "gadgets",
    "qty": 1
  },
  "sale-mtyymm7n": {
    "item": "gadgets",
    "qty": 1
  }
}
```

## Shows

- `fero('inventory', { data: {…} })` — a seed makes a server; whole rows, applied once to an empty resource.
- `fero('inventory')` — a bare client: the directory lookup is live, so start order does not matter.
- `inventory.data.widgets = { ...inventory.snapshot.widgets, stock }` — the whole row again, in the seed's style.
- `inventory.data[`sale-…`] = { item, qty }` — a client's assignment: relayed, stamped at the server, echoed back.
- `inventory.data.filter((r) => r.item !== undefined).length()` — a live count (a scalar view; `.snapshot()` reads it).
- `cluster.me.snapshot()` — `listen`, `hosts` (the servers the directory lists — the label's `servers`),
  `rendezvous.{addr, hosting, up}`; `cluster.snapshot().peers` — the live links (the server's `watchers`).
- One `render` for data and cluster taps through `coalesce`, redrawn only when the picture changed.

## Deliberately does NOT show

What a client write is on the wire and the confirm ring (03), the record shapes and the two write
styles (04), views over rows (05), hosted methods and the door that closes a resource (08), the same
server coming back with its data (12), a client failing over between servers (14).

## Honest limits

- A memory-only server that restarts re-seeds and forgets: the client's earlier sales disappear when it
  resyncs to the new server. `dir` keeps them (12).
- Never write a leaf on a seeded row (`widgets.stock = 7`) and never read-modify-write it from a
  client: a row record and a leaf record are independent cells (IDEAS P2). After a memory-only restart
  the server re-seeds the row while a client's resync deletes the stale leaf from its own copy, so the
  client shows the row with the field missing and the two disagree until the next whole-row write. This
  example rewrites whole rows on the server and appends fact rows from the client, so the two never overlap.
- This server is OPEN: it declares no `methods:`, so any process on the box can `fero('inventory')` and
  rewrite these rows too. `methods:` closes it (08).
- The client's `(down)` first line is a boot transient every client prints; only its persistence means
  "no server yet".
- Sales are counted, not folded into `gadgets.stock` — turning facts into a total is 06's lesson.
- The client's bounded run waits one second after its last sale before stopping: the sale is already on
  the wire, and a client shows its own write only when the server's stamped echo comes back — the wait
  lets that echo paint. Proving a write landed is 03's lesson.
- A second `node server.ts` in a third terminal joins the first as a cluster (as in 01) and shows up in
  the label's `servers`; every watcher shows in the server's `watchers`.
