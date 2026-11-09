// E-40 cold client in Node: a fresh process imports the same browser bundle (client.mjs) and makes its first
// committed write over wss. Times are ms from process start (Node's performance.timeOrigin).
//   NODE_EXTRA_CA_CERTS=<cert.pem> node cold-node.mjs <bundle.mjs> <wss url>
const t0 = performance.now()
const [bundle, url] = process.argv.slice(2)
const a = performance.now()
const c = await import(bundle)
const b = performance.now()
const cl = await c.connect(url, { name: 'room', secret: 'e40-secret', firstWrite: [{ type: 0, key: ['k1', 'n'], value: 1 }] })
const m = {}; for (const [k, v] of Object.entries(cl.marks)) m[k] = +v.toFixed(2)
// a second client in the same process: what a connection costs once the runtime is warm
const cl2 = await c.connect(url, { name: 'room', secret: 'e40-secret', firstWrite: [{ type: 0, key: ['k2', 'n'], value: 2 }] })
const w = {}; for (const [k, v] of Object.entries(cl2.marks)) w[k] = +(v - cl2.marks.start).toFixed(2)
console.log(JSON.stringify({ mode: 'node', node: process.version, script_start: +t0.toFixed(2), import_ms: +(b - a).toFixed(2), marks: m, warm: w, rows: Object.keys(cl.data[Symbol.for('data.v4.value')] ?? {}).length }))
cl.close(); cl2.close(); process.exit(0)
