// How long after an anchor is dropped does a FinalizationRegistry callback run? Node 22, no forced GC in the timed part.
const mode = process.argv[2]            // idle | alloc | old-idle | old-alloc
const N = 1000
let fired = 0, first = -1, t0 = 0
const reg = new FinalizationRegistry(() => { fired++; if (first < 0) first = performance.now() - t0 })
// register cost
{ const xs = []; for (let i = 0; i < 100000; i++) xs.push({}); const a = performance.now(); const r2 = new FinalizationRegistry(() => {}); for (const x of xs) r2.register(x, 1); var regNs = (performance.now() - a) * 1e6 / 100000 }
let anchors = []; for (let i = 0; i < N; i++) { const a = { i }; reg.register(a, i); anchors.push(a) }
if (mode.startsWith('old')) { globalThis.gc(); globalThis.gc() }   // promote the anchors to the old generation
await new Promise((r) => setTimeout(r, 50))
anchors = null; t0 = performance.now()
let junk = []
const tick = () => { if (mode.endsWith('alloc')) { junk = []; for (let i = 0; i < 2000; i++) junk.push({ a: i, b: 'x' + i }) } }   // about 100 KB per 10 ms tick
const marks = {}
for (const at of [100, 1000, 5000, 15000, 30000]) {
  while (performance.now() - t0 < at) { tick(); await new Promise((r) => setTimeout(r, 10)) }
  marks[at] = fired
}
console.log(JSON.stringify({ bench: 'fin-time', node: process.version, mode, anchors: N, registerNs: +regNs.toFixed(0), firstMs: +first.toFixed(0), firedByMs: marks }))
