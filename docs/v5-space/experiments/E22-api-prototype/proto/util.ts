// util — small shared helpers: durations, sizes, hashing, the seeded PRNG, versions, a heap,
// deep equality and the value check that stands in for the wire (DATA-03, 'unencodable').

export type Duration = number | string
export type Size = number | string

const UNIT_MS: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }
const UNIT_B: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }

/** A Duration as milliseconds. A number is milliseconds. */
export const ms = (d: Duration | undefined, def: number): number => {
  if (d === undefined) return def
  if (typeof d === 'number') return d
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(d)
  if (!m) throw new Error(`fero: '${d}' is not a duration (write 30s, 10m, 1h, or a number of ms)`)
  return Number(m[1]) * UNIT_MS[m[2]]
}
/** A Size as bytes. A number is bytes. */
export const bytes = (s: Size | undefined, def: number): number => {
  if (s === undefined) return def
  if (typeof s === 'number') return s
  const m = /^(\d+(?:\.\d+)?)(B|KB|MB|GB|TB)$/.exec(s)
  if (!m) throw new Error(`fero: '${s}' is not a size (write 200MB, 1GB, or a number of bytes)`)
  return Number(m[1]) * UNIT_B[m[2]]
}

/** FNV-1a, 32 bits: the slot hash. Stable across runs and machines. */
export const fnv1a = (s: string): number => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

/** sfc32: a small, fast, seeded PRNG. Every random choice in a world comes from one of these. */
export class Rng {
  #a: number; #b: number; #c: number; #d: number
  constructor(seed: number) {
    this.#a = 0x9e3779b9; this.#b = 0x243f6a88; this.#c = 0xb7e15162; this.#d = seed >>> 0
    for (let i = 0; i < 12; i++) this.next()
  }
  next(): number {
    let a = this.#a, b = this.#b, c = this.#c, d = this.#d
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0
    const t = (a + b | 0) + d | 0
    d = d + 1 | 0
    a = b ^ (b >>> 9)
    b = c + (c << 3) | 0
    c = (c << 21) | (c >>> 11)
    c = c + t | 0
    this.#a = a; this.#b = b; this.#c = c; this.#d = d
    return (t >>> 0) / 4294967296
  }
  int(n: number): number { return Math.floor(this.next() * n) }
  range(lo: number, hi: number): number { return lo + this.next() * (hi - lo) }
  pick<T>(xs: readonly T[]): T { return xs[this.int(xs.length)] }
  chance(p: number): boolean { return this.next() < p }
  /** a child stream, so one subsystem's draws do not shift another's */
  fork(): Rng { return new Rng(Math.floor(this.next() * 4294967296)) }
}

// ── versions: the slot epoch, then the index in the group's log; fixed width so plain string `<`
// is log order within one partition, across failovers (index never falls for committed entries) and
// moves (the epoch rises on every move). DESIGN-V5's O `slot`.
export const ver = (epoch: number, index: number): string =>
  epoch.toString(16).padStart(4, '0') + ':' + index.toString(16).padStart(12, '0')
export const ZERO_VERSION = ver(0, 0)
export const verEpoch = (v: string): number => parseInt(v.slice(0, 4), 16)
export const verIndex = (v: string): number => parseInt(v.slice(5), 16)

/** A binary min-heap on (t, seq): the world's event queue, and the writers' ttl index. */
export class Heap<T extends { t: number; seq: number }> {
  #xs: T[] = []
  get size(): number { return this.#xs.length }
  peek(): T | undefined { return this.#xs[0] }
  push(x: T): void {
    const xs = this.#xs
    xs.push(x)
    let i = xs.length - 1
    while (i > 0) {
      const p = (i - 1) >> 1
      if (less(xs[p], xs[i])) break
      ;[xs[p], xs[i]] = [xs[i], xs[p]]
      i = p
    }
  }
  pop(): T | undefined {
    const xs = this.#xs
    if (xs.length === 0) return undefined
    const top = xs[0]
    const last = xs.pop()!
    if (xs.length > 0) {
      xs[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1, r = l + 1
        let m = i
        if (l < xs.length && less(xs[l], xs[m])) m = l
        if (r < xs.length && less(xs[r], xs[m])) m = r
        if (m === i) break
        ;[xs[m], xs[i]] = [xs[i], xs[m]]
        i = m
      }
    }
    return top
  }
}
const less = (a: { t: number; seq: number }, b: { t: number; seq: number }): boolean =>
  a.t < b.t || (a.t === b.t && a.seq < b.seq)

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const ka = Object.keys(a as object), kb = Object.keys(b as object)
  if (ka.length !== kb.length) return false
  for (const k of ka) if (!Object.hasOwn(b as object, k) || !deepEqual((a as any)[k], (b as any)[k])) return false
  return true
}

export const deepFreeze = <T>(v: T): T => {
  if (v === null || typeof v !== 'object' || Object.isFrozen(v)) return v
  for (const k of Object.keys(v as object)) deepFreeze((v as any)[k])
  return Object.freeze(v)
}

/** The wire stand-in: a deep copy of plain data, frozen, or the reason it would not arrive unchanged
 *  ('unencodable'): a bigint, a function, a symbol, a Date, a Map, a class instance, NaN, deeper than 60. */
export const wireCopy = (v: unknown, depth = 0): unknown => {
  if (depth > 60) throw new WireError('deeper than 60 levels')
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new WireError(`${v} is not a finite number`); return v }
  if (v === undefined) return undefined
  if (typeof v !== 'object') throw new WireError(`a ${typeof v}`)
  if (Array.isArray(v)) return Object.freeze(v.map((x) => wireCopy(x, depth + 1)))
  const proto = Object.getPrototypeOf(v)
  if (proto !== Object.prototype && proto !== null) throw new WireError(`a ${proto?.constructor?.name ?? 'class'} instance`)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v)) { const x = wireCopy((v as any)[k], depth + 1); if (x !== undefined) out[k] = x }
  return Object.freeze(out)
}
export class WireError extends Error {}

/** A rough byte size of a value as the wire would carry it. */
export const sizeOf = (v: unknown): number => (v === undefined ? 0 : JSON.stringify(v).length)

/** cyrb53-style running hash for traces: two 32-bit lanes, folded to a 13-hex-digit string. */
export class TraceHash {
  #h1 = 0xdeadbeef; #h2 = 0x41c6ce57; n = 0
  add(s: string): void {
    let h1 = this.#h1, h2 = this.#h2
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677)
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
    this.#h1 = h1; this.#h2 = h2; this.n++
  }
  hex(): string { return ((this.#h2 >>> 0) * 2 ** 21 + ((this.#h1 >>> 0) >>> 11)).toString(16).padStart(14, '0') }
}
