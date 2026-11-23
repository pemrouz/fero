// E-65 X5, part `clientmerge` timing: what merging costs a client per partial frame, for a top 10.
// The client keeps every group's top 10 and, on a frame from group g, replaces g's list and takes the best
// 10 of the G lists (a k-way pick over sorted lists: 10 steps of a scan over G heads).
// Usage: node cm-bench.mjs [run]   prints one JSON line
let seed = 11
const r = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296 }
const K = 10
function bench(G) {
  const lists = Array.from({ length: G }, () => Array.from({ length: K }, () => Math.floor(r() * 1e9)).sort((a, b) => b - a))
  const heads = new Int32Array(G)
  let sink = 0
  const F = 200000
  const frames = Array.from({ length: 1024 }, () => [Math.floor(r() * G), Array.from({ length: K }, () => Math.floor(r() * 1e9)).sort((a, b) => b - a)])
  const t0 = process.hrtime.bigint()
  for (let f = 0; f < F; f++) {
    const [g, list] = frames[f & 1023]
    lists[g] = list
    heads.fill(0)
    for (let i = 0; i < K; i++) {                             // pick the best head, K times
      let best = -1, bv = -Infinity
      for (let j = 0; j < G; j++) { const h = heads[j]; if (h < K && lists[j][h] > bv) { bv = lists[j][h]; best = j } }
      heads[best]++; sink += bv
    }
  }
  return { G, nsPerFrame: Math.round(Number(process.hrtime.bigint() - t0) / F), sink: sink > 0 }
}
console.log(JSON.stringify({ part: 'cm-bench', run: +(process.argv[2] ?? 1), node: process.version, top10: [bench(16), bench(256)] }))
