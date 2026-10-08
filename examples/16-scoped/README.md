# 16 · Every row on exactly two members

Terminals 1 to 3, one member each — its own port first, then the others; each waits until all three are up:

```
$ cd examples/16-scoped
$ node server.ts 4811 5811 6811
MEMBER 184389 on 127.0.0.1:4811
snapshot holistic
filter holistic
holds 8 of 9
1-5811 shortfall → { v: 1 }
```

```
$ node server.ts 5811 6811 4811
MEMBER 184390 on 127.0.0.1:5811
snapshot holistic
filter holistic
holds 5 of 9
2-4811 shortfall → { v: 2 }
1-6811 shortfall → { v: 1 }
2-5811 shortfall → { v: 2 }
3-5811 shortfall → { v: 3 }
```

```
$ node server.ts 6811 4811 5811
MEMBER 184391 on 127.0.0.1:6811
snapshot holistic
filter holistic
holds 5 of 9
3-4811 shortfall → { v: 3 }
1-4811 shortfall → { v: 1 }
2-6811 shortfall → { v: 2 }
3-6811 shortfall → { v: 3 }
```

Terminal 4, a client, once the members have printed:

```
$ node client.ts 4811 5811 6811
CLIENT 184478 — 9 rows
```

- `replicas: 2` on the static shape of 15 (`listen`, `hosts`, no directory): every row lives on exactly two
  of the three members — 8 + 5 + 5 = 18, nine rows × two holders. Which two is a hash of the row's key: a
  writer is not always a holder (terminal 2 wrote `2-5811` and fetches it) and the split is uneven.
- A member holds a shard, and a shard is never shown as the resource: `f.snapshot` and every operator
  (`f.data.filter`, a tap) throw a typed `ScopedError`: `{ scoped: true, op, reason, replicas, hint }`, the
  reason `holistic`. `await f.data` is the gather: the whole resource, collected from every member. A row
  not held here is a handle: a sync read of it throws `shortfall`, `await f.data[k]` is one hop to a holder.
- Nothing is written until all three are in: scoping arms when the view commits. A client is not scoped —
  `methods.read()` is the whole resource, gathered by the member that took the call.

```sh
node server.ts 4811 5811             # twice, rotated: two members hold every row, 6 of 6, no hops
node server.ts 4811 5811 6811 7811   # four times, rotated: twelve rows, still two holders each, 24 holdings
node client.ts 4811                  # a client naming one member still reads all nine
```

`node check.ts` runs this story on its own and ends with `ok 16-scoped`, in about four seconds.
Next: [17 · what last-writer-wins loses](../17-lww-honesty/).
