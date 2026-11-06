// order — F4's evidence. A gateway forwards a client's pipelined writes (NATS PUBs, a Kafka
// producer's batches, JetStream async publishes) as fero writes to ONE partition, several in
// flight at once. Does the log keep the order they were issued in? API.md promises order per
// partition in the LOG; it says nothing about the order of concurrent, unawaited writes from one
// process. Here: one client process issues 40 set()s to one row without awaiting, while a seeded
// leader change hits the group; then the log is read and its order compared with issue order.
// The same run with each write chained on the previous one (what the gateways do) is the control.
//
//   node --experimental-strip-types --no-warnings checks/order.check.ts [--seeds 100]

import { fero } from '../../E22-api-prototype/proto/index.ts'

const argv = process.argv.slice(2)
const seeds = Number(argv[argv.indexOf('--seeds') + 1] || 100)
const N = 40

const run = async (seed: number, chained: boolean): Promise<{ inversions: number; committed: number; lost: number }> => {
  const w = fero.world({ seed, shuffle: false })
  const servers = ['s1', 's2', 's3'].map((id) => w.proc(id))
  for (const s of servers) await s.run(() => s.fero('topic', { server: true, rows: false, history: 'all' }))
  await w.settle()
  const c = w.proc('client')
  const res = await c.run(() => c.fero('topic'))
  w.chaos({ leaderChanges: 1, moves: 0, within: 4, res: 'topic' })   // inside the burst below
  const acks: Promise<unknown>[] = []
  let prev: Promise<unknown> = Promise.resolve()
  for (let i = 0; i < N; i++) {
    const go = () => c.run(() => res.set('k', { i }, { timeout: '60s' }))
    const p = chained ? prev.then(go, go) : go()
    prev = p
    acks.push(p.catch(() => null))
  }
  await Promise.all(acks)
  await w.settle()
  const r = c.run(() => res.read({ from: 'earliest', partitions: ['k'] }))
  const got: number[] = []
  const it = r[Symbol.asyncIterator]()
  // read what is committed, then stop (a live reader never ends)
  for (;;) {
    const next = await Promise.race([it.next(), w.settle().then(() => 'idle' as const)])
    if (next === 'idle' || (next as IteratorResult<any>).done) break
    got.push(((next as IteratorResult<any>).value.rec.value as { i: number }).i)
  }
  r.close()
  let inversions = 0
  for (let j = 1; j < got.length; j++) if (got[j] < got[j - 1]) inversions++
  await w.close()
  return { inversions, committed: got.length, lost: N - new Set(got).size }
}

for (const chained of [false, true]) {
  let bad = 0, inv = 0, lost = 0, committed = 0
  for (let s = 1; s <= seeds; s++) {
    const r = await run(s, chained)
    if (r.inversions > 0) bad++
    inv += r.inversions; lost += r.lost; committed += r.committed
  }
  console.log(`${chained ? 'chained (each write after the previous answer)' : 'pipelined (40 writes in flight)'}: ${bad} of ${seeds} seeds commit out of issue order (${inv} inversions); ${committed} entries committed for ${seeds * N} writes; ${lost} writes missing`)
}
process.exit(0)
