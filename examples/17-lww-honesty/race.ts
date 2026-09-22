import { fero } from '../../api/index.ts'

// two members in one process, so every read and write happens in a known order
const b = await fero('tally', { uuid: 'b', listen: '127.0.0.1:0', rendezvous: false })
const a = await fero('tally', { uuid: 'a', listen: '127.0.0.1:0', hosts: [b.cluster.me.snapshot().listen], rendezvous: false })

// the first view — 'a' proposes it, being the lowest id and the one that dials — until then 'replicated' means 'I hold it'
await new Promise<void>((ok) => b.cluster.tap(() => b.cluster.snapshot().epoch && ok()))

// a write awaited at 'replicated' is held by both members when it resolves
const write = (f: typeof a, key: string, value: unknown) => f.methods.update({ key, value }, { confirm: 'replicated' })

// both read the count, then both write it back plus one
await write(a, 'count', 0)
const [va, vb] = await Promise.all([a.data.count, b.data.count])
const [ra, rb] = await Promise.all([write(a, 'count', va + 1), write(b, 'count', vb + 1)])
console.log(`two increments of ${va}, stamped ${ra.origin}:${ra.seq} and ${rb.origin}:${rb.seq} → count is ${await a.data.count} on a, ${await b.data.count} on b`)

// the fix: one row per increment, never rewritten, and a fold over the rows
const [fa, fb] = await Promise.all([write(a, 'a-1', { n: 1 }), write(b, 'b-1', { n: 1 })])
console.log(`two facts { n: 1 }, stamped ${fa.origin}:${fa.seq} and ${fb.origin}:${fb.seq} → sum is ${a.data.sum('n').snapshot()} on a, ${b.data.sum('n').snapshot()} on b`)

for (const f of [a, b]) await f.destroy()
