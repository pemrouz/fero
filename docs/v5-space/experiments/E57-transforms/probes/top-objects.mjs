// Probe: top(n) over object rows compares whole objects with < and >, so every pair ties; arrival decides.
import { fileURLToPath } from 'node:url'
const D = await import((process.env.DATA ?? fileURLToPath(new URL('../../../../../../data', import.meta.url))) + '/api/index.ts')
const { $, node: NODE, lane } = D
const keys = (h) => { const o = []; h[NODE].each((k) => o.push(k)); return o }
const a = $({}), b = $({}); const La = lane(a), Lb = lane(b)
La([{ type: 0, key: ['lo'], value: { s: 1 } }]); La([{ type: 0, key: ['hi'], value: { s: 9 } }])
Lb([{ type: 0, key: ['hi'], value: { s: 9 } }]); Lb([{ type: 0, key: ['lo'], value: { s: 1 } }])
console.log('top(1) over object rows, lo first:', keys(a.top(1)), ' hi first:', keys(b.top(1)))
const n = $({ x: 3, y: 7, z: 5 })
console.log('top(2) over number rows:', keys(n.top(2)))
