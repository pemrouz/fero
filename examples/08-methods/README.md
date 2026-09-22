# 08 · A function that runs on the server

Terminal 1, the bank. It logs its object on every change:

```
$ cd examples/08-methods
$ node server.ts
SERVER 1562755 { genesis: { who: 'alice', amount: 100 } }
SERVER 1562755 {
  genesis: { who: 'alice', amount: 100 },
  'deposit-1562755-1': { who: 'alice', amount: 5 }
}
SERVER 1562755 {
  genesis: { who: 'alice', amount: 100 },
  'deposit-1562755-1': { who: 'alice', amount: 5 },
  'deposit-1562755-2': { who: 'alice', amount: 5 }
}
```

Terminal 2, a client, run once:

```
$ node client.ts
CLIENT 1562799 — me 84f3f13e
deposit 105
deposit 110
whoami 84f3f13e
read { who: 'alice', amount: 100 }
fail methods.fail: nope
nosuch methods.nosuch: unknown method 'nosuch'
update methods-only
```

- `methods: { deposit, fail, whoami }` are functions the server hosts. `await bank.methods.deposit(…)` on a
  client runs one on the server, with `ctx.data` the server's own data, and gets what it returned. Declaring
  `methods:` is also the door: from then on a client changes data only through them. A write of its own —
  the last line; `methods.update` is `bank.data.hack = …` with a reply — is refused `methods-only` and never
  shows. Start the server first: a call waits ten seconds for one, then rejects `timeout after 10000ms`.
- The reply follows the commit. `deposit` writes a row, `await ctx.flush()` waits until it is committed, and
  only then counts the total — so the second call says 110: it counted the first. On one server the write
  commits inside the assignment; with two, a row the other server owns shows on its echo, and the flush
  waits for that: without it, some calls answer a deposit short.
- A thrown error comes back as the rejection, prefixed with the method's name; a name the server does not
  host rejects the same way. `ctx.peer` is the caller's id — the `me` on the client's first line. `read` is
  built in: one row, or all of it.

```sh
node client.ts                     # again: 115 and 120 — every deposit the server committed counts
node server.ts                     # a second server: a call runs on the one that let the client in first
node server.ts --fero.dir ./bank   # the deposits come back after a restart, and the next client counts them
```

`node check.ts` runs this story on its own and ends with `ok 08-methods`, in about ten seconds.
Next: [09 · a method that streams](../09-live/).
