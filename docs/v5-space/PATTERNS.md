# fero v5 patterns: how the common jobs are done

This page walks through six jobs that most apps need, and shows how fero v5 does each one. The six are: answering a request, consuming a log, a work queue, a lock, a saga across resources, and keeping one resource derived from another. Each job's section has the same parts, so you can jump to the part you want.

- **Nothing here is built.** The code type-checks against the declarations in [API.md](API.md) (its section 6); section 11 of this page shows how. [E-22] ran all of API.md's patterns on a prototype, with older names for the calls, and with leader changes forced in.
- **The names and calls are API.md's** as of 2026-11-20 (decisions V5-1 to V5-15 in [DECISIONS.md][dec]). Where API.md is silent and this page picks, it says *this page's reading*.
- **How each claim is marked.** (measured): timed. (checked): a model checker, a simulation with fixed random seeds, or the TypeScript compiler ran it. (reasoned): an argument, or sums on measured parts. (a guess): nobody measured it. (from memory): an outside fact not checked here.
- **Where the numbers come from.** E-nn is an experiment under [experiments/](experiments). PATHS 3.7, LAYERS 8.8, MEMORY 9.3 and TRANSFORMS 3.4 are sections of [PATHS.md](PATHS.md), [LAYERS.md](LAYERS.md), [MEMORY.md](MEMORY.md) and [TRANSFORMS.md](TRANSFORMS.md).
- **L1 to L5 are the layers** of [LAYERS.md](LAYERS.md), named under each "What happens". L1 keeps the log and its copies (Raft). L2 judges writes and turns records into rows: conditions, ops, marks, writer time. L3 is the reads that stay: live links, `changes()` and cursors. L4 is the surface: `fero()`, the lens and its verbs. L5 is the libraries, built only from L4's calls.

## 1. Words first

Each word is explained once, here.

| Word | In one sentence |
|---|---|
| resource | A named, shared map of rows, such as `fero('orders')`. Underneath, each is a small cluster of its own. |
| row | One entry of a resource: a key and a JSON-like value, with its own version and expiry. |
| lens | A path into a resource, such as `orders.data['o-981']` or `shop.data.widgets.stock`. Building one sends nothing. You read and write through it with verbs: `get()`, `set()`, `connect()`. |
| server, client | A **server** holds a copy of a resource and can lead part of it. A **client** only uses it. The role is per resource, and comes from how the process opens it: `server: true`, a `data` seed or `methods:` make a server. |
| leader | The one server that puts a partition's writes in one order and judges them. If it fails, another copy takes over. |
| partition | The rows that one leader keeps in one order and can change together. The first key of a lens is the partition. By default each row is its own partition. At `depth: 2` the second key is the row, so one partition holds many rows. There is no order across partitions. |
| slot | One of a resource's 4,096 fixed parts. Each partition's key hashes to one slot. |
| group | One log with one leader. It holds some of a resource's slots, and so many partitions. A resource has one group or more. (`#groups`, below, is named for consumer groups, not for this.) |
| commit | A write is on disk on most of the copies. Only then can anyone see it. |
| log | Every committed change, in order within each partition. `changes()` reads it. The resource's `history` option says how long it is kept. |
| record | One change on the log. A reader gets each one as `e`. `e.partition` says where it landed. `e.value` is the whole row, and is set only when the record wrote a whole row. |
| version | A record's place in its partition's log: short text that sorts in log order, such as `38S9`. |
| cursor | A reader's place in the log, across partitions: text you save and give back as `from`. |
| `get()`, `connect()` | `get()` reads a value once, and keeps nothing. `connect()` keeps a live link: the newest state now, then again after each commit. A slow reader of a live link skips to the newest. |
| stage | How far your own write has got when you hear back. A plain write (a whole-row `set` or `remove`, with no `if`, `once` or `from`) can answer early: at `received` (the leader has it), then `replicated`. Every other write answers only at its commit. |
| op | A change the leader works out on the newest value, such as `op.incr(-1)`. |
| condition | A test the leader checks before it writes, such as `if: { absent: true }`. If it fails, the write is refused `conflict`. |
| `set(fn)` | Read the row, call `fn`, and write the result only if the row has not changed meanwhile. If it has, read and try again. |
| `once` | A name your code gives a write or a call. A retry under the same name, from any process, gets the first answer. A name lasts one day, and costs about 221 B for that day (API.md section 7). |
| session | One process's life, kept by a lease that the process renews by itself (`session.ms`, 10 s). Rows bound to it die with the process. |
| lease | A hold that ends at a set time unless it is renewed. |
| writer time | The clock that leases and expiry use: the leader's clock, held to the median of the members' clocks, never going back. |
| claim | A write the leader judges: it leases to the caller the first rows that are due and have no live lease. Queues and services take work this way. |
| fencing token | A number that rises with each new holder of a lock. A write carries it, and the leader refuses a token older than one it has seen. |
| mark | A note that says "source record `e` is done". The write option `{ from: e }` puts it in the same log entry as the output it made. So a restart skips what is done. |
| share | A part of a source's partitions that one consumer owns at a time. |
| served view | A view the server names in its `methods:`. It is kept on one copy, for every client that asks. |
| `#` names | fero's own system resources: `#locks`, `#groups` (where consumers keep their places), `#sagas`, `#calls`, `#sessions`. |
| at least once | Nothing is lost, but after a crash some work may happen twice. |
| exactly once | Each item has its effect once, through crashes and resends. In fero, only for writes into fero, never for an email your code sends. |

## 2. What a pattern is here

A pattern is a small library on top of rows and the log. It is not a new part of fero.
- **Nothing new in the kernel.** [E-22] built nine libraries and ran all 22 patterns on the kernel's five operations: append, read, snapshot, change members and hand over. None needed a sixth (checked).
- **A library uses only the public calls:** `fero()`, the lens and its verbs, conditions, ops, `claim` and marks. None adds a message to the wire ([LAYERS.md](LAYERS.md) section 6, L5).
- **So a library's state is plain rows.** A lock is a row of `#locks`. A queue's job is a row of the queue. A consumer's place is a row of `#groups`. Any process that serves a resource serves the `#` resources too (*API.md's reading*, section 7).
- **A library's resource still needs a server.** `queue('resizes', { server: true })`, in a server process, creates and serves it. Workers open the bare name, and are clients.

## 3. If you used something else for the job

| If you used | fero's pattern | The difference |
|---|---|---|
| NATS request-reply | a method, or `service()` (section 4) | A method is one trip, to the server that holds the row. A service writes each request and reply to disk: three commits per ask, where NATS core keeps a request only in memory (from memory). So a request outlives a worker's crash, and another worker takes it. The asker may still time out first: with a worker killed in half the runs, 17 of 400 asks did in [E-22]. |
| a Kafka consumer group | `consumer()` (section 5) | Exactly once into fero comes from a mark in the target's own log, with no transaction coordinator. It holds while the source keeps its log back to the mark, and while fero paces the loop. Kafka needs transactions and `sendOffsetsToTransaction`. In return, a Kafka transaction's outputs to several partitions show together to `read_committed` readers (from memory). fero's do not (API.md 3.11). |
| an SQS-style queue | `queue()` (section 6) | The lease plays SQS's visibility timeout, counted in writer time. Jobs come out first in, first out within a partition. Once another worker takes a job, the first worker's late ack is refused, since its token is old. Like an SQS standard queue, a job may still run twice. SQS's FIFO queues keep order within a message group, and drop a resent message within 5 minutes (from memory). |
| a Redis lock (`SET NX PX`, Redlock) | `lock()` (section 7) | Each holder gets a rising token, and the leader of the row you write refuses an older one. A Redis lock gives no token to check (from memory). |
| a workflow engine (Temporal, Step Functions) | `saga()` (section 8) | A saga is a short list of writes with their undos, run under fenced locks. It is not a long-running workflow. Temporal replays your workflow code from its history; Step Functions runs a state machine you declare (from memory). |
| a materialized view (Postgres, ksqlDB) | `derive()` (section 9) | The target is a resource of its own, kept live. The view form keeps it equal to a view of the source's rows. The record form applies each source record once, by marks. ksqlDB keeps its tables live too; a Postgres materialized view changes only when you refresh it (from memory). |

**Why not build these on someone else's log?** [E-44] built four patterns on NATS JetStream in 164 lines, and they passed their main checks. But a failover took 5.2 to 7.2 s. And a retried write landed twice once JetStream's dedup window had passed. The run set that window to 1 s to show this; the default is 2 minutes (measured, on a shared box, so rough). fero's own dedup has limits too: a resend counts once within a session, and a `once` name for a day. fero's own failover is not timed yet, since nothing is built.

## 4. Answering a request

**The job.** A caller asks a question and waits for one answer. Two shapes: the server that holds the data answers (a **method**), or a pool of workers answers (a **service**).

**The code: a method.** A method is a function the resource's servers host. When a resource declares methods, clients change its rows only by calling them (V4-5, "the door").

```ts
// file: answer.ts — answering a request with a method: the server that holds the row answers
import { fero } from 'fero'
// ── shop.ts, a server: a seed and methods make it one
const shop = await fero('shop', { data: { widgets: { stock: 10, cents: 500 } }, methods: {
  quote: { at: 'row', run: async (n: number, ctx) => {               // runs at the row's leader
    const w = await ctx.at.get()                                     // the leader holds the row: no trip
    return { cents: n * (w?.cents ?? 0), left: w?.stock ?? 0 }       // it wrote nothing, so it waits for no commit
  } },
} })
export type Shop = typeof shop                                       // the client imports this type, never the handle
// ── app.ts, a client typed by the server: `import type { Shop } from './shop.ts'`
const app = await fero<Shop>('shop')
const q = await app.data.widgets.quote(3)                            // one trip, to the leader of widgets
console.log(q.cents, q.left)
// @ts-expect-error the door (V4-5): a client of a resource with methods changes rows only by calling them
await app.data.widgets.stock.set(4)
```

**The code: a service.** A service is a library. Askers write requests into the service's own resource, and any number of workers take them and answer.

```ts
// file: answer-service.ts — answering a request with a service: any number of workers answer
import { service } from 'fero'
type Thumb = { url: string }
// ── svc.ts, a server: it creates and serves the service's own resource
await service<Thumb, Thumb>('thumbs', { server: true })
// ── worker.ts, run as many as you like: each takes requests and answers them
const worker = await service<Thumb, Thumb>('thumbs')
worker.answer(async (req) => ({ url: await resize(req.url) }), { concurrency: 4 })
// ── app.ts, an asker
const asker = await service<Thumb, Thumb>('thumbs')
const small = await asker.ask({ url: 'a.png' }, { timeout: '5s' })  // one answer, or 'timeout', or 'no-answerer'
console.log(small.url)
// @ts-expect-error the request is checked against the service's type
await asker.ask({ path: 'a.png' })
```

**What happens: a method** (L4, then L2; API.md 3.8).
1. Here: the client hashes the lens's first key, `widgets`, to find its leader, and sends the call there. One trip.
2. At the leader: the server checks that `quote` may run on a row (`at: 'row'`), then runs it. `ctx.at.get()` reads the leader's own copy.
3. This handler wrote nothing, so its reply waits for no disk. If a handler writes, its reply waits until each of its writes has committed, at this same leader.

**What happens: a service** (L5, on L2's `claim`; API.md gives the calls, [E-22]'s library the rows).
1. `answer()` writes a presence row for the worker, bound to its session. So the row dies with the process.
2. `ask()` looks for a live answerer. With none, it fails `no-answerer` at once. Otherwise it writes the request as a row, with a ttl (a time to live) as long as its timeout. Commit 1.
3. A worker **claims** the request: the leader of its partition leases the row to that worker. Commit 2. The worker runs your function.
4. The worker writes the reply, only if no reply exists yet. Commit 3. The asker follows its own reply rows, so it gets the reply. The worker then removes the request, after the asker has its answer.

**What it promises, and what it does not.**
- A method runs where its row lives, on the newest committed state. It is not a transaction. A check-then-set inside it must still be an op (such as `op.incr`) or a condition (`if: { … }`), so that the leader judges it. In [E-22], a plain read then a plain set sold the last item twice in 120 of 120 races (checked).
- A service gives each request at most one answer. It does not promise one run. A worker that pauses past its lease may run a request that another worker also runs. Only the first reply is kept.

**When something breaks.**
- **The server dies during a call.** The caller gets `unknown`: the call may have run, and fero does not send it again. `{ retry: true }` sends it again: use it only for a handler that is safe to run twice, as `quote` is. `{ once: 'q-17' }` names the call instead. fero first claims that name in `#calls`, so the call runs at most once, from any process, for a day. A retry gets the first answer.
- **The leader changes.** The call is redirected once, then goes straight to the new leader ([E-55] claim 18, on a prototype; checked).
- **A worker dies mid-request.** Its claim lapses, and another worker takes the request. With an answerer killed in half the runs: 383 answers and 17 timeouts of 400 asks, never two answers ([E-22]; checked).
- **The only worker just died.** It still looks alive for up to `session.ms` (10 s), so asks time out instead of failing at once ([E-22] D7).
- **A request comes twice.** fero's own resends count once within a session ([E-20]). A second `ask` from your code is a second request.

**Cost.**
- A method on a path: one trip, to the row's leader. A trip on one box is about 40 µs at the median. [E-01] measured that for a bare message in Node, not for a method call (measured).
- Each write the handler makes adds one commit: about 1 ms at the median, with its disk sync shared with other writes (MEMORY 9.3; reasoned).
- With `once`: three commits in a row (claim the name in `#calls`, run, store the result), and up to two more trips (API.md 3.8).
- A service ask: three commits in a row. In E-22's simulation, 6.0 ms at the median against 2.15 ms for one write (checked, in simulated time).

**Use something else when.** The work is long, or must outlive the asker: a work queue (section 6). Many callers watch the same answer live: a served view (API.md 3.10).

## 5. Consuming a log

**The job.** Read every change of a resource, in order, and act on each. Several processes share the work, and a crash loses nothing.

**The code.**

```ts
// file: consume.ts — consuming a log: a reader on its own, then a group (at least once)
import { fero, consumer } from 'fero'
type Order = { user: string; cents: number; paid?: boolean }
// ── orders.ts, a server: it keeps 7 days of log for its readers
await fero<Order>('orders', { server: true, history: '7d' })
// ── report.ts, one reader: it saves its own place
const orders = await fero<Order>('orders')
const r = orders.data.changes({ from: saved ?? 'earliest' })        // every partition, from a saved cursor
for await (const e of r) { console.log(e.partition, e.value?.cents); keep(r.cursor) }
// ── billing.ts, run it in as many processes as you like: each share has one owner at a time
const billing = await consumer(orders, 'billing')
for await (const batch of billing) {
  for (const e of batch.entries) await bill(e.value)               // your own side effect: it may run twice after a crash
  await batch.commit()                                             // moves the share's cursor; a paused owner's is refused 'fenced'
}
```

```ts
// file: consume-once.ts — consuming a log into fero exactly once: a mark rides each write
import { fero, consumer } from 'fero'
type Order = { user: string; cents: number; paid?: boolean }
// ── invoicing.ts, run it in as many processes as you like: a client of orders and of invoices
const orders = await fero<Order>('orders')
const invoices = await fero<{ cents: number }>('invoices')
const invoicing = await consumer(orders, 'invoicing')
invoicing.run((e) => {                                             // once per record, in the shares this process owns
  if (e.value) invoices.data[e.partition].set({ cents: e.value.cents }, { from: e })   // not awaited: fero paces the loop
})
// @ts-expect-error a marked write may be skipped at its mark, so it answers at its commit only: no early `received`
invoicing.run((e) => invoices.data[e.partition].set({ cents: 1 }, { from: e }).received)
```

**What happens** (L5, over L3's log reader and L2's fences; LAYERS 6.2, 6.3, 8.8).
1. A plain reader, `changes({ from })`, opens one subscription at a copy, then gets each record as it commits. You save `r.cursor` yourself.
2. `consumer(orders, 'billing')` writes a member row in `#groups`, bound to this process's session.
3. The source's partitions are split into **shares**. Each share has one owner at a time. A lease row in `#locks` holds it, and that row's version is the share's token. ([E-22]'s library used 16 shares; a partition stays in its share for good.)
4. A new owner reads the share's cursor from `#groups`. It writes that cursor back once, under its own token, before it reads the log. After that, an older owner's late write of the cursor is refused `fenced`.
5. It reads its shares' log from that cursor. `commit()` writes the cursor under the token: one commit per batch.
6. `run(fn)` writes no cursor per batch. Each output carries `{ from: e }`, so its mark lands in the same log entry as the output, at the target's leader. That leader keeps the highest mark it has applied, per reader name and source slot. It skips a write at or below that mark, and answers it as done.
7. `run(fn)` still keeps each share's cursor, so a restart knows where to read from. It writes the cursor now and then, and moves it only once the marked writes up to it are answered. So a restart may read some records again; their writes are skipped at their marks (API.md P-08, LAYERS 6.3, PATHS 4.14; *API.md's reading*).
8. fero paces `run`: a marked write is never refused `backpressure`. Instead the reader stops giving records until the line of waiting writes is short again (V5-12).

**What it promises, and what it does not.**
- Every committed record reaches one owner, in order within its partition. There is no order across partitions.
- `commit()` is at least once: after a crash, the records since the last commit come again, and your code runs again.
- `run()` with `{ from: e }` is exactly once for the writes into fero, even after a long stop, while the source keeps its log back to the share's cursor ([E-30]; checked). It is not exactly once for an email or a payment your function makes.
- Two runs are not done yet. E-30's model wrote the mark itself, so a model run with the mark written by your code, as here, is still to do. So is a test of the pacing in a real client (API.md 3.11).
- `e.value` is set only when a record wrote a whole row. Write orders whole, or use `derive` with rows (section 9).

**When something breaks.**
- **A member crashes.** Its lease lapses, and other members take its shares, within one lease plus one commit (API.md P-08; reasoned, not measured).
- **A member pauses**, say in a long GC. Its shares go to others, and its late `commit()` is refused `fenced`: 40 of 40 such commits were refused in [E-22] (checked).
- **The leader changes, or a slot moves.** A cursor keeps its meaning across both ([E-31]; checked).
- **A record comes twice.** With `commit()`, your code sees it twice. With `run()`, the second write is skipped at its mark.
- **The log was cut.** A reader whose cursor is older than what the source keeps (its `history`) gets `expired` and stops. It never skips ahead.

**Cost.**
- A reader: one trip to open; then each kept record crosses the wire once. A cursor is 22 to 79 B for 1 to 10 partitions ([E-19]; measured).
- `commit()`: one commit per batch.
- `run()`: one marked write per output. Writes sent together go in the same commits. The target keeps each mark in 29 B: one mark per reader, source slot and target slot, however many records flow ([E-30]; measured).
- Speed: marked writes that are not awaited ran at 122,000 to 134,000 a second. Awaited one by one, they ran at 239 to 240 a second ([E-55] claim 21; measured on a prototype whose commit was a 4 ms timer, not a disk).

**Use something else when.** The output should be a resource equal to a function of the source: `derive()` (section 9). Each item is a job for one worker, with retries and a dead-letter: a queue (section 6). You need only the newest state, not every change: `connect()`, where a slow reader skips to the newest.

## 6. A work queue

**The job.** Hand each job to one worker. If the worker dies, hand the job to another. After too many tries, set it aside.

**The code.**

```ts
// file: work-queue.ts — a work queue: add, then work; or take and ack by hand
import { queue } from 'fero'
type Thumb = { url: string }
// ── jobs.ts, a server: it creates and serves the queue
await queue<Thumb>('resizes', { server: true, lease: '30s', deliveries: 5 })
// ── web.ts, a client: add a job
const resizes = await queue<Thumb>('resizes')
await resizes.add({ url: 'a.png' }, { key: 'a.png' })             // written only if absent: the same key twice is one job
// ── worker.ts, run as many as you like
const jobs = await queue<Thumb>('resizes')
jobs.work(async (job) => { await resize(job.url) }, { concurrency: 4 })   // return: done. throw: tried again later
const [m] = await jobs.take(1, { wait: '20s' })                    // or by hand: one job, leased to you for 30 s
if (m) await resize(m.job.url).then(() => m.ack(), () => m.nack({ delay: '1m' }))
// @ts-expect-error the job is checked against the queue's type when it is added
await resizes.add({ path: 'b.png' })
```

**What happens** (L5, on L2's `claim`; API.md P-09 and P-22; PATHS 4.13).
1. `add` writes the job as a row of the queue; with `key`, only if no row has that key. Commit 1. The jobs share a partition, so one leader keeps them in order. In [E-22]'s library that partition was `main`, unless `add`'s `partition` option named another.
2. A take is a **claim** at the leader of the queue's partition. The leader leases the first rows that are due and have no live lease. It writes the lease and the count of tries. Commit 2. The claim's version is its token. An empty take writes nothing.
3. `work` runs your function. A return acks: the row is removed under the token. Commit 3. A throw sends the job back, to be taken again.
4. After `deliveries` tries, the job is written to `resizes.dead`, then removed from the queue.
5. A take with `wait` follows the queue's partition, and wakes when a job is added. It writes nothing while it waits.

**What it promises, and what it does not.**
- At most one live lease per job. No job is lost until it is acked. First in, first out within a partition. Priorities hold within a partition, and a delayed job is never taken before its time, by writer time (API.md P-09, P-22).
- It does not promise one run. A worker that pauses past its lease may still finish a job that another worker has taken. Make jobs safe to run twice.

**When something breaks.**
- **A worker crashes.** Its lease lapses by writer time, and the job can be taken again. A lapse writes nothing, so workers notice it at the library's next poll, once a second ([E-22] D6).
- **A worker pauses past its lease.** Another worker takes the job, and the first one's `ack` is refused, since its token is old. With one worker killed and one paused 40 s, each job was removed once, never under two live leases ([E-22]; checked).
- **The leader changes.** A claim is a committed write. An empty take is answered only after the state the leader judged it on has committed. So no take is told "empty" because of a write that a leader change then lost (API.md section 7).
- **An add comes twice.** fero's own resends count once. Two adds with one `key`, from two processes, are one job while it is in the queue (reasoned).

**Cost.**
- Three commits per job: add, take, ack (PATHS 4.13; reasoned).
- With N workers waiting, one add wakes all N, and N − 1 claims come back empty (reasoned).
- The fix is to let a waiting take wait at the leader. It waits for the first build's measurements (V5-9).

**Use something else when.** Every consumer must see every message: a log (section 5). The caller waits for an answer: a service (section 4).

## 7. A lock

**The job.** Let one process at a time do something, and make sure an old holder that wakes up late cannot do harm.

**The code.**

```ts
// file: locks.ts — a lock with a fenced write, and a leader for life
import { fero, lock } from 'fero'
// ── payroll.ts, a client of ledger: it only writes, under locks
const ledger = await fero<{ by: number }>('ledger')
await lock('payroll', { lease: '10s', wait: '5s' }, async (l) => {     // one holder at a time; released on return or throw
  await ledger.data['run-42'].set({ by: process.pid }, { if: { lock: l } })   // fenced: refused once a newer holder wrote here
})
const leader = await lock('leader:billing', { wait: 'forever' })       // held until release()
ledger.data['run-42'].connect((row) => draw(row), { signal: leader.signal })   // a live link that ends when the lock goes
leader.lost.then(() => process.exit(1))                                // the lease is gone: stop acting now
// @ts-expect-error a fence needs the holder's token, not only the lock's name
await ledger.data['run-43'].set({ by: 1 }, { if: { lock: 'payroll' } })
```

**What happens** (L5, on L2's conditions; API.md section 7, "Locks").
1. `lock('payroll')` writes the row `payroll` of `#locks`, only if it is absent or its lease has lapsed. One commit. That write's version is the token. Tokens rise for ever.
2. While you hold it, the lease is renewed. (*This page's reading* of `lock()`'s `renew` option, which API.md declares but does not explain. [E-22]'s library renewed every third of the lease.)
3. A protected write carries `if: { lock: l }`: the lock's name and token. The leader of that write's partition keeps, per lock, the newest token it has seen, even after the lock row is gone. It refuses an older token with `fenced`. It reads no other resource: leaders do not follow `#locks` ([E-24]).
4. When your function returns or throws, the row is removed under the token. `l.signal` aborts, so the links you gave it end.
5. A process that waits watches the row. Past `wait`, it gives up with `locked`.

**What it promises, and what it does not.**
- **At most one holder per lease, while most clocks are sound.** The lease counts in writer time. If most of the members' clocks are wrong, two holders can overlap: [E-21] saw 2 early lock grants in 30 such runs (checked, in simulation). Then only the fence protects your writes.
- No write under an older token commits at a partition whose leader has seen a newer one. But before the new holder's first write there, a stale write can still land ([E-22] F5). To close that gap, write to that partition under the new token first.
- A lock guards only the writes that carry its token. It does not stop a paused holder's code, or an email it sends.

**When something breaks.**
- **The holder crashes.** The lease lapses by writer time, and the next taker gets a higher token.
- **The holder pauses** (a GC, a stalled VM). It may still believe it holds the lock. Its writes under the old token are refused wherever the new holder already wrote. [E-21] tried several rules for writer time. Under each, 28 to 127 such late writes were sent, and the fence refused them all, even when writer time was the leader's own unchecked clock (checked).
- **The leader of `#locks` changes.** A renewal sent during the election reaches no leader. So in E-22's prototype, a new leader of `#locks` gave every lease one more `election.ms` (its rule D10). A paused holder can then keep the lock up to one `election.ms` longer per `#locks` election, and the next taker waits that much longer ([E-22] F5). API.md and LAYERS.md do not say whether v5 keeps this rule (*this page's reading*: it is the prototype's).
- **A protected write comes twice.** A resend of a write that committed answers `ok`, never `fenced` (API.md section 7).
- **Clocks are wrong.** The fence uses no clock. The lease uses writer time, so one wrong clock, the leader's included, changes nothing ([E-21]; checked). When most clocks are wrong, the group keeps writing by a wrong time. In 30 such runs, 104 rows expired early, 370 late, and 2 locks were granted early ([E-21]; checked). A guard that makes the group stop instead costs 2 more rules. Whether to add it is still open ([AMENDMENTS.md](AMENDMENTS.md) G-11, and its question 12).

**Cost.**
- Taking the lock: one conditional write, so one commit, about 1 ms at the median on one box (MEMORY 9.3; reasoned).
- Each renewal: one more commit.
- A fenced write: an ordinary write, plus one check at its leader.
- Memory: every group that a fenced write reaches keeps the newest token for that lock, even after the lock row is gone. The records do not say how big that table grows, or when an entry may go (not measured).

**Use something else when.** The job is a check-then-set on one row: an op or a condition does it at the leader, with no lock. In [E-22] they gave one winner in all 300 races (checked). `set(fn)` makes the same check with a retry loop, but that loop has not run yet (API.md P-14). Many jobs, each done once: a queue (section 6).

## 8. A saga across resources

**The job.** Change rows in two places, so that both changes stay or neither does. Here: take 2 widgets from `stock` and write the order `o-981`.

**The code.** A step takes one lens: any lens that can write. So the steps may sit in different resources. (*This page's reading*: to a saga, another resource's partition is one more partition in one more group. [E-24]'s model placed every partition that way.)

```ts
// file: sagas.ts — a saga across two resources: both steps stay, or neither does
import { fero, op, saga } from 'fero'
import type { Shop } from './answer.ts'
type Order = { user: string; cents: number; paid?: boolean }
// ── stock.ts, a server: it serves stock, and so the system resources too
await fero<{ left: number }>('stock', { server: true })
saga.sweep({ every: '10s' })                                         // finish or undo what a dead holder left
// ── checkout.ts, a client of resources with no methods: so it may write
const stock = await fero<{ left: number }>('stock')
const orders = await fero<Order>('orders')
await saga([
  { at: stock.data.widgets.left, value: op.incr(-2, { min: 0 }) },   // its undo, incr(+2), is worked out for you
  { at: orders.data['o-981'], value: { user: 'ada', cents: 1000 }, if: { absent: true }, undo: { remove: true } },
], { once: 'o-981' })                                                // a retry under this name, from any process, is the same saga
// ── admin.ts, a client typed by a resource with methods
const shop = await fero<Shop>('shop')
// @ts-expect-error a step needs a lens that can write: a client of a resource with methods has none (V4-5)
await saga([{ at: shop.data.widgets.stock, value: 9 }])
```

**What happens** (L5; rows in `#locks` and `#sagas`; PATHS 3.7).
1. Take each step's partition lock in `#locks`, in key order. One commit each.
2. Read `#sagas`. If another saga was left unfinished on these partitions, finish or undo it first.
3. Write the intent, `run`, with the steps. One commit.
4. Run each step at its own leader, fenced by its partition's lock token. One commit each, one after another.
5. Write `done`, answer, then release the locks.

**If a step is refused** (here, the stock would go below 0), the saga is undone. It writes `undo`, undoes the steps backwards, then writes `undone`. It undoes every step, applied or not: the failed one and those after it too. That way each of the saga's partitions gets a write fenced by its lock's token, which raises the fence there. So a paused holder's late step is refused at every partition ([E-24]).

**What it promises, and what it does not.**
- Every saga ends all applied or all undone, by its holder or a later one, even with paused holders. Model-checked on seven bounds, up to 2.9 million states ([E-24]; checked).
- No write cycle between two sagas. At first, the Elle history checker found one in 10 to 19 of 100 histories. Then each saga's locks were made its own until it ended: each step is fenced by its partition's lock, and an unfinished saga on those partitions is finished first. After that, Elle found none in 300 histories ([E-22]; checked).
- **Readers may see half.** A reader can see the stock taken and no order yet: in 66 to 77 of 100 histories ([E-22]; checked). fero gave this up on purpose (V5-1).
- The locks fence only the saga's own writes. Other code's plain write to the same row is not stopped (reasoned).

**When something breaks.**
- **The holder crashes.** Its locks lapse. A retry under the same `once` name, from any process, finds the intent and finishes it in its recorded direction ([E-24] checked such a later holder). `saga.sweep` on a server does the same on a timer (reasoned; not modelled).
- **The holder pauses.** A later holder takes the locks with higher tokens, and writes every partition of the saga. So the paused holder's late step is refused `fenced` ([E-24]).
- **The leader changes during a step.** fero resends the step, and it commits at most once ([E-20]).
- **A step has no undo.** `push`, `merge`, `max` and `min` cannot be inverted. Give such a step its own `undo`, or the saga is refused `no-undo` before it starts ([E-22] F4).

**Cost.**
- 6 to 7 commits in a row and one read round: about 7 ms on one box (PATHS 3.7; reasoned, 7 × 0.97 ms).
- Two-phase commit as Percolator runs it needs 2 commits in a row. A design with a fixed order, as Calvin's, needs 1 (PATHS 3.7; from memory). So a saga costs about 3 times Percolator's.

**Use something else when.** Both rows can live in one partition. At `depth: 2` one partition holds many rows. One `batch` (several writes to one partition, as one log entry) is then all or none in one commit, and nobody sees half. Readers must never see half: fero does not offer that across partitions. A step takes minutes, or waits for a person: a workflow engine.

## 9. Keeping one resource derived from another

**The job.** Keep `totals` equal to the sum of each user's orders as `orders` changes. Or keep `paid` holding each user's paid cents, each order counted once.

**The code.** `derive` has two forms (decided in V5-14 and V5-15). The **view form** keeps the target's rows equal to a bucket view of the source: one row per bucket, here one per user. The **record form** runs your function once per source record.

```ts
// file: derived.ts — one resource kept from another: the view form, then the record form with rows
import { fero, op, derive } from 'fero'
type Order = { user: string; cents: number; paid?: boolean }
// ── totals.ts, a server of the source and of each target
const orders = await fero<Order>('orders', { server: true, history: '7d' })   // the record form reads the log: keep enough
const totals = await fero<number>('totals', { server: true })
await derive(orders.data.by('user').sum('cents'), totals)          // totals.ada is the sum of ada's orders, kept equal
const paid = await fero<number>('paid', { server: true })
await derive(orders, paid, (e, { row, prev }) => {                  // once per record, with the row after and before it
  if (row?.paid && !prev?.paid) paid.data[row.user].set(op.incr(row.cents), { from: e })   // the mark: { from: e }
}, { rows: true })
// ── app.ts, a client of a target: it reads it like any resource
const sums = await fero<number>('totals')
console.log(await sums.data.ada.get())                              // one read, one trip; or connect() to keep it live here
// @ts-expect-error the row after and before come only when you ask for rows
await derive(orders, paid, (e, { row }) => row)
```

**What happens: the view form** (L5; LAYERS 8.8, TRANSFORMS 3.4).
1. Take the lock `derive:totals`. Its row carries the deriver's code version, so older code never takes over from newer.
2. **Bump**: send one fenced write that changes nothing to every group of `totals`, and wait for each answer. After that, an older deriver's late write there is refused.
3. **Read barrier**: read `orders`' position after the bumps. Work out the view up to that position, writing nothing yet.
4. Read `totals`, then write the difference: a set per changed bucket, a remove per bucket that went.
5. Follow `orders`: one fenced write per changed bucket per commit.

**What happens: the record form.**
1. Read `paid.marks(name)`, where `name` is the deriver's name: `derive`'s `name` option (*this page's reading*: by default the target's own name). For each source slot, it gives the lowest mark over `paid`'s slots. That is the cursor.
2. Read `orders`' log from there, for the shares this deriver owns. With `{ rows: true }` it also keeps its share of `orders`' rows in memory, so `fn` gets the row after the record and the row before it.
3. Run `fn` per record. Each output is a marked write, not awaited. A record with no output gets a bare mark, so idle slots keep up.
4. At `paid`'s leader, a write at or below the stored mark is skipped and answered as done. Any other is applied, and its mark raised, in one log entry.

**What it promises, and what it does not.**
- **The view form.** `totals` equals the view once it catches up. It never steps back, and never goes back to older code. The first design failed 514 of 1,000 seeds; with the bump, the barrier and the code version, 0 of 1,000 failed ([E-57] B3; checked). It reads rows, not the log, so it needs no `history`.
- The view form still has one gap. A stale write from an older deriver can land at a target group before the bump reaches it. The next difference repairs it: 1,389 did, all repaired ([E-57] B3; checked).
- In the view form, only the deriver writes the target. Any other write is refused `derived` (TRANSFORMS 3.4, LAYERS 6.3; reasoned, not run).
- **The record form.** [E-30] checked it without rows. Each source record changes the target exactly once, through crashes, restarts and moves, while the source keeps its log back to the marks (checked). E-30's model wrote the marks itself; a run with the marks written by your code is not done yet, as in section 5.
- **The record form with rows, as `paid` uses it.** The same promise is meant to hold. But on a restart it also opens `orders`' past at the mark, and works the rows forward from there. That part is reasoned, not built, and its model is not run yet (LAYERS 6.3, 6.4).
- The target trails the source by about one commit. There is no transaction across the two.
- The view form's own log is a log of states. To count events, use the record form.

**When something breaks.**
- **The deriver crashes.** Another server of the target takes over: the lock, for the view form; the shares, for the record form. Several servers of `paid` split the work, so it is done once.
- **Old code comes back**, after a rollback. It does not take over from newer code until an admin resets the lock row's version.
- **A record comes twice.** Its write is skipped at its mark.
- **The source's log was cut** past the marks. The record form stops with `expired` and says so; it never skips a record (reasoned; not modelled: E-30's model kept the whole log, LAYERS 8.8). The view form does not care: 7,475 starts after the log was cut, 0 wrong ([E-57] B3; checked).
- **The source loses its majority.** The target stops getting changes, and keeps serving what it has (LAYERS 8.8; reasoned, not modelled).

**Cost.**
- The view form: the view's own work on the deriver, and 0.748 target writes per source commit ([E-57] B3's mix; checked). A restart at 100,000 source rows and 1,000 buckets: 48.7 to 51.8 ms ([E-57] B3; measured).
- The record form: one marked write per output; writes sent together go in the same commits. The target keeps each mark in 29 B, one per reader, source slot and target slot ([E-30]; measured).
- With rows: applying each record to its row costs 0.63 to 1.5 µs. The deriver keeps its share of the rows, at about 330 B a row ([E-57] A1, [E-05]; measured). The form with rows is not built yet (V5-15).

**Use something else when.** You need the answer on a screen, not stored: a served view, or operators right of `connect()`, which run in this process (API.md 3.10). A join on a screen: `lookup`, right of `connect()`. A side effect outside fero: a consumer with `commit()` (section 5).

## 10. Every pattern of API.md, and which of the six it builds on

The six lean on each other too:
- a service is a small queue of requests;
- a consumer and `derive` hold their shares with lease rows, as a lock does;
- `derive` is a consumer that writes with marks.

| API.md pattern | Builds on |
|---|---|
| P-01 Live shared state | none: rows and `connect()` |
| P-02 Cache with expiry, session store | none: rows with a ttl |
| P-03 Near cache, client data sync | none: `get()` and `connect()` |
| P-04 Read-through cache | none: a `load` and a condition |
| P-05 WebSocket fan-out by room | none: one shared `connect()` per room |
| P-06 Pub/sub | consuming a log: a plain reader, from now on |
| P-07 Streams and replay | consuming a log: a reader with a saved cursor |
| P-08 Consumer groups | consuming a log: `consumer()` |
| P-09 Work queue | a work queue |
| P-10 Locks and leader election | a lock |
| P-11 Counters and rate limits | none: ops at the leader (`limiter` is its own small library) |
| P-12 Leaderboards, live aggregates | none: served views; to keep one for good, a derived resource |
| P-13 Presence | none: rows that die with their session |
| P-14 Invariants | answering a request: a method on a row |
| P-15 Transactions across partitions | a saga |
| P-16 Event sourcing, CQRS | consuming a log (a rebuild); kept in fero, a derived resource |
| P-17 Derived resources | a derived resource |
| P-18 Tapes, forks, replays | none |
| P-19 Clients everywhere | none |
| P-20 Change the shape of rows | none (`migrate` is a paced loop of its own) |
| P-21 Request and reply | answering a request: `service()`, or a method |
| P-22 Delayed jobs, waiting takes, priorities | a work queue |

## 11. How this page is checked

Each `ts` block whose first line is `// file: …` is written to a fresh folder, with API.md's own `fero.d.ts` and `env.d.ts`, and type-checked with TypeScript. Then each line marked `// @ts-expect-error` must fail at its own line, and nothing else may fail.

```js check
// PATTERNS.md checker: this page's "// file: <name>" blocks, with API.md's fero.d.ts and env.d.ts, are written to a
// fresh folder and type-checked with tsc against data's shipped types (DATA names data's folder; ../data by default).
// Then, in a copy where each @ts-expect-error is a plain comment, each line it marks must fail, and nothing else may.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
const page = process.argv[1]
const data = resolve(process.env.DATA ?? '../data')
const blocks = (file) => [...readFileSync(file, 'utf8').matchAll(/^( *)```ts\n\1(\/\/ file: (\S+)[^\n]*\n[\s\S]*?)^\1```/gm)]
  .map(([, pad, body, name]) => [name, body.replace(new RegExp('^' + pad, 'gm'), '')])
const base = blocks(join(dirname(page), 'API.md')).filter(([name]) => name === 'fero.d.ts' || name === 'env.d.ts')
if (base.length !== 2) { console.log('API.md must hold one fero.d.ts and one env.d.ts block'); process.exit(1) }
const own = blocks(page)
const root = mkdtempSync(join(tmpdir(), 'fero-patterns-'))
const compilerOptions = { target: 'es2022', module: 'esnext', moduleResolution: 'bundler', strict: true, noEmit: true,
  types: [], lib: ['es2022', 'dom'], paths: { fero: ['./fero.d.ts'], data: [join(data, 'types/public.d.ts')] } }
const put = (dir, strip) => {
  const marked = []
  mkdirSync(dir)
  for (const [name, body] of base) writeFileSync(join(dir, name), body)
  for (const [name, body] of own) {
    const lines = body.split('\n')
    if (strip) lines.forEach((l, i) => {
      if (l.includes('// @ts-expect-error')) { marked.push(`${name}:${i + 2}`); lines[i] = l.replace('@ts-expect-error', '(must fail below)') }
    })
    writeFileSync(join(dir, name), lines.join('\n'))
  }
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions, files: [...base, ...own].map(([name]) => name) }))
  return marked
}
put(join(root, 'page'), false)
console.log(`${own.length} blocks of this page → ${join(root, 'page')}`)
execFileSync('tsc', ['-p', join(root, 'page', 'tsconfig.json')], { stdio: 'inherit' })
console.log(`ok: ${own.length} blocks type-check (tsc ${execFileSync('tsc', ['-v']).toString().trim()})`)
const marked = put(join(root, 'stripped'), true)
let out = ''
try { execFileSync('tsc', ['-p', join(root, 'stripped', 'tsconfig.json')], { encoding: 'utf8' }) } catch (e) { out = e.stdout }
const errors = out.split('\n').filter((l) => /^\S+\(\d+,\d+\): error/.test(l))
const at = errors.map((l) => l.replace(/^(\S+?)\((\d+),\d+\).*$/, (_, f, n) => `${f.split('/').pop()}:${n}`))
for (const l of errors) console.log('  ' + l.split('/').pop().slice(0, 150))
const missed = marked.filter((m) => !at.includes(m)), stray = at.filter((a) => !marked.includes(a))
console.log(`stripped → ${join(root, 'stripped')}: ${marked.length} marked lines, ${marked.length - missed.length} fail at their own line, ${stray.length} errors elsewhere`)
if (!marked.length || missed.length || stray.length) { console.log({ missed, stray }); process.exit(1) }
```

Run it from the repo root, with `tsc` on `PATH` and data next to this repo (or `DATA` naming its folder):

```sh
node --input-type=module -e "$(awk '/^```js check$/{f=1;next} /^```$/{f=0} f' docs/v5-space/PATTERNS.md)" docs/v5-space/PATTERNS.md
```

**Result, run here on 2026-11-20** (Node 22.22.0, TypeScript 6.0.2, data at 63fea66): `ok: 8 blocks type-check (tsc Version 6.0.2)`, then `7 marked lines, 7 fail at their own line, 0 errors elsewhere`.
- **The seven that must fail**, one in each block but `consume.ts`, each for the reason its comment gives: a write on a typed client of a resource with methods (`answer.ts`, TS2339); a request and a job of the wrong shape (`answer-service.ts`, `work-queue.ts`, TS2353); `received` on a marked write (`consume-once.ts`, TS2339); a lock's name where its token belongs (`locks.ts`, TS2769); a saga step on a lens that cannot write (`sagas.ts`, TS2739); `{ row }` without `{ rows: true }` (`derived.ts`, TS2769; with no overload to match, `e` and `row` get no type, so the same line also gives TS7006 and TS7031).
- **Not checked here: that any of it runs.** Nothing on this page is built.

[dec]: ../DECISIONS.md
[E-01]: experiments/E01-floors/README.md
[E-05]: experiments/E05-fold-cost/README.md
[E-19]: experiments/E19-slot-positions/README.md
[E-20]: experiments/E20-dedup/README.md
[E-21]: experiments/E21-time/README.md
[E-22]: experiments/E22-api-prototype/README.md
[E-24]: experiments/E24-sagas-ramp/README.md
[E-30]: experiments/E30-derived-once/README.md
[E-31]: experiments/E31-subscribe/README.md
[E-44]: experiments/E44-outside-log/README.md
[E-55]: experiments/E55-lens-prototype/README.md
[E-57]: experiments/E57-transforms/README.md
