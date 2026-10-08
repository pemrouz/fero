import { writeFileSync } from 'node:fs'
import { fero, type Fero } from '../../api/index.ts'
import { diag, JK } from '../../internals.ts'

// three members in one process, each dialing the ones before it: a, the lowest id, proposes the first view
const nodes: Fero[] = []
for (const uuid of ['c', 'b', 'a']) nodes.push(await fero('story', { uuid, listen: '127.0.0.1:0', hosts: nodes.map((n) => n.cluster.me.snapshot().listen), rendezvous: false }))
const [c, b, a] = nodes
const write = (f: Fero, key: string, value: string) => f.methods.update({ key, value })
const settle = async (key: string) => { while (!nodes.every((n) => n.cluster.snapshot().epoch && n.data[key].snapshot() === a.data[key].snapshot())) await new Promise((r) => setTimeout(r, 25)) }

// act 1, the open window: before the first view every member stamps for itself, so two writes to one cell are an election
const [ra, rb] = await Promise.all([write(a, 'spot', 'from a'), write(b, 'spot', 'from b')])
await settle('spot')
console.log(`race: 'from a' is ${ra.origin}:${ra.seq}, 'from b' is ${rb.origin}:${rb.seq} → spot is '${a.data.spot.snapshot()}' on a, b, c`)

// act 2, history: with a view one member stamps every write to a cell, in turn — no election
// (the key names are picked for their owners: the ring hash puts 'spot' on b and 'missed' on c)
const [sa, sb] = await Promise.all([write(a, 'spot', 'a again'), write(b, 'spot', 'b again')])
await settle('spot')
console.log(`history: 'a again' is ${sa.origin}:${sa.seq}, 'b again' is ${sb.origin}:${sb.seq} → spot is '${a.data.spot.snapshot()}' on a, b, c`)

// act 3, the cut: a drops its socket to c — c's write reaches b at once and a when the link heals, by anti-entropy
diag(a)!.drop!('c')
const rc = await write(c, 'missed', 'the cut')
await settle('missed')
console.log(`cut: a dropped its link to c, 'the cut' is ${rc.origin}:${rc.seq} → missed is '${a.data.missed.snapshot()}' on a, b, c`)

writeFileSync('story.capture.json', JSON.stringify({ v: 1, kind: 'live', vocab: JK, seed: null, nodes: nodes.map((n) => diag(n)!.capture()) }))
console.log('open it: npm run debug -- examples/22-time-travel/story.capture.json')
for (const n of nodes) await n.destroy()
