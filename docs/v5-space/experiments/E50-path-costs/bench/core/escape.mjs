// B9: the price of PA-1's tagged escape. JSON.stringify changes or drops some values without a sound: NaN and
// ±Infinity become null, -0 becomes 0, undefined drops out of an object (null in an array), a BigInt throws, and a
// Uint8Array becomes an object of numbered keys. A record format that carries the value as JSON text must find
// those values before it trusts JSON.stringify, and turn them back on decode. Two ways are timed per record:
//   walk   a walk of the value first (numbers, undefined, bigint, byte arrays, and any object key equal to the tag);
//          only a value that needs it goes through JSON.stringify with a replacer and gets a 'has escapes' flag, so
//          the decoder runs a reviver only on flagged records (the flag is a bit in the record header: not timed)
//   always JSON.stringify with a replacer and JSON.parse with a reviver on every record (no flag, no walk)
// against plain JSON.stringify / JSON.parse (unsafe: the floor). Shapes: a field record's number, E-05's small row
// (as E-34 makes it) and E-34's 2 KB row. A self-check round-trips one value holding every escaped class.
// Usage: node escape.mjs     prints one JSON line (ns per record, median of 7 rounds)
import { isDeepStrictEqual } from 'node:util'

const TAG = '$f'
const needs = (v) => {
  switch (typeof v) {
    case 'number': return !Number.isFinite(v) || Object.is(v, -0)
    case 'string': case 'boolean': return false
    case 'object':
      if (v === null) return false
      if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) if (needs(v[i])) return true; return false }
      if (ArrayBuffer.isView(v)) return true
      for (const k in v) if (k === TAG || needs(v[k])) return true
      return false
    default: return true // undefined, bigint, function, symbol
  }
}
const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64')
function replacer(k, v) {
  if (typeof v === 'number') return Number.isNaN(v) ? { [TAG]: 'nan' } : v === Infinity ? { [TAG]: 'inf' } : v === -Infinity ? { [TAG]: '-inf' } : Object.is(v, -0) ? { [TAG]: '-0' } : v
  if (v === undefined) return { [TAG]: 'u' }
  if (typeof v === 'bigint') return { [TAG]: 'n', v: v.toString() }
  if (v instanceof Uint8Array) return { [TAG]: 'b', v: b64(v) }
  // a user object with a key equal to the tag goes as its entries, so the decoder never mistakes it for an escape
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, TAG)) return { [TAG]: 'o', v: Object.entries(v) }
  return v
}
const UNDEF = Symbol('undef')
function reviver(k, v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, TAG)) {
    switch (v[TAG]) {
      case 'nan': return NaN
      case 'inf': return Infinity
      case '-inf': return -Infinity
      case '-0': return -0
      case 'u': return UNDEF
      case 'n': return BigInt(v.v)
      case 'b': return new Uint8Array(Buffer.from(v.v, 'base64'))
      case 'o': return Object.fromEntries(v.v)
    }
  }
  return v
}
// a reviver cannot return undefined to keep a key (it deletes it), so 'u' comes back as a marker and is swapped once
const fixUndef = (v) => {
  if (v === UNDEF) return undefined
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) for (const k of Object.keys(v)) { if (v[k] === UNDEF) v[k] = undefined; else fixUndef(v[k]) }
  return v
}
const encWalk = (v) => needs(v) ? [1, JSON.stringify(v, replacer)] : [0, JSON.stringify(v)]
const decFlag = (flag, s) => flag ? fixUndef(JSON.parse(s, reviver)) : JSON.parse(s)

const BODY = 'lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor '.repeat(25).slice(0, 1900)
const row = (i, big) => {
  const r = { name: 'user-' + i, email: 'u' + i + '@example.com', region: 'r' + (i % 16), room: i % 100, n: i, active: (i & 1) === 0, tags: ['a', 'b'] }
  if (big) r.body = BODY.slice(0, 1890) + String(i % 1e9).padStart(10, '0')
  return r
}
const N = 256
const shapes = {
  field: Array.from({ length: N }, (_, i) => i * 7 + 0.5),
  small: Array.from({ length: N }, (_, i) => row(i, false)),
  big: Array.from({ length: N }, (_, i) => row(i, true)),
}
// self-check: every escaped class, nested, and a user key equal to the tag
const odd = { a: NaN, b: -0, c: Infinity, d: -Infinity, e: undefined, f: 12345678901234567890n, g: new Uint8Array([0, 1, 255]), h: [1, NaN, { i: -0 }], j: { [TAG]: 'nan', k: 1 }, s: 'plain' }
const [oflag, os] = encWalk(odd)
const back = decFlag(oflag, os)
const ok = oflag === 1 && isDeepStrictEqual(back, odd) && Object.is(back.b, -0) && Object.hasOwn(back, 'e') && back.f === odd.f
  && Object.values(shapes).every((vs) => vs.every((v) => { const [f, s] = encWalk(v); return f === 0 && isDeepStrictEqual(decFlag(f, s), v) }))

let sink = 0
const bench = (fn) => {
  let reps = 1
  for (;;) { const t = performance.now(); for (let i = 0; i < reps; i++) fn(); if (performance.now() - t > 30) break; reps *= 2 }
  reps = Math.max(1, Math.round(reps * 5))
  const rounds = []
  for (let r = 0; r < 7; r++) { const t = performance.now(); for (let i = 0; i < reps; i++) fn(); rounds.push((performance.now() - t) * 1e6 / reps / N) }
  rounds.sort((a, b) => a - b); return +rounds[3].toFixed(1)
}
const res = {}
for (const [name, vs] of Object.entries(shapes)) {
  const plainS = vs.map((v) => JSON.stringify(v)), repS = vs.map((v) => JSON.stringify(v, replacer))
  res[name] = {
    stringify_ns: bench(() => { for (const v of vs) sink += JSON.stringify(v).length }),
    walk_ns: bench(() => { for (const v of vs) sink += needs(v) ? 1 : 0 }),
    walk_stringify_ns: bench(() => { for (const v of vs) sink += encWalk(v)[1].length }),
    replacer_ns: bench(() => { for (const v of vs) sink += JSON.stringify(v, replacer).length }),
    parse_ns: bench(() => { for (const s of plainS) sink += JSON.parse(s) ? 1 : 0 }),
    reviver_ns: bench(() => { for (const s of repS) sink += fixUndef(JSON.parse(s, reviver)) ? 1 : 0 }),
    json_bytes: +(plainS.reduce((a, s) => a + s.length, 0) / N).toFixed(1),
  }
}
console.log(JSON.stringify({ bench: 'escape', ok, node: process.version, ...res }))
