// E-55 shared helpers: E-05's small row, timing (median of rounds), GC, heap, output.
export const row = (i) => ({ name: 'user-' + i, email: 'u' + i + '.example.com', region: 'r' + (i % 16), room: i % 100, n: i, active: (i & 1) === 0, tags: ['a', 'b'] })
export const key = (i) => 'k' + i
export const seedRows = (n) => { const o = {}; for (let i = 0; i < n; i++) o[key(i)] = row(i); return o }
export const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc() } }
export const gcAsync = async () => { for (let i = 0; i < 4; i++) { globalThis.gc?.(); await new Promise((r) => setTimeout(r, 5)) } }
export const now = () => process.hrtime.bigint()
export const heap = () => process.memoryUsage().heapUsed
export const out = (o) => console.log(JSON.stringify({ exp: 'E-55', node: process.version, ...o }))
export const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
export const q = (xs, f) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))] }
export const r1 = (x) => Math.round(x * 10) / 10
export const r3 = (x) => Math.round(x * 1000) / 1000
// a seeded generator (LCG, as E-54)
export const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff; return s } }
// ns per op: each way runs `m` ops per round; rounds interleave the ways (so drift hits all alike); median of rounds
export function interleave(ways, m, rounds = 5) {
  const xs = Object.fromEntries(Object.keys(ways).map((k) => [k, []]))
  for (let r = 0; r < rounds; r++) {
    for (const [k, fn] of Object.entries(ways)) { gc(); const t0 = now(); fn(m, r); xs[k].push(Number(now() - t0) / m) }
  }
  return Object.fromEntries(Object.entries(xs).map(([k, v]) => [k, r1(med(v))]))
}
