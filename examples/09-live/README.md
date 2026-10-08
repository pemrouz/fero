# 09 · A method that streams

Terminal 1, the bank. Its screen is redrawn on every deposit — this is it after bob's last one:

```
$ cd examples/09-live
$ node server.ts
BANK 1573132 — clients 1
{
  opening: { who: 'alice', amount: 100 },
  '4db1323c-d4f1-4bac-a5cc-20dce88b4180': { who: 'alice', amount: 5 },
  '3fe98f39-0526-4903-b1ed-0b21f62fd4ce': { who: 'alice', amount: 10 },
  '2f1721cf-8834-4693-9db4-2521225f33a9': { who: 'bob', amount: 5 },
  '430e0b9e-0be5-42c7-bb87-3b981df6e0b2': { who: 'bob', amount: 10 }
}
```

Terminal 2, a client, run twice: alice, then bob. Each run deposits, opens its feed, deposits again, exits:

```
$ node client.ts
alice total 0 top []
alice total 105 top [ 100, 5 ]
live {
  opening: { who: 'alice', amount: 100 },
  '4db1323c-d4f1-4bac-a5cc-20dce88b4180': { who: 'alice', amount: 5 }
}
alice total 115 top [ 100, 10, 5 ]
$ node client.ts bob
bob total 0 top []
bob total 5 top [ 5 ]
live { '2f1721cf-8834-4693-9db4-2521225f33a9': { who: 'bob', amount: 5 } }
bob total 15 top [ 10, 5 ]
```

- `feed` is a method that returns a view — `ctx.data.filter(…)` — not a value, and that is the whole trick.
  On the client, `bank.methods.feed(who)` is a handle with two modes. `await` it and the bank answers once,
  with a snapshot. `.open()` it and the bank streams the view into a mirror here: every row that matches,
  kept up to date as long as it is open. `sum` and `za` (the three biggest) chain on the mirror, so the sort
  runs on the client, not at the bank. A method that returns one number streams it as `{ value }`; `await`
  still gives the bare number.
- The mirror starts empty (`total 0`). Its first frame is the fold — everything so far, the deposit made
  before the open included. `live` is `feed.mode`. The deposit made after the open arrives as one delta.
  `deposit` is a method too: under `methods:` it is the only way a client changes the bank (a plain write
  is refused). `close()` ends the stream; the bank keeps the rows.
- The honest limit: every `feed(who)` call builds a new filter at the bank, and `close()` stops the stream
  but leaves that view there for the bank's lifetime. With many callers, return `ctx.data` and filter on
  the mirror, or keep one view per name.

```sh
node client.ts      # alice again: her feed starts from every row so far, then one more delta
node server.ts      # a second bank: a client's feed opens on either, and a deposit lands on both screens
```

`node check.ts` runs this story on its own and ends with `ok 09-live`, in about ten seconds.
Next: [10 · how sure do you want to be](../10-confirm/).
