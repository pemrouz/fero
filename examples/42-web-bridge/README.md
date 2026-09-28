# 42 · A browser on the other end

Terminal 1, the inventory, over two runs. A screen is the header and the object, redrawn on each change:

```
$ cd examples/42-web-bridge
$ node server.ts
INVENTORY 424397 on 127.0.0.1:41583
{ widgets: { stock: 8, price: 4 }, gadgets: { stock: 3, price: 9 } }
INVENTORY 424397 on 127.0.0.1:41583
{ widgets: { stock: 7, price: 4 }, gadgets: { stock: 3, price: 9 } }
^C
$ node server.ts
INVENTORY 424990 on 127.0.0.1:36361
{ widgets: { stock: 7, price: 4 }, gadgets: { stock: 3, price: 9 } }
```

Terminal 2, the bridge. Open http://localhost:8080/ in a browser, set widgets to 7, close the tab:

```
$ node web.ts 8080
WEB 424520 on http://localhost:8080
tab open 1
set widgets 7
tab closed 0
```

- fero speaks TCP, so a browser cannot join; the bridge joins for it. `fero('inventory')` with nothing else
  is a client that follows the server by name, and `node:http` serves the page from the same file: no build,
  no auth. The page lists each row and the total, and its form sets a stock.
- A tab is its own subscriptions: `/events` opens `f.data.connect` for the rows and `total.connect` for the
  sum, and streams every change record as it lands — the whole object first, then one record per change,
  the same records fero's own views run on:
  `data: {"type":"update","key":["widgets"],"value":{"stock":7,"price":4}}`. `total` is one fold,
  `f.data.sum('stock')`, built once on the bridge and shared by every tab. Closing the tab disposes both.
- The form posts `{ key, stock }` and the bridge writes the WHOLE row, the price kept. A client's write
  shows only as the server's echo, so every tab and the server's screen move in one step. `dir` keeps the
  rows on disk: Ctrl-C the server, run it again, and stock 7 is back. A seed applies only to a node with
  no rows yet, so it never lands over rows the browser changed; without `dir` a restart is the seed again.

```sh
curl -N localhost:8080/events                           # a shell tab: the records as text, tab open 1
curl -s localhost:8080/snapshot                         # the rows and the total, once
curl -d '{"key":"gizmos","stock":5}' localhost:8080/set # the post by hand: a new row on every screen
node web.ts 8081                                        # a second bridge: another client, the same rows
rm -rf inventory && node server.ts                      # ^C terminal 1 first: the seed again, gizmos gone
```

`node check.ts` runs this story on its own and ends with `ok 42-web-bridge`, in about three seconds.
Next: [43 · a ledger that survives](../43-ledger/).
