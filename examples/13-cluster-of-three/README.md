# 13 · The deployment rule

Terminals 1 to 3, one member each. Terminal 1, after the client ran:

```
$ cd examples/13-cluster-of-three
$ node server.ts 4801
MEMBER 271476 on 127.0.0.1:4801 — life 12f06eac
epoch 2 — members 3 — peers 2 — writable true
{ '4801': 5, '4802': 4, '4803': 3, '271869': 'client' }
```

Terminal 4, a client, run once — one write, awaited until two of the three disks hold it:

```
$ node client.ts
CLIENT 271869 — persisted by 1f47032a seq 13 epoch 2
```

Terminal 3, over two runs — `kill -9 271607` from terminal 4 (the pid is on its screen), then again:

```
$ node server.ts 4803
MEMBER 271607 on 127.0.0.1:4803 — life 1f47032a
epoch 2 — members 3 — peers 2 — writable true
{ '4801': 7, '4802': 6, '4803': 6, '271869': 'client' }
$ node server.ts 4803
MEMBER 272598 on 127.0.0.1:4803 — life 1f47032a~2
epoch 4 — members 3 — peers 2 — writable true
{ '4801': 17, '4802': 16, '4803': 6, '271869': 'client' }
```

Terminal 1, the moment the vote is in — the link had gone at once (`peers 1`), the vote took six seconds:

```
MEMBER 271476 on 127.0.0.1:4801 — life 12f06eac
epoch 3 — members 2 — peers 1 — writable true
{ '4801': 7, '4802': 6, '4803': 6, '271869': 'client' }
```

- `listen: '127.0.0.1:4801'` is a fixed address and `dir: './vault-4801'` a disk; the name `vault` is still
  found through the directory. Three members with both is the deployment rule: two of three is a majority,
  so one can die and the other two go on. `persisted by 1f47032a`: two of three disks hold the write, and
  `1f47032a` is terminal 3's id — the member killed next had stamped it, and nothing was lost.
- `peers` is who this member has a live link to; `members` is the agreed group, changed only by a vote.
  The link drops at once; the vote waits for the dead member's redials to give up — six seconds at 30 ms,
  twenty at the default 100. A row the dead member was stamping stands still until then — both survivors'
  own rows here, at 7 and 6 (14 tells why) — then catches up: 17 and 16 by the time terminal 3 is back.
- The same command again is the SAME member: `life 1f47032a~2`, its rows back from its disk before it has
  reached anyone (`'4803': 6` was its last write), voted back in (`epoch 4 — members 3`), then caught up.
  Without `dir` it would be a new id on the old address; and two members alone cannot vote a dead one out.

```sh
node server.ts 4804                       # a fourth member: members 4 on every screen
node server.ts 4802                       # only two members; kill -9 one: the other stops, writable false
rm -rf vault-4803 && node server.ts 4803  # no past: a new id in its first life, a new member on the old address
```

`node check.ts` runs this story on its own and ends with `ok 13-cluster-of-three`, in about ten seconds.
Next: [14 · the client does not notice](../14-failover/).
