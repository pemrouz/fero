# 12 · The same node, next life

One terminal, over two runs. A screen is the header line and the object; the word under it is the guarantee:

```
$ cd examples/12-durable
$ node server.ts
NOTES 3436569 — life 342d2132
{ seed: 3436569, '342d2132': '02:43:07' }
persisted
^C
$ node server.ts
NOTES 3436638 — life 342d2132~2
{ seed: 3436569, '342d2132': '02:43:07', '342d2132~2': '02:43:08' }
persisted
```

- `dir: './notes'` makes the node durable: every commit goes to a log in that folder, and the folder holds
  who the node is. Run the file again and it is the SAME node in its next life — `life <id>~2` on the
  header, the same id — with its rows back before it has a socket. One dir is one node of one resource:
  another name or another `uuid` on it is refused.
- The seed applied once. `data:` seeds a resource only when its fold is empty at boot, and a restored life
  is not empty: `seed:` still holds life 1's pid — the first header's — in life 2, and life 1's row keeps
  the time it was written.
- Each life writes one row keyed by its origin, awaited at `confirm: 'persisted'`: the reply comes when the
  row is on disk, and `persisted` under the object is that reply. Alone, that disk is the only one — a solo
  `persisted` is one copy, honestly weaker than the majority the word means in a cluster (13).

```sh
node server.ts                      # a third run: life ~3, three rows
node server.ts --fero.dir ./other   # a second identity, first life: every row on both screens, one seed wins (17)
node server.ts --fero.uuid zz       # refused: one dir, one identity
rm -rf notes && node server.ts      # no dir, no past: a new id, first life, its own seed, the old rows gone
```

`node check.ts` runs this story on its own and ends with `ok 12-durable`, in about two seconds.
Next: [13 · the deployment rule](../13-cluster-of-three/).
