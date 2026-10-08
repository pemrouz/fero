# 14 · The client does not notice

Terminal 1, a server, started alone. Just before it is killed, three servers share the object:

```
$ cd examples/14-failover
$ node server.ts
SERVER 994827 — members 3
{ '994827': 8, '994841': 7, '994843': 7 }
```

Terminal 2, a client. It met terminal 1 alone, so terminal 1 feeds it. Terminals 3 and 4, two more servers:

```
$ node client.ts
CLIENT 994828 — peers 3
{ '994827': 8, '994841': 7, '994843': 7 }
```

Terminal 2, the moment `kill -9 994827` lands in any other terminal — the server feeding it is gone:

```
CLIENT 994828 — peers 2
{ '994827': 8, '994841': 7, '994843': 7 }
```

Terminal 2, ten seconds later:

```
CLIENT 994828 — peers 2
{ '994827': 8, '994841': 27, '994843': 27 }
```

Terminal 4, the moment the vote is in, about a second and a half after the kill:

```
SERVER 994843 — members 2
{ '994827': 8, '994841': 10, '994843': 9 }
```

- `fero('feed')` with nothing else dials every server the directory lists — `peers 3` — and ONE of them, the
  first it met, feeds its live handle `c.methods.feed().open()`. `kill -9` that one: `peers` drops at once,
  the dead row stands where it stopped, and the handle re-subscribes on a survivor by itself — nothing to
  reconnect, nothing to reopen. Kill any other server and the handle is not even touched.
- The other rows count on — unless the dead server was stamping them. Each row has one server that stamps
  it, picked by its key; a row that fell to the dead one stands still until the survivors vote it out —
  `members 2`, about a second and a half here: the dead member's redial chain with `redial: { ms: 30 }`
  gives up after five tries, then the vote; about four seconds by default — then catches up. A client's
  write goes the same way.
- A call in flight when the feeder dies fails fast — `methods.mark: link-down` — unless it says
  `{ retry: true }`: then it runs the handler AGAIN on a survivor. Retry only what is safe to run twice:
  `mark` sets one cell, so twice is once; a deposit would count twice.

```sh
node client.ts failover   # after the kill: a client's write, through mark, lands at once or after the vote
node server.ts            # after the kill: a new server joins — members 3 again, a fourth row
node client.ts            # another watcher: the same picture, peers 3
```

`node check.ts` runs this story on its own and ends with `ok 14-failover`, in a few seconds.
Next: [15 · addresses are just config](../15-static-topology/).
