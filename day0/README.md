# Day 0 — wire-format spike

Build-order step 1 from [../plan.md](../plan.md#L349). Proves the one hypothesis
everything else in fero rests on:

> **change records on the wire === change records in memory**

`data`'s `$()` proxy already emits change records — `{ type, key, value, at? }` —
through a `FunctionSink` (`proxy.connect(obj, fn)`). This spike pipes those records
onto a TCP socket on side A and replays them verbatim onto another `$()` on side B
via its root `res`. **There is no translation layer:** the bytes on the wire are
the records `data` produces internally, and the methods that replay them
(`res.update / insert / remove`) are exactly the ones the proxy's own set/delete
traps call. fero, if this holds, is plumbing around this fact.

It holds.

## Files

- [replicate.ts](replicate.ts) — the entire primitive. `publish(proxy, socket)`
  (send side) + `subscribe(proxy, socket)` (receive side), ~20 lines each.
- [replicate.test.ts](replicate.test.ts) — round-trips over real TCP loopback:
  initial snapshot, object set, nested set, delete, ordered array insert, and a
  mixed stream. `npm test`.
- [server.ts](server.ts) / [client.ts](client.ts) — the two-process demo.

## Run it

```sh
npm test                                      # the automated proof

# or watch two processes converge:
node --experimental-strip-types day0/server.ts 5171
node --experimental-strip-types day0/client.ts 5171   # another terminal
```

## What it surfaced

- **Upsert splits to insert.** Setting a *new* object key (`a.user99 = {…}`) crosses
  the wire as `insert` with `at:"user99"`, not `update` — `data`'s `BU1` turns
  previously-`undefined` keys into `BI0` inserts (`data/core.ts` `BU1`). It replays
  correctly because `at` carries the key. Worth remembering when L1 builds the log:
  the log entry for a first-write is an insert.
- **Sinks are weakly held.** A `FunctionSink` lives only as a `WeakRef` on the view
  (`data/core.ts` `View.sinks`), so long-lived replication needs something to keep
  it alive. `data`'s `PropSink` already solved this — `connect(obj, 'prop')` pins the
  sink to `obj` via a `lifetimes` `WeakMap`, so holding the returned object is the
  whole retention contract. `FunctionSink` didn't wire that up, so the first cut of
  `publish()` reached into `view.sinks` and deref'd. Fixed at the source: `data`'s
  `FunctionSink` now pins to `obj` too (symmetric with `PropSink`), so `publish()`
  just returns the object `connect` hands back — **retain it, drop it to stop.** No
  deref, no internals. (Deterministic mid-stream disconnect would be a future `data`
  API; the `socket.writable` guard already makes post-close delivery a no-op.)

## What it deliberately does NOT do

- **Framing is newline-JSON** — the dumbest thing that works. The real wire format
  (length-prefixed binary, lazy-deserialise, batching) is L0 (`transport/message.ts`).
- **No `move`.** Moves only arise from ordering operators (`sort`/`az`/`top`), which
  belong to per-client projections — deferred to L2.
- **No transport, no peers, no log.** One socket, two proxies. That's the point.
