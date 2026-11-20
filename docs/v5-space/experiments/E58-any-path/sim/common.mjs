// E-58: shared helpers. A seeded random source, a deep equality that tells a hole from `undefined`, and a plain
// JavaScript model of a resource's state that is written WITHOUT data, so a fault in data or in a reader cannot hide in
// the model. The model's write rules copy data's clause 10 on purpose (a missing or scalar parent becomes a clean {};
// an equal value is a no-op; a remove that finds nothing is a no-op), with one difference: a field write on a row that
// is itself a string makes a clean {} here, where data spreads the string's characters (the "shape" runs count it).
export const MUT = process.env.E58_MUTATE ?? ''

// mulberry32: a small, fast, seeded generator
export function rng(seed) {
  let a = (seed * 2654435761) >>> 0
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  next.int = (n) => Math.floor(next() * n)
  next.pick = (xs) => xs[Math.floor(next() * xs.length)]
  next.chance = (p) => next() < p
  return next
}

// deep equality of JSON-like values. Arrays and objects compare their own keys, so a hole is not an `undefined`
// element and a named field on an array counts.
export function deepEq(a, b) {
  if (Object.is(a, b)) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && a.length !== b.length) return false
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (const k of ka) { if (!Object.hasOwn(b, k)) return false; if (!deepEq(a[k], b[k])) return false }
  return true
}

// a read along a path, as data's leafAt reads it (through strings too: 'abc'['1'] is 'b')
export function leafAt(v, path, from = 0) {
  let cur = v
  for (let i = from; i < path.length; i++) {
    if (cur === null || cur === undefined) return undefined
    cur = cur[path[i]]
  }
  return cur
}

export const isObj = (v) => v !== null && typeof v === 'object'
const shallow = (v) => (Array.isArray(v) ? v.slice() : { ...v })

// copy-on-write set along a path (data's pathCopy, clause 10c), the model's own code. A non-object at the top is a
// clean {} (data spreads a string there: see the header). An equal value (Object.is at the leaf) is a no-op.
export function setAt(v, path, value) {
  if (path.length === 0) return value
  if (Object.is(leafAt(v, path), value)) return v
  const root = isObj(v) ? shallow(v) : {}
  let src = v, dst = root
  for (let i = 0; i < path.length - 1; i++) {
    const p = path[i]
    const cur = isObj(src) ? src[p] : undefined
    const next = isObj(cur) ? shallow(cur) : {}
    dst[p] = next
    src = cur
    dst = next
  }
  dst[path[path.length - 1]] = value
  return root
}

// copy-on-write delete along a path (data's pathDelete, clause 10a-b). Returns the same value when nothing is there,
// and the string 'sparse-hole' for an array's own element (data throws; v5 refuses it 'sparse-hole').
export function delAt(v, path) {
  let probe = v
  for (let i = 0; i < path.length - 1; i++) { if (!isObj(probe)) return v; probe = probe[path[i]] }
  const last = path[path.length - 1]
  if (!isObj(probe) || !Object.hasOwn(probe, last)) return v
  if (Array.isArray(probe)) return 'sparse-hole'
  if (probe[last] === undefined) return v
  const root = shallow(v)
  let src = v, dst = root
  for (let i = 0; i < path.length - 1; i++) { const n = shallow(src[path[i]]); dst[path[i]] = n; src = src[path[i]]; dst = n }
  delete dst[last]
  return root
}

export function clone(v) { return v === undefined ? undefined : structuredClone(v) }

// is a a prefix of b (a at or above b)?
export function isPrefix(a, b) {
  if (a.length > b.length) return false
  for (let i = 0; i < a.length; i++) if (String(a[i]) !== String(b[i])) return false
  return true
}
// where a record lands, seen from a lens: 'at' | 'below' | 'above' | 'beside'
export function where(lens, key) {
  if (isPrefix(lens, key)) return lens.length === key.length ? 'at' : 'below'
  if (isPrefix(key, lens)) return 'above'
  return 'beside'
}

// counters: a flat bag of named counts
export function bag() { return Object.create(null) }
export function inc(b, k, n = 1) { b[k] = (b[k] ?? 0) + n }
