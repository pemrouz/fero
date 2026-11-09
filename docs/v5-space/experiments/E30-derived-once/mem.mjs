// E-30 memory probe: what a B writer keeps to spot a repeated output, in
// Node, for the two options that hold. Run: node --expose-gc mem.mjs <design> <n>
// (the same method as E-20's mem.mjs: build the map, full GC, heap delta).
//
//   srcpos   one key per output applied, kept for the source's retention:
//            key (source slot, source sequence, k) -> the output's position.
//            n is the number of keys held = outputs per second x retention.
//   srchi    one number per (consumer, source slot, B slot) this writer has
//            applied outputs for: key -> the highest source sequence.
//            n is the number of such triples the writer holds.
//
// Prints bytes per entry after a full GC.

const [design, nArg] = process.argv.slice(2)
const n = Number(nArg)

function build() {
  const m = new Map()
  if (design === 'srcpos') {
    // a 53-bit number packs (slot 10 bits, sequence 40 bits, k 3 bits): the
    // cheapest honest key; a string key would cost more
    for (let i = 0; i < n; i++) {
      const slot = i & 1023, seq = Math.floor(i / 1024), k = i % 3
      m.set(slot * 2 ** 43 + seq * 8 + k, { slot: (i * 7) & 1023, seq: i })
    }
  } else if (design === 'srchi') {
    // key: consumer id (a group member's registered number) x source slot x B slot
    for (let i = 0; i < n; i++) {
      const consumer = Math.floor(i / (1024 * 4)), sslot = (i >> 2) & 1023, bslot = (i * 257) & 1023
      m.set((consumer * 1024 + sslot) * 1024 + bslot, i + 7)
    }
  } else throw new Error('design?')
  return m
}

globalThis.gc(); globalThis.gc()
const before = process.memoryUsage().heapUsed
const keep = build()
globalThis.gc(); globalThis.gc()
const after = process.memoryUsage().heapUsed
console.log(JSON.stringify({ design, n, entries: keep.size, bytes_per_entry: Math.round((after - before) / keep.size),
  total_mb: Math.round((after - before) / 1e6) }))
