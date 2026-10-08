# 44 · Open, then a door

Terminal 1, the shop, over two runs: open, then the same shop with a door. A screen is the header line and
the object, redrawn on every change:

```
$ cd examples/44-sell
$ node open.ts
SHOP 1095037 — open
{ widgets: { price: 0 } }
^C
$ node door.ts
SHOP 1095103 — methods: sell
{
  widgets: { price: 10 },
  'sale-1095103-1': { item: 'widgets', price: 10 }
}
```

Terminal 2, a customer, run once against each:

```
$ node customer.ts
CUSTOMER 1095078
price 0: committed
sell: methods.sell: unknown method 'sell'
$ node customer.ts
CUSTOMER 1095147
price 0: methods-only
sell: { item: 'widgets', price: 10 }
```

- An open shop is what 02 built: a seed makes a server, and every client may change every row. That is
  fine for a demo. In a shop it means any customer can set the price, and the shop shows `price: 0` like
  any other write. You probably don't want everyone to change anything.
- `methods: { sell }` is the door (08). From then on a client changes data only through the methods. The
  same price write is refused `methods-only` and never shows. `sell` runs on the server and writes the
  sale as a new row at the server's price: the caller names the item, never the price. Reads stay open.
- `methods.update` is the plain write `shop.data.widgets = { price: 0 }` with a reply, so the customer
  can print what became of it. The bare assignment meets the same door; the check makes one to show it.

```sh
node customer.ts                 # again, against the door: a second sale row, still at 10
node door.ts --fero.dir ./shop   # the sales come back after a restart, and the seed applies once
```

`node check.ts` runs this story on its own and ends with `ok 44-sell`, in about three seconds.
That is the series.
