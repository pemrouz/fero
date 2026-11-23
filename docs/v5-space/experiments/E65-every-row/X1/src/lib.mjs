// E-65 X1: shared helpers. Nothing here imports data; data is loaded by loadData() from DATA (default: the
// sibling ../data next to this repo, read only). fero v4's codec is loaded by loadCodec() from FERO (default:
// this repo's root).
//   rng, hash32, slotOf   a seeded source; the slot of a row key (4,096 slots, as LAYERS "Words")
//   rowOf, makeGen        E-64 O2/O4's row and write mix, so the options compare: rows of eight fields (about
//                         100 B as JSON), and a stream of field writes, whole-row writes, inserts and deletes
//   out, loadavg, gc      one JSON line per run; the load average; a full collection
//   GcWatch               every GC pause (perf_hooks 'gc' entries) in a phase: longest, longest major, count
import { fileURLToPath, pathToFileURL } from 'node:url'
import { PerformanceObserver } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'

export const DATA = process.env.DATA ?? fileURLToPath(new URL('../../../../../../../data', import.meta.url))
export const FERO = process.env.FERO ?? fileURLToPath(new URL('../../../../../../', import.meta.url))
export const loadData = () => import(pathToFileURL(DATA + '/api/index.ts').href)
export const loadCodec = () => import(pathToFileURL(FERO + '/kernel/codec.ts').href)

export function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
export function hash32(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16
  return h >>> 0
}
export const SLOTS = 4096
export const slotOf = (key) => hash32(key) % SLOTS

// The row: eight fields, about 100 B as JSON (E-64 O2 and O4 used the same, so the numbers compare).
export const FIELDS = ['user', 'cents', 'score', 'paid', 'sku', 'title', 'at', 'qty']
export function rowOf(r, users = 1000) {
  return { user: 'u' + Math.floor(r() * users), cents: Math.floor(r() * 10000), score: Math.floor(r() * 1e6), paid: r() < 0.5, sku: 'sku-' + Math.floor(r() * 1e5), title: 'item ' + Math.floor(r() * 1e9).toString(36) + ' blue large', at: 1.7e12 + Math.floor(r() * 1e10), qty: 1 + Math.floor(r() * 5) }
}
// The write mix (E-64 O4's): 25 % whole rows, 30 % cents, 12 % user, 13 % score, 8 % paid, 3 % cents deleted,
// 9 % row removed; a write to a removed row inserts it again.
export function makeGen(N, seed = 1, users = 1000) {
  const r = rng(seed)
  const live = new Uint8Array(N).fill(1)
  return (H) => {
    const recs = new Array(H)
    for (let i = 0; i < H; i++) {
      const j = Math.floor(r() * N), k = 'k' + j
      if (!live[j]) { recs[i] = { type: 1, key: [], at: k, value: rowOf(r, users) }; live[j] = 1; continue }
      const u = r()
      if (u < 0.25) recs[i] = { type: 0, key: [k], value: rowOf(r, users) }
      else if (u < 0.55) recs[i] = { type: 0, key: [k, 'cents'], value: Math.floor(r() * 10000) }
      else if (u < 0.67) recs[i] = { type: 0, key: [k, 'user'], value: 'u' + Math.floor(r() * users) }
      else if (u < 0.8) recs[i] = { type: 0, key: [k, 'score'], value: Math.floor(r() * 1e6) }
      else if (u < 0.88) recs[i] = { type: 0, key: [k, 'paid'], value: r() < 0.5 }
      else if (u < 0.91) recs[i] = { type: 2, key: [k, 'cents'] }
      else { recs[i] = { type: 2, key: [k] }; live[j] = 0 }
    }
    return recs
  }
}
// the initial rows as insert records, in batches
export function* inserts(N, seed = 99, batch = 4096, users = 1000) {
  const r = rng(seed)
  for (let i = 0; i < N; i += batch) {
    const b = []
    for (let j = i; j < Math.min(N, i + batch); j++) b.push({ type: 1, key: [], at: 'k' + j, value: rowOf(r, users) })
    yield b
  }
}

export const out = (o) => console.log(JSON.stringify(o))
export const loadavg = () => { try { return readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).join(' ') } catch { return null } }
export const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc() } }
export const heapUsed = () => process.memoryUsage().heapUsed
export const now = () => process.hrtime.bigint()
export const nsSince = (t0) => Number(process.hrtime.bigint() - t0)
export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }

// GC pauses: perf_hooks 'gc' entries (the time JavaScript was stopped), split by phase
export class GcWatch {
  constructor() {
    this.phase = 'none'; this.by = {}
    this.obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const p = (this.by[this.phase] ??= { n: 0, max: 0, maxMajor: 0, total: 0 })
        p.n++; p.total += e.duration
        if (e.duration > p.max) p.max = e.duration
        const kind = e.detail?.kind ?? e.kind
        if (kind === 4 && e.duration > p.maxMajor) p.maxMajor = e.duration // 4 = major (mark-sweep-compact)
      }
    })
    this.obs.observe({ entryTypes: ['gc'] })
  }
  set(phase) { this.phase = phase }
  async flush() { await new Promise((r) => setTimeout(r, 50)) }
  report() { const o = {}; for (const [k, v] of Object.entries(this.by)) o[k] = { n: v.n, max_ms: +v.max.toFixed(1), max_major_ms: +v.maxMajor.toFixed(1), total_ms: +v.total.toFixed(0) }; this.obs.disconnect(); return o }
}
export function args() {
  const o = {}
  for (const a of process.argv.slice(2)) { const m = /^--([^=]+)=?(.*)$/.exec(a); if (m) o[m[1]] = m[2] === '' ? true : isNaN(+m[2]) ? m[2] : +m[2] }
  return o
}
