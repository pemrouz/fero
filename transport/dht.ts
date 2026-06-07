// Consistent hashring: map a partition key to its owning peer, and the next
// R-1 distinct peers clockwise for replication. A pure in-memory routing
// function — emits no bytes.
//
// Rethink of fero-old/dht.js: it used a bintrees red-black tree and allocated a
// throwaway query object + iterator on every lookup (dht.js:40). Here the ring
// is two parallel sorted arrays — `#hashes: Uint32Array` (ascending) and
// `#owners: string[]` (aligned) — and lookup is a branch-light binary search
// with zero allocation. Membership change is rare (rebuild the arrays, lazily);
// lookup is hot (every routed record) — so we optimize the common case. A
// contiguous ~1000-entry Uint32Array (5 peers × 200 vnodes) is ~4KB and fits in
// cache, vs an RBTree of heap-scattered nodes.
//
// Consumes the committed-view membership via installView (transport/index.ts) —
// the ring changes only on a view commit, never on raw connect/disconnect.

const VNODES = 200 // virtual nodes per peer — smooth distribution, ≈1/N move on churn

// djb2 accumulation (seed 5381) + an fmix32 avalanche finalizer. The finalizer
// is NOT optional: plain djb2 has poor diffusion on the trailing characters, so
// an address's vnodes (`addr*0`…`addr*9`, differing only in the last char) hash
// to nearly the same value and cluster on the ring — yielding a wildly uneven
// distribution. fmix32 spreads those low-bit differences across all 32 bits.
// Fast, allocation-free. Injectable; bake off vs wy/xxhash in dht.perf.ts (see
// ../IDEAS.md).
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

export type DHTOpts = {
  vnodes?: number
  hash?: (s: string) => number
  replicas?: number
}

export class DHT {
  #vnodes: number
  #hash: (s: string) => number
  #replicas: number
  #members = new Map<string, Uint32Array>() // address → its vnode hashes (for removal)
  #hashes = new Uint32Array(0) // sorted ascending
  #owners: string[] = [] // aligned with #hashes
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
  // membership change is rare relative to lookups.
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
    // single-node case, and the per-write owner check on a solo server's hot path).
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

}
