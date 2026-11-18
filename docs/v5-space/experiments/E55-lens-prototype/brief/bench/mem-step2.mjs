// Memory data keeps per distinct key read through its handle, one fresh promoted source per way.
// node --expose-gc mem-step2.mjs <rows> <way: get1 | sugar2>
import { pathToFileURL } from 'node:url'
const D = await import(pathToFileURL(process.env.TREE + '/data/api/index.ts').href)
const VALUE = Symbol.for('data.v4.value')
const N = +process.argv[2], way = process.argv[3]
const rows = {}; for (let i = 0; i < N; i++) rows['k' + i] = { n: i, name: 'user-' + i }
const keys = Object.keys(rows)
const gc = () => { globalThis.gc(); globalThis.gc() }
const q = D.$(rows); q.promote()
let s = 0
for (let i = 0; i < 1000; i++) s += q.get(keys[i])[VALUE].n   // warm the code paths and the Map
gc(); const h0 = process.memoryUsage().heapUsed
if (way === 'get1') for (let i = 1000; i < N; i++) s += q.get(keys[i])[VALUE].n
else for (let i = 1000; i < N; i++) s += q[keys[i]].n[VALUE]
gc(); const h1 = process.memoryUsage().heapUsed
console.log(JSON.stringify({ bench: 'mem-step2', node: process.version, rows: N, way, bytesPerKey: Math.round((h1 - h0) / (N - 1000)), s: s > 0 }))
