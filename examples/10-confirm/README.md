# 10 · How sure do you want to be

Terminal 1, a member. Its screen is the committed view and the object — this is it after the client ran:

```
$ cd examples/10-confirm
$ node server.ts
MEMBER 1621883 — me a69c0c97 — epoch 1 — writable true — members 2
{ k: 3 }
```

Terminal 2, the same command. A majority needs two, and the view commits once both are in:

```
$ node server.ts
MEMBER 1622035 — me 3d2f4f23 — epoch 1 — writable true — members 2
{ k: 3 }
```

Terminal 3, a client, run once — the same write, awaited at three rungs:

```
$ node client.ts
CLIENT 1622386
k=1 committed by a69c0c97 seq 1 epoch 1
k=2 replicated by a69c0c97 seq 2 epoch 1
k=3 persisted timeout — reached committed by a69c0c97 seq 3 epoch 1
{ k: 3 }
```

- `methods.update({ key: 'k', value: 1 })` is `c.data.k = 1` with a reply, and `confirm` names the rung to
  wait for: `committed` (the default: a member stamped it and applied it), `replicated` (a majority of the
  members hold it), `persisted` (a majority have it on disk). The reply names the rung it PROVED and the
  commit's coordinates — `by a69c0c97` is the member that stamped it, the `me` on terminal 1; `seq` is its
  place in that member's log; `epoch` the view it was committed under.
- A reject is not a rollback. Nobody here has a disk, so the third rung can never be proven, and when the
  deadline passes (`timeout`, 3 s here, 10 s unless you say) the reply says how far it got instead:
  `reached committed`, with the same coordinates. The write is there — `{ k: 3 }` on all three screens.
- The view commits (`epoch 1 — members 2`) once both members are in, and the client waits for that before
  it writes: with one server up it prints nothing. A client proves its rung at its primary, the member that
  let it in — that one holds the evidence, the client only asks.

```sh
node server.ts                 # a third member: writable false until the vote lets it in, then members 3
node server.ts --fero.dir ./a  # both members on a disk (./b for the other): the third rung is proven too
node client.ts                 # Ctrl-C a member first: a majority of one is one, so replicated proves alone
```

`node check.ts` runs this story on its own and ends with `ok 10-confirm`, in about ten seconds.
Next: [11 · one rule for every write](../11-validation/).
