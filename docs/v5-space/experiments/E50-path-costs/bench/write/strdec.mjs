// strdec.mjs — v4's Cursor.str decodes every string with TextDecoder over a subarray (kernel/codec.ts Cursor.str).
// Row field names and short values are mostly short ASCII. What does a short-ASCII fast path save per string?
//   td      : new subarray + TextDecoder.decode (v4)
//   ascii   : if every byte < 0x80 and n <= 32, String.fromCharCode over the bytes; else TextDecoder
//   intern  : ascii, plus a 1-entry-per-length cache for repeated field names (hit when the bytes match)
const td = new TextDecoder('utf-8', { ignoreBOM: true })
const enc = new TextEncoder()
const words = ['name', 'email', 'region', 'room', 'n', 'active', 'tags', 'user123', 'user123@example.org', 'eu-west', 'r23', 'a', 'b']
// a buffer holding the strings back to back, as a row record would
const parts = words.map((w) => enc.encode(w))
const buf = new Uint8Array(parts.reduce((s, p) => s + p.length, 0))
const spans = []
{ let at = 0; for (const p of parts) { buf.set(p, at); spans.push([at, p.length]); at += p.length } }
const decTd = (b, at, n) => td.decode(b.subarray(at, at + n))
const decAscii = (b, at, n) => {
  if (n > 32) return td.decode(b.subarray(at, at + n))
  for (let i = 0; i < n; i++) if (b[at + i] > 0x7f) return td.decode(b.subarray(at, at + n))
  if (n === 1) return String.fromCharCode(b[at])
  let s = ''
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[at + i])
  return s
}
const cache = new Map()
const decIntern = (b, at, n) => {
  if (n <= 12) {
    let h = n
    for (let i = 0; i < n; i++) h = (h * 31 + b[at + i]) | 0
    const hit = cache.get(h)
    if (hit !== undefined && hit.length === n) {
      let same = true
      for (let i = 0; i < n; i++) if (hit.charCodeAt(i) !== b[at + i]) { same = false; break }
      if (same) return hit
    }
    const s = decAscii(b, at, n)
    cache.set(h, s)
    return s
  }
  return decAscii(b, at, n)
}
for (const f of [decAscii, decIntern]) for (let k = 0; k < spans.length; k++) if (f(buf, ...spans[k]) !== words[k]) throw new Error('mismatch')
const median = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1]
const bench = (f) => {
  const reps = 200000
  const r = []
  let sink = 0
  for (let round = 0; round < 7; round++) {
    const t = performance.now()
    for (let i = 0; i < reps; i++) for (let k = 0; k < spans.length; k++) sink += f(buf, spans[k][0], spans[k][1]).length
    r.push((performance.now() - t) * 1e6 / reps / spans.length)
  }
  globalThis.__s = sink
  return +median(r).toFixed(1)
}
console.log(JSON.stringify({ bench: 'strdec', node: process.version, unit: 'ns per string', strings: spans.length, td: bench(decTd), ascii: bench(decAscii), intern: bench(decIntern) }))
