// E-40 cold client in a dedicated Web Worker (the Worker-like runtime): import, connect, door, first write.
const q = new URLSearchParams(location.search)
const a = performance.now()
const c = await import('./client.mjs')
const b = performance.now()
const cl = await c.connect(q.get('wss'), { name: 'room', secret: 'e40-secret', firstWrite: [{ type: 0, key: ['k1', 'n'], value: 1 }] })
const cl2 = await c.connect(q.get('wss'), { name: 'room', secret: 'e40-secret', firstWrite: [{ type: 0, key: ['k2', 'n'], value: 2 }] }) // warm: a second client
const warm = {}; for (const [k, v] of Object.entries(cl2.marks)) warm[k] = +(v - cl2.marks.start).toFixed(2)
postMessage({ timeOrigin: performance.timeOrigin, import_ms: +(b - a).toFixed(2), marks: { worker_script: a, ...cl.marks }, warm, rows: Object.keys(cl.data[Symbol.for('data.v4.value')] ?? {}).length })
