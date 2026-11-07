// A small seeded chaos sim around kernel K (either twin behind one interface). Three or five
// nodes, one virtual clock in ticks, a network with delay, loss and cut links, crashes that keep
// only what the node persisted (its journal), client writes, and data's hot lane folding every
// applied entry on every node (user code and data's fold run in JS, as in fero's sim).
// Monitors: every node applies the same entry at the same index; nodes at the same applied
// index fold to the same data value. The driver treats the kernel as bytes in, bytes out, so
// the TS and the WASM twin get byte-identical inputs as long as their effects agree.
import { W, R, EV, OP, EFF } from '../k-ts/k.ts'

export interface Kernel {
  name: string
  create(id: number, n: number, journal: Uint8Array): number
  step(h: number, ev: Uint8Array): Uint8Array
  dump(h: number): Uint8Array
  destroy(h: number): void
  reset?(): void
}
export interface Opts { ticks?: number; fold?: any; hash?: boolean; record?: Recorder | null; trace?: number[] }
export interface Result { events: number; applies: number; leaderChanges: number; crashes: number; hash: number; dumps: Uint8Array[]; violations: string[]; firstDiffAt?: number }
/** a trace of kernel calls, for the replay benches (one per run) */
export interface Recorder { create(id: number, n: number, j: Uint8Array): void; step(slot: number, ev: Uint8Array): void; destroy(slot: number): void }

export const mulberry32 = (a: number) => () => {
  a = (a + 0x6d2b79f5) | 0
  let t = Math.imul(a ^ (a >>> 15), 1 | a)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// keys a real app sends: ASCII, accented, a fullwidth letter (U+FF5A, above the surrogate range in
// UTF-16) and an emoji (an astral code point, a surrogate pair in UTF-16), and a lone surrogate
const KEYS = ['a', 'b', 'c', 'user:1', 'user:2', 'café', 'ｚ', '😀', 'naïve', 'x\uD800y']
const EMPTY = new Uint8Array(0)

const fnv = (h: number, b: Uint8Array): number => {
  for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 16777619)
  return h >>> 0
}

export function runSeed(K: Kernel, seed: number, o: Opts = {}): Result {
  K.reset?.()
  const rnd = mulberry32(seed)
  const n = rnd() < 0.8 ? 3 : 5
  const T = o.ticks ?? 100
  const D = o.fold
  const h: number[] = [0], alive: boolean[] = [false], journal: Uint8Array[][] = [[]], downUntil: number[] = [0], cutUntil: number[] = [0]
  const lanes: any[] = [null], srcs: any[] = [null], applied: number[] = [0]
  const rec = o.record ?? null
  const slot: number[] = [0] // recorder slot per node
  let nextSlot = 0
  const mk = (id: number, j: Uint8Array) => {
    h[id] = K.create(id, n, j); alive[id] = true; applied[id] = 0
    if (rec) { rec.create(id, n, j); slot[id] = nextSlot++ }
    if (D) { srcs[id] = D.$({}); lanes[id] = D.lane(srcs[id], { onReject: (r: any) => { throw r.error } }) }
  }
  for (let id = 1; id <= n; id++) { journal[id] = []; downUntil[id] = 0; cutUntil[id] = 0; mk(id, EMPTY) }
  const buckets: { to: number; from: number; m: Uint8Array }[][] = Array.from({ length: T + 8 }, () => [])
  const applyAt = new Map<number, number>()
  const violations: string[] = []
  let hash = 0x811c9dc5, events = 0, applies = 0, leaderChanges = 0, crashes = 0, t = 0
  const reqBase = rnd() < 0.1 ? 2 ** 32 : 0
  let req = 0
  const w = new W()
  const recs: any[] = []

  const step = (id: number, ev: Uint8Array) => {
    events++
    if (rec) rec.step(slot[id], ev)
    const eff = K.step(h[id], ev)
    if (o.hash) { hash = Math.imul(hash ^ id, 16777619) >>> 0; hash = fnv(hash, eff) }
    if (o.trace) o.trace.push(fnv(fnv(0x811c9dc5, ev), eff) ^ id)
    const r = new R(eff)
    while (r.more()) {
      const tag = r.u8()
      if (tag === EFF.SEND) {
        const to = r.varint(), len = r.varint()
        const m = eff.slice(r.pos, r.pos + len); r.pos += len
        if (rnd() < 0.05) continue
        buckets[Math.min(t + 1 + Math.floor(rnd() * 3), T + 7)].push({ to, from: id, m })
      } else if (tag === EFF.PERSIST) {
        const len = r.varint(); journal[id].push(eff.slice(r.pos, r.pos + len)); r.pos += len
      } else if (tag === EFF.APPLY) {
        const at = r.pos
        const idx = r.varint(), op = r.u8(), key = r.str()
        let v = 0, existed = 0
        if (op === OP.SET || op === OP.INCR) v = r.f64(); else if (op === OP.DEL) existed = r.u8()
        const sig = fnv(0x811c9dc5, eff.subarray(at, r.pos))
        const prev = applyAt.get(idx)
        if (prev === undefined) applyAt.set(idx, sig); else if (prev !== sig) violations.push(`seed ${seed}: node ${id} applied a different entry at ${idx}`)
        applied[id] = idx; applies++
        if (D) {
          if (op === OP.SET || op === OP.INCR) recs.push({ type: 0, key: [key], value: v })
          else if (op === OP.DEL && existed) recs.push({ type: 2, key: [key] })
        }
      } else if (tag === EFF.REPLY) {
        r.varint(); const st = r.u8(); r.varint(); void st
      } else if (tag === EFF.ROLE) {
        const role = r.u8(); r.varint(); r.varint()
        if (role === 2) leaderChanges++
      } else throw new Error('effect tag ' + tag)
    }
    if (D && recs.length) { lanes[id](recs); recs.length = 0 }
  }
  const crash = (id: number, until: number) => {
    alive[id] = false; downUntil[id] = until; crashes++
    K.destroy(h[id]); if (rec) rec.destroy(slot[id])
  }
  const restart = (id: number) => {
    const parts = journal[id]
    let len = 0; for (const p of parts) len += p.length
    const j = new Uint8Array(len); let off = 0; for (const p of parts) { j.set(p, off); off += p.length }
    journal[id] = [j]
    mk(id, j)
  }
  const tick = new Uint8Array([EV.TICK])
  for (t = 0; t < T; t++) {
    if (rnd() < 0.02) { const id = 1 + Math.floor(rnd() * n); if (alive[id]) crash(id, t + 3 + Math.floor(rnd() * 10)) }
    if (rnd() < 0.02) { const id = 1 + Math.floor(rnd() * n); cutUntil[id] = t + 5 + Math.floor(rnd() * 10) }
    for (let id = 1; id <= n; id++) if (!alive[id] && downUntil[id] === t) restart(id)
    const due = buckets[t]
    for (let i = 0; i < due.length; i++) {
      const { to, from, m } = due[i]
      if (!alive[to] || cutUntil[to] > t || cutUntil[from] > t) continue
      w.reset(); w.u8(EV.RECV); w.varint(from); w.bytes(m)
      step(to, w.buf.subarray(0, w.len))
    }
    if (rnd() < 0.6) {
      const id = 1 + Math.floor(rnd() * n)
      const x = rnd(), op = x < 0.6 ? OP.SET : x < 0.9 ? OP.INCR : OP.DEL
      const key = KEYS[Math.floor(rnd() * KEYS.length)]
      const y = rnd()
      const v = y < 0.7 ? Math.floor(rnd() * 100) : y < 0.8 ? Math.floor(rnd() * 64) / 8 : y < 0.9 ? 2 ** 32 + Math.floor(rnd() * 100) : 2 ** 53 + 2 * Math.floor(rnd() * 100)
      if (alive[id]) {
        w.reset(); w.u8(EV.PROPOSE); w.varint(reqBase + ++req); w.u8(op); w.str(key); if (op !== OP.DEL) w.f64(v)
        step(id, w.buf.subarray(0, w.len))
      }
    }
    for (let id = 1; id <= n; id++) if (alive[id]) step(id, tick)
  }
  const dumps: Uint8Array[] = []
  for (let id = 1; id <= n; id++) if (alive[id]) { const d = K.dump(h[id]); dumps.push(d); if (o.hash) hash = fnv(hash, d) }
  if (D) {
    const byApplied = new Map<number, string>()
    for (let id = 1; id <= n; id++) if (alive[id]) {
      const s = JSON.stringify(srcs[id][D.value])
      const p = byApplied.get(applied[id])
      if (p === undefined) byApplied.set(applied[id], s); else if (p !== s) violations.push(`seed ${seed}: fold differs at applied ${applied[id]}`)
    }
  }
  for (let id = 1; id <= n; id++) if (alive[id]) K.destroy(h[id])
  return { events, applies, leaderChanges, crashes, hash, dumps, violations }
}
