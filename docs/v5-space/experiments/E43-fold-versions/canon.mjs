// E-43: one canonical text for any value in the codec's domain, so two folds can be compared byte for byte.
// Numbers are written from their own bits (so -0, NaN and every double are told apart), strings by
// JSON.stringify (exact for every code unit), bytes as hex, arrays with their holes and any named fields,
// objects in their own key order ('own') or in sorted key order ('sorted').
const f64 = new Float64Array(1), u32v = new Uint32Array(f64.buffer)
const num = (x) => { if (x !== x) return 'nNaN'; f64[0] = x; return 'n' + u32v[1].toString(16) + '.' + u32v[0].toString(16) }
export const canon = (v, sorted = false) => {
  if (v === undefined) return 'U'
  if (v === null) return 'N'
  switch (typeof v) {
    case 'boolean': return v ? 'T' : 'F'
    case 'number': return num(v)
    case 'string': return JSON.stringify(v)
    case 'object': break
    default: return '?' + typeof v
  }
  if (v instanceof Uint8Array) { let s = 'b'; for (let i = 0; i < v.length; i++) s += (v[i] < 16 ? '0' : '') + v[i].toString(16); return s }
  if (Array.isArray(v)) {
    // by own keys, never by counting to length: one record can set an array's length to 2^31 (see the README)
    const ks = Object.keys(v), n = v.length
    let s = '[', next = 0, i = 0
    for (; i < ks.length; i++) {
      const k = ks[i], idx = k >>> 0
      if (String(idx) !== k || idx >= n) break // the named fields follow the index keys
      if (idx > next) s += (next ? ',' : '') + 'H*' + (idx - next) // a run of holes
      s += (idx ? ',' : '') + canon(v[k], sorted); next = idx + 1
    }
    if (n > next) s += (next ? ',' : '') + 'H*' + (n - next)
    s += ']'
    if (i < ks.length) { const extra = ks.slice(i); if (sorted) extra.sort(); s += '+{'; for (const k of extra) s += JSON.stringify(k) + ':' + canon(v[k], sorted) + ','; s += '}' }
    return s
  }
  const ks = Object.keys(v); if (sorted) ks.sort()
  let s = '{'
  for (let i = 0; i < ks.length; i++) s += (i ? ',' : '') + JSON.stringify(ks[i]) + ':' + canon(v[ks[i]], sorted)
  return s + '}'
}
// FNV-1a over a string's code units, 32 bits (per-record digests; the snapshots use SHA-256)
export const fnv = (s, h = 0x811c9dc5) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) } return h >>> 0 }
