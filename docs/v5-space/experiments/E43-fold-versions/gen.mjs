// E-43: write one seeded stream of change records, in fero's own record codec (frames of 256).
//   node gen.mjs <tree> <out dir> [records=1000000] [seed=43]
// Files: stream.log (u32 length + frame bytes, repeated), stream.kinds (one byte per record: the kind it was
// made as), stream.keys (u32 per record: the row key's number), stream.json (seed, counts, sha256).
// The generator uses integer arithmetic only (mulberry32 with Math.imul), so the same seed gives the same
// bytes on any Node version; run.sh checks that by sha256 on Node 22 and Node 26.
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import fs from 'node:fs'

const [TREE, OUT, Ns = '1000000', SEEDs = '43'] = process.argv.slice(2)
const N = Number(Ns), SEED = Number(SEEDs)
const C = await import(pathToFileURL(TREE + '/fero/kernel/codec.ts').href)

// ── a seeded integer generator ───────────────────────────────────────────────
let st = SEED >>> 0
const u32 = () => { st = (st + 0x6d2b79f5) >>> 0; let t = st; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return (t ^ (t >>> 14)) >>> 0 }
const int = (n) => u32() % n
const pick = (a) => a[int(a.length)]

// ── row keys: 20,000 plain ones and a few odd ones (integer-like, unicode, NUL, object-method names) ─────────
const NK = 20000
const ODD = ['0', '7', '42', '007', '-1', '1.5', '4294967295', 'é', '日本', '😀', 'a\u0000b', ' ', 'constructor', 'toString', 'hasOwnProperty', 'length', 'valueOf']
const keyName = (i) => (i < NK ? 'k' + i : ODD[i - NK])
const NKEYS = NK + ODD.length
const FIELDS = ['a', 'b', 'c', 'n', 's', 'tags', 'meta', '0', '1', '2', '10', 'x.y', 'é']
const DOUBLES = [0.1, 0.30000000000000004, 1e21, 1e-7, 5e-324, 1.7976931348623157e308, 9007199254740993, -0, NaN, Infinity, -Infinity, 2 ** 31, 2 ** 53 - 1]
const STRINGS = ['', 'str', 'hello world', '42', '0', 'é', '日本語', '😀 ok', 'é', 'a\u0000b', 'true', 'null']

// ── values, inside the codec's domain: null, undefined, booleans, numbers, strings, bytes, arrays, objects ───
const scalar = () => {
  const r = int(100)
  if (r < 30) return int(1000)
  if (r < 40) return (int(4001) - 2000) / 8 // a dyadic fraction: exact in every engine
  if (r < 50) return pick(DOUBLES)
  if (r < 75) return pick(STRINGS)
  if (r < 80) return null
  if (r < 85) return undefined
  if (r < 93) return int(2) === 0
  if (r < 96) { const b = new Uint8Array(int(6)); for (let i = 0; i < b.length; i++) b[i] = int(256); return b }
  return 'u' + int(100000)
}
const arr = (d) => { const n = int(5); const a = new Array(n); for (let i = 0; i < n; i++) a[i] = d > 0 && int(4) === 0 ? val(d - 1) : scalar(); return a }
const obj = (d) => { const n = int(5); const o = {}; for (let i = 0; i < n; i++) o[pick(FIELDS)] = d > 0 && int(3) === 0 ? val(d - 1) : scalar(); return o }
const val = (d) => { const r = int(10); return r < 5 ? obj(d) : r < 7 ? arr(d) : scalar() }
// a row as an app would write it: an object with a few fields, often a tags array and a nested meta
const row = () => {
  const o = { n: int(1000), s: pick(STRINGS) }
  if (int(2) === 0) o.tags = arr(1)
  if (int(2) === 0) o.meta = obj(2)
  if (int(3) === 0) o[pick(FIELDS)] = val(2)
  if (int(8) === 0) o.a = null
  if (int(8) === 0) o.b = undefined
  return o
}

// ── what the generator remembers about each key: is it live, and the last whole row it wrote (a hint only) ───
const live = new Uint8Array(NKEYS)
const hint = new Array(NKEYS)
const liveList = [] // keys ever made live (may hold dead ones; picks re-check)
const anyKey = () => (int(50) === 0 ? NK + int(ODD.length) : int(NK))
const liveKey = () => { for (let t = 0; t < 8 && liveList.length; t++) { const k = pick(liveList); if (live[k]) return k } return anyKey() }
const deadKey = () => { for (let t = 0; t < 8; t++) { const k = anyKey(); if (!live[k]) return k } return anyKey() }
// a live key whose last whole row has a field of the wanted sort, and that field's name
const aimed = (want) => {
  for (let t = 0; t < 24 && liveList.length; t++) {
    const k = pick(liveList); const h = hint[k]
    if (!live[k] || h === null || typeof h !== 'object' || Array.isArray(h) || h instanceof Uint8Array) continue
    for (const f of Object.keys(h)) if (want(h[f])) return [k, f, h[f]]
  }
  return null
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)

const KINDS = [
  'insert-at', 'insert-keyed', 'row-set', 'row-set-scalar', 'field-set', 'deep-set-object', 'deep-set-missing',
  'deep-set-under-null', 'deep-set-under-number', 'deep-set-under-string', 'deep-set-under-array-index',
  'deep-set-under-array-name', 'array-index-out-of-range', 'row-remove-live', 'row-remove-dead', 'field-remove',
  'field-remove-absent', 'deep-remove', 'deep-remove-absent-ancestor', 'array-element-remove', 'array-element-remove-undefined',
  'array-element-remove-out-of-range', 'deep-set-dead-row', 'same-again', 'undefined-over-absent', 'remove-undefined-leaf',
  'bad-type', 'bad-empty-key-update', 'bad-nested-insert', 'bad-insert-no-key', 'bad-empty-key-remove', 'deep-set-into-scalar-row',
]
const KI = Object.fromEntries(KINDS.map((k, i) => [k, i]))
const WEIGHTS = { 'insert-at': 120, 'insert-keyed': 30, 'row-set': 120, 'row-set-scalar': 10, 'field-set': 220, 'deep-set-object': 80, 'deep-set-missing': 40,
  'deep-set-under-null': 15, 'deep-set-under-number': 15, 'deep-set-under-string': 15, 'deep-set-under-array-index': 25, 'deep-set-under-array-name': 8,
  'array-index-out-of-range': 8, 'row-remove-live': 70, 'row-remove-dead': 15, 'field-remove': 50, 'field-remove-absent': 15, 'deep-remove': 25,
  'deep-remove-absent-ancestor': 10, 'array-element-remove': 10, 'array-element-remove-undefined': 5, 'array-element-remove-out-of-range': 5,
  'deep-set-dead-row': 15, 'same-again': 40, 'undefined-over-absent': 10, 'remove-undefined-leaf': 8, 'bad-type': 2, 'bad-empty-key-update': 2,
  'bad-nested-insert': 2, 'bad-insert-no-key': 2, 'bad-empty-key-remove': 2, 'deep-set-into-scalar-row': 6 }
const WTAB = []; for (const k of KINDS) for (let i = 0; i < WEIGHTS[k]; i++) WTAB.push(KI[k])

const U = 0, I = 1, R = 2
let last = null // the last record, for 'same-again'
const make = () => {
  const kind = WTAB[int(WTAB.length)]
  const name = KINDS[kind]
  let k, r
  const setRow = (key, v) => { if (!live[key]) { live[key] = 1; liveList.push(key) } hint[key] = v }
  switch (name) {
    case 'insert-at': k = int(3) === 0 ? liveKey() : anyKey(); r = { type: I, key: [], value: row(), at: keyName(k) }; setRow(k, r.value); break
    case 'insert-keyed': k = anyKey(); r = { type: I, key: [keyName(k)], value: row() }; setRow(k, r.value); break
    case 'row-set': k = int(4) === 0 ? anyKey() : liveKey(); r = { type: U, key: [keyName(k)], value: row() }; setRow(k, r.value); break
    case 'row-set-scalar': k = anyKey(); r = { type: U, key: [keyName(k)], value: int(3) === 0 ? arr(1) : scalar() }; setRow(k, r.value); break
    case 'field-set': k = liveKey(); r = { type: U, key: [keyName(k), pick(FIELDS)], value: int(4) === 0 ? val(1) : scalar() }; break
    case 'deep-set-object': { const a = aimed(isObj); k = a ? a[0] : liveKey(); r = { type: U, key: [keyName(k), a ? a[1] : 'meta', pick(FIELDS)], value: val(1) }; if (int(3) === 0) r.key.push(pick(FIELDS)); break }
    case 'deep-set-missing': k = liveKey(); r = { type: U, key: [keyName(k), 'm' + int(4), pick(FIELDS)], value: scalar() }; if (int(3) === 0) r.key.push(pick(FIELDS)); break
    case 'deep-set-under-null': { const a = aimed((v) => v === null || v === undefined); k = a ? a[0] : liveKey(); r = { type: U, key: [keyName(k), a ? a[1] : 'a', pick(FIELDS)], value: scalar() }; break }
    case 'deep-set-under-number': { const a = aimed((v) => typeof v === 'number' || typeof v === 'boolean'); k = a ? a[0] : liveKey(); r = { type: U, key: [keyName(k), a ? a[1] : 'n', pick(FIELDS)], value: scalar() }; break }
    case 'deep-set-under-string': { const a = aimed((v) => typeof v === 'string' && v.length > 0); k = a ? a[0] : liveKey(); r = { type: U, key: [keyName(k), a ? a[1] : 's', pick(FIELDS)], value: scalar() }; break }
    case 'deep-set-under-array-index': { const a = aimed((v) => Array.isArray(v) && v.length > 0); k = a ? a[0] : liveKey(); r = { type: U, key: [keyName(k), a ? a[1] : 'tags', String(a ? int(a[2].length) : 0)], value: val(1) }; if (int(4) === 0) r.key.push(pick(FIELDS)); break }
    // (a write to an array's `length` is kept small here: one record that sets it to 2^31 makes every later write
    // under that array take minutes, see bigarray.mjs; that case is probed apart so the 1e6 run stays a fold test)
    case 'deep-set-under-array-name': { const a = aimed(Array.isArray); k = a ? a[0] : liveKey(); const nm = pick(['a', 'length', 'x.y', '-1', '1.5']); r = { type: U, key: [keyName(k), a ? a[1] : 'tags', nm], value: nm === 'length' ? pick([int(64), int(8), 'str', -1, 1.5, null]) : scalar() }; break }
    case 'array-index-out-of-range': { const a = aimed(Array.isArray); k = a ? a[0] : liveKey(); r = { type: U, key: [keyName(k), a ? a[1] : 'tags', String((a ? a[2].length : 0) + int(4))], value: scalar() }; break }
    case 'row-remove-live': k = liveKey(); r = { type: R, key: [keyName(k)] }; live[k] = 0; hint[k] = undefined; break
    case 'row-remove-dead': k = deadKey(); r = { type: R, key: [keyName(k)] }; live[k] = 0; hint[k] = undefined; break
    case 'field-remove': { const a = aimed(() => true); k = a ? a[0] : liveKey(); r = { type: R, key: [keyName(k), a ? a[1] : 'n'] }; break }
    case 'field-remove-absent': k = liveKey(); r = { type: R, key: [keyName(k), 'nope' + int(3)] }; break
    case 'deep-remove': { const a = aimed(isObj); k = a ? a[0] : liveKey(); r = { type: R, key: [keyName(k), a ? a[1] : 'meta', a && Object.keys(a[2]).length ? pick(Object.keys(a[2])) : pick(FIELDS)] }; break }
    case 'deep-remove-absent-ancestor': k = int(2) === 0 ? liveKey() : deadKey(); r = { type: R, key: [keyName(k), 'nope' + int(3), pick(FIELDS), pick(FIELDS)] }; break
    case 'array-element-remove': { const a = aimed((v) => Array.isArray(v) && v.length > 0); k = a ? a[0] : liveKey(); r = { type: R, key: [keyName(k), a ? a[1] : 'tags', String(a ? int(a[2].length) : 0)] }; break }
    case 'array-element-remove-undefined': { const a = aimed((v) => Array.isArray(v) && v.includes(undefined)); k = a ? a[0] : liveKey(); r = { type: R, key: [keyName(k), a ? a[1] : 'tags', String(a ? a[2].indexOf(undefined) : 0)] }; break }
    case 'array-element-remove-out-of-range': { const a = aimed(Array.isArray); k = a ? a[0] : liveKey(); r = { type: R, key: [keyName(k), a ? a[1] : 'tags', String((a ? a[2].length : 0) + int(3))] }; break }
    case 'deep-set-dead-row': k = deadKey(); r = { type: U, key: [keyName(k), pick(FIELDS)], value: scalar() }; if (int(2) === 0) r.key.push(pick(FIELDS)); break
    case 'same-again': if (last !== null) { k = last.k; r = last.r; break } k = liveKey(); r = { type: U, key: [keyName(k), 'n'], value: 1 }; break
    case 'undefined-over-absent': k = liveKey(); r = { type: U, key: [keyName(k), 'nope' + int(3)], value: undefined }; if (int(2) === 0) r.key.push('deep'); break
    case 'remove-undefined-leaf': { const a = aimed((v) => v === undefined); k = a ? a[0] : liveKey(); r = { type: R, key: [keyName(k), a ? a[1] : 'b'] }; break }
    case 'bad-type': k = liveKey(); r = { type: 3, key: [keyName(k)], value: 1 }; break
    case 'bad-empty-key-update': k = 0; r = { type: U, key: [], value: { x: 1 } }; break
    case 'bad-nested-insert': k = liveKey(); r = { type: I, key: [keyName(k), 'tags'], value: 1 }; break
    case 'bad-insert-no-key': k = 0; r = { type: I, key: [], value: { x: 1 } }; break
    case 'bad-empty-key-remove': k = 0; r = { type: R, key: [] }; break
    case 'deep-set-into-scalar-row': { let found = -1; for (let t = 0; t < 24 && liveList.length; t++) { const c = pick(liveList); if (live[c] && !isObj(hint[c])) { found = c; break } } k = found >= 0 ? found : liveKey(); r = { type: U, key: [keyName(k), pick(FIELDS)], value: scalar() }; break }
    default: throw new Error(name)
  }
  last = { k, r }
  return [kind, k, r]
}

fs.mkdirSync(OUT, { recursive: true })
const kinds = new Uint8Array(N), keys = new Uint32Array(N)
const fd = fs.openSync(OUT + '/stream.log', 'w')
const sha = createHash('sha256')
const B = 256
const lenBuf = Buffer.alloc(4)
let frames = 0, bytes = 0
for (let i = 0; i < N; i += B) {
  const recs = []
  for (let j = i; j < Math.min(N, i + B); j++) { const [kind, k, r] = make(); kinds[j] = kind; keys[j] = k; recs.push(r) }
  const f = C.encodeFrame(recs)
  lenBuf.writeUInt32LE(f.length, 0)
  fs.writeSync(fd, lenBuf); fs.writeSync(fd, f)
  sha.update(lenBuf); sha.update(f)
  frames++; bytes += 4 + f.length
}
fs.closeSync(fd)
fs.writeFileSync(OUT + '/stream.kinds', kinds)
fs.writeFileSync(OUT + '/stream.keys', Buffer.from(keys.buffer))
const count = {}; for (let i = 0; i < N; i++) count[KINDS[kinds[i]]] = (count[KINDS[kinds[i]]] ?? 0) + 1
const meta = { node: process.version, seed: SEED, records: N, frames, bytes, sha256: sha.digest('hex'), kindsSha256: createHash('sha256').update(kinds).digest('hex'), nkeys: NKEYS, keyNames: { plain: NK, odd: ODD }, kinds: KINDS, count }
fs.writeFileSync(OUT + '/stream.json', JSON.stringify(meta, null, 1))
console.log(JSON.stringify({ node: meta.node, seed: SEED, records: N, frames, bytes, sha256: meta.sha256, kindsSha256: meta.kindsSha256 }))
