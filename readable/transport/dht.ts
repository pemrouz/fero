// Consistent hashring: route a key to its owning peer + R-1 clockwise replicas — pure, zero-byte.

const VNODES = 200 // virtual nodes per peer — smooth distribution, ≈1/N move on churn

// djb2 hash + fmix32 finalizer — the avalanche step is required so a peer's vnodes don't cluster.
export const hash32 = (s: string): number => {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 33) ^ s.charCodeAt(i)) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

// Tunables: vnode count, injectable hash fn, and replication factor.
export type DHTOpts = {
  vnodes?: number
  hash?: (s: string) => number
  replicas?: number
}

// The ring: member set + two parallel sorted arrays (#hashes/#owners), rebuilt lazily on change.
export class DHT {
  #vnodes: number
  #hash: (s: string) => number
  #replicas: number
  #members = new Map<string, Uint32Array>()
  #hashes = new Uint32Array(0)
  #owners: string[] = []
  #dirty = false

  constructor({ vnodes = VNODES, hash = hash32, replicas = 1 }: DHTOpts = {}) {
    this.#vnodes = vnodes
    this.#hash = hash
    this.#replicas = replicas
  }

  add(address: string) {
    if (this.#members.has(address)) return
    const vns = new Uint32Array(this.#vnodes)
    for (let i = 0; i < this.#vnodes; i++) vns[i] = this.#hash(address + '*' + i)
    this.#members.set(address, vns)
    this.#dirty = true
  }

  remove(address: string) {
    if (this.#members.delete(address)) this.#dirty = true
  }

  has(address: string) {
    return this.#members.has(address)
  }

  members(): string[] {
    return [...this.#members.keys()]
  }

  get size() {
    return this.#members.size
  }

  // Rebuild the sorted arrays from the member set. O(M log M); the cold path —
  #rebuild() {
    const pairs: Array<[number, string]> = []
    for (const [addr, vns] of this.#members) for (let i = 0; i < vns.length; i++) pairs.push([vns[i], addr])
    pairs.sort((a, b) => a[0] - b[0])
    const hashes = new Uint32Array(pairs.length)
    const owners: string[] = new Array(pairs.length)
    for (let i = 0; i < pairs.length; i++) {
      hashes[i] = pairs[i][0]
      owners[i] = pairs[i][1]
    }
    this.#hashes = hashes
    this.#owners = owners
    this.#dirty = false
  }

  // First ring slot whose hash >= h, wrapping to 0 (clockwise-with-wraparound).
  #search(h: number): number {
    const a = this.#hashes
    let lo = 0
    let hi = a.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (a[mid] < h) lo = mid + 1
      else hi = mid
    }
    return lo === a.length ? 0 : lo
  }

  // The peer that owns `key` (the partition — typically a change record's key[0]).
  owner(key: string): string | undefined {
    if (this.#dirty) this.#rebuild()
    if (this.#hashes.length === 0) return undefined
    // Sole member owns every key — skip the hash + binary search (the common
    if (this.#members.size === 1) return this.#owners[0]
    return this.#owners[this.#search(this.#hash(key))]
  }

  // The owner + the next distinct peers clockwise, for R-way replication.
  owners(key: string, replicas = this.#replicas): string[] {
    if (this.#dirty) this.#rebuild()
    const n = this.#hashes.length
    if (n === 0) return []
    const start = this.#search(this.#hash(key))
    const out: string[] = []
    const seen = new Set<string>()
    for (let s = 0; s < n && out.length < replicas; s++) {
      const addr = this.#owners[(start + s) % n]
      if (!seen.has(addr)) {
        seen.add(addr)
        out.push(addr)
      }
    }
    return out
  }

  // Allocation-free membership predicate: is `addr` among the first R distinct owners of `key`?
  holds(key: string, addr: string, replicas = this.#replicas): boolean {
    if (this.#dirty) this.#rebuild()
    const n = this.#hashes.length
    if (n === 0) return false
    // R ≥ distinct members ⇒ every member holds every partition — a Map lookup, no ring
    if (this.#members.size <= replicas) return this.#members.has(addr)
    const start = this.#search(this.#hash(key))
    const owners = this.#owners
    let distinct = 0
    for (let s = 0; s < n && distinct < replicas; s++) {
      const cand = owners[(start + s) % n]
      // dedup without a Set: count `cand` only at the FIRST slot it appears in this walk.
      let isNew = true
      for (let t = 0; t < s; t++)
        if (owners[(start + t) % n] === cand) {
          isNew = false
          break
        }
      if (!isNew) continue
      if (cand === addr) return true
      distinct++
    }
    return false
  }

}
