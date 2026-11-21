// E-62 item 4: the per-row version store kept inside the row's own entry in data's store, timed against the separate
// Map (CONNECT 3.6 and 9; E-56 positions' `ver`: +10.5 to +276 ns a write over a plain Map write, 29-37 B a row).
//   node --expose-gc --experimental-strip-types verstore.mjs <rows> <shape: row | field>
// Two copies of data's kernel in one process: data as it is (DATA, read only) and a scratch copy with patch/
// data-ver.patch (DV): Store.vers, a Float64Array beside `slots`, indexed by the same slot, and SourceNode.write(key,
// path, value, at, ver) storing `ver` there right after the one keySlot probe the write already makes.
// One store of `rows` rows (E-05's small row), promoted to data's packed lane. Each write replaces a row picked at
// random (seeded) with a new row made before the clock starts (shape row, as E-56's tree bench), or sets its field n
// to a new number (shape field, fero's common write). Ways, all on the patched copy's one store, interleaved:
//   base      SourceNode.write with no version (the column is there; the write skips it)
//   map       base, then vmap.set(key, version): E-56's `ver` beside data's store
//   slot      SourceNode.write(..., version): the version in the row's own entry
//   map big   map with versions above 2^31 (a real version is (epoch << 40 | sequence): never a small integer)
//   slot big  slot with the same versions
//   orig      the unpatched data's own store of the same rows, base only (the patch must cost a plain write nothing)
// And the read the leader makes for `if: { version }` and a diff entry: vmap.get(key) against store.verOf(key).
// Memory: the column is 8 B a slot, allocated by doubling; the Map's bytes come from the heap, the median of 3 builds.
import { pathToFileURL, fileURLToPath } from 'node:url'
import { row, key, rng, gc, heap, out, interleave } from './common.mjs'

const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../data', import.meta.url))
const DV = process.env.DV
if (!DV) throw new Error('set DV to the patched copy of data (run.sh makes it)')
const load = async (root) => ({ RT: (await import(pathToFileURL(root + '/kernel/runtime.ts').href)).Runtime, SN: (await import(pathToFileURL(root + '/kernel/node.ts').href)).SourceNode })
const O = await load(DATA), P = await load(DV)

const N = +process.argv[2], SHAPE = process.argv[3] ?? 'row'
const SEG = +(process.env.WRITES ?? 100000), ROUNDS = +(process.env.ROUNDS ?? 21)
const keys = Array.from({ length: N }, (_, i) => key(i))
const seed = () => { const o = {}; for (let i = 0; i < N; i++) o[keys[i]] = row(i); return o }
const EMPTY = Object.freeze([]), NPATH = Object.freeze(['n'])

const src = new P.SN(new P.RT(), seed()); src.store.keepVersions()
const orig = new O.SN(new O.RT(), seed()); orig.store.promote()
const vmap = new Map(); for (let i = 0; i < N; i++) vmap.set(keys[i], i + 1)
for (let i = 0; i < N; i++) src.store.vers[src.store.slotOf(keys[i])] = i + 1
let seq = N, big = 2 ** 40 * 3 + N // epoch 3: above 2^31, still exact in a double while epoch < 2^13
const r = rng(62)

// each timed segment writes SEG seeded keys; its fresh rows (or numbers) are made before the clock starts
const idx = new Int32Array(SEG)
let fresh = new Array(SEG)
let stamp = 1e6
function prep(round) {
  for (let w = 0; w < SEG; w++) idx[w] = Math.floor(r() * N)
  if (SHAPE === 'row') for (let w = 0; w < SEG; w++) fresh[w] = row(idx[w], ++stamp)
  else for (let w = 0; w < SEG; w++) fresh[w] = ++stamp + 0.5 // a double, as a real field value often is
  void round
}
const path = SHAPE === 'row' ? EMPTY : NPATH
const ways = {
  base: () => { for (let w = 0; w < SEG; w++) src.write(keys[idx[w]], path, fresh[w]); return SEG },
  map: () => { for (let w = 0; w < SEG; w++) { const k = keys[idx[w]]; src.write(k, path, fresh[w]); vmap.set(k, ++seq) } return SEG },
  slot: () => { for (let w = 0; w < SEG; w++) src.write(keys[idx[w]], path, fresh[w], undefined, ++seq); return SEG },
  'map big': () => { for (let w = 0; w < SEG; w++) { const k = keys[idx[w]]; src.write(k, path, fresh[w]); vmap.set(k, ++big) } return SEG },
  'slot big': () => { for (let w = 0; w < SEG; w++) src.write(keys[idx[w]], path, fresh[w], undefined, ++big); return SEG },
  orig: () => { for (let w = 0; w < SEG; w++) orig.write(keys[idx[w]], path, fresh[w]); return SEG },
}
// interleave() calls gc() then the way; make each way prepare its own fresh input first, outside the clock
const names = Object.keys(ways)
const xs = Object.fromEntries(names.map((k) => [k, []]))
const now = () => process.hrtime.bigint()
for (const k of names) { prep(-1); ways[k]() } // warm
for (let rd = 0; rd < ROUNDS; rd++) {
  for (let j = 0; j < names.length; j++) {
    const k = names[(j + rd) % names.length]
    prep(rd); gc(); const t0 = now(); ways[k](); xs[k].push(Number(now() - t0) / SEG)
  }
}
const st = (v) => { const s = [...v].sort((a, b) => a - b); return { med: Math.round(s[s.length >> 1] * 10) / 10, lo: Math.round(s[0] * 10) / 10, hi: Math.round(s[s.length - 1] * 10) / 10 } }
const diff = (a, b) => st(xs[a].map((x, i) => x - xs[b][i]))
const ns = Object.fromEntries(names.map((k) => [k, st(xs[k])]))

// reads: the version of a random row, for `if: { version }` at the leader and a diff entry's version
let sink = 0
const R = 200000, ridx = Int32Array.from({ length: R }, () => Math.floor(r() * N))
const reads = interleave({
  'map get': () => { for (let j = 0; j < R; j++) sink = (sink + (vmap.get(keys[ridx[j]]) & 7)) & 1023; return R },
  'slot get': () => { for (let j = 0; j < R; j++) sink = (sink + (src.store.verOf(keys[ridx[j]]) & 7)) & 1023; return R },
  'row get': () => { for (let j = 0; j < R; j++) sink = (sink + (src.get(keys[ridx[j]]).room & 7)) & 1023; return R },
}, { rounds: ROUNDS, ops: R })

// check: write every row once more through both ways with the same versions; the column and the Map must agree
let bad = 0
for (let i = 0; i < N; i++) { const v = ++seq; src.write(keys[i], NPATH, -i, undefined, v); vmap.set(keys[i], v) }
for (let i = 0; i < N; i++) if (src.store.verOf(keys[i]) !== vmap.get(keys[i])) bad++
// and a write that changes nothing still moves the version (the row's version is its last write's)
const k0 = keys[0], v0 = ++seq; src.write(k0, NPATH, src.get(k0).n, undefined, v0)
const noop = src.store.verOf(k0) === v0

// memory: the Map's bytes a row (built three times, the median); the column's are exact
const mb = []
for (let t = 0; t < 3; t++) { gc(); const h0 = heap(); let m = new Map(); for (let i = 0; i < N; i++) m.set(keys[i], 2 ** 40 * 3 + i); const h1 = heap(); mb.push((h1 - h0) / N); globalThis.__keep = m; m = null; globalThis.__keep = null }
mb.sort((a, b) => a - b)
out({
  item: 4, bench: 'verstore', rows: N, shape: SHAPE, writes: SEG, rounds: ROUNDS, ns,
  derived: { map_over_base: diff('map', 'base'), slot_over_base: diff('slot', 'base'), slot_minus_map: diff('slot', 'map'), mapbig_over_base: diff('map big', 'base'), slotbig_over_base: diff('slot big', 'base'), base_minus_orig: diff('base', 'orig') },
  reads: reads.ns, reads_derived: { slot_minus_map: reads.diff('slot get', 'map get') },
  bytes: { map_per_row_big_versions: Math.round(mb[1] * 10) / 10, column_per_slot: 8, column_allocated_per_row: Math.round(src.store.vers.byteLength / N * 10) / 10 },
  check: { column_equals_map: bad === 0 ? 'ok' : 'MISMATCH ' + bad, noop_write_moves_version: noop },
  sink: sink >= 0,
})
