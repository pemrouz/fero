# 04 · Rows and records

One terminal, one run — a line per record as it lands, a line per refusal, then the object:

```
$ cd examples/04-rows
$ node server.ts
update [] {}
insert [] {"qty":1,"status":"new"} at o1
update ["o1"] {"qty":1,"status":"paid"}
insert [] {"qty":2} at o2
update ["o2","status"] "new"
update ["o2","status"] "paid"
insert [] {"qty":3} at 87187389-b325-49fb-bd18-08b82861104c
remove ["87187389-b325-49fb-bd18-08b82861104c"] {"qty":3}
refused: data: .filter(...) on a child path would operate on the OWNING view
refused: fero: insert() mints a data-side key that would not replicate
refused: fero: replace keys (data.k = v), not the resource root
{ o1: { qty: 1, status: 'paid' }, o2: { qty: 2, status: 'paid' } }
```

- `f.data.tap((r) => …)` — a tap with a parameter sees every record as it lands: its `type`, its `key` (a
  path into the object), its `value`, and `at` for a new row. The first record is the whole value on attach,
  `{}`. A new row is an insert at its key, a rewrite is an update of the row, a field is a deeper key, and a
  remove carries what was there. A record is the unit of change, and the shape that replicates.
- Two styles, one per row and never both on one: `o1` is written whole (a write replaces the row; to change
  a field, spread a copy of `f.snapshot.o1`), `o2` by its fields (the row appears from its first field, then
  one record per field). A row cell and a field cell are separate cells: mixed on one row, a replica can
  show a stale field. `set`, `update`, `patch` and `remove` make the same records as assignment and
  `delete`. `methods.insert` mints the row key, a uuid, and hands it back; `methods.remove` takes it.
- Three refusals before anything lands, each with its reason. data refuses an operator off a row (a row is
  an address, not a view: chain from `f.data` itself); fero refuses `insert()` on the view (fero owns the
  key) and a whole-root overwrite (`f.data.update({})`: replace keys, not the root). Each line is the first
  half of the real message; the other half says what to do instead.

```sh
node server.ts --fero.dir ./orders   # twice: the second run opens on last time's rows, and o1 is an update
node server.ts --no-fero.listen      # no port and no directory: the same records, nothing on the wire
```

`node check.ts` runs this story on its own and ends with `ok 04-rows`, in about five seconds.
Next: [05 · live views](../05-views/).
