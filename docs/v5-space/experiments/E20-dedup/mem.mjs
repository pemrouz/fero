// E-20 memory probe: the writer's dedup state per client, in Node, as each
// option keeps it (one shard's writer). Run: node --expose-gc mem.mjs <design> <n>
//
//   win       per issuer: { hi, outs: Map(id -> outcome) }, one outcome held (the
//             issuer's latest; the window W bounds how many), issuer id a string
//             (process id + life, as DESIGN-V5 4.3)
//   sess      per session: { floor, outs: Map(seq -> outcome) }, one outcome held,
//             session id a number (its registration position in #s)
//   sessslot  sess with the state split per (session, slot), so a slot move carries
//             its part: each client touches 4 slots, so n clients make 4n entries
//   pid       per (producer, partition): { epoch, last, cache[5] } (Kafka keeps the
//             last 5 batches' sequence and offset); each producer writes 4 partitions
//   keys      per write: key (22-char random id) -> outcome, kept for the key's TTL;
//             n here is the number of keys held (writes/s x TTL)
//
// An outcome is { kind, slot, epoch, seq }: the position the answer names.
// Prints bytes per client (or per key) after a full GC.

const [design, nArg] = process.argv.slice(2)
const n = Number(nArg)
const outcome = (i) => ({ kind: 1, slot: i & 1023, epoch: 3, seq: i })
const rnd = (i) => (i.toString(36) + 'x'.repeat(22)).slice(0, 22)

function build() {
  const m = new Map()
  if (design === 'win') {
    for (let i = 0; i < n; i++) {
      const outs = new Map(); outs.set(i + 7, outcome(i))
      m.set(`p${(1e6 + i).toString(36)}:${(i % 9973).toString(36)}`, { hi: i + 7, last: i, outs })
    }
  } else if (design === 'sess') {
    for (let i = 0; i < n; i++) {
      const outs = new Map(); outs.set(7, outcome(i))
      m.set(1e6 + i, { floor: 7, outs })
    }
  } else if (design === 'sessslot') {
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < 4; s++) {
        const outs = new Map(); outs.set(7, outcome(i))
        m.set((1e6 + i) * 1024 + ((i + s * 257) & 1023), { floor: 7, outs })
      }
    }
  } else if (design === 'pid') {
    for (let i = 0; i < n; i++) {
      for (let s = 0; s < 4; s++) {
        const cache = []
        for (let k = 0; k < 5; k++) cache.push({ seq: i + k, epoch: 3, offset: i * 5 + k })
        m.set(`${1e6 + i}/${(i + s * 257) & 1023}`, { epoch: 0, last: i + 4, cache })
      }
    }
  } else if (design === 'keys') {
    for (let i = 0; i < n; i++) m.set(rnd(i * 2654435761), { ...outcome(i), t: 1700000000000 + i })
  } else throw new Error('design?')
  return m
}

globalThis.gc(); globalThis.gc()
const before = process.memoryUsage().heapUsed
const keep = build()
globalThis.gc(); globalThis.gc()
const after = process.memoryUsage().heapUsed
const per = (after - before) / n
console.log(JSON.stringify({ design, n, entries: keep.size, bytes_per_client: Math.round(per),
  total_mb: Math.round((after - before) / 1048576) }))
