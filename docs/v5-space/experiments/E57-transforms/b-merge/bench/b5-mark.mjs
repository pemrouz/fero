// B5, bytes per mark: what a B writer keeps per (consumer, source slot, B slot), E-30's mem.mjs method (build the
// map, full collection, heap delta), for today's mark (the source sequence) and the mark with the write's number:
// packed into the same number (sequence x 256 + w, exact while the sequence stays below 2^45) or as a pair.
//   node --expose-gc b5-mark.mjs
const n = 1e6
const gc = () => { globalThis.gc(); globalThis.gc() }
const out = { exp: 'E-57', part: 'b-merge', claim: 'B5', bench: 'mark-bytes', node: process.version, entries: n, bytesPerEntry: {} }
for (const way of ['sequence (today)', 'sequence x 256 + w (packed)', '[sequence, w] (a pair)']) {
  gc()
  const h0 = process.memoryUsage().heapUsed
  const m = new Map()
  for (let i = 0; i < n; i++) {
    const consumer = Math.floor(i / (1024 * 4)), sslot = (i >> 2) & 1023, bslot = (i * 257) & 1023
    const key = (consumer * 1024 + sslot) * 1024 + bslot, seq = i + 7
    m.set(key, way.startsWith('sequence (') ? seq : way.includes('packed') ? seq * 256 + (i & 3) : [seq, i & 3])
  }
  gc()
  out.bytesPerEntry[way] = Math.round((process.memoryUsage().heapUsed - h0) / n)
  m.clear()
}
out.onTheWire = 'the write number is a small integer: one more varint byte per marked write while w < 128 (reasoned)'
console.log(JSON.stringify(out))
