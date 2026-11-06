# How to write a pattern example and a check on the E-22 prototype

This is for E-22's steps 2 and 3: every pattern of [API.md](../../API.md) §7 as an example of at most 40 lines, with a check. Two worked pairs exist: [examples/p01-live-state.ts](examples/p01-live-state.ts) with [checks/p01.check.ts](checks/p01.check.ts), and [examples/p14-invariants.ts](examples/p14-invariants.ts) with [checks/p14.check.ts](checks/p14.check.ts). Copy one.

## What the prototype is, in six lines

- **One OS process, one world.** `fero.world({ seed })` makes a world: a virtual clock, one event queue, seeded random streams. A run is a function of its seed and its fault schedule.
- **Many simulated processes.** `w.proc('s1')` is a process. Code inside `s1.run(async () => { … })` runs as `s1`: `fero()` and every library resolve there.
- **Each resource is 2 groups over 1,024 slots** (`fero.world({ groups: 4 })` for more). A group is an ordered log with a leader (the writer) and up to 3 voters.
- **The kernel has five operations**: `append`, `read`, `snapshot`, `changeMembers`, `handOver` ([proto/kernel.ts](proto/kernel.ts)). L2 ([proto/l2.ts](proto/l2.ts)) is a library over them: dedup, conditions, ops, TTL, `max`, `where`, sessions, claims, fences, the slot move's steps.
- **data folds every committed record** through one seam ([proto/seam.ts](proto/seam.ts), the shape of v4's `api/substrate.ts`), on every replica and at every writer.
- **The API is API.md's** ([proto/index.ts](proto/index.ts), [proto/api.ts](proto/api.ts)). Where it is not, [API-NOTES.md](API-NOTES.md) says so.

## The two files

**The example**, `examples/pNN-<name>.ts`: API.md's code for the pattern, as close to verbatim as it runs. Each file the pattern names (`server.ts`, `client.ts`, `worker.ts`) becomes an exported async function. It imports only `../proto/index.ts` (and `../lib/index.ts` for L5 libraries, below). No world, no faults, no assertions: those live in the check. At most 40 lines.

```ts
// P-NN <name>, as API.md §7 writes it.
import { fero, op } from '../proto/index.ts'

// ── server.ts
export const server = async () => {
  const shop = await fero('shop', { server: true, rows: { ttl: '10m' } })
  return shop
}
// ── client.ts
export const client = async () => {
  const shop = await fero('shop')
  const ack = await shop.set('k', op.incr(1))
  return { shop, ack }
}
```

**The check**, `checks/pNN.check.ts`: runs the example under many seeds with faults, and asserts the pattern's guarantee (its REQUIREMENTS row).

```ts
import { check, report, isMain } from '../proto/check.ts'
import { server, client } from '../examples/pNN-name.ts'

export const run = () => check('pNN-name', async (c) => {
  const [s1, s2, s3, a, b] = c.procs('s1', 's2', 's3', 'a', 'b')
  for (const s of [s1, s2, s3]) await s.run(server)      // three servers: groups get 3 voters
  await c.settle()                                        // joins and handovers finish
  c.chaos({ leaderChanges: 2, moves: 1, within: 5 })      // faults inside the work below
  const [x, y] = await Promise.all([a.run(client), b.run(client)])
  await c.settle()
  c.eq(x.shop.snapshot.k, 2, 'both incrs counted once')   // the guarantee
}, { seeds: 100 })

if (isMain(import.meta.url)) report(await run(), import.meta.url)
```

Run it: `node --experimental-strip-types --no-warnings checks/pNN.check.ts`. It ends `ok pNN-name (100 seeds, …; faults hit: …)` or prints each failing seed with its fault schedule and a replay command.

## The check's tools

| Tool | What it does |
|---|---|
| `c.procs('s1', 'a')` | simulated processes by name |
| `p.run(fn)` | run `fn` as process `p` |
| `c.settle()` | run until nothing is in flight (every message delivered, every fold caught up); virtual time moves only as far as that needs |
| `c.w.advance('31s')` | move virtual time: TTLs, leases, session lapses and timers fire in order |
| `c.chaos({ leaderChanges, moves, within, res, down })` | a seeded fault schedule, starting now. A leader change keeps only what the new leader holds, so an uncommitted tail can be lost; writes get `no-writer` for `down` ms (default `election.ms` 2000 plus jitter). A move takes one slot that holds data to another group. Call it once, where the pattern's work starts. Set `within` to the work's virtual length: a write is about 1 to 2 ms, a write across an election about 2.5 s |
| `c.w.faults([{ at, do, … }])` | an exact schedule: `leader-change`, `move`, `kill` (`proc`), `pause` (`proc`, `for` ms: a zombie or a GC stall), `skew` (`proc`, `by` ms: its clock), `drop` (`p`: the chance each message is lost) |
| `c.w.kill('a')`, `c.w.pause('a', 5000)` | the same, now |
| `c.ok(cond, msg)`, `c.eq(a, b, msg)` | assertions; `eq` compares JSON |
| `c.note(s)` | printed beside a failing seed |
| `c.w.history` | every verb's invoke and completion: `{ proc, res, op, key, arg, t0, t1, ok, value, code, outcome, v }`. Convert it for Porcupine and Elle (TEST-13) |
| `c.stack` | the internals, for asserting on them: `c.stack.k` (catalog, groups, `moves`, `stats`), `c.stack.l2.writers` (each group's writer state), `c.stack.l3.replicaIf(proc, name)` (a process's replica) |
| `fero('#locks')` | a handle on a system resource (`#locks`, `#sessions`, `#calls`); the first open creates it, so a library needs nothing but `fero()` |

After the body, the harness checks three monitors on every seed: no divergence between what a writer judged and what data folded; every caught-up replica equal to a fresh fold of the committed log; no user-code throw while folding (pass `{ faultsOk: true }` to a check of DATA-06).

**Flags** on any check: `--seeds N` (seeds 1 to N), `--seed S` (one seed), `--trace` (print every event of that seed), `--no-chaos` (skip the schedule).

## Rules that make a check mean something

1. **A server needs a server marker.** `server: true`, `data`, `methods`, `listen`, `dir` or a code key. A process that passes only `rows`, `history`, `partition` or `durability` is a client, and a resource nobody serves never commits (API-NOTES C1). Patterns that open a bare name (P-08, P-10, P-11, P-15, P-17) need the check to start the server the example does not show.
2. **Put the faults inside the work.** Look at the line the check prints: `faults hit: N elections, M tail entries lost, k/k moves done, d retries answered by dedup`. If `lost` and `dedup` stay 0 over 100 seeds, the faults landed before or after the work; move `c.chaos()` or shorten `within`. Add `{ at, do: 'drop', p: 0.05 }` to make acks go missing, which is what exercises dedup.
3. **Run it under the shuffle.** The shuffle is on in every world: a replica applies different partitions' entries in a seeded order (each partition keeps its own), and a log reader takes groups in a seeded order. 100 seeds are 100 shuffles (TEST-12). An example that passes only with `fero.world({ shuffle: false })` leans on an order that will not last.
4. **Do not use real time or real randomness** in examples: no `setTimeout`, `Date.now()` or `Math.random()`. Use `fero.now()`, `fero.id()` and `w.advance()`. A real timer breaks replay.
5. **A live reader never ends.** `for await (const e of f.read(…))` waits for the next record forever; `break` out, or `close()` it (API-NOTES C10).
6. **One check per guarantee row.** Name the REQUIREMENTS id in the check's first comment, and assert the guarantee itself (an exact count, an order, an equality), not only that nothing threw.
7. **Use the API as API.md types it.** `./run.sh types` type-checks every example against API.md's own `fero.d.ts` (`checks/api-types.mjs`). An example that needs a prototype-only addition (`touch`'s `lease`, a `#locks` row) says so in a comment and in API-NOTES.
8. **Keep each check fast**: 100 seeds in a few seconds. The core checks run 100 to 200 seeds in 0.3 to 1.7 s.

## What the core offers a library (L5)

L5 libraries (`queue`, `lock`, `group`, `derive`, `saga`, `limiter`, `service`, `migrate`, `tape`) go in `lib/<name>.ts`, exported from `lib/index.ts`. Each is built **only** from what `proto/index.ts` exports: the verbs and `fero()`. Never import `proto/kernel.ts`, `l2.ts` or `l3.ts` from a library: that would hide a sixth kernel operation, which is what Q-22 asks about. What the verbs give a library:

| Need | The verb |
|---|---|
| exactly once per attempt | every write carries an attempt id; fero resends it by itself and the writer answers a resend from its table. Inside a keyed method call, `ctx`'s writes get ids made from the call key, so a re-run writes nothing twice |
| a lease on a row | `claim({ partition, n, lease, where })`: rows of one partition in the order they were first written, skipping live leases; `where(row, t)` gets writer time. An empty claim writes nothing. `Claimed.deliveries` counts claims of that row |
| extend or end a lease | `touch(key, { lease, if: { version: token } })` (an addition, API-NOTES C2); `lease: 0` ends it |
| ack | `remove(key, { if: { version: token } })`: `conflict` if the lease lapsed and someone claimed it again |
| a fencing token | a row in `fero('#locks')` written with `if: { absent: true }` or `if: { expired: true }`: its `Ack.version` is the token. Every writer compares `if: { fence: { lock, token } }` with the newest token of that lock it has seen (API-NOTES C6) |
| a row that dies with its writer | `set(key, v, { while: 'session' })`, or `rows: { while: 'session' }`; the row goes `session.ms` (10 s) after the process stops renewing |
| expiry | `ttl` on a write, `rows.ttl` on the resource; the writer removes the row with `reason: 'ttl'` |
| a position in a stream | `read({ from, partitions | prefix | share })` and `reader.cursor`; a cursor stays exact across leader changes and moves |
| a share of a stream | `read({ share: { index, of } })`: a partition is in one share forever |
| check-then-set | `get(key, { version: true })` then `set(…, { if: { version } })`, or an op; never a plain read then set (API-NOTES C5) |
| writer time | `ctx.now()` in a method; `Claimed.until`; `Entry.t` |

## Files

| File | What |
|---|---|
| [proto/world.ts](proto/world.ts) | the world: processes, the clock, the event queue and driver, the network and fsync model, faults, the history |
| [proto/kernel.ts](proto/kernel.ts) | L1: groups, logs, the five operations, elections that lose uncommitted tails, the slot move, joins and leaves |
| [proto/l2.ts](proto/l2.ts) | L2: the writer's state as a fold of its log, and the judge |
| [proto/l3.ts](proto/l3.ts) | L3: replicas, the feed (order across groups and moves), log readers and cursors, follows, the near cache, the fold monitor |
| [proto/api.ts](proto/api.ts) | L4: `fero()`, the resource, the verbs, routing and retries, methods and `ctx`, keyed calls, sessions, the cluster view |
| [proto/seam.ts](proto/seam.ts) | the one importer of data: the fold, the lens, the snapshot proxy |
| [proto/check.ts](proto/check.ts) | the check harness |
| [proto/index.ts](proto/index.ts) | what an example imports |
