// E-62 item 5: what an `equals` guard costs the leader, and its size on the wire, beside a version guard on E-56's
// version store (V5-15's consequences; LAYERS 11, "Owed for V5-15" item 1; ANYPATH T11 for objects).
//   node --expose-gc --experimental-strip-types equals.mjs
// A field write with `if: { equals: old }` carries the old value; the leader reads the field's value now and compares.
// For each kind of value, the leader's work per guarded write, interleaved, the median of the rounds:
//   read      the field's value read from data's store (src.get(row) then the field): every guard pays it
//   deep      + a deep compare with the value the request carried (a decoded copy: equal, but other objects)
//   json      + JSON.stringify(value now) === the request's text (one string compare; key order must agree)
//   xxh64     + E-05's xxHash32 under two seeds over the value now's JSON bytes, against an 8-byte hash in the request
//   crc32     + Node's native zlib.crc32 over the JSON text, against 4 bytes (too short to trust: shown for its speed)
//   sha256    + crypto.hash('sha256', JSON text), against 32 bytes
//   version   a version guard instead: the row's version from the store (a Map, as E-56's `ver`) against the
//             request's version, parsed from its text once (`if: { version }`; it refuses for a sibling field's write)
//   decode    what the leader pays first to turn the request's bytes into the old value (JSON.parse), apart
// Kinds: a number, a 16-character string, E-05's small row as a field value (about 110 B of JSON), the same padded to
// about 1 KB, and a list of 100 small rows (about 11 KB). Each with the request's value equal (the guard passes: the
// whole compare runs) and differing in its last field (refused late).
// Checks: every way agrees with the deep compare on the equal and the differing cases; and on a value equal but with its
// keys in another order, deep passes while json and the hashes refuse (a false refusal).
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { xxh32 } from '../../E05-fold-cost/bench/xxh.mjs'
import { row, key, out, interleave, vtext } from './common.mjs'

const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../data', import.meta.url))
const { Runtime } = await import(pathToFileURL(DATA + '/kernel/runtime.ts').href)
const { SourceNode } = await import(pathToFileURL(DATA + '/kernel/node.ts').href)
const OPSX = +(process.env.OPSX ?? 1), ROUNDS = +(process.env.ROUNDS ?? 9)
const OPSK = { number: 100000, string16: 100000, row: 100000, obj1k: 20000, list100: 2000 } // fewer for big values
const R = 1000 // rows in the store; each guarded write names one, in turn

// a deep compare on JSON values: objects by key set (order free), arrays in order, primitives by ===
function deepEq(a, b) {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  const aa = Array.isArray(a)
  if (aa !== Array.isArray(b)) return false
  if (aa) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!deepEq(a[i], b[i])) return false; return true }
  const ka = Object.keys(a)
  if (ka.length !== Object.keys(b).length) return false
  for (let i = 0; i < ka.length; i++) { const k = ka[i]; if (!Object.hasOwn(b, k) || !deepEq(a[k], b[k])) return false }
  return true
}
const te = new TextEncoder(), SCR = new Uint8Array(1 << 16)
const xx64 = (s) => { const w = te.encodeInto(s, SCR).written; return [xxh32(SCR, 0, w, 1) >>> 0, xxh32(SCR, 0, w, 2) >>> 0] }

const PAD = 'x'.repeat(900)
const KINDS = {
  number: (i, last) => 1000 + i + last,
  string16: (i, last) => ('s' + i).padEnd(15, '-') + (last ? 'b' : 'a'),
  row: (i, last) => ({ ...row(i), active: last ? !((i & 1) === 0) : (i & 1) === 0 }),
  obj1k: (i, last) => ({ ...row(i), pad: PAD + (last ? 'y' : 'x') }),
  list100: (i, last) => ({ items: Array.from({ length: 100 }, (_, j) => (j === 99 && last ? { ...row(j), n: -1 } : row(j))) }),
}
const results = {}
let sink = 0
const checks = {}
for (const [kind, make] of Object.entries(KINDS)) {
  const OPS = Math.max(200, Math.round(OPSK[kind] * OPSX))
  // the store: R rows, each with field v holding a value of this kind; the requests carry the old value as JSON
  // the leader's values came off the wire: decoded from JSON, as a fold makes them
  const seed = {}; for (let i = 0; i < R; i++) seed[key(i)] = JSON.parse(JSON.stringify({ v: make(i, 0), w: 0 }))
  const src = new SourceNode(new Runtime(), seed); src.store.promote()
  const vmap = new Map(); for (let i = 0; i < R; i++) vmap.set(key(i), 2 ** 40 * 3 + i)
  const keys = Array.from({ length: R }, (_, i) => key(i))
  const reqEq = [], reqNe = []
  for (let i = 0; i < R; i++) {
    for (const [arr, last] of [[reqEq, 0], [reqNe, 1]]) {
      const text = JSON.stringify(make(i, last))
      arr.push({ text, value: JSON.parse(text), xx: xx64(text), crc: zlib.crc32(text), sha: crypto.hash('sha256', text, 'buffer'), vtext: vtext(3, i + (last ? 1 : 0)) })
    }
  }
  // the request's version text parsed to its number once, as the leader parses a request
  const vnum = (t) => { let n = 0; for (let j = 1; j < t.length; j++) n = n * 32 + '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.indexOf(t[j]); return n }
  for (const r of [...reqEq, ...reqNe]) r.vnum = vnum(r.vtext)
  const cur = (i) => src.get(keys[i]).v
  const mk = (reqs, test) => () => { let ok = 0; for (let j = 0; j < OPS; j++) { const i = j % R; if (test(i, reqs[i])) ok++ } sink = (sink + ok) & 1023; return OPS }
  const ways = (reqs) => ({
    read: mk(reqs, (i) => cur(i) !== undefined),
    deep: mk(reqs, (i, q) => deepEq(cur(i), q.value)),
    json: mk(reqs, (i, q) => JSON.stringify(cur(i)) === q.text),
    xxh64: mk(reqs, (i, q) => { const h = xx64(JSON.stringify(cur(i))); return h[0] === q.xx[0] && h[1] === q.xx[1] }),
    crc32: mk(reqs, (i, q) => zlib.crc32(JSON.stringify(cur(i))) === q.crc),
    sha256: mk(reqs, (i, q) => crypto.hash('sha256', JSON.stringify(cur(i)), 'buffer').equals(q.sha)),
    version: mk(reqs, (i, q) => vmap.get(keys[i]) === q.vnum),
    decode: mk(reqs, (i, q) => JSON.parse(q.text) !== undefined),
  })
  const wEq = ways(reqEq), wNe = ways(reqNe)
  const eq = interleave(wEq, { rounds: ROUNDS, ops: OPS })
  const ne = interleave(wNe, { rounds: ROUNDS, ops: OPS })
  const over = (r) => Object.fromEntries(['deep', 'json', 'xxh64', 'crc32', 'sha256', 'version'].map((k) => [k, r.diff(k, 'read')]))
  // agreement: each way's answer against deep, on equal, differing and reordered requests
  const agree = { equal: {}, differs: {} }
  for (const [nm, reqs, want] of [['equal', reqEq, true], ['differs', reqNe, false]]) {
    for (const w of ['deep', 'json', 'xxh64', 'crc32', 'sha256']) {
      let bad = 0
      for (let i = 0; i < R; i++) {
        const q = reqs[i], c = cur(i), s = JSON.stringify(c)
        const got = w === 'deep' ? deepEq(c, q.value) : w === 'json' ? s === q.text : w === 'xxh64' ? (xx64(s)[0] === q.xx[0] && xx64(s)[1] === q.xx[1]) : w === 'crc32' ? zlib.crc32(s) === q.crc : crypto.hash('sha256', s, 'buffer').equals(q.sha)
        if (got !== want) bad++
      }
      agree[nm][w] = bad
    }
  }
  let reorder = null
  if (typeof make(0, 0) === 'object') {
    // the same value with its keys in reverse order (a leader whose row was built by merges, or another writer)
    const rev = (o) => (Array.isArray(o) ? o.map(rev) : o !== null && typeof o === 'object' ? Object.fromEntries(Object.keys(o).reverse().map((k) => [k, rev(o[k])])) : o)
    let deepPass = 0, jsonPass = 0, hashPass = 0
    for (let i = 0; i < R; i++) { const c = cur(i), t = JSON.stringify(rev(c)); if (deepEq(c, JSON.parse(t))) deepPass++; if (JSON.stringify(c) === t) jsonPass++; const h = xx64(t), g = xx64(JSON.stringify(c)); if (h[0] === g[0] && h[1] === g[1]) hashPass++ }
    reorder = { rows: R, deep_passes: deepPass, json_passes: jsonPass, hash_passes: hashPass }
  }
  const sample = reqEq[R >> 1]
  results[kind] = {
    ops: OPS,
    equal: { ns: eq.ns, over_read: over(eq), decode: eq.diff('decode', 'read') },
    differs: { ns: ne.ns, over_read: over(ne) },
    wire_bytes: { equals_value: Buffer.byteLength(sample.text), xxh64: 8, crc32: 4, sha256: 32, version_text: sample.vtext.length },
    agree, reorder,
  }
  checks[kind] = agree
}
out({ item: 5, bench: 'equals', rows: R, rounds: ROUNDS, results, sink: sink >= 0 })
