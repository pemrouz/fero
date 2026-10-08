# 13 · The deployment rule

Terminals 1 to 3, one member each. Terminal 1, after the client ran:

```
$ cd examples/13-cluster-of-three
$ node server.ts 4801
MEMBER 994647 on 127.0.0.1:4801 — life a0f05cb4
epoch 2 — members 3 — peers 2 — writable true
{ '4801': 1, '4802': 1, '4803': 1, '994694': 'client' }
```

Terminal 4, a client, run once — one write, awaited until two of the three disks hold it:

```
$ node client.ts
CLIENT 994694 — persisted by 4f13ed90 seq 4 epoch 2
```

Terminal 3, over two runs — `kill -9 994649` from terminal 4 (the pid is on its screen), then again:

```
$ node server.ts 4803
MEMBER 994649 on 127.0.0.1:4803 — life fe733a25
epoch 2 — members 3 — peers 2 — writable true
{ '4801': 1, '4802': 1, '4803': 1, '994694': 'client' }
$ node server.ts 4803
MEMBER 994756 on 127.0.0.1:4803 — life fe733a25~2
epoch 4 — members 3 — peers 2 — writable true
{ '4801': 4, '4802': 4, '4803': 1, '994694': 'client' }
```

Terminal 1, the moment the vote is in — the link had gone at once (`peers 1`), the vote took about a second:

```
MEMBER 994647 on 127.0.0.1:4801 — life a0f05cb4
epoch 3 — members 2 — peers 1 — writable true
{ '4801': 2, '4802': 2, '4803': 1, '994694': 'client' }
```

- `listen: '127.0.0.1:4801'` is a fixed address and `dir: './vault-4801'` a disk; the name `vault` is still
  found through the directory. Three members with both is the deployment rule: two of three is a majority,
  so one can die and the other two go on. `persisted by 4f13ed90`: two of three disks hold the write, and
  `4f13ed90` is terminal 2's id — a member that stamped it and is still up; nothing was lost when 3 died.
- `peers` is who this member has a live link to; `members` is the agreed group, changed only by a vote.
  The link drops at once; the vote waits for the dead member's redials to give up — five tries, about a
  second at 30 ms, about four at the default 100. A row the dead member was stamping stands still until
  then (14 tells why), then catches up; with a vote this quick you can barely see it.
- The same command again is the SAME member: `life fe733a25~2`, its rows back from its disk before it has
  reached anyone (`'4803': 1` was its last write), voted back in (`epoch 4 — members 3`), then caught up.
  Without `dir` it would be a new id on the old address; and two members alone cannot vote a dead one out.

```sh
node server.ts 4804                       # a fourth member: members 4 on every screen
node server.ts 4802                       # only two members; kill -9 one: the other stops, writable false
rm -rf vault-4803 && node server.ts 4803  # no past: a new id in its first life, a new member on the old address
```

`node check.ts` runs this story on its own and ends with `ok 13-cluster-of-three`, in a few seconds.
Next: [14 · the client does not notice](../14-failover/).
