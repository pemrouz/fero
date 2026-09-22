import { fero } from '../../api/index.ts'

// three members, this file three times with the ports rotated: with replicas 2, every row lives on two of them
const ports = process.argv.slice(2), [mine, ...peers] = ports.map((p) => `127.0.0.1:${p}`)
const f = await fero('shards', { listen: mine, hosts: peers, rendezvous: false, replicas: 2 })
console.log(`MEMBER ${process.pid} on ${mine}`)

// once every member is in, the view commits and scoping arms: a row has two holders now, so write three
await new Promise<void>((ok) => f.cluster.tap(() => Object.keys(f.cluster.snapshot().members).length === ports.length && ok()))
for (const n of [1, 2, 3]) f.data[`${n}-${ports[0]}`] = { v: n }

// a shard is never the resource: a sync read or an operator on a member throws, typed
for (const read of [() => f.snapshot, () => f.data.filter(() => true)]) try { read() } catch ({ op, reason }) { console.log(op, reason) }

// the whole resource is a gather, polled until every member's rows are in — a row not held here is one hop away
let all = await f.data
while (Object.keys(all).length < 3 * ports.length) all = await new Promise((r) => setTimeout(() => r(f.data), 250))
console.log(`holds ${f.cluster.partitions.snapshot().held} of ${Object.keys(all).length}`)
for (const k of Object.keys(all)) try { void f.data[k].v } catch ({ reason }) { console.log(k, reason, '→', await f.data[k]) }
